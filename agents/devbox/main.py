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
# The container's own last line of defence, under the 60-min streaming
# connection cap. The middleware owns the one cap callers see
# (middleware/src/lib/devbox-lifetime.ts TASK_MAX_S, DE-48); the two MUST
# agree — a BFF that sends more than this is silently clamped here.
MAX_TIMEOUT_S = 3300


class ModelNotAllowed(ValueError):
    """A requested model the allowlist does not name (DE-40)."""

    def __init__(self, requested: str, allowed: set[str]):
        super().__init__(f"model not allowlisted: {requested}")
        self.requested = requested
        self.allowed = sorted(allowed)


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


def _allowed_models() -> set[str]:
    return {m.strip() for m in os.environ.get(
        "DEVBOX_ALLOWED_MODELS", "").split(",") if m.strip()}


def _resolve_model(requested: str | None) -> str:
    """Model for this task.

    Defaults to whatever the runtime was deployed with (Haiku) and lets a
    caller opt into something larger per task. Most devbox work is small —
    reading a file, running a test, writing a note — and paying Sonnet rates
    for "are you there" is the common case, not the exception.

    A model the allowlist does not name is REFUSED (ModelNotAllowed), never
    silently swapped for the default (DE-40): the middleware already answers
    400 with the allowed set, so a caller that reaches this with a bad model
    has bypassed it and must fail visibly rather than bill something else.
    """
    default = os.environ.get("ANTHROPIC_MODEL", "").strip()
    if not requested:
        return default
    requested = str(requested).strip()
    allowed = _allowed_models()
    if requested in allowed or (not allowed and requested == default):
        return requested
    raise ModelNotAllowed(requested, allowed)


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


# ─── Credentialed git (DE-45) ────────────────────────────────────────────────
#
# InvokeAgentRuntimeCommand takes only a command string, so a clone or push
# through it put the repository token INTO shell text — in `ps`, in the probe
# file the wrapper writes, in git's own error output. This entrypoint is the
# other channel: the token arrives in the invoke payload, is handed to git as
# an HTTP auth header through the child's ENVIRONMENT (GIT_CONFIG_* →
# `http.https://github.com/.extraheader`), and touches neither argv, nor
# .git/config, nor disk. The remote URL stays clean, so no `set-url` dance.

GIT_OPS = ("clone", "push")
_GIT_TIMEOUT_S = 600
_SAFE_REPO = r"^[\w.-]+/[\w.-]+$"
_SAFE_REF = r"^[\w./-]{1,200}$"


def _git_bin() -> str:
    path = shutil.which("git")
    if not path:
        raise RuntimeError("git not found on PATH — image build is broken")
    return path


def _git_env(workspace: str, token: str | None) -> dict:
    """The child's environment: the token as an auth header, never an argument.

    GIT_CONFIG_COUNT/KEY_n/VALUE_n are read by git itself, so nothing is
    written anywhere. `safe.directory` because the checkout may be owned by a
    different uid than this process."""
    env = dict(os.environ)
    env["HOME"] = workspace
    env.pop("GIT_ASKPASS", None)
    env["GIT_TERMINAL_PROMPT"] = "0"
    pairs = [("safe.directory", "*")]
    if token:
        import base64
        basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        pairs.append(("http.https://github.com/.extraheader", f"AUTHORIZATION: basic {basic}"))
    env["GIT_CONFIG_COUNT"] = str(len(pairs))
    for i, (k, v) in enumerate(pairs):
        env[f"GIT_CONFIG_KEY_{i}"] = k
        env[f"GIT_CONFIG_VALUE_{i}"] = v
    return env


def _git_argv(op: str, repo: str, target: str, branch: str | None, commit: str | None, depth: int) -> list[list[str]]:
    """The git invocations for an op. The token is NOT here — see _git_env."""
    import re
    if op not in GIT_OPS:
        raise ValueError(f"unsupported git op: {op}")
    if not re.match(_SAFE_REPO, repo or "") or any(re.fullmatch(r"\.+", seg) for seg in repo.split("/")):
        raise ValueError("repo must be owner/name")
    if not target or not target.startswith("/") or any(c in target for c in "\n\r\0"):
        raise ValueError("target must be an absolute path")
    url = f"https://github.com/{repo}.git"
    git = _git_bin()
    if op == "clone":
        return [[git, "clone", "--depth", str(max(1, int(depth))), url, target]]
    if not branch or not re.match(_SAFE_REF, branch):
        raise ValueError("branch is required for push")
    if commit and not re.match(r"^[0-9a-f]{7,40}$", commit):
        raise ValueError("commit must be a sha")
    steps = []
    if commit:
        steps.append([git, "-C", target, "checkout", "-B", branch, commit])
    else:
        steps.append([git, "-C", target, "checkout", "-B", branch])
    steps.append([git, "-C", target, "push", "-u", url, branch, "--force-with-lease"])
    return steps


