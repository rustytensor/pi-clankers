import assert from 'node:assert/strict';
import test from 'node:test';
import type { Theme } from '@earendil-works/pi-coding-agent';
import type { Component, TUI } from '@earendil-works/pi-tui';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { createBackgroundActivityController, renderBackgroundActivity, sanitizeActivityLabel, BACKGROUND_ACTIVITY_WIDGET } from '../../ui/background-activity.js';
import type { BackgroundActivityClock, BackgroundActivityContext } from '../../ui/background-activity.js';
import { EMPTY_NATIVE_ACTIVITY, UNAVAILABLE_WORKFLOW_ACTIVITY, projectActivity } from '../../activity.js';
import type { ActivitySource, NativeActivitySnapshot, NativeActivityRun, WorkflowActivityRun, WorkflowActivitySnapshot, ActivityProjection } from '../../activity.js';

class Clock implements BackgroundActivityClock {
  time = 100_000; next = 0;
  jobs = new Map<number, { at: number; fn: () => void }>();
  now = () => this.time;
  setTimeout = (fn: () => void, delay: number) => { const id = ++this.next; this.jobs.set(id, { at: this.time + delay, fn }); return id; };
  clearTimeout = (id: unknown) => { this.jobs.delete(id as number); };
  advance(ms: number) {
    const end = this.time + ms;
    for (;;) {
      const entry = [...this.jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      this.time = entry[1].at; this.jobs.delete(entry[0]); entry[1].fn();
    }
    this.time = end;
  }
}
class Source<T> implements ActivitySource<T> {
  reads = 0; listeners = new Set<() => void>(); failRead = false; failSubscribe = false; failUnsubscribe = false;
  constructor(public value: T) {}
  snapshot() { this.reads++; if (this.failRead) throw Error('read'); return this.value; }
  subscribe(fn: () => void) { if (this.failSubscribe) throw Error('subscribe'); this.listeners.add(fn); return () => { this.listeners.delete(fn); if (this.failUnsubscribe) throw Error('unsubscribe'); }; }
  emit() { for (const fn of this.listeners) fn(); }
}
function run(id = 'r', phase: NativeActivityRun['phase'] = 'working', local = true): NativeActivityRun {
  return { runId: id, phase, local, startedAt: new Date(10_000).toISOString(),
    ...(phase === 'completed' ? { endedAt: new Date(100_000).toISOString() } : {}),
    members: [{ parentRunId: id, memberRunId: `${id}-m`, piSessionId: `${id}-session`, agentDefinitionId: '解析者',
      phase, cleanup: phase === 'completed' ? 'settled' : 'pending', observedExecution: phase === 'working', attachment: 'attached' }] };
}
function snapshot(runs: readonly NativeActivityRun[] = [run()]): NativeActivitySnapshot { return { revision: 1, runs, clipped: false }; }
function host(clock: Clock) {
  let component: (Component & { dispose?(): void }) | undefined;
  const components: Array<Component & { dispose?(): void }> = [];
  const calls: unknown[][] = [];
  let requests = 0;
  const tui = { terminal: { rows: 30 }, requestRender() { requests++; } } as unknown as TUI;
  const theme = { fg: (_token: string, text: string) => text } as Theme;
  const ctx: BackgroundActivityContext = { mode: 'tui', hasUI: true, ui: { setWidget(key: string, content: unknown, options?: unknown) {
    calls.push([key, content, options]);
    component?.dispose?.(); component = undefined;
    if (typeof content === 'function') { component = content(tui, theme); components.push(component!); }
  } } };
  return { ctx, tui, theme, calls, components, clock, get requests() { return requests; }, get component() { return component; }, lines(width = 120) { return component?.render(width) ?? []; } };
}
function fixture(runs?: readonly NativeActivityRun[]) {
  const clock = new Clock(), native = new Source(snapshot(runs)), permissions = new Source(0), h = host(clock);
  const seen: Array<TUI | undefined> = [];
  const controller = createBackgroundActivityController({ native, permissions, clock, onTui: t => seen.push(t) });
  controller.attach(h.ctx);
  return { clock, native, permissions, h, seen, controller };
}
const pure = () => projectActivity(snapshot(), UNAVAILABLE_WORKFLOW_ACTIVITY, 100_000);

test('public widget is uniquely named below editor, static, bounded and non-interactive', () => {
  const f = fixture();
  assert.equal(f.h.calls.length, 1); assert.equal(f.h.calls[0]?.[0], BACKGROUND_ACTIVITY_WIDGET);
  assert.deepEqual(f.h.calls[0]?.[2], { placement: 'belowEditor' });
  assert.match(f.h.lines()[0]!, /1 agents working.*run 1m 30s/);
  assert.equal(f.h.lines().length, 2); assert.equal('handleInput' in f.h.component!, false);
  f.controller.dispose(); assert.equal(f.clock.jobs.size, 0); assert.equal(f.native.listeners.size, 0);
});
test('render fits every width/CJK/resize; very short viewports preserve editor/footer', () => {
  const p = pure();
  for (const width of [0, 1, 7, 8, 10, 20, 49, 89, 90, 120, 200]) for (const height of [3, 5, 9, 10, 30]) {
    const lines = renderBackgroundActivity(p, width, { nowMs: 100_000, height });
    assert.ok(lines.length <= (height < 5 ? 0 : height < 10 ? 1 : 2));
    for (const line of lines) assert.ok(visibleWidth(line) <= (width >= 90 ? Math.floor(width * 2 / 3) : width));
  }
  assert.deepEqual(renderBackgroundActivity(p, NaN, { nowMs: 100_000 }), []);
  const f = fixture(); assert.equal(f.h.lines(120).length, 2); assert.equal(f.h.lines(20).length, 1); assert.equal(f.h.lines(120).length, 2); f.controller.dispose();
});
test('ANSI/OSC/C0/C1/bidi labels are sanitized, Unicode and ASCII fallback supported', () => {
  const bad = '\x1b[31m解析者\x1b[0m\x1b]8;;https://invalid\x07label\x1b]8;;\x07\n\r\x85\u202e';
  assert.equal(sanitizeActivityLabel(bad), '解析者label');
  const p = pure(); p.detail; // frozen projection is never mutated by rendering
  const value = { ...p, detail: [{ ...p.detail[0]!, agentDefinitionId: bad }] };
  const lines = renderBackgroundActivity(value, 200, { nowMs: 100_000 });
  assert.ok(lines[1]!.includes('解析者label')); assert.doesNotMatch(lines.join(''), /[\x00-\x1f\x7f-\x9f\u202e]/);
  const ascii = renderBackgroundActivity(p, 200, { nowMs: 100_000, ascii: true });
  assert.ok(ascii[0]!.startsWith('* Clankers | ')); assert.doesNotMatch(ascii[0]!, /●|·|…/);
});
test('theme evaluated each render, semantic color and throwing theme safely falls back', () => {
  const p = pure(); let color = '31'; const tokens: string[] = [];
  const theme = { fg(token: string, text: string) { tokens.push(token); return `\x1b[${color}m${text}\x1b[0m`; } } as Theme;
  const a = renderBackgroundActivity(p, 120, { nowMs: 100_000, theme }); color = '32';
  const b = renderBackgroundActivity(p, 120, { nowMs: 100_000, theme }); assert.notDeepEqual(a, b);
  assert.equal(stripTerminalSequences(a[0]!), stripTerminalSequences(b[0]!)); assert.ok(tokens.includes('accent')); assert.ok(tokens.includes('dim'));
  assert.doesNotThrow(() => renderBackgroundActivity(p, 120, { nowMs: 100_000, theme: { fg() { throw Error(); } } as unknown as Theme }));
});
test('progress reports step/reuse bases; dynamic total never becomes a percentage or ceiling', () => {
  const p = pure();
  const progress = { basis: 'top-level-steps' as const, total: 9, completed: 3, reused: 2, failed: 1, skipped: 1, cancelled: 1, unverified: 1, reusedUnits: 4 };
  const value: ActivityProjection = { ...p, focus: { ...p.focus!, kind: 'workflow', attemptNo: 2, progress }, detail: [] };
  const text = renderBackgroundActivity(value, 600, { nowMs: 100_000 })[0]!;
  assert.match(text, /3\/9 steps completed.*2 steps reused.*1 steps failed.*1 steps skipped.*1 steps cancelled.*1 steps unverified.*4 units reused/);
  const dynamic = renderBackgroundActivity({ ...value, focus: { ...value.focus!, progress: { ...progress, total: null } } }, 600, { nowMs: 100_000 })[0]!;
  assert.match(dynamic, /3 steps completed \(total unknown\)/); assert.doesNotMatch(dynamic, /%|ETA|tokens|cost/);
});
test('clipped counts are explicit lower bounds, distinct agent/unit/check/approval bases', () => {
  const p = pure();
  const value = { ...p, clipped: true, counts: { ...p.counts, queuedAgents: 2, queuedUnits: 3, checking: 1, applying: 1, waitingApproval: 1 }, detail: [] };
  const text = renderBackgroundActivity(value, 600, { nowMs: 100_000 })[0]!;
  assert.match(text, />=1 agents working.*>=2 agents queued.*>=3 units queued.*>=1 workflow approvals pending.*>=1 checking.*>=1 applying.*counts lower bounds/);
});
test('permission attention works while otherwise idle and cannot fabricate run/elapsed/paused status', () => {
  const f = fixture([]); assert.deepEqual(f.h.lines(), []); assert.equal(f.clock.jobs.size, 0);
  f.permissions.value = 3; f.permissions.emit(); f.clock.advance(50);
  assert.match(f.h.lines()[0]!, /^! Clankers.*3 permissions pending/); assert.doesNotMatch(f.h.lines().join(''), /Run:|run \d|paused|Workflow/);
  assert.equal(f.clock.jobs.size, 0); f.controller.dispose();
});
test('hint reflects only supplied active binding, updates without source pulls, hides incomplete hint', () => {
  const f = fixture(); const reads = f.native.reads;
  f.controller.setActiveShortcut('alt+g'); assert.match(f.h.lines(300)[0]!, /\[alt\+g\] Manage/);
  assert.doesNotMatch(f.h.lines(20)[0]!, /Manage|alt\+/);
  f.controller.setActiveShortcut(undefined); assert.doesNotMatch(f.h.lines(300)[0]!, /Manage/);
  assert.equal(f.native.reads, reads); f.controller.dispose();
});
test('50ms coalescing and 1s clock perform zero source pulls or full projection rescans on ticks', () => {
  const f = fixture(); let traversals = 0;
  const cachedRun = run();
  f.native.value = { ...snapshot(), get runs() { traversals++; return [cachedRun]; } };
  for (let i = 0; i < 1000; i++) f.native.emit();
  const reads = f.native.reads; f.clock.advance(49); assert.equal(f.native.reads, reads);
  f.clock.advance(1); assert.equal(f.native.reads, reads + 1);
  const scanned = traversals, permissionReads = f.permissions.reads;
  for (let i = 0; i < 10; i++) { f.clock.advance(1000); f.h.lines(); }
  assert.equal(f.native.reads, reads + 1); assert.equal(f.permissions.reads, permissionReads); assert.equal(traversals, scanned);
  assert.match(f.h.lines()[0]!, /run 1m 40s/); f.controller.dispose();
});
test('elapsed tick does not discard an invalidation scheduled just before it', () => {
  const f = fixture(); f.clock.advance(975); f.native.value = snapshot([run('next')]); f.native.emit();
  const reads = f.native.reads; f.clock.advance(25); assert.equal(f.native.reads, reads);
  f.clock.advance(25); assert.equal(f.native.reads, reads + 1); f.controller.dispose();
});
test('settled local success grace expires once from cached DTO, old history never gets grace', () => {
  const f = fixture([run('done', 'completed')]); assert.match(f.h.lines()[0]!, /completed/);
  const reads = f.native.reads; f.clock.advance(4999); assert.ok(f.h.lines().length);
  f.clock.advance(1); assert.deepEqual(f.h.lines(), []); assert.equal(f.native.reads, reads); assert.equal(f.clock.jobs.size, 0);
  f.controller.dispose(); const old = fixture([run('old', 'completed', false)]); assert.deepEqual(old.h.lines(), []); assert.equal(old.clock.jobs.size, 0); old.controller.dispose();
});
test('focus remains stable through later source updates; current failure takes attention priority', () => {
  const a = run('a'), b = run('b');
  const named = (row: NativeActivityRun) => ({ ...row, members: row.members.map(m => ({ ...m, agentDefinitionId: row.runId })) });
  const f = fixture([named(a), named(b)]);
  assert.match(f.h.lines()[1]!, /a: working/);
  const before = f.h.lines(); f.native.value = snapshot([named(b), named(a)]); f.native.emit(); f.clock.advance(50); assert.deepEqual(f.h.lines(), before);
  f.native.value = snapshot([run('a'), run('failure', 'failed')]); f.native.emit(); f.clock.advance(50);
  assert.match(f.h.lines()[0]!, /^! Clankers.*failed/); assert.equal(f.h.lines().length, 1); assert.equal(f.clock.jobs.size, 1); // Attention focus does not suppress actual background work/known cleanup.
  f.controller.dispose(); assert.equal(f.clock.jobs.size, 0);
});
test('hidden stops all timers and reads, preserves independent TUI handle, does not control work', () => {
  const f = fixture(); const seen = [...f.seen]; f.controller.setVisible(false);
  assert.deepEqual(f.h.lines(), []); assert.equal(f.clock.jobs.size, 0); assert.deepEqual(f.seen, seen);
  const reads = f.native.reads; for (let i = 0; i < 100; i++) f.native.emit(); f.clock.advance(10_000);
  assert.equal(f.native.reads, reads); assert.equal(f.clock.jobs.size, 0); assert.equal(f.native.listeners.size, 1);
  f.controller.setVisible(true); assert.equal(f.native.reads, reads + 1); assert.ok(f.h.lines().length); f.controller.dispose();
});
test('RPC/print/json/missing-mode/no-UI initialize no widget, sources, timers or TUI callback', () => {
  for (const mode of ['rpc', 'print', 'json', undefined, 'tui']) {
    const clock = new Clock(), h = host(clock), source = new Source(snapshot()); const seen: unknown[] = [];
    const c = createBackgroundActivityController({ native: source, clock, onTui: t => seen.push(t) });
    c.attach({ ...h.ctx, mode, hasUI: mode !== 'tui' }); assert.equal(h.calls.length, 0); assert.equal(source.reads, 0); assert.equal(source.listeners.size, 0); assert.equal(clock.jobs.size, 0); assert.deepEqual(seen, []); c.dispose();
  }
});
test('idle and initially hidden keep render[] factory for independent shortcut', () => {
  for (const visible of [true, false]) {
    const clock = new Clock(), h = host(clock); const seen: unknown[] = [];
    const c = createBackgroundActivityController({ visible, clock, onTui: t => seen.push(t) }); c.attach(h.ctx);
    assert.equal(h.calls.length, 1); assert.deepEqual(h.lines(), []); assert.deepEqual(seen, [h.tui]); assert.equal(clock.jobs.size, 0); c.dispose();
  }
});
test('same context repeated attach is idempotent; old component/session cleanup cannot clear new generation', () => {
  const f = fixture(); const old = f.h.component!;
  f.controller.attach(f.h.ctx); assert.equal(f.h.calls.length, 1);
  const cleanup = f.controller.attach({ ...f.h.ctx }); const current = f.h.component!;
  assert.notEqual(old, current); const calls = f.h.calls.length, seen = f.seen.length;
  old.dispose?.(); old.dispose?.(); assert.equal(f.h.calls.length, calls); assert.equal(f.seen.length, seen); assert.ok(f.h.lines().length);
  cleanup(); cleanup(); f.controller.dispose(); f.controller.dispose(); assert.equal(f.clock.jobs.size, 0); assert.equal(f.native.listeners.size, 0);
});
test('old controller reload disposal cannot clear new controller TUI or widget', () => {
  const f = fixture(), old = f.h.component!; const c = createBackgroundActivityController({ native: f.native, clock: f.clock }); c.attach({ ...f.h.ctx });
  const calls = f.h.calls.length, seen = f.seen.length; f.controller.dispose(); old.dispose?.();
  assert.equal(f.h.calls.length, calls); assert.equal(f.seen.length, seen); assert.ok(f.h.lines().length); c.dispose(); assert.equal(f.native.listeners.size, 0);
});
test('source/subscriber/render/callback/unsubscribe failures cannot propagate or retain stale working', () => {
  const f = fixture(); f.native.failRead = true; f.native.failUnsubscribe = true; f.native.emit();
  assert.doesNotThrow(() => f.clock.advance(50)); assert.doesNotMatch(f.h.lines().join(''), /agents working/); assert.match(f.h.lines()[0]!, /uncertain/);
  f.permissions.failRead = true; f.permissions.emit(); f.clock.advance(50); assert.match(f.h.lines()[0]!, /permission visibility unavailable/); assert.doesNotThrow(() => f.controller.dispose());
  const clock = new Clock(), h = host(clock), source = new Source(snapshot()); source.failSubscribe = true;
  const c = createBackgroundActivityController({ native: source, clock, onTui() { throw Error('callback'); } }); assert.doesNotThrow(() => c.attach(h.ctx)); assert.doesNotThrow(() => c.dispose());
  const bad = createBackgroundActivityController({ clock }); assert.doesNotThrow(() => bad.attach({ mode: 'tui', hasUI: true, ui: { setWidget() { throw Error('host'); } } })); bad.dispose();
});
test('reentrant onTui disposal/attach and stale factories are harmless', () => {
  const clock = new Clock(), h = host(clock); let once = true;
  const c = createBackgroundActivityController({ native: new Source(snapshot()), clock, onTui(t) { if (t && once) { once = false; c.attach({ ...h.ctx }); } } });
  assert.doesNotThrow(() => c.attach(h.ctx)); assert.ok(h.lines().length); assert.equal(clock.jobs.size, 1);
  const staleFactory = h.calls[0]![1] as (t: TUI, theme: Theme) => Component;
  assert.deepEqual(staleFactory(h.tui, h.theme).render(120), []); c.dispose(); assert.equal(clock.jobs.size, 0);
});
test('reentrant source pull session replacement cannot restore stale projection/context', () => {
  const clock = new Clock(), h = host(clock); let once = true;
  const source: ActivitySource<NativeActivitySnapshot> = { subscribe: () => () => {}, snapshot() { if (once) { once = false; c.attach({ ...h.ctx }); } return snapshot(); } };
  const c = createBackgroundActivityController({ native: source, clock }); c.attach(h.ctx);
  assert.equal(h.calls.filter(row => typeof row[1] === 'function').length, 1); assert.ok(h.lines().length); c.dispose();
});
test('hide/show without source changes never rescans active DTO; hidden expired grace reprojects only cached DTO', () => {
  let scans = 0; const clock = new Clock(), h = host(clock), rows = [run()];
  const source = new Source<NativeActivitySnapshot>({ ...snapshot(), get runs() { scans++; return rows; } });
  const c = createBackgroundActivityController({ native: source, clock }); c.attach(h.ctx);
  const before = scans; c.setVisible(false); clock.advance(2000); c.setVisible(true);
  assert.equal(scans, before); assert.equal(source.reads, 1); c.dispose();
  const f = fixture([run('done', 'completed')]); const reads = f.native.reads;
  f.controller.setVisible(false); f.clock.advance(6000); f.controller.setVisible(true);
  assert.deepEqual(f.h.lines(), []); assert.equal(f.native.reads, reads); assert.equal(f.clock.jobs.size, 0); f.controller.dispose();
});
test('unsettled terminal cleanup and inert historical failures never become success grace or fresh attention', () => {
  const done = run('done', 'completed'); const unsettled = { ...done, members: done.members.map(m => ({ ...m, cleanup: 'pending' as const })) };
  const f = fixture([unsettled]); assert.match(f.h.lines()[0]!, /cleanup/); assert.doesNotMatch(f.h.lines()[0]!, /completed/);
  f.clock.advance(6000); assert.ok(f.h.lines().length); f.controller.dispose();
  const old = fixture([run('old-failure', 'failed', false)]); assert.deepEqual(old.h.lines(), []); assert.equal(old.clock.jobs.size, 0); old.controller.dispose();
});
test('throwing projection DTO and renderer host property stay observation-only; detach to RPC cleans up', () => {
  const clock = new Clock(), h = host(clock), native = new Source<NativeActivitySnapshot>({ revision: 0, clipped: false, get runs(): readonly NativeActivityRun[] { throw Error('bad DTO'); } });
  const c = createBackgroundActivityController({ clock, native }); assert.doesNotThrow(() => c.attach(h.ctx)); assert.match(h.lines()[0]!, /uncertain/);
  Object.defineProperty(h.tui.terminal, 'rows', { configurable: true, get() { throw Error('renderer'); } });
  assert.deepEqual(h.lines(), []); c.attach({ ...h.ctx, mode: 'rpc' }); assert.equal(clock.jobs.size, 0); assert.equal(native.listeners.size, 0); c.dispose();
});
test('failed source subscription fails visibility closed instead of retaining unobserved working state', () => {
  const clock = new Clock(), h = host(clock), native = new Source(snapshot()); native.failSubscribe = true;
  const permissions = new Source(2); permissions.failSubscribe = true;
  const c = createBackgroundActivityController({ clock, native, permissions }); c.attach(h.ctx);
  assert.equal(native.reads, 0); assert.doesNotMatch(h.lines().join(''), /agents working/); assert.match(h.lines()[0]!, /permission visibility unavailable/); assert.equal(clock.jobs.size, 0); c.dispose();
});
test('workflow approval/progress stays static and cached, separate from permissions/agent work', () => {
  const clock = new Clock(), h = host(clock), native = new Source(snapshot([]));
  let scans = 0;
  const rows = [{ workflowRunId: 'wf', familyId: 'family', attemptNo: 2, definitionId: 'def',
    startedAt: new Date(10_000).toISOString(), updatedAt: new Date(100_000).toISOString(), status: 'running',
    recovered: false, local: true, cleanup: 'settled' as const, uncertain: false,
    progress: { basis: 'top-level-steps' as const, total: 3, completed: 1, reused: 1, failed: 0, skipped: 0, cancelled: 0, unverified: 0, reusedUnits: 1 },
    units: [{ workflowRunId: 'wf', familyId: 'family', attemptNo: 2, stepId: 'step', unitId: 'unit', inputHash: 'hash',
      status: 'running', kind: 'coding', approvalStatus: 'pending', cleanup: 'settled' as const, admitted: false, reused: false }],
  }];
  const workflows = new Source({ revision: 1, available: true, uncertain: false, clipped: false, get runs() { scans++; return rows; } });
  const permissions = new Source(1);
  const c = createBackgroundActivityController({ native, workflows, permissions, clock }); c.attach(h.ctx);
  const text = h.lines(500)[0]!;
  assert.match(text, /1 permissions pending.*Workflow attempt 2: waiting approval.*1 workflow approvals pending.*1\/3 steps completed.*attempt 1m 30s/);
  assert.doesNotMatch(text, /agents working|paused/);
  assert.equal(clock.jobs.size, 0);
  const before = [native.reads, workflows.reads, permissions.reads, scans]; clock.advance(10_000); h.lines();
  assert.deepEqual([native.reads, workflows.reads, permissions.reads, scans], before);
  c.dispose(); assert.equal(workflows.listeners.size, 0);
});

function workflow(phase = 'approval'): WorkflowActivityRun {
  return { workflowRunId: 'wf', familyId: 'family', attemptNo: 2, definitionId: 'def',
    startedAt: new Date(10_000).toISOString(), updatedAt: new Date(100_000).toISOString(), status: 'running',
    recovered: false, local: true, cleanup: 'pending', uncertain: false,
    progress: { basis: 'top-level-steps', total: 3, completed: 1, reused: 1, failed: 0, skipped: 0, cancelled: 0, unverified: 0, reusedUnits: 1 },
    units: [{ workflowRunId: 'wf', familyId: 'family', attemptNo: 2, stepId: 'step', unitId: 'unit', inputHash: 'hash',
      status: 'running', kind: 'coding', phase, approvalStatus: phase === 'approval' ? 'pending' : undefined,
      cleanup: 'pending', admitted: phase !== 'approval', reused: false }],
  };
}
function workflowSnapshot(row: WorkflowActivityRun): WorkflowActivitySnapshot {
  return { revision: 1, available: true, uncertain: false, clipped: false, runs: [row] };
}
test('paused, approval, retry-wait and queued-only are static without any 1s timers', () => {
  for (const phase of ['paused', 'waiting-approval', 'retry-wait', 'queued'] as const) {
    const f = fixture([run('waiting', phase)]);
    assert.equal(f.clock.jobs.size, 0, phase);
    assert.doesNotMatch(f.h.lines()[0]!, /^●|^\* /);
    assert.match(f.h.lines(300)[0]!, new RegExp(phase.replace(/-/g, ' ')));
    const before = [f.native.reads, f.permissions.reads, f.h.requests, f.h.lines(300)[0]];
    f.clock.advance(60_000);
    assert.deepEqual([f.native.reads, f.permissions.reads, f.h.requests, f.h.lines(300)[0]], before);
    f.controller.dispose(); assert.equal(f.clock.jobs.size, 0);
  }
  const p = projectActivity(snapshot([run('p', 'paused')]), UNAVAILABLE_WORKFLOW_ACTIVITY, 100_000);
  assert.match(renderBackgroundActivity(p, 120, { nowMs: 100_000 })[0]!, /^Ⅱ Clankers/);
  assert.match(renderBackgroundActivity(p, 120, { nowMs: 100_000, ascii: true })[0]!, /^\|\| Clankers/);
});
test('approval focus with actual other work ticks focused elapsed using only cached projection', () => {
  const clock = new Clock(), h = host(clock), native = new Source(snapshot()); let scans = 0;
  const rows = [workflow()];
  const workflows = new Source<WorkflowActivitySnapshot>({ ...workflowSnapshot(rows[0]!), get runs() { scans++; return rows; } });
  const c = createBackgroundActivityController({ native, workflows, clock }); c.attach(h.ctx);
  assert.match(h.lines(500)[0]!, /^! Clankers.*waiting approval.*1 agents working.*attempt 1m 30s/);
  assert.equal(clock.jobs.size, 1);
  const before = [native.reads, workflows.reads, scans]; clock.advance(10_000);
  assert.deepEqual([native.reads, workflows.reads, scans], before);
  assert.match(h.lines(500)[0]!, /attempt 1m 40s/);
  c.setVisible(false); assert.equal(clock.jobs.size, 0); c.dispose();
});
test('latest Source A pending resource ownership is not cleanup; known cleanup alone ticks, unknown does not', () => {
  const working = run(), p = projectActivity(snapshot([working]), UNAVAILABLE_WORKFLOW_ACTIVITY, 100_000);
  assert.equal(p.counts.working, 1); assert.equal(p.counts.cleanup, 0);
  const done = run('done', 'completed');
  const pending = { ...done, members: done.members.map(m => ({ ...m, cleanup: 'pending' as const })) };
  const cleanup = projectActivity(snapshot([pending]), UNAVAILABLE_WORKFLOW_ACTIVITY, 100_000);
  assert.equal(cleanup.counts.working, 0); assert.equal(cleanup.counts.cleanup, 1);
  const f = fixture([pending]); assert.equal(f.clock.jobs.size, 1);
  const reads = f.native.reads; f.clock.advance(10_000); assert.equal(f.native.reads, reads); f.controller.dispose();
  const unknown = { ...pending, members: pending.members.map(m => ({ ...m, cleanup: 'unknown' as const })) };
  const uncertain = projectActivity(snapshot([unknown]), UNAVAILABLE_WORKFLOW_ACTIVITY, 100_000);
  assert.equal(uncertain.counts.cleanup, 0); assert.ok(uncertain.counts.unknown > 0);
  const idle = fixture([unknown]); assert.equal(idle.clock.jobs.size, 0); idle.controller.dispose();
});
test('actual starting, check and apply counts tick; unknown and paused workflow resource ownership do not', () => {
  const starting = fixture([run('start', 'starting')]); assert.equal(starting.clock.jobs.size, 1); starting.controller.dispose();
  for (const phase of ['check', 'apply', 'applying', 'paused', 'unknown']) {
    const clock = new Clock(), h = host(clock);
    const row = phase === 'paused' ? { ...workflow('idle'), status: 'paused' }
      : phase === 'unknown' ? { ...workflow('idle'), cleanup: 'unknown' as const } : workflow(phase);
    const source = new Source(workflowSnapshot(row));
    const p = projectActivity(EMPTY_NATIVE_ACTIVITY, source.value, 100_000);
    assert.equal(p.counts.cleanup, 0, phase);
    const work = ['check', 'apply', 'applying'].includes(phase);
    assert.equal(p.counts.checking + p.counts.applying, work ? 1 : 0, phase);
    const c = createBackgroundActivityController({ workflows: source, clock }); c.attach(h.ctx);
    assert.equal(clock.jobs.size, work ? 1 : 0, phase);
    const reads = source.reads; clock.advance(10_000); assert.equal(source.reads, reads); c.dispose();
  }
});
test('wide mixed and workflow layouts reserve the FULL actual key hint in ANSI/CJK visible columns', () => {
  const row = { ...workflow('apply'), label: '解析者e\u0301' + '界'.repeat(90) };
  const p = projectActivity(snapshot([run()]), workflowSnapshot(row), 100_000);
  const mixed: ActivityProjection = { ...p, counts: { ...p.counts, starting: 1, queuedAgents: 12, queuedUnits: 22,
    checking: 2, waitingApproval: 3, cleanup: 1, unknown: 1 }, moreRuns: 5, clipped: true };
  const theme = { fg(_token: string, text: string) { return `\x1b[33m${text}\x1b[0m`; } } as Theme;
  for (const projection of [p, mixed]) for (const width of [48, 60, 89, 90, 120, 200]) {
    const line = renderBackgroundActivity(projection, width, { nowMs: 100_000, activeShortcut: 'Alt+g', theme })[0]!;
    assert.ok(visibleWidth(line) <= (width >= 90 ? Math.floor(width * 2 / 3) : width));
    assert.match(stripTerminalSequences(line), /  \[Alt\+g\] Manage$/);
  }
  for (let width = 8; width < 48; width++) {
    const line = renderBackgroundActivity(mixed, width, { nowMs: 100_000, activeShortcut: 'Alt+g' })[0]!;
    assert.ok(visibleWidth(line) <= width);
    assert.ok(!line.includes('[Alt') || line.endsWith('[Alt+g] Manage'));
  }
  for (const invalid of ['g', 'shift+g', 'alt+g\n', '\x1b[31malt+g', 'alt+g] Wrong', 'alt+' + 'g'.repeat(500)]) {
    assert.doesNotMatch(renderBackgroundActivity(mixed, 200, { nowMs: 100_000, activeShortcut: invalid })[0]!, /Manage|Wrong/);
  }
  assert.match(renderBackgroundActivity(mixed, 48, { nowMs: 100_000, activeShortcut: 'Ctrl+Alt+9', ascii: true })[0]!, /\[Ctrl\+Alt\+9\] Manage$/);
});
test('actual observed focus label is preferred, sanitized and bounded with opaque ID fallback', () => {
  const bad = '\x1b[31m解析者\x1b[0m\x1b]8;;https://invalid\x07label\x1b]8;;\x07\n\r\x85\u202e';
  for (const row of [{ ...run('opaque-run-id'), label: bad }, { ...workflow('check'), label: bad }]) {
    const p = 'runId' in row ? projectActivity(snapshot([row]), UNAVAILABLE_WORKFLOW_ACTIVITY, 100_000)
      : projectActivity(EMPTY_NATIVE_ACTIVITY, workflowSnapshot(row), 100_000);
    assert.equal(p.focus?.label, bad); // A publishes observed data; display sanitization belongs here.
    const text = renderBackgroundActivity(p, 300, { nowMs: 100_000 })[0]!;
    assert.match(text, /\(解析者label\)/); assert.doesNotMatch(text, /opaque-run-id|https|[\x00-\x1f\x7f-\x9f\u202e]/);
  }
  assert.match(renderBackgroundActivity(pure(), 300, { nowMs: 100_000 })[0]!, /Run: working \(r\)/);
  const p = pure();
  assert.match(renderBackgroundActivity({ ...p, focus: { ...p.focus!, label: '\x1b[31m\x1b[0m\n' } }, 300, { nowMs: 100_000 })[0]!, /\(r\)/);
  const bounded = renderBackgroundActivity({ ...p, focus: { ...p.focus!, label: 'X'.repeat(10_000) } }, 2000, { nowMs: 100_000 })[0]!;
  assert.ok(bounded.includes('X'.repeat(128))); assert.ok(!bounded.includes('X'.repeat(129)));
});


// Positive cached-DTO oracles for independent finding10802. No source event is needed to age success grace.
function success(id: string, endedAt = 100_000): NativeActivityRun {
  return { ...run(id, 'completed'), endedAt: new Date(endedAt).toISOString() };
}
function expiryFixture(rows: NativeActivityRun[], workflowRows: WorkflowActivityRun[] = []) {
  const clock = new Clock(), h = host(clock); let scans = 0;
  const native = new Source<NativeActivitySnapshot>({ ...snapshot(), get runs() { scans++; return rows; } });
  const workflows = new Source<WorkflowActivitySnapshot>({ revision: 1, available: true, uncertain: false,
    clipped: false, runs: workflowRows });
  const permissions = new Source(0);
  const c = createBackgroundActivityController({ native, workflows, permissions, clock }); c.attach(h.ctx);
  const oracle = () => {
    const p = projectActivity(snapshot(rows), workflows.value, clock.now(), 'native:live');
    assert.equal(p.focus?.runId, 'live');
    assert.deepEqual(h.lines(600), renderBackgroundActivity(p, 600, { nowMs: clock.now(), height: 30 }));
    return p;
  };
  return { clock, h, native, workflows, permissions, c, oracle, get scans() { return scans; },
    pulls: () => [native.reads, workflows.reads, permissions.reads] };
}
test('active stable focus drops nonfocused successes at EACH exact 5s expiry with one cached projection, zero tick rescans/pulls', () => {
  const f = expiryFixture([run('live'), success('early', 98_000), success('later')]);
  assert.equal(f.oracle().moreRuns, 2); assert.match(f.h.lines(600)[0]!, /working \(live\).*\+2 runs/);
  const pulls = f.pulls(), initial = f.scans;
  f.clock.advance(2999); assert.equal(f.scans, initial); assert.deepEqual(f.pulls(), pulls);
  assert.match(f.h.lines(600)[0]!, /\+2 runs/);
  // Count one canonical projection independently; deadline recomputation must not add expiry-time scans.
  let oneProjection = 0;
  projectActivity({ ...snapshot(), get runs() { oneProjection++; return [run('live')]; } }, UNAVAILABLE_WORKFLOW_ACTIVITY, f.clock.now());
  f.clock.advance(1); assert.equal(f.scans - initial, oneProjection); assert.equal(f.oracle().moreRuns, 1);
  const first = f.scans; f.clock.advance(1999); assert.equal(f.scans, first); assert.match(f.h.lines(600)[0]!, /\+1 runs/);
  f.clock.advance(1); assert.equal(f.scans - first, oneProjection); assert.equal(f.oracle().moreRuns, 0);
  assert.doesNotMatch(f.h.lines(600)[0]!, /\+\d+ runs/);
  const expired = f.scans; f.clock.advance(10_000); assert.equal(f.scans, expired); assert.deepEqual(f.pulls(), pulls);
  f.c.dispose(); assert.equal(f.clock.jobs.size, 0);
});
test('nonfocused native AND workflow successes expire across hidden/show without pulls or historic revival', () => {
  const done: WorkflowActivityRun = { ...workflow(), workflowRunId: 'done-wf', status: 'completed',
    updatedAt: new Date(100_000).toISOString(), cleanup: 'settled', units: [] };
  const f = expiryFixture([run('live'), success('early', 98_000)], [done]);
  assert.equal(f.oracle().moreRuns, 2); const pulls = f.pulls(), initial = f.scans;
  f.c.setVisible(false); assert.equal(f.clock.jobs.size, 0); f.clock.advance(2000); f.c.setVisible(true);
  assert.equal(f.scans, initial); assert.deepEqual(f.pulls(), pulls); assert.equal(f.oracle().moreRuns, 2);
  f.c.setVisible(false); f.clock.advance(2000); assert.equal(f.scans, initial); f.c.setVisible(true);
  assert.equal(f.oracle().moreRuns, 1); assert.deepEqual(f.pulls(), pulls);
  const first = f.scans; f.clock.advance(999); assert.equal(f.scans, first);
  f.clock.advance(1); assert.equal(f.oracle().moreRuns, 0); assert.deepEqual(f.pulls(), pulls);
  f.c.setVisible(false); f.clock.advance(10_000); const expired = f.scans; f.c.setVisible(true);
  assert.equal(f.scans, expired); assert.equal(f.oracle().moreRuns, 0); f.c.dispose();
});
test('success expiry generation survives reload and late old disposal; final disposal removes ALL deadline/tick jobs', () => {
  const f = expiryFixture([run('live'), success('done')]), old = f.h.component!;
  f.clock.advance(1000);
  const next = createBackgroundActivityController({ native: f.native, workflows: f.workflows, permissions: f.permissions, clock: f.clock });
  const cleanup = next.attach({ ...f.h.ctx }); const current = f.h.component!;
  const pulls = f.pulls(); assert.equal(f.clock.jobs.size, 2);
  f.c.dispose(); old.dispose?.(); old.dispose?.(); assert.equal(f.h.component, current); assert.equal(f.clock.jobs.size, 2);
  const before = f.scans; f.clock.advance(3999); assert.equal(f.scans, before); f.clock.advance(1);
  assert.equal(f.oracle().moreRuns, 0); assert.deepEqual(f.pulls(), pulls);
  cleanup(); cleanup(); next.dispose(); current.dispose?.(); assert.equal(f.clock.jobs.size, 0);
  const scans = f.scans; f.clock.advance(10_000); assert.equal(f.scans, scans); assert.deepEqual(f.pulls(), pulls);
  assert.equal(f.native.listeners.size, 0); assert.equal(f.workflows.listeners.size, 0);
});
test('queued/approval attention focus plus nonfocused success has ONLY a grace timer, then stays static', () => {
  for (const phase of ['queued', 'waiting-approval'] as const) {
    const rows = [run('waiting', phase), success('done')];
    const f = fixture(rows); assert.equal(f.clock.jobs.size, 1); const reads = f.native.reads, requests = f.h.requests;
    assert.match(f.h.lines(600)[0]!, /\+1 runs/); assert.doesNotMatch(f.h.lines()[0]!, /^●|^\* /);
    f.clock.advance(4999); assert.equal(f.h.requests, requests); f.clock.advance(1);
    const p = projectActivity(snapshot(rows), UNAVAILABLE_WORKFLOW_ACTIVITY, f.clock.now(), 'native:waiting');
    assert.equal(p.focus?.runId, 'waiting'); assert.equal(p.moreRuns, 0);
    assert.deepEqual(f.h.lines(600), renderBackgroundActivity(p, 600, { nowMs: f.clock.now(), height: 30 }));
    assert.equal(f.native.reads, reads); assert.equal(f.clock.jobs.size, 0);
    const text = f.h.lines(600); f.clock.advance(10_000); assert.deepEqual(f.h.lines(600), text); f.controller.dispose();
  }
});
test('deadline discovery follows canonical eligibility: unknown cleanup, duplicate-session uncertainty and historical/workflow superseded successes do not spin', () => {
  const done = success('done');
  const uncertain = { ...done, members: done.members.map(m => ({ ...m, cleanup: 'unknown' as const })) };
  const conflict = { ...success('conflict'), members: done.members.map(m => ({ ...m, parentRunId: 'conflict', memberRunId: 'conflict-m' })) };
  for (const rows of [[uncertain], [done, conflict], [run('history', 'completed', false)], [success('expired', 94_999)],
    [{ ...done, endedAt: 'invalid' }]]) {
    const f = fixture(rows); assert.equal(f.clock.jobs.size, 0); const pulls = f.native.reads;
    f.clock.advance(10_000); assert.equal(f.native.reads, pulls); f.controller.dispose();
  }
  for (const change of [{ recovered: true }, { local: false }, { supersededBy: 'newer' }, { uncertain: true }, { cleanup: 'unknown' as const }]) {
    const clock = new Clock(), h = host(clock);
    const done: WorkflowActivityRun = { ...workflow(), status: 'completed', cleanup: 'settled', units: [], ...change };
    const source = new Source(workflowSnapshot(done));
    const c = createBackgroundActivityController({ workflows: source, clock }); c.attach(h.ctx);
    assert.equal(clock.jobs.size, 0); clock.advance(10_000); assert.equal(source.reads, 1); c.dispose();
  }
});
test('success calendar respects native run cap but includes visible successes outside focus-candidate cap', () => {
  const outside = expiryFixture(Array.from({ length: 32 }, (_, i) => run(i ? `live-${i}` : 'live')).concat(success('outside')));
  assert.equal(outside.clock.jobs.size, 1); const scans = outside.scans;
  outside.clock.advance(10_000); assert.equal(outside.scans, scans); outside.c.dispose();
  const f = expiryFixture([run('live'), ...Array.from({ length: 31 }, (_, i) => success(`done-${i}`, 98_000 + i * 50))]);
  assert.equal(f.oracle().moreRuns, 31); const pulls = f.pulls();
  f.clock.advance(2999); assert.equal(f.oracle().moreRuns, 31); f.clock.advance(1); assert.equal(f.oracle().moreRuns, 30);
  f.clock.advance(1500); assert.equal(f.oracle().moreRuns, 0); assert.deepEqual(f.pulls(), pulls); f.c.dispose();
});

test('same-deadline success batch expires with exactly ONE cached projection and cannot revive on later source refresh', () => {
  const f = expiryFixture([run('live'), success('a'), success('b')]); const pulls = f.pulls(), before = f.scans;
  f.clock.advance(4999); assert.equal(f.scans, before); f.clock.advance(1);
  assert.equal(f.scans - before, 3); assert.equal(f.oracle().moreRuns, 0); assert.deepEqual(f.pulls(), pulls);
  f.native.emit(); f.clock.advance(50); assert.equal(f.oracle().moreRuns, 0);
  const scans = f.scans; f.clock.advance(10_000); assert.equal(f.scans, scans); f.c.dispose();
});
