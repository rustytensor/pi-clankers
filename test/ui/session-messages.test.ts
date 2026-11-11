import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionMessageService, getSessionMessageReceipts, OPERATOR_CUSTOM_TYPE, validateSessionMessageInput } from '../../session-messages.js';
import { createClankersStateContainer } from '../../state.js';
import { createClankersPersistenceManager, recoverClankersStateAfterRestart } from '../../persistence.js';
import type { ClankersSessionMessageInput, ClankersSessionMessageKey, ClankersState } from '../../types.js';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const key: ClankersSessionMessageKey = { parentRunId: 'parent', memberRunId: 'member', piSessionId: 'pi' };
const input = (messageId = 'm', overrides: Partial<ClankersSessionMessageInput> = {}): ClankersSessionMessageInput => ({ key: { ...key }, messageId, body: '  /literal\n\tcode  ', mode: 'followUp', ...overrides });
function fixture(save?: (state: ClankersState) => unknown) {
  const container = createClankersStateContainer(); let readonly = false, accepting = true;
  const calls: ClankersSessionMessageInput[] = []; let listener: (event: unknown) => void = () => undefined;
  let enqueue: (message: ClankersSessionMessageInput) => unknown = () => undefined;
  const service = createSessionMessageService({ container, readOnly: () => readonly, save });
  const release = service.register(key, { accepting: () => accepting, subscribe(fn) { listener = fn; return () => { listener = () => undefined; }; }, enqueue(message) { calls.push(message); return enqueue(message); } });
  return { container, service, calls, release, emit: (event: unknown) => listener(event), readonly: (value: boolean) => { readonly = value; }, accepting: (value: boolean) => { accepting = value; }, enqueue: (fn: typeof enqueue) => { enqueue = fn; } };
}
const consumed = (messageId: string, target = key) => ({ type: 'message_start', message: { role: 'custom', customType: OPERATOR_CUSTOM_TYPE, content: 'transformed', details: { schemaVersion: 1, ...target, messageId } } });

test('exact IDs, same-body distinct IDs and immutable idempotent receipts', async () => {
  const f = fixture();
  assert.equal((await f.service.send(input())).receipt?.status, 'queued');
  assert.equal((await f.service.send(input())).receipt?.status, 'queued'); assert.equal(f.calls.length, 1);
  assert.equal((await f.service.send(input('m', { body: 'different' }))).ok, false); assert.equal(f.calls.length, 1);
  assert.equal((await f.service.send(input('m2'))).ok, true); assert.equal(f.calls.length, 2);
  assert.equal((await f.service.send(input('wrong', { key: { ...key, memberRunId: 'leader' } }))).ok, false);
  assert.equal((await f.service.send(input('wrong-pi', { key: { ...key, piSessionId: 'other' } }))).ok, false);
  assert.equal(f.calls.length, 2);
  f.emit(consumed('m', { ...key, piSessionId: 'other' })); assert.equal(f.service.list(key)[0]!.status, 'queued');
  f.emit(consumed('m')); assert.equal(f.service.list(key)[0]!.status, 'delivered');
  const copy = f.service.list(key); copy[0]!.key.memberRunId = 'mutated'; copy[0]!.status = 'failed';
  assert.equal(f.service.list(key)[0]!.status, 'delivered'); assert.equal(f.service.list(key)[0]!.key.memberRunId, 'member');
  assert.equal(f.service.list(key)[0]!.body, '  /literal\n\tcode  ');
  f.release(); assert.equal(f.service.getState(key).canSend, false);
});

test('readonly, inactive, invalid bodies and IDs fail before mutation', async () => {
  const f = fixture(); f.readonly(true); assert.equal((await f.service.send(input())).ok, false);
  f.readonly(false); f.accepting(false); assert.equal((await f.service.send(input())).ok, false);
  f.accepting(true);
  for (const body of ['', ' \n\t', '\x1b[31munsafe', 'x\r\ny', 'x'.repeat(16385), '\x00', '\x7f']) assert.equal((await f.service.send(input('invalid', { body }))).ok, false);
  assert.equal(validateSessionMessageInput(input('bad id')), false);
  assert.equal(validateSessionMessageInput(input('id', { mode: 'nextTurn' as never })), false);
  assert.equal(validateSessionMessageInput(input('id', { key: { ...key, piSessionId: '' } })), false);
  assert.equal(f.calls.length, 0); assert.equal(f.service.list(key).length, 0);
  assert.throws(() => f.service.list(key, 0)); assert.throws(() => f.service.list(key, 129));
});

