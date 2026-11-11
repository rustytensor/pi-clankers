import { ACTIVITY_LIMITS, createActivityChannel } from './activity.js';
import type { ActivityProgress, WorkflowActivityRun, WorkflowActivitySnapshot, WorkflowActivityUnit } from './activity.js';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ClankersAgentDefinition, ClankersStateContainer } from './types.js';
import { WORKFLOW_EXTENSION_KEY, WORKFLOW_LIMITS, assertWorkflowAuthoringCompatibility, aggregateWorkflow, createReadOnlyReviewDefinition,
  freezeWorkflowData, normalizeWorkflowAgent, resolveWorkflowRef, validateReviewInputs, validateWorkflowDefinition, validateWorkflowValue,
  workflowRecoveryAddresses, workflowUnavailableEnvelope, evaluateWorkflowCondition, workflowStepEntries, workflowStepContext, qualifyWorkflowStep, workflowAssert, workflowHash, workflowJson, workflowRecoveryDependencyHash, workflowRecoverySourceContract, workflowUnitHash, workflowUnitEnvelope, workflowView } from './workflow-model.js';
import { approvalRequestHash, codingBaselineHash, codingGatesPassed, codingPolicyHash, createCodingApprovalRequest, resolveCodingBounds, validateCodingPolicy } from './workflow-coding.js';
import type { WorkflowCodingGateEvidence, WorkflowCodingReviewEvidence } from './workflow-coding.js';
import { createWorkflowApprovalRegistry } from './workflow-approvals.js';
import { captureCodingBaseline, createCodingWorkspace, createContinuationCodingWorkspace, createPartialReconstructionCodingWorkspace, inspectPartialWorkspaceArtifacts, inspectRootReadyWorkspaceArtifacts, inspectRetainedCodingWorkspaceManifest, partialWorkspaceSourceFence } from './workflow-workspace.js';
import type { WorkspaceEffectHooks, WorkspaceEffectIntent, WorkspaceEffectObservation, WorkspaceLeaseReleaseIntent, WorkspaceLeaseReleaseObservation } from './workflow-workspace.js';
import { inspectDurableCheckReceipt, profileHash, runCodingCheck } from './workflow-checks.js';
import type { DurableCheckIntent, DurableCheckReceipt, DurableCheckSupervisorReady } from './workflow-checks.js';
import { recoveryWriterUsage, appendRecoveryIntent, appendRecoveryResult, classifyRecoveryOperation, selectRecoveryContinuation, validateRecoveryCheckpoint } from './workflow-recovery.js';
import type { RecoveryCheckpointV1, RecoveryOperationKind, RecoveryResultStatus } from './workflow-recovery.js';
import type { WorkflowAction, WorkflowDefinition, WorkflowJson, WorkflowNativeIdentity, WorkflowNativeOutcome,
  WorkflowNativePort, WorkflowRecoveryWriterOwnerEvidence, WorkflowReply, WorkflowRun, WorkflowService, WorkflowServiceOptions, WorkflowState,
  WorkflowBinding, WorkflowIterationRun, WorkflowStep, WorkflowStepRun, WorkflowUnit, WorkflowUnitStatus, WorkflowTrustedApprovalApi, WorkflowTrustedRecoveryAuthorizeRequest } from './workflow-model.js';
import { WORKFLOW_SCRIPT_FORMAT_VERSION, WORKFLOW_SCRIPT_LANGUAGE_VERSION, WORKFLOW_SCRIPT_COMPILER_VERSION,
  WORKFLOW_SCRIPT_PARSER_VERSION } from './workflow-script-format.js';
import { AUTOMATION_EXTENSION_KEY, validateAutomationLedger, validateAutomationReservation } from './automation-admission.js';
const settled = (status: WorkflowUnitStatus) => !['queued', 'running'].includes(status);
const terminal = (run: WorkflowRun) => ['completed', 'failed', 'cancelled', 'needs-attention'].includes(run.status);
const errorText = (error: unknown) => error instanceof Error && error.message.length <= 1024 ? error.message : 'Workflow operation failed (missing or oversized diagnostic)';
const identityValid = (identity: WorkflowNativeIdentity | undefined): identity is WorkflowNativeIdentity => !!identity &&
  typeof identity.runId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(identity.runId) &&
  typeof identity.taskId === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(identity.taskId);
const copy = <T>(value: T): T => workflowJson(value, WORKFLOW_LIMITS.ledgerBytes) as T;
// Bounded nofollow reads for final pure physical owner/head fences. Never call a
// host inspector here; check the same regular inode before, during and after reading.
const readAuthorityArtifact = (path: string, maxBytes: number) => {
  const before = lstatSync(path);
  workflowAssert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1 && before.size <= maxBytes, 'Authority artifact unsafe or oversized');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  try {
    const same = (st: ReturnType<typeof fstatSync>) => st.isFile() && st.dev === before.dev && st.ino === before.ino && st.nlink === 1 && st.size === before.size && st.mtimeMs === before.mtimeMs && st.ctimeMs === before.ctimeMs && st.mode === before.mode && st.uid === before.uid;
    workflowAssert(same(fstatSync(fd)), 'Authority artifact changed before read');
    const bytes = Buffer.alloc(before.size + 1); let length = 0;
    while (length < bytes.length) { const n = readSync(fd, bytes, length, bytes.length - length, null); if (!n) break; length += n; }
    workflowAssert(length === before.size && same(fstatSync(fd)) && same(lstatSync(path)), 'Authority artifact changed during read');
    return bytes.subarray(0, length);
  } finally { closeSync(fd); }
};
const recoveryResultStatus = (status: WorkflowNativeOutcome['status'] | 'failed'): RecoveryResultStatus => status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : status === 'unverified' ? 'uncertain' : 'failed';
type RuntimeCodingWorkspace = { stageRoot: string; read(path: string): string; write(path: string, text: string): void; inspect(): { hash: string; changedPaths: string[]; files: Array<{ path: string; before: Buffer | null; after: Buffer | null; beforeHash: string | null; afterHash: string | null; preview?: string; clippedBytes?: number }>; totalBytes?: number; clippedBytes?: number }; assertFreshDestination(): void; apply(candidateHash: string): { status: 'applied' | 'partial' | 'rejected'; appliedPaths: string[]; error?: string }; recoveryManifest?(): import('./workflow-workspace.js').WorkspaceRecoveryManifest; cleanup?(): void; settle?(): void };
const owners = new WeakMap<ClankersStateContainer, symbol>();
/** Non-executing recovery. Unknown/corrupt ledgers are errors, never an empty replacement. */
export function recoverWorkflowState(value: unknown): WorkflowState {
  const state = copy(value) as WorkflowState;
  const recoveryMutations: Array<() => void> = [];
  const recoveryOriginals: Array<() => void> = [];
  workflowAssert(state && state.version === 1 && Array.isArray(state.definitions) && Array.isArray(state.runs) &&
    Object.keys(state).every(k => ['version', 'definitions', 'runs'].includes(k)), 'Invalid workflow ledger');
  workflowAssert(state.definitions.length <= 16 && state.runs.length <= 16, 'Workflow retention limit exceeded');
  workflowAssert(new Set(state.definitions.map(d => d.id)).size === state.definitions.length && new Set(state.runs.map(r => r.workflowRunId)).size === state.runs.length, 'Duplicate workflow identities');
  state.definitions = state.definitions.map(validateWorkflowDefinition);
  // Cross-attempt evidence is checked while every retained attempt is still raw.
  for (const run of state.runs.filter(r => r.definition?.version === 2 || r.definition?.version === 3)) {
    workflowAssert(new Set(state.runs.filter(r => r.familyId === run.familyId).map(r => r.attemptNo)).size === state.runs.filter(r => r.familyId === run.familyId).length, 'Duplicate family attempt');
    workflowAssert(run.attemptNo === 1 ? run.retryOf === undefined && run.recoveryOf === undefined && run.familyId === run.workflowRunId : ((typeof run.retryOf === 'string') !== (typeof run.recoveryOf === 'string')) && (run.retryOf ?? run.recoveryOf) !== run.workflowRunId, 'Invalid family lineage');
    const previous = state.runs.find(r => r.workflowRunId === (run.retryOf ?? run.recoveryOf));
    if (previous) {
      const retryLink = typeof run.retryOf === 'string';
      workflowAssert(previous.familyId === run.familyId && previous.attemptNo + 1 === run.attemptNo && (retryLink ? previous.supersededBy === run.workflowRunId && previous.cleanupSettled && ['failed', 'cancelled'].includes(previous.status) : previous.recovered && previous.status === 'needs-attention' && previous.supersededBy === run.workflowRunId && previous.recovery?.selection?.continuationAttemptId === run.workflowRunId && previous.recovery.selection.sourceAttemptId === previous.workflowRunId && run.recovery?.origin?.sourceAttemptId === previous.workflowRunId && run.recovery.origin.continuationAttemptId === run.workflowRunId && workflowHash(previous.recovery.selection) === workflowHash(run.recovery.origin)) && previous.admissions <= run.admissions && previous.definitionHash === run.definitionHash && workflowHash(previous.inputs) === workflowHash(run.inputs) && workflowHash(previous.agents) === workflowHash(run.agents), 'Invalid previous attempt evidence');
      for (const { step } of workflowStepEntries(run)) for (const unit of step.units) if (unit.reusedFrom) {
        const old = workflowStepEntries(previous).flatMap(e => e.step.units).find(u => u.id === unit.id);
        workflowAssert(old && old.status === 'completed' && old.cleanupSettled && old.inputHash === unit.inputHash && workflowHash(old.result) === workflowHash(unit.result) && workflowHash(old.native) === workflowHash(unit.native), 'Reused unit lacks exact settled prior evidence');
      }
    }
  }
  for (const run of state.runs) {
    const def = validateWorkflowDefinition(run.definition);
    workflowAssert(Object.keys(run).every(k => ['workflowRunId', 'familyId', 'attemptNo', 'retryOf', 'recoveryOf', 'supersededBy', 'definition', 'definitionHash', 'inputs', 'agents', 'concurrency', 'status', 'createdAt', 'updatedAt', 'admissions', 'cleanupSettled', 'recovered', 'steps', 'report', 'error', 'recoveryOriginal', 'recovery'].includes(k)), 'Unknown run ledger field');
    workflowAssert(typeof run.workflowRunId === 'string' && run.workflowRunId.length > 0 && run.workflowRunId.length <= 160 && typeof run.familyId === 'string' && run.familyId.length > 0 &&
      Number.isSafeInteger(run.attemptNo) && run.attemptNo >= 1 && run.attemptNo <= 3 && Number.isSafeInteger(run.admissions) && run.admissions >= 0 && run.admissions <= 256 &&
      Number.isSafeInteger(run.concurrency) && run.concurrency >= 1 && run.concurrency <= 32 &&
      typeof run.cleanupSettled === 'boolean' && typeof run.recovered === 'boolean' &&
      ['running', 'paused', 'cancelling', 'completed', 'failed', 'cancelled', 'needs-attention'].includes(run.status) &&
      typeof run.createdAt === 'string' && Number.isFinite(Date.parse(run.createdAt)) && typeof run.updatedAt === 'string' && Number.isFinite(Date.parse(run.updatedAt)) &&
      workflowHash(def) === run.definitionHash, 'Invalid workflow run');
    run.definition = def; run.inputs = workflowJson(run.inputs, WORKFLOW_LIMITS.inputBytes); validateWorkflowValue(run.inputs, def.inputSchema);
    workflowAssert(run.agents && typeof run.agents === 'object' && Array.isArray(run.steps) && run.steps.length === def.steps.length, 'Invalid workflow steps/agents');
    if (def.id === 'read-only-review') validateReviewInputs(run.inputs);
    if (run.report !== undefined) workflowJson(run.report);
    const expectedAgents = [...new Set(def.steps.flatMap(s => s.body ?? [s]).flatMap(s => s.kind === 'native' ? [s.agentId!] : s.kind === 'coding' ? [validateCodingPolicy(s.coding!.policy as import('./workflow-coding.js').WorkflowCodingPolicy).identity.workerAgentId, validateCodingPolicy(s.coding!.policy as import('./workflow-coding.js').WorkflowCodingPolicy).identity.rootAgentId] : []))].sort();
    workflowAssert(Object.keys(run.agents).sort().join(',') === expectedAgents.join(','), 'Frozen agent set mismatch');
    for (const agent of Object.values(run.agents)) normalizeWorkflowAgent(agent);
    // Check fingerprints before recovery changes any dependency status.
    if (def.version === 2 || def.version === 3) validateV2Ledger(run);
    for (const { spec, step, iterationId } of workflowStepEntries(run)) for (const unit of step.units)
      workflowAssert(unit.inputHash === workflowUnitHash(run, qualifyWorkflowStep(spec, iterationId), unit.inputs), 'Recovered materialized input/dependency hash mismatch');
    const ids = new Set<string>(); let live = false;
    for (const entry of workflowStepEntries(run)) {
      const { step } = entry, spec = qualifyWorkflowStep(entry.spec, entry.iterationId);
      workflowAssert(Object.keys(step).every(k => ['id', 'status', 'units', 'output', 'error', ...((def.version === 2 || def.version === 3) ? ['condition', 'skipReason', 'iterations', 'termination'] : [])].includes(k)), 'Unknown step ledger field');
      if (step.output !== undefined) workflowJson(step.output);
      workflowAssert(step.id === spec.id && Array.isArray(step.units) && step.units.length <= (spec.fanout?.maxItems ?? 1) &&
        ['queued', 'running', 'completed', 'failed', 'cancelled', 'skipped', 'unverified'].includes(step.status), 'Invalid step ledger');
      if (spec.kind === 'native') {
        const agent = run.agents[spec.agentId!]; workflowAssert(agent && agent.id === spec.agentId && typeof agent.model === 'string' && agent.model.length > 0, 'Missing frozen agent');
      }
      for (const [index, unit] of step.units.entries()) {
        workflowAssert(Object.keys(unit).every(k => ['id', 'stepId', 'index', 'status', 'inputHash', 'inputs', 'result', 'error', 'native', 'cleanupSettled', 'reusedFrom', ...(def.version === 3 ? ['coding'] : [])].includes(k)), 'Unknown unit ledger field');
        workflowAssert(unit.stepId === step.id && unit.id === `${step.id}:${index}` && !ids.has(unit.id) && unit.index === index &&
          typeof unit.inputHash === 'string' && /^[a-f0-9]{64}$/.test(unit.inputHash) && typeof unit.cleanupSettled === 'boolean' &&
          ['queued', 'running', 'completed', 'failed', 'cancelled', 'skipped', 'unverified'].includes(unit.status), 'Invalid unit ledger');
        ids.add(unit.id); workflowJson(unit.inputs, WORKFLOW_LIMITS.promptBytes);
        if (unit.native) workflowAssert(identityValid(unit.native), 'Invalid native identity');
        if (unit.reusedFrom) workflowAssert(typeof unit.reusedFrom.workflowRunId === 'string' && typeof unit.reusedFrom.unitId === 'string' && identityValid(unit.reusedFrom.native), 'Invalid reuse identity');
        if (unit.status === 'completed' && spec.kind === 'native') {
          workflowAssert(unit.result !== undefined && identityValid(unit.native) && unit.cleanupSettled, 'Completed unit lacks validated result/identity/settlement');
          validateWorkflowValue(workflowJson(unit.result, WORKFLOW_LIMITS.resultBytes), spec.outputSchema!);
        }
        if (unit.status === 'completed' && spec.kind === 'coding') {
          workflowAssert(unit.result !== undefined && unit.cleanupSettled, 'Completed coding unit lacks result/settlement');
          validateWorkflowValue(workflowJson(unit.result, WORKFLOW_LIMITS.resultBytes), spec.outputSchema!);
        }
        if (unit.status === 'running') { live = true; recoveryMutations.push(() => { unit.status = 'unverified'; unit.cleanupSettled = false; unit.error = 'Recovered native work is not reconnected; settlement unverified'; }); }
        if (unit.status === 'queued') recoveryMutations.push(() => { unit.status = 'skipped'; unit.error = 'Recovery disables automatic admission'; });
      }
      if (['running', 'queued'].includes(step.status)) { live = true; recoveryMutations.push(() => { step.status = 'unverified'; step.error = 'Recovered step requires attention; no replay'; if (def.version === 2 || def.version === 3) { step.skipReason = 'recovery'; if (spec.kind === 'repeat') step.termination = 'recovery'; } }); }
    }
    if (run.recovery !== undefined) { const validated = validateRecoveryCheckpoint(run.recovery); workflowAssert(validated.ok, 'Invalid workflow recovery checkpoint'); run.recovery = validated.value; const trustedRecoveryConfig = { enabled: true, durablePort: 'ensureWriter/inspectOwner:v1', sourceContract: workflowRecoverySourceContract() }; workflowAssert(run.recovery.workflowRunId === run.workflowRunId && run.recovery.familyId === run.familyId && run.recovery.attemptNo === run.attemptNo && run.recovery.definitionHash === run.definitionHash && run.recovery.inputsHash === workflowHash(run.inputs) && run.recovery.policyHash === workflowHash({ definition: run.definition, agents: run.agents, trustedRecoveryConfig }) && run.recovery.configurationHash === workflowHash({ concurrency: run.concurrency, trustedRecoveryConfig }) && run.recovery.budget.usedAdmissions === run.admissions, 'Recovery checkpoint/run binding mismatch'); for (const op of run.recovery.operations) { const entry = workflowStepEntries(run).find(e => qualifyWorkflowStep(e.spec, e.iterationId).id === op.stepId && (e.iterationId ?? undefined) === op.iterationId); const spec = entry ? qualifyWorkflowStep(entry.spec, entry.iterationId) : undefined; const unit = entry?.step.units.find(u => u.id === op.unitId); const context = spec ? workflowStepContext(run, spec.id) : undefined; const expectedDependencyHash = spec && unit ? workflowRecoveryDependencyHash(run, spec, unit, workflowRecoverySourceContract()) : undefined; const expectedPolicyHash = spec?.kind === 'native' ? workflowHash({ kind: 'native', agent: run.agents[spec.agentId!], prompt: spec.prompt, outputSchema: spec.outputSchema, hostSourceContract: workflowRecoverySourceContract() }) : spec ? workflowHash({ kind: spec.kind, coding: spec.coding ?? null, agentId: spec.agentId ?? null }) : undefined; workflowAssert(!!entry && !!spec && !!unit && unit.inputHash === op.inputHash && op.dependencyHash === expectedDependencyHash && op.policyHash === expectedPolicyHash, 'Recovery checkpoint unit binding mismatch'); } }
    workflowAssert(run.recoveryOf === undefined || run.recovery !== undefined, 'Recovery lineage requires checkpoint origin/reservation');
    if (run.recoveryOriginal !== undefined) validateRecoveryOriginal(run);
    else recoveryOriginals.push(() => { run.recoveryOriginal = captureRecoveryOriginal(run); validateRecoveryOriginal(run); });
    if (!terminal(run) || live || !run.cleanupSettled) {
      recoveryMutations.push(() => { run.status = 'needs-attention'; run.cleanupSettled = false; run.error = 'Recovered work is not live or reconnected; no automatic admission'; });
    }
    recoveryMutations.push(() => { run.recovered = true; });
  }
  // Recovery anchors are retained evidence, not disposable summaries. Validate the complete
  // prefix while raw statuses/checkpoints are still available, before inert transformation.
  for (const run of state.runs) if (state.runs.some(other => other.familyId === run.familyId && other.recovery)) {
    workflowAssert(run.recovery, 'Recovery family attempt lacks checkpoint anchor');
    const cp = run.recovery;
    for (const [index, id] of cp.budget.attemptIds.entries()) {
      const retained = state.runs.find(other => other.workflowRunId === id);
      workflowAssert(retained?.recovery && retained.familyId === run.familyId && retained.attemptNo === index + 1, 'Recovery family anchor/source attempt is missing');
      workflowAssert(workflowHash(retained.recovery.budget.attemptIds) === workflowHash(cp.budget.attemptIds.slice(0, index + 1)), 'Recovery family prefix changed');
      workflowAssert(retained.recovery.budget.usedAdmissions <= cp.budget.usedAdmissions && retained.recovery.budget.correctionsUsed <= cp.budget.correctionsUsed, 'Recovery family admission/correction counter reset');
    }
    if (run.recoveryOf !== undefined || cp.origin !== undefined) {
      const predecessorId = cp.budget.attemptIds[run.attemptNo - 2];
      const predecessor = state.runs.find(other => other.workflowRunId === predecessorId);
      workflowAssert(run.attemptNo > 1 && run.recoveryOf === predecessorId && cp.origin?.sourceAttemptId === predecessorId && cp.origin.continuationAttemptId === run.workflowRunId && predecessor?.supersededBy === run.workflowRunId && predecessor.recovery?.selection && workflowHash(predecessor.recovery.selection) === workflowHash(cp.origin), 'Recovery predecessor/origin/reservation is missing or contradictory');
    }
    if (run.attemptNo > 1) {
      const previous = state.runs.find(other => other.workflowRunId === cp.budget.attemptIds[run.attemptNo - 2])!;
      workflowAssert((run.recoveryOf ?? run.retryOf) === previous.workflowRunId, 'Recovery family predecessor differs from retained budget prefix');
      const admitted = new Set(cp.operations.filter(op => ['native', 'check', 'review', 'application', 'application-gate'].includes(op.kind)).map(op => op.unitId)).size;
      workflowAssert(cp.budget.usedAdmissions >= previous.recovery!.budget.usedAdmissions + admitted, 'Recovery family admissions omit admitted child units');
    }
    if (cp.selection) {
      const child = state.runs.find(other => other.workflowRunId === cp.selection!.continuationAttemptId);
      workflowAssert(child?.recoveryOf === run.workflowRunId && child.recovery?.origin && workflowHash(child.recovery.origin) === workflowHash(cp.selection), 'Recovery selected child/origin is missing or contradictory');
    }
  }
  recoveryOriginals.forEach(mutate => mutate());
  recoveryMutations.forEach(mutate => mutate());
  // Newly retained observations must also fit the authoritative namespace budget.
  return copy(state);
}

const recoveryOriginalBytes = 262144;
function boundedRecoveryDiagnostic(value: unknown): void {
  workflowAssert(value === undefined || (typeof value === 'string' && value.length <= 1024), 'Invalid recovery original diagnostic');
}
function captureRecoveryOriginal(run: WorkflowRun): NonNullable<WorkflowRun['recoveryOriginal']> {
  return workflowJson({ version: 1, recordedAt: run.updatedAt, status: run.status, cleanupSettled: run.cleanupSettled, recovered: run.recovered, ...(run.error !== undefined ? { error: run.error } : {}),
    steps: workflowStepEntries(run).map(({ step }) => ({ id: step.id, status: step.status, ...(step.error !== undefined ? { error: step.error } : {}), ...(step.skipReason !== undefined ? { skipReason: step.skipReason } : {}), ...(step.termination !== undefined ? { termination: step.termination } : {}),
      units: step.units.map(unit => ({ id: unit.id, stepId: unit.stepId, index: unit.index, status: unit.status, cleanupSettled: unit.cleanupSettled, ...(unit.error !== undefined ? { error: unit.error } : {}) })) })) }, recoveryOriginalBytes) as unknown as NonNullable<WorkflowRun['recoveryOriginal']>;
}
function validateRecoveryOriginal(run: WorkflowRun): void {
  const value = workflowJson(run.recoveryOriginal, recoveryOriginalBytes) as unknown as NonNullable<WorkflowRun['recoveryOriginal']>;
  const unitStatuses = ['queued', 'running', 'completed', 'failed', 'cancelled', 'skipped', 'unverified'];
  workflowAssert(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => ['version', 'recordedAt', 'status', 'cleanupSettled', 'recovered', 'error', 'steps'].includes(k)), 'Invalid recovery original');
  workflowAssert(value.version === 1 && typeof value.recordedAt === 'string' && Number.isFinite(Date.parse(value.recordedAt)) && ['running', 'paused', 'cancelling', 'completed', 'failed', 'cancelled', 'needs-attention'].includes(value.status) && typeof value.cleanupSettled === 'boolean' && typeof value.recovered === 'boolean', 'Invalid recovery original');
  boundedRecoveryDiagnostic(value.error);
  const entries = workflowStepEntries(run);
  workflowAssert(entries.length <= 256 && entries.reduce((total, entry) => total + entry.step.units.length, 0) <= 256, 'Recovery original observation limit exceeded');
  workflowAssert(Array.isArray(value.steps) && value.steps.length === entries.length, 'Recovery original step mismatch');
  for (const [index, entry] of entries.entries()) {
    const step = value.steps[index];
    workflowAssert(step && typeof step === 'object' && !Array.isArray(step) && Object.keys(step).every(k => ['id', 'status', 'error', 'skipReason', 'termination', 'units'].includes(k)), 'Invalid recovery original step');
    workflowAssert(step.id === entry.step.id && unitStatuses.includes(step.status), 'Recovery original step mismatch');
    boundedRecoveryDiagnostic(step.error);
    if (run.definition.version === 1) workflowAssert(step.skipReason === undefined && step.termination === undefined, 'Recovery original field not applicable');
    workflowAssert(step.skipReason === undefined || ['condition-false', 'dependency', 'cancelled', 'recovery'].includes(step.skipReason), 'Invalid recovery original skip reason');
    workflowAssert(step.termination === undefined || (entry.spec.kind === 'repeat' && ['converged', 'max-iterations', 'body-failed', 'invalid-transition', 'cancelled', 'recovery'].includes(step.termination)), 'Invalid recovery original termination');
    workflowAssert(Array.isArray(step.units) && step.units.length === entry.step.units.length, 'Recovery original unit mismatch');
    for (const [unitIndex, source] of entry.step.units.entries()) {
      const unit = step.units[unitIndex];
      workflowAssert(unit && typeof unit === 'object' && !Array.isArray(unit) && Object.keys(unit).every(k => ['id', 'stepId', 'index', 'status', 'cleanupSettled', 'error'].includes(k)), 'Invalid recovery original unit');
      workflowAssert(unit.id === source.id && unit.stepId === source.stepId && unit.index === source.index && unitStatuses.includes(unit.status) && typeof unit.cleanupSettled === 'boolean', 'Recovery original unit mismatch');
      boundedRecoveryDiagnostic(unit.error);
    }
  }
}

/** Validate the raw v2 ledger before recovery changes statuses. Never repair malformed history. */
function validateV2Ledger(run: WorkflowRun): void {
  const exact = (value: object, keys: string[]) => workflowAssert(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => keys.includes(k)), 'Unknown v2 ledger field');
  const diagnostic = (value: unknown) => workflowAssert(value === undefined || (typeof value === 'string' && value.length <= 1024), 'Invalid bounded diagnostic');
  diagnostic(run.error);
  workflowAssert(run.steps.every((s, i) => s.id === run.definition.steps[i].id), 'Noncontiguous top-level ledger');
  if (!run.recovered && terminal(run)) workflowAssert(run.cleanupSettled === workflowStepEntries(run).every(({ step }) => step.units.every(u => u.cleanupSettled)), 'Run settlement disagrees with unit ledger');
  let count = 0, admissions = 0;
  const runIds = new Set<string>(), taskIds = new Set<string>();
  for (const { spec, step, iterationId } of workflowStepEntries(run)) {
    const qualified = qualifyWorkflowStep(spec, iterationId), context = workflowStepContext(run, step.id);
    workflowAssert(step.id === qualified.id && Array.isArray(step.units), 'Invalid qualified step');
    diagnostic(step.error);
    workflowAssert(step.condition === undefined || (typeof step.condition === 'boolean' && !!spec.when), 'Invalid condition decision');
    workflowAssert(step.skipReason === undefined || ['condition-false', 'dependency', 'cancelled', 'recovery'].includes(step.skipReason), 'Invalid skip reason');
    workflowAssert(step.termination === undefined || (spec.kind === 'repeat' && ['converged', 'max-iterations', 'body-failed', 'invalid-transition', 'cancelled', 'recovery'].includes(step.termination)), 'Invalid repeat termination');
    const outputs: Record<string, WorkflowJson> = {};
    for (const dep of context.steps) {
      const id = context.iteration ? dep.id.slice(context.iteration.id.length + 1) : dep.id;
      if (dep.output !== undefined) outputs[id] = dep.output;
      else if (spec.consumeSkips && dep.skipReason === 'condition-false') outputs[id] = workflowUnavailableEnvelope(dep);
      else if (spec.consumeFailures && ['failed', 'unverified'].includes(dep.status)) outputs[id] = workflowUnavailableEnvelope(dep);
    }
    const resolve = (b: WorkflowBinding, item?: WorkflowJson) => 'value' in b ? b.value : resolveWorkflowRef(b.ref, run.inputs, outputs, item, context.iteration?.state);
    if (step.condition !== undefined) workflowAssert(step.condition === evaluateWorkflowCondition(spec.when!, b => resolve(b)), 'Condition decision mismatch');
    if (step.skipReason === 'dependency') workflowAssert(step.status === 'skipped' && step.units.length === 0 && step.output === undefined && step.iterations === undefined, 'Dependency skip materialized work');
    if (step.condition === false || step.skipReason === 'condition-false') workflowAssert(step.condition === false && step.skipReason === 'condition-false' && step.status === 'skipped' && step.units.length === 0 && step.output === undefined && step.iterations === undefined, 'False condition must have no materialized work');
    if (step.units.length || step.iterations?.length || step.status === 'completed') {
      workflowAssert(!spec.when || step.condition === true, 'Materialized step lacks true condition');
      for (const id of qualified.dependsOn) {
        const dep = context.steps.find(d => d.id === id)!;
        workflowAssert(dep.status === 'completed' || (spec.kind === 'aggregate' && (dep.skipReason === 'condition-false' ? spec.consumeSkips : spec.consumeFailures && ['failed', 'unverified'].includes(dep.status))), 'Invalid materialized dependency');
      }
    }
    if (spec.kind === 'repeat') {
      count++;
      workflowAssert(step.units.length === 0 && (step.iterations === undefined || Array.isArray(step.iterations)), 'Repeat cannot own native units');
      const iterations = step.iterations ?? [];
      workflowAssert(iterations.length <= spec.maxIterations!, 'Iteration limit exceeded');
      if (['running', 'completed'].includes(step.status)) workflowAssert(iterations.length > 0, 'Repeat missing iteration ledger');
      for (const [index, iteration] of iterations.entries()) {
        exact(iteration, ['id', 'index', 'state', 'steps', 'feedback', 'decision', 'error']); diagnostic(iteration.error);
        if (iteration.error !== undefined) workflowAssert(index === iterations.length - 1 && step.status === 'failed' && ['invalid-transition', 'body-failed', 'max-iterations'].includes(step.termination!), 'Transition error contradicts repeat status');
        workflowAssert(iteration.index === index && iteration.id === `${step.id}@${index}` && Array.isArray(iteration.steps) && iteration.steps.length === spec.body!.length, 'Invalid iteration identity/count');
        workflowAssert(iteration.steps.every((s, i) => s.id === `${iteration.id}/${spec.body![i].id}`), 'Noncontiguous body ledger');
        validateWorkflowValue(iteration.state, spec.stateSchema!);
        const previous = iterations[index - 1];
        if (previous) workflowAssert(previous.decision === false && previous.feedback !== undefined && !previous.error && previous.steps.every(s => (s.status === 'completed' || s.skipReason === 'condition-false') && s.units.every(u => u.cleanupSettled)), 'Iteration after failed/uncertain transition');
        workflowAssert(workflowHash(iteration.state) === workflowHash(previous ? previous.feedback : resolve(spec.initial!)), 'Iteration state continuity mismatch');
        const bodyOutputs = Object.fromEntries(iteration.steps.filter(s => s.status === 'completed' && s.output !== undefined).map(s => [s.id.slice(iteration.id.length + 1), s.output!]));
        const boundary = (b: WorkflowBinding, state: WorkflowJson) => 'value' in b ? b.value : resolveWorkflowRef(b.ref, run.inputs, bodyOutputs, undefined, state);
        if (iteration.feedback !== undefined) {
          workflowAssert(iteration.steps.every(s => (s.status === 'completed' || s.skipReason === 'condition-false') && s.units.every(u => u.cleanupSettled)), 'Feedback after failed/uncertain body');
          validateWorkflowValue(iteration.feedback, spec.stateSchema!);
          workflowAssert(workflowHash(iteration.feedback) === workflowHash(boundary(spec.feedback!, iteration.state)), 'Feedback mismatch');
        }
        if (iteration.decision !== undefined) {
          workflowAssert(typeof iteration.decision === 'boolean' && iteration.feedback !== undefined && iteration.decision === evaluateWorkflowCondition(spec.until!, b => boundary(b, iteration.feedback!)), 'Invalid transition decision');
          if (iteration.decision) workflowAssert(index === iterations.length - 1, 'Iteration after convergence');
        }
      }
      if (step.status === 'completed') {
        const last = iterations.at(-1)!;
        workflowAssert(last?.decision === true && last.error === undefined && step.error === undefined && step.output !== undefined && step.termination === 'converged', 'Completed repeat lacks convergence');
        validateWorkflowValue(step.output, spec.outputSchema!);
        const bodyOutputs = Object.fromEntries(last.steps.filter(s => s.status === 'completed' && s.output !== undefined).map(s => [s.id.slice(last.id.length + 1), s.output!]));
        const expected = 'value' in spec.output! ? spec.output!.value : resolveWorkflowRef(spec.output!.ref, run.inputs, bodyOutputs, undefined, last.feedback);
        workflowAssert(workflowHash(step.output) === workflowHash(expected), 'Repeat output mismatch');
      } else workflowAssert(step.output === undefined, 'Unconverged repeat has output');
      if (step.termination === 'converged') workflowAssert(step.status === 'completed', 'Convergence requires completed repeat');
      if (step.termination === 'invalid-transition' || step.termination === 'body-failed') workflowAssert(step.status === 'failed', 'Failed termination requires failed repeat');
      if (step.termination === 'cancelled') workflowAssert(step.status === 'cancelled', 'Cancelled termination requires cancelled repeat');
      if (step.termination === 'recovery') workflowAssert(step.status === 'unverified', 'Recovery termination requires unverified repeat');
      if (step.termination === 'max-iterations') workflowAssert(step.status === 'failed' && iterations.length === spec.maxIterations && iterations.at(-1)?.decision === false, 'Invalid nonconvergence');
      continue;
    }
    workflowAssert(step.iterations === undefined, 'Nonrepeat has iterations');
    let items: WorkflowJson[] = [null];
    if (spec.fanout && (step.units.length || step.status === 'completed')) {
      const source = resolveWorkflowRef(spec.fanout.from, run.inputs, outputs, undefined, context.iteration?.state);
      workflowAssert(Array.isArray(source) && source.length <= spec.fanout.maxItems, 'Invalid recovered fanout'); items = source;
    }
    if (step.units.length || step.status === 'completed') workflowAssert(step.units.length === items.length, 'Materialized unit count mismatch');
    count += step.units.length;
    for (const [index, unit] of step.units.entries()) {
      diagnostic(unit.error);
      workflowAssert(unit.result === undefined || unit.status === 'completed', 'Uncompleted unit has result');
      workflowAssert(unit.status !== 'running' || spec.kind === 'native' || spec.kind === 'coding', 'Running unit has invalid ownership');
      const inputs = Object.fromEntries(Object.entries(spec.inputs!).map(([key, b]) => [key, resolve(b, spec.fanout ? items[index] : undefined)]));
      workflowAssert(workflowHash(inputs) === workflowHash(unit.inputs), 'Materialized unit inputs mismatch');
      if (unit.native) {
        exact(unit.native, ['runId', 'taskId']);
        workflowAssert(!runIds.has(unit.native.runId) && !taskIds.has(unit.native.taskId), 'Duplicate native identity');
        runIds.add(unit.native.runId); taskIds.add(unit.native.taskId);
        if (!unit.reusedFrom) admissions++;
      }
      if (unit.reusedFrom) { exact(unit.reusedFrom, ['workflowRunId', 'unitId', 'native']); exact(unit.reusedFrom.native, ['runId', 'taskId']); workflowAssert(unit.reusedFrom.workflowRunId === run.retryOf && unit.reusedFrom.unitId === unit.id && unit.status === 'completed' && unit.cleanupSettled && workflowHash(unit.reusedFrom.native) === workflowHash(unit.native), 'Invalid native reuse'); }
      if (unit.result !== undefined && spec.kind === 'native') validateWorkflowValue(unit.result, spec.outputSchema!);
      if (unit.status === 'completed') workflowAssert(unit.cleanupSettled && unit.result !== undefined, 'Completed unit lacks settled result');
      if (spec.kind === 'aggregate' && unit.status === 'completed') workflowAssert(workflowHash(unit.result) === workflowHash(aggregateWorkflow(spec.operation!, inputs)), 'Aggregate result mismatch');
      if (spec.kind === 'coding' && unit.status === 'completed') validateWorkflowValue(unit.result!, spec.outputSchema!);
    }
    if (step.status === 'completed') {
      workflowAssert(step.units.every(u => u.status === 'completed') && step.output !== undefined, 'Completed step inconsistent');
      const expected = spec.fanout ? step.units.map(workflowUnitEnvelope) : step.units[0].result;
      workflowAssert(workflowHash(expected) === workflowHash(step.output), 'Step output mismatch');
    }
  }
  workflowAssert(count <= 256 && admissions <= run.admissions, 'Runtime expansion/admission mismatch');
  if (run.report !== undefined) workflowAssert(run.steps.at(-1)?.output !== undefined && workflowHash(run.report) === workflowHash(run.steps.at(-1)!.output), 'Report does not match final output');
  if (run.status === 'completed') workflowAssert(workflowStepEntries(run).every(({ step }) => step.status === 'completed' || step.skipReason === 'condition-false') && run.cleanupSettled, 'Completed workflow contains failure');
}

