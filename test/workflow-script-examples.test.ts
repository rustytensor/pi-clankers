import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createClankersStateContainer } from '../state.js';
import type { ClankersAgentDefinition } from '../types.js';
import { validateWorkflowDefinition, workflowHash } from '../workflow-model.js';
import type { WorkflowDefinition, WorkflowNativeOutcome, WorkflowNativePort, WorkflowNativeRequest, WorkflowRun, WorkflowService } from '../workflow-model.js';
import { createWorkflowService } from '../workflow-runtime.js';
import { compileWorkflowScript } from '../workflow-script.js';
import {
  CONDITIONAL_REFINEMENT_DEFINITION, CONDITIONAL_REFINEMENT_SCRIPT,
  READ_ONLY_PARALLEL_DEFINITION, READ_ONLY_PARALLEL_SCRIPT,
} from '../workflow-script-examples.js';

function agents(): Record<string, ClankersAgentDefinition> {
  return {
    generalist: { id: 'generalist', label: 'Generalist', source: 'builtin', prompt: 'Read-only generalist', model: 'fake/model', tools: ['read'], permissionMode: 'inherit' },
    reviewer: { id: 'reviewer', label: 'Reviewer', source: 'builtin', prompt: 'Read-only reviewer', model: 'fake/model', tools: ['read'], permissionMode: 'inherit' },
  };
}
/** Scripted local fake native port: no external providers, no real models, no writes. */
function harness() {
  const requests: WorkflowNativeRequest[] = [], orders: Array<[string, string]> = [];
  // Scripted responses consumed at admission time, keyed by agent id then step id.
  let script: (request: WorkflowNativeRequest) => string = () => '"ok"';
  const port: WorkflowNativePort = {
    preflight(agent) { assert.equal(agent.model, 'fake/model'); assert.deepEqual(agent.tools, ['read']); },
    execute(request) {
      requests.push(request);
      orders.push([request.agent.id, request.stepId]);
      request.assertAdmission();
      const identity = { runId: `native-${requests.length}`, taskId: `task-${requests.length}` };
      request.onIdentity(identity);
      const text = script(request);
      return Promise.resolve({ status: 'completed', text, cleanupSettled: true, identity } satisfies WorkflowNativeOutcome);
    },
  };
  const container = createClankersStateContainer({ agentDefinitions: agents() });
  let seq = 0;
  const service = createWorkflowService(container, port, { idFactory: () => `workflow-${++seq}`, now: () => new Date('2026-10-06T00:00:00.000Z') });
  return { service, requests, orders, setScript: (next: typeof script) => { script = next; }, run };
}
let currentRun: WorkflowRun | undefined;
function run(): WorkflowRun { assert(currentRun); return currentRun; }
async function start(service: WorkflowService, definition: WorkflowDefinition, inputs: unknown): Promise<string> {
  const defined = await service.execute({ action: 'workflows.define', definition });
  assert.equal(defined.ok, true, defined.error);
  const started = await service.execute({ action: 'workflows.start', definitionId: definition.id, inputs: inputs as never });
  assert.equal(started.ok, true, started.error);
  currentRun = undefined;
  return started.view!.workflowRunId;
}
async function turns(n = 6) { for (let i = 0; i < n; i++) await Promise.resolve(); }
function settled(service: WorkflowService, id: string): WorkflowRun {
  const run = service.get(id);
  assert(run, 'run not found');
  currentRun = run;
  return run;
}
/** Compiled graph without authoring metadata must equal the authored definition exactly. */
function stripAuthoring(definition: WorkflowDefinition): Omit<WorkflowDefinition, 'authoring'> {
  const { authoring, ...graph } = definition as WorkflowDefinition & { authoring?: unknown };
  assert(authoring && typeof authoring === 'object', 'compiled definition must carry authoring metadata');
  return graph;
}
const state = (done: boolean): string => JSON.stringify(done ? { findings: ['f1', 'f2'], questions: [], done: true } : { findings: ['f1'], questions: ['q1'], done: false });

test('example exports are inert plain data; importing defines nothing and starts nothing', () => {
  for (const script of [READ_ONLY_PARALLEL_SCRIPT, CONDITIONAL_REFINEMENT_SCRIPT]) {
    assert.equal(typeof script, 'string');
    assert(script.includes('workflow('));
  }
  for (const definition of [READ_ONLY_PARALLEL_DEFINITION, CONDITIONAL_REFINEMENT_DEFINITION]) {
    assert.equal(Object.isFrozen(definition), true);
    assert.equal('authoring' in definition, false);
    assert.deepEqual(JSON.parse(JSON.stringify(definition)), definition); // plain JSON data: no functions, no side-effect carriers
    assert.deepEqual(validateWorkflowDefinition(definition), definition); // frozen bounded graph validates unchanged
    assert.equal(definition.version, 2); // read-only authored graphs are root version 2, never informal v1
  }
});

