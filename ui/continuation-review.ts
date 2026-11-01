import { CURSOR_MARKER, Editor, getKeybindings, matchesKey, Text, truncateToWidth, type Focusable, type TUI } from '@earendil-works/pi-tui';
import type { NativeContinuationPrepare, NativeContinuationReview, NativeContinuationService } from '../native-continuation.js';
import type { NativeTranscriptKey } from '../native-transcript.js';
import type { StructuralPiCustomComponent, StructuralPiTuiHandle } from '../types.js';
import { styleText, type UiThemeLike } from './components.js';

export interface ContinuationSource {
  key: NativeTranscriptKey;
  entryId: string;
  unconfirmed: boolean;
}
export interface ContinuationReviewOptions {
  source: ContinuationSource;
  service: NativeContinuationService;
  /** Checks the originally displayed source, never selects a new one. */
  isCurrent(): boolean;
  close(): void;
}
const MAX_BODY = 16384;
const MAX_MODEL = 512;
const MAX_POLICY = 65536;
const MAX_DOCUMENT = 128 * 1024;
const MAX_LINES = 8192;
const MAX_EDITOR_INPUTS = 1024;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const UNSAFE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;
const normalize = (text: string) => text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
const copyKey = (key: NativeTranscriptKey): NativeTranscriptKey => ({ parentRunId: key.parentRunId, memberRunId: key.memberRunId, piSessionId: key.piSessionId });
const sameKey = (a: NativeTranscriptKey, b: NativeTranscriptKey) => a.parentRunId === b.parentRunId && a.memberRunId === b.memberRunId && a.piSessionId === b.piSessionId;
/** Render control bytes visibly, not as executable terminal sequences or silent omissions. */
function safe(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
function errorText(error: unknown): string {
  try { return safe(error instanceof Error ? error.message.slice(0, 512) : typeof error === 'string' ? error.slice(0, 512) : 'Unknown error').replace(/\n/g, ' '); }
  catch { return 'Unprintable error'; }
}
/** Reject excessive/non-JSON disclosure rather than confirming a silently clipped policy. */
function policyJson(value: unknown): string {
  let nodes = 0;
  let bytes = 0;
  const seen = new Set<object>();
  const visit = (item: unknown, depth: number): unknown => {
    if (++nodes > 4096 || depth > 16) throw new Error('Policy disclosure exceeds UI bounds; confirmation disabled.');
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string') {
      bytes += item.length;
      if (bytes > MAX_POLICY) throw new Error('Policy disclosure exceeds UI bounds; confirmation disabled.');
      return item;
    }
    if (!item || typeof item !== 'object' || seen.has(item)) throw new Error('Policy disclosure is not bounded JSON; confirmation disabled.');
    seen.add(item);
    let result: unknown;
    if (Array.isArray(item)) result = item.map((child) => visit(child, depth + 1));
    else {
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== Object.prototype && prototype !== null) throw new Error('Unsupported policy disclosure.');
      result = Object.fromEntries(Object.keys(item).map((key) => { bytes += key.length; if (bytes > MAX_POLICY) throw new Error('Policy disclosure exceeds UI bounds.'); return [key, visit((item as Record<string, unknown>)[key], depth + 1)]; }));
    }
    seen.delete(item);
    return result;
  };
  const result = JSON.stringify(visit(value, 0), null, 2);
  if (result.length > MAX_POLICY) throw new Error('Policy disclosure exceeds UI bounds; confirmation disabled.');
  return result;
}

/** A new-task authorization flow; this owns no runner, session, or cancellation signal. */
export class ZergContinuationReviewComponent implements StructuralPiCustomComponent, Focusable {
  private disposed = false;
  private phase: 'edit' | 'review' | 'starting' | 'result' = 'edit';
  private field: 'body' | 'model' = 'body';
  private body: Editor;
  private model: Editor;
  private _focused = false;
  private layoutAvailable = false;
  private generation = 0;
  private preparing = false;
  private acknowledged = false;
  private sourceInvalid = false;
  private review?: NativeContinuationReview;
  private policy = '';
  private message = '';
  private scroll = 0;
  private viewport = 1;
  private displayLimited = false;
  private renderedReview?: string;
  private result?: { runId: string; taskId: string };
  private editorInputs = { body: 0, model: 0 };
  private paste?: { text: string; tail: string; rejected: boolean };
  private readonly source: ContinuationSource;

