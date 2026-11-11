import assert from 'node:assert/strict';
import test from 'node:test';
import { ACTIVITY_LIMITS, createActivityChannel, createNativeActivityRecorder, activityLineage, EMPTY_NATIVE_ACTIVITY, projectActivity, UNAVAILABLE_WORKFLOW_ACTIVITY } from '../activity.js';
import type { ActivityLineage, NativeActivityMember, NativeActivityRun, WorkflowActivityRun, WorkflowActivityUnit } from '../activity.js';
const stamp = '2026-10-07T00:00:00.000Z', now = Date.parse(stamp);
const lineage: ActivityLineage = { workflowRunId: 'wf', familyId: 'family', attemptNo: 2, stepId: 'step', unitId: 'unit', inputHash: 'hash' };
function member(extra: Partial<NativeActivityMember> = {}): NativeActivityMember {
  return { parentRunId: 'native', memberRunId: 'native', taskId: 'task', piSessionId: 'session', agentDefinitionId: 'worker',
    phase: 'working', cleanup: 'pending', attachment: 'attached', observedExecution: true, ...extra };
}
function native(extra: Partial<NativeActivityRun> = {}): NativeActivityRun {
  return { runId: 'native', startedAt: stamp, phase: 'working', local: true, members: [member()], ...extra };
}
function unit(extra: Partial<WorkflowActivityUnit> = {}): WorkflowActivityUnit {
  return { ...lineage, status: 'running', kind: 'native', cleanup: 'pending', admitted: true, nativeRunId: 'native', nativeTaskId: 'task', reused: false, ...extra };
}
function workflow(extra: Partial<WorkflowActivityRun> = {}): WorkflowActivityRun {
  return { workflowRunId: 'wf', familyId: 'family', attemptNo: 2, definitionId: 'definition', startedAt: stamp, updatedAt: stamp,
    status: 'running', recovered: false, local: true, cleanup: 'pending', uncertain: false,
    progress: { basis: 'top-level-steps', total: 2, completed: 0, reused: 0, failed: 0, skipped: 0, cancelled: 0, unverified: 0, reusedUnits: 0 }, units: [unit()], ...extra };
}
function project(n: NativeActivityRun[] = [], w: WorkflowActivityRun[] = [], at = now, previous?: string) {
  return projectActivity({ revision: 1, runs: n, clipped: false }, { revision: 1, available: true, uncertain: false, runs: w, clipped: false }, at, previous);
}
test('channel caches immutable DTO, non-eager subscribe and isolated/coalesced invalidation', async () => {
  const channel = createActivityChannel({ nested: { value: 1 } }); let calls = 0;
  assert.equal(channel.source.snapshot(), channel.source.snapshot()); assert(Object.isFrozen(channel.source.snapshot().nested));
  const remove = channel.source.subscribe(() => { calls++; throw new Error('observer'); }); assert.equal(calls, 0);
  channel.publish({ nested: { value: 2 } }); channel.publish({ nested: { value: 3 } }); assert.equal(calls, 0);
  await Promise.resolve(); assert.equal(calls, 1); assert.equal(channel.source.snapshot().nested.value, 3);
  remove(); remove(); channel.publish({ nested: { value: 4 } }); await Promise.resolve(); assert.equal(calls, 1);
});
test('SDK proof only: persisted running, session retention, handled prompt, retries and cancellation are not working', () => {
  assert.equal(project([native()]).counts.working, 1);
  for (const change of [{ observedExecution: false }, { attachment: 'disposed' as const }, { piSessionId: undefined },
    { phase: 'retry-wait' as const }, { phase: 'starting' as const }, { phase: 'cleanup' as const }, { cleanup: 'unknown' as const }]) {
    assert.equal(project([native({ members: [member(change)] })]).counts.working, 0);
  }
  assert.equal(project([native({ phase: 'cancelling' })]).counts.working, 0);
  assert.equal(project([native({ local: false })]).counts.working, 0);
  assert.equal(project([], [workflow()]).counts.working, 0);
});
test('standalone/team workers count actual sessions, not orchestration or queued leader guesses', () => {
  const p = project([native({ teamId: 'team', members: [member(), member({ memberRunId: 'two', piSessionId: 'two' }),
    member({ memberRunId: 'queue', piSessionId: undefined, phase: 'queued', observedExecution: false })] })]);
  assert.equal(p.counts.working, 2); assert.equal(p.counts.queuedAgents, 1); assert.equal(p.moreRuns, 0); assert.equal(p.detail.length, 2);
});
test('identical native routing aliases deduplicate and conflicting aliases suppress computation', () => {
  assert.equal(project([native({ members: [member(), member()] })]).counts.working, 1);
  const p = project([native({ members: [member(), member({ observedExecution: false })] })]);
  assert.equal(p.counts.working, 0); assert.equal(p.counts.unknown, 1); assert.equal(p.focus?.phase, 'unknown');
});
test('full native/run/task and both lineage records join once; missing or unequal fields never wildcard', () => {
  const n = native({ members: [member({ lineage, taskLineage: lineage })] });
  const p = project([n], [workflow()]); assert.equal(p.counts.working, 1); assert.equal(p.moreRuns, 0);
  assert.equal(p.focus?.key, 'workflow:wf'); assert.equal(p.focus?.phase, 'working');
  for (const field of ['workflowRunId', 'familyId', 'attemptNo', 'stepId', 'unitId', 'inputHash', 'blockId', 'iterationId', 'iterationNo'] as const) {
    const bad = { ...lineage, [field]: typeof lineage[field] === 'number' ? 9 : 'different' };
    assert.equal(project([native({ members: [member({ lineage, taskLineage: bad })] })], [workflow()]).counts.working, 0, field);
  }
  for (const changes of [{ nativeRunId: 'wrong' }, { nativeTaskId: 'wrong' }, { reused: true }]) {
    assert.equal(project([n], [workflow({ units: [unit(changes)] })]).counts.working, 0);
  }
  assert.equal(project([native({ members: [member({ lineage })] })], [workflow()]).counts.working, 0);
});
test('recovered/history/reused/ambiguous units never new workers; exact live continuation remains work', () => {
  const n = native({ members: [member({ lineage, taskLineage: lineage })] });
  for (const changes of [{ recovered: true }, { local: false }, { units: [unit({ reused: true })] }]) {
    assert.equal(project([n], [workflow(changes)]).counts.working, 0);
  }
  assert.equal(project([n], [workflow({ recoveryOf: 'old' })]).counts.working, 1);
  assert.equal(project([n], [workflow({ units: [unit(), unit({ unitId: 'other' })] })]).counts.working, 1);
});
test('queue bases/check/application/approval/cleanup are distinct and check receipt is not running check', () => {
  const w = workflow({ units: [unit({ nativeRunId: undefined, phase: 'check' }), unit({ unitId: 'apply', nativeRunId: undefined, phase: 'applying' }),
    unit({ unitId: 'approval', nativeRunId: undefined, approvalStatus: 'pending', cleanup: 'settled' }),
    unit({ unitId: 'queue', status: 'queued', admitted: false, nativeRunId: undefined })] });
  const p = project([], [w]); assert.equal(p.counts.working, 0); assert.equal(p.counts.checking, 1); assert.equal(p.counts.applying, 1);
  assert.equal(p.counts.waitingApproval, 1); assert.equal(p.counts.queuedUnits, 1); assert.equal(p.counts.queuedAgents, 0); assert.equal(p.counts.cleanup, 0);
  assert.equal(p.focus?.phase, 'waiting-approval');
  assert.equal(project([], [workflow({ units: [unit({ phase: 'check-receipt' })] })]).counts.checking, 0);
});
test('paused workflow with truly executing child is not falsely stopped or double counted', () => {
  const p = project([native({ members: [member({ lineage, taskLineage: lineage })] })], [workflow({ status: 'paused' })]);
  assert.equal(p.counts.working, 1); assert.equal(p.focus?.phase, 'paused'); assert.equal(p.moreRuns, 0);
});
test('attention first, stable exact previous focus within priority, oldest live and no update carousel', () => {
  const a = native({ runId: 'a', startedAt: '2026-10-06T00:00:00Z' }), b = native({ runId: 'b', members: [member({ memberRunId: 'b', piSessionId: 'b' })] });
  assert.equal(project([b, a]).focus?.runId, 'a'); assert.equal(project([a, b], [], now, 'native:b').focus?.runId, 'b');
  assert.equal(project([a], [workflow({ status: 'failed', cleanup: 'settled', units: [] })]).focus?.phase, 'failed');
  assert.equal(project([a], [workflow({ units: [unit({ approvalStatus: 'pending' })] })]).focus?.phase, 'waiting-approval');
  assert.equal(project([a], [workflow({ local: false, status: 'failed', cleanup: 'settled', units: [] })]).focus?.runId, 'a');
});
test('5s grace only local observed completed and settled cleanup, never restored history', () => {
  const w = workflow({ status: 'completed', cleanup: 'settled', units: [] });
  assert.equal(project([], [w], now + 4999).focus?.phase, 'completed'); assert.equal(project([], [w], now + 5000).focus, undefined);
  assert.equal(project([], [workflow({ ...w, local: false })]).focus, undefined);
  assert.equal(project([native({ phase: 'completed', endedAt: stamp, members: [member({ phase: 'completed', cleanup: 'pending' })] })]).focus?.phase, 'cleanup');
  assert.equal(project([native({ phase: 'completed', endedAt: stamp, members: [member({ phase: 'completed', cleanup: 'unknown' })] })]).focus?.phase, 'unknown');
});
test('fixed/dynamic progress retained without inventing denominator and projector does not freeze inputs', () => {
  const w = workflow(); const p = project([], [w]); assert.equal(p.focus?.progress?.total, 2); assert.equal(Object.isFrozen(w.progress), false);
  w.progress.total = null; w.progress.reusedUnits = 2; assert.equal(project([], [w]).focus?.progress?.total, null);
  assert.equal(p.focus?.progress?.reusedUnits, 0); assert(Object.isFrozen(p));
});
test('hard observer bounds clip lower counts and keep only attention8/detail2/focus', () => {
  const runs = Array.from({ length: 40 }, (_, i) => native({ runId: `${i}`, phase: 'failed', members: [member({ memberRunId: `${i}`, piSessionId: `${i}` })] }));
  const p = project(runs); assert(p.clipped); assert(p.attention.length <= ACTIVITY_LIMITS.attention); assert(p.detail.length <= 2);
  const many = Array.from({ length: 300 }, (_, i) => member({ memberRunId: `${i}`, piSessionId: `${i}` }));
  const bounded = project([native({ members: many })]); assert.equal(bounded.counts.working, 256); assert(bounded.clipped);
  assert.deepEqual(projectActivity(EMPTY_NATIVE_ACTIVITY, UNAVAILABLE_WORKFLOW_ACTIVITY, now).counts, {
    working: 0, starting: 0, queuedAgents: 0, queuedUnits: 0, waitingApproval: 0, checking: 0, applying: 0, cleanup: 0, unknown: 0 });
});

