import { installFixtureSafety } from './fixture-safety.mjs';
// Local fetch restoration restores the retained guard, not ambient fetch.
installFixtureSafety({ name: 'messaging', maxRequests: 24 });
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Public SDK only. No real credentials, user resources, external endpoints, or
// provider test calls. Every model request is to this exact loopback listener.
const dir = mkdtempSync(join(tmpdir(), 'clankers-messaging-sdk-'));
const agentDir = join(dir, 'agent'); mkdirSync(agentDir); mkdirSync(join(dir, '.pi'));
process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_OFFLINE = '1'; process.chdir(dir);
const requests = [], gates = [], sessions = [], controls = [], services = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) { for (let i = 0; i < 400; i++) { if (await check()) return; await sleep(20); } throw Error(`Timeout: ${label}`); }
const server = createServer(async (req, res) => {
  try {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); requests.push(input);
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'messaging', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    emit({ role: 'assistant' }); emit({ content: 'local fixture response' });
    if (!input.messages.some((message) => message.role === 'assistant')) await new Promise((resolve) => { gates.push(resolve); res.on('close', resolve); });
    if (!res.destroyed) { emit({}, 'stop'); res.end('data: [DONE]\n\n'); }
  } catch (error) { res.destroy(error); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port;
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert.equal(url.origin, `http://127.0.0.1:${port}`, `External traffic refused: ${url.origin}`);
  assert.equal(url.pathname, '/v1/chat/completions');
  assert.equal(url.search, ''); assert.equal(url.hash, ''); assert.equal(url.username, ''); assert.equal(url.password, '');
  return originalFetch(input, { ...init, redirect: 'error' });
};
writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: {
  api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'dummy-local-only',
  models: [{ id: 'message', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 128 }],
} } }));
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'message', packages: [], extensions: [], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true }));
writeFileSync(join(dir, '.pi', 'settings.json'), JSON.stringify({ packages: [], extensions: [], noExtensions: true }));
const sdk = await import('@earendil-works/pi-coding-agent');
globalThis[Symbol.for('clankers/fixture-safety')].watchSDK(sdk);
const clankers = await import(new URL('../../index.ts', import.meta.url).href);
const state = await import(new URL('../../state.ts', import.meta.url).href);
const messaging = await import(new URL('../../session-messages.ts', import.meta.url).href);
const originalBind = sdk.AgentSession.prototype.bindExtensions;
const originalPrompt = sdk.AgentSession.prototype.prompt, originalDispose = sdk.AgentSession.prototype.dispose;
let prompts = 0, disposals = 0;
sdk.AgentSession.prototype.bindExtensions = function (...args) { sessions.push(this); return originalBind.apply(this, args); };
sdk.AgentSession.prototype.prompt = function (...args) { prompts++; return originalPrompt.apply(this, args); };
sdk.AgentSession.prototype.dispose = function (...args) { disposals++; return originalDispose.apply(this, args); };
const releaseAll = () => { for (const release of gates.splice(0)) release(); };
const deadline = setTimeout(() => { console.error('Messaging SDK fixture timeout'); process.exit(1); }, 60000);
try {
  const container = state.createClankersStateContainer();
  const sharedMessages = messaging.createSessionMessageService({ container, readOnly: () => container.read().mode.readOnly === true }); services.push(sharedMessages);
  // Inject faulty receipt cleanup while retaining the real public transport.
  // These faults must not prevent native cancellation or task-owned disposal.
  const faultyCleanup = { ...sharedMessages, closeParent() { throw Error('fixture receipt cancel fault'); }, shutdown() { throw Error('fixture receipt shutdown fault'); } };
  const owner = clankers.createClankersControl(container, { sessionMessageService: faultyCleanup }); controls.push(owner);
  const references = () => state.getSubagentRunSnapshots(container.read()).flatMap((run) => run.nativeSessions ?? []);
  assert((await owner.execute({ action: 'agents.create', id: 'messenger', model: 'fixture/message', tools: [], prompt: 'Answer briefly without tools.' })).ok);
  const starts = await Promise.all([1, 2].map((i) => owner.execute({ action: 'run', agent: 'messenger', task: `Exact session ${i}`, background: true })));
  await until(() => gates.length === 2 && references().length === 2 && sessions.every((session) => session.isStreaming), 'two streams');
  const refs = starts.map((start) => references().find((ref) => ref.parentRunId === start.runId));
  assert.notEqual(refs[0].piSessionId, refs[1].piSessionId);
  const send = (ref, messageId, mode, body) => owner.execute({ action: 'session.message.send', parentRunId: ref.parentRunId, memberRunId: ref.memberRunId, piSessionId: ref.piSessionId, messageId, mode, body });
  const literal = '  /skill:never-expand\n\tcode body  \n';
  const queued = await send(refs[0], 'steering', 'steer', literal); assert(queued.ok, JSON.stringify(queued)); assert.equal(queued.data.receipt.status, 'queued'); assert.equal(queued.data.receipt.persistence, 'memory');
  assert((await send(refs[0], 'steering', 'steer', literal)).ok); assert.equal((await send(refs[0], 'steering', 'followUp', literal)).ok, false);
  assert.equal((await send({ ...refs[0], piSessionId: refs[1].piSessionId }, 'wrong', 'steer', literal)).ok, false);
  assert((await send(refs[0], 'follow', 'followUp', 'follow priority')).ok);
  assert((await send(refs[0], 'same-body-new-ID', 'steer', literal)).ok);
  assert.equal((await send(refs[1], 'steering', 'steer', literal)).ok, false, 'same caller ID cannot be retargeted');
  assert((await send(refs[1], 'other-steering', 'followUp', 'other exact conversation')).ok);
  const explicitPrompts = prompts;
  releaseAll(); await until(() => references().every((ref) => ref.attachment === 'disposed'), 'settled sessions');
  const list = await owner.execute({ action: 'session.messages.list', parentRunId: refs[0].parentRunId, memberRunId: refs[0].memberRunId, piSessionId: refs[0].piSessionId });
  assert.equal(list.data.receipts.length, 3); assert(list.data.receipts.every((receipt) => receipt.status === 'delivered'));
  const firstSession = sessions.find((session) => session.sessionId === refs[0].piSessionId);
  const custom = firstSession.sessionManager.getEntries().filter((entry) => entry.type === 'custom_message');
  assert.deepEqual(custom.map((entry) => entry.details.messageId), ['steering', 'same-body-new-ID', 'follow']);
  assert.equal(custom[0].content, literal); assert.equal(custom[1].content, literal);
  const history = readFileSync(refs[0].sessionFile, 'utf8'); assert(history.includes('pi-clankers/operator/v1')); assert(history.includes('never-expand'));
  assert.equal(prompts, explicitPrompts, 'custom input never invokes prompt'); assert.equal(disposals, 2);
  const requestsAtClose = requests.length;
  assert.equal((await send(refs[0], 'inactive', 'steer', 'must not start')).ok, false); await sleep(50); assert.equal(requests.length, requestsAtClose);
  console.log('PASS exact concurrent SDK routing, literal input, distinct IDs, duplicate/conflict, steer before followUp, consumption receipts, native history, no inactive prompt or retained session');

  // clearQueue returns only user text, not custom envelopes. Never infer delivery
  // from that return value or queue_update. Existing abort/dispose own lifecycle.
  const cancel = await owner.execute({ action: 'run', agent: 'messenger', task: 'Queue clear and cancel', background: true });
  await until(() => gates.length === 1 && references().length === 3, 'cancel stream');
  const cancelRef = references().find((ref) => ref.parentRunId === cancel.runId);
  assert((await send(cancelRef, 'clear', 'followUp', 'queued then cleared')).ok);
  const cancelSession = sessions.find((session) => session.sessionId === cancelRef.piSessionId);
  cancelSession.clearQueue();
  assert((await owner.execute({ action: 'interrupt', runId: cancel.runId })).ok);
  releaseAll(); await until(() => references().find((ref) => ref.piSessionId === cancelRef.piSessionId).attachment === 'disposed', 'cancel disposal');
  const cleared = await owner.execute({ action: 'session.messages.list', parentRunId: cancelRef.parentRunId, memberRunId: cancelRef.memberRunId, piSessionId: cancelRef.piSessionId });
  assert.equal(cleared.data.receipts[0].status, 'needs-attention'); assert.equal(disposals, 3);
  console.log('PASS custom clearQueue/cancellation uncertainty and task-owned disposal');

  // Public SDK with inline extension hooks: input handlers never see new custom
  // envelopes; message_end transformations cannot revoke native consumption.
  const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [(pi) => {
      pi.on('input', (event) => event.text.startsWith('/literal') ? { action: 'handled' } : { action: 'continue' });
      pi.on('message_end', (event) => event.message.role === 'custom' ? { message: { ...event.message, content: 'extension transformed', details: undefined, customType: 'extension/replaced' } } : undefined);
    }] });
  await loader.reload();
  const runtime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), allowModelNetwork: false });
  const model = (await runtime.getAvailable()).find((item) => item.provider === 'fixture' && item.id === 'message'); assert(model);
  const { session } = await sdk.createAgentSession({ cwd: dir, agentDir, resourceLoader: loader, modelRuntime: runtime, model, tools: [], noTools: 'all', sessionManager: sdk.SessionManager.inMemory(), settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }) });
  const directContainer = state.createClankersStateContainer(); const exact = { parentRunId: 'direct', memberRunId: 'direct', piSessionId: session.sessionId };
  const service = messaging.createSessionMessageService({ container: directContainer, readOnly: () => false });
  let release;
  try {
    await session.bindExtensions({ mode: 'print' });
    release = service.register(exact, { accepting: () => session.isStreaming, subscribe: (fn) => session.subscribe(fn), enqueue: (input) => session.sendCustomMessage({ customType: messaging.OPERATOR_CUSTOM_TYPE, content: input.body, display: true, details: { schemaVersion: 1, ...input.key, messageId: input.messageId } }, { deliverAs: input.mode }) });
    const prompting = session.prompt('Extension transformed custom input'); await until(() => gates.length === 1, 'extension stream');
    const sent = await service.send({ key: exact, messageId: 'transformed', body: '/literal must stay input', mode: 'steer' }); assert.equal(sent.receipt.status, 'queued');
    releaseAll(); await prompting;
    assert.equal(service.list(exact)[0].status, 'delivered');
    const transformed = session.sessionManager.getEntries().filter((entry) => entry.type === 'custom_message'); assert.equal(transformed[0].content, 'extension transformed'); assert.equal(transformed[0].details, undefined);
  } finally { releaseAll(); release?.(); service.shutdown(); session.dispose(); }
  console.log(`PASS public input handled hook bypass and message_end metadata/content transform; all SDK checks (${requests.length} exact localhost requests)`);
} finally {
  clearTimeout(deadline); releaseAll(); for (const owner of controls) owner.dispose(); for (const service of services) service.shutdown();
  sdk.AgentSession.prototype.bindExtensions = originalBind; sdk.AgentSession.prototype.prompt = originalPrompt; sdk.AgentSession.prototype.dispose = originalDispose;
  globalThis.fetch = originalFetch; server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(dir, { recursive: true, force: true });
}
