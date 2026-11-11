import { installFixtureSafety } from './fixture-safety.mjs';
// Local guards wrap this retained guard, never the ambient transports.
installFixtureSafety({ name: 'continuation', maxRequests: 16, maxRequestBytes: 524288 });
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Standalone AFTER parent materialization/grant:
// node --import tsx test/fixtures/native-continuation-smoke.mjs
// Actual installed SDK, normal trusted fixture resources, never real credentials.
// Prototype wrappers observe/guard actual methods; they do not fabricate sessions.
const root = mkdtempSync(join(tmpdir(), 'clankers-continuation-sdk-'));
const fixturePath = process.env.PATH ?? '';
const originalFetch = globalThis.fetch, originalConnect = net.Socket.prototype.connect;
const controls = [], sourceBytes = new Map(), requests = [], disposed = [], sessions = [], gates = [];
const body = '/never-expand q b c n\n\tNEW_LITERAL_TASK: tabs/newline/trailing spaces stay literal.  \n';
let sdk, state, container, originalBind, originalPrompt, originalDispose, originalOpen, originalFork;
let prompts = 0, timedOut, failure, serverFailure, deadline, bindGate;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const checkDeadline = () => { if (timedOut) throw timedOut; if (serverFailure) throw serverFailure; };
async function until(check, label) {
  const end = Date.now() + 20000;
  while (Date.now() < end) { checkDeadline(); if (await check()) return; await sleep(20); }
  throw Error('Timeout: ' + label);
}
const tracePath = join(root, 'hooks.jsonl');
function trace() { return existsSync(tracePath) ? readFileSync(tracePath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []; }
function unchanged() { for (const [path, bytes] of sourceBytes) assert.deepEqual(readFileSync(path), bytes, 'Original source bytes must not change: ' + path); }
function boundary() { return { requests: requests.length, sessions: sessions.length, prompts, hooks: trace().length, disposals: disposed.length }; }
function release() { for (const gate of gates.splice(0)) gate(); }
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer dummy-continuation-only');
    let bytes = ''; for await (const chunk of req) { bytes += chunk; assert(bytes.length <= 524288); }
    const input = JSON.parse(bytes); assert(['old', 'current', 'fail', 'slow'].includes(input.model));
    assert.equal(input.stream, true); requests.push(input); assert(requests.length <= 16, 'Bound model requests including retries');
    if (input.model === 'fail') { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'isolated continuation failure' } })); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'continuation-fixture', object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    emit({ role: 'assistant' });
    emit({ content: input.model === 'old' ? 'OLD_FINAL_ONLY' : 'NEW_OUTPUT_ONLY' });
    if (input.model === 'slow') await new Promise(resolve => { gates.push(resolve); res.on('close', resolve); });
    if (!res.destroyed) { emit({}, 'stop'); res.end('data: [DONE]\n\n'); }
  } catch (error) { serverFailure ??= error; res.destroy(error); }
});
const watchdog = new Promise((_, reject) => { deadline = setTimeout(() => { timedOut = Error('Continuation SDK watchdog'); reject(timedOut); }, 90000); });
async function fixture() {
  for (const path of ['home', 'agent', 'tmp', '.pi', 'agent/extensions', 'agent/prompts', 'agent/skills/continuation']) mkdirSync(join(root, path), { recursive: true });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { PATH: fixturePath, HOME: join(root, 'home'), TMPDIR: join(root, 'tmp'), XDG_CONFIG_HOME: join(root, 'home'), PI_CODING_AGENT_DIR: join(root, 'agent'), PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' });
  process.chdir(root);
  for (let ancestor = dirname(root); ; ancestor = dirname(ancestor)) {
    for (const leaf of ['.pi', 'AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD', 'SYSTEM.md', 'APPEND_SYSTEM.md']) assert(!existsSync(join(ancestor, leaf)), 'Unexpected ancestor resource: ' + join(ancestor, leaf));
    if (ancestor === dirname(ancestor)) break;
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port, origin = 'http://127.0.0.1:' + port;
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    assert.equal(url.origin, origin); assert.equal(url.pathname, '/v1/chat/completions');
    assert(!url.search && !url.hash && !url.username && !url.password); assert.equal(method, 'POST');
    return originalFetch(input, { ...init, redirect: 'error' });
  };
  net.Socket.prototype.connect = function (...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0];
    const options = typeof first === 'object' ? first : { port: first, host: args[1] };
    assert(!options?.path && options?.host === '127.0.0.1' && String(options?.port) === String(port), 'Only exact fixture socket allowed');
    return originalConnect.apply(this, args);
  };
  tls.connect = () => { throw Error('TLS/external transport forbidden'); };
  const settings = { defaultProvider: 'fixture', defaultModel: 'old', packages: [], extensions: ['-builtin:mcp', '-builtin:llama.cpp', '-builtin:codemode', '-builtin:tool-search'], skills: [], prompts: [], themes: [], noExtensions: false, noSkills: false, noPromptTemplates: false, noThemes: true, defaultProjectTrust: 'never', enableInstallTelemetry: false, enableAnalytics: false, cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false } };
  const settingsPath = join(root, 'agent/settings.json');
  writeFileSync(settingsPath, JSON.stringify(settings)); writeFileSync(join(root, '.pi/settings.json'), JSON.stringify(settings));
  writeFileSync(join(root, 'agent/auth.json'), '{}');
  writeFileSync(join(root, 'agent/models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: origin + '/v1', apiKey: 'dummy-continuation-only', models: ['old', 'current', 'fail', 'slow'].map(id => ({ id, reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 128 })) } } }));
  // Normal user extension auto-discovery; no inline custom resource loader.
  writeFileSync(join(root, 'agent/extensions/observer.ts'), `import { appendFileSync } from 'node:fs';
const path = ${JSON.stringify(tracePath)};
export default function(pi) {
  function put(kind, extra = {}) { appendFileSync(path, JSON.stringify({ kind, ...extra }) + '\\n'); }
  put('factory');
  pi.on('session_start', (_event, ctx) => put('session_start', { id: ctx.sessionManager.getSessionId() }));
  pi.on('input', event => { put('input', { text: event.text }); return { action: event.text.includes('HANDLED_NO_MODEL') ? 'handled' : 'continue' }; });
  pi.on('before_agent_start', async (event, ctx) => { put('before_agent_start', { prompt: event.prompt }); await globalThis[Symbol.for('pi-clankers/fixture/pre-provider-gate/v1')]?.(ctx); });
  pi.registerCommand('never-expand', { description: 'must not dispatch', handler: () => { put('COMMAND_DISPATCH_FORBIDDEN'); throw Error('Literal continuation dispatched as slash command'); } });
}`);
  writeFileSync(join(root, 'agent/prompts/never-expand.md'), '---\ndescription: must not expand\n---\nTEMPLATE_EXPANSION_FORBIDDEN\n');
  writeFileSync(join(root, 'agent/skills/continuation/SKILL.md'), '---\nname: continuation\ndescription: CURRENT_SKILL_NORMAL_RESOURCE\n---\nRead-only fixture guidance.\n');
  writeFileSync(join(root, 'AGENTS.md'), 'OLD_CONTEXT_RESOURCE: original-source instructions only.\n');
  sdk = await import('@earendil-works/pi-coding-agent');
  globalThis[Symbol.for('clankers/fixture-safety')].watchSDK(sdk);
  const clankers = await import(new URL('../../index.ts', import.meta.url).href);
  state = await import(new URL('../../state.ts', import.meta.url).href);
  const persistence = await import(new URL('../../persistence.ts', import.meta.url).href);
  const historyApi = await import(new URL('../../native-history.ts', import.meta.url).href);
  originalBind = sdk.AgentSession.prototype.bindExtensions; originalPrompt = sdk.AgentSession.prototype.prompt; originalDispose = sdk.AgentSession.prototype.dispose;
  originalOpen = sdk.SessionManager.open; originalFork = sdk.SessionManager.forkFrom;
  sdk.AgentSession.prototype.bindExtensions = async function (...args) { sessions.push(this); const result = await originalBind.apply(this, args); await bindGate?.(this); return result; };
  sdk.AgentSession.prototype.prompt = function (...args) { prompts++; return originalPrompt.apply(this, args); };
  sdk.AgentSession.prototype.dispose = function (...args) { const result = originalDispose.apply(this, args); disposed.push(this.sessionId); return result; };
  sdk.SessionManager.open = function (path, ...args) { assert(!sourceBytes.has(resolve(path)), 'Original source must NEVER be SDK opened'); return originalOpen.call(this, path, ...args); };
  sdk.SessionManager.forkFrom = function (path, ...args) { assert(!sourceBytes.has(resolve(path)), 'Original source must NEVER be SDK forked'); return originalFork.call(this, path, ...args); };
  container = state.createClankersStateContainer();
  const snapshotFile = join(root, 'snapshot.json');
  const owner = clankers.createClankersControl(container, { persistence: { enabled: true, snapshotFile } }); controls.push(owner);
  async function execute(input) { const result = await owner.execute(input); assert(result.ok, JSON.stringify(result)); return result; }
  async function show(runId) { return (await execute({ action: 'runs.show', runId })).data.run; }
  async function terminal(runId, status = 'done') {
    await until(async () => { const run = await show(runId); return run.status === status && run.nativeSessions?.every(ref => ref.attachment === 'disposed'); }, status + ' and disposed');
    return show(runId);
  }
  for (const id of ['leader', 'selected', 'sibling']) await execute({ action: 'agents.create', id, model: 'fixture/old', tools: [], prompt: 'OLD_AUTHORITY: concise original task only.' });
  await execute({ action: 'team.create', id: 'source-team', leader: 'leader', members: ['selected', 'sibling'] });
  const launch = await execute({ action: 'run', agent: 'source-team', task: 'ORIGINAL_TASK_TO_EDIT', background: true, concurrency: 2 });
  const sourceRun = await terminal(launch.runId);
  assert.equal(sourceRun.nativeSessions.length, 3);
  const source = sourceRun.nativeSessions.find(ref => ref.agentDefinitionId === 'selected'); assert(source);
  assert.notEqual(source.parentRunId, source.memberRunId);
  const rows = readFileSync(source.sessionFile, 'utf8').trim().split('\n').map(JSON.parse);
  const user = rows.find(row => row.type === 'message' && row.message.role === 'user'); assert(user);
  const timestamp = new Date().toISOString(), last = rows.at(-1);
  const compact = { type: 'compaction', id: 'f1000001', parentId: last.id, timestamp, summary: 'INHERITED_COMPACTION_SUMMARY', firstKeptEntryId: user.id, tokensBefore: 100, systemMessage: { role: 'system', content: '', sections: { preamble: 'OLD_AUTHORITY' }, toolsAdded: [], timestamp: Date.now() } };
  const edit = { type: 'context_edit', id: 'f1000002', parentId: compact.id, timestamp, targetId: user.id, replacement: { content: 'EDITED_RETAINED_HISTORY' } };
  const abandoned = { type: 'message', id: 'f1000003', parentId: compact.id, timestamp, message: { role: 'user', content: 'ABANDONED_BRANCH_FORBIDDEN', timestamp: Date.now() } };
  appendFileSync(source.sessionFile, [compact, edit, abandoned].map(JSON.stringify).join('\n') + '\n');
  for (const ref of sourceRun.nativeSessions) sourceBytes.set(resolve(ref.sessionFile), readFileSync(ref.sessionFile));
  const key = { parentRunId: source.parentRunId, memberRunId: source.memberRunId, piSessionId: source.piSessionId };
  await execute({ action: 'agents.update', id: 'selected', model: 'fixture/current', tools: ['read'], prompt: 'CURRENT_AUTHORITY: only the newly reviewed literal task.' });
  writeFileSync(join(root, 'AGENTS.md'), 'CURRENT_CONTEXT_NORMAL_RESOURCE: no external services or tools beyond current policy.\n');
  const prepareInput = { action: 'session.continuation.prepare', ...key, entryId: edit.id, body };
  const prepare = async (extra = {}) => { const result = await execute({ ...prepareInput, ...extra }); assert(result.data.review); return result.data.review; };
  const start = review => execute({ action: 'session.continuation.start', reviewId: review.reviewId, confirm: true });
  const beforeReview = boundary(), beforeSnapshot = readFileSync(snapshotFile);
  const review = await prepare();
  assert.equal(typeof review.reviewId, 'string'); assert.equal(review.body, body); assert.deepEqual(review.key, key); assert.equal(review.entryId, edit.id);
  assert.equal(review.sourceFingerprint, createHash('sha256').update(sourceBytes.get(resolve(source.sessionFile))).digest('hex'));
  assert.match(review.policyDigest, /^[a-f0-9]{64}$/); assert.equal(review.policy.model, 'fixture/current');
  assert.equal(review.policy.resourcePolicy, 'normal-default-resource-loader'); assert.equal(review.policy.definition.id, 'selected');
  assert.equal(review.policy.definition.prompt, 'CURRENT_AUTHORITY: only the newly reviewed literal task.'); assert.deepEqual(review.policy.definition.tools, ['read']);
  assert(review.warnings.length > 0, 'Normal hooks/current startup authority must be disclosed');
  assert(!JSON.stringify(review).includes('dummy-continuation-only'), 'Credential contents must never appear in review');
  assert.deepEqual(boundary(), beforeReview, 'Prepare never creates sessions/loads factories/binds/input/prompts/disposes/calls models');
  assert.deepEqual(readFileSync(snapshotFile), beforeSnapshot, 'Review is ephemeral, not a persisted run'); unchanged();
  async function denied(input, label) { const before = boundary(); const result = await owner.execute(input); assert.equal(result.ok, false, label + ': ' + JSON.stringify(result)); assert.deepEqual(boundary(), before, label + ' has no execution effects'); unchanged(); }
  await denied({ action: 'session.continuation.prepare', ...key, piSessionId: key.piSessionId + '-wrong', entryId: edit.id, body }, 'Wrong exact Pi identity');
  await denied({ ...prepareInput, runId: source.parentRunId }, 'Unsupported fields cannot broaden scope');
  await denied({ action: 'session.continuation.start', reviewId: review.reviewId, confirm: false }, 'Explicit true confirmation required');
  await execute({ action: 'session.continuation.discard', reviewId: review.reviewId });
  await denied({ action: 'session.continuation.start', reviewId: review.reviewId, confirm: true }, 'Discarded token');
  await denied({ action: 'session.continuation.start', reviewId: 'unknown-token', confirm: true }, 'Unknown token');
  const readOnlyReview = await prepare();
  const writableState = container.read(); container.replace({ ...writableState, mode: { ...writableState.mode, readOnly: true } });
  const readOnlyBoundary = boundary(), readOnlySnapshot = readFileSync(snapshotFile);
  const readOnlyPrepared = await prepare();
  assert.deepEqual(boundary(), readOnlyBoundary, 'Readonly preparation remains non-executing inspection');
  assert.deepEqual(readFileSync(snapshotFile), readOnlySnapshot, 'Readonly review creates no persisted task');
  await execute({ action: 'session.continuation.discard', reviewId: readOnlyPrepared.reviewId });
  await denied({ action: 'session.continuation.start', reviewId: readOnlyReview.reviewId, confirm: true }, 'Readonly start');
  container.replace(writableState);
  const driftedDefinition = await prepare();
  await execute({ action: 'agents.update', id: 'selected', prompt: 'DEFINITION_DRIFT_MUST_REJECT' });
  await denied({ action: 'session.continuation.start', reviewId: driftedDefinition.reviewId, confirm: true }, 'Current definition drift');
  await execute({ action: 'agents.update', id: 'selected', prompt: 'CURRENT_AUTHORITY: only the newly reviewed literal task.' });
  const driftedConfig = await prepare();
  writeFileSync(settingsPath, JSON.stringify({ ...settings, noSkills: true }));
  await denied({ action: 'session.continuation.start', reviewId: driftedConfig.reviewId, confirm: true }, 'Normal resource configuration drift');
  writeFileSync(settingsPath, JSON.stringify(settings));
  const driftedSource = await prepare(), originalSource = sourceBytes.get(resolve(source.sessionFile));
  // TEST-OWNED mutation injection, outside the runtime. The core may not alter it.
  appendFileSync(source.sessionFile, '\n');
  const injected = readFileSync(source.sessionFile), driftBoundary = boundary();
  try { const result = await owner.execute({ action: 'session.continuation.start', reviewId: driftedSource.reviewId, confirm: true }); assert.equal(result.ok, false); assert.deepEqual(boundary(), driftBoundary); assert.deepEqual(readFileSync(source.sessionFile), injected); }
  finally { writeFileSync(source.sessionFile, originalSource); }
  unchanged();
  const unsupported = { type: 'message', id: 'f1000004', parentId: edit.id, timestamp, message: { role: 'system', content: 'LEGACY_NONEMPTY_AUTHORITY', timestamp: Date.now() } };
  appendFileSync(source.sessionFile, JSON.stringify(unsupported) + '\n');
  const unsupportedBoundary = boundary();
  try { const result = await owner.execute({ ...prepareInput, entryId: unsupported.id }); assert.equal(result.ok, false, 'Unsupported selected plain system authority fails closed'); assert.deepEqual(boundary(), unsupportedBoundary); }
  finally { writeFileSync(source.sessionFile, originalSource); }
  unchanged();
  const successReview = await prepare(), startupBefore = boundary(), hooksBefore = trace().length;
  const freshLaunch = await start(successReview), fresh = await terminal(freshLaunch.runId);
  assert.equal(freshLaunch.data.runId, fresh.runId); assert.equal(freshLaunch.data.taskId, fresh.taskId);
  assert.notEqual(fresh.runId, source.parentRunId); assert.notEqual(fresh.runId, source.memberRunId); assert.notEqual(fresh.taskId, sourceRun.taskId);
  assert.equal(fresh.nativeSessions.length, 1, 'Copy launches exactly selected member, never old team/siblings/leader');
  const copied = fresh.nativeSessions[0]; assert.equal(copied.agentDefinitionId, 'selected'); assert.equal(copied.memberRunId, fresh.runId);
  assert.notEqual(copied.piSessionId, source.piSessionId); assert.notEqual(copied.sessionFile, source.sessionFile); assert.equal(copied.cwd, root);
  assert.equal(requests.length, startupBefore.requests + 1); assert.equal(prompts, startupBefore.prompts + 1); assert.equal(sessions.length, startupBefore.sessions + 1);
  assert.equal(disposed.filter(id => id === copied.piSessionId).length, 1, 'One truthful task-owned disposal');
  const copiedSession = sessions.find(session => session.sessionId === copied.piSessionId); assert(copiedSession);
  assert.equal(copiedSession.model?.provider, 'fixture'); assert.equal(copiedSession.model?.id, 'current');
  assert.equal(copiedSession.thinkingLevel, 'off', 'Normal Pi clamps current requested thinking for a nonreasoning model');
  const request = requests.at(-1), text = message => typeof message.content === 'string' ? message.content : message.content?.map(block => block.text ?? '').join('');
  assert.equal(request.model, 'current'); assert.equal(text(request.messages.at(-1)), body);
  assert.deepEqual((request.tools ?? []).map(tool => tool.function.name), ['read']);
  const systemText = request.messages.filter(message => message.role === 'system').map(text).join('\n');
  assert(systemText.includes('CURRENT_AUTHORITY')); assert(systemText.includes('CURRENT_CONTEXT_NORMAL_RESOURCE')); assert(systemText.includes('CURRENT_SKILL_NORMAL_RESOURCE'));
  assert(!systemText.includes('OLD_AUTHORITY'), 'Historical system/tool authority must be replaced by current policy');
  const context = JSON.stringify(request.messages);
  assert(context.includes('INHERITED_COMPACTION_SUMMARY')); assert(context.includes('EDITED_RETAINED_HISTORY')); assert(context.includes('OLD_FINAL_ONLY'));
  assert(!context.includes('ORIGINAL_TASK_TO_EDIT')); assert(!context.includes('ABANDONED_BRANCH_FORBIDDEN')); assert(!context.includes('TEMPLATE_EXPANSION_FORBIDDEN'));
  assert(!context.includes(source.piSessionId), 'Inherited native identity metadata must not leak into model context');
  assert(fresh.finalSummary?.includes('NEW_OUTPUT_ONLY')); assert(!fresh.finalSummary?.includes('OLD_FINAL_ONLY'), 'Final outcome must capture only new post-start assistant output');
  const hooks = trace().slice(hooksBefore);
  assert.equal(hooks.filter(row => row.kind === 'factory').length, 1); assert.deepEqual(hooks.filter(row => row.kind === 'session_start').map(row => row.id), [copied.piSessionId]);
  assert.deepEqual(hooks.filter(row => row.kind === 'input').map(row => row.text), [body]); assert.deepEqual(hooks.filter(row => row.kind === 'before_agent_start').map(row => row.prompt), [body]);
  assert(!trace().some(row => row.kind === 'COMMAND_DISPATCH_FORBIDDEN'));
  const newRows = readFileSync(copied.sessionFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(newRows[0].id, copied.piSessionId); assert.equal(newRows[0].parentSession, source.sessionFile);
  const currentModel = newRows.findLast(row => row.type === 'model_change');
  assert.equal(currentModel?.provider, 'fixture'); assert.equal(currentModel?.modelId, 'current');
  assert.equal(newRows.findLast(row => row.type === 'thinking_level_change')?.thinkingLevel, copiedSession.thinkingLevel, 'Destination records current effective thinking');
  const own = newRows.filter(row => row.type === 'custom' && row.customType === 'pi-clankers/native-session/v1'); assert.equal(own.length, 1);
  const { attachment: _attachment, disposedAt: _disposedAt, recoveredAt: _recoveredAt, ...sourceIdentity } = source;
  const lineage = newRows.filter(row => row.type === 'custom' && row.customType === 'pi-clankers/native-continuation/v1'); assert.equal(lineage.length, 1);
  assert.deepEqual(Object.keys(lineage[0].data).sort(), ['ancestors', 'entryId', 'policyDigest', 'schemaVersion', 'source', 'sourceFingerprint'].sort());
  assert.deepEqual(lineage[0].data.source, sourceIdentity); assert.equal(lineage[0].data.entryId, edit.id); assert.equal(lineage[0].data.sourceFingerprint, successReview.sourceFingerprint); assert.equal(lineage[0].data.policyDigest, successReview.policyDigest);
  const oldRows = readFileSync(source.sessionFile, 'utf8').trim().split('\n').map(JSON.parse).slice(1);
  for (const row of oldRows) {
    const inherited = newRows.find(candidate => candidate.id === row.id); assert(inherited, 'Whole historical tree copied, selected context still exact');
    const expected = row.type === 'custom' && row.customType === 'pi-clankers/native-session/v1' ? { ...row, customType: 'pi-clankers/native-ancestor-session/v1' } : row;
    assert.deepEqual(inherited, expected, 'Only recognized own metadata namespace changes; opaque payload/tree IDs preserved');
  }
  const ancestors = newRows.filter(row => row.type === 'custom' && ['pi-clankers/native-ancestor-session/v1', 'pi-clankers/native-ancestor-continuation/v1'].includes(row.customType));
  assert.deepEqual(lineage[0].data.ancestors, ancestors.map(row => ({ id: row.id, customType: row.customType, dataDigest: createHash('sha256').update(JSON.stringify(row.data)).digest('hex') })));
  await historyApi.readNativeHistory(copied, { agentDir: join(root, 'agent'), requireFinalNewline: true });
  await historyApi.readNativeHistory(source, { agentDir: join(root, 'agent'), requireFinalNewline: true });
  assert.equal(fresh.metadata.nativeContinuation.entryId, edit.id);
  for (const ref of [source, copied]) assert.deepEqual((await execute({ action: 'session.messages.list', parentRunId: ref.parentRunId, memberRunId: ref.memberRunId, piSessionId: ref.piSessionId })).data.receipts, [], 'No old queue/receipt copied or replayed');
  await denied({ action: 'session.continuation.start', reviewId: successReview.reviewId, confirm: true }, 'Repeated confirmation'); unchanged();
  const failReview = await prepare({ model: 'fixture/fail' }), failLaunch = await start(failReview), failed = await terminal(failLaunch.runId, 'failed');
  assert(!failed.finalSummary?.includes('OLD_FINAL_ONLY')); assert.equal(failed.nativeSessions.length, 1); unchanged();
  const handledReview = await prepare({ body: 'HANDLED_NO_MODEL: current input hook consumes without assistant' }), beforeHandledRequests = requests.length;
  const handledLaunch = await start(handledReview), handled = await terminal(handledLaunch.runId, 'failed');
  assert.equal(requests.length, beforeHandledRequests, 'Normal handled input makes no request'); assert(!handled.finalSummary?.includes('OLD_FINAL_ONLY')); unchanged();
  // Ordinary authorized hooks still run; their changes must be checked before
  // any provider request. Use public session/model APIs, not private SDK state.
  const hookKey = Symbol.for('pi-clankers/fixture/pre-provider-gate/v1');
  for (const change of ['readOnly', 'model']) {
    const gateReview = await prepare(), beforeRequests = requests.length;
    let hookApplied = false;
    globalThis[hookKey] = async ctx => {
      if (change === 'readOnly') {
        const current = container.read();
        container.replace({ ...current, mode: { ...current.mode, readOnly: true } });
      } else {
        const session = sessions.find(candidate => candidate.sessionId === ctx.sessionManager.getSessionId()); assert(session);
        const oldModel = (await session.modelRuntime.getAvailable()).find(model => model.provider === 'fixture' && model.id === 'old'); assert(oldModel);
        await session.setModel(oldModel);
        assert.equal(session.model.id, 'old');
      }
      hookApplied = true;
    };
    try {
      const gateLaunch = await start(gateReview), gateRun = await terminal(gateLaunch.runId, 'failed');
      assert(hookApplied, 'Normal startup hook actually applied ' + change);
      assert.equal(requests.length, beforeRequests, 'Final pre-provider gate blocks hook ' + change + ' drift');
      assert(!gateRun.finalSummary?.includes('OLD_FINAL_ONLY')); unchanged();
    } finally {
      delete globalThis[hookKey];
      if (change === 'readOnly') {
        const current = container.read();
        container.replace({ ...current, mode: { ...current.mode, readOnly: false } });
      }
    }
  }
  console.log('PASS actual SDK final pre-provider gate: normal hooks change readonly/model, ZERO provider requests');
  const slowReview = await prepare({ model: 'fixture/slow' }), competingReview = await prepare();
  const slowLaunch = await start(slowReview);
  await until(() => gates.length === 1, 'new current stream active');
  await denied({ action: 'session.continuation.start', reviewId: competingReview.reviewId, confirm: true }, 'Same-source concurrent admission');
  await execute({ action: 'interrupt', runId: slowLaunch.runId });
  const cancelled = await terminal(slowLaunch.runId, 'cancelled');
  assert.equal(disposed.filter(id => id === cancelled.nativeSessions[0].piSessionId).length, 1); release(); unchanged();
  // Abort admission while actual bind/session_start has run, before new prompt.
  let resumeBind, bound;
  bindGate = session => { bound = session; return new Promise(resolve => { resumeBind = resolve; gates.push(resolve); }); };
  const abortReview = await prepare(), abortBoundary = boundary(), abortLaunch = await start(abortReview);
  await until(() => Boolean(resumeBind), 'startup bind gate');
  await execute({ action: 'interrupt', runId: abortLaunch.runId });
  bindGate = undefined; resumeBind();
  const abortedRun = await terminal(abortLaunch.runId, 'cancelled');
  assert.equal(prompts, abortBoundary.prompts); assert.equal(requests.length, abortBoundary.requests); assert.equal(abortedRun.nativeSessions.length, 1);
  assert.equal(disposed.filter(id => id === bound.sessionId).length, 1); unchanged();
  // Owner-local review survives neither disposal nor persistence recovery.
  const restartReview = await prepare(), saved = owner.getState();
  owner.dispose();
  saved.extensions.clankersSessionMessages = { schemaVersion: 1, receipts: [{ schemaVersion: 1, messageId: 'old-queued-recovery-only', key, body: 'OLD_QUEUE_MUST_NOT_REPLAY', mode: 'followUp', status: 'queued', detail: 'TEST-owned recovery-boundary injection, not a connected queue', createdAt: timestamp, updatedAt: timestamp, persistence: 'saved' }] };
  persistence.createClankersPersistenceManager({ enabled: true, snapshotFile }).save(saved);
  const count = boundary();
  const restored = clankers.createClankersControl(state.createClankersStateContainer(), { persistence: { enabled: true, snapshotFile } }); controls.push(restored);
  const stale = await restored.execute({ action: 'session.continuation.start', reviewId: restartReview.reviewId, confirm: true });
  assert.equal(stale.ok, false, 'Review tokens do not survive owner restart');
  const recoveredReceipts = (await restored.execute({ action: 'session.messages.list', ...key })).data.receipts;
  assert.equal(recoveredReceipts.length, 1); assert.equal(recoveredReceipts[0].messageId, 'old-queued-recovery-only'); assert.equal(recoveredReceipts[0].status, 'needs-attention', 'Recovered queue is disconnected knowledge, never replayed');
  const inspected = await restored.execute({ action: 'runs.show', runId: source.parentRunId });
  assert.equal(inspected.ok, true); assert.equal(inspected.data.run.runId, source.parentRunId);
  assert.deepEqual(boundary(), count, 'Restart/inspection performs ZERO resource hooks/prompts/model requests'); unchanged();
  assert(!requests.some(request => JSON.stringify(request.messages).includes('OLD_QUEUE_MUST_NOT_REPLAY')));
  console.log('PASS native continuation SDK: exact isolated localhost requests=' + requests.length + '; one selected source/current normal resources, strict compaction/context_edit, one-use/drift/readonly/handled/failure/cancel/pre-prompt abort, lineage, no replay, original bytes preserved');
}
try { await Promise.race([fixture(), watchdog]); } catch (error) { failure = error; }
finally {
  clearTimeout(deadline);
  let cleanupFailure;
  for (const control of controls) { try { control.dispose(); } catch (error) { cleanupFailure ??= error; } }
  release();
  const settled = () => (!container || !state || state.getSubagentRunSnapshots(container.read()).every(run => ['done', 'failed', 'cancelled', 'needs-attention'].includes(run.status) && (run.nativeSessions ?? []).every(ref => ref.attachment !== 'attached'))) && sessions.every(session => disposed.includes(session.sessionId));
  const end = Date.now() + 10000;
  while (!settled() && Date.now() < end) await sleep(20);
  try { unchanged(); } catch (error) { cleanupFailure ??= error; }
  server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
  if (timedOut || !settled()) {
    // Promise.race cannot cancel bootstrap; never expose restored real env/network
    // to an unresolved continuation. Retain dummy-only failure evidence and exit.
    console.error('Unsettled isolated continuation fixture; guards retained:', root); console.error(failure ?? cleanupFailure); process.exit(1);
  }
  // Dedicated subprocess: keep the dummy environment, SDK observation wrappers,
  // and network guards until process exit, including any unexpected late bootstrap.
  // A terminal snapshot is not a proof that every asynchronous callback has ended.
  rmSync(root, { recursive: true, force: true }); failure ??= cleanupFailure ?? serverFailure;
}
if (failure) throw failure;
