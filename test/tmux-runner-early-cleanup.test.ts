import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { createTmuxWorker, TmuxLaunchError, type TmuxLaunchOptions } from '../tmux-runner.js';

test('revocation immediately after mkdtemp leaves zero worker directories and children', async () => {
  const root = await fs.mkdtemp('/srv/devops/scratch/tmux-early-cleanup-');
  const original = { mkdtemp: fs.mkdtemp, rmdir: fs.rmdir, spawn: childProcess.spawn };
  let revoked = false, children = 0;
  childProcess.spawn = (() => { children++; throw new Error('Unexpected child'); }) as typeof childProcess.spawn;
  fs.mkdtemp = (async (...args: Parameters<typeof fs.mkdtemp>) => {
    const path = await original.mkdtemp(...args); revoked = true; return path;
  }) as typeof fs.mkdtemp;
  syncBuiltinESMExports();
  const check = async (base: string) => {
    revoked = false;
    let failure: unknown;
    try {
      await createTmuxWorker({ rootDir: base, agentDir: root, cwd: root,
        assertAdmission() { if (revoked) throw Object.assign(new Error('PRIVATE guard details'), { code: 'ENOENT' }); },
      } as TmuxLaunchOptions);
    } catch (error) { failure = error; }
    assert.ok(failure instanceof TmuxLaunchError);
    assert.equal(failure.message, 'Tmux worker launch failed.');
    assert.equal(children, 0);
    assert.deepEqual(await fs.readdir(base), []);
    assert.deepEqual(failure.cleanup, { closed: true, errors: [] });
  };
  try {
    await check(join(root, 'actual'));
    // Planted cleanup omission: the same zero-directory oracle must catch it.
    fs.rmdir = (async () => {}) as typeof fs.rmdir;
    syncBuiltinESMExports();
    await assert.rejects(check(join(root, 'fault')), assert.AssertionError);
  } finally {
    fs.mkdtemp = original.mkdtemp; fs.rmdir = original.rmdir; childProcess.spawn = original.spawn;
    syncBuiltinESMExports();
    await fs.rm(root, { recursive: true, force: true });
  }
});