test('intent persists before native enqueue and final guard handles synchronous readonly changes', async () => {
  const order: string[] = []; const f = fixture(() => { order.push('save'); });
  f.enqueue(() => { order.push('enqueue'); });
  assert.equal((await f.service.send(input())).ok, true);
  const enqueueAt = order.indexOf('enqueue'); assert(enqueueAt > 0);
  assert(order.slice(0, enqueueAt).every((step) => step === 'save'));
  assert(order.slice(enqueueAt + 1).includes('save'), 'queued receipt also persists after enqueue');
  f.container.subscribe?.(() => f.readonly(true));
  assert.equal((await f.service.send(input('guard'))).ok, false); assert.equal(f.calls.length, 1);
  assert.equal(f.service.list(key).find((r) => r.messageId === 'guard')?.status, 'failed');
});

test('pre-save failure sends nothing; post-enqueue failure retains volatile queued and delivered truth', async () => {
  const pre = fixture(() => { throw Error('disk full'); });
  const rejected = await pre.service.send(input()); assert.equal(rejected.ok, false); assert.equal(pre.calls.length, 0);
  assert.equal(rejected.receipt?.status, 'failed'); assert.equal(rejected.receipt?.persistence, 'failed');
  let enqueued = false; const post = fixture(() => { if (enqueued) throw Error('disk full'); }); post.enqueue(() => { enqueued = true; });
  const result = await post.service.send(input()); assert.equal(result.ok, true); assert.equal(result.receipt?.status, 'queued'); assert.equal(result.receipt?.persistence, 'failed');
  post.emit(consumed('m')); assert.equal(post.service.list(key)[0]!.status, 'delivered'); assert.equal(post.service.list(key)[0]!.persistence, 'failed');
  const duplicate = await post.service.send(input()); assert.equal(duplicate.receipt?.status, 'delivered'); assert.equal(post.calls.length, 1);
});

test('late enqueue resolution never downgrades consumption or settled uncertainty', async () => {
  const f = fixture(); let resolve!: () => void;
  f.enqueue(() => new Promise<void>((done) => { resolve = done; }));
  const sending = f.service.send(input()); f.emit(consumed('m')); resolve();
  assert.equal((await sending).receipt?.status, 'delivered');
  const g = fixture(); let finish!: () => void;
  g.enqueue(() => new Promise<void>((done) => { finish = done; }));
  const unconsumed = g.service.send(input()); g.emit({ type: 'agent_end' }); assert.equal(g.service.getState(key).canSend, true);
  g.emit({ type: 'agent_settled' }); finish();
  assert.equal((await unconsumed).receipt?.status, 'needs-attention'); assert.equal(g.service.getState(key).canSend, false);
});

test('unknown enqueue errors are not retried; transformed/drop IDs and queue disappearance never imply delivery', async () => {
  const f = fixture(); f.enqueue(() => { throw Error('uncertain transport'); });
  assert.equal((await f.service.send(input())).receipt?.status, 'needs-attention'); await f.service.send(input()); assert.equal(f.calls.length, 1);
  const g = fixture(); await g.service.send(input());
  g.emit({ type: 'queue_update', steering: [], followUp: [] });
  g.emit({ type: 'message_end', message: { role: 'custom', customType: OPERATOR_CUSTOM_TYPE, content: 'same body' } });
  g.emit({ type: 'message_start', message: { role: 'custom', customType: OPERATOR_CUSTOM_TYPE, content: 'same body' } });
  assert.equal(g.service.list(key)[0]!.status, 'queued'); g.release(); assert.equal(g.service.list(key)[0]!.status, 'needs-attention');
  const h = fixture(); await h.service.send(input()); h.emit(consumed('m'));
  h.emit({ type: 'message_end', message: { role: 'custom', customType: 'changed', content: 'filtered' } });
  h.service.closeParent(key.parentRunId); h.release(); assert.equal(h.service.list(key)[0]!.status, 'delivered');
});

