import assert from 'node:assert/strict';
import test from 'node:test';

import { createClankersState } from '../../state.js';
import { sendChatDraft } from '../../ui/chat-pane.js';
import { createManagementUiState, setSelectedTarget } from '../../ui/state.js';

test('M9 chat pane records honest local/intervention delivery states without fake delivered status', () => {
  const state = createClankersState({
    agents: {
      leader: { id: 'leader', label: 'Leader', kind: 'team-leader', status: 'running' },
    },
    teams: {
      alpha: { id: 'alpha', label: 'Alpha', kind: 'team', status: 'running', leaderAgentId: 'leader', memberAgentIds: ['leader'] },
      empty: { id: 'empty', label: 'Empty', kind: 'team', status: 'idle', memberAgentIds: [] },
    },
  });
  const uiState = createManagementUiState();
  const calls: Array<{ id: string; kind: string; body: string }> = [];
  const actions = {
    now: () => new Date('2026-05-01T00:00:00.000Z'),
    sendOperatorMessage: (target: { id: string; kind: 'agent' | 'team' | 'task' }, body: string) => {
      calls.push({ ...target, body });
      if (target.id === 'empty') {
        return { status: 'transport-unavailable' as const, statusDetail: 'Team empty has no leader; retained locally.' };
      }
      return { status: 'intervention-recorded' as const, statusDetail: 'intervention recorded; not delivered as chat transport.', routedTargetId: target.kind === 'team' ? 'leader' : target.id };
    },
  };

  setSelectedTarget(uiState, 'alpha', 'team');
  uiState.chatDraft = 'hello leader';
  assert.equal(sendChatDraft(state, uiState, actions), 'intervention recorded; not delivered as chat transport.');
  assert.equal(uiState.messages[0]?.status, 'intervention-recorded');
  assert.notEqual(uiState.messages[0]?.status, 'delivered');
  assert.equal(uiState.messages[0]?.routedTargetId, 'leader');

  setSelectedTarget(uiState, 'empty', 'team');
  uiState.chatDraft = 'hello?';
  assert.equal(sendChatDraft(state, uiState, actions), 'Team empty has no leader; retained locally.');
  assert.equal(uiState.messages[1]?.status, 'transport-unavailable');
  assert.equal(calls.length, 2);
});
