import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import type { StructuralPiCommandContext, StructuralPiCustomFactory } from '../../types.js';
import type { WorkflowAction, WorkflowReply, WorkflowRun, WorkflowService, WorkflowUnit, WorkflowView } from '../../workflow-model.js';
type TestAction = WorkflowAction;
import { openClankersWorkflowOverlay, ClankersWorkflowComponent, type ClankersWorkflowOverlayOptions } from '../../ui/workflow-overlay.js';

const unit = (id = 'unit-a', status: WorkflowUnit['status'] = 'completed'): WorkflowUnit => ({
  id, stepId: 'review', index: 0, status, inputHash: 'input-hash', inputs: {}, result: { findings: ['RESULT-ONLY-ON-DRILL'] },
  native: { runId: `native-${id}`, taskId: `task-${id}` }, cleanupSettled: true,
});
const run = (id = 'workflow-a', patch: Partial<WorkflowRun> = {}): WorkflowRun => ({
  workflowRunId: id, familyId: 'family-a', attemptNo: 1, definitionHash: 'definition-hash', inputs: {}, agents: {}, concurrency: 8,
  definition: { id: 'definition-a', version: 1, label: 'Read-only review', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, steps: [{ id: 'review', kind: 'native', dependsOn: [], inputs: {} }] },
  status: 'completed', createdAt: '2026-10-04T00:00:00Z', updatedAt: '2026-10-04T00:00:01Z', admissions: 1, cleanupSettled: true, recovered: false,
  steps: [{ id: 'review', status: 'completed', units: [unit()] }], ...patch,
});
function view(value: WorkflowRun): WorkflowView {
  const counts: WorkflowView['counts'] = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, skipped: 0, unverified: 0 };
  const correlations = value.steps.flatMap((step) => step.units.map((row) => { counts[row.status]++; return { stepId: step.id, unitId: row.id, status: row.status, native: row.native, reusedFrom: row.reusedFrom }; }));
  return { workflowRunId: value.workflowRunId, familyId: value.familyId, attemptNo: value.attemptNo, definitionId: value.definition.id,
    status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt, cleanupSettled: value.cleanupSettled, recovered: value.recovered, counts, correlations };
}
function fixture(initial = [run()], optionsPatch: Partial<ClankersWorkflowOverlayOptions> = {}, servicePatch: Partial<ClankersWorkflowOverlayOptions['service']> = {}) {
  let runs = initial; let listener: Parameters<WorkflowService['subscribe']>[0] = () => undefined;
  let renders = 0; let unsubscribed = 0; let done = 0; let result: unknown; let reads = 0;
  const actions: TestAction[] = [];
  const service: ClankersWorkflowOverlayOptions['service'] = {
    list: () => runs.map(view), get: (id) => { reads++; return runs.find((row) => row.workflowRunId === id); },
    subscribe: (next) => { listener = next; return () => { unsubscribed++; }; },
    execute: async (action) => { actions.push(action); return { ok: true, action: action.action }; },
    approvals: { grant: (id, request) => ({ id, status: 'granted', createdAt: 'now', ...request }), grantFingerprint: (id) => { throw new Error(`unexpected grant ${id}`); }, reject: (id, request, reason) => ({ id, status: 'rejected', createdAt: 'now', reason, ...request }), revoke: (id, request, reason) => ({ id, status: 'revoked', createdAt: 'now', reason, ...request }), inspect: () => [] }, ...servicePatch,
  };
  const options = { service, onOpenNative: async () => undefined, ...optionsPatch };
  const component = new ClankersWorkflowComponent({ requestRender: () => { renders++; } }, undefined, (value) => { done++; result = value; }, options);
  return { component, service, options, actions, update: (next: WorkflowRun[]) => { runs = next; listener(next.map(view)); }, late: () => listener(runs.map(view)),
    get renders() { return renders; }, get done() { return done; }, get unsubscribed() { return unsubscribed; }, get result() { return result as { native: { runId: string; taskId: string } } | undefined; }, get reads() { return reads; } };
}
const out = (component: ClankersWorkflowComponent, width = 512, height = 30) => component.render(width, height).join('\n');
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function units(component: ClankersWorkflowComponent): void { out(component); component.handleInput('enter'); out(component); component.handleInput('enter'); out(component); }

test('workflow lists counts, phases, distinct unit outcomes/reuse/cleanup; results only explicit drill', () => {
  const statuses: WorkflowUnit['status'][] = ['queued', 'running', 'completed', 'failed', 'cancelled', 'skipped', 'unverified'];
  const source = run('workflow-a', { status: 'needs-attention', cleanupSettled: false, recovered: true,
    steps: [{ id: 'review', status: 'unverified', units: statuses.map((status) => unit(status, status)) }] });
  source.steps[0]!.units[2]!.reusedFrom = { workflowRunId: 'previous-attempt', unitId: 'old-unit', native: { runId: 'old-native', taskId: 'old-task' } };
  const f = fixture([source]); const list = out(f.component);
  for (const status of statuses) assert.ok(list.includes(`${status}:1`), status);
  assert.ok(!list.includes('RESULT-ONLY-ON-DRILL'));
  units(f.component); const text = out(f.component);
  for (const status of statuses) assert.ok(text.includes(`unit ${status} · ${status}`), status);
  assert.match(text, /needs-attention.*cleanup-pending/); assert.match(text, /reused from previous-attempt\/old-unit native:old-native/);
  assert.ok(!text.includes('RESULT-ONLY-ON-DRILL')); f.component.handleInput('enter'); assert.match(out(f.component), /RESULT-ONLY-ON-DRILL/);
  assert.equal(f.actions.length, 0); f.component.dispose();
});

