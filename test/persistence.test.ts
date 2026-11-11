import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import test, { type TestContext } from 'node:test';
import { createClankersPersistenceManager } from '../persistence.js';
import { createClankersState, createClankersStateContainer } from '../state.js';

const first = () => new Date('2026-10-03T00:00:00.000Z');
const second = () => new Date('2026-10-03T00:00:01.000Z');
function fixture(t: TestContext) {
  const root = fs.mkdtempSync(join(tmpdir(), 'clankers-persistence-test-'));
  const path = join(root, 'state.json');
  const manager = createClankersPersistenceManager({ snapshotFile: path })!;
  const state = createClankersState({ extensions: { ownedFixture: 'saved' } });
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, path, manager, state, temps: () => fs.readdirSync(root).filter((name) => name.endsWith('.tmp')) };
}
function link(t: TestContext, target: string, path: string): boolean {
  try { fs.symlinkSync(target, path); return true; } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('This Windows host does not permit creating fixture symlinks.'); return false;
    }
    throw error;
  }
}

test('regular snapshot round-trip uses the verified descriptor and truthful saved/loaded metadata', (t) => {
  const f = fixture(t);
  const saved = f.manager.save(f.state, first);
  assert.equal(saved.lastSavedAt, first().toISOString());
  const originalRead = fs.readSync;
  let reads = 0;
  t.mock.method(fs, 'readSync', (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
    assert.equal(typeof fd, 'number'); assert.ok(length <= 64 * 1024); reads++;
    return originalRead(fd, buffer, offset, length, position);
  });
  t.mock.method(fs, 'readFileSync', () => { throw new Error('unbounded read forbidden'); });
  syncBuiltinESMExports();
  const container = createClankersStateContainer();
  const loaded = f.manager.hydrate(container, second);
  assert.ok(reads >= 2);
  assert.equal(loaded.lastLoadError, undefined);
  assert.ok(loaded.lastLoadedAt);
  assert.equal(container.read().extensions.ownedFixture, 'saved');
  assert.deepEqual(loaded.recoveredRunIds, []);
  assert.deepEqual(f.temps(), []);
});

test('missing/corrupt/unsupported/directory snapshots preserve current state and report load failures honestly', (t) => {
  const f = fixture(t), container = createClankersStateContainer({ extensions: { ownedFixture: 'current' } });
  const before = container.read();
  assert.equal(f.manager.hydrate(container).lastLoadError, undefined);
  for (const bytes of ['{broken', JSON.stringify({ version: 2, state: {} })]) {
    fs.writeFileSync(f.path, bytes);
    const info = f.manager.hydrate(container);
    assert.ok(info.lastLoadError); assert.equal(info.lastLoadedAt, undefined);
    assert.deepEqual(container.read(), before);
  }
  fs.unlinkSync(f.path); fs.mkdirSync(f.path);
  assert.match(f.manager.hydrate(container).lastLoadError!, /regular file/);
  assert.deepEqual(container.read(), before);
});

test('valid regular-target symlinks load; saving replaces link without altering target; dangling stays missing', (t) => {
  const f = fixture(t), target = join(f.root, 'target.json');
  f.manager.save(f.state, first); fs.renameSync(f.path, target);
  if (!link(t, target, f.path)) return;
  const bytes = fs.readFileSync(target), container = createClankersStateContainer();
  assert.equal(f.manager.hydrate(container).lastLoadError, undefined);
  assert.equal(container.read().extensions.ownedFixture, 'saved');
  f.manager.save(createClankersState({ extensions: { ownedFixture: 'new' } }), second);
  assert.ok(fs.lstatSync(f.path).isFile()); assert.deepEqual(fs.readFileSync(target), bytes);
  fs.unlinkSync(f.path); fs.unlinkSync(target); if (!link(t, target, f.path)) return;
  const before = container.read(), missing = f.manager.hydrate(container);
  assert.equal(missing.lastLoadError, undefined); assert.equal(missing.lastLoadedAt, undefined);
  assert.deepEqual(container.read(), before);
});

