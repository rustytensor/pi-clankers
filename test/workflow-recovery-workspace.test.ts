import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, linkSync, chmodSync, existsSync, rmSync, unlinkSync, rmdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { captureCodingBaseline, createCodingWorkspace, inspectRetainedCodingWorkspaceManifest, WorkspaceEffectUncertaintyError, WorkspaceLeaseReleaseUncertaintyError } from '../workflow-workspace.js';

function dirs() {
  const root = mkdtempSync(join(tmpdir(), 'cw-proj-'));
  const staging = mkdtempSync(join(tmpdir(), 'cw-stage-'));
  return { root, staging };
}

function retainedScope(manifest: any, staging: string) {
  return { projectRoot: manifest.projectRoot, stagingParent: staging, workflowRunId: manifest.workflowRunId, allowedPaths: manifest.allowedPaths };
}

function file(root: string, path: string, text: string | Buffer) {
  const parts = path.split('/');
  let dir = root;
  for (const p of parts.slice(0, -1)) { dir = join(dir, p); mkdirSync(dir, { recursive: true }); }
  writeFileSync(join(root, path), text, { mode: 0o600 });
}

const skipWin = { skip: process.platform === 'win32' };

test('stage8c effect hooks fence stage writes and poison after-effect uncertainty', () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a');
  let before = 0;
  const ws1 = createCodingWorkspace({ workflowRunId: 's8c-before', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {}, effectHooks: { beforeEffect(intent) { before++; assert.equal(intent.kind, 'stage-write'); if (before === 2) throw new Error('save-before'); } } });
  assert.throws(() => ws1.write('a.txt', 'b'), /save-before/);
  assert.equal(ws1.read('a.txt'), 'a');

  const { root: r2, staging: s2 } = dirs(); file(r2, 'a.txt', 'a');
  let after = 0;
  const ws2 = createCodingWorkspace({ workflowRunId: 's8c-after', projectRoot: r2, stagingParent: s2, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {}, effectHooks: { afterEffect(observation) { after++; if (after === 2) { assert.equal(observation.status, 'observed'); throw new Error('save-after'); } } } });
  assert.throws(() => ws2.write('a.txt', 'b'), /afterEffect failed/);
  assert.throws(() => ws2.write('a.txt', 'c'), /uncertain/);
  assert.throws(() => ws2.cleanup(), /uncertain/);
  const manifest = ws2.recoveryManifest();
  assert.equal(manifest.effects.at(-1)?.status, 'uncertain');
  assert.equal(manifest.effects.at(-1)?.afterSaved, false);
});

test('stage8c destination hooks record per-file creations and poison after apply save failure without cleanup', () => {
  const { root, staging } = dirs(); mkdirSync(join(root, 'src')); file(root, 'src/a.txt', 'a'); file(root, 'src/b.txt', 'b');
  let afterDest = 0;
  const ws = createCodingWorkspace({ workflowRunId: 's8c-apply-after', projectRoot: root, stagingParent: staging, inputPaths: ['src/a.txt', 'src/b.txt', 'src/new.txt'], writablePaths: ['src/a.txt', 'src/b.txt', 'src/new.txt'], assertAuthority() {}, effectHooks: { afterEffect(o) { if (o.kind === 'destination-write' && ++afterDest === 2) throw new Error('durable-save-lost'); } } });
  ws.write('src/a.txt', 'aa'); ws.write('src/b.txt', 'bb'); ws.write('src/new.txt', 'new');
  const out = ws.apply(ws.inspect().hash);
  assert.equal(out.status, 'partial');
  assert.deepEqual(out.appliedPaths, ['src/a.txt']);
  assert.equal(readFileSync(join(root, 'src/a.txt'), 'utf8'), 'aa');
  assert.equal(readFileSync(join(root, 'src/b.txt'), 'utf8'), 'bb');
  assert.equal(existsSync(join(root, 'src/new.txt')), false);
  assert.throws(() => ws.cleanup(), /uncertain/);
  assert.equal(existsSync(ws.stageRoot), true);
  const createRecord = ws.recoveryManifest().effects.find((e) => e.kind === 'stage-write' && e.path === 'src/new.txt');
  assert.equal(createRecord?.preimageHash, null);
  assert.match(createRecord?.postimageHash ?? '', /^[0-9a-f]{64}$/);
});

