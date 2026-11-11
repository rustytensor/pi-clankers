import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClankersState, createClankersStateContainer, updateClankersState } from '../state.js';
import { createClankersPersistenceManager } from '../persistence.js';
import { createWorkflowService, recoverWorkflowState } from '../workflow-runtime.js';
import { WORKFLOW_EXTENSION_KEY, workflowHash, workflowRecoveryAddresses, workflowStepEntries } from '../workflow-model.js';
import { recoveryWriterUsage, validateRecoveryCheckpoint } from '../workflow-recovery.js';
import type { WorkflowNativeRequest, WorkflowServiceOptions, WorkflowRecoveryNativeSettlementRequest } from '../workflow-model.js';
import type { RecoveryWriterOwnerEvidence } from '../persistence.js';

// Actual producer SIGKILL + authoritative store + actual check supervisor. Native transport
// is deliberately local/controlled: this is NOT real-model or SDK/host acceptance.
function processState(owner: RecoveryWriterOwnerEvidence): 'live' | 'dead' | 'unknown' {
  try {
    if (readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() !== owner.bootId) return 'dead';
    const raw = readFileSync(`/proc/${owner.pid}/stat`, 'utf8');
    return raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)[19] === owner.startTimeTicks ? 'live' : 'dead';
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'dead' : 'unknown'; }
}
async function waitFor<T>(get: () => T | undefined, label: string): Promise<T> {
  const end = Date.now() + 10000;
  while (Date.now() < end) { const value = get(); if (value !== undefined) return value; await new Promise(r => setTimeout(r, 10)); }
  throw new Error(`deadline: ${label}`);
}
async function fixture(t: any, options: { interruptWriter?: boolean; repeat?: boolean; nativeSettlement?: boolean; failAfterCommit?: boolean; cancelOnPublish?: boolean; priorAttempts?: number; writerLimit?: number; fanout?: boolean; failAfterCanonical?: boolean; unrelated?: boolean; repeatHistory?: boolean; cancelBoundary?: 'preflight' | 'effect-intent'; mutationPhase?: 'acquire' | 'id' | 'clock'; mutate?: (f: any) => void } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'clankers-selected-execution-'));
  const previousTmpdir = process.env.TMPDIR; process.env.TMPDIR = root;
  const projectRoot = join(root, 'project'), stagingParent = join(root, 'stage'), snapshotFile = join(root, 'state.json');
  mkdirSync(projectRoot, { mode: 0o700 }); mkdirSync(stagingParent, { mode: 0o700 }); mkdirSync(join(projectRoot, 'src'));
  for (const p of ['a','b']) writeFileSync(join(projectRoot, `src/${p}.txt`), 'old\n');
  writeFileSync(join(projectRoot, 'unrelated.txt'), 'USER_BYTES');
  const runtimeUrl = new URL('../workflow-runtime.ts', import.meta.url).href;
  const stateUrl = new URL('../state.ts', import.meta.url).href;
  const persistUrl = new URL('../persistence.ts', import.meta.url).href;
  const modelUrl = new URL('../workflow-model.ts', import.meta.url).href;
  const driver = `
    import { createHash, randomUUID } from 'node:crypto';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import { join } from 'node:path';
    import { createWorkflowService } from ${JSON.stringify(runtimeUrl)};
    import { createClankersStateContainer, createClankersState, updateClankersState } from ${JSON.stringify(stateUrl)};
    import { createClankersPersistenceManager } from ${JSON.stringify(persistUrl)};
    import { workflowHash } from ${JSON.stringify(modelUrl)};
    const projectRoot=process.argv[1], stagingParent=process.argv[2], snapshotFile=process.argv[3];
    const boundary='after-write'; const interruptWriter=${JSON.stringify(options.interruptWriter ?? false)};
    function pause(){const recorded=service.approvals.inspect().find(x=>x.status==='granted'&&x.kind===(interruptWriter?'implementation':'application')); fs.writeSync(1,JSON.stringify({runId,approvalId:recorded?.id,requestHash:recorded?.requestHash,owner:store.inspectRecoveryOwnership().owner})+'\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0); }
    const originalRename=fs.renameSync;
    fs.renameSync=(from,to)=>{originalRename(from,to); if(!interruptWriter && boundary==='after-write' && to===join(projectRoot,'src/a.txt'))pause();}; syncBuiltinESMExports();
    const str={type:'string',maxLength:256}, array=items=>({type:'array',maxItems:32,items}), object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
    const baseProfile={id:'node',executable:process.execPath,argv:['-e','process.exit(0)'],cwd:'src',env:{},timeoutMs:2000,allowGeneratedOutputs:false};
    const policy={version:3,capabilities:['stage-write','check','review','apply'],identity:{parentRunId:'fixture',taskId:'fixture-task',attemptNo:1,workerAgentId:'worker',rootAgentId:'reviewer',model:'fake/model'},scope:{task:'Change old to new in the disposable fixture',writablePaths:['src/a.txt','src/b.txt'],baseline:{projectRootId:projectRoot,stateHash:createHash('sha256').update('old\\n').digest('hex')},manifest:['a','b'].map(p=>({path:'src/'+p+'.txt',text:'old\\n',bytes:4,sha256:createHash('sha256').update('old\\n').digest('hex')}))},bounds:{maxIterations:${JSON.stringify(options.writerLimit ?? 3)}},reviewRequired:true,checkProfiles:[{...baseProfile,profileHash:workflowHash(baseProfile)}]};
    const definition={id:'interrupted-artifact',version:3,label:'Interrupted artifact',inputSchema:object({}),steps:[
      {id:'stage',kind:'coding',dependsOn:[],inputs:{},outputSchema:object({candidateHash:str,changedPaths:array(str)}),coding:{operation:'stage-write',policy}},
      {id:'check',kind:'coding',dependsOn:['stage'],inputs:{},outputSchema:object({passed:{type:'boolean'},profileId:str,candidateHash:str}),coding:{operation:'check',policy,checkProfileId:'node'}},
      {id:'review',kind:'coding',dependsOn:['check'],inputs:{},outputSchema:object({passed:{type:'boolean'},candidateHash:str,reviewer:str,findings:array(object({}))}),coding:{operation:'review',policy}},
      {id:'apply',kind:'coding',dependsOn:['review'],inputs:{},outputSchema:object({status:str,candidateHash:str,appliedPaths:array(str),rejectedPaths:array(str),diagnostics:array(str),outcomeHash:str}),coding:{operation:'apply',policy}}
    ]};
    const agents=Object.fromEntries(['worker','reviewer'].map(id=>[id,{id,label:id,source:'runtime',prompt:id,model:'fake/model',permissionMode:'inherit'}]));
    const base=createClankersStateContainer({agentDefinitions:agents});
    const store=createClankersPersistenceManager({snapshotFile}); store.hydrate(base);
    const container={...base, replace(next){const value=createClankersState(next);store.save(value);if(boundary==='before-write' && value.extensions.workflows?.runs?.some(r=>r.recovery?.operations.at(-1)?.kind==='application' && !r.recovery.operations.at(-1).result))pause();return base.replace(value);}, update(patch,options){const next=updateClankersState(base.read(),patch,options);store.save(next);if(boundary==='before-write' && next.extensions.workflows?.runs?.some(r=>r.recovery?.operations.at(-1)?.kind==='application' && !r.recovery.operations.at(-1).result))pause();return base.replace(next);}};
    let runId='', approval;
    const keepAlive=setInterval(()=>{},1000);
    const native={preflight(){},async execute(req){
      if(!req.coding){if(${JSON.stringify(options.unrelated ?? false)}) {req.onIdentity({runId:'unrelated-native',taskId:'unrelated-task'});await new Promise(()=>{});}else{req.onIdentity({runId:'native-stage-write',taskId:'task-stage-write'});pause();}}
      const suffix=(req.attemptNo>1?'-attempt-'+req.attemptNo:'')+(req.iterationNo>1?'-iteration-'+req.iterationNo:'');const identity={runId:'native-'+req.coding.operation+suffix,taskId:'task-'+req.coding.operation+suffix};req.onIdentity(identity);
      if(req.coding.operation==='stage-write') { for(const p of req.coding.policy.scope.writablePaths) req.coding.write(p,${JSON.stringify(options.repeatHistory ?? false)}&&req.iterationNo>1&&p==='src/b.txt'?'refined\\n':'new\\n'); if(interruptWriter || (${JSON.stringify(options.repeatHistory ?? false)}&&req.iterationNo===2)) pause(); }
      return {status:'completed',text:req.coding.operation==='review'?JSON.stringify({verdict:'pass',findings:[]}):'{}',cleanupSettled:true,identity};
    }};
    const service=createWorkflowService(container,native,{recovery:{enabled:true,durablePort:{ensureWriter(){return store.acquireRecoveryOwnership().owner;},inspectOwner(){return store.inspectRecoveryOwnership();}}},coding:{enabled:true,projectRoot,stagingParent,allocateCheckReceipt:({candidateId,profileId})=>{const receiptDir=fs.mkdtempSync(join(stagingParent,'receipt-')); const generation=randomUUID(),nonce=randomUUID(),markerPath=join(receiptDir,'marker.json');fs.writeFileSync(markerPath,JSON.stringify({generation,nonce,candidateId,profileId}),{mode:0o600});return {receiptDir,markerPath,generation,nonce,candidateId,profileId};},writablePaths:['src/a.txt','src/b.txt'],checkProfiles:{node:{id:baseProfile.id,executable:baseProfile.executable,argv:baseProfile.argv,cwd:baseProfile.cwd,env:baseProfile.env,timeoutMs:baseProfile.timeoutMs,outputBytes:65536,generatedOutputs:[]}}}});
    if (${JSON.stringify(options.repeat ?? false)}) {
      const body=definition.steps; const stateSchema=object({done:{type:'boolean'}});
      definition.steps=[{id:'loop',kind:'repeat',dependsOn:[],initial:{value:{done:false}},stateSchema,body,feedback:{value:{done:true}},until:{op:'boolean',value:{ref:{source:'iteration',path:['done']}}},output:{ref:{source:'iteration',path:[]}},outputSchema:stateSchema,maxIterations:3}];
    }
    if (${JSON.stringify(options.repeatHistory ?? false)}) {const block=definition.steps[0];const apply=block.body.pop();block.feedback={value:{done:false}};apply.dependsOn=['loop'];definition.steps.push(apply);}
    if (${JSON.stringify(options.fanout ?? false)}) { definition.version=1; definition.inputSchema=object({items:{type:'array',maxItems:3,items:str}});definition.steps=[{id:'fan',kind:'native',dependsOn:[],agentId:'worker',prompt:'Readonly fixture',inputs:{item:{ref:{source:'item',path:[]}}},outputSchema:object({ok:{type:'boolean'}}),fanout:{from:{source:'inputs',path:['items']},maxItems:3}}]; }
    const d=await service.execute({action:'workflows.define',definition}); if(!d.ok) throw Error(d.error);
    const r=await service.execute({action:'workflows.start',definitionId:definition.id,inputs:${JSON.stringify(options.fanout ? {items:['a','b']} : {})},concurrency:${JSON.stringify(options.unrelated ? 2 : 1)}}); if(!r.ok)throw Error(r.error);runId=r.view.workflowRunId;
    const end=Date.now()+6000;
    while(Date.now()<end){approval=service.approvals.inspect().find(x=>x.kind==='implementation'&&x.status==='pending');if(approval)break;await new Promise(r=>setTimeout(r,10));}
    if(!approval)throw Error('fixture implementation approval missing');service.approvals.grantFingerprint(approval.id,approval.requestHash);
    if(${JSON.stringify(options.unrelated ?? false)}) {const def={id:'unrelated',version:1,label:'Unrelated',inputSchema:object({}),steps:[{id:'work',kind:'native',dependsOn:[],inputs:{},agentId:'worker',prompt:'Readonly',outputSchema:object({ok:{type:'boolean'}})}]};const d=await service.execute({action:'workflows.define',definition:def});if(!d.ok)throw Error(d.error);const r=await service.execute({action:'workflows.start',definitionId:'unrelated',inputs:{},concurrency:2});if(!r.ok)throw Error(r.error);}
    approval=undefined;const appEnd=Date.now()+6000;while(Date.now()<appEnd){approval=service.approvals.inspect().find(x=>x.kind==='application'&&x.status==='pending');if(approval)break;await new Promise(r=>setTimeout(r,10));}if(!approval)throw Error('application approval missing '+JSON.stringify(service.get(runId)));service.approvals.grantFingerprint(approval.id,approval.requestHash);
  `;
  const launch = (script: string) => {
    const producer = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, projectRoot, stagingParent, snapshotFile], { env: { TMPDIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = once(producer, 'close'); let stdout = '', stderr = '';
    producer.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 16384) producer.kill('SIGKILL'); });
    producer.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
    return {producer,closed,get stdout(){return stdout;},get stderr(){return stderr;}};
  };
  let processFixture = launch(driver);
  let service: ReturnType<typeof createWorkflowService> | undefined;
  t.after(async () => {
    service?.dispose();
    if (processFixture.producer.exitCode === null && processFixture.producer.signalCode === null) processFixture.producer.kill('SIGKILL'); await processFixture.closed;
    if (previousTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmpdir;
    rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false);
  });
  const killProducer = async () => {
    await waitFor(() => processFixture.stdout.includes('\n') ? true : processFixture.producer.signalCode || processFixture.producer.exitCode !== null ? (() => { throw Error(processFixture.stderr); })() : undefined, 'producer');
    const ready = JSON.parse(processFixture.stdout.trim()) as { runId: string; approvalId: string; requestHash: string; owner: RecoveryWriterOwnerEvidence };
    assert.equal(processState(ready.owner), 'live'); assert.equal(ready.owner.pid, processFixture.producer.pid);
    processFixture.producer.kill('SIGKILL'); const [, signal] = await processFixture.closed; assert.equal(signal, 'SIGKILL'); assert.equal(processState(ready.owner), 'dead'); return ready;
  };
  let ready = await killProducer();
  const ancestorIds = [ready.runId], ancestorOwners = [ready.owner];
  for (let i = 1; i < (options.priorAttempts ?? 1); i++) {
    const oldReady = ready;
    const continuationDriver = driver
      .replace('const interruptWriter=false','const interruptWriter=true')
      .replace('recovery:{enabled:true,durablePort:', `recovery:{enabled:true,inspectNativeSettlement:req=>req.familyId===${JSON.stringify(ancestorIds[0])}&&req.native?.runId.startsWith('native-stage-write')?'settled':'unknown',durablePort:`)
      .replace('inspectOwner(){return store.inspectRecoveryOwnership();}', `inspectOwner(){return store.inspectRecoveryOwnership();},inspectPreviousOwner(o){try{const raw=fs.readFileSync('/proc/'+o.pid+'/stat','utf8');return raw.slice(raw.lastIndexOf(')')+2).trim().split(/\\s+/)[19]===o.startTimeTicks?'live':'dead';}catch(e){return e.code==='ENOENT'?'dead':'unknown';}},acquireWriter(opts){return store.acquireRecoveryOwnership(opts).owner;},publishSnapshot(next){store.save(next);return base.replace(next);}`)
      .replace(/    const d=await service.execute[\s\S]*?runId=r.view.workflowRunId;/, `    const source=service.get(${JSON.stringify(oldReady.runId)});const ids=source.definition.steps.flatMap(s=>s.kind==='repeat'?Array.from({length:s.maxIterations},(_,i)=>s.body.map(b=>s.id+'@'+i+'/'+b.id+':0')).flat():[s.id+':0']);const selections={rerunUnitIds:ids};const p=await service.recovery.prepare(source.workflowRunId,selections);if(p.assessment.plan.status!=='prepared')throw Error(JSON.stringify(p.assessment.blocked));const r=await service.recovery.authorize({workflowRunId:source.workflowRunId,assessmentFingerprint:p.assessment.fingerprint,selections});if(!r.ok)throw Error(r.error);runId=r.view.workflowRunId;`);
    processFixture = launch(continuationDriver); ready = await killProducer(); ancestorIds.push(ready.runId); ancestorOwners.push(ready.owner);
  }
  const store = createClankersPersistenceManager({ snapshotFile })!;
  const base = createClankersStateContainer(); store.hydrate(base);
  const originalSnapshot = readFileSync(snapshotFile); const originalStageEntries = readdirSync(stagingParent).sort();
  let publications = 0, nativeCalls = 0, freshWriter = '', freshReviewer = ''; let f: any, armed = false;
  const mutate = (phase: string) => { if (options.mutationPhase === phase) options.mutate?.(f); };
  const cancelBoundary = (phase: string) => { if (armed && options.cancelBoundary === phase) { armed = false; controller.abort(); } };
  const container = { ...base, replace(next: ReturnType<typeof base.read>) { const value = createClankersState(next); store.save(value); return base.replace(value); }, update(patch: any, opts: any) { const value = updateClankersState(base.read(), patch, opts); store.save(value); const result = base.replace(value); const child = (value.extensions[WORKFLOW_EXTENSION_KEY] as any)?.runs?.find((r:any)=>r.workflowRunId==='selected-child'); if (child?.recovery?.operations.at(-1)?.kind==='stage-write' && !child.recovery.operations.at(-1).result) cancelBoundary('effect-intent'); return result; } };
  const controller = new AbortController();
  const settledRequests: WorkflowRecoveryNativeSettlementRequest[] = [];
  const config: WorkflowServiceOptions = {
    idFactory: () => { mutate('id'); return 'selected-child'; }, now: () => { mutate('clock'); return new Date(); },
    recovery: { enabled: true, inspectNativeSettlement: req => {
      settledRequests.push(req);
      // Trusted local test transport has no launched subprocess. Bind its exact original
      // native identity + the actual dead producer. Never claim native result reuse.
      const index = ancestorIds.indexOf(req.workflowRunId); return options.nativeSettlement && index >= 0 && req.native?.runId.startsWith('native-stage-write') && processState(ancestorOwners[index]) === 'dead' ? 'settled' : 'unknown';
    }, durablePort: {
      ensureWriter: () => store.acquireRecoveryOwnership!().owner,
      inspectOwner: () => store.inspectRecoveryOwnership!(), inspectPreviousOwner: processState,
      acquireWriter: opts => { const acquired = store.acquireRecoveryOwnership!(opts).owner; assert.equal(acquired.pid, process.pid); assert.equal(processState(acquired), 'live'); mutate('acquire'); return acquired; },
      publishSnapshot: (next, opts) => { assert.equal(opts.expectedSnapshotHash, store.inspectRecoveryOwnership!().actualSnapshotHash); publications++; store.save(next as any); if (options.failAfterCommit) throw Error('publication effect uncertain'); const value = base.replace(next as any); if (options.failAfterCanonical) throw Error('after canonical effect uncertain'); if (options.cancelOnPublish) controller.abort(); return value; },
    } },
    coding: { enabled: true, projectRoot, stagingParent, writablePaths: ['src/a.txt','src/b.txt'], checkProfiles: { node: { id: 'node', executable: process.execPath, argv: ['-e','process.exit(0)'], cwd: 'src', env: {}, timeoutMs: 2000, outputBytes: 65536, generatedOutputs: [] } },
      allocateCheckReceipt: ({ candidateId, profileId }) => { const receiptDir = mkdtempSync(join(stagingParent, 'receipt-')); const generation = randomUUID(), nonce = randomUUID(), markerPath = join(receiptDir,'marker.json'); writeFileSync(markerPath, JSON.stringify({ generation, nonce, candidateId, profileId }), { mode: 0o600 }); return { receiptDir, markerPath, generation, nonce, candidateId, profileId }; } },
  };
  const native = { preflight() { cancelBoundary('preflight'); }, async execute(req: WorkflowNativeRequest) {
    nativeCalls++; assert.equal(req.workflowRunId, 'selected-child'); req.assertAdmission();
    if (!req.coding) { const identity={runId:'fresh-'+req.unitId,taskId:'fresh-task-'+req.unitId}; req.onIdentity(identity); return {status:'completed' as const,text:JSON.stringify({ok:true}),cleanupSettled:true,identity}; }
    const identity = { runId: 'fresh-' + req.coding!.operation, taskId: 'fresh-task-' + req.coding!.operation }; req.onIdentity(identity);
    if (req.coding!.operation === 'stage-write') {
      freshWriter = identity.runId;
      if (!options.interruptWriter && !options.repeatHistory) {
        assert.deepEqual(req.coding!.policy.scope.writablePaths, ['src/b.txt']);
        assert.ok(req.coding!.policy.scope.readonlyPaths!.includes('src/a.txt'));
        assert.throws(() => req.coding!.write('src/a.txt','DUPLICATE'), /writable|read.only|outside/i);
      }
      // Carried bytes still require a genuinely new writer identity. No old edit status.
      assert.equal(req.coding!.read('src/b.txt'), options.repeatHistory ? 'refined\n' : 'new\n'); req.coding!.write('src/b.txt',options.repeatHistory ? 'refined\n' : 'new\n');
      assert.equal(service!.approvals.inspect().filter(a => a.kind === 'application').length, 0);
    } else if (req.coding!.operation === 'review') { freshReviewer = identity.runId; assert.notEqual(freshReviewer, freshWriter); assert.throws(() => req.coding!.write('src/b.txt','bad'), /read.only/); }
    return { status: 'completed' as const, text: req.coding!.operation === 'review' ? JSON.stringify({ verdict: 'pass', findings: [] }) : '{}', cleanupSettled: true, identity };
  } };
  service = createWorkflowService(container, native, config);
  const selections = { rerunUnitIds: workflowRecoveryAddresses(service.get(ready.runId)!.definition).map(a => a.unitId) };
  const sourceBefore = service.get(ready.runId)!;
  f = { root, projectRoot, stagingParent, snapshotFile, originalSnapshot, originalStageEntries, ready, store, base, container, config, native, service, selections, controller, sourceBefore, settledRequests, ancestorIds, armCancellation: () => { armed = true; },
    get publications() { return publications; }, get nativeCalls() { return nativeCalls; },
    prepare: () => service!.recovery!.prepare(ready.runId, selections),
    authorize: (fp: string) => service!.recovery!.authorize({ workflowRunId: ready.runId, assessmentFingerprint: fp, selections }, controller.signal),
  };
  return f as { root: string; projectRoot: string; stagingParent: string; snapshotFile: string; originalSnapshot: Buffer; originalStageEntries: string[]; ready: typeof ready; store: typeof store; base: typeof base; container: typeof container; config: typeof config; native: typeof native; service: NonNullable<typeof service>; selections: typeof selections; controller: typeof controller; sourceBefore: typeof sourceBefore; settledRequests: typeof settledRequests; ancestorIds: string[]; publications: number; nativeCalls: number; armCancellation: () => void; prepare: () => Promise<any>; authorize: (fp:string) => Promise<any> };
}
async function select(f: Awaited<ReturnType<typeof fixture>>) {
  const p = await f.prepare(); assert.equal(p.ok,true,p.error); const assessment = p.assessment as any;
  assert.equal(assessment.plan.status, 'prepared', JSON.stringify(assessment.blocked));
  assert.equal(f.publications, 0); assert.equal(f.nativeCalls, 0); assert.deepEqual(readFileSync(f.snapshotFile), f.originalSnapshot);
  const a = await f.authorize(assessment.fingerprint); assert.equal(a.ok,true,a.error); assert.equal(f.publications, 1); assert.deepEqual(readdirSync(f.stagingParent).sort(),f.originalStageEntries);
  return a.view!.workflowRunId;
}
async function pendingApproval(f: Awaited<ReturnType<typeof fixture>>, kind: string, timing = {
  now: () => Date.now(), sleep: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
}) {
  const end = timing.now() + 10000;
  try {
    while (true) {
      // Publication can delay the polling timer past the deadline. Accept a late
      // observation only with proof that this pending gate was created in time.
      const approval = f.service.approvals.inspect().find(a => {
        const createdAt = typeof a.createdAt === 'string' ? Date.parse(a.createdAt) : NaN;
        return a.kind === kind && a.status === 'pending' && Number.isFinite(createdAt)
          && new Date(createdAt).toISOString() === a.createdAt && createdAt < end;
      });
      if (approval) return approval;
      if (timing.now() >= end) throw Error(`deadline: ${kind} approval`);
      await timing.sleep(10);
    }
  } catch (error) { throw Error(String(error) + JSON.stringify(f.service.list())); }
}

