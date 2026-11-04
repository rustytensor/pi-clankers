#!/usr/bin/env python3
"""Opt-in real Pi1.4/tmux MCP gate. Review before execution; no default tests.
TMUX_GATE_SDK=/absolute/managed/dist/index.js python3 test/fixtures/tmux-mcp-gate.py --fault
TMUX_GATE_SDK=/absolute/managed/dist/index.js python3 test/fixtures/tmux-mcp-gate.py
Fault must exit 1 with faultCaught=true and clean cleanup. Normal runs NORMAL, ABORT,
PARENTLOSS serially in fresh roots, stopping at the first unexpected failure.
"""
import argparse
import ctypes
import json
import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import tempfile
import time

HERE = Path(__file__).resolve().parent


def scenario(name, fault=False):
    started = time.monotonic()
    work_end, phase_end = started + 90, started + 30
    root = Path(tempfile.mkdtemp(prefix='ctm-', dir='/srv/devops/scratch'))
    os.chmod(root, 0o700)
    env = {'PATH': '/usr/bin:/bin', 'TERM': 'xterm-256color', 'LANG': 'C.UTF-8',
           'PI_OFFLINE': '1', 'PI_SKIP_VERSION_CHECK': '1', 'PI_TELEMETRY': '0',
           'PI_IMAGE_PROTOCOL': 'none', 'TMUX_GATE_ROOT': str(root),
           'TMUX_GATE_SDK': os.environ.get('TMUX_GATE_SDK', ''), 'TMUX_MCP_SCENARIO': name}
    for key, directory in [('HOME', 'home'), ('XDG_CONFIG_HOME', 'xdg'),
                           ('XDG_CACHE_HOME', 'cache'), ('XDG_DATA_HOME', 'data'),
                           ('XDG_STATE_HOME', 'state'), ('PI_CODING_AGENT_DIR', 'agent')]:
        env[key] = str(root / directory)
        (root / directory).mkdir(mode=0o700)
    for directory in ['workspace', 'workers']:
        (root / directory).mkdir(mode=0o700)
    parent = ready = None
    saved, public = {}, []
    error = None
    cleanup_errors = []
    natural = stable = fault_changed = False
    expected_models, expected_calls = (2, 3) if name == 'NORMAL' else (1, 1)

    def dump(file, value):
        file.write_text(json.dumps(value))
        os.chmod(file, 0o600)

    def load(file, default=None):
        try:
            return json.loads(file.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return default

    def provider():
        return load(root / 'provider.json', {'invocations': 0, 'verified': False, 'error': None})

    def audit():
        try:
            data = (root / 'mcp-audit.jsonl').read_text()
        except FileNotFoundError:
            return []
        assert len(data) <= 65536, 'audit_cap'
        # A synchronous append is atomic per line; ignore only an in-flight last line.
        return [json.loads(line) for line in data.splitlines(keepends=True) if line.endswith('\n')]

    def identity(pid):
        try:
            fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
            return None if fields[0] in ['Z', 'X'] else fields[19]
        except FileNotFoundError:
            return None

    def live(pid):
        return saved.get(pid) is not None and identity(pid) == saved[pid]

    def collect():
        queue, seen = [os.getpid()], {os.getpid()}
        while queue:
            pid = queue.pop()
            try:
                children = Path(f'/proc/{pid}/task/{pid}/children').read_text().split()
            except FileNotFoundError:
                continue
            for child in map(int, children):
                if child in seen:
                    continue
                seen.add(child)
                assert len(seen) <= 128, 'descendant_cap'
                stamp = identity(child)
                if stamp is not None:
                    saved.setdefault(child, stamp)
                    queue.append(child)

    def sockets():
        return list((root / 'workers').rglob('*.sock'))

    def gone():
        collect()
        return not any(live(pid) for pid in saved if pid != parent.pid) and not sockets()

    def wait(fn, label):
        while time.monotonic() < min(work_end, phase_end):
            collect()
            value = fn()
            if value:
                return value
            time.sleep(.04)
        raise AssertionError(label)

    def call(request, cleanup=False):
        assert parent.poll() is None, 'coordinator_exited'
        parent.stdin.write((json.dumps(request) + "\n").encode())
        parent.stdin.flush()
        end = min(started + 120, time.monotonic() + 20) if cleanup else min(work_end, phase_end)
        data = b''
        while time.monotonic() < end:
            collect()
            if not select.select([parent.stdout], [], [], .04)[0]:
                continue
            chunk = os.read(parent.stdout.fileno(), 1)
            assert chunk, 'coordinator_eof'
            data += chunk
            assert len(data) <= 262144, 'response_cap'
            if chunk == b'\n':
                public.append(data)
                assert len(public) <= 1024, 'public_cap'
                if ready:
                    assert ready['identity']['ownerNonce'].encode() not in data, 'public_nonce'
                return json.loads(data)
        raise AssertionError('response_deadline')

    def ok(request):
        value = call(request)
        assert value['ok'], 'public_refused'
        return value

    def counts():
        p = provider()
        assert p['invocations'] == expected_models and p['error'] is None, 'provider_count_error'
        assert p['verified'] == (name == 'NORMAL'), 'provider_verification'
        calls = [row for row in audit() if row['kind'] == 'call']
        assert len(calls) == expected_calls, 'real_call_count'
        expected = ['alias', 'gateway', 'named'] if name == 'NORMAL' else ['pending']
        assert sorted(row['args']['pattern'] for row in calls) == expected, 'real_patterns'
        assert all(row['name'] == 'search_text' and row['args']['project'] == 'synthetic' for row in calls), 'real_denied_call'
        for call_row in calls:
            pid = call_row["pid"]
            assert load(root / f"network-guard-{pid}.json") == {
                "pid": pid,
                "installed": True,
            }, "mcp_network_guard"
        return calls

    try:
        sdk = Path(env['TMUX_GATE_SDK'])
        assert sdk.is_absolute() and sdk.is_file(), 'sdk_required'
        sdk = sdk.resolve(strict=True)
        env["TMUX_GATE_SDK"] = str(sdk)
        package = load(sdk.parent.parent / 'package.json', {})
        assert package.get('name') == '@earendil-works/pi-coding-agent' and package.get('version') == '1.4.0', 'sdk_version'
        for source, target in [('tmux-mcp-provider.ts', 'provider.ts'),
                               ('tmux-standalone-observer.ts', 'observer.ts'),
                               ('tmux-standalone-no-network.mjs', 'no-network.mjs')]:
            shutil.copyfile(HERE / source, root / target)
        dump(root / 'agent' / 'settings.json', {'quietStartup': True, 'compaction': {'enabled': False}, 'retry': {'enabled': False}})
        dump(root / 'agent' / 'models.json', {'providers': {'mcp-fixture': {
            'baseUrl': 'http://fixture.invalid', 'api': 'openai-completions', 'apiKey': 'synthetic-not-a-key',
            'models': [{'id': 'fixed', 'name': 'Offline MCP fixture', 'reasoning': False, 'input': ['text'],
                        'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0},
                        'contextWindow': 65536, 'maxTokens': 1024}]}}})
        tmux_version = subprocess.run(
            ["/usr/bin/tmux", "-V"],
            env=env,
            capture_output=True,
            text=True,
            timeout=3,
            check=True,
        ).stdout.strip()
        assert tmux_version in ["tmux 3.7", "tmux 3.7a", "tmux 3.7b", "tmux 3.7c", "tmux 3.8"], (
            "approved_tmux_version_required"
        )
        node = shutil.which("node")
        assert node, "node_required"
        parent = subprocess.Popen([node, '--import', str(root / 'no-network.mjs'), str(HERE / 'tmux-mcp-parent.mjs')],
                                  cwd=root / 'workspace', env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, bufsize=0)
        saved[parent.pid] = identity(parent.pid)
        assert saved[parent.pid], "parent_identity"
        ok({'action': 'agents.create', 'id': 'fixture', 'prompt': 'Synthetic offline gate only.',
            'model': 'mcp-fixture/fixed:off', 'tools': ['mcp', 'larra', 'larra_search_text'],
            'disallowedTools': ['larra_delete_symbol']})
        admission = ok({'action': 'run', 'backend': 'tmux', 'agent': 'fixture', 'task': name, 'background': True})
        ready_path = wait(lambda: next(iter((root / 'workers').glob('worker-*/ready.json')), None), 'startup_30s')
        ready = load(ready_path)
        assert ready, "ready_json"
        worker, session = ready['identity']['workerId'], ready['identity']['sessionId']
        assert ready_path.stat().st_mode & 0o777 == 0o600, 'private_ready'
        assert all(ready[key] == value for key, value in {'mode': 'tui', 'hasUI': True, 'stdinTTY': True, 'stdoutTTY': True}.items()), 'real_tty'
        assert load(root / 'ui-proof.json') == {'pid': ready['pid'], 'mode': 'tui', 'hasUI': True, 'stdinTTY': True, 'stdoutTTY': True}, 'observer_tty'
        assert ready['model'] == 'mcp-fixture/fixed' and ready['thinkingLevel'] == 'off', 'model_policy'
        assert sorted(ready['tools']) == ['larra', 'larra_search_text', 'mcp'], 'tool_policy'
        assert all(ready['identity']['ownerNonce'].encode() not in row for row in public), 'early_public_nonce'
        collect()
        assert live(ready["pid"]), "owned_pi"
        for pid in [parent.pid, ready['pid']]:
            assert load(root / f'network-guard-{pid}.json') == {'pid': pid, 'installed': True}, 'network_guard'
        server_pid = int(Path(f"/proc/{ready['pid']}/stat").read_text().rsplit(')', 1)[1].split()[1])
        broker_pid = int(Path(f'/proc/{server_pid}/stat').read_text().rsplit(')', 1)[1].split()[1])
        assert live(server_pid) and live(broker_pid), 'server_broker_owned'
        assert int(Path(f'/proc/{broker_pid}/stat').read_text().rsplit(')', 1)[1].split()[1]) == parent.pid, 'broker_parent'

        def show():
            response = call({'action': 'tmux.workers.show', 'workerId': worker})
            if not response['ok']:
                return None
            value = response["data"]
            assert value["workerId"] == worker, "worker_changed"
            if value['phase'] == 'starting' and value['sessionId'] is None:
                return None
            assert value['sessionId'] == session, 'session_changed'
            return value

        wait(show, 'public_ready_30s')
        phase_end = min(work_end, time.monotonic() + 20)
        if name != 'NORMAL':
            pending = wait(lambda: load(root / 'server-started.json'), 'pending_server_20s')
            collect()
            assert live(pending["pid"]) and saved[pending["pid"]] == pending["start"], (
                "pending_child_owned"
            )
            assert load(root / f"network-guard-{pending['pid']}.json") == {'pid': pending['pid'], 'installed': True}, 'mcp_network_guard'
            counts()
            if name == 'PARENTLOSS':
                assert live(parent.pid), 'parent_identity_lost'
                phase_end = min(work_end, time.monotonic() + 8)
                os.kill(parent.pid, signal.SIGKILL)  # ONLY the saved coordinator, before natural oracle.
                wait(gone, "parent_loss_8s")
                assert not live(parent.pid), "parent_survived"
                counts()
                natural = True
            else:
                ok({'action': 'interrupt', 'runId': admission['runId']})
        if name != 'PARENTLOSS':
            query = {'action': 'agents.result', 'id': 'fixture', 'runId': admission['runId'], 'memberRunId': admission['runId'], 'full': True}
            def result():
                value = ok(query)['data']
                return value.get('result') if value.get('status') == 'found' else None
            row = wait(result, 'canonical_settlement_20s')
            text = 'MCP_GATE_OK' if name == 'NORMAL' else 'MCP_PENDING'
            assert row['state'] == ('done' if name == 'NORMAL' else 'cancelled'), 'canonical_state'
            assert row['final_message'] == text and row['full_available'], 'canonical_text'
            assert row['stop_reason'] == ('stop' if name == 'NORMAL' else 'aborted'), 'actual_stop_reason'
            assert row['agent_id'] == 'fixture' and row['run_id'] == row['member_run_id'] == admission['runId'], 'result_run_binding'
            assert row['task_id'] == admission['taskId'] and row['pi_session_id'] == session, 'result_pi_binding'
            def idle():
                value = show()
                return value if value and value['phase'] == 'idle' and value['currentRunId'] is None else None
            wait(idle, 'idle_20s')
            run = ok({"action": "runs.show", "runId": admission["runId"]})["data"][
                "run"
            ]
            job_id = run["metadata"]["tmuxJobId"]
            actual = ok(
                {"action": "tmux.workers.show", "workerId": worker, "jobId": job_id}
            )["data"]["result"]
            assert actual == {
                "outcome": "completed" if name == "NORMAL" else "aborted",
                "source": "coordinator",
                "jobId": job_id,
                "runId": admission["runId"],
                "taskId": admission["taskId"],
                "text": text,
                "textClipped": False,
                "settled": True,
            }, "actual_job_settlement"
            if name == 'ABORT':
                wait(lambda: not live(pending['pid']), 'aborted_mcp_reaped')
            before_audit = audit()
            counts()
            time.sleep(.25)
            counts()
            assert audit() == before_audit, "idle_mcp_activity"
            assert live(ready['pid']) and live(server_pid) and live(broker_pid), 'idle_closed_early'
            assert result() == row, "immutable_result"
            stable = True
            # Explicit close is required even in fault mode before its observed-evidence assertion.
            phase_end = min(work_end, time.monotonic() + 20)
            closed = ok({'action': 'tmux.workers.close', 'workerId': worker})['data']
            assert closed['closed'] and closed['errors'] == [], 'explicit_close'
            wait(gone, "close_resources_20s")
            natural = True
            assert result() == row, 'result_changed_after_close'
            counts()
            denied_evidence = [call for call in audit() if call['kind'] == 'call' and call['name'] != 'search_text']
            if fault:
                denied_evidence = denied_evidence + [{'kind': 'call', 'name': 'delete_symbol'}]
                fault_changed = True  # ONLY observed audit evidence changes; server/runtime remain untouched.
            assert denied_evidence == [], 'denied_call_audit'
    except BaseException as exc:
        # Only fixture-owned assertion identifiers; never stringify runtime errors.
        safe = str(exc) if isinstance(exc, AssertionError) else ''
        error = safe if safe and safe.replace('_', '').isalnum() else type(exc).__name__
    finally:
        cleanup_end = min(started + 120, time.monotonic() + 30)
        before = provider()['invocations']
        if parent and parent.poll() is None:
            try:
                assert call({'action': '__dispose'}, cleanup=True)['disposed']
            except BaseException:
                cleanup_errors.append('dispose_failed')
        for sig in [signal.SIGTERM, signal.SIGKILL]:
            collect()
            for pid in list(saved):
                if live(pid):
                    try:
                        os.kill(pid, sig)
                    except ProcessLookupError:
                        pass
            until = min(cleanup_end, time.monotonic() + 2)
            while time.monotonic() < until and any(live(pid) for pid in saved):
                time.sleep(.04)
        if parent:
            try:
                parent.wait(timeout=max(.01, cleanup_end - time.monotonic()))
            except subprocess.TimeoutExpired:
                cleanup_errors.append('parent_not_reaped')
        while time.monotonic() < cleanup_end:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
                if pid == 0:
                    time.sleep(.02)
            except ChildProcessError:
                break
        collect()
        remaining = sum(live(pid) for pid in saved) + len(sockets())
        if remaining:
            cleanup_errors.append('owned_resources_remain')
        if provider()['invocations'] != before:
            cleanup_errors.append('cleanup_model_call')
        real_calls = len([row for row in audit() if row['kind'] == 'call'])
        if time.monotonic() > started + 120:
            cleanup_errors.append('whole_120s')
        fault_caught = fault_changed and error == 'denied_call_audit' and before == 2 and real_calls == 3 and natural and not cleanup_errors
        summary = {'scenario': name, 'pass': error is None and natural and not cleanup_errors,
                   'fault': fault, 'faultCaught': fault_caught, 'error': error, 'cleanupErrors': cleanup_errors,
                   'providerInvocations': provider()['invocations'], 'realServerCalls': real_calls,
                   'stableResult': stable if name != 'PARENTLOSS' else None,
                   'naturalCleanupProved': natural, 'ownedResources': remaining,
                   'elapsedSeconds': round(time.monotonic() - started, 3), 'root': str(root)}
        dump(root / 'summary.json', summary)
        print(json.dumps(summary, separators=(',', ':')), flush=True)
    return summary['pass']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fault', action='store_true')
    parser.add_argument('--scenario', choices=['NORMAL', 'ABORT', 'PARENTLOSS'])
    args = parser.parse_args()
    if args.fault and args.scenario not in [None, 'NORMAL']:
        parser.error('--fault is NORMAL only')
    if ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError('Linux subreaper required')
    for name in ([args.scenario] if args.scenario else ['NORMAL'] if args.fault else ['NORMAL', 'ABORT', 'PARENTLOSS']):
        if not scenario(name, args.fault):
            return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
