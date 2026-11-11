import type { ClankersState, ClankersStateContainer, ClankersSessionMessageInput, ClankersSessionMessageKey, ClankersSessionMessageReceipt, ClankersSessionMessageResult } from './types.js';

export const OPERATOR_CUSTOM_TYPE = 'pi-clankers/operator/v1';
export const MAX_SESSION_MESSAGE_BODY = 16384;
const MAX_RECEIPTS = 128, MAX_BODY_TOTAL = 262144, MAX_PENDING = 32;
const LEDGER = 'clankersSessionMessages';
const modes = ['steer', 'followUp'] as const;
const identity = (key: ClankersSessionMessageKey) => JSON.stringify([key.parentRunId, key.memberRunId, key.piSessionId]);
const copyKey = (key: ClankersSessionMessageKey): ClankersSessionMessageKey => ({ parentRunId: key.parentRunId, memberRunId: key.memberRunId, piSessionId: key.piSessionId });
const copyReceipt = (receipt: ClankersSessionMessageReceipt): ClankersSessionMessageReceipt => ({ schemaVersion: 1, messageId: receipt.messageId, key: copyKey(receipt.key), body: receipt.body, mode: receipt.mode, status: receipt.status, detail: receipt.detail.slice(0, 512), createdAt: receipt.createdAt.slice(0, 64), updatedAt: receipt.updatedAt.slice(0, 64), persistence: receipt.persistence });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const safe = (fn: () => void) => { try { fn(); } catch { /* Observers never own native lifecycle. */ } };
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 256);
const pending = (receipt: ClankersSessionMessageReceipt) => receipt.status === 'recorded' || receipt.status === 'queued';

export function validateSessionMessageKey(key: unknown): key is ClankersSessionMessageKey {
  return record(key) && ['parentRunId', 'memberRunId', 'piSessionId'].every((field) => typeof key[field] === 'string' && (key[field] as string).length <= 256 && /^\S+$/.test(key[field] as string) && !/[\x00-\x1f\x7f-\x9f]/.test(key[field] as string));
}
export function validateSessionMessageInput(input: unknown): input is ClankersSessionMessageInput {
  return record(input) && validateSessionMessageKey(input.key) && typeof input.messageId === 'string' && input.messageId.length <= 128 && /^\S+$/.test(input.messageId) && !/[\x00-\x1f\x7f-\x9f]/.test(input.messageId)
    && typeof input.body === 'string' && input.body.length <= MAX_SESSION_MESSAGE_BODY && !!input.body.trim() && !/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(input.body) && (input.mode === 'steer' || input.mode === 'followUp');
}

/** Only this bounded ledger is persisted, never SDK handles or transcripts. */
export function getSessionMessageReceipts(state: ClankersState): ClankersSessionMessageReceipt[] {
  const ledger = state.extensions?.[LEDGER];
  if (!record(ledger) || ledger.schemaVersion !== 1 || !Array.isArray(ledger.receipts)) return [];
  const output: ClankersSessionMessageReceipt[] = []; let total = 0;
  for (const candidate of ledger.receipts.slice(0, MAX_RECEIPTS)) {
    if (!record(candidate) || candidate.schemaVersion !== 1 || !validateSessionMessageInput(candidate) || typeof candidate.createdAt !== 'string' || typeof candidate.updatedAt !== 'string' || typeof candidate.detail !== 'string'
      || typeof candidate.status !== 'string' || !['recorded', 'queued', 'delivered', 'failed', 'needs-attention'].includes(candidate.status) || typeof candidate.persistence !== 'string' || !['memory', 'saved', 'failed'].includes(candidate.persistence)) continue;
    const receipt = candidate as unknown as ClankersSessionMessageReceipt;
    if (output.some((item) => item.messageId === receipt.messageId)) continue;
    if (total + receipt.body.length > MAX_BODY_TOTAL) break;
    total += receipt.body.length; output.push(copyReceipt(receipt));
  }
  return output;
}
function withLedger(state: ClankersState, receipts: ClankersSessionMessageReceipt[]): ClankersState {
  return { ...state, extensions: { ...state.extensions, [LEDGER]: { schemaVersion: 1, receipts } } };
}
export function recoverSessionMessages(state: ClankersState, recoveredAt: string): ClankersState {
  const receipts = getSessionMessageReceipts(state);
  if (!receipts.length || !ledgerHealthy(state)) return state;
  return withLedger(state, receipts.map((receipt) => pending(receipt)
    ? { ...receipt, status: 'needs-attention', detail: 'Recovered receipt; native consumption unconfirmed. Never replayed.', updatedAt: recoveredAt } : receipt));
}

