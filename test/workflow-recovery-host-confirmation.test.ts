import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { createClankersControl, registerClankersExtension } from '../index.js';
import { createClankersPersistenceManager } from '../persistence.js';
import { createClankersState, createClankersStateContainer, snapshotClankersState, updateClankersState } from '../state.js';
import { normalizeWorkflowAgent, workflowHash, workflowRecoveryAddresses, workflowRecoveryDependencyHash, workflowRecoverySourceContract, workflowUnitHash, type WorkflowRecoveryNativeSettlementRequest, type WorkflowDefinition, type WorkflowRun } from '../workflow-model.js';
import type { ClankersState, ClankersStateContainer } from '../types.js';

function fixture(t: test.TestContext, registered = false, now?: () => Date, extra: { coding?: boolean; fanout?: boolean; interrupted?: boolean; inspectNativeSettlement?: (request: WorkflowRecoveryNativeSettlementRequest) => 'settled' | 'unknown' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'clankers-host-confirmation-'));
  const projectRoot = join(root, 'project'), stagingParent = join(root, 'staging'), snapshotFile = join(root, 'state.json');
  mkdirSync(projectRoot); mkdirSync(stagingParent);
  const agent = normalizeWorkflowAgent({ id: 'safe', label: 'Safe', prompt: 'Read only.', model: 'fake/model', tools: ['read'], source: 'runtime' });
  const definition: WorkflowDefinition = { id: 'host-source', version: 1, label: 'Source', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, steps: [{ id: 'read', kind: 'native', dependsOn: [], inputs: {}, agentId: agent.id, prompt: 'literal', outputSchema: { type: 'string', maxLength: 64 } }] };
  if (extra.fanout) {
    definition.inputSchema = { type: 'object', properties: { items: { type: 'array', maxItems: 3, items: { type: 'string', maxLength: 32 } } }, required: ['items'], additionalProperties: false };
    definition.steps[0]!.inputs = { item: { ref: { source: 'item', path: [] } } };
    definition.steps[0]!.fanout = { from: { source: 'inputs', path: ['items'] }, maxItems: 3 };
  }
  const reviewer = normalizeWorkflowAgent({ ...agent, id: 'reviewer', label: 'Reviewer' });
  if (extra.coding) {
    mkdirSync(join(projectRoot, 'src'));
    writeFileSync(join(projectRoot, 'src/file.txt'), 'old\n');
    const profile = { id: 'local', executable: process.execPath, argv: ['-e', 'process.exit(0)'], cwd: 'src', env: {}, timeoutMs: 2000, allowGeneratedOutputs: false };
    const policy = { version: 3, capabilities: ['stage-write', 'check', 'review', 'apply'], identity: { parentRunId: 'fixture', taskId: 'fixture-task', attemptNo: 1, workerAgentId: 'safe', rootAgentId: 'reviewer', model: 'fake/model' }, scope: { task: 'Change fixture file', writablePaths: ['src/file.txt'], baseline: { projectRootId: projectRoot, stateHash: createHash('sha256').update('old\n').digest('hex') }, manifest: [{ path: 'src/file.txt', text: 'old\n', bytes: 4, sha256: createHash('sha256').update('old\n').digest('hex') }] }, bounds: { maxIterations: 3 }, reviewRequired: true, checkProfiles: [{ ...profile, profileHash: workflowHash(profile) }] };
    definition.version = 3; definition.steps = [{ id: 'stage', kind: 'coding', dependsOn: [], inputs: {}, outputSchema: { type: 'object', properties: {}, additionalProperties: false }, coding: { operation: 'stage-write', policy } }];
  }
  const run: WorkflowRun = { workflowRunId: 'source', familyId: 'source', attemptNo: 1, definition, definitionHash: workflowHash(definition), inputs: extra.fanout ? { items: ['materialized-if-selected'] } : {}, agents: { safe: agent, ...(extra.coding ? { reviewer } : {}) }, concurrency: 1, status: 'running', createdAt: '2026-10-05T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z', admissions: 0, cleanupSettled: true, recovered: false, steps: definition.steps.map(step => ({ id: step.id, status: 'queued', units: [] })) };
  const trustedRecoveryConfig = { enabled: true, durablePort: 'ensureWriter/inspectOwner:v1', sourceContract: { knownHash: null, explicitUnknown: true } };
  run.recovery = { version: 1, sequence: 0, workflowRunId: run.workflowRunId, familyId: run.familyId, attemptNo: 1, definitionHash: run.definitionHash, inputsHash: workflowHash(run.inputs), policyHash: workflowHash({ definition, agents: run.agents, trustedRecoveryConfig }), configurationHash: workflowHash({ concurrency: run.concurrency, trustedRecoveryConfig }), budget: { maxAttempts: 3, maxAdmissions: 256, usedAdmissions: 0, attemptIds: ['source'], correctionsUsed: 0 }, operations: [] };
  if (extra.interrupted) {
    const spec = definition.steps[0]!;
    const unit = { id: 'read:0', stepId: 'read', index: 0, status: 'running' as const, inputHash: workflowUnitHash(run, spec, {}), inputs: {}, cleanupSettled: false, native: { runId: 'old-owned-native', taskId: 'old-owned-task' } };
    run.steps[0] = { id: 'read', status: 'running', units: [unit] }; run.admissions = 1; run.cleanupSettled = false;
    run.recovery.budget.usedAdmissions = 1; run.recovery.sequence = 1;
    run.recovery.operations = [{ kind: 'native', id: 'old-native-operation', sequence: 0, stepId: 'read', unitId: unit.id, inputHash: unit.inputHash, dependencyHash: workflowRecoveryDependencyHash(run, spec, unit, workflowRecoverySourceContract()), policyHash: workflowHash({ kind: 'native', agent, prompt: spec.prompt, outputSchema: spec.outputSchema, hostSourceContract: workflowRecoverySourceContract() }), paths: [], preimage: null, postimage: null, intent: { recordedAt: run.createdAt } }];
  }
  const seed = createClankersStateContainer({ agentDefinitions: { safe: agent, ...(extra.coding ? { reviewer } : {}) }, extensions: { workflows: { version: 1, definitions: [definition], runs: [run] } } });
  const manager = createClankersPersistenceManager({ snapshotFile })!;
  manager.hydrate(seed); manager.save(seed.read());
  const ownership = manager.acquireRecoveryOwnership!();
  // Local disk fixture simulates a retained verified-dead previous owner. No Pi process.
  writeFileSync(`${snapshotFile}.recovery-writer.lock/owner.json`, JSON.stringify({ version: 1, owner: { ...ownership.owner, pid: 2147483647, startTimeTicks: '1' } }));
  const base = createClankersStateContainer(); let launches = 0;
  const options = { now, persistence: { snapshotFile }, recovery: { enabled: true, ...(extra.inspectNativeSettlement ? { inspectNativeSettlement: extra.inspectNativeSettlement } : {}) }, coding: { enabled: extra.coding ?? false, projectRoot, stagingParent, ...(extra.coding ? { checkProfiles: { local: { id: 'local', executable: process.execPath, argv: ['-e', 'process.exit(0)'], cwd: 'src', env: {}, timeoutMs: 2000, outputBytes: 65536, generatedOutputs: [] } } } : {}) }, ...(extra.coding ? {} : { subagentAdapter: { kind: 'fake' as const, launch() { launches++; throw new Error('must not launch'); } } }) };
  const registration = registered ? registerClankersExtension({ registerCommand() {}, registerTool() {}, on() {} }, options) : undefined;
  const control = registration?.control ?? createClankersControl(base, options);
  t.after(() => { try { registration ? registration.dispose() : control.dispose(); } finally { rmSync(root, { recursive: true, force: true }); } });
  return { root, projectRoot, stagingParent, base, control, snapshotFile, source: run, get launches() { return launches; } };
}
async function prepare(f: ReturnType<typeof fixture>) {
  const result = await f.control.execute({ action: 'workflows.recovery.prepare', workflowRunId: 'source', selections: { reuseUnitIds: [], rerunUnitIds: workflowRecoveryAddresses(f.source.definition).map(a => a.unitId) } });
  assert.equal(result.ok, true, JSON.stringify(result));
  const assessment = (result.data as any).assessment;
  assert.equal(assessment.plan.status, 'prepared', JSON.stringify(assessment.blocked));
  return { workflowRunId: 'source', assessmentFingerprint: assessment.fingerprint as string, selections: assessment.selections as { reuseUnitIds: string[]; rerunUnitIds: string[] } };
}

