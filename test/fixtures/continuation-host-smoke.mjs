import assert from 'node:assert/strict';
import { assertAncestorIsolation, cleanHostEnvironment, guardSource, readFixtureBody, spawnOwnedController, settleOwnedController } from './host-fixture-safety.mjs';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Standalone AFTER parent applies/grants: node test/fixtures/continuation-host-smoke.mjs
// Installed Pi + Python stdlib only, four sequential genuine Pi CLI PTYs.
// Normal CURRENT child resources, clean dummy env and exact endpoint/socket guard.
// UI navigation only; automation never terminal-drives /zerg or provider TEST.
// ANSI emission/input/redraw evidence, not manual pixel/layout acceptance.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(repo, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
assert(existsSync(cli), 'Installed Pi CLI required');
const evidence = mkdtempSync(join(tmpdir(), 'zerg-continuation-pty-'));
const body = '/never-expand q b c n\n  PTY_NEW_LITERAL_TASK: preserve indentation; !not-shell';
const results = [], sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function observerSource(root) {
  return `import { appendFileSync } from 'node:fs';
const path = ${JSON.stringify(join(root, 'hooks.jsonl'))};
export default function(pi) {
  function put(kind, extra = {}) { appendFileSync(path, JSON.stringify({ kind, ...extra }) + '\\n'); }
  put('factory');
  pi.on('session_start', (_event, ctx) => put('session_start', { id: ctx.sessionManager.getSessionId() }));
  pi.on('input', event => { put('input', { text: event.text }); return { action: 'continue' }; });
  pi.on('before_agent_start', event => { put('before_agent_start', { prompt: event.prompt }); });
  pi.registerCommand('never-expand', { description: 'forbidden dispatch', handler: () => { put('COMMAND_DISPATCH_FORBIDDEN'); throw Error('Literal continuation command dispatched'); } });
}`;
}
function extensionSource(root, phaseDir, restarting) {
  return `import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerZergSwarmExtension } from ${JSON.stringify(join(repo, 'index.ts'))};
const root = ${JSON.stringify(root)}, phaseDir = ${JSON.stringify(phaseDir)}, restarting = ${JSON.stringify(restarting)}, body = ${JSON.stringify(body)};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) { const end = Date.now() + 45000; while (Date.now() < end) { if (await check()) return; await sleep(25); } throw Error('Timeout: ' + label); }
function put(name, value) { writeFileSync(join(phaseDir, name), JSON.stringify(value)); }
function phase(name, extra = {}) { put('phase.json', { name, ...extra }); }
function hash(path) { return createHash('sha256').update(readFileSync(path)).digest('hex'); }
function trace() { const path = join(root, 'hooks.jsonl'); return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse) : []; }
function keyOf(ref) { return { parentRunId: ref.parentRunId, memberRunId: ref.memberRunId, piSessionId: ref.piSessionId }; }
export default function(pi) {
  let handler, registrations = 0, started = false, cleaned = false;
  const proxy = new Proxy(pi, { get(target, key) {
    if (key === 'registerCommand') return (name, options) => { if (name === 'zerg') { handler = options.handler; registrations++; } return target.registerCommand(name, options); };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  const registration = registerZergSwarmExtension(proxy, { persistence: { enabled: true, snapshotFile: join(root, 'snapshot.json') } });
  const control = registration.control;
  function cleanup() { if (cleaned) return; cleaned = true; registration.dispose(); registration.dispose(); }
  pi.on('session_shutdown', cleanup);
  pi.on('session_start', (_event, ctx) => {
    if (started) return; started = true;
    setTimeout(() => void smoke(ctx).catch(error => { put('result.json', { ok: false, failureDomain: 'host-runtime-or-contract', error: String(error.stack ?? error).slice(-16000) }); try { cleanup(); } finally { ctx.shutdown(); } }), 0);
  });
  async function execute(input) { const result = await control.execute(input); assert(result.ok, JSON.stringify(result)); return result; }
  async function show(runId) { return (await execute({ action: 'runs.show', runId })).data.run; }
  async function receipts(key) { return (await execute({ action: 'session.messages.list', ...key, limit: 128 })).data.receipts; }
  async function complete(runId) { await until(async () => { const run = await show(runId); return run.status === 'done' && run.nativeSessions?.every(ref => ref.attachment === 'disposed'); }, 'terminal disposed'); return show(runId); }
  async function smoke(ctx) {
    assert.equal(ctx.mode, 'tui'); assert.equal(registrations, 1); assert.equal(typeof handler, 'function');
    if (restarting) {
      const saved = JSON.parse(readFileSync(join(root, 'expected.json'), 'utf8'));
      const source = await show(saved.sourceRunId), copied = await show(saved.newRunId);
      assert(source.nativeSessions.every(ref => ref.attachment !== 'attached'));
      assert(copied.nativeSessions.every(ref => ref.attachment !== 'attached'), 'Restart is not SDK reconnection');
      assert.deepEqual(source.nativeSessions.map(keyOf), saved.sourceKeys);
      assert.deepEqual(copied.nativeSessions.map(keyOf), saved.newKeys);
      const before = trace().length, beforeReceipts = await receipts(saved.key);
      for (const [path, digest] of Object.entries(saved.hashes)) assert.equal(hash(path), digest);
      phase('restart-chooser', { key: saved.key });
      await handler('sessions ' + saved.newRunId, ctx);
      for (const [path, digest] of Object.entries(saved.hashes)) assert.equal(hash(path), digest, 'Inspection/restart must not mutate source or copied history');
      assert.equal(trace().length, before, 'Inspection never reloads current child resources or sends input');
      assert.deepEqual(await receipts(saved.key), beforeReceipts, 'No receipts/queues replayed');
      assert.deepEqual((await show(saved.newRunId)).nativeSessions.map(keyOf), saved.newKeys);
      cleanup(); put('result.json', { ok: true, restarting: true, sourceRunId: saved.sourceRunId, newRunId: saved.newRunId, exactKey: saved.key, jsonlUnchanged: true, zeroChildHooks: true }); phase('complete'); ctx.shutdown(); return;
    }
    await execute({ action: 'agents.create', id: 'pty-selected', model: 'fixture/old', tools: ['read'], prompt: 'OLD_AUTHORITY: read only supplied file then report original output.' });
    const launch = await execute({ action: 'run', agent: 'pty-selected', task: 'Read ' + join(root, 'work/input.txt'), background: true });
    const sourceRun = await complete(launch.runId); assert.equal(sourceRun.nativeSessions.length, 1);
    const source = sourceRun.nativeSessions[0], sourceHash = hash(source.sessionFile);
    const rows = readFileSync(source.sessionFile, 'utf8').trim().split('\\n').map(JSON.parse);
    const selected = rows.filter(row => row.type === 'message' && row.message.role === 'assistant').at(-1); assert(selected);
    const key = keyOf(source);
    await execute({ action: 'agents.update', id: 'pty-selected', model: 'fixture/current', tools: ['read'], prompt: 'CURRENT_AUTHORITY: execute only the reviewed new literal task; no shell/write/external providers.' });
    writeFileSync(join(root, 'work/AGENTS.md'), 'CURRENT_CONTEXT_NORMAL_RESOURCE: remain within task scope.\\n');
    const hooksBefore = trace().length, stateBefore = JSON.stringify(control.getState());
    let stop = false;
    const observing = (async () => {
      for (const name of ['draft-ready', 'review-ready', 'review-cancelled', 'confirm-ready']) {
        await until(() => stop || existsSync(join(phaseDir, name)), name); if (stop) return;
        assert.equal(trace().length, hooksBefore, name + ' executes ZERO child resource factories/start/input/before hooks');
        assert.equal(JSON.stringify(control.getState()), stateBefore, name + ' creates no run or persisted queue');
        assert.equal(hash(source.sessionFile), sourceHash);
        put(name + '-checked', { ok: true });
      }
    })().then(() => ({}), error => { put('observation-error.json', { error: String(error.stack ?? error).slice(-16000) }); return { error }; });
    phase('source-chooser', { key, entryId: selected.id });
    await handler('sessions ' + launch.runId, ctx);
    stop = true; const observed = await observing; if (observed.error) throw observed.error;
    assert(existsSync(join(phaseDir, 'review-cancelled-checked')), 'Explicit review cancellation was exercised');
    const runs = (await execute({ action: 'runs.list' })).data.runs.filter(run => run.runId !== launch.runId);
    assert.equal(runs.length, 1, 'One new selected-agent run, no sibling/team/composer launches');
    const stillActive = await show(runs[0].runId);
    assert.equal(stillActive.status, 'running', 'Closing continuation/original UI does not stop the new task');
    assert.equal(stillActive.nativeSessions.length, 1); assert.equal(stillActive.nativeSessions[0].attachment, 'attached');
    put('oldviewer-closed-checked', { ok: true });
    const fresh = await complete(runs[0].runId); assert.equal(fresh.nativeSessions.length, 1);
    const copied = fresh.nativeSessions[0];
    assert.equal(copied.agentDefinitionId, source.agentDefinitionId);
    assert.notEqual(fresh.runId, source.parentRunId); assert.notEqual(fresh.taskId, sourceRun.taskId);
    assert.notEqual(copied.memberRunId, source.memberRunId); assert.notEqual(copied.piSessionId, source.piSessionId); assert.notEqual(copied.sessionFile, source.sessionFile);
    assert.equal(hash(source.sessionFile), sourceHash, 'Confirmed start must never rewrite original JSONL');
    assert.deepEqual(await receipts(key), [], 'n is not c: source message receipts unchanged');
    assert.deepEqual(await receipts(keyOf(copied)), [], 'No inherited queued receipts replayed');
    const additions = trace().slice(hooksBefore);
    assert.equal(additions.filter(row => row.kind === 'session_start').length, 1);
    assert.equal(additions.find(row => row.kind === 'session_start').id, copied.piSessionId);
    assert.deepEqual(additions.filter(row => row.kind === 'input').map(row => row.text), [body]);
    assert.deepEqual(additions.filter(row => row.kind === 'before_agent_start').map(row => row.prompt), [body]);
    assert(!trace().some(row => row.kind === 'COMMAND_DISPATCH_FORBIDDEN'));
    const newRows = readFileSync(copied.sessionFile, 'utf8').trim().split('\\n').map(JSON.parse);
    assert.equal(fresh.task, body, 'Task owner retains precisely the reviewed new task');
    assert(fresh.finalSummary?.includes('PTY_NEW_OUTPUT_ONLY')); assert(!fresh.finalSummary?.includes('PTY_OLD_FINAL_ONLY'), 'New outcome never takes inherited assistant completion');
    assert.equal(newRows[0].id, copied.piSessionId); assert.equal(newRows[0].parentSession, source.sessionFile);
    const own = newRows.filter(row => row.type === 'custom' && row.customType === 'pi-zerg-swarm/native-session/v1'); assert.equal(own.length, 1);
    const lineage = newRows.filter(row => row.type === 'custom' && row.customType === 'pi-zerg-swarm/native-continuation/v1'); assert.equal(lineage.length, 1);
    const { attachment: _attachment, disposedAt: _disposedAt, recoveredAt: _recoveredAt, ...identity } = source;
    assert.deepEqual(lineage[0].data.source, identity); assert.equal(lineage[0].data.entryId, selected.id); assert.equal(lineage[0].data.sourceFingerprint, sourceHash); assert.match(lineage[0].data.policyDigest, /^[a-f0-9]{64}$/);
    const ancestors = newRows.filter(row => row.type === 'custom' && ['pi-zerg-swarm/native-ancestor-session/v1', 'pi-zerg-swarm/native-ancestor-continuation/v1'].includes(row.customType));
    assert.equal(ancestors.length, 1); assert.deepEqual(ancestors[0].data, identity);
    assert.deepEqual(lineage[0].data.ancestors, ancestors.map(row => ({ id: row.id, customType: row.customType, dataDigest: createHash('sha256').update(JSON.stringify(row.data)).digest('hex') })));
    for (const row of rows.slice(1)) assert.deepEqual(newRows.find(entry => entry.id === row.id), row.type === 'custom' && row.customType === 'pi-zerg-swarm/native-session/v1' ? { ...row, customType: 'pi-zerg-swarm/native-ancestor-session/v1' } : row, 'Copied opaque history is unchanged apart from metadata namespace');
    phase('new-chooser', { key: keyOf(copied) });
    const beforeView = trace().length;
    await handler('sessions ' + fresh.runId, ctx);
    assert.equal(trace().length, beforeView, 'Saved copied viewer does not reopen SDK');
    const hashes = { [source.sessionFile]: sourceHash, [copied.sessionFile]: hash(copied.sessionFile) };
    const expected = { sourceRunId: launch.runId, newRunId: fresh.runId, sourceKeys: [key], newKeys: [keyOf(copied)], key: keyOf(copied), hashes, entryId: selected.id };
    writeFileSync(join(root, 'expected.json'), JSON.stringify(expected));
    cleanup(); put('result.json', { ok: true, restarting: false, registrations, sourceRunId: launch.runId, newRunId: fresh.runId, exactKey: keyOf(copied), entryId: selected.id, jsonlUnchanged: true, literalReviewedTask: true, oneSelectedAgentOnly: true }); phase('complete'); ctx.shutdown();
  }
}
`;
}

