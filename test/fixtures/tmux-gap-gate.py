#!/usr/bin/env python3
"""Opt-in offline real Pi1.5/tmux3.8 slice gate; fixed oracles in board13322.
TMUX_GATE_SDK=/absolute/managed/dist/index.js python3 test/fixtures/tmux-gap-gate.py
No default-suite execution. No keys, network, real providers, runtime mocks or edits.
"""
import ctypes
import importlib.util
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
spec = importlib.util.spec_from_file_location('accepted_oracle', HERE / 'tmux-team-validation-gate.py')
prior = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prior)
identity, result_oracle = prior.identity, prior.result_oracle
LONG = 'HEAD' + 'x' * 24000 + 'TAIL'
PREVIEW = LONG[:9986] + '\n[4036 characters omitted]\n' + LONG[-9986:]
LIVE = 'LIVE_HEAD\n  exact\t😀\nLIVE_TAIL'
ROOT = Path(tempfile.mkdtemp(prefix='cg-', dir='/srv/devops/scratch'))
os.chmod(ROOT, 0o700)
WHOLE = time.monotonic() + 250
phase = min(WHOLE - 15, time.monotonic() + 30)
saved = {}
parent = None
natural = False
failure = None
cleanup = []
checks = []


def dump(p, value):
    p.write_text(json.dumps(value))
    os.chmod(p, 0o600)


