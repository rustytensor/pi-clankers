import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { workflowView, type WorkflowAction, type WorkflowReply, type WorkflowRun, type WorkflowTrustedRecoveryAuthorizeRequest } from '../../workflow-model.js';
import { ClankersWorkflowComponent, type ClankersWorkflowOverlayOptions } from '../../ui/workflow-overlay.js';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(authority = true) {
  let run: WorkflowRun = { workflowRunId: 'source', familyId: 'source', attemptNo: 1, definitionHash: 'd'.repeat(64), inputs: {}, agents: {}, concurrency: 1,
    definition: { id: 'definition', version: 1, label: 'Recovery', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, steps: [{ id: 'read', kind: 'native', dependsOn: [], inputs: {} }] },
    status: 'needs-attention', createdAt: '2026-10-05T00:00:00Z', updatedAt: '2026-10-05T00:00:00Z', admissions: 1, cleanupSettled: true, recovered: true,
    steps: [{ id: 'read', status: 'unverified', units: [{ id: 'read:0', stepId: 'read', index: 0, status: 'unverified', inputHash: 'i'.repeat(64), inputs: {}, cleanupSettled: true, native: { runId: 'native', taskId: 'task' } }] }] };
  let child: WorkflowRun | undefined;
  let listener = () => {}; let closed = 0, unsubscribed = 0, native = 0;
  const actions: WorkflowAction[] = [], requests: WorkflowTrustedRecoveryAuthorizeRequest[] = [];
  let assessment: any = { workflowRunId: 'source', fingerprint: 'f'.repeat(64), plan: { status: 'prepared', executionAddresses: [{ unitId: 'read:0' }], recommendedSelections: { reuseUnitIds: [], rerunUnitIds: ['read:0'] } }, blocked: [], selections: { reuseUnitIds: [], rerunUnitIds: ['read:0'] } };
  let authorize: (request: WorkflowTrustedRecoveryAuthorizeRequest) => Promise<WorkflowReply> = async request => { requests.push(request); child = { ...structuredClone(run), workflowRunId: 'child', recovered: false, status: 'running' }; return { ok: true, action: 'workflows.recovery.prepare', view: workflowView(child) }; };
  const options: ClankersWorkflowOverlayOptions = { service: { list: () => [workflowView(run)], get: id => id === run.workflowRunId ? structuredClone(run) : id === child?.workflowRunId ? structuredClone(child) : undefined, subscribe: next => { listener = () => next([workflowView(run)]); return () => { unsubscribed++; }; }, approvals: { inspect: () => [], grant: undefined as never, grantFingerprint: undefined as never, reject: undefined as never, revoke: undefined as never }, execute: async action => { actions.push(action); const selected = action.action === 'workflows.recovery.prepare' && action.selections?.rerunUnitIds?.length; return { ok: true, action: action.action, assessment: selected ? structuredClone(assessment) : { ...structuredClone(assessment), fingerprint: '0'.repeat(64), plan: { ...assessment.plan, status: 'blocked' }, blocked: ['unselected-required-execution-address'], selections: { reuseUnitIds: [], rerunUnitIds: [] } } }; } }, recoveryAuthority: authority ? { authorize: request => authorize(request) } : undefined, onOpenNative: async () => { native++; } };
  const component = new ClankersWorkflowComponent({ requestRender() {} }, undefined, () => { closed++; }, options);
  const render = (width = 160, height = 32) => component.render(width, height).join('\n');
  return { component, actions, requests, render, changeChild: (status: WorkflowRun['status']) => { if (child) child.status = status; listener(); }, setAssessment: (value: any) => { assessment = value; }, get assessment() { return assessment; }, setAuthorize: (value: typeof authorize) => { authorize = value; }, change: (emit = true) => { run.updatedAt = '2026-10-05T00:00:01Z'; run.steps[0]!.units[0]!.status = 'cancelled'; if (emit) listener(); }, emit: () => listener(), get closed() { return closed; }, get native() { return native; }, get unsubscribed() { return unsubscribed; } };
}
async function prepared(f: ReturnType<typeof fixture>) { f.render(); f.component.handleInput('n'); await tick(); assert.match(f.render(), /RECOMMENDATION ONLY/); f.component.handleInput('s'); await tick(); }
async function armed(f: ReturnType<typeof fixture>) { await prepared(f); assert.match(f.render(), /Exact fingerprint/); f.component.handleInput('a'); }

