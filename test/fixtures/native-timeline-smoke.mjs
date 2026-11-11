import { installFixtureSafety } from './fixture-safety.mjs';
// Its saved originalEnv/Cwd/transports are now dummy-only guarded values.
installFixtureSafety({ name: 'timeline', maxRequests: 12, maxRequestBytes: 262144 });
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Actual installed public SDK. Fail closed before imports: no user resources,
// credentials or provider TEST calls; only this exact isolated loopback endpoint.
const root = mkdtempSync(join(tmpdir(), 'clankers-timeline-sdk-'));
const originalEnv = { ...process.env }, originalCwd = process.cwd();
const requests = [], gates = [], sessions = [], controls = [];
let prompts = 0, disposals = 0, aborted = 0;
let sdk, state, runtimeContainer, originalBind, originalPrompt, originalDispose;
const originalFetch = globalThis.fetch, originalConnect = net.Socket.prototype.connect, originalTls = tls.connect;
let timedOut, failure;
const checkDeadline = () => { if (timedOut) throw timedOut; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) { for (let i = 0; i < 500; i++) { checkDeadline(); if (await check()) return; await sleep(20); } throw Error(`Timeout: ${label}`); }
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer dummy-isolated-only'); assert(requests.length < 12);
    let body = ''; for await (const chunk of req) { body += chunk; assert(body.length <= 262144); }
    const input = JSON.parse(body); assert(['worker', 'leader'].includes(input.model)); assert.equal(input.stream, true); requests.push(input);
    res.on('close', () => { if (!res.writableEnded) aborted++; });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: 'timeline-fixture', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    emit({ role: 'assistant' }); emit({ content: `${input.model} native output, NOT addressed reply` });
    if (input.model === 'worker' && !input.messages.some((message) => message.role === 'assistant')) await new Promise((resolve) => { gates.push(resolve); res.on('close', resolve); });
    if (!res.destroyed) { emit({}, 'stop'); res.end('data: [DONE]\n\n'); }
  } catch (error) { res.destroy(error); }
});
const release = () => { for (const gate of gates.splice(0)) gate(); };
let deadline;
const watchdog = new Promise((_, reject) => { deadline = setTimeout(() => { timedOut = Error('Timeline SDK fixture watchdog timeout'); reject(timedOut); }, 60000); });
async function runFixture() {
for (const path of ['home', 'agent', 'tmp', '.pi']) mkdirSync(join(root, path));
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { PATH: originalEnv.PATH ?? '', HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), XDG_CONFIG_HOME: join(root, 'home'), PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1' });
process.chdir(root);
  // Parent resources must never be discovered by this disposable child cwd.
  for (let ancestor = dirname(root); ; ancestor = dirname(ancestor)) {
    for (const leaf of ['.pi', 'AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD', 'SYSTEM.md', 'APPEND_SYSTEM.md']) assert(!existsSync(join(ancestor, leaf)), 'Unexpected ancestor resource: ' + join(ancestor, leaf));
    if (ancestor === dirname(ancestor)) break;
  }
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
checkDeadline();
const port = server.address().port;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  assert.equal(url.origin, `http://127.0.0.1:${port}`); assert.equal(url.pathname, '/v1/chat/completions');
  assert.equal(url.username, ''); assert.equal(url.password, ''); assert.equal(url.search, ''); assert.equal(url.hash, '');
  assert.equal(init?.method ?? (typeof input === 'object' && input.method) ?? 'GET', 'POST');
  return originalFetch(input, { ...init, redirect: 'error' });
};
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === 'object' ? first : { port: first, host: args[1] };
  assert(!options?.path && options?.host === '127.0.0.1' && String(options?.port) === String(port), 'Only exact fixture loopback socket allowed');
  return originalConnect.apply(this, args);
};
tls.connect = () => { throw Error('TLS/external transport forbidden by isolated fixture'); };
const disabled = { defaultProvider: 'fixture', defaultModel: 'leader', packages: [], extensions: ['-builtin:mcp', '-builtin:llama.cpp', '-builtin:codemode', '-builtin:tool-search'], skills: [], prompts: [], themes: [], defaultProjectTrust: 'never', noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, enableInstallTelemetry: false, enableAnalytics: false, cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false } };
writeFileSync(join(root, '.pi', 'settings.json'), JSON.stringify(disabled));
writeFileSync(join(root, 'agent', 'settings.json'), JSON.stringify(disabled));
writeFileSync(join(root, 'agent', 'auth.json'), '{}');
writeFileSync(join(root, 'agent', 'models.json'), JSON.stringify({ providers: { fixture: {
  api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'dummy-isolated-only',
  models: ['worker', 'leader'].map((id) => ({ id, reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 128 })),
} } }));
sdk = await import('@earendil-works/pi-coding-agent');
globalThis[Symbol.for('clankers/fixture-safety')].watchSDK(sdk);
const clankers = await import(new URL('../../index.ts', import.meta.url).href);
state = await import(new URL('../../state.ts', import.meta.url).href);
const persistence = await import(new URL('../../persistence.ts', import.meta.url).href);
checkDeadline();
originalBind = sdk.AgentSession.prototype.bindExtensions; originalPrompt = sdk.AgentSession.prototype.prompt; originalDispose = sdk.AgentSession.prototype.dispose;
sdk.AgentSession.prototype.bindExtensions = function (...args) { sessions.push(this); return originalBind.apply(this, args); };
sdk.AgentSession.prototype.prompt = function (...args) { prompts++; return originalPrompt.apply(this, args); };
sdk.AgentSession.prototype.dispose = function (...args) { disposals++; return originalDispose.apply(this, args); };
  const container = runtimeContainer = state.createClankersStateContainer(), snapshotFile = join(root, 'timeline-state.json');
  const owner = clankers.createClankersControl(container, { persistence: { enabled: true, snapshotFile } }); controls.push(owner);
  for (const id of ['worker', 'leader']) assert((await owner.execute({ action: 'agents.create', id, model: `fixture/${id}`, tools: [], prompt: 'Answer briefly without tools.' })).ok);
  assert((await owner.execute({ action: 'team.create', id: 'timeline-team', leader: 'leader', members: ['worker'] })).ok);
  const launches = await Promise.all([1, 2].map((i) => owner.execute({ action: 'run', agent: 'timeline-team', task: `Isolated timeline ${i}`, background: true })));
  assert(launches.every((launch) => launch.ok));
  const refs = () => state.getSubagentRunSnapshots(container.read()).flatMap((run) => run.nativeSessions ?? []);
  await until(() => gates.length === 2 && refs().length === 2, 'two independent same-definition worker streams');
  const first = refs().find((ref) => ref.parentRunId === launches[0].runId), second = refs().find((ref) => ref.parentRunId === launches[1].runId);
  assert(first && second); assert.equal(first.agentDefinitionId, second.agentDefinitionId); assert.notEqual(first.piSessionId, second.piSessionId);
  const key = { parentRunId: first.parentRunId, memberRunId: first.memberRunId, piSessionId: first.piSessionId };
  const read = async (filter = {}) => { const result = await owner.execute({ action: 'timeline.list', ...filter }); assert(result.ok, JSON.stringify(result)); return result.data; };
  const sent = await owner.execute({ action: 'session.message.send', ...key, messageId: 'timeline-operator', mode: 'followUp', body: 'literal /never-expand follow-up' });
  assert(sent.ok); assert.equal(sent.data.receipt.status, 'queued');
  const snapshotBefore = readFileSync(snapshotFile, 'utf8'), explicitPrompts = prompts;
  for (let i = 0; i < 4; i++) {
    const timeline = await read({ teamId: 'timeline-team', ...key });
    const receipt = timeline.entries.find((entry) => entry.kind === 'operator-receipt'); assert(receipt); assert.equal(receipt.status, 'queued');
    assert(timeline.entries.every((entry) => entry.exactKey?.piSessionId === first.piSessionId));
    assert(!timeline.entries.some((entry) => entry.kind === 'native-output'));
  }
  assert.equal(readFileSync(snapshotFile, 'utf8'), snapshotBefore); assert.equal(prompts, explicitPrompts); assert.equal(disposals, 0);
  assert.equal((await read({ parentRunId: first.parentRunId, piSessionId: second.piSessionId })).entries.length, 0);
  assert.equal((await read({ teamId: 'unknown' })).entries.length, 0);
  const stranger = clankers.createClankersControl(state.createClankersStateContainer(), { subagentAdapter: { kind: 'fake', launch() { throw Error('no launch'); } } }); controls.push(stranger);
  assert.equal((await stranger.execute({ action: 'timeline.list', ...key })).data.entries.length, 0);
  release();
  await until(() => refs().length === 4 && refs().every((ref) => ref.attachment === 'disposed') && launches.every((launch) => state.getSubagentRunSnapshot(container.read(), launch.runId)?.status === 'done'), 'workers/leaders disposed AND both parent runs terminal');
  const complete = await read({ teamId: 'timeline-team' });
  const receipt = complete.entries.find((entry) => entry.kind === 'operator-receipt'); assert.equal(receipt.status, 'delivered');
  const outputs = complete.entries.filter((entry) => entry.kind === 'native-output'); assert.equal(outputs.length, 4); assert(outputs.every((entry) => entry.exactKey));
  assert(outputs.every((entry) => !('replyTo' in entry))); assert(complete.limitations.some((text) => text.includes('NOT an addressed reply')));
  assert.equal(prompts, 4); assert.equal(disposals, 4); assert.equal(aborted, 0);
  const nativeBytes = refs().map((ref) => [ref.sessionFile, readFileSync(ref.sessionFile)]);
  const retainedReceiptId = receipt.id;
  const current = owner.getState();
  owner.dispose(); // End the ORIGINAL snapshot owner before any restart injection/write.
  current.extensions.clankersSessionMessages.receipts[0].status = 'queued'; // Isolated restart-boundary injection; never enqueue/retry.
  const manager = persistence.createClankersPersistenceManager({ enabled: true, snapshotFile }); manager.save(current);
  const requestCount = requests.length, promptCount = prompts;
  let replay = 0;
  const restored = clankers.createClankersControl(state.createClankersStateContainer(), { persistence: { enabled: true, snapshotFile }, subagentAdapter: { kind: 'fake', launch() { replay++; throw Error('restart cannot launch'); }, sendMessage() { replay++; throw Error('restart cannot send'); } } }); controls.push(restored);
  const recovered = await restored.execute({ action: 'timeline.list', ...key }); assert(recovered.ok);
  const quarantined = recovered.data.entries.find((entry) => entry.kind === 'operator-receipt'); assert.equal(quarantined.status, 'needs-attention'); assert.equal(quarantined.id, retainedReceiptId);
  await restored.execute({ action: 'timeline.list', teamId: 'timeline-team' });
  assert.equal(replay, 0); assert.equal(prompts, promptCount); assert.equal(requests.length, requestCount); assert.equal(disposals, 4);
  for (const [file, bytes] of nativeBytes) assert.deepEqual(readFileSync(file), bytes, 'pure timeline/restart never rewrites native JSONL');
  assert.equal(requests.length, 5);
  console.log(`native timeline SDK PASS: ${requests.length} exact localhost requests; concurrent same-definition isolation, queued/delivered distinction, four native outputs, no inferred replies/replay, four task-owned disposals, native bytes preserved`);
}
try {
  await Promise.race([runFixture(), watchdog]);
} catch (error) {
  failure = error;
} finally {
  clearTimeout(deadline);
  let cleanupFailure;
  // Keep the dummy environment, public SDK hooks, fetch/socket guards and exact
  // listener alive while owners abort and task-owned finally blocks settle.
  for (const control of controls) { try { control.dispose(); } catch (error) { cleanupFailure ??= error; } }
  release();
  const settled = () => !runtimeContainer || !state || state.getSubagentRunSnapshots(runtimeContainer.read()).every((run) =>
    ['done', 'failed', 'cancelled', 'needs-attention'].includes(run.status) && (run.nativeSessions ?? []).every((ref) => ref.attachment !== 'attached'));
  const cleanupDeadline = Date.now() + 10000;
  while (!settled() && Date.now() < cleanupDeadline) await sleep(20);
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  if (timedOut || !settled()) {
    // Promise.race does not cancel a timed-out bootstrap continuation. Never
    // restore the real environment or remove guards/resources on timeout. This isolated
    // process is force-terminated instead; retain dummy-only failure evidence.
    console.error('Fixture timed out or cleanup did not settle; dummy guards/resources retained:', root);
    if (failure) console.error(failure);
    process.exit(1);
  }
  if (sdk && originalBind) sdk.AgentSession.prototype.bindExtensions = originalBind;
  if (sdk && originalPrompt) sdk.AgentSession.prototype.prompt = originalPrompt;
  if (sdk && originalDispose) sdk.AgentSession.prototype.dispose = originalDispose;
  globalThis.fetch = originalFetch; net.Socket.prototype.connect = originalConnect; tls.connect = originalTls;
  process.chdir(originalCwd); for (const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env, originalEnv);
  try { rmSync(root, { recursive: true, force: true }); } catch (error) { cleanupFailure ??= error; }
  failure ??= cleanupFailure;
}
if (failure) throw failure;
