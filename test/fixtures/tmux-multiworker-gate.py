#!/usr/bin/env python3
"""Opt-in working-tree Pi1.5 gate. Synthetic only; no network or operator settings.
TMUX_GATE_SDK=/absolute/managed/dist/index.js python3 test/fixtures/tmux-multiworker-gate.py
Planted identity/output contamination checks precede NORMAL and PARENTLOSS, once
and serially. First unexpected failure stops. Evidence stays under /srv/devops.
"""

import ctypes
import json
import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import tempfile
import threading
import time

HERE = Path(__file__).resolve().parent


def isolation(rows):
    assert len(rows) == 2 and all(row["phase"] == "busy" for row in rows), (
        "simultaneous_busy"
    )
    for field in ["workerId", "sessionId", "currentRunId"]:
        assert all(row[field] for row in rows) and rows[0][field] != rows[1][field], (
            "cross_worker_identity"
        )
    for field in ["jobId", "runId", "taskId"]:
        assert (
            all(row["job"][field] for row in rows)
            and rows[0]["job"][field] != rows[1]["job"][field]
        ), "cross_job_identity"
    assert all(row["currentRunId"] == row["job"]["runId"] for row in rows), (
        "current_run_binding"
    )


def result_oracle(row, admission, session, text, cancelled=False):
    assert row["final_message"] == text and row["full_available"], "cross_worker_output"
    assert row["state"] == ("cancelled" if cancelled else "done"), "canonical_state"
    assert row["stop_reason"] == ("aborted" if cancelled else "stop"), (
        "actual_stop_reason"
    )
    assert row["run_id"] == row["member_run_id"] == admission["runId"], (
        "result_run_binding"
    )
    assert row["task_id"] == admission["taskId"] and row["pi_session_id"] == session, (
        "result_session_binding"
    )


def planted_faults():
    rows = [
        {
            "workerId": x,
            "sessionId": "session-" + x,
            "currentRunId": "run-" + x,
            "phase": "busy",
            "job": {"jobId": "job-" + x, "runId": "run-" + x, "taskId": "task-" + x},
        }
        for x in ["A", "B"]
    ]
    rows[1]["workerId"] = rows[0]["workerId"]
    caught = []
    try:
        isolation(rows)
    except AssertionError as exc:
        assert str(exc) == "cross_worker_identity"
        caught.append(str(exc))
    try:
        result_oracle(
            {"final_message": "A_PARTIAL", "full_available": True},
            {},
            "session-B",
            "B_OK",
        )
    except AssertionError as exc:
        assert str(exc) == "cross_worker_output"
        caught.append(str(exc))
    assert caught == ["cross_worker_identity", "cross_worker_output"], (
        "planted_fault_not_caught"
    )
    return caught


def identity(pid):
    try:
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return None if fields[0] in ["Z", "X"] else fields[19]
    except FileNotFoundError:
        return None


