import { installFixtureSafety } from './fixture-safety.mjs';
// Dedicated subprocess: guard/empty environment installed before SDK resources.
installFixtureSafety({ name: 'concurrency', maxRequests: 64 });
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'zerg-concurrency-host-'));
const agentDir = join(dir, 'agent');
mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = '1';
process.chdir(dir);

const requests = [];
const gates = new Map();
const releases = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test, label) {
  for (let index = 0; index < 250; index += 1) {
    if (await test()) return;
    await sleep(20);
  }
  throw Error(`Timed out: ${label}`);
}

const server = createServer(async (req, res) => {
  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    requests.push(input);
    if (input.model === 'fail') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fixture worker failure' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'concurrency', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    emit({ role: 'assistant' });
    if (input.model.startsWith('slow')) {
      await new Promise((resolve) => { gates.set(input.model, true); releases.set(input.model, resolve); res.on('close', resolve); });
      gates.delete(input.model);
      releases.delete(input.model);
    }
    if (!res.destroyed) {
      emit({ content: `done ${input.model}` });
      emit({}, 'stop');
      res.end('data: [DONE]\n\n');
    }
  } catch (error) {
    res.destroy(error);
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const workerModels = Array.from({ length: 12 }, (_, index) => `slow${index}`);
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'dummy-local-only', models: [...workerModels, 'lead', 'ok', 'fail'].map((id) => ({ id, reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 128 })) } } }));
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'ok', packages: [] }));

const extensionDir = join(dir, '.pi', 'extensions');
mkdirSync(extensionDir, { recursive: true });
writeFileSync(join(extensionDir, 'startup.js'), "export default function(pi) { pi.on('session_start', async () => { await globalThis.__zergConcurrencyStartup?.(); }); }");
const startupReleases = [];
function eventBus() {
  const listeners = new Map();
  return {
    on(name, fn) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); return () => set.delete(fn); },
    emit(name, data) { for (const fn of listeners.get(name) ?? []) fn(data); },
  };
}
const deadline = setTimeout(() => { console.error('Global concurrency smoke timeout'); process.exit(1); }, 60000);
globalThis[Symbol.for('zerg/fixture-safety')].watchSDK(await import('@earendil-works/pi-coding-agent'));
const zerg = await import(new URL('../../index.ts', import.meta.url).href);
const control = zerg.createZergControl();

async function agent(control, id, model, extra = {}) {
  const result = await control.execute({ action: 'agents.create', id, model: `fixture/${model}`, prompt: 'Return concise status only. No tools or edits.', tools: [], ...extra });
  assert(result.ok, JSON.stringify(result));
}
async function team(control, id, members, leader = 'lead') {
  const result = await control.execute({ action: 'team.create', id, leader, members });
  assert(result.ok, JSON.stringify(result));
}
function release(model) { releases.get(model)?.(); }
function requestModels(start) { return requests.slice(start).map((request) => request.model); }
async function show(control, runId) { return (await control.execute({ action: 'runs.show', runId })).data.run; }

