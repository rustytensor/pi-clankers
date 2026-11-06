import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { createZergState, createZergStateContainer, upsertAgentDefinition } from '../state.js';
import { AGENT_RESULTS_KEY, type AgentResultLedger } from '../agent-results.js';

const fakePath = fileURLToPath(new URL('./fixtures/tmux-multiworker-fake.ts', import.meta.url));
const jiti = createJiti(import.meta.url, { fsCache: false, alias: { './tmux-runner.js': fakePath, './tmux-worker-policy.js': fakePath } });
const { createTmuxControl } = await jiti.import<typeof import('../tmux-control.js')>('../tmux-control.ts');
const fake = await jiti.import<typeof import('./fixtures/tmux-multiworker-fake.js')>(fakePath);
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await tick();
  assert.ok(check(), 'controller deadline');
}
test('controller preserves full large result, exact live output, frozen reporting policy and observed metrics', async () => {
  fake.launches.length = 0;
  const state = createZergStateContainer({ mode: { ...createZergState().mode, automation: 'automatic', readOnly: false } });
  const definition = { id: 'fixture', label: 'Fixture', source: 'user' as const, prompt: 'Synthetic only.', tools: [], model: 'fixture/fixed', may_write: ['src/**'] };
  state.replace(upsertAgentDefinition(state.read(), definition));
  const control = createTmuxControl(state, { cwd: '/unused', trusted: { sdkModulePath: '/unused/sdk.js', agentDir: '/unused/agent' }, ids: () => ({ runId: 'r', taskId: 't' }), assertAuthority() {} });
  let worker: ReturnType<typeof fake.fakeWorker> | undefined;
  try {
    control.start({ backend: 'tmux', agent: 'fixture', task: 'x'.repeat(10000), background: true });
    await until(() => fake.launches.length === 1);
    worker = fake.fakeWorker(fake.launches[0].options.workerId!);
    fake.launches[0].gate.resolve(worker.handle);
    await until(() => worker!.calls.prompts === 1);
    const job = worker.ledger.snapshot().job!;
    worker.ledger.observe(job, [{ type: 'text', text: 'working' }]);
    const live = await control.show(worker.handle.workerId, job.jobId);
    assert.equal(live.liveOutput?.text, 'working');
    assert.ok(!JSON.stringify(live).includes('ownerNonce'));
    assert.deepEqual(live.boundPolicy.may_write, ['src/**']);
    // Registry edits do not retrospectively broaden the already-bound reporting policy.
    state.replace(upsertAgentDefinition(state.read(), { ...definition, may_write: ['**'] }));
    const text = 'z'.repeat(10000);
    worker.settle(text, 'completed', { telemetry: { tokens: { input: 10, output: 4, cache_read: 2, cache_write: 0 }, context_percent: 12, elapsed_seconds: 3 }, toolEvidence: { files_changed: ['src/a.ts', 'outside.ts'], evidence_complete: false, evidence_reasons: ['Tool-event observations only.'] } });
    await control.awaitRun('r');
    const result = (state.read().extensions[AGENT_RESULTS_KEY] as AgentResultLedger).records[0];
    assert.equal(result.final_message, text);
    assert.equal(result.full_available, true);
    assert.deepEqual(result.files_changed, ['src/a.ts', 'outside.ts']);
    assert.deepEqual(result.files_outside_allowed, ['outside.ts']);
    assert.equal(result.evidence_complete, false);
    assert.deepEqual(result.tokens, { input: 10, output: 4, cache_read: 2, cache_write: 0 });
    assert.equal(result.elapsed_seconds, 3);
    assert.equal(result.context_percent, 12);
    assert.equal((await control.show(worker.handle.workerId, job.jobId)).liveOutput, null);
  } finally { control.dispose(); worker?.finishClose(); await control.drain(); }
});
