"""OrgIQ Devbox — Claude Code inside an AgentCore Runtime microVM.

The runtime-contract wrapper around the Claude Code CLI. Three access modes
exist for this runtime; only the first flows through this file:

  1. Task mode (this wrapper): InvokeAgentRuntime with {"prompt": ...} →
     `claude -p` headless run in /mnt/workspace, stream-json events streamed
     back as SSE.
  2. Command mode: InvokeAgentRuntimeCommand — the platform executes shell
     directly in this container; this wrapper is not in that path.
  3. Interactive: `agentcore exec --it` — platform PTY, also not this wrapper.

Auth chain: the microVM's execution role provides AWS credentials; Claude Code
runs with CLAUDE_CODE_USE_BEDROCK=1 and calls Bedrock inference directly.
No Anthropic API key exists anywhere.

Persistence: HOME is pointed at the session-storage mount so both the working
tree AND Claude Code's own state (~/.claude — conversation history, todo
state) survive stop/resume of the microVM. The mount only exists at
invocation time (never at import time) and is absent entirely under local
`agentcore dev` — everything workspace-related is resolved lazily per request
and degrades to a temp dir when the mount is missing.

CAVEAT (also in CLAUDE.md Gotchas): session storage is wiped on every runtime
version update — i.e. every image push + deploy — and after 14 days idle.
Treat the workspace as a cache; durable work leaves via git or command mode.
"""

import asyncio
import json
import logging
import os
import shutil
import signal
import tempfile
from typing import AsyncIterator

from bedrock_agentcore.runtime import BedrockAgentCoreApp

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

app = BedrockAgentCoreApp()

WORKSPACE_MOUNT = "/mnt/workspace"
# Hard cap below the 15-min synchronous request limit; streaming responses may
# run longer but we keep one conservative default and let callers raise it.
DEFAULT_TIMEOUT_S = int(os.environ.get("DEVBOX_TASK_TIMEOUT_S", "840"))
MAX_TIMEOUT_S = 3300  # under the 60-min streaming connection cap


def _resolve_workspace() -> tuple[str, bool]:
    """Return (workspace_dir, persistent).

    The session-storage mount is only present at invocation time on a runtime
    configured with filesystemConfigurations — and never present under local
    `agentcore dev`. Fall back to a temp dir so the wrapper still functions;
    the response flags persistence so callers aren't misled.
    """
    if os.path.isdir(WORKSPACE_MOUNT) and os.access(WORKSPACE_MOUNT, os.W_OK):
        return WORKSPACE_MOUNT, True
    fallback = os.path.join(tempfile.gettempdir(), "devbox-workspace")
    os.makedirs(fallback, exist_ok=True)
    return fallback, False


def _kill_process_group(proc: asyncio.subprocess.Process, timeout_s: int) -> None:
    """Kill claude AND its descendants (they share the session started with
    start_new_session=True). Falls back to killing just the direct child if
    the group is already gone."""
    log.warning("Task exceeded %ss — killing claude process group", timeout_s)
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        if proc.returncode is None:
            proc.kill()


def _claude_bin() -> str:
    path = shutil.which("claude")
    if not path:
        raise RuntimeError("claude CLI not found on PATH — image build is broken")
    return path


def _resolve_model(requested: str | None) -> str:
    """Model for this task.

    Defaults to whatever the runtime was deployed with (Haiku) and lets a
    caller opt into something larger per task. Most devbox work is small —
    reading a file, running a test, writing a note — and paying Sonnet rates
    for "are you there" is the common case, not the exception. Anything not on
    the allowlist falls back to the default rather than being passed through,
    so a typo cannot silently bill against an unexpected model.
    """
    default = os.environ.get("ANTHROPIC_MODEL", "").strip()
    if not requested:
        return default
    allowed = {m.strip() for m in os.environ.get(
        "DEVBOX_ALLOWED_MODELS", "").split(",") if m.strip()}
    if requested in allowed:
        return requested
    log.warning("Requested model %s is not allowlisted — using %s", requested, default)
    return default


