import assert from 'node:assert/strict';
import test from 'node:test';
import { createClankersStateContainer } from '../state.js';
import { createWorkflowService, recoverWorkflowState } from '../workflow-runtime.js';
import { WORKFLOW_LIMITS, workflowHash, workflowUnitHash } from '../workflow-model.js';
import type { WorkflowDefinition, WorkflowNativePort, WorkflowRun, WorkflowSchema, WorkflowState } from '../workflow-model.js';

const stringSchema: WorkflowSchema = { type: 'string', maxLength: 100 };
const objectSchema: WorkflowSchema = { type: 'object', properties: { x: stringSchema }, required: ['x'], additionalProperties: false };
const agent = { id: 'reviewer', label: 'Reviewer', source: 'builtin', prompt: 'Read only', model: 'fake/model' } as const;
const inertPort = (): WorkflowNativePort => ({ preflight() {}, execute: async () => { throw new Error('recovery test must not execute'); } });

function nativeDefinition(version: 1 | 2 | 3 = 1): WorkflowDefinition { return { id: `native-${version}`, version, label: 'Native', inputSchema: objectSchema, steps: [
  { id: 'work', kind: 'native', dependsOn: [], agentId: 'reviewer', prompt: 'Read only', outputSchema: stringSchema, inputs: { item: { ref: { source: 'inputs', path: ['x'] } } } },
] }; }
function aggregateDefinition(version: 1 | 2 | 3): WorkflowDefinition { return { id: `aggregate-${version}`, version, label: 'Aggregate', inputSchema: objectSchema, steps: [
  { id: 'collect', kind: 'aggregate', dependsOn: [], operation: 'collect', inputs: { x: { ref: { source: 'inputs', path: ['x'] } } } },
] }; }
function nativeRun(version: 1 | 2 | 3 = 1): WorkflowRun {
  const definition = nativeDefinition(version), inputs = { x: 'before' };
  const run: WorkflowRun = { workflowRunId: `run-${version}`, familyId: `run-${version}`, attemptNo: 1, definition, definitionHash: workflowHash(definition), inputs, agents: { reviewer: agent }, concurrency: 1, status: 'running', createdAt: '2026-10-04T00:00:00.000Z', updatedAt: '2026-10-04T00:00:01.000Z', admissions: 1, cleanupSettled: false, recovered: false, steps: [{ id: 'work', status: 'running', units: [{ id: 'work:0', stepId: 'work', index: 0, status: 'running', inputHash: '', inputs: { item: 'before' }, cleanupSettled: false }] }] };
  run.steps[0].units[0].inputHash = workflowUnitHash(run, definition.steps[0], run.steps[0].units[0].inputs);
  return run;
}
function aggregateRun(version: 1 | 2 | 3): WorkflowRun {
  const definition = aggregateDefinition(version), inputs = { x: 'ok' };
  const run: WorkflowRun = { workflowRunId: `agg-${version}`, familyId: `agg-${version}`, attemptNo: 1, definition, definitionHash: workflowHash(definition), inputs, agents: {}, concurrency: 1, status: 'completed', createdAt: '2026-10-04T00:00:00.000Z', updatedAt: '2026-10-04T00:00:01.000Z', admissions: 0, cleanupSettled: true, recovered: false, steps: [{ id: 'collect', status: 'completed', units: [{ id: 'collect:0', stepId: 'collect', index: 0, status: 'completed', inputHash: '', inputs: { x: 'ok' }, result: { x: 'ok' }, cleanupSettled: true }], output: { x: 'ok' } }], report: { x: 'ok' } };
  run.steps[0].units[0].inputHash = workflowUnitHash(run, definition.steps[0], run.steps[0].units[0].inputs);
  return run;
}
function state(...runs: WorkflowRun[]): WorkflowState { return { version: 1, definitions: runs.map(r => r.definition), runs }; }

test('recovery records immutable original status evidence before inert mutations', () => {
  const recovered = recoverWorkflowState(state(nativeRun(1))).runs[0];
  assert.equal(recovered.status, 'needs-attention');
  assert.equal(recovered.steps[0].status, 'unverified');
  assert.equal(recovered.steps[0].units[0].status, 'unverified');
  assert.deepEqual(recovered.recoveryOriginal, { version: 1, recordedAt: '2026-10-04T00:00:01.000Z', status: 'running', cleanupSettled: false, recovered: false, steps: [{ id: 'work', status: 'running', units: [{ id: 'work:0', stepId: 'work', index: 0, status: 'running', cleanupSettled: false }] }] });
});

