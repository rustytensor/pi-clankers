import assert from 'node:assert/strict';
import test from 'node:test';
import { createClankersStateContainer } from '../state.js';
import { createWorkflowService, recoverWorkflowState } from '../workflow-runtime.js';
import { workflowHash, workflowRecoveryDependencyHash, workflowRecoverySourceContract, workflowUnitHash } from '../workflow-model.js';
import type { WorkflowDefinition, WorkflowNativePort, WorkflowRun, WorkflowSchema } from '../workflow-model.js';

const stringSchema: WorkflowSchema = { type: 'string', maxLength: 100 };
const inputSchema: WorkflowSchema = { type: 'object', properties: { x: stringSchema }, required: ['x'], additionalProperties: false };
const agent = { id: 'worker', label: 'Worker', source: 'builtin', prompt: 'Do work', model: 'fake/model' } as const;
const def: WorkflowDefinition = { id: 'producer-v2', version: 2, label: 'Producer', inputSchema, steps: [{ id: 'work', kind: 'native', dependsOn: [], agentId: 'worker', prompt: 'Return JSON string', outputSchema: stringSchema, inputs: { x: { ref: { source: 'inputs', path: ['x'] } } } }] };
const container = () => createClankersStateContainer({ agentDefinitions: { worker: agent }, extensions: {} });
const okPort = (events: string[] = []): WorkflowNativePort => ({ preflight() {}, execute: async req => { events.push('effect'); req.onIdentity({ runId: `native-${req.unitId}`, taskId: `task-${req.unitId}` }); return { status: 'completed', text: JSON.stringify('ok'), identity: { runId: `native-${req.unitId}`, taskId: `task-${req.unitId}` }, cleanupSettled: true }; } });
const owner = { bootId: 'boot', pid: 123, startTimeTicks: '1', writerSessionId: 'writer', generation: 'gen-1' };
const recovery = (events: string[] = [], failAfter = -1) => { let writes = 0; return { enabled: true, durablePort: { ensureWriter() { events.push('ensureWriter'); return owner; }, inspectOwner() { events.push('inspectOwner'); return { snapshotFile: 'snapshot.json', lockDir: 'lock', claimDir: 'claim', expectedSnapshotHash: '0'.repeat(64), owner, ownerValid: true, claimPresent: false }; } }, bump() { writes++; if (writes === failAfter) throw new Error('sync durable fault'); } }; };

test('fresh service with disabled/missing recovery performs zero durable acquisition or execution', async () => {
  const events: string[] = [];
  const service = createWorkflowService(container(), okPort(events), { recovery: { enabled: false } });
  assert.deepEqual(events, []);
  assert.equal((await service.execute({ action: 'workflows.list' })).ok, true);
  assert.deepEqual(events, []);
  service.dispose();
});

test('authorized start ensures writer and checkpoints before native effect ordering', async () => {
  const events: string[] = [];
  const c = container(); const service = createWorkflowService(c, okPort(events), { recovery: recovery(events) });
  await service.execute({ action: 'workflows.define', definition: def });
  const reply = await service.execute({ action: 'workflows.start', definitionId: def.id, inputs: { x: 'a' }, concurrency: 1 });
  assert.equal(reply.ok, true);
  assert.equal(events[0], 'ensureWriter');
  assert(events.indexOf('effect') === -1 || events.indexOf('ensureWriter') < events.indexOf('effect'));
  const run = service.get(reply.view!.workflowRunId)!;
  assert.equal(run.recovery?.workflowRunId, run.workflowRunId);
  assert.equal(run.recovery?.inputsHash, workflowHash(run.inputs));
  service.dispose();
});

test('post-result persist failure retains intent and closes further admission without retrying save', async () => {
  const events: string[] = [];
  const c = container(), update = c.update.bind(c);
  let faults = 0;
  c.update = (patch, options) => {
    const value = typeof patch === 'function' ? patch(c.read()) : patch;
    const ledger = value.extensions?.workflows as { runs?: WorkflowRun[] } | undefined;
    if (ledger?.runs?.some(run => run.recovery?.operations.some(op => op.result))) { faults++; throw new Error('durable result save failed'); }
    return update(value, options);
  };
  const service = createWorkflowService(c, okPort(events), { recovery: recovery(events) });
  await service.execute({ action: 'workflows.define', definition: def });
  const reply = await service.execute({ action: 'workflows.start', definitionId: def.id, inputs: { x: 'b' }, concurrency: 1 });
  assert.equal(reply.ok, true);
  await assert.rejects(service.drain(), /uncertain/);
  const run = service.get(reply.view!.workflowRunId)!;
  assert.equal(run.status, 'needs-attention');
  assert.equal(run.cleanupSettled, false);
  const saved = c.read().extensions.workflows as unknown as { runs: WorkflowRun[] };
  assert.equal(saved.runs[0].recovery!.operations.length, 1);
  assert.equal(saved.runs[0].recovery!.operations[0].result, undefined);
  assert.equal(events.filter(e => e === 'effect').length, 1);
  assert.equal(faults, 1);
  const next = await service.execute({ action: 'workflows.start', definitionId: def.id, inputs: { x: 'next' } });
  assert.equal(next.ok, false);
  assert.equal(faults, 1);
  service.dispose();
});

