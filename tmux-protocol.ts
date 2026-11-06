import { timingSafeEqual } from 'node:crypto';

/** Local, same-UID trusted transport. These identities are not a sandbox. */
export const TMUX_PROTOCOL_VERSION = 1;
export const TMUX_TEXT_BYTES = 128 * 1024;
// JSON escapes a one-byte control character as six bytes. Reserve bounded
// envelope space as well, so every admitted text fits even at maximum escaping.
export const TMUX_FRAME_BYTES = 6 * TMUX_TEXT_BYTES + 32 * 1024;
export const TMUX_MAX_JOBS = 128;
export const TMUX_MAX_REQUESTS = 1024;

export interface TmuxIdentity {
  readonly workerId: string;
  readonly sessionId: string;
  readonly generation: string;
  /** Private transport credential: never project into UI, logs or AgentResult data. */
  readonly ownerNonce: string;
  readonly epoch: number;
}
export interface TmuxJobIdentity extends TmuxIdentity {
  readonly jobId: string;
  readonly runId: string | null;
  readonly taskId: string | null;
  readonly source: 'coordinator' | 'human';
}
export type TmuxAction = 'show' | 'prompt' | 'steer' | 'cancel' | 'close' | 'lease';
export interface TmuxRequest {
  readonly version: 1;
  readonly requestId: string;
  readonly identity: TmuxIdentity;
  readonly action: TmuxAction;
  /** Null is an exact idle expectation, never a wildcard/current-job selector. */
  readonly expectedJobId: string | null;
  readonly job: TmuxJobIdentity | null;
  readonly text: string | null;
}
export type TmuxRefusal = 'stale_identity' | 'stale_job' | 'human_owned' | 'busy' | 'closed' | 'limit' | 'duplicate_request' | 'invalid_request';
export interface TmuxTelemetry {
  readonly tokens: { readonly input: number | null; readonly output: number | null; readonly cache_read: number | null; readonly cache_write: number | null };
  readonly context_percent: number | null;
  readonly elapsed_seconds: number | null;
}
export interface TmuxToolEvidence {
  readonly files_changed: readonly string[];
  readonly evidence_complete: false;
  readonly evidence_reasons: readonly string[];
}
export interface TmuxJobResult {
  readonly identity: TmuxJobIdentity;
  readonly outcome: 'completed' | 'failed' | 'aborted';
  readonly text: string;
  readonly textClipped: boolean;
  readonly cancelRequested: boolean;
  readonly settled: true;
  readonly telemetry: TmuxTelemetry | null;
  readonly toolEvidence: TmuxToolEvidence | 'unavailable';
}
export interface TmuxLiveOutput {
  readonly identity: TmuxJobIdentity;
  readonly text: string;
  readonly clipped: boolean;
}
export interface TmuxSnapshot {
  readonly identity: TmuxIdentity;
  readonly ownership: 'coordinator' | 'human';
  readonly phase: 'idle' | 'busy' | 'closed';
  readonly job: TmuxJobIdentity | null;
  readonly result: TmuxJobResult | null;
  /** Latest assistant text only, exact active-job inspection; not a full transcript. */
  readonly liveOutput?: TmuxLiveOutput;
}
export interface TmuxResponse {
  readonly version: 1;
  readonly requestId: string;
  /** Echo the exact request tuple, including on refusal; snapshot may be newer. */
  readonly identity: TmuxIdentity;
  readonly action: TmuxAction;
  readonly expectedJobId: string | null;
  readonly status: 'observed' | 'accepted' | 'requested' | 'refused';
  readonly reason: TmuxRefusal | null;
  readonly snapshot: TmuxSnapshot;
}

