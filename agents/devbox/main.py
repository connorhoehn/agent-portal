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

The microVM runner (`"runner": "microvm"`, docs/microvm-runner-design.md)
is the same file on a runtime with no session storage: boot → task → push,
one work item per session, the run token and fleet secret held by an
in-process lab broker on a unix socket instead of the `claude` environment.

CAVEAT (also in CLAUDE.md Gotchas): session storage is wiped on every runtime
version update — i.e. every image push + deploy — and after 14 days idle.
Treat the workspace as a cache; durable work leaves via git or command mode.
"""

import asyncio
import base64
import contextlib
import hashlib
import json
import logging
import os
import re
import shutil
import signal
import stat
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import AsyncIterator

from bedrock_agentcore.runtime import BedrockAgentCoreApp

try:  # image: copied next to main.py; checkout: agents/_shared
    from secret_resolver import SecretResolutionError, resolve_secret
except ImportError:  # pragma: no cover - local run from the repo
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_shared"))
    from secret_resolver import SecretResolutionError, resolve_secret

try:  # the lab broker signs with the shared envelope signer (agents/_shared/callbacks.py)
    import callbacks as _callbacks
except ImportError:  # pragma: no cover - an image that did not copy callbacks.py
    _callbacks = None

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


def _kill_process_group(proc: asyncio.subprocess.Process, timeout_s: int, why: str = "timeout") -> None:
    """Kill claude AND its descendants (they share the session started with
    start_new_session=True). Falls back to killing just the direct child if
    the group is already gone."""
    if why == "timeout":
        log.warning("Task exceeded %ss — killing claude process group", timeout_s)
    else:
        log.warning("Task stopped (%s) — killing claude process group", why)
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


def _build_cmd(prompt: str, resume: bool, output_format: str, model: str = "",
               resume_session_id: str | None = None) -> list[str]:
    """The `claude -p` argv, for both runners.

    No `--dangerously-skip-permissions` (design §14 step 2): what a run may do
    is the managed settings' `permissions.allow` / `permissions.deny`
    (managed-settings.json, baked into /etc/claude-code), and in `-p` mode a
    call no rule allows is refused and reported to the model, not prompted.

    `resume_session_id` (microVM, design §9) resumes one recorded session by
    id; `resume` (fleet only) keeps today's `--continue`. The microVM path
    never passes `resume`."""
    cmd = [_claude_bin(), "-p", prompt, "--output-format", output_format]
    if model:
        cmd += ["--model", model]
    if output_format == "stream-json":
        # stream-json requires --verbose in headless mode.
        cmd.append("--verbose")
    if resume_session_id:
        cmd += ["--resume", resume_session_id]
    elif resume:
        # Fleet: continue the most recent conversation in this workspace. Safe
        # when none exists yet (Claude Code starts fresh).
        cmd.append("--continue")
    return cmd


def _prompt_digest(prompt: str) -> tuple[int, str]:
    """What the logs say about a prompt: its length and sha256, never its text (design §11)."""
    return len(prompt), hashlib.sha256(prompt.encode("utf-8", errors="replace")).hexdigest()


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
    # The lab callback secret comes from Secrets Manager by name
    # (LAB_CALLBACK_SECRET_ID); `lab` reads it as LAB_CALLBACK_SECRET.
    try:
        lab_secret = resolve_secret("LAB_CALLBACK_SECRET")
    except SecretResolutionError as exc:
        log.error("devbox: %s; `lab` calls will go unsigned", exc)
        lab_secret = ""
    if lab_secret:
        env["LAB_CALLBACK_SECRET"] = lab_secret
    else:
        env.pop("LAB_CALLBACK_SECRET", None)
    return env


def _budget_tokens(budget: object) -> int | None:
    """The fresh-token ceiling from the payload's `budget` (DE-35), or None.

    The middleware converts its dollar ceiling (the run's spend hold plus the
    top-ups it may still take) into tokens at the model's OUTPUT rate, the
    pessimistic one, so this file needs no price table."""
    if not isinstance(budget, dict):
        return None
    raw = budget.get("max_fresh_tokens")
    if isinstance(raw, bool) or not isinstance(raw, (int, float)) or raw <= 0:
        return None
    return int(raw)


class _FreshTokenMeter:
    """Fresh tokens so far: input + cache_creation + output, the rule the
    middleware's extractUsage uses (cache reads are excluded: they were
    counted on the turn that created them).

    Claude Code repeats one message's usage on every content block it emits
    for that message, so usage is kept per message id (the largest seen) and
    summed across ids; the final `result` event's run total is ignored here."""

    def __init__(self) -> None:
        self._by_message: dict[str, int] = {}
        self._anonymous = 0

    @staticmethod
    def _fresh(usage: dict) -> int:
        def n(key: str) -> int:
            v = usage.get(key)
            return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 else 0
        return n("input_tokens") + n("cache_creation_input_tokens") + n("output_tokens")

    def observe(self, ev: object) -> None:
        if not isinstance(ev, dict) or ev.get("type") == "result":
            return
        message = ev.get("message") if isinstance(ev.get("message"), dict) else None
        usage = ev.get("usage") if isinstance(ev.get("usage"), dict) else (
            message.get("usage") if message and isinstance(message.get("usage"), dict) else None)
        if not usage:
            return
        fresh = self._fresh(usage)
        mid = message.get("id") if message else None
        if isinstance(mid, str) and mid:
            self._by_message[mid] = max(self._by_message.get(mid, 0), fresh)
        else:
            self._anonymous += fresh

    @property
    def total(self) -> int:
        return self._anonymous + sum(self._by_message.values())


