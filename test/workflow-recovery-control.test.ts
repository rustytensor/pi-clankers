import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { registerHooks } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZergState, createZergStateContainer } from '../state.js';
import type { StructuralPiCommandOptions, ZergStateContainer } from '../types.js';
import type { WorkflowDefinition, WorkflowReply } from '../workflow-model.js';
import { createZergPersistenceManager } from '../persistence.js';

const fakeSource = `
// Deliberately unsupported: no shortcut resolver or registration capability.
export class ExtensionRunner {}
const h = new Proxy({}, {get:(_t,k)=>globalThis.__zergRecoveryControlFakeHost[k],set:(_t,k,v)=>{globalThis.__zergRecoveryControlFakeHost[k]=v;return true;}});
export const getAgentDir = () => '/fake-owned-agent';
export const ModelRuntime = { async create() { h.loads++; return { getAvailable: () => [{provider:'fake',id:'model'}] }; } };
export const SettingsManager = { create() { return { getGlobalSettings:()=>({}),getProjectSettings:()=>({}),applyOverrides:v=>{h.settings=v;} }; } };
export class DefaultResourceLoader { constructor(o){this.options=o;h.loader=o;} async reload(){} }
export const SessionManager = { create(cwd){ const id='fake-pi-'+(++h.managers); return {getSessionFile:()=>'/fake-owned/'+id+'.jsonl',getSessionId:()=>id,getCwd:()=>cwd,appendCustomEntry(){},appendSessionInfo(){},getEntryCount:()=>0,getEntries:()=>[],getLeafId:()=>null}; } };
export async function createAgentSession(o) {
 h.creates++; h.options=o;
 const listeners=new Set(), errors=new Set();
 const session={sessionId:o.sessionManager.getSessionId(),model:o.model,thinkingLevel:'off',messages:[],isStreaming:false,isCompacting:false,
 agent:{prepareRequest:async request=>request,onPayload:async p=>p,beforeToolCall:async()=>undefined},
 getActiveToolNames:()=>o.tools.slice(),getAllTools:()=>o.tools.map(name=>({name,sourceInfo:{path:'builtin:'+name,source:'builtin'}})),
 extensionRunner:{onError:fn=>{errors.add(fn);return()=>errors.delete(fn);},async emit(){h.shutdowns++;}},
 subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},async bindExtensions(){h.binds++;},
 async prompt(body,p){h.prompts.push({body,expand:p.expandPromptTemplates});p.preflightResult?.('started');h.providers++;const message={role:'assistant',content:[{type:'text',text:h.text}],stopReason:'stop'};session.messages.push(message);for(const listener of listeners)listener({type:'message_end',message});},
 async steer(){throw Error('no steer');}, async abort(){h.aborts++;}, async waitForIdle(){h.idles++;}, dispose(){h.disposes++;}}
 h.session=session; return {session};
}
`;
const fakeUrl = `data:text/javascript,${encodeURIComponent(fakeSource)}`;
const sdkHook = registerHooks({ resolve(specifier, context, next) { return specifier === '@earendil-works/pi-coding-agent' ? { url: fakeUrl, shortCircuit: true } : next(specifier, context); } });
after(() => sdkHook.deregister());
const { createZergControl, registerZergSwarmExtension } = await import('../index.js');
const { installManagementShortcutCatalogGuard } = await import('../internal-patch.js');
const { ExtensionRunner } = await import(fakeUrl);

type FakeHost = Record<string, any>;
let host: FakeHost;
function reset() { host ??= {}; for (const key of Object.keys(host)) delete host[key]; Object.assign(host, { loads: 0, managers: 0, creates: 0, binds: 0, providers: 0, aborts: 0, idles: 0, disposes: 0, shutdowns: 0, prompts: [], text: '{"ok":true}' }); (globalThis as any).__zergRecoveryControlFakeHost = host; }
function container(): ZergStateContainer { return createZergStateContainer(createZergState({ agentDefinitions: { safe: { id: 'safe', label: 'Safe', prompt: 'Read only.', source: 'runtime', model: 'fake/model', tools: ['read'], disallowedTools: [] } } })); }
const definition = (): WorkflowDefinition => ({ id: 'recovery-control', version: 1, label: 'Recovery control', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, steps: [{ id: 'step', kind: 'native', dependsOn: [], inputs: {}, agentId: 'safe', prompt: 'literal', outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } }] });
function reply(result: any): WorkflowReply { assert.equal(result.ok, true, result.error?.message); return result.data as WorkflowReply; }
async function start(control: any) { const saved = await control.execute({ action: 'agents.create', id: 'safe', prompt: 'Read only.', model: 'fake/model', tools: ['read'] }); assert.equal(saved.ok, true, saved.error?.message); reply(await control.execute({ action: 'workflows.define', definition: definition() })); const started = reply(await control.execute({ action: 'workflows.start', definitionId: 'recovery-control', inputs: {}, concurrency: 1 })); await control.drain?.(); return started.view!.workflowRunId; }
async function bytes(root: string) { const out: Record<string,string> = {}; const walk = (dir: string, prefix='') => { for (const name of readdirSync(dir)) { const path = join(dir, name), rel = prefix ? `${prefix}/${name}` : name; if (statSync(path).isDirectory()) walk(path, rel); else out[rel] = readFileSync(path, 'utf8'); } }; walk(root); return JSON.stringify(out); }

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

