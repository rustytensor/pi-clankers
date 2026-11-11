import type { ClankersManagementUiState, ClankersState } from '../types.js';
import { fitRawLine, sanitizeUiText, styleText, type UiThemeLike } from './components.js';

export function renderManagementFooter(state: ClankersState, uiState: ClankersManagementUiState, adapterKind: string, width: number, theme?: UiThemeLike): string[] {
  const mode = `${sanitizeUiText(state.mode.automation)}${state.mode.readOnly ? '/read-only' : ''}`;
  const selected = uiState.selectedTargetId ? `${sanitizeUiText(uiState.selectedTargetKind)}:${sanitizeUiText(uiState.selectedTargetId)}` : 'none';
  const clankersControl = state.extensions.clankersControl as { controller?: unknown } | undefined;
  const controller = clankersControl?.controller === 'pi' || clankersControl?.controller === 'clankers' || clankersControl?.controller === 'operator'
    ? clankersControl.controller : sanitizeUiText(state.mode.controller);
  return [
    fitRawLine(`${styleText(theme, 'muted', 'Focus')} ${styleText(theme, 'accent', sanitizeUiText(uiState.focusedPane))}  ${styleText(theme, 'muted', 'Selected')} ${selected}  ${styleText(theme, 'muted', 'Controller')} ${controller}  ${styleText(theme, 'muted', 'Mode')} ${mode}  ${styleText(theme, 'muted', 'Adapter')} ${sanitizeUiText(adapterKind)}  ${styleText(theme, 'muted', 'Rev')} ${sanitizeUiText(state.revision)}`, width),
    fitRawLine(`${styleText(theme, 'dim', 'Keys')} Tab focus · ↑↓ move · Enter select/send · r read-only · m/a/u mode · c controller · p/d approve/deny · i interrupt · Ctrl+X clear · q/Esc close`, width),
    ...(uiState.statusMessage ? [fitRawLine(`${styleText(theme, 'accent', 'Status')} ${sanitizeUiText(uiState.statusMessage)}`, width)] : []),
  ];
}