test('intent save failure admits no native execution', async () => {
  const c = container(), update = c.update.bind(c), events: string[] = [];
  c.update = (patch, options) => {
    const value = typeof patch === 'function' ? patch(c.read()) : patch;
    const ledger = value.extensions?.workflows as { runs?: WorkflowRun[] } | undefined;
    if (ledger?.runs?.some(run => run.recovery?.operations.length)) throw new Error('intent save failed');
    return update(value, options);
  };
  const service = createWorkflowService(c, okPort(events), { recovery: recovery(events) });
  await service.execute({ action: 'workflows.define', definition: def });
  await service.execute({ action: 'workflows.start', definitionId: def.id, inputs: { x: 'never' } });
  await service.drain().catch(() => {});
  assert.equal(events.filter(e => e === 'effect').length, 0);
  const saved = c.read().extensions.workflows as unknown as { runs: WorkflowRun[] };
  assert(saved.runs.every(run => !run.recovery?.operations.length));
  service.dispose();
});

test('native checkpoint has no mutating fake pre/post/generation receipts', () => {
  const r = sampleRun();
  assert.equal(r.admissions, r.recovery!.budget.usedAdmissions);
  assert.equal(new Set(r.recovery!.operations.map(o => o.unitId)).size, 1);
  assert(r.recovery!.operations.every(o => o.kind === 'native' && o.generation === undefined && o.preimage === null && o.postimage === null && o.paths.length === 0));
});

test('recovery-enabled coding definitions are blocked before native/coding effects', async () => {
  const codingDef = { ...def, id: 'blocked-v3', version: 3 as const, steps: [{ id: 'code', kind: 'coding' as const, dependsOn: [], inputs: { x: { ref: { source: 'inputs' as const, path: ['x'] } } }, outputSchema: stringSchema, coding: { operation: 'investigate' as const, policy: { identity: { rootAgentId: 'worker', workerAgentId: 'worker', parentRunId: 'parent', taskId: 'task', workflowRunId: 'template', attemptNo: 1, model: 'fake/model' }, capabilities: ['investigate'], scope: { task: 'read', writablePaths: ['src/a.ts'] }, bounds: { maxFiles: 1, maxBytes: 1000, maxOutputBytes: 1000, maxIterations: 1 } } } }] };
  const events: string[] = [];
  const service = createWorkflowService(container(), okPort(events), { recovery: recovery(events), coding: { enabled: true, projectRoot: '.', stagingParent: '.stage' } });
  await service.execute({ action: 'workflows.define', definition: codingDef as unknown as WorkflowDefinition });
  const reply = await service.execute({ action: 'workflows.start', definitionId: 'blocked-v3', inputs: { x: 'a' }, concurrency: 1 });
  assert.equal(reply.ok, false);
  assert(!events.includes('effect'));
  service.dispose();
});

test('admissions budget does not duplicate or reset across recovery checkpoint and retry carry', () => {
  const r = sampleRun();
  assert.equal(r.admissions, 1);
  assert.equal(r.recovery!.budget.usedAdmissions, 1);
  assert.deepEqual(r.recovery!.budget.attemptIds, [r.workflowRunId]);
});

test('strict backward raw validation binds run fields and unchanged input hashes', () => {
  const r = sampleRun();
  const ledger = { version: 1, definitions: [r.definition], runs: [r] };
  assert.doesNotThrow(() => recoverWorkflowState(ledger));
  const bad = structuredClone(r) as WorkflowRun;
  bad.recovery = { ...bad.recovery!, inputsHash: '0'.repeat(64) };
  assert.throws(() => recoverWorkflowState({ version: 1, definitions: [bad.definition], runs: [bad] }), /recovery|binding|Invalid/i);
});

