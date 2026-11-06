import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setImmediate as tick } from 'node:timers/promises';
import { createJiti } from 'jiti';
import { selectTmuxModel, attestTmuxModelSelection, preflightTmuxWorkerPolicy } from '../tmux-worker-policy.js';
import { tmuxModelCandidates, parseTmuxModelSelection } from '../tmux-worker-config.js';
import { createZergState, createZergStateContainer, upsertAgentDefinition } from '../state.js';

// Independent input: A is absent, B and C present. Request order C,B must
// select C, and B,C must select B, regardless of lexical/catalog order.
const descriptor = (id: string) => ({ provider: 'fixture', id, api: 'openai-completions', baseUrl: 'https://synthetic.invalid/v1' });
const physical = { B: descriptor('B'), C: descriptor('C') };
const catalog = (entries: Record<string, unknown> = physical) => ({ getError: () => undefined, getPhysicalModel: (_provider: string, id: string) => entries[id] }) as Parameters<typeof selectTmuxModel>[0];
const specs = ['fixture/A', 'fixture/B:medium', 'fixture/C:high'];

test('ordered bounded catalog selection and independent child attestation', () => {
  const chosen = selectTmuxModel(catalog(), specs);
  const observed = process.env.CLANKERS_TMUX_FALLBACK_PLANTED_FAULT === '1'
    ? selectTmuxModel(catalog(), [specs[0], specs[2], specs[1]]) : chosen;
  assert.equal(observed.modelSpec, 'fixture/B:medium');
  assert.equal(chosen.index, 1);
  assert.equal(Object.isFrozen(chosen), true);
  assert.equal(Object.isFrozen(chosen.candidates), true);
  assert.equal(selectTmuxModel(catalog(), [specs[0], specs[2], specs[1]]).modelSpec, 'fixture/C:high');
  attestTmuxModelSelection(catalog(), chosen);
  assert.throws(() => attestTmuxModelSelection(catalog({ ...physical, A: descriptor('A') }), chosen), /attestation/);
  assert.throws(() => attestTmuxModelSelection(catalog({ ...physical, B: { ...physical.B, baseUrl: 'https://changed.invalid' } }), chosen), /attestation/);
  assert.throws(() => parseTmuxModelSelection({ ...chosen, index: 2 }), /chosen/);
  assert.throws(() => tmuxModelCandidates(specs[0], Array(8).fill(specs[1])), /at most/);
  assert.throws(() => tmuxModelCandidates(specs[0], ['not-canonical']), /Canonical/);
  assert.throws(() => selectTmuxModel(catalog({}), specs), /No candidate/);
  assert.throws(() => selectTmuxModel(catalog({ A: null, ...physical }), specs), /Malformed/);
  assert.throws(() => selectTmuxModel(catalog({ A: { ...physical.B }, ...physical }), specs), /Malformed/);
  let lookups = 0;
  assert.throws(() => selectTmuxModel({ getError: () => 'invalid', getPhysicalModel() { lookups++; return undefined; } }, specs), /catalog/);
  assert.equal(lookups, 0);
  assert.throws(() => selectTmuxModel({ getError: () => undefined, getPhysicalModel() { lookups++; throw new Error('catalog I/O'); } }, specs), /catalog I\/O/);
  assert.equal(lookups, 1, 'lookup exceptions must not try the fallback');
});

