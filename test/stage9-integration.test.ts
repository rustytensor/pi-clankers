import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// No heavy fixture imports, SDK loads, sockets or live child processes before this gate.
// Author-only tests below evaluate extracted pure protocol code, never Pi/driver modules.
// A skip is NOT acceptance. These candidates are AUTHOR-ONLY until parent review.
const approved = process.env.ZERG_BACKGROUND_ACTIVITY_ACCEPTANCE === 'parent-approved';
const required = (key: string) => {
  const value = process.env[key]; assert(value, `Explicit ${key} required; no checkout/host fallback`); return value;
};
export const REQUIRED_ACTIVITY_ASSERTIONS = [
  'standalone-live', 'team-queued', 'leader-actual-only', 'workflow-mixed',
  'exact-dedup', 'reused-inert', 'recovered-inert', 'observer-no-authority',
  'pause', 'approval', 'cancel-cleanup', 'failure', 'completion',
  'dynamic-total-unknown', 'reload', 'reload-old-resources-retired',
] as const;
export const REQUIRED_HOST_ASSERTIONS = [
  'unsubmitted-multiline-draft', 'paste-no-open', 'modal-no-steal',
  'active-shortcut-shared-config', 'no-duplicate-overlay', 'close-without-cancel',
  'draft-focus-continuity', 'alternate-alt-j', 'real-conflict-rejected',
  'ctrl-i-rejected', 'desired-versus-active', 'reload', 'fresh-restart',
  'command-shortcut-component-latch', 'reload-draft-focus', 'footer-widget-coexistence', 'wide-narrow-wide', 'short-resize',
] as const;
for (const mode of ['sdk', 'regular', 'fullscreen'] as const) {
  test(`Stage 9 actual isolated ${mode}`, {
    skip: approved ? false : 'requires reviewed closure + ZERG_BACKGROUND_ACTIVITY_ACCEPTANCE=parent-approved; NOT acceptance passed',
    timeout: 200_000,
  }, async () => {
    // Runtime roots are explicit capabilities supplied ONLY by the reviewing parent.
    const candidate = required('ZERG_BACKGROUND_ACTIVITY_CANDIDATE_ROOT');
    const manifest = required('ZERG_BACKGROUND_ACTIVITY_MANIFEST');
    const sdk = required('ZERG_BACKGROUND_ACTIVITY_SDK_ROOT');
    const host = required('ZERG_BACKGROUND_ACTIVITY_HOST_ROOT');
    const guards = required('ZERG_BACKGROUND_ACTIVITY_GUARDS_ROOT');
    const safety = await import(new URL('file://' + guards + '/host-fixture-safety.mjs').href);
    const root = mkdtempSync('/tmp/zerg-stage9-' + mode + '-');
    safety.assertAncestorIsolation(root);
    mkdirSync(join(root, 'work')); mkdirSync(join(root, 'evidence'));
    const st = lstatSync(root);
    writeFileSync(join(root, 'evidence/parent-approval.json'), JSON.stringify({
      guard: 'parent-approved', root, uid: st.uid, dev: st.dev, ino: st.ino,
    }), { flag: 'wx', mode: 0o600 });
    const driver = fileURLToPath(new URL('./fixtures/stage9-activity-sdk-acceptance.mjs', import.meta.url));
    const controller = fileURLToPath(new URL('./fixtures/stage9-activity-host-pty.py', import.meta.url));
    const child = safety.spawnOwnedController('/usr/bin/python3', [controller, root, '--driver',
      process.execPath, '--max-old-space-size=512', driver, root, mode, candidate, manifest, sdk, host, guards], root, 180_000);
    const chunks: Buffer[] = []; let bytes = 0;
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk: Buffer) => {
      bytes += chunk.length; if (bytes <= 65_536) chunks.push(chunk);
    });
    const read = (path: string) => JSON.parse(readFileSync(join(root, path), 'utf8'));
    try {
      await child.fixtureClosed; await safety.settleOwnedController(child);
      const log = Buffer.concat(chunks).toString();
      writeFileSync(join(root, 'evidence/test.log'), log);
      assert.equal(child.exitCode, 0, `Retained evidence: ${root}\n${log}`);
      assert.equal(read('supervisor-result.json').ok, true);
      assert.deepEqual(read('supervisor-result.json').remaining, []);
      const result = read('evidence/result.json');
      assert.equal(result.ok, true);
      for (const name of REQUIRED_ACTIVITY_ASSERTIONS) assert(result.assertions.includes(name), `Uncovered actual assertion: ${name}`);
      if (mode === 'sdk') assert(result.assertions.includes('non-tui-zero-ui'));
      if (mode !== 'sdk') for (const name of REQUIRED_HOST_ASSERTIONS) assert(result.assertions.includes(name), `Uncovered actual PTY assertion: ${name}`);
      assert.equal(read('evidence/pty-result.json').ok, true);
      assert.deepEqual(read('evidence/pty-result.json').remaining, []);
      assert.deepEqual(read('evidence/socket-cleanup.json'), { listening: false, sockets: 0, responses: 0 });
      assert(bytes <= 65_536);
      console.log(`${mode}: ${root}/evidence; terminal recording is NOT human visual acceptance`);
    } finally { await safety.settleOwnedController(child); }
  });
}


// These tests are deliberately independent of the live acceptance gate. No Pi,
// Jiti, guard, provider, terminal controller or SDK source is imported/evaluated.
// The pure UI test imports TUI components and extracts local UI declarations only.
const authorSource = (name: string) => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');
test('Stage 9 author-only protocol: Python ordered positive/negative fake clocks', async () => {
  const { spawnSync } = await import('node:child_process');
  const source = authorSource('stage9-activity-host-pty.py');
  const script = `import ast, hashlib, json
source = ${JSON.stringify('PLACEHOLDER')}
tree = ast.parse(source)
names = {'STAGE9_PLAN', 'STAGE9_RECORD_BYTES', 'STAGE9_TOTAL_BYTES'}
nodes = [n for n in tree.body if (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in names for t in n.targets)) or (isinstance(n, ast.ClassDef) and n.name == 'StageProgress')]
assert len(nodes) == 4
exec(compile(ast.Module(body=nodes, type_ignores=[]), '<pure-protocol>', 'exec'))
assert len(STAGE9_PLAN) == 20 and STAGE9_RECORD_BYTES == 512 and STAGE9_TOTAL_BYTES == 21504
expected = {
 'stat': '17cc1bf1994692fd86109536f3d333eaa2b00322c3d3aac9e9e151c6c26ab8c8',
 'owned': '0fe1b370bdfe7622df16f5f3654eebafd9241e3ea294e5184bf519c024dce527',
 'send': '448ed445de81cf30e49ccf272f05aaf6f88bf1c702891cb347d4ec5160fc1494',
 'reap': '24edc4170a0443b53eb660c0bb4e9e8c6a4aafb8acef6a468d6c2351b0a920f2',
 'stop': '8ab57f79e171903747420952416e94f2b87cb75d36c6698de4ec154349798919',
}
# Keep the pinned representation independent of ast.dump display changes:
# Python 3.15 omits Load() contexts; the original hashes include them.
def ownership_dump(value):
 if isinstance(value, ast.AST):
  fields = [name + '=' + ownership_dump(item) for name, item in ast.iter_fields(value)
            if item != [] and not (item is None and getattr(type(value), name, ...) is None)]
  return type(value).__name__ + '(' + ', '.join(fields) + ')'
 if isinstance(value, list): return '[' + ', '.join(map(ownership_dump, value)) + ']'
 return repr(value)
for name, digest in expected.items():
 node = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == name)
 assert hashlib.sha256(ownership_dump(node).encode()).hexdigest() == digest
now, rows, acks = [0.0], {}, {}
def fresh():
 now[0] = 0.0; rows.clear(); acks.clear()
 def write(seq, row):
  assert seq not in acks
  acks[seq] = row.copy()
 return StageProgress(0.0, lambda: now[0], lambda: rows.copy(), write)
def advance(p, seconds=2):
 now[0] += seconds; rows[p.index + 1] = p.expected(); p.tick()
def rejected(action):
 try: action()
 except (AssertionError, Exception): return
 raise AssertionError('negative case falsely accepted')
p = fresh()
for _ in STAGE9_PLAN: advance(p)
assert now[0] == 40 and p.index == 20 and len(acks) == 20
# Regression RED: the original aggregate whole-live watchdog expires at20.
assert now[0] > 20 and p.start == 0 and p.end <= 140
cases = 1
# Inactivity/heartbeat and same-state progress never renew hard deadline.
p = fresh(); now[0] = 19; p.tick(); assert p.end == 20
now[0] = 20; rejected(p.tick); cases += 1
p = fresh(); advance(p); end = p.end; now[0] = end - .1; p.tick(); assert p.end == end
now[0] = end; rejected(p.tick); cases += 1
for field, value in [('phase', 'restart'), ('generation', 2), ('seq', 2), ('state', 'team'), ('version', True), ('generation', True), ('seq', True)]:
 p = fresh(); row = p.expected(); row[field] = value; rows[1] = row
 rejected(p.tick); cases += 1
for row in [None, [], {}, {'extra': 1}]:
 p = fresh(); rows[1] = row
 if row is None:
  # A missing/partial record cannot advance; fixed deadline still rejects.
  p.tick(); assert p.index == 0; now[0] = 20
 rejected(p.tick); cases += 1
p = fresh(); rows[2] = p.expected(); rejected(p.tick); cases += 1
p = fresh(); advance(p); rows[1]['state'] = 'team'; rejected(p.tick); cases += 1
p = fresh(); advance(p); del rows[1]; rejected(p.tick); cases += 1
p = fresh()
for _ in range(17): advance(p, 8)
assert p.index == 17 and now[0] == 136 and p.end == 140
now[0] = 140; rows[18] = p.expected(); rejected(p.tick); cases += 1
print(json.dumps({'ok': True, 'cases': cases, 'journeySeconds': 40, 'states': len(STAGE9_PLAN), 'ownershipASTs': len(expected)}))
`.replace(JSON.stringify('PLACEHOLDER'), JSON.stringify(source));
  const result = spawnSync('/usr/bin/python3', ['-B', '-c', script], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  assert.equal(result.status, 0, result.stderr); const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true); assert.equal(report.cases, 18); assert.equal(report.ownershipASTs, 5);
});

