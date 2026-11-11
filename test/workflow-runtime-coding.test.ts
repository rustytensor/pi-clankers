import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createClankersStateContainer } from '../state.js';
import { createWorkflowService } from '../workflow-runtime.js';
import { approvalRequestHash, createCodingApprovalRequest } from '../workflow-coding.js';
import { workflowHash } from '../workflow-model.js';
import type { WorkflowDefinition, WorkflowNativePort, WorkflowNativeRequest, WorkflowSchema } from '../workflow-model.js';

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const str = (n = 256): WorkflowSchema => ({ type: 'string', maxLength: n });
const bool: WorkflowSchema = { type: 'boolean' };
const arr = (item: WorkflowSchema): WorkflowSchema => ({ type: 'array', maxItems: 8, items: item });
const obj = (properties: Record<string, WorkflowSchema>): WorkflowSchema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
async function turns(n = 12) { for (let i = 0; i < n; i++) await new Promise<void>(resolve => setImmediate(resolve)); }

test('v3 coding waits for trusted grants, stages real files, checks, reviews and applies exact candidate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-coding-root-'));
  const staging = mkdtempSync(join(tmpdir(), 'wf-coding-stage-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.txt'), 'old\n');
  writeFileSync(join(root, 'src/untouched.txt'), 'keep\n');
  const profileBase = { id: 'unit', executable: process.execPath, argv: ['-e', "const fs=require('fs'); if(fs.readFileSync('a.txt','utf8')!=='new\\n') process.exit(2)"], cwd: 'src', env: {}, timeoutMs: 10_000, allowGeneratedOutputs: false as const };
  const policy = { version: 3 as const, capabilities: ['stage-write','check','review','apply'] as Array<'stage-write' | 'check' | 'review' | 'apply'>, identity: { parentRunId: 'parent', taskId: 'task', attemptNo: 1, rootAgentId: 'reviewer', workerAgentId: 'worker', model: 'fake/model' }, scope: { task: 'change old to new', writablePaths: ['src/a.txt'], readonlyPaths: ['src/untouched.txt'], baseline: { projectRootId: root, stateHash: sha('old\n') }, manifest: [{ path: 'src/a.txt', text: 'old\n', bytes: 4, sha256: sha('old\n') }] }, checkProfiles: [{ ...profileBase, profileHash: workflowHash(profileBase) }], reviewRequired: true };
  const stageOut = obj({ candidateHash: str(80), changedPaths: arr(str(128)) });
  const passOut = obj({ passed: bool, profileId: str(80), candidateHash: str(80) });
  const applyOut = obj({ status: str(16), candidateHash: str(80), appliedPaths: arr(str(128)), rejectedPaths: arr(str(128)), diagnostics: arr(str(256)), outcomeHash: str(80) });
  const def: WorkflowDefinition = { id: 'coding', version: 3, label: 'Coding', inputSchema: obj({}), steps: [
    { id: 'stage', kind: 'coding', dependsOn: [], inputs: {}, outputSchema: stageOut, coding: { operation: 'stage-write', policy } },
    { id: 'check', kind: 'coding', dependsOn: ['stage'], inputs: {}, outputSchema: passOut, coding: { operation: 'check', policy, checkProfileId: 'unit' } },
    { id: 'review', kind: 'coding', dependsOn: ['check'], inputs: {}, outputSchema: obj({ passed: bool, candidateHash: str(80), reviewer: str(160), findings: arr(obj({})) }), coding: { operation: 'review', policy } },
    { id: 'apply', kind: 'coding', dependsOn: ['review'], inputs: {}, outputSchema: applyOut, coding: { operation: 'apply', policy } },
  ] };
  const requests: WorkflowNativeRequest[] = [];
  const port: WorkflowNativePort = { preflight() {}, async execute(request) {
    requests.push(request); request.onIdentity({ runId: `native-${requests.length}`, taskId: `task-${requests.length}` });
    if (request.coding?.operation === 'stage-write') request.coding.write('src/a.txt', 'new\n');
    if (request.coding?.operation === 'review') return { status: 'completed', text: JSON.stringify({ verdict: 'pass', findings: [] }), cleanupSettled: true, identity: { runId: `native-${requests.length}`, taskId: `task-${requests.length}` } };
    return { status: 'completed', text: '{}', cleanupSettled: true, identity: { runId: `native-${requests.length}`, taskId: `task-${requests.length}` } };
  } };
  const container = createClankersStateContainer({ agentDefinitions: { worker: { id: 'worker', label: 'Worker', source: 'builtin', prompt: 'writer', model: 'fake/model', tools: ['read'], permissionMode: 'inherit' }, reviewer: { id: 'reviewer', label: 'Reviewer', source: 'builtin', prompt: 'review', model: 'fake/model', tools: ['read'], permissionMode: 'inherit' } } });
  const service = createWorkflowService(container, port, { idFactory: () => `wf-${Math.random().toString(16).slice(2)}`, coding: { enabled: true, projectRoot: root, stagingParent: staging, checkProfiles: { unit: { id: 'unit', executable: process.execPath, argv: profileBase.argv, cwd: 'src', env: {}, timeoutMs: 10_000, outputBytes: 65_536, generatedOutputs: [] } } } });
  assert.equal((await service.execute({ action: 'workflows.define', definition: def })).ok, true);
  const started = await service.execute({ action: 'workflows.start', definitionId: 'coding', inputs: {}, concurrency: 1 });
  assert(started.ok, started.error); await turns();
  assert.equal(requests.length, 0, 'approval pending holds no native/active permit');
  const runId = started.view!.workflowRunId;
  const impl = createCodingApprovalRequest('implementation', { ...policy, identity: { ...policy.identity, workflowRunId: runId } });
  const implInspection = service.approvals.inspect().find(r => r.kind === 'implementation')!;
  const implHash = implInspection.requestHash;
  assert.equal(implInspection.request.taskHash, impl.taskHash);
  assert.ok((implInspection.request as any).humanReview?.baseline?.hash);
  assert.equal(implHash, approvalRequestHash(implInspection.request as any));
  service.approvals.grantFingerprint(implInspection.id, implHash); await turns(20);
  assert.ok(requests[0], JSON.stringify(service.get(runId), null, 2));
  assert.equal(requests[0].coding?.operation, 'stage-write');
  for (let i = 0; i < 100 && !service.approvals.inspect().some(r => r.kind === 'application') && service.get(runId)!.status === 'running'; i++) await new Promise<void>(resolve => setTimeout(resolve, 20));
  const appInspection = service.approvals.inspect().find(r => r.kind === 'application');
  assert.ok(appInspection, JSON.stringify(service.get(runId), null, 2));
  const candidateHash = service.get(runId)!.steps[0].units[0].coding!.candidateHash!;
  const evidenceHash = service.get(runId)!.steps[2].units[0].coding!.evidenceHash!;
  const targetHash = workflowHash({ baseline: workflowHash({ projectRootId: root, stateHash: sha('old\n') }), candidate: candidateHash, changedPaths: ['src/a.txt'] });
  const app = createCodingApprovalRequest('application', { ...policy, identity: { ...policy.identity, workflowRunId: runId } }, { candidateHash, evidenceHash, targetHash }); void app;
  service.approvals.grantFingerprint(appInspection.id, appInspection.requestHash); await service.drain(); await turns();
  assert.equal(service.get(runId)!.status, 'completed');
  assert.equal(readFileSync(join(root, 'src/a.txt'), 'utf8'), 'new\n');
  assert.equal(readFileSync(join(root, 'src/untouched.txt'), 'utf8'), 'keep\n');
  service.dispose();
});

