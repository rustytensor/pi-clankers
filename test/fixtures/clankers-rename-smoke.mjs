// Offline public-SDK rename journey. Run in a dedicated subprocess with --import tsx.
// Expected values come from the rename contract and the v1.1.25 persistence schema.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import net from 'node:net';

const sdkOverride = process.env.CLANKERS_RENAME_SDK;
const splitAlias = process.env.CLANKERS_RENAME_FAULT_SPLIT_ALIAS === '1';
assert(!sdkOverride || isAbsolute(sdkOverride) || sdkOverride.startsWith('file:'), 'SDK must be absolute or a file URL');
const sdkUrl = sdkOverride ? (sdkOverride.startsWith('file:') ? sdkOverride : pathToFileURL(sdkOverride).href) : import.meta.resolve('@earendil-works/pi-coding-agent');
const scratch = process.env.CLANKERS_RENAME_TMPDIR ?? join(tmpdir(), 'pi-clankers-rename');
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(join(scratch, 'rename-'));
const agentDir = join(dir, 'agent');
const cwd = join(dir, 'project');
mkdirSync(agentDir); mkdirSync(join(dir, 'tmp')); mkdirSync(join(cwd, '.pi'), { recursive: true });
const oldCwd = process.cwd();
// Do not inherit credentials, model routing, proxy variables or user Pi resources.
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir, XDG_DATA_HOME: dir, TMPDIR: join(dir, 'tmp'), JITI_FS_CACHE: '0', PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PATH: '', NO_COLOR: '1' });
process.chdir(cwd);
const deadline = setTimeout(() => { console.error('Rename fixture exceeded 30s'); process.exit(1); }, 30_000);
let registration, isolated, child, parent;
let modelCalls = 0;
try {
  const sdk = await import(sdkUrl);
  const zerg = await import(new URL('../../index.ts', import.meta.url));
  const state = await import(new URL('../../state.ts', import.meta.url));
  const persistence = await import(new URL('../../persistence.ts', import.meta.url));
  const blocked = () => { throw new Error('Fixture forbids subprocess/install/fetch/network'); };
  for (const key of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[key] = blocked;
  net.Socket.prototype.connect = blocked;
  globalThis.fetch = blocked;
  syncBuiltinESMExports();
  const runtime = await sdk.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerProvider('rename-fixture', { api: 'rename-fixture-api', apiKey: 'fixture-only', baseUrl: 'https://unused.invalid',
    models: [{ id: 'inert', name: 'Inert', reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple() { modelCalls++; throw new Error('Rename journey must never invoke a model'); },
  });
  const tools = new Map(), commands = new Map(), lifecycle = new Map();
  let factories = 0;
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir,
    settingsManager: sdk.SettingsManager.inMemory({ packages: [], extensions: [] }),
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    extensionFactories: [pi => {
      factories++;
      registration = zerg.registerZergSwarmExtension({ ...pi, cwd,
        registerTool(definition) { tools.set(definition.name, definition); return pi.registerTool(definition); },
        registerCommand(name, command) { commands.set(name, command); return pi.registerCommand(name, command); },
        on(name, handler) { lifecycle.set(name, (lifecycle.get(name) ?? 0) + 1); return pi.on(name, handler); },
      });
    }],
  });
  await loader.reload();
  ({ session: parent } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime: runtime,
    model: (await runtime.getAvailable()).find(model => model.provider === 'rename-fixture' && model.id === 'inert'),
    settingsManager: sdk.SettingsManager.inMemory({ defaultTools: ['clankers_control', 'zerg_control'], retry: { enabled: false }, compaction: { enabled: false } }),
    sessionManager: sdk.SessionManager.inMemory(cwd), resourceLoader: loader,
    tools: ['clankers_control', 'zerg_control'] }));
  await parent.bindExtensions({ mode: 'print' });
  assert.deepEqual(parent.getActiveToolNames().sort(), ['clankers_control', 'zerg_control']);
  assert.deepEqual(parent.extensionRunner.getRegisteredCommands().map(command => command.name).sort(), ['clank', 'clankers', 'swarm', 'zerg', 'zerg-swarm']);
  assert.equal(factories, 1);
  assert.deepEqual([...tools.keys()], ['clankers_control', 'zerg_control']);
  assert.deepEqual([...commands.keys()], ['clankers', 'clank', 'zerg', 'zerg-swarm', 'swarm']);
  assert.equal(tools.get('clankers_control').execute, tools.get('zerg_control').execute);
  assert.equal(tools.get('clankers_control').parameters, tools.get('zerg_control').parameters);
  assert.equal(lifecycle.get('session_start'), 1);
  assert.equal(lifecycle.get('session_shutdown'), 1);
  const lifecycleBefore = [...lifecycle];
  if (splitAlias) isolated = zerg.createZergControl(state.createZergStateContainer());
  async function execute(name, action) {
    if (splitAlias && name === 'zerg_control') return isolated.execute(action);
    return (await tools.get(name).execute('rename-journey', action)).details;
  }
  const created = await execute('clankers_control', { action: 'agents.create', id: 'rename-proof', prompt: 'Return fixture data only.', tools: [] });
  assert.equal(created.ok, true);
  const oldRead = await execute('zerg_control', { action: 'agents.show', id: 'rename-proof' });
  assert.equal(oldRead.ok, true, 'old alias must find rename-proof created through new alias');
  assert.equal(oldRead.data.agent.id, 'rename-proof');
  assert.equal(oldRead.data.agent.prompt, 'Return fixture data only.');
  assert.deepEqual(oldRead.data.agent.tools, []);
  assert.equal((await execute('zerg_control', { action: 'agents.update', id: 'rename-proof', label: 'shared-proof' })).ok, true);
  const newRead = await execute('clankers_control', { action: 'agents.show', id: 'rename-proof' });
  assert.equal(newRead.data.agent.label, 'shared-proof');
  const parser = zerg.createZergCommandHandler(() => registration.control.getState());
  for (const alias of ['clankers', 'clank', 'zerg', 'zerg-swarm', 'swarm']) {
    const notices = [];
    await commands.get(alias).handler('agents show rename-proof', { hasUI: false, mode: 'print', ui: { notify: text => notices.push(text) } });
    assert.deepEqual(notices, [newRead.output]);
    const parsed = parser('/' + alias + ' agents show rename-proof');
    assert.equal(parsed.ok, true); assert.equal(parsed.output, newRead.output);
    assert.match(parsed.output, /rename-proof/); assert.match(parsed.output, /shared-proof/);
  }
  assert.deepEqual([...lifecycle], lifecycleBefore, 'aliases do not register extra lifecycle resources');
  assert.equal(factories, 1);

  // Literal old envelope: never generate it with the renamed writer, never save it.
  const legacyBytes = '{"version":1,"packageVersion":"1.1.25","stateSchemaVersion":"0.2.0","writerSessionId":"zerg-legacy-writer","savedAt":"2026-10-01T00:00:00.000Z","state":{"schemaVersion":"0.2.0","lifecycle":"ready","revision":1,"metadata":{"createdAt":"2026-10-01T00:00:00.000Z","updatedAt":"2026-10-01T00:00:00.000Z","resetCount":0},"agents":{"zerg-running":{"id":"zerg-running","label":"Legacy","kind":"subagent","status":"running","metadata":{"nativeSessions":[{"schemaVersion":1,"parentRunId":"zerg-running","memberRunId":"zerg-running","agentDefinitionId":"same","piSessionId":"pi-legacy","sessionFile":"/never-open/legacy.jsonl","cwd":"/never-open","createdAt":"2026-10-01T00:00:00.000Z","attachment":"attached"}]}}},"tasks":{},"teams":{},"tree":{},"events":[],"mode":{"automation":"manual","interventionEnabled":true,"controller":"operator"},"extensions":{"zergControl":{"controller":"pi"}},"agentDefinitions":{}}}\n';
  const legacyRoot = join(dir, 'legacy');
  const legacyFile = join(legacyRoot, '.pi/zerg-swarm/v1/state.json');
  mkdirSync(join(legacyRoot, '.pi/zerg-swarm/v1'), { recursive: true }); writeFileSync(legacyFile, legacyBytes);
  const manager = persistence.createZergPersistenceManager({ rootDir: legacyRoot });
  const recovered = state.createZergStateContainer();
  assert.equal(manager.info.snapshotFile, legacyFile);
  const info = manager.hydrate(recovered, () => new Date('2026-10-02T00:00:00.000Z'));
  assert.deepEqual(info.recoveredRunIds, ['zerg-running']);
  const ref = state.getSubagentRunSnapshot(recovered.read(), 'zerg-running').nativeSessions[0];
  assert.equal(ref.piSessionId, 'pi-legacy'); assert.equal(ref.createdAt, '2026-10-01T00:00:00.000Z');
  assert.equal(ref.attachment, 'unavailable'); assert.equal(ref.disposedAt, undefined);
  assert.equal(recovered.read().extensions.zergControl.controller, 'pi');
  assert.equal(readFileSync(legacyFile, 'utf8'), legacyBytes);

  // SDK managed npm layout, preinstalled locally. No package install or copied implementation.
  // Both scopes contain pinned/object entries; prefix-similar names must remain loadable.
  globalThis.__clankersRenameFactories = [];
  const names = ['pi-zerg-swarm', 'pi-clankers', 'pi-zerg-swarm-extra', 'pi-clankers-extra'];
  for (const [scope, base] of [['user', agentDir], ['project', join(cwd, '.pi')]]) {
    for (const name of names) {
      const packageDir = join(base, 'npm/node_modules', name); mkdirSync(packageDir, { recursive: true });
      writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name, version: '1.1.25', type: 'module', pi: { extensions: ['./index.js'] } }));
      writeFileSync(join(packageDir, 'index.js'), `export default function(){globalThis.__clankersRenameFactories.push(${JSON.stringify(scope + ':' + name)});}\n`);
    }
  }
  const globalFile = join(agentDir, 'settings.json'), projectFile = join(cwd, '.pi/settings.json');
  const globalBytes = JSON.stringify({ packages: ['npm:pi-zerg-swarm', { source: 'npm:pi-clankers@1.1.25', extensions: ['index.js'] }, 'npm:pi-zerg-swarm-extra@1.1.25'], extensions: [] });
  const projectBytes = JSON.stringify({ packages: [{ source: 'npm:pi-zerg-swarm@1.1.25', extensions: ['index.js'] }, 'npm:pi-clankers', 'npm:pi-clankers-extra@1.1.25'], extensions: [] });
  writeFileSync(globalFile, globalBytes); writeFileSync(projectFile, projectBytes);
  let childSettings, childLoader;
  let childCreated = 0, childDisposed = 0;
  const nativeSdk = { ...sdk, getAgentDir: () => agentDir,
    async createAgentSession(options) {
      const result = await sdk.createAgentSession(options); childCreated++;
      const dispose = result.session.dispose.bind(result.session);
      result.session.dispose = () => { childDisposed++; return dispose(); };
      return result;
    },
    ModelRuntime: { create: async () => runtime },
    SettingsManager: { create: () => { childSettings = sdk.SettingsManager.create(cwd, agentDir); return childSettings; } },
    SessionManager: { create: () => sdk.SessionManager.inMemory(cwd) },
    DefaultResourceLoader: class extends sdk.DefaultResourceLoader {
      constructor(options) { super({ ...options, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, agentsFilesOverride: () => ({ agentsFiles: [] }) }); childLoader = this; }
    },
  };
  ({ session: child } = await zerg.__zergNativeTestInternals.createPiNativeSession(nativeSdk,
    { id: 'rename-child', prompt: 'Return fixture data only.', source: 'runtime', tools: [] }, 'Inspect fixture only.', cwd, 'rename-fixture/inert'));
  assert(childLoader, 'production native path used real DefaultResourceLoader');
  assert.deepEqual(childLoader.getExtensions().errors, []);
  const loaded = globalThis.__clankersRenameFactories;
  assert(loaded.some(name => name.endsWith(':pi-zerg-swarm-extra')), 'unrelated legacy-prefix factory loaded');
  assert(loaded.some(name => name.endsWith(':pi-clankers-extra')), 'unrelated new-prefix factory loaded');
  assert.equal(loaded.filter(name => name.endsWith(':pi-zerg-swarm') || name.endsWith(':pi-clankers')).length, 0);
  for (const settings of [childSettings.getGlobalSettings(), childSettings.getProjectSettings()]) {
    for (const entry of settings.packages) if (['npm:pi-zerg-swarm', 'npm:pi-clankers', 'npm:pi-zerg-swarm@1.1.25', 'npm:pi-clankers@1.1.25'].includes(typeof entry === 'string' ? entry : entry.source)) assert.deepEqual(entry.extensions, []);
  }
  assert.equal(readFileSync(globalFile, 'utf8'), globalBytes); assert.equal(readFileSync(projectFile, 'utf8'), projectBytes);
  await child.abort(); child.dispose(); child = undefined;
  assert.equal(childCreated, 1); assert.equal(childDisposed, 1);
  registration.dispose(); registration.dispose();
  await registration.control.drain?.();
  assert.equal(modelCalls, 0, 'No hidden provider calls during rename inspection');
  console.log('PASS rename aliases, legacy read-only recovery and real child package exclusion');
} finally {
  if (child) { await child.abort(); child.dispose(); }
  if (parent) { await parent.abort(); parent.dispose(); }
  registration?.dispose(); isolated?.dispose();
  await Promise.all([registration?.control.drain?.(), isolated?.drain?.()]);
  delete globalThis.__clankersRenameFactories;
  clearTimeout(deadline); process.chdir(oldCwd); rmSync(dir, { recursive: true, force: true });
}
