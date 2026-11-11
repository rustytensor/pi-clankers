import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createClankersStateContainer } from '../state.js';
import { createWorkflowService } from '../workflow-runtime.js';
import type { WorkflowDefinition, WorkflowNativePort, WorkflowNativeRequest, WorkflowSchema } from '../workflow-model.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const str = (n = 160): WorkflowSchema => ({ type: 'string', maxLength: n });
const arr = (items: WorkflowSchema): WorkflowSchema => ({ type: 'array', maxItems: 8, items });
const obj = (properties: Record<string, WorkflowSchema>): WorkflowSchema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function owner(generation = 'owner-gen') {
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8').split(') ').pop()!.trim().split(/\s+/)[19];
  return { bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), pid: process.pid, startTimeTicks: stat, writerSessionId: 'writer', generation };
}

test('simulated dead owner with original PID alive cannot prove interrupted native settlement', { timeout: 20000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'wf-positive-prepare-root-'));
  const staging = mkdtempSync(join(tmpdir(), 'wf-positive-prepare-stage-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/a.txt'), 'old\n');
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const wrote: string[] = [];
  const policy = { version: 3 as const, capabilities: ['stage-write'] as const, identity: { parentRunId: 'parent', taskId: 'task', attemptNo: 1, rootAgentId: 'worker', workerAgentId: 'worker', model: 'fake/model' }, scope: { task: 'change old to new', writablePaths: ['src/a.txt'], readonlyPaths: [], baseline: { projectRootId: root, stateHash: sha('old\n') }, manifest: [{ path: 'src/a.txt', text: 'old\n', bytes: 4, sha256: sha('old\n') }] } };
  const def: WorkflowDefinition = { id: 'stage-only', version: 3, label: 'Stage only', inputSchema: obj({}), steps: [
    { id: 'stage', kind: 'coding', dependsOn: [], inputs: {}, outputSchema: obj({ candidateHash: str(), changedPaths: arr(str()) }), coding: { operation: 'stage-write', policy } },
  ] };
  const port: WorkflowNativePort = { preflight() {}, async execute(req: WorkflowNativeRequest) {
    req.onIdentity({ runId: `native-${req.unitId}`, taskId: `task-${req.unitId}` });
    req.coding!.write('src/a.txt', 'new\n');
    wrote.push('stage-write');
    await paused;
    return { status: 'completed', text: JSON.stringify({ candidateHash: req.coding!.inspect().candidateHash, changedPaths: ['src/a.txt'] }), cleanupSettled: true };
  } };
  const oldOwner = owner();
  const calls = { ensureWriter: 0, inspectOwner: 0, previous: 0 };
  let currentOwner: typeof oldOwner | undefined = oldOwner;
  const durable = { ensureWriter: () => { calls.ensureWriter++; return oldOwner; }, inspectOwner: () => { calls.inspectOwner++; return { snapshotFile: 's', lockDir: 'l', claimDir: 'c', claimPresent: false, ownerValid: true, ...(currentOwner ? { owner: currentOwner } : {}) }; }, inspectPreviousOwner: (e: any) => { calls.previous++; assert.deepEqual(e, oldOwner); return 'dead' as const; } };
  const container = createClankersStateContainer({ agentDefinitions: { worker: { id: 'worker', label: 'Worker', source: 'builtin', prompt: 'writer', model: 'fake/model', permissionMode: 'inherit' } } });
  const svc = createWorkflowService(container, port, { idFactory: () => `wf-${Math.random().toString(16).slice(2)}`, recovery: { enabled: true, durablePort: durable }, coding: { enabled: true, projectRoot: root, stagingParent: staging, writablePaths: ['src/a.txt'] } });
  t.after(async () => { release(); svc.dispose(); await svc.drain().catch(() => {}); rmSync(root, { recursive: true, force: true }); rmSync(staging, { recursive: true, force: true }); });
  assert.equal((await svc.execute({ action: 'workflows.define', definition: def })).ok, true);
  const started = await svc.execute({ action: 'workflows.start', definitionId: def.id, inputs: {}, concurrency: 1 });
  assert.equal(started.ok, true, started.error);
  const approval = await serviceApproval(svc); svc.approvals.grantFingerprint(approval.id, approval.requestHash);
  for (let i = 0; i < 200 && wrote.length === 0; i++) await tick();
  assert.deepEqual(wrote, ['stage-write']);
  const retained = JSON.stringify(container.read().extensions.workflows);
  currentOwner = undefined;
  const fresh = createWorkflowService(container, port, { recovery: { enabled: true, durablePort: durable }, coding: { enabled: true, projectRoot: root, stagingParent: staging, writablePaths: ['src/a.txt'] } });
  const display = await fresh.execute({ action: 'workflows.recovery.inspect', workflowRunId: started.view!.workflowRunId });
  const selections = structuredClone((display.assessment as any).plan.recommendedSelections);
  assert.deepEqual(selections, { reuseUnitIds: [], rerunUnitIds: ['stage:0'] });
  const beforeCalls = { ...calls }; const beforeWrites = [...wrote];
  const reply = await fresh.execute({ action: 'workflows.recovery.prepare', workflowRunId: started.view!.workflowRunId, selections });
  assert.equal(reply.ok, true, reply.error);
  assert.equal((reply.assessment as any).plan.status, 'blocked');
  assert.match(JSON.stringify((reply.assessment as any).blocked), /previous-native-settlement-unknown/);
  assert.equal(oldOwner.pid, process.pid); assert.equal(process.kill(oldOwner.pid, 0), true);
  assert.equal(calls.ensureWriter, beforeCalls.ensureWriter); assert.deepEqual(wrote, beforeWrites);
  assert.equal(fresh.approvals.inspect().length, 0);
  assert.match(JSON.stringify((reply.assessment as any).candidateCarry), /reusable-candidate-carry-only/);
  assert.equal(JSON.stringify(container.read().extensions.workflows), retained);
  assert.equal(calls.ensureWriter > 0, true);
  fresh.dispose();
});

async function serviceApproval(svc: ReturnType<typeof createWorkflowService>) {
  for (let i = 0; i < 200; i++) {
    const approval = svc.approvals.inspect().find(a => a.kind === 'implementation');
    if (approval) return approval;
    await tick();
  }
  throw new Error('implementation approval not requested: ' + JSON.stringify(svc.list()));
}
