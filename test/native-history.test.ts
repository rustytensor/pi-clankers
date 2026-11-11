import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, rename, stat } from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { SessionManager, type SessionEntry } from '@earendil-works/pi-coding-agent';
import { readNativeHistory, inheritNativeHistory, validateNativeHistorySelection, NATIVE_SESSION_MARKER, NATIVE_CONTINUATION_MARKER, NATIVE_ANCESTOR_SESSION_MARKER, NATIVE_ANCESTOR_CONTINUATION_MARKER, NATIVE_HISTORY_LIMITS, type NativeHistory, type NativeHistoryIdentity } from '../native-history.js';
import { createNativeTranscriptService } from '../native-transcript.js';
import type { ClankersNativeSessionReference } from '../types.js';

const timestamp = '2026-10-03T00:00:00.000Z';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const identity = (ref: ClankersNativeSessionReference): NativeHistoryIdentity => ({ schemaVersion: 1, parentRunId: ref.parentRunId, memberRunId: ref.memberRunId, agentDefinitionId: ref.agentDefinitionId, piSessionId: ref.piSessionId, sessionFile: ref.sessionFile, cwd: ref.cwd, createdAt: ref.createdAt });
const entry = (id: string, parentId: string | null, type: string, data: Record<string, unknown> = {}): SessionEntry => ({ id, parentId, type, timestamp, ...data } as SessionEntry);
const user = (id: string, parentId: string | null, content = 'literal task') => entry(id, parentId, 'message', { message: { role: 'user', content, timestamp: 1 } });
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const assistant = (id: string, parentId: string | null, content: unknown[] = [{ type: 'text', text: 'answer', textSignature: 'opaque signature' }], stopReason = 'stop') => entry(id, parentId, 'message', { message: { role: 'assistant', content, api: 'openai-completions', provider: 'local', model: 'fixture', usage, stopReason, timestamp: 2 } });
const result = (id: string, parentId: string | null, toolCallId = 'call1', toolName = 'read') => entry(id, parentId, 'message', { message: { role: 'toolResult', toolCallId, toolName, content: [{ type: 'text', text: 'result' }], isError: false, timestamp: 3 } });
const tool = { type: 'toolCall', id: 'call1', name: 'read', arguments: { path: 'a' }, thoughtSignature: 'opaque tool signature' };
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const agentDir = await mkdtemp(join(tmpdir(), 'clankers-native-history-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const cwd = resolve(agentDir, 'workspace'), group = `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  const directory = join(agentDir, 'sessions', group); await mkdir(directory, { recursive: true });
  const ref: ClankersNativeSessionReference = { schemaVersion: 1, parentRunId: 'parent', memberRunId: 'member', agentDefinitionId: 'worker', piSessionId: 'session1', sessionFile: join(directory, 'original.jsonl'), cwd, createdAt: timestamp, attachment: 'disposed' };
  const header = { type: 'session' as const, version: 3, id: ref.piSessionId, cwd, timestamp };
  const marker = entry('marker', null, 'custom', { customType: NATIVE_SESSION_MARKER, data: identity(ref) });
  const entries = [marker, user('user', 'marker'), assistant('assistant', 'user')];
  const save = async (rows: unknown[] = [header, ...entries], newline = true) => {
    const bytes = rows.map((row) => JSON.stringify(row)).join('\n') + (newline ? '\n' : ''); await writeFile(ref.sessionFile, bytes); return bytes;
  };
  await save();
  return { agentDir, ref, header, marker, entries, save, directory };
}

test('strict raw read fingerprints exact bytes; native selection has exact position and leaves source unchanged', async (t) => {
  const f = await fixture(t), before = await readFile(f.ref.sessionFile), beforeStat = await stat(f.ref.sessionFile);
  const history = await readNativeHistory(f.ref, { agentDir: f.agentDir, requireFinalNewline: true });
  assert.equal(history.fingerprint.sha256, hash(before.toString()));
  assert.equal(history.fingerprint.ino, beforeStat.ino); assert.equal(history.fingerprint.size, before.length);
  assert.deepEqual(history.entries, f.entries);
  const selected = validateNativeHistorySelection(history, 'user');
  assert.deepEqual(selected.context.messages.map((message) => message.role), ['user']);
  assert.equal(selected.entryDigest, hash(JSON.stringify(f.entries[1])));
  assert.throws(() => validateNativeHistorySelection(history, 'missing'), /missing/);
  assert.throws(() => validateNativeHistorySelection(history, ''), /exact entry/);
  assert.deepEqual(await readFile(f.ref.sessionFile), before);
  assert.equal((await stat(f.ref.sessionFile)).mtimeMs, beforeStat.mtimeMs);
});

test('viewer still tolerates complete no-final-newline and generic metadata; execution does not repair or flatten it', async (t) => {
  const f = await fixture(t); await f.save([f.header, ...f.entries, entry('future', 'assistant', 'future_opaque', { payload: { signature: 'keep me' } })], false);
  const bytes = await readFile(f.ref.sessionFile);
  const history = await readNativeHistory(f.ref, { agentDir: f.agentDir });
  assert.throws(() => validateNativeHistorySelection(history, 'future'), /unsupported execution entry/);
  await assert.rejects(readNativeHistory(f.ref, { agentDir: f.agentDir, requireFinalNewline: true }), /final newline/);
  const service = createNativeTranscriptService({ getReferences: () => [f.ref], agentDir: f.agentDir }); t.after(async () => service.shutdown());
  const handle = await service.open(f.ref); assert.equal(handle.getSnapshot().source, 'saved'); handle.dispose();
  assert.deepEqual(await readFile(f.ref.sessionFile), bytes);
});

test('path boundaries reject outside/nested/noncanonical locators, symlink files/directories, and nonregular files', async (t) => {
  const f = await fixture(t);
  for (const sessionFile of [join(f.agentDir, 'outside.jsonl'), join(f.directory, 'nested', 'file.jsonl'), `${f.directory}/../${f.directory.split('/').at(-1)}/original.jsonl`, 'relative.jsonl']) {
    await assert.rejects(readNativeHistory({ ...f.ref, sessionFile }, { agentDir: f.agentDir }), /locator denied/);
  }
  const link = join(f.directory, 'link.jsonl'); await symlink(f.ref.sessionFile, link);
  await assert.rejects(readNativeHistory({ ...f.ref, sessionFile: link }, { agentDir: f.agentDir }), /symlink denied/);
  await rename(f.directory, `${f.directory}-real`); await symlink(`${f.directory}-real`, f.directory);
  await assert.rejects(readNativeHistory(f.ref, { agentDir: f.agentDir }), /symlink denied/);
  await rm(f.directory); await rename(`${f.directory}-real`, f.directory);
  await rm(f.ref.sessionFile); await mkdir(f.ref.sessionFile);
  await assert.rejects(readNativeHistory(f.ref, { agentDir: f.agentDir }), /regular file/);
});

test('strict bytes reject corrupt/partial JSONL, UTF8, versions, missing/duplicate/extended provenance and graph faults', async (t) => {
  const f = await fixture(t);
  const cases: Array<[unknown[], RegExp]> = [
    [[{ ...f.header, version: 2 }, ...f.entries], /requires v3/],
    [[{ ...f.header, id: 'other' }, ...f.entries], /header identity/],
    [[f.header, ...f.entries, f.header], /header identity/],
    [[f.header, ...f.entries.slice(1)], /orphan|provenance/],
    [[f.header, ...f.entries, { ...f.marker, id: 'other-marker' }], /provenance/],
    [[f.header, { ...f.marker, data: { ...identity(f.ref), extra: true } }, ...f.entries.slice(1)], /provenance/],
    [[f.header, ...f.entries, f.entries[1]], /duplicate/],
    [[f.header, f.marker, user('orphan', 'absent')], /orphan/],
    [[f.header, f.marker, user('a', 'b'), user('b', 'a')], /cyclic/],
    [[f.header, ...f.entries, null], /corrupt/],
  ];
  for (const [rows, error] of cases) { await f.save(rows); await assert.rejects(readNativeHistory(f.ref, { agentDir: f.agentDir }), error); }
  await writeFile(f.ref.sessionFile, '{"type":"session"}\n{"type":'); await assert.rejects(readNativeHistory(f.ref, { agentDir: f.agentDir }), /corrupt/);
  await writeFile(f.ref.sessionFile, Buffer.from([0xc3, 0x28])); await assert.rejects(readNativeHistory(f.ref, { agentDir: f.agentDir }), /UTF-8/);
  await writeFile(f.ref.sessionFile, Buffer.alloc(NATIVE_HISTORY_LIMITS.bytes + 1)); await assert.rejects(readNativeHistory(f.ref, { agentDir: f.agentDir }), /byte limit/);
  await f.save([f.header, ...f.entries, entry('large', 'assistant', 'custom', { customType: 'other', data: 'x'.repeat(NATIVE_HISTORY_LIMITS.line) })]);
  await assert.rejects(readNativeHistory(f.ref, { agentDir: f.agentDir }), /line limit/);
  await f.save([f.header, f.marker, ...Array.from({ length: NATIVE_HISTORY_LIMITS.entries }, (_, i) => entry(`e${i}`, null, 'custom', { customType: 'other' }))]);
  await assert.rejects(readNativeHistory(f.ref, { agentDir: f.agentDir }), /entry limit/);
});

test('fd fencing rejects a changed stat and closes the fd; abort also leaves bytes unchanged', async (t) => {
  const f = await fixture(t), bytes = await readFile(f.ref.sessionFile);
  const originalOpen = fsPromises.open; let closed = false;
  const mock = t.mock.method(fsPromises, 'open', async (...args: Parameters<typeof originalOpen>) => {
    const file = await originalOpen(...args); let reads = 0;
    return { read: file.read.bind(file), stat: async () => { const value = await file.stat(); if (++reads === 2) value.mtimeMs += 1; return value; }, close: async () => { closed = true; await file.close(); } };
  });
  syncBuiltinESMExports();
  try { await assert.rejects(readNativeHistory(f.ref, { agentDir: f.agentDir }), /changed during read/); assert.equal(closed, true); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readNativeHistory(f.ref, { agentDir: f.agentDir, signal: controller.signal }), /aborted/);
  assert.deepEqual(await readFile(f.ref.sessionFile), bytes);
});

test('copy preserves full sibling tree and opaque payloads; every recognized inherited metadata entry is accounted across generations', async (t) => {
  const f = await fixture(t); f.entries.push(user('sibling', 'marker', 'other branch'), entry('opaque', 'sibling', 'custom', { customType: 'other.extension', data: { nested: [1, { data: 'opaque', signature: 'preserve' }] } })); await f.save();
  const original = await readNativeHistory(f.ref, { agentDir: f.agentDir }), raw = JSON.stringify(original.entries);
  async function next(source: NativeHistory, sourceRef: ClankersNativeSessionReference, n: number) {
    const inherited = inheritNativeHistory(source);
    const ref = { ...f.ref, piSessionId: `session${n}`, sessionFile: join(f.directory, `next${n}.jsonl`) };
    const marker = entry(`marker${n}`, 'user', 'custom', { customType: NATIVE_SESSION_MARKER, data: identity(ref) });
    const continuation = entry(`continuation${n}`, marker.id, 'custom', { customType: NATIVE_CONTINUATION_MARKER, data: { schemaVersion: 1, source: identity(sourceRef), sourceFingerprint: source.fingerprint.sha256, entryId: 'user', policyDigest: hash('current policy'), ancestors: inherited.ancestors } });
    const header = { ...f.header, id: ref.piSessionId, parentSession: sourceRef.sessionFile };
    const rows = [header, ...inherited.entries, marker, continuation]; await writeFile(ref.sessionFile, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    return { ref, rows, continuation, history: await readNativeHistory(ref, { agentDir: f.agentDir, requireFinalNewline: true }) };
  }
  const second = await next(original, f.ref, 2), third = await next(second.history, second.ref, 3);
  assert.equal(third.history.entries.filter((e: any) => e.customType === NATIVE_SESSION_MARKER).length, 1);
  assert.equal(third.history.entries.filter((e: any) => e.customType === NATIVE_ANCESTOR_SESSION_MARKER).length, 2);
  assert.equal(third.history.entries.filter((e: any) => e.customType === NATIVE_ANCESTOR_CONTINUATION_MARKER).length, 1);
  assert.deepEqual(third.history.entries.find((e) => e.id === 'opaque'), original.entries.find((e) => e.id === 'opaque'));
  assert.equal(JSON.stringify(original.entries), raw);
  assert.deepEqual(validateNativeHistorySelection(third.history, 'assistant').context, validateNativeHistorySelection(original, 'assistant').context);
  for (const corrupt of [
    { ...third.continuation, data: { ...(third.continuation as any).data, ancestors: [] } },
    { ...third.continuation, data: { ...(third.continuation as any).data, ancestors: (third.continuation as any).data.ancestors.map((item: any, i: number) => i ? item : { ...item, dataDigest: hash('wrong') }) } },
    { ...third.continuation, data: { ...(third.continuation as any).data, source: { ...identity(second.ref), piSessionId: 'missing' } } },
  ]) {
    await writeFile(third.ref.sessionFile, [...third.rows.slice(0, -1), corrupt].map((row) => JSON.stringify(row)).join('\n') + '\n');
    await assert.rejects(readNativeHistory(third.ref, { agentDir: f.agentDir }), /ancestor|source/);
  }
  await writeFile(third.ref.sessionFile, third.rows.slice(0, -1).map((row) => JSON.stringify(row)).join('\n') + '\n');
  await assert.rejects(readNativeHistory(third.ref, { agentDir: f.agentDir }), /lineage count/);
});

test('public native compaction and context edit projection is authoritative and branch-relative', async (t) => {
  const f = await fixture(t);
  const older = user('old', 'marker', 'summarized-away'); const kept = user('kept', 'old', 'original');
  const compaction = entry('compact', 'kept', 'compaction', { summary: 'authoritative summary', firstKeptEntryId: 'kept', tokensBefore: 100 });
  const edit = entry('edit', 'compact', 'context_edit', { targetId: 'kept', replacement: { content: 'replacement' } });
  const omit = entry('omit', 'edit', 'context_edit', { targetId: 'kept', replacement: null });
  await f.save([f.header, f.marker, older, kept, compaction, edit, omit]);
  const history = await readNativeHistory(f.ref, { agentDir: f.agentDir });
  const native = SessionManager.inMemory(f.ref.cwd, undefined, [history.header, ...history.entries]); native.branch('edit');
  assert.deepEqual(validateNativeHistorySelection(history, 'edit').context, native.buildSessionContext());
  assert.deepEqual(validateNativeHistorySelection(history, 'edit').context.messages.map((m: any) => m.content ?? m.summary), ['authoritative summary', 'replacement']);
  assert.deepEqual(validateNativeHistorySelection(history, 'kept').context.messages.map((m: any) => m.content), ['summarized-away', 'original']);
  assert.deepEqual(validateNativeHistorySelection(history, 'omit').context.messages.map((m: any) => m.summary), ['authoritative summary']);
  await f.save([f.header, f.marker, older, kept, { ...compaction, firstKeptEntryId: 'compact' }]);
  assert.equal(validateNativeHistorySelection(await readNativeHistory(f.ref, { agentDir: f.agentDir }), 'compact').context.messages.length, 1);
  for (const bad of [
    { ...compaction, firstKeptEntryId: 'missing' },
    { ...edit, targetId: 'missing' },
    { ...edit, targetId: 'marker' },
    { ...edit, replacement: 'bare invalid replacement' },
  ]) {
    const invalid = { ...bad, parentId: 'kept' } as SessionEntry;
    await f.save([f.header, f.marker, older, kept, invalid]);
    assert.throws(() => validateNativeHistorySelection({ ...history, entries: [f.marker, older, kept, invalid] }, invalid.id), /compaction|context edit/);
  }
});

test('exact projected selection rejects partial, unmatched, duplicate and edited-away tool pairs; closed batches preserve signatures', async (t) => {
  const f = await fixture(t), call = assistant('call', 'user', [tool], 'toolUse'), done = result('done', 'call');
  await f.save([f.header, f.marker, f.entries[1], call, done]);
  const history = await readNativeHistory(f.ref, { agentDir: f.agentDir });
  assert.throws(() => validateNativeHistorySelection(history, 'call'), /incomplete tool boundary/);
  assert.equal((validateNativeHistorySelection(history, 'done').context.messages[1] as any).content[0].thoughtSignature, 'opaque tool signature');
  const scenarios: SessionEntry[][] = [
    [assistant('bad', 'user', [], 'pending')],
    [assistant('bad', 'user', [], 'deferred')],
    [result('bad', 'user')],
    [call, result('bad', 'call', 'call1', 'wrong')],
    [call, user('bad', 'call')],
    [call, done, result('bad', 'done')],
    [call, done, assistant('bad', 'done', [tool], 'toolUse')],
    [call, done, entry('bad', 'done', 'context_edit', { targetId: 'done', replacement: null })],
    [call, done, entry('bad', 'done', 'context_edit', { targetId: 'call', replacement: null })],
    [entry('bad', 'user', 'message', { message: { role: 'unknown_extension_role', content: 'opaque', timestamp: 1 } })],
  ];
  for (const suffix of scenarios) assert.throws(() => validateNativeHistorySelection({ ...history, entries: [f.marker, f.entries[1], ...suffix] }, 'bad'), /incomplete|unsafe|orphan|mismatched|interrupted|duplicate|unsupported/);
});


test('execution validates required system tool declaration/removal fields while preserving valid opaque extras', async (t) => {
  const f = await fixture(t), history = await readNativeHistory(f.ref, { agentDir: f.agentDir });
  const system = (data: Record<string, unknown>) => entry('system', 'marker', 'message', { message: { role: 'system', content: '', timestamp: 1, ...data } });
  const valid = system({ sections: { policy: 'old declared instructions', removed: null }, toolsAdded: [{ name: 'read', description: 'Read file', parameters: { type: 'object', properties: {} }, namespace: 'valid.optional', opaque: { preserve: true } }], toolsRemoved: [{ name: 'write', namespace: 'valid.optional' }] });
  const selected = validateNativeHistorySelection({ ...history, entries: [f.marker, valid] }, 'system');
  assert.deepEqual(selected.context.messages[0], (valid as any).message);
  for (const data of [
    { toolsAdded: [null] }, { toolsAdded: [{}] }, { toolsAdded: [{ name: 'read' }] },
    { toolsAdded: [{ name: 'read', description: 'read', parameters: null }] },
    { toolsRemoved: [null] }, { toolsRemoved: [{}] }, { toolsRemoved: [{ name: '' }] },
    { toolsRemoved: ['write'] }, { sections: { bad: 1 } }, { replace: 'yes' },
  ]) assert.throws(() => validateNativeHistorySelection({ ...history, entries: [f.marker, system(data)] }, 'system'), /invalid system/);
  const compact = entry('compact', 'user', 'compaction', { summary: 'summary', tokensBefore: 1, firstKeptEntryId: 'compact', systemMessage: { role: 'system', content: '', toolsAdded: [null], timestamp: 1 } });
  assert.throws(() => validateNativeHistorySelection({ ...history, entries: [f.marker, f.entries[1], compact] }, 'compact'), /invalid system/);
});

test('continuation provenance rejects identity reuse, false parentSession, unaccounted metadata and wrong reserved entry type', async (t) => {
  const f = await fixture(t), source = await readNativeHistory(f.ref, { agentDir: f.agentDir });
  const inherited = inheritNativeHistory(source);
  const ref = { ...f.ref, piSessionId: 'fresh', sessionFile: join(f.directory, 'fresh.jsonl') };
  const header = { ...f.header, id: ref.piSessionId, parentSession: f.ref.sessionFile };
  const own = entry('fresh-marker', 'user', 'custom', { customType: NATIVE_SESSION_MARKER, data: identity(ref) });
  const data = { schemaVersion: 1, source: identity(f.ref), sourceFingerprint: source.fingerprint.sha256, entryId: 'user', policyDigest: hash('policy'), ancestors: inherited.ancestors };
  const continuation = entry('continuation', own.id, 'custom', { customType: NATIVE_CONTINUATION_MARKER, data });
  const rows = [header, ...inherited.entries, own, continuation];
  const save = async (entries: unknown[]) => writeFile(ref.sessionFile, entries.map((row) => JSON.stringify(row)).join('\n') + '\n');
  await save(rows); await readNativeHistory(ref, { agentDir: f.agentDir });
  await save([{ ...header, parentSession: '/wrong/source.jsonl' }, ...rows.slice(1)]);
  await assert.rejects(readNativeHistory(ref, { agentDir: f.agentDir }), /parentSession/);
  for (const field of ['piSessionId', 'sessionFile'] as const) {
    const bad = { ...data, source: { ...data.source, [field]: ref[field] } };
    await save([...rows.slice(0, -1), { ...continuation, data: bad }]);
    await assert.rejects(readNativeHistory(ref, { agentDir: f.agentDir }), /source|fresh/);
  }
  await save([header, { ...inherited.entries[0], data: identity(ref) }, ...inherited.entries.slice(1), own, continuation]);
  await assert.rejects(readNativeHistory(ref, { agentDir: f.agentDir }), /not fresh/);
  const extra = entry('unaccounted', null, 'custom', { customType: NATIVE_ANCESTOR_SESSION_MARKER, data: { ...identity(f.ref), piSessionId: 'older', sessionFile: '/older/file.jsonl' } });
  await save([...rows.slice(0, -1), extra, continuation]);
  await assert.rejects(readNativeHistory(ref, { agentDir: f.agentDir }), /unaccounted/);
  await save([...rows, entry('wrong-type', null, 'custom_message', { customType: NATIVE_ANCESTOR_SESSION_MARKER, content: 'payload', display: false })]);
  await assert.rejects(readNativeHistory(ref, { agentDir: f.agentDir }), /reserved metadata/);
});