test('installed SDK optional descriptor fields survive frozen offline selection', async () => {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const root = await mkdtemp('/srv/devops/scratch/clankers-fallback-sdk-');
  try {
    await writeFile(join(root, 'auth.json'), '{}');
    await writeFile(join(root, 'models.json'), JSON.stringify({ providers: { 'clankers-synthetic': { baseUrl: 'https://synthetic.invalid/v1', api: 'openai-completions', models: ['B', 'C'].map(id => ({ id, reasoning: true, input: ['text'], contextWindow: 4096, maxTokens: 128 })) } } }));
    const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: join(root, 'models.json'), allowModelNetwork: false, refreshOnCreate: false });
    const plan = selectTmuxModel(runtime, ['clankers-synthetic/A', 'clankers-synthetic/B:medium', 'clankers-synthetic/C:high']);
    assert.equal(plan.index, 1);
    assert.equal(plan.modelSpec, 'clankers-synthetic/B:medium');
    attestTmuxModelSelection(runtime, plan);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unselected fallback failure reports no actual model or launch', async () => {
  const fakePath = fileURLToPath(new URL('./fixtures/tmux-multiworker-fake.ts', import.meta.url));
  // Jiti shares its module cache: keep the same policy module as the next case.
  // The deliberately absent SDK path below supplies the preflight failure.
  const jiti = createJiti(import.meta.url, { fsCache: false, alias: { './tmux-runner.js': fakePath } });
  const { createTmuxControl } = await jiti.import<typeof import('../tmux-control.js')>('../tmux-control.ts');
  const fake = await jiti.import<typeof import('./fixtures/tmux-multiworker-fake.js')>(fakePath);
  fake.launches.length = 0;
  const state = createZergStateContainer({ mode: { ...createZergState().mode, automation: 'automatic', readOnly: false } });
  state.replace(upsertAgentDefinition(state.read(), { id: 'solo', label: 'Solo', source: 'user', prompt: 'synthetic', tools: [], model: specs[0] }));
  const control = createTmuxControl(state, { cwd: '/unused', trusted: { sdkModulePath: '/unused/sdk.js', agentDir: '/unused' }, assertAuthority() {}, ids: () => ({ runId: 'unselected-run', taskId: 'unselected-task' }) });
  try {
    const run = control.start({ agent: 'solo', task: 'synthetic', fallbackModels: specs.slice(1) });
    await control.awaitRun(run.runId!);
    assert.equal(fake.launches.length, 0);
    assert.equal(state.read().agents[run.runId!].metadata!.model, null);
    assert.equal(control.retainedResults()[0].model, null);
  } finally { control.dispose(); await control.drain(); }
});

// Synthetic SDK data plane only: no installed host credentials, network or provider.
const sdkSource = `
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
export function createAgentSessionServices() {}
export function createAgentSessionFromServices() {}
export function createAgentSessionRuntime() {}
export class InteractiveMode {}
export class DefaultResourceLoader {}
export class SessionManager {}
export class ProjectTrustStore { get() { return false; } }
export function hasTrustRequiringProjectResources(cwd) { return existsSync(join(cwd, 'untrusted')); }
export class SettingsManager {
 static fromStorage() { return new SettingsManager(); }
 static inMemory() { return new SettingsManager(); }
 drainErrors() { return []; }
 getGlobalSettings() { return {}; }
 getProjectSettings() { return {}; }
 setPackages() {}
 setProjectPackages() {}
 async flush() {}
}
export class DefaultPackageManager {
 async resolve() { return { extensions: [], skills: [], prompts: [], themes: [] }; }
 getInstalledPath() { return undefined; }
}
export class ModelRuntime {
 static async create(options) {
  if (options.allowModelNetwork !== false || options.refreshOnCreate !== false) throw new Error('network not disabled');
  const runtime = new ModelRuntime(); runtime.data = JSON.parse(readFileSync(options.modelsPath, 'utf8')); return runtime;
 }
 getError() { return this.data.error; }
 getPhysicalModel(provider, id) { if (this.data.throw) throw new Error('catalog failure'); return this.data.models[id]; }
}
`;
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await tick();
  assert.ok(check(), 'synthetic step exceeded 3 seconds');
}

