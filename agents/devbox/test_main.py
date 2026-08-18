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
echo "{\"type\":\"argv\",\"args\":\"$*\",\"home\":\"$HOME\"}"
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