test('stage8c retained manifest is immutable and classifies destinations without adopting or cleaning', () => {
  const { root, staging } = dirs(); file(root, 'pre.txt', 'pre'); file(root, 'post.txt', 'post'); file(root, 'conflict.txt', 'conflict'); mkdirSync(join(root, 'src'));
  const ws = createCodingWorkspace({ workflowRunId: 's8c-inspect', projectRoot: root, stagingParent: staging, inputPaths: ['pre.txt', 'post.txt', 'conflict.txt', 'src/new.txt'], writablePaths: ['pre.txt', 'post.txt', 'conflict.txt', 'src/new.txt'], assertAuthority() {} });
  ws.write('post.txt', 'POST'); ws.write('conflict.txt', 'CONFLICT'); ws.write('src/new.txt', 'NEW');
  const manifest = ws.recoveryManifest();
  assert.throws(() => ((manifest as any).version = 2), /read only|Cannot assign/);
  writeFileSync(join(root, 'post.txt'), 'POST');
  writeFileSync(join(root, 'conflict.txt'), 'other');
  writeFileSync(join(root, 'unrelated.txt'), 'leave-me');
  const inspection = inspectRetainedCodingWorkspaceManifest(manifest, retainedScope(manifest, staging));
  assert.equal(inspection.status, 'safe');
  const byPath = new Map(inspection.classifications.map((c) => [c.path, c.class]));
  assert.equal(byPath.get('pre.txt'), 'preimage');
  assert.equal(byPath.get('post.txt'), 'postimage');
  assert.equal(byPath.get('conflict.txt'), 'conflict');
  assert.equal(byPath.get('src/new.txt'), 'preimage');
  assert.equal(readFileSync(join(root, 'unrelated.txt'), 'utf8'), 'leave-me');
  assert.equal(existsSync(ws.stageRoot), true);
});

test('stage8c inspect rejects replaced unsafe artifacts and does not repair', () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a');
  const ws = createCodingWorkspace({ workflowRunId: 's8c-unsafe', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {} });
  const manifest = ws.recoveryManifest();
  unlinkSync(join(ws.stageRoot, '.coding-workspace-owner.json'));
  symlinkSync(join(root, 'a.txt'), join(ws.stageRoot, '.coding-workspace-owner.json'));
  const out = inspectRetainedCodingWorkspaceManifest(manifest, retainedScope(manifest, staging));
  assert.equal(out.status, 'unsafe');
  assert.match(out.error ?? '', /marker|symlink|identity/);
  assert.equal(existsSync(join(ws.stageRoot, '.coding-workspace-owner.json')), true);
});

test('stage8c retained inspect rejects raw absolute paths before trusting filesystem', () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a');
  const ws = createCodingWorkspace({ workflowRunId: 's8c-raw-scope', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {} });
  const raw: any = { ...ws.recoveryManifest(), projectRoot: '/tmp/not-trusted-project-root' };
  const out = inspectRetainedCodingWorkspaceManifest(raw, { projectRoot: root, stagingParent: staging, workflowRunId: 's8c-raw-scope', allowedPaths: ['a.txt'] });
  assert.equal(out.status, 'unsafe');
  assert.match(out.error ?? '', /trusted scope|baseline hash|identity|scope/i);
});

test('stage8c retained inspect rejects replaced marker and changed candidate bytes', () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a');
  const ws = createCodingWorkspace({ workflowRunId: 's8c-replaced-candidate', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {} });
  ws.write('a.txt', 'b');
  const manifest = ws.recoveryManifest();
  writeFileSync(join(ws.stageRoot, 'a.txt'), 'c');
  let out = inspectRetainedCodingWorkspaceManifest(manifest, retainedScope(manifest, staging));
  assert.equal(out.status, 'unsafe');
  assert.match(out.error ?? '', /content changed|identity changed/);
  writeFileSync(join(ws.stageRoot, 'a.txt'), 'b');
  unlinkSync(join(ws.stageRoot, '.coding-workspace-owner.json'));
  file(ws.stageRoot, '.coding-workspace-owner.json', JSON.stringify({ owner: 'other' }));
  out = inspectRetainedCodingWorkspaceManifest(manifest, retainedScope(manifest, staging));
  assert.equal(out.status, 'unsafe');
});