def scenario(name):
    started = time.monotonic()
    work_end, phase_end = started + 90, started + 30
    root = Path(tempfile.mkdtemp(prefix="cmw-", dir="/srv/devops/scratch"))
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
        "TMUX_GATE_SDK": os.environ.get("TMUX_GATE_SDK", ""),
    }
    for key, directory in [
        ("HOME", "home"),
        ("XDG_CONFIG_HOME", "xdg"),
        ("XDG_CACHE_HOME", "cache"),
        ("XDG_DATA_HOME", "data"),
        ("XDG_STATE_HOME", "state"),
        ("PI_CODING_AGENT_DIR", "agent"),
    ]:
        env[key] = str(root / directory)
        (root / directory).mkdir(mode=0o700)
    for directory in ["workspace", "workers"]:
        (root / directory).mkdir(mode=0o700)
    parent = sentinel = None
    saved, unrelated = {}, {}
    error = None
    cleanup_errors = []
    natural = sentinel_preserved = stable = False
    public = []
    ready = {}

    def dump(file, value):
        file.write_text(json.dumps(value))
        os.chmod(file, 0o600)

    def load(file, default=None):
        try:
            return json.loads(file.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return default

    def live(pid):
        return saved.get(pid) is not None and identity(pid) == saved[pid]

    def collect():
        queue, seen = [os.getpid()], {os.getpid()}
        while queue:
            pid = queue.pop()
            try:
                children = Path(f"/proc/{pid}/task/{pid}/children").read_text().split()
            except FileNotFoundError:
                continue
            for child in map(int, children):
                if child in seen:
                    continue
                seen.add(child)
                assert len(seen) <= 128, "descendant_cap"
                stamp = identity(child)
                if stamp is not None:
                    if child in unrelated or pid in unrelated:
                        unrelated.setdefault(child, stamp)
                    else:
                        saved.setdefault(child, stamp)
                    queue.append(child)

    def artifacts():
        return [
            p
            for p in (root / "workers").rglob("*")
            if p.name in ["control.sock", "tmux.sock", "ready.json", "config.json"]
        ]

    def gone():
        collect()
        return (
            not any(live(pid) for pid in saved if pid != parent.pid) and not artifacts()
        )

    def wait(fn, label):
        while time.monotonic() < min(work_end, phase_end):
            collect()
            value = fn()
            if value:
                return value
            time.sleep(0.04)
        raise AssertionError(label)

    def call(request, cleanup=False):
        assert parent.poll() is None, "coordinator_exited"
        parent.stdin.write((json.dumps(request) + "\n").encode())
        parent.stdin.flush()
        end = (
            min(started + 120, time.monotonic() + 20)
            if cleanup
            else min(work_end, phase_end)
        )
        data = b""
        while time.monotonic() < end:
            collect()
            if not select.select([parent.stdout], [], [], 0.04)[0]:
                continue
            chunk = os.read(parent.stdout.fileno(), 1)
            assert chunk, "coordinator_eof"
            data += chunk
            assert len(data) <= 262144, "response_cap"
            if chunk == b"\n":
                public.append(data)
                assert sum(map(len, public)) <= 2 * 1024 * 1024, "public_cap"
                for r in ready.values():
                    assert r["identity"]["ownerNonce"].encode() not in data, (
                        "public_nonce"
                    )
                return json.loads(data)
        raise AssertionError("response_deadline")

    def ok(request):
        response = call(request)
        assert response["ok"], "public_refused"
        return response

    def providers():
        return {
            r["pid"]: load(root / f"provider-{r['pid']}.json", {})
            for r in ready.values()
        }

    def counts(expected):
        values = providers()
        assert len(values) == 2 and all(
            v and v["error"] is None for v in values.values()
        ), "provider_error"
        assert sorted(len(v["calls"]) for v in values.values()) == expected, (
            "provider_count"
        )
        return values

    try:
        sdk = Path(env["TMUX_GATE_SDK"])
        assert sdk.is_absolute() and sdk.is_file(), "sdk_required"
        sdk = sdk.resolve(strict=True)
        env["TMUX_GATE_SDK"] = str(sdk)
        pkg = load(sdk.parent.parent / "package.json", {})
        assert (
            pkg.get("name") == "@earendil-works/pi-coding-agent"
            and pkg.get("version") == "1.5.0"
        ), "sdk_version"
        assert (
            subprocess.check_output(
                ["/usr/bin/tmux", "-V"], env=env, text=True, timeout=3
            ).strip()
            == "tmux 3.8"
        ), "tmux_version"
        shutil.copyfile(HERE / "tmux-multiworker-provider.ts", root / "provider.ts")
        shutil.copyfile(
            HERE / "tmux-standalone-no-network.mjs", root / "no-network.mjs"
        )
        dump(
            root / "agent/settings.json",
            {
                "quietStartup": True,
                "compaction": {"enabled": False},
                "retry": {"enabled": False},
            },
        )
        dump(
            root / "agent/models.json",
            {
                "providers": {
                    "multiworker-fixture": {
                        "baseUrl": "http://fixture.invalid",
                        "api": "openai-completions",
                        "apiKey": "synthetic-not-a-key",
                        "models": [
                            {
                                "id": "fixed",
                                "name": "Offline multiworker fixture",
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
        # Sentinel is a separate server not created by the controller. Save exact IDs.
        sentinel_socket = str(root / "sentinel.sock")
        sentinel = subprocess.Popen(
            ["/usr/bin/tmux", "-D", "-S", sentinel_socket, "-f", "/dev/null"],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        unrelated[sentinel.pid] = identity(sentinel.pid)
        end = time.monotonic() + 3
        while not Path(sentinel_socket).exists() and time.monotonic() < end:
            time.sleep(0.02)
        pane = subprocess.check_output(
            [
                "/usr/bin/tmux",
                "-S",
                sentinel_socket,
                "new-session",
                "-d",
                "-P",
                "-F",
                "#{pane_pid}",
                "sleep 180",
            ],
            env=env,
            text=True,
            timeout=3,
        )
        unrelated[int(pane.strip())] = identity(int(pane.strip()))
        assert all(unrelated.values()), "sentinel_identity"
        node = shutil.which("node")
        assert node, "node_required"
        parent = subprocess.Popen(
            [
                node,
                "--import",
                str(root / "no-network.mjs"),
                str(HERE / "tmux-multiworker-parent.mjs"),
            ],
            cwd=root / "workspace",
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )

        def diagnostics():
            retained = 0
            with (root / "coordinator.stderr").open("wb") as log:
                os.chmod(root / "coordinator.stderr", 0o600)
                while chunk := parent.stderr.read(4096):
                    keep = chunk[: max(0, 16384 - retained)]
                    log.write(keep)
                    log.flush()
                    retained += len(keep)

        threading.Thread(target=diagnostics, daemon=True).start()
        saved[parent.pid] = identity(parent.pid)
        ok(
            {
                "action": "agents.create",
                "id": "fixture",
                "prompt": "Synthetic offline gate only.",
                "model": "multiworker-fixture/fixed:off",
                "tools": [],
            }
        )
        admissions = [
            ok(
                {
                    "action": "run",
                    "backend": "tmux",
                    "agent": "fixture",
                    "task": token,
                    "background": True,
                }
            )
            for token in ["A_WAIT", "B_WAIT"]
        ]
        phase_end = min(work_end, time.monotonic() + 30)

        def both_ready():
            files = list((root / "workers").glob("worker-*/ready.json"))
            if len(files) != 2:
                return False
            values = [load(p) for p in files]
            if not all(values):
                return False
            for r in values:
                ready[r["identity"]["workerId"]] = r
            rows = ok({"action": "tmux.workers.list"})["data"]["workers"]
            if len(rows) != 2 or any(row["phase"] != "busy" for row in rows):
                return False
            if any(
                not load(root / f"provider-{r['pid']}.json", {}).get("calls")
                for r in values
            ):
                return False
            return rows

        rows = wait(both_ready, "simultaneous_busy_30s")
        isolation(rows)
        rows = [
            next(row for row in rows if row["currentRunId"] == a["runId"])
            for a in admissions
        ]
        A, B = rows
        for row in rows:
            r = ready[row["workerId"]]
            assert row["sessionId"] == r["identity"]["sessionId"] and live(r["pid"]), (
                "real_session_binding"
            )
            assert all(
                r[key] == value
                for key, value in {
                    "mode": "tui",
                    "hasUI": True,
                    "stdinTTY": True,
                    "stdoutTTY": True,
                }.items()
            ), "real_tty"
            assert load(root / f"ui-{r['pid']}.json") == {
                "pid": r["pid"],
                "sessionId": row["sessionId"],
                "mode": "tui",
                "hasUI": True,
                "stdinTTY": True,
                "stdoutTTY": True,
            }, "independent_ui"
            assert r["tools"] == [] and r["model"] == "multiworker-fixture/fixed", (
                "worker_policy"
            )
            assert all(
                r["identity"]["ownerNonce"].encode() not in entry for entry in public
            ), "early_public_nonce"
            assert load(root / f"network-guard-{r['pid']}.json") == {
                "pid": r["pid"],
                "installed": True,
            }, "worker_network_guard"
        assert load(root / f"network-guard-{parent.pid}.json") == {
            "pid": parent.pid,
            "installed": True,
        }, "parent_network_guard"
        counts([1, 1])
        phase_end = min(work_end, time.monotonic() + 20)
        assert not call({"action": "tmux.workers.show", "workerId": "missing"})["ok"], (
            "wrong_worker"
        )
        assert not call(
            {
                "action": "tmux.workers.steer",
                "workerId": A["workerId"],
                "runId": B["currentRunId"],
                "body": "WRONG",
            }
        )["ok"], "wrong_worker_run"
        foreign = call(
            {
                "action": "tmux.workers.show",
                "workerId": B["workerId"],
                "jobId": A["job"]["jobId"],
            }
        )
        assert not foreign["ok"] or foreign["data"]["result"] is None, (
            "foreign_job_fallback"
        )
        if name == "PARENTLOSS":
            assert live(parent.pid), "parent_identity_lost"
            os.kill(parent.pid, signal.SIGKILL)
            phase_end = min(work_end, time.monotonic() + 8)
            wait(gone, "parent_loss_8s")
            counts([1, 1])
            natural = True
        else:

            def result(admission):
                response = ok(
                    {
                        "action": "agents.result",
                        "id": "fixture",
                        "runId": admission["runId"],
                        "memberRunId": admission["runId"],
                        "full": True,
                    }
                )["data"]
                return (
                    response.get("result")
                    if response.get("status") == "found"
                    else None
                )

            ok({"action": "interrupt", "runId": admissions[0]["runId"]})
            ar = wait(lambda: result(admissions[0]), "A_cancel_20s")
            result_oracle(ar, admissions[0], A["sessionId"], "A_PARTIAL", True)
            closed = ok({"action": "tmux.workers.close", "workerId": A["workerId"]})[
                "data"
            ]
            assert closed["closed"] and closed["errors"] == [], "A_close"
            assert not live(ready[A["workerId"]]["pid"]), "A_still_live"
            b_busy = ok({"action": "tmux.workers.show", "workerId": B["workerId"]})[
                "data"
            ]
            assert (
                b_busy["job"] == B["job"]
                and b_busy["sessionId"] == B["sessionId"]
                and b_busy["phase"] == "busy"
            ), "B_changed_by_A"
            counts([1, 1])
            bpid = ready[B["workerId"]]["pid"]
            assert live(bpid), "B_killed_by_A"
            (root / f"release-{bpid}").touch()
            br = wait(lambda: result(admissions[1]), "B_settle_20s")
            result_oracle(br, admissions[1], B["sessionId"], "B_OK")

            def idle():
                row = ok({"action": "tmux.workers.show", "workerId": B["workerId"]})[
                    "data"
                ]
                return row["phase"] == "idle" and row["currentRunId"] is None

            wait(idle, "B_idle_20s")
            next_run = ok(
                {
                    "action": "tmux.workers.prompt",
                    "workerId": B["workerId"],
                    "task": "B_REUSE",
                    "background": True,
                }
            )
            assert next_run["runId"] not in [
                a["runId"] for a in admissions
            ] and next_run["taskId"] not in [a["taskId"] for a in admissions], (
                "fresh_ids"
            )
            assert not call({"action": "interrupt", "runId": admissions[1]["runId"]})[
                "ok"
            ], "stale_interrupt"
            nr = wait(lambda: result(next_run), "B_reuse_20s")
            result_oracle(nr, next_run, B["sessionId"], "B_REUSE_OK")
            wait(idle, "B_reuse_idle_20s")
            run = ok({"action": "runs.show", "runId": next_run["runId"]})["data"]["run"]
            assert run["metadata"]["tmuxJobId"] not in [
                r["job"]["jobId"] for r in rows
            ], "fresh_job"
            actual = ok(
                {
                    "action": "tmux.workers.show",
                    "workerId": B["workerId"],
                    "jobId": B["job"]["jobId"],
                }
            )["data"]["result"]
            assert (
                actual["text"] == "B_OK" and actual["runId"] == admissions[1]["runId"]
            ), "immutable_job_result"
            before = counts([1, 2])
            time.sleep(0.25)
            assert counts([1, 2]) == before, "idle_model_work"
            assert result(admissions[0]) == ar and result(admissions[1]) == br, (
                "immutable_canonical_results"
            )
            stable = True
            phase_end = min(work_end, time.monotonic() + 20)
            assert ok({"action": "__dispose"})["disposed"], "dispose_all"
            wait(gone, "dispose_20s")
            counts([1, 2])
            natural = True
        sentinel_preserved = all(
            identity(pid) == stamp for pid, stamp in unrelated.items()
        )
        assert sentinel_preserved, "unrelated_tmux_changed"
    except BaseException as exc:
        safe = str(exc) if isinstance(exc, AssertionError) else ""
        error = safe if safe and safe.replace("_", "").isalnum() else type(exc).__name__
    finally:
        cleanup_end = min(started + 120, time.monotonic() + 30)
        if parent and parent.poll() is None and not natural:
            try:
                assert call({"action": "__dispose"}, cleanup=True)["disposed"]
            except BaseException:
                cleanup_errors.append("dispose_failed")
        # Emergency cleanup is not acceptance evidence. Signal only saved identities.
        for sig in [signal.SIGTERM, signal.SIGKILL]:
            collect()
            for pid, stamp in {**saved, **unrelated}.items():
                if stamp is not None and identity(pid) == stamp:
                    try:
                        os.kill(pid, sig)
                    except ProcessLookupError:
                        pass
            until = min(cleanup_end, time.monotonic() + 2)
            while time.monotonic() < until and any(
                identity(pid) == stamp
                for pid, stamp in {**saved, **unrelated}.items()
                if stamp
            ):
                time.sleep(0.04)
        for proc in [parent, sentinel]:
            if proc:
                try:
                    proc.wait(timeout=max(0.01, cleanup_end - time.monotonic()))
                except subprocess.TimeoutExpired:
                    cleanup_errors.append("child_not_reaped")
        while time.monotonic() < cleanup_end:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
                if pid == 0:
                    time.sleep(0.02)
            except ChildProcessError:
                break
        remaining = sum(
            stamp is not None and identity(pid) == stamp
            for pid, stamp in {**saved, **unrelated}.items()
        ) + len(artifacts())
        if remaining:
            cleanup_errors.append("owned_resources_remain")
        if time.monotonic() > started + 120:
            cleanup_errors.append("whole_120s")
        total_calls = sum(len(value.get("calls", [])) for value in providers().values())
        summary = {
            "scenario": name,
            "pass": error is None
            and natural
            and sentinel_preserved
            and not cleanup_errors,
            "error": error,
            "cleanupErrors": cleanup_errors,
            "providerInvocations": total_calls,
            "stableResults": stable if name == "NORMAL" else None,
            "naturalCleanupProved": natural,
            "sentinelPreserved": sentinel_preserved,
            "ownedResources": remaining,
            "elapsedSeconds": round(time.monotonic() - started, 3),
            "root": str(root),
        }
        dump(root / "summary.json", summary)
        print(json.dumps(summary, separators=(",", ":")), flush=True)
    return summary


def main():
    if ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError("Linux subreaper required")
    caught = planted_faults()
    print(json.dumps({"plantedFaultsCaught": caught}), flush=True)
    for name in ["NORMAL", "PARENTLOSS"]:
        if not scenario(name)["pass"]:
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