test('superseded settled failure does not steal current attempt focus, source uncertainty is not erased', () => {
  const old = workflow({ status: 'failed', cleanup: 'settled', units: [], supersededBy: 'next' });
  const next = workflow({ workflowRunId: 'next', attemptNo: 3, units: [] });
  assert.equal(project([], [old, next]).focus?.runId, 'next');
  assert.equal(project([], [workflow({ ...old, uncertain: true, cleanup: 'unknown' }), next]).focus?.runId, 'wf');
});
test('workflow-unit identity must agree with its owning run, not just native metadata', () => {
  const n = native({ members: [member({ lineage, taskLineage: lineage })] });
  for (const changes of [{ workflowRunId: 'other' }, { familyId: 'other' }, { attemptNo: 3 }]) {
    assert.equal(project([n], [workflow(changes)]).counts.working, 0);
  }
});

test('native proof does not turn workflow cleanup/unverified or terminal units into useful computation', () => {
  const n = native({ members: [member({ lineage, taskLineage: lineage })] });
  for (const u of [unit({ status: 'unverified', cleanup: 'unknown', admitted: false }), unit({ status: 'completed', cleanup: 'settled', admitted: false })]) {
    assert.equal(project([n], [workflow({ units: [u] })]).counts.working, 0);
  }
  assert.equal(project([n], [workflow({ uncertain: true })]).counts.working, 0);
});