test('pendingApproval accepts an in-time gate observed on a delayed polling wake', async () => {
  for (const wakeAt of [110000, 110001]) {
    let clock = 100000, samples = 0, sleeps = 0;
    const gate = { id: 'exact-pending-approval', kind: 'application', status: 'pending', createdAt: new Date(109999).toISOString() };
    // Non-executing registry stub: only the two inspection methods are used.
    const f = { service: { approvals: { inspect: () => { samples++; return sleeps ? [gate] : []; } }, list: () => [] } } as unknown as Awaited<ReturnType<typeof fixture>>;
    const result = await pendingApproval(f, 'application', {
      now: () => clock,
      sleep: async ms => { assert.equal(ms, 10); sleeps++; clock = wakeAt; },
    });
    assert.strictEqual(result, gate);
    assert.equal(samples, 2); assert.equal(sleeps, 1);
  }
});

test('pendingApproval rejects late, absent, nonpending and invalid gates at the unchanged deadline', async () => {
  const gate = { id: 'gate', kind: 'application', status: 'pending', createdAt: new Date(109999).toISOString() };
  for (const observed of [
    [], [{ ...gate, createdAt: new Date(110000).toISOString() }], [{ ...gate, createdAt: new Date(110001).toISOString() }],
    [{ ...gate, status: 'granted' }], [{ ...gate, kind: 'implementation' }],
    [{ ...gate, createdAt: 'invalid' }], [{ ...gate, createdAt: undefined }], [{ ...gate, createdAt: 109999 }], [{ ...gate, createdAt: '0' }],
  ]) for (const wakeAt of [110000, 110001]) {
    let clock = 100000, samples = 0, sleeps = 0;
    const f = { service: { approvals: { inspect: () => { samples++; return sleeps ? observed : []; } }, list: () => [] } } as unknown as Awaited<ReturnType<typeof fixture>>;
    await assert.rejects(pendingApproval(f, 'application', {
      now: () => clock,
      sleep: async ms => { assert.equal(ms, 10); sleeps++; clock = wakeAt; },
    }), /^Error: Error: deadline: application approval\[\]$/);
    assert.equal(samples, 2); assert.equal(sleeps, 1);
  }
});

