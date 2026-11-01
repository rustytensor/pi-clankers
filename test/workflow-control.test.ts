import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createZergState, createZergStateContainer } from '../state.js';
import type { WorkflowReply, WorkflowState } from '../workflow-model.js';
import type { WorkflowDefinition, WorkflowBinding, WorkflowRef, WorkflowSchema, WorkflowCondition, WorkflowIterationRun } from '../index.js';
import type { ZergControl, ZergStateContainer, StructuralPiCommandOptions } from '../types.js';

// This module never starts the SDK. Dynamic SDK imports resolve only to this
// bounded in-memory fake: no files, resources, tools, model transport or PTY.
const fakeSource = `
// Deliberately unsupported: no shortcut resolver or registration capability.
export class ExtensionRunner {}
const h = new Proxy({}, {get:(_t,k)=>globalThis.__zergWorkflowFakeHost[k],set:(_t,k,v)=>{globalThis.__zergWorkflowFakeHost[k]=v;return true;}});
export const getAgentDir = () => '/fake-owned-agent';
export const ModelRuntime = { async create() { h.loads++; await h.setup?.(); return { getAvailable: () => [{provider:'fake',id:'model'}] }; } };
export const SettingsManager = { create() { return { getGlobalSettings:()=>({}),getProjectSettings:()=>({}),applyOverrides:v=>{h.settings=v;} }; } };
export class DefaultResourceLoader { constructor(o){this.options=o;h.loader=o;} async reload(){await h.reload?.();} }
export const SessionManager = { create(cwd){ const id='fake-pi-'+(++h.managers); return {getSessionFile:()=>'/fake-owned/'+id+'.jsonl',getSessionId:()=>id,getCwd:()=>cwd,appendCustomEntry(){},appendSessionInfo(){},getEntryCount:()=>0,getEntries:()=>[],getLeafId:()=>null}; } };
export async function createAgentSession(o) {
 h.creates++; h.options=o;
 const listeners=new Set(),errors=new Set();
 const all=()=>o.tools.map(name=>({name,sourceInfo:{path:h.override?'inline:read':'builtin:'+name,source:h.override?'inline':'builtin'}}));
 const session={sessionId:o.sessionManager.getSessionId(),model:o.model,thinkingLevel:'off',messages:[],isStreaming:false,isCompacting:false,
 agent:{prepareRequest:async request=>{await h.prepare?.();return request;},onPayload:async p=>{await h.beforePayload?.();return p;},beforeToolCall:async()=>undefined},
 getActiveToolNames:()=>o.tools.slice(),getAllTools:all,
 extensionRunner:{onError:fn=>{errors.add(fn);return()=>errors.delete(fn);},async emit(){h.shutdowns++;await h.shutdownGate;if(h.shutdownFault)for(const fn of errors)fn({error:'shutdown fault'});}},
 subscribe:fn=>{listeners.add(fn);return()=>{listeners.delete(fn);h.unsubscribes++;if(h.unsubscribeFault)throw Error('unsubscribe fault');};},
 async bindExtensions(){h.binds++;for(const factory of h.loader.extensionFactories??[]){factory({on:(name,fn)=>{if(name==='tool_call')h.toolGuard=fn;},getAllTools:all});}await h.bind?.(session);},
 async prompt(body,p){h.prompts.push({body,expand:p.expandPromptTemplates});p.preflightResult?.('started');await session.agent.prepareRequest({model:session.model,context:{}},new AbortController().signal);await session.agent.onPayload({});h.providers++;await h.promptGate;const message={role:'assistant',content:[{type:'text',text:h.text}],stopReason:h.stopReason??'stop'};session.messages.push(message);for(const listener of listeners)listener({type:'message_end',message});},
 async steer(body,_images,options){h.steers??=[];h.steers.push({body,options});return 'queued';},
 async abort(){h.aborts++;h.releasePrompt?.();await h.abortGate;if(h.abortFault)throw Error('abort fault');},
 async waitForIdle(){h.idles++;await h.idleGate;},
 dispose(){h.disposes++;if(h.disposeFault)throw Error('dispose fault');},
 };
 h.session=session;h.errorListeners=errors;return {session};
}
`;
const fakeUrl = `data:text/javascript,${encodeURIComponent(fakeSource)}`;
const sdkHook = registerHooks({ resolve(specifier, context, next) {
  return specifier === '@earendil-works/pi-coding-agent' ? { url: fakeUrl, shortCircuit: true } : next(specifier, context);
} });
after(() => sdkHook.deregister());
const { createZergControl, registerZergSwarmExtension } = await import('../index.js');
const { installManagementShortcutCatalogGuard } = await import('../internal-patch.js');
const { ExtensionRunner } = await import(fakeUrl);
const { recoverZergStateAfterRestart } = await import('../persistence.js');

