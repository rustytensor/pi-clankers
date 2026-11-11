import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { validateWorkflowDefinition, workflowHash, workflowView, type WorkflowRun, type WorkflowAction, type WorkflowUnit } from '../../workflow-model.js';
import { compileWorkflowScript } from '../../workflow-script.js';
import { ClankersWorkflowComponent, type ClankersWorkflowOverlayOptions } from '../../ui/workflow-overlay.js';

const script = `workflow({id:"mapped",label:"Mapped progress",inputSchema:{type:"object",properties:{},additionalProperties:false}},()=>{
const read=native("read",{dependsOn:[],inputs:{},agentId:"safe",prompt:"Read only",outputSchema:{type:"boolean"}});
phase("reading",[read]);
});`;
const span = { start: 1, end: 20, line: 2, column: 0 };
const unit = (stepId: string, id: string, nativeId: string): WorkflowUnit => ({ id, stepId, index: 0, status: 'completed', inputHash: 'input', inputs: {}, result: true, cleanupSettled: true, native: { runId: nativeId, taskId: `task-${nativeId}` } });
function run(): WorkflowRun {
  const graph = validateWorkflowDefinition({ id: 'mapped', version: 2, label: 'Mapped progress', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    steps: [{ id: 'read', kind: 'native', dependsOn: [], inputs: {}, agentId: 'safe', prompt: 'Read only', outputSchema: { type: 'boolean' } }] });
  const definition = structuredClone(validateWorkflowDefinition({ ...graph, authoring: { formatVersion: 1, languageVersion: 1, compilerVersion: 1, parserVersion: 'typescript@5.9.3', sourceHash: 'a'.repeat(64), graphHash: workflowHash(graph), sourceName: 'mapped.workflow.js', sourceLength: 100, sourceBytes: 100, steps: [{ path: ['read'], span }], phases: [{ id: 'reading', paths: [['read']], span }] } }));
  return { workflowRunId: 'workflow-exact', familyId: 'family-exact', attemptNo: 2, definitionHash: workflowHash(definition), inputs: {}, agents: {}, concurrency: 8, definition,
    status: 'completed', createdAt: '2026-10-06T00:00:00Z', updatedAt: '2026-10-06T00:00:01Z', admissions: 1, cleanupSettled: true, recovered: false,
    steps: [{ id: 'read', status: 'completed', units: [unit('read', 'read.unit.0', 'native-exact')] }] };
}
function fixture(initial = run()) {
  let value = initial, result: { native: { runId: string; taskId: string } } | undefined, unsubscribed = 0;
  const actions: WorkflowAction[] = [];
  const service: ClankersWorkflowOverlayOptions['service'] = { list: () => [workflowView(value)], get: id => id === value.workflowRunId ? value : undefined,
    subscribe: () => () => { unsubscribed++; }, execute: async action => { actions.push(action); return { ok: true, action: action.action }; },
    approvals: { inspect: () => [], grant() { throw new Error('No approval authority in source display.'); }, grantFingerprint() { throw new Error('No approval authority.'); }, reject() { throw new Error('No approval authority.'); }, revoke() { throw new Error('No approval authority.'); } } };
  const component = new ClankersWorkflowComponent(undefined, undefined, reply => { result = reply; }, { service, workflowRunId: initial.workflowRunId, onOpenNative() {} });
  return { component, actions, update(next: WorkflowRun) { value = next; }, native: () => result?.native, get result() { return result; }, get unsubscribed() { return unsubscribed; } };
}
const render = (c: ClankersWorkflowComponent) => c.render(512, 32).join('\n');

test('actual compiled source maps render in existing step/result rows without authoring or start actions', async () => {
  const compiled = await compileWorkflowScript(script, { sourceName: 'mapped.workflow.js' }); assert.equal(compiled.ok, true);
  if (!compiled.ok) return;
  const value = run(); value.definition = compiled.definition;
  const location = compiled.definition.authoring!.steps[0]!.span;
  const f = fixture(value);
  try {
    assert.match(render(f.component), /phase read · completed · 1 units.*authored read.*group reading.*source mapped.workflow.js/);
    assert.ok(render(f.component).includes(`:${location.line}:${location.column}`));
    f.component.handleInput('enter'); render(f.component); f.component.handleInput('enter');
    assert.match(render(f.component), /native run native-exact.*task task-native-exact/);
    assert.match(render(f.component), /authored read.*group reading/); assert.deepEqual(f.actions, []);
  } finally { f.component.dispose(); }
});

