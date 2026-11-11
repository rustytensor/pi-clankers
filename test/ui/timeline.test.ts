import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { renderClankersTimeline } from '../../render.js';
import { getClankersTimeline } from '../../timeline.js';
import { createClankersState } from '../../state.js';
import { recoverClankersStateAfterRestart } from '../../persistence.js';
import type { ClankersState, ClankersNativeSessionReference, ClankersSessionMessageReceipt, ClankersTimelineEntry } from '../../types.js';

const date = '2026-10-03T00:00:00.000Z';
function fixture() {
  const state = createClankersState();
  const ref: ClankersNativeSessionReference = { schemaVersion: 1, parentRunId: 'clankers-a', memberRunId: 'clankers-a-worker', piSessionId: 'pi-a', agentDefinitionId: 'same-worker', sessionFile: '/never-open', cwd: '/never-scan', createdAt: date, attachment: 'attached' };
  state.agents['clankers-a'] = { id: 'clankers-a', label: 'parent', kind: 'subagent', status: 'running', metadata: { runId: 'clankers-a', agentDefinitionId: 'leader', teamId: 'original-team', nativeSessions: [ref], memberProgress: [{ agentId: 'same-worker', runId: ref.memberRunId, status: 'running', startedAt: date }] } };
  const receipt: ClankersSessionMessageReceipt = { schemaVersion: 1, messageId: 'message-a', key: { parentRunId: ref.parentRunId, memberRunId: ref.memberRunId, piSessionId: ref.piSessionId }, body: 'literal operator input', mode: 'followUp', status: 'queued', detail: 'queued is not consumed', createdAt: date, updatedAt: date, persistence: 'memory' };
  state.extensions.clankersSessionMessages = { schemaVersion: 1, receipts: [receipt] };
  const log = { id: 'native-output', source: 'adapter', kind: 'result', level: 'info', runId: ref.parentRunId, agentId: ref.agentDefinitionId, createdAt: date, message: 'native complete', data: { handoff: 'worker output, not an addressed reply', nativeTimeline: { schemaVersion: 1, kind: 'native-output', parentRunId: ref.parentRunId, memberRunId: ref.memberRunId, piSessionId: ref.piSessionId, agentDefinitionId: ref.agentDefinitionId } } };
  state.extensions.clankersLogs = { records: [log], maxRecords: 500 };
  return { state, ref, receipt, log };
}
function entries(state: ClankersState) { return getClankersTimeline(state, { limit: 256 }).entries; }
function exact(entry: ClankersTimelineEntry) { return entry.exactKey; }

test('timeline is pure, isolated, typed and not a delivery/reply/transcript history', () => {
  const f = fixture(), before = JSON.stringify(f.state);
  const result = getClankersTimeline(f.state);
  assert.deepEqual(result.entries.map((entry) => entry.kind).sort(), ['member-snapshot', 'native-output', 'operator-receipt', 'run-snapshot'].sort());
  assert.equal(result.entries.filter((entry) => entry.kind === 'operator-receipt').length, 1);
  assert.equal(result.entries.find((entry) => entry.kind === 'native-output')?.bodyPreview, f.log.data.handoff);
  assert(result.limitations.some((text) => /NOT an addressed reply/.test(text)));
  assert(!JSON.stringify(result).includes('/never-open')); assert(!JSON.stringify(result).includes('/never-scan'));
  assert(!JSON.stringify(result).includes('replyTo'));
  result.entries[0]!.summary = 'mutated projection';
  for (const entry of result.entries) if (entry.exactKey) entry.exactKey.piSessionId = 'changed';
  assert.equal(JSON.stringify(f.state), before);
  assert.deepEqual(getClankersTimeline(f.state), getClankersTimeline(f.state));
});

test('exact AND filters do not infer historical team membership or broaden unknown scope', () => {
  const f = fixture();
  f.state.teams['new-team'] = { id: 'new-team', label: 'new team', kind: 'team', status: 'running', leaderAgentId: 'leader', memberAgentIds: ['same-worker'] };
  assert.equal(getClankersTimeline(f.state, { teamId: 'new-team' }).entries.length, 0);
  for (const filter of [{ parentRunId: 'missing' }, { memberRunId: 'missing' }, { piSessionId: 'missing' }, { parentRunId: 'clankers-b', piSessionId: 'pi-a' }]) assert.equal(getClankersTimeline(f.state, filter).entries.length, 0);
  const result = getClankersTimeline(f.state, { teamId: 'original-team', parentRunId: 'clankers-a', memberRunId: 'clankers-a-worker', piSessionId: 'pi-a' });
  assert.equal(result.entries.length, 3); assert(result.entries.every(exact));
  assert.equal(getClankersTimeline(f.state, { parentRunId: 'clankers-a', memberRunId: 'same-worker' }).entries.length, 0, 'member is recorded run ID, not definition');
});