test('nonregular admission rejects a FIFO-shaped stat without opening or reading (portable, no mkfifo dependency)', (t) => {
  const f = fixture(t);
  f.manager.save(f.state, first);
  const stat = fs.lstatSync(f.path);
  t.mock.method(fs, 'statSync', () => Object.assign(stat, { isFile: () => false, isFIFO: () => true }));
  const open = t.mock.method(fs, 'openSync', () => { throw new Error('nonregular open must not occur'); });
  const read = t.mock.method(fs, 'readSync', () => { throw new Error('nonregular read must not occur'); });
  syncBuiltinESMExports();
  assert.match(f.manager.hydrate(createClankersStateContainer()).lastLoadError!, /regular file/);
  assert.equal(open.mock.callCount(), 0); assert.equal(read.mock.callCount(), 0);
});

test('open uses nonblocking where available; descriptor type or inode drift rejects before reading and closes', (t) => {
  const f = fixture(t); f.manager.save(f.state, first);
  const originalOpen = fs.openSync, originalStat = fs.fstatSync;
  let descriptor = -1, nonregular = true;
  t.mock.method(fs, 'openSync', (path: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
    assert.equal(path, f.path); assert.equal(typeof flags, 'number');
    for (const flag of [fs.constants.O_NONBLOCK]) {
      if (flag) assert.equal((flags as number) & flag, flag);
    }
    return descriptor = originalOpen(path, flags, mode);
  });
  t.mock.method(fs, 'fstatSync', (fd: number) => {
    const stat = originalStat(fd);
    return nonregular ? Object.assign(stat, { isFile: () => false }) : Object.assign(stat, { ino: stat.ino + 1 });
  });
  const read = t.mock.method(fs, 'readSync', () => { throw new Error('drifted descriptor must not be read'); });
  syncBuiltinESMExports();
  for (const drift of [true, false]) {
    nonregular = drift;
    const container = createClankersStateContainer(), before = container.read();
    assert.match(f.manager.hydrate(container).lastLoadError!, /changed before reading/);
    assert.deepEqual(container.read(), before);
    assert.throws(() => originalStat(descriptor), { code: 'EBADF' });
  }
  assert.equal(read.mock.callCount(), 0);
});

test('read/parse errors close the snapshot descriptor without claiming successful hydration', (t) => {
  const f = fixture(t); fs.writeFileSync(f.path, '{broken');
  const originalOpen = fs.openSync;
  let descriptor = -1;
  t.mock.method(fs, 'openSync', (path: fs.PathLike, flags: string | number, mode?: fs.Mode) => descriptor = originalOpen(path, flags, mode));
  syncBuiltinESMExports();
  const container = createClankersStateContainer(), before = container.read();
  assert.ok(f.manager.hydrate(container).lastLoadError);
  assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
  t.mock.method(fs, 'readSync', () => { throw new Error('owned read fault'); }); syncBuiltinESMExports();
  assert.match(f.manager.hydrate(container).lastLoadError!, /owned read fault/);
  assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
  assert.deepEqual(container.read(), before); assert.equal(f.manager.info.lastLoadedAt, undefined);
});

test('exclusive temp creation preserves pre-existing regular collisions and prior snapshot/info', (t) => {
  const f = fixture(t); f.manager.save(f.state, first);
  const original = fs.readFileSync(f.path), previousInfo = f.manager.info;
  const stamp = 1234567890000, temp = `${f.path}.${process.pid}.${stamp.toString(36)}.tmp`;
  fs.writeFileSync(temp, 'owned collision'); t.mock.method(Date, 'now', () => stamp);
  assert.throws(() => f.manager.save(f.state, second), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(temp, 'utf8'), 'owned collision');
  assert.deepEqual(fs.readFileSync(f.path), original); assert.deepEqual(f.manager.info, previousInfo);
});

