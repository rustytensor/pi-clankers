import { constants, closeSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { LEGACY_AGENT_STATE_DIRECTORY, convertLegacyPreferencesFile } from './../legacy-names.js';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

export const DEFAULT_MANAGEMENT_SHORTCUT = 'alt+g';
export interface UiPreferences { version: 1; activityStrip: boolean; managementShortcut: string | null }
export interface PreferenceSaveResult { ok: boolean; reason?: string }
export interface UiPreferencesSnapshot { desired: Readonly<UiPreferences>; loadError?: string }
export interface UiPreferencesStore {
  snapshot(): UiPreferencesSnapshot;
  saveHuman(update: Partial<Omit<UiPreferences, 'version'>>): PreferenceSaveResult;
  subscribe(listener: () => void): () => void;
}
export function normalizeManagementShortcut(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 128) throw new Error('Use Ctrl/Alt modified letters or digits, or disable.');
  const parts = value.trim().toLowerCase().split('+');
  const key = parts.pop();
  if (parts.includes('shift') || parts.includes('super')) throw new Error('Shift/Super are not portable management modifiers; use Ctrl/Alt.');
  if (!key || !/^[a-z0-9]$/.test(key) || parts.length < 1 || parts.length > 2 || new Set(parts).size !== parts.length || parts.some((part) => part !== 'ctrl' && part !== 'alt')) {
    throw new Error('Use Ctrl/Alt modified letters or digits; bare typing keys and unsupported syntax are not allowed.');
  }
  return [...(parts.includes('ctrl') ? ['ctrl'] : []), ...(parts.includes('alt') ? ['alt'] : []), key].join('+');
}
const defaults = (): UiPreferences => ({ version: 1, activityStrip: true, managementShortcut: DEFAULT_MANAGEMENT_SHORTCUT });
const MAX_BYTES = 4096;
function readBounded(path: string): string | undefined {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('UI preferences must be a regular file of at most 4096 bytes.');
    // One bounded read, including one extra byte to reject growth after stat.
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    if (size > MAX_BYTES) throw new Error('UI preferences exceed 4096 bytes.');
    return buffer.subarray(0, size).toString('utf8');
  } finally { closeSync(fd); }
}
function decode(text: string): UiPreferences {
  const value = JSON.parse(text) as UiPreferences;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'activityStrip,managementShortcut,version' || value.version !== 1 || typeof value.activityStrip !== 'boolean') {
    throw new Error('Invalid version 1 Clankers UI preferences.');
  }
  return { version: 1, activityStrip: value.activityStrip, managementShortcut: normalizeManagementShortcut(value.managementShortcut) };
}
function reason(error: unknown): string { return error instanceof Error ? error.message.slice(0, 240) : 'UI preferences unavailable.'; }
/** Only the human management settings view calls saveHuman; no load migration/autowrite. */
export function createUiPreferences(options: { agentDir?: string } = {}): UiPreferencesStore {
  const agentDir = options.agentDir ?? getAgentDir();
  const directory = join(agentDir, 'clankers');
  const path = join(directory, 'ui.json');
  let desired = defaults();
  let original: string | undefined;
  let loadError: string | undefined;
  try {
    // One-time conversion of the old preferences file; the old file is left as it was.
    convertLegacyPreferencesFile(join(agentDir, LEGACY_AGENT_STATE_DIRECTORY, 'ui.json'), path);
    original = readBounded(path); if (original !== undefined) desired = decode(original); }
  catch (error) { loadError = reason(error); desired.managementShortcut = null; }
  const listeners = new Set<() => void>();
  return {
    snapshot: () => ({ desired: Object.freeze({ ...desired }), ...(loadError ? { loadError } : {}) }),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    saveHuman(update) {
      if (loadError) return { ok: false, reason: `Existing preferences are invalid/unreadable; repair ui.json first: ${loadError}` };
      let temporary: string | undefined;
      try {
        if (!update || typeof update !== 'object' || Array.isArray(update) || Object.keys(update).some((key) => key !== 'activityStrip' && key !== 'managementShortcut')) throw new Error('Unsupported UI preference update.');
        const next = { ...desired };
        if (Object.hasOwn(update, 'activityStrip')) {
          if (typeof update.activityStrip !== 'boolean') throw new Error('Activity strip visibility must be boolean.');
          next.activityStrip = update.activityStrip;
        }
        if (Object.hasOwn(update, 'managementShortcut')) next.managementShortcut = normalizeManagementShortcut(update.managementShortcut);
        if (readBounded(path) !== original) throw new Error('UI preferences changed outside this view; reload before saving.');
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        temporary = join(directory, `.ui-${randomUUID()}.tmp`);
        const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        const content = `${JSON.stringify(next, null, 2)}\n`;
        try { writeFileSync(fd, content, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
        // Repeat the bounded compare before the atomic replacement. Not a cross-process lock.
        if (readBounded(path) !== original) throw new Error('UI preferences changed while saving; reload before saving.');
        renameSync(temporary, path); temporary = undefined;
        desired = next; original = content;
      } catch (error) {
        if (temporary) { try { unlinkSync(temporary); } catch { /* Best effort owned temporary cleanup. */ } }
        return { ok: false, reason: reason(error) };
      }
      for (const listener of listeners) { try { listener(); } catch { /* Observers have no settings authority. */ } }
      return { ok: true };
    },
  };
}
