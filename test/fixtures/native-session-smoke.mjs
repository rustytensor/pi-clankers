import { installFixtureSafety } from './fixture-safety.mjs';
// Dedicated subprocess: guard/empty environment installed before SDK resources.
installFixtureSafety({ name: 'session', maxRequests: 32 });
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real public Pi SDK, isolated resources/credentials, loopback-only model traffic.
const dir = mkdtempSync(join(tmpdir(), 'zerg-session-host-'));
const agentDir = join(dir, 'agent');
mkdirSync(agentDir);
mkdirSync(join(dir, '.pi'));
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = '1';
process.chdir(dir);
const requests = [];
const releases = [];
const disposed = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 250; i++) { if (await check()) return; await sleep(20); }
  throw Error(`Timeout: ${label}`);
}
const server = createServer(async (req, res) => {
  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    assert(['ok', 'slow', 'fail'].includes(input.model));
    requests.push(input);
    if (input.model === 'fail') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fixture provider failure' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'session-fixture', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    emit({ role: 'assistant' });
    if (input.model === 'slow') await new Promise((resolve) => { releases.push(resolve); res.on('close', resolve); });
    if (!res.destroyed) {
      emit({ content: `fixture done ${input.model}` }); emit({}, 'stop');
      res.end('data: [DONE]\n\n');
    }
  } catch (error) { res.destroy(error); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert.equal(url.hostname, '127.0.0.1', `External fixture traffic refused: ${url.hostname}`);
  assert.equal(url.port, String(port));
  return originalFetch(input, init);
};
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: {
  api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'dummy-local-only',
  models: ['ok', 'slow', 'fail'].map((id) => ({ id, reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 128 })),
} } }));
const settings = { defaultProvider: 'fixture', defaultModel: 'ok', packages: [], extensions: [], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true };
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(settings));
writeFileSync(join(dir, '.pi', 'settings.json'), JSON.stringify({ packages: [], extensions: [], noExtensions: true }));
assert.deepEqual(JSON.parse(readFileSync(join(agentDir, 'settings.json'))).packages, []);

