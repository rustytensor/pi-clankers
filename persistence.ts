import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, opendirSync, openSync, readSync, readFileSync, readlinkSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, parse as parsePath, resolve as resolvePath } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { AGENT_RESULTS_KEY, restoreAgentResults } from './agent-results.js';
import { recoverWorkflowState } from './workflow-runtime.js';
import { WORKFLOW_EXTENSION_KEY } from './workflow-model.js';
import { recoverSessionMessages } from './session-messages.js';
import {
  appendZergLogRecord,
  applyRuntimeTransition,
  createZergState,
  getSubagentRunSnapshots,
  getZergLogState,
} from './state.js';
import {
  ZERG_EXTENSION_VERSION,
  ZERG_STATE_SCHEMA_VERSION,
  type AgentStatus,
  type ZergExtensionFields,
  type ZergLifecycleSubstate,
  type ZergPersistenceInfo,
  type ZergPersistenceOptions,
  type ZergRunRecoveryInfo,
  type ZergState,
  type ZergStateContainer,
} from './types.js';

const DEFAULT_PERSISTENCE_RELATIVE_PATH = '.pi/zerg-swarm/v1/state.json';
const ZERG_CONTROL_EXTENSION_KEY = 'zergControl';
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const SNAPSHOT_SIZE_ERROR = 'Zerg persistence snapshot exceeds the 64 MiB UTF-8 byte limit.';
const ZERG_PERSISTENCE_EXTENSION_KEY = 'zergPersistence';
const RECOVERY_OWNER_MARKER = 'owner.json';
const RECOVERY_OWNER_MAX_BYTES = 16 * 1024;
const EMPTY_SNAPSHOT_SHA256 = createHash('sha256').update('').digest('hex');

interface ZergPersistenceEnvelope {
  version: 1;
  packageVersion: string;
  stateSchemaVersion: string;
  writerSessionId: string;
  savedAt: string;
  state: ZergState;
}

export interface RecoveryWriterOwnerEvidence {
  readonly bootId: string;
  readonly pid: number;
  readonly startTimeTicks: string;
  readonly writerSessionId: string;
  readonly generation: string;
  readonly lockDev?: number;
  readonly lockIno?: number;
  readonly markerDev?: number;
  readonly markerIno?: number;
}

export interface RecoveryOwnershipInfo {
  readonly owner: RecoveryWriterOwnerEvidence;
  readonly lockDir: string;
  readonly expectedSnapshotHash: string;
}

export interface RecoveryOwnershipAcquireOptions {
  readonly expectedSnapshotHash?: string;
  readonly verifiedDeadOwner?: RecoveryWriterOwnerEvidence;
}

export interface RecoveryOwnershipInspection {
  readonly snapshotFile: string;
  readonly lockDir: string;
  readonly claimDir: string;
  readonly actualSnapshotHash?: string;
  readonly expectedSnapshotHash?: string;
  readonly owner?: RecoveryWriterOwnerEvidence;
  readonly ownerValid: boolean;
  readonly blocker?: string;
  readonly claimPresent: boolean;
}

export interface RecoverySnapshotCommitOptions {
  readonly expectedSnapshotHash?: string;
  readonly now?: () => Date;
}

export interface ZergPersistenceManager {
  readonly info: ZergPersistenceInfo;
  hydrate(container: ZergStateContainer, now?: () => Date): ZergPersistenceInfo;
  save(state: ZergState, now?: () => Date): ZergPersistenceInfo;
  inspectRecoveryOwnership?(): RecoveryOwnershipInspection;
  acquireRecoveryOwnership?(options?: RecoveryOwnershipAcquireOptions): RecoveryOwnershipInfo;
  releaseRecoveryOwnership?(owner: RecoveryWriterOwnerEvidence): void;
  commitRecoverySnapshot?(state: ZergState, options?: RecoverySnapshotCommitOptions): ZergPersistenceInfo;
}

