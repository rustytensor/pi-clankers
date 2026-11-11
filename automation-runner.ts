import { randomUUID, createHash } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readlinkSync, mkdirSync, writeFileSync, fsyncSync, unlinkSync, lstatSync, readSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createClankersControl } from './index.js';
import { createClankersPersistenceManager } from './persistence.js';
import type { ClankersPersistenceManager, RecoveryWriterOwnerEvidence } from './persistence.js';
import { createClankersState, createClankersStateContainer } from './state.js';
import type { ClankersControl, ClankersState } from './types.js';
import { workflowHash, workflowView } from './workflow-model.js';
import { recoverWorkflowState } from './workflow-runtime.js';
import type { WorkflowState, WorkflowRun, WorkflowView, WorkflowReply } from './workflow-model.js';
import { loadAutomationProfile, validateAutomationRequest, createAutomationProfileIdentityGuard,
  scopedReadAutomationPath } from './automation-profile.js';
import type { AutomationRequestV1, AutomationProfileV1, AutomationProfileIdentityGuard, AutomationResultV1 } from './automation-profile.js';
import { createAutomationLedger, validateAutomationLedger, reserveAutomationEvent,
  projectAutomationEvent, pruneAutomationEvents } from './automation-admission.js';
import type { AutomationLedgerV1 } from './automation-admission.js';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

const terminal = (view: WorkflowView) => ['completed', 'failed', 'cancelled', 'needs-attention'].includes(view.status);
const emptyWorkflows = (): WorkflowState => ({ version: 1, definitions: [], runs: [] });

function result(request: AutomationRequestV1 | undefined, delivery: AutomationResultV1['delivery'], reasonCode?: string,
  view?: WorkflowView, uncertain = false): AutomationResultV1 {
  const cleanup = uncertain ? 'uncertain' : view ? view.cleanupSettled ? 'settled' : 'uncertain' : 'not-started';
  const counts: Record<string, number> = {};
  if (view) for (const key of ['queued', 'running', 'completed', 'failed', 'cancelled', 'skipped', 'unverified']) {
    const value = view.counts[key as keyof typeof view.counts];
    if (Number.isSafeInteger(value) && value >= 0 && value <= 65536) counts[key] = value;
  }
  return { version: 1, profileId: request?.profileId ?? '', eventId: request?.eventId ?? '', delivery,
    cleanup, ...(reasonCode ? { reasonCode } : {}), ...(view ? { workflowRunId: view.workflowRunId, workflowStatus: view.status,
      counts, inspection: `workflows.show:${view.workflowRunId}` } : {}),
    exitCode: view?.status === 'completed' && cleanup === 'settled' && !reasonCode &&
      (delivery === 'accepted' || delivery === 'duplicate') ? 0 : delivery === 'rejected' ? 2 : 1 };
}

/** This only protects the runner-owned runtime locations. Profile/full-graph/read/config
 * authority is provided by the imported trusted loader and identity guard. No chmod/repair.
 * Descriptor-relative creation occurs only for explicitly configured dirs AFTER acquisition. */
