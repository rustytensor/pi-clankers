import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCodingWorkspace, inspectPartialWorkspaceArtifacts, WorkspaceEffectUncertaintyError, type InspectPartialArtifactsOptions } from '../workflow-workspace.js';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
// These are independently supplied HOST permissions, not permissions extracted from a snapshot.
const inputPaths = ['src/a.txt', 'src/b.txt', 'src/ro.txt'];
const writablePaths = ['src/a.txt', 'src/b.txt'];

async function interrupted(mode: 'initial' | 'changed' | 'two', run: (f: { root: string; project: string; stage: string; options: InspectPartialArtifactsOptions; msg: any }) => void) {
  const root = mkdtempSync(join(tmpdir(), `clankers-partial-${mode}-`));
  const oldTmp = process.env.TMPDIR;
  process.env.TMPDIR = root; // Same isolated lease root for producer AND verifier.
  const project = join(root, 'project'), staging = join(root, 'staging');
  mkdirSync(join(project, 'src'), { recursive: true, mode: 0o700 }); mkdirSync(staging, { mode: 0o700 });
  for (const name of ['a', 'b', 'ro']) writeFileSync(join(project, `src/${name}.txt`), `${name}-old\n`);
  writeFileSync(join(project, 'unrelated'), 'KEEP');
  const driver = `
    import { randomUUID } from 'node:crypto';
    import { readFileSync } from 'node:fs';
    import { createCodingWorkspace } from ${JSON.stringify(new URL('../workflow-workspace.ts', import.meta.url).href)};
    const [mode,projectRoot,stagingParent]=process.argv.slice(1);
    const stat=readFileSync('/proc/'+process.pid+'/stat','utf8');
    const owner={bootId:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),pid:process.pid,startTimeTicks:stat.slice(stat.lastIndexOf(')')+2).trim().split(/\\s+/)[19],writerSessionId:randomUUID(),generation:randomUUID()};
    let rootReady, latestIntent, recordedManifest, expectedHash;
    const results=[];
    function stop(){ process.stdout.write(JSON.stringify({rootReady,latestIntent,recordedManifest,results,expectedHash})+'\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0); }
    const hooks={
      rootReady(e){rootReady=e;},
      beforeEffect(i){latestIntent=i; if(mode==='initial') stop();},
      afterEffect(o){ if(recordedManifest && o.path==='src/a.txt') { expectedHash=ws.inspect().hash; stop(); } results.push(o); }
    };
    const ws=createCodingWorkspace({workflowRunId:'partial-'+mode,projectRoot,stagingParent,inputPaths:${JSON.stringify(inputPaths)},writablePaths:${JSON.stringify(writablePaths)},assertAuthority(){},effectHooks:hooks,recoveryWriterOwnerEvidence:owner});
    if(mode==='two') ws.write('src/b.txt','b-new\\n');
    recordedManifest=ws.recoveryManifest();
    ws.write('src/a.txt','a-new\\n');
    throw new Error('stop hook unexpectedly returned');
  `;
  // Deliberately do not inherit provider credentials or unrelated NODE_OPTIONS.
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', driver, mode, project, staging], { env: { PATH: process.env.PATH, TMPDIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let stdout = '', stderr = '';
  child.stdout.on('data', (b: Buffer) => { stdout += b.toString(); if (stdout.length > 256 * 1024) child.kill('SIGKILL'); });
  child.stderr.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-4096); });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { clearInterval(poll); reject(new Error('child not ready: '+stderr)); }, 8000);
      const poll = setInterval(() => { if (stdout.includes('\n')) { clearTimeout(timer); clearInterval(poll); resolve(); } }, 10);
    });
    child.kill('SIGKILL');
    const [, signal] = await closed; assert.equal(signal, 'SIGKILL');
    const msg = JSON.parse(stdout.trim());
    const options: InspectPartialArtifactsOptions = { rootReadyEvidence: msg.rootReady, latestIntent: msg.latestIntent, ...(msg.recordedManifest ? { recordedManifest: msg.recordedManifest } : {}), recordedResults: msg.results, trustedScope: { projectRoot: project, stagingParent: staging, workflowRunId: 'partial-'+mode, allowedPaths: inputPaths, inputPaths, writablePaths } };
    for (const lease of msg.rootReady.destinationLeases) assert.ok(lease.leaseDir.startsWith(root+'/'));
    run({ root, project, stage: msg.rootReady.stageRoot, options, msg });
    assert.equal(readFileSync(join(project, 'unrelated'), 'utf8'), 'KEEP');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await closed; }
    if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp;
    rmSync(root, { recursive: true, force: true });
  }
}
function inventory(root: string): unknown {
  const walk = (p: string): unknown => { const st = lstatSync(p); return [st.ino, st.mode, st.nlink, st.mtimeMs, st.isDirectory() ? readdirSync(p).sort().map(n => [n, walk(join(p,n))]) : st.isSymbolicLink() ? 'symlink' : sha(readFileSync(p))]; };
  return walk(root);
}
function blocked(options: InspectPartialArtifactsOptions) { const out = inspectPartialWorkspaceArtifacts(options); assert.equal(out.status, 'blocked', JSON.stringify(out)); return out; }