export function createZergPersistenceManager(options: ZergPersistenceOptions | undefined): ZergPersistenceManager | undefined {
  if (!options?.enabled && !options?.rootDir && !options?.snapshotFile) {
    return undefined;
  }
  if (options.enabled === false) {
    return undefined;
  }
  const snapshotFile = options.snapshotFile
    ? resolvePath(options.snapshotFile)
    : resolvePath(options.rootDir ?? process.cwd(), DEFAULT_PERSISTENCE_RELATIVE_PATH);
  const writerSessionId = `zerg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  let info: ZergPersistenceInfo = { enabled: true, snapshotFile, writerSessionId };
  const recoveryWriter = createRecoveryWriter(snapshotFile, writerSessionId);

  return {
    get info() {
      return { ...info, recoveredRunIds: info.recoveredRunIds ? [...info.recoveredRunIds] : undefined };
    },
    hydrate(container, now) {
      const hydrated = hydrateZergState(container.read(), snapshotFile, writerSessionId, now);
      recoveryWriter.noteHydratedHead(hydrated.head);
      info = hydrated.info;
      if (hydrated.state) {
        container.replace(hydrated.state);
      }
      return this.info;
    },
    save(state, now) {
      info = recoveryWriter.saveGeneric(state, info, now);
      return this.info;
    },
    inspectRecoveryOwnership() {
      return recoveryWriter.inspect();
    },
    acquireRecoveryOwnership(options) {
      return recoveryWriter.acquire(options);
    },
    releaseRecoveryOwnership(owner) {
      recoveryWriter.release(owner);
    },
    commitRecoverySnapshot(state, options) {
      info = recoveryWriter.commit(state, info, options);
      return this.info;
    },
  };
}

interface RecoveryWriterController {
  inspect(): RecoveryOwnershipInspection;
  noteHydratedHead(result: HydratedSnapshotHead): void;
  acquire(options?: RecoveryOwnershipAcquireOptions): RecoveryOwnershipInfo;
  release(owner: RecoveryWriterOwnerEvidence): void;
  commit(state: ZergState, previousInfo: ZergPersistenceInfo, options?: RecoverySnapshotCommitOptions): ZergPersistenceInfo;
  saveGeneric(state: ZergState, previousInfo: ZergPersistenceInfo, now?: () => Date): ZergPersistenceInfo;
}

interface SnapshotHeadCache {
  readonly kind: 'empty' | 'regular' | 'nonregular-link';
  readonly hash: string;
  readonly dev?: number;
  readonly ino?: number;
  readonly size?: number;
  readonly mtimeMs?: number;
  readonly ctimeMs?: number;
}

interface HydratedSnapshotHead {
  readonly kind?: 'empty' | 'regular' | 'nonregular-link';
  readonly hash?: string;
  readonly dev?: number;
  readonly ino?: number;
  readonly size?: number;
  readonly mtimeMs?: number;
  readonly ctimeMs?: number;
  readonly loadError?: string;
}

function createRecoveryWriter(snapshotFile: string, writerSessionId: string): RecoveryWriterController {
  const lockDir = `${snapshotFile}.recovery-writer.lock`;
  const markerFile = `${lockDir}/${RECOVERY_OWNER_MARKER}`;
  const claimDir = `${snapshotFile}.recovery-writer.claim`;
  let owned: RecoveryOwnershipInfo | undefined;
  let poisoned: string | undefined;
  let observedHead: SnapshotHeadCache | undefined;
  let observedLoadError: string | undefined;

  function poison(message: string): never {
    poisoned = message;
    throw new Error(message);
  }
  function assertUsable(): void {
    if (poisoned) throw new Error(`Zerg recovery persistence manager is poisoned: ${poisoned}`);
  }
  function makeOwner(): RecoveryWriterOwnerEvidence {
    const identity = getCurrentLinuxProcessIdentity();
    return { ...identity, writerSessionId, generation: randomBytes(16).toString('hex') };
  }
  function withClaim<T>(body: () => T): T {
    assertUsable();
    assertRecoveryPathSafe(snapshotFile, true);
    mkdirSync(claimDir, { mode: 0o700 });
    const claimStat = lstatSync(claimDir);
    if (!claimStat.isDirectory()) throw new Error('Recovery writer claim is not a directory.');
    let bodyError: unknown;
    let result: T;
    try {
      result = body();
    } catch (error) {
      bodyError = error;
    }
    try {
      const current = lstatSync(claimDir);
      if (current.dev !== claimStat.dev || current.ino !== claimStat.ino || !current.isDirectory()) {
        throw new Error('Recovery writer claim identity changed before release.');
      }
      rmdirSync(claimDir);
      if (bodyError === undefined) fsyncDirectory(dirname(claimDir));
    } catch (cleanupError) {
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      poisoned = `Recovery writer claim cleanup failed or is uncertain: ${message}`;
      if (bodyError !== undefined) {
        throw new AggregateError([bodyError, cleanupError], `Recovery writer operation failed and claim cleanup failed or is uncertain: ${message}`);
      }
      throw new Error(`Zerg recovery persistence manager is poisoned: ${poisoned}`);
    }
    if (bodyError !== undefined) throw bodyError;
    return result!;
  }
  function currentSnapshotHead(): SnapshotHeadCache {
    return hashExistingSnapshotWithIdentity(snapshotFile);
  }
  function currentGenericSnapshotHead(): SnapshotHeadCache {
    return hashGenericSnapshotWithIdentity(snapshotFile);
  }
  function rememberSnapshotPublication(hash: string): void {
    assertSnapshotHash(hash);
    observedHead = { kind: 'regular', hash };
    observedLoadError = undefined;
  }
  function expectedObservedHash(): string | undefined {
    return observedHead?.hash;
  }
  function requireObservedGenericAdmission(currentHead: SnapshotHeadCache): void {
    if (observedLoadError) {
      if (!observedHead || observedHead.kind !== 'nonregular-link' || currentHead.kind !== 'nonregular-link' || !snapshotHeadsMatch(observedHead, currentHead)) {
        throw new Error(`Generic zerg snapshot save blocked by prior persistence load error: ${observedLoadError}`);
      }
    }
    if (observedHead && !snapshotHeadsMatch(observedHead, currentHead)) {
      throw new Error('Generic zerg snapshot save blocked by stale observed snapshot head.');
    }
    if (!observedHead) observedHead = currentHead;
  }
  function installOwner(expectedSnapshotHash: string): RecoveryOwnershipInfo {
    const owner = makeOwner();
    mkdirSync(lockDir, { mode: 0o700 });
    const lockStat = lstatSync(lockDir);
    if (!lockStat.isDirectory()) throw new Error('Recovery writer lock is not a directory after creation.');
    let markerDescriptor: number | undefined;
    try {
      markerDescriptor = openSync(markerFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      const markerStat = fstatSync(markerDescriptor);
      if (!markerStat.isFile()) throw new Error('Recovery owner marker is not a regular file after creation.');
      const completeOwner = { ...owner, lockDev: lockStat.dev, lockIno: lockStat.ino, markerDev: markerStat.dev, markerIno: markerStat.ino };
      const serialized = `${JSON.stringify({ version: 1, owner: completeOwner }, null, 2)}\n`;
      if (Buffer.byteLength(serialized, 'utf8') > RECOVERY_OWNER_MAX_BYTES) throw new Error('Recovery owner evidence is too large.');
      writeFileSync(markerDescriptor, serialized, 'utf8');
      fsyncSync(markerDescriptor);
      closeSync(markerDescriptor);
      markerDescriptor = undefined;
      fsyncDirectory(lockDir);
      fsyncDirectory(dirname(lockDir));
      const verify = readRecoveryOwner(lockDir);
      if (!ownersEqual(verify.owner, completeOwner)) throw new Error('Recovery owner marker verification failed.');
      owned = freezeOwnershipInfo({ owner: completeOwner, lockDir, expectedSnapshotHash });
      return freezeOwnershipInfo(owned);
    } catch (error) {
      if (markerDescriptor !== undefined) closeSync(markerDescriptor);
      // After mkdir/open evidence may be incomplete or uncertain; retain it rather than fabricating cleanup.
      throw error;
    }
  }
  function acquire(options: RecoveryOwnershipAcquireOptions = {}): RecoveryOwnershipInfo {
    assertUsable();
    if (observedLoadError) {
      throw new Error(`Recovery ownership acquisition blocked by prior persistence load error: ${boundedDiagnostic(observedLoadError)}`);
    }
    if (owned) {
      const verified = verifyOwned(options.expectedSnapshotHash);
      const managerExpected = expectedObservedHash();
      if (managerExpected !== undefined && verified.expectedSnapshotHash !== managerExpected) {
        poison('Recovery owned snapshot head no longer matches manager observed snapshot head.');
      }
      return freezeOwnershipInfo(verified);
    }
    return withClaim(() => {
      const currentHead = currentSnapshotHead();
      const managerExpected = expectedObservedHash();
      const expectedSnapshotHash = options.expectedSnapshotHash ?? managerExpected ?? currentHead.hash;
      assertSnapshotHash(expectedSnapshotHash);
      if (managerExpected !== undefined && expectedSnapshotHash !== managerExpected) {
        throw new Error('Recovery expected snapshot hash does not match manager observed snapshot head.');
      }
      if (currentHead.hash !== expectedSnapshotHash) {
        throw new Error('Recovery expected snapshot hash does not match current snapshot head.');
      }
      try {
        return installOwner(expectedSnapshotHash);
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST') throw error;
      }
      if (!options.verifiedDeadOwner) {
        throw new Error('Recovery writer ownership is held or unsafe; explicit verified-dead owner evidence is required for takeover.');
      }
      const existing = readRecoveryOwner(lockDir);
      if (!ownersEqual(existing.owner, options.verifiedDeadOwner)) {
        throw new Error('Recovery writer takeover evidence does not match current owner.');
      }
      if (!isOwnerSafelyDead(existing.owner)) {
        throw new Error('Recovery writer owner is live or cannot be proven dead.');
      }
      const entries = readAtMostDirectoryEntries(lockDir, 2);
      if (entries.length !== 1 || entries[0] !== RECOVERY_OWNER_MARKER) {
        throw new Error('Recovery writer lock contains retained evidence and cannot be automatically deleted.');
      }
      const before = readRecoveryOwner(lockDir);
      if (!ownersEqual(before.owner, existing.owner)) throw new Error('Recovery writer lock changed before takeover cleanup.');
      unlinkSync(markerFile);
      rmdirSync(lockDir);
      fsyncDirectory(dirname(lockDir));
      return installOwner(expectedSnapshotHash);
    });
  }
  function verifyOwned(expectedSnapshotHash?: string): RecoveryOwnershipInfo {
    assertUsable();
    if (!owned) throw new Error('Recovery writer ownership has not been acquired.');
    const current = readRecoveryOwner(lockDir);
    if (!ownersEqual(current.owner, owned.owner)) poison('Recovery writer ownership generation changed.');
    if (expectedSnapshotHash !== undefined) {
      assertSnapshotHash(expectedSnapshotHash);
      if (expectedSnapshotHash !== owned.expectedSnapshotHash) {
        poison('Recovery explicit expected snapshot hash does not match owned recovery head.');
      }
    }
    const expected = owned.expectedSnapshotHash;
    const actual = hashExistingSnapshot(snapshotFile);
    if (actual !== expected) poison('Recovery snapshot head hash changed before commit.');
    return freezeOwnershipInfo({ ...owned, expectedSnapshotHash: expected });
  }
  return {
    inspect() {
      let out = inspectRecoveryOwnershipSnapshot(snapshotFile, lockDir, claimDir, expectedObservedHash());
      const extraBlockers: string[] = [];
      if (poisoned) extraBlockers.push(`poisoned: ${boundedDiagnostic(poisoned)}`);
      if (observedLoadError) extraBlockers.push(`observed load error: ${boundedDiagnostic(observedLoadError)}`);
      if (out.claimPresent) extraBlockers.push('recovery claim is present.');
      if (out.actualSnapshotHash && out.expectedSnapshotHash && out.actualSnapshotHash !== out.expectedSnapshotHash) extraBlockers.push('snapshot head is stale relative to manager observation.');
      if (extraBlockers.length > 0) out = { ...out, blocker: [out.blocker, ...extraBlockers].filter(Boolean).join(' ') };
      return freezeInspection(out);
    },
    noteHydratedHead(result) {
      if (result.hash) observedHead = { kind: result.kind ?? 'regular', hash: result.hash, dev: result.dev, ino: result.ino, size: result.size, mtimeMs: result.mtimeMs, ctimeMs: result.ctimeMs };
      else observedHead = undefined;
      observedLoadError = result.loadError;
    },
    acquire,
    release(owner) {
      assertUsable();
      withClaim(() => {
        if (!owned || !ownersEqual(owned.owner, owner)) throw new Error('Recovery writer release owner does not match this manager.');
        try {
          const current = readRecoveryOwner(lockDir);
          if (!ownersEqual(current.owner, owner)) poison('Recovery writer ownership changed before release.');
          const entries = readAtMostDirectoryEntries(lockDir, 2);
          if (entries.length !== 1 || entries[0] !== RECOVERY_OWNER_MARKER) throw new Error('Recovery writer lock contains unexpected retained evidence.');
          unlinkSync(markerFile);
          rmdirSync(lockDir);
          fsyncDirectory(dirname(lockDir));
          owned = undefined;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          poison(`Recovery writer release failed or is uncertain: ${message}`);
        }
      });
    },
    commit(state, previousInfo, options = {}) {
      return withClaim(() => {
        const verified = verifyOwned(options.expectedSnapshotHash);
        try {
          const nextInfo = saveZergStateSnapshot(state, snapshotFile, writerSessionId, previousInfo, options.now, true);
          const publishedHash = hashExistingSnapshot(snapshotFile);
          owned = freezeOwnershipInfo({ ...verified, expectedSnapshotHash: publishedHash });
          rememberSnapshotPublication(publishedHash);
          return nextInfo;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          poison(`Recovery snapshot commit failed or is uncertain: ${message}`);
        }
      });
    },
    saveGeneric(state, previousInfo, now) {
      assertUsable();
      const prepared = prepareZergStateSnapshot(state, snapshotFile, writerSessionId, previousInfo, now);
      return withClaim(() => {
        const evidence = readRecoveryOwnerIfPresent(lockDir);
        if (evidence && (!owned || !ownersEqual(evidence.owner, owned.owner))) {
          throw new Error('Generic zerg snapshot save blocked by outstanding recovery writer ownership.');
        }
        const sourceHead = currentGenericSnapshotHead();
        const poisonOnUncertain = owned !== undefined;
        if (owned) {
          const verified = verifyOwned();
          requireObservedGenericAdmission(sourceHead);
          try {
            const next = savePreparedZergStateSnapshot(snapshotFile, prepared, poisonOnUncertain);
            const current = readRecoveryOwner(lockDir);
            if (!ownersEqual(current.owner, owned.owner)) poison('Recovery writer ownership changed during generic save.');
            const publishedHash = hashExistingSnapshot(snapshotFile);
            owned = freezeOwnershipInfo({ ...verified, expectedSnapshotHash: publishedHash });
            rememberSnapshotPublication(publishedHash);
            return next;
          } catch (error) {
            poison(`Recovery owned snapshot save failed or is uncertain: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        requireObservedGenericAdmission(sourceHead);
        const next = savePreparedZergStateSnapshot(snapshotFile, prepared, false);
        rememberSnapshotPublication(hashExistingSnapshot(snapshotFile));
        return next;
      });
    },
  };
}

