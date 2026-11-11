import assert from 'node:assert/strict';
import test from 'node:test';
import { createClankersStateContainer } from '../state.js';
import { createWorkflowService, recoverWorkflowState } from '../workflow-runtime.js';
import { workflowHash } from '../workflow-model.js';
import type { WorkflowDefinition, WorkflowJson, WorkflowNativeOutcome, WorkflowNativePort, WorkflowNativeRequest, WorkflowRun, WorkflowSchema, WorkflowService } from '../workflow-model.js';

const outputSchema: WorkflowSchema = { type: 'string', maxLength: 100 };
function definition(fanout = 4): WorkflowDefinition { return { id: 'simple', version: 1, label: 'Simple', inputSchema: { type: 'array', maxItems: fanout, items: outputSchema }, steps: [
  { id: 'work', kind: 'native', dependsOn: [], agentId: 'reviewer', prompt: 'Read only; no data authority', outputSchema,
    inputs: { item: { ref: { source: 'item', path: [] } } }, fanout: { from: { source: 'inputs', path: [] }, maxItems: fanout } },
  { id: 'collect', kind: 'aggregate', operation: 'collect', consumeFailures: true, dependsOn: ['work'], inputs: { results: { ref: { source: 'step', stepId: 'work', path: [] } } } },
] }; }
function fakePort() {
  const requests: WorkflowNativeRequest[] = [], finish: Array<(outcome: WorkflowNativeOutcome) => void> = [];
  const port: WorkflowNativePort = { preflight(agent) { assert.equal(agent.model, 'fake/model'); assert.deepEqual(agent.tools, ['read']); }, execute(request) {
    requests.push(request); request.assertAdmission(); const identity = { runId: `native-${requests.length}`, taskId: `task-${requests.length}` }; request.onIdentity(identity);
    return new Promise(resolve => finish.push(outcome => resolve({ ...outcome, identity })));
  } };
  return { port, requests, finish, done(index: number, text = '"ok"', status: WorkflowNativeOutcome['status'] = 'completed', cleanupSettled = true) { finish[index]({ status, text, cleanupSettled }); } };
}
function harness(fanout = 4) {
  const container = createClankersStateContainer({ agentDefinitions: { reviewer: { id: 'reviewer', label: 'Reviewer', source: 'builtin', prompt: 'Readonly', model: 'fake/model', tools: ['read'], permissionMode: 'inherit' } } });
  const fake = fakePort(); let seq = 0;
  const service = createWorkflowService(container, fake.port, { idFactory: () => `workflow-${++seq}`, now: () => new Date('2026-10-04T00:00:00.000Z') });
  return { container, fake, service, def: definition(fanout) };
}
async function turns(n = 6) { for (let i = 0; i < n; i++) await Promise.resolve(); }
async function start(h: ReturnType<typeof harness>, inputs: WorkflowJson = ['a', 'b', 'c', 'd'], concurrency = 2) {
  assert.equal((await h.service.execute({ action: 'workflows.define', definition: h.def })).ok, true);
  const reply = await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs, concurrency }); assert.equal(reply.ok, true, reply.error); await turns(); return reply.view!.workflowRunId;
}
function run(service: WorkflowService, id: string): WorkflowRun { const value = service.get(id); assert(value); return value; }

test('shared scheduler holds permits across concurrent promises and cleanup settlement', async () => {
  const h = harness(), id = await start(h); assert.equal(h.fake.requests.length, 2); assert.equal(run(h.service, id).status, 'running');
  h.fake.done(0); await turns(); assert.equal(h.fake.requests.length, 3);
  h.fake.done(1); await turns(); assert.equal(h.fake.requests.length, 4);
  h.fake.done(2); h.fake.done(3); await h.service.drain(); assert.equal(run(h.service, id).status, 'completed'); assert.equal(run(h.service, id).cleanupSettled, true);
  assert.equal(run(h.service, id).admissions, 4); h.service.dispose();
});

test('concurrency is workflow-wide across multiple runs', async () => {
  const h = harness(); const one = await start(h, ['a', 'b', 'c'], 2);
  const two = await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: ['d', 'e'], concurrency: 2 }); await turns(); assert(two.ok);
  assert.equal(h.fake.requests.length, 2); h.fake.done(0); h.fake.done(1); await turns(); assert.equal(h.fake.requests.length, 4);
  h.fake.done(2); h.fake.done(3); await turns(); assert.equal(h.fake.requests.length, 5); h.fake.done(4); await h.service.drain();
  assert.equal(run(h.service, one).status, 'completed'); assert.equal(run(h.service, two.view!.workflowRunId).status, 'completed'); h.service.dispose();
});

test('empty fanout completes explicit zero-unit output without native startup', async () => {
  const h = harness(), id = await start(h, []); await h.service.drain(); assert.equal(h.fake.requests.length, 0); assert.equal(run(h.service, id).status, 'completed'); assert.deepEqual(run(h.service, id).steps[0].output, []); h.service.dispose();
});

test('pause closes admission synchronously, admitted work finishes and resume continues', async () => {
  const h = harness(), id = await start(h); assert.equal((await h.service.execute({ action: 'workflows.pause', workflowRunId: id })).ok, true);
  h.fake.done(0); h.fake.done(1); await turns(); assert.equal(h.fake.requests.length, 2); assert.equal(run(h.service, id).status, 'paused');
  assert.equal((await h.service.execute({ action: 'workflows.resume', workflowRunId: id })).ok, true); await turns(); assert.equal(h.fake.requests.length, 4);
  h.fake.done(2); h.fake.done(3); await h.service.drain(); assert.equal(run(h.service, id).status, 'completed'); h.service.dispose();
});

test('cancel is prompt but terminal/retry wait for native-owned cleanup, even after readonly flips', async () => {
  const h = harness(), id = await start(h); h.container.update({ mode: { ...h.container.read().mode, readOnly: true } });
  assert.equal((await h.service.execute({ action: 'workflows.cancel', workflowRunId: id })).ok, true);
  assert(h.fake.requests.every(r => r.signal.aborted)); assert.equal(run(h.service, id).status, 'cancelling'); assert.equal(run(h.service, id).cleanupSettled, false);
  assert.equal((await h.service.execute({ action: 'workflows.retry', workflowRunId: id })).ok, false);
  h.fake.done(0); h.fake.done(1); await h.service.drain(); assert.equal(run(h.service, id).status, 'cancelled'); assert.equal(h.fake.requests.length, 2); h.service.dispose();
});

