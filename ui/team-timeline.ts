import { Input, Text, truncateToWidth, type Focusable } from '@earendil-works/pi-tui';
import type { StructuralPiCommandContext, StructuralPiCustomComponent, StructuralPiTuiHandle, ZergSessionMessageKey, ZergTimelineEntry, ZergTimelineFilter, ZergTimelineSnapshot } from '../types.js';
import { sanitizeTranscriptText } from './agent-overlay.js';
import { styleText, type UiThemeLike } from './components.js';
import { matchesKey, printableInput } from './state.js';

export interface ZergTeamTimelineOptions {
  getSnapshot(filter: ZergTimelineFilter): ZergTimelineSnapshot;
  subscribe(listener: () => void): () => void;
  initialFilter?: ZergTimelineFilter;
  viewCoding?(key: ZergSessionMessageKey): Promise<void>;
}
interface TimelineViewState {
  filter: ZergTimelineFilter;
  selectedId?: string;
  follow: boolean;
  detail: boolean;
  detailScroll: number;
}
type TimelineProof = Pick<ZergTimelineEntry, 'id' | 'kind' | 'teamId' | 'parentRunId' | 'memberRunId' | 'piSessionId' | 'exactKey'> & { messageId?: string };
interface TimelineResult { key: ZergSessionMessageKey; state: TimelineViewState }
const FIELDS = ['teamId', 'parentRunId', 'memberRunId', 'piSessionId'] as const;
const MAX_ROWS = 256;
const MAX_TEXT = 256 * 1024;
const MAX_LINES = 512;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const safeId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f-\x9f]/u.test(value);
const stableId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f-\x9f]/u.test(value);
const sameKey = (a: ZergSessionMessageKey, b: ZergSessionMessageKey) => FIELDS.slice(1).every((field) => a[field as keyof ZergSessionMessageKey] === b[field as keyof ZergSessionMessageKey]);
function validKey(key: ZergSessionMessageKey | undefined): key is ZergSessionMessageKey {
  return Boolean(key && safeId(key.parentRunId) && safeId(key.memberRunId) && safeId(key.piSessionId));
}
function filterCopy(filter: ZergTimelineFilter): ZergTimelineFilter {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) throw new Error('Invalid timeline filter object.');
  for (const name of Object.keys(filter)) {
    if (![...FIELDS, 'limit'].includes(name) && (filter as Record<string, unknown>)[name] !== undefined) throw new Error('Unsupported timeline filter field.');
  }
  const copy: ZergTimelineFilter = {};
  for (const field of FIELDS) {
    if (filter[field] !== undefined) {
      if (!safeId(filter[field])) throw new Error(`Invalid exact ${field}: maximum 256 characters, no whitespace/control.`);
      copy[field] = filter[field];
    }
  }
  if (filter.limit !== undefined) {
    if (!Number.isSafeInteger(filter.limit) || filter.limit < 1 || filter.limit > MAX_ROWS) throw new Error('Invalid timeline limit (1..256).');
    copy.limit = filter.limit;
  }
  return copy;
}
const clean = (value: unknown, max = 1024) => typeof value === 'string' ? sanitizeTranscriptText(value.slice(0, Math.max(0, max))).slice(0, Math.max(0, max)) : '';
function errorText(error: unknown): string {
  try { return clean(error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown failure (non-text error).', 256).replace(/\n/g, ' '); }
  catch { return 'Unknown failure (unreadable error).'; }
}
function copyKey(key: ZergSessionMessageKey): ZergSessionMessageKey {
  return { parentRunId: key.parentRunId, memberRunId: key.memberRunId, piSessionId: key.piSessionId };
}
const oneLine = (value: unknown, max = 1024) => clean(value, max).replace(/\n/g, ' ');
function cleanup(callback?: () => void): void { try { callback?.(); } catch { /* Continue UI-only cleanup. */ } }
// Only a whole single key packet may invoke actions; never parse an unsafe suffix as a shortcut.
function keyPacket(data: string): boolean {
  return data.length <= 64 && (data === '\x1b' || /^[\x01\x05\x08\x09\x0a\x0b\x0d\x15\x17\x7f]$/.test(data)
    || /^\x1b\[[0-9;:]*[A-Za-z~]$/.test(data) || /^\x1bO[A-Za-z]$/.test(data)
    || !/[\x00-\x1f\x7f-\x9f]/u.test(data));
}
function label(entry: ZergTimelineEntry): string {
  switch (entry.kind) {
    case 'operator-receipt': return `operator receipt/current status: ${entry.status} · ${entry.persistence}`;
    case 'native-output': return 'native output/handoff: NOT addressed reply';
    case 'recorded-event': return 'recorded event';
    default: return `${entry.kind}: current snapshot, NOT historical event`;
  }
}

/** Abbreviations are display-only; keys and filters always retain untouched identities. */
function scanRow(entry: ZergTimelineEntry): string {
  const short = (value: string | undefined, max = 12) => value === undefined ? '?' : value.length <= max ? value : `${value.slice(0, 6)}…${value.slice(-5)}`;
  const actor = `${short(entry.agentDefinitionId)} r:${short(entry.parentRunId)} m:${short(entry.memberRunId)}`;
  const kind = entry.kind === 'operator-receipt' ? `receipt ${entry.status}/${entry.persistence}`
    : entry.kind === 'native-output' ? 'output NOT reply'
    : entry.kind === 'recorded-event' ? 'recorded event'
    : `${entry.kind === 'run-snapshot' ? 'run' : 'member'} current snapshot`;
  const content = oneLine(entry.bodyPreview || entry.summary, 160);
  return `${actor} [${kind}] ${content}${entry.clipped ? ' [preview clipped]' : ''} · ${entry.timestamp ?? 'UNKNOWN TIME'}`;
}

/** Each custom interaction is fresh; no timeline watcher survives the coding drilldown. */
export async function openZergTeamTimeline(context: StructuralPiCommandContext, options: ZergTeamTimelineOptions): Promise<void> {
  if (context.hasUI === false || (context.mode !== undefined && context.mode !== 'tui') || !context.ui?.custom) throw new Error('Timeline requires an interactive Pi TUI.');
  let state: TimelineViewState | undefined;
  let notice = '';
  while (true) {
    let component: ZergTeamTimelineComponent | undefined;
    let result: TimelineResult | undefined;
    try {
      await Promise.resolve(context.ui.custom((tui, theme, _keys, done) => {
        component = new ZergTeamTimelineComponent(tui, theme as UiThemeLike | undefined, (value) => { result = value; done?.(value); }, options, state, notice);
        return component;
      }, { overlay: true, overlayOptions: { title: 'clankers team timeline', anchor: 'center', width: '90%', maxHeight: '82%' } }));
    } finally { component?.dispose(); }
    if (!result || !options.viewCoding) return;
    state = result.state;
    notice = '';
    try { await options.viewCoding(copyKey(result.key)); }
    catch (error) { notice = `Exact coding viewer unavailable: ${errorText(error)}`; }
  }
}

/** Bounded read projection and plain view state only; never owns native lifetimes. */
export class ZergTeamTimelineComponent implements StructuralPiCustomComponent, Focusable {
  private disposed = false;
  private unsubscribe?: () => void;
  private dirty = true;
  private invalidFilter = false;
  private state: TimelineViewState;
  private entries: ZergTimelineEntry[] = [];
  private renderedSelected?: TimelineProof;
  private limitations: string[] = [];
  private counts = '';
  private notice = '';
  private observerNotice = '';
  private form?: Input[];
  private field = 0;
  private formEdits = 0;
  private rejectingPaste = false;
  private pasteTail = '';
  private viewport = 1;
  private _focused = false;
  private cache?: { width: number; id: string; lines: string[]; limited: boolean };

  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.form?.forEach((input, index) => { input.focused = value && index === this.field; }); }

  constructor(private readonly tui: StructuralPiTuiHandle | undefined, private readonly theme: UiThemeLike | undefined,
    private readonly done: ((result?: TimelineResult) => void) | undefined, private readonly options: ZergTeamTimelineOptions,
    restored?: TimelineViewState, notice = '') {
    this.state = restored ? { ...restored, filter: { ...restored.filter } } : { filter: {}, follow: true, detail: false, detailScroll: 0 };
    this.notice = notice;
    try { this.state.filter = filterCopy(restored?.filter ?? options.initialFilter ?? {}); }
    catch (error) { this.invalidFilter = true; this.state.follow = false; this.notice = errorText(error); }
    try {
      const unsubscribe = options.subscribe(() => { if (!this.disposed) { this.dirty = true; this.invalidate(); this.requestRender(); } });
      if (this.disposed) cleanup(unsubscribe); else this.unsubscribe = unsubscribe;
    } catch (error) { this.observerNotice = `Timeline observer unavailable: ${errorText(error)}`; }
  }

  invalidate(): void { this.cache = undefined; this.form?.forEach((input) => input.invalidate()); }
  private requestRender(): void { if (!this.disposed) { try { this.tui?.requestRender?.(); } catch { this.observerNotice = 'Timeline redraw unavailable.'; } } }
  private refresh(force = false): void {
    if ((!this.dirty && !force) || this.disposed || this.invalidFilter) return;
    this.dirty = false;
    this.invalidate();
    try {
      const snapshot = this.options.getSnapshot({ ...this.state.filter });
      if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.entries)) throw new Error('Invalid timeline snapshot.');
      const candidates = snapshot.entries.slice(-MAX_ROWS);
      const ids = new Set<string>();
      const duplicates = new Set<string>();
      for (const row of candidates) { if (ids.has(row.id)) duplicates.add(row.id); ids.add(row.id); }
      let remaining = MAX_TEXT;
      let rejected = 0;
      let clipped = snapshot.entries.length > MAX_ROWS;
      const text = (value: unknown, cap: number) => {
        const result = clean(value, Math.min(cap, remaining));
        if (typeof value === 'string' && value.length > Math.min(cap, remaining)) clipped = true;
        remaining = Math.max(0, remaining - result.length);
        return result;
      };
      this.entries = [];
      for (const row of candidates.slice().reverse()) {
        if (!stableId(row.id) || duplicates.has(row.id) || !['operator-receipt', 'native-output', 'recorded-event', 'run-snapshot', 'member-snapshot'].includes(row.kind)
          || FIELDS.some((field) => (row[field] !== undefined && !safeId(row[field])) || (this.state.filter[field] !== undefined && row[field] !== this.state.filter[field]))) { rejected++; continue; }
        const base = { id: row.id, kind: row.kind, timestamp: text(row.timestamp, 64) || undefined,
          timestampMeaning: ['created', 'recorded', 'current-update'].includes(row.timestampMeaning) ? row.timestampMeaning : 'recorded', summary: text(row.summary, 256), bodyPreview: text(row.bodyPreview, 1024), clipped: Boolean(row.clipped) };
        const entry = base as ZergTimelineEntry;
        for (const field of FIELDS) if (row[field] !== undefined) entry[field] = row[field];
        if (safeId(row.agentDefinitionId)) entry.agentDefinitionId = row.agentDefinitionId;
        if (validKey(row.exactKey) && row.parentRunId === row.exactKey.parentRunId && row.memberRunId === row.exactKey.memberRunId && row.piSessionId === row.exactKey.piSessionId) entry.exactKey = copyKey(row.exactKey);
        if (row.kind === 'operator-receipt') Object.assign(entry, { messageId: text(row.messageId, 256), mode: text(row.mode, 32), status: text(row.status, 64), persistence: text(row.persistence, 32), updatedAt: text(row.updatedAt, 64) });
        else if (row.kind === 'native-output' || row.kind === 'recorded-event') Object.assign(entry, { source: text(row.source, 32), sourceId: text(row.sourceId, 2048), ...('status' in row ? { status: text(row.status, 64) } : {}) });
        else Object.assign(entry, { status: text(row.status, 64), attachment: text(row.attachment, 64) });
        this.entries.push(entry);
      }
      this.entries.reverse();
      this.limitations = (Array.isArray(snapshot.limitations) ? snapshot.limitations.slice(0, 16) : []).map((value) => text(value, 512));
      const count = (value: number) => Number.isSafeInteger(value) && value >= 0 ? String(value) : 'unknown';
      this.counts = `${this.entries.length} retained · ${count(snapshot.omittedEntries)} omitted · ${count(snapshot.clippedEntries)} clipped${clipped ? ' · UI text/row bound' : ''}${rejected ? ` · ${rejected} invalid/duplicate rows withheld` : ''}`;
      if (this.state.selectedId && !this.entries.some((entry) => entry.id === this.state.selectedId)) {
        this.state.selectedId = undefined; this.state.follow = false; this.notice = 'Selected row missing/evicted; coding target cleared. End follows again.';
      } else if (this.state.follow) this.state.selectedId = this.entries.at(-1)?.id;
    } catch (error) {
      this.entries = []; this.state.selectedId = undefined; this.state.follow = false;
      this.counts = 'Projection unavailable; completeness unknown.';
      this.notice = `Timeline unavailable: ${errorText(error)}`;
    }
  }

  render(width = 100, requestedHeight?: number): string[] {
    if (this.disposed) return [];
    const w = Math.max(1, Math.min(512, Math.floor(width) || 1));
    const h = Math.max(1, Math.min(128, Math.floor(requestedHeight ?? (this.tui?.terminal?.rows ?? 32) * 0.82) || 1));
    try { return this.renderSafe(w, h); }
    catch (error) { this.invalidate(); this.renderedSelected = undefined; return [truncateToWidth(`Timeline render unavailable: ${errorText(error)}`, w, '', true)]; }
  }
  private renderSafe(w: number, h: number): string[] {
    this.refresh();
    const styled = (token: string, value: string) => styleText(this.theme, token, value);
    const title = styled('accent', `clankers team timeline · READ ONLY · ${this.state.follow ? 'follow tail' : 'scroll paused'}`);
    const scope = `Exact AND · ${FIELDS.map((field) => `${field}=${this.state.filter[field] ?? '*'}`).join(' · ')}`;
    const notices = [this.notice, this.observerNotice, ...this.limitations].filter(Boolean).join(' · ');
    const footer = this.form ? 'Tab/ShiftTab field · Enter apply exact AND (blank=all) · Esc cancel' : '↑↓/Home pause · End follow · Enter detail · PgUp/PgDn detail scroll · f filter · v exact coding · q/Esc close';
    const header = [title, oneLine(scope, 2048), oneLine(`${this.counts} · ${notices}`, 12000)];
    // Tiny terminals reserve one body row before notices/footer, so the retained tail is not hidden.
    const headerCount = Math.min(3, Math.max(0, h - 2));
    const footerCount = h >= 3 ? 1 : 0;
    const capacity = Math.max(1, h - headerCount - footerCount);
    this.viewport = capacity;
    let body: string[];
    let shown: ZergTimelineEntry[] | undefined;
    if (this.form) {
      this.focused = this._focused;
      const rows = this.form.map((input, index) => `${index === this.field ? '›' : ' '} ${FIELDS[index]}: ${input.render(Math.max(1, w - FIELDS[index]!.length - 5))[0] ?? ''}`);
      const offset = capacity < 4 ? this.field : 0;
      body = rows.slice(offset, offset + capacity);
    } else if (this.state.detail && this.selected()) {
      shown = [this.selected()!];
      const lines = this.detailLines(w);
      this.state.detailScroll = Math.max(0, Math.min(this.state.detailScroll, Math.max(0, lines.length - capacity)));
      body = lines.slice(this.state.detailScroll, this.state.detailScroll + capacity);
      if (this.cache?.limited) header[2] = oneLine(`UI detail truncated: text/line bound · ${this.counts} · ${notices}`, 12000);
    } else {
      const selected = this.entries.findIndex((entry) => entry.id === this.state.selectedId);
      const offset = this.state.follow ? Math.max(0, this.entries.length - capacity) : Math.max(0, Math.min(Math.max(0, this.entries.length - capacity), selected - Math.floor(capacity / 2)));
      shown = this.entries.slice(offset, offset + capacity);
      body = shown.map((entry) => `${entry.id === this.state.selectedId ? '›' : ' '} ${scanRow(entry)}`);
      if (!body.length) body = [this.invalidFilter ? 'Invalid initial filter; f to apply explicit valid scope.' : 'No matching timeline entries. No fallback.'];
    }
    const output = [...header.slice(0, headerCount), ...body, ...(footerCount ? [styled('dim', footer)] : [])].slice(0, h).map((line) => truncateToWidth(line, w, '', true));
    if (shown) {
      const entry = shown.find((row) => row.id === this.state.selectedId);
      this.renderedSelected = entry ? { id: entry.id, kind: entry.kind, teamId: entry.teamId, parentRunId: entry.parentRunId, memberRunId: entry.memberRunId, piSessionId: entry.piSessionId, exactKey: entry.exactKey ? copyKey(entry.exactKey) : undefined, messageId: entry.kind === 'operator-receipt' ? entry.messageId : undefined } : undefined;
    }
    return output;
  }
  private selected(): ZergTimelineEntry | undefined { return this.entries.find((entry) => entry.id === this.state.selectedId); }
  private detailLines(width: number): string[] {
    const entry = this.selected()!;
    if (this.cache?.width === width && this.cache.id === entry.id) return this.cache.lines;
    const values = [`row id: ${entry.id}`, `[${label(entry)}]`, ...FIELDS.map((field) => `${field}: ${entry[field] ?? 'unknown/unlinked'}`),
      `time: ${entry.timestamp ?? 'UNKNOWN TIME'} · basis: ${entry.timestampMeaning}`, `agent definition: ${entry.agentDefinitionId ?? 'unknown'}`,
      ...(entry.kind === 'operator-receipt' ? [`messageId: ${entry.messageId}`, `mode: ${entry.mode} · status: ${entry.status} · persistence: ${entry.persistence}`, `updatedAt: ${entry.updatedAt}`, 'delivered = native consumed, not acknowledgement/completion or associated reply'] : []),
      ...('status' in entry && entry.kind !== 'operator-receipt' ? [`status: ${entry.status}`] : []),
      ...('attachment' in entry ? [`attachment: ${entry.attachment || 'unknown'}`] : []),
      entry.exactKey ? 'v: proven exact coding key (revalidated before open)' : 'No proven exact coding key; drilldown unavailable.', entry.summary, entry.bodyPreview,
      entry.clipped ? 'Preview clipped; retained text only.' : '', ...FIELDS.map((field) => `filter ${field}: ${this.state.filter[field] ?? '* (all)'}`), ...this.limitations];
    const lines: string[] = [];
    let remaining = MAX_TEXT;
    let limited = false;
    const contentLimit = MAX_LINES - 1;
    for (const value of values) {
      const cap = Math.min(remaining, 8192);
      const text = clean(value, cap); remaining = Math.max(0, remaining - text.length);
      if (value.length > cap) limited = true;
      if (lines.length >= contentLimit || remaining <= 0) { limited = true; break; }
      // Bound each segment before public wrapping; no untrusted theme escapes retained in state.
      const parts = text.split('\n');
      for (const part of parts) {
        const wrapped = new Text(part || ' ', 0, 0).render(width);
        const available = contentLimit - lines.length;
        if (wrapped.length > available) limited = true;
        lines.push(...wrapped.slice(0, available));
        if (lines.length >= contentLimit) { limited = true; break; }
      }
    }
    if (limited) lines.push('UI detail truncated: text/line bound; some identity/body fields not displayed.');
    return (this.cache = { width, id: entry.id, lines, limited }).lines;
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    // Only complete, isolated literal identity paste is accepted inside the form.
    // Incomplete/mixed/unsafe packets are discarded across chunks, never shortcuts.
    if (this.rejectingPaste || data.includes(PASTE_START)) {
      const complete = !this.rejectingPaste && data.startsWith(PASTE_START) && data.endsWith(PASTE_END)
        && data.indexOf(PASTE_END) === data.length - PASTE_END.length;
      if (this.form && complete && data.length <= 256 + PASTE_START.length + PASTE_END.length) {
        const body = data.slice(PASTE_START.length, -PASTE_END.length);
        const input = this.form[this.field]!;
        const prior = input.getValue();
        if (safeId(body) && prior.length + body.length <= 256 && this.formEdits < 256) {
          try {
            // Public Input's paste path inserts literal words, never our legacy shortcuts.
            input.handleInput(data);
            if (!safeId(input.getValue())) throw new Error('Invalid pasted identity.');
            this.formEdits++; this.notice = 'Literal identity pasted; Enter applies exact filter.';
            this.requestRender(); return;
          } catch (error) { input.setValue(prior); input.handleInput('\x05'); this.notice = `Paste rejected: ${errorText(error)}`; this.requestRender(); return; }
        }
      }
      const end = (this.pasteTail + data).includes(PASTE_END);
      this.rejectingPaste = !end;
      this.pasteTail = end ? '' : data.slice(-PASTE_END.length + 1);
      this.notice = end ? 'Paste rejected; whole packet discarded, filter/selection retained.' : 'Incomplete paste rejected; waiting for end marker, filter/selection retained.';
      this.requestRender(); return;
    }
    if (!keyPacket(data) || data.includes(PASTE_END)) { this.notice = 'Invalid input packet rejected; no action taken.'; this.requestRender(); return; }
    if (this.form) { this.formInput(data); this.requestRender(); return; }
    if (matchesKey(data, 'escape') || data.toLowerCase() === 'q') { this.dispose(); return; }
    if (data.toLowerCase() === 'v') { this.drilldown(this.renderedSelected); this.requestRender(); return; }
    this.refresh();
    if (data.toLowerCase() === 'f') {
      this.form = FIELDS.map((field) => { const input = new Input(); input.setValue(this.state.filter[field] ?? ''); input.handleInput('\x05'); return input; });
      this.field = 0; this.formEdits = 0; this.focused = this._focused;
    } else if (matchesKey(data, 'enter')) { this.state.detail = !this.state.detail; this.state.detailScroll = 0; }
    else if (matchesKey(data, 'end')) { this.state.follow = true; this.state.selectedId = this.entries.at(-1)?.id; this.state.detailScroll = 0; }
    else if (matchesKey(data, 'pageup', 'pagedown') && this.state.detail) {
      this.state.follow = false; this.state.detailScroll = Math.max(0, this.state.detailScroll + (matchesKey(data, 'pageup') ? -this.viewport : this.viewport));
    } else if (matchesKey(data, 'home', 'up', 'down', 'pageup', 'pagedown')) {
      this.state.follow = false;
      const index = this.entries.findIndex((entry) => entry.id === this.state.selectedId);
      const step = matchesKey(data, 'pageup', 'pagedown') ? this.viewport : 1;
      const next = matchesKey(data, 'home') ? 0 : Math.max(0, Math.min(this.entries.length - 1, index + (matchesKey(data, 'up', 'pageup') ? -step : step)));
      this.state.selectedId = this.entries[next]?.id; this.state.detailScroll = 0;
    }
    this.requestRender();
  }
  private formInput(data: string): void {
    if (matchesKey(data, 'escape')) { this.form = undefined; return; }
    if (matchesKey(data, 'tab', 'shift-tab')) { this.field = (this.field + (matchesKey(data, 'shift-tab') ? 3 : 1)) % 4; this.focused = this._focused; return; }
    if (matchesKey(data, 'enter')) {
      try {
        const filter: ZergTimelineFilter = { limit: this.state.filter.limit };
        FIELDS.forEach((field, index) => { const value = this.form![index]!.getValue(); if (value) filter[field] = value; });
        const applied = filterCopy(filter);
        // Confirm projection accepts it before replacing the old explicit scope.
        this.options.getSnapshot({ ...applied });
        this.state = { filter: applied, follow: true, detail: false, detailScroll: 0 };
        this.form = undefined; this.renderedSelected = undefined; this.invalidFilter = false; this.dirty = true; this.notice = 'Exact AND filter applied; unknown IDs stay empty.';
      } catch (error) { this.notice = `Filter rejected: ${errorText(error)}`; }
      return;
    }
    const input = this.form![this.field]!;
    const prior = input.getValue();
    const navigation = matchesKey(data, 'left', 'right', 'home', 'end', 'backspace', 'delete') || ['\x01', '\x05', '\x15', '\x0b', '\x17'].includes(data);
    const printable = printableInput(data);
    const text = printable ?? data;
    if (!navigation && (!safeId(text) || prior.length + text.length > 256)) { this.notice = 'Filter input rejected: exact IDs <=256, no whitespace/control.'; return; }
    if (++this.formEdits > 256) {
      this.form![this.field] = new Input(); this.form![this.field]!.setValue(prior); this.form![this.field]!.handleInput('\x05'); this.formEdits = 0;
      this.notice = 'Filter edit history reset; cursor moved to end. Repeat edit explicitly.'; this.focused = this._focused; return;
    }
    try {
      const legacy: Record<string, string> = { backspace: '\x7f', delete: '\x1b[3~', left: '\x1b[D', right: '\x1b[C', home: '\x01', end: '\x05' };
      input.handleInput(legacy[data] ?? data);
      if (input.getValue() && !safeId(input.getValue())) { input.setValue(prior); this.notice = 'Invalid filter input rejected.'; }
    } catch (error) { input.setValue(prior); this.notice = `Filter editor unavailable: ${errorText(error)}`; }
  }
  private drilldown(prior: TimelineProof | undefined): void {
    if (prior && prior.id !== this.state.selectedId) { this.notice = 'Selection not yet redrawn; coding target unavailable until next frame.'; return; }
    if (!prior?.exactKey || !this.options.viewCoding) { this.notice = 'No proven exact coding target available.'; return; }
    const key = copyKey(prior.exactKey);
    this.state.follow = false;
    this.state.selectedId = prior.id;
    this.refresh(true);
    const current = this.selected();
    if (!current?.exactKey || current.id !== prior.id || current.kind !== prior.kind || !sameKey(current.exactKey, key)
      || FIELDS.some((field) => current[field] !== prior[field]) || (prior.kind === 'operator-receipt' && (current.kind !== 'operator-receipt' || current.messageId !== prior.messageId))) {
      this.state.selectedId = undefined; this.notice = 'Selected row changed/missing; coding target cleared.'; return;
    }
    this.finish({ key, state: { ...this.state, filter: { ...this.state.filter } } });
  }
  dispose(): void { this.finish(); }
  private finish(result?: TimelineResult): void {
    if (this.disposed) return;
    this.disposed = true; cleanup(this.unsubscribe); this.unsubscribe = undefined;
    this.form = undefined; this.entries = []; this.renderedSelected = undefined; this.cache = undefined;
    cleanup(() => this.done?.(result));
  }
}