test('stage8c strict retained validation rejects malformed duplicate and oversize records', () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a');
  const ws = createCodingWorkspace({ workflowRunId: 's8c-strict', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {} });
  const manifest: any = ws.recoveryManifest();
  assert.equal(inspectRetainedCodingWorkspaceManifest({ ...manifest, version: 2 }, retainedScope(manifest, staging)).status, 'unsafe');
  assert.equal(inspectRetainedCodingWorkspaceManifest({ ...manifest, allowedPaths: ['a.txt', 'a.txt'] }, retainedScope(manifest, staging)).status, 'unsafe');
  assert.equal(inspectRetainedCodingWorkspaceManifest({ ...manifest, effects: Array.from({ length: 513 }, (_, i) => ({ ...manifest.effects[0], sequence: i + 1 })) }, retainedScope(manifest, staging)).status, 'unsafe');
  assert.equal(inspectRetainedCodingWorkspaceManifest({ ...manifest, inputPaths: Array.from({ length: 33 }, (_, i) => `x${i}.txt`) }, retainedScope(manifest, staging)).status, 'unsafe');
});

test('stage8c operation limit is enforced before preeffect and missing hooks do not claim durability', () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a');
  let before = 0;
  const ws = createCodingWorkspace({ workflowRunId: 's8c-oplimit', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {}, effectHooks: { beforeEffect() { before++; } } });
  for (let i = 0; i < 511; i++) ws.write('a.txt', `v${i}`);
  assert.throws(() => ws.write('a.txt', 'overflow'), /too many/);
  assert.equal(before, 512);
  const { root: root2, staging: staging2 } = dirs(); file(root2, 'a.txt', 'a');
  const noHooks = createCodingWorkspace({ workflowRunId: 's8c-nohooks', projectRoot: root2, stagingParent: staging2, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {} });
  assert.equal(noHooks.recoveryManifest().effects[0].beforeCalled, false);
  assert.equal(noHooks.recoveryManifest().effects[0].afterSaved, false);
});

test('stage8c initialization afterEffect uncertainty is retained', () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a');
  let stageRoot = '';
  assert.throws(() => createCodingWorkspace({ workflowRunId: 's8c-init-uncertain', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {}, effectHooks: { beforeEffect(i) { stageRoot = i.stageRoot; }, afterEffect(o) { if (o.kind === 'stage-write') throw new Error('save-lost'); } } }), /afterEffect failed/);
  assert.equal(existsSync(stageRoot), true);
  assert.equal(existsSync(join(stageRoot, '.coding-workspace-owner.json')), true);
});

test('stage8c staging preimage receipt uses current staged bytes', () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a');
  const ws = createCodingWorkspace({ workflowRunId: 's8c-stage-preimage', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {} });
  ws.write('a.txt', 'b'); ws.write('a.txt', 'c');
  const effects = ws.recoveryManifest().effects.filter((e) => e.kind === 'stage-write' && e.path === 'a.txt');
  assert.equal(effects.at(-1)?.preimageHash, effects.at(-2)?.postimageHash);
});


test('stage8c initializer afterEffect failure throws typed uncertainty with attribution and retains leases', () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a');
  let thrown: unknown;
  try {
    createCodingWorkspace({ workflowRunId: 's8c-init-typed', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {}, effectHooks: { afterEffect(o) { if (o.kind === 'stage-write') throw new Error('persist-lost'); } } });
  } catch (e) { thrown = e; }
  assert.ok(thrown instanceof WorkspaceEffectUncertaintyError);
  assert.equal(thrown.cleanupBlocked, true);
  assert.equal(thrown.generation, thrown.lastKnownManifest?.ownerGeneration);
  assert.equal(thrown.possibleEffect?.status, 'uncertain');
  assert.equal(thrown.possibleEffect?.path, 'a.txt');
  assert.equal(thrown.intendedScope.workflowRunId, 's8c-init-typed');
  assert.equal(existsSync(thrown.intendedScope.stageRoot), true);
  assert.equal(existsSync(join(thrown.intendedScope.stageRoot, '.coding-workspace-owner.json')), true);
  assert.throws(() => createCodingWorkspace({ workflowRunId: 's8c-init-typed-other', projectRoot: root, stagingParent: mkdtempSync(join(tmpdir(), 'cw-stage-typed2-')), inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {} }), /lease exists|exist/i);
});

