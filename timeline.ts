import { hasRunIdPrefix } from './legacy-names.js';
import { sanitizeNativeTranscriptText } from './native-transcript.js';
import { createClankersSubagentRunSnapshot } from './state.js';
import { getSessionMessageReceipts, validateSessionMessageKey } from './session-messages.js';
import type { ClankersNativeSessionReference, ClankersSessionMessageKey, ClankersState, ClankersTimelineEntry, ClankersTimelineFilter, ClankersTimelineSnapshot } from './types.js';

export const CLANKERS_TIMELINE_DEFAULT_LIMIT = 128;
export const CLANKERS_TIMELINE_MAX_LIMIT = 256;
const RUN_SCAN = 512;
const PER_RUN_SCAN = 64;
const RECORD_SCAN = 2048;
const TEXT_BUDGET = 65536;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && /^\S+$/.test(value) && !/[\x00-\x1f\x7f-\x9f]/.test(value);
const optionalId = (value: unknown): string | undefined => identity(value) ? value : undefined;
const time = (value: unknown): string | undefined => typeof value === 'string' && value.length <= 64 && !/[\x00-\x1f\x7f-\x9f]/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined;
const stableId = (...parts: string[]): string => JSON.stringify(parts);
const shortStatus = (value: unknown): string => typeof value === 'string' ? sanitizeNativeTranscriptText(value.slice(0, 64)).replace(/\s+/g, ' ') : 'unknown';
const keyOf = (key: ClankersSessionMessageKey): string => stableId(key.parentRunId, key.memberRunId, key.piSessionId);

export function validateClankersTimelineFilter(value: unknown): ClankersTimelineFilter {
  if (!record(value)) throw new Error('Timeline filters must be an object.');
  const allowed = new Set(['teamId', 'parentRunId', 'memberRunId', 'piSessionId', 'limit']);
  let fields = 0;
  for (const field in value) {
    if (!Object.hasOwn(value, field)) continue;
    if (++fields > 16 || (!allowed.has(field) && value[field] !== undefined)) throw new Error('Unsupported timeline filter field. Use teamId, parentRunId, memberRunId, piSessionId and limit.');
  }
  const filter: ClankersTimelineFilter = {};
  for (const field of ['teamId', 'parentRunId', 'memberRunId', 'piSessionId'] as const) {
    if (value[field] !== undefined) {
      if (!identity(value[field])) throw new Error(`Timeline ${field} requires an exact ID (1..256 characters, no whitespace or controls).`);
      filter[field] = value[field];
    }
  }
  if (value.limit !== undefined) {
    if (!Number.isSafeInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > CLANKERS_TIMELINE_MAX_LIMIT) throw new Error('Timeline limit must be an integer 1..256.');
    filter.limit = value.limit as number;
  }
  return filter;
}