test('actual control recovery capability reads and missing-run requests never initialize a ledger or acquire a writer', async t => {
  for (const existingSnapshot of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), 'clankers-host-inert-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const snapshotFile = join(root, 'state.json');
    if (existingSnapshot) {
      const seed = createClankersStateContainer();
      const manager = createClankersPersistenceManager({ snapshotFile })!;
      manager.hydrate(seed); manager.save(seed.read());
    }
    const disk = () => readdirSync(root, { recursive: true }).map(name => [name, readFileSync(join(root, String(name))).toString('hex')]);
    const beforeConstruction = disk();
    const base = createClankersStateContainer();
    let launches = 0, publications = 0;
    const control = createClankersControl(base, {
      persistence: { snapshotFile }, recovery: { enabled: true },
      subagentAdapter: { kind: 'fake', launch() { launches++; throw new Error('must not launch'); } },
    });
    t.after(() => control.dispose());
    base.subscribe!(() => { publications++; });
    const initial = control.getState();
    assert.equal(initial.extensions.workflows, undefined);
    assert.deepEqual(disk(), beforeConstruction);
    const inert = () => {
      assert.deepEqual(disk(), beforeConstruction, 'no snapshot writes or recovery ownership lock/claim acquisition');
      assert.deepEqual(control.getState(), initial, 'no revisions or ledger initialization');
      assert.equal(publications, 0); assert.equal(launches, 0);
    };
    const api = control.workflowRecovery!;
    assert.ok(api); inert();
    for (let i = 0; i < 3; i++) { assert.equal(control.workflowRecovery, api); inert(); }
    // The service helper is the same inert proxy surfaced as host authority.
    const helper = api as NonNullable<import('../workflow-model.js').WorkflowService['recovery']>;
    const prepared = await helper.prepare('missing', { rerunUnitIds: ['read:0'] });
    assert.equal(prepared.ok, false); assert.match(prepared.error!, /run not found/i); inert();
    const executed = await control.execute({ action: 'workflows.recovery.prepare', workflowRunId: 'missing' });
    assert.equal(executed.ok, false); inert();
    const request = { workflowRunId: 'missing', assessmentFingerprint: 'a'.repeat(64), selections: { rerunUnitIds: ['read:0'] } };
    const reply = await api.authorize(request);
    assert.equal(reply.ok, false); assert.match(reply.error!, /run not found/i); inert();
    const aborted = new AbortController(); aborted.abort();
    assert.match((await api.authorize(request, aborted.signal)).error!, /cancelled/i); inert();
    control.dispose();
    assert.equal(control.workflowRecovery, api);
    assert.match((await api.authorize(request)).error!, /disposed/i); inert();
  }
});