test('repeat iterations share compiled authored paths but retain distinct runtime unit and native identities', async () => {
  const repeatSource = `workflow({id:"mapped",label:"Mapped progress",inputSchema:{type:"object",properties:{},additionalProperties:false}},()=>{
const cycle=repeat("refine",{dependsOn:[],initial:value(false),stateSchema:{type:"boolean"},outputSchema:{type:"boolean"},maxIterations:2},()=>{
const read=native("read",{dependsOn:[],inputs:{},agentId:"safe",prompt:"Read only",outputSchema:{type:"boolean"}});
phase("body-reading",[read]);
return {feedback:ref(read,[]),until:{op:"eq",left:ref("iteration",[]),right:value(true)},output:ref(read,[])};
});
phase("refinement",[cycle]);
});`;
  const compiled = await compileWorkflowScript(repeatSource, { sourceName: 'repeat.workflow.js' }); assert.equal(compiled.ok, true, JSON.stringify(compiled));
  if (!compiled.ok) return;
  const value = run(); value.definition = compiled.definition;
  const bodySpan = compiled.definition.authoring!.steps.find(row => row.path.length === 2)!.span;
  value.steps = [{ id: 'refine', status: 'completed', units: [], termination: 'converged', iterations: [0, 1].map(index => {
    const id = `refine.iteration.${index}`; const stepId = `${id}/read`;
    return { id, index, state: {}, decision: true, steps: [{ id: stepId, status: 'completed', units: [unit(stepId, `${stepId}.unit.0`, `native-${index}`)] }] };
  }) }];
  const f = fixture(value);
  try {
    assert.match(render(f.component), /authored refine.*group refinement/);
    f.component.handleInput('enter'); render(f.component); f.component.handleInput('end'); render(f.component); f.component.handleInput('enter');
    const text = render(f.component);
    assert.match(text, /phase refine.iteration.1\/read.*authored refine\/read.*group body-reading/);
    assert.ok(text.includes(`:${bodySpan.line}:${bodySpan.column}`));
    f.component.handleInput('enter'); assert.match(render(f.component), /unit refine.iteration.1\/read.unit.0/);
    f.component.handleInput('c'); assert.deepEqual(f.result?.native, { runId: 'native-1', taskId: 'task-native-1' });
    assert.equal(f.unsubscribed, 1); assert.deepEqual(f.actions, []);
  } finally { f.component.dispose(); }
});

test('source display sanitizes terminal control strings and obeys every pane width/height', () => {
  const value = run(); const authoring = value.definition.authoring!;
  authoring.sourceName = '中文 é 👨‍👩‍👧‍👦 \x1b]52;c;SOURCE-OSC\x07\x9d52;c;C1-OSC\x9c.workflow.js';
  authoring.phases[0]!.id = 'reading\x1bPSECRET\x1b\\\x1b[31mred\x1b[0m';
  const f = fixture(value);
  try {
    for (const level of ['steps', 'units', 'result']) {
      for (const width of [1, 2, 3, 8, 20, 80, 512]) for (const height of [1, 2, 3, 5, 32, 128]) {
        const lines = f.component.render(width, height); assert.ok(lines.length <= height, level);
        for (const line of lines) assert.ok(visibleWidth(line) <= width, `${level} ${width}x${height}`);
        // Pi Text/truncation may append its own harmless SGR reset; submitted
        // OSC/DCS/C1 control content must never reach terminal output.
        assert.doesNotMatch(lines.join('\n').replace(/\x1b\[[0-9;]*m/g, ''), /SOURCE-OSC|C1-OSC|SECRET|\x1b|\x9d|\x9c/);
      }
      render(f.component); f.component.handleInput('enter');
    }
    assert.deepEqual(f.actions, []);
  } finally { f.component.dispose(); }
});

test('authored labels never select a sibling native identity or grant recovery/approval authority', () => {
  const f = fixture();
  try {
    render(f.component); f.component.handleInput('enter'); render(f.component);
    const replacement = run(); replacement.definition.authoring!.steps[0]!.span.line = 99;
    replacement.steps[0]!.units[0]!.native = { runId: 'native-replaced', taskId: 'task-replaced' }; f.update(replacement);
    f.component.handleInput('c'); assert.equal(f.result, undefined);
    render(f.component); f.component.handleInput('c'); assert.deepEqual(f.native(), { runId: 'native-replaced', taskId: 'task-replaced' });
    assert.deepEqual(f.actions, []);
  } finally { f.component.dispose(); }
});

test('legacy definitions without authoring preserve existing progress and exact coding navigation', () => {
  const value = run(); delete value.definition.authoring; value.definition.version = 1;
  const f = fixture(value);
  try {
    assert.doesNotMatch(render(f.component), /authored|group reading|source mapped/);
    f.component.handleInput('enter'); render(f.component); f.component.handleInput('c');
    assert.deepEqual(f.result?.native, { runId: 'native-exact', taskId: 'task-native-exact' }); assert.deepEqual(f.actions, []);
  } finally { f.component.dispose(); }
});
