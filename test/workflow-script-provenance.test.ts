import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createClankersStateContainer } from '../state.js';
import { createWorkflowService, recoverWorkflowState } from '../workflow-runtime.js';
import { validateWorkflowDefinition, workflowHash, workflowView, workflowUnitHash, workflowRecoverySourceContract } from '../workflow-model.js';
import type { WorkflowDefinition, WorkflowNativePort, WorkflowRecoveryDurablePort, WorkflowSchema, WorkflowState } from '../workflow-model.js';
import type { WorkflowScriptAuthoring } from '../workflow-script-format.js';
import { classifyRecoveryOperation } from '../workflow-recovery.js';

const empty: WorkflowSchema = { type: 'object', properties: {}, additionalProperties: false };
const bool: WorkflowSchema = { type: 'boolean' };
const digest = (source: string) => createHash('sha256').update(source, 'utf8').digest('hex');
function graph(): WorkflowDefinition {
  return { id: 'authored', version: 2, label: 'Authored', inputSchema: empty, steps: [
    { id: 'work', kind: 'native', agentId: 'agent', prompt: 'Read only', dependsOn: [], inputs: {}, outputSchema: bool },
    { id: 'report', kind: 'aggregate', operation: 'collect', dependsOn: ['work'], inputs: { result: { ref: { source: 'step', stepId: 'work', path: [] } } } },
  ] };
}
/** Model-only fixture: submitted source is not parsed, authenticated or executed here. */
function authored(definition = graph(), source = ' '.repeat(100)): WorkflowDefinition {
  const plain = validateWorkflowDefinition(definition);
  const authoring: WorkflowScriptAuthoring = {
    formatVersion: 1, languageVersion: 1, compilerVersion: 1, parserVersion: 'typescript@5.9.3',
    sourceHash: digest(source), graphHash: workflowHash(plain), sourceName: 'workflow.workflow.js', sourceBytes: Buffer.byteLength(source), sourceLength: source.length,
    steps: plain.steps.flatMap((s, i) => [{ path: [s.id], span: { start: i * 10, end: i * 10 + 5, line: 1, column: i * 10 } },
      ...(s.body ?? []).map((b, j) => ({ path: [s.id, b.id], span: { start: 50 + j * 10, end: 55 + j * 10, line: 1, column: 50 + j * 10 } }))]),
    phases: [{ id: 'main', paths: plain.steps.map(s => [s.id]), span: { start: 80, end: 90, line: 1, column: 80 } }],
  };
  return validateWorkflowDefinition({ ...plain, authoring });
}
function invalid(mutate: (def: any) => void, message?: RegExp): void {
  const def = structuredClone(authored()); mutate(def);
  if (message) assert.throws(() => validateWorkflowDefinition(def), message);
  else assert.throws(() => validateWorkflowDefinition(def));
}
const agent = { id: 'agent', label: 'Agent', prompt: 'Read only', source: 'project' as const, model: 'fake/model', tools: ['read'], permissionMode: 'inherit' as const };
function fixture(definition = authored(), recovery = false, repeatTwice = false) {
  const container = createClankersStateContainer({ agentDefinitions: { agent } });
  let nativeCalls = 0, acquisitions = 0, publications = 0;
  const owner = { bootId: 'test', pid: 1, startTimeTicks: '2', writerSessionId: 'test', generation: 'test' };
  const durable: WorkflowRecoveryDurablePort = {
    ensureWriter: () => owner,
    inspectOwner: () => ({ snapshotFile: 'fixture', lockDir: 'fixture', claimDir: 'fixture', claimPresent: false, ownerValid: true, owner, actualSnapshotHash: 'a'.repeat(64) }),
    inspectPreviousOwner: () => 'unknown',
    acquireWriter: () => { acquisitions++; return owner; },
    publishSnapshot: () => { publications++; throw new Error('No recovery publication authorized by fixture'); },
  };
  const port: WorkflowNativePort = { preflight() {}, async execute(request) {
    nativeCalls++; request.assertAdmission(); const identity = { runId: `native-${nativeCalls}`, taskId: `task-${nativeCalls}` }; request.onIdentity(identity);
    return { status: 'completed', text: repeatTwice && request.iterationNo === 1 ? 'false' : 'true', identity, cleanupSettled: true };
  } };
  const options = recovery ? { recovery: { enabled: true, durablePort: durable } } : {};
  const service = createWorkflowService(container, port, options);
  return { container, service, port, options, definition, get nativeCalls() { return nativeCalls; }, get acquisitions() { return acquisitions; }, get publications() { return publications; } };
}
async function completed(f: ReturnType<typeof fixture>) {
  const defined = await f.service.execute({ action: 'workflows.define', definition: f.definition }); assert.equal(defined.ok, true, defined.error);
  const started = await f.service.execute({ action: 'workflows.start', definitionId: f.definition.id, inputs: {} }); assert.equal(started.ok, true, started.error);
  await f.service.drain(); const run = f.service.get(started.view!.workflowRunId)!; assert.equal(run.status, 'completed'); return run;
}