test('trusted proxy checks exact run before service initialization with an existing ledger', async t => {
  const f = fixture(t), before = readFileSync(f.snapshotFile), initial = f.control.getState();
  const reply = await f.control.workflowRecovery!.authorize({ workflowRunId: 'missing', assessmentFingerprint: 'a'.repeat(64) });
  assert.equal(reply.ok, false); assert.match(reply.error!, /run not found/i);
  assert.deepEqual(readFileSync(f.snapshotFile), before); assert.deepEqual(f.control.getState(), initial);
  assert.equal(f.launches, 0);
});

test('real host wiring uses exact displayed proof, acknowledges actual running child, and duplicate returns same child', async t => {
  const f = fixture(t), before = readFileSync(f.snapshotFile);
  const request = await prepare(f);
  assert.deepEqual(readFileSync(f.snapshotFile), before, 'inspection never saves');
  const api = f.control.workflowRecovery; assert.ok(api);
  const reply = await api.authorize(request);
  assert.equal(reply.ok, true, reply.error);
  assert.equal(reply.view?.status, 'running');
  const child = reply.view!.workflowRunId;
  const saved = JSON.parse(readFileSync(f.snapshotFile, 'utf8')).state.extensions.workflows;
  assert.equal(saved.runs.length, 2); assert.equal(saved.runs[0].recovery.selection.assessmentFingerprint, request.assessmentFingerprint);
  assert.equal(saved.runs[1].recoveryOf, 'source'); assert.equal(saved.runs[1].admissions, 0);
  assert.equal(f.launches, 0);
  const bytes = readFileSync(f.snapshotFile);
  const duplicate = await api.authorize(request);
  assert.equal(duplicate.ok, true, duplicate.error); assert.equal(duplicate.view?.workflowRunId, child);
  assert.deepEqual(readFileSync(f.snapshotFile), bytes);
});

test('host rejects stale, readOnly, disposed, aborted and model-facing grants without publication', async t => {
  for (const kind of ['stale', 'readOnly', 'disposed', 'aborted', 'model'] as const) {
    const f = fixture(t), request = await prepare(f), api = f.control.workflowRecovery!;
    const before = readFileSync(f.snapshotFile), revision = f.base.read().revision;
    if (kind === 'readOnly') f.base.update({ mode: { ...f.base.read().mode, readOnly: true } });
    if (kind === 'disposed') f.control.dispose();
    const signal = new AbortController(); if (kind === 'aborted') signal.abort();
    const reply = kind === 'model' ? await f.control.execute({ action: 'workflows.recovery.authorize', ...request } as never)
      : await api.authorize({ ...request, ...(kind === 'stale' ? { assessmentFingerprint: 'a'.repeat(64) } : {}) }, signal.signal);
    assert.equal(reply.ok, false, kind); assert.deepEqual(readFileSync(f.snapshotFile), before, kind); assert.equal(f.launches, 0);
    if (kind === 'readOnly') assert.equal(f.base.read().mode.readOnly, true);
    else assert.equal(f.base.read().revision, revision);
  }
});