test('legacy logs never guess exact sessions from matching run and definition', () => {
  const f = fixture(); delete (f.log.data as Partial<typeof f.log.data>).nativeTimeline;
  const output = entries(f.state).find((entry) => entry.kind === 'recorded-event' && entry.source === 'log');
  assert(output); assert.equal(output.exactKey, undefined); assert.equal(output.memberRunId, undefined); assert.equal(output.piSessionId, undefined);
  assert(!getClankersTimeline(f.state, { piSessionId: f.ref.piSessionId }).entries.some((entry) => entry.kind === 'native-output'));
});

test('forged mismatched marker/source/definition and owner references fail closed', () => {
  for (const fault of ['pi', 'parent', 'definition', 'source', 'schema'] as const) {
    const f = fixture();
    if (fault === 'pi') f.log.data.nativeTimeline.piSessionId = 'wrong';
    if (fault === 'parent') f.log.data.nativeTimeline.parentRunId = 'clankers-other';
    if (fault === 'definition') f.log.data.nativeTimeline.agentDefinitionId = 'wrong';
    if (fault === 'source') f.log.source = 'command';
    if (fault === 'schema') f.log.data.nativeTimeline.schemaVersion = 2;
    assert(!entries(f.state).find((entry) => 'sourceId' in entry && entry.sourceId === 'native-output')?.exactKey, fault);
  }
  const owner = fixture(), stranger = createClankersState();
  stranger.extensions = owner.state.extensions;
  assert(getClankersTimeline(stranger, { piSessionId: owner.ref.piSessionId }).entries.every((entry) => entry.kind === 'operator-receipt' && !entry.exactKey), 'recorded orphan key is historical fact, not drilldown authority');
  assert(entries(stranger).every((entry) => !entry.exactKey));
  const conflicted = fixture(); conflicted.state.agents['clankers-a']!.metadata!.runId = 'clankers-wrong';
  assert(entries(conflicted.state).every((entry) => !entry.exactKey));
});

test('same-definition concurrent runs retain exact owner/run/session isolation', () => {
  const f = fixture();
  const other = { ...f.ref, parentRunId: 'clankers-b', memberRunId: 'clankers-b-worker', piSessionId: 'pi-b' };
  f.state.agents['clankers-b'] = { ...f.state.agents['clankers-a']!, id: 'clankers-b', metadata: { runId: 'clankers-b', agentDefinitionId: 'leader', teamId: 'original-team', nativeSessions: [other], memberProgress: [{ agentId: 'same-worker', runId: other.memberRunId, status: 'running' }] } };
  const results = getClankersTimeline(f.state, { parentRunId: 'clankers-b', piSessionId: 'pi-b' }).entries;
  assert.equal(results.length, 1); assert.equal(results[0]?.kind, 'member-snapshot');
  assert.equal(getClankersTimeline(f.state, { parentRunId: 'clankers-b', piSessionId: 'pi-a' }).entries.length, 0);
});

test('duplicate identities omit ambiguous rows and canonical reference conflicts unlink', () => {
  const f = fixture();
  (f.state.extensions.clankersLogs as { records: unknown[] }).records.push({ ...f.log, data: { ...f.log.data, handoff: 'other' } });
  assert(!entries(f.state).some((entry) => entry.kind === 'native-output'));
  (f.state.extensions.clankersSessionMessages as { receipts: unknown[] }).receipts.push({ ...f.receipt, key: { ...f.receipt.key, piSessionId: 'retarget' } });
  assert(!entries(f.state).some((entry) => entry.kind === 'operator-receipt'));
  (f.state.agents['clankers-a']!.metadata!.nativeSessions as unknown[]).push({ ...f.ref, piSessionId: 'pi-second' });
  assert(entries(f.state).every((entry) => entry.exactKey?.piSessionId !== 'pi-a'));
  assert.equal(getClankersTimeline(f.state, { piSessionId: 'pi-a' }).entries.length, 0);
  assert.equal(getClankersTimeline(f.state, { piSessionId: 'pi-second' }).entries.length, 1, 'canonical LAST valid member reference only');
});