def _build_cmd(prompt: str, resume: bool, output_format: str, model: str = "") -> list[str]:
    cmd = [_claude_bin(), "-p", prompt, "--output-format", output_format]
    if model:
        cmd += ["--model", model]
    if output_format == "stream-json":
        # stream-json requires --verbose in headless mode.
        cmd.append("--verbose")
    if resume:
        # Continue the most recent conversation in this workspace. Safe when
        # none exists yet (Claude Code starts fresh).
        cmd.append("--continue")
    # The microVM IS the sandbox — permission prompts would deadlock headless
    # runs, and there is no interactive user to answer them.
    cmd.append("--dangerously-skip-permissions")
    return cmd


def _model_of(cmd: list[str]) -> str:
    """What this run actually used — the --model flag, else the runtime default."""
    if "--model" in cmd:
        return cmd[cmd.index("--model") + 1]
    return os.environ.get("ANTHROPIC_MODEL", "")


# The run this task is, as the middleware sent it (`lab` in the payload,
# middleware lib/run-brief.ts). Every `lab` call reads these: LAB_RUN_REF and
# LAB_RUN_TOKEN let `lab brief` fetch THIS run's frozen session brief (the
# SessionStart hook) and let `lab applied` / `lab propose` report for it; the
# rest is attribution, which used to fall back to basename(pwd).
_LAB_ENV = {
    "run_ref": "LAB_RUN_REF",
    "run_token": "LAB_RUN_TOKEN",
    "brief_id": "LAB_BRIEF_ID",
    "work_item_id": "LAB_WORK_ITEM_ID",
    "initiative_id": "LAB_INITIATIVE_ID",
    "repo": "LAB_REPO",
    "session_id": "LAB_SESSION_ID",
    "box_id": "LAB_BOX_ID",
}


def _lab_env(lab: object) -> dict:
    """LAB_* variables from the payload's `lab` object. Unknown keys, non-string
    values and anything with a newline are dropped — these land in a shell."""
    if not isinstance(lab, dict):
        return {}
    out = {}
    for key, var in _LAB_ENV.items():
        value = lab.get(key)
        if isinstance(value, str) and value and "\n" not in value and len(value) <= 4096:
            out[var] = value
    return out


def _subprocess_env(workspace: str, lab: object = None) -> dict:
    env = dict(os.environ)
    # HOME on the persistent mount → ~/.claude (session state, --continue
    # history) survives stop/resume alongside the working tree.
    env["HOME"] = workspace
    env.setdefault("CLAUDE_CODE_USE_BEDROCK", "1")
    # A run never inherits another run's identity: clear first, then set.
    for var in _LAB_ENV.values():
        env.pop(var, None)
    env.update(_lab_env(lab))
    return env


async def _run_streaming(cmd: list[str], workspace: str, persistent: bool, timeout_s: int, lab: object = None) -> AsyncIterator[dict]:
    """Spawn claude and yield one dict per stream-json event line.

    Yield DICTS, not pre-serialised JSON strings: BedrockAgentCoreApp
    json-encodes every yielded value into its SSE data frame, so a yielded
    string arrives double-encoded (`data: "{\\"type\\"..."`) and consumers
    that expect `data: {...}` silently skip every event. (Found in the local
    container smoke test — do not regress this.)

    A final devbox-authored event carries exit code + metadata.
    """
    yield {
        "type": "devbox_start",
        "workspace": workspace,
        "workspace_persistent": persistent,
        "model": _model_of(cmd),
    }

    # start_new_session: claude spawns children (bash tool calls, subagents)
    # that inherit the stdout/stderr pipes. A bare proc.kill() on timeout
    # leaves those children holding the pipes, so the read loop below would
    # hang until every grandchild exits. Killing the whole process group
    # closes the pipes and unblocks reads immediately.
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=workspace,
        env=_subprocess_env(workspace, lab),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )

    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_s
    timed_out = False
    assert proc.stdout is not None
    while True:
        remaining = deadline - loop.time()
        if remaining <= 0:
            timed_out = True
            _kill_process_group(proc, timeout_s)
            break
        try:
            raw_line = await asyncio.wait_for(proc.stdout.readline(), timeout=remaining)
        except asyncio.TimeoutError:
            timed_out = True
            _kill_process_group(proc, timeout_s)
            break
        if not raw_line:
            break  # EOF — claude exited and no child holds the pipe
        line = raw_line.decode("utf-8", errors="replace").strip()
        if not line:
            continue
        # Parse stream-json event lines back to dicts for the app to
        # encode once; wrap anything that isn't JSON (stray CLI output)
        # so consumers always receive JSON objects.
        if line.startswith("{"):
            try:
                yield json.loads(line)
                continue
            except json.JSONDecodeError:
                pass
        yield {"type": "devbox_raw", "text": line}
    await proc.wait()

    stderr_tail = b""
    if proc.stderr is not None and not timed_out:
        try:
            stderr_tail = await asyncio.wait_for(proc.stderr.read(), timeout=5)
        except asyncio.TimeoutError:
            stderr_tail = b""

    yield {
        "type": "devbox_end",
        "exit_code": proc.returncode,
        "timed_out": timed_out,
        "stderr": stderr_tail.decode("utf-8", errors="replace")[-4000:],
    }