test('Stage 9 author-only protocol: SDK ordered stage promises and exact ack validator', async () => {
  const ts = await import('typescript'); const vm = await import('node:vm');
  const source = authorSource('stage9-activity-host-fixture.ts');
  const ast = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
  assert.equal((ast as any).parseDiagnostics.length, 0);
  const names = ['protocolRow', 'validProtocolRow', 'deadlineError', 'bounded', 'sdkStagesThrough'];
  const code = ast.statements.filter((node: any) => ts.isVariableStatement(node) && node.declarationList.declarations.some((d: any) => d.name.getText(ast) === 'STAGE9_PLAN')
    || ts.isFunctionDeclaration(node) && names.includes(node.name!.text)).map(n => n.getText(ast)).join('\n');
  let now = 0; const timers: Array<{ callback: () => void; delay: number }> = [];
  const progress: any = { index: 0, end: 20, sdkIndex: 0, completed: Array.from({ length: 20 }, () => {
    let resolve: any; const promise = new Promise(r => { resolve = r; }); return { promise, resolve };
  }) };
  const context = vm.createContext({ progress, budget: { start: 0, deadline: 140 }, monotonic: () => now, assert,
    setTimeout: (callback: () => void, delay: number) => { const t = { callback, delay }; timers.push(t); return t; },
    clearTimeout: (timer: any) => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
    existsSync: () => false, join: (...parts: string[]) => parts.join('/'), root: '/fake-owned-root',
  });
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  const row = context.protocolRow(0);
  assert.equal(context.validProtocolRow(row, row), true);
  for (const bad of [null, [], { ...row, extra: 1 }, { ...row, generation: 2 }, { ...row, phase: 'restart' },
    { ...row, seq: 2 }, { ...row, seq: true }, { ...row, state: 'team' }, { ...row, version: '1' }]) {
    assert(!context.validProtocolRow(bad, row));
  }
  const drive = async (last: string, count: number) => {
    const pending = context.sdkStagesThrough(last);
    for (let n = 0; n < count; n++) {
      now += 2; progress.completed[progress.index].resolve(); progress.index++; progress.end = Math.min(140, now + 20);
      for (let i = 0; i < 8; i++) await Promise.resolve();
    }
    await pending;
  };
  await drive('reload-ready', 13); assert.equal(now, 26); // exceeds old readiness aggregate20
  await drive('completion', 4);
  await drive('restart-completion', 3); assert.equal(now, 40); assert.equal(progress.sdkIndex, 20);
  // A never-settling actual stage/operation keeps its hard watchdog (not unbounded await).
  progress.end = 60; const hung = context.bounded(new Promise(() => {}), 'fake hung startup');
  const rejected = assert.rejects(hung, /Stage9 deadline/); assert.equal(timers.at(-1)!.delay, 20000);
  now = 60; timers.at(-1)!.callback(); await rejected;
  // Remaining overall time also caps an individual startup/control/drain await.
  now = 139; progress.end = 159;
  const overall = context.bounded(new Promise(() => {}), 'fake drain at overall cap');
  const failed = assert.rejects(overall, /Stage9 deadline/); assert.equal(timers.at(-1)!.delay, 1000);
  now = 140; timers.at(-1)!.callback(); await failed;
});

test('Stage 9 author-only protocol: immutable driver and exact ceilings/static barriers', async () => {
  const { createHash } = await import('node:crypto');
  const driver = authorSource('stage9-activity-sdk-acceptance.mjs');
  assert.equal(createHash('sha256').update(driver).digest('hex'), '630d3b3fd8a508b87046537a344e76fe5a3f83128936b62d9a1b098a74c8e2d2');
  const fixture = authorSource('stage9-activity-host-fixture.ts'), controller = authorSource('stage9-activity-host-pty.py');
  for (const literal of ['maxRequests: 32', 'maxRequestBytes: 262144', 'maxOutputBytes: 1048576', 'timeoutMs: 165000',
    'responseBytes <= 131072', '2e9ea3e178365b12af84ba2ae2ee191d5b28609546af7746641f06a8ab8e354a',
    'Exact scoped tool set; no shell/delegation/MCP/approval authority']) assert(driver.includes(literal));
  for (const literal of ['timeout=165', 'start + 140', 'time.monotonic() + 20', 'len(raw) <= 1024 * 1024',
    'len(result) <= 64', 'len(threads) <= 128', 'count <= 42', 'STAGE9_RECORD_BYTES = 512', 'STAGE9_TOTAL_BYTES = 21504']) assert(controller.includes(literal));
  for (const literal of ['Date.now() + 20000', "await sdkStagesThrough('reload-ready')", "phase === 'restart' ? 'restart-completion' : 'completion'",
    "rows.length === 3 && ['solo', 'w0', 'workflow']", "Only exact sealed disposable workflow tools; no other tools or delegation.', tools: ['read']",
    "await bounded(session.reload(),", "await bounded(registration.control.drain(),", "await bounded(control.control.drain(),"]) assert(fixture.includes(literal), literal);
  assert(!fixture.includes("'same-process SDK reload readiness'")); assert(!fixture.includes("'SDK journey'"));
  assert(!controller.includes("'fixture phase completed'"));
});