type FakeHost = Record<string, any>;
let host: FakeHost;
function reset() {
  host ??= {};
  for (const key of Object.keys(host)) delete host[key];
  Object.assign(host, { loads: 0, managers: 0, creates: 0, binds: 0, providers: 0, aborts: 0, idles: 0,
    disposes: 0, shutdowns: 0, unsubscribes: 0, prompts: [], text: '{"ok":true}' });
  (globalThis as any).__zergWorkflowFakeHost = host;
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) { assert.ok(Date.now() < deadline, 'bounded fake-host wait exceeded'); await new Promise(r => setTimeout(r, 1)); }
}
const definition = (steps = 1): WorkflowDefinition => ({ id: 'control-test', version: 1, label: 'Pure fake native',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  steps: Array.from({ length: steps }, (_, index) => ({ id: `step${index}`, dependsOn: index ? [`step${index - 1}`] : [], kind: 'native' as const,
    inputs: {}, agentId: 'safe', prompt: '/literal-not-a-command',
    outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
  })),
});
function container(): ZergStateContainer {
  return createZergStateContainer(createZergState({ agentDefinitions: {
    safe: { id: 'safe', label: 'Safe', prompt: 'Read only.', source: 'runtime', model: 'fake/model', tools: ['read'], disallowedTools: [] },
  } }));
}
function reply(result: Awaited<ReturnType<ZergControl['execute']>>): WorkflowReply { assert.equal(result.ok, true, result.error?.message); return result.data as WorkflowReply; }
async function start(control: ZergControl, steps = 1) {
  reply(await control.execute({ action: 'workflows.define', definition: definition(steps) }));
  return reply(await control.execute({ action: 'workflows.start', definitionId: 'control-test', inputs: {}, concurrency: 1 })).view!.workflowRunId;
}
async function view(control: ZergControl, workflowRunId: string) { return reply(await control.execute({ action: 'workflows.show', workflowRunId })).view!; }
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function codingDefinition(id: string, root: string): WorkflowDefinition {
  const policy = { version: 3 as const, capabilities: ['stage-write'] as ['stage-write'], identity: { parentRunId: 'parent', taskId: id, attemptNo: 1, rootAgentId: 'safe', workerAgentId: 'safe', model: 'fake/model' },
    scope: { task: `large approval payload ${id}`, writablePaths: ['src/a.txt'], readonlyPaths: ['src/readonly.txt'], baseline: { projectRootId: root, stateHash: sha('old\n') }, manifest: [{ path: 'src/a.txt', text: 'old\n', bytes: 4, sha256: sha('old\n') }] } };
  return { id, version: 3, label: id, inputSchema: { type: 'object', properties: {}, additionalProperties: false }, steps: [
    { id: 'stage', kind: 'coding', dependsOn: [], inputs: {}, outputSchema: { type: 'object', properties: { candidateHash: { type: 'string', maxLength: 80 }, changedPaths: { type: 'array', maxItems: 8, items: { type: 'string', maxLength: 128 } } }, required: ['candidateHash','changedPaths'], additionalProperties: false }, coding: { operation: 'stage-write', policy } },
  ] };
}
function codingControl(root: string, staging: string) {
  return createZergControl(container(), { coding: { enabled: true, projectRoot: root, stagingParent: staging } });
}
function makeCodingRoot(label: string) {
  const root = mkdtempSync(join(tmpdir(), `wf-control-${label}-root-`)); const staging = mkdtempSync(join(tmpdir(), `wf-control-${label}-stage-`));
  mkdirSync(join(root, 'src')); writeFileSync(join(root, 'src/a.txt'), 'old\n'); writeFileSync(join(root, 'src/readonly.txt'), `${'x'.repeat(5000)}\n`);
  return { root, staging };
}

test('fake Pi shortcut bridge stays unsupported, inert and unregistered', () => {
  reset(); const prototype = ExtensionRunner.prototype;
  const before = Object.getOwnPropertyDescriptors(prototype), parent = Object.getPrototypeOf(prototype);
  let registrations = 0, callbacks = 0;
  assert.equal(Object.hasOwn(prototype, 'getShortcuts'), false);
  const guard = installManagementShortcutCatalogGuard({
    handler() {}, ownerCommandHandler() {}, candidate: 'alt+g',
    enabled() { callbacks++; return true; }, register() { registrations++; },
    validate() { callbacks++; return { ok: true }; }, onCatalog() { callbacks++; },
  });
  assert.equal(guard.installed, false); assert.equal(registrations, 0); assert.equal(callbacks, 0);
  assert.deepEqual(Object.getOwnPropertyDescriptors(prototype), before);
  assert.equal(Object.getPrototypeOf(prototype), parent);
  guard.dispose(); guard.dispose();
  assert.deepEqual(Object.getOwnPropertyDescriptors(prototype), before);
  assert.equal(Object.getPrototypeOf(prototype), parent);
  assert.equal(registrations, 0); assert.equal(callbacks, 0);
  assert.equal(host.loads, 0); assert.equal(host.creates, 0); assert.equal(host.providers, 0);
});

