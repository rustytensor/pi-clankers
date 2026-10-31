import { normalizeResultSchema, normalizeMayWrite, isImmutableAgentResultLedger } from './agent-results.js';
import { ZERG_STATE_SCHEMA_VERSION, type AgentIdentity, type AgentKind, type AgentStatus, type HookLifecycleEvent, type PermissionModeIntervention, type PermissionModeInterventionInput, type PermissionModeSnapshot, type PermissionModeState, type PermissionModeTransitionInput, type TaskRecord, type TeamIdentity, type TeamKind, type ZergAgentDefinition, type ZergAgentRuntimeTransition, type ZergContext, type ZergExtensionFields, type ZergPermissionDecision, type ZergPermissionQueueState, type ZergPermissionRequest, type ZergPermissionRequester, type ZergPermissionRequestKind, type ZergPermissionRequestStatus, type ZergPermissionResolver, type ZergLifecycleSubstate, type ZergLogLevel, type ZergLogRecord, type ZergLogSource, type ZergLogState, type ZergOutputKind, type ZergRuntimeHealth, type ZergRuntimeModeContext, type ZergRuntimeState, type ZergRuntimeTransition, type ZergState, type ZergStateContainer, type ZergStateListener, type ZergStatePatch, type ZergStateUpdateOptions, type ZergSubagentRunSnapshot, type ZergNativeSessionReference, type ZergTeamRuntimeTransition, type ZergTreeNode } from './types.js';

const DEFAULT_TIMESTAMP = '1970-01-01T00:00:00.000Z';
const MAX_LIFECYCLE_SUBSTATE_REASON_LENGTH = 160;
const MAX_ZERG_STATE_LISTENER_DIAGNOSTIC_LENGTH = 240;
// Extension metadata is persisted as JSON-shaped state. Bound traversal so invalid
// cycles and hostile/deep graphs fail before commits instead of overflowing stacks.
const MAX_EXTENSION_CLONE_DEPTH = 64;
const MAX_EXTENSION_CLONE_WORK = 100_000;

const DEFAULT_MODE: PermissionModeState = {
  automation: 'manual',
  interventionEnabled: true,
  controller: 'operator',
};

const BUILTIN_AGENT_DEFINITIONS: Record<string, ZergAgentDefinition> = {
  generalist: {
    id: 'generalist',
    label: 'Generalist',
    description: 'A versatile default agent for general implementation and follow-through.',
    prompt: 'You are a generalist coding agent focused on pragmatic implementation and collaboration.',
    source: 'builtin',
    tools: ['files', 'shell', 'analysis'],
    permissionMode: 'inherit',
  },
  planner: {
    id: 'planner',
    label: 'Planner',
    description: 'Plans execution and decomposes work into practical, testable tasks.',
    prompt: 'You are a planning agent that converts goals into concrete, sequenced tasks.',
    source: 'builtin',
    tools: ['analysis', 'search'],
    permissionMode: 'inherit',
  },
  reviewer: {
    id: 'reviewer',
    label: 'Reviewer',
    description: 'Reviews changes for correctness, risk, and maintainability.',
    prompt: 'You are a reviewer focused on validating quality, correctness, and operational risk.',
    source: 'builtin',
    tools: ['analysis', 'search'],
    permissionMode: 'inherit',
    disallowedTools: ['destructive-write'],
  },
};

export function createBuiltinAgentDefinitions(): Record<string, ZergAgentDefinition> {
  return cloneAgentDefinitions(BUILTIN_AGENT_DEFINITIONS);
}

export function createZergSubagentRunSnapshot(run: ZergSubagentRunSnapshot): ZergSubagentRunSnapshot {
  // Parent metadata is authoritative whenever the reserved key is present,
  // including malformed/null/undefined values. Typed-only adapter snapshots
  // remain supported when no canonical ledger key was supplied.
  const nativeSessions = normalizeNativeSessionReferences(
    run.metadata && Object.hasOwn(run.metadata, 'nativeSessions') ? run.metadata.nativeSessions : run.nativeSessions,
    run.runId,
  );
  const nativeContinuation = normalizeNativeContinuationLineage(run.metadata && Object.hasOwn(run.metadata, 'nativeContinuation') ? run.metadata.nativeContinuation : run.nativeContinuation);
  return {
    runId: run.runId,
    agentId: run.agentId,
    agentDefinitionId: run.agentDefinitionId,
    agentLabel: run.agentLabel,
    task: run.task,
    status: run.status,
    taskId: run.taskId,
    launchMode: run.launchMode,
    substate: run.substate,
    substateReason: run.substateReason,
    substateUpdatedAt: run.substateUpdatedAt,
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    finalSummary: run.finalSummary,
    errorSummary: run.errorSummary,
    ...(run.recovery ? { recovery: { ...run.recovery } } : {}),
    memberProgress: run.memberProgress?.map((member) => ({ ...member })),
    ...(nativeSessions !== undefined ? { nativeSessions } : {}),
    ...(nativeContinuation ? { nativeContinuation } : {}),
    metadata: cloneRunMetadata(run.metadata, run.runId),
  };
}

export function seedBuiltinAgentDefinitions(state: ZergState): ZergState {
  let mergedDefinitions = state.agentDefinitions;
  let changed = false;

  for (const [id, definition] of Object.entries(BUILTIN_AGENT_DEFINITIONS)) {
    if (state.agentDefinitions[id] === undefined) {
      if (!changed) {
        mergedDefinitions = {
          ...state.agentDefinitions,
          [id]: definition,
        };
        changed = true;
      } else {
        mergedDefinitions = {
          ...mergedDefinitions,
          [id]: definition,
        };
      }
      continue;
    }
  }

  if (!changed) {
    return state;
  }

  return createZergState({
    ...state,
    agentDefinitions: mergedDefinitions,
  });
}

