import test from 'node:test';
import assert from 'node:assert/strict';
import { ExtensionRunner } from '@earendil-works/pi-coding-agent';
import { installManagementShortcutCatalogGuard, type ManagementCatalogObservation } from '../internal-patch.js';
import { validateManagementShortcut } from '../ui/management-shortcut.js';
const anchor = () => {};
const ours = () => {};
const other = () => {};
const last = () => {};
type Shortcut = { handler: Function; extensionPath: string };
type Extension = { path: string; shortcuts: Map<string, Shortcut>; commands: Map<string, { handler: Function }> };
function ext(entries: Array<[string, Function]>, own = false): Extension {
  return { path: own ? 'ours' : 'other', shortcuts: new Map(entries.map(([key, handler]) => [key, { handler, extensionPath: handler.name }])), commands: new Map(own ? [['clankers', { handler: anchor }]] : []) };
}
function fixture(extensions: Extension[], candidate = 'alt+g', BaseRunner = ExtensionRunner, validateOverride?: () => { ok: boolean; reason?: string }) {
  // Private class prototype only, copied public method. Never patches installed/live class.
  class PrivateRunner extends BaseRunner {}
  Object.defineProperty(PrivateRunner.prototype, 'getShortcuts', Object.getOwnPropertyDescriptor(BaseRunner.prototype, 'getShortcuts')!);
  const runner = new (PrivateRunner as unknown as new (...args: unknown[]) => { getShortcuts(bindings: unknown): Map<string, Shortcut>; setUIContext(...args: unknown[]): void; getShortcutDiagnostics(): unknown[]; extensions: Extension[] })(extensions, {}, '.', {}, {});
  runner.setUIContext({}, 'tui');
  const observations: ManagementCatalogObservation[] = [];
  let registrations = 0;
  const guard = installManagementShortcutCatalogGuard({
    handler: ours, ownerCommandHandler: anchor, candidate, enabled: () => true,
    register() { registrations++; const owner = extensions.find((e) => e.commands.get('clankers')?.handler === anchor)!; owner.shortcuts.set(candidate, { handler: ours, extensionPath: 'ours' }); },
    validate: (bindings, entries) => validateOverride ? validateOverride() : validateManagementShortcut(candidate, bindings, entries, ours),
    onCatalog: (observation) => { observations.push(observation); }, runnerClass: PrivateRunner,
  });
  return { runner, guard, observations, registrations: () => registrations, PrivateRunner };
}
test('deferred registration filters conflict in both extension orders without touching other actions', () => {
  for (const reverse of [false, true]) {
    const owner = ext([], true); owner.commands.set('clankers', { handler: anchor }); owner.commands.set('clankers', { handler: anchor }); const competitor = ext([['Alt+G', other], ['alt+j', other]]);
    const extensions = reverse ? [competitor, owner] : [owner, competitor];
    const f = fixture(extensions);
    try {
      assert.equal(f.guard.installed, true); assert.equal(f.registrations(), 0);
      const result = f.runner.getShortcuts({});
      assert.equal(f.registrations(), 0); assert.equal(result.get('alt+g')?.handler, other);
      assert.equal(result.get('alt+j')?.handler, other); assert.equal(owner.shortcuts.size, 0);
      assert.equal(f.observations.at(-1)?.ok, false);
    } finally { f.guard.dispose(); }
  }
});
test('real resolved argument overrides validation; original diagnostics/order/write behavior stays intact', () => {
  const owner = ext([], true); const f = fixture([ext([['alt+k', other]]), owner, ext([['alt+k', last]])]);
  try {
    const result = f.runner.getShortcuts({ 'editor': 'alt+z' });
    assert.equal(f.registrations(), 1); assert.equal(result.get('alt+g')?.handler, ours);
    assert.deepEqual([...result.keys()], ['alt+k', 'alt+g']); assert.equal(result.get('alt+k')?.handler, last);
    assert.equal(f.runner.getShortcutDiagnostics().length, 1);
    const before = [...owner.shortcuts];
    const conflict = f.runner.getShortcuts({ 'override': 'alt+g' });
    assert.equal(conflict.has('alt+g'), false); assert.equal(result.has('alt+g'), false);
    assert.deepEqual([...owner.shortcuts], before); assert.equal(f.registrations(), 1);
    assert.equal(f.runner.getShortcuts({}).has('alt+g'), false); // latched until reload
    assert.equal(f.observations.at(-1)?.ok, false);
  } finally { f.guard.dispose(); }
});
test('unknown/overflow registries fail closed before public registration', () => {
  const registries: Extension[][] = [
    [ext([], true), { ...ext([]), shortcuts: {} } as never],
    [ext([], true), ...Array.from({ length: 256 }, () => ext([]))],
    [ext([], true), ext([['x'.repeat(129), other]])],
    [ext([], true), ext(Array.from({ length: 4097 }, (_, index) => [`alt+${index}`, other]))],
    [ext([], true), ext([], true)],
  ];
  for (const registry of registries) {
    const f = fixture(registry); try { try { f.runner.getShortcuts({}); } catch { /* Preserve original unknown registry error. */ } assert.equal(f.registrations(), 0); }
    finally { f.guard.dispose(); }
  }
});
test('unknown effective argument and validator exceptions never register; preserved original exceptions', () => {
  for (const bindings of [null, { bad: 5 }, { bad: ['alt+g', 3] }, Object.defineProperty({}, 'bad', { enumerable: true, get() { throw new Error('getter'); } })]) {
    const f = fixture([ext([], true)]); try { try { f.runner.getShortcuts(bindings); } catch { /* Original failure allowed. */ } assert.equal(f.registrations(), 0); }
    finally { f.guard.dispose(); }
  }
});
test('retained maps are bounded; cap withdraws own only and stays inactive', () => {
  const f = fixture([ext([], true), ext([['alt+k', other]])]);
  try {
    const maps = Array.from({ length: 128 }, () => f.runner.getShortcuts({}));
    assert.ok(maps.every((map) => map.get('alt+g')?.handler === ours));
    const next = f.runner.getShortcuts({}); assert.equal(next.has('alt+g'), false);
    assert.ok(maps.every((map) => !map.has('alt+g') && map.get('alt+k')?.handler === other));
    assert.equal(f.runner.getShortcuts({}).has('alt+g'), false); assert.match(f.observations.at(-1)?.reason ?? '', /limit/);
  } finally { f.guard.dispose(); }
});
test('guard disposal is idempotent/conditional and does not overwrite a later patch', () => {
  const f = fixture([ext([], true)]); const captured = f.runner.getShortcuts({});
  const second = installManagementShortcutCatalogGuard({ handler: ours, ownerCommandHandler: anchor, candidate: 'alt+g', enabled: () => true, register() {}, validate: () => ({ ok: true }), onCatalog() {}, runnerClass: f.PrivateRunner });
  assert.equal(second.installed, false);
  const later = () => new Map(); Object.defineProperty(f.PrivateRunner.prototype, 'getShortcuts', { value: later, writable: true, configurable: true });
  f.guard.dispose(); f.guard.dispose(); assert.equal(captured.has('alt+g'), false); assert.equal(f.PrivateRunner.prototype.getShortcuts, later);
  class Unknown { getShortcuts() { return new Map(); } }
  const unsupported = installManagementShortcutCatalogGuard({ handler: ours, ownerCommandHandler: anchor, candidate: 'alt+g', enabled: () => true, register() { throw new Error('never'); }, validate: () => ({ ok: true }), onCatalog() {}, runnerClass: Unknown });
  assert.equal(unsupported.installed, false);
});
test('unowned runner leaves original catalog and diagnostics unchanged', () => {
  const f = fixture([ext([['alt+g', other], ['alt+j', last]])]);
  try { assert.equal(f.runner.getShortcuts({}).get('alt+g')?.handler, other); assert.equal(f.registrations(), 0); assert.equal(f.observations.length, 0); }
  finally { f.guard.dispose(); }
});

