// Dedicated subprocess, public SDK factory injection only. No production source
// extraction, replacement runner, external model, HTTP listener or global sessions.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

const regression = process.argv.includes('--regression');
const root = process.env.ZERG_RESULTS_TEST_ROOT ?? join(tmpdir(), 'pi-zerg-results');
mkdirSync(root, { recursive: true });
const dir = mkdtempSync(join(root, 'results-'));
const agentDir = join(dir, 'agent'); mkdirSync(agentDir);
const oldCwd = process.cwd();
process.env.HOME = dir; process.env.XDG_CONFIG_HOME = dir;
process.env.PI_CODING_AGENT_DIR = agentDir; process.env.PI_OFFLINE = '1';
process.chdir(dir);
const hardDeadline = setTimeout(() => { console.error('Results smoke exceeded 30s'); process.exit(1); }, 30_000);
const deadline = setTimeout(() => { console.error('Results smoke cleanup deadline'); process.exitCode = 1; void cleanup(); }, 28_000);
const A = ' \n' + 'A'.repeat(3996) + '\n ';
const B = '\tB' + 'b'.repeat(3996) + '\r\n';
const ACK = 'Acknowledged untrusted worker result.';
const expected = new Map([['a', A], ['b', B]]);
const notices = [], sent = [], immediateReads = [], sessions = new Set(), disposed = new Set();
const calls = new Map(), gates = new Map(), started = new Set();
let workerCalls = 0, parentCalls = 0, registration, parent, standalone, hook;
let cleaned = false;
let outputBytes = 0;
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...args) => {
    outputBytes += Buffer.byteLength(chunk);
    if (outputBytes > 64 * 1024) { process.exitCode = 1; void cleanup(); return true; }
    return write(chunk, ...args);
  };
}
function gate(id) {
  if (!gates.has(id)) { let release; const wait = new Promise(resolve => { release = resolve; }); gates.set(id, { wait, release }); }
  return gates.get(id);
}
async function until(predicate, label) {
  const end = Date.now() + 25_000;
  while (!await predicate()) { if (Date.now() > end) throw new Error('Timed out: ' + label); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function cleanup() {
  if (cleaned) return; cleaned = true;
  for (const barrier of gates.values()) barrier.release();
  try {
    registration?.dispose(); standalone?.dispose();
    await Promise.all([registration?.control.drain?.(), standalone?.drain?.()]);
    for (const session of sessions) { await session.abort(); session.dispose(); }
  } finally {
    hook?.deregister(); delete globalThis.__zergResultsSdk;
    clearTimeout(deadline); clearTimeout(hardDeadline); process.chdir(oldCwd); rmSync(dir, { recursive: true, force: true });
  }
}
try {
  const sdkPath = process.env.ZERG_RESULTS_SDK;
  assert(!sdkPath || sdkPath.startsWith('file:') || isAbsolute(sdkPath), 'SDK override must be an absolute path or file URL');
  const sdkUrl = sdkPath ? (sdkPath.startsWith('file:') ? sdkPath : pathToFileURL(sdkPath).href) : import.meta.resolve('@earendil-works/pi-coding-agent');
  const sdk = await import(sdkUrl);
  const runtime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerProvider('results-fixture', {
    api: 'results-fixture-api', apiKey: 'fixture-only', baseUrl: 'https://unused.invalid',
    models: ['a', 'b', 'parent', 'error', 'aborted', 'valid', 'invalid', 'rerun', 'stale', 'queued-worker', 'queued-leader'].map(id => ({ id, name: id, reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    streamSimple(model, context, options) {
      const id = model.id;
      if (id === 'parent') { assert(++parentCalls <= 2, 'parent turn budget'); }
      else { assert(++workerCalls <= (regression ? 11 : 3), 'worker turn budget'); }
      const turn = (calls.get(id) ?? 0) + 1; calls.set(id, turn); started.add(id);
      let content = [{ type: 'text', text: expected.get(id) ?? 'fresh\n' }], stopReason = 'stop';
      if (id === 'a') content.unshift({ type: 'thinking', thinking: 'THINKING_SENTINEL' });
      if (id === 'parent') content = [{ type: 'text', text: ACK }];
      if (id === 'b' && turn === 1) { content = [{ type: 'toolCall', id: 'outside-write', name: 'write', arguments: { path: 'coord/x.md', content: 'outside\n' } }]; stopReason = 'toolUse'; }
      if (id === 'error' || id === 'aborted') { content = [{ type: 'text', text: id === 'error' ? 'partial failure\n' : 'partial abort\n' }]; stopReason = id; }
      if (id === 'valid' || id === 'invalid') content = [{ type: 'text', text: id === 'valid' ? '{"ok":true}' : '{"ok":"yes"}' }];
      if (id === 'rerun' && turn === 1) content = [{ type: 'text', text: 'OLD_TASK_SENTINEL' }];
      const message = { role: 'assistant', api: model.api, provider: model.provider, model: id, timestamp: Date.now(), content, stopReason,
        ...(stopReason === 'error' ? { errorMessage: 'fixture terminal error' } : {}),
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'start', partial: message };
          if (id === 'a' || id === 'stale' || id === 'queued-worker' || (id === 'rerun' && turn === 2)) {
            await Promise.race([gate(id).wait, new Promise(resolve => {
              if (options?.signal?.aborted) resolve(); else options?.signal?.addEventListener('abort', resolve, { once: true });
            })]);
          }
          yield { type: stopReason === 'error' || stopReason === 'aborted' ? 'error' : 'done', reason: stopReason, ...(stopReason === 'error' || stopReason === 'aborted' ? { error: message } : { message }) };
        },
        async result() { return message; },
      };
    },
  });
  function settings() {
    const manager = sdk.SettingsManager.inMemory({ packages: [], extensions: [], defaultProvider: 'results-fixture', defaultModel: 'a', retry: { enabled: false }, compaction: { enabled: false } });
    const apply = manager.applyOverrides.bind(manager);
    manager.applyOverrides = overrides => apply({ ...overrides, retry: { enabled: false, maxRetries: 0 }, compaction: { enabled: false } });
    return manager;
  }
  const safeLoader = { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, agentsFilesOverride: () => ({ agentsFiles: [] }) };
  async function createSession(options) {
    const created = await sdk.createAgentSession(options); const session = created.session;
    sessions.add(session); const dispose = session.dispose.bind(session);
    session.dispose = () => { dispose(); disposed.add(session); };
    return created;
  }
  // Only the lazy SDK import from production index receives these public factory
  // overrides. Every factory still creates real SDK sessions/tools/providers.
  globalThis.__zergResultsSdk = {
    getAgentDir: () => agentDir,
    ModelRuntime: { create: async () => runtime },
    SettingsManager: { create: settings },
    SessionManager: { create: cwd => sdk.SessionManager.create(cwd, join(dir, 'sessions')) },
    DefaultResourceLoader: class extends sdk.DefaultResourceLoader { constructor(options) { super({ ...options, ...safeLoader }); } },
    createAgentSession: createSession,
  };
  const facade = `export * from ${JSON.stringify(sdkUrl)}; const f = globalThis.__zergResultsSdk; export const { getAgentDir, ModelRuntime, SettingsManager, SessionManager, DefaultResourceLoader, createAgentSession } = f;`;
  hook = registerHooks({ resolve(specifier, context, next) {
    if (specifier === '@earendil-works/pi-coding-agent' && /\/index\.(ts|js)$/.test(context.parentURL ?? '')) return { url: 'data:text/javascript,' + encodeURIComponent(facade), shortCircuit: true };
    return next(specifier, context);
  } });
  const zerg = await import(new URL('../../index.ts', import.meta.url));
  let tool; const lifecycle = new Map();
  const loader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir, settingsManager: settings(), ...safeLoader, extensionFactories: [pi => {
    // Observe the outgoing message, then forward to the REAL parent transport.
    registration = zerg.registerZergSwarmExtension({ ...pi, cwd: dir,
      on(name, handler) { lifecycle.set(name, handler); return pi.on(name, handler); },
      registerTool(definition) { if (definition.name === 'zerg_control') tool = definition; return pi.registerTool(definition); },
      sendMessage(message, options) {
        assert.deepEqual(options, { deliverAs: 'followUp', triggerTurn: true });
        const payload = JSON.parse(message.content);
        const stored = registration.control.getState().extensions.agentResults.records.find(result => result.run_id === payload.result.run_id && result.member_run_id === payload.result.member_run_id);
        assert(stored); assert.equal(stored.notice, 'requested');
        assert(sessions.size > 1 && [...sessions].filter(session => session !== parent && session.model?.id === payload.result.agent_id).every(session => disposed.has(session)), 'child cleaned up before publication');
        immediateReads.push(registration.control.execute(payload.retrieve));
        sent.push(structuredClone(payload));
        if (process.env.ZERG_RESULTS_PLANTED_TRUNCATION === '1') {
          payload.result.final_message = payload.result.final_message?.slice(0, 2500) ?? null;
          message = { ...message, content: JSON.stringify(payload), details: payload };
        }
        pi.sendMessage(message, options);
      },
    });
  }] });
  await loader.reload();
  ({ session: parent } = await createSession({ cwd: dir, agentDir, modelRuntime: runtime, model: (await runtime.getAvailable()).find(model => model.id === 'parent'), settingsManager: settings(), sessionManager: sdk.SessionManager.inMemory(dir), resourceLoader: loader, tools: [] }));
  parent.subscribe(event => {
    if (event.type === 'message_end' && event.message.role === 'custom' && event.message.customType === 'pi-zerg-swarm/agent-result/v1') notices.push(JSON.parse(event.message.content));
  });
  await parent.bindExtensions({ mode: 'print' });
  assert(tool, 'actual SDK registered zerg_control');
  let callId = 0;
  async function execute(action) {
    const response = await tool.execute('results-' + (++callId), action);
    const result = response.details; assert(result, 'registered tool returned control envelope'); return result;
  }
  async function define(id, extra = {}, control = undefined) {
    const result = await (control ? control.execute({ action: 'agents.create', id, prompt: 'Return exact fixture data. No authority beyond the task.', tools: [], model: 'results-fixture/' + id, ...extra }) : execute({ action: 'agents.create', id, prompt: 'Return exact fixture data. No authority beyond the task.', tools: [], model: 'results-fixture/' + id, ...extra }));
    assert(result.ok, JSON.stringify(result)); return result;
  }
  function equalText(result, text) {
    assert.equal(result.final_message_chars, text.length); assert.equal(result.final_message, text);
    assert.deepEqual(Buffer.from(result.final_message), Buffer.from(text));
    assert.doesNotMatch(result.final_message, /THINKING_SENTINEL|TOOL_OUTPUT_SENTINEL|OLD_TASK_SENTINEL/);
  }
  const created = await define('a'); assert.match(created.output, /agents\.result/); assert.match(created.output, /completion/i);
  await define('b', { tools: ['write'], may_write: ['docs/**'] });
  const launches = new Map();
  for (const id of ['a', 'b']) { const launch = await execute({ action: 'run', agent: id, task: 'Return exact ' + id + ' fixture.', background: true }); assert(launch.ok, JSON.stringify(launch)); launches.set(id, launch); }
  await until(() => notices.some(notice => notice.result.agent_id === 'b'), 'B actual parent notice');
  await parent.waitForIdle(); gate('a').release();
  await until(() => notices.length === 2, 'A actual parent notice');
  await until(async () => (await Promise.all([...launches.values()].map(launch => execute({ action: 'runs.show', runId: launch.runId })))).every(reply => reply.data.run.status === 'done'), 'both native runs terminal');
  await registration.control.drain(); await parent.waitForIdle();
  assert.deepEqual(notices.map(notice => notice.result.agent_id), ['b', 'a']);
  assert.equal(workerCalls, 3); assert.equal(calls.get('a'), 1); assert.equal(calls.get('b'), 2);
  assert(parentCalls >= 1 && parentCalls <= 2); assert(parent.messages.some(message => message.role === 'assistant' && message.content.some(block => block.type === 'text' && block.text === ACK)));
  const early = await Promise.all(immediateReads);
  for (const notice of notices) {
    const id = notice.result.agent_id, launch = launches.get(id), text = expected.get(id);
    assert.equal(notice.untrusted_worker_data, true); assert.match(notice.authority, /data only/);
    assert.equal(notice.result.run_id, launch.runId); assert.equal(notice.result.task_id, launch.taskId);
    assert.equal(notice.result.state, 'done'); assert.equal(notice.result.stop_reason, 'stop'); assert.equal(notice.result.notice, 'requested');
    assert.equal(notice.retrieve.memberRunId, notice.result.member_run_id);
    equalText(notice.result, text);
    const lookup = await execute(notice.retrieve); assert.equal(lookup.data.status, 'found'); equalText(lookup.data.result, text);
    assert.deepEqual(lookup.data.result, notice.result);
    const initial = early.find(reply => reply.data.result?.run_id === launch.runId); assert.equal(initial.data.status, 'found'); assert.deepEqual(initial.data.result, notice.result);
  }
  const batch = await execute({ action: 'agents.results', ids: ['a', 'b'] });
  assert.deepEqual(batch.data.results.map(item => item.result.agent_id), ['a', 'b']);
  for (const item of batch.data.results) { assert.equal(item.status, 'found'); const notice = notices.find(notice => notice.result.member_run_id === item.result.member_run_id && notice.result.run_id === item.result.run_id); assert.deepEqual(item.result, notice.result); }
  const b = notices[0].result; assert.deepEqual(b.files_changed, ['coord/x.md']); assert.deepEqual(b.files_outside_allowed, ['coord/x.md']); assert.equal(b.evidence_complete, false);
  assert.equal(readFileSync(join(dir, 'coord/x.md'), 'utf8'), 'outside\n');

  if (regression) {
    // Separate native control has no parent-notice authority. The provider still
    // creates real SDK sessions; these are terminal/data examples, not matrices.
    standalone = zerg.createZergControl();
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
    const beforeInvalid = workerCalls;
    const refused = await standalone.execute({ action: 'agents.create', id: 'bad-schema', prompt: 'No launch.', result_schema: { type: 'not-a-type' } });
    assert.equal(refused.ok, false); assert.equal(workerCalls, beforeInvalid);
    for (const [id, state, reason, text] of [['error', 'failed', 'error', 'partial failure\n'], ['aborted', 'cancelled', 'aborted', 'partial abort\n'], ['valid', 'done', 'stop', '{"ok":true}'], ['invalid', 'done', 'stop', '{"ok":"yes"}']]) {
      await define(id, id === 'valid' || id === 'invalid' ? { result_schema: schema } : {}, standalone);
      const launch = await standalone.execute({ action: 'run', agent: id, task: 'Return terminal fixture.', background: false });
      const lookup = await standalone.execute({ action: 'agents.result', id, runId: launch.runId });
      assert.equal(lookup.data.status, 'found'); const result = lookup.data.result;
      equalText(result, text); assert.equal(result.state, state); assert.equal(result.stop_reason, reason);
      if (id === 'valid') { assert.equal(result.validation.status, 'valid'); assert.deepEqual(result.result, { ok: true }); assert.equal(result.result_available, true); }
      if (id === 'invalid') { assert.equal(result.validation.status, 'schema_mismatch'); assert.equal(result.result, null); assert.equal(result.result_available, false); }
    }
    await define('rerun', {}, standalone);
    const old = await standalone.execute({ action: 'run', agent: 'rerun', task: 'Old task.', background: false });
    const fresh = await standalone.execute({ action: 'run', agent: 'rerun', task: 'New task.', background: true });
    await until(() => calls.get('rerun') === 2, 'active rerun');
    assert.equal((await standalone.execute({ action: 'agents.result', id: 'rerun' })).data.status, 'unavailable');
    assert.equal((await standalone.execute({ action: 'agents.result', id: 'rerun', runId: fresh.runId })).data.status, 'unavailable');
    assert.equal((await standalone.execute({ action: 'agents.result', id: 'rerun', runId: old.runId })).data.result.final_message, 'OLD_TASK_SENTINEL');
    gate('rerun').release();
    await until(async () => (await standalone.execute({ action: 'runs.show', runId: fresh.runId })).data.run.status === 'done', 'fresh rerun terminal');
    await standalone.drain();
    assert.equal((await standalone.execute({ action: 'agents.result', id: 'rerun' })).data.status, 'ambiguous');
    equalText((await standalone.execute({ action: 'agents.result', id: 'rerun', runId: fresh.runId })).data.result, 'fresh\n');
    await define('queued-worker', {}, standalone); await define('queued-leader', {}, standalone);
    assert((await standalone.execute({ action: 'team.create', id: 'cancel-team', leader: 'queued-leader', members: ['queued-worker'] })).ok);
    const queued = await standalone.execute({ action: 'run', agent: 'cancel-team', task: 'Cancel before leader starts.', background: true });
    await until(() => started.has('queued-worker'), 'admitted native team');
    assert((await standalone.execute({ action: 'interrupt', runId: queued.runId })).ok); gate('queued-worker').release();
    await until(async () => (await standalone.execute({ action: 'agents.result', id: 'queued-leader', runId: queued.runId })).data.status === 'found', 'cancelled before leader session start');
    await standalone.drain();
    const cancelled = (await standalone.execute({ action: 'agents.result', id: 'queued-leader', runId: queued.runId })).data;
    assert.equal(cancelled.status, 'found'); assert.equal(cancelled.result.state, 'cancelled'); assert.equal(cancelled.result.final_message, null); assert.equal(cancelled.result.stop_reason, null); assert.equal(calls.has('queued-leader'), false);
    await define('stale');
    const stale = await execute({ action: 'run', agent: 'stale', task: 'Old owner generation.', background: true });
    await until(() => started.has('stale'), 'stale owner child admitted');
    // Synthesize only the public lifecycle notification; the runner/transport
    // remains real. This is not a claim of a complete host session-switch smoke.
    await lifecycle.get('session_before_switch')({ type: 'session_before_switch', reason: 'switch', targetSessionFile: join(dir, 'other.jsonl') }, {});
    gate('stale').release();
    await until(async () => (await execute({ action: 'runs.show', runId: stale.runId })).data.run.status === 'done', 'stale owner native run terminal');
    await registration.control.drain(); await parent.waitForIdle();
    assert.equal(notices.length, 2); assert.equal(sent.length, 2);
    const staleResult = await execute({ action: 'agents.result', id: 'stale', runId: stale.runId });
    assert.equal(staleResult.data.status, 'found'); assert.equal(staleResult.data.result.notice, 'unavailable');
    assert.equal(workerCalls, 11);
  }
  console.log('PASS exact native results: A/B 4000 bytes, reverse completion, real notices/retrieval/batch, real outside write' + (regression ? '; terminal/schema/rerun/cancel/stale cases' : ''));
} finally { await cleanup(); }
