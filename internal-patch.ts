import { createHash } from 'node:crypto';
import { ExtensionRunner } from '@earendil-works/pi-coding-agent';
import { appendHookEvent } from './state.js';
import type { HookLifecycleEvent, StructuralPiExtensionContext, ZergInternalPatchController, ZergState, ZergStateContainer } from './types.js';

export type PiPackageMetadataEntry = { pkg: string | { source: string; autoload?: boolean }; scope: 'user' | 'project' };

/** Guarded metadata-only Pi internals for continuation review. Never exposes
 * getInstalledPath/resolve: npm legacy lookup can execute commands. */
export function guardedPiPackageMetadata(manager: object) {
  const metadata = manager as {
    dedupePackages(entries: PiPackageMetadataEntry[]): PiPackageMetadataEntry[];
    parseSource(source: string): { type: string; name: string; path: string };
    getManagedNpmInstallPath(source: unknown, scope: string): string;
    installedNpmMatchesConfiguredVersion(source: unknown, path: string): Promise<boolean>;
    resolvePathFromBase(path: string, base: string): string;
  };
  for (const name of ['dedupePackages', 'parseSource', 'getManagedNpmInstallPath', 'installedNpmMatchesConfiguredVersion', 'resolvePathFromBase'] as const) {
    if (typeof metadata[name] !== 'function') throw new Error('Unsupported Pi metadata resolver');
  }
  return Object.freeze({
    dedupePackages: metadata.dedupePackages.bind(manager),
    parseSource: metadata.parseSource.bind(manager),
    getManagedNpmInstallPath: metadata.getManagedNpmInstallPath.bind(manager),
    installedNpmMatchesConfiguredVersion: metadata.installedNpmMatchesConfiguredVersion.bind(manager),
    resolvePathFromBase: metadata.resolvePathFromBase.bind(manager),
  });
}

export interface InternalPatchOptions {
  maxEvents?: number;
  now?: () => Date;
}

type InternalPatchStateTarget = ZergState | ZergStateContainer;

interface PatchRecord {
  disposed: boolean;
  restore(): void;
}

type EventBusMethodName = 'emit' | 'on';
type EventBusMethod = (this: unknown, ...args: unknown[]) => unknown;
type EventBusPatchTarget = Record<EventBusMethodName, EventBusMethod>;

const activePatchesByContext = new WeakMap<object, PatchRecord>();
const activePatchesByEventBus = new WeakMap<EventBusPatchTarget, PatchRecord>();

export function installInternalPatch(
  context: StructuralPiExtensionContext | undefined,
  state: InternalPatchStateTarget,
  options: InternalPatchOptions = {},
): ZergInternalPatchController {
  const target = typeof context === 'object' && context !== null ? context : undefined;
  const alreadyInstalled = target ? activePatchesByContext.has(target) : false;

  let disposed = false;
  let generatedEventSequence = 0;
  const maxEvents = options.maxEvents ?? 100;
  const now = options.now ?? (() => new Date());

  const getHighestGeneratedEventSequence = (events: readonly HookLifecycleEvent[]): number => {
    return events.reduce((highest, event) => {
      const match = /^event-(\d+)$/.exec(event.id);
      if (!match) {
        return highest;
      }

      const sequence = Number.parseInt(match[1]!, 10);
      return Number.isSafeInteger(sequence) ? Math.max(highest, sequence) : highest;
    }, 0);
  };

  const nextGeneratedEventId = (current: ZergState): string => {
    generatedEventSequence = Math.max(
      generatedEventSequence,
      current.revision,
      current.events.length,
      getHighestGeneratedEventSequence(current.events),
    ) + 1;
    return `event-${generatedEventSequence}`;
  };

  const emitLifecycleEvent: ZergInternalPatchController['emit'] = (event) => {
    if (disposed) {
      throw new Error('Cannot emit zerg internal patch events after dispose().');
    }

    const current = readPatchState(state);
    const next: HookLifecycleEvent = {
      id: event.id ?? nextGeneratedEventId(current),
      createdAt: event.createdAt ?? now().toISOString(),
      type: event.type,
      message: event.message,
      status: event.status,
      agentId: event.agentId,
      taskId: event.taskId,
      teamId: event.teamId,
      treeNodeId: event.treeNodeId,
      revision: event.revision,
    };

    writePatchState(state, appendHookEvent(current, next, maxEvents));
    return next;
  };

  if (!target || alreadyInstalled) {
    return {
      installed: false,
      emit: emitLifecycleEvent,
      dispose() {
        disposed = true;
      },
    };
  }

  const eventBus = findEventBusPatchTarget(target);

  if (!eventBus || activePatchesByEventBus.has(eventBus)) {
    return {
      installed: false,
      emit: emitLifecycleEvent,
      dispose() {
        disposed = true;
      },
    };
  }

  const restoreStack: Array<() => void> = [];
  const record: PatchRecord = {
    disposed: false,
    restore() {
      for (const restore of [...restoreStack].reverse()) {
        restore();
      }
    },
  };

  try {
    restoreStack.push(replaceEventBusMethod(eventBus, 'emit', (original) => function zergPatchedPiEventEmit(this: unknown, ...args: unknown[]): unknown {
      const result = original.apply(this, args);

      safelyEmitPatchObservation(record, emitLifecycleEvent, `pi-zerg-swarm observed Pi event bus emit: ${formatObservedPiEventName(args[0])}`);
      return result;
    }));

    restoreStack.push(replaceEventBusMethod(eventBus, 'on', (original) => function zergPatchedPiEventOn(this: unknown, ...args: unknown[]): unknown {
      const result = original.apply(this, args);

      safelyEmitPatchObservation(record, emitLifecycleEvent, `pi-zerg-swarm observed Pi event bus subscription: ${formatObservedPiEventName(args[0])}`);
      return result;
    }));
  } catch (error) {
    for (const restore of [...restoreStack].reverse()) {
      restore();
    }
    throw error;
  }
  activePatchesByEventBus.set(eventBus, record);

  activePatchesByContext.set(target, record);

  return {
    installed: true,
    emit: emitLifecycleEvent,
    dispose() {
      if (disposed) {
        return;
      }

      disposed = true;
      activePatchesByEventBus.delete(eventBus);
      record.disposed = true;
      activePatchesByContext.delete(target);
      record.restore();
    },
  };
}