test('actual initial intent-before-effect SIGKILL permits only fresh reconstruction; inspection has no effects', { timeout: 12000 }, async () => {
  await interrupted('initial', ({ root, stage, options, msg }) => {
    assert.equal(msg.latestIntent.sequence, 1); assert.equal(msg.latestIntent.preimageHash, null);
    assert.equal(existsSync(join(stage, 'src/a.txt')), false);
    const before = inventory(root), start = Date.now();
    const out = inspectPartialWorkspaceArtifacts(options);
    assert.equal(out.status, 'safe', JSON.stringify(out)); assert.equal(out.mode, 'fresh-reconstruction-only');
    assert.equal(out.observedCandidate, undefined); assert.equal(out.observedManifest, undefined);
    assert.deepEqual(out.settlement, { localOwner: 'dead', checks: 'unknown', native: 'unknown', admission: false });
    assert.ok(Date.now()-start < 1000); assert.deepEqual(inventory(root), before);
    blocked({ ...options, latestIntent: undefined });
    mkdirSync(join(stage, 'src'), { mode: 0o700 }); writeFileSync(join(stage, 'src/a.txt'), 'a-old\n', { mode: 0o600 });
    assert.equal(inspectPartialWorkspaceArtifacts(options).mode, 'fresh-reconstruction-only'); // Pending copy may have reached its postimage.
  });
});

test('SIGKILL after changed stage effect but before receipt yields exact observed hash, never original completion', { timeout: 12000 }, async () => {
  await interrupted('changed', ({ root, project, options, msg }) => {
    const before = inventory(root), start = Date.now();
    const out = inspectPartialWorkspaceArtifacts(options);
    assert.equal(out.status, 'safe', JSON.stringify(out)); assert.equal(out.mode, 'observed-candidate-carry');
    const serial = [{ path: 'src/a.txt', beforeHash: sha('a-old\n'), afterHash: sha('a-new\n'), after: Buffer.from('a-new\n').toString('base64') }];
    assert.equal(out.observedCandidate?.candidateHash, sha(JSON.stringify(serial)));
    assert.equal(out.observedCandidate?.candidateHash, msg.expectedHash, 'same hash as live workspace.inspect() after actual effect');
    assert.equal(out.observedCandidate?.files[0].base64, serial[0].after);
    assert.equal(out.observedCandidate?.invalidatesHistoricalClaims, true);
    assert.deepEqual(out.observedManifest?.effects, msg.recordedManifest.effects);
    assert.equal(out.observedManifest?.effects.some(e => e.sequence === msg.latestIntent.sequence), false);
    assert.ok(Date.now()-start < 1000); assert.deepEqual(inventory(root), before);
    assert.equal(readFileSync(join(project, 'src/a.txt'), 'utf8'), 'a-old\n');
    blocked({ ...options, latestIntent: undefined });
    blocked({ ...options, recordedResults: { completed: true, check: 'passed' } });
    blocked({ ...options, recordedResults: [...msg.results, { ...msg.latestIntent, status: 'observed', observedPostimageHash: msg.latestIntent.postimageHash }] });
    blocked({ ...options, recordedManifest: { ...msg.recordedManifest, baselineHash: sha('wrong') } });
    blocked({ ...options, recordedManifest: { ...msg.recordedManifest, effects: [] , markerOwner: 'wrong' } });
    blocked({ ...options, rootReadyEvidence: { ...msg.rootReady, ownerEvidence: undefined } });
    blocked({ ...options, rootReadyEvidence: { ...msg.rootReady, markerOwner: 'wrong' } });
    blocked({ ...options, rootReadyEvidence: { ...msg.rootReady, stageRootIdentity: { ...msg.rootReady.stageRootIdentity, ino: 0 } } });
    blocked({ ...options, latestIntent: { ...msg.latestIntent, postimageHash: sha('wrong') } });
    blocked({ ...options, trustedScope: { ...options.trustedScope, writablePaths: [] } });
    blocked({ ...options, trustedScope: { ...options.trustedScope, projectRoot: root } });
    blocked({ ...options, rootReadyEvidence: { ...msg.rootReady, destinationLeases: msg.rootReady.destinationLeases.map((l: any) => ({ ...l, ownerValue: 'wrong-owner' })) } });
    blocked({ ...options, rootReadyEvidence: { ...msg.rootReady, destinationLeases: msg.rootReady.destinationLeases.slice(1) } });
    blocked({ ...options, rootReadyEvidence: { ...msg.rootReady, destinationLeases: msg.rootReady.destinationLeases.map((l: any) => ({ ...l, leaseDir: root, ownerFile: join(root, 'owner') })) } });
    blocked({ ...options, latestIntent: { ...msg.latestIntent, ownerEvidence: { ...msg.latestIntent.ownerEvidence, generation: 'wrong-generation' } } });
    assert.deepEqual(inventory(root), before);
  });
});

