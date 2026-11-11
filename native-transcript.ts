import { readNativeHistory } from './native-history.js';
import { normalizeCustomType } from './legacy-names.js';
import type { ClankersNativeSessionReference } from './types.js';

export type NativeTranscriptKey = Pick<ClankersNativeSessionReference, 'parentRunId' | 'memberRunId' | 'piSessionId'>;
export type NativeTranscriptBlock = {
  id: string; entryId?: string; kind: 'text' | 'thinking' | 'tool' | 'event'; role?: string;
  text: string; toolCallId?: string; parentToolCallId?: string; toolName?: string;
  argumentsText?: string; resultText?: string; status?: string;
};
export type NativeTranscriptBranch = { leafId: string; label: string };
export type NativeTranscriptSnapshot = {
  key: NativeTranscriptKey; revision: number; source: 'live' | 'saved' | 'captured' | 'unavailable';
  status: 'running' | 'settled' | 'closed' | 'unavailable'; diagnostic?: string;
  defaultLeafBasis: 'live' | 'recorded-tip'; inspectedLeafId?: string | null; liveLeafId?: string | null;
  branches: NativeTranscriptBranch[]; blocks: NativeTranscriptBlock[]; truncated: boolean; droppedBlocks: number;
};
export type NativeTranscriptReadHandle = {
  getSnapshot(selection?: { leafId?: string | null }): NativeTranscriptSnapshot;
  subscribe(listener: () => void): () => void; dispose(): void;
};
/** Runner-only public SDK read facade. Never exposed by a viewer handle. */
export type NativeTranscriptReadFacade = {
  subscribe(listener: (event: any) => void): () => void;
  getMessages(): unknown; getEntryCount(): number; getEntries(): unknown[]; getLeafId(): string | null;
};
export type NativeTranscriptService = ReturnType<typeof createNativeTranscriptService>;

const LIMIT = { bytes: 8 * 1024 * 1024, line: 256 * 1024, entries: 10000, blocks: 200,
  text: 32 * 1024, collector: 256 * 1024, owners: 32, tools: 64, listeners: 64 } as const;
type Entry = { id: string; parentId: string | null; blocks: NativeTranscriptBlock[] };
type Data = { entries: Entry[]; leaf: string | null; extra: NativeTranscriptBlock[]; truncated: boolean; dropped: number };
const record = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const keyOf = (key: NativeTranscriptKey) => JSON.stringify([key.parentRunId, key.memberRunId, key.piSessionId]);
const copyKey = (key: NativeTranscriptKey): NativeTranscriptKey => ({ parentRunId: key.parentRunId, memberRunId: key.memberRunId, piSessionId: key.piSessionId });
const ignoreFault = (fn: () => void) => { try { fn(); } catch { /* Observation must never affect execution. */ } };