test('predicted-temp symlink cannot clobber its target, become the snapshot, or be deleted as cleanup', (t) => {
  const f = fixture(t); f.manager.save(f.state, first);
  const original = fs.readFileSync(f.path), previousInfo = f.manager.info;
  const stamp = 1234567890000, temp = `${f.path}.${process.pid}.${stamp.toString(36)}.tmp`, target = join(f.root, 'sentinel');
  fs.writeFileSync(target, 'owned sentinel'); if (!link(t, target, temp)) return;
  t.mock.method(Date, 'now', () => stamp);
  assert.throws(() => f.manager.save(f.state, second), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(target, 'utf8'), 'owned sentinel'); assert.ok(fs.lstatSync(temp).isSymbolicLink());
  assert.ok(fs.lstatSync(f.path).isFile()); assert.deepEqual(fs.readFileSync(f.path), original);
  assert.deepEqual(f.manager.info, previousInfo);
});

test('partial write failures close and remove only the newly created temp while preserving prior snapshot/info', (t) => {
  const f = fixture(t); f.manager.save(f.state, first);
  const original = fs.readFileSync(f.path), previousInfo = f.manager.info;
  let descriptor = -1;
  t.mock.method(fs, 'writeFileSync', (fd: fs.PathOrFileDescriptor) => {
    assert.equal(typeof fd, 'number'); descriptor = fd as number;
    fs.writeSync(descriptor, 'partial owned envelope'); throw new Error('owned partial write fault');
  }); syncBuiltinESMExports();
  assert.throws(() => f.manager.save(f.state, second), /owned partial write fault/);
  assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
  assert.deepEqual(f.temps(), []); assert.deepEqual(fs.readFileSync(f.path), original);
  assert.deepEqual(f.manager.info, previousInfo);
});

test('rename failures clean up the temp and preserve previous successful metadata; directory destinations stay intact', (t) => {
  const f = fixture(t); f.manager.save(f.state, first);
  const original = fs.readFileSync(f.path), previousInfo = f.manager.info;
  t.mock.method(fs, 'renameSync', () => { throw new Error('owned rename fault'); }); syncBuiltinESMExports();
  assert.throws(() => f.manager.save(f.state, second), /owned rename fault/);
  assert.deepEqual(f.temps(), []); assert.deepEqual(fs.readFileSync(f.path), original);
  assert.deepEqual(f.manager.info, previousInfo);
  t.mock.restoreAll(); syncBuiltinESMExports(); fs.unlinkSync(f.path); fs.mkdirSync(f.path);
  assert.throws(() => f.manager.save(f.state, second)); assert.ok(fs.lstatSync(f.path).isDirectory());
  assert.deepEqual(f.temps(), []); assert.deepEqual(f.manager.info, previousInfo);
});

test('close failure still attempts close/cleanup and never publishes saved metadata', (t) => {
  const f = fixture(t), originalClose = fs.closeSync;
  let descriptor = -1, calls = 0;
  t.mock.method(fs, 'closeSync', (fd: number) => {
    descriptor = fd; if (++calls === 1) throw new Error('owned close fault'); originalClose(fd);
  }); syncBuiltinESMExports();
  assert.throws(() => f.manager.save(f.state, first), /owned close fault/);
  assert.equal(calls, 2); assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
  assert.deepEqual(f.temps(), []); assert.equal(fs.existsSync(f.path), false);
  assert.equal(f.manager.info.lastSavedAt, undefined);
});

test('unavoidable cleanup failures expose both errors rather than reporting a save or concealing residue', (t) => {
  const f = fixture(t);
  t.mock.method(fs, 'renameSync', () => { throw new Error('owned rename fault'); });
  t.mock.method(fs, 'unlinkSync', () => { throw new Error('owned cleanup fault'); }); syncBuiltinESMExports();
  assert.throws(() => f.manager.save(f.state, first), (error: unknown) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors.map((entry: Error) => entry.message), ['owned rename fault', 'owned cleanup fault']); return true;
  });
  assert.equal(f.temps().length, 1); assert.equal(f.manager.info.lastSavedAt, undefined);
});

test('mkdir failure does not create temps or touch the blocking sentinel', (t) => {
  const f = fixture(t), blocked = join(f.root, 'blocked'); fs.writeFileSync(blocked, 'owned sentinel');
  const manager = createClankersPersistenceManager({ snapshotFile: join(blocked, 'state.json') })!;
  assert.throws(() => manager.save(f.state, first));
  assert.equal(fs.readFileSync(blocked, 'utf8'), 'owned sentinel'); assert.deepEqual(f.temps(), []);
  assert.equal(manager.info.lastSavedAt, undefined);
});