export interface SessionMessageFacade {
  /** All identity, cancellation, streaming and settling checks must be synchronous. */
  accepting(): boolean;
  enqueue(input: ClankersSessionMessageInput): Promise<unknown> | unknown;
  subscribe(listener: (event: unknown) => void): () => void;
}
function ledgerHealthy(state: ClankersState): boolean {
  const ledger = state.extensions?.[LEDGER];
  return ledger === undefined || (record(ledger) && ledger.schemaVersion === 1 && Array.isArray(ledger.receipts) && ledger.receipts.length <= MAX_RECEIPTS && getSessionMessageReceipts(state).length === ledger.receipts.length);
}
export function createSessionMessageService(options: {
  container: ClankersStateContainer;
  readOnly: () => boolean;
  save?: (state: ClankersState) => unknown;
  now?: () => Date;
}) {
  type Owner = { key: ClankersSessionMessageKey; facade?: SessionMessageFacade; closing: boolean; observing: boolean; unsubscribe?: () => void };
  const owners = new Map<string, Owner>();
  const listeners = new Map<string, Set<() => void>>(); let stopped = false, listenerCount = 0, publicationDepth = 0;
  const timestamp = () => (options.now ?? (() => new Date()))().toISOString();
  const notify = (key: ClankersSessionMessageKey) => { for (const listener of listeners.get(identity(key)) ?? []) safe(listener); };
  const unsubscribeState = options.container.subscribe?.(() => { if (!stopped) for (const owner of owners.values()) notify(owner.key); });
  function store(receipts: ClankersSessionMessageReceipt[], changed: ClankersSessionMessageReceipt): boolean {
    publicationDepth++;
    try {
      const state = withLedger(options.container.read(), receipts);
      // Do not publish a 'saved' receipt until the explicit write succeeded.
      // A wrapper may save again after publishing; its failure still fails closed.
      options.save?.(state);
      options.container.replace(state);
      // Reentrant non-message controls can alter state during publication. Save
      // the fresh canonical state, not the wrapper's stale returned snapshot.
      options.save?.(options.container.read());
      notify(changed.key); return true;
    } catch (error) {
      const latest = getSessionMessageReceipts(options.container.read());
      // The attempted transition may not have been published at all. Merge it
      // with newer reentrant observations rather than losing transport truth.
      const index = latest.findIndex((item) => item.messageId === changed.messageId && identity(item.key) === identity(changed.key));
      const current = latest[index];
      const observed = current && (current.status === 'delivered' || current.status === 'failed'
        || (current.status === 'needs-attention' && changed.status !== 'delivered')
        || (current.status === 'queued' && changed.status === 'recorded')) ? current : changed;
      const failedReceipt = { ...observed, persistence: 'failed' as const, detail: `${observed.detail} Receipt snapshot failed: ${errorText(error)}`.slice(0, 512) };
      const failed = [...latest];
      if (index < 0) failed.push(failedReceipt); else failed[index] = failedReceipt;
      safe(() => { options.container.replace(withLedger(options.container.read(), failed)); });
      notify(changed.key); return false;
    } finally { publicationDepth--; }
  }
  function mark(key: ClankersSessionMessageKey, messageId: string, status: ClankersSessionMessageReceipt['status'], detail: string) {
    const receipts = getSessionMessageReceipts(options.container.read());
    const index = receipts.findIndex((item) => item.messageId === messageId && identity(item.key) === identity(key));
    if (index < 0) return;
    const old = receipts[index]!;
    if (old.status === 'delivered' || old.status === 'failed' || (status !== 'delivered' && !pending(old))) return;
    const changed = { ...old, status, detail, updatedAt: timestamp(), persistence: options.save ? 'saved' as const : 'memory' as const };
    receipts[index] = changed; store(receipts, changed);
  }
  function finalize(owner: Owner, reason: string) {
    owner.closing = true;
    for (const receipt of getSessionMessageReceipts(options.container.read())) if (identity(receipt.key) === identity(owner.key) && pending(receipt)) mark(owner.key, receipt.messageId, 'needs-attention', reason);
    notify(owner.key);
  }
  function availability(key: ClankersSessionMessageKey) {
    if (!validateSessionMessageKey(key)) return { canSend: false, reason: 'Exact session IDs are required.' };
    if (stopped) return { canSend: false, reason: 'Messaging owner is closed.' };
    try {
      if (!ledgerHealthy(options.container.read())) return { canSend: false, reason: 'Receipt ledger unsupported or exceeds bounds; no IDs discarded and no native send.' };
      if (options.readOnly()) return { canSend: false, reason: 'Read-only control blocks messaging.' };
      const owner = owners.get(identity(key));
      if (!owner || owner.closing || !owner.facade?.accepting()) return { canSend: false, reason: 'Exact native session is not accepting live messages.' };
      return { canSend: true };
    } catch { return { canSend: false, reason: 'Native messaging capability unavailable.' }; }
  }
  const service = {
    getState(key: ClankersSessionMessageKey) {
      const receipts = validateSessionMessageKey(key) ? getSessionMessageReceipts(options.container.read()).filter((item) => identity(item.key) === identity(key)) : [];
      return { key: copyKey(key), ...availability(key), allowedModes: [...modes], persistence: receipts.some((item) => item.persistence === 'failed') ? 'failed' as const : options.save ? 'saved' as const : 'memory' as const,
        receipts: receipts.slice(-8).map(copyReceipt), droppedReceipts: Math.max(0, receipts.length - 8) };
    },
    list(key: ClankersSessionMessageKey, limit = 32) {
      if (!validateSessionMessageKey(key) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECEIPTS) throw new Error('Exact session IDs and limit 1..128 are required.');
      return getSessionMessageReceipts(options.container.read()).filter((item) => identity(item.key) === identity(key)).slice(-limit).map(copyReceipt);
    },
    subscribe(key: ClankersSessionMessageKey, listener: () => void): () => void {
      if (!validateSessionMessageKey(key) || stopped || listenerCount >= 64) return () => undefined;
      const id = identity(key), set = listeners.get(id) ?? new Set<() => void>();
      const wrapped = () => safe(listener); set.add(wrapped); listeners.set(id, set); listenerCount++;
      let closed = false;
      return () => { if (closed) return; closed = true; set.delete(wrapped); listenerCount = Math.max(0, listenerCount - 1); if (!set.size) listeners.delete(id); };
    },
    async send(input: ClankersSessionMessageInput, signal?: AbortSignal): Promise<ClankersSessionMessageResult> {
      if (!validateSessionMessageInput(input)) return { ok: false, message: 'Required exact IDs, messageId, mode and nonblank literal body (max 16384; LF/tab only controls) are invalid.' };
      if (signal?.aborted) return { ok: false, message: 'Message request cancelled before intent; not sent.' };
      if (publicationDepth > 0) return { ok: false, message: 'Reentrant submission during receipt publication rejected; not sent.' };
      const frozen: ClankersSessionMessageInput = { key: copyKey(input.key), messageId: input.messageId, body: input.body, mode: input.mode };
      let receipts = getSessionMessageReceipts(options.container.read());
      const prior = receipts.find((item) => item.messageId === frozen.messageId);
      if (prior) return identity(prior.key) === identity(frozen.key) && prior.body === frozen.body && prior.mode === frozen.mode
        ? { ok: prior.status === 'queued' || prior.status === 'delivered', message: prior.detail, receipt: copyReceipt(prior) }
        : { ok: false, message: 'messageId conflict: exact payload differs; no native send.' };
      const eligible = availability(frozen.key);
      if (!eligible.canSend) return { ok: false, message: eligible.reason! };
      const selectedOwner = owners.get(identity(frozen.key));
      if (receipts.length >= MAX_RECEIPTS || receipts.reduce((sum, item) => sum + item.body.length, 0) + frozen.body.length > MAX_BODY_TOTAL || receipts.filter((item) => identity(item.key) === identity(frozen.key) && pending(item)).length >= MAX_PENDING)
        return { ok: false, message: 'Receipt capacity reached; no receipts evicted and no native send.' };
      const time = timestamp();
      const receipt: ClankersSessionMessageReceipt = { schemaVersion: 1, ...frozen, status: 'recorded', detail: 'Local intent recorded; not native delivery.', createdAt: time, updatedAt: time, persistence: options.save ? 'saved' : 'memory' };
      receipts = [...receipts, receipt];
      if (!store(receipts, receipt)) {
        safe(() => mark(frozen.key, frozen.messageId, 'failed', 'Intent snapshot failed before native enqueue; not sent.'));
        const failed = service.list(frozen.key, MAX_RECEIPTS).find((item) => item.messageId === frozen.messageId);
        return { ok: false, message: 'Intent snapshot failed; no native send.', receipt: failed };
      }
      // State listeners can cancel/change readonly during the intent write.
      const finalCheck = availability(frozen.key);
      const owner = owners.get(identity(frozen.key));
      if (signal?.aborted || !finalCheck.canSend || !owner?.facade || owner !== selectedOwner) {
        safe(() => mark(frozen.key, frozen.messageId, 'failed', signal?.aborted ? 'Message request cancelled before enqueue; not sent.' : finalCheck.reason ?? 'Exact owner detached before enqueue; not sent.'));
      } else {
        try {
          // No await between the final guard and the synchronous SDK enqueue.
          const result = owner.facade.enqueue(frozen);
          await result;
          safe(() => mark(frozen.key, frozen.messageId, 'queued', 'Native queued; consumption not yet confirmed.'));
        } catch (error) {
          safe(() => mark(frozen.key, frozen.messageId, 'needs-attention', `Native enqueue outcome unconfirmed: ${errorText(error)}. Never retried.`));
        }
      }
      const current = service.list(frozen.key, MAX_RECEIPTS).find((item) => item.messageId === frozen.messageId);
      return { ok: current?.status === 'queued' || current?.status === 'delivered', message: current?.detail ?? 'Receipt unavailable; no retry.', receipt: current };
    },
    register(key: ClankersSessionMessageKey, facade: SessionMessageFacade): () => void {
      if (stopped || !validateSessionMessageKey(key) || owners.has(identity(key)) || owners.size >= 32) return () => undefined;
      const owner: Owner = { key: copyKey(key), facade, closing: false, observing: true };
      owners.set(identity(key), owner);
      try {
        owner.unsubscribe = facade.subscribe((event: unknown) => safe(() => {
          if (!owner.observing || owners.get(identity(owner.key)) !== owner || !record(event)) return;
          if (event.type === 'agent_start') { notify(owner.key); return; }
          if (event.type === 'agent_settled') { owner.observing = false; finalize(owner, 'Native settled without confirmed consumption; never replayed.'); return; }
          if (event.type !== 'message_start' || !record(event.message) || event.message.role !== 'custom' || event.message.customType !== OPERATOR_CUSTOM_TYPE) return;
          const details = event.message.details;
          if (!record(details) || details.schemaVersion !== 1 || typeof details.messageId !== 'string') return;
          const messageId = details.messageId;
          if (!validateSessionMessageKey(details) || identity(details) !== identity(owner.key)) return;
          mark(owner.key, messageId, 'delivered', 'Native consumed into turn; not model acknowledgement or completion.');
        }));
      } catch { owners.delete(identity(key)); owner.closing = true; owner.observing = false; owner.facade = undefined; owner.unsubscribe = undefined; return () => undefined; }
      facade = undefined as never;
      notify(key);
      let released = false;
      return () => { if (released) return; released = true; owner.observing = false; safe(() => finalize(owner, 'Native detached without confirmed consumption; never replayed.')); const unsubscribe = owner.unsubscribe; owner.unsubscribe = undefined; owner.facade = undefined; safe(() => unsubscribe?.()); if (owners.get(identity(owner.key)) === owner) owners.delete(identity(owner.key)); notify(owner.key); };
    },
    closeParent(parentRunId: string) { for (const owner of owners.values()) if (owner.key.parentRunId === parentRunId) safe(() => finalize(owner, 'Cancellation requested; consumption unconfirmed. Never replayed.')); },
    shutdown() {
      if (stopped) return; stopped = true;
      safe(() => unsubscribeState?.());
      for (const owner of owners.values()) { owner.observing = false; safe(() => finalize(owner, 'Messaging owner closed; consumption unconfirmed. Never replayed.')); const unsubscribe = owner.unsubscribe; owner.unsubscribe = undefined; owner.facade = undefined; safe(() => unsubscribe?.()); }
      owners.clear(); listeners.clear(); listenerCount = 0;
    },
  };
  return service;
}
export type SessionMessageService = ReturnType<typeof createSessionMessageService>;