// Unit hooks compiled from the ACTUAL host wrapper and port, not an alternate writer.
const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('index.ts', source, ts.ScriptTarget.ES2022, true);
const compile = (text: string) => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function hooks(baseContainer: ClankersStateContainer, manager: any, options: any = {}, registered = false) {
  const recoveryPublications = new WeakMap(), recoveryWriterIdleChecks = new WeakMap(), ownedPersistenceManagers = new WeakMap();
  const fn = parsed.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === (registered ? 'registerClankersExtension' : 'createClankersControl'))!;
  const statements = [...fn.body!.statements];
  const index = (name: string) => statements.findIndex(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === name));
  const preparedStart = index('preparedOwner'), preparedEnd = index('assertPreparedOwner');
  if (!registered) assert.ok(preparedStart >= 0 && preparedEnd >= preparedStart, 'prepared owner initialization source missing');
  const initialization = registered ? [] : statements.slice(preparedStart, preparedEnd + 1);
  const text = [...initialization, ...statements.slice(index('committingPersistentState'), index('nativeTranscriptService'))].map(n => n.getText(parsed)).join('\n');
  let shared: ClankersState | undefined;
  const container = new Function('startupRecoveryBlock', 'baseContainer', 'stateContainer', 'syncSharedStateFromContainer', 'persistenceManager', 'options', 'createClankersState', 'updateClankersState', 'snapshotClankersState', 'isDeepStrictEqual', 'associatedPersistenceManager', 'ownedPersistenceManagers', 'recoveryPublications', 'recoveryWriterIdleChecks', compile(text + `\nreturn ${registered ? 'syncedStateContainer' : 'container'};`))(undefined, baseContainer, baseContainer, () => { shared = baseContainer.snapshot(); }, manager, options, createClankersState, updateClankersState, snapshotClankersState, isDeepStrictEqual, undefined, ownedPersistenceManagers, recoveryPublications, recoveryWriterIdleChecks) as ClankersStateContainer;
  const builder = parsed.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === 'buildWorkflowRecoveryOptions')!;
  const build = new Function('recoveryPublications', 'recoveryWriterIdleChecks', 'isDeepStrictEqual', 'inspectPreviousWorkflowOwner', compile(builder.getText(parsed) + '\nreturn buildWorkflowRecoveryOptions;'))(recoveryPublications, recoveryWriterIdleChecks, isDeepStrictEqual, () => 'dead');
  let disposed = false; let notified: unknown;
  const port = build({ recovery: { enabled: true } }, manager, container, () => disposed, (owner: unknown) => { notified = owner; }).durablePort;
  return { container, port, dispose: () => { disposed = true; }, get notified() { return notified; }, get shared() { return shared; } };
}
function mockManager() {
  let head = 'a'.repeat(64), acquired = false, saves = 0;
  const owner = { writerSessionId: 'same-manager', generation: 'same-generation' };
  const manager = { info: {}, hydrate() {}, acquireRecoveryOwnership(request: any) { assert.equal(request.expectedSnapshotHash, head); acquired = true; return { owner }; }, inspectRecoveryOwnership() { return { owner: acquired ? owner : undefined, ownerValid: acquired, claimPresent: false, actualSnapshotHash: head, expectedSnapshotHash: head }; }, save(_state: ClankersState, now?: () => Date) { now?.(); saves++; head = 'b'.repeat(64); }, get saves() { return saves; } };
  return manager;
}
test('existing wrapped publication has one save, same-manager owner notification, and no independent commit', () => {
  const base = createClankersStateContainer(), manager = mockManager(), h = hooks(base, manager);
  const owner = h.port.acquireWriter({ expectedSnapshotHash: 'a'.repeat(64) });
  assert.equal(h.notified, owner);
  let observed = 0; base.subscribe!(() => { observed++; assert.equal(manager.saves, 1); assert.throws(() => h.container.replace({}), /nested/); });
  const canonical = h.port.publishSnapshot({ ...base.read(), selectedNodeId: 'child' }, { expectedSnapshotHash: 'a'.repeat(64) });
  assert.equal(manager.saves, 1); assert.equal(observed, 1); assert.deepEqual(canonical, base.read());
});
test('clock callback authority loss blocks save/publication; disposal/head checks precede effects', () => {
  for (const change of ['readOnly', 'dispose', 'head'] as const) {
    const base = createClankersStateContainer(), manager = mockManager(); let callback = () => {};
    const h = hooks(base, manager, { now() { callback(); return new Date(); } });
    h.port.acquireWriter({ expectedSnapshotHash: 'a'.repeat(64) });
    if (change === 'readOnly') callback = () => { base.update({ mode: { ...base.read().mode, readOnly: true } }); };
    if (change === 'dispose') callback = h.dispose;
    assert.throws(() => h.port.publishSnapshot({ ...base.read(), selectedNodeId: 'child' }, { expectedSnapshotHash: (change === 'head' ? 'c' : 'a').repeat(64) }), /read-only|disposed|changed/);
    assert.equal(manager.saves, 0); assert.notEqual(base.read().selectedNodeId, 'child');
  }
});

test('registered control preserves authoritative manager association through trusted wrapped publication', async t => {
  const f = fixture(t, true), before = readFileSync(f.snapshotFile);
  const status = await f.control.execute({ action: 'status' });
  const writerSessionId = (status.data as any).persistence.writerSessionId;
  assert.ok(writerSessionId);
  const request = await prepare(f);
  assert.deepEqual(readFileSync(f.snapshotFile), before);
  const reply = await f.control.workflowRecovery!.authorize(request);
  assert.equal(reply.ok, true, reply.error);
  const envelope = JSON.parse(readFileSync(f.snapshotFile, 'utf8'));
  const marker = JSON.parse(readFileSync(`${f.snapshotFile}.recovery-writer.lock/owner.json`, 'utf8'));
  assert.equal(envelope.writerSessionId, writerSessionId);
  assert.equal(marker.owner.writerSessionId, writerSessionId);
  assert.equal(envelope.state.extensions.workflows.runs.length, 2);
  assert.equal(f.control.getState().extensions.workflows && (f.control.getState().extensions.workflows as any).runs.length, 2);
  assert.equal(f.launches, 0);
});
test('publication observer disposal or owner generation loss poisons the existing writer after one save', () => {
  for (const kind of ['disposed', 'generation'] as const) {
    const base = createClankersStateContainer(), manager = mockManager(), h = hooks(base, manager);
    h.port.acquireWriter({ expectedSnapshotHash: 'a'.repeat(64) });
    let lost = false;
    const inspect = manager.inspectRecoveryOwnership;
    manager.inspectRecoveryOwnership = () => { const current = inspect(); return lost && current.owner ? { ...current, owner: { ...current.owner, generation: 'changed' } } : current; };
    base.subscribe!(() => { if (kind === 'disposed') h.dispose(); else lost = true; });
    assert.throws(() => h.port.publishSnapshot({ ...base.read(), selectedNodeId: 'child' }, { expectedSnapshotHash: 'a'.repeat(64) }), /disposed|owner\/head changed/);
    assert.equal(manager.saves, 1); assert.equal(base.read().selectedNodeId, 'child');
    assert.throws(() => h.container.replace({}), /previous failure/);
  }
});