test('cancellation after recovery intent remains readonly/no replay on recovery', () => {
  const r = sampleRun('running');
  r.steps[0].units[0].status = 'running'; r.steps[0].status = 'running'; r.cleanupSettled = false;
  const recovered = recoverWorkflowState({ version: 1, definitions: [r.definition], runs: [r] });
  assert.equal(recovered.runs[0].status, 'needs-attention');
  assert.equal(recovered.runs[0].steps[0].units[0].status, 'unverified');
});


test('restored service does not execute recovered queued/running native work', async () => {
  const events: string[] = [];
  const r = sampleRun('running');
  const c = createClankersStateContainer({ agentDefinitions: { worker: agent }, extensions: { workflows: { version: 1, definitions: [r.definition], runs: [r] } } });
  const service = createWorkflowService(c, okPort(events), { recovery: recovery(events) });
  assert.equal(service.get('run1')!.status, 'needs-attention');
  await Promise.resolve();
  assert(!events.includes('effect'));
  service.dispose();
});

test('ordinary legacy v3 without recovery remains accepted', async () => {
  const legacy = { ...def, id: 'legacy-v3', version: 3 as const };
  const service = createWorkflowService(container(), okPort([]));
  const defined = await service.execute({ action: 'workflows.define', definition: legacy });
  assert.equal(defined.ok, true);
  service.dispose();
});

test('malformed recovery header is rejected while legacy run without recovery is compatible', () => {
  const r = sampleRun();
  const legacy = structuredClone(r) as WorkflowRun;
  delete legacy.recovery;
  assert.doesNotThrow(() => recoverWorkflowState({ version: 1, definitions: [legacy.definition], runs: [legacy] }));
  const bad = structuredClone(r) as WorkflowRun;
  bad.recovery = { ...bad.recovery!, workflowRunId: 'other' };
  assert.throws(() => recoverWorkflowState({ version: 1, definitions: [bad.definition], runs: [bad] }), /recovery|binding|Invalid/i);
});