def load(p):
    try:
        return json.loads(p.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def collect():
    todo = [os.getpid()]
    seen = set(todo)
    while todo:
        pid = todo.pop()
        try:
            children = Path(f'/proc/{pid}/task/{pid}/children').read_text().split()
        except FileNotFoundError:
            continue
        for child in map(int, children):
            if child in seen:
                continue
            seen.add(child)
            assert len(seen) < 100, 'descendant_cap'
            stamp = identity(child)
            if stamp:
                saved.setdefault(child, stamp)
                todo.append(child)


def artifacts():
    paths = [p for p in (ROOT / 'workers').rglob('*') if p.name in ['control.sock', 'tmux.sock', 'ready.json', 'config.json']]
    assert all(len(str(p).encode()) < 100 for p in paths if p.suffix == '.sock'), 'socket_path_budget'
    return paths


def gone():
    collect()
    return not any(identity(pid) == stamp for pid, stamp in saved.items() if parent is None or pid != parent.pid) and not artifacts()


def reset(seconds=30):
    global phase
    phase = min(WHOLE - 15, time.monotonic() + seconds)


def wait(fn, label):
    while time.monotonic() < phase:
        collect()
        value = fn()
        if value:
            return value
        time.sleep(.04)
    raise AssertionError(label)


def call(q):
    assert parent.poll() is None, 'parent_exited'
    parent.stdin.write((json.dumps(q) + '\n').encode())
    parent.stdin.flush()
    data = b''
    while time.monotonic() < phase:
        collect()
        if not select.select([parent.stdout], [], [], .04)[0]:
            continue
        chunk = os.read(parent.stdout.fileno(), 65536)
        assert chunk, 'parent_eof'
        data += chunk
        assert len(data) < 1048576, 'response_cap'
        if data.endswith(b'\n'):
            return json.loads(data)
    raise AssertionError('public_response_deadline')


def ok(q):
    value = call({'fixture': 'tool', 'action': q}) if 'action' in q else call(q)
    assert value['ok'], json.dumps(value)
    return value


def workers():
    return ok({'action': 'tmux.workers.list'})['data']['workers']


def show(worker, job=None):
    return ok({'action': 'tmux.workers.show', 'workerId': worker, **({'jobId': job} if job else {})})['data']


def settled(admission, expected):
    run = admission['runId']
    row = ok({'fixture': 'state'})['data']['agents'].get(run)
    if not row or row['status'] == 'running':
        return None
    assert row['status'] == expected, f"wrong_canonical_outcome:{run}:{row['status']}"
    return row


def result(agent, admission, full=True):
    reply = ok({'action': 'agents.result', 'id': agent, 'runId': admission['runId'], 'memberRunId': admission['runId'], 'full': full})['data']
    assert reply['status'] == 'found', 'public_result_missing'
    return reply['result']


def providers():
    rows = [load(p) for p in ROOT.glob('provider-*.json')]
    rows = [row for row in rows if row]
    assert not any(row['error'] for row in rows), 'provider_contract'
    return rows


def count():
    return sum(len(row['calls']) for row in providers())


def effects():
    p = ROOT / 'effects.jsonl'
    return [json.loads(line) for line in p.read_text().splitlines()] if p.exists() else []


def create(agent, tools, **policy):
    actual = ok({'action': 'agents.create', 'id': agent, 'prompt': 'Synthetic offline gate only.', 'tools': tools, 'model': 'team-fixture/fixed:off', **policy})['data']['agent']
    assert actual['tools'] == sorted(tools) and actual['model'] == 'team-fixture/fixed:off', 'public_agent_policy'
    for key, value in policy.items():
        assert actual[key] == value, 'public_agent_policy_' + key


def launch(agent, task):
    return ok({'action': 'run', 'agent': agent, 'task': task, 'backend': 'tmux', 'background': True, 'concurrency': 1})


def reuse(worker, task):
    return ok({'action': 'tmux.workers.prompt', 'workerId': worker, 'task': task, 'background': True})


def idle(worker, session):
    row = show(worker)
    assert row['phase'] == 'idle' and row['sessionId'] == session and row['ownership'] == 'coordinator' and row['currentRunId'] is None, 'keep_open_reusable_worker'
    return row


def tokens(row, values):
    assert row['tokens'] == dict(zip(['input', 'output', 'cache_read', 'cache_write'], values)), 'per_job_tokens'
    assert isinstance(row['elapsed_seconds'], (float, int)) and row['elapsed_seconds'] >= 0, 'elapsed_telemetry'
    assert row['evidence_complete'] is False and row['evidence_reasons'], 'honest_incomplete_evidence'


def close_all():
    for row in workers():
        closed = ok({'action': 'tmux.workers.close', 'workerId': row['workerId']})['data']
        assert closed['closed'] and closed['errors'] == [], 'explicit_close_failed'
    wait(lambda: not workers(), 'close_zero_workers')
    wait(gone, 'close_zero_resources')


def main():
    global parent, natural, failure, phase
    start = time.monotonic()
    assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0
    try:
        # The same exact output comparator used below must reject a planted one-char fault.
        p = {'runId': 'fault-run', 'taskId': 'fault-task'}
        row = {'agent_id': 'large', 'member_run_id': 'fault-run', 'run_id': 'fault-run', 'task_id': 'fault-task', 'final_message': LONG[:-1] + '!', 'state': 'done'}
        caught = False
        try:
            result_oracle(row, 'large', 'fault-run', p, LONG)
        except AssertionError as exc:
            assert str(exc) == 'wrong_output'
            caught = True
        assert caught, 'planted_fault_not_detected'
        checks.append('planted_one_character_fault_caught')
        env = {'PATH': '/usr/bin:/bin', 'TERM': 'xterm-256color', 'LANG': 'C.UTF-8', 'PI_OFFLINE': '1', 'PI_SKIP_VERSION_CHECK': '1', 'PI_TELEMETRY': '0', 'PI_IMAGE_PROTOCOL': 'none', 'TMUX_GATE_ROOT': str(ROOT), 'TMUX_GATE_SDK': os.environ['TMUX_GATE_SDK']}
        for key, directory in [('HOME', 'home'), ('XDG_CONFIG_HOME', 'xdg'), ('XDG_CACHE_HOME', 'cache'), ('XDG_DATA_HOME', 'data'), ('XDG_STATE_HOME', 'state'), ('PI_CODING_AGENT_DIR', 'agent')]:
            (ROOT / directory).mkdir(mode=0o700)
            env[key] = str(ROOT / directory)
        for directory in ['workers', 'workspace']:
            (ROOT / directory).mkdir(mode=0o700)
        assert subprocess.check_output(['/usr/bin/tmux', '-V'], env=env, text=True, timeout=3).strip() == 'tmux 3.8', 'tmux_version'
        assert load(Path(env['TMUX_GATE_SDK']).parent.parent / 'package.json')['version'] == '1.5.0', 'pi_version'
        shutil.copyfile(HERE / 'tmux-gap-provider.mjs', ROOT / 'provider.ts')
        shutil.copyfile(HERE / 'tmux-standalone-no-network.mjs', ROOT / 'no-network.mjs')
        dump(ROOT / 'agent/settings.json', {'quietStartup': True, 'compaction': {'enabled': False}, 'retry': {'enabled': False}})
        dump(ROOT / 'agent/models.json', {'providers': {'team-fixture': {'baseUrl': 'http://fixture.invalid', 'api': 'openai-completions', 'apiKey': 'synthetic-not-a-key', 'models': [{'id': 'fixed', 'name': 'Offline gap fixture', 'reasoning': False, 'input': ['text'], 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}, 'contextWindow': 65536, 'maxTokens': 32768}]}}})
        stderr = (ROOT / 'parent.stderr').open('wb')
        os.chmod(ROOT / 'parent.stderr', 0o600)
        parent = subprocess.Popen([shutil.which('node'), '--import', str(ROOT / 'no-network.mjs'), str(HERE / 'tmux-public-smoke-parent.mjs')], env=env, cwd=ROOT / 'workspace', stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, bufsize=0)
        saved[parent.pid] = identity(parent.pid)
        create('large', ['write', 'gap_direct'], may_write=['docs/**'])
        first = launch('large', 'LARGE')
        reset()
        paused = wait(lambda: next((r for r in providers() if (ROOT / f"paused-{r['pid']}").exists()), None), 'paused_stream')
        target = next(r for r in workers() if r['agentId'] == 'large')
        worker, session = target['workerId'], target['sessionId']
        job = target['job']['jobId']
        def live():
            row = show(worker, job)
            return row if row.get('liveOutput') and row['liveOutput']['text'] == LIVE else None
        active = wait(live, 'exact_live_output_while_paused')
        assert active['phase'] == 'busy' and active['liveOutput']['runId'] == first['runId'] and active['liveOutput']['jobId'] == job and not active['liveOutput']['clipped'], 'live_exact_job_binding'
        assert count() == 2 and len(effects()) == 1 and effects()[0]['name'] == 'gap_direct', 'first_two_requests_and_direct_effect'
        assert (ROOT / 'workspace/coord/out.txt').read_text() == 'WRITE_OK\n', 'real_write_bytes'
        checks.append('paused_exact_live_output_and_declared_direct_effect')
        (ROOT / f"release-{paused['pid']}").touch()
        wait(lambda: settled(first, 'done'), 'large_settled')
        old = result('large', first)
        result_oracle(old, 'large', first['runId'], first, LONG)
        assert old['final_message_chars'] == 24008 and old['omitted_chars'] == 0 and old['full_available'], 'large_exact_metadata'
        preview = result('large', first, False)
        assert preview['final_message'] == PREVIEW and preview['omitted_chars'] == 4036 and preview['final_message_chars'] == 24008 and preview['full_available'], 'exact_head_tail_preview'
        assert old['files_changed'] == ['coord/out.txt'] and old['files_outside_allowed'] == ['coord/out.txt'], 'reporting_only_may_write'
        tokens(old, [24, 12, 3, 5])
        idle(worker, session)
        old_bytes = json.dumps(old, sort_keys=True)
        checks.append('large_exact_preview_successful_write_and_fixed_usage')
        second = reuse(worker, 'REUSE')
        assert second['runId'] != first['runId'] and second['taskId'] != first['taskId'], 'fresh_reuse_ids'
        reset()
        wait(lambda: settled(second, 'done'), 'reuse_settled')
        fresh = result('large', second)
        result_oracle(fresh, 'large', second['runId'], second, 'REUSE_OK')
        assert fresh['pi_session_id'] == old['pi_session_id'] == session and fresh['files_changed'] == [] and fresh['files_outside_allowed'] == [], 'reuse_evidence_session_reset'
        tokens(fresh, [17, 9, 4, 1])
        assert json.dumps(result('large', first), sort_keys=True) == old_bytes, 'old_result_mutated'
        idle(worker, session)
        before = count()
        time.sleep(2.2)
        idle(worker, session)
        assert before == count() == 3, 'idle_provider_calls'
        checks.append('same_worker_reset_immutable_result_idle_no_requests')
        create('limited', ['gap_direct'], maxTurns=1)
        limited = launch('limited', 'TURN_LIMIT')
        reset()
        limited_run = wait(lambda: settled(limited, 'failed'), 'maxTurns1_failed_settlement')
        limited_row = result('limited', limited)
        tokens(limited_row, [19, 3, 0, 2])
        assert limited_row['state'] == 'failed' and limited_row['stop_reason'] is None and count() == 4 and len(effects()) == 2, 'maxTurns1_first_tool_then_no_second_provider'
        capworker = next(r for r in workers() if r['agentId'] == 'limited')
        capid, capsession = capworker['workerId'], capworker['sessionId']
        capresult = show(capid, limited_run['metadata']['tmuxJobId'])
        assert capresult['result']['outcome'] == 'failed' and capresult['result']['settled'], 'honest_failed_transport_settlement'
        idle(capid, capsession)
        capreuse = reuse(capid, 'REUSE')
        reset()
        wait(lambda: settled(capreuse, 'done'), 'maxTurns1_reuse')
        capfresh = result('limited', capreuse)
        result_oracle(capfresh, 'limited', capreuse['runId'], capreuse, 'REUSE_OK')
        tokens(capfresh, [17, 9, 4, 1])
        idle(capid, capsession)
        assert count() == 5, 'maxTurns1_reset_request_count'
        checks.append('maxTurns1_first_tool_hard_preprovider_failure_and_reuse')
        unauthorized = reuse(capid, 'UNDECLARED')
        reset()
        wait(lambda: settled(unauthorized, 'failed'), 'undeclared_failed_settlement')
        tokens(result('limited', unauthorized), [23, 2, 1, 0])
        assert count() == 6 and len(effects()) == 2 and all(e['name'] == 'gap_direct' for e in effects()), 'unauthorized_tool_executed'
        checks.append('registered_inactive_undeclared_tool_failed_closed')
        close_all()
        for agent, tool in [('missing', 'gap_missing'), ('deferred', 'gap_deferred')]:
            if agent == 'deferred':
                (ROOT / 'deferred').touch()
            create(agent, [tool])
            refused = launch(agent, 'REUSE')
            reset()
            wait(lambda: settled(refused, 'failed'), agent + '_startup_refused')
            failed = result(agent, refused, False)
            assert failed['state'] == 'failed' and failed['pi_session_id'] is None and failed['final_message'] is None, agent + '_claimed_work'
            assert count() == 6 and len(effects()) == 2, agent + '_unauthorized_execution'
            close_all()
        checks.append('missing_and_deferred_tools_fail_before_provider_or_effect')
        for row in providers():
            ui = load(ROOT / f"ui-{row['pid']}.json")
            if row['calls']:
                assert ui and ui['mode'] == 'tui' and all(ui[k] for k in ['hasUI', 'stdinTTY', 'stdoutTTY']), 'actual_pi_tty'
            assert load(ROOT / f"network-guard-{row['pid']}.json") == {'pid': row['pid'], 'installed': True}, 'worker_network_guard'
        assert load(ROOT / f'network-guard-{parent.pid}.json') == {'pid': parent.pid, 'installed': True}, 'parent_network_guard'
        assert count() == 6, 'exact_six_provider_calls'
        close_all()
        reset(15)
        ok({'fixture': 'dispose'})
        wait(gone, 'dispose_zero_resources')
        natural = True
        checks.append('explicit_close_dispose_zero_owned_resources')
    except BaseException as exc:
        failure = str(exc) if isinstance(exc, AssertionError) else type(exc).__name__ + ': ' + str(exc)
    finally:
        end = min(WHOLE, time.monotonic() + 15)
        if parent and parent.poll() is None and not natural:
            try:
                phase = end
                call({'fixture': 'dispose'})
            except BaseException:
                cleanup.append('emergency_dispose_failed')
        for sig in [signal.SIGTERM, signal.SIGKILL]:
            collect()
            for pid, stamp in saved.items():
                if stamp and identity(pid) == stamp:
                    try:
                        os.kill(pid, sig)
                    except ProcessLookupError:
                        pass
            until = min(end, time.monotonic() + 1)
            while time.monotonic() < until and any(stamp and identity(pid) == stamp for pid, stamp in saved.items()):
                time.sleep(.03)
        if parent:
            try:
                parent.wait(timeout=max(.01, end - time.monotonic()))
            except subprocess.TimeoutExpired:
                cleanup.append('parent_not_reaped')
        while time.monotonic() < end:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
                if not pid:
                    time.sleep(.02)
            except ChildProcessError:
                break
        remaining = sum(bool(stamp and identity(pid) == stamp) for pid, stamp in saved.items()) + len(artifacts())
        if remaining:
            cleanup.append('owned_resources_remain')
        if time.monotonic() > WHOLE:
            cleanup.append('whole_250s')
        observed = [load(p) for p in ROOT.glob('provider-*.json')]
        summary = {'pass': failure is None and natural and not cleanup, 'failure': failure, 'checks': checks, 'providerInvocations': sum(len(r['calls']) for r in observed if r), 'naturalCleanup': natural, 'ownedResources': remaining, 'cleanupErrors': cleanup, 'elapsedSeconds': round(time.monotonic() - start, 3), 'root': str(ROOT), 'pids': saved}
        dump(ROOT / 'summary.json', summary)
        print(json.dumps(summary), flush=True)
    return 0 if summary['pass'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
