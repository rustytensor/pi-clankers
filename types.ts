import type { WorkflowAction } from './workflow-model.js';

/** Trusted foreground automation capabilities. NEVER serialized or recovered from state. */
export interface TrustedAutomationNativeContext {
  readonly cwd: string;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly preflightedModelRuntime: import('@earendil-works/pi-coding-agent').ModelRuntime;
  /** Non-consuming synchronous logical path/policy validation; grants no read capability. */
  readonly scopedAccess: (path: string) => void;
  /** ONLY consuming text delivery. Enforce finite nofollow scope/identity on every call. */
  readonly scopedRead: (path: string) => string;
  readonly assertPolicy: () => void;
  /** Request preparations, not transport requests or spend. */
  readonly beforeProviderRequest: () => void;
  readonly expectedThinkingLevel: string;
}
export type { WorkflowAction, WorkflowDefinition, WorkflowRun, WorkflowView, WorkflowReply, WorkflowNativeLineage } from './workflow-model.js';

export const CLANKERS_COMMANDS = ['clankers', 'clank'] as const;
export const CLANKERS_EXTENSION_VERSION = '2.0.2' as const;
export type ClankersCommandName = (typeof CLANKERS_COMMANDS)[number];
export const CLANKERS_COMMAND_INVOCATIONS = ['/clankers', '/clank'] as const;
export type ClankersCommandInvocation = (typeof CLANKERS_COMMAND_INVOCATIONS)[number];
export type AgentKind = 'subagent' | 'teammate' | 'team-leader';
export type TeamKind = 'team' | 'squad' | 'worktree';
export type AgentStatus = 'idle' | 'running' | 'blocked' | 'needs-attention' | 'done' | 'failed' | 'cancelled';
export type TaskStatus = AgentStatus;
export type AutomationMode = 'manual' | 'assisted' | 'automatic';
export type ClankersMode = AutomationMode;
export type ClankersRuntimeTransitionAction = 'create' | 'start' | 'progress' | 'stop' | 'fail' | 'reset';
export type ClankersLifecycleSubstate =
  | 'queued'
  | 'spawning'
  | 'starting'
  | 'planning'
  | 'waiting-permission'
  | 'waiting-input'
  | 'executing'
  | 'tool-running'
  | 'streaming-output'
  | 'compacting'
  | 'idle'
  | 'stopping'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'reset';
export type ClankersRuntimeHealth = 'unknown' | 'healthy' | 'degraded' | 'blocked' | 'failed' | 'stopped';
export type ClankersRuntimeEntity = 'agent' | 'team';
export type ThinkingStepStatus = 'todo' | 'running' | 'blocked' | 'done' | 'failed' | 'unknown';
export type ClankersContextKind = 'command' | 'extension' | 'team' | 'agent' | 'task';
export type ClankersTreeNodeKind = 'agent' | 'task' | 'team';
export type ClankersLifecycleState = 'initializing' | 'ready' | 'resetting' | 'disposed';
export type ClankersAgentDefinitionSource = 'builtin' | 'project' | 'user' | 'runtime';
export type ClankersSubagentLaunchMode = 'fresh' | 'fork';
export type ClankersPermissionRequestStatus = 'pending' | 'approved' | 'denied' | 'cancelled' | 'expired';
export type ClankersPermissionDecision = 'approve' | 'deny' | 'cancel' | 'expire';
export type ClankersPermissionRequestKind = 'run' | 'interrupt' | 'tool' | 'mode' | 'intervention' | 'adapter';
export type ClankersPermissionRequester = 'operator' | 'pi' | 'clankers' | 'adapter';
export type ClankersPermissionResolver = 'operator' | 'pi' | 'clankers';
export type ClankersLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type ClankersLogSource = 'command' | 'adapter' | 'permission' | 'lifecycle' | 'overlay' | 'pi-event';
export type ClankersOutputKind = 'text' | 'json' | 'tool' | 'thinking' | 'result' | 'error';
export const CLANKERS_STATE_SCHEMA_VERSION = '0.2.0' as const;
export type ClankersStateSchemaVersion = typeof CLANKERS_STATE_SCHEMA_VERSION;

