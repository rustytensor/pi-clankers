// Test-only host. No injected WorkflowNativePort: createClankersControl and the
// registered extension own their real, sealed native SDK runner.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClankersControl, registerClankersExtension } from '../../index.js';
import { createClankersStateContainer } from '../../state.js';
import { workflowHash, workflowStepEntries } from '../../workflow-model.js';
import type { WorkflowRecoveryNativeSettlementRequest } from '../../workflow-model.js';

const root = process.env.WORKFLOW_RECOVERY_ROOT!;
const phase = process.env.WORKFLOW_RECOVERY_PHASE!;
const sha = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const read = (n: string) => JSON.parse(readFileSync(join(root, 'evidence', n), 'utf8'));
const put = (n: string, v: unknown) => writeFileSync(join(root, 'evidence', n), JSON.stringify(v, null, 2));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const original = 'export const value = 1;\n', fresh = 'export const value = 3;\n';
const target = join(root, 'work/src/bug.js');
const snapshot = join(root, 'snapshot.json');
const sdkUrl = process.env.WORKFLOW_RECOVERY_SDK!;
const nativeSessions: Array<{ id: string; file?: string; tools: string[]; disposed: boolean }> = [];
let settlementEnabled = true;
let settlementCalls = 0;

async function until(check: () => unknown, label: string) {
  const end = Date.now() + 45_000;
  while (Date.now() < end) { if (await check()) return; await sleep(25); }
  throw Error('Deadline: ' + label);
}
function processIdentity(pid: number) {
  const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(')').at(-1)!.trim().split(/\s+/);
  return { pid, bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), startTicks: fields[19] };
}
export function inspectFixtureSettlement(req: WorkflowRecoveryNativeSettlementRequest): 'settled' | 'unknown' {
  settlementCalls++;
  if (!settlementEnabled || !existsSync(join(root, 'evidence/closed-proof.json'))) return 'unknown';
  if (statSync(join(root, 'evidence/closed-proof.json')).size > 32_768) return 'unknown';
  const proof = read('closed-proof.json'), old = read('old.json');
  // An independent driver emits this only after pidfd SIGKILL, wait/owned drain,
  // held response closure AND all old accepted sockets close. This is deliberately
  // limited to this deterministic, in-process, sealed loopback transport.
  if (proof.version !== 1 || proof.transport !== 'owned-sealed-loopback-sdk-v1' ||
      proof.origin !== read('config.json').origin || proof.bindingHash !== workflowHash(old.binding) ||
      workflowHash(req) !== workflowHash(old.binding) || workflowHash(proof.binding) !== workflowHash(req) || !req.native ||
      workflowHash(proof.identity) !== workflowHash(old.identity) ||
      proof.identity.bootId !== readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() ||
      proof.processExit !== -9 || proof.kernel?.pidfdSignalled !== true || proof.kernel?.pidfdExitReadable !== true ||
      proof.kernel?.waitExit !== -9 || proof.kernel?.postOpenStartTicks !== old.identity.startTicks ||
      proof.oldHttp.active !== 0 || proof.oldHttp.sockets !== 0 ||
      proof.oldHttp.heldClosed !== true || proof.oldHttp.requestIds.length !== 3 ||
      proof.remaining.length !== 0 || proof.sealedSessionId !== old.sessions[0]?.id ||
      proof.sealedSessionFile !== old.reference.sessionFile ||
      old.reference.memberRunId !== req.native.runId ||
      proof.nativeReferenceHash !== workflowHash(old.reference) ||
      proof.exactStageWriteObserved !== true) return 'unknown';
  if (existsSync(`/proc/${proof.identity.pid}`)) return 'unknown';
  return 'settled';
}
function effects() {
  const out: Record<string, string> = {};
  function walk(p: string) { if (!existsSync(p)) return; const st = statSync(p); if (st.isDirectory()) for (const n of readdirSync(p).sort()) walk(join(p, n)); else out[p] = sha(readFileSync(p)); }
  walk(join(root, 'work')); walk(join(root, 'stage'));
  for (const n of readdirSync(root).filter(n => n.startsWith('snapshot'))) walk(join(root, n));
  return out;
}
function profile() {
  const base = { id: 'node', executable: process.execPath, argv: ['-e', "const fs=require('fs');if(fs.readFileSync('bug.js','utf8')!=='export const value = 3;\\n')process.exit(2);console.log('GENUINE_RECOVERY_CHECK')"], cwd: 'src', env: {}, timeoutMs: 10_000, allowGeneratedOutputs: false };
  return { ...base, profileHash: workflowHash(base) };
}
function options() {
  return { persistence: { enabled: true, snapshotFile: snapshot }, recovery: { enabled: true, inspectNativeSettlement: inspectFixtureSettlement }, coding: { enabled: true, projectRoot: join(root, 'work'), stagingParent: join(root, 'stage'), checkProfiles: { node: { id: 'node', executable: process.execPath, argv: profile().argv, cwd: 'src', env: {}, timeoutMs: 10_000, outputBytes: 4096 } } } };
}
function definition() {
  const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
  const str = (maxLength = 256) => ({ type: 'string', maxLength });
  const arr = (items: unknown) => ({ type: 'array', maxItems: 8, items });
  const bool = { type: 'boolean' };
  const p = { version: 3, capabilities: ['investigate', 'stage-write', 'check', 'review', 'apply'], identity: { parentRunId: 'acceptance', taskId: 'recovery', attemptNo: 1, rootAgentId: 'reviewer', workerAgentId: 'writer', model: 'fixture/writer' }, scope: { task: 'Controlled recovery fixture; stage bug.js only, preserve unrelated bytes.', writablePaths: ['src/bug.js'], readonlyPaths: ['src/untouched.txt'], baseline: { projectRootId: join(root, 'work'), stateHash: sha(original) }, manifest: [{ path: 'src/bug.js', text: original, bytes: Buffer.byteLength(original), sha256: sha(original) }] }, checkProfiles: [profile()], reviewRequired: true };
  return { id: 'recovery-native', version: 3, label: 'Actual native recovery acceptance', inputSchema: obj({}), steps: [
    { id: 'stage', kind: 'coding', dependsOn: [], inputs: {}, outputSchema: obj({ candidateHash: str(80), changedPaths: arr(str(128)) }), coding: { operation: 'stage-write', policy: p } },
    { id: 'check', kind: 'coding', dependsOn: ['stage'], inputs: {}, outputSchema: obj({ passed: bool, profileId: str(80), candidateHash: str(80) }), coding: { operation: 'check', policy: p, checkProfileId: 'node' } },
    { id: 'review', kind: 'coding', dependsOn: ['check'], inputs: {}, outputSchema: obj({ passed: bool, candidateHash: str(80), reviewer: str(160), findings: arr(obj({ id: str(20), severity: str(10), path: str(128), message: str(256) })) }), coding: { operation: 'review', policy: p } },
    { id: 'apply', kind: 'coding', dependsOn: ['review'], inputs: {}, outputSchema: obj({ status: str(16), candidateHash: str(80), appliedPaths: arr(str(128)), rejectedPaths: arr(str(128)), diagnostics: arr(str(256)), outcomeHash: str(80) }), coding: { operation: 'apply', policy: p } },
  ] };
}
async function watchSDK() {
  // Bundled Pi CLI provides its real SDK through jiti virtual modules. SDK
  // mode resolves the same name to pinned dist/index. Observe both actual
  // classes without substituting createAgentSession or its tools/transport.
  const watched = new Set<object>();
  for (const sdk of [await import(sdkUrl), await import('@earendil-works/pi-coding-agent')]) {
    const proto = sdk.AgentSession.prototype;
    if (watched.has(proto)) continue; watched.add(proto);
    const bind = proto.bindExtensions, dispose = proto.dispose;
    const records = new WeakMap<object, typeof nativeSessions[number]>();
    proto.bindExtensions = function (...args: unknown[]) {
      const tools = this.getActiveToolNames();
      if (tools.includes('workflow_stage_read') && !records.has(this)) { const rec = { id: this.sessionId, file: this.sessionFile, tools, disposed: false }; records.set(this, rec); nativeSessions.push(rec); }
      return bind.apply(this, args);
    };
    proto.dispose = function (...args: unknown[]) { try { return dispose.apply(this, args); } finally { const rec = records.get(this); if (rec) rec.disposed = true; } };
  }
}
const runOf = (control: any, id: string) => control.getState().extensions.workflows.runs.find((r: any) => r.workflowRunId === id);
const reference = (control: any, native: any) => control.getState().agents[native.runId].metadata.nativeSessions[0];
const units = (r: any) => workflowStepEntries(r).flatMap(e => e.step.units);
async function exec(control: any, input: unknown) { const result = await control.execute(input); assert(result.ok, JSON.stringify(result)); return result; }
async function approval(control: any, kind: string) {
  await until(() => { const state = control.getState(); put('gate-state.json', { kind, state, sessions: nativeSessions }); const failed = state.extensions.workflows.runs.find((r: any) => !r.recovered && ['failed', 'cancelled', 'needs-attention'].includes(r.status)); if (failed) throw Error('Run stopped before ' + kind + ': ' + JSON.stringify(failed).slice(-12000)); return control.workflowApprovals.inspect().some((r: any) => r.kind === kind && r.status === 'pending'); }, kind + ' gate');
  return control.workflowApprovals.inspect().find((r: any) => r.kind === kind && r.status === 'pending');
}
async function oldPhase(control: any) {
  for (const [id, model] of [['writer', 'fixture/writer'], ['reviewer', 'fixture/reviewer']]) await exec(control, { action: 'agents.create', id, model, tools: ['read', 'write', 'bash', 'clankers_control'], prompt: 'Use controlled workflow stage tools only.' });
  const def = definition(); await exec(control, { action: 'workflows.define', definition: def });
  const runId = (await exec(control, { action: 'workflows.start', definitionId: def.id, inputs: {}, concurrency: 1 })).data.view.workflowRunId;
  const impl = await approval(control, 'implementation'); control.workflowApprovals.grantFingerprint(impl.id, impl.requestHash);
  await until(() => existsSync(join(root, 'evidence/held.json')), 'actual tool write followed by held provider stream');
  const run = runOf(control, runId), unit = units(run).find(u => u.native)!;
  assert(unit?.native, 'actual old native identity must be present');
  const op = run.recovery.operations.find((o: any) => o.kind === 'native' && o.unitId === unit.id);
  assert(op && !op.result, 'old native intent without completion');
  assert(run.recovery.operations.some((o: any) => o.kind === 'stage-write' && o.result?.status === 'completed'), 'actual stage write recorded before crash');
  assert.equal(readFileSync(target, 'utf8'), original);
  assert.equal(nativeSessions.length, 1, 'exactly one actual old SDK writer');
  const ref = reference(control, unit.native);
  assert.equal(nativeSessions[0].file, ref.sessionFile);
  assert.equal(nativeSessions[0].id, ref.piSessionId);
  const binding = { workflowRunId: runId, familyId: run.familyId, unitId: unit.id, operationId: op.id, native: unit.native, inputHash: op.inputHash, dependencyHash: op.dependencyHash, policyHash: op.policyHash };
  put('old.json', { runId, run, binding, reference: ref, sourceNativeHistoryHash: sha(readFileSync(ref.sessionFile)), identity: processIdentity(process.pid), impl, sessions: nativeSessions, snapshotHash: sha(readFileSync(snapshot)), effects: effects() });
  // Intentionally stay active: independent controller kills this real process.
  await new Promise(() => {});
}
async function freshAssessment(control: any) {
  const old = read('old.json'), run = runOf(control, old.runId);
  assert(run?.recovered && run.status === 'needs-attention');
  assert(run.recoveryOriginal && units(run).some(u => u.status === 'unverified'));
  assert.deepEqual(run.recovery.operations, old.run.recovery.operations, 'no fabricated old completion metadata');
  assert.equal(sha(readFileSync(old.reference.sessionFile)), old.sourceNativeHistoryHash, 'old actual SDK source history remains unchanged');
  const sourceHistory = workflowHash({ steps: run.steps, original: run.recoveryOriginal, operations: run.recovery.operations });
  const before = effects();
  assert.equal(nativeSessions.length, 0);
  assert.deepEqual(control.workflowApprovals.inspect(), [], 'no old live grants');
  const missingCallback = createClankersControl(undefined, { ...options(), recovery: { enabled: true } });
  try { const denied = (await exec(missingCallback, { action: 'workflows.recovery.prepare', workflowRunId: old.runId })).data.assessment; assert(denied.blocked.some((b: string) => b.includes('native-settlement-unknown')), 'missing callback defaults to UNKNOWN'); } finally { missingCallback.dispose(); }
  settlementEnabled = false;
  const unknown = (await exec(control, { action: 'workflows.recovery.prepare', workflowRunId: old.runId })).data.assessment;
  assert(unknown.blocked.some((b: string) => b.includes('native-settlement-unknown')), JSON.stringify(unknown));
  settlementEnabled = true;
  // Exact-binding negative tests, not an always-settled callback.
  assert.equal(inspectFixtureSettlement({ ...old.binding, inputHash: '0'.repeat(64) }), 'unknown');
  assert.equal(inspectFixtureSettlement({ ...old.binding, operationId: 'alien' }), 'unknown');
  assert.equal(inspectFixtureSettlement(old.binding), 'settled');
  await exec(control, { action: 'workflows.recovery.inspect', workflowRunId: old.runId });
  const recommended = (await exec(control, { action: 'workflows.recovery.prepare', workflowRunId: old.runId })).data.assessment;
  assert.equal(recommended.plan.status, 'blocked', 'omitted selections cannot execute');
  const selections = { reuseUnitIds: [...recommended.plan.recommendedSelections.reuseUnitIds].sort(), rerunUnitIds: [...recommended.plan.recommendedSelections.rerunUnitIds].sort() };
  assert.equal(selections.rerunUnitIds.length, 4, 'explicit ALL potential execution addresses');
  const prepared = (await exec(control, { action: 'workflows.recovery.prepare', workflowRunId: old.runId, selections })).data.assessment;
  put('assessment.json', { unknown, recommended, prepared });
  assert.equal(prepared.plan.status, 'prepared', JSON.stringify(prepared));
  assert.notEqual(prepared.fingerprint, recommended.fingerprint);
  const request = { workflowRunId: old.runId, assessmentFingerprint: prepared.fingerprint, selections };
  assert.equal((await control.workflowRecovery.authorize({ ...request, assessmentFingerprint: recommended.fingerprint })).ok, false, 'actual earlier recommendation fingerprint is stale for explicit NEW selection');
  assert.equal((await control.workflowRecovery.authorize({ ...request, assessmentFingerprint: '0'.repeat(64) })).ok, false, 'wrong fingerprint cannot authorize');
  assert.equal((await control.execute({ action: 'workflows.recovery.authorize', ...request })).ok, false, 'model control action cannot self-grant');
  assert.equal((await control.execute({ action: 'workflows.recovery.prepare', workflowRunId: old.runId, selections, inspectNativeSettlement: 'settled', grant: true })).ok, false, 'model flags cannot turn prepare into authority');
  // A separate real hydrated host, temporarily in read-only caller mode. No
  // persistence write and no recovery record modification.
  const base = createClankersStateContainer(); const ro = createClankersControl(base, options());
  const state = base.read(); base.replace({ ...state, mode: { ...state.mode, readOnly: true } });
  try { assert.equal((await ro.workflowRecovery!.authorize(request)).ok, false); } finally { ro.dispose(); }
  assert.deepEqual(effects(), before, 'startup + inspect/prepare/negatives zero project/artifact/snapshot writes');
  assert.equal(nativeSessions.length, 0, 'zero SDK sessions before explicit host approval');
  assert.equal(read('http-count.json').requests, 3, 'startup/inspect/prepare/negative steps zero provider requests');
  assert.deepEqual(before, old.effects, 'crashed effects remain unchanged through hydration');
  put('ready.json', { request, sourceHistory, runId: old.runId, zeroAgents: true, effectsHash: workflowHash(before), settlementCalls });
  return { old, request, sourceHistory };
}
async function finish(control: any, context: Awaited<ReturnType<typeof freshAssessment>>, host?: any) {
  const { old, sourceHistory } = context;
  await until(() => control.getState().extensions.workflows.runs.some((r: any) => r.recoveryOf === old.runId), 'explicitly selected NEW child');
  const child = control.getState().extensions.workflows.runs.find((r: any) => r.recoveryOf === old.runId);
  assert.notEqual(child.workflowRunId, old.runId);
  const impl = await approval(control, 'implementation');
  assert.notEqual(impl.id, old.impl.id); assert.notEqual(impl.requestHash, old.impl.requestHash);
  assert.throws(() => control.workflowApprovals.grantFingerprint(old.impl.id, old.impl.requestHash));
  assert.equal(nativeSessions.length, 0, 'recovery approval is NOT implementation approval');
  assert.equal(readFileSync(target, 'utf8'), original);
  put('implementation.json', impl);
  if (host) { assert(await host.ui.confirm('NEW implementation approval', `Exact fingerprint: ${impl.requestHash}\nOnly NEW writer may stage; project unchanged.`)); }
  control.workflowApprovals.grantFingerprint(impl.id, impl.requestHash);
  put('implementation-approved.json', { id: impl.id, hash: impl.requestHash, child: child.workflowRunId });
  const app = await approval(control, 'application');
  assert.equal(readFileSync(target, 'utf8'), original, 'real native/check/review cannot apply before separate gate');
  assert.equal(nativeSessions.length, 2, 'fresh writer + distinct fresh read-only reviewer');
  const liveRun = runOf(control, child.workflowRunId), all = units(liveRun);
  const writer = all.find(u => u.stepId === 'stage')!, reviewer = all.find(u => u.stepId === 'review')!, check = all.find(u => u.stepId === 'check')!;
  assert(writer.native && reviewer.native && check.result && (check.result as any).passed);
  const evidence = check.coding?.evidence as any;
  assert.equal(evidence?.durableCheck?.receipt?.commandStarted, true);
  assert.equal(evidence?.durableCheck?.receipt?.commandCompleted, true);
  assert.equal(evidence?.durableCheck?.receipt?.commandOutcome.exitCode, 0);
  assert.equal(evidence?.durableCheck?.receipt?.cleanup.outcome, 'ok');
  assert.equal(evidence?.durableCheck?.receipt?.profileHash, evidence?.durableCheck?.intent?.profileHash);
  assert.equal(evidence?.durableCheck?.receipt?.nonce, evidence?.durableCheck?.config?.nonce);
  assert.equal(evidence?.gateEvidence?.checks[0]?.stdout, 'GENUINE_RECOVERY_CHECK\n');
  assert.equal(read('http-count.json').requests, 9, 'real writer + independent review complete before app gate');
  assert.notEqual(reference(control, writer.native).sessionFile, old.reference.sessionFile);
  assert.notEqual(writer.native.runId, old.binding.native.runId);
  assert.notEqual(reference(control, writer.native).sessionFile, reference(control, reviewer.native).sessionFile);
  assert.deepEqual(nativeSessions.map(s => s.tools.slice().sort()), [['workflow_stage_inspect', 'workflow_stage_read', 'workflow_stage_write'], ['workflow_stage_inspect', 'workflow_stage_read']]);
  assert(nativeSessions.every(s => s.disposed), 'SDK handles disposed before application approval');
  put('application.json', { app, child: child.workflowRunId, writer: writer.native, reviewer: reviewer.native, check });
  assert.throws(() => control.workflowApprovals.grantFingerprint(app.id, '0'.repeat(64)));
  if (host) { assert(await host.ui.confirm('SEPARATE NEW application approval', `Exact fingerprint: ${app.requestHash}\nApply only freshly checked/reviewed candidate now?`)); }
  control.workflowApprovals.grantFingerprint(app.id, app.requestHash);
  await control.drain();
  const done = runOf(control, child.workflowRunId); assert.equal(done.status, 'completed', JSON.stringify(done));
  assert.equal(readFileSync(target, 'utf8'), fresh);
  assert.equal(readFileSync(join(root, 'work/src/untouched.txt'), 'utf8'), 'UNRELATED_USER_BYTES\n');
  assert.equal(sha(readFileSync(old.reference.sessionFile)), old.sourceNativeHistoryHash, 'old native JSONL history not rewritten');
  const retained = runOf(control, old.runId);
  assert.equal(workflowHash({ steps: retained.steps, original: retained.recoveryOriginal, operations: retained.recovery.operations }), sourceHistory, 'old unverified/source history preserved');
  const applications = done.recovery.operations.filter((o: any) => o.kind === 'application');
  assert.equal(applications.length, 1, 'no duplicate project postimage publication');
  assert.deepEqual(applications[0].paths, ['src/bug.js']);
  assert.throws(() => control.workflowApprovals.grantFingerprint(app.id, app.requestHash));
  put('result.json', { ok: true, phase, child: child.workflowRunId, old: old.runId, sourceHistory, sessions: nativeSessions, operations: done.recovery.operations, final: done, settlementCalls });
}