test('stage8c strict manifest rejects duplicate or omitted baseline and missing identities', () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a'); file(root, 'b.txt', 'b');
  const ws = createCodingWorkspace({ workflowRunId: 's8c-baseline-exact', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt', 'b.txt'], writablePaths: ['a.txt', 'b.txt'], assertAuthority() {} });
  const manifest: any = ws.recoveryManifest();
  const dup = { ...manifest, baselineEntries: [manifest.baselineEntries[0], manifest.baselineEntries[0]] };
  dup.baselineHash = manifest.baselineHash;
  assert.equal(inspectRetainedCodingWorkspaceManifest(dup, retainedScope(manifest, staging)).status, 'unsafe');
  const omitted = { ...manifest, baselineEntries: [manifest.baselineEntries[0]] };
  omitted.baselineHash = manifest.baselineHash;
  assert.equal(inspectRetainedCodingWorkspaceManifest(omitted, retainedScope(manifest, staging)).status, 'unsafe');
  const nullFile = { ...manifest, baselineEntries: manifest.baselineEntries.map((e: any, i: number) => i === 0 ? { ...e, file: null } : e) };
  nullFile.baselineHash = manifest.baselineHash;
  assert.equal(inspectRetainedCodingWorkspaceManifest(nullFile, retainedScope(manifest, staging)).status, 'unsafe');
});

test('stage8c strict manifest rejects missing or mismatched effect marker identities', () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a');
  const ws = createCodingWorkspace({ workflowRunId: 's8c-marker-proof', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {} });
  ws.write('a.txt', 'b');
  const manifest: any = ws.recoveryManifest();
  const nullMarker = { ...manifest, effects: manifest.effects.map((e: any) => ({ ...e, markerIdentity: null })) };
  assert.equal(inspectRetainedCodingWorkspaceManifest(nullMarker, retainedScope(manifest, staging)).status, 'unsafe');
  const wrongMarker = { ...manifest, effects: manifest.effects.map((e: any) => ({ ...e, markerIdentity: { ...e.markerIdentity, ino: e.markerIdentity.ino + 1 } })) };
  assert.equal(inspectRetainedCodingWorkspaceManifest(wrongMarker, retainedScope(manifest, staging)).status, 'unsafe');
});

test('stage8c retained inventory rejects excessive bounded declared dirs without materializing arbitrary trees', () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a');
  const ws = createCodingWorkspace({ workflowRunId: 's8c-retained-entry-cap', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], limits: { maxFiles: 1 }, assertAuthority() {} });
  const manifest: any = ws.recoveryManifest();
  for (let i = 0; i < 4; i++) file(ws.stageRoot, `extra${i}.txt`, 'x');
  const out = inspectRetainedCodingWorkspaceManifest(manifest, retainedScope(manifest, staging));
  assert.equal(out.status, 'unsafe');
  assert.match(out.error ?? '', /inventory|undeclared|too large/);
});

function currentOwnerEvidence(writerSessionId = 'writer-session', generation = 'writer-generation') {
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
  return { bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), pid: process.pid, startTimeTicks: fields[19], writerSessionId, generation, lockDev: 1, lockIno: 2, markerDev: 3, markerIno: 4 };
}

test('stage8c rechecks authority and active ownership after durable intent before stage effect', skipWin, () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a'); file(root, 'marker-replacement.txt', 'm');
  let ok = true; let armed = false;
  const wsReadonly = createCodingWorkspace({ workflowRunId: 's8c-recheck-readonly', projectRoot: root, stagingParent: staging, inputPaths: [], writablePaths: ['a.txt'], assertAuthority() { if (!ok) throw new Error('readonly'); }, effectHooks: { beforeEffect() { if (armed) ok = false; } } });
  armed = true;
  assert.throws(() => wsReadonly.write('a.txt', 'b'), /readonly/);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'a');
  assert.equal(readFileSync(join(wsReadonly.stageRoot, 'a.txt'), 'utf8'), 'a');
  assert.equal(wsReadonly.recoveryManifest().effects.at(-1)?.status, 'rejected');

  const { root: r2, staging: s2 } = dirs(); file(r2, 'a.txt', 'a');
  let settledArmed = false;
  const wsSettled = createCodingWorkspace({ workflowRunId: 's8c-recheck-settled', projectRoot: r2, stagingParent: s2, inputPaths: [], writablePaths: ['a.txt'], assertAuthority() {}, effectHooks: { beforeEffect() { if (settledArmed) wsSettled.settle(); } } });
  settledArmed = true;
  assert.throws(() => wsSettled.write('a.txt', 'b'), /settled/);
  assert.equal(readFileSync(join(r2, 'a.txt'), 'utf8'), 'a');
  assert.equal(readFileSync(join(wsSettled.stageRoot, 'a.txt'), 'utf8'), 'a');

  const { root: r3, staging: s3 } = dirs(); file(r3, 'a.txt', 'a'); file(r3, 'replacement.txt', 'x');
  let markerArmed = false;
  const wsMarker = createCodingWorkspace({ workflowRunId: 's8c-recheck-marker', projectRoot: r3, stagingParent: s3, inputPaths: [], writablePaths: ['a.txt'], assertAuthority() {}, effectHooks: { beforeEffect(i) { if (markerArmed) { unlinkSync(i.markerPath); symlinkSync(join(r3, 'replacement.txt'), i.markerPath); } } } });
  markerArmed = true;
  assert.throws(() => wsMarker.write('a.txt', 'b'), /marker|symlink|owner/);
  assert.equal(readFileSync(join(r3, 'a.txt'), 'utf8'), 'a');
  assert.equal(readFileSync(join(wsMarker.stageRoot, 'a.txt'), 'utf8'), 'a');
});