test('workflow control does not trust fabricated native adapter kind or authority metadata', async () => {
  reset(); let launched = 0;
  const control = createZergControl(container(), { subagentAdapter: { kind: 'pi-native', launch() { launched++; return { ok: true, message: 'forged' }; } } });
  reply(await control.execute({ action: 'workflows.define', definition: definition() }));
  const result = await control.execute({ action: 'workflows.start', definitionId: 'control-test', inputs: {} });
  assert.equal(result.ok, false); assert.match(result.error!.message, /owned native/);
  assert.equal(launched, 0); assert.equal(host.loads, 0); control.dispose();
});

test('workflow exact identity precedes native publication and reentrant readonly cancellation reaches no SDK', async () => {
  reset(); const state = container(); const control = createZergControl(state);
  let correlated = false, cancelled = false;
  const unsubscribe = state.subscribe!(snapshot => {
    const ledger = snapshot.extensions.workflows as WorkflowState | undefined;
    const run = ledger?.runs[0], native = run?.steps[0]?.units[0]?.native;
    if (native && !snapshot.agents[native.runId]) correlated = true;
    if (native && snapshot.agents[native.runId] && !cancelled) {
      cancelled = true; state.update({ mode: { ...state.read().mode, readOnly: true } });
      void control.execute({ action: 'workflows.cancel', workflowRunId: run!.workflowRunId });
    }
  });
  const id = await start(control); await control.drain!();
  assert.ok(correlated); assert.ok(cancelled); assert.equal(host.loads, 0);
  const summary = await view(control, id); assert.equal(summary.status, 'cancelled'); assert.equal(summary.cleanupSettled, true);
  unsubscribe(); control.dispose();
});

test('workflow bounded literal output uses existing native references and ordinary fake hooks', async () => {
  reset(); const control = createZergControl(container()); let normalHook = 0;
  host.beforePayload = () => { normalHook++; };
  const id = await start(control); await control.drain!();
  const summary = await view(control, id); assert.equal(summary.status, 'completed');
  assert.equal(normalHook, 1); assert.equal(host.prompts[0].expand, false); assert.ok(host.prompts[0].body.startsWith('/literal-not-a-command'));
  assert.deepEqual(host.options.tools, ['read']); assert.deepEqual(host.options.customTools, []); assert.equal(host.settings.retry.enabled, false);
  assert.equal(host.shutdowns, 1); assert.equal(host.idles, 1); assert.equal(host.disposes, 1);
  const native = summary.correlations[0].native!;
  const snapshot = control.getState(); assert.equal(snapshot.agents[native.runId].metadata!.taskId, native.taskId);
  assert.equal((snapshot.agents[native.runId].metadata!.memberProgress as any[])[0].status, 'done');
  assert.equal((snapshot.agents[native.runId].metadata!.nativeSessions as any[])[0].attachment, 'disposed');
  assert.ok(!JSON.stringify(summary).includes('WORKFLOW_DATA_JSON')); assert.ok(!JSON.stringify(summary).includes('"ok":true'));
  control.dispose();
});

test('workflow permit covers delayed abort and shutdown; no next unit or retry before settlement', async () => {
  reset(); const abort = deferred(), shutdown = deferred(); host.abortGate = abort.promise; host.shutdownGate = shutdown.promise;
  const control = createZergControl(container()); const id = await start(control, 2);
  await until(() => host.aborts === 1); assert.equal(host.creates, 1);
  assert.equal((await view(control, id)).cleanupSettled, false);
  assert.equal((await control.execute({ action: 'workflows.retry', workflowRunId: id })).ok, false);
  abort.resolve(); await until(() => host.shutdowns === 1); assert.equal(host.creates, 1);
  shutdown.resolve(); await control.drain!(); assert.equal(host.creates, 2); assert.equal((await view(control, id)).status, 'completed'); control.dispose();
});

test('readonly cancellation and disposal retain settlement after native routing is cleared', async () => {
  reset(); const prompt = deferred(), abort = deferred(); host.promptGate = prompt.promise; host.abortGate = abort.promise; host.releasePrompt = prompt.resolve;
  const state = container(); const control = createZergControl(state); const id = await start(control, 2);
  await until(() => host.providers === 1); state.update({ mode: { ...state.read().mode, readOnly: true } });
  reply(await control.execute({ action: 'workflows.cancel', workflowRunId: id }));
  assert.equal((await view(control, id)).cleanupSettled, false); assert.ok(host.aborts >= 1);
  control.dispose(); let drained = false; const drain = control.drain!().then(() => { drained = true; });
  await new Promise(r => setTimeout(r, 5)); assert.equal(drained, false); assert.equal(host.disposes, 0); assert.equal(host.creates, 1);
  abort.resolve(); await drain; assert.equal(host.creates, 1); assert.equal(host.disposes, 1);
});

