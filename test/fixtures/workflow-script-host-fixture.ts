// Test-only actual host extension + SDK journey. No injected native port,
// approval grants, shell/project code, fake session transport or source eval.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.WORKFLOW_SCRIPT_ROOT!;
const config = JSON.parse(readFileSync(join(root, 'evidence/config.json'), 'utf8'));
const require = createRequire(join(config.piPackage, 'package.json'));
const { createJiti } = await import(pathToFileURL(require.resolve('jiti')).href);
// Public Jiti aliases pin both the library's imports and our SDK observer to
// the explicit physical installed/copied host closure; no resolver fallback.
const jiti = createJiti(import.meta.url, { moduleCache: true, fsCache: false, alias: config.hostModuleAliases });
const clankers = await jiti.import(join(config.moduleRoot, 'index.ts'));
const model = await jiti.import(join(config.moduleRoot, 'workflow-model.ts'));
const runtime = await jiti.import(join(config.moduleRoot, 'workflow-runtime.ts'));
const persistence = await jiti.import(join(config.moduleRoot, 'persistence.ts'));
const compiler = await jiti.import(join(config.moduleRoot, 'workflow-script.ts'));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const put = (name: string, value: unknown) => writeFileSync(join(root, 'evidence', name), JSON.stringify(value, null, 2));
const read = (name: string) => JSON.parse(readFileSync(join(root, 'evidence', name), 'utf8'));
const clone = (v: any) => JSON.parse(JSON.stringify(v));
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const snapshot = join(root, 'snapshot.json');
const recoverySnapshot = join(root, 'snapshot-recovery.json');
const options = (snapshotFile = snapshot) => ({ persistence: { enabled: true, snapshotFile }, recovery: { enabled: true } });
const units = (run: any) => model.workflowStepEntries(run).flatMap((entry: any) => entry.step.units);
const runOf = (control: any, id: string) => control.getState().extensions.workflows.runs.find((r: any) => r.workflowRunId === id);
const scalar = { type: 'string', maxLength: 32 };
const empty = { type: 'object', properties: {}, required: [], additionalProperties: false };
const ref = (stepId: string) => ({ ref: { source: 'step', stepId, path: [] } });
const parallelSource = `workflow({id:"script-parallel",label:"Script parallel review",inputSchema:{type:"object",properties:{},required:[],additionalProperties:false}},()=>{
 const schema={type:"string",maxLength:32};
 const alpha=native("alpha",{dependsOn:[],agentId:"reviewer",prompt:"SCRIPT_ALPHA Return JSON string alpha. Readonly. No tools needed.",inputs:{},outputSchema:schema});
 const beta=native("beta",{dependsOn:[],agentId:"reviewer",prompt:"SCRIPT_BETA Return JSON string beta. Readonly. No tools needed.",inputs:{},outputSchema:schema});
 phase("reviews",[alpha,beta]);
 const report=aggregate("report",{dependsOn:[alpha,beta],operation:"collect",inputs:{alpha:ref(alpha,[]),beta:ref(beta,[])}});
});`;
const parallelDefinition = { id: 'script-parallel', version: 2, label: 'Script parallel review', inputSchema: empty, steps: [
  ...['alpha', 'beta'].map(id => ({ id, kind: 'native', dependsOn: [], agentId: 'reviewer', prompt: `SCRIPT_${id.toUpperCase()} Return JSON string ${id}. Readonly. No tools needed.`, inputs: {}, outputSchema: scalar })),
  { id: 'report', kind: 'aggregate', dependsOn: ['alpha', 'beta'], operation: 'collect', inputs: { alpha: ref('alpha'), beta: ref('beta') } },
] };
const repeatSource = `workflow({id:"script-repeat",label:"Script conditional refinement",inputSchema:{type:"object",properties:{},required:[],additionalProperties:false}},()=>{
 const block=repeat("refinement",{dependsOn:[],initial:value(0),stateSchema:{type:"integer"},outputSchema:{type:"integer"},maxIterations:2},()=>{
  const refine=native("refine",{dependsOn:[],agentId:"refine",prompt:"SCRIPT_REFINE Return next scripted integer as JSON. Readonly.",inputs:{state:ref("iteration",[])},outputSchema:{type:"integer"}});
  const assess=native("assess",{dependsOn:[refine],agentId:"assess",prompt:"SCRIPT_ASSESS Return scripted integer as JSON. Readonly.",inputs:{state:ref(refine,[])},outputSchema:{type:"integer"}});
  phase("iteration-review",[refine,assess]);
  return {feedback:ref(assess,[]),until:{op:"gte",left:ref("iteration",[]),right:value(2)},output:ref(assess,[])};
 });
});`;

