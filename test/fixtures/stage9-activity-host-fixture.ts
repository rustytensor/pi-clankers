// Actual isolated Pi extension/SDK fixture. No injected native transport or
// invented live DTOs. AUTHOR-ONLY; actual journeys require a fresh execution grant.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { closeSync, fstatSync, openSync, unlinkSync, existsSync, lstatSync, realpathSync, renameSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.STAGE9_ROOT!;
assert(root && root.startsWith('/tmp/zerg-stage9-'));
const config = JSON.parse(readFileSync(join(root, 'evidence/config.json'), 'utf8'));
assert.equal(config.root, root);
assert.equal(realpathSync(root), root); const rootStat = lstatSync(root);
assert(rootStat.isDirectory() && rootStat.uid === process.getuid!() && (rootStat.mode & 0o077) === 0);

// BEGIN STAGE9 PROTOCOL (pure validators are exercised without importing Pi).
const STAGE9_PLAN = [["live",1,"startup"],["live",1,"mixed"],["live",1,"team"],["live",1,"implementation"],["live",1,"application"],["live",1,"approval-settled"],["live",1,"reuse-first"],["live",1,"reuse-retry"],["live",1,"dynamic-parallel"],["live",1,"dynamic-conditional"],["live",1,"cancel"],["live",1,"failure"],["live",1,"reload-ready"],["live",2,"reload"],["live",2,"old-retirement"],["live",2,"fresh-run"],["live",2,"completion"],["restart",1,"restart-startup"],["restart",1,"recovery"],["restart",1,"restart-completion"]] as const;
const STAGE9_RECORD_BYTES = 512, STAGE9_TOTAL_BYTES = 21504; // 40 records + budget + one atomic-publish pending file
function protocolRow(index: number) {
  const [phase, generation, state] = STAGE9_PLAN[index];
  return { version: 1, phase, generation, seq: index + 1, state };
}
function validProtocolRow(row: any, expected: any) {
  return row && typeof row === 'object' && !Array.isArray(row)
    && Object.keys(row).sort().join(',') === 'generation,phase,seq,state,version'
    && Object.keys(expected).every(key => row[key] === expected[key]);
}
// END STAGE9 PROTOCOL
function protocolPath(name: string) {
  assert(/^(?:progress|ack)-[0-9]{2}\.json(?:\.pending)?$|^budget\.json$/.test(name));
  const path = join(root, 'evidence', name);
  assert.equal(resolve(path), path); assert(path.startsWith(root + '/evidence/'));
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const st = lstatSync(parent); assert(st.isDirectory() && !st.isSymbolicLink());
    assert.equal(realpathSync(parent), parent); if (parent === dirname(parent)) break;
  }
  if (existsSync(path)) { const st = lstatSync(path); assert(st.isFile() && !st.isSymbolicLink() && st.nlink === 1);
    assert.equal(st.uid, process.getuid!()); assert(st.size <= STAGE9_RECORD_BYTES); }
  return path;
}
function protocolRead(name: string) {
  const text = readFileSync(protocolPath(name), 'utf8');
  // Our wire form is canonical JSON: duplicate keys/whitespace/unknown fields fail.
  const value = JSON.parse(text); assert.equal(text, JSON.stringify(value)); return value;
}
function protocolPut(name: string, row: any) {
  const text = JSON.stringify(row); assert(Buffer.byteLength(text) <= STAGE9_RECORD_BYTES);
  const target = protocolPath(name); assert(!existsSync(target), 'Duplicate protocol write');
  const pending = protocolPath(name + '.pending');
  writeFileSync(pending, text, { flag: 'wx', mode: 0o600 });
  assert(!existsSync(target), 'Duplicate protocol publish'); renameSync(pending, target);
}
const monotonic = () => Number(process.hrtime.bigint()) / 1e9; // Linux CLOCK_MONOTONIC, same as controller
const budget = protocolRead('budget.json');
assert.deepEqual(Object.keys(budget).sort(), ['deadline', 'start', 'version']);
assert.equal(budget.version, 1); assert.equal(typeof budget.start, 'string'); assert.equal(typeof budget.deadline, 'string');
budget.start = Number(budget.start); budget.deadline = Number(budget.deadline);
assert(Number.isFinite(budget.start)); assert.equal(budget.deadline, budget.start + 140); assert(monotonic() < budget.deadline);
const sharedKey = Symbol.for('stage9.disposable.evidence');
const shared: any = (globalThis as any)[sharedKey] ??= { generations: [], native: [], watched: new Set(), current: undefined };
shared.promptCalls ??= 0; // Cumulative prompt ENTRY evidence; never reset by reload.
// Same existing disposable process-local evidence owner, not a new registry.
const progress: any = shared.protocol ??= {
  index: process.env.STAGE9_PHASE === 'restart' ? 17 : 0,
  stateStart: monotonic(), end: Math.min(budget.deadline, monotonic() + 20), sdkIndex: process.env.STAGE9_PHASE === 'restart' ? 17 : 0,
  completed: STAGE9_PLAN.map(() => { let resolve: any; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }),
};
function deadlineError(label: string) {
  return Error(`Stage9 deadline: ${label}; state=${STAGE9_PLAN[progress.index]?.[2]} seq=${progress.index + 1} stateElapsed=${monotonic() - progress.stateStart}s overall=${monotonic() - budget.start}s`);
}
async function bounded(operation: PromiseLike<any>, label: string, observationEnd = Infinity): Promise<any> {
  const end = Math.min(budget.deadline, progress.end, monotonic() + 20, observationEnd);
  let timer: any;
  try { const value = await Promise.race([operation, new Promise<never>((_r, reject) => {
    timer = setTimeout(() => reject(deadlineError(label)), Math.max(0, (end - monotonic()) * 1000));
  })]); if (monotonic() >= end) throw deadlineError(label); return value; } finally { clearTimeout(timer); }
}
async function verifiedStage(state: string) {
  const row = protocolRow(progress.index);
  assert.equal(row.state, state); assert.equal(row.phase, process.env.STAGE9_PHASE);
  assert.equal(row.generation, generation.id);
  assert(monotonic() < Math.min(progress.end, budget.deadline), String(deadlineError(state)));
  const id = String(row.seq).padStart(2, '0'); protocolPut('progress-' + id + '.json', row);
  // Ack is a separate hard20s/inactivity20s observation; it may NOT extend the
  // already running state deadline. Only a verified exact ack advances a state.
  await until(() => {
    const name = 'ack-' + id + '.json'; if (!existsSync(protocolPath(name))) return false;
    assert(validProtocolRow(protocolRead(name), row), 'Malformed/stale/out-of-order ack'); return true;
  }, 'controller ack ' + state);
  progress.completed[progress.index].resolve(); progress.index++;
  progress.stateStart = monotonic(); progress.end = Math.min(budget.deadline, progress.stateStart + 20);
}
async function sdkStagesThrough(state: string) {
  const end = STAGE9_PLAN.findIndex((row, index) => index >= progress.sdkIndex && row[2] === state);
  assert(end >= progress.sdkIndex);
  for (; progress.sdkIndex <= end; progress.sdkIndex++) {
    await bounded(progress.completed[progress.sdkIndex].promise, 'actual SDK stage ' + STAGE9_PLAN[progress.sdkIndex][2]);
    if (existsSync(join(root, 'evidence/failure.json'))) throw Error(JSON.stringify(read('failure.json')));
  }
}

