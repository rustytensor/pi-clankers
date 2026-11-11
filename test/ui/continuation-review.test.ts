import assert from 'node:assert/strict';
import test from 'node:test';
import { CURSOR_MARKER, visibleWidth } from '@earendil-works/pi-tui';
import type { NativeContinuationPrepare, NativeContinuationReview, NativeContinuationService } from '../../native-continuation.js';
import { ClankersContinuationReviewComponent } from '../../ui/continuation-review.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const key = { parentRunId: 'parent-source', memberRunId: 'member-source', piSessionId: 'pi-source' };
function review(request: NativeContinuationPrepare, patch: Partial<NativeContinuationReview> = {}): NativeContinuationReview {
  return { reviewId: 'review-1', expiresAt: new Date(Date.now() + 60000).toISOString(), key: { parentRunId: request.parentRunId, memberRunId: request.memberRunId, piSessionId: request.piSessionId }, entryId: request.entryId, body: request.body,
    sourceFingerprint: 'fingerprint-exact-file', policyDigest: 'digest-current-definition', warnings: ['Normal Pi hooks can transform prompts at runtime.'],
    policy: { definition: { id: 'source-definition', prompt: 'CURRENT PROMPT' }, tools: ['read', 'bash'], denies: ['write'], model: request.model || 'current-model', cwd: '/current', resources: 'normal Pi DefaultResourceLoader, extensions, MCP' } as unknown as NativeContinuationReview['policy'], ...patch };
}
function fixture(unconfirmed = false) {
  let current = true;
  let closed = 0;
  let disposedServices = 0;
  let renders = 0;
  const prepares: NativeContinuationPrepare[] = [];
  const starts: Array<{ reviewId: string; confirm: true }> = [];
  const discards: string[] = [];
  const service: NativeContinuationService = {
    prepare: async (request) => { prepares.push(request); return review(request); },
    start: async (request) => { starts.push(request); return { runId: 'NEW-run', taskId: 'NEW-task' }; },
    discard: ({ reviewId }) => { discards.push(reviewId); }, dispose: () => { disposedServices++; },
  };
  const component = new ClankersContinuationReviewComponent({ terminal: { rows: 48 }, requestRender: () => { renders++; } }, undefined,
    { source: { key, entryId: 'at-entry', unconfirmed }, service, isCurrent: () => current, close: () => { closed++; } });
  component.focused = true;
  component.render(160, 40);
  return { component, service, prepares, starts, discards, setCurrent(value: boolean) { current = value; component.sourceChanged(); }, get closed() { return closed; }, get disposedServices() { return disposedServices; }, get renders() { return renders; } };
}
async function prepared(f: ReturnType<typeof fixture>, body = 'NEW literal task'): Promise<void> {
  f.component.handleInput(`\x1b[200~${body}\x1b[201~`);
  f.component.handleInput('\r');
  await tick();
}

test('new continuation is separate prepare/review/explicit authorization; exact token-only start', async () => {
  const f = fixture();
  assert.equal(f.prepares.length, 0);
  assert.equal(f.starts.length, 0);
  await prepared(f, '  /clankers run --dangerous\n  qsb n  ');
  assert.equal(f.prepares.length, 1);
  assert.deepEqual(f.prepares[0], { ...key, entryId: 'at-entry', body: '  /clankers run --dangerous\n  qsb n  ' });
  assert.equal(f.starts.length, 0);
  f.component.handleInput('\r');
  f.component.handleInput('\x13');
  f.component.handleInput('\x19'); // Cannot authorize a review that has never rendered.
  assert.equal(f.starts.length, 0);
  const output = f.component.render(180, 70).join('\n');
  for (const value of ['parent-source', 'member-source', 'pi-source', 'Selected entry (at): at-entry', 'fingerprint-exact-file', 'digest-current-definition', 'CURRENT PROMPT', 'bash', 'write', 'current-model', '/current', 'Historical permissions are UNKNOWN', 'NEW authorization', 'no old queues/teams', 'Original transcript unchanged', 'Normal Pi resources/extensions/MCP']) assert.ok(output.includes(value), value);
  f.component.handleInput('\x19');
  f.component.handleInput('\x19');
  await tick();
  assert.deepEqual(f.starts, [{ reviewId: 'review-1', confirm: true }]);
  const result = f.component.render(180, 40).join('\n');
  assert.match(result, /Destination run: NEW-run/);
  assert.match(result, /Destination task: NEW-task/);
  assert.match(result, /not a completion claim/);
  f.component.dispose();
  assert.equal(f.disposedServices, 0, 'viewer never disposes shared runtime service');
});

