import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { createJiti } from 'jiti';
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent';
import { prepareTmuxContinuationPolicy } from '../tmux-worker-policy.js';
import { createZergState, createZergStateContainer, upsertAgentDefinition } from '../state.js';

// ANSWER=42 is settled source DATA. The only new assignment is Explain only.
// Actual control and installed SDK metadata resolver; only process transport is fake.
test('continuation retains exact closed source, inventories local managed resources, and launches only a confirmed current review', async () => {
  const root = await mkdtemp('/srv/devops/scratch/clankers-continuation-control-');
  const home = process.env.HOME;
  const cwd = join(root, 'cwd'), agentDir = join(root, 'agent');
  await mkdir(join(cwd, '.pi'), { recursive: true });
  await mkdir(agentDir);
  process.env.HOME = join(root, 'home');
  const sdkModulePath = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const packageRoot = join(cwd, '.pi', 'npm', 'node_modules', 'synthetic-continuation');
  await mkdir(packageRoot, { recursive: true });
  const code = join(packageRoot, 'extension.js');
  const manifest = { name: 'synthetic-continuation', version: '1.0.0', type: 'module', pi: { extensions: ['./extension.js'] } };
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest));
  await writeFile(code, 'export default function () { throw new Error("FACTORY MUST NOT RUN DURING PREPARE"); }');
  const globalSettings = join(agentDir, 'settings.json'), projectSettings = join(cwd, '.pi', 'settings.json');
  // Project identity wins BEFORE mapping; the user copy intentionally is not installed.
  const originalGlobal = JSON.stringify({ packages: ['npm:synthetic-continuation@0.5.0'] });
  const originalProject = JSON.stringify({ packages: [{ source: 'npm:synthetic-continuation@1.0.0', extensions: ['extension.js'] }] });
  await writeFile(globalSettings, originalGlobal); await writeFile(projectSettings, originalProject);
  new ProjectTrustStore(agentDir).set(cwd, true);
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { synthetic: { api: 'openai-completions', baseUrl: 'https://synthetic.invalid', models: [{ id: 'fixed', input: ['text'], contextWindow: 4096, maxTokens: 128 }] } } }));
  const state = createZergStateContainer({ mode: { ...createZergState().mode, automation: 'automatic', readOnly: false } });
  const definition = { id: 'solo', label: 'Solo', source: 'user' as const, prompt: 'Preserve caller scope.', tools: [], model: 'synthetic/fixed' };
  state.replace(upsertAgentDefinition(state.read(), definition));
  const fakePath = fileURLToPath(new URL('./fixtures/tmux-multiworker-fake.ts', import.meta.url));
  const jiti = createJiti(import.meta.url, { fsCache: false, alias: { './tmux-runner.js': fakePath } });
  const { createTmuxControl } = await jiti.import<typeof import('../tmux-control.js')>('../tmux-control.ts');
  const fake = await jiti.import<typeof import('./fixtures/tmux-multiworker-fake.js')>(fakePath);
  fake.launches.length = 0;
  let serial = 0;
  const control = createTmuxControl(state, { cwd, trusted: { agentDir, sdkModulePath }, assertAuthority() {}, ids: () => ({ runId: `run-${++serial}`, taskId: `task-${serial}` }) });
  const handles: ReturnType<typeof fake.fakeWorker>[] = [];
  const wait = async (condition: () => boolean) => { for (let n = 0; n < 500 && !condition(); n++) await pause(10); assert.ok(condition(), 'bounded transport boundary reached'); };
  const open = async (index: number) => {
    await wait(() => fake.launches.length > index);
    const launch = fake.launches[index]; launch.options.assertAdmission?.();
    const worker = fake.fakeWorker(launch.options.workerId!); handles.push(worker);
    launch.gate.resolve(worker.handle);
    await wait(() => worker.calls.prompts === 1);
    return worker;
  };
  try {
    const initial = control.start({ agent: 'solo', task: 'Return ANSWER=42 only.' });
    const old = await open(0);
    const settled = old.settle(process.env.CLANKERS_CONTINUATION_PLANTED_FAULT === '1' ? 'ANSWER=41' : 'ANSWER=42');
    await control.awaitRun(initial.runId!);
    const oldRecord = structuredClone(state.read().agents[initial.runId!]);
    const closing = control.close(old.handle.workerId); old.finishClose(); await closing;
    assert.equal((await control.list()).length, 0);
    const revision = state.read().revision;
    const review = await control.prepare(old.handle.workerId, settled.identity.jobId, 'Explain only.');
    assert.equal(state.read().revision, revision, 'prepare does not publish state');
    assert.equal(fake.launches.length, 1, 'prepare allocates zero workers');
    assert.equal(review.resultContext, 'ANSWER=42');
    assert.equal(review.originalTask, 'Return ANSWER=42 only.');
    assert.equal(review.task, 'Explain only.');
    assert.equal(JSON.stringify(review).includes('ownerNonce'), false);
    assert.equal(await readFile(globalSettings, 'utf8'), originalGlobal);
    assert.equal(await readFile(projectSettings, 'utf8'), originalProject);
    await assert.rejects(control.prepare(old.handle.workerId, 'wrong-job', 'Explain only.'), /Exact retained/);
    const launched = await control.startContinuation(review.reviewId, true);
    await assert.rejects(control.startContinuation(review.reviewId, true), /consumed/);
    const fresh = await open(1);
    assert.notEqual(fresh.handle.sessionId, old.handle.sessionId);
    assert.notEqual(launched.runId, initial.runId);
    assert.equal(state.read().tasks[launched.taskId!].title, 'Explain only.');
    fresh.settle('42 is the supplied answer.'); await control.awaitRun(launched.runId!);
    assert.deepEqual(state.read().agents[initial.runId!], oldRecord, 'source state immutable');
    const drift = await control.prepare(old.handle.workerId, settled.identity.jobId, 'Explain only.');
    await writeFile(code, 'export default function () { return 43; }');
    await assert.rejects(control.startContinuation(drift.reviewId, true), /changed/);
    assert.equal(fake.launches.length, 2, 'drift allocates zero workers');
    const readonly = await control.prepare(old.handle.workerId, settled.identity.jobId, 'Explain only.');
    state.update({ mode: { ...state.read().mode, readOnly: true } });
    await assert.rejects(control.startContinuation(readonly.reviewId, true), /read-only/);
    assert.equal(fake.launches.length, 2);
    await assert.rejects(control.close(fresh.handle.workerId), /read-only/);
    state.update({ mode: { ...state.read().mode, readOnly: false } });
    const closeFresh = control.close(fresh.handle.workerId); fresh.finishClose(); await closeFresh;
    await writeFile(code, "import fs from 'node:fs'; export default function () {}");
    await assert.rejects(control.prepare(old.handle.workerId, settled.identity.jobId, 'Explain only.'), /Unsupported policy dependency/);
    await writeFile(code, 'export default function () {}');
    const input = { cwd, agentDir, modelSpec: definition.model, definitionPrompt: definition.prompt, tools: [], disallowedTools: [] };
    const policy = await prepareTmuxContinuationPolicy(sdkModulePath, input, () => definition);
    await writeFile(join(cwd, 'AGENTS.md'), 'New context');
    assert.notEqual(policy.read().digest, policy.snapshot.digest, 'formerly absent context root invalidates');
    await writeFile(projectSettings, JSON.stringify({ packages: [{ source: 'npm:synthetic-continuation', autoload: false }] }));
    await assert.rejects(prepareTmuxContinuationPolicy(sdkModulePath, input, () => definition), /autoload/);
    await writeFile(projectSettings, '{}');
    await assert.rejects(prepareTmuxContinuationPolicy(sdkModulePath, input, () => definition), /Unmanaged/);
  } finally {
    for (const handle of handles) handle.finishClose();
    control.dispose(); await control.drain();
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    await rm(root, { recursive: true, force: true });
  }
});

