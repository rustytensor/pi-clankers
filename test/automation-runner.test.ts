import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough, Readable } from 'node:stream';
// Public mjs framing: no SDK, provider, process or scheduler invocation.
// @ts-expect-error Public JavaScript entry point has no declaration file.
import { parseAutomationArguments, readAutomationStdin } from '../automation-cli.mjs';

const event = { version: 1, profileId: 'daily', eventId: '2026-10-06T12:00:00.000Z', occurrenceTime: '2026-10-06T12:00:00.000Z' };

test('CLI admits only frozen operations and operator absolute locator', () => {
  for (const operation of ['run', 'status', 'report']) {
    assert.deepEqual(parseAutomationArguments([operation, '--profiles-dir', '/operator/profiles']), { operation, profilesDir: '/operator/profiles' });
  }
  assert.deepEqual(parseAutomationArguments(['profile-hash', '--profiles-dir', '/operator/profiles', '--profile-id', 'daily']), {
    operation: 'profile-hash', profilesDir: '/operator/profiles', profileId: 'daily',
  });
  for (const args of [[], ['run'], ['replay', '--profiles-dir', '/x'], ['run', '--profiles-dir', '.pi'],
    ['run', '--profiles-dir', '/x', '--cwd', '/project'], ['run', '--profiles-dir', '/x', '--profiles-dir', '/y'],
    ['run', '--profiles-dir', '/x', 'task'], ['run', '--profiles-dir', '/x', '--profile-id', 'daily'],
    ['profile-hash', '--profiles-dir', '/x'], ['profile-hash', '--profiles-dir', '/x', '--profile-id', '../secret'],
    ['run', '--profiles-dir', '/x\0evil']]) assert.throws(() => parseAutomationArguments(args));
});

test('stdin accepts one bounded strict UTF8 scalar envelope across chunk boundaries', async () => {
  const bytes = Buffer.from(JSON.stringify(event));
  assert.deepEqual(await readAutomationStdin(Readable.from([bytes.subarray(0, 8), bytes.subarray(8)])), event);
  assert.deepEqual(await readAutomationStdin(Readable.from([Buffer.from(` \n${JSON.stringify(event)}\r\n`)])), event);
});

test('stdin rejects duplicate keys including escaped aliases, nesting, malformed JSON and invalid UTF8', async () => {
  for (const text of ['', '{}{}', 'null', '[]', '{"version":1,"version":1}', '{"version":1,"\\u0076ersion":1}',
    '{"inputs":{}}', '{"inputs":[]}', '{"x":1,}', '{"x":1} trailing', '{"x":01}', '{"x":NaN}',
    '{"a":1,"b":2,"c":3,"d":4,"e":5}']) await assert.rejects(readAutomationStdin(Readable.from([Buffer.from(text)])));
  await assert.rejects(readAutomationStdin(Readable.from([Buffer.from([0xc3, 0x28])])), /invalid-request-json/);
});

test('stdin bounds bytes, cancels stalled streams and removes owned listeners', async () => {
  await assert.rejects(readAutomationStdin(Readable.from([Buffer.alloc(4097, 0x20)])), /invalid-request-size/);
  const stalled = new PassThrough();
  await assert.rejects(readAutomationStdin(stalled, undefined, 5), /stdin-deadline/);
  assert.equal(stalled.listenerCount('data'), 0);
  const signal = new AbortController();
  const stream = new PassThrough();
  const reading = readAutomationStdin(stream, signal.signal, 100);
  signal.abort();
  await assert.rejects(reading, /caller-cancelled/);
  assert.equal(stream.listenerCount('end'), 0);
  const already = new AbortController(); already.abort();
  await assert.rejects(readAutomationStdin(new PassThrough(), already.signal), /caller-cancelled/);
});