test('receipt status changes keep immutable row order/ID; snapshots are not events', () => {
  const f = fixture(), original = entries(f.state).find((entry) => entry.kind === 'operator-receipt')!;
  f.receipt.status = 'delivered'; f.receipt.updatedAt = '2026-10-03T03:00:00Z';
  const current = entries(f.state).find((entry) => entry.kind === 'operator-receipt')!;
  assert.equal(current.id, original.id); assert.equal(current.timestamp, original.timestamp);
  assert.equal(current.timestampMeaning, 'created');
  assert(entries(f.state).filter((entry) => entry.kind.endsWith('snapshot')).every((entry) => entry.timestampMeaning === 'current-update'));
  f.log.createdAt = 'unknown';
  const output = entries(f.state).find((entry) => entry.kind === 'native-output')!;
  assert.equal(output.timestamp, undefined); assert.deepEqual(entries(f.state), entries(f.state));
});

test('bounded scan, text, rows and omissions are honest before sanitization', () => {
  const f = fixture();
  const logs = Array.from({ length: 3000 }, (_, index) => ({ ...f.log, id: `log-${index}`, createdAt: new Date(Date.parse(date) + index * 1000).toISOString(), message: `wide${'x'.repeat(10000)}`, data: { ...f.log.data, handoff: '\x1b]0;bad\x07safe ' + '界'.repeat(20000) } }));
  f.state.extensions.clankersLogs = { records: logs, maxRecords: 4000 };
  const result = getClankersTimeline(f.state, { limit: 256 });
  assert(result.entries.length <= 256 && result.entries.length > 0); assert(result.omittedEntries > 0);
  assert(result.limitations.some((text) => /outside the window are unknown/.test(text)));
  assert(result.entries.every((entry) => entry.bodyPreview.length <= 1024 && entry.summary.length <= 256));
  assert(result.entries.reduce((sum, entry) => sum + entry.summary.length + entry.bodyPreview.length, 0) <= 65536);
  assert(result.clippedEntries > 0); assert(!JSON.stringify(result.entries).includes('bad'));
  assert(!JSON.stringify(result.entries).includes('\\u001b'));
  assert.equal(getClankersTimeline(f.state, { limit: 1 }).entries.length, 1);
});

test('malformed filter identities/limits reject without normalizing into a target', () => {
  const f = fixture();
  for (const filter of [{ limit: 0 }, { limit: 257 }, { limit: NaN }, { limit: 1.2 }, { limit: '3' }, { piSessionId: ' pi-a' }, { memberRunId: '' }, { teamId: '\x1bteam' }, { parentRunId: 'x'.repeat(257) }]) assert.throws(() => getClankersTimeline(f.state, filter as never));
});

test('restart projection uses quarantined receipts and detached refs without replay or path access', () => {
  const f = fixture();
  const recovered = recoverClankersStateAfterRestart(f.state, { now: () => new Date('2026-10-03T01:00:00Z') }).state;
  const before = JSON.stringify(recovered);
  const result = getClankersTimeline(recovered);
  const receipt = result.entries.find((entry) => entry.kind === 'operator-receipt');
  assert(receipt && receipt.kind === 'operator-receipt'); assert.equal(receipt.status, 'needs-attention');
  assert(result.entries.every((entry) => entry.kind !== 'member-snapshot' || entry.attachment !== 'attached'));
  assert.equal(JSON.stringify(recovered), before); assert.deepEqual(getClankersTimeline(recovered), result);
});


test('queued recorded members filter without inventing a Pi session, canonical invalid refs cannot revive', () => {
  const f = fixture();
  f.state.agents['clankers-a']!.metadata!.nativeSessions = [];
  const result = getClankersTimeline(f.state, { memberRunId: f.ref.memberRunId });
  assert.equal(result.entries.filter((entry) => entry.kind === 'member-snapshot').length, 1); assert.equal(result.entries.length, 2, 'receipt keeps its recorded key');
  assert.equal(result.entries[0]?.exactKey, undefined);
  assert.equal(getClankersTimeline(f.state, { piSessionId: f.ref.piSessionId }).entries.length, 1, 'orphan receipt remains filterable without drilldown');
  for (const patch of [{ sessionFile: '' }, { cwd: '' }, { attachment: 'invalid' }, { disposedAt: 'invalid' }, { recoveredAt: 'invalid' }, { createdAt: 'invalid' }]) {
    f.state.agents['clankers-a']!.metadata!.nativeSessions = [{ ...f.ref, ...patch }];
    assert(entries(f.state).every((entry) => !entry.exactKey));
  }
});

