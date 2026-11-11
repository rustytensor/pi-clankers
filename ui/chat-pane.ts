import type { ClankersManagementTargetKind, ClankersManagementUiState, ClankersOperatorMessageDeliveryStatus, ClankersState } from '../types.js';
import { renderPane, sanitizeUiText, styleText, type UiThemeLike } from './components.js';
import { addOperatorMessage, backspaceDraft, clearDraft } from './state.js';
import { resolveSelectedTarget } from './detail-pane.js';

export interface ChatSendResult {
  status: ClankersOperatorMessageDeliveryStatus;
  statusDetail: string;
  routedTargetId?: string;
}

export interface ChatPaneActions {
  now(): Date;
  sendOperatorMessage(target: { id: string; kind: ClankersManagementTargetKind }, body: string): ChatSendResult;
}

export function updateChatDraftFromInput(uiState: ClankersManagementUiState, input: string): void {
  uiState.chatDraft = `${uiState.chatDraft}${input}`.slice(0, 500);
}

export function cancelChatDraft(uiState: ClankersManagementUiState): string {
  clearDraft(uiState);
  return 'chat draft cancelled';
}

export function sendChatDraft(state: ClankersState, uiState: ClankersManagementUiState, actions: ChatPaneActions): string {
  const body = uiState.chatDraft.trim();
  if (!body) {
    return 'chat draft is empty';
  }
  const target = resolveSelectedTarget(state, uiState);
  if (!target) {
    addOperatorMessage(uiState, {
      targetId: 'none',
      targetKind: 'agent',
      body,
      status: 'queued-local',
      statusDetail: 'No selected target; message retained locally and not delivered.',
      now: actions.now(),
    });
    clearDraft(uiState);
    return 'no selected target; message retained locally';
  }
  const result = actions.sendOperatorMessage(target, body);
  addOperatorMessage(uiState, {
    targetId: target.id,
    targetKind: target.kind,
    routedTargetId: result.routedTargetId,
    body,
    status: result.status,
    statusDetail: result.statusDetail,
    now: actions.now(),
  });
  clearDraft(uiState);
  return result.statusDetail;
}

export function handleChatBackspace(uiState: ClankersManagementUiState): void {
  backspaceDraft(uiState);
}

export function renderChatPane(state: ClankersState, uiState: ClankersManagementUiState, width: number, height: number, composerLines?: readonly string[], theme?: UiThemeLike): string[] {
  const selected = resolveSelectedTarget(state, uiState);
  const targetLabel = selected ? `${sanitizeUiText(selected.kind)} ${sanitizeUiText(selected.id)}` : 'none';
  const lines = [
    `${styleText(theme, 'accent', 'Target')} ${targetLabel}`,
    styleText(theme, 'dim', 'Messages are recorded as operator interventions, not fake chat delivery.'),
    '',
  ];
  const thread = uiState.messages.filter((message) => !selected || message.targetId === selected.id || message.routedTargetId === selected.id).slice(-Math.max(1, height - 9));
  if (thread.length === 0) {
    lines.push('thread: no local operator messages for target');
  } else {
    for (const message of thread) {
      const routed = message.routedTargetId ? ` -> ${sanitizeUiText(message.routedTargetId)}` : '';
      lines.push(`${sanitizeUiText(message.createdAt)} ${sanitizeUiText(message.targetKind)}:${sanitizeUiText(message.targetId)}${routed}`);
      lines.push(`  [${sanitizeUiText(message.status)}] ${sanitizeUiText(message.body)}`);
      lines.push(`  ${sanitizeUiText(message.statusDetail)}`);
    }
  }
  lines.push('');
  if (composerLines && composerLines.length > 0) {
    lines.push(...composerLines.map((line) => `draft: ${line}`));
  } else {
    lines.push(`draft: ${sanitizeUiText(uiState.chatDraft) || '(empty)'}`);
  }
  lines.push(styleText(theme, 'dim', 'Type here when focused. Enter sends. Ctrl+X clears.'));
  return renderPane(lines, { title: '3 Message', focused: uiState.focusedPane === 'chat', width, height, theme });
}