test('optional authoring roundtrips frozen data; legacy definition hashes/views remain unchanged', async () => {
  const legacy = graph(); assert.deepEqual(validateWorkflowDefinition(legacy), legacy);
  const f = fixture(legacy); const run = await completed(f);
  const oldHash = workflowHash(legacy); assert.equal(run.definitionHash, oldHash);
  assert.equal(Object.hasOwn(run.definition, 'authoring'), false);
  for (const entry of [...workflowView(run).steps!, ...workflowView(run).correlations]) {
    assert.equal(Object.hasOwn(entry, 'source'), false); assert.equal(Object.hasOwn(entry, 'phaseId'), false); assert.equal(Object.hasOwn(entry, 'authoredPath'), false);
  }
  const def = authored(); assert.equal(Object.isFrozen(def.authoring), true); assert.equal(Object.isFrozen(def.authoring!.steps[0].path), true);
  assert.deepEqual(validateWorkflowDefinition(JSON.parse(JSON.stringify(def))), def); f.service.dispose();
});

test('strict authoring rejects unknown/missing/accessor/prototype keys at all map levels', () => {
  for (const mutate of [
    (d: any) => { d.authoring.extra = true; }, (d: any) => { delete d.authoring.sourceHash; },
    (d: any) => { d.authoring.steps[0].extra = true; }, (d: any) => { d.authoring.steps[0].span.extra = true; },
    (d: any) => { d.authoring.phases[0].extra = true; }, (d: any) => { d.authoring.phases[0].span.extra = true; },
    (d: any) => { d.authoring.steps[0].path = Object.assign(['work'], { extra: true }); },
    (d: any) => { Object.defineProperty(d.authoring, 'sourceHash', { enumerable: true, get() { throw new Error('Accessor executed'); } }); },
    (d: any) => { Object.setPrototypeOf(d.authoring, { hidden: true }); },
  ]) invalid(mutate, /Unknown|hash|array|accessor|Nonplain/i);
});

test('source and graph hashes, display names, source byte/length and metadata budgets are strict', () => {
  for (const key of ['sourceHash', 'graphHash']) for (const value of ['A'.repeat(64), 'a'.repeat(63), '', null]) invalid(d => { d.authoring[key] = value; }, /hash/);
  invalid(d => { d.steps[0].prompt = 'Graph changed'; }, /graph hash mismatch/);
  for (const name of ['../source.js', 'a\u001b[31m.js', 'a\u202e.js', '', 'x'.repeat(129)]) invalid(d => { d.authoring.sourceName = name; }, /source name/);
  for (const value of [-1, 0, 65537, 1.5, '100']) invalid(d => { d.authoring.sourceBytes = value; }, /source bounds/);
  for (const value of [-1, 0, 65537, 1.5, '100']) invalid(d => { d.authoring.sourceLength = value; }, /source bounds/);
  invalid(d => { d.authoring.sourceBytes = 301; }, /source bounds/);
  invalid(d => { d.authoring.sourceLength = 101; }, /source bounds/);
  invalid(d => { d.authoring.padding = 'x'.repeat(8192); }, /byte budget/);
  invalid(d => { d.steps[0].prompt = 'x'.repeat(65536); }, /byte budget/);
});

test('unsupported format/language/compiler/parser versions refuse migration-required without reinterpretation', () => {
  for (const key of ['formatVersion', 'languageVersion', 'compilerVersion', 'parserVersion']) {
    invalid(d => { d.authoring[key] = key === 'parserVersion' ? 'typescript@next' : 2; }, /migration-required/);
    invalid(d => { delete d.authoring[key]; }, /migration-required/);
  }
});