test('workflow cleanup attempts every stage and blocks reuse/admission when shutdown or disposal fails', async () => {
  reset(); host.shutdownFault = true; host.disposeFault = true; host.unsubscribeFault = true;
  const control = createZergControl(container()); const id = await start(control, 2); await assert.rejects(control.drain!(), /uncertain/);
  const summary = await view(control, id); assert.equal(summary.status, 'needs-attention'); assert.equal(summary.cleanupSettled, false);
  assert.equal(host.shutdowns, 1); assert.equal(host.disposes, 1); assert.ok(host.unsubscribes >= 1); assert.equal(host.creates, 1);
  assert.equal((await control.execute({ action: 'workflows.retry', workflowRunId: id })).ok, false); control.dispose();
});

for (const boundary of ['bind', 'beforePayload', 'override'] as const) test(`workflow ${boundary} policy drift refuses fake provider and still cleans up`, async () => {
  reset(); const state = container(); const control = createZergControl(state);
  if (boundary === 'override') host.override = true;
  else host[boundary] = () => { state.update({ mode: { ...state.read().mode, readOnly: true } }); };
  const id = await start(control); await control.drain!(); const summary = await view(control, id);
  assert.notEqual(summary.status, 'completed'); assert.equal(host.providers, 0); assert.equal(host.disposes, 1); assert.equal(host.shutdowns, 1); control.dispose();
});

test('oversized final output fails explicitly without parsing, clipping, persistence, or handoff', async () => {
  reset(); host.text = 'x'.repeat(16385); const control = createZergControl(container()); const id = await start(control); await control.drain!();
  const summary = await view(control, id); assert.notEqual(summary.status, 'completed');
  assert.equal(summary.counts.failed, 1); assert.ok(!JSON.stringify(control.getState()).includes(host.text)); control.dispose();
});

test('restart recovery does not execute or reconnect any workflow native unit', async () => {
  reset(); const control = createZergControl(container()); const id = await start(control); await control.drain!();
  const seed = control.getState(); const ledger = seed.extensions.workflows as WorkflowState;
  ledger.runs[0].status = 'running'; ledger.runs[0].cleanupSettled = false;
  ledger.runs[0].steps[0].status = 'running'; ledger.runs[0].steps[0].units[0].status = 'running'; ledger.runs[0].steps[0].units[0].cleanupSettled = false;
  const recovered = recoverZergStateAfterRestart(seed).state; control.dispose(); reset();
  const next = createZergControl(createZergStateContainer(recovered)); const summary = await view(next, id);
  assert.equal(summary.status, 'needs-attention'); assert.equal(summary.recovered, true); assert.equal(summary.counts.unverified, 1);
  assert.equal((await next.execute({ action: 'workflows.resume', workflowRunId: id })).ok, false); assert.equal(host.loads, 0); next.dispose();
});

test('workflows.show exposes only compact exact-run approval summaries while trusted operator inspect stays full', async () => {
  reset(); const a = makeCodingRoot('a');
  const control = codingControl(a.root, a.staging);
  reply(await control.execute({ action: 'workflows.define', definition: codingDefinition('coding-a', a.root) }));
  reply(await control.execute({ action: 'workflows.define', definition: codingDefinition('coding-b', a.root) }));
  const runA = reply(await control.execute({ action: 'workflows.start', definitionId: 'coding-a', inputs: {}, concurrency: 1 })).view!.workflowRunId;
  const runB = reply(await control.execute({ action: 'workflows.start', definitionId: 'coding-b', inputs: {}, concurrency: 1 })).view!.workflowRunId;
  await until(() => control.workflowApprovals!.inspect().length === 2);
  const full = control.workflowApprovals!.inspect();
  assert.equal(full.length, 2);
  assert.ok(JSON.stringify(full[0]!.request.humanReview).includes('x'.repeat(1000)), 'trusted operator API retains full bounded review payload');
  const shown = await control.execute({ action: 'workflows.show', workflowRunId: runA }); assert.equal(shown.ok, true, shown.error?.message);
  const approvals = (shown.data as any).approvals;
  assert.equal(approvals.workflowRunId, runA);
  assert.equal(approvals.requests.length, 1);
  assert.equal(approvals.requests[0].kind, 'implementation');
  assert.equal(approvals.requests[0].scope.task, 'large approval payload coding-a');
  assert.deepEqual(approvals.requests[0].scope.paths.writable, ['src/a.txt']);
  assert.equal(approvals.requests[0].request, undefined);
  assert.equal(approvals.requests[0].action, undefined);
  assert.ok(!JSON.stringify(shown.data).includes('x'.repeat(1000)), 'compact show omits full file payload');
  assert.equal(JSON.stringify(shown.data).includes(runB), false, 'selected run does not expose other run approval identity');
  assert.equal((await control.execute({ action: 'workflows.show', workflowRunId: 'forged-run' })).ok, false);
  control.dispose();
});

