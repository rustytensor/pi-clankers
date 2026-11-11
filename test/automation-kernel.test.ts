import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { isDeepStrictEqual } from 'node:util';
import { createClankersState, createClankersStateContainer, snapshotClankersState, updateClankersState, seedBuiltinAgentDefinitions } from '../state.js';
import { createWorkflowService } from '../workflow-runtime.js';
import { createClankersControl } from '../index.js';
import { createClankersPersistenceManager, type ClankersPersistenceManager } from '../persistence.js';
import { createSealedWorkflowResourceLoader } from '../workflow-native-tools.js';
import { normalizeWorkflowAgent, validateWorkflowDefinition, workflowHash } from '../workflow-model.js';
import type { WorkflowRun, WorkflowState, WorkflowService, WorkflowServiceOptions, WorkflowNativePort } from '../workflow-model.js';
import type { AutomationProfileV1, AutomationRequestV1 } from '../automation-profile.js';
import { createAutomationLedger, validateAutomationLedger, lookupAutomationEvent, reserveAutomationEvent, projectAutomationEvent, pruneAutomationEvents, validateAutomationReservation } from '../automation-admission.js';

const time = Date.parse('2026-10-06T12:00:00.000Z');
const agent = normalizeWorkflowAgent({ id: 'reader', label: 'Reader', source: 'builtin', prompt: 'Read only', model: 'test/model:off', tools: ['read'], permissionMode: 'inherit' });
const definition = validateWorkflowDefinition({ id: 'daily', version: 1, label: 'Daily', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, steps: [
  { id: 'read', kind: 'native', dependsOn: [], agentId: agent.id, prompt: 'Read approved files', inputs: {}, outputSchema: { type: 'string', maxLength: 100 } },
] });
function profile(): AutomationProfileV1 {
  return { version: 1, id: 'daily', enabled: true, approvedProfileHash: 'a'.repeat(64), projectRoot: '/owned/project', snapshotFile: '/owned/state/snapshot.json', agentDir: '/owned/agent', sessionDir: '/owned/sessions', definition, definitionId: definition.id, definitionHash: workflowHash(definition), fixedInputs: {}, readPaths: ['input.txt'], agents: [agent], modelPolicy: { provider: 'test', id: 'model', thinkingLevel: 'off' }, credentialSourceRef: { kind: 'env', name: 'TEST_KEY' }, modelConfigFile: null,
    limits: { maxEventAgeMs: 300000, maxFutureSkewMs: 30000, minIntervalMs: 60000, maxRetainedEvents: 16, maxRunMs: 300000, maxCleanupMs: 10000, maxOutputBytes: 16384, maxReadBytes: 1048576, maxAdmissions: 64, maxProviderRequests: 128, concurrency: 1 } };
}
function request(at = time): AutomationRequestV1 { const occurrenceTime = new Date(at).toISOString(); return { version: 1, profileId: 'daily', eventId: occurrenceTime, occurrenceTime }; }
function fresh(id = 'fresh', at = time): WorkflowRun { return { workflowRunId: id, familyId: id, attemptNo: 1, definition, definitionHash: workflowHash(definition), inputs: {}, agents: { reader: agent }, concurrency: 1, status: 'running', createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(), admissions: 0, cleanupSettled: true, recovered: false, steps: [{ id: 'read', status: 'queued', units: [] }] }; }
function workflows(...runs: WorkflowRun[]): WorkflowState { return { version: 1, definitions: [definition], runs }; }
function reserve(id = 'fresh') { const p = profile(), run = fresh(id); return { p, run, ledger: reserveAutomationEvent(createAutomationLedger(p), p, request(), run, 'owner-generation', time) }; }