test('unsettled cleanup obligation while working is not itself a cleaning-up phase', () => {
  assert.equal(project([native()]).counts.cleanup, 0);
  assert.equal(project([], [workflow()]).counts.cleanup, 0);
  assert.equal(project([native({ phase: 'cancelling', members: [member({ phase: 'cancelling' })] })]).counts.cleanup, 1);
  assert.equal(project([], [workflow({ status: 'cancelling' })]).counts.cleanup, 1);
});

test('unknown cleanup is inactive/static uncertainty, never an active cleanup count', () => {
  const nativeUnknown = project([native({ phase: 'unknown', members: [member({ phase: 'unknown', cleanup: 'unknown', observedExecution: false })] })]);
  assert.equal(project([native({ members: [member({ cleanup: 'unknown' })] })]).counts.unknown, 1);
  assert.equal(nativeUnknown.counts.working, 0); assert.equal(nativeUnknown.counts.cleanup, 0); assert.equal(nativeUnknown.counts.unknown, 1);
  const wfUnknown = project([], [workflow({ cleanup: 'unknown', status: 'needs-attention', units: [unit({ status: 'unverified', cleanup: 'unknown', admitted: false })] })]);
  assert.equal(wfUnknown.counts.cleanup, 0); assert.equal(wfUnknown.counts.unknown, 1);
  assert.equal(project([], [workflow({ ...workflow(), local: false, cleanup: 'unknown', uncertain: true })]).counts.cleanup, 0);
});
test('same physical Pi session across different native tuples is ambiguous, not two live workers', () => {
  const p = project([native({ members: [member(), member({ parentRunId: 'other-parent', memberRunId: 'other-member' })] })]);
  assert.equal(p.counts.working, 0); assert.equal(p.counts.unknown, 2); assert.equal(p.detail.length, 0); assert.equal(p.focus?.phase, 'unknown');
  const acrossRuns = project([native(), native({ runId: 'other', members: [member({ parentRunId: 'other', memberRunId: 'other' })] })]);
  assert.equal(acrossRuns.counts.working, 0); assert.equal(acrossRuns.counts.unknown, 2);
});
test('raw apply phase recognized only when genuinely admitted/running with pending settlement', () => {
  const applying = project([], [workflow({ units: [unit({ kind: 'coding', phase: 'apply' })] })]);
  assert.equal(applying.counts.applying, 1); assert.equal(applying.counts.working, 0); assert.equal(applying.focus?.phase, 'applying');
  for (const changes of [{ admitted: false }, { status: 'completed' }, { cleanup: 'settled' as const }, { approvalStatus: 'pending' }]) {
    assert.equal(project([], [workflow({ units: [unit({ kind: 'coding', phase: 'apply', ...changes })] })]).counts.applying, 0);
  }
});
test('native member access is bounded even during terminal grace/cleanup/focus derivation', () => {
  const members = Array.from({ length: 257 }, (_, i) => member({ memberRunId: `${i}`, piSessionId: `${i}`, phase: 'completed', cleanup: 'settled' }));
  let beyondCap = 0; Object.defineProperty(members, 256, { get() { beyondCap++; return member(); } });
  const p = project([native({ phase: 'completed', endedAt: stamp, members })]);
  assert.equal(beyondCap, 0); assert(p.clipped); assert.equal(p.focus, undefined);
  Object.defineProperty(members, 'some', { value() { throw new Error('unbounded some'); } });
  Object.defineProperty(members, 'every', { value() { throw new Error('unbounded every'); } });
  assert(project([native({ members })]).clipped);
});