async def _run_streaming(cmd: list[str], workspace: str, persistent: bool, timeout_s: int, lab: object = None,
                         budget: object = None, env: dict | None = None) -> AsyncIterator[dict]:
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
        env=env if env is not None else _subprocess_env(workspace, lab),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )

    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout_s
    timed_out = False
    # Why the group was killed: 'timeout' | 'budget' | 'cancelled' | None (DE-35).
    killed: str | None = None
    max_fresh = _budget_tokens(budget)
    meter = _FreshTokenMeter()
    finished = False
    assert proc.stdout is not None
    try:
        while True:
            remaining = deadline - loop.time()
            if remaining <= 0:
                timed_out = True
                killed = "timeout"
                _kill_process_group(proc, timeout_s)
                break
            try:
                raw_line = await asyncio.wait_for(proc.stdout.readline(), timeout=remaining)
            except asyncio.TimeoutError:
                timed_out = True
                killed = "timeout"
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
            event: dict | None = None
            if line.startswith("{"):
                try:
                    parsed = json.loads(line)
                    event = parsed if isinstance(parsed, dict) else {"type": "devbox_raw", "text": line}
                except json.JSONDecodeError:
                    event = None
            if event is None:
                event = {"type": "devbox_raw", "text": line}
            yield event
            # The token ceiling (DE-35): checked after the event is forwarded,
            # so the middleware sees the usage that crossed it.
            if max_fresh is not None:
                meter.observe(event)
                if meter.total >= max_fresh:
                    killed = "budget"
                    _kill_process_group(proc, timeout_s, "budget")
                    break
        await proc.wait()
        finished = True
    finally:
        # A closed stream (the caller aborted, AgentCore cancelled the
        # request) lands here as GeneratorExit/CancelledError at the yield:
        # without this, claude kept running — and billing — after nobody was
        # listening.
        if not finished and proc.returncode is None:
            _kill_process_group(proc, timeout_s, "cancelled")

    stderr_tail = b""
    if proc.stderr is not None and not timed_out and killed != "budget":
        try:
            stderr_tail = await asyncio.wait_for(proc.stderr.read(), timeout=5)
        except asyncio.TimeoutError:
            stderr_tail = b""

    yield {
        "type": "devbox_end",
        "exit_code": proc.returncode,
        "timed_out": timed_out,
        "killed_reason": killed,
        **({"fresh_tokens": meter.total, "max_fresh_tokens": max_fresh} if max_fresh is not None else {}),
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
# A ref can never be read as an option (no leading dash) or climb (no "..").
_SAFE_REF = r"^[A-Za-z0-9][\w./-]{0,199}$"


def _safe_ref(ref: object) -> bool:
    return isinstance(ref, str) and bool(re.match(_SAFE_REF, ref)) and ".." not in ref \
        and not ref.endswith((".lock", "/", ".")) and "//" not in ref


class BadTarget(ValueError):
    """A clone target outside the workspace (design §4)."""


def _workspace_root() -> str:
    return os.path.realpath(_resolve_workspace()[0])


def _confine(target: object, root: str | None = None) -> str:
    """The target's realpath, or BadTarget unless it is STRICTLY under the
    workspace root. Called before any delete or git call (design §4)."""
    root = os.path.realpath(root or _workspace_root())
    if not isinstance(target, str) or not target.startswith("/") or any(c in target for c in "\n\r\0"):
        raise BadTarget("target must be an absolute path")
    real = os.path.realpath(target)
    if root == "/" or real == root or os.path.commonpath([root, real]) != root:
        raise BadTarget("target must be strictly under the workspace")
    return real


def _wipe(root: str) -> int:
    """`find $root -mindepth 1 -delete`, then recreate ~/.claude (design §4).

    Never follows a link: a symlink in the workspace is unlinked, not its
    target emptied. Returns the number of top-level entries removed."""
    root = os.path.realpath(root)
    if root == "/" or not os.path.isabs(root):
        raise BadTarget("refusing to wipe /")
    with os.scandir(root) as it:
        entries = list(it)
    for entry in entries:
        if entry.is_dir(follow_symlinks=False):
            shutil.rmtree(entry.path)
        else:
            os.unlink(entry.path)
    os.makedirs(os.path.join(root, ".claude"), mode=0o700, exist_ok=True)
    return len(entries)


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
    if not branch or not _safe_ref(branch):
        raise ValueError("branch is required for push")
    if commit and not re.match(r"^[0-9a-f]{7,40}$", commit):
        raise ValueError("commit must be a sha")
    steps = []
    if commit:
        steps.append([git, "-C", target, "checkout", "-B", branch, commit, "--"])
    else:
        steps.append([git, "-C", target, "checkout", "-B", branch, "--"])
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
        # Confined BEFORE the rmtree below (design §4): `/etc` or
        # `/mnt/workspace/../etc` never reaches a delete.
        if target.startswith("/"):
            target = _confine(target, workspace)
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


# ─── The microVM runner (docs/microvm-runner-design.md §3 §4 §8 §9 §11) ───────
#
# One session runs one work item, as three invokes on one runtime session:
#
#   boot  wipe the workspace, clone (read token in the git child's env only),
#         start the lab broker (run token + fleet secret in THIS process's
#         memory only), check the skill library's sha through the broker.
#   task  `claude -p` under the managed allowlist with no credential in its
#         environment; snapshot commit; transcript → presigned PUT; one
#         devbox_end with the run's numbers.
#   push  push the branch (write token in the git child's env only).
#
# Claude never holds a credential that leaves the VM (design §2, §8).

MICROVM_OPS = ("boot", "task", "push")
_LAB_SOCKET_DEFAULT = "/run/orgiq/lab.sock"
_LAB_SERVICE_ID = "orgiq-devbox"            # middleware service-auth.ts DEVBOX_SERVICE_ID
_LAB_AUDIENCE = "orgiq-middleware/lab"      # middleware LAB_CALLBACK_SERVICE_AUTH.signed.audience
_LIBRARY_FORMAT = "orgiq-skill-library/1"   # the `lab skills` wire format
_DEFAULT_AUTHOR = {"name": "OrgIQ Agent", "email": "agent@orgiq.local"}
_RESPONSE_MAX = 32 * 1024 * 1024            # the broker's upstream cap (lab's --max-filesize)
_BROKER_BODY_MAX = 1024 * 1024
_TRANSCRIPT_MAX = 256 * 1024 * 1024
_SAFE_ID = r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$"
_SESSION_UUID = r"^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$"
_BRANCH_PREFIX = "orgiq/"

# What the `claude` child never inherits (design §8, pinned by a test).
#
# The design's "AWS_* other than region" line was wrong: `claude` must call
# Bedrock as the execution role, and on AgentCore (as on ECS) that role reaches
# the process through the container credential provider variables
# (AWS_CONTAINER_CREDENTIALS_FULL_URI / _RELATIVE_URI, AWS_CONTAINER_AUTHORIZATION_TOKEN[_FILE]),
# or web identity (AWS_WEB_IDENTITY_TOKEN_FILE, AWS_ROLE_ARN, AWS_ROLE_SESSION_NAME),
# not static keys. Stripping every AWS_* cut Claude off from Bedrock. So only
# STATIC credentials, and the files/profiles that could point at some, are
# stripped; the provider variables, the region, AWS_EXECUTION_ENV, AWS_BEDROCK_*
# and CLAUDE_CODE_USE_BEDROCK / ANTHROPIC_* model settings pass through.
_CLAUDE_ENV_STRIP = (
    "LAB_RUN_TOKEN", "LAB_CALLBACK_SECRET", "LAB_CALLBACK_SECRET_ID",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
    "AWS_PROFILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE",
    "GH_TOKEN", "GITHUB_TOKEN",
)
_CLAUDE_ENV_STRIP_PREFIXES = ("GIT_CONFIG",)

# Seam: every HTTP call this file makes (broker upstream, transcript GET/PUT).
_urlopen = urllib.request.urlopen


class _Refusal(Exception):
    def __init__(self, error: str, detail: str = ""):
        super().__init__(error)
        self.error = error
        self.detail = detail

    def result(self) -> dict:
        return {"ok": False, "error": self.error, "detail": self.detail}


def _lab_socket_path() -> str:
    return os.environ.get("LAB_BROKER_SOCKET") or _LAB_SOCKET_DEFAULT


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _clean_str(value: object, limit: int = 4096) -> str | None:
    if isinstance(value, str) and value and len(value) <= limit and not any(c in value for c in "\n\r\0"):
        return value
    return None


def _https_url(value: object) -> str | None:
    url = _clean_str(value, 8192)
    if not url or not url.startswith("https://") or re.search(r"\s", url):
        return None
    return url


def _author(value: object) -> dict | None:
    """{name, email} for a commit, or None when the payload has none usable."""
    if not isinstance(value, dict):
        return None
    name, email = _clean_str(value.get("name"), 200), _clean_str(value.get("email"), 320)
    if not name or not email or any(c in name for c in "<>") or not re.fullmatch(r"[^\s<>@]+@[^\s<>@]+", email):
        return None
    return {"name": name, "email": email}


def _stripped_for_claude(name: str) -> bool:
    return name in _CLAUDE_ENV_STRIP or name.startswith(_CLAUDE_ENV_STRIP_PREFIXES)


def _cwd_slug(cwd: str) -> str:
    """Claude Code's project folder for a cwd: every non-alphanumeric → '-'."""
    return re.sub(r"[^A-Za-z0-9]", "-", cwd)


def _transcript_path(home: str, cwd: str, session_id: str) -> str:
    return os.path.join(home, ".claude", "projects", _cwd_slug(cwd), f"{session_id}.jsonl")


def _library_sha(body: bytes, header_sha: str = "") -> str | None:
    """The skill library's set sha, recomputed the way `lab skills` does, or
    None when the body is not a self-consistent library."""
    try:
        lib = json.loads(body)
        if not isinstance(lib, dict) or lib.get("format") != _LIBRARY_FORMAT:
            return None
        lines = []
        for f in lib.get("files", []):
            data = str(f.get("content", "")).encode("utf-8")
            sha = f.get("sha256", "")
            if hashlib.sha256(data).hexdigest() != sha:
                return None
            lines.append(f"{f.get('path', '')} {f.get('mode')} {sha}")
    except (ValueError, TypeError, AttributeError):
        return None
    got = hashlib.sha256(("\n".join([_LIBRARY_FORMAT] + sorted(lines)) + "\n").encode()).hexdigest()
    if got != lib.get("sha256") or (header_sha and got != header_sha):
        return None
    return got


# ── The lab broker (design §8) ───────────────────────────────────────────────

class LabBroker:
    """An HTTP/1.1 server on a unix socket that `lab` talks to instead of the
    middleware. It holds the run token and the fleet secret in memory, refuses
    every path that is not this run's, signs the service envelope with
    agents/_shared/callbacks.py's signer, adds `x-lab-run-token`, and forwards
    to `lab_api_base`. One request per connection."""

    # Headers `lab` may set that are forwarded; everything else (including any
    # x-lab-run-token or X-Service-Auth `lab` was talked into sending) is dropped.
    _PASS_REQUEST = ("accept", "content-type", "if-none-match")
    _PASS_RESPONSE = ("content-type", "etag", "x-skill-library-sha256", "x-brief-sha256", "cache-control")

    def __init__(self, *, run_ref: str, run_token: str, secret: str, api_base: str, socket_path: str):
        self.run_ref = run_ref
        self._run_token = run_token
        self._secret = secret
        self.api_base = api_base.rstrip("/")
        self.socket_path = socket_path
        self._run_segments = {run_ref, urllib.parse.quote(run_ref, safe="")}
        self._server: asyncio.base_events.Server | None = None

    async def start(self) -> None:
        parent = os.path.dirname(self.socket_path)
        os.makedirs(parent, mode=0o700, exist_ok=True)
        if os.path.lexists(self.socket_path):
            os.unlink(self.socket_path)
        old = os.umask(0o177)  # the socket is born 0600, no window at 0755
        try:
            self._server = await asyncio.start_unix_server(self._handle, path=self.socket_path)
        finally:
            os.umask(old)
        os.chmod(self.socket_path, 0o600)

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            with contextlib.suppress(Exception):
                await self._server.wait_closed()
            self._server = None
        with contextlib.suppress(FileNotFoundError):
            os.unlink(self.socket_path)

    def allowed(self, method: str, target: str) -> bool:
        """Only this run's routes: /api/runs/<run_ref>/…, /api/lab/…, and the
        two run-scoped runbook writes `lab applied|propose|keep` make."""
        if method not in ("GET", "POST") or not target.startswith("/") or re.search(r"[\s#\\]", target):
            return False
        path = target.split("?", 1)[0]
        if re.search(r"%(2[fFeE]|5[cC]|00)", path):
            return False  # no encoded separators, dots or NULs
        segs = path.split("/")[1:]
        if any(s in ("", ".", "..") for s in segs):
            return False
        if len(segs) >= 3 and segs[:2] == ["api", "lab"]:
            return True
        if len(segs) >= 4 and segs[:2] == ["api", "runs"] and segs[2] in self._run_segments:
            return True
        if method == "POST" and segs == ["api", "runbooks", "proposals"]:
            return True
        if method == "POST" and len(segs) == 4 and segs[:2] == ["api", "runbooks"] and segs[3] == "applications" \
                and re.fullmatch(r"[A-Za-z0-9._-]{1,120}", segs[2]):
            return True
        return False

    def stamp_run_ref(self, body: bytes) -> bytes | None:
        """Every /api/lab/* POST is filed for THIS run (sweep 4 M1): whatever
        `run_ref` the body names is replaced by the boot's, and the middleware
        refuses a body run_ref that is not the token's run. None when the body
        is not one JSON object (refused, never forwarded)."""
        try:
            doc = json.loads(body.decode("utf-8")) if body.strip() else {}
        except ValueError:
            return None
        if not isinstance(doc, dict):
            return None
        doc["run_ref"] = self.run_ref
        return json.dumps(doc, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    def _forward(self, method: str, target: str, body: bytes, headers: dict) -> tuple[int, dict, bytes]:
        url = self.api_base + target
        out = {k: headers[k] for k in self._PASS_REQUEST if k in headers}
        if self._secret:
            if _callbacks is None:
                return 500, {"content-type": "application/json"}, b'{"error":"lab broker: signer unavailable"}'
            if _callbacks.legacy_headers_allowed():
                out["x-lab-auth"] = self._secret
            nonce = _callbacks.new_nonce()
            out[_callbacks.SERVICE_AUTH_HEADER] = _callbacks.sign_service_request(
                method, _callbacks.request_target(url), body.decode("utf-8"),
                secret=self._secret, service_id=_LAB_SERVICE_ID,
                audience=_callbacks.nonce_audience(_LAB_AUDIENCE, nonce))
            out[_callbacks.SERVICE_NONCE_HEADER] = nonce
        out["x-lab-run-token"] = self._run_token
        req = urllib.request.Request(url, data=body if method == "POST" else None, method=method, headers=out)
        try:
            with _urlopen(req, timeout=30) as resp:
                status, rh, data = resp.status, resp.headers, resp.read(_RESPONSE_MAX + 1)
        except urllib.error.HTTPError as err:
            status, rh, data = err.code, err.headers, err.read() if err.fp else b""
        except Exception as err:  # noqa: BLE001 - the agent gets a 502, never a crash
            log.warning("lab broker: upstream unreachable (%s)", type(err).__name__)
            return 502, {"content-type": "application/json"}, b'{"error":"lab broker: upstream unreachable"}'
        if len(data) > _RESPONSE_MAX:
            return 502, {"content-type": "application/json"}, b'{"error":"lab broker: response too large"}'
        keep = {}
        for k in self._PASS_RESPONSE:
            v = rh.get(k) if rh is not None else None
            if v:
                keep[k] = v
        return status, keep, data

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            status, rh, data = await self._serve(reader, writer)
        except Exception as err:  # noqa: BLE001
            log.warning("lab broker: %s", type(err).__name__)
            status, rh, data = 400, {"content-type": "application/json"}, b'{"error":"lab broker: bad request"}'
        try:
            head = [f"HTTP/1.1 {status} {'OK' if status < 400 else 'Error'}",
                    f"Content-Length: {len(data)}", "Connection: close"]
            head += [f"{k}: {v}" for k, v in rh.items()]
            writer.write(("\r\n".join(head) + "\r\n\r\n").encode("latin-1") + data)
            await writer.drain()
        finally:
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()

    async def _serve(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> tuple[int, dict, bytes]:
        raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=15)
        lines = raw.decode("latin-1").split("\r\n")
        parts = lines[0].split(" ")
        if len(parts) != 3:
            raise ValueError("request line")
        method, target = parts[0].upper(), parts[1]
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, _, v = line.partition(":")
                headers[k.strip().lower()] = v.strip()
        js = {"content-type": "application/json"}
        if "transfer-encoding" in headers:
            return 411, js, b'{"error":"lab broker: content-length required"}'
        length = int(headers.get("content-length") or 0)
        if length < 0 or length > _BROKER_BODY_MAX:
            return 413, js, b'{"error":"lab broker: body too large"}'
        if not self.allowed(method, target):
            log.warning("lab broker: refused %s %s", method, target.split("?", 1)[0][:200])
            return 403, js, b'{"error":"lab broker: path not allowed for this run"}'
        if length and headers.get("expect", "").lower() == "100-continue":
            writer.write(b"HTTP/1.1 100 Continue\r\n\r\n")
            await writer.drain()
        body = await asyncio.wait_for(reader.readexactly(length), timeout=30) if length else b""
        body.decode("utf-8")  # the envelope signs text; refuse anything else (→ 400)
        if method == "POST" and target.split("?", 1)[0].startswith("/api/lab/"):
            body = self.stamp_run_ref(body)
            if body is None:
                return 400, js, b'{"error":"lab broker: a lab post carries one JSON object"}'
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, self._forward, method, target, body, headers)


async def _unix_http(socket_path: str, method: str, target: str, body: bytes = b"",
                     headers: dict | None = None) -> tuple[int, dict, bytes]:
    """A one-shot HTTP/1.1 request over a unix socket (boot's own broker calls; tests)."""
    reader, writer = await asyncio.open_unix_connection(socket_path)
    try:
        head = [f"{method} {target} HTTP/1.1", "Host: localhost", "Connection: close",
                f"Content-Length: {len(body)}"] + [f"{k}: {v}" for k, v in (headers or {}).items()]
        writer.write(("\r\n".join(head) + "\r\n\r\n").encode("latin-1") + body)
        await writer.drain()
        raw = await asyncio.wait_for(reader.read(), timeout=60)
    finally:
        writer.close()
        with contextlib.suppress(Exception):
            await writer.wait_closed()
    head_raw, _, data = raw.partition(b"\r\n\r\n")
    lines = head_raw.decode("latin-1").split("\r\n")
    status = int(lines[0].split(" ")[1])
    hdrs = {}
    for line in lines[1:]:
        k, _, v = line.partition(":")
        hdrs[k.strip().lower()] = v.strip()
    return status, hdrs, data


# ── Run state between the three invokes ──────────────────────────────────────

@dataclass
class _MicrovmRun:
    run_ref: str
    brief_ref: str | None
    library_sha: str
    repo: str
    ref: str
    home: str
    target: str
    base_sha: str
    git_config: bytes
    broker: LabBroker
    author: dict | None = None
    pushed: dict = field(default_factory=dict)


_RUN: _MicrovmRun | None = None


async def _mvm_shutdown() -> None:
    """Stop the broker and forget the run (a new boot; tests)."""
    global _RUN
    run, _RUN = _RUN, None
    if run is not None:
        await run.broker.stop()


async def _exec(argv: list[str], *, cwd: str, env: dict, timeout_s: int = _GIT_TIMEOUT_S) -> tuple[int, str]:
    """Run one child (git) to completion → (exit code, combined output tail). A test seam."""
    proc = await asyncio.create_subprocess_exec(
        *argv, cwd=cwd, env=env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
        start_new_session=True)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
    except asyncio.TimeoutError:
        _kill_process_group(proc, timeout_s)
        await proc.wait()
        return 124, f"timed out after {timeout_s}s"
    return proc.returncode or 0, out.decode("utf-8", errors="replace")[-8000:]


def _mvm_git_env(home: str, token: str | None = None, author: dict | None = None) -> dict:
    """The git child's environment on the microVM path.

    Built from a minimal base, not os.environ: no AWS credentials, no fleet
    secret. The token rides as a github.com-scoped extraheader through
    GIT_CONFIG_* (never argv, never disk). After `claude` has run, the repo is
    untrusted: hooks, fsmonitor, credential helpers, the global and system
    config are all switched off here, and .git/config is restored from boot
    (_restore_git_config) before any git call."""
    env = {k: os.environ[k] for k in ("PATH", "LANG", "LC_ALL", "TZ") if k in os.environ}
    env.update({"HOME": home, "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_CONFIG_GLOBAL": os.devnull, "GIT_PAGER": "cat"})
    pairs = [("safe.directory", "*"), ("core.hooksPath", os.devnull), ("core.fsmonitor", "false"),
             ("credential.helper", "")]
    if token:
        basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        pairs.append(("http.https://github.com/.extraheader", f"AUTHORIZATION: basic {basic}"))
    env["GIT_CONFIG_COUNT"] = str(len(pairs))
    for i, (k, v) in enumerate(pairs):
        env[f"GIT_CONFIG_KEY_{i}"] = k
        env[f"GIT_CONFIG_VALUE_{i}"] = v
    a = author or _DEFAULT_AUTHOR
    env.update({"GIT_AUTHOR_NAME": a["name"], "GIT_AUTHOR_EMAIL": a["email"],
                "GIT_COMMITTER_NAME": a["name"], "GIT_COMMITTER_EMAIL": a["email"]})
    return env


def _microvm_claude_env(run: _MicrovmRun, author: dict | None) -> dict:
    """The `claude` child's environment: no run token, no fleet secret, no git
    credential config, no AWS variable but the region (design §8). `lab`
    reaches the platform through the broker's socket instead."""
    env = {k: v for k, v in os.environ.items() if not _stripped_for_claude(k)}
    for var in _LAB_ENV.values():
        env.pop(var, None)
    env["HOME"] = run.home
    env.setdefault("CLAUDE_CODE_USE_BEDROCK", "1")
    env["LAB_API_BASE"] = "http+unix://" + run.broker.socket_path
    env["LAB_RUN_REF"] = run.run_ref
    env["LAB_LIBRARY_SHA"] = run.library_sha
    env["LAB_REPO"] = run.repo
    if run.brief_ref:
        env["LAB_BRIEF_ID"] = run.brief_ref
    a = author or _DEFAULT_AUTHOR
    env.update({"GIT_AUTHOR_NAME": a["name"], "GIT_AUTHOR_EMAIL": a["email"],
                "GIT_COMMITTER_NAME": a["name"], "GIT_COMMITTER_EMAIL": a["email"]})
    return env


def _restore_git_config(run: _MicrovmRun) -> None:
    """Put back the .git/config boot saw, so a `claude`-edited config (a
    remote, a proxy, a filter driver) never reaches a credentialed git call."""
    gitdir = os.path.join(run.target, ".git")
    if os.path.islink(gitdir) or not os.path.isdir(gitdir):
        raise _Refusal("repo-tampered", ".git is not a directory")
    cfg = os.path.join(gitdir, "config")
    tmp = cfg + ".orgiq-restore"
    with contextlib.suppress(FileNotFoundError):
        os.unlink(tmp)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o644)
    with os.fdopen(fd, "wb") as fh:
        fh.write(run.git_config)
    os.replace(tmp, cfg)