test('exact native coding drill disposes observer, keeps reused source identity, never starts work', () => {
  const source = run(); source.steps[0]!.units[0]!.reusedFrom = { workflowRunId: 'old', unitId: 'original', native: { runId: 'native-original', taskId: 'task-original' } };
  const f = fixture([source]); units(f.component); f.component.handleInput('c');
  assert.deepEqual(f.result?.native, { runId: 'native-original', taskId: 'task-original' });
  assert.equal(f.unsubscribed, 1); assert.equal(f.done, 1); assert.equal(f.actions.length, 0);
  const renders = f.renders; f.late(); f.component.handleInput('x'); f.component.dispose(); assert.equal(f.renders, renders); assert.equal(f.done, 1);
});

test('last-rendered selection holds across reorder; key navigation before redraw cannot retarget controls', async () => {
  const a = run('a', { status: 'running', cleanupSettled: false }); const b = run('b', { status: 'running', cleanupSettled: false, familyId: 'family-b' });
  const f = fixture([a, b]); out(f.component); f.update([b, a]); f.component.handleInput('x'); await tick();
  assert.deepEqual(f.actions, [{ action: 'workflows.cancel', workflowRunId: 'a' }]);
  out(f.component); f.component.handleInput('home'); f.component.handleInput('x'); await tick(); assert.equal(f.actions.length, 1);
  out(f.component); f.component.handleInput('x'); await tick(); assert.equal((f.actions.at(-1) as { workflowRunId: string }).workflowRunId, 'b'); f.component.dispose();
});

test('replacement/missing run, step, unit and native identity cannot retarget a rendered coding action', () => {
  for (const replace of [(r: WorkflowRun) => { r.definitionHash = 'new-definition'; }, (r: WorkflowRun) => { r.familyId = 'new-family'; },
    (r: WorkflowRun) => { r.createdAt = '2026-10-04T00:00:02Z'; }, (r: WorkflowRun) => { r.attemptNo = 2; },
    (r: WorkflowRun) => { r.steps[0]!.units[0]!.inputHash = 'new-input'; }, (r: WorkflowRun) => { r.steps[0]!.units[0]!.native!.taskId = 'different-task'; },
    (r: WorkflowRun) => { r.steps[0]!.units[0]!.native!.runId = 'different-native'; }, (r: WorkflowRun) => { r.steps[0]!.units = []; }, (r: WorkflowRun) => { r.steps = []; }]) {
    const f = fixture(); units(f.component); const replacement = run(); replace(replacement); f.update([replacement]); f.component.handleInput('c');
    assert.equal(f.done, 0); assert.equal(f.actions.length, 0); f.component.dispose();
  }
  const f = fixture(); units(f.component); f.update([run('other')]); out(f.component); f.component.handleInput('c'); f.component.handleInput('x');
  assert.equal(f.done, 0); assert.equal(f.actions.length, 0); assert.match(out(f.component), /missing\/evicted/); f.component.dispose();
});

test('duplicate identities/wrong lookup result are withheld, never infer another unit', () => {
  const duplicate = run(); duplicate.steps[0]!.units.push(unit()); const f = fixture([duplicate]); units(f.component); f.component.handleInput('c');
  assert.equal(f.result, undefined); assert.equal(f.done, 0); f.component.dispose();
  const g = fixture([run()], {}, { get: () => run('wrong') }); assert.match(out(g.component), /Wrong workflow/); g.component.handleInput('x'); assert.equal(g.actions.length, 0); g.component.dispose();
  const h = fixture([run(), run()]); out(h.component); h.component.handleInput('x'); assert.equal(h.actions.length, 0); h.component.dispose();
});

test('pause/resume explicitly follow rendered state, do not toggle unseen changes; cancel whole workflow', async () => {
  const f = fixture([run('workflow-a', { status: 'running', cleanupSettled: false })]); out(f.component); f.component.handleInput('p'); await tick();
  assert.deepEqual(f.actions[0], { action: 'workflows.pause', workflowRunId: 'workflow-a' });
  f.update([run('workflow-a', { status: 'paused', cleanupSettled: false })]); out(f.component); f.component.handleInput('p'); await tick();
  assert.deepEqual(f.actions[1], { action: 'workflows.resume', workflowRunId: 'workflow-a' });
  out(f.component); f.update([run('workflow-a', { status: 'running', cleanupSettled: false })]); f.component.handleInput('p'); await tick(); assert.equal(f.actions.length, 2);
  units(f.component); f.component.handleInput('x'); await tick(); assert.deepEqual(f.actions.at(-1), { action: 'workflows.cancel', workflowRunId: 'workflow-a' });
  assert.match(out(f.component), /admitted workers continue/); f.component.dispose();
});