for (const repeat of [false, true]) test(`SIGKILL partial application -> selected ${repeat ? 'repeat frontier' : 'DAG'} -> fresh writer/check/review -> separate remaining apply`, { timeout: 30000 }, async t => {
  const f = await fixture(t, { repeat }); const childId = await select(f);
  const oldUnits = workflowStepEntries(f.sourceBefore).flatMap(e => e.step.units);
  const oldStage = oldUnits.find(u => u.coding?.phase === 'staged')!;
  const originalManifest = (oldStage.coding!.workspace as any).recoveryManifest;
  assert.ok(originalManifest.destinationLeases.every((l: any) => l.leaseDir.startsWith(f.root + '/')));
  const oldStageBytes = readFileSync(join(originalManifest.stageRoot,'src/b.txt'));
  assert.equal(f.nativeCalls, 0); assert.equal(readFileSync(join(f.projectRoot,'src/a.txt'),'utf8'),'new\n');
  assert.equal(readFileSync(join(f.projectRoot,'src/b.txt'),'utf8'),'old\n');
  const impl = await pendingApproval(f, 'implementation');
  assert.deepEqual((impl.request.humanReview as any).trust.writablePaths,['src/b.txt']);
  assert.equal(f.nativeCalls, 0);
  const beforeImpl = f.service.get(childId)!; assert.equal(beforeImpl.admissions,f.sourceBefore.admissions);
  assert.throws(() => f.service.approvals.grantFingerprint(f.ready.approvalId,f.ready.requestHash));
  f.service.approvals.grantFingerprint(impl.id,impl.requestHash);
  const app = await pendingApproval(f,'application');
  assert.notEqual(app.id,f.ready.approvalId); assert.notEqual(app.requestHash,f.ready.requestHash);
  assert.equal(f.nativeCalls,2); assert.equal(readFileSync(join(f.projectRoot,'src/b.txt'),'utf8'),'old\n');
  const units = workflowStepEntries(f.service.get(childId)!).flatMap(e => e.step.units);
  const writer = units.find(u => u.coding?.phase === 'staged')!, check = units.find(u => u.coding?.phase === 'check-passed')!, review = units.find(u => u.coding?.phase === 'review-passed')!;
  assert.notEqual(writer.native!.runId,oldStage.native!.runId); assert.notEqual(writer.coding!.candidateHash,oldStage.coding!.candidateHash);
  assert.notEqual(review.native!.runId,writer.native!.runId);
  const durable = (check.coding!.evidence as any).durableCheck;
  assert.equal(durable.receipt.commandStarted,true); assert.equal(durable.receipt.commandCompleted,true); assert.equal(durable.receipt.commandOutcome.exitCode,0); assert.equal(durable.receipt.cleanup.outcome,'ok');
  const provenance = (writer.coding!.workspace as any).continuationProvenance;
  assert.equal(provenance.sourceWorkflowId,f.ready.runId); assert.notEqual(provenance.newStageGen,provenance.oldStageGen); assert.deepEqual(provenance.alreadySatisfiedPaths,['src/a.txt']);
  f.service.approvals.grantFingerprint(app.id,app.requestHash); await f.service.drain();
  const child = f.service.get(childId)!; assert.equal(child.status,'completed',JSON.stringify(child));
  assert.equal(child.admissions, f.sourceBefore.admissions + 4); assert.equal(child.recovery!.budget.correctionsUsed, repeat ? 1 : 0);
  assert.equal(child.recovery!.operations.filter(op => op.kind === 'application').length,1);
  assert.deepEqual(child.recovery!.operations.find(op => op.kind === 'application')!.paths,['src/b.txt']);
  assert.equal(child.recovery!.operations.filter(op => ['native','check','review','application-gate'].includes(op.kind)).length,4);
  assert.equal(readFileSync(join(f.projectRoot,'src/a.txt'),'utf8'),'new\n'); assert.equal(readFileSync(join(f.projectRoot,'src/b.txt'),'utf8'),'new\n');
  assert.equal(readFileSync(join(f.projectRoot,'unrelated.txt'),'utf8'),'USER_BYTES'); assert.deepEqual(readFileSync(join(originalManifest.stageRoot,'src/b.txt')),oldStageBytes);
  const source = f.service.get(f.ready.runId)!;
  assert.deepEqual(source.steps,f.sourceBefore.steps); assert.deepEqual(source.recoveryOriginal,f.sourceBefore.recoveryOriginal); assert.deepEqual(source.recovery!.operations,f.sourceBefore.recovery!.operations); assert.equal(source.cleanupSettled,false);
  assert.equal(validateRecoveryCheckpoint(child.recovery).ok,true);
  assert.doesNotThrow(() => recoverWorkflowState(f.base.read().extensions[WORKFLOW_EXTENSION_KEY]));
  const forget = await f.service.execute({action:'workflows.forget',workflowRunId:f.ready.runId}); assert.equal(forget.ok,false);
});