test('body/model editor and Pi whitespace normalization are literal, not shortcuts or trimming', async () => {
  const f = fixture();
  f.component.handleInput('\x1b[200~  /tree\r\n\tqsb n  \x1b[201~');
  f.component.handleInput('\x1bm');
  f.component.handleInput('provider/model');
  f.component.handleInput('\x13');
  await tick();
  assert.equal(f.prepares[0]?.body, '  /tree\n    qsb n  ');
  assert.equal(f.prepares[0]?.model, 'provider/model');
  assert.equal(f.starts.length, 0);
  assert.match(f.component.render(160, 60).join('\n'), /provider\/model/);
  f.component.handleInput('e');
  assert.deepEqual(f.discards, ['review-1']);
  f.component.handleInput('\x1bm'); // Body editor again.
  f.component.handleInput('\x1b\r'); // Alt+Enter inserts a newline rather than submitting.
  f.component.handleInput('literal end');
  f.component.handleInput('\x13');
  await tick();
  assert.equal(f.prepares[1]?.body, '  /tree\n    qsb n  \nliteral end');
  f.component.dispose();
});

test('unavailable source-copy requires separate explicit acknowledgment, never claims closure/reconnect', async () => {
  const f = fixture(true);
  await prepared(f);
  assert.equal(f.prepares.length, 0);
  assert.match(f.component.render(160, 40).join('\n'), /explicitly acknowledges unconfirmed source closure/);
  f.component.handleInput('\x1ba');
  f.component.handleInput('\r');
  await tick();
  assert.equal(f.prepares[0]?.acknowledgeUnconfirmedSource, true);
  const output = f.component.render(160, 60).join('\n');
  assert.match(output, /YES \(not proof of closure\)/);
  assert.match(output, /no process\/workspace restoration|No workspace\/process restoration/);
  f.component.handleInput('e');
  f.component.handleInput('\x1ba');
  f.component.handleInput('\r');
  await tick();
  assert.equal(f.prepares.length, 1, 'toggling acknowledgment off cannot reuse prior token');
  assert.equal(f.starts.length, 0);
  f.component.dispose();
});

test('atomic split paste rejects mixed prefixes, excessive size, unsafe suffixes and suffix submit/confirm', async () => {
  const f = fixture();
  f.component.handleInput('seed');
  const packets = ['prefix\x1b[200~paste\x1b[201~TRAIL', '\x1b[200~paste\x1b[201~\x13', '\x1b[200~paste\x1b[201~\x19', '\x1b[200~bad\x1b[31m\x1b[201~TRAIL', `\x1b[200~${'x'.repeat(16385)}\x1b[201~TRAIL`];
  for (const packet of packets) {
    f.component.handleInput(packet);
    assert.match(f.component.render(160, 40).join('\n'), /Paste rejected/);
    assert.equal(f.prepares.length, 0);
    assert.equal(f.starts.length, 0);
  }
  f.component.handleInput('\x1b[200~  literal\n    code\x1b[20');
  assert.equal(f.prepares.length, 0);
  f.component.handleInput('1~qsb n');
  f.component.handleInput('\r');
  await tick();
  assert.equal(f.prepares[0]?.body, 'seed  literal\n    codeqsb n');
  f.component.render(160, 60);
  f.component.handleInput('\x1b[200~literal edit\x1b[201~\x19');
  assert.deepEqual(f.discards, ['review-1'], 'review invalidated before handling pasted edits');
  assert.equal(f.starts.length, 0);
  f.component.dispose();
});