test('cancel of paused queued work settles honestly without requiring another launch', async () => {
  const h = harness(), id = await start(h); await h.service.execute({ action: 'workflows.pause', workflowRunId: id }); h.fake.done(0); h.fake.done(1); await h.service.drain();
  await h.service.execute({ action: 'workflows.cancel', workflowRunId: id }); await h.service.drain(); assert.equal(run(h.service, id).status, 'cancelled'); assert.equal(run(h.service, id).cleanupSettled, true); h.service.dispose();
});

test('reentrant pause in admission publication prevents not-yet-committed port startup', async () => {
  const h = harness(); let hit = false;
  h.container.subscribe?.(state => { const ledger = state.extensions.workflows as unknown as { runs: WorkflowRun[] } | undefined;
    const selected = ledger?.runs.find(r => r.steps.some(s => s.units.some(u => u.status === 'running')));
    if (selected && !hit) { hit = true; void h.service.execute({ action: 'workflows.pause', workflowRunId: selected.workflowRunId }); }
  });
  const id = await start(h); assert.equal(hit, true); assert.equal(h.fake.requests.length, 0); assert.equal(run(h.service, id).status, 'paused');
  await h.service.execute({ action: 'workflows.cancel', workflowRunId: id }); await h.service.drain(); assert.equal(run(h.service, id).status, 'cancelled'); h.service.dispose();
});

test('reentrant cancel in publication before port execute is settled, not fabricated cleanup uncertainty', async () => {
  const h = harness(); let hit = false;
  h.service.subscribe(views => { const selected = views.find(v => v.counts.running > 0); if (selected && !hit) { hit = true; void h.service.execute({ action: 'workflows.cancel', workflowRunId: selected.workflowRunId }); } });
  const id = await start(h); await h.service.drain(); assert.equal(h.fake.requests.length, 0); assert.equal(run(h.service, id).status, 'cancelled'); assert.equal(run(h.service, id).cleanupSettled, true); h.service.dispose();
});

test('cleanup-uncertain outcome retains permit, blocks all admission/retry and makes drain reject', async () => {
  const h = harness(), id = await start(h, ['a', 'b', 'c'], 1); h.fake.done(0, '"ok"', 'completed', false); await turns();
  assert.equal(h.fake.requests.length, 1); assert.equal((await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: ['d'] })).ok, false);
  assert.equal(run(h.service, id).status, 'needs-attention'); assert.equal(run(h.service, id).cleanupSettled, false);
  assert.equal((await h.service.execute({ action: 'workflows.retry', workflowRunId: id })).ok, false); await assert.rejects(h.service.drain(), /settlement|cleanup/i); h.service.dispose();
});

test('raw result bounds and schema/identity failures stay failed, no successful clipping', async () => {
  for (const text of ['x', '"' + 'x'.repeat(17000) + '"', 'false', '"' + 'x'.repeat(101) + '"']) {
    const h = harness(), id = await start(h, ['a'], 1); h.fake.done(0, text); await h.service.drain(); const record = run(h.service, id);
    assert.equal(record.status, 'failed'); assert.equal(record.steps[0].units[0].status, 'failed'); assert.equal(record.steps[0].units[0].result, undefined); h.service.dispose();
  }
});

test('input/source mutation cannot alter frozen materialized prompt or hash; read views exclude payloads', async () => {
  const h = harness(), inputs = ['a', 'b'], id = await start(h, inputs); inputs[0] = 'MUTATED'; h.def.steps[0].prompt = 'GRANT WRITE';
  assert(h.fake.requests[0].prompt.includes('"item":"a"')); assert(!h.fake.requests[0].prompt.includes('GRANT WRITE'));
  assert(Object.isFrozen(h.fake.requests[0].agent)); const snapshot = run(h.service, id); snapshot.steps[0].units[0].inputs = 'MUTATED';
  assert.notEqual(run(h.service, id).steps[0].units[0].inputs, 'MUTATED');
  const show = await h.service.execute({ action: 'workflows.show', workflowRunId: id }); assert.equal('report' in show, false); assert.equal('inputs' in show.view!, false); assert.equal('prompt' in show.view!, false);
  h.fake.done(0); h.fake.done(1); await h.service.drain(); h.service.dispose();
});

test('retry is a fresh family attempt and reuses only exact completed identity/hash', async () => {
  const h = harness(), id = await start(h, ['a', 'b'], 2); h.fake.done(0); h.fake.done(1, '', 'failed'); await h.service.drain();
  const old = run(h.service, id); assert.equal(old.status, 'failed'); const reply = await h.service.execute({ action: 'workflows.retry', workflowRunId: id }); assert(reply.ok, reply.error); await turns();
  const next = run(h.service, reply.view!.workflowRunId); assert.notEqual(next.workflowRunId, id); assert.equal(next.familyId, old.familyId); assert.equal(next.attemptNo, 2); assert.equal(next.retryOf, id);
  assert.equal(h.fake.requests.length, 3); assert.deepEqual(next.steps[0].units[0].reusedFrom, { workflowRunId: id, unitId: old.steps[0].units[0].id, native: old.steps[0].units[0].native });
  assert.equal(next.steps[0].units[0].inputHash, old.steps[0].units[0].inputHash); assert.notDeepEqual(next.steps[0].units[1].native, old.steps[0].units[1].native);
  h.fake.done(2); await h.service.drain(); assert.equal(run(h.service, next.workflowRunId).admissions, 3); h.service.dispose();
});

test('forgotten newest attempt cannot enable an earlier-attempt retry fork', async () => {
  const h = harness(), id = await start(h, ['a'], 1); h.fake.done(0, '', 'failed'); await h.service.drain();
  const second = await h.service.execute({ action: 'workflows.retry', workflowRunId: id }); await turns(); h.fake.done(1, '', 'failed'); await h.service.drain();
  assert.equal((await h.service.execute({ action: 'workflows.forget', workflowRunId: second.view!.workflowRunId })).ok, true);
  assert.equal((await h.service.execute({ action: 'workflows.retry', workflowRunId: id })).ok, false); h.service.dispose();
});

test('retry rejects changed inputs or current named definitions and agent policy drift', async () => {
  const h = harness(), id = await start(h, ['a'], 1); h.fake.done(0, '', 'failed'); await h.service.drain();
  assert.equal((await h.service.execute({ action: 'workflows.retry', workflowRunId: id, inputs: ['different'] } as never)).ok, false);
  const changed = definition(); changed.steps[0].prompt = 'Different'; await h.service.execute({ action: 'workflows.define', definition: changed }); assert.equal((await h.service.execute({ action: 'workflows.retry', workflowRunId: id })).ok, false); h.service.dispose();
});

