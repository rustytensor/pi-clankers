import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createNativeTranscriptService, sanitizeNativeTranscriptText, type NativeTranscriptReadFacade } from '../../native-transcript.js';
import type { ClankersNativeSessionReference } from '../../types.js';

const tick = () => new Promise((done) => setTimeout(done, 45));
const ref = (extra: Partial<ClankersNativeSessionReference> = {}): ClankersNativeSessionReference => ({ schemaVersion: 1,
  parentRunId: 'clankers-parent', memberRunId: 'clankers-member', agentDefinitionId: 'worker', piSessionId: 'native-id',
  sessionFile: '/missing/native-id.jsonl', cwd: '/fixture', createdAt: '2026-10-02T00:00:00.000Z', attachment: 'attached', ...extra });
function fake() {
  let entries: any[] = [], leaf: string | null = null; let calls = 0;
  const listeners = new Set<(event: any) => void>();
  const facade: NativeTranscriptReadFacade = { subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    getEntryCount: () => entries.length, getEntries: () => { calls++; return entries; }, getLeafId: () => leaf, getMessages: () => [] };
  const emit = (event: any) => { for (const fn of listeners) fn(event); };
  const append = (row: any) => { entries.push(row); leaf = row.id; };
  return { facade, emit, append, listeners, reads: () => calls, setRows(rows: any[]) { entries = rows; leaf = rows.at(-1)?.id ?? null; } };
}
const message = (id: string, parentId: string | null, role: string, content: any, extra = {}) => ({ type: 'message', id, parentId, message: { role, content, ...extra } });

test('exact identity/owner isolation, streaming late attach, final append reconciliation, capture and callback isolation', async () => {
  const reference = ref(), source = fake(); source.append(message('user', null, 'user', 'original'));
  const service = createNativeTranscriptService({ getReferences: () => [reference] });
  const independent = createNativeTranscriptService({ getReferences: () => [reference] });
  const release = service.register(reference, source.facade);
  const wrong = await service.open({ ...reference, memberRunId: 'other' });
  assert.equal(wrong.getSnapshot().source, 'unavailable'); wrong.dispose();
  const isolated = await independent.open(reference); assert.equal(isolated.getSnapshot().source, 'unavailable'); isolated.dispose();
  source.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  source.emit({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'plan', thinkingSignature: 'SECRET' }, { type: 'text', text: '  partial\n    code' }] } });
  const view = await service.open(reference);
  assert.match(JSON.stringify(view.getSnapshot().blocks), /partial/); assert.doesNotMatch(JSON.stringify(view.getSnapshot()), /SECRET/);
  let delivered = 0; view.subscribe(() => { throw Error('observer'); }); view.subscribe(() => { delivered++; });
  const final = { role: 'assistant', content: [{ type: 'text', text: 'authoritative' }] };
  source.emit({ type: 'message_end', message: final }); // SDK appends synchronously AFTER emit
  source.append({ type: 'message', id: 'final', parentId: 'user', message: final });
  source.emit({ type: 'agent_settled' }); await tick();
  assert(delivered > 0); assert.equal(view.getSnapshot().blocks.filter((block) => block.text === 'authoritative').length, 1);
  assert.doesNotMatch(JSON.stringify(view.getSnapshot().blocks), /partial/);
  const before = source.reads(); release(); release();
  assert.equal(source.listeners.size, 0); assert.equal(view.getSnapshot().source, 'captured'); assert.equal(view.getSnapshot().status, 'settled');
  assert.match(view.getSnapshot().diagnostic!, /not a persistence claim/); assert.match(JSON.stringify(view.getSnapshot().blocks), /authoritative/);
  source.emit({ type: 'message_update', message: { role: 'assistant', content: 'stale' } }); await tick(); assert.equal(source.reads(), before + 1);
  view.dispose(); view.dispose(); service.shutdown(); independent.shutdown();
});