const pythonSource = String.raw`import errno, fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time
root, phase_dir, node, cli, mode, restarting = sys.argv[1:]
master, slave = pty.openpty()
def resize(cols, rows): fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
resize(120, 42)
env = dict(os.environ); env['TERM'] = 'xterm-256color'
args = [node, '--import', root + '/guard.mjs', cli, '--offline', '--no-session', '--no-approve', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-tools', '--model', 'fixture/current', '--thinking', 'off', '--tui-mode', mode, '-e', phase_dir + '/smoke.ts']
proc = subprocess.Popen(args, cwd=root + '/work', env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
raw = bytearray(); start = time.monotonic()
ansi = re.compile(r'\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\x1b[@-_]')
def pump(wait=0.04):
    ready, _, _ = select.select([master], [], [], wait)
    if ready:
        try: data = os.read(master, 65536)
        except OSError as error:
            if error.errno == errno.EIO: return
            raise
        raw.extend(data)
        if len(raw) > 4 * 1024 * 1024:
            del raw[4 * 1024 * 1024:]; raise Exception('Terminal evidence exceeds 4 MiB')
        if b'\x1b[6n' in data: os.write(master, b'\x1b[1;1R')
        if b'\x1b[c' in data: os.write(master, b'\x1b[?1;2c')
        if b'\x1b[>c' in data: os.write(master, b'\x1b[>0;0;0c')
def text(since=0): return ansi.sub('', bytes(raw[since:]).decode('utf-8', 'replace'))
def emitted(value, since=0): return value in text(since) or re.sub(r'\s+', '', value) in re.sub(r'\s+', '', text(since))
def read(name):
    try:
        with open(phase_dir + '/' + name) as f: return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError): return {}
def until(check, label):
    while time.monotonic() - start < 100:
        pump()
        if check(): return
        if read('result.json').get('ok') is False: raise Exception('Host failure: ' + str(read('result.json')))
        if read('observation-error.json'): raise Exception('Observation failure: ' + str(read('observation-error.json')))
        if proc.poll() is not None:
            # Exit can become observable between the condition and this poll.
            if check(): return
            raise Exception('Host exited early: ' + label + '\n' + text()[-5000:])
    raise Exception('PTY timeout: ' + label + '\n' + text()[-5000:])
def phase(name): return read('phase.json').get('name') == name
def pause(seconds=0.2):
    end = time.monotonic() + seconds
    while time.monotonic() < end: pump()
report = {'mode': mode, 'restarting': restarting == '1', 'hostPid': proc.pid, 'keys': [], 'sizes': [120]}
def key(value, label): os.write(master, value); report['keys'].append(label); pause(0.07)
def touch(name):
    with open(phase_dir + '/' + name, 'w') as f: f.write('controller handshake\n')
def resized():
    for cols, rows in [(45, 30), (120, 42)]:
        before = len(raw); resize(cols, rows); os.kill(proc.pid, signal.SIGWINCH); report['sizes'].append(cols); pause(0.4)
        assert len(raw) > before, 'Resize did not produce an actual renderer emission'
def terminate(_signum, _frame): raise Exception('Controller terminated')
signal.signal(signal.SIGTERM, terminate)
try:
    def saved_view(chooser, output, continuation=False):
        until(lambda: phase(chooser), chooser); pause(0.4)
        begin = len(raw); key(b'\r', 'Enter exact saved session'); pause(0.3); key(b'\x1b[F', 'End saved transcript')
        until(lambda: emitted(output, begin), 'actual saved assistant output rendered')
        until(lambda: emitted('saved', begin), 'validated saved source label')
        before = len(raw); key(b'c', 'c stays disabled in saved source'); pause(0.2)
        assert 'Enter newline' not in text(before), 'Saved view incorrectly entered live composer'
        key(b'\x13', 'Ctrl+s in saved view does not send'); pause(0.15)
        key(b'b', 'b remains inspection only'); pause(0.2)
        key(b'\x1b[B', 'Down exact finalized branch'); key(b'\r', 'Enter inspect branch locally'); pause(0.3)
        key(b'\x1b[F', 'End explicitly inspected branch'); until(lambda: emitted(output, begin), 'branch output remains available')
        if continuation:
            before = len(raw); key(b'n', 'n draft only on fresh restart'); until(lambda: emitted('clankers NEW continuation', before), 'new editor on recovered saved source')
            until(lambda: emitted('normalizes CRLF/CR', before), 'normal Pi editing disclosure')
            key(b'\x1b', 'Escape draft without preparing'); pause(0.3)
        key(b'\x1b', 'Escape saved viewer without reconnect')
    if restarting == '1':
        saved_view('restart-chooser', 'PTY_NEW_OUTPUT_ONLY', True)
    else:
        until(lambda: phase('source-chooser'), 'source chooser'); pause(0.4)
        source_data = read('phase.json'); report['sourceKey'] = source_data['key']; report['entryId'] = source_data['entryId']
        begin = len(raw); key(b'\r', 'Enter exact disposed source'); pause(0.3); key(b'\x1b[F', 'End original saved history')
        until(lambda: emitted('PTY_OLD_FINAL_ONLY', begin), 'original saved assistant output')
        before = len(raw); key(b'c', 'c saved composer remains disabled'); pause(0.2)
        assert 'Enter newline' not in text(before), 'n integration changed saved c behavior'
        key(b'\x13', 'Ctrl+s saved source sends nothing')
        key(b'b', 'b inspect original branch, not continue'); pause(0.2)
        key(b'\x1b[B', 'Down exact original finalized branch'); key(b'\r', 'Enter inspect original entry'); pause(0.3)
        draft_start = len(raw); key(b'n', 'n opens NEW task editor only')
        until(lambda: emitted('clankers NEW continuation', draft_start), 'new task editor')
        until(lambda: emitted(source_data['entryId'], draft_start), 'last rendered exact inspected entry bound')
        until(lambda: emitted('normalizes CRLF/CR', draft_start), 'normal Pi Editor disclosure visible before review')
        task = b'/never-expand q b c n\n  PTY_NEW_LITERAL_TASK: preserve indentation; !not-shell'
        # Split bracketed paste: embedded command/shortcut-looking text remains one
        # literal packet. No Enter, suffix key, or first half can start a task.
        key(b'\x1b[200~' + task[:24], 'Begin atomic multiline literal paste'); pause(0.15)
        key(task[24:] + b'\x1b[201~', 'Finish atomic multiline literal paste'); pause(0.3)
        touch('draft-ready'); until(lambda: read('draft-ready-checked').get('ok'), 'draft zero child hooks/model calls')
        resized()
        review_start = len(raw); key(b'\r', 'Enter prepares REVIEW ONLY')
        until(lambda: emitted('Review only.', review_start), 'separate review screen rendered')
        until(lambda: emitted('CURRENT policy', review_start), 'current policy disclosure')
        for _ in range(12):
            if emitted('fixture/current', review_start) and emitted('CURRENT_AUTHORITY', review_start): break
            key(b'\x1b[6~', 'PgDn inspect full current policy')
        assert emitted('fixture/current', review_start), 'Current resolved model never displayed'
        assert emitted('CURRENT_AUTHORITY', review_start), 'Current definition prompt never displayed'
        key(b'\x1b[F', 'End review exact new literal body')
        until(lambda: emitted('PTY_NEW_LITERAL_TASK', review_start), 'review displays reviewed body')
        touch('review-ready'); until(lambda: read('review-ready-checked').get('ok'), 'review zero effects')
        key(b'\r', 'Enter review NEVER executes'); key(b'\x13', 'Ctrl+s review NEVER executes'); pause(0.3)
        key(b'\x1b', 'Escape explicitly discards review'); pause(0.3)
        touch('review-cancelled'); until(lambda: read('review-cancelled-checked').get('ok'), 'cancelled review preserves state/source and zero effects')
        key(b'n', 'n opens fresh draft, no stale token reuse'); pause(0.2)
        key(b'\x1b[200~' + task + b'\x1b[201~', 'Paste exact new task for explicit authorization'); pause(0.2)
        second_review = len(raw); key(b'\x13', 'Ctrl+s prepares second REVIEW ONLY')
        until(lambda: emitted('Review only.', second_review), 'fresh separate review screen')
        resized(); key(b'\x1b[F', 'End confirm reviewed literal body'); until(lambda: emitted('PTY_NEW_LITERAL_TASK', second_review), 'exact second reviewed body')
        key(b'\r', 'Enter second review remains readonly'); key(b'\x13', 'Ctrl+s second review remains readonly'); pause(0.3)
        touch('confirm-ready'); until(lambda: read('confirm-ready-checked').get('ok'), 'no effects before dedicated explicitconfirm')
        confirmed = len(raw); key(b'\x19', 'Ctrl+y ONLY explicit NEW task authorization'); pause(0.4)
        key(b'\x1b[F', 'End destination identity disclosure')
        until(lambda: emitted('Destination run:', confirmed), 'new destination ID, not successful completion claim')
        until(lambda: emitted('Original viewer has not been retargeted', confirmed), 'old viewer target retained')
        until(lambda: os.path.exists(phase_dir + '/current-streaming'), 'actual new task stream active independently of UI')
        returned = len(raw); key(b'\x1b', 'Escape result returns same original viewer'); pause(0.3)
        key(b'\x1b[F', 'End original after new launch'); pause(0.2)
        until(lambda: emitted('PTY_OLD_FINAL_ONLY', returned), 'same original history actually rendered after new task start')
        key(b'\x1b', 'Escape original does not abort new task')
        until(lambda: read('oldviewer-closed-checked').get('ok'), 'new task remains attached/running after UI close')
        touch('release-current')
        saved_view('new-chooser', 'PTY_NEW_OUTPUT_ONLY')
    until(lambda: os.path.exists(phase_dir + '/result.json'), 'host result')
    until(lambda: proc.poll() is not None, 'orderly host exit')
    assert proc.returncode == 0, 'Host exit ' + str(proc.returncode)
    report['ok'] = True
except BaseException as error:
    report['ok'] = False; report['failureDomain'] = 'pty-controller-or-emission'; report['error'] = str(error)
finally:
    if proc.poll() is None:
        os.killpg(proc.pid, signal.SIGTERM)
        try: proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL); proc.wait(timeout=3)
    pump(0); os.close(master)
    report['hostExit'] = proc.returncode; report['bytes'] = len(raw)
    with open(phase_dir + '/terminal.ansi', 'wb') as f: f.write(raw)
    with open(phase_dir + '/terminal.txt', 'w') as f: f.write(text())
    with open(phase_dir + '/pty-result.json', 'w') as f: json.dump(report, f, indent=2)
if not report['ok']: sys.exit(1)
`;