export function normalizeAgentDefinitionId(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

export function getAgentDefinitions(state: ZergState): ZergAgentDefinition[] {
  return Object.values(state.agentDefinitions)
    .map((definition) => cloneAgentDefinition(definition))
    .sort((left, right) => left.id.localeCompare(right.id) || left.label.localeCompare(right.label));
}

export function getAgentDefinition(state: ZergState, rawId: string): ZergAgentDefinition | undefined {
  const id = normalizeAgentDefinitionId(rawId);
  if (!id) {
    return undefined;
  }

  const definition = state.agentDefinitions[id];
  if (!definition) {
    return undefined;
  }

  return cloneAgentDefinition(definition);
}

export function getSubagentRunSnapshots(state: ZergState): ZergSubagentRunSnapshot[] {
  return Object.values(state.agents)
    .filter((agent) => isPiSubagentRunAgentId(agent.id))
    .map((agent) => cloneSubagentRunSnapshot(fromAgentToRunSnapshot(agent)))
    .sort((left, right) => (right.startedAt ?? '').localeCompare(left.startedAt ?? '') || left.runId.localeCompare(right.runId));
}

export function getSubagentRunSnapshot(state: ZergState, runId: string): ZergSubagentRunSnapshot | undefined {
  const run = getSubagentRunById(state, runId);
  return run ? cloneSubagentRunSnapshot(run) : undefined;
}

export function upsertAgentDefinition(state: ZergState, definition: ZergAgentDefinition): ZergState {
  const id = normalizeAgentDefinitionId(definition.id);
  if (!id) {
    throw new Error('agent definition id must be a non-empty string');
  }

  const prompt = definition.prompt?.trim();
  if (!prompt) {
    throw new Error('agent definition prompt must be a non-empty string');
  }

  const model = normalizeOptionalConfigText(definition.model);
  const fallbackModels = dedupeSortedTools(definition.fallbackModels);
  const maxTurns = normalizePositiveInteger(definition.maxTurns);

  const { result_schema, may_write, ...baseDefinition } = definition;
  const normalized: ZergAgentDefinition = {
    ...baseDefinition,
    id,
    label: definition.label?.trim() || definition.id,
    prompt,
    ...(result_schema === undefined ? {} : { result_schema: normalizeResultSchema(result_schema) }),
    ...(may_write === undefined ? {} : { may_write: normalizeMayWrite(may_write) }),
    ...(model ? { model } : {}),
    ...(fallbackModels ? { fallbackModels } : {}),
    ...(maxTurns ? { maxTurns } : {}),
    tools: definition.tools === undefined ? undefined : dedupeSortedTools(definition.tools) ?? [],
    disallowedTools: dedupeSortedTools(definition.disallowedTools),
    metadata: cloneOptional(definition.metadata, cloneExtensionFields),
    extensions: cloneOptional(definition.extensions, cloneExtensionFields),
  };

  return updateZergState(state, {
    agentDefinitions: {
      ...state.agentDefinitions,
      [id]: normalized,
    },
  });
}

export function removeAgentDefinition(state: ZergState, rawId: string): ZergState {
  const id = normalizeAgentDefinitionId(rawId);
  if (!id || state.agentDefinitions[id] === undefined) {
    return state;
  }

  const nextDefinitions = { ...state.agentDefinitions };
  delete nextDefinitions[id];

  return updateZergState(state, {
    agentDefinitions: nextDefinitions,
  });
}

export function createZergState(seed: Partial<ZergState> = {}): ZergState {
  return {
    schemaVersion: ZERG_STATE_SCHEMA_VERSION,
    lifecycle: seed.lifecycle ?? 'ready',
    revision: seed.revision ?? 0,
    metadata: cloneMetadata(seed.metadata),
    agents: cloneAgents(seed.agents),
    tasks: cloneTasks(seed.tasks),
    teams: cloneTeams(seed.teams),
    tree: cloneTree(seed.tree),
    events: cloneEvents(seed.events),
    selectedNodeId: seed.selectedNodeId,
    mode: cloneMode(seed.mode),
    context: cloneContext(seed.context),
    extensions: cloneExtensionFields(seed.extensions),
    agentDefinitions: cloneAgentDefinitions(seed.agentDefinitions),
  };
}

export function snapshotZergState(state: ZergState): ZergState {
  return createZergState(state);
}

export function updateZergState(state: ZergState, patch: ZergStatePatch, options: ZergStateUpdateOptions = {}): ZergState {
  const base = snapshotZergState(state);
  const resolvedPatch = typeof patch === 'function' ? patch(base) : patch;
  const mergedMetadata = cloneMetadata({
    ...base.metadata,
    ...(resolvedPatch.metadata ?? {}),
    updatedAt: options.updatedAt ?? resolvedPatch.metadata?.updatedAt ?? base.metadata.updatedAt,
  });

  return createZergState({
    ...base,
    ...resolvedPatch,
    metadata: mergedMetadata,
    lifecycle: options.lifecycle ?? resolvedPatch.lifecycle ?? base.lifecycle,
    revision: options.preserveRevision ? (resolvedPatch.revision ?? base.revision) : base.revision + 1,
  });
}

export function getCurrentAgents(state: ZergState): AgentIdentity[] {
  return Object.keys(state.agents).sort().map((id) => cloneAgent(state.agents[id]!));
}

export function getCurrentTasks(state: ZergState): TaskRecord[] {
  return Object.keys(state.tasks).sort().map((id) => cloneTask(state.tasks[id]!));
}

export function getCurrentTeams(state: ZergState): TeamIdentity[] {
  return Object.keys(state.teams).sort().map((id) => cloneTeam(state.teams[id]!));
}

export function getCurrentTree(state: ZergState): Record<string, ZergTreeNode> {
  return cloneTree(state.tree);
}

export function getCurrentMode(state: ZergState): PermissionModeState {
  return cloneMode(state.mode);
}

export function getSelectedNodeId(state: ZergState): string | undefined {
  return state.selectedNodeId;
}

export function getSelectedTreeNode(state: ZergState): ZergTreeNode | undefined {
  return state.selectedNodeId ? cloneOptional(state.tree[state.selectedNodeId], cloneTreeNode) : undefined;
}

export function upsertAgent(state: ZergState, agent: AgentIdentity): ZergState {
  return updateZergState(state, {
    agents: {
      ...state.agents,
      [agent.id]: cloneAgent(agent),
    },
  });
}

export function upsertTask(state: ZergState, task: TaskRecord): ZergState {
  return updateZergState(state, {
    tasks: {
      ...state.tasks,
      [task.id]: cloneTask(task),
    },
  });
}

export function upsertTeam(state: ZergState, team: TeamIdentity): ZergState {
  return updateZergState(state, {
    teams: {
      ...state.teams,
      [team.id]: cloneTeam(team),
    },
  });
}

export function upsertTreeNode(state: ZergState, node: ZergTreeNode): ZergState {
  return updateZergState(state, {
    tree: {
      ...state.tree,
      [node.id]: cloneTreeNode(node),
    },
  });
}

export function appendHookEvent(state: ZergState, event: HookLifecycleEvent, maxEvents = 100): ZergState {
  const events = [...cloneEvents(state.events), cloneEvent(event)].slice(-Math.max(1, maxEvents));
  return updateZergState(state, { events });
}

export function selectNode(state: ZergState, selectedNodeId: string | undefined): ZergState {
  return updateZergState(state, { selectedNodeId });
}

export const MAX_INTERVENTION_MESSAGE_LENGTH = 240;
export const DEFAULT_PERMISSION_QUEUE_MAX_REQUESTS = 50;
export const MAX_PERMISSION_SUMMARY_LENGTH = 160;
export const MAX_PERMISSION_DETAILS_LENGTH = 480;
export const MAX_PERMISSION_REASON_LENGTH = 240;
export const DEFAULT_ZERG_LOG_MAX_RECORDS = 200;
export const MAX_ZERG_LOG_MESSAGE_LENGTH = 480;
const MAX_ZERG_LOG_DATA_DEPTH = 3;
const MAX_ZERG_LOG_DATA_KEYS = 24;
const MAX_ZERG_LOG_DATA_ARRAY_ITEMS = 20;
const MAX_ZERG_LOG_DATA_STRING_LENGTH = 160;
const ZERG_PERMISSION_EXTENSION_KEY = 'zergPermissions';
const ZERG_LOG_EXTENSION_KEY = 'zergLogs';

export interface EnqueuePermissionRequestInput {
  kind: ZergPermissionRequestKind;
  targetId?: string;
  agentId?: string;
  runId?: string;
  requester?: ZergPermissionRequester;
  summary: string;
  details?: string;
  expiresAt?: string;
  metadata?: ZergExtensionFields;
}

export interface PermissionQueueMutationOptions extends ZergRuntimeTransitionOptions {
  id?: string;
  maxRequests?: number;
  resolvedBy?: ZergPermissionResolver;
  reason?: string;
}

export interface AppendZergLogRecordInput {
  id?: string;
  runId?: string;
  agentId?: string;
  taskId?: string;
  teamId?: string;
  source: ZergLogSource;
  level?: ZergLogLevel;
  kind?: ZergOutputKind;
  message: string;
  data?: ZergExtensionFields;
  createdAt?: string;
}

export interface ZergLogMutationOptions extends ZergRuntimeTransitionOptions {
  maxRecords?: number;
}

export interface ZergLogFilter {
  runId?: string;
  level?: ZergLogLevel;
  limit?: number;
}

export function getPermissionQueueState(state: ZergState): ZergPermissionQueueState {
  return clonePermissionQueueState(readPermissionQueueCandidate(state), DEFAULT_PERMISSION_QUEUE_MAX_REQUESTS);
}

export function getPendingPermissionRequests(state: ZergState): ZergPermissionRequest[] {
  return getPermissionQueueState(state).requests
    .filter((request) => request.status === 'pending')
    .map(clonePermissionRequest);
}

export function getZergLogState(state: ZergState): ZergLogState {
  return cloneZergLogState(readZergLogCandidate(state), DEFAULT_ZERG_LOG_MAX_RECORDS);
}

export function appendZergLogRecord(
  state: ZergState,
  input: AppendZergLogRecordInput,
  options: ZergLogMutationOptions = {},
): ZergState {
  return appendZergLogRecords(state, [input], options);
}

export function appendZergLogRecords(
  state: ZergState,
  inputs: readonly AppendZergLogRecordInput[],
  options: ZergLogMutationOptions = {},
): ZergState {
  if (inputs.length === 0) {
    return state;
  }

  const timestamp = resolveStateTransitionTimestamp(state, options);
  const maxRecords = normalizeZergLogMax(options.maxRecords ?? getZergLogState(state).maxRecords);

  return updateZergState(state, (base) => {
    const currentLogState = getZergLogState(base);
    let nextSequence = Math.max(base.revision, ...currentLogState.records.map((record) => record.sequence ?? 0));
    const records = [...currentLogState.records];

    for (const input of inputs) {
      const message = sanitizeZergLogMessage(input.message);
      if (!message) {
        continue;
      }

      nextSequence += 1;
      records.push(cloneZergLogRecord({
        id: sanitizeZergLogId(input.id) || `log-${nextSequence}`,
        source: input.source,
        level: input.level ?? 'info',
        kind: input.kind ?? 'text',
        message,
        sequence: nextSequence,
        createdAt: input.createdAt ?? timestamp,
        runId: sanitizeOptionalLogText(input.runId, MAX_PERMISSION_SUMMARY_LENGTH),
        agentId: sanitizeOptionalLogText(input.agentId, MAX_PERMISSION_SUMMARY_LENGTH),
        taskId: sanitizeOptionalLogText(input.taskId, MAX_PERMISSION_SUMMARY_LENGTH),
        teamId: sanitizeOptionalLogText(input.teamId, MAX_PERMISSION_SUMMARY_LENGTH),
        data: sanitizeZergLogData(input.data),
      }));
    }

    const trimmedRecords = trimZergLogRecords(records, maxRecords);
    return {
      extensions: {
        ...base.extensions,
        [ZERG_LOG_EXTENSION_KEY]: cloneZergLogState({
          records: trimmedRecords,
          maxRecords,
          lastRecordId: trimmedRecords.at(-1)?.id ?? currentLogState.lastRecordId,
        }, maxRecords),
      },
    };
  }, { updatedAt: timestamp, preserveRevision: true });
}

export function getZergLogs(state: ZergState, filter: ZergLogFilter = {}): ZergLogRecord[] {
  const limit = normalizeZergLogLimit(filter.limit);
  const records = getZergLogState(state).records.filter((record) => {
    if (filter.runId && record.runId !== filter.runId) {
      return false;
    }

    if (filter.level && record.level !== filter.level) {
      return false;
    }

    return true;
  });

  return records.slice(-limit).map(cloneZergLogRecord);
}

export function enqueuePermissionRequest(
  state: ZergState,
  input: EnqueuePermissionRequestInput,
  options: PermissionQueueMutationOptions = {},
): ZergState {
  const timestamp = resolveStateTransitionTimestamp(state, options);
  const maxRequests = normalizePermissionQueueMax(options.maxRequests ?? getPermissionQueueState(state).maxRequests);
  const summary = sanitizePermissionText(input.summary, MAX_PERMISSION_SUMMARY_LENGTH);
  const details = sanitizeOptionalPermissionText(input.details, MAX_PERMISSION_DETAILS_LENGTH);
  const targetId = sanitizeOptionalPermissionText(input.targetId, MAX_PERMISSION_SUMMARY_LENGTH);
  const agentId = sanitizeOptionalPermissionText(input.agentId, MAX_PERMISSION_SUMMARY_LENGTH);
  const runId = sanitizeOptionalPermissionText(input.runId, MAX_PERMISSION_SUMMARY_LENGTH);

  if (!summary) {
    throw new Error('permission request summary must be non-empty');
  }

  return updateZergState(state, (base) => {
    const revision = base.revision + 1;
    const currentQueue = getPermissionQueueState(base);
    const request: ZergPermissionRequest = {
      id: sanitizePermissionId(options.id) || `perm-${revision}`,
      kind: input.kind,
      status: 'pending',
      requester: input.requester ?? 'operator',
      summary,
      createdAt: timestamp,
      ...(targetId ? { targetId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(runId ? { runId } : {}),
      ...(details ? { details } : {}),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      metadata: cloneOptional(input.metadata, cloneExtensionFields),
    };
    const requests = trimPermissionRequests([...currentQueue.requests, request], maxRequests);
    const queue = clonePermissionQueueState({
      requests,
      maxRequests,
      lastRequestId: request.id,
      pendingCount: countPendingPermissionRequests(requests),
    }, maxRequests);
    const event: HookLifecycleEvent = {
      id: `permission-${revision}`,
      type: 'permission',
      message: formatPermissionRequestEventMessage(request),
      sequence: revision,
      revision,
      createdAt: timestamp,
    };

    return {
      extensions: {
        ...base.extensions,
        [ZERG_PERMISSION_EXTENSION_KEY]: queue,
      },
      events: appendRuntimeEvent(base.events, event, options.maxEvents),
    };
  }, { updatedAt: timestamp });
}

export function resolvePermissionRequest(
  state: ZergState,
  requestId: string,
  decision: ZergPermissionDecision,
  options: PermissionQueueMutationOptions = {},
): ZergState {
  const queue = getPermissionQueueState(state);
  const normalizedId = sanitizePermissionId(requestId);
  const existing = queue.requests.find((request) => request.id === normalizedId);
  if (!existing || existing.status !== 'pending') {
    return state;
  }

  const timestamp = resolveStateTransitionTimestamp(state, options);
  const nextStatus = permissionStatusForDecision(decision);
  const reason = sanitizeOptionalPermissionText(options.reason, MAX_PERMISSION_REASON_LENGTH);
  const resolvedBy = options.resolvedBy ?? (decision === 'expire' ? 'zerg' : 'operator');
  const maxRequests = normalizePermissionQueueMax(options.maxRequests ?? queue.maxRequests);

  return updateZergState(state, (base) => {
    const revision = base.revision + 1;
    const currentQueue = getPermissionQueueState(base);
    const requests = trimPermissionRequests(currentQueue.requests.map((request) => {
      if (request.id !== normalizedId) {
        return request;
      }

      return clonePermissionRequest({
        ...request,
        status: nextStatus,
        resolvedAt: timestamp,
        resolvedBy,
        ...(reason ? { decisionReason: reason } : {}),
      });
    }), maxRequests);
    const resolved = requests.find((request) => request.id === normalizedId) ?? existing;
    const nextQueue = clonePermissionQueueState({
      requests,
      maxRequests,
      lastRequestId: currentQueue.lastRequestId,
      pendingCount: countPendingPermissionRequests(requests),
    }, maxRequests);
    const event: HookLifecycleEvent = {
      id: `permission-${revision}`,
      type: 'permission',
      message: formatPermissionResolutionEventMessage(resolved, decision, reason),
      sequence: revision,
      revision,
      createdAt: timestamp,
    };

    return {
      extensions: {
        ...base.extensions,
        [ZERG_PERMISSION_EXTENSION_KEY]: nextQueue,
      },
      events: appendRuntimeEvent(base.events, event, options.maxEvents),
    };
  }, { updatedAt: timestamp });
}

export function expirePermissionRequests(
  state: ZergState,
  options: PermissionQueueMutationOptions = {},
): ZergState {
  const timestamp = resolveStateTransitionTimestamp(state, options);
  const queue = getPermissionQueueState(state);
  const expiringIds = queue.requests
    .filter((request) => request.status === 'pending' && request.expiresAt !== undefined && request.expiresAt <= timestamp)
    .map((request) => request.id);

  if (expiringIds.length === 0) {
    return state;
  }

  const maxRequests = normalizePermissionQueueMax(options.maxRequests ?? queue.maxRequests);
  return updateZergState(state, (base) => {
    const revision = base.revision + 1;
    const currentQueue = getPermissionQueueState(base);
    const expiring = new Set(expiringIds);
    const requests = trimPermissionRequests(currentQueue.requests.map((request) => expiring.has(request.id)
      ? clonePermissionRequest({ ...request, status: 'expired', resolvedAt: timestamp, resolvedBy: options.resolvedBy ?? 'zerg' })
      : request), maxRequests);
    const nextQueue = clonePermissionQueueState({
      requests,
      maxRequests,
      lastRequestId: currentQueue.lastRequestId,
      pendingCount: countPendingPermissionRequests(requests),
    }, maxRequests);
    const event: HookLifecycleEvent = {
      id: `permission-${revision}`,
      type: 'permission',
      message: `permission expired: ${expiringIds.join(', ')}`,
      sequence: revision,
      revision,
      createdAt: timestamp,
    };

    return {
      extensions: {
        ...base.extensions,
        [ZERG_PERMISSION_EXTENSION_KEY]: nextQueue,
      },
      events: appendRuntimeEvent(base.events, event, options.maxEvents),
    };
  }, { updatedAt: timestamp });
}

export function setMode(state: ZergState, mode: Partial<PermissionModeState>): ZergState {
  return updateZergState(state, {
    mode: {
      ...state.mode,
      ...mode,
    },
  });
}

export function applyModeTransition(
  state: ZergState,
  transition: PermissionModeTransitionInput,
  options: ZergRuntimeTransitionOptions = {},
): ZergState {
  const timestamp = resolveStateTransitionTimestamp(state, options);

  return updateZergState(state, (base) => {
    const revision = base.revision + 1;
    const previousMode = clonePermissionModeSnapshot(base.mode);
    const contextId = Object.hasOwn(transition, 'contextId')
      ? transition.contextId
      : base.mode.contextId;
    const mode: PermissionModeState = {
      ...base.mode,
      automation: transition.automation,
      controller: transition.controller,
      interventionEnabled: transition.interventionEnabled,
      contextId,
      previousMode,
      activeIntervention: transition.clearActiveIntervention === false ? base.mode.activeIntervention : undefined,
      ...(transition.readOnly !== undefined || base.mode.readOnly !== undefined
        ? { readOnly: transition.readOnly ?? base.mode.readOnly }
        : {}),
    };
    const event: HookLifecycleEvent = {
      id: `mode-${revision}`,
      type: 'mode',
      message: buildModeTransitionMessage(previousMode, mode, transition),
      sequence: revision,
      revision,
      createdAt: timestamp,
      mode: cloneRuntimeMode(mode),
      previousMode,
    };

    return {
      mode,
      events: appendRuntimeEvent(base.events, event, options.maxEvents),
    };
  }, { updatedAt: timestamp });
}

export function applyInterventionRecord(
  state: ZergState,
  intervention: PermissionModeInterventionInput,
  options: ZergRuntimeTransitionOptions = {},
): ZergState {
  const timestamp = resolveStateTransitionTimestamp(state, options);

  return updateZergState(state, (base) => {
    const revision = base.revision + 1;
    const sanitized = {
      ...intervention,
      message: sanitizeInterventionMessage(intervention.message),
      createdAt: timestamp,
    };

    const mode: PermissionModeState = {
      ...base.mode,
      controller: 'operator',
      interventionEnabled: true,
      activeIntervention: sanitized,
      previousMode: base.mode.previousMode,
    };

    const event: HookLifecycleEvent = {
      id: `permission-${revision}`,
      type: 'permission',
      message: `intervention recorded: ${intervention.kind} ${intervention.targetId}`,
      sequence: revision,
      revision,
      createdAt: timestamp,
      mode: cloneRuntimeMode(mode),
      intervention: sanitized,
      previousMode: mode.previousMode,
    };

    return {
      mode,
      events: appendRuntimeEvent(base.events, event, options.maxEvents),
    };
  }, { updatedAt: timestamp });
}

export function resetZergState(seed?: Partial<ZergState>): ZergState {
  return createZergState(seed);
}

export function createZergStateContainer(seed?: Partial<ZergState>): ZergStateContainer {
  let current = createZergState(seed);
  const listeners = new Set<ZergStateListener>();

  const publish = () => {
    const snapshot = snapshotZergState(current);
    const listenerFailures: unknown[] = [];
    for (const listener of [...listeners]) {
      try {
        listener(snapshotZergState(snapshot));
      } catch (error) {
        listenerFailures.push(error);
      }
    }
    reportStateListenerFailures(listenerFailures);
    return snapshot;
  };

  return {
    read() {
      return snapshotZergState(current);
    },
    snapshot() {
      return snapshotZergState(current);
    },
    replace(nextState: Partial<ZergState> = createZergState()) {
      current = createZergState(nextState);
      return publish();
    },
    update(patch: ZergStatePatch, options?: ZergStateUpdateOptions) {
      current = updateZergState(current, patch, options);
      return publish();
    },
    subscribe(listener: ZergStateListener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function reportStateListenerFailures(failures: readonly unknown[]): void {
  if (failures.length === 0) {
    return;
  }

  const firstFailure = formatStateListenerFailure(failures[0]);
  const diagnostic = `pi-zerg-swarm state listener failure: ${failures.length} subscriber(s) failed${firstFailure ? `: ${firstFailure}` : ''}`
    .slice(0, MAX_ZERG_STATE_LISTENER_DIAGNOSTIC_LENGTH);
  try {
    globalThis.console?.error?.(diagnostic);
  } catch {
    // Diagnostics must never affect already-committed state updates.
  }
}

function formatStateListenerFailure(error: unknown): string {
  try {
    const message = error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : String(error);
    return message.slice(0, 120).replace(/\s+/g, ' ').trim();
  } catch {
    return 'unknown error';
  }
}

export let sharedZergState = createZergState();

export function readSharedZergState(): ZergState {
  return snapshotZergState(sharedZergState);
}

export function updateSharedZergState(patch: ZergStatePatch, options?: ZergStateUpdateOptions): ZergState {
  sharedZergState = updateZergState(sharedZergState, patch, options);
  return readSharedZergState();
}

export function replaceSharedZergState(nextState: Partial<ZergState> = createZergState()): ZergState {
  sharedZergState = createZergState(nextState);
  return readSharedZergState();
}


export interface ZergRuntimeTransitionOptions {
  now?: () => Date;
  maxEvents?: number;
}

export function applyRuntimeTransition(
  state: ZergState,
  transition: ZergRuntimeTransition,
  options: ZergRuntimeTransitionOptions = {},
): ZergState {
  const timestamp = resolveTransitionTimestamp(state, transition, options);

  return updateZergState(state, (base) => {
    const revision = base.revision + 1;
    const mode = resolveRuntimeMode(base.mode, transition);
    const status = resolveTransitionStatus(base, transition);
    const health = resolveTransitionHealth(base, transition);
    const activity = transition.activity?.trim() || defaultRuntimeActivity(transition.action);
    const substate = resolveTransitionSubstate(transition, activity);
    const substateReason = sanitizeLifecycleSubstateReason(transition.substateReason);
    const runtime = buildRuntimeState(
      getExistingRuntime(base, transition),
      transition,
      timestamp,
      mode,
      health,
      activity,
      revision,
      substate,
      substateReason,
    );
    const event: HookLifecycleEvent = {
      id: `runtime-${revision}`,
      type: transition.entity,
      message: formatRuntimeEventMessage(transition, activity),
      status,
      action: transition.action,
      health,
      substate,
      substateReason,
      mode,
      sequence: revision,
      revision,
      createdAt: timestamp,
      ...(transition.entity === 'agent' ? { agentId: transition.id } : { teamId: transition.id }),
    };

    if (transition.entity === 'agent') {
      return {
        agents: {
          ...base.agents,
          [transition.id]: buildAgentIdentity(base.agents[transition.id], transition, status, runtime),
        },
        events: appendRuntimeEvent(base.events, event, options.maxEvents),
        mode,
      };
    }

    return {
      teams: {
        ...base.teams,
        [transition.id]: buildTeamIdentity(base.teams[transition.id], transition, status, runtime),
      },
      events: appendRuntimeEvent(base.events, event, options.maxEvents),
      mode,
    };
  }, { updatedAt: timestamp });
}

export function replayRuntimeTransitions(
  seed: Partial<ZergState> | ZergState,
  transitions: readonly ZergRuntimeTransition[],
  options: ZergRuntimeTransitionOptions = {},
): ZergState {
  return transitions.reduce((current, transition) => applyRuntimeTransition(current, transition, options), createZergState(seed));
}


function resolveStateTransitionTimestamp(
  state: ZergState,
  options: ZergRuntimeTransitionOptions,
): string {
  return options.now?.().toISOString() ?? state.metadata.updatedAt;
}

function resolveTransitionTimestamp(
  state: ZergState,
  transition: ZergRuntimeTransition,
  options: ZergRuntimeTransitionOptions,
): string {
  return transition.at ?? options.now?.().toISOString() ?? state.metadata.updatedAt;
}

function resolveRuntimeMode(stateMode: PermissionModeState, transition: ZergRuntimeTransition): ZergRuntimeModeContext {
  return {
    automation: transition.mode?.automation ?? stateMode.automation,
    interventionEnabled: transition.mode?.interventionEnabled ?? stateMode.interventionEnabled,
    controller: transition.mode?.controller ?? stateMode.controller,
    activeIntervention: transition.mode?.activeIntervention ?? stateMode.activeIntervention,
    contextId: transition.contextId ?? transition.mode?.contextId ?? stateMode.contextId,
    readOnly: transition.mode?.readOnly ?? stateMode.readOnly,
  };
}

function buildModeTransitionMessage(
  previousMode: PermissionModeSnapshot,
  nextMode: PermissionModeState,
  transition: PermissionModeTransitionInput,
): string {
  const baseMessage = `mode transition ${previousMode.automation}/${previousMode.controller} -> ${nextMode.automation}/${nextMode.controller}`;
  return transition.reason ? `${baseMessage}: ${transition.reason}` : baseMessage;
}

function sanitizeInterventionMessage(message: string, maxLength: number = MAX_INTERVENTION_MESSAGE_LENGTH): string {
  const sanitized = message
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return sanitized.slice(0, maxLength);
}

function getExistingRuntime(state: ZergState, transition: ZergRuntimeTransition): ZergRuntimeState | undefined {
  return transition.entity === 'agent' ? state.agents[transition.id]?.runtime : state.teams[transition.id]?.runtime;
}

function resolveTransitionStatus(state: ZergState, transition: ZergRuntimeTransition): AgentStatus {
  if (transition.status) {
    return transition.status;
  }

  switch (transition.action) {
    case 'start':
    case 'progress':
      return 'running';
    case 'stop':
      return 'done';
    case 'fail':
      return 'failed';
    case 'reset':
      return 'idle';
    case 'create':
      return getExistingStatus(state, transition) ?? 'idle';
  }
}

function getExistingStatus(state: ZergState, transition: ZergRuntimeTransition): AgentStatus | undefined {
  return transition.entity === 'agent' ? state.agents[transition.id]?.status : state.teams[transition.id]?.status;
}

function resolveTransitionHealth(state: ZergState, transition: ZergRuntimeTransition): ZergRuntimeHealth {
  if (transition.health) {
    return transition.health;
  }

  switch (transition.action) {
    case 'start':
    case 'progress':
      return 'healthy';
    case 'stop':
      return 'stopped';
    case 'fail':
      return 'failed';
    case 'reset':
      return 'unknown';
    case 'create':
      return getExistingRuntime(state, transition)?.health ?? 'unknown';
  }
}

function buildRuntimeState(
  existing: ZergRuntimeState | undefined,
  transition: ZergRuntimeTransition,
  timestamp: string,
  mode: ZergRuntimeModeContext,
  health: ZergRuntimeHealth,
  activity: string,
  activitySequence: number,
  substate: ZergLifecycleSubstate,
  substateReason: string | undefined,
): ZergRuntimeState {
  const createdAt = existing?.createdAt ?? timestamp;
  const activityMetadata = {
    lastActivity: activity,
    lastActivityAt: timestamp,
    lastActivitySequence: activitySequence,
    lastActivityRevision: activitySequence,
    substate,
    substateReason,
    substateUpdatedAt: timestamp,
  } as const;

  if (transition.action === 'reset') {
    return {
      createdAt,
      updatedAt: timestamp,
      health,
      mode,
      ...activityMetadata,
    };
  }

  return {
    createdAt,
    updatedAt: timestamp,
    startedAt: transition.action === 'start' ? timestamp : existing?.startedAt,
    stoppedAt: transition.action === 'stop' || transition.action === 'fail' ? timestamp : existing?.stoppedAt,
    ...activityMetadata,
    health,
    mode,
  };
}

function buildAgentIdentity(
  existing: AgentIdentity | undefined,
  transition: ZergAgentRuntimeTransition,
  status: AgentStatus,
  runtime: ZergRuntimeState,
): AgentIdentity {
  return {
    ...(existing ?? {}),
    id: transition.id,
    label: transition.label?.trim() || existing?.label || transition.id,
    kind: isAgentKind(transition.kind) ? transition.kind : existing?.kind ?? 'subagent',
    status,
    parentId: transition.parentId ?? existing?.parentId,
    teamId: transition.teamId ?? existing?.teamId,
    childIds: mergeStrings(existing?.childIds, transition.childIds),
    contextId: transition.contextId ?? existing?.contextId,
    runtime,
    metadata: {
      ...existing?.metadata,
      ...cloneExtensionFields(transition.metadata),
    },
  };
}

function buildTeamIdentity(
  existing: TeamIdentity | undefined,
  transition: ZergTeamRuntimeTransition,
  status: AgentStatus,
  runtime: ZergRuntimeState,
): TeamIdentity {
  return {
    ...(existing ?? {}),
    id: transition.id,
    label: transition.label?.trim() || existing?.label || transition.id,
    kind: isTeamKind(transition.kind) ? transition.kind : existing?.kind ?? 'team',
    status,
    leaderAgentId: transition.leaderAgentId ?? existing?.leaderAgentId,
    memberAgentIds: mergeStrings(existing?.memberAgentIds, transition.memberAgentIds) ?? [],
    parentTeamId: transition.parentTeamId ?? existing?.parentTeamId,
    taskIds: mergeStrings(existing?.taskIds, transition.taskIds),
    runtime,
    metadata: {
      ...existing?.metadata,
      ...cloneExtensionFields(transition.metadata),
    },
  };
}

function appendRuntimeEvent(events: readonly HookLifecycleEvent[], event: HookLifecycleEvent, maxEvents = 100): HookLifecycleEvent[] {
  return [...cloneEvents(events), cloneEvent(event)].slice(-Math.max(1, maxEvents));
}

function formatRuntimeEventMessage(transition: ZergRuntimeTransition, activity: string): string {
  return `${transition.entity} ${transition.id} ${transition.action}: ${activity}`;
}

function resolveTransitionSubstate(transition: ZergRuntimeTransition, activity: string): ZergLifecycleSubstate {
  if (isLifecycleSubstate(transition.substate)) {
    return transition.substate;
  }

  if (transition.action === 'progress') {
    return inferLifecycleSubstateFromActivity(activity, 'executing');
  }

  if (transition.status === 'cancelled') {
    return 'cancelled';
  }

  switch (transition.action) {
    case 'create':
      return 'queued';
    case 'start':
      return 'starting';
    case 'stop':
      return 'completed';
    case 'fail':
      return 'failed';
    case 'reset':
      return 'reset';
  }
}

function inferLifecycleSubstateFromActivity(activity: string, fallback: ZergLifecycleSubstate): ZergLifecycleSubstate {
  const normalized = activity.toLowerCase();
  if (normalized.includes('permission')) return 'waiting-permission';
  if (normalized.includes('input')) return 'waiting-input';
  if (normalized.includes('compact')) return 'compacting';
  if (normalized.includes('stream')) return 'streaming-output';
  if (normalized.includes('tool')) return 'tool-running';
  return fallback;
}

function isLifecycleSubstate(value: unknown): value is ZergLifecycleSubstate {
  return value === 'queued'
    || value === 'spawning'
    || value === 'starting'
    || value === 'planning'
    || value === 'waiting-permission'
    || value === 'waiting-input'
    || value === 'executing'
    || value === 'tool-running'
    || value === 'streaming-output'
    || value === 'compacting'
    || value === 'idle'
    || value === 'stopping'
    || value === 'cancelling'
    || value === 'completed'
    || value === 'failed'
    || value === 'cancelled'
    || value === 'reset';
}

function sanitizeLifecycleSubstateReason(reason: string | undefined): string | undefined {
  if (reason === undefined) {
    return undefined;
  }

  const sanitized = reason
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_LIFECYCLE_SUBSTATE_REASON_LENGTH);

  return sanitized || undefined;
}

function defaultRuntimeActivity(action: ZergRuntimeTransition['action']): string {
  switch (action) {
    case 'create':
      return 'created';
    case 'start':
      return 'started';
    case 'progress':
      return 'progress updated';
    case 'stop':
      return 'stopped';
    case 'fail':
      return 'failed';
    case 'reset':
      return 'reset';
  }
}

function isAgentKind(value: ZergRuntimeTransition['kind']): value is AgentKind {
  return value === 'subagent' || value === 'teammate' || value === 'team-leader';
}

function isTeamKind(value: ZergRuntimeTransition['kind']): value is TeamKind {
  return value === 'team' || value === 'squad' || value === 'worktree';
}

function mergeStrings(existing: string[] | undefined, incoming: string[] | undefined): string[] | undefined {
  const merged = [...new Set([...(existing ?? []), ...(incoming ?? [])])];
  return merged.length > 0 ? merged : undefined;
}

function normalizeOptionalConfigText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function dedupeSortedTools(tools: string[] | undefined): string[] | undefined {
  if (!tools || tools.length === 0) {
    return undefined;
  }

  const deduped = [...new Set(tools.map((tool) => (typeof tool === 'string' ? tool.trim() : '')))]
    .filter((tool) => tool.length > 0)
    .sort((left, right) => left.localeCompare(right));

  return deduped.length > 0 ? deduped : undefined;
}

const SUBAGENT_RUN_ID_PREFIX = 'zerg-';

function getSubagentRunById(state: ZergState, runId: string): ZergSubagentRunSnapshot | undefined {
  const agent = state.agents[runId];
  if (!agent || !isPiSubagentRunAgentId(agent.id)) {
    return undefined;
  }

  return fromAgentToRunSnapshot(agent);
}

function isPiSubagentRunAgentId(id: string): boolean {
  return id.startsWith(SUBAGENT_RUN_ID_PREFIX);
}

function cloneSubagentRunSnapshot(run: ZergSubagentRunSnapshot): ZergSubagentRunSnapshot {
  return {
    ...run,
    ...(run.nativeSessions !== undefined ? { nativeSessions: normalizeNativeSessionReferences(run.nativeSessions, run.runId) } : {}),
    metadata: cloneRunMetadata(run.metadata, run.runId),
  };
}

/** Validate only scalar identity data; paths remain inert locators. Last exact member wins. */
function normalizeNativeSessionReferences(value: unknown, parentRunId: string): ZergNativeSessionReference[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return [];
  const references = new Map<string, ZergNativeSessionReference>();
  const text = (input: unknown): input is string => typeof input === 'string'
    && input.trim().length > 0 && input.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(input);
  const timestamp = (input: unknown): input is string => text(input) && Number.isFinite(Date.parse(input));
  for (const entry of value) {
    if (!isPlainRecord(entry) || entry.schemaVersion !== 1 || entry.parentRunId !== parentRunId
      || !text(entry.memberRunId) || !text(entry.agentDefinitionId) || !text(entry.piSessionId)
      || !text(entry.sessionFile) || !text(entry.cwd) || !timestamp(entry.createdAt)
      || (entry.attachment !== 'attached' && entry.attachment !== 'disposed' && entry.attachment !== 'unavailable')
      || (entry.disposedAt !== undefined && !timestamp(entry.disposedAt))
      || (entry.recoveredAt !== undefined && !timestamp(entry.recoveredAt))) continue;
    references.set(entry.memberRunId, {
      schemaVersion: 1, parentRunId, memberRunId: entry.memberRunId,
      agentDefinitionId: entry.agentDefinitionId, piSessionId: entry.piSessionId,
      sessionFile: entry.sessionFile, cwd: entry.cwd, createdAt: entry.createdAt,
      attachment: entry.attachment as ZergNativeSessionReference['attachment'],
      ...(entry.disposedAt !== undefined ? { disposedAt: entry.disposedAt as string } : {}),
      ...(entry.recoveredAt !== undefined ? { recoveredAt: entry.recoveredAt as string } : {}),
    });
  }
  return [...references.values()];
}

function cloneRunMetadata(metadata: ZergExtensionFields | undefined, parentRunId: string): ZergExtensionFields | undefined {
  const cloned = cloneOptional(metadata, cloneExtensionFields);
  if (cloned && 'nativeSessions' in cloned) {
    const nativeSessions = normalizeNativeSessionReferences(cloned.nativeSessions, parentRunId);
    if (nativeSessions === undefined) delete cloned.nativeSessions;
    else cloned.nativeSessions = nativeSessions;
  }
  if (cloned && Object.hasOwn(cloned, 'nativeContinuation')) {
    const lineage = normalizeNativeContinuationLineage(cloned.nativeContinuation);
    if (!lineage) delete cloned.nativeContinuation;
    else cloned.nativeContinuation = lineage;
  }
  return cloned;
}

export function normalizeNativeContinuationLineage(value: unknown): import('./types.js').ZergNativeContinuationLineage | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  const fields = ['schemaVersion', 'source', 'entryId', 'sourceFingerprint', 'policyDigest', 'policy'];
  if (Object.keys(data).length !== fields.length || fields.some((key) => !Object.hasOwn(data, key)) || data.schemaVersion !== 1) return undefined;
  if (typeof data.entryId !== 'string' || !data.entryId || data.entryId.length > 256 || /[\s\u0000-\u001f\u007f-\u009f]/.test(data.entryId)) return undefined;
  if (typeof data.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(data.sourceFingerprint) || typeof data.policyDigest !== 'string' || !/^[a-f0-9]{64}$/.test(data.policyDigest)) return undefined;
  if (!data.source || typeof data.source !== 'object' || Array.isArray(data.source) || !data.policy || typeof data.policy !== 'object' || Array.isArray(data.policy)) return undefined;
  const source = data.source as Record<string, unknown>;
  const sourceFields = ['schemaVersion', 'parentRunId', 'memberRunId', 'agentDefinitionId', 'piSessionId', 'sessionFile', 'cwd', 'createdAt'];
  if (source.schemaVersion !== 1 || Object.keys(source).length !== sourceFields.length || sourceFields.slice(1).some((key) => typeof source[key] !== 'string' || !(source[key] as string).length || (source[key] as string).length > 4096 || /[\u0000-\u001f\u007f-\u009f]/.test(source[key] as string))) return undefined;
  const policy = data.policy as Record<string, unknown>;
  if (policy.schemaVersion !== 1 || policy.resourcePolicy !== 'normal-default-resource-loader' || typeof policy.model !== 'string' || typeof policy.cwd !== 'string' || typeof policy.authorityInstruction !== 'string' || typeof policy.thinkingLevel !== 'string' || !Array.isArray(policy.inputs) || policy.inputs.length > 128 || !Array.isArray(policy.context) || policy.context.length > 32) return undefined;
  try {
    const policyText = JSON.stringify(policy);
    const text = JSON.stringify(data);
    if (policyText.length > 32768 || text.length > 49152) return undefined;
    return JSON.parse(text) as import('./types.js').ZergNativeContinuationLineage;
  } catch { return undefined; }
}

function fromAgentToRunSnapshot(agent: AgentIdentity): ZergSubagentRunSnapshot {
  const runtimeTask = agent.runtime?.lastActivity;
  const runtime = agent.runtime;
  const metadata = cloneRunMetadata(agent.metadata, agent.id);
  const taskId = typeof metadata?.taskId === 'string' ? metadata.taskId : undefined;
  const launchMode = metadata?.launchMode === 'fork' || metadata?.launchMode === 'fresh' ? metadata.launchMode : undefined;
  const agentDefinitionId = typeof metadata?.agentDefinitionId === 'string' ? metadata.agentDefinitionId : undefined;
  const originalTask = typeof metadata?.originalTask === 'string'
    ? metadata.originalTask
    : typeof metadata?.task === 'string' ? metadata.task : undefined;
  const recovery = isPlainRecord(metadata?.recovery)
    ? {
      recoveredAt: typeof metadata.recovery.recoveredAt === 'string' ? metadata.recovery.recoveredAt : '',
      reason: 'process-restart' as const,
      previousStatus: typeof metadata.recovery.previousStatus === 'string' ? metadata.recovery.previousStatus as ZergSubagentRunSnapshot['status'] : undefined,
      previousSubstate: typeof metadata.recovery.previousSubstate === 'string' ? metadata.recovery.previousSubstate as ZergSubagentRunSnapshot['substate'] : undefined,
      previousWriterSessionId: typeof metadata.recovery.previousWriterSessionId === 'string' ? metadata.recovery.previousWriterSessionId : undefined,
    }
    : undefined;
  return {
    runId: agent.id,
    agentId: agentDefinitionId ?? agent.id,
    agentDefinitionId,
    agentLabel: agent.label,
    status: agent.status || 'unknown',
    task: originalTask ?? runtimeTask,
    taskId,
    launchMode,
    substate: runtime?.substate,
    substateReason: runtime?.substateReason,
    substateUpdatedAt: runtime?.substateUpdatedAt,
    startedAt: runtime?.startedAt,
    updatedAt: runtime?.updatedAt,
    completedAt: typeof metadata?.completedAt === 'string' ? metadata.completedAt : undefined,
    finalSummary: typeof metadata?.finalSummary === 'string' ? metadata.finalSummary : undefined,
    errorSummary: typeof metadata?.errorSummary === 'string' ? metadata.errorSummary : undefined,
    ...(recovery?.recoveredAt ? { recovery } : {}),
    memberProgress: Array.isArray(metadata?.memberProgress) ? metadata.memberProgress.map((member) => ({ ...(member as Record<string, unknown>) })) as unknown as ZergSubagentRunSnapshot['memberProgress'] : undefined,
    ...(metadata?.nativeSessions !== undefined ? { nativeSessions: normalizeNativeSessionReferences(metadata.nativeSessions, agent.id) } : {}),
    ...(metadata?.nativeContinuation !== undefined ? { nativeContinuation: normalizeNativeContinuationLineage(metadata.nativeContinuation) } : {}),
    metadata,
  };
}

function readZergLogCandidate(state: ZergState): Partial<ZergLogState> | undefined {
  const candidate = state.extensions[ZERG_LOG_EXTENSION_KEY];
  return isPlainRecord(candidate) ? candidate as Partial<ZergLogState> : undefined;
}

function cloneZergLogState(
  logState: Partial<ZergLogState> | undefined,
  fallbackMaxRecords: number,
): ZergLogState {
  const maxRecords = normalizeZergLogMax(logState?.maxRecords ?? fallbackMaxRecords);
  const rawRecords = Array.isArray(logState?.records) ? logState.records : [];
  const records = trimZergLogRecords(rawRecords
    .filter(isZergLogRecordLike)
    .map((record) => cloneZergLogRecord(record)), maxRecords);
  const lastRecordId = typeof logState?.lastRecordId === 'string' && logState.lastRecordId.trim()
    ? logState.lastRecordId.trim()
    : records.at(-1)?.id;

  return {
    records,
    maxRecords,
    lastRecordId,
  };
}

function cloneZergLogRecord(record: ZergLogRecord): ZergLogRecord {
  return {
    id: record.id,
    source: record.source,
    level: record.level,
    kind: record.kind,
    message: record.message,
    createdAt: record.createdAt,
    runId: record.runId,
    agentId: record.agentId,
    taskId: record.taskId,
    teamId: record.teamId,
    data: sanitizeZergLogData(record.data),
    sequence: record.sequence,
  };
}

function isZergLogRecordLike(value: unknown): value is ZergLogRecord {
  if (!isPlainRecord(value)) {
    return false;
  }

  return typeof value.id === 'string'
    && isZergLogSource(value.source)
    && isZergLogLevel(value.level)
    && isZergOutputKind(value.kind)
    && typeof value.message === 'string'
    && typeof value.createdAt === 'string';
}

function isZergLogLevel(value: unknown): value is ZergLogLevel {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

function isZergLogSource(value: unknown): value is ZergLogSource {
  return value === 'command' || value === 'adapter' || value === 'permission' || value === 'lifecycle' || value === 'overlay' || value === 'pi-event';
}

function isZergOutputKind(value: unknown): value is ZergOutputKind {
  return value === 'text' || value === 'json' || value === 'tool' || value === 'thinking' || value === 'result' || value === 'error';
}

function normalizeZergLogMax(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_ZERG_LOG_MAX_RECORDS;
}

function normalizeZergLogLimit(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : DEFAULT_ZERG_LOG_MAX_RECORDS;
}

function trimZergLogRecords(records: ZergLogRecord[], maxRecords: number): ZergLogRecord[] {
  return records.map(cloneZergLogRecord).slice(-normalizeZergLogMax(maxRecords));
}

function sanitizeZergLogId(value: string | undefined): string {
  return sanitizeZergLogMessage(value ?? '').replace(/\s+/g, '-');
}

function sanitizeZergLogMessage(value: string): string {
  return value
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_ZERG_LOG_MESSAGE_LENGTH);
}

function sanitizeOptionalLogText(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const sanitized = sanitizeZergLogMessage(value).slice(0, maxLength);
  return sanitized || undefined;
}

function sanitizeZergLogData(value: ZergExtensionFields | undefined): ZergExtensionFields | undefined {
  if (!value) {
    return undefined;
  }

  const sanitized = sanitizeZergLogDataValue(value, 0, new Set());
  return isPlainRecord(sanitized) && Object.keys(sanitized).length > 0 ? sanitized : undefined;
}

function sanitizeZergLogDataValue(value: unknown, depth: number, seen: Set<object>): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return Number.isNaN(value) ? undefined : value;
  }

  if (typeof value === 'string') {
    return sanitizeZergLogMessage(value).slice(0, MAX_ZERG_LOG_DATA_STRING_LENGTH);
  }

  if (typeof value !== 'object' || depth >= MAX_ZERG_LOG_DATA_DEPTH) {
    return undefined;
  }

  if (seen.has(value)) {
    return undefined;
  }

  seen.add(value);
  if (Array.isArray(value)) {
    const output = value
      .slice(0, MAX_ZERG_LOG_DATA_ARRAY_ITEMS)
      .map((item) => sanitizeZergLogDataValue(item, depth + 1, seen))
      .filter((item) => item !== undefined);
    seen.delete(value);
    return output;
  }

  if (!isPlainRecord(value)) {
    seen.delete(value);
    return undefined;
  }

  const entries = Object.entries(value).slice(0, MAX_ZERG_LOG_DATA_KEYS);
  const output: Record<string, unknown> = {};
  for (const [key, nested] of entries) {
    const sanitizedKey = sanitizeZergLogMessage(key).slice(0, 64);
    if (!sanitizedKey) {
      continue;
    }

    const sanitizedValue = sanitizeZergLogDataValue(nested, depth + 1, seen);
    if (sanitizedValue !== undefined) {
      output[sanitizedKey] = sanitizedValue;
    }
  }
  seen.delete(value);
  return output;
}

function readPermissionQueueCandidate(state: ZergState): Partial<ZergPermissionQueueState> | undefined {
  const candidate = state.extensions[ZERG_PERMISSION_EXTENSION_KEY];
  return isPlainRecord(candidate) ? candidate as Partial<ZergPermissionQueueState> : undefined;
}

function clonePermissionQueueState(
  queue: Partial<ZergPermissionQueueState> | undefined,
  fallbackMaxRequests: number,
): ZergPermissionQueueState {
  const maxRequests = normalizePermissionQueueMax(queue?.maxRequests ?? fallbackMaxRequests);
  const rawRequests = Array.isArray(queue?.requests) ? queue.requests : [];
  const requests = trimPermissionRequests(rawRequests
    .filter(isPermissionRequestLike)
    .map((request) => clonePermissionRequest(request)), maxRequests);
  const lastRequestId = typeof queue?.lastRequestId === 'string' && queue.lastRequestId.trim()
    ? queue.lastRequestId.trim()
    : requests.at(-1)?.id;

  return {
    requests,
    maxRequests,
    lastRequestId,
    pendingCount: countPendingPermissionRequests(requests),
  };
}

function clonePermissionRequest(request: ZergPermissionRequest): ZergPermissionRequest {
  return {
    id: request.id,
    kind: request.kind,
    status: request.status,
    requester: request.requester,
    summary: request.summary,
    createdAt: request.createdAt,
    targetId: request.targetId,
    agentId: request.agentId,
    runId: request.runId,
    details: request.details,
    expiresAt: request.expiresAt,
    resolvedAt: request.resolvedAt,
    resolvedBy: request.resolvedBy,
    decisionReason: request.decisionReason,
    metadata: cloneOptional(request.metadata, cloneExtensionFields),
  };
}

function isPermissionRequestLike(value: unknown): value is ZergPermissionRequest {
  if (!isPlainRecord(value)) {
    return false;
  }

  return typeof value.id === 'string'
    && isPermissionRequestKind(value.kind)
    && isPermissionRequestStatus(value.status)
    && isPermissionRequester(value.requester)
    && typeof value.summary === 'string'
    && typeof value.createdAt === 'string';
}

function isPermissionRequestKind(value: unknown): value is ZergPermissionRequestKind {
  return value === 'run' || value === 'interrupt' || value === 'tool' || value === 'mode' || value === 'intervention' || value === 'adapter';
}

function isPermissionRequestStatus(value: unknown): value is ZergPermissionRequestStatus {
  return value === 'pending' || value === 'approved' || value === 'denied' || value === 'cancelled' || value === 'expired';
}

function isPermissionRequester(value: unknown): value is ZergPermissionRequester {
  return value === 'operator' || value === 'pi' || value === 'zerg' || value === 'adapter';
}

function normalizePermissionQueueMax(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : DEFAULT_PERMISSION_QUEUE_MAX_REQUESTS;
}

function trimPermissionRequests(requests: ZergPermissionRequest[], maxRequests: number): ZergPermissionRequest[] {
  const normalizedMax = normalizePermissionQueueMax(maxRequests);
  const cloned = requests.map(clonePermissionRequest);
  if (cloned.length <= normalizedMax) {
    return cloned;
  }

  const pending = cloned.filter((request) => request.status === 'pending');
  if (pending.length >= normalizedMax) {
    return pending.slice(-normalizedMax);
  }

  const resolvedSlots = normalizedMax - pending.length;
  const resolved = cloned.filter((request) => request.status !== 'pending').slice(-resolvedSlots);
  const selected = new Set([...pending, ...resolved]);
  return cloned.filter((request) => selected.has(request));
}

function countPendingPermissionRequests(requests: readonly ZergPermissionRequest[]): number {
  return requests.filter((request) => request.status === 'pending').length;
}

function sanitizePermissionId(value: string | undefined): string {
  return sanitizePermissionText(value ?? '', MAX_PERMISSION_SUMMARY_LENGTH).replace(/\s+/g, '-');
}

function sanitizePermissionText(value: string, maxLength: number): string {
  return value
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function sanitizeOptionalPermissionText(value: string | undefined, maxLength: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const sanitized = sanitizePermissionText(value, maxLength);
  return sanitized || undefined;
}

function permissionStatusForDecision(decision: ZergPermissionDecision): Exclude<ZergPermissionRequestStatus, 'pending'> {
  switch (decision) {
    case 'approve':
      return 'approved';
    case 'deny':
      return 'denied';
    case 'cancel':
      return 'cancelled';
    case 'expire':
      return 'expired';
  }
}

function formatPermissionRequestEventMessage(request: ZergPermissionRequest): string {
  const target = request.targetId ? ` ${request.targetId}` : '';
  return `permission requested: ${request.id} ${request.kind}${target} - ${request.summary}`;
}

function formatPermissionResolutionEventMessage(request: ZergPermissionRequest, decision: ZergPermissionDecision, reason: string | undefined): string {
  return `permission ${decision}: ${request.id}${reason ? ` - ${reason}` : ''}`;
}

function cloneAgentDefinitions(definitions: Record<string, ZergAgentDefinition> = {}): Record<string, ZergAgentDefinition> {
  return Object.fromEntries(Object.entries(definitions).map(([id, definition]) => [id, cloneAgentDefinition(definition)]));
}

function cloneAgents(agents: Record<string, AgentIdentity> = {}): Record<string, AgentIdentity> {
  return Object.fromEntries(Object.entries(agents).map(([id, agent]) => [id, cloneAgent(agent)]));
}

function cloneTasks(tasks: Record<string, TaskRecord> = {}): Record<string, TaskRecord> {
  return Object.fromEntries(Object.entries(tasks).map(([id, task]) => [id, cloneTask(task)]));
}

function cloneTeams(teams: Record<string, TeamIdentity> = {}): Record<string, TeamIdentity> {
  return Object.fromEntries(Object.entries(teams).map(([id, team]) => [id, cloneTeam(team)]));
}

function cloneTree(tree: Record<string, ZergTreeNode> = {}): Record<string, ZergTreeNode> {
  return Object.fromEntries(Object.entries(tree).map(([id, node]) => [id, cloneTreeNode(node)]));
}

function cloneEvents(events: readonly HookLifecycleEvent[] = []): HookLifecycleEvent[] {
  return events.map(cloneEvent);
}

function cloneAgent(agent: AgentIdentity): AgentIdentity {
  return {
    ...agent,
    childIds: cloneArray(agent.childIds),
    runtime: cloneOptional(agent.runtime, cloneRuntimeState),
    metadata: isPiSubagentRunAgentId(agent.id)
      ? cloneRunMetadata(agent.metadata, agent.id)
      : cloneOptional(agent.metadata, cloneExtensionFields),
    extensions: cloneOptional(agent.extensions, cloneExtensionFields),
  };
}

function cloneAgentDefinition(definition: ZergAgentDefinition): ZergAgentDefinition {
  const { result_schema, may_write, ...baseDefinition } = definition;
  return {
    ...baseDefinition,
    ...(result_schema === undefined ? {} : { result_schema: structuredClone(result_schema) }),
    ...(may_write === undefined ? {} : { may_write: cloneArray(may_write) }),
    fallbackModels: cloneOptional(definition.fallbackModels, cloneArray),
    tools: cloneOptional(definition.tools, cloneArray),
    disallowedTools: cloneOptional(definition.disallowedTools, cloneArray),
    metadata: cloneOptional(definition.metadata, cloneExtensionFields),
    extensions: cloneOptional(definition.extensions, cloneExtensionFields),
  };
}

function cloneTask(task: TaskRecord): TaskRecord {
  return {
    ...task,
    blockedBy: cloneArray(task.blockedBy),
    metadata: cloneOptional(task.metadata, cloneExtensionFields),
    extensions: cloneOptional(task.extensions, cloneExtensionFields),
  };
}

function cloneTeam(team: TeamIdentity): TeamIdentity {
  return {
    ...team,
    memberAgentIds: [...team.memberAgentIds],
    taskIds: cloneArray(team.taskIds),
    runtime: cloneOptional(team.runtime, cloneRuntimeState),
    metadata: cloneOptional(team.metadata, cloneExtensionFields),
    extensions: cloneOptional(team.extensions, cloneExtensionFields),
  };
}

function cloneTreeNode(node: ZergTreeNode): ZergTreeNode {
  return {
    ...node,
    childIds: [...node.childIds],
    metadata: cloneOptional(node.metadata, cloneExtensionFields),
    extensions: cloneOptional(node.extensions, cloneExtensionFields),
  };
}

function cloneEvent(event: HookLifecycleEvent): HookLifecycleEvent {
  return {
    ...event,
    mode: cloneOptional(event.mode, cloneRuntimeMode),
    intervention: cloneOptional(event.intervention, clonePermissionModeIntervention),
    previousMode: cloneOptional(event.previousMode, clonePermissionModeSnapshot),
  };
}

function cloneRuntimeState(runtime: ZergRuntimeState): ZergRuntimeState {
  return {
    ...runtime,
    mode: cloneRuntimeMode(runtime.mode),
  };
}

function cloneRuntimeMode(mode: ZergRuntimeModeContext): ZergRuntimeModeContext {
  return {
    ...mode,
    activeIntervention: cloneOptional(mode.activeIntervention, clonePermissionModeIntervention),
  };
}

function cloneMode(mode?: Partial<PermissionModeState>): PermissionModeState {
  const cloned: PermissionModeState = {
    ...DEFAULT_MODE,
    ...mode,
  };

  if (mode?.activeIntervention !== undefined) {
    cloned.activeIntervention = clonePermissionModeIntervention(mode.activeIntervention);
  } else {
    delete cloned.activeIntervention;
  }

  if (mode?.previousMode !== undefined) {
    cloned.previousMode = clonePermissionModeSnapshot(mode.previousMode);
  } else {
    delete cloned.previousMode;
  }

  return cloned;
}

function clonePermissionModeIntervention(intervention?: PermissionModeIntervention): PermissionModeIntervention {
  return { ...intervention! };
}

function clonePermissionModeSnapshot(snapshot?: PermissionModeSnapshot): PermissionModeSnapshot {
  const cloned: PermissionModeSnapshot = {
    automation: snapshot?.automation ?? DEFAULT_MODE.automation,
    interventionEnabled: snapshot?.interventionEnabled ?? DEFAULT_MODE.interventionEnabled,
    controller: snapshot?.controller ?? DEFAULT_MODE.controller,
    contextId: snapshot?.contextId,
  };

  if (snapshot?.readOnly !== undefined) {
    cloned.readOnly = snapshot.readOnly;
  }

  return cloned;
}

function cloneContext(context?: ZergContext): ZergContext | undefined {
  if (!context) {
    return undefined;
  }

  return {
    ...context,
    metadata: cloneOptional(context.metadata, cloneExtensionFields),
  };
}

function cloneMetadata(metadata: Partial<ZergState['metadata']> = {}): ZergState['metadata'] {
  return {
    createdAt: metadata.createdAt ?? DEFAULT_TIMESTAMP,
    updatedAt: metadata.updatedAt ?? metadata.createdAt ?? DEFAULT_TIMESTAMP,
    resetCount: metadata.resetCount ?? 0,
    source: metadata.source,
    labels: metadata.labels ? { ...metadata.labels } : undefined,
    extensions: cloneOptional(metadata.extensions, cloneExtensionFields),
  };
}

interface CloneExtensionContext {
  active: WeakSet<object>;
  work: number;
}

function cloneExtensionFields(fields: ZergExtensionFields = {}): ZergExtensionFields {
  const context = createExtensionCloneContext();
  context.active.add(fields);
  try {
    return cloneExtensionRecordEntries(fields, context, 0);
  } finally {
    context.active.delete(fields);
  }
}

function createExtensionCloneContext(): CloneExtensionContext {
  return { active: new WeakSet<object>(), work: 0 };
}

function cloneExtensionValue(value: unknown, context: CloneExtensionContext = createExtensionCloneContext(), depth = 0): unknown {
  // Only module-owned, recursively frozen ledgers bypass deep hot-path clones.
  // Caller-supplied lookalikes do not pass the WeakSet identity check.
  if (value && typeof value === 'object' && isImmutableAgentResultLedger(value)) return value;
  countExtensionCloneWork(context);

  if (value === null || typeof value !== 'object') {
    return value;
  }

  assertExtensionCloneDepth(depth);

  if (context.active.has(value)) {
    throw new TypeError('Invalid extension metadata: cycle detected');
  }

  if (Array.isArray(value)) {
    context.active.add(value);
    try {
      // Sparse slots also cost work and expand when persisted as JSON. Check
      // length before allocation, then count holes as well as present values.
      if (value.length > MAX_EXTENSION_CLONE_WORK - context.work) {
        throw new TypeError('Invalid extension metadata: too large');
      }
      const output = new Array<unknown>(value.length);
      for (let index = 0; index < value.length; index += 1) {
        if (index in value) {
          output[index] = cloneExtensionValue(value[index], context, depth + 1);
        } else {
          countExtensionCloneWork(context);
        }
      }
      return output;
    } finally {
      context.active.delete(value);
    }
  }

  if (isPlainRecord(value)) {
    context.active.add(value);
    try {
      return cloneExtensionRecordEntries(value, context, depth);
    } finally {
      context.active.delete(value);
    }
  }

  return value;
}

function cloneExtensionRecordEntries(record: Record<string, unknown>, context: CloneExtensionContext, depth: number): ZergExtensionFields {
  const output: ZergExtensionFields = {};
  for (const [key, nested] of Object.entries(record)) {
    const value = cloneExtensionValue(nested, context, depth + 1);
    // This fresh plain output is not exposed during recursion. Assignment makes
    // the same own data property unless a key is inherited; keep DefineProperty
    // for those keys (including __proto__) to bypass setters/nonwritable values.
    // Check after cloning, since source getters can change Object.prototype.
    // Inherited get/set fields also affect the original descriptor literal:
    // preserve their conversion callbacks and errors, even for undefined values.
    if (key in output || 'get' in Object.prototype || 'set' in Object.prototype) {
      Object.defineProperty(output, key, { value, enumerable: true, configurable: true, writable: true });
    } else {
      output[key] = value;
    }
  }
  return output;
}

function countExtensionCloneWork(context: CloneExtensionContext): void {
  context.work += 1;
  if (context.work > MAX_EXTENSION_CLONE_WORK) {
    throw new TypeError('Invalid extension metadata: too large');
  }
}

function assertExtensionCloneDepth(depth: number): void {
  if (depth > MAX_EXTENSION_CLONE_DEPTH) {
    throw new TypeError('Invalid extension metadata: too deep');
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneArray(values: string[] | undefined): string[] | undefined {
  return values ? [...values] : undefined;
}

function cloneOptional<T>(value: T | undefined, clone: (input: T) => T): T | undefined {
  return value === undefined ? undefined : clone(value);
}