export interface ClankersExtensionFields {
  [key: string]: unknown;
}

export interface ClankersContext {
  id: string;
  kind: ClankersContextKind;
  title?: string;
  source?: string;
  metadata?: ClankersExtensionFields;
}

export interface ClankersAgentDefinition {
  id: string;
  label: string;
  description?: string;
  prompt: string;
  source: ClankersAgentDefinitionSource;
  /** Offline draft-07 result validation; does not alter execution authority. */
  result_schema?: import('./agent-results.js').ResultSchema;
  /** Reporting-only relative glob policy, not a sandbox. Absent differs from []. */
  may_write?: string[];
  /** LLM/model identifier to request when launching this agent. */
  model?: string;
  /** Saved agent lists are normalized/sorted. Tmux uses that saved order; pass run fallbacks for explicit priority. */
  fallbackModels?: string[];
  /** Optional maximum agentic turns for launch adapters that support turn caps. */
  maxTurns?: number;
  tools?: string[];
  disallowedTools?: string[];
  permissionMode?: AutomationMode | 'inherit';
  metadata?: ClankersExtensionFields;
  extensions?: ClankersExtensionFields;
}

export type PermissionModeController = 'operator' | 'automation';
export type ClankersControlController = 'operator' | 'pi' | 'clankers';

export interface ClankersControlAuditEntry {
  id: string;
  action: string;
  message: string;
  createdAt: string;
}

export interface ClankersControlState {
  controller: ClankersControlController;
  selectedTargetId?: string;
  selectedTargetKind?: ClankersManagementTargetKind;
  selectedRunId?: string;
  activeRunId?: string;
  auditLog?: ClankersControlAuditEntry[];
}

export interface ClankersPersistenceOptions {
  enabled?: boolean;
  rootDir?: string;
  snapshotFile?: string;
}

export interface ClankersPersistenceInfo {
  enabled: boolean;
  snapshotFile?: string;
  writerSessionId?: string;
  lastLoadedAt?: string;
  lastSavedAt?: string;
  recoveredRunIds?: string[];
  lastLoadError?: string;
}

export interface ClankersRunRecoveryInfo {
  recoveredAt: string;
  reason: 'process-restart';
  previousStatus?: AgentStatus;
  previousSubstate?: ClankersLifecycleSubstate;
  previousWriterSessionId?: string;
}

export interface ClankersSubagentLaunchRequest {
  backend?: 'native' | 'tmux';
  agent: string;
  task: string;
  background?: boolean;
  /** @deprecated Use launchMode: 'fork' instead. */
  fork?: boolean;
  launchMode?: ClankersSubagentLaunchMode;
  runId?: string;
  taskId?: string;
  agentDefinitionId?: string;
  /** Immutable team selected by the caller, if the launch targeted a team. */
  resolvedTeamId?: string;
  /** Immutable team member definition ids validated before launch. */
  memberAgentIds?: string[];
  /** Maximum concurrent native team workers for this run. Defaults to 8. */
  concurrency?: number;
  description?: string;
  /** LLM/model identifier requested for this launch. */
  model?: string;
  /** Ordered launch fallbacks. Tmux: at most 7 canonical specs, offline missing-model selection only; never dispatch retry. */
  fallbackModels?: string[];
  /** Optional maximum agentic turns requested for this launch. */
  maxTurns?: number;
}

export interface ClankersSubagentControlResult {
  ok: boolean;
  runId?: string;
  taskId?: string;
  message: string;
}

export interface ClankersOperatorMessageResult {
  ok: boolean;
  runId?: string;
  targetId?: string;
  routedTargetId?: string;
  status: ClankersOperatorMessageDeliveryStatus;
  message: string;
}

export interface ClankersSubagentMemberProgress {
  agentId: string;
  runId?: string;
  status: 'queued' | 'starting' | 'running' | 'done' | 'failed' | 'cancelled';
  handoffPath?: string;
  startedAt?: string;
  completedAt?: string;
  message?: string;
}