async def _head_sha(run: _MicrovmRun, env: dict) -> str | None:
    rc, out = await _exec([_git_bin(), "-C", run.target, "rev-parse", "HEAD"], cwd=run.home, env=env)
    sha = out.strip().splitlines()[-1] if rc == 0 and out.strip() else ""
    return sha if re.fullmatch(r"[0-9a-f]{40}", sha) else None


# Files a run might dump its environment into: never staged by the snapshot
# (sweep 4 Low 5). The `claude` child's env still holds the container
# credential pair by design; a name-based exclude is the cheap half, a scan of
# the staged diff for the known values is the open half (design §16).
SNAPSHOT_EXCLUDES = (".env", ".env.*", "*.env", ".envrc", "environ", "*.environ", "env.txt", "env.log")


def _snapshot_pathspec() -> list[str]:
    """`git add -A -- <this>`: the whole tree less SNAPSHOT_EXCLUDES at any depth."""
    return ["."] + [f":(exclude,glob)**/{pat}" for pat in SNAPSHOT_EXCLUDES]


async def _snapshot(run: _MicrovmRun, author: dict | None) -> str | None:
    """Commit whatever the run left in the tree (as the actor), less dumped
    env files, → head sha."""
    _restore_git_config(run)
    env = _mvm_git_env(run.home, None, author)
    git = _git_bin()
    rc, out = await _exec([git, "-C", run.target, "status", "--porcelain"], cwd=run.home, env=env)
    if rc == 0 and out.strip():
        rc, _ = await _exec([git, "-C", run.target, "add", "-A", "--", *_snapshot_pathspec()], cwd=run.home, env=env)
        if rc == 0:
            rc, _ = await _exec([git, "-C", run.target, "commit", "--no-verify", "-q", "-m",
                                 f"OrgIQ snapshot: run {run.run_ref}"], cwd=run.home, env=env)
        if rc != 0:
            log.warning("microvm: snapshot commit exited %s", rc)
    return await _head_sha(run, env)


