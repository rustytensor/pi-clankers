import { createHash } from 'node:crypto';
import { normalizeCustomType } from './legacy-names.js';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { SessionManager, type SessionHeader, type SessionEntry, type SessionContext, type SessionProjection } from '@earendil-works/pi-coding-agent';
import type { ClankersNativeSessionReference } from './types.js';

export const NATIVE_SESSION_MARKER = 'pi-clankers/native-session/v1';
export const NATIVE_ANCESTOR_SESSION_MARKER = 'pi-clankers/native-ancestor-session/v1';
export const NATIVE_CONTINUATION_MARKER = 'pi-clankers/native-continuation/v1';
export const NATIVE_ANCESTOR_CONTINUATION_MARKER = 'pi-clankers/native-ancestor-continuation/v1';
export const NATIVE_HISTORY_LIMITS = { bytes: 8 * 1024 * 1024, line: 256 * 1024, entries: 10000, ancestors: 128 } as const;
export type NativeHistoryFingerprint = { sha256: string; dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
export type NativeHistory = { header: SessionHeader; entries: SessionEntry[]; fingerprint: NativeHistoryFingerprint };
export type NativeHistoryIdentity = Pick<ClankersNativeSessionReference, 'schemaVersion' | 'parentRunId' | 'memberRunId' | 'agentDefinitionId' | 'piSessionId' | 'sessionFile' | 'cwd' | 'createdAt'>;
export type NativeHistoryAncestor = { id: string; customType: string; dataDigest: string };
export type NativeHistoryContinuation = {
  schemaVersion: 1; source: NativeHistoryIdentity; sourceFingerprint: string; entryId: string;
  policyDigest: string; ancestors: NativeHistoryAncestor[];
};
export type NativeHistorySelection = { entryId: string; entryDigest: string; context: SessionContext; projection: SessionProjection };
const identityFields = ['schemaVersion', 'parentRunId', 'memberRunId', 'agentDefinitionId', 'piSessionId', 'sessionFile', 'cwd', 'createdAt'] as const;
const record = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f-\x9f]/u.test(value);
const exact = (value: Record<string, any>, fields: readonly string[]) => Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const reserved = [NATIVE_SESSION_MARKER, NATIVE_ANCESTOR_SESSION_MARKER, NATIVE_CONTINUATION_MARKER, NATIVE_ANCESTOR_CONTINUATION_MARKER];
const ancestor = (entry: any): boolean => entry.type === 'custom' && [NATIVE_ANCESTOR_SESSION_MARKER, NATIVE_ANCESTOR_CONTINUATION_MARKER].includes(entry.customType);
const descriptor = (entry: any): NativeHistoryAncestor => ({ id: entry.id, customType: entry.customType, dataDigest: digest(entry.data) });
function validIdentity(value: unknown): value is NativeHistoryIdentity {
  return record(value) && exact(value, identityFields) && value.schemaVersion === 1 &&
    ['parentRunId', 'memberRunId', 'agentDefinitionId', 'piSessionId'].every((field) => id(value[field])) &&
    typeof value.sessionFile === 'string' && value.sessionFile.length <= 4096 && isAbsolute(value.sessionFile) &&
    typeof value.cwd === 'string' && value.cwd.length <= 4096 && isAbsolute(value.cwd) &&
    typeof value.createdAt === 'string' && value.createdAt.length <= 64 && Number.isFinite(Date.parse(value.createdAt));
}
function sameIdentity(a: NativeHistoryIdentity, b: NativeHistoryIdentity): boolean { return identityFields.every((field) => a[field] === b[field]); }

