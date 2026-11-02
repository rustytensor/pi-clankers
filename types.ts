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

export const ZERG_COMMANDS = ['clankers', 'clank', 'zerg', 'zerg-swarm', 'swarm'] as const;
export const ZERG_EXTENSION_VERSION = '1.1.29' as const;
export type ZergCommandName = (typeof ZERG_COMMANDS)[number];
export const ZERG_COMMAND_INVOCATIONS = ['/clankers', '/clank', '/zerg', '/zerg-swarm', '/swarm'] as const;
export type ZergCommandInvocation = (typeof ZERG_COMMAND_INVOCATIONS)[number];
export type AgentKind = 'subagent' | 'teammate' | 'team-leader';
export type TeamKind = 'team' | 'squad' | 'worktree';
export type AgentStatus = 'idle' | 'running' | 'blocked' | 'needs-attention' | 'done' | 'failed' | 'cancelled';
export type TaskStatus = AgentStatus;
export type AutomationMode = 'manual' | 'assisted' | 'automatic';
export type ZergMode = AutomationMode;
export type ZergRuntimeTransitionAction = 'create' | 'start' | 'progress' | 'stop' | 'fail' | 'reset';
export type ZergLifecycleSubstate =
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
export type ZergRuntimeHealth = 'unknown' | 'healthy' | 'degraded' | 'blocked' | 'failed' | 'stopped';
export type ZergRuntimeEntity = 'agent' | 'team';
export type ThinkingStepStatus = 'todo' | 'running' | 'blocked' | 'done' | 'failed' | 'unknown';
export type ZergContextKind = 'command' | 'extension' | 'team' | 'agent' | 'task';
export type ZergTreeNodeKind = 'agent' | 'task' | 'team';
export type ZergLifecycleState = 'initializing' | 'ready' | 'resetting' | 'disposed';
export type ZergAgentDefinitionSource = 'builtin' | 'project' | 'user' | 'runtime';
export type ZergSubagentLaunchMode = 'fresh' | 'fork';
export type ZergPermissionRequestStatus = 'pending' | 'approved' | 'denied' | 'cancelled' | 'expired';
export type ZergPermissionDecision = 'approve' | 'deny' | 'cancel' | 'expire';
export type ZergPermissionRequestKind = 'run' | 'interrupt' | 'tool' | 'mode' | 'intervention' | 'adapter';
export type ZergPermissionRequester = 'operator' | 'pi' | 'zerg' | 'adapter';
export type ZergPermissionResolver = 'operator' | 'pi' | 'zerg';
export type ZergLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type ZergLogSource = 'command' | 'adapter' | 'permission' | 'lifecycle' | 'overlay' | 'pi-event';
export type ZergOutputKind = 'text' | 'json' | 'tool' | 'thinking' | 'result' | 'error';
export const ZERG_STATE_SCHEMA_VERSION = '0.2.0' as const;
export type ZergStateSchemaVersion = typeof ZERG_STATE_SCHEMA_VERSION;

export interface ZergExtensionFields {
  [key: string]: unknown;
}

export interface ZergContext {
  id: string;
  kind: ZergContextKind;
  title?: string;
  source?: string;
  metadata?: ZergExtensionFields;
}

export interface ZergAgentDefinition {
  id: string;
  label: string;
  description?: string;
  prompt: string;
  source: ZergAgentDefinitionSource;
  /** Offline draft-07 result validation; does not alter execution authority. */
  result_schema?: import('./agent-results.js').ResultSchema;
  /** Reporting-only relative glob policy, not a sandbox. Absent differs from []. */
  may_write?: string[];
  /** LLM/model identifier to request when launching this agent. */
  model?: string;
  /** Ordered fallback model identifiers for launch adapters that support fallbacks. */
  fallbackModels?: string[];
  /** Optional maximum agentic turns for launch adapters that support turn caps. */
  maxTurns?: number;
  tools?: string[];
  disallowedTools?: string[];
  permissionMode?: AutomationMode | 'inherit';
  metadata?: ZergExtensionFields;
  extensions?: ZergExtensionFields;
}

export type PermissionModeController = 'operator' | 'automation';
export type ZergControlController = 'operator' | 'pi' | 'zerg';

export interface ZergControlAuditEntry {
  id: string;
  action: string;
  message: string;
  createdAt: string;
}