def _result_usage(ev: dict | None) -> tuple[int | None, dict | None]:
    """(fresh tokens, usage) from the stream-json `result` event, mirroring the
    middleware's parseResultUsage: no result, or malformed usage, is (None,
    None) — unknown, never 0."""
    usage = ev.get("usage") if isinstance(ev, dict) else None
    if not isinstance(usage, dict):
        return None, None

    def n(key: str, default: int | None = None) -> int | None:
        v = usage.get(key)
        if v is None:
            return default
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0:
            return None
        return int(v)

    inp, out = n("input_tokens"), n("output_tokens")
    cw, cr = n("cache_creation_input_tokens", 0), n("cache_read_input_tokens", 0)
    if inp is None or out is None or cw is None or cr is None:
        return None, None
    return inp + cw + out, {"inputTokens": inp, "outputTokens": out, "cacheWriteTokens": cw, "cacheReadTokens": cr}


def _get_transcript(url: str, path: str) -> bool:
    try:
        with _urlopen(urllib.request.Request(url, method="GET"), timeout=120) as resp:
            data = resp.read(_TRANSCRIPT_MAX + 1)
    except Exception as err:  # noqa: BLE001
        log.warning("microvm: transcript download failed (%s)", getattr(err, "code", type(err).__name__))
        return False
    if len(data) > _TRANSCRIPT_MAX:
        log.warning("microvm: transcript download over %s bytes; refused", _TRANSCRIPT_MAX)
        return False
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
    return True