test('source scan caps label unknown omissions and do not clone unrelated metadata', () => {
  const f = fixture();
  f.state.agents['clankers-a']!.metadata!.nativeSessions = Array.from({ length: 65 }, (_, i) => ({ ...f.ref, memberRunId: `member-${i}` }));
  assert(getClankersTimeline(f.state).limitations.some((text) => /Reference scan capped/.test(text)));
  assert(entries(f.state).every((entry) => !entry.exactKey));
  const other = fixture();
  for (let i = 0; i < 600; i++) other.state.agents[`clankers-${i}`] = { ...other.state.agents['clankers-a']!, id: `clankers-${i}`, metadata: { runId: `clankers-${i}` } };
  const result = getClankersTimeline(other.state, { limit: 256 });
  assert.equal(result.entries.length, 256); assert(result.limitations.some((text) => /512 agent records/.test(text)));
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  other.state.agents['clankers-a']!.metadata!.unrelated = cyclic;
  assert.doesNotThrow(() => getClankersTimeline(other.state));
});


test('timeline text fallback fits narrow Unicode columns and never emits untrusted controls', () => {
  const f = fixture(); f.log.message = '\x1b]0;untrusted-title\x07' + '界🙂'.repeat(1000);
  const snapshot = getClankersTimeline(f.state);
  for (const width of [1, 2, 12, 45, 88]) {
    const text = renderClankersTimeline(snapshot, { width });
    assert(text.split('\n').every((line) => visibleWidth(line) <= width));
    assert(!text.includes('untrusted-title')); assert(!text.includes('\x1b]'));
  }
});


test('orphan receipts keep the full recorded key for scope, never an actionable drilldown', () => {
  const f = fixture(); delete f.state.agents['clankers-a'];
  const result = getClankersTimeline(f.state, { parentRunId: f.ref.parentRunId, memberRunId: f.ref.memberRunId, piSessionId: f.ref.piSessionId });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0]?.kind, 'operator-receipt');
  assert.equal(result.entries[0]?.memberRunId, f.ref.memberRunId); assert.equal(result.entries[0]?.piSessionId, f.ref.piSessionId);
  assert.equal(result.entries[0]?.exactKey, undefined);
});

test('newest communication survives aggregate budgeting, older omissions are explicit', () => {
  const f = fixture();
  const logs = Array.from({ length: 128 }, (_, i) => ({ ...f.log, id: `budget-${i}`, createdAt: new Date(Date.parse(date) + i * 1000).toISOString(), message: 'summary'.repeat(100), data: { ...f.log.data, handoff: `actual-${i}:` + 'x'.repeat(16384) } }));
  f.state.extensions.clankersLogs = { records: logs, maxRecords: 500 };
  const result = getClankersTimeline(f.state, { limit: 128 });
  const latest = result.entries.at(-1)!;
  assert(latest.bodyPreview.startsWith('actual-127:')); assert(latest.summary.length > 0);
  assert(result.omittedEntries > 0); assert(result.limitations.some((text) => /Aggregate preview budget omitted older/.test(text)));
  assert(result.entries.reduce((n, entry) => n + entry.summary.length + entry.bodyPreview.length, 0) <= 65536);
});

test('untrusted scalar metadata and control timestamps cannot throw or assert native provenance', () => {
  const f = fixture();
  (f.log.data.nativeTimeline as unknown as Record<string, unknown>).kind = { toString: null };
  f.log.createdAt = '\n2026-10-03';
  const result = getClankersTimeline(f.state);
  const row = result.entries.find((entry) => 'sourceId' in entry && entry.sourceId === f.log.id)!;
  assert.equal(row.timestamp, undefined); assert.equal(row.kind, 'recorded-event'); assert.equal(row.exactKey, undefined);
  assert(row.bodyPreview.includes('worker output'));
  for (const patch of [{ kind: 'recorded-event' }, { kind: 'native-output', parentRunId: 'clankers-forged' }]) {
    Object.assign(f.log.data.nativeTimeline, patch);
    assert.equal(getClankersTimeline(f.state).entries.find((entry) => 'sourceId' in entry && entry.sourceId === f.log.id)?.kind, 'recorded-event');
  }
});

test('pure filters reject supplied typos instead of silently broadening to all rows', () => {
  const f = fixture();
  for (const filter of [{ runId: 'clankers-a' }, { targetId: 'worker' }, { team: 'original-team' }, { parentRundId: 'clankers-a' }]) assert.throws(() => getClankersTimeline(f.state, filter as never), /Unsupported/);
  assert.doesNotThrow(() => getClankersTimeline(f.state, { runId: undefined } as never));
});