test('optional real labels are copied bounded to focus, never used as execution proof', () => {
  assert.equal(project([native({ label: 'Actual team label' })]).focus?.label, 'Actual team label');
  assert.equal(project([], [workflow({ label: 'Actual definition label' })]).focus?.label, 'Actual definition label');
  assert.equal(project([], [workflow({ label: 'x'.repeat(200) })]).focus?.label?.length, 128);
  assert.equal(project([native()]).focus?.label, undefined);
  assert.equal(project([native({ label: 'editing/testing', members: [member({ observedExecution: false })] })]).counts.working, 0);
});


test('primitive recorder caches real boundaries; queue, retry, cancellation and retained handles are not work', async () => {
  const r = createNativeActivityRecorder();
  r.begin({ runId: 'native', taskId: 'task', startedAt: stamp, phase: 'starting' });
  r.member('native', member({ phase: 'queued', piSessionId: undefined, attachment: undefined, observedExecution: false }));
  const p = () => projectActivity(r.source.snapshot(), UNAVAILABLE_WORKFLOW_ACTIVITY, now);
  assert.equal(p().counts.queuedAgents, 1); assert.equal(p().counts.working, 0);
  r.patch('native', 'native', { phase: 'starting', piSessionId: 'session', attachment: 'attached' });
  assert.equal(p().counts.starting, 1); assert.equal(p().counts.working, 0);
  for (const event of ['agent_start', 'compaction_start', 'summarization_retry_attempt_start']) {
    r.event('native', 'native', event); assert.equal(p().counts.working, 1); assert.equal(p().counts.cleanup, 0);
    r.event('native', 'native', 'agent_end'); assert.equal(p().counts.working, 0);
  }
  for (const event of ['auto_retry_start', 'summarization_retry_scheduled']) {
    r.event('native', 'native', event); assert.equal(p().counts.working, 0); assert.equal(p().focus?.phase, 'retry-wait');
  }
  r.event('native', 'native', 'agent_start'); r.cancel('native');
  assert.equal(p().counts.working, 0); assert.equal(p().counts.cleanup, 1);
  r.event('native', 'native', 'agent_start'); assert.equal(p().counts.working, 0);
  r.patch('native', 'native', { cleanup: 'unknown', attachment: 'unavailable' });
  assert.equal(p().counts.cleanup, 0); r.finish('native', 'cancelled', stamp);
  assert.equal(p().focus?.phase, 'unknown');
});
test('recorder stores only bounded observer primitives without freezing canonical lineage or task/SDK payloads', () => {
  const r = createNativeActivityRecorder(), canonical = { ...lineage };
  r.begin({ runId: 'native', startedAt: stamp, phase: 'starting', label: 'x'.repeat(1000), sdk: {} } as any);
  r.member('native', { ...member(), lineage: canonical, taskLineage: canonical, task: 'SECRET', sdk: {} } as any);
  r.patch('native', 'native', { lineage: canonical, taskLineage: canonical, sdk: {} } as any);
  const snap = r.source.snapshot(); assert.equal(Object.isFrozen(canonical), false);
  assert.equal(snap.runs[0].label?.length, 128); assert.equal(Object.hasOwn(snap.runs[0], 'sdk'), false);
  assert.equal(Object.hasOwn(snap.runs[0].members[0], 'sdk'), false); assert.equal(Object.hasOwn(snap.runs[0].members[0], 'task'), false);
  canonical.unitId = 'changed'; assert.equal(snap.runs[0].members[0].lineage?.unitId, 'unit');
  for (let i = 0; i < 300; i++) r.member('native', member({ memberRunId: `member-${i}`, piSessionId: `session-${i}` }));
  assert.equal(r.source.snapshot().runs[0].members.length, 256); assert(r.source.snapshot().clipped);
  for (let i = 0; i < 40; i++) r.begin({ runId: `run-${i}`, startedAt: stamp, phase: 'starting' });
  assert.equal(r.source.snapshot().runs.length, 32); assert(r.source.snapshot().clipped);
  assert.equal(activityLineage({ ...lineage, attemptNo: 0 }), undefined);
});