test('authored path maps require exact unique top/body coverage and phase IDs/membership stay scoped', () => {
  for (const mutate of [
    (d: any) => { d.authoring.steps.pop(); }, (d: any) => { d.authoring.steps[1].path = ['work']; },
    (d: any) => { d.authoring.steps[1].path = ['missing']; }, (d: any) => { d.authoring.steps[1].path = ['work', 'report']; },
    (d: any) => { d.authoring.steps[1].path = ['work:0']; }, (d: any) => { d.authoring.steps[1].path = []; },
    (d: any) => { d.authoring.phases[0].paths.push(['work']); }, (d: any) => { d.authoring.phases[0].paths.push(['missing']); },
    (d: any) => { d.authoring.phases.push(structuredClone(d.authoring.phases[0])); },
    (d: any) => { d.authoring.phases.push({ ...d.authoring.phases[0], id: 'other' }); },
    (d: any) => { d.authoring.phases[0].paths = []; }, (d: any) => { d.authoring.phases[0].id = 'bad/id'; },
  ]) invalid(mutate, /coverage|path|membership|phase/i);
  const loop: WorkflowDefinition = { id: 'loop', version: 2, label: 'Loop', inputSchema: empty, steps: [
    { id: 'loop', kind: 'repeat', dependsOn: [], initial: { value: false }, stateSchema: bool, body: [
      { id: 'work', kind: 'native', agentId: 'agent', prompt: 'Read only', dependsOn: [], inputs: {}, outputSchema: bool },
    ], feedback: { ref: { source: 'step', stepId: 'work', path: [] } }, until: { op: 'boolean', value: { ref: { source: 'iteration', path: [] } } }, output: { ref: { source: 'iteration', path: [] } }, outputSchema: bool, maxIterations: 2 },
  ] };
  const def = structuredClone(authored(loop));
  def.authoring!.phases.push({ id: 'body', paths: [['loop', 'work']], span: { start: 60, end: 65, line: 1, column: 60 } });
  assert.deepEqual(validateWorkflowDefinition(def), def);
  def.authoring!.phases[0].paths.push(['loop', 'work']);
  assert.throws(() => validateWorkflowDefinition(def), /cross-scope|membership/);
});

test('source positions reject out-of-range, incomplete and noninteger UTF16 spans', () => {
  for (const span of [null, {}, { start: -1, end: 5, line: 1, column: 0 }, { start: 0, end: 0, line: 1, column: 0 },
    { start: 0, end: 101, line: 1, column: 0 }, { start: 0, end: 5, line: 0, column: 0 },
    { start: 0, end: 5, line: 2, column: 0 }, { start: 0, end: 5, line: 1, column: 1 },
    { start: 0.5, end: 5, line: 1, column: 0 }, { start: 0, end: 5, line: 1, column: -1 }]) {
    invalid(d => { d.authoring.steps[0].span = span; }, /span/);
    invalid(d => { d.authoring.phases[0].span = span; }, /span/);
  }
});

test('full definition and unit hashes bind source-only/location/phase edits while graph hash remains equal', async () => {
  const first = authored(), second = authored(graph(), '/' + ' '.repeat(99));
  assert.equal(first.authoring!.graphHash, second.authoring!.graphHash); assert.notEqual(workflowHash(first), workflowHash(second));
  const f = fixture(first); const run = await completed(f);
  const old = workflowUnitHash(run, run.definition.steps[0], {});
  const edited = { ...run, definition: second, definitionHash: workflowHash(second) };
  assert.notEqual(workflowUnitHash(edited, second.steps[0], {}), old);
  for (const mutate of [(d: any) => { d.authoring.sourceName = 'renamed.js'; }, (d: any) => { d.authoring.steps[0].span.end++; }, (d: any) => { d.authoring.phases[0].id = 'renamed'; }]) {
    const def = structuredClone(first); mutate(def); validateWorkflowDefinition(def); assert.notEqual(workflowHash(def), workflowHash(first));
  }
  f.service.dispose();
});

