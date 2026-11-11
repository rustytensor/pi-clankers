import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, opendirSync, openSync, readSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFileSync as osReadFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { WORKFLOW_LIMITS, workflowJson } from './workflow-model.js';

export type CodingWorkspaceLimits = {
  maxFiles?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxPreviewBytes?: number;
};

export type CodingBaselineEntry = { path: string; abs: string; exists: boolean; parentPaths: string[]; parentChain: Identity[]; bytes?: number; sha256?: string; text?: string; mode?: number; file?: Identity };
export type CodingBaselineManifest = { projectRoot: string; projectRootIdentity: Identity; inputPaths: string[]; writablePaths: string[]; entries: CodingBaselineEntry[]; totalBytes: number; hash: string; clipped: boolean };
export type CaptureCodingBaselineOptions = { projectRoot: string; inputPaths: string[]; writablePaths: string[]; limits?: CodingWorkspaceLimits };

export type RecoveryWriterOwnerEvidence = { bootId: string; pid: number; startTimeTicks: string; writerSessionId: string; generation: string; lockDev?: number; lockIno?: number; markerDev?: number; markerIno?: number };
export type WorkspaceEffectIntent = { sequence: number; kind: 'stage-write' | 'destination-write'; generation: string; workflowRunId: string; projectRoot: string; stageRoot: string; stageRootIdentity: Identity; markerPath: string; markerIdentity: Identity; markerOwner: string; ownerEvidence?: RecoveryWriterOwnerEvidence; path: string; candidateHash: string | null; preimageHash: string | null; postimageHash: string | null };
export type WorkspaceEffectObservation = WorkspaceEffectIntent & { status: 'observed' | 'rejected' | 'uncertain'; error?: string; observedPostimageHash: string | null };
export type WorkspaceEffectRecord = WorkspaceEffectObservation & { beforeCalled: boolean; afterSaved: boolean; recordedAt: string };
export class WorkspaceEffectUncertaintyError extends Error {
  readonly lastKnownManifest: WorkspaceRecoveryManifest | null;
  readonly intendedScope: Readonly<{ workflowRunId: string; projectRoot: string; stageRoot: string; markerPath: string; allowedPaths: readonly string[] }>;
  readonly generation: string;
  readonly possibleEffect: WorkspaceEffectObservation | null;
  readonly cleanupBlocked = true;
  constructor(message: string, details: { lastKnownManifest: WorkspaceRecoveryManifest | null; intendedScope: { workflowRunId: string; projectRoot: string; stageRoot: string; markerPath: string; allowedPaths: readonly string[] }; generation: string; possibleEffect: WorkspaceEffectObservation | null; cause?: unknown }) {
    super(message);
    this.name = 'WorkspaceEffectUncertaintyError';
    if (details.cause !== undefined) (this as Error & { cause?: unknown }).cause = details.cause;
    this.lastKnownManifest = details.lastKnownManifest ? deepFreeze(details.lastKnownManifest) : null;
    this.intendedScope = deepFreeze({ ...details.intendedScope, allowedPaths: [...details.intendedScope.allowedPaths] });
    this.generation = details.generation;
    this.possibleEffect = details.possibleEffect ? freezeClone(details.possibleEffect) : null;
    Object.freeze(this);
  }
};
export type RetainedLeaseEvidence = Readonly<{ key: string; leaseDir: string; leaseDirIdentity: Identity; ownerFile: string; ownerFileIdentity: Identity; ownerValue: string }> ;
export type LeaseReleaseCurrentObservation = Readonly<{ leaseDirPresent: boolean; leaseDirIdentity: Identity | null; ownerFilePresent: boolean; ownerFileIdentity: Identity | null; ownerValue: string | null; ownerValueMatches: boolean | null; ownerKnownOutcome: 'known' | 'unknown'; error?: string }>;
export type WorkspaceLeaseReleaseIntent = Readonly<{ sequence: number; generation: string; workflowRunId: string; beforeLeaseEvidence: RetainedLeaseEvidence }>;
export type WorkspaceLeaseReleaseObservation = WorkspaceLeaseReleaseIntent & Readonly<{ status: 'observed' | 'uncertain'; currentObservation: LeaseReleaseCurrentObservation; error?: string }>;
export class WorkspaceLeaseReleaseUncertaintyError extends Error {
  readonly lastKnownManifest: WorkspaceRecoveryManifest | null;
  readonly intendedScope: Readonly<{ workflowRunId: string; projectRoot: string; stageRoot: string; markerPath: string; allowedPaths: readonly string[] }>;
  readonly generation: string;
  readonly beforeLeaseEvidence: RetainedLeaseEvidence;
  readonly currentObservation: LeaseReleaseCurrentObservation;
  readonly remainingLeaseEvidence: readonly RetainedLeaseEvidence[];
  readonly cleanupBlocked = true;
  constructor(message: string, details: { lastKnownManifest: WorkspaceRecoveryManifest | null; intendedScope: { workflowRunId: string; projectRoot: string; stageRoot: string; markerPath: string; allowedPaths: readonly string[] }; generation: string; beforeLeaseEvidence: RetainedLeaseEvidence; currentObservation: LeaseReleaseCurrentObservation; remainingLeaseEvidence: readonly RetainedLeaseEvidence[]; cause?: unknown }) {
    super(message);
    this.name = 'WorkspaceLeaseReleaseUncertaintyError';
    if (details.cause !== undefined) (this as Error & { cause?: unknown }).cause = details.cause;
    this.lastKnownManifest = details.lastKnownManifest ? deepFreeze(details.lastKnownManifest) : null;
    this.intendedScope = deepFreeze({ ...details.intendedScope, allowedPaths: [...details.intendedScope.allowedPaths] });
    this.generation = details.generation;
    this.beforeLeaseEvidence = freezeClone(details.beforeLeaseEvidence);
    this.currentObservation = freezeClone(details.currentObservation);
    this.remainingLeaseEvidence = deepFreeze(details.remainingLeaseEvidence.map((e) => freezeClone(e)));
    Object.freeze(this);
  }
}
export type WorkspaceRecoveryManifest = Readonly<{ version: 1; workflowRunId: string; ownerGeneration: string; projectRoot: string; projectRootIdentity: Identity; stageRoot: string; stageRootIdentity: Identity; markerPath: string; markerIdentity: Identity; markerOwner: string; inputPaths: readonly string[]; writablePaths: readonly string[]; allowedPaths: readonly string[]; baselineHash: string; baselineEntries: readonly { path: string; exists: boolean; sha256: string | null; bytes: number | null; file: Identity | null; parentChain: readonly Identity[] }[]; candidateEntries: readonly { path: string; exists: boolean; sha256: string | null; bytes: number | null; identity: Identity | null; generation: string | null }[]; declaredStageDirs: readonly { path: string; identity: Identity }[]; declaredStageFiles: readonly { path: string; identity: Identity; generation: string; sha256: string; bytes: number }[]; destinationLeases: readonly RetainedLeaseEvidence[]; ownerEvidence?: RecoveryWriterOwnerEvidence; effects: readonly WorkspaceEffectRecord[] }>;
export type RetainedWorkspaceTrustedScope = { projectRoot: string; stagingParent: string; workflowRunId: string; allowedPaths: readonly string[]; limits?: CodingWorkspaceLimits };
export type WorkspaceRootReadyEvidence = Readonly<{ version: 1; workflowRunId: string; ownerGeneration: string; projectRoot: string; projectRootIdentity: Identity; stageRoot: string; stageRootIdentity: Identity; markerPath: string; markerIdentity: Identity; markerOwner: string; inputPaths: readonly string[]; writablePaths: readonly string[]; allowedPaths: readonly string[]; baselineHash: string; baselineEntries: readonly { path: string; exists: boolean; sha256: string | null; bytes: number | null; file: Identity | null; parentChain: readonly Identity[] }[]; destinationLeases: readonly RetainedLeaseEvidence[]; ownerEvidence?: RecoveryWriterOwnerEvidence; recordedAt: string }> ;
export type WorkspaceEffectHooks = { rootReady?: (evidence: WorkspaceRootReadyEvidence) => void; beforeEffect?: (intent: WorkspaceEffectIntent, capacity?: WorkspaceEffectCapacity) => void; assertEffectCapacity?: (intent: WorkspaceEffectIntent, capacity: WorkspaceEffectCapacity) => void; assertLeaseReleaseAuthority?: () => void; assertLeaseReleaseCapacity?: (intent: WorkspaceLeaseReleaseIntent) => void; canSettlePreEffectRejection?: () => boolean; afterEffect?: (observation: WorkspaceEffectObservation) => void; beforeLeaseRelease?: (intent: WorkspaceLeaseReleaseIntent) => void; afterLeaseRelease?: (observation: WorkspaceLeaseReleaseObservation) => void };
/** Serialization upper bound only; never an observed manifest or recovery proof. */
export type WorkspaceEffectCapacity = Readonly<{ manifest: unknown; observation: unknown }>;
export type CreateCodingWorkspaceOptions = {
  workflowRunId: string;
  projectRoot: string;
  stagingParent: string;
  inputPaths: string[];
  writablePaths: string[];
  assertAuthority: () => void;
  limits?: CodingWorkspaceLimits;
  reviewedBaseline?: CodingBaselineManifest;
  effectHooks?: WorkspaceEffectHooks;
  recoveryWriterOwnerEvidence?: RecoveryWriterOwnerEvidence;
};

export type WorkspaceCandidate = {
  hash: string;
  changedPaths: string[];
  files: Array<{ path: string; before: Buffer | null; after: Buffer | null; beforeHash: string | null; afterHash: string | null; preview: string; clippedBytes: number }>;
  totalBytes: number;
  clippedBytes: number;
};

export type ApplyOutcome = { status: 'applied' | 'partial' | 'rejected'; appliedPaths: string[]; error?: string };

export type CodingWorkspace = {
  readonly stageRoot: string;
  read(path: string): string;
  write(path: string, text: string): void;
  inspect(): WorkspaceCandidate;
  assertFreshDestination(): void;
  apply(candidateHash: string): ApplyOutcome;
  recoveryManifest(): WorkspaceRecoveryManifest;
  cleanup(): void;
  settle(): void;
};

export type CreateContinuationCodingWorkspaceOptions = {
  rawRetainedManifest: unknown;
  trustedScope: RetainedWorkspaceTrustedScope;
  workflowRunId: string;
  recoveryWriterOwnerEvidence: RecoveryWriterOwnerEvidence;
  assertAuthority: () => void;
  assertPreviousSettlement: (inspection: RetainedWorkspaceInspection) => void;
  effectHooks?: WorkspaceEffectHooks;
  limits?: CodingWorkspaceLimits;
};
export type ContinuationCodingWorkspaceProvenance = {
  sourceWorkflowId: string;
  oldStageGen: string;
  candidateHash: string;
  alreadySatisfiedPaths: readonly string[];
  remainingPaths: readonly string[];
  newStageGen: string;
};
export type ContinuationCodingWorkspaceResult =
  | { status: 'created'; workspace: CodingWorkspace; provenance: ContinuationCodingWorkspaceProvenance }
  | { status: 'blocked'; error: string; inspection?: RetainedWorkspaceInspection; uncertainty?: { kind: string; message: string }; createdWorkspaceEvidence?: WorkspaceRecoveryManifest; provenance?: Partial<ContinuationCodingWorkspaceProvenance> };

export type Identity = { dev: number; ino: number; mode: number; uid: number; gid: number; size?: number; mtimeMs?: number; hash?: string };
type Baseline = { path: string; abs: string; exists: boolean; parentPaths: string[]; parentChain: Identity[]; bytes?: Buffer; mode?: number; file?: Identity };
type StageAuthority = { root: Identity; marker: Identity; dirs: Map<string, Identity>; files: Map<string, Identity>; fileGenerations: Map<string, string> };

const DEFAULT_LIMITS = { maxFiles: 32, maxFileBytes: 256 * 1024, maxTotalBytes: 1024 * 1024, maxPreviewBytes: 4096 };
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: true });
const TEXT_ENCODER = new TextEncoder();
const PROTECTED = new Set(['.git', '.pi', '.agents', 'config', 'configs', 'credential', 'credentials', 'secrets', 'secret']);
const ownedDestinations = new Map<string, string>();

export function captureCodingBaseline(options: CaptureCodingBaselineOptions): CodingBaselineManifest {
  if (process.platform === 'win32') throw new Error('coding baseline is unsupported on win32 path semantics');
  const limits = validateLimits(options.limits);
  const projectRoot = resolveExistingDirectory(options.projectRoot, 'projectRoot');
  assertNoSymlinkComponents(projectRoot);
  const inputs = unique(options.inputPaths.map(validateRelPath));
  const writables = unique(options.writablePaths.map(validateRelPath));
  const manifested = unique([...inputs, ...writables]);
  if (manifested.length > limits.maxFiles) throw new Error('too many manifested files');
  const entries: CodingBaselineEntry[] = [];
  let totalBytes = 0;
  for (const rel of manifested) {
    const abs = safeProjectAbs(projectRoot, rel);
    assertSafeExistingDirectory(dirname(abs), `baseline parent for ${rel}`);
    if (existsNoFollow(abs)) {
      assertSafeExistingFile(abs, rel);
      const bytes = readFileBounded(abs, limits.maxFileBytes, `baseline input too large: ${rel}`);
      totalBytes += bytes.length;
      if (totalBytes > limits.maxTotalBytes) throw new Error('baseline manifest total too large');
      decodeUtf8(bytes, `baseline input is not utf8 text: ${rel}`);
      const b = baselineFor(projectRoot, rel, bytes);
      entries.push({ path: rel, abs: b.abs, exists: true, parentPaths: b.parentPaths, parentChain: b.parentChain, bytes: bytes.length, sha256: hashBytes(bytes), text: bytes.toString('utf8'), mode: b.mode, file: b.file });
    } else {
      if (inputs.includes(rel) && !writables.includes(rel)) throw new Error(`input does not exist: ${rel}`);
      const b = baselineForMissing(projectRoot, rel);
      entries.push({ path: rel, abs: b.abs, exists: false, parentPaths: b.parentPaths, parentChain: b.parentChain });
    }
  }
  const rootSt = checkedLstat(projectRoot, 'projectRoot');
  const comparable = { projectRoot, projectRootIdentity: directoryIdentity(rootSt), inputPaths: inputs, writablePaths: writables, entries, totalBytes, clipped: false };
  return Object.freeze({ ...comparable, hash: hash(JSON.stringify(comparable)) });
}