/** Pure, owner-state-only projection. No transcript/adapter access, replay or caches. */
export function getClankersTimeline(state: ClankersState, input: ClankersTimelineFilter = {}): ClankersTimelineSnapshot {
  const filter = validateClankersTimelineFilter(input);
  const limitations = [
    'Bounded retained state only; not a complete conversation or delivery history.',
    'Operator receipts show current transport/persistence status. Native output is NOT an addressed reply.',
    'Snapshots show current state, NOT recorded historical events. Unknown times have deterministic ID order, not inferred chronology.',
  ];
  const runs = new Map<string, { agent: ClankersState['agents'][string]; metadata: Record<string, unknown>; teamId?: string }>();
  const references = new Map<string, ClankersNativeSessionReference>();
  const blockedMembers = new Set<string>();
  const memberRefs = new Map<string, ClankersNativeSessionReference>();
  const notice = (message: string) => { if (!limitations.includes(message)) limitations.push(message); };
  let runIds: string[];
  if (filter.parentRunId !== undefined) {
    // Exact scoped lookup does not lose a known parent behind unrelated rows.
    runIds = Object.hasOwn(state.agents, filter.parentRunId) ? [filter.parentRunId] : [];
  } else {
    // Key enumeration is O(total stored agents); expensive per-record ledger
    // normalization/candidate work is bounded to the newest insertion window.
    const storedIds = Object.keys(state.agents);
    runIds = storedIds.slice(-RUN_SCAN);
    if (storedIds.length > RUN_SCAN) limitations.push('Input normalization capped at newest 512 agent records by stored insertion order (not timestamp-complete); matching omissions outside this window are unknown.');
  }
  for (const id of runIds) {
    const agent = state.agents[id];
    if (!identity(id) || !hasRunIdPrefix(id, 'clankers-') || !agent || agent.id !== id) continue;
    const metadata = record(agent.metadata) ? agent.metadata : {};
    if (metadata.runId !== undefined && metadata.runId !== id) continue;
    runs.set(id, { agent, metadata, teamId: optionalId(metadata.teamId) });
    const ledger = metadata.nativeSessions;
    if (!Array.isArray(ledger)) continue;
    if (ledger.length > PER_RUN_SCAN) { notice('Reference scan capped at 64 per run; exact linkage disabled for truncated ledgers (unseen conflicts possible).'); continue; }
    // Reuse canonical LAST-valid-member normalization on only the bounded
    // native ledger, not unrelated run metadata or an entire state snapshot.
    const boundedLedger = ledger.filter((candidate) => record(candidate)
      && ['parentRunId', 'memberRunId', 'agentDefinitionId', 'piSessionId', 'sessionFile', 'cwd', 'createdAt', 'disposedAt', 'recoveredAt']
        .every((field) => candidate[field] === undefined || (typeof candidate[field] === 'string' && (candidate[field] as string).length <= 8192)));
    const normalized = createClankersSubagentRunSnapshot({ runId: id, agentId: id, status: agent.status,
      nativeSessions: boundedLedger as ClankersNativeSessionReference[] }).nativeSessions ?? [];
    for (const ref of normalized) {
      if (!validateSessionMessageKey(ref) || !identity(ref.agentDefinitionId)) continue;
      const member = stableId(id, ref.memberRunId);
      if (ref.memberRunId === id && metadata.agentDefinitionId !== ref.agentDefinitionId) { blockedMembers.add(member); continue; }
      const memberProgress = Array.isArray(metadata.memberProgress) ? metadata.memberProgress : [];
      if (memberProgress.length > PER_RUN_SCAN) { blockedMembers.add(member); continue; }
      if (memberProgress.some((item) => record(item) && item.runId === ref.memberRunId && item.agentId !== ref.agentDefinitionId)) { blockedMembers.add(member); continue; }
      references.set(keyOf(ref), ref);
      memberRefs.set(member, ref);
    }
  }
  const corroborate = (key: unknown, definition?: unknown): ClankersNativeSessionReference | undefined => {
    if (!validateSessionMessageKey(key)) return undefined;
    const id = keyOf(key), ref = references.get(id);
    if (!ref || blockedMembers.has(stableId(key.parentRunId, key.memberRunId))) return undefined;
    if (definition !== undefined && definition !== ref.agentDefinitionId) return undefined;
    return ref;
  };
  const attribution = (ref: ClankersNativeSessionReference | undefined) => ref ? {
    parentRunId: ref.parentRunId, memberRunId: ref.memberRunId, piSessionId: ref.piSessionId, agentDefinitionId: ref.agentDefinitionId,
    exactKey: { parentRunId: ref.parentRunId, memberRunId: ref.memberRunId, piSessionId: ref.piSessionId },
  } : {};
  // Candidate count/work is bounded before any preview sanitization. Text stays
  // as references until the final bounded tail has been selected.
  type Candidate = ClankersTimelineEntry;
  const candidates: Candidate[] = [];
  const add = (entry: Candidate) => {
    if (filter.teamId !== undefined && entry.teamId !== filter.teamId) return;
    if (filter.parentRunId !== undefined && entry.parentRunId !== filter.parentRunId) return;
    if (filter.memberRunId !== undefined && entry.memberRunId !== filter.memberRunId) return;
    if (filter.piSessionId !== undefined && entry.piSessionId !== filter.piSessionId) return;
    candidates.push(entry);
  };
  const receiptLedger = record(state.extensions.clankersSessionMessages) ? state.extensions.clankersSessionMessages : undefined;
  // Reader already bounds and validates receipt payloads; additionally reject
  // duplicate source IDs rather than allowing a malformed collision to retarget.
  const receiptCounts = new Map<string, number>();
  const rawReceipts = receiptLedger && Array.isArray(receiptLedger.receipts) ? receiptLedger.receipts : [];
  for (const item of rawReceipts.slice(0, 128)) if (record(item) && identity(item.messageId)) receiptCounts.set(item.messageId, (receiptCounts.get(item.messageId) ?? 0) + 1);
  if (rawReceipts.length > 128) notice('Receipt input exceeds retained ledger bound; exact links disabled, matching omissions unknown.');
  if ([...receiptCounts.values()].some((n) => n > 1)) notice('Duplicate receipt IDs omitted; no retargeting.');
  for (const receipt of getSessionMessageReceipts(state)) {
    if (!identity(receipt.messageId) || (receiptCounts.get(receipt.messageId) ?? 1) !== 1) continue;
    const ref = rawReceipts.length <= 128 ? corroborate(receipt.key) : undefined;
    add({ id: stableId('receipt', receipt.messageId), kind: 'operator-receipt', timestamp: time(receipt.createdAt), timestampMeaning: 'created',
      parentRunId: receipt.key.parentRunId, memberRunId: receipt.key.memberRunId, piSessionId: receipt.key.piSessionId, teamId: runs.get(receipt.key.parentRunId)?.teamId, ...attribution(ref),
      summary: `Operator receipt/current status: ${receipt.status} (${receipt.persistence})${ref ? '' : ' — unlinked exact identity'}`,
      bodyPreview: receipt.body, clipped: false, messageId: receipt.messageId, mode: receipt.mode, status: receipt.status, persistence: receipt.persistence,
      updatedAt: time(receipt.updatedAt) ?? '' });
  }
  const logState = record(state.extensions.clankersLogs) ? state.extensions.clankersLogs : undefined;
  const logs = logState && Array.isArray(logState.records) ? logState.records : [];
  const readWindow = (values: unknown[], label: string) => {
    if (values.length > RECORD_SCAN) limitations.push(`${label} input capped at last 2048 records; matching omissions outside the window are unknown.`);
    return values.slice(-RECORD_SCAN);
  };
  const uniqueWindow = (values: unknown[], label: string) => {
    const window = readWindow(values, label), counts = new Map<string, number>();
    for (const item of window) if (record(item) && identity(item.id)) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
    if ([...counts.values()].some((n) => n > 1)) limitations.push(`${label}: duplicate source IDs omitted; no retargeting.`);
    return window.filter((item): item is Record<string, unknown> => record(item) && identity(item.id) && counts.get(item.id) === 1);
  };
  for (const log of uniqueWindow(logs, 'Logs')) {
    const parentRunId = optionalId(log.runId);
    const data = record(log.data) ? log.data : {};
    const marker = record(data.nativeTimeline) ? data.nativeTimeline : undefined;
    const hasHandoff = log.source === 'adapter' && log.kind === 'result' && typeof data.handoff === 'string';
    const consistentKind = marker?.kind === 'native-output' ? hasHandoff : marker?.kind === 'recorded-event' && !hasHandoff;
    const ref = log.source === 'adapter' && marker?.schemaVersion === 1 && consistentKind && marker.parentRunId === parentRunId && marker.agentDefinitionId === log.agentId
      ? corroborate(marker, marker.agentDefinitionId) : undefined;
    const teamId = optionalId(log.teamId) ?? (parentRunId ? runs.get(parentRunId)?.teamId : undefined);
    // A conflicting explicit recorded team identity is not rewritten by a join.
    const recordedTeam = parentRunId ? runs.get(parentRunId)?.teamId : undefined;
    if (recordedTeam && optionalId(log.teamId) && log.teamId !== recordedTeam) continue;
    const output = !!ref && marker?.kind === 'native-output' && hasHandoff;
    add({ id: stableId('log', log.id as string, time(log.createdAt) ?? '', parentRunId ?? '', optionalId(log.agentId) ?? '', optionalId(marker?.memberRunId) ?? '', optionalId(marker?.piSessionId) ?? ''), kind: output ? 'native-output' : 'recorded-event', source: 'log', sourceId: log.id as string,
      timestamp: time(log.createdAt), timestampMeaning: 'recorded', parentRunId, teamId,
      agentDefinitionId: optionalId(log.agentId), ...attribution(ref), summary: `${!ref && hasHandoff ? 'Recorded log/unlinked handoff: ' : ''}${typeof log.message === 'string' ? log.message.slice(0, 512) : 'Recorded log'}`,
      bodyPreview: hasHandoff ? data.handoff as string : '', clipped: false });
  }
  for (const event of uniqueWindow(state.events as unknown[], 'Lifecycle')) {
    const parentRunId = identity(event.agentId) && runs.has(event.agentId) ? event.agentId : undefined;
    const teamId = optionalId(event.teamId) ?? (parentRunId ? runs.get(parentRunId)?.teamId : undefined);
    if (optionalId(event.teamId) && parentRunId && runs.get(parentRunId)?.teamId && event.teamId !== runs.get(parentRunId)?.teamId) continue;
    add({ id: stableId('event', event.id as string, time(event.createdAt) ?? '', optionalId(event.agentId) ?? '', optionalId(event.teamId) ?? ''), kind: 'recorded-event', source: 'lifecycle', sourceId: event.id as string,
      timestamp: time(event.createdAt), timestampMeaning: 'recorded', parentRunId, teamId,
      summary: typeof event.message === 'string' ? event.message : 'Recorded lifecycle event', bodyPreview: '', clipped: false,
      status: event.status === undefined ? undefined : shortStatus(event.status) });
  }
  for (const [parentRunId, run] of runs) {
    const { agent, metadata, teamId } = run;
    // A parent aggregate is not an implicit choice of its leader conversation.
    add({ id: stableId('run', parentRunId), kind: 'run-snapshot', parentRunId, teamId, agentDefinitionId: optionalId(metadata.agentDefinitionId),
      timestamp: time(agent.runtime?.updatedAt), timestampMeaning: 'current-update', status: shortStatus(agent.status),
      summary: `Current run snapshot: ${shortStatus(agent.status)} (NOT historical event)`,
      bodyPreview: typeof metadata.finalSummary === 'string' ? metadata.finalSummary : '', clipped: false });
    const members = Array.isArray(metadata.memberProgress) ? metadata.memberProgress : [];
    if (members.length > PER_RUN_SCAN) notice('Member scan capped at 64 per run; matching omissions are unknown.');
    const window = members.slice(0, PER_RUN_SCAN), counts = new Map<string, number>();
    for (const member of window) if (record(member) && identity(member.runId)) counts.set(member.runId, (counts.get(member.runId) ?? 0) + 1);
    for (const member of window) {
      if (!record(member) || !identity(member.runId) || !identity(member.agentId) || counts.get(member.runId) !== 1) continue;
      const found = corroborate(memberRefs.get(stableId(parentRunId, member.runId)), member.agentId);
      add({ id: stableId('member', parentRunId, member.runId, member.agentId, found?.piSessionId ?? ''), kind: 'member-snapshot', parentRunId, teamId,
        // Recorded member run/definition attribution is not an inferred Pi link.
        memberRunId: member.runId, agentDefinitionId: member.agentId, ...attribution(found), attachment: found?.attachment,
        timestamp: time(member.completedAt) ?? time(member.startedAt), timestampMeaning: 'current-update',
        status: shortStatus(member.status), summary: `Current member snapshot: ${shortStatus(member.status)} (NOT historical event)`,
        bodyPreview: typeof member.message === 'string' ? member.message : '', clipped: false });
    }
  }
  // Unknown times precede known times; only known source timestamps order events.
  candidates.sort((a, b) => (a.timestamp ? Date.parse(a.timestamp) : -Infinity) - (b.timestamp ? Date.parse(b.timestamp) : -Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const chosen = candidates.slice(-(filter.limit ?? CLANKERS_TIMELINE_DEFAULT_LIMIT));
  let remaining = TEXT_BUDGET;
  const preview = (text: string, maximum: number) => {
    // Slice BEFORE regex work; sanitize again after slice so partial terminal
    // sequences cannot escape. Limit after tab expansion too.
    const bounded = text.slice(0, Math.min(maximum, remaining));
    const sanitized = sanitizeNativeTranscriptText(bounded);
    const safe = sanitized.slice(0, Math.min(maximum, remaining));
    remaining -= safe.length;
    return { text: safe, clipped: text.length > bounded.length || safe.length < sanitized.length };
  };
  const entries: ClankersTimelineEntry[] = [];
  // Preserve the latest real communication text. Older rows that cannot fit
  // even a summary are omitted explicitly, never silently blank the tail.
  for (let index = chosen.length - 1; index >= 0; index--) {
    if (remaining <= 0) { notice('Aggregate preview budget omitted older rows; latest communication text retained.'); break; }
    const item = chosen[index]!;
    const summary = preview(item.summary, 256), body = preview(item.bodyPreview, 1024);
    entries.push({ ...item, summary: summary.text, bodyPreview: body.text, clipped: summary.clipped || body.clipped });
  }
  entries.reverse();
  return { schemaVersion: 1, revision: state.revision, filter: { ...filter }, entries,
    omittedEntries: candidates.length - entries.length, clippedEntries: entries.filter((entry) => entry.clipped).length, limitations };
}
