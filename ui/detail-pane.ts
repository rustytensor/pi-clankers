import type { ClankersManagementTargetKind, ClankersManagementUiState, ClankersPermissionRequest, ClankersState } from '../types.js';
import { fitRawLine, healthGlyph, renderPane, sanitizeUiText, styleText, type UiThemeLike } from './components.js';

export function resolveSelectedTarget(state: ClankersState, uiState: ClankersManagementUiState): { id: string; kind: ClankersManagementTargetKind } | undefined {
  if (uiState.selectedTargetId && uiState.selectedTargetKind) {
    return { id: uiState.selectedTargetId, kind: uiState.selectedTargetKind };
  }
  if (state.selectedNodeId) {
    const node = state.tree[state.selectedNodeId];
    if (node?.refId && (node.kind === 'agent' || node.kind === 'team' || node.kind === 'task')) {
      return { id: node.refId, kind: node.kind };
    }
  }
  return undefined;
}

export function renderDetailPane(state: ClankersState, uiState: ClankersManagementUiState, width: number, height: number, theme?: UiThemeLike): string[] {
  const selected = resolveSelectedTarget(state, uiState);
  const lines: string[] = [];
  if (!selected) {
    lines.push('No target selected yet. Use Select pane, then Enter.');
    lines.push(`lifecycle: ${state.lifecycle}`);
    lines.push(`revision: ${state.revision}`);
    lines.push(`mode: ${state.mode.automation} | read-only: ${state.mode.readOnly ? 'on' : 'off'}`);
    lines.push(...latestGlobalSignals(state));
    const clean = lines.map(sanitizeUiText);
    clean[0] = styleText(theme, 'warning', clean[0]!);
    return renderPane(clean, { title: 'Details', focused: uiState.focusedPane === 'detail', width, height, theme });
  }

  if (selected.kind === 'agent') {
    const agent = state.agents[selected.id];
    if (!agent) {
      lines.push(`Agent ${selected.id} no longer exists.`);
    } else {
      lines.push(`agent: ${agent.label} (${agent.id})`);
      lines.push(`kind/status: ${agent.kind} / ${agent.status}`);
      lines.push(`substate: ${agent.runtime?.substate ?? 'none'} | health: ${healthGlyph(agent.runtime?.health)}`);
      lines.push(`activity: ${agent.runtime?.lastActivity ?? 'none'}`);
      lines.push(`team: ${agent.teamId ?? 'none'} | parent: ${agent.parentId ?? 'none'}`);
      lines.push(`context: ${agent.contextId ?? agent.runtime?.mode.contextId ?? 'none'}`);
      lines.push(...targetPermissionLines(state, selected.id));
      lines.push(...targetLogLines(state, selected.id, 'agent'));
    }
  } else if (selected.kind === 'team') {
    const team = state.teams[selected.id];
    if (!team) {
      lines.push(`Team ${selected.id} no longer exists.`);
    } else {
      lines.push(`team: ${team.label} (${team.id})`);
      lines.push(`kind/status: ${team.kind} / ${team.status}`);
      lines.push(`leader: ${team.leaderAgentId ?? 'none'} | members: ${team.memberAgentIds.length}`);
      lines.push(`tasks: ${team.taskIds?.length ?? 0}`);
      lines.push(`substate: ${team.runtime?.substate ?? 'none'} | health: ${healthGlyph(team.runtime?.health)}`);
      lines.push(`activity: ${team.runtime?.lastActivity ?? 'none'}`);
      lines.push(...targetPermissionLines(state, selected.id));
      lines.push(...targetLogLines(state, selected.id, 'team'));
    }
  } else {
    const task = state.tasks[selected.id];
    if (!task) {
      lines.push(`Task ${selected.id} no longer exists.`);
    } else {
      lines.push(`task: ${task.title} (${task.id})`);
      lines.push(`status/substate: ${task.status} / ${task.substate ?? 'none'}`);
      lines.push(`owner: ${task.ownerAgentId ?? 'none'} | team: ${task.teamId ?? 'none'}`);
      lines.push(`updated: ${task.updatedAt}`);
      lines.push(`blocked-by: ${(task.blockedBy ?? []).join(', ') || 'none'}`);
      lines.push(...targetPermissionLines(state, selected.id));
      lines.push(...targetLogLines(state, selected.id, 'task'));
    }
  }

  const clean = lines.map(sanitizeUiText);
  clean.push(styleText(theme, 'dim', 'view: t scoped team timeline · v read-only coding chooser'));
  clean.push(styleText(theme, 'dim', 'action: i interrupts selected active run/agent'));
  return renderPane(clean.map((line) => fitRawLine(line, width - 4)), { title: 'Details', focused: uiState.focusedPane === 'detail', width, height, theme });
}

function targetPermissionLines(state: ClankersState, targetId: string): string[] {
  const requests = readPermissions(state).filter((request) => request.targetId === targetId || request.agentId === targetId || request.runId === targetId).slice(-4).reverse();
  if (requests.length === 0) {
    return ['permissions: none for target'];
  }
  return ['permissions:', ...requests.map((request) => `  ${request.id} [${request.status}/${request.kind}] ${request.summary}`)];
}

function targetLogLines(state: ClankersState, targetId: string, kind: ClankersManagementTargetKind): string[] {
  const records = readLogs(state).filter((record) => {
    if (kind === 'agent') return record.agentId === targetId || record.runId === targetId;
    if (kind === 'team') return record.teamId === targetId;
    return record.taskId === targetId;
  }).slice(-5).reverse();
  if (records.length === 0) {
    return ['logs: none for target'];
  }
  return ['logs:', ...records.map((record) => `  ${record.id} [${record.level}/${record.source}] ${record.message}`)];
}

function latestGlobalSignals(state: ClankersState): string[] {
  const permissions = readPermissions(state).filter((request) => request.status === 'pending');
  const warnings = readLogs(state).filter((record) => record.level === 'warn' || record.level === 'error');
  const lines = [`pending permissions: ${permissions.length}`];
  if (permissions.at(-1)) {
    const latest = permissions.at(-1)!;
    lines.push(`latest permission: ${latest.id} ${latest.summary}`);
  }
  lines.push(`warnings/errors: ${warnings.length}`);
  if (warnings.at(-1)) {
    const latest = warnings.at(-1)!;
    lines.push(`latest warning: ${latest.id} ${latest.message}`);
  }
  return lines;
}

function readPermissions(state: ClankersState): ClankersPermissionRequest[] {
  const candidate = state.extensions.clankersPermissions;
  if (!candidate || typeof candidate !== 'object' || !Array.isArray((candidate as { requests?: unknown }).requests)) {
    return [];
  }
  return (candidate as { requests: ClankersPermissionRequest[] }).requests;
}

function readLogs(state: ClankersState): Array<{ id: string; level: string; source: string; message: string; runId?: string; agentId?: string; teamId?: string; taskId?: string }> {
  const candidate = state.extensions.clankersLogs;
  if (!candidate || typeof candidate !== 'object' || !Array.isArray((candidate as { records?: unknown }).records)) {
    return [];
  }
  return (candidate as { records: Array<{ id: string; level: string; source: string; message: string; runId?: string; agentId?: string; teamId?: string; taskId?: string }> }).records;
}