test('workflow approval grant is not exposed through zerg_control tool actions and slash path requires trusted UI', async () => {
  reset(); const commands = new Map<string, StructuralPiCommandOptions>(); let tool: any;
  const extension = registerZergSwarmExtension({ registerCommand(name, command) { commands.set(name, command); }, registerTool(value) { if (value.name === 'zerg_control') tool = value; } });
  try {
    const modelResult = await tool.execute('fake-call', { action: 'workflows.approve', workflowRunId: 'wf', approvalId: 'approval-1', confirm: true });
    assert.equal(modelResult.details.ok, false);
    assert.match(modelResult.details.error.message, /Unknown clankers_control action/);
    const notices: string[] = [];
    await commands.get('zerg')!.handler('workflows approve wf approval-1', { mode: 'print', hasUI: false, ui: { notify(text: string) { notices.push(text); } } });
    assert.match(notices.at(-1) ?? '', /interactive UI confirmation is required/);
  } finally { extension.dispose(); }
});

test('registered workflow aliases and structured tool share one service; nonterminal monitor never requires TUI', async () => {
  reset(); const commands = new Map<string, StructuralPiCommandOptions>(); let tool: any;
  const extension = registerZergSwarmExtension({ registerCommand(name, command) { commands.set(name, command); }, registerTool(value) { if (value.name === 'zerg_control') tool = value; } });
  const notices: string[] = []; const context = { mode: 'print' as const, hasUI: false, ui: { notify(text: string) { notices.push(text); }, custom() { throw Error('must not open TUI'); } } };
  for (const name of ['zerg', 'zerg-swarm', 'swarm']) await commands.get(name)!.handler('workflows list', context);
  await commands.get('swarm')!.handler(`workflows define ${JSON.stringify(definition())}`, context);
  const result = await tool.execute('fake-call', { action: 'workflows.show', definitionId: 'control-test' }); assert.equal(result.details.ok, true);
  await commands.get('zerg')!.handler('workflows monitor', context); assert.ok(notices.length >= 5); assert.equal(host.loads, 0); extension.dispose();
});

test('workflow dispose leaves native lifecycle nonterminal while cleanup is pending', async () => {
  reset(); const prompt = deferred(), abort = deferred(); host.promptGate = prompt.promise; host.abortGate = abort.promise; host.releasePrompt = prompt.resolve;
  const control = createZergControl(container()); const id = await start(control);
  await until(() => host.providers === 1); const native = (await view(control, id)).correlations[0].native!;
  control.dispose(); const before = control.getState().agents[native.runId];
  await new Promise(r => setTimeout(r, 5)); await until(() => host.aborts >= 3);
  assert.equal((control.getState().agents[native.runId].metadata!.memberProgress as any[])[0].status, 'running', 'member terminal progress must not precede cleanup');
  abort.resolve(); await control.drain!();
  assert.equal(before.status, 'running', 'terminal must not precede owned settlement');
  assert.equal(control.getState().agents[native.runId].status, 'cancelled');
});

for (const repeat of [false, true]) test(`owned slash workflows ${repeat ? 'v2 repeat' : 'v1'} reject input-changing messages and interrupt without external bridge emissions`, async () => {
  reset(); let tool: any; const emissions: string[] = [];
  const extension = registerZergSwarmExtension({ events: { on() { return () => {}; }, emit(name) { emissions.push(String(name)); } }, registerTool(value) { if (value.name === 'zerg_control') tool = value; } });
  const execute = async (action: any) => (await tool.execute('fake-control', action)).details;
  const saved = await execute({ action: 'agents.create', id: 'safe', prompt: 'Read only.', model: 'fake/model', tools: ['read', 'bash', 'mcp', 'zerg_control'] }); assert.equal(saved.ok, true);
  reply(await execute({ action: 'workflows.define', definition: repeat ? repeatDefinition() : definition() }));
  const prompt = deferred(), abort = deferred(); host.promptGate = prompt.promise; host.abortGate = abort.promise; host.releasePrompt = prompt.resolve;
  const id = reply(await execute({ action: 'workflows.start', definitionId: 'control-test', inputs: {}, concurrency: 1 })).view!.workflowRunId;
  await until(() => host.providers === 1); assert.deepEqual(host.options.tools, ['read']);
  const native = reply(await execute({ action: 'workflows.show', workflowRunId: id })).view!.correlations[0].native!;
  const delivered = await execute({ action: 'message', runId: native.runId, targetId: native.runId, body: '/literal-operator' }); assert.equal(delivered.ok, false); assert.match(delivered.error.message, /inputs are frozen/); assert.equal(host.steers, undefined);
  const reference = (await execute({ action: 'runs.show', runId: native.runId })).data.run.nativeSessions[0];
  for (const mode of ['steer', 'followUp']) {
    const result = await execute({ action: 'session.message.send', parentRunId: native.runId, memberRunId: native.runId, piSessionId: reference.piSessionId, messageId: `frozen-${mode}`, mode, body: '/literal-operator' });
    assert.equal(result.ok, false); assert.match(result.error.message, /inputs are frozen/);
  }
  assert.equal(host.prompts.length, 1); assert.equal(host.steers, undefined);
  const interrupted = await execute({ action: 'interrupt', runId: native.runId }); assert.equal(interrupted.ok, true);
  abort.resolve(); await until(() => host.disposes === 1); extension.dispose(); assert.deepEqual(emissions, []);
});