test('v3 coding creates a missing writable path that is also present in runtime input paths', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-coding-create-root-'));
  const staging = mkdtempSync(join(tmpdir(), 'wf-coding-create-stage-'));
  mkdirSync(join(root, 'src'));
  const profileBase = { id: 'unit', executable: process.execPath, argv: ['-e', "const fs=require('fs'); if(fs.readFileSync('new.txt','utf8')!=='created\\n') process.exit(2)"], cwd: 'src', env: {}, timeoutMs: 10_000, allowGeneratedOutputs: false as const };
  const policy = { version: 3 as const, capabilities: ['stage-write','check','review','apply'] as Array<'stage-write' | 'check' | 'review' | 'apply'>, identity: { parentRunId: 'parent', taskId: 'create', attemptNo: 1, rootAgentId: 'reviewer', workerAgentId: 'worker', model: 'fake/model' }, scope: { task: 'create src/new.txt', writablePaths: ['src/new.txt'], baseline: { projectRootId: root, stateHash: sha('missing') }, manifest: [{ path: 'src/new.txt', text: '', bytes: 0, sha256: sha('') }] }, checkProfiles: [{ ...profileBase, profileHash: workflowHash(profileBase) }], reviewRequired: true };
  const def: WorkflowDefinition = { id: 'coding-create', version: 3, label: 'Create', inputSchema: obj({}), steps: [
    { id: 'stage', kind: 'coding', dependsOn: [], inputs: {}, outputSchema: obj({ candidateHash: str(80), changedPaths: arr(str(128)) }), coding: { operation: 'stage-write', policy } },
    { id: 'check', kind: 'coding', dependsOn: ['stage'], inputs: {}, outputSchema: obj({ passed: bool, profileId: str(80), candidateHash: str(80) }), coding: { operation: 'check', policy, checkProfileId: 'unit' } },
    { id: 'review', kind: 'coding', dependsOn: ['check'], inputs: {}, outputSchema: obj({ passed: bool, candidateHash: str(80), reviewer: str(160), findings: arr(obj({})) }), coding: { operation: 'review', policy } },
    { id: 'apply', kind: 'coding', dependsOn: ['review'], inputs: {}, outputSchema: obj({ status: str(16), candidateHash: str(80), appliedPaths: arr(str(128)), rejectedPaths: arr(str(128)), diagnostics: arr(str(256)), outcomeHash: str(80) }), coding: { operation: 'apply', policy } },
  ] };
  const port: WorkflowNativePort = { preflight() {}, async execute(request) {
    const identity = { runId: `create-${request.coding?.operation}`, taskId: `task-${request.unitId}`.replace(/[^A-Za-z0-9_.:-]/g, '-') };
    request.onIdentity(identity);
    if (request.coding?.operation === 'stage-write') request.coding.write('src/new.txt', 'created\n');
    if (request.coding?.operation === 'review') return { status: 'completed', text: JSON.stringify({ verdict: 'pass', findings: [] }), cleanupSettled: true, identity };
    return { status: 'completed', text: '{}', cleanupSettled: true, identity };
  } };
  const container = createClankersStateContainer({ agentDefinitions: { worker: { id: 'worker', label: 'Worker', source: 'builtin', prompt: 'writer', model: 'fake/model', permissionMode: 'inherit' }, reviewer: { id: 'reviewer', label: 'Reviewer', source: 'builtin', prompt: 'review', model: 'fake/model', permissionMode: 'inherit' } } });
  const service = createWorkflowService(container, port, { idFactory: () => `wf-${Math.random().toString(16).slice(2)}`, coding: { enabled: true, projectRoot: root, stagingParent: staging, checkProfiles: { unit: { id: 'unit', executable: process.execPath, argv: profileBase.argv, cwd: 'src', env: {}, timeoutMs: 10_000, outputBytes: 65_536, generatedOutputs: [] } } } });
  const defined = await service.execute({ action: 'workflows.define', definition: def });
  assert(defined.ok, defined.error);
  const started = await service.execute({ action: 'workflows.start', definitionId: 'coding-create', inputs: {}, concurrency: 1 });
  assert(started.ok, started.error); await turns();
  const impl = service.approvals.inspect().find(r => r.kind === 'implementation')!; service.approvals.grantFingerprint(impl.id, impl.requestHash);
  for (let i = 0; i < 200 && !service.approvals.inspect().some(r => r.kind === 'application') && service.get(started.view!.workflowRunId)!.status === 'running'; i++) await new Promise<void>(resolve => setTimeout(resolve, 20));
  const app = service.approvals.inspect().find(r => r.kind === 'application')!; service.approvals.grantFingerprint(app.id, app.requestHash); await service.drain(); await turns();
  assert.equal(service.get(started.view!.workflowRunId)!.status, 'completed', JSON.stringify(service.get(started.view!.workflowRunId), null, 2));
  assert.equal(readFileSync(join(root, 'src/new.txt'), 'utf8'), 'created\n');
  service.dispose();
});