// Offline execution of the actual index wiring with intercepted module dependencies.
// No compiled file, SDK session, host prototype, preferences file, provider or PTY is created.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { createClankersStateContainer, createClankersState, replaceSharedClankersState, } from '../state.js';
import type { ClankersSubagentControlAdapter } from '../types.js';
const indexUrl = new URL('../index.ts', import.meta.url), indexRequire = createRequire(indexUrl);
const indexCode = transpileModule(readFileSync(indexUrl, 'utf8').replaceAll('import.meta.url', JSON.stringify(indexUrl.href)), {
  compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true },
}).outputText;
const indexModules = new Map<string, any>();
for (const [, id] of indexCode.matchAll(/require\("(\.\/[^"]+)"\)/g)) {
  if (!id.startsWith('./ui/') && id !== './internal-patch.js' && !indexModules.has(id)) {
    indexModules.set(id, await import(new URL(id.replace(/\.js$/, '.ts'), indexUrl).href));
  }
}
function indexHarness(extra: Record<string, unknown> = {}) {
  const events = new Map<string, Set<(...args: any[]) => any>>(), commands = new Map<string, any>();
  let preferencesCreated = 0, shortcutsCreated = 0, workflowCreated = 0, overlayCalls = 0;
  const backgroundOptions: any[] = [], attachments: any[] = [], hints: any[] = [], visibility: boolean[] = [];
  const shortcutOptions: any[] = [], shortcutEvents: string[] = [];
  const preferences = { snapshot: () => ({ desired: { activityStrip: true, managementShortcut: 'alt+j' } }) };
  const settings = { snapshot: () => ({ activityStrip: true, active: 'alt+g', desired: 'alt+j', pending: true }),
    subscribe: () => () => {}, saveHuman: () => { throw new Error('No preference writes permitted'); } };
  const requireFake = (id: string): any => {
    if (Object.hasOwn(extra, id)) return extra[id];
    if (id === '@earendil-works/pi-coding-agent') return {};
    if (id === 'node:fs') return { ...indexRequire(id), mkdirSync() {}, writeFileSync() { throw new Error('No writes'); } };
    if (id === './internal-patch.js') return { installInternalPatch: () => ({ installed: false, emit() {}, dispose() {} }) };
    if (id === './ui/preferences.js') return { createUiPreferences() { preferencesCreated++; return preferences; } };
    if (id === './ui/management-shortcut.js') return { createManagementShortcutController(options: any) {
      shortcutsCreated++; shortcutOptions.push(options);
      return { settings, attach() { shortcutEvents.push('attach'); }, detach() { shortcutEvents.push('detach'); },
        setTui(tui: unknown) { shortcutEvents.push(tui ? 'tui' : 'no-tui'); }, promptStart() { shortcutEvents.push('prompt-start'); },
        promptEnd() { shortcutEvents.push('prompt-end'); }, dispose() { shortcutEvents.push('dispose'); } };
    } };
    if (id === './ui/background-activity.js') return { createBackgroundActivityController(options: any) {
      backgroundOptions.push(options);
      return { attach(ctx: any) { attachments.push(ctx); options.onTui({ hasOverlay: () => false, getFocusedComponent: () => ({}) });
        let dead = false; return () => { if (!dead) { dead = true; options.onTui(undefined); } }; },
        setVisible(v: boolean) { visibility.push(v); }, setActiveShortcut(v: unknown) { hints.push(v); }, dispose() {} };
    } };
    if (id === './ui/management-overlay.js') return { openClankersManagementOverlay(ctx: any, options: any) { overlayCalls++; return ctx.ui.custom(options); } };
    if (id.startsWith('./ui/')) return {}; // unrelated viewers are not part of these offline wiring tests
    if (id === './workflow-runtime.js') return { ...indexModules.get(id), createWorkflowService(...args: any[]) { workflowCreated++; return indexModules.get(id).createWorkflowService(...args); } };
    return indexModules.get(id) ?? indexRequire(id);
  };
  const module = { exports: {} as any };
  const internals = new Function('require', 'module', 'exports', indexCode + `
    return { createPiNativeAdapter, runSinglePiNativeAgent, runPiNativeClankersRequest, createPiNativeActiveRun,
      workflowControlServices, managementOpeners, requestPiNativeAbort,
      setSessionFactory(factory) { createPiNativeSession = factory; },
      setHandoff() { ensurePiNativeHandoff = (_ctx, _run, _id, text) => text ?? 'fake'; }
    };
  `)(requireFake, module, module.exports);
  internals.setHandoff();
  const context: any = { registerCommand(name: string, options: any) { commands.set(name, options.handler); return () => commands.delete(name); },
    registerTool() {}, registerShortcut() {}, on(name: string, cb: (...args: any[]) => any) {
      const listeners = events.get(name) ?? new Set(); events.set(name, listeners); listeners.add(cb); return () => listeners.delete(cb);
    } };
  const emit = async (name: string, ctx: any) => { for (const listener of [...events.get(name) ?? []]) await listener({ type: name }, ctx); };
  return { api: module.exports, internals, context, emit, commands, backgroundOptions, attachments, shortcutOptions, shortcutEvents, hints, visibility,
    metrics: () => ({ preferencesCreated, shortcutsCreated, workflowCreated, overlayCalls }) };
}
function fakeAdapter(): ClankersSubagentControlAdapter & { cancels: number } {
  return { kind: 'fake', cancels: 0, launch() { throw new Error('Observation cannot launch'); }, interrupt() { this.cancels++; return { ok: true, message: 'fake' }; },
    dispose() { this.cancels++; }, listRuns() { throw new Error('Observer cannot scan runs'); }, getRun() { throw new Error('Observer cannot get runs'); } };
}
async function microtasks(n = 16) { for (let i = 0; i < n; i++) await Promise.resolve(); }
test('registration is strict-TUI and lazy: noninteractive/legacy attach never creates prefs/components/ledger', async () => {
  replaceSharedClankersState(createClankersState()); const h = indexHarness(), adapter = fakeAdapter();
  const registration = h.api.registerClankersExtension(h.context, { subagentAdapter: adapter });
  const before = registration.state;
  for (const ctx of [{ mode: 'print', hasUI: false }, { mode: 'json', hasUI: false }, { mode: 'rpc', hasUI: true }, { hasUI: true }, { mode: 'tui', hasUI: true }]) {
    await h.emit('session_start', { ...ctx, ui: {} });
  }
  assert.deepEqual(h.metrics(), { preferencesCreated: 0, shortcutsCreated: 0, workflowCreated: 0, overlayCalls: 0 });
  assert.deepEqual(registration.state, before); assert.equal(adapter.cancels, 0);
  const source = h.internals.workflowControlServices.get(registration.control).activity;
  const snap = source.snapshot(), remove = source.subscribe(() => { throw new Error('observer'); });
  for (let i = 0; i < 100; i++) assert.equal(source.snapshot(), snap);
  assert.equal(h.metrics().workflowCreated, 0); assert.equal(registration.state.extensions.workflows, undefined);
  remove(); registration.dispose();
});
test('real registration wires canonical cached permission count, effective hint, singleton shared opener and observer-only generation cleanup', async () => {
  replaceSharedClankersState(createClankersState()); const h = indexHarness(), adapter = fakeAdapter();
  const registration = h.api.registerClankersExtension(h.context, { subagentAdapter: adapter });
  let release!: () => void; const ui = { setWidget() {}, onTerminalInput() { return () => {}; }, custom() { return new Promise<void>(resolve => { release = resolve; }); } };
  const ctx = { mode: 'tui', hasUI: true, ui, waitForIdle() { throw new Error('No background idle wait'); } };
  await h.emit('session_start', ctx); await h.emit('session_start', ctx);
  assert.equal(h.attachments.length, 1); assert.equal(h.metrics().preferencesCreated, 1); assert.equal(h.metrics().shortcutsCreated, 1);
  assert.equal(h.metrics().workflowCreated, 0); assert.equal(registration.state.extensions.workflows, undefined);
  assert.equal(h.hints.at(-1), 'alt+g'); assert.equal(h.visibility.at(-1), true);
  const permissions = h.backgroundOptions[0].permissions, before = registration.state;
  assert.equal(permissions.snapshot(), 0);
  await h.commands.get('clankers')('permission request tool worker Permission', { mode: 'print', hasUI: false }); await microtasks(); assert.equal(permissions.snapshot(), 1);
  assert.equal(adapter.cancels, 0); assert.equal(h.metrics().workflowCreated, 0);
  const after = registration.state; for (let i = 0; i < 1000; i++) permissions.snapshot(); assert.deepEqual(registration.state, after);
  const a = h.commands.get('clankers')('config', ctx), b = h.commands.get('clankers')('/clankers config', ctx);
  h.shortcutOptions[0].openManagement(ctx); await microtasks(); assert.equal(h.metrics().overlayCalls, 1);
  assert(h.shortcutOptions[0].isOpening()); release(); await a; await b; assert(!h.shortcutOptions[0].isOpening());
  assert.equal(adapter.cancels, 0); assert.deepEqual(registration.state, after);
  await h.emit('ui_prompt_start', ctx); await h.emit('ui_prompt_end', ctx);
  assert(h.shortcutEvents.includes('prompt-start')); assert(h.shortcutEvents.includes('prompt-end'));
  await h.emit('session_start', { ...ctx }); assert.equal(h.attachments.length, 2); assert.equal(h.metrics().preferencesCreated, 1);
  await h.emit('session_shutdown', ctx); const count = h.attachments.length;
  await h.emit('session_start', ctx); assert.equal(h.attachments.length, count); // disposed contexts cannot be revived
  assert.equal(adapter.cancels, 1); // exactly ORIGINAL adapter shutdown owner, not view close/switch
  registration.dispose(); assert.equal(h.shortcutEvents.filter(x => x === 'dispose').length, 1);
  assert.equal(before.extensions.workflows, undefined);
});
test('lazy workflow proxy only attaches after NORMAL service initialization', async () => {
  const h = indexHarness(), container = createClankersStateContainer(), adapter = fakeAdapter();
  const control = h.api.createClankersControl(container, { subagentAdapter: adapter }), service = h.internals.workflowControlServices.get(control);
  let notices = 0; const remove = service.activity.subscribe(() => notices++);
  assert.equal(service.activity.snapshot().available, false); assert.equal(h.metrics().workflowCreated, 0);
  const reply = await service.execute({ action: 'workflows.list' }); assert(reply.ok); await microtasks();
  assert.equal(h.metrics().workflowCreated, 1); assert.equal(service.activity.snapshot().available, true); assert(notices > 0);
  const state = container.snapshot(); for (let i = 0; i < 100; i++) service.activity.snapshot(); assert.deepEqual(container.snapshot(), state);
  control.dispose(); remove(); assert.equal(service.activity.snapshot().available, false);
});