const require = createRequire(join(config.piRoot, 'package.json'));
const { createJiti } = await bounded(import(pathToFileURL(require.resolve('jiti')).href), 'load pinned jiti');
const jiti = createJiti(import.meta.url, { moduleCache: true, fsCache: false, interopDefault: false, alias: config.aliases });
// Exact candidate paths only; no silent public index fallback.
// Additive evidence seams wrap actual exported factories and forward every
// original source/result/subscription. Unsupported export wrapping fails closed.
// No production file/DTO/outcome/approval is manufactured or modified.

const backgroundModule: any = await bounded(jiti.import(join(config.candidateRoot, 'ui/background-activity.ts')), 'pinned module startup');
const preferencesModule: any = await bounded(jiti.import(join(config.candidateRoot, 'ui/preferences.ts')), 'pinned module startup');
const managementModule: any = await bounded(jiti.import(join(config.candidateRoot, 'ui/management-overlay.ts')), 'pinned module startup');
function seam(module: any, name: string, wrapper: (original: any) => any) {
  const original = module[name]; assert.equal(typeof original, 'function');
  if (original.stage9EvidenceSeam) return;
  const wrapped = wrapper(original); wrapped.stage9EvidenceSeam = true;
  const descriptor = Object.getOwnPropertyDescriptor(module, name);
  assert(descriptor, 'Unsupported exported evidence seam');
  Object.defineProperty(module, name, { configurable: true, enumerable: descriptor.enumerable, writable: true, value: wrapped });
  assert.equal(module[name], wrapped);
}
seam(backgroundModule, 'createBackgroundActivityController', original => (options: any) => {
  const g = shared.current; assert(g); g.factories++;
  const wrap = (source: any, key: string) => !source ? source : {
    snapshot: () => { g.snapshots++; const value = source.snapshot(); g[key] = value; return value; },
    subscribe: (listener: any) => {
      g.subscriptions++; const remove = source.subscribe(() => { g.events++; listener(); }); let active = true;
      return () => { if (active) { active = false; remove(); g.subscriptions--; } };
    },
  };
  const clock = { now: Date.now, setTimeout(callback: any, delay: number) {
    const token = setTimeout(() => { g.timers.delete(token); callback(); }, delay);
    token.unref(); g.timers.add(token); return token;
  }, clearTimeout(token: any) { clearTimeout(token); g.timers.delete(token); } };
  return original({ ...options, clock, native: wrap(options.native, 'nativeSnapshot'),
    workflows: wrap(options.workflows, 'workflowSnapshot'), permissions: wrap(options.permissions, 'permissionSnapshot') });
});
seam(preferencesModule, 'createUiPreferences', original => (...args: any[]) => {
  shared.current.preferences++; return original(...args);
});
seam(managementModule, 'openZergManagementOverlay', original => (...args: any[]) => {
  const g = shared.current; assert(g && typeof g.witnessedContext === 'function');
  g.managementFactories++;
  // Observe BOTH real command and shortcut contexts here, without replacing
  // either registered handler identity or the production catalog anchor.
  return original(g.witnessedContext(args[0]), ...args.slice(1));
});
const zerg: any = await bounded(jiti.import(join(config.candidateRoot, 'index.ts')), 'pinned module startup');
const persistence: any = await bounded(jiti.import(join(config.candidateRoot, 'persistence.ts')), 'pinned module startup');
const workflowModel: any = await bounded(jiti.import(join(config.candidateRoot, 'workflow-model.ts')), 'pinned module startup');
const codingExample: any = await bounded(jiti.import(join(config.candidateRoot, 'workflow-coding-example.ts')), 'pinned module startup');
const examples: any = await bounded(jiti.import(join(config.candidateRoot, 'workflow-script-examples.ts')), 'pinned module startup');
const sdk: any = await bounded(jiti.import(config.aliases['@earendil-works/pi-coding-agent']), 'pinned module startup');
const tui: any = await bounded(jiti.import(config.aliases['@earendil-works/pi-tui']), 'pinned module startup');
const hash = (value: any) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = (value: any) => JSON.parse(JSON.stringify(value));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// BEGIN STAGE9 EVIDENCE PUBLICATION (finite fixture messages only).
// One synchronous writer per target; one actor-owned pending slot, never progress/ack.
const EVIDENCE_NAMES = ["release.json", "observed.json", "frames.json", "stage.json", "live.json", "performance.json", "restart-ready.json", "reload-ready.json", "approval-implementation.json", "approval-application.json", "reuse.json", "dynamic-read-only-parallel-review.json", "dynamic-bounded-conditional-refinement.json", "reload-proof.json", "result.json", "collision-fired.json", "modal-open.json", "modal-closed.json", "probe.json", "failure.json", "phase-finished.json", "non-tui.json"];
const EVIDENCE_PENDING = '.stage9-host-evidence.pending';
function evidenceStat(path: string) {
  let st;
  try { st = lstatSync(path); } catch (error: any) { if (error.code === 'ENOENT') return undefined; throw error; }
  assert(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.uid === process.getuid!());
  return st;
}
function evidencePath(name: string) {
  assert(EVIDENCE_NAMES.includes(name) || name === EVIDENCE_PENDING, 'Unowned evidence path');
  assert(root.startsWith('/tmp/zerg-stage9-') && resolve(root) === root);
  const owner = lstatSync(root); assert(owner.isDirectory() && owner.uid === process.getuid!() && (owner.mode & 0o077) === 0);
  const path = join(root, 'evidence', name); assert(path.startsWith(root + '/evidence/') && resolve(path) === path);
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const st = lstatSync(parent); assert(st.isDirectory() && !st.isSymbolicLink());
    assert.equal(realpathSync(parent), parent); if (parent === dirname(parent)) break;
  }
  evidenceStat(path); return path;
}
function evidencePut(name: string, value: any) {
  assert(EVIDENCE_NAMES.includes(name), 'Unowned evidence publisher');
  const text = JSON.stringify(value, null, 2); assert.equal(typeof text, 'string');
  const target = evidencePath(name), prior = evidenceStat(target), pending = evidencePath(EVIDENCE_PENDING);
  const fd = openSync(pending, 'wx', 0o600), owned = fstatSync(fd); let published = false;
  try {
    try { assert(owned.isFile() && owned.nlink === 1 && owned.uid === process.getuid!()); writeFileSync(fd, text); } finally { closeSync(fd); }
    const st = evidenceStat(evidencePath(EVIDENCE_PENDING)); assert(st && st.dev === owned.dev && st.ino === owned.ino);
    const current = evidenceStat(evidencePath(name));
    assert(prior ? current && current.dev === prior.dev && current.ino === prior.ino : !current, 'Competing evidence writer');
    renameSync(pending, target); published = true;
  } finally {
    if (!published) {
      const st = evidenceStat(evidencePath(EVIDENCE_PENDING)); assert(st && st.dev === owned.dev && st.ino === owned.ino);
      unlinkSync(pending); // Exactly one owned cleanup attempt; never a stale/foreign slot.
    }
  }
}
// END STAGE9 EVIDENCE PUBLICATION
const put = (name: string, value: any) => evidencePut(name, value);
const read = (name: string) => JSON.parse(readFileSync(join(root, 'evidence', name), 'utf8'));
const snapshot = join(root, 'live-snapshot.json');
const recoveredSnapshot = join(root, 'recovered-snapshot.json');
const assertions = new Set<string>();
const prove = (name: string) => assertions.add(name);
const requests = () => existsSync(join(root, 'evidence/http-count.json')) ? read('http-count.json').requests : 0;
async function until(check: () => any, label: string) {
  const end = Date.now() + 20000, observationEnd = monotonic() + 20;
  while (Date.now() < end && monotonic() < Math.min(progress.end, budget.deadline)) {
    if (existsSync(join(root, 'evidence/server-failure.json'))) throw Error(JSON.stringify(read('server-failure.json')));
    if (await bounded(Promise.resolve().then(check), label, observationEnd)) return;
    await sleep(20);
  }
  throw deadlineError(label);
}
const release = (models: string[]) => put('release.json', { models });
const native: any[] = shared.native;
const watched: Set<object> = shared.watched;
for (const host of [sdk, await bounded(import(config.sdk), 'actual host startup')]) {
  const proto = host.AgentSession.prototype;
  if (watched.has(proto)) continue; watched.add(proto);
  const prompt = proto.prompt, dispose = proto.dispose;
  const records = new WeakMap<object, any>();
  proto.prompt = function (...args: any[]) {
    shared.promptCalls++; // Includes main, repeated and rejected calls before forwarding.
    // The main session dispatches configuration commands; it is NOT a Zerg worker.
    if (this === shared.mainSession) return prompt.apply(this, args);
    let record = records.get(this);
    if (!record) {
      assert(native.length < 32);
      record = { generation: shared.current?.id, sessionId: this.sessionId, model: this.model?.id, disposed: false, starts: 0, ends: 0 };
      records.set(this, record); native.push(record);
      // Evidence-only subscription; never modifies, steers or replays a session.
      record.unsubscribe = this.subscribe((event: any) => {
        if (event.type === 'agent_start') record.starts++;
        if (event.type === 'agent_end') record.ends++;
      });
    }
    return prompt.apply(this, args);
  };
  proto.dispose = function (...args: any[]) {
    const result = dispose.apply(this, args);
    const record = records.get(this);
    if (record) { record.disposed = true; record.unsubscribe?.(); }
    return result;
  };
}
const live = () => native.filter(r => !r.disposed && r.starts > r.ends);
let registration: any, ctx: any, handler: any, widget: any, handle: any;
let opens = 0, closes = 0, frameCount = 0, frames: any[] = [], latestLines = '';
let generation: any, stableObserverWindow = false;
const initiationSnapshot = () => ({ prompts: shared.promptCalls, starts: native.reduce((n, r) => n + r.starts, 0), sessions: native.length });
const serialNative = () => native.map(({ unsubscribe: _u, ...record }) => record);
const metrics = (g: any) => ({ id: g.id, factories: g.factories, preferences: g.preferences,
  managementFactories: g.managementFactories, subscriptions: g.subscriptions, inputs: g.inputs, widgets: g.widgets,
  timers: g.timers.size, snapshots: g.snapshots, events: g.events, shutdown: g.shutdown, shortcuts: g.shortcuts.map((r: any) => r.key) });