for (const label of ['empty', 'unselected', 'stale', 'cancel', 'unknown-native', 'zero-write', 'readonly', 'commit-uncertain', 'postcommit-cancel'] as const) test(`SIGKILL selected execution safety: ${label}`, { timeout: 25000 }, async t => {
  const f = await fixture(t, { interruptWriter: label === 'unknown-native', failAfterCommit: label === 'commit-uncertain', cancelOnPublish: label === 'postcommit-cancel' });
  if (label === 'unknown-native') {
    const p = await f.prepare(); assert.equal((p.assessment as any).plan.status,'blocked'); assert.match(JSON.stringify(p.assessment),/previous-native-settlement-unknown/);
    assert.equal(f.publications,0); assert.equal(f.nativeCalls,0); return;
  }
  const p = await f.prepare(); assert.equal((p.assessment as any).plan.status,'prepared',JSON.stringify(p.assessment)); const fp = (p.assessment as any).fingerprint;
  if (label === 'empty' || label === 'unselected') {
    const selections = { rerunUnitIds: label === 'empty' ? [] : f.selections.rerunUnitIds.slice(0,-1) };
    const without = await f.service.recovery!.prepare(f.ready.runId,selections);
    assert.equal((without.assessment as any).plan.status,'blocked'); assert.match(JSON.stringify(without.assessment),/unselected-required-execution-address/);
    assert.deepEqual((without.assessment as any).plan.recommendedSelections.rerunUnitIds,f.selections.rerunUnitIds);
    const a = await f.service.recovery!.authorize({workflowRunId:f.ready.runId,assessmentFingerprint:(without.assessment as any).fingerprint,selections}); assert.equal(a.ok,false);
  } else if (label === 'stale') {
    writeFileSync(join(f.projectRoot,'src/b.txt'),'hostile'); const a = await f.authorize(fp); assert.equal(a.ok,false); assert.match(a.error!,/stale/);
  } else if (label === 'cancel') {
    f.controller.abort(); const a = await f.authorize(fp); assert.equal(a.ok,false); assert.match(a.error!,/cancelled/);
  } else if (label === 'zero-write') {
    writeFileSync(join(f.projectRoot,'src/b.txt'),'new\n'); const observed = await f.prepare(); assert.equal((observed.assessment as any).plan.status,'blocked'); assert.match(JSON.stringify(observed.assessment),/fully-satisfied-zero-write/);
  } else if (label === 'readonly') {
    f.base.replace({...f.base.read(),mode:{...f.base.read().mode,readOnly:true}}); const a = await f.authorize(fp); assert.equal(a.ok,false); assert.match(a.error!,/Read-only/);
  } else if (label === 'commit-uncertain') {
    const a = await f.authorize(fp); assert.equal(a.ok,false); assert.match(a.error!,/uncertain/);
    const again = await f.authorize(fp); assert.equal(again.ok,false); assert.match(again.error!,/poisoned/);
    assert.equal(f.publications,1); assert.equal(f.nativeCalls,0);
    const canonical = recoverWorkflowState(f.base.read().extensions[WORKFLOW_EXTENSION_KEY]);
    // Persisted selection cannot install authority in a new runtime, regardless of whether
    // the host published to its container before throwing.
    const restored = createClankersStateContainer(); const persistence = createClankersPersistenceManager({snapshotFile:f.snapshotFile})!; persistence.hydrate(restored);
    const fresh = createWorkflowService(restored,f.native,f.config);
    await Promise.resolve(); assert.equal(fresh.approvals.inspect().length,0); assert.equal(f.nativeCalls,0); assert.equal(fresh.list().filter(r=>r.recoveryOf===f.ready.runId).length,1); fresh.dispose(); void canonical;
    return;
  } else {
    const a = await f.authorize(fp); assert.equal(a.ok,false); assert.match(a.error!,/Caller cancelled after durable selection/); await Promise.resolve();
    assert.equal(f.service.get(a.view!.workflowRunId)!.status,'cancelled'); assert.equal(f.nativeCalls,0); assert.equal(f.service.approvals.inspect().length,0); assert.equal(f.publications,1); return;
  }
  assert.equal(f.publications,0); assert.equal(f.nativeCalls,0); assert.equal(f.service.approvals.inspect().length,0);
});