def _put_transcript(url: str, path: str) -> bool:
    """One PUT of the transcript to its presigned URL. A failure is logged and
    returned, never raised: it does not change the run's exit code."""
    try:
        with open(path, "rb") as fh:
            data = fh.read(_TRANSCRIPT_MAX + 1)
    except OSError:
        return False
    if len(data) > _TRANSCRIPT_MAX:
        log.warning("microvm: transcript over %s bytes; not uploaded", _TRANSCRIPT_MAX)
        return False
    req = urllib.request.Request(url, data=data, method="PUT", headers={"Content-Type": "application/x-ndjson"})
    try:
        with _urlopen(req, timeout=120) as resp:
            ok = 200 <= int(getattr(resp, "status", 200)) < 300
    except Exception as err:  # noqa: BLE001
        log.warning("microvm: transcript upload failed (%s)", getattr(err, "code", type(err).__name__))
        return False
    if not ok:
        log.warning("microvm: transcript upload answered %s", getattr(resp, "status", "?"))
    return ok


# ── boot ─────────────────────────────────────────────────────────────────────

async def _mvm_boot(payload: dict) -> dict:
    global _RUN
    t0 = time.monotonic()
    repo = payload.get("repo") if isinstance(payload.get("repo"), dict) else {}
    full_name = repo.get("full_name") if isinstance(repo.get("full_name"), str) else ""
    ref = payload.get("ref")
    token = _clean_str(payload.get("token"))
    run_ref = payload.get("run_ref")
    run_token = _clean_str(payload.get("run_token"))
    library_sha = payload.get("library_sha")
    brief_ref = payload.get("brief_ref")
    api_base = _clean_str(payload.get("lab_api_base"), 2048)
    try:
        if not re.match(_SAFE_REPO, full_name) or any(re.fullmatch(r"\.+", s) for s in full_name.split("/")):
            raise _Refusal("bad-repo", "repo.full_name must be owner/name")
        url = f"https://github.com/{full_name}.git"
        clone_url = repo.get("clone_url")
        if clone_url not in (None, url):
            raise _Refusal("bad-repo", "repo.clone_url must be https://github.com/<full_name>.git")
        if not _safe_ref(ref):
            raise _Refusal("bad-ref", "ref is not a safe ref name")
        if not isinstance(run_ref, str) or not re.match(_SAFE_ID, run_ref):
            raise _Refusal("bad-run", "run_ref is missing or unsafe")
        if not run_token:
            raise _Refusal("bad-run", "run_token is missing")
        if not isinstance(library_sha, str) or not re.fullmatch(r"[0-9a-f]{64}", library_sha):
            raise _Refusal("bad-library-sha", "library_sha must be 64 hex")
        if brief_ref is not None and (not isinstance(brief_ref, str) or not re.match(_SAFE_ID, brief_ref)):
            raise _Refusal("bad-run", "brief_ref is unsafe")
        if not api_base or not re.fullmatch(r"https?://[A-Za-z0-9.-]+(:\d{1,5})?(/[\w./-]*)?", api_base):
            raise _Refusal("bad-lab-api-base", "lab_api_base must be an http(s) origin")
        home = _workspace_root()
        try:
            target = _confine(payload.get("target"), home)  # before ANY delete
        except BadTarget as err:
            raise _Refusal("bad-target", str(err)) from None
    except _Refusal as r:
        log.warning("microvm boot refused: %s (%s)", r.error, r.detail)
        out = r.result()
        if r.error == "bad-target":
            # The dispatcher only knows the root by configuration; tell it the
            # real one so it can retry with a target under it (nothing was deleted).
            out["workspace_root"] = home
        return out

    await _mvm_shutdown()  # a reused container: the previous run's broker goes first
    try:
        removed = _wipe(home)
    except (OSError, BadTarget) as err:
        return _Refusal("wipe-failed", type(err).__name__).result()
    log.info("microvm boot: run=%s repo=%s ref=%s wiped=%d", run_ref, full_name, ref, removed)

    env = _mvm_git_env(home, token)
    git = _git_bin()
    rc, out = await _exec([git, "clone", "--depth", "50", "--no-tags", "--branch", ref, "--", url, target],
                          cwd=home, env=env)
    if rc != 0:
        log.warning("microvm boot: git clone exited %s: %s", rc, out[-1000:])
        return _Refusal("clone-failed", f"git clone exited {rc}").result()
    rc, out = await _exec([git, "-C", target, "checkout", "-B", ref, "--"], cwd=home, env=env)
    if rc != 0:
        log.warning("microvm boot: git checkout exited %s: %s", rc, out[-1000:])
        return _Refusal("checkout-failed", f"git checkout exited {rc}").result()
    try:
        with open(os.path.join(target, ".git", "config"), "rb") as fh:
            git_config = fh.read()
    except OSError:
        return _Refusal("clone-failed", "no .git/config after clone").result()

    # The fleet secret: the boot payload's, held only in the broker's memory
    # (the §12 role has no Secrets Manager grant, so LAB_CALLBACK_SECRET_ID
    # cannot resolve in a microVM); else the env / _ID resolution; else none.
    secret = _clean_str(payload.get("callback_secret")) or ""
    source = "payload" if secret else "none"
    if not secret:
        try:
            secret = resolve_secret("LAB_CALLBACK_SECRET")
        except SecretResolutionError as exc:
            log.error("microvm boot: %s; lab calls will go unsigned", exc)
            secret = ""
        source = "env" if secret else "none"
    log.info("microvm boot: run=%s callback secret source=%s", run_ref, source)
    broker = LabBroker(run_ref=run_ref, run_token=run_token, secret=secret, api_base=api_base,
                       socket_path=_lab_socket_path())
    try:
        await broker.start()
    except OSError as err:
        return _Refusal("broker-failed", type(err).__name__).result()
    run = _MicrovmRun(run_ref=run_ref, brief_ref=brief_ref, library_sha=library_sha, repo=full_name, ref=ref,
                      home=home, target=target, base_sha="", git_config=git_config, broker=broker,
                      author=_author(payload.get("author")))
    head = await _head_sha(run, env)
    if not head:
        await broker.stop()
        return _Refusal("clone-failed", "no HEAD after checkout").result()
    run.base_sha = head

    # The skill library through the broker, exactly as `lab skills` will see it.
    try:
        status, hdrs, body = await _unix_http(broker.socket_path, "GET",
                                              f"/api/runs/{urllib.parse.quote(run_ref, safe='')}/skills")
    except (OSError, ValueError, IndexError, asyncio.TimeoutError) as err:
        await broker.stop()
        return _Refusal("skills-unavailable", type(err).__name__).result()
    if status != 200:
        await broker.stop()
        return _Refusal("skills-unavailable", f"HTTP {status}").result()
    got = _library_sha(body, hdrs.get("x-skill-library-sha256", ""))
    if got != library_sha:
        await broker.stop()
        log.warning("microvm boot: library-mismatch run=%s got=%s want=%s", run_ref,
                    (got or "invalid")[:12], library_sha[:12])
        return _Refusal("library-mismatch",
                        f"library {(got or 'invalid')[:12]} is not the brief's {library_sha[:12]}").result()

    # Where `lab brief` looks when LAB_RUN_REF is not in its environment.
    state = {"run_ref": run_ref, "brief_ref": brief_ref, "library_sha": library_sha, "repo": full_name}
    with open(os.path.join(home, ".claude", "orgiq-run.json"), "w") as fh:
        json.dump(state, fh, sort_keys=True)
    _RUN = run
    log.info("microvm boot: run=%s head=%s library_sha_ok=true boot_ms=%d", run_ref, head,
             int((time.monotonic() - t0) * 1000))
    return {"ok": True, "head_sha": head, "library_sha_ok": True, "booted_at": _now_iso(),
            "workspace_root": home}