// Pure fake metadata/receivers only: evaluate the EXACT actual prompt hook,
// render witness and window blocks. Never import SDK/Pi or acceptance modules.
async function observerHarness() {
  const ts = await import('typescript'), vm = await import('node:vm');
  const source = authorSource('stage9-activity-host-fixture.ts');
  const ast = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true);
  assert.equal((ast as any).parseDiagnostics.length, 0);
  const nodes: any[] = [];
  const visit = (node: any) => { nodes.push(node); ts.forEachChild(node, visit); }; visit(ast);
  const exact = (predicate: (n: any) => boolean) => {
    const matches = nodes.filter(predicate); assert.equal(matches.length, 1); return matches[0].getText(ast);
  };
  const snapshot = exact(n => ts.isVariableStatement(n) && n.declarationList.declarations.some((d: any) => d.name.getText(ast) === 'initiationSnapshot'));
  const init = exact(n => ts.isExpressionStatement(n) && n.getText(ast).startsWith('shared.promptCalls ??='));
  const hook = exact(n => ts.isExpressionStatement(n) && n.getText(ast).startsWith('proto.prompt = function'));
  const prologue = ['proto', 'prompt', 'records'].map(name => exact(n => ts.isVariableStatement(n)
    && n.declarationList.declarations[0].name.getText(ast) === name
    && (name !== 'proto' || n.declarationList.declarations[0].initializer?.getText(ast) === 'host.AgentSession.prototype'))).join('\n');
  const functions = ['stateHash', 'witnessComponent'].map(name => exact(n => ts.isFunctionDeclaration(n) && n.name?.text === name)).join('\n');
  const windows = nodes.filter(n => ts.isTryStatement(n) && n.finallyBlock?.getText(ast) === '{ stableObserverWindow = false; }');
  assert.equal(windows.length, 2);
  const fake: any = { state: { readonly: true }, http: 3, native: [], shared: { current: { id: 1 } }, forwards: [], renders: [], sleeps: [],
    onSleep() {}, onCheckpoint() {}, onStage() {}, renderEffect() {} };
  const subscriptions = new WeakMap<object, any>();
  class Session {
    sessionId = 'fake-metadata-only'; model = { id: 'fake' };
    subscribe(callback: any) { subscriptions.set(this, callback); return () => {}; }
    prompt(...args: any[]) { fake.forwards.push({ receiver: this, args, counterAtEntry: fake.shared.promptCalls });
      if (fake.thrown) throw fake.thrown; return fake.result; }
    dispose() {}
  }
  const context = vm.createContext({ assert, shared: fake.shared, native: fake.native, host: { AgentSession: Session },
    registration: { control: { getState: () => fake.state } }, hash: (value: any) => JSON.stringify(value),
    requests: () => fake.http, performance: { now: () => 0 },
    tui: { visibleWidth: (line: string) => line.length, stripTerminalSequences: (line: string) => line },
    ctx: undefined, generation: { snapshots: 4, renders: 0, renderMs: 0 }, frameCount: 0, frames: [], latestLines: '', handle: undefined,
    observe() {}, put() {}, prove() {}, config: { mode: 'regular' }, solo: { runId: 'fake' }, team: { runId: 'fake' }, workflowRunId: 'fake', serialNative: () => [],
    sleep: async (ms: number) => { fake.sleeps.push(ms); await Promise.resolve(); context.generation.renders++; fake.onSleep(ms); },
    uiCheckpoint: async () => { await Promise.resolve(); fake.onCheckpoint(); },
    verifiedStage: async () => { await Promise.resolve(); fake.onStage(); },
  });
  const run = (code: string) => vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context, { timeout: 1000 });
  run(init + '\n' + snapshot + '\n' + functions + '\n' + prologue + '\n' + hook);
  context.generation.registration = context.registration;
  context.stableObserverWindow = false;
  const receiver = { render(...args: any[]) { fake.renders.push({ receiver: this, args }); fake.renderEffect(); return fake.lines; } };
  fake.lines = ['pure'];
  const widget = context.witnessComponent(receiver, 'widget'); context.widget = widget;
  const window = (index: number) => run('stableObserverWindow = true; (async () => { ' + windows[index].getText(ast) + ' })()');
  return { fake, context, Session, subscriptions, receiver, widget, window, snapshot: () => run('initiationSnapshot()'), reloadInit: () => run(init) };
}

test('Stage 9 author-only causal render: HTTP outside/inside held window, exact forward', { timeout: 5000 }, async () => {
  for (const kind of ['widget', 'management']) {
    const h = await observerHarness(), { fake, context, receiver } = h;
    const component = context.witnessComponent(receiver, kind);
    const marker = {};
    fake.renderEffect = () => { fake.http++; };
    assert.equal(component.render(240, marker), fake.lines); // Prior transport admission is NOT initiation.
    assert.equal(fake.renders.length, 1); assert.equal(fake.renders[0].receiver, receiver);
    assert.deepEqual(fake.renders[0].args, [240, marker]);
    context.stableObserverWindow = true;
    assert.throws(() => component.render(240), /Rendering initiated provider work/);
    assert.equal(fake.renders.length, 2);
  }
});

test('Stage 9 author-only causal render: genuine prompt/start/session and state deltas fail', { timeout: 5000 }, async () => {
  for (const kind of ['widget', 'management']) for (const delta of ['prompt', 'start', 'session', 'state']) {
    const h = await observerHarness(), { fake, context, Session, subscriptions, receiver } = h;
    const worker = new Session(); worker.prompt('seed'); // Creates evidence via the actual extracted hook.
    fake.shared.mainSession = new Session();
    fake.renderEffect = () => {
      if (delta === 'prompt') fake.shared.mainSession.prompt('main-entry');
      if (delta === 'start') subscriptions.get(worker)({ type: 'agent_start' });
      if (delta === 'session') fake.native.push({ starts: 0 }); // Evidence-array dimension, not an acceptance DTO.
      if (delta === 'state') fake.state.readonly = false;
    };
    assert.throws(() => context.witnessComponent(receiver, kind).render(240),
      delta === 'state' ? /Rendering changed execution authority\/state/ : /Rendering initiated genuine SDK work/);
    assert.equal(fake.http, 3); assert.equal(fake.renders.length, 1);
  }
});

test('Stage 9 author-only prompt entry: main/repeated/rejected, original args/result once, reload cumulative', { timeout: 5000 }, async () => {
  const h = await observerHarness(), { fake, Session, subscriptions } = h;
  const main = new Session(), worker = new Session(); fake.shared.mainSession = main;
  const args = ['text', { streamingBehavior: 'steer' }, {}];
  const result = {}; fake.result = result;
  assert.equal(main.prompt(...args), result); assert.equal(fake.native.length, 0);
  assert.equal(worker.prompt(...args), result); assert.equal(worker.prompt(...args), result);
  assert.equal(fake.native.length, 1);
  const error = Error('original rejected promise'); fake.result = Promise.reject(error);
  const rejected = worker.prompt(...args); assert.equal(rejected, fake.result);
  await assert.rejects(rejected, e => e === error);
  fake.result = Promise.resolve(result); const asyncResult = main.prompt(...args);
  assert.equal(asyncResult, fake.result); assert.equal(await asyncResult, result);
  assert.equal(fake.shared.promptCalls, 5); assert.equal(fake.forwards.length, 5);
  for (let i = 0; i < fake.forwards.length; i++) {
    const row = fake.forwards[i]; assert.equal(row.counterAtEntry, i + 1);
    assert.equal(row.receiver, i === 0 || i === 4 ? main : worker);
    for (let n = 0; n < args.length; n++) assert.equal(row.args[n], args[n]);
  }
  // Synchronous rejection and rejected main-session calls are entries too.
  fake.thrown = error; assert.throws(() => worker.prompt(...args), e => e === error);
  fake.thrown = undefined; fake.result = Promise.reject(error);
  const mainRejected = main.prompt(...args); assert.equal(mainRejected, fake.result);
  await assert.rejects(mainRejected, e => e === error);
  assert.equal(fake.shared.promptCalls, 7); assert.equal(fake.forwards.length, 7);
  for (const row of fake.forwards.slice(5)) for (let n = 0; n < args.length; n++) assert.equal(row.args[n], args[n]);
  assert.equal(fake.forwards[5].receiver, worker); assert.equal(fake.forwards[5].counterAtEntry, 6);
  assert.equal(fake.forwards[6].receiver, main); assert.equal(fake.forwards[6].counterAtEntry, 7);
  subscriptions.get(worker)({ type: 'agent_start' });
  h.reloadInit(); assert.equal(fake.shared.promptCalls, 7); assert.equal(fake.native[0].starts, 1);
  fake.result = result; worker.prompt(...args); assert.equal(fake.shared.promptCalls, 8); assert.equal(fake.native.length, 1);
});

test('Stage 9 author-only explicit UI commands: exact main hook entries, no worker/state/HTTP delta', { timeout: 5000 }, async () => {
  const h = await observerHarness(), { fake, Session, subscriptions, context } = h;
  for (let i = 0; i < 3; i++) {
    const worker = new Session(); worker.prompt('seed'); subscriptions.get(worker)({ type: 'agent_start' });
  }
  const main = new Session(); fake.shared.mainSession = main;
  const before = JSON.stringify(fake.state), result = {}; fake.result = result;
  assert.equal(JSON.stringify(h.snapshot()), JSON.stringify({ prompts: 3, starts: 3, sessions: 3 }));
  fake.onCheckpoint = () => {
    for (const command of ['/zerg config', '/s9modal']) assert.equal(main.prompt(command), result);
    // Still render through the actual witness after intentional main entries.
    context.witnessComponent(h.receiver, 'management').render(240);
  };
  await h.window(0);
  assert.deepEqual(fake.forwards.slice(3).map((row: any) => row.args), [['/zerg config'], ['/s9modal']]);
  for (let i = 3; i < 5; i++) {
    assert.equal(fake.forwards[i].receiver, main); assert.equal(fake.forwards[i].counterAtEntry, i + 1);
  }
  assert.equal(JSON.stringify(h.snapshot()), JSON.stringify({ prompts: 5, starts: 3, sessions: 3 }));
  assert.equal(JSON.stringify(fake.state), before); assert.equal(fake.http, 3);
  assert.deepEqual(fake.sleeps, [100, 1100]); assert.equal(context.stableObserverWindow, false);
});