test('compiled parallel review strips to the exact equivalent definition with deterministic provenance', async () => {
  const compiled = await compileWorkflowScript(READ_ONLY_PARALLEL_SCRIPT, { sourceName: 'read-only-parallel.js' });
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  const { definition, inspection } = compiled;
  assert.deepEqual(stripAuthoring(definition), READ_ONLY_PARALLEL_DEFINITION);
  assert.equal(definition.version, 2);
  assert.equal(definition.authoring!.formatVersion, 1);
  assert.equal(definition.authoring!.parserVersion, 'typescript@5.9.3');
  assert.equal(definition.authoring!.sourceHash, createHash('sha256').update(READ_ONLY_PARALLEL_SCRIPT, 'utf8').digest('hex'));
  assert.equal(definition.authoring!.sourceName, 'read-only-parallel.js');
  assert.equal(definition.authoring!.graphHash, workflowHash(READ_ONLY_PARALLEL_DEFINITION));
  assert.deepEqual(definition.authoring!.steps.map(s => s.path), [['survey'], ['verify'], ['collect']]);
  assert.deepEqual(definition.authoring!.phases.map(p => p.id), ['review', 'combine']);
  assert.deepEqual(inspection.phases.map(p => p.id), ['review', 'combine']);
  assert.deepEqual(inspection.steps.map(s => s.path.join('/')), ['survey', 'verify', 'collect']);
  assert.deepEqual(inspection.agentIds, ['generalist', 'reviewer']);
  assert.deepEqual(inspection.counts, { authored: 3, expanded: 9, native: 8, coding: 0, familyAdmissions: 24 });
  assert.equal(inspection.codingCapabilities.length, 0);
  // Deterministic recompilation: identical graph and provenance, zero provider or workspace effects.
  const again = await compileWorkflowScript(READ_ONLY_PARALLEL_SCRIPT);
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.deepEqual(stripAuthoring(again.definition), READ_ONLY_PARALLEL_DEFINITION);
  assert.equal(again.definition.authoring!.sourceHash, definition.authoring!.sourceHash);
  assert.equal(again.definition.authoring!.graphHash, definition.authoring!.graphHash);
  assert.deepEqual(again.definition.authoring!.steps, definition.authoring!.steps);
  assert.deepEqual(again.definition.authoring!.phases, definition.authoring!.phases);
});

test('compiled conditional refinement strips to the exact equivalent definition', async () => {
  const compiled = await compileWorkflowScript(CONDITIONAL_REFINEMENT_SCRIPT);
  assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  const { definition, inspection } = compiled;
  assert.deepEqual(stripAuthoring(definition), CONDITIONAL_REFINEMENT_DEFINITION);
  assert.equal(definition.version, 2);
  assert.deepEqual(definition.authoring!.steps.map(s => s.path),
    [['inspect'], ['extra'], ['coverage'], ['refine'], ['refine', 'revise'], ['refine', 'assess'], ['report']]);
  assert.deepEqual(definition.authoring!.phases.map(p => [p.id, p.paths]),
    [['inspect', [['inspect'], ['extra'], ['coverage']]], ['refine', [['refine'], ['report']]]]);
  assert.deepEqual(inspection.steps.map(s => s.path.join('/')),
    ['inspect', 'extra', 'coverage', 'refine', 'refine/revise', 'refine/assess', 'report']);
  assert.deepEqual(inspection.counts, { authored: 7, expanded: 11, native: 8, coding: 0, familyAdmissions: 24 });
  assert.deepEqual(inspection.codingCapabilities, []);
});