async function until(check: () => any, label: string) {
  const end = Date.now() + 35_000;
  while (Date.now() < end) { if (existsSync(join(root, 'evidence/server-failure.json'))) throw Error(JSON.stringify(read('server-failure.json'))); if (await check()) return; await sleep(20); }
  throw Error('Fixture deadline: ' + label);
}
async function exec(control: any, action: any) { const reply = await control.execute(action); assert(reply.ok, JSON.stringify(reply)); return reply.data; }
function effects() {
  const files: Record<string, string> = {};
  function walk(path: string) { for (const entry of readdirSync(path, { withFileTypes: true })) { const p = join(path, entry.name); if (entry.isDirectory()) walk(p); else files[p] = sha(readFileSync(p)); } }
  walk(join(root, 'work'));
  for (const path of [snapshot, recoverySnapshot]) if (existsSync(path)) files[path] = sha(readFileSync(path));
  return files;
}
function httpCount() { return existsSync(join(root, 'evidence/http-count.json')) ? read('http-count.json').requests : 0; }
let nativeStarts = 0, nativeDisposals = 0;
const nativeRecords: Array<{ classNo: number; sessionId: string; sessionFile: string; disposed: boolean }> = [];
let watchedClasses = 0;
function sdkEvidence() { put('sdk-instrumentation.json', { watchedClasses, nativeStarts, nativeDisposals, sessions: nativeRecords }); }
async function watchSDK() {
  const watched = new Set<object>();
  // Observe both actual loader instances (native ESM and fixture/library Jiti),
  // deduplicating only identical prototypes; never substitute the SDK factory.
  for (const sdk of [await import(config.sdk), await jiti.import('@earendil-works/pi-coding-agent')]) {
    const proto = sdk.AgentSession.prototype;
    if (watched.has(proto)) continue; watched.add(proto);
    const classNo = ++watchedClasses;
    const bind = proto.bindExtensions, dispose = proto.dispose;
    const records = new WeakMap<object, typeof nativeRecords[number]>();
    proto.bindExtensions = function (...args: any[]) {
      if (!records.has(this)) {
        const record = { classNo, sessionId: this.sessionId, sessionFile: this.sessionFile, disposed: false };
        records.set(this, record); nativeRecords.push(record); nativeStarts++; sdkEvidence();
      }
      return bind.apply(this, args);
    };
    proto.dispose = function (...args: any[]) {
      try { return dispose.apply(this, args); }
      finally {
        const record = records.get(this);
        if (record) { assert(!record.disposed, 'SDK disposed twice'); record.disposed = true; nativeDisposals++; sdkEvidence(); }
      }
    };
  }
  sdkEvidence();
}
async function settled(control: any, id: string) {
  await until(() => { const run = runOf(control, id); return run.cleanupSettled && ['completed', 'failed', 'cancelled'].includes(run.status); }, 'ordinary scheduler terminal + cleanup');
  const run = runOf(control, id); assert.equal(run.status, 'completed', JSON.stringify(run).slice(-8000)); return run;
}
async function identities(control: any, run: any) {
  for (const entry of model.workflowStepEntries(run)) for (const unit of entry.step.units.filter((u: any) => u.native)) {
    const n = (await exec(control, { action: 'runs.show', runId: unit.native.runId })).run;
    assert.equal(n.taskId, unit.native.taskId);
    assert.equal(n.metadata.workflow.workflowRunId, run.workflowRunId);
    assert.equal(n.metadata.workflow.familyId, run.familyId);
    assert.equal(n.metadata.workflow.attemptNo, run.attemptNo);
    assert.equal(n.metadata.workflow.stepId, unit.stepId);
    assert.equal(n.metadata.workflow.unitId, unit.id);
    if (entry.blockId) { assert.equal(n.metadata.workflow.iterationId, entry.iterationId); assert.equal(n.metadata.workflow.iterationNo, entry.iterationNo); }
    assert.equal(n.nativeSessions.length, 1); const session = n.nativeSessions[0];
    assert.equal(session.attachment, 'disposed'); assert(session.piSessionId && session.sessionFile);
    assert(readFileSync(session.sessionFile, 'utf8').includes('pi-clankers/native-session/v1'));
  }
}

