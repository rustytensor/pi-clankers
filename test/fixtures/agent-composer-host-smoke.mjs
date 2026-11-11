import assert from 'node:assert/strict';
import { assertAncestorIsolation, cleanHostEnvironment, guardSource, readFixtureBody, spawnOwnedController, settleOwnedController } from './host-fixture-safety.mjs';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Standalone: node test/fixtures/agent-composer-host-smoke.mjs
// Requires installed Pi 1.0 and Python 3's stdlib, never installs anything.
// Two actual PTYs; command-looking text only inside composer. Never terminal
// drive /clankers; no private SDK hooks or external model/provider TEST calls.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(repo, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
assert(existsSync(cli), 'Installed Pi CLI required');
const evidence = mkdtempSync(join(tmpdir(), 'clankers-composer-pty-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const operatorBody = '/not-a-command q s b\n  OPERATOR_LITERAL: keep indentation; !not-shell';

// The fixture extension registers the real extension exactly once and opens its
// captured UI handler with the returned structured control's SAME owner.
function extensionSource(root) {
  return `import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerClankersExtension } from ${JSON.stringify(join(repo, 'index.ts'))};
const root = ${JSON.stringify(root)};
const operatorBody = ${JSON.stringify(operatorBody)};
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
      writeFileSync(join(root, 'result.json'), JSON.stringify({ ok: false, failureDomain: 'host-runtime-or-contract', error: String(error.stack ?? error).slice(-16000) }));
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
    const key = { parentRunId: ref.parentRunId, memberRunId: ref.memberRunId, piSessionId: ref.piSessionId };
    async function receipts() {
      const result = await control.execute({ action: 'session.messages.list', ...key, limit: 10 });
      assert(result.ok, JSON.stringify(result));
      assert(Array.isArray(result.data.receipts), 'Contract requires data.receipts');
      return result.data.receipts;
    }
    assert.deepEqual(await receipts(), []);
    // Observe via the public control while the modal owns keyboard input. No
    // intercepted component callbacks, SDK handles, or duplicate registrations.
    const observeQueued = (async () => {
      await until(() => existsSync(join(root, 'draft-ready')), 'typed draft before explicit send');
      assert.deepEqual(await receipts(), [], 'Typing/Enter must not send');
      writeFileSync(join(root, 'draft-checked'), 'no implicit send');
      await until(async () => (await receipts()).length > 0, 'explicit Ctrl+s receipt');
      const [receipt] = await receipts();
      assert.deepEqual(receipt.key, key);
      assert.equal(receipt.body, operatorBody);
      assert.equal(receipt.mode, 'followUp');
      assert.equal(receipt.status, 'queued', 'Gated stream has not consumed input');
      assert.equal(typeof receipt.messageId, 'string');
      assert(receipt.messageId.length > 0);
      writeFileSync(join(root, 'receipt.json'), JSON.stringify(receipt));
      writeFileSync(join(root, 'queued-checked'), 'queued is not delivered');
      return receipt;
    })();
    // Attach rejection immediately: preserve observation failures separately
    // from any subsequent PTY/modal timeout, never an unhandled rejection.
    const queuedOutcome = observeQueued.then(receipt => ({ receipt }), error => {
      writeFileSync(join(root, 'observation-error.txt'), String(error.stack ?? error).slice(-16000));
      return { error };
    });
    phase('live-chooser', { key });
    await handler('sessions ' + launched.runId, ctx);
    const queued = await queuedOutcome;
    if (queued.error) throw queued.error;
    const receipt = queued.receipt;
    const afterClose = await show();
    assert.equal(afterClose.status, 'running', 'Closing viewer must not finish/abort runner');
    assert.equal(afterClose.nativeSessions[0].attachment, 'attached');
    const afterReceipts = await receipts();
    assert.equal(afterReceipts.length, 1, 'Empty-draft Ctrl+s must not send twice');
    assert.equal(afterReceipts[0].messageId, receipt.messageId);
    assert.equal(afterReceipts[0].status, 'queued');
    // Wrong exact native ID must fail closed without altering this receipt or
    // launching another session. No heuristic fallback selection.
    const wrong = await control.execute({ action: 'session.message.send', ...key, piSessionId: key.piSessionId + '-wrong', messageId: 'wrong-target-probe', body: 'DO_NOT_DELIVER', mode: 'followUp' });
    assert.equal(wrong.ok, false, JSON.stringify(wrong));
    assert.deepEqual(await receipts(), afterReceipts);
    phase('closed-live');
    await until(() => existsSync(join(root, 'release')), 'controller release');
    await until(() => existsSync(join(root, 'reply-streaming')), 'literal provider follow-up request');
    await until(async () => (await receipts())[0]?.status === 'delivered', 'native ID consumption');
    const delivered = (await receipts())[0];
    assert.equal(delivered.messageId, receipt.messageId);
    assert.deepEqual(delivered.key, key);
    assert.equal((await show()).status, 'running', 'Delivered does not imply agent completion');
    writeFileSync(join(root, 'delivered-checked'), JSON.stringify(delivered));
    await until(async () => {
      const run = await show();
      return run.status === 'done' && run.nativeSessions[0].attachment === 'disposed';
    }, 'completed and disposed');
    const done = await show();
    const bytes = readFileSync(ref.sessionFile);
    const entries = bytes.toString('utf8').trim().split('\\n').map(line => JSON.parse(line));
    assert(entries.some(e => e.type === 'message' && e.message.role === 'toolResult' && e.message.toolName === 'read'));
    const operators = entries.filter(e => e.type === 'custom_message' && e.customType === 'pi-clankers/operator/v1');
    assert.equal(operators.length, 1, 'Exactly one native operator history entry');
    assert.equal(operators[0].content, operatorBody);
    assert.equal(operators[0].details.messageId, receipt.messageId);
    assert(bytes.includes(Buffer.from('AGENT_REPLY_TO_OPERATOR')));
    assert.equal(done.nativeSessions.length, 1, 'No wrong-target launch/reconnect');
    phase('saved-chooser');
    await handler('sessions ' + launched.runId, ctx);
    assert.deepEqual(readFileSync(ref.sessionFile), bytes, 'Readonly inspection must preserve JSONL byte identity');
    const finalReceipts = await receipts();
    assert.equal(finalReceipts.length, 1, 'Readonly view must not send/replay');
    assert.equal(finalReceipts[0].messageId, receipt.messageId);
    assert.equal(finalReceipts[0].status, 'delivered');
    cleanup(); cleanup();
    writeFileSync(join(root, 'result.json'), JSON.stringify({ ok: true, registrations, runId: launched.runId, piSessionId: ref.piSessionId, status: done.status, attachment: done.nativeSessions[0].attachment, jsonlUnchanged: true, exactKey: key, messageId: receipt.messageId, queuedStatus: receipt.status, deliveredStatus: delivered.status, nativeOperatorEntries: operators.length }));
    phase('complete');
    ctx.shutdown();
  }
}
`;
}

// PTY navigation and isolated operator composer input only. Evidence is the real
// terminal byte stream, not mocked component.render output. ANSI stripping is
// not a full terminal emulator: emission/input/resize, not pixel correctness.
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
        # Answer startup terminal probes; never drive slash commands.
        if b'\x1b[6n' in data: os.write(master, b'\x1b[1;1R')
        if b'\x1b[c' in data: os.write(master, b'\x1b[?1;2c')
        if b'\x1b[>c' in data: os.write(master, b'\x1b[>0;0;0c')
def text(since=0): return ansi.sub('', bytes(raw[since:]).decode('utf-8', 'replace'))
def until(check, label):
    while time.monotonic() - start < 50:
        pump()
        if check(): return
        if proc.poll() is not None:
            # Exit can become observable between the condition and this poll.
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
    composeStart = len(raw)
    key(b'c', 'c enter composer')
    until(lambda: 'ctrl+s' in text(composeStart).lower(), 'public Editor composer hint emitted')
    key(b'/not-a-command q s b', 'literal command-looking first line'); pause(0.15)
    key(b'\r', 'Enter inserts newline, not send'); pause(0.15)
    key(b'  OPERATOR_LITERAL: keep indentation; !not-shell', 'indented literal second line')
    pause(0.3)
    with open(root + '/draft-ready', 'w') as f: f.write('typed without send')
    until(lambda: os.path.exists(root + '/draft-checked'), 'no implicit Enter delivery')
    # Resize with draft present, then explicit send. Actual terminal dimensions,
    # not calls to component.render().
    before = len(raw)
    resize(45, 30); os.kill(proc.pid, signal.SIGWINCH); report['sizes'].append(45); pause(0.4)
    assert len(raw) > before, 'Composer narrow resize did not redraw'
    before = len(raw)
    resize(120, 40); os.kill(proc.pid, signal.SIGWINCH); report['sizes'].append(120); pause(0.4)
    assert len(raw) > before, 'Composer wide resize did not redraw'
    key(b'\x13', 'Ctrl+s explicit send')
    until(lambda: os.path.exists(root + '/queued-checked'), 'queued exact-ID receipt while gated')
    until(lambda: 'queued' in text(composeStart).lower(), 'queued receipt emitted')
    key(b'\x13', 'Ctrl+s empty draft does not resend'); pause(0.2)
    key(b'\x1b', 'Escape exits compose only'); pause(0.3)
    assert not phase('closed-live'), 'First Escape closed viewer instead of exiting compose'
    key(b'\x1b', 'Escape closes live without abort')
    until(lambda: phase('closed-live'), 'live close returned without abort')
    with open(root + '/release', 'w') as f: f.write('release after viewer close\n')
    until(lambda: os.path.exists(root + '/delivered-checked'), 'delivered native consumption while reply gated')
    with open(root + '/release-reply', 'w') as f: f.write('release reply after delivered proof')
    until(lambda: phase('saved-chooser'), 'saved history chooser')
    pause(0.5)
    report['savedStart'] = len(raw)
    key(b'\r', 'Enter exact saved session'); pause(0.4)
    key(b'\x1b[F', 'End saved')
    until(lambda: 'AGENT_REPLY_TO_OPERATOR' in text(report['savedStart']), 'saved agent reply rendered')
    until(lambda: 'OPERATOR_LITERAL' in text(report['savedStart']), 'saved literal operator history rendered')
    until(lambda: 'saved' in text(report['savedStart']).lower(), 'saved source labelled')
    before = len(raw)
    key(b'c', 'c cannot compose in readonly saved view'); pause(0.3)
    assert 'ctrl+s' not in text(before).lower(), 'Saved view entered composer'
    key(b'\x13', 'Ctrl+s readonly does not send'); pause(0.2)
    key(b'\x1b', 'Escape close saved')
    until(lambda: os.path.exists(root + '/result.json'), 'host result')
    until(lambda: proc.poll() is not None, 'orderly shutdown')
    assert proc.returncode == 0, 'Host exit: ' + str(proc.returncode)
    report['ok'] = True
except BaseException as e:
    report['ok'] = False; report['failureDomain'] = 'pty-controller-or-emission'; report['error'] = str(e)
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
  const budget = { hits: 0, max: 3 };
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
      assert(requests.length <= 3, 'Unexpected additional model request');
      res.on('close', () => { if (!res.writableFinished) aborted++; });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'pty-fixture-' + requests.length, object: 'chat.completion.chunk', created: 1, model: 'slow', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
      emit({ role: 'assistant' });
      if (requests.length === 1) {
        assert(input.tools.some((tool) => tool.function.name === 'read'));
        emit({ content: 'TOOL_ACTIVITY: reading isolated fixture.\n' });
        emit({ tool_calls: [{ index: 0, id: 'fixture-read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: join(root, 'work/input.txt') }) } }] });
        emit({}, 'tool_calls');
      } else if (requests.length === 2) {
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
        emit({ content: 'FINAL_AFTER_CLOSE: original turn ended independently.\n' });
        emit({}, 'stop');
      } else {
        const literal = input.messages.filter(message => message.role === 'user' && (typeof message.content === 'string' ? message.content : message.content?.map(block => block.text ?? '').join('')) === operatorBody);
        assert.equal(literal.length, 1, 'Provider receives exactly one literal multiline operator body');
        const receipt = JSON.parse(readFileSync(join(root, 'receipt.json'), 'utf8'));
        assert(!JSON.stringify(input.messages).includes(receipt.messageId), 'Receipt ID leaked into model context');
        assert(!JSON.stringify(input.messages).includes('pi-clankers/operator/v1'), 'Custom metadata leaked into model context');
        assert(!JSON.stringify(input.messages).includes('DO_NOT_DELIVER'), 'Wrong-target input delivered');
        emit({ content: 'AGENT_REPLY_TO_OPERATOR: received literal multiline input.\n' });
        writeFileSync(join(root, 'reply-streaming'), 'native follow-up consumed');
        const deadline = Date.now() + 45000;
        while (!existsSync(join(root, 'release-reply')) && !res.destroyed && Date.now() < deadline) await sleep(25);
        assert(existsSync(join(root, 'release-reply')), 'Reply gate never released');
        assert(!res.destroyed, 'Reply stream aborted');
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
    const serverError = existsSync(join(root, 'server-error.txt')) ? readFileSync(join(root, 'server-error.txt'), 'utf8') : undefined;
    const observationError = existsSync(join(root, 'observation-error.txt')) ? readFileSync(join(root, 'observation-error.txt'), 'utf8') : undefined;
    assert.equal(exit.code, 0, JSON.stringify({ exit, ptyReport, hostReport, serverError, observationError, diagnostics }));
    assert.equal(ptyReport.ok, true);
    assert.equal(hostReport.ok, true, JSON.stringify(hostReport));
    assert.equal(requests.length, 3);
    assert.equal(aborted, 0);
    assert(!existsSync(join(root, 'server-error.txt')));
    assert(!existsSync(join(root, 'network-refused.txt')));
    assert.equal(budget.hits, 3);
    const result = { mode, localhostRequests: requests.length, aborted, ...hostReport, terminalBytes: ptyReport.bytes, sizes: ptyReport.sizes, hostExit: ptyReport.hostExit };
    writeFileSync(join(root, 'checks.json'), JSON.stringify(result, null, 2));
    results.push(result);
    console.log(`PASS actual Pi ${mode} PTY: exact session/literal composer queued+delivered/read tool/resize/close without abort/saved byte identity (${requests.length} localhost requests)`);
  } finally {
    clearTimeout(timer);
    try { await settleOwnedController(controller); }
    finally {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    }
    // Retain only bounded terminal/result evidence, never auth or session state.
    for (const leaf of ['home', 'tmp', 'agent', 'xdg', 'work', 'smoke.ts', 'guard.mjs', 'pty-controller.py', 'host-supervisor.py', '__pycache__', 'streaming', 'release', 'viewer-attached', 'phase.json', 'receipt.json', 'draft-ready', 'draft-checked', 'queued-checked', 'delivered-checked', 'reply-streaming', 'release-reply']) rmSync(join(root, leaf), { recursive: true, force: true });
  }
}
try {
  await runMode('regular');
  await runMode('fullscreen');
  writeFileSync(join(evidence, 'summary.json'), JSON.stringify({ ok: true, results, evidenceLimit: 'Actual ANSI renderer emission, not a full terminal emulator/pixel acceptance', processes: 'one Python controller plus one Pi CLI host per mode, sequential' }, null, 2));
  console.log('PASS composer host smoke; evidence: ' + evidence);
} catch (error) {
  console.error('FAIL composer host smoke; evidence: ' + evidence);
  throw error;
}