test('parallel review admits both fan-outs before the explicit join; fake port ordering is honored', async () => {
  const h = harness();
  h.setScript(request => request.agent.id === 'generalist'
    ? JSON.stringify({ summary: `summary-${request.unitId}`, concerns: [] })
    : JSON.stringify({ verdict: 'confirm', reason: 'clean' }));
  const id = await start(h.service, READ_ONLY_PARALLEL_DEFINITION, { targets: ['a.ts', 'b.ts'] });
  await turns();
  // Concurrency 8 admits all four fan-out units before the join can run.
  assert.equal(h.requests.length, 4);
  assert.deepEqual(h.orders.filter(([agent]) => agent === 'generalist').length, 2);
  assert.deepEqual(h.orders.filter(([agent]) => agent === 'reviewer').length, 2);
  assert(h.orders.every(([, stepId]) => stepId === 'survey' || stepId === 'verify'), 'join must not admit before its dependencies settle');
  assert(h.requests.every(r => !r.coding), 'read-only review never creates controlled coding contexts');
  const declared = new Map(READ_ONLY_PARALLEL_DEFINITION.steps.map(s => [s.id, s.prompt!]));
  assert(h.requests.every(r => r.prompt.startsWith(declared.get(r.stepId)!)), 'declared prompts flow through frozen materialization');
  await h.service.drain();
  const run = settled(h.service, id);
  assert.equal(run.status, 'completed');
  assert.equal(run.cleanupSettled, true);
  assert.deepEqual(run.steps.map(s => s.id), ['survey', 'verify', 'collect']);
  const collect = run.steps[2];
  assert.equal(collect.status, 'completed');
  // Completed fan-out dependencies contribute their whole bounded unit envelopes; the join adds no fabrication.
  const envelope = (unitId: string, identityNo: number, target: string, result: unknown) => ({
    id: unitId, index: Number(unitId.split(':')[1]), status: 'completed', stepId: unitId.split(':')[0],
    inputs: { target }, result, cleanupSettled: true,
    native: { runId: `native-${identityNo}`, taskId: `task-${identityNo}` },
  });
  assert.deepEqual(collect.output, {
    surveys: [
      envelope('survey:0', 1, 'a.ts', { summary: 'summary-survey:0', concerns: [] }),
      envelope('survey:1', 2, 'b.ts', { summary: 'summary-survey:1', concerns: [] }),
    ],
    verifications: [
      envelope('verify:0', 3, 'a.ts', { verdict: 'confirm', reason: 'clean' }),
      envelope('verify:1', 4, 'b.ts', { verdict: 'confirm', reason: 'clean' }),
    ],
  });
  h.service.dispose();
});

test('conditional refinement skips the extra review on false input and converges in one iteration', async () => {
  const h = harness();
  h.setScript(request => {
    if (request.stepId === 'inspect') return state(false);
    if (request.stepId === 'refine@0/revise') return state(true);
    if (request.stepId === 'refine@0/assess') return state(true);
    return assert.fail(`unexpected native request ${request.stepId}`);
  });
  const id = await start(h.service, CONDITIONAL_REFINEMENT_DEFINITION, { targets: ['a.ts'], extraReview: false });
  await turns();
  assert.deepEqual(h.orders.map(([, stepId]) => stepId), ['inspect', 'refine@0/revise']); // extra never starts
  assert(h.requests[1].prompt.includes('"findings":["f1"]'), 'iteration feedback feeds the next body step');
  await h.service.drain();
  const run = settled(h.service, id);
  assert.equal(run.status, 'completed');
  const [inspect, extra, coverage, refine, report] = run.steps;
  assert.deepEqual(extra.units, []);
  assert.equal(extra.skipReason, 'condition-false');
  // Deliberate condition skip contributes its whole unavailable envelope next to the real result.
  assert.deepEqual(coverage.output, {
    inspection: { findings: ['f1'], questions: ['q1'], done: false },
    additionalReview: { id: 'extra', status: 'skipped', skipReason: 'condition-false' },
  });
  assert.equal(refine.termination, 'converged');
  assert.equal(refine.iterations!.length, 1);
  assert.deepEqual(refine.output, { findings: ['f1', 'f2'], questions: [], done: true });
  assert.equal(report.status, 'completed');
  h.service.dispose();
});

test('conditional refinement runs the extra review on true input and enforces the max-iteration non-convergence failure', async () => {
  const h = harness();
  h.setScript(request => {
    if (request.stepId === 'inspect') return state(false);
    if (request.stepId === 'extra') return JSON.stringify('extra-review-ok');
    if (request.stepId.endsWith('/revise') || request.stepId.endsWith('/assess')) return state(false);
    return assert.fail(`unexpected native request ${request.stepId}`);
  });
  const id = await start(h.service, CONDITIONAL_REFINEMENT_DEFINITION, { targets: ['a.ts'], extraReview: true });
  await turns();
  assert.deepEqual(h.orders.map(([, stepId]) => stepId).slice(0, 2), ['inspect', 'extra']);
  await h.service.drain();
  const run = settled(h.service, id);
  // The reviewer never sets done: exactly three bounded iterations, then truthful non-convergence.
  assert.equal(run.status, 'failed'); // non-convergence at the limit is a failure, never success
  const [, extra, coverage, refine, report] = run.steps;
  assert.equal(extra.status, 'completed');
  assert.equal(coverage.status, 'completed');
  assert.equal(refine.termination, 'max-iterations');
  assert.equal(refine.iterations!.length, 3);
  assert.equal(refine.output, undefined);
  assert.deepEqual(refine.iterations!.at(-1)!.feedback, { findings: ['f1'], questions: ['q1'], done: false });
  assert.equal(refine.iterations!.at(-1)!.decision, false);
  assert.equal(report.status, 'completed'); // explicit failure-consuming join records the unavailable envelope
  const findings = (report.output as Record<string, unknown>).findings as Record<string, unknown>;
  assert.deepEqual(findings.diagnostic, { iterationId: 'refine@2', iterationNo: 3, feedback: { findings: ['f1'], questions: ['q1'], done: false }, decision: false });
  h.service.dispose();
});