async function journey(control: any, monitor?: (id: string) => Promise<void>, slash?: (action: any) => Promise<any>) {
  const author = slash ?? ((action: any) => exec(control, action));
  const before = { effects: effects(), ledger: clone(control.getState().extensions), starts: nativeStarts, requests: httpCount() };
  assert.equal(before.requests, 0);
  const validated = await author({ action: 'workflows.scripts.validate', source: parallelSource, sourceName: 'parallel.workflow.js' });
  assert(!Object.hasOwn(validated, 'definition'), 'validate only returns summary');
  const compiled = await author({ action: 'workflows.scripts.compile', source: parallelSource, sourceName: 'parallel.workflow.js' });
  const repeated = await compiler.compileWorkflowScript(parallelSource, { sourceName: 'parallel.workflow.js' });
  assert(repeated.ok); assert.deepEqual(repeated.definition, compiled.definition, 'deterministic source + mapping');
  const graph = clone(compiled.definition); delete graph.authoring;
  assert.deepEqual(graph, model.validateWorkflowDefinition(parallelDefinition), 'same declarative lowering, not second scheduler');
  assert.equal(compiled.definition.authoring.sourceHash, sha(parallelSource));
  assert.equal(compiled.definition.authoring.graphHash, model.workflowHash(graph));
  assert.equal(compiled.inspection.counts.native, 2); assert.equal(compiled.inspection.codingCapabilities.length, 0);
  const invalidSource = 'process.env.OPENAI_API_KEY; workflow({},()=>{});';
  const invalidValidation = await control.execute({ action: 'workflows.scripts.validate', source: invalidSource }); assert.equal(invalidValidation.ok, false);
  const forbidden = await control.execute({ action: 'workflows.scripts.compile', source: invalidSource }); assert.equal(forbidden.ok, false);
  const extra = await control.execute({ action: 'workflows.scripts.save', source: parallelSource, approved: true, start: true }); assert.equal(extra.ok, false);
  assert.deepEqual({ effects: effects(), ledger: clone(control.getState().extensions), starts: nativeStarts, requests: httpCount() }, before, 'compile/validate/rejection zero native/provider/approval/work/snapshot effects');
  assert.equal(control.workflowApprovals.inspect().length, 0);
  await author({ action: 'workflows.scripts.save', source: parallelSource, sourceName: 'parallel.workflow.js' });
  const inspection = await author({ action: 'workflows.scripts.inspect', definitionId: 'script-parallel' });
  assert.deepEqual(inspection.definition, compiled.definition);
  assert.equal(httpCount(), 0); assert.equal(nativeStarts, 0); assert.equal(control.workflowApprovals.inspect().length, 0);
  assert.equal(control.getState().extensions.workflows.runs.length, 0, 'save is not start');
  put('compiled.json', { ok: true, inspection: compiled.inspection, sourceHash: compiled.definition.authoring.sourceHash, graphHash: compiled.definition.authoring.graphHash });
  for (const id of ['reviewer', 'refine', 'assess']) await exec(control, { action: 'agents.create', id, model: 'fixture/' + id, tools: ['read'], prompt: 'Fixture: read-only scripted JSON response. No external providers, write, shell, MCP, delegation or extra authority.' });
  const start = await author({ action: 'workflows.start', definitionId: 'script-parallel', inputs: {}, concurrency: 2 });
  const id = start.view.workflowRunId;
  await until(() => httpCount() === 2 && units(runOf(control, id)).filter((u: any) => u.native && u.status === 'running').length === 2, 'two real owned SDK streams');
  const checkpoint = clone(control.getState());
  const frozen = clone(runOf(control, id).definition.authoring);
  const view = (await exec(control, { action: 'workflows.show', workflowRunId: id })).view;
  assert.equal(view.workflowRunId, id); assert(view.correlations.some((r: any) => r.source?.sourceName === 'parallel.workflow.js' && r.authoredPath?.[0] === 'alpha' && r.phaseId === 'reviews' && r.source.span.line >= 1));
  put('live.json', { workflowRunId: id, units: units(runOf(control, id)).filter((u: any) => u.native).map((u: any) => ({ id: u.id, native: u.native })), sourceHash: frozen.sourceHash });
  if (monitor) await monitor(id); // PTY owns fresh real input and releases held transport.
  else put('release.json', { explicitStart: true });
  const authored = await settled(control, id); await identities(control, authored);
  assert.deepEqual(authored.definition.authoring, frozen);
  if (monitor) put('finished.json', { status: authored.status });
  await exec(control, { action: 'workflows.define', definition: { ...parallelDefinition, id: 'declarative-parallel' } });
  const same = await exec(control, { action: 'workflows.start', definitionId: 'declarative-parallel', inputs: {}, concurrency: 2 });
  const declarative = await settled(control, same.view.workflowRunId); await identities(control, declarative);
  assert.deepEqual(authored.steps.map((s: any) => ({ id: s.id, status: s.status, output: s.output })), declarative.steps.map((s: any) => ({ id: s.id, status: s.status, output: s.output })), 'actual native ordering/result parity');
  await author({ action: 'workflows.scripts.save', source: repeatSource, sourceName: 'refine.workflow.js' });
  const loop = await author({ action: 'workflows.start', definitionId: 'script-repeat', inputs: {}, concurrency: 2 });
  const done = await settled(control, loop.view.workflowRunId); await identities(control, done);
  assert.equal(done.steps[0].termination, 'converged'); assert.equal(done.steps[0].iterations.length, 2); assert.equal(done.steps[0].output, 2);
  assert.deepEqual(done.steps[0].iterations.map((i: any) => i.steps.map((s: any) => s.status)), [['completed', 'completed'], ['completed', 'completed']]);
  const edit = await compiler.compileWorkflowScript('// authored comment edit\n' + parallelSource, { sourceName: 'parallel.workflow.js' }); assert(edit.ok);
  assert.equal(edit.definition.authoring.graphHash, frozen.graphHash); assert.notEqual(edit.definition.authoring.sourceHash, frozen.sourceHash);
  assert.notEqual(model.workflowHash(edit.definition), authored.definitionHash, 'even equivalent source edits bind continuation authority');
  assert.deepEqual(runOf(control, id).definition.authoring, frozen, 'unsaved compile does not alter frozen running/history definition');
  const ledger = checkpoint.extensions.workflows;
  const recovered = runtime.recoverWorkflowState(ledger);
  assert.equal(recovered.runs[0].status, 'needs-attention'); assert(recovered.runs[0].recovered);
  assert.deepEqual(recovered.runs[0].definition.authoring, frozen);
  for (const mutate of [
    (v: any) => { v.runs[0].definition.authoring.sourceHash = '0'.repeat(64); },
    (v: any) => { v.runs[0].definition.authoring.compilerVersion = 999; },
    (v: any) => { v.runs[0].recovery.definitionHash = '0'.repeat(64); },
  ]) { const stale = clone(ledger); mutate(stale); assert.throws(() => runtime.recoverWorkflowState(stale), 'source/compiler/checkpoint mismatch refuses recovery; never recompile'); }
  assert.equal(httpCount(), 8); assert.equal(control.workflowApprovals.inspect().length, 0);
  assert.equal(nativeStarts, 8); assert.equal(nativeDisposals, nativeStarts);
  assert.equal(new Set(nativeRecords.map(record => record.sessionId)).size, 8);
  assert(nativeRecords.every(record => record.disposed && record.sessionFile));
  return { checkpoint, id, frozen, starts: nativeStarts };
}
async function inertRecovery(prepared: any) {
  // Restore a detached genuine in-flight checkpoint only AFTER live runs settled.
  // Use a distinct owned snapshot: never overwrite the live writer's fenced head.
  // This is inert restart evidence, NOT a crash/transport-closure certification.
  assert(!existsSync(recoverySnapshot));
  persistence.createClankersPersistenceManager({ enabled: true, snapshotFile: recoverySnapshot }).save(prepared.checkpoint);
  const before = { effects: effects(), requests: httpCount(), starts: nativeStarts };
  const fresh = clankers.createClankersControl(undefined, options(recoverySnapshot));
  try {
    const recovered = runOf(fresh, prepared.id); assert.equal(recovered.status, 'needs-attention'); assert.equal(recovered.recovered, true);
    assert.equal(recovered.cleanupSettled, false); assert(units(recovered).some((u: any) => u.status === 'unverified'));
    assert.deepEqual(recovered.definition.authoring, prepared.frozen);
    assert.equal((await fresh.execute({ action: 'workflows.resume', workflowRunId: prepared.id })).ok, false);
    assert.equal((await fresh.execute({ action: 'workflows.retry', workflowRunId: prepared.id })).ok, false);
    const saved = await exec(fresh, { action: 'workflows.scripts.inspect', definitionId: 'script-parallel' });
    assert.deepEqual(saved.definition.authoring, prepared.frozen);
    const assessment = await exec(fresh, { action: 'workflows.recovery.inspect', workflowRunId: prepared.id });
    assert(assessment); assert.equal(fresh.workflowApprovals.inspect().length, 0);
    await sleep(100);
    assert.deepEqual({ effects: effects(), requests: httpCount(), starts: nativeStarts }, before, 'recovery inspection inert, no parser replay/native/provider/work/snapshot effects');
  } finally {
    fresh.dispose();
    // Recovered historical native work remains unverified, even though our real
    // live sessions naturally settled. Do not invent settlement or swallow errors.
    await assert.rejects(fresh.drain(), { message: 'Native cleanup settlement is uncertain' });
    assert.equal(runOf(fresh, prepared.id).cleanupSettled, false);
    assert.deepEqual(runOf(fresh, prepared.id).definition.authoring, prepared.frozen);
    assert.deepEqual({ effects: effects(), requests: httpCount(), starts: nativeStarts }, before, 'inert recovered disposal/drain performs no native/provider/work/snapshot effects');
    put('recovery-drain.json', { ok: true, rejected: 'Native cleanup settlement is uncertain', recordedCleanupSettled: false, historicalSettlementNotClaimed: true });
  }
  put('result.json', { ok: true, mode: config.mode, actualNative: nativeStarts, disposed: nativeDisposals, requests: httpCount(), sourceHash: prepared.frozen.sourceHash, graphHash: prepared.frozen.graphHash, frozenProvenance: true, inertRecovery: true, limitations: ['scripted loopback not real-model quality', 'restored in-flight checkpoint after natural settlement, not real crash', 'not OS sandbox/manual visual acceptance', 'no coding grants made'] });
}
export async function runSDK() {
  await watchSDK(); const control = clankers.createClankersControl(undefined, options());
  try { const prepared = await journey(control); control.dispose(); await control.drain(); await inertRecovery(prepared); }
  catch (error) { put('failure.json', { error: String((error as Error).stack ?? error).slice(-16000) }); throw error; }
  finally { control.dispose(); await control.drain(); }
}
export default async function scriptHostFixture(pi: any) {
  await watchSDK(); let handler: any, started = false;
  const proxy = new Proxy(pi, { get(target, key) { if (key === 'registerCommand') return (name: string, value: any) => { if (name === 'clankers') handler = value.handler; return target.registerCommand(name, value); }; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
  const registration = clankers.registerClankersExtension(proxy, options());
  pi.on('session_shutdown', () => registration.dispose());
  pi.on('session_start', (_: unknown, ctx: any) => { if (started) return; started = true; setTimeout(() => void (async () => {
    assert.equal(ctx.mode, 'tui'); assert.equal(typeof handler, 'function');
    // Drive the REAL registered slash parser/handler with actual host context.
    // Forward notifications to Pi as well as assert replies. Authoring is handler-
    // driven, not manually typed JSON; navigation below is fresh real PTY input.
    const routes: any[] = [];
    const slash = async (action: any) => {
      const { action: name, ...body } = action;
      assert(name.startsWith('workflows.scripts.') || name === 'workflows.start');
      const command = name.startsWith('workflows.scripts.') ? 'workflows scripts ' + name.split('.').at(-1) : 'workflows start';
      const notices: Array<{ message: string; type: string }> = [];
      const ui = new Proxy(ctx.ui, { get(target, key) {
        if (key === 'notify') return (message: string, type: string) => { notices.push({ message, type }); return target.notify(message, type); };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } });
      const context = new Proxy(ctx, { get(target, key) { return key === 'ui' ? ui : Reflect.get(target, key); } });
      await handler(command + ' ' + JSON.stringify(body), context);
      assert.equal(notices.length, 1, 'one actual slash result notification');
      assert.equal(notices[0].type, 'info', notices[0].message);
      const reply = JSON.parse(notices[0].message);
      if (name === 'workflows.start') assert.equal(reply.ok, true);
      routes.push({ action: name, notification: 'info', replyHash: sha(notices[0].message), actualHostContext: true });
      put('slash-routes.json', { ok: true, authoring: 'real registered handler in actual Pi ctx; not manually typed composer JSON', routes });
      return reply;
    };
    const prepared = await journey(registration.control, async (id: string) => {
      const finished = settled(registration.control, id).then(run => put('finished.json', { status: run.status }));
      await handler('workflows monitor ' + id, ctx);
      await finished;
      assert.equal(runOf(registration.control, id).status, 'completed', 'monitor close is not cancel/start authority');
      put('monitor-closed.json', { ok: true });
    }, slash);
    for (const action of ['workflows.scripts.validate', 'workflows.scripts.compile', 'workflows.scripts.save', 'workflows.scripts.inspect', 'workflows.start']) assert(routes.some(route => route.action === action));
    registration.dispose(); await registration.control.drain(); await inertRecovery(prepared); ctx.shutdown();
  })().catch(async error => { put('failure.json', { error: String(error.stack ?? error).slice(-16000) }); registration.dispose(); await registration.control.drain(); ctx.shutdown(); }), 0); });
}