test('blank, over-limit draft/model and readonly policy failures retain drafts without start', async () => {
  const f = fixture();
  f.component.handleInput('  ');
  f.component.handleInput('\r');
  assert.equal(f.prepares.length, 0);
  f.component.handleInput(`\x1b[200~${'x'.repeat(16384)}\x1b[201~`);
  assert.match(f.component.render(160, 40).join('\n'), /Paste rejected/);
  f.component.handleInput('keep');
  f.service.prepare = async (request) => { f.prepares.push(request); throw new Error('Current task is readOnly'); };
  f.component.handleInput('\r');
  await tick();
  assert.match(f.component.render(160, 40).join('\n'), /readOnly/);
  assert.match(f.component.render(160, 40).join('\n'), /keep/);
  assert.equal(f.starts.length, 0);
  f.component.handleInput('\x1bm');
  f.component.handleInput(`\x1b[200~${'m'.repeat(513)}\x1b[201~`);
  assert.match(f.component.render(160, 40).join('\n'), /Paste rejected/);
  f.component.dispose();
});

test('edit, Escape, disposal and source/policy failure invalidate tokens and never auto-retry', async () => {
  const f = fixture();
  await prepared(f);
  f.component.render(160, 60);
  f.component.handleInput('e');
  assert.deepEqual(f.discards, ['review-1']);
  f.component.handleInput(' changed');
  f.component.handleInput('\r');
  await tick();
  f.component.render(160, 60);
  f.service.start = async (request) => { f.starts.push(request); throw new Error('Definition/policy changed; review invalid'); };
  f.component.handleInput('\x19');
  await tick();
  assert.match(f.component.render(160, 40).join('\n'), /Definition\/policy changed/);
  f.component.handleInput('\x19');
  assert.equal(f.starts.length, 1);
  f.component.handleInput('\x1b');
  assert.equal(f.closed, 1);
  assert.equal(f.disposedServices, 0);
  const stale = fixture();
  await prepared(stale);
  stale.component.render(160, 60);
  stale.setCurrent(false);
  assert.deepEqual(stale.discards, ['review-1']);
  stale.component.handleInput('\x19');
  assert.equal(stale.starts.length, 0);
  assert.match(stale.component.render(160, 40).join('\n'), /Source changed/);
  stale.component.dispose();
});

test('pending prepare owns generation; edit, Escape and source changes discard late review', async () => {
  for (const action of ['edit', 'escape', 'dispose', 'source']) {
    const f = fixture();
    let resolve!: (value: NativeContinuationReview) => void;
    f.service.prepare = (request) => { f.prepares.push(request); return new Promise((done) => { resolve = done; }); };
    f.component.handleInput('first');
    f.component.handleInput('\r');
    f.component.handleInput('\r');
    assert.equal(f.prepares.length, 1);
    if (action === 'edit') f.component.handleInput(' later');
    if (action === 'escape') f.component.handleInput('\x1b');
    if (action === 'dispose') f.component.dispose();
    if (action === 'source') f.setCurrent(false);
    resolve(review(f.prepares[0]!));
    await tick();
    assert.deepEqual(f.discards, ['review-1']);
    f.component.handleInput('\x19');
    assert.equal(f.starts.length, 0);
    assert.doesNotMatch(f.component.render(160, 60).join('\n'), /Source fingerprint:/);
    f.component.dispose();
  }
});

