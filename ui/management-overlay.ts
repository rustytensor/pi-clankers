import { DEFAULT_MANAGEMENT_SHORTCUT } from './preferences.js';
import type { ManagementUiPreferencesFacade } from './management-shortcut.js';
import { Input, type Component, type Focusable } from '@earendil-works/pi-tui';
import type { AutomationMode, StructuralPiCommandContext, StructuralPiCustomComponent, StructuralPiTuiHandle, ZergControlController, ZergManagementTargetKind, ZergManagementUiState, ZergOperatorMessageDeliveryStatus, ZergState } from '../types.js';
import { sanitizeTranscriptText } from './agent-overlay.js';
import { boldText, columns, fitRawLine, sanitizeUiText, styleText, type UiThemeLike } from './components.js';
import { ChatPaneActions, cancelChatDraft, renderChatPane, sendChatDraft } from './chat-pane.js';
import { renderDetailPane, resolveSelectedTarget } from './detail-pane.js';
import { renderManagementFooter } from './footer.js';
import { SettingsPaneActions, applyPermissionFromSettings, createSettingsPaneState, cycleController, movePendingPermissionCursor, renderSettingsPane } from './settings-pane.js';
import { MANAGEMENT_PANES, createManagementUiState, matchesKey, movePaneFocus, setSelectedTarget } from './state.js';
import { activateTreeSelection, buildManagementTreeRows, collapseTreeSelection, createTreePaneState, expandTreeSelection, moveTreeCursor, renderTreePane } from './tree-pane.js';

function viewerError(error: unknown): string {
  try {
    const message: unknown = error instanceof Error ? error.message : error;
    const text = typeof message === 'string' ? `${error instanceof Error ? 'Error: ' : ''}${message.slice(0, 256)}` : 'Unknown failure (non-text error).';
    return sanitizeTranscriptText(text).slice(0, 256).replace(/\n/g, ' ');
  }
  catch { return 'Unknown failure (unreadable error).'; }
}

export interface ZergManagementOverlayActions extends SettingsPaneActions, ChatPaneActions {
  selectTarget(target: { id: string; kind: ZergManagementTargetKind }): string;
  interruptSelected(target: { id: string; kind: ZergManagementTargetKind } | undefined): string;
}

export interface ZergManagementOverlayOptions {
  getSnapshot(): ZergState;
  subscribe(listener: () => void): () => void;
  adapterKind: string;
  uiPreferences?: ManagementUiPreferencesFacade;
  actions: ZergManagementOverlayActions;
  viewTimeline?(target: { id: string; kind: ZergManagementTargetKind } | undefined): Promise<void>;
  viewCoding?(target: { id: string; kind: ZergManagementTargetKind } | undefined): Promise<void>;
}

export async function openZergManagementOverlay(context: Pick<StructuralPiCommandContext, 'ui'>, options: ZergManagementOverlayOptions): Promise<void> {
  let component: ZergManagementOverlayComponent | undefined;
  try {
    await Promise.resolve(context.ui?.custom?.(
      (tui?: StructuralPiTuiHandle, theme?: unknown, _keybindings?: unknown, done?: (result?: void) => void) => {
        component?.dispose();
        return component = new ZergManagementOverlayComponent(tui, theme as UiThemeLike | undefined, () => done?.(undefined), options);
      },
      { overlay: true, overlayOptions: { title: 'clankers config', anchor: 'center', width: '78%', maxHeight: '82%', minWidth: 72 } },
    ));
  } finally { component?.dispose(); }
}

export class ZergManagementOverlayComponent implements StructuralPiCustomComponent, Component, Focusable {
  focused = false;
  private readonly uiState: ZergManagementUiState = createManagementUiState();
  private readonly treeState = createTreePaneState();
  private readonly settingsState = createSettingsPaneState();
  private readonly chatInput = new Input();
  private readonly preferencesInput = new Input();
  private unsubscribePreferences: () => void = () => undefined;
  private codingViewerOpen = false;
  private disposed = false;
  private unsubscribe: () => void = () => undefined;
  private cachedWidth?: number;
  private cachedHeight?: number;
  private cachedLines?: string[];

