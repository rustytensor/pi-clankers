import type { ClankersManagementTargetKind, ClankersManagementUiState, ClankersState } from '../types.js';
import { fitRawLine, renderPane, sanitizeUiText, statusGlyph, styleText, type UiThemeLike, visibleSlice } from './components.js';
import { isExpanded, setExpanded, setSelectedTarget, toggleExpanded } from './state.js';

export interface ManagementTreeRow {
  id: string;
  label: string;
  depth: number;
  expandable: boolean;
  expanded: boolean;
  targetId?: string;
  targetKind?: ClankersManagementTargetKind;
  status?: string;
}

export interface TreePaneState {
  cursor: number;
  scrollOffset: number;
}

export function createTreePaneState(): TreePaneState {
  return { cursor: 0, scrollOffset: 0 };
}

export function buildManagementTreeRows(state: ClankersState, uiState: ClankersManagementUiState): ManagementTreeRow[] {
  const rows: ManagementTreeRow[] = [];
  const addRoot = (id: string, label: string, count: number) => {
    const expanded = isExpanded(uiState, id);
    rows.push({ id, label: `${label} (${count})`, depth: 0, expandable: count > 0, expanded });
    return expanded;
  };

  const teams = Object.values(state.teams).sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  if (addRoot('root:teams', 'Teams', teams.length)) {
    for (const team of teams) {
      const nodeId = `team:${team.id}`;
      const childCount = (team.leaderAgentId ? 1 : 0) + team.memberAgentIds.length + (team.taskIds?.length ?? 0);
      const expanded = isExpanded(uiState, nodeId);
      rows.push({ id: nodeId, label: `${team.label} [${team.kind}]`, depth: 1, expandable: childCount > 0, expanded, targetId: team.id, targetKind: 'team', status: team.runtime?.substate ?? team.status });
      if (expanded) {
        if (team.leaderAgentId) {
          const leader = state.agents[team.leaderAgentId];
          rows.push({ id: `${nodeId}:leader:${team.leaderAgentId}`, label: `leader ${leader?.label ?? team.leaderAgentId}`, depth: 2, expandable: false, expanded: false, targetId: team.leaderAgentId, targetKind: 'agent', status: leader?.runtime?.substate ?? leader?.status });
        }
        for (const agentId of team.memberAgentIds) {
          const agent = state.agents[agentId];
          rows.push({ id: `${nodeId}:agent:${agentId}`, label: `member ${agent?.label ?? agentId}`, depth: 2, expandable: false, expanded: false, targetId: agentId, targetKind: 'agent', status: agent?.runtime?.substate ?? agent?.status });
        }
        for (const taskId of team.taskIds ?? []) {
          const task = state.tasks[taskId];
          rows.push({ id: `${nodeId}:task:${taskId}`, label: `task ${task?.title ?? taskId}`, depth: 2, expandable: false, expanded: false, targetId: taskId, targetKind: 'task', status: task?.substate ?? task?.status });
        }
      }
    }
  }

  const agents = Object.values(state.agents).sort((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
  if (addRoot('root:agents', 'Agents', agents.length)) {
    for (const agent of agents) {
      const nodeId = `agent:${agent.id}`;
      const childIds = agent.childIds ?? [];
      const taskIds = Object.values(state.tasks).filter((task) => task.ownerAgentId === agent.id).map((task) => task.id).sort();
      const expanded = isExpanded(uiState, nodeId);
      rows.push({ id: nodeId, label: `${agent.label} [${agent.kind}]`, depth: 1, expandable: childIds.length + taskIds.length > 0, expanded, targetId: agent.id, targetKind: 'agent', status: agent.runtime?.substate ?? agent.status });
      if (expanded) {
        for (const childId of childIds) {
          const child = state.agents[childId];
          rows.push({ id: `${nodeId}:child:${childId}`, label: `child ${child?.label ?? childId}`, depth: 2, expandable: false, expanded: false, targetId: childId, targetKind: 'agent', status: child?.runtime?.substate ?? child?.status });
        }
        for (const taskId of taskIds) {
          const task = state.tasks[taskId];
          rows.push({ id: `${nodeId}:task:${taskId}`, label: `task ${task?.title ?? taskId}`, depth: 2, expandable: false, expanded: false, targetId: taskId, targetKind: 'task', status: task?.substate ?? task?.status });
        }
      }
    }
  }

  const tasks = Object.values(state.tasks).sort((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  if (addRoot('root:tasks', 'Tasks', tasks.length)) {
    for (const task of tasks) {
      rows.push({ id: `task:${task.id}`, label: task.title, depth: 1, expandable: false, expanded: false, targetId: task.id, targetKind: 'task', status: task.substate ?? task.status });
    }
  }

  return rows;
}

export function clampTreeCursor(treeState: TreePaneState, rowCount: number): void {
  treeState.cursor = rowCount === 0 ? 0 : Math.max(0, Math.min(treeState.cursor, rowCount - 1));
}

export function moveTreeCursor(treeState: TreePaneState, rows: readonly ManagementTreeRow[], direction: 1 | -1): void {
  clampTreeCursor(treeState, rows.length);
  treeState.cursor = rows.length === 0 ? 0 : Math.max(0, Math.min(treeState.cursor + direction, rows.length - 1));
}

export function collapseTreeSelection(uiState: ClankersManagementUiState, treeState: TreePaneState, rows: readonly ManagementTreeRow[]): void {
  const row = rows[treeState.cursor];
  if (!row) return;
  if (row.expandable && row.expanded) {
    setExpanded(uiState, row.id, false);
  }
}

export function expandTreeSelection(uiState: ClankersManagementUiState, treeState: TreePaneState, rows: readonly ManagementTreeRow[]): void {
  const row = rows[treeState.cursor];
  if (!row) return;
  if (row.expandable && !row.expanded) {
    setExpanded(uiState, row.id, true);
  }
}

export function activateTreeSelection(uiState: ClankersManagementUiState, treeState: TreePaneState, rows: readonly ManagementTreeRow[]): ManagementTreeRow | undefined {
  const row = rows[treeState.cursor];
  if (!row) return undefined;
  if (row.expandable && !row.targetId) {
    toggleExpanded(uiState, row.id);
    return row;
  }
  if (row.targetId && row.targetKind) {
    setSelectedTarget(uiState, row.targetId, row.targetKind);
  }
  return row;
}

export function renderTreePane(state: ClankersState, uiState: ClankersManagementUiState, treeState: TreePaneState, width: number, height: number, theme?: UiThemeLike): string[] {
  const rows = buildManagementTreeRows(state, uiState);
  clampTreeCursor(treeState, rows.length);
  const bodyHeight = Math.max(3, height - 4);
  const slice = visibleSlice(rows, treeState.cursor, bodyHeight);
  treeState.scrollOffset = slice.offset;
  const rendered = slice.rows.map((row, visibleIndex) => {
    const rowIndex = slice.offset + visibleIndex;
    const selected = rowIndex === slice.selectedIndex;
    const confirmed = row.targetId && row.targetId === uiState.selectedTargetId;
    const branch = row.expandable ? (row.expanded ? '▾' : '▸') : ' ';
    const depthMarker = row.depth === 0 ? '' : `${'›'.repeat(row.depth)} `;
    const cursor = selected ? styleText(theme, 'accent', '›') : ' ';
    const mark = confirmed ? styleText(theme, 'success', '●') : ' ';
    const glyph = styleText(theme, statusColor(row.status), statusGlyph(row.status));
    const prefix = `${cursor} ${depthMarker}${branch} ${mark}${glyph}`;
    return fitRawLine(`${prefix} ${sanitizeUiText(row.label)}`, width - 4);
  });
  if (rows.length === 0) {
    rendered.push('No agents, teams, or tasks.');
  }
  rendered.push(styleText(theme, 'dim', `rows ${rows.length === 0 ? '0/0' : `${slice.offset + 1}-${Math.min(rows.length, slice.offset + slice.rows.length)}/${rows.length}`} | Enter select | ←/→ expand`));
  return renderPane(rendered, { title: '1 Select', focused: uiState.focusedPane === 'tree', width, height, theme });
}

function statusColor(status?: string): string {
  if (status === 'done' || status === 'completed' || status === 'healthy') return 'success';
  if (status === 'failed' || status === 'cancelled') return 'error';
  if (status === 'blocked' || status === 'needs-attention' || status === 'degraded') return 'warning';
  if (status === 'running' || status === 'executing' || status === 'starting') return 'accent';
  return 'muted';
}