/** Checks the complete recognized metadata set, not the last marker on the selected branch. */
function validateProvenance(rows: Record<string, any>[], ref: ClankersNativeSessionReference, header: Record<string, any>): void {
  if (rows.some((entry) => reserved.includes(entry.customType) && entry.type !== 'custom')) throw new Error('Saved history reserved metadata type mismatch');
  const own = rows.filter((entry) => entry.type === 'custom' && entry.customType === NATIVE_SESSION_MARKER);
  // The legacy exact-one/eight-field check is deliberately unchanged.
  if (own.length !== 1 || !record(own[0].data) || !exact(own[0].data, identityFields) ||
      identityFields.some((field) => own[0].data[field] !== ref[field])) throw new Error('Saved history provenance mismatch');
  const inherited = rows.filter(ancestor);
  const continuations = rows.filter((entry) => entry.type === 'custom' && entry.customType === NATIVE_CONTINUATION_MARKER);
  if (inherited.length > NATIVE_HISTORY_LIMITS.ancestors || continuations.length > 1 || (inherited.length > 0 && continuations.length !== 1)) throw new Error('Saved history lineage count mismatch');
  for (const entry of inherited) if (entry.customType === NATIVE_ANCESTOR_SESSION_MARKER &&
      (!validIdentity(entry.data) || entry.data.piSessionId === ref.piSessionId || entry.data.sessionFile === ref.sessionFile)) throw new Error('Saved history ancestor identity invalid or not fresh');
  const byId = new Map(rows.map((entry) => [entry.id, entry]));
  for (const entry of rows.filter((row) => row.type === 'custom' && [NATIVE_CONTINUATION_MARKER, NATIVE_ANCESTOR_CONTINUATION_MARKER].includes(row.customType))) {
    const data = entry.data;
    if (!record(data) || !exact(data, ['schemaVersion', 'source', 'sourceFingerprint', 'entryId', 'policyDigest', 'ancestors']) ||
        data.schemaVersion !== 1 || !validIdentity(data.source) || !sha(data.sourceFingerprint) || !sha(data.policyDigest) || !id(data.entryId) ||
        !Array.isArray(data.ancestors) || data.ancestors.length > NATIVE_HISTORY_LIMITS.ancestors || !byId.has(data.entryId)) throw new Error('Saved history continuation invalid');
    const seen = new Set<string>();
    for (const item of data.ancestors) {
      const target = record(item) ? byId.get(item.id) : undefined;
      if (!record(item) || !exact(item, ['id', 'customType', 'dataDigest']) || !id(item.id) || !sha(item.dataDigest) || seen.has(item.id) ||
          !target || !ancestor(target) || target.customType !== normalizeCustomType(item.customType) || digest(target.data) !== item.dataDigest ||
          rows.indexOf(target) >= rows.indexOf(entry)) throw new Error('Saved history ancestor digest mismatch');
      seen.add(item.id);
    }
    if (!data.ancestors.some((item: NativeHistoryAncestor) => {
      const target = byId.get(item.id)!;
      return target.customType === NATIVE_ANCESTOR_SESSION_MARKER && sameIdentity(target.data, data.source);
    })) throw new Error('Saved history continuation source missing');
    if (entry.customType === NATIVE_CONTINUATION_MARKER) {
      if (data.source.piSessionId === ref.piSessionId || data.source.sessionFile === ref.sessionFile) throw new Error('Saved history continuation identity is not fresh');
      if (header.parentSession !== undefined && header.parentSession !== data.source.sessionFile) throw new Error('Saved history continuation parentSession mismatch');
      if (data.ancestors.length !== inherited.length || data.ancestors.some((item: NativeHistoryAncestor, index: number) => {
        const expected = descriptor(inherited[index]);
        return item.id !== expected.id || normalizeCustomType(item.customType) !== expected.customType || item.dataDigest !== expected.dataDigest;
      })) throw new Error('Saved history unaccounted ancestor metadata');
    }
  }
}

