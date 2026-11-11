import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClankersStateContainer } from '../state.js';
import { createClankersPersistenceManager } from '../persistence.js';
import { createWorkflowService } from '../workflow-runtime.js';
import { workflowHash } from '../workflow-model.js';
import { inspectPartialWorkspaceArtifacts } from '../workflow-workspace.js';

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const paths = ['src/a.txt', 'src/b.txt'];
const inputs = ['src/ro.txt', ...paths];
const url = (file: string) => JSON.stringify(new URL('../' + file + '.ts', import.meta.url).href);
const inventory = (p: string): unknown => { const st = lstatSync(p); return [st.ino, st.mode, st.nlink, st.isDirectory() ? readdirSync(p).sort().map(n => [n, inventory(join(p, n))]) : sha(readFileSync(p))]; };

type Mode = 'initial' | 'copy2' | 'mutation' | 'two' | 'root-fail' | 'intent-fail' | 'receipt-fail' | 'cancel-root' | 'cancel-intent' | 'cancel-mutation' | 'cancel-preflight' | 'cancel-owner' | 'reserve-mutation';
async function producer(mode: Mode, inspect: (f: { root: string; project: string; staging: string; snapshotFile: string; ready: any; raw: any }) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'clankers-partial-service-')), oldTmp = process.env.TMPDIR;
  process.env.TMPDIR = root;
  const project = join(root, 'project'), staging = join(root, 'stage'), snapshotFile = join(root, 'state.json');
  mkdirSync(join(project, 'src'), { recursive: true, mode: 0o700 }); mkdirSync(staging, { mode: 0o700 });
  const fixturePaths = mode === 'reserve-mutation' ? [...paths, ...Array.from({ length: 6 }, (_, i) => `src/f${i}.txt`)] : paths;
  const fixtureInputs = ['src/ro.txt', ...fixturePaths];
  for (const path of fixtureInputs) writeFileSync(join(project, path), `${path.slice(4, -4)}-old\n`);
  writeFileSync(join(project, 'unrelated'), 'KEEP');
  const driver = `
    import { createHash } from 'node:crypto';
    import { existsSync, readFileSync } from 'node:fs';
    import { createWorkflowService } from ${url('workflow-runtime')};
    import { createClankersStateContainer, updateClankersState, createClankersState } from ${url('state')};
    import { createClankersPersistenceManager } from ${url('persistence')};
    import { workflowJson, WORKFLOW_LIMITS } from ${url('workflow-model')};
    const [mode,projectRoot,stagingParent,snapshotFile]=process.argv.slice(1);
    const paths=${JSON.stringify(fixturePaths)}, inputs=${JSON.stringify(fixtureInputs)};
    const sha=s=>createHash('sha256').update(s).digest('hex');
    const str={type:'string',maxLength:256}, obj=p=>({type:'object',properties:p,required:Object.keys(p),additionalProperties:false});
    const policy={version:3,capabilities:['stage-write'],identity:{parentRunId:'fixture',taskId:'task',attemptNo:1,workerAgentId:'worker',rootAgentId:'worker',model:'fake/model'},scope:{task:'Edit both fixture files',writablePaths:paths,readonlyPaths:['src/ro.txt'],baseline:{projectRootId:projectRoot,stateHash:sha('baseline')},manifest:paths.map(path=>{const text=readFileSync(projectRoot+'/'+path,'utf8');return {path,text,bytes:Buffer.byteLength(text),sha256:sha(text)};})}};
    const definition={id:'partial-service',version:3,label:'Partial service',inputSchema:obj({}),steps:[{id:'stage',kind:'coding',dependsOn:[],inputs:{},outputSchema:obj({candidateHash:str,changedPaths:{type:'array',maxItems:8,items:str}}),coding:{operation:'stage-write',policy}}]};
    const base=createClankersStateContainer({agentDefinitions:{worker:{id:'worker',label:'Worker',source:'runtime',prompt:'writer',model:'fake/model',permissionMode:'inherit'}}});
    const store=createClankersPersistenceManager({snapshotFile});store.hydrate(base);
    let acquired=false, nativeCalls=0, failed=false, faultCount=0, expectedHash=null, cancelled=false, reserveDiagnostic=null;
    const nodes=x=>1+(x&&typeof x==='object'?Object.values(x).reduce((n,v)=>n+nodes(v),0):0);
    function stop(){process.stdout.write(JSON.stringify({runId:'partial-run',nativeCalls,faultCount,expectedHash,cancelled,reserveDiagnostic,owner:store.inspectRecoveryOwnership().owner})+'\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
    function publish(next){
      const unit=next.extensions.workflows?.runs?.[0]?.steps?.[0]?.units?.[0], ws=unit?.coding?.workspace;
      const initial=ws?.latestIntent?.preimageHash===null;
      const changed=ws?.latestObservation?.postimageHash===sha('a-new\\n');
      if(!failed && (mode==='mutation'||mode==='two'||mode==='receipt-fail') && changed){
        if(mode==='receipt-fail'){failed=true;faultCount++;throw Error('receipt fault before save');}
        stop(); // Real mutation already happened; authoritative snapshot still holds pending intent.
      }
      if(acquired)store.commitRecoverySnapshot(next);else store.save(next);
      if(!failed && ((mode==='initial' && ws?.latestIntent?.sequence===1)||(mode==='copy2' && ws?.latestIntent?.sequence===2)))stop();
      if(!failed && ((mode==='root-fail'&&ws?.rootReady&&!ws.latestIntent)||(mode==='intent-fail'&&initial&&ws?.latestIntent?.sequence===1))){failed=true;faultCount++;throw Error('publication fault after save');}
      return base.replace(next);
    }
    const container={...base,replace(next){return publish(createClankersState(next));},update(patch,options){return publish(updateClankersState(base.read(),patch,options));}};
    let service, armedPreflight=false;
    function cancel(){if(!cancelled){cancelled=true;service.execute({action:'workflows.cancel',workflowRunId:'partial-run'}).then(r=>{if(!r.ok)throw Error(r.error);});}}
    const port={preflight(){if(mode==='cancel-preflight' && armedPreflight)cancel();},async execute(req){nativeCalls++;req.onIdentity({runId:'native-writer',taskId:'native-task'});if(mode==='two')req.coding.write('src/b.txt','b-new\\n');
      if(mode==='reserve-mutation'){
        const arr=items=>({type:'array',maxItems:32,items});
        const def={id:'padding',version:1,label:'Bounded retained inputs',inputSchema:obj({pad:arr(arr(arr({type:'null'})))}),steps:[{id:'hold',kind:'native',agentId:'worker',dependsOn:[],inputs:{},prompt:'readonly',outputSchema:obj({})}]};
        let reply=await service.execute({action:'workflows.define',definition:def});if(!reply.ok)throw Error(reply.error);
        const makePad=n=>{const out=[];while(n){const group=[];for(let i=0;i<32&&n;i++){const size=Math.min(32,n);group.push(Array(size).fill(null));n-=size;}out.push(group);}return out;};
        const startPad=async n=>{const r=await service.execute({action:'workflows.start',definitionId:'padding',inputs:{pad:makePad(n)}});if(!r.ok)throw Error(r.error);};
        const count=()=>nodes(base.read().extensions.workflows);
        const before=count();await startPad(0);const overhead=count()-before-nodes({pad:[]});
        // Leave enough for the old 512-node reserve, but not a full 8-path manifest.
        const target=20000-900;
        for(let i=0;i<8&&count()<target-32;i++){
          let n=Math.min(6000,target-count()-overhead-2);while(n>0&&count()+overhead+nodes({pad:makePad(n)})>target)n--;
          if(n<=0)break;await startPad(n);
        }
        const ws=service.get('partial-run').steps[0].units[0].coding.workspace;
        reserveDiagnostic={beforeEffectNodes:count(),stagedHash:sha(readFileSync(ws.rootReady.stageRoot+'/src/a.txt')),paddingRuns:base.read().extensions.workflows.runs.length-1};
        try{req.coding.write('src/a.txt','a-new\\n');reserveDiagnostic.effectReturned=true;}catch(e){
          reserveDiagnostic.error=String(e);
          const projected=structuredClone(base.read().extensions.workflows);
          projected.runs.find(r=>r.workflowRunId==='partial-run').steps[0].units[0].coding.workspace.recoveryManifest=e.lastKnownManifest;
          reserveDiagnostic.actualManifestNodes=nodes(e.lastKnownManifest);
          reserveDiagnostic.ledgerWithActualManifestNodes=nodes(projected);
          // A real retained manifest alone already exceeds the old available
          // headroom; the next receipt would grow it further after the write.
          try{workflowJson(projected,WORKFLOW_LIMITS.ledgerBytes);}catch(err){reserveDiagnostic.postEffectCapacityError=String(err);}
        }
        reserveDiagnostic.afterHash=sha(readFileSync(ws.rootReady.stageRoot+'/src/a.txt'));
        reserveDiagnostic.authoritativeHash=base.read().extensions.workflows.runs.find(r=>r.workflowRunId==='partial-run').steps[0].units[0].coding.workspace.latestIntent.postimageHash;
        stop();
      }
      expectedHash=sha(JSON.stringify(paths.filter(p=>mode==='two'||p==='src/a.txt').map(path=>({path,beforeHash:sha(path.includes('/a.')?'a-old\\n':'b-old\\n'),afterHash:sha(path.includes('/a.')?'a-new\\n':'b-new\\n'),after:Buffer.from(path.includes('/a.')?'a-new\\n':'b-new\\n').toString('base64')}))));
      req.coding.write('src/a.txt','a-new\\n');throw Error('stop unexpectedly returned');}};
    service=createWorkflowService(container,port,{idFactory:(()=>{let n=0;return()=>n++===0?'partial-run':'padding-'+n;})(),recovery:{enabled:true,durablePort:{ensureWriter(){const o=store.acquireRecoveryOwnership().owner;acquired=true;return o;},inspectOwner(){if(mode==='cancel-owner' && service?.get('partial-run')?.steps[0]?.units[0]?.coding?.workspace?.rootReady)cancel();return store.inspectRecoveryOwnership();}}},coding:{enabled:true,projectRoot,stagingParent,writablePaths:paths}});
    service.subscribe(()=>{const ws=service.get('partial-run')?.steps[0]?.units[0]?.coding?.workspace;
      if(!ws)return;
      if(mode==='cancel-root' && ws.rootReady && !ws.latestIntent || mode==='cancel-intent' && ws.latestIntent?.sequence===1 || mode==='cancel-mutation' && ws.latestIntent?.postimageHash===sha('a-new\\n'))cancel();
      if(mode==='cancel-preflight' && ws.rootReady && !ws.latestIntent)armedPreflight=true;
    });
    const d=await service.execute({action:'workflows.define',definition});if(!d.ok)throw Error(d.error);
    const r=await service.execute({action:'workflows.start',definitionId:definition.id,inputs:{},concurrency:1});if(!r.ok)throw Error(r.error);
    let approval;for(let i=0;i<500;i++){approval=service.approvals.inspect().find(a=>a.kind==='implementation');if(approval)break;await new Promise(r=>setTimeout(r,10));}
    if(!approval)throw Error('approval missing');service.approvals.grantFingerprint(approval.id,approval.requestHash);
    if(mode.startsWith('cancel-')){for(let i=0;i<500&&!cancelled;i++)await new Promise(r=>setTimeout(r,10));if(!cancelled)throw Error('cancellation callback missing');await service.drain().catch(()=>{});stop();}
    if(mode.endsWith('-fail')){await service.drain().catch(()=>{});const retry=await service.execute({action:'workflows.start',definitionId:definition.id,inputs:{}});if(retry.ok)throw Error('poisoned service admitted retry');stop();}
    setInterval(()=>{},1000);
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', driver, mode, project, staging, snapshotFile], { env: { TMPDIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let stdout = '', stderr = '';
  child.stdout.on('data', (b: Buffer) => { stdout += b.toString(); if (stdout.length > 16384) child.kill('SIGKILL'); });
  child.stderr.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-8192); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('producer deadline: ' + stderr)); }, 10000);
      const ready = () => { if (stdout.includes('\n')) { clearTimeout(timer); child.stdout.off('data', ready); resolve(); } };
      child.stdout.on('data', ready); child.once('exit', () => { clearTimeout(timer); if (!stdout.includes('\n')) reject(new Error('producer exited: ' + stderr)); }); ready();
    });
    const ready = JSON.parse(stdout.trim());
    const liveLedger = JSON.parse(readFileSync(snapshotFile, 'utf8')).state.extensions.workflows;
    const liveWorkspace = liveLedger.runs[0].steps[0].units[0].coding.workspace;
    const live = inspectPartialWorkspaceArtifacts({ rootReadyEvidence: liveWorkspace.rootReady, latestIntent: liveWorkspace.latestIntent, recordedResults: liveWorkspace.effectObservations, recordedManifest: liveWorkspace.recoveryManifest, trustedScope: { projectRoot: project, stagingParent: staging, workflowRunId: ready.runId, inputPaths: fixtureInputs, writablePaths: fixturePaths, allowedPaths: fixtureInputs } });
    assert.equal(live.status, 'blocked'); assert.match(live.blockers.join(' '), /still alive/);
    child.kill('SIGKILL'); const [, signal] = await closed; assert.equal(signal, 'SIGKILL');
    const raw = JSON.parse(readFileSync(snapshotFile, 'utf8')).state.extensions.workflows;
    assert.equal(ready.owner.pid, child.pid);
    await inspect({ root, project, staging, snapshotFile, ready, raw });
    assert.equal(readFileSync(join(project, 'unrelated'), 'utf8'), 'KEEP');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; }
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    rmSync(root, { recursive: true, force: true });
  }
}

for (const mode of ['initial', 'copy2', 'mutation', 'two'] as const) test(`actual service SIGKILL ${mode}: snapshot-produced partial artifacts prepare inertly`, { timeout: 15000 }, async () => {
  await producer(mode, async ({ root, project, staging, snapshotFile, ready, raw }) => {
    const ws = raw.runs[0].steps[0].units[0].coding.workspace;
    assert.ok(ws.rootReady); assert.deepEqual(ws.rootReady.ownerEvidence, ready.owner, 'retain complete actual snapshot owner dimensions'); if (mode !== 'two') assert.equal(ws.recoveryManifest, undefined, 'no stage result was saved');
    assert.equal(ws.latestObservation?.sequence === ws.latestIntent.sequence, false);
    assert.equal(raw.runs[0].steps[0].units[0].result, undefined);
    assert.equal(raw.runs[0].recovery.operations.find((o: any) => o.kind === 'native').result, undefined);
    assert.ok(ws.rootReady.destinationLeases.every((l: any) => l.leaseDir.startsWith(root + '/')));
    const before = inventory(root), store = createClankersPersistenceManager({ snapshotFile })!, container = createClankersStateContainer(); store.hydrate(container);
    let forbiddenCalls = 0, hook = () => {};
    const forbidden = () => { forbiddenCalls++; throw Error('prepare invoked effect'); };
    const previous = (owner: any): 'dead' | 'unknown' | 'live' => { hook(); if (workflowHash(owner) !== workflowHash(ready.owner)) return 'unknown'; try { const st = readFileSync(`/proc/${owner.pid}/stat`, 'utf8'); return st.slice(st.lastIndexOf(')') + 2).trim().split(/\s+/)[19] === owner.startTimeTicks ? 'live' : 'dead'; } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'dead' : 'unknown'; } };
    // The captured producer port performs only synchronous local writes: no
    // subprocess, child task, or detached native work. Setup/copy interruptions
    // legitimately precede onIdentity (native=null); death closes that setup too.
    const producerRun = raw.runs[0], op = producerRun.recovery.operations.find((o: any) => o.kind === 'native');
    const unit = producerRun.steps[0].units[0];
    const proof = Object.freeze({ workflowRunId: producerRun.workflowRunId, familyId: producerRun.familyId, unitId: unit.id, operationId: op.id, native: unit.native ? Object.freeze(structuredClone(unit.native)) : null, inputHash: op.inputHash, dependencyHash: op.dependencyHash, policyHash: op.policyHash });
    assert.equal(existsSync(`/proc/${ready.owner.pid}`), false, 'actual killed producer is gone');
    const inspectNativeSettlement = (request: unknown): 'settled' | 'unknown' =>
      !existsSync(`/proc/${ready.owner.pid}`) && readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() === ready.owner.bootId && workflowHash(request) === workflowHash(proof) ? 'settled' : 'unknown';
    const options = { recovery: { enabled: true, inspectNativeSettlement, durablePort: { ensureWriter: forbidden, inspectOwner: () => store.inspectRecoveryOwnership!(), inspectPreviousOwner: previous } }, coding: { enabled: true, projectRoot: project, stagingParent: staging, writablePaths: paths } };
    const service = createWorkflowService(container, { preflight: forbidden, execute: async () => forbidden() }, options);
    const display = await service.execute({ action: 'workflows.recovery.inspect', workflowRunId: ready.runId });
    const selections = structuredClone((display.assessment as any).plan.recommendedSelections);
    assert.deepEqual(selections, { reuseUnitIds: [], rerunUnitIds: ['stage:0'] });
    try {
      const defaultReply = await service.execute({ action: 'workflows.recovery.prepare', workflowRunId: ready.runId });
      assert.equal((defaultReply.assessment as any).plan.status, 'blocked');
      assert.deepEqual((defaultReply.assessment as any).blocked, ['unselected-required-execution-address']);
      const unknownService = createWorkflowService(createClankersStateContainer(container.snapshot()), { preflight: forbidden, execute: async () => forbidden() }, { ...options, recovery: { ...options.recovery, inspectNativeSettlement: undefined } });
      try {
        const unknown = await unknownService.execute({ action: 'workflows.recovery.prepare', workflowRunId: ready.runId, selections });
        assert.equal((unknown.assessment as any).plan.status, 'blocked');
        assert.match(JSON.stringify((unknown.assessment as any).blocked), /previous-native-settlement-unknown/);
      } finally { unknownService.dispose(); }
      const reply = await service.execute({ action: 'workflows.recovery.prepare', workflowRunId: ready.runId, selections }); assert.equal(reply.ok, true, reply.error);
      const a = reply.assessment as any; assert.equal(a.plan.status, 'prepared', JSON.stringify(a.blocked));
      assert.equal(a.candidateCarry[0].state, mode === 'initial' || mode === 'copy2' ? 'fresh-reconstruction-only' : 'observed-candidate-carry');
      if (ready.expectedHash) assert.equal(a.candidateCarry[0].candidateHash, ready.expectedHash);
      assert.equal(service.get(ready.runId)!.steps[0].units[0].status, 'unverified'); assert.equal(forbiddenCalls, 0); assert.deepEqual(inventory(root), before);
      for (const corrupt of [
        (u: any) => { u.coding.candidateHash = '0'.repeat(64); },
        (u: any) => { u.coding.workspace.latestIntent.postimageHash = '0'.repeat(64); },
        (u: any) => { u.coding.workspace.rootReady.ownerGeneration = 'mismatched-generation'; },
        (u: any) => { u.coding.workspace.effectObservations = []; u.coding.workspace.latestIntent.sequence += 1; },
      ]) {
        const snapshot = structuredClone(container.snapshot());
        corrupt((snapshot.extensions.workflows as any).runs[0].steps[0].units[0]);
        const corruptService = createWorkflowService(createClankersStateContainer(snapshot), { preflight: forbidden, execute: async () => forbidden() }, options);
        try { const bad = await corruptService.execute({ action: 'workflows.recovery.prepare', workflowRunId: ready.runId, selections }); assert.equal(bad.ok, true, bad.error); assert.equal((bad.assessment as any).plan.status, 'blocked'); assert.ok(!(bad.assessment as any).blocked.includes('unselected-required-execution-address')); }
        finally { corruptService.dispose(); }
      }
      if (mode !== 'initial') for (const [label, corrupt] of [
        ['zero result hash', (r: any) => { r.recovery.operations.find((o: any) => o.kind === 'stage-write' && o.result).result.resultHash = '0'.repeat(64); }],
        ['missing result hash', (r: any) => { delete r.recovery.operations.find((o: any) => o.kind === 'stage-write' && o.result).result.resultHash; }],
        ['zero evidence hash', (r: any) => { r.recovery.operations.find((o: any) => o.kind === 'stage-write' && o.result).result.evidenceHash = '0'.repeat(64); }],
        ['renumbered reordered effect prefix', (r: any) => { const ops = r.recovery.operations, first = ops.findIndex((o: any) => o.kind === 'stage-write'), last = ops.findLastIndex((o: any) => o.kind === 'stage-write'); [ops[first], ops[last]] = [ops[last], ops[first]]; ops.forEach((o: any, i: number) => { o.sequence = i; if (o.kind === 'stage-write') o.id = `${r.workflowRunId}:${o.unitId}:stage-write:${i}`; }); }],
        ['extra pending last intent', (r: any) => { const op = structuredClone(r.recovery.operations.findLast((o: any) => o.kind === 'stage-write')); op.id += ':extra'; op.sequence = r.recovery.operations.length; r.recovery.operations.push(op); r.recovery.sequence++; }],
        ['extra intent in another generation', (r: any) => { const op = structuredClone(r.recovery.operations.findLast((o: any) => o.kind === 'stage-write')); op.id += ':extra'; op.generation = 'different'; op.sequence = r.recovery.operations.length; r.recovery.operations.push(op); r.recovery.sequence++; }],
        ['missing checkpoint prefix effect', (r: any) => { r.recovery.operations.splice(r.recovery.operations.findIndex((o: any) => o.kind === 'stage-write'), 1); r.recovery.sequence--; r.recovery.operations.forEach((o: any, i: number) => { o.sequence = i; if (o.kind === 'stage-write') o.id = `${r.workflowRunId}:${o.unitId}:stage-write:${i}`; }); }],
        ['changed pending generation', (r: any) => { r.recovery.operations.findLast((o: any) => o.kind === 'stage-write').generation = 'different'; }],
        ...(['unitId', 'stepId', 'inputHash', 'dependencyHash', 'policyHash'] as const).map(key => [`changed pending ${key}`, (r: any) => { r.recovery.operations.findLast((o: any) => o.kind === 'stage-write')[key] = key.endsWith('Hash') ? '0'.repeat(64) : 'different'; }] as const),
      ] as const) {
        const snapshot = structuredClone(container.snapshot());
        corrupt((snapshot.extensions.workflows as any).runs[0]);
        let corruptService: ReturnType<typeof createWorkflowService>;
        try { corruptService = createWorkflowService(createClankersStateContainer(snapshot), { preflight: forbidden, execute: async () => forbidden() }, options); }
        catch (error) { assert.match(String(error), /Recovery checkpoint|Invalid.*recovery/, label); continue; }
        try { const bad = await corruptService.execute({ action: 'workflows.recovery.prepare', workflowRunId: ready.runId, selections }); assert.equal(bad.ok, true, `${label}: ${bad.error}`); assert.equal((bad.assessment as any).plan.status, 'blocked', label); assert.ok(!(bad.assessment as any).blocked.includes('unselected-required-execution-address'), label); }
        finally { corruptService.dispose(); }
      }
      const original = readFileSync(join(project, 'src/ro.txt')); writeFileSync(join(project, 'src/ro.txt'), 'drift');
      assert.equal(((await service.execute({ action: 'workflows.recovery.prepare', workflowRunId: ready.runId, selections })).assessment as any).plan.status, 'blocked'); writeFileSync(join(project, 'src/ro.txt'), original);
      let callbacks = 0;
      hook = () => { if (++callbacks === 2) writeFileSync(join(project, 'src/ro.txt'), 'callback drift'); };
      const artifactDrift = await service.execute({ action: 'workflows.recovery.prepare', workflowRunId: ready.runId, selections });
      assert.equal((artifactDrift.assessment as any).plan.status, 'blocked'); assert.match(JSON.stringify(artifactDrift.assessment), /retained-artifacts-changed/);
      writeFileSync(join(project, 'src/ro.txt'), original);
      hook = () => container.update({ mode: { ...container.read().mode, readOnly: true } });
      const changed = await service.execute({ action: 'workflows.recovery.prepare', workflowRunId: ready.runId, selections }); assert.equal((changed.assessment as any).plan.status, 'blocked'); assert.match(JSON.stringify(changed.assessment), /current-source-changed/);
      assert.equal(forbiddenCalls, 0);
    } finally { service.dispose(); }
  });
});

for (const mode of ['root-fail', 'intent-fail', 'receipt-fail'] as const) test(`service ${mode} poisons admission and retains authoritative evidence`, { timeout: 15000 }, async () => {
  await producer(mode, async ({ project, ready, raw }) => {
    const ws = raw.runs[0].steps[0].units[0].coding.workspace;
    assert.equal(ready.faultCount, 1); assert.equal(ready.nativeCalls, mode === 'receipt-fail' ? 1 : 0);
    assert.ok(existsSync(ws.rootReady.markerPath)); assert.ok(ws.rootReady.destinationLeases.every((l: any) => existsSync(l.ownerFile)));
    assert.equal(readFileSync(join(project, 'src/a.txt'), 'utf8'), 'a-old\n');
    if (mode === 'root-fail') assert.equal(ws.latestIntent, undefined);
    else assert.ok(ws.latestIntent);
    assert.equal(raw.runs[0].recovery.operations.find((o: any) => o.kind === 'native').result, undefined);
  });
});

for (const mode of ['cancel-root', 'cancel-intent', 'cancel-mutation', 'cancel-preflight', 'cancel-owner'] as const) test(`actual service ${mode} callback prevents the physical write and retains evidence`, { timeout: 15000 }, async () => {
  await producer(mode, async ({ project, ready, raw }) => {
    const ws = raw.runs[0].steps[0].units[0].coding.workspace;
    assert.equal(ready.cancelled, true);
    assert.ok(existsSync(ws.rootReady.markerPath));
    assert.ok(ws.rootReady.destinationLeases.every((l: any) => existsSync(l.ownerFile)));
    assert.equal(readFileSync(join(project, 'src/a.txt'), 'utf8'), 'a-old\n');
    const mutation = mode === 'cancel-mutation';
    assert.equal(ready.nativeCalls, mutation ? 1 : 0);
    assert.equal(existsSync(join(ws.rootReady.stageRoot, 'src/a.txt')), mutation);
    assert.equal(existsSync(join(ws.rootReady.stageRoot, 'src/ro.txt')), mutation);
    if (mutation) assert.equal(readFileSync(join(ws.rootReady.stageRoot, 'src/a.txt'), 'utf8'), 'a-old\n');
    if (mode === 'cancel-intent' || mutation) {
      assert.ok(ws.latestIntent);
      assert.equal(ws.latestObservation?.status, 'rejected');
      assert.equal(ws.latestObservation?.observedPostimageHash, mutation ? sha('a-old\n') : null);
    } else assert.equal(ws.latestIntent, undefined);
  });
});

test('actual service near ledger complexity limit blocks first mutation before bytes change (8 writable + readonly)', { timeout: 15000 }, async (t) => {
  await producer('reserve-mutation', async ({ ready, raw }) => {
    const diagnostic = ready.reserveDiagnostic;
    t.diagnostic(JSON.stringify({ beforeEffectNodes: diagnostic.beforeEffectNodes, actualManifestNodes: diagnostic.actualManifestNodes, ledgerWithActualManifestNodes: diagnostic.ledgerWithActualManifestNodes }));
    assert.ok(diagnostic.beforeEffectNodes >= 19000, JSON.stringify(diagnostic));
    assert.ok(diagnostic.beforeEffectNodes < 19500, 'old 512-node reserve would fit');
    assert.equal(diagnostic.effectReturned, undefined);
    assert.match(diagnostic.error, /complexity exceeded/);
    assert.ok(diagnostic.actualManifestNodes > 512, JSON.stringify(diagnostic));
    assert.ok(diagnostic.ledgerWithActualManifestNodes > 20000, JSON.stringify(diagnostic));
    assert.match(diagnostic.postEffectCapacityError, /complexity exceeded/);
    assert.equal(diagnostic.stagedHash, sha('a-old\n'));
    assert.equal(diagnostic.afterHash, diagnostic.stagedHash);
    const ws = raw.runs[0].steps[0].units[0].coding.workspace;
    assert.ok(ws.rootReady);
    assert.equal(ws.latestIntent.postimageHash === sha('a-new\n'), false, 'no new mutation intent admitted');
    assert.equal(ws.latestObservation.status, 'observed', 'prior copy receipt retained');
    assert.equal(raw.runs[0].recovery.operations.filter((o: any) => o.kind === 'stage-write').length, 9);
  });
});