test('SIGKILL interrupted writer requires exact positive local settlement then new writer; restored selection is inert', {timeout:25000}, async t => {
  const f = await fixture(t,{interruptWriter:true,nativeSettlement:true}); const childId = await select(f);
  const impl = await pendingApproval(f,'implementation'); assert.equal(f.nativeCalls,0); assert.ok(f.settledRequests.length > 0);
  for (const req of f.settledRequests) { assert.equal(req.workflowRunId,f.ready.runId); assert.equal(req.unitId,'stage:0'); assert.equal(req.native!.runId,'native-stage-write'); assert.match(req.dependencyHash,/^[a-f0-9]{64}$/); }
  // Startup restores statuses/receipts only, no live plan or inherited approvals.
  const restored = createClankersStateContainer(); const store = createClankersPersistenceManager({snapshotFile:f.snapshotFile})!; store.hydrate(restored);
  const fresh = createWorkflowService(restored,f.native,f.config); assert.equal(fresh.get(childId)!.recovered,true); assert.equal(fresh.get(childId)!.status,'needs-attention'); assert.equal(fresh.approvals.inspect().length,0); fresh.dispose();
  f.service.approvals.grantFingerprint(impl.id,impl.requestHash); const app = await pendingApproval(f,'application'); f.service.approvals.grantFingerprint(app.id,app.requestHash); await f.service.drain(); assert.equal(f.service.get(childId)!.status,'completed');
});

