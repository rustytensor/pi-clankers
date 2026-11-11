import { decodeKittyPrintable, matchesKey as matchesPiKey, type KeyId } from '@earendil-works/pi-tui';
import type { ClankersManagementPaneId, ClankersManagementTargetKind, ClankersManagementUiState, ClankersOperatorMessageDeliveryStatus, ClankersOperatorMessageRecord } from '../types.js';

export const MANAGEMENT_PANES: ClankersManagementPaneId[] = ['tree', 'settings', 'chat', 'detail'];

export function createManagementUiState(): ClankersManagementUiState {
  return {
    focusedPane: 'tree',
    expandedNodeIds: ['root:teams', 'root:agents', 'root:tasks'],
    chatDraft: '',
    messages: [],
  };
}

export function movePaneFocus(state: ClankersManagementUiState, direction: 1 | -1): void {
  const current = MANAGEMENT_PANES.indexOf(state.focusedPane);
  const next = (current + direction + MANAGEMENT_PANES.length) % MANAGEMENT_PANES.length;
  state.focusedPane = MANAGEMENT_PANES[next]!;
}

export function setSelectedTarget(state: ClankersManagementUiState, targetId: string | undefined, targetKind: ClankersManagementTargetKind | undefined): void {
  state.selectedTargetId = targetId;
  state.selectedTargetKind = targetKind;
}

export function isExpanded(state: ClankersManagementUiState, nodeId: string): boolean {
  return state.expandedNodeIds.includes(nodeId);
}

export function setExpanded(state: ClankersManagementUiState, nodeId: string, expanded: boolean): void {
  if (expanded) {
    if (!state.expandedNodeIds.includes(nodeId)) {
      state.expandedNodeIds = [...state.expandedNodeIds, nodeId].sort();
    }
    return;
  }
  state.expandedNodeIds = state.expandedNodeIds.filter((candidate) => candidate !== nodeId);
}

export function toggleExpanded(state: ClankersManagementUiState, nodeId: string): void {
  setExpanded(state, nodeId, !isExpanded(state, nodeId));
}

export function appendDraftText(state: ClankersManagementUiState, input: string): void {
  state.chatDraft = `${state.chatDraft}${input}`.slice(0, 500);
}

export function backspaceDraft(state: ClankersManagementUiState): void {
  state.chatDraft = state.chatDraft.slice(0, -1);
}

export function clearDraft(state: ClankersManagementUiState): void {
  state.chatDraft = '';
}

export function addOperatorMessage(
  state: ClankersManagementUiState,
  input: {
    targetId: string;
    targetKind: ClankersManagementTargetKind;
    routedTargetId?: string;
    body: string;
    status: ClankersOperatorMessageDeliveryStatus;
    statusDetail: string;
    now: Date;
  },
): ClankersOperatorMessageRecord {
  const message: ClankersOperatorMessageRecord = {
    id: `ui-msg-${input.now.getTime().toString(36)}-${state.messages.length + 1}`,
    targetId: input.targetId,
    targetKind: input.targetKind,
    routedTargetId: input.routedTargetId,
    body: input.body,
    status: input.status,
    statusDetail: input.statusDetail,
    createdAt: input.now.toISOString(),
  };
  state.messages = [...state.messages, message].slice(-50);
  return message;
}

export function matchesKey(data: string, ...keys: string[]): boolean {
  return keys.some((key) => {
    const normalized = normalizeKeyId(key);
    return data === key || data === normalized || matchesLegacySequence(data, normalized) || matchesPiKey(data, normalized);
  });
}

export function printableInput(data: string): string | undefined {
  return decodeKittyPrintable(data) ?? (data.length === 1 && data >= ' ' && data !== '\u007f' ? data : undefined);
}

function normalizeKeyId(key: string): KeyId {
  return (key === 'shift-tab' ? 'shift+tab' : key) as KeyId;
}

function matchesLegacySequence(data: string, key: KeyId): boolean {
  if (key === 'up') return data === '\u001b[A';
  if (key === 'down') return data === '\u001b[B';
  if (key === 'right') return data === '\u001b[C';
  if (key === 'left') return data === '\u001b[D';
  if (key === 'escape') return data === '\u001b';
  if (key === 'tab') return data === '\t';
  if (key === 'shift+tab') return data === '\u001b[Z';
  if (key === 'enter') return data === '\r' || data === '\n';
  if (key === 'backspace') return data === '\u007f' || data === '\b';
  return false;
}
