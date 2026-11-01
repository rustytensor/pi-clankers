import { installFixtureSafety } from './fixture-safety.mjs';
// Dedicated subprocess: guard/empty environment installed before SDK resources.
installFixtureSafety({ name: 'capabilities', maxRequests: 16 });
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'zerg-capabilities-host-'));
const agentDir = join(dir, 'agent');
mkdirSync(agentDir);
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = '1';
process.chdir(dir);

const requests = [];
let sessionStarts = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(test, label) {
  for (let i = 0; i < 200; i += 1) {
    if (await test()) return;
    await sleep(20);
  }
  throw new Error(`Timed out: ${label}`);
}

const server = createServer(async (req, res) => {
  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    requests.push(input);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'capabilities', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    emit({ role: 'assistant' });
    emit({ content: `done ${input.model}` });
    emit({}, 'stop');
    res.end('data: [DONE]\n\n');
  } catch (error) {
    res.destroy(error);
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'dummy-local-only', models: ['ok', 'lead', 'a', 'b'].map((id) => ({ id, reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 128 })) } } }));
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'ok', packages: [] }));
mkdirSync(join(dir, '.pi', 'extensions'), { recursive: true });
writeFileSync(join(dir, '.pi', 'extensions', 'count-session-start.js'), "export default function(pi) { globalThis.__zergCapabilityFactories = (globalThis.__zergCapabilityFactories || 0) + 1; pi.on('session_start', () => { globalThis.__zergCapabilitySessionStarts = (globalThis.__zergCapabilitySessionStarts || 0) + 1; }); }");

const deadline = setTimeout(() => { console.error('Global capabilities smoke timeout'); process.exit(1); }, 60_000);
globalThis[Symbol.for('zerg/fixture-safety')].watchSDK(await import('@earendil-works/pi-coding-agent'));
const zerg = await import(new URL('../../index.ts', import.meta.url).href);
const controls = [];
let registration;

function observeSessionStarts() {
  sessionStarts = globalThis.__zergCapabilitySessionStarts || 0;
  return sessionStarts;
}
async function makeControl(options) {
  const control = zerg.createZergControl({}, options);
  controls.push(control);
  return control;
}
async function addAgent(control, id, model = 'ok', extra = {}) {
  const result = await control.execute({ action: 'agents.create', id, model: `fixture/${model}`, prompt: 'Return a concise status. Do not use tools.', tools: [], ...extra });
  assert(result.ok, JSON.stringify(result));
}
async function show(control, runId) {
  return (await control.execute({ action: 'runs.show', runId })).data.run;
}
async function expectRejected(control, action, expected, { background = false, execute } = {}) {
  const beforeRequests = requests.length;
  const beforeStarts = observeSessionStarts();
  const beforeFactories = globalThis.__zergCapabilityFactories || 0;
  const result = await (execute ?? ((request) => control.execute(request)))({ ...action, background });
  assert(result.runId, JSON.stringify(result));
  if (!background) {
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.error.code, 'run_failed', JSON.stringify(result));
  } else {
    assert.equal(result.ok, true, JSON.stringify(result));
    await until(async () => (await show(control, result.runId)).status === 'failed', `background rejection ${expected}`);
  }
  const run = await show(control, result.runId);
  assert.equal(run.status, 'failed', JSON.stringify(run));
  const failureText = [run.substateReason, run.errorSummary, run.metadata?.errorSummary].filter(Boolean).join('\n');
  assert.match(failureText, /unsupported capability request before SDK startup/);
  assert.match(failureText, expected);
  assert.equal(requests.length, beforeRequests, `provider request leaked for ${expected}`);
  assert.equal(observeSessionStarts(), beforeStarts, `session_start leaked for ${expected}`);
  assert.equal(globalThis.__zergCapabilityFactories || 0, beforeFactories, `extension factory loaded for ${expected}`);
  assert.equal(existsSync(join(dir, 'coord', result.runId)), false, 'preflight must precede coordination directory creation');
  assert.equal(control.getState().tasks[result.taskId]?.status, 'failed');
  assert((run.metadata?.errorSummary?.length ?? Infinity) < 512, 'capability diagnostic must be bounded');
  assert.equal(run.memberProgress?.length ?? 0, 0, 'preflight must not start or queue members');
  return { result, run };
}