test('Stage 9 author-only exact stable windows: async invariance, every delta fails, finally clears', { timeout: 5000 }, async () => {
  for (const index of [0, 1]) {
    const positive = await observerHarness(); await positive.window(index);
    assert.deepEqual(positive.fake.sleeps, index === 0 ? [100, 1100] : [100]);
    assert.equal(positive.fake.renders.length, index === 0 ? 100 : 20);
    assert.equal(positive.context.stableObserverWindow, false);
    for (const delta of ['prompt', 'start', 'session', 'state', 'http', 'render-http', ...(index === 0 ? ['late-start', 'late-session', 'late-state', 'late-http', 'ack-start', 'ack-session', 'ack-state', 'ack-http', 'pull', 'timer'] : [])]) {
      const h = await observerHarness(), { fake, Session, subscriptions, context } = h;
      const worker = new Session(); worker.prompt('seed'); fake.shared.mainSession = new Session();
      fake.onSleep = () => {
        if (delta === 'prompt') fake.shared.mainSession.prompt('async-entry');
        if (delta === 'start') subscriptions.get(worker)({ type: 'agent_start' });
        if (delta === 'session') fake.native.push({ starts: 0 });
        if (delta === 'state') fake.state.readonly = false;
        if (delta === 'http') fake.http++;
        if (delta === 'pull') context.generation.snapshots++;
        if (delta === 'timer') context.generation.renders = 0;
      };
      if (delta === 'render-http') fake.renderEffect = () => { fake.http++; };
      const uiDelta = () => {
        if (delta.endsWith('-start')) subscriptions.get(worker)({ type: 'agent_start' });
        if (delta.endsWith('-session')) new Session().prompt('unexpected-worker-entry');
        if (delta.endsWith('-state')) fake.state.readonly = false;
        if (delta.endsWith('-http')) fake.http++;
      };
      if (delta.startsWith('late-')) fake.onCheckpoint = uiDelta;
      if (delta.startsWith('ack-')) fake.onStage = uiDelta;
      await assert.rejects(h.window(index), /^(late|ack)-(start|session)$/.test(delta)
        ? /UI window initiated genuine SDK worker work/ : delta === 'prompt' || delta === 'start' || delta === 'session'
          ? /Observer window initiated genuine SDK work/ : delta === 'render-http' ? /Rendering initiated provider work/ : /AssertionError/);
      assert.equal(context.stableObserverWindow, false, 'Flag cleared even on failure, before resume/release/grant');
    }
  }
});


test('Stage 9 author-only observer: exact window placement, limitations and reviewed controller', { timeout: 5000 }, async () => {
  const { createHash } = await import('node:crypto');
  const source = authorSource('stage9-activity-host-fixture.ts');
  assert.equal(createHash('sha256').update(authorSource('stage9-activity-host-pty.py')).digest('hex'),
    '1e99a2e0f0a07a7661b05a584da77ebfca181987741493dd98d5c000f0d06b8a');
  assert.equal(source.match(/shared\.promptCalls\+\+/g)?.length, 1);
  assert(source.indexOf('shared.promptCalls++;') < source.indexOf('if (this === shared.mainSession)'));
  assert(source.includes('initiation: initiationSnapshot()'));
  assert(source.includes("if (stableObserverWindow) assert.equal(requests(), requestBefore, 'Rendering initiated provider work');"));
  const first = source.indexOf('stableObserverWindow = true;'), last = source.lastIndexOf('stableObserverWindow = true;');
  const clear = 'finally { stableObserverWindow = false; }';
  assert(source.indexOf('rows.length === 3') < source.indexOf("action: 'workflows.pause'"));
  assert(source.indexOf("action: 'workflows.pause'") < first);
  assert(source.indexOf(clear, first) < source.indexOf("action: 'workflows.resume'"));
  assert(source.indexOf(clear, first) < source.indexOf("release(['w0'])"));
  assert(source.indexOf("await until(() => pending(kind)") < last);
  assert(source.indexOf(clear, last) < source.indexOf('workflowApprovals.grantFingerprint'));
  assert(source.includes("limitations: ['isolated dummy-loopback executed; no external-provider or model-quality acceptance', 'no OS sandbox', 'no human visual claim',\n      'restored genuine in-flight checkpoint after natural cleanup, not a crash']"));
  assert(source.startsWith('// Actual isolated Pi extension/SDK fixture. No injected native transport or\n// invented live DTOs. AUTHOR-ONLY; actual journeys require a fresh execution grant.'));
  const wrapper = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert(wrapper.includes('timeout: 200_000')); assert(wrapper.includes('root, 180_000)'));
});

// AST-only guard of the real controller's input sequence; no editor/host is mocked or run.
test('Stage 9 author-only editor clear: documented kills, no double interrupt, exact drafts/commands', async () => {
  const { spawnSync } = await import('node:child_process');
  const script = `import ast, json
source = ${JSON.stringify(authorSource('stage9-activity-host-pty.py'))}
tree = ast.parse(source)
functions = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
def calls(node, name):
 return [n for n in ast.walk(node) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == name]
clear = functions['clear_draft']
assert len(clear.body) == 2
assert ast.literal_eval(calls(clear, 'key')[0].args[0]) == bytes([5, 21, 21, 21])
assert ast.literal_eval(calls(clear, 'draft')[0].args[0]) == ''
assert len(calls(tree, 'clear_draft')) == 6
assert not any(isinstance(n, ast.Constant) and isinstance(n.value, bytes) and 3 in n.value for n in ast.walk(tree)), 'Ctrl+C can exit Pi'
commands = [ast.literal_eval(n.args[0]) for n in calls(tree, 'key') if isinstance(n.args[0], ast.Constant) and isinstance(n.args[0].value, bytes) and n.args[0].value.startswith(b'/')]
assert commands == [b'/zerg config\\r', b'/s9modal\\r', b'/reload\\r']
for name, value, drafts in [
 ('live_ui', 'S9 DRAFT 一\\nsecond line', ['value', 'value', 'value', "value + 'Z'", 'value', 'value']),
 ('reload_ui', 'S9 RELOAD DRAFT 一\\nnever submitted to model', ['value', 'value', 'value', 'value', "value + 'Z'"])
]:
 node = functions[name]
 assignment = next(n for n in node.body if isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'value' for t in n.targets))
 assert ast.literal_eval(assignment.value) == value
 assert [ast.unparse(n.args[0]) for n in calls(node, 'draft')] == drafts
 # Every intentional slash submission is still preceded by an observed empty draft.
 for i, statement in enumerate(node.body):
  if any(isinstance(n.args[0], ast.Constant) and isinstance(n.args[0].value, bytes) and n.args[0].value.startswith(b'/') for n in calls(statement, 'key')):
   assert any(calls(prior, 'clear_draft') for prior in node.body[max(0, i - 2):i])
print(json.dumps({'ok': True, 'clears': 6, 'commands': 3, 'draftAssertions': 11}))
`;
  const result = spawnSync('/usr/bin/python3', ['-B', '-c', script], { encoding: 'utf8', timeout: 5000, maxBuffer: 65536 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, clears: 6, commands: 3, draftAssertions: 11 });
});