function validateGraph(rows: Record<string, any>[]): void {
  const byId = new Map<string, Record<string, any>>();
  for (const row of rows) {
    if (typeof row.id !== 'string' || !row.id || row.id.length > 256 || byId.has(row.id) ||
        !(row.parentId === null || typeof row.parentId === 'string') || typeof row.type !== 'string') throw new Error('Saved history invalid or duplicate entry');
    byId.set(row.id, row);
  }
  const visited = new Set<string>(); let steps = 0;
  for (const row of rows) {
    const path = new Set<string>(); let cursor: Record<string, any> | undefined = row;
    while (cursor && !visited.has(cursor.id)) {
      if (++steps > NATIVE_HISTORY_LIMITS.entries || path.has(cursor.id)) throw new Error('Saved history cyclic graph or work limit');
      path.add(cursor.id);
      if (cursor.parentId === null) break;
      cursor = byId.get(cursor.parentId); if (!cursor) throw new Error('Saved history orphan entry');
    }
    for (const entryId of path) visited.add(entryId);
  }
}
function sameStat(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Strict, non-repairing raw read. Never hand the source pathname to a native session manager. */
export async function readNativeHistory(ref: ClankersNativeSessionReference, options: { agentDir?: string; signal?: AbortSignal; requireFinalNewline?: boolean } = {}): Promise<NativeHistory> {
  const abort = () => { if (options.signal?.aborted) throw new Error('Saved history load aborted'); };
  abort();
  const root = resolve(options.agentDir ?? (await import('@earendil-works/pi-coding-agent')).getAgentDir(), 'sessions');
  const group = `--${resolve(ref.cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
  const path = resolve(ref.sessionFile), directory = join(root, group);
  if (!isAbsolute(ref.sessionFile) || path !== ref.sessionFile || !path.startsWith(`${directory}${sep}`) ||
      path.slice(directory.length + 1).includes(sep) || !path.endsWith('.jsonl')) throw new Error('Saved history locator denied');
  const checkPath = async () => {
    const parts = path.split(sep).filter(Boolean); let current: string = sep;
    for (const part of parts) { abort(); current = join(current, part); if ((await lstat(current)).isSymbolicLink()) throw new Error('Saved history symlink denied'); }
    if (await realpath(path) !== path) throw new Error('Saved history canonical path mismatch');
  };
  await checkPath();
  const before = await lstat(path);
  if (!before.isFile()) throw new Error('Saved history is not a regular file');
  if (before.size > NATIVE_HISTORY_LIMITS.bytes) throw new Error('Saved history exceeds byte limit');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes: Buffer, fingerprint: NativeHistoryFingerprint;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !sameStat(stat, before) || stat.size > NATIVE_HISTORY_LIMITS.bytes) throw new Error('Saved history identity changed');
    bytes = Buffer.alloc(Math.min(stat.size + 1, NATIVE_HISTORY_LIMITS.bytes + 1));
    let length = 0;
    while (length < bytes.length) { abort(); const read = await file.read(bytes, length, Math.min(65536, bytes.length - length), length); if (!read.bytesRead) break; length += read.bytesRead; }
    const after = await file.stat(); await checkPath(); const locator = await lstat(path);
    if (!sameStat(after, stat) || !sameStat(locator, stat) || !locator.isFile() || length !== stat.size) throw new Error('Saved history changed during read');
    bytes = bytes.subarray(0, length);
    fingerprint = { sha256: createHash('sha256').update(bytes).digest('hex'), dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  } finally { await file.close(); }
  abort();
  if (options.requireFinalNewline && bytes.at(-1) !== 10) throw new Error('Saved history execution requires final newline');
  let decoded: string;
  try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('Saved history invalid UTF-8'); }
  const lines = decoded.split('\n'); if (lines.at(-1) === '') lines.pop();
  if (!lines.length || lines.length > NATIVE_HISTORY_LIMITS.entries + 1) throw new Error('Saved history entry limit or empty file');
  if (lines.some((line) => Buffer.byteLength(line) > NATIVE_HISTORY_LIMITS.line)) throw new Error('Saved history line limit exceeded');
  let rows: Record<string, any>[];
  try { rows = lines.map((line) => { const value: unknown = JSON.parse(line); if (!record(value)) throw new Error(); return Object.hasOwn(value, 'customType') ? { ...value, customType: normalizeCustomType(value.customType) } : value; }); }
  catch { throw new Error('Saved history corrupt or partial JSONL'); }
  const header = rows.shift()!;
  if (header.type !== 'session' || header.version !== 3) throw new Error('Unsupported saved session header (requires v3)');
  if (header.id !== ref.piSessionId || header.cwd !== ref.cwd || rows.some((entry) => entry.type === 'session')) throw new Error('Saved history header identity mismatch');
  validateGraph(rows); validateProvenance(rows, ref, header);
  return { header: header as SessionHeader, entries: rows as SessionEntry[], fingerprint };
}

/** Copy the complete raw tree; only our identity/lineage namespace changes. Opaque data is preserved. */
export function inheritNativeHistory(history: NativeHistory): { entries: SessionEntry[]; ancestors: NativeHistoryAncestor[] } {
  const entries = clone(history.entries);
  for (const entry of entries) {
    if (entry.type !== 'custom') continue;
    if (entry.customType === NATIVE_SESSION_MARKER) entry.customType = NATIVE_ANCESTOR_SESSION_MARKER;
    else if (entry.customType === NATIVE_CONTINUATION_MARKER) entry.customType = NATIVE_ANCESTOR_CONTINUATION_MARKER;
  }
  const ancestors = entries.filter(ancestor).map(descriptor);
  if (ancestors.length > NATIVE_HISTORY_LIMITS.ancestors) throw new Error('Native history ancestor limit reached');
  return { entries, ancestors };
}

function content(value: unknown, allowed: readonly string[], stringAllowed: boolean): boolean {
  if (typeof value === 'string') return stringAllowed;
  if (!Array.isArray(value)) return false;
  return value.every((block) => record(block) && allowed.includes(block.type) &&
    (block.type === 'text' ? typeof block.text === 'string' : block.type === 'image' ? typeof block.data === 'string' && typeof block.mimeType === 'string' :
      block.type === 'thinking' ? typeof block.thinking === 'string' || (block.redacted === true && typeof block.thinkingSignature === 'string') :
      id(block.id) && typeof block.name === 'string' && block.name.length > 0 && record(block.arguments)));
}
function validateMessage(message: unknown): void {
  if (!record(message) || !Number.isFinite(message.timestamp)) throw new Error('Native history incomplete message');
  const role = message.role;
  if (role === 'user' || role === 'custom') {
    if (!content(message.content, ['text', 'image'], true) || (role === 'custom' && (typeof message.customType !== 'string' || typeof message.display !== 'boolean'))) throw new Error('Native history invalid user/custom message');
  } else if (role === 'assistant') {
    if (!content(message.content, ['text', 'thinking', 'toolCall'], false) || !['stop', 'length', 'toolUse', 'error', 'aborted', 'deferred'].includes(message.stopReason) ||
        !['api', 'provider', 'model'].every((field) => typeof message[field] === 'string' && message[field].length > 0) || !record(message.usage)) throw new Error('Native history incomplete assistant message');
  } else if (role === 'toolResult') {
    if (!id(message.toolCallId) || typeof message.toolName !== 'string' || typeof message.isError !== 'boolean' || !content(message.content, ['text', 'image'], false)) throw new Error('Native history invalid tool result');
  } else if (role === 'system') {
    if (!content(message.content, ['text'], true) || (message.sections !== undefined && (!record(message.sections) || !Object.values(message.sections).every((value) => value === null || typeof value === 'string'))) ||
        (message.replace !== undefined && typeof message.replace !== 'boolean') ||
        (message.toolsAdded !== undefined && (!Array.isArray(message.toolsAdded) || !message.toolsAdded.every((tool: unknown) => record(tool) && typeof tool.name === 'string' && tool.name.length > 0 && typeof tool.description === 'string' && record(tool.parameters)))) ||
        (message.toolsRemoved !== undefined && (!Array.isArray(message.toolsRemoved) || !message.toolsRemoved.every((tool: unknown) => record(tool) && typeof tool.name === 'string' && tool.name.length > 0)))) throw new Error('Native history invalid system message');
  } else if (role === 'bashExecution') {
    if (typeof message.command !== 'string' || typeof message.output !== 'string' || typeof message.cancelled !== 'boolean' || typeof message.truncated !== 'boolean' ||
        (message.exitCode !== undefined && !Number.isFinite(message.exitCode))) throw new Error('Native history invalid bash execution');
  } else throw new Error('Native history unsupported execution message role');
}
function editable(entry: any): boolean { return entry.type === 'custom_message' || (entry.type === 'message' && ['user', 'assistant', 'toolResult', 'custom'].includes(entry.message?.role)); }

/** Exact entry position only. Public native projection is authoritative for compaction and append-only edits. */
export function validateNativeHistorySelection(history: NativeHistory, entryId: string): NativeHistorySelection {
  if (!id(entryId)) throw new Error('Native history exact entry required');
  validateGraph(history.entries as any[]);
  const selected = history.entries.find((entry) => entry.id === entryId);
  if (!selected) throw new Error('Native history selected entry missing');
  const manager = SessionManager.inMemory(history.header.cwd, undefined, clone([history.header, ...history.entries]));
  manager.branch(entryId);
  const path = manager.getBranch();
  const preceding = new Map<string, SessionEntry>();
  for (const entry of path) {
    if (!id(entry.id) || typeof entry.timestamp !== 'string' || !Number.isFinite(Date.parse(entry.timestamp))) throw new Error('Native history invalid execution entry identity');
    switch (entry.type) {
      case 'message': validateMessage(entry.message); break;
      case 'custom_message':
        if (typeof entry.customType !== 'string' || typeof entry.display !== 'boolean' || !content(entry.content, ['text', 'image'], true)) throw new Error('Native history invalid custom message');
        break;
      case 'compaction':
        if (typeof entry.summary !== 'string' || !Number.isFinite(entry.tokensBefore) || entry.tokensBefore < 0 ||
            (entry.firstKeptEntryId !== entry.id && !preceding.has(entry.firstKeptEntryId))) throw new Error('Native history invalid compaction boundary');
        if (entry.systemMessage !== undefined) { if (entry.systemMessage.role !== 'system') throw new Error('Native history invalid compaction checkpoint'); validateMessage(entry.systemMessage); }
        break;
      case 'context_edit': {
        const target = preceding.get(entry.targetId);
        if (!target || !editable(target) || (entry.replacement !== null && (!record(entry.replacement) || !exact(entry.replacement, ['content'])))) throw new Error('Native history invalid context edit target');
        if (entry.replacement !== null) {
          const role = target.type === 'message' ? (target.message as any).role : 'custom';
          if (!content(entry.replacement.content, role === 'assistant' ? ['text', 'thinking', 'toolCall'] : ['text', 'image'], true)) throw new Error('Native history invalid context edit replacement');
        }
        break;
      }
      case 'branch_summary':
        if (typeof entry.summary !== 'string' || !history.entries.some((row) => row.id === entry.fromId)) throw new Error('Native history invalid branch summary');
        break;
      case 'model_change': if (typeof entry.provider !== 'string' || typeof entry.modelId !== 'string') throw new Error('Native history invalid model metadata'); break;
      case 'thinking_level_change': if (typeof entry.thinkingLevel !== 'string') throw new Error('Native history invalid thinking metadata'); break;
      case 'custom': if (typeof entry.customType !== 'string') throw new Error('Native history invalid custom metadata'); break;
      case 'label': if (!history.entries.some((row) => row.id === entry.targetId) || (entry.label !== undefined && typeof entry.label !== 'string')) throw new Error('Native history invalid label'); break;
      case 'session_info': if (entry.name !== undefined && typeof entry.name !== 'string') throw new Error('Native history invalid session info'); break;
      case 'usage': break; // Accounting-only, never model context; unknown usage kinds are valid Pi metadata.
      default: throw new Error('Native history unsupported execution entry');
    }
    preceding.set(entry.id, entry);
  }
  const projection = manager.buildSessionProjection(), context = manager.buildSessionContext();
  const pending = new Map<string, string>(), seen = new Set<string>();
  for (const message of projection.messages as any[]) {
    if (message.role === 'compactionSummary' || message.role === 'branchSummary') continue;
    validateMessage(message);
    if (message.role === 'assistant') {
      if (pending.size || ['pending', 'error', 'aborted', 'deferred'].includes(message.stopReason)) throw new Error('Native history unsafe assistant boundary');
      const calls = message.content.filter((block: any) => block.type === 'toolCall');
      if (message.stopReason === 'toolUse' && !calls.length) throw new Error('Native history incomplete tool batch');
      for (const call of calls) {
        if (seen.has(call.id)) throw new Error('Native history duplicate tool call');
        seen.add(call.id); pending.set(call.id, call.name);
      }
    } else if (message.role === 'toolResult') {
      if (pending.get(message.toolCallId) !== message.toolName) throw new Error('Native history orphan or mismatched tool result');
      pending.delete(message.toolCallId);
    } else if (pending.size && message.role !== 'system') throw new Error('Native history interrupted tool batch');
  }
  if (pending.size) throw new Error('Native history incomplete tool boundary');
  return { entryId, entryDigest: digest(selected), context, projection };
}