test('late prepare rejection after close is contained; a submitted task is never aborted by close', async () => {
  const f = fixture();
  let reject!: (error: Error) => void;
  f.service.prepare = () => new Promise((_resolve, fail) => { reject = fail; });
  f.component.handleInput('draft');
  f.component.handleInput('\r');
  f.component.handleInput('\x1b');
  const renders = f.renders;
  reject(new Error('late review error'));
  await tick();
  assert.equal(f.renders, renders);
  const g = fixture();
  await prepared(g);
  g.component.render(160, 60);
  let resolve!: (value: { runId: string; taskId: string }) => void;
  g.service.start = (request) => { g.starts.push(request); return new Promise((done) => { resolve = done; }); };
  g.component.handleInput('\x19');
  g.component.handleInput('\x1b');
  assert.deepEqual(g.starts, [{ reviewId: 'review-1', confirm: true }]);
  assert.equal('signal' in g.starts[0]!, false);
  assert.equal(g.discards.length, 0, 'submitted token is consumed, not cancellation-owned');
  resolve({ runId: 'late-run', taskId: 'late-task' });
  await tick();
  assert.doesNotMatch(g.component.render(160, 40).join('\n'), /late-run/);
  assert.equal(g.disposedServices, 0);
});

test('review identity/body mismatch, expiry and unbounded policy reject before authorization', async () => {
  for (const patch of [{ key: { ...key, memberRunId: 'other' } }, { entryId: 'other-entry' }, { body: 'substituted body' }, { expiresAt: '2000-01-01' },
    { policy: { prompt: 'x'.repeat(65537) } as unknown as NativeContinuationReview['policy'] }]) {
    const f = fixture();
    f.service.prepare = async (request) => { f.prepares.push(request); return review(request, patch); };
    await prepared(f, 'retained exact task');
    const output = f.component.render(160, 40).join('\n');
    assert.match(output, /Review failed/);
    assert.match(output, /retained exact task/);
    f.component.handleInput('\x19');
    assert.equal(f.starts.length, 0);
    assert.deepEqual(f.discards, ['review-1']);
    f.component.dispose();
  }
});

test('review is copied; backend mutation cannot replace source/body/policy/token after render', async () => {
  const f = fixture();
  let candidate!: NativeContinuationReview;
  f.service.prepare = async (request) => { f.prepares.push(request); return candidate = review(request); };
  await prepared(f);
  f.component.render(160, 60);
  candidate.reviewId = 'mutated-token';
  candidate.key.memberRunId = 'mutated-member';
  candidate.body = 'mutated-body';
  candidate.policy = { prompt: 'mutated-policy' } as unknown as NativeContinuationReview['policy'];
  assert.doesNotMatch(f.component.render(160, 60).join('\n'), /mutated-/);
  f.component.handleInput('\x19');
  await tick();
  assert.deepEqual(f.starts, [{ reviewId: 'review-1', confirm: true }]);
  f.component.dispose();
});

test('safe bounded disclosure scrolls full tuple/policy/body; narrow/focus/truncation never authorize', async () => {
  const f = fixture();
  f.service.prepare = async (request) => { f.prepares.push(request); return review(request, { warnings: ['\x1b]52;clipboard\x07evil\n    indented'], policy: { tools: ['bash'], prompt: Array.from({ length: 100 }, (_, i) => `policy-line-${i}`).join('\n') } as unknown as NativeContinuationReview['policy'] }); };
  f.component.handleInput('界👩‍💻é');
  for (const width of [1, 2, 8, 12, 21, 80, 240]) for (const height of [1, 4, 8, 10, 24, 60]) {
    const frame = f.component.render(width, height);
    assert.ok(frame.length <= height);
    for (const line of frame) { assert.ok(visibleWidth(line) <= width); assert.equal(line.includes('\n'), false); }
    if (width >= 12 && height >= 10) assert.ok(frame.some((line) => line.includes(CURSOR_MARKER)));
  }
  f.component.focused = false;
  assert.equal(f.component.render(160, 40).some((line) => line.includes(CURSOR_MARKER)), false);
  f.component.focused = true;
  f.component.handleInput('\r'); await tick();
  f.component.render(8, 8);
  f.component.handleInput('\x19');
  assert.equal(f.starts.length, 0);
  f.component.render(160, 20);
  f.component.handleInput('\x1b[F');
  const tail = f.component.render(160, 20).join('\n');
  assert.match(tail, /End of task body/);
  assert.doesNotMatch(tail, /\x1b\]52/);
  assert.match(tail, /\\u001b/);
  f.component.handleInput('\x1b[H');
  assert.match(f.component.render(160, 20).join('\n'), /Source parent run: parent-source/);
  f.component.dispose();
  const clipped = fixture();
  await prepared(clipped, 'x\n'.repeat(8192));
  const output = clipped.component.render(160, 40).join('\n');
  assert.match(output, /UI display truncated; confirmation disabled/);
  clipped.component.handleInput('\x19');
  assert.equal(clipped.starts.length, 0);
  clipped.component.dispose();
});