try {
  const control = await makeControl();
  await addAgent(control, 'ok');
  await addAgent(control, 'max-agent', 'ok', { maxTurns: 1 });
  await addAgent(control, 'fb-agent', 'ok', { fallbackModels: ['fixture/b'] });
  await addAgent(control, 'lead', 'lead');
  await addAgent(control, 'a', 'a');
  await addAgent(control, 'late-bad', 'b', { fallbackModels: ['fixture/a'] });
  assert((await control.execute({ action: 'team.create', id: 'team-late-bad', leader: 'lead', members: ['a', 'late-bad'] })).ok);
  assert((await control.execute({ action: 'team.create', id: 'team-max', leader: 'lead', members: ['a'], maxTurns: 2 })).ok);
  assert((await control.execute({ action: 'team.create', id: 'unrelated-bad', leader: 'lead', members: ['late-bad'] })).ok);

  await expectRejected(control, { action: 'run', agent: 'ok', task: 'fork unsupported', launchMode: 'fork' }, /launchMode=fork/);
  await expectRejected(control, { action: 'run', agent: 'ok', task: 'max unsupported', maxTurns: 1 }, /run option maxTurns/);
  await expectRejected(control, { action: 'run', agent: 'ok', task: 'fallback unsupported', fallbackModels: ['fixture/b'] }, /run option fallbackModels/);
  await expectRejected(control, { action: 'run', agent: 'max-agent', task: 'agent max unsupported' }, /leader max-agent option maxTurns/);
  await expectRejected(control, { action: 'run', agent: 'fb-agent', task: 'agent fallback unsupported' }, /leader fb-agent option fallbackModels/);
  await expectRejected(control, { action: 'run', agent: 'team-max', task: 'team max unsupported' }, /run option maxTurns/);
  await expectRejected(control, { action: 'run', agent: 'team-late-bad', task: 'late member unsupported', concurrency: 1 }, /worker late-bad option fallbackModels/);
  await expectRejected(control, { action: 'run', agent: 'ok', task: 'background max unsupported', maxTurns: 3 }, /maxTurns/, { background: true });
  await addAgent(control, 'late-max', 'b', { maxTurns: 1 });
  for (const [id, leader, members, extra, expected] of [
    ['team-fallback', 'lead', ['a'], { fallbackModels: ['fixture/b'] }, /run option fallbackModels/],
    ['team-leader-max', 'max-agent', ['a'], {}, /leader max-agent option maxTurns/],
    ['team-leader-fb', 'fb-agent', ['a'], {}, /leader fb-agent option fallbackModels/],
    ['team-late-max', 'lead', ['a', 'late-max'], {}, /worker late-max option maxTurns/],
  ]) {
    assert((await control.execute({ action: 'team.create', id, leader, members, ...extra })).ok);
    await expectRejected(control, { action: 'run', agent: id, task: 'whole selected plan preflight', concurrency: 1 }, expected);
  }
  await expectRejected(control, { action: 'run', agent: 'ok', task: 'bounded diagnostic', fallbackModels: Array.from({ length: 100 }, () => `fixture/${'x'.repeat(2000)}`) }, /fallbackModels/);
  console.log('PASS native capability preflight rejects fork/maxTurns/fallbackModels before session_start or provider requests, including late workers behind concurrency 1');

  let start = requests.length;
  const fresh = await control.execute({ action: 'run', agent: 'ok', task: 'explicit fresh with empty fallback is supported', launchMode: 'fresh', fallbackModels: [] });
  assert.equal(fresh.ok, true, JSON.stringify(fresh));
  assert.deepEqual(requests.slice(start).map((request) => request.model), ['ok']);
  start = requests.length;
  const bareLeader = await control.execute({ action: 'run', agent: 'lead', task: 'bare leader ignores unrelated unsupported team', background: false });
  assert.equal(bareLeader.ok, true, JSON.stringify(bareLeader));
  assert.equal((await show(control, bareLeader.runId)).status, 'done');
  assert.deepEqual(requests.slice(start).map((request) => request.model), ['lead']);
  start = requests.length;
  const validTeam = await control.execute({ action: 'team.create', id: 'valid-team', leader: 'lead', members: ['a'] });
  assert(validTeam.ok, JSON.stringify(validTeam));
  const teamRun = await control.execute({ action: 'run', agent: 'valid-team', task: 'valid team still works', background: false });
  assert.equal(teamRun.ok, true, JSON.stringify(teamRun));
  assert.deepEqual(requests.slice(start).map((request) => request.model), ['a', 'lead']);
  console.log('PASS default fresh single and team native runs remain successful; bare leader does not validate unrelated teams');

  const abortController = new AbortController();
  abortController.abort();
  const cancelled = await control.execute({ action: 'run', agent: 'ok', task: 'cancel before launch', maxTurns: 4, background: false }, abortController.signal);
  assert.equal(cancelled.ok, false, JSON.stringify(cancelled));
  assert.equal(cancelled.error.code, 'run_cancelled');
  console.log('PASS foreground cancellation keeps precedence over unsupported native capability rejection');

  const received = [];
  const external = await makeControl({ subagentAdapter: { kind: 'fake', launch(request) { received.push(request); return { ok: true, runId: request.runId, taskId: request.taskId, message: 'external accepted' }; }, async awaitRun() { return undefined; }, getRun() { return undefined; }, dispose() {} } });
  await addAgent(external, 'external-agent');
  const externalRun = await external.execute({ action: 'run', agent: 'external-agent', task: 'external accepts capabilities', background: true, launchMode: 'fork', maxTurns: 5, fallbackModels: ['fixture/b'] });
  assert.equal(externalRun.ok, true, JSON.stringify(externalRun));
  assert.equal(received[0].launchMode, 'fork');
  assert.equal(received[0].maxTurns, 5);
  assert.deepEqual(received[0].fallbackModels, ['fixture/b']);
  console.log('PASS external adapter receives unsupported-native capabilities unchanged');

  const listeners = new Map();
  const bridgePayloads = [];
  let acknowledge = true;
  let registeredTool;
  let slashHandler;
  const events = {
    on(name, fn) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); return () => set.delete(fn); },
    emit(name, data) {
      if (name === 'subagent:slash:request' && acknowledge) {
        bridgePayloads.push(data);
        setImmediate(() => {
          for (const fn of listeners.get('subagent:slash:started') ?? []) fn({ requestId: data.requestId });
          for (const fn of listeners.get('subagent:slash:response') ?? []) fn({ requestId: data.requestId, result: { ok: true, message: 'ack bridge handled' } });
        });
      }
      for (const fn of listeners.get(name) ?? []) fn(data);
    },
  };
  registration = zerg.registerZergSwarmExtension({ events, registerCommand(name, command) { if (name === 'zerg') slashHandler = command.handler; }, registerTool(tool) { if (tool.name === 'zerg_control') registeredTool = tool; } });
  assert((await registration.control.execute({ action: 'agents.create', id: 'bridge', prompt: 'No tools.', tools: [], model: 'fixture/ok' })).ok);
  start = requests.length;
  const bridged = await registration.control.execute({ action: 'run', agent: 'bridge', task: 'bridge keeps capability request', background: true, launchMode: 'fork', maxTurns: 6, fallbackModels: ['fixture/a'] });
  assert.equal(bridged.ok, true, JSON.stringify(bridged));
  await until(async () => (await registration.control.execute({ action: 'runs.show', runId: bridged.runId })).data.run.status === 'done', 'acknowledged bridge completion');
  assert.equal(requests.length, start, 'acknowledged slash bridge must not fall back to native SDK');
  assert.equal(bridgePayloads.length, 1);
  assert.equal(bridgePayloads[0].params.context, 'fork');
  assert.equal(bridgePayloads[0].params.maxTurns, 6);
  assert.deepEqual(bridgePayloads[0].params.fallbackModels, ['fixture/a']);
  console.log('PASS acknowledged slash bridge path is not rejected by native fallback preflight');

  acknowledge = false;
  const bridgeStarts = observeSessionStarts();
  const bridgeFactories = globalThis.__zergCapabilityFactories || 0;
  for (const options of [{ launchMode: 'fork' }, { maxTurns: 1 }, { fallbackModels: ['fixture/b'] }]) {
    await expectRejected(registration.control, { action: 'run', agent: 'bridge', task: 'native fallback rejects capability', ...options }, /unsupported capability/, { background: true });
    await expectRejected(registration.control, { action: 'run', agent: 'bridge', task: 'foreground tool native rejection', ...options }, /unsupported capability/, {
      execute: async (action) => {
        const response = await registeredTool.execute('capability-rejection', action);
        assert.equal(response.isError, true);
        return response.details;
      },
    });
  }
  const notifications = [];
  const commandContext = { cwd: dir, hasUI: false, ui: { notify(message) { notifications.push(message); } } };
  for (const [flag, name] of [['--fork', 'fork'], ['--max-turns 1', 'maxTurns'], ['--fallback-models fixture/b', 'fallbackModels']]) {
    const task = `slash rejects ${name}`;
    await slashHandler(`run bridge "${task}" ${flag}`, commandContext);
    const record = Object.values(registration.control.getState().agents).find((agent) => agent.metadata?.originalTask === task);
    assert(record, `slash run missing for ${name}`);
    await until(async () => (await show(registration.control, record.id)).status === 'failed', 'slash native capability rejection');
    const run = await show(registration.control, record.id);
    assert.match(run.metadata.errorSummary, new RegExp(name));
    assert.equal(registration.control.getState().tasks[run.taskId].status, 'failed');
    assert.equal(existsSync(join(dir, 'coord', record.id)), false);
    // Slash launch acknowledges submission; inspect its eventual failure explicitly.
    await slashHandler(`runs show ${record.id}`, commandContext);
  }
  assert(notifications.some((message) => /unsupported capability/.test(message)));
  const abort = new AbortController();
  const pending = registeredTool.execute('cancel-before-native-fallback', { action: 'run', agent: 'bridge', task: 'cancel before unsupported native fallback', launchMode: 'fork', maxTurns: 2 }, abort.signal);
  abort.abort();
  const aborted = await pending;
  assert.equal(aborted.isError, true);
  assert.equal(aborted.details.error.code, 'run_cancelled');
  await sleep(180);
  assert.equal(requests.length, start);
  assert.equal(observeSessionStarts(), bridgeStarts);
  assert.equal(globalThis.__zergCapabilityFactories || 0, bridgeFactories);
  console.log('PASS native fallback foreground tool/slash/background rejection and cancellation before startup');
  const validBridge = await registration.control.execute({ action: 'run', agent: 'bridge', task: 'supported fresh native fallback' });
  assert.equal(validBridge.ok, true, JSON.stringify(validBridge));
  assert.equal((await show(registration.control, validBridge.runId)).status, 'done');
  console.log(`PASS all native capability checks (${requests.length} localhost model requests; ${observeSessionStarts()} session_start callbacks)`);
} finally {
  clearTimeout(deadline);
  registration?.dispose();
  for (const control of controls) control.dispose();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