test('stage8c constructor initial copy recheck blocks stage mutation after revoked intent', skipWin, () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a');
  let ok = true; let stageRoot = '';
  assert.throws(() => createCodingWorkspace({ workflowRunId: 's8c-init-revoked', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() { if (!ok) throw new Error('aborted'); }, effectHooks: { beforeEffect(i) { stageRoot = i.stageRoot; ok = false; } } }), /aborted/);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'a');
  assert.equal(stageRoot ? existsSync(join(stageRoot, 'a.txt')) : false, false);
});

test('stage8c rechecks authority after durable intent before destination write', () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a');
  let applyOk = true;
  const ws = createCodingWorkspace({ workflowRunId: 's8c-apply-recheck', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() { if (!applyOk) throw new Error('cancelled'); }, effectHooks: { beforeEffect(i) { if (i.kind === 'destination-write') applyOk = false; } } });
  ws.write('a.txt', 'b');
  const out = ws.apply(ws.inspect().hash);
  assert.equal(out.status, 'rejected');
  assert.deepEqual(out.appliedPaths, []);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'a');
  assert.equal(ws.recoveryManifest().effects.filter((e) => e.kind === 'destination-write').at(-1)?.status, 'rejected');
});



test('stage8c retained classification uses independent current bytes despite uncertain receipts', () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a'); mkdirSync(join(root, 'src'));
  let failDestinationAfter = false;
  const ws = createCodingWorkspace({ workflowRunId: 's8c-independent-current', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt', 'src/new.txt'], writablePaths: ['a.txt', 'src/new.txt'], assertAuthority() {}, effectHooks: { afterEffect(o) { if (failDestinationAfter && o.kind === 'destination-write') throw new Error('receipt-lost'); } } });
  ws.write('a.txt', 'b'); ws.write('src/new.txt', 'n');
  const candidate = ws.inspect();
  failDestinationAfter = true;
  const out = ws.apply(candidate.hash);
  assert.equal(out.status, 'partial');
  const manifest = ws.recoveryManifest();
  const inspected = inspectRetainedCodingWorkspaceManifest(manifest, retainedScope(manifest, staging));
  assert.equal(inspected.status, 'safe');
  const byPath = new Map(inspected.classifications.map((c) => [c.path, c]));
  assert.equal(byPath.get('a.txt')?.class, 'postimage');
  assert.equal(byPath.get('a.txt')?.recordedApplication, 'uncertain');
  assert.equal(byPath.get('a.txt')?.recordedEffects.some((e) => e.status === 'uncertain' || !e.afterSaved), true);
  writeFileSync(join(root, 'src/new.txt'), 'n');
  const inspected2 = inspectRetainedCodingWorkspaceManifest(manifest, retainedScope(manifest, staging));
  const byPath2 = new Map(inspected2.classifications.map((c) => [c.path, c]));
  assert.equal(byPath2.get('src/new.txt')?.class, 'postimage');
  assert.equal(byPath2.get('src/new.txt')?.recordedApplication, 'none');
});



test('stage8c partial lease release failure poisons workspace and reports before/current evidence', (t) => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a');
  let armed = false;
  let blockedLease = '';
  let observed: any;
  const realRmdir = fs.rmdirSync;
  t.mock.method(fs, 'rmdirSync', (path: fs.PathLike, options?: fs.RmDirOptions) => {
    if (armed && String(path) === blockedLease) throw new Error('injected lease directory removal failure');
    return realRmdir(path, options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const ws = createCodingWorkspace({
    workflowRunId: 's8c-lease-partial', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {},
    effectHooks: {
      beforeLeaseRelease(intent) {
        blockedLease = intent.beforeLeaseEvidence.leaseDir;
      },
      afterLeaseRelease(o) { observed = o; },
    },
  });
  ws.write('a.txt', 'b');
  const manifest = ws.recoveryManifest();
  armed = true;
  assert.throws(() => ws.settle(), WorkspaceLeaseReleaseUncertaintyError);
  assert.equal(observed?.status, 'uncertain');
  assert.equal(observed?.beforeLeaseEvidence.ownerValue, manifest.destinationLeases[0].ownerValue);
  assert.equal(observed?.currentObservation.leaseDirPresent, true);
  assert.equal(observed?.currentObservation.ownerFilePresent, false);
  assert.throws(() => ws.write('a.txt', 'c'), /cleaned up|settled|uncertain/);
  const rejected = ws.apply(ws.inspect().hash);
  assert.equal(rejected.status, 'rejected');
  assert.match(rejected.error ?? '', /uncertain|settled|cleaned up/);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'a');
});

test('stage8c inspect clones bounded plain JSON before raw access and does not mutate caller object', () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a');
  const ws = createCodingWorkspace({ workflowRunId: 's8c-plain-clone', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {} });
  const manifest: any = ws.recoveryManifest();
  let touched = false;
  const raw = Object.create(null);
  Object.defineProperty(raw, 'version', { enumerable: true, get() { touched = true; throw new Error('getter'); } });
  const bad = inspectRetainedCodingWorkspaceManifest(raw, retainedScope(manifest, staging));
  assert.equal(bad.status, 'unsafe');
  assert.equal(bad.manifest, null);
  assert.equal(touched, false);
  const mutable: any = { ...manifest, extra: 'x' };
  const out = inspectRetainedCodingWorkspaceManifest(mutable, retainedScope(manifest, staging));
  assert.equal(out.status, 'unsafe');
  mutable.extra = 'still caller owned';
  assert.equal(mutable.extra, 'still caller owned');
});

test('stage8c lease release verifies exact owner before settle and retains bookkeeping on mismatch', () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a');
  const ws = createCodingWorkspace({ workflowRunId: 's8c-lease-proof', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {} });
  const key = createHash('sha256').update(`${root}\0a.txt`).digest('hex');
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  const ownerFile = join(tmpdir(), `pi-clankers-coding-leases-${uid}`, key, 'owner');
  writeFileSync(ownerFile, 'other-owner');
  assert.throws(() => ws.settle(), /lease owner|mismatch|changed/);
  assert.throws(() => createCodingWorkspace({ workflowRunId: 's8c-lease-proof-2', projectRoot: root, stagingParent: mkdtempSync(join(tmpdir(), 'cw-stage-lease2-')), inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {} }), /lease exists|exist/i);
});

