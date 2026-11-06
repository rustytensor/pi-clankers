#!/usr/bin/env python3
"""Opt-in offline public-control Pi1.5/tmux3.8 fallback acceptance, 250s whole bound.
TMUX_GATE_SDK=/absolute/managed/dist/index.js python3 test/fixtures/tmux-fallback-gate.py
Oracle declared before execution: absent A, explicit [B,C] (B sorts after C),
exact FIRST_OK / SECOND_OK, third failed, exactly three B calls, same session,
new jobs, unchanged selection digests, no C/replay, exact close/dispose cleanup.
The pre-fix run must fail after real readiness and before any provider request.
Reuses only the prior gate's host/transport/cleanup helpers, not its scenarios.
"""
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('gap_helpers', HERE / 'tmux-gap-gate.py')
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
ROOT = g.ROOT
A, B, C = ['fallback-fixture/' + name + ':off' for name in ['missing', 'z-first', 'a-second']]
DESCRIPTOR = {'id': 'z-first', 'name': 'z-first', 'api': 'openai-completions', 'provider': 'fallback-fixture', 'baseUrl': 'http://fixture.invalid', 'reasoning': False, 'input': ['text'], 'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0}, 'contextWindow': 65536, 'maxTokens': 4096}

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()

PLAN = {'candidates': [A, B, C], 'index': 1, 'modelSpec': B, 'modelDigest': digest(DESCRIPTOR)}
PLAN['planDigest'] = digest(PLAN)
ready_proof = []
collect_processes = g.collect

def collect():
    collect_processes()
    # Keep only non-secret readiness fields. Never export ownerNonce or manifest.
    for file in (ROOT / 'workers').rglob('ready.json'):
        row = g.load(file)
        if row:
            safe = {key: row.get(key) for key in ['model', 'modelSelection', 'mode', 'hasUI', 'stdinTTY', 'stdoutTTY']}
            if safe not in ready_proof:
                ready_proof.append(safe)

g.collect = collect

def public(action):
    return g.ok(action)

def state():
    return g.ok({'fixture': 'state'})['data']

def settle(admission, expected):
    row = state()['agents'].get(admission['runId'])
    if not row or row['status'] == 'running':
        return None
    assert row['status'] == expected, 'expected_' + expected + '_got_' + row['status']
    assert row['metadata']['model'] == B and row['metadata']['modelSelection'] == PLAN, 'canonical_selected_model'
    return row

def result(admission, expected, text):
    row = public({'action': 'agents.result', 'id': 'fallback', 'runId': admission['runId'], 'memberRunId': admission['runId'], 'full': True})['data']
    assert row['status'] == 'found', 'exact_result_missing'
    row = row['result']
    assert row['agent_id'] == 'fallback' and row['run_id'] == row['member_run_id'] == admission['runId'] and row['task_id'] == admission['taskId'], 'result_job_identity'
    assert row['state'] == expected and row['model'] == B and row['final_message'] == text, 'exact_result_output_or_model'
    return row

def main():
    start = time.monotonic()
    failure, natural, cleanup, checks = None, False, [], []
    assert ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0
    try:
        env = {'PATH': '/usr/bin:/bin', 'TERM': 'xterm-256color', 'LANG': 'C.UTF-8', 'PI_OFFLINE': '1', 'PI_SKIP_VERSION_CHECK': '1', 'PI_TELEMETRY': '0', 'PI_IMAGE_PROTOCOL': 'none', 'TMUX_GATE_ROOT': str(ROOT), 'TMUX_GATE_SDK': os.environ['TMUX_GATE_SDK']}
        for key, directory in [('HOME', 'home'), ('XDG_CONFIG_HOME', 'xdg'), ('XDG_CACHE_HOME', 'cache'), ('XDG_DATA_HOME', 'data'), ('XDG_STATE_HOME', 'state'), ('PI_CODING_AGENT_DIR', 'agent')]:
            (ROOT / directory).mkdir(mode=0o700)
            env[key] = str(ROOT / directory)
        for directory in ['workers', 'workspace']:
            (ROOT / directory).mkdir(mode=0o700)
        assert subprocess.check_output(['/usr/bin/tmux', '-V'], env=env, text=True, timeout=3).strip() == 'tmux 3.8', 'tmux_version'
        assert g.load(Path(env['TMUX_GATE_SDK']).parent.parent / 'package.json')['version'] == '1.5.0', 'pi_version'
        shutil.copyfile(HERE / 'tmux-fallback-provider.mjs', ROOT / 'provider.ts')
        shutil.copyfile(HERE / 'tmux-standalone-no-network.mjs', ROOT / 'no-network.mjs')
        g.dump(ROOT / 'agent/settings.json', {'quietStartup': True, 'compaction': {'enabled': False}, 'retry': {'enabled': False}})
        models = [{key: value for key, value in {**DESCRIPTOR, 'id': name, 'name': name}.items() if key not in ['api', 'provider', 'baseUrl']} for name in ['z-first', 'a-second']]
        g.dump(ROOT / 'agent/models.json', {'providers': {'fallback-fixture': {'baseUrl': 'http://fixture.invalid', 'api': 'openai-completions', 'apiKey': 'synthetic-not-a-key', 'models': models}}})
        stderr = (ROOT / 'parent.stderr').open('wb')
        os.chmod(ROOT / 'parent.stderr', 0o600)
        g.parent = subprocess.Popen([shutil.which('node'), '--import', str(ROOT / 'no-network.mjs'), str(HERE / 'tmux-public-smoke-parent.mjs')], env=env, cwd=ROOT / 'workspace', stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, bufsize=0)
        g.saved[g.parent.pid] = g.identity(g.parent.pid)
        definition = public({'action': 'agents.create', 'id': 'fallback', 'prompt': 'Synthetic offline fallback gate only.', 'tools': [], 'model': A, 'fallbackModels': [C]})['data']['agent']
        assert definition['fallbackModels'] == [C], 'definition_fallback'
        # Public explicit [] must override the saved definition's usable C.
        refused = public({'action': 'run', 'agent': 'fallback', 'task': 'FIRST', 'backend': 'tmux', 'background': True, 'fallbackModels': []})
        def empty_settled():
            row = state()['agents'].get(refused['runId'])
            if not row or row['status'] == 'running':
                return None
            assert row['status'] == 'failed', 'empty_fallback_must_fail'
            return row
        g.wait(empty_settled, 'empty_preflight_settlement')
        assert g.count() == 0 and not list(ROOT.glob('provider-*.json')), 'empty_launched_provider_or_child'
        spawn = ROOT / 'spawn-proof.jsonl'
        assert not spawn.exists() or not spawn.read_text().strip(), 'empty_spawned_child'
        g.close_all()
        checks.append('public_empty_disables_definition_fallback_zero_child_zero_provider')
        first = public({'action': 'run', 'agent': 'fallback', 'task': 'FIRST', 'backend': 'tmux', 'background': True, 'fallbackModels': [B, C]})
        g.reset()
        g.wait(lambda: settle(first, 'done'), 'first_settlement')
        old = result(first, 'done', 'FIRST_OK')
        worker = g.workers()[0]
        worker_id, session = worker['workerId'], worker['sessionId']
        assert worker['model'] == B and worker['modelSelection'] == PLAN, 'worker_selection_order_or_digest'
        assert ready_proof and all(row['model'] == 'fallback-fixture/z-first' and row['modelSelection'] == PLAN and row['mode'] == 'tui' and all(row[key] for key in ['hasUI', 'stdinTTY', 'stdoutTTY']) for row in ready_proof), 'real_ready_selection'
        first_job = state()['agents'][first['runId']]['metadata']['tmuxJobId']
        assert old['pi_session_id'] == session, 'first_session'
        g.idle(worker_id, session)
        checks.append('explicit_order_B_ready_model_and_independent_descriptor_plan_digests')
        jobs = [first_job]
        for task, expected, text in [('SECOND', 'done', 'SECOND_OK'), ('FAIL', 'failed', '')]:
            admission = public({'action': 'tmux.workers.prompt', 'workerId': worker_id, 'task': task, 'background': True})
            assert admission['runId'] != first['runId'] and admission['taskId'] != first['taskId'], 'new_job_ids'
            g.reset()
            canonical = g.wait(lambda: settle(admission, expected), task + '_settlement')
            jobs.append(canonical['metadata']['tmuxJobId'])
            fresh = result(admission, expected, text)
            assert fresh['pi_session_id'] == session, 'reused_session'
            snapshot = g.show(worker_id, jobs[-1])
            assert snapshot['result']['settled'] and snapshot['result']['outcome'] == ('completed' if expected == 'done' else 'failed'), 'transport_failed_settlement'
            assert snapshot['modelSelection'] == PLAN and snapshot['model'] == B, 'reuse_model_changed'
            g.idle(worker_id, session)
        assert len(set(jobs)) == 3, 'job_identity_replayed'
        assert result(first, 'done', 'FIRST_OK') == old, 'old_result_changed'
        time.sleep(.3)
        rows = g.providers()
        assert len(rows) == 1 and len(rows[0]['calls']) == 3, 'exact_three_requests_one_worker'
        assert [row['scenario'] for row in rows[0]['calls']] == ['FIRST', 'SECOND', 'FAIL'], 'requests_replayed'
        assert all(row['model'] == DESCRIPTOR and row['sessionId'] == session for row in rows[0]['calls']), 'provider_actual_model_descriptor'
        ui = g.load(ROOT / f"ui-{rows[0]['pid']}.json")
        assert ui['model'] == DESCRIPTOR and ui['sessionId'] == session, 'actual_worker_session_model'
        for pid in [g.parent.pid, rows[0]['pid']]:
            assert g.load(ROOT / f'network-guard-{pid}.json') == {'pid': pid, 'installed': True}, 'network_guard_missing'
        checks.append('same_worker_new_jobs_second_literal_then_failed_one_call_no_C_or_replay')
        g.close_all()
        g.reset(15)
        g.ok({'fixture': 'dispose'})
        g.wait(g.gone, 'dispose_zero_owned_resources')
        natural = True
        checks.append('exact_close_dispose_zero_owned_resources')
    except BaseException as exc:
        failure = str(exc) if isinstance(exc, AssertionError) else type(exc).__name__ + ': ' + str(exc)
    finally:
        end = min(g.WHOLE, time.monotonic() + 15)
        if g.parent and g.parent.poll() is None and not natural:
            try:
                g.phase = end
                g.call({'fixture': 'dispose'})
            except BaseException:
                cleanup.append('emergency_dispose_failed')
        for sig in [signal.SIGTERM, signal.SIGKILL]:
            collect()
            for pid, stamp in g.saved.items():
                if stamp and g.identity(pid) == stamp:
                    try:
                        os.kill(pid, sig)
                    except ProcessLookupError:
                        pass
            until = min(end, time.monotonic() + 1)
            while time.monotonic() < until and any(stamp and g.identity(pid) == stamp for pid, stamp in g.saved.items()):
                time.sleep(.03)
        if g.parent:
            try:
                g.parent.wait(timeout=max(.01, end - time.monotonic()))
            except subprocess.TimeoutExpired:
                cleanup.append('parent_not_reaped')
        while time.monotonic() < end:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
                if not pid:
                    time.sleep(.02)
            except ChildProcessError:
                break
        remaining = sum(bool(stamp and g.identity(pid) == stamp) for pid, stamp in g.saved.items()) + len(g.artifacts())
        if remaining:
            cleanup.append('owned_resources_remain')
        if time.monotonic() > g.WHOLE:
            cleanup.append('whole_250s')
        rows = [g.load(p) for p in ROOT.glob('provider-*.json')]
        summary = {'pass': failure is None and natural and not cleanup, 'failure': failure, 'checks': checks, 'providerInvocations': sum(len(row['calls']) for row in rows if row), 'readyProof': ready_proof, 'expectedPlan': PLAN, 'naturalCleanup': natural, 'ownedResources': remaining, 'cleanupErrors': cleanup, 'elapsedSeconds': round(time.monotonic() - start, 3), 'root': str(ROOT)}
        g.dump(ROOT / 'summary.json', summary)
        print(json.dumps(summary), flush=True)
    return 0 if summary['pass'] else 1

if __name__ == '__main__':
    raise SystemExit(main())