test('throwing workflow persistence boundary cannot suppress native adapter cleanup', async () => {
  reset(); const prompt = deferred(), abort = deferred(); host.promptGate = prompt.promise; host.abortGate = abort.promise; host.releasePrompt = prompt.resolve;
  const base = container(); let boundaryFault = false;
  const state: ZergStateContainer = { ...base, update(patch, options) {
    if (boundaryFault && typeof patch !== 'function' && patch.extensions?.workflows) throw new Error('fake workflow persistence boundary');
    return base.update(patch, options);
  } };
  const control = createZergControl(state); await start(control); await until(() => host.providers === 1);
  boundaryFault = true;
  try { control.dispose(); } catch (error) { assert.match(String(error), /boundary/); }
  assert.ok(host.aborts >= 2, 'native owner cancellation attempted after workflow persistence fault');
  abort.resolve();
  try { await control.drain!(); } catch (error) { assert.match(String(error), /uncertain|boundary|settlement/); }
  assert.equal(host.disposes, 1); assert.equal(host.shutdowns, 1); assert.equal(host.creates, 1);
});


test('malformed workflow namespace is retained and cannot suppress ordinary native recovery', async () => {
  reset(); const control = createZergControl(container()); const id = await start(control); await control.drain!();
  const native = (await view(control, id)).correlations[0].native!, seed = control.getState(); control.dispose();
  const malformed = { version: 99, opaque: 'retain original data' }; seed.extensions.workflows = malformed;
  seed.agents[native.runId].status = 'running'; seed.agents[native.runId].runtime!.substate = 'executing';
  (seed.agents[native.runId].metadata!.nativeSessions as any[])[0].attachment = 'attached';
  const recovered = recoverZergStateAfterRestart(seed); assert.deepEqual(recovered.state.extensions.workflows, malformed);
  assert.ok(recovered.recoveredRunIds.includes(native.runId)); assert.equal(recovered.state.agents[native.runId].status, 'needs-attention');
  assert.equal((recovered.state.agents[native.runId].metadata!.nativeSessions as any[])[0].attachment, 'unavailable');
  reset(); const next = createZergControl(createZergStateContainer(recovered.state));
  assert.equal((await next.execute({ action: 'runs.show', runId: native.runId })).ok, true);
  assert.equal((await next.execute({ action: 'workflows.list' })).ok, false); assert.equal(host.loads, 0); next.dispose();
});


test('definitive SDK assistant failure is failed, not ambiguous success or unverified', async () => {
  reset(); host.stopReason = 'error'; host.text = ''; const control = createZergControl(container());
  const id = await start(control); await control.drain!(); const summary = await view(control, id);
  assert.equal(summary.status, 'failed'); assert.equal(summary.counts.failed, 1); assert.equal(summary.cleanupSettled, true);
  assert.equal(host.shutdowns, 1); assert.equal(host.disposes, 1); control.dispose();
});


test('lazy workflow initialization refuses reentrant first-read observers without losing ownership', async () => {
  reset(); const state = container(); const control = createZergControl(state);
  const revision = state.read().revision;
  reply(await control.execute({ action: 'status' }));
  assert.equal(state.read().revision, revision);
  assert.equal(state.read().extensions.workflows, undefined, 'ordinary controls must not initialize workflows');
  let callbacks = 0;
  const reads: Array<Promise<Awaited<ReturnType<ZergControl['execute']>>>> = [];
  const unsubscribe = state.subscribe!(() => {
    if (callbacks++ < 2) reads.push(control.execute({ action: 'workflows.list' }));
  });
  try {
    reply(await control.execute({ action: 'workflows.list' }));
    const nested = await Promise.all(reads);
    unsubscribe();
    reply(await control.execute({ action: 'workflows.define', definition: definition() }));
    assert.equal(callbacks, 1, 'only one workflow constructor may publish');
    assert.equal(nested.length, 1);
    assert.equal(nested[0]!.ok, false);
    assert.match(nested[0]!.error!.message, /initializing/);
    reply(await control.execute({ action: 'workflows.show', definitionId: 'control-test' }));
    assert.equal(host.loads, 0); assert.equal(host.creates, 0); assert.equal(host.providers, 0);
  } finally { unsubscribe(); control.dispose(); }
});