async def _run_git(payload: dict) -> AsyncIterator[dict]:
    """Run one credentialed git op and stream its output.

    Events: `git_start` (op, repo, target — never the token), `git_output`
    lines (the token cannot appear: git never saw it as text), and `git_end`
    with the exit code. Output is capped per step."""
    op = str(payload.get("op") or "")
    repo = str(payload.get("repo") or "")
    target = str(payload.get("target") or "")
    branch = payload.get("branch")
    commit = payload.get("commit")
    token = payload.get("token")
    depth = payload.get("depth") or 50
    token = token if isinstance(token, str) and token else None
    workspace, persistent = _resolve_workspace()
    try:
        steps = _git_argv(op, repo, target, branch if isinstance(branch, str) else None,
                          commit if isinstance(commit, str) else None, depth)
    except ValueError as err:
        yield {"type": "git_end", "op": op, "exit_code": 2, "error": str(err)}
        return
    yield {"type": "git_start", "op": op, "repo": repo, "target": target, "authenticated": bool(token),
           "workspace_persistent": persistent}
    if op == "clone":
        shutil.rmtree(target, ignore_errors=True)
        os.makedirs(os.path.dirname(target) or workspace, exist_ok=True)
    env = _git_env(workspace, token)
    rc = 0
    for argv in steps:
        proc = await asyncio.create_subprocess_exec(
            *argv, cwd=workspace, env=env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
            start_new_session=True,
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout=_GIT_TIMEOUT_S)
        except asyncio.TimeoutError:
            _kill_process_group(proc, _GIT_TIMEOUT_S)
            await proc.wait()
            yield {"type": "git_end", "op": op, "exit_code": 124, "error": f"git timed out after {_GIT_TIMEOUT_S}s"}
            return
        text = out.decode("utf-8", errors="replace")[-8000:]
        if text.strip():
            yield {"type": "git_output", "text": text}
        rc = proc.returncode or 0
        if rc != 0:
            break
    yield {"type": "git_end", "op": op, "exit_code": rc}


@app.entrypoint
async def handle(payload: dict) -> AsyncIterator | dict:
    """Payload contract:

    {
      "prompt":  str   (required — the Claude Code task),
      "resume":  bool  (optional — continue the workspace's last conversation),
      "stream":  bool  (optional, default true — SSE stream-json vs single JSON),
      "timeout": int   (optional seconds, capped at MAX_TIMEOUT_S),
      "model":   str   (optional — MUST be on DEVBOX_ALLOWED_MODELS, else an
                        error and no `claude` process, DE-40),
      "lab":     dict  (optional — the run: run_ref, run_token, brief_id,
                        work_item_id, initiative_id, repo, session_id, box_id;
                        set as LAB_* for every `lab` call, see _LAB_ENV)
    }

    Or a credentialed git op (DE-45), which never starts `claude`:

    {
      "op":     "clone" | "push",
      "repo":   "owner/name",
      "target": "/mnt/workspace/<dir>",
      "branch": str   (push),
      "commit": sha   (push, optional — branch from this commit),
      "token":  str   (optional — passed to git as an auth header via env,
                        never argv, config or disk)
    }
    """
    if not isinstance(payload, dict):
        payload = {"prompt": str(payload)}

    if payload.get("op") in GIT_OPS:
        return _run_git(payload)

    prompt = payload.get("prompt") or payload.get("input_text") or payload.get("message") or ""
    if not prompt:
        return {"agent": "devbox", "error": "missing prompt"}

    resume = bool(payload.get("resume", False))
    stream = payload.get("stream", True) is not False
    timeout_s = min(int(payload.get("timeout") or DEFAULT_TIMEOUT_S), MAX_TIMEOUT_S)
    try:
        model = _resolve_model(payload.get("model"))
    except ModelNotAllowed as err:
        log.warning("Refused model %s (allowed: %s)", err.requested, ",".join(err.allowed))
        return {"agent": "devbox", "error": "model not allowlisted", "model": err.requested, "allowed": err.allowed}

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