// Real filesystem/ownership manager behind each ACTUAL wrapper. The selected
// source/child state is produced by trusted runtime authorization, not hand-built.
async function diskHooks(t: test.TestContext, registered: boolean, now?: () => Date) {
  const f = fixture(t), request = await prepare(f), sourceState = f.base.snapshot();
  const reply = await f.control.workflowRecovery!.authorize(request);
  assert.equal(reply.ok, true, reply.error);
  const intended = f.control.getState(), childId = reply.view!.workflowRunId;
  const snapshotFile = join(f.root, `wrapped-${registered}.json`);
  const base = createClankersStateContainer();
  const manager = createClankersPersistenceManager({ snapshotFile })!;
  manager.hydrate(base); base.replace(sourceState); manager.save(base.read());
  let saves = 0;
  const save = manager.save.bind(manager);
  manager.save = (state, clock) => { saves++; return save(state, clock); };
  const h = hooks(base, manager, { now }, registered);
  const head = manager.inspectRecoveryOwnership!().actualSnapshotHash!;
  const owner = h.port.acquireWriter({ expectedSnapshotHash: head });
  t.after(() => { try { manager.releaseRecoveryOwnership!(owner); } catch { /* deliberately poisoned fixtures retain evidence */ } });
  const disk = () => JSON.parse(readFileSync(snapshotFile, 'utf8')).state as ClankersState;
  const publish = () => h.port.publishSnapshot(intended, { expectedSnapshotHash: head });
  return { ...h, base, manager, intended, childId, snapshotFile, disk, publish, get shared() { return h.shared; }, get saves() { return saves; } };
}

// Save owns envelope metadata and JSON omits undefined fields. Compare the
// entire durable canonical payload except that manager-owned bookkeeping.
function durableCanonical(state: ClankersState) {
  const copy = JSON.parse(JSON.stringify(state));
  delete copy.extensions.clankersPersistence;
  return copy;
}

test('both wrappers use one real-manager selection save, no redundant ordinary save', async t => {
  for (const registered of [false, true]) {
    const h = await diskHooks(t, registered);
    h.base.subscribe!(() => {
      assert.equal(h.saves, 1);
      assert.equal((h.disk().extensions.workflows as any).runs.length, 2, 'selection saved before publication');
      assert.throws(() => h.container.replace({}), /nested/);
    });
    const canonical = h.publish();
    assert.equal(h.saves, 1); assert.deepEqual(durableCanonical(h.disk()), durableCanonical(canonical));
    assert.deepEqual(canonical, h.base.read());
    assert.equal(h.manager.inspectRecoveryOwnership!().actualSnapshotHash, h.manager.inspectRecoveryOwnership!().expectedSnapshotHash);
  }
});

test('both wrappers persist synchronous observer readOnly/cancellation canonically through real manager', async t => {
  for (const registered of [false, true]) {
    const h = await diskHooks(t, registered);
    let changed = false;
    h.base.subscribe!(() => {
      if (changed) return; changed = true;
      const current = h.base.read(), workflows = current.extensions.workflows as any;
      h.base.update({ mode: { ...current.mode, readOnly: true }, extensions: { ...current.extensions, workflows: { ...workflows,
        runs: workflows.runs.map((run: WorkflowRun) => run.workflowRunId === h.childId ? { ...run, status: 'cancelled' } : run),
      } } });
    });
    const canonical = h.publish();
    assert.equal(h.saves, 2, 'selection plus necessary canonical follow-up, no generic update');
    assert.deepEqual(durableCanonical(h.disk()), durableCanonical(h.base.read())); assert.deepEqual(canonical, h.base.read());
    assert.equal(h.disk().mode.readOnly, true);
    const runs = (h.disk().extensions.workflows as any).runs as WorkflowRun[];
    assert.equal(runs.length, 2); assert.equal(runs[1]!.status, 'cancelled'); assert.equal(runs[1]!.admissions, 0);
    assert.equal(h.manager.inspectRecoveryOwnership!().blocker, undefined);
    if (registered) assert.deepEqual(h.shared, canonical, 'shared publication preserves canonical revocation');
  }
});

test('real-manager canonical follow-up failure is uncertain, retains first disk selection and poisons both wrappers', async t => {
  for (const registered of [false, true]) {
    let failClock = false;
    const h = await diskHooks(t, registered, () => failClock ? new Date(NaN) : new Date());
    let changed = false;
    h.base.subscribe!(() => {
      if (changed) return; changed = true; failClock = true;
      h.base.update({ mode: { ...h.base.read().mode, readOnly: true } });
    });
    assert.throws(h.publish, /uncertain.*Invalid time/);
    assert.equal(h.saves, 2); assert.equal(h.base.read().mode.readOnly, true);
    assert.notEqual(h.disk().mode.readOnly, true, 'failed follow-up honestly retains first committed selection');
    assert.equal((h.disk().extensions.workflows as any).runs.length, 2);
    const bytes = readFileSync(h.snapshotFile);
    assert.throws(() => h.container.update({ selectedNodeId: 'unauthorized' }), /previous failure/);
    assert.throws(h.publish, /previous failure|read-only/);
    assert.throws(() => h.port.acquireWriter({ expectedSnapshotHash: h.manager.inspectRecoveryOwnership!().actualSnapshotHash }), /poisoned|read-only/);
    assert.deepEqual(readFileSync(h.snapshotFile), bytes); assert.equal(h.saves, 2);
    assert.equal((h.base.read().extensions.workflows as any).runs.length, 2, 'never creates a second child');
  }
});

