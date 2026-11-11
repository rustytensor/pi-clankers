import assert from 'node:assert/strict';
import { assertAncestorIsolation, cleanHostEnvironment, guardSource, readFixtureBody, spawnOwnedController, settleOwnedController } from './host-fixture-safety.mjs';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Standalone: node test/fixtures/agent-overlay-host-smoke.mjs
// Requires installed Pi 1.0 and Python 3's stdlib, never installs anything.
// Two actual PTYs; no slash-command input, private SDK hooks or external models.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(repo, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
assert(existsSync(cli), 'Installed Pi CLI required');
const evidence = mkdtempSync(join(tmpdir(), 'clankers-overlay-pty-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];

// The fixture extension registers the real extension exactly once and opens its
// captured UI handler with the returned structured control's SAME owner.
function extensionSource(root) {
  return `import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerClankersExtension } from ${JSON.stringify(join(repo, 'index.ts'))};
const root = ${JSON.stringify(root)};
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) { if (await check()) return; await sleep(30); }
  throw Error('Timeout: ' + label);
}
function phase(name, extra = {}) { writeFileSync(join(root, 'phase.json'), JSON.stringify({ name, ...extra })); }
export default function (pi) {
  let handler;
  let registrations = 0;
  const proxy = new Proxy(pi, { get(target, key) {
    if (key === 'registerCommand') return (name, options) => {
      if (name === 'clankers') { handler = options.handler; registrations++; }
      return target.registerCommand(name, options);
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const registration = registerClankersExtension(proxy);
  const control = registration.control;
  let cleaned = false;
  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    registration.dispose();
    registration.dispose();
  }
  pi.on('session_shutdown', cleanup);
  let started = false;
  pi.on('session_start', (_event, ctx) => {
    if (started) return;
    started = true;
    // Do not await a modal inside startup event dispatch.
    setTimeout(() => void smoke(ctx).catch(error => {
      writeFileSync(join(root, 'result.json'), JSON.stringify({ ok: false, error: String(error.stack ?? error).slice(-16000) }));
      try { cleanup(); } finally { ctx.shutdown(); }
    }), 0);
  });
  async function smoke(ctx) {
    assert.equal(ctx.mode, 'tui');
    assert.equal(registrations, 1);
    assert.equal(typeof handler, 'function');
    assert((await control.execute({ action: 'agents.create', id: 'pty-reader', model: 'fixture/slow', tools: ['read'], prompt: 'Read only the supplied fixture file. No edits or other tools.' })).ok);
    const launched = await control.execute({ action: 'run', agent: 'pty-reader', task: 'Read ' + join(root, 'work/input.txt') + ' then report.', background: true });
    assert(launched.ok, JSON.stringify(launched));
    async function show() { const r = await control.execute({ action: 'runs.show', runId: launched.runId }); assert(r.ok); return r.data.run; }
    await until(() => existsSync(join(root, 'streaming')), 'second request streaming');
    const live = await show();
    assert.equal(live.status, 'running');
    assert.equal(live.nativeSessions.length, 1);
    const ref = live.nativeSessions[0];
    assert.equal(ref.parentRunId, launched.runId);
    assert.equal(ref.memberRunId, launched.runId);
    assert.equal(ref.attachment, 'attached');
    phase('live-chooser', { key: { parentRunId: ref.parentRunId, memberRunId: ref.memberRunId, piSessionId: ref.piSessionId } });
    await handler('sessions ' + launched.runId, ctx);
    const afterClose = await show();
    assert.equal(afterClose.status, 'running', 'Closing viewer must not finish/abort runner');
    assert.equal(afterClose.nativeSessions[0].attachment, 'attached');
    phase('closed-live');
    await until(() => existsSync(join(root, 'release')), 'controller release');
    await until(async () => {
      const run = await show();
      return run.status === 'done' && run.nativeSessions[0].attachment === 'disposed';
    }, 'completed and disposed');
    const done = await show();
    const bytes = readFileSync(ref.sessionFile, 'utf8');
    const entries = bytes.trim().split('\\n').map(line => JSON.parse(line));
    assert(entries.some(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolName === 'read'));
    assert(bytes.includes('FINAL_AFTER_CLOSE'));
    phase('saved-chooser');
    await handler('sessions ' + launched.runId, ctx);
    assert.equal(readFileSync(ref.sessionFile, 'utf8'), bytes, 'History inspection must not mutate JSONL');
    cleanup(); cleanup();
    writeFileSync(join(root, 'result.json'), JSON.stringify({ ok: true, registrations, runId: launched.runId, piSessionId: ref.piSessionId, status: done.status, attachment: done.nativeSessions[0].attachment, jsonlUnchanged: true }));
    phase('complete');
    ctx.shutdown();
  }
}
`;
}

// PTY navigation only. Evidence is the real terminal byte stream, not mocked
// component.render output. ANSI stripping is not a full terminal emulator;
// this proves renderer emission/input/resize, not visual pixel correctness.
const pythonSource = String.raw`import errno, fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time
root, node, guard, cli, mode = sys.argv[1:]
master, slave = pty.openpty()
def resize(cols, rows):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
resize(120, 40)
env = dict(os.environ); env['TERM'] = 'xterm-256color'
args = [node, '--import', guard, cli, '--offline', '--no-session', '--no-approve', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-tools', '--model', 'fixture/slow', '--thinking', 'off', '--tui-mode', mode, '-e', root + '/smoke.ts']
proc = subprocess.Popen(args, cwd=root + '/work', env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
raw = bytearray()
start = time.monotonic()
ansi = re.compile(r'\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\x1b[@-_]')
def pump(wait=0.05):
    ready, _, _ = select.select([master], [], [], wait)
    if ready:
        try: data = os.read(master, 65536)
        except OSError as e:
            if e.errno == errno.EIO: return
            raise
        raw.extend(data)
        if len(raw) > 4 * 1024 * 1024:
            del raw[4 * 1024 * 1024:]; raise Exception('Terminal evidence exceeds 4 MiB')
        # Real terminals answer these probes; this tiny controller only answers
        # startup capability queries, never drives slash commands.
        if b'\x1b[6n' in data: os.write(master, b'\x1b[1;1R')
        if b'\x1b[c' in data: os.write(master, b'\x1b[?1;2c')
        if b'\x1b[>c' in data: os.write(master, b'\x1b[>0;0;0c')
def text(since=0): return ansi.sub('', bytes(raw[since:]).decode('utf-8', 'replace'))
def until(check, label):
    while time.monotonic() - start < 50:
        pump()
        if check(): return
        if proc.poll() is not None:
            if check(): return
            raise Exception('Host exited early: ' + label + '\n' + text()[-5000:])
    raise Exception('PTY timeout: ' + label + '\n' + text()[-5000:])
def phase(name):
    try:
        with open(root + '/phase.json') as f: return json.load(f)['name'] == name
    except (FileNotFoundError, json.JSONDecodeError): return False
def pause(seconds):
    end = time.monotonic() + seconds
    while time.monotonic() < end: pump()
report = {'mode': mode, 'hostPid': proc.pid, 'keys': [], 'sizes': [120]}
def key(value, label):
    os.write(master, value); report['keys'].append(label)
def terminate(_signum, _frame): raise Exception('PTY controller terminated')
signal.signal(signal.SIGTERM, terminate)
try:
    until(lambda: phase('live-chooser'), 'live chooser hook')
    with open(root + '/phase.json') as f: report['key'] = json.load(f)['key']
    pause(0.5)
    report['liveStart'] = len(raw)
    key(b'\r', 'Enter exact live session')
    until(lambda: 'LIVE_DELTA' in text(report['liveStart']), 'live assistant delta actually rendered')
    with open(root + '/viewer-attached', 'w') as f: f.write('viewer selected\n')
    until(lambda: 'LIVE_UPDATE_AFTER_ATTACH' in text(report['liveStart']), 'post-attach live delta rendered')
    key(b'\x1b[H', 'Home'); pause(0.3)
    until(lambda: report['key']['piSessionId'] in text(report['liveStart']), 'full exact Pi session ID rendered')
    until(lambda: 'TOOL_FILE_CONTENT' in text(report['liveStart']), 'actual read tool result card rendered')
    before = len(raw)
    resize(45, 30); os.kill(proc.pid, signal.SIGWINCH); report['sizes'].append(45); pause(0.4)
    assert len(raw) > before, 'Narrow resize did not produce a real redraw'
    key(b'\x1b[F', 'End'); pause(0.3)
    before = len(raw)
    resize(120, 40); os.kill(proc.pid, signal.SIGWINCH); report['sizes'].append(120); pause(0.4)
    assert len(raw) > before, 'Wide resize did not produce a real redraw'
    key(b'q', 'q close live')
    until(lambda: phase('closed-live'), 'live close returned without abort')
    with open(root + '/release', 'w') as f: f.write('release after viewer close\n')
    until(lambda: phase('saved-chooser'), 'saved history chooser')
    pause(0.5)
    report['savedStart'] = len(raw)
    key(b'\r', 'Enter exact saved session'); pause(0.4)
    key(b'\x1b[F', 'End saved')
    until(lambda: 'FINAL_AFTER_CLOSE' in text(report['savedStart']), 'saved final text rendered')
    until(lambda: 'saved' in text(report['savedStart']).lower(), 'saved source labelled')
    key(b'\x1b', 'Escape close saved')
    until(lambda: os.path.exists(root + '/result.json'), 'host result')
    until(lambda: proc.poll() is not None, 'orderly shutdown')
    assert proc.returncode == 0, 'Host exit: ' + str(proc.returncode)
    report['ok'] = True
except BaseException as e:
    report['ok'] = False; report['error'] = str(e)
finally:
    if proc.poll() is None:
        os.killpg(proc.pid, signal.SIGTERM)
        try: proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL); proc.wait(timeout=3)
    pump(0)
    os.close(master)
    report['hostExit'] = proc.returncode
    report['bytes'] = len(raw)
    with open(root + '/terminal.ansi', 'wb') as f: f.write(raw)
    with open(root + '/terminal.txt', 'w') as f: f.write(text())
    with open(root + '/pty-result.json', 'w') as f: json.dump(report, f, indent=2)
if not report['ok']: sys.exit(1)
`;

async function runMode(mode) {
  const root = join(evidence, mode);
  const requests = [];
  const budget = { hits: 0, max: 2 };
  let aborted = 0;
  let controller;
  let timer;
  const server = createServer(async (req, res) => {
    try {
      const body = await readFixtureBody(req, budget);
      assert.equal(req.headers.authorization, 'Bearer dummy-loopback-only');
      const input = JSON.parse(body);
      assert.equal(input.model, 'slow');
      requests.push(input);
      assert(requests.length <= 2, 'Unexpected additional model request');
      res.on('close', () => { if (!res.writableFinished) aborted++; });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'pty-fixture-' + requests.length, object: 'chat.completion.chunk', created: 1, model: 'slow', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
      emit({ role: 'assistant' });
      if (requests.length === 1) {
        assert(input.tools.some((tool) => tool.function.name === 'read'));
        emit({ content: 'TOOL_ACTIVITY: reading isolated fixture.\n' });
        emit({ tool_calls: [{ index: 0, id: 'fixture-read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: join(root, 'work/input.txt') }) } }] });
        emit({}, 'tool_calls');
      } else {
        assert(input.messages.some((message) => message.role === 'tool' && JSON.stringify(message.content).includes('TOOL_FILE_CONTENT')), 'Real SDK read-tool result must reach next model turn');
        emit({ content: 'LIVE_DELTA: streamed while model remains gated.\n' });
        writeFileSync(join(root, 'streaming'), 'second stream active\n');
        const deadline = Date.now() + 45000;
        let updated = false;
        while (!existsSync(join(root, 'release')) && !res.destroyed && Date.now() < deadline) {
          if (!updated && existsSync(join(root, 'viewer-attached'))) {
            updated = true;
            emit({ content: 'LIVE_UPDATE_AFTER_ATTACH: delivered to open viewer.\n' });
          }
          await sleep(25);
        }
        assert(updated, 'Viewer never requested post-attach live delta');
        assert(existsSync(join(root, 'release')), 'Stream gate never released');
        assert(!res.destroyed, 'Closing viewer aborted the model request');
        emit({ content: 'FINAL_AFTER_CLOSE: runner completed independently.\n' });
        emit({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    } catch (error) {
      writeFileSync(join(root, 'server-error.txt'), String(error.stack ?? error).slice(-16000));
      res.destroy(error);
    }
  });
  try {
    assertAncestorIsolation(root); cleanHostEnvironment(root);
    mkdirSync(join(root, 'work'), { recursive: true });
    writeFileSync(join(root, 'work/input.txt'), 'TOOL_FILE_CONTENT: isolated read result\n');
    writeFileSync(join(root, 'agent/auth.json'), '{}');
    writeFileSync(join(root, 'agent/settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'slow', packages: [], extensions: [], noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, enableInstallTelemetry: false, enableAnalytics: false, cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false } }));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    writeFileSync(join(root, 'agent/models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: origin + '/v1', apiKey: 'dummy-loopback-only', models: [{ id: 'slow', name: 'PTY fixture', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 256 }] } } }));
    // Imported by Node before CLI bootstrap, including model/resource loading.
    writeFileSync(join(root, 'guard.mjs'), guardSource(root, origin));
    writeFileSync(join(root, 'smoke.ts'), extensionSource(root));
    writeFileSync(join(root, 'pty-controller.py'), pythonSource);
    controller = spawnOwnedController('/usr/bin/python3', [join(root, 'pty-controller.py'), root, process.execPath, join(root, 'guard.mjs'), cli, mode], root, 55000);
    let diagnostics = '';
    for (const stream of [controller.stdout, controller.stderr]) stream.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-16000); });
    const exit = await new Promise((resolve, reject) => {
      controller.once('error', reject);
      controller.once('exit', (code, signal) => resolve({ code, signal }));
      timer = setTimeout(() => { controller.kill('SIGTERM'); reject(Error('Controller deadline exceeded')); }, 60000);
    });
    clearTimeout(timer);
    const ptyReport = existsSync(join(root, 'pty-result.json')) ? JSON.parse(readFileSync(join(root, 'pty-result.json'), 'utf8')) : {};
    const hostReport = existsSync(join(root, 'result.json')) ? JSON.parse(readFileSync(join(root, 'result.json'), 'utf8')) : {};
    assert.equal(exit.code, 0, JSON.stringify({ exit, ptyReport, hostReport, diagnostics }));
    assert.equal(ptyReport.ok, true);
    assert.equal(hostReport.ok, true, JSON.stringify(hostReport));
    assert.equal(requests.length, 2);
    assert.equal(aborted, 0);
    assert(!existsSync(join(root, 'server-error.txt')));
    assert(!existsSync(join(root, 'network-refused.txt')));
    assert.equal(budget.hits, 2);
    const result = { mode, localhostRequests: requests.length, aborted, ...hostReport, terminalBytes: ptyReport.bytes, sizes: ptyReport.sizes, hostExit: ptyReport.hostExit };
    results.push(result);
    console.log(`PASS actual Pi ${mode} PTY: exact session/live delta/read tool/resize/close without abort/saved history (${requests.length} localhost requests)`);
  } finally {
    clearTimeout(timer);
    try { await settleOwnedController(controller); }
    finally {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    }
    // Retain only bounded terminal/result evidence, never auth or session state.
    for (const leaf of ['home', 'tmp', 'agent', 'xdg', 'work', 'smoke.ts', 'guard.mjs', 'pty-controller.py', 'host-supervisor.py', '__pycache__', 'streaming', 'release', 'viewer-attached', 'phase.json']) rmSync(join(root, leaf), { recursive: true, force: true });
  }
}
try {
  await runMode('regular');
  await runMode('fullscreen');
  writeFileSync(join(evidence, 'summary.json'), JSON.stringify({ ok: true, results, evidenceLimit: 'Actual ANSI renderer emission, not a full terminal emulator/pixel acceptance', processes: 'one Python controller plus one Pi CLI host per mode, sequential' }, null, 2));
  console.log('PASS overlay host smoke; evidence: ' + evidence);
} catch (error) {
  console.error('FAIL overlay host smoke; evidence: ' + evidence);
  throw error;
}
