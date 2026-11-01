import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { getKeybindings } from '@earendil-works/pi-tui';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExtensionRunner, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createUiPreferences } from '../../ui/preferences.js';
import { createManagementShortcutController, isManagementShortcutPacket, validateManagementShortcut } from '../../ui/management-shortcut.js';
import { ZergManagementOverlayComponent, type ZergManagementOverlayActions } from '../../ui/management-overlay.js';
import { createZergState } from '../../state.js';
const other = () => {};
test('effective builtins and extension normalization/terminal equivalence, not merely shared letters', async () => {
  const { KeybindingsManager } = await import(new URL('core/keybindings.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href);
  const defaults = new KeybindingsManager().getEffectiveConfig();
  assert.equal(validateManagementShortcut('alt+g', defaults, []).ok, true);
  assert.equal(validateManagementShortcut('alt+j', defaults, []).ok, true);
  for (const [candidate, occupied] of [
    ['alt+g', 'Alt+G'], ['ctrl+alt+g', 'alt+ctrl+g'], ['alt+g', 'alt+shift+g'], ['alt+g', 'alt+super+g'],
    ['ctrl+i', 'tab'], ['ctrl+m', 'enter'], ['ctrl+j', 'enter'], ['ctrl+h', 'backspace'],
    ['ctrl+2', 'ctrl+space'], ['ctrl+3', 'escape'], ['ctrl+4', 'ctrl+\\'], ['ctrl+5', 'ctrl+]'], ['ctrl+6', 'ctrl+^'], ['ctrl+7', 'ctrl+-'], ['ctrl+8', 'backspace'],
    ['ctrl+alt+i', 'alt+tab'], ['ctrl+alt+m', 'alt+enter'], ['alt+b', 'alt+left'], ['alt+f', 'alt+right'],
  ]) {
    assert.equal(validateManagementShortcut(candidate, { custom: occupied }, []).ok, false, `${candidate} / ${occupied}`);
    assert.equal(validateManagementShortcut(candidate, {}, [{ key: occupied!, handler: other }]).ok, false, `extension ${candidate} / ${occupied}`);
  }
  for (const occupied of ['g', 'ctrl+g', 'alt+j', 'ctrl+alt+g']) assert.equal(validateManagementShortcut('alt+g', { action: occupied }, []).ok, true, occupied);
  assert.equal(validateManagementShortcut('alt+g', { custom: [] }, []).ok, true); // disabled override
  for (const occupied of ['meta+g', 'hyper+g', 'garbage', 'alt+alt+g']) assert.equal(validateManagementShortcut('alt+g', { action: occupied }, []).ok, false);
  assert.equal(validateManagementShortcut('alt+g', {}, [{ key: 'alt+g', handler: other }], other).ok, true);
  assert.equal(validateManagementShortcut('alt+g', { action: 'x'.repeat(129) }, []).ok, false);
});
test('entire exact packet only: no mixed/pasted/malformed/repeat/release authorization', () => {
  for (const packet of ['\x1bg', '\x1b[103;3u', '\x1b[27;3;103~', '\x1b[103;3:1u']) assert.equal(isManagementShortcutPacket(packet, 'alt+g'), true, JSON.stringify(packet));
  for (const packet of ['g', '\x1bgtext', 'text\x1bg', '\x1b[200~\x1bg\x1b[201~', '\x1b[200~', '\x1b[201~', '\x1b[103;3:2u', '\x1b[103;3:3u', '\x1b[103;3u\x1b[103;3u', '\x1b[103;19u', '\x1b[103;3u\n', '\x1b[103:71;3u']) assert.equal(isManagementShortcutPacket(packet, 'alt+g'), false, JSON.stringify(packet));
});
function fixture(initial?: string | null) {
  const dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.shortcut-'));
  const preferences = createUiPreferences({ agentDir: dir });
  if (initial !== undefined) assert.equal(preferences.saveHuman({ managementShortcut: initial }).ok, true);
  class PrivateRunner extends ExtensionRunner {}
  Object.defineProperty(PrivateRunner.prototype, 'getShortcuts', Object.getOwnPropertyDescriptor(ExtensionRunner.prototype, 'getShortcuts')!);
  const anchor = () => {};
  type Shortcut = { handler: (ctx: ExtensionContext) => void; extensionPath: string };
  const owner = { path: 'ours', commands: new Map([['zerg', { handler: anchor }]]), shortcuts: new Map<string, Shortcut>() };
  const runner = new (PrivateRunner as unknown as new (...args: unknown[]) => { getShortcuts(bindings: unknown): Map<string, Shortcut>; setUIContext(...args: unknown[]): void })([owner], {}, '.', {}, {});
  runner.setUIContext({}, 'tui');
  let listener: ((data: string) => undefined) | undefined;
  let removed = 0;
  let registrations = 0;
  let opens = 0;
  let opening = false;
  let overlay = false;
  let focused: unknown = {};
  let warnings = 0;
  const controller = createManagementShortcutController({
    pi: { registerShortcut(key, options) { registrations++; owner.shortcuts.set(key, { handler: options.handler as (ctx: ExtensionContext) => void, extensionPath: 'ours' }); } },
    preferences, ownerCommandHandler: anchor, runnerClass: PrivateRunner,
    openManagement() { if (opening) return; opening = true; opens++; }, isOpening: () => opening, warn: () => warnings++,
  });
  const context = { mode: 'tui', hasUI: true, ui: { onTerminalInput(callback: (data: string) => undefined) { listener = callback; return () => { removed++; listener = undefined; }; } } };
  const tui = { hasOverlay: () => overlay, getFocusedComponent: () => focused };
  return {
    controller, runner, owner, preferences, context, tui,
    saved() { const path = join(dir, 'zerg-swarm/ui.json'); const stat = statSync(path); return { bytes: readFileSync(path), inode: stat.ino, mtime: stat.mtimeMs, files: readdirSync(dirname(path)) }; },
    input(packet: string) { assert.equal(listener?.(packet), undefined); },
    fire(handler = owner.shortcuts.get('alt+g')?.handler) { handler?.({ mode: 'tui', hasUI: true } as ExtensionContext); },
    counts: () => ({ opens, registrations, removed, warnings }),
    modal(value: boolean) { overlay = value; }, focus(value: unknown) { focused = value; }, closeOverlay() { opening = false; },
    close() { controller.dispose(); rmSync(dir, { recursive: true, force: true }); },
  };
}
test('passive synchronous one-use token expires; modal/prompt/shared latch/generation reject; cleanup once', async () => {
  const f = fixture(); try {
    f.controller.attach(f.context); f.controller.setTui(f.tui);
    assert.equal(f.counts().registrations, 0); f.runner.getShortcuts({}); assert.equal(f.controller.status().active, 'alt+g');
    f.fire(); assert.equal(f.counts().opens, 0);
    f.input('\x1bg'); f.fire(); f.fire(); assert.equal(f.counts().opens, 1);
    f.input('\x1bg'); f.fire(); assert.equal(f.counts().opens, 1); f.closeOverlay();
    f.input('\x1bg'); await Promise.resolve(); f.fire(); assert.equal(f.counts().opens, 1);
    f.modal(true); f.input('\x1bg'); f.fire(); f.modal(false); assert.equal(f.counts().opens, 1);
    f.controller.promptStart(); f.input('\x1bg'); f.fire(); f.controller.promptEnd(); assert.equal(f.counts().opens, 1);
    f.focus(undefined); f.input('\x1bg'); f.fire(); f.focus({}); assert.equal(f.counts().opens, 1);
    f.input('\x1bg'); f.controller.setTui(f.tui); f.fire(); assert.equal(f.counts().opens, 1);
    f.input('\x1bg'); f.modal(true); f.fire(); f.modal(false); assert.equal(f.counts().opens, 1);
    for (const packet of ['\x1b[200~\x1bg\x1b[201~', '\x1bgmore', '\x1b[103;3:2u', '\x1b[103;3:3u']) { f.input(packet); f.fire(); }
    assert.equal(f.counts().opens, 1);
    f.input('\x1b[200~'); f.input('\x1bg'); f.fire(); assert.equal(f.counts().opens, 1); f.input('\x1b[201~');
    f.input('\x1bg'); f.fire(); assert.equal(f.counts().opens, 2);
    f.controller.dispose(); f.controller.dispose(); assert.equal(f.counts().removed, 1);
  } finally { f.close(); }
});
test('all desired shortcut changes are reload-only, visibility independent, catalog conflict terminal latch', () => {
  const f = fixture(); try {
    f.controller.attach(f.context); f.controller.setTui(f.tui); const editorMap = f.runner.getShortcuts({});
    assert.equal(f.controller.settings.saveHuman({ managementShortcut: 'alt+j' }).ok, true);
    assert.deepEqual([f.controller.status().active, f.controller.status().desired, f.controller.status().pending], ['alt+g', 'alt+j', true]);
    assert.equal(f.runner.getShortcuts({}).get('alt+g')?.handler, f.owner.shortcuts.get('alt+g')?.handler);
    assert.equal(f.controller.status().active, 'alt+g');
    assert.equal(f.controller.settings.saveHuman({ managementShortcut: null }).ok, true);
    assert.equal(f.controller.status().active, 'alt+g'); assert.equal(f.controller.status().pending, true);
    assert.equal(f.controller.settings.saveHuman({ activityStrip: false }).ok, true);
    assert.equal(f.controller.settings.snapshot().activityStrip, false); assert.equal(f.controller.status().active, 'alt+g');
    assert.equal(f.controller.settings.saveHuman({ managementShortcut: 'alt+g' }).ok, true); assert.equal(f.controller.status().pending, false);
    f.runner.getShortcuts({ override: 'alt+j' }); const prior = f.preferences.snapshot();
    assert.equal(f.controller.settings.saveHuman({ managementShortcut: 'alt+j' }).ok, false); assert.deepEqual(f.preferences.snapshot(), prior);
    f.runner.getShortcuts({ override: 'alt+g' }); assert.equal(f.controller.status().active, null); assert.equal(editorMap.has('alt+g'), false);
    f.runner.getShortcuts({}); assert.equal(f.controller.status().active, null); assert.equal(f.counts().warnings, 1);
  } finally { f.close(); }
});
test('nonTUI/unsupported/no public safety surface never register, fallback remains; disabled generation stays disabled', () => {
  const f = fixture(); try { f.controller.attach({ mode: 'rpc', hasUI: true }); f.controller.setTui(f.tui); f.runner.getShortcuts({}); assert.equal(f.counts().registrations, 0); assert.equal(f.controller.status().fallback, '/clankers config'); }
  finally { f.close(); }
  const disabled = fixture(null); try {
    disabled.controller.attach(disabled.context); disabled.controller.setTui(disabled.tui); disabled.runner.getShortcuts({}); assert.equal(disabled.counts().registrations, 0);
    assert.equal(disabled.controller.settings.saveHuman({ managementShortcut: 'alt+g' }).ok, true);
    disabled.runner.getShortcuts({}); assert.equal(disabled.counts().registrations, 0); assert.equal(disabled.controller.status().active, null); assert.equal(disabled.controller.status().pending, true);
  } finally { disabled.close(); }
  const missing = fixture(); try { missing.controller.attach(missing.context); missing.runner.getShortcuts({}); missing.controller.setTui(missing.tui); missing.runner.getShortcuts({}); assert.equal(missing.counts().registrations, 0); }
  finally { missing.close(); }
});
test('optional settings Input owns authority-key text; old controls and chat draft remain intact outside subview', () => {
  const f = fixture(); let actionsCalled = 0; let completed = 0;
  const actions: ZergManagementOverlayActions = {
    now: () => new Date(), toggleReadOnly: () => { actionsCalled++; return 'toggled'; }, setAutomation: () => { actionsCalled++; return 'mode'; }, setController: () => { actionsCalled++; return 'controller'; }, approvePermission: () => { actionsCalled++; return 'approve'; }, denyPermission: () => { actionsCalled++; return 'deny'; }, selectTarget: () => 'selected', interruptSelected: () => { actionsCalled++; return 'interrupt'; }, sendOperatorMessage: () => ({ status: 'transport-unavailable', statusDetail: 'unavailable' }),
  };
  try {
    f.controller.attach(f.context); f.controller.setTui(f.tui); f.runner.getShortcuts({});
    const component = new ZergManagementOverlayComponent({ requestRender() {} }, undefined, () => { completed++; }, { getSnapshot: () => createZergState(), subscribe: () => () => {}, adapterKind: 'native', actions, uiPreferences: f.controller.settings });
    component.handleInput('\t'); component.handleInput('\t'); component.handleInput('draft'); assert.equal(component.getStateForTests().chatDraft, 'draft');
    component.handleInput('\x1b[Z'); component.handleInput('o');
    assert.match(component.render(140, 36).join('\n'), /UI preferences/);
    for (const key of ['r', 'm', 'a', 'u', 'c', 'i', 'p', 'd', 'q']) component.handleInput(key);
    assert.equal(actionsCalled, 0); assert.equal(completed, 0);
    component.handleInput('\x16'); assert.equal(f.preferences.snapshot().desired.activityStrip, false);
    component.handleInput('\r'); assert.equal(f.preferences.snapshot().desired.managementShortcut, 'alt+g'); // invalid draft rejected
    component.handleInput('\x1b'); assert.equal(completed, 0); assert.equal(component.getStateForTests().chatDraft, 'draft');
    component.handleInput('r'); assert.equal(actionsCalled, 1);
    component.handleInput('q'); assert.equal(completed, 1); component.dispose(); assert.equal(completed, 1);
  } finally { f.close(); }
});

test('session reattachment keeps immutable extension candidate and drops stale input authorization', () => {
  const f = fixture();
  try {
    f.controller.attach(f.context); f.controller.setTui(f.tui); f.runner.getShortcuts({});
    assert.equal(f.controller.settings.saveHuman({ managementShortcut: 'alt+j' }).ok, true);
    f.input('\x1bg'); f.controller.detach(); f.fire(); assert.equal(f.counts().opens, 0);
    f.controller.attach(f.context); f.controller.setTui(f.tui); f.runner.getShortcuts({});
    assert.equal(f.controller.status().active, 'alt+g'); assert.equal(f.controller.status().desired, 'alt+j'); assert.equal(f.counts().registrations, 1);
    f.input('\x1bg'); f.fire(); assert.equal(f.counts().opens, 1);
  } finally { f.close(); }
});


test('saves use the observed host catalog, not the imported TUI singleton; invalid proposals never write', () => {
  const f = fixture();
  try {
    const singletonBindings = getKeybindings().getResolvedBindings();
    assert.equal(validateManagementShortcut('alt+n', singletonBindings, []).ok, true);
    f.controller.attach(f.context); f.controller.setTui(f.tui);
    const competitor = Object.freeze({ handler: other, extensionPath: 'foreign' });
    f.owner.shortcuts.set('alt+k', competitor); Object.freeze(f.owner);
    const hostBindings = Object.freeze({ 'app.session.new': 'alt+n', 'tui.input.tab': Object.freeze(['tab']) });
    const editorMap = f.runner.getShortcuts(hostBindings);
    assert.equal(f.controller.status().active, 'alt+g');
    assert.equal(editorMap.get('alt+k'), competitor);
    assert.equal(f.controller.settings.saveHuman({ managementShortcut: 'alt+j' }).ok, true);
    const prior = f.preferences.snapshot(); const saved = f.saved();
    for (const proposal of ['ctrl+i', 'alt+k', 'alt+n']) {
      assert.equal(f.controller.settings.saveHuman({ managementShortcut: proposal }).ok, false, proposal);
      assert.deepEqual(f.preferences.snapshot(), prior); assert.deepEqual(f.saved(), saved);
    }
    assert.equal(f.controller.status().desired, 'alt+j'); assert.equal(f.controller.status().active, 'alt+g');
    assert.equal(f.controller.status().pending, true); assert.equal(editorMap.get('alt+k'), competitor);
    assert.deepEqual(hostBindings, { 'app.session.new': 'alt+n', 'tui.input.tab': ['tab'] });
    assert.equal(f.controller.settings.saveHuman({ managementShortcut: null }).ok, true);
    assert.equal(f.controller.status().active, 'alt+g'); assert.equal(f.controller.status().pending, true);
    assert.equal(f.controller.settings.saveHuman({ activityStrip: false }).ok, true);
  } finally { f.close(); }
});

test('host binding and extension snapshots resist later foreign mutation and follow the latest observation', () => {
  const f = fixture();
  try {
    f.controller.attach(f.context); f.controller.setTui(f.tui);
    const keys = ['alt+n']; const bindings = { 'app.session.new': keys };
    const competitor = { handler: other, extensionPath: 'foreign' };
    f.owner.shortcuts.set('alt+k', competitor); f.runner.getShortcuts(bindings);
    assert.equal(f.controller.settings.saveHuman({ managementShortcut: 'alt+j' }).ok, true);
    const saved = f.saved();
    keys[0] = 'alt+j'; f.owner.shortcuts.delete('alt+k'); competitor.handler = () => {};
    for (const proposal of ['alt+n', 'alt+k']) {
      assert.equal(f.controller.settings.saveHuman({ managementShortcut: proposal }).ok, false);
      assert.deepEqual(f.saved(), saved);
    }
    assert.equal(f.controller.settings.saveHuman({ managementShortcut: 'alt+j' }).ok, true);
    f.runner.getShortcuts(Object.freeze({ 'app.session.new': Object.freeze(['alt+j']) }));
    const latest = f.saved();
    assert.equal(f.controller.settings.saveHuman({ managementShortcut: 'alt+j' }).ok, false);
    assert.deepEqual(f.saved(), latest);
    assert.equal(f.controller.settings.saveHuman({ managementShortcut: 'alt+n' }).ok, true);
  } finally { f.close(); }
});

test('missing, stale, detached, failed and disposed catalog authority rejects saves without writing', () => {
  const f = fixture('alt+j');
  try {
    const reject = () => {
      const prior = f.preferences.snapshot(); const saved = f.saved();
      assert.equal(f.controller.settings.saveHuman({ managementShortcut: 'alt+n' }).ok, false);
      assert.deepEqual(f.preferences.snapshot(), prior); assert.deepEqual(f.saved(), saved);
    };
    reject(); f.controller.attach(f.context); f.controller.setTui(f.tui); reject();
    f.runner.getShortcuts({});
    f.controller.setTui(f.tui); reject(); // generation changes need a fresh host observation
    f.runner.getShortcuts({}); assert.equal(f.controller.settings.saveHuman({ managementShortcut: 'alt+k' }).ok, true);
    f.controller.detach(); reject();
    f.controller.attach(f.context); f.controller.setTui(f.tui); reject();
    f.runner.getShortcuts({}); assert.equal(f.controller.settings.saveHuman({ managementShortcut: 'alt+n' }).ok, true);
    const malformed = Object.create(null); Object.defineProperty(malformed, 'bad', { get() { throw new Error('unreadable host catalog'); }, enumerable: true });
    assert.throws(() => f.runner.getShortcuts(malformed), /unreadable host catalog/); reject();
    f.controller.dispose(); reject();
  } finally { f.close(); }
});


test('unavailable or overflow latest host bindings erase old authority; disposal of a valid snapshot fails closed', () => {
  for (const unavailable of [undefined, { 'app.session.new': undefined }, { 'app.session.new': Array(4097).fill('alt+n') }]) {
    const f = fixture('alt+j');
    try {
      f.controller.attach(f.context); f.controller.setTui(f.tui); f.runner.getShortcuts({});
      try { f.runner.getShortcuts(unavailable); } catch { /* Preserve original resolver exceptions. */ }
      const prior = f.preferences.snapshot(); const saved = f.saved();
      assert.equal(f.controller.settings.saveHuman({ managementShortcut: 'alt+n' }).ok, false);
      assert.deepEqual(f.preferences.snapshot(), prior); assert.deepEqual(f.saved(), saved);
      assert.equal(f.controller.settings.saveHuman({ managementShortcut: null }).ok, true);
      assert.equal(f.controller.settings.saveHuman({ activityStrip: false }).ok, true);
    } finally { f.close(); }
  }
  const f = fixture('alt+j');
  try {
    f.controller.attach(f.context); f.controller.setTui(f.tui); f.runner.getShortcuts({});
    assert.equal(f.controller.settings.saveHuman({ managementShortcut: 'alt+n' }).ok, true);
    const prior = f.preferences.snapshot(); const saved = f.saved(); f.controller.dispose();
    assert.equal(f.controller.settings.saveHuman({ managementShortcut: 'alt+k' }).ok, false);
    assert.deepEqual(f.preferences.snapshot(), prior); assert.deepEqual(f.saved(), saved);
  } finally { f.close(); }
});


test('effective binding output accepts 4096 and rejects 4097, including cumulative finite over-yield', () => {
  assert.equal(validateManagementShortcut('alt+j', { action: Object.freeze(Array(4096).fill('alt+n')) }, []).ok, true);
  assert.equal(validateManagementShortcut('alt+j', { action: Array(4097).fill('alt+n') }, []).ok, false);
  assert.equal(validateManagementShortcut('alt+j', { first: 'alt+n', second: Array(4095).fill('alt+n') }, []).ok, true);
  const overYield = ['alt+n'];
  Object.defineProperty(overYield, Symbol.iterator, { value: function* () { for (let i = 0; i < 4097; i++) yield 'alt+n'; } });
  assert.equal(overYield.length, 1);
  assert.equal(validateManagementShortcut('alt+j', { action: overYield }, []).ok, false);
  const cumulative = ['alt+n'];
  Object.defineProperty(cumulative, Symbol.iterator, { value: function* () { for (let i = 0; i < 4096; i++) yield 'alt+n'; } });
  assert.equal(validateManagementShortcut('alt+j', { first: 'alt+n', second: cumulative }, []).ok, false);
});

test('4096 frozen host bindings preserve reload-only desired saves, foreign controls and safe disable/visibility', () => {
  const f = fixture();
  try {
    f.controller.attach(f.context); f.controller.setTui(f.tui);
    const keys = Object.freeze(Array(4096).fill('alt+n'));
    const bindings = Object.freeze({ action: keys });
    const competitor = Object.freeze({ handler: other, extensionPath: 'foreign' });
    f.owner.shortcuts.set('alt+k', competitor); Object.freeze(f.owner);
    const editorMap = f.runner.getShortcuts(bindings);
    assert.equal(f.controller.status().active, 'alt+g');
    assert.equal(f.controller.settings.saveHuman({ managementShortcut: 'alt+j' }).ok, true);
    const prior = f.preferences.snapshot(); const saved = f.saved();
    for (const proposal of ['alt+n', 'alt+k']) {
      assert.equal(f.controller.settings.saveHuman({ managementShortcut: proposal }).ok, false);
      assert.deepEqual(f.preferences.snapshot(), prior); assert.deepEqual(f.saved(), saved);
    }
    assert.equal(f.controller.status().desired, 'alt+j'); assert.equal(f.controller.status().pending, true);
    assert.equal(editorMap.get('alt+k'), competitor); assert.equal(keys.length, 4096);
    assert.equal(keys.every((key) => key === 'alt+n'), true);
    assert.equal(f.controller.settings.saveHuman({ managementShortcut: null }).ok, true);
    assert.equal(f.controller.status().active, 'alt+g');
    assert.equal(f.controller.settings.saveHuman({ activityStrip: false }).ok, true);
    assert.equal(f.controller.settings.snapshot().activityStrip, false);
  } finally { f.close(); }
});

test('finite iterator overflow during validation or snapshot erases latest authority without writes or losing desired Alt+J', () => {
  for (const snapshotOnly of [false, true]) {
    const f = fixture('alt+j');
    try {
      f.controller.attach(f.context); f.controller.setTui(f.tui);
      const competitor = Object.freeze({ handler: other, extensionPath: 'foreign' });
      f.owner.shortcuts.set('alt+k', competitor); Object.freeze(f.owner);
      const editorMap = f.runner.getShortcuts(Object.freeze({ action: Object.freeze(['alt+n']) }));
      assert.equal(f.controller.status().active, 'alt+j');
      const prior = f.preferences.snapshot(); const saved = f.saved();
      let traversals = 0;
      const values = ['alt+n'];
      Object.defineProperty(values, Symbol.iterator, { value: function* () {
        traversals++;
        const count = snapshotOnly && traversals === 1 ? 1 : 4097;
        for (let i = 0; i < count; i++) yield 'alt+n';
      } });
      const latestMap = f.runner.getShortcuts(Object.freeze({ action: Object.freeze(values) }));
      assert.equal(f.controller.status().alternative, undefined);
      for (const proposal of ['alt+j', 'alt+n', 'alt+k']) {
        const result = f.controller.settings.saveHuman({ managementShortcut: proposal });
        assert.equal(result.ok, false, `${snapshotOnly} / ${proposal}`);
        if (!result.ok) assert.match(result.reason!, /catalog unavailable\/stale/i);
        assert.deepEqual(f.preferences.snapshot(), prior); assert.deepEqual(f.saved(), saved);
      }
      assert.equal(f.controller.status().desired, 'alt+j');
      assert.equal(editorMap.get('alt+k'), competitor); assert.equal(latestMap.get('alt+k'), competitor);
      assert.equal(values.length, 1); assert.equal(values[0], 'alt+n');
      assert.equal(f.controller.settings.saveHuman({ managementShortcut: null }).ok, true);
      assert.equal(f.controller.settings.saveHuman({ activityStrip: false }).ok, true);
      assert.equal(f.controller.settings.snapshot().activityStrip, false);
    } finally { f.close(); }
  }
});