export function createCodingWorkspace(options: CreateCodingWorkspaceOptions): CodingWorkspace {
  if (process.platform === 'win32') throw new Error('coding workspace is unsupported on win32 path semantics');
  const limits = validateLimits(options.limits);
  if (!options.workflowRunId || /[\0/\\]/.test(options.workflowRunId) || options.workflowRunId.length > 80) throw new Error('invalid workflowRunId');
  const projectRoot = resolveExistingDirectory(options.projectRoot, 'projectRoot');
  assertNoSymlinkComponents(projectRoot);
  const stagingParent = resolveExistingDirectory(options.stagingParent, 'stagingParent');
  assertNoSymlinkComponents(stagingParent);
  if (!isAbsolute(stagingParent)) throw new Error('stagingParent must be absolute');
  const inputs = unique(options.inputPaths.map(validateRelPath));
  const writables = unique(options.writablePaths.map(validateRelPath));
  const manifested = unique([...inputs, ...writables]);
  if (manifested.length > limits.maxFiles) throw new Error('too many manifested files');
  const writableSet = new Set(writables);
  const inputSet = new Set(inputs);
  if (options.reviewedBaseline) {
    const fresh = captureCodingBaseline({ projectRoot, inputPaths: inputs, writablePaths: writables, limits });
    if (fresh.hash !== options.reviewedBaseline.hash) throw new Error('reviewed coding baseline changed before workspace creation');
  }
  const originalProjectIdentity = directoryIdentity(checkedLstat(projectRoot, 'projectRoot'));
  const ownerGeneration = randomUUID();
  const ownerEvidence = options.recoveryWriterOwnerEvidence ? verifyCurrentOwnerEvidence(options.recoveryWriterOwnerEvidence) : undefined;
  const owner = `${options.workflowRunId}:${process.pid}:${ownerGeneration}`;
  const expectedDirs = expectedStageDirs(manifested);
  const expectedFiles = new Set<string>();

  const leaseRoot = ensureLeaseRoot();
  const leases: LeaseRecord[] = [];
  const ownedKeys: string[] = [];
  const baselines = new Map<string, Baseline>();
  let stageRoot = '';
  let marker = '';
  let authority: StageAuthority | undefined;
  let applyAttempted = false;
  let cleaned = false;
  let activeWorkspace = true;
  let leasesReleased = false;
  let poisoned: Error | undefined;
  let operationSequence = 0;
  const effectRecords: WorkspaceEffectRecord[] = [];

  try {
    options.assertAuthority();
    for (const rel of writables) acquireLease(leaseRoot, projectRoot, rel, owner, leases, ownedKeys);

    stageRoot = mkdtempSync(join(stagingParent, `coding-${options.workflowRunId}-`));
    chmodSync(stageRoot, 0o700);
    const rootSt = checkedLstat(stageRoot, 'stageRoot');
    if (!rootSt.isDirectory() || rootSt.isSymbolicLink()) throw new Error('stageRoot is not a private directory');
    marker = join(stageRoot, '.coding-workspace-owner.json');
    const markerOwner = { owner, workflowRunId: options.workflowRunId, ownerGeneration, projectRoot, stageRoot, createdAt: new Date().toISOString() };
    writeFileSync(marker, JSON.stringify(markerOwner), { mode: 0o600, flag: 'wx' });
    fsyncFile(marker); fsyncDir(stageRoot);
    const markerSt = checkedLstat(marker, 'workspace marker');
    if (!markerSt.isFile() || markerSt.isSymbolicLink() || markerSt.size > 4096) throw new Error('workspace marker invalid');
    authority = { root: identity(rootSt), marker: identity(markerSt), dirs: new Map([['', identity(rootSt)]]), files: new Map(), fileGenerations: new Map() };

    let total = 0;
    const stageWrites: Array<{ rel: string; bytes: Buffer }> = [];
    for (const rel of manifested) {
      const abs = safeProjectAbs(projectRoot, rel);
      const parent = dirname(abs);
      assertSafeExistingDirectory(parent, `writable parent for ${rel}`);
      if (existsNoFollow(abs)) {
        assertSafeExistingFile(abs, rel);
        const bytes = readFileBounded(abs, limits.maxFileBytes, `input too large: ${rel}`);
        total += bytes.length;
        if (total > limits.maxTotalBytes) throw new Error('manifest total too large');
        decodeUtf8(bytes, `${inputSet.has(rel) ? 'input' : 'writable'} is not utf8 text: ${rel}`);
        const st = checkedLstat(abs, rel);
        if ((st.mode & 0o111) !== 0) throw new Error(`executable input rejected: ${rel}`);
        baselines.set(rel, baselineFor(projectRoot, rel, bytes));
        if (inputSet.has(rel) || writableSet.has(rel)) stageWrites.push({ rel, bytes });
      } else {
        if (inputSet.has(rel) && !writableSet.has(rel)) throw new Error(`input does not exist: ${rel}`);
        baselines.set(rel, baselineForMissing(projectRoot, rel));
      }
    }
    if (options.effectHooks?.rootReady) {
      try {
        const evidence = buildRootReadyEvidence();
        // One bounded publication, never repeated in each effect record.
        workflowJson(evidence, WORKFLOW_LIMITS.ledgerBytes);
        options.effectHooks.rootReady(evidence);
        // Successful publication may synchronously revoke authority or alter roots.
        // The snapshot already references these artifacts: never clean them on rejection.
        options.assertAuthority();
        assertOwnedStage(stageRoot, marker, owner, authority);
      } catch (error) {
        poisoned = uncertaintyError(`rootReady publication uncertain: ${message(error)}`, error, null);
        throw poisoned;
      }
    }
    for (const { rel, bytes } of stageWrites) {
      recordEffect('stage-write', rel, null, observeStageHash(stageRoot, rel, limits), hashBytes(bytes), () => writeStageFile(stageRoot, rel, bytes, writableSet.has(rel), expectedDirs, authority!));
      expectedFiles.add(rel);
    }
  } catch (error) {
    if (poisoned) { try { options.assertAuthority(); } catch {} throw error; }
    let cleanupError: unknown;
    try { if (stageRoot && marker && authority) cleanupArtifacts(stageRoot, marker, owner, authority, leases, ownedKeys, leaseReleaseContext()); }
    catch (e) { cleanupError = e; }
    try { releaseLeases(leases, ownedKeys, leaseReleaseContext()); }
    catch (e) { cleanupError = cleanupError ?? e; }
    if (cleanupError !== undefined && error instanceof Error) (error as Error & { cleanupError?: unknown }).cleanupError = cleanupError;
    throw error;
  }

  function assertOwnedRetained() {
    if (cleaned) throw new Error('workspace has been cleaned up');
    if (!authority) throw new Error('workspace initialization incomplete');
    assertOwnedStage(stageRoot, marker, owner, authority);
  }
  function assertActive() {
    assertOwnedRetained();
    if (!activeWorkspace) throw new Error('workspace has been settled');
    if (poisoned) throw new Error(`workspace effect state uncertain: ${poisoned.message}`);
  }

  function recordEffect(kind: 'stage-write' | 'destination-write', rel: string, candidateHash: string | null, preimageHash: string | null, postimageHash: string | null, effect: () => Partial<WorkspaceEffectObservation> | void): WorkspaceEffectObservation {
    if (poisoned) throw new Error(`workspace effect state uncertain: ${poisoned.message}`);
    if (operationSequence >= 512) throw new Error('too many workspace effect records');
    if (!authority) throw new Error('workspace initialization incomplete');
    const markerSt = checkedLstat(marker, 'workspace marker');
    if (!sameIdentity(authority.marker, markerSt)) throw new Error('workspace marker identity changed');
    const baseIntent = { sequence: operationSequence + 1, kind, generation: ownerGeneration, workflowRunId: options.workflowRunId, projectRoot, stageRoot, stageRootIdentity: freezeClone(authority.root), markerPath: marker, markerIdentity: freezeClone(authority.marker), markerOwner: owner, path: rel, candidateHash, preimageHash, postimageHash };
    const intent: WorkspaceEffectIntent = ownerEvidence ? { ...baseIntent, ownerEvidence: freezeClone(ownerEvidence) } : baseIntent;
    let beforeCalled = false;
    let afterSaved = false;
    const capacity = options.effectHooks?.beforeEffect || options.effectHooks?.assertEffectCapacity ? projectEffectCapacity(intent) : undefined;
    if (options.effectHooks?.beforeEffect) {
      try { options.effectHooks.beforeEffect(freezeClone(intent), capacity); beforeCalled = true; }
      catch (error) {
        // Root-ready publishers opt into retained partial-artifact evidence. A failed
        // intent publication may already be durable: do not clean that evidence.
        if (options.effectHooks.rootReady) {
          poisoned = uncertaintyError(`beforeEffect publication uncertain: ${message(error)}`, error, null);
          throw poisoned;
        }
        throw error; // Preserve the legacy hook contract when root-ready is absent.
      }
    }
    operationSequence++;
    try {
      if (beforeCalled) options.assertAuthority();
      // Pure owner-side capacity recheck after all host callbacks, without another
      // publication or host callback between this check and the physical effect.
      if (options.effectHooks?.assertEffectCapacity) options.effectHooks.assertEffectCapacity(freezeClone(intent), capacity!);
      assertActive();
      const refreshedMarker = checkedLstat(marker, 'workspace marker');
      if (!sameIdentity(intent.markerIdentity, refreshedMarker)) throw new Error('workspace marker identity changed after effect intent');
    } catch (error) {
      const observation: WorkspaceEffectObservation = { ...intent, status: 'rejected', error: message(error).slice(0, 1024), observedPostimageHash: kind === 'destination-write' ? observeHash(projectRoot, baselines.get(rel), limits) : observeStageHash(stageRoot, rel, limits) };
      try { if (options.effectHooks?.afterEffect) { options.effectHooks.afterEffect(freezeClone(observation)); afterSaved = true; } }
      catch (saveError) {
        if (options.effectHooks?.rootReady) {
          poisoned = uncertaintyError(`rejected effect publication uncertain: ${message(saveError)}`, saveError, observation);
          throw poisoned;
        }
      }
      effectRecords.push({ ...observation, beforeCalled, afterSaved, recordedAt: new Date().toISOString() });
      if (options.effectHooks?.rootReady && afterSaved && options.effectHooks.assertLeaseReleaseAuthority && options.effectHooks.canSettlePreEffectRejection?.()) {
        // This is the PRE-effect rejection branch, not a missing result or failed
        // observation. Retain published stage evidence; settle only owned leases
        // through their actual durable cleanup operations. No write authority here.
        try {
          options.effectHooks.assertLeaseReleaseAuthority();
          releaseLeases(leases, ownedKeys, leaseReleaseContext());
          leasesReleased = true; activeWorkspace = false;
          const rejection = new Error(`workspace effect rejected and leases settled: ${message(error)}`);
          (rejection as Error & { workspaceRejectionSettled?: boolean }).workspaceRejectionSettled = true;
          throw rejection;
        } catch (cleanupError) {
          if ((cleanupError as { workspaceRejectionSettled?: boolean })?.workspaceRejectionSettled) throw cleanupError;
          poisoned = uncertaintyError(`rejected effect cleanup uncertain: ${message(cleanupError)}`, cleanupError, observation);
          throw poisoned;
        }
      }
      if (options.effectHooks?.rootReady) {
        poisoned = uncertaintyError(`post-intent authority/ownership rejected: ${message(error)}`, error, observation);
        throw poisoned;
      }
      throw error;
    }
    let observation: WorkspaceEffectObservation;
    try {
      const observed = effect();
      observation = observed ? { ...intent, ...observed, sequence: intent.sequence, generation: intent.generation, workflowRunId: intent.workflowRunId, projectRoot: intent.projectRoot, stageRoot: intent.stageRoot, markerPath: intent.markerPath, markerIdentity: intent.markerIdentity, markerOwner: intent.markerOwner, path: intent.path, candidateHash: intent.candidateHash, preimageHash: intent.preimageHash, postimageHash: intent.postimageHash } as WorkspaceEffectObservation : { ...intent, status: 'observed', observedPostimageHash: postimageHash };
    } catch (error) {
      observation = { ...intent, status: 'uncertain', error: message(error).slice(0, 1024), observedPostimageHash: kind === 'destination-write' ? observeHash(projectRoot, baselines.get(rel), limits) : observeStageHash(stageRoot, rel, limits) };
      effectRecords.push({ ...observation, beforeCalled, afterSaved: false, recordedAt: new Date().toISOString() });
      poisoned = uncertaintyError(`${kind} effect uncertain: ${message(error)}`, error, observation);
      try { options.assertAuthority(); } catch {}
      throw poisoned;
    }
    try {
      if (options.effectHooks?.afterEffect) { options.effectHooks.afterEffect(freezeClone(observation)); afterSaved = true; }
      if (options.effectHooks?.rootReady) { options.assertAuthority(); assertOwnedRetained(); }
      effectRecords.push({ ...observation, beforeCalled, afterSaved, recordedAt: new Date().toISOString() });
      if (kind === 'stage-write') authority!.fileGenerations.set(rel, ownerGeneration);
      return observation;
    } catch (error) {
      const uncertainObservation = { ...observation, status: 'uncertain' as const, error: message(error).slice(0, 1024) };
      effectRecords.push({ ...uncertainObservation, beforeCalled, afterSaved: false, recordedAt: new Date().toISOString() });
      poisoned = uncertaintyError(`afterEffect failed: ${message(error)}`, error, uncertainObservation);
      try { options.assertAuthority(); } catch {}
      throw poisoned;
    }
  }


  function projectEffectCapacity(intent: WorkspaceEffectIntent): WorkspaceEffectCapacity {
    // Include the FULL representation, even during constructor copies and before
    // deep stage directories exist. Numeric strings deliberately overestimate
    // serialized filesystem numbers; none of this is published as evidence.
    const number = '9'.repeat(32);
    const id = { dev: number, ino: number, mode: number, uid: number, gid: number, size: number, mtimeMs: number };
    // JSON escaping can cost six bytes per UTF-16 error code unit.
    const observation = { ...intent, status: 'uncertain', error: '\u0000'.repeat(1024), observedPostimageHash: 'f'.repeat(64) };
    const { recordedAt: _time, ...root } = buildRootReadyEvidence();
    return deepFreeze({ observation, manifest: {
      ...root,
      candidateEntries: writables.map(path => ({ path, exists: true, sha256: 'f'.repeat(64), bytes: number, identity: id, generation: ownerGeneration })),
      declaredStageDirs: [...expectedDirs].map(path => ({ path, identity: id })),
      declaredStageFiles: manifested.map(path => ({ path, identity: id, generation: ownerGeneration, sha256: 'f'.repeat(64), bytes: number })),
      destinationLeases: leases.map(lease => ({ ...leaseEvidence(lease), leaseDirIdentity: id, ownerFileIdentity: id })),
      effects: [...effectRecords, { ...observation, beforeCalled: true, afterSaved: true, recordedAt: new Date().toISOString() }],
    } });
  }

  function buildRootReadyEvidence(): WorkspaceRootReadyEvidence {
    if (!authority || !stageRoot || !marker) throw new Error('workspace initialization incomplete');
    const entries = [...baselines.values()].map((b) => ({ path: b.path, exists: b.exists, sha256: b.exists ? hashBytes(b.bytes!) : null, bytes: b.exists ? b.bytes!.length : null, file: b.file ? freezeClone(b.file) : null, parentChain: freezeClone(b.parentChain) }));
    return deepFreeze({ version: 1 as const, workflowRunId: options.workflowRunId, ownerGeneration, projectRoot, projectRootIdentity: freezeClone(originalProjectIdentity), stageRoot, stageRootIdentity: freezeClone(authority.root), markerPath: marker, markerIdentity: freezeClone(authority.marker), markerOwner: owner, ...(ownerEvidence ? { ownerEvidence: freezeClone(ownerEvidence) } : {}), inputPaths: [...inputs], writablePaths: [...writables], allowedPaths: manifested, baselineHash: hash(JSON.stringify(entries.map((e) => ({ path: e.path, exists: e.exists, sha256: e.sha256, bytes: e.bytes })))), baselineEntries: entries, destinationLeases: leases.map((lease) => leaseEvidence(lease)), recordedAt: new Date().toISOString() });
  }

  function buildRecoveryManifestUnsafe(): WorkspaceRecoveryManifest | null {
    if (!authority || !stageRoot || !marker) return null;
    const entries = [...baselines.values()].map((b) => ({ path: b.path, exists: b.exists, sha256: b.exists ? hashBytes(b.bytes!) : null, bytes: b.exists ? b.bytes!.length : null, file: b.file ? freezeClone(b.file) : null, parentChain: freezeClone(b.parentChain) }));
    const candidateEntries = writables.map((rel) => candidateEntry(stageRoot, rel, authority!, limits));
    const manifest: WorkspaceRecoveryManifest = {
      version: 1,
      workflowRunId: options.workflowRunId,
      ownerGeneration,
      projectRoot,
      projectRootIdentity: freezeClone(originalProjectIdentity),
      stageRoot,
      stageRootIdentity: freezeClone(authority!.root),
      markerPath: marker,
      markerIdentity: freezeClone(authority!.marker),
      markerOwner: owner,
      ...(ownerEvidence ? { ownerEvidence: freezeClone(ownerEvidence) } : {}),
      inputPaths: [...inputs],
      writablePaths: [...writables],
      allowedPaths: manifested,
      baselineHash: hash(JSON.stringify(entries.map((e) => ({ path: e.path, exists: e.exists, sha256: e.sha256, bytes: e.bytes })))),
      baselineEntries: entries,
      candidateEntries,
      declaredStageDirs: [...authority!.dirs.entries()].map(([path, id]) => ({ path, identity: freezeClone(id) })),
      declaredStageFiles: [...authority!.files.entries()].map(([path, id]) => {
        const bytes = readFileBounded(join(stageRoot, path), limits.maxFileBytes, `stage file too large: ${path}`);
        return { path, identity: freezeClone(id), generation: authority!.fileGenerations.get(path) ?? ownerGeneration, sha256: hashBytes(bytes), bytes: bytes.length };
      }),
      destinationLeases: leases.map((lease) => leaseEvidence(lease)),
      effects: effectRecords.map((r) => freezeClone(r)),
    };
    return deepFreeze(manifest);
  }

  function uncertaintyError(text: string, cause: unknown, possibleEffect: WorkspaceEffectObservation | null): WorkspaceEffectUncertaintyError {
    return new WorkspaceEffectUncertaintyError(text, { lastKnownManifest: safeManifest(), intendedScope: { workflowRunId: options.workflowRunId, projectRoot, stageRoot, markerPath: marker, allowedPaths: manifested }, generation: ownerGeneration, possibleEffect, cause });
  }

  function safeManifest(): WorkspaceRecoveryManifest | null { try { return buildRecoveryManifestUnsafe(); } catch { return null; } }
  function leaseReleaseContext(): LeaseReleaseContext {
    return { workflowRunId: options.workflowRunId, generation: ownerGeneration, beforeLeaseRelease: options.effectHooks?.beforeLeaseRelease, afterLeaseRelease: options.effectHooks?.afterLeaseRelease, assertAuthorityBeforeMutation: options.effectHooks?.assertLeaseReleaseAuthority, assertCapacityBeforeMutation: options.effectHooks?.assertLeaseReleaseCapacity, nextSequence: () => ++operationSequence, manifest: safeManifest, scope: () => ({ workflowRunId: options.workflowRunId, projectRoot, stageRoot, markerPath: marker, allowedPaths: manifested }) };
  }
  function poisonLeaseRelease(error: unknown): never {
    poisoned = error instanceof Error ? error : new Error(message(error));
    activeWorkspace = false;
    throw poisoned;
  }

  function recoveryManifest(): WorkspaceRecoveryManifest {
    assertOwnedRetained();
    return buildRecoveryManifestUnsafe()!;
  }

  function inspect(): WorkspaceCandidate {
    assertOwnedRetained();
    inventoryStage(stageRoot, authority!, expectedDirs, expectedFiles, inputSet, writableSet, limits);
    verifyReadonlyInputs(stageRoot, baselines, inputSet, writableSet, limits);
    const files: WorkspaceCandidate['files'] = [];
    let totalManifestedBytes = 0;
    for (const rel of inputs) if (!writableSet.has(rel)) totalManifestedBytes += baselines.get(rel)?.bytes?.length ?? 0;
    if (totalManifestedBytes > limits.maxTotalBytes) throw new Error('candidate total too large');
    for (const rel of writables) {
      const baseline = baselines.get(rel)!;
      const abs = join(stageRoot, rel);
      const exists = existsNoFollow(abs);
      if (exists) assertStageFile(abs, rel);
      if (!exists && baseline.exists) throw new Error(`candidate deletion unsupported: ${rel}`);
      const after = exists ? readFileBounded(abs, limits.maxFileBytes, `candidate file too large: ${rel}`) : null;
      if (after) decodeUtf8(after, `candidate is not utf8 text: ${rel}`);
      const before = baseline.exists ? Buffer.from(baseline.bytes!) : null;
      totalManifestedBytes += after?.length ?? 0;
      if (totalManifestedBytes > limits.maxTotalBytes) throw new Error('candidate total too large');
      if (!bufEqual(before, after)) {
        if (!exists && !baseline.exists) continue;
        const previewBytes = after ?? Buffer.alloc(0);
        const clipped = Math.max(0, previewBytes.length - limits.maxPreviewBytes);
        files.push({ path: rel, before: before ? Buffer.from(before) : null, after: after ? Buffer.from(after) : null, beforeHash: before ? hashBytes(before) : null, afterHash: after ? hashBytes(after) : null, preview: previewBytes.subarray(0, limits.maxPreviewBytes).toString('utf8'), clippedBytes: clipped });
      }
    }
    if (files.length > limits.maxFiles) throw new Error('too many candidate files');
    const serial = files.map((f) => ({ path: f.path, beforeHash: f.beforeHash, afterHash: f.afterHash, after: f.after?.toString('base64') ?? null }));
    return { hash: hash(JSON.stringify(serial)), changedPaths: files.map((f) => f.path), files, totalBytes: totalManifestedBytes, clippedBytes: files.reduce((n, f) => n + f.clippedBytes, 0) };
  }

  function assertFreshDestination(): void {
    assertActive();
    for (const rel of writables) assertFreshOne(projectRoot, baselines.get(rel)!, limits);
  }

  function apply(candidateHash: string): ApplyOutcome {
    applyAttempted = true;
    try {
      assertActive();
      options.assertAuthority();
      const candidate = inspect();
      if (candidate.hash !== candidateHash) return { status: 'rejected', appliedPaths: [], error: 'candidate hash mismatch' };
      for (const rel of writables) assertFreshOne(projectRoot, baselines.get(rel)!, limits);
      for (const file of candidate.files) if (file.after === null) return { status: 'rejected', appliedPaths: [], error: `deletion is unsupported: ${file.path}` };
      const appliedPaths: string[] = [];
      for (const file of candidate.files) {
        try {
          options.assertAuthority();
          assertFreshOne(projectRoot, baselines.get(file.path)!, limits);
          const base = baselines.get(file.path)!;
          recordEffect('destination-write', file.path, candidate.hash, baselineHashFor(base), file.afterHash, () => writeDestination(projectRoot, file.path, file.after, base, limits));
          appliedPaths.push(file.path);
        } catch (error) {
          return { status: poisoned || appliedPaths.length ? 'partial' : 'rejected', appliedPaths, error: message(error).slice(0, 1024) };
        }
      }
      return { status: 'applied', appliedPaths };
    } catch (error) {
      return { status: 'rejected', appliedPaths: [], error: message(error).slice(0, 1024) };
    }
  }

  return {
    get stageRoot() { return stageRoot; },
    read(path: string): string {
      assertActive();
      const rel = validateRelPath(path);
      if (!inputSet.has(rel) && !writableSet.has(rel)) throw new Error(`path not staged: ${rel}`);
      const abs = join(stageRoot, rel);
      assertStageFile(abs, rel);
      return decodeUtf8(readFileBounded(abs, limits.maxFileBytes, `read too large: ${rel}`), `not utf8 text: ${rel}`);
    },
    write(path: string, text: string): void {
      assertActive();
      options.assertAuthority();
      const rel = validateRelPath(path);
      if (!writableSet.has(rel)) throw new Error(`path is not writable: ${rel}`);
      const bytes = Buffer.from(TEXT_ENCODER.encode(text));
      if (bytes.length > limits.maxFileBytes) throw new Error(`write too large: ${rel}`);
      recordEffect('stage-write', rel, null, observeStageHash(stageRoot, rel, limits), hashBytes(bytes), () => writeStageFile(stageRoot, rel, bytes, true, expectedDirs, authority!));
      expectedFiles.add(rel);
    },
    inspect,
    assertFreshDestination,
    apply,
    recoveryManifest,
    cleanup(): void {
      assertActive();
      if (poisoned) throw new Error(`workspace effect state uncertain: ${poisoned.message}`);
      if (applyAttempted) throw new Error('cleanup refused after apply attempt; reconcile workspace manually');
      inventoryStage(stageRoot, authority!, expectedDirs, expectedFiles, inputSet, writableSet, limits);
      try { cleanupArtifacts(stageRoot, marker, owner, authority!, leases, ownedKeys, leaseReleaseContext()); } catch (error) { poisonLeaseRelease(error); }
      leasesReleased = true;
      cleaned = true;
    },
    settle(): void {
      assertOwnedRetained();
      if (poisoned) throw new Error(`workspace effect state uncertain: ${poisoned.message}`);
      inventoryStage(stageRoot, authority!, expectedDirs, expectedFiles, inputSet, writableSet, limits);
      if (!leasesReleased) { try { releaseLeases(leases, ownedKeys, leaseReleaseContext()); } catch (error) { poisonLeaseRelease(error); } leasesReleased = true; }
      activeWorkspace = false;
    },
  };
}

