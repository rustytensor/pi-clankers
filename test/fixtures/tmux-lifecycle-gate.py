#!/usr/bin/env python3
"""Reviewed opt-in lifecycle gate: TMUX_GATE_SDK=/absolute/managed/dist/index.js python3 test/fixtures/tmux-lifecycle-gate.py
Runs serially, stops on first failure. No normal standalone gate rerun. No raw output export.
Fixed oracles: PUBLICDISPOSE=1/exact COORD_ONE_OK/stable result; SETUPREFUSAL=0;
PARENTLOSS=0; all must lose every owned worker PID and socket without test cleanup help.
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
import time

HERE = Path(__file__).resolve().parent
EXPECTED = {"PUBLICDISPOSE": 1, "SETUPREFUSAL": 0, "PARENTLOSS": 0}


def scenario(name):
    started = time.monotonic()
    work_end = started + 90  # Reserve final 30 seconds within whole 120s.
    phase_end = started + 30
    root = Path(tempfile.mkdtemp(prefix="ctl-", dir="/srv/devops/scratch"))
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
        "TMUX_LIFECYCLE_SCENARIO": name,
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
    parent = None
    saved = {}
    error = None
    cleanup_errors = []
    stable = False
    proved_resources_zero = False
    ready = None

    def dump(path, value):
        path.write_text(json.dumps(value))
        os.chmod(path, 0o600)

    def load(path, default=None):
        try:
            return json.loads(path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return default

    def provider():
        return load(
            root / "provider.json",
            {"invocations": 0, "calls": [], "sources": [], "error": None},
        )

    def identity(pid):
        try:
            fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
            return None if fields[0] in ["Z", "X"] else fields[19]
        except FileNotFoundError:
            return None

    def live(pid):
        return saved.get(pid) is not None and identity(pid) == saved[pid]

    def collect():
        # Linux subreaper owns all descendants, including the broker's detached server.
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
                assert len(seen) <= 128, "descendant cap"
                stamp = identity(child)
                if stamp is not None:
                    saved.setdefault(child, stamp)
                    queue.append(child)

    def sockets():
        return list((root / "workers").rglob("*.sock"))

    def gone():
        collect()
        return (
            not any(live(pid) for pid in saved if not parent or pid != parent.pid)
            and not sockets()
        )

    def wait(fn, label):
        while time.monotonic() < min(work_end, phase_end):
            collect()
            value = fn()
            if value:
                return value
            time.sleep(0.04)
        raise AssertionError(label)

    def response():
        data = b""
        while time.monotonic() < min(work_end, phase_end):
            collect()
            if not select.select([parent.stdout], [], [], 0.04)[0]:
                continue
            chunk = os.read(parent.stdout.fileno(), 1)
            assert chunk, "coordinator EOF"
            data += chunk
            assert len(data) <= 262144, "response cap"
            if chunk == b"\n":
                if ready:
                    assert ready["identity"]["ownerNonce"].encode() not in data, (
                        "public credential leak"
                    )
                return json.loads(data)
        raise AssertionError("coordinator response deadline")

    def call(request):
        assert parent.poll() is None, "coordinator exited"
        parent.stdin.write((json.dumps(request) + "\n").encode())
        parent.stdin.flush()
        return response()

    def ok(request):
        value = call(request)
        assert value["ok"], "public request refused"
        return value

    def check_count():
        value = provider()
        count = EXPECTED[name]
        assert value["invocations"] == count and value["error"] is None, (
            "provider count/error"
        )
        assert value["calls"] == (["COORD_ONE"] if count else []), "provider inputs"
        assert value["sources"] == (["coordinator"] if count else []), "provider source"

    try:
        sdk = Path(env["TMUX_GATE_SDK"])
        assert sdk.is_absolute() and sdk.is_file(), "absolute managed SDK required"
        env["TMUX_GATE_SDK"] = str(sdk.resolve(strict=True))
        package = load(sdk.resolve().parent.parent / "package.json", {})
        assert (
            package.get("name") == "@earendil-works/pi-coding-agent"
            and package.get("version") == "1.4.0"
        ), "SDK must be managed 1.4.0"
        for source, target in [
            ("tmux-standalone-provider.ts", "provider.ts"),
            ("tmux-standalone-observer.ts", "observer.ts"),
            ("tmux-standalone-no-network.mjs", "no-network.mjs"),
        ]:
            shutil.copyfile(HERE / source, root / target)
        dump(
            root / "agent" / "settings.json",
            {
                "quietStartup": True,
                "compaction": {"enabled": False},
                "retry": {"enabled": False},
            },
        )
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
        node = shutil.which("node")
        assert node, "Node required"
        parent = subprocess.Popen(
            [
                node,
                "--import",
                str(root / "no-network.mjs"),
                str(HERE / "tmux-lifecycle-parent.mjs"),
            ],
            cwd=root / "workspace",
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )
        saved[parent.pid] = identity(parent.pid)
        assert saved[parent.pid], "coordinator identity"
        if name == "PARENTLOSS":
            safe = response()
            assert safe["ready"] and safe["coordinatorPid"] == parent.pid, (
                "runner readiness"
            )
        else:
            ok(
                {
                    "action": "agents.create",
                    "id": "fixture",
                    "prompt": "Synthetic offline gate only.",
                    "model": "standalone-fixture/fixed:off",
                    "tools": [],
                }
            )
            admission = call(
                {
                    "action": "run",
                    "backend": "tmux",
                    "agent": "fixture",
                    "task": "COORD_ONE",
                    "background": name == "PUBLICDISPOSE",
                }
            )
            if name == "SETUPREFUSAL":
                assert not admission["ok"], "missing SDK admitted"
                assert ok({"action": "tmux.workers.list"})["data"] == {"workers": []}, (
                    "reserved slot retained"
                )
                assert not (root / "spawn-proof.jsonl").exists(), (
                    "setup spawned subprocess"
                )
                assert not list((root / "workers").rglob("ready.json")) and gone(), (
                    "setup created worker/socket"
                )
                check_count()
                phase_end = min(work_end, time.monotonic() + 8)
                assert ok({"action": "__dispose"})["disposed"], "drain incomplete"
                wait(gone, "setup cleanup deadline")
                proved_resources_zero = True
            else:
                assert admission["ok"], "run refused"
        if name != "SETUPREFUSAL":
            ready_path = wait(
                lambda: next(
                    iter((root / "workers").glob("worker-*/ready.json")), None
                ),
                "startup 30s",
            )
            ready = load(ready_path)
            assert ready and ready_path.stat().st_mode & 0o777 == 0o600, (
                "private readiness"
            )
            for key, value in {
                "mode": "tui",
                "hasUI": True,
                "stdinTTY": True,
                "stdoutTTY": True,
            }.items():
                assert ready[key] == value, "actual interactive TTY required"
            assert load(root / "ui-proof.json") == {
                "pid": ready["pid"],
                "mode": "tui",
                "hasUI": True,
                "stdinTTY": True,
                "stdoutTTY": True,
            }, "observer TTY proof"
            assert (
                ready["tools"] == []
                and ready["model"] == "standalone-fixture/fixed"
                and ready["thinkingLevel"] == "off"
            ), "worker policy"
            collect()
            assert live(ready["pid"]), "owned Pi not live"
            for pid in [parent.pid, ready["pid"]]:
                assert load(root / f"network-guard-{pid}.json") == {
                    "pid": pid,
                    "installed": True,
                }, "network guard missing"
            assert Path(ready["socketPath"]).is_socket(), "control socket missing"
            # Actual foreground server and broker ancestry, not a process-name guess.
            fields = (
                Path(f"/proc/{ready['pid']}/stat").read_text().rsplit(")", 1)[1].split()
            )
            server_pid = int(fields[1])
            broker_pid = int(
                Path(f"/proc/{server_pid}/stat")
                .read_text()
                .rsplit(")", 1)[1]
                .split()[1]
            )
            assert live(server_pid) and live(broker_pid), "owned server/broker missing"
            assert (
                int(
                    Path(f"/proc/{broker_pid}/stat")
                    .read_text()
                    .rsplit(")", 1)[1]
                    .split()[1]
                )
                == parent.pid
            ), "broker parent mismatch"
            phase_end = work_end
            if name == "PUBLICDISPOSE":
                query = {
                    "action": "agents.result",
                    "id": "fixture",
                    "runId": admission["runId"],
                    "memberRunId": admission["runId"],
                    "full": True,
                }

                def completed():
                    value = ok(query)["data"]
                    return (
                        value.get("result") if value.get("status") == "found" else None
                    )

                row = wait(completed, "completed result")
                assert (
                    row["state"] == "done" and row["final_message"] == "COORD_ONE_OK"
                ), "exact result"
                assert (
                    row["pi_session_id"] == ready["identity"]["sessionId"]
                    and row["stop_reason"] == "stop"
                ), "result identity"
                assert (
                    row["task_id"] == admission["taskId"] and row["full_available"]
                ), "complete canonical result"

                def idle():
                    value = ok(
                        {
                            "action": "tmux.workers.show",
                            "workerId": ready["identity"]["workerId"],
                        }
                    )["data"]
                    return value["phase"] == "idle" and value["currentRunId"] is None

                wait(idle, "kept open idle")
                time.sleep(0.25)
                check_count()
                assert live(ready["pid"]) and live(server_pid) and live(broker_pid), (
                    "idle worker closed early"
                )
                phase_end = min(work_end, time.monotonic() + 8)
                disposed = ok({"action": "__dispose", "resultQuery": query})
                stable = disposed["stableResult"]
                assert disposed["disposed"] and stable, "dispose result changed"
            else:
                assert (
                    safe["workerId"] == ready["identity"]["workerId"]
                    and safe["sessionId"] == ready["identity"]["sessionId"]
                ), "ready binding"
                time.sleep(0.25)
                check_count()
                phase_end = min(work_end, time.monotonic() + 8)
                assert live(parent.pid), "coordinator identity lost"
                os.kill(
                    parent.pid, signal.SIGKILL
                )  # ONLY coordinator; no cleanup before oracle.
            wait(gone, "owned resources survived 8s")
            if name == "PUBLICDISPOSE":
                assert live(parent.pid), "exit cleanup masked public disposal"
            else:
                assert not live(parent.pid), "SIGKILL coordinator survived"
            check_count()
            proved_resources_zero = True
    except BaseException as exc:
        # No exception strings: runtime messages could contain transport credentials.
        error = type(exc).__name__
    finally:
        cleanup_end = min(started + 120, time.monotonic() + 30)
        before = provider()["invocations"]
        # A failed oracle remains failed even when emergency cleanup succeeds.
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
                time.sleep(0.04)
        if parent:
            try:
                parent.wait(timeout=max(0.01, cleanup_end - time.monotonic()))
            except subprocess.TimeoutExpired:
                cleanup_errors.append("coordinator not reaped")
        while time.monotonic() < cleanup_end:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
                if pid == 0:
                    time.sleep(0.02)
            except ChildProcessError:
                break
        collect()
        remaining = sum(live(pid) for pid in saved) + len(sockets())
        if remaining:
            cleanup_errors.append("owned resources remain")
        if (
            provider()["invocations"] != before
            or provider()["invocations"] != EXPECTED[name]
        ):
            cleanup_errors.append("provider count changed/unexpected")
        if time.monotonic() > started + 120:
            cleanup_errors.append("whole deadline exceeded")
        summary = {
            "scenario": name,
            "pass": error is None and not cleanup_errors and proved_resources_zero,
            "errorType": error,
            "cleanupErrors": cleanup_errors,
            "modelCounter": provider()["invocations"],
            "stableResult": stable if name == "PUBLICDISPOSE" else None,
            "ownedResources": remaining,
            "naturalCleanupProved": proved_resources_zero,
            "root": str(root),
            "elapsedSeconds": round(time.monotonic() - started, 3),
        }
        dump(root / "summary.json", summary)
        print(json.dumps(summary, separators=(",", ":")), flush=True)
    return summary["pass"]


def main():
    if ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) != 0:
        raise RuntimeError("Linux subreaper required")
    for name in EXPECTED:
        if not scenario(name):
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