test('automation immutable strict data ledger and exact same-payload duplicates never reserve again', () => {
  const { p, run, ledger } = reserve();
  assert(Object.isFrozen(ledger)); assert(Object.isFrozen(ledger.events[0]));
  assert.equal(lookupAutomationEvent(ledger, p, request()).kind, 'duplicate');
  assert.throws(() => reserveAutomationEvent(ledger, p, request(), fresh('two'), 'next-owner', time), /duplicate/);
  assert.equal(projectAutomationEvent(ledger, workflows(run), p, request()).view!.workflowRunId, run.workflowRunId);
  for (const bad of [{ ...ledger, extra: true }, { ...ledger, events: [ledger.events[0], ledger.events[0]] }, { ...ledger, clockWatermark: NaN }, { ...ledger, namespace: 'b'.repeat(64) }]) assert.throws(() => validateAutomationLedger(bad));
  let read = false; assert.throws(() => validateAutomationLedger({ ...ledger, get injected() { read = true; return 1; } })); assert.equal(read, false);
  assert.throws(() => validateAutomationReservation(ledger, { ...ledger, events: [] }, fresh('two')), /append/);
});
test('generation/payload conflicts, missing attempt and attempt collision never masquerade as duplicate success', () => {
  const { p, ledger, run } = reserve();
  for (const changed of [{ ...p, approvedProfileHash: 'b'.repeat(64) }, { ...p, fixedInputs: { changed: true } }, { ...p, definitionHash: 'c'.repeat(64) }]) assert.equal(lookupAutomationEvent(ledger, changed, request()).kind, 'conflict');
  assert.throws(() => projectAutomationEvent(ledger, workflows(), p, request()), /missing/);
  assert.throws(() => projectAutomationEvent(ledger, workflows({ ...run, inputs: { changed: true } }), p, request()), /mismatch/);
  assert.throws(() => reserveAutomationEvent(ledger, p, request(time + 60000), fresh(), 'other', time + 60000), /binding/);
});
test('clock rollback, replay/future/rate/retention floors persist across pruning', () => {
  const { p, ledger, run } = reserve();
  assert.throws(() => reserveAutomationEvent(ledger, p, request(time + 1), fresh('two'), 'other', time - 1), /rollback/);
  assert.throws(() => reserveAutomationEvent(ledger, p, request(time + 1), fresh('two'), 'other', time + 1), /frequency/);
  assert.throws(() => reserveAutomationEvent(ledger, p, request(time + 1000000), fresh('two'), 'other', time + 60000), /future/);
  assert.throws(() => reserveAutomationEvent(ledger, { ...p, limits: { ...p.limits, maxRetainedEvents: 1 } }, request(time + 60000), fresh('two'), 'other', time + 60000), /full/);
  run.status = 'failed'; run.steps[0].status = 'failed';
  const pruned = pruneAutomationEvents(ledger, workflows(run), p, time + 400000);
  assert.deepEqual(pruned.removedWorkflowRunIds, ['fresh']); assert.equal(pruned.ledger.lastAcceptedAt, time); assert.equal(pruned.ledger.lastOccurrence, time); assert.equal(pruned.ledger.rejectBefore, time);
  assert.equal(pruned.workflows.runs.length, 0);
  assert.throws(() => reserveAutomationEvent(pruned.ledger, p, request(), fresh('two'), 'other', time + 400000), /expired/);
  assert.throws(() => reserveAutomationEvent(pruned.ledger, p, request(time + 400000), fresh('two'), 'other', time + 399999), /rollback/);
});
test('pruning retains active, uncertain, needs-attention and referenced evidence', () => {
  for (const variant of ['active', 'uncertain', 'attention', 'referenced']) {
    const { p, ledger, run } = reserve(); run.status = variant === 'active' ? 'running' : variant === 'attention' ? 'needs-attention' : 'failed';
    run.cleanupSettled = variant !== 'uncertain';
    const state = workflows(run); if (variant === 'referenced') state.runs.push({ ...fresh('two'), retryOf: 'fresh' });
    const projected = pruneAutomationEvents(ledger, state, p, time + 400000);
    assert.equal(projected.ledger.events.length, 1); assert.equal(projected.removedWorkflowRunIds.length, 0);
  }
});
function harness(options: WorkflowServiceOptions = {}) {
  const p = profile(), base = createClankersStateContainer({ agentDefinitions: { reader: agent } });
  const snapshots: ReturnType<typeof base.snapshot>[] = [];
  let calls = 0, ids = 0;
  const port: WorkflowNativePort = { preflight() {}, async execute(req) { calls++; req.assertAdmission(); const identity = { runId: `native-${calls}`, taskId: `task-${calls}` }; req.onIdentity(identity); return { status: 'completed', text: '"ok"', identity, cleanupSettled: true }; } };
  base.subscribe?.(s => { snapshots.push(s); });
  let service: WorkflowService;
  const reservation = (run: Readonly<WorkflowRun>) => {
    assert(Object.isFrozen(run)); assert(Object.isFrozen(run.definition)); assert(Object.isFrozen(run.steps));
    return reserveAutomationEvent((base.read().extensions.automation as never) ?? createAutomationLedger(p), p, request(), run, 'owner-generation', time);
  };
  service = createWorkflowService(base, port, { now: () => new Date(time), idFactory: () => `workflow-${++ids}`, onStartReservation: reservation, ...options });
  return { p, base, snapshots, service, reservation, calls: () => calls };
}
async function define(h: ReturnType<typeof harness>) { assert.equal((await h.service.execute({ action: 'workflows.define', definition })).ok, true); }
async function start(h: ReturnType<typeof harness>, signal?: AbortSignal) { return h.service.execute({ action: 'workflows.start', definitionId: definition.id, inputs: {}, concurrency: 1 }, signal); }