test('v3 coding repeat accepts review correction feedback before application gate', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-coding-repeat-root-'));
  const staging = mkdtempSync(join(tmpdir(), 'wf-coding-repeat-stage-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.txt'), 'old\n');
  const profileBase = { id: 'unit', executable: process.execPath, argv: ['-e', "const fs=require('fs'); if(fs.readFileSync('a.txt','utf8')!=='new\\n') process.exit(2)"], cwd: 'src', env: {}, timeoutMs: 10_000, allowGeneratedOutputs: false as const };
  const policy = { version: 3 as const, capabilities: ['stage-write','check','review','apply'] as Array<'stage-write' | 'check' | 'review' | 'apply'>, identity: { parentRunId: 'parent', taskId: 'repeat', attemptNo: 1, rootAgentId: 'reviewer', workerAgentId: 'worker', model: 'fake/model' }, scope: { task: 'repeat until review passes', writablePaths: ['src/a.txt'], baseline: { projectRootId: root, stateHash: sha('old\n') }, manifest: [{ path: 'src/a.txt', text: 'old\n', bytes: 4, sha256: sha('old\n') }] }, checkProfiles: [{ ...profileBase, profileHash: workflowHash(profileBase) }], reviewRequired: true };
  const stageOut = obj({ candidateHash: str(80), changedPaths: arr(str(128)) });
  const passOut = obj({ passed: bool, profileId: str(80), candidateHash: str(80) });
  const reviewOut = obj({ passed: bool, candidateHash: str(80), reviewer: str(160), findings: arr(obj({ id: str(20), severity: str(10), path: str(128), message: str(256) })) });
  const applyOut = obj({ status: str(16), candidateHash: str(80), appliedPaths: arr(str(128)), rejectedPaths: arr(str(128)), diagnostics: arr(str(256)), outcomeHash: str(80) });
  const def: WorkflowDefinition = { id: 'coding-repeat', version: 3, label: 'Coding repeat', inputSchema: obj({}), steps: [
    { id: 'loop', kind: 'repeat', dependsOn: [], initial: { value: { passed: false, candidateHash: '', reviewer: '', findings: [] } }, stateSchema: reviewOut, maxIterations: 2,
      body: [
        { id: 'stage', kind: 'coding', dependsOn: [], inputs: {}, outputSchema: stageOut, coding: { operation: 'stage-write', policy } },
        { id: 'check', kind: 'coding', dependsOn: ['stage'], inputs: {}, outputSchema: passOut, coding: { operation: 'check', policy, checkProfileId: 'unit' } },
        { id: 'review', kind: 'coding', dependsOn: ['check'], inputs: {}, outputSchema: reviewOut, coding: { operation: 'review', policy } },
      ], feedback: { ref: { source: 'step', stepId: 'review', path: [] } }, until: { op: 'boolean', value: { ref: { source: 'iteration', path: ['passed'] } } }, output: { ref: { source: 'iteration', path: [] } }, outputSchema: reviewOut },
    { id: 'apply', kind: 'coding', dependsOn: ['loop'], inputs: {}, outputSchema: applyOut, coding: { operation: 'apply', policy } },
  ] };
  let writes = 0, reviews = 0;
  const port: WorkflowNativePort = { preflight() {}, async execute(request) {
    const announced = { runId: `repeat-native-${writes}-${reviews}-${request.coding?.operation}`, taskId: `repeat-task-${writes}-${reviews}-${request.unitId.replace(/[^A-Za-z0-9_.:-]/g, '-')}` };
    request.onIdentity(announced);
    if (request.coding?.operation === 'stage-write') { writes++; request.coding.write('src/a.txt', 'new\n'); }
    if (request.coding?.operation === 'review') { reviews++; return { status: 'completed', text: JSON.stringify(reviews === 1 ? { verdict: 'fail', findings: [{ id: 'f1', severity: 'high', path: 'src/a.txt', message: 'not good' }] } : { verdict: 'pass', findings: [] }), cleanupSettled: true, identity: announced }; }
    return { status: 'completed', text: '{}', cleanupSettled: true, identity: announced };
  } };
  const container = createClankersStateContainer({ agentDefinitions: { worker: { id: 'worker', label: 'Worker', source: 'builtin', prompt: 'writer', model: 'fake/model', permissionMode: 'inherit' }, reviewer: { id: 'reviewer', label: 'Reviewer', source: 'builtin', prompt: 'review', model: 'fake/model', permissionMode: 'inherit' } } });
  const service = createWorkflowService(container, port, { idFactory: () => `wf-${Math.random().toString(16).slice(2)}`, coding: { enabled: true, projectRoot: root, stagingParent: staging, checkProfiles: { unit: { id: 'unit', executable: process.execPath, argv: profileBase.argv, cwd: 'src', env: {}, timeoutMs: 10_000, outputBytes: 65_536, generatedOutputs: [] } } } });
  assert.equal((await service.execute({ action: 'workflows.define', definition: def })).ok, true);
  const started = await service.execute({ action: 'workflows.start', definitionId: 'coding-repeat', inputs: {}, concurrency: 1 });
  assert(started.ok, started.error); await turns();
  const impl = service.approvals.inspect().find(r => r.kind === 'implementation')!;
  service.approvals.grantFingerprint(impl.id, impl.requestHash);
  const runId = started.view!.workflowRunId;
  for (let i = 0; i < 200 && !service.approvals.inspect().some(r => r.kind === 'application') && service.get(runId)!.status === 'running'; i++) await new Promise<void>(resolve => setTimeout(resolve, 20));
  assert.equal(reviews, 2, JSON.stringify(service.get(runId), null, 2));
  const app = service.approvals.inspect().find(r => r.kind === 'application')!;
  service.approvals.grantFingerprint(app.id, app.requestHash); await service.drain(); await turns();
  assert.equal(service.get(runId)!.status, 'completed', JSON.stringify(service.get(runId), null, 2));
  assert.equal(readFileSync(join(root, 'src/a.txt'), 'utf8'), 'new\n');
  service.dispose();
});