test('retry requires rendered explicit confirmation, settled cleanup, same attempt/state; no new work on selection', async () => {
  const f = fixture(); out(f.component); f.component.handleInput('r'); f.component.handleInput('enter'); await tick(); assert.equal(f.actions.length, 0);
  assert.match(out(f.component), /Retry NEW attempt/); f.component.handleInput('escape'); out(f.component); assert.equal(f.actions.length, 0);
  f.component.handleInput('r'); out(f.component); f.component.handleInput('enter'); f.component.handleInput('enter'); await tick();
  assert.deepEqual(f.actions, [{ action: 'workflows.retry', workflowRunId: 'workflow-a' }]); f.component.dispose();
  const g = fixture(); out(g.component); g.component.handleInput('r'); out(g.component); g.update([run('workflow-a', { status: 'needs-attention', cleanupSettled: false })]); g.component.handleInput('enter'); await tick(); assert.equal(g.actions.length, 0); g.component.dispose();
  for (const patch of [{ status: 'running' as const }, { cleanupSettled: false }]) {
    const h = fixture([run('workflow-a', patch)]); out(h.component); h.component.handleInput('r'); assert.doesNotMatch(out(h.component), /Retry NEW attempt/); assert.equal(h.actions.length, 0); h.component.dispose();
  }
});

test('deferred/sync-throwing controls are bounded, suppress duplicates, ignore completion after close', async () => {
  let resolve!: (reply: WorkflowReply) => void; let calls = 0;
  const f = fixture(undefined, {}, { execute: () => { calls++; return new Promise((next) => { resolve = next; }); } });
  out(f.component); f.component.handleInput('x'); f.component.handleInput('x'); assert.equal(calls, 1); assert.match(out(f.component), /Control pending/);
  f.component.dispose(); const renders = f.renders; resolve({ ok: true, action: 'workflows.cancel' }); await tick(); assert.equal(f.renders, renders); assert.equal(f.done, 1);
  const hostile = Object.create(null, { message: { get() { throw new Error('getter'); } } });
  const g = fixture(undefined, {}, { execute: () => { throw hostile; } }); out(g.component); assert.doesNotThrow(() => g.component.handleInput('x')); await tick(); assert.match(out(g.component), /non-text error/); g.component.dispose();
  const h = fixture(undefined, {}, { execute: async (action) => ({ ok: false, action: action.action, error: '\x1b]52;c;INJECT\x07policy denied' }) });
  out(h.component); h.component.handleInput('x'); await tick(); assert.match(out(h.component), /policy denied/); assert.doesNotMatch(out(h.component), /INJECT/); h.component.dispose();
});