test('frozen provenance/checkpoints roundtrip inertly without parser/provider or recovery authority', async () => {
  const f = fixture(authored(), true); const run = await completed(f);
  assert.equal(run.recovery!.definitionHash, workflowHash(f.definition));
  const saved = JSON.stringify(f.container.read().extensions.workflows);
  const restored = recoverWorkflowState(JSON.parse(saved));
  assert.deepEqual(restored.runs[0].definition.authoring, run.definition.authoring);
  assert.equal(restored.runs[0].recovered, true);
  const container = createClankersStateContainer({ agentDefinitions: { agent }, extensions: { workflows: restored as any } });
  let admissions = 0; const inert: WorkflowNativePort = { preflight() { admissions++; }, async execute() { admissions++; throw new Error('No replay'); } };
  const service = createWorkflowService(container, inert, f.options); await service.drain();
  assert.equal(admissions, 0); assert.equal(service.approvals.inspect().length, 0);
  assert.equal(f.acquisitions, 0); assert.equal(f.publications, 0);
  assert.equal(service.get(run.workflowRunId)!.definitionHash, run.definitionHash);
  assert.equal(JSON.stringify(f.container.read().extensions.workflows), saved);
  f.service.dispose(); service.dispose();
});

test('saved full-hash/unit/checkpoint bindings reject provenance forgery, never reconstruct source', async () => {
  const f = fixture(authored(), true); await completed(f);
  const saved = JSON.parse(JSON.stringify(f.container.read().extensions.workflows)) as WorkflowState;
  const changed = (mutate: (state: WorkflowState) => void) => { const state = structuredClone(saved); mutate(state); assert.throws(() => recoverWorkflowState(state), /Invalid workflow run|input\/dependency hash mismatch|checkpoint\/run binding mismatch|migration-required|graph hash mismatch/); };
  changed(state => { state.runs[0].definition.authoring!.sourceHash = 'b'.repeat(64); });
  changed(state => { const run = state.runs[0]; run.definition.authoring!.sourceHash = 'b'.repeat(64); run.definitionHash = workflowHash(run.definition); });
  changed(state => { const run = state.runs[0]; run.definition.authoring!.sourceHash = 'b'.repeat(64); run.definitionHash = workflowHash(run.definition); for (const step of run.steps) for (const unit of step.units) unit.inputHash = workflowUnitHash(run, run.definition.steps.find(s => s.id === step.id)!, unit.inputs); });
  changed(state => { (state.runs[0].definition.authoring as any).compilerVersion = 2; });
  changed(state => { state.runs[0].definition.steps[0].prompt = 'Forged graph'; });
  f.service.dispose();
});

test('source-only explicit redefine invalidates recovery fingerprints and old confirmation before any acquisition', async () => {
  const f = fixture(authored(), true); const run = await completed(f);
  const selections = { rerunUnitIds: ['work:0'], reuseUnitIds: [] };
  const before = await f.service.recovery!.prepare(run.workflowRunId, selections); assert.equal(before.ok, true, before.error);
  const fp = (before.assessment as any).fingerprint as string;
  const replacement = authored(graph(), '/' + ' '.repeat(99));
  assert.equal(replacement.authoring!.graphHash, run.definition.authoring!.graphHash);
  const defined = await f.service.execute({ action: 'workflows.define', definition: replacement }); assert.equal(defined.ok, true, defined.error);
  const after = await f.service.recovery!.prepare(run.workflowRunId, selections); assert.equal(after.ok, true, after.error);
  assert.notEqual((after.assessment as any).fingerprint, fp); assert.match(JSON.stringify((after.assessment as any).blocked), /definition-drift/);
  const confirm = await f.service.recovery!.authorize({ workflowRunId: run.workflowRunId, assessmentFingerprint: fp, selections });
  assert.equal(confirm.ok, false); assert.match(confirm.error ?? '', /fingerprint is stale/);
  assert.equal(f.acquisitions, 0); assert.equal(f.publications, 0); assert.equal(f.nativeCalls, 1);
  assert.equal(f.service.get(run.workflowRunId)!.definitionHash, run.definitionHash); f.service.dispose();
});