function hydrateZergState(
  current: ZergState,
  snapshotFile: string,
  writerSessionId: string,
  now: (() => Date) | undefined,
): { state?: ZergState; info: ZergPersistenceInfo; head: HydratedSnapshotHead } {
  const baseInfo: ZergPersistenceInfo = { enabled: true, snapshotFile, writerSessionId };
  let readHead: HydratedSnapshotHead | undefined;
  try {
    // Follow legitimate final symlinks; missing paths start empty, invalid final links remain replaceable legacy evidence.
    // This is file admission, not ancestor confinement or a filesystem sandbox.
    const expected = statSync(snapshotFile, { throwIfNoEntry: false });
    if (!expected) {
      const link = lstatSync(snapshotFile, { throwIfNoEntry: false });
      if (!link) return { info: baseInfo, head: { kind: 'empty', hash: EMPTY_SNAPSHOT_SHA256 } };
      if (link.isSymbolicLink()) {
        // A dangling final link has no readable snapshot, as in legacy loading.
        // Remember the link itself only to guard a later explicit generic save.
        return { info: baseInfo, head: hashFinalSymlinkIdentity(snapshotFile, link) };
      }
      throw new Error('Zerg persistence snapshot must be a regular file.');
    }
    if (!expected.isFile()) {
      const link = lstatSync(snapshotFile, { throwIfNoEntry: false });
      if (link?.isSymbolicLink()) readHead = hashFinalSymlinkIdentity(snapshotFile, link);
      throw new Error('Zerg persistence snapshot must be a regular file.');
    }
    if (expected.size > MAX_SNAPSHOT_BYTES) throw new Error(SNAPSHOT_SIZE_ERROR);
    // Nonblocking admission prevents a file/target swapped for a FIFO from hanging open.
    const descriptor = openSync(snapshotFile, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    let envelope: Partial<ZergPersistenceEnvelope>;
    try {
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
        throw new Error('Zerg persistence snapshot changed before reading.');
      }
      if (opened.size > MAX_SNAPSHOT_BYTES) throw new Error(SNAPSHOT_SIZE_ERROR);
      // Size admission alone cannot bound a file that grows during reading.
      // Decode incrementally with one fixed buffer, reading at most limit + 1.
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const decoder = new StringDecoder('utf8');
      const text: string[] = [];
      const hash = createHash('sha256');
      let bytes = 0;
      for (;;) {
        const count = readSync(descriptor, chunk, 0, Math.min(chunk.length, MAX_SNAPSHOT_BYTES - bytes + 1), null);
        if (count === 0) break;
        bytes += count;
        if (bytes > MAX_SNAPSHOT_BYTES) throw new Error(SNAPSHOT_SIZE_ERROR);
        const part = chunk.subarray(0, count);
        hash.update(part);
        text.push(decoder.write(part));
      }
      const finished = fstatSync(descriptor);
      if (!finished.isFile() || finished.dev !== opened.dev || finished.ino !== opened.ino) {
        throw new Error('Zerg persistence snapshot changed while reading.');
      }
      if (finished.size > MAX_SNAPSHOT_BYTES) throw new Error(SNAPSHOT_SIZE_ERROR);
      text.push(decoder.end());
      const headHash = hash.digest('hex');
      readHead = { kind: 'regular', hash: headHash, dev: opened.dev, ino: opened.ino, size: opened.size, mtimeMs: opened.mtimeMs, ctimeMs: opened.ctimeMs };
      envelope = JSON.parse(text.join('')) as Partial<ZergPersistenceEnvelope>;
    } finally {
      closeSync(descriptor);
    }
    if (envelope.version !== 1 || !isPlainRecord(envelope.state)) {
      const message = 'Unsupported zerg persistence snapshot format.';
      return { info: { ...baseInfo, lastLoadError: message }, head: { ...readHead, loadError: message } };
    }
    const rawState = envelope.state as Partial<ZergState>;
    const preparedState = rawState.extensions?.[AGENT_RESULTS_KEY] === undefined ? rawState : { ...rawState,
      extensions: { ...rawState.extensions, [AGENT_RESULTS_KEY]: restoreAgentResults(rawState.extensions[AGENT_RESULTS_KEY]) } };
    const loaded = createZergState(preparedState);
    // Recovery may retain saved readOnly, but must never revoke current authority.
    if (current.mode.readOnly === true) loaded.mode.readOnly = true;
    const recovered = recoverZergStateAfterRestart(loaded, {
      now,
      previousWriterSessionId: typeof envelope.writerSessionId === 'string' ? envelope.writerSessionId : undefined,
    });
    const info: ZergPersistenceInfo = {
      ...baseInfo,
      lastLoadedAt: new Date().toISOString(),
      recoveredRunIds: recovered.recoveredRunIds,
    };
    return { state: writePersistenceInfo(recovered.state, info), info, head: readHead ?? { loadError: 'Snapshot head was not captured.' } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { info: { ...baseInfo, lastLoadError: message }, head: { ...readHead, loadError: message } };
  }
}

interface PreparedZergStateSnapshot {
  readonly info: ZergPersistenceInfo;
  readonly serialized: string;
}

function prepareZergStateSnapshot(
  state: ZergState,
  snapshotFile: string,
  writerSessionId: string,
  previousInfo: ZergPersistenceInfo,
  now: (() => Date) | undefined,
): PreparedZergStateSnapshot {
  const savedAt = (now ?? (() => new Date()))().toISOString();
  const info: ZergPersistenceInfo = { ...previousInfo, enabled: true, snapshotFile, writerSessionId, lastSavedAt: savedAt };
  const stateToSave = writePersistenceInfo(state, info);
  const envelope: ZergPersistenceEnvelope = {
    version: 1,
    packageVersion: ZERG_EXTENSION_VERSION,
    stateSchemaVersion: ZERG_STATE_SCHEMA_VERSION,
    writerSessionId,
    savedAt,
    state: sanitizeJsonValue(stateToSave) as ZergState,
  };
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SNAPSHOT_BYTES) throw new Error(SNAPSHOT_SIZE_ERROR);
  return { info, serialized };
}