test('v3 coding rejects divergent trusted check profile before execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-coding-diverge-root-'));
  const staging = mkdtempSync(join(tmpdir(), 'wf-coding-diverge-stage-'));
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/a.txt'), 'old\n');
  const profileBase = { id: 'unit', executable: process.execPath, argv: ['-e', 'process.exit(0)'], cwd: 'src', env: {}, timeoutMs: 10_000, allowGeneratedOutputs: false as const };
  const policy = { version: 3 as const, capabilities: ['stage-write','check'] as Array<'stage-write' | 'check'>, identity: { parentRunId: 'parent', taskId: 'diverge', attemptNo: 1, rootAgentId: 'reviewer', workerAgentId: 'worker', model: 'fake/model' }, scope: { task: 'change old to new', writablePaths: ['src/a.txt'], baseline: { projectRootId: root, stateHash: sha('old\n') }, manifest: [{ path: 'src/a.txt', text: 'old\n', bytes: 4, sha256: sha('old\n') }] }, checkProfiles: [{ ...profileBase, profileHash: workflowHash(profileBase) }], reviewRequired: false };
  const def: WorkflowDefinition = { id: 'coding-diverge', version: 3, label: 'Diverge', inputSchema: obj({}), steps: [
    { id: 'stage', kind: 'coding', dependsOn: [], inputs: {}, outputSchema: obj({ candidateHash: str(80), changedPaths: arr(str(128)) }), coding: { operation: 'stage-write', policy } },
    { id: 'check', kind: 'coding', dependsOn: ['stage'], inputs: {}, outputSchema: obj({ passed: bool, profileId: str(80), candidateHash: str(80) }), coding: { operation: 'check', policy, checkProfileId: 'unit' } },
  ] };
  let checkExecuted = false;
  const port: WorkflowNativePort = { preflight() {}, async execute(request) { request.onIdentity({ runId: `diverge-${request.coding?.operation}`, taskId: `task-${request.unitId}`.replace(/[^A-Za-z0-9_.:-]/g, '-') }); if (request.coding?.operation === 'stage-write') request.coding.write('src/a.txt', 'new\n'); if (request.coding?.operation === 'check') checkExecuted = true; return { status: 'completed', text: '{}', cleanupSettled: true }; } };
  const container = createClankersStateContainer({ agentDefinitions: { worker: { id: 'worker', label: 'Worker', source: 'builtin', prompt: 'writer', model: 'fake/model', permissionMode: 'inherit' }, reviewer: { id: 'reviewer', label: 'Reviewer', source: 'builtin', prompt: 'review', model: 'fake/model', permissionMode: 'inherit' } } });
  const service = createWorkflowService(container, port, { idFactory: () => `wf-${Math.random().toString(16).slice(2)}`, coding: { enabled: true, projectRoot: root, stagingParent: staging, checkProfiles: { unit: { id: 'unit', executable: process.execPath, argv: ['-e', 'process.exit(9)'], cwd: 'src', env: {}, timeoutMs: 10_000, outputBytes: 65_536, generatedOutputs: [] } } } });
  assert.equal((await service.execute({ action: 'workflows.define', definition: def })).ok, true);
  const started = await service.execute({ action: 'workflows.start', definitionId: 'coding-diverge', inputs: {}, concurrency: 1 }); assert(started.ok, started.error); await turns();
  const impl = service.approvals.inspect().find(r => r.kind === 'implementation')!; service.approvals.grantFingerprint(impl.id, impl.requestHash); await service.drain(); await turns();
  const run = service.get(started.view!.workflowRunId)!; assert.equal(run.status, 'failed'); assert.equal(checkExecuted, false); assert.match(JSON.stringify(run), /Trusted check profile does not exactly match approved profile/); service.dispose();
});

test('v3 failed writer does not invent dummy native identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-coding-failed-writer-root-'));
  const staging = mkdtempSync(join(tmpdir(), 'wf-coding-failed-writer-stage-'));
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/a.txt'), 'old\n');
  const policy = { version: 3 as const, capabilities: ['stage-write'] as Array<'stage-write'>, identity: { parentRunId: 'parent', taskId: 'failwriter', attemptNo: 1, rootAgentId: 'reviewer', workerAgentId: 'worker', model: 'fake/model' }, scope: { task: 'fail before identity', writablePaths: ['src/a.txt'], baseline: { projectRootId: root, stateHash: sha('old\n') }, manifest: [{ path: 'src/a.txt', text: 'old\n', bytes: 4, sha256: sha('old\n') }] }, reviewRequired: false };
  const def: WorkflowDefinition = { id: 'coding-failed-writer', version: 3, label: 'Failed writer', inputSchema: obj({}), steps: [{ id: 'stage', kind: 'coding', dependsOn: [], inputs: {}, outputSchema: obj({ candidateHash: str(80), changedPaths: arr(str(128)) }), coding: { operation: 'stage-write', policy } }] };
  const port: WorkflowNativePort = { preflight() {}, async execute() { return { status: 'failed', error: 'writer failed honestly', cleanupSettled: true }; } };
  const container = createClankersStateContainer({ agentDefinitions: { worker: { id: 'worker', label: 'Worker', source: 'builtin', prompt: 'writer', model: 'fake/model', permissionMode: 'inherit' }, reviewer: { id: 'reviewer', label: 'Reviewer', source: 'builtin', prompt: 'review', model: 'fake/model', permissionMode: 'inherit' } } });
  const service = createWorkflowService(container, port, { idFactory: () => `wf-${Math.random().toString(16).slice(2)}`, coding: { enabled: true, projectRoot: root, stagingParent: staging } });
  assert.equal((await service.execute({ action: 'workflows.define', definition: def })).ok, true);
  const started = await service.execute({ action: 'workflows.start', definitionId: 'coding-failed-writer', inputs: {}, concurrency: 1 }); assert(started.ok, started.error); await turns();
  const impl = service.approvals.inspect().find(r => r.kind === 'implementation')!; service.approvals.grantFingerprint(impl.id, impl.requestHash); await service.drain(); await turns();
  const unit = service.get(started.view!.workflowRunId)!.steps[0].units[0]; assert.equal(unit.status, 'failed'); assert.equal(unit.native, undefined); assert.match(unit.error ?? '', /did not complete/); service.dispose();
});