/** Pi-assigned locator and attachment state, not a transcript durability claim. */
export type ClankersSessionMessageKey = Pick<ClankersNativeSessionReference, 'parentRunId' | 'memberRunId' | 'piSessionId'>;
export interface ClankersSessionMessageReceipt {
  schemaVersion: 1;
  messageId: string;
  key: ClankersSessionMessageKey;
  body: string;
  mode: ClankersOperatorMessageMode;
  status: 'recorded' | 'queued' | 'delivered' | 'failed' | 'needs-attention';
  detail: string;
  createdAt: string;
  updatedAt: string;
  persistence: 'memory' | 'saved' | 'failed';
}
export interface ClankersSessionMessageInput {
  key: ClankersSessionMessageKey;
  messageId: string;
  body: string;
  mode: ClankersOperatorMessageMode;
}
export interface ClankersSessionMessageResult {
  ok: boolean;
  message: string;
  receipt?: ClankersSessionMessageReceipt;
}

export interface ClankersNativeSessionReference {
  schemaVersion: 1;
  parentRunId: string;
  memberRunId: string;
  agentDefinitionId: string;
  piSessionId: string;
  sessionFile: string;
  cwd: string;
  createdAt: string;
  attachment: 'attached' | 'disposed' | 'unavailable';
  disposedAt?: string;
  recoveredAt?: string;
}

/** Read-only durable provenance, never an executable resume/review token. */
export interface ClankersNativeContinuationLineage {
  schemaVersion: 1;
  source: Pick<ClankersNativeSessionReference, 'schemaVersion' | 'parentRunId' | 'memberRunId' | 'agentDefinitionId' | 'piSessionId' | 'sessionFile' | 'cwd' | 'createdAt'>;
  entryId: string;
  sourceFingerprint: string;
  policyDigest: string;
  policy: import('./native-continuation.js').NativeContinuationPolicy;
}
export interface ClankersTimelineFilter {
  teamId?: string;
  parentRunId?: string;
  memberRunId?: string;
  piSessionId?: string;
  limit?: number;
}
export interface ClankersTimelineEntryBase {
  id: string;
  timestamp?: string;
  timestampMeaning: 'created' | 'recorded' | 'current-update';
  summary: string;
  bodyPreview: string;
  clipped: boolean;
  teamId?: string;
  parentRunId?: string;
  memberRunId?: string;
  piSessionId?: string;
  agentDefinitionId?: string;
  /** Corroborated full tuple in this owner's current canonical reference ledger. */
  exactKey?: ClankersSessionMessageKey;
}
export type ClankersTimelineEntry = ClankersTimelineEntryBase & (
  | { kind: 'operator-receipt'; messageId: string; mode: ClankersOperatorMessageMode; status: ClankersSessionMessageReceipt['status']; persistence: ClankersSessionMessageReceipt['persistence']; updatedAt: string }
  | { kind: 'native-output'; source: 'log'; sourceId: string }
  | { kind: 'recorded-event'; source: 'log' | 'lifecycle'; sourceId: string; status?: string }
  | { kind: 'run-snapshot' | 'member-snapshot'; status: string; attachment?: ClankersNativeSessionReference['attachment'] }
);
export interface ClankersTimelineSnapshot {
  schemaVersion: 1;
  revision: number;
  filter: ClankersTimelineFilter;
  entries: ClankersTimelineEntry[];
  /** Known matching rows omitted within the inspected window, NOT outside it. */
  omittedEntries: number;
  clippedEntries: number;
  limitations: string[];
}

export interface ClankersSubagentRunSnapshot {
  runId: string;
  agentId: string;
  agentDefinitionId?: string;
  agentLabel?: string;
  task?: string;
  status: AgentStatus;
  taskId?: string;
  launchMode?: ClankersSubagentLaunchMode;
  substate?: ClankersLifecycleSubstate;
  substateReason?: string;
  substateUpdatedAt?: string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  finalSummary?: string;
  errorSummary?: string;
  recovery?: ClankersRunRecoveryInfo;
  memberProgress?: ClankersSubagentMemberProgress[];
  /** Read-only projection of the canonical parent metadata.nativeSessions ledger. */
  nativeSessions?: ClankersNativeSessionReference[];
  nativeContinuation?: ClankersNativeContinuationLineage;
  metadata?: ClankersExtensionFields;
}