/** One owned scheduler; no SDK, tools, files, eval, arbitrary loops or automatic retries. */
export function createWorkflowService(container: ClankersStateContainer, port: WorkflowNativePort, options: WorkflowServiceOptions = {}): WorkflowService {
  const onStartReservation = options.onStartReservation;
  const hostAdmission = options.assertAdmission;
  const maxAdmissions = options.maxAdmissions ?? WORKFLOW_LIMITS.admissions;
  workflowAssert(Number.isSafeInteger(maxAdmissions) && maxAdmissions >= 1 && maxAdmissions <= WORKFLOW_LIMITS.admissions, 'Native admission cap must be integer 1..256');
  let startInProgress = false;
  let expectedAutomationHash = onStartReservation ? workflowHash(container.read().extensions[AUTOMATION_EXTENSION_KEY] ?? null) : '';
  const hostNow = options.now ?? (() => new Date());
  let observedClock = { millis: Date.now(), ticks: process.hrtime.bigint() };
  const now = () => { const date = hostNow(); observedClock = { millis: date.getTime(), ticks: process.hrtime.bigint() }; return date; };
  let approvalEpoch = 0;
  const idFactory = options.idFactory ?? randomUUID;
  const existing = container.read().extensions[WORKFLOW_EXTENSION_KEY];
  const state: WorkflowState = existing === undefined ? { version: 1, definitions: [createReadOnlyReviewDefinition()], runs: [] } : recoverWorkflowState(existing);
  if (onStartReservation && container.read().extensions[AUTOMATION_EXTENSION_KEY] !== undefined) validateAutomationLedger(container.read().extensions[AUTOMATION_EXTENSION_KEY], state);
  const owner = Symbol('workflow-owner'); owners.set(container, owner);
  const listeners = new Set<(views: ReturnType<typeof workflowView>[]) => void>();
  const approvalRegistry = createWorkflowApprovalRegistry(now);
  const allocateCheckReceipt = options.coding?.allocateCheckReceipt;
  const codingCfg = options.coding ? freezeWorkflowData({ ...(options.coding.enabled !== undefined ? { enabled: options.coding.enabled } : {}), projectRoot: options.coding.projectRoot, stagingParent: options.coding.stagingParent, ...(options.coding.receiptParent !== undefined ? { receiptParent: options.coding.receiptParent } : {}), ...(options.coding.writablePaths !== undefined ? { writablePaths: options.coding.writablePaths } : {}), ...(options.coding.checkProfiles !== undefined ? { checkProfiles: options.coding.checkProfiles } : {}), ...(options.coding.receiptParent !== undefined ? { receiptParent: options.coding.receiptParent } : {}) }, WORKFLOW_LIMITS.definitionBytes) as WorkflowServiceOptions['coding'] : undefined;
  workflowAssert(options.recovery?.enabled !== true || (typeof options.recovery.durablePort?.ensureWriter === 'function' && typeof options.recovery.durablePort?.inspectOwner === 'function'), 'Durable recovery requires an owned persistence port');
  const recoveryEnabled = options.recovery?.enabled === true && !!options.recovery.durablePort;
  const recoveryPort = recoveryEnabled ? options.recovery!.durablePort! : undefined;
  workflowAssert(!recoveryEnabled || (options.recovery?.sourceConfig === undefined && options.recovery?.identityVersionHash === undefined), 'Versioned external dependency capture is not yet supported by this recovery producer');
  const recoverySourceContract = workflowRecoverySourceContract();
  const trustedRecoveryConfig = recoveryEnabled ? freezeWorkflowData({ enabled: true, durablePort: 'ensureWriter/inspectOwner:v1', sourceContract: recoverySourceContract }, WORKFLOW_LIMITS.definitionBytes) : undefined;
  let recoveryOwnerEvidence: WorkflowRecoveryWriterOwnerEvidence | undefined;
  const recoveryConfigurationHash = (run: WorkflowRun) => workflowHash({ concurrency: run.concurrency, trustedRecoveryConfig: trustedRecoveryConfig ?? null });
  const recoveryPolicyHash = (run: WorkflowRun) => workflowHash({ definition: run.definition, agents: run.agents, trustedRecoveryConfig: trustedRecoveryConfig ?? null });
  const recoveryOperationPolicyHash = (run: WorkflowRun, spec: WorkflowStep) => workflowHash(spec.kind === 'native' ? { kind: 'native', agent: run.agents[spec.agentId!], prompt: spec.prompt, outputSchema: spec.outputSchema, hostSourceContract: recoverySourceContract } : { kind: spec.kind, coding: spec.coding ?? null, agentId: spec.agentId ?? null });
  const recoveryDependencyHash = (run: WorkflowRun, spec: WorkflowStep, unit: WorkflowUnit) => workflowRecoveryDependencyHash(run, spec, unit, recoverySourceContract);
  const assertRecoveryOwner = () => {
    if (!recoveryEnabled) return;
    workflowAssert(recoveryOwnerEvidence, 'Recovery writer owner proof missing');
    const inspected = recoveryPort!.inspectOwner();
    workflowAssert(!inspected.blocker && !inspected.claimPresent && inspected.ownerValid === true && inspected.owner && workflowHash(inspected.owner) === workflowHash(recoveryOwnerEvidence) && inspected.owner.generation === recoveryOwnerEvidence.generation, 'Recovery writer ownership changed');
    return inspected;
  };
  // The filesystem-backed port supplies physical identities. Verify those and the
  // actual head/claim without calling the host inspector again at the pure boundary.
  // Abstract host ports remain responsible for the truth of their synchronous observation.
  const pureRecoveryOwner = (inspected: ReturnType<typeof assertRecoveryOwner>) => {
    if (!inspected || recoveryOwnerEvidence?.lockDev === undefined) return;
    const evidence = recoveryOwnerEvidence;
    const lock = lstatSync(inspected.lockDir), markerPath = resolve(inspected.lockDir, 'owner.json'), marker = lstatSync(markerPath);
    workflowAssert(lock.isDirectory() && !lock.isSymbolicLink() && lock.dev === evidence.lockDev && lock.ino === evidence.lockIno && (lock.mode & 0o777) === 0o700, 'Recovery writer lock changed after callback');
    workflowAssert(marker.isFile() && !marker.isSymbolicLink() && marker.nlink === 1 && marker.size > 0 && marker.size <= 4096 && marker.dev === evidence.markerDev && marker.ino === evidence.markerIno && (marker.mode & 0o777) === 0o600, 'Recovery writer marker changed after callback');
    const recordedOwner = JSON.parse(readAuthorityArtifact(markerPath, 4096).toString('utf8'));
    workflowAssert(recordedOwner.version === 1 && workflowHash(recordedOwner.owner) === workflowHash(evidence), 'Recovery writer owner changed after callback');
    let claimAbsent = false;
    try { lstatSync(inspected.claimDir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') claimAbsent = true; else throw error; }
    workflowAssert(claimAbsent, 'Recovery writer claim changed after callback');
    const snapshot = lstatSync(inspected.snapshotFile);
    workflowAssert(snapshot.isFile() && !snapshot.isSymbolicLink() && snapshot.size <= 64 * 1024 * 1024, 'Recovery snapshot unsafe after callback');
    workflowAssert(createHash('sha256').update(readAuthorityArtifact(inspected.snapshotFile, 64 * 1024 * 1024)).digest('hex') === inspected.actualSnapshotHash && inspected.actualSnapshotHash === inspected.expectedSnapshotHash, 'Recovery snapshot head changed after callback');
  };
  const newRecoveryCheckpoint = (run: WorkflowRun, priorAdmissions: number, previous?: WorkflowRun): RecoveryCheckpointV1 => {
    const previousIds = previous?.recovery?.budget.attemptIds;
    workflowAssert(run.attemptNo === 1 || previousIds !== undefined, 'Recovery retry lacks previous attempt proof');
    const attemptIds = run.attemptNo === 1 ? [run.workflowRunId] : [...previousIds!, run.workflowRunId];
    workflowAssert(attemptIds.length === run.attemptNo && attemptIds[0] === run.familyId, 'Recovery attempt lineage mismatch');
    return { version: 1, sequence: 0, workflowRunId: run.workflowRunId, familyId: run.familyId, attemptNo: run.attemptNo, definitionHash: run.definitionHash, inputsHash: workflowHash(run.inputs), policyHash: recoveryPolicyHash(run), configurationHash: recoveryConfigurationHash(run), budget: { maxAttempts: 3, maxAdmissions: 256, usedAdmissions: priorAdmissions, attemptIds, correctionsUsed: previous?.recovery?.budget.correctionsUsed ?? 0 }, operations: [] };
  };
  const validateRunRecovery = (run: WorkflowRun) => {
    if (run.recovery === undefined) return;
    const validated = validateRecoveryCheckpoint(run.recovery); workflowAssert(validated.ok, 'Invalid workflow recovery checkpoint');
    const cp = validated.value;
    workflowAssert(cp.workflowRunId === run.workflowRunId && cp.familyId === run.familyId && cp.attemptNo === run.attemptNo && cp.definitionHash === run.definitionHash && cp.inputsHash === workflowHash(run.inputs) && cp.policyHash === recoveryPolicyHash(run) && cp.configurationHash === recoveryConfigurationHash(run) && cp.budget.usedAdmissions === run.admissions, 'Recovery checkpoint/run binding mismatch');
    for (const op of cp.operations) {
      const entry = workflowStepEntries(run).find(e => qualifyWorkflowStep(e.spec, e.iterationId).id === op.stepId && (e.iterationId ?? undefined) === op.iterationId);
      const spec = entry ? qualifyWorkflowStep(entry.spec, entry.iterationId) : undefined;
      const unit = entry?.step.units.find(u => u.id === op.unitId);
      workflowAssert(!!entry && !!spec && !!unit && unit.index === Number(unit.id.slice(unit.id.lastIndexOf(':') + 1)) && unit.inputHash === op.inputHash && unit.inputHash === workflowUnitHash(run, spec, unit.inputs), 'Recovery checkpoint unit binding mismatch');
      workflowAssert(op.dependencyHash === recoveryDependencyHash(run, spec, unit) && op.policyHash === recoveryOperationPolicyHash(run, spec), 'Recovery checkpoint operation binding mismatch');
    }
  };
  const recoveryAdmissionIntent = (run: WorkflowRun, spec: WorkflowStep, unit: WorkflowUnit, kind: RecoveryOperationKind) => {
    if (!recoveryEnabled || !run.recovery) return undefined;
    workflowAssert(kind === 'native' || kind === 'check' || kind === 'review' || kind === 'application-gate', 'Unsupported recovery admission kind');
    assertSelectedUnit(run, unit);
    const usage = recoveryWriterUsage(state.runs, run);
    const block = workflowStepContext(run, spec.id).block;
    if (block && spec.coding?.operation === 'stage-write') {
      const blockUsage = usage.blocks.find(b => b.blockId === block.id)!;
      workflowAssert(blockUsage.admittedWriters < blockUsage.limit, 'Family repeat writer/correction allowance exhausted');
      workflowAssert(usage.correctionsUsed + (blockUsage.admittedWriters > 0 ? 1 : 0) <= 96, 'Cumulative correction checkpoint bound exhausted before admission');
    }
    const opId = `${run.workflowRunId}:${unit.id}:${kind}:${run.recovery.sequence}`;
    const context = workflowStepContext(run, spec.id);
    const result = appendRecoveryIntent(run.recovery, { kind, id: opId, stepId: spec.id, unitId: unit.id, ...(context.iteration?.id ? { iterationId: context.iteration.id } : {}), inputHash: unit.inputHash, dependencyHash: recoveryDependencyHash(run, spec, unit), policyHash: recoveryOperationPolicyHash(run, spec), paths: [], preimage: null, postimage: null, intent: { recordedAt: now().toISOString() } });
    workflowAssert(result.ok, 'Recovery intent validation failed'); run.recovery = result.value; run.recovery.budget.correctionsUsed = recoveryWriterUsage(state.runs, run, true).correctionsUsed; return opId;
  };
  const recoveryAdmissionResult = (run: WorkflowRun, opId: string | undefined, status: RecoveryResultStatus, cleanup: 'settled' | 'uncertain' | 'not-required', evidence?: unknown) => {
    if (!recoveryEnabled || !run.recovery || !opId) return;
    const result = appendRecoveryResult(run.recovery, opId, { recordedAt: now().toISOString(), status, cleanup, ...(evidence !== undefined ? { evidenceHash: workflowHash(evidence), resultHash: workflowHash(evidence) } : {}) }, { nativeAlreadyCompleted: status === 'completed' ? true : undefined });
    workflowAssert(result.ok, 'Recovery result validation failed'); run.recovery = result.value;
  };
  const recoveryEffectIntent = (run: WorkflowRun, spec: WorkflowStep, unit: WorkflowUnit, kind: RecoveryOperationKind, paths: string[], preimage: Record<string, string | null> | null, postimage: Record<string, string | null> | null, generation?: string) => {
    if (!recoveryEnabled || !run.recovery) return undefined;
    const opId = `${run.workflowRunId}:${unit.id}:${kind}:${run.recovery.sequence}`;
    const context = workflowStepContext(run, spec.id);
    const result = appendRecoveryIntent(run.recovery, { kind, id: opId, stepId: spec.id, unitId: unit.id, ...(context.iteration?.id ? { iterationId: context.iteration.id } : {}), inputHash: unit.inputHash, dependencyHash: recoveryDependencyHash(run, spec, unit), policyHash: recoveryOperationPolicyHash(run, spec), ...(generation ? { generation } : {}), paths, preimage, postimage, intent: { recordedAt: now().toISOString() } });
    workflowAssert(result.ok, 'Recovery effect intent validation failed'); run.recovery = result.value; validateRunRecovery(run); stamp(run); persist(); return opId;
  };
  type CodingEffectContext = { run: WorkflowRun; spec: WorkflowStep; unit: WorkflowUnit };
  const assertWorkspaceReceiptCapacity = (run: WorkflowRun, spec: WorkflowStep, intent?: WorkspaceEffectIntent | WorkspaceLeaseReleaseIntent) => {
      const policy = validateCodingPolicy(spec.coding!.policy as import('./workflow-coding.js').WorkflowCodingPolicy);
      const paths = [...new Set([...(policy.scope.readonlyPaths ?? []), ...policy.scope.writablePaths])];
      const workspace = latestCodingSession(run)?.workspace;
      const manifest = workspace?.recoveryManifest?.();
      const currentManifestBytes = manifest ? Buffer.byteLength(JSON.stringify(manifest), 'utf8') : 0;
      // Initial manifest growth includes all baseline parent identities, staged files/dirs,
      // leases and effect entries, not a fixed 512-node reserve. This intentionally conservative
      // envelope may reject a large ledger earlier; it is never persisted as synthetic evidence.
      const rootDepth = (codingCfg?.projectRoot.split('/').length ?? 0);
      const predictedNodes = 512 + paths.reduce((n, path) => n + 256 + 64 * (rootDepth + path.split('/').length), 0) + (manifest?.effects.length ?? paths.length) * 96;
      const predictedBytes = Math.max(currentManifestBytes + Buffer.byteLength(JSON.stringify(intent ?? {}), 'utf8') * 3 + 8192, predictedNodes * 64);
      workflowAssert(predictedNodes < WORKFLOW_LIMITS.nodes, 'Observed workspace receipt capacity exhausted before effect');
      const width = Math.ceil(predictedBytes / predictedNodes);
      workflowJson({ ...state, receiptCapacityCheck: Array.from({ length: predictedNodes }, () => 'x'.repeat(width)) }, WORKFLOW_LIMITS.ledgerBytes);
    };
  const makeCodingEffectHooks = (session: { effectContext?: CodingEffectContext }): WorkspaceEffectHooks | undefined => {
    if (!recoveryEnabled) return undefined;
    const opIds = new Map<string, string>();
    const ctx = () => { workflowAssert(session.effectContext, 'Coding workspace effect lacks current admitted unit context'); return session.effectContext; };
    const remember = (key: string, opId: string | undefined) => { if (opId) opIds.set(key, opId); };
    const find = (key: string) => opIds.get(key);
    const save = () => { try { validateRunRecovery(ctx().run); stamp(ctx().run); persist(); } catch (error) { authorityLost = true; cleanupUncertain = true; active.forEach(a => a.controller.abort()); refreshActivity(); throw error; } };
    const reserveEffect = (intent: WorkspaceEffectIntent, capacity: import('./workflow-workspace.js').WorkspaceEffectCapacity, pendingOpId?: string) => {
      const c = ctx();
      const kind: RecoveryOperationKind = intent.kind === 'destination-write' ? 'application' : 'stage-write';
      const observations = asRecord(c.unit.coding?.workspace)?.effectObservations;
      workflowAssert(!Array.isArray(observations) || observations.length < 512, 'Workspace observation bound exceeded');
      // Project the NEXT authoritative ledger, not a constant receipt reserve.
      // The workspace supplies a full worst-case manifest without inventing
      // filesystem identities or receipts in the recorded history.
      const projection = structuredClone(state);
      const projectedRun = projection.runs.find(r => r.workflowRunId === c.run.workflowRunId)!;
      const projectedUnit = workflowStepEntries(projectedRun).flatMap(e => e.step.units).find(u => u.id === c.unit.id)!;
      const opIdForProjection = pendingOpId ?? `${c.run.workflowRunId}:${c.unit.id}:${kind}:${c.run.recovery!.sequence}`;
      const context = workflowStepContext(c.run, c.spec.id);
      // This last capacity check is pure: never call the host clock after the
      // workspace's final authority check. Fixed-width checkpoint ISO format.
      const capacityRecordedAt = '9999-12-31T23:59:59.999Z';
      const nextIntent = pendingOpId ? validateRecoveryCheckpoint(c.run.recovery) : appendRecoveryIntent(c.run.recovery!, { kind, id: opIdForProjection, stepId: c.spec.id, unitId: c.unit.id, ...(context.iteration?.id ? { iterationId: context.iteration.id } : {}), inputHash: c.unit.inputHash, dependencyHash: recoveryDependencyHash(c.run, c.spec, c.unit), policyHash: recoveryOperationPolicyHash(c.run, c.spec), generation: intent.generation, paths: [intent.path], preimage: { [intent.path]: intent.preimageHash }, postimage: { [intent.path]: intent.postimageHash }, intent: { recordedAt: capacityRecordedAt } });
      workflowAssert(nextIntent.ok, 'Recovery effect capacity intent exceeded');
      const nextResult = appendRecoveryResult(nextIntent.value, opIdForProjection, { recordedAt: capacityRecordedAt, status: 'uncertain', cleanup: 'uncertain', evidenceHash: 'f'.repeat(64), resultHash: 'f'.repeat(64) });
      workflowAssert(nextResult.ok, 'Recovery effect capacity result exceeded');
      projectedRun.recovery = nextResult.value;
      projectedUnit.coding = { ...(projectedUnit.coding ?? { phase: 'effect-intent' }), workspace: workflowJson({
        ...asRecord(projectedUnit.coding?.workspace), latestIntent: intent, latestObservation: capacity.observation,
        effectObservations: [...(Array.isArray(observations) ? observations : []), capacity.observation], recoveryManifest: capacity.manifest,
      }, WORKFLOW_LIMITS.ledgerBytes) };
      // Also retain bounded failure/settlement diagnostics, never evict evidence.
      workflowJson({ ledger: projection, failureDiagnostic: 'x'.repeat(8192), settlementMetadata: Array(128).fill(null) }, WORKFLOW_LIMITS.ledgerBytes);
    };
    const reserveLease = (intent: WorkspaceLeaseReleaseIntent, opId: string) => {
      const c = ctx();
      const prior = asRecord(c.unit.coding?.workspace);
      const observations = Array.isArray(prior?.leaseObservations) ? prior.leaseObservations : [];
      workflowAssert(observations.length < 128, 'Lease receipt bound exceeded');
      const projection = structuredClone(state);
      const run = projection.runs.find(r => r.workflowRunId === c.run.workflowRunId)!;
      const unit = workflowStepEntries(run).flatMap(e => e.step.units).find(u => u.id === c.unit.id)!;
      const checkpoint = appendRecoveryResult(run.recovery!, opId, { recordedAt: '9999-12-31T23:59:59.999Z', status: 'uncertain', cleanup: 'uncertain', evidenceHash: 'f'.repeat(64), resultHash: 'f'.repeat(64) });
      workflowAssert(checkpoint.ok, 'Lease receipt capacity checkpoint exceeded'); run.recovery = checkpoint.value;
      const number = '9'.repeat(32), identity = { dev:number, ino:number, mode:number, uid:number, gid:number, size:number, mtimeMs:number };
      const observation = { ...intent, status: 'uncertain', error: '\u0000'.repeat(1024), currentObservation: { leaseDirPresent: true, leaseDirIdentity: identity, ownerFilePresent:true, ownerFileIdentity:identity, ownerValue:intent.beforeLeaseEvidence.ownerValue, ownerValueMatches:false, ownerKnownOutcome:'unknown', error:'\u0000'.repeat(1024) } };
      unit.coding = { ...(unit.coding ?? {phase:'lease-release'}), workspace: workflowJson({ ...prior, leaseObservations: [...observations, observation] }, WORKFLOW_LIMITS.ledgerBytes) };
      workflowJson({ ledger: projection, failureDiagnostic:'x'.repeat(8192), settlementMetadata:Array(128).fill(null) }, WORKFLOW_LIMITS.ledgerBytes);
    };
    return {
      rootReady: evidence => {
        const c = ctx();
        const previous = c.unit.coding?.workspace;
        workflowAssert(!previous || !asRecord(previous)?.rootReady, 'Root-ready evidence already published');
        c.unit.coding = { ...(c.unit.coding ?? { phase: 'root-ready' }), workspace: workflowJson({ ...asRecord(previous), ...(asRecord(previous)?.continuationProvenance ? { continuationProvenance: { ...asRecord(asRecord(previous)?.continuationProvenance), newStageGen: evidence.ownerGeneration } } : {}), rootReady: evidence, effectObservations: [] }, WORKFLOW_LIMITS.ledgerBytes) };
        save();
      },
      beforeEffect: (intent: WorkspaceEffectIntent, capacity) => {
        const c = ctx();
        const kind: RecoveryOperationKind = intent.kind === 'destination-write' ? 'application' : 'stage-write';
        workflowJson(intent, 16 * 1024);
        workflowAssert(capacity && c.run.recovery, 'Workspace effect lacks complete capacity projection');

        reserveEffect(intent, capacity);
        const priorWorkspace = c.unit.coding?.workspace;
        c.unit.coding = { ...(c.unit.coding ?? { phase: 'effect-intent' }), workspace: workflowJson({
          ...(priorWorkspace && typeof priorWorkspace === 'object' && !Array.isArray(priorWorkspace) ? priorWorkspace : {}),
          latestIntent: intent,
        }, WORKFLOW_LIMITS.ledgerBytes) };
        let opId: string | undefined;
        try { opId = recoveryEffectIntent(c.run, c.spec, c.unit, kind, [intent.path], { [intent.path]: intent.preimageHash }, { [intent.path]: intent.postimageHash }, intent.generation); }
        catch (error) { authorityLost = true; cleanupUncertain = true; active.forEach(a => a.controller.abort()); refreshActivity(); throw error; }
        remember(`${intent.generation}:${intent.sequence}`, opId);
        // Publication observers may add bounded retained history synchronously.
        // Re-project the canonical ledger with the actual pending intent before
        // returning to the workspace's final authority/ownership check.
        reserveEffect(intent, capacity, opId);
      },
      assertEffectCapacity: (intent, capacity) => {
        const opId = find(`${intent.generation}:${intent.sequence}`);
        workflowAssert(opId, 'Workspace effect lacks pending capacity binding');
        reserveEffect(intent, capacity, opId);
      },
      afterEffect: (observation: WorkspaceEffectObservation) => {
        const c = ctx();
        const opId = find(`${observation.generation}:${observation.sequence}`);
        const status: RecoveryResultStatus = observation.status === 'observed' ? 'completed' : observation.status === 'rejected' ? 'failed' : 'uncertain';
        recoveryAdmissionResult(c.run, opId, status, observation.status === 'observed' ? 'settled' : observation.status === 'rejected' ? 'not-required' : 'uncertain', { workspaceEffect: observation });
        if (c.unit.coding) {
          const priorWorkspace = c.unit.coding.workspace;
          const manifest = latestCodingSession(c.run)?.workspace?.recoveryManifest?.();
          const prior = asRecord(priorWorkspace);
          const observations = Array.isArray(prior?.effectObservations) ? prior.effectObservations : [];
          workflowAssert(observations.length < 512, 'Workspace observation bound exceeded');
          c.unit.coding.workspace = workflowJson({
            ...(priorWorkspace && typeof priorWorkspace === 'object' && !Array.isArray(priorWorkspace) ? priorWorkspace : {}),
            latestObservation: observation, effectObservations: [...observations, observation], ...(manifest ? { recoveryManifest: manifest } : {}),
          }, WORKFLOW_LIMITS.ledgerBytes);
        }
        save();
      },
      canSettlePreEffectRejection: () => { const c = ctx(); return !!c.run.recoveryOf && c.run.status === 'cancelling' && c.spec.coding?.operation === 'stage-write' && !c.unit.native && !latestCodingSession(c.run)?.workspace; },
      assertLeaseReleaseCapacity: intent => { const opId = find(`${intent.generation}:lease:${intent.sequence}`); workflowAssert(opId, 'Lease cleanup lacks pending receipt binding'); reserveLease(intent, opId); },
      assertLeaseReleaseAuthority: () => {
        const c = ctx();
        const pure = () => {
          ledgerCurrent(); workflowAssert(!disposed && !container.read().mode.readOnly && state.runs.includes(c.run), 'Lease cleanup owner/mode changed');
          workflowAssert(workflowHash(state.definitions.find(d => d.id === c.run.definition.id)) === c.run.definitionHash, 'Lease cleanup definition changed');
          for (const [id, agent] of Object.entries(c.run.agents)) workflowAssert(container.read().agentDefinitions[id] && workflowHash(normalizeWorkflowAgent(container.read().agentDefinitions[id])) === workflowHash(agent), 'Lease cleanup agent changed');
        };
        pure(); assertRecoveryOwner(); pure();
      },
      beforeLeaseRelease: (intent: WorkspaceLeaseReleaseIntent) => {
        const c = ctx(); assertWorkspaceReceiptCapacity(c.run, c.spec, intent);
        const previous = asRecord(c.unit.coding?.workspace);
        const intents = Array.isArray(previous?.leaseIntents) ? previous.leaseIntents : [];
        workflowAssert(intents.length < 128, 'Lease intent metadata bound exceeded');
        c.unit.coding = { ...(c.unit.coding ?? { phase: 'lease-transfer' }), workspace: workflowJson({ ...previous, leaseIntents: [...intents, intent] }, WORKFLOW_LIMITS.ledgerBytes) };
        const opId = recoveryEffectIntent(c.run, c.spec, c.unit, 'cleanup', [], null, null, intent.generation);
        remember(`${intent.generation}:lease:${intent.sequence}`, opId); workflowAssert(opId, 'Lease cleanup lacks durable intent'); reserveLease(intent, opId);
      },
      afterLeaseRelease: (observation: WorkspaceLeaseReleaseObservation) => {
        const c = ctx();
        const opId = find(`${observation.generation}:lease:${observation.sequence}`);
        recoveryAdmissionResult(c.run, opId, observation.status === 'observed' ? 'completed' : 'uncertain', observation.status === 'observed' ? 'settled' : 'uncertain', { leaseRelease: observation });
        const previous = asRecord(c.unit.coding?.workspace);
        const observations = Array.isArray(previous?.leaseObservations) ? previous.leaseObservations : [];
        workflowAssert(observations.length < 128, 'Lease observation metadata bound exceeded');
        c.unit.coding = { ...(c.unit.coding ?? { phase: 'lease-transfer' }), workspace: workflowJson({ ...previous, leaseObservations: [...observations, observation] }, WORKFLOW_LIMITS.ledgerBytes) };
        save();
      },
    };
  };
  const codingWorkspaces = new Map<string, { workspace?: RuntimeCodingWorkspace; candidateHash?: string; evidence?: WorkflowCodingGateEvidence; implApprovalId?: string; implRequestHash?: string; baseline?: ReturnType<typeof captureCodingBaseline>; continuationProvenance?: import('./workflow-workspace.js').ContinuationCodingWorkspaceProvenance; effectContext?: CodingEffectContext }>();
  const active = new Map<string, { run: WorkflowRun; unit: WorkflowUnit; controller: AbortController }>();
  const pending = new Set<Promise<void>>();
  const abortListeners = new Map<string, () => void>();
  let disposed = false, scheduled = false, pumping = false, expectedHash = '', authorityLost = false;
  let recoveryAuthorizationPoisoned: string | undefined;
  let recoveryDiagnostic: import('./workflow-model.js').WorkflowRecoveryDiagnostic | undefined;
  let diagnosticRuns: WorkflowRun[] | undefined;
  const poisonRecovery = (error: unknown, intended?: WorkflowState) => {
    recoveryAuthorizationPoisoned = errorText(error);
    authorityLost = true; liveRecoveryPlans.clear(); active.forEach(a => a.controller.abort());
    // Capture only an exact, already-observed canonical selection. A save that might have
    // succeeded is not proof of container publication. Never hydrate/reconnect on reads.
    diagnosticRuns = undefined;
    if (intended) {
      try {
        if (workflowHash(container.read().extensions[WORKFLOW_EXTENSION_KEY]) === workflowHash(intended)) diagnosticRuns = copy(intended.runs);
      } catch { /* The local view remains explicitly uncertain. */ }
    }
    recoveryDiagnostic = { reason: recoveryAuthorizationPoisoned, localView: 'stale-or-uncertain', publication: diagnosticRuns ? 'canonical-selection-observed' : 'uncertain' };
    refreshActivity();
  };
  // Never hydrated. Selection/origin are history, not executable authority.
  const liveRecoveryPlans = new Map<string, { generation: string; fingerprint: string; units: Set<string>; settledSources: Set<string>; settlementChecks: Array<() => boolean>; settlementObservers: Array<() => WorkflowJson>; carry?: { manifest?: unknown; partialOptions?: import('./workflow-workspace.js').InspectPartialArtifactsOptions; allowedPaths: string[]; remainingPaths: string[]; satisfiedPaths: string[]; observationHash: string }; sourceHistoryHash: string }>();
  const observedSettledSources = new Set<string>(); // Inert observations for drain; never an admission grant.
  const sourceHistoryHash = (run: WorkflowRun) => workflowHash({ steps: run.steps, recoveryOriginal: run.recoveryOriginal ?? null, operations: run.recovery?.operations ?? null });
  const assertSelectedUnit = (run: WorkflowRun, unit: WorkflowUnit) => {
    if (!run.recoveryOf) return;
    const plan = liveRecoveryPlans.get(run.workflowRunId);
    workflowAssert(plan?.units.has(unit.id), 'Unselected recovery execution unit blocks admission');
    workflowAssert(!run.recovery?.operations.some(op => op.unitId === unit.id && ['native', 'check', 'review', 'application-gate'].includes(op.kind)), 'Recovery unit already admitted');
  };
  let cleanupUncertain = state.runs.some(r => !r.cleanupSettled);
  let initialized = false;

  const projectedRuns = () => diagnosticRuns ?? state.runs;
  // Observer-local identities distinguish inert restored terminal history from this owner.
  const restoredActivityIds = new Set(state.runs.map(run => run.workflowRunId));
  const activityApplying = new Set<string>();
  const activityChannel = createActivityChannel<WorkflowActivitySnapshot>({ revision: 0,
    available: true, uncertain: false, runs: [], clipped: false });
  let activityRevision = 0;
  const refreshActivity = () => {
    try {
      const runs: WorkflowActivityRun[] = [];
      let clipped = projectedRuns().length > ACTIVITY_LIMITS.workflowRuns;
      const uncertain = authorityLost || owners.get(container) !== owner || !!recoveryDiagnostic || (disposed && active.size > 0);
      for (const run of projectedRuns().slice(0, ACTIVITY_LIMITS.workflowRuns)) {
        const units: WorkflowActivityUnit[] = [];
        const progress: ActivityProgress = { basis: 'top-level-steps',
          total: run.definition.steps.some(spec => spec.kind === 'repeat' || spec.fanout) ? null : run.definition.steps.length,
          completed: 0, reused: 0, failed: 0, skipped: 0, cancelled: 0, unverified: 0, reusedUnits: 0 };
        let addresses = 0;
        const append = (step: WorkflowStepRun, spec: WorkflowStep, blockId?: string, iterationId?: string, iterationNo?: number) => {
          if (++addresses > ACTIVITY_LIMITS.workflowUnits) { clipped = true; return; }
          for (const unit of step.units) {
            if (units.length >= ACTIVITY_LIMITS.workflowUnits) { clipped = true; break; }
            const key = `${run.workflowRunId}/${unit.id}`;
            const admission = active.get(key);
            const applying = activityApplying.has(key);
            const cleanup = applying ? 'pending' as const : unit.cleanupSettled ? 'settled' as const
              : uncertain || unit.status === 'unverified' || run.recovered ? 'unknown' as const : 'pending' as const;
            units.push({ workflowRunId: run.workflowRunId, familyId: run.familyId, attemptNo: run.attemptNo,
              stepId: step.id, unitId: unit.id, inputHash: unit.inputHash,
              ...(blockId !== undefined ? { blockId, iterationId, iterationNo } : {}),
              status: unit.status, kind: spec.kind, cleanup,
              admitted: !!admission && !admission.controller.signal.aborted && !uncertain && unit.status === 'running',
              reused: !!unit.reusedFrom,
              ...(unit.native ? { nativeRunId: unit.native.runId, nativeTaskId: unit.native.taskId } : {}),
              ...(unit.coding ? { phase: applying ? 'applying' : unit.coding.phase,
                approvalStatus: unit.coding.approvalStatus } : {}) });
            if (unit.reusedFrom) progress.reusedUnits++;
          }
        };
        for (const step of run.steps) {
          const spec = run.definition.steps.find(candidate => candidate.id === step.id);
          if (!spec) throw new Error('Unknown activity step');
          if (step.status === 'completed') {
            if (step.units.length > 0 && step.units.every(unit => !!unit.reusedFrom)) progress.reused++;
            else progress.completed++;
          } else if (step.status === 'failed' || step.status === 'skipped' || step.status === 'cancelled' || step.status === 'unverified') progress[step.status]++;
          append(step, spec);
          for (const iteration of step.iterations ?? []) {
            if (addresses >= ACTIVITY_LIMITS.workflowUnits) { clipped = true; break; }
            for (const body of iteration.steps) {
              const bodySpec = spec.body?.find(candidate => `${iteration.id}/${candidate.id}` === body.id);
              if (!bodySpec) throw new Error('Unknown activity body step');
              append(body, bodySpec, step.id, iteration.id, iteration.index + 1);
              if (addresses >= ACTIVITY_LIMITS.workflowUnits) break;
            }
          }
        }
        const cleanup = run.cleanupSettled ? 'settled' as const
          : uncertain || run.status === 'needs-attention' || run.recovered ? 'unknown' as const : 'pending' as const;
        runs.push({ workflowRunId: run.workflowRunId, familyId: run.familyId, attemptNo: run.attemptNo,
          retryOf: run.retryOf, recoveryOf: run.recoveryOf, supersededBy: run.supersededBy,
          definitionId: run.definition.id, label: run.definition.label.slice(0, 128), startedAt: run.createdAt, updatedAt: run.updatedAt,
          status: run.status, recovered: run.recovered, local: !restoredActivityIds.has(run.workflowRunId),
          cleanup, uncertain, progress, units });
      }
      activityChannel.publish({ revision: ++activityRevision, available: true, uncertain, runs, clipped });
    } catch {
      // Never retain a stale claim of computation if observation itself fails.
      try { activityChannel.publish({ revision: ++activityRevision, available: false, uncertain: true, runs: [], clipped: true }); }
      catch { /* Observer failure is not an execution outcome. */ }
    }
  };

  const projectedView = (run: WorkflowRun) => ({ ...workflowView(run), ...(recoveryDiagnostic ? { recoveryDiagnostic } : {}) });
  const list = () => copy(projectedRuns().map(projectedView));
  const ledgerCurrent = () => {
    workflowAssert(!authorityLost && owners.get(container) === owner, 'Workflow ledger ownership lost');
    if (onStartReservation) workflowAssert(workflowHash(container.read().extensions[AUTOMATION_EXTENSION_KEY] ?? null) === expectedAutomationHash, 'Automation ledger changed outside its owner');
    workflowAssert(workflowHash(container.read().extensions[WORKFLOW_EXTENSION_KEY]) === expectedHash, 'Workflow ledger changed outside its owner');
  };
  const persist = (automation?: ReturnType<typeof validateAutomationReservation>) => {
    try {
    if (initialized) ledgerCurrent();
    else workflowAssert(owners.get(container) === owner, 'Workflow ledger ownership lost');
    if (onStartReservation && (automation ?? container.read().extensions[AUTOMATION_EXTENSION_KEY]) !== undefined) validateAutomationLedger(automation ?? container.read().extensions[AUTOMATION_EXTENSION_KEY], state);
    const data = workflowJson(state, WORKFLOW_LIMITS.ledgerBytes);
    expectedHash = workflowHash(data);
    const current = container.read();
    if (automation) expectedAutomationHash = workflowHash(automation);
    container.update({ extensions: { ...current.extensions, [WORKFLOW_EXTENSION_KEY]: data, ...(automation ? { [AUTOMATION_EXTENSION_KEY]: automation } : {}) } });
    if (workflowHash(container.read().extensions[WORKFLOW_EXTENSION_KEY]) !== expectedHash || (onStartReservation && workflowHash(container.read().extensions[AUTOMATION_EXTENSION_KEY] ?? null) !== expectedAutomationHash)) {
      authorityLost = true; active.forEach(a => a.controller.abort());
      throw new Error('Workflow/automation ledger changed during publication');
    }
    initialized = true;
    for (const listener of [...listeners]) { try { listener(list()); } catch { /* Observers cannot alter ownership or settlement. */ } }
    } finally { refreshActivity(); }
  };
  const stamp = (run: WorkflowRun) => { run.updatedAt = now().toISOString(); };
  // Callback-free predicates are the final step after EVERY trusted host callback.
  const pureAuthority = (run?: WorkflowRun) => {
    workflowAssert(!disposed, 'Workflow admission closed: disposal'); ledgerCurrent();
    const selectedPlan = run && liveRecoveryPlans.get(run.workflowRunId);
    if (run?.recoveryOf) {
      workflowAssert(selectedPlan && !run.recovered && selectedPlan.generation === recoveryOwnerEvidence?.generation && selectedPlan.fingerprint === run.recovery?.origin?.assessmentFingerprint, 'Recovery execution requires fresh live owner-bound authorization');
      workflowAssert(!state.runs.some(r => r.familyId === run.familyId && r.attemptNo > run.attemptNo), 'Recovery execution family head changed');
      const source = state.runs.find(r => r.workflowRunId === run.recoveryOf);
      workflowAssert(source && sourceHistoryHash(source) === selectedPlan.sourceHistoryHash, 'Recovery source history changed');
    }
    workflowAssert(!cleanupUncertain || (selectedPlan && ![...active.values()].some(a => a.unit.status === 'unverified' || a.run.status === 'needs-attention') && state.runs.every(r => r.cleanupSettled || r === run || selectedPlan.settledSources.has(r.workflowRunId))), 'Workflow admission closed: uncertain cleanup outside verified selected scope');
    const current = container.read(); workflowAssert(current.lifecycle !== 'disposed' && current.lifecycle !== 'resetting', 'Canonical lifecycle blocks workflow admission'); workflowAssert(!current.mode.readOnly, 'Read-only caller state blocks workflow admission');
    if (run) {
      if (run.definition.authoring) assertWorkflowAuthoringCompatibility(run.definition.authoring);
      workflowAssert(state.runs.includes(run), 'Workflow run ownership changed');
      workflowAssert(workflowHash(state.definitions.find(d => d.id === run.definition.id)) === run.definitionHash, 'Workflow definition changed after host callback');
      for (const [id, agent] of Object.entries(run.agents)) workflowAssert(current.agentDefinitions[id] && workflowHash(normalizeWorkflowAgent(current.agentDefinitions[id])) === workflowHash(agent), 'Frozen agent definition/policy changed after host callback');
    }
  };
  const authority = (run?: WorkflowRun, afterHostCallback?: () => void) => {
    const plan = run && liveRecoveryPlans.get(run.workflowRunId);
    const callbacks = [port.preflight, recoveryPort?.inspectOwner, recoveryPort?.inspectPreviousOwner, options.recovery?.inspectNativeSettlement];
    let ownerObservation: ReturnType<typeof assertRecoveryOwner>;
    // This entire predicate is callback-free. Re-run ALL canonical, grant, owner,
    // source receipt and artifact fences after each host callback and at the boundary.
    const recheck = () => {
      pureAuthority(run); afterHostCallback?.();
      workflowAssert(callbacks.every((fn, i) => fn === [port.preflight, recoveryPort?.inspectOwner, recoveryPort?.inspectPreviousOwner, options.recovery?.inspectNativeSettlement][i]), 'Authority observer changed during host callback');
      pureRecoveryOwner(ownerObservation);
      for (const check of plan?.settlementChecks ?? []) workflowAssert(check(), 'Previous source root/check settlement changed or unknown');
    };
    recheck();
    if (run) { ownerObservation = assertRecoveryOwner(); recheck(); }
    if (run) for (const agent of Object.values(run.agents)) { port.preflight(agent); recheck(); }
    if (hostAdmission) { workflowAssert(hostAdmission() === undefined, 'Admission guard must be synchronous'); recheck(); }
    // Enum-only host observations are not immutable certificates. Require two bounded
    // identical complete sweeps AFTER preflight, rejecting unknown or drift. There are
    // no host calls after the final pure predicate. Hidden host state still requires the
    // documented synchronous owned-lifecycle contract; this is not PID-based proof.
    let previous: string | undefined;
    for (let pass = 0; pass < 2; pass++) {
      const observations: WorkflowJson[] = [];
      if (run) { ownerObservation = assertRecoveryOwner(); recheck(); observations.push(workflowJson(Object.fromEntries(Object.entries(ownerObservation ?? {}).filter(([, value]) => value !== undefined)))); }
      for (const observe of plan?.settlementObservers ?? []) { observations.push(observe()); recheck(); }
      const exact = workflowHash(observations);
      workflowAssert(previous === undefined || exact === previous, 'Authority observations drifted during host callbacks');
      previous = exact;
    }
    recheck();
  };
  const freshId = () => {
    const id = idFactory(); workflowAssert(typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(id) && !state.runs.some(r => r.workflowRunId === id), 'Workflow ID collision/invalid ID'); return id;
  };
  const freezeAgents = (def: WorkflowDefinition): Record<string, ClankersAgentDefinition> => {
    const agents: Record<string, ClankersAgentDefinition> = {};
    const agentIds = new Set<string>();
    for (const step of def.steps.flatMap(s => s.body ?? [s])) {
      if (step.kind === 'native') agentIds.add(step.agentId!);
      if (step.kind === 'coding') { const p = validateCodingPolicy(step.coding!.policy as import('./workflow-coding.js').WorkflowCodingPolicy); agentIds.add(p.identity.workerAgentId); if (p.reviewRequired || p.capabilities.includes('review')) agentIds.add(p.identity.rootAgentId); }
    }
    for (const agentId of agentIds) if (!agents[agentId]) {
      const source = container.read().agentDefinitions[agentId];
      workflowAssert(source, 'Workflow agent definition not found'); const agent = normalizeWorkflowAgent(source);
      workflowAssert(agent && typeof agent.model === 'string' && agent.model.trim().length > 0, 'Workflow agents require an explicit model');
      workflowAssert(agent.maxTurns === undefined && (!agent.fallbackModels || agent.fallbackModels.length === 0) &&
        (agent.permissionMode === undefined || agent.permissionMode === 'inherit'), 'Unsupported native overrides');
      agents[agent.id] = freezeWorkflowData(agent, WORKFLOW_LIMITS.definitionBytes); port.preflight(agents[agent.id]);
    }
    return agents;
  };
  const cancelRun = (run: WorkflowRun) => {
    liveRecoveryPlans.delete(run.workflowRunId);
    // Selection is durable history, but this inert child has no admitted effects to settle.
    // Cancel that exact canonical child without entering the execution scheduler or inventing output.
    if (run.status === 'needs-attention' && run.cleanupSettled && !run.recovered && run.recovery?.origin && run.recovery.operations.length === 0 && run.steps.every(step => step.status === 'queued' && step.units.length === 0)) {
      ledgerCurrent();
      const source = state.runs.find(other => other.workflowRunId === run.recoveryOf);
      workflowAssert(source?.recovery?.selection && source.supersededBy === run.workflowRunId && workflowHash(source.recovery.selection) === workflowHash(run.recovery.origin), 'Cancellation requires exact selected child');
      run.status = 'cancelled'; stamp(run);
      for (const step of run.steps) { step.status = 'cancelled'; if (run.definition.version !== 1) step.skipReason = 'cancelled'; }
      run.error = 'Caller cancelled selected recovery child before execution; durable selection retained';
      persist();
      return;
    }
    if (terminal(run) && run.cleanupSettled) return;
    run.status = 'cancelling'; stamp(run);
    for (const { spec, step } of workflowStepEntries(run)) {
      for (const unit of step.units) if (unit.status === 'queued' || (unit.status === 'running' && unit.cleanupSettled && unit.coding?.approvalStatus === 'pending' && !active.has(`${run.workflowRunId}/${unit.id}`))) { unit.status = 'cancelled'; unit.cleanupSettled = true; }
      if (step.status === 'queued' || (spec.kind === 'repeat' && step.status === 'running')) { step.status = 'cancelled'; if (run.definition.version === 2 || run.definition.version === 3) { step.skipReason = 'cancelled'; if (spec.kind === 'repeat') step.termination = 'cancelled'; } else step.output = { status: 'cancelled', error: 'Workflow cancellation before admission' }; }
      else if (step.units.length) outputStep(spec, step);
    }
    active.forEach(a => { if (a.run === run) a.controller.abort(); });
    finishRun(run); persist(); schedule();
  };
  const attachSignal = (run: WorkflowRun, signal?: AbortSignal) => {
    if (!signal) return;
    const cancel = () => { if (authorityLost || owners.get(container) !== owner) return; cancelRun(run); };
    signal.addEventListener('abort', cancel, { once: true });
    abortListeners.set(run.workflowRunId, () => signal.removeEventListener('abort', cancel));
    if (signal.aborted) cancel();
  };
  const outputsFor = (run: WorkflowRun, spec?: WorkflowStep): Record<string, WorkflowJson> => {
    const context = workflowStepContext(run, spec?.id ?? '');
    const outputs: Record<string, WorkflowJson> = {};
    for (const step of context.steps) {
      const id = context.iteration ? step.id.slice(context.iteration.id.length + 1) : step.id;
      if (step.output !== undefined) outputs[id] = step.output;
      else if (spec?.consumeSkips && step.skipReason === 'condition-false') outputs[id] = workflowUnavailableEnvelope(step);
      else if (spec?.consumeFailures && ['failed', 'unverified'].includes(step.status)) outputs[id] = workflowUnavailableEnvelope(step);
    }
    return outputs;
  };
  const bindingValue = (run: WorkflowRun, spec: WorkflowStep, binding: WorkflowBinding, item?: WorkflowJson): WorkflowJson =>
    'value' in binding ? binding.value : resolveWorkflowRef(binding.ref, run.inputs, outputsFor(run, spec), item, workflowStepContext(run, spec.id).iteration?.state);
  const materialize = (run: WorkflowRun, spec: WorkflowStep, item?: WorkflowJson): Record<string, WorkflowJson> => {
    const inputs: Record<string, WorkflowJson> = {};
    for (const [key, binding] of Object.entries(spec.inputs!)) inputs[key] = bindingValue(run, spec, binding, item);
    return freezeWorkflowData(inputs, WORKFLOW_LIMITS.promptBytes);
  };
  const hashUnit = workflowUnitHash;
  const setOutput = (step: WorkflowStepRun, output: WorkflowJson) => {
    const old = step.output; step.output = workflowJson(output);
    try { workflowJson(state, WORKFLOW_LIMITS.ledgerBytes); }
    catch (error) { if (old === undefined) delete step.output; else step.output = old; throw error; }
  };
  const outputStep = (spec: WorkflowStep, step: WorkflowStepRun) => {
    if (step.units.some(u => !settled(u.status))) { step.status = 'running'; return; }
    step.status = step.units.every(u => u.status === 'completed') ? 'completed' : step.units.some(u => u.status === 'unverified') ? 'unverified' : step.units.some(u => u.status === 'cancelled') ? 'cancelled' : 'failed';
    if (spec.fanout) setOutput(step, step.units.map(workflowUnitEnvelope));
    else if (step.units.length === 1) setOutput(step, step.units[0].status === 'completed' ? step.units[0].result! : workflowUnitEnvelope(step.units[0]));
    else setOutput(step, { status: step.status, error: step.error ?? 'Step did not produce a result' });
  };
  function finishRun(run: WorkflowRun) {
    if (terminal(run)) { liveRecoveryPlans.delete(run.workflowRunId); return; }
    if (workflowStepEntries(run).some(({ step: s }) => s.units.some(u => !u.cleanupSettled && settled(u.status)))) {
      run.status = 'needs-attention'; liveRecoveryPlans.delete(run.workflowRunId); run.cleanupSettled = false; stamp(run); return;
    }
    if (workflowStepEntries(run).some(({ step: s }) => !settled(s.status))) {
      run.cleanupSettled = workflowStepEntries(run).every(({ step: s }) => s.units.every(u => u.cleanupSettled)); return;
    }
    run.cleanupSettled = workflowStepEntries(run).every(({ step: s }) => s.units.every(u => u.cleanupSettled));
    if (!run.cleanupSettled) run.status = 'needs-attention';
    else if (run.status === 'cancelling') run.status = 'cancelled';
    else {
      const final = run.steps[run.steps.length - 1];
      if (final.output !== undefined) {
        run.report = final.output;
        try { workflowJson(state, WORKFLOW_LIMITS.ledgerBytes); }
        catch (error) { delete run.report; run.error = errorText(error); run.status = 'failed'; liveRecoveryPlans.delete(run.workflowRunId); stamp(run); return; }
      }
      const partial = run.report && typeof run.report === 'object' && !Array.isArray(run.report) && (run.report.partial === true || run.report.passed === false);
      run.status = workflowStepEntries(run).every(({ step: s }) => s.status === 'completed' || ((run.definition.version === 2 || run.definition.version === 3) && s.skipReason === 'condition-false')) && !partial ? 'completed' : 'failed';
    }
    stamp(run); if (terminal(run)) liveRecoveryPlans.delete(run.workflowRunId); abortListeners.get(run.workflowRunId)?.(); abortListeners.delete(run.workflowRunId);
  }
  const budgetResult = (unit: WorkflowUnit, result: WorkflowJson) => {
    unit.result = result;
    try { workflowJson(state, WORKFLOW_LIMITS.ledgerBytes); } catch (error) { delete unit.result; throw error; }
  };
  const reuse = (run: WorkflowRun, unit: WorkflowUnit, spec: WorkflowStep) => {
    if (recoveryEnabled || !run.retryOf || spec.kind !== 'native') return; // Unknown recovery dependency contracts never certify old native completion.
    const previous = state.runs.find(r => r.workflowRunId === run.retryOf);
    const old = previous && workflowStepEntries(previous).find(e => e.step.id === spec.id)?.step.units.find(u => u.index === unit.index && u.inputHash === unit.inputHash && u.status === 'completed' && u.cleanupSettled && u.native && u.result !== undefined);
    if (!old) return;
    validateWorkflowValue(old.result!, spec.outputSchema!); budgetResult(unit, freezeWorkflowData(old.result!, WORKFLOW_LIMITS.resultBytes));
    unit.status = 'completed'; unit.native = copy(old.native!); unit.cleanupSettled = true;
    unit.reusedFrom = { workflowRunId: run.retryOf, unitId: old.id, native: copy(old.native!) };
  };
  const prepare = (run: WorkflowRun, spec: WorkflowStep, step: WorkflowStepRun) => {
    try {
      const scope = workflowStepContext(run, spec.id);
      const failedDependencies = spec.dependsOn.some(id => {
        const dependency = scope.steps.find(s => s.id === id)!;
        if (dependency.status === 'completed') return false;
        if (run.definition.version === 1) return !(spec.kind === 'aggregate' && spec.consumeFailures);
        if (spec.kind !== 'aggregate') return true;
        return dependency.skipReason === 'condition-false' ? !spec.consumeSkips : !(spec.consumeFailures && ['failed', 'unverified'].includes(dependency.status));
      });
      if (failedDependencies) {
        step.status = 'skipped'; step.error = 'Dependency did not complete successfully';
        if (run.definition.version === 2 || run.definition.version === 3) step.skipReason = 'dependency'; else step.output = workflowJson({ status: 'skipped', error: step.error }); return;
      }
      if (spec.when) {
        step.condition = evaluateWorkflowCondition(spec.when, b => bindingValue(run, spec, b));
        if (!step.condition) { step.status = 'skipped'; step.skipReason = 'condition-false'; return; }
      }
      if (spec.kind === 'repeat') {
        const initial = freezeWorkflowData(bindingValue(run, spec, spec.initial!)); validateWorkflowValue(initial, spec.stateSchema!);
        step.iterations = []; step.status = 'running'; appendIteration(spec, step, initial); return;
      }
      if (spec.kind === 'aggregate') {
        const inputs = materialize(run, spec), unit: WorkflowUnit = { id: `${spec.id}:0`, stepId: spec.id, index: 0, status: 'running', inputHash: hashUnit(run, spec, inputs), inputs, cleanupSettled: true };
        step.units = [unit];
        budgetResult(unit, freezeWorkflowData(aggregateWorkflow(spec.operation!, inputs))); unit.status = 'completed'; outputStep(spec, step); return;
      }
      if (spec.kind === 'coding') {
        const inputs = materialize(run, spec), unit: WorkflowUnit = { id: `${spec.id}:0`, stepId: spec.id, index: 0, status: 'queued', inputHash: hashUnit(run, spec, inputs), inputs, cleanupSettled: true, coding: { phase: spec.coding!.operation } };
        step.units = [unit]; outputStep(spec, step); return;
      }
      let items: WorkflowJson[] = [null];
      if (spec.fanout) {
        const source = resolveWorkflowRef(spec.fanout.from, run.inputs, outputsFor(run, spec), undefined, workflowStepContext(run, spec.id).iteration?.state);
        workflowAssert(Array.isArray(source) && source.length <= spec.fanout.maxItems, 'Runtime fanout exceeds declared bound'); items = source;
      }
      step.units = items.map((item, index) => {
        const inputs = materialize(run, spec, spec.fanout ? item : undefined);
        const unit: WorkflowUnit = { id: `${spec.id}:${index}`, stepId: spec.id, index, status: 'queued', inputHash: hashUnit(run, spec, inputs), inputs, cleanupSettled: true };
        reuse(run, unit, spec); return unit;
      });
      if (run.definition.version === 2 || run.definition.version === 3) {
        try { workflowJson(state, WORKFLOW_LIMITS.ledgerBytes); } catch (error) { step.units = []; throw error; }
      }
      if (!step.units.length) { step.status = 'completed'; step.output = []; } else outputStep(spec, step);
    } catch (error) {
      step.status = 'failed'; step.error = errorText(error); if (spec.kind === 'repeat') step.termination = 'invalid-transition'; if (spec.kind !== 'repeat') step.output = workflowJson({ status: 'failed', error: step.error });
      step.units.forEach(u => { if (!settled(u.status)) { u.status = 'failed'; u.cleanupSettled = true; u.error = step.error; } });
      if (run.definition.version === 2 || run.definition.version === 3) {
        try { workflowJson(state, WORKFLOW_LIMITS.ledgerBytes); } catch { step.units = []; delete step.output; }
      }
    }
  };
  const lineage = (run: WorkflowRun, id: string) => {
    const context = workflowStepContext(run, id);
    return context.iteration ? { blockId: context.block!.id, iterationId: context.iteration.id, iterationNo: context.iteration.index + 1 } : {};
  };
  const appendIteration = (spec: WorkflowStep, step: WorkflowStepRun, value: WorkflowJson) => {
    const index = step.iterations!.length, id = `${step.id}@${index}`;
    const iteration: WorkflowIterationRun = { id, index, state: freezeWorkflowData(value), steps: spec.body!.map(s => ({ id: `${id}/${s.id}`, status: 'queued', units: [] })) };
    step.iterations!.push(iteration);
    try { workflowJson(state, WORKFLOW_LIMITS.ledgerBytes); } catch (error) { step.iterations!.pop(); throw error; }
  };
  const advanceRepeat = (run: WorkflowRun, spec: WorkflowStep, step: WorkflowStepRun): boolean => {
    const iteration = step.iterations!.at(-1)!;
    if (!iteration.steps.every(s => settled(s.status))) return false;
    try {
      workflowAssert(iteration.steps.every(s => s.units.every(u => u.cleanupSettled)), 'Repeat body cleanup is uncertain');
      workflowAssert(iteration.steps.every(s => s.status === 'completed' || s.skipReason === 'condition-false'), 'Repeat body did not complete successfully');
      const outputs = Object.fromEntries(iteration.steps.filter(s => s.status === 'completed' && s.output !== undefined).map(s => [s.id.slice(iteration.id.length + 1), s.output!]));
      const resolve = (b: WorkflowBinding, value: WorkflowJson) => 'value' in b ? b.value : resolveWorkflowRef(b.ref, run.inputs, outputs, undefined, value);
      if (iteration.decision === undefined) {
        const feedback = freezeWorkflowData(resolve(spec.feedback!, iteration.state)); validateWorkflowValue(feedback, spec.stateSchema!);
        iteration.feedback = feedback;
        iteration.decision = evaluateWorkflowCondition(spec.until!, b => resolve(b, feedback));
        try { workflowJson(state, WORKFLOW_LIMITS.ledgerBytes); } catch (error) { delete iteration.feedback; delete iteration.decision; throw error; }
        // Publish the transition before admitting another iteration; observers may pause/cancel.
        stamp(run); persist();
      }
      if (run.status !== 'running') return true;
      try { authority(run); } catch (error) { run.status = 'paused'; run.error = errorText(error); return true; }
      if (iteration.decision) {
        const output = resolve(spec.output!, iteration.feedback!); validateWorkflowValue(output, spec.outputSchema!);
        setOutput(step, output); step.status = 'completed'; step.termination = 'converged';
      } else {
        if (step.iterations!.length >= spec.maxIterations!) { step.termination = 'max-iterations'; throw new Error('Repeat did not converge within maxIterations'); }
        appendIteration(spec, step, iteration.feedback!);
      }
    } catch (error) { iteration.error = errorText(error); step.error = iteration.error; step.termination ??= iteration.steps.some(s => !['completed', 'skipped'].includes(s.status)) ? 'body-failed' : 'invalid-transition'; step.status = 'failed'; delete step.output; }
    return true;
  };
  const runActiveCount = (run: WorkflowRun) => [...active.values()].filter(a => a.run === run).length;
  const globalCap = () => Math.min(32, ...state.runs.filter(r => !terminal(r) || !r.cleanupSettled).map(r => r.concurrency));
  const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
  const codingKey = (run: WorkflowRun) => run.workflowRunId;
  const latestCodingSession = (run: WorkflowRun) => codingWorkspaces.get(codingKey(run));
  const codingOutput = (unit: WorkflowUnit, result: WorkflowJson) => { budgetResult(unit, freezeWorkflowData(result, WORKFLOW_LIMITS.resultBytes)); unit.status = 'completed'; unit.cleanupSettled = true; };
  const boundedJson = (value: unknown): WorkflowJson => workflowJson(JSON.parse(JSON.stringify(value)), WORKFLOW_LIMITS.resultBytes);
  const candidateJson = (workspace: RuntimeCodingWorkspace) => { const c = workspace.inspect(); return freezeWorkflowData({ candidateHash: c.hash, changedPaths: c.changedPaths, files: c.files.map(f => ({ path: f.path, beforeText: f.before?.toString('utf8') ?? null, afterText: f.after?.toString('utf8') ?? null, beforeHash: f.beforeHash, afterHash: f.afterHash })) }, WORKFLOW_LIMITS.resultBytes); };
  const requiredChecksPassed = (policy: ReturnType<typeof validateCodingPolicy>, evidence: WorkflowCodingGateEvidence | undefined, candidateHash: string) => {
    const expected = sha256(candidateHash);
    return (policy.checkProfiles ?? []).every(profile => evidence?.checks.some(check => {
      const detail = check as unknown as Record<string, unknown>;
      const cleanup = detail.cleanup as { outcome?: unknown } | undefined;
      return check.profileId === profile.id && check.status === 'passed' && detail.expectedCandidateHash === expected && detail.candidateHashBefore === expected && detail.candidateHashAfter === expected && detail.timedOut !== true && detail.cancelled !== true && cleanup?.outcome !== 'uncertain';
    }) ?? false);
  };
  const assertRuntimeApplyEvidence = (run: WorkflowRun, policy: ReturnType<typeof validateCodingPolicy>, evidence: WorkflowCodingGateEvidence, candidateHash: string) => {
    workflowAssert(policy.reviewRequired === true && policy.capabilities.includes('review'), 'Apply requires mandatory native independent review');
    workflowAssert(requiredChecksPassed(policy, evidence, candidateHash), 'Required checks are not fresh/passed for current candidate');
    const entries = workflowStepEntries(run);
    const writer = entries.flatMap(({ spec, step }) => spec.kind === 'coding' && spec.coding?.operation === 'stage-write' ? step.units : [])
      .find(u => u.status === 'completed' && u.cleanupSettled && u.native && u.coding?.candidateHash === candidateHash);
    workflowAssert(!!writer?.native, 'Apply requires settled native writer evidence for current candidate');
    for (const profile of policy.checkProfiles ?? []) {
      const checkUnit = entries.flatMap(({ spec, step }) => spec.kind === 'coding' && spec.coding?.operation === 'check' && spec.coding.checkProfileId === profile.id ? step.units : [])
        .find(u => u.status === 'completed' && u.cleanupSettled && u.coding?.candidateHash === candidateHash && typeof u.result === 'object' && u.result !== null && !Array.isArray(u.result) && (u.result as Record<string, WorkflowJson>).passed === true && (u.result as Record<string, WorkflowJson>).profileId === profile.id);
      workflowAssert(!!checkUnit, 'Apply requires settled native check evidence for every approved profile');
    }
    const review = evidence.review;
    workflowAssert(review?.status === 'passed', 'Apply requires passed review evidence');
    const reviewUnit = entries.flatMap(({ spec, step }) => spec.kind === 'coding' && spec.coding?.operation === 'review' ? step.units : [])
      .find(u => u.status === 'completed' && u.cleanupSettled && u.native && u.coding?.candidateHash === candidateHash && review.reviewerIdentity === `${u.native.runId}:${u.native.taskId}`);
    workflowAssert(!!reviewUnit?.native, 'Apply requires genuine current native review evidence');
    workflowAssert(reviewUnit.native.runId !== writer.native.runId && reviewUnit.native.taskId !== writer.native.taskId, 'Reviewer native identity must be distinct from writer');
    workflowAssert(reviewUnit.native.runId !== policy.identity.workerAgentId && reviewUnit.native.taskId !== policy.identity.workerAgentId, 'Reviewer native identity must not be the worker agent id');
  };
  const baselineSnapshotJson = (baseline: ReturnType<typeof captureCodingBaseline>) => freezeWorkflowData({ baselineHash: baseline.hash, inputPaths: baseline.inputPaths, writablePaths: baseline.writablePaths, files: baseline.entries.map(e => ({ path: e.path, exists: e.exists, text: e.text ?? null, sha256: e.sha256 ?? null, bytes: e.bytes ?? 0 })) }, WORKFLOW_LIMITS.resultBytes);
  const assertFreshBaseline = (baseline: ReturnType<typeof captureCodingBaseline>, projectRoot: string, inputPaths: string[], writablePaths: string[], limits: unknown) => {
    const fresh = captureCodingBaseline({ projectRoot, inputPaths, writablePaths, limits: limits as Parameters<typeof captureCodingBaseline>[0]['limits'] });
    const comparable = (b: ReturnType<typeof captureCodingBaseline>) => ({ inputPaths: b.inputPaths, writablePaths: b.writablePaths, entries: b.entries.map(e => ({ path: e.path, exists: e.exists, bytes: e.bytes ?? 0, sha256: e.sha256 ?? null, text: e.text ?? null })) });
    workflowAssert(workflowHash(comparable(fresh)) === workflowHash(comparable(baseline)), 'Reviewed coding baseline changed before grant');
    return fresh;
  };
  const implementationPredicate = (id: string, requestHash: string) => {
    approvalRegistry.requireLiveFingerprint('implementation', id, requestHash);
    const inspected = approvalRegistry.inspect(id)[0];
    workflowAssert(inspected && inspected.status === 'granted' && !inspected.consumed && inspected.requestHash === requestHash, 'Implementation grant changed');
    const epoch = approvalEpoch;
    const expiry = inspected.request.expiresAt ? Date.parse(inspected.request.expiresAt) : Infinity;
    return () => {
      // No callback/host clock after final authority. Project elapsed kernel time
      // from the most recent actual host clock observation; never forge a receipt.
      const time = observedClock.millis + Number(process.hrtime.bigint() - observedClock.ticks) / 1e6;
      workflowAssert(approvalEpoch === epoch && expiry > time, 'Implementation grant revoked/changed/expired after host callback');
    };
  };
  const assertCodingGrantAuthority = (run: WorkflowRun, controller: AbortController, unit: WorkflowUnit, id: string, hash: string) => {
    const grant = implementationPredicate(id, hash);
    authority(run, () => { pureRunnable(run, controller, unit); grant(); });
    pureRunnable(run, controller, unit); grant();
  };
  const strictCodingOutcome = (raw: WorkflowNativeOutcome): WorkflowNativeOutcome => {
    try {
      workflowAssert(raw && typeof raw === 'object' && !Array.isArray(raw) && Object.getPrototypeOf(raw) === Object.prototype && Object.getOwnPropertySymbols(raw).length === 0, 'Invalid coding native outcome');
      const fields = Object.getOwnPropertyDescriptors(raw);
      workflowAssert(Object.entries(fields).every(([k, d]) => ['status', 'text', 'error', 'identity', 'cleanupSettled'].includes(k) && d.enumerable && 'value' in d), 'Invalid coding outcome fields/accessors');
      workflowAssert(typeof fields.cleanupSettled?.value === 'boolean' && typeof fields.status?.value === 'string' && ['completed', 'failed', 'cancelled', 'unverified'].includes(fields.status.value), 'Invalid coding outcome status/settlement');
      workflowAssert(fields.text === undefined || typeof fields.text.value === 'string', 'Invalid coding outcome text');
      workflowAssert(fields.error === undefined || typeof fields.error.value === 'string', 'Invalid coding outcome diagnostic');
      workflowAssert(fields.identity === undefined || identityValid(fields.identity.value), 'Invalid coding outcome identity');
      return raw;
    } catch { return { status: 'unverified', cleanupSettled: false, error: 'Malformed coding native outcome; cleanup settlement unknown' }; }
  };
  const pureRunnable = (run: WorkflowRun, controller: AbortController, unit: WorkflowUnit) => {
    workflowAssert(!controller.signal.aborted && (run.status === 'running' || run.status === 'paused') && !terminal(run), 'Workflow unit cancelled/closed'); workflowAssert(!settled(unit.status), 'Workflow unit is terminal');
    workflowAssert(unit.inputHash === (() => { const e = workflowStepEntries(run).find(e => e.step.units.includes(unit))!; return hashUnit(run, qualifyWorkflowStep(e.spec, e.iterationId), unit.inputs); })(), 'Coding materialized input changed after host callback');
  };
  const assertRunnable = (run: WorkflowRun, controller: AbortController, unit: WorkflowUnit) => { authority(run, () => pureRunnable(run, controller, unit)); pureRunnable(run, controller, unit); };
  const launchCoding = (run: WorkflowRun, spec: WorkflowStep, step: WorkflowStepRun, unit: WorkflowUnit): boolean => {
    const rawPolicy = spec.coding!.policy as import('./workflow-coding.js').WorkflowCodingPolicy;
    const selectedPlan = liveRecoveryPlans.get(run.workflowRunId);
    const carry = selectedPlan?.carry;
    const effectiveScope = carry ? { ...rawPolicy.scope, writablePaths: carry.remainingPaths, readonlyPaths: [...new Set([...(rawPolicy.scope.readonlyPaths ?? []), ...carry.satisfiedPaths])], manifest: rawPolicy.scope.manifest.filter(e => carry.remainingPaths.includes(e.path)) } : rawPolicy.scope;
    const op = spec.coding!.operation, policy = validateCodingPolicy({ ...rawPolicy, scope: effectiveScope, identity: { ...rawPolicy.identity, workflowRunId: run.workflowRunId, attemptNo: run.attemptNo } });
    const cfg = codingCfg;
    const inputPaths = [...(policy.scope.readonlyPaths ?? []), ...policy.scope.writablePaths];
    const writablePaths = carry?.remainingPaths ?? cfg?.writablePaths ?? policy.scope.writablePaths;
    const sealedToolPolicyHash = workflowHash({ capabilities: policy.capabilities, writablePaths, readonlyPaths: policy.scope.readonlyPaths ?? [], protectedPaths: policy.scope.protectedPaths ?? [] });
    const checkProfilesForReview = () => (policy.checkProfiles ?? []).map(p => ({ id: p.id, executable: p.executable, argv: p.argv, cwd: p.cwd, env: p.env ?? {}, timeoutMs: p.timeoutMs, outputBytes: resolveCodingBounds(policy).maxOutputBytes, profileHash: p.profileHash, allowGeneratedOutputs: false as const }));
    const approvalPayload = (kind: 'implementation' | 'application', baseline: ReturnType<typeof captureCodingBaseline>, application?: unknown) => freezeWorkflowData({ summary: `${kind} approval for ${op} ${run.workflowRunId}`, workflow: { workflowRunId: run.workflowRunId, parentRunId: policy.identity.parentRunId, taskId: policy.identity.taskId, attemptNo: run.attemptNo, operation: op, task: policy.scope.task }, trust: { projectRoot: cfg!.projectRoot, stagingParent: cfg!.stagingParent, writablePaths, inputPaths, networkSandbox: 'none' as const, warning: 'No network sandbox is provided by the workflow runtime; approval relies on deterministic local checks and sealed coding tools.' }, agent: { rootAgentId: policy.identity.rootAgentId, workerAgentId: policy.identity.workerAgentId, model: policy.identity.model, sealedToolPolicyHash, effectivePolicyHash: codingPolicyHash(policy) }, limits: { bounds: resolveCodingBounds(policy), corrections: { maxIterations: resolveCodingBounds(policy).maxIterations, admissionLimit: WORKFLOW_LIMITS.admissions } }, baseline, checkProfiles: checkProfilesForReview(), ...(application !== undefined ? { application } : {}), disclosures: ['Payload is bounded and JSON-escaped for display.', 'Full retained file contents are addressed by sha256 hashes and stage/workspace locators.', 'Approval is valid only for this exact request fingerprint.'] }, WORKFLOW_LIMITS.promptBytes) as import('./workflow-coding.js').WorkflowCodingHumanReviewPayload;
    const implementationRequest = (baseline: ReturnType<typeof captureCodingBaseline>) => createCodingApprovalRequest('implementation', policy, { humanReview: approvalPayload('implementation', baseline) });
    try { authority(run); if (unit.status === 'queued') assertSelectedUnit(run, unit); workflowAssert(cfg?.enabled !== false && cfg?.projectRoot && cfg?.stagingParent, 'Trusted coding host config missing'); workflowAssert(unit.inputHash === hashUnit(run, spec, unit.inputs), 'Materialized dependency/input identity changed'); }
    catch (error) { unit.status = 'failed'; unit.error = errorText(error); outputStep(spec, step); stamp(run); finishRun(run); persist(); return true; }
    if (unit.status === 'running' && unit.coding?.approvalStatus === 'pending') {
      const inspections = approvalRegistry.inspect(unit.coding.approvalId);
      if (!inspections[0] || inspections[0].status === 'pending') return false;
      unit.coding.approvalStatus = inspections[0].status;
      if (inspections[0].status !== 'granted') {
        if (op === 'apply') latestCodingSession(run)?.workspace?.settle?.();
        unit.status = 'failed'; unit.error = `Coding approval ${inspections[0].status}`; unit.cleanupSettled = true; outputStep(spec, step); stamp(run); finishRun(run); persist(); return true;
      }
    }
    if (unit.status === 'queued') {
      unit.status = 'running'; unit.cleanupSettled = true; unit.coding = { ...(unit.coding ?? {}), phase: op }; outputStep(spec, step); stamp(run); persist();
      if (op === 'stage-write' || op === 'apply') {
        const session = latestCodingSession(run);
        const reviewedBaseline = op === 'stage-write' ? session?.baseline ?? captureCodingBaseline({ projectRoot: cfg!.projectRoot, inputPaths, writablePaths, limits: policy.bounds }) : session?.baseline;
        const appCandidate = op === 'apply' && session?.candidateHash && session?.evidence && session?.workspace ? session.workspace.inspect() : undefined;
        if (op === 'apply') {
          try {
            workflowAssert(session?.workspace && session.candidateHash && session.evidence, 'No staged candidate/evidence for apply');
            assertRuntimeApplyEvidence(run, policy, session.evidence, session.candidateHash);
            workflowAssert(codingGatesPassed(policy, session.evidence, { candidateHash: session.candidateHash, policyHash: codingPolicyHash(policy), baselineHash: codingBaselineHash(policy), changedPaths: session.workspace.inspect().changedPaths, files: [], bytes: 0, id: session.candidateHash.slice(0, 32), iteration: run.attemptNo }), 'Required checks/review have not passed');
          } catch (error) { unit.status = 'failed'; unit.error = errorText(error); unit.cleanupSettled = true; outputStep(spec, step); stamp(run); finishRun(run); persist(); return true; }
        }
        const appData = appCandidate && session?.candidateHash && session?.evidence && session?.workspace ? { candidate: candidateJson(session.workspace), stats: { totalBytes: appCandidate.totalBytes ?? 0, clippedBytes: appCandidate.clippedBytes ?? 0 }, retained: { stageRoot: session.workspace.stageRoot, candidateHash: session.candidateHash }, evidence: session.evidence, targetBaselineHash: reviewedBaseline?.hash, beforeAfter: appCandidate.files.map(f => ({ path: f.path, beforeHash: f.beforeHash, afterHash: f.afterHash, beforeBytes: f.before?.length ?? 0, afterBytes: f.after?.length ?? 0, preview: f.preview ?? f.after?.toString('utf8') ?? '', clippedBytes: f.clippedBytes ?? 0 })) } : undefined;
        const req = op === 'stage-write'
          ? implementationRequest(reviewedBaseline!)
          : createCodingApprovalRequest('application', policy, appData && reviewedBaseline && session ? { candidateHash: session.candidateHash!, evidenceHash: workflowHash(session.evidence!), targetHash: workflowHash({ baseline: reviewedBaseline.hash, candidate: session.candidateHash, changedPaths: appCandidate!.changedPaths }), humanReview: approvalPayload('application', reviewedBaseline, appData) } : {});
        const record = approvalRegistry.request(req); unit.coding = { phase: op === 'stage-write' ? 'awaiting-implementation-approval' : 'awaiting-application-approval', approvalId: record.id, approvalStatus: record.status, ...(latestCodingSession(run)?.candidateHash ? { candidateHash: latestCodingSession(run)!.candidateHash } : {}), ...(latestCodingSession(run)?.evidence ? { evidenceHash: workflowHash(latestCodingSession(run)!.evidence!) } : {}), ...(reviewedBaseline ? { baseline: boundedJson(reviewedBaseline) } : {}) }; stamp(run); persist();
        if (record.status !== 'granted') return true;
      }
    }
    if (active.size >= globalCap() || runActiveCount(run) >= run.concurrency) return false;
    workflowAssert(run.admissions < WORKFLOW_LIMITS.admissions, 'Workflow family admission budget exhausted');
    const controller = new AbortController(); const activeKey = `${run.workflowRunId}/${unit.id}`;
    const poisonJournal = (error: unknown) => { authorityLost = true; unit.status = 'unverified'; unit.cleanupSettled = false; run.cleanupSettled = false; cleanupUncertain = true; controller.abort(); unit.error = errorText(error); refreshActivity(); };
    const journalPersist = () => { try { validateRunRecovery(run); stamp(run); persist(); } catch (error) { poisonJournal(error); throw error; } };
    const recoveryCodingOpId = recoveryEnabled ? recoveryAdmissionIntent(run, spec, unit, op === 'check' ? 'check' : op === 'review' ? 'review' : op === 'apply' ? 'application-gate' : 'native') : undefined;
    active.set(activeKey, { run, unit, controller }); run.admissions++; validateRunRecovery(run); run.cleanupSettled = false; unit.cleanupSettled = false;
    stamp(run); persist();
    let operationBegan = false;
    const operation = Promise.resolve().then(async () => {
      assertRunnable(run, controller, unit);
      if (op === 'investigate') {
        const baseline = captureCodingBaseline({ projectRoot: cfg!.projectRoot, inputPaths, writablePaths, limits: policy.bounds });
        codingWorkspaces.set(codingKey(run), { ...(latestCodingSession(run) ?? {}), baseline });
        const entries = new Map(baseline.entries.map(e => [e.path, e]));
        const readPaths = baseline.inputPaths;
        const agent = run.agents[policy.identity.rootAgentId]; workflowAssert(agent, 'Coding investigation agent missing');
        const promptPayload = freezeWorkflowData({ identity: { role: 'readonly-investigation', rootAgentId: policy.identity.rootAgentId, workerAgentId: policy.identity.workerAgentId, parentRunId: policy.identity.parentRunId, workflowRunId: run.workflowRunId, taskId: policy.identity.taskId, attemptNo: run.attemptNo }, task: policy.scope.task, outputSchema: spec.outputSchema, availablePaths: readPaths, baselineHash: baseline.hash, instructions: ['Investigate only by reading the exact availablePaths through workflow_stage_read or workflow_stage_inspect.', 'Do not request or perform writes. Return only JSON matching outputSchema.'] }, WORKFLOW_LIMITS.promptBytes);
        const inspectDetails = () => ({ candidateHash: baseline.hash, changedPaths: [], files: baseline.entries.map(e => ({ path: e.path, beforeText: e.text ?? null, afterText: e.text ?? null, beforeHash: e.sha256 ?? null, afterHash: e.sha256 ?? null })) });
        operationBegan = true;
        const outcome = strictCodingOutcome(await port.execute({ workflowRunId: run.workflowRunId, familyId: run.familyId, attemptNo: run.attemptNo, ...lineage(run, spec.id), stepId: spec.id, unitId: unit.id, inputHash: unit.inputHash, agent: freezeWorkflowData(agent, WORKFLOW_LIMITS.definitionBytes), prompt: `Readonly workflow coding investigation. Return only JSON matching WORKFLOW_INVESTIGATION_OUTPUT_SCHEMA.\nWORKFLOW_INVESTIGATION_REQUEST_JSON\n${JSON.stringify(promptPayload)}\nEND_WORKFLOW_INVESTIGATION_REQUEST_JSON`, signal: controller.signal, assertAdmission: () => assertRunnable(run, controller, unit), onIdentity: (native: WorkflowNativeIdentity) => { workflowAssert(identityValid(native) && !unit.native, 'Missing/duplicate/invalid investigation identity'); workflowAssert(!state.runs.some(r => workflowStepEntries(r).some(({ step: s }) => s.units.some(u => u !== unit && !u.reusedFrom && u.native && (u.native.runId === native.runId || u.native.taskId === native.taskId)))), 'Native identity collision'); unit.native = copy(native); journalPersist(); }, coding: { operation: op, policy, candidateHash: baseline.hash, iteration: run.attemptNo, paths: readPaths, read: (p: string) => { assertRunnable(run, controller, unit); const entry = entries.get(p); workflowAssert(!!entry && readPaths.includes(p), 'investigation path is outside exact readonly snapshot'); workflowAssert(entry.exists && typeof entry.text === 'string', 'investigation path is unavailable in readonly snapshot'); return entry.text; }, write: () => { throw new Error('investigation context is read-only'); }, inspect: () => { assertRunnable(run, controller, unit); return inspectDetails(); } } }));
        unit.cleanupSettled = outcome.cleanupSettled === true; assertRunnable(run, controller, unit);
        workflowAssert(unit.cleanupSettled && outcome.status === 'completed' && typeof outcome.text === 'string' && unit.native, 'Investigation did not complete with settled exact identity');
        if (outcome.identity) workflowAssert(workflowHash(outcome.identity) === workflowHash(unit.native), 'Investigation native identity mismatch');
        const result = workflowJson(JSON.parse(outcome.text), WORKFLOW_LIMITS.resultBytes); validateWorkflowValue(result, spec.outputSchema!);
        unit.coding = { phase: 'investigated', candidateHash: baseline.hash, baseline: baselineSnapshotJson(baseline), evidence: boundedJson({ investigation: { identity: unit.native, baselineHash: baseline.hash, paths: readPaths } }) };
        codingOutput(unit, result);
      } else if (op === 'stage-write') {
        const reviewed = unit.coding?.approvalId ? approvalRegistry.inspect(unit.coding.approvalId)[0] : undefined;
        const baseline = (reviewed?.request?.humanReview as any)?.baseline ?? captureCodingBaseline({ projectRoot: cfg!.projectRoot, inputPaths, writablePaths, limits: policy.bounds });
        const req = reviewed?.request ? reviewed.request as ReturnType<typeof implementationRequest> : implementationRequest(baseline);
        let record = reviewed ? reviewed as any : approvalRegistry.request(req); unit.coding = { phase: 'awaiting-implementation-approval', approvalId: record.id, approvalStatus: record.status, baseline: boundedJson(baseline) }; unit.status = 'running'; unit.cleanupSettled = true; outputStep(spec, step); stamp(run); persist();
        if (record.status !== 'granted') return;
        let workspaceBaseline: ReturnType<typeof captureCodingBaseline>;
        try { workspaceBaseline = assertFreshBaseline(baseline as ReturnType<typeof captureCodingBaseline>, cfg!.projectRoot, inputPaths, writablePaths, policy.bounds); }
        catch (error) { approvalRegistry.invalidate(r => r.kind === 'implementation' && r.id === unit.coding!.approvalId, 'reviewed baseline changed before implementation grant'); throw error; }
        const requestHash = approvalRegistry.inspect(unit.coding!.approvalId)[0].requestHash;
        const grant = unit.coding?.approvalId ? approvalRegistry.requireLiveFingerprint('implementation', unit.coding.approvalId, requestHash) : approvalRegistry.requireLive('implementation', req); unit.coding.consumedApprovalId = grant.approvalId;
        const assertSatisfiedFresh = () => {
          if (!carry?.satisfiedPaths.length) return;
          const current = captureCodingBaseline({ projectRoot: cfg!.projectRoot, inputPaths: carry.satisfiedPaths, writablePaths: [], limits: policy.bounds });
          const approvedEntries = (baseline as ReturnType<typeof captureCodingBaseline>).entries.filter(e => carry.satisfiedPaths.includes(e.path));
          workflowAssert(workflowHash(current.entries) === workflowHash(approvedEntries), 'Already-satisfied readonly destination changed');
        };
        const codingEligibility = () => {
          const session = latestCodingSession(run) ?? sessionForHooks;
          const context = session.effectContext;
          const admitted = context ? active.get(`${run.workflowRunId}/${context.unit.id}`) : [...active.values()].find(a => a.run === run);
          workflowAssert(admitted && admitted.run === run && (!context || admitted.unit === context.unit), 'Coding effect lacks current admitted unit');
          pureRunnable(run, admitted.controller, admitted.unit); assertSatisfiedFresh();
        };
        const assertCodingAuthority = () => {
          const liveGrant = implementationPredicate(grant.approvalId, grant.requestHash);
          authority(run, () => { codingEligibility(); liveGrant(); });
          codingEligibility(); liveGrant(); // No host calls after these final predicates.
        };
        const previousSession = codingWorkspaces.get(codingKey(run));
        let workspace = previousSession?.workspace; const sessionForHooks = previousSession ?? {}; if (!workspace) {
          sessionForHooks.effectContext = { run, spec, unit };
          try {
            assertWorkspaceReceiptCapacity(run, spec); // Before any continuation/new stage or lease allocation.
            if (carry) {
              const source = state.runs.find(r => r.workflowRunId === run.recoveryOf)!;
              const old = asRecord(carry.manifest) ?? asRecord(carry.partialOptions?.rootReadyEvidence)!;
              const provenance = { sourceWorkflowId: source.workflowRunId, oldStageGen: old.ownerGeneration, alreadySatisfiedPaths: carry.satisfiedPaths, remainingPaths: carry.remainingPaths };
              unit.coding.workspace = workflowJson({ ...asRecord(unit.coding.workspace), continuationProvenance: provenance, sourceCarry: { version: 1, sourceWorkflowId: source.workflowRunId, sourceHistoryHash: sourceHistoryHash(source), ...(carry.manifest ? { observedManifest: carry.manifest } : { partialOptions: carry.partialOptions }), observationHash: carry.observationHash, historicalCompletion: false } }, WORKFLOW_LIMITS.ledgerBytes);
              journalPersist(); assertCodingAuthority();
            }
            if (carry?.partialOptions) {
              workspace = createPartialReconstructionCodingWorkspace({ partialOptions: carry.partialOptions, workflowRunId: run.workflowRunId, recoveryWriterOwnerEvidence: recoveryOwnerEvidence!, assertAuthority: assertCodingAuthority, assertPreviousSettlement: () => { workflowAssert(selectedPlan?.settledSources.has(run.recoveryOf!), 'Partial source scope settlement missing'); }, effectHooks: makeCodingEffectHooks(sessionForHooks)!, limits: policy.bounds });
            } else if (carry) {
              const result = createContinuationCodingWorkspace({ rawRetainedManifest: carry.manifest, trustedScope: { projectRoot: cfg!.projectRoot, stagingParent: cfg!.stagingParent, workflowRunId: run.recoveryOf!, allowedPaths: carry.allowedPaths }, workflowRunId: run.workflowRunId, recoveryWriterOwnerEvidence: recoveryOwnerEvidence!, assertAuthority: assertCodingAuthority, assertPreviousSettlement: inspection => {
                workflowAssert(selectedPlan?.settledSources.has(run.recoveryOf!) && workflowHash({ classifications: inspection.classifications, readonlyObservations: inspection.readonlyObservations }) === carry.observationHash, 'Previous scope-bound settlement/observations changed');
              }, effectHooks: makeCodingEffectHooks(sessionForHooks), limits: policy.bounds });
              workflowAssert(result.status === 'created', result.status === 'blocked' ? result.error : 'Continuation workspace blocked');
              workspace = result.workspace; sessionForHooks.continuationProvenance = { ...result.provenance, alreadySatisfiedPaths: carry.satisfiedPaths }; unit.coding.workspace = workflowJson({ ...asRecord(unit.coding.workspace), recoveryManifest: workspace.recoveryManifest?.(), continuationProvenance: sessionForHooks.continuationProvenance }, WORKFLOW_LIMITS.ledgerBytes);
              journalPersist();
            } else workspace = createCodingWorkspace({ workflowRunId: run.workflowRunId, projectRoot: cfg!.projectRoot, stagingParent: cfg!.stagingParent, inputPaths, writablePaths, assertAuthority: assertCodingAuthority, limits: policy.bounds, reviewedBaseline: workspaceBaseline, effectHooks: makeCodingEffectHooks(sessionForHooks), recoveryWriterOwnerEvidence: recoveryOwnerEvidence }) as RuntimeCodingWorkspace;
          } finally { delete sessionForHooks.effectContext; }
        }
        const previousCandidate = previousSession?.workspace ? candidateJson(previousSession.workspace) : undefined;
        const previousFeedback = workflowStepContext(run, spec.id).iteration?.state;
        sessionForHooks.workspace = workspace; sessionForHooks.implApprovalId = grant.approvalId; sessionForHooks.implRequestHash = grant.requestHash; sessionForHooks.baseline = baseline as ReturnType<typeof captureCodingBaseline>; if (previousSession?.candidateHash) sessionForHooks.candidateHash = previousSession.candidateHash; if (previousSession?.evidence) sessionForHooks.evidence = previousSession.evidence; codingWorkspaces.set(codingKey(run), sessionForHooks);
        const agent = run.agents[policy.identity.workerAgentId]; workflowAssert(agent, 'Coding worker agent missing');
        const correctionContext = freezeWorkflowData({ ...(previousFeedback !== undefined ? { previousFeedback } : {}), ...(previousCandidate !== undefined ? { previousCandidate } : {}), ...(previousSession?.evidence !== undefined ? { previousEvidence: previousSession.evidence } : {}) }, WORKFLOW_LIMITS.promptBytes);
        const writerPrompt = `${policy.scope.task}\n\nWORKFLOW_CORRECTION_CONTEXT_JSON\n${JSON.stringify(correctionContext)}\nEND_WORKFLOW_CORRECTION_CONTEXT_JSON`;
        const reqNative = { workflowRunId: run.workflowRunId, familyId: run.familyId, attemptNo: run.attemptNo, ...lineage(run, spec.id), stepId: spec.id, unitId: unit.id, inputHash: unit.inputHash, agent: freezeWorkflowData(agent, WORKFLOW_LIMITS.definitionBytes), prompt: writerPrompt, signal: controller.signal, assertAdmission: () => assertRunnable(run, controller, unit), onIdentity: (native: WorkflowNativeIdentity) => { workflowAssert(identityValid(native) && !unit.native, 'Missing/duplicate/invalid native identity'); workflowAssert(!state.runs.some(r => workflowStepEntries(r).some(({ step: s }) => s.units.some(u => u !== unit && !u.reusedFrom && u.native && (u.native.runId === native.runId || u.native.taskId === native.taskId)))), 'Native identity collision'); unit.native = copy(native); journalPersist(); }, coding: { operation: op, policy, stageRoot: workspace.stageRoot, iteration: run.attemptNo, paths: inputPaths, read: (p: string) => { assertRunnable(run, controller, unit); assertCodingAuthority(); return workspace.read(p); }, write: (p: string, text: string) => { assertRunnable(run, controller, unit); assertCodingAuthority(); const session = latestCodingSession(run); if (session) session.effectContext = { run, spec, unit }; try { workspace.write(p, text); } finally { if (session) delete session.effectContext; } if (session) { delete session.candidateHash; delete session.evidence; } approvalRegistry.invalidate(r => r.kind === 'application' && r.attemptKey === req.attemptKey, 'writer mutation invalidated application request'); }, inspect: () => { assertRunnable(run, controller, unit); assertCodingAuthority(); return candidateJson(workspace); } } };
        operationBegan = true;
        const outcome = strictCodingOutcome(await port.execute(reqNative));
        unit.cleanupSettled = outcome.cleanupSettled === true;
        if ((controller.signal.aborted || run.status === 'cancelling') && unit.cleanupSettled) { workspace.settle?.(); unit.status = 'cancelled'; return; }
        assertRunnable(run, controller, unit); assertCodingAuthority();
        workflowAssert(unit.cleanupSettled && outcome.status === 'completed' && unit.native, 'Coding writer did not complete with settled exact identity');
        if (outcome.identity) workflowAssert(workflowHash(outcome.identity) === workflowHash(unit.native), 'Coding native identity mismatch');
        const candidate = workspace.inspect(); workflowAssert(candidate.changedPaths.length > 0, 'Coding writer produced no candidate changes'); latestCodingSession(run)!.candidateHash = candidate.hash;
        approvalRegistry.invalidate(r => r.kind === 'application' && r.attemptKey === req.attemptKey, 'writer invalidated previous gate evidence');
        unit.coding = { phase: 'staged', candidateHash: candidate.hash, consumedApprovalId: grant.approvalId, workspace: workflowJson(recoveryEnabled ? { ...asRecord(unit.coding?.workspace), recoveryManifest: workspace.recoveryManifest?.() ?? { error: 'workspace-manifest-unavailable-after-stage' }, ...(asRecord(unit.coding?.workspace)?.continuationProvenance ? { continuationProvenance: asRecord(unit.coding?.workspace)!.continuationProvenance } : {}) } : { stageRoot: workspace.stageRoot }, WORKFLOW_LIMITS.ledgerBytes), candidate: candidateJson(workspace) }; codingOutput(unit, { candidateHash: candidate.hash, changedPaths: candidate.changedPaths });
      } else if (op === 'check') {
        const session = latestCodingSession(run); workflowAssert(session?.workspace && session.candidateHash && session.implApprovalId && session.implRequestHash, 'No staged candidate for check'); const workspace = session.workspace; approvalRegistry.requireLiveFingerprint('implementation', session.implApprovalId, session.implRequestHash);
        const profile = policy.checkProfiles?.find(p => p.id === spec.coding!.checkProfileId); workflowAssert(profile, 'Check profile not selected');
        const bounds = resolveCodingBounds(policy);
        const approvedHostProfile = { id: profile.id, executable: profile.executable, argv: profile.argv, cwd: profile.cwd, env: profile.env ?? {}, timeoutMs: profile.timeoutMs, outputBytes: bounds.maxOutputBytes, generatedOutputs: [] };
        const trustedProfile = cfg!.checkProfiles?.[profile.id];
        const trustedOutputBytes = trustedProfile && typeof trustedProfile === 'object' && Number.isSafeInteger((trustedProfile as Record<string, unknown>).outputBytes) ? (trustedProfile as Record<string, number>).outputBytes : bounds.maxOutputBytes;
        workflowAssert(trustedOutputBytes > 0 && trustedOutputBytes <= bounds.maxOutputBytes, 'Trusted check output bound exceeds approved policy');
        const comparableTrustedProfile = trustedProfile && typeof trustedProfile === 'object' ? { ...(trustedProfile as Record<string, unknown>), outputBytes: bounds.maxOutputBytes, generatedOutputs: (trustedProfile as Record<string, unknown>).generatedOutputs ?? [] } : trustedProfile;
        if (!trustedProfile || workflowHash(comparableTrustedProfile) !== workflowHash(approvedHostProfile)) { unit.cleanupSettled = true; active.delete(activeKey); throw new Error('Trusted check profile does not exactly match approved profile'); }
        operationBegan = true;
        const checkProfileHash = profileHash(trustedProfile);
        const durable = recoveryEnabled ? (() => {
          workflowAssert(typeof allocateCheckReceipt === 'function', 'Recovery-enabled checks require durable receipt allocator');
          const config = allocateCheckReceipt({ workflowRunId: run.workflowRunId, unitId: unit.id, candidateHash: session.candidateHash!, candidateId: workflowHash({ version: 1, workflowRunId: run.workflowRunId, unitId: unit.id, candidateHash: session.candidateHash! }), profileId: profile.id, profileHash: checkProfileHash });
          workflowAssert(config.candidateId === workflowHash({ version: 1, workflowRunId: run.workflowRunId, unitId: unit.id, candidateHash: session.candidateHash! }) && config.profileId === profile.id, 'Check receipt allocation must bind the exact workflow/unit/candidate and profile');
          const persistEvidence = (kind: 'intent' | 'ready' | 'receipt', value: DurableCheckIntent | DurableCheckSupervisorReady | DurableCheckReceipt) => {
            const prior = unit.coding?.evidence && typeof unit.coding.evidence === 'object' && !Array.isArray(unit.coding.evidence) ? unit.coding.evidence as Record<string, WorkflowJson> : {};
            const priorDurable = prior.durableCheck && typeof prior.durableCheck === 'object' && !Array.isArray(prior.durableCheck) ? prior.durableCheck as Record<string, WorkflowJson> : {};
            unit.coding = { ...(unit.coding ?? {}), phase: `check-${kind}`, candidateHash: session.candidateHash, evidence: workflowJson({ ...prior, durableCheck: { ...priorDurable, config: workflowJson(config, WORKFLOW_LIMITS.ledgerBytes), [kind]: workflowJson(value, WORKFLOW_LIMITS.ledgerBytes) } }, WORKFLOW_LIMITS.ledgerBytes) };
            journalPersist();
          };
          return { ...config,
            onIntent: (intent: DurableCheckIntent) => persistEvidence('intent', intent),
            onSupervisorReady: (ready: DurableCheckSupervisorReady) => persistEvidence('ready', ready),
            onReceipt: (receipt: DurableCheckReceipt) => {
              persistEvidence('receipt', receipt);
              const co = receipt.commandOutcome;
              const status: RecoveryResultStatus = !receipt.commandCompleted || !co ? 'uncertain' : co.cancelled ? 'cancelled' : (co.timedOut || co.exitCode !== 0 || co.signal !== null) ? 'failed' : 'completed';
              const cleanup = receipt.cleanup.outcome === 'ok' || receipt.cleanup.outcome === 'not_needed' ? 'settled' : 'uncertain';
              recoveryAdmissionResult(run, recoveryCodingOpId, status, cleanup, { durableCheckReceipt: receipt });
              journalPersist();
            }
          };
        })() : undefined;
        const result = await runCodingCheck({ profile: trustedProfile, stageRoot: workspace.stageRoot, expectedCandidateHash: sha256(session.candidateHash), captureCandidate: () => workspace.inspect().hash, signal: controller.signal, assertAuthority: () => { if (controller.signal.aborted || run.status === 'cancelling') { authority(run); approvalRegistry.requireLiveFingerprint('implementation', session.implApprovalId!, session.implRequestHash!); return; } assertCodingGrantAuthority(run, controller, unit, session.implApprovalId!, session.implRequestHash!); }, durable });
        const evidenceComparable = { profileId: profile.id, status: result.passed ? 'passed' as const : 'failed' as const, ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}), ...(result.signal !== null ? { signal: String(result.signal) } : {}), stdout: result.stdout, stderr: result.stderr, startedAt: result.startedAt, completedAt: result.finishedAt, outcome: result.outcome, reason: result.reason, timedOut: result.timedOut, cancelled: result.cancelled, stdoutTruncated: result.stdoutTruncated, stderrTruncated: result.stderrTruncated, stdoutDroppedBytes: result.stdoutDroppedBytes, stderrDroppedBytes: result.stderrDroppedBytes, cleanup: result.cleanup, candidateHashBefore: result.candidateHashBefore, candidateHashAfter: result.candidateHashAfter, expectedCandidateHash: result.expectedCandidateHash, checkProfileHash: result.profileHash };
        const evidence = { ...evidenceComparable, evidenceHash: workflowHash(evidenceComparable) };
        session.evidence = { checks: [...(session.evidence?.checks ?? []).filter(c => c.profileId !== profile.id), evidence], ...(session.evidence?.review ? { review: session.evidence.review } : {}) };
        const priorCheckEvidence = unit.coding?.evidence && typeof unit.coding.evidence === 'object' && !Array.isArray(unit.coding.evidence) ? unit.coding.evidence as Record<string, WorkflowJson> : {}; unit.coding = { phase: result.passed ? 'check-passed' : 'check-failed', candidateHash: session.candidateHash, evidenceHash: workflowHash(session.evidence), evidence: boundedJson({ ...priorCheckEvidence, gateEvidence: session.evidence }) };
        unit.cleanupSettled = result.cleanup.outcome === 'ok' || result.cleanup.outcome === 'not_needed';
        if (controller.signal.aborted || run.status === 'cancelling') { if (!unit.cleanupSettled) throw new Error(`Required coding check failed: ${result.reason}`); unit.status = 'cancelled'; return; }
        assertCodingGrantAuthority(run, controller, unit, session.implApprovalId, session.implRequestHash);
        if (!result.passed) {
          const corrective = result.outcome === 'failed' && !result.timedOut && !result.cancelled && (result.cleanup.outcome === 'ok' || result.cleanup.outcome === 'not_needed');
          if (!corrective) throw new Error(`Required coding check failed: ${result.reason}`);
          codingOutput(unit, { passed: false, profileId: profile.id, candidateHash: session.candidateHash });
        } else codingOutput(unit, { passed: true, profileId: profile.id, candidateHash: session.candidateHash });
      } else if (op === 'review') {
        const session = latestCodingSession(run); workflowAssert(session?.workspace && session.candidateHash && session.implApprovalId && session.implRequestHash, 'No staged candidate for review'); const workspace = session.workspace; approvalRegistry.requireLiveFingerprint('implementation', session.implApprovalId, session.implRequestHash);
        const agent = run.agents[policy.identity.rootAgentId]; workflowAssert(agent && agent.id !== policy.identity.workerAgentId, 'Independent reviewer agent missing');
        const reviewPayload = freezeWorkflowData({ task: policy.scope.task, writablePaths: policy.scope.writablePaths, candidate: candidateJson(workspace), checks: session.evidence?.checks ?? [] }, WORKFLOW_LIMITS.promptBytes);
        operationBegan = true;
        const outcome = strictCodingOutcome(await port.execute({ workflowRunId: run.workflowRunId, familyId: run.familyId, attemptNo: run.attemptNo, ...lineage(run, spec.id), stepId: spec.id, unitId: unit.id, inputHash: unit.inputHash, agent: freezeWorkflowData(agent, WORKFLOW_LIMITS.definitionBytes), prompt: `Review exact staged candidate and return only JSON {\"verdict\":\"pass|fail\",\"findings\":[]}.\n${JSON.stringify(reviewPayload)}`, signal: controller.signal, assertAdmission: () => assertRunnable(run, controller, unit), onIdentity: (native) => { workflowAssert(identityValid(native) && !unit.native, 'Missing/duplicate/invalid reviewer identity'); workflowAssert(!state.runs.some(r => workflowStepEntries(r).some(({ step: s }) => s.units.some(u => u !== unit && !u.reusedFrom && u.native && (u.native.runId === native.runId || u.native.taskId === native.taskId)))), 'Native identity collision'); unit.native = copy(native); journalPersist(); }, coding: { operation: op, policy, stageRoot: workspace.stageRoot, candidateHash: session.candidateHash, iteration: run.attemptNo, paths: inputPaths, read: (p) => { assertCodingGrantAuthority(run, controller, unit, session.implApprovalId!, session.implRequestHash!); return workspace.read(p); }, write: () => { throw new Error('review context is read-only'); }, inspect: () => { assertCodingGrantAuthority(run, controller, unit, session.implApprovalId!, session.implRequestHash!); return candidateJson(workspace); } } }));
        unit.cleanupSettled = outcome.cleanupSettled === true;
        workflowAssert(outcome.cleanupSettled && outcome.status === 'completed' && typeof outcome.text === 'string' && unit.native, 'Review did not complete with settled identity'); unit.cleanupSettled = true;
        if (outcome.identity) workflowAssert(workflowHash(outcome.identity) === workflowHash(unit.native), 'Reviewer native identity mismatch');
        workflowAssert(unit.native.runId !== policy.identity.workerAgentId && unit.native.taskId !== policy.identity.workerAgentId, 'Reviewer identity is not distinct');
        assertCodingGrantAuthority(run, controller, unit, session.implApprovalId, session.implRequestHash);
        const parsed = workflowJson(JSON.parse(outcome.text), WORKFLOW_LIMITS.resultBytes) as Record<string, WorkflowJson>; workflowAssert(Object.keys(parsed).every(k => ['verdict','findings'].includes(k)) && (parsed.verdict === 'pass' || parsed.verdict === 'fail' || parsed.verdict === 'passed' || parsed.verdict === 'failed') && Array.isArray(parsed.findings), 'Invalid bounded review schema'); const scriptedVerdict = parsed.verdict === 'pass' || parsed.verdict === 'passed';
        const checksReady = requiredChecksPassed(policy, session.evidence, session.candidateHash);
        const verdict = scriptedVerdict && checksReady;
        const findings = parsed.findings;
        const reviewBase = { status: verdict ? 'passed' as const : 'failed' as const, reviewerIdentity: `${unit.native.runId}:${unit.native.taskId}`, findings };
        const review = { ...reviewBase, evidenceHash: workflowHash(reviewBase) } as unknown as WorkflowCodingReviewEvidence;
        session.evidence = { checks: session.evidence?.checks ?? [], review };
        unit.coding = { phase: verdict ? 'review-passed' : 'review-failed', candidateHash: session.candidateHash, evidenceHash: workflowHash(session.evidence), evidence: boundedJson(session.evidence) };
        codingOutput(unit, { passed: verdict, candidateHash: session.candidateHash, reviewer: review.reviewerIdentity, findings });
      } else if (op === 'apply') {
        const session = latestCodingSession(run); workflowAssert(session?.workspace && session.candidateHash && session.evidence && session.implApprovalId && session.implRequestHash, 'No staged candidate/evidence for apply'); const workspace = session.workspace; approvalRegistry.requireLiveFingerprint('implementation', session.implApprovalId, session.implRequestHash);
        assertRuntimeApplyEvidence(run, policy, session.evidence, session.candidateHash);
        workflowAssert(codingGatesPassed(policy, session.evidence, { candidateHash: session.candidateHash, policyHash: codingPolicyHash(policy), baselineHash: codingBaselineHash(policy), changedPaths: session.workspace.inspect().changedPaths, files: [], bytes: 0, id: session.candidateHash.slice(0, 32), iteration: run.attemptNo }), 'Required checks/review have not passed');
        try { session.workspace.assertFreshDestination(); }
        catch (error) { if (unit.coding?.approvalId) approvalRegistry.invalidate(r => r.kind === 'application' && r.id === unit.coding!.approvalId, 'target changed before application'); session.effectContext = { run, spec, unit }; try { session.workspace.settle?.(); } finally { delete session.effectContext; } throw error; }
        const candidateForApproval = session.workspace.inspect(); const baseline = session.baseline ?? captureCodingBaseline({ projectRoot: cfg!.projectRoot, inputPaths, writablePaths, limits: policy.bounds }); const targetHash = workflowHash({ baseline: baseline.hash, candidate: session.candidateHash, changedPaths: candidateForApproval.changedPaths });
        const applicationPayload = { candidate: candidateJson(session.workspace), stats: { totalBytes: candidateForApproval.totalBytes ?? 0, clippedBytes: candidateForApproval.clippedBytes ?? 0 }, retained: { stageRoot: session.workspace.stageRoot, candidateHash: session.candidateHash }, evidence: session.evidence, targetBaselineHash: baseline.hash, beforeAfter: candidateForApproval.files.map(f => ({ path: f.path, beforeHash: f.beforeHash, afterHash: f.afterHash, beforeBytes: f.before?.length ?? 0, afterBytes: f.after?.length ?? 0, preview: f.preview ?? f.after?.toString('utf8') ?? '', clippedBytes: f.clippedBytes ?? 0 })) };
        const req = createCodingApprovalRequest('application', policy, { candidateHash: session.candidateHash, evidenceHash: workflowHash(session.evidence), targetHash, humanReview: approvalPayload('application', baseline, applicationPayload) });
        const record = approvalRegistry.request(req); unit.coding = { ...(unit.coding?.evidence ? { evidence: unit.coding.evidence } : {}), ...(unit.coding?.workspace ? { workspace: unit.coding.workspace } : {}), phase: 'awaiting-application-approval', approvalId: record.id, approvalStatus: record.status, candidateHash: session.candidateHash, evidenceHash: workflowHash(session.evidence) }; unit.status = 'running'; unit.cleanupSettled = true; outputStep(spec, step); stamp(run); persist();
        if (record.status !== 'granted') return;
        const beforeApply = session.workspace.inspect(); workflowAssert(beforeApply.hash === session.candidateHash, 'Workspace candidate changed after review/check gates');
        const grant = unit.coding?.approvalId ? approvalRegistry.consumeFingerprint('application', unit.coding.approvalId, approvalRegistry.inspect(unit.coding.approvalId)[0].requestHash) : approvalRegistry.consume('application', req); approvalRegistry.requireLiveFingerprint('implementation', session.implApprovalId, session.implRequestHash); assertRunnable(run, controller, unit); operationBegan = true; session.effectContext = { run, spec, unit }; let applied: ReturnType<RuntimeCodingWorkspace['apply']>; activityApplying.add(activeKey); refreshActivity(); try { applied = session.workspace.apply(session.candidateHash); } finally { delete session.effectContext; activityApplying.delete(activeKey); refreshActivity(); }
        const outcome = { status: applied.status, candidateHash: session.candidateHash, appliedPaths: applied.appliedPaths, rejectedPaths: applied.status === 'applied' ? [] : session.workspace.inspect().changedPaths.filter(p => !applied.appliedPaths.includes(p)), diagnostics: applied.error ? [applied.error] : [], outcomeHash: workflowHash(applied) };
        unit.coding = { phase: applied.status === 'applied' ? 'applied' : applied.status === 'partial' ? 'apply-partial-uncertain' : 'apply-rejected', candidateHash: session.candidateHash, evidenceHash: workflowHash(session.evidence), consumedApprovalId: grant.approvalId, appliedPaths: applied.appliedPaths, rejectedPaths: outcome.rejectedPaths, ...(applied.error ? { error: applied.error } : {}), outcome: boundedJson(outcome), evidence: boundedJson(session.evidence), workspace: workflowJson(recoveryEnabled ? { ...asRecord(unit.coding?.workspace), recoveryManifest: session.workspace.recoveryManifest?.() ?? { error: 'workspace-manifest-unavailable-after-apply' }, ...(session.continuationProvenance ? { continuationProvenance: session.continuationProvenance } : {}) } : { stageRoot: session.workspace.stageRoot }, WORKFLOW_LIMITS.ledgerBytes) };
        if (applied.status !== 'applied') { budgetResult(unit, freezeWorkflowData(outcome as unknown as WorkflowJson, WORKFLOW_LIMITS.resultBytes)); unit.status = 'failed'; unit.cleanupSettled = applied.status === 'rejected'; if (applied.status === 'partial') cleanupUncertain = true; throw new Error(applied.error ?? 'Apply rejected'); }
        session.effectContext = { run, spec, unit }; try { session.workspace.settle?.(); } finally { delete session.effectContext; }
        codingOutput(unit, outcome as unknown as WorkflowJson);
      } else throw new Error(`Unsupported coding operation ${op}`);
    }).then(() => { if (!unit.cleanupSettled) unit.cleanupSettled = true;  active.delete(activeKey);
      if (recoveryEnabled && recoveryCodingOpId && !(run.recovery?.operations.find(o => o.id === recoveryCodingOpId)?.result)) recoveryAdmissionResult(run, recoveryCodingOpId, unit.status === 'cancelled' ? 'cancelled' : unit.status === 'failed' ? 'failed' : 'completed', unit.cleanupSettled ? 'settled' : 'uncertain', { coding: unit.coding ?? null, result: unit.result !== undefined ? { hash: workflowHash(unit.result) } : null });
      outputStep(spec, step); stamp(run); finishRun(run); journalPersist(); }, error => { if ((error as { workspaceRejectionSettled?: boolean })?.workspaceRejectionSettled && controller.signal.aborted) { unit.cleanupSettled = true; unit.status = 'cancelled'; }
      else if (authorityLost || (error as { cleanupBlocked?: boolean })?.cleanupBlocked) { unit.cleanupSettled = false; unit.status = 'unverified'; cleanupUncertain = true; }
      else if (!operationBegan) { unit.cleanupSettled = true; active.delete(activeKey); if (unit.status !== 'cancelled') unit.status = 'failed'; }
      else if (!unit.cleanupSettled) { unit.status = 'unverified'; cleanupUncertain = true; }
      else if (unit.status !== 'failed') unit.status = 'failed'; unit.error = errorText(error);  if (unit.cleanupSettled) active.delete(activeKey);
      if (recoveryEnabled && recoveryCodingOpId && !(run.recovery?.operations.find(o => o.id === recoveryCodingOpId)?.result)) recoveryAdmissionResult(run, recoveryCodingOpId, unit.status === 'cancelled' ? 'cancelled' : unit.status === 'unverified' ? 'uncertain' : 'failed', unit.cleanupSettled ? 'settled' : 'uncertain', { coding: unit.coding ?? null, error: unit.error ?? null });
      outputStep(spec, step); stamp(run); finishRun(run); if (!authorityLost) journalPersist(); }).finally(() => { pending.delete(operation); schedule(); refreshActivity(); });
    pending.add(operation); return true;
  };
  const launch = (run: WorkflowRun, spec: WorkflowStep, step: WorkflowStepRun, unit: WorkflowUnit) => {
    const controller = new AbortController();
    const key = `${run.workflowRunId}/${unit.id}`;
    let invoked = false;
    const assertAdmission = () => {
      assertRecoveryOwner();
      authority(run); workflowAssert(!controller.signal.aborted && run.status !== 'cancelling' && !terminal(run), 'Workflow unit cancelled/closed');
      workflowAssert(invoked || run.status === 'running', 'Workflow paused before native admission');
      workflowAssert(unit.inputHash === hashUnit(run, spec, unit.inputs), 'Materialized dependency/input identity changed');
    };
    try {
      assertAdmission(); workflowAssert(run.admissions < maxAdmissions, 'Workflow family admission budget exhausted');
      const prompt = `${spec.prompt}\n\nWORKFLOW_DATA_JSON\n${JSON.stringify({ inputs: unit.inputs, outputSchema: spec.outputSchema })}\nEND_WORKFLOW_DATA_JSON`;
      workflowAssert(Buffer.byteLength(prompt, 'utf8') <= WORKFLOW_LIMITS.promptBytes, 'Resolved workflow prompt exceeded');
      let recoveryOpId: string | undefined;
      if (recoveryEnabled) { assertRecoveryOwner(); recoveryOpId = recoveryAdmissionIntent(run, spec, unit, 'native'); }
      run.admissions++; validateRunRecovery(run); unit.status = 'running'; unit.cleanupSettled = false; run.cleanupSettled = false;
      active.set(key, { run, unit, controller }); stamp(run); persist(); assertAdmission();
      const onIdentity = (identity: WorkflowNativeIdentity) => {
        workflowAssert(identityValid(identity) && !unit.native, 'Missing/duplicate/invalid native identity');
        workflowAssert(!state.runs.some(r => workflowStepEntries(r).some(({ step: s }) => s.units.some(u => u !== unit && !u.reusedFrom && u.native && (u.native.runId === identity.runId || u.native.taskId === identity.taskId)))), 'Native identity collision');
        try { unit.native = copy(identity); persist(); assertAdmission(); }
        catch (error) { if (recoveryEnabled) { authorityLost = true; unit.status = 'unverified'; unit.cleanupSettled = false; cleanupUncertain = true; controller.abort(); } refreshActivity(); throw error; }
      };
      const operation = Promise.resolve().then(() => { assertAdmission(); invoked = true; return port.execute({ workflowRunId: run.workflowRunId, familyId: run.familyId, attemptNo: run.attemptNo, ...lineage(run, spec.id), stepId: spec.id, unitId: unit.id, inputHash: unit.inputHash,
        agent: freezeWorkflowData(run.agents[spec.agentId!], WORKFLOW_LIMITS.definitionBytes), prompt, signal: controller.signal, assertAdmission, onIdentity }); })
        .then(outcome => complete(outcome), error => complete({ status: invoked ? 'unverified' : 'cancelled', error: errorText(error), cleanupSettled: !invoked }))
        .finally(() => { pending.delete(operation); schedule(); refreshActivity(); });
      pending.add(operation);
      function complete(rawOutcome: WorkflowNativeOutcome) {
        try {
        let outcome = rawOutcome;
        try {
          workflowAssert(outcome && typeof outcome === 'object' && !Array.isArray(outcome) && Object.getPrototypeOf(outcome) === Object.prototype && Object.getOwnPropertySymbols(outcome).length === 0, 'Invalid native outcome');
          const fields = Object.getOwnPropertyDescriptors(outcome);
          workflowAssert(Object.entries(fields).every(([k, d]) => ['status', 'text', 'error', 'identity', 'cleanupSettled'].includes(k) && d.enumerable && 'value' in d), 'Invalid native outcome fields/accessors');
          workflowAssert(typeof fields.cleanupSettled?.value === 'boolean' && typeof fields.status?.value === 'string' && ['completed', 'failed', 'cancelled', 'unverified'].includes(fields.status.value), 'Invalid native outcome status/settlement');
        } catch { outcome = { status: 'unverified', cleanupSettled: false, error: 'Malformed native outcome; cleanup settlement unknown' }; }
        const diagnostic = typeof outcome.error === 'string' && outcome.error.length <= 1024 ? outcome.error : outcome.error ? 'Oversized/invalid native diagnostic rejected' : undefined;
        unit.cleanupSettled = outcome.cleanupSettled === true;
        if (unit.cleanupSettled) active.delete(key); // Unknown cleanup retains ownership and its permit.
        else cleanupUncertain = true;
        if (owners.get(container) !== owner || authorityLost) return; // Old completion cannot publish into a recovered/new owner.
        if (!invoked && unit.cleanupSettled && run.status === 'paused') {
          unit.status = 'queued'; delete unit.error; outputStep(spec, step); stamp(run); finishRun(run); persist(); return;
        }
        try {
          workflowAssert(['completed', 'failed', 'cancelled', 'unverified'].includes(outcome.status), 'Invalid native outcome status');
          if (outcome.identity) workflowAssert(unit.native && workflowHash(outcome.identity) === workflowHash(unit.native), 'Native outcome identity mismatch');
          if (!unit.cleanupSettled) { unit.status = 'unverified'; unit.error = diagnostic ?? 'Native cleanup not proven settled'; }
          else if (controller.signal.aborted || run.status === 'cancelling') { unit.status = 'cancelled'; }
          else if (outcome.status !== 'completed') { unit.status = outcome.status; unit.error = diagnostic ?? 'Native unit did not complete'; }
          else {
            workflowAssert(identityValid(unit.native) && typeof outcome.text === 'string', 'Completed native result lacks identity/text');
            workflowAssert(Buffer.byteLength(outcome.text, 'utf8') <= WORKFLOW_LIMITS.resultBytes, 'Raw native result exceeded before parsing');
            const result = workflowJson(JSON.parse(outcome.text), WORKFLOW_LIMITS.resultBytes); validateWorkflowValue(result, spec.outputSchema!);
            if (run.definition.id === 'read-only-review' && spec.id === 'discover') {
              const targets = (result as Record<string, WorkflowJson>).targets as string[];
              const candidates = (run.inputs as Record<string, WorkflowJson>).candidatePaths as string[];
              workflowAssert(new Set(targets).size === targets.length && targets.every(t => candidates.includes(t)), 'Discovery target outside caller candidate scope');
            }
            if (run.definition.id === 'read-only-review' && spec.id === 'review') {
              const findings = (result as Record<string, WorkflowJson>).findings as Array<Record<string, WorkflowJson>>;
              const candidates = (run.inputs as Record<string, WorkflowJson>).candidatePaths as string[];
              workflowAssert(findings.every(f => typeof f.id === 'string' && f.id.trim().length > 0 && typeof f.path === 'string' && candidates.some(path => f.path === path || String(f.path).startsWith(`${path}/`)) && Number.isSafeInteger(f.line) && Number(f.line) > 0) && new Set(findings.map(f => f.id)).size === findings.length, 'Review finding missing/duplicate ID or outside caller candidate scope');
            }
            budgetResult(unit, freezeWorkflowData(result, WORKFLOW_LIMITS.resultBytes)); unit.status = 'completed';
          }
        } catch (error) { unit.status = unit.cleanupSettled ? 'failed' : 'unverified'; unit.error = errorText(error); }
        if (recoveryEnabled) {
          try {
            const evidence = { identity: unit.native ?? null, outcome: { status: outcome.status, cleanupSettled: unit.cleanupSettled, diagnostic: diagnostic ?? null }, result: unit.result !== undefined ? { hash: workflowHash(unit.result) } : null };
            recoveryAdmissionResult(run, recoveryOpId, unit.status === 'completed' ? 'completed' : unit.status === 'cancelled' ? 'cancelled' : unit.status === 'unverified' ? 'uncertain' : 'failed', unit.cleanupSettled ? 'settled' : 'uncertain', evidence);
            validateRunRecovery(run);
          } catch (error) { unit.status = 'unverified'; unit.cleanupSettled = false; cleanupUncertain = true; unit.error = errorText(error); }
        }
        try { outputStep(spec, step); stamp(run); finishRun(run); persist(); }
        catch (error) {
          if (recoveryEnabled) {
            unit.status = 'unverified'; unit.cleanupSettled = false; cleanupUncertain = true;
            step.status = 'unverified'; step.error = errorText(error); delete step.output;
            run.status = 'needs-attention'; run.cleanupSettled = false; run.error = step.error; stamp(run);
            authorityLost = true; active.forEach(a => a.controller.abort());
          } else {
            step.status = 'failed'; step.error = errorText(error); step.output = { status: 'failed', error: step.error };
            run.error = step.error; stamp(run); finishRun(run);
            try { persist(); } catch { authorityLost = true; active.forEach(a => a.controller.abort()); }
          }
        }
        } finally { refreshActivity(); }
      }
    } catch (error) {
      if (!invoked) { active.delete(key); unit.cleanupSettled = true; unit.status = run.status === 'paused' ? 'queued' : run.status === 'cancelling' ? 'cancelled' : 'failed'; }
      else { unit.status = 'unverified'; unit.cleanupSettled = false; controller.abort(); }
      unit.error = errorText(error); outputStep(spec, step); stamp(run); finishRun(run); persist();
    }
  };
  function pump() {
    scheduled = false; if (pumping || disposed || authorityLost) return; pumping = true;
    try {
      ledgerCurrent();
      let progress = true;
      while (progress) {
        progress = false;
        for (const run of state.runs) {
          if (run.status !== 'running') continue;
          try { authority(run); } catch (error) { if (run.status === 'running') { run.status = 'paused'; run.error = errorText(error); stamp(run); persist(); } continue; }
          for (const entry of workflowStepEntries(run)) {
            if (run.status !== 'running') break;
            const spec = qualifyWorkflowStep(entry.spec, entry.iterationId), step = entry.step;
            if (entry.blockId && run.steps.find(s => s.id === entry.blockId)!.status !== 'running') continue;
            const scope = workflowStepContext(run, step.id);
            if (step.status === 'queued' && spec.dependsOn.every(id => settled(scope.steps.find(s => s.id === id)!.status))) {
              prepare(run, spec, step); stamp(run); persist(); progress = true;
            }
            if (run.status !== 'running') break;
            if (spec.kind === 'repeat' && step.status === 'running' && advanceRepeat(run, spec, step)) { stamp(run); persist(); progress = true; }
            if (run.status !== 'running') break;
            for (const unit of step.units) {
              if (run.status !== 'running') break;
              if (spec.kind === 'coding') { if (unit.status === 'queued' || (unit.status === 'running' && unit.coding?.approvalStatus === 'pending')) progress = launchCoding(run, spec, step, unit) || progress; continue; }
              if (active.size >= globalCap() || runActiveCount(run) >= run.concurrency) break;
              if (unit.status === 'queued') { launch(run, spec, step, unit); progress = true; }
            }
          }
          finishRun(run);
        }
      }
      persist();
    } catch (error) {
      authorityLost = true; liveRecoveryPlans.clear(); active.forEach(a => a.controller.abort());
      for (const run of state.runs) if (!terminal(run)) { run.status = 'needs-attention'; run.error = errorText(error); }
    } finally { pumping = false; refreshActivity(); }
  }
  function schedule() { if (!scheduled && !disposed && !authorityLost) { scheduled = true; queueMicrotask(pump); } }

  const normalizeRecoverySelections = (raw: unknown): { reuseUnitIds: string[]; rerunUnitIds: string[] } => {
    const value = raw === undefined ? {} : workflowJson(raw, WORKFLOW_LIMITS.definitionBytes) as Record<string, unknown>;
    workflowAssert(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(k => ['reuseUnitIds', 'rerunUnitIds'].includes(k)), 'Unknown recovery selection field');
    const list = (v: unknown, label: string) => {
      if (v === undefined) return [];
      workflowAssert(Array.isArray(v) && v.length <= 256 && v.every(x => typeof x === 'string' && x.length > 0 && x.length <= 160), 'Invalid recovery selection');
      const ids = v as string[];
      workflowAssert(new Set(ids).size === ids.length, `Duplicate recovery ${label} selection`);
      return [...ids];
    };
    const reuseUnitIds = list(value.reuseUnitIds, 'reuse');
    const rerunUnitIds = list(value.rerunUnitIds, 'rerun');
    const reuse = new Set(reuseUnitIds);
    workflowAssert(!rerunUnitIds.some(id => reuse.has(id)), 'Recovery selection overlap');
    return { reuseUnitIds, rerunUnitIds };
  };
  const currentRecoverySnapshot = (run: WorkflowRun) => {
    const current = container.read();
    const requiredAgentIds = Object.keys(run.agents).sort();
    const agents: Record<string, ClankersAgentDefinition | null> = {};
    const mismatches: string[] = [];
    for (const id of requiredAgentIds) {
      const source = current.agentDefinitions?.[id];
      if (!source) { agents[id] = null; mismatches.push(`missing-agent:${id}`); continue; }
      try {
        const normalized = normalizeWorkflowAgent(source);
        agents[id] = normalized;
        if (workflowHash(normalized) !== workflowHash(run.agents[id])) mismatches.push(`agent-definition-drift:${id}`);
      } catch { agents[id] = null; mismatches.push(`invalid-agent:${id}`); }
    }
    const definition = state.definitions.find(d => d.id === run.definition.id) ?? null;
    if (!definition || workflowHash(definition) !== run.definitionHash) mismatches.push('definition-drift');
    if (run.definition.authoring) {
      try { assertWorkflowAuthoringCompatibility(run.definition.authoring); }
      catch { mismatches.push('authoring-migration-required'); }
    }
    const declaredPolicy = { definitionHash: run.definitionHash, frozenAgentsHash: workflowHash(run.agents), trustedRecoveryConfig: trustedRecoveryConfig ?? null };
    const profiles: Record<string, string | null> = {};
    for (const { spec } of workflowStepEntries(run)) if (spec.coding?.operation === 'check' && spec.coding.checkProfileId) {
      const id = spec.coding.checkProfileId;
      try {
        const trusted = codingCfg?.checkProfiles?.[id];
        profiles[id] = profileHash(trusted);
        const policy = validateCodingPolicy(spec.coding.policy as import('./workflow-coding.js').WorkflowCodingPolicy);
        const approved = policy.checkProfiles?.find(profile => profile.id === id);
        if (!approved) mismatches.push(`missing-approved-check-profile:${id}`);
        else {
          const expected = { id: approved.id, executable: approved.executable, argv: approved.argv, cwd: approved.cwd, env: approved.env ?? {}, timeoutMs: approved.timeoutMs, outputBytes: resolveCodingBounds(policy).maxOutputBytes, generatedOutputs: [] };
          const current = { ...(trusted as Record<string, unknown>), outputBytes: resolveCodingBounds(policy).maxOutputBytes, generatedOutputs: (trusted as Record<string, unknown>).generatedOutputs ?? [] };
          if (workflowHash(expected) !== workflowHash(current)) mismatches.push(`check-profile-policy-drift:${id}`);
        }
      }
      catch { profiles[id] = null; mismatches.push(`missing-or-invalid-check-profile:${id}`); }
    }
    const currentConfig = { concurrency: run.concurrency, recoveryEnabled, sourceContract: recoverySourceContract, ...(run.definition.authoring ? { authoringCompatibility: { formatVersion: WORKFLOW_SCRIPT_FORMAT_VERSION, languageVersion: WORKFLOW_SCRIPT_LANGUAGE_VERSION, compilerVersion: WORKFLOW_SCRIPT_COMPILER_VERSION, parserVersion: WORKFLOW_SCRIPT_PARSER_VERSION } } : {}), coding: codingCfg ?? null, profiles, unsupportedSourceConfig: options.recovery?.sourceConfig !== undefined || options.recovery?.identityVersionHash !== undefined };
    return { declaredPolicyHash: workflowHash(declaredPolicy), currentAgentsHash: workflowHash(agents), currentConfigHash: workflowHash(currentConfig), namespaceHash: workflowHash(current.extensions[WORKFLOW_EXTENSION_KEY] ?? null), mode: { automation: current.mode.automation ?? null, controller: current.mode.controller ?? null, readOnly: current.mode.readOnly ?? null, contextId: current.mode.contextId ?? null, interventionEnabled: current.mode.interventionEnabled ?? null }, lifecycle: current.lifecycle ?? null, requiredAgentIds, mismatches };
  };

  const safePathUnder = (child: string, parent: string): boolean => {
    if (process.platform === 'win32' || typeof child !== 'string' || typeof parent !== 'string' || !isAbsolute(child) || !isAbsolute(parent)) return false;
    try {
      const parentAbs = realpathSync(parent);
      const childParentAbs = realpathSync(resolve(child, '..'));
      if (lstatSync(parentAbs).isSymbolicLink() || lstatSync(childParentAbs).isSymbolicLink()) return false;
      const rel = relative(parentAbs, resolve(child));
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
    } catch { return false; }
  };
  const noUndefined = <T>(value: T): T => workflowJson(value, WORKFLOW_LIMITS.ledgerBytes) as T;
  const trustedCodingScope = (spec: WorkflowStep): { inputPaths: string[]; writablePaths: string[]; allowedPaths: string[]; error?: string } => {
    try {
      const policy = validateCodingPolicy(spec.coding!.policy as import('./workflow-coding.js').WorkflowCodingPolicy);
      const inputPaths = [...new Set([...(policy.scope.readonlyPaths ?? []), ...policy.scope.writablePaths])];
      const writablePolicy = [...policy.scope.writablePaths];
      const hostWritable = [...(codingCfg?.writablePaths ?? writablePolicy)];
      if (hostWritable.some(path => !writablePolicy.includes(path))) return { inputPaths, writablePaths: hostWritable.slice(), allowedPaths: [...new Set([...inputPaths, ...hostWritable])], error: 'trusted-writable-scope-current-host-mismatch' };
      return { inputPaths, writablePaths: hostWritable.slice(), allowedPaths: [...new Set([...inputPaths, ...hostWritable])] };
    } catch (error) { return { inputPaths: [], writablePaths: [], allowedPaths: [], error: `trusted-coding-policy-invalid:${errorText(error)}` }; }
  };
  const asRecord = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const observeNativeSettlement = (run: WorkflowRun, unit: WorkflowUnit, op: import('./workflow-recovery.js').RecoveryOperationV1) => {
    if (op.result?.cleanup === 'settled') return true;
    if (!options.recovery?.inspectNativeSettlement) return false;
    const request = freezeWorkflowData({ workflowRunId: run.workflowRunId, familyId: run.familyId, unitId: unit.id, operationId: op.id, native: unit.native ?? null, inputHash: op.inputHash, dependencyHash: op.dependencyHash, policyHash: op.policyHash });
    return options.recovery.inspectNativeSettlement(request) === 'settled';
  };
  const settledAncestor = (run: WorkflowRun): boolean => {
    if (run.cleanupSettled) return true;
    if (!run.recovery || !run.recovered) return false;
    const entries = workflowStepEntries(run);
    const localApplicationSettled = (): boolean => {
      if (!codingCfg) return false;
      const manifests = entries.flatMap(e => e.step.units).map(u => asRecord(asRecord(u.coding?.workspace)?.recoveryManifest)).filter((m): m is Record<string, unknown> => !!m);
      const manifest = manifests.at(-1);
      const owner = asRecord(manifest?.ownerEvidence);
      if (!manifest || !owner || recoveryPort?.inspectPreviousOwner?.(owner as unknown as WorkflowRecoveryWriterOwnerEvidence) !== 'dead') return false;
      const spec = entries.find(e => e.spec.kind === 'coding')?.spec;
      if (!spec) return false;
      const scope = trustedCodingScope(spec);
      if (scope.error) return false;
      const inspection = inspectRetainedCodingWorkspaceManifest(manifest, { projectRoot: codingCfg.projectRoot, stagingParent: codingCfg.stagingParent, workflowRunId: run.workflowRunId, allowedPaths: scope.allowedPaths });
      if (inspection.status !== 'safe' || inspection.readonlyObservations.some(ro => !ro.safe) || inspection.classifications.some(c => c.class !== 'preimage' && c.class !== 'postimage')) return false;
      // Only managed local application uncertainty can be settled from these current exact
      // observations. This cannot settle an unknown native/check/lease descendant or stage edit.
      return run.recovery!.operations.filter(op => op.kind === 'application' && (!op.result || op.result.cleanup === 'uncertain')).every(op => op.generation === manifest.ownerGeneration && op.paths.every(path => inspection.classifications.some(c => c.path === path)));
    };
    return run.recovery.operations.every(op => {
      if (op.result?.cleanup === 'settled' || op.result?.cleanup === 'not-required') return true;
      const unit = entries.flatMap(e => e.step.units).find(u => u.id === op.unitId);
      if (unit && (op.kind === 'native' || op.kind === 'review')) return observeNativeSettlement(run, unit, op);
      return (op.kind === 'application' || op.kind === 'application-gate') && localApplicationSettled();
    });
  };
  let recoveryAssessmentChecks: Array<() => boolean> = [];
  const recoveryAssessment = (run: WorkflowRun, assessmentMode: 'inspect' | 'prepare', selections?: unknown, signal?: AbortSignal, transition?: { acquired: WorkflowRecoveryWriterOwnerEvidence; previousInspection: Record<string, unknown>; afterCallback: () => void }) => {
    workflowAssert(!disposed, 'Workflow service disposed');
    workflowAssert(!signal?.aborted, 'Caller already cancelled');
    if (initialized) ledgerCurrent(); else workflowAssert(owners.get(container) === owner, 'Workflow ledger ownership lost');
    const selected = normalizeRecoverySelections(selections);
    const checkpoint = run.recovery;
    const checkpointHash = checkpoint ? workflowHash(checkpoint) : null;
    const checkpointSummary = checkpoint ? { version: checkpoint.version, sequence: checkpoint.sequence, operationCount: checkpoint.operations.length, budget: checkpoint.budget, workflowRunId: checkpoint.workflowRunId, familyId: checkpoint.familyId, attemptNo: checkpoint.attemptNo, definitionHash: checkpoint.definitionHash, inputsHash: checkpoint.inputsHash, policyHash: checkpoint.policyHash, configurationHash: checkpoint.configurationHash } : null;
    const currentBefore = currentRecoverySnapshot(run);
    const inspectedOwner = recoveryPort ? recoveryPort.inspectOwner() : { unsupported: true };
    transition?.afterCallback();
    const observedOwnerInspection = Object.fromEntries(Object.entries(inspectedOwner).filter(([, value]) => value !== undefined));
    // Only the exact acquired owner token may change during this private transition.
    // Everything else (including actual/expected snapshot head and lock paths) remains bound.
    if (transition) {
      workflowAssert(acquiredOwnerMatches(observedOwnerInspection.owner, transition.acquired), 'Recovery acquired owner changed');
      const withoutToken = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'owner'));
      workflowAssert(workflowHash(withoutToken(observedOwnerInspection)) === workflowHash(withoutToken(transition.previousInspection)), 'Recovery head or ownership namespace changed');
    }
    const ownerInspection = transition ? transition.previousInspection : observedOwnerInspection;
    workflowAssert(!signal?.aborted, 'Caller cancelled recovery assessment');
    if (initialized) ledgerCurrent(); else workflowAssert(owners.get(container) === owner, 'Workflow ledger ownership lost');
    let currentAfter = currentRecoverySnapshot(run);
    const blocked: string[] = [];
    if (!recoveryEnabled || !recoveryPort) blocked.push('durable-recovery-owner-port-not-configured-inspect-only');
    if (run.definition.steps.flatMap(s => s.body ?? [s]).some(s => s.kind === 'coding') && (!codingCfg?.projectRoot || !codingCfg.stagingParent)) blocked.push('artifact-assessment-unavailable: trusted coding projectRoot/stagingParent required for retained artifact assessment');
    const ownerRecord = ownerInspection as { blocker?: string; claimPresent?: boolean; ownerValid?: boolean; owner?: unknown; unsupported?: boolean };
    if (ownerRecord.unsupported) blocked.push('owner-inspection-unsupported-current-source');
    if (ownerRecord.blocker) blocked.push(`owner:${ownerRecord.blocker}`);
    if (ownerRecord.claimPresent) blocked.push('current-writer-claim-present-settlement-unknown');
    // A private acquired token is exempt from the old-owner liveness blocker, not reported dead.
    // Public inspect/prepare always performs the real liveness observation.
    if (ownerRecord.owner && !transition) {
      const previous = recoveryPort?.inspectPreviousOwner?.(ownerRecord.owner as WorkflowRecoveryWriterOwnerEvidence) ?? 'unknown';
      if (previous !== 'dead') blocked.push(`snapshot-writer-${previous}-blocks-continuation`);
    }
    if (run.supersededBy || state.runs.some(other => other.familyId === run.familyId && other.attemptNo > run.attemptNo)) blocked.push('source-is-not-latest-family-attempt');
    if (run.definition.steps.flatMap(s => s.body ?? [s]).some(s => s.kind === 'coding') && codingCfg?.enabled === false) blocked.push('trusted-coding-host-disabled');
    if (!checkpoint) blocked.push('source-checkpoint-missing-legacy-inspect-only');
    if (checkpoint) { const validated = validateRecoveryCheckpoint(checkpoint); workflowAssert(validated.ok, 'Invalid recovery checkpoint'); }
    if (!run.recovered || run.status !== 'needs-attention') blocked.push('source-attempt-is-not-a-recovered-interruption');
    for (const mismatch of [...currentBefore.mismatches, ...currentAfter.mismatches]) blocked.push(`current-policy:${mismatch}`);
    if (workflowHash(currentBefore) !== workflowHash(currentAfter)) blocked.push('current-source-changed-during-owner-inspection');
    const entries = workflowStepEntries(run);
    const allUnits = entries.flatMap(({ spec, step, iterationId }) => step.units.map(unit => ({ spec: qualifyWorkflowStep(spec, iterationId), step, iterationId, unit })));
    const currentDestination: Array<Record<string, unknown>> = [];
    const candidateCarry: Array<Record<string, unknown>> = [];
    const retainedWorkspaceEvidence: Array<Record<string, unknown>> = [];
    const recheckWorkspaces: Array<() => boolean> = [];
    const observedReceipts: Array<{ unitId: string; receiptHash: string }> = [];
    const latestWorkspaceByGeneration = new Map<string, Record<string, unknown>>();
    for (const { spec, unit } of allUnits) if (spec.kind === 'coding') {
      const workspace = asRecord(unit.coding?.workspace);
      const raw = asRecord(workspace?.recoveryManifest);
      const root = asRecord(workspace?.rootReady);
      if (!raw && !root) continue;
      const key = typeof (raw ?? root)!.ownerGeneration === 'string' ? (raw ?? root)!.ownerGeneration as string : `${unit.id}:unknown`;
      const rank = Math.max(-1, ...(checkpoint?.operations ?? []).filter(op => op.unitId === unit.id && op.generation === key).map(op => op.sequence));
      const previous = latestWorkspaceByGeneration.get(key);
      if (!previous || rank >= Number(previous.rank)) latestWorkspaceByGeneration.set(key, { unitId: unit.id, rank, rawManifest: raw, rootReady: root, effectObservations: workspace?.effectObservations, latestIntent: asRecord(unit.coding?.workspace as any)?.latestIntent, latestObservation: asRecord(unit.coding?.workspace as any)?.latestObservation });
    }
    // An application intent may belong to a new unit which has no manifest yet.
    // Retain the last full manifest, but never lose that newer outstanding intent.
    for (const { unit } of allUnits) {
      const workspace = asRecord(unit.coding?.workspace);
      const intent = asRecord(workspace?.latestIntent);
      if (!intent || typeof intent.generation !== 'string') continue;
      const retained = latestWorkspaceByGeneration.get(intent.generation);
      if (!retained) blocked.push(`unit:${unit.id}:intent-generation-without-retained-manifest`);
      const rank = Math.max(-1, ...(checkpoint?.operations ?? []).filter(op => op.unitId === unit.id && op.generation === intent.generation).map(op => op.sequence));
      if (retained && rank > Number(retained.rank)) latestWorkspaceByGeneration.set(intent.generation, { ...retained, unitId: unit.id, rank, latestIntent: intent, latestObservation: workspace?.latestObservation });
    }
    if (latestWorkspaceByGeneration.size > 1) blocked.push('multiple-retained-workspace-generations-require-explicit-reconciliation');
    const latestSharedWorkspace = latestWorkspaceByGeneration.size === 1 ? [...latestWorkspaceByGeneration.values()][0] : undefined;
    const units = allUnits.map(({ spec, unit }) => {
      const ops = checkpoint?.operations.filter(op => op.unitId === unit.id && op.stepId === spec.id) ?? [];
      const expected = { inputHash: unit.inputHash, dependencyHash: recoveryDependencyHash(run, spec, unit), policyHash: recoveryOperationPolicyHash(run, spec) };
      const classifications = ops.map(op => {
        const c = classifyRecoveryOperation(op, { ...expected, externalInputsKnown: false, dependencyContractVersion: 'unknown', nativeAlreadyCompleted: false });
        return { operationId: op.id, kind: op.kind, classification: c.classification, reasons: c.reasons, cleanup: op.result?.cleanup ?? 'unknown', resultStatus: op.result?.status ?? 'unknown' };
      });
      const operationClasses = [...new Set(classifications.map(c => c.kind))].sort();
      const hasCompletedInvalid = classifications.some(c => c.classification === 'completed-invalid' || c.classification === 'conflicting-history');
      const hasHistoricalApplicationGate = operationClasses.includes('application-gate');
      const hasUnknown = classifications.some(c => c.classification === 'interrupted-uncertain' || c.cleanup === 'unknown');
      let workspaceSafe = spec.kind !== 'coding';
      const workspace = asRecord(unit.coding?.workspace);
      let rawManifest = asRecord(workspace?.recoveryManifest);
      if (spec.kind === 'coding' && latestSharedWorkspace) rawManifest = asRecord(latestSharedWorkspace.rawManifest);
      const latestIntent = asRecord(latestSharedWorkspace?.latestIntent ?? workspace?.latestIntent);
      const latestObservation = asRecord(latestSharedWorkspace?.latestObservation ?? workspace?.latestObservation);
      const rootReady = latestSharedWorkspace?.rootReady ?? workspace?.rootReady;
      const interruptedStage = rootReady && (!latestIntent || (latestIntent.kind === 'stage-write' && (!latestObservation || latestObservation.sequence !== latestIntent.sequence || latestObservation.generation !== latestIntent.generation)));
      if (spec.kind === 'coding') {
        const trustedScope = trustedCodingScope(spec);
        const actualRoot = rawManifest ?? asRecord(rootReady);
        const provenanceWorkspace = allUnits.map(e => asRecord(e.unit.coding?.workspace)).find(w => asRecord(w?.continuationProvenance)?.newStageGen === actualRoot?.ownerGeneration);
        const provenance = asRecord(provenanceWorkspace?.continuationProvenance), sourceCarry = asRecord(provenanceWorkspace?.sourceCarry);
        if (run.recoveryOf && provenance) {
          const parent = state.runs.find(r => r.workflowRunId === run.recoveryOf);
          const parentManifest = parent && workflowStepEntries(parent).flatMap(e => e.step.units).map(u => asRecord(asRecord(u.coding?.workspace)?.recoveryManifest)).find(m => m?.ownerGeneration === provenance.oldStageGen);
          const observedParent = asRecord(sourceCarry?.observedManifest), partialParent = asRecord(asRecord(sourceCarry?.partialOptions)?.rootReadyEvidence);
          const sourceRoot = observedParent ?? parentManifest ?? partialParent;
          const remaining = Array.isArray(provenance.remainingPaths) ? provenance.remainingPaths as string[] : [];
          const satisfied = Array.isArray(provenance.alreadySatisfiedPaths) ? provenance.alreadySatisfiedPaths as string[] : [];
          const samePaths = sourceRoot && workflowHash([...remaining, ...satisfied].sort()) === workflowHash([...(sourceRoot.writablePaths as string[])].sort());
          const satisfiedBound = sourceRoot && actualRoot && satisfied.every(path => {
            const sourceEntry = (sourceRoot.writablePaths as string[]).includes(path)
              ? (sourceRoot.candidateEntries as Array<Record<string, unknown>> | undefined)?.find(e => e.path === path)
              : (sourceRoot.baselineEntries as Array<Record<string, unknown>> | undefined)?.find(e => e.path === path);
            const childEntry = (actualRoot.baselineEntries as Array<Record<string, unknown>> | undefined)?.find(e => e.path === path);
            return sourceEntry?.exists === true && typeof sourceEntry.sha256 === 'string' && childEntry?.sha256 === sourceEntry.sha256 && !(actualRoot.writablePaths as string[]).includes(path);
          });
          if (parent && sourceRoot && sourceCarry?.version === 1 && sourceCarry.sourceHistoryHash === sourceHistoryHash(parent) && sourceCarry.sourceWorkflowId === parent.workflowRunId && sourceRoot.workflowRunId === parent.workflowRunId && sourceRoot.ownerGeneration === provenance.oldStageGen && provenance.sourceWorkflowId === parent.workflowRunId && remaining.length > 0 && samePaths && satisfiedBound && [...remaining,...satisfied].every(p => trustedScope.writablePaths.includes(p)) && new Set([...remaining,...satisfied]).size === remaining.length+satisfied.length) {
            trustedScope.writablePaths = remaining.slice();
            trustedScope.inputPaths = [...new Set([...(sourceRoot.inputPaths as string[]), ...satisfied])];
            trustedScope.allowedPaths = [...new Set([...trustedScope.inputPaths, ...remaining])];
          } else blocked.push(`unit:${unit.id}:continuation-provenance-invalid`);
        }
        if (trustedScope.error) { workspaceSafe = false; blocked.push(`unit:${unit.id}:${trustedScope.error}`); }
        if (!rawManifest && !interruptedStage) { workspaceSafe = false; blocked.push(latestIntent ? `unit:${unit.id}:partial-workspace-intent-without-full-recoveryManifest` : `unit:${unit.id}:missing-workspace-recoveryManifest`); }
        if (interruptedStage && codingCfg?.projectRoot && codingCfg.stagingParent && !trustedScope.error) {
          const partialOptions = { rootReadyEvidence: rootReady, latestIntent, recordedManifest: rawManifest, recordedResults: latestSharedWorkspace?.effectObservations ?? workspace?.effectObservations, trustedScope: { projectRoot: codingCfg.projectRoot, stagingParent: codingCfg.stagingParent, workflowRunId: run.workflowRunId, ...trustedScope } };
          const observations = Array.isArray(partialOptions.recordedResults) ? partialOptions.recordedResults : [];
          const matchingEffects = checkpoint?.operations.filter(o => o.kind === 'stage-write' || o.kind === 'application') ?? [];
          const source = allUnits.find(e => e.unit.id === (latestSharedWorkspace?.unitId ?? unit.id));
          const boundEffect = (o: RecoveryCheckpointV1['operations'][number] | undefined, obs: Record<string, unknown>, index: number) => !!o && !!source
            && source.spec.kind === 'coding' && source.spec.coding?.operation === 'stage-write'
            && o.kind === 'stage-write' && o.generation === latestIntent?.generation && o.sequence === checkpoint?.operations.indexOf(o)
            && obs.sequence === index + 1 && obs.generation === latestIntent?.generation
            && o.unitId === source.unit.id && o.stepId === source.spec.id && o.iterationId === source.iterationId
            && o.inputHash === source.unit.inputHash && o.dependencyHash === recoveryDependencyHash(run, source.spec, source.unit) && o.policyHash === recoveryOperationPolicyHash(run, source.spec)
            && o.paths.length === 1 && o.paths[0] === obs.path && Object.keys(o.preimage ?? {}).length === 1 && Object.keys(o.postimage ?? {}).length === 1
            && o.preimage?.[obs.path as string] === obs.preimageHash && o.postimage?.[obs.path as string] === obs.postimageHash;
          // The entire ordered generation prefix must correspond one-to-one to
          // real observations, followed by exactly one pending last intent.
          const pending = matchingEffects[observations.length];
          const boundIntent = !latestIntent ? matchingEffects.length === 0 && observations.length === 0 : matchingEffects.length === observations.length + 1 && !pending?.result
            && boundEffect(pending, latestIntent, observations.length)
            && pending === checkpoint?.operations[checkpoint.operations.length - 1];
          const receiptsBound = observations.every((raw, index) => {
            const obs = asRecord(raw), o = matchingEffects[index];
            return !!obs && boundEffect(o, obs, index) && o.result?.status === 'completed' && o.result.cleanup === 'settled'
              && o.result.evidenceHash === workflowHash({ workspaceEffect: obs }) && o.result.resultHash === workflowHash({ workspaceEffect: obs });
          });
          const partial = latestIntent ? inspectPartialWorkspaceArtifacts(partialOptions) : inspectRootReadyWorkspaceArtifacts(partialOptions);
          const observationHash = workflowHash(partial);
          retainedWorkspaceEvidence.push({ unitId: unit.id, partialArtifacts: partial, observationHash });
          recheckWorkspaces.push(() => workflowHash(latestIntent ? inspectPartialWorkspaceArtifacts(partialOptions) : inspectRootReadyWorkspaceArtifacts(partialOptions)) === observationHash);
          workspaceSafe = partial.status === 'safe' && !!boundIntent && receiptsBound;
          if (!boundIntent || !receiptsBound) blocked.push(`unit:${unit.id}:partial-artifacts-checkpoint-receipt-binding-missing`);
          if (!workspaceSafe) blocked.push(...partial.blockers.map(b => `unit:${unit.id}:partial-artifacts:${b}`));
          const sourceUnit = allUnits.find(e => e.unit.id === (latestSharedWorkspace?.unitId ?? unit.id))?.unit;
          const recordedHash = sourceUnit?.coding?.candidateHash;
          const outputHash = asRecord(sourceUnit?.result)?.candidateHash;
          if (recordedHash !== undefined || outputHash !== undefined) {
            const candidate = asRecord(sourceUnit?.coding?.candidate);
            const files = Array.isArray(candidate?.files) ? candidate.files.map(asRecord) : [];
            const oldEntries = Array.isArray(rawManifest?.candidateEntries) ? rawManifest.candidateEntries.map(asRecord) : [];
            const baselines = Array.isArray(rawManifest?.baselineEntries) ? rawManifest.baselineEntries.map(asRecord) : [];
            const changedEntries = oldEntries.filter(e => e && e.sha256 !== baselines.find(b => b?.path === e.path)?.sha256);
            const valid = !!candidate && !!rawManifest && files.length === changedEntries.length && files.every((f, i) => !!f && typeof f.afterText === 'string' && f.path === changedEntries[i]?.path && f.afterHash === changedEntries[i]?.sha256 && sha256(f.afterText) === f.afterHash && f.beforeHash === baselines.find(b => b?.path === f.path)?.sha256);
            const oldHash = valid ? sha256(JSON.stringify(files.map(f => ({ path: f!.path, beforeHash: f!.beforeHash, afterHash: f!.afterHash, after: Buffer.from(f!.afterText as string, 'utf8').toString('base64') })))) : null;
            if (!valid || candidate?.candidateHash !== oldHash || (recordedHash !== undefined && recordedHash !== oldHash) || (outputHash !== undefined && outputHash !== oldHash)) {
              workspaceSafe = false; blocked.push(`unit:${unit.id}:historical-candidate-hash-mismatch-or-proof-missing`);
            }
          }
          const previousOwner = asRecord(rootReady)?.ownerEvidence;
          const ownerState = previousOwner ? recoveryPort?.inspectPreviousOwner?.(previousOwner as WorkflowRecoveryWriterOwnerEvidence) ?? 'unknown' : 'unknown';
          transition?.afterCallback();
          if (ownerState !== 'dead') { workspaceSafe = false; blocked.push(`unit:${unit.id}:previous-workspace-owner-${ownerState}`); }
          if (partial.observedManifest) {
            const i = inspectRetainedCodingWorkspaceManifest(partial.observedManifest, partialOptions.trustedScope);
            for (const c of i.classifications) currentDestination.push(noUndefined({ unitId: unit.id, path: c.path, recordedApplication: c.recordedApplication, writerAttribution: 'not-established', status: c.class === 'preimage' ? 'preimage' : c.class === 'postimage' ? 'postimage' : 'unknown' }));
          } else if (partial.status === 'safe' && partial.mode === 'fresh-reconstruction-only') {
            for (const path of trustedScope.writablePaths) currentDestination.push({ unitId: unit.id, path, recordedApplication: 'none', writerAttribution: 'not-established', status: 'preimage' });
          }
          candidateCarry.push({ unitId: unit.id, sourceUnitId: sourceUnit?.id ?? unit.id, state: workspaceSafe ? partial.mode : 'blocked', candidateHash: partial.observedCandidate?.candidateHash ?? null, observedCandidate: partial.observedCandidate ?? null, historicalCompletion: false, observationHash });
        } else if (rawManifest && codingCfg?.projectRoot && codingCfg.stagingParent && !trustedScope.error) {
          if (rawManifest.workflowRunId !== run.workflowRunId) { workspaceSafe = false; blocked.push(`unit:${unit.id}:manifest-workflowRunId-not-source-attempt`); }
          if (JSON.stringify([...(Array.isArray(rawManifest.writablePaths) ? rawManifest.writablePaths : [])].sort()) !== JSON.stringify([...trustedScope.writablePaths].sort())) { workspaceSafe = false; blocked.push(`unit:${unit.id}:manifest-writable-scope-mismatch`); }
          const manifestPaths = trustedScope.allowedPaths;
          const inspection = inspectRetainedCodingWorkspaceManifest(rawManifest, { projectRoot: codingCfg.projectRoot, stagingParent: codingCfg.stagingParent, workflowRunId: run.workflowRunId, allowedPaths: manifestPaths }) as ReturnType<typeof inspectRetainedCodingWorkspaceManifest> & { candidateHash?: string };
          const interruptedCandidate = latestIntent && (!latestObservation || latestObservation.generation !== latestIntent.generation || latestObservation.sequence !== latestIntent.sequence || latestObservation.path !== latestIntent.path || latestObservation.stageRoot !== latestIntent.stageRoot || latestObservation.markerPath !== latestIntent.markerPath || latestObservation.markerOwner !== latestIntent.markerOwner);
          retainedWorkspaceEvidence.push({ unitId: unit.id, status: inspection.status, settlement: inspection.settlement, error: inspection.error ?? null, ...(interruptedCandidate ? { interruptedCandidateEvidence: { generation: latestIntent.generation, sequence: latestIntent.sequence, path: latestIntent.path, kind: latestIntent.kind, stageRoot: latestIntent.stageRoot, markerPath: latestIntent.markerPath, markerOwner: latestIntent.markerOwner } } : {}), observationHash: workflowHash({ classifications: inspection.classifications, readonlyObservations: inspection.readonlyObservations, recordedOutcome: inspection.recordedOutcome, latestIntent: latestIntent ?? null, latestObservation: latestObservation ?? null }) });
          const observed = workflowHash(inspection);
          recheckWorkspaces.push(() => workflowHash(inspectRetainedCodingWorkspaceManifest(rawManifest, { projectRoot: codingCfg.projectRoot, stagingParent: codingCfg.stagingParent, workflowRunId: run.workflowRunId, allowedPaths: manifestPaths })) === observed);
          // This reconciles current bytes only. Original receipts stay untouched;
          // any missing result stays unverified. A postimage does not identify its writer.
          const manifest = inspection.manifest;
          const intentSource = allUnits.find(entry => entry.unit.id === latestSharedWorkspace?.unitId);
          const applicationOp = checkpoint?.operations.at(-1);
          const applications = checkpoint?.operations.filter(op => op.kind === 'application') ?? [];
          const outstandingApplications = applications.filter(op => !op.result || op.result.status === 'uncertain');
          const lastApplicationUnverified = !applicationOp?.result || applicationOp.result.status === 'uncertain';
          const intentPath = typeof latestIntent?.path === 'string' ? latestIntent.path : '';
          const baselineEntry = manifest?.baselineEntries.find(entry => entry.path === intentPath);
          const candidateEntry = manifest?.candidateEntries.find(entry => entry.path === intentPath);
          const equal = (a: unknown, b: unknown) => workflowHash(a ?? null) === workflowHash(b ?? null);
          // afterEffect durably saves its observation/CP result before the workspace
          // appends that record. Bind the one-record lag to the original receipt;
          // never patch the retained manifest or manufacture a completed result.
          const applicationPrefixSafe = (() => {
            if (inspection.status !== 'safe' || !manifest || !latestIntent || !checkpoint || !intentSource) return false;
            const effectOps = checkpoint.operations.filter(op => op.kind === 'stage-write' || op.kind === 'application');
            if (effectOps.length > 512 || effectOps.at(-1) !== applicationOp
              || effectOps.some(op => op.generation !== manifest.ownerGeneration)) return false;
            const records = manifest.effects;
            if (records.some((record, index) => record.sequence !== index + 1)) return false;
            const lag = effectOps.length - (lastApplicationUnverified ? 1 : 0) - records.length;
            if (lag !== 0 && lag !== 1) return false;
            const observationOf = (record: typeof records[number]) => {
              const { beforeCalled, afterSaved, recordedAt, ...observation } = record;
              return observation;
            };
            if (lag === 0 && latestObservation && !equal(latestObservation, records.length ? observationOf(records[records.length - 1]) : null)) return false;
            if (lag === 1 && (!latestObservation || latestObservation.kind !== 'destination-write')) return false;
            const known = [...records.map(observationOf), ...(lag === 1 ? [latestObservation!] : [])];
            if (records.some(record => !record.beforeCalled || !record.afterSaved)) return false;
            if (latestIntent.sequence !== known.length + (lastApplicationUnverified ? 1 : 0)) return false;
            if (!lastApplicationUnverified) {
              if (!latestObservation) return false;
              const { status, error, observedPostimageHash, ...observedIntent } = latestObservation;
              if (!equal(latestIntent, observedIntent)) return false;
            }
            const applicationPaths: string[] = [];
            for (let index = 0; index < known.length; index++) {
              const observation = known[index], op = effectOps[index];
              const source = allUnits.find(entry => entry.unit.id === op.unitId && entry.spec.id === op.stepId);
              if (!source || typeof observation.path !== 'string' || observation.sequence !== index + 1 || observation.status !== 'observed' || observation.error !== undefined
                || observation.observedPostimageHash !== observation.postimageHash
                || observation.generation !== manifest.ownerGeneration || observation.workflowRunId !== run.workflowRunId
                || !['projectRoot', 'stageRoot', 'stageRootIdentity', 'markerPath', 'markerIdentity', 'markerOwner', 'ownerEvidence'].every(key => equal((observation as any)[key], (manifest as any)[key]))
                || !equal(op.paths, [observation.path]) || !equal(op.preimage, { [observation.path]: observation.preimageHash })
                || !equal(op.postimage, { [observation.path]: observation.postimageHash })
                || op.inputHash !== source.unit.inputHash || op.dependencyHash !== recoveryDependencyHash(run, source.spec, source.unit)
                || op.policyHash !== recoveryOperationPolicyHash(run, source.spec)
                || op.result?.status !== 'completed' || op.result.cleanup !== 'settled'
                || op.result.evidenceHash !== workflowHash({ workspaceEffect: observation })
                || op.result.resultHash !== workflowHash({ workspaceEffect: observation })) return false;
              if (observation.kind === 'destination-write') {
                const baseline = manifest.baselineEntries.find(entry => entry.path === observation.path);
                const candidate = manifest.candidateEntries.find(entry => entry.path === observation.path);
                if (op.kind !== 'application' || source !== intentSource || source.spec.coding?.operation !== 'apply'
                  || !trustedScope.writablePaths.includes(observation.path) || !baseline || !candidate
                  || observation.preimageHash !== baseline.sha256 || observation.postimageHash !== candidate.sha256
                  || baseline.sha256 === candidate.sha256 || observation.candidateHash !== inspection.candidateHash) return false;
                applicationPaths.push(observation.path);
              } else if (observation.kind !== 'stage-write' || op.kind !== 'stage-write' || applicationPaths.length > 0) return false;
            }
            // Destination application is a sorted, duplicate-free prefix of the
            // changed candidate. Other postimages remain observations, not receipts.
            const changedPaths = manifest.candidateEntries.filter(entry => entry.sha256 !== manifest.baselineEntries.find(base => base.path === entry.path)?.sha256).map(entry => entry.path).sort();
            if (lastApplicationUnverified) applicationPaths.push(intentPath);
            return applicationPaths.length > 0 && equal(applicationPaths, changedPaths.slice(0, applicationPaths.length));
          })();
          const reconciledApplication = !!(latestIntent && manifest && inspection.status === 'safe' && applicationPrefixSafe
            && (lastApplicationUnverified ? interruptedCandidate : !interruptedCandidate)
            && checkpoint?.workflowRunId === run.workflowRunId && checkpoint.familyId === run.familyId && checkpoint.attemptNo === run.attemptNo
            && checkpoint.definitionHash === run.definitionHash && checkpoint.inputsHash === workflowHash(run.inputs)
            && outstandingApplications.length === (lastApplicationUnverified ? 1 : 0)
            && latestIntent.kind === 'destination-write' && intentSource?.spec.coding?.operation === 'apply'
            && applicationOp?.kind === 'application' && applicationOp.unitId === intentSource.unit.id && applicationOp.stepId === intentSource.spec.id
            && applicationOp.inputHash === intentSource.unit.inputHash
            && applicationOp.dependencyHash === recoveryDependencyHash(run, intentSource.spec, intentSource.unit)
            && applicationOp.policyHash === recoveryOperationPolicyHash(run, intentSource.spec)
            && (!applicationOp.result || applicationOp.result.status === 'uncertain' || applicationOp.result.status === 'completed')
            && equal(applicationOp.paths, [intentPath]) && applicationOp.generation === manifest.ownerGeneration
            && latestIntent.generation === manifest.ownerGeneration && latestIntent.workflowRunId === run.workflowRunId
            && ['projectRoot', 'stageRoot', 'stageRootIdentity', 'markerPath', 'markerIdentity', 'markerOwner', 'ownerEvidence'].every(key => equal(latestIntent[key], (manifest as any)[key]))
            && !!manifest.ownerEvidence && ['bootId', 'pid', 'startTimeTicks', 'writerSessionId', 'generation'].every(key => equal((manifest.ownerEvidence as any)[key], asRecord(ownerRecord.owner)?.[key]))
            && trustedScope.writablePaths.includes(intentPath) && baselineEntry && candidateEntry
            && latestIntent.preimageHash === baselineEntry.sha256 && latestIntent.postimageHash === candidateEntry.sha256
            && equal(applicationOp.preimage, { [intentPath]: baselineEntry.sha256 }) && equal(applicationOp.postimage, { [intentPath]: candidateEntry.sha256 })
            && typeof inspection.candidateHash === 'string' && latestIntent.candidateHash === inspection.candidateHash
            && intentSource.unit.coding?.candidateHash === inspection.candidateHash
            && inspection.classifications.every(c => c.class === 'preimage' || c.class === 'postimage'));
          workspaceSafe = inspection.status === 'safe' && ((!interruptedCandidate && applications.length === 0) || reconciledApplication);
          if ((interruptedCandidate || applications.length > 0) && !reconciledApplication) blocked.push(`unit:${unit.id}:partial-evidence-lastIntent-without-matchingObservation-preserved-bytes-readonly-prepare-blocked`);
          if (!workspaceSafe) blocked.push(`unit:${unit.id}:retained-workspace-unsafe:${inspection.error ?? 'unknown'}`);
          if (inspection.manifest?.ownerEvidence) {
            const priorOwner = recoveryPort?.inspectPreviousOwner?.(inspection.manifest.ownerEvidence as WorkflowRecoveryWriterOwnerEvidence) ?? 'unknown';
            transition?.afterCallback();
            if (priorOwner !== 'dead') { workspaceSafe = false; blocked.push(`unit:${unit.id}:previous-workspace-owner-${priorOwner}-blocks-settlement`); }
          } else { workspaceSafe = false; blocked.push(`unit:${unit.id}:retained-workspace-ownerEvidence-missing`); }
          for (const ro of inspection.readonlyObservations) if (!ro.safe) { workspaceSafe = false; blocked.push(`unit:${unit.id}:readonly-input-changed:${ro.path}`); }
          for (const c of inspection.classifications) currentDestination.push(noUndefined({ unitId: unit.id, path: c.path, recordedApplication: c.recordedApplication, writerAttribution: 'not-established', status: c.class === 'postimage' ? 'postimage' : c.class === 'preimage' ? 'preimage' : c.class === 'conflict' ? 'conflict' : 'unknown', ...((c as any).reason !== undefined ? { reason: (c as any).reason } : {}) }));
          const sourceUnit = allUnits.find(entry => entry.unit.id === (latestSharedWorkspace?.unitId ?? unit.id))?.unit;
          const recordedCandidateHash = sourceUnit?.coding?.candidateHash;
          const recordedOutputCandidateHash = asRecord(sourceUnit?.result)?.candidateHash;
          if ((recordedCandidateHash && recordedCandidateHash !== inspection.candidateHash) || (recordedOutputCandidateHash !== undefined && recordedOutputCandidateHash !== inspection.candidateHash)) {
            workspaceSafe = false;
            blocked.push(`unit:${unit.id}:latest-recorded-candidate-hash-mismatch`);
          }
          candidateCarry.push({ unitId: unit.id, sourceUnitId: sourceUnit?.id ?? unit.id, state: workspaceSafe ? 'reusable-candidate-carry-only' : 'blocked', candidateHash: inspection.candidateHash ?? null, recordedCandidateHash: recordedCandidateHash ?? null, paths: manifestPaths, ...(reconciledApplication ? { applicationObservation: { alreadySatisfiedPaths: inspection.classifications.filter(c => c.class === 'postimage').map(c => c.path), remainingPreimagePaths: inspection.classifications.filter(c => c.class === 'preimage').map(c => c.path), originalResultStatus: applicationOp?.result?.status ?? 'missing', writerAttribution: 'not-established' } } : {}), observationHash: retainedWorkspaceEvidence[retainedWorkspaceEvidence.length - 1]?.observationHash });
        }
      }
      let observedCheckSettled = false;
      const durable = asRecord(asRecord(unit.coding?.evidence)?.durableCheck);
      if (durable) {
        const cfg = asRecord(durable.config), intent = asRecord(durable.intent), ready = asRecord(durable.ready);
        const receiptParent = codingCfg?.receiptParent ?? codingCfg?.stagingParent;
        if (!cfg || !intent || !ready) blocked.push(`unit:${unit.id}:missing-or-malformed-durable-check-config-intent-ready`);
        else if (cfg.candidateId !== workflowHash({ version: 1, workflowRunId: run.workflowRunId, unitId: unit.id, candidateHash: unit.coding?.candidateHash ?? null }) || intent.candidateId !== cfg.candidateId) blocked.push(`unit:${unit.id}:check-receipt-logical-unit-binding-mismatch`);
        else if (!receiptParent || !safePathUnder(String(cfg.receiptDir ?? ''), receiptParent)) blocked.push(`unit:${unit.id}:durable-check-receiptDir-outside-trusted-parent`);
        else {
          const receipt = inspectDurableCheckReceipt({ ...(cfg as any), profileHash: String(intent.profileHash), expectedCandidateHash: String(intent.expectedCandidateHash), candidateHashBefore: String(intent.candidateHashBefore), nodeIdentity: (intent as any).nodeIdentity, supervisorIdentity: (ready as any).supervisorIdentity });
          const receiptHash = workflowHash(receipt ?? null);
          observedReceipts.push({ unitId: unit.id, receiptHash });
          recheckWorkspaces.push(() => workflowHash(inspectDurableCheckReceipt({ ...(cfg as any), profileHash: String(intent.profileHash), expectedCandidateHash: String(intent.expectedCandidateHash), candidateHashBefore: String(intent.candidateHashBefore), nodeIdentity: (intent as any).nodeIdentity, supervisorIdentity: (ready as any).supervisorIdentity }) ?? null) === receiptHash);
          if (!receipt) blocked.push(`unit:${unit.id}:durable-check-receipt-missing`);
          else if ('blocked' in receipt) blocked.push(`unit:${unit.id}:durable-check-receipt-blocked:${receipt.error}`);
          else if (receipt.profileId !== cfg.profileId || receipt.candidateId !== cfg.candidateId || receipt.profileHash !== intent.profileHash || receipt.expectedCandidateHash !== intent.expectedCandidateHash || receipt.candidateHashBefore !== intent.candidateHashBefore) blocked.push(`unit:${unit.id}:durable-check-receipt-binding-mismatch`);
          else if (receipt.commandStarted === false) {
            observedCheckSettled = true;
            classifications.push({ operationId: `durable:${unit.id}`, kind: 'check' as RecoveryOperationKind, classification: 'never-admitted', reasons: ['durable receipt proves command did not start; no command side effect'], cleanup: receipt.cleanup.outcome, resultStatus: 'failed' });
          }
          else if (receipt.commandCompleted && receipt.commandOutcome && receipt.commandOutcome.exitCode === 0 && receipt.commandOutcome.signal === null && receipt.commandOutcome.timedOut !== true && receipt.commandOutcome.cancelled !== true && (receipt.cleanup.outcome === 'ok' || receipt.cleanup.outcome === 'not_needed')) {
            classifications.push({ operationId: `durable:${unit.id}`, kind: 'check' as RecoveryOperationKind, classification: 'completed-invalid' as const, reasons: ['durable receipt shows prior command settled but no current host-versioned closed dependency contract; old result is nonreusable'], cleanup: receipt.cleanup.outcome, resultStatus: 'completed' });
            observedCheckSettled = true;
          } else if (receipt.cleanup.outcome === 'ok' || receipt.cleanup.outcome === 'not_needed') {
            observedCheckSettled = true;
            classifications.push({ operationId: `durable:${unit.id}`, kind: 'check' as RecoveryOperationKind, classification: 'known-failed-cancelled', reasons: ['prior command settled without reusable success; fresh check approval required'], cleanup: receipt.cleanup.outcome, resultStatus: 'failed' });
          } else blocked.push(`unit:${unit.id}:previous-check-settlement-unknown`);
        }
      } else if (operationClasses.includes('check')) blocked.push(`unit:${unit.id}:check-operation-lacks-durable-receipt-evidence`);
      const nativeOps = ops.filter(op => op.kind === 'native' || op.kind === 'review');
      const observedNativeSettlement = nativeOps.every(op => {
        const settled = observeNativeSettlement(run, unit, op);
        transition?.afterCallback();
        if (!op.result || op.result.cleanup === 'uncertain') recheckWorkspaces.push(() => observeNativeSettlement(run, unit, op) === settled);
        return settled;
      });
      if (!observedNativeSettlement) blocked.push(`unit:${unit.id}:previous-native-settlement-unknown`);
      const hasConflictingHistory = classifications.some(c => c.classification === 'conflicting-history');
      const reusable = classifications.some(c => c.classification === 'completed-valid') && !hasCompletedInvalid && unit.cleanupSettled && workspaceSafe && operationClasses.every(k => k !== 'native' && k !== 'check');
      const sourceProofMissing = ops.length === 0;
      const proposeFreshReadonlyNativeRerun = spec.kind === 'native' && unit.cleanupSettled && !hasUnknown && !hasConflictingHistory && (sourceProofMissing || hasCompletedInvalid);
      const observedLocalSettlement = spec.kind === 'coding' && workspaceSafe && observedNativeSettlement && (spec.coding?.operation !== 'check' || observedCheckSettled);
      const rerunnable = !reusable && observedNativeSettlement && (observedLocalSettlement || ((unit.cleanupSettled || (spec.kind === 'native' && nativeOps.length > 0 && observedNativeSettlement)) && !hasConflictingHistory));
      const safeUnitReasons = [...(unit.cleanupSettled ? ['prior-cleanup-settled'] : []), ...(proposeFreshReadonlyNativeRerun ? ['old-native-completion-not-claimed-propose-fresh-approved-rerun'] : []), ...(hasHistoricalApplicationGate ? ['application-gate-history-requires-fresh-authorization'] : []), ...(workspaceSafe && spec.kind === 'coding' ? ['retained-workspace-manifest-current-and-owner-dead'] : [])];
      const historicalLimitations = [...(unit.cleanupSettled ? [] : ['recorded-cleanup-settlement-unknown']), ...(hasUnknown ? ['recorded-check-or-operation-settlement-unknown'] : []), ...(hasCompletedInvalid && !proposeFreshReadonlyNativeRerun ? ['stored-completion-lacks-current-host-evidence'] : []), ...(ops.length ? [] : ['source-operation-proof-missing']), ...(workspaceSafe ? [] : ['retained-workspace-proof-missing-or-unsafe']), ...(hasHistoricalApplicationGate ? ['application-gate-is-historical-nonreusable-authority'] : [])];
      const unitBlockers = !reusable && !rerunnable ? ['current-evidence-does-not-support-reuse-or-fresh-rerun'] : [];
      return { unitId: unit.id, stepId: spec.id, status: unit.status, cleanupSettled: unit.cleanupSettled, originalStatus: run.recoveryOriginal?.steps.flatMap(s => s.units).find(u => u.id === unit.id)?.status ?? null, projectedStatus: unit.status, operationClasses, safeUnitReasons, classifications, observedLocalSettlement, observedNativeSettlement, reuseEligible: reusable, rerunEligible: rerunnable, proposeFreshReadonlyNativeRerun, historicalLimitations, blockers: unitBlockers };
    });
    const finalOwner = recoveryPort ? recoveryPort.inspectOwner() : { unsupported: true };
    transition?.afterCallback();
    const finalOwnerInspection = Object.fromEntries(Object.entries(finalOwner).filter(([, value]) => value !== undefined));
    if (workflowHash(finalOwnerInspection) !== workflowHash(observedOwnerInspection)) blocked.push('snapshot-owner-or-head-changed-during-assessment');
    // Finish all host callbacks before re-observing artifacts and canonical state.
    if (recheckWorkspaces.some(recheck => !recheck())) {
      blocked.push('retained-artifacts-changed-during-assessment');
      for (const carry of candidateCarry) carry.state = 'blocked';
    }
    currentAfter = currentRecoverySnapshot(run);
    workflowAssert(!disposed && !signal?.aborted && owners.get(container) === owner, 'Recovery assessment lost authority or was cancelled');
    if (initialized) ledgerCurrent();
    if (workflowHash(currentBefore) !== workflowHash(currentAfter)) blocked.push('current-source-changed-during-artifact-assessment');
    if (currentDestination.some(d => d.status === 'conflict' || d.status === 'unknown')) blocked.push('retained-destination-conflict-or-unknown-blocks-changes');
    if (units.some(unit => unit.blockers.length)) blocked.push('remaining-unit-settlement-or-input-evidence-is-unverified');
    const materialized = new Set(units.map(u => u.unitId));
    const executionAddresses = workflowRecoveryAddresses(run.definition);
    const plannedNeverAdmitted = executionAddresses.filter(address => !materialized.has(address.unitId)).map(address => ({ ...address, reason: 'bounded-potential-never-admitted', admitted: false }));
    if (executionAddresses.some(address => !selected.rerunUnitIds.includes(address.unitId))) blocked.push('unselected-required-execution-address');
    if (selected.reuseUnitIds.length) blocked.push('native-check-review-result-contract-unknown-no-completion-reuse');
    for (const ancestor of state.runs.filter(other => other !== run && !other.cleanupSettled)) {
      if (ancestor.familyId !== run.familyId || ancestor.attemptNo >= run.attemptNo || !settledAncestor(ancestor)) blocked.push(`run:${ancestor.workflowRunId}:unrelated-or-ancestor-settlement-unknown`);
      transition?.afterCallback();
    }
    const correctionUsage = checkpoint ? recoveryWriterUsage(state.runs, run) : { blocks: [], correctionsUsed: 0 };
    for (const block of correctionUsage.blocks) if (block.admittedWriters >= block.limit && executionAddresses.some(a => a.blockId === block.blockId && run.definition.steps.find(s => s.id === block.blockId)!.body!.some(s => s.coding?.operation === 'stage-write'))) blocked.push(`block:${block.blockId}:family-repeat-writer-allowance-exhausted`);
    if (correctionUsage.correctionsUsed > 96) blocked.push('cumulative-correction-checkpoint-bound-exhausted');
    const validSelectionIds = new Set(executionAddresses.map(address => address.unitId));
    const selectedUnknown = [...selected.reuseUnitIds, ...selected.rerunUnitIds].filter(id => !validSelectionIds.has(id));
    if (selectedUnknown.length) blocked.push('selection-references-unknown-unit');
    if (selected.reuseUnitIds.some(id => plannedNeverAdmitted.some(u => u.unitId === id))) blocked.push('selection-reuse-references-never-admitted-unit');
    if (selected.reuseUnitIds.some(id => !units.some(unit => unit.unitId === id && unit.reuseEligible))) blocked.push('selected-reuse-evidence-is-ineligible');
    if (selected.rerunUnitIds.some(id => !plannedNeverAdmitted.some(unit => unit.unitId === id) && !units.some(unit => unit.unitId === id && unit.rerunEligible))) blocked.push('selected-rerun-settlement-is-unverified');
    const budget = checkpoint?.budget ?? { maxAttempts: 3, maxAdmissions: 256, usedAdmissions: run.admissions, correctionsUsed: 0, attemptIds: [run.workflowRunId] };
    const remainingAdmissions = Math.max(0, budget.maxAdmissions - budget.usedAdmissions), remainingAttempts = Math.max(0, budget.maxAttempts - run.attemptNo);
    if (remainingAttempts === 0) blocked.push('family-attempt-budget-exhausted');
    if (selected.rerunUnitIds.length > remainingAdmissions) blocked.push('selection-exceeds-remaining-admission-budget');
    const projectedNodeCount = executionAddresses.length;
    if (projectedNodeCount > WORKFLOW_LIMITS.nodes || projectedNodeCount > remainingAdmissions + allUnits.length) blocked.push('bounded-potential-plan-exceeds-node-or-checkpoint-budget');
    const sourceCompleted = units.filter(u => u.originalStatus === 'completed').map(u => u.unitId), sourceFailed = units.filter(u => u.originalStatus === 'failed').map(u => u.unitId), sourceInterrupted = units.filter(u => ['running','queued','unverified'].includes(String(u.originalStatus))).map(u => u.unitId);
    const schema = { version: 1, authority: 'inspect-prepare-only', prepareIsPermission: false, actualArtifactAssessment: true, classifications: ['never-admitted','completed-valid','completed-invalid','interrupted-uncertain','known-failed-cancelled','conflicting-history'] };
    // Unknown contracts force the first-invalid frontier to zero. Source iterations remain
    // intact; rerunning the frontier still consumes the retained family's writer allowance.
    const repeatFrontiers = run.definition.steps.filter(s => s.kind === 'repeat').map(s => ({ blockId: s.id, firstInvalidIteration: 0, retainedSourceIterations: run.steps.find(step => step.id === s.id)?.iterations?.length ?? 0, reason: 'trusted-versioned-body-feedback-transition-contract-unavailable' }));
    const carryPaths = currentDestination.filter(d => d.status === 'preimage').map(d => d.path);
    if (candidateCarry.length && carryPaths.length === 0) blocked.push('fully-satisfied-zero-write-requires-current-observation-host-completion-not-implemented');
    const plan = { status: modeForAssessment(assessmentMode, blocked), ledgerOnlyProjection: false, unsupported: [], executionAddresses, recommendedSelections: { reuseUnitIds: [], rerunUnitIds: executionAddresses.map(a => a.unitId) }, repeatFrontiers, correctionUsage, effectiveScopes: { remainingWritablePaths: [...new Set(carryPaths)], alreadySatisfiedReadonlyPaths: [...new Set(currentDestination.filter(d => d.status === 'postimage').map(d => d.path))] }, admittedSelectionCount: selected.rerunUnitIds.length, boundedPotentialNeverAdmittedCount: plannedNeverAdmitted.length, freshAuthorizationsRequired: ['implementation','check','review','application'] };
    const fingerprintProjection = { schema, workflowRunId: run.workflowRunId, familyId: run.familyId, attemptNo: run.attemptNo, rawSourceCPHash: checkpointHash, sourceCPSummary: checkpointSummary, sourceFamilyHead: state.runs.filter(other => other.familyId === run.familyId).reduce((latest, other) => other.attemptNo > latest.attemptNo ? other : latest, run).workflowRunId, snapshotHead: workflowHash(container.read().extensions[WORKFLOW_EXTENSION_KEY]), current: { before: currentBefore, after: currentAfter, definitionHash: run.definitionHash, recovered: run.recovered, status: run.status, cleanupSettled: run.cleanupSettled, destination: currentDestination, candidateCarry }, ownerInspection, retainedWorkspaceEvidence, observedReceipts, units, plannedNeverAdmitted, remainingAdmissions, budget, selections: selected, blocked, plan };
    const fingerprint = workflowHash(fingerprintProjection);
    if (!transition) recoveryAssessmentChecks = [...recheckWorkspaces];
    const fingerprintParts = workflowJson({ schema, workflowRunId: run.workflowRunId, familyId: run.familyId, attemptNo: run.attemptNo, sourceCPHash: checkpointHash, sourceCPSummary: checkpointSummary, current: { before: currentBefore, after: currentAfter, destination: currentDestination }, selectionHash: workflowHash(selected), unitsHash: workflowHash(units), retainedWorkspaceEvidenceHash: workflowHash(retainedWorkspaceEvidence), plannedNeverAdmittedHash: workflowHash(plannedNeverAdmitted), remainingAdmissions, budget, blocked, plan }, WORKFLOW_LIMITS.aggregateBytes);
    return workflowJson({ schema, workflowRunId: run.workflowRunId, attemptNo: run.attemptNo, status: run.status, recovered: run.recovered, cleanupSettled: run.cleanupSettled, fingerprint, fingerprintParts, ownerInspection, plan, units, plannedNeverAdmitted, sourceOriginal: { completedUnitIds: sourceCompleted, failedUnitIds: sourceFailed, interruptedUnitIds: sourceInterrupted, status: run.recoveryOriginal?.status ?? null, cleanupSettled: run.recoveryOriginal?.cleanupSettled ?? null }, sourceCheckpoint: { present: !!checkpoint, hash: checkpointHash, summary: checkpointSummary }, current: { before: currentBefore, after: currentAfter, destination: currentDestination, retainedWorkspaceEvidence, observedReceipts }, candidateCarry, dependencyInvalidations: { conservative: true, downstreamInvalidatedUnitIds: units.filter(u => !u.reuseEligible).map(u => u.unitId) }, budget: { maxAttempts: budget.maxAttempts, maxAdmissions: budget.maxAdmissions, usedAdmissions: budget.usedAdmissions, remainingAdmissions, remainingAttempts, correctionsUsed: budget.correctionsUsed ?? 0 }, selections: selected, blocked }, WORKFLOW_LIMITS.aggregateBytes);
  };
  const modeForAssessment = (mode: 'inspect' | 'prepare', blocked: string[]) => mode === 'prepare' && blocked.length === 0 ? 'prepared' : blocked.length ? 'blocked' : 'inspect-only';

  const asWorkflowJsonRecord = (value: unknown): Record<string, unknown> => {
    workflowAssert(value && typeof value === 'object' && !Array.isArray(value), 'Invalid recovery assessment');
    return value as Record<string, unknown>;
  };
  const acquiredOwnerMatches = (owner: unknown, acquired: WorkflowRecoveryWriterOwnerEvidence | undefined) => !!owner && !!acquired && workflowHash(owner) === workflowHash(acquired) && (owner as WorkflowRecoveryWriterOwnerEvidence).generation === acquired.generation;

  const recoveryAuthorize = async (request: WorkflowTrustedRecoveryAuthorizeRequest, signal?: AbortSignal): Promise<WorkflowReply> => {
    let committed = false;
    try {
      workflowAssert(!disposed, 'Workflow service disposed');
      workflowAssert(!signal?.aborted, 'Caller already cancelled');
      workflowAssert(recoveryEnabled && recoveryPort, 'Durable recovery authorization is unavailable');
      workflowAssert(typeof recoveryPort.acquireWriter === 'function' && typeof recoveryPort.publishSnapshot === 'function', 'Recovery authorization requires acquisition-capable authoritative durable publication port');
      workflowAssert(!recoveryAuthorizationPoisoned, `Recovery authorization is poisoned after uncertain publication: ${recoveryAuthorizationPoisoned}`);
      const raw = workflowJson(request, WORKFLOW_LIMITS.definitionBytes) as unknown as WorkflowTrustedRecoveryAuthorizeRequest;
      workflowAssert(Object.keys(raw).every(k => ['workflowRunId', 'assessmentFingerprint', 'selections'].includes(k)), 'Unknown recovery authorization field');
      workflowAssert(typeof raw.workflowRunId === 'string' && typeof raw.assessmentFingerprint === 'string' && /^[a-f0-9]{64}$/.test(raw.assessmentFingerprint), 'Invalid recovery authorization request');
      if (initialized) ledgerCurrent(); else workflowAssert(owners.get(container) === owner, 'Workflow ledger ownership lost');
      const currentContainer = container.read();
      workflowAssert(!currentContainer.mode.readOnly, 'Read-only caller state blocks recovery authorization');
      const source = state.runs.find(r => r.workflowRunId === raw.workflowRunId); workflowAssert(source, 'Workflow run not found');
      const duplicate = state.runs.find(r => r.recoveryOf === source.workflowRunId);
      if (duplicate) {
        const sel = source.recovery?.selection;
        workflowAssert(sel && sel.continuationAttemptId === duplicate.workflowRunId && duplicate.recovery?.origin?.sourceAttemptId === source.workflowRunId && sel.assessmentFingerprint === raw.assessmentFingerprint && workflowHash({ reuseUnitIds: sel.reuseUnitIds, rerunUnitIds: sel.rerunUnitIds }) === workflowHash(normalizeRecoverySelections(raw.selections)), 'Competing recovery authorization already selected a child');
        return { ok: true, action: 'workflows.recovery.prepare', view: copy(workflowView(duplicate)), assessment: recoveryAssessment(source, 'prepare', raw.selections, signal) };
      }
      const assessment = asWorkflowJsonRecord(recoveryAssessment(source, 'prepare', raw.selections, signal));
      workflowAssert(assessment.fingerprint === raw.assessmentFingerprint, 'Recovery authorization fingerprint is stale');
      const plan = asWorkflowJsonRecord(assessment.plan);
      workflowAssert(plan.status === 'prepared', 'Recovery assessment is not prepared');
      workflowAssert(Array.isArray(assessment.blocked) && assessment.blocked.length === 0, 'Recovery assessment is blocked');
      workflowAssert(!signal?.aborted, 'Caller cancelled recovery authorization before durable selection');
      const selected = normalizeRecoverySelections(raw.selections);
      const budget = asWorkflowJsonRecord(assessment.budget);
      const usedAdmissions = Number(budget.usedAdmissions);
      workflowAssert(Number.isSafeInteger(usedAdmissions) && usedAdmissions <= 256, 'Recovery authorization exceeds admission budget');
      const confirmAssessment = asWorkflowJsonRecord(recoveryAssessment(source, 'prepare', raw.selections, signal));
      workflowAssert(confirmAssessment.fingerprint === raw.assessmentFingerprint && asWorkflowJsonRecord(confirmAssessment.plan).status === 'prepared', 'Recovery authorization source changed before publication');
      const inspected = recoveryPort.inspectOwner();
      workflowAssert(!inspected.blocker && !inspected.claimPresent && typeof inspected.actualSnapshotHash === 'string' && (inspected.owner === undefined || inspected.ownerValid === true), 'Recovery writer ownership is currently blocked or uncertain');
      const previousOwner = inspected.owner as WorkflowRecoveryWriterOwnerEvidence | undefined;
      if (previousOwner) workflowAssert((recoveryPort.inspectPreviousOwner?.(previousOwner) ?? 'unknown') === 'dead', 'Recovery previous writer is not verified dead');
      const previousInspection = Object.fromEntries(Object.entries(inspected).filter(([, value]) => value !== undefined));
      workflowAssert(workflowHash(previousInspection) === workflowHash(confirmAssessment.ownerInspection), 'Recovery owner or head changed before acquisition');
      const beforeAcquire = asWorkflowJsonRecord(recoveryAssessment(source, 'prepare', raw.selections, signal));
      workflowAssert(beforeAcquire.fingerprint === raw.assessmentFingerprint && !container.read().mode.readOnly, 'Recovery source changed in acquisition callbacks');
      const artifactChecks = [...recoveryAssessmentChecks];
      try {
        const acquiredRaw = recoveryPort.acquireWriter({ expectedSnapshotHash: inspected.actualSnapshotHash, ...(previousOwner ? { verifiedDeadOwner: previousOwner } : {}) });
        workflowAssert(acquiredRaw && typeof acquiredRaw === 'object' && !('then' in acquiredRaw), 'Recovery acquisition must complete synchronously');
        const acquired = ('owner' in acquiredRaw ? acquiredRaw.owner : acquiredRaw) as WorkflowRecoveryWriterOwnerEvidence;
        recoveryOwnerEvidence = freezeWorkflowData(acquired, WORKFLOW_LIMITS.definitionBytes);
      }
      catch (error) { poisonRecovery(error); throw error; }
      workflowAssert(recoveryOwnerEvidence, 'Recovery acquisition returned no owner');
      const transition = { acquired: recoveryOwnerEvidence, previousInspection, afterCallback: () => {
        // Inspect the acquired token/head after each callback, then make only local pure reads.
        // This extra inspect itself can mutate state: its result and post-callback artifacts/policy
        // are checked before returning. Do not recursively invoke another assessment here.
        const observed = Object.fromEntries(Object.entries(recoveryPort.inspectOwner()).filter(([, value]) => value !== undefined));
        workflowAssert(acquiredOwnerMatches(observed.owner, recoveryOwnerEvidence), 'Recovery acquired owner changed in callback');
        const withoutToken = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'owner'));
        workflowAssert(workflowHash(withoutToken(observed)) === workflowHash(withoutToken(previousInspection)), 'Recovery snapshot head changed in callback');
        workflowAssert(!disposed && !signal?.aborted && !container.read().mode.readOnly, 'Recovery callback lost authority or was cancelled');
        ledgerCurrent();
        workflowAssert(workflowHash(currentRecoverySnapshot(source)) === workflowHash(asWorkflowJsonRecord(confirmAssessment.current).before), 'Recovery policy or mode changed in callback');
        workflowAssert(artifactChecks.every(check => check()), 'Recovery artifacts changed in callback');
      } };
      const revalidate = () => {
        workflowAssert(!container.read().mode.readOnly, 'Read-only caller state blocks recovery authorization');
        const currentAssessment = asWorkflowJsonRecord(recoveryAssessment(source, 'prepare', raw.selections, signal, transition));
        workflowAssert(currentAssessment.fingerprint === raw.assessmentFingerprint && asWorkflowJsonRecord(currentAssessment.plan).status === 'prepared', 'Recovery authorization source changed after acquisition');
        return currentAssessment;
      };
      revalidate();
      if (initialized) ledgerCurrent(); else workflowAssert(owners.get(container) === owner, 'Workflow ledger ownership lost');
      const afterAcquireContainer = container.read();
      workflowAssert(!afterAcquireContainer.mode.readOnly, 'Read-only caller state blocks recovery authorization');
      workflowAssert(workflowHash(afterAcquireContainer.extensions[WORKFLOW_EXTENSION_KEY]) === expectedHash, 'Workflow namespace changed after writer acquisition');
      const sourceAfterAcquire = state.runs.find(r => r.workflowRunId === source.workflowRunId);
      workflowAssert(sourceAfterAcquire, 'Workflow run disappeared after writer acquisition');
      workflowAssert(!state.runs.some(r => r.recoveryOf === source.workflowRunId), 'Duplicate recovery child detected before publication');
      workflowAssert(sourceAfterAcquire.recovery && sourceAfterAcquire.recovery.selection === undefined, 'Source recovery selection already exists');
      revalidate();
      workflowAssert(state.runs.length < 16, 'Workflow run retention full; explicitly forget a terminal run');
      const workflowRunId = freshId();
      revalidate(); // idFactory is a host callback, not a trusted pure function.
      const time = now().toISOString();
      revalidate(); // The clock can mutate authority too.
      const child: WorkflowRun = { workflowRunId, familyId: source.familyId, attemptNo: source.attemptNo + 1, recoveryOf: source.workflowRunId,
        definition: sourceAfterAcquire.definition, definitionHash: sourceAfterAcquire.definitionHash, inputs: copy(sourceAfterAcquire.inputs), agents: copy(sourceAfterAcquire.agents), concurrency: sourceAfterAcquire.concurrency,
        status: 'running', createdAt: time, updatedAt: time, admissions: usedAdmissions, cleanupSettled: true, recovered: false,
        steps: sourceAfterAcquire.definition.steps.map(s => ({ id: s.id, status: 'queued' as WorkflowUnitStatus, units: [] })) };
      child.recovery = newRecoveryCheckpoint(child, usedAdmissions, sourceAfterAcquire);
      child.recovery.budget.correctionsUsed = recoveryWriterUsage(state.runs, sourceAfterAcquire).correctionsUsed;
      const selectedCaps = ['rerun-selected', ...(selected.reuseUnitIds.length ? ['reuse-completed'] : []), ...(Array.isArray(confirmAssessment.candidateCarry) && confirmAssessment.candidateCarry.length ? ['carry-artifacts'] : [])];
      child.recovery = { ...child.recovery, sequence: child.recovery.sequence + 1, origin: { sourceAttemptId: source.workflowRunId, assessmentFingerprint: raw.assessmentFingerprint, continuationAttemptId: child.workflowRunId, attemptNo: child.attemptNo, usedAdmissions, reuseUnitIds: selected.reuseUnitIds, rerunUnitIds: selected.rerunUnitIds, capabilities: selectedCaps } };
      validateRunRecovery(child);
      const sourceReservedRecovery = selectRecoveryContinuation(sourceAfterAcquire.recovery!, { sourceAttemptId: sourceAfterAcquire.workflowRunId, assessmentFingerprint: raw.assessmentFingerprint, continuationAttemptId: child.workflowRunId, attemptNo: child.attemptNo, usedAdmissions, reuseUnitIds: selected.reuseUnitIds, rerunUnitIds: selected.rerunUnitIds, capabilities: selectedCaps });
      workflowAssert(sourceReservedRecovery.ok, 'Recovery source selection validation failed');
      const sourceReserved = { ...sourceAfterAcquire, recovery: sourceReservedRecovery.value, supersededBy: child.workflowRunId };
      validateRunRecovery(sourceReserved);
      const nextRuns = state.runs.map(r => r.workflowRunId === sourceReserved.workflowRunId ? sourceReserved : r).concat(child);
      const nextWorkflowState = workflowJson({ ...state, runs: nextRuns }, WORKFLOW_LIMITS.ledgerBytes) as unknown as WorkflowState;
      const finalInspection = recoveryPort.inspectOwner();
      workflowAssert(!finalInspection.blocker && !finalInspection.claimPresent && finalInspection.ownerValid === true && acquiredOwnerMatches(finalInspection.owner, recoveryOwnerEvidence) && typeof finalInspection.actualSnapshotHash === 'string', 'Recovery writer ownership changed before publication');
      const finalAssessment = revalidate(); // Last callback observations, artifacts and canonical state before publication.
      const publicationBase = container.read();
      workflowAssert(!publicationBase.mode.readOnly && workflowHash(publicationBase.extensions[WORKFLOW_EXTENSION_KEY]) === expectedHash, 'Workflow state changed before publication');
      const nextContainerState = { ...publicationBase, extensions: { ...publicationBase.extensions, [WORKFLOW_EXTENSION_KEY]: nextWorkflowState } };
      let published = false;
      try {
        const result = recoveryPort.publishSnapshot!(nextContainerState, { expectedSnapshotHash: inspected.actualSnapshotHash });
        workflowAssert(!result || typeof result !== 'object' || !('then' in result), 'Recovery publication must complete synchronously');
        workflowAssert(workflowHash(container.read().extensions[WORKFLOW_EXTENSION_KEY]) === workflowHash(nextWorkflowState), 'Workflow ledger changed during recovery publication');
        published = true; committed = true;
        expectedHash = workflowHash(nextWorkflowState);
        state.runs.splice(0, state.runs.length, ...nextWorkflowState.runs);
        initialized = true;
        for (const listener of [...listeners]) { try { listener(list()); } catch { /* observer */ } }
      } catch (error) {
        poisonRecovery(error, nextWorkflowState);
        throw error;
      }
      workflowAssert(published, 'Recovery publication did not complete');
      const publishedChild = state.runs.find(r => r.workflowRunId === child.workflowRunId)!;
      const settledSources = new Set<string>([source.workflowRunId]);
      for (const ancestor of state.runs.filter(r => r.familyId === source.familyId && r.attemptNo < source.attemptNo)) if (settledAncestor(ancestor)) settledSources.add(ancestor.workflowRunId);
      const livePlan: Parameters<typeof liveRecoveryPlans.set>[1] = { generation: recoveryOwnerEvidence!.generation, fingerprint: raw.assessmentFingerprint, units: new Set(selected.rerunUnitIds), settledSources, settlementChecks: [], settlementObservers: [], sourceHistoryHash: sourceHistoryHash(state.runs.find(r => r.workflowRunId === source.workflowRunId)!) };
      const carries = finalAssessment.candidateCarry as Array<Record<string, unknown>>;
      if (carries?.length) {
        const sourceUnit = workflowStepEntries(sourceAfterAcquire).flatMap(e => e.step.units).find(u => u.id === carries[0].sourceUnitId);
        const sourceWorkspace = asRecord(sourceUnit?.coding?.workspace);
        const generation = asRecord(sourceWorkspace?.latestIntent)?.generation;
        const laterPartial = (finalAssessment.current as any)?.retainedWorkspaceEvidence?.find((e: any) => e.unitId === carries[0].unitId)?.partialArtifacts;
        const manifest = asRecord(laterPartial?.observedManifest) ?? asRecord(sourceWorkspace?.recoveryManifest) ?? workflowStepEntries(sourceAfterAcquire).flatMap(e => e.step.units).map(u => asRecord(asRecord(u.coding?.workspace)?.recoveryManifest)).filter(m => m && (!generation || m.ownerGeneration === generation)).at(-1);
        if (laterPartial?.mode === 'fresh-reconstruction-only') {
          const root = laterPartial.rootReady;
          // Already host/parent-partition-validated in the exact final assessment.
          // Do not widen a narrowed child's source generation back to original policy.
          const trustedScope = { inputPaths: [...root.inputPaths], writablePaths: [...root.writablePaths], allowedPaths: [...root.allowedPaths] };
          const partialOptions = { rootReadyEvidence: root, ...(sourceWorkspace?.latestIntent ? { latestIntent: sourceWorkspace.latestIntent } : {}), ...(sourceWorkspace?.recoveryManifest ? { recordedManifest: sourceWorkspace.recoveryManifest } : {}), ...(sourceWorkspace?.effectObservations ? { recordedResults: sourceWorkspace.effectObservations } : {}), trustedScope: { projectRoot: codingCfg!.projectRoot, stagingParent: codingCfg!.stagingParent, workflowRunId: source.workflowRunId, ...trustedScope } };
          workflowAssert((partialOptions.latestIntent === undefined ? inspectRootReadyWorkspaceArtifacts(partialOptions) : inspectPartialWorkspaceArtifacts(partialOptions)).status === 'safe', 'Initial partial observation changed after publication');
          livePlan.carry = { partialOptions, allowedPaths: [...root.allowedPaths], remainingPaths: [...root.writablePaths], satisfiedPaths: root.inputPaths.filter((p: string) => !root.writablePaths.includes(p) && workflowStepEntries(sourceAfterAcquire).some(e => e.spec.coding && (e.spec.coding.policy as import('./workflow-coding.js').WorkflowCodingPolicy).scope.writablePaths.includes(p))), observationHash: carries[0].observationHash as string };
        } else {
        workflowAssert(manifest, 'Selected carry manifest unavailable');
        const allowedPaths = manifest.allowedPaths as string[];
        const inspected = inspectRetainedCodingWorkspaceManifest(manifest, { projectRoot: codingCfg!.projectRoot, stagingParent: codingCfg!.stagingParent, workflowRunId: source.workflowRunId, allowedPaths });
        workflowAssert(inspected.status === 'safe', 'Selected carry observations changed after publication');
        livePlan.carry = { manifest, allowedPaths, remainingPaths: inspected.classifications.filter(c => c.class === 'preimage').map(c => c.path), satisfiedPaths: [...new Set([...inspected.classifications.filter(c => c.class === 'postimage').map(c => c.path), ...inspected.readonlyObservations.filter(ro => ro.safe && workflowStepEntries(sourceAfterAcquire).some(e => e.spec.coding && (e.spec.coding.policy as import('./workflow-coding.js').WorkflowCodingPolicy).scope.writablePaths.includes(ro.path))).map(ro => ro.path)])], observationHash: workflowHash({ classifications: inspected.classifications, readonlyObservations: inspected.readonlyObservations }) };
        }
      }
      const checkedOwners = new Set<string>();
      for (const id of settledSources) {
        const ancestor = state.runs.find(r => r.workflowRunId === id)!;
        for (const { spec: ancestorSpec, step } of workflowStepEntries(ancestor)) for (const u of step.units) {
          for (const op of ancestor.recovery?.operations.filter(o => o.unitId === u.id && (o.kind === 'native' || o.kind === 'review')) ?? []) {
            if (op.result?.cleanup !== 'settled') livePlan.settlementObservers.push(() => {
              const request = freezeWorkflowData({ workflowRunId: ancestor.workflowRunId, familyId: ancestor.familyId, unitId: u.id, operationId: op.id, native: u.native ?? null, inputHash: op.inputHash, dependencyHash: op.dependencyHash, policyHash: op.policyHash });
              const result = options.recovery?.inspectNativeSettlement?.(request) ?? 'unknown';
              workflowAssert(result === 'settled', 'Previous source native settlement changed or unknown');
              return workflowJson({ request, result });
            });
          }
          const durable = asRecord(asRecord(u.coding?.evidence)?.durableCheck);
          if (durable) {
            const config = asRecord(durable.config)!, intent = asRecord(durable.intent)!, ready = asRecord(durable.ready)!;
            const inspect = () => inspectDurableCheckReceipt({ ...(config as any), profileHash: String(intent.profileHash), expectedCandidateHash: String(intent.expectedCandidateHash), candidateHashBefore: String(intent.candidateHashBefore), nodeIdentity: (intent as any).nodeIdentity, supervisorIdentity: (ready as any).supervisorIdentity });
            const hash = workflowHash(inspect() ?? null);
            livePlan.settlementChecks.push(() => workflowHash(inspect() ?? null) === hash);
          }
          const manifest = asRecord(asRecord(u.coding?.workspace)?.recoveryManifest);
          const root = asRecord(asRecord(u.coding?.workspace)?.rootReady);
          const oldOwner = (manifest ?? root)?.ownerEvidence;
          if (oldOwner && !checkedOwners.has(workflowHash(oldOwner))) { checkedOwners.add(workflowHash(oldOwner)); livePlan.settlementObservers.push(() => {
            const result = recoveryPort?.inspectPreviousOwner?.(oldOwner as WorkflowRecoveryWriterOwnerEvidence) ?? 'unknown';
            workflowAssert(result === 'dead', 'Previous source owner settlement changed or unknown');
            return workflowJson({ owner: oldOwner, result });
          }); }
        }
      }
      if (livePlan.carry?.partialOptions) {
        const partialOptions = livePlan.carry.partialOptions;
        livePlan.settlementChecks.push(partialWorkspaceSourceFence(partialOptions));
      }
      if (livePlan.carry?.manifest) {
        const manifest = livePlan.carry.manifest;
        const scope = { projectRoot: codingCfg!.projectRoot, stagingParent: codingCfg!.stagingParent, workflowRunId: source.workflowRunId, allowedPaths: livePlan.carry.allowedPaths };
        livePlan.settlementChecks.push(() => { const i = inspectRetainedCodingWorkspaceManifest(manifest, scope); return i.status === 'safe' && i.readonlyObservations.every(o => o.safe); }); // Fresh workspace owns destination freshness; historical bytes may be refined.
      }
      settledSources.forEach(id => observedSettledSources.add(id));
      try { attachSignal(publishedChild, signal); } // Cancellation targets canonical child before live grant.
      catch (error) { poisonRecovery(error, state); throw error; }
      if (!signal?.aborted && publishedChild.status === 'running') { liveRecoveryPlans.set(publishedChild.workflowRunId, livePlan); schedule(); }
      return { ok: !signal?.aborted, action: 'workflows.recovery.prepare', ...(signal?.aborted ? { error: 'Caller cancelled after durable selection; selected child cancelled before execution' } : {}), view: copy(workflowView(publishedChild)), assessment: copy(finalAssessment) as WorkflowJson };
    } catch (error) { if (committed && !recoveryDiagnostic) poisonRecovery(error, state); return { ok: false, action: 'workflows.recovery.prepare', error: errorText(error), ...(recoveryDiagnostic ? { recoveryDiagnostic: copy(recoveryDiagnostic) } : {}) }; }
    finally { refreshActivity(); }
  };

  const makeRun = (definition: WorkflowDefinition, inputs: WorkflowJson, concurrency: number, previous?: WorkflowRun): WorkflowRun => {
    if (definition.authoring) assertWorkflowAuthoringCompatibility(definition.authoring);
    workflowAssert(state.runs.length < 16, 'Workflow run retention full; explicitly forget a terminal run');
    workflowAssert(Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 32, 'Concurrency must be integer 1..32');
    const frozenInputs = freezeWorkflowData(inputs, WORKFLOW_LIMITS.inputBytes); validateWorkflowValue(frozenInputs, definition.inputSchema);
    if (definition.id === 'read-only-review') validateReviewInputs(frozenInputs);
    const agents = freezeAgents(definition), workflowRunId = freshId(), time = now().toISOString();
    if (previous) workflowAssert(workflowHash(agents) === workflowHash(previous.agents), 'Retry frozen agent policy changed');
    const run: WorkflowRun = { workflowRunId, familyId: previous?.familyId ?? workflowRunId, attemptNo: previous ? previous.attemptNo + 1 : 1,
      ...(previous ? { retryOf: previous.workflowRunId } : {}), definition, definitionHash: workflowHash(definition), inputs: frozenInputs, agents, concurrency,
      status: 'running', createdAt: time, updatedAt: time, admissions: previous?.admissions ?? 0, cleanupSettled: true, recovered: false,
      steps: definition.steps.map(s => ({ id: s.id, status: 'queued', units: [] })) };
    if (recoveryEnabled) { recoveryOwnerEvidence = freezeWorkflowData(recoveryPort!.ensureWriter(), WORKFLOW_LIMITS.definitionBytes); assertRecoveryOwner(); run.recovery = newRecoveryCheckpoint(run, previous?.admissions ?? 0, previous); }
    validateRunRecovery(run);
    return run;
  };
  const execute = async (raw: WorkflowAction, signal?: AbortSignal): Promise<WorkflowReply> => {
    let action: WorkflowAction['action'] = 'workflows.list';
    try {
      const input = workflowJson(raw, WORKFLOW_LIMITS.definitionBytes + WORKFLOW_LIMITS.inputBytes) as unknown as WorkflowAction;
      action = input.action;
      const allowed: Record<string, string[]> = { 'workflows.list': [], 'workflows.define': ['definition'], 'workflows.show': ['definitionId', 'workflowRunId'], 'workflows.start': ['definitionId', 'inputs', 'concurrency'], 'workflows.recovery.inspect': ['workflowRunId'], 'workflows.recovery.prepare': ['workflowRunId', 'selections'] };
      const known = ['workflows.pause', 'workflows.resume', 'workflows.cancel', 'workflows.retry', 'workflows.report', 'workflows.forget'];
      workflowAssert(Object.hasOwn(allowed, action) || known.includes(action), 'Unknown workflow action');
      workflowAssert(Object.keys(input).every(k => k === 'action' || (allowed[action] ?? ['workflowRunId']).includes(k)), 'Unknown workflow action field');
      if (action === 'workflows.list') {
        // Rich internal/UI views stay intact; default tool context carries attempts, not every unit identity.
        const runs = list().map(({ correlations, steps, ...summary }) => summary);
        return { ok: true, action, runs, definitions: state.definitions.map(d => ({ id: d.id, label: d.label, stepCount: d.steps.length })), ...(recoveryDiagnostic ? { recoveryDiagnostic: copy(recoveryDiagnostic) } : {}) };
      }
      if (input.action === 'workflows.show') {
        workflowAssert(!!input.definitionId !== !!input.workflowRunId, 'Show requires exactly one identity');
        if (input.definitionId) { const definition = state.definitions.find(d => d.id === input.definitionId); workflowAssert(definition, 'Workflow definition not found'); return { ok: true, action, definition: { id: definition.id, label: definition.label, stepCount: definition.steps.length } }; }
        const run = projectedRuns().find(r => r.workflowRunId === input.workflowRunId); workflowAssert(run, 'Workflow run not found'); return { ok: true, action, view: copy(projectedView(run)) };
      }
      if (input.action === 'workflows.report') { const run = projectedRuns().find(r => r.workflowRunId === input.workflowRunId); workflowAssert(run, 'Workflow run not found'); return { ok: true, action, view: copy(projectedView(run)), ...(run.report !== undefined ? { report: copy(run.report) } : {}) }; }
      if (input.action === 'workflows.recovery.inspect' || input.action === 'workflows.recovery.prepare') {
        if (recoveryDiagnostic) {
          const run = projectedRuns().find(r => r.workflowRunId === input.workflowRunId); workflowAssert(run, 'Workflow run not found');
          return { ok: false, action, error: `Recovery authorization poisoned: ${recoveryDiagnostic.reason}`, view: copy(projectedView(run)), recoveryDiagnostic: copy(recoveryDiagnostic), assessment: workflowJson({ plan: { status: 'blocked' }, blocked: ['recovery-authorization-poisoned'], recoveryDiagnostic }, WORKFLOW_LIMITS.aggregateBytes) };
        }
        workflowAssert(!signal?.aborted, 'Caller already cancelled'); const run = state.runs.find(r => r.workflowRunId === input.workflowRunId); workflowAssert(run, 'Workflow run not found'); const assessment = recoveryAssessment(run, input.action === 'workflows.recovery.prepare' ? 'prepare' : 'inspect', input.action === 'workflows.recovery.prepare' ? input.selections : undefined, signal); workflowAssert(!signal?.aborted, 'Caller cancelled recovery assessment'); return { ok: true, action, view: copy(workflowView(run)), assessment }; }
      workflowAssert(!disposed, 'Workflow service disposed'); ledgerCurrent();
      if (input.action === 'workflows.define') {
        authority(); const definition = validateWorkflowDefinition(input.definition), index = state.definitions.findIndex(d => d.id === definition.id);
        workflowAssert(index >= 0 || state.definitions.length < 16, 'Workflow definition retention full');
        workflowAssert(!state.runs.some(r => r.definition.id === definition.id && (!terminal(r) || !r.cleanupSettled)), 'Cannot redefine an unsettled workflow');
        const definitions = [...state.definitions]; if (index >= 0) definitions[index] = definition; else definitions.push(definition);
        workflowJson({ ...state, definitions }, WORKFLOW_LIMITS.ledgerBytes); state.definitions = definitions;
        persist(); return { ok: true, action, definition: { id: definition.id, label: definition.label, stepCount: definition.steps.length } };
      }
      if (input.action === 'workflows.start') {
        if (!onStartReservation) {
          authority(); workflowAssert(!signal?.aborted, 'Caller already cancelled'); const definition = state.definitions.find(d => d.id === input.definitionId); workflowAssert(definition, 'Workflow definition not found');
          const run = makeRun(definition, input.inputs, input.concurrency ?? 8);
          workflowJson({ ...state, runs: [...state.runs, run] }, WORKFLOW_LIMITS.ledgerBytes);
          state.runs.push(run); persist(); attachSignal(run, signal); schedule(); return { ok: true, action, view: copy(workflowView(run)) };
        }
        workflowAssert(!startInProgress, 'Workflow start reservation already in progress');
        startInProgress = true;
        let selected: WorkflowRun | undefined;
        try {
          const recheck = () => { authority(selected); workflowAssert(!signal?.aborted, 'Caller cancelled during start reservation'); };
          recheck(); const definition = state.definitions.find(d => d.id === input.definitionId); workflowAssert(definition, 'Workflow definition not found');
          const run = makeRun(definition, input.inputs, input.concurrency ?? 8);
          // makeRun invokes preflight, ID and clock hooks. None is execution authority.
          recheck();
          workflowJson({ ...state, runs: [...state.runs, run] }, WORKFLOW_LIMITS.ledgerBytes);
          state.runs.push(run); selected = run; recheck();
          const existingAutomation = container.read().extensions[AUTOMATION_EXTENSION_KEY];
          const previousAutomation = existingAutomation === undefined ? undefined : validateAutomationLedger(existingAutomation, state);
          const reservation = onStartReservation(freezeWorkflowData(run, WORKFLOW_LIMITS.ledgerBytes));
          recheck();
          const automation = validateAutomationReservation(previousAutomation, reservation, run);
          recheck();
          persist(automation);
          // Publication and observers may synchronously revoke caller/owner/policy.
          recheck(); workflowAssert(run.status === 'running', 'Workflow start revoked during publication');
          attachSignal(run, signal); recheck();
          schedule(); return { ok: true, action, view: copy(workflowView(run)) };
        } catch (error) {
          if (selected) { authorityLost = true; active.forEach(a => a.controller.abort()); }
          throw error;
        } finally { startInProgress = false; }
      }
      workflowAssert('workflowRunId' in input, 'Workflow run identity required');
      const run = state.runs.find(r => r.workflowRunId === input.workflowRunId); workflowAssert(run, 'Workflow run not found');
      if (input.action === 'workflows.cancel') { cancelRun(run); return { ok: true, action, view: copy(workflowView(run)) }; }
      if (input.action === 'workflows.pause') { workflowAssert(run.status === 'running', 'Only running workflows can pause'); run.status = 'paused'; stamp(run); persist(); }
      if (input.action === 'workflows.resume') { workflowAssert(run.status === 'paused' && !run.recovered, 'Only live paused workflows can resume'); authority(run); run.status = 'running'; delete run.error; stamp(run); persist(); schedule(); }
      if (input.action === 'workflows.retry') {
        workflowAssert(!run.recoveryOf && !run.recovery?.origin, 'Linked recovery attempts require fresh trusted recovery authorization, not ordinary retry'); workflowAssert(!run.recovered, 'Recovered attempts require fresh trusted recovery authorization, not retry'); authority(run); workflowAssert(['failed', 'cancelled'].includes(run.status) && run.cleanupSettled && run.attemptNo < 3 && run.admissions < 256, 'Retry requires fully settled failed/cancelled attempt within family budget');
        workflowAssert(!run.supersededBy && !state.runs.some(r => r.familyId === run.familyId && r.attemptNo > run.attemptNo), 'Retry requires latest family attempt');
        workflowAssert(!signal?.aborted, 'Caller already cancelled');
        const next = makeRun(run.definition, run.inputs, run.concurrency, run);
        workflowJson({ ...state, runs: [...state.runs.map(r => r === run ? { ...r, supersededBy: next.workflowRunId } : r), next] }, WORKFLOW_LIMITS.ledgerBytes);
        run.supersededBy = next.workflowRunId; state.runs.push(next); persist(); attachSignal(next, signal); schedule(); return { ok: true, action, view: copy(workflowView(next)) };
      }
      if (input.action === 'workflows.forget') {
        // Do not remove an anchor, predecessor, selected child, or provenance source from a
        // recovery-enabled family. Legacy families without checkpoints keep ordinary behavior.
        const referenced = state.runs.some(other => other !== run && other.recovery && (
          other.recovery.budget.attemptIds.includes(run.workflowRunId)
          || other.retryOf === run.workflowRunId || other.recoveryOf === run.workflowRunId || other.supersededBy === run.workflowRunId
          || [other.recovery.selection, other.recovery.origin].some(link => link?.sourceAttemptId === run.workflowRunId || link?.continuationAttemptId === run.workflowRunId)
          || workflowStepEntries(other).some(({ step }) => step.units.some(unit => unit.reusedFrom?.workflowRunId === run.workflowRunId))
        ));
        workflowAssert(!referenced && !run.recovery?.selection, 'Forget would remove referenced recovery family anchor/source/selection evidence');
        authority();
        workflowAssert(terminal(run) && run.cleanupSettled, 'Forget requires terminal settled workflow');
        state.runs.splice(state.runs.indexOf(run), 1); abortListeners.get(run.workflowRunId)?.(); abortListeners.delete(run.workflowRunId); persist();
      }
      return { ok: true, action, view: copy(workflowView(run)) };
    } catch (error) { return { ok: false, action, error: errorText(error) }; }
    finally { refreshActivity(); }
  };
  if (existing === undefined) persist();
  else { expectedHash = workflowHash(container.read().extensions[WORKFLOW_EXTENSION_KEY]); initialized = true; }
  const approvals: WorkflowTrustedApprovalApi = {
    grant(id, request) { approvalEpoch++; const record = approvalRegistry.grant(id, request); schedule(); return record; },
    grantFingerprint(id, requestHash) { approvalEpoch++; const record = approvalRegistry.grantFingerprint(id, requestHash); schedule(); return record; },
    reject(id, request, reason) { approvalEpoch++; const record = approvalRegistry.reject(id, request, reason); schedule(); return record; },
    revoke(id, request, reason) { approvalEpoch++; const record = approvalRegistry.revoke(id, request, reason); schedule(); return record; },
    inspect: id => { approvalEpoch++; return approvalRegistry.inspect(id) as unknown as ReturnType<WorkflowTrustedApprovalApi['inspect']>; },
  };
  refreshActivity();
  return { activity: activityChannel.source, execute, list, get: id => { const run = projectedRuns().find(r => r.workflowRunId === id); return run ? copy(run) : undefined; }, approvals,
    ...(recoveryEnabled ? { recovery: { prepare: (workflowRunId: string, selections?: { reuseUnitIds?: string[]; rerunUnitIds?: string[] }) => execute({ action: 'workflows.recovery.prepare', workflowRunId, ...(selections !== undefined ? { selections } : {}) } as WorkflowAction), authorize: recoveryAuthorize } } : {}),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() {
      if (disposed) return; disposed = true;
      try {
      // Cleanup requests precede every observable/fallible ledger publication.
      liveRecoveryPlans.clear(); active.forEach(a => a.controller.abort()); abortListeners.forEach(remove => remove()); abortListeners.clear(); listeners.clear();
      if (owners.get(container) === owner && !authorityLost) for (const run of state.runs) if (!terminal(run)) {
        try { cancelRun(run); }
        catch (error) { authorityLost = true; run.status = 'needs-attention'; run.error = errorText(error); }
      }
      } finally { refreshActivity(); }
    },
    async drain() { await Promise.resolve(); while (pending.size) { await Promise.allSettled([...pending]); await Promise.resolve(); } workflowAssert(!onStartReservation || !authorityLost, 'Automation publication/admission is uncertain'); workflowAssert(!cleanupUncertain || state.runs.every(r => r.cleanupSettled || observedSettledSources.has(r.workflowRunId)), 'Native cleanup settlement is uncertain'); },
  };
}
