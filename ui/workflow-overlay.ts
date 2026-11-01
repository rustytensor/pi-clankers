import { Text, isKeyRelease, truncateToWidth, type Focusable } from '@earendil-works/pi-tui';
import type { StructuralPiCommandContext, StructuralPiCustomComponent, StructuralPiTuiHandle } from '../types.js';
import { workflowJson, workflowHash, workflowStepEntries, WORKFLOW_LIMITS } from '../workflow-model.js';
import type { WorkflowAction, WorkflowJson, WorkflowNativeIdentity, WorkflowRun, WorkflowService, WorkflowStepRun, WorkflowTrustedRecoveryApi, WorkflowTrustedRecoveryAuthorizeRequest, WorkflowUnit } from '../workflow-model.js';
import { sanitizeUiText, styleText, uiErrorText, visibleSlice, type UiThemeLike } from './components.js';
import { matchesKey } from './state.js';

/** Display-only provenance, never used to select or authorize an execution ID. */
function authoredLabel(run: WorkflowRun, entry?: ReturnType<typeof workflowStepEntries>[number]): string {
  const authoring = run.definition.authoring;
  if (!authoring || !entry) return '';
  const path = entry.blockId ? [entry.blockId, entry.spec.id] : [entry.spec.id];
  const matches = authoring.steps.slice(0, 16).filter(row => row.path.length === path.length && row.path.every((id, index) => id === path[index]));
  if (matches.length !== 1) return '';
  const phases = authoring.phases.slice(0, 16).filter(phase => phase.paths.slice(0, 16).some(row => row.length === path.length && row.every((id, index) => id === path[index])));
  const span = matches[0]!.span;
  return ` · authored ${clipped(path.join('/'), 161)}${phases.length === 1 ? ` · group ${clipped(phases[0]!.id, 80)}` : ''} · source ${clipped(authoring.sourceName, 128)}:${span.line}:${span.column}`;
}

export interface ZergWorkflowOverlayOptions {
  service: Pick<WorkflowService, 'list' | 'get' | 'subscribe' | 'execute' | 'approvals'>;
  /** Separate host capability, never obtained through model-facing execute actions. */
  recoveryAuthority?: WorkflowTrustedRecoveryApi;
  workflowRunId?: string;
  onOpenNative?(identity: WorkflowNativeIdentity): void | Promise<void>;
}
type RecoverySelections = { reuseUnitIds?: string[]; rerunUnitIds?: string[] };
type WorkflowControlAction = 'workflows.pause' | 'workflows.resume' | 'workflows.cancel' | 'workflows.retry';
interface RecoveryAssessmentState { kind: 'inspect' | 'prepare'; runId: string; proofIdentity: string; sourceHash: string; requestToken: number; priorLevel: ViewState['level']; requestedAt: string; reply?: Awaited<ReturnType<WorkflowService['execute']>>; error?: string; selections?: RecoverySelections }
interface RecoveryConfirmation { request: WorkflowTrustedRecoveryAuthorizeRequest; sourceHash: string; token: number }
interface ViewState { level: 'list' | 'steps' | 'iterations' | 'body' | 'units' | 'result' | 'recovery'; runId?: string; stepId?: string; blockId?: string; iterationId?: string; unitId?: string; restoredIdentity?: string; scroll: number }
interface Proof { iterationId?: string; runId: string; stepId?: string; unitId?: string; identity: string; status: WorkflowRun['status']; cleanup: boolean; selectedRunIdentity: string; listSignature: string }
interface CodingResult { native: WorkflowNativeIdentity; state: ViewState }
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f-\x9f]/u.test(value);
const cleanup = (fn?: () => void) => { try { fn?.(); } catch { /* Finish every UI cleanup stage. */ } };
const terminal = (run: WorkflowRun) => ['completed', 'failed', 'cancelled', 'needs-attention'].includes(run.status);
const nativeOf = (unit?: WorkflowUnit) => unit?.reusedFrom?.native ?? unit?.native;
function copyNative(value?: WorkflowNativeIdentity): WorkflowNativeIdentity | undefined {
  return value && validId(value.runId) && validId(value.taskId) ? { runId: value.runId, taskId: value.taskId } : undefined;
}
function identity(run: WorkflowRun, stepId?: string, unitId?: string): string {
  const entry = stepId === undefined ? undefined : workflowStepEntries(run).find(({ step }) => step.id === stepId);
  const step = entry?.step;
  const unit = unitId === undefined ? undefined : step?.units.find((row) => row.id === unitId);
  if (!validId(run.workflowRunId) || !validId(run.familyId) || !validId(run.definition.id) || !Number.isSafeInteger(run.attemptNo)
    || typeof run.definitionHash !== 'string' || run.definitionHash.length > 256 || typeof run.createdAt !== 'string' || run.createdAt.length > 64
    || (stepId !== undefined && (!validId(stepId) || !step || workflowStepEntries(run).filter(({ step }) => step.id === stepId).length !== 1))
    || (unitId !== undefined && (!validId(unitId) || !unit || unit.stepId !== stepId || typeof unit.inputHash !== 'string' || unit.inputHash.length > 256 || step!.units.filter((row) => row.id === unitId).length !== 1))) throw new Error('Invalid/ambiguous workflow identity.');
  return JSON.stringify([run.workflowRunId, run.familyId, run.attemptNo, run.retryOf, run.definition.id, run.definitionHash, run.createdAt,
    stepId, entry?.blockId, entry?.iterationId, entry?.iterationNo, unitId, unit?.inputHash, unit?.native?.runId, unit?.native?.taskId,
    unit?.reusedFrom?.workflowRunId, unit?.reusedFrom?.unitId, unit?.reusedFrom?.native.runId, unit?.reusedFrom?.native.taskId]);
}
const clipped = (value: unknown, max = 80): string => {
  const text = sanitizeUiText(typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value));
  return text.length > max ? `${text.slice(0, Math.max(0, max - 28))}… [clipped ${text.length - Math.max(0, max - 28)} chars]` : text;
};
const hash8 = (value?: string) => value ? clipped(value, 16) : 'none';
const statusWord = (value?: string) => value ? clipped(value, 24) : 'missing';
function codingApprovalLines(service: ZergWorkflowOverlayOptions['service'], approvalId?: string, limit = 2): string[] {
  if (!approvalId) return [];
  try {
    const rows = service.approvals.inspect(approvalId).slice(0, limit);
    if (!rows.length) return [`approval ${clipped(approvalId, 48)} · missing/revoked from registry`];
    return rows.map((row) => {
      const scope = (row as { scope?: Record<string, unknown>; request?: Record<string, unknown> }).scope ?? (row as { request?: Record<string, unknown> }).request ?? {};
      const fields = ['attemptKey', 'baselineHash', 'candidateHash', 'evidenceHash', 'targetHash', 'expiresAt']
        .map((key) => scope[key] ? `${key}:${hash8(String(scope[key]))}` : undefined).filter(Boolean).join(' ');
      return `approval ${clipped(row.id, 48)} · ${row.kind}/${row.status}${row.consumed ? '/consumed' : ''} · request ${hash8(row.requestHash)}${fields ? ` · ${fields}` : ''}${row.reason ? ` · ${clipped(row.reason, 80)}` : ''}`;
    }).concat(rows.length >= limit ? [`Approval detail clipped: showing ${limit}.`] : []);
  } catch (error) { return [`approval ${clipped(approvalId, 48)} · inspect unavailable: ${uiErrorText(error)}`]; }
}
function jsonRecord(value: unknown): Record<string, unknown> | undefined { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }

function jsonArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function countBy<T extends string>(values: T[]): Record<T, number> {
  return values.reduce((acc, value) => { acc[value] = (acc[value] ?? 0) + 1; return acc; }, {} as Record<T, number>);
}
function boundedJsonText(value: unknown, maxBytes = 8192): string {
  try { return JSON.stringify(workflowJson(value, maxBytes)); }
  catch (error) { return `unavailable/malformed bounded JSON: ${uiErrorText(error)}`; }
}
function assessmentLines(value: unknown): string[] {
  let safe: WorkflowJson;
  try { safe = workflowJson(value, Math.min(WORKFLOW_LIMITS.aggregateBytes, 65536)); }
  catch (error) { return [`assessment: unavailable/malformed bounded JSON: ${uiErrorText(error)}`]; }
  const root = jsonRecord(safe);
  if (!root) return ['assessment: unavailable/malformed bounded JSON'];
  const plan = jsonRecord(root.plan);
  const budget = jsonRecord(root.budget);
  const selections = jsonRecord(root.selections);
  const sourceOriginal = jsonRecord(root.sourceOriginal);
  const sourceCheckpoint = jsonRecord(root.sourceCheckpoint);
  const current = jsonRecord(root.current);
  const dependencyInvalidations = jsonRecord(root.dependencyInvalidations);
  const units = jsonArray(root.units).map(jsonRecord).filter((u): u is Record<string, unknown> => !!u);
  const blocked = jsonArray(root.blocked).map(String);
  const unitClassifications = units.flatMap((unit) => jsonArray(unit.classifications).map(jsonRecord).filter((c): c is Record<string, unknown> => !!c));
  const classes = unitClassifications.map(c => String(c.classification ?? c.kind ?? 'unknown'));
  const classCounts = countBy(classes);
  const reuseEligible = units.filter(u => u.reuseEligible === true).length;
  const rerunEligible = units.filter(u => u.rerunEligible === true).length;
  const unitBlockers = units.flatMap(u => jsonArray(u.blockers).map(b => `${String(u.unitId ?? '?')}:${String(b)}`));
  const planStatus = typeof plan?.status === 'string' ? plan.status : (blocked.length ? 'blocked' : String(root.status ?? 'unknown'));
  const lines = [
    `assessment status:${statusWord(String(root.status ?? planStatus))} · plan:${statusWord(String(planStatus))} · fingerprint:${hash8(typeof root.fingerprint === 'string' ? root.fingerprint : undefined)}`,
    `schema: ${clipped(boundedJsonText(root.schema, 1024), 160)} · read-only projection; prepare is not permission`,
    `units · total:${units.length} reuseEligible:${reuseEligible} rerunEligible:${rerunEligible} classifications:${Object.entries(classCounts).slice(0, 8).map(([k, v]) => `${clipped(k, 28)}:${v}`).join(' ') || 'none'}`,
    `budget · remainingAdmissions:${budget?.remainingAdmissions ?? 'unknown'} remainingAttempts:${budget?.remainingAttempts ?? 'unknown'} correctionsUsed:${budget?.correctionsUsed ?? 'unknown'} usedAdmissions:${budget?.usedAdmissions ?? 'unknown'} maxAdmissions:${budget?.maxAdmissions ?? 'unknown'} maxAttempts:${budget?.maxAttempts ?? 'unknown'}`,
    `source attempt · workflow:${clipped(root.workflowRunId, 48)} attempt:${root.attemptNo ?? 'unknown'} checkpoint:${sourceCheckpoint?.present === true ? 'present' : 'missing'} fp:${hash8(typeof sourceCheckpoint?.hash === 'string' ? sourceCheckpoint.hash : undefined)}`,
    `sourceOriginal · completed:${jsonArray(sourceOriginal?.completedUnitIds).length} failed:${jsonArray(sourceOriginal?.failedUnitIds).length} interrupted:${jsonArray(sourceOriginal?.interruptedUnitIds).length}`,
    `current projection · recovered:${root.recovered ?? 'unknown'} cleanup:${root.cleanupSettled ?? 'unknown'} before:${clipped(boundedJsonText(current?.before, 2048), 120)} after:${clipped(boundedJsonText(current?.after, 2048), 120)}`,
    `selections · reuse:${jsonArray(selections?.reuseUnitIds).length} rerun:${jsonArray(selections?.rerunUnitIds).length}`,
    `bounded potential execution addresses:${jsonArray(plan?.executionAddresses).length} (includes future fanout/repeat; unused addresses are not admissions)`,
    `repeat frontiers:${clipped(boundedJsonText(plan?.repeatFrontiers ?? [], 4096), 320)} · correction usage:${clipped(boundedJsonText(plan?.correctionUsage ?? null, 4096), 320)}`,
    `effective scopes:${clipped(boundedJsonText(plan?.effectiveScopes ?? null, 4096), 320)}`,
  ];
  if (blocked.length) lines.push(`blocked: ${blocked.slice(0, 8).map(v => clipped(v, 80)).join('; ')}${blocked.length > 8 ? ` [${blocked.length - 8} omitted by UI bound]` : ''}`);
  if (unitBlockers.length) lines.push(`unit blockers: ${unitBlockers.slice(0, 10).map(v => clipped(v, 80)).join('; ')}${unitBlockers.length > 10 ? ` [${unitBlockers.length - 10} omitted by UI bound]` : ''}`);
  const invalidated = jsonArray(dependencyInvalidations?.downstreamInvalidatedUnitIds);
  if (invalidated.length) lines.push(`dependency invalidations: ${invalidated.slice(0, 10).map(v => clipped(v, 48)).join(', ')}${invalidated.length > 10 ? ` [${invalidated.length - 10} omitted by UI bound]` : ''}`);
  const unitSummaries = units.slice(0, 10).map(u => `${u.unitId ?? '?'} ${u.status ?? '?'} original:${u.originalStatus ?? '?'} projected:${u.projectedStatus ?? '?'} reuse:${u.reuseEligible === true} rerun:${u.rerunEligible === true} classes:${jsonArray(u.classifications).length}`);
  if (unitSummaries.length) lines.push(...unitSummaries.map(v => `unit: ${clipped(v, 160)}`));
  if (units.length > unitSummaries.length) lines.push(`units omitted by UI bound: ${units.length - unitSummaries.length}`);
  return lines.slice(0, 48);
}