const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$(?![\s\S])/;
const NONCE = /^[a-f0-9]{64}$(?![\s\S])/;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Invalid tmux object');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, names: string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== names.length || actual.some(key => !names.includes(key))) throw new Error('Invalid tmux fields');
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error('Invalid tmux identifier');
}
export function parseTmuxIdentity(value: unknown): TmuxIdentity {
  const v = record(value);
  keys(v, ['workerId', 'sessionId', 'generation', 'ownerNonce', 'epoch']);
  id(v.workerId); id(v.sessionId); id(v.generation);
  if (typeof v.ownerNonce !== 'string' || !NONCE.test(v.ownerNonce) || !Number.isSafeInteger(v.epoch) || (v.epoch as number) < 0) throw new Error('Invalid tmux owner');
  return Object.freeze({ workerId: v.workerId, sessionId: v.sessionId, generation: v.generation, ownerNonce: v.ownerNonce, epoch: v.epoch as number });
}
export function parseTmuxJobIdentity(value: unknown): TmuxJobIdentity {
  const v = record(value);
  keys(v, ['workerId', 'sessionId', 'generation', 'ownerNonce', 'epoch', 'jobId', 'runId', 'taskId', 'source']);
  const base = parseTmuxIdentity({ workerId: v.workerId, sessionId: v.sessionId, generation: v.generation, ownerNonce: v.ownerNonce, epoch: v.epoch });
  id(v.jobId);
  if (v.source === 'coordinator') { id(v.runId); id(v.taskId); }
  else if (v.source !== 'human' || v.runId !== null || v.taskId !== null) throw new Error('Invalid tmux job source');
  return Object.freeze({ ...base, jobId: v.jobId, runId: v.runId as string | null, taskId: v.taskId as string | null, source: v.source });
}
export function sameTmuxIdentity(a: TmuxIdentity, b: TmuxIdentity): boolean {
  return a.workerId === b.workerId && a.sessionId === b.sessionId && a.generation === b.generation && a.epoch === b.epoch && a.ownerNonce.length === b.ownerNonce.length && timingSafeEqual(Buffer.from(a.ownerNonce), Buffer.from(b.ownerNonce));
}
function text(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > TMUX_TEXT_BYTES) throw new Error('Invalid tmux text');
}
export function parseTmuxRequest(value: unknown): TmuxRequest {
  const v = record(value);
  keys(v, ['version', 'requestId', 'identity', 'action', 'expectedJobId', 'job', 'text']);
  if (v.version !== TMUX_PROTOCOL_VERSION) throw new Error('Unsupported tmux protocol');
  id(v.requestId);
  const identity = parseTmuxIdentity(v.identity);
  if (!['show', 'prompt', 'steer', 'cancel', 'close', 'lease'].includes(v.action as string)) throw new Error('Invalid tmux action');
  if (v.expectedJobId !== null) id(v.expectedJobId);
  const job = v.job === null ? null : parseTmuxJobIdentity(v.job);
  if (v.action === 'prompt') {
    text(v.text);
    if (!job || job.source !== 'coordinator' || !sameTmuxIdentity(identity, job) || v.expectedJobId !== null) throw new Error('Invalid tmux prompt binding');
  } else {
    if (job !== null) throw new Error('Unexpected tmux job');
    if (v.action === 'steer') text(v.text);
    else if (v.text !== null) throw new Error('Unexpected tmux text');
    if ((v.action === 'steer' || v.action === 'cancel') && v.expectedJobId === null) throw new Error('Missing exact tmux job');
  }
  return Object.freeze({ version: 1, requestId: v.requestId, identity, action: v.action as TmuxAction, expectedJobId: v.expectedJobId as string | null, job, text: v.text as string | null });
}

/** Newline-delimited JSON; reject by bytes before JSON parsing or retention. */
export function encodeTmuxFrame(value: TmuxRequest | TmuxResponse): Buffer {
  const frame = Buffer.from(JSON.stringify(value) + '\n', 'utf8');
  if (frame.length > TMUX_FRAME_BYTES) throw new Error('Tmux frame limit');
  return frame;
}
export class TmuxFrameDecoder {
  private pending = Buffer.alloc(0);
  push(chunk: Buffer): unknown[] {
    // A socket read is itself bounded, even when it contains many small frames.
    if (chunk.length + this.pending.length > TMUX_FRAME_BYTES) throw new Error('Tmux frame limit');
    this.pending = Buffer.concat([this.pending, chunk]);
    const values: unknown[] = [];
    let end: number;
    while ((end = this.pending.indexOf(10)) !== -1) {
      const line = this.pending.subarray(0, end);
      this.pending = this.pending.subarray(end + 1);
      if (!line.length || values.length >= 32) throw new Error('Invalid tmux framing');
      values.push(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)));
    }
    return values;
  }
  finish(): void { if (this.pending.length) throw new Error('Truncated tmux frame'); }
}