function findEventBusPatchTarget(target: object): EventBusPatchTarget | undefined {
  const events = (target as { events?: unknown }).events;

  if (isEventBusPatchTarget(events)) {
    return events;
  }

  return undefined;
}

function isEventBusPatchTarget(value: unknown): value is EventBusPatchTarget {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const candidate = value as { emit?: unknown; on?: unknown };
  return typeof candidate.emit === 'function' && typeof candidate.on === 'function';
}

function replaceEventBusMethod(
  target: EventBusPatchTarget,
  methodName: EventBusMethodName,
  createReplacement: (original: EventBusMethod) => EventBusMethod,
): () => void {
  const original = target[methodName];
  const replacement = createReplacement(original);

  target[methodName] = replacement;

  if (target[methodName] !== replacement) {
    throw new Error(`Unable to replace Pi event bus ${methodName} hook.`);
  }

  return () => {
    if (target[methodName] === replacement) {
      target[methodName] = original;
    }
  };
}

function safelyEmitPatchObservation(
  record: PatchRecord,
  emit: ZergInternalPatchController['emit'],
  message: string,
): void {
  if (record.disposed) {
    return;
  }

  try {
    emit({ type: 'hook', message, status: 'done' });
  } catch {
    // Pi runtime hooks must preserve original event-bus behavior even if zerg telemetry fails.
  }
}

function formatObservedPiEventName(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : '<unknown>';
}

function readPatchState(state: InternalPatchStateTarget): ZergState {
  return isZergStateContainer(state) ? state.snapshot() : state;
}

function writePatchState(target: InternalPatchStateTarget, nextState: ZergState): void {
  if (isZergStateContainer(target)) {
    target.replace(nextState);
    return;
  }

  Object.assign(target, nextState);
}

function isZergStateContainer(value: InternalPatchStateTarget): value is ZergStateContainer {
  return typeof (value as ZergStateContainer).snapshot === 'function'
    && typeof (value as ZergStateContainer).replace === 'function';
}