test('subscriber failures and repeated disposal cannot change receipt/run ownership', async () => {
  const f = fixture(); let notices = 0;
  const unsubscribe = f.service.subscribe(key, () => { throw Error('viewer'); });
  f.service.subscribe(key, () => { notices++; });
  await f.service.send(input()); assert(notices > 0); unsubscribe(); unsubscribe();
  f.service.shutdown(); f.service.shutdown(); f.release(); f.release();
  assert.equal(f.service.list(key)[0]!.status, 'needs-attention'); assert.equal((await f.service.send(input('new'))).ok, false);
});

test('bounded receipt capacity rejects rather than silently evicting IDs', async () => {
  const f = fixture();
  for (let i = 0; i < 32; i++) assert.equal((await f.service.send(input(`id${i}`))).ok, true);
  assert.equal((await f.service.send(input('overflow'))).ok, false); assert.equal(f.calls.length, 32);
  for (let i = 0; i < 32; i++) f.emit(consumed(`id${i}`));
  for (let i = 32; i < 128; i++) { await f.service.send(input(`id${i}`)); f.emit(consumed(`id${i}`)); }
  assert.equal(f.service.list(key, 128).length, 128); assert.equal((await f.service.send(input('overflow-total'))).ok, false);
  assert.equal((await f.service.send(input('id0'))).receipt?.status, 'delivered'); assert.equal(f.calls.length, 128);
  assert.equal(f.service.getState(key).receipts.length, 8); assert.equal(f.service.getState(key).droppedReceipts, 120);
});

