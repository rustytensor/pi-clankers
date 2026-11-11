import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createClankersPersistenceManager, type RecoveryWriterOwnerEvidence } from '../persistence.js';
import { createClankersState, createClankersStateContainer } from '../state.js';

const first = () => new Date('2026-10-04T00:00:00.000Z');
const second = () => new Date('2026-10-04T00:00:01.000Z');

function fixture(t: TestContext, cleanup = true) {
  const root = fs.mkdtempSync(join(tmpdir(), 'clankers-recovery-persistence-'));
  const snapshotFile = join(root, 'state.json');
  const manager = createClankersPersistenceManager({ snapshotFile })!;
  const state = createClankersState({ extensions: { marker: 'initial' } });
  if (cleanup) t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, snapshotFile, manager, state, lockDir: `${snapshotFile}.recovery-writer.lock` };
}
function sha(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
function emptyHash(): string { return sha(''); }

test('actual terminated writer remains inert and a fresh manager requires explicit exact takeover', { timeout: 15000 }, async (t) => {
  const f = fixture(t, false);
  const source = `
    import { createClankersPersistenceManager } from ${JSON.stringify(new URL('../persistence.ts', import.meta.url).href)};
    import { createClankersState } from ${JSON.stringify(new URL('../state.ts', import.meta.url).href)};
    const manager = createClankersPersistenceManager({ snapshotFile: process.argv[1] });
    const ownership = manager.acquireRecoveryOwnership();
    manager.commitRecoverySnapshot(createClankersState({ extensions: { crashProbe: 'durable-intent' } }));
    process.stdout.write(JSON.stringify(ownership.owner) + '\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source, f.snapshotFile], { env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let output = '', diagnostic = '';
  child.stdout.on('data', (bytes: Buffer) => { output += bytes.toString('utf8'); if (output.length > 16384) child.kill('SIGKILL'); });
  child.stderr.on('data', (bytes: Buffer) => { diagnostic = (diagnostic + bytes.toString('utf8')).slice(-4096); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    t.mock.restoreAll(); syncBuiltinESMExports();
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('owned writer probe deadline')); }, 10000);
    const receive = () => { if (output.includes('\n')) { clearTimeout(deadline); child.stdout.off('data', receive); resolve(); } };
    child.stdout.on('data', receive);
    child.once('exit', () => { clearTimeout(deadline); if (!output.includes('\n')) reject(new Error(`owned writer probe exited before publication: ${diagnostic}`)); });
    receive();
  });
  const oldOwner = JSON.parse(output.trim()) as RecoveryWriterOwnerEvidence;
  assert.equal(oldOwner.pid, child.pid);
  assert.equal(JSON.parse(fs.readFileSync(f.snapshotFile, 'utf8')).state.extensions.crashProbe, 'durable-intent');
  child.kill('SIGKILL');
  await closed;
  const before = fs.readFileSync(f.snapshotFile);
  const restarted = createClankersPersistenceManager({ snapshotFile: f.snapshotFile })!;
  const container = createClankersStateContainer();
  restarted.hydrate(container);
  assert.equal(container.read().extensions.crashProbe, 'durable-intent');
  assert.deepEqual(fs.readFileSync(f.snapshotFile), before, 'fresh hydrate cannot replay or rewrite evidence');
  assert.throws(() => restarted.save(f.state), /outstanding recovery writer ownership/);
  const ownership = restarted.acquireRecoveryOwnership!({ expectedSnapshotHash: sha(before), verifiedDeadOwner: oldOwner });
  restarted.commitRecoverySnapshot!(createClankersState({ extensions: { crashProbe: 'explicit-new-owner' } }));
  restarted.releaseRecoveryOwnership!(ownership.owner);
  assert.equal(JSON.parse(fs.readFileSync(f.snapshotFile, 'utf8')).state.extensions.crashProbe, 'explicit-new-owner');
});

test('recovery ownership is explicit and generic saves respect a competing owner', (t) => {
  const f = fixture(t);
  const owner = f.manager.acquireRecoveryOwnership!({ expectedSnapshotHash: emptyHash() });
  assert.ok(owner.owner.generation);
  assert.ok(fs.lstatSync(f.lockDir).isDirectory());

  const competitor = createClankersPersistenceManager({ snapshotFile: f.snapshotFile })!;
  assert.throws(() => competitor.save(f.state, first), /outstanding recovery writer ownership/);
  assert.throws(() => competitor.acquireRecoveryOwnership!({ expectedSnapshotHash: emptyHash() }), /explicit verified-dead owner evidence/);

  const info = f.manager.commitRecoverySnapshot!(f.state, { expectedSnapshotHash: emptyHash(), now: first });
  assert.equal(info.lastSavedAt, first().toISOString());
  assert.equal(JSON.parse(fs.readFileSync(f.snapshotFile, 'utf8')).state.extensions.marker, 'initial');
});

test('intent/commit write failure poisons the manager and preserves the lock evidence', (t) => {
  const f = fixture(t);
  f.manager.acquireRecoveryOwnership!({ expectedSnapshotHash: emptyHash() });
  t.mock.method(fs, 'writeFileSync', () => { throw new Error('intent save fault'); });
  syncBuiltinESMExports();
  assert.throws(() => f.manager.commitRecoverySnapshot!(f.state, { expectedSnapshotHash: emptyHash(), now: first }), /poisoned|intent save fault/);
  assert.throws(() => f.manager.save(f.state, second), /poisoned/);
  assert.ok(fs.lstatSync(f.lockDir).isDirectory());
});

test('post-rename fsync uncertainty poisons rather than retrying or publishing later work', (t) => {
  const f = fixture(t);
  f.manager.acquireRecoveryOwnership!({ expectedSnapshotHash: emptyHash() });
  const realFsync = fs.fsyncSync;
  let calls = 0;
  t.mock.method(fs, 'fsyncSync', (fd: number) => {
    calls += 1;
    if (calls >= 2) throw new Error('directory fsync uncertain');
    return realFsync(fd);
  });
  syncBuiltinESMExports();
  assert.throws(() => f.manager.commitRecoverySnapshot!(f.state, { expectedSnapshotHash: emptyHash(), now: first }), /poisoned|uncertain|directory fsync uncertain/);
  assert.ok(fs.existsSync(f.snapshotFile), 'rename may already have published bytes');
  assert.throws(() => f.manager.commitRecoverySnapshot!(f.state, { expectedSnapshotHash: sha(fs.readFileSync(f.snapshotFile)), now: second }), /poisoned/);
});

test('snapshot generation mismatch blocks and poisons before overwrite', (t) => {
  const f = fixture(t);
  f.manager.save(f.state, first);
  const expected = sha(fs.readFileSync(f.snapshotFile));
  const owned = f.manager.acquireRecoveryOwnership!({ expectedSnapshotHash: expected });
  fs.writeFileSync(f.snapshotFile, 'external generation');
  assert.throws(() => f.manager.commitRecoverySnapshot!(createClankersState({ extensions: { marker: 'next' } }), { expectedSnapshotHash: expected, now: second }), /head hash changed/);
  assert.equal(fs.readFileSync(f.snapshotFile, 'utf8'), 'external generation');
  assert.throws(() => f.manager.releaseRecoveryOwnership!(owned.owner), /poisoned/);
});

test('missing or unsafe ownership evidence blocks takeover rather than deleting retained evidence', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.lockDir, { mode: 0o700 });
  assert.throws(() => createClankersPersistenceManager({ snapshotFile: f.snapshotFile })!.acquireRecoveryOwnership!({ expectedSnapshotHash: emptyHash(), verifiedDeadOwner: {
    bootId: '00000000-0000-0000-0000-000000000000', pid: 999999, startTimeTicks: '1', writerSessionId: 'old', generation: '0'.repeat(32),
  } }), /missing|invalid|too large|unsupported/);
  assert.ok(fs.lstatSync(f.lockDir).isDirectory());

  fs.writeFileSync(join(f.lockDir, 'owner.json'), '{bad', { mode: 0o600 });
  assert.throws(() => createClankersPersistenceManager({ snapshotFile: f.snapshotFile })!.acquireRecoveryOwnership!({ expectedSnapshotHash: emptyHash(), verifiedDeadOwner: {
    bootId: '00000000-0000-0000-0000-000000000000', pid: 999999, startTimeTicks: '1', writerSessionId: 'old', generation: '1'.repeat(32),
  } }), /JSON|unsupported|invalid/);
  assert.equal(fs.readFileSync(join(f.lockDir, 'owner.json'), 'utf8'), '{bad');
});

test('explicit verified-dead takeover is serialized by claim and does not accept PID-only proof', (t) => {
  const f = fixture(t);
  const oldOwner: RecoveryWriterOwnerEvidence = {
    bootId: '00000000-0000-0000-0000-000000000000', pid: 1, startTimeTicks: '1', writerSessionId: 'old-writer', generation: '2'.repeat(32),
  };
  fs.mkdirSync(f.lockDir, { mode: 0o700 });
  const lockStat = fs.statSync(f.lockDir);
  const marker = join(f.lockDir, 'owner.json');
  fs.writeFileSync(marker, `${JSON.stringify({ version: 1, owner: oldOwner })}\n`, { mode: 0o600 });
  const markerStat = fs.lstatSync(marker);
  const exactOwner = { ...oldOwner, lockDev: lockStat.dev, lockIno: lockStat.ino, markerDev: markerStat.dev, markerIno: markerStat.ino };
  fs.writeFileSync(marker, `${JSON.stringify({ version: 1, owner: exactOwner })}\n`);

  fs.mkdirSync(`${f.snapshotFile}.recovery-writer.claim`);
  assert.throws(() => f.manager.acquireRecoveryOwnership!({ expectedSnapshotHash: emptyHash(), verifiedDeadOwner: { ...exactOwner, startTimeTicks: '2' } }), /EEXIST|claim/);
  fs.rmdirSync(`${f.snapshotFile}.recovery-writer.claim`);

  const acquired = f.manager.acquireRecoveryOwnership!({ expectedSnapshotHash: emptyHash(), verifiedDeadOwner: exactOwner });
  assert.notEqual(acquired.owner.generation, exactOwner.generation);
});

test('explicit release verifies generation and lets another manager acquire', (t) => {
  const f = fixture(t);
  const acquired = f.manager.acquireRecoveryOwnership!({ expectedSnapshotHash: emptyHash() });
  assert.throws(() => f.manager.releaseRecoveryOwnership!({ ...acquired.owner, generation: '3'.repeat(32) }), /does not match/);
  f.manager.releaseRecoveryOwnership!(acquired.owner);
  assert.equal(fs.existsSync(f.lockDir), false);
  const next = createClankersPersistenceManager({ snapshotFile: f.snapshotFile })!.acquireRecoveryOwnership!({ expectedSnapshotHash: emptyHash() });
  assert.ok(next.owner.generation);
});

test('owned legacy save is serialized by claim and advances recovery expected hash', (t) => {
  const f = fixture(t);
  const acquired = f.manager.acquireRecoveryOwnership!({ expectedSnapshotHash: emptyHash() });
  const saved = f.manager.save(createClankersState({ extensions: { marker: 'owned-save' } }), first);
  assert.equal(saved.lastSavedAt, first().toISOString());
  assert.equal(JSON.parse(fs.readFileSync(f.snapshotFile, 'utf8')).state.extensions.marker, 'owned-save');
  const committed = f.manager.commitRecoverySnapshot!(createClankersState({ extensions: { marker: 'after-owned-save' } }), { now: second });
  assert.equal(committed.lastSavedAt, second().toISOString());
  assert.equal(JSON.parse(fs.readFileSync(f.snapshotFile, 'utf8')).state.extensions.marker, 'after-owned-save');
  f.manager.releaseRecoveryOwnership!(acquired.owner);
});

test('generic save contention uses adjacent claim for the whole critical section', (t) => {
  const f = fixture(t);
  fs.mkdirSync(`${f.snapshotFile}.recovery-writer.claim`);
  assert.throws(() => f.manager.save(f.state, first), /EEXIST|claim/);
  fs.rmdirSync(`${f.snapshotFile}.recovery-writer.claim`);
  f.manager.save(f.state, second);
  assert.equal(JSON.parse(fs.readFileSync(f.snapshotFile, 'utf8')).savedAt, second().toISOString());
});

test('incomplete locks, extra lock contents, symlink locks, and replaced dirs remain blocked', (t) => {
  const f = fixture(t);
  const dead: RecoveryWriterOwnerEvidence = {
    bootId: '00000000-0000-0000-0000-000000000000', pid: 999999, startTimeTicks: '1', writerSessionId: 'old', generation: '4'.repeat(32),
  };
  fs.mkdirSync(f.lockDir, { mode: 0o700 });
  assert.throws(() => f.manager.acquireRecoveryOwnership!({ expectedSnapshotHash: emptyHash(), verifiedDeadOwner: dead }), /missing|invalid|too large/);
  fs.writeFileSync(join(f.lockDir, 'extra'), 'retained');
  assert.throws(() => f.manager.acquireRecoveryOwnership!({ expectedSnapshotHash: emptyHash(), verifiedDeadOwner: dead }), /missing|invalid|too large/);
  fs.rmSync(f.lockDir, { recursive: true, force: true });
  fs.symlinkSync('elsewhere', f.lockDir);
  assert.throws(() => f.manager.acquireRecoveryOwnership!({ expectedSnapshotHash: emptyHash(), verifiedDeadOwner: dead }), /EEXIST|not a directory|ENOENT/);
});

test('recovery hashing rejects growing or replaced snapshot files', (t) => {
  const f = fixture(t);
  f.manager.save(f.state, first);
  const expected = sha(fs.readFileSync(f.snapshotFile));
  const acquired = f.manager.acquireRecoveryOwnership!({ expectedSnapshotHash: expected });
  const original = fs.readSync;
  let replaced = false;
  t.mock.method(fs, 'readSync', (...args: Parameters<typeof fs.readSync>) => {
    const count = original(...args);
    if (!replaced && typeof args[0] === 'number') {
      replaced = true;
      fs.writeFileSync(f.snapshotFile, 'replacement');
    }
    return count;
  });
  syncBuiltinESMExports();
  assert.throws(() => f.manager.commitRecoverySnapshot!(f.state, { now: second }), /changed|poisoned/);
  assert.throws(() => f.manager.releaseRecoveryOwnership!(acquired.owner), /poisoned/);
});

test('first acquire creates missing snapshot parent without accepting ancestor symlinks', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'clankers-recovery-parent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const missingParentSnapshot = join(root, 'missing', 'nested', 'state.json');
  const manager = createClankersPersistenceManager({ snapshotFile: missingParentSnapshot })!;
  const acquired = manager.acquireRecoveryOwnership!({ expectedSnapshotHash: emptyHash() });
  assert.ok(fs.lstatSync(join(root, 'missing', 'nested')).isDirectory());
  manager.releaseRecoveryOwnership!(acquired.owner);

  const real = join(root, 'real');
  fs.mkdirSync(real);
  const link = join(root, 'link');
  fs.symlinkSync(real, link);
  const symlinkManager = createClankersPersistenceManager({ snapshotFile: join(link, 'state.json') })!;
  assert.throws(() => symlinkManager.acquireRecoveryOwnership!({ expectedSnapshotHash: emptyHash() }), /ancestor is not a directory/);
});

test('incomplete recovery lock blocks generic save without overwriting snapshot', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.snapshotFile, 'previous snapshot bytes');
  fs.mkdirSync(f.lockDir, { mode: 0o700 });
  assert.throws(() => f.manager.save(createClankersState({ extensions: { marker: 'new' } }), first), /missing|invalid|too large/);
  assert.equal(fs.readFileSync(f.snapshotFile, 'utf8'), 'previous snapshot bytes');
});

test('claim cleanup uncertainty poisons manager and preserves the cleanup error', (t) => {
  const f = fixture(t);
  const realRmdir = fs.rmdirSync;
  t.mock.method(fs, 'rmdirSync', (path: fs.PathLike) => {
    if (String(path).endsWith('.recovery-writer.claim')) throw new Error('claim cleanup fault');
    return realRmdir(path);
  });
  syncBuiltinESMExports();
  assert.throws(() => f.manager.save(f.state, first), /poisoned|claim cleanup fault/);
  assert.throws(() => f.manager.save(f.state, second), /poisoned|claim cleanup fault/);
});

test('owned commit does not accept a newer external expectedHash override', (t) => {
  const f = fixture(t);
  const acquired = f.manager.acquireRecoveryOwnership!({ expectedSnapshotHash: emptyHash() });
  fs.writeFileSync(f.snapshotFile, 'external generation');
  const newer = sha(fs.readFileSync(f.snapshotFile));
  assert.throws(() => f.manager.commitRecoverySnapshot!(createClankersState({ extensions: { marker: 'bad' } }), { expectedSnapshotHash: newer, now: first }), /owned recovery head|poisoned/);
  assert.equal(fs.readFileSync(f.snapshotFile, 'utf8'), 'external generation');
  assert.throws(() => f.manager.releaseRecoveryOwnership!(acquired.owner), /poisoned/);
});

test('ownership info is cloned and frozen so returned token mutation cannot alter internal owner', (t) => {
  const f = fixture(t);
  const acquired = f.manager.acquireRecoveryOwnership!({ expectedSnapshotHash: emptyHash() });
  assert.ok(Object.isFrozen(acquired));
  assert.ok(Object.isFrozen(acquired.owner));
  assert.throws(() => { (acquired.owner as { generation: string }).generation = '9'.repeat(32); }, /read only|Cannot assign/);
  const again = f.manager.acquireRecoveryOwnership!();
  assert.equal(again.owner.generation, acquired.owner.generation);
  assert.notEqual(again.owner, acquired.owner);
  f.manager.releaseRecoveryOwnership!(acquired.owner);
});

test('valid dead-owner lock with extra contents is retained and blocks takeover', (t) => {
  const f = fixture(t);
  const oldOwner: RecoveryWriterOwnerEvidence = {
    bootId: '00000000-0000-0000-0000-000000000000', pid: 999999, startTimeTicks: '1', writerSessionId: 'old-writer', generation: '5'.repeat(32),
  };
  fs.mkdirSync(f.lockDir, { mode: 0o700 });
  const lockStat = fs.lstatSync(f.lockDir);
  const marker = join(f.lockDir, 'owner.json');
  fs.writeFileSync(marker, `${JSON.stringify({ version: 1, owner: oldOwner })}\n`, { mode: 0o600 });
  const markerStat = fs.lstatSync(marker);
  const exactOwner = { ...oldOwner, lockDev: lockStat.dev, lockIno: lockStat.ino, markerDev: markerStat.dev, markerIno: markerStat.ino };
  fs.writeFileSync(marker, `${JSON.stringify({ version: 1, owner: exactOwner })}\n`);
  fs.writeFileSync(join(f.lockDir, 'extra'), 'retained');
  assert.throws(() => f.manager.acquireRecoveryOwnership!({ expectedSnapshotHash: emptyHash(), verifiedDeadOwner: exactOwner }), /retained evidence/);
  assert.equal(fs.readFileSync(join(f.lockDir, 'extra'), 'utf8'), 'retained');
});

test('invalid or missing owner start ticks block takeover instead of proving death', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.lockDir, { mode: 0o700 });
  const marker = join(f.lockDir, 'owner.json');
  const invalidOwner = {
    bootId: '00000000-0000-0000-0000-000000000000', pid: 999999, writerSessionId: 'old-writer', generation: '6'.repeat(32),
  };
  fs.writeFileSync(marker, `${JSON.stringify({ version: 1, owner: invalidOwner })}\n`, { mode: 0o600 });
  assert.throws(() => f.manager.acquireRecoveryOwnership!({ expectedSnapshotHash: emptyHash(), verifiedDeadOwner: invalidOwner as RecoveryWriterOwnerEvidence }), /invalid identity|start|unsupported/);
  assert.ok(fs.existsSync(marker));
});

test('stale hydrated manager cannot reset family after competitor save and lock release', (t) => {
  const f = fixture(t);
  f.manager.save(createClankersState({ extensions: { marker: 'source' } }), first);
  const stale = createClankersPersistenceManager({ snapshotFile: f.snapshotFile })!;
  stale.hydrate(createClankersStateContainer());

  const competitor = createClankersPersistenceManager({ snapshotFile: f.snapshotFile })!;
  const head = sha(fs.readFileSync(f.snapshotFile));
  const owned = competitor.acquireRecoveryOwnership!({ expectedSnapshotHash: head });
  competitor.commitRecoverySnapshot!(createClankersState({ extensions: { marker: 'selected-child' } }), { expectedSnapshotHash: head, now: second });
  competitor.releaseRecoveryOwnership!(owned.owner);

  assert.throws(() => stale.save(createClankersState({ extensions: { marker: 'stale-reset' } }), second), /stale observed snapshot head/);
  assert.equal(JSON.parse(fs.readFileSync(f.snapshotFile, 'utf8')).state.extensions.marker, 'selected-child');
});

test('changed head blocks recovery authorization even when caller supplies current disk hash', (t) => {
  const f = fixture(t);
  f.manager.save(f.state, first);
  const observed = sha(fs.readFileSync(f.snapshotFile));
  fs.writeFileSync(f.snapshotFile, 'newer external head');
  const current = sha(fs.readFileSync(f.snapshotFile));
  assert.throws(() => f.manager.acquireRecoveryOwnership!({ expectedSnapshotHash: current }), /manager observed snapshot head/);
  assert.throws(() => f.manager.acquireRecoveryOwnership!({ expectedSnapshotHash: observed }), /current snapshot head/);
  assert.equal(fs.readFileSync(f.snapshotFile, 'utf8'), 'newer external head');
});

test('inspect recovery ownership is read-only for missing parents and grants no owner', (t) => {
  const root = fs.mkdtempSync(join(tmpdir(), 'clankers-inspect-readonly-'));
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }); });
  const snapshotFile = join(root, 'missing', 'nested', 'state.json');
  const manager = createClankersPersistenceManager({ snapshotFile })!;
  t.mock.method(fs, 'mkdirSync', () => { throw new Error('inspect attempted mkdir'); });
  t.mock.method(fs, 'openSync', () => { throw new Error('inspect attempted open'); });
  t.mock.method(fs, 'writeFileSync', () => { throw new Error('inspect attempted write'); });
  t.mock.method(fs, 'renameSync', () => { throw new Error('inspect attempted rename'); });
  syncBuiltinESMExports();
  const inspected = manager.inspectRecoveryOwnership!();
  assert.equal(inspected.actualSnapshotHash, emptyHash());
  assert.equal(inspected.owner, undefined);
  assert.equal(inspected.ownerValid, false);
  assert.equal(inspected.claimPresent, false);
  assert.equal(fs.existsSync(join(root, 'missing')), false);
  assert.ok(Object.isFrozen(inspected));
});

test('inspect reports unsupported unsafe owner evidence without granting ownership', (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.lockDir, { mode: 0o700 });
  fs.writeFileSync(join(f.lockDir, 'owner.json'), `${JSON.stringify({ version: 2, owner: {} })}\n`, { mode: 0o600 });
  const inspected = f.manager.inspectRecoveryOwnership!();
  assert.equal(inspected.owner, undefined);
  assert.equal(inspected.ownerValid, false);
  assert.match(inspected.blocker ?? '', /unsupported|invalid|blocked/);
  assert.ok(fs.existsSync(f.lockDir));
  assert.throws(() => f.manager.releaseRecoveryOwnership!({
    bootId: '00000000-0000-0000-0000-000000000000', pid: 999999, startTimeTicks: '1', writerSessionId: 'none', generation: '7'.repeat(32),
  }), /does not match/);
});

test('generic saves replace final symlinks while recovery ownership stays strict', (t) => {
  const f = fixture(t);
  const target = join(f.root, 'target.json');
  f.manager.save(f.state, first);
  fs.renameSync(f.snapshotFile, target);
  fs.symlinkSync(target, f.snapshotFile);
  const container = createClankersStateContainer();
  assert.equal(f.manager.hydrate(container).lastLoadError, undefined);
  assert.equal(container.read().extensions.marker, 'initial');
  assert.throws(() => f.manager.acquireRecoveryOwnership!({ expectedSnapshotHash: sha(fs.readFileSync(target)) }), /regular file|ELOOP/);
  const targetBytes = fs.readFileSync(target);
  f.manager.save(createClankersState({ extensions: { marker: 'replacement' } }), second);
  assert.ok(fs.lstatSync(f.snapshotFile).isFile());
  assert.deepEqual(fs.readFileSync(target), targetBytes);

  fs.unlinkSync(f.snapshotFile);
  fs.mkdirSync(join(f.root, 'directory-target'));
  fs.symlinkSync(join(f.root, 'directory-target'), f.snapshotFile);
  const fresh = createClankersPersistenceManager({ snapshotFile: f.snapshotFile })!;
  fresh.save(createClankersState({ extensions: { marker: 'directory-link-replaced' } }), first);
  assert.ok(fs.lstatSync(f.snapshotFile).isFile());
  assert.equal(JSON.parse(fs.readFileSync(f.snapshotFile, 'utf8')).state.extensions.marker, 'directory-link-replaced');
});


test('explicit legacy save may replace unchanged invalid final symlink observed during hydrate load error', (t) => {
  const f = fixture(t);
  const targetDir = join(f.root, 'directory-target');
  fs.mkdirSync(targetDir);
  fs.symlinkSync(targetDir, f.snapshotFile);
  const manager = createClankersPersistenceManager({ snapshotFile: f.snapshotFile })!;
  const container = createClankersStateContainer();
  const hydrated = manager.hydrate(container);
  assert.match(hydrated.lastLoadError ?? '', /regular file/);
  assert.equal(fs.lstatSync(f.snapshotFile).isSymbolicLink(), true);
  const inspected = manager.inspectRecoveryOwnership!();
  assert.match(inspected.blocker ?? '', /observed load error|snapshot blocked/);
  assert.throws(() => manager.acquireRecoveryOwnership!(), /prior persistence load error/);

  manager.save(createClankersState({ extensions: { marker: 'legacy-replacement' } }), first);
  assert.ok(fs.lstatSync(f.snapshotFile).isFile());
  assert.ok(fs.lstatSync(targetDir).isDirectory(), 'replacement must not mutate symlink target directory');
  assert.equal(JSON.parse(fs.readFileSync(f.snapshotFile, 'utf8')).state.extensions.marker, 'legacy-replacement');
});

test('invalid-link legacy save is bound to the exact hydrated link evidence only', (t) => {
  const f = fixture(t);
  const originalTarget = join(f.root, 'original-directory-target');
  const changedTarget = join(f.root, 'changed-directory-target');
  fs.mkdirSync(originalTarget);
  fs.mkdirSync(changedTarget);
  fs.symlinkSync(originalTarget, f.snapshotFile);
  const manager = createClankersPersistenceManager({ snapshotFile: f.snapshotFile })!;
  manager.hydrate(createClankersStateContainer());
  fs.unlinkSync(f.snapshotFile);
  fs.symlinkSync(changedTarget, f.snapshotFile);
  assert.throws(() => manager.save(createClankersState({ extensions: { marker: 'stale-link' } }), first), /stale observed snapshot head|prior persistence load error/);
  assert.equal(fs.readlinkSync(f.snapshotFile), changedTarget);

  fs.unlinkSync(f.snapshotFile);
  fs.mkdirSync(f.snapshotFile);
  const plainDirectory = createClankersPersistenceManager({ snapshotFile: f.snapshotFile })!;
  plainDirectory.hydrate(createClankersStateContainer());
  assert.throws(() => plainDirectory.save(createClankersState({ extensions: { marker: 'plain-dir' } }), second), /regular file/);
  assert.ok(fs.lstatSync(f.snapshotFile).isDirectory());
});

test('acquire rejects prior load error and revalidates already-owned generation and expected value', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.snapshotFile, '{broken');
  const manager = createClankersPersistenceManager({ snapshotFile: f.snapshotFile })!;
  manager.hydrate(createClankersStateContainer());
  assert.throws(() => manager.acquireRecoveryOwnership!({ expectedSnapshotHash: sha(fs.readFileSync(f.snapshotFile)) }), /prior persistence load error/);

  fs.unlinkSync(f.snapshotFile);
  const clean = createClankersPersistenceManager({ snapshotFile: f.snapshotFile })!;
  const owned = clean.acquireRecoveryOwnership!({ expectedSnapshotHash: emptyHash() });
  assert.throws(() => clean.acquireRecoveryOwnership!({ expectedSnapshotHash: '1'.repeat(64) }), /owned recovery head|poisoned/);
  assert.throws(() => clean.releaseRecoveryOwnership!(owned.owner), /poisoned/);
});

test('inspection reports claim and observed blockers without creating ownership', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.snapshotFile, '{broken');
  f.manager.hydrate(createClankersStateContainer());
  fs.mkdirSync(`${f.snapshotFile}.recovery-writer.claim`);
  const inspected = f.manager.inspectRecoveryOwnership!();
  assert.equal(inspected.claimPresent, true);
  assert.equal(inspected.owner, undefined);
  assert.match(inspected.blocker ?? '', /observed load error|claim/);
});
