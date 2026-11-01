import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { registerHooks } from 'node:module';
import type { ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZergState, createZergStateContainer } from '../state.js';
import type { StructuralPiToolDefinition, ZergControlAction, ZergStateContainer } from '../types.js';
import type { WorkflowDefinition, WorkflowState } from '../workflow-model.js';

// History's existing static API import is allowed; the shortcut bridge is inert.
// Preferences get only a throwing static facade, never an agent directory.
// Every other Pi-root request remains forbidden.
let staticHistoryLoads = 0, staticBridgeLoads = 0, staticPreferencesLoads = 0, sdkLoads = 0, preferenceDirCalls = 0, controlledRejections = 0;
const bridgeParents = new Set(['../internal-patch.ts', '../internal-patch.js'].map(path => new URL(path, import.meta.url).href));
const bridgeUrl = `data:text/javascript,${encodeURIComponent('export class ExtensionRunner {}')}`;
const preferencesParents = new Set(['../ui/preferences.ts', '../ui/preferences.js'].map(path => new URL(path, import.meta.url).href));
(globalThis as any).__scriptControlPreferenceDirCall = () => { preferenceDirCalls++; };
const preferencesUrl = `data:text/javascript,${encodeURIComponent('export function getAgentDir() { globalThis.__scriptControlPreferenceDirCall(); throw new Error("Agent directory lookup forbidden in authoring tests."); }')}`;
function resolvePiRoot(parentURL: string | undefined, controlledNegative = false) {
  if (parentURL?.endsWith('/native-history.ts') || parentURL?.endsWith('/native-history.js')) { staticHistoryLoads++; return undefined; }
  if (parentURL && bridgeParents.has(parentURL)) { staticBridgeLoads++; return { url: bridgeUrl, shortCircuit: true }; }
  if (parentURL && preferencesParents.has(parentURL)) { staticPreferencesLoads++; return { url: preferencesUrl, shortCircuit: true }; }
  if (controlledNegative) controlledRejections++; else sdkLoads++;
  throw new Error('SDK/session/provider execution forbidden in authoring tests.');
}
let mutateRead: (() => void) | undefined;
(globalThis as any).__scriptControlReadMutation = () => mutateRead?.();
const parserChildren: Array<{ child: ChildProcess; closed: boolean }> = [];
(globalThis as any).__scriptControlSpawn = (command: string, args: string[], child: ChildProcess) => {
  assert.equal(command, process.execPath); assert.ok(args.some(arg => arg.endsWith('workflow-script-compiler.mjs')));
  const record = { child, closed: false }; parserChildren.push(record); child.once('close', () => { record.closed = true; });
};
const processWrapper = `export * from 'child_process'; import {spawn as real} from 'child_process'; export function spawn(command,args,options){const child=real(command,args,options);globalThis.__scriptControlSpawn(command,args,child);return child;}`;
const fsWrapper = `export * from 'fs'; import {readSync as read} from 'fs'; export function readSync(...args){const result=read(...args);globalThis.__scriptControlReadMutation?.();return result;}`;
const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@earendil-works/pi-coding-agent') {
    return resolvePiRoot(context.parentURL) ?? next(specifier, context);
  }
  if (specifier === 'node:child_process' && context.parentURL?.includes('/workflow-script-process.')) return { url: `data:text/javascript,${encodeURIComponent(processWrapper)}`, shortCircuit: true };
  if (specifier === 'node:fs' && context.parentURL?.includes('/workflow-script-controls.')) return { url: `data:text/javascript,${encodeURIComponent(fsWrapper)}`, shortCircuit: true };
  return next(specifier, context);
} });
after(() => { hook.deregister(); delete (globalThis as any).__scriptControlReadMutation; delete (globalThis as any).__scriptControlSpawn; delete (globalThis as any).__scriptControlPreferenceDirCall; });
const { createZergControl, createPiZergCommandHandler, registerZergSwarmExtension } = await import('../index.js');
const { parseWorkflowScriptAction, readWorkflowScriptFile, executeWorkflowScriptAction } = await import('../workflow-script-controls.js');

test('authoring static imports account for history, inert bridge and uncalled preferences facade', async () => {
  assert.equal(staticHistoryLoads, 1); assert.equal(staticBridgeLoads, 1); assert.equal(staticPreferencesLoads, 1);
  assert.equal(sdkLoads, 0); assert.equal(preferenceDirCalls, 0);
  const { ExtensionRunner } = await import(bridgeUrl);
  assert.deepEqual(Reflect.ownKeys(ExtensionRunner.prototype), ['constructor']);
  assert.equal(Object.hasOwn(ExtensionRunner.prototype, 'getShortcuts'), false);
  const preferencesFacade = await import(preferencesUrl);
  assert.deepEqual(Object.keys(preferencesFacade), ['getAgentDir']);
  assert.equal(typeof preferencesFacade.getAgentDir, 'function'); // Do not invoke: nonTUI authoring must never call it.
  assert.equal(preferenceDirCalls, 0);
});

