import { randomUUID } from 'node:crypto';
import { CURSOR_MARKER, Editor, getKeybindings, matchesKey as piMatchesKey, Text, stripTerminalSequences, truncateToWidth, type Focusable, type TUI } from '@earendil-works/pi-tui';
import type { NativeTranscriptKey, NativeTranscriptReadHandle, NativeTranscriptSnapshot } from '../native-transcript.js';
import type { NativeContinuationService } from '../native-continuation.js';
import type { StructuralPiCommandContext, StructuralPiCustomComponent, StructuralPiTuiHandle, ZergNativeSessionReference } from '../types.js';
import { styleText, uiErrorText, type UiThemeLike } from './components.js';
import { ZergContinuationReviewComponent, type ContinuationSource } from './continuation-review.js';
import { matchesKey } from './state.js';

export type ZergComposerMode = 'steer' | 'followUp';
export type ZergReceiptPersistence = 'memory' | 'saved' | 'failed';
export interface ZergComposerReceipt {
  messageId: string;
  key: NativeTranscriptKey;
  status: 'recorded' | 'queued' | 'delivered' | 'failed' | 'needs-attention';
  detail: string;
  createdAt: string;
  updatedAt: string;
  persistence: ZergReceiptPersistence;
}
export interface ZergComposerState {
  key: NativeTranscriptKey;
  canSend: boolean;
  reason?: string;
  allowedModes: ZergComposerMode[];
  persistence: ZergReceiptPersistence;
  receipts: ZergComposerReceipt[];
  droppedReceipts?: number;
}
export interface ZergOverlayComposer {
  getState(key: NativeTranscriptKey): ZergComposerState;
  subscribe(key: NativeTranscriptKey, listener: () => void): () => void;
  send(request: { key: NativeTranscriptKey; messageId: string; body: string; mode: ZergComposerMode }): Promise<{ ok: boolean; message: string; receipt?: ZergComposerReceipt }>;
}
export interface ZergAgentOverlayOptions {
  getReferences(): ZergNativeSessionReference[];
  subscribeReferences(listener: () => void): () => void;
  open(key: NativeTranscriptKey, options?: { signal?: AbortSignal }): Promise<NativeTranscriptReadHandle>;
  composer?: ZergOverlayComposer;
  nativeContinuationService?: NativeContinuationService;
  /** Explicit exact drilldown; never defaults to a chooser/leader if stale. */
  initialKey?: NativeTranscriptKey;
}

const MAX_CHOICES = 256;
const MAX_LINES = 2048;
const MAX_TEXT = 256 * 1024;
const MAX_FIELD = 32 * 1024;
const MAX_DRAFT = 16384;
const MAX_RECEIPTS = 8;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const UNSAFE_DRAFT = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;

