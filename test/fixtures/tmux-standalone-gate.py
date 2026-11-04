#!/usr/bin/env python3
"""Opt-in host gate. AUTHOR ONLY: parent must review before --fault then one normal run.
No terminal text oracle, no real keys, no default test-suite registration.
"""
import argparse
import ctypes
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shlex
import shutil
import signal
import socket
import struct
import subprocess
import tempfile
import termios
import threading
import time
import uuid

HERE = Path(__file__).resolve().parent
SDK_ENV = "TMUX_GATE_SDK"
EXPECTED_INPUTS = ['COORD_ONE', 'WAIT_STEER', 'STEER_ONE', 'HUMAN_ONE', 'WAIT_CANCEL']
EXPECTED_SOURCES = ['coordinator', 'coordinator', 'coordinator', 'human', 'coordinator']
EXPECTED_TEXTS = ['COORD_ONE_OK', 'STEER_ONE_OK', 'HUMAN_ONE_OK', 'PARTIAL_CANCEL']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fault', action='store_true')
    args = parser.parse_args()
    started = time.monotonic()
    work_end = started + 90
    phase_end = started + 30  # Startup, including imports and admission, cannot exceed 30s.
    root = Path(tempfile.mkdtemp(prefix='ctg-', dir='/srv/devops/scratch'))
    os.chmod(root, 0o700)
    env = {
        "PATH": "/usr/bin:/bin",
        "TERM": "xterm-256color",
        "LANG": "C.UTF-8",
        "PI_OFFLINE": "1",
        "PI_SKIP_VERSION_CHECK": "1",
        "PI_TELEMETRY": "0",
        "PI_IMAGE_PROTOCOL": "none",
        "TMUX_GATE_ROOT": str(root),
        SDK_ENV: os.environ.get(SDK_ENV, ""),
    }
    for key, directory in [('HOME', 'home'), ('XDG_CONFIG_HOME', 'xdg'), ('XDG_CACHE_HOME', 'cache'),
                           ('XDG_DATA_HOME', 'data'), ('XDG_STATE_HOME', 'state'), ('PI_CODING_AGENT_DIR', 'agent')]:
        env[key] = str(root / directory)
        (root / directory).mkdir(mode=0o700)
    for directory in ['workspace', 'workers', 'resources']:
        (root / directory).mkdir(mode=0o700)
    if ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError('Cannot enable owned-descendant subreaper')
    parent = attach = master = None
    drain_stop = threading.Event()
    saved = {}
    raw_public = []
    results = []
    error = None
    cleanup_errors = []
    fault_changed = False
    worker = session = ready = server_socket = None
    barrier = 0

    def dump(path, value):
        path.write_text(json.dumps(value))
        os.chmod(path, 0o600)

    def read_json(path, default=None):
        try:
            return json.loads(path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return default

    def provider():
        return read_json(root / 'provider.json', {'invocations': 0, 'calls': [], 'sources': [], 'phase': '', 'error': None})

    def identity(pid):
        try:
            fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
            return None if fields[0] in ['Z', 'X'] else fields[19]
        except FileNotFoundError:
            return None

    def save_pid(pid):
        stamp = identity(pid)
        assert stamp is not None, 'owned PID not live'
        saved[pid] = stamp

    def live(pid):
        return identity(pid) == saved.get(pid) and saved.get(pid) is not None

    def wait_for(fn, label, seconds=20):
        end = min(work_end, phase_end, time.monotonic() + seconds)
        while time.monotonic() < end:
            value = fn()
            if value:
                return value
            time.sleep(.04)
        raise AssertionError('deadline: ' + label)

    def call(request, seconds=20, cleanup=False):
        assert parent and parent.poll() is None, 'parent controller exited'
        parent.stdin.write((json.dumps(request) + '\n').encode())
        parent.stdin.flush()
        end = min(started + 120 if cleanup else min(work_end, phase_end), time.monotonic() + seconds)
        data = b''
        while time.monotonic() < end:
            readable, _, _ = select.select([parent.stdout], [], [], max(0, end - time.monotonic()))
            if not readable:
                break
            chunk = os.read(parent.stdout.fileno(), 1)
            assert chunk, 'parent response EOF'
            data += chunk
            assert len(data) <= 262144, 'public response cap'
            if chunk == b'\n':
                value = json.loads(data)
                raw_public.append(data.decode())
                if ready:
                    assert ready['identity']['ownerNonce'] not in data.decode(), 'nonce in PUBLIC response'
                return value
        raise AssertionError('controller response deadline')

    def ok(request):
        response = call(request)
        assert response['ok'], 'public request refused: ' + request['action']
        return response

    def show(job_id=None):
        request = {"action": "tmux.workers.show", "workerId": worker}
        if job_id is not None:
            request["jobId"] = job_id
        response = call(request)
        # A read may refresh a stale epoch. Never replay a mutation automatically.
        if not response['ok']:
            return None
        value = response['data']
        assert value["workerId"] == worker, "worker replaced"
        # Child readiness precedes the parent's authenticated handle registration.
        # Only that explicit unbound startup state may wait; no session retargeting.
        if value["phase"] == "starting" and value["sessionId"] is None:
            return None
        assert value["sessionId"] == session, "Pi session replaced"
        return value

    def idle():
        value = show()
        return value if value and value['phase'] == 'idle' and value['currentRunId'] is None else None

    def terminal(text):
        assert attach and attach.poll() is None, 'attached tmux client exited'
        os.write(master, text.encode())

    def human_command(command):
        nonlocal barrier
        terminal('/clankers-control ' + command + '\r')
        # An independent public extension command proves the PTY command was consumed.
        time.sleep(.06)
        barrier += 1
        terminal('/gate-barrier\r')
        wait_for(lambda: read_json(root / 'barrier.json', {}).get('count') == barrier, 'PTY command barrier')

    def canonical(admission, text, state='done'):
        run_id, task_id = admission['runId'], admission['taskId']
        def get():
            response = ok({'action': 'agents.result', 'id': 'fixture', 'runId': run_id, 'memberRunId': run_id, 'full': True})
            lookup = response["data"]
            row = lookup.get("result") if lookup.get("status") == "found" else None
            return row if row and row.get('state') == state else None
        row = wait_for(get, 'canonical result')
        assert row['agent_id'] == 'fixture' and row['run_id'] == run_id and row['member_run_id'] == run_id
        assert row['task_id'] == task_id and row['pi_session_id'] == session
        assert row['final_message'] == text and row['full_available'], 'exact canonical text'
        assert row["stop_reason"] == ("aborted" if state == "cancelled" else "stop")
        wait_for(idle, "kept-open idle")
        run = ok({"action": "runs.show", "runId": run_id})["data"]["run"]
        job_id = run["metadata"]["tmuxJobId"]
        assert isinstance(job_id, str) and job_id
        actual = wait_for(lambda: show(job_id), "exact coordinator job")["result"]
        assert actual["jobId"] == job_id
        assert actual['source'] == 'coordinator' and actual['runId'] == run_id and actual['taskId'] == task_id
        assert actual['text'] == text and not actual['textClipped'] and actual['settled']
        assert actual['outcome'] == ('aborted' if state == 'cancelled' else 'completed')
        assert live(ready['pid']), 'completion closed worker'
        results.append((admission, row, actual))
        return actual

    def unchanged_results():
        for admission, expected, _ in results:
            current = ok({'action': 'agents.result', 'id': 'fixture', 'runId': admission['runId'], 'memberRunId': admission['runId'], 'full': True})['data']
            assert current == {"status": "found", "result": expected}, (
                "canonical result mutated after later work"
            )
            batch = ok(
                {
                    "action": "agents.results",
                    "ids": ["fixture"],
                    "runId": admission["runId"],
                    "memberRunId": admission["runId"],
                    "full": True,
                }
            )["data"]
            assert batch == {"results": [current]}, "batch result disagrees"

    def reject_before_spawn(request):
        before = sorted(str(p.relative_to(root / 'workers')) for p in (root / 'workers').rglob('*'))
        spawn_path = root / 'spawn-proof.jsonl'
        spawn_before = spawn_path.read_bytes() if spawn_path.exists() else b''
        count = provider()['invocations']
        response = call(request)
        assert not response['ok'], 'unsupported request admitted'
        assert before == sorted(str(p.relative_to(root / 'workers')) for p in (root / 'workers').rglob('*')), 'preflight created artifacts'
        assert provider()['invocations'] == count, 'preflight invoked provider'
        assert (spawn_path.read_bytes() if spawn_path.exists() else b'') == spawn_before, 'preflight spawned process'

    def stale_wire(change, action='cancel', job_id=None):
        # Only negative identity probes use the private channel. All real work uses createZergControl.
        ident = dict(ready['identity'])
        ident['epoch'] = wait_for(show, 'current identity')['epoch']
        ident.update(change)
        request = {'version': 1, 'requestId': str(uuid.uuid4()), 'identity': ident,
                   'action': action, 'expectedJobId': job_id, 'text': None, 'job': None}
        with socket.socket(socket.AF_UNIX) as channel:
            deadline = min(work_end, phase_end, time.monotonic() + 2)
            channel.settimeout(max(0.01, deadline - time.monotonic()))
            channel.connect(ready['socketPath'])
            channel.sendall((json.dumps(request) + '\n').encode())
            data = b''
            wrong_binding = "sessionId" in change or "workerId" in change
            while b'\n' not in data:
                assert time.monotonic() < deadline, "stale probe deadline"
                channel.settimeout(max(0.01, deadline - time.monotonic()))
                chunk = channel.recv(65536)
                if wrong_binding:
                    assert chunk == b"" and data == b"", (
                        "wrong binding returned bytes or owner credentials"
                    )
                    return
                assert chunk, "stale epoch probe EOF"
                data += chunk
                assert len(data) <= 262144
            response = json.loads(data.split(b'\n')[0])
            assert response['status'] == 'refused' and response['reason'] == 'stale_identity', 'stale identity accepted'

    try:
        assert env[SDK_ENV] and Path(env[SDK_ENV]).is_absolute(), (
            "Absolute TMUX_GATE_SDK required"
        )
        sdk = Path(env[SDK_ENV]).resolve(strict=True)
        assert sdk.is_file(), "Pi 1.4 SDK file required"
        sdk_package = read_json(sdk.parent.parent / "package.json", {})
        assert (
            sdk_package.get("name") == "@earendil-works/pi-coding-agent"
            and sdk_package.get("version") == "1.4.0"
        ), "Pi 1.4.0 SDK required"
        env[SDK_ENV] = str(sdk)
        node = shutil.which('node')
        assert node, 'Node required'
        for source, target in [('tmux-standalone-provider.ts', 'provider.ts'), ('tmux-standalone-observer.ts', 'observer.ts'), ('tmux-standalone-no-network.mjs', 'no-network.mjs')]:
            shutil.copyfile(HERE / source, root / target)
        extensions = []
        for name in ['pi-clankers', 'pi-zerg-swarm']:
            package = root / 'resources' / name
            package.mkdir()
            dump(package / 'package.json', {'name': name, 'type': 'module'})
            trap = package / 'index.ts'
            trap.write_text("import fs from 'node:fs'; fs.writeFileSync(process.env.TMUX_GATE_ROOT + '/SELF_FACTORY_RAN', 'bad'); export default function() {}\n")
            alias = root / 'resources' / (name + '-alias.ts')
            alias.symlink_to(trap)
            extensions.extend([str(trap), str(alias)])
        unrelated = root / 'resources' / 'unrelated.ts'
        unrelated.write_text("import fs from 'node:fs'; export default function() { fs.writeFileSync(process.env.TMUX_GATE_ROOT + '/unrelated-loaded', 'yes'); }\n")
        extensions.append(str(unrelated))
        dump(root / 'agent' / 'settings.json', {'extensions': extensions, 'quietStartup': True,
             'compaction': {'enabled': False}, 'retry': {'enabled': False}})
        dump(
            root / "agent" / "models.json",
            {
                "providers": {
                    "standalone-fixture": {
                        "baseUrl": "http://fixture.invalid",
                        "api": "openai-completions",
                        "apiKey": "synthetic-not-a-key",
                        "models": [
                            {
                                "id": "fixed",
                                "name": "Offline fixture",
                                "reasoning": False,
                                "input": ["text"],
                                "cost": {
                                    "input": 0,
                                    "output": 0,
                                    "cacheRead": 0,
                                    "cacheWrite": 0,
                                },
                                "contextWindow": 65536,
                                "maxTokens": 1024,
                            }
                        ],
                    }
                }
            },
        )
        parent = subprocess.Popen([node, '--import', str(root / 'no-network.mjs'), str(HERE / 'tmux-standalone-parent.mjs')],
                                  cwd=root / 'workspace', env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
        save_pid(parent.pid)
        ok({'action': 'agents.create', 'id': 'fixture', 'prompt': 'Synthetic offline gate only.',
            'model': 'standalone-fixture/fixed:off', 'tools': []})
        base = {'action': 'run', 'backend': 'tmux', 'agent': 'fixture', 'task': 'NEVER_RUN', 'background': True}
        for extra in [{'fork': True}, {'maxTurns': 1}, {'concurrency': 2}, {'fallbackModels': ['x/y']}, {'recovery': True}]:
            reject_before_spawn({**base, **extra})
        ok({'action': 'agents.create', 'id': 'unsupported', 'prompt': 'Never run', 'model': 'standalone-fixture/fixed:off', 'tools': ['mcp']})
        reject_before_spawn({**base, 'agent': 'unsupported'})
        ok({'action': 'team.create', 'id': 'fixture-team', 'members': ['fixture']})
        reject_before_spawn({**base, 'agent': 'fixture-team'})
        reject_before_spawn({'action': 'workflows.start', 'id': 'never', 'backend': 'tmux'})
        first = ok({**base, 'task': 'COORD_ONE'})
        ready_path = wait_for(lambda: next(iter((root / 'workers').glob('worker-*/ready.json')), None), 'ready artifact', 30)
        ready = read_json(ready_path)
        worker, session = ready['identity']['workerId'], ready['identity']['sessionId']
        save_pid(ready['pid'])
        server_socket = ready_path.parent / 'tmux.sock'
        def tmux(*argv):
            return subprocess.run(['/usr/bin/tmux', '-S', str(server_socket), '-f', '/dev/null', *argv], env=env, capture_output=True, text=True, timeout=3, check=True).stdout.strip()
        pane_pid, server_pid = map(int, tmux('display-message', '-p', '-t', 'worker:0.0', '#{pane_pid}:#{pid}').split(':'))
        assert pane_pid == ready['pid']
        save_pid(server_pid)
        proof = read_json(root / 'ui-proof.json')
        assert proof == {'pid': pane_pid, 'mode': 'tui', 'hasUI': True, 'stdinTTY': True, 'stdoutTTY': True}
        guard = read_json(root / f"network-guard-{pane_pid}.json")
        assert guard == {"pid": pane_pid, "installed": True}, (
            "network guard missing in actual child"
        )
        assert all(
            ready.get(key) == value
            for key, value in {
                "mode": "tui",
                "hasUI": True,
                "stdinTTY": True,
                "stdoutTTY": True,
            }.items()
        )
        assert ready['version'] == 1 and ready['model'] == 'standalone-fixture/fixed' and ready['thinkingLevel'] == 'off' and ready['tools'] == []
        assert ready_path.stat().st_mode & 0o777 == 0o600
        assert Path(ready['socketPath']).stat().st_mode & 0o777 == 0o600
        assert not (root / 'SELF_FACTORY_RAN').exists() and (root / 'unrelated-loaded').read_text() == 'yes'
        assert all(ready['identity']['ownerNonce'] not in text for text in raw_public)
        public = wait_for(show, 'public ready')
        phase_end = min(work_end, time.monotonic() + 20)
        attach_argv = shlex.split(public['attachCommand'])
        assert attach_argv == ['tmux', '-S', str(server_socket), 'attach-session', '-t', 'worker']
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
        def setup_tty():
            os.setsid()
            fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        attach = subprocess.Popen(attach_argv, cwd=root, env=env, stdin=slave, stdout=slave, stderr=slave, preexec_fn=setup_tty)
        os.close(slave)
        save_pid(attach.pid)
        def drain_terminal():
            pending = b''
            while not drain_stop.is_set():
                readable, _, _ = select.select([master], [], [], .05)
                if not readable:
                    continue
                try:
                    data = os.read(master, 65536)
                    if not data:
                        return
                    pending = (pending + data)[-4096:]
                    for query, response in [(b'\x1b[6n', b'\x1b[1;1R'), (b'\x1b[c', b'\x1b[?1;2c'), (b'\x1b[>c', b'\x1b[>0;0;0c'), (b'\x1b[?u', b'\x1b[?0u')]:
                        if query in pending:
                            os.write(master, response)
                            pending = pending.replace(query, b'')
                except OSError:
                    return
        threading.Thread(target=drain_terminal, daemon=True).start()
        first_job = canonical(first, EXPECTED_TEXTS[0])
        before = provider()['invocations']
        time.sleep(.25)
        assert provider()['invocations'] == before == 1, 'idle model invocation'
        # Same worker's existence is part of preflight: no second spawn/artifact/provider work.
        reject_before_spawn(base)
        stale_wire({'sessionId': 'stale-session'}, job_id=first_job['jobId'])
        stale_wire({"workerId": "stale-worker"}, job_id=first_job["jobId"])
        phase_end = min(work_end, time.monotonic() + 20)
        second = ok({'action': 'tmux.workers.prompt', 'workerId': worker, 'task': 'WAIT_STEER', 'background': True})
        wait_for(lambda: provider()['phase'] == 'WAIT_STEER', 'steer latch')
        busy = wait_for(show, 'busy snapshot')
        human_command('takeover')
        after_busy = wait_for(show, 'busy takeover refusal')
        assert after_busy['ownership'] == 'coordinator' and after_busy['epoch'] == busy['epoch'] and after_busy['job'] == busy['job']
        assert not call({'action': 'tmux.workers.steer', 'workerId': worker, 'runId': first['runId'], 'body': 'NEVER_RUN'})['ok']
        ok({'action': 'tmux.workers.steer', 'workerId': worker, 'runId': second['runId'], 'body': 'STEER_ONE'})
        (root / 'release-steer').write_text('release\n')
        canonical(second, EXPECTED_TEXTS[1])
        phase_end = min(work_end, time.monotonic() + 20)
        human_command('takeover')
        human = wait_for(lambda: (s if (s := show()) and s['ownership'] == 'human' else None), 'human ownership')
        assert human['epoch'] != busy['epoch']
        assert provider()['calls'] == EXPECTED_INPUTS[:3] and provider()['sources'] == EXPECTED_SOURCES[:3]
        stale_wire({'epoch': busy['epoch']}, action='show')
        denied = call({'action': 'tmux.workers.prompt', 'workerId': worker, 'task': 'SHOULD_NOT_RUN', 'background': True})
        if args.fault:
            denied['ok'] = True  # Exactly ONE observed field changed; production is untouched.
            fault_changed = True
        assert not denied['ok'], 'human_owned denial falsely approved'
        assert provider()['invocations'] == 3
        terminal('HUMAN_ONE\r')
        wait_for(lambda: provider()['phase'] == 'HUMAN_ONE', 'human release latch')
        human_busy = wait_for(show, 'human busy job')
        assert human_busy['job']['source'] == 'human' and human_busy['job']['runId'] is None and human_busy['job']['taskId'] is None
        human_command('return')
        busy_return = wait_for(show, 'busy return refusal')
        assert busy_return['ownership'] == 'human' and busy_return['epoch'] == human['epoch'] and busy_return['job'] == human_busy['job']
        (root / 'release-human').write_text('release\n')
        wait_for(idle, "human settlement")
        human_done = wait_for(
            lambda: show(human_busy["job"]["jobId"]), "exact human job"
        )["result"]
        assert human_done == {'outcome': 'completed', 'source': 'human', 'jobId': human_busy['job']['jobId'], 'runId': None, 'taskId': None, 'text': EXPECTED_TEXTS[2], 'textClipped': False, 'settled': True}
        unchanged_results()
        human_command('return')
        returned = wait_for(lambda: (s if (s := show()) and s['ownership'] == 'coordinator' else None), 'coordinator return')
        assert returned['epoch'] != human['epoch']
        phase_end = min(work_end, time.monotonic() + 20)
        third = ok({'action': 'tmux.workers.prompt', 'workerId': worker, 'task': 'WAIT_CANCEL', 'background': True})
        wait_for(lambda: provider()['phase'] == 'WAIT_CANCEL', 'partial cancellation')
        assert not call({'action': 'interrupt', 'runId': second['runId']})['ok'], 'stale cancel retargeted'
        ok({'action': 'interrupt', 'runId': third['runId']})
        canonical(third, EXPECTED_TEXTS[3], 'cancelled')
        unchanged_results()
        assert len({item[0]['runId'] for item in results}) == 3 and len({item[0]['taskId'] for item in results}) == 3
        assert len({item[2]['jobId'] for item in results} | {human_done['jobId']}) == 4
        assert provider()['invocations'] == 5 and provider()['calls'] == EXPECTED_INPUTS and provider()['sources'] == EXPECTED_SOURCES and provider()['error'] is None
        time.sleep(.25)
        assert provider()['invocations'] == 5
        closed = ok({'action': 'tmux.workers.close', 'workerId': worker})
        assert closed['data']['closed'] and closed['data']['errors'] == []
        assert not live(pane_pid) and not live(server_pid), 'explicit close left worker live'
        assert not Path(ready['socketPath']).exists() and not server_socket.exists(), 'explicit close retained socket'
    except BaseException as exc:
        error = str(exc) or type(exc).__name__
    finally:
        cleanup_end = min(started + 120, time.monotonic() + 30)
        before_cleanup = provider()['invocations']

        # Every descendant of this standalone gate is owned. Save start-times before signals,
        # including setup descendants that never reached ready. No process-name matching.
        def collect_owned():
            queue = [os.getpid()]
            seen = set(queue)
            while queue and len(seen) <= 128:
                pid = queue.pop()
                try:
                    children = (
                        Path(f"/proc/{pid}/task/{pid}/children").read_text().split()
                    )
                except FileNotFoundError:
                    continue
                for child in map(int, children):
                    if child in seen:
                        continue
                    seen.add(child)
                    stamp = identity(child)
                    if stamp is not None:
                        saved.setdefault(child, stamp)
                        queue.append(child)

        collect_owned()
        if parent and parent.poll() is None:
            try:
                call({'action': '__dispose'}, seconds=max(.01, min(20, cleanup_end - time.monotonic())), cleanup=True)
            except BaseException:
                cleanup_errors.append('public dispose did not complete')
        # Kill only saved exact identities. Parent's own runner supervises setup descendants.
        for sig in [signal.SIGTERM, signal.SIGKILL]:
            collect_owned()
            for pid in saved:
                if live(pid):
                    try:
                        os.kill(pid, sig)
                    except ProcessLookupError:
                        pass
            until = min(cleanup_end, time.monotonic() + 2)
            while time.monotonic() < until and any(live(pid) for pid in saved):
                time.sleep(.04)
        drain_stop.set()
        if master is not None:
            os.close(master)
        for proc in [attach, parent]:
            if proc:
                try:
                    proc.wait(timeout=max(.01, cleanup_end - time.monotonic()))
                except subprocess.TimeoutExpired:
                    cleanup_errors.append('owned child not reaped')
        while time.monotonic() < cleanup_end:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
                if pid == 0:
                    time.sleep(.02)
                    continue
            except ChildProcessError:
                break
        if any(live(pid) for pid in saved):
            cleanup_errors.append('saved owned PID remains')
        if any((root / 'workers').rglob('*.sock')):
            cleanup_errors.append('owned socket remains')
        if provider()['invocations'] != before_cleanup:
            cleanup_errors.append('cleanup invoked model')
        if args.fault and (not fault_changed or provider()['invocations'] != 3 or error != 'human_owned denial falsely approved'):
            cleanup_errors.append('fault was not caught at exactly three calls')
        if time.monotonic() - started > 120:
            cleanup_errors.append('whole 120 second budget exceeded')
        summary = {'pass': error is None and not cleanup_errors, 'fault': args.fault,
                   'faultCaught': fault_changed and error == 'human_owned denial falsely approved',
                   'error': error, 'cleanupErrors': cleanup_errors, 'invocations': provider()['invocations'],
                   'calls': provider()['calls'], 'sources': provider()['sources'],
                   'canonicalResults': len(results), 'elapsedSeconds': round(time.monotonic() - started, 3),
                   'notCovered': ['separate process-only parent-dispose/setup-failure/parent-loss cases',
                                  'default-native execution selection'],
                   'root': str(root)}
        dump(root / 'summary.json', summary)
        # Session JSONL preserved only in this isolated root; no raw terminal/session data exported.
        print(json.dumps(summary, separators=(',', ':')))
    return 1 if error or cleanup_errors else 0


if __name__ == '__main__':
    raise SystemExit(main())