function codingSummary(unit: WorkflowUnit): string {
  const coding = unit.coding;
  if (!coding) return '';
  const result = jsonRecord(unit.result);
  const changed = Array.isArray(result?.changedPaths) ? result.changedPaths.map(String) : [];
  const applied = coding.appliedPaths ?? (Array.isArray(result?.appliedPaths) ? result.appliedPaths.map(String) : []);
  const outcome = typeof result?.status === 'string' ? ` · application:${statusWord(result.status)}${['partial','uncertain'].includes(result.status) ? '!' : ''}` : '';
  return ` · coding phase:${statusWord(coding.phase)} approval:${statusWord(coding.approvalStatus)} candidate:${hash8(coding.candidateHash ?? (typeof result?.candidateHash === 'string' ? result.candidateHash : undefined))} paths:${changed.length || applied.length}`
    + `${coding.evidenceHash ? ` checks/review:${hash8(coding.evidenceHash)}` : ' checks/review:missing'}${applied.length ? ` applied:${applied.length}` : ''}${outcome}`;
}
function codingDetailLines(unit: WorkflowUnit, service: ZergWorkflowOverlayOptions['service']): string[] {
  if (!unit.coding) return [];
  const coding = unit.coding, result = jsonRecord(unit.result);
  const changed = Array.isArray(result?.changedPaths) ? result.changedPaths.map(String) : [];
  const applied = coding.appliedPaths ?? (Array.isArray(result?.appliedPaths) ? result.appliedPaths.map(String) : []);
  const paths = changed.length ? changed : applied;
  const visible = paths.slice(0, 6).map(p => clipped(p, 72)).join(', ');
  const omitted = paths.length > 6 ? ` [${paths.length - 6} omitted]` : '';
  const lines = [
    `coding monitor · phase ${statusWord(coding.phase)} · attempt unit ${clipped(unit.id, 64)} · writer ${nativeOf(unit)?.runId ?? 'unlinked'}/${nativeOf(unit)?.taskId ?? 'unlinked'}`,
    `prepared≠checked≠reviewed≠approved≠applied · candidate ${hash8(coding.candidateHash ?? (typeof result?.candidateHash === 'string' ? result.candidateHash : undefined))} · changed/applied paths ${paths.length}: ${visible}${omitted}`,
    `freshness · checks/review evidence ${coding.evidenceHash ? hash8(coding.evidenceHash) : 'missing/stale until matching gate completes'} · approval ${statusWord(coding.approvalStatus)} · consumed ${coding.consumedApprovalId ? clipped(coding.consumedApprovalId, 48) : 'none'}`,
  ];
  if (typeof result?.status === 'string' && ['partial','uncertain','rejected'].includes(result.status)) lines.push(`application outcome requires attention: ${statusWord(result.status)} · partial/uncertain is not applied`);
  lines.push(...codingApprovalLines(service, coding.approvalId));
  return lines;
}
/** Report the recorded transition, never infer exhaustion from a generic failure. */
function repeatOutcome(step: WorkflowStepRun, recovered: boolean): string {
  if (step.status === 'unverified' || recovered || step.termination === 'recovery') return 'uncertain/unverified';
  if (step.status === 'cancelled' || step.termination === 'cancelled') return 'cancelled';
  if (step.termination === 'converged') return step.status === 'completed' ? 'converged' : 'convergence not confirmed';
  if (step.termination === 'max-iterations') return 'nonconverged (max-iterations)';
  if (step.termination === 'body-failed') return 'body-failed';
  if (step.termination === 'invalid-transition') return 'invalid-transition (schema/feedback/condition/output)';
  return step.status === 'failed' ? 'failed (termination unspecified)' : 'convergence not confirmed';
}
/** Explicit local result drill only. Bound traversal BEFORE formatting, not a context/transcript copy. */
function resultPreview(value: unknown): string {
  let budget = 3072; let nodes = 256; let clipped = false;
  const take = (text: string) => { if (text.length > budget) clipped = true; const out = text.slice(0, budget); budget -= out.length; return out; };
  const visit = (item: unknown, depth: number): string => {
    if (budget <= 0 || --nodes < 0 || depth > 8) { clipped = true; return ''; }
    if (typeof item === 'string') { if (item.length > 3072) clipped = true; return take(JSON.stringify(sanitizeUiText(item.slice(0, 3072)))); }
    if (item === null || typeof item === 'boolean' || typeof item === 'number') return take(String(item));
    if (Array.isArray(item)) {
      const pieces = [take('[')];
      for (let i = 0; i < item.length; i++) { if (budget <= 0 || nodes <= 0) { clipped = true; break; } if (i) pieces.push(take(', ')); pieces.push(visit(item[i], depth + 1)); }
      pieces.push(take(']')); return pieces.join('');
    }
    if (item && typeof item === 'object') {
      const pieces = [take('{')]; let index = 0;
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        if (budget <= 0 || nodes <= 0) { clipped = true; break; }
        if (index++) pieces.push(take(', '));
        pieces.push(take(JSON.stringify(sanitizeUiText(key)) + ': '), visit((item as Record<string, unknown>)[key], depth + 1));
      }
      pieces.push(take('}')); return pieces.join('');
    }
    return take('(no structured result)');
  };
  const text = visit(value, 0);
  return `${text}${clipped ? ' [preview clipped: 3072 chars/256 nodes/depth 8]' : ''}`;
}

/** Fresh interaction on return from the existing native coding viewer; no watcher survives drilldown. */
export async function openZergWorkflowOverlay(context: StructuralPiCommandContext, options: ZergWorkflowOverlayOptions): Promise<void> {
  if (context.hasUI === false || (context.mode !== undefined && context.mode !== 'tui') || !context.ui?.custom) throw new Error('Workflow monitor requires an interactive Pi TUI.');
  let state: ViewState | undefined; let notice = '';
  while (true) {
    let component: ZergWorkflowComponent | undefined; let result: CodingResult | undefined;
    try {
      await Promise.resolve(context.ui.custom((tui, theme, _keys, done) => {
        component?.dispose();
        component = new ZergWorkflowComponent(tui, theme as UiThemeLike | undefined, (value) => { result = value; done?.(value); }, options, state, notice);
        return component;
      }, { overlay: true, overlayOptions: { title: 'clankers workflows', anchor: 'center', width: '90%', maxHeight: '82%' } }));
    } finally { component?.dispose(); }
    if (!result || !options.onOpenNative) return;
    state = result.state; notice = '';
    try { await options.onOpenNative({ ...result.native }); }
    catch (error) { notice = `Exact coding viewer unavailable: ${uiErrorText(error)}`; }
  }
}

/** Owns UI observation only, never the workflow service or native worker lifetimes. */
export class ZergWorkflowComponent implements StructuralPiCustomComponent, Focusable {
  focused = false;
  private disposed = false;
  private unsubscribe?: () => void;
  private state: ViewState;
  private proof?: Proof;
  private rows: string[] = [];
  private notice: string;
  private observerNotice = '';
  private pending = false;
  private confirmation?: Proof;
  private recovery?: RecoveryAssessmentState;
  private displayedRecovery?: RecoveryConfirmation;
  private armedRecovery?: RecoveryConfirmation;
  private armedRecoveryRendered = false;
  private authorizingRecovery = false;
  private selectedRecoveryChild?: { sourceId: string; childId: string };
  private confirmationRendered = false;
  private rejectingPaste = false;
  private pasteTail = '';
  private viewport = 1;
  private recoveryRequestToken = 0;