export interface ZergControlState {
  controller: ZergControlController;
  selectedTargetId?: string;
  selectedTargetKind?: ZergManagementTargetKind;
  selectedRunId?: string;
  activeRunId?: string;
  auditLog?: ZergControlAuditEntry[];
}

export interface ZergPersistenceOptions {
  enabled?: boolean;
  rootDir?: string;
  snapshotFile?: string;
}

export interface ZergPersistenceInfo {
  enabled: boolean;
  snapshotFile?: string;
  writerSessionId?: string;
  lastLoadedAt?: string;
  lastSavedAt?: string;
  recoveredRunIds?: string[];
  lastLoadError?: string;
}

export interface ZergRunRecoveryInfo {
  recoveredAt: string;
  reason: 'process-restart';
  previousStatus?: AgentStatus;
  previousSubstate?: ZergLifecycleSubstate;
  previousWriterSessionId?: string;
}

export interface ZergSubagentLaunchRequest {
  agent: string;
  task: string;
  background?: boolean;
  /** @deprecated Use launchMode: 'fork' instead. */
  fork?: boolean;
  launchMode?: ZergSubagentLaunchMode;
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
  /** Ordered fallback model identifiers requested for this launch. */
  fallbackModels?: string[];
  /** Optional maximum agentic turns requested for this launch. */
  maxTurns?: number;
}

export interface ZergSubagentControlResult {
  ok: boolean;
  runId?: string;
  taskId?: string;
  message: string;
}

export interface ZergOperatorMessageResult {
  ok: boolean;
  runId?: string;
  targetId?: string;
  routedTargetId?: string;
  status: ZergOperatorMessageDeliveryStatus;
  message: string;
}

export interface ZergSubagentMemberProgress {
  agentId: string;
  runId?: string;
  status: 'queued' | 'starting' | 'running' | 'done' | 'failed' | 'cancelled';
  handoffPath?: string;
  startedAt?: string;
  completedAt?: string;
  message?: string;
}

/** Pi-assigned locator and attachment state, not a transcript durability claim. */
export type ZergSessionMessageKey = Pick<ZergNativeSessionReference, 'parentRunId' | 'memberRunId' | 'piSessionId'>;
export interface ZergSessionMessageReceipt {
  schemaVersion: 1;
  messageId: string;
  key: ZergSessionMessageKey;
  body: string;
  mode: ZergOperatorMessageMode;
  status: 'recorded' | 'queued' | 'delivered' | 'failed' | 'needs-attention';
  detail: string;
  createdAt: string;
  updatedAt: string;
  persistence: 'memory' | 'saved' | 'failed';
}
export interface ZergSessionMessageInput {
  key: ZergSessionMessageKey;
  messageId: string;
  body: string;
  mode: ZergOperatorMessageMode;
}
export interface ZergSessionMessageResult {
  ok: boolean;
  message: string;
  receipt?: ZergSessionMessageReceipt;
}