function parseTmuxTelemetry(value: unknown): TmuxTelemetry | null {
  if (value === null) return null;
  const v = record(value);
  keys(v, ['tokens', 'context_percent', 'elapsed_seconds']);
  const tokens = record(v.tokens);
  keys(tokens, ['input', 'output', 'cache_read', 'cache_write']);
  for (const metric of [...Object.values(tokens), v.context_percent, v.elapsed_seconds]) {
    if (metric !== null && (typeof metric !== 'number' || !Number.isFinite(metric) || metric < 0 || metric > Number.MAX_SAFE_INTEGER)) throw new Error('Invalid tmux telemetry');
  }
  return Object.freeze({ tokens: Object.freeze({ ...tokens }) as unknown as TmuxTelemetry['tokens'], context_percent: v.context_percent as number | null, elapsed_seconds: v.elapsed_seconds as number | null });
}
function parseTmuxToolEvidence(value: unknown): TmuxToolEvidence | 'unavailable' {
  if (value === 'unavailable') return value;
  const v = record(value);
  keys(v, ['files_changed', 'evidence_complete', 'evidence_reasons']);
  const strings = (items: unknown, count: number, width: number): items is string[] => Array.isArray(items) && items.length <= count && items.every(item => typeof item === 'string' && item.length <= width);
  if (v.evidence_complete !== false || !strings(v.files_changed, 256, 4096) || !strings(v.evidence_reasons, 32, 512) || Buffer.byteLength(JSON.stringify(v)) > 16 * 1024) throw new Error('Invalid tmux tool evidence');
  return Object.freeze({ files_changed: Object.freeze([...v.files_changed]), evidence_complete: false, evidence_reasons: Object.freeze([...v.evidence_reasons]) });
}
/** Retain only bounded observed paths; never claim an independently verified diff. */
export function boundTmuxToolEvidence(value: Omit<TmuxToolEvidence, 'evidence_complete'> & { readonly evidence_complete: boolean }): TmuxToolEvidence {
  const files = [...value.files_changed].slice(0, 256);
  const reasons = [...value.evidence_reasons].slice(0, 30);
  let omitted = files.length !== value.files_changed.length;
  while (files.some(path => path.length > 4096) || Buffer.byteLength(JSON.stringify({ files_changed: files, evidence_complete: false, evidence_reasons: [...reasons, 'Transport omitted observed paths.'] })) > 16 * 1024) {
    if (!files.length) throw new Error('Tmux evidence reasons exceed budget');
    files.pop(); omitted = true;
  }
  if (omitted) reasons.push('Transport omitted observed paths.');
  return parseTmuxToolEvidence({ files_changed: files, evidence_complete: false, evidence_reasons: reasons }) as TmuxToolEvidence;
}

