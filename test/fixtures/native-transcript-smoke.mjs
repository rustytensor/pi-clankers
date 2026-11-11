import { installFixtureSafety } from './fixture-safety.mjs';
// Dedicated subprocess: guard/empty environment installed before SDK resources.
installFixtureSafety({ name: 'transcript', maxRequests: 16 });
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Actual public SDK with isolated resources and strictly loopback-only model traffic.
const dir = mkdtempSync(join(tmpdir(), 'clankers-transcript-sdk-'));
const agentDir = join(dir, 'agent'); mkdirSync(agentDir); mkdirSync(join(dir, '.pi'));
process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_OFFLINE = '1'; process.chdir(dir);
const target = join(dir, 'fixture.txt'); writeFileSync(target, 'tool result fixture');
const requests = [], gates = [], disposed = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) { for (let i = 0; i < 300; i++) { if (await check()) return; await sleep(20); } throw Error(`Timeout: ${label}`); }
const server = createServer(async (req, res) => {
  try {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); requests.push(input);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'transcript', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    emit({ role: 'assistant' });
    if (input.messages.some((message) => message.role === 'tool')) {
      emit({ content: 'final authoritative text' }); emit({}, 'stop');
    } else {
      emit({ content: 'streamed first text' });
      await new Promise((resolve) => { gates.push({ resolve, emit }); res.on('close', resolve); });
      if (!res.destroyed) {
        emit({ tool_calls: [{ index: 0, id: 'fixture-call', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: target }) } }] });
        emit({}, 'tool_calls');
      }
    }
    if (!res.destroyed) res.end('data: [DONE]\n\n');
  } catch (error) { res.destroy(error); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port;
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert.equal(url.hostname, '127.0.0.1', `External traffic refused: ${url.hostname}`); assert.equal(url.port, String(port));
  return originalFetch(input, init);
};
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: {
  api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'dummy-local-only',
  models: [{ id: 'tool', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 128 }],
} } }));
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'tool', packages: [], extensions: [], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true }));
writeFileSync(join(dir, '.pi', 'settings.json'), JSON.stringify({ packages: [], extensions: [], noExtensions: true }));
const sdk = await import('@earendil-works/pi-coding-agent');
globalThis[Symbol.for('clankers/fixture-safety')].watchSDK(sdk);
const clankers = await import(new URL('../../index.ts', import.meta.url).href);
const state = await import(new URL('../../state.ts', import.meta.url).href);
const { createNativeTranscriptService } = await import(new URL('../../native-transcript.ts', import.meta.url).href);
const originalDispose = sdk.AgentSession.prototype.dispose, originalPrompt = sdk.AgentSession.prototype.prompt, originalAbort = sdk.AgentSession.prototype.abort;
let promptCalls = 0, abortCalls = 0;
sdk.AgentSession.prototype.dispose = function (...args) { disposed.push(this.sessionId); return originalDispose.apply(this, args); };
sdk.AgentSession.prototype.prompt = function (...args) { promptCalls++; return originalPrompt.apply(this, args); };
sdk.AgentSession.prototype.abort = function (...args) { abortCalls++; return originalAbort.apply(this, args); };
const owners = [], services = [];
const container = state.createClankersStateContainer();
const references = () => state.getSubagentRunSnapshots(container.read()).flatMap((run) => run.nativeSessions ?? []);
const service = createNativeTranscriptService({ getReferences: references, agentDir }); services.push(service);
const owner = clankers.createClankersControl(container, { nativeTranscriptService: service }); owners.push(owner);
const releaseAll = () => { for (const gate of gates.splice(0)) gate.resolve(); };
const deadline = setTimeout(() => { console.error('Transcript fixture timeout'); process.exit(1); }, 60000);
try {
  assert((await owner.execute({ action: 'agents.create', id: 'observer', model: 'fixture/tool', tools: ['read'], prompt: 'Use the provided read tool, then answer.' })).ok);
  const run = await owner.execute({ action: 'run', agent: 'observer', task: 'Read fixture and report.', background: true }); assert(run.ok, JSON.stringify(run));
  await until(() => gates.length === 1 && references().length === 1, 'first stream');
  const ref = references()[0]; const view = await service.open(ref);
  await until(() => JSON.stringify(view.getSnapshot().blocks).includes('streamed first text'), 'late attach sees partial');
  assert.equal(view.getSnapshot().source, 'live');
  const isolated = createNativeTranscriptService({ getReferences: references, agentDir }); services.push(isolated);
  const other = await isolated.open(ref); assert.equal(other.getSnapshot().source, 'saved'); assert.match(other.getSnapshot().diagnostic, /no live observer connected/); other.dispose();
  const revision = container.read().revision; let notifications = 0;
  view.subscribe(() => { throw Error('fixture viewer failure'); }); view.subscribe(() => notifications++);
  for (let i = 0; i < 5; i++) { gates[0].emit({ content: ` delta-${i}` }); await sleep(15); }
  await until(() => JSON.stringify(view.getSnapshot().blocks).includes('delta-4'), 'live deltas');
  assert.equal(container.read().revision, revision, 'transcript deltas must not publish ClankersState'); assert(notifications > 0);
  const calls = promptCalls, aborts = abortCalls, disposals = disposed.length;
  const closed = await service.open(ref); closed.dispose(); closed.dispose();
  assert.equal(promptCalls, calls); assert.equal(abortCalls, aborts); assert.equal(disposed.length, disposals);
  releaseAll();
  await until(() => references()[0].attachment === 'disposed', 'runner completed');
  const capture = view.getSnapshot(); assert.equal(capture.source, 'captured'); assert.equal(capture.status, 'settled');
  assert.match(JSON.stringify(capture.blocks), /final authoritative text/);
  const tool = capture.blocks.filter((block) => block.toolCallId === 'fixture-call'); assert.equal(tool.length, 1); assert.match(tool[0].resultText, /tool result fixture/);
  assert.equal(disposed.filter((id) => id === ref.piSessionId).length, 1);
  const bytes = readFileSync(ref.sessionFile); const saved = await service.open(references()[0]);
  assert.equal(saved.getSnapshot().source, 'saved'); assert.equal(saved.getSnapshot().defaultLeafBasis, 'recorded-tip');
  assert.deepEqual(readFileSync(ref.sessionFile), bytes); assert.equal(promptCalls, calls); saved.dispose(); view.dispose();
  console.log('PASS actual SDK late attach/deltas/tool identity/final capture; closing observer never aborts or prompts; no per-delta state publication; saved bytes unchanged');

  // Two concurrent same-definition sessions require exact keys, not definition inference.
  const parallel = await Promise.all([1, 2].map((i) => owner.execute({ action: 'run', agent: 'observer', task: `Concurrent ${i}`, background: true })));
  await until(() => gates.length === 2 && references().length === 3, 'concurrent streams');
  const refs = parallel.map((result) => references().find((ref) => ref.parentRunId === result.runId));
  assert.notEqual(refs[0].piSessionId, refs[1].piSessionId);
  const views = await Promise.all(refs.map((ref) => service.open(ref))); assert(views.every((view) => view.getSnapshot().source === 'live'));
  assert.deepEqual(views.map((view) => view.getSnapshot().key.piSessionId), refs.map((ref) => ref.piSessionId));
  const missing = await service.open({ ...refs[0], memberRunId: 'missing' }); assert.equal(missing.getSnapshot().source, 'unavailable'); missing.dispose();
  releaseAll(); await until(() => refs.every((ref) => references().find((next) => next.piSessionId === ref.piSessionId).attachment === 'disposed'), 'concurrent completion');
  views.forEach((view) => view.dispose());
  console.log('PASS exact concurrent owner/session keys and no missing-key leader fallback');

  // Bridge fallback must use the extension owner's same observer instance.
  const busListeners = new Map();
  const events = { on(name, fn) { const listeners = busListeners.get(name) ?? new Set(); listeners.add(fn); busListeners.set(name, listeners); return () => listeners.delete(fn); }, emit(name, data) { for (const fn of busListeners.get(name) ?? []) fn(data); } };
  state.replaceSharedClankersState(state.createClankersState()); let registration;
  const bridge = createNativeTranscriptService({ getReferences: () => state.getSubagentRunSnapshots(registration.state).flatMap((run) => run.nativeSessions ?? []), agentDir }); services.push(bridge);
  registration = clankers.registerClankersExtension({ cwd: dir, events, registerCommand() {}, registerTool() {} }, { nativeTranscriptService: bridge }); owners.push(registration);
  assert((await registration.control.execute({ action: 'agents.create', id: 'bridge-observer', model: 'fixture/tool', tools: ['read'], prompt: 'Read then report.' })).ok);
  const bridgeRun = await registration.control.execute({ action: 'run', agent: 'bridge-observer', task: 'Bridge fallback.', background: true }); assert(bridgeRun.ok);
  await until(() => gates.length === 1 && bridge.list().length === 1, 'bridge stream');
  const bridgeView = await bridge.open(bridge.list()[0]); assert.equal(bridgeView.getSnapshot().source, 'live'); bridgeView.dispose();
  releaseAll(); await until(() => bridge.list()[0].attachment === 'disposed', 'bridge completion');
  console.log('PASS extension bridge-native fallback shares owner-scoped live observer service');
  console.log(`PASS all transcript SDK checks (${requests.length} localhost requests, ${promptCalls} explicit prompts)`);
} finally {
  clearTimeout(deadline); releaseAll(); for (const service of services) service.shutdown(); for (const owner of owners) owner.dispose();
  sdk.AgentSession.prototype.dispose = originalDispose; sdk.AgentSession.prototype.prompt = originalPrompt; sdk.AgentSession.prototype.abort = originalAbort;
  globalThis.fetch = originalFetch; server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(dir, { recursive: true, force: true });
}
