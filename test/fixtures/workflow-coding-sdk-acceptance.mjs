import { installFixtureSafety } from './fixture-safety.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const guard = installFixtureSafety({ name: 'workflow-coding-sdk', maxRequests: 80, maxRequestBytes: 1048576, maxOutputBytes: 8388608, timeoutMs: 220000 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = text => createHash('sha256').update(text).digest('hex');
const digest = file => sha(readFileSync(file, 'utf8'));
const ORIGINAL_BYTES = 'export const value = 1;\n';
const CANDIDATE2_BYTES = 'export const value = 2;\n';
const CANDIDATE3_BYTES = 'export const value = 3;\n';
const USER_NEWER_BYTES = 'USER_NEWER_BYTES\n';

if (process.argv[2] === '--recover') {
  const info = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const sdk = await import('@earendil-works/pi-coding-agent');
  const clankers = await import(new URL('../../index.ts', import.meta.url).href);
  let executions = 0;
  for (const method of ['bindExtensions','prompt']) sdk.AgentSession.prototype[method] = function () { executions++; throw Error('Recovered coding hydration must not start SDK work'); };
  const owner = clankers.createClankersControl(undefined, { persistence: { enabled: true, snapshotFile: info.snapshotFile } });
  try {
    const shown = await owner.execute({ action: 'workflows.show', workflowRunId: info.workflowRunId }); assert(shown.ok, JSON.stringify(shown)); assert.equal(shown.data.view.status, 'needs-attention'); assert.equal(shown.data.view.recovered, true);
    assert.equal((await owner.execute({ action: 'workflows.resume', workflowRunId: info.workflowRunId })).ok, false);
    assert.equal((await owner.execute({ action: 'workflows.retry', workflowRunId: info.workflowRunId })).ok, false);
    for (const [file, h] of info.hashes) assert.equal(digest(file), h);
    assert.equal(executions, 0);
    console.log('PASS workflow coding fresh-process recovery: zero SDK/provider/tool replay and no authority restoration');
  } finally { owner.dispose(); }
  process.exit(0);
}

const repo = fileURLToPath(new URL('../../', import.meta.url));
const workflowHash = value => createHash('sha256').update(JSON.stringify(value, Object.keys(value).sort())).digest('hex');
function canonical(value) { return JSON.stringify(value, (k, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a.localeCompare(b))) : v); }
function hash(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function obj(properties) { return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }; }
const str = (maxLength = 256) => ({ type: 'string', maxLength });
const arr = items => ({ type: 'array', maxItems: 8, items });
const bool = { type: 'boolean' };

const root = mkdtempSync(join(tmpdir(), 'clankers-coding-sdk-'));
const work = join(root, 'work'), agentDir = join(root, 'agent'), staging = join(root, 'stage');
for (const dir of [work, agentDir, staging, join(work, 'src')]) mkdirSync(dir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = '1'; process.env.PI_SKIP_VERSION_CHECK = '1'; process.env.PI_TELEMETRY = '0';
writeFileSync(join(work, 'src/bug.js'), ORIGINAL_BYTES);
writeFileSync(join(work, 'src/untouched.txt'), 'USER_UNRELATED_MODIFICATION\n');
writeFileSync(join(work, 'src/original.txt'), 'ORIGINAL_UNCHANGED\n');
const unrelatedHash = digest(join(work, 'src/untouched.txt'));
const originalHash = digest(join(work, 'src/original.txt'));
const settings = { packages: [], extensions: ['-builtin:mcp','-builtin:llama.cpp','-builtin:codemode','-builtin:tool-search'], skills: [], prompts: [], themes: [], noExtensions: false, noSkills: false, noPromptTemplates: false, noThemes: true, defaultProjectTrust: 'never', enableInstallTelemetry: false, enableAnalytics: false, cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false } };
writeFileSync(join(agentDir, 'settings.json'), JSON.stringify(settings)); writeFileSync(join(agentDir, 'auth.json'), '{}');

