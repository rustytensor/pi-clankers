import { Ajv, type ValidateFunction } from 'ajv';
import { isAbsolute, relative, resolve, matchesGlob, sep } from 'node:path';

export const AGENT_RESULTS_KEY = 'agentResults';
export const AGENT_RESULT_LIMITS = Object.freeze({ records: 128, totalBytes: 8 * 1024 * 1024, fullBytes: 1024 * 1024, previewChars: 20_000, batch: 32, responseBytes: 1024 * 1024, schemaBytes: 16_384, schemaNodes: 256, schemaDepth: 16, dataNodes: 32_768, dataDepth: 64, validators: 32 });
export type ResultSchema = boolean | Record<string, unknown>;
export interface AgentResult {
  agent_id: string; task_id: string | null; run_id: string; member_run_id: string; pi_session_id: string | null;
  state: 'done' | 'failed' | 'cancelled'; stop_reason: string | null; model: string | null;
  final_message: string | null; final_message_chars: number; full_available: boolean; omitted_chars: number;
  files_changed: string[]; files_outside_allowed: string[] | null;
  evidence_complete: boolean; evidence_reasons: string[];
  tokens: { input: number | null; output: number | null; cache_read: number | null; cache_write: number | null };
  context_percent: number | null; elapsed_seconds: number | null;
  validation: { status: 'not_requested' | 'valid' | 'invalid_json' | 'schema_mismatch' | 'unavailable' | 'limit_exceeded'; errors: string[] };
  result: unknown; result_available: boolean; result_omitted: boolean;
  historical: boolean; notice: 'unavailable' | 'requested' | 'failed';
}
export interface AgentResultLedger { schema_version: 1; records: AgentResult[]; }
export interface AgentResultSelector { id: string; runId?: string; memberRunId?: string; full?: boolean; }
export type AgentResultLookup = { status: 'found'; result: AgentResult } | { status: 'unavailable'; reason: string } | { status: 'ambiguous'; selectors: { id: string; runId: string; memberRunId: string }[] };
const validators = new Map<string, ValidateFunction>();
const immutableLedgers = new WeakSet<object>();
export function isImmutableAgentResultLedger(value: object): boolean { return immutableLedgers.has(value); }
function freezeResultData(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeResultData(child);
  Object.freeze(value);
}
const keywords = new Set(['$schema', 'title', 'description', '$comment', 'type', 'properties', 'required', 'additionalProperties', 'items', 'additionalItems', 'minItems', 'maxItems', 'uniqueItems', 'contains', 'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minProperties', 'maxProperties', 'enum', 'const', 'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else']);
const poison = new Set(['__proto__', 'prototype', 'constructor']);
// No refs, regex or formats: this is an offline, bounded draft-07 profile,
// not a sandbox for arbitrary untrusted JSON Schemas. Never attach loadSchema.
function boundedJson(value: unknown, nodes: number, depth: number, byteLimit = AGENT_RESULT_LIMITS.fullBytes, maxArray = nodes): string {
  let work = 0, bytes = 0;
  const active = new Set<object>();
  const visit = (item: unknown, level: number): void => {
    if (++work > nodes || level > depth) throw new Error('JSON work/depth limit exceeded.');
    if (typeof item === 'string') {
      if (item.length > byteLimit || (bytes += Buffer.byteLength(item)) > byteLimit) throw new Error('JSON byte budget exceeded.');
      return;
    }
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object' || active.has(item)) throw new Error('Expected finite JSON data without cycles.');
    const proto = Object.getPrototypeOf(item);
    if (!Array.isArray(item) && proto !== Object.prototype && proto !== null) throw new Error('Expected plain JSON object.');
    if (Array.isArray(item) && item.length > maxArray) throw new Error('JSON array work limit exceeded.');
    active.add(item);
    for (const key of Object.keys(item)) {
      if (key.length > byteLimit || (bytes += Buffer.byteLength(key) + 4) > byteLimit) throw new Error('JSON byte budget exceeded.');
      if (poison.has(key)) throw new Error('Unsafe JSON property name.');
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      if (!('value' in descriptor)) throw new Error('JSON accessors are not supported.');
      visit(descriptor.value, level + 1);
    }
    active.delete(item);
  };
  visit(value, 0);
  return JSON.stringify(value);
}
function checkSchema(schema: unknown): void {
  if (typeof schema === 'boolean') return;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('result_schema must be a draft-07 schema.');
  for (const [key, value] of Object.entries(schema)) {
    if (!keywords.has(key)) throw new Error(`Unsupported result_schema keyword: ${key}`);
    if (key === '$schema' && value !== 'http://json-schema.org/draft-07/schema#') throw new Error('Only JSON Schema draft-07 is supported.');
    if (key === 'properties') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid schema properties.');
      for (const child of Object.values(value)) checkSchema(child);
    } else if (['allOf', 'anyOf', 'oneOf'].includes(key) || (key === 'items' && Array.isArray(value))) {
      if (!Array.isArray(value)) throw new Error(`Invalid schema ${key}.`);
      for (const child of value) checkSchema(child);
    } else if (['additionalProperties', 'additionalItems', 'items', 'contains', 'not', 'if', 'then', 'else'].includes(key)) checkSchema(value);
  }
}
function compileSchema(schema: ResultSchema): ValidateFunction {
  const key = boundedJson(schema, AGENT_RESULT_LIMITS.schemaNodes, AGENT_RESULT_LIMITS.schemaDepth, AGENT_RESULT_LIMITS.schemaBytes);
  if (Buffer.byteLength(key) > AGENT_RESULT_LIMITS.schemaBytes) throw new Error('result_schema exceeds 16 KiB.');
  checkSchema(schema);
  const cached = validators.get(key);
  if (cached) { validators.delete(key); validators.set(key, cached); return cached; }
  const ajv = new Ajv({ strict: true, allErrors: false, coerceTypes: false, useDefaults: false, removeAdditional: false, ownProperties: true, validateFormats: true, addUsedSchema: false, code: { optimize: false } });
  const validate = ajv.compile(schema);
  if (validators.size >= AGENT_RESULT_LIMITS.validators) validators.delete(validators.keys().next().value!);
  validators.set(key, validate);
  return validate;
}
export function normalizeResultSchema(schema: unknown): ResultSchema | undefined {
  if (schema === undefined) return undefined;
  const json = boundedJson(schema, AGENT_RESULT_LIMITS.schemaNodes, AGENT_RESULT_LIMITS.schemaDepth, AGENT_RESULT_LIMITS.schemaBytes);
  if (Buffer.byteLength(json) > AGENT_RESULT_LIMITS.schemaBytes) throw new Error('result_schema exceeds 16 KiB.');
  const copy = JSON.parse(json) as ResultSchema;
  compileSchema(copy);
  return copy;
}
export function normalizeMayWrite(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 128) throw new Error('may_write must be an array of at most 128 relative glob patterns (reporting only).');
  return value.map((pattern) => {
    if (typeof pattern !== 'string' || !pattern || pattern.length > 512 || isAbsolute(pattern) || pattern.includes('\\') || /[\u0000-\u001f\u007f]/.test(pattern) || pattern.split('/').includes('..')) throw new Error('may_write requires non-traversing relative glob patterns.');
    const normalized = pattern.split('/').filter(part => part && part !== '.').join('/');
    if (!normalized) throw new Error('may_write glob must identify a relative path.');
    return normalized;
  });
}
export function validateAgentResult(text: string | null, schema?: ResultSchema): AgentResult['validation'] & { result?: unknown } {
  if (schema === undefined) return { status: 'not_requested', errors: [] };
  if (text === null) return { status: 'unavailable', errors: ['No new assistant final text.'] };
  if (Buffer.byteLength(text) > AGENT_RESULT_LIMITS.fullBytes) return { status: 'limit_exceeded', errors: ['Final text exceeds JSON validation budget.'] };
  let data: unknown;
  try { data = JSON.parse(text); } catch { return { status: 'invalid_json', errors: ['Final text is not JSON.'] }; }
  // Ajv uniqueItems on structural data can be quadratic. Bound those arrays
  // independently rather than advertising node/depth limits as a time sandbox.
  const usesUniqueItems = (value: unknown): boolean => !!value && typeof value === 'object' && (Object.hasOwn(value, 'uniqueItems') && (value as { uniqueItems?: unknown }).uniqueItems === true || Object.values(value).some(usesUniqueItems));
  try { boundedJson(data, AGENT_RESULT_LIMITS.dataNodes, AGENT_RESULT_LIMITS.dataDepth, AGENT_RESULT_LIMITS.fullBytes, usesUniqueItems(schema) ? 256 : AGENT_RESULT_LIMITS.dataNodes); }
  catch { return { status: 'limit_exceeded', errors: ['Result JSON exceeds work/depth budget or contains unsafe properties.'] }; }
  const validator = compileSchema(schema);
  return validator(data) ? { status: 'valid', errors: [], result: data } : { status: 'schema_mismatch', errors: (validator.errors ?? []).slice(0, 4).map(e => `${e.instancePath.slice(0, 256)} ${e.keyword}: ${e.message ?? 'invalid'}`.slice(0, 512)) };
}
/** Only a newly observed assistant message, never history or tool/thinking blocks. */
export function exactAssistantText(message: unknown): string | null {
  if (!message || typeof message !== 'object' || (message as { role?: unknown }).role !== 'assistant') return null;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const blocks = content.filter((b): b is { type: 'text'; text: string } => !!b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string');
  return blocks.length ? blocks.map(b => b.text).join('') : null;
}
export function previewAgentText(text: string): { text: string; omitted: number } {
  const cap = AGENT_RESULT_LIMITS.previewChars;
  if (text.length <= cap) return { text, omitted: 0 };
  // Reserve marker space too; visible preview is at most 20000 UTF16 units.
  const reserve = `\n[${text.length} characters omitted]\n`.length;
  let head = Math.floor((cap - reserve) / 2), tail = text.length - Math.floor((cap - reserve) / 2);
  if (/[\uD800-\uDBFF]/.test(text[head - 1])) head--;
  if (/[\uDC00-\uDFFF]/.test(text[tail])) tail++;
  const omitted = tail - head;
  return { text: `${text.slice(0, head)}\n[${omitted} characters omitted]\n${text.slice(tail)}`, omitted };
}
export function captureAssistantResultText(message: unknown): Pick<AgentResult, 'final_message' | 'final_message_chars' | 'full_available' | 'omitted_chars'> {
  const missing = { final_message: null, final_message_chars: 0, full_available: false, omitted_chars: 0 };
  if (!message || typeof message !== 'object' || (message as { role?: unknown }).role !== 'assistant') return missing;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return missing;
  const blocks: string[] = [];
  let chars = 0, bytes = 0, previous = '';
  for (const block of content) if (block?.type === 'text' && typeof block.text === 'string') {
    blocks.push(block.text); chars += block.text.length; bytes += Buffer.byteLength(block.text);
    if (block.text.length) {
      if (/[\uD800-\uDBFF]/.test(previous) && /[\uDC00-\uDFFF]/.test(block.text[0])) bytes -= 2;
      previous = block.text[block.text.length - 1];
    }
  }
  if (!blocks.length) return missing;
  if (bytes <= AGENT_RESULT_LIMITS.fullBytes) return { final_message: blocks.join(''), final_message_chars: chars, full_available: true, omitted_chars: 0 };
  // Never allocate a concatenation of an over-ceiling message. Retain exact
  // head/tail slices and the original count, not a falsely labelled full string.
  let head = '', tail = '';
  for (const block of blocks) { if (head.length < 9000) head += block.slice(0, 9000 - head.length); tail = (tail + block.slice(-9000)).slice(-9000); }
  if (/[\uD800-\uDBFF]/.test(head[head.length - 1])) head = head.slice(0, -1);
  if (/[\uDC00-\uDFFF]/.test(tail[0])) tail = tail.slice(1);
  const omitted = chars - head.length - tail.length;
  return { final_message: `${head}\n[${omitted} characters omitted]\n${tail}`, final_message_chars: chars, full_available: false, omitted_chars: omitted };
}
export function projectAgentResult(result: AgentResult, full = false): AgentResult {
  const copy = structuredClone(result);
  if (!full && copy.result_available && JSON.stringify(copy.result).length > AGENT_RESULT_LIMITS.previewChars) {
    copy.result = null; copy.result_omitted = true;
  }
  if (!full && copy.final_message !== null && copy.omitted_chars === 0) {
    const preview = previewAgentText(copy.final_message); copy.final_message = preview.text; copy.omitted_chars = preview.omitted;
  }
  return copy;
}
export function retainAgentResult(ledger: AgentResultLedger | undefined, result: AgentResult): AgentResultLedger {
  const retained = structuredClone(result);
  if (retained.final_message !== null && Buffer.byteLength(retained.final_message) > AGENT_RESULT_LIMITS.fullBytes) {
    const preview = previewAgentText(retained.final_message);
    retained.final_message = preview.text; retained.omitted_chars = preview.omitted; retained.full_available = false;
  }
  const records = [...(ledger?.records ?? []).filter(r => !(r.run_id === retained.run_id && r.member_run_id === retained.member_run_id)), retained].slice(-AGENT_RESULT_LIMITS.records);
  let sizes = records.map(r => Buffer.byteLength(JSON.stringify(r)));
  let total = sizes.reduce((a, b) => a + b, 0);
  while (total > AGENT_RESULT_LIMITS.totalBytes && records.length) { total -= sizes.shift()!; records.shift(); }
  const next: AgentResultLedger = { schema_version: 1, records };
  freezeResultData(next); immutableLedgers.add(next);
  return next;
}
export function restoreAgentResults(value: unknown): AgentResultLedger {
  let ledger: AgentResultLedger = { schema_version: 1, records: [] };
  if (!value || typeof value !== 'object' || (value as AgentResultLedger).schema_version !== 1 || !Array.isArray((value as AgentResultLedger).records)) return ledger;
  const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
  const metric = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
  const strings = (v: unknown, count: number, max: number): v is string[] => Array.isArray(v) && v.length <= count && v.every(item => text(item, max));
  for (const raw of (value as AgentResultLedger).records.slice(-AGENT_RESULT_LIMITS.records)) {
    try {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as AgentResult;
      if (![r.agent_id, r.run_id, r.member_run_id].every(v => text(v, 256) && v.length > 0) || !(r.task_id === null || text(r.task_id, 256)) || !(r.pi_session_id === null || text(r.pi_session_id, 256))) continue;
      if (!['done', 'failed', 'cancelled'].includes(r.state) || !(r.stop_reason === null || text(r.stop_reason, 128)) || !(r.model === null || text(r.model, 512))) continue;
      if (!(r.final_message === null || text(r.final_message, AGENT_RESULT_LIMITS.fullBytes)) || !Number.isSafeInteger(r.final_message_chars) || r.final_message_chars < 0 || !Number.isSafeInteger(r.omitted_chars) || r.omitted_chars < 0 || typeof r.full_available !== 'boolean') continue;
      if (r.final_message === null) { if (r.full_available || r.final_message_chars !== 0 || r.omitted_chars !== 0) continue; }
      else {
        if (Buffer.byteLength(r.final_message) > AGENT_RESULT_LIMITS.fullBytes) continue;
        if (r.full_available) { if (r.omitted_chars !== 0 || r.final_message.length !== r.final_message_chars) continue; }
        else {
          const marker = `\n[${r.omitted_chars} characters omitted]\n`;
          if (r.omitted_chars <= 0 || r.final_message_chars - r.omitted_chars + marker.length !== r.final_message.length || !r.final_message.includes(marker)) continue;
        }
      }
      if (!strings(r.files_changed, 256, 4096) || !(r.files_outside_allowed === null || strings(r.files_outside_allowed, 256, 4096)) || !strings(r.evidence_reasons, 32, 512)) continue;
      if (!r.tokens || ![r.tokens.input, r.tokens.output, r.tokens.cache_read, r.tokens.cache_write, r.context_percent, r.elapsed_seconds].every(metric)) continue;
      if (!r.validation || !['not_requested', 'valid', 'invalid_json', 'schema_mismatch', 'unavailable', 'limit_exceeded'].includes(r.validation.status) || !strings(r.validation.errors, 4, 512)) continue;
      if (typeof r.result_available !== 'boolean' || r.result_omitted !== false || (r.result_available && r.validation.status !== 'valid')) continue;
      const checkedResult = r.result_available ? JSON.parse(boundedJson(r.result, AGENT_RESULT_LIMITS.dataNodes, AGENT_RESULT_LIMITS.dataDepth)) : null;
      // Build an allowlist, never spread persisted fields (locators/cwd and unknown
      // keys are deliberately excluded). Restored tool evidence is never complete.
      const normalized: AgentResult = {
        agent_id: r.agent_id, task_id: r.task_id, run_id: r.run_id, member_run_id: r.member_run_id, pi_session_id: r.pi_session_id,
        state: r.state, stop_reason: r.stop_reason, model: r.model, final_message: r.final_message, final_message_chars: r.final_message_chars,
        full_available: r.full_available, omitted_chars: r.omitted_chars, files_changed: [...r.files_changed], files_outside_allowed: r.files_outside_allowed === null ? null : [...r.files_outside_allowed],
        evidence_complete: false, evidence_reasons: [...r.evidence_reasons.slice(0, 31), 'Historical stored observations; not independently verified.'],
        tokens: { input: r.tokens.input, output: r.tokens.output, cache_read: r.tokens.cache_read, cache_write: r.tokens.cache_write }, context_percent: r.context_percent, elapsed_seconds: r.elapsed_seconds,
        validation: { status: r.validation.status, errors: [...r.validation.errors] }, result: checkedResult, result_available: r.result_available, result_omitted: false,
        historical: true, notice: 'unavailable',
      };
      ledger = retainAgentResult(ledger, normalized);
    } catch { /* Malformed historical records are discarded, never replayed. */ }
  }
  return ledger;
}
export function lookupAgentResult(ledger: AgentResultLedger | undefined, selector: AgentResultSelector): AgentResultLookup {
  if (typeof selector.id !== 'string' || !selector.id || (selector.runId !== undefined && typeof selector.runId !== 'string') || (selector.memberRunId !== undefined && typeof selector.memberRunId !== 'string') || (selector.full !== undefined && typeof selector.full !== 'boolean')) throw new Error('Invalid result selector.');
  const matches = (ledger?.records ?? []).filter(r => r.agent_id === selector.id && (selector.runId === undefined || r.run_id === selector.runId) && (selector.memberRunId === undefined || r.member_run_id === selector.memberRunId));
  if (!matches.length) return { status: 'unavailable', reason: 'No retained native result (not captured, evicted, external adapter, or unknown selector). Full text unavailable.' };
  if (matches.length > 1) return { status: 'ambiguous', selectors: matches.map(r => ({ id: r.agent_id, runId: r.run_id, memberRunId: r.member_run_id })) };
  if (selector.full && !matches[0].full_available) return { status: 'unavailable', reason: 'Exact full text unavailable: retention ceiling exceeded or no new text captured.' };
  return { status: 'found', result: projectAgentResult(matches[0], selector.full) };
}
export function lookupAgentResults(ledger: AgentResultLedger | undefined, ids: string[], selector: Omit<AgentResultSelector, 'id'> = {}): AgentResultLookup[] {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > AGENT_RESULT_LIMITS.batch) throw new Error('Results batch requires 1..32 ids; split larger requests.');
  const results = ids.map(id => lookupAgentResult(ledger, { ...selector, id }));
  if (Buffer.byteLength(JSON.stringify(results)) > AGENT_RESULT_LIMITS.responseBytes - 4096) throw new Error('Results response exceeds 1 MiB; request fewer ids/previews or singular agents.result full:true. No results returned.');
  return results;
}
export function createWriteEvidence(cwd: string, policy: string[] | undefined) {
  const pending = new Map<string, string>();
  const changed = new Set<string>();
  const reasons = new Set<string>();
  // Public events identify names, not tool implementation provenance. Report
  // observations, never an independently verified filesystem diff.
  reasons.add('Tool-event evidence only; custom/extension/external writes may be unobservable.');
  return {
    event(event: { type?: string; [key: string]: unknown }) {
      const id = typeof event.toolCallId === 'string' ? event.toolCallId : '';
      if (event.type === 'tool_execution_start') {
        if (event.toolName !== 'write' && event.toolName !== 'edit') { reasons.add('Bash/MCP/other tools are not attributed.'); return; }
        const path = (event.args as { path?: unknown } | undefined)?.path;
        if (!id || typeof path !== 'string' || path.length > 4096 || pending.size >= 256) { reasons.add('Missing/overflowed write tool arguments.'); return; }
        pending.set(id, path);
      } else if (event.type === 'tool_execution_end') {
        const path = pending.get(id); if (path === undefined) return;
        pending.delete(id);
        if (event.isError !== false) { reasons.add('Failed/partial tool writes are unknown.'); return; }
        if (changed.size >= 256) { reasons.add('Observed path budget exceeded.'); return; }
        changed.add(relative(cwd, resolve(cwd, path)).split(sep).join('/') || '.');
      }
    },
    snapshot() {
      const files = [...changed].sort();
      const outside = policy === undefined ? null : files.filter(path => path === '..' || path.startsWith('../') || !policy.some(pattern => matchesGlob(path, pattern)));
      const evidence = [...reasons]; if (pending.size) evidence.push('Unsettled write tools may have partial writes.');
      return { files_changed: files, files_outside_allowed: outside, evidence_complete: false, evidence_reasons: evidence };
    },
  };
}
