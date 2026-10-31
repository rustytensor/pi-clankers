import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCodingWorkspace, createContinuationCodingWorkspace as carryCandidate, type RecoveryWriterOwnerEvidence } from '../workflow-workspace.js';

// Explicit in-memory journal port for isolated unit tests, not crash-durability certification.
function createContinuationCodingWorkspace(options: Parameters<typeof carryCandidate>[0]): ReturnType<typeof carryCandidate> {
  const journal: unknown[] = [];
  return carryCandidate({ ...options, effectHooks: {
    beforeEffect: intent => { journal.push(intent); }, afterEffect: result => { journal.push(result); },
    beforeLeaseRelease: intent => { journal.push(intent); }, afterLeaseRelease: result => { journal.push(result); },
    ...options.effectHooks,
  } });
}
function dirs() { return { root: mkdtempSync(join(tmpdir(), 'cw-carry-proj-')), staging: mkdtempSync(join(tmpdir(), 'cw-carry-stage-')) }; }
function file(root: string, path: string, text: string) { const parts = path.split('/'); let dir = root; for (const p of parts.slice(0, -1)) { dir = join(dir, p); mkdirSync(dir, { recursive: true }); } writeFileSync(join(root, path), text, { mode: 0o600 }); }
function startTicks(pid = process.pid): string { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[19]; }
function ownerEvidence(generation = randomUUID()): RecoveryWriterOwnerEvidence { return { bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), pid: process.pid, startTimeTicks: startTicks(), writerSessionId: randomUUID(), generation }; }
function scope(manifest: any, staging: string) { return { projectRoot: manifest.projectRoot, stagingParent: staging, workflowRunId: manifest.workflowRunId, allowedPaths: manifest.allowedPaths }; }
// Synthetic consistency fixtures only; genuine process death is exercised below.
function deaden(manifest: any) { const ownerEvidence = { ...manifest.ownerEvidence, bootId: '00000000-0000-0000-0000-000000000000' }; return { ...manifest, ownerEvidence, effects: manifest.effects.map((e: any) => e.ownerEvidence ? { ...e, ownerEvidence } : e) }; }

