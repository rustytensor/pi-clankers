import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUiPreferences, normalizeManagementShortcut } from '../../ui/preferences.js';
function fixture() {
  const dir = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.prefs-'));
  return { dir, file: join(dir, 'clankers', 'ui.json'), close: () => rmSync(dir, { recursive: true, force: true }) };
}
test('portable grammar normalizes case/order and rejects unsupported settings', () => {
  for (const [input, output] of [['Alt+G', 'alt+g'], ['ALT+CTRL+7', 'ctrl+alt+7'], ['ctrl+a', 'ctrl+a']]) assert.equal(normalizeManagementShortcut(input), output);
  assert.equal(normalizeManagementShortcut(null), null);
  for (const input of ['g', '7', '', 'shift+alt+g', 'super+g', 'ctrl+ctrl+g', 'meta+g', 'ctrl+enter', 'alt++', 'ctrl +g', 'a'.repeat(129), undefined, 12]) assert.throws(() => normalizeManagementShortcut(input));
});
test('defaults in memory only; explicit atomic human saves preserve invalid proposals', () => {
  const f = fixture();
  try {
    const store = createUiPreferences({ agentDir: f.dir });
    assert.deepEqual(store.snapshot().desired, { version: 1, activityStrip: true, managementShortcut: 'alt+g' });
    assert.equal(existsSync(f.file), false);
    let notices = 0; const unsub = store.subscribe(() => notices++);
    assert.deepEqual(store.saveHuman({ activityStrip: false, managementShortcut: 'ALT+J' }), { ok: true });
    assert.equal(notices, 1); const prior = readFileSync(f.file, 'utf8');
    assert.equal(store.saveHuman({ managementShortcut: 'shift+g' }).ok, false);
    assert.equal(store.saveHuman({ activityStrip: undefined }).ok, false);
    assert.equal(store.saveHuman({ version: 2 } as never).ok, false);
    assert.equal(readFileSync(f.file, 'utf8'), prior); assert.equal(notices, 1);
    assert.equal(store.saveHuman({ managementShortcut: null }).ok, true);
    assert.equal(store.snapshot().desired.managementShortcut, null);
    assert.equal(store.saveHuman({ managementShortcut: 'alt+g' }).ok, true);
    assert.equal(store.snapshot().desired.activityStrip, false);
    assert.deepEqual(readdirSync(dirname(f.file)), ['ui.json']);
    unsub(); assert.equal(store.saveHuman({ activityStrip: true }).ok, true); assert.equal(notices, 3);
  } finally { f.close(); }
});
test('malformed/schema/oversized preferences fail closed without overwrite or default shortcut', () => {
  for (const content of ['bad json', '{}', '{"version":2,"activityStrip":true,"managementShortcut":"alt+g"}', '{"version":1,"activityStrip":true,"managementShortcut":"g"}', '{"version":1,"activityStrip":true,"managementShortcut":"alt+g","extra":1}', ' '.repeat(4097)]) {
    const f = fixture(); try {
      mkdirSync(dirname(f.file)); writeFileSync(f.file, content);
      const store = createUiPreferences({ agentDir: f.dir });
      assert.ok(store.snapshot().loadError); assert.equal(store.snapshot().desired.managementShortcut, null);
      assert.equal(store.saveHuman({ managementShortcut: 'alt+g' }).ok, false);
      assert.equal(readFileSync(f.file, 'utf8'), content);
    } finally { f.close(); }
  }
});
test('failed/external-update save preserves prior desired state', () => {
  const f = fixture(); try {
    const store = createUiPreferences({ agentDir: f.dir });
    writeFileSync(join(f.dir, 'clankers'), 'not a directory');
    assert.equal(store.saveHuman({ activityStrip: false }).ok, false);
    assert.equal(store.snapshot().desired.activityStrip, true);
    rmSync(join(f.dir, 'clankers')); mkdirSync(dirname(f.file)); writeFileSync(f.file, 'external');
    assert.equal(store.saveHuman({ activityStrip: false }).ok, false);
    assert.equal(store.snapshot().desired.activityStrip, true); assert.equal(readFileSync(f.file, 'utf8'), 'external');
  } finally { f.close(); }
});