export default async function recoveryHostFixture(pi: any) {
  await watchSDK();
  let clankersCommand: any;
  const proxy = new Proxy(pi, { get(target, key) { if (key === 'registerCommand') return (name: string, value: any) => { if (name === 'clankers') clankersCommand = value.handler; return target.registerCommand(name, value); }; const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; } });
  const registration = registerClankersExtension(proxy, options());
  pi.on('session_shutdown', () => registration.dispose());
  pi.on('session_start', (_: unknown, ctx: any) => {
    setTimeout(() => { void (async () => {
      if (phase === 'old') return oldPhase(registration.control);
      const prepared = await freshAssessment(registration.control);
      // PTY drives REAL registered /clankers monitor. No handleInput injection and
      // no host authorize call outside the real recovery UI.
      await clankersCommand('workflows monitor ' + prepared.old.runId, ctx);
      put('closed-first.json', { count: (registration.control.getState().extensions.workflows as any).runs.length, sessions: nativeSessions.length });
      assert.equal((registration.control.getState().extensions.workflows as any).runs.length, 1, 'close/navigation did not cancel or authorize');
      const afterClose = runOf(registration.control, prepared.old.runId); assert.equal(afterClose.status, 'needs-attention');
      assert.equal(workflowHash({ steps: afterClose.steps, original: afterClose.recoveryOriginal, operations: afterClose.recovery.operations }), prepared.sourceHistory, 'UI close/navigation preserved unverified source history');
      assert.equal(workflowHash(effects()), read('ready.json').effectsHash, 'UI inspect/navigation/close remains read-only');
      const selected = (async () => { await until(() => (registration.control.getState().extensions.workflows as any).runs.some((r: any) => r.recoveryOf === prepared.old.runId), 'UI trusted confirmation'); put('selected.json', { selected: true }); })().then(() => ({ error: undefined }), error => ({ error }));
      await clankersCommand('workflows monitor ' + prepared.old.runId, ctx);
      const selectedResult = await selected; if (selectedResult.error) throw selectedResult.error;
      await finish(registration.control, prepared, ctx);
      registration.dispose(); ctx.shutdown();
    })().catch(error => { put('failure.json', { error: String(error.stack ?? error).slice(-18_000) }); registration.dispose(); ctx.shutdown(); }); }, 0);
  });
}

if (process.argv.includes('--sdk')) {
  await watchSDK();
  const control = createClankersControl(undefined, options());
  try {
    if (phase === 'old') await oldPhase(control);
    else { const prepared = await freshAssessment(control); const result = await control.workflowRecovery!.authorize!(prepared.request); assert(result.ok, JSON.stringify(result)); await finish(control, prepared); }
  } catch (error) { put('failure.json', { error: String((error as Error).stack ?? error).slice(-18_000) }); throw error; }
  finally { control.dispose(); await control.drain!().catch(() => {}); }
}