test('real runtime observer cancellation is persisted, prevents activation and duplicate child', async t => {
  const f = fixture(t), request = await prepare(f);
  let changed = false;
  f.base.subscribe!(() => {
    const current = f.base.read(), workflows = current.extensions.workflows as any;
    if (changed || workflows?.runs.length !== 2) return; changed = true;
    f.base.update({ mode: { ...current.mode, readOnly: true }, extensions: { ...current.extensions, workflows: { ...workflows,
      runs: workflows.runs.map((run: WorkflowRun) => run.recoveryOf === 'source' ? { ...run, status: 'cancelled' } : run),
    } } });
  });
  const reply = await f.control.workflowRecovery!.authorize(request);
  assert.equal(reply.ok, false); assert.match(reply.error!, /changed during recovery publication/);
  const disk = JSON.parse(readFileSync(f.snapshotFile, 'utf8')).state;
  assert.equal(disk.mode.readOnly, true); assert.deepEqual(disk.extensions.workflows, f.base.read().extensions.workflows);
  assert.equal(disk.extensions.workflows.runs[1].status, 'cancelled');
  const duplicate = await f.control.workflowRecovery!.authorize(request);
  assert.equal(duplicate.ok, false); assert.equal((f.base.read().extensions.workflows as any).runs.length, 2);
  const resumed = await f.control.execute({ action: 'workflows.resume', workflowRunId: disk.extensions.workflows.runs[1].workflowRunId });
  assert.equal(resumed.ok, false); assert.equal(f.launches, 0);
});

test('real-manager recording refuses disposed owner, changed generation or head without rollback', async t => {
  for (const registered of [false, true]) for (const kind of ['dispose', 'generation', 'head'] as const) {
    const h = await diskHooks(t, registered);
    let changed = false, lastDisk: Buffer | undefined;
    h.base.subscribe!(() => {
      if (changed) return; changed = true;
      h.base.update({ mode: { ...h.base.read().mode, readOnly: true } });
      if (kind === 'dispose') h.dispose();
      if (kind === 'generation') {
        const markerFile = `${h.snapshotFile}.recovery-writer.lock/owner.json`;
        const marker = JSON.parse(readFileSync(markerFile, 'utf8'));
        marker.owner.generation = 'unowned-generation'; writeFileSync(markerFile, JSON.stringify(marker));
      }
      if (kind === 'head') writeFileSync(h.snapshotFile, readFileSync(h.snapshotFile, 'utf8') + '\n');
      lastDisk = readFileSync(h.snapshotFile);
    });
    assert.throws(h.publish, /uncertain.*(disposed|owner\/head changed)/);
    assert.equal(h.saves, 1, 'no recording without valid head/generation/owner');
    assert.equal(h.base.read().mode.readOnly, true); assert.notEqual(h.disk().mode.readOnly, true);
    assert.deepEqual(readFileSync(h.snapshotFile), lastDisk, 'no unauthorized save or rollback');
    assert.throws(() => h.container.replace({}), /previous failure/);
  }
});

test('canonical recording clock cannot silently substitute a new canonical version', async t => {
  for (const registered of [false, true]) {
    let callback = () => {};
    const h = await diskHooks(t, registered, () => { callback(); return new Date(); });
    let changed = false;
    h.base.subscribe!(() => {
      if (changed) return; changed = true;
      h.base.update({ mode: { ...h.base.read().mode, readOnly: true } });
      callback = () => h.base.update({ selectedNodeId: 'new-observer-version' });
    });
    assert.throws(h.publish, /uncertain.*canonical state changed/);
    assert.equal(h.saves, 2); assert.equal(h.base.read().selectedNodeId, 'new-observer-version');
    assert.notEqual(h.disk().selectedNodeId, 'new-observer-version');
    assert.throws(() => h.container.replace({}), /previous failure/);
  }
});

test('real runtime failed canonical save reports uncertainty and blocks all later recovery mutation', async t => {
  let failClock = false;
  const f = fixture(t, false, () => failClock ? new Date(NaN) : new Date()), request = await prepare(f);
  let changed = false;
  f.base.subscribe!(() => {
    if (changed || (f.base.read().extensions.workflows as any)?.runs.length !== 2) return; changed = true;
    f.base.update({ mode: { ...f.base.read().mode, readOnly: true } }); failClock = true;
  });
  const reply = await f.control.workflowRecovery!.authorize(request);
  assert.equal(reply.ok, false); assert.match(reply.error!, /uncertain.*Invalid time/);
  const bytes = readFileSync(f.snapshotFile), disk = JSON.parse(bytes.toString()).state;
  assert.equal(disk.extensions.workflows.runs.length, 2); assert.notEqual(disk.mode.readOnly, true);
  assert.equal(f.base.read().mode.readOnly, true);
  failClock = false;
  const duplicate = await f.control.workflowRecovery!.authorize(request);
  assert.equal(duplicate.ok, false);
  const resumed = await f.control.execute({ action: 'workflows.resume', workflowRunId: disk.extensions.workflows.runs[1].workflowRunId });
  assert.equal(resumed.ok, false); assert.deepEqual(readFileSync(f.snapshotFile), bytes);
  assert.equal((f.base.read().extensions.workflows as any).runs.length, 2); assert.equal(f.launches, 0);
});

