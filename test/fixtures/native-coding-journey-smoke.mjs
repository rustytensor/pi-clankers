import { installFixtureSafety } from './fixture-safety.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Standalone isolated integration fixture; run under an owned-process supervisor.
// Scripted loopback responses exercise genuine SDK tools, not model quality.
// No operator auto-confirm: authority below is ONLY this exact synthetic review.
const guard = installFixtureSafety({ name: 'coding-journey', maxRequests: 40,
  maxRequestBytes: 1048576, maxOutputBytes: 8388608, timeoutMs: 235000 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const sdk = await import('@earendil-works/pi-coding-agent');
guard.watchSDK(sdk);
const zerg = await import(new URL('../../index.ts', import.meta.url).href);
const state = await import(new URL('../../state.ts', import.meta.url).href);
const persistence = await import(new URL('../../persistence.ts', import.meta.url).href);

if (process.argv[2] === '--recover') {
  // A genuinely fresh process with its OWN empty HOME/cwd and no listener.
  const info = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  let execution = 0;
  for (const method of ['bindExtensions', 'prompt']) sdk.AgentSession.prototype[method] = function () {
    execution++; throw Error('Recovery must not execute SDK sessions');
  };
  const owner = zerg.createZergControl(state.createZergStateContainer(), {
    persistence: { enabled: true, snapshotFile: info.snapshotFile },
    subagentAdapter: { kind: 'fake', launch() { execution++; throw Error('Recovery launch'); },
      sendMessage() { execution++; throw Error('Recovery send'); } },
  });
  try {
    const timeline = await owner.execute({ action: 'timeline.list', ...info.key }); assert(timeline.ok);
    assert.equal(timeline.data.entries.find(entry => entry.kind === 'operator-receipt').status, 'needs-attention');
    const start = await owner.execute({ action: 'session.continuation.start', reviewId: info.reviewId, confirm: true });
    assert.equal(start.ok, false, 'Ephemeral review cannot survive fresh-process restart');
    assert.equal(execution, 0); assert.equal(guard.requests, 0);
    for (const [file, digest] of info.hashes) assert.equal(hash(file), digest);
    console.log('PASS fresh-process recovery: detached knowledge, zero execution/network/queue/tool replay');
  } finally { owner.dispose(); }
} else {
  const work = process.cwd(), agentDir = process.env.PI_CODING_AGENT_DIR;
  const source = join(work, 'src', 'bounded-count.mjs'), tests = join(work, 'supervisor-tests.mjs');
  const sentinel = join(work, 'do-not-touch.txt'), snapshotFile = join(work, 'state.json');
  mkdirSync(join(work, 'src')); mkdirSync(join(work, '.pi')); mkdirSync(join(agentDir, 'extensions'));
  const defect = 'export function boundedCount(value, max = 10) { return Math.max(0, Math.min(value || max, max)); }\n';
  const fixed = defect.replace('value || max', 'value ?? max');
  // The server NEVER writes source/tests. Only supervisor setup writes baseline;
  // after this, exactly ONE genuine implementer SDK edit may mutate the source.
  writeFileSync(source, defect); writeFileSync(sentinel, 'immutable synthetic sentinel\n');
  writeFileSync(tests, `import assert from 'node:assert/strict'; import test from 'node:test';
import { boundedCount } from './src/bounded-count.mjs';
test('zero remains zero',()=>assert.equal(boundedCount(0),0));
test('negative clamps',()=>assert.equal(boundedCount(-3),0));
test('maximum clamps',()=>assert.equal(boundedCount(30),10));
test('nonzero remains nonzero',()=>assert.equal(boundedCount(4),4));\n`);
  const immutable = [[tests, hash(tests)], [sentinel, hash(sentinel)]];
  const nativeHashes = new Map();
  const unchanged = () => {
    for (const [file, digest] of [...immutable, ...nativeHashes]) assert.equal(hash(file), digest, file);
  };
  const command = `'${process.execPath}' --test --test-reporter=tap '${tests}'`;
  function supervisorTest() {
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', tests], {
      cwd: work, env: guard.childEnv(), timeout: 10000, maxBuffer: 65536, encoding: 'utf8', killSignal: 'SIGKILL',
    });
    assert.ifError(result.error); assert.equal(result.signal, null); unchanged(); return result;
  }
  const baseline = supervisorTest(); assert.equal(baseline.status, 1);
  assert.match(baseline.stdout, /# fail 1/); assert.match(baseline.stdout, /zero remains zero/);
  const trace = [], requests = [], sessions = [], disposals = new Map(), gates = new Set();
  const receivedReports = new Map(), reportRuns = new Map();
  let active = 0, peakActive = 0, toolGate, startupGate, failure, serverFailure, owner, restartChild;
  let investigationGate, investigationReleased = false;
  function pause(signal) {
    return new Promise(resolve => {
      const release = () => { gates.delete(release); resolve(); };
      gates.add(release); if (signal?.aborted) release(); else signal?.addEventListener('abort', release, { once: true });
    });
  }
  function releaseAll() { for (const release of [...gates]) release(); investigationGate?.(); }
  const policyKey = Symbol.for('zerg/coding-journey/policy');
  globalThis[policyKey] = {
    trace,
    admit(role, event) {
      const { toolName, input } = event;
      if (toolName === 'read') {
        const allowed = role === 'investigator' ? [source] : role === 'designer' ? [tests] :
          ['implementer', 'summary'].includes(role) ? [source] : [source, tests];
        assert(allowed.includes(input.path), 'Exact read path only');
      } else if (toolName === 'edit') {
        assert.equal(role, 'implementer'); assert.equal(input.path, source);
        assert.deepEqual(input, { path: source, edits: [{ oldText: 'value || max', newText: 'value ?? max' }] });
        assert.equal(receivedReports.size, 2, 'Only leader AFTER receiving both exact worker results may patch');
        assert(receivedReports.get('investigator')?.final_message.includes('INVESTIGATION:'));
        assert(receivedReports.get('designer')?.final_message.includes('REGRESSION:'));
        assert(trace.some(row => row.kind === 'result' && row.role === 'implementer' && row.toolName === 'read' && !row.isError && JSON.stringify(row.content).includes('value || max')), 'Actual source read must precede edit');
      } else if (toolName === 'bash') {
        assert.equal(role, 'verifier'); assert.equal(input.command, command);
        assert.equal(input.timeout, 10);
      } else throw Error('Tool outside exact synthetic authority');
      unchanged(); trace.push({ kind: 'admit', role, toolName, input });
    },
    async readGate(role, signal) {
      if (role === 'cancel-tool') { toolGate = true; await pause(signal); }
      if (signal?.aborted) throw Error('Cancelled BEFORE underlying read');
      trace.push({ kind: 'read-executed', role });
    },
    async startup(role, signal) { if (role === 'cancel-startup') { startupGate = true; await pause(signal); } },
  };
  // Trusted normal auto-discovered fixture extension, not sealed resources.
  // Wrap only the public read tool to gate a REAL tool execution for cancellation.
  writeFileSync(join(agentDir, 'extensions', 'journey.ts'), `import { createReadTool } from '@earendil-works/pi-coding-agent';
const key=Symbol.for('zerg/coding-journey/policy');
export default function(pi) {
  pi.on('session_start',(_event,ctx)=>globalThis[key].startup(ctx.model?.id,ctx.signal));
  pi.on('tool_call',(event,ctx)=>{globalThis[key].admit(ctx.model?.id,event);});
  pi.on('tool_result',(event,ctx)=>{globalThis[key].trace.push({kind:'result',role:ctx.model?.id,toolName:event.toolName,isError:event.isError,content:event.content});});
  const read=createReadTool(${JSON.stringify(work)});
  pi.registerTool({...read,execute:async(id,args,signal,onUpdate,ctx)=>{
    await globalThis[key].readGate(ctx.model?.id,signal);
    return read.execute(id,args,signal,onUpdate);
  }});
}\n`);
  function text(message) { return typeof message.content === 'string' ? message.content : (message.content ?? []).map(block => block.text ?? '').join(''); }
  async function receiveReports(role, messages, ids) {
    const runId = reportRuns.get(role); assert(runId, 'Exact leader run required');
    const leaderTask = messages.find(message => message.role === 'user' && text(message).includes('The worker pass finished with:'));
    assert(leaderTask, 'Leader must actually receive worker-result previews');
    const previews = text(leaderTask).split('\n').filter(line => line.startsWith('Untrusted worker data: '))
      .map(line => JSON.parse(line.slice('Untrusted worker data: '.length)));
    assert.equal(previews.length, ids.length);
    for (const id of ids) {
      const memberRunId = `${runId}-${id}`;
      const preview = previews.find(result => result.agent_id === id);
      assert(preview, 'Missing required received report: ' + id);
      assert.equal(preview.run_id, runId); assert.equal(preview.member_run_id, memberRunId);
      assert.equal(preview.state, 'done'); assert.equal(preview.omitted_chars, 0);
      const retained = await execute({ action: 'agents.result', id, runId, memberRunId });
      assert.equal(retained.data.status, 'found');
      assert.deepEqual(preview, retained.data.result, 'Received preview must equal genuine exact retained worker result');
      receivedReports.set(id, preview);
    }
  }
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, 'Bearer dummy-journey-only');
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const input = JSON.parse(Buffer.concat(chunks)); requests.push(input); assert(requests.length <= 40);
      assert.equal(input.stream, true);
      const role = input.model;
      assert(['investigator', 'designer', 'implementer', 'reviewer', 'verifier', 'summary',
        'continuation', 'cancel-stream', 'cancel-tool', 'cancel-startup'].includes(role));
      const allowedTools = role === 'implementer' ? ['read', 'edit'] : role === 'verifier' ? ['read', 'bash'] : ['read'];
      assert.deepEqual((input.tools ?? []).map(tool => tool.function.name).sort(), allowedTools.sort());
      let messages = input.messages;
      if (role === 'continuation') {
        const newTask = messages.findLastIndex(message => message.role === 'user' && text(message).includes('NEW_JOURNEY_REVIEW'));
        assert(newTask >= 0); messages = messages.slice(newTask);
        const system = input.messages.filter(message => message.role === 'system').map(text).join('\n');
        assert(system.includes('CURRENT_REVIEW_ONLY')); assert(!system.includes('IMPLEMENTER_AUTHORITY'));
      }
      const calls = new Map(messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? []).map(call => [call.id, call]));
      const results = messages.filter(message => message.role === 'tool').map(result => {
        const call = calls.get(result.tool_call_id); assert(call, 'Tool result must have actual prior call');
        const args = JSON.parse(call.function.arguments); return { name: call.function.name, args, content: text(result) };
      });
      const read = path => results.some(result => result.name === 'read' && result.args.path === path);
      const readResult = path => results.find(result => result.name === 'read' && result.args.path === path)?.content;
      let tool, answer;
      if (role === 'investigator') {
        if (!read(source)) tool = ['read', { path: source }];
        else { assert(readResult(source).includes('value || max')); answer = 'INVESTIGATION: zero is incorrectly defaulted by value || max. Narrow patch uses nullish default.'; }
      } else if (role === 'designer') {
        if (!read(tests)) tool = ['read', { path: tests }];
        else { assert(readResult(tests).includes('zero remains zero')); answer = 'REGRESSION: immutable tests cover zero, negative, maximum, nonzero; baseline zero fails.'; }
      } else if (role === 'implementer') {
        await receiveReports(role, messages, ['investigator', 'designer']);
        if (!read(source)) tool = ['read', { path: source }];
        else if (!results.some(result => result.name === 'edit')) {
          assert(readResult(source).includes('value || max'));
          assert(receivedReports.get('investigator').final_message.includes('INVESTIGATION:'));
          assert(receivedReports.get('designer').final_message.includes('REGRESSION:'));
          tool = ['edit', { path: source, edits: [{ oldText: 'value || max', newText: 'value ?? max' }] }];
        } else { assert.equal(readFileSync(source, 'utf8'), fixed); answer = 'IMPLEMENTED: one authorized narrow source patch; independent verification still required.'; }
      } else if (role === 'reviewer') {
        const missing = [source, tests].find(path => !read(path));
        if (missing) tool = ['read', { path: missing }];
        else { assert(readResult(source).includes('value ?? max')); answer = 'REVIEWED: exact nullish patch preserves zero; supervisor tests unchanged.'; }
      } else if (role === 'verifier') {
        const result = results.find(result => result.name === 'bash');
        if (!result) tool = ['bash', { command, timeout: 10 }];
        else { assert(result.content.includes('# pass 4')); assert(result.content.includes('# fail 0')); answer = 'VERIFIED: genuine absolute-node test command reports four pass, zero fail.'; }
      } else if (role === 'summary') {
        await receiveReports(role, messages, ['reviewer', 'verifier']);
        assert(receivedReports.get('reviewer').final_message.includes('REVIEWED:'));
        assert(receivedReports.get('verifier').final_message.includes('VERIFIED:'));
        const verified = trace.find(row => row.kind === 'result' && row.role === 'verifier' && row.toolName === 'bash');
        assert(verified && !verified.isError); assert(JSON.stringify(verified.content).includes('# pass 4'));
        assert(JSON.stringify(verified.content).includes('# fail 0'));
        answer = 'ACCEPTED: independent review and actual verifier tests both present.';
      } else if (role === 'continuation') {
        if (!read(tests)) tool = ['read', { path: tests }];
        else { assert(readResult(tests).includes('zero remains zero')); answer = 'NEW_REVIEW_ONLY: extra immutable test inspection under current read-only tool policy.'; }
      } else if (role === 'cancel-tool') tool = ['read', { path: source }];
      else if (role === 'cancel-startup') throw Error('Startup-cancelled worker reached provider');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'journey', object: 'chat.completion.chunk', created: 1, model: role, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
      emit({ role: 'assistant' });
      if (role === 'investigator' && !investigationReleased) {
        await new Promise(resolve => { investigationGate = () => { investigationReleased = true; resolve(); }; res.on('close', resolve); });
      }
      if (role === 'cancel-stream') { emit({ content: 'stream awaiting explicit cancellation' }); await pause(); }
      if (res.destroyed) return;
      if (tool) {
        emit({ tool_calls: [{ index: 0, id: 'journey-call-' + requests.length, type: 'function', function: { name: tool[0], arguments: JSON.stringify(tool[1]) } }] }); emit({}, 'tool_calls');
      } else { emit({ content: answer ?? 'cancelled stream must never become success' }); emit({}, 'stop'); }
      res.end('data: [DONE]\n\n');
    } catch (error) { serverFailure ??= error; guard.markFailure(error); res.destroy(error); }
  });
  const originalBind = sdk.AgentSession.prototype.bindExtensions, originalDispose = sdk.AgentSession.prototype.dispose;
  sdk.AgentSession.prototype.bindExtensions = function (...args) {
    sessions.push(this); peakActive = Math.max(peakActive, ++active); assert(active <= 2, 'At most two active SDK sessions');
    return originalBind.apply(this, args);
  };
  sdk.AgentSession.prototype.dispose = function (...args) {
    disposals.set(this.sessionId, (disposals.get(this.sessionId) ?? 0) + 1); active--;
    return originalDispose.apply(this, args);
  };
  async function until(check, label) {
    const end = Date.now() + 20000;
    while (Date.now() < end) { guard.check(); if (serverFailure) throw serverFailure; if (await check()) return; await sleep(20); }
    throw Error('Timeout: ' + label);
  }
  const container = state.createZergStateContainer();
  async function execute(input) { const result = await owner.execute(input); assert(result.ok, JSON.stringify(result)); return result; }
  const show = async runId => (await execute({ action: 'runs.show', runId })).data.run;
  async function terminal(runId, status = 'done') {
    await until(async () => { const run = await show(runId); return run.status === status && (run.nativeSessions ?? []).every(ref => ref.attachment === 'disposed'); }, status + ' disposed');
    unchanged(); return show(runId);
  }
  async function define(id, tools = ['read'], prompt = 'READONLY: synthetic evidence inspection only. No writes, Git, installs, external network, or delegation.') {
    await execute({ action: 'agents.create', id, model: 'fixture/' + id, tools, prompt });
  }
  function key(ref) { return { parentRunId: ref.parentRunId, memberRunId: ref.memberRunId, piSessionId: ref.piSessionId }; }
  function protect(run) { for (const ref of run.nativeSessions) nativeHashes.set(ref.sessionFile, hash(ref.sessionFile)); }
  let deadline;
  const watchdog = new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('Journey 180s deadline')), 180000); });
  async function journey() {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const settings = { defaultProvider: 'fixture', defaultModel: 'investigator', packages: [],
      extensions: ['-builtin:mcp', '-builtin:llama.cpp', '-builtin:codemode', '-builtin:tool-search'],
      skills: [], prompts: [], themes: [], noExtensions: false, noSkills: false, noPromptTemplates: false,
      noThemes: true, defaultProjectTrust: 'never', enableInstallTelemetry: false, enableAnalytics: false,
      cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false } };
    writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(settings));
    writeFileSync(join(work, '.pi', 'settings.json'), JSON.stringify(settings)); writeFileSync(join(agentDir, 'auth.json'), '{}');
    writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'dummy-journey-only',
      models: ['investigator', 'designer', 'implementer', 'reviewer', 'verifier', 'summary', 'continuation',
        'cancel-stream', 'cancel-tool', 'cancel-startup', 'must-never-start', 'must-never-worker'].map(id => ({ id, reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 2048 })) } } }));
    owner = zerg.createZergControl(container, { persistence: { enabled: true, snapshotFile } });
    await define('investigator'); await define('designer');
    await define('implementer', ['read', 'edit'], 'IMPLEMENTER_AUTHORITY: leader is sole source writer AFTER receiving both exact worker reports. Only exact value || max to value ?? max edit in src/bounded-count.mjs; no test edits.');
    await execute({ action: 'team.create', id: 'implementation', leader: 'implementer', members: ['investigator', 'designer'] });
    const task = 'Investigate narrow zero-default defect, design regression, then implement exact nullish patch. Workers READONLY, leader sole source writer after receiving both exact worker reports. Immutable supervisor tests/sentinel. No Git/install/external services/delegation. Verifier later may execute ONLY ' + command;
    const launch = await execute({ action: 'run', agent: 'implementation', task, background: true, concurrency: 2 });
    reportRuns.set('implementer', launch.runId);
    await until(() => investigationGate && (state.getSubagentRunSnapshot(container.read(), launch.runId)?.nativeSessions ?? []).length >= 2, 'investigator live and exact worker identities');
    const live = (await show(launch.runId)).nativeSessions.find(ref => ref.agentDefinitionId === 'investigator');
    const sibling = (await show(launch.runId)).nativeSessions.find(ref => ref.agentDefinitionId === 'designer');
    const literal = '  /never-expand NEW_LITERAL_JOURNEY\n\tkeep spaces  \n';
    const sent = await execute({ action: 'session.message.send', ...key(live), messageId: 'journey-literal', mode: 'steer', body: literal });
    assert.equal(sent.data.receipt.status, 'queued');
    assert.equal((await owner.execute({ action: 'session.message.send', ...key(live), piSessionId: sibling.piSessionId, messageId: 'wrong-route', mode: 'steer', body: literal })).ok, false);
    const countBeforeInspection = requests.length, snapshotBeforeInspection = hash(snapshotFile);
    const queued = await execute({ action: 'timeline.list', ...key(live) });
    assert.equal(queued.data.entries.find(entry => entry.kind === 'operator-receipt').status, 'queued');
    assert(queued.data.entries.every(entry => entry.exactKey?.piSessionId === live.piSessionId));
    assert.equal(requests.length, countBeforeInspection); assert.equal(hash(snapshotFile), snapshotBeforeInspection);
    investigationGate();
    const implemented = await terminal(launch.runId);
    assert.equal(readFileSync(source, 'utf8'), fixed); protect(implemented);
    assert.equal(trace.filter(row => row.kind === 'result' && row.toolName === 'edit').length, 1);
    assert(trace.filter(row => row.kind === 'result').every(row => !row.isError));
    const receipts = await execute({ action: 'session.messages.list', ...key(live) }); assert.equal(receipts.data.receipts[0].status, 'delivered');
    const literalEntry = readFileSync(live.sessionFile, 'utf8').trim().split('\n').map(JSON.parse).find(row => row.type === 'custom_message' && row.details?.messageId === 'journey-literal');
    assert(literalEntry); assert.equal(literalEntry.content, literal);
    assert(!requests.filter(input => input.model === 'designer').some(input => JSON.stringify(input.messages).includes('NEW_LITERAL_JOURNEY')));
    await define('reviewer'); await define('verifier', ['read', 'bash']); await define('summary');
    receivedReports.clear();
    await execute({ action: 'team.create', id: 'review', leader: 'summary', members: ['reviewer', 'verifier'] });
    const reviewLaunch = await execute({ action: 'run', agent: 'review', task: 'Independent READONLY review; verifier may execute ONLY ' + command + '. No source/test edits, no Git/install/network/delegation.', background: true, concurrency: 2 });
    reportRuns.set('summary', reviewLaunch.runId);
    const reviewed = await terminal(reviewLaunch.runId); protect(reviewed);
    const summaryResult = await execute({ action: 'agents.result', id: 'summary', runId: reviewed.runId, memberRunId: reviewed.runId });
    assert.equal(summaryResult.data.status, 'found'); assert(summaryResult.data.result.final_message.includes('ACCEPTED:'));
    const verified = trace.find(row => row.kind === 'result' && row.role === 'verifier' && row.toolName === 'bash');
    assert(verified && !verified.isError); assert(JSON.stringify(verified.content).includes('# pass 4'));
    const final = supervisorTest(); assert.equal(final.status, 0); assert.match(final.stdout, /# pass 4/); assert.match(final.stdout, /# fail 0/);
    const selected = implemented.nativeSessions.find(ref => ref.agentDefinitionId === 'implementer'); assert(selected);
    await execute({ action: 'agents.update', id: 'implementer', model: 'fixture/continuation', tools: ['read'], prompt: 'CURRENT_REVIEW_ONLY: inspect immutable tests for this explicitly authorized extra review; NO implementation or test-command authority.' });
    const rows = readFileSync(selected.sessionFile, 'utf8').trim().split('\n').map(JSON.parse), entryId = rows.at(-1).id;
    const reviewBody = 'NEW_JOURNEY_REVIEW: read supervisor-tests.mjs and summarize zero regression only.';
    const prepare = async () => (await execute({ action: 'session.continuation.prepare', ...key(selected), entryId, body: reviewBody })).data.review;
    const boundary = { requests: requests.length, sessions: sessions.length, trace: trace.length, snapshot: hash(snapshotFile), revision: container.read().revision };
    assert.equal((await owner.execute({ action: 'session.continuation.prepare', ...key(selected), piSessionId: live.piSessionId, entryId, body: reviewBody })).ok, false);
    const discarded = await prepare();
    assert.deepEqual({ requests: requests.length, sessions: sessions.length, trace: trace.length, snapshot: hash(snapshotFile), revision: container.read().revision }, boundary);
    await execute({ action: 'session.continuation.discard', reviewId: discarded.reviewId });
    assert.equal((await owner.execute({ action: 'session.continuation.start', reviewId: discarded.reviewId, confirm: true })).ok, false);
    const consent = await prepare(); assert.deepEqual(consent.policy.definition.tools, ['read']);
    assert.equal(consent.body, reviewBody); unchanged();
    // Explicit fixture-only grant for exactly reviewBody, selected tuple and current policy.
    const before = sessions.length;
    const continued = await execute({ action: 'session.continuation.start', reviewId: consent.reviewId, confirm: true });
    const newRun = await terminal(continued.runId); protect(newRun);
    assert.equal(sessions.length, before + 1); assert.equal(newRun.nativeSessions.length, 1);
    assert.equal(newRun.nativeSessions[0].agentDefinitionId, 'implementer'); assert.notEqual(newRun.nativeSessions[0].piSessionId, selected.piSessionId);
    assert(newRun.finalSummary.includes('NEW_REVIEW_ONLY')); assert(!newRun.finalSummary.includes('IMPLEMENTED:'));
    assert.equal(newRun.metadata.nativeContinuation.entryId, entryId);
    const copiedRows = readFileSync(newRun.nativeSessions[0].sessionFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(copiedRows[0].parentSession, selected.sessionFile);
    const lineage = copiedRows.filter(row => row.type === 'custom' && row.customType === 'pi-zerg-swarm/native-continuation/v1');
    assert.equal(lineage.length, 1); assert.equal(lineage[0].data.entryId, entryId);
    assert.deepEqual(key(lineage[0].data.source), key(selected));
    assert.equal(lineage[0].data.sourceFingerprint, consent.sourceFingerprint);
    assert.equal(lineage[0].data.policyDigest, consent.policyDigest);
    assert.equal((await owner.execute({ action: 'session.continuation.start', reviewId: consent.reviewId, confirm: true })).ok, false);
    unchanged();
    for (const role of ['cancel-stream', 'cancel-tool', 'cancel-startup']) {
      await define(role);
      if (role === 'cancel-stream') { await define('must-never-start'); await define('must-never-worker'); }
      await execute({ action: 'team.create', id: 'team-' + role, leader: 'must-never-start', members: [role, 'must-never-worker'] });
      const count = requests.length;
      const cancelledLaunch = await execute({ action: 'run', agent: 'team-' + role, task: 'Cancellation fixture: readonly synthetic source. No other operations.', background: true, concurrency: 1 });
      await until(() => role === 'cancel-tool' ? toolGate : role === 'cancel-startup' ? startupGate : gates.size > 0, role + ' gate');
      const cancelling = await show(cancelledLaunch.runId);
      assert.deepEqual(cancelling.memberProgress.map(member => member.agentId), [role, 'must-never-worker']);
      assert.equal(cancelling.memberProgress[1].status, 'queued'); assert.equal(cancelling.memberProgress[1].startedAt, undefined);
      let cancelledKey;
      if (role === 'cancel-stream') {
        cancelledKey = key(cancelling.nativeSessions[0]);
        const pending = await execute({ action: 'session.message.send', ...cancelledKey, messageId: 'cancelled-literal', mode: 'followUp', body: 'CANCELLED_LITERAL_MUST_NOT_EXECUTE' });
        assert.equal(pending.data.receipt.status, 'queued');
      }
      await execute({ action: 'interrupt', runId: cancelledLaunch.runId }); releaseAll();
      const cancelled = await terminal(cancelledLaunch.runId, 'cancelled');
      assert.equal(requests.length, count + (role === 'cancel-startup' ? 0 : 1));
      assert(cancelled.memberProgress.every(member => member.status === 'cancelled'));
      assert.equal(cancelled.memberProgress[1].startedAt, undefined);
      assert(!trace.some(row => row.kind === 'read-executed' && row.role === 'cancel-tool'));
      assert.equal(container.read().tasks[cancelled.taskId].status, 'cancelled');
      if (cancelledKey) {
        const pending = await execute({ action: 'session.messages.list', ...cancelledKey });
        assert.equal(pending.data.receipts[0].status, 'needs-attention');
      }
      assert(!requests.some(input => JSON.stringify(input.messages).includes('CANCELLED_LITERAL_MUST_NOT_EXECUTE')));
    }
    assert(!requests.some(input => ['must-never-start', 'must-never-worker'].includes(input.model)));
    const completedTimeline = await execute({ action: 'timeline.list', teamId: 'implementation' });
    const outputs = completedTimeline.data.entries.filter(entry => entry.kind === 'native-output');
    assert.equal(outputs.length, 3); assert(outputs.every(entry => entry.exactKey && !('replyTo' in entry)));
    const restartReview = await prepare(), saved = owner.getState(); owner.dispose();
    // Test-owned recovery-boundary snapshot injection is NOT a live queued message.
    saved.extensions.zergSessionMessages.receipts[0].status = 'queued';
    persistence.createZergPersistenceManager({ enabled: true, snapshotFile }).save(saved);
    const recoveryInfo = join(work, 'recovery-info.json');
    writeFileSync(recoveryInfo, JSON.stringify({ snapshotFile, reviewId: restartReview.reviewId,
      key: key(live), hashes: [...immutable, ...nativeHashes, [source, hash(source)]] }));
    const loader = createRequire(import.meta.url).resolve('tsx');
    const requestCount = requests.length;
    const child = restartChild = spawn(process.execPath, ['--import', loader, fileURLToPath(import.meta.url), '--recover', recoveryInfo], {
      // Stay in the parent's supervised process group; recovery has no child launches.
      cwd: work, env: guard.childEnv(), stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = []; let outputBytes = 0;
    const capture = chunk => { outputBytes += chunk.length; if (outputBytes > 65536) { guard.markFailure(Error('Restart output cap')); child.kill('SIGKILL'); } else output.push(chunk); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    const timeout = setTimeout(() => { guard.markFailure(Error('Restart 40s deadline')); child.kill('SIGKILL'); }, 40000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => signal ? reject(Error('Restart signal ' + signal)) : resolve(code)); }).finally(() => clearTimeout(timeout));
    assert.equal(code, 0, Buffer.concat(output).toString()); assert.match(Buffer.concat(output).toString(), /zero execution/);
    assert.equal(requests.length, requestCount); unchanged();
    assert.equal(readFileSync(source, 'utf8'), fixed); assert.equal(active, 0); assert(peakActive <= 2);
    assert(sessions.every(session => disposals.get(session.sessionId) === 1));
    console.log('PASS objective coding journey: baseline FAIL -> genuine single SDK edit -> independent read review + actual Node tests PASS; literal exact receipts/timeline, current-policy one-selected continuation, gated stream/tool/startup cancel and fresh-process no replay; requests=' + requests.length + ', peakActive=' + peakActive);
  }
  try { await Promise.race([journey(), watchdog]); } catch (error) { failure = error; guard.markFailure(error); }
  finally {
    clearTimeout(deadline); try { owner?.dispose(); } catch (error) { failure ??= error; guard.markFailure(error); }
    releaseAll();
    if (restartChild && restartChild.exitCode === null && restartChild.signalCode === null) {
      guard.markFailure(Error('Restart still active during cleanup')); restartChild.kill('SIGKILL');
      await Promise.race([new Promise(resolve => restartChild.once('close', resolve)), sleep(2000)]);
    }
    const end = Date.now() + 15000;
    while (active !== 0 && Date.now() < end) await sleep(20);
    if (active !== 0) { guard.markFailure(Error('Unsettled SDK cleanup')); process.exit(86); }
    try { unchanged(); } catch (error) { failure ??= error; guard.markFailure(error); }
    server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve));
    // Retain dummy resources, instrumentation and transports until process exit.
    // Outer supervisor still owns hard process-group cleanup. No sandbox claim.
  }
  if (failure) throw failure;
}