for (const repeat of [false, true]) for (const referenceCase of ['exact', 'missing', 'ambiguous', 'stale-pi', 'wrong-member'] as const) test(`workflow control to coding UI ${repeat ? 'v2 repeat' : 'v1'} ${referenceCase} uses exact initial identity or refuses without chooser`, async () => {
  reset();
  const { createNativeTranscriptService } = await import('../native-transcript.js');
  const commands = new Map<string, StructuralPiCommandOptions>();
  let references: import('../types.js').ZergNativeSessionReference[] = [];
  const opened: import('../native-transcript.js').NativeTranscriptKey[] = [];
  let handleDisposals = 0;
  const transcript = createNativeTranscriptService({ getReferences: () => references });
  transcript.open = async (key) => {
    opened.push({ ...key });
    return { getSnapshot: () => ({ key: { ...key }, revision: 1, source: 'captured', status: 'closed', defaultLeafBasis: 'recorded-tip',
      branches: [], blocks: [], truncated: false, droppedBlocks: 0 }), subscribe: () => () => {}, dispose: () => { handleDisposals++; } };
  };
  const extension = registerZergSwarmExtension({ registerCommand(name, command) { commands.set(name, command); } }, { nativeTranscriptService: transcript });
  try {
    reply(await extension.control.execute({ action: 'agents.create', id: 'safe', prompt: 'Read only.', model: 'fake/model', tools: ['read'] }));
    const id = repeat ? await startDefinition(extension.control, repeatDefinition()) : await start(extension.control); await extension.control.drain!();
    const native = (await view(extension.control, id)).correlations[0].native!;
    const run = (await extension.control.execute({ action: 'runs.show', runId: native.runId })).data as { run: { nativeSessions: import('../types.js').ZergNativeSessionReference[] } };
    const reference = run.run.nativeSessions[0]!;
    const exactKey = { parentRunId: native.runId, memberRunId: native.runId, piSessionId: reference.piSessionId };
    references = referenceCase === 'missing' ? [] : referenceCase === 'ambiguous' ? [{ ...reference }, { ...reference }]
      : [{ ...reference, ...(referenceCase === 'stale-pi' ? { piSessionId: 'stale-pi-session' } : {}),
        ...(referenceCase === 'wrong-member' ? { memberRunId: 'unrelated-member' } : {}) }];
    const codingFrames: string[] = [], returnedFrames: string[] = [], notices: string[] = [];
    let workflowEntries = 0, codingEntries = 0;
    const context: import('../types.js').StructuralPiCommandContext = { mode: 'tui', hasUI: true, ui: {
      notify(text) { notices.push(text); },
      async custom(factory, options) {
        const component = (factory as import('../types.js').StructuralPiCustomFactory)({ terminal: { rows: 32 }, requestRender() {} }, undefined, undefined, () => {});
        assert.ok('render' in component, 'existing workflow/coding factories must enter synchronously');
        if ((options as import('../types.js').StructuralPiCustomOptions | undefined)?.overlayOptions?.title === 'clankers coding') {
          codingEntries++;
          // Capture BEFORE another key or awaited tick: initialKey must enter the exact view immediately.
          codingFrames.push(component.render(512).join('\n'));
          await Promise.resolve();
          codingFrames.push(component.render(512).join('\n'));
        } else {
          workflowEntries++;
          assert.ok(workflowEntries <= 2, 'bounded workflow return path');
          if (workflowEntries === 1) {
            component.render(512); component.handleInput!('\r');
            if (repeat) { component.render(512); component.handleInput!('\r'); component.render(512); component.handleInput!('\r'); }
            component.render(512); component.handleInput!('c');
          } else returnedFrames.push(component.render(512).join('\n'));
        }
        return undefined;
      },
    } };
    await commands.get('zerg')!.handler(`workflows monitor ${id}`, context);
    assert.deepEqual(notices, []);
    assert.equal(workflowEntries, 2, 'coding drilldown returns to a fresh workflow view');
    if (referenceCase === 'exact') {
      assert.equal(codingEntries, 1); assert.deepEqual(opened, [exactKey]);
      assert.equal(handleDisposals, 1);
      for (const frame of codingFrames) {
        assert.ok(!frame.includes('Exact session chooser'), 'selected unit must never enter the chooser');
        for (const value of Object.values(exactKey)) assert.ok(frame.includes(value), `immediate full identity missing ${value}`);
      }
    } else {
      assert.equal(codingEntries, 0, 'invalid reference must not open any coding overlay');
      assert.deepEqual(opened, []); assert.equal(handleDisposals, 0);
      assert.match(returnedFrames[0]!, /Exact coding viewer unavailable:.*reference.*(missing|ambiguous|stale)/i);
    }
    assert.equal(host.creates, 1); assert.equal(host.providers, 1); assert.equal(host.disposes, 1, 'viewer does not own or restart native lifecycle');
  } finally { extension.dispose(); }
});