test('policy drift after publication blocks port/provider admission without invalidating unrelated logs', async () => {
  const h = harness(), id = await start(h, ['a', 'b'], 1); const request = h.fake.requests[0];
  h.container.update({ agentDefinitions: { ...h.container.read().agentDefinitions, reviewer: { ...request.agent, tools: ['write'] } } });
  assert.throws(() => request.assertAdmission(), /policy changed/); h.fake.done(0); await h.service.drain(); assert.equal(h.fake.requests.length, 1); assert.equal(run(h.service, id).status, 'paused');
  await h.service.execute({ action: 'workflows.cancel', workflowRunId: id }); await h.service.drain(); h.service.dispose();
});

test('recovery is nonexecuting and unreconnected running work cannot resume/retry/forget', async () => {
  const h = harness(), id = await start(h, ['a'], 1); const ledger = h.container.read().extensions.workflows;
  const recovered = recoverWorkflowState(ledger); assert.equal(recovered.runs[0].status, 'needs-attention'); assert.equal(recovered.runs[0].steps[0].units[0].status, 'unverified'); assert.equal(recovered.runs[0].cleanupSettled, false);
  const other = createClankersStateContainer(h.container.snapshot()); const newService = createWorkflowService(other, h.fake.port); await turns(); assert.equal(h.fake.requests.length, 1);
  for (const action of ['workflows.resume', 'workflows.retry', 'workflows.forget'] as const) assert.equal((await newService.execute({ action, workflowRunId: id })).ok, false);
  h.fake.done(0); await h.service.drain(); h.service.dispose(); newService.dispose();
});

test('old completions after disposal/recreation cannot overwrite recovered owner ledger', async () => {
  const h = harness(), id = await start(h, ['a'], 1); h.service.dispose(); const newService = createWorkflowService(h.container, h.fake.port);
  const before = workflowHash(h.container.read().extensions.workflows); h.fake.done(0); await h.service.drain(); await turns(); assert.equal(workflowHash(h.container.read().extensions.workflows), before);
  assert.equal(run(newService, id).status, 'needs-attention'); newService.dispose();
});

test('corrupt/oversized recovery fails closed without replacing historical namespace', () => {
  for (const ledger of [{ version: 2, definitions: [], runs: [] }, { version: 1, definitions: [], runs: ['wrong'] }, { version: 1, definitions: [], runs: [], raw: 'x'.repeat(2100000) }]) {
    const container = createClankersStateContainer({ extensions: { workflows: ledger } }); const before = JSON.stringify(container.read().extensions.workflows);
    assert.throws(() => createWorkflowService(container, fakePort().port)); assert.equal(JSON.stringify(container.read().extensions.workflows), before);
  }
});

test('invalid action/schema/input/concurrency and pre-aborted caller cause zero native startup', async () => {
  const h = harness(); await h.service.execute({ action: 'workflows.define', definition: h.def });
  for (const concurrency of [0, 33, 1.5, NaN]) assert.equal((await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: [], concurrency })).ok, false);
  const aborted = new AbortController(); aborted.abort(); assert.equal((await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: [] }, aborted.signal)).ok, false);
  assert.equal((await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: ['x'.repeat(101)] })).ok, false);
  assert.equal((await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: [], permissions: 'write' } as never)).ok, false);
  assert.equal(h.fake.requests.length, 0); h.service.dispose(); h.service.dispose(); await h.service.drain();
});

test('action getters never execute and unknown cleanup recovery closes all new admissions', async () => {
  const h = harness(); let calls = 0;
  const hostile = Object.defineProperty({}, 'action', { enumerable: true, get() { calls++; return 'workflows.start'; } });
  assert.equal((await h.service.execute(hostile as never)).ok, false); assert.equal(calls, 0);
  const id = await start(h, ['a'], 1); const other = createClankersStateContainer(h.container.snapshot());
  const recovered = createWorkflowService(other, h.fake.port);
  assert.equal((await recovered.execute({ action: 'workflows.start', definitionId: 'simple', inputs: ['b'] })).ok, false);
  assert.equal(run(recovered, id).status, 'needs-attention'); await assert.rejects(recovered.drain(), /cleanup/);
  recovered.dispose(); h.fake.done(0); await h.service.drain(); h.service.dispose();
});

test('three explicit attempts are finite, never automatic, and retain cumulative admission budget', async () => {
  const h = harness(); let id = await start(h, ['a'], 1);
  for (let attempt = 1; attempt <= 3; attempt++) {
    h.fake.done(attempt - 1, '', 'failed'); await h.service.drain(); assert.equal(h.fake.requests.length, attempt);
    assert.equal(run(h.service, id).admissions, attempt); const retry = await h.service.execute({ action: 'workflows.retry', workflowRunId: id });
    if (attempt === 3) assert.equal(retry.ok, false);
    else { assert(retry.ok, retry.error); id = retry.view!.workflowRunId; await turns(); }
  }
  h.service.dispose();
});

test('sixteen retained runs are bounded and forget deletes no native history', async () => {
  const h = harness(); const first = await start(h, [], 1); await h.service.drain();
  for (let i = 1; i < 16; i++) { assert.equal((await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: [] })).ok, true); await h.service.drain(); }
  assert.equal((await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: [] })).ok, false);
  assert.equal(h.service.list().length, 16); assert.equal(h.fake.requests.length, 0);
  h.container.update({ extensions: { ...h.container.read().extensions, unrelatedNativeHistory: { sentinel: true } } });
  assert.equal((await h.service.execute({ action: 'workflows.forget', workflowRunId: first })).ok, true);
  assert.deepEqual(h.container.read().extensions.unrelatedNativeHistory, { sentinel: true }); h.service.dispose();
});

async function presetHarness() {
  const h = harness(); const reviewer = h.container.read().agentDefinitions.reviewer;
  h.container.update({ agentDefinitions: { ...h.container.read().agentDefinitions, generalist: { ...reviewer, id: 'generalist' } } });
  const reply = await h.service.execute({ action: 'workflows.start', definitionId: 'read-only-review', inputs: { candidatePaths: ['a.ts', 'b.ts'], scope: 'Read only evidence' }, concurrency: 2 });
  assert(reply.ok, reply.error); await turns(); return { ...h, id: reply.view!.workflowRunId };
}