const limit = 64 * 1024 * 1024;

test('recovery never disables current readOnly and also retains saved readOnly', (t) => {
  const f = fixture(t);
  for (const saved of [undefined, false, true]) {
    for (const current of [undefined, false, true]) {
      const state = createClankersState(); state.mode.readOnly = saved;
      f.manager.save(state, first);
      const seed = createClankersState(); seed.mode.readOnly = current;
      const container = createClankersStateContainer(seed);
      assert.equal(f.manager.hydrate(container).lastLoadError, undefined);
      assert.equal(container.read().mode.readOnly, current === true ? true : saved);
    }
  }
});

test('symlinks to nonregular targets are rejected; regular-target swap is rejected and descriptor closed', (t) => {
  const f = fixture(t), target = join(f.root, 'target'); fs.mkdirSync(target);
  if (!link(t, target, f.path)) return;
  const container = createClankersStateContainer(), before = container.read();
  assert.match(f.manager.hydrate(container).lastLoadError!, /regular file/);
  assert.deepEqual(container.read(), before);
  fs.rmdirSync(target); f.manager.save(f.state, first); fs.renameSync(f.path, target);
  if (!link(t, target, f.path)) return;
  const other = join(f.root, 'other'); fs.copyFileSync(target, other);
  const open = fs.openSync; let descriptor = -1;
  t.mock.method(fs, 'openSync', (path: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
    fs.unlinkSync(f.path); fs.symlinkSync(other, f.path);
    return descriptor = open(path, flags, mode);
  }); syncBuiltinESMExports();
  assert.match(f.manager.hydrate(container).lastLoadError!, /changed before reading/);
  assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' });
  assert.deepEqual(container.read(), before);
});

test('oversized sparse snapshot is refused before open/read, preserving its bytes and current state', (t) => {
  const f = fixture(t), fd = fs.openSync(f.path, 'wx');
  fs.writeSync(fd, 'owned oversized sentinel'); fs.ftruncateSync(fd, limit + 1); fs.closeSync(fd);
  const container = createClankersStateContainer(), before = container.read();
  const open = t.mock.method(fs, 'openSync', () => { throw new Error('oversized must not open'); });
  const read = t.mock.method(fs, 'readSync', () => { throw new Error('oversized must not read'); });
  syncBuiltinESMExports();
  const info = f.manager.hydrate(container);
  assert.match(info.lastLoadError!, /64 MiB UTF-8 byte limit/); assert.equal(info.lastLoadedAt, undefined);
  assert.equal(open.mock.callCount(), 0); assert.equal(read.mock.callCount(), 0);
  assert.equal(fs.statSync(f.path).size, limit + 1); assert.deepEqual(container.read(), before);
  t.mock.restoreAll(); syncBuiltinESMExports();
  const check = fs.openSync(f.path, 'r'), head = Buffer.alloc(24), tail = Buffer.alloc(1);
  try {
    fs.readSync(check, head, 0, head.length, 0); fs.readSync(check, tail, 0, 1, limit);
    assert.equal(head.toString(), 'owned oversized sentinel'); assert.equal(tail[0], 0);
  } finally { fs.closeSync(check); }
});

test('64 MiB stat boundary admits equality; descriptor growth before/after read refuses and closes', (t) => {
  const f = fixture(t); f.manager.save(f.state, first);
  const stat = fs.statSync, fstat = fs.fstatSync, open = fs.openSync;
  let size = limit, phase = 'equal', checks = 0, descriptor = -1;
  t.mock.method(fs, 'statSync', (path: fs.PathLike) => Object.assign(stat(path), { size: limit }));
  t.mock.method(fs, 'openSync', (path: fs.PathLike, flags: string | number, mode?: fs.Mode) => descriptor = open(path, flags, mode));
  t.mock.method(fs, 'fstatSync', (fd: number) => Object.assign(fstat(fd), { size: phase === 'after' && ++checks === 1 ? limit : size }));
  syncBuiltinESMExports();
  assert.equal(f.manager.hydrate(createClankersStateContainer()).lastLoadError, undefined);
  for (const when of ['before', 'after']) {
    phase = when; size = limit + 1; checks = 0;
    const container = createClankersStateContainer(), before = container.read();
    assert.match(f.manager.hydrate(container).lastLoadError!, /64 MiB/);
    assert.throws(() => fstat(descriptor), { code: 'EBADF' }); assert.deepEqual(container.read(), before);
  }
});