test('SIGKILL selected child cancellation targets canonical child at fresh implementation gate', {timeout:25000}, async t => {
  const f = await fixture(t); const childId = await select(f); await pendingApproval(f,'implementation'); f.controller.abort(); await f.service.drain();
  assert.equal(f.service.get(childId)!.status,'cancelled'); assert.equal(f.nativeCalls,0); assert.deepEqual(f.service.get(f.ready.runId)!.steps,f.sourceBefore.steps);
});

test('three real SIGKILL attempts retain repeat cursor/source history and consume writer allowance without refunds', {timeout:45000}, async t => {
  const f = await fixture(t,{interruptWriter:true,repeat:true,nativeSettlement:true,priorAttempts:2});
  assert.equal(f.sourceBefore.attemptNo,2); assert.equal(f.sourceBefore.admissions,2); assert.equal(f.sourceBefore.recovery!.budget.correctionsUsed,1);
  assert.equal(f.sourceBefore.steps[0].iterations!.length,1); assert.equal(f.sourceBefore.steps[0].iterations![0].index,0);
  const retained = f.ancestorIds.map(id=>f.service.get(id)!);
  const p = await f.prepare(); const assessment = p.assessment as any; assert.equal(assessment.plan.status,'prepared',JSON.stringify(assessment.blocked));
  assert.deepEqual(assessment.plan.repeatFrontiers,[{blockId:'loop',firstInvalidIteration:0,retainedSourceIterations:1,reason:'trusted-versioned-body-feedback-transition-contract-unavailable'}]);
  assert.equal(assessment.plan.correctionUsage.blocks[0].admittedWriters,2); assert.equal(assessment.plan.correctionUsage.blocks[0].limit,3);
  const childId = await select(f); const impl = await pendingApproval(f,'implementation'); f.service.approvals.grantFingerprint(impl.id,impl.requestHash);
  const app = await pendingApproval(f,'application'); f.service.approvals.grantFingerprint(app.id,app.requestHash); await f.service.drain();
  const child = f.service.get(childId)!; assert.equal(child.attemptNo,3); assert.equal(child.status,'completed'); assert.equal(child.admissions,6); assert.equal(child.recovery!.budget.correctionsUsed,2);
  const usage = recoveryWriterUsage([...retained,child],child); assert.equal(usage.blocks[0].admittedWriters,3); assert.equal(usage.blocks[0].corrections,2);
  assert.deepEqual(child.recovery!.budget.attemptIds,[...f.ancestorIds,childId]);
  for (const original of retained) { assert.deepEqual(f.service.get(original.workflowRunId)!.steps,original.steps); assert.deepEqual(f.service.get(original.workflowRunId)!.recovery!.operations,original.recovery!.operations); assert.equal((await f.service.execute({action:'workflows.forget',workflowRunId:original.workflowRunId})).ok,false); }
  assert.doesNotThrow(()=>recoverWorkflowState(f.base.read().extensions[WORKFLOW_EXTENSION_KEY]));
});