test('failed discovery produces explicit partial final coverage, not successful empty report', async () => {
  const h = await presetHarness(); h.fake.done(0, '', 'failed'); await h.service.drain();
  const record = run(h.service, h.id); assert.equal(record.status, 'failed'); assert.equal(h.fake.requests.length, 1);
  assert(record.report && typeof record.report === 'object'); const report = record.report as Record<string, WorkflowJson>;
  assert.equal(report.partial, true); assert((report.workerFailures as WorkflowJson[]).length >= 1);
  assert.deepEqual((report.coverage as Record<string, WorkflowJson>).candidates, ['a.ts', 'b.ts']); h.service.dispose();
});

test('preset retains failed review and verifier coverage with exact original native IDs', async () => {
  const h = await presetHarness(); h.fake.done(0, JSON.stringify({ targets: ['a.ts', 'b.ts'] })); await turns();
  assert.equal(h.fake.requests.length, 3);
  h.fake.done(1, JSON.stringify({ findings: [{ id: 'local', title: 'Issue', path: 'a.ts', line: 1, severity: 'high', detail: 'Evidence' }] })); h.fake.done(2, '', 'failed'); await turns(12);
  assert.equal(h.fake.requests.length, 4); h.fake.done(3, '', 'failed'); await h.service.drain();
  const record = run(h.service, h.id), report = record.report as Record<string, WorkflowJson>;
  assert.equal(record.status, 'failed'); assert.equal(report.partial, true); assert.equal((report.unverified as WorkflowJson[]).length, 1);
  assert.equal((report.workerFailures as WorkflowJson[]).length, 2);
  const serialized = JSON.stringify(report); assert(serialized.includes('native-2')); assert(serialized.includes('native-3')); assert(serialized.includes('native-4')); h.service.dispose();
});

test('out-of-scope discovery is failed before any review admission', async () => {
  const h = await presetHarness(); h.fake.done(0, JSON.stringify({ targets: ['outside.ts'] })); await h.service.drain();
  assert.equal(h.fake.requests.length, 1); assert.equal(run(h.service, h.id).status, 'failed'); assert.match(run(h.service, h.id).steps[0].units[0].error!, /caller candidate scope/); h.service.dispose();
});

test('malformed port outcomes cannot resolve a cleanup barrier or free ownership', async () => {
  const h = harness(); h.service.dispose();
  const malformed: WorkflowNativePort = { preflight() {}, execute: async () => null as never };
  const service = createWorkflowService(h.container, malformed);
  await service.execute({ action: 'workflows.define', definition: h.def }); const reply = await service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: ['a'], concurrency: 1 });
  await turns(12); assert.equal(run(service, reply.view!.workflowRunId).status, 'needs-attention');
  await assert.rejects(service.drain(), /cleanup/); assert.equal((await service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: ['b'] })).ok, false); service.dispose();
});

test('recovery rejects changed materialized hashes without replacing raw ledger', async () => {
  const h = harness(), id = await start(h, ['a'], 1); h.fake.done(0); await h.service.drain();
  const ledger = h.container.read().extensions.workflows as unknown as { runs: WorkflowRun[] };
  ledger.runs[0].steps[0].units[0].inputs = { item: 'CHANGED' };
  assert.throws(() => recoverWorkflowState(ledger), /hash mismatch/);
  assert.equal(run(h.service, id).status, 'completed'); h.service.dispose();
});

test('immediate pause between reservation and invocation retains queued live work until explicit resume', async () => {
  const h = harness(); await h.service.execute({ action: 'workflows.define', definition: h.def });
  const reply = await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: ['a'], concurrency: 1 }); const id = reply.view!.workflowRunId;
  assert.equal((await h.service.execute({ action: 'workflows.pause', workflowRunId: id })).ok, true); await turns();
  assert.equal(h.fake.requests.length, 0); assert.equal(run(h.service, id).status, 'paused'); assert.equal(run(h.service, id).steps[0].units[0].status, 'queued');
  assert.equal((await h.service.execute({ action: 'workflows.resume', workflowRunId: id })).ok, true); await turns(); assert.equal(h.fake.requests.length, 1);
  h.fake.done(0); await h.service.drain(); assert.equal(run(h.service, id).status, 'completed'); h.service.dispose();
});

test('dispose after ledger ownership loss still aborts every owned handle and never overwrites replacement', async () => {
  const h = harness(); await h.service.execute({ action: 'workflows.define', definition: h.def });
  const one = await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: ['a'], concurrency: 2 }); await turns();
  const two = await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: ['b'], concurrency: 2 }); await turns(); assert(one.ok && two.ok); assert.equal(h.fake.requests.length, 2);
  const replacement = { sentinel: 'NEW WORKFLOW OWNER' }; h.container.update({ extensions: { ...h.container.read().extensions, workflows: replacement } });
  assert.doesNotThrow(() => h.service.dispose()); assert(h.fake.requests.every(r => r.signal.aborted)); assert.doesNotThrow(() => h.service.dispose());
  h.fake.done(0); h.fake.done(1); await h.service.drain(); assert.deepEqual(h.container.read().extensions.workflows, replacement);
});

test('list/show/define responses contain definition summaries, never fixed prompts or schemas', async () => {
  const h = harness(); const defined = await h.service.execute({ action: 'workflows.define', definition: h.def });
  assert.deepEqual(defined.definition, { id: 'simple', label: 'Simple', stepCount: 2 });
  const shown = await h.service.execute({ action: 'workflows.show', definitionId: 'simple' }); assert.deepEqual(shown.definition, defined.definition);
  const listed = await h.service.execute({ action: 'workflows.list' });
  for (const reply of [defined, shown, listed]) { const json = JSON.stringify(reply); assert(!json.includes('Read only; no data authority')); assert(!json.includes('outputSchema')); assert(!json.includes('inputSchema')); }
  h.service.dispose();
});