test('growth while reading consumes at most 64 MiB plus one sentinel byte without large test allocations', (t) => {
  const f = fixture(t); f.manager.save(f.state, first);
  const open = fs.openSync; let descriptor = -1, consumed = 0, decodes = 0;
  t.mock.method(fs, 'openSync', (path: fs.PathLike, flags: string | number, mode?: fs.Mode) => descriptor = open(path, flags, mode));
  t.mock.method(fs, 'readSync', (fd: number, buffer: Buffer, offset: number, length: number, position: null) => {
    assert.equal(fd, descriptor); assert.equal(buffer.length, 64 * 1024); assert.equal(offset, 0); assert.equal(position, null);
    assert.equal(length, Math.min(64 * 1024, limit - consumed + 1)); consumed += length; return length;
  });
  // Virtual byte counts exercise the production loop; no 64 MiB text is allocated.
  t.mock.method(StringDecoder.prototype, 'write', () => { decodes++; return ''; });
  syncBuiltinESMExports();
  const container = createClankersStateContainer(), before = container.read();
  assert.match(f.manager.hydrate(container).lastLoadError!, /64 MiB/);
  assert.equal(consumed, limit + 1); assert.equal(decodes, limit / (64 * 1024));
  assert.throws(() => fs.fstatSync(descriptor), { code: 'EBADF' }); assert.deepEqual(container.read(), before);
});

test('UTF-8 decoding preserves multi-byte characters split across bounded reads', (t) => {
  const f = fixture(t), value = '🙂漢é'.repeat(8);
  f.manager.save(createClankersState({ extensions: { ownedFixture: value } }), first);
  const read = fs.readSync;
  t.mock.method(fs, 'readSync', (fd: number, buffer: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => read(fd, buffer, offset, Math.min(length, 1), position));
  syncBuiltinESMExports();
  const container = createClankersStateContainer(); assert.equal(f.manager.hydrate(container).lastLoadError, undefined);
  assert.equal(container.read().extensions.ownedFixture, value);
});

test('save uses serialized UTF-8 bytes including newline; equality allowed, oversize refused before mkdir/temp', (t) => {
  const f = fixture(t), state = createClankersState({ extensions: { ownedFixture: '🙂漢é' } });
  const byteLength = Buffer.byteLength; let reported = limit, measured = 0, chars = 0;
  t.mock.method(Buffer, 'byteLength', (value: string, encoding?: BufferEncoding) => {
    assert.equal(encoding, 'utf8'); assert.ok(value.endsWith('\n')); assert.equal(JSON.parse(value).state.extensions.ownedFixture, '🙂漢é');
    measured = byteLength(value, encoding); chars = value.length; return reported;
  });
  f.manager.save(state, first); assert.ok(measured > chars);
  const bytes = fs.readFileSync(f.path), previous = f.manager.info; reported = limit + 1;
  const mkdir = t.mock.method(fs, 'mkdirSync', () => { throw new Error('oversize must not mkdir'); });
  const open = t.mock.method(fs, 'openSync', () => { throw new Error('oversize must not create temp'); });
  syncBuiltinESMExports();
  assert.throws(() => f.manager.save(state, second), /64 MiB UTF-8 byte limit/);
  assert.equal(mkdir.mock.callCount(), 0); assert.equal(open.mock.callCount(), 0);
  assert.deepEqual(f.manager.info, previous); assert.deepEqual(f.temps(), []);
  t.mock.restoreAll(); syncBuiltinESMExports(); assert.deepEqual(fs.readFileSync(f.path), bytes);
});