test('authoring guard rejects other Pi-root parents with separately counted negative probes', () => {
  const parents = [undefined, new URL('../index.ts', import.meta.url).href,
    new URL('../workflow-script-controls.ts', import.meta.url).href,
    new URL('../nested/internal-patch.ts', import.meta.url).href,
    'file:///unrelated/internal-patch.ts', new URL('../internal-patch.ts?other', import.meta.url).href,
    ...['../nested/ui/preferences.ts', '../nested/ui/preferences.js', '../preferences.ts', '../preferences.js',
      '../ui/preferences.ts?other', '../ui/preferences.js?other', '../ui/preferences.ts#other', '../ui/preferences.js#other']
      .map(path => new URL(path, import.meta.url).href),
    'file:///unrelated/ui/preferences.ts', 'file:///unrelated/ui/preferences.js'];
  assert.equal(controlledRejections, 0);
  for (const parent of parents) assert.throws(() => resolvePiRoot(parent, true), /SDK\/session\/provider execution forbidden/);
  assert.equal(controlledRejections, parents.length);
  assert.equal(staticHistoryLoads, 1); assert.equal(staticBridgeLoads, 1); assert.equal(staticPreferencesLoads, 1);
  assert.equal(sdkLoads, 0); assert.equal(preferenceDirCalls, 0);
});


const source = `workflow({id:"script-control",label:"Control test",inputSchema:{type:"object",properties:{},additionalProperties:false}},()=>{
const review=native("review",{dependsOn:[],inputs:{},agentId:"safe",prompt:"/literal",outputSchema:{type:"object",properties:{ok:{type:"boolean"}},required:["ok"],additionalProperties:false}});
phase("reading",[review]);
});`;
function fixture() {
  const base = createZergStateContainer(createZergState()); let writes = 0, launches = 0, notifications = 0;
  const container: ZergStateContainer = { read: () => base.read(), snapshot: () => base.snapshot(), subscribe: listener => base.subscribe!(listener),
    replace: state => { writes++; return base.replace(state); }, update: (state, options) => { writes++; return base.update(state, options); } };
  const off = base.subscribe!(() => { notifications++; });
  const control = createZergControl(container, { subagentAdapter: { kind: 'fake', launch() { launches++; throw new Error('No native launch authority.'); } } });
  return { control, container, close: () => { off(); control.dispose(); }, get effects() { return { writes, launches, notifications, sdkLoads, preferenceDirCalls }; } };
}
const payload = (result: Awaited<ReturnType<ReturnType<typeof fixture>['control']['execute']>>) => { assert.equal(result.ok, true, result.error?.message); return result.data as any; };