  constructor(
    private readonly tui: StructuralPiTuiHandle | undefined,
    private readonly theme: UiThemeLike | undefined,
    private readonly done: (() => void) | undefined,
    private readonly options: ZergManagementOverlayOptions,
  ) {
    this.preferencesInput.onSubmit = (value) => {
      const shortcut = value.trim().toLowerCase() === 'off' ? null : value.trim().toLowerCase() === 'default' ? DEFAULT_MANAGEMENT_SHORTCUT : value;
      const result = this.options.uiPreferences?.saveHuman({ managementShortcut: shortcut });
      this.uiState.statusMessage = result?.ok ? 'UI preferences saved; shortcut changes require /reload' : result?.reason ?? 'UI preferences unavailable';
      this.requestRender();
    };
    this.preferencesInput.onEscape = () => { this.settingsState.preferencesOpen = false; this.requestRender(); };
    try { this.unsubscribePreferences = options.uiPreferences?.subscribe(() => this.requestRender()) ?? (() => undefined); }
    catch { /* Preferences observation does not change existing controls. */ }
    this.chatInput.onSubmit = (value) => {
      this.uiState.chatDraft = value;
      this.uiState.statusMessage = sendChatDraft(this.options.getSnapshot(), this.uiState, this.options.actions);
      this.chatInput.setValue('');
    };
    this.chatInput.onEscape = () => {
      this.dispose();
    };
    try {
      const unsubscribe = options.subscribe(() => this.requestRender());
      if (this.disposed) { try { unsubscribe(); } catch { /* Reentrant close still releases observer. */ } }
      else this.unsubscribe = unsubscribe;
    } catch (error) { this.uiState.statusMessage = `Management observer unavailable: ${viewerError(error)}`; }
  }

  render(width = 120, requestedHeight?: number): string[] {
    const height = this.resolveHeight(requestedHeight);
    if (this.cachedLines && this.cachedWidth === width && this.cachedHeight === height) {
      return this.cachedLines;
    }
    const snapshot = this.options.getSnapshot();
    const safeWidth = Math.max(1, Math.min(512, Math.floor(width) || 1));
    const safeHeight = height;
    if (safeWidth < 72 || safeHeight < 18) {
      this.chatInput.focused = false;
      this.preferencesInput.focused = false;
      return [styleText(this.theme, 'warning', 'clankers config: resize terminal (72 columns / 18 rows); Esc closes')]
        .slice(0, safeHeight).map((line) => fitRawLine(line, safeWidth));
    }
    this.ensureDefaultTarget(snapshot);
    const footer = renderManagementFooter(snapshot, this.uiState, this.options.adapterKind, safeWidth, this.theme);
    const header = this.renderHeader(snapshot, safeWidth);
    const bodyHeight = Math.max(8, safeHeight - header.length - footer.length - 1);
    if (this.settingsState.preferencesOpen && this.options.uiPreferences) {
      this.chatInput.focused = false;
      this.preferencesInput.focused = this.focused;
      const preferences = renderSettingsPane(snapshot, this.uiState, this.settingsState, this.options.adapterKind, safeWidth, bodyHeight, this.theme, this.options.uiPreferences, this.preferencesInput.render(Math.max(8, safeWidth - 4)));
      this.cachedWidth = width; this.cachedHeight = height;
      return this.cachedLines = [...header, ...preferences, '', ...footer].map((line) => fitRawLine(line, safeWidth)).slice(0, safeHeight);
    }
    const topHeight = Math.max(4, Math.floor(bodyHeight * 0.58));
    const bottomHeight = Math.max(4, bodyHeight - topHeight);
    const leftWidth = Math.max(30, Math.floor((safeWidth - 2) * 0.42));
    const rightWidth = safeWidth - 2 - leftWidth;
    const tree = renderTreePane(snapshot, this.uiState, this.treeState, leftWidth, topHeight, this.theme);
    const detail = renderDetailPane(snapshot, this.uiState, rightWidth, topHeight, this.theme);
    this.preferencesInput.focused = this.focused && this.uiState.focusedPane === 'settings' && !!this.settingsState.preferencesOpen;
    const settings = renderSettingsPane(snapshot, this.uiState, this.settingsState, this.options.adapterKind, leftWidth, bottomHeight, this.theme, this.options.uiPreferences);
    this.chatInput.focused = this.focused && this.uiState.focusedPane === 'chat';
    const composerLines = this.chatInput.render(Math.max(8, rightWidth - 12));
    const chat = renderChatPane(snapshot, this.uiState, rightWidth, bottomHeight, composerLines, this.theme);
    const body = [
      ...columns(tree, detail, safeWidth),
      ...columns(settings, chat, safeWidth),
    ];
    this.cachedWidth = width;
    this.cachedHeight = height;
    this.cachedLines = [...header, ...body, '', ...footer].map((line) => fitRawLine(line, safeWidth)).slice(0, safeHeight);
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedHeight = undefined;
    this.cachedLines = undefined;
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    // Own text BEFORE legacy global keys: typing r/m/a/u/c/i/p/d cannot change authority.
    if (this.settingsState.preferencesOpen && this.options.uiPreferences) {
      if (matchesKey(data, 'ctrl+v')) {
        const result = this.options.uiPreferences.saveHuman({ activityStrip: !this.options.uiPreferences.snapshot().activityStrip });
        this.uiState.statusMessage = result.ok ? 'Activity strip visibility saved (immediate)' : result.reason;
      } else if (data.length > 4096) this.uiState.statusMessage = 'UI preference input exceeds limit';
      else {
        this.preferencesInput.handleInput(data);
        if (this.preferencesInput.getValue().length > 128) this.preferencesInput.setValue(this.preferencesInput.getValue().slice(0, 128));
      }
      this.requestRender(); return;
    }
    if (matchesKey(data, 'escape') || ((data === 'q' || data === 'Q') && (this.uiState.focusedPane !== 'chat' || this.uiState.chatDraft.length === 0))) {
      this.dispose();
      return;
    }
    if (this.uiState.focusedPane === 'chat' && this.isChatTextInput(data)) {
      this.handleChatInput(data);
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'tab')) {
      movePaneFocus(this.uiState, 1);
      this.requestRender();
      return;
    }
    if (matchesKey(data, 'shift-tab')) {
      movePaneFocus(this.uiState, -1);
      this.requestRender();
      return;
    }
    if ((data === 't' || data === 'T') && (this.uiState.focusedPane === 'tree' || this.uiState.focusedPane === 'detail')) {
      this.openCodingViewer('timeline');
      return;
    }
    if ((data === 'v' || data === 'V') && (this.uiState.focusedPane === 'tree' || this.uiState.focusedPane === 'detail')) {
      this.openCodingViewer();
      return;
    }