function validateLimits(l?: CodingWorkspaceLimits): Required<CodingWorkspaceLimits> {
  const merged = { ...DEFAULT_LIMITS, ...(l ?? {}) };
  for (const [k, v] of Object.entries(merged)) if (!Number.isSafeInteger(v) || v <= 0) throw new Error(`invalid workspace limit: ${k}`);
  if (merged.maxFiles > DEFAULT_LIMITS.maxFiles) throw new Error('maxFiles exceeds hard cap');
  if (merged.maxFileBytes > DEFAULT_LIMITS.maxFileBytes) throw new Error('maxFileBytes exceeds hard cap');
  if (merged.maxTotalBytes > DEFAULT_LIMITS.maxTotalBytes) throw new Error('maxTotalBytes exceeds hard cap');
  if (merged.maxPreviewBytes > DEFAULT_LIMITS.maxPreviewBytes) throw new Error('maxPreviewBytes exceeds hard cap');
  return merged;
}
function validateRelPath(p: string): string {
  if (!p || p.includes('\0') || p.includes('\\') || isAbsolute(p)) throw new Error(`invalid relative path: ${p}`);
  const parts = p.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`ambiguous path: ${p}`);
  if (parts.some((part) => PROTECTED.has(part) || part.startsWith('.'))) throw new Error(`protected path: ${p}`);
  return parts.join('/');
}
function unique<T>(items: T[]): T[] { return [...new Set(items)]; }
function hash(s: string): string { return createHash('sha256').update(s).digest('hex'); }
function hashBytes(b: Buffer): string { return createHash('sha256').update(b).digest('hex'); }
function message(e: unknown): string { return e instanceof Error ? e.message : String(e); }
function decodeUtf8(bytes: Buffer, err: string): string { try { return TEXT_DECODER.decode(bytes); } catch { throw new Error(err); } }
function bufEqual(a: Buffer | null, b: Buffer | null): boolean { return a === b || (!!a && !!b && a.equals(b)); }
function checkedLstat(abs: string, label: string) { try { return lstatSync(abs); } catch { throw new Error(`${label} parent/path does not exist`); } }
function directoryIdentity(st: ReturnType<typeof checkedLstat>): Identity { return { dev: st.dev, ino: st.ino, mode: st.mode, uid: st.uid, gid: st.gid }; }
function identity(st: ReturnType<typeof checkedLstat>): Identity { return { ...directoryIdentity(st), size: st.size, mtimeMs: st.mtimeMs }; }
function sameIdentity(a: Identity, st: ReturnType<typeof checkedLstat>): boolean { return a.dev === st.dev && a.ino === st.ino && a.mode === st.mode && a.uid === st.uid && a.gid === st.gid; }
function resolveExistingDirectory(path: string, name: string): string { const abs = resolve(path); assertSafeExistingDirectory(abs, name); return abs; }
function safeProjectAbs(root: string, rel: string): string { const abs = resolve(root, rel); const r = relative(root, abs); if (r.startsWith('..') || isAbsolute(r)) throw new Error(`path escapes project: ${rel}`); return abs; }
function assertSafeExistingDirectory(abs: string, label: string): void { assertNoSymlinkComponents(abs); const st = checkedLstat(abs, label); if (!st.isDirectory()) throw new Error(`${label} is not a directory`); if (st.isSymbolicLink()) throw new Error(`${label} is a symlink`); }
function assertSafeExistingFile(abs: string, rel: string): void { assertNoSymlinkComponents(abs); const st = checkedLstat(abs, rel); if (!st.isFile()) throw new Error(`not a regular file: ${rel}`); if (st.isSymbolicLink()) throw new Error(`symlink file rejected: ${rel}`); if (st.nlink !== 1) throw new Error(`hardlink rejected: ${rel}`); }
function assertStageFile(abs: string, rel: string): void { const st = checkedLstat(abs, rel); if (!st.isFile()) throw new Error(`stage file invalid: ${rel}`); if (st.isSymbolicLink() || st.nlink !== 1 || (st.mode & 0o111) !== 0) throw new Error(`unsafe stage file: ${rel}`); }
function assertNoSymlinkComponents(abs: string): void { let cur = isAbsolute(abs) ? sep : ''; for (const part of abs.split(sep).filter(Boolean)) { cur = join(cur, part); const st = checkedLstat(cur, cur); if (st.isSymbolicLink()) throw new Error(`symlink component rejected: ${abs}`); } }
function existsNoFollow(abs: string): boolean { try { lstatSync(abs); return true; } catch (e: any) { if (e?.code === 'ENOENT') return false; throw e; } }
function readFileBounded(abs: string, max: number, tooLarge: string): Buffer {
  const fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.isSymbolicLink?.() || before.size > max) throw new Error(tooLarge);
    const out = Buffer.alloc(before.size);
    let off = 0;
    while (off < out.length) { const n = readSync(fd, out, off, out.length - off, off); if (n <= 0) break; off += n; }
    const after = fstatSync(fd);
    if (!sameIdentity(identity(before as any), after as any) || after.size !== before.size || off !== out.length) throw new Error(`file changed while reading: ${abs}`);
    return out;
  } finally { closeSync(fd); }
}
function parentPaths(abs: string): string[] { const out: string[] = []; let cur = dirname(abs); while (cur && cur !== dirname(cur)) { out.push(cur); cur = dirname(cur); if (out.length > 128) throw new Error('path too deep'); } return out; }
function parentChain(abs: string): { paths: string[]; ids: Identity[] } { const paths = parentPaths(abs); return { paths, ids: paths.map((p) => directoryIdentity(checkedLstat(p, p))) }; }
function baselineFor(root: string, rel: string, bytes: Buffer): Baseline { const abs = safeProjectAbs(root, rel); const st = checkedLstat(abs, rel); const parents = parentChain(abs); return { path: rel, abs, exists: true, parentPaths: parents.paths, parentChain: parents.ids, bytes: Buffer.from(bytes), mode: st.mode & 0o666, file: { ...identity(st), hash: hashBytes(bytes) } }; }
function baselineForMissing(root: string, rel: string): Baseline { const abs = safeProjectAbs(root, rel); const parents = parentChain(abs); return { path: rel, abs, exists: false, parentPaths: parents.paths, parentChain: parents.ids }; }
function expectedStageDirs(files: string[]): Set<string> { const dirs = new Set(['']); for (const f of files) { let cur = ''; for (const part of f.split('/').slice(0, -1)) { cur = cur ? `${cur}/${part}` : part; dirs.add(cur); } } return dirs; }
function ensureStageDir(root: string, relDir: string, expected: Set<string>, auth: StageAuthority): string {
  if (!expected.has(relDir)) throw new Error(`unexpected stage directory: ${relDir}`);
  let curRel = '';
  let curAbs = root;
  for (const part of relDir.split('/').filter(Boolean)) {
    curRel = curRel ? `${curRel}/${part}` : part;
    curAbs = join(root, curRel);
    if (!existsNoFollow(curAbs)) mkdirSync(curAbs, { mode: 0o700 });
    const st = checkedLstat(curAbs, curRel);
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`unsafe stage directory: ${curRel}`);
    const old = auth.dirs.get(curRel);
    if (old && !sameIdentity(old, st)) throw new Error(`stage directory identity changed: ${curRel}`);
    auth.dirs.set(curRel, identity(st));
  }
  return curAbs;
}
function writeStageFile(stageRoot: string, rel: string, bytes: Buffer, mutable: boolean, expectedDirs: Set<string>, auth: StageAuthority): void {
  const parent = ensureStageDir(stageRoot, dirname(rel) === '.' ? '' : dirname(rel), expectedDirs, auth);
  const abs = join(stageRoot, rel);
  if (existsNoFollow(abs)) { assertStageFile(abs, rel); chmodSync(abs, 0o600); }
  const tmp = join(parent, `.${basename(rel)}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tmp, bytes, { flag: 'wx', mode: mutable ? 0o600 : 0o400 });
  fsyncFile(tmp);
  renameSync(tmp, abs);
  chmodSync(abs, mutable ? 0o600 : 0o400);
  fsyncFile(abs); fsyncDir(parent);
  auth.files.set(rel, identity(checkedLstat(abs, rel)));
}
function inventoryStage(root: string, auth: StageAuthority, expectedDirs: Set<string>, expectedFiles: Set<string>, inputs: Set<string>, writables: Set<string>, limits: Required<CodingWorkspaceLimits>): void {
  if (expectedDirs.size > limits.maxFiles + 1 || expectedFiles.size > limits.maxFiles) throw new Error('stage inventory bounds invalid');
  const stack = ['']; let fileCount = 0; let entryCount = 0; const maxEntries = limits.maxFiles + expectedDirs.size + 1;
  while (stack.length) {
    const rel = stack.pop()!;
    if (!expectedDirs.has(rel)) throw new Error(`unexpected stage directory: ${rel}`);
    const abs = rel ? join(root, rel) : root;
    const st = checkedLstat(abs, rel || 'stageRoot');
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`unsafe stage directory: ${rel}`);
    const old = auth.dirs.get(rel); if (!old || !sameIdentity(old, st)) throw new Error(`stage directory identity changed: ${rel || '.'}`);
    const dir = opendirSync(abs);
    try {
      for (;;) {
        if (entryCount > maxEntries) throw new Error('stage listing too large');
        const ent = dir.readSync();
        if (!ent) break;
        entryCount++;
        if (entryCount > maxEntries) throw new Error('stage listing too large');
        const name = ent.name;
        if (rel === '' && name === '.coding-workspace-owner.json') continue;
        if (name.startsWith('.')) throw new Error(`unexpected hidden stage entry: ${name}`);
        const childRel = rel ? `${rel}/${name}` : name;
        const childAbs = join(root, childRel);
        const cst = checkedLstat(childAbs, childRel);
        if (cst.isSymbolicLink()) throw new Error(`stage symlink rejected: ${childRel}`);
        if (cst.isDirectory()) { if (!expectedDirs.has(childRel)) throw new Error(`unexpected stage directory: ${childRel}`); stack.push(childRel); continue; }
        if (!cst.isFile() || cst.nlink !== 1 || (cst.mode & 0o111) !== 0) throw new Error(`unsafe stage entry: ${childRel}`);
        if (!expectedFiles.has(childRel) && !writables.has(childRel)) throw new Error(`unexpected stage file: ${childRel}`);
        if (++fileCount > limits.maxFiles) throw new Error('too many stage files');
      }
    } finally { dir.closeSync(); }
  }
}
function verifyReadonlyInputs(root: string, baselines: Map<string, Baseline>, inputs: Set<string>, writables: Set<string>, limits: Required<CodingWorkspaceLimits>): void {
  for (const rel of inputs) if (!writables.has(rel)) {
    const base = baselines.get(rel)!;
    const abs = join(root, rel);
    assertStageFile(abs, rel);
    const st = checkedLstat(abs, rel);
    if ((st.mode & 0o777) !== 0o400) throw new Error(`readonly stage mode changed: ${rel}`);
    const bytes = readFileBounded(abs, limits.maxFileBytes, `readonly stage too large: ${rel}`);
    if (!bytes.equals(base.bytes!)) throw new Error(`readonly stage content changed: ${rel}`);
  }
}
function assertOwnedStage(stageRoot: string, marker: string, owner: string, auth: StageAuthority): void {
  assertSafeExistingDirectory(stageRoot, 'stageRoot');
  const rst = checkedLstat(stageRoot, 'stageRoot'); if (!sameIdentity(auth.root, rst)) throw new Error('stageRoot identity changed');
  const mst = checkedLstat(marker, 'workspace marker'); if (!sameIdentity(auth.marker, mst) || !mst.isFile() || mst.size > 4096) throw new Error('workspace marker identity changed');
  if (marker !== join(stageRoot, '.coding-workspace-owner.json')) throw new Error('workspace marker path mismatch');
  const text = decodeUtf8(readFileBounded(marker, 4096, 'workspace marker too large'), 'workspace marker is not utf8');
  const data = JSON.parse(text); if (data.owner !== owner || data.stageRoot !== stageRoot) throw new Error('workspace ownership marker mismatch');
}
function assertFreshOne(root: string, base: Baseline, limits: Required<CodingWorkspaceLimits>): void {
  const now = parentChain(base.abs);
  if (now.ids.length !== base.parentChain.length) throw new Error(`parent identity changed: ${base.path}`);
  for (let i = 0; i < now.ids.length; i++) if (now.paths[i] !== base.parentPaths[i] || !sameIdentity(base.parentChain[i], checkedLstat(now.paths[i], now.paths[i]))) throw new Error(`parent identity changed: ${base.path}`);
  if (!existsNoFollow(base.abs)) { if (base.exists) throw new Error(`destination deleted: ${base.path}`); return; }
  assertSafeExistingFile(base.abs, base.path);
  const st = checkedLstat(base.abs, base.path);
  if (!base.exists) throw new Error(`destination unexpectedly exists: ${base.path}`);
  if (!sameIdentity(base.file!, st)) throw new Error(`destination identity changed: ${base.path}`);
  if (st.size !== base.file!.size || st.mtimeMs !== base.file!.mtimeMs) throw new Error(`destination metadata changed: ${base.path}`);
  const bytes = readFileBounded(base.abs, limits.maxFileBytes, `destination too large: ${base.path}`);
  if (hashBytes(bytes) !== base.file!.hash) throw new Error(`destination content changed: ${base.path}`);
  if ((st.mode & 0o111) !== 0) throw new Error(`destination executable changed: ${base.path}`);
}
function writeDestination(root: string, rel: string, after: Buffer | null, base: Baseline, limits: Required<CodingWorkspaceLimits>): Partial<WorkspaceEffectObservation> {
  const abs = safeProjectAbs(root, rel);
  if (after === null) throw new Error(`deletion is unsupported: ${rel}`);
  if (after.length > limits.maxFileBytes) throw new Error(`candidate file too large: ${rel}`);
  decodeUtf8(after, `candidate is not utf8 text: ${rel}`);
  const parent = dirname(abs);
  assertSafeExistingDirectory(parent, `destination parent for ${rel}`);
  const pst = checkedLstat(parent, parent);
  const tmp = join(parent, `.${basename(abs)}.coding-${process.pid}-${randomUUID()}.tmp`);
  let phase: 'pre-open' | 'pre-rename' | 'post-rename' = 'pre-open';
  let renamed = false;
  try {
    const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, base.exists ? (base.mode ?? 0o600) : 0o600);
    phase = 'pre-rename';
    try { writeFileSync(fd, after); fsyncSync(fd); } finally { closeSync(fd); }
    const pst2 = checkedLstat(parent, parent); if (!sameIdentity(identity(pst), pst2)) throw new Error(`destination parent changed: ${rel}`);
    assertFreshOne(root, base, limits);
    renameSync(tmp, abs);
    renamed = true; phase = 'post-rename';
    fsyncDir(parent);
    const observed = readFileBounded(abs, limits.maxFileBytes, `destination too large after write: ${rel}`);
    const observedHash = hashBytes(observed);
    if (observedHash !== hashBytes(after)) throw new Error(`destination observed hash mismatch: ${rel}`);
    return { preimageHash: baselineHashFor(base), postimageHash: hashBytes(after), status: 'observed', observedPostimageHash: observedHash };
  } catch (error) {
    if (!renamed) { try { if (existsNoFollow(tmp)) unlinkSync(tmp); } catch {} }
    throw new Error(`destination write failed ${phase}: ${message(error)}`);
  }
}

function fsyncFile(abs: string): void { const fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
function fsyncDir(abs: string): void { const fd = openSync(abs, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
function baselineHashFor(base: Baseline | undefined): string | null { return base?.exists ? hashBytes(base.bytes!) : null; }
function observeHash(root: string, base: Baseline | undefined, limits: Required<CodingWorkspaceLimits>): string | null {
  if (!base) return null;
  try {
    const abs = safeProjectAbs(root, base.path);
    if (abs !== base.abs) return null;
    if (!parentChainMatches(abs, base.parentChain)) return null;
    if (!existsNoFollow(abs)) return null;
    assertSafeExistingFile(abs, base.path);
    return hashBytes(readFileBounded(abs, limits.maxFileBytes, `observed destination too large: ${base.path}`));
  } catch { return null; }
}
function observeStageHash(stageRoot: string, rel: string, limits: Required<CodingWorkspaceLimits>): string | null {
  try {
    validateRelPath(rel);
    const abs = join(stageRoot, rel);
    assertNoSymlinkComponents(dirname(abs));
    if (!existsNoFollow(abs)) return null;
    assertStageFile(abs, rel);
    const st = checkedLstat(abs, rel);
    const rootSt = checkedLstat(stageRoot, 'stageRoot');
    if (st.uid !== rootSt.uid) return null;
    return hashBytes(readFileBounded(abs, limits.maxFileBytes, `observed stage too large: ${rel}`));
  } catch { return null; }
}
function candidateEntry(stageRoot: string, rel: string, auth: StageAuthority, limits: Required<CodingWorkspaceLimits>): { path: string; exists: boolean; sha256: string | null; bytes: number | null; identity: Identity | null; generation: string | null } {
  const abs = join(stageRoot, rel);
  const absent = { path: rel, exists: false, sha256: null, bytes: null, identity: null, generation: null };
  assertNoSymlinkComponents(stageRoot);
  let parent = stageRoot;
  for (const part of rel.split('/').slice(0, -1)) {
    parent = join(parent, part);
    if (!existsNoFollow(parent)) return absent;
    const st = checkedLstat(parent, parent);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`unsafe candidate parent: ${rel}`);
  }
  if (!existsNoFollow(abs)) return absent;
  assertStageFile(abs, rel);
  const st = checkedLstat(abs, rel);
  const rootSt = checkedLstat(stageRoot, 'stageRoot');
  if (st.uid !== rootSt.uid) throw new Error(`candidate file owner changed: ${rel}`);
  const bytes = readFileBounded(abs, limits.maxFileBytes, `candidate file too large: ${rel}`);
  return { path: rel, exists: true, sha256: hashBytes(bytes), bytes: bytes.length, identity: identity(st), generation: auth.fileGenerations.get(rel) ?? null };
}
function parentChainMatches(abs: string, expected: readonly Identity[]): boolean {
  const now = parentChain(abs);
  if (now.ids.length !== expected.length) return false;
  for (let i = 0; i < expected.length; i++) if (!sameIdentity(expected[i], checkedLstat(now.paths[i], now.paths[i]))) return false;
  return true;
}
function freezeClone<T>(value: T): T { return deepFreeze(structuredClone(value)); }
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object') { Object.freeze(value); for (const v of Object.values(value as any)) deepFreeze(v); } return value; }

export type RetainedWorkspaceSettlement = { state: 'verifiable-owner' | 'settlement-unknown'; adoptable: boolean; reason?: string; retainedLeases?: readonly RetainedLeaseEvidence[] };
export type RetainedWorkspaceInspection = { status: 'safe' | 'unsafe'; candidateHash?: string; settlement: RetainedWorkspaceSettlement; error?: string; classifications: Array<{ path: string; class: 'preimage' | 'postimage' | 'conflict' | 'unknown'; recordedApplication: 'none' | 'recorded' | 'uncertain' | 'rejected'; observedHash: string | null; intendedPostimageHash: string | null; recordedEffects: WorkspaceEffectRecord[] }>; readonlyObservations: Array<{ path: string; observedHash: string | null; projectObservedHash?: string | null; safe: boolean }>; recordedOutcome: readonly WorkspaceEffectRecord[]; manifest: WorkspaceRecoveryManifest | null };
export function inspectRetainedCodingWorkspaceManifest(rawManifest: unknown, scope: RetainedWorkspaceTrustedScope): RetainedWorkspaceInspection {
  const limits = validateLimits(scope.limits);
  let manifest: WorkspaceRecoveryManifest;
  try { manifest = workflowJson(rawManifest, WORKFLOW_LIMITS.ledgerBytes) as unknown as WorkspaceRecoveryManifest; } catch (error) { return deepFreeze({ status: 'unsafe', settlement: { state: 'settlement-unknown', adoptable: false, reason: 'manifest is not bounded plain JSON' }, error: message(error).slice(0, 1024), classifications: [], readonlyObservations: [], recordedOutcome: [], manifest: null }); }
  try { validateRecoveryManifest(manifest, scope, limits); } catch (error) { return deepFreeze({ status: 'unsafe', settlement: settlementForManifest(manifest), error: message(error).slice(0, 1024), classifications: [], readonlyObservations: [], recordedOutcome: [], manifest }); }
  try {
    assertSafeExistingDirectory(manifest.projectRoot, 'projectRoot');
    if (!sameIdentity(manifest.projectRootIdentity, checkedLstat(manifest.projectRoot, 'projectRoot'))) throw new Error('projectRoot identity changed');
    assertSafeExistingDirectory(manifest.stageRoot, 'stageRoot');
    if (!sameIdentity(manifest.stageRootIdentity, checkedLstat(manifest.stageRoot, 'stageRoot'))) throw new Error('stageRoot identity changed');
    const mst = checkedLstat(manifest.markerPath, 'workspace marker');
    if (!sameIdentity(manifest.markerIdentity, mst) || !mst.isFile() || mst.isSymbolicLink()) throw new Error('workspace marker identity changed');
    const markerText = decodeUtf8(readFileBounded(manifest.markerPath, 4096, 'workspace marker too large'), 'workspace marker is not utf8');
    const marker = JSON.parse(markerText);
    if (marker.owner !== manifest.markerOwner || marker.workflowRunId !== manifest.workflowRunId || marker.ownerGeneration !== manifest.ownerGeneration || marker.projectRoot !== manifest.projectRoot || marker.stageRoot !== manifest.stageRoot) throw new Error('workspace marker content mismatch');
    validateDeclaredStage(manifest, limits);
    const classes = manifest.writablePaths.map((rel) => classifyDestination(manifest, rel, limits));
    const readonlyObservations = manifest.inputPaths.filter((p) => !manifest.writablePaths.includes(p)).map((path) => {
      const h = observeStageHash(manifest.stageRoot, path, limits);
      const entry = manifest.baselineEntries.find(e => e.path === path);
      const abs = safeProjectAbs(manifest.projectRoot, path);
      if (!entry || !parentChainMatches(abs, entry.parentChain)) throw new Error(`readonly project input changed: ${path}`);
      assertSafeExistingFile(abs, path);
      const current = checkedLstat(abs, path);
      if (!entry.file || !sameIdentity(entry.file, current)) throw new Error(`readonly project input changed: ${path}`);
      const projectObservedHash = hashBytes(readFileBounded(abs, limits.maxFileBytes, `readonly project input too large: ${path}`));
      return { path, observedHash: h, projectObservedHash, safe: h === entry.sha256 && projectObservedHash === entry.sha256 };
    });
    if (readonlyObservations.some(o => !o.safe)) throw new Error('readonly project input changed or retained stage observation mismatch');
    return deepFreeze({ status: 'safe', candidateHash: retainedCandidateHash(manifest, limits), settlement: settlementForManifest(manifest), classifications: classes, readonlyObservations, recordedOutcome: manifest.effects.map((e) => freezeClone(e)), manifest });
  } catch (error) {
    return deepFreeze({ status: 'unsafe', settlement: settlementForManifest(manifest), error: message(error).slice(0, 1024), classifications: [], readonlyObservations: [], recordedOutcome: manifest.effects.map((e) => freezeClone(e)), manifest });
  }
}


export type PartialArtifactObservedCandidate = Readonly<{ observed: true; source: 'root-ready-plus-latest-stage-intent'; candidateHash: string; changedPaths: readonly string[]; files: readonly { path: string; beforeHash: string | null; afterHash: string; bytes: number; sha256: string; base64: string }[]; invalidatesHistoricalClaims: true }>;
export type PartialArtifactInspection = Readonly<{
  status: 'safe' | 'blocked'; mode: 'fresh-reconstruction-only' | 'observed-candidate-carry' | 'blocked'; blockers: readonly string[];
  rootReady?: WorkspaceRootReadyEvidence; latestIntent?: WorkspaceEffectIntent; observedCandidate?: PartialArtifactObservedCandidate;
  /** Fresh observation for carry verification, NOT the original recorded manifest. */
  observedManifest?: WorkspaceRecoveryManifest;
  settlement?: { localOwner: 'dead'; checks: 'unknown'; native: 'unknown'; admission: false };
}>;
export type PartialArtifactsTrustedScope = RetainedWorkspaceTrustedScope & { inputPaths: readonly string[]; writablePaths: readonly string[] };
export type InspectPartialArtifactsOptions = Readonly<{ rootReadyEvidence: unknown; latestIntent?: unknown; recordedManifest?: unknown; recordedResults?: unknown; trustedScope: PartialArtifactsTrustedScope }>;

/** Observation only. No lease acquisition/release, artifact mutation, replay, or admission. */
export function inspectPartialWorkspaceArtifacts(options: InspectPartialArtifactsOptions): PartialArtifactInspection { return inspectPartialArtifacts(options, false); }
/** Root-only observation. Runtime separately binds zero effects to the source checkpoint. */
export function inspectRootReadyWorkspaceArtifacts(options: InspectPartialArtifactsOptions): PartialArtifactInspection { return inspectPartialArtifacts(options, true); }
function inspectPartialArtifacts(options: InspectPartialArtifactsOptions, allowRootOnly: boolean): PartialArtifactInspection {
  try {
    const limits = validateLimits(options.trustedScope.limits);
    const root = validateRootReadyEvidence(options.rootReadyEvidence, options.trustedScope, limits);
    if (!root.ownerEvidence) throw new Error('root-ready lacks owner evidence');
    if (root.markerOwner !== `${root.workflowRunId}:${root.ownerEvidence.pid}:${root.ownerGeneration}`) throw new Error('root-ready owner PID mismatch');
    assertOldOwnerSafelyDead(root.ownerEvidence);
    assertRootReadyStillOwned(root, limits);
    const intent = options.latestIntent === undefined ? undefined : validateLatestStageIntent(options.latestIntent, root);
    const baseline = new Map(root.baselineEntries.map(e => [e.path, e]));
    const writable = new Set(root.writablePaths);
    let recorded: WorkspaceRecoveryManifest | undefined;
    if (options.recordedManifest !== undefined) {
      recorded = workflowJson(options.recordedManifest, WORKFLOW_LIMITS.ledgerBytes) as unknown as WorkspaceRecoveryManifest;
      validateRecoveryManifest(recorded, options.trustedScope, limits);
      for (const key of ['workflowRunId','ownerGeneration','projectRoot','projectRootIdentity','stageRoot','stageRootIdentity','markerPath','markerIdentity','markerOwner','ownerEvidence','inputPaths','writablePaths','allowedPaths','baselineHash','baselineEntries','destinationLeases'] as const) {
        if (JSON.stringify(recorded[key]) !== JSON.stringify(root[key])) throw new Error(`recorded manifest conflicts with root-ready: ${key}`);
      }
    }
    // Require a complete, ordered chain of real receipts. Missing receipts are unknown,
    // not implicit baseline copies or native completions.
    const results = options.recordedResults === undefined ? [] : workflowJson(options.recordedResults, WORKFLOW_LIMITS.ledgerBytes);
    if (!Array.isArray(results) || results.length > 512) throw new Error('recorded results must be bounded effect observations');
    const known = new Map(root.allowedPaths.map(path => [path, null as string | null]));
    const receipts: WorkspaceEffectObservation[] = [];
    for (const raw of results) {
      const result = raw as unknown as WorkspaceEffectObservation;
      assertPlainObject(result, 'recorded result');
      const { status, observedPostimageHash, error, ...rawIntent } = result;
      const ri = validateLatestStageIntent(rawIntent, root);
      if (ri.sequence !== receipts.length + 1 || (intent && ri.sequence >= intent.sequence)) throw new Error('recorded result sequence conflicts with pending intent');
      if (status !== 'observed' || error !== undefined || observedPostimageHash !== ri.postimageHash) throw new Error('recorded result uncertain or conflicting');
      if (ri.preimageHash !== known.get(ri.path) || ri.postimageHash === null) throw new Error('recorded result preimage chain mismatch');
      const initial = ri.preimageHash === null && ri.postimageHash === baseline.get(ri.path)?.sha256;
      if (!initial && !writable.has(ri.path)) throw new Error('readonly recorded mutation');
      known.set(ri.path, ri.postimageHash); receipts.push(result);
    }
    if (intent ? intent.sequence !== receipts.length + 1 || intent.preimageHash !== known.get(intent.path) : receipts.length !== 0 || recorded !== undefined) throw new Error('missing pending intent or incomplete receipt chain');
    if (recorded) {
      for (const effect of recorded.effects) {
        const receipt = receipts.find(r => r.sequence === effect.sequence);
        if (!receipt || !effect.beforeCalled || !effect.afterSaved) throw new Error('recorded manifest effect lacks matching receipt');
        const { beforeCalled: _b, afterSaved: _a, recordedAt: _t, ...observation } = effect;
        if (JSON.stringify(observation) !== JSON.stringify(receipt)) throw new Error('recorded manifest receipt conflict');
      }
      for (const c of recorded.candidateEntries) {
        if (c.sha256 !== known.get(c.path)) throw new Error('recorded candidate conflicts with preimage chain');
      }
      for (const f of recorded.declaredStageFiles) if (f.sha256 !== known.get(f.path)) throw new Error('recorded declaration conflicts with receipt chain');
    }
    const stage = new Map<string, Buffer>();
    let total = 0;
    for (const entry of root.baselineEntries) {
      const abs = safeProjectAbs(root.projectRoot, entry.path);
      if (existsNoFollow(abs) !== entry.exists) throw new Error(`project baseline existence changed: ${entry.path}`);
      if (entry.exists) {
        assertSafeExistingFile(abs, entry.path);
        const st = checkedLstat(abs, entry.path);
        if (!entry.file || !sameIdentity(entry.file, st)) throw new Error(`project baseline identity changed: ${entry.path}`);
        const bytes = readFileBounded(abs, limits.maxFileBytes, 'project baseline too large');
        if (bytes.length !== entry.bytes || hashBytes(bytes) !== entry.sha256) throw new Error(`project baseline content changed: ${entry.path}`);
      }
      if (existsNoFollow(join(root.stageRoot, entry.path))) {
        const mode = checkedLstat(join(root.stageRoot, entry.path), entry.path).mode & 0o777;
        if ((!writable.has(entry.path) && mode !== 0o400) || (mode & 0o077) !== 0) throw new Error(`stage permission changed: ${entry.path}`);
        const bytes = readObservedStageCandidateBytes(root, entry.path, limits);
        decodeUtf8(bytes, `stage input not utf8: ${entry.path}`);
        total += bytes.length;
        if (total > limits.maxTotalBytes) throw new Error('stage total too large');
        stage.set(entry.path, bytes);
      }
    }
    const settlement = { localOwner: 'dead' as const, checks: 'unknown' as const, native: 'unknown' as const, admission: false as const };
    if (!intent) {
      if (!allowRootOnly) throw new Error('missing pending intent');
      if (stage.size !== 0) throw new Error('root-only observation has unreceipted stage bytes');
      assertRootReadyStillOwned(root, limits);
      return deepFreeze({ status: 'safe', mode: 'fresh-reconstruction-only', blockers: [], rootReady: root, settlement });
    }
    const initialCopy = intent.candidateHash === null && intent.preimageHash === null && intent.postimageHash === baseline.get(intent.path)?.sha256;
    if (initialCopy) {
      for (const entry of root.baselineEntries) {
        const bytes = stage.get(entry.path), h = bytes ? hashBytes(bytes) : null;
        const expected = known.get(entry.path);
        if (entry.path === intent.path ? h !== expected && h !== intent.postimageHash : h !== expected) throw new Error('initial staging observation conflicts with receipt chain');
        if (h !== null && h !== entry.sha256) throw new Error('initial staging contains candidate mutation');
      }
      assertRootReadyStillOwned(root, limits);
      return deepFreeze({ status: 'safe', mode: 'fresh-reconstruction-only', blockers: [], rootReady: root, latestIntent: intent, settlement });
    }
    if (!writable.has(intent.path) || intent.postimageHash === null) throw new Error('pending intent is not a candidate mutation');
    const changed: Array<{ path: string; beforeHash: string | null; afterHash: string; after: string }> = [];
    for (const entry of root.baselineEntries) {
      const bytes = stage.get(entry.path), h = bytes ? hashBytes(bytes) : null;
      if (!bytes && entry.exists) throw new Error(`stage input missing: ${entry.path}`);
      const expected = entry.path === intent.path ? intent.postimageHash : known.get(entry.path);
      if (h !== expected) throw new Error(`observed postimage conflicts with receipt chain: ${entry.path}`);
      if (!writable.has(entry.path) && h !== entry.sha256) throw new Error(`readonly stage input changed: ${entry.path}`);
    }
    // Same order and serialization as workspace.inspect(), including EVERY changed path.
    for (const path of root.writablePaths) {
      const entry = baseline.get(path)!, bytes = stage.get(path), h = bytes ? hashBytes(bytes) : null;
      if (h !== entry.sha256) {
        if (!bytes || !h) throw new Error('candidate deletion unsupported');
        changed.push({ path, beforeHash: entry.sha256, afterHash: h, after: bytes.toString('base64') });
      }
    }
    if (changed.length === 0) throw new Error('changed candidate postimage not observed');
    if (recorded) {
      for (const f of recorded.declaredStageFiles) {
        if (f.path === intent.path) continue; // Atomic replacement has a new inode.
        const bytes = stage.get(f.path);
        if (!bytes || hashBytes(bytes) !== f.sha256 || bytes.length !== f.bytes || !sameIdentity(f.identity, checkedLstat(join(root.stageRoot, f.path), f.path))) throw new Error('recorded declaration conflicts with observation');
      }
      for (const d of recorded.declaredStageDirs) if (!sameIdentity(d.identity, checkedLstat(join(root.stageRoot, d.path), d.path))) throw new Error('recorded directory identity changed');
    }
    const candidateHash = hash(JSON.stringify(changed));
    const observedCandidate: PartialArtifactObservedCandidate = { observed: true, source: 'root-ready-plus-latest-stage-intent', candidateHash, changedPaths: changed.map(f => f.path), files: changed.map(f => ({ path: f.path, beforeHash: f.beforeHash, afterHash: f.afterHash, sha256: f.afterHash, bytes: stage.get(f.path)!.length, base64: f.after })), invalidatesHistoricalClaims: true };
    const { recordedAt: _recordedAt, ...manifestRoot } = root;
    const observedManifest: WorkspaceRecoveryManifest = {
      ...freezeClone(manifestRoot), inputPaths: [...root.inputPaths], writablePaths: [...root.writablePaths], allowedPaths: [...root.allowedPaths],
      baselineEntries: root.baselineEntries.map(e => ({ ...freezeClone(e), parentChain: [...e.parentChain] })), destinationLeases: [...root.destinationLeases],
      candidateEntries: root.writablePaths.map(path => { const bytes = stage.get(path); return { path, exists: !!bytes, sha256: bytes ? hashBytes(bytes) : null, bytes: bytes?.length ?? null, identity: bytes ? identity(checkedLstat(join(root.stageRoot, path), path)) : null, generation: bytes ? root.ownerGeneration : null }; }),
      declaredStageDirs: [...expectedStageDirs([...stage.keys()])].map(path => ({ path, identity: identity(checkedLstat(join(root.stageRoot, path), path)) })),
      declaredStageFiles: [...stage].map(([path, bytes]) => ({ path, identity: identity(checkedLstat(join(root.stageRoot, path), path)), generation: root.ownerGeneration, sha256: hashBytes(bytes), bytes: bytes.length })),
      effects: recorded?.effects ?? [], // Never synthesize a receipt for the interrupted effect.
    };
    assertRootReadyStillOwned(root, limits);
    const checked = inspectRetainedCodingWorkspaceManifest(observedManifest, options.trustedScope);
    if (checked.status !== 'safe') throw new Error(`observed manifest unsafe: ${checked.error}`);
    return deepFreeze({ status: 'safe', mode: 'observed-candidate-carry', blockers: [], rootReady: root, latestIntent: intent, observedCandidate, observedManifest, settlement });
  } catch (error) { return deepFreeze({ status: 'blocked', mode: 'blocked', blockers: [message(error)] }); }
}

/** Callback-free source artifact fence after a validated partial assessment. Destination
 * leases intentionally transfer to the new generation; source bytes/identity never do.
 * Writable destination freshness is enforced by the fresh workspace, not old baselines. */
export function partialWorkspaceSourceFence(options: InspectPartialArtifactsOptions): () => boolean {
  const limits = validateLimits(options.trustedScope.limits);
  const root = validateRootReadyEvidence(options.rootReadyEvidence, options.trustedScope, limits);
  const observe = () => {
    assertRootReadyStillOwned(root, limits, false);
    const paths = [...root.allowedPaths, ...expectedStageDirs([...root.allowedPaths])];
    const stage = paths.map(path => {
      const abs = join(root.stageRoot, path);
      if (!existsNoFollow(abs)) return { path, missing: true };
      const st = checkedLstat(abs, path);
      return { path, identity: identity(st), bytes: st.isFile() ? hashBytes(readObservedStageCandidateBytes(root, path, limits)) : null };
    });
    for (const entry of root.baselineEntries.filter(e => !root.writablePaths.includes(e.path))) {
      const abs = safeProjectAbs(root.projectRoot, entry.path);
      assertSafeExistingFile(abs, entry.path);
      if (!entry.file || !sameIdentity(entry.file, checkedLstat(abs, entry.path)) || hashBytes(readFileBounded(abs, limits.maxFileBytes, 'readonly source baseline too large')) !== entry.sha256) throw new Error('Readonly source destination changed after callback');
    }
    return hash(JSON.stringify(stage));
  };
  const expected = observe();
  return () => { try { return observe() === expected; } catch { return false; } };
}

function validateRootReadyEvidence(raw: unknown, scope: PartialArtifactsTrustedScope, limits: Required<CodingWorkspaceLimits>): WorkspaceRootReadyEvidence {
  const r = workflowJson(raw, WORKFLOW_LIMITS.ledgerBytes) as unknown as WorkspaceRootReadyEvidence;
  assertPlainObject(r, 'root-ready evidence');
  const keys = ['allowedPaths','baselineEntries','baselineHash','destinationLeases','inputPaths','markerIdentity','markerOwner','markerPath','ownerGeneration','projectRoot','projectRootIdentity','recordedAt','stageRoot','stageRootIdentity','version','workflowRunId','writablePaths', ...(r.ownerEvidence !== undefined ? ['ownerEvidence'] : [])].sort();
  assertExactKeys(r, keys, 'root-ready evidence');
  if (r.version !== 1) throw new Error('root-ready version invalid');
  const projectRoot = resolveExistingDirectory(scope.projectRoot, 'HOST projectRoot'), stagingParent = resolveExistingDirectory(scope.stagingParent, 'HOST stagingParent');
  assertNoSymlinkComponents(projectRoot); assertNoSymlinkComponents(stagingParent);
  if (projectRoot === stagingParent || projectRoot.startsWith(stagingParent + sep) || stagingParent.startsWith(projectRoot + sep)) throw new Error('HOST project/staging partitions overlap');
  if (r.projectRoot !== projectRoot || r.workflowRunId !== scope.workflowRunId) throw new Error('root-ready outside trusted scope');
  if (!isAbsolute(r.stageRoot) || dirname(r.stageRoot) !== stagingParent || r.markerPath !== join(r.stageRoot, '.coding-workspace-owner.json')) throw new Error('root-ready stage outside trusted scope');
  validateId(r.workflowRunId, 'root-ready workflowRunId'); validateId(r.ownerGeneration, 'root-ready ownerGeneration');
  if (!r.markerOwner.startsWith(`${r.workflowRunId}:`) || !r.markerOwner.endsWith(`:${r.ownerGeneration}`)) throw new Error('root-ready marker owner mismatch');
  validateIdentity(r.projectRootIdentity, 'root-ready projectRootIdentity'); validateIdentity(r.stageRootIdentity, 'root-ready stageRootIdentity'); validateIdentity(r.markerIdentity, 'root-ready markerIdentity');
  if (r.ownerEvidence !== undefined) validateOwnerEvidence(r.ownerEvidence, 'root-ready ownerEvidence');
  const inputs = validateStringList(r.inputPaths, limits.maxFiles, 'root-ready inputPaths').map(validateRelPath);
  const writables = validateStringList(r.writablePaths, limits.maxFiles, 'root-ready writablePaths').map(validateRelPath);
  const hostInputs = validateStringList(scope.inputPaths, limits.maxFiles, 'HOST inputPaths').map(validateRelPath);
  const hostWritable = validateStringList(scope.writablePaths, limits.maxFiles, 'HOST writablePaths').map(validateRelPath);
  assertUnique(hostInputs, 'HOST inputs'); assertUnique(hostWritable, 'HOST writables');
  if (JSON.stringify(hostInputs) !== JSON.stringify(inputs) || JSON.stringify(hostWritable) !== JSON.stringify(writables)) throw new Error('root-ready HOST partition mismatch');
  const all = unique([...inputs, ...writables]);
  const scoped = validateStringList(scope.allowedPaths, limits.maxFiles, 'trusted allowedPaths').map(validateRelPath);
  const allowed = validateStringList(r.allowedPaths, limits.maxFiles, 'root-ready allowedPaths').map(validateRelPath);
  if (JSON.stringify(all) !== JSON.stringify(allowed) || JSON.stringify(scoped) !== JSON.stringify(allowed)) throw new Error('root-ready allowed paths invalid');
  assertUnique(inputs, 'root-ready inputs'); assertUnique(writables, 'root-ready writables'); assertUnique(allowed, 'root-ready allowed');
  if (!Array.isArray(r.baselineEntries) || r.baselineEntries.length !== all.length) throw new Error('root-ready baseline entries invalid');
  const paths: string[] = []; let total = 0;
  for (const e of r.baselineEntries as any[]) { validateBaselineEntry(e, all, limits); paths.push(e.path); total += e.bytes ?? 0; if (total > limits.maxTotalBytes) throw new Error('root-ready baseline total too large'); }
  for (const entry of r.baselineEntries) if (inputs.includes(entry.path) && !writables.includes(entry.path) && !entry.exists) throw new Error('root-ready readonly input missing');
  assertUnique(paths, 'root-ready baseline entries'); if (JSON.stringify(paths) !== JSON.stringify(all)) throw new Error('root-ready baseline coverage invalid');
  const expected = hash(JSON.stringify(r.baselineEntries.map((e) => ({ path: e.path, exists: e.exists, sha256: e.sha256, bytes: e.bytes }))));
  if (r.baselineHash !== expected) throw new Error('root-ready baseline hash invalid');
  validateLeaseEvidenceList(r.destinationLeases as any[], limits);
  if (typeof r.recordedAt !== 'string' || r.recordedAt.length > 80) throw new Error('root-ready recordedAt invalid');
  return deepFreeze(r);
}
function assertRootReadyStillOwned(root: WorkspaceRootReadyEvidence, limits: Required<CodingWorkspaceLimits>, verifyLeases = true): void {
  assertSafeExistingDirectory(root.projectRoot, 'projectRoot');
  if (!sameIdentity(root.projectRootIdentity, checkedLstat(root.projectRoot, 'projectRoot'))) throw new Error('root-ready projectRoot identity changed');
  assertSafeExistingDirectory(root.stageRoot, 'stageRoot');
  if (!sameIdentity(root.stageRootIdentity, checkedLstat(root.stageRoot, 'stageRoot'))) throw new Error('root-ready stageRoot identity changed');
  const mst = checkedLstat(root.markerPath, 'workspace marker');
  if (!sameIdentity(root.markerIdentity, mst) || !mst.isFile() || mst.isSymbolicLink()) throw new Error('root-ready marker identity changed');
  const marker = JSON.parse(decodeUtf8(readFileBounded(root.markerPath, 4096, 'workspace marker too large'), 'workspace marker is not utf8'));
  if (marker.owner !== root.markerOwner || marker.workflowRunId !== root.workflowRunId || marker.ownerGeneration !== root.ownerGeneration || marker.projectRoot !== root.projectRoot || marker.stageRoot !== root.stageRoot) throw new Error('root-ready marker content mismatch');
  for (const entry of root.baselineEntries) {
    const abs = safeProjectAbs(root.projectRoot, entry.path);
    if (!parentChainMatches(abs, entry.parentChain)) throw new Error(`root-ready parent chain changed: ${entry.path}`);
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : userInfo().uid;
  if (root.stageRootIdentity.uid !== uid || root.markerIdentity.uid !== uid || mst.nlink !== 1 || (mst.mode & 0o077) !== 0 || (root.stageRootIdentity.mode & 0o077) !== 0) throw new Error('root-ready private owner identity invalid');
  const leaseRoot = expectedLeaseRootExisting();
  const expectedKeys = new Set(root.writablePaths.map(p => hash(`${root.projectRoot}\0${p}`)));
  if (root.destinationLeases.length !== expectedKeys.size) throw new Error('root-ready lease coverage mismatch');
  for (const lease of root.destinationLeases) {
    if (!expectedKeys.delete(lease.key) || lease.leaseDir !== join(leaseRoot, lease.key) || lease.ownerValue !== root.markerOwner || lease.ownerFileIdentity.uid !== uid || lease.leaseDirIdentity.uid !== uid) throw new Error('root-ready lease scope mismatch');
    if (verifyLeases) leaseRecordFromEvidence(lease); // Internal transfer rechecks already-released artifacts separately.
  }
  const files = new Set(root.allowedPaths), dirs = expectedStageDirs([...files]);
  let seen = 0;
  // Linux kernel-owned fd locators let opendir enumerate the nofollow-opened
  // directory, rather than following a path swapped after lstat.
  const rootFd = openSync(root.stageRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const queue = [{ rel: '', fd: rootFd }];
  try {
    for (let n = 0; n < queue.length; n++) {
      const { rel, fd } = queue[n], dst = fstatSync(fd);
      if (!dst.isDirectory() || dst.uid !== uid || (dst.mode & 0o077) !== 0) throw new Error('root-ready directory owner/mode invalid');
      if (!rel && !sameIdentity(root.stageRootIdentity, dst)) throw new Error('root-ready opened root identity changed');
      const fdPath = `/proc/self/fd/${fd}`, dir = opendirSync(fdPath);
      try { for (;;) {
        const ent = dir.readSync(); if (!ent) break;
        if (++seen > files.size + dirs.size + 1) throw new Error('root-ready stage inventory too large');
        if (!rel && ent.name === '.coding-workspace-owner.json') continue;
        const child = rel ? `${rel}/${ent.name}` : ent.name;
        const childPath = join(fdPath, ent.name), st = checkedLstat(childPath, child);
        if (st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o077) !== 0) throw new Error(`root-ready stage symlink/owner/mode rejected: ${child}`);
        if (st.isDirectory()) {
          if (!dirs.has(child)) throw new Error(`unexpected stage directory: ${child}`);
          const childFd = openSync(childPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          queue.push({ rel: child, fd: childFd });
          if (!sameIdentity(identity(st), fstatSync(childFd))) throw new Error('root-ready directory changed during inventory');
        } else if (!st.isFile() || st.nlink !== 1 || !files.has(child)) throw new Error(`unexpected stage file: ${child}`);
      } } finally { dir.closeSync(); }
    }
  } finally { for (const { fd } of queue) closeSync(fd); }

}

function validateLatestStageIntent(raw: unknown, root: WorkspaceRootReadyEvidence): WorkspaceEffectIntent {
  const i = workflowJson(raw, WORKFLOW_LIMITS.ledgerBytes) as unknown as WorkspaceEffectIntent;
  assertPlainObject(i, 'latest intent');
  const keys = ['candidateHash','generation','kind','markerIdentity','markerOwner','markerPath','path','postimageHash','preimageHash','projectRoot','sequence','stageRoot','stageRootIdentity','workflowRunId', ...(i.ownerEvidence !== undefined ? ['ownerEvidence'] : [])].sort();
  assertExactKeys(i, keys, 'latest intent');
  if (!Number.isSafeInteger(i.sequence) || i.sequence < 1 || i.sequence > 512) throw new Error('latest intent sequence invalid');
  if (i.kind !== 'stage-write' || i.candidateHash !== null) throw new Error('latest intent kind/candidate hash unsupported');
  if (i.workflowRunId !== root.workflowRunId || i.generation !== root.ownerGeneration || i.projectRoot !== root.projectRoot || i.stageRoot !== root.stageRoot || i.markerPath !== root.markerPath || i.markerOwner !== root.markerOwner) throw new Error('latest intent scope mismatch');
  if (!sameIdentity(i.stageRootIdentity, { ...root.stageRootIdentity, isDirectory: () => true } as any) || !sameIdentity(i.markerIdentity, { ...root.markerIdentity, isDirectory: () => false } as any)) throw new Error('latest intent root identity mismatch');
  validateRelPath(i.path); if (!root.allowedPaths.includes(i.path)) throw new Error('latest intent path outside HOST scope');
  for (const h of [i.candidateHash, i.postimageHash, i.preimageHash]) if (h !== null) validateHash(h, 'latest intent hash');
  if (JSON.stringify(i.ownerEvidence ?? null) !== JSON.stringify(root.ownerEvidence ?? null)) throw new Error('latest intent owner evidence mismatch');
  return deepFreeze(i);
}
function readObservedStageCandidateBytes(root: WorkspaceRootReadyEvidence, rel: string, limits: Required<CodingWorkspaceLimits>): Buffer {
  const abs = join(root.stageRoot, rel);
  assertNoSymlinkComponents(dirname(abs));
  if (!existsNoFollow(abs)) throw new Error('observed candidate missing');
  assertStageFile(abs, rel);
  const st = checkedLstat(abs, rel); const rst = checkedLstat(root.stageRoot, 'stageRoot');
  if (st.uid !== rst.uid || st.uid !== root.stageRootIdentity.uid) throw new Error('observed candidate owner mismatch');
  return readFileBounded(abs, limits.maxFileBytes, `observed candidate too large: ${rel}`);
}

/** Only initial baseline copying: no historical candidate/outcome is invented. */
export function createPartialReconstructionCodingWorkspace(options: {
  partialOptions: InspectPartialArtifactsOptions; workflowRunId: string;
  recoveryWriterOwnerEvidence: RecoveryWriterOwnerEvidence; assertAuthority: () => void;
  assertPreviousSettlement: () => void; effectHooks: WorkspaceEffectHooks; limits?: CodingWorkspaceLimits;
}): CodingWorkspace {
  const partial = options.partialOptions.latestIntent === undefined ? inspectRootReadyWorkspaceArtifacts(options.partialOptions) : inspectPartialWorkspaceArtifacts(options.partialOptions);
  if (partial.status !== 'safe' || partial.mode !== 'fresh-reconstruction-only' || !partial.rootReady) throw new Error('Initial partial reconstruction proof unavailable');
  const root = partial.rootReady, limits = validateLimits(options.limits);
  const owner = verifyCurrentOwnerEvidence(options.recoveryWriterOwnerEvidence);
  if (!root.ownerEvidence || owner.generation === root.ownerEvidence.generation || owner.writerSessionId === root.ownerEvidence.writerSessionId || root.workflowRunId === options.workflowRunId) throw new Error('Partial reconstruction requires distinct current owner/run');
  if (!options.effectHooks.rootReady || !options.effectHooks.beforeEffect || !options.effectHooks.afterEffect || !options.effectHooks.beforeLeaseRelease || !options.effectHooks.afterLeaseRelease) throw new Error('Partial reconstruction requires full durable hooks');
  const baseline = captureCodingBaseline({ projectRoot: root.projectRoot, inputPaths: [...root.inputPaths], writablePaths: [...root.writablePaths], limits });
  if (!baseline.entries.every(entry => {
    const source = root.baselineEntries.find(e => e.path === entry.path);
    return source && source.exists === entry.exists && source.sha256 === entry.sha256 && source.bytes === entry.bytes
      && (!entry.exists || (source.file && entry.file && sameIdentity(source.file, { ...entry.file, isDirectory: () => false } as any)));
  })) throw new Error('Partial reconstruction capture differs from the source root baseline');
  const stageHash = () => hash(JSON.stringify(root.allowedPaths.map(path => {
    const abs = join(root.stageRoot, path);
    if (!existsNoFollow(abs)) return [path, null];
    return [path, identity(checkedLstat(abs, path)), observeStageHash(root.stageRoot, path, limits)];
  })));
  const oldStageHash = stageHash();
  const recheck = () => {
    assertOldOwnerSafelyDead(root.ownerEvidence!);
    assertRootReadyStillOwned(root, limits, false); // Released leases are NOT filesystem ownership proof.
    if (stageHash() !== oldStageHash) throw new Error('Initial partial stage changed during lease transfer');
    const fresh = captureCodingBaseline({ projectRoot: root.projectRoot, inputPaths: [...root.inputPaths], writablePaths: [...root.writablePaths], limits });
    if (workflowHashForWorkspace(fresh) !== workflowHashForWorkspace(baseline)) throw new Error('Partial reconstruction project baseline changed');
  };
  options.assertAuthority(); options.assertPreviousSettlement(); options.assertAuthority(); recheck();
  releaseRetainedDestinationLeases(root, options.effectHooks, options.assertAuthority, recheck, partial);
  options.assertAuthority(); recheck();
  return createCodingWorkspace({ workflowRunId: options.workflowRunId, projectRoot: root.projectRoot, stagingParent: options.partialOptions.trustedScope.stagingParent, inputPaths: [...root.inputPaths], writablePaths: [...root.writablePaths], assertAuthority: options.assertAuthority, reviewedBaseline: baseline, recoveryWriterOwnerEvidence: owner, effectHooks: options.effectHooks, limits });
}
const workflowHashForWorkspace = (value: unknown) => hash(JSON.stringify(value));

export function createContinuationCodingWorkspace(options: CreateContinuationCodingWorkspaceOptions): ContinuationCodingWorkspaceResult {
  const limits = validateLimits(options.limits ?? options.trustedScope.limits);
  let inspection: RetainedWorkspaceInspection;
  try {
    inspection = inspectRetainedCodingWorkspaceManifest(options.rawRetainedManifest, { ...options.trustedScope, limits });
    if (inspection.status !== 'safe' || !inspection.manifest) return { status: 'blocked', error: inspection.error ?? 'retained workspace is unsafe', inspection };
    const manifest = inspection.manifest;
    if (!options.effectHooks?.beforeEffect || !options.effectHooks.afterEffect || !options.effectHooks.beforeLeaseRelease || !options.effectHooks.afterLeaseRelease) return { status: 'blocked', error: 'Continuation requires explicit durable effect and lease-release journal hooks', inspection };
    if (!manifest.ownerEvidence) return { status: 'blocked', error: 'retained workspace lacks verifiable ownerEvidence', inspection };
    assertOldOwnerSafelyDead(manifest.ownerEvidence);
    const newOwner = verifyCurrentOwnerEvidence(options.recoveryWriterOwnerEvidence);
    if (newOwner.generation === manifest.ownerEvidence.generation || newOwner.writerSessionId === manifest.ownerEvidence.writerSessionId) throw new Error('new recovery writer ownerEvidence is not distinct from retained owner');
    if (options.workflowRunId === manifest.workflowRunId) throw new Error('continuation workflowRunId must be fresh');
    const observationHash = retainedInspectionObservationHash(inspection);
    const alreadySatisfiedPaths = inspection.classifications.filter((c) => c.class === 'postimage').map((c) => c.path);
    const remainingPaths = inspection.classifications.filter((c) => c.class === 'preimage').map((c) => c.path);
    const blocker = inspection.classifications.find((c) => c.class !== 'preimage' && c.class !== 'postimage');
    if (blocker) return { status: 'blocked', error: `retained destination ${blocker.class}: ${blocker.path}`, inspection };
    for (const ro of inspection.readonlyObservations) if (!ro.safe) return { status: 'blocked', error: `retained readonly input changed: ${ro.path}`, inspection };
    retainedCandidateHash(manifest, limits);

    const recheckRetained = (label: string): RetainedWorkspaceInspection => {
      assertRetainedManifestStable(manifest, limits);
      const fresh = inspectRetainedCodingWorkspaceManifest(options.rawRetainedManifest, { ...options.trustedScope, limits });
      if (fresh.status !== 'safe' || !fresh.manifest) throw new Error(`retained workspace changed before ${label}: ${fresh.error ?? 'unsafe'}`);
      if (retainedInspectionObservationHash(fresh) !== observationHash) throw new Error(`retained workspace observations changed before ${label}`);
      return fresh;
    };

    options.assertAuthority();
    options.assertPreviousSettlement(inspection);
    options.assertAuthority();
    assertOldOwnerSafelyDead(manifest.ownerEvidence);
    recheckRetained('lease release');
    releaseRetainedDestinationLeases(manifest, options.effectHooks, () => { options.assertAuthority(); }, () => { recheckRetained('lease unlink'); }, inspection);

    options.assertAuthority();
    recheckRetained('baseline capture');
    const inputPaths = unique([...manifest.inputPaths, ...alreadySatisfiedPaths]);
    const writablePaths = remainingPaths;
    const reviewedBaseline = captureCodingBaseline({ projectRoot: manifest.projectRoot, inputPaths, writablePaths, limits });
    recheckRetained('new stage creation');
    const workspace = createCodingWorkspace({ workflowRunId: options.workflowRunId, projectRoot: manifest.projectRoot, stagingParent: options.trustedScope.stagingParent, inputPaths, writablePaths, assertAuthority: options.assertAuthority, limits, reviewedBaseline, effectHooks: options.effectHooks, recoveryWriterOwnerEvidence: newOwner });
    try {
      for (const rel of remainingPaths) {
        options.assertAuthority();
        recheckRetained(`copy ${rel}`);
        const retainedEntry = manifest.candidateEntries.find(entry => entry.path === rel);
        if (retainedEntry && !retainedEntry.exists && manifest.baselineEntries.find(entry => entry.path === rel)?.exists === false) continue;
        const bytes = readRetainedCandidateBytes(manifest, rel, limits);
        let current: Buffer | null = null;
        const entry = workspace.recoveryManifest().candidateEntries.find((e) => e.path === rel);
        if (entry?.exists) current = Buffer.from(workspace.read(rel), 'utf8');
        if (!current || !current.equals(bytes)) workspace.write(rel, decodeUtf8(bytes, `retained candidate is not utf8 text: ${rel}`));
      }
      recheckRetained('capture result');
      const carried = workspace.inspect();
      const newManifest = workspace.recoveryManifest();
      return { status: 'created', workspace, provenance: deepFreeze({ sourceWorkflowId: manifest.workflowRunId, oldStageGen: manifest.ownerGeneration, candidateHash: carried.hash, alreadySatisfiedPaths, remainingPaths, newStageGen: newManifest.ownerGeneration }) };
    } catch (error) {
      if (error instanceof WorkspaceEffectUncertaintyError || error instanceof WorkspaceLeaseReleaseUncertaintyError) throw error;
      let createdWorkspaceEvidence: WorkspaceRecoveryManifest | undefined;
      try { createdWorkspaceEvidence = workspace.recoveryManifest(); } catch {}
      return { status: 'blocked', error: message(error).slice(0, 1024), inspection, ...(createdWorkspaceEvidence ? { createdWorkspaceEvidence } : {}), provenance: { sourceWorkflowId: manifest.workflowRunId, oldStageGen: manifest.ownerGeneration, alreadySatisfiedPaths, remainingPaths, newStageGen: createdWorkspaceEvidence?.ownerGeneration }, uncertainty: { kind: 'post-create-carry-blocked', message: message(error) } };
    }
  } catch (error) {
    if (error instanceof WorkspaceEffectUncertaintyError || error instanceof WorkspaceLeaseReleaseUncertaintyError) throw error;
    return { status: 'blocked', error: message(error).slice(0, 1024), ...(inspection! ? { inspection: inspection! } : {}) };
  }
}


function retainedInspectionObservationHash(inspection: RetainedWorkspaceInspection): string {
  return hash(JSON.stringify({
    status: inspection.status,
    error: inspection.error ?? null,
    manifest: inspection.manifest ? {
      workflowRunId: inspection.manifest.workflowRunId,
      ownerGeneration: inspection.manifest.ownerGeneration,
      projectRoot: inspection.manifest.projectRoot,
      projectRootIdentity: inspection.manifest.projectRootIdentity,
      stageRoot: inspection.manifest.stageRoot,
      stageRootIdentity: inspection.manifest.stageRootIdentity,
      markerPath: inspection.manifest.markerPath,
      markerIdentity: inspection.manifest.markerIdentity,
      markerOwner: inspection.manifest.markerOwner,
      baselineHash: inspection.manifest.baselineHash,
      baselineEntries: inspection.manifest.baselineEntries,
      candidateEntries: inspection.manifest.candidateEntries,
      declaredStageDirs: inspection.manifest.declaredStageDirs,
      declaredStageFiles: inspection.manifest.declaredStageFiles,
    } : null,
    classifications: inspection.classifications.map((c) => ({ path: c.path, class: c.class, recordedApplication: c.recordedApplication, observedHash: c.observedHash, intendedPostimageHash: c.intendedPostimageHash })),
    readonlyObservations: inspection.readonlyObservations,
  }));
}
function retainedCandidateHash(manifest: WorkspaceRecoveryManifest, limits: Required<CodingWorkspaceLimits>): string {
  const files = manifest.writablePaths.map((rel) => {
    const before = manifest.baselineEntries.find((e) => e.path === rel);
    const after = manifest.candidateEntries.find((e) => e.path === rel);
    if (!before || !after) throw new Error(`retained candidate entry missing: ${rel}`);
    if (after.exists) readRetainedCandidateBytes(manifest, rel, limits);
    if (before.sha256 === after.sha256) return null;
    if (!after.exists && !before.exists) return null;
    if (!after.exists && before.exists) throw new Error(`retained candidate deletion unsupported: ${rel}`);
    return { path: rel, beforeHash: before.sha256, afterHash: after.sha256, after: readRetainedCandidateBytes(manifest, rel, limits).toString('base64') };
  }).filter((f): f is { path: string; beforeHash: string | null; afterHash: string | null; after: string } => !!f);
  return hash(JSON.stringify(files));
}
function readRetainedCandidateBytes(manifest: WorkspaceRecoveryManifest, rel: string, limits: Required<CodingWorkspaceLimits>): Buffer {
  const entry = manifest.candidateEntries.find((e) => e.path === rel);
  if (!entry || !entry.exists || entry.sha256 === null || entry.bytes === null || entry.identity === null) throw new Error(`retained candidate bytes unavailable: ${rel}`);
  const abs = join(manifest.stageRoot, rel);
  assertStageFile(abs, rel);
  const st = checkedLstat(abs, `retained candidate ${rel}`);
  if (!sameIdentity(entry.identity, st)) throw new Error(`retained candidate identity changed: ${rel}`);
  const bytes = readFileBounded(abs, Math.min(limits.maxFileBytes, entry.bytes), `retained candidate too large: ${rel}`);
  if (bytes.length !== entry.bytes || hashBytes(bytes) !== entry.sha256) throw new Error(`retained candidate content changed: ${rel}`);
  return bytes;
}
function assertRetainedManifestStable(manifest: WorkspaceRecoveryManifest, limits: Required<CodingWorkspaceLimits>): void {
  assertSafeExistingDirectory(manifest.projectRoot, 'projectRoot');
  if (!sameIdentity(manifest.projectRootIdentity, checkedLstat(manifest.projectRoot, 'projectRoot'))) throw new Error('retained projectRoot identity changed');
  assertSafeExistingDirectory(manifest.stageRoot, 'stageRoot');
  if (!sameIdentity(manifest.stageRootIdentity, checkedLstat(manifest.stageRoot, 'stageRoot'))) throw new Error('retained stageRoot identity changed');
  const mst = checkedLstat(manifest.markerPath, 'workspace marker');
  if (!sameIdentity(manifest.markerIdentity, mst) || !mst.isFile() || mst.isSymbolicLink()) throw new Error('retained workspace marker identity changed');
  const markerText = decodeUtf8(readFileBounded(manifest.markerPath, 4096, 'workspace marker too large'), 'workspace marker is not utf8');
  const marker = JSON.parse(markerText);
  if (marker.owner !== manifest.markerOwner || marker.workflowRunId !== manifest.workflowRunId || marker.ownerGeneration !== manifest.ownerGeneration || marker.projectRoot !== manifest.projectRoot || marker.stageRoot !== manifest.stageRoot) throw new Error('retained workspace marker content mismatch');
  validateDeclaredStage(manifest, limits);
  retainedCandidateHash(manifest, limits);
  for (const ro of manifest.inputPaths.filter((p) => !manifest.writablePaths.includes(p))) {
    const entry = manifest.baselineEntries.find((e) => e.path === ro);
    if (!entry) throw new Error(`retained readonly missing: ${ro}`);
    const h = observeStageHash(manifest.stageRoot, ro, limits);
    if (h !== entry.sha256) throw new Error(`retained readonly stage changed: ${ro}`);
    const abs = safeProjectAbs(manifest.projectRoot, ro);
    if (!parentChainMatches(abs, entry.parentChain)) throw new Error(`retained readonly project parent changed: ${ro}`);
    const projectHash = existsNoFollow(abs) ? (() => { assertSafeExistingFile(abs, ro); return hashBytes(readFileBounded(abs, limits.maxFileBytes, `readonly project input too large: ${ro}`)); })() : null;
    if (projectHash !== entry.sha256) throw new Error(`retained readonly project input changed: ${ro}`);
  }
}
function assertOldOwnerSafelyDead(e: RecoveryWriterOwnerEvidence): void {
  validateOwnerEvidence(e, 'retained ownerEvidence');
  const nowBoot = currentBootId();
  if (e.bootId !== nowBoot) {
    if (!isStrictBootUuid(e.bootId) || !isStrictBootUuid(nowBoot)) throw new Error('retained owner boot identity is not strictly verifiable');
    return;
  }
  const procDir = `/proc/${e.pid}`;
  if (!existsNoFollow(procDir)) return;
  let ticks: string;
  try { ticks = currentStartTicks(e.pid); } catch { throw new Error('retained owner PID is unreadable'); }
  if (ticks === e.startTimeTicks) throw new Error('retained owner is still alive');
  throw new Error('retained owner PID has ambiguous reuse');
}
function isStrictBootUuid(s: string): boolean { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s); }
function leaseRecordFromEvidence(e: RetainedLeaseEvidence): LeaseRecord {
  validateLeaseEvidence(e);
  const lease: LeaseRecord = { key: e.key, dir: e.leaseDir, dirIdentity: freezeClone(e.leaseDirIdentity), ownerFile: e.ownerFile, ownerIdentity: freezeClone(e.ownerFileIdentity), ownerValue: e.ownerValue };
  verifyLeaseForRelease(lease);
  return lease;
}
function validateLeaseEvidence(e: RetainedLeaseEvidence): void {
  assertPlainObject(e, 'retained lease');
  assertExactKeys(e, ['key','leaseDir','leaseDirIdentity','ownerFile','ownerFileIdentity','ownerValue'], 'retained lease');
  validateHash(e.key, 'retained lease key');
  if (typeof e.leaseDir !== 'string' || typeof e.ownerFile !== 'string' || e.ownerFile !== join(e.leaseDir, 'owner')) throw new Error('retained lease path invalid');
  validateIdentity(e.leaseDirIdentity, 'retained lease dir identity');
  validateIdentity(e.ownerFileIdentity, 'retained lease owner identity');
  if (typeof e.ownerValue !== 'string' || e.ownerValue.length > 512) throw new Error('retained lease owner invalid');
}
function releaseRetainedDestinationLeases(manifest: WorkspaceRecoveryManifest | WorkspaceRootReadyEvidence, hooks: WorkspaceEffectHooks | undefined, assertAuthority: () => void, revalidateScope: () => void, inspection: RetainedWorkspaceInspection | PartialArtifactInspection): void {
  preflightRetainedLeaseEvidence(manifest);
  const leases = manifest.destinationLeases.map(leaseRecordFromEvidence);
  const keys = leases.map((l) => l.key);
  const ctx: LeaseReleaseContext = { workflowRunId: manifest.workflowRunId, generation: manifest.ownerGeneration, beforeLeaseRelease: (intent) => { assertAuthority(); hooks?.beforeLeaseRelease?.(intent); assertAuthority(); revalidateScope(); }, assertAuthorityBeforeMutation: () => { assertAuthority(); revalidateScope(); }, afterLeaseRelease: hooks?.afterLeaseRelease, assertCapacityBeforeMutation: hooks?.assertLeaseReleaseCapacity, nextSequence: (() => { let n = 0; return () => ++n; })(), manifest: () => 'effects' in manifest ? manifest : null, scope: () => ({ workflowRunId: manifest.workflowRunId, projectRoot: manifest.projectRoot, stageRoot: manifest.stageRoot, markerPath: manifest.markerPath, allowedPaths: manifest.allowedPaths }) };
  while (leases.length) {
    assertAuthority();
    try { releaseLeases(leases, keys, ctx); }
    catch (error) { throw error instanceof WorkspaceLeaseReleaseUncertaintyError ? error : new WorkspaceLeaseReleaseUncertaintyError(`retained lease release uncertain: ${message(error)}`, { lastKnownManifest: 'effects' in manifest ? manifest : null, intendedScope: { workflowRunId: manifest.workflowRunId, projectRoot: manifest.projectRoot, stageRoot: manifest.stageRoot, markerPath: manifest.markerPath, allowedPaths: manifest.allowedPaths }, generation: manifest.ownerGeneration, beforeLeaseEvidence: leaseEvidence(leases[leases.length - 1]), currentObservation: observeLeaseRelease(leases[leases.length - 1], error), remainingLeaseEvidence: leases.map(leaseEvidence), cause: error }); }
  }
  void inspection;
}


function preflightRetainedLeaseEvidence(manifest: WorkspaceRecoveryManifest | WorkspaceRootReadyEvidence): void {
  const root = expectedLeaseRootExisting();
  const expected = new Map(manifest.writablePaths.map((rel) => [hash(`${manifest.projectRoot}\0${rel}`), rel]));
  if (manifest.destinationLeases.length !== manifest.writablePaths.length) throw new Error('retained lease coverage invalid');
  const seen = new Set<string>();
  for (const e of manifest.destinationLeases) {
    validateLeaseEvidence(e);
    if (!expected.has(e.key) || seen.has(e.key)) throw new Error('retained lease key coverage invalid');
    seen.add(e.key);
    const expectedDir = join(root, e.key);
    const expectedOwner = join(expectedDir, 'owner');
    if (e.leaseDir !== expectedDir || e.ownerFile !== expectedOwner) throw new Error('retained lease path outside trusted root');
    if (e.ownerValue !== manifest.markerOwner) throw new Error('retained lease owner mismatch');
  }
  if (seen.size !== expected.size) throw new Error('retained lease full coverage invalid');
}
function classifyDestination(manifest: WorkspaceRecoveryManifest, rel: string, limits: Required<CodingWorkspaceLimits>): RetainedWorkspaceInspection['classifications'][number] {
  const entry = manifest.baselineEntries.find((e) => e.path === rel);
  const effects = manifest.effects.filter((e) => e.kind === 'destination-write' && e.path === rel);
  const intendedPostimageHash = intendedPostimage(manifest, rel, effects);
  let observedHash: string | null = null;
  let cls: 'preimage' | 'postimage' | 'conflict' | 'unknown' = 'unknown';
  try {
    const abs = safeProjectAbs(manifest.projectRoot, rel);
    if (!entry) throw new Error('missing entry');
    const safeParent = parentChainMatches(abs, entry.parentChain);
    if (!safeParent) throw new Error('unsafe parent chain');
    if (!existsNoFollow(abs)) {
      observedHash = null;
      if (entry.sha256 === null) cls = 'preimage';
      else cls = intendedPostimageHash === null ? 'unknown' : 'conflict';
    } else {
      assertSafeExistingFile(abs, rel);
      const bytes = readFileBounded(abs, limits.maxFileBytes, `destination too large: ${rel}`);
      observedHash = hashBytes(bytes);
      if (observedHash === entry.sha256) cls = 'preimage';
      else if (intendedPostimageHash !== null && observedHash === intendedPostimageHash) cls = 'postimage';
      else cls = 'conflict';
    }
  } catch { cls = 'unknown'; }
  return { path: rel, class: cls, recordedApplication: recordedApplicationState(effects), observedHash, intendedPostimageHash, recordedEffects: effects.map((e) => freezeClone(e)) };
}
function recordedApplicationState(effects: WorkspaceEffectRecord[]): 'none' | 'recorded' | 'uncertain' | 'rejected' {
  if (effects.length === 0) return 'none';
  if (effects.some((e) => e.status === 'uncertain')) return 'uncertain';
  if (effects.some((e) => e.status === 'observed')) return 'recorded';
  return 'rejected';
}
function intendedPostimage(manifest: WorkspaceRecoveryManifest, rel: string, effects: WorkspaceEffectRecord[]): string | null {
  const fromIntent = [...effects].reverse().find((e) => e.postimageHash !== null)?.postimageHash ?? null;
  if (fromIntent) return fromIntent;
  const candidate = manifest.candidateEntries.find((e) => e.path === rel);
  return candidate?.exists ? candidate.sha256 : null;
}
function validateRecoveryManifest(m: WorkspaceRecoveryManifest, scope: RetainedWorkspaceTrustedScope, limits: Required<CodingWorkspaceLimits>): void {
  assertPlainObject(m, 'recovery manifest');
  const keys = ['version','workflowRunId','ownerGeneration','projectRoot','projectRootIdentity','stageRoot','stageRootIdentity','markerPath','markerIdentity','markerOwner','inputPaths','writablePaths','allowedPaths','baselineHash','baselineEntries','candidateEntries','declaredStageDirs','declaredStageFiles','destinationLeases','effects', ...(m.ownerEvidence !== undefined ? ['ownerEvidence'] : [])].sort();
  assertExactKeys(m, keys, 'recovery manifest');
  if (m.ownerEvidence !== undefined) validateOwnerEvidence(m.ownerEvidence, 'ownerEvidence');
  if (m.version !== 1) throw new Error('recovery manifest version invalid');
  validateId(m.workflowRunId, 'workflowRunId'); validateId(m.ownerGeneration, 'ownerGeneration');
  const projectRoot = resolve(scope.projectRoot); const stagingParent = resolve(scope.stagingParent);
  if (m.projectRoot !== projectRoot || m.workflowRunId !== scope.workflowRunId) throw new Error('manifest outside trusted scope');
  if (!isAbsolute(m.stageRoot) || dirname(m.stageRoot) !== stagingParent) throw new Error('stage root outside trusted staging parent');
  if (m.markerPath !== join(m.stageRoot, '.coding-workspace-owner.json')) throw new Error('marker path mismatch');
  if (!m.markerOwner.startsWith(`${m.workflowRunId}:`) || !m.markerOwner.endsWith(`:${m.ownerGeneration}`)) throw new Error('marker owner mismatch');
  validateIdentity(m.projectRootIdentity, 'projectRootIdentity'); validateIdentity(m.stageRootIdentity, 'stageRootIdentity'); validateIdentity(m.markerIdentity, 'markerIdentity');
  const inputPaths = validateStringList(m.inputPaths, limits.maxFiles, 'inputPaths').map(validateRelPath);
  const writablePaths = validateStringList(m.writablePaths, limits.maxFiles, 'writablePaths').map(validateRelPath);
  const all = unique([...inputPaths, ...writablePaths]);
  const scopedAllowed = validateStringList(scope.allowedPaths, limits.maxFiles, 'trusted allowedPaths').map(validateRelPath);
  const manifestAllowed = validateStringList(m.allowedPaths, limits.maxFiles, 'allowedPaths').map(validateRelPath);
  if (all.length > limits.maxFiles || JSON.stringify(all) !== JSON.stringify(manifestAllowed) || JSON.stringify(scopedAllowed) !== JSON.stringify(manifestAllowed)) throw new Error('manifest allowed paths invalid');
  assertUnique(inputPaths, 'inputPaths'); assertUnique(writablePaths, 'writablePaths'); assertUnique(manifestAllowed, 'allowedPaths');
  if (!Array.isArray(m.baselineEntries) || m.baselineEntries.length !== all.length) throw new Error('manifest baseline entries invalid');
  let total = 0; const baselinePaths: string[] = []; for (const e of m.baselineEntries as any[]) { validateBaselineEntry(e, all, limits); baselinePaths.push(e.path); total += e.bytes ?? 0; if (total > limits.maxTotalBytes) throw new Error('manifest baseline total too large'); }
  assertUnique(baselinePaths, 'baseline entries');
  if (JSON.stringify(baselinePaths) !== JSON.stringify(all)) throw new Error('manifest baseline exact coverage invalid');
  const expectedBaselineHash = hash(JSON.stringify(m.baselineEntries.map((e) => ({ path: e.path, exists: e.exists, sha256: e.sha256, bytes: e.bytes }))));
  if (m.baselineHash !== expectedBaselineHash) throw new Error('manifest baseline hash invalid');
  if (!Array.isArray(m.candidateEntries) || m.candidateEntries.length !== writablePaths.length) throw new Error('candidate entries invalid');
  let candTotal = 0; const candPaths: string[] = []; for (const e of m.candidateEntries as any[]) { validateCandidateEntry(e, writablePaths, limits); candPaths.push(e.path); candTotal += e.bytes ?? 0; if (candTotal > limits.maxTotalBytes) throw new Error('candidate total too large'); } assertUnique(candPaths, 'candidate entries'); if (JSON.stringify(candPaths) !== JSON.stringify(writablePaths)) throw new Error('candidate exact coverage invalid');
  validateStageDeclarations(m, all, limits); validateLeaseEvidenceList(m.destinationLeases as any[], limits); validateEffects(m.effects as any[], all, m);
}
function validateDeclaredStage(m: WorkspaceRecoveryManifest, limits: Required<CodingWorkspaceLimits>): void {
  for (const d of m.declaredStageDirs) { const abs = d.path ? join(m.stageRoot, d.path) : m.stageRoot; const st = checkedLstat(abs, d.path || 'stageRoot'); if (!st.isDirectory() || !sameIdentity(d.identity, st)) throw new Error(`declared stage directory changed: ${d.path || '.'}`); }
  for (const f of m.declaredStageFiles) { const abs = join(m.stageRoot, f.path); assertNoSymlinkComponents(dirname(abs)); assertStageFile(abs, f.path); const st = checkedLstat(abs, f.path); if (!sameIdentity(f.identity, st)) throw new Error(`declared stage file identity changed: ${f.path}`); const bytes = readFileBounded(abs, limits.maxFileBytes, `stage file too large: ${f.path}`); if (bytes.length !== f.bytes || hashBytes(bytes) !== f.sha256) throw new Error(`declared stage file content changed: ${f.path}`); }
  for (const c of m.candidateEntries) { if (!c.exists) continue; const abs = join(m.stageRoot, c.path); assertNoSymlinkComponents(dirname(abs)); assertStageFile(abs, c.path); const st = checkedLstat(abs, c.path); if (!c.identity || !sameIdentity(c.identity, st)) throw new Error(`candidate file identity changed: ${c.path}`); const bytes = readFileBounded(abs, limits.maxFileBytes, `candidate file too large: ${c.path}`); if (bytes.length !== c.bytes || hashBytes(bytes) !== c.sha256) throw new Error(`candidate file content changed: ${c.path}`); }
  const declaredDirs = new Set(m.declaredStageDirs.map((d) => d.path));
  const declaredFiles = new Set(m.declaredStageFiles.map((f) => f.path));
  if (declaredDirs.size !== m.declaredStageDirs.length || declaredFiles.size !== m.declaredStageFiles.length || declaredDirs.size > limits.maxFiles + 1 || declaredFiles.size > limits.maxFiles) throw new Error('stage declaration bounds invalid');
  let count = 0; const maxEntries = limits.maxFiles + m.declaredStageDirs.length + 1;
  for (const rel of declaredDirs) {
    const abs = rel ? join(m.stageRoot, rel) : m.stageRoot;
    const dir = opendirSync(abs);
    try {
      for (;;) {
        if (count > maxEntries) throw new Error('stage inventory too large');
        const ent = dir.readSync();
        if (!ent) break;
        count++;
        if (count > maxEntries) throw new Error('stage inventory too large');
        const name = ent.name;
        if (rel === '' && name === '.coding-workspace-owner.json') continue;
        const child = rel ? `${rel}/${name}` : name;
        const cst = checkedLstat(join(m.stageRoot, child), child);
        if (cst.isSymbolicLink()) throw new Error(`stage symlink rejected: ${child}`);
        if (cst.isDirectory()) { if (!declaredDirs.has(child)) throw new Error(`undeclared stage directory: ${child}`); }
        else { if (!declaredFiles.has(child)) throw new Error(`undeclared stage file: ${child}`); }
      }
    } finally { dir.closeSync(); }
  }
}
function validateStageDeclarations(m: WorkspaceRecoveryManifest, all: string[], limits: Required<CodingWorkspaceLimits>): void {
  if (!Array.isArray(m.declaredStageDirs) || m.declaredStageDirs.length > limits.maxFiles + 1) throw new Error('stage dirs invalid');
  const expectedDirs = expectedStageDirs(all); const dirs: string[] = [];
  for (const d of m.declaredStageDirs as any[]) { assertExactKeys(d, ['identity','path'], 'stage dir'); const path = d.path === '' ? '' : validateRelPath(d.path); if (!expectedDirs.has(path)) throw new Error('unexpected declared stage dir'); validateIdentity(d.identity, 'stage dir identity'); dirs.push(path); }
  assertUnique(dirs, 'stage dirs'); if (!dirs.includes('')) throw new Error('stage root declaration missing');
  if (!Array.isArray(m.declaredStageFiles) || m.declaredStageFiles.length > limits.maxFiles) throw new Error('stage files invalid');
  const files: string[] = [];
  for (const f of m.declaredStageFiles as any[]) { assertExactKeys(f, ['bytes','generation','identity','path','sha256'], 'stage file'); const path = validateRelPath(f.path); if (!all.includes(path)) throw new Error('stage file outside allowed paths'); validateIdentity(f.identity, 'stage file identity'); validateId(f.generation, 'stage file generation'); validateHash(f.sha256, 'stage file hash'); if (!Number.isSafeInteger(f.bytes) || f.bytes < 0 || f.bytes > limits.maxFileBytes) throw new Error('stage file bytes invalid'); files.push(path); }
  assertUnique(files, 'stage files');
}
function validateEffects(effects: any[], all: string[], m: WorkspaceRecoveryManifest): void {
  if (!Array.isArray(effects) || effects.length > 512) throw new Error('too many effect records');
  let last = 0; const seq = new Set<number>();
  for (const e of effects) { const keys = ['afterSaved','beforeCalled','candidateHash','error','generation','kind','path','postimageHash','preimageHash','recordedAt','sequence','status','workflowRunId','projectRoot','stageRoot','stageRootIdentity','markerPath','markerIdentity','markerOwner','observedPostimageHash', ...(e.ownerEvidence !== undefined ? ['ownerEvidence'] : [])].filter((k) => k !== 'error' || e.error !== undefined).sort(); assertExactKeys(e, keys, 'effect'); if (e.ownerEvidence !== undefined) validateOwnerEvidence(e.ownerEvidence, 'effect ownerEvidence'); if (JSON.stringify(e.ownerEvidence ?? null) !== JSON.stringify(m.ownerEvidence ?? null)) throw new Error('effect ownerEvidence mismatch'); if (!Number.isSafeInteger(e.sequence) || e.sequence < 1 || e.sequence > 512 || seq.has(e.sequence) || e.sequence <= last) throw new Error('effect sequence invalid'); seq.add(e.sequence); last = e.sequence; if (e.kind !== 'stage-write' && e.kind !== 'destination-write') throw new Error('effect kind invalid'); if (e.status !== 'observed' && e.status !== 'rejected' && e.status !== 'uncertain') throw new Error('effect status invalid'); if (typeof e.beforeCalled !== 'boolean' || typeof e.afterSaved !== 'boolean') throw new Error('effect durability flags invalid'); validateRelPath(e.path); if (!all.includes(e.path)) throw new Error('effect outside allowed paths'); validateId(e.generation, 'effect generation'); for (const h of [e.candidateHash, e.observedPostimageHash, e.postimageHash, e.preimageHash]) if (h !== null) validateHash(h, 'effect hash'); if (e.error !== undefined && (typeof e.error !== 'string' || e.error.length > 1024)) throw new Error('effect error invalid'); if (typeof e.recordedAt !== 'string' || e.recordedAt.length > 80) throw new Error('effect recordedAt invalid'); if (e.workflowRunId !== m.workflowRunId || e.projectRoot !== m.projectRoot || e.stageRoot !== m.stageRoot || e.markerPath !== m.markerPath || e.markerOwner !== m.markerOwner || e.generation !== m.ownerGeneration) throw new Error('effect scope invalid'); validateIdentity(e.stageRootIdentity, 'effect stage root identity'); if (!sameIdentity(e.stageRootIdentity, { ...m.stageRootIdentity, isDirectory: () => true } as any)) throw new Error('effect stage root identity invalid'); validateIdentity(e.markerIdentity, 'effect marker identity'); if (!sameIdentity(e.markerIdentity, { ...m.markerIdentity, isDirectory: () => false } as any)) throw new Error('effect marker identity invalid'); }
}
function validateBaselineEntry(e: any, all: string[], limits: Required<CodingWorkspaceLimits>): void { assertExactKeys(e, ['bytes','exists','file','parentChain','path','sha256'], 'baseline entry'); const path = validateRelPath(e.path); if (!all.includes(path)) throw new Error('manifest entry outside allowed paths'); if (typeof e.exists !== 'boolean') throw new Error('baseline exists invalid'); if (e.exists) { validateHash(e.sha256, 'baseline hash'); if (!Number.isSafeInteger(e.bytes) || e.bytes < 0 || e.bytes > limits.maxFileBytes) throw new Error('baseline bytes invalid'); validateIdentity(e.file, 'baseline file'); } else if (e.sha256 !== null || e.bytes !== null || e.file !== null) throw new Error('manifest baseline entry invalid'); if (!Array.isArray(e.parentChain) || e.parentChain.length > 128) throw new Error('parentChain invalid'); for (const id of e.parentChain) validateIdentity(id, 'parent identity'); }
function validateCandidateEntry(e: any, writable: string[], limits: Required<CodingWorkspaceLimits>): void { assertExactKeys(e, ['bytes','exists','generation','identity','path','sha256'], 'candidate entry'); const path = validateRelPath(e.path); if (!writable.includes(path)) throw new Error('candidate outside writable paths'); if (typeof e.exists !== 'boolean') throw new Error('candidate exists invalid'); if (e.exists) { validateHash(e.sha256, 'candidate hash'); if (!Number.isSafeInteger(e.bytes) || e.bytes < 0 || e.bytes > limits.maxFileBytes) throw new Error('candidate bytes invalid'); validateIdentity(e.identity, 'candidate identity'); if (e.generation !== null) validateId(e.generation, 'candidate generation'); } else if (e.sha256 !== null || e.bytes !== null || e.identity !== null || e.generation !== null) throw new Error('candidate null entry invalid'); }

function validateLeaseEvidenceList(v: any[], limits: Required<CodingWorkspaceLimits>): void {
  if (!Array.isArray(v) || v.length > limits.maxFiles) throw new Error('destination leases invalid');
  const keys: string[] = [];
  for (const e of v) {
    assertExactKeys(e, ['key','leaseDir','leaseDirIdentity','ownerFile','ownerFileIdentity','ownerValue'], 'destination lease');
    validateHash(e.key, 'destination lease key');
    if (typeof e.leaseDir !== 'string' || e.leaseDir.length > 1024 || typeof e.ownerFile !== 'string' || e.ownerFile.length > 1024 || e.ownerFile !== join(e.leaseDir, 'owner')) throw new Error('destination lease path invalid');
    validateIdentity(e.leaseDirIdentity, 'destination lease dir identity'); validateIdentity(e.ownerFileIdentity, 'destination lease owner identity');
    if (typeof e.ownerValue !== 'string' || e.ownerValue.length > 512) throw new Error('destination lease owner invalid');
    keys.push(e.key);
  }
  assertUnique(keys, 'destination leases');
}
function validateOwnerEvidence(v: any, label: string): void {
  assertPlainObject(v, label);
  for (const k of ['bootId','generation','pid','startTimeTicks','writerSessionId']) if (!(k in v)) throw new Error(`${label} keys invalid`);
  for (const k of Object.keys(v)) if (!['bootId','generation','lockDev','lockIno','markerDev','markerIno','pid','startTimeTicks','writerSessionId'].includes(k)) throw new Error(`${label} keys invalid`);
  if (typeof v.bootId !== 'string' || !isStrictBootUuid(v.bootId)) throw new Error(`${label} bootId invalid`);
  if (!Number.isSafeInteger(v.pid) || v.pid <= 0) throw new Error(`${label} pid invalid`);
  if (typeof v.startTimeTicks !== 'string' || !/^[0-9]+$/.test(v.startTimeTicks)) throw new Error(`${label} startTimeTicks invalid`);
  for (const k of ['lockDev','lockIno','markerDev','markerIno']) if (v[k] !== undefined && (!Number.isSafeInteger(v[k]) || v[k] < 0)) throw new Error(`${label} ${k} invalid`);
  validateId(v.writerSessionId, `${label} writerSessionId`); validateId(v.generation, `${label} generation`);
}
function currentBootId(): string { return osReadFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); }
function currentStartTicks(pid: number): string {
  const stat = osReadFileSync(`/proc/${pid}/stat`, 'utf8');
  const close = stat.lastIndexOf(')');
  const fields = stat.slice(close + 2).trim().split(/\s+/);
  if (fields.length < 20) throw new Error('process stat invalid');
  return fields[19];
}
function verifyCurrentOwnerEvidence(e: RecoveryWriterOwnerEvidence): RecoveryWriterOwnerEvidence {
  validateOwnerEvidence(e, 'recoveryWriterOwnerEvidence');
  if (e.pid !== process.pid || e.bootId !== currentBootId() || e.startTimeTicks !== currentStartTicks(process.pid)) throw new Error('recovery writer ownerEvidence is not current process');
  return freezeClone(e);
}
function settlementForManifest(manifest: WorkspaceRecoveryManifest): RetainedWorkspaceSettlement {
  const retainedLeases = Array.isArray((manifest as any)?.destinationLeases) ? (manifest as any).destinationLeases.map((l: RetainedLeaseEvidence) => freezeClone(l)) : undefined;
  if (!manifest || typeof manifest !== 'object' || !(manifest as any).ownerEvidence) return { state: 'settlement-unknown', adoptable: false, reason: 'legacy manifest lacks verifiable ownerEvidence', ...(retainedLeases ? { retainedLeases } : {}) };
  try { validateOwnerEvidence((manifest as any).ownerEvidence, 'ownerEvidence'); return { state: 'verifiable-owner', adoptable: false, reason: 'inspection never proves actor stopped or adopts retained workspace', ...(retainedLeases ? { retainedLeases } : {}) }; }
  catch (error) { return { state: 'settlement-unknown', adoptable: false, reason: message(error), ...(retainedLeases ? { retainedLeases } : {}) }; }
}

function assertPlainObject(v: any, label: string): void { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${label} invalid`); }
function assertExactKeys(v: any, keys: string[], label: string): void { assertPlainObject(v, label); if (JSON.stringify(Object.keys(v).sort()) !== JSON.stringify([...keys].sort())) throw new Error(`${label} keys invalid`); }
function validateStringList(v: readonly string[], max: number, label: string): string[] { if (!Array.isArray(v) || v.length > max) throw new Error(`${label} invalid`); let bytes = 0; return v.map((s) => { if (typeof s !== 'string' || s.length > 512) throw new Error(`${label} entry invalid`); bytes += Buffer.byteLength(s); if (bytes > 64 * 1024) throw new Error(`${label} too large`); return s; }); }
function assertUnique<T>(items: T[], label: string): void { if (new Set(items).size !== items.length) throw new Error(`${label} duplicate`); }
function validateId(s: string, label: string): void { if (typeof s !== 'string' || !s || s.length > 160 || s.includes(String.fromCharCode(0)) || s.includes('/') || s.includes('\\')) throw new Error(`${label} invalid`); }
function validateHash(s: string, label: string): void { if (typeof s !== 'string' || !/^[0-9a-f]{64}$/.test(s)) throw new Error(`${label} invalid`); }
function validateIdentity(v: any, label: string): void { assertPlainObject(v, label); for (const k of ['dev','ino','mode','uid','gid']) if (!Number.isSafeInteger(v[k]) || v[k] < 0) throw new Error(`${label} invalid`); if (v.size !== undefined && (!Number.isSafeInteger(v.size) || v.size < 0)) throw new Error(`${label} invalid`); if (v.mtimeMs !== undefined && (typeof v.mtimeMs !== 'number' || !Number.isFinite(v.mtimeMs))) throw new Error(`${label} invalid`); if (v.hash !== undefined) validateHash(v.hash, label); const allowed = ['dev','gid','hash','ino','mode','mtimeMs','size','uid'].sort(); for (const k of Object.keys(v)) if (!allowed.includes(k)) throw new Error(`${label} keys invalid`); }


