import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClankersStateContainer } from '../state.js';
import { createClankersPersistenceManager } from '../persistence.js';
import { createWorkflowService } from '../workflow-runtime.js';
import { WORKFLOW_EXTENSION_KEY, workflowHash } from '../workflow-model.js';
import type { RecoveryWriterOwnerEvidence } from '../persistence.js';

// Actual process interruption with a fake native transport, not real-model/SDK acceptance.
test('fresh process-owned checkpoint prepares retained stage after actual owner SIGKILL without execution', { timeout: 20000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'clankers-interrupted-artifact-'));
  // Keep destination leases inside this fixture, not the shared system temp root.
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = root;
  t.after(() => { if (previousTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmpdir; });
  const projectRoot = join(root, 'project'), stagingParent = join(root, 'stage'), snapshotFile = join(root, 'state.json');
  mkdirSync(projectRoot, { mode: 0o700 }); mkdirSync(stagingParent, { mode: 0o700 }); mkdirSync(join(projectRoot, 'src'));
  writeFileSync(join(projectRoot, 'src/a.txt'), 'old\n'); writeFileSync(join(projectRoot, 'unrelated.txt'), 'USER_BYTES');
  const runtimeUrl = new URL('../workflow-runtime.ts', import.meta.url).href;
  const stateUrl = new URL('../state.ts', import.meta.url).href;
  const persistUrl = new URL('../persistence.ts', import.meta.url).href;
  const modelUrl = new URL('../workflow-model.ts', import.meta.url).href;
  const driver = `
    import { createHash } from 'node:crypto';
    import { createWorkflowService } from ${JSON.stringify(runtimeUrl)};
    import { createClankersStateContainer, createClankersState, updateClankersState } from ${JSON.stringify(stateUrl)};
    import { createClankersPersistenceManager } from ${JSON.stringify(persistUrl)};
    import { workflowHash } from ${JSON.stringify(modelUrl)};
    const projectRoot=process.argv[1], stagingParent=process.argv[2], snapshotFile=process.argv[3];
    const str={type:'string',maxLength:256}, array=items=>({type:'array',maxItems:32,items}), object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
    const baseProfile={id:'node',executable:process.execPath,argv:['-e','process.exit(0)'],cwd:'src',env:{},timeoutMs:2000,allowGeneratedOutputs:false};
    const policy={version:3,capabilities:['stage-write','check','review','apply'],identity:{parentRunId:'fixture',taskId:'fixture-task',attemptNo:1,workerAgentId:'worker',rootAgentId:'reviewer',model:'fake/model'},scope:{task:'Change old to new in the disposable fixture',writablePaths:['src/a.txt'],baseline:{projectRootId:projectRoot,stateHash:createHash('sha256').update('old\\n').digest('hex')},manifest:[{path:'src/a.txt',text:'old\\n',bytes:4,sha256:createHash('sha256').update('old\\n').digest('hex')}]},reviewRequired:true,checkProfiles:[{...baseProfile,profileHash:workflowHash(baseProfile)}]};
    const definition={id:'interrupted-artifact',version:3,label:'Interrupted artifact',inputSchema:object({}),steps:[
      {id:'stage',kind:'coding',dependsOn:[],inputs:{},outputSchema:object({candidateHash:str,changedPaths:array(str)}),coding:{operation:'stage-write',policy}},
      {id:'check',kind:'coding',dependsOn:['stage'],inputs:{},outputSchema:object({passed:{type:'boolean'},profileId:str,candidateHash:str}),coding:{operation:'check',policy,checkProfileId:'node'}},
      {id:'review',kind:'coding',dependsOn:['check'],inputs:{},outputSchema:object({passed:{type:'boolean'},candidateHash:str,reviewer:str,findings:array(object({}))}),coding:{operation:'review',policy}},
      {id:'apply',kind:'coding',dependsOn:['review'],inputs:{},outputSchema:object({status:str,candidateHash:str,appliedPaths:array(str),rejectedPaths:array(str),diagnostics:array(str),outcomeHash:str}),coding:{operation:'apply',policy}}
    ]};
    const agents=Object.fromEntries(['worker','reviewer'].map(id=>[id,{id,label:id,source:'runtime',prompt:id,model:'fake/model',permissionMode:'inherit'}]));
    const base=createClankersStateContainer({agentDefinitions:agents});
    const store=createClankersPersistenceManager({snapshotFile}); store.hydrate(base);
    const container={...base, replace(next){const value=createClankersState(next);store.save(value);return base.replace(value);}, update(patch,options){const next=updateClankersState(base.read(),patch,options);store.save(next);return base.replace(next);}};
    let runId='', approval;
    const keepAlive=setInterval(()=>{},1000);
    const native={preflight(){},async execute(req){
      req.onIdentity({runId:'native-original',taskId:'task-original'});
      req.coding.write('src/a.txt','new\\n');
      process.stdout.write(JSON.stringify({runId,approvalId:approval.id,requestHash:approval.requestHash,owner:store.inspectRecoveryOwnership().owner})+'\\n');
      await new Promise(()=>{});
    }};
    const service=createWorkflowService(container,native,{recovery:{enabled:true,durablePort:{ensureWriter(){return store.acquireRecoveryOwnership().owner;},inspectOwner(){return store.inspectRecoveryOwnership();}}},coding:{enabled:true,projectRoot,stagingParent,writablePaths:['src/a.txt'],checkProfiles:{node:{id:baseProfile.id,executable:baseProfile.executable,argv:baseProfile.argv,cwd:baseProfile.cwd,env:baseProfile.env,timeoutMs:baseProfile.timeoutMs,outputBytes:65536,generatedOutputs:[]}}}});
    const d=await service.execute({action:'workflows.define',definition}); if(!d.ok) throw Error(d.error);
    const r=await service.execute({action:'workflows.start',definitionId:definition.id,inputs:{},concurrency:1}); if(!r.ok)throw Error(r.error);runId=r.view.workflowRunId;
    const end=Date.now()+6000;
    while(Date.now()<end){approval=service.approvals.inspect().find(x=>x.kind==='implementation'&&x.status==='pending');if(approval)break;await new Promise(r=>setTimeout(r,10));}
    if(!approval)throw Error('fixture implementation approval missing');service.approvals.grantFingerprint(approval.id,approval.requestHash);
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', driver, projectRoot, stagingParent, snapshotFile], { env: { TMPDIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let stdout = '', stderr = '', success = false;
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 16384) child.kill('SIGKILL'); });
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    if (success) { rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false); }
    else console.error('Retained interrupted artifact evidence', root, stderr);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('interrupted artifact producer deadline: ' + stderr)); }, 9000);
    const ready = () => { if (stdout.includes('\n')) { clearTimeout(timer); child.stdout.off('data', ready); resolve(); } };
    child.stdout.on('data', ready);
    child.once('exit', () => { clearTimeout(timer); if (!stdout.includes('\n')) reject(new Error('producer exited before checkpoint: ' + stderr)); });
    ready();
  });
  const ready = JSON.parse(stdout.trim()) as { runId: string; approvalId: string; requestHash: string; owner: RecoveryWriterOwnerEvidence };
  assert.equal(ready.owner.pid, child.pid);
  child.kill('SIGKILL'); const [, signal] = await closed; assert.equal(signal, 'SIGKILL');
  assert.equal(existsSync(`/proc/${child.pid}`), false);
  const before = readFileSync(snapshotFile);
  const store = createClankersPersistenceManager({ snapshotFile })!;
  const container = createClankersStateContainer(); store.hydrate(container);
  let forbiddenCalls = 0;
  const forbidden = () => { forbiddenCalls++; throw new Error('recovery preparation attempted execution'); };
  let ownerHook = () => {};
  const previous = (owner: RecoveryWriterOwnerEvidence): 'live' | 'dead' | 'unknown' => {
    ownerHook();
    if (owner.pid !== ready.owner.pid || owner.bootId !== ready.owner.bootId || owner.startTimeTicks !== ready.owner.startTimeTicks || owner.generation !== ready.owner.generation) return 'unknown';
    try { const raw = readFileSync(`/proc/${owner.pid}/stat`, 'utf8'); const ticks = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)[19]; return ticks === owner.startTimeTicks ? 'live' : 'dead'; }
    catch (error) { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'dead' : 'unknown'; }
  };
  // This producer's native transport has no child tasks or detached work.
  const producerRun = JSON.parse(before.toString()).state.extensions.workflows.runs.find((r: any) => r.workflowRunId === ready.runId);
  const op = producerRun.recovery.operations.find((op: any) => op.kind === 'native');
  const unit = producerRun.steps.flatMap((step: any) => step.units).find((unit: any) => unit.id === op.unitId);
  const proof = Object.freeze({ workflowRunId: producerRun.workflowRunId, familyId: producerRun.familyId, unitId: unit.id, operationId: op.id, native: unit.native ? Object.freeze(structuredClone(unit.native)) : null, inputHash: op.inputHash, dependencyHash: op.dependencyHash, policyHash: op.policyHash });
  const options = {
    recovery: { enabled: true, inspectNativeSettlement: (request: unknown): 'settled' | 'unknown' => !existsSync(`/proc/${ready.owner.pid}`) && readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() === ready.owner.bootId && workflowHash(request) === workflowHash(proof) ? 'settled' : 'unknown', durablePort: { ensureWriter: forbidden, inspectOwner: () => store.inspectRecoveryOwnership!(), inspectPreviousOwner: previous } },
    coding: { enabled: true, projectRoot, stagingParent, writablePaths: ['src/a.txt'], checkProfiles: { node: { id: 'node', executable: process.execPath, argv: ['-e', 'process.exit(0)'], cwd: 'src', env: {}, timeoutMs: 2000, outputBytes: 65536, generatedOutputs: [] } } },
  };
  const native = { preflight: forbidden, execute: async () => forbidden() };
  const service = createWorkflowService(container, native, options);
  const display = await service.execute({ action: 'workflows.recovery.inspect', workflowRunId: ready.runId });
  const selections = structuredClone((display.assessment as any).plan.recommendedSelections);
  assert.deepEqual(selections, { reuseUnitIds: [], rerunUnitIds: ['stage:0', 'check:0', 'review:0', 'apply:0'] });
  try {
    assert.equal(service.approvals.inspect().length, 0);
    assert.throws(() => service.approvals.grantFingerprint(ready.approvalId, ready.requestHash));
    const reply = await service.execute({ action: 'workflows.recovery.prepare', workflowRunId: ready.runId, selections });
    assert.equal(reply.ok, true, reply.error);
    const assessment = reply.assessment as any;
    assert.equal(assessment.plan.status, 'prepared', JSON.stringify(assessment.blocked));
    assert.match(JSON.stringify(assessment.candidateCarry), /reusable-candidate-carry-only/);
    assert.equal(service.get(ready.runId)?.steps[0].units[0].status, 'unverified');
    assert.equal(forbiddenCalls, 0);
    assert.deepEqual(readFileSync(snapshotFile), before);
    assert.equal(readFileSync(join(projectRoot, 'src/a.txt'), 'utf8'), 'old\n');
    assert.equal(readFileSync(join(projectRoot, 'unrelated.txt'), 'utf8'), 'USER_BYTES');
    assert.match(assessment.candidateCarry[0].candidateHash, /^[a-f0-9]{64}$/);
    // Equal destination bytes are observations, not evidence identifying their writer.
    writeFileSync(join(projectRoot, 'src/a.txt'), 'new\n');
    const postimage = await service.execute({ action: 'workflows.recovery.prepare', workflowRunId: ready.runId, selections });
    assert.equal((postimage.assessment as any).plan.status, 'blocked');
    assert.match(JSON.stringify((postimage.assessment as any).blocked), /fully-satisfied-zero-write/);
    assert.equal((postimage.assessment as any).current.destination[0].status, 'postimage');
    assert.equal((postimage.assessment as any).current.destination[0].recordedApplication, 'none');
    assert.equal((postimage.assessment as any).current.destination[0].writerAttribution, 'not-established');
    assert.equal(service.get(ready.runId)?.steps[0].units[0].status, 'unverified');
    writeFileSync(join(projectRoot, 'src/a.txt'), 'old\n');
    const corrupt = structuredClone(container.snapshot());
    (corrupt.extensions[WORKFLOW_EXTENSION_KEY] as any).runs[0].steps[0].units[0].coding.candidateHash = '0'.repeat(64);
    const corruptService = createWorkflowService(createClankersStateContainer(corrupt), native, options);
    try {
      const mismatch = await corruptService.execute({ action: 'workflows.recovery.prepare', workflowRunId: ready.runId, selections });
      assert.equal((mismatch.assessment as any).plan.status, 'blocked');
      assert.match(JSON.stringify(mismatch.assessment), /latest-recorded-candidate-hash-mismatch/);
    } finally { corruptService.dispose(); }
    const invalidReuse = await service.execute({ action: 'workflows.recovery.prepare', workflowRunId: ready.runId, selections: { reuseUnitIds: [service.get(ready.runId)!.steps[0].units[0].id] } });
    assert.equal((invalidReuse.assessment as any).plan.status, 'blocked');
    assert.match(JSON.stringify(invalidReuse.assessment), /selected-reuse-evidence-is-ineligible/);
    const manifest = (service.get(ready.runId)!.steps[0].units[0].coding!.workspace as any).recoveryManifest;
    assert.ok(manifest.stageRoot.startsWith(stagingParent + '/'));
    assert.ok(manifest.destinationLeases.length > 0);
    assert.ok(manifest.destinationLeases.every((lease: any) => lease.leaseDir.startsWith(root + '/') && lease.ownerFile.startsWith(lease.leaseDir + '/')));
    let callbacks = 0;
    ownerHook = () => { if (++callbacks === 2) writeFileSync(join(manifest.stageRoot, 'src/a.txt'), 'drift\n'); };
    const artifactDrift = await service.execute({ action: 'workflows.recovery.prepare', workflowRunId: ready.runId, selections });
    assert.equal((artifactDrift.assessment as any).plan.status, 'blocked');
    assert.match(JSON.stringify(artifactDrift.assessment), /retained-artifacts-changed-during-assessment/);
    writeFileSync(join(manifest.stageRoot, 'src/a.txt'), 'new\n');
    callbacks = 0;
    ownerHook = () => { if (++callbacks === 2) container.update({ mode: { ...container.read().mode, readOnly: true } }); };
    const modeDrift = await service.execute({ action: 'workflows.recovery.prepare', workflowRunId: ready.runId, selections });
    assert.equal((modeDrift.assessment as any).plan.status, 'blocked');
    assert.match(JSON.stringify(modeDrift.assessment), /current-source-changed-during-artifact-assessment/);
    assert.equal(forbiddenCalls, 0);
    assert.deepEqual(readFileSync(snapshotFile), before);
    success = true;
  } finally { service.dispose(); }
});