export interface ZergNativeSessionReference {
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
export interface ZergNativeContinuationLineage {
  schemaVersion: 1;
  source: Pick<ZergNativeSessionReference, 'schemaVersion' | 'parentRunId' | 'memberRunId' | 'agentDefinitionId' | 'piSessionId' | 'sessionFile' | 'cwd' | 'createdAt'>;
  entryId: string;
  sourceFingerprint: string;
  policyDigest: string;
  policy: import('./native-continuation.js').NativeContinuationPolicy;
}
export interface ZergTimelineFilter {
  teamId?: string;
  parentRunId?: string;
  memberRunId?: string;
  piSessionId?: string;
  limit?: number;
}
export interface ZergTimelineEntryBase {
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
  exactKey?: ZergSessionMessageKey;
}
export type ZergTimelineEntry = ZergTimelineEntryBase & (
  | { kind: 'operator-receipt'; messageId: string; mode: ZergOperatorMessageMode; status: ZergSessionMessageReceipt['status']; persistence: ZergSessionMessageReceipt['persistence']; updatedAt: string }
  | { kind: 'native-output'; source: 'log'; sourceId: string }
  | { kind: 'recorded-event'; source: 'log' | 'lifecycle'; sourceId: string; status?: string }
  | { kind: 'run-snapshot' | 'member-snapshot'; status: string; attachment?: ZergNativeSessionReference['attachment'] }
);
export interface ZergTimelineSnapshot {
  schemaVersion: 1;
  revision: number;
  filter: ZergTimelineFilter;
  entries: ZergTimelineEntry[];
  /** Known matching rows omitted within the inspected window, NOT outside it. */
  omittedEntries: number;
  clippedEntries: number;
  limitations: string[];
}

export interface ZergSubagentRunSnapshot {
  runId: string;
  agentId: string;
  agentDefinitionId?: string;
  agentLabel?: string;
  task?: string;
  status: AgentStatus;
  taskId?: string;
  launchMode?: ZergSubagentLaunchMode;
  substate?: ZergLifecycleSubstate;
  substateReason?: string;
  substateUpdatedAt?: string;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  finalSummary?: string;
  errorSummary?: string;
  recovery?: ZergRunRecoveryInfo;
  memberProgress?: ZergSubagentMemberProgress[];
  /** Read-only projection of the canonical parent metadata.nativeSessions ledger. */
  nativeSessions?: ZergNativeSessionReference[];
  nativeContinuation?: ZergNativeContinuationLineage;
  metadata?: ZergExtensionFields;
}

export interface ZergPermissionRequest {
  id: string;
  kind: ZergPermissionRequestKind;
  status: ZergPermissionRequestStatus;
  targetId?: string;
  agentId?: string;
  runId?: string;
  requester: ZergPermissionRequester;
  summary: string;
  details?: string;
  createdAt: string;
  expiresAt?: string;
  resolvedAt?: string;
  resolvedBy?: ZergPermissionResolver;
  decisionReason?: string;
  metadata?: ZergExtensionFields;
}

export interface ZergPermissionQueueState {
  requests: ZergPermissionRequest[];
  maxRequests: number;
  lastRequestId?: string;
  pendingCount: number;
}

export interface ZergLogRecord {
  id: string;
  runId?: string;
  agentId?: string;
  taskId?: string;
  teamId?: string;
  source: ZergLogSource;
  level: ZergLogLevel;
  kind: ZergOutputKind;
  message: string;
  data?: ZergExtensionFields;
  sequence?: number;
  createdAt: string;
}

export interface ZergLogState {
  records: ZergLogRecord[];
  maxRecords: number;
  lastRecordId?: string;
}

export interface ZergSubagentControlAdapter {
  readonly kind: 'pi-native' | 'pi-slash-bridge' | 'fake' | 'unavailable';
  /** Compact owner observation; kind/status/session retention is not execution proof. */
  readonly activity?: import('./activity.js').ActivitySource<import('./activity.js').NativeActivitySnapshot>;
  launch(request: ZergSubagentLaunchRequest): ZergSubagentControlResult;
  interrupt?(runId?: string): ZergSubagentControlResult;
  sendMessage?(targetId: string, body: string, runId?: string, mode?: ZergOperatorMessageMode): ZergOperatorMessageResult | Promise<ZergOperatorMessageResult>;
  awaitRun?(runId: string): Promise<ZergSubagentRunSnapshot | undefined>;
  listAgentDefinitions?(): readonly ZergAgentDefinition[];
  getAgentDefinition?(id: string): ZergAgentDefinition | undefined;
  listRuns?(): readonly ZergSubagentRunSnapshot[];
  getRun?(runId: string): ZergSubagentRunSnapshot | undefined;
  dispose?(): void;
}

export interface ZergControlHelpParameter {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export type ZergControlHelpData =
  | {
    version: string;
    kind: 'directory';
    groups: Array<{ name: string; actions: Array<{ action: ZergControlAction['action']; summary: string; effects: string[] }> }>;
    hint: string;
    restrictions: string[];
  }
  | {
    version: string;
    kind: 'action';
    action: ZergControlAction['action'];
    summary: string;
    parameters: readonly ZergControlHelpParameter[];
    constraints: readonly string[];
    effects: readonly string[];
    example: ZergControlAction;
    restrictions: readonly string[];
  };

export type ZergControlAction =
  | { action: 'help'; topic?: ZergControlAction['action'] }
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
  | { action: 'run'; agent: string; task: string; background?: boolean; launchMode?: ZergSubagentLaunchMode; concurrency?: number; model?: string; fallbackModels?: string[]; maxTurns?: number }
  | { action: 'runs.list' }
  | { action: 'runs.show'; runId: string }
  | ({ action: 'session.message.send'; messageId: string; body: string; mode: ZergOperatorMessageMode } & ZergSessionMessageKey)
  | ({ action: 'session.messages.list'; limit?: number } & ZergSessionMessageKey)
  | ({ action: 'timeline.list' } & ZergTimelineFilter)
  | ({ action: 'session.continuation.prepare'; entryId: string; body: string; model?: string; acknowledgeUnconfirmedSource?: boolean } & ZergSessionMessageKey)
  | { action: 'session.continuation.start'; reviewId: string; confirm: true }
  | { action: 'session.continuation.discard'; reviewId: string }
  | { action: 'logs.list'; runId?: string; level?: ZergLogLevel; limit?: number }
  | { action: 'message'; targetId: string; body: string; runId?: string; mode?: ZergOperatorMessageMode }
  | { action: 'interrupt'; runId?: string };

export interface ZergControlError {
  code: string;
  message: string;
}

export interface ZergControlResult<T = unknown> {
  ok: boolean;
  action: ZergControlAction['action'];
  output?: string;
  data?: T;
  runId?: string;
  taskId?: string;
  agentId?: string;
  teamId?: string;
  error?: ZergControlError;
  stateRevision?: number;
}

export interface ZergControl {
  execute(action: ZergControlAction, signal?: AbortSignal): Promise<ZergControlResult>;
  getState(): ZergState;
  /** Trusted host-only workflow approval API; not exposed through zerg_control actions. */
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

export interface ZergRuntimeModeContext {
  automation: AutomationMode;
  interventionEnabled: boolean;
  controller: PermissionModeController;
  activeIntervention?: PermissionModeIntervention;
  contextId?: string;
  readOnly?: boolean;
}

export interface ZergRuntimeState {
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  stoppedAt?: string;
  lastActivityAt?: string;
  lastActivity?: string;
  lastActivitySequence?: number;
  lastActivityRevision?: number;
  substate?: ZergLifecycleSubstate;
  substateReason?: string;
  substateUpdatedAt?: string;
  health: ZergRuntimeHealth;
  mode: ZergRuntimeModeContext;
}

interface ZergRuntimeTransitionBase {
  action: ZergRuntimeTransitionAction;
  id: string;
  label?: string;
  status?: AgentStatus;
  health?: ZergRuntimeHealth;
  activity?: string;
  substate?: ZergLifecycleSubstate;
  substateReason?: string;
  at?: string;
  mode?: Partial<ZergRuntimeModeContext>;
  contextId?: string;
  metadata?: ZergExtensionFields;
}

export interface ZergAgentRuntimeTransition extends ZergRuntimeTransitionBase {
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

export interface ZergTeamRuntimeTransition extends ZergRuntimeTransitionBase {
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

export type ZergRuntimeTransition = ZergAgentRuntimeTransition | ZergTeamRuntimeTransition;

export interface AgentIdentity {
  id: string;
  label: string;
  kind: AgentKind;
  status: AgentStatus;
  parentId?: string;
  teamId?: string;
  childIds?: string[];
  contextId?: string;
  runtime?: ZergRuntimeState;
  metadata?: ZergExtensionFields;
  extensions?: ZergExtensionFields;
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
  runtime?: ZergRuntimeState;
  metadata?: ZergExtensionFields;
  extensions?: ZergExtensionFields;
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
  substate?: ZergLifecycleSubstate;
  substateReason?: string;
  substateUpdatedAt?: string;
  updatedAt: string;
  metadata?: ZergExtensionFields;
  extensions?: ZergExtensionFields;
}

export interface HookLifecycleEvent {
  id: string;
  type: 'agent' | 'task' | 'team' | 'tree' | 'hook' | 'permission' | 'mode' | 'state' | 'log';
  message: string;
  status?: AgentStatus | TaskStatus | ThinkingStepStatus;
  action?: ZergRuntimeTransitionAction;
  health?: ZergRuntimeHealth;
  substate?: ZergLifecycleSubstate;
  substateReason?: string;
  mode?: ZergRuntimeModeContext;
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

export interface ZergTreeNode {
  id: string;
  kind: ZergTreeNodeKind;
  label: string;
  status?: AgentStatus | TaskStatus;
  refId?: string;
  parentId?: string;
  childIds: string[];
  ownerAgentId?: string;
  teamId?: string;
  metadata?: ZergExtensionFields;
  extensions?: ZergExtensionFields;
}

export interface ZergStateMetadata {
  createdAt: string;
  updatedAt: string;
  resetCount: number;
  source?: string;
  labels?: Record<string, string>;
  extensions?: ZergExtensionFields;
}

export interface ZergState {
  schemaVersion: ZergStateSchemaVersion;
  lifecycle: ZergLifecycleState;
  revision: number;
  metadata: ZergStateMetadata;
  agents: Record<string, AgentIdentity>;
  tasks: Record<string, TaskRecord>;
  teams: Record<string, TeamIdentity>;
  tree: Record<string, ZergTreeNode>;
  events: HookLifecycleEvent[];
  selectedNodeId?: string;
  mode: PermissionModeState;
  context?: ZergContext;
  extensions: ZergExtensionFields;
  agentDefinitions: Record<string, ZergAgentDefinition>;
}

export interface ZergStateUpdateOptions {
  lifecycle?: ZergLifecycleState;
  updatedAt?: string;
  preserveRevision?: boolean;
}

export type ZergStatePatch = Partial<ZergState> | ((state: ZergState) => Partial<ZergState> | ZergState);

export type ZergStateListener = (state: ZergState) => void;

export interface ZergStateContainer {
  read(): ZergState;
  snapshot(): ZergState;
  replace(nextState?: Partial<ZergState>): ZergState;
  update(patch: ZergStatePatch, options?: ZergStateUpdateOptions): ZergState;
  subscribe?(listener: ZergStateListener): () => void;
}

export interface ThinkingStep {
  id: string;
  title: string;
  status: ThinkingStepStatus;
  sourceLine: number;
}

export type ZergThinkingStep = ThinkingStep;

export interface ZergThinkingContext {
  mode: ZergMode;
  steps: ThinkingStep[];
  context?: ZergContext;
}

export interface ZergCommandResult {
  ok: boolean;
  output: string;
  runId?: string;
  taskId?: string;
}

export interface ZergInternalPatchController {
  installed: boolean;
  emit(event: Omit<HookLifecycleEvent, 'id' | 'createdAt'> & Partial<Pick<HookLifecycleEvent, 'id' | 'createdAt'>>): HookLifecycleEvent;
  dispose(): void;
}

export type ZergCommandHandler = (input?: string) => ZergCommandResult | string | Promise<ZergCommandResult | string>;

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

export type ZergConfigOverlayTab = 'monitor' | 'control' | 'targets' | 'permissions' | 'lifecycle' | 'logs' | 'intervene' | 'config';

export type ZergManagementPaneId = 'tree' | 'detail' | 'settings' | 'chat';
export type ZergManagementTargetKind = 'agent' | 'team' | 'task';
export type ZergOperatorMessageMode = 'steer' | 'followUp';
export const ZERG_OPERATOR_MESSAGE_MODES: readonly ZergOperatorMessageMode[] = ['steer', 'followUp'] as const;
export type ZergOperatorMessageDeliveryStatus = 'draft' | 'queued-local' | 'queued' | 'handled' | 'transport-unavailable' | 'intervention-recorded' | 'accepted' | 'delivered' | 'delivery-failed';

export interface ZergOperatorMessageRecord {
  id: string;
  targetId: string;
  targetKind: ZergManagementTargetKind;
  routedTargetId?: string;
  body: string;
  status: ZergOperatorMessageDeliveryStatus;
  statusDetail: string;
  createdAt: string;
}

export interface ZergManagementUiState {
  focusedPane: ZergManagementPaneId;
  selectedTargetId?: string;
  selectedTargetKind?: ZergManagementTargetKind;
  expandedNodeIds: string[];
  chatDraft: string;
  statusMessage?: string;
  messages: ZergOperatorMessageRecord[];
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

export type ZergPiCommandHandler = (args: string, ctx: StructuralPiCommandContext) => Promise<void> | void;

export interface StructuralPiCommandOptions {
  description?: string;
  handler: ZergPiCommandHandler;
}

export interface StructuralPiCommand extends StructuralPiCommandOptions {
  name: ZergCommandName;
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
  registerCommand?(name: ZergCommandName, options: StructuralPiCommandOptions): unknown;
  registerTool?(definition: StructuralPiToolDefinition): unknown;
  events?: {
    emit?(eventName: unknown, ...args: unknown[]): unknown;
    on?(eventName: unknown, handler: (...args: unknown[]) => unknown): unknown;
  };
  commands?: {
    register?(name: ZergCommandName, options: StructuralPiCommandOptions): unknown;
    registerCommand?(name: ZergCommandName, options: StructuralPiCommandOptions): unknown;
  };
  commandRegistrar?: {
    registerCommand?(name: ZergCommandName, options: StructuralPiCommandOptions): unknown;
  };
}