test('pure validate/compile and missing inspect have zero state, SDK, command, approval or workspace effects', async () => {
  const f = fixture(); const initial = f.control.getState(), effects = f.effects;
  const directory = mkdtempSync(join(tmpdir(), 'script-pure-'));
  try {
    writeFileSync(join(directory, 'workspace.txt'), 'unchanged');
    const validate = payload(await f.control.execute({ action: 'workflows.scripts.validate', source }));
    assert.deepEqual(Object.keys(validate), ['inspection']); assert.equal(validate.inspection.id, 'script-control');
    const compile = payload(await f.control.execute({ action: 'workflows.scripts.compile', source }));
    assert.ok(Object.isFrozen(compile.definition)); assert.ok(Object.isFrozen(compile.definition.steps));
    assert.equal(compile.definition.authoring.steps[0].path[0], 'review');
    assert.ok(Buffer.byteLength(JSON.stringify(compile.definition)) <= 65536);
    assert.equal((await f.control.execute({ action: 'workflows.scripts.inspect', definitionId: 'script-control' })).ok, false);
    assert.deepEqual(f.control.getState(), initial); assert.deepEqual(f.effects, effects);
    assert.equal(f.control.getState().extensions.workflows, undefined);
    assert.equal(readFileSync(join(directory, 'workspace.txt'), 'utf8'), 'unchanged'); assert.deepEqual(readdirSync(directory), ['workspace.txt']);
    assert.deepEqual(initial.agents, {}); assert.deepEqual(initial.tasks, {});
  } finally { f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('explicit save defines once, never starts or grants approval; imported source has no authority', async () => {
  const f = fixture();
  try {
    const saved = payload(await f.control.execute({ action: 'workflows.scripts.save', source }));
    assert.equal(saved.saved.id, 'script-control'); assert.ok(f.effects.writes > 0);
    const ledger = f.control.getState().extensions.workflows as WorkflowState;
    assert.equal(ledger.definitions.filter(definition => definition.id === 'script-control').length, 1);
    assert.equal(ledger.runs.length, 0); assert.equal(f.effects.launches, 0); assert.equal(sdkLoads, 0);
    const before = f.control.getState(), effects = f.effects;
    const inspected = payload(await f.control.execute({ action: 'workflows.scripts.inspect', definitionId: 'script-control' }));
    assert.deepEqual(inspected.definition, ledger.definitions.find(definition => definition.id === 'script-control')); assert.ok(Object.isFrozen(inspected.definition));
    assert.deepEqual(f.control.getState(), before); assert.deepEqual(f.effects, effects);
    const changed = payload(await f.control.execute({ action: 'workflows.scripts.compile', source: source + '\n// unsaved' }));
    assert.notEqual(changed.definition.authoring.sourceHash, inspected.definition.authoring.sourceHash);
    assert.deepEqual(f.control.getState(), before);
    const resaved = payload(await f.control.execute({ action: 'workflows.scripts.save', source: source + '\n// explicitly saved edit' }));
    assert.equal(resaved.saved.id, 'script-control');
    const edited = payload(await f.control.execute({ action: 'workflows.scripts.inspect', definitionId: 'script-control' }));
    assert.notEqual(edited.definition.authoring.sourceHash, inspected.definition.authoring.sourceHash);
    assert.equal(edited.definition.authoring.graphHash, inspected.definition.authoring.graphHash);
    assert.notDeepEqual(edited.definition, inspected.definition);
    assert.deepEqual((f.control.getState().extensions.workflows as WorkflowState).runs, []);
    assert.deepEqual(f.control.workflowApprovals!.inspect(), []);
    const started = await f.control.execute({ action: 'workflows.start', definitionId: 'script-control', inputs: {} });
    assert.equal(started.ok, false); assert.equal(f.effects.launches, 0); assert.equal(sdkLoads, 0);
  } finally { f.close(); }
});

test('saved inspect invokes neither compiler nor lazy define capability, including legacy graphs', async () => {
  // Remove only authoring metadata from a real compiler product; keep its
  // existing native schema/operation contract and inspect it without parsing.
  const f = fixture();
  try {
    const compiled = payload(await f.control.execute({ action: 'workflows.scripts.compile', source })).definition as WorkflowDefinition;
    const { authoring: _authoring, ...definition } = compiled;
    definition.version = 1;
    let ledgerReads = 0;
    const reply = await executeWorkflowScriptAction({ action: 'workflows.scripts.inspect', definitionId: definition.id }, {
      readLedger() { ledgerReads++; return { version: 1, definitions: [definition], runs: [] }; }, cwd: '/unreadable',
      define() { throw new Error('Lazy service must not be touched.'); },
    });
    assert.equal(reply.ok, true); assert.equal(ledgerReads, 1); assert.equal((reply.data as any).definition.authoring, undefined);
  } finally { f.close(); }
});

test('structured authoring rejects unknown keys/types/getters/prototypes without effects', async () => {
  const f = fixture(); const before = f.control.getState(), effects = f.effects;
  try {
    for (const action of [
      { action: 'workflows.scripts.validate', source, start: true }, { action: 'workflows.scripts.compile', source, approved: true },
      { action: 'workflows.scripts.save', source, concurrency: 1 }, { action: 'workflows.scripts.validate', source, typo: undefined },
      { action: 'workflows.scripts.validate', source: 1 }, { action: 'workflows.scripts.compile', source, sourceName: 4 },
      { action: 'workflows.scripts.inspect', definitionId: 'a', source }, { action: 'workflows.scripts.inspect', definitionId: '../a' },
      { action: 'workflows.scripts.import', path: 'a', source }, { action: 'workflows.scripts.import', path: '../a' },
      { action: 'workflows.scripts.validate', source: 'x'.repeat(65537) }, { action: 'workflows.scripts.validate', source: '界'.repeat(30000) },
    ]) assert.equal((await f.control.execute(action as unknown as ZergControlAction)).ok, false, JSON.stringify(Object.keys(action)));
    let getter = 0; const hostile = { action: 'workflows.scripts.validate', get source() { getter++; return source; } };
    assert.throws(() => parseWorkflowScriptAction(hostile)); assert.equal(getter, 0);
    assert.throws(() => parseWorkflowScriptAction(Object.assign(Object.create({ inherited: true }), { action: 'workflows.scripts.validate', source })));
    assert.throws(() => parseWorkflowScriptAction({ action: 'workflows.scripts.validate', source, [Symbol('extra')]: 1 }));
    assert.deepEqual(f.control.getState(), before); assert.deepEqual(f.effects, effects);
  } finally { f.close(); }
});

test('malformed source diagnostics remain bounded and cannot cause save/approval effects', async () => {
  const f = fixture(); const before = f.control.getState(), effects = f.effects;
  try {
    for (const text of ['process.exit(0)', 'workflow(', 'import fs from "node:fs"', source.replace('dependsOn:[]', 'dependsOn:[],approved:true'), '\ud800']) {
      const result = await f.control.execute({ action: 'workflows.scripts.save', source: text }); assert.equal(result.ok, false);
      const diagnostics = (result.data as any)?.diagnostics;
      if (diagnostics) { assert.ok(diagnostics.length <= 8); for (const diagnostic of diagnostics) assert.ok(diagnostic.message.length <= 256); }
    }
    assert.deepEqual(f.control.getState(), before); assert.deepEqual(f.effects, effects);
  } finally { f.close(); }
});

test('already aborted pure/save/import actions do not parse, read or initialize workflow owner', async () => {
  const f = fixture(), controller = new AbortController(); controller.abort(); const before = f.control.getState(), effects = f.effects;
  try {
    for (const action of [{ action: 'workflows.scripts.validate', source }, { action: 'workflows.scripts.save', source }, { action: 'workflows.scripts.import', path: 'missing.workflow.js' }] as ZergControlAction[]) assert.equal((await f.control.execute(action, controller.signal)).ok, false);
    assert.deepEqual(f.control.getState(), before); assert.deepEqual(f.effects, effects);
  } finally { f.close(); }
});

test('slash aliases preserve authoring JSON parity in noninteractive modes without a workflow service', async () => {
  const f = fixture(), handler = createPiZergCommandHandler(f.container); const before = f.control.getState(), effects = f.effects;
  try {
    for (const command of ['/zerg', '/zerg-swarm', '/swarm']) for (const mode of ['json', 'print', 'rpc'] as const) {
      let notice = '', level = '';
      await handler(`${command} workflows scripts validate ${JSON.stringify({ source })}`, { mode, hasUI: false, ui: { notify(text, kind) { notice = text; level = kind ?? ''; }, custom() { throw new Error('No TUI authoring dependency.'); } } });
      assert.equal(level, 'info', notice); assert.equal(JSON.parse(notice).inspection.id, 'script-control');
    }
    for (const body of ['compile {}', 'validate []', 'validate null', 'validate {', 'unknown {}', `validate ${JSON.stringify({ source, action: 'workflows.start' })}`, `validate ${JSON.stringify({ source, start: true })}`, `import ${JSON.stringify({ path: '../bad' })}`]) {
      let level = ''; await handler(`/zerg workflows scripts ${body}`, { mode: 'json', hasUI: false, ui: { notify(_text, kind) { level = kind ?? ''; } } }); assert.equal(level, 'error', body);
    }
    let invalidNotice = '';
    await handler('/zerg workflows scripts validate {SOURCE-MUST-NOT-ECHO', { mode: 'json', hasUI: false, ui: { notify(text) { invalidNotice = text; } } });
    assert.equal(invalidNotice, 'Script command requires valid bounded JSON fields.');
    assert.deepEqual(f.control.getState(), before); assert.deepEqual(f.effects, effects);
  } finally { f.close(); }
});

test('registered zerg_control authoring schema and unknown-key rejection work without SDK', async () => {
  let tool: StructuralPiToolDefinition | undefined;
  const registration = registerZergSwarmExtension({ registerCommand() {}, registerTool(value) { if (value.name === 'zerg_control') tool = value; } });
  try {
    assert.ok(tool?.execute); const before = registration.control.getState();
    const properties = (tool.parameters as any).properties;
    assert.equal(properties.workflowRunId.maxLength, 160, 'Preserve the existing workflow identity schema');
    assert.equal(properties.source.maxLength, 65536); assert.equal(properties.path.maxLength, 1024);
    const caller = new AbortController(); caller.abort(); const children = parserChildren.length;
    assert.equal((await tool.execute('cancelled', { action: 'workflows.scripts.save', source }, caller.signal)).isError, true);
    assert.equal(parserChildren.length, children, 'Tool forwards caller cancellation before parsing');
    const valid = await tool.execute('test', { action: 'workflows.scripts.validate', source }); assert.equal(valid.isError, false);
    const invalid = await tool.execute('test', { action: 'workflows.scripts.compile', source, approved: true }); assert.equal(invalid.isError, true);
    assert.deepEqual(registration.control.getState(), before); assert.equal(sdkLoads, 0);
  } finally { registration.dispose(); }
});

test('safe import reads only explicit local file and saves without any native execution', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'script-import-')); mkdirSync(join(directory, 'src')); writeFileSync(join(directory, 'src/test.workflow.js'), source);
  let definitions: WorkflowDefinition[] = [];
  try {
    const reply = await executeWorkflowScriptAction({ action: 'workflows.scripts.import', path: 'src/test.workflow.js' }, { cwd: directory, readLedger: () => undefined,
      async define(definition) { definitions.push(definition); return { ok: true, action: 'workflows.define', definition: { id: definition.id, label: definition.label, stepCount: definition.steps.length } }; },
    });
    assert.equal(reply.ok, true); assert.equal(definitions.length, 1); assert.equal(definitions[0]!.authoring!.sourceName, 'test.workflow.js');
    assert.equal(sdkLoads, 0); assert.equal(readFileSync(join(directory, 'src/test.workflow.js'), 'utf8'), source);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('file import rejects absolute/traversal/NUL/symlink ancestors/leaf/directories/special/oversize/invalidUTF8', () => {
  const directory = mkdtempSync(join(tmpdir(), 'script-hazards-'));
  try {
    mkdirSync(join(directory, 'folder')); writeFileSync(join(directory, 'good.js'), source); symlinkSync('good.js', join(directory, 'link.js')); symlinkSync('folder', join(directory, 'linked-folder'));
    writeFileSync(join(directory, 'bad.js'), Buffer.from([0xc0, 0xaf])); writeFileSync(join(directory, 'large.js'), 'x'.repeat(65537));
    for (const path of ['/absolute.js', '../good.js', 'folder/../good.js', './good.js', 'folder//good.js', 'x\0.js', 'C:bad', 'folder\\good.js', 'link.js', 'linked-folder/good.js', 'folder', 'bad.js', 'large.js']) assert.throws(() => readWorkflowScriptFile(path, directory), path);
    // /dev/null is a readable nonregular device, never source; the descriptor walk is not a scan.
    assert.throws(() => readWorkflowScriptFile('null', '/dev'), /regular file/);
    assert.equal(readWorkflowScriptFile('good.js', directory), source);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('growth and same-size mutation during descriptor read fail closed with descriptor cleanup', () => {
  const directory = mkdtempSync(join(tmpdir(), 'script-growth-')), path = join(directory, 'source.js');
  try {
    for (const change of [() => appendFileSync(path, 'more'), () => writeFileSync(path, 'y'.repeat(8))]) {
      writeFileSync(path, 'x'.repeat(8)); let changed = false;
      mutateRead = () => { if (!changed) { changed = true; change(); } };
      assert.throws(() => readWorkflowScriptFile('source.js', directory), /changed or grew/); assert.ok(changed);
      mutateRead = undefined;
      assert.doesNotThrow(() => readWorkflowScriptFile('source.js', directory));
    }
  } finally { mutateRead = undefined; rmSync(directory, { recursive: true, force: true }); }
});

test('control disposal cancels active/queued parser jobs and drain waits for actual child close, without saving', async () => {
  const f = fixture(), before = f.control.getState(), effects = f.effects, start = parserChildren.length;
  try {
    const jobs = [f.control.execute({ action: 'workflows.scripts.save', source }), f.control.execute({ action: 'workflows.scripts.compile', source }), f.control.execute({ action: 'workflows.scripts.validate', source })];
    assert.ok(parserChildren.length > start, 'Actual owned parser process started before disposal.');
    f.control.dispose(); f.control.dispose(); await f.control.drain!(); await f.control.drain!();
    for (const result of await Promise.all(jobs)) assert.equal(result.ok, false, 'Disposed owner cannot report authoring success.');
    assert.ok(parserChildren.slice(start).every(record => record.closed), 'drain returns only after actual child close.');
    assert.deepEqual(f.control.getState(), before); assert.deepEqual(f.effects, effects);
    assert.equal((await f.control.execute({ action: 'workflows.scripts.compile', source })).ok, false);
  } finally { f.close(); await f.control.drain!(); }
});

test('disposing one compiler control owner cannot cancel another owner queued in the module admission lane', async () => {
  const a = fixture(), b = fixture(), initial = b.control.getState();
  try {
    const first = a.control.execute({ action: 'workflows.scripts.compile', source });
    const second = b.control.execute({ action: 'workflows.scripts.compile', source });
    a.control.dispose(); await a.control.drain!();
    assert.equal((await first).ok, false); payload(await second);
    assert.deepEqual(b.control.getState(), initial); assert.equal(b.effects.writes, 0); assert.equal(b.effects.launches, 0);
  } finally { a.close(); b.close(); await Promise.all([a.control.drain!(), b.control.drain!()]); }
});

test('caller abort after actual parser launch and read-only revocation before save cannot initialize or persist a ledger', async () => {
  const f = fixture(), caller = new AbortController(), before = f.control.getState(), start = parserChildren.length;
  try {
    const aborted = f.control.execute({ action: 'workflows.scripts.save', source }, caller.signal);
    assert.ok(parserChildren.length > start); caller.abort(); assert.equal((await aborted).ok, false); await f.control.drain!();
    assert.ok(parserChildren.slice(start).every(record => record.closed)); assert.deepEqual(f.control.getState(), before); assert.equal(f.effects.writes, 0);
    const saving = f.control.execute({ action: 'workflows.scripts.save', source });
    f.container.replace(createZergState({ ...f.container.read(), mode: { ...f.container.read().mode, readOnly: true } }));
    const readonly = f.control.getState(), effects = f.effects;
    assert.equal((await saving).ok, false); assert.deepEqual(f.control.getState(), readonly); assert.deepEqual(f.effects, effects);
    assert.equal(readonly.extensions.workflows, undefined);
    payload(await f.control.execute({ action: 'workflows.scripts.validate', source })); assert.deepEqual(f.control.getState(), readonly);
  } finally { f.close(); await f.control.drain!(); }
});

test('registered slash authoring shares control ownership across disposal and shutdown', async () => {
  const commands: Record<string, { handler: ReturnType<typeof createPiZergCommandHandler> }> = {};
  const registration = registerZergSwarmExtension({ registerCommand(name, command) { commands[name] = command; } }, { subagentAdapter: { kind: 'fake', launch() { throw new Error('No native launch.'); } } });
  const before = registration.control.getState(), start = parserChildren.length; let notice = '', level = '';
  try {
    const job = commands.zerg!.handler(`workflows scripts save ${JSON.stringify({ source })}`, { mode: 'json', hasUI: false, ui: { notify(text, kind) { notice = text; level = kind ?? ''; } } });
    assert.ok(parserChildren.length > start); registration.dispose(); await registration.control.drain!(); await job;
    assert.equal(level, 'error', notice); assert.deepEqual(registration.control.getState(), before);
    assert.ok(parserChildren.slice(start).every(record => record.closed));
  } finally { registration.dispose(); await registration.control.drain!(); }
});

test('pure authoring with configured durable recovery creates no ledger, snapshots, owner claims, or receipts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'script-persist-pure-'));
  const state = createZergStateContainer(createZergState());
  let launches = 0, settlement = 0;
  const control = createZergControl(state, { persistence: { enabled: true, rootDir: directory }, recovery: { enabled: true, inspectNativeSettlement() { settlement++; throw new Error('No runtime owner for authoring.'); } },
    subagentAdapter: { kind: 'fake', launch() { launches++; throw new Error('No native launch.'); } } });
  const files = () => readdirSync(directory, { recursive: true }).map(String).sort().map(name => [name, readFileSync(join(directory, name)).toString('hex')]);
  try {
    const before = control.getState(), disk = files();
    payload(await control.execute({ action: 'workflows.scripts.validate', source }));
    payload(await control.execute({ action: 'workflows.scripts.compile', source }));
    assert.equal((await control.execute({ action: 'workflows.scripts.inspect', definitionId: 'missing' })).ok, false);
    assert.deepEqual(control.getState(), before); assert.deepEqual(files(), disk);
    assert.equal(before.extensions.workflows, undefined); assert.equal(launches, 0); assert.equal(settlement, 0); assert.equal(sdkLoads, 0);
  } finally { control.dispose(); await control.drain!(); rmSync(directory, { recursive: true, force: true }); }
});

test('all five registered slash/structured authoring actions have parity and no implicit start', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'script-parity-')); writeFileSync(join(directory, 'test.workflow.js'), source);
  const commands: Record<string, { handler: ReturnType<typeof createPiZergCommandHandler> }> = {};
  let tool: StructuralPiToolDefinition | undefined;
  const registration = registerZergSwarmExtension({ registerCommand(name, command) { commands[name] = command; }, registerTool(value) { if (value.name === 'zerg_control') tool = value; } }, { cwd: directory,
    subagentAdapter: { kind: 'fake', launch() { throw new Error('No implicit native start.'); } } });
  const slash = async (verb: string, fields: object, alias = 'zerg') => {
    let notice = '', level = '';
    await commands[alias]!.handler(`workflows scripts ${verb} ${JSON.stringify(fields)}`, { mode: 'rpc', hasUI: false, cwd: directory, ui: { notify(text, kind) { notice = text; level = kind ?? ''; }, custom() { throw new Error('No custom TUI dependency.'); } } });
    assert.equal(level, 'info', notice); return JSON.parse(notice);
  };
  try {
    assert.ok(tool?.execute);
    const structured = async (verb: string, fields: object) => {
      const result = await tool!.execute!('test', { action: `workflows.scripts.${verb}`, ...fields });
      assert.equal(result.isError, false, JSON.stringify(result)); return (result.details as any).data;
    };
    for (const verb of ['validate', 'compile']) {
      const before = registration.control.getState(); assert.deepEqual(await slash(verb, { source }), await structured(verb, { source })); assert.deepEqual(registration.control.getState(), before);
    }
    assert.deepEqual(await slash('save', { source }), await structured('save', { source }));
    for (const alias of ['zerg', 'zerg-swarm', 'swarm']) {
      const before = registration.control.getState(), count = parserChildren.length;
      assert.deepEqual(await slash('inspect', { definitionId: 'script-control' }, alias), await structured('inspect', { definitionId: 'script-control' }));
      assert.equal(parserChildren.length, count, 'saved inspect never starts parser'); assert.deepEqual(registration.control.getState(), before);
    }
    assert.deepEqual(await slash('import', { path: 'test.workflow.js' }), await structured('import', { path: 'test.workflow.js' }));
    const ledger = registration.control.getState().extensions.workflows as WorkflowState;
    assert.equal(ledger.definitions.filter(definition => definition.id === 'script-control').length, 1);
    assert.equal(ledger.runs.length, 0); assert.equal(sdkLoads, 0);
    assert.equal(ledger.definitions.find(definition => definition.id === 'script-control')!.authoring!.sourceName, 'test.workflow.js'); assert.deepEqual(registration.control.workflowApprovals!.inspect(), []);
  } finally { registration.dispose(); await registration.control.drain!(); rmSync(directory, { recursive: true, force: true }); }
});


test('caller cancellation reaps the active parser before the action promise completes, not merely before drain', async () => {
  const f = fixture(), caller = new AbortController(), start = parserChildren.length;
  try {
    const job = f.control.execute({ action: 'workflows.scripts.save', source }, caller.signal);
    const record = parserChildren[start]!; assert.ok(record?.child.pid); caller.abort();
    const result = await job;
    assert.equal(result.ok, false); assert.ok(record.closed, 'action promise cannot outrun actual parser close');
    assert.throws(() => process.kill(record.child.pid!, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
    assert.equal(f.effects.writes, 0); assert.equal(f.control.getState().extensions.workflows, undefined);
  } finally { f.close(); await f.control.drain!(); }
});

test('dispose, caller cancellation, and read-only revocation during lazy-ledger publication cannot save', async () => {
  for (const revoke of ['dispose', 'abort', 'readOnly'] as const) {
    const f = fixture(), caller = new AbortController(); let revoked = false, writesAtRevocation = 0;
    const off = f.container.subscribe!(() => {
      if (revoked || !f.container.read().extensions.workflows) return;
      revoked = true;
      if (revoke === 'dispose') f.control.dispose();
      else if (revoke === 'abort') caller.abort();
      else f.container.replace(createZergState({ ...f.container.read(), mode: { ...f.container.read().mode, readOnly: true } }));
      writesAtRevocation = f.effects.writes;
    });
    try {
      const result = await f.control.execute({ action: 'workflows.scripts.save', source }, caller.signal);
      assert.ok(revoked); assert.equal(result.ok, false); assert.equal(f.effects.writes, writesAtRevocation);
      const ledger = f.control.getState().extensions.workflows as WorkflowState;
      assert.ok(ledger.definitions.every(definition => definition.id !== 'script-control'));
      assert.equal(ledger.runs.length, 0); assert.equal(f.effects.launches, 0);
    } finally { off(); f.close(); await f.control.drain!(); }
  }
});

test('public session_shutdown hook aborts and drains structured plus all slash aliases before returning', async () => {
  const commands: Record<string, { handler: ReturnType<typeof createPiZergCommandHandler> }> = {};
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const registration = registerZergSwarmExtension({
    registerCommand(name, command) { commands[name] = command; return { dispose() { delete commands[name]; } }; },
    on(event, handler) { handlers.set(String(event), handler); return () => handlers.delete(String(event)); },
  }, { subagentAdapter: { kind: 'fake', launch() { throw new Error('No native launch.'); } } });
  const before = registration.control.getState(), start = parserChildren.length;
  const notices: string[] = [];
  try {
    const structured = registration.control.execute({ action: 'workflows.scripts.save', source });
    const slash = ['zerg', 'zerg-swarm', 'swarm'].map(alias => commands[alias]!.handler(`workflows scripts save ${JSON.stringify({ source })}`, {
      mode: 'json', hasUI: false, ui: { notify(_text, level) { notices.push(level ?? ''); } },
    }));
    assert.ok(parserChildren.length > start); const shutdown = handlers.get('session_shutdown'); assert.ok(shutdown);
    await shutdown();
    assert.ok(parserChildren.slice(start).every(record => record.closed));
    assert.equal((await structured).ok, false); await Promise.all(slash); assert.deepEqual(notices, ['error', 'error', 'error']);
    assert.deepEqual(registration.control.getState(), before); await shutdown(); await registration.control.drain!();
    assert.equal((await registration.control.execute({ action: 'workflows.scripts.compile', source })).ok, false);
  } finally { registration.dispose(); registration.dispose(); await registration.control.drain!(); }
});

test('reload-style disposal drains the old compiler owner and permits a fresh registration on the same fake host', async () => {
  const commands: Record<string, { handler: ReturnType<typeof createPiZergCommandHandler> }> = {};
  const host = { registerCommand(name: string, command: { handler: ReturnType<typeof createPiZergCommandHandler> }) {
    commands[name] = command; return { dispose() { delete commands[name]; } };
  } };
  const adapter = { kind: 'fake' as const, launch() { throw new Error('No native launch.'); } };
  const old = registerZergSwarmExtension(host, { subagentAdapter: adapter }), before = old.control.getState(), start = parserChildren.length;
  let oldLevel = '', freshLevel = '';
  try {
    const oldJob = commands.zerg!.handler(`workflows scripts save ${JSON.stringify({ source })}`, { mode: 'rpc', hasUI: false, ui: { notify(_text, level) { oldLevel = level ?? ''; } } });
    old.dispose(); old.dispose(); await old.control.drain!(); await oldJob;
    assert.equal(oldLevel, 'error'); assert.ok(parserChildren.slice(start).every(record => record.closed));
    assert.deepEqual(old.control.getState(), before);
    const fresh = registerZergSwarmExtension(host, { subagentAdapter: adapter });
    try {
      const freshBefore = fresh.control.getState();
      await commands.swarm!.handler(`workflows scripts validate ${JSON.stringify({ source })}`, { mode: 'rpc', hasUI: false, ui: { notify(_text, level) { freshLevel = level ?? ''; } } });
      assert.equal(freshLevel, 'info'); assert.deepEqual(fresh.control.getState(), freshBefore);
      assert.equal((await old.control.execute({ action: 'workflows.scripts.compile', source })).ok, false);
    } finally { fresh.dispose(); await fresh.control.drain!(); }
  } finally { old.dispose(); await old.control.drain!(); }
});

test('authoring leaves every actual parser child closed and never dynamically initializes the native SDK', () => {
  assert.equal(staticHistoryLoads, 1, 'Only the pre-existing static history API import is allowed');
  assert.equal(staticBridgeLoads, 1, 'Only the exact static shortcut bridge import receives the inert facade');
  assert.equal(staticPreferencesLoads, 1, 'Only the exact static preferences parent receives the throwing facade');
  assert.equal(preferenceDirCalls, 0, 'NonTUI authoring never looks up a real or manufactured agent directory');
  assert.equal(controlledRejections, 16, 'Deliberate guard probes are counted separately from authoring SDK attempts');
  assert.equal(sdkLoads, 0); assert.ok(parserChildren.length > 0);
  assert.ok(parserChildren.every(record => record.closed));
  for (const record of parserChildren) if (record.child.pid) assert.throws(() => process.kill(record.child.pid!, 0), (error: NodeJS.ErrnoException) => error.code === 'ESRCH');
});