    if (this.handleGlobalAction(data)) {
      this.requestRender();
      return;
    }

    switch (this.uiState.focusedPane) {
      case 'tree':
        this.handleTreeInput(data);
        break;
      case 'settings':
        this.handleSettingsInput(data);
        break;
      case 'chat':
        this.handleChatInput(data);
        break;
      case 'detail':
        if (matchesKey(data, 'enter')) {
          this.uiState.statusMessage = 'detail pane is read-only; use tree/settings/chat actions';
        }
        break;
    }
    this.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = () => undefined;
    try { unsubscribe(); } catch { /* A failing observer cannot block host completion. */ }
    try { this.unsubscribePreferences(); } catch { /* Observer only. */ }
    try { this.done?.(); } catch { /* Host completion is attempted once. */ }
  }

  getStateForTests(): ZergManagementUiState {
    return {
      ...this.uiState,
      expandedNodeIds: [...this.uiState.expandedNodeIds],
      messages: this.uiState.messages.map((message) => ({ ...message })),
    };
  }

  private resolveHeight(requestedHeight?: number): number {
    const rows = requestedHeight ?? (this.tui?.terminal?.rows ?? 32) * 0.82;
    return Math.max(1, Math.min(128, Math.floor(rows) || 1));
  }

  private requestRender(): void {
    if (this.disposed) return;
    this.invalidate();
    try { this.tui?.requestRender?.(); } catch { this.uiState.statusMessage = 'management redraw unavailable'; }
  }

  private renderHeader(snapshot: ZergState, width: number): string[] {
    const counts = `${Object.keys(snapshot.teams).length} teams · ${Object.keys(snapshot.agents).length} agents · ${Object.keys(snapshot.tasks).length} tasks`;
    const pendingPermissions = this.countPendingPermissions(snapshot);
    const readOnly = snapshot.mode.readOnly ? styleText(this.theme, 'warning', 'read-only on') : styleText(this.theme, 'success', 'edits allowed');
    const title = boldText(this.theme, styleText(this.theme, 'accent', 'clankers config'));
    return [
      fitRawLine(`${title} ${styleText(this.theme, 'muted', '·')} ${styleText(this.theme, 'muted', counts)} ${styleText(this.theme, 'muted', '·')} ${readOnly}`, width),
      fitRawLine(`${styleText(this.theme, 'dim', 'Use three steps:')} ${styleText(this.theme, 'accent', 'Select')} → ${styleText(this.theme, 'accent', 'Settings')} → ${styleText(this.theme, 'accent', 'Message')}   ${styleText(this.theme, 'dim', 'Tab changes focus')}`, width),
      fitRawLine(`${styleText(this.theme, 'muted', 'Mode')} ${sanitizeUiText(snapshot.mode.automation)}   ${styleText(this.theme, 'muted', 'Controller')} ${this.resolveControlController(snapshot)}   ${styleText(this.theme, 'muted', 'Pending approvals')} ${pendingPermissions}`, width),
    ];
  }

  private ensureDefaultTarget(snapshot: ZergState): void {
    if (this.uiState.selectedTargetId && this.uiState.selectedTargetKind) return;
    const rows = buildManagementTreeRows(snapshot, this.uiState);
    const existing = resolveSelectedTarget(snapshot, this.uiState);
    if (existing) {
      setSelectedTarget(this.uiState, existing.id, existing.kind);
      const existingIndex = rows.findIndex((row) => row.targetId === existing.id && row.targetKind === existing.kind);
      if (existingIndex >= 0) this.treeState.cursor = existingIndex;
      return;
    }
    const firstTargetIndex = rows.findIndex((row) => row.targetId && row.targetKind);
    if (firstTargetIndex < 0) return;
    const firstTarget = rows[firstTargetIndex]!;
    this.treeState.cursor = firstTargetIndex;
    setSelectedTarget(this.uiState, firstTarget.targetId, firstTarget.targetKind);
  }

  private resolveControlController(snapshot: ZergState): string {
    const candidate = snapshot.extensions.zergControl as { controller?: unknown } | undefined;
    return candidate?.controller === 'pi' || candidate?.controller === 'zerg' || candidate?.controller === 'operator'
      ? candidate.controller
      : 'operator';
  }

  private countPendingPermissions(snapshot: ZergState): number {
    const candidate = snapshot.extensions.zergPermissions;
    if (!candidate || typeof candidate !== 'object' || !Array.isArray((candidate as { requests?: unknown }).requests)) {
      return 0;
    }
    return (candidate as { requests: Array<{ status?: unknown }> }).requests.filter((request) => request.status === 'pending').length;
  }

  private isChatTextInput(data: string): boolean {
    return !matchesKey(data, 'tab', 'shift-tab');
  }

  private openCodingViewer(view: 'coding' | 'timeline' = 'coding'): void {
    if (this.codingViewerOpen) return;
    const callback = view === 'timeline' ? this.options.viewTimeline : this.options.viewCoding;
    if (!callback) {
      this.uiState.statusMessage = `${view} viewer unavailable`;
      this.requestRender();
      return;
    }
    let target: { id: string; kind: ZergManagementTargetKind } | undefined;
    try {
      this.ensureDefaultTarget(this.options.getSnapshot());
      target = resolveSelectedTarget(this.options.getSnapshot(), this.uiState);
    } catch { this.uiState.statusMessage = `${view} scope unavailable`; this.requestRender(); return; }
    this.codingViewerOpen = true;
    this.uiState.statusMessage = `opening read-only ${view} viewer`;
    this.requestRender();
    // Promise boundary catches synchronous throws as well as async host failures.
    void Promise.resolve().then(() => {
      if (!this.disposed) return callback.call(this.options, target);
    }).then(() => {
      if (!this.disposed) this.uiState.statusMessage = `${view} viewer closed`;
    }, (error: unknown) => {
      if (!this.disposed) this.uiState.statusMessage = `${view} viewer unavailable: ${viewerError(error)}`;
    }).finally(() => {
      this.codingViewerOpen = false;
      this.requestRender();
    });
  }
  private handleGlobalAction(data: string): boolean {
    if (data === 'r' || data === 'R') {
      this.uiState.statusMessage = this.options.actions.toggleReadOnly();
      return true;
    }
    if (data === 'm' || data === 'M') {
      this.uiState.statusMessage = this.options.actions.setAutomation('manual');
      return true;
    }
    if (data === 'a' || data === 'A') {
      this.uiState.statusMessage = this.options.actions.setAutomation('assisted');
      return true;
    }
    if (data === 'u' || data === 'U') {
      this.uiState.statusMessage = this.options.actions.setAutomation('automatic');
      return true;
    }
    if (data === 'c' || data === 'C') {
      this.uiState.statusMessage = cycleController(this.options.getSnapshot(), this.options.actions);
      return true;
    }
    if (data === 'i' || data === 'I') {
      const selected = this.uiState.selectedTargetId && this.uiState.selectedTargetKind ? { id: this.uiState.selectedTargetId, kind: this.uiState.selectedTargetKind } : undefined;
      this.uiState.statusMessage = this.options.actions.interruptSelected(selected);
      return true;
    }
    if (data === 'p' || data === 'P') {
      this.uiState.statusMessage = applyPermissionFromSettings(this.settingsState, this.options.getSnapshot(), 'approve', this.options.actions);
      return true;
    }
    if (data === 'd' || data === 'D') {
      this.uiState.statusMessage = applyPermissionFromSettings(this.settingsState, this.options.getSnapshot(), 'deny', this.options.actions);
      return true;
    }
    return false;
  }

  private handleTreeInput(data: string): void {
    const rows = buildManagementTreeRows(this.options.getSnapshot(), this.uiState);
    if (matchesKey(data, 'up')) {
      moveTreeCursor(this.treeState, rows, -1);
      this.uiState.statusMessage = 'tree cursor moved; press enter to confirm selection';
    } else if (matchesKey(data, 'down')) {
      moveTreeCursor(this.treeState, rows, 1);
      this.uiState.statusMessage = 'tree cursor moved; press enter to confirm selection';
    } else if (matchesKey(data, 'left')) {
      collapseTreeSelection(this.uiState, this.treeState, rows);
      this.uiState.statusMessage = 'tree node collapsed';
    } else if (matchesKey(data, 'right')) {
      expandTreeSelection(this.uiState, this.treeState, rows);
      this.uiState.statusMessage = 'tree node expanded';
    } else if (matchesKey(data, 'enter') || matchesKey(data, 'space')) {
      const row = activateTreeSelection(this.uiState, this.treeState, rows);
      this.uiState.statusMessage = row?.targetId && row.targetKind
        ? this.options.actions.selectTarget({ id: row.targetId, kind: row.targetKind })
        : 'tree group toggled';
    }
  }

  private handleSettingsInput(data: string): void {
    if ((data === 'o' || data === 'O') && this.options.uiPreferences) {
      this.settingsState.preferencesOpen = true;
      this.settingsState.confirmation = undefined;
      this.preferencesInput.setValue(this.options.uiPreferences.snapshot().desired ?? 'off');
      this.uiState.statusMessage = 'editing UI preferences (no execution authority changes)';
    } else if (matchesKey(data, 'up')) {
      movePendingPermissionCursor(this.settingsState, this.options.getSnapshot(), -1);
      this.uiState.statusMessage = 'permission cursor moved';
    } else if (matchesKey(data, 'down')) {
      movePendingPermissionCursor(this.settingsState, this.options.getSnapshot(), 1);
      this.uiState.statusMessage = 'permission cursor moved';
    } else if (matchesKey(data, 'enter')) {
      this.uiState.statusMessage = 'settings focused: use r/m/a/u/c/p/d action keys';
    }
  }

  private handleChatInput(data: string): void {
    if (matchesKey(data, 'enter')) {
      this.uiState.chatDraft = this.chatInput.getValue();
      this.uiState.statusMessage = sendChatDraft(this.options.getSnapshot(), this.uiState, this.options.actions);
      this.chatInput.setValue('');
      return;
    }
    if (matchesKey(data, 'ctrl+x')) {
      this.chatInput.setValue('');
      this.uiState.statusMessage = cancelChatDraft(this.uiState);
      return;
    }
    this.chatInput.handleInput(data);
    this.uiState.chatDraft = this.chatInput.getValue();
    if (this.uiState.chatDraft) {
      this.uiState.statusMessage = 'editing chat draft';
    }
  }
}

export function paneOrderForTests(): readonly string[] {
  return MANAGEMENT_PANES;
}