// Independent discovery counterexample: a new HOME would otherwise load a different
// global skills tree while every previously captured file remained unchanged.
test('inventory refuses changed loader roots and linked-worktree context', async () => {
  const root = await mkdtemp('/srv/devops/scratch/clankers-continuation-roots-');
  const home = process.env.HOME;
  process.env.HOME = join(root, 'home');
  const cwd = join(root, 'cwd'), agentDir = join(root, 'agent');
  await mkdir(cwd); await mkdir(agentDir);
  const definition = { id: 'solo', label: 'Solo', source: 'user' as const, prompt: 'synthetic', model: 'synthetic/fixed' };
  try {
    const policy = await prepareTmuxContinuationPolicy(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')), { cwd, agentDir, modelSpec: definition.model, definitionPrompt: definition.prompt, tools: [], disallowedTools: [] }, () => definition);
    process.env.HOME = join(root, 'different-home');
    assert.throws(policy.read, /Loader environment changed/);
    process.env.HOME = join(root, 'home');
    await writeFile(join(cwd, '.git'), 'gitdir: /synthetic/unavailable');
    assert.throws(policy.read, /Linked worktree/);
  } finally {
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    await rm(root, { recursive: true, force: true });
  }
});

// Fixed oracle: revoke after process creation but before prompt. Observation may
// fail the exact live job, never execute or write through a replaced/disposed owner.
test('continuation startup failure observes only the live exact owner after revocation', async () => {
  const root = await mkdtemp('/srv/devops/scratch/clankers-terminal-');
  const home = process.env.HOME;
  const cwd = join(root, 'cwd'), agentDir = join(root, 'agent');
  await mkdir(cwd); await mkdir(agentDir);
  process.env.HOME = join(root, 'home');
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({ providers: { synthetic: { api: 'openai-completions', baseUrl: 'https://synthetic.invalid', models: [{ id: 'fixed', input: ['text'], contextWindow: 4096, maxTokens: 128 }] } } }));
  const state = createZergStateContainer({ mode: { ...createZergState().mode, automation: 'automatic', readOnly: false } });
  state.replace(upsertAgentDefinition(state.read(), { id: 'solo', label: 'Solo', source: 'user', prompt: 'Synthetic only.', tools: [], model: 'synthetic/fixed' }));
  const fakePath = fileURLToPath(new URL('./fixtures/tmux-multiworker-fake.ts', import.meta.url));
  const jiti = createJiti(import.meta.url, { fsCache: false, alias: { './tmux-runner.js': fakePath } });
  const { createTmuxControl } = await jiti.import<typeof import('../tmux-control.js')>('../tmux-control.ts');
  const fake = await jiti.import<typeof import('./fixtures/tmux-multiworker-fake.js')>(fakePath);
  fake.launches.length = 0;
  const { AGENT_RESULTS_KEY } = await import('../agent-results.js');
  let serial = 0, notices = 0;
  let onAuthority: (() => void) | undefined;
  const control = createTmuxControl(state, { cwd, trusted: { agentDir, sdkModulePath: fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')) }, assertAuthority() { onAuthority?.(); }, ids: () => ({ runId: `terminal-${++serial}`, taskId: `task-${serial}` }), captureNotice: () => () => { notices++; return 'unavailable'; } });
  const handles: ReturnType<typeof fake.fakeWorker>[] = [];
  const wait = async (predicate: () => boolean) => { for (let n = 0; n < 500 && !predicate(); n++) await pause(10); assert.ok(predicate(), 'bounded boundary'); };
  try {
    const source = control.start({ agent: 'solo', task: 'Return ANSWER=42.' });
    await wait(() => fake.launches.length === 1);
    const old = fake.fakeWorker(fake.launches[0].options.workerId!); handles.push(old);
    fake.launches[0].gate.resolve(old.handle);
    await wait(() => old.calls.prompts === 1);
    const result = old.settle('ANSWER=42'); await control.awaitRun(source.runId!);
    const closing = control.close(old.handle.workerId); old.finishClose(); await closing;
    const sourceState = structuredClone(state.read().agents[source.runId!]);
    const sourceNotices = notices;
    // Three actual control inputs, not a permission/transport matrix.
    for (const scenario of ['readonly', 'replaced', 'disposed'] as const) {
      state.update({ mode: { ...state.read().mode, readOnly: false } });
      const review = await control.prepare(old.handle.workerId, result.identity.jobId, 'Explain only.');
      const admitted = await control.startContinuation(review.reviewId, true);
      await wait(() => fake.launches.length === serial);
      const launch = fake.launches.at(-1)!;
      launch.options.assertAdmission?.();
      const worker = fake.fakeWorker(launch.options.workerId!); handles.push(worker);
      state.update({ mode: { ...state.read().mode, readOnly: true } });
      let protectedState: ReturnType<typeof state.read> | undefined;
      onAuthority = () => {
        onAuthority = undefined;
        if (scenario === 'replaced') {
          const current = state.read(), agent = current.agents[admitted.runId!];
          state.replace({ ...current, agents: { ...current.agents, [admitted.runId!]: { ...agent, metadata: { ...agent.metadata, tmuxJobId: 'replacement-job' } } } });
          protectedState = structuredClone(state.read());
        } else if (scenario === 'disposed') {
          control.dispose();
          protectedState = structuredClone(state.read());
        }
      };
      launch.gate.resolve(worker.handle);
      await control.awaitRun(admitted.runId!);
      await wait(() => worker.calls.closes === 1);
      assert.equal(worker.calls.prompts, 0, 'zero continuation prompts/provider dispatch');
      assert.equal(notices, sourceNotices, 'read-only failure must not send a notice');
      assert.equal((await control.list()).length, 1, 'cleanup-pending slot stays reserved');
      const retained = control.retainedResults().find(row => row.run_id === admitted.runId);
      assert.equal(retained?.state, 'failed');
      assert.equal(retained?.task_id, admitted.taskId);
      assert.equal(retained?.member_run_id, admitted.runId);
      if (scenario === 'readonly') {
        assert.equal(state.read().agents[admitted.runId!].status, 'failed');
        assert.equal(state.read().tasks[admitted.taskId!].status, 'failed');
        const ledger = state.read().extensions[AGENT_RESULTS_KEY] as import('../agent-results.js').AgentResultLedger;
        assert.deepEqual(ledger.records.find(row => row.run_id === admitted.runId), retained);
        await assert.rejects(control.close(worker.handle.workerId), /read-only/);
      } else assert.deepEqual(state.read(), protectedState, 'zero writes into replaced/disposed owner');
      assert.deepEqual(state.read().agents[source.runId!], sourceState);
      worker.finishClose(); await control.drain();
      assert.equal((await control.list()).length, 0);
      assert.equal(worker.calls.closes, 1);
    }
  } finally {
    onAuthority = undefined;
    for (const handle of handles) handle.finishClose();
    control.dispose(); await control.drain();
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    await rm(root, { recursive: true, force: true });
  }
});

test('cancelled preflight consumes review without launching', async () => {
  const { createTmuxContinuationService, tmuxContinuationDigest } = await import('../tmux-continuation.js');
  const source = { key: { backend: 'tmux' as const, workerId: 'worker', sessionId: 'session', generation: 'generation', epoch: 0, jobId: 'job', runId: 'run', taskId: 'task', resultDigest: tmuxContinuationDigest('ANSWER=42') }, agentId: 'solo', originalTask: 'Return ANSWER=42', resultText: 'ANSWER=42', complete: true as const, settled: true as const };
  const abort = new AbortController();
  let launches = 0;
  const service = createTmuxContinuationService({ source: () => source, policy: () => ({ fixed: true }), assertAuthority() {}, async preflight() { await Promise.resolve(); abort.abort(); }, launch() { launches++; } });
  const review = service.prepare({ source: source.key, task: 'Explain only.' });
  await assert.rejects(service.start({ reviewId: review.reviewId, confirm: true }, abort.signal), /cancelled/);
  assert.equal(launches, 0);
  await assert.rejects(service.start({ reviewId: review.reviewId, confirm: true }), /consumed/);
  service.dispose();
});