export interface ClankersPermissionRequest {
  id: string;
  kind: ClankersPermissionRequestKind;
  status: ClankersPermissionRequestStatus;
  targetId?: string;
  agentId?: string;
  runId?: string;
  requester: ClankersPermissionRequester;
  summary: string;
  details?: string;
  createdAt: string;
  expiresAt?: string;
  resolvedAt?: string;
  resolvedBy?: ClankersPermissionResolver;
  decisionReason?: string;
  metadata?: ClankersExtensionFields;
}

export interface ClankersPermissionQueueState {
  requests: ClankersPermissionRequest[];
  maxRequests: number;
  lastRequestId?: string;
  pendingCount: number;
}

export interface ClankersLogRecord {
  id: string;
  runId?: string;
  agentId?: string;
  taskId?: string;
  teamId?: string;
  source: ClankersLogSource;
  level: ClankersLogLevel;
  kind: ClankersOutputKind;
  message: string;
  data?: ClankersExtensionFields;
  sequence?: number;
  createdAt: string;
}

export interface ClankersLogState {
  records: ClankersLogRecord[];
  maxRecords: number;
  lastRecordId?: string;
}

export interface ClankersSubagentControlAdapter {
  readonly kind: 'pi-native' | 'pi-slash-bridge' | 'fake' | 'unavailable';
  /** Compact owner observation; kind/status/session retention is not execution proof. */
  readonly activity?: import('./activity.js').ActivitySource<import('./activity.js').NativeActivitySnapshot>;
  launch(request: ClankersSubagentLaunchRequest): ClankersSubagentControlResult;
  interrupt?(runId?: string): ClankersSubagentControlResult;
  sendMessage?(targetId: string, body: string, runId?: string, mode?: ClankersOperatorMessageMode): ClankersOperatorMessageResult | Promise<ClankersOperatorMessageResult>;
  awaitRun?(runId: string): Promise<ClankersSubagentRunSnapshot | undefined>;
  listAgentDefinitions?(): readonly ClankersAgentDefinition[];
  getAgentDefinition?(id: string): ClankersAgentDefinition | undefined;
  listRuns?(): readonly ClankersSubagentRunSnapshot[];
  getRun?(runId: string): ClankersSubagentRunSnapshot | undefined;
  dispose?(): void;
}