test('finalized tool cards retire beyond 64 sequential calls and persisted redaction wins', async () => {
  const reference = ref(), source = fake(), service = createNativeTranscriptService({ getReferences: () => [reference] });
  source.append(message('user', null, 'user', 'tools'));
  const release = service.register(reference, source.facade); const view = await service.open(reference);
  let parent = 'user';
  for (let i = 0; i < 140; i++) {
    const id = `call-${i}`, callEntry = `a-${i}`, resultEntry = `r-${i}`;
    const call = { role: 'assistant', content: [{ type: 'toolCall', id, name: 'read', arguments: { path: '/fixture' } }] };
    source.emit({ type: 'message_start', message: call });
    source.emit({ type: 'message_end', message: call });
    source.append({ type: 'message', id: callEntry, parentId: parent, message: call });
    source.emit({ type: 'tool_execution_start', toolCallId: id, toolName: 'read', args: { path: '/fixture' } });
    source.emit({ type: 'tool_execution_end', toolCallId: id, toolName: 'read', result: { content: [{ type: 'text', text: 'UNREDACTED' }] } });
    source.append(message(resultEntry, callEntry, 'toolResult', [{ type: 'text', text: `redacted-${i}` }], { toolCallId: id, toolName: 'read' }));
    source.emit({ type: 'entry_appended' }); await Promise.resolve(); parent = resultEntry;
    source.emit({ type: 'tool_execution_update', toolCallId: id, toolName: 'read', partialResult: { content: [{ type: 'text', text: 'UNREDACTED_LATE' }] } });
  }
  assert(!view.getSnapshot().blocks.some((block) => block.toolCallId === 'call-0'), 'first call aged out of retained history');
  const reads = source.reads();
  for (const type of ['tool_execution_start', 'tool_execution_update', 'tool_execution_end']) {
    source.emit({ type, toolCallId: 'call-0', toolName: 'read', partialResult: { content: 'UNREDACTED_RETIRED' }, result: { content: 'UNREDACTED_RETIRED' } });
    assert(!view.getSnapshot().blocks.some((block) => block.toolCallId === 'call-0'));
  }
  assert.equal(source.reads(), reads, 'delayed callbacks do not scan arbitrary SDK history');
  const snapshot = view.getSnapshot();
  assert(snapshot.blocks.some((block) => block.toolCallId === 'call-139' && block.resultText === 'redacted-139'));
  assert.doesNotMatch(JSON.stringify(snapshot), /UNREDACTED/);
  assert.equal(snapshot.blocks.filter((block) => block.toolCallId === 'call-139').length, 1);
  release(); view.dispose(); service.shutdown();
});

test('observer read/subscribe faults and abort/close/shutdown never invoke runner mutations', async () => {
  const reference = ref(), source = fake(), service = createNativeTranscriptService({ getReferences: () => [reference] });
  const release = service.register(reference, { ...source.facade, getEntries() { throw Error('read'); } });
  const controller = new AbortController(); const view = await service.open(reference, { signal: controller.signal });
  assert.match(view.getSnapshot().diagnostic!, /read failed/);
  let notifications = 0; view.subscribe(() => notifications++); controller.abort();
  source.emit({ type: 'agent_settled' }); await tick(); assert.equal(notifications, 0); assert.equal(source.listeners.size, 1);
  service.shutdown(); release(); assert.equal(source.listeners.size, 0);
  const broken = createNativeTranscriptService({ getReferences: () => [reference] });
  assert.doesNotThrow(() => broken.register(reference, { ...source.facade, subscribe() { throw Error('subscribe'); } })); broken.shutdown();
});

test('oversized entries preserve default leaf stubs and bounded final/partial/tool projections', async () => {
  const reference = ref(), source = fake(), service = createNativeTranscriptService({ getReferences: () => [reference] });
  source.append(message('huge', null, 'assistant', Array.from({ length: 400 }, () => ({ type: 'text', text: 'x'.repeat(100000) }))));
  const release = service.register(reference, source.facade); const view = await service.open(reference);
  let snapshot = view.getSnapshot(); assert.equal(snapshot.inspectedLeafId, 'huge'); assert(snapshot.blocks.length > 0); assert(snapshot.truncated);
  assert(JSON.stringify(snapshot).length * 2 < 256 * 1024);
  source.emit({ type: 'message_start', message: { role: 'assistant', content: Array.from({ length: 80 }, (_, i) => ({ type: 'toolCall', id: `${i}`, name: 'tool', arguments: {} })) } });
  for (let i = 0; i < 80; i++) source.emit({ type: 'tool_execution_start', toolCallId: `${i}`, toolName: 'tool', args: { huge: 'x'.repeat(100000) } });
  source.emit({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1000000) }] } });
  snapshot = view.getSnapshot(); assert(snapshot.blocks.length <= 200); assert(JSON.stringify(snapshot).length * 2 < 256 * 1024); assert(snapshot.truncated);
  release(); view.dispose(); service.shutdown();
});