import { readFileSync, mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

// Evaluate ONLY this runner's exact source with controlled public factory fakes.
// This is not an SDK/provider/process/core-engine acceptance test. No public test seam.
const source = readFileSync(new URL('../automation-runner.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const nativeRequire = createRequire(import.meta.url);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// Model only runner-owned timers: an unresolved promise is not a live handle.
// Timers still wait until their due time; never fire an orphan unref timer.
const flushRunnerMicrotasks = async () => { for (let i = 0; i < 250; i++) await Promise.resolve(); };
function controlledRunnerTimers() {
  let now = 0;
  let sequence = 0;
  type Timer = { id: number; due: number; callback: () => void; referenced: boolean;
    unref(): Timer; hasRef(): boolean };
  const active = new Map<number, Timer>();
  return {
    now: () => now,
    active,
    setTimeout(callback: () => void, ms: number): Timer {
      const timer: Timer = { id: ++sequence, due: now + Math.max(0, ms), callback, referenced: true,
        unref() { this.referenced = false; return this; }, hasRef() { return this.referenced; } };
      active.set(timer.id, timer);
      return timer;
    },
    clearTimeout(timer: Timer) { active.delete(timer.id); },
    async fireNextLive() {
      assert.ok([...active.values()].some(timer => timer.hasRef()), 'no live runner timer: Node would exit');
      const next = [...active.values()].sort((a, b) => a.due - b.due || a.id - b.id)[0];
      now = next.due;
      active.delete(next.id);
      next.callback();
      await flushRunnerMicrotasks();
    },
  };
}

type Scenario = { outcome?: string; foreign?: boolean; duplicate?: boolean; conflict?: boolean; credential?: boolean;
  saveFail?: boolean; releaseFail?: boolean; setupHang?: boolean; cancelledHang?: boolean; drainReject?: boolean; prior?: boolean;
  signal?: AbortSignal; output?: number; finalSaveDelayMs?: number; maxRunMs?: number; readBurst?: boolean; providerBurst?: boolean; microtaskStarve?: boolean; defineHang?: boolean;
  maxReadBytes?: number; readText?: string;
  scopedExercise?: (native: any, profile: any, calls: string[], fences: {
    expire: () => void; loseOwner: () => void; onGuard: (nth: number, effect: () => void) => void;
  }) => void };
function harness(scenario: Scenario = {}, timers?: ReturnType<typeof controlledRunnerTimers>) {
  const root = mkdtempSync(resolve(tmpdir(), 's8e-runner-unit-'));
  const projectRoot = resolve(root, 'project'); mkdirSync(projectRoot, { mode: 0o700 });
  const stateRoot = resolve(root, 'state'); mkdirSync(stateRoot, { mode: 0o700 });
  const calls: string[] = [];
  const profile: any = { version: 1, id: 'daily', enabled: true, approvedProfileHash: 'a'.repeat(64), projectRoot,
    snapshotFile: resolve(stateRoot, 'snapshot.json'), agentDir: resolve(root, 'agent'), sessionDir: resolve(root, 'sessions'),
    definitionId: 'daily-review', definitionHash: 'b'.repeat(64), definition: { id: 'daily-review', version: 1, label: 'Review',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }, steps: [] }, fixedInputs: {}, readPaths: ['public.txt'],
    agents: [{ id: 'reviewer', label: 'Reviewer', prompt: 'Read only', source: 'runtime', model: 'fixture/test:off', permissionMode: 'inherit', tools: ['read'] }],
    modelPolicy: { provider: 'fixture', id: 'test', thinkingLevel: 'off' }, credentialSourceRef: { kind: 'env', name: 'S8E_UNIT_ONLY' }, modelConfigFile: null,
    limits: { maxEventAgeMs: 300000, maxFutureSkewMs: 30000, minIntervalMs: 1, maxRetainedEvents: 16,
      maxRunMs: scenario.maxRunMs ?? 100, maxCleanupMs: 30, maxOutputBytes: scenario.output ?? 16384, maxReadBytes: scenario.maxReadBytes ?? 1024, maxAdmissions: 64, maxProviderRequests: 128, concurrency: 1 } };
  let workflow: any;
  const viewOf = (run: any) => ({ workflowRunId: run.workflowRunId, familyId: run.familyId, attemptNo: 1,
    definitionId: profile.definitionId, status: run.status, cleanupSettled: run.cleanupSettled,
    counts: { queued: 0, running: run.status === 'running' ? 1 : 0, completed: run.status === 'completed' ? 1 : 0, failed: run.status === 'failed' ? 1 : 0, cancelled: 0, skipped: 0, unverified: 0 } });
  const makeRun = () => ({ workflowRunId: 'exact-workflow-1', familyId: 'exact-workflow-1', attemptNo: 1,
    status: 'running', cleanupSettled: true, admissions: 0, recovered: false, definition: profile.definition,
    definitionHash: profile.definitionHash, agents: {}, inputs: {}, concurrency: 1, steps: [] });
  let state: any = { extensions: { workflows: { version: 1, definitions: [], runs: [] } }, agents: {}, tasks: {}, agentDefinitions: {}, mode: { readOnly: false } };
  if (scenario.duplicate || scenario.conflict || scenario.prior) {
    workflow = makeRun(); workflow.status = scenario.prior ? 'needs-attention' : scenario.outcome ?? 'completed';
    workflow.cleanupSettled = !scenario.prior;
    state.extensions.workflows.runs.push(workflow);
    state.extensions.automation = { version: 1, events: [{ eventId: event.eventId, workflowRunId: workflow.workflowRunId }] };
  }
  const container = { read: () => state, snapshot: () => clone(state), replace: (v: any) => (state = clone(v)), update: (v: any) => (state = { ...state, ...clone(v) }) };
  let held: any = scenario.foreign ? { generation: 'foreign', writerSessionId: 'foreign' } : undefined;
  const manager = { info: { writerSessionId: 'fake-owned' }, hydrate() { calls.push('hydrate'); return {}; },
    inspectRecoveryOwnership() { return { owner: held, ownerValid: !!held, claimPresent: false, actualSnapshotHash: 'd'.repeat(64) }; },
    acquireRecoveryOwnership(options: any) { calls.push('acquire'); assert.deepEqual(Object.keys(options), ['expectedSnapshotHash']); held = { generation: 'owned-generation', writerSessionId: 'fake-owned' }; return { owner: held }; },
    save(_state: any) { calls.push('save'); if (calls.filter(c => c === 'save').length === 3) { const until = Date.now() + (scenario.finalSaveDelayMs ?? 0); while (Date.now() < until) { /* controlled checkpoint delay */ } } if (scenario.saveFail) throw new Error('PRIVATE TASK/SECRET must not escape'); },
    releaseRecoveryOwnership(owner: any) { calls.push('release'); assert.deepEqual(owner, held); if (scenario.releaseFail) throw new Error('private release error'); held = undefined; } };
  let runnerSignal: AbortSignal | undefined;
  const runtime: any = { getPhysicalModel: () => ({ provider: 'fixture', id: 'test', reasoning: false }), getError: () => undefined,
    getRegisteredProviderIds: () => [], isUsingOAuth: () => false, getProviderAuthStatus: () => ({ source: 'runtime' }),
    async setRuntimeApiKey(provider: string, key: string) { calls.push('runtime-key'); assert.equal(provider, 'fixture'); assert.equal(key, 'UNIT-NONCREDENTIAL'); },
    async getAvailable(provider: string) { assert.equal(provider, 'fixture'); return [runtime.getPhysicalModel()]; } };
  let disposedGuard = 0;
  let clockOffset = 0;
  let guardEffect: (() => void) | undefined;
  let guardCountdown = 0;
  let exerciseError: unknown;
  const fences = { expire: () => { clockOffset += 10000; }, loseOwner: () => { held = undefined; },
    onGuard(nth: number, effect: () => void) { guardCountdown = nth; guardEffect = effect; } };
  const guard = { assertCurrent() { calls.push('guard'); if (guardEffect && --guardCountdown === 0) { const effect = guardEffect; guardEffect = undefined; effect(); } },
    readPath() { throw new Error('unused'); }, readModelConfig: () => null,
    dispose() { disposedGuard++; calls.push('guard-dispose'); } };
  let nativeOptions: any;
  const fakeControl = { getState: () => clone(state), async execute(action: any) {
    calls.push(action.action);
    if (action.action === 'workflows.define') return scenario.defineHang ? new Promise(() => {}) : { ok: true };
    if (action.action === 'workflows.cancel') {
      if (scenario.cancelledHang) return new Promise(() => {});
      workflow.status = 'cancelled'; workflow.cleanupSettled = true;
      state.extensions.workflows.runs = [workflow]; return { ok: true };
    }
    if (action.action === 'workflows.start') {
      workflow = makeRun(); const ledger = nativeOptions.trustedWorkflow.onStartReservation(workflow);
      state.extensions.automation = ledger; state.extensions.workflows.runs = [workflow]; manager.save(state);
      calls.push('reservation-committed');
      if (scenario.scopedExercise) {
        try { scenario.scopedExercise(nativeOptions.trustedAutomationNative, profile, calls, fences); }
        catch (error) { exerciseError = error; throw error; }
      }
      if (scenario.readBurst) {
        profile.limits.maxReadBytes = 4;
        assert.equal(nativeOptions.trustedAutomationNative.scopedRead(resolve(profile.projectRoot, 'public.txt')), 'abc');
        nativeOptions.trustedAutomationNative.scopedRead(resolve(profile.projectRoot, 'public.txt'));
      }
      if (scenario.providerBurst) { profile.limits.maxProviderRequests = 1; nativeOptions.trustedAutomationNative.beforeProviderRequest(); }
      if (scenario.microtaskStarve) for (let i = 0; i < 10000; i++) { await Promise.resolve(); nativeOptions.trustedAutomationNative.assertPolicy(); }
      nativeOptions.trustedAutomationNative.beforeProviderRequest(); calls.push('fake-provider-boundary');
      if (scenario.outcome === 'paused') workflow.status = 'paused';
      else if (scenario.outcome === 'unknown-cleanup') { workflow.status = 'needs-attention'; workflow.cleanupSettled = false; }
      else if (scenario.outcome !== 'hang') { workflow.status = scenario.outcome ?? 'completed'; workflow.cleanupSettled = true; }
      return { ok: true, data: { view: viewOf(workflow) } };
    }
    throw new Error('unexpected action');
  }, dispose() { calls.push('dispose'); }, async drain() { calls.push('drain'); if (scenario.drainReject) throw new Error('SECRET drain output'); } };
  const modules: Record<string, any> = {
    './index.js': { createClankersControl(c: any, options: any) { calls.push('control'); assert.equal(c, container); assert.equal(options.persistenceManager, manager);
      assert.equal(options.persistence, undefined);
      assert.deepEqual(Object.keys(options.recovery), ['enabled']); assert.equal(options.recovery.enabled, true);
      assert.deepEqual(Object.keys(options).sort(), ['persistenceManager', 'recovery', 'trustedAutomationNative', 'trustedWorkflow']);
      assert.equal(calls.filter(call => call === 'acquire').length, 1);
      nativeOptions = options; return fakeControl; } },
    './persistence.js': { createClankersPersistenceManager: () => manager },
    './state.js': { createClankersState: clone, createClankersStateContainer: () => container },
    './workflow-model.js': { workflowHash: JSON.stringify, workflowView: viewOf },
    './workflow-runtime.js': { recoverWorkflowState: clone },
    './automation-profile.js': { validateAutomationRequest(v: any) { if (Object.keys(v).sort().join(',') !== 'eventId,occurrenceTime,profileId,version') throw new Error('bad request'); return clone(v); },
      async loadAutomationProfile() { calls.push('profile'); return profile; }, async createAutomationProfileIdentityGuard() { return guard; }, scopedReadAutomationPath: () => { calls.push('scoped-text-read'); return scenario.readText ?? 'abc'; } },
    './automation-admission.js': { createAutomationLedger: () => ({ version: 1, events: [] }), validateAutomationLedger: clone,
      projectAutomationEvent(ledger: any, workflows: any) { const binding = ledger.events.find((e: any) => e.eventId === event.eventId);
        return { lookup: binding ? { kind: scenario.conflict ? 'conflict' : 'duplicate', binding } : { kind: 'missing' }, ...(binding ? { view: viewOf(workflows.runs[0]) } : {}) }; },
      reserveAutomationEvent(ledger: any, p: any, request: any, run: any, generation: string) { calls.push('reserve'); assert.equal(p, profile); assert.deepEqual(request, event); assert.equal(generation, held.generation); return { ...ledger, events: [...ledger.events, { eventId: event.eventId, workflowRunId: run.workflowRunId }] }; },
      pruneAutomationEvents(ledger: any, workflows: any) { calls.push('prune'); return { ledger, workflows, removedWorkflowRunIds: [] }; } },
    '@earendil-works/pi-coding-agent': { ModelRuntime: { async create(options: any) { runnerSignal = options.signal; calls.push('runtime-create'); assert.equal(options.modelsPath, null); assert.equal(options.allowModelNetwork, false); assert.equal(options.refreshOnCreate, false); assert.equal(await options.credentials.read('fixture'), undefined); assert.equal((await options.credentials.list()).length, 0);
      await assert.rejects(options.credentials.modify('fixture', () => undefined)); assert.ok(options.modelsStore); return scenario.setupHang ? new Promise(() => {}) : runtime; } } },
    'node:perf_hooks': { performance: { now: () => (timers ? timers.now() : nativeRequire('node:perf_hooks').performance.now()) + clockOffset } },
  };
  const exports: any = {};
  const sandbox = { exports, require: (name: string) => modules[name] ?? nativeRequire(name), Buffer,
    process: { ...process, platform: 'linux', geteuid: process.geteuid?.bind(process), env: scenario.credential === false ? {} : { S8E_UNIT_ONLY: 'UNIT-NONCREDENTIAL' } },
    AbortController, setTimeout: timers?.setTimeout ?? setTimeout, clearTimeout: timers?.clearTimeout ?? clearTimeout, Promise };
  runInNewContext(compiled, sandbox, { filename: 'automation-runner-unit.cjs' });
  return { api: exports, calls, profile, held: () => held, runnerSignal: () => runnerSignal, guardDisposed: () => disposedGuard, exerciseError: () => exerciseError, state: () => state,
    agentExists: () => existsSync(profile.agentDir), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

for (const outcome of ['completed', 'failed']) test(`foreground ${outcome} waits exact outcome, disposes/drains, final same-manager save before last release`, async () => {
  const h = harness({ outcome });
  try {
    const answer = await h.api.runAutomationEvent('/trusted/operator', event);
    assert.equal(answer.delivery, 'accepted', JSON.stringify({ answer, calls: h.calls })); assert.equal(answer.workflowStatus, outcome);
    assert.equal(answer.cleanup, 'settled'); assert.equal(answer.exitCode, outcome === 'completed' ? 0 : 1);
    assert.equal(answer.workflowRunId, 'exact-workflow-1'); assert.equal(h.held(), undefined);
    assert.ok(h.calls.indexOf('acquire') < h.calls.indexOf('runtime-create'));
    assert.ok(h.calls.indexOf('acquire') < h.calls.indexOf('control'));
    assert.ok(h.calls.indexOf('reservation-committed') < h.calls.indexOf('fake-provider-boundary'));
    assert.ok(h.calls.indexOf('dispose') < h.calls.indexOf('drain'));
    assert.deepEqual(h.calls.filter(c => ['dispose', 'drain', 'save', 'release'].includes(c)).slice(-4), ['dispose', 'drain', 'save', 'release']);
    assert.equal(h.guardDisposed(), 1);
    assert.ok(!JSON.stringify(answer).includes('UNIT-NONCREDENTIAL'));
  } finally { h.cleanup(); }
});

for (const outcome of ['completed', 'failed', 'cancelled']) test(`duplicate ${outcome} is historical pure projection and preserves failed duplicate exit`, async () => {
  const h = harness({ duplicate: true, outcome });
  try {
    for (const api of ['runAutomationEvent', 'inspectAutomationEvent']) {
      const answer = await h.api[api]('/trusted/operator', event);
      assert.equal(answer.delivery, 'duplicate'); assert.equal(answer.exitCode, outcome === 'completed' ? 0 : 1);
    }
    for (const forbidden of ['acquire', 'control', 'runtime-create', 'save', 'release']) assert.ok(!h.calls.includes(forbidden));
  } finally { h.cleanup(); }
});

test('foreign owner remains busy; duplicate foreign-owner status is honest uncertainty without writer acquisition', async () => {
  for (const duplicate of [false, true]) {
    const h = harness({ foreign: true, duplicate });
    try {
      const answer = await h.api.runAutomationEvent('/trusted/operator', event);
      assert.equal(answer.delivery, duplicate ? 'duplicate' : 'busy'); assert.equal(answer.cleanup, 'uncertain');
      assert.notEqual(answer.exitCode, 0); assert.ok(!h.calls.includes('acquire'));
      const status = await h.api.inspectAutomationEvent('/trusted/operator', event);
      assert.notEqual(status.exitCode, 0); assert.ok(!h.calls.includes('save'));
    } finally { h.cleanup(); }
  }
});

test('request authority injection/conflict/prior uncertainty are refused before runtime and new reservations', async () => {
  for (const scenario of [{ conflict: true }, { prior: true }]) {
    const h = harness(scenario);
    try { assert.notEqual((await h.api.runAutomationEvent('/trusted', event)).exitCode, 0); assert.ok(!h.calls.includes('runtime-create')); }
    finally { h.cleanup(); }
  }
  const h = harness();
  try { const answer = await h.api.runAutomationEvent('/trusted', { ...event, approvals: true }); assert.equal(answer.reasonCode, 'invalid-request'); assert.deepEqual(h.calls, []); }
  finally { h.cleanup(); }
});

test('missing named credential never initializes SDK or starts work, and releases a clean unadmitted owner', async () => {
  const h = harness({ credential: false });
  try { const answer = await h.api.runAutomationEvent('/trusted', event); assert.equal(answer.reasonCode, 'credential-unavailable'); assert.equal(answer.cleanup, 'not-started'); assert.ok(!h.calls.includes('runtime-create')); assert.equal(h.held(), undefined); }
  finally { h.cleanup(); }
});

test('persistence failure before initialization never admits and retains ownership uncertainty without leaking error', async () => {
  const h = harness({ saveFail: true });
  try { const answer = await h.api.runAutomationEvent('/trusted', event); assert.notEqual(answer.exitCode, 0); assert.ok(!h.calls.includes('control')); assert.ok(!h.calls.includes('fake-provider-boundary')); assert.ok(!JSON.stringify(answer).includes('PRIVATE TASK/SECRET')); assert.ok(h.held()); assert.ok(!h.calls.includes('release')); }
  finally { h.cleanup(); }
});

for (const outcome of ['paused', 'hang']) test(`${outcome} requires bounded cancellation rather than launch/drain success`, async () => {
  const h = harness({ outcome, maxRunMs: 20 });
  try { const answer = await h.api.runAutomationEvent('/trusted', event); assert.equal(answer.workflowStatus, 'cancelled'); assert.equal(answer.cleanup, 'settled'); assert.notEqual(answer.exitCode, 0); assert.ok(h.calls.includes('workflows.cancel')); }
  finally { h.cleanup(); }
});

for (const cancelledHang of [false, true]) test(`foreground poll keeps the only live timer after deadline abort; ${cancelledHang ? 'stuck cancellation is bounded uncertainty' : 'cleanup settles before last release'}`, async () => {
  const timers = controlledRunnerTimers();
  const h = harness({ outcome: 'hang', maxRunMs: 100, cancelledHang }, timers);
  try {
    let answer: any;
    const pending = h.api.runAutomationEvent('/trusted', event).then((value: any) => { answer = value; return value; });
    await flushRunnerMicrotasks();
    assert.ok(h.calls.includes('reservation-committed'));
    const before = [...timers.active.values()].sort((a, b) => a.id - b.id);
    assert.equal(before.length, 2); // Only the runner deadline and foreground poll.
    assert.equal(before[0].due, 100);
    assert.equal(before[0].hasRef(), true); // Deadline keeps the process alive before abort.
    assert.equal(before[1].due, 20);
    const pollReferencedBeforeAbort = before[1].hasRef();
    while (timers.now() < 100) await timers.fireNextLive();

    // Deadline fires first at 100ms. Abort does NOT wake the awaited poll.
    assert.equal(h.runnerSignal()?.aborted, true);
    assert.equal(answer, undefined);
    assert.equal(h.calls.includes('workflows.cancel'), false);
    assert.equal(h.calls.includes('dispose'), false);
    assert.ok(h.held());
    assert.equal(timers.active.size, 1);
    const poll = [...timers.active.values()][0];
    assert.equal(poll.due, 100);
    assert.equal(poll.hasRef(), true, 'foreground poll must keep Node alive after the deadline handle disappears');
    assert.equal(pollReferencedBeforeAbort, true);
    await timers.fireNextLive(); // No unrelated handles and no manual orphan-timer rescue.

    if (cancelledHang) {
      assert.equal(answer, undefined);
      assert.equal(timers.active.size, 1); // Owned cancellation timeout, not a test keepalive.
      const cancellationBound = [...timers.active.values()][0];
      assert.equal(cancellationBound.due, 130);
      assert.equal(cancellationBound.hasRef(), true);
      await timers.fireNextLive();
    }
    const settled = await pending;
    assert.equal(answer, settled);
    assert.equal(settled.reasonCode, 'runner-deadline');
    assert.equal(settled.workflowRunId, 'exact-workflow-1');
    assert.equal(settled.workflowStatus, cancelledHang ? 'running' : 'cancelled');
    assert.equal(settled.delivery, cancelledHang ? 'uncertain' : 'accepted');
    assert.equal(settled.cleanup, cancelledHang ? 'uncertain' : 'settled');
    assert.equal(settled.exitCode, 1);
    assert.ok(timers.now() <= h.profile.limits.maxRunMs + h.profile.limits.maxCleanupMs);
    assert.equal(timers.active.size, 0);
    assert.equal(h.calls.filter(call => call === 'workflows.cancel').length, 1);
    assert.equal(h.guardDisposed(), 1);
    const cleanupCalls = h.calls.filter(call => ['dispose', 'drain', 'save', 'release'].includes(call));
    if (cancelledHang) {
      assert.ok(h.held());
      assert.ok(!h.calls.includes('release'));
      assert.deepEqual(cleanupCalls.slice(-3), ['dispose', 'drain', 'save']);
    } else {
      assert.equal(h.held(), undefined);
      assert.deepEqual(cleanupCalls.slice(-4), ['dispose', 'drain', 'save', 'release']);
      assert.equal(h.calls.at(-1), 'release');
    }
  } finally { h.cleanup(); }
});

test('unknown model initialization, rejected drain and stuck cancellation retain owner/evidence and cannot return success', async () => {
  for (const scenario of [{ setupHang: true, maxRunMs: 10 }, { drainReject: true }, { outcome: 'hang', cancelledHang: true, maxRunMs: 10 }]) {
    const h = harness(scenario);
    try { const answer = await h.api.runAutomationEvent('/trusted', event); assert.equal(answer.cleanup, 'uncertain'); assert.notEqual(answer.exitCode, 0); assert.ok(h.held()); assert.ok(!h.calls.includes('release')); }
    finally { h.cleanup(); }
  }
});

test('signal cancellation closes exact run; pre-aborted caller has no initialization', async () => {
  const h = harness({ outcome: 'hang', maxRunMs: 1000 });
  const signal = new AbortController();
  try {
    const pending = h.api.runAutomationEvent('/trusted', event, signal.signal);
    const timer = setTimeout(() => signal.abort(), 10);
    const answer = await pending; clearTimeout(timer);
    assert.equal(answer.workflowStatus, 'cancelled'); assert.equal(answer.reasonCode, 'caller-cancelled'); assert.notEqual(answer.exitCode, 0);
    const already = new AbortController(); already.abort();
    const before = h.calls.length;
    assert.equal((await h.api.runAutomationEvent('/trusted', event, already.signal)).reasonCode, 'caller-cancelled');
    assert.equal(h.calls.length, before);
  } finally { h.cleanup(); }
});

test('too-small output profile is rejected before ownership/provider setup, still bounded', async () => {
  const h = harness({ output: 256 });
  try { const answer = await h.api.runAutomationEvent('/trusted', event); assert.equal(answer.reasonCode, 'output-bound-too-small'); assert.ok(Buffer.byteLength(JSON.stringify(answer)) <= 256); assert.ok(!h.calls.includes('acquire')); }
  finally { h.cleanup(); }
});

test('release failure is nonzero uncertainty even after actual completed settled work', async () => {
  const h = harness({ releaseFail: true });
  try { const answer = await h.api.runAutomationEvent('/trusted', event); assert.equal(answer.delivery, 'uncertain'); assert.equal(answer.workflowStatus, 'completed'); assert.equal(answer.cleanup, 'uncertain'); assert.notEqual(answer.exitCode, 0); }
  finally { h.cleanup(); }
});


test('runtime cumulative text and provider request caps charge repeated calls without refunds', async () => {
  for (const scenario of [{ readBurst: true }, { providerBurst: true }]) {
    const h = harness(scenario);
    try {
      const answer = await h.api.runAutomationEvent('/trusted', event);
      assert.equal(answer.reasonCode, scenario.readBurst ? 'read-byte-limit' : 'provider-request-limit');
      assert.notEqual(answer.exitCode, 0); assert.ok(!h.calls.includes('fake-provider-boundary'));
    } finally { h.cleanup(); }
  }
});

test('already-resolved microtasks cannot starve the synchronous policy deadline fence', async () => {
  const h = harness({ microtaskStarve: true, maxRunMs: 10 });
  try { const answer = await h.api.runAutomationEvent('/trusted', event); assert.equal(answer.reasonCode, 'runner-deadline'); assert.notEqual(answer.exitCode, 0); assert.ok(!h.calls.includes('fake-provider-boundary')); }
  finally { h.cleanup(); }
});

test('signal bounds unknown SDK setup independently of long runner deadline; pending define also retains owner', async () => {
  const h = harness({ setupHang: true, maxRunMs: 1000 });
  const abort = new AbortController();
  try {
    const began = Date.now(); const timer = setTimeout(() => abort.abort(), 10);
    const answer = await h.api.runAutomationEvent('/trusted', event, abort.signal); clearTimeout(timer);
    assert.ok(Date.now() - began < 500); assert.equal(answer.cleanup, 'uncertain'); assert.ok(h.held());
  } finally { h.cleanup(); }
  const pending = harness({ defineHang: true, maxRunMs: 10 });
  try { const answer = await pending.api.runAutomationEvent('/trusted', event); assert.equal(answer.cleanup, 'uncertain'); assert.ok(pending.held()); assert.ok(!pending.calls.includes('workflows.start')); }
  finally { pending.cleanup(); }
});

test('synchronous final checkpoint crossing cleanup deadline keeps owner and reports honest nonzero uncertainty', async () => {
  const h = harness({ finalSaveDelayMs: 50 });
  try { const answer = await h.api.runAutomationEvent('/trusted', event); assert.equal(answer.workflowStatus, 'completed'); assert.equal(answer.cleanup, 'uncertain'); assert.equal(answer.reasonCode, 'cleanup-deadline'); assert.notEqual(answer.exitCode, 0); assert.ok(h.held()); assert.ok(!h.calls.includes('release')); }
  finally { h.cleanup(); }
});

test('SDK-style access then consuming read delivers exact UTF8 budget once; repeated access never consumes', async () => {
  const text = 'aé'; // Three UTF8 bytes, not JavaScript character count.
  const h = harness({ readText: text, maxReadBytes: Buffer.byteLength(text), scopedExercise(native, profile, calls) {
    const path = resolve(profile.projectRoot, 'public.txt');
    const before = calls.filter(c => c === 'guard').length;
    for (let i = 0; i < 3; i++) assert.equal(native.scopedAccess(path), undefined);
    assert.ok(calls.filter(c => c === 'guard').length >= before + 6); // Before AND after each access.
    assert.equal(calls.filter(c => c === 'scoped-text-read').length, 0);
    assert.equal(native.scopedRead(path), text);
    assert.equal(calls.filter(c => c === 'scoped-text-read').length, 1);
  } });
  try { const answer = await h.api.runAutomationEvent('/trusted', event); assert.equal(h.exerciseError(), undefined); assert.equal(answer.exitCode, 0); }
  finally { h.cleanup(); }
});

test('repeated access/read sequences charge exactly two text deliveries at cumulative boundary and reject third', async () => {
  const h = harness({ maxReadBytes: 6, scopedExercise(native, profile, calls) {
    const path = resolve(profile.projectRoot, 'public.txt');
    for (let i = 0; i < 2; i++) { assert.equal(native.scopedAccess(path), undefined); assert.equal(native.scopedRead(path), 'abc'); }
    assert.equal(native.scopedAccess(path), undefined);
    assert.throws(() => native.scopedRead(path), /read-byte-limit/);
    // The real reader still runs (descriptor/hash/text checks) before refusing overdelivery.
    assert.equal(calls.filter(c => c === 'scoped-text-read').length, 3);
  } });
  try { const answer = await h.api.runAutomationEvent('/trusted', event); assert.equal(h.exerciseError(), undefined); assert.equal(answer.reasonCode, 'read-byte-limit'); assert.notEqual(answer.exitCode, 0); }
  finally { h.cleanup(); }
});

test('access and consuming read reject outside root, unapproved paths and noncanonical aliases before reader', async () => {
  const h = harness({ scopedExercise(native, profile, calls) {
    for (const path of [resolve(profile.projectRoot, '../outside.txt'), resolve(profile.projectRoot, 'other.txt'),
      'public.txt', `${profile.projectRoot}/./public.txt`, `${profile.projectRoot}/nested/../public.txt`]) {
      assert.throws(() => native.scopedAccess(path), /read-outside-scope/);
      assert.throws(() => native.scopedRead(path), /read-outside-scope/);
    }
    assert.equal(calls.filter(c => c === 'scoped-text-read').length, 0);
  } });
  try { const answer = await h.api.runAutomationEvent('/trusted', event); assert.equal(h.exerciseError(), undefined); assert.equal(answer.exitCode, 0); }
  finally { h.cleanup(); }
});

for (const operation of ['scopedAccess', 'scopedRead']) for (const phase of ['before', 'after']) {
  for (const failure of ['deadline', 'cancel', 'owner', 'policy']) test(`${operation} ${phase} policy fence rejects ${failure} without text delivery`, async () => {
    const cancellation = new AbortController();
    let observed = false;
    const h = harness({ maxRunMs: 1000, scopedExercise(native, profile, calls, fences) {
      // assertPolicy performs four identity checks. The fifth is the first post-operation guard.
      fences.onGuard(phase === 'before' ? 1 : 5, () => {
        if (failure === 'deadline') fences.expire();
        else if (failure === 'cancel') cancellation.abort();
        else if (failure === 'owner') fences.loseOwner();
        else throw new Error('controlled-policy-change');
      });
      assert.throws(() => native[operation](resolve(profile.projectRoot, 'public.txt')),
        failure === 'owner' ? /owner-unavailable/ : failure === 'policy' ? /controlled-policy-change/ : /abort/i);
      observed = true;
      assert.equal(calls.filter(c => c === 'scoped-text-read').length, operation === 'scopedRead' && phase === 'after' ? 1 : 0);
    } });
    try {
      const answer = await h.api.runAutomationEvent('/trusted', event, cancellation.signal);
      assert.equal(h.exerciseError(), undefined); assert.equal(observed, true);
      if (failure !== 'policy') { assert.notEqual(answer.exitCode, 0); assert.ok(!h.calls.includes('fake-provider-boundary')); }
    } finally { h.cleanup(); }
  });
}

test('inert checkpoint option adds neither recovery authorization nor a reusable native source seal', async () => {
  // Static boundary proof only; the factory fake does not certify core checkpoint execution.
  assert.doesNotMatch(source, /workflowRecovery|workflows\.recovery|verifiedDeadOwner|sourceConfig|knownHash|reuseEligible/);
  const h = harness();
  try {
    const answer = await h.api.runAutomationEvent('/trusted/operator', event);
    assert.equal(answer.exitCode, 0);
    assert.equal(h.calls.filter(call => call === 'acquire').length, 1);
    assert.equal(h.calls.filter(call => call === 'release').length, 1);
    assert.deepEqual(h.calls.filter(call => call.startsWith('workflows.')), ['workflows.define', 'workflows.start']);
    assert.equal(h.calls.at(-1), 'release');
    const before = h.calls.length;
    const inspected = await h.api.inspectAutomationEvent('/trusted/operator', event);
    assert.equal(inspected.delivery, 'duplicate');
    for (const call of h.calls.slice(before)) assert.ok(!['acquire', 'release', 'save', 'control', 'runtime-create'].includes(call));
  } finally { h.cleanup(); }
});

for (const quota of ['read-byte-limit', 'provider-request-limit']) test(`caught ${quota} cancels the exact bound run and run/status/report duplicates stay nonzero without replay`, async t => {
  const h = harness({ maxReadBytes: 6, scopedExercise(native, profile, calls) {
    if (quota === 'read-byte-limit') {
      const path = resolve(profile.projectRoot, 'public.txt');
      assert.equal(native.scopedRead(path), 'abc');
      assert.equal(native.scopedRead(path), 'abc');
      assert.throws(() => native.scopedRead(path), /read-byte-limit/);
      assert.equal(calls.filter(c => c === 'scoped-text-read').length, 3);
    } else {
      profile.limits.maxProviderRequests = 1;
      native.beforeProviderRequest();
      assert.throws(() => native.beforeProviderRequest(), /provider-request-limit/);
    }
    // Like the SDK, catch the tool/preparation error. The runner must stop policy
    // execution itself, not rely on an exception escaping the native caller.
  } });
  try {
    const first = await h.api.runAutomationEvent('/trusted', event);
    assert.equal(h.exerciseError(), undefined);
    t.diagnostic(JSON.stringify({ quota, first, ownerRetained: !!h.held() }));
    assert.equal(first.reasonCode, quota);
    assert.equal(first.exitCode, 1);
    assert.equal(first.workflowRunId, 'exact-workflow-1');
    assert.ok(['cancelled', 'failed', 'needs-attention'].includes(first.workflowStatus));
    assert.equal(h.runnerSignal()?.aborted, true);
    assert.ok(h.calls.includes('workflows.cancel'));
    assert.ok(!h.calls.includes('fake-provider-boundary'));
    // Synchronous fake start may abort before bounded(start) resolves: never
    // turn that setup uncertainty into a claimed settled/released owner.
    if (first.cleanup === 'uncertain') { assert.ok(h.held()); assert.ok(!h.calls.includes('release')); }
    const before = h.calls.length;
    const stateBefore = clone(h.state());
    for (const operation of ['run', 'status', 'report']) {
      const duplicate = await h.api[operation === 'run' ? 'runAutomationEvent' : 'inspectAutomationEvent']('/trusted', event);
      assert.equal(duplicate.delivery, 'duplicate');
      assert.equal(duplicate.workflowRunId, first.workflowRunId);
      assert.equal(duplicate.workflowStatus, first.workflowStatus);
      assert.notEqual(duplicate.exitCode, 0);
    }
    assert.deepEqual(h.state(), stateBefore);
    for (const call of h.calls.slice(before)) assert.ok(!['acquire', 'runtime-create', 'runtime-key', 'control', 'reserve', 'workflows.start', 'fake-provider-boundary', 'scoped-text-read', 'save', 'release'].includes(call));
    assert.equal(h.calls.filter(call => call === 'acquire').length, 1);
  } finally { h.cleanup(); }
});