test('recovery inspect and prepare structured tool validate exact IDs, selections and no authorization fields', async () => {
  reset(); let tool: any; const extension = registerZergSwarmExtension({ registerTool(value) { if (value.name === 'zerg_control') tool = value; }, registerCommand() {} });
  try {
    const id = await start(extension.control);
    const inspect = await tool.execute('call', { action: 'workflows.recovery.inspect', workflowRunId: id });
    assert.equal(inspect.details.ok, true); assert.equal(inspect.details.action, 'workflows.recovery.inspect'); assert.match(inspect.content[0].text, /ledger-only|blocked|assessment|unsupported/i);
    const prepare = await tool.execute('call', { action: 'workflows.recovery.prepare', workflowRunId: id, selections: { reuseUnitIds: ['step:0'], rerunUnitIds: ['other'] } });
    assert.equal(prepare.details.ok, true); assert.equal((prepare.details.data as any).assessment.selections.reuseUnitIds[0], 'step:0');
    assert.equal((prepare.details.data as any).assessment.plan.status, 'blocked');
    assert.match(JSON.stringify((prepare.details.data as any).assessment.blocked), /unselected-required-execution-address/);
    for (const params of [
      { action: 'workflows.recovery.inspect', workflowRunId: `${id} extra` },
      { action: 'workflows.recovery.prepare', workflowRunId: 'x'.repeat(257) },
      { action: 'workflows.recovery.prepare', workflowRunId: id, selections: { reuseUnitIds: ['u'], rerunUnitIds: ['u'] } },
      { action: 'workflows.recovery.prepare', workflowRunId: id, selections: { authorize: true } },
      { action: 'workflows.recovery.prepare', workflowRunId: id, confirm: true },
      { action: 'workflows.recovery.prepare', workflowRunId: id, assessmentFingerprint: 'stale' },
    ]) { const result = await tool.execute('bad', params); assert.equal(result.details.ok, false, JSON.stringify(params)); }
    assert.equal(host.loads, 1); assert.equal(host.creates, 1);
  } finally { extension.dispose(); }
});

test('slash workflow recovery commands share aliases and reject JSON/path/extra identities', async () => {
  reset(); const commands = new Map<string, StructuralPiCommandOptions>(); let tool: any;
  const extension = registerZergSwarmExtension({ registerCommand(name, command) { commands.set(name, command); }, registerTool(value) { if (value.name === 'zerg_control') tool = value; } });
  try {
    const id = await start(extension.control); const notices: string[] = []; const context = { mode: 'print' as const, hasUI: false, ui: { notify(text: string) { notices.push(text); } } };
    await commands.get('zerg')!.handler(`workflows recovery inspect ${id}`, context);
    await commands.get('zerg-swarm')!.handler(`workflows recovery prepare ${id}`, context);
    await commands.get('swarm')!.handler(`workflows recovery inspect ${id} ${id}`, context);
    await commands.get('zerg')!.handler(`workflows recovery prepare ${JSON.stringify({ workflowRunId: id })}`, context);
    assert.match(notices[0]!, /"action":"workflows.recovery.inspect"/);
    assert.match(notices[1]!, /"action":"workflows.recovery.prepare"/);
    assert.match(notices[2]!, /Usage: \/clankers workflows/);
    assert.match(notices[3]!, /Workflow run not found|Usage/);
    const parity = await tool.execute('call', { action: 'workflows.recovery.inspect', workflowRunId: id }); assert.equal(parity.details.ok, true);
  } finally { extension.dispose(); }
});

test('recovery host opt-in requires persistence and inspect/prepare never acquire writer or mutate persisted bytes', async () => {
  reset(); assert.throws(() => createZergControl(container(), { recovery: { enabled: true } }), /persistence/);
  const root = mkdtempSync(join(tmpdir(), 'zerg-recovery-control-'));
  const pm = createZergPersistenceManager({ enabled: true, rootDir: root })!;
  const state = container(); pm.hydrate(state); pm.save(state.read()); pm.acquireRecoveryOwnership!();
  const before = await bytes(root);
  const control = createZergControl(container(), { persistence: { enabled: true, rootDir: root }, recovery: { enabled: true }, subagentAdapter: { kind: 'fake', launch() { return { ok: false, message: 'no launch' }; } } });
  try {
    const missingInspect = await control.execute({ action: 'workflows.recovery.inspect', workflowRunId: 'missing-run' });
    const missingPrepare = await control.execute({ action: 'workflows.recovery.prepare', workflowRunId: 'missing-run', selections: { reuseUnitIds: ['u'] } });
    assert.equal(missingInspect.ok, false); assert.equal(missingPrepare.ok, false);
    assert.equal(await bytes(root), before);
  } finally { control.dispose(); }
  assert.equal(await bytes(root), before);
  assert.equal(host.loads, 0); assert.equal(host.creates, 0); assert.equal(host.providers, 0);
});