function runtimePath(path: string, file: boolean, create = false): void {
  if (process.platform !== 'linux' || !process.geteuid || !path.startsWith('/') || resolve(path) !== path) throw new Error('runtime-path-unavailable');
  const handles: number[] = [];
  const paths: string[] = ['/'];
  const uid = process.geteuid();
  try {
    let fd = openSync('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(fd);
    let sticky = false;
    const parts = path.slice(1).split('/');
    for (let i = 0; i < parts.length; i++) {
      const isFile = file && i === parts.length - 1;
      const next = `${paths.at(-1) === '/' ? '' : paths.at(-1)}/${parts[i]}`;
      const child = `/proc/self/fd/${fd}/${parts[i]}`;
      let opened: number;
      try { opened = openSync(child, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (isFile ? 0 : constants.O_DIRECTORY)); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (isFile) { for (let j = 0; j < handles.length; j++) if (readlinkSync(`/proc/self/fd/${handles[j]}`) !== paths[j]) throw new Error('runtime-path-substituted'); return; }
        if (!create || sticky) throw new Error('runtime-path-unavailable');
        mkdirSync(child, { mode: 0o700 });
        opened = openSync(child, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      }
      handles.push(opened); paths.push(next); fd = opened;
      const stat = fstatSync(fd);
      if ((stat.uid !== uid && stat.uid !== 0) || (isFile ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) throw new Error('runtime-path-untrusted');
      if (sticky && (stat.uid !== uid || isFile || (stat.mode & 0o022))) throw new Error('runtime-path-untrusted');
      sticky = !isFile && stat.uid === 0 && !!(stat.mode & 0o1000) && !!(stat.mode & 0o022);
      if ((stat.mode & 0o022) && !sticky) throw new Error('runtime-path-untrusted');
      if (isFile && (stat.mode & 0o077)) throw new Error('runtime-file-not-private');
      if (readlinkSync(`/proc/self/fd/${fd}`) !== next) throw new Error('runtime-path-substituted');
    }
    if (sticky) throw new Error('runtime-path-untrusted');
    for (let j = 0; j < handles.length; j++) if (readlinkSync(`/proc/self/fd/${handles[j]}`) !== paths[j]) throw new Error('runtime-path-substituted');
  } finally { for (const fd of handles.reverse()) closeSync(fd); }
}

function loadState(profile: AutomationProfileV1): { manager: ClankersPersistenceManager; container: ReturnType<typeof createClankersStateContainer>;
  workflows: WorkflowState; ledger: AutomationLedgerV1 } {
  runtimePath(profile.snapshotFile, true); // No creation, no legacy symlink hydration.
  const manager = createClankersPersistenceManager({ enabled: true, snapshotFile: profile.snapshotFile });
  if (!manager || !manager.inspectRecoveryOwnership || !manager.acquireRecoveryOwnership || !manager.releaseRecoveryOwnership) throw new Error('persistence-unavailable');
  const container = createClankersStateContainer();
  if (manager.hydrate(container).lastLoadError) throw new Error('state-unavailable');
  const state = container.read();
  const workflows = state.extensions.workflows === undefined ? emptyWorkflows() : recoverWorkflowState(state.extensions.workflows);
  if (state.extensions.automation === undefined && (workflows.runs.length || Object.keys(state.agents).length || Object.keys(state.tasks).length)) throw new Error('state-namespace-not-empty');
  const ledger = state.extensions.automation === undefined ? createAutomationLedger(profile) : validateAutomationLedger(state.extensions.automation, workflows);
  return { manager, container, workflows, ledger };
}

/** Read-only hydration/projection only: never construct control, acquire/release, save,
 * initialize ModelRuntime, reconnect native sessions, or schedule/replay history. */
export async function inspectAutomationEvent(profilesDir: string, request: unknown): Promise<AutomationResultV1> {
  let event: AutomationRequestV1 | undefined;
  let guard: AutomationProfileIdentityGuard | undefined;
  try {
    event = validateAutomationRequest(request);
    const profile = await loadAutomationProfile(profilesDir, event.profileId);
    if (profile.limits.maxOutputBytes < 1024) return result(event, 'rejected', 'output-bound-too-small');
    guard = await createAutomationProfileIdentityGuard(profile);
    guard.assertCurrent();
    const { manager, workflows, ledger } = loadState(profile);
    const projection = projectAutomationEvent(ledger, workflows, profile, event);
    const ownership = manager.inspectRecoveryOwnership!();
    guard.assertCurrent();
    const foreign = !!ownership.owner || ownership.claimPresent || !!ownership.blocker;
    if (projection.lookup.kind === 'conflict') return result(event, 'rejected', 'event-conflict');
    if (projection.lookup.kind === 'duplicate') return result(event, 'duplicate', foreign ? 'foreign-owner-uncertain' :
      projection.view ? undefined : 'binding-without-run', projection.view, foreign || !projection.view);
    return result(event, foreign ? 'uncertain' : 'rejected', foreign ? 'foreign-owner-uncertain' : 'event-not-found', undefined, foreign);
  } catch { return result(event, 'rejected', event ? 'inspection-unavailable' : 'invalid-request'); }
  finally { guard?.dispose(); }
}

/** Bounded wait attaches a rejection handler even when the owned operation outlives us.
 * Timeout is uncertainty, never proof of cancellation or cleanup. */
async function bounded<T>(operation: Promise<T>, ms: number, signal?: AbortSignal): Promise<{ ok: true; value: T } | { ok: false; pending: boolean; error?: unknown }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort = () => {};
  const cancelled = new Promise<{ ok: false; pending: boolean }>(resolve => {
    const abort = () => resolve({ ok: false, pending: true });
    signal?.addEventListener('abort', abort, { once: true });
    removeAbort = () => signal?.removeEventListener('abort', abort);
    if (signal?.aborted) abort();
  });
  try {
    return await Promise.race([operation.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, pending: false, error })),
      new Promise<{ ok: false; pending: boolean }>(resolve => { timer = setTimeout(() => resolve({ ok: false, pending: true }), Math.max(0, ms)); }), cancelled]);
  } finally { if (timer) clearTimeout(timer); removeAbort(); }
}