function parseResult(value: unknown): TmuxJobResult {
  const v = record(value);
  keys(v, ['identity', 'outcome', 'text', 'textClipped', 'cancelRequested', 'settled', 'telemetry', 'toolEvidence']);
  const identity = parseTmuxJobIdentity(v.identity);
  if (!['completed', 'failed', 'aborted'].includes(v.outcome as string) || typeof v.text !== 'string' || Buffer.byteLength(v.text) > TMUX_TEXT_BYTES || typeof v.textClipped !== 'boolean' || typeof v.cancelRequested !== 'boolean' || v.settled !== true) throw new Error('Invalid tmux result');
  return Object.freeze({ identity, outcome: v.outcome as TmuxJobResult['outcome'], text: v.text, textClipped: v.textClipped, cancelRequested: v.cancelRequested, settled: true, telemetry: parseTmuxTelemetry(v.telemetry), toolEvidence: parseTmuxToolEvidence(v.toolEvidence) });
}
export function parseTmuxResponse(value: unknown, request: TmuxRequest): TmuxResponse {
  const v = record(value);
  keys(v, ['version', 'requestId', 'identity', 'action', 'expectedJobId', 'status', 'reason', 'snapshot']);
  const identity = parseTmuxIdentity(v.identity);
  if (v.version !== 1 || v.requestId !== request.requestId || !sameTmuxIdentity(identity, request.identity) || v.action !== request.action || v.expectedJobId !== request.expectedJobId) throw new Error('Mismatched tmux response');
  if (!['observed', 'accepted', 'requested', 'refused'].includes(v.status as string)) throw new Error('Invalid tmux receipt');
  const reasons = ['stale_identity', 'stale_job', 'human_owned', 'busy', 'closed', 'limit', 'duplicate_request', 'invalid_request'];
  if (v.status === 'refused' ? !reasons.includes(v.reason as string) : v.reason !== null) throw new Error('Invalid tmux refusal');
  if (v.status !== 'refused') {
    const expectedStatus = request.action === 'show' || request.action === 'lease' ? 'observed' : request.action === 'prompt' ? 'accepted' : 'requested';
    if (v.status !== expectedStatus) throw new Error('Invalid tmux receipt state');
  }
  const s = record(v.snapshot);
  keys(s, ['identity', 'ownership', 'phase', 'job', 'result', ...(Object.hasOwn(s, 'liveOutput') ? ['liveOutput'] : [])]);
  const snapshotIdentity = parseTmuxIdentity(s.identity);
  const job = s.job === null ? null : parseTmuxJobIdentity(s.job);
  const result = s.result === null ? null : parseResult(s.result);
  if (!['coordinator', 'human'].includes(s.ownership as string) || !['idle', 'busy', 'closed'].includes(s.phase as string) || (s.phase === 'busy') !== (job !== null)) throw new Error('Invalid tmux snapshot');
  if (job && !sameTmuxIdentity(job, snapshotIdentity)) throw new Error('Mismatched tmux active job');
  if (snapshotIdentity.workerId !== identity.workerId || snapshotIdentity.sessionId !== identity.sessionId || snapshotIdentity.generation !== identity.generation || snapshotIdentity.ownerNonce !== identity.ownerNonce) throw new Error('Replacement tmux worker is not reconnectable');
  if (result && (result.identity.workerId !== identity.workerId || result.identity.sessionId !== identity.sessionId || result.identity.generation !== identity.generation || result.identity.ownerNonce !== identity.ownerNonce)) throw new Error('Mismatched tmux result');
  if (v.status !== 'refused' && !sameTmuxIdentity(snapshotIdentity, identity)) throw new Error('Unexpected tmux ownership change');
  if (result && result.identity.jobId !== request.expectedJobId) throw new Error('Unexpected tmux result job');
  if (v.status === 'accepted' && (!job || !request.job || JSON.stringify(job) !== JSON.stringify(request.job))) throw new Error('Unexpected accepted tmux job');
  let liveOutput: TmuxLiveOutput | undefined;
  if (s.liveOutput !== undefined) {
    const live = record(s.liveOutput);
    keys(live, ['identity', 'text', 'clipped']);
    const binding = parseTmuxJobIdentity(live.identity);
    if (!job || result || request.action !== 'show' || request.expectedJobId !== job.jobId || JSON.stringify(binding) !== JSON.stringify(job) || typeof live.text !== 'string' || Buffer.byteLength(live.text) > 8192 || typeof live.clipped !== 'boolean') throw new Error('Invalid tmux live output binding');
    liveOutput = Object.freeze({ identity: binding, text: live.text, clipped: live.clipped });
  }
  const snapshot: TmuxSnapshot = Object.freeze({ identity: snapshotIdentity, ownership: s.ownership as TmuxSnapshot['ownership'], phase: s.phase as TmuxSnapshot['phase'], job, result, ...(liveOutput ? { liveOutput } : {}) });
  return Object.freeze({ version: 1, requestId: request.requestId, identity, action: request.action, expectedJobId: request.expectedJobId, status: v.status as TmuxResponse['status'], reason: v.reason as TmuxRefusal | null, snapshot });
}

