import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, writeFileSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTrustedCodingWorkflowExample } from '../workflow-coding-example.js';
import { createClankersStateContainer } from '../state.js';
import { createWorkflowService } from '../workflow-runtime.js';
import { EMPTY_NATIVE_ACTIVITY, projectActivity } from '../activity.js';
import type { WorkflowDefinition, WorkflowNativeOutcome, WorkflowNativeRequest } from '../workflow-model.js';
const date = '2026-10-07T00:00:00.000Z';
function harness(fanout = false, existing?: unknown) {
  const container = createClankersStateContainer({ agentDefinitions: { worker: { id: 'worker', label: 'Worker', source: 'builtin', prompt: 'Read only',
    model: 'fake/model', tools: ['read'], permissionMode: 'inherit' } }, ...(existing ? { extensions: { workflows: existing as any } } : {}) });
  let reads = 0, updates = 0, seq = 0;
  const originalRead = container.read.bind(container), originalUpdate = container.update.bind(container);
  container.read = () => { reads++; return originalRead(); };
  container.update = value => { updates++; return originalUpdate(value); };
  const requests: WorkflowNativeRequest[] = [], finish: Array<(outcome: WorkflowNativeOutcome) => void> = [];
  const service = createWorkflowService(container, { preflight() {}, execute(request) {
    requests.push(request); request.assertAdmission(); const identity = { runId: `native-${requests.length}`, taskId: `task-${requests.length}` };
    request.onIdentity(identity); return new Promise(resolve => finish.push(outcome => resolve({ ...outcome, identity })));
  } }, { now: () => new Date(date), idFactory: () => `wf-${++seq}` });
  const schema = { type: 'string' as const, maxLength: 32 };
  const def: WorkflowDefinition = { id: 'activity', version: 1, label: 'Activity', inputSchema: fanout
    ? { type: 'array', items: schema, maxItems: 4 } : schema,
    steps: [{ id: 'first', kind: 'native', dependsOn: [], agentId: 'worker', prompt: 'readonly', outputSchema: schema, inputs: {},
      ...(fanout ? { fanout: { from: { source: 'inputs' as const, path: [] }, maxItems: 4 } } : {}) },
    { id: 'second', kind: 'native', dependsOn: ['first'], agentId: 'worker', prompt: 'readonly', outputSchema: schema, inputs: {} }] };
  return { container, service, requests, finish, def, counters: () => ({ reads, updates }),
    done(index: number, cleanupSettled = true, status: WorkflowNativeOutcome['status'] = 'completed') { finish[index]({ status, text: '"ok"', cleanupSettled }); } };
}
async function turns(n = 12) { for (let i = 0; i < n; i++) await Promise.resolve(); }
async function start(h: ReturnType<typeof harness>, inputs: string | string[] = 'input') {
  const defined = await h.service.execute({ action: 'workflows.define', definition: h.def }); assert(defined.ok, defined.error);
  const reply = await h.service.execute({ action: 'workflows.start', definitionId: h.def.id, inputs, concurrency: 1 });
  assert(reply.ok, reply.error); await turns(); return reply.view!.workflowRunId;
}
test('activity snapshot/subscribe causes zero reads, ledger initialization, full copies, getters or approval calls', async () => {
  const h = harness(); await start(h);
  const source = h.service.activity!; assert(source); const before = h.counters();
  h.service.list = () => { throw new Error('full list'); }; h.service.get = () => { throw new Error('full get'); };
  h.service.approvals.inspect = () => { throw new Error('approvalEpoch changed'); };
  const snapshot = source.snapshot(); let notices = 0; const remove = source.subscribe(() => { notices++; });
  for (let i = 0; i < 1000; i++) assert.equal(source.snapshot(), snapshot);
  assert.deepEqual(h.counters(), before); assert.equal(notices, 0); assert(Object.isFrozen(snapshot.runs[0].units[0]));
  assert.equal(snapshot.runs[0].units[0].nativeRunId, 'native-1'); assert.equal(snapshot.runs[0].label, h.def.label);
  assert.equal(projectActivity(EMPTY_NATIVE_ACTIVITY, snapshot, Date.parse(date)).counts.working, 0);
  remove(); h.done(0); await turns(); h.done(1); await h.service.drain(); h.service.dispose();
});
test('fixed v1 top-step progress excludes failed/skipped and no unmaterialized invented queue', async () => {
  const h = harness(); await start(h); let run = h.service.activity!.snapshot().runs[0];
  assert.equal(run.progress.total, 2); assert.equal(run.units.length, 1); assert.equal(run.progress.completed, 0);
  h.done(0); await turns(); run = h.service.activity!.snapshot().runs[0]; assert.equal(run.progress.completed, 1);
  assert.equal(run.units.length, 2); h.done(1, true, 'failed'); await h.service.drain(); run = h.service.activity!.snapshot().runs[0];
  assert.equal(run.progress.completed, 1); assert.equal(run.progress.failed, 1); h.service.dispose();
});
test('fanout dynamic denominator null and materialized queue basis is units not potential agents', async () => {
  const h = harness(true); await start(h, ['a', 'b', 'c']); const snap = h.service.activity!.snapshot();
  assert.equal(snap.runs[0].progress.total, null); assert.equal(snap.runs[0].units.length, 3);
  const p = projectActivity(EMPTY_NATIVE_ACTIVITY, snap, Date.parse(date)); assert.equal(p.counts.queuedUnits, 2);
  assert.equal(p.counts.queuedAgents, 0); assert.equal(p.counts.working, 0);
  h.done(0); await turns(); h.done(1); await turns(); h.done(2); await turns(); h.done(3); await h.service.drain(); h.service.dispose();
});
test('unknown cleanup retains runtime permit but is never observed execution or admitted computation', async () => {
  const h = harness(); await start(h); h.done(0, false); await turns();
  const run = h.service.activity!.snapshot().runs[0]; assert.equal(run.cleanup, 'unknown');
  assert.equal(run.units[0].status, 'unverified'); assert.equal(run.units[0].admitted, false);
  const p = projectActivity(EMPTY_NATIVE_ACTIVITY, h.service.activity!.snapshot(), Date.parse(date));
  assert.equal(p.counts.working, 0); assert.equal(p.counts.unknown, 1); assert.equal(p.focus?.phase, 'unknown');
  await assert.rejects(h.service.drain(), /cleanup/); h.service.dispose();
});
test('poisoned terminal publication refreshes without successful persist and cannot retain admitted work', async () => {
  const h = harness(); await start(h); const original = h.container.update.bind(h.container);
  h.container.update = value => {
    const runs = typeof value === 'function' ? undefined : (value.extensions?.workflows as any)?.runs;
    if (runs?.some((run: any) => run.steps[0].status !== 'running')) throw new Error('terminal publication poison');
    return original(value);
  };
  h.done(0); await turns(); const snap = h.service.activity!.snapshot(); assert(snap.uncertain);
  assert(snap.runs.every(run => run.uncertain)); assert(snap.runs[0].units.every(unit => !unit.admitted));
  assert.equal(projectActivity(EMPTY_NATIVE_ACTIVITY, snap, Date.parse(date)).counts.working, 0); h.service.dispose();
});
test('pump fence failure refreshes compact uncertainty without new ledger publication', async () => {
  const h = harness(); await start(h); const state = h.container.read();
  h.container.update({ extensions: { ...state.extensions, workflows: { changedOutsideOwner: true } } });
  h.done(0); await turns(); const snap = h.service.activity!.snapshot(); assert(snap.uncertain);
  assert(snap.runs[0].units.every(unit => !unit.admitted)); h.service.dispose();
});
test('disposal closes observer computation, cleanup uncertainty retained and repeated disposal harmless', async () => {
  const h = harness(); await start(h); h.service.dispose(); h.service.dispose();
  const snap = h.service.activity!.snapshot(); assert(snap.uncertain); assert.equal(snap.runs[0].units[0].admitted, false);
  assert.equal(snap.runs[0].cleanup, 'unknown'); assert(h.requests[0].signal.aborted);
  h.done(0); await h.service.drain(); assert.equal(h.service.activity!.snapshot().runs[0].units[0].admitted, false);
});
test('restored completed/failed history never qualifies as current local grace/attention', async () => {
  for (const failed of [false, true]) {
    const h = harness(); await start(h); h.done(0); await turns(); h.done(1, true, failed ? 'failed' : 'completed'); await h.service.drain();
    const existing = h.container.read().extensions.workflows; h.service.dispose(); const restored = harness(false, existing);
    const snap = restored.service.activity!.snapshot(); assert.equal(snap.runs[0].local, false); assert.equal(restored.requests.length, 0);
    assert.equal(projectActivity(EMPTY_NATIVE_ACTIVITY, snap, Date.parse(date)).focus, undefined);
    const before = restored.counters(); const remove = restored.service.activity!.subscribe(() => {}); restored.service.activity!.snapshot(); remove();
    assert.deepEqual(restored.counters(), before); restored.service.dispose();
  }
});
test('restored in-flight history inert/unverified and new linked/owner IDs classified by identity not timestamps', async () => {
  const h = harness(); await start(h); const existing = h.container.read().extensions.workflows;
  const restored = harness(false, existing); const run = restored.service.activity!.snapshot().runs[0];
  assert.equal(run.local, false); assert.equal(run.recovered, true); assert.equal(run.units[0].admitted, false); assert.equal(restored.requests.length, 0);
  h.service.dispose(); h.done(0); await h.service.drain(); restored.service.dispose();
});
test('observer callbacks asynchronous and exceptions cannot alter outcomes or original subscriber order', async () => {
  const h = harness(); await turns(); const order: string[] = []; let inExecute = false;
  h.service.subscribe(() => { order.push('original'); });
  const remove = h.service.activity!.subscribe(() => { assert(!inExecute); order.push('activity'); throw new Error('observer fails'); });
  inExecute = true; const define = h.service.execute({ action: 'workflows.define', definition: h.def }); inExecute = false; await define; await turns();
  assert.equal(order[0], 'original'); assert(order.includes('activity'));
  const reply = await h.service.execute({ action: 'workflows.start', definitionId: h.def.id, inputs: 'x' }); assert(reply.ok); await turns();
  h.done(0); await turns(); h.done(1); await h.service.drain(); assert.equal(h.service.activity!.snapshot().runs[0].status, 'completed');
  remove(); h.service.dispose();
});


