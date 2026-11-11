import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
async function fixture(t: any, options: { interruptWriter?: boolean; repeat?: boolean; nativeSettlement?: boolean; failAfterCommit?: boolean; cancelOnPublish?: boolean; priorAttempts?: number; writerLimit?: number; fanout?: boolean; failAfterCanonical?: boolean; unrelated?: boolean; repeatHistory?: boolean; cancelBoundary?: 'preflight' | 'effect-intent'; transferBoundary?: 'lease-intent' | 'lease-receipt' | 'new-root' | 'new-copy' | 'carry-mutation'; stageBoundary?: 'initial' | 'mutation' | 'two'; appBoundary?: 'first-write' | 'first-receipt' | 'second-intent' | 'second-write'; mutationPhase?: 'acquire' | 'id' | 'clock'; mutate?: (f: any) => void } = {}) {
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
    const transferBoundary=${JSON.stringify(options.transferBoundary ?? null)}; const boundary='after-write'; const stageBoundary=${JSON.stringify(options.stageBoundary ?? null)}, appBoundary=${JSON.stringify(options.appBoundary ?? 'first-write')}; const interruptWriter=${JSON.stringify(options.interruptWriter ?? false)};
    function checkpointBoundary(value){const child=value.extensions.workflows?.runs?.find(r=>r.attemptNo===2);const cws=child?.steps?.[0]?.units?.[0]?.coding?.workspace, tail2=child?.recovery?.operations.at(-1);if(transferBoundary && child && ((transferBoundary==='lease-intent'&&tail2?.kind==='cleanup'&&!tail2.result)||(transferBoundary==='lease-receipt'&&tail2?.kind==='cleanup'&&tail2.result)||(transferBoundary==='new-root'&&cws?.rootReady&&!cws.latestIntent)||(transferBoundary==='new-copy'&&cws?.latestIntent?.sequence===1&&!tail2.result)))pause();const ws=value.extensions.workflows?.runs?.[0]?.steps?.find(s=>s.id==='stage')?.units?.[0]?.coding?.workspace; const cp=value.extensions.workflows?.runs?.[0]?.recovery; const tail=cp?.operations.at(-1); if(stageBoundary==='initial' && ws?.latestIntent?.sequence===1 && !tail?.result)pause(); if(appBoundary==='first-receipt' && tail?.kind==='application' && tail.result?.status==='completed' && tail.paths[0]==='src/a.txt')pause(); if(appBoundary==='second-intent' && tail?.kind==='application' && !tail.result && tail.paths[0]==='src/b.txt')pause();} let nativeEntered=false; function pause(){const run=service.get(runId);const op=run.recovery.operations.findLast(o=>o.kind==='native'); const unit=run.steps.flatMap(s=>s.units).find(u=>u.id===op.unitId); const recorded=service.approvals.inspect().find(x=>x.status==='granted'&&x.kind===(interruptWriter?'implementation':'application')); fs.writeSync(1,JSON.stringify({runId,approvalId:recorded?.id,requestHash:recorded?.requestHash,lifecycle:{version:1,transport:'inline-owned-fixture',nativeEntered,operationId:op.id,unitId:op.unitId,inputHash:op.inputHash,dependencyHash:op.dependencyHash,policyHash:op.policyHash,native:unit.native??null},owner:store.inspectRecoveryOwnership().owner})+'\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0); }
    const originalRename=fs.renameSync;
    fs.renameSync=(from,to)=>{originalRename(from,to); if(transferBoundary==='carry-mutation'&&String(to).includes('/coding-')&&String(to).endsWith('/src/b.txt')&&service.get(runId)?.attemptNo===2&&fs.readFileSync(to,'utf8')==='new\\n')pause(); if(stageBoundary && stageBoundary!=='initial' && String(to).includes('/coding-') && String(to).endsWith(stageBoundary==='two'?'/src/b.txt':'/src/a.txt') && fs.readFileSync(to,'utf8')==='new\\n')pause(); if(!interruptWriter && !stageBoundary && boundary==='after-write' && to===join(projectRoot,appBoundary==='second-write'?'src/b.txt':'src/a.txt') && appBoundary!=='first-receipt' && appBoundary!=='second-intent')pause();}; syncBuiltinESMExports();
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
    const container={...base, replace(next){const value=createClankersState(next);store.save(value);checkpointBoundary(value);if(boundary==='before-write' && value.extensions.workflows?.runs?.some(r=>r.recovery?.operations.at(-1)?.kind==='application' && !r.recovery.operations.at(-1).result))pause();return base.replace(value);}, update(patch,options){const next=updateClankersState(base.read(),patch,options);store.save(next);checkpointBoundary(next);if(boundary==='before-write' && next.extensions.workflows?.runs?.some(r=>r.recovery?.operations.at(-1)?.kind==='application' && !r.recovery.operations.at(-1).result))pause();return base.replace(next);}};
    let runId='', approval;
    const keepAlive=setInterval(()=>{},1000);
    const native={preflight(){},async execute(req){nativeEntered=true;
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
    const ready = JSON.parse(processFixture.stdout.trim()) as { runId: string; approvalId: string; requestHash: string; lifecycle: any; owner: RecoveryWriterOwnerEvidence };
    assert.equal(processState(ready.owner), 'live'); assert.equal(ready.owner.pid, processFixture.producer.pid);
    processFixture.producer.kill('SIGKILL'); const [, signal] = await processFixture.closed; assert.equal(signal, 'SIGKILL'); assert.equal(processState(ready.owner), 'dead'); return ready;
  };
  let ready = await killProducer();
  const ancestorIds = [ready.runId], ancestorOwners = [ready.owner];
  for (let i = 1; i < (options.priorAttempts ?? (options.transferBoundary ? 2 : 1)); i++) {
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
      const index = ancestorIds.indexOf(req.workflowRunId), proof=ready.lifecycle;
      const bound=proof?.version===1 && proof.transport==='inline-owned-fixture' && ['unitId','operationId','inputHash','dependencyHash','policyHash','native'].every(k=>workflowHash((req as any)[k])===workflowHash(proof[k]));
      return options.nativeSettlement && index===ancestorIds.length-1 && bound && req.familyId===ancestorIds[0] && processState(ancestorOwners[index])==='dead' && (proof.nativeEntered || options.stageBoundary==='initial' || !!options.transferBoundary) ? 'settled' : 'unknown';
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
      if (!options.interruptWriter && !options.repeatHistory && !options.stageBoundary && options.appBoundary!=='second-write') {
        assert.deepEqual(req.coding!.policy.scope.writablePaths, ['src/b.txt']);
        assert.ok(req.coding!.policy.scope.readonlyPaths!.includes('src/a.txt'));
        assert.throws(() => req.coding!.write('src/a.txt','DUPLICATE'), /writable|read.only|outside/i);
      }
      // Carried bytes still require a genuinely new writer identity. No old edit status.
      if(options.stageBoundary){assert.equal(req.coding!.read('src/b.txt'), options.stageBoundary==='two'?'new\n':'old\n'); for(const p of req.coding!.policy.scope.writablePaths) req.coding!.write(p,'new\n');} else { assert.equal(req.coding!.read('src/b.txt'), options.repeatHistory ? 'refined\n' : options.transferBoundary && options.transferBoundary!=='carry-mutation' ? 'old\n' : 'new\n'); req.coding!.write('src/b.txt',options.repeatHistory ? 'refined\n' : 'new\n'); }
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
async function pendingApproval(f: Awaited<ReturnType<typeof fixture>>, kind: string) {
  try { return await waitFor(() => f.service.approvals.inspect().find(a => a.kind === kind && a.status === 'pending'), kind + ' approval'); } catch (error) { throw Error(String(error) + JSON.stringify(f.service.list())); }
}

// These four reproduce the independent review findings against the selected baseline.
for (const kind of ['stage-write','application'] as const) test(`integrated: readonly change in last ${kind} preflight blocks physical effect`, {timeout:30000}, async t => {
  const f=await fixture(t);const id=await select(f);const impl=await pendingApproval(f,'implementation');
  if(kind==='application') f.service.approvals.grantFingerprint(impl.id,impl.requestHash);
  const approval=kind==='application'?await pendingApproval(f,'application'):impl;
  let calls=0, mutated=false,target='';
  f.native.preflight=()=>{
    const cp=(f.base.read().extensions[WORKFLOW_EXTENSION_KEY] as any)?.runs?.find((r:any)=>r.workflowRunId===id)?.recovery;
    if(cp?.operations.at(-1)?.kind===kind && !cp.operations.at(-1).result && !mutated && ++calls===2){mutated=true;target=cp.operations.at(-1).id;f.base.update({mode:{...f.base.read().mode,readOnly:true}});}
  };
  f.service.approvals.grantFingerprint(approval.id,approval.requestHash);await f.service.drain().catch(()=>{});
  assert.equal(mutated,true,JSON.stringify({calls,child:f.service.get(id)}));assert.notEqual(f.service.get(id)!.recovery!.operations.find(o=>o.id===target)?.result?.status,'completed');
  if(kind==='application') assert.equal(readFileSync(join(f.projectRoot,'src/b.txt'),'utf8'),'old\n');
});
test('integrated: mismatched returned reviewer identity cannot create application approval',{timeout:30000},async t=>{
  const f=await fixture(t);const id=await select(f);const original=f.native.execute;
  f.native.execute=async req=>{const out=await original(req);return req.coding?.operation==='review'?{...out,identity:{runId:'other-reviewer',taskId:'other-task'}}:out;};
  const impl=await pendingApproval(f,'implementation');f.service.approvals.grantFingerprint(impl.id,impl.requestHash);await f.service.drain().catch(()=>{});
  assert.equal(f.service.approvals.inspect().some(a=>a.kind==='application'),false);
  assert.notEqual(f.service.get(id)!.steps.find(s=>s.id==='review')!.status,'completed');
});
test('integrated: positive prior lifecycle observation becoming unknown blocks fresh effects',{timeout:30000},async t=>{
  const f=await fixture(t,{interruptWriter:true,nativeSettlement:true});let positive=true;
  const observe=f.config.recovery!.inspectNativeSettlement!;
  f.config.recovery!.inspectNativeSettlement=req=>positive?observe(req):'unknown';
  const id=await select(f);const impl=await pendingApproval(f,'implementation');const before=readdirSync(f.stagingParent).sort();positive=false;
  f.service.approvals.grantFingerprint(impl.id,impl.requestHash);await f.service.drain().catch(()=>{});
  assert.equal(f.nativeCalls,0);assert.deepEqual(readdirSync(f.stagingParent).sort(),before);
  assert.equal(f.service.approvals.inspect().some(a=>a.kind==='application'),false);
  assert.equal(f.service.get(f.ready.runId)!.cleanupSettled,false);
});

for(const stageBoundary of ['initial','mutation','two'] as const) test(`integrated: real SIGKILL ${stageBoundary} pending stage result -> exact selected fresh gates/application`,{timeout:45000},async t=>{
  const f=await fixture(t,{stageBoundary,nativeSettlement:true});const source=f.service.get(f.ready.runId)!;
  const ws=(source.steps[0].units[0].coding!.workspace as any);
  assert.ok(ws.rootReady);assert.notEqual(ws.latestObservation?.sequence,ws.latestIntent.sequence);
  assert.equal(source.recovery!.operations.at(-1)!.result,undefined);
  const id=await select(f);assert.equal(f.nativeCalls,0);const impl=await pendingApproval(f,'implementation');
  f.service.approvals.grantFingerprint(impl.id,impl.requestHash);const app=await pendingApproval(f,'application');
  assert.equal(f.nativeCalls,2);const check=f.service.get(id)!.steps.find(s=>s.id==='check')!.units[0];
  assert.equal((check.coding!.evidence as any).durableCheck.receipt.commandCompleted,true);
  f.service.approvals.grantFingerprint(app.id,app.requestHash);await f.service.drain();
  assert.equal(f.service.get(id)!.status,'completed');for(const p of ['a','b'])assert.equal(readFileSync(join(f.projectRoot,`src/${p}.txt`),'utf8'),'new\n');
  assert.deepEqual(f.service.get(f.ready.runId)!.steps,source.steps);assert.deepEqual(f.service.get(f.ready.runId)!.recovery!.operations,source.recovery!.operations);
});

for(const appBoundary of ['first-write','first-receipt','second-intent'] as const) test(`integrated: real two-path application ${appBoundary} ordered receipt prefix, fresh narrowed apply without duplicate postimage`,{timeout:45000},async t=>{
  const f=await fixture(t,{appBoundary});const source=f.service.get(f.ready.runId)!;
  const originalA=readFileSync(join(f.projectRoot,'src/a.txt')), originalInode=lstatSync(join(f.projectRoot,'src/a.txt')).ino;const id=await select(f);
  const impl=await pendingApproval(f,'implementation');assert.deepEqual((impl.request.humanReview as any).trust.writablePaths,['src/b.txt']);
  f.service.approvals.grantFingerprint(impl.id,impl.requestHash);const app=await pendingApproval(f,'application');
  assert.deepEqual(readFileSync(join(f.projectRoot,'src/a.txt')),originalA);assert.equal(readFileSync(join(f.projectRoot,'src/b.txt'),'utf8'),'old\n');
  const child=f.service.get(id)!;const check=child.steps.find(s=>s.id==='check')!.units[0];assert.equal((check.coding!.evidence as any).durableCheck.receipt.commandOutcome.exitCode,0);
  f.service.approvals.grantFingerprint(app.id,app.requestHash);await f.service.drain();
  const done=f.service.get(id)!;assert.equal(done.status,'completed');assert.deepEqual(done.recovery!.operations.filter(o=>o.kind==='application').map(o=>o.paths),[['src/b.txt']]);
  assert.deepEqual(readFileSync(join(f.projectRoot,'src/a.txt')),originalA);assert.equal(lstatSync(join(f.projectRoot,'src/a.txt')).ino,originalInode,'no duplicate destination rename');assert.equal(readFileSync(join(f.projectRoot,'src/b.txt'),'utf8'),'new\n');
  assert.deepEqual(f.service.get(f.ready.runId)!.steps,source.steps);assert.deepEqual(f.service.get(f.ready.runId)!.recovery!.operations,source.recovery!.operations);
});
test('integrated: full two-path postimage after SIGKILL is not historical completion or zero-write authority',{timeout:30000},async t=>{
  const f=await fixture(t,{appBoundary:'second-write'});const p=await f.prepare();assert.equal(p.assessment.plan.status,'blocked');assert.match(JSON.stringify(p.assessment.blocked),/fully-satisfied-zero-write/);
  const a=await f.authorize(p.assessment.fingerprint);assert.equal(a.ok,false);assert.equal(f.publications,0);assert.equal(f.nativeCalls,0);
  assert.equal(f.service.get(f.ready.runId)!.recovery!.operations.at(-1)!.result,undefined);
});
test('integrated: ordered partial proof rejects mutated hashes, generations, source units and missing prefix; unknown lifecycle is default',{timeout:30000},async t=>{
  const f=await fixture(t,{stageBoundary:'two',nativeSettlement:true});const original=f.base.snapshot();
  const corruptions: Array<[string,(run:any)=>void]>=[
    ['resultHash',r=>{r.recovery.operations.find((o:any)=>o.kind==='stage-write'&&o.result).result.resultHash='0'.repeat(64);} ],
    ['evidenceHash',r=>{r.recovery.operations.find((o:any)=>o.kind==='stage-write'&&o.result).result.evidenceHash='0'.repeat(64);} ],
    ['missing hash',r=>{delete r.recovery.operations.find((o:any)=>o.kind==='stage-write'&&o.result).result.resultHash;} ],
    ['observation prefix',r=>{r.steps[0].units[0].coding.workspace.effectObservations.shift();}],
    ['pending generation',r=>{r.recovery.operations.at(-1).generation='other';}],
    ['pending source unit',r=>{r.recovery.operations.at(-1).unitId='other:0';}],
    ['changed full observed candidate',r=>{r.steps[0].units[0].coding.candidateHash='0'.repeat(64);}],
    ['extra pending',r=>{const op=structuredClone(r.recovery.operations.at(-1));op.id+=':extra';op.sequence=r.recovery.operations.length;r.recovery.operations.push(op);r.recovery.sequence++;}],
  ];
  for(const [label,mutate] of corruptions){
    const snapshot=structuredClone(original);mutate((snapshot.extensions[WORKFLOW_EXTENSION_KEY] as any).runs[0]);
    let s:ReturnType<typeof createWorkflowService>|undefined;
    try{s=createWorkflowService(createClankersStateContainer(snapshot),f.native,f.config);const p=await s.recovery!.prepare(f.ready.runId,f.selections);assert.equal((p.assessment as any).plan.status,'blocked',label);}
    catch(e){assert.match(String(e),/Recovery checkpoint|Invalid.*recovery/,label);}finally{s?.dispose();}
  }
  const config={...f.config,recovery:{...f.config.recovery!,inspectNativeSettlement:undefined}};
  const unknown=createWorkflowService(createClankersStateContainer(original),f.native,config);
  try{const p=await unknown.recovery!.prepare(f.ready.runId,f.selections);assert.equal((p.assessment as any).plan.status,'blocked');assert.match(JSON.stringify(p.assessment),/previous-native-settlement-unknown/);}finally{unknown.dispose();}
  assert.equal(f.nativeCalls,0);assert.equal(f.publications,0);
});

for(const transferBoundary of ['lease-intent','lease-receipt','new-root','new-copy','carry-mutation'] as const) test(`integrated: real second owner SIGKILL at ${transferBoundary} retains original source/carry and truthful cleanup receipts`,{timeout:45000},async t=>{
  const f=await fixture(t,{transferBoundary,nativeSettlement:true});const source=f.sourceBefore;
  const ws=(source.steps[0].units[0].coding!.workspace as any);assert.ok(ws.sourceCarry);assert.equal(ws.sourceCarry.historicalCompletion,false);
  assert.equal(ws.sourceCarry.sourceWorkflowId,f.ancestorIds[0]);assert.ok(ws.sourceCarry.observedManifest);
  const ancestor=f.service.get(f.ancestorIds[0])!;assert.equal(ws.sourceCarry.sourceHistoryHash,workflowHash({steps:ancestor.steps,recoveryOriginal:ancestor.recoveryOriginal??null,operations:ancestor.recovery!.operations}));
  assert.equal(ancestor.cleanupSettled,false);assert.equal(ancestor.recovery!.operations.find(o=>o.kind==='application')!.result,undefined);
  assert.ok(source.recovery!.operations.some(o=>o.kind==='cleanup'));assert.equal(source.recovery!.operations.some(o=>o.kind==='stage-write'&&o.paths.length===0),false);
  if(transferBoundary==='lease-intent'||transferBoundary==='lease-receipt'){
    const p=await f.prepare();assert.equal(p.assessment.plan.status,'blocked');assert.ok(ws.leaseIntents.length>0);
    if(transferBoundary==='lease-receipt')assert.ok(ws.leaseObservations.length>0);
    assert.equal(f.nativeCalls,0);assert.equal(f.publications,0);return;
  }
  const id=await select(f);const impl=await pendingApproval(f,'implementation');f.service.approvals.grantFingerprint(impl.id,impl.requestHash);
  const app=await pendingApproval(f,'application');f.service.approvals.grantFingerprint(app.id,app.requestHash);await f.service.drain();
  assert.equal(f.service.get(id)!.status,'completed');assert.deepEqual(f.service.get(f.ready.runId)!.steps,source.steps);
  assert.deepEqual(f.service.get(f.ready.runId)!.recovery!.operations,source.recovery!.operations);
  assert.deepEqual(f.service.get(id)!.recovery!.operations.filter(o=>o.kind==='application').map(o=>o.paths),[['src/b.txt']]);
});

for(const drift of ['owner','source-root','check-receipt'] as const) test(`integrated: fresh grant revalidates exact prior ${drift} settlement, no cached membership bypass`,{timeout:30000},async t=>{
  const f=await fixture(t);const id=await select(f);const impl=await pendingApproval(f,'implementation');const dirs=readdirSync(f.stagingParent).sort();
  if(drift==='owner') f.config.recovery!.durablePort!.inspectPreviousOwner=()=> 'unknown';
  else if(drift==='source-root') {
    const manifest=(f.sourceBefore.steps.find(s=>s.id==='stage')!.units[0].coding!.workspace as any).recoveryManifest;
    writeFileSync(join(manifest.stageRoot,'src/b.txt'),'foreign');
  } else {
    const receipt=(f.sourceBefore.steps.find(s=>s.id==='check')!.units[0].coding!.evidence as any).durableCheck.config;
    writeFileSync(join(receipt.receiptDir,receipt.generation+'.receipt.json'),'{}');
  }
  f.service.approvals.grantFingerprint(impl.id,impl.requestHash);await f.service.drain().catch(()=>{});
  assert.equal(f.nativeCalls,0);assert.deepEqual(readdirSync(f.stagingParent).sort(),dirs);assert.equal(f.service.approvals.inspect().some(a=>a.kind==='application'),false);
  assert.deepEqual(f.service.get(f.ready.runId)!.steps,f.sourceBefore.steps);assert.equal(f.service.get(f.ready.runId)!.cleanupSettled,false);
});
for(const drift of ['agent','revoke'] as const) test(`integrated: final preflight ${drift} mutation invalidates exact live implementation before stage effect`,{timeout:30000},async t=>{
  const f=await fixture(t);const id=await select(f);const impl=await pendingApproval(f,'implementation');let mutated=false;
  f.native.preflight=()=>{
    const cp=(f.base.read().extensions[WORKFLOW_EXTENSION_KEY] as any)?.runs?.find((r:any)=>r.workflowRunId===id)?.recovery;
    if(cp?.operations.at(-1)?.kind==='stage-write'&&!cp.operations.at(-1).result&&!mutated){mutated=true;
      if(drift==='agent') f.base.update({agentDefinitions:{...f.base.read().agentDefinitions,worker:{...f.base.read().agentDefinitions.worker,prompt:'changed after intent'}}});
      else f.service.approvals.revoke(impl.id,impl.request as any,'preflight revoke');
    }
  };
  f.service.approvals.grantFingerprint(impl.id,impl.requestHash);await f.service.drain().catch(()=>{});assert.equal(mutated,true);assert.equal(f.nativeCalls,0);
  assert.equal(f.service.get(id)!.recovery!.operations.some(o=>o.kind==='stage-write'&&o.result?.status==='completed'),false);
});
test('integrated: host clock callback cannot invalidate source lifecycle after final cached check',{timeout:30000},async t=>{
  let armed=false, invalidated=false;const f=await fixture(t,{interruptWriter:true,nativeSettlement:true,mutationPhase:'clock',mutate:x=>{if(armed&&!invalidated){invalidated=true;x.config.recovery.inspectNativeSettlement=()=> 'unknown';}}});
  const id=await select(f);const impl=await pendingApproval(f,'implementation');armed=true;
  f.service.approvals.grantFingerprint(impl.id,impl.requestHash);await f.service.drain().catch(()=>{});
  assert.equal(invalidated,true);assert.equal(f.nativeCalls,0);assert.equal(f.service.get(id)!.recovery!.operations.some(o=>o.kind==='stage-write'),false);
});


for (const kind of ['stage-write','application'] as const) test(`integrated: final ${kind} preflight invalidates prior-native settlement`, {timeout:40000}, async t => {
  const f=await fixture(t,{interruptWriter:true,nativeSettlement:true}); let positive=true;
  const observe=f.config.recovery!.inspectNativeSettlement!;
  f.config.recovery!.inspectNativeSettlement=req=>positive?observe(req):'unknown';
  const id=await select(f); const impl=await pendingApproval(f,'implementation');
  if(kind==='application') f.service.approvals.grantFingerprint(impl.id,impl.requestHash);
  const approval=kind==='application'?await pendingApproval(f,'application'):impl;
  let calls=0,mutated=false,target='';
  f.native.preflight=()=>{
    const cp=(f.base.read().extensions[WORKFLOW_EXTENSION_KEY] as any)?.runs?.find((r:any)=>r.workflowRunId===id)?.recovery;
    if(cp?.operations.at(-1)?.kind===kind && !cp.operations.at(-1).result && !mutated && ++calls===2){mutated=true; target=cp.operations.at(-1).id; positive=false;}
  };
  f.service.approvals.grantFingerprint(approval.id,approval.requestHash); await f.service.drain().catch(()=>{});
  const child=f.service.get(id)!; const op=child.recovery!.operations.find(o=>o.id===target);
  const ws=child.steps.find(s=>s.id==='stage')!.units[0].coding?.workspace as any;
  const root=ws?.rootReady?.stageRoot || ws?.recoveryManifest?.stageRoot;
  assert.equal(mutated,true); assert.notEqual(op?.result?.status,'completed','physical effect has completed despite previous lifecycle unknown');
  if(kind==='application') assert.equal(readFileSync(join(f.projectRoot,'src/b.txt'),'utf8'),'old\n');
  else assert.equal(existsSync(join(root,'src/a.txt')),false,'physical stage copy must not occur after lifecycle invalidation');
});
for(const drift of ['owner','check-receipt'] as const) test(`integrated: final application preflight invalidates ${drift}`, {timeout:40000},async t=>{
  const f=await fixture(t);const id=await select(f);const impl=await pendingApproval(f,'implementation');
  f.service.approvals.grantFingerprint(impl.id,impl.requestHash);const app=await pendingApproval(f,'application');
  let calls=0,mutated=false,target='';const inspect=f.config.recovery!.durablePort!.inspectOwner!;
  f.native.preflight=()=>{
    const cp=(f.base.read().extensions[WORKFLOW_EXTENSION_KEY] as any)?.runs?.find((r:any)=>r.workflowRunId===id)?.recovery;
    if(cp?.operations.at(-1)?.kind==='application'&&!cp.operations.at(-1).result&&!mutated&&++calls===2){mutated=true;target=cp.operations.at(-1).id;
      if(drift==='owner')f.config.recovery!.durablePort!.inspectOwner=()=>({...inspect(),ownerValid:false,blocker:'ownership-unknown'});
      else {const receipt=(f.sourceBefore.steps.find(s=>s.id==='check')!.units[0].coding!.evidence as any).durableCheck.config;writeFileSync(join(receipt.receiptDir,receipt.generation+'.receipt.json'),'{}');}
    }
  };
  f.service.approvals.grantFingerprint(app.id,app.requestHash);await f.service.drain().catch(()=>{});
  assert.equal(mutated,true);assert.equal(readFileSync(join(f.projectRoot,'src/b.txt'),'utf8'),'old\n','write after final preflight invalidated trusted settlement/ownership');
});
for (const drift of ['lifecycle','satisfied'] as const) test(`integrated: final application preflight ${drift} fence`,{timeout:40000},async t=>{
 const f=await fixture(t);const id=await select(f);const impl=await pendingApproval(f,'implementation');f.service.approvals.grantFingerprint(impl.id,impl.requestHash);const app=await pendingApproval(f,'application');let calls=0,mutated=false,target='';
 f.native.preflight=()=>{
  const cp=(f.base.read().extensions[WORKFLOW_EXTENSION_KEY] as any)?.runs?.find((r:any)=>r.workflowRunId===id)?.recovery;
  if(cp?.operations.at(-1)?.kind==='application'&&!cp.operations.at(-1).result&&!mutated&&++calls===2){mutated=true;target=cp.operations.at(-1).id;
   if(drift==='lifecycle')f.base.update({lifecycle:'disposed'});else writeFileSync(join(f.projectRoot,'src/a.txt'),'foreign\n');
  }
 };
 f.service.approvals.grantFingerprint(app.id,app.requestHash);await f.service.drain().catch(()=>{});
 assert.equal(mutated,true);assert.equal(readFileSync(join(f.projectRoot,'src/b.txt'),'utf8'),'old\n',`${drift} change after preflight must block application`);
});

for (const drift of ['canonical-lifecycle', 'check-receipt', 'physical-claim', 'physical-marker', 'snapshot-head'] as const) test(`integrated: owner inspector mutates ${drift} after reading, pure effect boundary rejects`, {timeout:40000}, async t => {
  const f = await fixture(t); const id = await select(f);
  const impl = await pendingApproval(f, 'implementation'); f.service.approvals.grantFingerprint(impl.id, impl.requestHash);
  const app = await pendingApproval(f, 'application'); const inspect = f.config.recovery!.durablePort!.inspectOwner!;
  let mutated = false;
  f.config.recovery!.durablePort!.inspectOwner = () => {
    const observed = inspect();
    const cp = (f.base.read().extensions[WORKFLOW_EXTENSION_KEY] as any).runs.find((r:any) => r.workflowRunId === id).recovery;
    if (!mutated && cp.operations.at(-1)?.kind === 'application' && !cp.operations.at(-1).result) {
      mutated = true;
      if (drift === 'canonical-lifecycle') f.base.update({lifecycle:'disposed'});
      else if (drift === 'physical-claim') mkdirSync(observed.claimDir, {mode:0o700});
      else if (drift === 'physical-marker') {
        const path = join(observed.lockDir, 'owner.json'), marker = JSON.parse(readFileSync(path, 'utf8'));
        marker.owner.generation = '0'.repeat(32); writeFileSync(path, JSON.stringify(marker));
      }
      else if (drift === 'snapshot-head') writeFileSync(f.snapshotFile, '{}');
      else {
        const receipt = (f.sourceBefore.steps.find(s=>s.id==='check')!.units[0].coding!.evidence as any).durableCheck.config;
        writeFileSync(join(receipt.receiptDir, receipt.generation+'.receipt.json'), '{}');
      }
    }
    return observed; // Deliberately stale but positive: not a fake positive lifecycle proof.
  };
  f.service.approvals.grantFingerprint(app.id, app.requestHash); await f.service.drain().catch(()=>{});
  assert.equal(mutated, true); assert.equal(readFileSync(join(f.projectRoot, 'src/b.txt'), 'utf8'), 'old\n');
});

for (const drift of ['owner-to-native', 'native-to-canonical'] as const) test(`integrated: settlement observer ${drift} mutation cannot bypass stable sweeps/pure fences`, {timeout:40000}, async t => {
  const f = await fixture(t, {interruptWriter:true, nativeSettlement:true}); let positive = true, mutated = false;
  const native = f.config.recovery!.inspectNativeSettlement!;
  f.config.recovery!.inspectNativeSettlement = request => {
    const result = positive ? native(request) : 'unknown';
    const cp = (f.base.read().extensions[WORKFLOW_EXTENSION_KEY] as any).runs.find((r:any)=>r.workflowRunId==='selected-child')?.recovery;
    if (drift === 'native-to-canonical' && !mutated && cp?.operations.at(-1)?.kind === 'stage-write' && !cp.operations.at(-1).result) {
      mutated = true; f.base.update({mode:{...f.base.read().mode,readOnly:true}});
    }
    return result;
  };
  const previous = f.config.recovery!.durablePort!.inspectPreviousOwner!;
  f.config.recovery!.durablePort!.inspectPreviousOwner = owner => {
    const result = previous(owner);
    const cp = (f.base.read().extensions[WORKFLOW_EXTENSION_KEY] as any).runs.find((r:any)=>r.workflowRunId==='selected-child')?.recovery;
    if (drift === 'owner-to-native' && !mutated && cp?.operations.at(-1)?.kind === 'stage-write' && !cp.operations.at(-1).result) { mutated = true; positive = false; }
    return result;
  };
  const id = await select(f); const impl = await pendingApproval(f, 'implementation');
  f.service.approvals.grantFingerprint(impl.id, impl.requestHash); await f.service.drain().catch(()=>{});
  assert.equal(mutated,true); assert.equal(f.nativeCalls,0);
  const child = f.service.get(id)!;
  assert.equal(child.recovery!.operations.some(o=>o.kind==='stage-write'&&o.result?.status==='completed'),false);
  assert.deepEqual(f.service.get(f.ready.runId)!.steps, f.sourceBefore.steps);
});

test('integrated: final preflight mutates root-ready-only source bytes; transferred leases do not bypass source fence', {timeout:40000}, async t => {
  const f = await fixture(t, {stageBoundary:'initial', nativeSettlement:true}); const source = f.sourceBefore;
  const id = await select(f), impl = await pendingApproval(f, 'implementation'); let calls = 0, mutated = false;
  const root = (source.steps[0].units[0].coding!.workspace as any).rootReady.stageRoot;
  f.native.preflight = () => {
    const cp = (f.base.read().extensions[WORKFLOW_EXTENSION_KEY] as any).runs.find((r:any)=>r.workflowRunId===id).recovery;
    if (!mutated && cp.operations.at(-1)?.kind === 'stage-write' && !cp.operations.at(-1).result && ++calls === 2) {
      mutated = true; mkdirSync(join(root, 'src'), {recursive:true,mode:0o700}); writeFileSync(join(root,'src/a.txt'),'foreign\n',{mode:0o600});
    }
  };
  f.service.approvals.grantFingerprint(impl.id,impl.requestHash); await f.service.drain().catch(()=>{});
  assert.equal(mutated,true); assert.equal(f.nativeCalls,0);
  assert.equal(f.service.get(id)!.recovery!.operations.some(o=>o.kind==='stage-write'&&o.result?.status==='completed'),false);
  assert.deepEqual(f.service.get(f.ready.runId)!.steps,source.steps);
});