test('explicit source/phase projections preserve exact execution/native identities and stay out of list DTOs', async () => {
  const f = fixture(); const run = await completed(f); const view = workflowView(run);
  assert.deepEqual(view.steps![0].authoredPath, ['work']); assert.equal(view.steps![0].phaseId, 'main');
  assert.deepEqual(view.steps![0].source, { sourceName: 'workflow.workflow.js', span: { start: 0, end: 5, line: 1, column: 0 } });
  assert.equal(view.correlations[0].unitId, 'work:0'); assert.deepEqual(view.correlations[0].native, { runId: 'native-1', taskId: 'task-1' });
  assert.deepEqual(view.correlations[0].authoredPath, ['work']);
  view.steps![0].source!.span.end = 99; assert.equal(run.definition.authoring!.steps[0].span.end, 5);
  const list = await f.service.execute({ action: 'workflows.list' }); assert.equal(Object.hasOwn(list.runs![0], 'steps'), false); assert.equal(Object.hasOwn(list.runs![0], 'correlations'), false);
  f.service.dispose();
});
test('authoring maps retain exact16 bounds, dense arrays and sanitized display maximum', () => {
  const sixteen: WorkflowDefinition = { ...graph(), steps: Array.from({ length: 16 }, (_, i) => ({
    id: `work-${i}`, kind: 'native', agentId: 'agent', prompt: 'Read only', dependsOn: [], inputs: {}, outputSchema: bool,
  })) };
  const def = structuredClone(authored(sixteen, ' '.repeat(1000)));
  def.authoring!.sourceName = 'x'.repeat(128);
  def.authoring!.phases = def.authoring!.steps.map((entry, i) => ({ id: `phase-${i}`, paths: [entry.path], span: entry.span }));
  assert.equal(validateWorkflowDefinition(def).authoring!.phases.length, 16);
  const tooManyPhases = structuredClone(def);
  tooManyPhases.authoring!.phases.push({ id: 'overflow', paths: [['work-0']], span: def.authoring!.steps[0].span });
  assert.throws(() => validateWorkflowDefinition(tooManyPhases), /phase limit/);
  const extraMap = structuredClone(def); extraMap.authoring!.steps.push(extraMap.authoring!.steps[0]);
  assert.throws(() => validateWorkflowDefinition(extraMap), /coverage/);
  for (const mutate of [
    (d: any) => { delete d.authoring.steps[0]; },
    (d: any) => { delete d.authoring.phases[0].paths[0]; },
    (d: any) => { delete d.authoring.steps[0].path[0]; },
    (d: any) => { d.authoring.steps[0].path.push('extra', 'extra'); },
  ]) { const bad = structuredClone(def); mutate(bad); assert.throws(() => validateWorkflowDefinition(bad), /array|path/); }
  const noPhases = structuredClone(def); noPhases.authoring!.phases = [];
  assert.equal(validateWorkflowDefinition(noPhases).authoring!.phases.length, 0);
  // Positions and raw sourceHash cannot be authenticated from a frozen graph alone.
  const opaqueSource = structuredClone(def); opaqueSource.authoring!.sourceHash = 'b'.repeat(64);
  assert.equal(validateWorkflowDefinition(opaqueSource).authoring!.sourceHash, 'b'.repeat(64));
});

const compiledSource = `workflow({id: "authored", label: "Authored", inputSchema: {type: "object", properties: {}, additionalProperties: false}}, () => {
  const flag = {type: "boolean"};
  const work = native("work", {agentId: "agent", prompt: "Read only", dependsOn: [], inputs: {}, outputSchema: flag});
  const report = aggregate("report", {operation: "collect", dependsOn: [work], inputs: {result: ref(work, [])}});
  phase("main", [work, report]);
});`;
async function compiled(source: string, sourceName = 'workflow.workflow.js') {
  const { compileWorkflowScript } = await import('../workflow-script.js');
  const reply = await compileWorkflowScript(source, { sourceName });
  assert.equal(reply.ok, true, reply.ok ? undefined : JSON.stringify(reply.diagnostics));
  if (!reply.ok) throw new Error('Compilation failed');
  return reply.definition;
}
function assertSourcePositions(source: string, definition: WorkflowDefinition) {
  const authoring = definition.authoring!;
  assert.equal(authoring.sourceHash, digest(source));
  assert.equal(authoring.sourceBytes, Buffer.byteLength(source, 'utf8'));
  assert.equal(authoring.sourceLength, source.length);
  for (const entry of [...authoring.steps, ...authoring.phases]) {
    const before = source.slice(0, entry.span.start), lines = before.split('\n');
    assert.equal(entry.span.line, lines.length);
    assert.equal(entry.span.column, lines.at(-1)!.length);
    assert(entry.span.end > entry.span.start && entry.span.end <= source.length);
    assert(source.slice(entry.span.start, entry.span.end).trim().length > 0);
  }
}