// Publication-only IO on disposable synthetic files: no module/provider/SDK/PTY load.
// Split each write deterministically at the cross-process reader boundary.
test('Stage 9 author-only publication: exact JS publishers, old-or-new, scope and owned cleanup', { timeout: 5000 }, async () => {
  const fs = await import('node:fs'), path = await import('node:path');
  const ts = await import('typescript'), vm = await import('node:vm');
  for (const actor of ['driver', 'host']) {
    const source = authorSource(actor === 'driver' ? 'stage9-activity-sdk-acceptance.mjs' : 'stage9-activity-host-fixture.ts');
    const ast = ts.createSourceFile('publication.ts', source, ts.ScriptTarget.Latest, true);
    const names = ['evidenceStat', 'evidencePath', 'evidencePut', ...(actor === 'driver' ? ['regularPath'] : [])];
    const selected = ast.statements.filter((n: any) => ts.isFunctionDeclaration(n) && names.includes(n.name!.text)
      || ts.isVariableStatement(n) && n.declarationList.declarations.some((d: any) => ['EVIDENCE_NAMES', 'EVIDENCE_PENDING'].includes(d.name.getText(ast))));
    assert.equal(selected.length, names.length + 2);
    const root = fs.mkdtempSync('/tmp/zerg-stage9-publication-');
    const evidence = join(root, 'evidence'); fs.mkdirSync(evidence, { mode: 0o700 });
    let target = '', writes = 0, unlinks = 0, failWrite = false, failRename = false;
    const observed: any[] = [];
    const sample = () => { if (fs.existsSync(target)) observed.push(JSON.parse(fs.readFileSync(target, 'utf8'))); else observed.push(null); };
    const context = vm.createContext({ ...fs, ...path, assert, process, root,
      writeFileSync(fd: number, text: string) {
        assert.equal(typeof fd, 'number'); const st = fs.fstatSync(fd);
        assert(st.isFile() && st.nlink === 1 && st.uid === process.getuid!()); assert.equal(st.mode & 0o777, 0o600);
        const data = Buffer.from(text), split = Math.floor(data.length / 2);
        fs.writeSync(fd, data.subarray(0, split)); sample(); writes++;
        if (failWrite) throw Error('synthetic write failure');
        fs.writeSync(fd, data.subarray(split)); sample();
      },
      renameSync(from: string, to: string) { sample(); if (failRename) throw Error('synthetic rename failure'); fs.renameSync(from, to); sample(); },
      unlinkSync(file: string) { unlinks++; fs.unlinkSync(file); },
    });
    const run = (code: string) => vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context, { timeout: 1000 });
    try {
      run(selected.map(n => n.getText(ast)).join('\n').replace(/^export /gm, ''));
      const ownedNames: string[] = run('EVIDENCE_NAMES'), pendingName: string = run('EVIDENCE_PENDING');
      assert(!/^(progress|ack)-|^budget\.json$/.test(pendingName));
      target = join(evidence, ownedNames[0]); const pending = join(evidence, pendingName);
      const publish = (name: string, value: any) => actor === 'driver' ? context.evidencePut(root, name, value) : context.evidencePut(name, value);
      const old = { requests: 1, rows: [{ id: 1 }] }, next = { requests: 2, rows: [{ id: 1 }, { id: 2 }] };
      publish(ownedNames[0], old); assert.equal(observed.filter(x => x === null).length, 3);
      assert.deepEqual(observed.at(-1), old); observed.length = 0;
      const firstIdentity = fs.lstatSync(target).ino;
      publish(ownedNames[0], next);
      assert.deepEqual(observed, [old, old, old, next]); // No reader retry and no partial JSON.
      assert.notEqual(fs.lstatSync(target).ino, firstIdentity); assert(!fs.existsSync(pending)); assert.equal(unlinks, 0);
      // RED control: the old in-place publication exposes truncated JSON to this SAME reader.
      const fd = fs.openSync(target, 'w');
      try { fs.writeSync(fd, '{"requests":'); assert.throws(sample, /JSON|Unexpected/); } finally { fs.closeSync(fd); }
      // Neither the host reader nor a publication serializing malformed input masks errors.
      const cyclic: any = {}; cyclic.self = cyclic;
      const count = writes;
      assert.throws(() => publish(ownedNames[0], cyclic), /circular/i);
      assert.throws(() => publish(ownedNames[0], undefined), /AssertionError/); assert.equal(writes, count);
      if (actor === 'host') {
        const reader = ast.statements.find((n: any) => ts.isVariableStatement(n) && n.declarationList.declarations.some((d: any) => d.name.getText(ast) === 'read'))!;
        run(reader.getText(ast)); assert.throws(() => run(`read(${JSON.stringify(ownedNames[0])})`), /JSON|Unexpected/);
      }
      // Restore via the exact publisher, then inject write/rename failures: preserve OLD, delete only OWN pending.
      target = join(evidence, ownedNames[0]); fs.writeFileSync(target, JSON.stringify(old), { mode: 0o600 });
      for (const kind of ['write', 'rename']) {
        failWrite = kind === 'write'; failRename = kind === 'rename'; const before: number = unlinks;
        assert.throws(() => publish(ownedNames[0], next), /synthetic .* failure/);
        assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), old);
        assert(!fs.existsSync(pending)); assert.equal(unlinks, before + 1);
      }
      failWrite = failRename = false;
      for (const name of ['../escape.json', '/tmp/escape.json', 'progress-01.json', 'budget.json', 'live-snapshot.json', pendingName]) {
        assert.throws(() => publish(name, next), /Unowned/);
      }
      const sentinel = join(root, 'synthetic-sentinel'); fs.writeFileSync(sentinel, '{}', { flag: 'wx', mode: 0o600 });
      for (const kind of ['regular', 'symlink', 'hardlink', 'directory']) {
        if (kind === 'regular') fs.writeFileSync(pending, '{}', { flag: 'wx', mode: 0o600 });
        if (kind === 'symlink') fs.symlinkSync(sentinel, pending);
        if (kind === 'hardlink') fs.linkSync(sentinel, pending);
        if (kind === 'directory') fs.mkdirSync(pending);
        const before: number = unlinks; assert.throws(() => publish(ownedNames[0], next)); assert.equal(unlinks, before);
        assert(fs.lstatSync(pending)); // A foreign/stale pending is never adopted or removed.
        if (kind === 'directory') fs.rmdirSync(pending); else fs.unlinkSync(pending);
      }
      fs.unlinkSync(target);
      for (const kind of ['symlink', 'hardlink', 'directory']) {
        if (kind === 'symlink') fs.symlinkSync(sentinel, target);
        if (kind === 'hardlink') fs.linkSync(sentinel, target);
        if (kind === 'directory') fs.mkdirSync(target);
        assert.throws(() => publish(ownedNames[0], next)); assert(!fs.existsSync(pending));
        if (kind === 'directory') fs.rmdirSync(target); else fs.unlinkSync(target);
      }
      const moved = join(root, 'evidence-moved'); fs.renameSync(evidence, moved); fs.symlinkSync(moved, evidence);
      assert.throws(() => publish(ownedNames[0], next)); fs.unlinkSync(evidence); fs.renameSync(moved, evidence);
      fs.chmodSync(root, 0o755); assert.throws(() => publish(ownedNames[0], next)); fs.chmodSync(root, 0o700);
      const before = writes;
      publish(ownedNames[0], next); assert.equal(writes, before + 1); assert(!fs.existsSync(pending));
      assert.deepEqual(JSON.parse(fs.readFileSync(sentinel, 'utf8')), {});
    } finally {
      // Only this private synthetic tree, bounded inventory; no acceptance root touched.
      assert(fs.lstatSync(root).isDirectory() && fs.realpathSync(root) === root);
      assert(fs.readdirSync(root).length <= 4); fs.rmSync(root, { recursive: true });
    }
  }
});