test('stage8c ownerEvidence is optional, verified as current process, and inspection remains non-adoptive', skipWin, () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a');
  const ownerEvidence = currentOwnerEvidence();
  const ws = createCodingWorkspace({ workflowRunId: 's8c-owner-evidence', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {}, recoveryWriterOwnerEvidence: ownerEvidence });
  const manifest = ws.recoveryManifest();
  // Optional fence inode/device proof is preserved when supplied, never invented.
  assert.deepEqual(manifest.ownerEvidence, ownerEvidence);
  assert.deepEqual(manifest.effects[0].ownerEvidence, ownerEvidence);
  const inspected = inspectRetainedCodingWorkspaceManifest(manifest, retainedScope(manifest, staging));
  assert.equal(inspected.settlement.state, 'verifiable-owner');
  assert.equal(inspected.settlement.adoptable, false);

  const { root: r2, staging: s2 } = dirs(); file(r2, 'a.txt', 'a');
  const legacy = createCodingWorkspace({ workflowRunId: 's8c-owner-legacy', projectRoot: r2, stagingParent: s2, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {} });
  const legacyInspection = inspectRetainedCodingWorkspaceManifest(legacy.recoveryManifest(), retainedScope(legacy.recoveryManifest(), s2));
  assert.equal(legacyInspection.settlement.state, 'settlement-unknown');
  assert.equal(legacyInspection.settlement.adoptable, false);

  assert.throws(() => createCodingWorkspace({ workflowRunId: 's8c-owner-wrong', projectRoot: r2, stagingParent: mkdtempSync(join(tmpdir(), 'cw-stage-owner-wrong-')), inputPaths: [], writablePaths: [], assertAuthority() {}, recoveryWriterOwnerEvidence: { ...ownerEvidence, pid: process.pid + 100000 } }), /current process/);
});