function expectedLeaseRootExisting(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : userInfo().uid;
  const dir = join(tmpdir(), `pi-clankers-coding-leases-${uid}`);
  assertNoSymlinkComponents(dir);
  const st = checkedLstat(dir, 'leaseRoot');
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o077) !== 0) throw new Error('unsafe lease root');
  return dir;
}
function ensureLeaseRoot(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : userInfo().uid;
  const dir = join(tmpdir(), `pi-clankers-coding-leases-${uid}`);
  if (!existsNoFollow(dir)) mkdirSync(dir, { mode: 0o700 });
  return expectedLeaseRootExisting();
}
type LeaseRecord = { key: string; dir: string; dirIdentity: Identity; ownerFile: string; ownerIdentity: Identity; ownerValue: string };
type LeaseReleaseContext = { workflowRunId: string; generation: string; beforeLeaseRelease?: (intent: WorkspaceLeaseReleaseIntent) => void; assertAuthorityBeforeMutation?: () => void; assertCapacityBeforeMutation?: (intent: WorkspaceLeaseReleaseIntent) => void; afterLeaseRelease?: (observation: WorkspaceLeaseReleaseObservation) => void; nextSequence: () => number; manifest: () => WorkspaceRecoveryManifest | null; scope: () => { workflowRunId: string; projectRoot: string; stageRoot: string; markerPath: string; allowedPaths: readonly string[] } };
function acquireLease(root: string, projectRoot: string, rel: string, owner: string, leases: LeaseRecord[], ownedKeys: string[]): void {
  const key = hash(`${projectRoot}\0${rel}`);
  const old = ownedDestinations.get(key); if (old) throw new Error(`destination lease exists: ${rel}`);
  const dir = join(root, key);
  mkdirSync(dir, { mode: 0o700 });
  const ownerFile = join(dir, 'owner');
  writeFileSync(ownerFile, owner, { flag: 'wx', mode: 0o600 });
  fsyncFile(ownerFile); fsyncDir(dir); fsyncDir(root);
  const dst = checkedLstat(dir, 'leaseDir');
  const ost = checkedLstat(ownerFile, 'lease owner');
  if (!dst.isDirectory() || dst.isSymbolicLink() || !ost.isFile() || ost.isSymbolicLink()) throw new Error('unsafe destination lease');
  const record = { key, dir, dirIdentity: identity(dst), ownerFile, ownerIdentity: identity(ost), ownerValue: owner };
  ownedDestinations.set(key, owner); ownedKeys.push(key); leases.push(record);
}
function releaseLeases(leases: LeaseRecord[], keys: string[], ctx?: LeaseReleaseContext): void {
  while (leases.length) {
    const lease = leases[leases.length - 1];
    const before = leaseEvidence(lease);
    const sequence = ctx?.nextSequence() ?? 0;
    try {
      verifyLeaseForRelease(lease);
      const intent: WorkspaceLeaseReleaseIntent | null = ctx ? deepFreeze({ sequence, generation: ctx.generation, workflowRunId: ctx.workflowRunId, beforeLeaseEvidence: before }) : null;
      if (intent && ctx?.beforeLeaseRelease) ctx.beforeLeaseRelease(intent);
      if (ctx?.assertAuthorityBeforeMutation) ctx.assertAuthorityBeforeMutation();
      if (intent && ctx?.assertCapacityBeforeMutation) ctx.assertCapacityBeforeMutation(intent);
      verifyLeaseForRelease(lease);
      unlinkSync(lease.ownerFile);
      rmdirSync(lease.dir);
      ownedDestinations.delete(lease.key);
      leases.pop();
      const index = keys.indexOf(lease.key);
      if (index >= 0) keys.splice(index, 1);
      if (intent && ctx?.afterLeaseRelease) ctx.afterLeaseRelease(deepFreeze({ ...intent, status: 'observed' as const, currentObservation: observeLeaseRelease(lease) }));
    } catch (error) {
      const currentObservation = observeLeaseRelease(lease, error);
      const uncertainty = ctx ? new WorkspaceLeaseReleaseUncertaintyError(`destination lease release uncertain: ${message(error)}`, { lastKnownManifest: ctx.manifest(), intendedScope: ctx.scope(), generation: ctx.generation, beforeLeaseEvidence: before, currentObservation, remainingLeaseEvidence: leases.map((l) => leaseEvidence(l)), cause: error }) : error;
      if (ctx?.afterLeaseRelease && sequence) {
        try { ctx.afterLeaseRelease(deepFreeze({ sequence, generation: ctx.generation, workflowRunId: ctx.workflowRunId, beforeLeaseEvidence: before, status: 'uncertain' as const, currentObservation, error: message(error).slice(0, 1024) })); } catch {}
      }
      throw uncertainty;
    }
  }
  for (const key of keys) if (ownedDestinations.has(key)) throw new Error(`destination lease retained without proof: ${key}`);
}
function leaseEvidence(lease: LeaseRecord): RetainedLeaseEvidence { return freezeClone({ key: lease.key, leaseDir: lease.dir, leaseDirIdentity: lease.dirIdentity, ownerFile: lease.ownerFile, ownerFileIdentity: lease.ownerIdentity, ownerValue: lease.ownerValue }); }
function observeLeaseRelease(lease: LeaseRecord, error?: unknown): LeaseReleaseCurrentObservation {
  let leaseDirPresent = false; let leaseDirIdentity: Identity | null = null; let ownerFilePresent = false; let ownerFileIdentity: Identity | null = null; let ownerValue: string | null = null; let ownerValueMatches: boolean | null = null;
  try { const dst = lstatSync(lease.dir); leaseDirPresent = true; leaseDirIdentity = identity(dst); } catch {}
  try { const ost = lstatSync(lease.ownerFile); ownerFilePresent = true; ownerFileIdentity = identity(ost); ownerValue = decodeUtf8(readFileBounded(lease.ownerFile, 4096, 'lease owner too large'), 'lease owner is not utf8'); ownerValueMatches = ownerValue === lease.ownerValue; } catch { if (ownerFilePresent) ownerValueMatches = null; }
  return deepFreeze({ leaseDirPresent, leaseDirIdentity, ownerFilePresent, ownerFileIdentity, ownerValue, ownerValueMatches, ownerKnownOutcome: 'unknown' as const, ...(error !== undefined ? { error: message(error).slice(0, 1024) } : {}) });
}
function verifyLeaseForRelease(lease: LeaseRecord): void {
  const dst = checkedLstat(lease.dir, 'leaseDir');
  if (!dst.isDirectory() || dst.isSymbolicLink() || !sameIdentity(lease.dirIdentity, dst)) throw new Error('destination lease directory changed');
  const ownerSt = checkedLstat(lease.ownerFile, 'lease owner');
  if (!ownerSt.isFile() || ownerSt.isSymbolicLink() || !sameIdentity(lease.ownerIdentity, ownerSt)) throw new Error('destination lease owner changed');
  const value = decodeUtf8(readFileBounded(lease.ownerFile, 4096, 'lease owner too large'), 'lease owner is not utf8');
  if (value !== lease.ownerValue) throw new Error('destination lease owner mismatch');
  const dir = opendirSync(lease.dir);
  try { for (;;) { const ent = dir.readSync(); if (!ent) break; if (ent.name !== 'owner') throw new Error('destination lease has unexpected entries'); } } finally { dir.closeSync(); }
}
function cleanupArtifacts(stageRoot: string, marker: string, owner: string, auth: StageAuthority, leases: LeaseRecord[], keys: string[], ctx?: LeaseReleaseContext): void {
  assertOwnedStage(stageRoot, marker, owner, auth);
  for (const rel of [...auth.files.keys()].sort((a, b) => b.length - a.length)) { const abs = join(stageRoot, rel); if (existsNoFollow(abs)) { assertStageFile(abs, rel); unlinkSync(abs); } }
  const mst = checkedLstat(marker, 'workspace marker'); if (!sameIdentity(auth.marker, mst)) throw new Error('workspace marker identity changed'); unlinkSync(marker);
  for (const rel of [...auth.dirs.keys()].filter(Boolean).sort((a, b) => b.length - a.length)) { const abs = join(stageRoot, rel); const st = checkedLstat(abs, rel); const id = auth.dirs.get(rel)!; if (!sameIdentity(id, st) || !st.isDirectory()) throw new Error(`stage directory identity changed: ${rel}`); rmdirSync(abs); }
  const rst = checkedLstat(stageRoot, 'stageRoot'); if (!sameIdentity(auth.root, rst)) throw new Error('stageRoot identity changed'); rmdirSync(stageRoot);
  releaseLeases(leases, keys, ctx);
}