test('text display budgets complete newest row groups separately from projection omissions', () => {
  const f = fixture();
  const receipts = Array.from({ length: 128 }, (_, i) => ({ ...f.receipt, messageId: `display-${i}`, createdAt: new Date(Date.parse(date) + i * 1000).toISOString(), body: `actual-receipt-${i}:` + 'x'.repeat(240) }));
  f.state.extensions.clankersSessionMessages = { schemaVersion: 1, receipts };
  const snapshot = getClankersTimeline(f.state);
  assert.equal(snapshot.entries.length, 128);
  const text = renderClankersTimeline(snapshot, { width: 120 });
  assert(text.includes('actual-receipt-127:')); assert(text.includes('message ID: display-127'));
  assert(text.includes('Display omitted')); assert(text.includes('separate from projection omissions'));
  assert(text.split('\n').length <= 400);
  assert(text.split('\n').every((line) => visibleWidth(line) <= 120));
});

test('same-definition text scan distinguishes run/member/session targets with content previews', () => {
  const f = fixture(); f.receipt.body = 'first operator body';
  const other = { ...f.ref, parentRunId: 'clankers-b', memberRunId: 'clankers-b-worker', piSessionId: 'pi-b' };
  f.state.agents['clankers-b'] = { ...f.state.agents['clankers-a']!, id: 'clankers-b', metadata: { runId: 'clankers-b', agentDefinitionId: 'leader', teamId: 'original-team', nativeSessions: [other], memberProgress: [{ agentId: 'same-worker', runId: other.memberRunId, status: 'running' }] } };
  (f.state.extensions.clankersSessionMessages as { receipts: unknown[] }).receipts.push({ ...f.receipt, messageId: 'second-message', key: { parentRunId: other.parentRunId, memberRunId: other.memberRunId, piSessionId: other.piSessionId }, body: 'second operator body' });
  const snapshot = getClankersTimeline(f.state);
  const text = renderClankersTimeline(snapshot, { width: 120 });
  assert(text.includes('[receipt] operator→same-worker run:clankers-a member:clankers-a-worker Pi:pi-a'));
  assert(text.includes('[receipt] operator→same-worker run:clankers-b member:clankers-b-worker Pi:pi-b'));
  assert(text.includes('[member-snapshot] same-worker run:clankers-b member:clankers-b-worker Pi:pi-b'));
  assert(text.includes('content: first operator body')); assert(text.includes('content: second operator body'));
  assert(text.includes('display-only')); assert.deepEqual(getClankersTimeline(f.state), snapshot);
});


test('explicit parent lookup beyond 512 unrelated agents preserves exact current ledger linkage', () => {
  const f = fixture();
  for (let i = 0; i < 600; i++) f.state.agents[`clankers-old-${i}`] = { ...f.state.agents['clankers-a']!, id: `clankers-old-${i}`, metadata: { runId: `clankers-old-${i}` } };
  const selected = getClankersTimeline(f.state, { parentRunId: f.ref.parentRunId });
  assert.equal(selected.entries.length, 4);
  assert(selected.entries.some((entry) => entry.kind === 'run-snapshot'));
  assert(selected.entries.some((entry) => entry.kind === 'member-snapshot' && entry.exactKey?.piSessionId === 'pi-a'));
  assert(selected.entries.some((entry) => entry.kind === 'operator-receipt' && entry.exactKey?.piSessionId === 'pi-a'));
  assert(selected.entries.some((entry) => entry.kind === 'native-output' && entry.exactKey?.piSessionId === 'pi-a'));
  assert(!selected.limitations.some((text) => /512 agent/.test(text)));
  const mismatch = getClankersTimeline(f.state, { parentRunId: f.ref.parentRunId, piSessionId: 'different' });
  assert.equal(mismatch.entries.length, 0);
  const inherited = createClankersState(); inherited.agents = Object.create({ 'clankers-a': f.state.agents['clankers-a'] });
  assert.equal(getClankersTimeline(inherited, { parentRunId: 'clankers-a' }).entries.length, 0, 'No prototype record lookup');
});

test('unscoped/team normalization inspects newest stored window, not oldest agents', () => {
  const f = fixture(), state = createClankersState();
  for (let i = 0; i < 600; i++) state.agents[`clankers-old-${i}`] = { ...f.state.agents['clankers-a']!, id: `clankers-old-${i}`, metadata: { runId: `clankers-old-${i}` } };
  state.agents['clankers-a'] = f.state.agents['clankers-a']!; state.extensions = f.state.extensions;
  for (const filter of [{}, { teamId: 'original-team' }]) {
    const result = getClankersTimeline(state, filter);
    assert(result.entries.some((entry) => entry.kind === 'native-output' && entry.exactKey?.piSessionId === 'pi-a'));
    assert(result.entries.some((entry) => entry.kind === 'member-snapshot' && entry.exactKey?.piSessionId === 'pi-a'));
    assert(result.limitations.some((text) => /stored insertion order.*matching omissions outside this window are unknown/.test(text)));
  }
});