test('trusted confirmation captures last actually displayed exact fingerprint and normalized selections', async () => {
  const f = fixture(); await prepared(f);
  f.component.handleInput('a'); f.component.handleInput('enter'); await tick(); assert.equal(f.requests.length, 0, 'reply arrival alone is not displayed consent');
  const old = structuredClone(f.assessment); assert.match(f.render(), new RegExp(old.fingerprint));
  f.component.handleInput('a'); f.component.handleInput('enter'); await tick(); assert.equal(f.requests.length, 0, 'armed confirmation needs render');
  // Mutating unseen callback data cannot silently substitute a new plan.
  f.setAssessment({ ...old, fingerprint: 'b'.repeat(64), selections: { reuseUnitIds: ['other'], rerunUnitIds: [] } });
  assert.match(f.render(), /CONFIRM source/);
  f.component.handleInput('enter'); f.component.handleInput('enter'); await tick();
  assert.deepEqual(f.requests, [{ workflowRunId: 'source', assessmentFingerprint: old.fingerprint, selections: old.selections }]);
  assert.equal(f.actions.length, 2, 'never silently prepares again');
  assert.match(f.render(), /selected child child.*running/); assert.equal(f.native, 0); f.component.dispose();
});
test('navigation, cancel, observer update, unseen source change and close invalidate armed confirmation', async () => {
  for (const kind of ['escape', 'q', 'down', 'i', 'update', 'silent', 'close'] as const) {
    const f = fixture(); await armed(f); f.render();
    if (kind === 'update') f.change(); else if (kind === 'silent') f.change(false); else f.component.handleInput(kind === 'close' ? '\x03' : kind);
    f.component.handleInput('enter'); await tick(); assert.equal(f.requests.length, 0, kind);
    if (kind === 'escape' || kind === 'q') assert.match(f.render(), /confirmation cancelled/);
    f.component.dispose(); assert.equal(f.unsubscribed, 1);
  }
});
test('narrow or clipped proof cannot authorize, missing authority and inspect are inert', async () => {
  const f = fixture(); await prepared(f); const lines = f.component.render(12, 5);
  lines.forEach(line => assert.ok(visibleWidth(line) <= 12));
  f.component.handleInput('a'); f.component.handleInput('enter'); await tick(); assert.equal(f.requests.length, 0);
  const ids = Array.from({ length: 256 }, (_, i) => `long-unit-${i}-${'x'.repeat(120)}`).sort();
  f.component.dispose();
  for (const [width, height] of [[160, 32], [512, 128]]) {
    const long = fixture();
    long.setAssessment({ ...long.assessment, plan: { status: 'prepared', executionAddresses: ids.map(unitId => ({ unitId })), recommendedSelections: { reuseUnitIds: [], rerunUnitIds: ids } }, selections: { reuseUnitIds: [], rerunUnitIds: ids } });
    await prepared(long);
    assert.deepEqual((long.actions.at(-1) as any).selections.rerunUnitIds, ids, 'all IDs explicitly requested read-only');
    assert.match(long.render(width, height), /Recovery line clipped/);
    long.component.handleInput('a'); long.render(width, height); long.component.handleInput('enter'); await tick();
    assert.equal(long.requests.length, 0, 'even visually fitting sanitizer-truncated selections cannot be consent');
    long.component.dispose();
  }
  for (const trusted of [true, false]) {
    const g = fixture(trusted); g.render(); g.component.handleInput('i'); await tick(); g.render(); g.component.handleInput('a'); g.component.handleInput('enter'); await tick();
    assert.equal(g.requests.length, 0); assert.deepEqual(g.actions.map(a => a.action), ['workflows.recovery.inspect']); assert.equal(g.native, 0); g.component.dispose();
  }
});
test('pending authorize suppresses duplicate requests; closing observer never cancels submitted host work', async () => {
  const f = fixture(); let resolve!: (reply: WorkflowReply) => void;
  f.setAuthorize(request => { f.requests.push(request); return new Promise(next => { resolve = next; }); });
  await armed(f); f.render(); f.component.handleInput('enter'); f.component.handleInput('a'); f.component.handleInput('enter');
  assert.equal(f.requests.length, 1); assert.match(f.render(), /Control pending/);
  f.component.handleInput('\x03'); resolve({ ok: false, action: 'workflows.recovery.prepare', error: 'caller cancelled before selection' }); await tick();
  assert.equal(f.closed, 1); assert.equal(f.actions.length, 2); assert.equal(f.native, 0);
});
test('honest rejection/uncertainty is sanitized, no model action or grant', async () => {
  for (const throwError of [false, true]) {
    const f = fixture(); f.setAuthorize(async request => { f.requests.push(request); if (throwError) throw new Error('commit uncertain'); return { ok: false, action: 'workflows.recovery.prepare', error: '\x1b]52;c;INJECT\x07read-only host rejected selection' }; });
    await armed(f); f.render(); f.component.handleInput('enter'); await tick(); const text = f.render();
    assert.match(text, throwError ? /failed\/uncertain.*commit uncertain/ : /rejected\/cancelled\/uncertain.*read-only/); assert.doesNotMatch(text, /INJECT/);
    assert.deepEqual(f.actions.map(a => a.action), ['workflows.recovery.prepare', 'workflows.recovery.prepare']); f.component.dispose();
  }
});
test('native coding drill and closing inspection retain existing observer-only behavior', async () => {
  const f = fixture(); f.render(); f.component.handleInput('enter'); f.render(); f.component.handleInput('enter'); f.render(); f.component.handleInput('c');
  assert.equal(f.closed, 1); assert.equal(f.actions.length, 0); assert.equal(f.requests.length, 0);
  const g = fixture(); await prepared(g); g.render(); g.component.handleInput('\x03');
  assert.deepEqual(g.actions.map(a => a.action), ['workflows.recovery.prepare', 'workflows.recovery.prepare']); assert.equal(g.requests.length, 0); assert.equal(g.native, 0);
});

