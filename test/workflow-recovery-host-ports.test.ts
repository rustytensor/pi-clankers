import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import ts from 'typescript';
import { createClankersStateContainer } from '../state.js';
import { createClankersPersistenceManager } from '../persistence.js';
import { WORKFLOW_EXTENSION_KEY, workflowHash, workflowStepEntries } from '../workflow-model.js';
import { profileHash as codingCheckProfileHash, runCodingCheck, inspectDurableCheckReceipt } from '../workflow-checks.js';

// Exercise exact private host code rather than introduce a public allocator authority seam.
const source = fs.readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
const names = new Set(['boundedReadJsonFileNoFollow', 'assertPrivateDirectoryNoFollow', 'fsyncOpenPath', 'assertUnder', 'exactStringKeys', 'inspectPreviousWorkflowOwner', 'createDefaultWorkflowCheckAllocator']);
const statements = parsed.statements.filter(node => (ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? '')) || (ts.isVariableStatement(node) && node.declarationList.declarations.some(d => ts.isIdentifier(d.name) && d.name.text.startsWith('HOST_CHECK_'))));
const code = ts.transpileModule(statements.map(node => node.getText(parsed)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const bindings = Object.fromEntries(Object.entries({ ...fs, ...path, fsConstants: fs.constants, resolvePath: path.resolve, randomBytes, randomUUID, workflowHash, workflowStepEntries, codingCheckProfileHash, WORKFLOW_EXTENSION_KEY }).filter(([key]) => key !== 'default'));
const helpers = new Function(...Object.keys(bindings), code + '\nreturn { allocate: createDefaultWorkflowCheckAllocator, inspect: inspectPreviousWorkflowOwner };')(...Object.values(bindings)) as {
  allocate: (container: ReturnType<typeof createClankersStateContainer>, manager: NonNullable<ReturnType<typeof createClankersPersistenceManager>>, config: any, owner: () => any) => (request: any) => import('../workflow-checks.js').DurableCheckReceiptConfig;
  inspect: (owner: any) => 'live' | 'dead' | 'unknown';
};

function fixture(t: import('node:test').TestContext) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'recovery-host-ports-'));
  const projectRoot = path.join(root, 'project'), stagingParent = path.join(root, 'stage');
  fs.mkdirSync(projectRoot, { mode: 0o700 }); fs.mkdirSync(stagingParent, { mode: 0o700 });
  const profile = { id: 'check', executable: process.execPath, argv: ['-e', 'process.exit(0)'], cwd: '.', env: {}, timeoutMs: 2000, outputBytes: 1024 };
  const spec = { id: 'check', kind: 'coding', coding: { operation: 'check', checkProfileId: 'check', policy: {} } };
  const candidateHash = createHash('sha256').update('candidate').digest('hex');
  const container = createClankersStateContainer({ extensions: { workflows: { version: 1, definitions: [], runs: [{ workflowRunId: 'run', status: 'running', definition: { version: 3, steps: [{ id: 'stage', kind: 'coding', coding: { operation: 'stage-write' } }, spec] }, steps: [{ id: 'stage', status: 'completed', units: [{ id: 'stage:0', status: 'completed', cleanupSettled: true, coding: { candidateHash } }] }, { id: 'check', status: 'running', units: [{ id: 'check:0', status: 'running', cleanupSettled: false, inputHash: 'a'.repeat(64), coding: { phase: 'check' } }] }], recovery: { operations: [{ kind: 'check', unitId: 'check:0', inputHash: 'a'.repeat(64), policyHash: workflowHash({ kind: spec.kind, coding: spec.coding, agentId: null }) }] } }] } } });
  const manager = createClankersPersistenceManager({ snapshotFile: path.join(root, 'state.json') })!;
  manager.save(container.snapshot());
  const ownership = manager.acquireRecoveryOwnership!();
  t.after(() => { manager.releaseRecoveryOwnership!(ownership.owner); fs.rmSync(root, { recursive: true, force: true }); });
  const config = { enabled: true, projectRoot, stagingParent, checkProfiles: { check: profile } };
  const allocate = helpers.allocate(container, manager, config, () => ownership.owner);
  const request = { workflowRunId: 'run', unitId: 'check:0', candidateHash, profileId: 'check', profileHash: codingCheckProfileHash(profile) };
  return { root, projectRoot, stagingParent, container, manager, ownership, config, allocate, request, profile };
}

test('host allocator is construction-inert and produces the actual four-field check marker contract', async t => {
  const f = fixture(t);
  assert.deepEqual(fs.readdirSync(f.stagingParent), []);
  const artifact = f.allocate(f.request);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(artifact.markerPath, 'utf8'))).sort(), ['candidateId', 'generation', 'nonce', 'profileId']);
  assert.equal(fs.statSync(artifact.receiptDir).mode & 0o777, 0o700);
  const result = await runCodingCheck({ profile: f.profile, stageRoot: f.projectRoot, expectedCandidateHash: f.request.candidateHash, captureCandidate: () => 'candidate', assertAuthority() {}, durable: { ...artifact, onIntent() {}, onSupervisorReady() {}, onReceipt() {} } });
  assert.equal(result.passed, true, JSON.stringify(result));
  assert.equal(result.durableReceipt?.generation, artifact.generation);
});

