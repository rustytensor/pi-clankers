import assert from 'node:assert/strict';
import { test } from 'node:test';
import { __clankersNativeTestInternals } from '../index.js';
import type { WorkflowNativeRequest } from '../workflow-model.js';

function fakeSdk(host: Record<string, any>) {
  return {
    getAgentDir: () => '/fake-agent',
    createExtensionRuntime: () => ({ sealed: true }),
    ModelRuntime: { async create() { host.modelRuntime = true; return { getAvailable: () => [{ provider: 'fake', id: 'model' }] }; } },
    SettingsManager: { create() { return { getGlobalSettings: () => ({}), getProjectSettings: () => ({}), applyOverrides(value: unknown) { host.settings = value; } }; } },
    SessionManager: { create(cwd: string) { return { getSessionFile: () => '/fake/session.jsonl', getSessionId: () => 'fake-session', getCwd: () => cwd, appendCustomEntry() {}, appendSessionInfo() {}, getEntryCount: () => 0, getEntries: () => [], getLeafId: () => null }; } },
    async createAgentSession(options: any) {
      host.options = options;
      const resource = options.resourceLoader.getExtensions();
      host.resource = resource;
      host.skills = options.resourceLoader.getSkills();
      host.prompts = options.resourceLoader.getPrompts();
      host.agentsFiles = options.resourceLoader.getAgentsFiles();
      const session: any = {
        model: options.model,
        thinkingLevel: 'off',
        messages: [],
        isStreaming: false,
        isCompacting: false,
        agent: { prepareRequest: async (request: any) => request, onPayload: async (payload: any) => payload, beforeToolCall: async () => undefined },
        getActiveToolNames: () => options.tools.slice(),
        getAllTools: () => options.customTools.map((tool: any) => ({ name: tool.name, sourceInfo: { source: 'inline', path: `inline:${tool.name}` } })),
        extensionRunner: { onError: () => () => {}, emit: async () => {} },
        subscribe: () => () => {},
        bindExtensions: async () => {},
        prompt: async () => {
          const write = options.customTools.find((tool: any) => tool.name === 'workflow_stage_write');
          if (write) await write.execute('write-1', { path: 'owned.txt', text: 'after' });
          const message = { role: 'assistant', content: [{ type: 'text', text: '{"ok":true}' }], stopReason: 'stop' };
          session.messages.push(message);
          return [message];
        },
        abort: async () => {}, waitForIdle: async () => {}, dispose() {},
      };
      host.session = session;
      return { session };
    },
  };
}

function request(operation: 'investigate' | 'stage-write' | 'review', writes: string[] = []): WorkflowNativeRequest {
  const req: WorkflowNativeRequest = {
    workflowRunId: 'wf', familyId: 'wf', attemptNo: 1, stepId: 's', unitId: 's:0', inputHash: '0'.repeat(64),
    agent: { id: 'worker', label: 'Worker', prompt: 'Use workflow tools only.', source: 'runtime', model: 'fake/model', tools: ['read'] },
    prompt: 'task', signal: new AbortController().signal, onIdentity() {}, assertAdmission() { writes.push('assert'); },
    coding: {
      operation, iteration: 1, policy: {} as never, stageRoot: '/stage', paths: ['owned.txt'],
      read(path) { writes.push(`read:${path}`); return path === 'owned.txt' ? 'before' : ''; },
      write(path, text) { writes.push(`write:${path}:${text}`); },
      inspect() { writes.push('inspect'); return { candidateHash: 'candidate', changedPaths: ['owned.txt'], files: [] }; },
    },
  };
  return req;
}

test('normal native sessions preserve existing package and extension resources in settings overrides', async () => {
  const host: Record<string, any> = {};
  const agent = { id: 'normal', label: 'Normal', prompt: 'Use ordinary tools.', source: 'runtime' as const, model: 'fake/model', tools: ['read'] };
  await __clankersNativeTestInternals.createPiNativeSession(fakeSdk(host) as never, agent, 'task', '/project', 'fake/model');
  assert.equal(host.settings.retry.enabled, true);
  assert.deepEqual(host.settings.defaultTools, ['read']);
  assert.equal(Object.hasOwn(host.settings, 'packages'), false);
  assert.equal(Object.hasOwn(host.settings, 'extensions'), false);
});

test('workflow coding stage-write uses sealed loader and controlled custom read/write tools only', async () => {
  const host: Record<string, any> = {}; const events: string[] = [];
  const admission = { request: request('stage-write', events), tools: ['read'], aborts: [], failures: [], cleanupSettled: true, assert() { events.push('admission'); } };
  const { session, tools } = await __clankersNativeTestInternals.createPiNativeSession(fakeSdk(host) as never, admission.request.agent, 'task', '/project', 'fake/model', undefined, admission as never);
  assert.deepEqual(tools, ['workflow_stage_read', 'workflow_stage_write', 'workflow_stage_inspect']);
  assert.deepEqual(host.options.tools, tools);
  assert.equal(host.options.excludeTools.length, 0);
  assert.deepEqual(host.options.customTools.map((tool: any) => tool.name), tools);
  assert.deepEqual(host.skills, { skills: [], diagnostics: [] });
  assert.deepEqual(host.prompts, { prompts: [], diagnostics: [] });
  assert.deepEqual(host.agentsFiles, { agentsFiles: [] });
  assert.equal(host.settings.retry.enabled, false);
  assert.deepEqual(host.settings.packages, []);
  assert.deepEqual(host.settings.extensions, []);
  await session.prompt('task');
  assert.ok(events.includes('write:owned.txt:after'));
});

test('workflow coding review exposes read/inspect without write', async () => {
  const host: Record<string, any> = {}; const events: string[] = [];
  const admission = { request: request('review', events), tools: ['read'], aborts: [], failures: [], cleanupSettled: true, assert() { events.push('admission'); } };
  await __clankersNativeTestInternals.createPiNativeSession(fakeSdk(host) as never, admission.request.agent, 'task', '/project', 'fake/model', undefined, admission as never);
  assert.deepEqual(host.options.tools, ['workflow_stage_read', 'workflow_stage_inspect']);
  assert.equal(host.options.customTools.some((tool: any) => tool.name === 'workflow_stage_write'), false);
});

test('workflow coding investigation exposes readonly sealed snapshot tools before implementation approval', async () => {
  const host: Record<string, any> = {}; const events: string[] = [];
  const admission = { request: request('investigate', events), tools: ['read'], aborts: [], failures: [], cleanupSettled: true, assert() { events.push('admission'); } };
  await __clankersNativeTestInternals.createPiNativeSession(fakeSdk(host) as never, admission.request.agent, 'task', '/project', 'fake/model', undefined, admission as never);
  assert.deepEqual(host.options.tools, ['workflow_stage_read', 'workflow_stage_inspect']);
  assert.equal(host.options.customTools.some((tool: any) => tool.name === 'workflow_stage_write'), false);
});