const sdk = await import('@earendil-works/pi-coding-agent'); guard.watchSDK(sdk);
const clankers = await import(new URL('../../index.ts', import.meta.url).href);
const model = await import(new URL('../../workflow-model.ts', import.meta.url).href);
const persistence = await import(new URL('../../persistence.ts', import.meta.url).href);

let recoveryChild; const requests = []; const held = new Map(); let serverFailure;
function rowText(row) { return typeof row.content === 'string' ? row.content : (row.content ?? []).map(b => b.text ?? '').join(''); }
function toolRows(input) { return input.messages.filter(r => r.role === 'tool'); }
function assistantCalls(input) { return new Map(input.messages.filter(r => r.role === 'assistant').flatMap(r => r.tool_calls ?? []).map(c => [c.id, c])); }
function readPrompt(input) { return input.messages.filter(r => r.role === 'user').map(rowText).join('\n'); }
const server = createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, 'Bearer dummy-coding-sdk-only');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks)); requests.push(input); assert(requests.length <= 80);
    const tools = (input.tools ?? []).map(t => t.function.name).sort();
    if (input.model === 'writer') assert.deepEqual(tools, ['workflow_stage_inspect','workflow_stage_read','workflow_stage_write'].sort(), 'writer sees only sealed stage tools');
    else if (input.model === 'reviewer') assert.deepEqual(tools, ['workflow_stage_inspect','workflow_stage_read'].sort(), 'reviewer read-only stage tools');
    else throw Error('unexpected model ' + input.model);
    const calls = assistantCalls(input), results = toolRows(input);
    for (const result of results) assert(calls.has(result.tool_call_id), 'tool result matches actual assistant call');
    const prompt = readPrompt(input); const hold = prompt.includes('HOLD_FOR_CANCEL');
    let tool, answer;
    if (input.model === 'writer') {
      if (hold && results.length === 0) { tool = ['workflow_stage_read', { path: 'src/bug.js' }]; }
      else if (hold && results.length === 1) { tool = ['workflow_stage_write', { path: 'src/bug.js', text: CANDIDATE2_BYTES }]; }
      else if (hold && results.length === 2) { await new Promise(resolve => held.set('cancel-writer', resolve)); answer = JSON.stringify({ status: 'cancelled-late' }); }
      else if (results.length === 0) tool = ['workflow_stage_read', { path: 'src/bug.js' }];
      else if (results.length === 1) { const readBytes = rowText(results[0]); if (readBytes.includes(ORIGINAL_BYTES)) tool = ['workflow_stage_write', { path: 'src/bug.js', text: CANDIDATE2_BYTES }]; else if (readBytes.includes(CANDIDATE2_BYTES)) tool = ['workflow_stage_write', { path: 'src/bug.js', text: CANDIDATE3_BYTES }]; else assert.fail('writer read unexpected staged bytes: ' + readBytes); }
      else if (results.length === 2) { assert(rowText(results[1]).includes('staged write accepted')); tool = ['workflow_stage_inspect', {}]; }
      else { assert(rowText(results[2]).includes('candidateHash')); answer = JSON.stringify({ status: 'writer-complete' }); }
    } else {
      if (!/Review exact staged candidate/i.test(prompt) && /investigate|original readonly/i.test(prompt)) {
        if (results.length === 0) tool = ['workflow_stage_read', { path: 'src/original.txt' }];
        else { assert(rowText(results[0]).includes('ORIGINAL_UNCHANGED')); answer = JSON.stringify({ summary: 'readonly investigation completed before implementation approval', readonlyPaths: ['src/original.txt'] }); }
      } else if (results.length === 0) tool = ['workflow_stage_read', { path: 'src/bug.js' }];
      else if (results.length === 1) {
        const reviewedBytes = rowText(results[0]);
        if (reviewedBytes.includes(CANDIDATE2_BYTES)) answer = JSON.stringify({ verdict: 'fail', findings: [{ id: 'r1', severity: 'high', path: 'src/bug.js', message: 'candidate still needs value 3' }] });
        else if (reviewedBytes.includes(CANDIDATE3_BYTES)) answer = JSON.stringify({ verdict: 'pass', findings: [] });
        else assert.fail('reviewer read unexpected staged bytes: ' + reviewedBytes);
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'coding-' + requests.length, object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    emit({ role: 'assistant' });
    if (tool) { emit({ tool_calls: [{ index: 0, id: 'coding-call-' + requests.length, type: 'function', function: { name: tool[0], arguments: JSON.stringify(tool[1]) } }] }); emit({}, 'tool_calls'); }
    else { emit({ content: answer }); emit({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  } catch (error) { serverFailure ??= error; guard.markFailure(error); res.destroy(error); }
});

function checkProfile() { const base = { id: 'node', executable: process.execPath, argv: ['-e', "const fs=require('fs'); const v=fs.readFileSync('bug.js','utf8'); if(v!=='export const value = 2;\\n'&&v!=='export const value = 3;\\n') process.exit(2)"], cwd: 'src', env: {}, timeoutMs: 10000, allowGeneratedOutputs: false }; return { ...base, profileHash: model.workflowHash(base) }; }
function policy(task) { const text = ORIGINAL_BYTES; const profile = checkProfile(); return { version: 3, capabilities: ['investigate','stage-write','check','review','apply'], identity: { parentRunId: 'parent', taskId: task, attemptNo: 1, rootAgentId: 'reviewer', workerAgentId: 'writer', model: 'fixture/writer' }, scope: { task: task === 'cancel' ? 'HOLD_FOR_CANCEL controlled staged change' : 'Fix src/bug.js only after readonly investigation of original; preserve unrelated files.', writablePaths: ['src/bug.js'], readonlyPaths: ['src/original.txt','src/untouched.txt'], baseline: { projectRootId: work, stateHash: sha(text) }, manifest: [{ path: 'src/bug.js', text, bytes: Buffer.byteLength(text), sha256: sha(text) }] }, checkProfiles: [profile], reviewRequired: true }; }
function definition(id, task, repeat = true, includeInvestigation = true) { const p = policy(task); const investigationOut = obj({ summary: str(512), readonlyPaths: arr(str(128)) }); const stageOut = obj({ candidateHash: str(80), changedPaths: arr(str(128)) }); const passOut = obj({ passed: bool, profileId: str(80), candidateHash: str(80) }); const reviewOut = obj({ passed: bool, candidateHash: str(80), reviewer: str(160), findings: arr(obj({ id: str(20), severity: str(10), path: str(128), message: str(256) })) }); const applyOut = obj({ status: str(16), candidateHash: str(80), appliedPaths: arr(str(128)), rejectedPaths: arr(str(128)), diagnostics: arr(str(256)), outcomeHash: str(80) }); const body = [ { id: 'stage', kind: 'coding', dependsOn: [], inputs: {}, outputSchema: stageOut, coding: { operation: 'stage-write', policy: p } }, { id: 'check', kind: 'coding', dependsOn: ['stage'], inputs: {}, outputSchema: passOut, coding: { operation: 'check', policy: p, checkProfileId: 'node' } }, { id: 'review', kind: 'coding', dependsOn: ['check'], inputs: {}, outputSchema: reviewOut, coding: { operation: 'review', policy: p } } ]; return { id, version: 3, label: id, inputSchema: obj({}), steps: [ ...(includeInvestigation ? [{ id: 'investigate', kind: 'coding', dependsOn: [], inputs: {}, outputSchema: investigationOut, coding: { operation: 'investigate', policy: p } }] : []), ...(repeat ? [ { id: 'loop', kind: 'repeat', dependsOn: includeInvestigation ? ['investigate'] : [], initial: { value: { passed: false, candidateHash: '', reviewer: '', findings: [] } }, stateSchema: reviewOut, maxIterations: 2, body, feedback: { ref: { source: 'step', stepId: 'review', path: [] } }, until: { op: 'boolean', value: { ref: { source: 'iteration', path: ['passed'] } } }, output: { ref: { source: 'iteration', path: [] } }, outputSchema: reviewOut }, { id: 'apply', kind: 'coding', dependsOn: ['loop'], inputs: {}, outputSchema: applyOut, coding: { operation: 'apply', policy: p } } ] : [...body.map(s => ({ ...s, dependsOn: s.id === 'stage' && includeInvestigation ? ['investigate'] : s.dependsOn })), { id: 'apply', kind: 'coding', dependsOn: ['review'], inputs: {}, outputSchema: applyOut, coding: { operation: 'apply', policy: p } }]) ] }; }
async function until(check, label, ms = 45000) { const end = Date.now() + ms; while (Date.now() < end) { guard.check(); if (serverFailure) throw serverFailure; if (await check()) return; await sleep(25); } throw Error('timeout: ' + label); }
async function exec(control, action) { const r = await control.execute(action); assert(r.ok, JSON.stringify(r)); return r; }
function terminal(run) { return run.cleanupSettled && ['completed','failed','cancelled','needs-attention'].includes(run.status); }
function units(run) { return model.workflowStepEntries(run).flatMap(e => e.step.units); }
async function createControl(snapshotFile) { return clankers.createClankersControl(undefined, { persistence: { enabled: true, snapshotFile }, coding: { enabled: true, projectRoot: work, stagingParent: staging, checkProfiles: { node: { id: 'node', executable: process.execPath, argv: checkProfile().argv, cwd: 'src', env: {}, timeoutMs: 10000, outputBytes: 4096 } } } }); }

try {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', apiKey: 'dummy-coding-sdk-only', models: ['writer','reviewer'].map(id => ({ id, reasoning: false, input: ['text'], contextWindow: 65536, maxTokens: 2048 })) } } }));
  const snapshotFile = join(root, 'snapshot.json'); var control = await createControl(snapshotFile);
  for (const [id, modelId, prompt] of [['writer','fixture/writer','Writer MUST use workflow_stage_read before workflow_stage_write; no other tools.'], ['reviewer','fixture/reviewer','Readonly reviewer; use workflow_stage_read and return JSON verdict.']]) await exec(control, { action: 'agents.create', id, model: modelId, tools: ['read','bash','edit','write','clankers_control','codemode'], prompt });

  await exec(control, { action: 'workflows.define', definition: definition('deny', 'deny', false, false) });
  const deny = (await exec(control, { action: 'workflows.start', definitionId: 'deny', inputs: {}, concurrency: 1 })).data.view.workflowRunId;
  await until(() => control.workflowApprovals.inspect().some(r => r.kind === 'implementation' && r.status === 'pending'), 'deny impl approval');
  const denyReq = control.workflowApprovals.inspect().find(r => r.kind === 'implementation' && r.status === 'pending');
  control.workflowApprovals.reject(denyReq.id, denyReq.request, 'operator denied'); await control.drain().catch(() => {});
  await until(() => terminal(control.getState().extensions.workflows.runs.find(r => r.workflowRunId === deny)), 'deny terminal');
  assert.equal(requests.length, 0, 'Denied implementation made zero provider/tool calls');

  await exec(control, { action: 'workflows.define', definition: definition('main', 'main', true) });
  const main = (await exec(control, { action: 'workflows.start', definitionId: 'main', inputs: {}, concurrency: 1 })).data.view.workflowRunId;
  await until(() => control.workflowApprovals.inspect().some(r => r.kind === 'implementation' && r.status === 'pending'), 'main impl approval');
  let impl = control.workflowApprovals.inspect().find(r => r.kind === 'implementation' && r.status === 'pending'); control.workflowApprovals.grantFingerprint(impl.id, impl.requestHash);
  await until(() => control.workflowApprovals.inspect().some(r => r.kind === 'application' && r.status === 'pending'), 'application after review correction');
  const reviewerRequests = requests.filter(r => r.model === 'reviewer' && toolRows(r).length === 1 && !/investigate|original readonly/i.test(readPrompt(r))).length; assert.equal(reviewerRequests, 2, 'First review fails, Stage8A repeat correction then independent pass');
  const app = control.workflowApprovals.inspect().find(r => r.kind === 'application' && r.status === 'pending');
  assert.throws(() => control.workflowApprovals.grantFingerprint(app.id, '0'.repeat(64)), /Approval|hash|request/i, 'wrong application fingerprint refused');
  writeFileSync(join(work, 'src/bug.js'), USER_NEWER_BYTES);
  control.workflowApprovals.grantFingerprint(app.id, app.requestHash); await control.drain().catch(() => {});
  await until(() => terminal(control.getState().extensions.workflows.runs.find(r => r.workflowRunId === main)), 'target-changed main terminal');
  const staleRun = control.getState().extensions.workflows.runs.find(r => r.workflowRunId === main);
  assert.equal(staleRun.status, 'failed', 'target change after exact application request invalidates old application');
  const staleApply = units(staleRun).find(u => u.stepId === 'apply');
  assert.deepEqual(staleApply?.result?.appliedPaths ?? [], [], 'invalidated old application applied no paths');
  assert.equal(readFileSync(join(work, 'src/bug.js'), 'utf8'), USER_NEWER_BYTES, 'newer user target bytes preserved');
  assert.throws(() => control.workflowApprovals.grantFingerprint(app.id, app.requestHash), /Approval|hash|request|pending|consumed|live/i, 'old grant replay rejected');
  writeFileSync(join(work, 'src/bug.js'), ORIGINAL_BYTES);

  await exec(control, { action: 'workflows.define', definition: definition('main-restart', 'main-restart', true) });
  const restarted = (await exec(control, { action: 'workflows.start', definitionId: 'main-restart', inputs: {}, concurrency: 1 })).data.view.workflowRunId;
  await until(() => control.workflowApprovals.inspect().some(r => r.kind === 'implementation' && r.status === 'pending'), 'restart impl approval');
  impl = control.workflowApprovals.inspect().find(r => r.kind === 'implementation' && r.status === 'pending'); control.workflowApprovals.grantFingerprint(impl.id, impl.requestHash);
  await until(() => control.workflowApprovals.inspect().some(r => r.kind === 'application' && r.status === 'pending'), 'restart application after review correction');
  const app2 = control.workflowApprovals.inspect().find(r => r.kind === 'application' && r.status === 'pending'); control.workflowApprovals.grantFingerprint(app2.id, app2.requestHash); await control.drain();
  const mainRun = control.getState().extensions.workflows.runs.find(r => r.workflowRunId === restarted); assert.equal(mainRun.status, 'completed', JSON.stringify(mainRun));
  assert.equal(readFileSync(join(work, 'src/bug.js'), 'utf8'), CANDIDATE3_BYTES, 'corrected apply bytes reached project');
  assert.equal(digest(join(work, 'src/untouched.txt')), unrelatedHash, 'unrelated user modification preserved');
  assert.equal(digest(join(work, 'src/original.txt')), originalHash, 'readonly original unchanged');
  const writerToolNames = requests.filter(r => r.model === 'writer').flatMap(r => [...assistantCalls(r).values()].map(c => c.function.name)); assert(writerToolNames.includes('workflow_stage_write'), 'Native SDK writer actually called controlled stagewrite tool');
  const writerReadRows = requests.filter(r => r.model === 'writer' && toolRows(r).length === 1).map(r => rowText(toolRows(r)[0]));
  assert(writerReadRows.some(t => t.includes(CANDIDATE2_BYTES)), 'second writer iteration read prior candidate2 bytes from actual tool response');
  const writePayloads = requests.filter(r => r.model === 'writer').flatMap(r => [...assistantCalls(r).values()].filter(c => c.function.name === 'workflow_stage_write').map(c => JSON.parse(c.function.arguments).text));
  assert(writePayloads.includes(CANDIDATE2_BYTES) && writePayloads.includes(CANDIDATE3_BYTES), 'writer actually issued distinct stage write tool calls for candidate2 and candidate3');
  const stageHashes = units(mainRun).filter(u => u.stepId.includes('stage') && u.result?.candidateHash).map(u => u.result.candidateHash);
  assert(stageHashes.length >= 2 && new Set(stageHashes).size >= 2, 'correction produced distinct candidate hashes from real stage results');
  const nativeIds = units(mainRun).filter(u => u.native).map(u => u.native.runId); assert(new Set(nativeIds).size === nativeIds.length, 'distinct native sessions including reviewer');

  writeFileSync(join(work, 'src/bug.js'), ORIGINAL_BYTES);
  await exec(control, { action: 'workflows.define', definition: definition('cancel', 'cancel', false) });
  const cancel = (await exec(control, { action: 'workflows.start', definitionId: 'cancel', inputs: {}, concurrency: 1 })).data.view.workflowRunId;
  await until(() => control.workflowApprovals.inspect().some(r => r.kind === 'implementation' && r.status === 'pending'), 'cancel impl');
  impl = control.workflowApprovals.inspect().find(r => r.kind === 'implementation' && r.status === 'pending'); control.workflowApprovals.grantFingerprint(impl.id, impl.requestHash);
  await until(() => held.has('cancel-writer'), 'cancel writer held'); await exec(control, { action: 'workflows.cancel', workflowRunId: cancel }); held.get('cancel-writer')();
  await until(() => terminal(control.getState().extensions.workflows.runs.find(r => r.workflowRunId === cancel)), 'cancel terminal');
  assert.equal(control.getState().extensions.workflows.runs.find(r => r.workflowRunId === cancel).status, 'cancelled');
  assert.equal(readFileSync(join(work, 'src/bug.js'), 'utf8'), ORIGINAL_BYTES, 'cancel never applies staged bytes');
  held.delete('cancel-writer');

  await exec(control, { action: 'workflows.define', definition: definition('recover', 'cancel', false) });
  const rec = (await exec(control, { action: 'workflows.start', definitionId: 'recover', inputs: {}, concurrency: 1 })).data.view.workflowRunId;
  await until(() => control.workflowApprovals.inspect().some(r => r.kind === 'implementation' && r.status === 'pending'), 'recover impl');
  impl = control.workflowApprovals.inspect().find(r => r.kind === 'implementation' && r.status === 'pending'); control.workflowApprovals.grantFingerprint(impl.id, impl.requestHash);
  await until(() => held.has('cancel-writer') && control.getState().extensions.workflows.runs.find(r => r.workflowRunId === rec).steps.some(s => s.units.some(u => u.native)), 'recover in-flight native');
  const savedRequests = requests.length; const savedHashes = [join(work, 'src/bug.js'), join(work, 'src/untouched.txt'), join(work, 'src/original.txt')].map(f => [f, digest(f)]);
  const recoverySnapshot = join(root, 'recovery-state.json');
  persistence.createClankersPersistenceManager({ enabled: true, snapshotFile: recoverySnapshot }).save(control.getState());
  control.dispose(); held.get('cancel-writer')?.();
  const loader = createRequire(import.meta.url).resolve('tsx'), info = join(root, 'recover-info.json'); writeFileSync(info, JSON.stringify({ snapshotFile: recoverySnapshot, workflowRunId: rec, hashes: savedHashes }));
  recoveryChild = spawn(process.execPath, ['--import', loader, fileURLToPath(import.meta.url), '--recover', info], { cwd: work, env: guard.childEnv(), stdio: ['ignore','pipe','pipe'] });
  let out = Buffer.alloc(0); for (const s of [recoveryChild.stdout, recoveryChild.stderr]) s.on('data', c => { out = Buffer.concat([out,c]).subarray(-65536); });
  const code = await new Promise((resolve, reject) => { recoveryChild.once('error', reject); recoveryChild.once('close', (code, signal) => signal ? reject(Error('signal '+signal)) : resolve(code)); });
  assert.equal(code, 0, out.toString()); assert.match(out.toString(), /PASS workflow coding fresh-process recovery/); assert.equal(requests.length, savedRequests, 'fresh process caused zero provider replay in parent server');
  assert(!existsSync(join(root, 'network-refused.txt')));
  console.log('PASS workflow coding SDK acceptance: real SDK sealed stagewrite/review/check/apply, deny/stale/cancel/recovery zero replay; requests=' + requests.length);
} catch (error) { guard.markFailure(error); console.error('FAIL workflow coding SDK acceptance: ' + String(error.stack ?? error).slice(-16000)); throw error; }
finally { for (const release of held.values()) { try { release(); } catch {} } try { recoveryChild?.kill?.('SIGKILL'); } catch {} try { control?.dispose?.(); } catch {} server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