test('Stage 9 author-only publication: exact Python publisher/reader, scope, parse failure and cleanup', { timeout: 5000 }, async () => {
  const { spawnSync } = await import('node:child_process');
  const script = `import ast, json, os, tempfile, shutil
source = ${JSON.stringify(authorSource('stage9-activity-host-pty.py'))}
tree = ast.parse(source)
names = {'EVIDENCE_NAMES', 'EVIDENCE_PENDING'}
functions = {'evidence_stat', 'evidence_path', 'put', 'load'}
nodes = [n for n in tree.body if (isinstance(n, ast.Assign) and any(isinstance(t, ast.Name) and t.id in names for t in n.targets)) or (isinstance(n, ast.FunctionDef) and n.name in functions)]
assert len(nodes) == 6
exec(compile(ast.Module(body=nodes, type_ignores=[]), '<pure-publication>', 'exec'))
root = tempfile.mkdtemp(prefix='zerg-stage9-publication-', dir='/tmp')
os.mkdir(root + '/evidence', 0o700)
target = root + '/evidence/ui-live.json'
pending = root + '/evidence/' + EVIDENCE_PENDING
old, new = {'requests': 1}, {'requests': 2}
observations, removes = [], []
real_fdopen, real_rename, real_unlink = os.fdopen, os.rename, os.unlink
failure = None
def sample():
 observations.append(load('ui-live.json'))
class Split:
 def __init__(self, fd, mode):
  assert mode == 'wb'; self.f = real_fdopen(fd, mode)
 def __enter__(self): return self
 def __exit__(self, *args): self.f.close()
 def write(self, data):
  split = len(data) // 2
  self.f.write(data[:split]); self.f.flush(); sample()
  if failure == 'write': raise RuntimeError('synthetic write failure')
  self.f.write(data[split:]); self.f.flush(); sample()
def rename(a, b):
 sample()
 if failure == 'rename': raise RuntimeError('synthetic rename failure')
 real_rename(a, b); sample()
def unlink(path): removes.append(path); real_unlink(path)
def rejected(action):
 try: action()
 except Exception: return
 raise AssertionError('negative accepted')
os.fdopen, os.rename, os.unlink = Split, rename, unlink
try:
 assert load('missing.json') == {}
 put('ui-live.json', old); assert observations == [{}, {}, {}, old]
 observations.clear(); prior = os.lstat(target).st_ino
 put('ui-live.json', new); assert observations == [old, old, old, new]
 assert os.lstat(target).st_ino != prior and not os.path.lexists(pending) and not removes
 # RED control: old in-place publication lets the exact consumer see truncated JSON.
 with open(target, 'w') as f: f.write('{"requests":')
 try: load('ui-live.json')
 except json.JSONDecodeError: pass
 else: raise AssertionError('malformed JSON swallowed')
 cyclic = {}; cyclic['self'] = cyclic
 rejected(lambda: put('ui-live.json', cyclic))
 rejected(lambda: put('ui-live.json', float('nan')))
 assert not os.path.lexists(pending)
 with open(target, 'w') as f: json.dump(old, f)
 for failure in ['write', 'rename']:
  before = len(removes); rejected(lambda: put('ui-live.json', new))
  assert load('ui-live.json') == old and not os.path.lexists(pending) and len(removes) == before + 1
 failure = None
 for name in ['../escape.json', '/tmp/escape.json', 'progress-01.json', 'budget.json', 'live-snapshot.json', EVIDENCE_PENDING]:
  rejected(lambda: put(name, new))
 sentinel = root + '/synthetic-sentinel'
 with open(sentinel, 'x') as f: f.write('{}')
 for kind in ['regular', 'symlink', 'hardlink', 'directory']:
  if kind == 'regular':
   with open(pending, 'x') as f: f.write('{}')
  if kind == 'symlink': os.symlink(sentinel, pending)
  if kind == 'hardlink': os.link(sentinel, pending)
  if kind == 'directory': os.mkdir(pending)
  before = len(removes); rejected(lambda: put('ui-live.json', new))
  assert os.path.lexists(pending) and len(removes) == before
  if kind == 'directory': os.rmdir(pending)
  else: real_unlink(pending)
 real_unlink(target)
 for kind in ['symlink', 'hardlink', 'directory']:
  if kind == 'symlink': os.symlink(sentinel, target)
  if kind == 'hardlink': os.link(sentinel, target)
  if kind == 'directory': os.mkdir(target)
  rejected(lambda: put('ui-live.json', new)); assert not os.path.lexists(pending)
  if kind == 'directory': os.rmdir(target)
  else: real_unlink(target)
 real_rename(root + '/evidence', root + '/moved'); os.symlink(root + '/moved', root + '/evidence')
 rejected(lambda: put('ui-live.json', new)); real_unlink(root + '/evidence'); real_rename(root + '/moved', root + '/evidence')
 os.chmod(root, 0o755); rejected(lambda: put('ui-live.json', new)); os.chmod(root, 0o700)
 put('ui-live.json', new); assert load('ui-live.json') == new and not os.path.lexists(pending)
 assert json.load(open(sentinel)) == {}
 # These slots must be ignored by protocol_rows, preserving its strict42/21504 ceilings.
 assert not EVIDENCE_PENDING.startswith(('progress-', 'ack-')) and EVIDENCE_PENDING != 'budget.json'
 print(json.dumps({'ok': True, 'publishers': len(EVIDENCE_NAMES), 'ownedCleanups': len(removes)}))
finally:
 os.fdopen, os.rename, os.unlink = real_fdopen, real_rename, real_unlink
 assert os.path.realpath(root) == root and len(os.listdir(root)) <= 4
 shutil.rmtree(root)
`;
  const result = spawnSync('/usr/bin/python3', ['-B', '-c', script], { encoding: 'utf8', timeout: 4000, maxBuffer: 65536 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, publishers: 6, ownedCleanups: 2 });
});


// No Pi/SDK/provider/PTY: AST-extracted controller predicates over synthetic ANSI.
test('Stage 9 author-only settings: fresh specific form gates and documented remaining keys', { timeout: 5000 }, async () => {
  const { spawnSync } = await import('node:child_process');
  const script = String.raw`import ast, json, re
source = ${JSON.stringify(authorSource('stage9-activity-host-pty.py'))}
tree = ast.parse(source)
functions = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
def calls(node, name):
 return sorted([n for n in ast.walk(node) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name) and n.func.id == name], key=lambda n: (n.lineno, n.col_offset))
# Exact real emission matcher only, not a controller or terminal execution.
exec(compile(ast.Module(body=[functions['text'], functions['emitted']], type_ignores=[]), '<pure-emission>', 'exec'))
ansi = re.compile(r'\x1b\[[0-?]*[ -/]*[@-~]')
for name, active in [('settings_ui', 'alt+g'), ('reload_ui', 'alt+j'), ('restart_ui', 'alt+j')]:
 node = functions[name]
 keys = calls(node, 'key')
 opening = next(i for i, n in enumerate(keys) if isinstance(n.args[0], ast.Constant) and n.args[0].value == b'o')
 assert ast.literal_eval(keys[opening-1].args[0]) == b'\t'
 tab = next(i for i, n in enumerate(node.body) if keys[opening-1] in calls(n, 'key'))
 assert ast.unparse(node.body[tab-1]) == 'offset = len(raw)'
 gate = node.body[tab+2]
 predicate = calls(gate, 'until')[0].args[0]
 markers = calls(predicate, 'emitted')
 assert [ast.literal_eval(n.args[0]) for n in markers] == ['2 UI preferences', 'Active: '+active, 'Desired: '+active, 'Shortcut: type key, off, or default; Enter saves']
 assert all(ast.unparse(n.args[1]) == 'offset' for n in markers)
 check = eval(compile(ast.Expression(body=predicate), '<actual-form-gate>', 'eval'))
 form = '\n'.join(ast.literal_eval(n.args[0]) for n in markers).encode()
 raw = bytearray(form + b'\nQuick keys: o UI preferences (when settings focused)'); offset = len(raw)
 assert not check(), 'old form cannot authorize typing'
 raw.extend(b'\nQuick keys: o UI preferences (when settings focused)'); assert not check(), 'generic hint cannot authorize typing'
 raw.extend(b'\n2 UI preferences\nActive: '+active.encode()); assert not check(), 'partial form is not ready'
 raw.extend(b'\n\x1b[7m'+form+b'\x1b[27m'); assert check()
 assert ast.literal_eval(keys[opening+1].args[0]) == (bytes([5,21])+b'alt+j\r' if name == 'settings_ui' else bytes([27]))
 assert ast.literal_eval(keys[-1].args[0]) == (bytes([27])+b'k' if name == 'settings_ui' else b'Z' if name == 'reload_ui' else bytes([27]))
settings = functions['settings_ui']
loop = next(n for n in settings.body if isinstance(n, ast.For))
assert ast.literal_eval(loop.iter) == [b'ctrl+i', b'alt+k', b'alt+n']
proposal = calls(loop, 'key')[0].args[0]
assert ast.unparse(proposal) == "b'\\x05\\x15' + binding + b'\\r'"
assert ast.literal_eval(calls(functions['close_manage'], 'key')[0].args[0]) == b'q'
assert ast.literal_eval(functions['open_manage'].args.defaults[0]) == bytes([27])+b'g'
assert not any(isinstance(n, ast.Constant) and n.value == b'2' for n in ast.walk(tree))
print(json.dumps({'ok': True, 'freshFormGates': 3, 'conflictProposals': 3}))
`;
  const result = spawnSync('/usr/bin/python3', ['-B', '-c', script], { encoding: 'utf8', timeout: 4000, maxBuffer: 65536 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, freshFormGates: 3, conflictProposals: 3 });
});

