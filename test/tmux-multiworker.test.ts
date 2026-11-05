import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { createZergState, createZergStateContainer, upsertAgentDefinition } from '../state.js';
import type { TmuxControl } from '../tmux-control.js';

// Import the working-tree controller, replacing only its external launch boundary.
const fakePath = fileURLToPath(new URL('./fixtures/tmux-multiworker-fake.ts', import.meta.url));
const jiti = createJiti(import.meta.url, { fsCache: false, alias: {
  './tmux-runner.js': fakePath, './tmux-worker-policy.js': fakePath,
} });
const { createTmuxControl } = await jiti.import<typeof import('../tmux-control.js')>('../tmux-control.ts');
const fake = await jiti.import<typeof import('./fixtures/tmux-multiworker-fake.js')>(fakePath);
const request = { agent: 'fixture', task: 'WAIT', backend: 'tmux' as const, background: true };
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await tick();
  assert.ok(check(), 'controller step exceeded 2s');
}
function fixture() {
  fake.launches.length = 0;
  const state = createZergStateContainer({ mode: { ...createZergState().mode, automation: 'automatic', readOnly: false } });
  state.replace(upsertAgentDefinition(state.read(), { id: 'fixture', label: 'Fixture', source: 'user', prompt: 'Synthetic only.', tools: [], model: 'fixture/fixed' }));
  let n = 0;
  const hooks: { ids?: () => { runId: string; taskId: string }; notice?: () => void; authority?: () => void } = {};
  const control = createTmuxControl(state, { cwd: '/unused', trusted: { sdkModulePath: '/unused/sdk.js', agentDir: '/unused/agent' },
    ids: () => hooks.ids?.() ?? { runId: `run-${++n}`, taskId: `task-${n}` },
    captureNotice: () => { hooks.notice?.(); return undefined; }, assertAuthority: () => hooks.authority?.(),
  });
  return { control, state, hooks };
}
async function open(count: number) {
  await until(() => fake.launches.length === count);
  const handles = fake.launches.map(launch => fake.fakeWorker(launch.options.workerId!));
  fake.launches.forEach((launch, i) => launch.gate.resolve(handles[i].handle));
  await until(() => handles.every(handle => handle.calls.prompts === 1));
  return handles;
}
async function dispose(control: TmuxControl, handles: ReturnType<typeof fake.fakeWorker>[]) {
  control.dispose();
  for (const handle of handles) handle.finishClose();
  await control.drain();
  assert.deepEqual(await control.list(), []);
}

async function capacity() {
  const { control } = fixture();
  const runs = Array.from({ length: 8 }, () => control.start(request));
  assert.throws(() => control.start(request), /capacity is 8/);
  const setup = await control.list();
  assert.equal(setup.length, 8); assert.equal(new Set(setup.map(w => w.workerId)).size, 8);
  assert.ok(setup.every(w => w.phase === 'starting'));
  await until(() => fake.launches.length === 8);
  fake.launches[0].gate.reject(new fake.TmuxLaunchError(true, false));
  await control.awaitRun(runs[0].runId!);
  assert.deepEqual((await control.list()).map(w => w.workerId), setup.slice(1).map(w => w.workerId));
  runs.push(control.start(request));
  assert.throws(() => control.start(request), /capacity is 8/);
  await until(() => fake.launches.length === 9);
  const handles = fake.launches.slice(1).map(launch => fake.fakeWorker(launch.options.workerId!));
  fake.launches.slice(1).forEach((launch, i) => launch.gate.resolve(handles[i].handle));
  await until(() => handles.every(h => h.calls.prompts === 1));
  handles.forEach((h, i) => h.settle(`OUTPUT_${i}`));
  await Promise.all(runs.slice(1).map(r => control.awaitRun(r.runId!)));
  assert.ok((await control.list()).every(w => w.phase === 'idle'));
  assert.throws(() => control.start(request), /capacity is 8/);
  const closing = control.close(handles[0].handle.workerId);
  assert.throws(() => control.start(request), /capacity is 8/);
  assert.equal((await control.list()).length, 8);
  handles[0].finishClose(); await closing;
  assert.equal((await control.list()).length, 7);
  control.start(request); // Replacement counts even when disposed before launching.
  assert.throws(() => control.start(request), /capacity is 8/);
  await dispose(control, handles.slice(1));
  assert.ok(handles.every(h => h.calls.closes === 1));
}