test('existing recoveryOriginal is validated separately and never replaced on repeated recovery', () => {
  const first = recoverWorkflowState(state(nativeRun(1)));
  const original = first.runs[0].recoveryOriginal;
  assert(original);
  first.runs[0].updatedAt = '2026-10-05T00:00:00.000Z';
  first.runs[0].recoveryOriginal = { ...original, error: 'sentinel' };
  const second = recoverWorkflowState(first).runs[0];
  assert.equal(second.recoveryOriginal?.recordedAt, '2026-10-04T00:00:01.000Z');
  assert.equal(second.recoveryOriginal?.error, 'sentinel');
  assert.equal(second.recoveryOriginal?.status, 'running');
});

test('malformed, mismatched, and oversized recoveryOriginal records fail closed', () => {
  const malformed = nativeRun(1); malformed.recoveryOriginal = { ...recoverWorkflowState(state(nativeRun(1))).runs[0].recoveryOriginal!, extra: true } as never;
  assert.throws(() => recoverWorkflowState(state(malformed)), /recovery original/i);
  const mismatched = nativeRun(1); mismatched.recoveryOriginal = { ...recoverWorkflowState(state(nativeRun(1))).runs[0].recoveryOriginal!, steps: [{ id: 'other', status: 'running', units: [] }] } as never;
  assert.throws(() => recoverWorkflowState(state(mismatched)), /recovery original/i);
  const oversized = nativeRun(1); oversized.recoveryOriginal = { ...recoverWorkflowState(state(nativeRun(1))).runs[0].recoveryOriginal!, error: 'x'.repeat(263000) };
  assert.throws(() => recoverWorkflowState(state(oversized)), /budget|diagnostic|JSON string exceeded/i);
});

test('legacy v1 v2 and v3 records without recoveryOriginal remain valid and are populated', () => {
  for (const version of [1, 2, 3] as const) {
    const recovered = recoverWorkflowState(state(aggregateRun(version))).runs[0];
    assert.equal(recovered.status, 'completed');
    assert.equal(recovered.recoveryOriginal?.version, 1);
    assert.equal(recovered.recoveryOriginal?.status, 'completed');
    assert.equal(recovered.recoveryOriginal?.steps[0].units[0].status, 'completed');
  }
});

test('recovery preserves source ledger input object and does not execute public workflow code', () => {
  const original = state(nativeRun(1));
  const before = JSON.stringify(original);
  const container = createClankersStateContainer({ extensions: { workflows: original }, agentDefinitions: { reviewer: agent } });
  const service = createWorkflowService(container, inertPort());
  assert.equal(JSON.stringify(original), before);
  assert.equal(service.get('run-1')?.recoveryOriginal?.status, 'running');
  service.dispose();
});

test('first capture rejects invalid diagnostics rather than creating history rejected on next restart', () => {
  for (const error of ['x'.repeat(1025), 42]) {
    const run = nativeRun(1);
    run.error = error as string;
    assert.throws(() => recoverWorkflowState(state(run)), /diagnostic/i);
    assert.equal(run.recoveryOriginal, undefined);
  }
});

test('history expansion cannot exceed the workflow namespace budget', () => {
  const runs = Array.from({ length: 10 }, (_, index) => {
    const run = aggregateRun(1);
    run.workflowRunId = run.familyId = `aggregate-${index}`;
    run.report = '';
    return run;
  });
  const ledger: WorkflowState = { version: 1, definitions: [runs[0].definition], runs };
  const padding = WORKFLOW_LIMITS.ledgerBytes - Buffer.byteLength(JSON.stringify(ledger)) - 128;
  const perRun = Math.floor(padding / runs.length);
  for (const run of runs) run.report = 'x'.repeat(perRun);
  assert(Buffer.byteLength(JSON.stringify(ledger)) < WORKFLOW_LIMITS.ledgerBytes);
  assert.throws(() => recoverWorkflowState(ledger), /budget/i);
  assert(runs.every(run => run.recoveryOriginal === undefined));
});