test('geometry grid, Unicode and untrusted OSC/CSI/C1 are safe before trusted theme ANSI, theme invalidation rebuilds', () => {
  const source = run(); source.definition.label = '中文 é 👨‍👩‍👧‍👦 \x1b[31mred\x1b[0m \x1b]52;c;LABEL-OSC\x07';
  source.steps[0]!.error = '\x9b2Jphase \x9d52;c;ERROR-OSC\x9c'; source.steps[0]!.units[0]!.error = '\x1bPsecret\x1b\\safe unit';
  const f = fixture([source]); let color = 36;
  const component = new ClankersWorkflowComponent({ terminal: { rows: 1 } }, { fg: (_token, text) => { assert.doesNotMatch(text, /[\x00-\x1f\x7f-\x9f]/u); return `\x1b[${color}m${text}\x1b[0m`; } }, undefined, f.options);
  component.focused = true; assert.equal(component.focused, true);
  for (const width of [1, 2, 3, 8, 20, 80, 512]) for (const height of [1, 2, 3, 5, 30, 128]) {
    const lines = component.render(width, height); assert.ok(lines.length <= height); for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}x${height}: ${visibleWidth(line)}`);
    assert.doesNotMatch(lines.join('\n'), /LABEL-OSC|ERROR-OSC|secret|\x9b|\x9d|\x1b\]/);
  }
  assert.match(out(component), /\x1b\[36m/); color = 35; component.invalidate(); assert.match(out(component), /\x1b\[35m/); assert.doesNotMatch(out(component), /\x1b\[36m/);
  units(component); component.handleInput('enter'); for (const width of [1, 2, 20, 80]) for (const line of component.render(width, 5)) assert.ok(visibleWidth(line) <= width);
  assert.ok(component.render(Number.NaN, Number.NaN).length <= 1); component.dispose(); f.component.dispose();
});

test('result traversal is explicitly clipped/bounded and never included in parent default progress view', () => {
  const source = run(); source.steps[0]!.units[0]!.result = Array.from({ length: 10000 }, () => 'x'.repeat(1000));
  const f = fixture([source]); units(f.component); assert.doesNotMatch(out(f.component), /preview clipped/); f.component.handleInput('enter');
  f.component.handleInput('end'); assert.match(out(f.component), /preview clipped/); assert.equal(f.actions.length, 0); f.component.dispose();
});

test('public keys/back behavior, paste/mixed packets do not execute controls, close does not cancel service', () => {
  const f = fixture(); units(f.component);
  for (const packet of ['xc', 'p\x1b[A', '\x1b]52;c;bad\x07x', '\x1b[200~x']) f.component.handleInput(packet);
  f.component.handleInput('p'); f.component.handleInput('r\x1b[201~x'); assert.equal(f.actions.length, 0); assert.equal(f.done, 0);
  f.component.handleInput('enter'); out(f.component); f.component.handleInput('q'); assert.match(out(f.component), /· units ·/);
  f.component.handleInput('\x1b'); assert.match(out(f.component), /· steps ·/); f.component.handleInput('escape'); assert.match(out(f.component), /· list ·/);
  f.component.handleInput('\x03'); assert.equal(f.done, 1); assert.equal(f.actions.length, 0);
});

test('observer storms read only on render; throwing subscribe/redraw/theme/unsubscribe/done remain idempotent', () => {
  const f = fixture(); out(f.component); const reads = f.reads; for (let i = 0; i < 100; i++) f.late(); assert.equal(f.reads, reads);
  f.component.dispose(); f.component.dispose(); const renders = f.renders; f.late(); assert.equal(f.renders, renders); assert.equal(f.unsubscribed, 1); assert.equal(f.done, 1);
  let done = 0; const g = fixture(undefined, {}, { subscribe: () => () => { throw new Error('unsubscribe'); } });
  const component = new ClankersWorkflowComponent({ requestRender: () => { throw new Error('redraw'); } }, { fg: () => { throw new Error('theme'); } }, () => { done++; throw new Error('done'); }, g.options);
  assert.doesNotThrow(() => out(component)); assert.doesNotThrow(() => component.handleInput('home')); component.dispose(); component.dispose(); assert.equal(done, 1); g.component.dispose();
  const h = fixture(undefined, {}, { subscribe: () => { throw new Error('subscribe'); } }); assert.match(out(h.component), /Observer unavailable/); h.component.dispose();
});

test('custom rejection/factory replacement/constructor failure and unsupported modes leave no watchers', async () => {
  const f = fixture(); f.component.dispose();
  await assert.rejects(openClankersWorkflowOverlay({ mode: 'tui', ui: { custom: async (factory) => { await (factory as StructuralPiCustomFactory)(); throw new Error('custom rejected'); } } }, f.options), /custom rejected/);
  assert.equal(f.unsubscribed, 2);
  await openClankersWorkflowOverlay({ mode: 'tui', ui: { custom: async (factory) => { const create = factory as StructuralPiCustomFactory; await create(); const current = await create(); current.dispose?.(); } } }, f.options);
  assert.equal(f.unsubscribed, 4);
  await assert.rejects(openClankersWorkflowOverlay({ mode: 'tui', ui: { custom: async (factory) => { await (factory as StructuralPiCustomFactory)(); } } }, { ...f.options, workflowRunId: 'bad id' }), /Invalid exact/); assert.equal(f.unsubscribed, 4);
  for (const mode of ['rpc', 'json', 'print'] as const) await assert.rejects(openClankersWorkflowOverlay({ mode, hasUI: true, ui: { custom: () => { throw new Error('must not call'); } } }, f.options), /interactive Pi TUI/);
  await assert.rejects(openClankersWorkflowOverlay({ hasUI: false }, f.options), /interactive Pi TUI/);
});

test('coding navigation uses exact native callback and fresh interaction after error/return, old listeners inert', async () => {
  const f = fixture(); f.component.dispose(); let customCalls = 0; const natives: Array<{ runId: string; taskId: string }> = [];
  const context: StructuralPiCommandContext = { mode: 'tui', ui: { custom: async (factory) => {
    const component = await (factory as StructuralPiCustomFactory)(); customCalls++;
    if (customCalls === 1) { units(component as ClankersWorkflowComponent); component.handleInput?.('c'); assert.equal(f.unsubscribed, 2); }
    else { assert.match(out(component as ClankersWorkflowComponent), /Exact coding viewer unavailable/); component.handleInput?.('\x03'); }
  } } };
  await openClankersWorkflowOverlay(context, { ...f.options, onOpenNative: async (native) => { natives.push(native); assert.equal(f.unsubscribed, 2); throw new Error('closed native session'); } });
  assert.equal(customCalls, 2); assert.deepEqual(natives, [{ runId: 'native-unit-a', taskId: 'task-unit-a' }]); assert.equal(f.unsubscribed, 3); assert.equal(f.actions.length, 0);
});

test('public Kitty/CSI keys work; key release and mixed suffix packets cannot trigger actions', async () => {
  const f = fixture([run('workflow-a', { status: 'running', cleanupSettled: false })]); out(f.component);
  f.component.handleInput('\x1b[120;1:3u'); f.component.handleInput('\x1b[120ux'); assert.equal(f.actions.length, 0);
  f.component.handleInput('\x1b[112u'); await tick(); assert.deepEqual(f.actions, [{ action: 'workflows.pause', workflowRunId: 'workflow-a' }]);
  out(f.component); f.component.handleInput('\x1b[13u'); assert.match(out(f.component), /· steps ·/);
  f.component.handleInput('\x1b[13u'); out(f.component); f.component.handleInput('\x1b[99u');
  assert.deepEqual(f.result?.native, { runId: 'native-unit-a', taskId: 'task-unit-a' }); assert.equal(f.unsubscribed, 1);
});

function codingRun(status = 'pending', patch: Partial<WorkflowUnit> = {}): WorkflowRun {
  const source = run('workflow-coding'); source.definition.version = 3;
  source.definition.steps = [{ id: 'stage', kind: 'coding', dependsOn: [], inputs: {}, outputSchema: { type: 'object', properties: {}, additionalProperties: false }, coding: { operation: 'stage-write', policy: {} } } as never];
  source.steps = [{ id: 'stage', status: 'running', units: [{ ...unit('stage:0', 'running'), stepId: 'stage', id: 'stage:0', result: { candidateHash: 'c'.repeat(64), changedPaths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts', 'src/g.ts'] }, coding: { phase: 'awaiting-implementation-approval', approvalId: 'approval-1', approvalStatus: status }, ...patch }] }];
  return source;
}

test('coding monitor inspects approval states and clipped candidate scope without approval controls', () => {
  for (const status of ['pending', 'granted', 'revoked', 'expired'] as const) {
    const f = fixture([codingRun(status)], {}, { approvals: { grant: undefined as never, grantFingerprint: undefined as never, reject: undefined as never, revoke: undefined as never, inspect: (id?: string) => [{ id: id ?? 'approval-1', kind: 'implementation', status, requestHash: 'a'.repeat(64), consumed: false, createdAt: '2026-10-04T00:00:00Z', request: { kind: 'implementation', attemptKey: 'parent:task:1', taskHash: 'b'.repeat(64), policyHash: 'p'.repeat(64), scopeHash: 's'.repeat(64), agentHash: 'g'.repeat(64), model: 'model-x', baselineHash: 'd'.repeat(64) }, scope: { attemptKey: 'parent:task:1', baselineHash: 'd'.repeat(64) } }] as never } });
    units(f.component); assert.match(out(f.component), new RegExp(`approval:${status}`));
    f.component.handleInput('enter'); const text = out(f.component);
    assert.match(text, new RegExp(`implementation/${status}`));
    assert.match(text, /prepared≠checked≠reviewed≠approved≠applied/);
    assert.match(text, /\[1 omitted\]/);
    assert.doesNotMatch(text, /confirm=true|grantFingerprint|grant\(/);
    f.component.handleInput('escape'); f.component.handleInput('escape'); f.component.dispose();
  }
});

test('coding monitor reports stale selection and partial uncertain application as not applied', () => {
  const f = fixture([codingRun('granted', { status: 'completed', result: { status: 'partial', candidateHash: 'e'.repeat(64), appliedPaths: ['src/a.ts'] }, coding: { phase: 'applied', candidateHash: 'e'.repeat(64), evidenceHash: 'f'.repeat(64), appliedPaths: ['src/a.ts'] } })]);
  units(f.component); assert.match(out(f.component), /application:partial!/);
  f.component.handleInput('enter'); assert.match(out(f.component), /partial\/uncertain is not applied/);
  const replacement = codingRun('granted'); replacement.steps[0]!.units[0]!.inputHash = 'changed'; f.update([replacement]); f.component.handleInput('c');
  assert.equal(f.done, 0); assert.equal(f.actions.length, 0); f.component.dispose();
});

function loopRun(): WorkflowRun {
  const value = run(); value.definition.version = 2;
  value.definition.steps = [{ id: 'loop', kind: 'repeat', dependsOn: [], maxIterations: 3,
    body: [{ id: 'review', kind: 'native', dependsOn: [], inputs: {} }] }];
  value.steps = [{ id: 'loop', status: 'completed', termination: 'converged', units: [], iterations: [0, 1].map(index => ({
    id: `loop@${index}`, index, state: { private: 'STATE-ONLY-DETAIL' }, decision: index === 1,
    steps: [{ id: `loop@${index}/review`, status: 'completed', units: [{ ...unit(`loop@${index}/review:0`), stepId: `loop@${index}/review` }] }],
  })) }]; return value;
}
function loopUnits(component: ClankersWorkflowComponent): void {
  units(component); // list -> steps -> iterations
  component.handleInput('end'); out(component); component.handleInput('enter'); out(component); // exact last iteration -> body
  component.handleInput('enter'); out(component); // body -> units
}
test('repeat monitor drills iteration/body/unit by exact qualified ID and returns from native despite reorder', async () => {
  const source = loopRun(); const f = fixture([source]); f.component.dispose(); let visits = 0;
  await openClankersWorkflowOverlay({ mode: 'tui', ui: { custom: async factory => {
    const component = await (factory as StructuralPiCustomFactory)() as ClankersWorkflowComponent;
    if (++visits === 1) {
      out(component); component.handleInput('enter'); assert.match(out(component), /iteration 2\/3.*converged/);
      component.handleInput('enter'); assert.match(out(component), /iteration loop@1.*decision true/);
      assert.doesNotMatch(out(component), /STATE-ONLY-DETAIL/);
      component.handleInput('end'); out(component); component.handleInput('enter'); out(component); component.handleInput('enter'); out(component); component.handleInput('c');
    } else {
      assert.match(out(component), /› unit loop@1\/review:0/);
      component.handleInput('q'); assert.match(out(component), /· body ·/);
      component.handleInput('q'); assert.match(out(component), /› iteration loop@1/);
      component.handleInput('\x03');
    }
  } } }, { ...f.options, onOpenNative: async native => {
    assert.deepEqual(native, { runId: 'native-loop@1/review:0', taskId: 'task-loop@1/review:0' });
    source.steps[0]!.iterations!.reverse(); f.update([source]);
  } });
  assert.equal(visits, 2); assert.equal(f.actions.length, 0);
});
test('repeat monitor rejects stale iteration/native identity and renders skip/nonconvergence safely at narrow widths', () => {
  for (const mutate of [(value: WorkflowRun) => { value.steps[0]!.iterations = []; },
    (value: WorkflowRun) => { value.steps[0]!.iterations![1]!.steps[0]!.units[0]!.native!.taskId = 'replacement'; }]) {
    const source = loopRun(); const f = fixture([source]); loopUnits(f.component); mutate(source); f.update([source]);
    f.component.handleInput('c'); assert.equal(f.done, 0); assert.equal(f.actions.length, 0); f.component.dispose();
  }
  const source = loopRun(); source.steps[0]!.status = 'failed'; source.steps[0]!.termination = 'max-iterations'; source.definition.steps[0]!.maxIterations = 2; source.steps[0]!.iterations![1]!.decision = false;
  source.steps[0]!.error = 'Maximum iterations reached \x1b]52;c;HIDDEN\x07';
  const f = fixture([source]); out(f.component); f.component.handleInput('enter');
  assert.match(out(f.component), /nonconverged/); assert.doesNotMatch(out(f.component), /HIDDEN/);
  for (const width of [1, 2, 8, 20, 80]) for (const height of [1, 3, 8]) {
    const lines = f.component.render(width, height); assert.ok(lines.length <= height); lines.forEach(line => assert.ok(visibleWidth(line) <= width));
  }
  source.steps[0]!.status = 'skipped'; source.steps[0]!.skipReason = 'condition-false'; source.steps[0]!.iterations = [];
  f.update([source]); assert.match(out(f.component), /condition-false/); f.component.dispose();
});

for (const [status, termination, expected] of [
  ['failed', 'body-failed', 'body-failed'],
  ['failed', 'invalid-transition', 'invalid-transition (schema/feedback/condition/output)'],
  ['failed', undefined, 'failed (termination unspecified)'],
  ['cancelled', 'cancelled', 'cancelled'],
  ['unverified', 'recovery', 'uncertain/unverified'],
  ['cancelled', 'converged', 'cancelled'],
  ['unverified', 'converged', 'uncertain/unverified'],
  ['failed', 'converged', 'convergence not confirmed'],
  ['completed', undefined, 'convergence not confirmed'],
] as const) test(`repeat outcome ${status}/${termination} never infers convergence from a true decision`, () => {
  const source = loopRun(); const block = source.steps[0]!;
  block.status = status; block.termination = termination; block.error = 'exact diagnostic';
  const f = fixture([source]); out(f.component); f.component.handleInput('enter');
  const text = out(f.component); assert.ok(text.includes(expected), text);
  assert.match(text, /exact diagnostic/); assert.doesNotMatch(text, / · converged|nonconverged/);
  f.component.handleInput('enter'); assert.ok(out(f.component).includes(expected)); f.component.dispose();
});

test('repeat iteration UI is bounded at 32 and never claims recovered history is verified convergence', () => {
  const source = loopRun(); source.recovered = true;
  const f = fixture([source]); out(f.component); f.component.handleInput('enter');
  assert.match(out(f.component), /uncertain\/unverified/); assert.doesNotMatch(out(f.component), / · converged/);
  const sample = source.steps[0]!.iterations![0]!;
  source.steps[0]!.iterations = Array.from({ length: 33 }, (_, index) => ({ ...sample, index, id: `loop@${index}`,
    steps: [{ id: `loop@${index}/review`, status: 'completed', units: [{ ...unit(`loop@${index}/review:0`), stepId: `loop@${index}/review` }] }],
  }));
  f.component.handleInput('enter'); assert.match(out(f.component), /16 phases\/32 iterations\/32 units/);
  f.component.handleInput('end'); assert.match(out(f.component), /› iteration loop@31/);
  assert.doesNotMatch(out(f.component), /iteration loop@32/); f.component.dispose();
});

test('native return preserves exact repeat body spec across phase and body reorder', async () => {
  const source = loopRun();
  source.definition.steps.push({ id: 'tail', kind: 'aggregate', dependsOn: [], inputs: {} });
  source.steps.push({ id: 'tail', status: 'completed', units: [] });
  source.definition.steps[0]!.body!.push({ id: 'other', kind: 'aggregate', dependsOn: [], inputs: {} });
  for (const iteration of source.steps[0]!.iterations!) iteration.steps.push({ id: `${iteration.id}/other`, status: 'completed', units: [] });
  const f = fixture([source]); f.component.dispose(); let visits = 0;
  await openClankersWorkflowOverlay({ mode: 'tui', ui: { custom: async factory => {
    const component = await (factory as StructuralPiCustomFactory)() as ClankersWorkflowComponent;
    if (++visits === 1) { loopUnits(component); component.handleInput('c'); }
    else {
      assert.match(out(component), /› unit loop@1\/review:0/);
      component.handleInput('q'); assert.match(out(component), /› phase loop@1\/review/);
      component.handleInput('enter'); assert.match(out(component), /› unit loop@1\/review:0/);
      component.handleInput('\x03');
    }
  } } }, { ...f.options, onOpenNative: async native => {
    assert.deepEqual(native, { runId: 'native-loop@1/review:0', taskId: 'task-loop@1/review:0' });
    for (const iteration of source.steps[0]!.iterations!) iteration.steps.reverse();
    source.steps[0]!.iterations!.reverse(); source.steps.reverse(); f.update([source]);
  } });
  assert.equal(visits, 2); assert.equal(f.actions.length, 0);
});

test('native return refuses changed exact unit identity instead of silently accepting replacement', async () => {
  const source = loopRun(); const f = fixture([source]); f.component.dispose(); let visits = 0;
  await openClankersWorkflowOverlay({ mode: 'tui', ui: { custom: async factory => {
    const component = await (factory as StructuralPiCustomFactory)() as ClankersWorkflowComponent;
    if (++visits === 1) { loopUnits(component); component.handleInput('c'); }
    else {
      assert.match(out(component), /Exact coding selection changed; no fallback/);
      component.handleInput('c'); component.handleInput('x'); component.handleInput('\x03');
    }
  } } }, { ...f.options, onOpenNative: async () => {
    source.steps[0]!.iterations![1]!.steps[0]!.units[0]!.native!.taskId = 'replacement'; f.update([source]);
  } });
  assert.equal(visits, 2); assert.equal(f.actions.length, 0);
});


function actualUnit(unitId: string, patch: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return { unitId, stepId: 'review', status: 'completed', cleanupSettled: true, originalStatus: 'running', projectedStatus: 'completed', operationClasses: ['native'], safeUnitReasons: [], classifications: [], reuseEligible: false, rerunEligible: false, proposeFreshReadonlyNativeRerun: false, blockers: [], ...patch };
}
function actualAssessment(workflowRunId: string, patch: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return { schema: { version: 1, authority: 'inspect-prepare-only', prepareIsPermission: false }, workflowRunId, attemptNo: 1, status: 'needs-attention', recovered: true, cleanupSettled: false, fingerprint: 'fp', fingerprintParts: {}, plan: { status: 'blocked' }, units: [actualUnit('unit-a')], plannedNeverAdmitted: [], sourceOriginal: { completedUnitIds: [], failedUnitIds: [], interruptedUnitIds: ['unit-a'] }, sourceCheckpoint: { present: false, hash: 'checkpoint-fp', summary: {} }, current: { before: { status: 'running' }, after: { status: 'needs-attention' } }, dependencyInvalidations: { conservative: true, downstreamInvalidatedUnitIds: [] }, budget: { maxAttempts: 3, maxAdmissions: 256, usedAdmissions: 1, remainingAdmissions: 255, remainingAttempts: 2, correctionsUsed: 0 }, selections: { reuseUnitIds: [], rerunUnitIds: [] }, blocked: [], ...patch };
}
test('recovery inspect/prepare use exact rendered run proof and remain read-only assessment calls', async () => {
  const calls: TestAction[] = [];
  const f = fixture([run('workflow-a', { status: 'needs-attention', cleanupSettled: false, recovered: true, recoveryOriginal: { version: 1, recordedAt: '2026-10-04T00:00:00Z', status: 'running', cleanupSettled: false, recovered: false, steps: [{ id: 'review', status: 'running', units: [{ id: 'unit-a', stepId: 'review', index: 0, status: 'running', cleanupSettled: false }] }] } })], {}, {
    execute: async (action) => { calls.push(action); return ({ ok: true, action: action.action, assessment: actualAssessment('workflow-a', { fingerprint: 'fp-a', units: [actualUnit('unit-a', { reuseEligible: true, classifications: [{ classification: 'completed-valid', kind: 'native', cleanup: 'settled' }] }), actualUnit('unit-b', { rerunEligible: true, blockers: ['operator-check-required'], classifications: [{ classification: 'interrupted-uncertain', kind: 'native', cleanup: 'unknown' }] })], blocked: ['fresh-approval-required'], budget: { maxAttempts: 3, maxAdmissions: 256, usedAdmissions: 1, remainingAdmissions: 255, remainingAttempts: 2, correctionsUsed: 0 } }) }) as never; },
  });
  out(f.component); f.component.handleInput('i'); await tick(); let text = out(f.component);
  assert.deepEqual(calls, [{ action: 'workflows.recovery.inspect', workflowRunId: 'workflow-a' }]);
  assert.match(text, /Recovery assessment pane/); assert.match(text, /read-only/); assert.match(text, /no automatic reconnect/); assert.match(text, /Original|original attempt/i);
  assert.match(text, /status:needs-attention/); assert.match(text, /plan:blocked/); assert.match(text, /fingerprint:fp-a/); assert.match(text, /reuseEligible:1/); assert.match(text, /interrupted-uncertain:1/); assert.match(text, /fresh-approval-required/);
  assert.match(text, /Authorize new attempt: unavailable until trusted host configured/); assert.doesNotMatch(text, /safe to continue/i);
  f.component.handleInput('escape'); out(f.component); f.component.handleInput('n'); await tick(); text = out(f.component);
  assert.equal(calls.length, 2); assert.deepEqual(calls[1], { action: 'workflows.recovery.prepare', workflowRunId: 'workflow-a', selections: {} });
  assert.match(text, /Prepare continuation/); assert.match(text, /Rendered selections/); f.component.dispose();
});

test('recovery stale selected run proof is refused and fingerprint display never retargets changed plan', async () => {
  const a = run('a', { status: 'needs-attention', cleanupSettled: false, recovered: true }); const b = run('b', { status: 'needs-attention', cleanupSettled: false, recovered: true, familyId: 'family-b' });
  const calls2: TestAction[] = [];
  const f = fixture([a, b], {}, { execute: async (action) => { calls2.push(action); const id = 'workflowRunId' in action ? action.workflowRunId ?? '' : ''; return ({ ok: true, action: action.action, assessment: actualAssessment(id, { fingerprint: id === 'a' ? 'fp-a' : 'fp-b' }) }) as never; } });
  out(f.component); f.update([b, a]); f.component.handleInput('i'); await tick(); assert.equal(calls2.length, 0); assert.match(out(f.component), /stale|changed|missing/i);
  out(f.component); f.component.handleInput('home'); out(f.component); f.component.handleInput('i'); await tick(); assert.deepEqual(calls2, [{ action: 'workflows.recovery.inspect', workflowRunId: 'b' }]); assert.match(out(f.component), /fp-b/); assert.doesNotMatch(out(f.component), /fp-a/); f.component.dispose();
});



test('recovery assessment rejects malformed callback data before formatting without unbounded stringify', async () => {
  let getter = 0;
  const hostile = Object.create(null, { status: { enumerable: true, get() { getter++; throw new Error('must not stringify getter'); } } });
  const f = fixture([run('workflow-a', { status: 'needs-attention', cleanupSettled: false, recovered: true })], {}, {
    execute: async (action) => ({ ok: true, action: action.action, assessment: hostile }) as never,
  });
  out(f.component); f.component.handleInput('i'); await tick(); const text = out(f.component, 80, 12);
  assert.equal(getter, 0);
  assert.match(text, /malformed bounded JSON|JSON accessor/);
  assert.ok(text.length < 5000);
  f.component.dispose();
});
test('recovery pane sanitizes and bounds sidebar data, rejects errors, and close never cancels workflow or opens native', async () => {
  let native = 0; const calls3: TestAction[] = [];
  const many = Array.from({ length: 40 }, (_, i) => `unit-${i}\x1b]52;c;bad\x07`);
  const f = fixture([run('workflow-a', { status: 'needs-attention', cleanupSettled: false, recovered: true })], { onOpenNative: async () => { native++; } }, {
    execute: async (action) => { calls3.push(action); return ({ ok: false, action: action.action, error: '\x1b]52;c;bad\x07blocked by policy' }) as never; },
  });
  out(f.component); f.component.handleInput('i'); await tick(); let text = out(f.component, 80, 10);
  assert.match(text, /blocked by policy/); assert.doesNotMatch(text, /\x1b\]|bad/); assert.equal(calls3.length, 1);
  f.component.handleInput('escape'); out(f.component); f.options.service.execute = async (action) => { calls3.push(action); return ({ ok: true, action: action.action, assessment: actualAssessment('workflow-a', { status: 'blocked', fingerprint: 'fp', units: many.map((id) => actualUnit(id, { blockers: ['blocked'], classifications: [{ classification: 'interrupted-uncertain', kind: 'native', cleanup: 'unknown' }] })), blocked: many }) }) as never; };
  f.component.handleInput('n'); await tick(); const lines = f.component.render(24, 6); assert.ok(lines.length <= 6); for (const line of lines) assert.ok(visibleWidth(line) <= 24);
  f.component.handleInput('q'); f.component.handleInput('\x03'); assert.equal(native, 0); assert.equal(calls3.filter((a) => ['workflows.cancel','workflows.retry','workflows.pause','workflows.resume'].includes(a.action)).length, 0); f.component.dispose();
});