// Every fixture write is lexically/resolved bounded, with no symlink ancestors or shared files.
function guardFixture(path: string, root: string): void {
  const full = resolve(path), bounded = resolve(root), rel = relative(bounded, full);
  assert(!isAbsolute(rel) && rel !== '..' && !rel.startsWith('../'));
  let current = existsSync(full) ? full : dirname(full);
  while (!existsSync(current)) current = dirname(current);
  const resolved = realpathSync(current), actualRoot = realpathSync(bounded);
  assert(resolved === actualRoot || resolved.startsWith(actualRoot + '/'));
  for (let parent = current; ; parent = dirname(parent)) {
    const st = lstatSync(parent); assert(!st.isSymbolicLink());
    if (parent === dirname(parent)) break;
  }
  if (existsSync(full) && lstatSync(full).isFile()) assert.equal(lstatSync(full).nlink, 1);
}
test('real workflow approval phase/full repeat lineage comes from compact closure, never approval inspection', async () => {
  const fixtureParent = dirname(fileURLToPath(import.meta.url));
  guardFixture(join(fixtureParent, 'activity-fixture-'), fixtureParent);
  const scratch = mkdtempSync(join(fixtureParent, 'activity-fixture-'));
  guardFixture(scratch, fixtureParent);
  const projectRoot = join(scratch, 'project'), stagingParent = join(scratch, 'stage');
  guardFixture(projectRoot, scratch); mkdirSync(projectRoot); guardFixture(stagingParent, scratch); mkdirSync(stagingParent);
  const example = buildTrustedCodingWorkflowExample({ projectRoot, stagingParent, model: 'fake/model' });
  for (const [path, text] of Object.entries(example.initialFiles)) {
    const target = join(projectRoot, path); guardFixture(dirname(target), scratch); mkdirSync(dirname(target), { recursive: true });
    guardFixture(target, scratch); writeFileSync(target, text);
  }
  const def = example.definition; def.steps = [def.steps[1]]; def.steps[0].dependsOn = [];
  const container = createClankersStateContainer({ agentDefinitions: Object.fromEntries(['worker', 'reviewer'].map(id => [id,
    { id, label: id, source: 'builtin', model: 'fake/model', prompt: 'Fake only', tools: ['read'], permissionMode: 'inherit' }])) });
  const service = createWorkflowService(container, { preflight() {}, execute() { throw new Error('No approval or provider execution permitted'); } },
    { now: () => new Date(date), idFactory: () => 'coding-wf', coding: example.coding });
  let inspections = 0; service.approvals.inspect = () => { inspections++; throw new Error('Observer approval epoch mutation'); };
  const defined = await service.execute({ action: 'workflows.define', definition: def }); assert(defined.ok, defined.error);
  const started = await service.execute({ action: 'workflows.start', definitionId: def.id, inputs: {} }); assert(started.ok, started.error); await turns();
  const snap = service.activity!.snapshot(), run = snap.runs[0], unit = run.units[0];
  assert.equal(run.local, true); assert.equal(run.progress.total, null); assert.equal(unit.phase, 'awaiting-implementation-approval');
  assert.equal(unit.approvalStatus, 'pending'); assert.equal(unit.cleanup, 'settled'); assert.equal(unit.admitted, false);
  assert.equal(unit.blockId, 'correct-until-reviewed'); assert.equal(unit.iterationNo, 1); assert(unit.iterationId);
  assert(unit.stepId.startsWith(`${unit.iterationId}/`)); assert.match(unit.inputHash, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(unit, 'inputs'), false); assert.equal(Object.hasOwn(unit, 'coding'), false); assert.equal(Object.hasOwn(unit, 'result'), false);
  const p = projectActivity(EMPTY_NATIVE_ACTIVITY, snap, Date.parse(date)); assert.equal(p.counts.waitingApproval, 1); assert.equal(p.counts.working, 0);
  for (let i = 0; i < 50; i++) service.activity!.snapshot(); assert.equal(inspections, 0);
  service.dispose(); await service.drain();
});