test('recommendation is data only: explicit read-only reprepare yields new requested lists/fingerprint before separate render/arm/confirm', async () => {
  const f = fixture(); f.render(); f.component.handleInput('n'); await tick();
  f.component.handleInput('a'); f.component.handleInput('enter'); await tick(); assert.equal(f.requests.length, 0);
  assert.match(f.render(), /unselected-required-execution-address/);
  assert.match(f.render(), /RECOMMENDATION ONLY/);
  f.component.handleInput('s'); await tick();
  assert.deepEqual(f.actions[1], { action: 'workflows.recovery.prepare', workflowRunId: 'source', selections: { reuseUnitIds: [], rerunUnitIds: ['read:0'] } });
  f.component.handleInput('a'); f.component.handleInput('enter'); assert.equal(f.requests.length, 0);
  assert.match(f.render(), /Exact rerun selections: \["read:0"\]/);
  f.component.handleInput('a'); f.render(); f.component.handleInput('enter'); await tick();
  assert.equal(f.requests[0]!.assessmentFingerprint, 'f'.repeat(64));
  assert.match(f.render(), /CURRENT status running/);
  f.changeChild('cancelled'); assert.match(f.render(), /CURRENT status cancelled/);
  assert.doesNotMatch(f.render(), /NEW inert child|creates an inert child/); f.component.dispose();
});
test('unrequested assessment selections cannot become a host grant; stale recommendation cannot reprepare', async () => {
  const f = fixture(); await prepared(f);
  f.setAssessment({ ...f.assessment, selections: { reuseUnitIds: [], rerunUnitIds: ['unrequested:0'] } });
  f.render(); f.component.handleInput('s'); await tick(); f.render(); f.component.handleInput('a'); f.render(); f.component.handleInput('enter'); await tick();
  assert.equal(f.requests.length, 0);
  const before = f.actions.length; f.change(false); f.component.handleInput('s'); await tick();
  assert.equal(f.actions.length, before); f.component.dispose();
});

test('outstanding host authorization stays pending across back-navigation; observer navigation is not a second grant/cancel', async () => {
  const f = fixture(); let resolve!: (reply: WorkflowReply) => void;
  f.setAuthorize(request => { f.requests.push(request); return new Promise(next => { resolve = next; }); });
  await armed(f); f.render(); f.component.handleInput('enter'); f.component.handleInput('escape'); f.render();
  f.component.handleInput('n'); await tick(); f.render(); f.component.handleInput('s'); await tick(); f.render();
  f.component.handleInput('a'); f.render(); f.component.handleInput('enter');
  assert.equal(f.requests.length, 1); assert.equal(f.actions.length, 2);
  resolve({ ok: false, action: 'workflows.recovery.prepare', error: 'caller cancelled before commit' }); await tick();
  assert.match(f.render(), /cancelled before commit/); assert.equal(f.actions.some(action => action.action === 'workflows.cancel'), false); f.component.dispose();
});

test('full explicit recommendation includes future fanout/repeat addresses; all requested lists are displayed before exact confirmation', async () => {
  const f = fixture(); const ids = ['loop@0/body:0', 'loop@1/body:0', 'fan:0', 'fan:1', 'fan:2'];
  f.setAssessment({ ...f.assessment, plan: { status: 'prepared', executionAddresses: ids.map(unitId => ({ unitId })), recommendedSelections: { reuseUnitIds: [], rerunUnitIds: ids } }, selections: { reuseUnitIds: [], rerunUnitIds: [...ids].sort() } });
  await prepared(f); const text = f.render(); for (const id of ids) assert.ok(text.includes(id));
  assert.deepEqual((f.actions[1] as any).selections.rerunUnitIds, [...ids].sort());
  f.component.handleInput('a'); f.render(); f.component.handleInput('enter'); await tick();
  assert.deepEqual(f.requests[0]?.selections?.rerunUnitIds, [...ids].sort()); f.component.dispose();
});
