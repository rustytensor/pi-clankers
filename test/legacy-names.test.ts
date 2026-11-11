import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createClankersPersistenceManager } from '../persistence.js';
import { createClankersStateContainer, getSubagentRunSnapshot } from '../state.js';

// Fixed input in the pre-2.0.0 format: old default path, old extension key, old controller value, old run id.
const OLD_SNAPSHOT = '{"version":1,"packageVersion":"1.1.32","stateSchemaVersion":"0.2.0","writerSessionId":"zerg-old-writer","savedAt":"2026-10-01T00:00:00.000Z","state":{"schemaVersion":"0.2.0","lifecycle":"ready","revision":1,"metadata":{"createdAt":"2026-10-01T00:00:00.000Z","updatedAt":"2026-10-01T00:00:00.000Z","resetCount":0},"agents":{"zerg-finished":{"id":"zerg-finished","label":"Old run","kind":"subagent","status":"completed","metadata":{}}},"tasks":{},"teams":{},"tree":{},"events":[],"mode":{"automation":"manual","interventionEnabled":true,"controller":"operator"},"extensions":{"zergControl":{"controller":"zerg"}},"agentDefinitions":{}}}\n';

test('an old-format saved snapshot is converted once and loads under the new names', () => {
  const root = mkdtempSync(join(tmpdir(), 'clankers-legacy-'));
  try {
    const oldFile = join(root, '.pi/zerg-swarm/v1/state.json');
    const newFile = join(root, '.pi/clankers/v1/state.json');
    mkdirSync(join(root, '.pi/zerg-swarm/v1'), { recursive: true });
    writeFileSync(oldFile, OLD_SNAPSHOT);

    const manager = createClankersPersistenceManager({ rootDir: root })!;
    assert.equal(manager.info.snapshotFile, newFile);
    const container = createClankersStateContainer();
    const info = manager.hydrate(container);
    assert.equal(info.lastLoadError, undefined);

    // Expected values worked out from the fixed input above: key renamed, controller value renamed, everything else kept.
    const state = container.read();
    assert.deepEqual(Object.keys(state.extensions).filter(key => key.startsWith('zerg')), []);
    assert.ok(Object.hasOwn(state.extensions, 'clankersControl'));
    assert.equal((state.extensions.clankersControl as { controller: string }).controller, 'clankers');
    assert.equal(getSubagentRunSnapshot(state, 'zerg-finished')?.runId, 'zerg-finished');

    const written = JSON.parse(readFileSync(newFile, 'utf8'));
    assert.deepEqual(Object.keys(written.state.extensions), ['clankersControl']);
    assert.equal(written.state.extensions.clankersControl.controller, 'clankers');
    assert.equal(written.writerSessionId, 'zerg-old-writer');
    assert.equal(readFileSync(oldFile, 'utf8'), OLD_SNAPSHOT, 'the old file is not touched');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