test('retry is new LOCAL identity at same timestamp while wholly reused steps and mixed reuse are disclosed', async () => {
  const h = harness(); const id = await start(h); h.done(0); await turns(); h.done(1, true, 'failed'); await h.service.drain();
  const retry = await h.service.execute({ action: 'workflows.retry', workflowRunId: id }); assert(retry.ok, retry.error); await turns();
  let run = h.service.activity!.snapshot().runs[1]; assert.equal(run.local, true); assert.equal(run.startedAt, date);
  assert.equal(run.attemptNo, 2); assert.equal(run.progress.reused, 1); assert.equal(run.progress.completed, 0); assert.equal(run.progress.reusedUnits, 1);
  assert.equal(run.units[0].reused, true); h.done(2); await h.service.drain(); run = h.service.activity!.snapshot().runs[1];
  assert.equal(run.progress.reused, 1); assert.equal(run.progress.completed, 1); h.service.dispose();
  const mixed = harness(true); const mixedId = await start(mixed, ['a', 'b']); mixed.done(0); await turns(); mixed.done(1, true, 'failed'); await mixed.service.drain();
  assert((await mixed.service.execute({ action: 'workflows.retry', workflowRunId: mixedId })).ok); await turns(); mixed.done(2); await turns(); mixed.done(3); await mixed.service.drain();
  const mixedRun = mixed.service.activity!.snapshot().runs[1]; assert.equal(mixedRun.progress.total, null);
  assert.equal(mixedRun.progress.completed, 2); assert.equal(mixedRun.progress.reused, 0); assert.equal(mixedRun.progress.reusedUnits, 1); mixed.service.dispose();
});