/** Pure arbitration. SDK side effects occur only after acceptance, never in this class. */
export class TmuxWorkerLedger {
  private identity: TmuxIdentity;
  private ownership: 'coordinator' | 'human' = 'coordinator';
  private closed = false;
  private closing = false;
  private active: TmuxJobIdentity | null = null;
  private cancelRequested = false;
  private liveOutput: TmuxLiveOutput | undefined;
  private readonly requests = new Set<string>();
  private readonly jobs = new Set<string>();
  private readonly runs = new Set<string>();
  private readonly tasks = new Set<string>();
  private readonly results = new Map<string, TmuxJobResult>();
  constructor(identity: TmuxIdentity) { this.identity = parseTmuxIdentity(identity); }

  snapshot(jobId?: string, includeLive = true): TmuxSnapshot {
    return Object.freeze({ identity: this.identity, ownership: this.ownership, phase: this.closed ? 'closed' : this.active ? 'busy' : 'idle', job: this.closed ? null : this.active, result: jobId ? this.results.get(jobId) ?? null : null, ...(includeLive && jobId && this.active?.jobId === jobId && this.liveOutput ? { liveOutput: this.liveOutput } : {}) });
  }
  /** Caller must send the returned receipt even if dispatch subsequently fails. No retry. */
  accept(input: TmuxRequest): TmuxResponse {
    const request = parseTmuxRequest(input);
    // Never disclose the owner's snapshot/nonce to an unauthenticated tuple.
    // The transport must close on this error, without serializing an exception.
    if (!sameTmuxIdentity({ ...request.identity, epoch: this.identity.epoch }, this.identity)) throw new Error('Invalid tmux worker binding');
    const inspection = request.action === 'show' || request.action === 'lease';
    let reason: TmuxRefusal | null = null;
    if (!sameTmuxIdentity(request.identity, this.identity)) reason = 'stale_identity';
    else if (this.closed || this.closing) reason = 'closed';
    else if (!inspection && this.requests.has(request.requestId)) reason = 'duplicate_request';
    else if (!inspection && request.action !== 'close' && this.requests.size >= TMUX_MAX_REQUESTS) reason = 'limit';
    else {
      // Idle inspection/heartbeats must not exhaust a keep-open worker's mutation budget.
      // Close reserves one final receipt even when the mutation budget is exhausted.
      if (!inspection) this.requests.add(request.requestId);
      // Show retrieves an exact historical result; lease renews worker liveness, not a job.
      if (!inspection && request.expectedJobId !== (this.active?.jobId ?? null)) reason = 'stale_job';
      else if (request.action === 'prompt') {
        if (this.ownership !== 'coordinator') reason = 'human_owned';
        else if (this.active) reason = 'busy';
        else if (!request.job || this.jobs.has(request.job.jobId) || this.runs.has(request.job.runId!) || this.tasks.has(request.job.taskId!)) reason = 'invalid_request';
        else if (this.jobs.size >= TMUX_MAX_JOBS) reason = 'limit';
        else { this.active = request.job; this.jobs.add(request.job.jobId); this.runs.add(request.job.runId!); this.tasks.add(request.job.taskId!); this.cancelRequested = false; }
      } else if (request.action === 'steer' || request.action === 'cancel') {
        if (this.ownership !== 'coordinator') reason = 'human_owned';
        else if (!this.active) reason = 'stale_job';
        else if (request.action === 'cancel') this.cancelRequested = true;
      } else if (request.action === 'close') this.closing = true;
    }
    const status = reason ? 'refused' : request.action === 'prompt' ? 'accepted' : request.action === 'show' || request.action === 'lease' ? 'observed' : 'requested';
    // Close remains requested until the supervisor actually terminates the worker.
    return Object.freeze({ version: 1, requestId: request.requestId, identity: request.identity, action: request.action, expectedJobId: request.expectedJobId, status, reason, snapshot: this.snapshot(request.expectedJobId ?? undefined, request.action === 'show') });
  }
  /** Only the local human command calls this. There is no remote takeover verb. */
  humanOwnership(target: 'human' | 'coordinator', expected: TmuxIdentity): TmuxRefusal | null {
    if (!sameTmuxIdentity(expected, this.identity)) return 'stale_identity';
    if (this.closed || this.closing) return 'closed';
    if (this.active) return 'busy';
    if (target === this.ownership) return 'invalid_request';
    if (this.identity.epoch === Number.MAX_SAFE_INTEGER) return 'limit';
    this.ownership = target;
    this.identity = Object.freeze({ ...this.identity, epoch: this.identity.epoch + 1 });
    return null;
  }
  beginHuman(jobId: string, expected: TmuxIdentity): TmuxJobIdentity {
    id(jobId);
    if (!sameTmuxIdentity(expected, this.identity) || this.closed || this.closing || this.active || this.ownership !== 'human' || this.jobs.has(jobId) || this.jobs.size >= TMUX_MAX_JOBS) throw new Error('Human tmux turn not admitted');
    this.active = parseTmuxJobIdentity({ ...this.identity, jobId, runId: null, taskId: null, source: 'human' });
    this.jobs.add(jobId); this.cancelRequested = false;
    return this.active;
  }
  /** Notification-only capture; stale jobs can never overwrite another job's output. */
  observe(job: TmuxJobIdentity, content: unknown): void {
    if (!this.active || this.closed || JSON.stringify(parseTmuxJobIdentity(job)) !== JSON.stringify(this.active)) throw new Error('Stale tmux observation');
    const captured = captureTmuxText(content, 8192);
    this.liveOutput = Object.freeze({ identity: this.active, ...captured });
  }
  /** Only real agent_settled observation may call settle; never a prompt/abort ACK. */
  settle(job: TmuxJobIdentity, outcome: TmuxJobResult['outcome'], value: string, clipped: boolean, observation?: { telemetry: TmuxTelemetry | null; toolEvidence: TmuxToolEvidence | 'unavailable' }): TmuxJobResult {
    if (!this.active || !sameTmuxIdentity(job, this.active) || job.jobId !== this.active.jobId || job.runId !== this.active.runId || job.taskId !== this.active.taskId || job.source !== this.active.source || this.closed) throw new Error('Stale tmux settlement');
    const result = parseResult({ identity: this.active, outcome, text: value, textClipped: clipped, cancelRequested: this.cancelRequested, settled: true, telemetry: observation?.telemetry ?? null, toolEvidence: observation?.toolEvidence ?? 'unavailable' });
    this.results.set(job.jobId, result);
    this.active = null; this.cancelRequested = false; this.liveOutput = undefined;
    return result;
  }
  /** Invalidating authority does not invent a settled result for interrupted work. */
  invalidate(): void { this.closed = true; this.active = null; this.liveOutput = undefined; }
}