test('structured list stays compact across retained attempts while internal list and show retain exact correlations', async () => {
  const h = harness(32);
  const ids: string[] = [];
  let observed = h.service.list();
  const unsubscribe = h.service.subscribe(views => { observed = views; });
  try {
    assert.equal((await h.service.execute({ action: 'workflows.define', definition: h.def })).ok, true);
    for (let attempt = 0; attempt < 16; attempt++) {
      const size = attempt === 0 ? 1 : attempt === 15 ? 32 : 2;
      const offset = h.fake.requests.length;
      const started = await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: Array(size).fill('PRIVATE_UNIT_PAYLOAD'), concurrency: 32 });
      assert(started.ok, started.error); ids.push(started.view!.workflowRunId); await turns();
      assert.equal(h.fake.requests.length - offset, size);
      for (let index = offset; index < offset + size; index++) h.fake.done(index, '"PRIVATE_RESULT_PAYLOAD"');
      await h.service.drain();
    }
    const listed = await h.service.execute({ action: 'workflows.list' });
    assert(listed.ok, listed.error); assert.equal(listed.runs!.length, 16);
    const rich = h.service.list(); assert.deepEqual(observed, rich);
    for (const [index, summary] of listed.runs!.entries()) {
      const { correlations, ...expected } = rich[index];
      assert.deepEqual(summary, expected);
      assert.equal(Object.hasOwn(summary, 'correlations'), false);
      assert.equal(summary.workflowRunId, ids[index]); assert.equal(summary.familyId, ids[index]); assert.equal(summary.attemptNo, 1);
      assert.equal(summary.status, 'completed'); assert.equal(summary.cleanupSettled, true);
      assert.equal(summary.counts.completed, index === 0 ? 2 : index === 15 ? 33 : 3); // Includes the deterministic collect unit.
      const shown = await h.service.execute({ action: 'workflows.show', workflowRunId: ids[index] });
      assert(shown.ok, shown.error); assert.deepEqual(shown.view, rich[index]);
      assert.deepEqual(shown.view!.correlations, correlations);
      assert.deepEqual(correlations.filter(c => c.native).map(c => c.native), run(h.service, ids[index]).steps[0].units.map(u => u.native));
    }
    const json = JSON.stringify(listed);
    for (const excluded of ['correlations', 'unitId', 'stepId', 'native-', 'task-', 'reusedFrom', 'PRIVATE_UNIT_PAYLOAD', 'PRIVATE_RESULT_PAYLOAD', 'Read only; no data authority']) assert(!json.includes(excluded), excluded);
    // Increasing fanout 1 -> 32 changes counts, not the number of identity fields or rows in the tool reply.
    assert.deepEqual(Object.keys(listed.runs![0]), Object.keys(listed.runs![15]));
    assert(Math.abs(JSON.stringify(listed.runs![15]).length - JSON.stringify(listed.runs![0]).length) < 16);
    listed.runs![0].counts.completed = -1;
    assert.equal(h.service.list()[0].counts.completed, 2); // Summary mutations cannot reach the ledger/UI.
  } finally { unsubscribe(); h.service.dispose(); }
});

function repeatDef(maxIterations = 3): WorkflowDefinition {
  return { id: 'simple', version: 2, label: 'Repeat', inputSchema: { type: 'array', maxItems: 4, items: outputSchema }, steps: [{ id: 'loop', kind: 'repeat', dependsOn: [], initial: { value: 0 }, stateSchema: { type: 'integer' }, maxIterations,
    body: [{ id: 'body', kind: 'native', dependsOn: [], inputs: { state: { ref: { source: 'iteration', path: [] } }, original: { ref: { source: 'inputs', path: [] } } }, agentId: 'reviewer', prompt: 'Readonly', outputSchema: { type: 'integer' } }],
    feedback: { ref: { source: 'step', stepId: 'body', path: [] } }, until: { op: 'gte', left: { ref: { source: 'iteration', path: [] } }, right: { value: 2 } }, output: { ref: { source: 'iteration', path: [] } }, outputSchema: { type: 'integer' } }] };
}

test('v2 false branches create no units/startup; explicit skip joins retain unavailable envelope', async () => {
  const h = harness(); h.def.version = 2; h.def.steps[0].when = { op: 'boolean', value: { value: false } }; h.def.steps[1].consumeSkips = true;
  const id = await start(h); await h.service.drain(); const r = run(h.service, id);
  assert.equal(h.fake.requests.length, 0); assert.equal(r.status, 'completed'); assert.deepEqual(r.steps[0].units, []); assert.equal(r.steps[0].output, undefined); assert.equal(r.steps[0].skipReason, 'condition-false');
  assert.deepEqual(r.steps[1].output, { results: { id: 'work', status: 'skipped', skipReason: 'condition-false' } });
  const recovered = recoverWorkflowState(h.container.read().extensions.workflows); assert.deepEqual(recoverWorkflowState(recovered), recovered);
  const list = await h.service.execute({ action: 'workflows.list' }); assert(!('steps' in list.runs![0])); assert(!('correlations' in list.runs![0])); h.service.dispose();
});

test('v2 failures poison skip/failure-consuming aggregate runs and skips require explicit opt-in', async () => {
  for (const failure of [false, true]) {
    const h = harness(1); h.def.version = 2; if (!failure) h.def.steps[0].when = { op: 'boolean', value: { value: false } };
    const id = await start(h, ['a']); if (failure) h.fake.done(0, '', 'failed'); await h.service.drain();
    assert.equal(run(h.service, id).status, 'failed'); assert.equal(run(h.service, id).steps[1].status, failure ? 'completed' : 'skipped'); h.service.dispose();
  }
});

test('repeat first/later convergence and bounded nonconvergence preserve feedback and exact lineage', async () => {
  for (const values of [[2], [1, 2], [0, 0, 0]]) {
    const h = harness(); h.def = repeatDef(); const id = await start(h, ['original']);
    for (const [index, value] of values.entries()) {
      assert.equal(h.fake.requests.length, index + 1); const request = h.fake.requests[index];
      assert.equal(request.stepId, `loop@${index}/body`); assert.equal(request.unitId, `loop@${index}/body:0`); assert.equal(request.blockId, 'loop'); assert.equal(request.iterationId, `loop@${index}`); assert.equal(request.iterationNo, index + 1);
      assert(request.prompt.includes('original')); assert(request.prompt.includes(`"state":${index ? values[index - 1] : 0}`));
      h.fake.done(index, String(value)); await turns(12);
    }
    await h.service.drain(); const r = run(h.service, id), block = r.steps[0], converged = values.at(-1) === 2;
    assert.equal(r.status, converged ? 'completed' : 'failed'); assert.equal(block.output, converged ? 2 : undefined); assert.equal(block.iterations!.length, values.length);
    assert.equal(block.iterations!.at(-1)!.feedback, values.at(-1)); assert.equal(block.iterations!.at(-1)!.decision, converged);
    assert.equal(block.termination, converged ? 'converged' : 'max-iterations');
    const view = h.service.list()[0]; assert.equal(view.steps![0].maxIterations, 3); assert.equal(view.correlations.at(-1)!.iterationNo, values.length);
    const recovered = recoverWorkflowState(h.container.read().extensions.workflows); assert.deepEqual(recoverWorkflowState(recovered), recovered); h.service.dispose();
  }
});