function repeatDefinition(): WorkflowDefinition {
  const native = definition().steps[0]!;
  const stateSchema: WorkflowSchema = native.outputSchema!;
  const feedbackRef: WorkflowRef = { source: 'step', stepId: 'body', path: [] };
  const feedback: WorkflowBinding = { ref: feedbackRef };
  const until: WorkflowCondition = { op: 'boolean', value: { ref: { source: 'iteration', path: ['ok'] } } };
  return { ...definition(), version: 2, steps: [{ id: 'loop', kind: 'repeat', dependsOn: [],
    initial: { value: { ok: false } }, stateSchema, body: [{ ...native, id: 'body' }],
    feedback, until,
    output: { ref: { source: 'iteration', path: [] } }, outputSchema: native.outputSchema, maxIterations: 2,
  }] };
}
async function startDefinition(control: ZergControl, value: WorkflowDefinition) {
  reply(await control.execute({ action: 'workflows.define', definition: value }));
  return reply(await control.execute({ action: 'workflows.start', definitionId: value.id, inputs: {}, concurrency: 1 })).view!.workflowRunId;
}
test('v2 false condition has zero native setup/admissions and explicit skipped branch join', async () => {
  reset(); const state = container(); const control = createZergControl(state);
  const value = definition(); value.version = 2; value.steps[0]!.when = { op: 'boolean', value: { value: false } };
  value.steps.push({ id: 'join', kind: 'aggregate', dependsOn: ['step0'], operation: 'collect', consumeSkips: true,
    inputs: { branch: { ref: { source: 'step', stepId: 'step0', path: [] } } } });
  const id = await startDefinition(control, value); await control.drain!();
  assert.equal(host.loads, 0); assert.equal(host.creates, 0); assert.equal(host.providers, 0);
  const ledger = (state.read().extensions.workflows as WorkflowState).runs.find(row => row.workflowRunId === id)!;
  assert.equal(ledger.admissions, 0); assert.equal(ledger.steps[0]!.skipReason, 'condition-false');
  assert.deepEqual(ledger.steps[0]!.units, []); assert.equal(ledger.steps[0]!.output, undefined);
  assert.equal(ledger.steps[1]!.status, 'completed'); assert.match(JSON.stringify(ledger.steps[1]!.output), /skipped/);
  control.dispose();
});
test('v2 required branch failure is not hidden by an explicitly consuming aggregate', async () => {
  reset(); host.text = 'invalid-json'; const control = createZergControl(container());
  const value = definition(); value.version = 2;
  value.steps.push({ id: 'join', kind: 'aggregate', dependsOn: ['step0'], operation: 'collect', consumeFailures: true,
    inputs: { branch: { ref: { source: 'step', stepId: 'step0', path: [] } } } });
  const id = await startDefinition(control, value); await control.drain!();
  assert.notEqual((await view(control, id)).status, 'completed'); control.dispose();
});
test('v2 repeat native task and agent publish exact qualified lineage with unchanged read-only policy', async () => {
  reset(); const state = container(); const control = createZergControl(state);
  const id = await startDefinition(control, repeatDefinition()); await control.drain!();
  const ledger = (state.read().extensions.workflows as WorkflowState).runs.find(row => row.workflowRunId === id)!;
  assert.equal(ledger.status, 'completed'); const iteration: WorkflowIterationRun = ledger.steps[0]!.iterations![0]!;
  assert.equal(iteration.id, 'loop@0'); assert.equal(iteration.decision, true);
  const unit = iteration.steps[0]!.units[0]!; assert.equal(unit.id, 'loop@0/body:0'); assert.equal(unit.stepId, 'loop@0/body');
  assert.ok(unit.native); const native = state.read().agents[unit.native.runId]!;
  const lineage = native.metadata!.workflow;
  assert.deepEqual(lineage, { workflowRunId: id, familyId: ledger.familyId, attemptNo: 1, stepId: unit.stepId, unitId: unit.id,
    inputHash: unit.inputHash, blockId: 'loop', iterationId: 'loop@0', iterationNo: 1 });
  assert.deepEqual(state.read().tasks[unit.native.taskId]!.metadata!.workflow, lineage);
  const summary = await view(control, id); assert.equal(summary.correlations[0]!.native!.runId, unit.native.runId);
  assert.equal(host.settings.retry.enabled, false); assert.deepEqual(host.options.tools, ['read']); control.dispose();
});
test('v2 repeat pause closes next iteration admission and cancel settles exact active body worker', async () => {
  reset(); host.text = '{"ok":false}'; const gate = deferred(); host.promptGate = gate.promise; host.releasePrompt = gate.resolve;
  const state = container(); const control = createZergControl(state);
  const id = await startDefinition(control, repeatDefinition()); await until(() => host.providers === 1);
  reply(await control.execute({ action: 'workflows.pause', workflowRunId: id }));
  assert.equal((await view(control, id)).status, 'paused'); assert.equal(host.aborts, 0);
  reply(await control.execute({ action: 'workflows.cancel', workflowRunId: id })); await control.drain!();
  const summary = await view(control, id); assert.equal(summary.status, 'cancelled'); assert.equal(summary.cleanupSettled, true);
  assert.equal(host.providers, 1); assert.ok(host.aborts >= 1); assert.equal(summary.correlations[0]!.stepId, 'loop@0/body'); control.dispose();
});