function sampleRun(status: WorkflowRun['status'] = 'completed'): WorkflowRun {
  const inputs = { x: 'a' };
  const run: WorkflowRun = { workflowRunId: 'run1', familyId: 'run1', attemptNo: 1, definition: def, definitionHash: workflowHash(def), inputs, agents: { worker: agent }, concurrency: 1, status, createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:01.000Z', admissions: 1, cleanupSettled: status === 'completed', recovered: false, steps: [{ id: 'work', status: status === 'completed' ? 'completed' : 'running', units: [{ id: 'work:0', stepId: 'work', index: 0, status: status === 'completed' ? 'completed' : 'running', inputHash: '', inputs: { x: 'a' }, cleanupSettled: status === 'completed', ...(status === 'completed' ? { native: { runId: 'native', taskId: 'task' }, result: 'ok' } : {}) }], ...(status === 'completed' ? { output: 'ok' } : {}) }], ...(status === 'completed' ? { report: 'ok' } : {}) };
  run.steps[0].units[0].inputHash = workflowUnitHash(run, def.steps[0], run.steps[0].units[0].inputs);
  const trustedRecoveryConfig = { enabled: true, durablePort: 'ensureWriter/inspectOwner:v1', sourceContract: { knownHash: null, explicitUnknown: true } }; const dependencyHash = workflowHash({ version: 1, unit: { id: 'work:0', index: 0, inputHash: run.steps[0].units[0].inputHash, inputs: run.steps[0].units[0].inputs, unitHash: workflowUnitHash(run, def.steps[0], run.steps[0].units[0].inputs) }, qualifiedStep: { id: 'work', kind: 'native', dependsOn: [], iterationId: null }, priorIteration: null, dependencies: {}, hostSourceContract: { knownHash: null, explicitUnknown: true } }); const nativePolicyHash = workflowHash({ kind: 'native', agent, prompt: def.steps[0].prompt, outputSchema: def.steps[0].outputSchema, hostSourceContract: { knownHash: null, explicitUnknown: true } }); run.recovery = { version: 1, sequence: status === 'completed' ? 2 : 1, workflowRunId: run.workflowRunId, familyId: run.familyId, attemptNo: 1, definitionHash: run.definitionHash, inputsHash: workflowHash(run.inputs), policyHash: workflowHash({ definition: run.definition, agents: run.agents, trustedRecoveryConfig }), configurationHash: workflowHash({ concurrency: run.concurrency, trustedRecoveryConfig }), budget: { maxAttempts: 3, maxAdmissions: 256, usedAdmissions: 1, attemptIds: [run.workflowRunId], correctionsUsed: 0 }, operations: [{ kind: 'native', id: 'op1', sequence: 0, stepId: 'work', unitId: 'work:0', inputHash: run.steps[0].units[0].inputHash, dependencyHash, policyHash: nativePolicyHash, paths: [], preimage: null, postimage: null, intent: { recordedAt: '2026-10-05T00:00:00.000Z' }, ...(status === 'completed' ? { result: { recordedAt: '2026-10-05T00:00:01.000Z', status: 'completed', cleanup: 'settled', evidenceHash: workflowHash({ identity: { runId: 'native', taskId: 'task' }, result: { hash: workflowHash('ok') } }), resultHash: workflowHash({ identity: { runId: 'native', taskId: 'task' }, result: { hash: workflowHash('ok') } }) } } : {}) }] };
  return run;
}

test('recovery dependency hash ignores unrelated parallel outputs', () => {
  const dagDef: WorkflowDefinition = { ...def, id: 'dag', steps: [
    { ...def.steps[0], id: 'a', dependsOn: [] },
    { ...def.steps[0], id: 'b', dependsOn: [] },
    { ...def.steps[0], id: 'c', dependsOn: ['a'] },
  ] };
  const inputs = { x: 'a' };
  const run: WorkflowRun = { workflowRunId: 'dag-run', familyId: 'dag-run', attemptNo: 1, definition: dagDef, definitionHash: workflowHash(dagDef), inputs, agents: { worker: agent }, concurrency: 2, status: 'running', createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z', admissions: 3, cleanupSettled: false, recovered: false, steps: dagDef.steps.map(s => ({ id: s.id, status: 'completed' as const, units: [{ id: `${s.id}:0`, stepId: s.id, index: 0, status: 'completed' as const, inputHash: '', inputs: { x: 'a' }, result: `${s.id}-out`, native: { runId: `n-${s.id}`, taskId: `t-${s.id}` }, cleanupSettled: true }], output: `${s.id}-out` })) };
  for (const [i, spec] of dagDef.steps.entries()) run.steps[i].units[0].inputHash = workflowUnitHash(run, spec, run.steps[i].units[0].inputs);
  const unit = run.steps[2].units[0];
  const before = workflowRecoveryDependencyHash(run, dagDef.steps[2], unit, workflowRecoverySourceContract());
  run.steps[1].output = 'b-completed-later';
  run.steps[1].units[0].result = 'b-completed-later';
  assert.equal(workflowRecoveryDependencyHash(run, dagDef.steps[2], unit, workflowRecoverySourceContract()), before);
});

test('recovered attempts cannot bypass fresh recovery authorization through retry', async () => {
  const r = sampleRun('failed');
  r.status = 'failed'; r.cleanupSettled = true;
  r.steps[0].status = 'failed'; r.steps[0].units[0].status = 'failed'; r.steps[0].units[0].cleanupSettled = true;
  r.recovery!.budget.correctionsUsed = 7;
  const c = container();
  c.update({ extensions: { workflows: { version: 1, definitions: [r.definition], runs: [r] } } });
  const events: string[] = [];
  const service = createWorkflowService(c, okPort(events), { recovery: recovery(events) });
  const reply = await service.execute({ action: 'workflows.retry', workflowRunId: r.workflowRunId });
  assert.equal(reply.ok, false);
  assert.match(reply.error ?? '', /fresh trusted recovery authorization/);
  assert.equal(service.get(r.workflowRunId)!.recovery!.budget.correctionsUsed, 7);
  assert(!events.includes('effect'));
  service.dispose();
});

test('owner inspection generation is required before native admission', async () => {
  const events: string[] = [];
  const badRecovery = recovery(events);
  badRecovery.durablePort.inspectOwner = () => ({ snapshotFile: 'snapshot.json', lockDir: 'lock', claimDir: 'claim', expectedSnapshotHash: '0'.repeat(64), owner: { ...owner, generation: 'gen-2' }, ownerValid: true, claimPresent: false });
  const service = createWorkflowService(container(), okPort(events), { recovery: badRecovery });
  await service.execute({ action: 'workflows.define', definition: def });
  const reply = await service.execute({ action: 'workflows.start', definitionId: def.id, inputs: { x: 'own' }, concurrency: 1 });
  assert.equal(reply.ok, false);
  assert(!events.includes('effect'));
  service.dispose();
});