test('host allocation rejects readonly state and wrong check profile before mkdir', t => {
  const f = fixture(t);
  assert.throws(() => f.allocate({ ...f.request, profileHash: 'b'.repeat(64) }), /matching candidate|running coding unit/);
  f.container.update({ mode: { ...f.container.read().mode, readOnly: true } });
  assert.throws(() => f.allocate(f.request), /writable owner/);
  assert.deepEqual(fs.readdirSync(f.stagingParent), []);
});

test('existing unmarked managed receipt root is never adopted or repaired', t => {
  const f = fixture(t);
  const artifact = f.allocate(f.request), familyRoot = path.dirname(artifact.receiptDir);
  fs.unlinkSync(path.join(familyRoot, 'clankers-managed-root.json'));
  const before = fs.readdirSync(familyRoot);
  assert.throws(() => f.allocate(f.request), /ENOENT/);
  assert.deepEqual(fs.readdirSync(familyRoot), before);
  assert.equal(fs.existsSync(path.join(familyRoot, 'clankers-managed-root.json')), false);
});

test('receipt generation is rejected before path traversal can reach another file', t => {
  const f = fixture(t);
  const artifact = f.allocate(f.request);
  const bad = { ...artifact, generation: '../outside' };
  fs.writeFileSync(artifact.markerPath, JSON.stringify({ generation: bad.generation, nonce: artifact.nonce, candidateId: artifact.candidateId, profileId: artifact.profileId }), { mode: 0o600 });
  const result = inspectDurableCheckReceipt({ ...bad, profileHash: f.request.profileHash, expectedCandidateHash: f.request.candidateHash, candidateHashBefore: f.request.candidateHash, nodeIdentity: { bootId: f.ownership.owner.bootId, pid: process.pid, startTime: f.ownership.owner.startTimeTicks } });
  assert(result && 'blocked' in result);
  assert.match(result.error, /single safe path component/);
});

test('admitted checks may allocate while paused, but recovered runs cannot allocate', t => {
  const f = fixture(t);
  const change = (patch: Record<string, unknown>) => {
    const workflow = f.container.read().extensions[WORKFLOW_EXTENSION_KEY] as any;
    f.container.update({ extensions: { ...f.container.read().extensions, [WORKFLOW_EXTENSION_KEY]: { ...workflow, runs: [{ ...workflow.runs[0], ...patch }] } } });
    f.manager.save(f.container.snapshot());
  };
  change({ status: 'paused' });
  const artifact = f.allocate(f.request);
  assert.equal(fs.existsSync(artifact.markerPath), true);
  const before = fs.readdirSync(path.dirname(artifact.receiptDir));
  change({ status: 'running', recovered: true });
  assert.throws(() => f.allocate(f.request), /active running coding unit/);
  assert.deepEqual(fs.readdirSync(path.dirname(artifact.receiptDir)), before);
});

test('receipt allocation rechecks canonical authority after owner callbacks before creating files', t => {
  for (const change of ['mode', 'namespace', 'lifecycle']) {
    const f = fixture(t);
    const allocate = helpers.allocate(f.container, f.manager, f.config, () => {
      if (change === 'mode') f.container.update({ mode: { ...f.container.read().mode, readOnly: true } });
      else if (change === 'lifecycle') f.container.update({ lifecycle: 'disposed' });
      else {
        const workflow = f.container.read().extensions[WORKFLOW_EXTENSION_KEY] as any;
        f.container.update({ extensions: { ...f.container.read().extensions, [WORKFLOW_EXTENSION_KEY]: { ...workflow, runs: [{ ...workflow.runs[0], status: 'cancelled' }] } } });
      }
      return f.ownership.owner;
    });
    assert.throws(() => allocate(f.request), /authority changed during owner inspection/);
    assert.deepEqual(fs.readdirSync(f.stagingParent), []);
  }
});

test('private owner inspector rejects malformed tuples and distinguishes current live identity', t => {
  const f = fixture(t);
  assert.equal(helpers.inspect(f.ownership.owner), 'live');
  assert.equal(helpers.inspect({ ...f.ownership.owner, bootId: 'not-a-boot-id' }), 'unknown');
  assert.equal(helpers.inspect({ ...f.ownership.owner, startTimeTicks: 'not-ticks' }), 'unknown');
  const before = fs.readFileSync(path.join(f.root, 'state.json'));
  helpers.inspect(f.ownership.owner);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'state.json')), before);
});
