import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { registerHooks } from 'node:module';
import ts from 'typescript';
import type { ZergControlOptions } from '../index.js';
import * as helpModule from '../control-help.js';
import { ZERG_CONTROL_ACTION_NAMES, ZERG_CONTROL_HELP_CATALOG } from '../control-help.js';
import { createZergState, createZergStateContainer, readSharedZergState, replaceSharedZergState } from '../state.js';
import { validateSessionMessageInput, validateSessionMessageKey } from '../session-messages.js';
import { validateContinuationPrepare, type NativeContinuationPrepare } from '../native-continuation.js';
import { isWorkflowScriptActionName, parseWorkflowScriptAction } from '../workflow-script-controls.js';
import { validateWorkflowDefinition, type WorkflowDefinition } from '../workflow-model.js';
import { ZERG_EXTENSION_VERSION, type StructuralPiToolDefinition, type StructuralPiToolResult, type ZergControlAction, type ZergControlResult, type ZergStateContainer } from '../types.js';

// Reuse the existing authoring-test resolve-hook pattern: allow the three
// static Pi facades, but fail if help reaches lazy SDK/provider or compiler IO.
let armed = false;
let forbiddenEffects = 0;
const globals = globalThis as typeof globalThis & { __zergHelpEffect?: (name: string) => void };
globals.__zergHelpEffect = name => { if (armed) { forbiddenEffects++; assert.fail(`Help side effect: ${name}`); } };
const fsFacade = `export * from 'fs'; import * as fs from 'fs';
  export function openSync(...args) { globalThis.__zergHelpEffect('file read/open'); return fs.openSync(...args); }
  export function mkdirSync(...args) { globalThis.__zergHelpEffect('mkdir'); return fs.mkdirSync(...args); }
  export function writeFileSync(...args) { globalThis.__zergHelpEffect('snapshot write'); return fs.writeFileSync(...args); }
  export function renameSync(...args) { globalThis.__zergHelpEffect('snapshot publish'); return fs.renameSync(...args); }`;
const processFacade = `export * from 'child_process'; import { spawn as real } from 'child_process';
  export function spawn(...args) { globalThis.__zergHelpEffect('subprocess'); return real(...args); }`;
const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@earendil-works/pi-coding-agent' && armed) {
    forbiddenEffects++; assert.fail('Help requested lazy SDK/provider module');
  }
  if (specifier === 'node:fs' && /\/(persistence|native-transcript)\./.test(context.parentURL ?? ''))
    return { url: `data:text/javascript,${encodeURIComponent(fsFacade)}`, shortCircuit: true };
  if (specifier === 'node:child_process' && context.parentURL?.includes('/workflow-script-process.'))
    return { url: `data:text/javascript,${encodeURIComponent(processFacade)}`, shortCircuit: true };
  return next(specifier, context);
} });
after(() => { hook.deregister(); delete globals.__zergHelpEffect; });
const { createZergCommandHandler, createZergControl, registerZergSwarmExtension } = await import('../index.js');