async function runMode(mode) {
  const root = join(evidence, mode);
  const requests = [], counts = { old: 0, current: 0 };
  const budget = { hits: 0, max: 3 };
  let restarting = false, serverFailure, aborted = 0, controller, timer;
  const server = createServer(async (req, res) => {
    try {
      const bytes = await readFixtureBody(req, budget);
      assert(!restarting, 'Fresh inspection host must make ZERO model calls');
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer dummy-continuation-only');
      const input = JSON.parse(bytes); assert(['old', 'current'].includes(input.model)); assert.equal(input.stream, true);
      const turn = ++counts[input.model]; assert(turn <= (input.model === 'old' ? 2 : 1)); requests.push({ model: input.model, turn }); assert(requests.length <= 3);
      assert.deepEqual((input.tools ?? []).map(tool => tool.function.name), ['read']);
      if (input.model === 'current') {
        assert.equal(counts.old, 2);
        assert(existsSync(join(root, 'live/review-cancelled-checked')), 'Current run started before cancellation/explicit review exercise');
        const text = message => typeof message.content === 'string' ? message.content : message.content?.map(block => block.text ?? '').join('');
        assert.equal(text(input.messages.at(-1)), body, 'Reviewed literal task is the exact last user input');
        const system = input.messages.filter(message => message.role === 'system').map(text).join('\n');
        assert(system.includes('CURRENT_AUTHORITY')); assert(system.includes('CURRENT_CONTEXT_NORMAL_RESOURCE')); assert(system.includes('CURRENT_SKILL_NORMAL_RESOURCE'));
        assert(!system.includes('OLD_AUTHORITY'), 'Historical system policy cannot govern the new request');
        assert(existsSync(join(root, 'live/confirm-ready-checked')), 'Current run started before dedicated explicit confirmation');
        assert(JSON.stringify(input.messages).includes('PTY_OLD_FINAL_ONLY'), 'Selected historical assistant remains evidence, never the new completion');
        assert(JSON.stringify(input.messages).includes('PTY_INHERITED_TOOL_RESULT'));
        assert(!JSON.stringify(input.messages).includes('TEMPLATE_EXPANSION_FORBIDDEN'));
      }
      res.on('close', () => { if (!res.writableFinished) aborted++; });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'continuation-pty-' + requests.length, object: 'chat.completion.chunk', created: 1, model: input.model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
      emit({ role: 'assistant' });
      if (input.model === 'old' && turn === 1) {
        emit({ tool_calls: [{ index: 0, id: 'fixture-read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: join(root, 'work/input.txt') }) } }] }); emit({}, 'tool_calls');
      } else {
        if (input.model === 'old') assert(input.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('PTY_INHERITED_TOOL_RESULT')));
        emit({ content: input.model === 'old' ? 'PTY_OLD_FINAL_ONLY' : 'PTY_NEW_OUTPUT_ONLY' });
        if (input.model === 'current') {
          writeFileSync(join(root, 'live/current-streaming'), 'current stream gated');
          const end = Date.now() + 100000;
          while (!existsSync(join(root, 'live/release-current')) && !res.destroyed && Date.now() < end) await sleep(25);
          assert(existsSync(join(root, 'live/release-current')), 'New task stream never explicitly released');
          assert(!res.destroyed, 'Closing NEW/original viewer aborted the task-owned stream');
        }
        emit({}, 'stop');
      }
      res.end('data: [DONE]\n\n');
    } catch (error) { serverFailure ??= String(error.stack ?? error).slice(-16000); writeFileSync(join(root, 'server-error.txt'), serverFailure); res.destroy(error); }
  });
  async function host(restart) {
    const phaseDir = join(root, restart ? 'restart' : 'live');
    writeFileSync(join(phaseDir, 'smoke.ts'), extensionSource(root, phaseDir, restart)); writeFileSync(join(phaseDir, 'pty-controller.py'), pythonSource);
    controller = spawnOwnedController('/usr/bin/python3', [join(phaseDir, 'pty-controller.py'), root, phaseDir, process.execPath, cli, mode, restart ? '1' : '0'], root, 105000);
    let diagnostics = '';
    for (const stream of [controller.stdout, controller.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-16000); });
    const exit = await new Promise((resolve, reject) => {
      controller.once('error', reject); controller.once('exit', (code, signal) => resolve({ code, signal }));
      timer = setTimeout(() => { controller.kill('SIGTERM'); reject(Error('Controller watchdog')); }, 115000);
    });
    clearTimeout(timer);
    const load = name => existsSync(join(phaseDir, name)) ? JSON.parse(readFileSync(join(phaseDir, name), 'utf8')) : {};
    const pty = load('pty-result.json'), host = load('result.json'); writeFileSync(join(phaseDir, 'diagnostics.txt'), diagnostics);
    assert.equal(exit.code, 0, JSON.stringify({ exit, pty, host, serverFailure, diagnostics })); assert.equal(pty.ok, true); assert.equal(host.ok, true, JSON.stringify(host));
    assert(!existsSync(join(root, 'network-refused.txt'))); assert(!serverFailure, serverFailure); assert.equal(aborted, 0);
    await settleOwnedController(controller);
    return { ...host, hostPid: pty.hostPid, terminalBytes: pty.bytes, sizes: pty.sizes, hostExit: pty.hostExit };
  }
  try {
    assertAncestorIsolation(root); cleanHostEnvironment(root);
    for (const path of ['agent/extensions', 'agent/prompts', 'agent/skills/continuation', 'work/.pi', 'live', 'restart']) mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, 'work/input.txt'), 'PTY_INHERITED_TOOL_RESULT\n');
    writeFileSync(join(root, 'agent/auth.json'), '{}');
    const settings = { defaultProvider: 'fixture', defaultModel: 'current', packages: [], extensions: ['-builtin:mcp', '-builtin:llama.cpp', '-builtin:codemode', '-builtin:tool-search'], skills: [], prompts: [], themes: [], noExtensions: false, noSkills: false, noPromptTemplates: false, noThemes: true, defaultProjectTrust: 'never', enableInstallTelemetry: false, enableAnalytics: false, cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false } };
    writeFileSync(join(root, 'agent/settings.json'), JSON.stringify(settings)); writeFileSync(join(root, 'work/.pi/settings.json'), JSON.stringify(settings));
    writeFileSync(join(root, 'agent/extensions/observer.ts'), observerSource(root));
    writeFileSync(join(root, 'agent/prompts/never-expand.md'), '---\ndescription: forbidden dispatch\n---\nTEMPLATE_EXPANSION_FORBIDDEN\n');
    writeFileSync(join(root, 'agent/skills/continuation/SKILL.md'), '---\nname: continuation\ndescription: CURRENT_SKILL_NORMAL_RESOURCE\n---\nTask-local read-only policy.\n');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = 'http://127.0.0.1:' + server.address().port;
    writeFileSync(join(root, 'agent/models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: origin + '/v1', apiKey: 'dummy-continuation-only', models: ['old', 'current'].map(id => ({ id, reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 256 })) } } }));
    writeFileSync(join(root, 'guard.mjs'), guardSource(root, origin));
    const live = await host(false); assert.deepEqual(counts, { old: 2, current: 1 });
    restarting = true;
    const before = requests.length, restart = await host(true); assert.equal(requests.length, before, 'Genuinely fresh restart inspection makes ZERO model requests');
    assert.equal(budget.hits, 3);
    assert.notEqual(live.hostPid, restart.hostPid); assert.deepEqual(live.exactKey, restart.exactKey);
    const result = { mode, localhostRequests: requests.length, restartRequests: 0, aborted, live, restart };
    results.push(result); writeFileSync(join(root, 'checks.json'), JSON.stringify(result, null, 2));
    console.log('PASS actual Pi ' + mode + ' continuation/restart PTYs: explicit review/cancel/confirm, one fresh selected run, literal task/current resources, lineage, original bytes; zero restart calls');
  } finally {
    clearTimeout(timer);
    try { await settleOwnedController(controller); }
    finally { server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); }
    // Preserve bounded dummy terminal/check diagnostics, not credentials/history/code.
    const keep = new Set(['live', 'restart', 'checks.json', 'server-error.txt', 'network-refused.txt', 'supervisor-result.json']);
    for (const leaf of existsSync(root) ? readdirSync(root) : []) if (!keep.has(leaf)) rmSync(join(root, leaf), { recursive: true, force: true });
    const hostKeep = new Set(['terminal.ansi', 'terminal.txt', 'pty-result.json', 'result.json', 'diagnostics.txt', 'observation-error.json']);
    for (const name of ['live', 'restart']) for (const leaf of existsSync(join(root, name)) ? readdirSync(join(root, name)) : []) if (!hostKeep.has(leaf)) rmSync(join(root, name, leaf), { recursive: true, force: true });
  }
}
try {
  await runMode('regular'); await runMode('fullscreen');
  writeFileSync(join(evidence, 'summary.json'), JSON.stringify({ ok: true, results, evidenceLimit: 'Actual ANSI emission/input/redraw only; NOT manual pixel/layout acceptance', processes: 'Sequential Python controller plus actual Pi CLI, genuinely fresh restart in each mode' }, null, 2));
  console.log('PASS continuation host smoke; bounded evidence: ' + evidence);
} catch (error) { console.error('FAIL continuation host smoke; bounded evidence: ' + evidence); throw error; }
