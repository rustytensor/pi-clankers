import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertAncestorIsolation, cleanHostEnvironment, guardSource, spawnOwnedController, settleOwnedController } from './host-fixture-safety.mjs';

// Only run from an approved allowlisted source snapshot AFTER parent grant.
// Two real Pi CLI PTYs, public registered config handler, ZERO model requests.
// /reload is Pi's built-in lifecycle command, never terminal-driven /zerg.
// Renderer/input/resize evidence is NOT manual visual/pixel acceptance.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(repo, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
assert(existsSync(cli), 'Installed Pi required (no installation)');
const evidence = mkdtempSync(join(tmpdir(), 'zerg-management-pty-'));
const results = [];
function extensionSource(root) {
  return `import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { visibleWidth, CURSOR_MARKER } from '@earendil-works/pi-tui';
import { registerZergSwarmExtension } from ${JSON.stringify(join(repo, 'index.ts'))};
import { createZergState, replaceSharedZergState } from ${JSON.stringify(join(repo, 'state.ts'))};
const root = ${JSON.stringify(root)};
const put = (name, value) => writeFileSync(join(root, name), JSON.stringify(value));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export default function(pi) {
  const generation = existsSync(join(root, 'generation.json')) ? JSON.parse(readFileSync(join(root, 'generation.json'), 'utf8')) + 1 : 1;
  assert(generation <= 2, 'Unexpected reload generation'); put('generation.json', generation);
  // Synthetic retained data only. NEVER print these strings, even on failure.
  const attack = '\\u001b]52;c;U1lOVEhFVElDX09OTFk=\\u0007\\u001b[2J\\u009d52;c;fake\\u009c\\nFAKE_RETAINED';
  replaceSharedZergState(createZergState({
    agents: { 'management-retained': { id: 'management-retained', label: attack + ' SYNTHETIC_AGENT', kind: 'teammate', status: 'idle' } },
    extensions: { zergPermissions: { requests: [{ id: 'management-synthetic', status: 'pending', kind: 'tool', summary: attack }] } },
  }));
  let handler, registrations = 0;
  const proxy = new Proxy(pi, { get(target, key) {
    if (key === 'registerCommand') return (name, options) => { if (name === 'zerg') { handler = options.handler; registrations++; } return target.registerCommand(name, options); };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const registration = registerZergSwarmExtension(proxy);
  const control = registration.control;
  let cleaned = false, started = false;
  const components = [], checks = [];
  function cleanup() { if (cleaned) return; cleaned = true; for (const item of components) item.component.dispose?.(); registration.dispose(); registration.dispose(); }
  pi.on('session_shutdown', cleanup);
  pi.on('session_start', (_event, ctx) => {
    if (started) return; started = true;
    setTimeout(() => void smoke(ctx).catch(() => {
      // Deliberately no Error/retained-state dump into terminal or evidence.
      put('result.json', { ok: false, generation, failureDomain: 'management-host-contract' });
      try { cleanup(); } finally { ctx.shutdown(); }
    }), 0);
  });
  function safeText(text) {
    const plain = text.split(CURSOR_MARKER).join('').replace(/\\u001b\\[[0-9;]*m/g, '');
    assert(!/[\\u001b\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]/.test(plain), 'Unsafe terminal control (payload withheld)');
  }
  async function smoke(ctx) {
    assert.equal(ctx.mode, 'tui'); assert.equal(registrations, 1); assert.equal(typeof handler, 'function');
    assert.equal(Object.keys(control.getState().tasks).length, 0);
    const ui = new Proxy(ctx.ui, { get(target, key) {
      if (key === 'notify') return (text, ...args) => { safeText(text); return target.notify(text, ...args); };
      if (key === 'custom') return (factory, options) => target.custom((tui, theme, kb, done) => {
        const item = { disposed: false, done: 0, redraws: 0, late: 0, frames: 0, styled: false, focusedChat: false, cursorSeen: false, draftSeen: false, draftCleared: false, widths: [] };
        const observedTui = new Proxy(tui, { get(handle, name) {
          if (name === 'requestRender') return (...args) => { item.redraws++; if (item.disposed) item.late++; return handle.requestRender(...args); };
          const value = Reflect.get(handle, name); return typeof value === 'function' ? value.bind(handle) : value;
        } });
        const component = factory(observedTui, theme, kb, value => { item.done++; return done(value); });
        // This is the actual registered management component, never a fake UI.
        assert.equal(typeof component.getStateForTests, 'function', 'Management fallback is not acceptance');
        item.component = component; components.push(item);
        const render = component.render.bind(component), dispose = component.dispose.bind(component);
        component.render = (width, height) => {
          const lines = render(width, height);
          // ASSERT BEFORE returning bytes to the real terminal renderer. Theme
          // SGR and the trusted Pi cursor marker remain intact, no final stripping.
          for (const line of lines) { safeText(line); assert(!line.includes('\\n') && !line.includes('\\r')); assert(visibleWidth(line) <= width); }
          const physicalWidth = typeof tui.terminal?.columns === 'number' ? tui.terminal.columns : width;
          const physicalHeight = typeof tui.terminal?.rows === 'number' ? tui.terminal.rows : height;
          for (const line of lines) assert(visibleWidth(line) <= Math.min(width, physicalWidth));
          if (height !== undefined) assert(lines.length <= height);
          if (physicalHeight !== undefined) assert(lines.length <= physicalHeight);
          item.frames++; item.widths.push(width); if (item.widths.length > 128) item.widths.shift();
          item.styled ||= lines.some(line => /\\u001b\\[[0-9;]*m/.test(line));
          const state = component.getStateForTests();
          assert.equal(state.selectedTargetId, 'management-retained', 'Exact retained selection across focus/resize');
          if (state.focusedPane === 'chat') {
            assert(component.focused, 'Actual input owner lost focus');
            item.focusedChat = true;
            assert(lines.some(line => line.includes(CURSOR_MARKER)), 'Public Input cursor marker required');
            item.cursorSeen = true;
            if (state.chatDraft === 'literal-q-c-n') item.draftSeen = true;
            if (item.draftSeen && state.chatDraft === '') item.draftCleared = true;
            assert.equal(state.messages.length, 0, 'Draft must not send a local operator message');
            assert.equal(state.selectedTargetId, item.selected);
          }
          if (!item.selected) item.selected = state.selectedTargetId;
          return lines;
        };
        component.dispose = () => { dispose(); item.disposed = true; };
        return component;
      }, options);
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
    } });
    const facade = new Proxy(ctx, { get(target, key) { return key === 'ui' ? ui : Reflect.get(target, key); } });
    const cycles = generation === 1 ? 2 : 1;
    for (let cycle = 1; cycle <= cycles; cycle++) {
      put('phase.json', { name: 'management-' + generation + '-' + cycle });
      await handler('config', facade);
      const item = components.at(-1);
      assert(item && item.frames > 0 && item.styled && item.focusedChat && item.cursorSeen && item.draftSeen && item.draftCleared, 'Real render/theme/focus/exact draft/cancel acceptance required');
      assert.equal(item.component.getStateForTests().messages.length, 0);
      assert.equal(item.done, 1); assert.equal(item.late, 0);
      item.component.dispose(); item.component.dispose(); assert.equal(item.done, 1);
      const before = item.redraws;
      const action = await control.execute({ action: 'agents.create', id: 'closed-change-' + generation + '-' + cycle, tools: [], prompt: 'Synthetic definition only; never launch.' });
      assert(action.ok); await sleep(100); assert.equal(item.redraws, before, 'Closed component receives no state redraw');
      assert.equal(Object.keys(control.getState().tasks).length, 0, 'Management owns no runner/task');
      const runs = await control.execute({ action: 'runs.list' }); assert(runs.ok); assert.deepEqual(runs.data.runs, []);
      checks.push({ generation, cycle, frames: item.frames, styled: item.styled, focusedChat: item.focusedChat, cursorSeen: item.cursorSeen, draftSeen: item.draftSeen, draftCleared: item.draftCleared, done: item.done, lateRedraws: item.late, widths: item.widths });
    }
    cleanup();
    put('generation-' + generation + '.json', { ok: true, generation, checks, zeroTasks: true, zeroRuns: true });
    if (generation === 1) { put('phase.json', { name: 'await-reload' }); return; }
    assert(JSON.parse(readFileSync(join(root, 'generation-1.json'), 'utf8')).ok);
    put('result.json', { ok: true, generations: 2, reload: true, shutdown: true, zeroModelRequests: true });
    put('phase.json', { name: 'complete' }); ctx.shutdown();
  }
}
`;
}
const pythonSource = String.raw`import errno, fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time
root, node, cli, mode = sys.argv[1:]
master, slave = pty.openpty()
def resize(cols, rows): fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
resize(160, 70)
env = dict(os.environ); env['TERM'] = 'xterm-256color'
args = [node, '--import', root + '/guard.mjs', cli, '--offline', '--no-session', '--no-approve', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-tools', '--model', 'fixture/never', '--thinking', 'off', '--tui-mode', mode, '-e', root + '/smoke.ts']
proc = subprocess.Popen(args, cwd=root + '/work', env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
raw = bytearray(); start = time.monotonic()
ansi = re.compile(r'\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\x1b[@-_]')
def pump(wait=0.04):
    if select.select([master], [], [], wait)[0]:
        try: data = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO: return
            raise
        raw.extend(data)
        if len(raw) > 4 * 1024 * 1024:
            del raw[4 * 1024 * 1024:]; raise Exception('Terminal evidence ceiling')
        if b'\x1b[6n' in data: os.write(master, b'\x1b[1;1R')
        if b'\x1b[c' in data: os.write(master, b'\x1b[?1;2c')
        if b'\x1b[>c' in data: os.write(master, b'\x1b[>0;0;0c')
def read(name):
    try:
        with open(root + '/' + name) as f: return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError): return {}
def phase(name): return read('phase.json').get('name') == name
def until(check):
    while time.monotonic() - start < 70:
        pump()
        if check(): return
        if read('result.json').get('ok') is False: raise Exception('Host contract failed (payload withheld)')
        if proc.poll() is not None:
            if check(): return
            raise Exception('Host exited early')
    raise Exception('PTY deadline')
def pause():
    end = time.monotonic() + 0.4
    while time.monotonic() < end: pump()
report = {'mode': mode, 'hostPid': proc.pid, 'sizes': [160], 'ok': False}
def key(value): os.write(master, value); pause()
def terminate(_sig, _frame): raise Exception('Controller terminated')
signal.signal(signal.SIGTERM, terminate)
try:
    for generation, cycles in [(1, 2), (2, 1)]:
        for cycle in range(1, cycles + 1):
            until(lambda: phase('management-' + str(generation) + '-' + str(cycle))); pause()
            until(lambda: 'clankers config' in ansi.sub('', bytes(raw).decode('utf-8', 'replace')))
            # Tree -> settings -> chat. Typed action-looking input remains a
            # literal draft; no Enter/send, no runner or provider invocation.
            key(b'\t'); key(b'\t'); key(b'literal-q-c-n')
            key(b'\x18') # Ctrl+x cancel draft, still same management target
            key(b'\x1b[Z'); key(b'\x1b[Z')
            for cols, rows in [(10, 5), (45, 20), (160, 70)]:
                before = len(raw); resize(cols, rows); os.kill(proc.pid, signal.SIGWINCH); pause()
                report['sizes'].append(cols); assert len(raw) > before, 'No actual resize emission'
            key(b'\x1b')
        if generation == 1:
            until(lambda: phase('await-reload')); pause()
            key(b'/reload\r') # only Pi built-in lifecycle, NOT /zerg automation
    until(lambda: read('result.json').get('ok') is True)
    until(lambda: proc.poll() is not None)
    assert proc.returncode == 0
    report['ok'] = True
except BaseException:
    report['error'] = 'PTY/lifecycle failure (no retained field dump)'
finally:
    if proc.poll() is None:
        os.killpg(proc.pid, signal.SIGTERM)
        try: proc.wait(timeout=3)
        except subprocess.TimeoutExpired: os.killpg(proc.pid, signal.SIGKILL); proc.wait(timeout=3)
    try: pump(0)
    except BaseException: report['ok'] = False
    os.close(master)
    report['hostExit'] = proc.returncode; report['bytes'] = len(raw)
    with open(root + '/terminal.ansi', 'wb') as f: f.write(raw)
    with open(root + '/pty-result.json', 'w') as f: json.dump(report, f)
if not report['ok']: sys.exit(1)
`;
async function runMode(mode) {
  const root = join(evidence, mode); let controller;
  try {
    assertAncestorIsolation(root); cleanHostEnvironment(root); mkdirSync(join(root, 'work'), { recursive: true });
    writeFileSync(join(root, 'agent/auth.json'), '{}');
    writeFileSync(join(root, 'agent/settings.json'), JSON.stringify({ packages: [], extensions: [], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, defaultProjectTrust: 'never', enableInstallTelemetry: false, enableAnalytics: false, cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false } }));
    writeFileSync(join(root, 'agent/models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'dummy-never-used', models: [{ id: 'never', input: ['text'], contextWindow: 8192, maxTokens: 64 }] } } }));
    writeFileSync(join(root, 'guard.mjs'), guardSource(root));
    writeFileSync(join(root, 'smoke.ts'), extensionSource(root)); writeFileSync(join(root, 'pty-controller.py'), pythonSource);
    controller = spawnOwnedController('/usr/bin/python3', [join(root, 'pty-controller.py'), root, process.execPath, cli, mode], root, 75000);
    let diagnosticsBytes = 0;
    for (const stream of [controller.stdout, controller.stderr]) stream.on('data', chunk => { diagnosticsBytes += chunk.length; if (diagnosticsBytes > 65536) controller.kill('SIGTERM'); });
    const exit = await new Promise((resolve, reject) => { controller.once('error', reject); controller.once('exit', (code, signal) => resolve({ code, signal })); });
    await settleOwnedController(controller);
    assert.equal(exit.code, 0, 'Owned supervisor/PTY failed'); assert(diagnosticsBytes <= 65536);
    assert(!existsSync(join(root, 'network-refused.txt')), 'ZERO attempted network required');
    const load = name => JSON.parse(readFileSync(join(root, name), 'utf8'));
    const host = load('result.json'), pty = load('pty-result.json'); assert(host.ok && pty.ok); assert.equal(pty.hostExit, 0);
    results.push({ mode, ...host, terminalBytes: pty.bytes, sizes: pty.sizes, generations: [load('generation-1.json'), load('generation-2.json')] });
  } finally {
    await settleOwnedController(controller); // fail closed: retain isolation until reaped
    const keep = new Set(['terminal.ansi', 'pty-result.json', 'result.json', 'generation-1.json', 'generation-2.json', 'supervisor-result.json', 'network-refused.txt']);
    for (const leaf of existsSync(root) ? readdirSync(root) : []) if (!keep.has(leaf)) rmSync(join(root, leaf), { recursive: true, force: true });
  }
}
try {
  await runMode('regular'); await runMode('fullscreen');
  writeFileSync(join(evidence, 'summary.json'), JSON.stringify({ ok: true, results, evidenceLimit: 'Actual registered management renderer/input/lifecycle; not manual visual acceptance. Zero model requests; no runner ownership.' }, null, 2));
  console.log('PASS management host; bounded synthetic evidence: ' + evidence);
} catch (error) { console.error('FAIL management host; bounded synthetic evidence: ' + evidence); throw error; }