test('root/bundled current SDK private classes share supported guard semantics, aliases anchor same owner', async () => {
  const { ExtensionRunner: BundledRunner } = await import(new URL('bundle/index.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href);
  for (const Runner of [ExtensionRunner, BundledRunner]) {
    const owner = ext([], true); owner.commands.set('clankers', { handler: anchor });
    const f = fixture([owner], 'alt+g', Runner);
    try { assert.equal(f.guard.installed, true); const map = f.runner.getShortcuts({}); assert.equal(map.get('alt+g')?.handler, ours); assert.equal(f.registrations(), 1); }
    finally { f.guard.dispose(); }
  }
});
test('validator throws or reenters: no registration; original resolver writes once, thrown errors preserved', () => {
  let f: ReturnType<typeof fixture>;
  f = fixture([ext([], true)], 'alt+g', ExtensionRunner, () => { f.runner.getShortcuts({}); return { ok: true }; });
  try { assert.equal(f.runner.getShortcuts({}).has('alt+g'), false); assert.equal(f.registrations(), 0); assert.match(f.observations.at(-1)?.reason ?? '', /Reentrant/); }
  finally { f.guard.dispose(); }
  const failure = fixture([ext([], true)], 'alt+g', ExtensionRunner, () => { throw new Error('validator offline'); });
  try { assert.equal(failure.runner.getShortcuts({}).has('alt+g'), false); assert.equal(failure.registrations(), 0); }
  finally { failure.guard.dispose(); }
  const preserved = fixture([ext([], true), ext([['alt+k', other]]), ext([['alt+k', last]])]);
  let writes = 0; let diagnostics: unknown;
  Object.defineProperty(preserved.runner, 'shortcutDiagnostics', { configurable: true, get: () => diagnostics, set(value) { writes++; assert.equal(this, preserved.runner); diagnostics = value; } });
  const thrown = new Error('original hasUI failure');
  Object.defineProperty(preserved.runner, 'hasUI', { configurable: true, value() { throw thrown; } });
  try { assert.throws(() => preserved.runner.getShortcuts({}), (error) => error === thrown); assert.equal(writes, 1); assert.equal(preserved.registrations(), 0); }
  finally { preserved.guard.dispose(); }
});
test('registry drift/unknown Map after activation withdraws captured maps and never restores another action', () => {
  const owner = ext([], true); const f = fixture([owner, ext([['alt+k', other]])]);
  try {
    const captured = f.runner.getShortcuts({}); owner.shortcuts.set('alt+g', { handler: last, extensionPath: 'last' });
    const next = f.runner.getShortcuts({}); assert.equal(captured.has('alt+g'), false); assert.equal(next.get('alt+g')?.handler, last);
    assert.equal(f.runner.getShortcuts({}).get('alt+g')?.handler, last); assert.equal(f.observations.at(-1)?.ok, false);
  } finally { f.guard.dispose(); }
  const unknown = fixture([ext([], true)]);
  try {
    const captured = unknown.runner.getShortcuts({});
    unknown.runner.extensions.push({ ...ext([]), shortcuts: Object.assign(new Map(), { [Symbol.iterator]: function* () { yield ['alt+k', { handler: other, extensionPath: 'other' }]; } }) });
    const next = unknown.runner.getShortcuts({}); assert.equal(captured.has('alt+g'), false); assert.equal(next.has('alt+g'), false);
  } finally { unknown.guard.dispose(); }
});

test('unsupported iterable registry after activation still filters only own before original lastwins', () => {
  const owner = ext([], true); const competitor = ext([['alt+g', other]]); const f = fixture([owner]);
  try {
    const captured = f.runner.getShortcuts({});
    (f.runner as unknown as { extensions: unknown }).extensions = new Set([competitor, owner]);
    const next = f.runner.getShortcuts({});
    assert.equal(captured.has('alt+g'), false); assert.equal(next.get('alt+g')?.handler, other); assert.equal(owner.shortcuts.get('alt+g')?.handler, ours);
    assert.equal(f.observations.at(-1)?.ok, false);
  } finally { f.guard.dispose(); }
});

// Frozen registry records are an offline compatibility negative case, not a
// claim that Pi's loader normally freezes them. Only private injected classes.
function originalCatalog(extensions: Extension[], bindings: unknown = {}) {
  class OracleRunner extends ExtensionRunner {}
  const runner = new (OracleRunner as unknown as new (...args: unknown[]) => { getShortcuts(bindings: unknown): Map<string, Shortcut>; setUIContext(...args: unknown[]): void; getShortcutDiagnostics(): unknown[] })(extensions, {}, '.', {}, {});
  runner.setUIContext({}, 'tui');
  const map = runner.getShortcuts(bindings);
  return { map, diagnostics: runner.getShortcutDiagnostics() };
}
function assertOriginalCatalog(f: ReturnType<typeof fixture>, extensions: Extension[], bindings: unknown = {}) {
  const expected = originalCatalog(extensions, bindings);
  const actual = f.runner.getShortcuts(bindings);
  assert.deepEqual([...actual], [...expected.map]);
  for (const [key, shortcut] of expected.map) assert.equal(actual.get(key), shortcut);
  assert.deepEqual(f.runner.getShortcutDiagnostics(), expected.diagnostics);
  return actual;
}
test('frozen initial-conflict records preserve the original other-handler catalog, order, identities and diagnostics', () => {
  for (const reverse of [false, true]) for (const freezeOwner of [false, true]) {
    const owner = ext([], true); const competitor = Object.freeze(ext([['Alt+G', other], ['alt+k', other]]));
    if (freezeOwner) Object.freeze(owner);
    const duplicate = Object.freeze(ext([['ALT+K', last], ['alt+j', last]]));
    const extensions = reverse ? [competitor, owner, duplicate] : [owner, competitor, duplicate];
    const mapsBefore = extensions.map((extension) => [...extension.shortcuts]);
    const f = fixture(extensions);
    try {
      assert.equal(f.guard.installed, true);
      assert.equal(assertOriginalCatalog(f, extensions).get('alt+g')?.handler, other);
      assert.equal(f.registrations(), 0); assert.equal(f.observations.at(-1)?.ok, false);
      assert.deepEqual(extensions.map((extension) => [...extension.shortcuts]), mapsBefore);
    } finally { f.guard.dispose(); }
  }
});
test('frozen records after activation filter only own BEFORE lastwins; captured maps withdraw only own and stay inactive', () => {
  for (const reverse of [false, true]) {
    const owner = ext([], true); const competitor = ext([['alt+k', other]]);
    const duplicate = ext([['ALT+K', last], ['alt+j', last]]);
    const extensions = reverse ? [competitor, duplicate, owner] : [owner, competitor, duplicate];
    const f = fixture(extensions);
    try {
      const captured = f.runner.getShortcuts({}); assert.equal(captured.get('alt+g')?.handler, ours);
      competitor.shortcuts.set('Alt+G', { handler: other, extensionPath: 'competitor' });
      extensions.forEach(Object.freeze);
      const before = extensions.map((extension) => [...extension.shortcuts]);
      // Positive oracle: original resolver on identical other entries, omitting
      // only our handler. No mutation of actual host maps or restoration.
      const oracle = extensions.map((extension) => ({ ...extension, shortcuts: new Map([...extension.shortcuts].filter(([, shortcut]) => shortcut.handler !== ours)) }));
      const next = assertOriginalCatalog(f, oracle);
      assert.equal(next.get('alt+g')?.handler, other); assert.equal(captured.has('alt+g'), false);
      assert.equal(captured.get('alt+k')?.handler, last); assert.equal(captured.get('alt+j')?.handler, last);
      assert.deepEqual(extensions.map((extension) => [...extension.shortcuts]), before);
      assert.equal(owner.shortcuts.get('alt+g')?.handler, ours); assert.equal(f.registrations(), 1);
      competitor.shortcuts.delete('Alt+G');
      assert.equal(f.runner.getShortcuts({}).has('alt+g'), false); assert.equal(f.observations.at(-1)?.ok, false);
      assert.equal(f.registrations(), 1);
    } finally { f.guard.dispose(); }
  }
});
test('locked receiver.extensions and frozen records remain invariant-safe on rejected/unsupported catalogs', () => {
  for (const unsupported of [false, true]) {
    const owner = Object.freeze(ext([], true)); const f = fixture([owner]);
    try {
      const captured = f.runner.getShortcuts({}); assert.equal(captured.get('alt+g')?.handler, ours);
      const competitor = Object.freeze(ext([['alt+g', other], ['alt+k', last]]));
      const extensions = unsupported ? new Set([competitor, owner]) : [competitor, owner];
      Object.defineProperty(f.runner, 'extensions', { value: extensions, configurable: false, writable: false });
      const oracle = [competitor, { ...owner, shortcuts: new Map<string, Shortcut>() }];
      const next = assertOriginalCatalog(f, oracle);
      assert.equal(next.get('alt+g')?.handler, other); assert.equal(captured.has('alt+g'), false);
      assert.equal(f.registrations(), 1); assert.equal(f.observations.at(-1)?.ok, false);
    } finally { f.guard.dispose(); }
  }
});
test('frozen malformed records preserve exact original iteration/read exceptions and original diagnostic writes', () => {
  for (const kind of ['iterator', 'getter'] as const) {
    const owner = Object.freeze(ext([], true)); const f = fixture([owner]);
    const thrown = new Error(`original ${kind} failure`);
    const broken = ext([]);
    if (kind === 'iterator') Object.defineProperty(broken.shortcuts, Symbol.iterator, { value() { throw thrown; } });
    else Object.defineProperty(broken, 'shortcuts', { get() { throw thrown; } });
    Object.freeze(broken);
    let writes = 0; let diagnostics: unknown;
    Object.defineProperty(f.runner, 'shortcutDiagnostics', { get: () => diagnostics, set(value) { writes++; assert.equal(this, f.runner); diagnostics = value; } });
    try {
      const captured = f.runner.getShortcuts({}); writes = 0;
      f.runner.extensions.push(broken);
      assert.throws(() => ExtensionRunner.prototype.getShortcuts.call(f.runner as never, {}), (error) => error === thrown);
      assert.equal(writes, 1); writes = 0;
      assert.throws(() => f.runner.getShortcuts({}), (error) => error === thrown);
      assert.equal(writes, 1); assert.deepEqual(diagnostics, []);
      assert.equal(captured.has('alt+g'), false); assert.equal(f.registrations(), 1);
    } finally { f.guard.dispose(); }
  }
});

test('exact independent frozen-record counterexample is closed for root and bundled offline private runners', async () => {
  const { ExtensionRunner: BundledRunner } = await import(new URL('bundle/index.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href);
  for (const Runner of [ExtensionRunner, BundledRunner]) {
    const owner = Object.freeze(ext([], true)); const competitor = Object.freeze(ext([['alt+g', other]]));
    const extensions = [owner, competitor];
    const f = fixture(extensions, 'alt+g', Runner);
    try {
      const original = Runner.prototype.getShortcuts.call(f.runner, {});
      assert.equal(original.get('alt+g')?.handler, other); assert.equal(f.guard.installed, true);
      const guarded = f.runner.getShortcuts({});
      assert.deepEqual([...guarded], [...original]); assert.equal(guarded.get('alt+g'), original.get('alt+g'));
      assert.equal(f.registrations(), 0); assert.equal(owner.shortcuts.size, 0);
      assert.equal(f.observations.at(-1)?.ok, false);
    } finally { f.guard.dispose(); }
  }
});