test('opt-in snapshot recovery finalizes pending receipts without reconnect/replay even with no active run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clankers-receipt-'));
  try {
    assert.equal(createClankersPersistenceManager(undefined), undefined); assert.equal(createClankersPersistenceManager({ enabled: false, rootDir: dir }), undefined);
    const manager = createClankersPersistenceManager({ enabled: true, rootDir: dir })!;
    const f = fixture((state) => manager.save(state)); await f.service.send(input());
    assert(manager.info.snapshotFile);
    const saved = JSON.parse(readFileSync(manager.info.snapshotFile, 'utf8')); assert.equal(saved.state.extensions.clankersSessionMessages.receipts[0].status, 'queued');
    const recovered = createClankersStateContainer(); manager.hydrate(recovered);
    const receipts = getSessionMessageReceipts(recovered.read()); assert.equal(receipts[0]!.status, 'needs-attention');
    const isolated = createSessionMessageService({ container: recovered, readOnly: () => false });
    assert.equal(isolated.getState(key).canSend, false); assert.equal((await isolated.send(input())).receipt?.status, 'needs-attention');
    assert.equal(f.calls.length, 1); assert.deepEqual(recoverClankersStateAfterRestart(recovered.read()).recoveredRunIds, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('unsupported ledgers are not silently rewritten or treated as empty', async () => {
  const f = fixture();
  f.container.replace({ ...f.container.read(), extensions: { clankersSessionMessages: { schemaVersion: 2, receipts: [{ messageId: 'existing' }] } } });
  assert.equal((await f.service.send(input())).ok, false); assert.equal(f.calls.length, 0);
  assert.equal((f.container.read().extensions.clankersSessionMessages as { schemaVersion: number }).schemaVersion, 2);
});

test('recognized native operator history displays only whitelisted content', async () => {
  const { createNativeTranscriptService } = await import('../../native-transcript.js');
  const ref = { schemaVersion: 1 as const, ...key, agentDefinitionId: 'definition', sessionFile: '/not-opened', cwd: '/tmp', createdAt: new Date().toISOString(), attachment: 'attached' as const };
  const service = createNativeTranscriptService({ getReferences: () => [ref] });
  const release = service.register(ref, { subscribe: () => () => undefined, getMessages: () => [], getLeafId: () => 'operator', getEntryCount: () => 1,
    getEntries: () => [{ type: 'custom_message', id: 'operator', parentId: null, customType: OPERATOR_CUSTOM_TYPE, content: 'operator input', details: { secret: 'MUST NOT DISPLAY' } }] });
  const view = await service.open(key);
  assert.match(JSON.stringify(view.getSnapshot().blocks), /operator input/); assert.doesNotMatch(JSON.stringify(view.getSnapshot().blocks), /MUST NOT DISPLAY/);
  release(); view.dispose(); service.shutdown();
});


test('global message IDs cannot be retargeted and unrecognized fields never enter receipts', async () => {
  const f = fixture(); const other = { ...key, memberRunId: 'other', piSessionId: 'other' }; let otherCalls = 0;
  f.service.register(other, { accepting: () => true, subscribe: () => () => undefined, enqueue: () => { otherCalls++; } });
  const hostile = { ...input(), unbounded: 'x'.repeat(1000000), key: { ...key, extra: 'unbounded' } };
  await f.service.send(hostile);
  const ledger = f.container.read().extensions.clankersSessionMessages as { receipts: Record<string, unknown>[] };
  assert.equal(ledger.receipts[0]!.unbounded, undefined); assert.equal((ledger.receipts[0]!.key as Record<string, unknown>).extra, undefined);
  assert.equal((await f.service.send(input('m', { key: other }))).ok, false); assert.equal(otherCalls, 0);
  const candidate = { ...f.service.list(key)[0]!, unbounded: 'x'.repeat(1000000) };
  f.container.replace({ ...f.container.read(), extensions: { clankersSessionMessages: { schemaVersion: 1, receipts: [candidate] } } });
  assert.equal((getSessionMessageReceipts(f.container.read())[0] as unknown as Record<string, unknown>).unbounded, undefined);
  const malformed = { ...candidate, status: { toString: () => 'queued' } };
  f.container.replace({ ...f.container.read(), extensions: { clankersSessionMessages: { schemaVersion: 1, receipts: [malformed] } } });
  assert.deepEqual(getSessionMessageReceipts(f.container.read()), []); assert.equal((await f.service.send(input('new'))).ok, false);
});

test('retained native callbacks after release, shutdown or subscription failure cannot change receipts', async () => {
  const container = createClankersStateContainer(); const service = createSessionMessageService({ container, readOnly: () => false });
  let retained!: (event: unknown) => void;
  const release = service.register(key, { accepting: () => true, subscribe(fn) { retained = fn; return () => undefined; }, enqueue() {} });
  await service.send(input()); release(); const after = service.list(key);
  retained(consumed('m')); assert.deepEqual(service.list(key), after);
  const next = service.register(key, { accepting: () => true, subscribe(fn) { retained = fn; return () => undefined; }, enqueue() {} });
  await service.send(input('next')); service.shutdown(); const closed = service.list(key); retained(consumed('next')); assert.deepEqual(service.list(key), closed); next();
  const failed = createSessionMessageService({ container, readOnly: () => false });
  failed.register(key, { accepting: () => true, subscribe(fn) { retained = fn; throw Error('subscribe failure'); }, enqueue() {} });
  retained(consumed('m')); assert.deepEqual(failed.list(key), closed); failed.shutdown();
});

test('availability notices include native start and canonical readonly updates, not stream deltas', () => {
  const f = fixture(); let notices = 0; const revision = f.container.read().revision;
  f.service.subscribe(key, () => { notices++; });
  f.emit({ type: 'message_update', message: { role: 'assistant', content: 'delta' } }); assert.equal(notices, 0);
  f.emit({ type: 'agent_start' }); assert.equal(notices, 1); assert.equal(f.container.read().revision, revision);
  f.readonly(true); f.container.replace(f.container.read()); assert(notices > 1); assert.equal(f.service.getState(key).canSend, false);
  f.release();
});

test('reentrant submission during intent publication is rejected without losing saved intents', async () => {
  const saved: ClankersState[] = []; const f = fixture((state) => { saved.push(state); });
  const attempts: Promise<unknown>[] = [];
  const unsubscribe = f.container.subscribe?.(() => { attempts.push(f.service.send(input('reentrant'))); });
  assert.equal((await f.service.send(input())).ok, true); await Promise.all(attempts); unsubscribe?.();
  assert.equal(f.calls.length, 1); assert.deepEqual(f.service.list(key).map((receipt) => receipt.messageId), ['m']);
  assert(saved.every((state) => getSessionMessageReceipts(state).length === 1));
  assert.equal((await f.service.send(input('later'))).ok, true); assert.equal(f.calls.length, 2);
});

test('receipt recovery preserves prior uncertainty and repeated hydration timestamps', async () => {
  const f = fixture(); await f.service.send(input()); f.release();
  const before = f.service.list(key)[0]!;
  const once = recoverClankersStateAfterRestart(f.container.read(), { now: () => new Date('2030-01-01') }).state;
  const twice = recoverClankersStateAfterRestart(once, { now: () => new Date('2031-01-01') }).state;
  assert.deepEqual(getSessionMessageReceipts(once)[0], before); assert.deepEqual(getSessionMessageReceipts(twice), getSessionMessageReceipts(once));
});


test('first explicit queued or delivered snapshot failure preserves observed transport status', async () => {
  for (const status of ['queued', 'delivered'] as const) {
    const f = fixture((state) => { if (getSessionMessageReceipts(state).some((receipt) => receipt.status === status)) throw Error(`prepublication ${status}`); });
    const result = await f.service.send(input());
    assert.equal(result.ok, true); assert.equal(result.receipt?.status, 'queued'); assert.equal(f.calls.length, 1);
    if (status === 'delivered') f.emit(consumed('m'));
    const observed = f.service.list(key)[0]!;
    assert.equal(observed.status, status); assert.equal(observed.persistence, 'failed');
    const duplicate = await f.service.send(input()); assert.equal(duplicate.ok, true); assert.equal(duplicate.receipt?.status, status); assert.equal(f.calls.length, 1);
    f.release(); f.service.shutdown();
  }
});

test('failed queued snapshot merges newer reentrant delivery without losing other rows', async () => {
  let f!: ReturnType<typeof fixture>; let inject = false;
  f = fixture((state) => {
    if (inject && getSessionMessageReceipts(state).some((receipt) => receipt.messageId === 'm' && receipt.status === 'queued')) {
      inject = false; f.emit(consumed('m')); throw Error('outer queued snapshot');
    }
  });
  await f.service.send(input('other')); f.emit(consumed('other'));
  const before = f.service.list(key)[0]!; inject = true;
  const result = await f.service.send(input());
  assert.equal(result.ok, true); assert.equal(result.receipt?.status, 'delivered'); assert.equal(result.receipt?.persistence, 'failed');
  assert.deepEqual(f.service.list(key)[0], before); assert.equal(f.calls.length, 2);
  f.release(); f.service.shutdown();
});

test('request abort before intent or during publication sends nothing; post-enqueue abort retains truth', async () => {
  const pre = fixture(); const initial = new AbortController(); initial.abort();
  assert.equal((await pre.service.send(input(), initial.signal)).ok, false); assert.equal(pre.service.list(key).length, 0); assert.equal(pre.calls.length, 0);
  const f = fixture(); const during = new AbortController();
  const unsubscribe = f.container.subscribe?.(() => during.abort());
  const rejected = await f.service.send(input(), during.signal); unsubscribe?.();
  assert.equal(rejected.ok, false); assert.equal(rejected.receipt?.status, 'failed'); assert.equal(f.calls.length, 0);
  const after = new AbortController(); f.enqueue(() => { after.abort(); });
  const queued = await f.service.send(input('after'), after.signal);
  assert.equal(queued.ok, true); assert.equal(queued.receipt?.status, 'queued'); assert.equal(f.calls.length, 1);
  f.emit(consumed('after')); assert.equal(f.service.list(key).find((receipt) => receipt.messageId === 'after')?.status, 'delivered');
  pre.release(); pre.service.shutdown(); f.release(); f.service.shutdown();
});
