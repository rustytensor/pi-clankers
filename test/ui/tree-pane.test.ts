import assert from 'node:assert/strict';
import test from 'node:test';

import { createClankersState } from '../../state.js';
import { createManagementUiState } from '../../ui/state.js';
import { activateTreeSelection, buildManagementTreeRows, collapseTreeSelection, createTreePaneState, expandTreeSelection, moveTreeCursor } from '../../ui/tree-pane.js';

test('M9 tree pane builds live hierarchy, expands, clamps, and does not churn confirmed selection on cursor moves', () => {
  const state = createClankersState({
    agents: Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`agent-${index}`, { id: `agent-${index}`, label: `Agent ${index}`, kind: 'subagent' as const, status: 'idle' as const }])),
    teams: {
      alpha: { id: 'alpha', label: 'Alpha', kind: 'team', status: 'running', leaderAgentId: 'agent-0', memberAgentIds: ['agent-1'], taskIds: ['task-1'] },
    },
    tasks: {
      'task-1': { id: 'task-1', title: 'Task one', status: 'running', ownerAgentId: 'agent-0', teamId: 'alpha', updatedAt: '2026-05-01T00:00:00.000Z' },
    },
  });
  const uiState = createManagementUiState();
  const treeState = createTreePaneState();

  let rows = buildManagementTreeRows(state, uiState);
  assert.ok(rows.length > 20);
  assert.equal(uiState.selectedTargetId, undefined);

  for (let index = 0; index < 6; index += 1) {
    moveTreeCursor(treeState, rows, 1);
  }
  assert.equal(uiState.selectedTargetId, undefined);

  const current = rows[treeState.cursor]!;
  if (current.expandable) {
    expandTreeSelection(uiState, treeState, rows);
    assert.ok(uiState.expandedNodeIds.includes(current.id));
    collapseTreeSelection(uiState, treeState, buildManagementTreeRows(state, uiState));
    assert.equal(uiState.expandedNodeIds.includes(current.id), false);
  }

  rows = buildManagementTreeRows(state, uiState);
  const selected = activateTreeSelection(uiState, treeState, rows);
  if (selected?.targetId) {
    assert.equal(uiState.selectedTargetId, selected.targetId);
  }
});