test('terminal controls, image/signature/unknown payloads are omitted without losing multiline indentation', async () => {
  assert.equal(sanitizeNativeTranscriptText('a\x1b]8;;https://evil\x07b\x1b]8;;\x07\x1b[31mc\x1b[0m\n  d\t中'), 'abc\n  d    中');
  const reference = ref(), source = fake(), service = createNativeTranscriptService({ getReferences: () => [reference] });
  source.append(message('safe', null, 'assistant', [{ type: 'image', data: 'BASE64_SECRET' }, { type: 'thinking', redacted: true, thinkingSignature: 'SIGNATURE' }, { type: 'text', text: '\n  code', textSignature: 'SIGNATURE' }]));
  source.append(message('custom', 'safe', 'arbitrary-role', [{ data: 'CUSTOM_SECRET' }]));
  const release = service.register(reference, source.facade), view = await service.open(reference), serialized = JSON.stringify(view.getSnapshot());
  assert.doesNotMatch(serialized, /BASE64_SECRET|SIGNATURE|CUSTOM_SECRET/); assert.match(serialized, /image omitted/); assert.match(serialized, /code/);
  release(); view.dispose(); service.shutdown();
});

async function savedFixture(fn: (context: { ref: ClankersNativeSessionReference; service: ReturnType<typeof createNativeTranscriptService>; rows: any[]; write(rows: any[]): Promise<void>; dir: string }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'clankers-transcript-unit-')), cwd = resolve(dir, 'workspace'), agentDir = join(dir, 'agent');
  const group = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`, folder = join(agentDir, 'sessions', group);
  await mkdir(folder, { recursive: true }); const reference = ref({ cwd, sessionFile: join(folder, 'native-id.jsonl'), attachment: 'disposed' });
  const { attachment: _attachment, ...identity } = reference;
  const rows: any[] = [{ type: 'session', version: 3, id: reference.piSessionId, cwd },
    { type: 'custom', id: 'marker', parentId: null, customType: 'pi-clankers/native-session/v1', data: identity },
    message('user', 'marker', 'user', 'original'), message('left', 'user', 'assistant', 'left branch'),
    message('root2', null, 'user', 'second root'), message('right', 'user', 'assistant', 'right branch'),
    { type: 'compaction', id: 'compact', parentId: 'right', summary: 'summary', firstKeptEntryId: 'right' },
    { type: 'context_edit', id: 'edit', parentId: 'compact', targetId: 'user', replacement: null }];
  const write = async (value: any[]) => writeFile(reference.sessionFile, value.map((row) => JSON.stringify(row)).join('\n') + '\n');
  await write(rows); const service = createNativeTranscriptService({ getReferences: () => [reference], agentDir });
  try { await fn({ ref: reference, service, rows, write, dir }); } finally { service.shutdown(); await rm(dir, { recursive: true, force: true }); }
}

test('saved raw branches/multiple roots/recorded tip, no context rewrite and byte-identical inspection', async () => savedFixture(async ({ ref, service }) => {
  const before = await readFile(ref.sessionFile); const view = await service.open(ref); const snapshot = view.getSnapshot();
  assert.equal(snapshot.source, 'saved'); assert.equal(snapshot.defaultLeafBasis, 'recorded-tip'); assert.equal(snapshot.inspectedLeafId, 'edit'); assert.equal(snapshot.liveLeafId, null);
  assert(snapshot.branches.some((branch) => branch.leafId === 'root2'));
  assert.match(JSON.stringify(snapshot.blocks), /original/); assert.match(JSON.stringify(snapshot.blocks), /not effective model context/);
  assert.match(JSON.stringify(view.getSnapshot({ leafId: 'left' }).blocks), /left branch/);
  assert.doesNotMatch(JSON.stringify(view.getSnapshot({ leafId: 'left' }).blocks), /right branch/);
  assert.equal(view.getSnapshot({ leafId: 'absent' }).blocks.length, 0); assert.equal(view.getSnapshot({ leafId: null }).blocks.length, 0);
  assert.deepEqual(await readFile(ref.sessionFile), before); view.dispose();
}));

test('saved attached or unavailable reference is history-only, not proven closed/connected', async () => savedFixture(async ({ ref, service }) => {
  ref.attachment = 'attached'; const view = await service.open(ref);
  assert.equal(view.getSnapshot().source, 'saved'); assert.equal(view.getSnapshot().status, 'unavailable'); assert.match(view.getSnapshot().diagnostic!, /no live observer connected/); view.dispose();
}));

test('saved reader denies header/provenance/duplicates/orphans/cycles/future versions/partial tail/line and byte overflow', async () => savedFixture(async ({ ref, service, rows, write }) => {
  const mutate = async (label: string, change: (copy: any[]) => void) => {
    const copy = structuredClone(rows); change(copy); await write(copy); const view = await service.open(ref);
    assert.equal(view.getSnapshot().source, 'unavailable', label); assert(view.getSnapshot().diagnostic, label); view.dispose();
  };
  await mutate('header', (copy) => copy[0].id = 'forged');
  await mutate('provenance', (copy) => copy[1].data.memberRunId = 'forged');
  await mutate('marker duplicate', (copy) => copy.push({ ...copy[1], id: 'another' }));
  await mutate('id duplicate', (copy) => copy.push(copy[2]));
  await mutate('orphan', (copy) => copy[2].parentId = 'unknown');
  await mutate('cycle', (copy) => copy[2].parentId = 'edit');
  await mutate('future', (copy) => copy[0].version = 4);
  await mutate('line', (copy) => copy[2].message.content = 'x'.repeat(256 * 1024));
  await write(rows); await writeFile(ref.sessionFile, '{partial', { flag: 'a' });
  let view = await service.open(ref); assert.match(view.getSnapshot().diagnostic!, /corrupt or partial/); view.dispose();
  await writeFile(ref.sessionFile, 'x'.repeat(8 * 1024 * 1024 + 1));
  view = await service.open(ref); assert.match(view.getSnapshot().diagnostic!, /byte limit/); view.dispose();
}));

test('saved reader rejects outside roots, symlink files/components, nonregular/missing locators and aborts', async () => savedFixture(async ({ ref, service, rows, write, dir }) => {
  const original = ref.sessionFile;
  ref.sessionFile = join(dir, 'outside.jsonl'); await write(rows); let view = await service.open(ref); assert.match(view.getSnapshot().diagnostic!, /locator denied/); view.dispose();
  ref.sessionFile = original; await rm(original); await symlink(join(dir, 'outside.jsonl'), original);
  view = await service.open(ref); assert.match(view.getSnapshot().diagnostic!, /symlink denied/); view.dispose();
  await rm(original); await mkdir(original); view = await service.open(ref); assert.match(view.getSnapshot().diagnostic!, /regular file/); view.dispose();
  await rm(original, { recursive: true }); view = await service.open(ref); assert.equal(view.getSnapshot().source, 'unavailable'); view.dispose();
  await write(rows); const controller = new AbortController(); const pending = service.open(ref, { signal: controller.signal }); controller.abort();
  view = await pending; assert.equal(view.getSnapshot().source, 'unavailable'); view.dispose();
}));

test('queued reconciliation survives message generation changes and metadata append preserves ongoing partial', async () => {
  const reference = ref(), source = fake(), service = createNativeTranscriptService({ getReferences: () => [reference] });
  const release = service.register(reference, source.facade), view = await service.open(reference);
  source.emit({ type: 'message_start', message: { role: 'user', content: 'task' } });
  source.emit({ type: 'message_end', message: { role: 'user', content: 'task' } });
  source.append(message('user', null, 'user', 'task'));
  source.emit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  source.emit({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'ongoing partial' }] } });
  const partialId = view.getSnapshot().blocks.find((block) => block.text === 'ongoing partial')!.id;
  await Promise.resolve();
  assert.match(JSON.stringify(view.getSnapshot().blocks), /task/); assert.match(JSON.stringify(view.getSnapshot().blocks), /ongoing partial/);
  source.append({ type: 'session_info', id: 'info', parentId: 'user', name: 'metadata while streaming' });
  source.emit({ type: 'entry_appended' }); await Promise.resolve();
  assert.equal(view.getSnapshot().blocks.find((block) => block.text === 'ongoing partial')!.id, partialId);
  release(); view.dispose(); service.shutdown();
});


test('already-aborted opens consume no viewer slots; closed services return inert views', async () => {
  const reference = ref(), source = fake(), service = createNativeTranscriptService({ getReferences: () => [reference] });
  service.register(reference, source.facade);
  for (let i = 0; i < 40; i++) {
    const controller = new AbortController(); controller.abort();
    const rejected = await service.open(reference, { signal: controller.signal });
    assert.equal(rejected.getSnapshot().source, 'unavailable');
  }
  const view = await service.open(reference);
  assert.equal(view.getSnapshot().source, 'live');
  view.dispose(); service.shutdown();
  for (let i = 0; i < 40; i++) {
    const closed = await service.open(reference);
    assert.equal(closed.getSnapshot().source, 'unavailable');
    assert.deepEqual(closed.getSnapshot().key, { parentRunId: reference.parentRunId, memberRunId: reference.memberRunId, piSessionId: reference.piSessionId });
    closed.subscribe(() => assert.fail('closed observer callback'))();
    closed.dispose(); closed.dispose();
  }
  assert.equal(source.listeners.size, 0);
});

test('transient tool clipping is explicit rather than silently displaying a complete result', async () => {
  const reference = ref(), source = fake(), service = createNativeTranscriptService({ getReferences: () => [reference] });
  source.append(message('long-call', null, 'assistant', [{ type: 'toolCall', id: 'long', name: 'read', arguments: { path: 'a'.repeat(500) } }]));
  const release = service.register(reference, source.facade), view = await service.open(reference);
  source.emit({ type: 'tool_execution_update', toolCallId: 'long', toolName: 'read', args: { path: 'a'.repeat(500) }, partialResult: { content: [{ type: 'text', text: 'x'.repeat(1024) }] } });
  const snapshot = view.getSnapshot();
  assert.equal(snapshot.truncated, true);
  assert.match(snapshot.blocks[0]!.argumentsText!, /\[truncated\]/);
  assert.match(snapshot.blocks[0]!.resultText!, /\[truncated\]/);
  source.append({ id: 'info', parentId: null, type: 'session_info', name: 'metadata' });
  source.emit({ type: 'entry_appended' }); await Promise.resolve();
  assert.equal(view.getSnapshot().truncated, true);
  release(); view.dispose(); service.shutdown();
});


test('saved opens reserve viewer capacity before await and disposal releases exactly one slot', async () => savedFixture(async ({ ref, service }) => {
  const held = [];
  for (let i = 0; i < 31; i++) held.push(await service.open({ ...ref, memberRunId: `missing-${i}` }));
  const first = service.open(ref), second = service.open(ref);
  const rejected = await second;
  assert.match(rejected.getSnapshot().diagnostic!, /handle limit/);
  const admitted = await first;
  assert.equal(admitted.getSnapshot().source, 'saved');
  rejected.dispose();
  const stillFull = await service.open(ref);
  assert.match(stillFull.getSnapshot().diagnostic!, /handle limit/, 'inert rejection did not free an admitted slot');
  admitted.dispose(); admitted.dispose();
  const replacement = await service.open(ref); assert.equal(replacement.getSnapshot().source, 'saved'); replacement.dispose();
  for (const view of held) view.dispose();
}));

test('pending saved reservation is cleaned on abort/shutdown and failed loads remain disposable', async () => savedFixture(async ({ ref, service }) => {
  const controller = new AbortController();
  const pending = service.open(ref, { signal: controller.signal }); controller.abort();
  const aborted = await pending; assert.equal(aborted.getSnapshot().source, 'unavailable');
  const held = [];
  for (let i = 0; i < 32; i++) held.push(await service.open({ ...ref, memberRunId: `missing-${i}` }));
  assert(held.every((view) => /Exact native/.test(view.getSnapshot().diagnostic!)), 'abort freed reserved slot');
  for (const view of held) view.dispose();
  await rm(ref.sessionFile);
  const failed = await service.open(ref); assert.equal(failed.getSnapshot().source, 'unavailable'); failed.dispose();
  const source = fake(); service.register(ref, source.facade);
  const live = await service.open(ref); assert.equal(live.getSnapshot().source, 'live'); live.dispose();
  service.shutdown(); assert.equal(source.listeners.size, 0);
}));

test('shutdown during saved load cannot attach a completed viewer', async () => savedFixture(async ({ ref, service }) => {
  const pending = service.open(ref); service.shutdown();
  const view = await pending; assert.equal(view.getSnapshot().source, 'unavailable');
  view.subscribe(() => assert.fail('shutdown callback'))(); view.dispose();
}));

test('current pending calls admit late-attach updates, live ends and nested starts without admitting unknown callbacks', async () => {
  const reference = ref(), source = fake();
  source.append(message('call', null, 'assistant', [{ type: 'toolCall', id: 'current', name: 'read', arguments: { path: '/fixture' } }]));
  const service = createNativeTranscriptService({ getReferences: () => [reference] });
  const release = service.register(reference, source.facade), view = await service.open(reference);
  source.emit({ type: 'tool_execution_update', toolCallId: 'unknown', partialResult: { content: 'UNKNOWN' } });
  source.emit({ type: 'tool_execution_update', toolCallId: 'current', toolName: 'read', partialResult: { content: 'GENUINE' } });
  assert.equal(view.getSnapshot().blocks.find((block) => block.toolCallId === 'current')?.resultText, 'GENUINE');
  source.emit({ type: 'tool_execution_start', toolCallId: 'child', parentToolCallId: 'current', toolName: 'nested' });
  source.emit({ type: 'tool_execution_update', toolCallId: 'child', partialResult: { content: 'CHILD' } });
  assert.equal(view.getSnapshot().blocks.find((block) => block.toolCallId === 'child')?.parentToolCallId, 'current');
  source.emit({ type: 'tool_execution_end', toolCallId: 'child', result: { content: 'CHILD_FINAL' } });
  source.emit({ type: 'tool_execution_end', toolCallId: 'current', result: { content: 'FINAL' } });
  source.emit({ type: 'tool_execution_update', toolCallId: 'current', partialResult: { content: 'STALE' } });
  assert.equal(view.getSnapshot().blocks.find((block) => block.toolCallId === 'current')?.resultText, 'FINAL');
  assert.doesNotMatch(JSON.stringify(view.getSnapshot()), /UNKNOWN|STALE/);
  source.append(message('result', 'call', 'toolResult', 'REDACTED', { toolCallId: 'current', toolName: 'read' }));
  source.emit({ type: 'entry_appended' }); await Promise.resolve();
  assert.equal(view.getSnapshot().blocks.find((block) => block.toolCallId === 'current')?.resultText, 'REDACTED');
  assert.equal(view.getSnapshot({ leafId: 'call' }).blocks.find((block) => block.toolCallId === 'current')?.status, 'pending');
  release(); view.dispose(); service.shutdown();
});


test('saved load reference drift releases its disposable reservation without exposing history', async () => savedFixture(async ({ ref, service }) => {
  const pending = service.open(ref); ref.sessionFile += '.changed';
  const view = await pending;
  assert.equal(view.getSnapshot().source, 'unavailable'); assert.match(view.getSnapshot().diagnostic!, /reference changed/);
  view.dispose(); view.dispose();
  const held = [];
  for (let i = 0; i < 32; i++) held.push(await service.open({ ...ref, memberRunId: `missing-${i}` }));
  assert(held.every((handle) => /Exact native/.test(handle.getSnapshot().diagnostic!)));
  for (const handle of held) handle.dispose();
}));