test('throwing observer/discard and arbitrary errors are safe; no implicit submission', async () => {
  const f = fixture();
  f.service.prepare = async () => { throw Object.assign(Object.create(null), { toString: null }); };
  await prepared(f);
  assert.match(f.component.render(160, 40).join('\n'), /Unknown error/);
  assert.equal(f.starts.length, 0);
  f.service.prepare = async (request) => review(request);
  f.component.handleInput('\r'); await tick();
  f.service.discard = () => { throw new Error('discard failed'); };
  assert.doesNotThrow(() => f.component.handleInput('e'));
  assert.equal(f.starts.length, 0);
  f.component.dispose();
});


test('reentrant redraw disposal before authorization commit never calls start', async () => {
  const f = fixture();
  let armed = false;
  let component!: ClankersContinuationReviewComponent;
  component = new ClankersContinuationReviewComponent({ terminal: { rows: 48 }, requestRender: () => { if (armed) { armed = false; component.dispose(); } } }, undefined,
    { source: { key, entryId: 'at-entry', unconfirmed: false }, service: f.service, isCurrent: () => true, close: () => undefined });
  component.focused = true;
  component.render(160, 40);
  component.handleInput('NEW task'); component.handleInput('\r'); await tick();
  component.render(160, 60);
  armed = true;
  component.handleInput('\x19');
  await tick();
  assert.equal(f.starts.length, 0);
  assert.deepEqual(f.discards, ['review-1']);
  assert.equal(f.disposedServices, 0);
  component.dispose(); f.component.dispose();
});

test('expired displayed review invalidates token and result destination remains scrollable', async () => {
  const f = fixture();
  f.service.prepare = async (request) => review(request, { expiresAt: new Date(Date.now() + 60000).toISOString() });
  await prepared(f);
  f.component.render(160, 60);
  // Simulate expiry without waiting or replacing the review with backend mutable data.
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 120000;
    f.component.handleInput('\x19');
  } finally { Date.now = originalNow; }
  assert.equal(f.starts.length, 0);
  assert.deepEqual(f.discards, ['review-1']);
  assert.match(f.component.render(160, 40).join('\n'), /Review expired/);
  f.component.handleInput('\r'); await tick();
  f.component.render(160, 60); f.component.handleInput('\x19'); await tick();
  f.component.render(30, 10);
  f.component.handleInput('\x1b[F');
  assert.match(f.component.render(30, 10).join('\n'), /NEW-task/);
  f.component.dispose();
});


test('source invalidation is idempotent: repeated renders/publications do not request redraw loops', async () => {
  const f = fixture();
  await prepared(f);
  f.component.render(160, 60);
  f.setCurrent(false);
  const afterInvalidation = f.renders;
  assert.deepEqual(f.discards, ['review-1']);
  for (let index = 0; index < 100; index++) {
    f.component.sourceChanged();
    f.component.render(index % 2 ? 80 : 160, 40);
  }
  assert.equal(f.renders, afterInvalidation);
  assert.deepEqual(f.discards, ['review-1']);
  f.component.handleInput('\x19');
  assert.equal(f.starts.length, 0);
  f.component.dispose();
});