test('repeat reentrant transition pause/cancel prevents next iteration admission', async () => {
  for (const action of ['workflows.pause', 'workflows.cancel'] as const) {
    const h = harness(); h.def = repeatDef(); let hit = false;
    h.service.subscribe(views => { const v = views[0]; if (v && !hit && h.service.get(v.workflowRunId)?.steps[0].iterations?.[0].decision === false) { hit = true; void h.service.execute({ action, workflowRunId: v.workflowRunId }); } });
    const id = await start(h); h.fake.done(0, '1'); await h.service.drain(); assert(hit); assert.equal(h.fake.requests.length, 1); assert.equal(run(h.service, id).steps[0].iterations!.length, 1);
    assert.equal(run(h.service, id).status, action === 'workflows.pause' ? 'paused' : 'cancelled');
    if (action === 'workflows.pause') { assert((await h.service.execute({ action: 'workflows.resume', workflowRunId: id })).ok); await turns(12); h.fake.done(1, '2'); await h.service.drain(); assert.equal(run(h.service, id).status, 'completed'); }
    h.service.dispose();
  }
});

test('repeat cancellation waits for running body cleanup; uncertain cleanup prevents transitions', async () => {
  for (const uncertain of [false, true]) {
    const h = harness(); h.def = repeatDef(); const id = await start(h);
    if (!uncertain) { await h.service.execute({ action: 'workflows.cancel', workflowRunId: id }); assert.equal(run(h.service, id).status, 'cancelling'); assert(h.fake.requests[0].signal.aborted); }
    h.fake.done(0, '1', 'completed', !uncertain);
    if (uncertain) await assert.rejects(h.service.drain()); else await h.service.drain();
    assert.equal(run(h.service, id).status, uncertain ? 'needs-attention' : 'cancelled'); assert.equal(h.fake.requests.length, 1); assert.equal(run(h.service, id).steps[0].iterations![0].feedback, undefined); h.service.dispose();
  }
});

test('repeat raw recovery is recursively inert, twice stable, no fresh-service replay, and rejects tamper', async () => {
  const h = harness(); h.def = repeatDef(); const id = await start(h); h.fake.done(0, '1'); await turns(12);
  const raw = JSON.parse(JSON.stringify(h.container.read().extensions.workflows));
  const recovered = recoverWorkflowState(raw); assert.equal(recovered.runs[0].status, 'needs-attention'); assert.equal(recovered.runs[0].steps[0].iterations![1].steps[0].status, 'unverified'); assert.deepEqual(recoverWorkflowState(recovered), recovered);
  const mutations: Array<(r: WorkflowRun) => void> = [
    r => { r.steps[0].iterations![1].index = 5; }, r => { r.steps[0].iterations![1].state = 8; },
    r => { r.steps[0].iterations![0].feedback = 9; }, r => { r.steps[0].iterations![0].decision = true; },
    r => { r.steps[0].iterations![0].steps[0].units[0].inputHash = '0'.repeat(64); },
    r => { r.steps[0].iterations![0].steps[0].units[0].inputs = { state: 5 }; },
    r => { r.steps[0].iterations![0].steps[0].units[0].cleanupSettled = false; },
    r => { r.steps[0].iterations![0].steps[0].id = 'body'; },
    r => { r.steps[0].iterations![0].steps[0].units[0].native = { runId: 'n', taskId: 't', unexpected: true } as never; },
    r => { r.steps[0].output = 1; },
  ];
  for (const mutate of mutations) { const value = JSON.parse(JSON.stringify(raw)); mutate(value.runs[0]); assert.throws(() => recoverWorkflowState(value)); }
  const replacement = createWorkflowService(h.container, h.fake.port); await turns(); assert.equal(h.fake.requests.length, 2); assert.equal((await replacement.execute({ action: 'workflows.resume', workflowRunId: id })).ok, false);
  h.fake.done(1, '2'); await h.service.drain(); assert.equal(replacement.get(id)!.status, 'needs-attention'); replacement.dispose(); h.service.dispose();
});

test('repeat fanout shares original scheduler permits across iterations and concurrent runs', async () => {
  const h = harness(); h.def = repeatDef(2);
  const block = h.def.steps[0], body = block.body![0];
  body.fanout = { from: { source: 'inputs', path: [] }, maxItems: 4 }; body.inputs!.item = { ref: { source: 'item', path: [] } };
  block.feedback = { value: 2 };
  const one = await start(h, ['a', 'b', 'c'], 2);
  const two = await h.service.execute({ action: 'workflows.start', definitionId: 'simple', inputs: ['x', 'y'], concurrency: 2 }); assert(two.ok); await turns();
  assert.equal(h.fake.requests.length, 2);
  h.fake.done(0, '1'); await turns(12); assert.equal(h.fake.requests.length, 3);
  h.fake.done(1, '1'); await turns(12); assert.equal(h.fake.requests.length, 4);
  h.fake.done(2, '1'); await turns(12); assert.equal(h.fake.requests.length, 5);
  h.fake.done(3, '1'); h.fake.done(4, '1'); await h.service.drain();
  assert.equal(run(h.service, one).status, 'completed'); assert.equal(run(h.service, two.view!.workflowRunId).status, 'completed'); h.service.dispose();
});

test('repeat retry reuses exact completed addresses; changed feedback invalidates downstream iteration hashes', async () => {
  const h = harness(); h.def = repeatDef();
  const id = await start(h); h.fake.done(0, '1'); await turns(12); const firstHash = h.fake.requests[1].inputHash;
  h.fake.done(1, '', 'failed'); await h.service.drain();
  const reply = await h.service.execute({ action: 'workflows.retry', workflowRunId: id }); assert(reply.ok); await turns(12);
  assert.equal(h.fake.requests.length, 3); assert.equal(h.fake.requests[2].stepId, 'loop@1/body'); assert.equal(h.fake.requests[2].inputHash, firstHash);
  const retry = run(h.service, reply.view!.workflowRunId); assert.equal(retry.steps[0].iterations![0].steps[0].units[0].reusedFrom!.unitId, 'loop@0/body:0');
  const { workflowUnitHash, qualifyWorkflowStep } = await import('../workflow-model.js');
  const unit = retry.steps[0].iterations![1].steps[0].units[0], spec = qualifyWorkflowStep(retry.definition.steps[0].body![0], 'loop@1');
  assert.equal(workflowUnitHash(retry, spec, unit.inputs), firstHash);
  retry.steps[0].iterations![0].feedback = 0;
  assert.notEqual(workflowUnitHash(retry, spec, unit.inputs), firstHash);
  h.fake.done(2, '2'); await h.service.drain();
  const recovered = recoverWorkflowState(h.container.read().extensions.workflows); assert.deepEqual(recoverWorkflowState(recovered), recovered); h.service.dispose();
});

