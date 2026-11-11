import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClankersState, createClankersStateContainer, updateClankersState } from '../state.js';
import { createClankersPersistenceManager } from '../persistence.js';
import { createWorkflowService, recoverWorkflowState } from '../workflow-runtime.js';
import { appendRecoveryIntent, validateRecoveryCheckpoint } from '../workflow-recovery.js';
import { WORKFLOW_EXTENSION_KEY, workflowHash, workflowUnitEnvelope } from '../workflow-model.js';
import type { WorkflowRecoveryDurablePort, WorkflowRecoveryNativeSettlementRequest } from '../workflow-model.js';
import type { RecoveryWriterOwnerEvidence } from '../persistence.js';

// Real local kernel identity; the newly acquired verifier PID must be LIVE.
function processState(owner: RecoveryWriterOwnerEvidence): 'live' | 'dead' | 'unknown' {
  try {
    if (readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() !== owner.bootId) return 'dead';
    const raw = readFileSync(`/proc/${owner.pid}/stat`, 'utf8');
    const ticks = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)[19];
    return ticks === owner.startTimeTicks ? 'live' : 'dead';
  } catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'dead' : 'unknown'; }
}
type Mutation = (f: Awaited<ReturnType<typeof fixture>>) => void;
async function fixture(t: any, options: { acquire?: Mutation; id?: Mutation; clock?: Mutation; owner?: Mutation; failAfterSave?: boolean; failAfterPublish?: boolean; saveWithoutPublish?: boolean; repeat?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'clankers-auth-kill-'));
  const previousTmpdir = process.env.TMPDIR; process.env.TMPDIR = root;
  const projectRoot = join(root, 'project'), stagingParent = join(root, 'stage'), snapshotFile = join(root, 'state.json');
  mkdirSync(projectRoot, { mode: 0o700 }); mkdirSync(stagingParent, { mode: 0o700 }); mkdirSync(join(projectRoot, 'src'));
  writeFileSync(join(projectRoot, 'src/a.txt'), 'old\n'); writeFileSync(join(projectRoot, 'unrelated.txt'), 'USER_BYTES');
  const runtimeUrl = new URL('../workflow-runtime.ts', import.meta.url).href;
  const stateUrl = new URL('../state.ts', import.meta.url).href;
  const persistUrl = new URL('../persistence.ts', import.meta.url).href;
  const modelUrl = new URL('../workflow-model.ts', import.meta.url).href;
  let driver = `
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
  if (options.repeat) {
    const output = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
    const repeat = { id: 'repeat-kill', version: 2, label: 'Repeat kill', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, steps: [{ id: 'loop', kind: 'repeat', dependsOn: [], initial: { value: { ok: false } }, stateSchema: output, body: [{ id: 'body', kind: 'native', dependsOn: [], inputs: {}, agentId: 'worker', prompt: 'literal', outputSchema: output }], feedback: { value: { ok: true } }, until: { op: 'boolean', value: { ref: { source: 'iteration', path: ['ok'] } } }, output: { ref: { source: 'iteration', path: [] } }, outputSchema: output, maxIterations: 2 }] };
    driver = driver.replace(/const definition=[\s\S]*?const agents=/, 'const definition=' + JSON.stringify(repeat) + ';const agents=')
      .replace("req.coding.write('src/a.txt','new\\n');", '')
      .replace('JSON.stringify({runId,approvalId:approval.id,requestHash:approval.requestHash,owner:', 'JSON.stringify({runId:req.workflowRunId,owner:')
      .replace(/    const end=Date.now\(\)\+6000;[\s\S]*$/, '');
  }
  // Deliberately no inherited provider credentials, PATH, or user environment.
  const producer = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', driver, projectRoot, stagingParent, snapshotFile], { env: { TMPDIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(producer, 'close');
  let stdout = '', stderr = '';
  producer.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 16384) producer.kill('SIGKILL'); });
  producer.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
  t.after(async () => {
    if (producer.exitCode === null && producer.signalCode === null) producer.kill('SIGKILL');
    await closed;
    if (previousTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmpdir;
    rmSync(root, { recursive: true, force: true }); assert.equal(existsSync(root), false);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { producer.kill('SIGKILL'); reject(new Error('producer deadline: ' + stderr)); }, 9000);
    const ready = () => { if (stdout.includes('\n')) { clearTimeout(timer); producer.stdout.off('data', ready); resolve(); } };
    producer.stdout.on('data', ready);
    producer.once('exit', () => { clearTimeout(timer); if (!stdout.includes('\n')) reject(new Error('producer exited: ' + stderr)); }); ready();
  });
  const ready = JSON.parse(stdout.trim()) as { runId: string; owner: RecoveryWriterOwnerEvidence };
  assert.equal(ready.owner.pid, producer.pid); assert.equal(processState(ready.owner), 'live');
  producer.kill('SIGKILL'); const [, signal] = await closed; assert.equal(signal, 'SIGKILL'); assert.equal(processState(ready.owner), 'dead');
  const store = createClankersPersistenceManager({ snapshotFile })!;
  const base = createClankersStateContainer(); store.hydrate(base);
  let saves = 0, publications = 0, launched = 0, acquired: RecoveryWriterOwnerEvidence | undefined;
  const saveThenPublish = (next: ReturnType<typeof base.read>, authorization = false) => {
    saves++; store.save(next);
    if (authorization && options.failAfterSave) throw new Error('after-effect publication failed');
    if (authorization && options.saveWithoutPublish) return next;
    const result = base.replace(next);
    if (authorization && options.failAfterPublish) throw new Error('after-publication observer failed');
    return result;
  };
  const container = { ...base,
    replace(next: ReturnType<typeof base.read>) { return saveThenPublish(createClankersState(next)); },
    update(patch: any, opts: any) { return saveThenPublish(updateClankersState(base.read(), patch, opts)); },
  };
  const durable: WorkflowRecoveryDurablePort = {
    ensureWriter: () => store.acquireRecoveryOwnership!().owner,
    inspectOwner: () => { const observed = store.inspectRecoveryOwnership!(); if (f) options.owner?.(f); return observed; },
    inspectPreviousOwner: processState,
    acquireWriter: optionsForAcquire => {
      assert.deepEqual(optionsForAcquire?.verifiedDeadOwner, ready.owner);
      assert.equal(optionsForAcquire?.expectedSnapshotHash, store.inspectRecoveryOwnership!().actualSnapshotHash);
      acquired = store.acquireRecoveryOwnership!(optionsForAcquire).owner;
      assert.equal(acquired.pid, process.pid); assert.equal(processState(acquired), 'live');
      options.acquire?.(f); return acquired;
    },
    publishSnapshot: (next, opts) => {
      assert.equal(opts?.expectedSnapshotHash, store.inspectRecoveryOwnership!().actualSnapshotHash);
      publications++; return saveThenPublish(next as ReturnType<typeof base.read>, true);
    },
  };
  // Immutable checkpoint produced by this closed fake transport: execute only writes
  // synchronously in its own process, then waits; it launches no detached native work.
  const producerRun = JSON.parse(readFileSync(snapshotFile, 'utf8')).state.extensions.workflows.runs.find((r: any) => r.workflowRunId === ready.runId);
  const settlementRequests = producerRun.recovery.operations.filter((op: any) => op.kind === 'native' || op.kind === 'review').map((op: any) => {
    const unit = producerRun.steps.flatMap((step: any) => [...step.units, ...(step.iterations ?? []).flatMap((it: any) => it.steps.flatMap((step: any) => step.units))]).find((u: any) => u.id === op.unitId);
    assert.ok(unit, 'producer checkpoint identifies exact native unit');
    return Object.freeze({ workflowRunId: producerRun.workflowRunId, familyId: producerRun.familyId, unitId: op.unitId, operationId: op.id, native: unit.native ? Object.freeze(structuredClone(unit.native)) : null, inputHash: op.inputHash, dependencyHash: op.dependencyHash, policyHash: op.policyHash });
  });
  assert.equal(settlementRequests.length, 1);
  const inspectNativeSettlement = (request: WorkflowRecoveryNativeSettlementRequest): 'settled' | 'unknown' => processState(ready.owner) === 'dead' && settlementRequests.some((proof: any) => workflowHash(proof) === workflowHash(request)) ? 'settled' : 'unknown';
  const config = { recovery: { enabled: true, durablePort: durable, inspectNativeSettlement }, coding: { enabled: true, projectRoot, stagingParent, writablePaths: ['src/a.txt'], checkProfiles: { node: { id: 'node', executable: process.execPath, argv: ['-e', 'process.exit(0)'], cwd: 'src', env: {}, timeoutMs: 2000, outputBytes: 65536, generatedOutputs: [] } } } };
  let f: any;
  const native = { preflight() {
    assert.equal(publications, 1, 'native preflight is allowed only after successful host commit');
    assert.equal(base.read().extensions.workflows !== undefined, true);
  }, async execute() { launched++; throw new Error('authorization must not execute before implementation grant'); } };
  const service = createWorkflowService(container, native, { ...config, idFactory: () => { options.id?.(f); return `child-${publications + 1}`; }, now: () => { options.clock?.(f); return new Date(); } });
  const manifest = options.repeat ? null : (service.get(ready.runId)!.steps[0].units[0].coding!.workspace as any).recoveryManifest;
  if (manifest) assert.ok(manifest.destinationLeases.every((lease: any) => lease.leaseDir.startsWith(root + '/') && lease.ownerFile.startsWith(lease.leaseDir + '/')));
  const displayed = await service.execute({ action: 'workflows.recovery.inspect', workflowRunId: ready.runId });
  assert.equal(displayed.ok, true, displayed.error);
  const selections = structuredClone((displayed.assessment as any).plan.recommendedSelections);
  assert.deepEqual(selections.rerunUnitIds, options.repeat ? ['loop@0/body:0', 'loop@1/body:0'] : ['stage:0', 'check:0', 'review:0', 'apply:0']);
  // Recommendation is data, not permission: the caller explicitly resubmits it.

  f = { root, ready, store, base, container, service, manifest, projectRoot, snapshotFile, selections, config, native,
    get saves() { return saves; }, get publications() { return publications; }, get launched() { return launched; }, get acquired() { return acquired; },
    prepare: () => service.recovery!.prepare(ready.runId, selections),
    authorize: (fp: string) => service.recovery!.authorize({ workflowRunId: ready.runId, assessmentFingerprint: fp, selections }),
    restore: () => {
      const restored = createClankersStateContainer(); const persistence = createClankersPersistenceManager({ snapshotFile })!; persistence.hydrate(restored);
      let secondPublish = 0;
      const restoredService = createWorkflowService(restored, native, { ...config, recovery: { enabled: true, inspectNativeSettlement, durablePort: {
        ensureWriter: () => persistence.acquireRecoveryOwnership!().owner,
        inspectOwner: () => persistence.inspectRecoveryOwnership!(), inspectPreviousOwner: processState,
        acquireWriter: opts => persistence.acquireRecoveryOwnership!(opts).owner,
        publishSnapshot: next => { secondPublish++; persistence.save(next as any); return restored.replace(next as any); },
      } } });
      return { service: restoredService, restored, get publications() { return secondPublish; } };
    },
  };
  t.after(() => service.dispose());
  return f as { root: string; ready: typeof ready; store: typeof store; base: typeof base; container: typeof container; service: typeof service; manifest: any; projectRoot: string; snapshotFile: string; selections: typeof selections; saves: number; publications: number; launched: number; acquired?: RecoveryWriterOwnerEvidence; prepare: () => Promise<any>; authorize: (fp: string) => Promise<any>; restore: () => any };
}

async function preparedFingerprint(f: Awaited<ReturnType<typeof fixture>>) {
  const before = { saves: f.saves, publications: f.publications, launched: f.launched };
  const bytes = readFileSync(f.snapshotFile);
  const p = await f.prepare(); assert.equal(p.ok, true, p.error);
  assert.deepEqual({ saves: f.saves, publications: f.publications, launched: f.launched }, before);
  assert.deepEqual(readFileSync(f.snapshotFile), bytes);
  assert.equal(p.assessment.plan.status, 'prepared', JSON.stringify(p.assessment.blocked));
  assert.deepEqual(p.assessment.ownerInspection.owner, f.ready.owner);
  assert.equal(p.assessment.ownerInspection.actualSnapshotHash, f.store.inspectRecoveryOwnership!().actualSnapshotHash);
  return p.assessment.fingerprint as string;
}

test('real SIGKILL: exact displayed selection commits one linked child then requests fresh implementation', { timeout: 20000 }, async t => {
  const f = await fixture(t); const fp = await preparedFingerprint(f);
  const sourceBefore = f.service.get(f.ready.runId)!;
  const a = await f.authorize(fp); assert.equal(a.ok, true, a.error);
  assert.equal(f.publications, 1); assert.equal(f.saves, 5); assert.equal(f.launched, 0);
  const source = f.service.get(f.ready.runId)!; const child = f.service.get(a.view.workflowRunId)!;
  assert.equal(source.status, 'needs-attention'); assert.equal(source.recovered, true);
  assert.deepEqual(source.steps, sourceBefore.steps);
  assert.deepEqual(source.recoveryOriginal, sourceBefore.recoveryOriginal);
  assert.deepEqual(source.recovery!.operations, sourceBefore.recovery!.operations);
  assert.equal(source.supersededBy, child.workflowRunId); assert.equal(source.recovery!.selection!.assessmentFingerprint, fp);
  assert.equal(source.recovery!.selection!.continuationAttemptId, child.workflowRunId);
  assert.equal(source.steps[0].units[0].status, 'unverified'); // No fake original completion.
  assert.equal(child.recoveryOf, source.workflowRunId); assert.equal(child.recovery!.selection, undefined);
  assert.equal(child.recovery!.origin!.sourceAttemptId, source.workflowRunId); assert.equal(child.recovery!.origin!.assessmentFingerprint, fp);
  assert.equal(child.status, 'running'); assert.equal(child.admissions, source.admissions);
  assert.equal(f.service.approvals.inspect().filter(x => x.kind === 'implementation' && x.status === 'pending').length, 1);
  assert.equal(child.recovery!.budget.usedAdmissions, source.recovery!.budget.usedAdmissions);
  assert.equal(child.recovery!.budget.correctionsUsed, source.recovery!.budget.correctionsUsed);
  assert.deepEqual(child.recovery!.budget.attemptIds, [source.workflowRunId, child.workflowRunId]);
  assert.equal(child.steps[0].status, 'running'); assert.equal(child.steps[0].units.length, 1);
  assert.equal(child.steps[0].units[0].coding!.phase, 'awaiting-implementation-approval');
  assert.equal(child.steps[0].units[0].native, undefined);
  assert.equal(child.recovery!.operations.length, 0);
  assert.equal(readFileSync(join(f.projectRoot, 'src/a.txt'), 'utf8'), 'old\n');
  assert.equal(processState(f.acquired!), 'live');
  // Ordinary read-only assessment never exempts the now-live writer.
  const now = await f.prepare(); assert.match(JSON.stringify(now.assessment.blocked), /snapshot-writer-live/);
  const duplicate = await f.authorize(fp); assert.equal(duplicate.ok, true, duplicate.error); assert.equal(duplicate.view.workflowRunId, child.workflowRunId);
  const competing = await f.service.recovery!.authorize({ workflowRunId: source.workflowRunId, assessmentFingerprint: fp, selections: {} });
  assert.equal(competing.ok, false); assert.equal(f.publications, 1);
  const fresh = f.restore();
  const again = await fresh.service.recovery.authorize({ workflowRunId: source.workflowRunId, assessmentFingerprint: fp, selections: f.selections });
  assert.equal(again.ok, true, again.error); assert.equal(again.view.workflowRunId, child.workflowRunId); assert.equal(fresh.publications, 0);
  assert.equal(recoverWorkflowState(fresh.restored.read().extensions[WORKFLOW_EXTENSION_KEY]).runs.filter(r => r.recoveryOf === source.workflowRunId).length, 1);
  fresh.service.dispose();
});

test('real SIGKILL: stale artifact plan loses to fresh exact selection; no competing child', { timeout: 20000 }, async t => {
  const f = await fixture(t); const stale = await preparedFingerprint(f);
  writeFileSync(join(f.projectRoot, 'src/a.txt'), 'new\n');
  const satisfied = await f.prepare();
  assert.equal(satisfied.assessment.plan.status, 'blocked');
  assert.match(JSON.stringify(satisfied.assessment.blocked), /fully-satisfied-zero-write/);
  writeFileSync(join(f.projectRoot, 'src/a.txt'), 'old\n');
  f.base.update({ mode: { ...f.base.read().mode, contextId: 'fresh-display' } });
  const fresh = await preparedFingerprint(f); assert.notEqual(stale, fresh);
  const [oldReply, newReply] = await Promise.all([f.authorize(stale), f.authorize(fresh)]);
  assert.equal(oldReply.ok, false); assert.equal(newReply.ok, true, newReply.error);
  assert.equal(f.publications, 1); assert.equal(f.saves, 5); assert.equal(f.launched, 0);
});

const mutations: Record<string, Mutation> = {
  readonly: f => f.base.replace({ ...f.base.read(), mode: { ...f.base.read().mode, readOnly: true } }),
  mode: f => f.base.replace({ ...f.base.read(), mode: { ...f.base.read().mode, contextId: 'changed-context' } }),
  namespace: f => { const next = structuredClone(f.base.read()); (next.extensions[WORKFLOW_EXTENSION_KEY] as any).runs[0].error = 'changed'; f.base.replace(next); },
  policy: f => { const next = structuredClone(f.base.read()); next.agentDefinitions.worker.prompt += ' drift'; f.base.replace(next); },
  artifact: f => writeFileSync(join(f.manifest.stageRoot, 'src/a.txt'), 'drift\n'),
  destination: f => writeFileSync(join(f.projectRoot, 'src/a.txt'), 'conflict\n'),
  head: f => writeFileSync(f.snapshotFile, readFileSync(f.snapshotFile, 'utf8') + '\n'),
};
for (const phase of ['acquire', 'id', 'clock'] as const) for (const [label, mutate] of Object.entries(mutations)) {
  test(`real SIGKILL: ${phase} callback ${label} mutation blocks publication`, { timeout: 20000 }, async t => {
    const f = await fixture(t, { [phase]: mutate }); const fp = await preparedFingerprint(f);
    const a = await f.authorize(fp); assert.equal(a.ok, false, JSON.stringify(a));
    assert.equal(f.publications, 0); assert.equal(f.saves, 0); assert.equal(f.launched, 0);
    assert.equal(f.service.list().filter(r => r.recoveryOf === f.ready.runId).length, 0);
    assert.equal(processState(f.acquired!), 'live');
  });
}

test('real SIGKILL: last owner-inspection callback artifact mutation is rejected before publication', { timeout: 20000 }, async t => {
  let armed = false, calls = 0;
  const f = await fixture(t, { id: () => { armed = true; }, owner: x => { if (armed && ++calls === 2) mutations.artifact!(x); } });
  const fp = await preparedFingerprint(f); const a = await f.authorize(fp);
  assert.equal(a.ok, false); assert.equal(f.publications, 0); assert.equal(f.saves, 0);
});

test('real SIGKILL: after-effect publication failure poisons same service; fresh restore cannot allocate a second child', { timeout: 20000 }, async t => {
  const f = await fixture(t, { failAfterSave: true }); const fp = await preparedFingerprint(f);
  const first = await f.authorize(fp); assert.equal(first.ok, false); assert.match(first.error, /after-effect/);
  const second = await f.authorize(fp); assert.equal(second.ok, false); assert.match(second.error, /poisoned/);
  assert.equal(f.publications, 1); assert.equal(f.saves, 1); assert.equal(f.launched, 0);
  const fresh = f.restore(); const linked = fresh.service.list().filter((r: any) => r.recoveryOf === f.ready.runId);
  assert.equal(linked.length, 1);
  const duplicate = await fresh.service.recovery.authorize({ workflowRunId: f.ready.runId, assessmentFingerprint: fp, selections: f.selections });
  assert.equal(duplicate.ok, true, duplicate.error); assert.equal(duplicate.view.workflowRunId, linked[0].workflowRunId); assert.equal(fresh.publications, 0);
  fresh.service.dispose();
});

test('origin admission count is historical: admission debits once per unit and permits later outgoing selection', { timeout: 20000 }, async t => {
  const f = await fixture(t); const fp = await preparedFingerprint(f); const a = await f.authorize(fp); assert.equal(a.ok, true, a.error);
  const cp = f.service.get(a.view.workflowRunId)!.recovery!;
  const input = { kind: 'native' as const, id: 'fresh-native', stepId: 'stage', unitId: 'stage:0', inputHash: workflowHash({}), dependencyHash: workflowHash({ dep: 1 }), policyHash: workflowHash({ policy: 1 }), paths: [], preimage: null, postimage: null, intent: { recordedAt: new Date().toISOString() } };
  const admitted = appendRecoveryIntent(cp, input); assert.equal(admitted.ok, true, JSON.stringify(admitted));
  assert.equal(admitted.value.budget.usedAdmissions, cp.budget.usedAdmissions + 1);
  assert.equal(admitted.value.origin!.usedAdmissions, cp.budget.usedAdmissions);
  const repeated = appendRecoveryIntent(admitted.value, { ...input, id: 'fresh-native-second-operation' }); assert.equal(repeated.ok, true, JSON.stringify(repeated));
  assert.equal(repeated.value.budget.usedAdmissions, admitted.value.budget.usedAdmissions);
  const outgoing = { ...cp.origin!, sourceAttemptId: cp.workflowRunId, continuationAttemptId: 'third', attemptNo: 3, usedAdmissions: admitted.value.budget.usedAdmissions };
  const both = validateRecoveryCheckpoint({ ...admitted.value, sequence: admitted.value.sequence + 1, selection: outgoing }); assert.equal(both.ok, true, JSON.stringify(both));
});


test('real SIGKILL: partial repeat selection blocks without resetting interrupted cursor/history', { timeout: 20000 }, async t => {
  const f = await fixture(t, { repeat: true });
  const history = f.service.get(f.ready.runId)!;
  assert.equal(history.steps[0].iterations!.length, 1);
  const partial = { rerunUnitIds: ['loop@0/body:0'] };
  const p = await f.service.recovery!.prepare(f.ready.runId, partial); assert.equal(p.ok, true, p.error);
  assert.equal((p.assessment as any).plan.status, 'blocked'); assert.match(JSON.stringify((p.assessment as any).blocked), /unselected-required-execution-address/);
  const a = await f.service.recovery!.authorize({ workflowRunId: f.ready.runId, assessmentFingerprint: (p.assessment as any).fingerprint, selections: partial }); assert.equal(a.ok, false);
  assert.deepEqual(f.service.get(f.ready.runId)!.steps, history.steps); assert.equal(f.publications, 0); assert.equal(f.launched, 0);
});


test('real SIGKILL: error after canonical publication poisons authorization, preserving durable single child', { timeout: 20000 }, async t => {
  const f = await fixture(t, { failAfterPublish: true }); const fp = await preparedFingerprint(f);
  assert.equal((await f.authorize(fp)).ok, false);
  const canonical = f.base.read().extensions[WORKFLOW_EXTENSION_KEY] as any;
  assert.equal(canonical.runs.filter((r: any) => r.recoveryOf === f.ready.runId).length, 1);
  const again = await f.authorize(fp); assert.equal(again.ok, false); assert.match(again.error, /poisoned/);
  assert.equal(f.publications, 1); assert.equal(f.saves, 1); assert.equal(f.launched, 0);
  const fresh = f.restore();
  const duplicate = await fresh.service.recovery.authorize({ workflowRunId: f.ready.runId, assessmentFingerprint: fp, selections: f.selections });
  assert.equal(duplicate.ok, true, duplicate.error); assert.equal(fresh.publications, 0); fresh.service.dispose();
});

test('real SIGKILL: linked family evidence survives forget/restore; missing anchor or correction reset is rejected', { timeout: 20000 }, async t => {
  const f = await fixture(t); const fp = await preparedFingerprint(f); const a = await f.authorize(fp); assert.equal(a.ok, true, a.error);
  const before = structuredClone(f.base.read().extensions[WORKFLOW_EXTENSION_KEY]) as any;
  for (const workflowRunId of [f.ready.runId, a.view.workflowRunId]) {
    const forgotten = await f.service.execute({ action: 'workflows.forget', workflowRunId });
    assert.equal(forgotten.ok, false); assert.match(forgotten.error!, /referenced recovery family anchor/);
  }
  assert.deepEqual(f.base.read().extensions[WORKFLOW_EXTENSION_KEY], before);
  assert.equal(f.publications, 1); assert.equal(f.saves, 5);
  const missingRoot = structuredClone(before); missingRoot.runs = missingRoot.runs.filter((r: any) => r.workflowRunId !== f.ready.runId);
  assert.throws(() => recoverWorkflowState(missingRoot), /Recovery family anchor\/source attempt is missing/);
  const missingChild = structuredClone(before); missingChild.runs = missingChild.runs.filter((r: any) => r.workflowRunId !== a.view.workflowRunId);
  assert.throws(() => recoverWorkflowState(missingChild), /selected child\/origin is missing/);
  // Deliberate corrupt restore inputs, never written as invented workflow results.
  const reset = structuredClone(before); reset.runs.find((r: any) => r.workflowRunId === f.ready.runId).recovery.budget.correctionsUsed = 1;
  assert.throws(() => recoverWorkflowState(reset), /admission\/correction counter reset/);
  const fresh = f.restore();
  assert.equal(fresh.service.get(a.view.workflowRunId).recovery.budget.usedAdmissions, before.runs[1].recovery.budget.usedAdmissions);
  assert.equal(fresh.service.get(a.view.workflowRunId).recovery.budget.correctionsUsed, before.runs[1].recovery.budget.correctionsUsed); fresh.service.dispose();
});

// Exact regressions for the independent review's three reproduced defects.
test('real SIGKILL: restore rejects missing predecessor plus erased source reservation, and every asymmetric link', { timeout: 20000 }, async t => {
  const f = await fixture(t); const fp = await preparedFingerprint(f);
  const a = await f.authorize(fp); assert.equal(a.ok, true, a.error);
  const canonical = structuredClone(f.base.read().extensions[WORKFLOW_EXTENSION_KEY]) as any;
  const corruptions: Array<(source: any, child: any, ledger: any) => void> = [
    (source, child) => { delete source.recovery.selection; child.recoveryOf = 'missing-predecessor'; },
    source => { delete source.recovery.selection; },
    (_source, child) => { child.recoveryOf = 'missing-predecessor'; },
    (_source, child) => { delete child.recovery.origin; },
    (source, child) => { delete source.recovery.selection; delete child.recovery; },
    (source, child) => { delete source.recovery.selection; delete child.recovery.origin; delete child.recoveryOf; child.retryOf = 'missing-predecessor'; },
    (source, child) => { delete source.recovery.selection; delete child.recoveryOf; child.retryOf = source.workflowRunId; },
    (_source, child) => { child.recovery.budget.attemptIds[0] = 'missing-prefix'; },
    (_source, child) => { child.recovery.origin.assessmentFingerprint = workflowHash('different-selection'); },
    (source, _child, ledger) => { ledger.runs = ledger.runs.filter((r: any) => r !== source); },
  ];
  for (const corrupt of corruptions) {
    const ledger = structuredClone(canonical);
    corrupt(ledger.runs.find((r: any) => r.workflowRunId === f.ready.runId), ledger.runs.find((r: any) => r.workflowRunId === a.view.workflowRunId), ledger);
    assert.throws(() => recoverWorkflowState(ledger), /Invalid previous attempt evidence|Recovery predecessor\/origin\/reservation|Invalid workflow recovery checkpoint|Recovery family anchor\/source|Recovery selected child\/origin|Recovery family predecessor|Recovery lineage requires/);
  }
  // Ordinary legacy retry ledgers have no retained checkpoint-prefix contract. Do not
  // retroactively require their (historically forgettable) predecessor to be retained.
  const legacy = structuredClone(canonical);
  legacy.runs = legacy.runs.filter((r: any) => r.workflowRunId === a.view.workflowRunId);
  delete legacy.runs[0].recovery; delete legacy.runs[0].recoveryOf;
  legacy.runs[0].retryOf = f.ready.runId;
  assert.doesNotThrow(() => recoverWorkflowState(legacy));
  assert.equal(f.saves, 5); assert.equal(f.publications, 1); assert.equal(f.launched, 0);
});

for (const phase of ['acquire', 'id', 'clock'] as const) test(`real SIGKILL: cancellation at ${phase} before commit publishes no selection`, { timeout: 20000 }, async t => {
  const controller = new AbortController();
  const f = await fixture(t, { [phase]: () => controller.abort() }); const fp = await preparedFingerprint(f);
  const before = structuredClone(f.base.read().extensions[WORKFLOW_EXTENSION_KEY]);
  const reply = await f.service.recovery!.authorize({ workflowRunId: f.ready.runId, assessmentFingerprint: fp, selections: f.selections }, controller.signal);
  assert.equal(reply.ok, false); assert.match(reply.error!, /cancel/);
  assert.equal(f.publications, 0); assert.equal(f.saves, 0); assert.equal(f.launched, 0);
  assert.deepEqual(f.base.read().extensions[WORKFLOW_EXTENSION_KEY], before);
  assert.equal(f.service.get(f.ready.runId)!.recovery!.selection, undefined);
});

for (const phase of ['publish-return', 'service-listener', 'after-return'] as const) test(`real SIGKILL: cancellation ${phase} targets exact selected canonical child without native execution`, { timeout: 20000 }, async t => {
  const f = await fixture(t); const fp = await preparedFingerprint(f); const controller = new AbortController();
  const sourceBefore = f.service.get(f.ready.runId)!;
  if (phase === 'publish-return') {
    const durable = (f as any).config.recovery.durablePort, publish = durable.publishSnapshot;
    durable.publishSnapshot = (next: any, options: any) => { const out = publish(next, options); controller.abort(); return out; };
  }
  if (phase === 'service-listener') f.service.subscribe(() => controller.abort());
  const reply = await f.service.recovery!.authorize({ workflowRunId: f.ready.runId, assessmentFingerprint: fp, selections: f.selections }, controller.signal);
  assert.equal(reply.ok, phase === 'after-return', reply.error);
  if (phase === 'after-return') controller.abort(); else assert.match(reply.error!, /cancelled after durable selection/);
  const childId = reply.view!.workflowRunId;
  const canonical = f.base.read().extensions[WORKFLOW_EXTENSION_KEY] as any;
  const child = f.service.get(childId)!;
  assert.deepEqual(child, canonical.runs.find((r: any) => r.workflowRunId === childId));
  assert.equal(child.status, 'cancelled'); assert.equal(child.cleanupSettled, true);
  if (phase !== 'after-return') assert.ok(child.steps.every(s => s.status === 'cancelled' && s.units.length === 0 && s.output === undefined));
  else {
    assert.deepEqual(child.steps[0].output, workflowUnitEnvelope(child.steps[0].units[0]));
    assert.ok(child.steps.slice(1).every(s => s.status === 'cancelled' && s.output === undefined && s.units.length === 0));
    assert.ok(child.steps.flatMap(s => s.units).every(u => u.status === 'cancelled' && !u.native && u.result === undefined && u.cleanupSettled));
    assert.equal(child.steps[0].units[0].coding!.phase, 'awaiting-implementation-approval');
  }
  assert.equal(child.recovery!.operations.length, 0); assert.equal(child.recovery!.origin!.assessmentFingerprint, fp);
  const source = f.service.get(f.ready.runId)!;
  assert.deepEqual(source.steps, sourceBefore.steps); assert.equal(source.error, sourceBefore.error);
  assert.equal(source.status, sourceBefore.status); assert.deepEqual(source.recoveryOriginal, sourceBefore.recoveryOriginal);
  assert.equal(source.recovery!.selection!.continuationAttemptId, childId); assert.equal(source.supersededBy, childId);
  assert.equal(f.publications, 1); assert.equal(f.saves, phase === 'after-return' ? 6 : 3); assert.equal(f.launched, 0);
  const duplicate = await f.authorize(fp); assert.equal(duplicate.ok, true, duplicate.error); assert.equal(duplicate.view.workflowRunId, childId);
  const fresh = f.restore();
  assert.equal(fresh.service.get(childId).status, 'cancelled');
  const again = await fresh.service.recovery.authorize({ workflowRunId: f.ready.runId, assessmentFingerprint: fp, selections: f.selections });
  assert.equal(again.ok, true, again.error); assert.equal(again.view.workflowRunId, childId); assert.equal(fresh.publications, 0);
  fresh.service.dispose();
});

for (const failure of ['failAfterSave', 'failAfterPublish'] as const) test(`real SIGKILL: ${failure} retains bounded poison on inspect/list/status without read effects or invented publication`, { timeout: 20000 }, async t => {
  const f = await fixture(t, { [failure]: true }); const fp = await preparedFingerprint(f);
  const original = f.service.get(f.ready.runId)!;
  const failed = await f.authorize(fp); assert.equal(failed.ok, false);
  const reason = failure === 'failAfterSave' ? 'after-effect publication failed' : 'after-publication observer failed';
  assert.equal(failed.recoveryDiagnostic.reason, reason);
  const diagnostic = { reason, localView: 'stale-or-uncertain', publication: failure === 'failAfterSave' ? 'uncertain' : 'canonical-selection-observed' };
  const beforeReads = structuredClone(f.base.read()); const snapshotBefore = readFileSync(f.snapshotFile);
  // Read projections may not reacquire, inspect the writer/artifacts, save or reconnect.
  const durable = (f as any).config.recovery.durablePort;
  durable.inspectOwner = durable.acquireWriter = durable.publishSnapshot = () => { throw Error('unexpected read effect'); };
  for (const action of ['workflows.recovery.inspect', 'workflows.recovery.prepare', 'workflows.show', 'workflows.report'] as const) {
    const read = await f.service.execute({ action, workflowRunId: f.ready.runId });
    assert.deepEqual(read.view!.recoveryDiagnostic, diagnostic);
    assert.equal(read.view!.error, original.error); assert.equal(read.view!.status, original.status);
    if (action.startsWith('workflows.recovery.')) { assert.equal(read.ok, false); assert.match(read.error!, new RegExp(reason)); }
  }
  const list = f.service.list(); const status = await f.service.execute({ action: 'workflows.list' });
  assert.deepEqual(status.recoveryDiagnostic, diagnostic);
  for (const view of [...list, ...status.runs!]) assert.deepEqual(view.recoveryDiagnostic, diagnostic);
  const linked = list.filter(r => r.recoveryOf === f.ready.runId);
  assert.equal(linked.length, failure === 'failAfterSave' ? 0 : 1);
  if (linked.length) {
    const shown = await f.service.execute({ action: 'workflows.show', workflowRunId: linked[0].workflowRunId });
    assert.equal(shown.ok, true); assert.deepEqual(shown.view!.recoveryDiagnostic, diagnostic);
    assert.equal(shown.view!.status, 'running');
    assert.equal(f.service.get(linked[0].workflowRunId)!.steps[0].status, 'queued');
  }
  const source = f.service.get(f.ready.runId)!;
  assert.equal(source.error, original.error); assert.equal(source.status, original.status);
  assert.deepEqual(source.steps, original.steps); assert.deepEqual(source.recoveryOriginal, original.recoveryOriginal);
  const again = await f.authorize(fp); assert.equal(again.ok, false); assert.match(again.error, /poisoned/); assert.deepEqual(again.recoveryDiagnostic, diagnostic);
  assert.deepEqual(f.base.read(), beforeReads); assert.deepEqual(readFileSync(f.snapshotFile), snapshotBefore);
  assert.equal(f.publications, 1); assert.equal(f.saves, 1); assert.equal(f.launched, 0);
  const fresh = f.restore(); const restoredLinked = fresh.service.list().filter((r: any) => r.recoveryOf === f.ready.runId);
  assert.equal(restoredLinked.length, 1);
  const duplicate = await fresh.service.recovery.authorize({ workflowRunId: f.ready.runId, assessmentFingerprint: fp, selections: f.selections });
  assert.equal(duplicate.ok, true, duplicate.error); assert.equal(duplicate.view.workflowRunId, restoredLinked[0].workflowRunId); assert.equal(fresh.publications, 0); fresh.service.dispose();
});

test('real SIGKILL: save-only publication callback returning normally cannot project an unobserved child', { timeout: 20000 }, async t => {
  const f = await fixture(t, { saveWithoutPublish: true }); const fp = await preparedFingerprint(f);
  const failed = await f.authorize(fp); assert.equal(failed.ok, false); assert.match(failed.error, /ledger changed during recovery publication/);
  assert.equal(failed.recoveryDiagnostic.publication, 'uncertain');
  assert.equal(f.service.list().filter(r => r.recoveryOf === f.ready.runId).length, 0);
  assert.equal((f.base.read().extensions[WORKFLOW_EXTENSION_KEY] as any).runs.length, 1);
  const inspect = await f.service.execute({ action: 'workflows.recovery.inspect', workflowRunId: f.ready.runId });
  assert.equal(inspect.ok, false); assert.deepEqual(inspect.recoveryDiagnostic, failed.recoveryDiagnostic);
  const again = await f.authorize(fp); assert.equal(again.ok, false); assert.match(again.error, /poisoned/);
  assert.equal(f.saves, 1); assert.equal(f.publications, 1); assert.equal(f.launched, 0);
  const fresh = f.restore(); assert.equal(fresh.service.list().filter((r: any) => r.recoveryOf === f.ready.runId).length, 1);
  const duplicate = await fresh.service.recovery.authorize({ workflowRunId: f.ready.runId, assessmentFingerprint: fp, selections: f.selections });
  assert.equal(duplicate.ok, true, duplicate.error); assert.equal(fresh.publications, 0); fresh.service.dispose();
});
