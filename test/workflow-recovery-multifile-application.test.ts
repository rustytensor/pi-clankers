import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClankersStateContainer } from '../state.js';
import { createClankersPersistenceManager } from '../persistence.js';
import { createWorkflowService } from '../workflow-runtime.js';
import { WORKFLOW_EXTENSION_KEY, workflowHash } from '../workflow-model.js';
import type { RecoveryWriterOwnerEvidence } from '../persistence.js';

// Actual process interruption with a fake native transport, not real-model/SDK acceptance.
for (const boundary of ['first-write', 'first-receipt', 'second-intent', 'second-write', 'third-write'] as const) test(`multi-file application ${boundary}: actual owner SIGKILL binds only canonical prior receipts`, { timeout: 20000 }, async t => {
  const paths = ['src/a.txt', 'src/b.txt', 'src/c.txt'];
  const satisfied = boundary === 'third-write' ? paths : boundary === 'second-write' ? paths.slice(0, 2) : paths.slice(0, 1);
  const root = mkdtempSync(join(tmpdir(), 'clankers-multifile-artifact-'));
  const artifacts = (): Record<string, string> => {
    const files: Record<string, string> = {};
    const walk = (dir: string) => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) walk(path); else { assert.ok(entry.isFile(), path); files[path] = readFileSync(path).toString('base64'); } } };
    walk(root); return files;
  };
  // Keep destination leases inside this fixture, not the shared system temp root.
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = root;
  t.after(() => { if (previousTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmpdir; });
  const projectRoot = join(root, 'project'), stagingParent = join(root, 'stage'), snapshotFile = join(root, 'state.json');
  mkdirSync(projectRoot, { mode: 0o700 }); mkdirSync(stagingParent, { mode: 0o700 }); mkdirSync(join(projectRoot, 'src'));
  for (const path of paths) writeFileSync(join(projectRoot, path), 'old\n'); writeFileSync(join(projectRoot, 'unrelated.txt'), 'USER_BYTES');
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
    const boundary=${JSON.stringify(boundary)};
    function pause(){ fs.writeSync(1,JSON.stringify({runId,approvalId:approval.id,requestHash:approval.requestHash,owner:store.inspectRecoveryOwnership().owner})+'\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0); }
    const originalRename=fs.renameSync;
    fs.renameSync=(from,to)=>{if(boundary==='second-intent' && to===join(projectRoot,'src/b.txt'))pause(); originalRename(from,to); if((boundary==='first-write' && to===join(projectRoot,'src/a.txt')) || (boundary==='second-write' && to===join(projectRoot,'src/b.txt')) || (boundary==='third-write' && to===join(projectRoot,'src/c.txt')))pause();}; syncBuiltinESMExports();
    const str={type:'string',maxLength:256}, array=items=>({type:'array',maxItems:32,items}), object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
    const baseProfile={id:'node',executable:process.execPath,argv:['-e','process.exit(0)'],cwd:'src',env:{},timeoutMs:2000,allowGeneratedOutputs:false};
    const policy={version:3,capabilities:['stage-write','check','review','apply'],identity:{parentRunId:'fixture',taskId:'fixture-task',attemptNo:1,workerAgentId:'worker',rootAgentId:'reviewer',model:'fake/model'},scope:{task:'Change old to new in the disposable fixture',writablePaths:['src/a.txt','src/b.txt','src/c.txt'],baseline:{projectRootId:projectRoot,stateHash:createHash('sha256').update('old\\n').digest('hex')},manifest:['src/a.txt','src/b.txt','src/c.txt'].map(path=>({path,text:'old\\n',bytes:4,sha256:createHash('sha256').update('old\\n').digest('hex')}))},reviewRequired:true,checkProfiles:[{...baseProfile,profileHash:workflowHash(baseProfile)}]};
    const definition={id:'interrupted-artifact',version:3,label:'Interrupted artifact',inputSchema:object({}),steps:[
      {id:'stage',kind:'coding',dependsOn:[],inputs:{},outputSchema:object({candidateHash:str,changedPaths:array(str)}),coding:{operation:'stage-write',policy}},
      {id:'check',kind:'coding',dependsOn:['stage'],inputs:{},outputSchema:object({passed:{type:'boolean'},profileId:str,candidateHash:str}),coding:{operation:'check',policy,checkProfileId:'node'}},
      {id:'review',kind:'coding',dependsOn:['check'],inputs:{},outputSchema:object({passed:{type:'boolean'},candidateHash:str,reviewer:str,findings:array(object({}))}),coding:{operation:'review',policy}},
      {id:'apply',kind:'coding',dependsOn:['review'],inputs:{},outputSchema:object({status:str,candidateHash:str,appliedPaths:array(str),rejectedPaths:array(str),diagnostics:array(str),outcomeHash:str}),coding:{operation:'apply',policy}}
    ]};
    const agents=Object.fromEntries(['worker','reviewer'].map(id=>[id,{id,label:id,source:'runtime',prompt:id,model:'fake/model',permissionMode:'inherit'}]));
    const base=createClankersStateContainer({agentDefinitions:agents});
    const store=createClankersPersistenceManager({snapshotFile}); store.hydrate(base);
    const afterSave=state=>{if(boundary==='first-receipt' && state.extensions.workflows?.runs?.some(r=>r.recovery?.operations.at(-1)?.kind==='application' && r.recovery.operations.at(-1).result?.status==='completed'))pause();};
    const container={...base, replace(next){const value=createClankersState(next);store.save(value);afterSave(value);return base.replace(value);}, update(patch,options){const next=updateClankersState(base.read(),patch,options);store.save(next);afterSave(next);return base.replace(next);}};
    let runId='', approval;
    const keepAlive=setInterval(()=>{},1000);
    const native={preflight(){},async execute(req){
      const identity={runId:'native-'+req.coding.operation,taskId:'task-'+req.coding.operation};req.onIdentity(identity);
      if(req.coding.operation==='stage-write') for(const path of ['src/a.txt','src/b.txt','src/c.txt']) req.coding.write(path,'new\\n');
      return {status:'completed',text:req.coding.operation==='review'?JSON.stringify({verdict:'pass',findings:[]}):'{}',cleanupSettled:true,identity};
    }};
    const service=createWorkflowService(container,native,{recovery:{enabled:true,durablePort:{ensureWriter(){return store.acquireRecoveryOwnership().owner;},inspectOwner(){return store.inspectRecoveryOwnership();}}},coding:{enabled:true,projectRoot,stagingParent,allocateCheckReceipt:({candidateId,profileId})=>{const receiptDir=fs.mkdtempSync(join(stagingParent,'receipt-')); const generation=randomUUID(),nonce=randomUUID(),markerPath=join(receiptDir,'marker.json');fs.writeFileSync(markerPath,JSON.stringify({generation,nonce,candidateId,profileId}),{mode:0o600});return {receiptDir,markerPath,generation,nonce,candidateId,profileId};},writablePaths:['src/a.txt','src/b.txt','src/c.txt'],checkProfiles:{node:{id:baseProfile.id,executable:baseProfile.executable,argv:baseProfile.argv,cwd:baseProfile.cwd,env:baseProfile.env,timeoutMs:baseProfile.timeoutMs,outputBytes:65536,generatedOutputs:[]}}}});
    const d=await service.execute({action:'workflows.define',definition}); if(!d.ok) throw Error(d.error);
    const r=await service.execute({action:'workflows.start',definitionId:definition.id,inputs:{},concurrency:1}); if(!r.ok)throw Error(r.error);runId=r.view.workflowRunId;
    const end=Date.now()+6000;
    while(Date.now()<end){approval=service.approvals.inspect().find(x=>x.kind==='implementation'&&x.status==='pending');if(approval)break;await new Promise(r=>setTimeout(r,10));}
    if(!approval)throw Error('fixture implementation approval missing');service.approvals.grantFingerprint(approval.id,approval.requestHash);
    approval=undefined;const appEnd=Date.now()+6000;while(Date.now()<appEnd){approval=service.approvals.inspect().find(x=>x.kind==='application'&&x.status==='pending');if(approval)break;await new Promise(r=>setTimeout(r,10));}if(!approval)throw Error('application approval missing '+JSON.stringify(service.get(runId)));service.approvals.grantFingerprint(approval.id,approval.requestHash);
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
  const before = readFileSync(snapshotFile);
  const originalArtifacts = artifacts();
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
  const options = {
    recovery: { enabled: true, durablePort: { ensureWriter: forbidden, inspectOwner: () => store.inspectRecoveryOwnership!(), inspectPreviousOwner: previous } },
    coding: { enabled: true, projectRoot, stagingParent, writablePaths: paths, checkProfiles: { node: { id: 'node', executable: process.execPath, argv: ['-e', 'process.exit(0)'], cwd: 'src', env: {}, timeoutMs: 2000, outputBytes: 65536, generatedOutputs: [] } } },
  };
  const native = { preflight: forbidden, execute: async () => forbidden() };
  const service = createWorkflowService(container, native, options);
  const display = await service.execute({ action: 'workflows.recovery.inspect', workflowRunId: ready.runId });
  const selections = structuredClone((display.assessment as any).plan.recommendedSelections);
  assert.deepEqual(selections, { reuseUnitIds: [], rerunUnitIds: ['stage:0', 'check:0', 'review:0', 'apply:0'] });
  const zeroWriteBlocker = 'fully-satisfied-zero-write-requires-current-observation-host-completion-not-implemented';
  const assertEvidenceBlocked = (assessment: any, label: string) => {
    assert.equal(assessment.plan.status, 'blocked', label);
    assert.ok(!assessment.blocked.includes('unselected-required-execution-address'), label);
    assert.ok(assessment.blocked.some((reason: string) => reason !== zeroWriteBlocker), 'must hit evidence blocker: ' + label);
  };
  try {
    assert.equal(service.approvals.inspect().length, 0);
    assert.throws(() => service.approvals.grantFingerprint(ready.approvalId, ready.requestHash));
    const live = await service.execute({ action: 'workflows.recovery.prepare', workflowRunId: ready.runId, selections });
    assert.equal((live.assessment as any).plan.status, 'blocked');
    assert.match(JSON.stringify(live.assessment), /snapshot-writer-live/);
    child.kill('SIGKILL'); await closed;
    assert.equal(child.signalCode, 'SIGKILL');
    assert.equal(existsSync(`/proc/${child.pid}`), false);
    const reply = await service.execute({ action: 'workflows.recovery.prepare', workflowRunId: ready.runId, selections });
    assert.equal(reply.ok, true, reply.error);
    const assessment = reply.assessment as any;
    assert.equal(assessment.plan.status, boundary === 'third-write' ? 'blocked' : 'prepared', JSON.stringify(assessment.blocked));
    assert.deepEqual(assessment.blocked, boundary === 'third-write' ? [zeroWriteBlocker] : []);
    assert.equal(assessment.schema.prepareIsPermission, false);
    assert.ok(assessment.plan.freshAuthorizationsRequired.includes('application'));
    const checkEvidence = (service.get(ready.runId)!.steps[1].units[0].coding!.evidence as any).durableCheck;
    assert.equal(checkEvidence.receipt.commandStarted, true);
    assert.equal(checkEvidence.receipt.commandCompleted, true);
    assert.equal(checkEvidence.receipt.commandOutcome.exitCode, 0);
    assert.equal(checkEvidence.receipt.cleanup.outcome, 'ok');
    assert.ok(checkEvidence.config.receiptDir.startsWith(stagingParent + '/'));
    assert.ok(existsSync(checkEvidence.receipt.receiptPath));
    const supervisor = checkEvidence.receipt.supervisorIdentity;
    const cleanupDeadline = Date.now() + 2000;
    while (existsSync(`/proc/${supervisor.pid}`) && Date.now() < cleanupDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(existsSync(`/proc/${supervisor.pid}`), false, 'owned check supervisor must be reaped');
    assert.match(JSON.stringify(assessment.candidateCarry), /reusable-candidate-carry-only/);
    assert.ok(assessment.units.every((unit: any) => !unit.reuseEligible), 'no old external result is reusable');
    assert.equal(service.get(ready.runId)?.steps[3].units[0].status, 'unverified');
    assert.equal(forbiddenCalls, 0);
    assert.deepEqual(readFileSync(snapshotFile), before);
    for (const path of paths) assert.equal(readFileSync(join(projectRoot, path), 'utf8'), satisfied.includes(path) ? 'new\n' : 'old\n');
    assert.equal(readFileSync(join(projectRoot, 'unrelated.txt'), 'utf8'), 'USER_BYTES');
    assert.match(assessment.candidateCarry[0].candidateHash, /^[a-f0-9]{64}$/);
    const applyUnit = service.get(ready.runId)!.steps[3].units[0];
    assert.equal(applyUnit.status, 'unverified');
    assert.equal(service.get(ready.runId)!.recovery!.operations.at(-1)!.result?.status, boundary === 'first-receipt' ? 'completed' : undefined);
    for (const observation of assessment.current.destination) assert.equal(observation.status, satisfied.includes(observation.path) ? 'postimage' : 'preimage');
    assert.equal(assessment.candidateCarry[0].applicationObservation.originalResultStatus, boundary === 'first-receipt' ? 'completed' : 'missing');
    assert.deepEqual(assessment.candidateCarry[0].applicationObservation.alreadySatisfiedPaths, satisfied);
    assert.deepEqual(assessment.candidateCarry[0].applicationObservation.remainingPreimagePaths, paths.filter(path => !satisfied.includes(path)));
    assert.equal(assessment.units[3].classifications.filter((c: any) => c.kind === 'application').at(-1).classification, boundary === 'first-receipt' ? 'completed-invalid' : 'interrupted-uncertain');
    assert.equal(service.get(ready.runId)!.recovery!.operations.find(op => op.kind === 'application-gate')!.result, undefined, 'overall application gate never settled');
    const originalRun = service.get(ready.runId)!;
    const applicationOps = originalRun.recovery!.operations.filter(op => op.kind === 'application');
    assert.equal(applicationOps.length, boundary === 'first-write' || boundary === 'first-receipt' ? 1 : boundary === 'third-write' ? 3 : 2);
    assert.deepEqual(applicationOps.map(op => op.paths[0]), paths.slice(0, applicationOps.length));
    for (const op of applicationOps.slice(0, -1)) assert.equal(op.result?.status, 'completed');
    const retained = (applyUnit.coding!.workspace as any);
    if (boundary !== 'first-write') {
      const unverified = boundary !== 'first-receipt';
      const known = applicationOps.at(unverified ? -2 : -1)!;
      assert.equal(retained.latestIntent.sequence, retained.recoveryManifest.effects.at(-1).sequence + (unverified ? 2 : 1), 'real afterEffect manifest lags receipt by exactly one record');
      assert.equal(retained.latestObservation.sequence, retained.latestIntent.sequence - (unverified ? 1 : 0));
      assert.equal(retained.latestObservation.path, known.paths[0]);
      assert.equal(known.result!.evidenceHash, workflowHash({ workspaceEffect: retained.latestObservation }));
    }
    assert.equal(assessment.current.destination[0].recordedApplication, boundary === 'third-write' ? 'recorded' : 'none');
    assert.equal(assessment.current.destination[0].writerAttribution, 'not-established');
    assert.equal(service.approvals.inspect().length, 0);
    const unavailable = await service.execute({ action: 'workflows.recovery.authorize', workflowRunId: ready.runId } as any);
    assert.equal(unavailable.ok, false);
    const inspect = await service.execute({ action: 'workflows.recovery.inspect', workflowRunId: ready.runId });
    assert.equal((inspect.assessment as any).plan.status, 'blocked');
    assert.deepEqual((inspect.assessment as any).blocked, boundary === 'third-write' ? ['unselected-required-execution-address', zeroWriteBlocker] : ['unselected-required-execution-address']);
    assert.equal(service.get(ready.runId)!.recovery!.operations.at(-1)!.result?.status, boundary === 'first-receipt' ? 'completed' : undefined);
    assert.deepEqual(artifacts(), originalArtifacts, 'inspect/prepare must neither write nor clean any retained artifact');
    writeFileSync(join(projectRoot, 'src/a.txt'), 'HOSTILE');
    const hostile = await service.execute({ action: 'workflows.recovery.prepare', workflowRunId: ready.runId, selections });
    assertEvidenceBlocked(hostile.assessment, 'hostile destination');
    writeFileSync(join(projectRoot, 'src/a.txt'), 'new\n');
    // Tampering is a negative test only, never the source of interruption evidence.
    for (const field of ['candidateHash', 'preimageHash', 'postimageHash', 'path', 'generation', 'markerOwner', 'stageRoot', 'stageRootIdentity', 'markerIdentity', 'ownerEvidence', 'sequence', 'workflowRunId', 'missing-intent']) {
      const corrupt = structuredClone(container.snapshot());
      const workspace = (corrupt.extensions[WORKFLOW_EXTENSION_KEY] as any).runs[0].steps[3].units[0].coding.workspace;
      if (field === 'missing-intent') delete workspace.latestIntent; else workspace.latestIntent[field] = 'mismatch';
      const corruptService = createWorkflowService(createClankersStateContainer(corrupt), native, options);
      try {
        const mismatch = await corruptService.execute({ action: 'workflows.recovery.prepare', workflowRunId: ready.runId, selections });
        assertEvidenceBlocked(mismatch.assessment, field);
      } finally { corruptService.dispose(); }
    }
    if (boundary !== 'first-write') {
      for (const field of ['missing-observation', 'path', 'sequence', 'generation', 'workflowRunId', 'candidateHash', 'preimageHash', 'postimageHash', 'observedPostimageHash', 'status', 'stageRoot', 'ownerEvidence', 'markerOwner', 'error', 'evidenceHash', 'resultHash', 'missing-result', 'result-status', 'cleanup', 'previous-op-path', 'previous-op-preimage', 'previous-op-postimage', 'previous-op-generation', 'duplicate-current-path', 'unexpected-current-path', 'competing-application']) {
        if (boundary === 'first-receipt' && field === 'duplicate-current-path') continue;
        const corrupt = structuredClone(container.snapshot());
        const run = (corrupt.extensions[WORKFLOW_EXTENSION_KEY] as any).runs[0];
        const workspace = run.steps[3].units[0].coding.workspace;
        const apps = run.recovery.operations.filter((op: any) => op.kind === 'application');
        const prior = apps.at(boundary === 'first-receipt' ? -1 : -2), current = apps.at(-1);
        if (field === 'missing-observation') delete workspace.latestObservation;
        else if (field === 'evidenceHash' || field === 'resultHash') prior.result[field] = '0'.repeat(64);
        else if (field === 'missing-result') { delete prior.result; run.recovery.sequence--; }
        else if (field === 'result-status') prior.result.status = 'failed';
        else if (field === 'cleanup') prior.result.cleanup = 'uncertain';
        else if (field === 'previous-op-path') { prior.paths = ['src/c.txt']; prior.preimage = { 'src/c.txt': workspace.latestObservation.preimageHash }; prior.postimage = { 'src/c.txt': workspace.latestObservation.postimageHash }; }
        else if (field === 'previous-op-preimage') prior.preimage[prior.paths[0]] = '0'.repeat(64);
        else if (field === 'previous-op-postimage') prior.postimage[prior.paths[0]] = '0'.repeat(64);
        else if (field === 'previous-op-generation') prior.generation = 'unexpected-generation';
        else if (field === 'duplicate-current-path' || field === 'unexpected-current-path') {
          const path = field === 'duplicate-current-path' ? prior.paths[0] : 'unrelated.txt';
          workspace.latestIntent.path = path; current.paths = [path]; current.preimage = { [path]: workspace.latestIntent.preimageHash }; current.postimage = { [path]: workspace.latestIntent.postimageHash };
        } else if (field === 'competing-application') {
          run.recovery.operations.push({ ...structuredClone(current), id: current.id + ':competing', sequence: run.recovery.operations.length }); run.recovery.sequence += current.result ? 2 : 1;
        } else workspace.latestObservation[field] = 'mismatch';
        const corruptService = createWorkflowService(createClankersStateContainer(corrupt), native, options);
        try {
          const mismatch = await corruptService.execute({ action: 'workflows.recovery.prepare', workflowRunId: ready.runId, selections });
          assertEvidenceBlocked(mismatch.assessment, field);
        } finally { corruptService.dispose(); }
      }
      if (boundary === 'third-write') {
        for (const field of ['afterSaved', 'beforeCalled', 'candidateHash', 'status', 'malformed-effects']) {
          const corrupt = structuredClone(container.snapshot());
          const workspace = (corrupt.extensions[WORKFLOW_EXTENSION_KEY] as any).runs[0].steps[3].units[0].coding.workspace;
          const previous = workspace.recoveryManifest.effects.find((record: any) => record.kind === 'destination-write');
          if (field === 'malformed-effects') workspace.recoveryManifest.effects = 'mismatch';
          else previous[field] = field === 'afterSaved' || field === 'beforeCalled' ? false : field === 'status' ? 'uncertain' : '0'.repeat(64);
          const corruptService = createWorkflowService(createClankersStateContainer(corrupt), native, options);
          try {
            const mismatch = await corruptService.execute({ action: 'workflows.recovery.prepare', workflowRunId: ready.runId, selections });
            assertEvidenceBlocked(mismatch.assessment, 'manifest prior application ' + field);
          } finally { corruptService.dispose(); }
        }
      }
    }
    assert.deepEqual(artifacts(), originalArtifacts, 'negative in-memory observations must not change original receipts or manifest artifacts');
    const invalidReuse = await service.execute({ action: 'workflows.recovery.prepare', workflowRunId: ready.runId, selections: { ...selections, rerunUnitIds: selections.rerunUnitIds.filter((id: string) => id !== 'stage:0'), reuseUnitIds: [service.get(ready.runId)!.steps[0].units[0].id] } });
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
    assert.ok(manifest.destinationLeases.every((lease: any) => existsSync(lease.ownerFile)), 'assessment must not release leases');
    assert.equal(readFileSync(join(projectRoot, 'unrelated.txt'), 'utf8'), 'USER_BYTES');
    assert.deepEqual(readFileSync(snapshotFile), before);
    success = true;
  } finally { service.dispose(); }
});