/** Capture text without concatenating unbounded provider text or copying whole messages. */
export function captureTmuxText(content: unknown, limit = TMUX_TEXT_BYTES): { text: string; clipped: boolean } {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > TMUX_TEXT_BYTES) throw new Error('Invalid tmux capture limit');
  if (!Array.isArray(content)) return { text: '', clipped: false };
  let output = ''; let remaining = limit; let clipped = false;
  for (let index = 0; index < Math.min(content.length, 1024); index++) {
    const block = content[index];
    if (!block || block.type !== 'text' || typeof block.text !== 'string') continue;
    // UTF-8 is at most four bytes per code point; only inspect a bounded prefix.
    let prefix = block.text.slice(0, remaining);
    if (prefix.length && /[\uD800-\uDBFF]/.test(prefix[prefix.length - 1])) prefix = prefix.slice(0, -1);
    // Binary search avoids quadratic rescanning for large multibyte output.
    if (Buffer.byteLength(prefix) > remaining) {
      let low = 0, high = prefix.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (Buffer.byteLength(prefix.slice(0, middle)) <= remaining) low = middle;
        else high = middle - 1;
      }
      prefix = prefix.slice(0, low);
    }
    if (prefix.length && /[\uD800-\uDBFF]/.test(prefix[prefix.length - 1])) prefix = prefix.slice(0, -1);
    output += prefix; remaining -= Buffer.byteLength(prefix);
    if (prefix.length < block.text.length) { clipped = true; break; }
  }
  return { text: output, clipped: clipped || content.length > 1024 };
}