function nativeHarness(options: { failDispose?: boolean } = {}) {
  const h = indexHarness(), r = createNativeActivityRecorder(), active = h.internals.createPiNativeActiveRun('native', r);
  const container = createClankersStateContainer({ agents: { native: { id: 'native', label: 'Worker', kind: 'subagent', status: 'running', metadata: { taskId: 'task' } } },
    tasks: { task: { id: 'task', title: 'not-an-activity-label', status: 'running', updatedAt: stamp } } });
  let listener: ((e: any) => void) | undefined, resolve!: () => void, disposeCalls = 0;
  const completion = new Promise<void>(done => { resolve = done; });
  const session: any = { messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'done' }] }],
    subscribe(cb: (e: any) => void) { listener = cb; return () => { listener = undefined; }; }, bindExtensions: async () => {},
    async prompt(_task: string, opts: any) { assert.deepEqual(Object.keys(opts), ['source']); await completion; },
    dispose() { disposeCalls++; if (options.failDispose) throw new Error('dispose uncertainty'); }, abort: async () => {} };
  const manager = { getSessionFile: () => '/private/fake-session.jsonl', getSessionId: () => 'fake-pi', getCwd: () => '/private', appendCustomEntry() {}, appendSessionInfo() {} };
  h.internals.setSessionFactory(async () => ({ session, sessionManager: manager, tools: [] }));
  r.begin({ runId: 'native', startedAt: stamp, phase: 'starting' });
  const run = { task: 'never-derived-label', runId: 'native', parentRunId: 'native', taskId: 'task',
    request: { agent: 'worker', task: 'never-derived-label' }, options: { nativeActivity: r, now: () => new Date(stamp) }, container, activeRun: active };
  const p = () => projectActivity(r.source.snapshot(), UNAVAILABLE_WORKFLOW_ACTIVITY, now);
  return { h, r, run, session, p, complete: resolve, emit: (type: string) => listener?.({ type }), disposed: () => disposeCalls };
}
test('actual native session subscription wiring reports SDK boundaries and prompt/cleanup, without guessing preprompt work', async () => {
  const n = nativeHarness(); const job = n.h.internals.runSinglePiNativeAgent({}, { id: 'worker', label: 'Worker', source: 'runtime', prompt: '' }, n.run);
  await microtasks(); assert.equal(n.p().counts.working, 0); assert.equal(n.p().counts.starting, 1);
  assert.equal(n.r.source.snapshot().runs[0].members[0].piSessionId, 'fake-pi');
  n.emit('agent_start'); assert.equal(n.p().counts.working, 1);
  n.emit('agent_end'); assert.equal(n.p().counts.working, 0);
  n.emit('auto_retry_start'); assert.equal(n.p().counts.working, 0);
  n.emit('compaction_start'); assert.equal(n.p().counts.working, 1); assert.equal(n.p().focus?.phase, 'compacting');
  n.emit('compaction_end'); assert.equal(n.p().counts.working, 0);
  n.emit('agent_start'); n.emit('agent_settled'); assert.equal(n.p().counts.working, 0); assert.equal(n.p().counts.cleanup, 1); assert.equal(n.p().focus?.phase, 'cleanup');
  n.complete(); const result = await job; assert.equal(result.status, 'done'); assert.equal(n.disposed(), 1);
  assert.equal(n.r.source.snapshot().runs[0].members[0].cleanup, 'settled'); assert.equal(n.p().counts.working, 0);
});
test('native cancellation immediately removes working proof; late SDK events cannot revive computation', async () => {
  const n = nativeHarness(); const job = n.h.internals.runSinglePiNativeAgent({}, { id: 'worker', source: 'runtime', prompt: '' }, n.run);
  await microtasks(); n.emit('agent_start'); assert.equal(n.p().counts.working, 1);
  n.h.internals.requestPiNativeAbort('native', new Map([['native', n.run.activeRun]]));
  assert.equal(n.p().counts.working, 0); n.emit('agent_start'); assert.equal(n.p().counts.working, 0);
  n.complete(); assert.equal((await job).status, 'cancelled'); assert.equal(n.disposed(), 1);
});
test('native cleanup failure is uncertainty, never completed grace or retained-handle work', async () => {
  const n = nativeHarness({ failDispose: true }); const job = n.h.internals.runSinglePiNativeAgent({}, { id: 'worker', source: 'runtime', prompt: '' }, n.run);
  await microtasks(); n.emit('agent_start'); n.complete(); await assert.rejects(job, /dispose uncertainty/);
  n.r.finish('native', 'failed', stamp); assert.equal(n.p().counts.working, 0); assert.equal(n.p().counts.cleanup, 0);
  assert.equal(n.p().focus?.phase, 'unknown'); assert.equal(n.r.source.snapshot().runs[0].members[0].cleanup, 'unknown');
});