const EXPECTED_ACTIONS = [
  'help', 'status', 'agents.list', 'agents.show', 'agents.result', 'agents.results', 'agents.create', 'agents.update', 'agents.delete',
  'team.create', 'team.update', 'run', 'runs.list', 'runs.show', 'timeline.list', 'logs.list',
  'tmux.workers.list', 'tmux.workers.show', 'tmux.workers.prompt', 'tmux.workers.steer', 'tmux.workers.close',
  'session.message.send', 'session.messages.list', 'session.continuation.prepare',
  'session.continuation.start', 'session.continuation.discard', 'message', 'interrupt',
  'workflows.list', 'workflows.define', 'workflows.show', 'workflows.start', 'workflows.pause',
  'workflows.resume', 'workflows.cancel', 'workflows.retry', 'workflows.report', 'workflows.forget',
  'workflows.recovery.inspect', 'workflows.recovery.prepare', 'workflows.scripts.validate',
  'workflows.scripts.compile', 'workflows.scripts.inspect', 'workflows.scripts.save', 'workflows.scripts.import',
] as const satisfies readonly ZergControlAction['action'][];
// A new public union member must acquire a regression case, not just a catalog entry.
type MissingAction = Exclude<ZergControlAction['action'], typeof EXPECTED_ACTIONS[number]>;
const exhaustive: Record<MissingAction, never> = {};
void exhaustive;
const indexSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
const indexAst = ts.createSourceFile('index.ts', indexSource, ts.ScriptTarget.Latest, true);
const sorted = (names: readonly string[]) => [...names].sort();
const bytes = (value: unknown) => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
const noRuntime = new Proxy({}, { get: (_target, key) => () => { assert.fail(`Help touched runtime ${String(key)}`); } });
const inertOptions: ZergControlOptions = {
  subagentAdapter: { kind: 'fake', launch() { assert.fail('Help launched native/provider work'); } },
  nativeTranscriptService: noRuntime as NonNullable<ZergControlOptions['nativeTranscriptService']>,
  sessionMessageService: noRuntime as NonNullable<ZergControlOptions['sessionMessageService']>,
  nativeContinuationService: noRuntime as NonNullable<ZergControlOptions['nativeContinuationService']>,
};
interface Directory {
  version: string; kind: 'directory'; groups: Array<{ name: string; actions: Array<{ action: string; summary: string; effects: string[] }> }>;
  hint: string; restrictions: string[];
}
interface Focused {
  version: string; kind: 'action'; action: string; summary: string;
  parameters: Array<{ name: string; type: string; required: boolean; description: string }>;
  constraints: string[]; effects: string[]; example: ZergControlAction; restrictions: string[];
}

function diskSnapshot(root: string): Array<{ path: string; content: string | null }> {
  const entries: Array<{ path: string; content: string | null }> = [];
  const walk = (directory: string, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = `${prefix}${entry.name}`;
      entries.push({ path, content: entry.isDirectory() ? null : readFileSync(join(directory, entry.name)).toString('base64') });
      if (entry.isDirectory()) walk(join(directory, entry.name), `${path}/`);
    }
  };
  walk(root); return entries;
}

function bounded(result: ZergControlResult, error = false): void {
  assert.ok(bytes(result.output ?? '') <= (error ? 512 : 16384));
  assert.ok(bytes(result.data ?? {}) <= 16384);
  // Check the ENTIRE envelope too: bounding only output leaves result.action vulnerable.
  assert.ok(bytes(result) <= (error ? 2048 : 32768));
  if (error) {
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'invalid_request');
    assert.ok(bytes(result.error?.message ?? '') <= 512);
    assert.ok(bytes(result.action) <= 512);
    assert.doesNotMatch(result.output ?? '', /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u);
    assert.doesNotMatch(result.action, /[\u0000-\u001f\u007f-\u009f]/u);
  }
}
function toolResult(result: StructuralPiToolResult, error = false): ZergControlResult {
  assert.ok(bytes(result) <= (error ? 4096 : 65536));
  for (const part of result.content ?? []) if (part.type === 'text') assert.ok(bytes(part.text ?? '') <= (error ? 512 : 16384));
  const details = result.details as ZergControlResult;
  bounded(details, error);
  assert.equal(result.isError, error);
  return details;
}
function registration(options: ZergControlOptions = inertOptions) {
  let tool: StructuralPiToolDefinition | undefined;
  const tools = new Map<string, StructuralPiToolDefinition>();
  const commands = new Map<string, { handler: (args: string, ctx: { hasUI: boolean; mode: 'print'; ui: { notify: (text: string) => void } }) => unknown }>();
  const owner = registerZergSwarmExtension({
    registerTool(value) { tools.set(value.name, value); if (value.name === 'clankers_control') tool = value; },
    registerCommand(name, value) { commands.set(name, value); },
  }, options);
  assert.deepEqual([...tools.keys()], ['clankers_control', 'zerg_control']);
  assert.equal(tools.get('clankers_control')?.execute, tools.get('zerg_control')?.execute);
  assert.equal(tools.get('clankers_control')?.parameters, tools.get('zerg_control')?.parameters);
  assert.ok(tool?.execute);
  return { owner, tool, commands, execute: (input: unknown) => Promise.resolve(tool!.execute!('help-regression', input, undefined, undefined, { hasUI: false, mode: 'print' })) };
}