test('repeat validates initial, feedback, until types and converged output without fabricating results', async () => {
  for (const failure of ['initial', 'feedback', 'until', 'output'] as const) {
    const h = harness(); h.def = repeatDef(); const block = h.def.steps[0];
    if (failure === 'initial') block.initial = { value: 'bad' };
    if (failure === 'feedback') block.feedback = { value: 'bad' };
    if (failure === 'until') block.until = { op: 'boolean', value: { ref: { source: 'iteration', path: [] } } };
    if (failure === 'output') block.output = { value: 'bad' };
    const defined = await h.service.execute({ action: 'workflows.define', definition: h.def }); assert.equal(defined.ok, false); assert.equal(h.fake.requests.length, 0); h.service.dispose();
  }
});

test('body reentrant reservation pause/cancel and admission callbacks retain one owned scheduler', async () => {
  for (const action of ['workflows.pause', 'workflows.cancel'] as const) {
    const h = harness(); h.def = repeatDef(); let hit = false;
    h.service.subscribe(views => { const view = views[0]; if (view && !hit && view.counts.running > 0) { hit = true; void h.service.execute({ action, workflowRunId: view.workflowRunId }); } });
    const id = await start(h); assert(hit); assert.equal(h.fake.requests.length, 0);
    if (action === 'workflows.pause') { assert.equal(run(h.service, id).status, 'paused'); await h.service.execute({ action: 'workflows.resume', workflowRunId: id }); await turns(12); h.fake.done(0, '2'); }
    await h.service.drain(); assert.equal(run(h.service, id).status, action === 'workflows.pause' ? 'completed' : 'cancelled'); h.service.dispose();
  }
});

test('step traversal pairs exact authored identities after reorder and rejects duplicate/malformed addresses', async () => {
  const h = harness(); h.def = repeatDef(); h.def.steps[0].body!.push({ id: 'other', kind: 'aggregate', operation: 'collect', dependsOn: [], inputs: {} });
  const id = await start(h); h.fake.done(0, '2'); await h.service.drain();
  const r = run(h.service, id), { workflowStepEntries } = await import('../workflow-model.js');
  r.steps[0].iterations![0].steps.reverse();
  const entries = workflowStepEntries(r); assert.equal(entries[1].spec.id, 'other'); assert.equal(entries[1].step.id, 'loop@0/other');
  r.steps[0].iterations![0].steps[0].id = 'loop@0/body'; assert.throws(() => workflowStepEntries(r)); h.service.dispose();
});

test('repeat nonconvergence explicit failure report retains feedback/provenance without verified output', async () => {
  const h = harness(); h.def = repeatDef(1);
  h.def.steps.push({ id: 'report', kind: 'aggregate', operation: 'collect', consumeFailures: true, dependsOn: ['loop'], inputs: { loop: { ref: { source: 'step', stepId: 'loop', path: [] } } } });
  const id = await start(h); h.fake.done(0, '1'); await h.service.drain(); const r = run(h.service, id);
  assert.equal(r.status, 'failed'); assert.equal(r.steps[0].output, undefined); assert.equal(r.steps[1].status, 'completed');
  assert.deepEqual((r.report as Record<string, any>).loop.diagnostic, { iterationId: 'loop@0', iterationNo: 1, feedback: 1, decision: false });
  assert.equal((r.report as Record<string, any>).loop.termination, 'max-iterations'); assert(!('result' in (r.report as Record<string, any>).loop));
  const recovered = recoverWorkflowState(h.container.read().extensions.workflows); assert.deepEqual(recoverWorkflowState(recovered), recovered); h.service.dispose();
});

test('repeat transition publication rechecks readonly and agent authority before creating the next iteration', async () => {
  for (const drift of ['readonly', 'agent']) {
    const h = harness(); h.def = repeatDef(); let hit = false;
    h.service.subscribe(views => { const view = views[0]; if (view && !hit && h.service.get(view.workflowRunId)?.steps[0].iterations?.[0].decision === false) {
      hit = true; const current = h.container.read();
      if (drift === 'readonly') h.container.update({ mode: { ...current.mode, readOnly: true } });
      else h.container.update({ agentDefinitions: { ...current.agentDefinitions, reviewer: { ...current.agentDefinitions.reviewer, prompt: 'changed' } } });
    } });
    const id = await start(h); h.fake.done(0, '1'); await h.service.drain(); assert(hit);
    assert.equal(h.fake.requests.length, 1); assert.equal(run(h.service, id).steps[0].iterations!.length, 1); assert.equal(run(h.service, id).status, 'paused'); h.service.dispose();
  }
});

test('repeat runtime validates numeric boundary refinements and optional missing until paths', async () => {
  for (const failure of ['initial', 'feedback', 'until', 'output']) {
    const h = harness(); h.def = repeatDef(); const block = h.def.steps[0];
    if (failure === 'initial') { h.def.inputSchema = { type: 'number' }; block.initial = { ref: { source: 'inputs', path: [] } }; block.body![0].inputs = {}; }
    if (failure === 'feedback') block.body![0].outputSchema = { type: 'number' };
    if (failure === 'output') { block.stateSchema = { type: 'number' }; block.body![0].outputSchema = { type: 'number' }; block.until = { op: 'gte', left: { ref: { source: 'iteration', path: [] } }, right: { value: 1 } }; }
    if (failure === 'until') {
      block.initial = { value: {} }; block.stateSchema = { type: 'object', properties: { done: { type: 'boolean' } }, additionalProperties: false }; block.feedback = { value: {} };
      block.until = { op: 'boolean', value: { ref: { source: 'iteration', path: ['done'] } } }; block.outputSchema = block.stateSchema;
    }
    const id = await start(h, failure === 'initial' ? 1.5 : []); if (failure !== 'initial') h.fake.done(0, failure === 'until' ? '1' : '1.5'); await h.service.drain();
    const r = run(h.service, id); assert.equal(r.status, 'failed'); assert.equal(r.report, undefined); assert.equal(r.steps[0].output, undefined); assert.equal(r.steps[0].termination, 'invalid-transition');
    await assertInertRecovery(h.container.read().extensions.workflows); h.service.dispose();
  }
});