test('v3 coding failed required check enters bounded repeat correction and scripted review pass cannot bypass gates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-coding-check-repeat-root-'));
  const staging = mkdtempSync(join(tmpdir(), 'wf-coding-check-repeat-stage-'));
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/a.txt'), 'old\n');
  const profileBase = { id: 'unit', executable: process.execPath, argv: ['-e', "const fs=require('fs'); if(fs.readFileSync('a.txt','utf8')!=='good\\n') process.exit(7)"], cwd: 'src', env: {}, timeoutMs: 10_000, allowGeneratedOutputs: false as const };
  const policy = { version: 3 as const, capabilities: ['stage-write','check','review','apply'] as Array<'stage-write' | 'check' | 'review' | 'apply'>, identity: { parentRunId: 'parent', taskId: 'failedcheck-repeat', attemptNo: 1, rootAgentId: 'reviewer', workerAgentId: 'worker', model: 'fake/model' }, scope: { task: 'first bad then good', writablePaths: ['src/a.txt'], baseline: { projectRootId: root, stateHash: sha('old\n') }, manifest: [{ path: 'src/a.txt', text: 'old\n', bytes: 4, sha256: sha('old\n') }] }, checkProfiles: [{ ...profileBase, profileHash: workflowHash(profileBase) }], reviewRequired: true };
  const stageOut = obj({ candidateHash: str(80), changedPaths: arr(str(128)) });
  const passOut = obj({ passed: bool, profileId: str(80), candidateHash: str(80) });
  const reviewOut = obj({ passed: bool, candidateHash: str(80), reviewer: str(160), findings: arr(obj({ id: str(20), severity: str(10), path: str(128), message: str(256) })) });
  const applyOut = obj({ status: str(16), candidateHash: str(80), appliedPaths: arr(str(128)), rejectedPaths: arr(str(128)), diagnostics: arr(str(256)), outcomeHash: str(80) });
  const def: WorkflowDefinition = { id: 'failed-check-repeat', version: 3, label: 'Failed check repeat', inputSchema: obj({}), steps: [
    { id: 'loop', kind: 'repeat', dependsOn: [], initial: { value: { passed: false, candidateHash: '', reviewer: '', findings: [] } }, stateSchema: reviewOut, maxIterations: 2,
      body: [
        { id: 'stage', kind: 'coding', dependsOn: [], inputs: {}, outputSchema: stageOut, coding: { operation: 'stage-write', policy } },
        { id: 'check', kind: 'coding', dependsOn: ['stage'], inputs: {}, outputSchema: passOut, coding: { operation: 'check', policy, checkProfileId: 'unit' } },
        { id: 'review', kind: 'coding', dependsOn: ['check'], inputs: {}, outputSchema: reviewOut, coding: { operation: 'review', policy } },
      ], feedback: { ref: { source: 'step', stepId: 'review', path: [] } }, until: { op: 'boolean', value: { ref: { source: 'iteration', path: ['passed'] } } }, output: { ref: { source: 'iteration', path: [] } }, outputSchema: reviewOut },
    { id: 'apply', kind: 'coding', dependsOn: ['loop'], inputs: {}, outputSchema: applyOut, coding: { operation: 'apply', policy } },
  ] };
  let writes = 0, reviews = 0; const prompts: string[] = [];
  const port: WorkflowNativePort = { preflight() {}, async execute(request) {
    const identity = { runId: `fc-${request.coding?.operation}-${writes}-${reviews}-${request.unitId}`.replace(/[^A-Za-z0-9_.:-]/g, '-'), taskId: `fct-${request.unitId}`.replace(/[^A-Za-z0-9_.:-]/g, '-') };
    request.onIdentity(identity);
    if (request.coding?.operation === 'stage-write') { prompts.push(request.prompt); writes++; request.coding.write('src/a.txt', writes === 1 ? 'bad\n' : 'good\n'); }
    if (request.coding?.operation === 'review') { reviews++; return { status: 'completed', text: JSON.stringify({ verdict: 'pass', findings: [] }), cleanupSettled: true, identity }; }
    return { status: 'completed', text: '{}', cleanupSettled: true, identity };
  } };
  const container = createClankersStateContainer({ agentDefinitions: { worker: { id: 'worker', label: 'Worker', source: 'builtin', prompt: 'writer', model: 'fake/model', permissionMode: 'inherit' }, reviewer: { id: 'reviewer', label: 'Reviewer', source: 'builtin', prompt: 'review', model: 'fake/model', permissionMode: 'inherit' } } });
  const service = createWorkflowService(container, port, { idFactory: () => `wf-${Math.random().toString(16).slice(2)}`, coding: { enabled: true, projectRoot: root, stagingParent: staging, checkProfiles: { unit: { id: 'unit', executable: process.execPath, argv: profileBase.argv, cwd: 'src', env: {}, timeoutMs: 10_000, outputBytes: 65_536, generatedOutputs: [] } } } });
  assert.equal((await service.execute({ action: 'workflows.define', definition: def })).ok, true);
  const started = await service.execute({ action: 'workflows.start', definitionId: 'failed-check-repeat', inputs: {}, concurrency: 1 }); assert(started.ok, started.error); await turns();
  const impl = service.approvals.inspect().find(r => r.kind === 'implementation')!; service.approvals.grantFingerprint(impl.id, impl.requestHash);
  const runId = started.view!.workflowRunId;
  for (let i = 0; i < 200 && !service.approvals.inspect().some(r => r.kind === 'application') && service.get(runId)!.status === 'running'; i++) await new Promise<void>(resolve => setTimeout(resolve, 20));
  assert.equal(writes, 2, JSON.stringify(service.get(runId), null, 2)); assert.equal(reviews, 2); assert.match(prompts[1]!, /previousFeedback/); assert.match(prompts[1]!, /bad\\n/);
  const firstReview = service.get(runId)!.steps[0].iterations![0].steps[2].output as any; assert.equal(firstReview.passed, false, 'scripted review pass is forced false while required check failed');
  const app = service.approvals.inspect().find(r => r.kind === 'application')!; service.approvals.grantFingerprint(app.id, app.requestHash); await service.drain(); await turns();
  assert.equal(service.get(runId)!.status, 'completed', JSON.stringify(service.get(runId), null, 2)); assert.equal(readFileSync(join(root, 'src/a.txt'), 'utf8'), 'good\n'); service.dispose();
});

