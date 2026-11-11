import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Default npm test MUST NOT launch new SDK/model/PTY acceptance. The integrating
// parent grants this separately, after independently reading the staged harnesses.
const approved = process.env.CLANKERS_WORKFLOW_ACCEPTANCE === 'parent-approved';
const safetyUrl = new URL('./fixtures/host-fixture-safety.mjs', import.meta.url).href;
const loader = createRequire(import.meta.url).resolve('tsx');

for (const [fixture, deadline, marker] of [
  ['native-workflow-smoke.mjs', 240_000, 'PASS native workflow acceptance'],
  ['workflow-host-smoke.mjs', 300_000, 'PASS workflow host acceptance'],
  ['workflow-loop-host-smoke.mjs', 300_000, 'PASS workflow loop host acceptance'],
] as const) {
  test(`isolated workflow acceptance: ${fixture}`, {
    skip: approved ? false : 'Parent SDK/PTY acceptance grant required', timeout: deadline + 25_000,
  }, async () => {
    // Dynamic helper import only after opt-in; never import either heavy fixture.
    const safety = await import(safetyUrl);
    const root = mkdtempSync(join(tmpdir(), 'clankers-workflow-acceptance-'));
    safety.assertAncestorIsolation(root);
    mkdirSync(join(root, 'work'));
    const controllerPath = join(root, 'controller.py');
    // The shared outer helper intentionally FAILS any post-controller orphan.
    // Own compiler adoption here, not by relaxing that helper's leak check.
    const compiler = realpathSync(createRequire(createRequire(loader).resolve('esbuild/package.json'))
      .resolve(`@esbuild/linux-${process.arch}/bin/esbuild`));
    writeFileSync(controllerPath, String.raw`import ctypes,json,os,signal,subprocess,sys,time
assert sys.platform == 'linux'
assert ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0, 'subreaper unavailable'
compiler = ${JSON.stringify(compiler)}
report_path = ${JSON.stringify(join(root, 'controller-result.json'))}
seen = {}
report = {'ok': False, 'fixtureExit': None, 'remaining': [], 'reaped': [], 'signals': [], 'errors': []}
proc = None
def stop(sig, _frame):
    report['signals'].append(sig)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
def stat(pid):
    try:
        with open('/proc/' + str(pid) + '/stat') as f:
            raw = f.read(); fields = raw.rsplit(')', 1)[1].split()
        entry = {'pid': pid, 'birth': fields[19], 'ppid': int(fields[1]), 'group': int(fields[2]),
                 'state': fields[0], 'comm': raw.split('(', 1)[1].rsplit(')', 1)[0][:64]}
        return entry
    except (FileNotFoundError, ProcessLookupError): return None
def owned():
    table = {}
    for name in os.listdir('/proc'):
        if name.isdigit():
            entry = stat(int(name))
            if entry: table[entry['pid']] = entry
    parents = {os.getpid()}; members = {}
    for _ in range(65):
        found = {pid: row for pid, row in table.items() if row['ppid'] in parents and pid not in parents}
        if not found: break
        members.update(found); parents.update(found)
    if len(members) > 64: raise RuntimeError('descendant ceiling')
    for pid, entry in members.items():
        # Inspect executable/service provenance ONLY after ancestry establishes ownership.
        try:
            entry['exe'] = os.readlink('/proc/' + str(pid) + '/exe')
            with open('/proc/' + str(pid) + '/cmdline', 'rb') as f: args = f.read(4096).split(b'\0')
            entry['compiler'] = entry['comm'] == 'esbuild' and entry['exe'] == compiler and any(a.startswith(b'--service=') for a in args)
        except (FileNotFoundError, ProcessLookupError):
            entry['exe'] = None; entry['compiler'] = False
        key = (pid, entry['birth'])
        if key not in seen:
            if len(seen) >= 64: raise RuntimeError('observed descendant ceiling')
            seen[key] = {**entry, 'firstPpid': entry['ppid'], 'compilerVerified': entry['compiler'], 'adopted': False}
        saved = seen[key]
        # Zombie exe/cmdline disappear: accept ONLY a previously live-verified
        # exact installed tsx compiler, never comm alone or an unknown zombie.
        if entry['exe'] is not None:
            saved['compilerVerified'] = entry['compiler']; saved['exe'] = entry['exe']
        if entry['compiler']: saved['verifiedPpid'] = entry['ppid']
        saved.update({'ppid': entry['ppid'], 'state': entry['state'], 'comm': entry['comm']})
        if pid != proc.pid and entry['ppid'] == os.getpid(): saved['adopted'] = True
    return members
def drain():
    start = time.monotonic(); end = start + 1.0
    while True:
        members = owned()
        for pid, entry in members.items():
            saved = seen[(pid, entry['birth'])]
            if not saved['compilerVerified'] or entry['comm'] != 'esbuild':
                reason = 'unexpected descendant ' + str(pid)
                if reason not in report['errors']: report['errors'].append(reason)
            if entry['ppid'] != os.getpid(): continue
            try: reaped, status = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError: continue
            if reaped:
                code = os.waitstatus_to_exitcode(status)
                report['reaped'].append({'pid': pid, 'birth': entry['birth'], 'comm': entry['comm'],
                                        'compilerVerified': saved['compilerVerified'], 'exit': code})
                if code != 0: report['errors'].append('descendant nonzero or signal ' + str(pid))
        members = owned()
        if not members or time.monotonic() >= end or report['signals']: break
        time.sleep(.01)
    report['remaining'] = list(members.values())
    report['naturalDrainSeconds'] = time.monotonic() - start
try:
    proc = subprocess.Popen([${JSON.stringify(process.execPath)}, '--import', ${JSON.stringify(loader)}, ${JSON.stringify(fileURLToPath(new URL('./fixtures/' + fixture, import.meta.url)))}], stdin=subprocess.DEVNULL)
    while proc.poll() is None and not report['signals']:
        owned(); time.sleep(.01)
    report['fixtureExit'] = proc.poll()
    # No signals/forced cleanup here. A live noncompiler or any survivor fails;
    # the unchanged outer supervisor owns emergency cleanup and reports it.
    drain()
    report['ok'] = report['fixtureExit'] == 0 and not report['remaining'] and not report['errors'] and not report['signals']
except BaseException as error:
    report['errors'].append(str(error)[:1000])
finally:
    report['seen'] = list(seen.values())
    with open(report_path, 'w') as f: json.dump(report, f)
    print('Workflow controller settlement: ' + json.dumps({key: report.get(key) for key in ['ok', 'fixtureExit', 'naturalDrainSeconds', 'reaped', 'signals', 'errors']}) + '; evidence ' + report_path, flush=True)
sys.exit(0 if report['ok'] else 1)
`);
    let controller: any;
    let bytes = 0, exceeded = false, supervisorTimedOut = false;
    let supervisorTimer: ReturnType<typeof setTimeout> | undefined;
    const output: Buffer[] = [];
    try {
      controller = safety.spawnOwnedController('/usr/bin/python3', [controllerPath], root, deadline);
      supervisorTimer = setTimeout(() => {
        supervisorTimedOut = true; controller.kill('SIGTERM');
      }, deadline + 10_000);
      const capture = (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 65_536) { exceeded = true; controller.kill('SIGTERM'); }
        else output.push(chunk);
      };
      controller.stdout.on('data', capture); controller.stderr.on('data', capture);
      await controller.fixtureClosed;
      await safety.settleOwnedController(controller);
      const text = Buffer.concat(output).toString('utf8');
      writeFileSync(join(root, 'result.log'), text);
      const report = JSON.parse(readFileSync(join(root, 'supervisor-result.json'), 'utf8'));
      const settlement = JSON.parse(readFileSync(join(root, 'controller-result.json'), 'utf8'));
      assert.equal(settlement.ok, true, `Compiler-only natural drain required; evidence ${root}\n${text}`);
      assert.equal(settlement.fixtureExit, 0);
      assert.deepEqual(settlement.remaining, []);
      assert.deepEqual(settlement.signals, []);
      assert(!supervisorTimedOut, `Supervisor deadline; evidence ${root}`);
      assert(!exceeded && bytes <= 65_536, `Output ceiling; evidence ${root}`);
      assert.equal(controller.exitCode, 0, `Acceptance failed; evidence ${root}\n${text}`);
      assert.equal(report.ok, true, `Natural owned process settlement required; evidence ${root}`);
      assert.deepEqual(report.remaining, []);
      assert.match(text, new RegExp(marker));
      if (fixture === 'native-workflow-smoke.mjs') assert.match(text, /PASS Stage8A native:.*real-inflight-zero-replay/);
    } finally {
      // Preserve truthful bounded logs/cleanup proof on failure AND success.
      // If ownership cannot settle, retain the empty isolated resources too.
      if (supervisorTimer) clearTimeout(supervisorTimer);
      if (output.length) writeFileSync(join(root, 'result.log'), Buffer.concat(output));
      await safety.settleOwnedController(controller);
    }
  });
}