test('repeat writer allowance exhaustion after two real admitted killed writers blocks attempt three before grant/effect', {timeout:40000}, async t => {
  const f = await fixture(t,{interruptWriter:true,repeat:true,nativeSettlement:true,priorAttempts:2,writerLimit:2});
  const p = await f.prepare(); assert.equal((p.assessment as any).plan.status,'blocked'); assert.match(JSON.stringify(p.assessment),/family-repeat-writer-allowance-exhausted/);
  assert.equal(f.publications,0); assert.equal(f.nativeCalls,0); assert.equal(f.service.approvals.inspect().length,0); assert.equal(f.service.list().length,2);
});

test('SIGKILL fanout execution authorizes bounded future addresses but debits only two actual materialized native units', {timeout:25000}, async t => {
  const f = await fixture(t,{fanout:true,nativeSettlement:true}); const p=await f.prepare(); const a=p.assessment as any;
  assert.deepEqual(a.plan.executionAddresses.map((x:any)=>x.unitId),['fan:0','fan:1','fan:2']);
  assert.equal(a.plan.status,'prepared',JSON.stringify(a.blocked));
  const childId=await select(f); await f.service.drain(); const child=f.service.get(childId)!;
  assert.equal(child.status,'completed'); assert.equal(f.nativeCalls,2); assert.equal(child.admissions,3); assert.equal(child.steps[0].units.length,2); assert.equal(child.recovery!.operations.length,2);
  assert.equal(f.service.approvals.inspect().length,0); assert.deepEqual(f.service.get(f.ready.runId)!.steps,f.sourceBefore.steps);
  assert.doesNotThrow(()=>recoverWorkflowState(f.base.read().extensions[WORKFLOW_EXTENSION_KEY]));
});

test('three-attempt partial application family keeps old cleanup uncertainty but positive local settlement does not globally stop narrowed child', {timeout:45000}, async t => {
  const f=await fixture(t,{repeat:true,nativeSettlement:true,priorAttempts:2});
  assert.equal(f.sourceBefore.attemptNo,2); const root=f.service.get(f.ancestorIds[0])!; assert.equal(root.cleanupSettled,false); assert.equal(root.recovery!.operations.at(-1)!.kind,'application'); assert.equal(root.recovery!.operations.at(-1)!.result,undefined);
  const childId=await select(f); const impl=await pendingApproval(f,'implementation'); assert.deepEqual((impl.request.humanReview as any).trust.writablePaths,['src/b.txt']); f.service.approvals.grantFingerprint(impl.id,impl.requestHash);
  const app=await pendingApproval(f,'application'); f.service.approvals.grantFingerprint(app.id,app.requestHash); await f.service.drain(); const child=f.service.get(childId)!; assert.equal(child.status,'completed'); assert.equal(child.attemptNo,3); assert.equal(child.recovery!.budget.correctionsUsed,2);
  assert.equal(child.recovery!.operations.filter(op=>op.kind==='application').length,1); assert.deepEqual(child.recovery!.operations.find(op=>op.kind==='application')!.paths,['src/b.txt']);
  assert.deepEqual(f.service.get(root.workflowRunId)!.steps,root.steps); assert.deepEqual(f.service.get(root.workflowRunId)!.recovery!.operations,root.recovery!.operations); assert.equal(f.service.get(root.workflowRunId)!.cleanupSettled,false);
  assert.doesNotThrow(()=>recoverWorkflowState(f.base.read().extensions[WORKFLOW_EXTENSION_KEY]));
});

for (const phase of ['acquire','id','clock'] as const) for (const mutation of ['readonly','namespace','destination','artifact'] as const) test(`exact execution authorization ${phase}/${mutation} callback rejects before publication`, {timeout:25000}, async t => {
  const f=await fixture(t,{mutationPhase:phase,mutate:x=>{
    if (mutation==='readonly') x.base.replace({...x.base.read(),mode:{...x.base.read().mode,readOnly:true}});
    else if (mutation==='namespace') {const state=structuredClone(x.base.read()); (state.extensions[WORKFLOW_EXTENSION_KEY] as any).runs[0].error='external drift';x.base.replace(state);}
    else if (mutation==='destination') writeFileSync(join(x.projectRoot,'src/b.txt'),'hostile');
    else {const manifest=workflowStepEntries(x.sourceBefore).flatMap(e=>e.step.units).map(u=>(u.coding?.workspace as any)?.recoveryManifest).find(Boolean);writeFileSync(join(manifest.stageRoot,'src/b.txt'),'hostile');}
  }});
  const p=await f.prepare(); assert.equal(p.assessment.plan.status,'prepared');const a=await f.authorize(p.assessment.fingerprint);assert.equal(a.ok,false);assert.equal(f.publications,0);assert.equal(f.nativeCalls,0);assert.equal(f.service.list().filter(r=>r.recoveryOf===f.ready.runId).length,0);
});

for (const cancelBoundary of ['preflight','effect-intent'] as const) test(`selected fresh writer ${cancelBoundary} cancellation cannot write after host callbacks`, {timeout:25000}, async t=>{
  const f=await fixture(t,{cancelBoundary});const childId=await select(f);const impl=await pendingApproval(f,'implementation');f.armCancellation();f.service.approvals.grantFingerprint(impl.id,impl.requestHash);await f.service.drain();
  assert.equal(f.nativeCalls,0);assert.equal(f.service.get(childId)!.status,'cancelled',JSON.stringify(f.service.get(childId)));assert.equal(readFileSync(join(f.projectRoot,'src/a.txt'),'utf8'),'new\n');assert.equal(readFileSync(join(f.projectRoot,'src/b.txt'),'utf8'),'old\n');
  assert.equal(f.service.get(childId)!.recovery!.operations.filter(op=>op.kind==='stage-write'&&op.result?.status==='completed').length,0);
});