# ── task ─────────────────────────────────────────────────────────────────────

async def _mvm_task(payload: dict) -> AsyncIterator | dict:
    run = _RUN
    if run is None:
        return {"agent": "devbox", "error": "not-booted"}
    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt:
        return {"agent": "devbox", "error": "missing prompt"}
    try:
        model = _resolve_model(payload.get("model"))
    except ModelNotAllowed as err:
        log.warning("Refused model %s (allowed: %s)", err.requested, ",".join(err.allowed))
        return {"agent": "devbox", "error": "model not allowlisted", "model": err.requested, "allowed": err.allowed}
    try:
        timeout_s = min(int(payload.get("timeout_s") or DEFAULT_TIMEOUT_S), MAX_TIMEOUT_S)
    except (TypeError, ValueError):
        timeout_s = DEFAULT_TIMEOUT_S
    resume_id = payload.get("resume_session_id")
    if resume_id is not None and (not isinstance(resume_id, str) or not re.fullmatch(_SESSION_UUID, resume_id)):
        return {"agent": "devbox", "error": "bad resume_session_id"}
    put_url = _https_url(payload.get("transcript_put_url"))
    author = _author(payload.get("author")) or run.author
    length, digest = _prompt_digest(prompt)
    log.info("microvm task: run=%s model=%s resume=%s prompt_len=%d prompt_sha256=%s",
             run.run_ref, model or "(default)", bool(resume_id), length, digest)
    if resume_id:
        get_url = _https_url(payload.get("resume_transcript_get_url"))
        path = _transcript_path(run.home, run.target, resume_id)
        loop = asyncio.get_running_loop()
        if not get_url or not await loop.run_in_executor(None, _get_transcript, get_url, path):
            return {"agent": "devbox", "error": "resume-transcript-unavailable"}
    cmd = _build_cmd(prompt, False, "stream-json", model, resume_session_id=resume_id)
    return _mvm_stream(cmd, run, timeout_s, payload.get("budget"), put_url, author)


async def _mvm_stream(cmd: list[str], run: _MicrovmRun, timeout_s: int, budget: object,
                      put_url: str | None, author: dict | None) -> AsyncIterator[dict]:
    """Today's event stream, then snapshot + transcript, then ONE devbox_end."""
    t0 = time.monotonic()
    result_ev: dict | None = None
    session_id: str | None = None
    inner_end: dict = {}
    env = _microvm_claude_env(run, author)
    inner = _run_streaming(cmd, run.target, False, timeout_s, budget=budget, env=env)
    async with contextlib.aclosing(inner):
        async for ev in inner:
            if ev.get("type") == "devbox_end":
                inner_end = ev
                continue
            if ev.get("type") == "result":
                result_ev = ev
            sid = ev.get("session_id")
            if isinstance(sid, str) and re.fullmatch(_SESSION_UUID, sid):
                session_id = sid  # the result event's, when there is one, is the last seen
            yield ev
    duration_ms = int((time.monotonic() - t0) * 1000)
    try:
        head = await _snapshot(run, author)
    except _Refusal as r:
        log.warning("microvm task: snapshot skipped (%s)", r.error)
        head = None
    uploaded = False
    if put_url and session_id:
        path = _transcript_path(run.home, run.target, session_id)
        if os.path.isfile(path):
            uploaded = await asyncio.get_running_loop().run_in_executor(None, _put_transcript, put_url, path)
    fresh, usage = _result_usage(result_ev)
    end = {
        "type": "devbox_end",
        "exit_code": inner_end.get("exit_code"),
        "timed_out": inner_end.get("timed_out", False),
        "killed_reason": inner_end.get("killed_reason"),
        "fresh_tokens": fresh,
        "usage": usage,
        "reported_cost_usd": result_ev.get("total_cost_usd") if isinstance(result_ev, dict) else None,
        "head_sha": head,
        "claude_session_id": session_id,
        "duration_ms": duration_ms,
        "transcript_uploaded": uploaded,
        "stderr": inner_end.get("stderr", ""),
    }
    if "fresh_tokens" in inner_end:  # the budget meter's own count (DE-35)
        end["metered_fresh_tokens"] = inner_end["fresh_tokens"]
        end["max_fresh_tokens"] = inner_end.get("max_fresh_tokens")
    log.info("microvm task end: run=%s exit=%s killed=%s fresh_tokens=%s head=%s session=%s duration_ms=%d "
             "transcript_uploaded=%s", run.run_ref, end["exit_code"], end["killed_reason"], fresh, head,
             session_id, duration_ms, uploaded)
    yield end


