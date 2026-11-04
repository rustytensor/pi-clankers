import { randomUUID } from 'node:crypto';
import { createJiti } from 'jiti';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTmuxWorker, TmuxLaunchError, type TmuxLaunchOptions, type TmuxWorkerHandle } from './tmux-runner.js';
import { TMUX_TEXT_BYTES, type TmuxJobResult, type TmuxSnapshot } from './tmux-protocol.js';
import type { ZergAgentDefinition, ZergCommandResult, ZergStateContainer, ZergSubagentLaunchRequest } from './types.js';
import { applyRuntimeTransition, getAgentDefinition, upsertTask } from './state.js';
import { AGENT_RESULTS_KEY, captureAssistantResultText, normalizeMayWrite, normalizeResultSchema, projectAgentResult, retainAgentResult, validateAgentResult, type AgentResult, type AgentResultLedger } from './agent-results.js';

import { resolveTmuxToolPolicy, parseTmuxMcpCommand, type TmuxMcpCommand } from './tmux-mcp.js';

/** Trusted host-only injection. These paths are never accepted in control JSON. */
export interface TrustedTmuxOptions {
  sdkModulePath?: string;
  agentDir?: string;
  rootDir?: string;
  fixtureExtensionPaths?: string[];
  fixtureMcpCommand?: TmuxMcpCommand;
  /** Trusted offline gate preload; runner validates it, never manifest/model JSON. */
  fixtureNodeImportPath?: string;
}
interface Options {
  cwd: string;
  trusted?: TrustedTmuxOptions;
  assertAuthority(): void;
  ids(): { runId: string; taskId: string };
  captureNotice?(): ((result: AgentResult) => AgentResult['notice']) | undefined;
}
interface Worker {
  workerId: string;
  definition: ZergAgentDefinition;
  model: string;
  handle?: TmuxWorkerHandle;
  opening?: Promise<TmuxWorkerHandle>;
  closing?: Promise<unknown>;
  runnerStarted?: boolean;
  launchFailed?: boolean;
  cleanupConfirmed?: boolean;
  current?: { runId: string; taskId: string; jobId: string };
}