test('genuine terminated owner carries candidate into fresh stage without rewriting satisfied destination', { timeout: 15000 }, async (t) => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'before-a'); file(root, 'b.txt', 'before-b');
  const module = new URL('../workflow-workspace.ts', import.meta.url).href;
  const code = `
    import { readFileSync, writeFileSync } from 'node:fs';
    import { randomUUID } from 'node:crypto';
    import { createCodingWorkspace } from ${JSON.stringify(module)};
    const root = process.argv[1], staging = process.argv[2];
    const stat = readFileSync('/proc/' + process.pid + '/stat', 'utf8');
    const owner = { bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), pid: process.pid, startTimeTicks: stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\\s+/)[19], writerSessionId: randomUUID(), generation: randomUUID() };
    const ws = createCodingWorkspace({ workflowRunId: 'actual-old-owner', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt','b.txt'], writablePaths: ['a.txt','b.txt'], assertAuthority() {}, recoveryWriterOwnerEvidence: owner });
    ws.write('a.txt', 'after-a'); ws.write('b.txt', 'after-b');
    writeFileSync(root + '/manifest.json', JSON.stringify(ws.recoveryManifest()));
    process.stdout.write('ready\\n');
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, root, staging], { env: { TMPDIR: tmpdir() }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close');
  let output = '', diagnostic = '', succeeded = false;
  child.stdout.on('data', (b: Buffer) => { output = (output + b.toString()).slice(-1024); });
  child.stderr.on('data', (b: Buffer) => { diagnostic = (diagnostic + b.toString()).slice(-4096); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed;
    if (succeeded) { rmSync(root, { recursive: true, force: true }); rmSync(staging, { recursive: true, force: true }); }
    else console.error('Retained candidate-carry evidence', root, staging, diagnostic);
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('owned stage producer deadline')); }, 7000);
    const receive = () => { if (output.includes('ready\n')) { clearTimeout(timer); child.stdout.off('data', receive); resolve(); } };
    child.stdout.on('data', receive);
    child.once('exit', () => { clearTimeout(timer); if (!output.includes('ready\n')) reject(new Error(`producer exited before ready: ${diagnostic}`)); });
    receive();
  });
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  assert.equal(manifest.ownerEvidence.pid, child.pid);
  child.kill('SIGKILL'); await closed;
  // Later byte equality is independent observation, not attribution to the old writer.
  writeFileSync(join(root, 'b.txt'), 'after-b');
  const oldMarker = readFileSync(manifest.markerPath, 'utf8');
  const before = readFileSync(join(root, 'a.txt'), 'utf8');
  let settlementChecks = 0;
  const out = createContinuationCodingWorkspace({ rawRetainedManifest: manifest, trustedScope: scope(manifest, staging), workflowRunId: 'actual-new-owner', recoveryWriterOwnerEvidence: ownerEvidence(), assertAuthority() {}, assertPreviousSettlement() { settlementChecks++; /* This isolated stage launched no checks. */ } });
  const created = expectCreated(out);
  assert.equal(settlementChecks > 0, true);
  assert.notEqual(created.workspace.stageRoot, manifest.stageRoot);
  assert.equal(readFileSync(manifest.markerPath, 'utf8'), oldMarker);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), before, 'carry is staging, never application');
  assert.equal(readFileSync(join(root, 'b.txt'), 'utf8'), 'after-b');
  assert.equal(created.workspace.read('a.txt'), 'after-a');
  assert.deepEqual(created.workspace.inspect().changedPaths, ['a.txt']);
  assert.deepEqual(created.provenance.alreadySatisfiedPaths, ['b.txt']);
  created.workspace.settle();
  succeeded = true;
});

function expectBlocked(out: ReturnType<typeof createContinuationCodingWorkspace>) { if (out.status !== 'blocked') throw new Error('expected blocked continuation'); return out; }
function expectCreated(out: ReturnType<typeof createContinuationCodingWorkspace>) { if (out.status !== 'created') throw new Error('expected created continuation'); return out; }

test('continuation blocks live retained owner before settlement or lease release', () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a');
  const old = createCodingWorkspace({ workflowRunId: 'old-live', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {}, recoveryWriterOwnerEvidence: ownerEvidence() });
  old.write('a.txt', 'b');
  let settlement = 0;
  const out = createContinuationCodingWorkspace({ rawRetainedManifest: old.recoveryManifest(), trustedScope: scope(old.recoveryManifest(), staging), workflowRunId: 'new-live', recoveryWriterOwnerEvidence: ownerEvidence(), assertAuthority() {}, assertPreviousSettlement() { settlement++; } });
  const blocked = expectBlocked(out);
  assert.match(blocked.error, /alive|ambiguous|owner/i);
  assert.equal(settlement, 0);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'a');
  old.cleanup(); rmSync(root, { recursive: true, force: true }); rmSync(staging, { recursive: true, force: true });
});

test('continuation requires host settlement callback and performs zero writes when revoked', () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a');
  const old = createCodingWorkspace({ workflowRunId: 'old-cb', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {}, recoveryWriterOwnerEvidence: ownerEvidence() });
  old.write('a.txt', 'b');
  const manifest = deaden(old.recoveryManifest());
  const out = createContinuationCodingWorkspace({ rawRetainedManifest: manifest, trustedScope: scope(manifest, staging), workflowRunId: 'new-cb', recoveryWriterOwnerEvidence: ownerEvidence(), assertAuthority() {}, assertPreviousSettlement() { throw new Error('missing durable check receipt'); } });
  const blocked = expectBlocked(out);
  assert.match(blocked.error, /durable check receipt/);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'a');
  old.cleanup(); rmSync(root, { recursive: true, force: true }); rmSync(staging, { recursive: true, force: true });
});

test('continuation blocks destination conflict and leaves external content intact', () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a');
  const old = createCodingWorkspace({ workflowRunId: 'old-conflict', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {}, recoveryWriterOwnerEvidence: ownerEvidence() });
  old.write('a.txt', 'b');
  writeFileSync(join(root, 'a.txt'), 'external');
  const manifest = deaden(old.recoveryManifest());
  const out = createContinuationCodingWorkspace({ rawRetainedManifest: manifest, trustedScope: scope(manifest, staging), workflowRunId: 'new-conflict', recoveryWriterOwnerEvidence: ownerEvidence(), assertAuthority() {}, assertPreviousSettlement() {} });
  const blocked = expectBlocked(out);
  assert.match(blocked.error, /conflict/);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'external');
  old.cleanup(); rmSync(root, { recursive: true, force: true }); rmSync(staging, { recursive: true, force: true });
});

test('continuation treats postimage paths as already satisfied and only carries remaining preimage bytes', () => {
  const { root, staging } = dirs(); file(root, 'pre.txt', 'pre'); file(root, 'post.txt', 'post');
  const old = createCodingWorkspace({ workflowRunId: 'old-mixed', projectRoot: root, stagingParent: staging, inputPaths: ['pre.txt', 'post.txt'], writablePaths: ['pre.txt', 'post.txt'], assertAuthority() {}, recoveryWriterOwnerEvidence: ownerEvidence() });
  old.write('pre.txt', 'PRE'); old.write('post.txt', 'POST');
  writeFileSync(join(root, 'post.txt'), 'POST');
  const manifest = deaden(old.recoveryManifest());
  const out = createContinuationCodingWorkspace({ rawRetainedManifest: manifest, trustedScope: scope(manifest, staging), workflowRunId: 'new-mixed', recoveryWriterOwnerEvidence: ownerEvidence(), assertAuthority() {}, assertPreviousSettlement() {} });
  const created = expectCreated(out);
  assert.deepEqual(created.provenance.alreadySatisfiedPaths, ['post.txt']);
  assert.deepEqual(created.provenance.remainingPaths, ['pre.txt']);
  assert.deepEqual(created.workspace.inspect().changedPaths, ['pre.txt']);
  assert.equal(created.workspace.read('pre.txt'), 'PRE');
  assert.equal(readFileSync(join(root, 'post.txt'), 'utf8'), 'POST');
  created.workspace.settle(); rmSync(root, { recursive: true, force: true }); rmSync(staging, { recursive: true, force: true });
});

test('continuation rechecks callback destination drift before lease unlink', () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a');
  const old = createCodingWorkspace({ workflowRunId: 'old-cb-drift', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {}, recoveryWriterOwnerEvidence: ownerEvidence() });
  old.write('a.txt', 'b');
  const manifest = deaden(old.recoveryManifest());
  const leaseOwner = manifest.destinationLeases[0].ownerFile;
  const out = createContinuationCodingWorkspace({ rawRetainedManifest: manifest, trustedScope: scope(manifest, staging), workflowRunId: 'new-cb-drift', recoveryWriterOwnerEvidence: ownerEvidence(), assertAuthority() {}, assertPreviousSettlement() { writeFileSync(join(root, 'a.txt'), 'external'); } });
  const blocked = expectBlocked(out);
  assert.match(blocked.error, /observations changed|conflict|changed/i);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'external');
  assert.equal(readFileSync(leaseOwner, 'utf8'), manifest.markerOwner);
  old.cleanup(); rmSync(root, { recursive: true, force: true }); rmSync(staging, { recursive: true, force: true });
});

test('continuation rejects changed readonly project dependency', () => {
  const { root, staging } = dirs(); file(root, 'ro.txt', 'ro'); file(root, 'a.txt', 'a');
  const old = createCodingWorkspace({ workflowRunId: 'old-ro-drift', projectRoot: root, stagingParent: staging, inputPaths: ['ro.txt', 'a.txt'], writablePaths: ['a.txt'], assertAuthority() {}, recoveryWriterOwnerEvidence: ownerEvidence() });
  old.write('a.txt', 'b');
  const manifest = deaden(old.recoveryManifest());
  writeFileSync(join(root, 'ro.txt'), 'changed');
  const out = createContinuationCodingWorkspace({ rawRetainedManifest: manifest, trustedScope: scope(manifest, staging), workflowRunId: 'new-ro-drift', recoveryWriterOwnerEvidence: ownerEvidence(), assertAuthority() {}, assertPreviousSettlement() {} });
  const blocked = expectBlocked(out);
  assert.match(blocked.error, /readonly project input changed|observations changed/i);
  old.cleanup(); rmSync(root, { recursive: true, force: true }); rmSync(staging, { recursive: true, force: true });
});

test('continuation carries missing new file candidate without reading absent workspace file', () => {
  const { root, staging } = dirs();
  const old = createCodingWorkspace({ workflowRunId: 'old-newfile', projectRoot: root, stagingParent: staging, inputPaths: [], writablePaths: ['new.txt'], assertAuthority() {}, recoveryWriterOwnerEvidence: ownerEvidence() });
  old.write('new.txt', 'created');
  const manifest = deaden(old.recoveryManifest());
  const out = createContinuationCodingWorkspace({ rawRetainedManifest: manifest, trustedScope: scope(manifest, staging), workflowRunId: 'new-newfile', recoveryWriterOwnerEvidence: ownerEvidence(), assertAuthority() {}, assertPreviousSettlement() {} });
  const created = expectCreated(out);
  assert.deepEqual(created.workspace.inspect().changedPaths, ['new.txt']);
  assert.equal(created.workspace.read('new.txt'), 'created');
  created.workspace.settle(); rmSync(root, { recursive: true, force: true }); rmSync(staging, { recursive: true, force: true });
});

test('continuation rejects malformed retained lease path without deleting real lease', () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a');
  const old = createCodingWorkspace({ workflowRunId: 'old-badlease', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {}, recoveryWriterOwnerEvidence: ownerEvidence() });
  old.write('a.txt', 'b');
  const manifest = deaden(old.recoveryManifest());
  const realOwner = manifest.destinationLeases[0].ownerFile;
  const bad = { ...manifest, destinationLeases: [{ ...manifest.destinationLeases[0], leaseDir: '/tmp/pi-zerg-swarm-bad-outside', ownerFile: '/tmp/pi-zerg-swarm-bad-outside/owner' }] };
  const out = createContinuationCodingWorkspace({ rawRetainedManifest: bad, trustedScope: scope(manifest, staging), workflowRunId: 'new-badlease', recoveryWriterOwnerEvidence: ownerEvidence(), assertAuthority() {}, assertPreviousSettlement() {} });
  const blocked = expectBlocked(out);
  assert.match(blocked.error, /trusted root|lease path|outside/i);
  assert.equal(readFileSync(realOwner, 'utf8'), manifest.markerOwner);
  old.cleanup(); rmSync(root, { recursive: true, force: true }); rmSync(staging, { recursive: true, force: true });
});

test('continuation rechecks swapped source marker after settlement callback', () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a');
  const old = createCodingWorkspace({ workflowRunId: 'old-marker-swap', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {}, recoveryWriterOwnerEvidence: ownerEvidence() });
  old.write('a.txt', 'b');
  const manifest = deaden(old.recoveryManifest());
  const originalMarker = readFileSync(manifest.markerPath, 'utf8');
  const out = createContinuationCodingWorkspace({ rawRetainedManifest: manifest, trustedScope: scope(manifest, staging), workflowRunId: 'new-marker-swap', recoveryWriterOwnerEvidence: ownerEvidence(), assertAuthority() {}, assertPreviousSettlement() { writeFileSync(manifest.markerPath, originalMarker.replace(manifest.markerOwner, `${manifest.markerOwner}-swapped`)); } });
  const blocked = expectBlocked(out);
  assert.match(blocked.error, /marker content mismatch|changed/i);
  writeFileSync(manifest.markerPath, originalMarker);
  old.cleanup(); rmSync(root, { recursive: true, force: true }); rmSync(staging, { recursive: true, force: true });
});

test('continuation preserves uncertain new manifest and does not settle after carry persist fault', () => {
  const { root, staging } = dirs(); file(root, 'a.txt', 'a');
  const old = createCodingWorkspace({ workflowRunId: 'old-persist-fault', projectRoot: root, stagingParent: staging, inputPaths: ['a.txt'], writablePaths: ['a.txt'], assertAuthority() {}, recoveryWriterOwnerEvidence: ownerEvidence() });
  old.write('a.txt', 'b');
  const manifest = deaden(old.recoveryManifest());
  let newStageWrites = 0;
  let thrown: any;
  try { createContinuationCodingWorkspace({ rawRetainedManifest: manifest, trustedScope: scope(manifest, staging), workflowRunId: 'new-persist-fault', recoveryWriterOwnerEvidence: ownerEvidence(), assertAuthority() {}, assertPreviousSettlement() {}, effectHooks: { afterEffect(obs) { if (obs.workflowRunId === 'new-persist-fault' && obs.kind === 'stage-write' && ++newStageWrites === 2) throw new Error('persist fault'); } } }); } catch (error) { thrown = error; }
  assert.ok(thrown);
  assert.match(String(thrown?.message), /persist fault/);
  assert.ok(thrown.lastKnownManifest);
  assert.ok(existsSync(thrown.lastKnownManifest.stageRoot));
  rmSync(root, { recursive: true, force: true }); rmSync(staging, { recursive: true, force: true });
});