async function independentJobs() {
  const { control, state } = fixture();
  const a = control.start(request), b = control.start(request);
  const [A, B] = await open(2);
  const [sa, sb] = await control.list();
  for (const field of ['workerId', 'sessionId', 'currentRunId'] as const) assert.notEqual(sa[field], sb[field]);
  assert.notEqual(sa.job!.jobId, sb.job!.jobId); assert.notEqual(sa.job!.taskId, sb.job!.taskId);
  await assert.rejects(control.steer(A.handle.workerId, b.runId!, 'WRONG'), /Exact current/);
  await assert.rejects(control.show('missing'), /Exact owned/);
  assert.equal((await control.show(B.handle.workerId, sa.job!.jobId)).result, null);
  assert.equal(control.interrupt('missing').ok, false);
  const before = state.read();
  const corrupt = state.read(); corrupt.agents[b.runId!].metadata!.tmuxJobId = sa.job!.jobId; state.replace(corrupt);
  assert.equal(control.interrupt(b.runId!).ok, false);
  await assert.rejects(control.steer(B.handle.workerId, b.runId!, 'WRONG'), /revoked/);
  state.replace(before);
  const corruptTask = state.read(); corruptTask.tasks[b.taskId!].metadata!.workerId = A.handle.workerId; state.replace(corruptTask);
  assert.equal(control.interrupt(b.runId!).ok, false); state.replace(before);
  assert.equal(control.interrupt(a.runId!).ok, true); await control.awaitRun(a.runId!);
  assert.deepEqual(B.calls.cancels, []); assert.deepEqual(B.ledger.snapshot(), { identity: B.handle.identity, ownership: 'coordinator', phase: 'busy', job: B.ledger.snapshot().job, result: null });
  const closed = control.close(A.handle.workerId); A.finishClose(); await closed;
  assert.equal((await control.show(B.handle.workerId)).job!.runId, b.runId);
  B.settle('B_OK'); await control.awaitRun(b.runId!);
  const prior = control.retainedResults();
  assert.deepEqual(prior.map(r => r.final_message), ['A_PARTIAL', 'B_OK']);
  const next = await control.prompt(B.handle.workerId, 'B_REUSE', true);
  await until(() => B.calls.prompts === 2);
  assert.notEqual(next.runId, b.runId); assert.notEqual(next.taskId, b.taskId);
  assert.equal(control.interrupt(b.runId!).ok, false);
  B.settle('B_REUSE_OK'); await control.awaitRun(next.runId!);
  assert.deepEqual(control.retainedResults().slice(0, 2), prior);
  assert.equal(control.retainedResults()[2].pi_session_id, sb.sessionId);
  await dispose(control, [B]);
  assert.deepEqual(control.retainedResults().slice(0, 2), prior);
}

async function uncertainCleanup() {
  const { control } = fixture();
  control.start(request); control.start(request);
  const [A, B] = await open(2);
  A.failInspection();
  const rows = await control.list();
  assert.equal(rows.length, 2); assert.equal(rows[0].workerId, A.handle.workerId);
  assert.ok('inspectionError' in rows[0]); assert.equal(rows[1].phase, 'busy');
  const closing = control.close(A.handle.workerId); A.finishClose(false); await closing;
  for (let i = 0; i < 6; i++) control.start(request);
  assert.throws(() => control.start(request), /capacity is 8/);
  await until(() => fake.launches.length === 8);
  fake.launches[2].gate.reject(new fake.TmuxLaunchError(false, true));
  for (const launch of fake.launches.slice(3)) launch.gate.reject(new fake.TmuxLaunchError(true, false));
  control.dispose(); B.finishClose();
  await assert.rejects(control.drain(), /cleanup/);
  const retained = await control.list();
  assert.equal(retained.length, 2);
  assert.deepEqual(new Set(retained.map(r => r.workerId)), new Set([A.handle.workerId, fake.launches[2].options.workerId]));
}

async function reentrantPublication() {
  const { control, state } = fixture();
  let admitted = 0, refused = 0;
  state.subscribe!(() => {
    if (admitted >= 8) return;
    admitted++;
    try { control.start(request); } catch (error) { assert.match(String(error), /capacity is 8/); refused++; }
  });
  control.start(request);
  assert.equal(admitted, 8); assert.equal(refused, 1);
  const listing = control.list();
  control.dispose();
  assert.equal((await listing).length, 8);
  await dispose(control, []);
  assert.equal(fake.launches.length, 0);
}

async function reentrantAdmission() {
  const { control, hooks } = fixture();
  hooks.ids = () => ({ runId: 'same-run', taskId: 'same-task' });
  hooks.notice = () => { hooks.notice = undefined; control.start(request); };
  assert.throws(() => control.start(request), /Canonical job owner changed/);
  const handles = await open(1);
  assert.equal((await control.list()).length, 1);
  handles[0].settle('SIBLING_OK'); await control.awaitRun('same-run');
  assert.equal(control.retainedResults()[0].final_message, 'SIBLING_OK');
  hooks.authority = () => { hooks.authority = undefined; control.dispose(); };
  assert.throws(() => control.start(request), /disposed/);
  handles[0].finishClose(); await control.drain();
  assert.deepEqual(await control.list(), []);
}

// A single sequential gate stops at the first failed assertion, not the next test.
test('independent worker controller gate: capacity, isolation, cleanup and reentrancy', { timeout: 30000 }, async t => {
  for (const check of [capacity, independentJobs, uncertainCleanup, reentrantPublication, reentrantAdmission]) {
    await check();
    t.diagnostic(`${check.name}: passed`);
  }
});