# ── push ─────────────────────────────────────────────────────────────────────

async def _mvm_push(payload: dict) -> dict:
    run = _RUN
    if run is None:
        return _Refusal("not-booted").result()
    branch = payload.get("branch")
    if not _safe_ref(branch) or not branch.startswith(_BRANCH_PREFIX):
        return _Refusal("bad-branch", f"branch must be a safe ref under {_BRANCH_PREFIX}").result()
    token = _clean_str(payload.get("token"))
    author = _author(payload.get("author")) or run.author
    try:
        await _snapshot(run, author)  # a tree left dirty since task, as the actor
    except _Refusal as r:
        return r.result()
    # The dispatcher's lease (`expected_head`): null means the branch must not
    # exist yet; a sha means it must be exactly there (a later attempt of a job
    # whose earlier attempt pushed). Absent keeps the session's own rule.
    has_expected = "expected_head" in payload
    expected_head = payload.get("expected_head")
    if has_expected and expected_head is not None and (
            not isinstance(expected_head, str) or not re.fullmatch(r"[0-9a-f]{40}", expected_head)):
        return _Refusal("bad-expected-head", "expected_head must be 40 hex or null").result()
    env = _mvm_git_env(run.home, token, author)
    git = _git_bin()
    rc, out = await _exec([git, "-C", run.target, "checkout", "-B", branch, "--"], cwd=run.home, env=env)
    if rc != 0:
        return _Refusal("checkout-failed", f"git checkout exited {rc}").result()
    # An explicit lease: the branch must be where this session last saw it.
    # This session's own push wins (it is newer than anything the dispatcher
    # knew); then the dispatcher's expected_head; then absent for a new branch,
    # the boot head for a resumed one.
    if run.pushed.get(branch):
        expected = run.pushed[branch]
    elif has_expected:
        expected = expected_head or ""
    else:
        expected = run.base_sha if branch == run.ref else ""
    url = f"https://github.com/{run.repo}.git"
    rc, out = await _exec([git, "-C", run.target, "push", f"--force-with-lease=refs/heads/{branch}:{expected}",
                           url, f"HEAD:refs/heads/{branch}"], cwd=run.home, env=env)
    if rc != 0:
        log.warning("microvm push: git push exited %s: %s", rc, out[-1000:])
        return _Refusal("push-rejected" if "stale info" in out or "rejected" in out else "push-failed",
                        f"git push exited {rc}").result()
    head = await _head_sha(run, env)
    if head:
        run.pushed[branch] = head
    log.info("microvm push: run=%s branch=%s head=%s", run.run_ref, branch, head)
    return {"ok": True, "head_sha": head, "pushed": True}


# ── debrief (docs/learning-loop-design.md, Stage 2) ──────────────────────────
#
# After the task, while the session is still up, the dispatcher may send the
# server's debrief request: resume the work session (forked) with the fixed
# prompt, read the ONE folder the answer names under .lab/keep, and hand the
# answer and folder back. The proposal is filed server side (the dispatcher
# calls the same settle path the local route uses); nothing here posts it.
# The same narrowing as tools/local-compute-report.mjs `debriefArgs`: a request
# can only take tools away, and the budget is capped whatever it says.

_KEEP_NAME = re.compile(r"^rb-[a-z0-9][a-z0-9-]{1,60}$")
_KEEP_SEG = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]*$")
_KEEP_FILE_MAX, _KEEP_BUNDLE_MAX, _KEEP_MAX_FILES, _KEEP_SKILL_MD_MAX = 32 * 1024, 80 * 1024, 24, 200_000
_DEBRIEF_TOOL_CEILING = ("Read", "Glob", "Grep", "Write", "Edit")
_DEBRIEF_ALLOW_RULE = re.compile(r"^(?:Read|Glob|Grep)(?:\(\./\*\*\))?$|^Edit\(\./\.lab/keep/\*\*\)$")
_DEBRIEF_DENY_FLOOR = ("Edit(./.git/**)", "Edit(**/.git/**)", "Bash", "WebFetch", "WebSearch")
_DEBRIEF_DENY_RULE = re.compile(r"^[A-Za-z]+(\([^\s]*\))?$")
_DEBRIEF_MAX_USD = 2.0
_DEBRIEF_MAX_TIMEOUT_S = 1800


def _debrief_cmd(request: object, session_id: object, model: str) -> list[str] | None:
    """The resume argv, or None when the request is not one this runner will run."""
    if not isinstance(request, dict):
        return None
    if not isinstance(session_id, str) or not re.fullmatch(_SESSION_UUID, session_id):
        return None
    prompt = request.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 20_000:
        return None
    schema = request.get("schema")
    if not isinstance(schema, dict):
        return None
    tools = [t for t in (request.get("tools") or []) if t in _DEBRIEF_TOOL_CEILING]
    allowed = [t for t in (request.get("allowedTools") or []) if isinstance(t, str) and _DEBRIEF_ALLOW_RULE.match(t)]
    denied = list(_DEBRIEF_DENY_FLOOR)
    for t in request.get("disallowedTools") or []:
        if isinstance(t, str) and _DEBRIEF_DENY_RULE.match(t) and t not in denied:
            denied.append(t)
    try:
        usd = float(request.get("maxBudgetUsd"))
    except (TypeError, ValueError):
        return None
    if not tools or not allowed or not (usd > 0):
        return None
    usd = min(usd, _DEBRIEF_MAX_USD)
    cmd = [_claude_bin(), "-p", prompt, "--resume", session_id, "--fork-session",
           "--output-format", "json", "--json-schema", json.dumps(schema, separators=(",", ":"))]
    if model:
        cmd += ["--model", model]
    cmd += ["--tools", ",".join(tools), "--allowedTools", ",".join(allowed),
            "--disallowedTools", ",".join(denied), "--permission-mode", "dontAsk",
            "--max-budget-usd", f"{usd:g}"]
    return cmd


def _debrief_answer(result: object) -> dict | None:
    if not isinstance(result, dict):
        return None
    so = result.get("structured_output")
    if isinstance(so, dict):
        return so
    text = result.get("result")
    if isinstance(text, str):
        m = re.search(r"\{[\s\S]*\}$", text.strip())
        if m:
            try:
                got = json.loads(m.group(0))
                return got if isinstance(got, dict) else None
            except ValueError:
                return None
    return None