/** Separate owner: never a native adapter, transcript or workflow capability. */
export function createTmuxControl(container: ZergStateContainer, options: Options) {
  let worker: Worker | undefined;
  let disposed = false;
  const pending = new Set<Promise<unknown>>();
  const jobs = new Map<string, Promise<void>>();
  const failures: string[] = [];
  // Detached settlement retention never mutates a disposed canonical owner.
  let settledResults: AgentResultLedger | undefined;
  const rememberFailure = (message: string) => { failures.push(message); if (failures.length > 4) failures.shift(); };
  const own = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  };
  const authority = (signal?: AbortSignal) => {
    if (disposed || signal?.aborted) throw new Error('Tmux owner/caller disposed or cancelled.');
    options.assertAuthority();
    const state = container.read();
    if (state.lifecycle === 'disposed' || state.mode.readOnly) throw new Error('Tmux mutations refuse read-only/disposed authority; permission queue is unsupported.');
    if (state.mode.automation !== 'automatic') throw new Error('Tmux requires automatic permission mode; manual/assisted are unsupported.');
  };
  const exact = (workerId: string) => {
    if (!worker || worker.workerId !== workerId) throw new Error('Exact owned workerId required; no fallback.');
    return worker;
  };
  const closeOwned = (target: Worker) => {
    if (!target.closing) target.closing = own((async () => {
      const handle = target.handle ?? await target.opening;
      if (!handle) return { closed: true, errors: [] };
      const result = await handle.close();
      if (!result.closed || result.errors.length) rememberFailure('Tmux cleanup incomplete; exact owned worker retained.');
      if (result.closed && !result.errors.length && worker === target) worker = undefined;
      return { closed: result.closed, errors: result.errors.length ? ['Owned worker cleanup reported errors.'] : [] };
    })().catch(() => {
      if (target.launchFailed && target.cleanupConfirmed) {
        if (worker === target && !target.current) worker = undefined;
        return { closed: true, errors: [] };
      }
      rememberFailure('Tmux cleanup unconfirmed; exact owned worker retained.');
      return { closed: false, errors: ['Owned worker cleanup unconfirmed.'] };
    }));
    return target.closing;
  };
  const project = (target: Worker, snapshot?: TmuxSnapshot) => ({
    workerId: target.workerId, sessionId: target.handle?.sessionId ?? null,
    attachCommand: target.handle?.attachCommand ?? null,
    agentId: target.definition.id, model: target.model,
    policyBinding: 'launch-time definition and policy; registry edits require close and a new worker',
    boundPolicy: { tools: [...(target.definition.tools ?? ['read', 'bash'])], disallowedTools: [...(target.definition.disallowedTools ?? [])], result_schema: structuredClone(target.definition.result_schema ?? null), may_write: null },
    phase: target.launchFailed ? (target.cleanupConfirmed ? 'failed_cleaned' : 'failed_cleanup_unconfirmed') : target.closing ? 'closing' : target.handle?.isClosed ? 'closed' : snapshot?.phase ?? (target.handle ? 'unknown' : 'starting'),
    ownership: snapshot?.ownership ?? null,
    epoch: snapshot?.identity.epoch ?? null,
    currentRunId: target.current?.runId ?? null,
    job: snapshot?.job ? { jobId: snapshot.job.jobId, runId: snapshot.job.runId, taskId: snapshot.job.taskId, source: snapshot.job.source } : null,
    result: snapshot?.result ? { outcome: snapshot.result.outcome, source: snapshot.result.identity.source, jobId: snapshot.result.identity.jobId, runId: snapshot.result.identity.runId, taskId: snapshot.result.identity.taskId, text: snapshot.result.text, textClipped: snapshot.result.textClipped, settled: true } : null,
    telemetry: null, toolEvidence: 'unavailable', nativeFeatures: 'unavailable: transcript, continuation, history, recovery and native coding UI',
  });
  const ownsRunningJob = (target: Worker, job: { runId: string; taskId: string }) => {
    try { authority(); } catch { return false; }
    const current = container.read();
    const agent = current.agents[job.runId], task = current.tasks[job.taskId];
    return worker === target && target.current?.runId === job.runId && target.current.taskId === job.taskId
      && agent?.status === 'running' && task?.status === 'running' && task.ownerAgentId === job.runId
      && agent.metadata?.backend === 'tmux' && agent.metadata?.workerId === target.workerId;
  };
  const publish = (target: Worker, job: { runId: string; taskId: string; jobId: string }, task: string, state: 'running' | 'done' | 'failed' | 'cancelled', reason: string) => {
    authority();
    if (state !== 'running' && !ownsRunningJob(target, job)) return;
    const current = container.read();
    if (state === 'running' && (worker !== target || target.current?.runId !== job.runId || current.agents[job.runId] || current.tasks[job.taskId])) throw new Error('Canonical job owner changed during admission.');
    const time = new Date().toISOString();
    const metadata = { backend: 'tmux', workerId: target.workerId, tmuxJobId: job.jobId, agentDefinitionId: target.definition.id, agentDefinitionLabel: target.definition.label, runId: job.runId, taskId: job.taskId, originalTask: task, model: target.model, launchMode: 'fresh' };
    const next = applyRuntimeTransition(current, { entity: 'agent', action: state === 'running' ? 'create' : state === 'done' ? 'stop' : 'fail', id: job.runId, label: target.definition.label, kind: 'subagent', status: state, activity: reason, substate: state === 'done' ? 'completed' : state === 'running' ? 'executing' : state, substateReason: reason, metadata }, { now: () => new Date(time) });
    container.replace(upsertTask(next, { id: job.taskId, title: task, status: state, ownerAgentId: job.runId, updatedAt: time, substate: state === 'done' ? 'completed' : state === 'running' ? 'executing' : state, substateReason: reason, substateUpdatedAt: time, metadata }));
  };
  const begin = (target: Worker, task: string, signal?: AbortSignal): ZergCommandResult => {
    authority(signal);
    if (target.current || target.closing || target.handle?.isClosed) throw new Error('Tmux worker busy, closing or closed.');
    if (typeof task !== 'string' || !task.trim() || Buffer.byteLength(task, 'utf8') > TMUX_TEXT_BYTES) throw new Error('Tmux task must be nonempty and at most 8192 UTF-8 bytes.');
    const ids = options.ids();
    if (![ids.runId, ids.taskId].every(id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$(?![\s\S])/.test(id))) throw new Error('Canonical run/task IDs do not fit the tmux protocol.');
    if (container.read().agents[ids.runId] || container.read().tasks[ids.taskId] || jobs.has(ids.runId)) throw new Error('Canonical run/task IDs must be new; collision refused.');
    const job = { ...ids, jobId: randomUUID() };
    const notice = options.captureNotice?.(); // Capture initiating session, not settlement-time session.
    authority(signal);
    if (worker !== target || target.current || target.closing) throw new Error('Worker admission changed during ID/notice capture.');
    target.current = job;
    try { publish(target, job, task, 'running', 'tmux job admitted; not completed'); }
    catch (error) { target.current = undefined; throw error; }
    const completion = own((async () => {
      let result: TmuxJobResult | undefined;
      let state: AgentResult['state'] = 'failed';
      try {
        authority(signal); // Recheck after reentrant canonical publication.
        const handle = target.handle ?? await target.opening;
        if (!handle) throw new Error('Worker setup unavailable.');
        target.handle = handle;
        authority(signal);
        if (!ownsRunningJob(target, job)) throw new Error('Job admission revoked.');
        const abort = () => { void own(handle.cancel(job.jobId).catch(() => { rememberFailure('Tmux cancellation not confirmed.'); })); };
        signal?.addEventListener('abort', abort, { once: true });
        try { result = await handle.prompt({ ...job, text: task }); }
        finally { signal?.removeEventListener('abort', abort); }
        if (!result.settled || result.identity.source !== 'coordinator' || result.identity.jobId !== job.jobId || result.identity.runId !== job.runId || result.identity.taskId !== job.taskId || result.identity.workerId !== target.workerId || result.identity.sessionId !== handle.sessionId) {
          result = undefined;
          throw new Error('Exact coordinator settlement identity mismatch.');
        }
        state = result.outcome === 'completed' ? 'done' : result.outcome === 'aborted' ? 'cancelled' : 'failed';
      } catch { state = 'failed'; }
      const captured = captureAssistantResultText(result && !result.textClipped ? { role: 'assistant', content: [{ type: 'text', text: result.text }] } : undefined);
      const checked = result?.textClipped
        ? { status: 'limit_exceeded' as const, errors: ['Transport clipped final text; exact JSON unavailable.'], result: undefined }
        : validateAgentResult(captured.final_message, target.definition.result_schema);
      const record: AgentResult = {
        agent_id: target.definition.id, task_id: job.taskId, run_id: job.runId, member_run_id: job.runId,
        pi_session_id: target.handle?.sessionId ?? null, state, stop_reason: result?.outcome === 'completed' ? 'stop' : result?.outcome === 'aborted' ? 'aborted' : null, model: target.model,
        ...captured, files_changed: [], files_outside_allowed: null, evidence_complete: false,
        evidence_reasons: ['Tmux toolEvidence unavailable; writes cannot be assessed.', ...(result?.textClipped ? ['Transport text clipped; original character count unknown.'] : [])],
        tokens: { input: null, output: null, cache_read: null, cache_write: null }, context_percent: null, elapsed_seconds: null,
        validation: { status: checked.status, errors: checked.errors }, result: checked.result ?? null, result_available: checked.status === 'valid', result_omitted: false,
        historical: false, notice: 'unavailable',
      };
      const alreadyRetained = () => (container.read().extensions[AGENT_RESULTS_KEY] as AgentResultLedger | undefined)?.records.some(item => item.run_id === job.runId && item.task_id === job.taskId);
      // Check again after every host callback: notice delivery and state subscribers
      // can dispose the owner or terminalize this exact canonical job reentrantly.
      if (ownsRunningJob(target, job) && !alreadyRetained() && notice) {
        try { record.notice = notice(projectAgentResult(record)); } catch { record.notice = 'failed'; }
      }
      settledResults = retainAgentResult(settledResults, record);
      if (!ownsRunningJob(target, job) || alreadyRetained()) return;
      const current = container.read();
      container.update({ extensions: { ...current.extensions, [AGENT_RESULTS_KEY]: retainAgentResult(current.extensions[AGENT_RESULTS_KEY] as AgentResultLedger | undefined, record) } });
      if (ownsRunningJob(target, job)) publish(target, job, task, state, result ? `tmux job ${result.outcome}; worker kept open` : 'tmux job failed or submission uncertain; no retry');
    })().catch(() => { rememberFailure('Tmux result publication failed; inspect retained state.'); }).finally(() => { if (target.current === job) target.current = undefined; if (worker === target && target.launchFailed && target.cleanupConfirmed) worker = undefined; }));
    jobs.set(job.runId, completion);
    // Bound completed await handles independently of immutable result retention.
    void completion.then(() => { jobs.delete(job.runId); });
    return { ok: true, ...ids, output: `tmux job admitted (${ids.runId}) task:${ids.taskId} worker:${target.workerId}; not completed` };
  };
  return {
    start(request: ZergSubagentLaunchRequest, signal?: AbortSignal): ZergCommandResult {
      authority(signal);
      if (typeof request.task !== 'string' || !request.task.trim() || Buffer.byteLength(request.task, 'utf8') > TMUX_TEXT_BYTES) throw new Error('Tmux task must be nonempty and at most 8192 UTF-8 bytes.');
      const allowed = new Set(['backend', 'agent', 'task', 'background', 'fork', 'launchMode', 'concurrency', 'model', 'fallbackModels', 'maxTurns']);
      if (Object.keys(request).some(key => !allowed.has(key))) throw new Error('Unsupported tmux launch field; no resume/history/recovery or private overrides.');
      if (worker) throw new Error('Only one tmux worker is supported, including idle/setup/cleanup. Close it explicitly first.');
      const state = container.read();
      if (state.teams[request.agent] || request.resolvedTeamId || request.memberAgentIds !== undefined) throw new Error('Tmux teams/fanout are unsupported, including empty or same-name teams.');
      const definition = getAgentDefinition(state, request.agent);
      if (!definition) throw new Error('Tmux requires an exact configured standalone agent.');
      if (request.fork || (request.launchMode !== undefined && request.launchMode !== 'fresh') || request.maxTurns !== undefined || definition.maxTurns !== undefined || request.fallbackModels?.length || definition.fallbackModels?.length || (request.concurrency !== undefined && request.concurrency !== 1)) throw new Error('Tmux supports only fresh standalone jobs, no turn limits, fallback models or fanout.');
      if (definition.permissionMode && !['automatic', 'inherit'].includes(definition.permissionMode)) throw new Error('Tmux manual/assisted permission policy unsupported.');
      const model = request.model ?? definition.model;
      if (typeof model !== 'string' || !/^[^\s/]+\/[^\s]+$/.test(model)) throw new Error('Tmux requires explicit canonical provider/model[:thinking].');
      const { tools, disallowedTools } = resolveTmuxToolPolicy(definition.tools, definition.disallowedTools);
      const frozen = structuredClone(definition);
      frozen.tools = [...tools]; frozen.disallowedTools = [...disallowedTools];
      frozen.result_schema = normalizeResultSchema(definition.result_schema);
      frozen.may_write = normalizeMayWrite(definition.may_write);
      if (frozen.may_write !== undefined) throw new Error('Tmux may_write reporting policy unsupported without tool evidence.');
      const target: Worker = { workerId: `clankers-${randomUUID()}`, definition: frozen, model };
      const launch: TmuxLaunchOptions = { cwd: options.cwd, agentDir: options.trusted?.agentDir ?? '', sdkModulePath: options.trusted?.sdkModulePath ?? fileURLToPath(createJiti(import.meta.url, { fsCache: false }).esmResolve('@earendil-works/pi-coding-agent')), modelSpec: model, definitionPrompt: frozen.prompt, tools, disallowedTools, workerId: target.workerId, ...(options.trusted?.rootDir ? { rootDir: options.trusted.rootDir } : {}), ...(options.trusted?.fixtureExtensionPaths ? { fixtureExtensionPaths: [...options.trusted.fixtureExtensionPaths] } : {}), ...(options.trusted?.fixtureNodeImportPath ? { fixtureNodeImportPath: options.trusted.fixtureNodeImportPath } : {}), ...(options.trusted?.fixtureMcpCommand ? { fixtureMcpCommand: parseTmuxMcpCommand(options.trusted.fixtureMcpCommand) } : {}) };
      worker = target; // Reserve before any await or process creation.
      // Delay child creation until begin has published and rechecked authority.
      target.opening = own(Promise.resolve().then(async () => {
        authority(signal);
        let agentDir = launch.agentDir;
        if (!agentDir) {
          const sdk = await import(pathToFileURL(launch.sdkModulePath).href) as { getAgentDir?: () => string };
          if (typeof sdk.getAgentDir !== 'function') throw new Error('Trusted Pi SDK getAgentDir capability unavailable.');
          agentDir = sdk.getAgentDir();
        }
        authority(signal);
        if (target.closing || !target.current || !ownsRunningJob(target, target.current)) throw new Error('Tmux launch admission revoked.');
        // Fail closed until the worker policy supplies pre-child model/resource
        // validation. Path/syntax checks alone do not establish SDK capabilities.
        const policy = await import('./tmux-worker-policy.js') as unknown as {
          preflightTmuxWorkerPolicy?: (sdkModulePath: string, input: TmuxLaunchOptions) => Promise<void>;
        };
        if (typeof policy.preflightTmuxWorkerPolicy !== 'function') throw new Error('Tmux pre-child model/resource validation unavailable.');
        const resolvedLaunch = { ...launch, agentDir };
        await policy.preflightTmuxWorkerPolicy(launch.sdkModulePath, resolvedLaunch);
        authority(signal);
        if (target.closing || !target.current || !ownsRunningJob(target, target.current)) throw new Error('Tmux launch admission revoked.');
        target.runnerStarted = true;
        return createTmuxWorker(resolvedLaunch);
      }).then(handle => { target.handle = handle; if (disposed) void closeOwned(target); return handle; }, error => {
        target.launchFailed = true;
        target.cleanupConfirmed = !target.runnerStarted || (error instanceof TmuxLaunchError && error.cleanup.closed && error.cleanup.errors.length === 0);
        if (!target.cleanupConfirmed) rememberFailure('Tmux launch cleanup unconfirmed; worker slot retained.');
        if (worker === target && target.cleanupConfirmed && !target.current) worker = undefined;
        throw new Error('Tmux worker setup failed.');
      }));
      // Observe rejection even when synchronous admission was revoked.
      void target.opening.catch(() => undefined);
      try { return begin(target, request.task, signal); }
      catch (error) { void closeOwned(target); throw error; }
    },
    async list() { return worker ? [project(worker, worker.handle && !worker.closing && !worker.handle.isClosed ? await worker.handle.inspect() : undefined)] : []; },
    async show(workerId: string, jobId?: string) {
      if (jobId !== undefined && (typeof jobId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$(?![\s\S])/.test(jobId))) throw new Error('Exact valid jobId required; no latest fallback.');
      const target = exact(workerId);
      return project(target, target.handle && !target.closing && !target.handle.isClosed ? await target.handle.inspect(jobId) : undefined);
    },
    async prompt(workerId: string, task: string, background = false, signal?: AbortSignal) {
      authority(signal); const target = exact(workerId);
      if (!target.handle || target.current || target.closing) throw new Error('Worker not idle/ready.');
      const snapshot = await target.handle.inspect();
      authority(signal);
      if (snapshot.ownership !== 'coordinator' || snapshot.phase !== 'idle') throw new Error('Worker is not coordinator-owned and idle.');
      const result = begin(target, task, signal);
      if (!background && result.runId) await jobs.get(result.runId);
      return result;
    },
    async steer(workerId: string, runId: string, body: string, signal?: AbortSignal) {
      authority(signal); const target = exact(workerId);
      if (!target.handle || !target.current || target.current.runId !== runId || target.closing) throw new Error('Exact current worker/run required for steer.');
      if (typeof body !== 'string' || !body.trim() || Buffer.byteLength(body, 'utf8') > TMUX_TEXT_BYTES) throw new Error('Steer body must be nonempty and at most 8192 UTF-8 bytes.');
      if (!ownsRunningJob(target, target.current)) throw new Error('Canonical job admission revoked.');
      const reply = await target.handle.steer(target.current.jobId, body);
      return { ok: reply.status !== 'refused', status: reply.status }; // Never serialize private response identity.
    },
    interrupt(runId: string): ZergCommandResult {
      authority();
      if (!worker?.handle || worker.current?.runId !== runId || worker.closing) return { ok: false, output: 'Exact active tmux run required; stale job refused.' };
      const target = worker;
      if (!ownsRunningJob(target, target.current!)) return { ok: false, output: 'Canonical tmux job admission revoked.' };
      void own(target.handle!.cancel(target.current!.jobId).then(reply => { if (reply.status === 'refused') rememberFailure('Tmux cancellation refused.'); }, () => { rememberFailure('Tmux cancellation not confirmed.'); }));
      return { ok: true, runId, output: 'Tmux cancellation requested; completion awaits actual settlement.' };
    },
    async close(workerId: string, signal?: AbortSignal) { authority(signal); return closeOwned(exact(workerId)); },
    async awaitRun(runId: string) { await jobs.get(runId); },
    retainedResults() { return settledResults?.records.map(record => projectAgentResult(record)) ?? []; },
    dispose() { if (disposed) return; disposed = true; if (worker) void closeOwned(worker); },
    async drain() { while (pending.size) await Promise.allSettled([...pending]); if (failures.length) throw new Error(failures.slice(-4).join(' ')); },
  };
}
export type TmuxControl = ReturnType<typeof createTmuxControl>;
