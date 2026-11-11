import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readFileSync as readOsFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { createClankersStateContainer } from '../state.js';
import { createWorkflowService } from '../workflow-runtime.js';
import { workflowHash } from '../workflow-model.js';
import { validateRecoveryCheckpoint } from '../workflow-recovery.js';
import type { WorkflowDefinition, WorkflowNativePort, WorkflowNativeRequest, WorkflowSchema } from '../workflow-model.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const str = (n = 160): WorkflowSchema => ({ type: 'string', maxLength: n });
const bool: WorkflowSchema = { type: 'boolean' };
const arr = (items: WorkflowSchema): WorkflowSchema => ({ type: 'array', maxItems: 8, items });
const obj = (properties: Record<string, WorkflowSchema>): WorkflowSchema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const turns = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise<void>(resolve => setImmediate(resolve)); };

test('recovery-enabled coding journals workspace effects and durable check receipts before effects', { timeout: 30000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wf-recovery-coding-root-'));
  const staging = mkdtempSync(join(tmpdir(), 'wf-recovery-coding-stage-'));
  const receipts = mkdtempSync(join(tmpdir(), 'wf-recovery-coding-receipts-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.txt'), 'old\n');
  const profileBase = { id: 'unit', executable: process.execPath, argv: ['-e', "const fs=require('fs'); if(fs.readFileSync('a.txt','utf8')!=='new\\n') process.exit(2)"], cwd: 'src', env: {}, timeoutMs: 10000, allowGeneratedOutputs: false as const };
  const trustedProfile = { id: 'unit', executable: process.execPath, argv: profileBase.argv, cwd: 'src', env: {}, timeoutMs: 10000, outputBytes: 65536, generatedOutputs: [] };
  const policy = { version: 3 as const, capabilities: ['investigate','stage-write','check','review','apply'] as Array<'investigate' | 'stage-write' | 'check' | 'review' | 'apply'>, identity: { parentRunId: 'parent', taskId: 'task', attemptNo: 1, rootAgentId: 'reviewer', workerAgentId: 'worker', model: 'fake/model' }, scope: { task: 'change old to new', writablePaths: ['src/a.txt'], baseline: { projectRootId: root, stateHash: sha('old\n') }, manifest: [{ path: 'src/a.txt', text: 'old\n', bytes: 4, sha256: sha('old\n') }] }, checkProfiles: [{ ...profileBase, profileHash: workflowHash(profileBase) }], reviewRequired: true };
  const def: WorkflowDefinition = { id: 'coding-recovery', version: 3, label: 'Coding recovery', inputSchema: obj({}), steps: [
    { id: 'investigate', kind: 'coding', dependsOn: [], inputs: {}, outputSchema: obj({ summary: str() }), coding: { operation: 'investigate', policy } },
    { id: 'stage', kind: 'coding', dependsOn: ['investigate'], inputs: {}, outputSchema: obj({ candidateHash: str(), changedPaths: arr(str()) }), coding: { operation: 'stage-write', policy } },
    { id: 'check', kind: 'coding', dependsOn: ['stage'], inputs: {}, outputSchema: obj({ passed: bool, profileId: str(), candidateHash: str() }), coding: { operation: 'check', policy, checkProfileId: 'unit' } },
    { id: 'review', kind: 'coding', dependsOn: ['check'], inputs: {}, outputSchema: obj({ passed: bool, candidateHash: str(), reviewer: str(), findings: arr(obj({})) }), coding: { operation: 'review', policy } },
    { id: 'apply', kind: 'coding', dependsOn: ['review'], inputs: {}, outputSchema: obj({ status: str(), candidateHash: str(), appliedPaths: arr(str()), rejectedPaths: arr(str()), diagnostics: arr(str()), outcomeHash: str() }), coding: { operation: 'apply', policy } },
  ] };
  const nativeEvents: string[] = [];
  const port: WorkflowNativePort = { preflight() {}, async execute(req: WorkflowNativeRequest) {
    nativeEvents.push(`native:${req.coding?.operation}`);
    const identity = { runId: `native-${nativeEvents.length}`, taskId: `task-${nativeEvents.length}` };
    req.onIdentity(identity);
    if (req.coding?.operation === 'investigate') { assert.equal(req.coding.read('src/a.txt'), 'old\n'); return { status: 'completed', text: JSON.stringify({ summary: 'ready' }), cleanupSettled: true, identity }; }
    if (req.coding?.operation === 'stage-write') req.coding.write('src/a.txt', 'new\n');
    if (req.coding?.operation === 'review') return { status: 'completed', text: JSON.stringify({ verdict: 'pass', findings: [] }), cleanupSettled: true, identity };
    return { status: 'completed', text: '{}', cleanupSettled: true, identity };
  } };
  const startTimeTicks = readOsFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ').pop()!.trim().split(/\s+/)[19];
  const bootId = readOsFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  const owner = { bootId, pid: process.pid, startTimeTicks, writerSessionId: 'writer', generation: 'owner-gen' };
  const container = createClankersStateContainer({ agentDefinitions: { worker: { id: 'worker', label: 'Worker', source: 'builtin', prompt: 'writer', model: 'fake/model', permissionMode: 'inherit' }, reviewer: { id: 'reviewer', label: 'Reviewer', source: 'builtin', prompt: 'review', model: 'fake/model', permissionMode: 'inherit' } } });
  let succeeded = false;
  const intentObservations: Array<{ kind: string; beforeMatches: boolean; rootProof: boolean }> = [];
  const unsubscribe = container.subscribe!(snapshot => {
    const runs = (snapshot.extensions.workflows as unknown as { runs: import('../workflow-model.js').WorkflowRun[] })?.runs ?? [];
    for (const run of runs) {
      const last = run.recovery?.operations.at(-1);
      if (!last || last.result || !['stage-write', 'application'].includes(last.kind)) continue;
      const unit = run.steps.flatMap(step => step.units).find(unit => unit.id === last.unitId);
      const workspace = unit?.coding?.workspace as { latestIntent?: { stageRoot?: string; stageRootIdentity?: unknown } } | undefined;
      const path = last.paths[0];
      const abs = join(last.kind === 'application' ? root : workspace?.latestIntent?.stageRoot ?? root, path);
      const current = existsSync(abs) ? sha(readFileSync(abs, 'utf8')) : null;
      intentObservations.push({ kind: last.kind, beforeMatches: current === last.preimage?.[path], rootProof: !!workspace?.latestIntent?.stageRootIdentity });
    }
  });
  const service = createWorkflowService(container, port, { idFactory: () => `wf-${randomBytes(4).toString('hex')}`, recovery: { enabled: true, durablePort: { ensureWriter: () => owner, inspectOwner: () => ({ snapshotFile: 'snapshot.json', lockDir: 'lock', claimDir: 'claim', expectedSnapshotHash: '0'.repeat(64), owner, ownerValid: true, claimPresent: false }) } }, coding: { enabled: true, projectRoot: root, stagingParent: staging, checkProfiles: { unit: trustedProfile }, allocateCheckReceipt: ({ workflowRunId, unitId, candidateHash, candidateId, profileId }) => { const dir = join(receipts, `${workflowRunId}-${unitId.replace(/[^A-Za-z0-9_.:-]/g, '-')}`); mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); const generation = randomUUID(); const nonce = randomBytes(24).toString('hex'); writeFileSync(join(dir, 'marker.json'), JSON.stringify({ generation, nonce, candidateId, profileId }), { mode: 0o600 }); return { receiptDir: dir, markerPath: join(dir, 'marker.json'), generation, nonce, candidateId, profileId }; } } });
  t.after(async () => {
    unsubscribe(); service.dispose();
    await service.drain().catch(() => {});
    if (succeeded) { for (const path of [root, staging, receipts]) rmSync(path, { recursive: true, force: true }); }
    else console.error('Retained coding journal test evidence', root, staging, receipts);
  });
  assert.equal((await service.execute({ action: 'workflows.define', definition: def })).ok, true);
  const started = await service.execute({ action: 'workflows.start', definitionId: def.id, inputs: {}, concurrency: 1 });
  assert(started.ok, started.error); await turns();
  let run = service.get(started.view!.workflowRunId)!;
  let impl = service.approvals.inspect().find(r => r.kind === 'implementation')!;
  service.approvals.grantFingerprint(impl.id, impl.requestHash); for (let i = 0; i < 200 && !service.approvals.inspect().some(r => r.kind === 'application') && service.get(started.view!.workflowRunId)!.status === 'running'; i++) await new Promise<void>(resolve => setTimeout(resolve, 20));
  const app = service.approvals.inspect().find(r => r.kind === 'application')!; assert(app, 'application approval requested');
  service.approvals.grantFingerprint(app.id, app.requestHash); await service.drain();
  run = service.get(started.view!.workflowRunId)!;
  assert.equal(run.status, 'completed'); assert.equal(readFileSync(join(root, 'src/a.txt'), 'utf8'), 'new\n');
  assert.equal(validateRecoveryCheckpoint(run.recovery).ok, true);
  const fresh = createWorkflowService(container, port, { recovery: { enabled: true, durablePort: { ensureWriter: () => owner, inspectOwner: () => ({ snapshotFile: 'snapshot.json', lockDir: 'lock', claimDir: 'claim', expectedSnapshotHash: '0'.repeat(64), owner, ownerValid: true, claimPresent: false }) } } });
  assert(fresh.get(started.view!.workflowRunId)); fresh.dispose();
  const ops = run.recovery!.operations;
  assert.equal(ops.filter(o => o.kind === 'stage-write').length, 2);
  assert.deepEqual(ops.filter(o => o.kind === 'stage-write').map(o => [o.paths, o.preimage, o.postimage]), [[[ 'src/a.txt' ], { 'src/a.txt': null }, { 'src/a.txt': sha('old\n') }], [[ 'src/a.txt' ], { 'src/a.txt': sha('old\n') }, { 'src/a.txt': sha('new\n') }]]);
  assert.equal(ops.some(o => o.kind === 'check'), true);
  assert.deepEqual(nativeEvents, ['native:investigate', 'native:stage-write', 'native:review']);
  assert.equal(ops.filter(op => op.kind === 'native').length, 2, 'only investigation and writer are native admissions; review is its own operation class');
  assert.equal(ops.filter(op => op.kind === 'application-gate').length, 1);
  assert.equal(ops.filter(op => op.kind === 'application').length, 1);
  assert.equal(run.recovery!.budget.usedAdmissions, 5);
  assert(intentObservations.length >= 3);
  assert(intentObservations.every(entry => entry.beforeMatches && entry.rootProof), 'file preimages and owned root proof are published before each effect');
  service.dispose();
  succeeded = true;
});
