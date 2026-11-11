import type { ManagementUiPreferencesFacade } from './management-shortcut.js';
import type { AutomationMode, ClankersControlController, ClankersManagementUiState, ClankersPermissionRequest, ClankersState } from '../types.js';
import { renderPane, sanitizeUiText, styleText, type UiThemeLike } from './components.js';

export interface SettingsPaneActions {
  toggleReadOnly(): string;
  setAutomation(mode: AutomationMode): string;
  setController(controller: ClankersControlController): string;
  approvePermission(requestId: string): string;
  denyPermission(requestId: string): string;
}

export interface SettingsPaneState {
  pendingCursor: number;
  preferencesOpen?: boolean;
  confirmation?: { action: 'approve' | 'deny'; requestId: string };
}

export function createSettingsPaneState(): SettingsPaneState {
  return { pendingCursor: 0 };
}

export function getPendingPermissionRows(state: ClankersState): ClankersPermissionRequest[] {
  const candidate = state.extensions.clankersPermissions;
  const requests = candidate && typeof candidate === 'object' && Array.isArray((candidate as { requests?: unknown }).requests)
    ? (candidate as { requests: ClankersPermissionRequest[] }).requests
    : [];
  return requests.filter((request) => request.status === 'pending').slice().reverse();
}

export function movePendingPermissionCursor(settingsState: SettingsPaneState, state: ClankersState, direction: 1 | -1): void {
  const rows = getPendingPermissionRows(state);
  settingsState.pendingCursor = rows.length === 0 ? 0 : Math.max(0, Math.min(settingsState.pendingCursor + direction, rows.length - 1));
  settingsState.confirmation = undefined;
}

export function applyPermissionFromSettings(settingsState: SettingsPaneState, state: ClankersState, action: 'approve' | 'deny', actions: SettingsPaneActions): string {
  const rows = getPendingPermissionRows(state);
  const request = rows[settingsState.pendingCursor];
  if (!request) {
    settingsState.confirmation = undefined;
    return 'no pending permission request selected';
  }
  if (settingsState.confirmation?.action === action && settingsState.confirmation.requestId === request.id) {
    settingsState.confirmation = undefined;
    return action === 'approve' ? actions.approvePermission(request.id) : actions.denyPermission(request.id);
  }
  settingsState.confirmation = { action, requestId: request.id };
  return `press ${action === 'approve' ? 'p' : 'd'} again to ${action} ${request.id}`;
}

export function cycleController(state: ClankersState, actions: SettingsPaneActions): string {
  const current = getControlController(state);
  const next: ClankersControlController = current === 'operator' ? 'pi' : current === 'pi' ? 'clankers' : 'operator';
  return actions.setController(next);
}

export function renderSettingsPane(state: ClankersState, uiState: ClankersManagementUiState, settingsState: SettingsPaneState, adapterKind: string, width: number, height: number, theme?: UiThemeLike, preferences?: ManagementUiPreferencesFacade, inputLines: string[] = []): string[] {
  if (settingsState.preferencesOpen && preferences) {
    const view = preferences.snapshot();
    const lines = [
      `Activity strip: ${view.activityStrip ? 'shown' : 'hidden'} (immediate)`,
      `Active: ${view.active ?? 'disabled/unavailable'}`,
      `Desired: ${view.desired ?? 'disabled'}${view.pending ? ' (pending /reload)' : ''}`,
      ...(view.reason ? [sanitizeUiText(view.reason)] : []),
      `Fallback: ${view.fallback}`,
      ...(view.alternative ? [`Validated alternate: ${view.alternative}`] : []),
      'Shortcut: type key, off, or default; Enter saves',
      ...inputLines,
      'Ctrl+v strip | Esc back; shortcut changes require /reload',
    ];
    return renderPane(lines, { title: '2 UI preferences', focused: uiState.focusedPane === 'settings', width, height, theme });
  }
  const pending = getPendingPermissionRows(state);
  settingsState.pendingCursor = pending.length === 0 ? 0 : Math.max(0, Math.min(settingsState.pendingCursor, pending.length - 1));
  const controller = getControlController(state);
  const readOnly = state.mode.readOnly ? styleText(theme, 'warning', 'on') : styleText(theme, 'success', 'off');
  const mode = styleText(theme, state.mode.automation === 'automatic' ? 'warning' : state.mode.automation === 'assisted' ? 'accent' : 'muted', sanitizeUiText(state.mode.automation));
  const lines = [
    `${styleText(theme, 'accent', 'Mode')} ${mode}   ${styleText(theme, 'accent', 'Read-only')} ${readOnly}`,
    `${styleText(theme, 'accent', 'Controller')} ${controller}   ${styleText(theme, 'accent', 'Adapter')} ${sanitizeUiText(adapterKind)}`,
    `Selected: ${sanitizeUiText(uiState.selectedTargetKind ?? 'none')} ${sanitizeUiText(uiState.selectedTargetId)}`.trim(),
    '',
    preferences ? 'Quick keys: o UI preferences (when settings focused)' : 'Quick keys:',
    '  r read-only   m manual   a assisted   u automatic   c controller',
    '',
    `Pending approvals (${pending.length})`,
  ];

  if (pending.length === 0) {
    lines.push('  none');
  } else {
    for (let index = 0; index < Math.min(pending.length, Math.max(1, height - 12)); index += 1) {
      const request = pending[index]!;
      lines.push(`${index === settingsState.pendingCursor ? '>' : ' '} ${sanitizeUiText(request.id)} [${sanitizeUiText(request.kind)}] ${sanitizeUiText(request.summary)}`);
    }
    lines.push('p approve selected | d deny selected (press twice to confirm)');
  }
  if (settingsState.confirmation) {
    lines.push(`confirm: press ${settingsState.confirmation.action === 'approve' ? 'p' : 'd'} again for ${sanitizeUiText(settingsState.confirmation.requestId)}`);
  }

  return renderPane(lines, { title: '2 Settings', focused: uiState.focusedPane === 'settings', width, height, theme });
}

function getControlController(state: ClankersState): ClankersControlController {
  const candidate = state.extensions.clankersControl as { controller?: unknown } | undefined;
  return candidate?.controller === 'pi' || candidate?.controller === 'clankers' || candidate?.controller === 'operator'
    ? candidate.controller
    : 'operator';
}