/** Terminal-safe transcript text; preserves indentation and newlines, not escape payloads. */
export function sanitizeNativeTranscriptText(value: string): string {
  return value.replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b[P_X^]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replace(/\t/g, '    ');
}
function text(value: unknown, limit = LIMIT.text): string {
  return typeof value === 'string' ? sanitizeNativeTranscriptText(value.slice(0, limit)) + (value.length > limit ? '\n[truncated]' : '') : '';
}
function boundedArguments(value: unknown): string {
  let work = 0;
  const visit = (item: unknown, depth: number): unknown => {
    if (++work > 256 || depth > 6) return '[omitted]';
    if (typeof item === 'string') return text(item, 1024);
    if (item === null || typeof item === 'boolean' || typeof item === 'number') return item;
    if (Array.isArray(item)) return item.slice(0, 32).map((child) => visit(child, depth + 1));
    if (record(item)) return Object.fromEntries(Object.keys(item).slice(0, 32).map((key) => [text(key, 128),
      /signature|^data$/i.test(key) ? '[opaque payload omitted]' : visit(item[key], depth + 1)]));
    return '[omitted]';
  };
  return text(JSON.stringify(visit(value, 0)));
}
function contentText(value: unknown): string {
  if (typeof value === 'string') return text(value);
  if (!Array.isArray(value)) return '';
  return text(value.slice(0, LIMIT.blocks).map((part) => !record(part) ? '[unsupported content]' :
    part.type === 'text' ? text(part.text) : part.type === 'image' ? '[image omitted]' : '[opaque content omitted]').join('\n'));
}
function messageBlocks(message: unknown, id: string, entryId?: string): NativeTranscriptBlock[] {
  if (!record(message)) return [{ id, entryId, kind: 'event', text: '[unsupported message]' }];
  const role = text(message.role, 128);
  if (role === 'toolResult') return [{ id: `tool:${text(message.toolCallId, 256)}`, entryId, kind: 'tool', role,
    toolCallId: text(message.toolCallId, 256), toolName: text(message.toolName, 256), text: '',
    resultText: contentText(message.content), status: message.isError ? 'error' : 'done' }];
  if (!['user', 'assistant', 'system', 'custom'].includes(role)) return [{ id, entryId, kind: 'event', role, text: `[${role || 'unknown'} message omitted]` }];
  if (typeof message.content === 'string') return [{ id, entryId, kind: 'text', role, text: text(message.content) }];
  if (!Array.isArray(message.content)) return [{ id, entryId, kind: 'event', role, text: '[message metadata only]' }];
  return message.content.slice(0, LIMIT.blocks).map((part: unknown, index: number): NativeTranscriptBlock => {
    const base = { id: `${id}:${index}`, entryId, role };
    if (!record(part)) return { ...base, kind: 'event', text: '[unsupported content]' };
    if (part.type === 'text') return { ...base, kind: 'text', text: text(part.text) };
    if (part.type === 'thinking') return { ...base, kind: 'thinking', text: part.redacted ? '[redacted thinking; signature omitted]' : text(part.thinking) || '[thinking signature omitted]' };
    if (part.type === 'toolCall') return { ...base, id: `tool:${text(part.id, 256)}`, kind: 'tool', toolCallId: text(part.id, 256),
      toolName: text(part.name, 256), argumentsText: boundedArguments(part.arguments), text: '', status: 'pending' };
    return { ...base, kind: 'event', text: part.type === 'image' ? '[image omitted]' : '[opaque content omitted]' };
  });
}
function entryBlocks(entry: Record<string, any>): NativeTranscriptBlock[] {
  if (entry.type === 'message') return messageBlocks(entry.message, entry.id, entry.id);
  if (entry.type === 'custom_message' && normalizeCustomType(entry.customType) === 'pi-clankers/operator/v1') {
    // Whitelist content only. Details, signatures and opaque custom payloads
    // remain omitted, including in validated saved history.
    return messageBlocks({ role: 'custom', content: entry.content }, entry.id, entry.id);
  }
  const base: NativeTranscriptBlock = { id: entry.id, entryId: entry.id, kind: 'event', text: '' };
  if (entry.type === 'compaction') base.text = `Compaction (raw history; not effective model context)\n${text(entry.summary)}`;
  else if (entry.type === 'context_edit') base.text = `Context edit of ${text(entry.targetId, 256)} (raw entry unchanged; replacement omitted)`;
  else if (entry.type === 'branch_summary') base.text = `Branch summary\n${text(entry.summary)}`;
  else if (entry.type === 'custom_message') base.text = `Custom message (payload omitted)`;
  else base.text = `${text(entry.type, 128)} metadata${entry.type === 'session_info' ? `: ${text(entry.name, 256)}` : ''}`;
  return [base];
}
function normalize(entries: unknown[], leaf: string | null): Data {
  let bytes = 0, blocks = 0, dropped = 0, truncated = false;
  const result: Entry[] = [];
  // Reserve half the aggregate budget for streaming and nested tool cards.
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!record(entry) || typeof entry.id !== 'string') continue;
    if (result.length >= LIMIT.blocks || bytes + 1024 >= LIMIT.collector / 2 || blocks >= LIMIT.blocks - 1) {
      dropped += i + 1; truncated = true; break;
    }
    const projected = entryBlocks(entry), retained: NativeTranscriptBlock[] = [];
    for (const block of projected) {
      const cost = JSON.stringify(block).length * 2;
      if (blocks >= LIMIT.blocks - 1 || bytes + cost + 1024 > LIMIT.collector / 2) { dropped++; truncated = true; continue; }
      bytes += cost; blocks++; retained.push(block);
      if ([block.text, block.resultText, block.argumentsText].some((value) => value?.includes('[truncated]'))) truncated = true;
    }
    if (!retained.length) { retained.push({ id: `${entry.id}:limit`, entryId: entry.id, kind: 'event', text: '[entry content omitted by limits]' }); blocks++; bytes += 512; }
    bytes += 1024;
    result.push({ id: text(entry.id, 256), parentId: typeof entry.parentId === 'string' ? text(entry.parentId, 256) : null, blocks: retained });
    if (Array.isArray(entry.message?.content) && entry.message.content.length > LIMIT.blocks) { truncated = true; dropped += entry.message.content.length - LIMIT.blocks; }
  }
  return { entries: result.reverse(), leaf, extra: [], truncated, dropped };
}
function project(data: Data, selection: string | null | undefined) {
  const byId = new Map(data.entries.map((entry) => [entry.id, entry]));
  const parents = new Set(data.entries.map((entry) => entry.parentId));
  const branches = data.entries.filter((entry) => !parents.has(entry.id)).map((entry) => ({ leafId: entry.id, label: `${entry.id} — ${entry.blocks[0]?.role ?? entry.blocks[0]?.kind ?? 'entry'}` }));
  const leaf = selection === undefined ? data.leaf : selection;
  if (leaf !== null && !byId.has(leaf ?? '')) return { branches, blocks: [], leaf, diagnostic: 'Selected entry unavailable or outside retained history' };
  const path: Entry[] = [];
  let next = leaf; let steps = 0;
  while (next && steps++ < LIMIT.entries) { const entry = byId.get(next); if (!entry) break; path.push(entry); next = entry.parentId; }
  const raw = path.reverse().flatMap((entry) => entry.blocks).concat(selection === undefined ? data.extra : []);
  // A final result and live event replace the same call card, never duplicate it.
  const blocks: NativeTranscriptBlock[] = [], tools = new Map<string, NativeTranscriptBlock>();
  for (const block of raw) {
    if (block.kind === 'tool' && block.toolCallId) {
      const existing = tools.get(block.toolCallId);
      if (existing) Object.assign(existing, block, { argumentsText: block.argumentsText ?? existing.argumentsText, parentToolCallId: block.parentToolCallId ?? existing.parentToolCallId });
      else { const copy = { ...block }; tools.set(block.toolCallId, copy); blocks.push(copy); }
    } else blocks.push({ ...block });
  }
  return { branches, blocks: blocks.slice(-LIMIT.blocks), leaf, diagnostic: next ? 'Earlier history omitted by retention limits' : undefined };
}
function unavailable(key: NativeTranscriptKey, diagnostic: string): NativeTranscriptSnapshot {
  return { key: copyKey(key), revision: 0, source: 'unavailable', status: 'unavailable', diagnostic,
    defaultLeafBasis: 'recorded-tip', branches: [], blocks: [], truncated: false, droppedBlocks: 0 };
}