export interface ClankersControlHelpParameter {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export type ClankersControlHelpData =
  | {
    version: string;
    kind: 'directory';
    groups: Array<{ name: string; actions: Array<{ action: ClankersControlAction['action']; summary: string; effects: string[] }> }>;
    hint: string;
    restrictions: string[];
  }
  | {
    version: string;
    kind: 'action';
    action: ClankersControlAction['action'];
    summary: string;
    parameters: readonly ClankersControlHelpParameter[];
    constraints: readonly string[];
    effects: readonly string[];
    example: ClankersControlAction;
    restrictions: readonly string[];
  };

export type ClankersControlAction =
  | { action: 'help'; topic?: ClankersControlAction['action'] }
  | import('./workflow-script-format.js').WorkflowScriptAction
  | WorkflowAction
  | { action: 'status' }
  | { action: 'agents.list' }
  | { action: 'agents.show'; id: string }
  | { action: 'agents.result'; id: string; runId?: string; memberRunId?: string; full?: boolean }
  | { action: 'agents.results'; ids: string[]; runId?: string; memberRunId?: string; full?: boolean }
  | { action: 'agents.create' | 'agents.update'; id: string; label?: string; description?: string; prompt?: string; model?: string; fallbackModels?: string[]; maxTurns?: number; tools?: string[]; disallowedTools?: string[]; permissionMode?: AutomationMode | 'inherit'; result_schema?: import('./agent-results.js').ResultSchema; may_write?: string[] }
  | { action: 'agents.delete'; id: string }
  | { action: 'team.create' | 'team.update'; id: string; label?: string; leader?: string; members?: string[]; kind?: TeamKind; model?: string; fallbackModels?: string[]; maxTurns?: number }
  | { action: 'tmux.continuation.prepare'; workerId: string; jobId: string; task: string }
  | { action: 'tmux.continuation.start'; reviewId: string; confirm: true }
  | { action: 'tmux.continuation.discard'; reviewId: string }
  | { action: 'tmux.workers.list' }
  | { action: 'tmux.workers.show'; workerId: string; jobId?: string }
  | { action: 'tmux.workers.close'; workerId: string }
  | { action: 'tmux.workers.prompt'; workerId: string; task: string; background?: boolean }
  | { action: 'tmux.workers.steer'; workerId: string; runId: string; body: string }
  | { action: 'run'; backend?: 'native' | 'tmux'; agent: string; task: string; background?: boolean; launchMode?: ClankersSubagentLaunchMode; concurrency?: number; model?: string; fallbackModels?: string[]; maxTurns?: number }
  | { action: 'runs.list' }
  | { action: 'runs.show'; runId: string }
  | ({ action: 'session.message.send'; messageId: string; body: string; mode: ClankersOperatorMessageMode } & ClankersSessionMessageKey)
  | ({ action: 'session.messages.list'; limit?: number } & ClankersSessionMessageKey)
  | ({ action: 'timeline.list' } & ClankersTimelineFilter)
  | ({ action: 'session.continuation.prepare'; entryId: string; body: string; model?: string; acknowledgeUnconfirmedSource?: boolean } & ClankersSessionMessageKey)
  | { action: 'session.continuation.start'; reviewId: string; confirm: true }
  | { action: 'session.continuation.discard'; reviewId: string }
  | { action: 'logs.list'; runId?: string; level?: ClankersLogLevel; limit?: number }
  | { action: 'message'; targetId: string; body: string; runId?: string; mode?: ClankersOperatorMessageMode }
  | { action: 'interrupt'; runId?: string };

export interface ClankersControlError {
  code: string;
  message: string;
}

export interface ClankersControlResult<T = unknown> {
  ok: boolean;
  action: ClankersControlAction['action'];
  output?: string;
  data?: T;
  runId?: string;
  taskId?: string;
  agentId?: string;
  teamId?: string;
  error?: ClankersControlError;
  stateRevision?: number;
}

export interface ClankersControl {
  execute(action: ClankersControlAction, signal?: AbortSignal): Promise<ClankersControlResult>;
  getState(): ClankersState;
  /** Trusted host-only workflow approval API; not exposed through clankers_control actions. */
  readonly workflowApprovals?: import('./workflow-model.js').WorkflowTrustedApprovalApi;
  /** Trusted host-only exact recovery confirmation; never a model/tool or slash
   * JSON grant. May activate selected readonly work; fresh coding gates stay separate. */
  readonly workflowRecovery?: import('./workflow-model.js').WorkflowTrustedRecoveryApi;
  dispose(): void;
  /** Wait for owner-local workflow settlement; disposal never frees uncertain permits. */
  drain?(): Promise<void>;
}

export type PermissionModeInterventionKind = 'agent' | 'subagent' | 'leader';

export interface PermissionModeIntervention {
  kind: PermissionModeInterventionKind;
  targetId: string;
  targetLabel?: string;
  teamId?: string;
  leaderAgentId?: string;
  message: string;
  createdAt: string;
}

export interface PermissionModeSnapshot {
  automation: AutomationMode;
  interventionEnabled: boolean;
  controller: PermissionModeController;
  contextId?: string;
  readOnly?: boolean;
}

export interface ClankersRuntimeModeContext {
  automation: AutomationMode;
  interventionEnabled: boolean;
  controller: PermissionModeController;
  activeIntervention?: PermissionModeIntervention;
  contextId?: string;
  readOnly?: boolean;
}

export interface ClankersRuntimeState {
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  stoppedAt?: string;
  lastActivityAt?: string;
  lastActivity?: string;
  lastActivitySequence?: number;
  lastActivityRevision?: number;
  substate?: ClankersLifecycleSubstate;
  substateReason?: string;
  substateUpdatedAt?: string;
  health: ClankersRuntimeHealth;
  mode: ClankersRuntimeModeContext;
}

interface ClankersRuntimeTransitionBase {
  action: ClankersRuntimeTransitionAction;
  id: string;
  label?: string;
  status?: AgentStatus;
  health?: ClankersRuntimeHealth;
  activity?: string;
  substate?: ClankersLifecycleSubstate;
  substateReason?: string;
  at?: string;
  mode?: Partial<ClankersRuntimeModeContext>;
  contextId?: string;
  metadata?: ClankersExtensionFields;
}

export interface ClankersAgentRuntimeTransition extends ClankersRuntimeTransitionBase {
  entity: 'agent';
  kind?: AgentKind;
  parentId?: string;
  childIds?: string[];
  teamId?: string;
  leaderAgentId?: never;
  memberAgentIds?: never;
  parentTeamId?: never;
  taskIds?: never;
}

export interface ClankersTeamRuntimeTransition extends ClankersRuntimeTransitionBase {
  entity: 'team';
  kind?: TeamKind;
  leaderAgentId?: string;
  memberAgentIds?: string[];
  parentTeamId?: string;
  taskIds?: string[];
  parentId?: never;
  childIds?: never;
  teamId?: never;
}

export type ClankersRuntimeTransition = ClankersAgentRuntimeTransition | ClankersTeamRuntimeTransition;

export interface AgentIdentity {
  id: string;
  label: string;
  kind: AgentKind;
  status: AgentStatus;
  parentId?: string;
  teamId?: string;
  childIds?: string[];
  contextId?: string;
  runtime?: ClankersRuntimeState;
  metadata?: ClankersExtensionFields;
  extensions?: ClankersExtensionFields;
}

export interface TeamIdentity {
  id: string;
  label: string;
  kind: TeamKind;
  status: AgentStatus;
  leaderAgentId?: string;
  memberAgentIds: string[];
  parentTeamId?: string;
  taskIds?: string[];
  runtime?: ClankersRuntimeState;
  metadata?: ClankersExtensionFields;
  extensions?: ClankersExtensionFields;
}

export interface TaskRecord {
  id: string;
  title: string;
  status: TaskStatus;
  ownerAgentId?: string;
  teamId?: string;
  parentId?: string;
  blockedBy?: string[];
  contextId?: string;
  substate?: ClankersLifecycleSubstate;
  substateReason?: string;
  substateUpdatedAt?: string;
  updatedAt: string;
  metadata?: ClankersExtensionFields;
  extensions?: ClankersExtensionFields;
}

export interface HookLifecycleEvent {
  id: string;
  type: 'agent' | 'task' | 'team' | 'tree' | 'hook' | 'permission' | 'mode' | 'state' | 'log';
  message: string;
  status?: AgentStatus | TaskStatus | ThinkingStepStatus;
  action?: ClankersRuntimeTransitionAction;
  health?: ClankersRuntimeHealth;
  substate?: ClankersLifecycleSubstate;
  substateReason?: string;
  mode?: ClankersRuntimeModeContext;
  intervention?: PermissionModeIntervention;
  previousMode?: PermissionModeSnapshot;
  sequence?: number;
  agentId?: string;
  taskId?: string;
  teamId?: string;
  treeNodeId?: string;
  revision?: number;
  createdAt: string;
}

export interface PermissionModeState extends PermissionModeSnapshot {
  activeIntervention?: PermissionModeIntervention;
  previousMode?: PermissionModeSnapshot;
}

export interface PermissionModeTransitionInput {
  automation: AutomationMode;
  controller: PermissionModeController;
  interventionEnabled: boolean;
  contextId?: string;
  reason?: string;
  readOnly?: boolean;
  clearActiveIntervention?: boolean;
}

export interface PermissionModeInterventionInput {
  kind: PermissionModeInterventionKind;
  targetId: string;
  targetLabel?: string;
  teamId?: string;
  leaderAgentId?: string;
  message: string;
}

export interface ClankersTreeNode {
  id: string;
  kind: ClankersTreeNodeKind;
  label: string;
  status?: AgentStatus | TaskStatus;
  refId?: string;
  parentId?: string;
  childIds: string[];
  ownerAgentId?: string;
  teamId?: string;
  metadata?: ClankersExtensionFields;
  extensions?: ClankersExtensionFields;
}

export interface ClankersStateMetadata {
  createdAt: string;
  updatedAt: string;
  resetCount: number;
  source?: string;
  labels?: Record<string, string>;
  extensions?: ClankersExtensionFields;
}

export interface ClankersState {
  schemaVersion: ClankersStateSchemaVersion;
  lifecycle: ClankersLifecycleState;
  revision: number;
  metadata: ClankersStateMetadata;
  agents: Record<string, AgentIdentity>;
  tasks: Record<string, TaskRecord>;
  teams: Record<string, TeamIdentity>;
  tree: Record<string, ClankersTreeNode>;
  events: HookLifecycleEvent[];
  selectedNodeId?: string;
  mode: PermissionModeState;
  context?: ClankersContext;
  extensions: ClankersExtensionFields;
  agentDefinitions: Record<string, ClankersAgentDefinition>;
}

export interface ClankersStateUpdateOptions {
  lifecycle?: ClankersLifecycleState;
  updatedAt?: string;
  preserveRevision?: boolean;
}

export type ClankersStatePatch = Partial<ClankersState> | ((state: ClankersState) => Partial<ClankersState> | ClankersState);

export type ClankersStateListener = (state: ClankersState) => void;

export interface ClankersStateContainer {
  read(): ClankersState;
  snapshot(): ClankersState;
  replace(nextState?: Partial<ClankersState>): ClankersState;
  update(patch: ClankersStatePatch, options?: ClankersStateUpdateOptions): ClankersState;
  subscribe?(listener: ClankersStateListener): () => void;
}

export interface ThinkingStep {
  id: string;
  title: string;
  status: ThinkingStepStatus;
  sourceLine: number;
}

export type ClankersThinkingStep = ThinkingStep;

export interface ClankersThinkingContext {
  mode: ClankersMode;
  steps: ThinkingStep[];
  context?: ClankersContext;
}

export interface ClankersCommandResult {
  ok: boolean;
  output: string;
  runId?: string;
  taskId?: string;
}

export interface ClankersInternalPatchController {
  installed: boolean;
  emit(event: Omit<HookLifecycleEvent, 'id' | 'createdAt'> & Partial<Pick<HookLifecycleEvent, 'id' | 'createdAt'>>): HookLifecycleEvent;
  dispose(): void;
}

export type ClankersCommandHandler = (input?: string) => ClankersCommandResult | string | Promise<ClankersCommandResult | string>;

export interface StructuralPiCustomComponent {
  render(width?: number): string[];
  invalidate(): void;
  handleInput?(data: string): unknown;
  dispose?(): void;
  focused?: boolean;
  wantsKeyRelease?: boolean;
}

export interface StructuralPiTuiHandle {
  terminal?: { rows?: number; columns?: number };
  requestRender?(force?: boolean): void;
  hasOverlay?(): boolean;
  getFocusedComponent?(): unknown;
}

export type ClankersConfigOverlayTab = 'monitor' | 'control' | 'targets' | 'permissions' | 'lifecycle' | 'logs' | 'intervene' | 'config';

export type ClankersManagementPaneId = 'tree' | 'detail' | 'settings' | 'chat';
export type ClankersManagementTargetKind = 'agent' | 'team' | 'task';
export type ClankersOperatorMessageMode = 'steer' | 'followUp';
export const CLANKERS_OPERATOR_MESSAGE_MODES: readonly ClankersOperatorMessageMode[] = ['steer', 'followUp'] as const;
export type ClankersOperatorMessageDeliveryStatus = 'draft' | 'queued-local' | 'queued' | 'handled' | 'transport-unavailable' | 'intervention-recorded' | 'accepted' | 'delivered' | 'delivery-failed';

export interface ClankersOperatorMessageRecord {
  id: string;
  targetId: string;
  targetKind: ClankersManagementTargetKind;
  routedTargetId?: string;
  body: string;
  status: ClankersOperatorMessageDeliveryStatus;
  statusDetail: string;
  createdAt: string;
}

export interface ClankersManagementUiState {
  focusedPane: ClankersManagementPaneId;
  selectedTargetId?: string;
  selectedTargetKind?: ClankersManagementTargetKind;
  expandedNodeIds: string[];
  chatDraft: string;
  statusMessage?: string;
  messages: ClankersOperatorMessageRecord[];
}

export type StructuralPiCustomFactory = (
  tui?: StructuralPiTuiHandle,
  theme?: unknown,
  keybindings?: unknown,
  done?: (result?: unknown) => void,
) => StructuralPiCustomComponent | Promise<StructuralPiCustomComponent>;

export interface StructuralPiCustomOptions {
  overlay?: boolean;
  overlayOptions?: Record<string, unknown>;
  onHandle?(handle: unknown): void;
  [key: string]: unknown;
}

export interface StructuralPiCommandContext {
  cwd?: string;
  hasUI?: boolean;
  /** Pi 1.0 RPC supports dialogs, but not custom terminal components. */
  mode?: 'tui' | 'rpc' | 'json' | 'print';
  ui?: {
    notify?(message: string, type?: 'info' | 'warning' | 'error'): void;
    custom?(
      render: StructuralPiCustomFactory | ((width: number) => string),
      options?: StructuralPiCustomOptions | Record<string, unknown>,
    ): Promise<unknown> | { close?(): void; dispose?(): void } | unknown;
    confirm?(message: string, details?: string): Promise<boolean> | boolean;
    /** Public TUI-only widget and passive input capabilities; absent on legacy hosts. */
    setWidget?: import('@earendil-works/pi-coding-agent').ExtensionUIContext['setWidget'];
    onTerminalInput?: import('@earendil-works/pi-coding-agent').ExtensionUIContext['onTerminalInput'];
  };
}

export type ClankersPiCommandHandler = (args: string, ctx: StructuralPiCommandContext) => Promise<void> | void;

export interface StructuralPiCommandOptions {
  description?: string;
  handler: ClankersPiCommandHandler;
}

export interface StructuralPiCommand extends StructuralPiCommandOptions {
  name: ClankersCommandName;
}

export interface StructuralPiToolResult {
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  details?: unknown;
  [key: string]: unknown;
}

export interface StructuralPiToolDefinition {
  name: string;
  label?: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters?: unknown;
  prepareArguments?(args: unknown): unknown;
  execute?(toolCallId: string, params: unknown, signal?: AbortSignal, onUpdate?: (result: StructuralPiToolResult) => void, context?: unknown): Promise<StructuralPiToolResult> | StructuralPiToolResult;
  [key: string]: unknown;
}

export interface StructuralPiExtensionContext {
  sendMessage?: import('@earendil-works/pi-coding-agent').ExtensionAPI['sendMessage'];
  registerShortcut?: import('@earendil-works/pi-coding-agent').ExtensionAPI['registerShortcut'];
  on?(eventName: unknown, handler: (...args: unknown[]) => unknown): unknown;
  registerCommand?(name: ClankersCommandName, options: StructuralPiCommandOptions): unknown;
  registerTool?(definition: StructuralPiToolDefinition): unknown;
  events?: {
    emit?(eventName: unknown, ...args: unknown[]): unknown;
    on?(eventName: unknown, handler: (...args: unknown[]) => unknown): unknown;
  };
  commands?: {
    register?(name: ClankersCommandName, options: StructuralPiCommandOptions): unknown;
    registerCommand?(name: ClankersCommandName, options: StructuralPiCommandOptions): unknown;
  };
  commandRegistrar?: {
    registerCommand?(name: ClankersCommandName, options: StructuralPiCommandOptions): unknown;
  };
}