// Necessary compatibility bridge only. The existing event-bus patch above is unchanged.
export interface ManagementCatalogEntry { key: string; handler: Function }
export interface ManagementCatalogDecision { ok: boolean; reason?: string }
export interface ManagementCatalogObservation extends ManagementCatalogDecision {
  entries?: readonly ManagementCatalogEntry[];
  bindings?: unknown;
}
export interface ManagementCatalogGuardOptions {
  handler: Function;
  ownerCommandHandler: Function;
  candidate: string | null;
  enabled(): boolean;
  register(): void;
  validate(bindings: unknown, entries: readonly ManagementCatalogEntry[]): ManagementCatalogDecision;
  onCatalog(observation: ManagementCatalogObservation): void;
  /** Offline tests pass a private class; production MUST use the public root host alias. */
  runnerClass?: { prototype: object };
}
const managementCatalogPatches = new WeakMap<object, object>();
const knownCatalogResolvers = new Set([
  'd9d78489cfef4f6aab01d18fecf82e1d32ebb4b089b8878e5f04aef73e9d1c91',
  '9fc1ea488493e382f885ad636e94615e6c366382ca0d62e8d9f6a65c6ae20f05',
]);
/** No registration until the actual owner catalog is known; never a second registry. */
export function installManagementShortcutCatalogGuard(options: ManagementCatalogGuardOptions): { installed: boolean; dispose(): void } {
  const prototype = (options.runnerClass ?? ExtensionRunner).prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'getShortcuts');
  const original = descriptor?.value;
  const unsupported = () => ({ installed: false, dispose() {} });
  if (typeof original !== 'function' || !descriptor?.writable || !descriptor.configurable || managementCatalogPatches.has(prototype)) return unsupported();
  const fingerprint = createHash('sha256').update(Function.prototype.toString.call(original).replace(/\s+/g, '')).digest('hex');
  if (!knownCatalogResolvers.has(fingerprint)) return unsupported();
  let disposed = false;
  let resolving = false;
  let registered = false;
  let rejected = false;
  let rejection = 'Management shortcut unavailable.';
  let owner: object | undefined;
  const retained: Array<WeakRef<Map<string, { handler?: unknown }>>> = [];
  const notify = (observation: ManagementCatalogObservation) => { try { options.onCatalog(observation); } catch { /* Observer only. */ } };
  const withdraw = () => {
    for (const ref of retained) {
      const map = ref.deref();
      if (map) for (const [key, shortcut] of map) if (shortcut?.handler === options.handler) map.delete(key);
    }
  };
  const reject = (message: string) => { rejected = true; rejection = message; withdraw(); };
  // Lazy filtering preserves every other object/Map/order and original diagnostics/writes/errors.
  // Forwarding views have empty targets: returning a filtered property from a
  // Proxy targeting the actual record/runner violates native invariants when
  // shortcuts/extensions is non-configurable and non-writable (e.g. frozen).
  // The fingerprinted resolver only reads these properties and writes runner
  // diagnostics; all other reads/writes still use the original receiver.
  function filteredReceiver(receiver: object, extensions: unknown): object {
    // Even an unsupported iterable registry must not let our previously registered
    // handler win a new table; forward malformed values so the original still throws.
    const filtered = {
      *[Symbol.iterator]() {
        for (const extension of extensions as Iterable<unknown>) {
          if (!extension || typeof extension !== 'object') { yield extension; continue; }
          yield new Proxy(Object.create(null), { get(_target, key) {
            if (key !== 'shortcuts') return Reflect.get(extension, key, extension);
            const shortcuts = Reflect.get(extension, key, extension);
            return { *[Symbol.iterator]() {
              for (const pair of shortcuts) {
                if (Array.isArray(pair) && pair[1]?.handler === options.handler) continue;
                yield pair;
              }
            } };
          } });
        }
      },
    };
    return new Proxy(Object.create(null), {
      get(_target, key) { return key === 'extensions' ? filtered : Reflect.get(receiver, key, receiver); },
      set(_target, key, value) { return Reflect.set(receiver, key, value, receiver); },
    });
  }
  function replacement(this: Record<string, unknown>, ...args: unknown[]): unknown {
    if (disposed) return original.apply(this, args);
    const extensions = this?.extensions;
    if (resolving) {
      reject('Reentrant catalog construction; reload required.');
      return original.apply(filteredReceiver(this, extensions), args);
    }
    resolving = true;
    let belongs = owner === this;
    let entries: ManagementCatalogEntry[] = [];
    let bindings: unknown = args[0];
    let allow = false;
    try {
      try {
        if (!prototype.isPrototypeOf(this) || !Array.isArray(extensions) || Object.getPrototypeOf(extensions) !== Array.prototype || Object.hasOwn(extensions, Symbol.iterator) || extensions.length > 256) throw new Error('Unknown/overflow extension catalog.');
        let anchors = 0;
        let anchoredExtension: unknown;
        let ownEntries = 0;
        for (const extension of extensions) {
          if (!extension || typeof extension !== 'object') throw new Error('Unknown extension registry shape.');
          for (const field of ['commands', 'shortcuts']) {
            const fieldDescriptor = Object.getOwnPropertyDescriptor(extension, field);
            const map = fieldDescriptor?.value;
            if (!fieldDescriptor || !Object.hasOwn(fieldDescriptor, 'value') || !(map instanceof Map) || Object.getPrototypeOf(map) !== Map.prototype || Object.hasOwn(map, Symbol.iterator) || Object.hasOwn(map, 'get') || Object.hasOwn(map, 'size')) throw new Error('Unknown extension registry Map shape.');
          }
          if (extension.commands.size > 4096) throw new Error('Command catalog overflow.');
          // Canonical command anchors one extension; aliases may share the same handler.
          if (extension.commands.get('zerg')?.handler === options.ownerCommandHandler) { anchors += 1; anchoredExtension = extension; belongs = true; }
          if (extension.shortcuts.size + entries.length > 4096) throw new Error('Shortcut catalog overflow.');
          for (const [key, shortcut] of extension.shortcuts) {
            if (entries.length >= 4096) throw new Error('Shortcut catalog overflow.');
            if (typeof key !== 'string' || key.length < 1 || key.length > 128 || !shortcut || typeof shortcut.handler !== 'function') throw new Error('Unknown shortcut entry.');
            entries.push({ key, handler: shortcut.handler });
            if (shortcut.handler === options.handler) ownEntries += 1;
          }
        }
        if (belongs) {
          if (anchors !== 1 || (owner && owner !== this)) throw new Error('Ambiguous management catalog ownership.');
          owner = this;
          if (this.mode !== 'tui' || typeof this.hasUI !== 'function' || !this.hasUI() || !options.enabled()) throw new Error('Management shortcut needs the interactive TUI.');
          const ownerShortcuts = (anchoredExtension as { shortcuts: Map<string, { handler?: unknown }> }).shortcuts;
          if ((!registered && ownEntries !== 0) || (registered && (ownEntries !== 1 || ownerShortcuts.get(options.candidate ?? '')?.handler !== options.handler)) || entries.some((entry) => entry.handler === options.handler && entry.key !== options.candidate)) throw new Error('Ambiguous management shortcut ownership/registry drift.');
          for (let index = retained.length - 1; index >= 0; index -= 1) if (!retained[index]!.deref()) retained.splice(index, 1);
          if (retained.length >= 128) throw new Error('Retained shortcut catalog limit reached; reload required.');
          if (rejected) throw new Error(rejection);
          if (!options.candidate) throw new Error('Management shortcut disabled (desired changes require reload).');
          const decision = options.validate(bindings, entries);
          if (!decision.ok) throw new Error(decision.reason ?? 'Management shortcut conflicts with another binding.');
          if (rejected) throw new Error(rejection);
          if (!registered) {
            if (entries.length >= 4096) throw new Error('Shortcut catalog capacity reached.');
            options.register();
            registered = true;
            const shortcuts = (anchoredExtension as { shortcuts: Map<string, { handler?: unknown }> }).shortcuts;
            if (shortcuts.get(options.candidate)?.handler !== options.handler) throw new Error('Public registrar did not register in the owner catalog.');
          }
          allow = !rejected;
        }
      } catch (error) {
        if (belongs) reject(error instanceof Error ? error.message.slice(0, 240).replace(/[\x00-\x1f\x7f]/g, ' ') : 'Catalog validation unavailable.');
        else if (!owner) notify({ ok: false, reason: 'Unknown/unavailable owner catalog; management shortcut not registered.' });
      }
      let result: unknown;
      try { result = original.apply(allow || !belongs ? this : filteredReceiver(this, extensions), args); }
      catch (error) { if (belongs) { reject('Host catalog failed; reload required.'); notify({ ok: false, reason: rejection }); } throw error; }
      if (belongs) {
        if (!(result instanceof Map)) { reject('Unknown host catalog result; reload required.'); }
        else {
          if (rejected) for (const [key, shortcut] of result) if (shortcut?.handler === options.handler) result.delete(key);
          if (allow && ![...result.values()].some((shortcut) => shortcut?.handler === options.handler)) reject('Host did not activate management shortcut; reload required.');
          if (retained.length < 128) retained.push(new WeakRef(result));
        }
        notify({ ok: allow && !rejected, reason: rejected ? rejection : undefined, entries, bindings });
      }
      return result;
    } finally { resolving = false; }
  }
  Object.defineProperty(prototype, 'getShortcuts', { ...descriptor, value: replacement });
  managementCatalogPatches.set(prototype, replacement);
  return {
    installed: true,
    dispose() {
      if (disposed) return;
      disposed = true; withdraw(); retained.length = 0;
      if (Object.getOwnPropertyDescriptor(prototype, 'getShortcuts')?.value === replacement) Object.defineProperty(prototype, 'getShortcuts', descriptor);
      if (managementCatalogPatches.get(prototype) === replacement) managementCatalogPatches.delete(prototype);
    },
  };
}
