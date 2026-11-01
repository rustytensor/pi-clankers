import assert from 'node:assert/strict';
import { assertAncestorIsolation, cleanHostEnvironment, guardSource, readFixtureBody, spawnOwnedController, settleOwnedController } from './host-fixture-safety.mjs';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Standalone, AFTER materialization: node test/fixtures/team-timeline-host-smoke.mjs
// Installed Pi + Python stdlib only. Four sequential genuine Pi PTYs: live and
// fresh restart in each TUI mode. No slash-command terminal automation, mocked
// UI callbacks, SDK prototype interception, installs, or external provider TEST.
// ANSI emission is evidence of input/redraw, NOT manual visual/pixel acceptance.
const repo = fileURLToPath(new URL('../../', import.meta.url));
const cli = join(repo, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js');
assert(existsSync(cli), 'Installed Pi CLI required');
const evidence = mkdtempSync(join(tmpdir(), 'zerg-team-timeline-pty-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const messageId = 'timeline-exact-operator-001';
const operatorBody = 'TIMELINE_OPERATOR_LITERAL: follow up only in worker A';
const results = [];

function extensionSource(root, phaseDir, restarting) {
  return `import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerZergSwarmExtension } from ${JSON.stringify(join(repo, 'index.ts'))};
const root = ${JSON.stringify(root)}, phaseDir = ${JSON.stringify(phaseDir)};
const restarting = ${JSON.stringify(restarting)};
const messageId = ${JSON.stringify(messageId)}, operatorBody = ${JSON.stringify(operatorBody)};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) { if (await check()) return; await sleep(25); }
  throw Error('Timeout: ' + label);
}
function put(name, value) { writeFileSync(join(phaseDir, name), JSON.stringify(value)); }
function phase(name, extra = {}) { put('phase.json', { name, ...extra }); }
function keyOf(ref) { return { parentRunId: ref.parentRunId, memberRunId: ref.memberRunId, piSessionId: ref.piSessionId }; }
function hashes(refs) { return Object.fromEntries(refs.map(ref => [ref.piSessionId, createHash('sha256').update(readFileSync(ref.sessionFile)).digest('hex')])); }
export default function (pi) {
  let handler, registrations = 0;
  // Capture only real registration; all UI/custom/input callbacks remain intact.
  const proxy = new Proxy(pi, { get(target, key) {
    if (key === 'registerCommand') return (name, options) => {
      if (name === 'zerg') { handler = options.handler; registrations++; }
      return target.registerCommand(name, options);
    };
    const value = Reflect.get(target, key);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  const registration = registerZergSwarmExtension(proxy, { persistence: { enabled: true, snapshotFile: join(root, 'snapshot.json') } });
  const control = registration.control;
  let cleaned = false, started = false;
  function cleanup() { if (cleaned) return; cleaned = true; registration.dispose(); registration.dispose(); }
  pi.on('session_shutdown', cleanup);
  pi.on('session_start', (_event, ctx) => {
    if (started) return; started = true;
    setTimeout(() => void smoke(ctx).catch(error => {
      put('result.json', { ok: false, failureDomain: 'host-runtime-or-contract', error: String(error.stack ?? error).slice(-16000) });
      try { cleanup(); } finally { ctx.shutdown(); }
    }), 0);
  });
  async function execute(input) { const result = await control.execute(input); assert(result.ok, JSON.stringify(result)); return result; }
  async function show(runId) { return (await execute({ action: 'runs.show', runId })).data.run; }
  async function receipts(key) { return (await execute({ action: 'session.messages.list', ...key, limit: 128 })).data.receipts; }
  async function timeline(filter) {
    const data = (await execute({ action: 'timeline.list', ...filter, limit: 256 })).data;
    assert.equal(data.schemaVersion, 1, 'timeline.list data must be direct snapshot');
    assert(Array.isArray(data.entries)); assert(data.entries.length <= 256);
    return data;
  }
  function receiptRow(snapshot, key) {
    const rows = snapshot.entries.filter(row => row.kind === 'operator-receipt' && row.messageId === messageId);
    assert.equal(rows.length, 1, 'Unique current receipt, not fabricated transition rows');
    assert.deepEqual(rows[0].exactKey, key);
    return rows[0];
  }
  async function inspect(ctx, name, filter, key) {
    const snapshot = await timeline(filter);
    const row = receiptRow(snapshot, key);
    const outputIndex = snapshot.entries.findIndex(entry => entry.kind === 'native-output');
    assert(outputIndex >= 0, 'Saved exact scope contains independently recorded native output');
    phase(name, { filter, key, messageId, rowId: row.id, rowIndex: snapshot.entries.findIndex(entry => entry.id === row.id), outputIndex });
    await handler('timeline --team ' + filter.teamId + ' --run ' + filter.parentRunId + ' --member ' + filter.memberRunId + ' --session ' + filter.piSessionId, ctx);
  }
  async function smoke(ctx) {
    assert.equal(ctx.mode, 'tui'); assert.equal(registrations, 1); assert.equal(typeof handler, 'function');
    if (restarting) {
      const saved = JSON.parse(readFileSync(join(root, 'expected.json'), 'utf8'));
      const run = await show(saved.runId);
      assert.equal(run.status, 'done');
      assert.deepEqual(run.nativeSessions.map(keyOf), saved.refs.map(keyOf), 'Fresh host retains exact ledger identities');
      assert(run.nativeSessions.every(ref => ref.attachment !== 'attached'), 'Restart is not live reconnection');
      assert.deepEqual(hashes(run.nativeSessions), saved.hashes);
      const before = await receipts(saved.key);
      assert.equal(before.length, 1); assert.equal(before[0].messageId, messageId); assert.equal(before[0].status, 'delivered');
      const snapshot = await timeline(saved.filter);
      assert.equal(receiptRow(snapshot, saved.key).id, saved.rowId, 'Stable row ID after fresh restart');
      await inspect(ctx, 'restart-timeline', saved.filter, saved.key);
      assert.deepEqual(hashes(run.nativeSessions), saved.hashes, 'Fresh readonly viewing never mutates JSONL');
      assert.deepEqual(await receipts(saved.key), before, 'Fresh host cannot replay/send');
      assert.deepEqual((await show(saved.runId)).nativeSessions.map(keyOf), saved.refs.map(keyOf), 'No new native identities on fresh inspection');
      cleanup();
      put('result.json', { ok: true, restarting: true, registrations, runId: saved.runId, exactKey: saved.key, rowId: saved.rowId, messageId, jsonlUnchanged: true, noLiveReconnection: true });
      phase('complete'); ctx.shutdown(); return;
    }
    for (const [id, model, tools] of [['timeline-lead', 'lead', []], ['timeline-a', 'a', ['read']], ['timeline-b', 'b', ['read']]]) {
      await execute({ action: 'agents.create', id, model: 'fixture/' + model, tools, prompt: 'Read only the supplied fixture file when requested; no other tools, edits, shell, network, or delegation. Return concise status.' });
    }
    await execute({ action: 'team.create', id: 'timeline-team', leader: 'timeline-lead', members: ['timeline-a', 'timeline-b'] });
    const launched = await execute({ action: 'run', agent: 'timeline-team', task: 'Read ' + join(root, 'work/input.txt') + ' and report.', background: true, concurrency: 2 });
    await until(() => existsSync(join(root, 'streaming-a')) && existsSync(join(root, 'streaming-b')), 'two genuine concurrent gated workers');
    const run = await show(launched.runId);
    assert.equal(run.status, 'running'); assert.equal(run.nativeSessions.length, 2, 'Leader has not started');
    const a = run.nativeSessions.find(ref => ref.agentDefinitionId === 'timeline-a');
    const b = run.nativeSessions.find(ref => ref.agentDefinitionId === 'timeline-b');
    assert(a && b); assert.notEqual(a.piSessionId, b.piSessionId); assert.notEqual(a.memberRunId, b.memberRunId);
    assert(run.nativeSessions.every(ref => ref.attachment === 'attached'));
    const key = keyOf(a), filter = { teamId: 'timeline-team', ...key };
    const sent = await execute({ action: 'session.message.send', ...key, messageId, body: operatorBody, mode: 'followUp' });
    assert.equal(sent.data.receipt.status, 'queued', 'Gated worker has not consumed input');
    assert.equal(sent.data.receipt.persistence, 'saved'); assert.deepEqual(sent.data.receipt.key, key);
    writeFileSync(join(root, 'receipt.json'), JSON.stringify(sent.data.receipt));
    for (const scope of [{ teamId: filter.teamId }, { parentRunId: key.parentRunId }, { memberRunId: key.memberRunId }, { piSessionId: key.piSessionId }, filter]) {
      const projected = await timeline(scope); assert.equal(receiptRow(projected, key).status, 'queued');
      for (const row of projected.entries) for (const [field, value] of Object.entries(scope)) assert.equal(row[field], value, 'Exact AND projection: ' + field);
    }
    for (const field of ['teamId', 'parentRunId', 'memberRunId', 'piSessionId']) assert.deepEqual((await timeline({ ...filter, [field]: 'unknown-' + field })).entries, []);
    assert.deepEqual((await timeline({ ...filter, piSessionId: b.piSessionId })).entries, [], 'Mismatched member/Pi tuple cannot fall back');
    const rowId = receiptRow(await timeline(filter), key).id;
    // Public control polling during the modal. No interception of UI/SDK state.
    let stop = false;
    const observation = (async () => {
      await until(() => stop || existsSync(join(phaseDir, 'request-selection')), 'controller requests exact filtered selection');
      if (stop) return;
      const snapshot = await timeline(filter), row = receiptRow(snapshot, key);
      put('selection.json', { rowId: row.id, rowIndex: snapshot.entries.findIndex(entry => entry.id === row.id) });
      await until(async () => stop || (await receipts(key))[0]?.status === 'delivered', 'native ID consumed into followup');
      if (stop) return;
      assert.equal((await show(launched.runId)).status, 'running', 'Delivered is not completion');
      const delivered = receiptRow(await timeline(filter), key);
      assert.equal(delivered.id, rowId); assert.equal(delivered.status, 'delivered');
      put('delivered.json', { messageId, rowId, status: delivered.status });
    })().then(() => ({}), error => {
      put('observation-error.json', { error: String(error.stack ?? error).slice(-16000) }); return { error };
    });
    phase('live-timeline', { filter, key, messageId, rowId });
    await handler('timeline --team timeline-team --run ' + launched.runId, ctx);
    stop = true;
    const observed = await observation; if (observed.error) throw observed.error;
    assert(existsSync(join(phaseDir, 'delivered.json')), 'Roundtrip exercised queued then delivered');
    const afterClose = await show(launched.runId);
    assert.equal(afterClose.status, 'running'); assert.equal(afterClose.nativeSessions.length, 2);
    assert(afterClose.nativeSessions.every(ref => ref.attachment === 'attached'), 'Closing viewers must not dispose workers');
    assert.equal((await receipts(key)).length, 1, 'Timeline shortcuts must never send');
    assert.equal((await receipts(key))[0].status, 'delivered');
    assert.equal((await receipts(keyOf(b))).length, 0, 'No implicit sibling/leader target');
    phase('closed-live');
    await until(async () => { const done = await show(launched.runId); return done.status === 'done' && done.nativeSessions.length === 3 && done.nativeSessions.every(ref => ref.attachment === 'disposed'); }, 'workers settled, leader finished, SDK disposed independently');
    const done = await show(launched.runId), beforeHashes = hashes(done.nativeSessions);
    const native = readFileSync(a.sessionFile, 'utf8').trim().split('\\n').map(line => JSON.parse(line));
    const operators = native.filter(entry => entry.type === 'custom_message' && entry.customType === 'pi-zerg-swarm/operator/v1');
    assert.equal(operators.length, 1); assert.equal(operators[0].details.messageId, messageId); assert.equal(operators[0].content, operatorBody);
    assert(native.some(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolName === 'read'));
    const all = await timeline({ parentRunId: launched.runId });
    assert(all.entries.some(entry => entry.kind === 'native-output'), 'Native outputs are separately projected');
    assert(all.entries.some(entry => entry.kind === 'run-snapshot'), 'Current snapshot is not an event');
    assert.equal(receiptRow(await timeline(filter), key).id, rowId);
    await inspect(ctx, 'saved-timeline', filter, key);
    assert.deepEqual(hashes(done.nativeSessions), beforeHashes, 'Saved viewing preserves every native JSONL byte');
    assert.equal((await receipts(key)).length, 1);
    assert.equal((await receipts(key))[0].status, 'delivered');
    const expected = { runId: launched.runId, refs: done.nativeSessions, key, filter, rowId, hashes: beforeHashes };
    writeFileSync(join(root, 'expected.json'), JSON.stringify(expected));
    cleanup();
    put('result.json', { ok: true, restarting: false, registrations, runId: launched.runId, exactKey: key, rowId, messageId, queuedStatus: sent.data.receipt.status, deliveredStatus: 'delivered', nativeOperatorEntries: operators.length, status: done.status, jsonlUnchanged: true });
    phase('complete'); ctx.shutdown();
  }
}
`;
}

// Only PTY input and terminal bytes. Selection indices come from the actual
// public projection, never incidental row counts or component interception.
const pythonSource = String.raw`import errno, fcntl, json, os, pty, re, select, signal, struct, subprocess, sys, termios, time
root, phase_dir, node, cli, mode, restarting = sys.argv[1:]
master, slave = pty.openpty()
def resize(cols, rows):
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
resize(120, 40)
env = dict(os.environ); env['TERM'] = 'xterm-256color'
args = [node, '--import', root + '/guard.mjs', cli, '--offline', '--no-session', '--no-approve', '--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-tools', '--model', 'fixture/lead', '--thinking', 'off', '--tui-mode', mode, '-e', phase_dir + '/smoke.ts']
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
        if read('observation-error.json'): raise Exception('Observer failure: ' + str(read('observation-error.json')))
        if proc.poll() is not None:
            if check(): return
            raise Exception('Host exited early: ' + label + '\n' + text()[-5000:])
    raise Exception('PTY timeout: ' + label + '\n' + text()[-5000:])
def phase(name): return read('phase.json').get('name') == name
def pause(seconds=0.2):
    end = time.monotonic() + seconds
    while time.monotonic() < end: pump()
current_filter = {}
report = {'mode': mode, 'restarting': restarting == '1', 'hostPid': proc.pid, 'keys': [], 'sizes': [120], 'segments': {}}
def key(value, label):
    os.write(master, value); report['keys'].append(label); pause(0.06)
def mark(name):
    report['segments'].setdefault(name, []).append(len(raw)); return len(raw)
def touch(name, common=False):
    with open((root if common else phase_dir) + '/' + name, 'w') as f: f.write('controller handshake\n')
def resized(label):
    for width, height in [(45, 30), (120, 40)]:
        before = len(raw); resize(width, height); os.kill(proc.pid, signal.SIGWINCH); report['sizes'].append(width)
        pause(0.4); assert len(raw) > before, label + ' resize emitted no redraw'
def exact_form(data, unknown=False):
    begin = mark('filter-unknown' if unknown else 'filter-exact')
    key(b'f', 'f exact AND filter'); pause(0.2)
    # Clear known prior raw values using public Input backspace. Separate
    # packets avoid relying on unsafe multi-control-packet interpretations.
    fields = ['teamId', 'parentRunId', 'memberRunId', 'piSessionId']
    for index, field in enumerate(fields):
        key(b'\x1b[F', 'End filter field')
        prior = current_filter.get(field, '')
        assert len(prior) <= 256, 'Bounded exact field'
        for _ in prior: key(b'\x7f', 'Backspace clear exact field')
        value = ('unknown-pi-session' if unknown and field == 'piSessionId' else data['filter'][field])
        if field == 'piSessionId' and not unknown:
            key(b'\x1b[200~' + value.encode() + b'\x1b[201~', 'complete bracketed exact piSessionId paste')
        else:
            key(value.encode(), 'exact ' + field)
        if index < 3: key(b'\t', 'Tab next filter field')
    resized('filter')
    key(b'\r', 'Enter apply exact AND filter'); pause(0.3)
    current_filter.update(data['filter'])
    if unknown: current_filter['piSessionId'] = 'unknown-pi-session'
    if unknown:
        until(lambda: 'No matching timeline entries. No fallback.' in text(begin), 'unknown exact filter stays empty')
        probe = mark('unknown-no-drill'); key(b'v', 'v unknown cannot retarget'); pause(0.25)
        assert 'clankers coding' not in text(probe).lower() and 'Exact session chooser' not in text(probe), 'Unknown filter retargeted coding'
    return begin
def select_receipt(data, selection):
    key(b'\x1b[H', 'Home pause/select first timeline row')
    for _ in range(selection['rowIndex']): key(b'\x1b[B', 'Down select projected receipt')
    begin = mark('receipt-detail')
    key(b'\r', 'Enter receipt details'); pause(0.3)
    until(lambda: emitted(data['messageId'], begin) and emitted(selection['rowId'], begin), 'unique receipt and stable raw row ID detail')
    # Full tuple can wrap; terminal emission is normalized only for this check.
    for value in data['key'].values(): until(lambda v=value: emitted(v, begin), 'full exact receipt identity: ' + value)
    resized('timeline-detail')
    return begin
def drill(data, live):
    begin = mark('live-coding' if live else 'saved-coding')
    key(b'v', 'v exact selected coding, no chooser'); pause(0.3)
    key(b'\x1b[H', 'Home full coding identity')
    for value in data['key'].values(): until(lambda v=value: emitted(v, begin), 'exact coding tuple: ' + value)
    # Saved raw history includes a long genuine user prompt before the read.
    # Navigate the public viewport; never require offscreen cards to emit.
    if not live:
        for _ in range(16):
            if 'TOOL_FILE_CONTENT' in text(begin): break
            key(b'\x1b[6~', 'PgDn saved coding to genuine read result'); pause(0.15)
    until(lambda: 'TOOL_FILE_CONTENT' in text(begin), 'actual SDK read tool card rendered')
    if live:
        key(b'\x1b[F', 'End coding live tail')
        until(lambda: 'LIVE_WORKER_A' in text(begin), 'addressed A stream, not sibling/leader')
        assert 'LIVE_WORKER_B' not in text(begin), 'Coding implicitly selected sibling'
        touch('viewer-attached', True)
        until(lambda: 'UPDATE_WORKER_A_AFTER_ATTACH' in text(begin), 'new live delta while coding attached')
        touch('release-a', True)
        until(lambda: read('delivered.json').get('status') == 'delivered', 'queued then native-consumed receipt')
        until(lambda: 'FOLLOWUP_WORKER_A' in text(begin), 'literal followup in addressed coding')
    else:
        key(b'\x1b[F', 'End saved coding')
        until(lambda: 'FOLLOWUP_WORKER_A' in text(begin), 'saved followup history emitted')
        until(lambda: 'saved' in text(begin).lower(), 'saved is not live reconnection')
        check = mark('saved-no-compose'); key(b'c', 'c readonly cannot compose'); key(b'\x13', 'Ctrl+s readonly cannot send')
        assert 'ctrl+s' not in text(check).lower(), 'Saved history entered composer'
    resized('coding')
    returned = mark('return-timeline')
    key(b'q', 'q close coding only, fresh timeline return'); pause(0.4)
    until(lambda: emitted(data['rowId'], returned) and emitted(data['messageId'], returned), 'same stable selected receipt/detail after return')
    until(lambda: 'paused' in text(returned).lower(), 'roundtrip retains paused selection')
    # Scope header is intentionally one-line truncated. Inspect explicit filter
    # values in the selected detail via public PgDn/PgUp, not identity inference.
    key(b'\x1b[6~', 'PgDn detail actual restored filter values'); pause(0.2)
    for field, value in data['filter'].items(): until(lambda f=field, v=value: emitted('filter ' + f + ': ' + v, returned), 'actual restored filter ' + field)
    key(b'\x1b[5~', 'PgUp restore original detail scroll'); pause(0.2)
    if live: until(lambda: 'delivered' in text(returned).lower(), 'updated current receipt, not delivery event fabrication')
    before = mark('timeline-no-send'); key(b'c', 'c timeline has no composer'); key(b'\x13', 'Ctrl+s timeline cannot send')
    assert 'ctrl+s' not in text(before).lower(), 'Timeline entered composer'
    key(b'\x1b[F', 'End timeline resumes follow'); pause(0.3)
    until(lambda: 'follow' in text(before).lower(), 'End resumes timeline follow')
    key(b'q', 'q close timeline only')
def terminate(_signum, _frame): raise Exception('PTY controller terminated')
signal.signal(signal.SIGTERM, terminate)
try:
    if restarting == '0':
        until(lambda: phase('live-timeline'), 'live timeline hook'); data = read('phase.json'); pause(0.5)
        current_filter.update({field: data['filter'][field] for field in ['teamId', 'parentRunId']})
        begin = mark('live-timeline'); resized('timeline')
        exact_form(data, True); exact_form(data)
        touch('request-selection')
        until(lambda: 'rowIndex' in read('selection.json'), 'real filtered public projection')
        select_receipt(data, read('selection.json'))
        drill(data, True)
        until(lambda: phase('closed-live'), 'viewers closed with both runners attached')
        touch('release-reply', True); touch('release-b', True)
        until(lambda: phase('saved-timeline'), 'completed timeline hook'); data = read('phase.json'); pause(0.4)
    else:
        until(lambda: phase('restart-timeline'), 'genuinely fresh host restored timeline'); data = read('phase.json'); pause(0.4)
    # Native output is a separate row, explicitly NOT an addressed reply.
    native_start = mark('native-output-distinction')
    key(b'\x1b[H', 'Home saved projected rows')
    for _ in range(data['outputIndex']): key(b'\x1b[B', 'Down projected native output')
    key(b'\r', 'Enter native output detail'); pause(0.3)
    until(lambda: 'native output/handoff: NOT addressed reply' in text(native_start), 'native output not receipt-associated reply')
    key(b'\r', 'Enter close native detail')
    select_receipt(data, data); drill(data, False)
    until(lambda: os.path.exists(phase_dir + '/result.json'), 'host result')
    until(lambda: proc.poll() is not None, 'orderly shutdown')
    assert proc.returncode == 0, 'Host exit: ' + str(proc.returncode)
    report['ok'] = True
except BaseException as error:
    report['ok'] = False; report['failureDomain'] = 'pty-controller-or-emission'; report['error'] = str(error)[-16000:]
finally:
    if proc.poll() is None:
        os.killpg(proc.pid, signal.SIGTERM)
        try: proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL); proc.wait(timeout=3)
    try: pump(0)
    except BaseException as error: report['cleanupError'] = str(error)[-1000:]; report['ok'] = False
    os.close(master)
    report['hostExit'] = proc.returncode; report['bytes'] = len(raw)
    with open(phase_dir + '/terminal.ansi', 'wb') as f: f.write(raw)
    with open(phase_dir + '/terminal.txt', 'w') as f: f.write(text())
    with open(phase_dir + '/pty-result.json', 'w') as f: json.dump(report, f, indent=2)
if not report['ok']: sys.exit(1)
`;


async function runMode(mode) {
  const root = join(evidence, mode);
  const requests = [], counts = { a: 0, b: 0, lead: 0 };
  const budget = { hits: 0, max: 6 };
  let aborted = 0, restarting = false, serverFailure, controller, timer;
  const server = createServer(async (req, res) => {
    try {
      const body = await readFixtureBody(req, budget);
      assert(!restarting, 'Fresh inspection host must make ZERO model requests');
      assert.equal(req.headers.authorization, 'Bearer dummy-exact-loopback-only');
      const input = JSON.parse(body);
      assert(['a', 'b', 'lead'].includes(input.model)); assert.equal(input.stream, true);
      const model = input.model, turn = ++counts[model];
      assert(turn <= (model === 'a' ? 3 : model === 'b' ? 2 : 1), 'Unexpected model turn');
      requests.push({ model, turn }); assert(requests.length <= 6, 'Request cap');
      const toolNames = (input.tools ?? []).map(tool => tool.function.name);
      assert.deepEqual(toolNames, model === 'lead' ? [] : ['read'], 'No unexpected tool/resource exposure');
      if (model === 'lead') assert(counts.a === 3 && counts.b === 2 && existsSync(join(root, 'release-reply')) && existsSync(join(root, 'release-b')), 'Leader only follows worker settlement');
      res.on('close', () => { if (!res.writableFinished) aborted++; });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const emit = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({ id: 'timeline-' + model + '-' + turn, object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
      emit({ role: 'assistant' });
      if (model !== 'lead' && turn === 1) {
        emit({ content: 'READ_WORKER_' + model.toUpperCase() + '\n' });
        emit({ tool_calls: [{ index: 0, id: 'read-' + model, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: join(root, 'work/input.txt') }) } }] });
        emit({}, 'tool_calls');
      } else if (model !== 'lead' && turn === 2) {
        assert(input.messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('TOOL_FILE_CONTENT')), 'Genuine SDK read result');
        emit({ content: 'LIVE_WORKER_' + model.toUpperCase() + ': real concurrent stream\n' });
        writeFileSync(join(root, 'streaming-' + model), 'stream active');
        const deadline = Date.now() + 100000;
        let updated = false;
        while (!existsSync(join(root, 'release-' + model)) && !res.destroyed && Date.now() < deadline) {
          if (model === 'a' && !updated && existsSync(join(root, 'viewer-attached'))) { updated = true; emit({ content: 'UPDATE_WORKER_A_AFTER_ATTACH\n' }); }
          await sleep(25);
        }
        assert(existsSync(join(root, 'release-' + model)), 'Worker gate deadline'); assert(!res.destroyed, 'Viewer close aborted worker');
        if (model === 'a') assert(updated, 'No actual attached live update');
        emit({ content: 'OUTPUT_WORKER_' + model.toUpperCase() + ': independent native output, not addressed reply association\n' });
        emit({}, 'stop');
      } else if (model === 'a') {
        const text = message => typeof message.content === 'string' ? message.content : message.content?.map(block => block.text ?? '').join('');
        assert.equal(input.messages.filter(message => message.role === 'user' && text(message) === operatorBody).length, 1);
        assert(!JSON.stringify(input.messages).includes(messageId), 'Receipt ID leaked into model context');
        assert(!JSON.stringify(input.messages).includes('pi-zerg-swarm/operator/v1'), 'Private metadata leaked');
        emit({ content: 'FOLLOWUP_WORKER_A: literal operator input consumed\n' });
        const deadline = Date.now() + 100000;
        while (!existsSync(join(root, 'release-reply')) && !res.destroyed && Date.now() < deadline) await sleep(25);
        assert(existsSync(join(root, 'release-reply')) && !res.destroyed, 'Followup gate not released normally');
        emit({}, 'stop');
      } else { emit({ content: 'LEADER_AFTER_BOTH_WORKERS\n' }); emit({}, 'stop'); }
      res.end('data: [DONE]\n\n');
    } catch (error) {
      serverFailure ??= String(error.stack ?? error).slice(-16000);
      writeFileSync(join(root, 'server-error.txt'), serverFailure);
      res.destroy(error);
    }
  });
  async function host(restart) {
    const phaseDir = join(root, restart ? 'restart' : 'live');
    writeFileSync(join(phaseDir, 'smoke.ts'), extensionSource(root, phaseDir, restart));
    writeFileSync(join(phaseDir, 'pty-controller.py'), pythonSource);
    controller = spawnOwnedController('/usr/bin/python3', [join(phaseDir, 'pty-controller.py'), root, phaseDir, process.execPath, cli, mode, restart ? '1' : '0'], root, 105000);
    let diagnostics = '';
    for (const stream of [controller.stdout, controller.stderr]) stream.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-16000); });
    const exit = await new Promise((resolve, reject) => {
      controller.once('error', reject); controller.once('exit', (code, signal) => resolve({ code, signal }));
      timer = setTimeout(() => { controller.kill('SIGTERM'); reject(Error('Controller deadline exceeded')); }, 115000);
    });
    clearTimeout(timer);
    const load = name => existsSync(join(phaseDir, name)) ? JSON.parse(readFileSync(join(phaseDir, name), 'utf8')) : {};
    const pty = load('pty-result.json'), host = load('result.json');
    writeFileSync(join(phaseDir, 'diagnostics.txt'), diagnostics);
    assert.equal(exit.code, 0, JSON.stringify({ exit, pty, host, serverFailure, diagnostics }));
    assert.equal(pty.ok, true); assert.equal(host.ok, true, JSON.stringify(host));
    assert(!existsSync(join(root, 'network-refused.txt')), 'Guard rejected unexpected network');
    assert(!serverFailure, serverFailure); assert.equal(aborted, 0);
    await settleOwnedController(controller);
    return { ...host, terminalBytes: pty.bytes, sizes: pty.sizes, hostPid: pty.hostPid, hostExit: pty.hostExit };
  }
  try {
    assertAncestorIsolation(root); cleanHostEnvironment(root);
    for (const leaf of ['work/.pi', 'live', 'restart']) mkdirSync(join(root, leaf), { recursive: true });
    writeFileSync(join(root, 'work/input.txt'), 'TOOL_FILE_CONTENT: isolated real read result\n');
    writeFileSync(join(root, 'agent/auth.json'), '{}');
    const settings = { defaultProvider: 'fixture', defaultModel: 'lead', packages: [], extensions: ['-builtin:mcp', '-builtin:llama.cpp', '-builtin:codemode', '-builtin:tool-search'], skills: [], prompts: [], themes: [], defaultProjectTrust: 'never', noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, enableInstallTelemetry: false, enableAnalytics: false, cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false } };
    writeFileSync(join(root, 'agent/settings.json'), JSON.stringify(settings));
    writeFileSync(join(root, 'work/.pi/settings.json'), JSON.stringify(settings));
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = 'http://127.0.0.1:' + server.address().port;
    writeFileSync(join(root, 'agent/models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: origin + '/v1', apiKey: 'dummy-exact-loopback-only', models: ['a', 'b', 'lead'].map(id => ({ id, name: 'Isolated timeline ' + id, reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 256 })) } } }));
    writeFileSync(join(root, 'guard.mjs'), guardSource(root, origin));
    const live = await host(false);
    assert.deepEqual(counts, { a: 3, b: 2, lead: 1 }); assert.equal(requests.length, 6);
    restarting = true;
    const before = requests.length, restart = await host(true);
    assert.equal(requests.length, before, 'Fresh restart performed zero prompts/model calls');
    assert.equal(budget.hits, 6);
    assert.notEqual(live.hostPid, restart.hostPid, 'Genuinely fresh process, not rehydrating same owner');
    assert.deepEqual(restart.exactKey, live.exactKey); assert.equal(restart.rowId, live.rowId);
    const result = { mode, localhostRequests: requests.length, restartRequests: requests.length - before, aborted, live, restart };
    results.push(result); writeFileSync(join(root, 'checks.json'), JSON.stringify(result, null, 2));
    console.log('PASS actual Pi ' + mode + ' timeline PTYs: concurrent exact workers/queued+consumed/filter/roundtrip/resize/close/saved/fresh restart (6 localhost requests; zero restart calls)');
  } finally {
    clearTimeout(timer);
    try { await settleOwnedController(controller); }
    finally {
      server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    }
    // Remove auth, native JSONL, model request context and all generated fixture
    // code. Keep only bounded terminal/check/error evidence (dummy content).
    const rootEvidence = new Set(['live', 'restart', 'checks.json', 'server-error.txt', 'network-refused.txt', 'supervisor-result.json']);
    for (const leaf of existsSync(root) ? readdirSync(root) : []) if (!rootEvidence.has(leaf)) rmSync(join(root, leaf), { recursive: true, force: true });
    const hostEvidence = new Set(['terminal.ansi', 'terminal.txt', 'pty-result.json', 'result.json', 'diagnostics.txt', 'observation-error.json']);
    for (const name of ['live', 'restart']) for (const leaf of existsSync(join(root, name)) ? readdirSync(join(root, name)) : []) if (!hostEvidence.has(leaf)) rmSync(join(root, name, leaf), { recursive: true, force: true });
  }
}
try {
  await runMode('regular'); await runMode('fullscreen');
  writeFileSync(join(evidence, 'summary.json'), JSON.stringify({ ok: true, results, evidenceLimit: 'Actual ANSI emission/input/redraw only; NOT manual pixel/layout acceptance', processes: 'sequential Python controller + Pi CLI per host; each mode includes a genuinely fresh restart' }, null, 2));
  console.log('PASS team timeline host smoke; bounded evidence: ' + evidence);
} catch (error) {
  console.error('FAIL team timeline host smoke; bounded evidence: ' + evidence);
  throw error;
}