test('real runtime readOnly-only observer revocation reaches disk and blocks activation', async t => {
  const f = fixture(t), request = await prepare(f);
  let changed = false;
  f.base.subscribe!(() => {
    if (changed || (f.base.read().extensions.workflows as any)?.runs.length !== 2) return; changed = true;
    f.base.update({ mode: { ...f.base.read().mode, readOnly: true } });
  });
  // Provisional runtime may acknowledge the inert selection or reject lost
  // authority; in neither case is acknowledgement an execution grant.
  await f.control.workflowRecovery!.authorize(request);
  const bytes = readFileSync(f.snapshotFile), disk = JSON.parse(bytes.toString()).state;
  assert.equal(disk.mode.readOnly, true); assert.deepEqual(disk.extensions.workflows, f.base.read().extensions.workflows);
  const child = disk.extensions.workflows.runs[1]; assert.equal(child.admissions, 0);
  const resumed = await f.control.execute({ action: 'workflows.resume', workflowRunId: child.workflowRunId });
  assert.equal(resumed.ok, false);
  const duplicate = await f.control.workflowRecovery!.authorize(request);
  assert.equal(duplicate.ok, false); assert.deepEqual(readFileSync(f.snapshotFile), bytes);
  assert.equal((f.base.read().extensions.workflows as any).runs.length, 2); assert.equal(f.launches, 0);
});

test('actual host recommendation is read-only and all explicit potential addresses require a new fingerprint before authorization', async t => {
  const f = fixture(t), before = readFileSync(f.snapshotFile);
  const first = await f.control.execute({ action: 'workflows.recovery.prepare', workflowRunId: 'source', selections: { reuseUnitIds: [], rerunUnitIds: [] } });
  assert.equal(first.ok, true); const assessment = (first.data as any).assessment;
  assert.equal(assessment.plan.status, 'blocked'); assert.ok(assessment.blocked.includes('unselected-required-execution-address'));
  assert.deepEqual(assessment.plan.recommendedSelections, { reuseUnitIds: [], rerunUnitIds: ['read:0'] });
  assert.deepEqual(readFileSync(f.snapshotFile), before); assert.equal(f.launches, 0);
  const request = await prepare(f); assert.notEqual(request.assessmentFingerprint, assessment.fingerprint);
  assert.deepEqual(readFileSync(f.snapshotFile), before);
  assert.equal((await f.control.workflowRecovery!.authorize({ ...request, assessmentFingerprint: assessment.fingerprint })).ok, false);
  assert.deepEqual(readFileSync(f.snapshotFile), before);
});

test('actual owned host selected coding child awaits separate implementation; no SDK/native/stage/destination effect before grant', async t => {
  const f = fixture(t, false, undefined, { coding: true });
  const before = readFileSync(f.snapshotFile), request = await prepare(f);
  assert.deepEqual(readFileSync(f.snapshotFile), before); assert.deepEqual(readdirSync(f.stagingParent), []);
  const selected = await f.control.workflowRecovery!.authorize(request);
  assert.equal(selected.ok, true, selected.error); assert.equal(selected.view?.status, 'running');
  for (let i = 0; i < 10 && !f.control.workflowApprovals!.inspect().some(row => row.status === 'pending'); i++) await new Promise(resolve => setImmediate(resolve));
  const pending = f.control.workflowApprovals!.inspect(); assert.equal(pending.length, 1);
  assert.equal(pending[0]!.kind, 'implementation'); assert.equal(pending[0]!.status, 'pending');
  const workflow = f.control.getState().extensions.workflows as any;
  const child = workflow.runs.find((r: WorkflowRun) => r.workflowRunId === selected.view!.workflowRunId) as WorkflowRun;
  assert.equal(child.status, 'running'); assert.equal(child.steps[0]!.units[0]!.coding?.phase, 'awaiting-implementation-approval');
  assert.equal(child.admissions, 0); assert.equal(child.steps[0]!.units[0]!.native, undefined);
  assert.deepEqual(readdirSync(f.stagingParent), []); assert.equal(readFileSync(join(f.projectRoot, 'src/file.txt'), 'utf8'), 'old\n');
  assert.equal(Object.keys(f.control.getState().tasks).length, 0);
  assert.deepEqual(JSON.parse(readFileSync(f.snapshotFile, 'utf8')).state.extensions.workflows, workflow);
});

test('missing or unknown trusted native lifecycle proof blocks interrupted source despite verified dead persistence owner', async t => {
  for (const callback of [undefined, (_request: WorkflowRecoveryNativeSettlementRequest) => 'unknown' as const]) {
    const f = fixture(t, false, undefined, { interrupted: true, inspectNativeSettlement: callback }), before = readFileSync(f.snapshotFile);
    const result = await f.control.execute({ action: 'workflows.recovery.prepare', workflowRunId: 'source', selections: { reuseUnitIds: [], rerunUnitIds: ['read:0'] } });
    assert.equal(result.ok, true, JSON.stringify(result.error)); const assessment = (result.data as any).assessment;
    assert.equal(assessment.plan.status, 'blocked'); assert.ok(assessment.blocked.includes('unit:read:0:previous-native-settlement-unknown'));
    const rejected = await f.control.workflowRecovery!.authorize({ workflowRunId: 'source', assessmentFingerprint: assessment.fingerprint, selections: assessment.selections });
    assert.equal(rejected.ok, false); assert.deepEqual(readFileSync(f.snapshotFile), before); assert.equal(f.launches, 0);
  }
});