  constructor(private readonly tui: StructuralPiTuiHandle | undefined, private readonly theme: UiThemeLike | undefined,
    private readonly done: ((result?: CodingResult) => void) | undefined, private readonly options: ZergWorkflowOverlayOptions,
    restored?: ViewState, notice = '') {
    if (options.workflowRunId !== undefined && !validId(options.workflowRunId)) throw new Error('Invalid exact workflow run ID.');
    this.state = restored ? { ...restored } : { level: options.workflowRunId ? 'steps' : 'list', runId: options.workflowRunId, scroll: 0 };
    this.notice = notice;
    // Nothing that can throw follows subscription acquisition. Late callbacks are always inert.
    try {
      const unsubscribe = options.service.subscribe(() => {
        if (!this.disposed) { this.displayedRecovery = undefined; this.armedRecovery = undefined; this.armedRecoveryRendered = false; this.redraw(); }
      });
      if (this.disposed) cleanup(unsubscribe); else this.unsubscribe = unsubscribe;
    } catch (error) { this.observerNotice = `Observer unavailable: ${uiErrorText(error)}`; }
  }
  invalidate(): void { /* No themed output retained in state. Last-rendered proof survives invalidation, never selection changes. */ }
  private redraw(): void {
    if (this.disposed) return;
    this.invalidate();
    try { this.tui?.requestRender?.(); } catch { this.observerNotice = 'Workflow redraw unavailable.'; }
  }
  private selectedId(): string | undefined { return this.state.level === 'list' ? this.state.runId : this.state.level === 'iterations' ? this.state.iterationId : ['steps', 'body'].includes(this.state.level) ? this.state.stepId : this.state.unitId; }
  private select(id?: string): void {
    if (this.state.level === 'list') { this.state.runId = id; this.state.stepId = this.state.unitId = undefined; }
    else if (this.state.level === 'iterations') { this.state.iterationId = id; this.state.unitId = undefined; }
    else if (['steps', 'body'].includes(this.state.level)) { this.state.stepId = id; this.state.unitId = undefined; }
    else this.state.unitId = id;
    this.displayedRecovery = undefined; this.armedRecovery = undefined; this.armedRecoveryRendered = false;
    this.state.restoredIdentity = undefined; this.state.scroll = 0; this.proof = undefined; this.recovery = undefined; this.recoveryRequestToken++; this.pending = this.authorizingRecovery;
  }
  render(width = 100, requestedHeight?: number): string[] {
    if (this.disposed) return [];
    const bound = (n: number, max: number) => Number.isFinite(n) ? Math.max(1, Math.min(max, Math.floor(n))) : 1;
    const w = bound(width, 512); const h = bound(requestedHeight ?? (this.tui?.terminal?.rows ?? 32) * 0.82, 128);
    this.proof = undefined; this.confirmationRendered = false; this.displayedRecovery = undefined; this.armedRecoveryRendered = false;
    try { return this.renderSafe(w, h); }
    catch (error) { this.rows = []; this.proof = undefined; this.displayedRecovery = undefined; this.armedRecovery = undefined; return [truncateToWidth(`Workflow view unavailable: ${uiErrorText(error)}`, w, '', true)]; }
  }
  private renderSafe(w: number, h: number): string[] {
    const views = this.options.service.list().slice(0, 16);
    const unique = (ids: string[]) => ids.filter((id) => validId(id) && ids.filter((other) => other === id).length === 1);
    if (this.state.level === 'recovery') { this.rows = []; }
    if (this.state.level === 'list') {
      this.rows = unique(views.map((view) => view.workflowRunId));
      if (this.state.runId === undefined) this.select(this.rows[0]);
    }
    const run = this.state.runId ? this.options.service.get(this.state.runId) : undefined;
    if (run && run.workflowRunId !== this.state.runId) throw new Error('Wrong workflow returned for exact ID.');
    const entries = run ? workflowStepEntries(run) : [];
    const block = run?.steps.find((row) => row.id === this.state.blockId);
    const iteration = block?.iterations?.find((row) => row.id === this.state.iterationId);
    const step = entries.find(({ step }) => step.id === this.state.stepId)?.step;
    if (this.state.level === 'steps') { this.rows = unique(run?.steps.slice(0, 16).map((row) => row.id) ?? []); if (this.state.stepId === undefined) this.select(this.rows[0]); }
    if (this.state.level === 'iterations') { this.rows = unique(block?.iterations?.slice(0, 32).map((row) => row.id) ?? []); if (this.state.iterationId === undefined) this.select(this.rows[0]); }
    if (this.state.level === 'body') { this.rows = unique(iteration?.steps.slice(0, 16).map((row) => row.id) ?? []); if (this.state.stepId === undefined) this.select(this.rows[0]); }
    if (this.state.level === 'units' || this.state.level === 'result') { this.rows = unique(step?.units.slice(0, 32).map((row) => row.id) ?? []); if (this.state.unitId === undefined) this.select(this.rows[0]); }
    const selectedEntry = entries.find(({ step }) => step.id === this.state.stepId);
    const selectedStep = selectedEntry?.step;
    if (this.state.blockId && ['body', 'units', 'result'].includes(this.state.level)
      && (selectedEntry?.blockId !== this.state.blockId || selectedEntry?.iterationId !== this.state.iterationId)) throw new Error('Exact iteration selection missing/changed; no fallback.');
    if (this.state.restoredIdentity && (!run || identity(run, this.state.stepId, this.state.unitId) !== this.state.restoredIdentity)) throw new Error('Exact coding selection changed; no fallback.');
    const unit = selectedStep?.units.find((row) => row.id === this.state.unitId);
    const status = run ? `${run.status}${!run.cleanupSettled ? ' · cleanup-pending' : ''}${run.recovered ? ' · recovered/unverified history' : ''}` : 'missing/evicted (no fallback)';
    const label = run?.definition.label ?? 'workflow runs';
    const blockSpec = entries.find(({ step }) => step.id === block?.id)?.spec;
    const repeatStatus = block && blockSpec?.kind === 'repeat'
      ? ` · ${block.id} iteration ${block.iterations?.length ?? 0}/${blockSpec.maxIterations} · ${block.status} · ${repeatOutcome(block, run!.recovered)}${block.skipReason ? ` · ${block.skipReason}` : ''}${block.error ? ` · ${block.error}` : ''}` : '';
    const original = run?.recoveryOriginal;
    const header = [`clankers workflows · ${this.state.level} · ${label}`, `${this.state.runId ?? 'all retained runs'} · attempt ${run?.attemptNo ?? '?'} · ${status}${repeatStatus}`,
      `${this.pending ? 'Control pending. ' : ''}${this.notice} ${this.observerNotice} ${run?.error ? `Workflow error: ${sanitizeUiText(run.error)} · ` : ''}Pause closes admission only; admitted workers continue. UI bounds: 16 runs/16 phases/32 iterations/32 units; approval monitor is inspect-only; recovery assessment is read-only; trusted selection activates a new child; coding gates remain separate; no automatic reconnect.`];
    const headerCount = Math.min(3, Math.max(0, h - 2)); const footerCount = h >= 3 ? 1 : 0;
    const capacity = Math.max(1, h - headerCount - footerCount); this.viewport = capacity;
    const selected = this.selectedId();
    const index = this.rows.indexOf(selected ?? '');
    const slice = visibleSlice(this.rows, Math.max(0, index), capacity);
    let body: string[]; let shown: boolean;
    if (this.confirmation) {
      body = [`Retry NEW attempt for ${this.confirmation.runId}? Enter confirms · Esc cancels (current policy rechecked).`];
      shown = false;
    } else if (this.state.level === 'recovery') {
      body = this.recoveryLines(run, original, w); shown = !!run;
    } else if (this.state.level === 'result' && unit) {
      const values = [`unit ${unit.id} · ${unit.status}${!unit.cleanupSettled ? ' · cleanup-pending' : ''}${codingSummary(unit)}`,
        unit.reusedFrom ? `reused from workflow ${unit.reusedFrom.workflowRunId} / unit ${unit.reusedFrom.unitId} / native ${unit.reusedFrom.native.runId}` : 'Original attempt result; no inferred replies.',
        `native run ${nativeOf(unit)?.runId ?? 'unlinked'} · task ${nativeOf(unit)?.taskId ?? 'unlinked'}`, `error: ${unit.error ?? '(none)'}`,
        ...codingDetailLines(unit, this.options.service), ...(selectedEntry ? [authoredLabel(run!, selectedEntry)] : []), resultPreview(unit.result), 'Local structured result preview only; no transcript copy.'];
      const lines: string[] = [];
      for (const value of values) {
        const wrapped = new Text(sanitizeUiText(value), 0, 0).render(w);
        const remaining = 511 - lines.length;
        lines.push(...wrapped.slice(0, remaining));
        if (wrapped.length > remaining || lines.length >= 511) { lines.push('UI detail clipped: 512 line bound.'); break; }
      }
      this.state.scroll = Math.max(0, Math.min(this.state.scroll, Math.max(0, lines.length - capacity)));
      body = lines.slice(this.state.scroll, this.state.scroll + capacity); shown = body.length > 0;
    } else {
      body = slice.rows.map((id) => {
        const mark = id === selected ? '›' : ' ';
        if (this.state.level === 'list') {
          const view = views.find((row) => row.workflowRunId === id)!;
          const counts = ['queued', 'running', 'completed', 'failed', 'cancelled', 'skipped', 'unverified'].map((key) => `${key}:${view.counts[key as keyof typeof view.counts]}`).join(' ');
          return `${mark} ${id} · ${view.definitionId} · attempt ${view.attemptNo} · ${view.status}${view.cleanupSettled ? '' : ' · cleanup-pending'} · ${counts}`;
        }
        if (this.state.level === 'iterations') {
          const row = block!.iterations!.find((entry) => entry.id === id)!;
          return `${mark} iteration ${id} · ${row.index + 1} · decision ${row.decision ?? 'pending'} · ${row.error ?? ''}`;
        }
        if (this.state.level === 'steps' || this.state.level === 'body') {
          const entry = entries.find(({ step }) => step.id === id)!;
          const row = entry.step;
          return `${mark} phase ${id} · ${row.status} · ${row.units.length} units${entry.spec.kind === 'repeat' ? ` · iteration ${row.iterations?.length ?? 0}/${entry.spec.maxIterations}` : ''} · ${row.skipReason ?? ''} ${row.error ?? ''}${entry.spec.kind === 'repeat' ? ` · ${repeatOutcome(row, run!.recovered)}` : ''}${authoredLabel(run!, entry)}`;
        }
        const row = selectedStep!.units.find((entry) => entry.id === id)!;
        return `${mark} unit ${id} · ${row.status}${row.cleanupSettled ? '' : ' · cleanup-pending'}${row.reusedFrom ? ` · reused from ${row.reusedFrom.workflowRunId}/${row.reusedFrom.unitId} native:${row.reusedFrom.native.runId}` : ''}${codingSummary(row)} · ${row.error ?? ''}${authoredLabel(run!, selectedEntry)}`;
      });
      shown = index >= 0 && slice.rows.includes(selected!);
      if (!body.length) body = ['No retained selection. Missing IDs never select another run/unit.'];
    }
    const footer = this.armedRecovery ? 'Enter authorize selected child · Esc/q cancels confirmation · Ctrl+C close UI only' : this.confirmation ? 'Enter confirmed retry · Esc/q dismiss · Ctrl+C close UI only'
      : '↑↓/Home/End select · Enter drill · Esc/q back · i inspect recovery · n prepare · s apply recommendation (read-only) · a arm trusted selection · p/x/r/c unchanged · Ctrl+C close UI';
    const output = [...header.slice(0, headerCount).map((line, i) => styleText(this.theme, i === 0 ? 'accent' : 'muted', sanitizeUiText(line))),
      ...body.map((line) => sanitizeUiText(line)), ...(footerCount ? [styleText(this.theme, 'dim', footer)] : [])].slice(0, h).map((line) => truncateToWidth(line, w, '', true));
    if (this.confirmation) this.confirmationRendered = true;
    else if (shown && run) {
      if (this.state.level === 'list') {
        const view = views.find((row) => row.workflowRunId === run.workflowRunId);
        if (!view || view.familyId !== run.familyId || view.attemptNo !== run.attemptNo || view.createdAt !== run.createdAt || view.status !== run.status || view.cleanupSettled !== run.cleanupSettled) return output;
      }
      const stepId = this.state.level === 'list' ? undefined : this.state.stepId;
      const unitId = ['units', 'result'].includes(this.state.level) ? this.state.unitId : undefined;
      this.proof = { iterationId: this.state.iterationId, runId: run.workflowRunId, stepId, unitId, identity: identity(run, stepId, unitId), selectedRunIdentity: identity(run), listSignature: views.map(v => `${v.workflowRunId}:${v.status}:${v.cleanupSettled}:${v.updatedAt}`).join('|'), status: run.status, cleanup: run.cleanupSettled };
    }
    return output;
  }
  private current(proof: Proof | undefined): WorkflowRun | undefined {
    if (!proof || proof.runId !== this.state.runId || (proof.stepId !== undefined && proof.stepId !== this.state.stepId) || (proof.unitId !== undefined && proof.unitId !== this.state.unitId)) return;
    const run = this.options.service.get(proof.runId);
    if (proof.iterationId !== this.state.iterationId) return;
    if (proof.iterationId && (!run || run.steps.find((row) => row.id === this.state.blockId)?.iterations?.filter((row) => row.id === proof.iterationId).length !== 1)) return;
    if (!run || identity(run, proof.stepId, proof.unitId) !== proof.identity) return;
    return run;
  }
  handleInput(data: string): void {
    if (this.disposed || isKeyRelease(data)) return;
    // Drop entire paste streams, never interpret a later chunk as a control shortcut.
    if (this.rejectingPaste || data.includes('\x1b[200~')) {
      const ended = (this.pasteTail + data).includes('\x1b[201~');
      this.rejectingPaste = !ended; this.pasteTail = ended ? '' : data.slice(-5); return;
    }
    if (data.length > 64 || data.includes('\x1b[201~') || (/[\x00-\x1f\x7f-\x9f]/u.test(data)
      && !['\x1b', '\x03', '\r', '\n'].includes(data) && !/^\x1b\[[0-9;:]*[A-Za-z~]$/.test(data) && !/^\x1bO[A-Za-z]$/.test(data))) return;
    if (matchesKey(data, 'ctrl+c')) { this.dispose(); return; }
    if (matchesKey(data, 'escape', 'q')) {
      if (this.armedRecovery) { this.armedRecovery = undefined; this.armedRecoveryRendered = false; this.displayedRecovery = undefined; this.notice = 'Recovery confirmation cancelled; no authorization submitted.'; }
      else if (this.confirmation) { this.confirmation = undefined; this.confirmationRendered = false; this.proof = undefined; this.notice = ''; }
      else if (this.state.level === 'recovery') { this.state.level = this.recovery?.priorLevel && this.recovery.priorLevel !== 'recovery' ? this.recovery.priorLevel : 'steps'; this.recovery = undefined; this.recoveryRequestToken++; this.pending = this.authorizingRecovery; this.proof = undefined; this.state.scroll = 0; }
      else if (this.state.level === 'list') { this.dispose(); return; }
      else {
        if (this.state.level === 'result') this.state.level = 'units';
        else if (this.state.level === 'units') this.state.level = this.state.blockId ? 'body' : 'steps';
        else if (this.state.level === 'body') { this.state.level = 'iterations'; this.state.stepId = this.state.blockId; }
        else if (this.state.level === 'iterations') { this.state.level = 'steps'; this.state.stepId = this.state.blockId; this.state.blockId = this.state.iterationId = undefined; }
        else this.state.level = 'list';
        this.proof = undefined; this.state.restoredIdentity = undefined; this.state.scroll = 0;
      }
      this.redraw(); return;
    }
    if (this.pending) return;
    try {
      if (this.armedRecovery) {
        if (matchesKey(data, 'enter')) {
          const captured = this.armedRecovery;
          if (!this.armedRecoveryRendered) this.notice = 'Exact confirmation not yet fully displayed; enlarge the pane.';
          else { this.armedRecovery = undefined; this.armedRecoveryRendered = false; this.authorizeRecovery(captured); }
        } else if (matchesKey(data, 'up', 'down', 'home', 'end', 'pageup', 'pagedown', 'i', 'n', 's', 'c')) {
          this.armedRecovery = undefined; this.displayedRecovery = undefined; this.notice = 'Navigation invalidated recovery confirmation.';
        }
      } else if (matchesKey(data, 's')) {
        this.applyRecoveryRecommendation();
      } else if (matchesKey(data, 'a')) {
        const captured = this.displayedRecovery;
        if (!this.options.recoveryAuthority) this.notice = 'Trusted recovery host unavailable; no authorization.';
        else if (!captured || !this.recoveryCurrent(captured)) this.notice = 'Prepared exact fingerprint/selections not fully displayed or stale; no authorization.';
        else { this.armedRecovery = structuredClone(captured); this.armedRecoveryRendered = false; this.state.scroll = 0; }
      } else if (this.confirmation) {
        if (matchesKey(data, 'enter')) {
          const proof = this.confirmation;
          if (!this.confirmationRendered) { this.notice = 'Confirmation not yet rendered; repeat after redraw.'; }
          else { this.confirmation = undefined; this.confirmationRendered = false; this.control('workflows.retry', proof); }
        }
      } else if (matchesKey(data, 'p', 'x', 'r', 'c', 'i', 'n', 'enter')) {
        const proof = this.proof; const run = this.current(proof);
        if (!run || !proof) { this.notice = 'Selection changed/missing/not yet rendered; no action taken.'; this.proof = undefined; }
        else if (matchesKey(data, 'i', 'n')) this.assess(matchesKey(data, 'n') ? 'prepare' : 'inspect', proof);
        else if (matchesKey(data, 'p')) {
          if (proof.status === 'running' || proof.status === 'paused') this.control(proof.status === 'paused' ? 'workflows.resume' : 'workflows.pause', proof);
          else this.notice = 'Pause/resume unavailable for this rendered state.';
        } else if (matchesKey(data, 'x')) this.control('workflows.cancel', proof);
        else if (matchesKey(data, 'r')) {
          if (run.status !== proof.status || run.cleanupSettled !== proof.cleanup || !terminal(run) || !run.cleanupSettled) this.notice = 'Retry requires terminal attempt and settled cleanup; redraw before retry.';
          else { this.confirmation = { ...proof }; this.confirmationRendered = false; }
        } else if (matchesKey(data, 'c')) {
          const native = copyNative(nativeOf(workflowStepEntries(run).find(({ step }) => step.id === proof.stepId)?.step.units.find((unit) => unit.id === proof.unitId)));
          if (!native || !this.options.onOpenNative) this.notice = 'Select a unit with exact recorded native identity; coding unavailable.';
          else { this.finish({ native, state: { ...this.state, restoredIdentity: proof.identity } }); return; }
        } else {
          if (this.state.level === 'list') this.state.level = 'steps';
          else if (this.state.level === 'iterations') { this.state.level = 'body'; this.state.stepId = undefined; }
          else if (this.state.level === 'steps' || this.state.level === 'body') {
            const entry = workflowStepEntries(run).find(({ step }) => step.id === this.state.stepId);
            if (entry?.spec.kind === 'repeat') { this.state.level = 'iterations'; this.state.blockId = this.state.stepId; this.state.iterationId = undefined; }
            else this.state.level = 'units';
          } else this.state.level = 'result';
          this.displayedRecovery = undefined; this.armedRecovery = undefined; this.armedRecoveryRendered = false;
          this.state.restoredIdentity = undefined; this.state.scroll = 0; this.proof = undefined; this.recovery = undefined; this.recoveryRequestToken++; this.pending = false;
        }
      } else if ((this.state.level === 'result' || this.state.level === 'recovery') && matchesKey(data, 'up', 'down', 'pageup', 'pagedown', 'home', 'end')) {
        this.state.scroll = matchesKey(data, 'home') ? 0 : matchesKey(data, 'end') ? 512 : Math.max(0, this.state.scroll + (matchesKey(data, 'up', 'pageup') ? -1 : 1) * (matchesKey(data, 'pageup', 'pagedown') ? this.viewport : 1));
      } else if (matchesKey(data, 'up', 'down', 'home', 'end')) {
        const index = this.rows.indexOf(this.selectedId() ?? '');
        const next = matchesKey(data, 'home') ? 0 : matchesKey(data, 'end') ? this.rows.length - 1 : Math.max(0, Math.min(this.rows.length - 1, index + (matchesKey(data, 'up') ? -1 : 1)));
        this.select(this.rows[next]);
      }
    } catch (error) { this.proof = undefined; this.notice = `Workflow action unavailable: ${uiErrorText(error)}`; }
    this.redraw();
  }

  private recoveryLines(run: WorkflowRun | undefined, original: WorkflowRun['recoveryOriginal'] | undefined, width: number): string[] {
    const lines: string[] = [];
    lines.push(`Recovery assessment pane · read-only · no automatic reconnect · original attempt ${original ? `${original.status}/${original.cleanupSettled ? 'cleanup-settled' : 'cleanup-unsettled'} recorded ${original.recordedAt}` : 'unknown/not recorded'}`);
    lines.push(this.options.recoveryAuthority ? 'Trusted host: s applies recommendation as read-only reprepare; a arms, then Enter confirms exact displayed proof.' : 'Authorize new attempt: unavailable until trusted host configured. Approval callbacks are not model control actions.');
    const candidate = this.armedRecovery ?? this.recoveryCandidate(run);
    const evidence: string[] = candidate ? [
      `${this.armedRecovery ? 'CONFIRM' : 'Prepared proof'} source ${candidate.request.workflowRunId} · authorizes NEW selected child`,
      `Exact fingerprint: ${candidate.request.assessmentFingerprint}`,
      `Exact reuse selections: ${JSON.stringify(candidate.request.selections?.reuseUnitIds ?? [])}`,
      `Exact rerun selections: ${JSON.stringify(candidate.request.selections?.rerunUnitIds ?? [])}`,
      'Readonly native may start after confirmation; coding implementation, checks, review and application gates remain separate.',
    ] : [];
    // Proof is eligible only when every exact evidence line actually fits in this render.
    lines.unshift(...evidence);
    if (this.armedRecovery && !this.recoveryCurrent(this.armedRecovery)) {
      this.armedRecovery = undefined; this.armedRecoveryRendered = false;
      lines.unshift('Confirmation invalidated: source changed; prepare/display again.');
    }
    if (!this.recovery) lines.push('Press i to inspect recovery or n to prepare continuation. Prepare is assessment only; it does not execute.');
    else {
      const stale = run ? workflowHash(run) !== this.recovery.sourceHash : true;
      const reply = this.recovery.reply;
      if (this.recovery.error) lines.push(`assessment error: ${this.recovery.error}`);
      else if (reply && !reply.ok) lines.push(`assessment blocked/rejected: ${sanitizeUiText(reply.error)}`);
      lines.push(`${this.recovery.kind === 'prepare' ? 'Prepare continuation' : 'Inspect recovery'} · requested ${this.recovery.requestedAt} · assessment freshness ${stale ? 'stale: selected run fingerprint/history/source proof changed' : 'captured assessment; reprepare to check current artifacts'} · run ${this.recovery.runId}`);
      if (this.recovery.selections) lines.push(`Rendered selections · reuse:${(this.recovery.selections.reuseUnitIds ?? []).map(v => clipped(v, 24)).join(',') || 'none'} · rerun:${(this.recovery.selections.rerunUnitIds ?? []).map(v => clipped(v, 24)).join(',') || 'none'}`);
      if (!this.recovery.error && !reply) lines.push('assessment pending...');
      else if (reply?.assessment) {
        lines.push(...assessmentLines(reply.assessment));
        const recommendation = this.recoveryRecommendation(run);
        if (recommendation) lines.push(`RECOMMENDATION ONLY (not requested/granted): ${JSON.stringify(recommendation)} · press s to explicitly reprepare with these lists; new fingerprint must be displayed/armed/confirmed.`);
      }
    }
    if (this.selectedRecoveryChild) {
      const { sourceId, childId } = this.selectedRecoveryChild;
      const child = this.options.service.get(childId);
      lines.push(`Source ${clipped(sourceId, 48)} · selected child ${clipped(childId, 48)} · CURRENT status ${child ? statusWord(child.status) : 'missing/evicted (no fallback)'}`);
      if (child) {
        lines.push(`Child cleanup ${child.cleanupSettled ? 'settled' : 'pending'} · pending gates are recorded below, not inferred grants.`);
        for (const { step } of workflowStepEntries(child).slice(0, 16)) for (const unit of step.units.slice(0, 32)) {
          lines.push(`Child unit ${clipped(unit.id, 64)} · ${statusWord(unit.status)}${codingSummary(unit)}`);
          lines.push(...codingDetailLines(unit, this.options.service));
        }
      }
    }
    lines.push('Budget/candidate/application: unknown unless the bounded assessment states otherwise. Pending fresh approvals: unknown/none displayed by default.');
    const out: string[] = [];
    let evidenceEnd = 0; let evidenceComplete = true;
    for (const [index, line] of lines.entries()) {
      const safe = sanitizeUiText(line);
      // The shared sanitizer also truncates at 4096 chars. A visually fitting
      // prefix is NOT display of an exact requested selection list.
      if (index < evidence.length && safe !== line) evidenceComplete = false;
      const wrapped = new Text(safe, 0, 0).render(width);
      const remaining = 256 - out.length; out.push(...wrapped.slice(0, Math.max(0, Math.min(8, remaining))));
      if (index < evidence.length) { evidenceEnd = out.length; if (wrapped.length > 8 || remaining < wrapped.length) evidenceComplete = false; }
      if (wrapped.length > 8 || safe !== line) out.push('Recovery line clipped: bounded omission; exact proof cannot authorize if omitted. Open service JSON for full details.');
      if (out.length >= 256) { out.push('Recovery assessment clipped: 256 line UI bound; not a context dump.'); break; }
    }
    this.state.scroll = Math.max(0, Math.min(this.state.scroll, Math.max(0, out.length - this.viewport)));
    if (candidate && evidenceComplete && evidenceEnd > 0 && this.state.scroll === 0 && evidenceEnd <= this.viewport && this.recoveryCurrent(candidate)) {
      if (this.armedRecovery) this.armedRecoveryRendered = true;
      else this.displayedRecovery = structuredClone(candidate);
    }
    return out.slice(this.state.scroll, this.state.scroll + this.viewport);
  }
  private recoveryCandidate(run?: WorkflowRun): RecoveryConfirmation | undefined {
    const recovery = this.recovery, reply = recovery?.reply;
    if (!run || recovery?.kind !== 'prepare' || !reply?.ok || workflowHash(run) !== recovery.sourceHash) return;
    let safe: WorkflowJson;
    try { safe = workflowJson(reply.assessment, WORKFLOW_LIMITS.aggregateBytes); } catch { return; }
    const assessment = jsonRecord(safe), plan = jsonRecord(assessment?.plan), selections = jsonRecord(assessment?.selections);
    // Assessment output is data, not consent. Only an explicit requested list can
    // become the exact displayed confirmation; never adopt returned defaults.
    const requested = recovery.selections;
    if (!requested || !Array.isArray(requested.reuseUnitIds) || !Array.isArray(requested.rerunUnitIds)) return;
    if (assessment?.workflowRunId !== recovery.runId || plan?.status !== 'prepared' || !Array.isArray(assessment?.blocked) || assessment.blocked.length || typeof assessment.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(assessment.fingerprint) || !selections) return;
    const reuse = selections.reuseUnitIds, rerun = selections.rerunUnitIds;
    if (![reuse, rerun].every(v => Array.isArray(v) && v.length <= 256 && v.every(id => validId(id) && id.length <= 160))) return;
    if (workflowHash({ reuseUnitIds: reuse, rerunUnitIds: rerun }) !== workflowHash(requested)) return;
    return { request: { workflowRunId: recovery.runId, assessmentFingerprint: assessment.fingerprint, selections: { reuseUnitIds: [...reuse as string[]], rerunUnitIds: [...rerun as string[]] } }, sourceHash: recovery.sourceHash, token: recovery.requestToken };
  }
  private recoveryRecommendation(run?: WorkflowRun): RecoverySelections | undefined {
    if (!run || !this.recovery?.reply?.assessment || workflowHash(run) !== this.recovery.sourceHash) return;
    let safe: WorkflowJson;
    try { safe = workflowJson(this.recovery.reply.assessment, WORKFLOW_LIMITS.aggregateBytes); } catch { return; }
    const plan = jsonRecord(jsonRecord(safe)?.plan), recommended = jsonRecord(plan?.recommendedSelections);
    const addresses = jsonArray(plan?.executionAddresses).map(row => jsonRecord(row)?.unitId);
    const reuse = recommended?.reuseUnitIds, rerun = recommended?.rerunUnitIds;
    if (!Array.isArray(reuse) || !Array.isArray(rerun) || reuse.length || !rerun.length || rerun.length > 256
      || !rerun.every(id => validId(id) && id.length <= 160) || new Set(rerun).size !== rerun.length
      || addresses.length !== rerun.length || addresses.some(id => !rerun.includes(id))) return;
    return { reuseUnitIds: [], rerunUnitIds: [...rerun as string[]].sort() };
  }
  private applyRecoveryRecommendation(): void {
    const proof = this.proof, run = this.current(proof);
    const selections = this.recoveryRecommendation(run);
    if (!proof || !run || this.state.level !== 'recovery' || !selections) {
      this.notice = 'No current displayed recommendation/source; inspect or prepare again. No authorization.'; return;
    }
    this.notice = 'Recommendation explicitly requested for read-only reprepare; display NEW fingerprint, then arm and confirm separately.';
    this.assess('prepare', proof, selections);
  }
  private recoveryCurrent(captured: RecoveryConfirmation): boolean {
    const run = this.options.service.get(captured.request.workflowRunId);
    return !this.disposed && this.state.level === 'recovery' && this.state.runId === captured.request.workflowRunId
      && this.recovery?.requestToken === captured.token && !!run && workflowHash(run) === captured.sourceHash;
  }
  private authorizeRecovery(captured: RecoveryConfirmation): void {
    if (!this.options.recoveryAuthority || !this.recoveryCurrent(captured)) { this.notice = 'Recovery confirmation stale/missing; no authorization.'; return; }
    const authority = this.options.recoveryAuthority;
    if (this.authorizingRecovery) { this.notice = 'Host selection already pending; no duplicate authorization.'; return; }
    this.authorizingRecovery = true; this.pending = true; this.displayedRecovery = undefined;
    // Closing this observer does not cancel an already submitted host selection/workflow.
    void (async () => {
      try {
        const reply = await authority.authorize(structuredClone(captured.request));
        if (!this.disposed) {
          const childId = reply.view?.workflowRunId ?? this.options.service.get(captured.request.workflowRunId)?.recovery?.selection?.continuationAttemptId;
          if (childId && childId !== captured.request.workflowRunId) this.selectedRecoveryChild = { sourceId: captured.request.workflowRunId, childId };
          this.notice = reply.ok ? `Source ${clipped(captured.request.workflowRunId, 48)} selected child ${clipped(reply.view?.workflowRunId, 48)} · ${statusWord(reply.view?.status)}. Readonly native may run; fresh coding gates remain separate.` : `Recovery selection rejected/cancelled/uncertain: ${sanitizeUiText(reply.error)}`;
          // Acknowledgement never permits resubmitting the same displayed proof.
          this.recovery = undefined; this.recoveryRequestToken++;
        }
      } catch (error) { if (!this.disposed) this.notice = `Recovery selection failed/uncertain: ${uiErrorText(error)}`; }
      finally { this.authorizingRecovery = false; if (!this.disposed) { this.pending = false; this.redraw(); } }
    })();
  }
  private assess(kind: 'inspect' | 'prepare', proof: Proof, explicitSelections?: RecoverySelections): void {
    const run = this.current(proof);
    if (!run || identity(run) !== proof.selectedRunIdentity || this.options.service.list().slice(0, 16).map(v => `${v.workflowRunId}:${v.status}:${v.cleanupSettled}:${v.updatedAt}`).join('|') !== proof.listSignature) { this.notice = 'Recovery assessment refused: exact selected run proof is stale/missing.'; this.proof = undefined; return; }
    const selections: RecoverySelections | undefined = kind === 'prepare' ? structuredClone(explicitSelections ?? {}) : undefined;
    const token = ++this.recoveryRequestToken;
    const priorLevel = this.state.level;
    this.displayedRecovery = undefined; this.armedRecovery = undefined;
    this.recovery = { kind, runId: proof.runId, sourceHash: workflowHash(run), proofIdentity: proof.selectedRunIdentity, requestToken: token, priorLevel, requestedAt: new Date().toISOString(), selections };
    this.state.level = 'recovery'; this.state.scroll = 0; this.pending = true; this.proof = undefined;
    void (async () => {
      try {
        const action: WorkflowAction = kind === 'prepare' ? { action: 'workflows.recovery.prepare', workflowRunId: proof.runId, selections } : { action: 'workflows.recovery.inspect', workflowRunId: proof.runId };
        const reply = await this.options.service.execute(action);
        if (!this.disposed && this.recovery?.requestToken === token && this.recovery.proofIdentity === proof.selectedRunIdentity && this.recovery.kind === kind) this.recovery.reply = reply;
      } catch (error) { if (!this.disposed && this.recovery?.requestToken === token && this.recovery.proofIdentity === proof.selectedRunIdentity) this.recovery.error = uiErrorText(error); }
      finally { if (!this.disposed && this.recovery?.requestToken === token) { this.pending = false; this.redraw(); } }
    })();
  }

  private control(action: WorkflowControlAction, proof: Proof): void {
    const run = this.current(proof);
    if (!run || run.status !== proof.status || run.cleanupSettled !== proof.cleanup) { this.notice = 'Rendered attempt state changed; redraw before control.'; this.proof = undefined; return; }
    if (action === 'workflows.retry' && (!terminal(run) || !run.cleanupSettled)) { this.notice = 'Retry blocked: cleanup not settled.'; return; }
    this.pending = true; this.proof = undefined;
    // Do not abort the workflow when the UI closes; control ownership belongs to the service.
    void (async () => {
      try {
        const reply = await this.options.service.execute({ action, workflowRunId: proof.runId });
        if (!this.disposed) this.notice = reply.ok ? `${action} accepted${reply.view ? ` · ${reply.view.workflowRunId} · ${reply.view.status}` : ''}.` : `Control rejected: ${sanitizeUiText(reply.error)}`;
      } catch (error) { if (!this.disposed) this.notice = `Control failed: ${uiErrorText(error)}`; }
      finally { if (!this.disposed) { this.pending = false; this.redraw(); } }
    })();
  }
  dispose(): void { this.finish(); }
  private finish(result?: CodingResult): void {
    if (this.disposed) return;
    this.disposed = true; this.recoveryRequestToken++; const unsubscribe = this.unsubscribe; this.unsubscribe = undefined;
    this.proof = undefined; this.confirmation = undefined; this.displayedRecovery = undefined; this.armedRecovery = undefined; this.rows = []; this.focused = false;
    cleanup(unsubscribe); cleanup(() => this.done?.(result));
  }
}