def _read_keep_folder(target: str, name: object) -> dict:
    """The one kept folder, read as `lab keep` reads it: links never followed,
    text only, names and sizes checked. {"folder"} | {"problems"} | {"missing"}."""
    if not isinstance(name, str) or not _KEEP_NAME.match(name):
        return {"problems": ["the answer names no usable folder"]}
    keep = os.path.join(target, ".lab", "keep")
    base = os.path.join(keep, name)
    try:
        if os.path.islink(keep) or not os.path.isdir(keep):
            return {"missing": True}
        st = os.lstat(base)
    except OSError:
        return {"missing": True}
    if _is_link(st) or not _is_dir(st):
        return {"missing": True}
    problems: list[str] = []
    skill_path = os.path.join(base, "SKILL.md")
    try:
        sst = os.lstat(skill_path)
        if not _is_file(sst):
            problems.append("no SKILL.md")
        elif sst.st_size > _KEEP_SKILL_MD_MAX:
            problems.append(f"SKILL.md is {sst.st_size} bytes (max {_KEEP_SKILL_MD_MAX})")
    except OSError:
        problems.append("no SKILL.md")
    files: list[dict] = []
    total = 0

    def walk(d: str, rel: str) -> None:
        nonlocal total
        for n in sorted(os.listdir(d)):
            full, r = os.path.join(d, n), f"{rel}/{n}"
            s = os.lstat(full)
            if _is_link(s):
                problems.append(f"{r} is not a regular file (links are not carried)")
                continue
            if _is_dir(s):
                walk(full, r)
                continue
            if not _is_file(s):
                problems.append(f"{r} is not a regular file (links are not carried)")
                continue
            if not all(_KEEP_SEG.match(p) for p in r.split("/")[1:]):
                problems.append(f"{r}: a name outside [A-Za-z0-9._-] or starting with . or -")
                continue
            if s.st_size > _KEEP_FILE_MAX:
                problems.append(f"{r} is {s.st_size} bytes (max {_KEEP_FILE_MAX})")
                continue
            with open(full, "rb") as fh:
                raw = fh.read()
            if b"\0" in raw:
                problems.append(f"{r} is binary (only text is carried)")
                continue
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                problems.append(f"{r} is not UTF-8 text")
                continue
            total += len(raw)
            files.append({"path": r, "content": text, "mode": "755" if s.st_mode & 0o111 else "644"})

    for root in ("scripts", "data"):
        t = os.path.join(base, root)
        try:
            ts = os.lstat(t)
        except OSError:
            continue
        if _is_link(ts) or not _is_dir(ts):
            continue
        walk(t, root)
    if len(files) > _KEEP_MAX_FILES:
        problems.append(f"{len(files)} files (max {_KEEP_MAX_FILES})")
    if total > _KEEP_BUNDLE_MAX:
        problems.append(f"the files total {total} bytes (max {_KEEP_BUNDLE_MAX})")
    if problems:
        return {"problems": problems[:8]}
    with open(skill_path, encoding="utf-8", errors="replace") as fh:
        skill_md = fh.read()
    return {"folder": {"name": name, "skill_md": skill_md, "files": files}}


def _is_link(st: os.stat_result) -> bool:
    return stat.S_ISLNK(st.st_mode)


def _is_dir(st: os.stat_result) -> bool:
    return stat.S_ISDIR(st.st_mode)


def _is_file(st: os.stat_result) -> bool:
    return stat.S_ISREG(st.st_mode)


def _clear_keep(target: str) -> None:
    """Start the debrief with an empty .lab/keep; a link is removed, never followed."""
    keep = os.path.join(target, ".lab", "keep")
    if os.path.islink(keep) or os.path.isfile(keep):
        os.unlink(keep)
    elif os.path.isdir(keep):
        shutil.rmtree(keep)


async def _mvm_debrief(payload: dict) -> dict:
    """→ {"ok": true, "answer", "folder"? | "problems"?, "cost_usd"} or
    {"ok": false, "error": "session-unavailable" | ...}. Never pushes, never posts."""
    run = _RUN
    if run is None:
        return _Refusal("not-booted").result()
    try:
        model = _resolve_model(payload.get("model"))
    except ModelNotAllowed as err:
        return {"ok": False, "error": "model-not-allowlisted", "model": err.requested}
    request = payload.get("request")
    cmd = _debrief_cmd(request, payload.get("claude_session_id"), model)
    if cmd is None:
        return {"ok": False, "error": "session-unavailable", "detail": "the request or session id is not usable"}
    try:
        timeout_s = min(max(int(request.get("timeoutS") or 300), 30), _DEBRIEF_MAX_TIMEOUT_S)
    except (TypeError, ValueError):
        timeout_s = 300
    try:
        _clear_keep(run.target)
    except OSError as err:
        log.warning("microvm debrief: could not clear .lab/keep (%s)", type(err).__name__)
    env = _microvm_claude_env(run, run.author)
    proc = await asyncio.create_subprocess_exec(*cmd, cwd=run.target, env=env, stdin=asyncio.subprocess.DEVNULL,
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                                                start_new_session=True)
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
    except asyncio.TimeoutError:
        _kill_process_group(proc, timeout_s)
        await proc.wait()
        stdout = b""
    result = None
    for line in reversed(stdout[:1_000_000].decode("utf-8", errors="replace").strip().splitlines()):
        try:
            o = json.loads(line)
        except ValueError:
            continue
        if isinstance(o, dict) and o.get("type") == "result":
            result = o
            break
    answer = _debrief_answer(result)
    if answer is None:
        log.warning("microvm debrief: run=%s no answer (exit %s)", run.run_ref, proc.returncode)
        return {"ok": False, "error": "session-unavailable", "detail": f"exit {proc.returncode}"}
    cost = result.get("total_cost_usd") if isinstance(result, dict) else None
    out: dict = {"ok": True, "answer": answer,
                 "cost_usd": cost if isinstance(cost, (int, float)) and not isinstance(cost, bool) else None}
    if answer.get("kind") in ("new", "revise"):
        read = _read_keep_folder(run.target, answer.get("folder"))
        if "folder" in read:
            out["folder"] = read["folder"]
        elif "problems" in read:
            out["problems"] = read["problems"]
    log.info("microvm debrief: run=%s kind=%s folder=%s", run.run_ref, answer.get("kind"), "folder" in out)
    return out


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
                        set as LAB_* for every `lab` call, see _LAB_ENV),
      "budget":  dict  (optional, DE-35 — {"max_fresh_tokens": int,
                        "reason_ref": str}: the process group is killed once
                        the run's fresh tokens reach the ceiling, and
                        devbox_end says killed_reason "budget")
    }

    Or `{"op": "wipe"}` (fleet, design §4): empty the workspace (never
    following a link) and recreate ~/.claude, → {"ok": true, "removed": n}.

    Or the microVM runner (`"runner": "microvm"`, design §3): `op` boot |
    task | push | debrief — see _mvm_boot / _mvm_task / _mvm_push / _mvm_debrief and
    docs/microvm-runner-design.md for the field contract. Without `runner`
    (or with "fleet") everything below behaves as it always has.

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

    runner = payload.get("runner")
    if runner == "microvm":
        op = payload.get("op")
        if op == "boot":
            return await _mvm_boot(payload)
        if op == "task":
            return await _mvm_task(payload)
        if op == "push":
            return await _mvm_push(payload)
        if op == "debrief":
            return await _mvm_debrief(payload)
        return {"ok": False, "error": "unsupported-op", "detail": "microvm ops are boot | task | push | debrief"}
    if runner not in (None, "fleet"):
        return {"ok": False, "error": "unknown-runner", "detail": "runner is fleet | microvm"}

    if payload.get("op") == "wipe":
        try:
            return {"ok": True, "removed": _wipe(_workspace_root())}
        except (OSError, BadTarget) as err:
            return {"ok": False, "error": "wipe-failed", "detail": type(err).__name__}

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
    prompt_len, prompt_sha = _prompt_digest(str(prompt))
    log.info(
        "Devbox task: stream=%s resume=%s persistent=%s model=%s prompt_len=%d prompt_sha256=%s",
        stream, resume, persistent, model or "(default)", prompt_len, prompt_sha,
    )

    if stream:
        cmd = _build_cmd(prompt, resume, "stream-json", model)
        return _run_streaming(cmd, workspace, persistent, timeout_s, payload.get("lab"), payload.get("budget"))

    cmd = _build_cmd(prompt, resume, "json", model)
    return await _run_sync(cmd, workspace, persistent, timeout_s, payload.get("lab"))


if __name__ == "__main__":
    app.run()