test('controller selects before launch, records chosen model, retains it on reuse, never replays failures', async () => {
  const root = await mkdtemp('/srv/devops/scratch/clankers-fallback-');
  const sdkPath = join(root, 'sdk.mjs');
  await writeFile(sdkPath, sdkSource);
  const saveCatalog = (models: Record<string, unknown>, extra = {}) => writeFile(join(root, 'models.json'), JSON.stringify({ models, ...extra }));
  const fakePath = fileURLToPath(new URL('./fixtures/tmux-multiworker-fake.ts', import.meta.url));
  const jiti = createJiti(import.meta.url, { fsCache: false, alias: { './tmux-runner.js': fakePath } });
  const { createTmuxControl } = await jiti.import<typeof import('../tmux-control.js')>('../tmux-control.ts');
  const fake = await jiti.import<typeof import('./fixtures/tmux-multiworker-fake.js')>(fakePath);
  fake.launches.length = 0;
  const state = createZergStateContainer({ mode: { ...createZergState().mode, automation: 'automatic', readOnly: false } });
  state.replace(upsertAgentDefinition(state.read(), { id: 'solo', label: 'Solo', source: 'user', prompt: 'synthetic', tools: [], model: specs[0] }));
  let sequence = 0;
  const control = createTmuxControl(state, { cwd: root, trusted: { sdkModulePath: sdkPath, agentDir: root }, assertAuthority() {}, ids: () => ({ runId: `r-${++sequence}`, taskId: `t-${sequence}` }) });
  let worker: ReturnType<typeof fake.fakeWorker> | undefined;
  const request = { agent: 'solo', task: 'synthetic no writes', backend: 'tmux' as const, background: true, fallbackModels: specs.slice(1) };
  try {
    await saveCatalog({});
    const unavailable = control.start(request); await control.awaitRun(unavailable.runId!);
    assert.equal(fake.launches.length, 0);
    await saveCatalog(physical, { error: 'malformed catalog' });
    const invalid = control.start(request); await control.awaitRun(invalid.runId!);
    assert.equal(fake.launches.length, 0);
    await saveCatalog(physical);
    await writeFile(join(root, 'untrusted'), 'synthetic');
    const denied = control.start(request); await control.awaitRun(denied.runId!);
    assert.equal(fake.launches.length, 0);
    await rm(join(root, 'untrusted'));
    // Real offline admission function with omitted fallbacks retains old behavior.
    await assert.rejects(preflightTmuxWorkerPolicy(sdkPath, { cwd: root, agentDir: root, modelSpec: specs[0], definitionPrompt: '', tools: [], disallowedTools: [] }), /exact physical/);
    const run = control.start(request);
    await until(() => fake.launches.length === 1);
    const launch = fake.launches[0];
    assert.equal(launch.options.modelSpec, 'fixture/B:medium');
    assert.equal(launch.options.modelSelection!.index, 1);
    assert.deepEqual(launch.options.modelSelection!.candidates, specs);
    assert.equal(state.read().agents[run.runId!].metadata!.model, 'fixture/B:medium');
    worker = fake.fakeWorker(launch.options.workerId!);
    launch.gate.resolve(worker.handle);
    await until(() => worker!.calls.prompts === 1);
    worker.settle('provider failed once', 'failed');
    await control.awaitRun(run.runId!);
    assert.equal(fake.launches.length, 1, 'no fallback launch after provider dispatch');
    assert.equal(worker.calls.prompts, 1, 'no replay after failure');
    const first = control.retainedResults().find(result => result.run_id === run.runId)!;
    assert.equal(first.model, 'fixture/B:medium');
    assert.equal(first.state, 'failed');
    await saveCatalog({ A: descriptor('A'), C: physical.C });
    const reuse = await control.prompt(worker.handle.workerId, 'explicit next job', true);
    await until(() => worker!.calls.prompts === 2);
    worker.settle('same selected model'); await control.awaitRun(reuse.runId!);
    assert.equal(fake.launches.length, 1);
    assert.equal(control.retainedResults().find(result => result.run_id === reuse.runId)!.model, 'fixture/B:medium');
    assert.equal(control.retainedResults().find(result => result.run_id === run.runId)!.model, first.model);
  } finally {
    control.dispose(); worker?.finishClose();
    for (const launch of fake.launches) launch.gate.reject(new fake.TmuxLaunchError(true, false));
    await control.drain(); await rm(root, { recursive: true, force: true });
  }
});