  constructor(private readonly tui: StructuralPiTuiHandle | undefined, private readonly theme: UiThemeLike | undefined, private readonly options: ContinuationReviewOptions) {
    this.source = { key: copyKey(options.source.key), entryId: options.source.entryId, unconfirmed: options.source.unconfirmed };
    this.body = this.createEditor();
    this.model = this.createEditor();
  }
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.updateFocus(); }
  invalidate(): void { this.body.invalidate(); this.model.invalidate(); }
  /** Source/ref publications invalidate review immediately, even before another redraw. */
  sourceChanged(): void {
    if (this.disposed || this.sourceInvalid || this.phase === 'starting' || this.phase === 'result' || this.current()) return;
    this.sourceInvalid = true;
    this.edit('Source changed; review invalidated. Escape and reopen the exact displayed source.');
    this.redraw();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.discardReview();
    this.paste = undefined;
    this.body.focused = false;
    this.model.focused = false;
    // A submitted start is task-owned. UI cleanup never aborts or retries it.
  }
  render(width = 100, requestedHeight?: number): string[] {
    const w = Math.max(1, Math.min(512, Math.floor(width) || 1));
    const h = Math.max(1, Math.min(128, Math.floor(requestedHeight ?? (this.tui?.terminal?.rows ?? 32) * 0.82) || 1));
    this.layoutAvailable = w >= 12 && h >= 10;
    this.updateFocus();
    this.sourceChanged();
    const document = this.document();
    const lines: string[] = [];
    const clean = safe(document.slice(0, MAX_DOCUMENT));
    this.displayLimited = document.length > MAX_DOCUMENT || clean.length > MAX_DOCUMENT;
    for (const part of clean.slice(0, MAX_DOCUMENT).split('\n')) {
      if (lines.length >= MAX_LINES) { this.displayLimited = true; break; }
      const wrapped = new Text(part || ' ', 0, 0).render(w);
      const available = MAX_LINES - lines.length;
      if (wrapped.length > available) this.displayLimited = true;
      lines.push(...wrapped.slice(0, available));
    }
    const editorRows = this.phase === 'edit' && this.layoutAvailable ? Math.min(6, Math.max(1, h - 7)) : 0;
    this.viewport = Math.max(1, h - 4 - editorRows);
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, lines.length - this.viewport)));
    const output = [styleText(this.theme, 'accent', `clankers NEW continuation · ${this.phase}`),
      safe(this.message || (this.preparing ? 'Preparing review only; no new task started.' : this.phase === 'review' ? 'Review current authority; Ctrl+y explicitly authorizes a NEW task.' : this.phase === 'edit' ? 'Pi editing: CR/CRLF become LF; tabs become four spaces. Enter prepares review, never execution.' : 'Original session unchanged; no process/workspace restoration.')).replace(/\n/g, ' '),
      `Disclosure lines ${this.scroll + 1}-${Math.min(lines.length, this.scroll + this.viewport)} of ${lines.length}${this.displayLimited ? ' · UI display truncated; confirmation disabled' : ' · PgUp/PgDn/Home/End to inspect'}`,
      ...lines.slice(this.scroll, this.scroll + this.viewport)];
    if (editorRows) {
      const editor = this.field === 'body' ? this.body : this.model;
      const rendered = editor.render(w);
      const cursor = rendered.findIndex((line) => line.includes(CURSOR_MARKER));
      const start = Math.max(0, Math.min(rendered.length - editorRows, cursor < 0 ? 0 : cursor - editorRows + 1));
      output.push(...rendered.slice(start, start + editorRows));
    }
    const footer = this.phase === 'edit' ? `${this.field} · Enter/Ctrl+s REVIEW · Alt+Enter newline · Alt+m body/model · Alt+a acknowledge · Esc back`
      : this.phase === 'review' ? 'Ctrl+y authorize NEW task · e edit (invalidates review) · Enter does not start · Esc back'
      : this.phase === 'starting' ? 'Starting NEW task · Esc back does not cancel task'
      : 'Esc back to original viewer · new task remains task-owned';
    // Always reserve the final row, including narrow/small terminal layouts.
    const frame = [...output.slice(0, Math.max(0, h - 1)), styleText(this.theme, 'dim', footer)]
      .map((line) => truncateToWidth(line, w, '', true));
    this.renderedReview = this.phase === 'review' && this.layoutAvailable && !this.displayLimited ? this.review?.reviewId : undefined;
    return frame;
  }
  handleInput(data: string): void {
    if (this.disposed) return;
    if (this.paste) { this.pasteInput(data); this.redraw(); return; }
    const pasteStart = data.indexOf(PASTE_START);
    if (pasteStart >= 0) {
      if (this.phase === 'starting' || this.phase === 'result') return;
      if (this.phase === 'review') this.edit();
      this.paste = { text: '', tail: '', rejected: pasteStart !== 0 };
      this.pasteInput(data.slice(pasteStart + PASTE_START.length));
      this.redraw(); return;
    }
    if (matchesKey(data, 'escape')) { this.dispose(); this.options.close(); return; }
    this.sourceChanged();
    if (this.phase === 'starting' || this.phase === 'result') {
      if (matchesKey(data, 'pageUp') || matchesKey(data, 'up')) this.scroll = Math.max(0, this.scroll - (matchesKey(data, 'pageUp') ? this.viewport : 1));
      else if (matchesKey(data, 'pageDown') || matchesKey(data, 'down')) this.scroll += matchesKey(data, 'pageDown') ? this.viewport : 1;
      else if (matchesKey(data, 'home')) this.scroll = 0;
      else if (matchesKey(data, 'end')) this.scroll = MAX_LINES;
      this.redraw(); return;
    }
    if (!this.layoutAvailable) { this.message = 'Resize terminal (at least 12 columns / 10 rows); confirmation disabled.'; this.redraw(); return; }
    if (matchesKey(data, 'pageUp')) this.scroll = Math.max(0, this.scroll - this.viewport);
    else if (matchesKey(data, 'pageDown')) this.scroll += this.viewport;
    else if (this.phase === 'review') {
      if (matchesKey(data, 'home')) this.scroll = 0;
      else if (matchesKey(data, 'end')) this.scroll = MAX_LINES;
      else if (matchesKey(data, 'up')) this.scroll = Math.max(0, this.scroll - 1);
      else if (matchesKey(data, 'down')) this.scroll += 1;
      else if (data === 'e') this.edit();
      else if (matchesKey(data, 'ctrl+y')) void this.start();
      // Neither Enter nor pasted/control-looking suffixes can confirm.
    } else if (matchesKey(data, 'ctrl+s') || matchesKey(data, 'enter')) void this.prepare();
    else if (matchesKey(data, 'alt+m')) { this.field = this.field === 'body' ? 'model' : 'body'; this.updateFocus(); }
    else if (matchesKey(data, 'alt+a')) { this.acknowledged = !this.acknowledged; this.edit(); }
    else if (getKeybindings().matches(data, 'tui.input.newLine')) this.change('\n', true);
    else this.change(data);
    this.redraw();
  }
  private createEditor(text = ''): Editor {
    const owner = this;
    const tui = { terminal: { get rows() { return Math.max(10, Math.min(128, owner.tui?.terminal?.rows ?? 32)); } }, requestRender: () => this.redraw() } as TUI;
    const color = (token: string) => (value: string) => styleText(this.theme, token, value);
    const editor = new Editor(tui, { borderColor: color('accent'), selectList: { selectedPrefix: color('accent'), selectedText: color('accent'), description: color('muted'), scrollInfo: color('dim'), noMatch: color('warning') } });
    editor.disableSubmit = true;
    editor.setText(text);
    return editor;
  }
  private updateFocus(): void {
    this.body.focused = this._focused && this.layoutAvailable && this.phase === 'edit' && this.field === 'body';
    this.model.focused = this._focused && this.layoutAvailable && this.phase === 'edit' && this.field === 'model';
  }
  private current(): boolean { try { return !this.sourceInvalid && this.options.isCurrent(); } catch { return false; } }
  private redraw(): void { if (!this.disposed) { try { this.tui?.requestRender?.(); } catch { this.message = 'Continuation redraw unavailable.'; } } }
  private discard(id: string): void { try { this.options.service.discard({ reviewId: id }); } catch { this.message = 'Review discard failed; no automatic retry. Token is locally invalidated.'; } }
  private discardReview(): void { const id = this.review?.reviewId; this.review = undefined; this.renderedReview = undefined; if (id) this.discard(id); }
  private edit(message = ''): void {
    this.generation += 1;
    this.message = message;
    this.discardReview();
    this.phase = 'edit';
    this.policy = '';
    this.scroll = 0;
    this.updateFocus();
  }
  private change(input: string, insert = false): void {
    const field = this.field;
    let editor = field === 'body' ? this.body : this.model;
    const previous = editor.getExpandedText();
    const limit = field === 'body' ? MAX_BODY : MAX_MODEL;
    if (input.length > limit) { this.message = 'Draft input rejected: size limit; draft retained.'; return; }
    const navigation = ['tui.editor.cursorUp', 'tui.editor.cursorDown', 'tui.editor.cursorLeft', 'tui.editor.cursorRight', 'tui.editor.cursorWordLeft', 'tui.editor.cursorWordRight', 'tui.editor.cursorLineStart', 'tui.editor.cursorLineEnd', 'tui.editor.pageUp', 'tui.editor.pageDown'] as const;
    const navigating = !insert && navigation.some((action) => getKeybindings().matches(input, action));
    let checkpoint = '';
    try {
      // Count non-navigation inputs per editor, including no-op edits that may push undo snapshots.
      if (!navigating && this.editorInputs[field] >= MAX_EDITOR_INPUTS) {
        const cursor = editor.getCursor();
        const lines = editor.getLines();
        if (cursor.line !== lines.length - 1 || cursor.col !== lines.at(-1)!.length) {
          this.message = `Editing history limit: move cursor to ${field} end before further edits; draft and cursor retained.`;
          return;
        }
        // A new public Editor releases its predecessor's unbounded undo stack. setText alone does not.
        editor.focused = false;
        editor = this.createEditor(previous);
        if (field === 'body') this.body = editor; else this.model = editor;
        this.editorInputs[field] = 0;
        this.updateFocus();
        checkpoint = `${field} undo checkpoint: earlier undo history cleared; draft retained at its existing end.`;
      }
      if (!navigating) this.editorInputs[field] += 1;
      if (insert) editor.insertTextAtCursor(input); else editor.handleInput(input);
      const text = editor.getExpandedText();
      if (text.length > limit || UNSAFE.test(text) || field === 'model' && /[\n\r\t]/.test(text)) {
        const restored = this.createEditor(previous);
        if (field === 'body') this.body = restored; else this.model = restored;
        this.editorInputs[field] = 0;
        this.updateFocus();
        this.message = 'Draft input rejected: size or control sequences; draft retained.';
        return;
      }
      if (text !== previous) this.edit(checkpoint);
      else if (checkpoint) this.message = checkpoint;
    } catch (error) { this.message = `Draft editor failed: ${errorText(error)}; no automatic submit.`; }
  }
  private pasteInput(data: string): void {
    const paste = this.paste!;
    const combined = paste.tail + data;
    const end = combined.indexOf(PASTE_END);
    const content = end < 0 ? combined.slice(0, Math.max(0, combined.length - PASTE_END.length + 1)) : combined.slice(0, end);
    paste.tail = end < 0 ? combined.slice(content.length) : '';
    const limit = this.field === 'body' ? MAX_BODY : MAX_MODEL;
    if (!paste.rejected) {
      if (paste.text.length + content.length > limit || UNSAFE.test(content)) { paste.rejected = true; paste.text = ''; }
      else paste.text += content;
    }
    if (end < 0) return;
    this.paste = undefined;
    // Entire packet is admitted atomically; suffix is literal text, never another key event.
    const value = normalize(paste.text + combined.slice(end + PASTE_END.length));
    const existing = (this.field === 'body' ? this.body : this.model).getExpandedText();
    if (paste.rejected || value.length + existing.length > limit || UNSAFE.test(value) || this.field === 'model' && /\n/.test(value)) {
      this.message = 'Paste rejected: whole packet discarded; draft retained; no shortcut executed.'; return;
    }
    this.change(value, true);
  }
  private async prepare(): Promise<void> {
    if (this.preparing || this.paste || !this.current()) { this.message = 'Review unavailable: source changed or review pending; no fallback.'; return; }
    const body = this.body.getExpandedText();
    const model = this.model.getExpandedText();
    if (!body.trim() || body.length > MAX_BODY || UNSAFE.test(body) || model.length > MAX_MODEL || /[\s\x00-\x1f\x7f-\x9f]/.test(model)) { this.message = 'Review requires a nonblank safe task and optional model identifier; literal task retained.'; return; }
    if (this.source.unconfirmed && !this.acknowledged) { this.message = 'Alt+a explicitly acknowledges unconfirmed source closure; source-copy only, not reconnect.'; return; }
    this.edit();
    const generation = this.generation;
    const request: NativeContinuationPrepare = { ...copyKey(this.source.key), entryId: this.source.entryId, body,
      ...(model ? { model } : {}), ...(this.acknowledged ? { acknowledgeUnconfirmedSource: true } : {}) };
    this.preparing = true;
    this.message = 'Preparing review only; no new task started.';
    this.redraw();
    let candidate: NativeContinuationReview | undefined;
    try {
      if (this.disposed || generation !== this.generation || !this.current()) return;
      candidate = await this.options.service.prepare(request);
      if (this.disposed || generation !== this.generation || !this.current()) { if (typeof candidate?.reviewId === 'string') this.discard(candidate.reviewId); return; }
      if (!candidate || !candidate.key || !sameKey(candidate.key, this.source.key) || candidate.entryId !== request.entryId || candidate.body !== body
        || typeof candidate.reviewId !== 'string' || !candidate.reviewId || candidate.reviewId.length > 256
        || typeof candidate.expiresAt !== 'string' || !Number.isFinite(Date.parse(candidate.expiresAt)) || Date.parse(candidate.expiresAt) <= Date.now()
        || typeof candidate.sourceFingerprint !== 'string' || !candidate.sourceFingerprint || candidate.sourceFingerprint.length > 256
        || typeof candidate.policyDigest !== 'string' || !candidate.policyDigest || candidate.policyDigest.length > 256
        || !Array.isArray(candidate.warnings) || candidate.warnings.length > 64 || candidate.warnings.some((warning) => typeof warning !== 'string' || warning.length > 4096)) throw new Error('Invalid exact continuation review; confirmation disabled.');
      const policy = policyJson(candidate.policy);
      // Do not retain mutable backend objects or substitute an edited request on confirmation.
      this.review = { reviewId: candidate.reviewId, expiresAt: candidate.expiresAt, key: copyKey(candidate.key), entryId: candidate.entryId, body: candidate.body,
        sourceFingerprint: candidate.sourceFingerprint, policyDigest: candidate.policyDigest, policy: JSON.parse(policy), warnings: [...candidate.warnings] };
      this.policy = policy;
      this.phase = 'review';
      this.renderedReview = undefined;
      this.scroll = 0;
      this.message = 'Review only. Ctrl+y is NEW authorization; Enter never starts.';
      this.updateFocus();
    } catch (error) {
      if (candidate && typeof candidate.reviewId === 'string') this.discard(candidate.reviewId);
      if (!this.disposed && generation === this.generation) this.message = `Review failed: ${errorText(error)}; draft retained; no automatic retry.`;
    } finally { this.preparing = false; if (!this.disposed) this.redraw(); }
  }
  private async start(): Promise<void> {
    const review = this.review;
    if (!review || this.phase !== 'review' || this.renderedReview !== review.reviewId || this.displayLimited || !this.current()) { this.message = 'Confirm disabled: review must be displayed, complete and exact; no fallback.'; return; }
    if (Date.parse(review.expiresAt) <= Date.now()) { this.edit('Review expired; prepare a new review before authorization.'); return; }
    const generation = this.generation;
    const reviewId = review.reviewId;
    this.review = undefined; // Locally consumed before any callback/reentrant publication.
    this.renderedReview = undefined;
    this.phase = 'starting';
    this.message = 'Starting NEW task; outcome pending. Closing UI does not abort it.';
    this.updateFocus();
    this.redraw();
    try {
      // Redraw callbacks may dispose/change the source before submission; don't commit stale authorization.
      if (this.disposed || generation !== this.generation || !this.current()) {
        this.discard(reviewId);
        if (!this.disposed) { this.phase = 'result'; this.message = 'Start not submitted: source changed before authorization committed.'; }
        return;
      }
      const result = await this.options.service.start({ reviewId, confirm: true });
      if (this.disposed || generation !== this.generation) return;
      if (!result || typeof result.runId !== 'string' || !result.runId || result.runId.length > 256 || typeof result.taskId !== 'string' || !result.taskId || result.taskId.length > 256) throw new Error('Invalid destination result; outcome unknown.');
      this.result = { runId: result.runId, taskId: result.taskId };
      this.phase = 'result';
      this.scroll = 0;
      this.message = 'NEW task started; not a completion claim. Original viewer has not been retargeted.';
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.phase = 'result';
      this.message = `Start failed or outcome unknown: ${errorText(error)}. Review consumed; no automatic retry.`;
    } finally { if (!this.disposed && generation === this.generation) this.redraw(); }
  }
  private document(): string {
    const source = this.source;
    const header = `Source parent run: ${source.key.parentRunId}\nSource member run: ${source.key.memberRunId}\nSource Pi session: ${source.key.piSessionId}\nSelected entry (at): ${source.entryId}\nHistorical permissions are UNKNOWN. This requires NEW authorization under current policy.\nNew identities; no old queues/teams. Original transcript unchanged.\nNo workspace/process restoration, sibling wakeup, reconnect or old approval replay.\nNormal Pi resources/extensions/MCP remain enabled; hooks may transform prompts at startup/runtime.\nUnconfirmed source-copy acknowledgment: ${source.unconfirmed ? this.acknowledged ? 'YES (not proof of closure)' : 'REQUIRED: Alt+a' : 'not required'}\n`;
    if (this.phase === 'result') return header + (this.result ? `\nDestination run: ${this.result.runId}\nDestination task: ${this.result.taskId}\nTask-owned execution; closing viewer does not cancel it.` : '\nNo confirmed destination; inspect runs for outcome. No automatic retry.');
    if (this.review) return header + `\nReview: ${this.review.reviewId}\nExpires: ${this.review.expiresAt}\nSource fingerprint: ${this.review.sourceFingerprint}\nCurrent policy digest: ${this.review.policyDigest}\nCURRENT policy (definition, tools/denies, model, cwd, resources):\n${this.policy}\nWarnings:\n${this.review.warnings.join('\n')}\nLiteral NEW task body:\n${this.review.body}\n[End of task body]`;
    return header + `\nOptional model (provider/model[:thinking]): ${this.model.getExpandedText() || '(current source definition default; backend review resolves)'}\nPi editor normalizes CRLF/CR to LF and tabs to four spaces; no trim or command interpretation.\nUndo history is bounded per editor: after 1024 inputs, editing at the logical end checkpoints earlier undo history. Middle cursors stay put; move to the end explicitly to continue.\nEditing ${this.field}; task body is literal text.\nAlt+m switches body/model. Enter prepares REVIEW, never executes.`;
  }
}