async def _run_sync(cmd: list[str], workspace: str, persistent: bool, timeout_s: int, lab: object = None) -> dict:
    """Collected single-JSON run (`--output-format json`)."""
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=workspace,
        env=_subprocess_env(workspace, lab),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,  # see _run_streaming — group kill on timeout
    )
    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
    except asyncio.TimeoutError:
        _kill_process_group(proc, timeout_s)
        await proc.wait()
        return {
            "agent": "devbox",
            "error": f"task timed out after {timeout_s}s",
            "workspace": workspace,
            "workspace_persistent": persistent,
        }

    out_text = stdout.decode("utf-8", errors="replace")
    try:
        result = json.loads(out_text)
    except json.JSONDecodeError:
        result = {"raw_output": out_text[-8000:]}

    return {
        "agent": "devbox",
        "exit_code": proc.returncode,
        "result": result,
        "stderr": stderr.decode("utf-8", errors="replace")[-4000:],
        "workspace": workspace,
        "workspace_persistent": persistent,
    }


@app.entrypoint
async def handle(payload: dict) -> AsyncIterator | dict:
    """Payload contract:

    {
      "prompt":  str   (required — the Claude Code task),
      "resume":  bool  (optional — continue the workspace's last conversation),
      "stream":  bool  (optional, default true — SSE stream-json vs single JSON),
      "timeout": int   (optional seconds, capped at MAX_TIMEOUT_S),
      "lab":     dict  (optional — the run: run_ref, run_token, brief_id,
                        work_item_id, initiative_id, repo, session_id, box_id;
                        set as LAB_* for every `lab` call, see _LAB_ENV)
    }
    """
    if not isinstance(payload, dict):
        payload = {"prompt": str(payload)}

    prompt = payload.get("prompt") or payload.get("input_text") or payload.get("message") or ""
    if not prompt:
        return {"agent": "devbox", "error": "missing prompt"}

    resume = bool(payload.get("resume", False))
    stream = payload.get("stream", True) is not False
    timeout_s = min(int(payload.get("timeout") or DEFAULT_TIMEOUT_S), MAX_TIMEOUT_S)
    model = _resolve_model(payload.get("model"))

    workspace, persistent = _resolve_workspace()
    log.info(
        "Devbox task: stream=%s resume=%s persistent=%s model=%s prompt=%s",
        stream, resume, persistent, model or "(default)", prompt[:120],
    )

    if stream:
        cmd = _build_cmd(prompt, resume, "stream-json", model)
        return _run_streaming(cmd, workspace, persistent, timeout_s, payload.get("lab"))

    cmd = _build_cmd(prompt, resume, "json", model)
    return await _run_sync(cmd, workspace, persistent, timeout_s, payload.get("lab"))


if __name__ == "__main__":
    app.run()