test('v3 coding required check failures outside convergence fail safely and retain evidence', async () => {
  async function runCase(kind: 'outside' | 'exhaust' | 'timeout') {
    const root = mkdtempSync(join(tmpdir(), `wf-coding-${kind}-root-`)); const staging = mkdtempSync(join(tmpdir(), `wf-coding-${kind}-stage-`));
    mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/a.txt'), 'old\n');
    const argv = kind === 'timeout' ? ['-e', 'setInterval(()=>{},1000)'] : ['-e', "const fs=require('fs'); if(fs.readFileSync('a.txt','utf8')!=='good\\n') process.exit(7)"];
    const profileBase = { id: 'unit', executable: process.execPath, argv, cwd: 'src', env: {}, timeoutMs: kind === 'timeout' ? 20 : 10_000, allowGeneratedOutputs: false as const };
    const policy = { version: 3 as const, capabilities: ['stage-write','check','review'] as Array<'stage-write' | 'check' | 'review'>, identity: { parentRunId: 'parent', taskId: kind, attemptNo: 1, rootAgentId: 'reviewer', workerAgentId: 'worker', model: 'fake/model' }, scope: { task: kind, writablePaths: ['src/a.txt'], baseline: { projectRootId: root, stateHash: sha('old\n') }, manifest: [{ path: 'src/a.txt', text: 'old\n', bytes: 4, sha256: sha('old\n') }] }, checkProfiles: [{ ...profileBase, profileHash: workflowHash(profileBase) }], reviewRequired: true };
    const stageOut = obj({ candidateHash: str(80), changedPaths: arr(str(128)) }); const passOut = obj({ passed: bool, profileId: str(80), candidateHash: str(80) }); const reviewOut = obj({ passed: bool, candidateHash: str(80), reviewer: str(160), findings: arr(obj({})) });
    const body = [ { id: 'stage', kind: 'coding' as const, dependsOn: [], inputs: {}, outputSchema: stageOut, coding: { operation: 'stage-write' as const, policy } }, { id: 'check', kind: 'coding' as const, dependsOn: ['stage'], inputs: {}, outputSchema: passOut, coding: { operation: 'check' as const, policy, checkProfileId: 'unit' } }, { id: 'review', kind: 'coding' as const, dependsOn: ['check'], inputs: {}, outputSchema: reviewOut, coding: { operation: 'review' as const, policy } } ];
    const def: WorkflowDefinition = kind === 'outside' || kind === 'timeout' ? { id: kind, version: 3, label: kind, inputSchema: obj({}), steps: body } : { id: kind, version: 3, label: kind, inputSchema: obj({}), steps: [{ id: 'loop', kind: 'repeat', dependsOn: [], initial: { value: { passed: false, candidateHash: '', reviewer: '', findings: [] } }, stateSchema: reviewOut, maxIterations: 1, body, feedback: { ref: { source: 'step', stepId: 'review', path: [] } }, until: { op: 'boolean', value: { ref: { source: 'iteration', path: ['passed'] } } }, output: { ref: { source: 'iteration', path: [] } }, outputSchema: reviewOut }] };
    let reviews = 0; const port: WorkflowNativePort = { preflight() {}, async execute(request) { const identity = { runId: `${kind}-${request.coding?.operation}-${request.unitId}`.replace(/[^A-Za-z0-9_.:-]/g, '-'), taskId: `t-${kind}-${request.unitId}`.replace(/[^A-Za-z0-9_.:-]/g, '-') }; request.onIdentity(identity); if (request.coding?.operation === 'stage-write') request.coding.write('src/a.txt', 'bad\n'); if (request.coding?.operation === 'review') { reviews++; return { status: 'completed', text: JSON.stringify({ verdict: 'pass', findings: [] }), cleanupSettled: true, identity }; } return { status: 'completed', text: '{}', cleanupSettled: true, identity }; } };
    const container = createClankersStateContainer({ agentDefinitions: { worker: { id: 'worker', label: 'Worker', source: 'builtin', prompt: 'writer', model: 'fake/model', permissionMode: 'inherit' }, reviewer: { id: 'reviewer', label: 'Reviewer', source: 'builtin', prompt: 'review', model: 'fake/model', permissionMode: 'inherit' } } });
    const service = createWorkflowService(container, port, { idFactory: () => `wf-${Math.random().toString(16).slice(2)}`, coding: { enabled: true, projectRoot: root, stagingParent: staging, checkProfiles: { unit: { id: 'unit', executable: process.execPath, argv, cwd: 'src', env: {}, timeoutMs: profileBase.timeoutMs, outputBytes: 65_536, generatedOutputs: [] } } } });
    assert.equal((await service.execute({ action: 'workflows.define', definition: def })).ok, true); const started = await service.execute({ action: 'workflows.start', definitionId: kind, inputs: {}, concurrency: 1 }); assert(started.ok, started.error); await turns(); const impl = service.approvals.inspect().find(r => r.kind === 'implementation')!; service.approvals.grantFingerprint(impl.id, impl.requestHash); await service.drain(); await turns(30); const run = service.get(started.view!.workflowRunId)!; service.dispose(); return { run, reviews };
  }
  const outside = await runCase('outside'); assert.equal(outside.run.status, 'failed'); assert.equal((outside.run.steps[2].output as any).passed, false);
  const exhausted = await runCase('exhaust'); assert.equal(exhausted.run.status, 'failed'); assert.match(JSON.stringify(exhausted.run), /check exited non-zero/); assert.match(JSON.stringify(exhausted.run), /candidateHash/);
  const timeout = await runCase('timeout'); assert.equal(timeout.run.status, 'failed'); assert.equal(timeout.reviews, 0, 'timeout/cleanup-uncertain check failure must not reach readiness review'); assert.equal(timeout.run.cleanupSettled, true);
});

test('v3 coding stale target after pending application grant fails settled, invalidates approval, and preserves newer bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-coding-stale-root-'));
  const staging = mkdtempSync(join(tmpdir(), 'wf-coding-stale-stage-'));
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/a.txt'), 'original1\n');
  const profileBase = { id: 'unit', executable: process.execPath, argv: ['-e', "const fs=require('fs'); if(fs.readFileSync('a.txt','utf8')!=='candidate2\\n') process.exit(2)"], cwd: 'src', env: {}, timeoutMs: 10_000, allowGeneratedOutputs: false as const };
  const policy = { version: 3 as const, capabilities: ['stage-write','check','review','apply'] as Array<'stage-write' | 'check' | 'review' | 'apply'>, identity: { parentRunId: 'parent', taskId: 'stale', attemptNo: 1, rootAgentId: 'reviewer', workerAgentId: 'worker', model: 'fake/model' }, scope: { task: 'stage candidate2', writablePaths: ['src/a.txt'], baseline: { projectRootId: root, stateHash: sha('original1\n') }, manifest: [{ path: 'src/a.txt', text: 'original1\n', bytes: 10, sha256: sha('original1\n') }] }, checkProfiles: [{ ...profileBase, profileHash: workflowHash(profileBase) }], reviewRequired: true };
  const def: WorkflowDefinition = { id: 'coding-stale-apply', version: 3, label: 'Stale apply', inputSchema: obj({}), steps: [
    { id: 'stage', kind: 'coding', dependsOn: [], inputs: {}, outputSchema: obj({ candidateHash: str(80), changedPaths: arr(str(128)) }), coding: { operation: 'stage-write', policy } },
    { id: 'check', kind: 'coding', dependsOn: ['stage'], inputs: {}, outputSchema: obj({ passed: bool, profileId: str(80), candidateHash: str(80) }), coding: { operation: 'check', policy, checkProfileId: 'unit' } },
    { id: 'review', kind: 'coding', dependsOn: ['check'], inputs: {}, outputSchema: obj({ passed: bool, candidateHash: str(80), reviewer: str(160), findings: arr(obj({})) }), coding: { operation: 'review', policy } },
    { id: 'apply', kind: 'coding', dependsOn: ['review'], inputs: {}, outputSchema: obj({ status: str(16), candidateHash: str(80), appliedPaths: arr(str(128)), rejectedPaths: arr(str(128)), diagnostics: arr(str(256)), outcomeHash: str(80) }), coding: { operation: 'apply', policy } },
  ] };
  const port: WorkflowNativePort = { preflight() {}, async execute(request) { const identity = { runId: `stale-${request.coding?.operation}`, taskId: `stale-${request.unitId}`.replace(/[^A-Za-z0-9_.:-]/g, '-') }; request.onIdentity(identity); if (request.coding?.operation === 'stage-write') request.coding.write('src/a.txt', 'candidate2\n'); if (request.coding?.operation === 'review') return { status: 'completed', text: JSON.stringify({ verdict: 'pass', findings: [] }), cleanupSettled: true, identity }; return { status: 'completed', text: '{}', cleanupSettled: true, identity }; } };
  const container = createClankersStateContainer({ agentDefinitions: { worker: { id: 'worker', label: 'Worker', source: 'builtin', prompt: 'writer', model: 'fake/model', permissionMode: 'inherit' }, reviewer: { id: 'reviewer', label: 'Reviewer', source: 'builtin', prompt: 'review', model: 'fake/model', permissionMode: 'inherit' } } });
  const service = createWorkflowService(container, port, { idFactory: () => `wf-${Math.random().toString(16).slice(2)}`, coding: { enabled: true, projectRoot: root, stagingParent: staging, checkProfiles: { unit: { id: 'unit', executable: process.execPath, argv: profileBase.argv, cwd: 'src', env: {}, timeoutMs: 10_000, outputBytes: 65_536, generatedOutputs: [] } } } });
  assert.equal((await service.execute({ action: 'workflows.define', definition: def })).ok, true);
  const started = await service.execute({ action: 'workflows.start', definitionId: 'coding-stale-apply', inputs: {}, concurrency: 1 }); assert(started.ok, started.error); await turns();
  const impl = service.approvals.inspect().find(r => r.kind === 'implementation')!; service.approvals.grantFingerprint(impl.id, impl.requestHash);
  const runId = started.view!.workflowRunId;
  for (let i = 0; i < 200 && !service.approvals.inspect().some(r => r.kind === 'application') && service.get(runId)!.status === 'running'; i++) await new Promise<void>(resolve => setTimeout(resolve, 20));
  const app = service.approvals.inspect().find(r => r.kind === 'application')!;
  writeFileSync(join(root, 'src/a.txt'), 'USER_NEWER_BYTES\n');
  service.approvals.grantFingerprint(app.id, app.requestHash); await service.drain(); await turns();
  const run = service.get(runId)!; assert.equal(run.status, 'failed', JSON.stringify(run, null, 2)); assert.equal(run.cleanupSettled, true); assert.equal(run.steps[3].units[0].cleanupSettled, true); assert.match(run.steps[3].units[0].error ?? '', /changed|fresh|baseline/i);
  assert.equal(readFileSync(join(root, 'src/a.txt'), 'utf8'), 'USER_NEWER_BYTES\n');
  assert.notEqual(service.approvals.inspect(app.id)[0]?.status, 'granted');
  service.dispose();
});