// Pure actual UI/Input source, fake preference storage and action counters ONLY.
// An explicit candidate root permits private authoring without copying/editing runtime.
test('Stage 9 author-only settings: actual Tab/o/Input, caret-end clear and no authority dispatch', { timeout: 5000 }, async () => {
  const ts = await import('typescript'), vm = await import('node:vm'), tui = await import('@earendil-works/pi-tui');
  const uiRoot = process.env.ZERG_BACKGROUND_ACTIVITY_CANDIDATE_ROOT ?? fileURLToPath(new URL('../', import.meta.url));
  const context = vm.createContext({ ...tui, matchesPiKey: tui.matchesKey });
  const shortcutContext = vm.createContext({ ...tui }); // Keep Pi matchesKey distinct from UI state.matchesKey.
  const extract = (file: string, names?: string[], target = context) => {
    const path = join(uiRoot, 'ui', file + '.ts'), st = lstatSync(path);
    assert(st.isFile() && !st.isSymbolicLink() && st.nlink === 1);
    const ast = ts.createSourceFile(file + '.ts', readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
    assert.equal((ast as any).parseDiagnostics.length, 0);
    const nodes = ast.statements.filter(n => (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isVariableStatement(n))
      && (!names || names.includes((n as any).name?.text) || ts.isVariableStatement(n) && n.declarationList.declarations.some(d => names.includes(d.name.getText(ast)))));
    if (names) assert.equal(nodes.length, names.length);
    const code = nodes.map(n => n.getText(ast).replace(/^export /, '')).join('\n');
    vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, target, { timeout: 1000 });
  };
  extract('preferences', ['DEFAULT_MANAGEMENT_SHORTCUT', 'normalizeManagementShortcut']);
  extract('preferences', ['normalizeManagementShortcut'], shortcutContext);
  extract('management-shortcut', ['namedKeys', 'otherKey', 'packets', 'equivalents', 'bindingEntries', 'validateManagementShortcut'], shortcutContext);
  for (const file of ['state', 'components', 'tree-pane', 'detail-pane', 'chat-pane', 'footer', 'settings-pane']) extract(file);
  extract('management-overlay', ['viewerError', 'ZergManagementOverlayComponent']);
  const Component: any = vm.runInContext('ZergManagementOverlayComponent', context);
  const state = { mode: { readOnly: true, automation: 'manual', controller: 'operator' }, extensions: {}, teams: {}, agents: {}, tasks: {}, tree: {}, lifecycle: 'ready', revision: 0 };
  const before = JSON.stringify(state);
  let actions = 0, saves = 0, closes = 0;
  const forbidden = () => { actions++; throw Error('legacy authority/viewer dispatched'); };
  // Real Input RED: setValue keeps caret at0, Ctrl+U alone does not clear default.
  const red = new tui.Input(); red.setValue('alt+g'); red.handleInput('\x15'); assert.equal(red.getValue(), 'alt+g');
  red.handleInput('\x05'); red.handleInput('\x15'); assert.equal(red.getValue(), '');
  for (const active of ['alt+g', 'alt+j', 'alt+j']) {
    let desired = active;
    const priorSaves = saves, priorCloses = closes;
    const preferences = {
      snapshot: () => ({ active, desired, pending: desired !== active, activityStrip: true, fallback: '/clankers config' }),
      subscribe: () => () => {},
      saveHuman(update: any) {
        saves++;
        const result = shortcutContext.validateManagementShortcut(update.managementShortcut, { 'tui.input.tab': 'tab', 'app.session.new': 'alt+n' }, [{ key: 'alt+k', handler: forbidden }]);
        if (result.ok) desired = context.normalizeManagementShortcut(update.managementShortcut);
        return result;
      },
    };
    const component = new Component({ requestRender() {} }, undefined, () => { closes++; }, {
      getSnapshot: () => state, subscribe: () => () => {}, adapterKind: 'pure-test', uiPreferences: preferences,
      actions: Object.fromEntries(['toggleReadOnly', 'setAutomation', 'setController', 'approvePermission', 'denyPermission', 'selectTarget', 'interruptSelected', 'sendOperatorMessage', 'now'].map(k => [k, forbidden])),
      viewTimeline: forbidden, viewCoding: forbidden,
    });
    component.focused = true;
    const screen = () => tui.stripTerminalSequences(component.render(240, 45).join('\n'));
    assert(screen().includes('Quick keys: o UI preferences')); assert(!screen().includes('2 UI preferences'));
    component.handleInput('2'); component.handleInput('o');
    assert.equal(component.getStateForTests().focusedPane, 'tree'); assert(!screen().includes('2 UI preferences')); assert.equal(saves, priorSaves);
    component.handleInput('\t'); assert.equal(component.getStateForTests().focusedPane, 'settings');
    component.handleInput('o');
    for (const marker of ['2 UI preferences', 'Active: '+active, 'Desired: '+active, 'Shortcut: type key, off, or default; Enter saves', '> '+active]) assert(screen().includes(marker), marker);
    const propose = (key: string) => { for (const packet of ['\x05', '\x15', ...key, '\r']) component.handleInput(packet); };
    propose('alt+j'); assert.equal(desired, 'alt+j'); assert.equal(actions, 0);
    assert(screen().includes('Active: '+active)); assert(screen().includes('Desired: alt+j'));
    assert.equal(screen().includes('pending /reload'), active !== 'alt+j');
    for (const binding of ['ctrl+i', 'alt+k', 'alt+n']) { propose(binding); assert.equal(desired, 'alt+j'); assert.equal(actions, 0); }
    component.handleInput('\x1b'); assert(!screen().includes('2 UI preferences')); assert.equal(closes, priorCloses);
    component.handleInput('q'); assert.equal(JSON.stringify(state), before); assert.equal(actions, 0);
  }
  assert.equal(saves, 12); assert.equal(closes, 3); assert.equal(actions, 0);
});