const sdk = await import('@earendil-works/pi-coding-agent');
globalThis[Symbol.for('zerg/fixture-safety')].watchSDK(sdk);
const zerg = await import(new URL('../../index.ts', import.meta.url).href);
const stateApi = await import(new URL('../../state.ts', import.meta.url).href);
const persistenceApi = await import(new URL('../../persistence.ts', import.meta.url).href);
const originalBind = sdk.AgentSession.prototype.bindExtensions;
const originalDispose = sdk.AgentSession.prototype.dispose;
const originalSubscribe = sdk.AgentSession.prototype.subscribe;
const originalPrompt = sdk.AgentSession.prototype.prompt;
const originalAppend = sdk.SessionManager.prototype.appendCustomEntry;
let bindHook;
let subscribeFailure = false;
let markerFailure = false;
let registryFailure = false;
let disposalFailure = false;
const originalMapSet = Map.prototype.set;
Map.prototype.set = function (key, value) {
  if (registryFailure && key === 'startup' && value instanceof sdk.AgentSession) {
    registryFailure = false; throw Error('fixture target registration failure');
  }
  return originalMapSet.call(this, key, value);
};
let promptCalls = 0;
const markerType = 'pi-zerg-swarm/native-session/v1';
sdk.AgentSession.prototype.bindExtensions = async function (...args) {
  await bindHook?.(this);
  return originalBind.apply(this, args);
};
sdk.AgentSession.prototype.dispose = function (...args) {
  const result = originalDispose.apply(this, args);
  disposed.push(this.sessionId);
  if (disposalFailure) { disposalFailure = false; throw Error('fixture disposal failure'); }
  return result;
};
sdk.AgentSession.prototype.subscribe = function (...args) {
  if (subscribeFailure && this.sessionManager.getEntries().some((entry) => entry.customType === markerType)) {
    subscribeFailure = false; throw Error('fixture subscription failure');
  }
  return originalSubscribe.apply(this, args);
};
sdk.AgentSession.prototype.prompt = function (...args) { promptCalls++; return originalPrompt.apply(this, args); };
sdk.SessionManager.prototype.appendCustomEntry = function (...args) {
  if (markerFailure && args[0] === markerType) { markerFailure = false; throw Error('fixture identity marker failure'); }
  return originalAppend.apply(this, args);
};
const controls = [];
function control(seed, options) { const value = zerg.createZergControl(seed, options); controls.push(value); return value; }
async function agent(owner, id, model = 'ok', extra = {}) {
  const result = await owner.execute({ action: 'agents.create', id, model: `fixture/${model}`, tools: [], prompt: 'Concise status only. No tools or edits.', ...extra });
  assert(result.ok, JSON.stringify(result));
}
async function show(owner, runId) { return (await owner.execute({ action: 'runs.show', runId })).data.run; }
async function done(owner, runId, status = 'done') {
  await until(async () => {
    const run = await show(owner, runId);
    return run.status === status && run.nativeSessions?.every((ref) => ref.attachment === 'disposed');
  }, `${runId} ${status} disposed`);
  return show(owner, runId);
}
function releaseAll() { for (const release of releases.splice(0)) release(); }
function verifyFile(ref, { assistant = true } = {}) {
  assert.equal(ref.attachment, 'disposed'); assert(ref.disposedAt);
  assert.equal(disposed.filter((id) => id === ref.piSessionId).length, 1);
  const bytes = readFileSync(ref.sessionFile, 'utf8');
  const entries = bytes.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(entries[0].type, 'session'); assert.equal(entries[0].id, ref.piSessionId); assert.equal(entries[0].cwd, ref.cwd);
  const marker = entries.filter((entry) => entry.type === 'custom' && entry.customType === markerType);
  assert.equal(marker.length, 1);
  const { disposedAt: _disposedAt, attachment: _attachment, recoveredAt: _recoveredAt, ...identity } = ref;
  assert.deepEqual(marker[0].data, identity);
  for (const key of ['attachment', 'disposedAt', 'recoveredAt']) assert.equal(Object.hasOwn(marker[0].data, key), false);
  assert(entries.some((entry) => entry.type === 'session_info' && entry.name.includes(ref.memberRunId)));
  assert(entries.some((entry) => entry.type === 'message' && entry.message.role === 'user'));
  if (assistant) assert(entries.some((entry) => entry.type === 'message' && entry.message.role === 'assistant'));
  // Opening is deliberately TEST-only. Runtime inspection never opens a locator.
  const manager = sdk.SessionManager.open(ref.sessionFile);
  assert.equal(manager.getSessionId(), ref.piSessionId);
  assert(manager.getTree().length > 0);
  assert.equal(JSON.stringify(manager.buildSessionContext().messages).includes(markerType), false);
  assert.equal(JSON.stringify(manager.buildSessionContext().messages).includes(ref.piSessionId), false);
  assert.equal(readFileSync(ref.sessionFile, 'utf8'), bytes);
}
function eventBus() {
  const listeners = new Map();
  return { on(name, fn) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); return () => set.delete(fn); }, emit(name, data) { for (const fn of listeners.get(name) ?? []) fn(data); } };
}
const deadline = setTimeout(() => { console.error('Global session fixture timeout'); process.exit(1); }, 60000);
try {
  const owner = control();
  await agent(owner, 'solo'); await agent(owner, 'leader'); await agent(owner, 'worker');
  let startingRef;
  bindHook = async (session) => {
    const marker = session.sessionManager.getEntries().find((entry) => entry.customType === markerType);
    assert(marker, 'marker must precede bind');
    const run = await show(owner, marker.data.parentRunId);
    startingRef = run.nativeSessions.find((ref) => ref.piSessionId === session.sessionId);
    assert(startingRef, 'reference must be published before bind');
    assert.equal(startingRef.attachment, 'attached');
    assert.equal(existsSync(startingRef.sessionFile), false, 'setup alone does not create JSONL');
  };
  const single = await owner.execute({ action: 'run', agent: 'solo', task: 'Single provenance.' });
  assert(single.ok, JSON.stringify(single));
  bindHook = undefined;
  const singleRun = await done(owner, single.runId);
  assert.equal(singleRun.nativeSessions.length, 1);
  verifyFile(singleRun.nativeSessions[0]);
  assert.equal(singleRun.nativeSessions[0].memberRunId, single.runId);
  console.log('PASS native identity is published before binding, lazy JSONL maps header/marker and excludes custom identity from context');

  assert((await owner.execute({ action: 'team.create', id: 'team', leader: 'leader', members: ['worker', 'solo'] })).ok);
  const team = await owner.execute({ action: 'run', agent: 'team', task: 'Team provenance.' });
  assert(team.ok, JSON.stringify(team));
  const teamRun = await done(owner, team.runId);
  assert.deepEqual(teamRun.nativeSessions.map((ref) => ref.agentDefinitionId).sort(), ['leader', 'solo', 'worker']);
  assert.equal(new Set(teamRun.nativeSessions.map((ref) => ref.piSessionId)).size, 3);
  for (const ref of teamRun.nativeSessions) { assert.equal(ref.parentRunId, team.runId); verifyFile(ref); }
  for (const member of teamRun.memberProgress) assert(teamRun.nativeSessions.some((ref) => ref.memberRunId === member.runId));
  console.log('PASS native team leader and worker mapping are exact member identities');

  await agent(owner, 'same', 'slow');
  const start = requests.length;
  const parallel = await Promise.all([1, 2].map((i) => owner.execute({ action: 'run', agent: 'same', task: `Same definition ${i}.`, background: true })));
  await until(() => requests.length === start + 2, 'parallel same-definition requests');
  const liveRefs = await Promise.all(parallel.map(async (run) => (await show(owner, run.runId)).nativeSessions[0]));
  assert.notEqual(liveRefs[0].piSessionId, liveRefs[1].piSessionId);
  assert.notEqual(liveRefs[0].sessionFile, liveRefs[1].sessionFile);
  for (const ref of liveRefs) {
    assert.equal(ref.attachment, 'attached');
    const rows = readFileSync(ref.sessionFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert(rows.some((entry) => entry.type === 'message' && entry.message.role === 'user'));
    assert.equal(rows.some((entry) => entry.type === 'message' && entry.message.role === 'assistant'), false);
    assert.equal(JSON.stringify(requests.slice(start).map((request) => request.messages)).includes(ref.piSessionId), false);
  }
  releaseAll();
  for (const result of parallel) verifyFile((await done(owner, result.runId)).nativeSessions[0]);
  console.log('PASS concurrent same-definition runs remain distinct and user prompts persist before assistant completion');

  await agent(owner, 'bad', 'fail');
  const failure = await owner.execute({ action: 'run', agent: 'bad', task: 'Provider failure.' });
  assert.equal(failure.ok, false);
  verifyFile((await done(owner, failure.runId, 'failed')).nativeSessions[0], { assistant: false });

  for (const mode of ['bind', 'subscribe', 'marker', 'publication', 'registry']) {
    const store = stateApi.createZergStateContainer();
    const local = control(store);
    await agent(local, 'startup');
    const count = requests.length;
    if (mode === 'bind') bindHook = () => { throw Error('fixture bind failure'); };
    if (mode === 'subscribe') subscribeFailure = true;
    if (mode === 'marker') markerFailure = true;
    if (mode === 'registry') registryFailure = true;
    const replace = store.replace.bind(store);
    let failPublish = mode === 'publication';
    store.replace = (value) => {
      if (failPublish && Object.values(value.agents ?? {}).some((agent) => agent.metadata?.nativeSessions?.some((ref) => ref.attachment === 'attached'))) {
        failPublish = false; throw Error('fixture publication failure');
      }
      return replace(value);
    };
    const result = await local.execute({ action: 'run', agent: 'startup', task: `Startup ${mode} failure.` });
    bindHook = undefined;
    assert.equal(result.ok, false, mode);
    if (mode === 'registry') assert.equal(registryFailure, false, 'target registration failure was exercised');
    const ref = (await done(local, result.runId, 'failed')).nativeSessions[0];
    assert.equal(existsSync(ref.sessionFile), false);
    assert.equal(disposed.filter((id) => id === ref.piSessionId).length, 1);
    assert.equal(requests.length, count);
    assert.equal((await local.execute({ action: 'message', targetId: 'startup', runId: result.runId, body: 'must not deliver' })).ok, false);
    local.dispose();
  }
  console.log('PASS provider, bind, subscription, marker, publication and target-registration failures guarantee disposal without fabricated files');

  const beforeDisposeFailure = requests.length;
  bindHook = () => { throw Error('fixture setup before disposal failure'); };
  disposalFailure = true;
  let failedCleanup;
  try {
    failedCleanup = await owner.execute({ action: 'run', agent: 'solo', task: 'Uncertain cleanup.' });
  } finally { bindHook = undefined; disposalFailure = false; }
  assert.equal(failedCleanup.ok, false);
  assert.match(failedCleanup.error.message, /fixture disposal failure/);
  const detached = await show(owner, failedCleanup.runId);
  assert.equal(detached.status, 'failed');
  const uncertainRef = detached.nativeSessions[0];
  assert.equal(uncertainRef.attachment, 'unavailable');
  assert.equal(uncertainRef.disposedAt, undefined);
  assert.equal(uncertainRef.recoveredAt, undefined);
  assert.equal(existsSync(uncertainRef.sessionFile), false);
  assert.equal(disposed.filter((id) => id === uncertainRef.piSessionId).length, 1);
  assert.equal(requests.length, beforeDisposeFailure);
  assert.equal((await owner.execute({ action: 'message', targetId: 'solo', runId: failedCleanup.runId, body: 'must not deliver' })).ok, false);
  console.log('PASS throwing SDK disposal leaves an unavailable, non-routable reference without confirmed disposal');

  const beforeUnsupported = disposed.length;
  const unsupported = await owner.execute({ action: 'run', agent: 'solo', task: 'Unsupported.', maxTurns: 1 });
  assert.equal(unsupported.ok, false);
  assert.equal((await show(owner, unsupported.runId)).nativeSessions, undefined);
  assert.equal(disposed.length, beforeUnsupported);

  for (const mode of ['interrupt', 'dispose', 'shutdown']) {
    const shutdownHooks = [];
    let nativeTool;
    const registered = zerg.registerZergSwarmExtension({ events: eventBus(), registerCommand() {}, registerTool(value) { if (value.name === 'zerg_control') nativeTool = value; }, on(name, hook) { if (name === 'session_shutdown') shutdownHooks.push(hook); } });
    controls.push(registered.control);
    const local = registered.control;
    let resume; let bound = 0;
    bindHook = () => { bound++; return new Promise((resolve) => { resume = resolve; }); };
    try {
      await agent(local, 'lead'); await agent(local, 'first'); await agent(local, 'queued');
      assert((await local.execute({ action: 'team.create', id: 'cancel-team', leader: 'lead', members: ['first', 'queued'] })).ok);
      const before = requests.length; const beforePrompts = promptCalls;
      const result = await local.execute({ action: 'run', agent: 'cancel-team', task: `Cancel before prompt ${mode}.`, background: true, concurrency: 1 });
      assert(result.ok);
      await until(() => bound === 1, 'one admitted bind');
      const active = await show(local, result.runId);
      assert.equal(active.nativeSessions.length, 1);
      assert.equal(active.nativeSessions[0].attachment, 'attached');
      assert.deepEqual(active.memberProgress.map((member) => member.status), ['starting', 'queued']);
      const toolShow = await nativeTool.execute('inspect-session', { action: 'runs.show', runId: result.runId });
      assert.deepEqual(toolShow.details.data.run.nativeSessions, active.nativeSessions);
      const toolList = await nativeTool.execute('inspect-session-list', { action: 'runs.list' });
      assert.deepEqual(toolList.details.data.runs.find((run) => run.runId === result.runId).nativeSessions, active.nativeSessions);
      if (mode === 'interrupt') assert((await local.execute({ action: 'interrupt', runId: result.runId })).ok);
      else if (mode === 'dispose') registered.dispose();
      else { assert(shutdownHooks.length); for (const hook of shutdownHooks) await hook({}, {}); }
      bindHook = undefined; resume();
      const cancelled = await done(local, result.runId, 'cancelled');
      assert.equal(cancelled.nativeSessions.length, 1, 'queued worker and skipped leader have no refs');
      assert.equal(existsSync(cancelled.nativeSessions[0].sessionFile), false);
      assert.equal(bound, 1); assert.equal(requests.length, before); assert.equal(promptCalls, beforePrompts);
      assert(cancelled.memberProgress.every((member) => member.status === 'cancelled'));
      assert.equal(disposed.filter((id) => id === cancelled.nativeSessions[0].piSessionId).length, 1);
    } finally { bindHook = undefined; resume?.(); registered.dispose(); }
  }
  // Interrupt a streaming session with an already-written user transcript.
  const beforeCancel = requests.length;
  const cancelled = await owner.execute({ action: 'run', agent: 'same', task: 'Cancel during streaming.', background: true });
  await until(() => requests.length > beforeCancel, 'streaming cancel started');
  assert((await owner.execute({ action: 'interrupt', runId: cancelled.runId })).ok);
  releaseAll();
  verifyFile((await done(owner, cancelled.runId, 'cancelled')).nativeSessions[0], { assistant: false });
  console.log('PASS preprompt cancellation, queued worker interruption, disposal and shutdown preserve only created identities');

  const snapshotFile = join(dir, 'state.json');
  const corrupt = join(dir, 'corrupt.jsonl'); const missing = join(dir, 'missing.jsonl');
  writeFileSync(corrupt, 'invalid transcript: never repair\n');
  const seed = owner.getState();
  const parent = seed.agents[single.runId];
  parent.metadata.nativeSessions = [
    { ...singleRun.nativeSessions[0], attachment: 'attached', disposedAt: undefined },
    { ...singleRun.nativeSessions[0], memberRunId: `${single.runId}-missing`, piSessionId: 'missing-id', sessionFile: missing, attachment: 'attached', disposedAt: undefined },
    { ...singleRun.nativeSessions[0], memberRunId: `${single.runId}-corrupt`, piSessionId: 'corrupt-id', sessionFile: corrupt, attachment: 'attached', disposedAt: undefined },
  ];
  const manager = persistenceApi.createZergPersistenceManager({ enabled: true, snapshotFile });
  manager.save(stateApi.createZergState(seed));
  const transcriptBytes = readFileSync(singleRun.nativeSessions[0].sessionFile, 'utf8');
  const beforeRestore = requests.length; const beforeRestorePrompts = promptCalls;
  const restored = control({}, { persistence: { enabled: true, snapshotFile } });
  const recovered = await show(restored, single.runId);
  assert.equal(recovered.status, 'done');
  assert.equal(recovered.nativeSessions.length, 3);
  assert(recovered.nativeSessions.every((ref) => ref.attachment === 'unavailable' && ref.recoveredAt && ref.disposedAt === undefined));
  assert.equal(recovered.nativeSessions[0].piSessionId, singleRun.nativeSessions[0].piSessionId);
  assert((await restored.execute({ action: 'runs.list' })).data.runs.some((run) => run.nativeSessions?.length === 3));
  const slash = zerg.createZergCommandHandler(stateApi.createZergStateContainer(restored.getState()))('runs show ' + single.runId);
  assert.match(slash.output, /native-sessions: 3/); assert.match(slash.output, /unavailable/);
  await sleep(100);
  assert.equal(requests.length, beforeRestore); assert.equal(promptCalls, beforeRestorePrompts);
  assert.equal(existsSync(missing), false); assert.equal(readFileSync(corrupt, 'utf8'), 'invalid transcript: never repair\n');
  assert.equal(readFileSync(singleRun.nativeSessions[0].sessionFile, 'utf8'), transcriptBytes);
  restored.dispose();
  const restoredAgain = control({}, { persistence: { enabled: true, snapshotFile } });
  assert.deepEqual((await show(restoredAgain, single.runId)).nativeSessions, recovered.nativeSessions);
  assert.equal(requests.length, beforeRestore); assert.equal(promptCalls, beforeRestorePrompts);
  console.log('PASS opt-in restart restores mappings idempotently with zero prompts and inert missing/corrupt locators');
  console.log(`PASS all native session reference checks (${requests.length} localhost requests, ${promptCalls} explicit prompts)`);
} finally {
  clearTimeout(deadline);
  bindHook = undefined; releaseAll();
  for (const owner of controls) owner.dispose();
  sdk.AgentSession.prototype.bindExtensions = originalBind;
  sdk.AgentSession.prototype.dispose = originalDispose;
  sdk.AgentSession.prototype.subscribe = originalSubscribe;
  sdk.AgentSession.prototype.prompt = originalPrompt;
  sdk.SessionManager.prototype.appendCustomEntry = originalAppend;
  Map.prototype.set = originalMapSet;
  globalThis.fetch = originalFetch;
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