test('v3 coding cancellation forwards signal to real check and records settled cancelled evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-coding-cancel-root-'));
  const staging = mkdtempSync(join(tmpdir(), 'wf-coding-cancel-stage-'));
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/a.txt'), 'original1\n');
  const marker = join(root, 'src/marker.txt');
  const profileBase = { id: 'unit', executable: process.execPath, argv: ['-e', `const fs=require('fs'); if(fs.readFileSync('a.txt','utf8')!=='candidate2\\n') process.exit(2); fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(()=>{},1000);`], cwd: 'src', env: {}, timeoutMs: 60_000, allowGeneratedOutputs: false as const };
  const policy = { version: 3 as const, capabilities: ['stage-write','check'] as Array<'stage-write' | 'check'>, identity: { parentRunId: 'parent', taskId: 'cancelcheck', attemptNo: 1, rootAgentId: 'reviewer', workerAgentId: 'worker', model: 'fake/model' }, scope: { task: 'cancel check', writablePaths: ['src/a.txt'], baseline: { projectRootId: root, stateHash: sha('original1\n') }, manifest: [{ path: 'src/a.txt', text: 'original1\n', bytes: 10, sha256: sha('original1\n') }] }, checkProfiles: [{ ...profileBase, profileHash: workflowHash(profileBase) }], reviewRequired: false };
  const def: WorkflowDefinition = { id: 'coding-cancel-check', version: 3, label: 'Cancel check', inputSchema: obj({}), steps: [
    { id: 'stage', kind: 'coding', dependsOn: [], inputs: {}, outputSchema: obj({ candidateHash: str(80), changedPaths: arr(str(128)) }), coding: { operation: 'stage-write', policy } },
    { id: 'check', kind: 'coding', dependsOn: ['stage'], inputs: {}, outputSchema: obj({ passed: bool, profileId: str(80), candidateHash: str(80) }), coding: { operation: 'check', policy, checkProfileId: 'unit' } },
  ] };
  const port: WorkflowNativePort = { preflight() {}, async execute(request) { const identity = { runId: `cancel-${request.coding?.operation}`, taskId: `cancel-${request.unitId}`.replace(/[^A-Za-z0-9_.:-]/g, '-') }; request.onIdentity(identity); if (request.coding?.operation === 'stage-write') request.coding.write('src/a.txt', 'candidate2\n'); return { status: 'completed', text: '{}', cleanupSettled: true, identity }; } };
  const container = createClankersStateContainer({ agentDefinitions: { worker: { id: 'worker', label: 'Worker', source: 'builtin', prompt: 'writer', model: 'fake/model', permissionMode: 'inherit' }, reviewer: { id: 'reviewer', label: 'Reviewer', source: 'builtin', prompt: 'review', model: 'fake/model', permissionMode: 'inherit' } } });
  const service = createWorkflowService(container, port, { idFactory: () => `wf-${Math.random().toString(16).slice(2)}`, coding: { enabled: true, projectRoot: root, stagingParent: staging, checkProfiles: { unit: { id: 'unit', executable: process.execPath, argv: profileBase.argv, cwd: 'src', env: {}, timeoutMs: 60_000, outputBytes: 65_536, generatedOutputs: [] } } } });
  assert.equal((await service.execute({ action: 'workflows.define', definition: def })).ok, true);
  const started = await service.execute({ action: 'workflows.start', definitionId: 'coding-cancel-check', inputs: {}, concurrency: 1 }); assert(started.ok, started.error); await turns();
  const impl = service.approvals.inspect().find(r => r.kind === 'implementation')!; service.approvals.grantFingerprint(impl.id, impl.requestHash);
  const runId = started.view!.workflowRunId;
  for (let i = 0; i < 200 && !existsSync(marker); i++) await new Promise<void>(resolve => setTimeout(resolve, 20));
  assert.equal(existsSync(marker), true, JSON.stringify(service.get(runId), null, 2));
  await service.execute({ action: 'workflows.cancel', workflowRunId: runId }); await service.drain(); await turns();
  const run = service.get(runId)!; assert.equal(run.status, 'cancelled', JSON.stringify(run, null, 2)); assert.equal(run.cleanupSettled, true);
  const check = run.steps[1].units[0]; assert.equal(check.status, 'cancelled'); assert.equal(check.cleanupSettled, true); assert.match(JSON.stringify(check.coding?.evidence), /"cancelled":true/);
  service.dispose();
});