test('after canonical publication poison retains canonical selected child and bounded diagnostic without activation', {timeout:25000},async t=>{
  const f=await fixture(t,{failAfterCanonical:true});const p=await f.prepare();const a=await f.authorize(p.assessment.fingerprint);assert.equal(a.ok,false);assert.equal(f.publications,1);assert.equal(f.nativeCalls,0);
  const child=f.service.list().find(r=>r.recoveryOf===f.ready.runId)!;assert.ok(child);assert.equal(child.status,'running');assert.equal(child.recoveryDiagnostic!.publication,'canonical-selection-observed');assert.match(child.recoveryDiagnostic!.reason,/after canonical/);assert.ok(child.recoveryDiagnostic!.reason.length<=1024);assert.equal(f.service.approvals.inspect().length,0);
  const again=await f.authorize(p.assessment.fingerprint);assert.equal(again.ok,false);assert.match(again.error!,/poisoned/);
});

for (const outcome of ['cancelled','failed','restarted'] as const) test(`linked origin ${outcome} child cannot use model-facing ordinary retry to allocate attempt three`, {timeout:25000},async t=>{
  const f=await fixture(t);const childId=await select(f);const impl=await pendingApproval(f,'implementation');
  if (outcome==='failed') f.service.approvals.reject(impl.id,impl.request as any,'fixture rejection');
  else f.controller.abort();
  await f.service.drain(); const source=f.service.get(f.ready.runId)!, child=f.service.get(childId)!; assert.equal(child.status,outcome==='failed'?'failed':'cancelled'); assert.equal(child.cleanupSettled,true);assert.equal(child.recovered,false);assert.ok(child.recovery!.origin);
  const budget=structuredClone(child.recovery!.budget);const reply=await f.service.execute({action:'workflows.retry',workflowRunId:childId});assert.equal(reply.ok,false);assert.match(reply.error!,/Linked recovery.*fresh trusted recovery authorization/);assert.equal(f.service.list().length,2);assert.equal(f.nativeCalls,0);assert.deepEqual(f.service.get(childId)!.recovery!.budget,budget);assert.deepEqual(f.service.get(f.ready.runId)!.steps,source.steps);
  if (outcome==='restarted') {
    const restored=createClankersStateContainer();const persistence=createClankersPersistenceManager({snapshotFile:f.snapshotFile})!;persistence.hydrate(restored);const fresh=createWorkflowService(restored,f.native,f.config);
    const again=await fresh.execute({action:'workflows.retry',workflowRunId:childId});assert.equal(again.ok,false);assert.match(again.error!,/Linked recovery.*fresh trusted recovery authorization/);assert.equal(fresh.list().length,2);assert.equal(fresh.approvals.inspect().length,0);fresh.dispose();
  }
});

test('three actual killed writer attempts exhaust retained family; no fourth child or reset/refund', {timeout:40000},async t=>{
  const f=await fixture(t,{interruptWriter:true,repeat:true,nativeSettlement:true,priorAttempts:3});assert.equal(f.sourceBefore.attemptNo,3);assert.equal(f.sourceBefore.admissions,3);assert.equal(f.sourceBefore.recovery!.budget.correctionsUsed,2);
  const p=await f.prepare();assert.equal(p.assessment.plan.status,'blocked');assert.match(JSON.stringify(p.assessment.blocked),/family-attempt-budget-exhausted/);assert.match(JSON.stringify(p.assessment.blocked),/family-repeat-writer-allowance-exhausted/);
  const a=await f.authorize(p.assessment.fingerprint);assert.equal(a.ok,false);assert.equal(f.publications,0);assert.equal(f.nativeCalls,0);assert.equal(f.service.list().length,3);assert.deepEqual(f.service.get(f.ready.runId)!.recovery!.budget,f.sourceBefore.recovery!.budget);
});

test('real SIGKILL unrelated admitted native uncertainty blocks otherwise verified local partial-child scope', {timeout:25000},async t=>{
  const f=await fixture(t,{unrelated:true});const p=await f.prepare();assert.equal(p.assessment.plan.status,'blocked');assert.match(JSON.stringify(p.assessment.blocked),/unrelated-or-ancestor-settlement-unknown/);
  const unrelated=f.service.list().find(r=>r.familyId!==f.sourceBefore.familyId)!;assert.ok(unrelated);const raw=f.service.get(unrelated.workflowRunId)!;assert.equal(raw.steps[0].units[0].native!.runId,'unrelated-native');assert.equal(raw.steps[0].units[0].cleanupSettled,false);assert.equal(raw.recovery!.operations[0].result,undefined);
  assert.equal(f.publications,0);assert.equal(f.nativeCalls,0);const a=await f.authorize(p.assessment.fingerprint);assert.equal(a.ok,false);assert.equal(f.service.approvals.inspect().length,0);
});

test('real SIGKILL at repeat iteration one preserves all old transition history; invalid frontier zero cannot mask extra writer corrections', {timeout:30000},async t=>{
  const f=await fixture(t,{repeat:true,repeatHistory:true,nativeSettlement:true});const old=f.sourceBefore.steps[0];assert.equal(old.iterations!.length,2);assert.equal(old.iterations![0].decision,false);assert.deepEqual(old.iterations![0].feedback,{done:false});assert.equal(old.iterations![1].index,1);
  assert.equal(f.sourceBefore.admissions,4);assert.equal(f.sourceBefore.recovery!.budget.correctionsUsed,1);
  const p=await f.prepare();assert.equal(p.assessment.plan.status,'prepared',JSON.stringify(p.assessment.blocked));assert.equal(p.assessment.plan.repeatFrontiers[0].firstInvalidIteration,0);assert.equal(p.assessment.plan.correctionUsage.blocks[0].admittedWriters,2);
  const childId=await select(f);const impl=await pendingApproval(f,'implementation');f.service.approvals.grantFingerprint(impl.id,impl.requestHash);await f.service.drain();const child=f.service.get(childId)!;
  assert.equal(child.status,'needs-attention');assert.match(child.error!,/Family repeat writer\/correction allowance exhausted/);assert.equal(f.nativeCalls,2);assert.equal(child.admissions,7);assert.equal(child.recovery!.budget.correctionsUsed,2);
  assert.equal(child.recovery!.operations.filter(op=>op.kind==='native'&&op.unitId.includes('/stage:')).length,1);assert.equal(child.recovery!.operations.some(op=>op.kind==='application'),false);assert.equal(f.service.approvals.inspect().some(a=>a.kind==='application'),false);
  assert.equal(readFileSync(join(f.projectRoot,'src/b.txt'),'utf8'),'old\n');assert.deepEqual(f.service.get(f.ready.runId)!.steps,f.sourceBefore.steps);assert.deepEqual(f.service.get(f.ready.runId)!.recovery!.operations,f.sourceBefore.recovery!.operations);
});