test('repeat runtime ledger budget fails before admitting an oversized next fanout', async () => {
  const h = harness(); h.def = repeatDef(2); h.def.inputSchema = { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 900 } };
  const block = h.def.steps[0]; block.body![0].fanout = { from: { source: 'inputs', path: [] }, maxItems: 32 }; block.feedback = { value: 1 };
  const id = await start(h, Array(32).fill('x'.repeat(900)), 32); assert.equal(h.fake.requests.length, 32);
  for (let i = 0; i < 32; i++) h.fake.done(i, '1'); await h.service.drain();
  const r = run(h.service, id); assert.equal(r.status, 'failed'); assert.equal(h.fake.requests.length, 32); assert.equal(r.steps[0].output, undefined);
  assert(Buffer.byteLength(JSON.stringify(h.container.read().extensions.workflows)) <= 2097152); recoverWorkflowState(h.container.read().extensions.workflows); h.service.dispose();
});

async function assertInertRecovery(raw: unknown) {
  const recovered = recoverWorkflowState(raw);
  assert.deepEqual(recoverWorkflowState(recovered), recovered);
  const container = createClankersStateContainer({ extensions: { workflows: raw } } as never);
  let requests = 0;
  const service = createWorkflowService(container, { preflight() {}, async execute() { requests++; throw new Error('Recovery replay'); } });
  if (recovered.runs.some(r => !r.cleanupSettled)) await assert.rejects(service.drain(), /cleanup settlement is uncertain/);
  else await service.drain();
  await turns(); assert.equal(requests, 0);
  assert.deepEqual(service.list().map(r => r.status), recovered.runs.map(r => r.status)); service.dispose();
}
function assertRejectedRecovery(raw: unknown, pattern: RegExp) {
  assert.throws(() => recoverWorkflowState(raw), pattern);
  let requests = 0;
  const container = createClankersStateContainer({ extensions: { workflows: raw } } as never);
  assert.throws(() => createWorkflowService(container, { preflight() {}, async execute() { requests++; throw new Error('Recovery replay'); } }), pattern);
  assert.equal(requests, 0);
}

test('raw recovery requires condition and dependency evidence for completed empty fanout', async () => {
  for (const version of [1, 2] as const) for (const condition of [undefined, true, false]) {
    if (version === 1 && condition !== undefined) continue;
    const h = harness(0); h.def.version = version; h.def.steps.pop();
    if (condition !== undefined) h.def.steps[0].when = { op: 'boolean', value: { value: condition } };
    await start(h, []); await h.service.drain();
    const raw = JSON.parse(JSON.stringify(h.container.read().extensions.workflows));
    await assertInertRecovery(raw);
    if (condition !== undefined) {
      raw.runs[0].steps[0] = { id: 'work', status: 'completed', units: [], output: [] }; raw.runs[0].report = [];
      assertRejectedRecovery(raw, /true condition/);
    }
    h.service.dispose();
  }
  const h = harness(0); h.def.version = 2;
  h.def.steps = [
    { id: 'gate', kind: 'aggregate', operation: 'collect', dependsOn: [], inputs: {}, when: { op: 'boolean', value: { value: false } } },
    { ...h.def.steps[0], dependsOn: ['gate'] },
  ];
  await start(h, []); await h.service.drain();
  const raw = JSON.parse(JSON.stringify(h.container.read().extensions.workflows)); await assertInertRecovery(raw);
  raw.runs[0].steps[1] = { id: 'work', status: 'completed', units: [], output: [] }; raw.runs[0].report = [];
  assertRejectedRecovery(raw, /materialized dependency/); h.service.dispose();
});

test('raw repeat recovery rejects contradictory transition errors and termination statuses', async () => {
  const h = harness(); h.def = repeatDef(); await start(h); h.fake.done(0, '2'); await h.service.drain();
  const raw = JSON.parse(JSON.stringify(h.container.read().extensions.workflows)); await assertInertRecovery(raw);
  for (const mutate of [
    (s: any) => { s.iterations[0].error = 'Transition failed'; },
    (s: any) => { s.error = 'Transition failed'; },
    (s: any) => { s.status = 'failed'; delete s.output; },
    ...['invalid-transition', 'body-failed', 'cancelled', 'recovery', 'max-iterations'].map(termination => (s: any) => { s.status = 'running'; delete s.output; s.termination = termination; }),
  ]) {
    const forged = structuredClone(raw); mutate(forged.runs[0].steps[0]); delete forged.runs[0].report;
    assertRejectedRecovery(forged, /repeat status|convergence|requires|nonconvergence/);
  }
  h.service.dispose();
  for (const decision of [1, 2]) {
    const paused = harness(); paused.def = repeatDef(); let hit = false;
    paused.service.subscribe(views => { const v = views[0]; if (v && !hit && paused.service.get(v.workflowRunId)?.steps[0].iterations?.[0].decision !== undefined) { hit = true; void paused.service.execute({ action: 'workflows.pause', workflowRunId: v.workflowRunId }); } });
    await start(paused); paused.fake.done(0, String(decision)); await paused.service.drain(); assert(hit);
    await assertInertRecovery(paused.container.read().extensions.workflows); paused.service.dispose();
  }
});

test('live and recovered native identities use distinct run/task namespaces', async () => {
  const h = harness(2); h.def.version = 2; h.def.steps.pop(); let count = 0;
  h.fake.port.execute = async request => {
    const index = count++, identity = index === 0 ? { runId: 'same', taskId: 'same' } : { runId: 'other', taskId: 'other' };
    request.onIdentity(identity); return { status: 'completed', text: '"ok"', cleanupSettled: true, identity };
  };
  await start(h, ['a', 'b']); await h.service.drain(); assert.equal(count, 2);
  const raw = JSON.parse(JSON.stringify(h.container.read().extensions.workflows)); assert.equal(raw.runs[0].status, 'completed'); await assertInertRecovery(raw);
  for (const key of ['runId', 'taskId']) {
    const forged = structuredClone(raw); forged.runs[0].steps[0].units[1].native[key] = 'same';
    assertRejectedRecovery(forged, /Duplicate native identity/);
  }
  const swapped = structuredClone(raw); swapped.runs[0].steps[0].units[0].native = { runId: 'a', taskId: 'b' }; swapped.runs[0].steps[0].units[1].native = { runId: 'b', taskId: 'a' };
  const { workflowUnitEnvelope } = await import('../workflow-model.js');
  swapped.runs[0].steps[0].output = swapped.runs[0].steps[0].units.map(workflowUnitEnvelope); swapped.runs[0].report = swapped.runs[0].steps[0].output;
  await assertInertRecovery(swapped); h.service.dispose();
});