function exactView(state: ClankersState, id: string): WorkflowView | undefined {
  // A live ledger is owned by the existing control, not restart-recovered on every poll.
  const workflows = state.extensions.workflows as unknown as WorkflowState | undefined;
  const run = workflows?.runs?.find(run => run.workflowRunId === id);
  return run ? workflowView(run) : undefined;
}
function modelFingerprint(runtime: ModelRuntime, profile: AutomationProfileV1): string {
  const pin = profile.modelPolicy;
  const model = runtime.getPhysicalModel(pin.provider, pin.id);
  if (!model || model.provider !== pin.provider || model.id !== pin.id || runtime.getError()) throw new Error('model-unavailable');
  // SDK1.0.0's documented physical metadata: no silent thinking clamp is acceptable.
  const map = model.thinkingLevelMap;
  if ((!model.reasoning && pin.thinkingLevel !== 'off') || map?.[pin.thinkingLevel] === null ||
    (pin.thinkingLevel === 'xhigh' && map?.xhigh === undefined)) throw new Error('thinking-unavailable');
  if (runtime.getRegisteredProviderIds().length || runtime.isUsingOAuth(pin.provider) ||
    runtime.getProviderAuthStatus(pin.provider).source !== 'runtime') throw new Error('credential-policy-mismatch');
  const serialized = JSON.stringify(model);
  if (Buffer.byteLength(serialized) > 65536) throw new Error('model-metadata-bound');
  return createHash('sha256').update(serialized).digest('hex');
}

