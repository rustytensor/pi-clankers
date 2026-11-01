import { isKeyRelease, isKeyRepeat, matchesKey, parseKey, type KeyId } from '@earendil-works/pi-tui';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { installManagementShortcutCatalogGuard, type ManagementCatalogEntry, type ManagementCatalogGuardOptions, type ManagementCatalogDecision } from '../internal-patch.js';
import { normalizeManagementShortcut, type PreferenceSaveResult, type UiPreferencesStore } from './preferences.js';

const namedKeys = new Set(['escape', 'esc', 'tab', 'enter', 'return', 'space', 'backspace', 'delete', 'insert', 'home', 'end', 'pageup', 'pagedown', 'up', 'down', 'left', 'right', 'clear', ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`)]);
function otherKey(value: string): string {
  let rest = value.trim().toLowerCase();
  const modifiers = new Set<string>();
  while (/^(ctrl|alt|shift|super)\+/.test(rest)) {
    const end = rest.indexOf('+');
    const modifier = rest.slice(0, end);
    if (modifiers.has(modifier)) throw new Error('Duplicate modifier in observed binding.');
    modifiers.add(modifier); rest = rest.slice(end + 1);
  }
  if (!(rest.length === 1 && /^[ -~]$/.test(rest)) && !namedKeys.has(rest)) throw new Error('Unsupported observed key syntax; catalog safety unavailable.');
  const key = rest === 'esc' ? 'escape' : rest === 'return' ? 'enter' : rest;
  // Other actions with collapsed Shift/Super can occupy the same terminal packet.
  return [...(modifiers.has('ctrl') ? ['ctrl'] : []), ...(modifiers.has('alt') ? ['alt'] : []), key].join('+');
}
function packets(key: string): string[] {
  const ctrl = key.startsWith('ctrl+');
  const alt = key.startsWith('alt+') || key.startsWith('ctrl+alt+');
  const base = key.replace(/^(ctrl\+)?(alt\+)?/, '');
  const modifier = 1 + (ctrl ? 4 : 0) + (alt ? 2 : 0);
  const output: string[] = [];
  const codepoint = base.length === 1 ? base.charCodeAt(0) : ({ escape: 27, tab: 9, enter: 13, space: 32, backspace: 127 } as Record<string, number>)[base];
  if (codepoint !== undefined) output.push(`\x1b[${codepoint};${modifier}u`, `\x1b[27;${modifier};${codepoint}~`);
  let legacy: string | undefined;
  if (ctrl) {
    if (/^[a-z]$/.test(base)) legacy = String.fromCharCode(base.charCodeAt(0) - 96);
    else legacy = ({ '2': '\x00', '@': '\x00', space: '\x00', '3': '\x1b', '[': '\x1b', '4': '\x1c', '\\': '\x1c', '5': '\x1d', ']': '\x1d', '6': '\x1e', '^': '\x1e', '7': '\x1f', '-': '\x1f', '_': '\x1f', '8': '\x7f', '?': '\x7f' } as Record<string, string>)[base];
  } else {
    if (base.length === 1) legacy = base;
    else legacy = ({ escape: '\x1b', tab: '\t', enter: '\r', backspace: '\x7f', space: ' ', left: '\x1b[D', right: '\x1b[C', up: '\x1b[A', down: '\x1b[B' } as Record<string, string>)[base];
  }
  if (legacy !== undefined) output.push(`${alt ? '\x1b' : ''}${legacy}`);
  if (!ctrl && !alt && base === 'enter') output.push('\n');
  if (!ctrl && base === 'backspace') output.push(`${alt ? '\x1b' : ''}\x08`);
  if (!ctrl && alt && base === 'left') output.push('\x1bb', '\x1bB');
  if (!ctrl && alt && base === 'right') output.push('\x1bf', '\x1bF');
  return output;
}
function equivalents(candidate: string, observed: string): boolean {
  if (candidate === observed) return true;
  const a = packets(candidate);
  const b = packets(observed);
  return a.some((packet) => b.includes(packet) || matchesKey(packet, observed as KeyId)) || b.some((packet) => matchesKey(packet, candidate as KeyId));
}
function bindingEntries(bindings: unknown, snapshot?: Record<string, string | readonly string[]>): Array<{ key: string; action: string }> {
  if (!bindings || typeof bindings !== 'object' || Array.isArray(bindings)) throw new Error('Effective keybindings unavailable.');
  const descriptors = Object.getOwnPropertyDescriptors(bindings);
  const ids = Object.keys(descriptors);
  if (ids.length > 4096) throw new Error('Effective keybinding catalog overflow.');
  const output: Array<{ key: string; action: string }> = [];
  for (const id of ids) {
    const descriptor = descriptors[id]!;
    if (!Object.hasOwn(descriptor, 'value')) throw new Error('Unknown effective keybinding value.');
    const values = typeof descriptor.value === 'string' ? [descriptor.value] : descriptor.value;
    if (!Array.isArray(values) || values.length + output.length > 4096) throw new Error('Unknown/overflow effective keybinding entries.');
    const copied: string[] = [];
    for (const key of values) {
      if (typeof key !== 'string' || key.length < 1 || key.length > 128) throw new Error('Unknown effective keybinding entry.');
      if (output.length >= 4096) throw new Error('Effective keybinding catalog overflow.');
      output.push({ key, action: id.slice(0, 80) });
      if (snapshot) copied.push(key);
    }
    if (snapshot) Object.defineProperty(snapshot, id, { value: typeof descriptor.value === 'string' ? descriptor.value : Object.freeze(copied), enumerable: true });
  }
  return output;
}
/** Pure conflict validation; actual host catalog argument is definitive at construction. */
export function validateManagementShortcut(candidate: unknown, bindings: unknown, entries: readonly ManagementCatalogEntry[], ownHandler?: Function): ManagementCatalogDecision {
  try {
    const normalized = normalizeManagementShortcut(candidate);
    if (!normalized) return { ok: true };
    if (entries.length > 4096) throw new Error('Extension shortcut catalog overflow.');
    const known = bindingEntries(bindings);
    for (const entry of entries) {
      if (typeof entry.key !== 'string' || entry.key.length < 1 || entry.key.length > 128 || typeof entry.handler !== 'function') throw new Error('Unknown extension shortcut entry.');
      if (entry.handler !== ownHandler) known.push({ key: entry.key, action: 'extension shortcut' });
    }
    for (const entry of known) {
      if (equivalents(normalized, otherKey(entry.key))) return { ok: false, reason: `${normalized} conflicts/aliases with ${entry.action} (${entry.key.slice(0, 128)}).` };
    }
    return { ok: true };
  } catch (error) { return { ok: false, reason: error instanceof Error ? error.message.slice(0, 240) : 'Shortcut validation unavailable.' }; }
}
export interface ManagementShortcutStatus {
  active: string | null;
  desired: string | null;
  pending: boolean;
  reason?: string;
  fallback: '/clankers config';
  alternative?: string;
}
export interface ManagementUiPreferencesFacade {
  snapshot(): ManagementShortcutStatus & { activityStrip: boolean };
  saveHuman(update: { activityStrip?: boolean; managementShortcut?: string | null }): PreferenceSaveResult;
  subscribe(listener: () => void): () => void;
}
export interface ManagementShortcutTui {
  hasOverlay(): boolean;
  getFocusedComponent(): unknown;
}
export interface ManagementShortcutContext {
  mode?: string;
  hasUI?: boolean;
  ui?: { onTerminalInput?(listener: (data: string) => undefined): () => void };
}
export interface ManagementShortcutControllerOptions {
  pi: Pick<ExtensionAPI, 'registerShortcut'>;
  preferences: UiPreferencesStore;
  ownerCommandHandler: Function;
  openManagement(context: ExtensionContext): void | Promise<void>;
  /** Parent shared synchronous command+shortcut latch. */
  isOpening(): boolean;
  onChange?(): void;
  warn?(reason: string): void;
  /** Offline tests only. */
  runnerClass?: ManagementCatalogGuardOptions['runnerClass'];
}
/** Recognizes an entire packet; passive observation never consumes or rewrites input. */
export function isManagementShortcutPacket(data: string, candidate: string): boolean {
  if (typeof data !== 'string' || data.length > 64 || isKeyRepeat(data) || isKeyRelease(data)) return false;
  const exactShape = /^[\x00-\x1f\x7f]$/.test(data) || /^\x1b[a-z0-9\x00-\x1f\x7f]$/.test(data) || /^\x1b\[\d{1,6};[1-9]\d?(?::1)?u$/.test(data) || /^\x1b\[27;[1-9]\d?;\d{1,6}~$/.test(data);
  return exactShape && parseKey(data) !== undefined && matchesKey(data, candidate as KeyId);
}
export function createManagementShortcutController(options: ManagementShortcutControllerOptions) {
  const initialPreferences = options.preferences.snapshot();
  const candidate = initialPreferences.desired.managementShortcut; // immutable extension generation binding
  const loadError = initialPreferences.loadError;
  let active: string | null = null;
  let reason: string | undefined = loadError ?? (candidate ? 'Awaiting validated interactive shortcut catalog.' : 'Management shortcut disabled.');
  let disposed = false;
  let attached = false;
  let generation = 0;
  let promptDepth = 0;
  let paste = false;
  let tui: ManagementShortcutTui | undefined;
  let token: { generation: number } | undefined;
  let catalog: { generation: number; bindings: unknown; entries: readonly ManagementCatalogEntry[] } | undefined;
  let alternative: string | undefined;
  let guard: { installed: boolean; dispose(): void } | undefined;
  let removeInput: (() => void) | undefined;
  let warned = false;
  const listeners = new Set<() => void>();
  const warnOnce = (message: string | undefined) => {
    if ((!candidate && !loadError) || warned) return;
    warned = true;
    try { options.warn?.(`${message ?? 'Management shortcut unavailable.'} Use /clankers config.`); } catch { /* Bounded warning only. */ }
  };
  const changed = () => {
    try { options.onChange?.(); } catch { /* Display only. */ }
    for (const listener of listeners) { try { listener(); } catch { /* Display only. */ } }
  };
  const available = () => {
    try { return !disposed && attached && !!tui && typeof tui.hasOverlay === 'function' && typeof tui.getFocusedComponent === 'function' && !tui.hasOverlay() && !!tui.getFocusedComponent() && promptDepth === 0 && !options.isOpening(); }
    catch { return false; }
  };
  const handler = (context: ExtensionContext): void => {
    const authorization = token; token = undefined;
    if (!authorization || authorization.generation !== generation || !active || !available() || context.mode !== 'tui' || !context.hasUI) return;
    // Take authorization and invoke shared opener synchronously before any await.
    try { void Promise.resolve(options.openManagement(context)).catch(() => { /* Parent owns UI failure reporting. */ }); }
    catch { /* A failed opener must not escape terminal dispatch. */ }
  };
  const status = (): ManagementShortcutStatus => {
    const desired = options.preferences.snapshot().desired.managementShortcut;
    return { active, desired, pending: desired !== candidate, reason, fallback: '/clankers config', ...(alternative ? { alternative } : {}) };
  };
  const settings: ManagementUiPreferencesFacade = {
    snapshot: () => ({ ...status(), activityStrip: options.preferences.snapshot().desired.activityStrip }),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    saveHuman(update) {
      if (!update || typeof update !== 'object' || Array.isArray(update)) return { ok: false, reason: 'Invalid UI preference update.' };
      if (Object.hasOwn(update, 'managementShortcut')) {
        let next: string | null;
        try { next = normalizeManagementShortcut(update.managementShortcut); } catch (error) { return { ok: false, reason: error instanceof Error ? error.message : 'Invalid shortcut.' }; }
        if (next) {
          if (disposed || !attached || !catalog || catalog.generation !== generation) return { ok: false, reason: 'Shortcut catalog unavailable/stale; use disable or /reload in interactive Pi.' };
          let result: ManagementCatalogDecision;
          try { result = validateManagementShortcut(next, catalog.bindings, catalog.entries, handler); }
          catch { result = { ok: false, reason: 'Effective keybindings unavailable.' }; }
          if (!result.ok) return result;
        }
      }
      return options.preferences.saveHuman(update);
    },
  };
  const removePreferences = options.preferences.subscribe(changed);
  const detach = () => {
    attached = false; generation += 1; token = undefined; catalog = undefined; tui = undefined; promptDepth = 0; paste = false; active = null;
    reason = 'Management shortcut detached; use /clankers config until interactive reattachment.';
    try { removeInput?.(); } catch { /* Cleanup only. */ }
    removeInput = undefined;
    if (!disposed) changed();
  };
  return {
    settings, status, detach,
    attach(context: ManagementShortcutContext) {
      if (disposed || attached) return;
      if (context.mode !== 'tui' || context.hasUI !== true || typeof context.ui?.onTerminalInput !== 'function') { reason = 'Management shortcut unavailable outside interactive Pi.'; changed(); return; }
      attached = true; generation += 1;
      try {
        removeInput = context.ui.onTerminalInput((data) => {
          token = undefined;
          const startsPaste = data.includes('\x1b[200~');
          const endsPaste = data.includes('\x1b[201~');
          if (startsPaste || endsPaste) { paste = startsPaste && !endsPaste; return undefined; }
          if (paste) return undefined;
          if (active && available() && isManagementShortcutPacket(data, active)) {
            const authorization = { generation }; token = authorization;
            queueMicrotask(() => { if (token === authorization) token = undefined; });
          }
          return undefined;
        });
        if (!guard) guard = installManagementShortcutCatalogGuard({
          handler, ownerCommandHandler: options.ownerCommandHandler, candidate,
          enabled: () => !disposed && attached && !!tui && typeof tui.hasOverlay === 'function' && typeof tui.getFocusedComponent === 'function',
          register: () => options.pi.registerShortcut(candidate as KeyId, { description: 'Open Clankers management (/clankers config)', handler }),
          validate: (bindings, entries) => validateManagementShortcut(candidate, bindings, entries, handler),
          onCatalog(observation) {
            catalog = undefined;
            try {
              if (!disposed && attached && observation.entries && observation.entries.length <= 4096) {
                // Retain the actual host argument, not an independently loaded TUI singleton.
                const bindings: Record<string, string | readonly string[]> = Object.create(null);
                bindingEntries(observation.bindings, bindings);
                const entries = Object.freeze(observation.entries.map((entry) => Object.freeze({ key: entry.key, handler: entry.handler })));
                catalog = { generation, bindings: Object.freeze(bindings), entries };
              }
            } catch { /* Missing/malformed authority must not retain the previous observation. */ }
            alternative = catalog && validateManagementShortcut('alt+j', catalog.bindings, catalog.entries, handler).ok ? 'alt+j' : undefined;
            active = observation.ok ? candidate : null;
            reason = observation.ok ? undefined : loadError ?? observation.reason;
            token = undefined;
            if (!observation.ok) warnOnce(reason);
            changed();
          },
          runnerClass: options.runnerClass,
        });
        if (!guard.installed) { reason = loadError ?? 'Unsupported/occupied Pi shortcut catalog guard; use /clankers config.'; warnOnce(reason); removeInput(); removeInput = undefined; attached = false; changed(); }
      } catch { attached = false; reason = loadError ?? 'Management shortcut integration unavailable; use /clankers config.'; warnOnce(reason); try { removeInput?.(); } catch { /* Cleanup only. */ } removeInput = undefined; guard?.dispose(); changed(); }
    },
    setTui(value: ManagementShortcutTui | undefined) { token = undefined; generation += 1; tui = disposed ? undefined : value; },
    promptStart() { token = undefined; promptDepth = Math.min(256, promptDepth + 1); },
    promptEnd() { token = undefined; promptDepth = Math.max(0, promptDepth - 1); },
    dispose() {
      if (disposed) return;
      disposed = true; detach(); active = null;
      guard?.dispose(); removePreferences(); listeners.clear();
    },
  };
}
