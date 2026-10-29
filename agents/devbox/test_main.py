"""Unit tests for the devbox wrapper (main.py) — no AWS, no network, no Docker.

Run from agents/devbox/:  python3 -m unittest test_main -v

Strategy:
  - `bedrock_agentcore` is stubbed via sys.modules BEFORE importing main, so
    the tests run on any host Python ≥3.10 without the SDK installed.
  - The `claude` binary is stubbed with generated shell scripts, selected via
    a monkeypatched `_claude_bin`, so subprocess plumbing (streaming, exit
    codes, timeout kill, env propagation) is exercised for real.

Covers:
  1. Streaming yields DICTS (not strings) — the double-encoding regression
     found in the container smoke test.
  2. Stream framing: devbox_start → passthrough events → devbox_end w/ exit 0.
  3. Non-JSON stdout lines wrapped as devbox_raw.
  4. Timeout kills a hung subprocess and flags timed_out.
  5. Sync mode returns collected JSON result + exit code.
  6. Missing prompt → error dict.
  7. resume flag adds --continue; stream mode adds --verbose.
  8. Workspace fallback when /mnt/workspace is absent + HOME pointed at it.
"""

import asyncio
import json
import os
import stat
import sys
import tempfile
import types
import unittest
from pathlib import Path

# ── Stub bedrock_agentcore before importing main ─────────────────────────────

_pkg = types.ModuleType("bedrock_agentcore")
_runtime = types.ModuleType("bedrock_agentcore.runtime")


class _FakeApp:
    def entrypoint(self, fn):
        return fn

    def run(self):  # pragma: no cover
        raise RuntimeError("not used in tests")


_runtime.BedrockAgentCoreApp = _FakeApp
_pkg.runtime = _runtime
sys.modules.setdefault("bedrock_agentcore", _pkg)
sys.modules.setdefault("bedrock_agentcore.runtime", _runtime)

sys.path.insert(0, str(Path(__file__).resolve().parent))
import main  # noqa: E402


# ── Stub claude binaries ─────────────────────────────────────────────────────

def _make_stub(tmpdir: str, body: str) -> str:
    path = os.path.join(tmpdir, "claude")
    with open(path, "w") as f:
        f.write("#!/bin/sh\n" + body)
    os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)
    return path


STREAM_OK = r"""
echo '{"type":"system","subtype":"init","session_id":"abc"}'
echo 'stray non-json line'
echo '{"type":"result","subtype":"success","num_turns":1}'
exit 0
"""

SYNC_OK = r"""
echo '{"type":"result","subtype":"success","result":"hello","total_cost_usd":0.01}'
exit 0
"""

HANG = r"""
echo '{"type":"system","subtype":"init"}'
sleep 60
"""

ECHO_ARGS_AND_ENV = r"""
echo "{\"type\":\"argv\",\"args\":\"$*\",\"home\":\"$HOME\",\"run_ref\":\"${LAB_RUN_REF:-}\"}"
exit 0
"""


def _collect(gen):
    async def _run():
        return [ev async for ev in gen]
    return asyncio.run(_run())


class DevboxWrapperTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.workspace = os.path.join(self.tmp.name, "ws")
        os.makedirs(self.workspace)
        self._orig_claude_bin = main._claude_bin

    def tearDown(self):
        main._claude_bin = self._orig_claude_bin
        self.tmp.cleanup()

    def _use_stub(self, body: str) -> None:
        path = _make_stub(self.tmp.name, body)
        main._claude_bin = lambda: path

    # 1+2+3. Streaming framing ------------------------------------------------

    def test_streaming_yields_dicts_with_envelope(self):
        self._use_stub(STREAM_OK)
        cmd = main._build_cmd("do it", resume=False, output_format="stream-json")
        events = _collect(main._run_streaming(cmd, self.workspace, True, timeout_s=30))

        # Every yield is a dict — never a pre-serialised string (the
        # double-encoding regression).
        for ev in events:
            self.assertIsInstance(ev, dict)

        self.assertEqual(events[0]["type"], "devbox_start")
        self.assertTrue(events[0]["workspace_persistent"])
        types_seen = [e["type"] for e in events]
        self.assertIn("system", types_seen)
        self.assertIn("result", types_seen)
        # Non-JSON stdout wrapped, not dropped and not passed through raw.
        raws = [e for e in events if e["type"] == "devbox_raw"]
        self.assertEqual(len(raws), 1)
        self.assertEqual(raws[0]["text"], "stray non-json line")

        end = events[-1]
        self.assertEqual(end["type"], "devbox_end")
        self.assertEqual(end["exit_code"], 0)
        self.assertFalse(end["timed_out"])

    # 4. Timeout --------------------------------------------------------------

    def test_streaming_timeout_kills_subprocess(self):
        self._use_stub(HANG)
        cmd = main._build_cmd("hang", resume=False, output_format="stream-json")
        events = _collect(main._run_streaming(cmd, self.workspace, True, timeout_s=2))
        end = events[-1]
        self.assertEqual(end["type"], "devbox_end")
        self.assertTrue(end["timed_out"])
        self.assertNotEqual(end["exit_code"], 0)

    # 5. Sync mode ------------------------------------------------------------

    def test_sync_mode_returns_parsed_result(self):
        self._use_stub(SYNC_OK)
        cmd = main._build_cmd("do it", resume=False, output_format="json")
        out = asyncio.run(main._run_sync(cmd, self.workspace, True, timeout_s=30))
        self.assertEqual(out["agent"], "devbox")
        self.assertEqual(out["exit_code"], 0)
        self.assertEqual(out["result"]["result"], "hello")
        self.assertTrue(out["workspace_persistent"])

    # 6. Entrypoint validation ------------------------------------------------

    def test_missing_prompt_is_an_error(self):
        out = asyncio.run(main.handle({}))
        self.assertEqual(out, {"agent": "devbox", "error": "missing prompt"})

    # 7. Command construction -------------------------------------------------

    def test_resume_and_stream_flags(self):
        self._use_stub(ECHO_ARGS_AND_ENV)
        cmd = main._build_cmd("task", resume=True, output_format="stream-json")
        events = _collect(main._run_streaming(cmd, self.workspace, True, timeout_s=30))
        argv = next(e for e in events if e["type"] == "argv")
        self.assertIn("--continue", argv["args"])
        self.assertIn("--verbose", argv["args"])
        self.assertIn("--dangerously-skip-permissions", argv["args"])
        self.assertIn("stream-json", argv["args"])
        # HOME pinned to the workspace so ~/.claude persists with the files.
        self.assertEqual(argv["home"], self.workspace)

        sync_cmd = main._build_cmd("task", resume=False, output_format="json")
        self.assertNotIn("--continue", sync_cmd)
        self.assertNotIn("--verbose", sync_cmd)

    # 8. Workspace fallback ---------------------------------------------------

    def test_workspace_fallback_when_mount_absent(self):
        # /mnt/workspace does not exist on dev machines/CI — must fall back.
        ws, persistent = main._resolve_workspace()
        if os.path.isdir(main.WORKSPACE_MOUNT) and os.access(main.WORKSPACE_MOUNT, os.W_OK):
            self.assertTrue(persistent)  # pragma: no cover — real mount present
        else:
            self.assertFalse(persistent)
            self.assertTrue(os.path.isdir(ws))


    # 9. The run's LAB_* env (lane E) ----------------------------------------

    def test_lab_payload_sets_the_run_env_and_nothing_else(self):
        os.environ["LAB_RUN_TOKEN"] = "stale-from-another-run"
        try:
            env = main._subprocess_env(self.workspace, {
                "run_ref": "job-1", "run_token": "tok", "brief_id": "brief-job-1",
                "work_item_id": "wi-1", "initiative_id": "p-auth", "repo": "o/r",
                "session_id": "s-1", "box_id": "box-1",
                "evil": "x", "repo_newline": "a\nb",
            })
            self.assertEqual(env["LAB_RUN_REF"], "job-1")
            self.assertEqual(env["LAB_RUN_TOKEN"], "tok")
            self.assertEqual(env["LAB_BRIEF_ID"], "brief-job-1")
            self.assertEqual(env["LAB_REPO"], "o/r")
            self.assertEqual(env["LAB_SESSION_ID"], "s-1")
            self.assertNotIn("evil", env)
            # No run → no inherited run identity.
            bare = main._subprocess_env(self.workspace, None)
            self.assertNotIn("LAB_RUN_TOKEN", bare)
            self.assertNotIn("LAB_RUN_REF", bare)
            # A value with a newline never reaches a shell.
            self.assertNotIn("LAB_REPO", main._subprocess_env(self.workspace, {"repo": "a\nb"}))
        finally:
            del os.environ["LAB_RUN_TOKEN"]

    def test_lab_env_reaches_the_claude_process(self):
        self._use_stub(ECHO_ARGS_AND_ENV)
        cmd = main._build_cmd("task", resume=False, output_format="stream-json")
        events = _collect(main._run_streaming(cmd, self.workspace, True, timeout_s=30, lab={"run_ref": "job-9", "run_token": "t9"}))
        argv = next(e for e in events if e["type"] == "argv")
        self.assertEqual(argv["run_ref"], "job-9")


    # 10. Model allowlist is a refusal, not a fallback (DE-40) ----------------

    def test_unlisted_model_is_refused_and_starts_no_claude(self):
        marker = os.path.join(self.tmp.name, "claude-ran")
        self._use_stub(f"touch {marker}\necho '{{\"type\":\"result\"}}'\n")
        saved = {k: os.environ.get(k) for k in ("DEVBOX_ALLOWED_MODELS", "ANTHROPIC_MODEL")}
        os.environ["DEVBOX_ALLOWED_MODELS"] = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
        os.environ["ANTHROPIC_MODEL"] = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
        try:
            out = asyncio.run(main.handle({"prompt": "hi", "model": "us.anthropic.claude-opus-4-8"}))
            self.assertIsInstance(out, dict)
            self.assertEqual(out["error"], "model not allowlisted")
            self.assertEqual(out["allowed"], ["us.anthropic.claude-haiku-4-5-20251001-v1:0"])
            self.assertFalse(os.path.exists(marker), "claude must not start for a refused model")
            # A listed model, and no model at all, still resolve.
            self.assertEqual(main._resolve_model("us.anthropic.claude-haiku-4-5-20251001-v1:0"),
                             "us.anthropic.claude-haiku-4-5-20251001-v1:0")
            self.assertEqual(main._resolve_model(None), "us.anthropic.claude-haiku-4-5-20251001-v1:0")
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    # 11. Credentialed git keeps the token out of argv, config and disk (DE-45)

    def test_git_op_passes_the_token_through_env_only(self):
        token = "ghs_SECRET_token_value_123"
        out_file = os.path.join(self.tmp.name, "git-calls")
        git = os.path.join(self.tmp.name, "git")
        with open(git, "w") as f:
            # Records argv, and whether the auth header reached git's env.
            f.write("#!/bin/sh\n"
                    f"echo \"ARGV $*\" >> {out_file}\n"
                    f"echo \"HDR ${{GIT_CONFIG_KEY_1:-}}\" >> {out_file}\n"
                    "echo cloned\n")
        os.chmod(git, 0o755)
        orig = main._git_bin
        main._git_bin = lambda: git
        try:
            target = os.path.join(self.workspace, "widgets")
            gen = asyncio.run(main.handle({"op": "clone", "repo": "acme/widgets", "target": target, "token": token}))
            events = _collect(gen)
        finally:
            main._git_bin = orig
        self.assertEqual(events[0]["type"], "git_start")
        self.assertTrue(events[0]["authenticated"])
        self.assertEqual(events[-1], {"type": "git_end", "op": "clone", "exit_code": 0})
        calls = Path(out_file).read_text()
        self.assertIn("ARGV clone --depth 50 https://github.com/acme/widgets.git", calls)
        self.assertIn("HDR http.https://github.com/.extraheader", calls)
        self.assertNotIn(token, calls)                       # not in argv
        self.assertNotIn(token, json.dumps(events))          # not in any event
        self.assertNotIn("x-access-token", calls)
        # The header value carries it, base64'd, in the CHILD env only.
        env = main._git_env(self.workspace, token)
        self.assertNotIn(token, env.get("GIT_CONFIG_VALUE_1", ""))
        self.assertTrue(env["GIT_CONFIG_VALUE_1"].startswith("AUTHORIZATION: basic "))
        self.assertNotIn("GIT_CONFIG_KEY_1", main._git_env(self.workspace, None))

    def test_git_op_refuses_bad_input_without_running_git(self):
        for payload in (
            {"op": "clone", "repo": "../etc", "target": "/tmp/x"},
            {"op": "clone", "repo": "a/b", "target": "relative"},
            {"op": "push", "repo": "a/b", "target": "/tmp/x"},
            {"op": "push", "repo": "a/b", "target": "/tmp/x", "branch": "b", "commit": "zz; rm"},
        ):
            events = _collect(asyncio.run(main.handle(payload)))
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["type"], "git_end")
            self.assertEqual(events[0]["exit_code"], 2)