try {
  await agent(control, 'lead', 'lead');
  for (let index = 0; index < 10; index += 1) await agent(control, `w${index}`, `slow${index}`);
  await team(control, 'default-team', Array.from({ length: 9 }, (_, index) => `w${index}`));
  let start = requests.length;
  globalThis.__zergConcurrencyStartup = () => new Promise((resolve) => startupReleases.push(resolve));
  const defaultRun = await control.execute({ action: 'run', agent: 'default-team', task: 'Default concurrency.', background: true });
  assert(defaultRun.ok, JSON.stringify(defaultRun));
  await until(() => startupReleases.length === 8, 'eight admitted session_start handlers');
  await sleep(80);
  assert.equal(startupReleases.length, 8, 'setup must count towards the cap');
  assert.deepEqual(requestModels(start), [], 'all admitted sessions are still starting');
  const starting = await show(control, defaultRun.runId);
  assert.deepEqual(starting.memberProgress.filter((m) => m.status === 'starting').map((m) => m.agentId), Array.from({ length: 8 }, (_, i) => `w${i}`));
  assert.equal(starting.memberProgress[8].status, 'queued');
  assert.equal(starting.memberProgress[8].startedAt, undefined);
  delete globalThis.__zergConcurrencyStartup;
  for (const resume of startupReleases.splice(0)) resume();
  await until(() => requestModels(start).filter((model) => model.startsWith('slow')).length === 8, 'default first eight workers');
  assert.deepEqual([...requestModels(start)].sort(), workerModels.slice(0, 8).sort());
  assert.equal(requestModels(start).includes('slow8'), false);
  assert.equal((await show(control, defaultRun.runId)).metadata.concurrency, 8);
  release('slow0');
  await until(() => requestModels(start).includes('slow8'), 'default queued worker admitted after release');
  assert.deepEqual([...requestModels(start)].sort(), workerModels.slice(0, 9).sort());
  assert.equal(requestModels(start).includes('lead'), false, 'leader waits for every worker');
  for (let index = 1; index < 9; index += 1) release(`slow${index}`);
  await until(async () => (await show(control, defaultRun.runId)).status === 'done', 'default run done');
  assert.equal(requestModels(start).at(-1), 'lead');
  assert((await show(control, defaultRun.runId)).memberProgress.every((member) => member.status === 'done'));
  console.log('PASS default native team worker concurrency is 8, FIFO, and leader follows workers');

  gates.clear(); releases.clear();
  await team(control, 'cap2-team', ['w0', 'w1', 'w2']);
  start = requests.length;
  const cap2 = await control.execute({ action: 'run', agent: 'cap2-team', task: 'Custom cap two.', background: true, concurrency: 2 });
  assert(cap2.ok, JSON.stringify(cap2));
  await until(() => requestModels(start).length === 2, 'cap2 first two');
  assert.deepEqual([...requestModels(start)].sort(), ['slow0', 'slow1']);
  release('slow0');
  await until(() => requestModels(start).includes('slow2'), 'cap2 third after release');
  release('slow1'); release('slow2');
  await until(async () => (await show(control, cap2.runId)).status === 'done', 'cap2 done');
  assert.equal((await show(control, cap2.runId)).metadata.concurrency, 2);
  console.log('PASS custom native team worker concurrency cap 2 is bounded and FIFO');

  await agent(control, 'fail', 'fail');
  await team(control, 'failure-drains-team', ['fail', 'w0', 'w1']);
  start = requests.length;
  const failureDrains = await control.execute({ action: 'run', agent: 'failure-drains-team', task: 'Failure drains queue.', background: true, concurrency: 1 });
  assert(failureDrains.ok, JSON.stringify(failureDrains));
  await until(() => requestModels(start).includes('slow0'), 'failure released cap1 slot');
  release('slow0');
  await until(() => requestModels(start).includes('slow1'), 'second queued after failure and release');
  release('slow1');
  await until(async () => (await show(control, failureDrains.runId)).status === 'failed', 'failure drains done');
  const failureRun = await show(control, failureDrains.runId);
  assert.deepEqual(failureRun.metadata.failedMemberSummaries.map((member) => member.agentId), ['fail']);
  console.log('PASS worker failure releases slot and remaining queued workers continue');

  gates.clear(); releases.clear();
  await agent(control, 'setup-reject', 'ok', { permissionMode: 'manual' });
  await team(control, 'setup-reject-drains-team', ['setup-reject', 'w0']);
  start = requests.length;
  const setupReject = await control.execute({ action: 'run', agent: 'setup-reject-drains-team', task: 'Setup rejection drains queue.', background: true, concurrency: 1 });
  assert(setupReject.ok, JSON.stringify(setupReject));
  await until(() => requestModels(start).includes('slow0'), 'setup rejection released cap1 slot');
  release('slow0');
  await until(async () => (await show(control, setupReject.runId)).status === 'failed', 'setup rejection done');
  assert.deepEqual(requestModels(start), ['slow0', 'lead']);
  console.log('PASS setup rejection releases worker slot without a model request');

  gates.clear(); releases.clear();
  await team(control, 'cancel-team', ['w0', 'w1', 'w2']);
  start = requests.length;
  const cancelRun = await control.execute({ action: 'run', agent: 'cancel-team', task: 'Cancel queued workers.', background: true, concurrency: 1 });
  assert(cancelRun.ok, JSON.stringify(cancelRun));
  await until(() => requestModels(start).length === 1, 'cancel first worker only');
  assert((await control.execute({ action: 'interrupt', runId: cancelRun.runId })).ok);
  release('slow0');
  await until(async () => (await show(control, cancelRun.runId)).status === 'cancelled', 'cancelled run terminal');
  const cancelled = await show(control, cancelRun.runId);
  assert.deepEqual(requestModels(start), ['slow0']);
  assert.equal(cancelled.memberProgress.length, 3);
  assert(cancelled.memberProgress.every((member) => member.status === 'cancelled'), JSON.stringify(cancelled.memberProgress));
  for (const member of cancelled.memberProgress.slice(1)) {
    assert.equal(member.startedAt, undefined);
    assert(member.completedAt);
  }
  assert.equal(cancelled.memberProgress.some((member) => member.agentId === 'lead'), false);
  console.log('PASS cancellation prevents queued launches and skips leader');

  control.dispose();

  let bridgeTool;
  const bridge = zerg.registerZergSwarmExtension({ events: eventBus(), registerCommand() {}, registerTool(tool) { if (tool.name === 'zerg_control') bridgeTool = tool; } });
  try {
    await agent(bridge.control, 'lead', 'lead');
    await agent(bridge.control, 'w0', 'slow0');
    await agent(bridge.control, 'w1', 'slow1');
    await team(bridge.control, 'bridge-team', ['w0', 'w1']);
    for (const concurrency of ['2', null, 0, -1, 1.5, true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const before = bridge.control.getState();
      const invalid = await bridgeTool.execute('invalid-limit', { action: 'run', agent: 'bridge-team', task: 'Do not launch.', concurrency });
      assert.equal(invalid.isError, true);
      assert.deepEqual(bridge.control.getState(), before);
    }
    gates.clear(); releases.clear(); start = requests.length;
    const bridgeRun = await bridge.control.execute({ action: 'run', agent: 'bridge-team', task: 'Bridge cap one.', background: true, concurrency: 1 });
    assert(bridgeRun.ok, JSON.stringify(bridgeRun));
    await until(() => requestModels(start).length === 1, 'bridge cap one first');
    assert.deepEqual(requestModels(start), ['slow0']);
    release('slow0');
    await until(() => requestModels(start).includes('slow1'), 'bridge cap one second');
    release('slow1');
    await until(async () => (await bridge.control.execute({ action: 'runs.show', runId: bridgeRun.runId })).data.run.status === 'done', 'bridge done');
  } finally {
    bridge.dispose();
  }
  console.log('PASS bridge-native fallback preserves per-run worker concurrency');

  // Exercise cancellation while admitted SDK sessions are still in session_start.
  for (const mode of ['interrupt', 'dispose', 'foreground-abort', 'shutdown']) {
    let tool;
    const shutdownHooks = [];
    const owner = zerg.registerZergSwarmExtension({
      events: eventBus(), registerCommand() {}, registerTool(value) { if (value.name === 'zerg_control') tool = value; },
      on(name, hook) { if (name === 'session_shutdown') shutdownHooks.push(hook); },
    });
    let entries = 0;
    globalThis.__zergConcurrencyStartup = () => { entries += 1; return new Promise((resolve) => startupReleases.push(resolve)); };
    try {
      await agent(owner.control, 'lead', 'lead');
      for (let i = 0; i < 3; i += 1) await agent(owner.control, `w${i}`, 'ok');
      await team(owner.control, 'startup-team', ['w0', 'w1', 'w2']);
      const task = `Cancel startup queue via ${mode}.`;
      const action = { action: 'run', agent: 'startup-team', task, concurrency: 2, background: mode !== 'foreground-abort' };
      const abort = new AbortController();
      const beforeRequests = requests.length;
      const foreground = mode === 'foreground-abort' ? tool.execute('abort-startup', action, abort.signal) : undefined;
      const launched = foreground ? undefined : await owner.control.execute(action);
      if (launched) assert(launched.ok, JSON.stringify(launched));
      await until(() => entries === 2, `${mode}: admitted startup sessions`);
      await sleep(60);
      assert.equal(entries, 2);
      const runId = launched?.runId ?? Object.values(owner.control.getState().agents).find((run) => run.metadata?.originalTask === task).id;
      const beforeCancel = await show(owner.control, runId);
      assert.deepEqual(beforeCancel.memberProgress.map((member) => member.status), ['starting', 'starting', 'queued']);
      assert.equal(beforeCancel.memberProgress[2].startedAt, undefined);
      if (mode === 'interrupt') assert((await owner.control.execute({ action: 'interrupt', runId })).ok);
      else if (mode === 'dispose') owner.dispose();
      else if (mode === 'foreground-abort') abort.abort();
      else { assert(shutdownHooks.length > 0); for (const hook of shutdownHooks) await hook({}, {}); }
      // Pi cannot forcibly unwind an arbitrary extension handler; release only admitted handlers.
      globalThis.__zergConcurrencyStartup = () => { entries += 1; };
      for (const resume of startupReleases.splice(0)) resume();
      if (foreground) { const result = await foreground; assert.equal(result.isError, true); assert.equal(result.details.ok, false); }
      await until(async () => {
        const run = await show(owner.control, runId);
        return run.status === 'cancelled' && run.memberProgress.length === 3 && run.memberProgress.every((member) => member.status === 'cancelled');
      }, `${mode}: all members terminal`);
      const stopped = await show(owner.control, runId);
      assert.equal(stopped.memberProgress[2].startedAt, undefined);
      assert(stopped.memberProgress[2].completedAt);
      assert.equal(stopped.memberProgress.some((member) => member.agentId === 'lead'), false);
      assert.equal(entries, 2, `${mode}: queued worker/leader must not initialize`);
      assert.equal(requests.length, beforeRequests, `${mode}: no model request after startup cancellation`);
    } finally {
      owner.dispose();
      delete globalThis.__zergConcurrencyStartup;
      for (const resume of startupReleases.splice(0)) resume();
    }
  }
  console.log('PASS SDK startup bounds and interrupt/dispose/foreground-abort/shutdown queue cancellation');

  const single = zerg.createZergControl();
  try {
    await agent(single, 'solo', 'ok');
    const result = await single.execute({ action: 'run', agent: 'solo', task: 'Single agent unchanged.', concurrency: 1 });
    assert(result.ok, JSON.stringify(result));
    assert.equal((await show(single, result.runId)).status, 'done');
  } finally { single.dispose(); }

  console.log(`PASS all native concurrency smoke checks (${requests.length} localhost model requests only)`);
} finally {
  clearTimeout(deadline);
  control.dispose();
  delete globalThis.__zergConcurrencyStartup;
  for (const resume of startupReleases.splice(0)) resume();
  for (const release of releases.values()) release();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