export async function runAutomationEvent(profilesDir: string, request: unknown, signal?: AbortSignal): Promise<AutomationResultV1> {
  let event: AutomationRequestV1 | undefined;
  let profile: AutomationProfileV1 | undefined;
  let guard: AutomationProfileIdentityGuard | undefined;
  let manager: ClankersPersistenceManager | undefined;
  let ownedContainer: ReturnType<typeof createClankersStateContainer> | undefined;
  let publicationPending = false;
  let owner: RecoveryWriterOwnerEvidence | undefined;
  let control: ClankersControl | undefined;
  let runtime: ModelRuntime | undefined;
  let configCopy: { path: string; dev: number; ino: number; hash: string; bytes: number } | undefined;
  let runId: string | undefined;
  let reason: string | undefined;
  let uncertain = false;
  let setupPending = false;
  let providerRequests = 0;
  let readBytes = 0;
  const caller = new AbortController();
  const abort = () => { reason ??= 'caller-cancelled'; caller.abort(); };
  signal?.addEventListener('abort', abort, { once: true });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    event = validateAutomationRequest(request);
    if (signal?.aborted) return result(event, 'rejected', 'caller-cancelled');
    profile = await loadAutomationProfile(profilesDir, event.profileId);
    if (profile.limits.maxOutputBytes < 1024) return result(event, 'rejected', 'output-bound-too-small');
    const stopAt = performance.now() + profile.limits.maxRunMs;
    deadline = setTimeout(() => { reason ??= 'runner-deadline'; caller.abort(); }, profile.limits.maxRunMs);
    guard = await createAutomationProfileIdentityGuard(profile);
    guard.assertCurrent();
    const loaded = loadState(profile);
    manager = loaded.manager; ownedContainer = loaded.container;
    const projection = projectAutomationEvent(loaded.ledger, loaded.workflows, profile, event);
    const ownership = manager.inspectRecoveryOwnership!();
    guard.assertCurrent();
    const foreign = !!ownership.owner || ownership.claimPresent || !!ownership.blocker;
    if (projection.lookup.kind === 'conflict') return result(event, 'rejected', 'event-conflict');
    if (projection.lookup.kind === 'duplicate') return result(event, 'duplicate', foreign ? 'foreign-owner-uncertain' :
      projection.view ? undefined : 'binding-without-run', projection.view, foreign || !projection.view);
    if (foreign) return result(event, 'busy', 'state-owner-busy', undefined, true);
    if (loaded.workflows.runs.some(run => !['completed', 'failed', 'cancelled'].includes(run.status) || !run.cleanupSettled)) {
      return result(event, 'uncertain', 'prior-work-unsettled', undefined, true);
    }
    caller.signal.throwIfAborted();
    // SAME prepared hydrated manager. No TTL/dead-owner takeover or recovery grant.
    owner = manager.acquireRecoveryOwnership!({ expectedSnapshotHash: ownership.actualSnapshotHash }).owner;
    const assertDeadline = () => {
      if (performance.now() >= stopAt) { reason ??= 'runner-deadline'; caller.abort(); }
      caller.signal.throwIfAborted();
    };
    const assertOwner = () => {
      assertDeadline();
      guard!.assertCurrent(); caller.signal.throwIfAborted();
      const inspected = manager!.inspectRecoveryOwnership!();
      if (inspected.blocker || inspected.claimPresent || !inspected.ownerValid ||
        workflowHash(inspected.owner) !== workflowHash(owner)) throw new Error('owner-unavailable');
      guard!.assertCurrent(); assertDeadline();
    };
    assertOwner();
    runtimePath(profile.agentDir, false, true);
    runtimePath(profile.sessionDir, false, true);
    assertOwner();
    const metadata = guard.readModelConfig(); // Pin/hash/closed parser BEFORE SDK creation.
    if (metadata !== null) {
      const path = resolve(profile.agentDir, `automation-models-${owner.generation}-${randomUUID()}.json`);
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {
        const text = JSON.stringify(metadata);
        const stat = fstatSync(fd); configCopy = { path, dev: stat.dev, ino: stat.ino, hash: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) };
        writeFileSync(fd, text, 'utf8'); fsyncSync(fd);
      } finally { closeSync(fd); }
    }
    const assertConfigCopy = () => {
      if (!configCopy) return;
      runtimePath(profile!.agentDir, false);
      const fd = openSync(configCopy.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) || stat.dev !== configCopy.dev || stat.ino !== configCopy.ino || stat.size !== configCopy.bytes) throw new Error('model-copy-changed');
        const bytes = Buffer.alloc(configCopy.bytes + 1); let length = 0;
        while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, length); if (!count) break; length += count; }
        if (length !== configCopy.bytes || createHash('sha256').update(bytes.subarray(0, length)).digest('hex') !== configCopy.hash) throw new Error('model-copy-changed');
      } finally { closeSync(fd); }
    };
    assertConfigCopy();
    const key = process.env[profile.credentialSourceRef.name];
    if (typeof key !== 'string' || !key.trim() || Buffer.byteLength(key) > 16384) throw new Error('credential-unavailable');
    const prepared = (async () => {
      const sdk = await import('@earendil-works/pi-coding-agent');
      assertOwner();
      assertConfigCopy();
      const modelRuntime = await sdk.ModelRuntime.create({ modelsPath: configCopy?.path ?? null,
        credentials: { async read() { return undefined; }, async list() { return []; },
          async modify() { throw new Error('automation-credential-persistence-disabled'); },
          async delete() { throw new Error('automation-credential-persistence-disabled'); } },
        modelsStore: { async read() { return undefined; }, async write() {}, async delete() {} },
        allowModelNetwork: false, refreshOnCreate: false, signal: caller.signal });
      assertOwner(); assertConfigCopy();
      await modelRuntime.setRuntimeApiKey(profile!.modelPolicy.provider, key, { signal: caller.signal });
      assertOwner();
      const available = await modelRuntime.getAvailable(profile!.modelPolicy.provider, { signal: caller.signal });
      if (!available.some(model => model.provider === profile!.modelPolicy.provider && model.id === profile!.modelPolicy.id)) throw new Error('model-unavailable');
      assertOwner();
      return modelRuntime;
    })();
    setupPending = true;
    const preparation = await bounded(prepared, stopAt - performance.now(), caller.signal);
    if (!preparation.ok) { setupPending = preparation.pending; uncertain = preparation.pending; reason ??= preparation.pending ? 'model-preparation-uncertain' : 'model-unavailable'; throw new Error('setup-unavailable'); }
    setupPending = false; runtime = preparation.value;
    const pinHash = modelFingerprint(runtime, profile);
    const pruned = pruneAutomationEvents(loaded.ledger, loaded.workflows, profile, Date.now());
    assertOwner();
    // Pure two-ledger pruning/seed preparation joins one SAME-manager owned commit.
    const seed = createClankersState({ ...loaded.container.read(), agentDefinitions: Object.fromEntries(profile.agents.map(agent => [agent.id, agent])),
      extensions: { ...loaded.container.read().extensions, workflows: pruned.workflows, automation: pruned.ledger } });
    publicationPending = true; manager.save(seed); publicationPending = false; loaded.container.replace(seed);
    assertOwner();
    const assertPolicy = () => {
      assertOwner();
      if (modelFingerprint(runtime!, profile!) !== pinHash) throw new Error('model-policy-changed');
      runtimePath(profile!.snapshotFile, true);
      runtimePath(profile!.agentDir, false); runtimePath(profile!.sessionDir, false);
      assertConfigCopy();
      assertOwner();
    };
    control = createClankersControl(loaded.container, { persistenceManager: manager, recovery: { enabled: true },
      trustedWorkflow: { maxAdmissions: profile.limits.maxAdmissions, assertAdmission: assertPolicy,
        onStartReservation(run: Readonly<WorkflowRun>) {
          assertPolicy();
          if (runId) throw new Error('multiple-starts-refused');
          const current = control!.getState();
          const ledger = validateAutomationLedger(current.extensions.automation, current.extensions.workflows as unknown as WorkflowState);
          // The callback returns DATA only. Core atomically publishes event+exact run before scheduling.
          const next = reserveAutomationEvent(ledger, profile!, event!, run, owner!.generation, Date.now());
          assertPolicy(); runId = run.workflowRunId;
          return next;
        } },
      trustedAutomationNative: { cwd: profile.projectRoot, agentDir: profile.agentDir, sessionDir: profile.sessionDir,
        preflightedModelRuntime: runtime, expectedThinkingLevel: profile.modelPolicy.thinkingLevel,
        assertPolicy, beforeProviderRequest: () => { assertPolicy(); if (++providerRequests > profile!.limits.maxProviderRequests) { reason ??= 'provider-request-limit'; caller.abort(); throw new Error('provider-request-limit'); } },
        scopedAccess: path => {
          assertPolicy();
          const candidate = relative(profile!.projectRoot, path);
          if (resolve(profile!.projectRoot, candidate) !== path || !profile!.readPaths.includes(candidate)) throw new Error('read-outside-scope');
          // SDK access is only a logical scope probe: never read or charge text here.
          assertPolicy();
        },
        scopedRead: path => {
          assertPolicy();
          const candidate = relative(profile!.projectRoot, path);
          if (resolve(profile!.projectRoot, candidate) !== path || !profile!.readPaths.includes(candidate)) throw new Error('read-outside-scope');
          const text = scopedReadAutomationPath(profile!, candidate, guard!);
          // Cumulative runtime TEXT returned, including repeated reads: no refunds.
          // Profile preflight identity/hash reads are separately finite (<=16 paths).
          const bytes = Buffer.byteLength(text, 'utf8');
          // SDK tools may catch a refusal and continue: close the existing caller
          // cancellation fence so the durable bound run cannot complete successfully.
          if (bytes > profile!.limits.maxReadBytes - readBytes) { reason ??= 'read-byte-limit'; caller.abort(); throw new Error('read-byte-limit'); }
          readBytes += bytes; assertPolicy(); return text;
        } },
    });
    assertPolicy();
    const defineResult = await bounded(control.execute({ action: 'workflows.define', definition: profile.definition }, caller.signal), stopAt - performance.now(), caller.signal);
    if (!defineResult.ok) { if (defineResult.pending) { setupPending = true; uncertain = true; caller.abort(); } throw new Error('definition-refused'); }
    const defined = defineResult.value;
    if (!defined.ok) throw new Error('definition-refused');
    assertPolicy();
    const startResult = await bounded(control.execute({ action: 'workflows.start', definitionId: profile.definitionId,
      inputs: profile.fixedInputs, concurrency: profile.limits.concurrency }, caller.signal), stopAt - performance.now(), caller.signal);
    if (!startResult.ok) { if (startResult.pending) { setupPending = true; uncertain = true; caller.abort(); } throw new Error('start-refused'); }
    const started = startResult.value;
    if (!started.ok || !runId) throw new Error('start-refused');
    const startedView = (started.data as WorkflowReply | undefined)?.view;
    if (!startedView || startedView.workflowRunId !== runId) throw new Error('start-identity-mismatch');
    // Launch/agent_end/drain alone is NOT completion. Monitor only the exact bound run.
    for (;;) {
      const view = exactView(control.getState(), runId);
      if (!view) { reason = 'bound-run-unavailable'; uncertain = true; break; }
      if (terminal(view)) { if (view.status === 'needs-attention') reason = 'workflow-needs-attention'; break; }
      if (view.status === 'paused') { reason ??= 'workflow-needs-interaction'; caller.abort(); break; }
      if (caller.signal.aborted || performance.now() >= stopAt) { reason ??= 'runner-deadline'; caller.abort(); break; }
      await new Promise<void>(resolve => { setTimeout(resolve, Math.min(20, Math.max(1, stopAt - performance.now()))); });
    }
  } catch (error) {
    // Bounded reason codes only; never use provider/SDK error.message as scheduler output.
    const codes = new Set(['credential-unavailable', 'model-unavailable', 'thinking-unavailable', 'definition-refused',
      'start-refused', 'start-identity-mismatch', 'runtime-path-unavailable', 'runtime-file-not-private']);
    reason ??= error instanceof Error && codes.has(error.message) ? error.message : event ? 'automation-unavailable' : 'invalid-request';
    if (publicationPending) uncertain = true;
    try {
      const inspected = manager?.inspectRecoveryOwnership?.();
      if (owner && inspected?.blocker) uncertain = true;
      if (!owner && inspected && (inspected.owner || inspected.claimPresent || inspected.blocker)) {
        return result(event, inspected.blocker ? 'uncertain' : 'busy', inspected.blocker ? 'owner-acquisition-uncertain' : 'state-owner-busy', undefined, true);
      }
    } catch { uncertain = true; }
  } finally {
    if (deadline) clearTimeout(deadline);
    if (!owner) { signal?.removeEventListener('abort', abort); try { guard?.dispose(); } catch { /* No owned work was admitted. */ } }
  }
  // Duplicate/reject/busy returns above run only the finally, never this owned cleanup.
  const cleanupAt = performance.now() + (profile?.limits.maxCleanupMs ?? 1);
  if (control) {
    if (runId) {
      const view = exactView(control.getState(), runId);
      if (!view || !terminal(view) || view.status === 'needs-attention') {
        caller.abort();
        const cancelled = await bounded(control.execute({ action: 'workflows.cancel', workflowRunId: runId }), cleanupAt - performance.now());
        if (!cancelled.ok || !cancelled.value.ok) uncertain = true;
      }
    }
    try { control.dispose(); } catch { uncertain = true; }
    if (!control.drain || !(await bounded(control.drain(), cleanupAt - performance.now())).ok) uncertain = true;
  }
  if (performance.now() >= cleanupAt) { uncertain = true; reason ??= 'cleanup-deadline'; }
  if (setupPending) uncertain = true; // Unknown initialization must keep owner/config evidence.
  let view = control && runId ? exactView(control.getState(), runId) : undefined;
  if (runId && (!view || !terminal(view) || !view.cleanupSettled)) uncertain = true;
  try { guard?.dispose(); } catch { uncertain = true; }
  if (configCopy && !uncertain) {
    try {
      const stat = lstatSync(configCopy.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.dev !== configCopy.dev || stat.ino !== configCopy.ino) throw new Error('unsafe-config-cleanup');
      unlinkSync(configCopy.path); // Exact runner-owned leaf only; never tmp/process sweeps.
    } catch { uncertain = true; }
  }
  if (owner && manager) {
    try {
      // Preserve the exact workflow/event outcome with THIS manager before the LAST release.
      // No fresh controller or separate event/transcript store; unknown work stays inert and bound.
      if (ownedContainer) manager.save(control ? control.getState() : ownedContainer.snapshot());
      if (setupPending) uncertain = true;
      if (performance.now() >= cleanupAt) { uncertain = true; reason ??= 'cleanup-deadline'; }
      if (!uncertain) manager.releaseRecoveryOwnership!(owner);
    } catch { uncertain = true; reason = 'outcome-persistence-uncertain'; }
  }
  view = control && runId ? exactView(control.getState(), runId) : undefined;
  signal?.removeEventListener('abort', abort);
  return result(event, uncertain ? 'uncertain' : runId ? 'accepted' : 'rejected', reason, view, uncertain);
}