function inertHandle(snapshot: NativeTranscriptReadHandle['getSnapshot']): NativeTranscriptReadHandle {
  return { getSnapshot: snapshot, subscribe: () => () => undefined, dispose() {} };
}
export function createNativeTranscriptService(options: { getReferences: () => ClankersNativeSessionReference[]; agentDir?: string }) {
  type Collector = { snapshot(selection?: { leafId?: string | null }): NativeTranscriptSnapshot; listeners: Set<() => void>; release(): void };
  const collectors = new Map<string, Collector>();
  const handles = new Set<() => void>();
  let stopped = false, loads = 0;
  const list = (parentRunId?: string): ClankersNativeSessionReference[] => {
    try { return options.getReferences().filter((ref) => !parentRunId || ref.parentRunId === parentRunId).map((ref) => ({ ...ref })); }
    catch { return []; }
  };
  function handle(snapshot: Collector['snapshot'], listeners = new Set<() => void>(), signal?: AbortSignal): NativeTranscriptReadHandle {
    if (stopped || signal?.aborted || handles.size >= LIMIT.owners) {
      const key = snapshot().key, diagnostic = stopped || signal?.aborted ? 'Viewer closed or load aborted' : 'Viewer handle limit reached';
      return inertHandle(() => unavailable(key, diagnostic));
    }
    let disposed = false; const owned = new Set<() => void>();
    const dispose = () => { if (disposed) return; disposed = true; snapshot = () => unavailable({ parentRunId: '', memberRunId: '', piSessionId: '' }, 'Viewer handle disposed'); for (const fn of owned) listeners.delete(fn); owned.clear(); handles.delete(dispose); signal?.removeEventListener('abort', dispose); };
    handles.add(dispose); signal?.addEventListener('abort', dispose, { once: true });
    if (signal?.aborted) dispose();
    return {
      getSnapshot(selection) { return snapshot(selection); },
      subscribe(listener) {
        if (disposed || listeners.size >= LIMIT.listeners) return () => undefined;
        const safe = () => ignoreFault(listener); owned.add(safe); listeners.add(safe);
        return () => { owned.delete(safe); listeners.delete(safe); };
      }, dispose,
    };
  }
  function register(ref: ClankersNativeSessionReference, facade: NativeTranscriptReadFacade): () => void {
    if (stopped || collectors.size >= LIMIT.owners) return () => undefined;
    const key = copyKey(ref), identity = keyOf(key);
    collectors.get(identity)?.release();
    let data: Data = { entries: [], leaf: null, extra: [], truncated: false, dropped: 0 };
    let active = true, revision = 0, status: NativeTranscriptSnapshot['status'] = 'running', diagnostic: string | undefined;
    let reader: NativeTranscriptReadFacade | undefined = facade, unsubscribe: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined, pending = false, generation = 0, epoch = 0;
    let stream: NativeTranscriptBlock[] = [], finishedGeneration: number | undefined;
    const tools = new Map<string, NativeTranscriptBlock>();
    // Positive admission is bounded to current calls, not all retired call IDs.
    const currentCalls = new Set<string>(), scopeCalls = new Set<string>();
    let callScope: string | undefined;
    const admitCalls = (blocks: NativeTranscriptBlock[], scope: string) => {
      if (scope !== callScope) { currentCalls.clear(); scopeCalls.clear(); callScope = scope; }
      for (const block of blocks) {
        const id = block.toolCallId;
        if (!id || block.kind !== 'tool') continue;
        if (block.resultText !== undefined || tools.get(id)?.status === 'done' || tools.get(id)?.status === 'error') currentCalls.delete(id);
        else if (block.role === 'assistant' && !scopeCalls.has(id) && scopeCalls.size < LIMIT.tools) { scopeCalls.add(id); currentCalls.add(id); }
      }
    };
    const refreshCalls = () => {
      // Walk only the already bounded current branch, never arbitrary SDK history.
      const byId = new Map(data.entries.map((entry) => [entry.id, entry]));
      const results = new Set<string>();
      let next = data.leaf, steps = 0;
      while (next && steps++ < LIMIT.blocks) {
        const entry = byId.get(next); if (!entry) break;
        for (const block of entry.blocks) if (block.toolCallId && block.resultText !== undefined) results.add(block.toolCallId);
        if (entry.blocks.some((block) => block.role === 'assistant')) {
          admitCalls(entry.blocks, entry.id);
          for (const id of results) currentCalls.delete(id);
          return;
        }
        next = entry.parentId;
      }
      currentCalls.clear(); scopeCalls.clear(); callScope = undefined;
    };
    const listeners = new Set<() => void>();
    const notify = () => {
      revision++;
      if (!timer && active) timer = setTimeout(() => { timer = undefined; if (active) for (const fn of listeners) ignoreFault(fn); }, 33);
    };
    const reconcile = () => {
      if (!active || !reader) return;
      try {
        const count = reader.getEntryCount();
        if (!Number.isSafeInteger(count) || count > LIMIT.entries || count < 0) { diagnostic = 'Live history exceeds entry limit'; data.truncated = true; return; }
        data = normalize(reader.getEntries(), reader.getLeafId());
        for (const entry of data.entries) for (const block of entry.blocks) {
          const live = block.toolCallId ? tools.get(block.toolCallId) : undefined;
          if (live && block.kind === 'tool') { block.parentToolCallId = live.parentToolCallId; if (block.resultText !== undefined) tools.delete(block.toolCallId!); }
        }
        refreshCalls();
        if (finishedGeneration === generation) stream = [];
        else if (stream.some((block) => block.role === 'assistant')) admitCalls(stream, `stream:${generation}`);
        finishedGeneration = undefined;
        data.extra = boundExtra([...tools.values(), ...stream], data, tools);
      } catch { diagnostic = 'Live observer read failed'; }
    };
    const job = () => {
      if (pending) return; pending = true; const token = epoch;
      queueMicrotask(() => { pending = false; if (!active || token !== epoch) return; ignoreFault(() => { reconcile(); notify(); }); });
    };
    const collector: Collector = {
      listeners,
      snapshot(selection) {
        const view = project(data, selection?.leafId);
        return { key: copyKey(key), revision, source: active ? 'live' : 'captured', status, diagnostic: diagnostic ?? view.diagnostic,
          defaultLeafBasis: 'live', inspectedLeafId: view.leaf, liveLeafId: data.leaf,
          branches: view.branches, blocks: view.blocks, truncated: data.truncated, droppedBlocks: data.dropped };
      },
      release() {
        if (!active) return;
        ignoreFault(reconcile); active = false; epoch++; if (status !== 'settled') status = 'unavailable'; diagnostic = [diagnostic, 'Live observation detached; captured output is not a persistence claim'].filter(Boolean).join('; ');
        if (timer) clearTimeout(timer); timer = undefined;
        ignoreFault(() => unsubscribe?.()); unsubscribe = undefined; reader = undefined;
        tools.clear(); currentCalls.clear(); scopeCalls.clear(); stream = [];
        if (collectors.get(identity) === collector) collectors.delete(identity);
        for (const fn of listeners) ignoreFault(fn); listeners.clear();
      },
    };
    collectors.set(identity, collector);
    try {
      reconcile();
      // SDK emits message_end before its synchronous append: reconcile after dispatch.
      unsubscribe = reader.subscribe((event: unknown) => ignoreFault(() => {
        if (!active || !record(event)) return;
        if (event.type === 'agent_settled') status = 'settled';
        if (event.type === 'agent_start') status = 'running';
        if (event.type === 'message_update' || event.type === 'message_start' || event.type === 'message_end') {
          const partial = record(event.assistantMessageEvent) ? event.assistantMessageEvent.partial : undefined;
          const message = event.message ?? partial;
          if (event.type === 'message_start') generation++;
          stream = messageBlocks(message, `stream:${generation}`);
          if (record(message) && message.role === 'assistant') admitCalls(stream, `stream:${generation}`);
          else if (event.type === 'message_start') { currentCalls.clear(); scopeCalls.clear(); callScope = undefined; }
          if (event.type === 'message_end') finishedGeneration = generation;
          data.extra = boundExtra([...tools.values(), ...stream], data, tools);
          // Retain only the bounded projection, not the unbounded incoming partial.
          stream = data.extra.filter((block) => !tools.has(block.toolCallId ?? ''));
          if (event.type === 'message_end') job();
        }
        if (typeof event.type === 'string' && event.type.startsWith('tool_execution_')) {
          const id = text(event.toolCallId, 256);
          if (!id || !['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(event.type)) return;
          // Retained persisted results remain authoritative, including redaction.
          if (data.entries.some((entry) => entry.blocks.some((block) => block.kind === 'tool' && block.toolCallId === id && block.resultText !== undefined))) return;
          const old = tools.get(id);
          if (old?.status === 'done' || old?.status === 'error') return;
          const parent = text(event.parentToolCallId, 256);
          const nestedStart = event.type === 'tool_execution_start' && tools.get(parent)?.status === 'running';
          // Unknown updates/end are valid only for proven current pending calls
          // (late attachment). Delayed retired callbacks cannot recreate a card.
          if (!old && !currentCalls.has(id) && !nestedStart) return;
          if (event.type === 'tool_execution_end') currentCalls.delete(id);
          if (tools.size < LIMIT.tools || tools.has(id)) {
            tools.set(id, { ...old, id: `tool:${id}`, kind: 'tool', toolCallId: id, parentToolCallId: text(event.parentToolCallId, 256) || old?.parentToolCallId,
              toolName: text(event.toolName, 256), text: '', argumentsText: event.args ? boundedArguments(event.args) : old?.argumentsText,
              resultText: contentText((event.result ?? event.partialResult)?.content) || old?.resultText,
              status: event.type === 'tool_execution_end' ? event.isError ? 'error' : 'done' : 'running' });
            // Bounded active-tool memory; completed cards live in finalized entries.
            // Keep each tool card small enough for the fixed 64-card budget.
            const card = tools.get(id)!;
            for (const field of ['argumentsText', 'resultText'] as const) {
              const value = card[field];
              if (value !== undefined && value.length > 256) { card[field] = text(value, 256); data.truncated = true; }
            }
            while (JSON.stringify([...tools.values()]).length * 2 > LIMIT.collector / 4) { tools.delete(tools.keys().next().value!); data.truncated = true; data.dropped++; }
            data.extra = boundExtra([...tools.values(), ...stream], data, tools);
            if (event.type === 'tool_execution_end') job();
          } else { data.truncated = true; data.dropped++; }
        }
        if (['entry_appended', 'compaction_end', 'agent_settled'].includes(event.type)) job();
        notify();
      }));
    } catch { diagnostic = 'Live observer subscription failed'; collector.release(); }
    return collector.release;
  }
  return {
    list, register,
    async open(key: NativeTranscriptKey, openOptions: { signal?: AbortSignal } = {}): Promise<NativeTranscriptReadHandle> {
      const signal = openOptions.signal;
      if (stopped || signal?.aborted) return inertHandle(() => unavailable(key, 'Viewer closed or load aborted'));
      if (handles.size >= LIMIT.owners) return inertHandle(() => unavailable(key, 'Viewer handle limit reached'));
      const ref = list().find((item) => keyOf(item) === keyOf(key));
      if (!ref) return handle(() => unavailable(key, 'Exact native session reference not found'), undefined, signal);
      const collector = collectors.get(keyOf(key));
      if (collector) return handle(collector.snapshot, collector.listeners, signal);
      if (loads >= 2) return handle(() => unavailable(key, 'Saved history load limit reached'), undefined, signal);
      // Reserve a real viewer slot synchronously before the asynchronous read.
      // Abort/shutdown dispose this same handle; completion never allocates another.
      let savedSnapshot: Collector['snapshot'] = () => unavailable(key, 'Saved history loading');
      const view = handle((selection) => savedSnapshot(selection), undefined, signal);
      loads++;
      try {
        const data = await readSaved(ref, options.agentDir, signal);
        if (stopped || signal?.aborted || !list().some((item) => keyOf(item) === keyOf(key) && item.sessionFile === ref.sessionFile)) throw new Error('Load aborted or reference changed');
        savedSnapshot = (selection) => {
          const view = project(data, selection?.leafId);
          return { key: copyKey(key), revision: 0, source: 'saved', status: ref.attachment === 'disposed' ? 'closed' : 'unavailable', defaultLeafBasis: 'recorded-tip',
            inspectedLeafId: view.leaf, liveLeafId: null, branches: view.branches, blocks: view.blocks,
            diagnostic: [ref.attachment !== 'disposed' ? 'History only; no live observer connected (closure not confirmed)' : '', view.diagnostic ?? '', data.truncated ? 'Saved history truncated by display limits' : ''].filter(Boolean).join('; ') || undefined, truncated: data.truncated, droppedBlocks: data.dropped };
        };
      } catch (error) { savedSnapshot = () => unavailable(key, error instanceof Error ? error.message : 'Saved history unavailable'); }
      finally { loads--; }
      return view;
    },
    shutdown() { if (stopped) return; stopped = true; for (const collector of [...collectors.values()]) collector.release(); for (const dispose of [...handles]) dispose(); },
  };
}

async function readSaved(ref: ClankersNativeSessionReference, agentDir?: string, signal?: AbortSignal): Promise<Data> {
  const history = await readNativeHistory(ref, { agentDir, signal });
  return normalize(history.entries, history.entries.at(-1)?.id ?? null);
}

function boundExtra(blocks: NativeTranscriptBlock[], data: Data, tools: Map<string, NativeTranscriptBlock>): NativeTranscriptBlock[] {
  let bytes = (JSON.stringify(data.entries).length + JSON.stringify([...tools.values()]).length) * 2;
  const result: NativeTranscriptBlock[] = [];
  for (const block of blocks) {
    if ([block.text, block.resultText, block.argumentsText].some((value) => value?.includes('[truncated]'))) data.truncated = true;
    const cost = JSON.stringify(block).length * 2;
    if (bytes + cost > LIMIT.collector || result.length + data.entries.reduce((n, entry) => n + entry.blocks.length, 0) >= LIMIT.blocks) { data.truncated = true; data.dropped++; break; }
    bytes += cost; result.push(block);
  }
  return result;
}