test('lazy proxy snapshot failures replace stale working data without invoking owner authority', async () => {
  let refresh!: () => void, broken = false, disposals = 0;
  const h = indexHarness({ './workflow-runtime.js': { createWorkflowService() {
    return { activity: { snapshot() { if (broken) throw new Error('source failed'); return { revision: 1, available: true, uncertain: false, runs: [], clipped: false }; },
      subscribe(cb: () => void) { refresh = cb; return () => {}; } },
      execute: async () => ({ ok: true }), dispose() { disposals++; }, drain: async () => {} };
  } } });
  const control = h.api.createClankersControl(createClankersStateContainer(), { subagentAdapter: fakeAdapter() });
  const service = h.internals.workflowControlServices.get(control); assert.equal(service.activity.snapshot().available, false);
  await service.execute({ action: 'workflows.list' }); assert.equal(service.activity.snapshot().available, true);
  broken = true; refresh(); assert.equal(service.activity.snapshot().available, false); assert.equal(service.activity.snapshot().uncertain, true);
  assert.equal(disposals, 0); control.dispose(); assert.equal(disposals, 1);
});
test('stale/throwing prompt contexts cannot change the current generation or escape observer handling', async () => {
  replaceSharedClankersState(createClankersState()); const h = indexHarness(), adapter = fakeAdapter();
  const registration = h.api.registerClankersExtension(h.context, { subagentAdapter: adapter });
  const old = { mode: 'tui', hasUI: true, ui: { setWidget() {}, onTerminalInput() { return () => {}; } } };
  const current = { ...old, ui: { ...old.ui } };
  await h.emit('session_start', old); await h.emit('session_start', current);
  const count = h.shortcutEvents.length;
  await h.emit('ui_prompt_start', old); await h.emit('ui_prompt_end', old);
  await h.emit('ui_prompt_start', { get mode() { throw new Error('invalidated Pi context'); } });
  assert.equal(h.shortcutEvents.length, count); assert.equal(adapter.cancels, 0);
  await h.emit('ui_prompt_start', { ...current }); await h.emit('ui_prompt_end', { ...current });
  assert.deepEqual(h.shortcutEvents.slice(-2), ['prompt-start', 'prompt-end']); registration.dispose();
});
test('team owner queues workers, never guesses an active leader; actual leader starts only after lanes settle', async () => {
  const n = nativeHarness();
  const definitions = Object.fromEntries(['one', 'two', 'leader'].map(id => [id, { id, label: id, source: 'runtime' as const, prompt: '' }]));
  n.run.container.update({ agentDefinitions: definitions });
  const records: Array<{ id: string; finish(): void }> = []; let disposed = 0;
  n.h.internals.setSessionFactory(async (_sdk: unknown, def: any) => {
    let listener: ((e: any) => void) | undefined, finish!: () => void;
    const done = new Promise<void>(resolve => { finish = resolve; });
    const session = { messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'ok' }] }],
      subscribe(cb: (e: any) => void) { listener = cb; return () => { listener = undefined; }; }, bindExtensions: async () => {},
      async prompt(_task: string, opts: any) { assert.deepEqual(opts, { source: 'extension' }); listener?.({ type: 'agent_start' }); await done; listener?.({ type: 'agent_end' }); },
      dispose() { disposed++; }, abort: async () => {} };
    records.push({ id: def.id, finish });
    return { session, tools: [], sessionManager: { getSessionFile: () => '/private/fake.jsonl', getSessionId: () => `pi-${def.id}`,
      getCwd: () => '/private', appendCustomEntry() {}, appendSessionInfo() {} } };
  });
  const request = { agent: 'leader', task: 'DO NOT INFER editing or testing', memberAgentIds: ['one', 'two'], concurrency: 1 };
  const job = n.h.internals.runPiNativeClankersRequest({}, n.run.container, n.run.options, request, 'native', 'task', 'fresh', n.run.activeRun);
  await microtasks(40); assert.deepEqual(records.map(x => x.id), ['one']); assert.equal(n.p().counts.working, 1); assert.equal(n.p().counts.queuedAgents, 1);
  assert(!n.r.source.snapshot().runs[0].members.some(m => m.agentDefinitionId === 'leader'));
  records[0].finish(); await microtasks(40); assert.deepEqual(records.map(x => x.id), ['one', 'two']); assert.equal(n.p().counts.working, 1);
  records[1].finish(); await microtasks(40); assert.deepEqual(records.map(x => x.id), ['one', 'two', 'leader']); assert.equal(n.p().counts.working, 1);
  records[2].finish(); await job; assert.equal(disposed, 3); assert.equal(n.p().counts.working, 0); assert.equal(n.p().focus?.phase, 'completed');
});
test('native terminal publication failure clears all useful-work proof even when fail publication also throws', async () => {
  const n = nativeHarness(); n.run.container.update({ agentDefinitions: { worker: { id: 'worker', label: 'Worker', source: 'runtime', prompt: '' } } });
  const replace = n.run.container.replace.bind(n.run.container);
  n.run.container.replace = (state: any) => {
    if (['done', 'failed'].includes(state.agents.native?.status)) throw new Error('terminal publication poisoned');
    return replace(state);
  };
  const job = n.h.internals.runPiNativeClankersRequest({}, n.run.container, n.run.options, { agent: 'worker', task: 'literal' }, 'native', 'task', 'fresh', n.run.activeRun);
  await microtasks(); n.emit('agent_start'); assert.equal(n.p().counts.working, 1); n.complete();
  await assert.rejects(job, /terminal publication poisoned/); assert.equal(n.p().counts.working, 0); assert.equal(n.p().focus?.phase, 'unknown');
  assert.equal(n.disposed(), 1);
});
test('view/widget initialization failure never disposes or interrupts the owner and cannot initialize workflows', async () => {
  replaceSharedClankersState(createClankersState());
  const h = indexHarness({ './ui/background-activity.js': { createBackgroundActivityController() { throw new Error('widget failed'); } } });
  const adapter = fakeAdapter(), registration = h.api.registerClankersExtension(h.context, { subagentAdapter: adapter });
  await h.emit('session_start', { mode: 'tui', hasUI: true, ui: { setWidget() {}, onTerminalInput() { return () => {}; } } });
  assert.equal(adapter.cancels, 0); assert.equal(h.metrics().workflowCreated, 0); assert.equal(registration.state.extensions.workflows, undefined);
  await h.emit('session_start', { mode: 'tui', hasUI: true, ui: { setWidget() {}, onTerminalInput() { return () => {}; } } });
  assert.equal(h.metrics().preferencesCreated, 1); assert.equal(h.metrics().shortcutsCreated, 1); // no partial-observer leak on retries
  registration.dispose(); assert.equal(adapter.cancels, 1);
});
