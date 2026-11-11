import assert from 'node:assert/strict';
import test from 'node:test';

import { enqueuePermissionRequest, createClankersState } from '../../state.js';
import { applyPermissionFromSettings, createSettingsPaneState, cycleController, movePendingPermissionCursor } from '../../ui/settings-pane.js';
import type { AutomationMode, ClankersControlController } from '../../types.js';

test('M9 settings pane routes mode/controller/read-only and permission actions through callbacks', () => {
  const state = enqueuePermissionRequest(createClankersState(), {
    kind: 'run',
    targetId: 'agent-1',
    requester: 'operator',
    summary: 'Run agent',
  }, { id: 'perm-1', now: () => new Date('2026-05-01T00:00:00.000Z') });
  const settings = createSettingsPaneState();
  const calls: string[] = [];
  const actions = {
    toggleReadOnly: () => { calls.push('readonly'); return 'readonly toggled'; },
    setAutomation: (mode: AutomationMode) => { calls.push(`mode:${mode}`); return `mode ${mode}`; },
    setController: (controller: ClankersControlController) => { calls.push(`controller:${controller}`); return `controller ${controller}`; },
    approvePermission: (requestId: string) => { calls.push(`approve:${requestId}`); return `approved ${requestId}`; },
    denyPermission: (requestId: string) => { calls.push(`deny:${requestId}`); return `denied ${requestId}`; },
  };

  assert.equal(cycleController(state, actions), 'controller pi');
  assert.deepEqual(calls, ['controller:pi']);

  movePendingPermissionCursor(settings, state, 1);
  assert.equal(applyPermissionFromSettings(settings, state, 'approve', actions), 'press p again to approve perm-1');
  assert.equal(applyPermissionFromSettings(settings, state, 'approve', actions), 'approved perm-1');
  assert.deepEqual(calls.slice(-1), ['approve:perm-1']);

  assert.equal(applyPermissionFromSettings(settings, state, 'deny', actions), 'press d again to deny perm-1');
  assert.equal(applyPermissionFromSettings(settings, state, 'deny', actions), 'denied perm-1');
  assert.deepEqual(calls.slice(-1), ['deny:perm-1']);
});