test('actual compiler provenance is deterministic UTF8/UTF16 data with equivalent graph and changed full hashes', async () => {
  const source = '// 😀 é\n' + compiledSource;
  const first = await compiled(source), second = await compiled(source);
  assert.deepEqual(first, second); assertSourcePositions(source, first);
  const { authoring, ...plain } = first;
  assert.deepEqual(plain, validateWorkflowDefinition(graph()));
  assert.equal(authoring!.graphHash, workflowHash(plain));
  assert(authoring!.sourceBytes > authoring!.sourceLength);
  assert.deepEqual(authoring!.steps.map(s => s.path), [['work'], ['report']]);
  for (const entry of authoring!.steps) assert(source.slice(entry.span.start, entry.span.end).includes(`${entry.path[0]}\"`));
  assert.deepEqual(authoring!.phases.map(p => ({ id: p.id, paths: p.paths })), [{ id: 'main', paths: [['work'], ['report']] }]);
  const editedSource = '// changed authoring only\n' + source;
  const edited = await compiled(editedSource); assertSourcePositions(editedSource, edited);
  assert.equal(edited.authoring!.graphHash, authoring!.graphHash);
  assert.notEqual(workflowHash(first), workflowHash(edited));
  assert.notDeepEqual(edited.authoring!.steps[0].span, authoring!.steps[0].span);
});

test('compiler-produced repeat paths and scoped phases project across iterations without conflating exact native identities', async () => {
  const source = `workflow({id: "repeat-sources", label: "Repeat sources", inputSchema: {type: "object", properties: {}, additionalProperties: false}}, () => {
    const flag = {type: "boolean"};
    const first = repeat("first", {dependsOn: [], initial: value(false), stateSchema: flag, outputSchema: flag, maxIterations: 2}, () => {
      const work = native("work", {agentId: "agent", prompt: "Read only", dependsOn: [], inputs: {}, outputSchema: flag});
      phase("first-body", [work]);
      return {feedback: ref(work, []), until: {op: "boolean", value: ref("iteration", [])}, output: ref("iteration", [])};
    });
    const second = repeat("second", {dependsOn: [first], initial: value(false), stateSchema: flag, outputSchema: flag, maxIterations: 2}, () => {
      const work = native("work", {agentId: "agent", prompt: "Read only", dependsOn: [], inputs: {}, outputSchema: flag});
      phase("second-body", [work]);
      return {feedback: ref(work, []), until: {op: "boolean", value: ref("iteration", [])}, output: ref("iteration", [])};
    });
    phase("outer", [first, second]);
  });`;
  const definition = await compiled(source); assertSourcePositions(source, definition);
  const f = fixture(definition, true, true);
  try {
    const run = await completed(f), view = workflowView(run);
    assert.equal(f.nativeCalls, 4); assert.equal(run.admissions, 4);
    assert.equal(run.recovery!.budget.usedAdmissions, 4);
    for (const block of ['first', 'second']) {
      const body = view.correlations.filter(c => c.blockId === block);
      assert.equal(body.length, 2); assert.deepEqual(body.map(c => c.iterationNo), [1, 2]);
      assert.equal(new Set(body.map(c => c.unitId)).size, 2);
      assert.equal(new Set(body.map(c => c.iterationId)).size, 2);
      const mapped = definition.authoring!.steps.find(s => s.path.join('/') === `${block}/work`)!;
      for (const entry of body) {
        assert.deepEqual(entry.authoredPath, [block, 'work']); assert.equal(entry.phaseId, `${block}-body`);
        assert.deepEqual(entry.source, { sourceName: 'workflow.workflow.js', span: mapped.span });
        assert(entry.unitId.includes(entry.iterationId!)); assert(entry.native?.runId.startsWith('native-'));
        const op = run.recovery!.operations.find(o => o.unitId === entry.unitId)!;
        assert.equal(op.iterationId, entry.iterationId);
      }
      const bodySteps = view.steps!.filter(s => s.authoredPath?.join('/') === `${block}/work`);
      assert.equal(bodySteps.length, 2); assert(bodySteps.every(s => s.phaseId === `${block}-body`));
      assert.equal(view.steps!.find(s => s.id === block)!.phaseId, 'outer');
    }
    const native = view.correlations.filter(c => c.native); assert.equal(new Set(native.map(c => c.native!.runId)).size, 4);
    const saved = JSON.parse(JSON.stringify(f.container.read().extensions.workflows));
    const restored = recoverWorkflowState(saved), restoredView = workflowView(restored.runs[0]);
    assert.deepEqual(restoredView.steps, view.steps); assert.deepEqual(restoredView.correlations, view.correlations);
    assert.deepEqual(restored.runs[0].definition.authoring, definition.authoring);
  } finally { f.service.dispose(); }
});

