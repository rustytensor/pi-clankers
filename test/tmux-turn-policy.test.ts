import assert from 'node:assert/strict';
import test from 'node:test';
import { createTmuxTurnBudget } from '../tmux-worker-policy.js';
import { parseTmuxMaxTurns, parseTmuxWorkerConfig } from '../tmux-worker-config.js';
import { resolveTmuxToolPolicy } from '../tmux-mcp.js';

test('two-request budget blocks third before dispatch and explicitly resets for next job', () => {
  const budget = createTmuxTurnBudget(2);
  let dispatched = 0;
  const call = () => { budget.consume(); dispatched++; };
  call(); call();
  if (process.env.CLANKERS_TMUX_TURNS_PLANTED_FAULT === '1') budget.reset();
  assert.throws(call, /maxTurns exhausted/);
  assert.equal(dispatched, 2);
  assert.throws(call, /maxTurns exhausted/);
  budget.reset(); call();
  assert.equal(dispatched, 3);
  assert.throws(() => parseTmuxMaxTurns(0), /maxTurns/);
  assert.throws(() => parseTmuxMaxTurns('2'), /maxTurns/);
  assert.throws(() => parseTmuxMaxTurns(1025), /maxTurns/);
  const config = parseTmuxWorkerConfig({ version: 1, workerId: 'w', generation: 'g', ownerNonce: 'a'.repeat(64), cwd: '/srv/devops/cwd', agentDir: '/srv/devops/agent', runDir: '/srv/devops/run', sessionDir: '/srv/devops/run/sessions', socketPath: '/srv/devops/run/sock', readyPath: '/srv/devops/run/ready', sdkModulePath: '/srv/devops/sdk.js', parentPid: 2, modelSpec: 'fixture/fixed', maxTurns: 2, definitionPrompt: '', tools: ['fixture_custom'], disallowedTools: [] });
  assert.equal(config.maxTurns, 2);
  assert.deepEqual(config.tools, ['fixture_custom']);
  assert.equal(Object.isFrozen(config), true);
  assert.deepEqual(resolveTmuxToolPolicy(['fixture_custom', 'clankers_control', 'larra_zerg_control', 'write'], ['write']).tools, ['fixture_custom']);
  assert.throws(() => resolveTmuxToolPolicy(['mcp__other__write']), /Unsupported/);
  // This tests data admission and the pre-dispatch counter, not SDK settlement.
  // Trusted extension existence/exact callable policy is attested by child readiness.
});