/** Inspect just the existing pure tool parser; never call a mutating dispatcher to
 * validate illustrative examples. The installed TS parser is already a dependency.
 * Keep this small whitelist fail-closed if parser dependencies change. */
function pureToolParser(): (input: unknown) => { ok: boolean; action?: ZergControlAction; message?: string } {
  const names = ['parseZergControlToolParams', 'parseRecoveryControlToolAction', 'parseRecoverySelections', 'isZergControlActionName', 'workflowFailure'];
  const declarations = names.map(name => {
    const node = indexAst.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
    if (!node && name === 'isZergControlActionName') return ''; // May be imported from the shared catalog.
    assert.ok(node, `Missing pure parser ${name}`);
    return node.getText(indexAst).replace(/^export\s+/, '');
  });
  const workflowNames = EXPECTED_ACTIONS.filter(name => name.startsWith('workflows.') && !name.startsWith('workflows.scripts.'));
  const bindings = { ...helpModule, isWorkflowScriptActionName, parseWorkflowScriptAction,
    WORKFLOW_ACTION_NAMES: new Set(workflowNames), isZergOperatorMessageMode: (value: unknown) => value === 'steer' || value === 'followUp' };
  const js = ts.transpileModule(`${declarations.join('\n')}\nreturn parseZergControlToolParams;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings)) as ReturnType<typeof pureToolParser>;
}

// Dispatchers for legacy calls intentionally have permissive flat parsing. These
// additional PURE checks mirror required argument guards, not runtime existence,
// authority, provider availability, script compilation, or file readability.
function exampleArguments(example: ZergControlAction): void {
  const value = example as unknown as Record<string, unknown>;
  const nonempty = (key: string) => assert.ok(typeof value[key] === 'string' && (value[key] as string).trim(), `${example.action}: ${key}`);
  if (isWorkflowScriptActionName(example.action)) { assert.doesNotThrow(() => parseWorkflowScriptAction(example)); return; }
  switch (example.action) {
    case 'help': assert.ok(value.topic === undefined || EXPECTED_ACTIONS.includes(value.topic as typeof EXPECTED_ACTIONS[number])); break;
    case 'agents.create': nonempty('id'); nonempty('prompt'); break;
    case 'agents.update': nonempty('id'); if (value.prompt !== undefined) nonempty('prompt'); break;
    case 'agents.result': nonempty('id'); break;
    case 'agents.results': assert.ok(Array.isArray(value.ids) && value.ids.length >= 1 && value.ids.length <= 32 && value.ids.every(id => typeof id === 'string' && id.trim())); break;
    case 'agents.show': case 'agents.delete': case 'team.create': case 'team.update': nonempty('id'); break;
    case 'run': nonempty('agent'); nonempty('task');
      if (value.concurrency !== undefined) assert.ok(Number.isSafeInteger(value.concurrency) && Number(value.concurrency) > 0); break;
    case 'runs.show': nonempty('runId'); break;
    case 'tmux.workers.show': case 'tmux.workers.close': nonempty('workerId'); break;
    case 'tmux.workers.prompt': nonempty('workerId'); nonempty('task'); break;
    case 'tmux.workers.steer': nonempty('workerId'); nonempty('runId'); nonempty('body'); break;
    case 'message': nonempty('targetId'); nonempty('body'); assert.ok(value.mode === undefined || value.mode === 'steer' || value.mode === 'followUp'); break;
    case 'session.message.send': assert.ok(validateSessionMessageInput({ key: value, messageId: value.messageId, body: value.body, mode: value.mode })); break;
    case 'session.messages.list': assert.equal(validateSessionMessageKey(value), true);
      if (value.limit !== undefined) assert.ok(Number.isSafeInteger(value.limit) && Number(value.limit) >= 1 && Number(value.limit) <= 128); break;
    case 'session.continuation.prepare': {
      const { action: _action, ...input } = value;
      assert.doesNotThrow(() => validateContinuationPrepare(input as unknown as NativeContinuationPrepare)); break;
    }
    case 'session.continuation.start': nonempty('reviewId'); assert.equal(value.confirm, true); break;
    case 'session.continuation.discard': nonempty('reviewId'); break;
    case 'timeline.list':
      if (value.limit !== undefined) assert.ok(Number.isInteger(value.limit) && Number(value.limit) >= 1 && Number(value.limit) <= 256); break;
    case 'workflows.define': assert.doesNotThrow(() => validateWorkflowDefinition(value.definition as WorkflowDefinition)); break;
    case 'workflows.show': assert.ok((typeof value.definitionId === 'string') !== (typeof value.workflowRunId === 'string')); break;
    case 'workflows.start': nonempty('definitionId'); assert.ok(Object.hasOwn(value, 'inputs'));
      if (value.concurrency !== undefined) assert.ok(Number.isInteger(value.concurrency) && Number(value.concurrency) >= 1 && Number(value.concurrency) <= 32); break;
    case 'workflows.pause': case 'workflows.resume': case 'workflows.cancel': case 'workflows.retry': case 'workflows.report': case 'workflows.forget':
    case 'workflows.recovery.inspect': case 'workflows.recovery.prepare': nonempty('workflowRunId'); break;
    case 'status': case 'agents.list': case 'runs.list': case 'logs.list': case 'interrupt': case 'workflows.list': case 'tmux.workers.list': break;
    default: assert.fail(`Missing example argument coverage: ${example.action}`);
  }
}

test('control help general directory is static, grouped, bounded and exact', async () => {
  const control = createZergControl({}, inertOptions);
  try {
    const result = await control.execute({ action: 'help' }); bounded(result);
    assert.equal(result.ok, true); assert.equal(result.action, 'help');
    const data = result.data as Directory;
    assert.deepEqual(sorted(Object.keys(data)), sorted(['version', 'kind', 'groups', 'hint', 'restrictions']));
    assert.equal(data.kind, 'directory'); assert.equal(data.version, ZERG_EXTENSION_VERSION);
    assert.ok(data.groups.length > 1); assert.match(data.hint, /topic/);
    assert.deepEqual(sorted(data.groups.flatMap(group => group.actions.map(entry => entry.action))), sorted(EXPECTED_ACTIONS));
    for (const group of data.groups) {
      assert.ok(group.name);
      for (const entry of group.actions) { assert.ok(entry.summary); assert.ok(entry.effects.length); assert.equal('parameters' in entry, false); }
    }
    assert.ok(data.restrictions.length);
    assert.deepEqual((await control.execute({ action: 'help', topic: undefined })).data, data);
  } finally { control.dispose(); }
});

test('every exact action topic has identical direct/tool help and valid data-only example', async () => {
  const control = createZergControl({}, inertOptions); const host = registration(); const parse = pureToolParser();
  try {
    assert.deepEqual(toolResult(await host.execute({ action: 'help' })).data, (await control.execute({ action: 'help' })).data);
    for (const topic of EXPECTED_ACTIONS) {
      const direct = await control.execute({ action: 'help', topic }); bounded(direct); assert.equal(direct.ok, true, topic);
      const registered = toolResult(await host.execute({ action: 'help', topic })); assert.deepEqual(registered.data, direct.data, topic);
      const data = direct.data as Focused;
      assert.deepEqual(sorted(Object.keys(data)), sorted(['version', 'kind', 'action', 'summary', 'parameters', 'constraints', 'effects', 'example', 'restrictions']));
      assert.equal(data.kind, 'action'); assert.equal(data.action, topic); assert.equal(data.version, ZERG_EXTENSION_VERSION);
      assert.ok(data.summary); assert.ok(data.effects.length); assert.ok(Array.isArray(data.restrictions));
      assert.equal(new Set(data.parameters.map(parameter => parameter.name)).size, data.parameters.length);
      const action = data.parameters.find(parameter => parameter.name === 'action'); assert.ok(action?.required);
      for (const parameter of data.parameters) { assert.ok(parameter.type); assert.ok(parameter.description); assert.equal(typeof parameter.required, 'boolean'); }
      const example = JSON.parse(JSON.stringify(data.example)) as ZergControlAction;
      assert.equal(example.action, topic); assert.equal(parse(example).ok, true, `Tool parser rejected ${topic}`);
      for (const parameter of data.parameters.filter(parameter => parameter.required)) assert.ok(Object.hasOwn(example, parameter.name), `${topic}: ${parameter.name}`);
      exampleArguments(example); // Deliberately NOT control.execute(example).
    }
  } finally { control.dispose(); host.owner.dispose(); }
});

test('tool enum, public predicate, typed catalog and workflow/script families cannot drift', () => {
  const host = registration();
  try {
    assert.deepEqual(sorted(ZERG_CONTROL_ACTION_NAMES), sorted(EXPECTED_ACTIONS));
    assert.deepEqual(sorted(Object.keys(ZERG_CONTROL_HELP_CATALOG)), sorted(EXPECTED_ACTIONS));
    assert.equal(new Set(ZERG_CONTROL_ACTION_NAMES).size, EXPECTED_ACTIONS.length);
    const schema = host.tool.parameters as { additionalProperties: boolean; properties: { action: { enum: string[] }; topic: { type: string; maxLength: number; description: string } }; required: string[] };
    assert.deepEqual(sorted(schema.properties.action.enum), sorted(EXPECTED_ACTIONS));
    assert.equal(schema.additionalProperties, true, 'No unrelated global parser/schema tightening');
    assert.ok(schema.required.includes('action')); assert.equal(schema.properties.topic.type, 'string'); assert.equal(schema.properties.topic.maxLength, 96);
    assert.match(schema.properties.topic.description, /help/i); assert.match(`${host.tool.description} ${host.tool.promptGuidelines?.join(' ')}`, /help/);
    const parse = pureToolParser();
    for (const action of EXPECTED_ACTIONS.filter(action => !isWorkflowScriptActionName(action) && !action.startsWith('workflows.recovery.'))) {
      assert.equal(parse({ action }).ok, true, `Accepted-name predicate rejected ${action}`);
    }
    // Derive current runtime families independently of the new catalog.
    const declaration = indexAst.statements.find(node => ts.isVariableStatement(node) && node.declarationList.declarations.some(d => d.name.getText(indexAst) === 'WORKFLOW_ACTION_NAMES'));
    assert.ok(declaration);
    const runtimeNames: string[] = []; const visit = (node: ts.Node) => { if (ts.isStringLiteral(node) && node.text.startsWith('workflows.')) runtimeNames.push(node.text); ts.forEachChild(node, visit); }; visit(declaration);
    assert.deepEqual(sorted(runtimeNames), sorted(EXPECTED_ACTIONS.filter(name => name.startsWith('workflows.') && !name.startsWith('workflows.scripts.'))));
    const scriptAst = ts.createSourceFile('scripts.ts', readFileSync(new URL('../workflow-script-controls.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    const scriptNames: string[] = []; const visitScript = (node: ts.Node) => { if (ts.isStringLiteral(node) && isWorkflowScriptActionName(node.text)) scriptNames.push(node.text); ts.forEachChild(node, visitScript); }; visitScript(scriptAst);
    assert.deepEqual(sorted([...new Set(scriptNames)]), sorted(EXPECTED_ACTIONS.filter(isWorkflowScriptActionName)));
  } finally { host.owner.dispose(); }
});

test('focused metadata preserves conditional identities, defaults, bounds and authority exclusions', async () => {
  const control = createZergControl({}, inertOptions);
  const text = async (topic: ZergControlAction['action']) => JSON.stringify((await control.execute({ action: 'help', topic })).data);
  try {
    assert.match(await text('run'), /8/); assert.match(await text('run'), /concurrency/);
    assert.match(await text('workflows.start'), /32/);
    assert.match(await text('session.message.send'), /steer/); assert.match(await text('session.message.send'), /followUp/);
    for (const action of ['session.message.send', 'session.messages.list', 'session.continuation.prepare'] as const) {
      for (const field of ['parentRunId', 'memberRunId', 'piSessionId']) assert.match(await text(action), new RegExp(field));
    }
    assert.match(await text('timeline.list'), /256/); assert.match(await text('session.messages.list'), /128/);
    assert.match(await text('workflows.scripts.validate'), /65536|65,536/);
    assert.match(await text('workflows.scripts.import'), /relative/i);
    assert.match(await text('workflows.show'), /exactly one|mutually exclusive|either.*or/i);
    assert.match(await text('agents.update'), /existing|retain|preserv|inherit/i);
    assert.match(await text('workflows.recovery.prepare'), /not authoriz|does not authoriz|never authoriz/i);
    assert.match(await text('workflows.start'), /approv|authorit|trusted/i);
    // The native-continuation suite also exercises preparation with a blocked
    // read-only host and verifies that only start checks admission authority.
    assert.match(await text('session.continuation.prepare'), /permits read-only inspection/i);
    assert.match(await text('session.continuation.prepare'), /Only start checks execution admission/i);
    assert.doesNotMatch(await text('session.continuation.prepare'), /non-read-only owner/i);
    for (const forbidden of ['teams.create', 'workflows.approve', 'workflows.approvals.grant', 'workflows.recovery.authorize', 'grantFingerprint', 'authorize']) {
      assert.equal(Object.hasOwn(ZERG_CONTROL_HELP_CATALOG, forbidden), false);
      bounded(await control.execute({ action: 'help', topic: forbidden } as ZergControlAction), true);
    }
  } finally { control.dispose(); }
});

test('malformed, alias, fuzzy and oversized help topics/extras fail bounded on both paths', async () => {
  const control = createZergControl({}, inertOptions); const host = registration();
  const requests: unknown[] = [
    ...[null, false, 1, [], {}, '', ' help', 'help ', 'agents', 'agents.*', 'teams.create', 'HELP', 'x'.repeat(96), 'x'.repeat(97), '\u001b\u0000' + '💥'.repeat(50000)].map(topic => ({ action: 'help', topic })),
    { action: 'help', limit: 1 }, { action: 'help', source: 'x'.repeat(100000) }, { action: 'help', extra: undefined },
    Object.defineProperty({ action: 'help' }, 'hidden', { value: true }), { action: 'help', [Symbol('extra')]: true },
    { action: 'help', ['💥'.repeat(100000)]: true },
  ];
  try {
    for (const request of requests) {
      bounded(await control.execute(request as ZergControlAction), true);
      toolResult(await host.execute(request), true);
    }
    for (const request of [null, [], {}, { action: 1 }]) toolResult(await host.execute(request), true);
  } finally { control.dispose(); host.owner.dispose(); }
});

test('unknown actions remain errors with discovery guidance and bounded sanitized entire results', async () => {
  const control = createZergControl({}, inertOptions); const host = registration();
  try {
    for (const action of ['agents.lsit', 'workflows.recovery.authorize', 'x'.repeat(100000), '\u0000\u001b\n' + '💥'.repeat(50000)]) {
      const direct = await control.execute({ action } as ZergControlAction); bounded(direct, true);
      const registered = toolResult(await host.execute({ action }), true);
      for (const result of [direct, registered]) assert.match(result.error!.message, /\{"action":"help"\}/);
    }
  } finally { control.dispose(); host.owner.dispose(); }
});

test('topic on non-help is rejected without silently dispatching or changing state', async () => {
  const control = createZergControl({}, inertOptions); const host = registration();
  try {
    for (const action of ['status', 'agents.create', 'workflows.list', 'workflows.scripts.compile'] as const) {
      for (const topic of ['status', undefined, 'x'.repeat(100000)]) {
        bounded(await control.execute({ action, topic } as ZergControlAction), true);
        toolResult(await host.execute({ action, topic }), true);
      }
    }
  } finally { control.dispose(); host.owner.dispose(); }
});

test('read-only direct help reads revision without snapshots, publications, lazy workflows or persistence/runtime effects', async () => {
  const rootDir = mkdtempSync(join(tmpdir(), 'zerg-help-'));
  const base = createZergStateContainer(createZergState({ mode: { automation: 'manual', interventionEnabled: true, controller: 'operator', readOnly: true } }));
  let snapshots = 0, writes = 0, publications = 0, clocks = 0;
  const container: ZergStateContainer = { read: () => base.read(), snapshot: () => { snapshots++; return base.snapshot(); },
    replace: value => { writes++; return base.replace(value); }, update: (value, options) => { writes++; return base.update(value, options); }, subscribe: listener => base.subscribe!(listener) };
  const remove = base.subscribe!(() => { publications++; });
  const control = createZergControl(container, { ...inertOptions, persistence: { enabled: true, rootDir }, now: () => { clocks++; return new Date('2026-10-09T00:00:00Z'); } });
  const before = base.snapshot(); const baseline = { snapshots, writes, publications, clocks };
  forbiddenEffects = 0; armed = true;
  try {
    for (const topic of [undefined, ...EXPECTED_ACTIONS]) {
      const result = await control.execute(topic === undefined ? { action: 'help' } : { action: 'help', topic });
      assert.equal(result.ok, true); assert.equal(result.stateRevision, before.revision); bounded(result);
    }
    assert.equal(forbiddenEffects, 0);
    assert.deepEqual({ snapshots, writes, publications, clocks }, baseline);
    assert.deepEqual(base.snapshot(), before); assert.equal(base.read().extensions.workflows, undefined);
    assert.deepEqual(readdirSync(rootDir), [], 'Help must not create persistence directories/snapshots');
  } finally { armed = false; control.dispose(); remove(); rmSync(rootDir, { recursive: true, force: true }); }
});

test('registered non-UI/read-only help does not publish shared state or initialize workflows', async () => {
  const previous = readSharedZergState();
  replaceSharedZergState(createZergState({ mode: { automation: 'manual', interventionEnabled: true, controller: 'operator', readOnly: true } }));
  const rootDir = mkdtempSync(join(tmpdir(), 'zerg-tool-help-'));
  const host = registration({ ...inertOptions, persistence: { enabled: true, rootDir } }); const before = host.owner.state; const shared = readSharedZergState();
  // Registration itself may persist command/lifecycle setup; help must not.
  const diskBefore = diskSnapshot(rootDir);
  forbiddenEffects = 0; armed = true;
  try {
    for (const topic of [undefined, ...EXPECTED_ACTIONS]) {
      const result = toolResult(await host.execute(topic === undefined ? { action: 'help' } : { action: 'help', topic }));
      assert.equal(result.ok, true); assert.equal(result.stateRevision, before.revision);
    }
    assert.equal(forbiddenEffects, 0);
    assert.deepEqual(host.owner.state, before); assert.deepEqual(readSharedZergState(), shared);
    assert.equal(host.owner.state.extensions.workflows, undefined); assert.deepEqual(diskSnapshot(rootDir), diskBefore);
  } finally { armed = false; host.owner.dispose(); replaceSharedZergState(previous); rmSync(rootDir, { recursive: true, force: true }); }
});

test('legacy slash help and all registered aliases remain available without UI', async () => {
  const container = createZergStateContainer(); const before = container.snapshot(); const slash = createZergCommandHandler(container);
  const expected = slash('/zerg help'); assert.equal(expected.ok, true); assert.match(expected.output, /\/zerg/);
  for (const alias of ['/clankers', '/clank', '/zerg', '/zerg-swarm', '/swarm']) assert.deepEqual(slash(`${alias} help`), expected);
  const host = registration();
  try {
    assert.deepEqual(sorted([...host.commands.keys()]), sorted(['clankers', 'clank', 'zerg', 'zerg-swarm', 'swarm']));
    for (const command of host.commands.values()) {
      const output: string[] = []; await command.handler('help', { hasUI: false, mode: 'print', ui: { notify: text => { output.push(text); } } });
      assert.ok(output.some(text => text.includes('/zerg')));
    }
    assert.deepEqual(container.snapshot(), before);
  } finally { host.owner.dispose(); }
});

test('legacy valid inspection calls keep their permissive non-help fields and parser semantics', async () => {
  const control = createZergControl({}, inertOptions); const host = registration(); const parse = pureToolParser();
  try {
    for (const input of [{ action: 'status', unrelated: true }, { action: 'logs.list', limit: 1000 }, { action: 'timeline.list', limit: 256 }]) {
      assert.equal(parse(input).ok, true);
      assert.equal((await control.execute(input as ZergControlAction)).ok, true);
      assert.equal((await host.execute(input)).isError, false);
    }
    assert.equal(parse({ action: 'message', targetId: 'worker', body: 'Review', mode: 'followUp' }).ok, true);
    assert.equal(parse({ action: 'message', targetId: 'worker', body: 'Review', mode: 'invalid' }).ok, false);
    assert.equal(parse({ action: 'workflows.recovery.prepare', workflowRunId: 'attempt-1', selections: { reuseUnitIds: ['unit-1'], rerunUnitIds: ['unit-2'] } }).ok, true);
    assert.equal(parse({ action: 'workflows.recovery.prepare', workflowRunId: 'attempt-1', selections: { reuseUnitIds: ['unit-1'], rerunUnitIds: ['unit-1'] } }).ok, false);
  } finally { control.dispose(); host.owner.dispose(); }
});

test('README discovery examples are exact JSON accepted by the pure parser', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const section = readme.split('### Discover actions safely')[1]?.split('Background jobs are inspectable through')[0];
  assert.ok(section);
  const examples = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]!));
  assert.deepEqual(examples, [{ action: 'help' }, { action: 'help', topic: 'agents.create' }]);
  const parse = pureToolParser(); for (const example of examples) assert.equal(parse(example).ok, true);
});

test('new runtime help module is in the explicit package allowlist', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { files: string[] };
  assert.ok(pkg.files.includes('control-help.ts'));
});

test('receipt help default matches the real read-only list handler, not its maximum', async () => {
  const key = { parentRunId: 'parent', memberRunId: 'member', piSessionId: 'session' };
  const receipts = Array.from({ length: 65 }, (_, index) => ({
    schemaVersion: 1, messageId: `message-${index}`, key, body: 'Previously recorded context',
    mode: 'followUp', status: 'delivered', detail: 'Synthetic retained receipt',
    createdAt: '2026-10-09T00:00:00Z', updatedAt: '2026-10-09T00:00:00Z', persistence: 'memory',
  }));
  const container = createZergStateContainer(createZergState({ extensions: { zergSessionMessages: { schemaVersion: 1, receipts } } }));
  const control = createZergControl(container, { subagentAdapter: inertOptions.subagentAdapter });
  const before = control.getState();
  try {
    const listed = await control.execute({ action: 'session.messages.list', ...key });
    assert.equal(listed.ok, true);
    const defaultCount = (listed.data as { receipts: unknown[] }).receipts.length;
    assert.equal(defaultCount, 32);
    const all = await control.execute({ action: 'session.messages.list', ...key, limit: 128 });
    assert.equal(all.ok, true); assert.equal((all.data as { receipts: unknown[] }).receipts.length, 65);
    const help = await control.execute({ action: 'help', topic: 'session.messages.list' });
    const parameter = (help.data as Focused).parameters.find(item => item.name === 'limit');
    assert.match(parameter!.description, new RegExp(`default ${defaultCount}\\b`, 'i'));
    assert.deepEqual(control.getState(), before);
  } finally { control.dispose(); }
});
