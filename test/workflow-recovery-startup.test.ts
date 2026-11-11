import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClankersPersistenceManager } from '../persistence.js';
import { createClankersStateContainer } from '../state.js';
import { registerClankersExtension } from '../index.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'clankers-startup-inert-'));
}

function fakeContext() {
  const emitted: unknown[] = [];
  return {
    emitted,
    events: {
      emit(event: unknown) { emitted.push(event); return true; },
      on() { return { dispose() {} }; },
    },
    registerCommand() { return { dispose() {} }; },
    registerTool() { return { dispose() {} }; },
    on() { return { dispose() {} }; },
  };
}

function seedSnapshot(snapshotFile: string): { bytes: Buffer; ownerWriterSessionId: string } {
  const manager = createClankersPersistenceManager({ enabled: true, snapshotFile });
  assert.ok(manager);
  const container = createClankersStateContainer();
  manager.hydrate(container);
  manager.save(container.snapshot());
  const owner = manager.acquireRecoveryOwnership?.();
  assert.ok(owner);
  return { bytes: readFileSync(snapshotFile), ownerWriterSessionId: owner.owner.writerSessionId };
}

test('registration is inert and inspectable when retained recovery owner blocks generic startup writes', async () => {
  const root = tempRoot();
  try {
    const snapshotFile = join(root, 'state.json');
    const seeded = seedSnapshot(snapshotFile);
    const markerBefore = readFileSync(`${snapshotFile}.recovery-writer.lock/owner.json`);
    const markerStatBefore = statSync(`${snapshotFile}.recovery-writer.lock/owner.json`);
    const context = fakeContext();

    const registration = registerClankersExtension(context as never, { persistence: { enabled: true, snapshotFile } });
    assert.equal(context.emitted.length, 0, 'startup patch.emit must not publish when recovery is inert');

    const status = await registration.control.execute({ action: 'status' });
    assert.equal(status.ok, true);
    const persistence = (status.data as { persistence: { startupRecovery?: { blocked?: boolean; reason?: string; ownerWriterSessionId?: string } } }).persistence;
    assert.equal(persistence.startupRecovery?.blocked, true);
    assert.equal(persistence.startupRecovery?.reason, 'owner-lock-present');
    assert.equal(persistence.startupRecovery?.ownerWriterSessionId, seeded.ownerWriterSessionId);

    context.events.emit('pi:passive');
    assert.equal(context.emitted.length, 1, 'passive Pi event reaches fake bus but clankers observation remains noop');
    const createResult = await registration.control.execute({ action: 'agents.create', id: 'blocked', prompt: 'no write' });
    assert.equal(createResult.ok, false);
    assert.match(createResult.error?.message ?? '', /startup recovery is inert/i);

    registration.dispose();
    assert.deepEqual(readFileSync(snapshotFile), seeded.bytes, 'snapshot bytes preserved through register/dispose');
    assert.deepEqual(readFileSync(`${snapshotFile}.recovery-writer.lock/owner.json`), markerBefore, 'owner marker preserved');
    assert.equal(statSync(`${snapshotFile}.recovery-writer.lock/owner.json`).mtimeMs, markerStatBefore.mtimeMs, 'owner marker not rewritten');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('registration is inert for retained recovery claim and malformed snapshots without cleanup', async () => {
  for (const mode of ['claim', 'corrupt'] as const) {
    const root = tempRoot();
    try {
      const snapshotFile = join(root, `${mode}.json`);
      if (mode === 'claim') {
        const manager = createClankersPersistenceManager({ enabled: true, snapshotFile });
        assert.ok(manager);
        const container = createClankersStateContainer();
        manager.hydrate(container);
        manager.save(container.snapshot());
        mkdirSync(`${snapshotFile}.recovery-writer.claim`, { mode: 0o700 });
      } else {
        mkdirSync(root, { recursive: true });
        writeFileSync(snapshotFile, '{not-json');
      }
      const before = readFileSync(snapshotFile);
      const context = fakeContext();
      const registration = registerClankersExtension(context as never, { persistence: { enabled: true, snapshotFile } });
      const status = await registration.control.execute({ action: 'status' });
      const startupRecovery = (status.data as { persistence: { startupRecovery?: { blocked?: boolean; reason?: string } } }).persistence.startupRecovery;
      assert.equal(startupRecovery?.blocked, true);
      assert.equal(startupRecovery?.reason, mode === 'claim' ? 'claim-present' : 'inspection-blocked');
      registration.dispose();
      assert.deepEqual(readFileSync(snapshotFile), before);
      if (mode === 'claim') assert.ok(statSync(`${snapshotFile}.recovery-writer.claim`).isDirectory());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test('plain first startup still emits startup patch event', () => {
  const root = tempRoot();
  try {
    const context = fakeContext();
    const registration = registerClankersExtension(context as never, { persistence: { enabled: true, snapshotFile: join(root, 'state.json') } });
    assert.equal(registration.state.events.length, 1);
    registration.dispose();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