test('trusted settlement callback is forwarded with exact request bindings, never grants a native result or approvals', async t => {
  const requests: WorkflowRecoveryNativeSettlementRequest[] = [];
  // Local fixture transport never owned a subprocess/socket/session. Proof is the
  // host-owned closed lifecycle fixture tuple, NOT dead-PID inference or SDK evidence.
  let expected: WorkflowRecoveryNativeSettlementRequest | undefined;
  const f = fixture(t, false, undefined, { interrupted: true, inspectNativeSettlement: request => {
    requests.push(request); return expected && isDeepStrictEqual(request, expected) ? 'settled' : 'unknown';
  } });
  const op = f.source.recovery!.operations[0]!;
  expected = { workflowRunId: 'source', familyId: 'source', unitId: 'read:0', operationId: op.id, native: f.source.steps[0]!.units[0]!.native!, inputHash: op.inputHash, dependencyHash: op.dependencyHash, policyHash: op.policyHash };
  const before = readFileSync(f.snapshotFile), request = await prepare(f);
  assert.ok(requests.length > 0); assert.deepEqual(requests[0], expected);
  assert.deepEqual(readFileSync(f.snapshotFile), before); assert.equal(f.launches, 0);
  assert.equal((f.control.getState().extensions.workflows as any).runs.length, 1);
  assert.deepEqual(f.control.workflowApprovals!.inspect(), []);
  assert.deepEqual(request.selections, { reuseUnitIds: [], rerunUnitIds: ['read:0'] });
});

test('default owned native adapter construction/inspection/disposal never independently hydrates/saves a blocked authoritative manager', async t => {
  const root = mkdtempSync(join(tmpdir(), 'clankers-owned-host-inert-')), snapshotFile = join(root, 'state.json');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manager = createClankersPersistenceManager({ snapshotFile })!, seed = createClankersStateContainer(); manager.hydrate(seed); manager.save(seed.read());
  const owner = manager.acquireRecoveryOwnership!().owner;
  writeFileSync(`${snapshotFile}.recovery-writer.lock/owner.json`, JSON.stringify({ version: 1, owner: { ...owner, pid: 2147483647, startTimeTicks: '1' } }));
  const before = readFileSync(snapshotFile), marker = readFileSync(`${snapshotFile}.recovery-writer.lock/owner.json`);
  const control = createClankersControl(createClankersStateContainer(), { persistence: { snapshotFile }, recovery: { enabled: true } });
  const initial = control.getState();
  const missing = await control.workflowRecovery!.authorize({ workflowRunId: 'missing', assessmentFingerprint: 'f'.repeat(64) });
  assert.equal(missing.ok, false); assert.deepEqual(control.getState(), initial);
  assert.deepEqual(readFileSync(snapshotFile), before); assert.deepEqual(readFileSync(`${snapshotFile}.recovery-writer.lock/owner.json`), marker);
  control.dispose(); control.dispose();
  assert.deepEqual(readFileSync(snapshotFile), before); assert.deepEqual(readFileSync(`${snapshotFile}.recovery-writer.lock/owner.json`), marker);
});

test('postpublication host observer model-policy change remains canonical and prevents selected scheduler effects', async t => {
  const f = fixture(t, false, undefined, { coding: true }), request = await prepare(f);
  let changed = false;
  f.base.subscribe!(() => {
    const current = f.base.read();
    if (changed || (current.extensions.workflows as any)?.runs.length !== 2) return; changed = true;
    f.base.update({ agentDefinitions: { ...current.agentDefinitions, safe: { ...current.agentDefinitions.safe!, model: 'different/model' } } });
  });
  await f.control.workflowRecovery!.authorize(request);
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.control.getState().agentDefinitions.safe!.model, 'different/model');
  assert.equal(JSON.parse(readFileSync(f.snapshotFile, 'utf8')).state.agentDefinitions.safe.model, 'different/model');
  const child = (f.control.getState().extensions.workflows as any).runs[1] as WorkflowRun;
  assert.notEqual(child.status, 'running'); assert.match(child.error ?? child.steps[0]?.units[0]?.error ?? '', /agent definition\/policy changed/);
  assert.equal(child.admissions, 0); assert.deepEqual(readdirSync(f.stagingParent), []);
  assert.equal(Object.keys(f.control.getState().tasks).length, 0); assert.deepEqual(f.control.workflowApprovals!.inspect(), []);
  assert.equal(readFileSync(join(f.projectRoot, 'src/file.txt'), 'utf8'), 'old\n');
});

test('actual host requires all bounded fanout addresses including future unused slots, not only current input length', async t => {
  const f = fixture(t, false, undefined, { fanout: true }), before = readFileSync(f.snapshotFile);
  const projected = await f.control.execute({ action: 'workflows.recovery.prepare', workflowRunId: 'source', selections: { rerunUnitIds: ['read:0'] } });
  assert.equal(projected.ok, true); const assessment = (projected.data as any).assessment;
  assert.equal(assessment.plan.status, 'blocked'); assert.ok(assessment.blocked.includes('unselected-required-execution-address'));
  assert.deepEqual(assessment.plan.executionAddresses.map((row: any) => row.unitId), ['read:0', 'read:1', 'read:2']);
  assert.deepEqual(assessment.plan.recommendedSelections, { reuseUnitIds: [], rerunUnitIds: ['read:0', 'read:1', 'read:2'] });
  const request = await prepare(f); assert.deepEqual(request.selections.rerunUnitIds, ['read:0', 'read:1', 'read:2']);
  assert.notEqual(request.assessmentFingerprint, assessment.fingerprint);
  assert.deepEqual(readFileSync(f.snapshotFile), before); assert.equal(f.launches, 0);
});