test('actual compiled source-only edits invalidate old plans but hashes never prove external inputs or reusable native closure', async () => {
  const first = await compiled(compiledSource), edited = await compiled('// source edit\n' + compiledSource);
  const f = fixture(first, true);
  try {
    const run = await completed(f);
    assert.deepEqual(workflowRecoverySourceContract(), { knownHash: null, explicitUnknown: true });
    for (const op of run.recovery!.operations.filter(o => o.kind === 'native')) {
      assert.notEqual(classifyRecoveryOperation(op, { inputHash: op.inputHash, dependencyHash: op.dependencyHash, policyHash: op.policyHash,
        evidenceHash: op.result?.evidenceHash, resultHash: op.result?.resultHash }).classification, 'completed-valid');
    }
    const selections = { rerunUnitIds: ['work:0'], reuseUnitIds: [] };
    const before = await f.service.recovery!.prepare(run.workflowRunId, selections); assert.equal(before.ok, true, before.error);
    const fingerprint = (before.assessment as any).fingerprint as string;
    assert.equal(first.authoring!.graphHash, edited.authoring!.graphHash);
    const savedRunHash = run.definitionHash;
    const redefine = await f.service.execute({ action: 'workflows.define', definition: edited }); assert.equal(redefine.ok, true, redefine.error);
    const after = await f.service.recovery!.prepare(run.workflowRunId, selections); assert.equal(after.ok, true, after.error);
    assert.notEqual((after.assessment as any).fingerprint, fingerprint);
    const confirm = await f.service.recovery!.authorize({ workflowRunId: run.workflowRunId, assessmentFingerprint: fingerprint, selections });
    assert.equal(confirm.ok, false); assert.match(confirm.error ?? '', /fingerprint is stale/);
    assert.equal(f.service.get(run.workflowRunId)!.definitionHash, savedRunHash);
    assert.equal(f.acquisitions, 0); assert.equal(f.publications, 0); assert.equal(f.nativeCalls, 1);
    assert.equal(f.service.approvals.inspect().length, 0);
  } finally { f.service.dispose(); }
});

test('valid root metadata accepts exactly8192 UTF8 bytes and rejects8193 including only known fields', () => {
  const body = Array.from({ length: 15 }, (_, i) => ({ ...graph().steps[0], id: (`work-${i}-`).padEnd(80, 'x') }));
  const loop: WorkflowDefinition = { ...graph(), steps: [{
    id: 'loop-'.padEnd(80, 'x'), kind: 'repeat', dependsOn: [], initial: { value: false }, stateSchema: bool,
    body, feedback: { ref: { source: 'step', stepId: body[0].id, path: [] } },
    until: { op: 'boolean', value: { ref: { source: 'iteration', path: [] } } },
    output: { ref: { source: 'iteration', path: [] } }, outputSchema: bool, maxIterations: 1,
  }] };
  const def = structuredClone(authored(loop, ' '.repeat(1000))), metadata = def.authoring!;
  metadata.sourceName = 'x'.repeat(128);
  metadata.phases = metadata.steps.map((entry, i) => ({ id: (`phase-${i}-`).padEnd(80, 'x'), paths: [entry.path], span: entry.span }));
  const bytes = () => Buffer.byteLength(JSON.stringify(metadata), 'utf8');
  assert(bytes() > 8192);
  for (const phase of metadata.phases) while (bytes() > 8192 && phase.id.length > 16) phase.id = phase.id.slice(0, -1);
  assert.equal(bytes(), 8192); assert.doesNotThrow(() => validateWorkflowDefinition(def));
  metadata.phases.find(p => p.id.length < 80)!.id += 'x';
  assert.equal(bytes(), 8193); assert.throws(() => validateWorkflowDefinition(def), /byte budget/);
});