// Two independent fixture evaluations share the SAME cached exports. Only exact
// extracted fixture/UI/latch declarations execute: no SDK/Jiti/product startup.
test('Stage 9 author-only cached reload: fresh delegate, real component/latch, late old owner', { timeout: 5000 }, async () => {
  const ts = await import('typescript'), vm = await import('node:vm'), tui = await import('@earendil-works/pi-tui');
  const uiRoot = process.env.ZERG_BACKGROUND_ACTIVITY_CANDIDATE_ROOT ?? fileURLToPath(new URL('../', import.meta.url));
  const sourceAt = (path: string) => {
    const st = lstatSync(path); assert(st.isFile() && !st.isSymbolicLink() && st.nlink === 1);
    return readFileSync(path, 'utf8');
  };
  const astOf = (source: string) => {
    const ast = ts.createSourceFile('pure.ts', source, ts.ScriptTarget.Latest, true);
    assert.equal((ast as any).parseDiagnostics.length, 0); return ast;
  };
  const run = (code: string, context: any) => vm.runInContext(ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context, { timeout: 1000 });
  const ui = vm.createContext({ ...tui, matchesPiKey: tui.matchesKey });
  const extractUi = (file: string, names?: string[]) => {
    const ast = astOf(sourceAt(join(uiRoot, 'ui', file + '.ts')));
    const nodes = ast.statements.filter(n => (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isVariableStatement(n))
      && (!names || names.includes((n as any).name?.text) || ts.isVariableStatement(n) && n.declarationList.declarations.some(d => names.includes(d.name.getText(ast)))));
    if (names) assert.equal(nodes.length, names.length);
    run(nodes.map(n => n.getText(ast).replace(/^export /, '')).join('\n'), ui);
  };
  extractUi('preferences', ['DEFAULT_MANAGEMENT_SHORTCUT']);
  for (const file of ['state', 'components', 'tree-pane', 'detail-pane', 'chat-pane', 'footer', 'settings-pane']) extractUi(file);
  extractUi('management-overlay', ['viewerError', 'openZergManagementOverlay', 'ZergManagementOverlayComponent']);
  const Component = run('ZergManagementOverlayComponent', ui);
  const realOpen = ui.openZergManagementOverlay;
  const indexAst = astOf(sourceAt(join(uiRoot, 'index.ts'))), indexNodes: any[] = [];
  const visitIndex = (n: any) => { indexNodes.push(n); ts.forEachChild(n, visitIndex); }; visitIndex(indexAst);
  const latch = indexNodes.filter(n => ts.isVariableStatement(n) && n.declarationList.declarations.some((d: any) =>
    ['openManagement', 'handler'].includes(d.name.getText(indexAst))) && n.getText(indexAst).includes('opening'));
  assert.equal(latch.length, 1); // openManagement; handler selected separately by its exact dispatch shape.
  const canonical = indexNodes.filter(n => ts.isVariableStatement(n) && n.getText(indexAst).includes("? openManagement(context) : dispatch(input, context)"));
  assert.equal(canonical.length, 1);
  const latchCode = 'let opening = false;\n' + latch[0].getText(indexAst) + '\n' + canonical[0].getText(indexAst);
  const options = { getSnapshot: () => ({ mode: { readOnly: true, automation: 'manual', controller: 'operator' },
    extensions: {}, teams: {}, agents: {}, tasks: {}, tree: {}, lifecycle: 'ready', revision: 0 }),
    subscribe: () => () => {}, adapterKind: 'pure', actions: {} };
  const currentSource = authorSource('stage9-activity-host-fixture.ts');
  // RED restores the two v3 hazards: the cached export's retained delegate,
  // and custom entry observing its captured ctx before the real custom call.
  // Keep this pure control self-contained when the parent assembles v4.
  const retained = 'return original(g.witnessedContext(args[0]), ...args.slice(1));';
  const staleObserve = 'opens++; observe(target, g);';
  assert.equal(currentSource.split(retained).length, 2); assert.equal(currentSource.split(staleObserve).length, 2);
  const oldSource = currentSource.replace(retained, 'return original(witnessedContext(args[0]), ...args.slice(1));')
    .replace(staleObserve, 'opens++; observe();');
  const factory = astOf(currentSource).statements.find((n: any) => ts.isFunctionDeclaration(n) && n.name?.text === 'stage9HostFixture')!;
  const factoryStatements = (factory as any).body.statements.map((n: any) => n.getText());
  const delegateIndex = factoryStatements.findIndex((s: string) => s.startsWith('g.witnessedContext ='));
  const registerIndex = factoryStatements.findIndex((s: string) => s.includes('zerg.registerZergSwarmExtension(proxy,'));
  assert(delegateIndex >= 0 && delegateIndex < registerIndex, 'Fresh delegate installed BEFORE product registration');
  const scenario = async (source: string, fixed: boolean) => {
    const ast = astOf(source), nodes: any[] = [];
    const visit = (n: any) => { nodes.push(n); ts.forEachChild(n, visit); }; visit(ast);
    const exact = (predicate: (n: any) => boolean) => {
      const hits = nodes.filter(predicate); assert.equal(hits.length, 1); return hits[0].getText(ast);
    };
    const functions = ['seam', 'stateHash', 'witnessComponent', 'witnessedContext'].map(name =>
      exact(n => ts.isFunctionDeclaration(n) && n.name?.text === name)).join('\n');
    const declarations = ['metrics', 'observe', 'contextCache', 'initiationSnapshot', 'serialNative'].map(name =>
      exact(n => ts.isVariableStatement(n) && n.declarationList.declarations.some((d: any) => d.name.getText(ast) === name))).join('\n');
    const seams = ['backgroundModule', 'preferencesModule', 'managementModule'].map(name =>
      exact(n => ts.isExpressionStatement(n) && n.getText(ast).startsWith('seam(' + name + ','))).join('\n');
    const delegate = exact(n => ts.isExpressionStatement(n) && n.getText(ast).startsWith('g.witnessedContext ='));
    const registrar = exact(n => ts.isVariableStatement(n) && n.getText(ast).startsWith('const proxy = new Proxy(pi,') && n.getText(ast).includes('g.shortcuts.push'));
    const shared: any = { current: undefined, generations: [], promptCalls: 0 };
    const managementModule: any = { ZergManagementOverlayComponent: Component, openZergManagementOverlay: realOpen };
    const backgroundModule: any = { createBackgroundActivityController: (o: any) => o };
    const preferencesModule: any = { createUiPreferences: (...args: any[]) => args };
    const publications: any[] = [], handlers: any[] = [], shortcuts: any[] = [];
    const evaluate = (id: number) => {
      const g: any = { id, factories: 0, preferences: 0, managementFactories: 0, inputs: 0, widgets: 0,
        subscriptions: 0, timers: new Set(), snapshots: 0, events: 0, renders: 0, renderMs: 0, shutdown: false,
        shortcuts: [], managementSignatures: [] };
      let reads = 0, entries = 0, customCalls = 0, resolveClose: any, invalid = false, staleReads = 0;
      let actual: any, inputRemove: any, widgetFactory: any;
      const uiTarget = { getEditorText: () => 'draft-' + id, onTerminalInput: () => () => { inputRemove = true; },
        setWidget: (_name: string, factory: any) => { widgetFactory = factory; },
        custom(factory: any) { customCalls++; actual = factory({ requestRender() {} });
          return new Promise<void>(resolve => { resolveClose = resolve; }); } };
      const ctx = { get ui() { if (invalid) { staleReads++; throw Error('INVALIDATED generation ' + id); } return uiTarget; } };
      const control = { getState: () => { reads++; return { owner: id }; } };
      const context: any = vm.createContext({ assert, shared, managementModule, backgroundModule, preferencesModule,
        generation: g, g, registration: { control }, ctx, opens: 0, closes: 0, frameCount: 0,
        frames: [], latestLines: '', native: [], stableObserverWindow: false, performance: { now: () => 0 },
        hash: (value: any) => JSON.stringify(value), requests: () => 0, tui, queueMicrotask,
        put: (_name: string, row: any) => publications.push(JSON.parse(JSON.stringify(row))),
        setTimeout, clearTimeout, Date, handle: undefined, widget: undefined,
        normalizeZergCommandInput: (input: string) => { entries++; return { topic: input }; },
        dispatch: (_input: string, c: any) => managementModule.openZergManagementOverlay(c, options),
        pi: { registerCommand: (_name: string, row: any) => handlers.push(row.handler),
          registerShortcut: (_key: string, row: any) => shortcuts.push(row.handler), on() {} },
      });
      shared.generations.push(g); shared.current = g;
      run(functions + '\n' + declarations + '\n' + seams + '\n' + delegate + '\n' + registrar, context);
      const latchContext = vm.createContext({ dispatch: context.dispatch, normalizeZergCommandInput: context.normalizeZergCommandInput });
      run(latchCode, latchContext);
      const handler = context.handler = run('handler', latchContext);
      run("proxy.registerCommand('zerg', { handler }); proxy.registerShortcut('alt+j', { handler });", context);
      g.registration = { control }; assert.equal(g.handler ?? handler, handler);
      assert.equal(handlers.at(-1), handler); assert.equal(shortcuts.at(-1), handler);
      return { g, context, ctx, handler, uiTarget, invalidate: () => { invalid = true; }, close: () => resolveClose(),
        status: () => ({ reads, entries, customCalls, staleReads, actual, inputRemove, widgetFactory }) };
    };
    const one = evaluate(1), firstExport = managementModule.openZergManagementOverlay;
    const pendingOld = one.handler('config', one.ctx);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(one.status().customCalls, 1); assert(one.status().actual instanceof Component);
    assert.equal(one.status().entries, 2); // Genuine queued canonical handler reentry hits exact product latch.
    const oldUi = one.context.witnessedContext(one.ctx);
    const removeOldInput = oldUi.ui.onTerminalInput(() => {});
    oldUi.ui.setWidget('pi-zerg-swarm.background-activity', () => ({ render: () => ['old widget'] }));
    const oldWidget = one.status().widgetFactory({ terminal: { rows: 45 } });
    if (!fixed) { one.close(); await pendingOld; }
    const two = evaluate(2); assert.equal(managementModule.openZergManagementOverlay, firstExport);
    one.invalidate();
    const pendingNew = two.handler('config', two.ctx);
    if (!fixed) {
      await assert.rejects(pendingNew, /INVALIDATED generation 1/);
      assert.equal(two.status().customCalls, 0); assert.equal(two.context.opens, 0);
      assert.equal(two.g.managementFactories, 1); assert.equal(one.status().staleReads, 1); return;
    }
    await Promise.resolve(); await Promise.resolve();
    assert.equal(two.status().customCalls, 1); assert(two.status().actual instanceof Component);
    assert.equal(two.status().entries, 2); assert.equal(one.status().entries, 2);
    assert.equal(two.context.opens, 1); assert.equal(one.context.opens, 1);
    assert.equal(two.g.managementFactories, 1); assert.equal(two.g.managementSignatures.length, 1);
    const beforeOld = one.status().reads, beforeNew = two.status().reads;
    oldWidget.render(240); one.status().actual.render(240); two.status().actual.render(240);
    assert.equal(one.status().reads, beforeOld + 4); assert.equal(two.status().reads, beforeNew + 2);
    assert.equal(one.g.renders, 2); assert.equal(two.g.renders, 1);
    removeOldInput(); assert.equal(one.g.inputs, 0); assert.equal(two.g.inputs, 0); assert(one.status().inputRemove);
    one.close(); await pendingOld;
    assert.equal(one.context.closes, 1); assert.equal(two.context.closes, 0);
    assert.equal(publications.at(-1).generation, 1); assert.equal(publications.at(-1).draft, 'draft-1');
    two.close(); await pendingNew;
    assert.equal(two.context.closes, 1); assert.equal(publications.at(-1).generation, 2);
    assert.equal(publications.at(-1).draft, 'draft-2'); assert.equal(one.status().staleReads, 0);
    // Fresh event/input/widget/preferences/background factory entry, old callbacks remain old-owned.
    const oldFactories = one.g.factories, newFactories = two.g.factories;
    const controller = backgroundModule.createBackgroundActivityController({ native: { snapshot: () => ['owned-2'], subscribe: (f: any) => { f(); return () => {}; } } });
    const remove = controller.native.subscribe(() => {}); controller.native.snapshot(); remove();
    assert.equal(one.g.factories, oldFactories); assert.equal(two.g.factories, newFactories + 1);
    assert.equal(two.g.snapshots, 1); assert.equal(two.g.events, 1); assert.equal(two.g.subscriptions, 0);
    const token = controller.clock.setTimeout(() => {}, 10000); controller.clock.clearTimeout(token); assert.equal(two.g.timers.size, 0);
    assert.deepEqual(preferencesModule.createUiPreferences('marker'), ['marker']); assert.equal(two.g.preferences, 1); assert.equal(one.g.preferences, 0);
  };
  await scenario(oldSource, false); await scenario(currentSource, true);
});