function saveZergStateSnapshot(
  state: ZergState,
  snapshotFile: string,
  writerSessionId: string,
  previousInfo: ZergPersistenceInfo,
  now: (() => Date) | undefined,
  poisonOnUncertain = false,
): ZergPersistenceInfo {
  return savePreparedZergStateSnapshot(snapshotFile, prepareZergStateSnapshot(state, snapshotFile, writerSessionId, previousInfo, now), poisonOnUncertain);
}

function savePreparedZergStateSnapshot(
  snapshotFile: string,
  prepared: PreparedZergStateSnapshot,
  poisonOnUncertain = false,
): ZergPersistenceInfo {
  mkdirSync(dirname(snapshotFile), { recursive: true });
  const tempFile = `${snapshotFile}.${process.pid}.${Date.now().toString(36)}.tmp`;
  // Exclusive creation refuses pre-existing files/symlinks. Do not clean up a
  // collision: only a successful open gives this save ownership of the temp.
  let descriptor: number | undefined = openSync(tempFile, 'wx', 0o600);
  try {
    writeFileSync(descriptor, prepared.serialized, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(tempFile, snapshotFile);
    fsyncDirectory(dirname(snapshotFile));
  } catch (error) {
    const failures: unknown[] = [error];
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch (cleanupError) { failures.push(cleanupError); }
    }
    try { unlinkSync(tempFile); } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException)?.code !== 'ENOENT') failures.push(cleanupError);
    }
    if (failures.length > 1) throw new AggregateError(failures, 'Zerg snapshot save failed and temporary-file cleanup failed.');
    if (poisonOnUncertain) throw new Error(`Zerg snapshot commit failed; recovery manager must be discarded: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
  return prepared.info;
}

export function recoverZergStateAfterRestart(
  state: ZergState,
  options: { now?: () => Date; previousWriterSessionId?: string } = {},
): { state: ZergState; recoveredRunIds: string[] } {
  const recoveredAt = (options.now ?? (() => new Date()))().toISOString();
  let next = recoverSessionMessages(state, recoveredAt);
  if (state.extensions[AGENT_RESULTS_KEY] !== undefined) next = { ...next,
    extensions: { ...next.extensions, [AGENT_RESULTS_KEY]: restoreAgentResults(state.extensions[AGENT_RESULTS_KEY]) } };
  if (state.extensions[WORKFLOW_EXTENSION_KEY] !== undefined) {
    try {
      next = { ...next, extensions: { ...next.extensions,
        [WORKFLOW_EXTENSION_KEY]: recoverWorkflowState(state.extensions[WORKFLOW_EXTENSION_KEY]),
      } };
    } catch (error) {
      // Preserve the raw namespace for inspection. Core admission rejects it;
      // corrupt workflow data must not suppress unrelated native recovery.
      next = appendZergLogRecord(next, { source: 'adapter', level: 'warn', kind: 'error', createdAt: recoveredAt,
        message: `Workflow recovery disabled; original namespace retained: ${(error instanceof Error ? error.message : String(error)).slice(0, 1024)}`,
      });
    }
  }
  const recoveredRunIds: string[] = [];

  for (const run of getSubagentRunSnapshots(state)) {
    if (run.nativeSessions?.some((reference) => reference.attachment === 'attached')) {
      const agent = next.agents[run.runId]!;
      next = {
        ...next,
        agents: { ...next.agents, [run.runId]: { ...agent, metadata: {
          ...agent.metadata,
          nativeSessions: run.nativeSessions.map((reference) => reference.attachment === 'attached'
            ? { ...reference, attachment: 'unavailable', recoveredAt }
            : { ...reference }),
        } } },
      };
    }
    if (isTerminalRun(run.status, run.substate)) continue;
    const previousStatus = run.status;
    const previousSubstate = run.substate;
    // Durable continuation lineage is historical evidence only. Review tokens are
    // owner-local and are never restored, admitted, or replayed by recovery.
    const recoveryReason = run.nativeContinuation
      ? 'continuation interrupted by Pi restart; live session unavailable; new reviewed task required'
      : 'recovered after Pi restart; live session unavailable';
    const recovery: ZergRunRecoveryInfo = {
      recoveredAt,
      reason: 'process-restart',
      previousStatus,
      previousSubstate,
      previousWriterSessionId: options.previousWriterSessionId,
    };
    next = applyRuntimeTransition(next, {
      entity: 'agent',
      action: 'fail',
      id: run.runId,
      label: run.agentLabel ?? run.agentId,
      kind: 'subagent',
      status: 'needs-attention',
      health: 'degraded',
      activity: recoveryReason,
      substate: 'failed',
      substateReason: recoveryReason,
      metadata: { ...next.agents[run.runId]?.metadata, recovery },
    }, { now: () => new Date(recoveredAt) });
    if (run.taskId && next.tasks[run.taskId]) {
      const task = next.tasks[run.taskId]!;
      next = {
        ...next,
        tasks: {
          ...next.tasks,
          [run.taskId]: {
            ...task,
            status: 'needs-attention',
            substate: 'failed',
            substateReason: recoveryReason,
            substateUpdatedAt: recoveredAt,
            updatedAt: recoveredAt,
            metadata: { ...task.metadata, recovery } as ZergExtensionFields,
          },
        },
      };
    }
    next = appendZergLogRecord(next, {
      source: 'adapter',
      level: 'warn',
      kind: 'text',
      runId: run.runId,
      agentId: run.agentId,
      taskId: run.taskId,
      message: `recovered ${run.runId} after Pi restart; live session unavailable`,
      data: { recovery },
      createdAt: recoveredAt,
    });
    recoveredRunIds.push(run.runId);
  }

  if (recoveredRunIds.length > 0) {
    next = clearRecoveredActiveRun(next, recoveredRunIds);
  }
  return { state: next, recoveredRunIds };
}

function clearRecoveredActiveRun(state: ZergState, recoveredRunIds: readonly string[]): ZergState {
  const control = state.extensions[ZERG_CONTROL_EXTENSION_KEY];
  if (!isPlainRecord(control) || typeof control.activeRunId !== 'string' || !recoveredRunIds.includes(control.activeRunId)) {
    return state;
  }
  return {
    ...state,
    extensions: {
      ...state.extensions,
      [ZERG_CONTROL_EXTENSION_KEY]: { ...control, activeRunId: undefined },
    },
  };
}

function writePersistenceInfo(state: ZergState, info: ZergPersistenceInfo): ZergState {
  return {
    ...state,
    extensions: {
      ...state.extensions,
      [ZERG_PERSISTENCE_EXTENSION_KEY]: { ...info, recoveredRunIds: info.recoveredRunIds ? [...info.recoveredRunIds] : undefined },
      zergLogs: getZergLogState(state),
    },
  };
}

function isTerminalRun(status: AgentStatus, substate: ZergLifecycleSubstate | undefined): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled' || substate === 'completed' || substate === 'failed' || substate === 'cancelled';
}

function sanitizeJsonValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return undefined;
  if (Array.isArray(value)) return value.map((entry) => sanitizeJsonValue(entry, seen));
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const clean = sanitizeJsonValue(entry, seen);
    if (clean !== undefined) output[key] = clean;
  }
  seen.delete(value);
  return output;
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}


function assertSnapshotHash(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('Recovery expected snapshot hash must be lowercase SHA-256 hex.');
}

function statSignature(stat: { size: number; mtimeMs: number; ctimeMs: number }): { size: number; mtimeMs: number; ctimeMs: number } {
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function sameStatSignature(a: { size: number; mtimeMs: number; ctimeMs: number }, b: { size: number; mtimeMs: number; ctimeMs: number }): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function assertPrivateFilesystemEvidence(stat: { mode: number; uid?: number }, expectedMode: number, label: string): void {
  if ((stat.mode & 0o777) !== expectedMode) throw new Error(`${label} has invalid unsafe permissions.`);
  const getuid = process.getuid;
  if (typeof getuid === 'function' && stat.uid !== getuid.call(process)) throw new Error(`${label} has invalid unsafe owner uid.`);
}

function hashExistingSnapshot(snapshotFile: string): string {
  let expected;
  try {
    expected = lstatSync(snapshotFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return EMPTY_SNAPSHOT_SHA256;
    throw error;
  }
  if (!expected.isFile()) throw new Error('Recovery snapshot head must be a regular file.');
  if (expected.size > MAX_SNAPSHOT_BYTES) throw new Error(SNAPSHOT_SIZE_ERROR);
  const expectedSig = statSignature(expected);
  const descriptor = openSync(snapshotFile, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw new Error('Recovery snapshot head changed before hashing.');
    }
    const openedSig = statSignature(opened);
    if (!sameStatSignature(expectedSig, openedSig)) {
      throw new Error('Recovery snapshot head metadata changed before hashing.');
    }
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    for (;;) {
      const count = readSync(descriptor, chunk, 0, Math.min(chunk.length, MAX_SNAPSHOT_BYTES - bytes + 1), null);
      if (count === 0) break;
      bytes += count;
      if (bytes > MAX_SNAPSHOT_BYTES) throw new Error(SNAPSHOT_SIZE_ERROR);
      hash.update(chunk.subarray(0, count));
    }
    const finished = fstatSync(descriptor);
    const finishedSig = statSignature(finished);
    if (!finished.isFile() || finished.dev !== opened.dev || finished.ino !== opened.ino || finished.size > MAX_SNAPSHOT_BYTES
      || bytes !== opened.size || !sameStatSignature(openedSig, finishedSig)) {
      throw new Error('Recovery snapshot head changed while hashing.');
    }
    const after = lstatSync(snapshotFile);
    if (!after.isFile() || after.dev !== expected.dev || after.ino !== expected.ino || !sameStatSignature(expectedSig, statSignature(after))) {
      throw new Error('Recovery snapshot path changed while hashing.');
    }
    return hash.digest('hex');
  } finally {
    closeSync(descriptor);
  }
}


function hashExistingSnapshotWithIdentity(snapshotFile: string): SnapshotHeadCache {
  let expected;
  try {
    expected = lstatSync(snapshotFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return { kind: 'empty', hash: EMPTY_SNAPSHOT_SHA256 };
    throw error;
  }
  if (!expected.isFile()) throw new Error('Recovery snapshot head must be a regular file.');
  if (expected.size > MAX_SNAPSHOT_BYTES) throw new Error(SNAPSHOT_SIZE_ERROR);
  const expectedSig = statSignature(expected);
  const descriptor = openSync(snapshotFile, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw new Error('Recovery snapshot head changed before hashing.');
    }
    const openedSig = statSignature(opened);
    if (!sameStatSignature(expectedSig, openedSig)) throw new Error('Recovery snapshot head metadata changed before hashing.');
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    for (;;) {
      const count = readSync(descriptor, chunk, 0, Math.min(chunk.length, MAX_SNAPSHOT_BYTES - bytes + 1), null);
      if (count === 0) break;
      bytes += count;
      if (bytes > MAX_SNAPSHOT_BYTES) throw new Error(SNAPSHOT_SIZE_ERROR);
      hash.update(chunk.subarray(0, count));
    }
    const finished = fstatSync(descriptor);
    const finishedSig = statSignature(finished);
    if (!finished.isFile() || finished.dev !== opened.dev || finished.ino !== opened.ino || finished.size > MAX_SNAPSHOT_BYTES
      || bytes !== opened.size || !sameStatSignature(openedSig, finishedSig)) {
      throw new Error('Recovery snapshot head changed while hashing.');
    }
    const after = lstatSync(snapshotFile);
    if (!after.isFile() || after.dev !== expected.dev || after.ino !== expected.ino || !sameStatSignature(expectedSig, statSignature(after))) {
      throw new Error('Recovery snapshot path changed while hashing.');
    }
    return { kind: 'regular', hash: hash.digest('hex'), dev: opened.dev, ino: opened.ino, size: opened.size, mtimeMs: opened.mtimeMs, ctimeMs: opened.ctimeMs };
  } finally {
    closeSync(descriptor);
  }
}


function hashGenericSnapshotWithIdentity(snapshotFile: string): SnapshotHeadCache {
  const followed = statSync(snapshotFile, { throwIfNoEntry: false });
  if (!followed) {
    const link = lstatSync(snapshotFile, { throwIfNoEntry: false });
    if (!link) return { kind: 'empty', hash: EMPTY_SNAPSHOT_SHA256 };
    if (link.isSymbolicLink()) return hashFinalSymlinkIdentity(snapshotFile, link);
    throw new Error('Generic zerg snapshot head must be a regular file, missing path, or replaceable final symlink.');
  }
  if (!followed.isFile()) {
    const link = lstatSync(snapshotFile, { throwIfNoEntry: false });
    if (link?.isSymbolicLink()) return hashFinalSymlinkIdentity(snapshotFile, link);
    throw new Error('Generic zerg snapshot head must be a regular file.');
  }
  if (followed.size > MAX_SNAPSHOT_BYTES) throw new Error(SNAPSHOT_SIZE_ERROR);
  const expectedSig = statSignature(followed);
  const descriptor = openSync(snapshotFile, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== followed.dev || opened.ino !== followed.ino) {
      throw new Error('Generic zerg snapshot head changed before hashing.');
    }
    const openedSig = statSignature(opened);
    if (!sameStatSignature(expectedSig, openedSig)) throw new Error('Generic zerg snapshot head metadata changed before hashing.');
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let bytes = 0;
    for (;;) {
      const count = readSync(descriptor, chunk, 0, Math.min(chunk.length, MAX_SNAPSHOT_BYTES - bytes + 1), null);
      if (count === 0) break;
      bytes += count;
      if (bytes > MAX_SNAPSHOT_BYTES) throw new Error(SNAPSHOT_SIZE_ERROR);
      hash.update(chunk.subarray(0, count));
    }
    const finished = fstatSync(descriptor);
    const finishedSig = statSignature(finished);
    if (!finished.isFile() || finished.dev !== opened.dev || finished.ino !== opened.ino || finished.size > MAX_SNAPSHOT_BYTES
      || bytes !== opened.size || !sameStatSignature(openedSig, finishedSig)) {
      throw new Error('Generic zerg snapshot head changed while hashing.');
    }
    const after = statSync(snapshotFile, { throwIfNoEntry: false });
    if (!after?.isFile() || after.dev !== followed.dev || after.ino !== followed.ino || !sameStatSignature(expectedSig, statSignature(after))) {
      throw new Error('Generic zerg snapshot path changed while hashing.');
    }
    return { kind: 'regular', hash: hash.digest('hex'), dev: opened.dev, ino: opened.ino, size: opened.size, mtimeMs: opened.mtimeMs, ctimeMs: opened.ctimeMs };
  } finally {
    closeSync(descriptor);
  }
}

function hashFinalSymlinkIdentity(snapshotFile: string, linkStat: Stats): SnapshotHeadCache {
  if (!linkStat.isSymbolicLink()) throw new Error('Generic zerg snapshot replacement candidate is not a symbolic link.');
  if (linkStat.size > MAX_SNAPSHOT_BYTES) throw new Error(SNAPSHOT_SIZE_ERROR);
  const target = readlinkSync(snapshotFile, 'utf8');
  if (Buffer.byteLength(target, 'utf8') > MAX_SNAPSHOT_BYTES) throw new Error(SNAPSHOT_SIZE_ERROR);
  const after = lstatSync(snapshotFile);
  if (!after.isSymbolicLink() || after.dev !== linkStat.dev || after.ino !== linkStat.ino || !sameStatSignature(statSignature(linkStat), statSignature(after))) {
    throw new Error('Generic zerg snapshot symlink changed while hashing.');
  }
  const hash = createHash('sha256');
  hash.update('symlink\0');
  hash.update(`${linkStat.dev}:${linkStat.ino}:${linkStat.size}:${linkStat.mtimeMs}:${linkStat.ctimeMs}\0`);
  hash.update(target, 'utf8');
  return { kind: 'nonregular-link', hash: hash.digest('hex'), dev: linkStat.dev, ino: linkStat.ino, size: linkStat.size, mtimeMs: linkStat.mtimeMs, ctimeMs: linkStat.ctimeMs };
}

function snapshotHeadsMatch(a: SnapshotHeadCache, b: SnapshotHeadCache): boolean {
  if (a.kind !== b.kind || a.hash !== b.hash) return false;
  if (a.kind === 'regular' && (a.dev === undefined || b.dev === undefined)) return true;
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function boundedDiagnostic(value: string): string {
  return value.length <= 1024 ? value : `${value.slice(0, 1024)}…`;
}

function readAtMostDirectoryEntries(path: string, maxEntries: number): string[] {
  const dir = opendirSync(path);
  const entries: string[] = [];
  try {
    for (;;) {
      const entry = dir.readSync();
      if (!entry) break;
      entries.push(entry.name);
      if (entries.length >= maxEntries) break;
    }
  } finally {
    dir.closeSync();
  }
  return entries;
}

function inspectRecoveryOwnershipSnapshot(snapshotFile: string, lockDir: string, claimDir: string, expectedSnapshotHash: string | undefined): RecoveryOwnershipInspection {
  let actualSnapshotHash: string | undefined;
  let owner: RecoveryWriterOwnerEvidence | undefined;
  let ownerValid = false;
  let blocker: string | undefined;
  let claimPresent = false;
  try {
    actualSnapshotHash = hashExistingSnapshot(snapshotFile);
  } catch (error) {
    blocker = `snapshot blocked: ${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    const claim = lstatSync(claimDir);
    if (!claim.isDirectory()) blocker = blocker ?? 'recovery claim path is not a directory.';
    claimPresent = claim.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') blocker = blocker ?? `claim blocked: ${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    const evidence = readRecoveryOwnerIfPresent(lockDir);
    if (evidence) {
      owner = evidence.owner;
      ownerValid = true;
    }
  } catch (error) {
    blocker = blocker ?? `owner blocked: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (expectedSnapshotHash !== undefined) assertSnapshotHash(expectedSnapshotHash);
  return { snapshotFile, lockDir, claimDir, actualSnapshotHash, expectedSnapshotHash, owner, ownerValid, blocker, claimPresent };
}

function freezeInspection(info: RecoveryOwnershipInspection): RecoveryOwnershipInspection {
  return Object.freeze({
    snapshotFile: info.snapshotFile,
    lockDir: info.lockDir,
    claimDir: info.claimDir,
    actualSnapshotHash: info.actualSnapshotHash,
    expectedSnapshotHash: info.expectedSnapshotHash,
    owner: info.owner ? Object.freeze({ ...info.owner }) : undefined,
    ownerValid: info.ownerValid,
    blocker: info.blocker,
    claimPresent: info.claimPresent,
  });
}

function readRecoveryOwnerIfPresent(lockDir: string): { owner: RecoveryWriterOwnerEvidence } | undefined {
  try {
    lstatSync(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
    throw error;
  }
  return readRecoveryOwner(lockDir);
}

function readRecoveryOwner(lockDir: string): { owner: RecoveryWriterOwnerEvidence } {
  const marker = `${lockDir}/${RECOVERY_OWNER_MARKER}`;
  const lockStat = lstatSync(lockDir);
  if (!lockStat.isDirectory()) throw new Error('Recovery owner lock is not a directory.');
  assertPrivateFilesystemEvidence(lockStat, 0o700, 'Recovery owner lock');
  let markerStat;
  try {
    markerStat = lstatSync(marker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error('Recovery owner evidence is missing, invalid, or too large.');
    }
    throw error;
  }
  if (!markerStat.isFile() || markerStat.size <= 0 || markerStat.size > RECOVERY_OWNER_MAX_BYTES) {
    throw new Error('Recovery owner evidence is missing, invalid, or too large.');
  }
  assertPrivateFilesystemEvidence(markerStat, 0o600, 'Recovery owner marker');
  if (markerStat.nlink !== 1) throw new Error('Recovery owner marker has unsafe hard links.');
  const descriptor = openSync(marker, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== markerStat.dev || opened.ino !== markerStat.ino || opened.size > RECOVERY_OWNER_MAX_BYTES) {
      throw new Error('Recovery owner marker changed before reading.');
    }
    assertPrivateFilesystemEvidence(opened, 0o600, 'Recovery owner marker');
    if (opened.nlink !== 1) throw new Error('Recovery owner marker has unsafe hard links.');
    const chunk = Buffer.allocUnsafe(4096);
    const decoder = new StringDecoder('utf8');
    const textParts: string[] = [];
    let bytes = 0;
    for (;;) {
      const count = readSync(descriptor, chunk, 0, Math.min(chunk.length, RECOVERY_OWNER_MAX_BYTES - bytes + 1), null);
      if (count === 0) break;
      bytes += count;
      if (bytes > RECOVERY_OWNER_MAX_BYTES) throw new Error('Recovery owner evidence is too large.');
      textParts.push(decoder.write(chunk.subarray(0, count)));
    }
    textParts.push(decoder.end());
    const finished = fstatSync(descriptor);
    if (!finished.isFile() || finished.dev !== opened.dev || finished.ino !== opened.ino || finished.size > RECOVERY_OWNER_MAX_BYTES
      || bytes !== opened.size || !sameStatSignature(statSignature(opened), statSignature(finished))) {
      throw new Error('Recovery owner marker changed while reading.');
    }
    const markerAfter = lstatSync(marker);
    const lockAfter = lstatSync(lockDir);
    if (!lockAfter.isDirectory() || lockAfter.dev !== lockStat.dev || lockAfter.ino !== lockStat.ino
      || !markerAfter.isFile() || markerAfter.dev !== markerStat.dev || markerAfter.ino !== markerStat.ino) {
      throw new Error('Recovery owner path identity changed while reading.');
    }
    const parsed = JSON.parse(textParts.join('')) as unknown;
    if (!isPlainRecord(parsed) || Object.keys(parsed).sort().join(',') !== 'owner,version' || parsed.version !== 1 || !isPlainRecord(parsed.owner)) {
      throw new Error('Recovery owner evidence has unsupported format.');
    }
    const owner = parseRecoveryOwner(parsed.owner);
    if (owner.lockDev !== undefined && (owner.lockDev !== lockStat.dev || owner.lockIno !== lockStat.ino)) {
      throw new Error('Recovery owner lock identity does not match current lock.');
    }
    if (owner.markerDev !== undefined && (owner.markerDev !== markerStat.dev || owner.markerIno !== markerStat.ino)) {
      throw new Error('Recovery owner marker identity does not match current marker.');
    }
    return { owner: { ...owner, lockDev: lockStat.dev, lockIno: lockStat.ino, markerDev: markerStat.dev, markerIno: markerStat.ino } };
  } finally {
    closeSync(descriptor);
  }
}

function parseRecoveryOwner(value: Record<string, unknown>): RecoveryWriterOwnerEvidence {
  const allowed = new Set(['bootId', 'pid', 'startTimeTicks', 'writerSessionId', 'generation', 'lockDev', 'lockIno', 'markerDev', 'markerIno']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error('Recovery owner evidence has unknown fields.');
  }
  const bootId = typeof value.bootId === 'string' ? value.bootId : '';
  const pid = typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0 ? value.pid : 0;
  const startTimeTicks = typeof value.startTimeTicks === 'string' ? value.startTimeTicks : '';
  const writer = typeof value.writerSessionId === 'string' ? value.writerSessionId : '';
  const generation = typeof value.generation === 'string' ? value.generation : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bootId) || pid <= 0 || !/^\d{1,32}$/.test(startTimeTicks) || writer.length < 1 || writer.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(writer) || !/^[0-9a-f]{32}$/.test(generation)) {
    throw new Error('Recovery owner evidence has invalid identity fields.');
  }
  const out: RecoveryWriterOwnerEvidence = { bootId, pid, startTimeTicks, writerSessionId: writer, generation };
  for (const key of ['lockDev', 'lockIno', 'markerDev', 'markerIno'] as const) {
    const n = value[key];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new Error('Recovery owner evidence has invalid filesystem identity.');
    (out as unknown as Record<string, number>)[key] = n;
  }
  return out;
}

function ownersEqual(a: RecoveryWriterOwnerEvidence, b: RecoveryWriterOwnerEvidence): boolean {
  return a.bootId === b.bootId && a.pid === b.pid && a.startTimeTicks === b.startTimeTicks
    && a.writerSessionId === b.writerSessionId && a.generation === b.generation
    && a.lockDev === b.lockDev && a.lockIno === b.lockIno && a.markerDev === b.markerDev && a.markerIno === b.markerIno;
}

function freezeOwnershipInfo(info: RecoveryOwnershipInfo): RecoveryOwnershipInfo {
  return Object.freeze({ owner: Object.freeze({ ...info.owner }), lockDir: info.lockDir, expectedSnapshotHash: info.expectedSnapshotHash });
}

function assertRecoveryPathSafe(snapshotFile: string, createParent: boolean): void {
  const parent = dirname(snapshotFile);
  if (createParent) mkdirSync(parent, { recursive: true });
  const parsed = parsePath(parent);
  let current = parsed.root;
  const rootStat = lstatSync(current);
  if (!rootStat.isDirectory()) throw new Error('Recovery snapshot root is not a directory.');
  const relative = parent.slice(parsed.root.length).split('/').filter(Boolean);
  for (const segment of relative) {
    current = current.endsWith('/') ? `${current}${segment}` : `${current}/${segment}`;
    const st = lstatSync(current);
    if (!st.isDirectory()) throw new Error('Recovery snapshot ancestor is not a directory.');
  }
}

function getCurrentLinuxProcessIdentity(): Pick<RecoveryWriterOwnerEvidence, 'bootId' | 'pid' | 'startTimeTicks'> {
  const bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const end = stat.lastIndexOf(')');
  if (end < 0) throw new Error('Cannot parse current process stat identity.');
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  const startTimeTicks = fields[19];
  if (!startTimeTicks || !/^\d+$/.test(startTimeTicks)) throw new Error('Cannot parse current process start-time identity.');
  return { bootId, pid: process.pid, startTimeTicks };
}

function isOwnerSafelyDead(owner: RecoveryWriterOwnerEvidence): boolean {
  let bootId: string;
  try { bootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return false; }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bootId)) return false;
  if (bootId !== owner.bootId) return true;
  try {
    const stat = readFileSync(`/proc/${owner.pid}/stat`, 'utf8');
    const end = stat.lastIndexOf(')');
    if (end < 0) return false;
    const fields = stat.slice(end + 2).trim().split(/\s+/);
    const startTimeTicks = fields[19];
    if (!startTimeTicks || !/^\d+$/.test(startTimeTicks)) return false;
    return startTimeTicks !== owner.startTimeTicks;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
  }
}


function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