test('fresh exact reservation and workflow are one preschedule publication; cap no-refund still uses shared scheduler', async () => {
  const h = harness({ maxAdmissions: 1 }); await define(h);
  const result = await start(h); assert.equal(result.ok, true, result.error); await h.service.drain();
  const first = h.snapshots.find(s => (s.extensions.workflows as WorkflowState)?.runs.length)!;
  const ledger = validateAutomationLedger(first.extensions.automation); const run = (first.extensions.workflows as WorkflowState).runs[0];
  assert.equal(ledger.events[0].workflowRunId, run.workflowRunId); assert.equal(run.admissions, 0);
  assert.equal(h.calls(), 1); assert.equal(h.service.get(run.workflowRunId)!.status, 'completed'); h.service.dispose();
});
test('reservation callback receives frozen copy; mutation/Promise/arbitrary patches fail before native execution', async () => {
  for (const hook of [(run: Readonly<WorkflowRun>) => { (run as WorkflowRun).workflowRunId = 'changed'; }, () => Promise.resolve({}), () => ({ extensions: { permissions: true } })]) {
    const h = harness({ onStartReservation: hook }); await define(h); const result = await start(h);
    assert.equal(result.ok, false); await assert.rejects(h.service.drain()); assert.equal(h.calls(), 0); h.service.dispose();
  }
});
test('clock/hook/listener cancellation, readonly, disposal and ledger replacement all close preschedule admission', async () => {
  for (const seam of ['clock', 'hook', 'listener']) for (const revocation of ['caller', 'readonly', 'dispose', 'ledger']) {
    const caller = new AbortController(); let armed = false, fired = false;
    let h: ReturnType<typeof harness>;
    const revoke = () => {
      if (!armed || fired) return; fired = true;
      if (revocation === 'caller') caller.abort();
      if (revocation === 'readonly') h.base.update({ mode: { ...h.base.read().mode, readOnly: true } });
      if (revocation === 'dispose') h.service.dispose();
      if (revocation === 'ledger') h.base.update({ extensions: { ...h.base.read().extensions, workflows: { version: 1, definitions: [], runs: [] } } });
    };
    h = harness({ now: () => { if (seam === 'clock') revoke(); return new Date(time); }, onStartReservation: run => { const ledger = h.reservation(run); if (seam === 'hook') revoke(); return ledger; } });
    await define(h);
    if (seam === 'listener') h.base.subscribe?.(s => { if ((s.extensions.workflows as WorkflowState)?.runs.length) revoke(); });
    armed = true; const result = await start(h, caller.signal); assert.equal(fired, true, `${seam}/${revocation}`); assert.equal(result.ok, false, `${seam}/${revocation}`);
    await h.service.drain().catch(() => undefined); assert.equal(h.calls(), 0, `${seam}/${revocation}`); h.service.dispose();
  }
});
test('uncertain publication poisons reservation even when container published then threw', async () => {
  const h = harness(); await define(h);
  const update = h.base.update.bind(h.base);
  h.base.update = (...args) => { const next = update(...args); if ((next.extensions.workflows as WorkflowState).runs.length) throw new Error('after-publication uncertainty'); return next; };
  const result = await start(h); assert.equal(result.ok, false); assert.equal(validateAutomationLedger(h.base.read().extensions.automation).events.length, 1);
  await assert.rejects(h.service.drain(), /uncertain/); assert.equal(h.calls(), 0); assert.equal((await start(h)).ok, false); h.service.dispose();
});
test('native lower admission cap rejects further units without granting refunds', async () => {
  const h = harness({ maxAdmissions: 1, onStartReservation: undefined });
  const two = validateWorkflowDefinition({ ...definition, steps: [definition.steps[0], { ...definition.steps[0], id: 'second' }] });
  assert.equal((await h.service.execute({ action: 'workflows.define', definition: two })).ok, true);
  const result = await start(h); assert.equal(result.ok, true); await h.service.drain();
  assert.equal(h.calls(), 1); assert.equal(h.service.get(result.view!.workflowRunId)!.admissions, 1); assert.equal(h.service.get(result.view!.workflowRunId)!.status, 'failed'); h.service.dispose();
  for (const maxAdmissions of [0, 257, 1.5, NaN]) assert.throws(() => harness({ maxAdmissions }), /cap/);
});
test('prepared same persistence manager requires acquisition before construction, never rehydrates or auto releases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'automation-kernel-'));
  try {
    const manager = createClankersPersistenceManager({ snapshotFile: join(dir, 'state.json') })!;
    const container = createClankersStateContainer(); manager.hydrate(container);
    assert.throws(() => createClankersControl(container, { persistenceManager: manager }), /prepared|generation/i);
    const owner = manager.acquireRecoveryOwnership!({ expectedSnapshotHash: manager.inspectRecoveryOwnership!().actualSnapshotHash }).owner;
    let hydration = 0; const original = manager.hydrate.bind(manager); manager.hydrate = (...args) => { hydration++; return original(...args); };
    const control = createClankersControl(container, { persistenceManager: manager }); assert.equal(hydration, 0);
    control.dispose(); assert.equal(manager.inspectRecoveryOwnership!().owner?.generation, owner.generation);
    manager.releaseRecoveryOwnership!(owner);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

/** Private seam tests use EXACT staged source functions with fake public SDK objects.
 * No provider/session/process acceptance claim and no exported testing backdoor. */
function nativeFactory() {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names = new Set(['createPiNativeSession', 'assertWorkflowSession', 'cleanupWorkflowSession', 'splitModelAndThinking', 'resolvePiNativeModel', 'resolvePiNativeToolPolicy', 'expandPiNativeToolAlias', 'createPiNativeSystemPrompt', 'workflowFailure']);
  const declarations = ast.statements.filter(n => ts.isFunctionDeclaration(n) && n.name && names.has(n.name.text));
  assert.equal(declarations.length, names.size);
  const js = ts.transpileModule(declarations.map(n => n.getText(ast).replaceAll('import.meta.url', JSON.stringify(new URL('../index.ts', import.meta.url).href))).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function('createSealedWorkflowResourceLoader', 'fileURLToPath', 'dirname', 'resolvePath', 'LARRA_NATIVE_TOOL_NAMES', `${js}\nreturn Object.assign(createPiNativeSession, { assertWorkflowSession });`)(createSealedWorkflowResourceLoader, fileURLToPath, dirname, resolve, []) as (...args: any[]) => Promise<any>;
}
function fakeSdk(thinking = 'off') {
  let opts: any, prepCalls = 0; const operations: any[] = [];
  const session: any = { model: { provider: 'test', id: 'model' }, thinkingLevel: thinking, agent: { prepareRequest: async () => { prepCalls++; }, onPayload: async () => undefined, beforeToolCall: async () => undefined }, getActiveToolNames: () => ['read'], getAllTools: () => [{ name: 'read', sourceInfo: { source: 'sdk', path: '<sdk:read>' } }], getToolDefinition: () => opts.customTools[0], abort: async () => {}, waitForIdle: async () => {}, extensionRunner: { onError: () => () => {}, emit: async () => {} }, dispose: () => {} };
  const sdk: any = { getAgentDir() { throw new Error('Global agent discovery forbidden'); }, ModelRuntime: { create() { throw new Error('Global model discovery forbidden'); } }, SettingsManager: { create() { throw new Error('Disk settings forbidden'); }, inMemory: () => ({ applyOverrides() {} }) }, SessionManager: { create: (cwd: string, sessionDir: string) => ({ cwd, sessionDir }) }, createExtensionRuntime: () => ({}), createReadToolDefinition: (_cwd: string, options: any) => { operations.push(options.operations); return { name: 'read', description: '', execute: () => {} }; }, createAgentSession: async (options: any) => { opts = options; return { session }; } };
  return { sdk, session, operations, getOpts: () => opts, prepCalls: () => prepCalls };
}
function nativeAdmission() {
  let allowed = true, providers = 0, reads = 0;
  const admission: any = { request: { agent }, tools: ['read'], aborts: [], failures: [], cleanupSettled: true, assert() { if (!allowed) throw new Error('revoked'); }, automation: { cwd: '/owned/project', agentDir: '/owned/agent', sessionDir: '/owned/sessions', expectedThinkingLevel: 'off', preflightedModelRuntime: { getAvailable: async () => [{ provider: 'test', id: 'model' }] }, assertPolicy() {}, beforeProviderRequest() { providers++; }, scopedAccess(path: string) { if (path !== '/owned/project/input.txt') throw new Error('scope'); }, scopedRead(path: string) { if (path !== '/owned/project/input.txt') throw new Error('scope'); reads++; return 'approved text'; } } };
  return { admission, revoke: () => { allowed = false; }, providers: () => providers, reads: () => reads };
}
test('automation native uses explicit runtime/paths/in-memory settings/sealed resources and true custom read origin', async () => {
  const factory = nativeFactory(), sdk = fakeSdk(), h = nativeAdmission();
  await factory(sdk.sdk, agent, 'task', h.admission.automation.cwd, agent.model, undefined, h.admission);
  const opts = sdk.getOpts(); assert.equal(opts.modelRuntime, h.admission.automation.preflightedModelRuntime); assert.equal(opts.agentDir, '/owned/agent'); assert.equal(opts.sessionManager.sessionDir, '/owned/sessions'); assert.deepEqual(opts.tools, ['read']);
  assert.deepEqual(opts.resourceLoader.getAgentsFiles(), { agentsFiles: [] }); assert.equal(opts.resourceLoader.getExtensions().extensions.length, 0); assert.equal(opts.resourceLoader.getSkills().skills.length, 0);
  await assert.rejects(sdk.operations[0].access('/secrets'), /scope/); assert.equal((await sdk.operations[0].readFile('/owned/project/input.txt')).toString(), 'approved text');
  assert.equal(await sdk.operations[0].detectImageMimeType('/secrets'), undefined);
  await sdk.session.agent.prepareRequest({ model: sdk.session.model, thinkingLevel: 'off' }); assert.equal(h.providers(), 1); assert.equal(sdk.prepCalls(), 1);
  sdk.session.getAllTools = () => [{ name: 'read', sourceInfo: { source: 'builtin', path: 'builtin:read' } }];
  await assert.rejects(sdk.session.agent.beforeToolCall({ toolCall: { name: 'read' } }), /custom read/);
});
test('SDK thinking normalization and every provider/tool model/thinking/revocation guard fail closed', async () => {
  const factory = nativeFactory();
  const mismatch = fakeSdk('low'), first = nativeAdmission();
  await assert.rejects(factory(mismatch.sdk, agent, 'task', '/owned/project', agent.model, undefined, first.admission), /thinking/);
  for (const change of ['thinking', 'model', 'definition', 'provider-hook', 'read-hook']) {
    const sdk = fakeSdk(), h = nativeAdmission(); await factory(sdk.sdk, agent, 'task', '/owned/project', agent.model, undefined, h.admission);
    if (change === 'thinking') sdk.session.thinkingLevel = 'high';
    if (change === 'model') sdk.session.model = { provider: 'other', id: 'model' };
    if (change === 'definition') sdk.session.getToolDefinition = () => ({ name: 'read' });
    if (change === 'provider-hook') h.admission.automation.beforeProviderRequest = h.revoke;
    if (change === 'read-hook') { h.admission.automation.scopedRead = () => { h.revoke(); return 'must not escape'; }; await assert.rejects(sdk.operations[0].readFile('/owned/project/input.txt'), /revoked/); }
    await assert.rejects(sdk.session.agent.prepareRequest({ model: sdk.session.model, thinkingLevel: 'off' })); assert.equal(sdk.prepCalls(), 0);
    await assert.rejects(sdk.session.agent.beforeToolCall({ toolCall: { name: 'read' } }));
  }
});

test('real owned persistence commits exact event and attempt together before fake native; failed commit never executes', async () => {
  for (const failure of ['none', 'before', 'after']) {
    const dir = mkdtempSync(join(tmpdir(), 'automation-atomic-'));
    try {
      const p = profile(), base = createClankersStateContainer({ agentDefinitions: { reader: agent } });
      const manager = createClankersPersistenceManager({ snapshotFile: join(dir, 'state.json') })!; manager.hydrate(base);
      const owner = manager.acquireRecoveryOwnership!({ expectedSnapshotHash: manager.inspectRecoveryOwnership!().actualSnapshotHash }).owner;
      let attempts = 0, calls = 0; const update = base.update.bind(base);
      base.update = (...args) => {
        const projected = createClankersStateContainer(base.snapshot()); const next = projected.update(...args);
        const firstAttempt = (next.extensions.workflows as WorkflowState).runs[0];
        const reservation = !!firstAttempt && !(base.read().extensions.workflows as WorkflowState).runs.length;
        if (reservation) {
          attempts++; assert.equal(calls, 0); validateAutomationLedger(next.extensions.automation, next.extensions.workflows as WorkflowState);
          if (failure === 'before') throw new Error('injected before durable publication');
        }
        manager.save(next);
        if (reservation && failure === 'after') throw new Error('injected uncertain after durable publication');
        return update(...args);
      };
      const service = createWorkflowService(base, { preflight() {}, async execute(req) {
        calls++; const persisted = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
        const serialized = JSON.stringify(persisted); assert(serialized.includes(req.workflowRunId)); assert(serialized.includes('owner-generation'));
        const identity = { runId: 'native', taskId: 'task' }; req.onIdentity(identity); return { status: 'completed', text: '"ok"', identity, cleanupSettled: true };
      } }, { now: () => new Date(time), idFactory: () => 'one', onStartReservation: run => reserveAutomationEvent(createAutomationLedger(p), p, request(), run, 'owner-generation', time) });
      await service.execute({ action: 'workflows.define', definition });
      const result = await service.execute({ action: 'workflows.start', definitionId: definition.id, inputs: {}, concurrency: 1 });
      assert.equal(result.ok, failure === 'none', result.error); await service.drain().catch(() => undefined);
      assert.equal(attempts, 1); assert.equal(calls, failure === 'none' ? 1 : 0);
      if (failure === 'after') assert(JSON.stringify(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))).includes('owner-generation'));
      service.dispose(); manager.releaseRecoveryOwnership!(owner); // Test-only isolated manager; not a production uncertainty release policy.
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
test('automation snapshot validation checks every binding, not just requested duplicate', () => {
  const { p, ledger, run } = reserve();
  const second = reserveAutomationEvent(ledger, p, request(time + 60000), fresh('two'), 'owner-two', time + 60000);
  assert.throws(() => validateAutomationLedger(second, workflows(run)), /missing/);
  assert.equal(validateAutomationLedger(second, workflows(run, fresh('two'))).events.length, 2);
});
test('native request preparation budget rejects before underlying SDK preparation and cleanup failure stays unknown', async () => {
  const sdk = fakeSdk(), h = nativeAdmission(); let requests = 0;
  h.admission.automation.beforeProviderRequest = () => { if (++requests > 1) throw new Error('provider-preparation cap'); };
  await nativeFactory()(sdk.sdk, agent, 'task', '/owned/project', agent.model, undefined, h.admission);
  await sdk.session.agent.prepareRequest({ model: sdk.session.model, thinkingLevel: 'off' });
  await assert.rejects(sdk.session.agent.prepareRequest({ model: sdk.session.model, thinkingLevel: 'off' }), /cap/); assert.equal(sdk.prepCalls(), 1);
  const broken = fakeSdk('low'), other = nativeAdmission(); let disposed = false;
  broken.session.abort = async () => { throw new Error('abort failed'); }; broken.session.dispose = () => { disposed = true; };
  await assert.rejects(nativeFactory()(broken.sdk, agent, 'task', '/owned/project', agent.model, undefined, other.admission), /thinking/);
  assert.equal(disposed, true); assert.equal(other.admission.cleanupSettled, false); assert(other.admission.failures.includes('abort failed'));
});

test('prepared thinking drift is rejected even when session thinking remains exact; canonical builtin guard is unchanged', async () => {
  const factory = nativeFactory() as any, sdk = fakeSdk(), h = nativeAdmission();
  sdk.session.agent.prepareRequest = async () => ({ thinkingLevel: 'high' });
  await factory(sdk.sdk, agent, 'task', '/owned/project', agent.model, undefined, h.admission);
  await assert.rejects(sdk.session.agent.prepareRequest({ model: sdk.session.model, thinkingLevel: 'off' }), /routed thinking/);
  const ordinary = { ...h.admission, automation: undefined, automationRead: undefined };
  assert.throws(() => factory.assertWorkflowSession(ordinary, sdk.session), /original SDK builtin/);
  sdk.session.getAllTools = () => [{ name: 'read', sourceInfo: { source: 'builtin', path: 'builtin:read' } }];
  assert.doesNotThrow(() => factory.assertWorkflowSession(ordinary, sdk.session));
});

test('prepared control refuses clock-reentrant release instead of falling back to an unowned generic save', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'automation-owner-clock-'));
  try {
    const manager = createClankersPersistenceManager({ snapshotFile: join(dir, 'state.json') })!;
    const container = createClankersStateContainer(); manager.hydrate(container);
    const owner = manager.acquireRecoveryOwnership!({ expectedSnapshotHash: manager.inspectRecoveryOwnership!().actualSnapshotHash }).owner;
    let armed = false, fired = false, saves = 0;
    const original = manager.save.bind(manager); manager.save = (...args) => { const result = original(...args); saves++; return result; };
    const control = createClankersControl(container, { persistenceManager: manager, now: () => {
      if (armed && !fired) { fired = true; manager.releaseRecoveryOwnership!(owner); }
      return new Date(time);
    } });
    let before: string | undefined; try { before = readFileSync(join(dir, 'state.json'), 'utf8'); } catch { /* The prepared control may not have initialized any metadata yet. */ }
    saves = 0; armed = true;
    const result = await control.execute({ action: 'workflows.define', definition }).catch(() => ({ ok: false }));
    assert.equal(fired, true); assert.equal(result.ok, false); assert.equal(saves, 0);
    if (before === undefined) assert.throws(() => readFileSync(join(dir, 'state.json')), { code: 'ENOENT' });
    else assert.equal(readFileSync(join(dir, 'state.json'), 'utf8'), before);
    control.dispose();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Exact production constructor prefix + recovery builder: no replacement owner guard.
function preparedWriterFixture(base: ReturnType<typeof createClankersStateContainer>, manager: ClankersPersistenceManager, associated?: ClankersPersistenceManager) {
  const source = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.ES2022, true);
  const fn = (name: string) => {
    const node = ast.statements.find((n): n is ts.FunctionDeclaration => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.ok(node, `Missing actual ${name}`); return node;
  };
  const statements = [...fn('createClankersControl').body!.statements];
  const end = statements.findIndex(n => ts.isVariableStatement(n) && n.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text === 'nativeTranscriptService'));
  assert.ok(end > 0);
  const ownedPersistenceManagers = new WeakMap(); if (associated) ownedPersistenceManagers.set(base, associated);
  const dependencies = { createClankersStateContainer, createClankersState, seedBuiltinAgentDefinitions, createClankersPersistenceManager, snapshotClankersState, updateClankersState, isDeepStrictEqual,
    ownedPersistenceManagers, recoveryPublications: new WeakMap(), recoveryWriterIdleChecks: new WeakMap(), inspectPreviousWorkflowOwner: () => 'unknown' };
  const text = ['isClankersStateContainer', 'inspectStartupRecoveryBlock', 'buildWorkflowRecoveryOptions'].map(name => fn(name).getText(ast)).join('\n')
    + '\n' + statements.slice(0, end).map(n => n.getText(ast)).join('\n')
    + '\nreturn { container, port: (isDisposed, onWriter) => buildWorkflowRecoveryOptions(options, persistenceManager, container, isDisposed, onWriter, preparedOwner ? () => assertPreparedOwner()! : undefined).durablePort };';
  const js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function('stateOrContainer', 'options', ...Object.keys(dependencies), js)(base, { persistenceManager: manager, recovery: { enabled: true } }, ...Object.values(dependencies)) as {
    container: ReturnType<typeof createClankersStateContainer>;
    port(isDisposed: () => boolean, onWriter: (owner: unknown) => void): NonNullable<NonNullable<WorkflowServiceOptions['recovery']>['durablePort']>;
  };
}
function preparedDisk(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'automation-prepared-cp-')), snapshotFile = join(dir, 'state.json');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = createClankersStateContainer(), manager = createClankersPersistenceManager({ snapshotFile })!;
  manager.hydrate(base); manager.save(base.read());
  const owner = manager.acquireRecoveryOwnership!({ expectedSnapshotHash: manager.inspectRecoveryOwnership!().actualSnapshotHash }).owner;
  const acquire = manager.acquireRecoveryOwnership!.bind(manager), release = manager.releaseRecoveryOwnership!.bind(manager), save = manager.save.bind(manager);
  let acquisitions = 0, releases = 0, saves = 0;
  manager.acquireRecoveryOwnership = (...args) => { acquisitions++; return acquire(...args); };
  manager.releaseRecoveryOwnership = (...args) => { releases++; return release(...args); };
  manager.save = (...args) => { saves++; return save(...args); };
  return { base, manager, owner, snapshotFile, releaseExternally: () => release(owner), get counts() { return { acquisitions, releases, saves }; } };
}

test('prepared producer verify-only port never acquires/releases and refuses recovery acquisition after owner loss', t => {
  const f = preparedDisk(t), extracted = preparedWriterFixture(f.base, f.manager); let notified = 0;
  const port = extracted.port(() => false, owner => { notified++; assert.deepEqual(owner, f.owner); });
  const before = readFileSync(f.snapshotFile);
  assert.deepEqual(port.ensureWriter(), f.owner); assert.deepEqual(port.ensureWriter(), f.owner); assert.equal(notified, 2);
  assert.throws(() => port.acquireWriter!({ expectedSnapshotHash: f.manager.inspectRecoveryOwnership!().actualSnapshotHash! }), /cannot acquire/);
  assert.deepEqual(f.counts, { acquisitions: 0, releases: 0, saves: 0 }); assert.deepEqual(readFileSync(f.snapshotFile), before);
  f.releaseExternally(); // Deliberate test revocation, not core release.
  assert.throws(() => port.ensureWriter(), /owner\/head changed/);
  assert.throws(() => port.acquireWriter!({ expectedSnapshotHash: f.manager.inspectRecoveryOwnership!().actualSnapshotHash! }), /cannot acquire/);
  assert.equal(notified, 2); assert.deepEqual(f.counts, { acquisitions: 0, releases: 0, saves: 0 });
});

test('prepared producer rejects missing/foreign generation, incoherent head and callbacks before any writer effect', t => {
  for (const seam of ['before', 'notification'] as const) for (const revoke of ['readonly', 'disposed', 'generation', 'head', 'canonical', 'lost-owner'] as const) {
    const f = preparedDisk(t), extracted = preparedWriterFixture(f.base, f.manager); let disposed = false, notified = 0;
    const mutation = () => {
      if (revoke === 'readonly') f.base.update({ mode: { ...f.base.read().mode, readOnly: true } });
      if (revoke === 'disposed') disposed = true;
      if (revoke === 'generation') {
        const file = `${f.snapshotFile}.recovery-writer.lock/owner.json`, marker = JSON.parse(readFileSync(file, 'utf8'));
        marker.owner.generation = 'foreign-generation'; writeFileSync(file, JSON.stringify(marker));
      }
      if (revoke === 'head') writeFileSync(f.snapshotFile, readFileSync(f.snapshotFile, 'utf8') + '\n');
      if (revoke === 'canonical') f.base.update({ selectedNodeId: 'changed' });
      if (revoke === 'lost-owner') f.releaseExternally();
    };
    const port = extracted.port(() => disposed, () => { notified++; if (seam === 'notification') mutation(); });
    if (seam === 'before') mutation();
    // A pre-existing ordinary canonical selection is not a revocation; only callback drift is.
    if (seam === 'before' && revoke === 'canonical') assert.deepEqual(port.ensureWriter(), f.owner);
    else assert.throws(() => port.ensureWriter(), /read-only|disposed|owner\/head changed|canonical state changed/, `${seam}/${revoke}`);
    assert.equal(notified, seam === 'notification' || revoke === 'canonical' ? 1 : 0);
    assert.deepEqual(f.counts, { acquisitions: 0, releases: 0, saves: 0 }, `${seam}/${revoke}`);
  }
});

test('prepared notification cannot advance a coherent manager head or dispose through inspection unnoticed', t => {
  const f = preparedDisk(t), extracted = preparedWriterFixture(f.base, f.manager);
  const port = extracted.port(() => false, () => { f.manager.save(f.base.read(), () => new Date(time)); });
  assert.throws(() => port.ensureWriter(), /head changed during notification/);
  assert.deepEqual(f.counts, { acquisitions: 0, releases: 0, saves: 1 }, 'only the injected callback wrote');
  const g = preparedDisk(t), second = preparedWriterFixture(g.base, g.manager); let disposed = false, notified = 0;
  const inspect = g.manager.inspectRecoveryOwnership!.bind(g.manager);
  g.manager.inspectRecoveryOwnership = () => { const result = inspect(); disposed = true; return result; };
  assert.throws(() => second.port(() => disposed, () => { notified++; }).ensureWriter(), /disposed/);
  assert.equal(notified, 0); assert.deepEqual(g.counts, { acquisitions: 0, releases: 0, saves: 0 });
});

test('prepared construction rejects mixed options, associated wrappers, incoherent head and startup-clock ownership loss', t => {
  const f = preparedDisk(t);
  assert.throws(() => createClankersControl(f.base, { persistenceManager: f.manager, persistence: { snapshotFile: f.snapshotFile } }), /conflicts/);
  assert.throws(() => preparedWriterFixture(f.base, f.manager, f.manager), /associated wrapper/);
  const foreign = createClankersPersistenceManager({ snapshotFile: f.snapshotFile })!;
  assert.throws(() => preparedWriterFixture(f.base, f.manager, foreign), /associated wrapper/);
  assert.deepEqual(f.counts, { acquisitions: 0, releases: 0, saves: 0 });
  writeFileSync(f.snapshotFile, readFileSync(f.snapshotFile, 'utf8') + '\n');
  assert.throws(() => createClankersControl(f.base, { persistenceManager: f.manager }), /coherent generation/);
  const g = preparedDisk(t);
  assert.throws(() => createClankersControl(g.base, { persistenceManager: g.manager, now: () => { g.releaseExternally(); return new Date(time); } }), /owner\/head changed/);
  assert.deepEqual(g.counts, { acquisitions: 0, releases: 0, saves: 0 });
});

test('public prepared control can produce inert CP and reserve in one commit; external owner alone releases last', async t => {
  const f = preparedDisk(t);
  const publications: WorkflowRun[] = [], save = f.manager.save.bind(f.manager);
  f.manager.save = (state, now) => {
    const run = (state.extensions.workflows as WorkflowState | undefined)?.runs[0];
    if (run) { validateAutomationLedger(state.extensions.automation, state.extensions.workflows as WorkflowState); publications.push(structuredClone(run)); }
    return save(state, now);
  };
  const aggregate = validateWorkflowDefinition({ ...definition, steps: [{ id: 'collect', kind: 'aggregate', operation: 'collect', dependsOn: [], inputs: {} }] });
  const p = { ...profile(), definition: aggregate, definitionHash: workflowHash(aggregate), agents: [] };
  let reservations = 0, launches = 0;
  const control = createClankersControl(f.base, { persistenceManager: f.manager, recovery: { enabled: true }, now: () => new Date(time),
    subagentAdapter: { kind: 'fake', launch() { launches++; throw new Error('No native/session effect allowed'); } },
    trustedWorkflow: { assertAdmission() {}, onStartReservation(run) {
      reservations++; assert.ok(run.recovery); assert.equal(run.recovery.selection, undefined); assert.equal(run.recovery.origin, undefined);
      return reserveAutomationEvent(createAutomationLedger(p), p, request(), run, f.owner.generation, time);
    } },
  });
  assert.equal((await control.execute({ action: 'workflows.define', definition: aggregate })).ok, true);
  const result = await control.execute({ action: 'workflows.start', definitionId: aggregate.id, inputs: {}, concurrency: 1 });
  assert.equal(result.ok, true, result.error?.message); await control.drain!();
  const state = control.getState(), runs = (state.extensions.workflows as WorkflowState).runs;
  assert.equal(runs.length, 1); assert.equal(runs[0].status, 'completed'); assert.ok(runs[0].recovery);
  assert.equal(runs[0].cleanupSettled, true); assert.equal(reservations, 1); assert.equal(launches, 0);
  validateAutomationLedger(state.extensions.automation, state.extensions.workflows as WorkflowState);
  const saved = JSON.parse(readFileSync(f.snapshotFile, 'utf8')).state;
  assert.deepEqual(saved.extensions.workflows, state.extensions.workflows);
  assert.deepEqual(saved.extensions.automation, state.extensions.automation);
  assert.ok(publications[0].recovery); assert.equal(publications[0].status, 'running'); assert.equal(publications[0].admissions, 0);
  control.dispose(); await control.drain!();
  assert.equal(f.counts.acquisitions, 0); assert.equal(f.counts.releases, 0); assert.equal(f.manager.inspectRecoveryOwnership!().owner?.generation, f.owner.generation);
  f.manager.save(control.getState(), () => new Date(time)); f.manager.releaseRecoveryOwnership!(f.owner);
  assert.equal(f.counts.releases, 1); assert.equal(f.manager.inspectRecoveryOwnership!().ownerValid, false);
});

test('automation access is non-consuming: exact-budget text delivers once and repeat reads remain charged', async () => {
  const sdk = fakeSdk(), h = nativeAdmission(); let accesses = 0, bytes = 0, reads = 0;
  h.admission.automation.scopedAccess = (path: string) => { assert.equal(path, '/owned/project/input.txt'); accesses++; };
  h.admission.automation.scopedRead = (path: string) => {
    assert.equal(path, '/owned/project/input.txt'); reads++;
    if (bytes + 3 > 3) throw new Error('cumulative read cap'); bytes += 3; return 'abc';
  };
  await nativeFactory()(sdk.sdk, agent, 'task', '/owned/project', agent.model, undefined, h.admission);
  const operations = sdk.operations[0], path = '/owned/project/input.txt';
  await operations.access(path); await operations.access(path); assert.equal(accesses, 2); assert.equal(reads, 0); assert.equal(bytes, 0);
  assert.equal((await operations.readFile(path)).toString(), 'abc'); assert.equal(bytes, 3); assert.equal(reads, 1);
  await operations.access(path); assert.equal(bytes, 3);
  await assert.rejects(operations.readFile(path), /cumulative read cap/); assert.equal(reads, 2); assert.equal(bytes, 3);
});

test('automation access rejects callback revocation, promises and missing scope without consuming text', async () => {
  for (const kind of ['revoke', 'promise', 'missing'] as const) {
    const sdk = fakeSdk(), h = nativeAdmission();
    h.admission.automation.scopedAccess = kind === 'revoke' ? h.revoke : kind === 'promise' ? () => Promise.resolve() : undefined;
    await nativeFactory()(sdk.sdk, agent, 'task', '/owned/project', agent.model, undefined, h.admission);
    await assert.rejects(sdk.operations[0].access('/owned/project/input.txt'));
    assert.equal(h.reads(), 0);
  }
});

test('prepared producer start rechecks clock cancellation/readOnly/disposal before reservation and never reacquires', async t => {
  for (const revoke of ['caller', 'readonly', 'dispose', 'lost-owner'] as const) {
    const f = preparedDisk(t), caller = new AbortController(); let armed = false, fired = false, reservations = 0;
    const aggregate = validateWorkflowDefinition({ ...definition, steps: [{ id: 'collect', kind: 'aggregate', operation: 'collect', dependsOn: [], inputs: {} }] });
    const p = { ...profile(), definition: aggregate, definitionHash: workflowHash(aggregate), agents: [] };
    const control = createClankersControl(f.base, { persistenceManager: f.manager, recovery: { enabled: true },
      subagentAdapter: { kind: 'fake', launch() { throw new Error('No native effect'); } },
      now: () => {
        if (armed && !fired) {
          fired = true;
          if (revoke === 'caller') caller.abort();
          if (revoke === 'readonly') f.base.update({ mode: { ...f.base.read().mode, readOnly: true } });
          if (revoke === 'dispose') control.dispose();
          if (revoke === 'lost-owner') f.releaseExternally();
        }
        return new Date(time);
      },
      trustedWorkflow: { assertAdmission() {}, onStartReservation(run) { reservations++; return reserveAutomationEvent(createAutomationLedger(p), p, request(), run, f.owner.generation, time); } },
    });
    assert.equal((await control.execute({ action: 'workflows.define', definition: aggregate })).ok, true);
    const before = readFileSync(f.snapshotFile); armed = true;
    const result = await control.execute({ action: 'workflows.start', definitionId: aggregate.id, inputs: {}, concurrency: 1 }, caller.signal);
    assert.equal(fired, true, revoke); assert.equal(result.ok, false, revoke); assert.equal(reservations, 0, revoke);
    assert.deepEqual(readFileSync(f.snapshotFile), before, revoke);
    assert.equal((control.getState().extensions.workflows as WorkflowState).runs.length, 0);
    assert.equal(f.counts.acquisitions, 0); assert.equal(f.counts.releases, 0); control.dispose();
  }
});
