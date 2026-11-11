/**
 * One-time conversion of data written under the pre-2.0.0 project names.
 *
 * This is the ONLY source module that may contain the old names. Every other
 * file uses the Clankers names. Nothing here deletes or rewrites old files: an
 * old snapshot or preferences file is read once and the converted copy is
 * written under the new path; the old file stays byte-for-byte as it was.
 */
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** Default snapshot path below a project root, before and after the rename. */
export const LEGACY_SNAPSHOT_RELATIVE_PATH = '.pi/zerg-swarm/v1/state.json';
export const CURRENT_SNAPSHOT_RELATIVE_PATH = '.pi/clankers/v1/state.json';
/** Directory below the Pi agent directory that held ui.json. */
export const LEGACY_AGENT_STATE_DIRECTORY = 'zerg-swarm';
/** Shared-state extension keys. */
export const LEGACY_EXTENSION_KEYS: Readonly<Record<string, string>> = Object.freeze({
  zergControl: 'clankersControl',
  zergPersistence: 'clankersPersistence',
  zergPermissions: 'clankersPermissions',
  zergLogs: 'clankersLogs',
  zergSessionMessages: 'clankersSessionMessages',
});
/** Controller / requester / resolver value that named this extension. */
export const LEGACY_ACTOR_VALUE = 'zerg';
export const CURRENT_ACTOR_VALUE = 'clankers';
/** Run identifiers written before the rename keep their prefix. */
export const LEGACY_RUN_ID_PREFIX = 'zerg-';
/** Pi session custom entry types. */
export const LEGACY_CUSTOM_TYPES: Readonly<Record<string, string>> = Object.freeze({
  'pi-zerg-swarm/native-session/v1': 'pi-clankers/native-session/v1',
  'pi-zerg-swarm/native-ancestor-session/v1': 'pi-clankers/native-ancestor-session/v1',
  'pi-zerg-swarm/native-continuation/v1': 'pi-clankers/native-continuation/v1',
  'pi-zerg-swarm/native-ancestor-continuation/v1': 'pi-clankers/native-ancestor-continuation/v1',
  'pi-zerg-swarm/operator/v1': 'pi-clankers/operator/v1',
  'pi-zerg-swarm/agent-result/v1': 'pi-clankers/agent-result/v1',
});
/** npm package name of the old distribution, still excluded from child sessions. */
export const LEGACY_PACKAGE_NAME = 'pi-zerg-swarm';
const MAX_LEGACY_BYTES = 64 * 1024 * 1024;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Current custom type for either an old or a current type string. */
export function normalizeCustomType<T>(value: T): T | string {
  return typeof value === 'string' && Object.hasOwn(LEGACY_CUSTOM_TYPES, value) ? LEGACY_CUSTOM_TYPES[value] : value;
}

/** True for a run id written under the current or the old prefix. */
export function hasRunIdPrefix(id: string, currentPrefix: string): boolean {
  return id.startsWith(currentPrefix) || id.startsWith(LEGACY_RUN_ID_PREFIX);
}

/**
 * Pure conversion of a saved state object. Returns the same object when nothing
 * is old; otherwise a shallow-copied state whose extension keys and actor values
 * use the current names. Run ids and every other value are kept as written.
 */
export function convertLegacyState<T extends Record<string, unknown>>(state: T): T {
  const extensions = (state as Record<string, unknown>).extensions;
  if (!isRecord(extensions) || !Object.keys(extensions).some(key => Object.hasOwn(LEGACY_EXTENSION_KEYS, key))) return state;
  const converted: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extensions)) {
    const target = Object.hasOwn(LEGACY_EXTENSION_KEYS, key) ? LEGACY_EXTENSION_KEYS[key] : key;
    if (target !== key && Object.hasOwn(extensions, target)) throw new Error(`Saved state holds both ${key} and ${target}; refusing ambiguous conversion.`);
    converted[target] = value;
  }
  const control = converted.clankersControl;
  if (isRecord(control) && control.controller === LEGACY_ACTOR_VALUE) converted.clankersControl = { ...control, controller: CURRENT_ACTOR_VALUE };
  const permissions = converted.clankersPermissions;
  if (isRecord(permissions) && Array.isArray(permissions.requests)) {
    converted.clankersPermissions = { ...permissions, requests: permissions.requests.map((request: unknown) => {
      if (!isRecord(request)) return request;
      const next: Record<string, unknown> = { ...request };
      if (next.requester === LEGACY_ACTOR_VALUE) next.requester = CURRENT_ACTOR_VALUE;
      if (next.resolvedBy === LEGACY_ACTOR_VALUE) next.resolvedBy = CURRENT_ACTOR_VALUE;
      return next;
    }) };
  }
  return { ...state, extensions: converted };
}

/** Converts the text of a saved snapshot envelope; unchanged text is returned as is. */
export function convertLegacySnapshotText(text: string): { text: string; converted: boolean } {
  const envelope = JSON.parse(text) as unknown;
  if (!isRecord(envelope) || !isRecord(envelope.state)) return { text, converted: false };
  const state = convertLegacyState(envelope.state);
  if (state === envelope.state) return { text, converted: false };
  return { text: JSON.stringify({ ...envelope, state }), converted: true };
}

function missing(path: string): boolean {
  try { lstatSync(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error; }
}

function writeNewFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.convert-${process.pid}`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (error) { closeSync(fd); try { unlinkSync(temporary); } catch { /* the original error is reported */ } throw error; }
  closeSync(fd);
  renameSync(temporary, path);
}

/**
 * Reads the old default snapshot once and writes the converted one under the new
 * path. Does nothing when the new file or link already exists or the old file is
 * missing. Returns true when a converted file was written.
 */
export function convertLegacySnapshotFile(legacyPath: string, currentPath: string): boolean {
  if (!missing(currentPath) || missing(legacyPath)) return false;
  const stat = lstatSync(legacyPath);
  if (!stat.isFile() || stat.size > MAX_LEGACY_BYTES) throw new Error('Legacy snapshot must be a regular file within the size limit.');
  const { text } = convertLegacySnapshotText(readFileSync(legacyPath, 'utf8'));
  writeNewFile(currentPath, text);
  return true;
}

/** One-time copy of the old ui.json. The content format did not change. */
export function convertLegacyPreferencesFile(legacyPath: string, currentPath: string): boolean {
  if (!missing(currentPath) || missing(legacyPath)) return false;
  const stat = lstatSync(legacyPath);
  if (!stat.isFile() || stat.size > 4096) throw new Error('Legacy UI preferences must be a small regular file.');
  writeNewFile(currentPath, readFileSync(legacyPath, 'utf8'));
  return true;
}