test('ordinary 500-character task can be typed key by key and reviewed exactly', async () => {
  const f = fixture();
  const task = '  Inspect this task literally; no shortcuts. '.repeat(12).slice(0, 500);
  for (const char of task) f.component.handleInput(char);
  assert.doesNotMatch(f.component.render(160, 40).join('\n'), /Editing history limit/);
  f.component.handleInput('\r'); await tick();
  assert.equal(f.prepares[0]?.body, task);
  assert.equal(f.starts.length, 0);
  f.component.dispose();
});

test('end typing checkpoints bounded undo history and continues past multiple budgets with exact review', async () => {
  const f = fixture();
  let task = '';
  for (let index = 0; index < 2200; index++) {
    if (index === 600) { f.component.handleInput('\x1b\r'); task += '\n'; }
    f.component.handleInput('x'); task += 'x';
    if (index === 1023 || index === 2047) {
      assert.match(f.component.render(160, 40).join('\n'), /body undo checkpoint/);
    }
  }
  f.component.handleInput('\r'); await tick();
  assert.equal(f.prepares[0]?.body, task);
  assert.equal(f.starts.length, 0);
  f.component.render(160, 40);
  f.component.handleInput('\x1b[F');
  assert.match(f.component.render(160, 40).join('\n'), /End of task body/);
  f.component.handleInput('\x19'); await tick();
  assert.deepEqual(f.starts, [{ reviewId: 'review-1', confirm: true }]);
  f.component.dispose();
});

test('middle cursor at undo budget retains position and draft until explicit end navigation', async () => {
  const f = fixture();
  for (let index = 0; index < 1024; index++) f.component.handleInput('x');
  f.component.handleInput('\x1b[D');
  const cursorLine = f.component.render(180, 40).find((line) => line.includes(CURSOR_MARKER));
  assert.ok(cursorLine);
  f.component.handleInput('REJECTED');
  const blocked = f.component.render(180, 40);
  assert.match(blocked.join('\n'), /Editing history limit: move cursor to body end/);
  assert.equal(blocked.find((line) => line.includes(CURSOR_MARKER)), cursorLine);
  f.component.handleInput('\x05'); // Explicit public line-end navigation.
  f.component.handleInput('accepted');
  assert.match(f.component.render(180, 40).join('\n'), /body undo checkpoint/);
  f.component.handleInput('\r'); await tick();
  assert.equal(f.prepares[0]?.body, 'x'.repeat(1024) + 'accepted');
  assert.equal(f.starts.length, 0);
  f.component.dispose();
});

test('body and model budgets are independent; model checkpoints cannot reset body undo accounting', async () => {
  const f = fixture();
  for (let index = 0; index < 1024; index++) f.component.handleInput('x');
  f.component.handleInput('\x1bm');
  // Stay within the model text bound while exercising its own undo history.
  for (let index = 0; index < 512; index++) {
    f.component.handleInput('m');
    f.component.handleInput('\x7f');
  }
  f.component.handleInput('p');
  assert.match(f.component.render(180, 40).join('\n'), /model undo checkpoint/);
  f.component.handleInput('rovider/model');
  f.component.handleInput('\x1bm');
  f.component.handleInput('\x1b[D');
  const before = f.component.render(180, 40).find((line) => line.includes(CURSOR_MARKER));
  f.component.handleInput('REJECTED');
  const blocked = f.component.render(180, 40);
  assert.match(blocked.join('\n'), /Editing history limit: move cursor to body end/);
  assert.equal(blocked.find((line) => line.includes(CURSOR_MARKER)), before);
  f.component.handleInput('\x05');
  f.component.handleInput('accepted');
  assert.match(f.component.render(180, 40).join('\n'), /body undo checkpoint/);
  f.component.handleInput('\r'); await tick();
  assert.equal(f.prepares[0]?.body, 'x'.repeat(1024) + 'accepted');
  assert.equal(f.prepares[0]?.model, 'provider/model');
  assert.equal(f.starts.length, 0);
  f.component.dispose();
});