test('SIGKILL negatives: readonly project/stage drift, nested extras, symlinks, hardlinks/owner proof, missing bytes and multiple edits', { timeout: 24000 }, async () => {
  await interrupted('changed', ({ root, project, stage, options, msg }) => {
    const ro = join(project, 'src/ro.txt');
    writeFileSync(ro, 'DRIFT'); blocked(options); writeFileSync(ro, 'ro-old\n');
    const stageRo = join(stage, 'src/ro.txt');
    chmodSync(stageRo, 0o600); writeFileSync(stageRo, 'DRIFT'); blocked(options); writeFileSync(stageRo, 'ro-old\n'); chmodSync(stageRo, 0o400);
    const nested = join(stage, 'src/unexpected');
    writeFileSync(nested, 'KEEP EXTRA');
    let before = inventory(root); blocked(options); assert.deepEqual(inventory(root), before); assert.equal(readFileSync(nested, 'utf8'), 'KEEP EXTRA'); rmSync(nested);
    symlinkSync(project, nested); before = inventory(root); blocked(options); assert.deepEqual(inventory(root), before); rmSync(nested);
    blocked({ ...options, rootReadyEvidence: { ...msg.rootReady, stageRootIdentity: { ...msg.rootReady.stageRootIdentity, uid: msg.rootReady.stageRootIdentity.uid+1 } } });
    linkSync(join(stage, 'src/a.txt'), join(root, 'hardlink')); blocked(options); rmSync(join(root, 'hardlink'));
    writeFileSync(join(stage, 'src/a.txt'), 'WRONG'); blocked(options);
    rmSync(join(stage, 'src/a.txt')); blocked(options);
  });
  await interrupted('two', ({ options, msg }) => {
    const out = inspectPartialWorkspaceArtifacts(options);
    assert.equal(out.status, 'safe', JSON.stringify(out.blockers));
    const serial = ['a', 'b'].map(n => ({ path: `src/${n}.txt`, beforeHash: sha(`${n}-old\n`), afterHash: sha(`${n}-new\n`), after: Buffer.from(`${n}-new\n`).toString('base64') }));
    assert.deepEqual(out.observedCandidate?.changedPaths, ['src/a.txt', 'src/b.txt']);
    assert.equal(out.observedCandidate?.candidateHash, msg.expectedHash);
    assert.equal(out.observedCandidate?.candidateHash, sha(JSON.stringify(serial)));
    // Missing proof must block rather than silently omit the second path.
    assert.match(blocked({ ...options, recordedManifest: undefined, recordedResults: [] }).blockers.join(' '), /chain|intent/);
  });
});

test('uncertain root-ready publication retains root and leases without file effects or cleanup', () => {
  const root = mkdtempSync(join(tmpdir(), 'clankers-rootready-error-')), oldTmp = process.env.TMPDIR;
  process.env.TMPDIR = root;
  const projectRoot = join(root, 'project'), stagingParent = join(root, 'stage');
  mkdirSync(projectRoot); mkdirSync(stagingParent); writeFileSync(join(projectRoot, 'a'), 'old');
  let evidence: any; let effects = 0, releases = 0;
  try {
    assert.throws(() => createCodingWorkspace({ workflowRunId: 'root-failure', projectRoot, stagingParent, inputPaths: ['a'], writablePaths: ['a'], assertAuthority() {}, effectHooks: { rootReady(e) { evidence = e; throw new Error('durability unknown'); }, beforeEffect() { effects++; }, beforeLeaseRelease() { releases++; } } }), WorkspaceEffectUncertaintyError);
    assert.equal(effects, 0); assert.equal(releases, 0);
    assert.ok(existsSync(evidence.markerPath)); assert.ok(existsSync(evidence.destinationLeases[0].ownerFile));
    assert.equal(existsSync(join(evidence.stageRoot, 'a')), false);
    assert.equal(readFileSync(join(projectRoot, 'a'), 'utf8'), 'old');
  } finally { if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp; rmSync(root, { recursive: true, force: true }); }
});