function rowText(value: string): string { return sanitizeTranscriptText(value).replace(/\n/g, ' '); }
function normalizedDraft(value: string): string { return value.replace(/\r\n?/g, '\n').replace(/\t/g, '    '); }
/** Untrusted transcripts never supply terminal commands or hyperlinks. */
export function sanitizeTranscriptText(value: string): string {
  return stripTerminalSequences(value.slice(0, MAX_FIELD)
    .replace(/\r\n?/g, '\n')
    .replace(/(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b[PX^_]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, '')
    .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, ''))
    .replace(/\x1b[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
    .replace(/\t/g, '    ');
}

function validExactKey(key: NativeTranscriptKey): boolean {
  return Boolean(key && [key.parentRunId, key.memberRunId, key.piSessionId].every((value) => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f-\x9f]/u.test(value)));
}

function sameKey(a: NativeTranscriptKey, b: NativeTranscriptKey): boolean {
  return a.parentRunId === b.parentRunId && a.memberRunId === b.memberRunId && a.piSessionId === b.piSessionId;
}

function cleanup(callback?: () => void): void {
  try { callback?.(); } catch { /* Finish every viewer cleanup, even if a host observer fails. */ }
}

export async function openZergAgentOverlay(context: StructuralPiCommandContext, options: ZergAgentOverlayOptions): Promise<void> {
  if (context.hasUI === false || (context.mode !== undefined && context.mode !== 'tui') || !context.ui?.custom) {
    throw new Error('Coding viewer requires an interactive Pi TUI.');
  }
  let component: ZergAgentOverlayComponent | undefined;
  try {
    await Promise.resolve(context.ui.custom(
      (tui?: StructuralPiTuiHandle, theme?: unknown, _keys?: unknown, done?: () => void) => {
        component?.dispose();
        return component = new ZergAgentOverlayComponent(tui, theme as UiThemeLike | undefined, done, options);
      },
      { overlay: true, overlayOptions: { title: 'clankers coding', anchor: 'center', width: '90%', maxHeight: '82%' } },
    ));
  } finally { component?.dispose(); }
}

/** Owns observer UI and explicit composer callbacks, never a runner or SDK session. */
export class ZergAgentOverlayComponent implements StructuralPiCustomComponent, Focusable {
  private disposed = false;
  private mode: 'chooser' | 'transcript' | 'branches' = 'chooser';
  private references: ZergNativeSessionReference[] = [];
  private choice = 0;
  private branchChoice = 0;
  private key?: NativeTranscriptKey;
  private leafId?: string | null;
  private snapshot?: NativeTranscriptSnapshot;
  private handle?: NativeTranscriptReadHandle;
  private unsubscribeReferences?: () => void;
  private unsubscribeTranscript?: () => void;
  private unsubscribeComposer?: () => void;
  private abort?: AbortController;
  private generation = 0;
  private message = '';
  private referencesLimited = false;
  private loading = false;
  private follow = true;
  private scroll = 0;
  private viewport = 1;
  private cache?: { width: number; lines: string[]; limited: boolean };
  private editor?: Editor;
  private composing = false;
  private _focused = false;
  private composerState?: ZergComposerState;
  private composerError = '';
  private composerWatchError = '';
  private composerMessage = '';
  private composerMode: ZergComposerMode = 'followUp';
  private layoutAvailable = true;
  private sending = false;
  private attempt?: { key: NativeTranscriptKey; messageId: string; body: string; mode: ZergComposerMode };
  private editRevision = 0;
  private editorInputs = 0;
  private paste?: { text: string; tail: string; rejected: boolean };
  private continuation?: ZergContinuationReviewComponent;
  private displayedContinuation?: { source: ContinuationSource; proof: string };
  private displayedChoice?: { index: number; key: NativeTranscriptKey };
  get focused(): boolean { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    if (this.editor) this.editor.focused = value && this.composing && this.layoutAvailable && !this.continuation;
    if (this.continuation) this.continuation.focused = value;
  }

  constructor(
    private readonly tui: StructuralPiTuiHandle | undefined,
    private readonly theme: UiThemeLike | undefined,
    private readonly done: (() => void) | undefined,
    private readonly options: ZergAgentOverlayOptions,
  ) {
    this.refreshReferences();
    if (options.initialKey !== undefined) {
      this.mode = 'transcript';
      void this.openExact(options.initialKey, true);
    }
    try {
      this.unsubscribeReferences = options.subscribeReferences(() => {
        if (this.disposed) return;
        this.refreshReferences();
        this.requestRender();
      });
    } catch (error) { this.message = `Reference observer unavailable: ${uiErrorText(error)}`; }
  }

  invalidate(): void { this.cache = undefined; this.editor?.invalidate(); this.continuation?.invalidate(); }

  render(width = 100, requestedHeight?: number): string[] {
    const w = Math.max(1, Math.min(512, Math.floor(width) || 1));
    const h = Math.max(1, Math.min(128, Math.floor(requestedHeight ?? (this.tui?.terminal?.rows ?? 32) * 0.82) || 1));
    if (this.continuation) { this.continuation.focused = this._focused; return this.continuation.render(w, h); }
    this.layoutAvailable = w >= 12 && h >= 10;
    if (this.editor) this.editor.focused = this._focused && this.composing && this.layoutAvailable;
    // Capture only a transcript frame actually rendered, never a branch chooser or an unseen publication.
    this.displayedContinuation = this.mode === 'transcript' && !this.loading && !this.composing ? this.continuationSource() : undefined;
    const composerLines = this.mode === 'transcript' && this.options.composer ? this.renderComposer(w, h) : [];
    const layout = this.mode === 'transcript' ? this.formatted(w) : undefined;
    const notice = [
      this.message || (this.snapshot?.truncated ? `Transcript truncated · ${this.snapshot.droppedBlocks} dropped blocks` : ''),
      layout?.limited ? 'UI display truncated: text/line limit' : '',
    ].filter(Boolean).join(' · ');
    const bodyCapacity = Math.max(0, h - 3 - composerLines.length);
    this.viewport = Math.max(1, bodyCapacity - (notice ? 1 : 0));
    const title = styleText(this.theme, 'accent', this.options.composer ? 'clankers coding · raw history + explicit composer' : 'clankers coding · read-only raw history');
    const status = this.mode === 'chooser' ? `Exact session chooser (${this.references.length})${this.referencesLimited ? ' · list truncated' : ''}`
      : this.loading ? 'Loading exact session…'
      : this.snapshot ? `${this.snapshot.source} · ${this.snapshot.status} · ${this.snapshot.source === 'captured' ? 'detached capture (not connected or proven saved)' : this.leafId ? 'branch inspection' : this.snapshot.defaultLeafBasis === 'live' ? 'live leaf' : 'last recorded entry (not proven active leaf)'} · ${this.follow ? 'follow tail' : 'scroll paused'}`
      : 'unavailable';
    let body: string[];
    this.displayedChoice = undefined;
    if (this.mode === 'chooser') {
      const offset = Math.max(0, this.choice - Math.floor(this.viewport / 3));
      const ref = this.references[this.choice];
      if (ref && w >= 12 && this.choice - offset < bodyCapacity - (notice ? 1 : 0)) {
        this.displayedChoice = { index: this.choice, key: { parentRunId: ref.parentRunId, memberRunId: ref.memberRunId, piSessionId: ref.piSessionId } };
      }
      body = this.references.slice(offset, offset + this.viewport).map((ref, index) => {
        const short = (id: string) => id.length > 22 ? `${id.slice(0, 8)}…${id.slice(-12)}` : id;
        return `${offset + index === this.choice ? '›' : ' '} ${offset + index + 1} ${ref.agentDefinitionId} · member ${short(ref.memberRunId)} · run ${short(ref.parentRunId)} · Pi ${short(ref.piSessionId)} · ${ref.attachment}`;
      });
      if (!body.length) body.push('No native sessions available. No implicit leader selection.');
    } else if (this.mode === 'branches') {
      const branches = this.snapshot?.branches.slice(0, MAX_CHOICES) ?? [];
      const choices = ['Default: live leaf / last recorded entry', ...branches.map((branch) => `${branch.label} · ${branch.leafId}`)];
      const offset = Math.max(0, this.branchChoice - Math.floor(this.viewport / 2));
      body = choices.slice(offset, offset + this.viewport).map((label, index) => `${offset + index === this.branchChoice ? '›' : ' '} ${label}`);
    } else {
      const cache = layout!;
      const maxScroll = Math.max(0, cache.lines.length - this.viewport);
      this.scroll = this.follow ? maxScroll : Math.max(0, Math.min(this.scroll, maxScroll));
      body = cache.lines.slice(this.scroll, this.scroll + this.viewport);
    }
    if (this.mode !== 'transcript') body = body.map(rowText);
    if (notice) body = [rowText(notice), ...body];
    body = body.slice(0, bodyCapacity);
    const footer = this.mode === 'chooser' ? '↑↓ select · Enter inspect · q/Esc close'
      : this.mode === 'branches' ? '↑↓ select · Enter inspect locally · s sessions · q/Esc close'
      : this.composing ? 'Enter newline · Ctrl+s send · Alt+m mode · Esc back (draft retained)'
      : `${this.options.composer ? 'c compose · ' : ''}${this.options.nativeContinuationService ? 'n NEW continuation · ' : ''}s sessions · b branches · ↑↓/PgUp/PgDn/Home scroll · End follow · q/Esc close`;
    // Reserve composer/receipt/footer rows before transcript slicing; never lose its tail.
    return [title, rowText(status), ...body, ...composerLines, styleText(this.theme, 'dim', footer)]
      .slice(0, h).map((line) => truncateToWidth(line, w, '', true));
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (this.continuation) { this.continuation.handleInput(data); return; }
    if (this.composing) { this.handleComposerInput(data); this.requestRender(); return; }
    if (data.toLowerCase() === 'n') { this.openContinuation(); this.requestRender(); return; }
    if (matchesKey(data, 'escape') || data.toLowerCase() === 'q') { this.dispose(); return; }
    if (data.toLowerCase() === 's' && !(this.options.initialKey && !this.handle)) {
      const hadDraft = Boolean(this.editor?.getExpandedText());
      this.detach();
      this.mode = 'chooser';
      this.message = hadDraft ? 'Draft discarded when leaving the exact session.' : '';
      this.refreshReferences();
    } else if (data.toLowerCase() === 'b' && this.snapshot && this.mode !== 'chooser') {
      this.mode = 'branches';
      this.branchChoice = 0;
    } else if (this.mode === 'chooser') {
      if (matchesKey(data, 'up')) this.choice = Math.max(0, this.choice - 1);
      if (matchesKey(data, 'down')) this.choice = Math.min(Math.max(0, this.references.length - 1), this.choice + 1);
      if (matchesKey(data, 'enter')) void this.openSelected();
    } else if (this.mode === 'branches') {
      if (matchesKey(data, 'up')) this.branchChoice = Math.max(0, this.branchChoice - 1);
      if (matchesKey(data, 'down')) this.branchChoice = Math.min(Math.min(MAX_CHOICES, this.snapshot?.branches.length ?? 0), this.branchChoice + 1);
      if (matchesKey(data, 'enter')) {
        this.leafId = this.branchChoice === 0 ? undefined : this.snapshot?.branches[this.branchChoice - 1]?.leafId;
        this.mode = 'transcript';
        this.follow = !this.leafId && this.snapshot?.source === 'live';
        this.scroll = 0;
        this.readSnapshot();
      }
    } else {
      if (data.toLowerCase() === 'c' && this.options.composer) {
        this.readComposerState();
        const reason = this.composerDisabledReason(false);
        if (reason) this.composerMessage = `Composer disabled: ${reason}`;
        else { this.composing = true; this.editor ??= this.createEditor(); this.focused = this._focused; }
      } else if (matchesKey(data, 'end')) { this.follow = !this.leafId && this.snapshot?.source === 'live'; this.scroll = MAX_LINES; }
      else if (matchesKey(data, 'home')) { this.follow = false; this.scroll = 0; }
      else if (matchesKey(data, 'up', 'pageup')) { this.follow = false; this.scroll = Math.max(0, this.scroll - (matchesKey(data, 'pageup') ? this.viewport : 1)); }
      else if (matchesKey(data, 'down', 'pagedown')) { this.follow = false; this.scroll += matchesKey(data, 'pagedown') ? this.viewport : 1; }
    }
    this.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    cleanup(this.unsubscribeReferences);
    this.unsubscribeReferences = undefined;
    cleanup(this.done);
  }

  private continuationSource(snapshot = this.snapshot): { source: ContinuationSource; proof: string } | undefined {
    if (!this.key || !this.handle || !snapshot || !sameKey(snapshot.key, this.key) || snapshot.source === 'live' || snapshot.status === 'running') return;
    const entryId = snapshot.inspectedLeafId;
    if (!validExactKey(this.key) || typeof entryId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(entryId)) return;
    try {
      const refs = this.options.getReferences().filter((ref) => sameKey(ref, this.key!));
      const ref = refs[0];
      if (refs.length !== 1 || !ref || ref.attachment === 'attached') return;
      // Whitelist exact reference metadata and selection proof. Raw file fingerprinting belongs to prepare/start.
      const proof = JSON.stringify([this.key.parentRunId, this.key.memberRunId, this.key.piSessionId, this.leafId,
        snapshot.revision, snapshot.source, snapshot.status, entryId, ref.schemaVersion, ref.agentDefinitionId,
        ref.sessionFile, ref.cwd, ref.createdAt, ref.attachment, ref.disposedAt, ref.recoveredAt]);
      if (proof.length > 16384) return;
      return { source: { key: { parentRunId: this.key.parentRunId, memberRunId: this.key.memberRunId, piSessionId: this.key.piSessionId }, entryId,
        unconfirmed: ref.attachment === 'unavailable' }, proof };
    } catch { return; }
  }

  private continuationCurrent(proof: string): boolean {
    try {
      const snapshot = this.handle?.getSnapshot({ leafId: this.leafId });
      return Boolean(snapshot && this.continuationSource(snapshot)?.proof === proof);
    } catch { return false; }
  }

  private openContinuation(): void {
    const displayed = this.displayedContinuation;
    const service = this.options.nativeContinuationService;
    if (!service || this.mode !== 'transcript' || !displayed || !this.continuationCurrent(displayed.proof)) {
      this.message = 'NEW continuation disabled: display an exact non-live saved entry first; stale/live sources never retarget.';
      return;
    }
    this.continuation = new ZergContinuationReviewComponent(this.tui, this.theme, {
      source: displayed.source, service, isCurrent: () => !this.disposed && this.continuationCurrent(displayed.proof),
      close: () => {
        this.continuation = undefined;
        this.displayedContinuation = undefined;
        // Return to the same viewer, never to the destination or another source.
        if (!this.disposed) { this.readSnapshot(); this.focused = this._focused; this.requestRender(); }
      },
    });
    this.focused = this._focused;
  }

  private requestRender(): void {
    if (this.disposed) return;
    try { this.tui?.requestRender?.(); } catch { this.message = 'Viewer redraw unavailable.'; }
  }

  private refreshReferences(): void {
    const prior = this.references[this.choice];
    try {
      const refs = this.options.getReferences();
      this.referencesLimited = refs.length > MAX_CHOICES;
      this.references = refs.slice(0, MAX_CHOICES).map((ref) => ({ ...ref }));
      const retained = prior ? this.references.findIndex((ref) => sameKey(ref, prior)) : -1;
      this.choice = retained >= 0 ? retained : Math.min(this.choice, Math.max(0, this.references.length - 1));
      this.continuation?.sourceChanged();
      if (this.key && !refs.some((ref) => sameKey(ref, this.key!))) {
        this.detach();
        this.mode = this.options.initialKey ? 'transcript' : 'chooser';
        this.message = 'Selected reference is no longer available. Choose an exact session again.';
      }
    } catch (error) {
      this.references = [];
      if (this.key) { this.detach(); this.mode = this.options.initialKey ? 'transcript' : 'chooser'; }
      this.message = `References unavailable: ${uiErrorText(error)}`;
    }
  }

  private async openSelected(): Promise<void> {
    const displayed = this.displayedChoice;
    const current = this.references[this.choice];
    if (!displayed || displayed.index !== this.choice || !current || !sameKey(displayed.key, current)) {
      this.message = 'Selected reference is stale or not yet displayed; render and choose an exact session again. No fallback.';
      this.requestRender();
      return;
    }
    await this.openExact({ ...displayed.key });
  }

  private async openExact(requestedKey: NativeTranscriptKey, explicitInitial = false): Promise<void> {
    this.detach();
    this.mode = 'transcript';
    if (explicitInitial && !validExactKey(requestedKey)) { this.message = 'Invalid exact initial/session key; no fallback.'; this.requestRender(); return; }
    const generation = this.generation;
    const key: NativeTranscriptKey = { parentRunId: requestedKey.parentRunId, memberRunId: requestedKey.memberRunId, piSessionId: requestedKey.piSessionId };
    this.key = key;
    this.mode = 'transcript';
    this.loading = true;
    this.message = '';
    this.follow = true;
    this.scroll = 0;
    const abort = this.abort = new AbortController();
    let opened: NativeTranscriptReadHandle | undefined;
    try {
      if (this.options.getReferences().filter((current) => sameKey(current, key)).length !== 1) throw new Error('Selected reference is stale or ambiguous; no fallback.');
      opened = await this.options.open(key, { signal: abort.signal });
      if (this.disposed || generation !== this.generation || abort.signal.aborted) { cleanup(() => opened?.dispose()); return; }
      this.handle = opened;
      this.loading = false;
      this.readSnapshot();
      this.follow = this.snapshot?.source === 'live';
      const unsubscribe = opened.subscribe(() => {
        if (this.disposed || generation !== this.generation) return;
        this.readSnapshot();
        this.requestRender();
      });
      if (this.disposed || generation !== this.generation) cleanup(unsubscribe);
      else { this.unsubscribeTranscript = unsubscribe; this.watchComposer(key, generation); }
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.detach();
      this.mode = 'transcript';
      this.key = key;
      this.message = `Transcript unavailable: ${uiErrorText(error)}`;
    }
    this.requestRender();
  }

  private readSnapshot(): void {
    try {
      const snapshot = this.handle?.getSnapshot({ leafId: this.leafId });
      if (snapshot && this.key && !sameKey(snapshot.key, this.key)) throw new Error('Transcript identity mismatch.');
      this.snapshot = snapshot;
      if (snapshot?.source !== 'live') this.follow = false;
      this.message = '';
    } catch (error) { this.snapshot = undefined; this.message = `Transcript unavailable: ${uiErrorText(error)}`; }
    this.continuation?.sourceChanged();
    this.invalidate();
  }

  private detach(): void {
    this.generation += 1;
    this.continuation?.dispose();
    this.continuation = undefined;
    this.displayedContinuation = undefined;
    this.displayedChoice = undefined;
    this.abort?.abort();
    this.abort = undefined;
    cleanup(this.unsubscribeTranscript);
    this.unsubscribeTranscript = undefined;
    cleanup(this.unsubscribeComposer);
    this.unsubscribeComposer = undefined;
    this.composing = false;
    if (this.editor) this.editor.focused = false;
    this.editor = undefined;
    this.paste = undefined;
    this.composerState = undefined;
    this.composerError = '';
    this.composerWatchError = '';
    this.composerMessage = '';
    this.composerMode = 'followUp';
    this.sending = false;
    this.attempt = undefined;
    this.editRevision += 1;
    this.editorInputs = 0;
    const handle = this.handle;
    this.handle = undefined;
    cleanup(() => handle?.dispose());
    this.snapshot = undefined;
    this.key = undefined;
    this.leafId = undefined;
    this.loading = false;
    this.invalidate();
  }

  private createEditor(text = ''): Editor {
    // Minimal public Editor geometry/redraw adapter; not a terminal renderer.
    const owner = this;
    const editorTui = {
      terminal: { get rows() { return Math.max(10, Math.min(128, owner.tui?.terminal?.rows ?? 32)); } },
      requestRender: () => this.requestRender(),
    } as TUI;
    const color = (token: string) => (value: string) => styleText(this.theme, token, value);
    const editor = new Editor(editorTui, {
      borderColor: color('accent'),
      selectList: { selectedPrefix: color('accent'), selectedText: color('accent'), description: color('muted'), scrollInfo: color('dim'), noMatch: color('warning') },
    });
    editor.disableSubmit = true;
    editor.setText(text);
    editor.focused = this._focused && this.composing && this.layoutAvailable;
    return editor;
  }

  private watchComposer(key: NativeTranscriptKey, generation: number): void {
    if (!this.options.composer) return;
    this.readComposerState();
    try {
      const unsubscribe = this.options.composer.subscribe({ ...key }, () => {
        if (this.disposed || generation !== this.generation || !this.key || !sameKey(this.key, key)) return;
        this.readComposerState();
        this.requestRender();
      });
      if (this.disposed || generation !== this.generation) cleanup(unsubscribe);
      else this.unsubscribeComposer = unsubscribe;
    } catch (error) { this.composerWatchError = rowText(`Composer observer unavailable: ${uiErrorText(error)}`).slice(0, 256); }
  }

  private validReceipt(receipt: ZergComposerReceipt, key: NativeTranscriptKey, messageId?: string): boolean {
    return Boolean(receipt && receipt.key && sameKey(receipt.key, key) && typeof receipt.messageId === 'string'
      && (messageId === undefined || receipt.messageId === messageId)
      && ['recorded', 'queued', 'delivered', 'failed', 'needs-attention'].includes(receipt.status)
      && ['memory', 'saved', 'failed'].includes(receipt.persistence) && typeof receipt.detail === 'string');
  }

  private readComposerState(): void {
    if (!this.options.composer || !this.key) return;
    try {
      const state = this.options.composer.getState({ ...this.key });
      if (!state?.key || !sameKey(state.key, this.key)) throw new Error('Composer identity mismatch.');
      if (!Array.isArray(state.receipts) || !Array.isArray(state.allowedModes) || !['memory', 'saved', 'failed'].includes(state.persistence)) throw new Error('Invalid composer state.');
      const receipts = state.receipts.slice(-MAX_RECEIPTS);
      if (receipts.some((receipt) => !this.validReceipt(receipt, this.key!))) throw new Error('Receipt identity or status mismatch.');
      this.composerState = {
        key: { ...this.key }, canSend: state.canSend === true, reason: state.reason === undefined ? undefined : rowText(state.reason).slice(0, 256),
        allowedModes: ['followUp', 'steer'].filter((mode) => state.allowedModes.includes(mode as ZergComposerMode)) as ZergComposerMode[],
        persistence: state.persistence,
        droppedReceipts: Math.max(0, Number.isSafeInteger(state.droppedReceipts) ? state.droppedReceipts! : 0) + Math.max(0, state.receipts.length - MAX_RECEIPTS),
        // Never retain backend extra fields (especially message bodies) in the UI.
        receipts: receipts.map((receipt) => ({ key: { ...this.key! }, messageId: receipt.messageId.slice(0, 128), status: receipt.status,
          detail: rowText(receipt.detail).slice(0, 256), createdAt: receipt.createdAt?.slice(0, 64), updatedAt: receipt.updatedAt?.slice(0, 64), persistence: receipt.persistence })),
      };
      this.composerError = '';
    } catch (error) { this.composerState = undefined; this.composerError = rowText(`Composer unavailable: ${uiErrorText(error)}`).slice(0, 256); }
  }

  private composerDisabledReason(forSend = true): string {
    if (!this.options.composer) return 'read-only viewer';
    if (this.mode !== 'transcript' || !this.key || this.loading) return 'no exact live session loaded';
    if (this.leafId !== undefined) return 'branch inspection is read-only; choose Default';
    if (this.snapshot?.source !== 'live' || this.snapshot.status !== 'running' || this.snapshot.defaultLeafBasis !== 'live') return 'only the running live default branch accepts messages';
    if (!this.layoutAvailable) return 'resize terminal (at least 12 columns / 10 rows)';
    if (this.composerError || this.composerWatchError) return this.composerError || this.composerWatchError;
    if (!this.composerState?.canSend || !this.composerState.allowedModes.length) return this.composerState?.reason || 'backend capability unavailable';
    if (forSend && !this.composerState.allowedModes.includes(this.composerMode)) return `selected mode ${this.composerMode} unavailable; Alt+m selects an allowed mode`;
    if (!sameKey(this.composerState.key, this.key)) return 'composer identity mismatch';
    return '';
  }

  private renderComposer(width: number, height: number): string[] {
    const capacity = Math.max(0, Math.min(13, height - 5));
    if (!capacity) return [];
    const reason = this.composerDisabledReason();
    const lines = [rowText(`Composer ${this.composerMode} · ${this.sending ? 'sending (not delivered)' : reason ? `disabled: ${reason}` : this.composing ? 'editing' : 'c to edit'} · receipt persistence ${this.composerState?.persistence ?? 'unknown'}`)];
    const editorRows = this.composing && this.editor && this.layoutAvailable ? Math.min(6, Math.max(1, capacity - 2)) : 0;
    if (this.composerMessage && lines.length < capacity - editorRows) lines.push(rowText(this.composerMessage).slice(0, 256));
    const receipts = this.composerState?.receipts ?? [];
    const receiptRows = Math.max(0, capacity - lines.length - editorRows - (receipts.length ? 1 : 0));
    const shown = receipts.slice(-receiptRows || receipts.length);
    const omitted = (this.composerState?.droppedReceipts ?? 0) + receipts.length - shown.length;
    if ((receipts.length || omitted) && lines.length < capacity - editorRows) lines.push(`Receipts: ${receipts.length} retained${omitted ? ` · ${omitted} omitted from view` : ''} · delivered = native consumed, not provider acknowledgement/completion`);
    for (const receipt of shown) {
      if (lines.length >= capacity - editorRows) break;
      const persistence = receipt.persistence === 'saved' ? 'receipt snapshot saved (not native transcript/fsync)' : receipt.persistence === 'failed' ? 'receipt save failed' : 'receipt memory only';
      lines.push(rowText(`${receipt.messageId} · ${receipt.status}${receipt.status === 'queued' || receipt.status === 'recorded' ? ' (not delivered)' : ''} · ${persistence} · ${receipt.detail}`));
    }
    if (editorRows && this.editor) {
      const editorLines = this.editor.render(width).map((line) => truncateToWidth(line, width, '', true));
      // Public Editor's trusted cursor marker locates the viewport; keep it, never sanitize it away.
      const cursor = editorLines.findIndex((line) => line.includes(CURSOR_MARKER));
      const start = Math.max(0, Math.min(editorLines.length - editorRows, cursor < 0 ? 0 : cursor - editorRows + 1));
      lines.push(...editorLines.slice(start, start + editorRows));
    }
    return lines.slice(0, capacity);
  }

  private changeEditor(input: string, insert = false): void {
    const editor = this.editor ??= this.createEditor();
    const previous = editor.getExpandedText();
    if (input.length > MAX_DRAFT) { this.composerMessage = 'Draft input rejected: 16384 character limit.'; return; }
    // Bound public Editor history without silently relocating a cursor in the middle of code.
    if (this.editorInputs >= 256) {
      const cursor = editor.getCursor();
      const draftLines = editor.getLines();
      const atEnd = cursor.line === draftLines.length - 1 && cursor.col === draftLines.at(-1)!.length;
      const navigation = ['tui.editor.cursorUp', 'tui.editor.cursorDown', 'tui.editor.cursorLeft', 'tui.editor.cursorRight', 'tui.editor.cursorWordLeft', 'tui.editor.cursorWordRight', 'tui.editor.cursorLineStart', 'tui.editor.cursorLineEnd', 'tui.editor.pageUp', 'tui.editor.pageDown'] as const;
      if (!atEnd && !navigation.some((action) => getKeybindings().matches(input, action))) {
        this.composerMessage = 'Editing history limit: move cursor to draft end before further edits.';
        return;
      }
      if (atEnd && !navigation.some((action) => getKeybindings().matches(input, action))) { this.editor = this.createEditor(previous); this.editorInputs = 0; }
    }
    try {
      if (insert) this.editor!.insertTextAtCursor(input);
      else this.editor!.handleInput(input);
      const text = this.editor!.getExpandedText();
      if (text.length > MAX_DRAFT || UNSAFE_DRAFT.test(text)) {
        this.editor = this.createEditor(previous);
        this.composerMessage = text.length > MAX_DRAFT ? 'Draft input rejected: 16384 character limit.' : 'Draft input rejected: terminal/control sequences.';
        return;
      }
      if (text !== previous) { this.editorInputs += 1; this.editRevision += 1; this.composerMessage = ''; }
    } catch (error) {
      this.editor = this.createEditor(previous);
      this.composerMessage = rowText(`Draft editor unavailable: ${uiErrorText(error)}`).slice(0, 256);
    }
  }

  private handlePaste(data: string): void {
    const paste = this.paste!;
    const combined = paste.tail + data;
    const end = combined.indexOf(PASTE_END);
    const content = end < 0 ? combined.slice(0, Math.max(0, combined.length - PASTE_END.length + 1)) : combined.slice(0, end);
    paste.tail = end < 0 ? combined.slice(content.length) : '';
    if (!paste.rejected) {
      if (content.length > MAX_DRAFT || UNSAFE_DRAFT.test(content) || normalizedDraft(paste.text + content).length + (this.editor?.getExpandedText().length ?? 0) > MAX_DRAFT) {
        paste.rejected = true; paste.text = '';
      } else paste.text += content;
    }
    if (end >= 0) {
      this.paste = undefined;
      if (paste.rejected) {
        this.composerMessage = 'Paste rejected: mixed prefix, size limit or terminal/control sequences; whole packet discarded, draft retained.';
        return;
      }
      this.changeEditor(normalizedDraft(paste.text), true);
      // Trailing data belongs to this paste input packet, never to command shortcuts.
      const trailing = combined.slice(end + PASTE_END.length);
      if (trailing) this.changeEditor(trailing.length > MAX_DRAFT ? trailing : normalizedDraft(trailing), true);
    }
  }

  private handleComposerInput(data: string): void {
    if (this.paste) { this.handlePaste(data); return; }
    const pasteStart = data.indexOf(PASTE_START);
    if (pasteStart >= 0) {
      // Mixed text/control prefixes cannot silently vanish or become command shortcuts.
      this.paste = { text: '', tail: '', rejected: pasteStart > 0 };
      this.handlePaste(data.slice(pasteStart + PASTE_START.length));
      return;
    }
    if (matchesKey(data, 'escape')) { this.composing = false; this.focused = this._focused; return; }
    if (!this.layoutAvailable) { this.composerMessage = 'Composer disabled: resize terminal; draft retained.'; return; }
    if (piMatchesKey(data, 'ctrl+s')) { void this.sendDraft(); return; }
    if (piMatchesKey(data, 'alt+m')) {
      const modes = this.composerState?.allowedModes ?? [];
      if (modes.length) {
        this.composerMode = modes[(modes.indexOf(this.composerMode) + 1) % modes.length]!;
        this.editRevision += 1;
      }
      return;
    }
    // Newlines are never submits, even when a terminal cannot distinguish modified Enter.
    const keys = getKeybindings();
    if (matchesKey(data, 'enter') || keys.matches(data, 'tui.input.submit') || keys.matches(data, 'tui.input.newLine')) this.changeEditor('\n', true);
    else this.changeEditor(data);
  }

  private async sendDraft(): Promise<void> {
    if (this.sending || this.paste || !this.key || !this.options.composer) return;
    this.readComposerState();
    const reason = this.composerDisabledReason();
    if (reason) { this.composerMessage = `Send disabled: ${reason}`; return; }
    const body = this.editor?.getExpandedText() ?? '';
    if (!body.trim() || body.length > MAX_DRAFT || UNSAFE_DRAFT.test(body)) {
      this.composerMessage = 'Send rejected: nonblank safe draft required (maximum 16384 characters).';
      return;
    }
    const key = { ...this.key };
    const mode = this.composerMode;
    const generation = this.generation;
    const revision = this.editRevision;
    if (!this.attempt || !sameKey(this.attempt.key, key) || this.attempt.body !== body || this.attempt.mode !== mode) this.attempt = { key, messageId: randomUUID(), body, mode };
    const request = this.attempt;
    const messageId = request.messageId;
    this.sending = true;
    this.composerMessage = 'Sending request; delivery not yet known.';
    this.requestRender();
    try {
      if (!this.options.getReferences().some((reference) => sameKey(reference, key))) throw new Error('Selected reference is stale.');
      if (this.disposed || generation !== this.generation || !this.key || !sameKey(this.key, key)) throw new Error('Selected reference changed.');
      const response = await this.options.composer.send({ ...request, key: { ...key } });
      if (this.disposed || generation !== this.generation || !this.key || !sameKey(this.key, key)) return;
      if (!response || typeof response.ok !== 'boolean' || typeof response.message !== 'string') throw new Error('Invalid send response; outcome unknown.');
      if (response.receipt && !this.validReceipt(response.receipt, key, messageId)) throw new Error('Send receipt identity or status mismatch; outcome unknown.');
      const accepted = response.ok && response.receipt && ['queued', 'delivered'].includes(response.receipt.status);
      this.composerMessage = response.ok && !accepted ? `Send not confirmed (${response.receipt?.status ?? 'missing receipt'}); draft retained; no automatic retry.` : rowText(response.message).slice(0, 256);
      if (accepted && revision === this.editRevision && this.editor?.getExpandedText() === body && this.composerMode === mode) {
        this.editor = this.createEditor();
        this.editRevision += 1;
        this.attempt = undefined;
      }
      this.readComposerState();
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.composerMessage = rowText(`Send failed or outcome unknown: ${uiErrorText(error)}. Draft retained; no automatic retry.`).slice(0, 256);
    } finally {
      if (!this.disposed && generation === this.generation) { this.sending = false; this.requestRender(); }
    }
  }

  private formatted(width: number): { width: number; lines: string[]; limited: boolean } {
    if (this.cache?.width === width) return this.cache;
    const lines: string[] = [];
    let remaining = MAX_TEXT;
    let limited = false;
    const add = (value: string | undefined, color = 'text') => {
      if (value === undefined) return;
      if (lines.length >= MAX_LINES || remaining <= 0) { limited = true; return; }
      const clean = sanitizeTranscriptText(value.slice(0, remaining));
      if (value.length > Math.min(remaining, MAX_FIELD)) limited = true;
      remaining -= clean.length;
      // Bound wrapping work before using Pi's public Text component.
      for (const part of clean.split('\n')) {
        if (lines.length >= MAX_LINES) { limited = true; break; }
        const wrapped = new Text(part || ' ', 0, 0).render(width);
        const available = MAX_LINES - lines.length;
        if (wrapped.length > available) limited = true;
        lines.push(...wrapped.slice(0, available).map((line) => styleText(this.theme, color, line)));
      }
    };
    if (this.key) {
      add(`parent run: ${this.key.parentRunId}`);
      add(`member run: ${this.key.memberRunId}`);
      add(`Pi session: ${this.key.piSessionId}`);
    }
    add('Raw branch history only; compaction/context_edit notices are not effective model context.', 'dim');
    const snapshot = this.snapshot;
    if (snapshot?.source === 'captured') add('Live observation detached; captured output is not connected or proven saved.', 'warning');
    add(snapshot?.diagnostic, 'warning');
    if (snapshot?.truncated) add(`Transcript truncated: ${snapshot.droppedBlocks} dropped blocks`, 'warning');
    add(`inspected leaf: ${snapshot?.inspectedLeafId ?? 'default'} · live leaf: ${snapshot?.liveLeafId ?? 'unknown'}`, 'dim');
    if (!snapshot?.blocks.length) add(this.loading ? 'Loading…' : 'No transcript blocks available.');
    for (const block of snapshot?.blocks.slice(0, MAX_CHOICES) ?? []) {
      if (lines.length >= MAX_LINES || remaining <= 0) { limited = true; break; }
      add(`[${block.kind}${block.role ? ` · ${block.role}` : ''}${block.toolName ? ` · ${block.toolName}` : ''}${block.status ? ` · ${block.status}` : ''}]`, 'accent');
      if (block.toolCallId) add(`tool call: ${block.toolCallId}${block.parentToolCallId ? ` · parent: ${block.parentToolCallId}` : ''}`, 'dim');
      add(block.text, block.kind === 'thinking' ? 'dim' : 'text');
      if (block.argumentsText) { add('arguments:', 'muted'); add(block.argumentsText); }
      if (block.resultText) { add('result:', 'muted'); add(block.resultText); }
      add('');
    }
    if ((snapshot?.blocks.length ?? 0) > MAX_CHOICES) limited = true;
    return this.cache = { width, lines, limited };
  }
}