# ── DE-35: the token ceiling and a closed stream ─────────────────────────────

# Streams usage turns forever and leaves a grandchild holding a pid file, so a
# test can tell whether the whole process group died, not just claude.
USAGE_STREAM = r"""
sleep 300 &
echo $! > "$PIDFILE"
i=0
while true; do
  i=$((i+1))
  echo "{\"type\":\"assistant\",\"message\":{\"id\":\"m$i\",\"usage\":{\"input_tokens\":10,\"cache_creation_input_tokens\":900,\"cache_read_input_tokens\":5000,\"output_tokens\":90}}}"
  # The same message again (one event per content block): counted once.
  echo "{\"type\":\"assistant\",\"message\":{\"id\":\"m$i\",\"usage\":{\"input_tokens\":10,\"cache_creation_input_tokens\":900,\"cache_read_input_tokens\":5000,\"output_tokens\":90}}}"
  sleep 0.05
done
"""


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # A zombie still answers kill(0); ask ps for its state.
    import subprocess
    state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return bool(state) and not state.startswith("Z")


def _wait_dead(pid: int, seconds: float = 3.0) -> bool:
    import time
    end = time.time() + seconds
    while time.time() < end:
        if not _alive(pid):
            return True
        time.sleep(0.05)
    return not _alive(pid)


class DevboxBudgetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.workspace = os.path.join(self.tmp.name, "ws")
        os.makedirs(self.workspace)
        self.pidfile = os.path.join(self.tmp.name, "child.pid")
        os.environ["PIDFILE"] = self.pidfile
        self._orig_claude_bin = main._claude_bin
        path = _make_stub(self.tmp.name, USAGE_STREAM)
        main._claude_bin = lambda: path

    def tearDown(self):
        main._claude_bin = self._orig_claude_bin
        os.environ.pop("PIDFILE", None)
        self.tmp.cleanup()

    def _child_pid(self) -> int:
        with open(self.pidfile) as f:
            return int(f.read().strip())

    def test_crossing_the_token_ceiling_kills_the_group(self):
        cmd = main._build_cmd("spend", resume=False, output_format="stream-json")
        events = _collect(main._run_streaming(
            cmd, self.workspace, True, timeout_s=30, budget={"max_fresh_tokens": 3000, "reason_ref": "hold-1"}))
        end = events[-1]
        self.assertEqual(end["type"], "devbox_end")
        self.assertEqual(end["killed_reason"], "budget")
        self.assertFalse(end["timed_out"])
        # 1000 fresh per message (cache reads excluded, duplicates once): the
        # third message crosses 3000.
        self.assertEqual(end["fresh_tokens"], 3000)
        self.assertEqual(len([e for e in events if e["type"] == "assistant"]), 5)
        self.assertTrue(_wait_dead(self._child_pid()), "the grandchild outlived the budget kill")

    def test_no_budget_means_no_budget_kill(self):
        cmd = main._build_cmd("spend", resume=False, output_format="stream-json")
        events = _collect(main._run_streaming(cmd, self.workspace, True, timeout_s=1, budget={"max_fresh_tokens": 0}))
        self.assertEqual(events[-1]["killed_reason"], "timeout")
        self.assertNotIn("fresh_tokens", events[-1])

    def test_closing_the_stream_kills_the_group(self):
        cmd = main._build_cmd("spend", resume=False, output_format="stream-json")

        async def run():
            gen = main._run_streaming(cmd, self.workspace, True, timeout_s=30)
            seen = 0
            async for ev in gen:
                if ev["type"] == "assistant":
                    seen += 1
                    if seen == 2:
                        break
            await gen.aclose()

        asyncio.run(run())
        self.assertTrue(_wait_dead(self._child_pid()), "the grandchild outlived the closed stream")

    def test_cancelling_the_task_kills_the_group(self):
        cmd = main._build_cmd("spend", resume=False, output_format="stream-json")

        async def consume():
            async for _ in main._run_streaming(cmd, self.workspace, True, timeout_s=30):
                pass

        async def run():
            task = asyncio.ensure_future(consume())
            await asyncio.sleep(0.5)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        asyncio.run(run())
        self.assertTrue(_wait_dead(self._child_pid()), "the grandchild outlived the cancelled task")

    def test_the_payload_budget_reaches_the_stream(self):
        captured = {}
        orig = main._run_streaming

        def fake(cmd, workspace, persistent, timeout_s, lab=None, budget=None):
            captured["budget"] = budget
            return orig(cmd, workspace, persistent, timeout_s, lab, budget)

        main._run_streaming = fake
        try:
            gen = asyncio.run(main.handle({"prompt": "x", "budget": {"max_fresh_tokens": 1500}}))
            events = _collect(gen)
        finally:
            main._run_streaming = orig
        self.assertEqual(captured["budget"], {"max_fresh_tokens": 1500})
        self.assertEqual(events[-1]["killed_reason"], "budget")


if __name__ == "__main__":
    unittest.main(verbosity=2)