test('successful root-ready publication followed by authority revocation retains all published evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'clankers-rootready-revoked-')), oldTmp = process.env.TMPDIR;
  process.env.TMPDIR = root;
  const projectRoot = join(root, 'project'), stagingParent = join(root, 'stage');
  mkdirSync(projectRoot); mkdirSync(stagingParent); writeFileSync(join(projectRoot, 'a'), 'old');
  let evidence: any, published = false, effects = 0, releases = 0;
  try {
    assert.throws(() => createCodingWorkspace({ workflowRunId: 'root-revoked', projectRoot, stagingParent, inputPaths: ['a'], writablePaths: ['a'], assertAuthority() { if (published) throw Error('authority revoked after publication'); }, effectHooks: { rootReady(e) { evidence = e; published = true; }, beforeEffect() { effects++; }, beforeLeaseRelease() { releases++; } } }), WorkspaceEffectUncertaintyError);
    assert.equal(effects, 0); assert.equal(releases, 0);
    assert.ok(existsSync(evidence.stageRoot)); assert.ok(existsSync(evidence.markerPath));
    for (const lease of evidence.destinationLeases) { assert.ok(existsSync(lease.leaseDir)); assert.ok(existsSync(lease.ownerFile)); }
    assert.equal(existsSync(join(evidence.stageRoot, 'a')), false);
    assert.equal(readFileSync(join(projectRoot, 'a'), 'utf8'), 'old');
  } finally { if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp; rmSync(root, { recursive: true, force: true }); }
});

test('capacity projection bounds full constructor evidence and deep newly created stage directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'clankers-capacity-')), oldTmp = process.env.TMPDIR;
  process.env.TMPDIR = root;
  const projectRoot = join(root, 'project'), stagingParent = join(root, 'stage');
  const missing = 'new/a/b/c/d/e/f/g/h/file.txt';
  mkdirSync(join(projectRoot, 'new/a/b/c/d/e/f/g/h'), { recursive: true }); mkdirSync(stagingParent);
  writeFileSync(join(projectRoot, 'readonly'), 'readonly'); writeFileSync(join(projectRoot, 'existing'), 'old');
  const nodes = (value: unknown): number => 1 + (value && typeof value === 'object' ? Object.values(value).reduce((sum: number, item) => sum + nodes(item), 0) : 0);
  let capacity: any, constructorCapacities = 0, rootReady: any;
  try {
    const ws = createCodingWorkspace({ workflowRunId: 'capacity', projectRoot, stagingParent, inputPaths: ['readonly', 'existing'], writablePaths: ['existing', missing], assertAuthority() {}, effectHooks: {
      rootReady(e) { rootReady = e; },
      beforeEffect(intent, reserve) {
        assert.ok(reserve); capacity = reserve;
        if (intent.preimageHash === null) constructorCapacities++;
        // All future directory and file representations are covered BEFORE any
        // constructor effect, including the presently absent deep stage tree.
        assert.ok((reserve.manifest as any).declaredStageDirs.some((d: any) => d.path === 'new/a/b/c/d/e/f/g/h'));
        assert.equal((reserve.manifest as any).candidateEntries.length, 2);
      },
    } });
    assert.equal(constructorCapacities, 2);
    assert.ok(nodes(capacity.manifest) >= nodes(ws.recoveryManifest()));
    assert.ok(Buffer.byteLength(JSON.stringify(capacity.manifest)) >= Buffer.byteLength(JSON.stringify(ws.recoveryManifest())));
    ws.write(missing, 'new');
    const manifest = ws.recoveryManifest();
    assert.ok(nodes(capacity.manifest) >= nodes(manifest));
    assert.ok(Buffer.byteLength(JSON.stringify(capacity.manifest)) >= Buffer.byteLength(JSON.stringify(manifest)));
    const { beforeCalled: _before, afterSaved: _after, recordedAt: _time, ...observation } = manifest.effects.at(-1)!;
    assert.ok(nodes(capacity.observation) >= nodes(observation));
    assert.equal(readFileSync(join(rootReady.stageRoot, missing), 'utf8'), 'new');
    assert.equal(existsSync(join(projectRoot, missing)), false);
    ws.cleanup();
  } finally { if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp; rmSync(root, { recursive: true, force: true }); }
});