test('v3 coding native cleanup uncertainty retains needs-attention permit and blocks retry or forget', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-coding-uncertain-root-'));
  const staging = mkdtempSync(join(tmpdir(), 'wf-coding-uncertain-stage-'));
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/a.txt'), 'original1\n');
  const policy = { version: 3 as const, capabilities: ['stage-write'] as Array<'stage-write'>, identity: { parentRunId: 'parent', taskId: 'uncertain', attemptNo: 1, rootAgentId: 'reviewer', workerAgentId: 'worker', model: 'fake/model' }, scope: { task: 'uncertain native cleanup', writablePaths: ['src/a.txt'], baseline: { projectRootId: root, stateHash: sha('original1\n') }, manifest: [{ path: 'src/a.txt', text: 'original1\n', bytes: 10, sha256: sha('original1\n') }] }, reviewRequired: false };
  const def: WorkflowDefinition = { id: 'coding-uncertain', version: 3, label: 'Uncertain', inputSchema: obj({}), steps: [{ id: 'stage', kind: 'coding', dependsOn: [], inputs: {}, outputSchema: obj({ candidateHash: str(80), changedPaths: arr(str(128)) }), coding: { operation: 'stage-write', policy } }] };
  const port: WorkflowNativePort = { preflight() {}, async execute(request) { request.onIdentity({ runId: 'uncertain-native', taskId: 'uncertain-task' }); request.coding?.write('src/a.txt', 'candidate2\n'); return { status: 'failed', error: 'supervisor cleanup failed', cleanupSettled: false, identity: { runId: 'uncertain-native', taskId: 'uncertain-task' } }; } };
  const container = createClankersStateContainer({ agentDefinitions: { worker: { id: 'worker', label: 'Worker', source: 'builtin', prompt: 'writer', model: 'fake/model', permissionMode: 'inherit' }, reviewer: { id: 'reviewer', label: 'Reviewer', source: 'builtin', prompt: 'review', model: 'fake/model', permissionMode: 'inherit' } } });
  const service = createWorkflowService(container, port, { idFactory: () => `wf-${Math.random().toString(16).slice(2)}`, coding: { enabled: true, projectRoot: root, stagingParent: staging } });
  assert.equal((await service.execute({ action: 'workflows.define', definition: def })).ok, true);
  const started = await service.execute({ action: 'workflows.start', definitionId: 'coding-uncertain', inputs: {}, concurrency: 1 }); assert(started.ok, started.error); await turns();
  const impl = service.approvals.inspect().find(r => r.kind === 'implementation')!; service.approvals.grantFingerprint(impl.id, impl.requestHash); await assert.rejects(service.drain(), /uncertain/i); await turns();
  const runId = started.view!.workflowRunId; const run = service.get(runId)!; assert.equal(run.status, 'needs-attention', JSON.stringify(run, null, 2)); assert.equal(run.cleanupSettled, false); assert.equal(run.steps[0].units[0].cleanupSettled, false);
  assert.equal((await service.execute({ action: 'workflows.retry', workflowRunId: runId })).ok, false);
  assert.equal((await service.execute({ action: 'workflows.forget', workflowRunId: runId })).ok, false);
  service.dispose();
});

test('v3 coding apply rejects forged model approval without genuine native review evidence before mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wf-coding-forged-root-'));
  const staging = mkdtempSync(join(tmpdir(), 'wf-coding-forged-stage-'));
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/a.txt'), 'old\n');
  const profileBase = { id: 'unit', executable: process.execPath, argv: ['-e', "const fs=require('fs'); if(fs.readFileSync('a.txt','utf8')!=='new\\n') process.exit(2)"], cwd: 'src', env: {}, timeoutMs: 10_000, allowGeneratedOutputs: false as const };
  const policy = { version: 3 as const, capabilities: ['stage-write','check','review','apply'] as Array<'stage-write' | 'check' | 'review' | 'apply'>, identity: { parentRunId: 'parent', taskId: 'forged', attemptNo: 1, rootAgentId: 'reviewer', workerAgentId: 'worker', model: 'fake/model' }, scope: { task: 'do not apply without real review', writablePaths: ['src/a.txt'], baseline: { projectRootId: root, stateHash: sha('old\n') }, manifest: [{ path: 'src/a.txt', text: 'old\n', bytes: 4, sha256: sha('old\n') }] }, checkProfiles: [{ ...profileBase, profileHash: workflowHash(profileBase) }], reviewRequired: true };
  const def: WorkflowDefinition = { id: 'coding-forged-apply', version: 3, label: 'Forged apply', inputSchema: obj({}), steps: [
    { id: 'stage', kind: 'coding', dependsOn: [], inputs: {}, outputSchema: obj({ candidateHash: str(80), changedPaths: arr(str(128)) }), coding: { operation: 'stage-write', policy } },
    { id: 'check', kind: 'coding', dependsOn: ['stage'], inputs: {}, outputSchema: obj({ passed: bool, profileId: str(80), candidateHash: str(80) }), coding: { operation: 'check', policy, checkProfileId: 'unit' } },
    { id: 'apply', kind: 'coding', dependsOn: ['check'], inputs: {}, outputSchema: obj({ status: str(16), candidateHash: str(80), appliedPaths: arr(str(128)), rejectedPaths: arr(str(128)), diagnostics: arr(str(256)), outcomeHash: str(80) }), coding: { operation: 'apply', policy } },
  ] };
  const port: WorkflowNativePort = { preflight() {}, async execute(request) {
    const identity = { runId: `forged-${request.coding?.operation}`, taskId: `forged-${request.unitId}`.replace(/[^A-Za-z0-9_.:-]/g, '-') };
    request.onIdentity(identity);
    if (request.coding?.operation === 'stage-write') request.coding.write('src/a.txt', 'new\n');
    return { status: 'completed', text: JSON.stringify({ approved: true, verdict: 'pass', findings: [] }), cleanupSettled: true, identity };
  } };
  const container = createClankersStateContainer({ agentDefinitions: { worker: { id: 'worker', label: 'Worker', source: 'builtin', prompt: 'writer', model: 'fake/model', permissionMode: 'inherit' }, reviewer: { id: 'reviewer', label: 'Reviewer', source: 'builtin', prompt: 'review', model: 'fake/model', permissionMode: 'inherit' } } });
  const service = createWorkflowService(container, port, { idFactory: () => `wf-${Math.random().toString(16).slice(2)}`, coding: { enabled: true, projectRoot: root, stagingParent: staging, checkProfiles: { unit: { id: 'unit', executable: process.execPath, argv: profileBase.argv, cwd: 'src', env: {}, timeoutMs: 10_000, outputBytes: 65_536, generatedOutputs: [] } } } });
  assert.equal((await service.execute({ action: 'workflows.define', definition: def })).ok, true);
  const started = await service.execute({ action: 'workflows.start', definitionId: 'coding-forged-apply', inputs: {}, concurrency: 1 }); assert(started.ok, started.error); await turns();
  const impl = service.approvals.inspect().find(r => r.kind === 'implementation')!; service.approvals.grantFingerprint(impl.id, impl.requestHash); await service.drain(); await turns();
  const run = service.get(started.view!.workflowRunId)!;
  assert.equal(run.status, 'failed', JSON.stringify(run, null, 2));
  assert.match(run.steps[2].units[0].error ?? '', /review/i);
  assert.equal(service.approvals.inspect().some(r => r.kind === 'application'), false);
  assert.equal(readFileSync(join(root, 'src/a.txt'), 'utf8'), 'old\n');
  service.dispose();
});