const observe = (ui = ctx?.ui, g = generation) => put('observed.json', { generation: g?.id, lifecycle: shared.generations.map(metrics), opens, closes, frameCount, lines: latestLines,
  draft: ui?.getEditorText?.(), native: serialNative(), initiation: initiationSnapshot() });
function stateHash(control = registration?.control) { return hash(control?.getState()); }
function witnessComponent(component: any, kind: 'widget' | 'management', g = generation, ui = ctx?.ui) {
  const control = g.registration.control;
  return new Proxy(component, { get(target, key) {
    if (key === 'render') return (...args: any[]) => {
      const stateBefore = stateHash(control), initiationBefore = initiationSnapshot(), requestBefore = requests(), start = performance.now();
      const lines = target.render(...args);
      assert.equal(stateHash(control), stateBefore, 'Rendering changed execution authority/state');
      assert.deepEqual(initiationSnapshot(), initiationBefore, 'Rendering initiated genuine SDK work');
      // External HTTP publication is causal evidence only while genuine work is held.
      if (stableObserverWindow) assert.equal(requests(), requestBefore, 'Rendering initiated provider work');
      assert(Array.isArray(lines));
      for (const line of lines) assert(tui.visibleWidth(line) <= args[0]);
      if (kind === 'widget') {
        assert(lines.length <= 2); latestLines = lines.map((line: string) => tui.stripTerminalSequences(line)).join('\n');
        if (frames.length < 256 && frames.at(-1)?.lines !== latestLines) {
          frames.push({ at: Date.now(), width: args[0], height: handle?.terminal?.rows, lines: latestLines });
          put('frames.json', frames);
        }
      }
      g.renderMs += performance.now() - start; g.renders++;
      frameCount++; assert(frameCount <= 10000); observe(ui, g); return lines;
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
}
const contextCache = new WeakMap<object, any>();
function witnessedContext(context: any, g = generation) {
  if (!context?.ui) return context;
  let ui = contextCache.get(context.ui);
  if (!ui) { ui = new Proxy(context.ui, { get(target, key) {
    if (key === 'onTerminalInput') return (listener: any) => {
      g.inputs++; const remove = target.onTerminalInput(listener); let active = true;
      return () => { if (active) { active = false; remove(); g.inputs--; } };
    };
    if (key === 'setWidget') return (name: string, content: any, options: any) => {
      if (name === 'pi-zerg-swarm.background-activity') g.widgets = content ? 1 : 0;
      if (name !== 'pi-zerg-swarm.background-activity' || typeof content !== 'function') return target.setWidget(name, content, options);
      return target.setWidget(name, (...args: any[]) => {
        handle = args[0]; widget = witnessComponent(content(...args), 'widget', g, target); return widget;
      }, options);
    };
    if (key === 'custom') return async (factory: any, options: any) => {
      // Capture this opening owner before async work; never reroute old callbacks.
      const reentryHandler = g.handler, reentryContext = witnessedContext(context, g);
      assert.equal(typeof reentryHandler, 'function');
      opens++; observe(target, g);
      try { return await target.custom((...args: any[]) => {
        const actual = factory(...args); assert(actual instanceof managementModule.ZergManagementOverlayComponent, 'Same real management component, no fallback');
        const signature = hash([actual.constructor.name, String(actual.render), String(actual.handleInput)]);
        g.managementSignatures.push(signature);
        // Canonical handler reentry while the same actual custom UI is opening
        // must hit the shared latch, not create a second component.
        queueMicrotask(() => void reentryHandler('config', reentryContext));
        return witnessComponent(actual, 'management', g, target);
      }, options); }
      finally { closes++; observe(target, g); }
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } }); contextCache.set(context.ui, ui); }
  return new Proxy(context, { get(target, key) { return key === 'ui' ? ui : Reflect.get(target, key); } });
}
async function exec(action: any) {
  const reply = await bounded(registration.control.execute(action), 'structured control ' + action.action); assert(reply.ok, JSON.stringify(reply)); return reply;
}
async function shown(runId: string) { return (await exec({ action: 'runs.show', runId })).data.run; }
async function workflow(workflowRunId: string) {
  return registration.control.getState().extensions.workflows.runs.find((run: any) => run.workflowRunId === workflowRunId);
}
function stripCount() {
  const match = latestLines.match(/(\d+) agents working/); return match ? Number(match[1]) : 0;
}
async function actualCount(expected: number) {
  await until(() => live().length === expected, 'actual SDK execution count ' + expected);
  if (config.mode !== 'sdk') await until(() => stripCount() === expected, 'actual widget count ' + expected);
  assert.equal(new Set(live().map(r => r.sessionId)).size, expected);
}
async function uiCheckpoint(stage: string) {
  put('stage.json', { stage });
  if (config.mode !== 'sdk') await until(() => existsSync(join(root, 'evidence/ui-' + stage + '.json')), 'real PTY checkpoint ' + stage);
}
async function journey() {
  for (const id of ['solo', 'w0', 'w1', 'w2', 'lead', 'workflow', 'fail', 'cancel']) {
    await exec({ action: 'agents.create', id, label: id, model: 'fixture/' + id,
      prompt: 'Only scripted fixture response. Never invoke tools or delegate.', tools: id === 'workflow' ? ['read'] : [] });
  }
  const solo = await exec({ action: 'run', agent: 'solo', task: 'S9 standalone readonly', background: true });
  await actualCount(1); prove('standalone-live');
  await exec({ action: 'team.create', id: 'tiny-team', leader: 'lead', members: ['w0', 'w1', 'w2'] });
  const team = await exec({ action: 'run', agent: 'tiny-team', task: 'S9 bounded readonly team', background: true, concurrency: 1 });
  await actualCount(2);
  const queued = await shown(team.runId);
  assert(queued.memberProgress.filter((r: any) => r.status === 'queued').length >= 2);
  assert(!native.some(r => r.model === 'lead')); prove('team-queued');
  await exec({ action: 'workflows.define', definition: { id: 's9-ro', version: 1, label: 'WF',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    steps: [{ id: 'review', kind: 'native', dependsOn: [], agentId: 'workflow',
      prompt: 'S9_WF return JSON string done, readonly no tools needed', inputs: {}, outputSchema: { type: 'string', maxLength: 32 } }] } });
  const start = await exec({ action: 'workflows.start', definitionId: 's9-ro', inputs: {}, concurrency: 1 });
  const workflowRunId = start.data.view.workflowRunId;
  await actualCount(3); prove('workflow-mixed');
  // agent_start precedes transport dispatch. Observe all three expected held
  // requests before measuring whether later rendering creates provider work.
  await until(() => {
    const rows = read('http-count.json').rows;
    return rows.length === 3 && ['solo', 'w0', 'workflow'].every(model => rows.some((row: any) => row.model === model));
  }, 'mixed actual transports admitted before observer invariance baseline');
  const mixed = await workflow(workflowRunId), mixedUnit = mixed.steps[0].units[0];
  assert(mixedUnit.native);
  const identity = await shown(mixedUnit.native.runId);
  assert.equal(identity.taskId, mixedUnit.native.taskId);
  const sdkIds = identity.nativeSessions.map((row: any) => row.piSessionId);
  assert(sdkIds.includes(live().find(r => r.model === 'workflow')!.sessionId), 'Exact native ledger/real SDK identity join');
  prove('exact-dedup');
  const checkpoint = clone(registration.control.getState());
  await exec({ action: 'workflows.pause', workflowRunId });
  assert.equal((await workflow(workflowRunId)).status, 'paused');
  stableObserverWindow = true;
  try {
    const before = { state: stateHash(), count: requests() }, initiationBefore = initiationSnapshot();
    if (widget) for (let i = 0; i < 100; i++) widget.render(240);
    await sleep(100);
    const pullCount = generation.snapshots, tickFrames = generation.renders;
    await sleep(1100); // Active timer is real; it must reuse bounded cached DTOs.
    if (config.mode !== 'sdk') { assert.equal(generation.snapshots, pullCount); assert(generation.renders > tickFrames); }
    assert.deepEqual({ state: stateHash(), count: requests() }, before);
    assert.deepEqual(initiationSnapshot(), initiationBefore, 'Observer window initiated genuine SDK work');
    prove('observer-no-authority'); prove('pause');
    put('live.json', { solo: solo.runId, team: team.runId, workflowRunId, native: serialNative() });
    await uiCheckpoint('live'); await verifiedStage('mixed');
    assert.deepEqual({ state: stateHash(), count: requests() }, before);
    // Reviewed controller submits /zerg config and /s9modal through main.prompt.
    // Passive/render prompt equality above remains total; UI must not start workers.
    const initiationAfter = initiationSnapshot();
    assert.deepEqual({ starts: initiationAfter.starts, sessions: initiationAfter.sessions },
      { starts: initiationBefore.starts, sessions: initiationBefore.sessions }, 'UI window initiated genuine SDK worker work');
  } finally { stableObserverWindow = false; }
  await exec({ action: 'workflows.resume', workflowRunId });
  release(['w0']); await until(() => native.some(r => r.model === 'w1'), 'queued w1 admitted');
  assert(!native.some(r => r.model === 'lead'));
  release(['w0', 'w1']); await until(() => native.some(r => r.model === 'w2'), 'queued w2 admitted');
  assert(!native.some(r => r.model === 'lead'));
  release(['w0', 'w1', 'w2']); await until(() => live().some(r => r.model === 'lead'), 'actual leader admitted after workers');
  await actualCount(3); prove('leader-actual-only');
  release(['w0', 'w1', 'w2', 'lead', 'solo', 'workflow']);
  await until(async () => (await shown(team.runId)).status === 'done' && (await shown(solo.runId)).status === 'done'
    && (await workflow(workflowRunId)).status === 'completed' && (await workflow(workflowRunId)).cleanupSettled, 'natural completion');
  await actualCount(0); prove('completion'); await verifiedStage('team');
  await approvalJourney();
  await reuseJourney();
  await dynamicJourney();
  const cancel = await exec({ action: 'run', agent: 'cancel', task: 'S9 cancellation', background: true });
  await actualCount(1);
  await exec({ action: 'interrupt', runId: cancel.runId });
  await until(async () => (await shown(cancel.runId)).status === 'cancelled' && native.filter(r => r.model === 'cancel').every(r => r.disposed), 'cancellation SDK cleanup');
  await actualCount(0); prove('cancel-cleanup'); await verifiedStage('cancel');
  const fail = await exec({ action: 'run', agent: 'fail', task: 'S9 fixture failure', background: true });
  await actualCount(1); release(['w0', 'w1', 'w2', 'lead', 'solo', 'workflow', 'fail']);
  await until(async () => (await shown(fail.runId)).status === 'failed' && native.filter(r => r.model === 'fail').every(r => r.disposed), 'failure with settled SDK handles');
  await actualCount(0); prove('failure');
  assert(native.every(r => r.disposed)); await verifiedStage('failure');
  persistence.createZergPersistenceManager({ enabled: true, snapshotFile: recoveredSnapshot }).save(checkpoint);
  put('performance.json', { renders: generation.renders, totalRenderMs: generation.renderMs, snapshots: generation.snapshots, events: generation.events });
  put('restart-ready.json', { workflowRunId, requests: requests(), assertions: [...assertions], native: serialNative() });
  await uiCheckpoint('settings');
  if (config.mode !== 'sdk') {
    const result = read('ui-settings.json');
    for (const name of result.assertions) prove(name);
    assert(generation.managementSignatures.length >= 2);
    assert.equal(new Set(generation.managementSignatures).size, 1); prove('command-shortcut-component-latch');
    assert(generation.factories > 0 && generation.preferences > 0 && generation.managementFactories >= 2, 'Evidence seam actually used');
  }
  put('reload-ready.json', { generation: generation.id, assertions: [...assertions], requests: requests(), native: serialNative() });
  put('stage.json', { stage: 'reload-ready' }); await verifiedStage('reload-ready');
}
const units = (run: any) => workflowModel.workflowStepEntries(run).flatMap((e: any) => e.step.units);
async function approvalJourney() {
  for (const id of ['coding-reader', 'coding-writer']) await exec({ action: 'agents.create', id, label: id,
    model: 'fixture/' + id, prompt: 'Only exact sealed disposable workflow tools; no other tools or delegation.', tools: ['read'] });
  await exec({ action: 'workflows.define', definition: generation.example.definition });
  const id = (await exec({ action: 'workflows.start', definitionId: generation.example.definition.id, inputs: {}, concurrency: 1 })).data.view.workflowRunId;
  const pending = (kind: string) => registration.control.workflowApprovals.inspect().find((r: any) =>
    r.kind === kind && r.status === 'pending' && r.request.humanReview?.workflow?.workflowRunId === id);
  for (const kind of ['implementation', 'application']) {
    await until(() => pending(kind), 'genuine ' + kind + ' approval pending');
    await actualCount(0);
    const request = clone(pending(kind)); assert(/^[a-f0-9]{64}$/.test(request.requestHash));
    const run = await workflow(id); assert(units(run).some((u: any) => u.coding?.approvalStatus === 'pending'));
    const source = generation.workflowSnapshot?.runs.find((r: any) => r.workflowRunId === id);
    if (config.mode !== 'sdk') {
      await until(() => /workflow approvals pending/.test(latestLines), 'real approval strip with zero native agents');
      assert.equal(stripCount(), 0);
      assert(source || generation.workflowSnapshot?.runs.some((r: any) => r.workflowRunId === id));
    }
    stableObserverWindow = true;
    try {
      const before = { requests: requests(), state: stateHash() }, initiationBefore = initiationSnapshot();
      if (widget) for (let n = 0; n < 20; n++) widget.render(240);
      await sleep(100); assert.deepEqual({ requests: requests(), state: stateHash() }, before);
      assert.deepEqual(initiationSnapshot(), initiationBefore, 'Observer window initiated genuine SDK work');
    } finally { stableObserverWindow = false; }
    assert.equal(readFileSync(join(root, 'work/src/message.txt'), 'utf8'), generation.example.initialFiles['src/message.txt']);
    put('approval-' + kind + '.json', { request, run, requests: requests(), native: serialNative() });
    // This is the disposable fixture's trusted operator, not model output or
    // strip authority. Grant only the exact *current* fingerprint after pending.
    const current = pending(kind); assert.equal(current.id, request.id); assert.equal(current.requestHash, request.requestHash);
    registration.control.workflowApprovals.grantFingerprint(current.id, current.requestHash);
    await verifiedStage(kind);
  }
  await until(async () => { const run = await workflow(id); return run.status === 'completed' && run.cleanupSettled; }, 'approved disposable coding settled');
  assert.equal(readFileSync(join(root, 'work/src/message.txt'), 'utf8'), 'hello from trusted workflow\n');
  await actualCount(0); prove('approval'); await verifiedStage('approval-settled');
}
async function reuseJourney() {
  // Recovery-enabled families intentionally refuse reuse. This live disposable
  // owner has recovery disabled; the separate restored owner enables inspection.
  for (const id of ['reuse-a', 'reuse-b']) await exec({ action: 'agents.create', id, label: id,
    model: 'fixture/' + id, tools: ['read'], prompt: 'Readonly scripted JSON response; invoke no tools.' });
  const definition = { id: 's9-reuse', version: 1, label: 'Fixed reuse witness',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    steps: ['a', 'b'].map((id, index) => ({ id, kind: 'native', agentId: 'reuse-' + id,
      dependsOn: index ? ['a'] : [], inputs: {}, prompt: 'Readonly S9 reuse ' + id,
      outputSchema: { type: 'string', maxLength: 32 } })) };
  await exec({ action: 'workflows.define', definition });
  const firstId = (await exec({ action: 'workflows.start', definitionId: definition.id, inputs: {}, concurrency: 1 })).data.view.workflowRunId;
  await until(async () => { const run = await workflow(firstId); return run.status === 'failed' && run.cleanupSettled; }, 'A success/B actual provider401 fully settled');
  await actualCount(0); const first = clone(await workflow(firstId));
  const a = units(first).find((u: any) => u.stepId === 'a');
  assert.equal(a.status, 'completed'); assert(a.native && a.cleanupSettled);
  const beforeRows = read('http-count.json').rows.filter((r: any) => r.model === 'reuse-a');
  assert.equal(beforeRows.length, 1); await verifiedStage('reuse-first');
  const nextId = (await exec({ action: 'workflows.retry', workflowRunId: firstId })).data.view.workflowRunId;
  await actualCount(1);
  const next = clone(await workflow(nextId)), reused = units(next).find((u: any) => u.stepId === 'a');
  assert.equal(next.retryOf, firstId); assert.equal(next.familyId, first.familyId); assert.equal(next.attemptNo, 2);
  assert.equal(next.definitionHash, first.definitionHash); assert.deepEqual(next.inputs, first.inputs);
  assert.deepEqual(reused.reusedFrom, { workflowRunId: firstId, unitId: a.id, native: a.native });
  assert.deepEqual(reused.native, a.native);
  assert.equal(read('http-count.json').rows.filter((r: any) => r.model === 'reuse-a').length, 1);
  assert.equal(native.filter(r => r.model === 'reuse-a').length, 1);
  assert.notEqual(native.filter(r => r.model === 'reuse-b')[0].sessionId, native.filter(r => r.model === 'reuse-b')[1].sessionId);
  assert.equal(native.filter(r => r.model === 'reuse-b').length, 2);
  assert.equal(live()[0].model, 'reuse-b');
  assert.equal((await bounded(registration.control.execute({ action: 'workflows.retry', workflowRunId: firstId }), 'reject superseded retry')).ok, false, 'Superseded family cannot retry');
  put('reuse.json', { first, next, native: serialNative(), rows: read('http-count.json').rows });
  release(['reuse-b']);
  await until(async () => { const run = await workflow(nextId); return run.status === 'completed' && run.cleanupSettled; }, 'retry B settled');
  await actualCount(0); prove('reused-inert'); await verifiedStage('reuse-retry');
}
async function dynamicJourney() {
  for (const id of ['generalist', 'reviewer']) await exec({ action: 'agents.create', id, label: id,
    model: 'fixture/' + id, tools: ['read'], prompt: 'Readonly schema JSON; no tools or execution authority.' });
  for (const original of [examples.READ_ONLY_PARALLEL_DEFINITION, examples.CONDITIONAL_REFINEMENT_DEFINITION]) {
    release([]);
    await exec({ action: 'workflows.define', definition: clone(original) });
    const inputs = original.id === examples.READ_ONLY_PARALLEL_DEFINITION.id ? { targets: ['sentinel.txt'] } : { targets: ['sentinel.txt'], extraReview: false };
    const id = (await exec({ action: 'workflows.start', definitionId: original.id, inputs, concurrency: 1 })).data.view.workflowRunId;
    await actualCount(1);
    if (config.mode !== 'sdk') {
      await until(() => generation.workflowSnapshot?.runs.find((r: any) => r.workflowRunId === id)?.progress.total === null, 'actual dynamic progress has no denominator');
      await until(() => /total unknown/.test(latestLines), 'real fanout/repeat strip total unknown, not expansion ceiling');
      assert(!/\d+\/\d+ steps completed/.test(latestLines));
    }
    put('dynamic-' + original.id + '.json', { run: clone(await workflow(id)), activity: generation.workflowSnapshot ?? null, lines: latestLines });
    release(['generalist', 'reviewer']);
    await until(async () => { const run = await workflow(id); return run.status === 'completed' && run.cleanupSettled; }, 'validated readonly dynamic example settled');
    await actualCount(0);
    await verifiedStage(original.id === examples.READ_ONLY_PARALLEL_DEFINITION.id ? 'dynamic-parallel' : 'dynamic-conditional');
  }
  prove('dynamic-total-unknown');
}
async function afterReload() {
  const prior = read('reload-ready.json'), before = requests();
  assert(generation.id > prior.generation); await verifiedStage('reload');
  const old = shared.generations.find((g: any) => g.id === prior.generation);
  assert(old.shutdown, 'Actual old runtime session_shutdown observed');
  for (const field of ['subscriptions', 'inputs', 'widgets']) assert.equal(old[field], 0, 'Old observer ' + field + ' removed');
  assert.equal(old.timers.size, 0);
  // Each retained actual host catalog must withdraw only our old handler.
  if (config.mode !== 'sdk') assert(old.catalogs.length > 0);
  for (const { map, own, other } of old.catalogs) {
    for (const row of map.values()) assert(!own.has(row.handler), 'Old opener retained in actual host shortcut table');
    for (const [key, row] of other) assert.equal(map.get(key), row, 'Other shortcut owner altered');
  }
  assert(native.every(r => r.disposed)); assert.equal(live().length, 0);
  await sleep(100); assert.equal(requests(), before, 'History did not reconnect/replay after reload');
  await verifiedStage('old-retirement');
  if (config.mode !== 'sdk') {
    await until(() => generation.factories > 0 && generation.inputs === 1 && generation.widgets === 1, 'new TUI observer generation bound');
    await uiCheckpoint('reload');
    for (const name of read('ui-reload.json').assertions) prove(name);
  }
  // Structured control, not terminal /zerg automation: new-generation SDK proof.
  await exec({ action: 'agents.create', id: 'reloaded', model: 'fixture/reloaded', tools: [], prompt: 'Scripted dummy response only.' });
  const fresh = await exec({ action: 'run', agent: 'reloaded', task: 'new generation only', background: true });
  await until(async () => (await shown(fresh.runId)).status === 'done' && native.some(r => r.generation === generation.id && r.model === 'reloaded' && r.disposed), 'new generation genuinely owns SDK execution');
  for (const name of prior.assertions) prove(name); prove('reload'); prove('reload-old-resources-retired');
  put('restart-ready.json', { ...read('restart-ready.json'), assertions: [...assertions] });
  put('reload-proof.json', { old: metrics(old), current: metrics(generation), native: serialNative(), requests: requests() });
  await verifiedStage('fresh-run');
}
async function recovered() {
  const original = read('restart-ready.json'), before = requests();
  const result = await exec({ action: 'workflows.show', workflowRunId: original.workflowRunId });
  assert.equal(result.data.view.recovered, true); assert.equal(result.data.view.status, 'needs-attention');
  for (const action of ['workflows.resume', 'workflows.retry']) {
    assert.equal((await bounded(registration.control.execute({ action, workflowRunId: original.workflowRunId }), 'reject recovered ' + action)).ok, false);
  }
  await sleep(200); assert.equal(native.length, 0); assert.equal(requests(), before);
  if (widget) assert.equal(stripCount(), 0, 'Recovery must not claim live SDK work');
  for (const name of original.assertions) prove(name); prove('recovered-inert');
  if (config.mode !== 'sdk') {
    await uiCheckpoint('restart');
    for (const name of read('ui-restart.json').assertions) prove(name);
  }
  await verifiedStage('recovery');
  put('result.json', { ok: true, assertions: [...assertions],
    limitations: ['isolated dummy-loopback executed; no external-provider or model-quality acceptance', 'no OS sandbox', 'no human visual claim',
      'restored genuine in-flight checkpoint after natural cleanup, not a crash'] });
}
// Observe actual resolved Maps only *after* the owner's original resolver runs.
// Do not replace getShortcuts (its immutable fingerprint is an acceptance gate).
// The public registrar records exact own handler identities. SDK runSDK retains
// its real Map; PTY captures the returned Map at the public setup consumer seam.
const runtimeProto = sdk.AgentSession.prototype;
if (!shared.catalogWitnessInstalled) {
  shared.catalogWitnessInstalled = true;
  const bind = runtimeProto.bindExtensions;
  runtimeProto.bindExtensions = async function (...args: any[]) {
    const result = await bind.apply(this, args);
    shared.mainSession ??= this; return result;
  };
}
if (config.mode !== 'sdk' && !shared.setupCatalogWitnessInstalled) {
  shared.setupCatalogWitnessInstalled = true;
  const proto = sdk.InteractiveMode.prototype;
  const original = proto.setupExtensionShortcuts; assert.equal(typeof original, 'function');
  // Evidence-only consumer seam: original resolver, original real receiver,
  // original effective bindings and exact returned Map. Never wrap/replace
  // getShortcuts or its fingerprint, filter decisions, or register an opener.
  proto.setupExtensionShortcuts = function (runner: any) {
    const g = shared.current; shared.mainSession = this.session;
    const receiver = new Proxy(runner, { get(target, key) {
      if (key === 'getShortcuts') return (...args: any[]) => {
        const map = target.getShortcuts(...args); assert(map instanceof Map);
        const own = new Set(g.shortcuts.filter((r: any) => r.description === 'Open Clankers management (/clankers config)').map((r: any) => r.handler));
        assert.equal(own.size, 1, 'Actual effective owned opener registered by production guard');
        assert([...map.values()].some((r: any) => own.has(r.handler)));
        g.catalogs.push({ map, own, other: [...map].filter(([, row]: any) => !own.has(row.handler)) });
        return map; // Exact Map consumed by the real main editor dispatch closure.
      };
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    return original.call(this, receiver);
  };
}
export default async function stage9HostFixture(pi: any) {
  const g: any = { id: shared.generations.length + 1, factories: 0, preferences: 0, managementFactories: 0,
    subscriptions: 0, inputs: 0, widgets: 0, snapshots: 0, events: 0, renders: 0, renderMs: 0,
    shutdown: false, timers: new Set(), shortcuts: [], catalogs: [], managementSignatures: [] };
  shared.generations.push(g); shared.current = g; generation = g;
  // Cached exported seams dispatch only at entry, through this fresh owner.
  g.witnessedContext = (context: any) => witnessedContext(context, g);
  const example = codingExample.buildTrustedCodingWorkflowExample({ projectRoot: join(root, 'work'), stagingParent: join(root, 'stage'),
    parentRunId: 's9-disposable-host', taskId: 's9-approval-witness', rootAgentId: 'coding-reader', workerAgentId: 'coding-writer', model: 'fixture/coding-writer' });
  g.example = example;
  if (!existsSync(join(root, 'stage'))) mkdirSync(join(root, 'stage'));
  if (!existsSync(join(root, 'work/src'))) mkdirSync(join(root, 'work/src'));
  if (!existsSync(join(root, 'work/src/message.txt'))) for (const [path, text] of Object.entries(example.initialFiles)) writeFileSync(join(root, 'work', path), text as string, { flag: 'wx' });
  const proxy = new Proxy(pi, { get(target, key) {
    if (key === 'registerShortcut') return (key: string, value: any) => { g.shortcuts.push({ key, ...value }); return target.registerShortcut(key, value); };
    if (key === 'registerCommand') return (name: string, value: any) => {
      if (name === 'zerg') handler = g.handler = value.handler; return target.registerCommand(name, value);
    };
    if (key === 'on') return (name: string, callback: any) => target.on(name, (event: any, context: any) => callback(event, g.witnessedContext(context)));
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const restart = process.env.STAGE9_PHASE === 'restart', reloaded = !restart && g.id > 1;
  registration = g.registration = zerg.registerZergSwarmExtension(proxy, { persistence: { enabled: true,
    snapshotFile: restart ? recoveredSnapshot : snapshot }, recovery: { enabled: restart }, coding: example.coding });
  if (config.mode !== 'sdk') {
    pi.registerShortcut('alt+k', { description: 'Stage9 genuine collision owner', handler: () => put('collision-fired.json', { ok: true }) });
    pi.registerCommand('s9modal', { description: 'Disposable modal probe', handler: async (_a: any, c: any) => {
      put('modal-open.json', { opens }); await c.ui.confirm('S9 modal probe', 'Escape closes; no execution authority'); put('modal-closed.json', { opens });
    } });
    pi.registerCommand('s9probe', { description: 'Read-only disposable evidence', handler: async () => { observe(); put('probe.json', { opens, closes }); } });
  }
  pi.on('session_shutdown', () => { g.shutdown = true; observe(); });
  let started = false;
  pi.on('session_start', (_event: any, context: any) => {
    if (started) return; started = true; ctx = context;
    if (config.mode !== 'sdk') {
      assert.equal(ctx.mode, 'tui');
      ctx.ui.setWidget('stage9.companion', ['S9 companion widget'], { placement: 'belowEditor' });
      ctx.ui.setStatus('stage9.companion', 'S9 companion status');
    } else assert.notEqual(ctx.mode, 'tui');
    setTimeout(() => void (async () => {
      if (config.mode !== 'sdk') await until(() => g.catalogs.length > 0, 'actual main editor shortcut catalog captured');
      if (!reloaded) await verifiedStage(restart ? 'restart-startup' : 'startup');
      if (restart) await recovered(); else if (reloaded) await afterReload(); else { await journey(); return; }
      registration.dispose();
      if (restart) await bounded(assert.rejects(registration.control.drain(), /Native cleanup settlement is uncertain/), 'actual uncertain recovered drain');
      else await bounded(registration.control.drain(), 'actual owner drain');
      await verifiedStage(restart ? 'restart-completion' : 'completion');
      observe(); put('phase-finished.json', { phase: restart ? 'restart' : 'live', assertions: [...assertions] });
      ctx.shutdown();
    })().catch(error => {
      put('failure.json', { error: String(error.stack ?? error).slice(-16000) });
      try { registration.dispose(); } finally { ctx.shutdown(); }
    }), 0);
  });
}
export async function runSDK() {
  const settings = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off', packages: [], enableInstallTelemetry: false });
  const modelRuntime = await bounded(sdk.ModelRuntime.create({ authPath: join(root, 'agent/auth.json'), modelsPath: join(root, 'agent/models.json'), refreshOnCreate: false, allowModelNetwork: false }), 'model runtime startup');
  const model = modelRuntime.getModel('fixture', 'solo'); assert(model);
  // Genuine mode binding with countertraps. A UI call/component/preferences
  // factory in any actual non-TUI mode is an error, never a synthetic success.
  const counts: any = { methods: 0, factories: 0, inputs: 0, widgets: 0, preferences: 0, shortcuts: 0 };
  for (const mode of ['print', 'rpc', 'json']) {
    const g: any = { id: 'nonTui-' + mode, factories: 0, preferences: 0, managementFactories: 0 };
    shared.current = g;
    const ui = new Proxy({}, { get(_target, key) { return () => { counts.methods++; if (key === 'setWidget') counts.widgets++;
      if (key === 'onTerminalInput') counts.inputs++; throw Error('NonTUI UI method called: ' + String(key)); }; } });
    let control: any;
    const loader = new sdk.DefaultResourceLoader({ cwd: join(root, 'work'), agentDir: join(root, 'agent'), settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi: any) => { const proxy = new Proxy(pi, { get(target, key) {
        if (key === 'registerShortcut') return () => { counts.shortcuts++; throw Error('NonTUI shortcut registration'); };
        const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
      } }); control = zerg.registerZergSwarmExtension(proxy, { persistence: { enabled: false } }); }] });
    await bounded(loader.reload(), 'nonTUI resources startup');
    const { session } = await bounded(sdk.createAgentSession({ cwd: join(root, 'work'), agentDir: join(root, 'agent'), model, modelRuntime,
      tools: [], noTools: true, resourceLoader: loader, settingsManager: settings, thinkingLevel: 'off', sessionManager: sdk.SessionManager.inMemory(join(root, 'work')) }), 'actual main session startup');
    const before = requests();
    try { await bounded(session.bindExtensions({ mode, uiContext: ui, shutdownHandler() {} }), 'nonTUI actual binding');
      assert.equal(requests(), before); assert.equal(native.length, 0);
      assert.equal(control.control.getState().extensions.workflows, undefined, 'NonTUI binding initialized execution authority');
      counts.factories += g.factories + g.managementFactories; counts.preferences += g.preferences;
      assert(!existsSync(join(root, 'agent/zerg-swarm/ui.json'))); control.dispose(); await bounded(control.control.drain(), 'nonTUI actual drain');
    } finally { session.dispose(); }
  }
  assert.deepEqual(counts, { methods: 0, factories: 0, inputs: 0, widgets: 0, preferences: 0, shortcuts: 0 });
  put('non-tui.json', { modes: ['print', 'rpc', 'json'], counts, noPreferencesFile: true, requests: requests() });
  prove('non-tui-zero-ui'); shared.mainSession = undefined;
  const resources = new sdk.DefaultResourceLoader({ cwd: join(root, 'work'), agentDir: join(root, 'agent'),
    settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [stage9HostFixture] });
  await bounded(resources.reload(), 'main resources startup');
  const { session } = await bounded(sdk.createAgentSession({ cwd: join(root, 'work'), agentDir: join(root, 'agent'), model, modelRuntime,
    tools: [], noTools: true, resourceLoader: resources, settingsManager: settings,
    thinkingLevel: 'off', sessionManager: sdk.SessionManager.inMemory(join(root, 'work')) }), 'actual main session startup');
  try {
    await bounded(session.bindExtensions({ mode: 'print', shutdownHandler() {} }), 'actual main binding');
    if (process.env.STAGE9_PHASE !== 'restart') {
      await sdkStagesThrough('reload-ready');
      if (existsSync(join(root, 'evidence/failure.json'))) throw Error(JSON.stringify(read('failure.json')));
      await bounded(session.reload(), 'public same-process SDK reload'); // Public API: retires old owner, no invented reconnection.
    }
    const phase = process.env.STAGE9_PHASE === 'restart' ? 'restart' : 'live';
    await sdkStagesThrough(phase === 'restart' ? 'restart-completion' : 'completion');
    await until(() => existsSync(join(root, 'evidence/phase-finished.json')) && read('phase-finished.json').phase === phase, 'verified final evidence');
    if (existsSync(join(root, 'evidence/failure.json'))) throw Error(JSON.stringify(read('failure.json')));
  } finally { await bounded(session.abort(), 'actual main session abort'); session.dispose(); }
}
