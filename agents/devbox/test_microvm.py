"""Unit tests for the microVM runner in main.py (docs/microvm-runner-design.md §15).

Run from agents/devbox/:  ../../.venv-synth/bin/python -m unittest discover -p 'test_*.py'

No AWS, no network, no real `claude`, no real git:
  - git calls go through `main._exec`, replaced here by a recorder that fakes
    clone/checkout/status/commit/push and keeps each call's argv and env;
  - every HTTP call goes through `main._urlopen`, replaced by a fake upstream
    (the middleware's skills route, the presigned transcript URLs);
  - `claude` is a generated shell script (as in test_main.py) that dumps its
    argv and environment and prints scripted stream-json;
  - the lab broker is real: a unix socket in a temp dir, spoken to with
    main._unix_http and, in one test, by the real `lab` script through curl.
"""

import asyncio
import base64
import contextlib
import hashlib
import io
import json
import logging
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import types
import unittest
import urllib.error
from email.message import Message
from pathlib import Path

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

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import main  # noqa: E402

FMT = "orgiq-skill-library/1"
HEAD = "a" * 40
NEW_HEAD = "b" * 40
SESSION = "0b8c2f4e-1d2a-4c3b-9e8f-112233445566"
RESUME = "11111111-2222-4333-8444-555555555555"
SECRET = "fleet-secret-value"
RUN_TOKEN = "run-token-SECRET-abcdef"
READ_TOKEN = "ghs_READ_token_123456"
WRITE_TOKEN = "ghs_WRITE_token_654321"


def library(files=(("rb-alpha/SKILL.md", "# alpha\n"),)) -> tuple[bytes, str]:
    entries, lines = [], []
    for path, content in files:
        sha = hashlib.sha256(content.encode()).hexdigest()
        entries.append({"path": path, "content": content, "mode": "644", "sha256": sha})
        lines.append(f"{path} 644 {sha}")
    set_sha = hashlib.sha256(("\n".join([FMT] + sorted(lines)) + "\n").encode()).hexdigest()
    return json.dumps({"format": FMT, "sha256": set_sha, "files": entries}).encode(), set_sha


LIB_BODY, LIB_SHA = library()


class FakeResponse:
    def __init__(self, status=200, body=b"", headers=None):
        self.status = status
        self._body = body
        self.headers = Message()
        for k, v in (headers or {}).items():
            self.headers[k] = v

    def read(self, n=-1):
        return self._body if n is None or n < 0 else self._body[:n]

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeUpstream:
    """The middleware + S3 as main._urlopen sees them. Records every request."""

    def __init__(self):
        self.calls = []
        self.skills = (200, LIB_BODY, {"x-skill-library-sha256": LIB_SHA, "content-type": "application/json"})
        self.put_error = None
        self.transcript = b'{"type":"user"}\n'

    def __call__(self, req, timeout=None):
        headers = {k.lower(): v for k, v in req.header_items()}
        self.calls.append({"url": req.full_url, "method": req.get_method(), "headers": headers, "data": req.data})
        url, method = req.full_url, req.get_method()
        if method == "PUT":
            if self.put_error:
                raise self.put_error
            return FakeResponse(200)
        if url.startswith("https://s3.example/get"):
            return FakeResponse(200, self.transcript)
        if url.endswith("/skills"):
            status, body, hdrs = self.skills
            if status != 200:
                raise urllib.error.HTTPError(url, status, "x", Message(), io.BytesIO(body))
            return FakeResponse(status, body, hdrs)
        if "/brief" in url:
            return FakeResponse(200, b"# the brief\n", {"x-brief-sha256": hashlib.sha256(b"# the brief\n").hexdigest()})
        return FakeResponse(200, b'{"ok":true}', {"content-type": "application/json"})

    def of(self, method):
        return [c for c in self.calls if c["method"] == method]


class FakeGit:
    """main._exec stand-in: records (argv, env) and fakes git's effects."""

    def __init__(self):
        self.calls = []
        self.dirty = False
        self.push_rc = 0
        self.head = HEAD
        self.on_clone = None

    async def __call__(self, argv, *, cwd, env, timeout_s=None):
        self.calls.append({"argv": list(argv), "env": dict(env)})
        args = argv[1:]
        if args[:1] == ["clone"]:
            if self.on_clone:
                self.on_clone()
            target = args[-1]
            os.makedirs(os.path.join(target, ".git"), exist_ok=True)
            Path(target, ".git", "config").write_text("[core]\n\tbare = false\n")
            return 0, "Cloning...\n"
        sub = args[2] if args[:1] == ["-C"] else args[0]
        if sub == "rev-parse":
            return 0, self.head + "\n"
        if sub == "status":
            return 0, (" M file.txt\n" if self.dirty else "")
        if sub == "commit":
            self.dirty = False
            self.head = NEW_HEAD
            return 0, ""
        if sub == "push":
            return self.push_rc, ("" if self.push_rc == 0 else " ! [rejected] (stale info)\n")
        return 0, ""

    def subcommands(self):
        out = []
        for c in self.calls:
            a = c["argv"][1:]
            out.append(a[2] if a[:1] == ["-C"] else a[0])
        return out


def run(coro):
    async def wrapped():
        try:
            return await coro
        finally:
            await main._mvm_shutdown()
    return asyncio.run(wrapped())


async def collect(gen):
    if isinstance(gen, dict):
        return gen
    return [ev async for ev in gen]


def make_claude(tmpdir, body) -> str:
    path = os.path.join(tmpdir, "claude")
    with open(path, "w") as f:
        f.write("#!/bin/sh\n" + body)
    os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)
    return path


# claude: dump argv + env, then a session with a result.
CLAUDE_OK = r"""
printf '%s\n' "$*" > "$OUT_DIR/argv"
env > "$OUT_DIR/env"
echo '{"type":"system","subtype":"init","session_id":"SESSION"}'
echo '{"type":"assistant","message":{"id":"m1","usage":{"input_tokens":10,"output_tokens":5}}}'
echo '{"type":"result","subtype":"success","session_id":"SESSION","total_cost_usd":0.02,"usage":{"input_tokens":100,"cache_creation_input_tokens":20,"cache_read_input_tokens":3000,"output_tokens":30}}'
exit 0
""".replace("SESSION", SESSION)

# claude that dies before any result.
CLAUDE_NO_RESULT = r"""
echo '{"type":"system","subtype":"init","session_id":"SESSION"}'
exit 1
""".replace("SESSION", SESSION)

# claude that writes its transcript where Claude Code keeps it.
CLAUDE_TRANSCRIPT = r"""
mkdir -p "$TRANSCRIPT_DIR"
echo '{"type":"user","message":"hi"}' > "$TRANSCRIPT_DIR/SESSION.jsonl"
echo '{"type":"system","subtype":"init","session_id":"SESSION"}'
echo '{"type":"result","subtype":"success","session_id":"SESSION","usage":{"input_tokens":1,"output_tokens":1}}'
exit 0
""".replace("SESSION", SESSION)


class MicrovmCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.root = os.path.realpath(os.path.join(self.tmp, "ws"))
        os.makedirs(self.root)
        self.out = os.path.join(self.tmp, "out")
        os.makedirs(self.out)
        self.sock = os.path.join(self.tmp, "run", "lab.sock")
        self.git = FakeGit()
        self.up = FakeUpstream()
        self.saved = {name: getattr(main, name) for name in
                      ("_resolve_workspace", "_exec", "_git_bin", "_urlopen", "_claude_bin", "_RUN")}
        main._resolve_workspace = lambda: (self.root, False)
        main._exec = self.git
        main._git_bin = lambda: "git"
        main._urlopen = self.up
        self.env_saved = dict(os.environ)
        os.environ.update({"LAB_BROKER_SOCKET": self.sock, "OUT_DIR": self.out, "LAB_CALLBACK_SECRET": SECRET})
        os.environ.pop("LAB_CALLBACK_SECRET_ID", None)
        self.use_claude(CLAUDE_OK)

    def tearDown(self):
        for name, value in self.saved.items():
            setattr(main, name, value)
        os.environ.clear()
        os.environ.update(self.env_saved)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def use_claude(self, body):
        path = make_claude(self.tmp, body)
        main._claude_bin = lambda: path

    @property
    def target(self):
        return os.path.join(self.root, "repo")

    def boot_payload(self, **over):
        p = {"op": "boot", "runner": "microvm",
             "repo": {"full_name": "acme/widgets", "clone_url": "https://github.com/acme/widgets.git"},
             "ref": "main", "target": self.target, "token": READ_TOKEN, "run_ref": "job-42",
             "run_token": RUN_TOKEN, "library_sha": LIB_SHA, "brief_ref": "brief-job-42",
             "lab_api_base": "https://lab.orgiq.internal"}
        p.update(over)
        return p

    def task_payload(self, **over):
        p = {"op": "task", "runner": "microvm", "prompt": "Fix the flaky widget test, please.",
             "budget": {"max_fresh_tokens": 1_000_000}, "timeout_s": 30,
             "transcript_put_url": "https://s3.example/put?X-Amz-Signature=sig",
             "resume_session_id": None, "resume_transcript_get_url": None}
        p.update(over)
        return p

    async def boot_and_task(self, task_over=None, boot_over=None):
        booted = await main.handle(self.boot_payload(**(boot_over or {})))
        self.assertTrue(booted.get("ok"), booted)
        events = await collect(await main.handle(self.task_payload(**(task_over or {}))))
        return booted, events


class BootTests(MicrovmCase):
    def test_wipe_leaves_the_workspace_empty_before_the_clone(self):
        outside = os.path.join(self.tmp, "outside")
        os.makedirs(outside)
        Path(outside, "keep.txt").write_text("not ours")
        Path(self.root, "previous-actor.txt").write_text("x")
        os.makedirs(os.path.join(self.root, "old-repo", ".git"))
        os.makedirs(os.path.join(self.root, ".claude", "projects", "p"))
        Path(self.root, ".claude", "projects", "p", "s.jsonl").write_text("{}")
        Path(self.root, ".hidden").write_text("x")
        os.symlink(outside, os.path.join(self.root, "link-out"))
        seen = {}

        def at_clone():
            # `find $WORKSPACE -mindepth 1` at the moment git clone starts: only
            # the recreated, empty ~/.claude.
            seen["entries"] = sorted(os.listdir(self.root))
            seen["claude"] = os.listdir(os.path.join(self.root, ".claude"))

        self.git.on_clone = at_clone
        out = run(main.handle(self.boot_payload()))
        self.assertTrue(out["ok"], out)
        self.assertEqual(seen["entries"], [".claude"])
        self.assertEqual(seen["claude"], [])
        self.assertTrue(Path(outside, "keep.txt").exists(), "wipe followed a symlink out of the workspace")
        self.assertEqual(out["head_sha"], HEAD)
        self.assertTrue(out["library_sha_ok"])
        self.assertTrue(out["booted_at"].endswith("Z"))

    def test_bad_targets_raise_before_any_delete(self):
        sentinel = Path(self.root, "sentinel")
        sentinel.write_text("still here")
        escape = os.path.join(self.tmp, "elsewhere")
        os.makedirs(escape)
        os.symlink(escape, os.path.join(self.root, "sneaky"))
        for target in ("/etc", "/mnt/workspace/../etc", self.root + "/../etc", self.root, self.root + "/",
                       "relative/path", os.path.join(self.root, "sneaky", "repo"), None):
            with self.subTest(target=target):
                if target is not None and target.startswith("/"):
                    with self.assertRaises(main.BadTarget):
                        main._confine(target, self.root)
                out = run(main.handle(self.boot_payload(target=target)))
                self.assertEqual(out, {"ok": False, "error": "bad-target", "detail": out["detail"]})
                self.assertTrue(sentinel.exists(), "a refused target still wiped the workspace")
        self.assertEqual(self.git.calls, [], "git ran for a refused target")
        self.assertEqual(self.up.calls, [])

    def test_fleet_clone_confines_its_target_before_rmtree(self):
        removed = []
        orig = main.shutil.rmtree
        main.shutil.rmtree = lambda p, **k: removed.append(p)
        try:
            for target in ("/etc", "/mnt/workspace/../etc", self.root + "/../etc"):
                events = run(collect(main._run_git({"op": "clone", "repo": "a/b", "target": target})))
                self.assertEqual(events[-1]["type"], "git_end")
                self.assertEqual(events[-1]["exit_code"], 2)
        finally:
            main.shutil.rmtree = orig
        self.assertEqual(removed, [])

    def test_clone_token_lives_only_in_the_git_childs_env(self):
        run(main.handle(self.boot_payload()))
        clone = self.git.calls[0]
        self.assertEqual(clone["argv"], ["git", "clone", "--depth", "50", "--no-tags", "--branch", "main", "--",
                                         "https://github.com/acme/widgets.git", self.target])
        self.assertEqual(self.git.calls[1]["argv"], ["git", "-C", self.target, "checkout", "-B", "main", "--"])
        env = clone["env"]
        keys = {env[f"GIT_CONFIG_KEY_{i}"]: env[f"GIT_CONFIG_VALUE_{i}"] for i in range(int(env["GIT_CONFIG_COUNT"]))}
        basic = base64.b64encode(f"x-access-token:{READ_TOKEN}".encode()).decode()
        self.assertEqual(keys["http.https://github.com/.extraheader"], f"AUTHORIZATION: basic {basic}")
        self.assertEqual(keys["core.hooksPath"], os.devnull)
        for call in self.git.calls:
            self.assertNotIn(READ_TOKEN, " ".join(call["argv"]))
        self.assertNotIn(SECRET, json.dumps(env))  # the git child never sees the fleet secret
        for path in Path(self.root).rglob("*"):
            if path.is_file():
                self.assertNotIn(READ_TOKEN, path.read_text(errors="replace"), f"token on disk in {path}")

    def test_bad_ref_repo_and_sha_are_refused_before_any_delete(self):
        sentinel = Path(self.root, "sentinel")
        sentinel.write_text("x")
        for over, error in (({"ref": "-oProxyCommand=evil"}, "bad-ref"), ({"ref": "a/../b"}, "bad-ref"),
                            ({"repo": {"full_name": "../etc"}}, "bad-repo"),
                            ({"repo": {"full_name": "a/b", "clone_url": "https://evil.example/a/b.git"}}, "bad-repo"),
                            ({"library_sha": "abc"}, "bad-library-sha"), ({"run_token": ""}, "bad-run"),
                            ({"lab_api_base": "file:///etc/passwd"}, "bad-lab-api-base")):
            with self.subTest(over=over):
                out = run(main.handle(self.boot_payload(**over)))
                self.assertFalse(out["ok"])
                self.assertEqual(out["error"], error)
        self.assertTrue(sentinel.exists())
        self.assertEqual(self.git.calls, [])

    def test_library_mismatch_fails_boot_before_claude_starts(self):
        other_body, other_sha = library((("rb-beta/SKILL.md", "# beta\n"),))
        self.up.skills = (200, other_body, {"x-skill-library-sha256": other_sha})
        marker = os.path.join(self.tmp, "claude-ran")
        self.use_claude(f"touch {marker}\necho '{{\"type\":\"result\"}}'\n")

        async def go():
            booted = await main.handle(self.boot_payload())
            task = await main.handle(self.task_payload())
            return booted, task

        booted, task = run(go())
        self.assertEqual(booted["error"], "library-mismatch")
        self.assertNotIn(other_sha, booted["detail"])  # 12-char prefixes only
        self.assertEqual(task, {"agent": "devbox", "error": "not-booted"})
        self.assertFalse(os.path.exists(marker), "claude started after a library-mismatch boot")
        self.assertFalse(os.path.exists(self.sock), "the broker outlived a failed boot")
        # The library was fetched through the broker, with the run token.
        skills = [c for c in self.up.calls if c["url"].endswith("/skills")]
        self.assertEqual(skills[0]["url"], "https://lab.orgiq.internal/api/runs/job-42/skills")
        self.assertEqual(skills[0]["headers"]["x-lab-run-token"], RUN_TOKEN)

    def test_a_tampered_library_is_a_mismatch_too(self):
        body = json.loads(LIB_BODY)
        body["files"][0]["content"] = "# alpha, edited in transit\n"
        self.up.skills = (200, json.dumps(body).encode(), {})
        out = run(main.handle(self.boot_payload()))
        self.assertEqual(out["error"], "library-mismatch")

    def test_skills_unavailable_fails_boot(self):
        self.up.skills = (503, b"", {})
        out = run(main.handle(self.boot_payload()))
        self.assertEqual(out["error"], "skills-unavailable")

    def test_boot_writes_the_run_state_lab_reads(self):
        run(main.handle(self.boot_payload()))
        state = json.loads(Path(self.root, ".claude", "orgiq-run.json").read_text())
        self.assertEqual(state, {"run_ref": "job-42", "brief_ref": "brief-job-42", "library_sha": LIB_SHA,
                                 "repo": "acme/widgets"})
        self.assertNotIn(RUN_TOKEN, json.dumps(state))

    def test_fleet_wipe_op_empties_the_workspace(self):
        Path(self.root, "a.txt").write_text("x")
        os.makedirs(os.path.join(self.root, "repo", ".git"))
        out = run(main.handle({"op": "wipe"}))
        self.assertEqual(out, {"ok": True, "removed": 2})
        self.assertEqual(os.listdir(self.root), [".claude"])

    def test_fleet_ops_are_unchanged_without_runner(self):
        out = run(main.handle({"op": "boot"}))  # no runner: not a microvm op, so a fleet task without a prompt
        self.assertEqual(out, {"agent": "devbox", "error": "missing prompt"})
        self.assertEqual(run(main.handle({"runner": "elsewhere"}))["error"], "unknown-runner")


class BrokerTests(MicrovmCase):
    def _broker(self):
        return main.LabBroker(run_ref="job-42", run_token=RUN_TOKEN, secret=SECRET,
                              api_base="https://lab.orgiq.internal", socket_path=self.sock)

    def test_refuses_paths_outside_this_run(self):
        async def go():
            broker = self._broker()
            await broker.start()
            try:
                mode = stat.S_IMODE(os.stat(self.sock).st_mode)
                results = {}
                for method, target in (
                    ("GET", "/api/runs/job-41/brief"),
                    ("GET", "/api/runs/job-42"),
                    ("GET", "/api/runs/job-42/../job-41/brief"),
                    ("GET", "/api/runs/job-42/%2e%2e/job-41/brief"),
                    ("GET", "/api/runs/job-42%2fx/brief"),
                    ("GET", "//api/lab/experiences"),
                    ("GET", "/api/lab"),
                    ("GET", "/api/admin/users"),
                    ("GET", "/api/runbooks/proposals"),
                    ("DELETE", "/api/lab/experiences/1"),
                    ("POST", "/api/observability/approvals/request"),
                ):
                    status, _, body = await main._unix_http(self.sock, method, target)
                    results[(method, target)] = (status, body)
                return mode, results
            finally:
                await broker.stop()

        mode, results = asyncio.run(go())
        self.assertEqual(mode, 0o600)
        for key, (status, body) in results.items():
            self.assertEqual(status, 403, key)
            self.assertIn(b"not allowed", body)
        self.assertEqual(self.up.calls, [], "a refused path reached the upstream")

    def test_forwards_this_runs_paths_with_both_headers(self):
        cb = main._callbacks

        async def go():
            broker = self._broker()
            await broker.start()
            try:
                get = await main._unix_http(self.sock, "GET", "/api/runs/job-42/brief?format=markdown",
                                            headers={"x-lab-run-token": "forged", "X-Service-Auth": "forged"})
                body = json.dumps({"kind": "gotcha", "title": "t ✓"}).encode()
                post = await main._unix_http(self.sock, "POST", "/api/lab/experiences", body,
                                             {"content-type": "application/json"})
                return get, post, body
            finally:
                await broker.stop()

        get, post, body = asyncio.run(go())
        self.assertEqual(get[0], 200)
        self.assertEqual(get[2], b"# the brief\n")
        self.assertIn("x-brief-sha256", get[1])
        self.assertEqual(post[0], 200)
        self.assertEqual(len(self.up.calls), 2)
        for call, method, target, sent in ((self.up.calls[0], "GET", "/api/runs/job-42/brief?format=markdown", ""),
                                           (self.up.calls[1], "POST", "/api/lab/experiences", body.decode())):
            h = call["headers"]
            self.assertEqual(call["url"], "https://lab.orgiq.internal" + target)
            self.assertEqual(h["x-lab-run-token"], RUN_TOKEN)  # the broker's, not the forged one
            nonce = h["x-service-nonce"]
            ok, who = cb.verify_service_request(
                h["x-service-auth"], method, target, sent, secret=SECRET, allowed_services=["orgiq-devbox"],
                audience=cb.nonce_audience("orgiq-middleware/lab", nonce))
            self.assertTrue(ok, who)
            self.assertNotIn("x-lab-auth", h)  # the static header stays off the wire by default
        self.assertEqual(self.up.calls[1]["data"], body)

    def test_runbook_writes_lab_makes_are_forwarded(self):
        async def go():
            broker = self._broker()
            await broker.start()
            try:
                a = await main._unix_http(self.sock, "POST", "/api/runbooks/rb-alpha/applications", b"{}")
                b = await main._unix_http(self.sock, "POST", "/api/runbooks/proposals", b"{}")
                return a[0], b[0]
            finally:
                await broker.stop()

        self.assertEqual(asyncio.run(go()), (200, 200))


class TaskTests(MicrovmCase):
    def _env_of_claude(self) -> dict:
        env = {}
        for line in Path(self.out, "env").read_text().splitlines():
            k, _, v = line.partition("=")
            env[k] = v
        return env

    KEPT = {
        "AWS_REGION": "us-east-1", "AWS_DEFAULT_REGION": "us-east-1",
        "AWS_CONTAINER_CREDENTIALS_FULL_URI": "http://169.254.170.23/v1/credentials",
        "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI": "/v2/credentials/x",
        "AWS_CONTAINER_AUTHORIZATION_TOKEN": "provider-token",
        "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE": "/var/run/token",
        "AWS_WEB_IDENTITY_TOKEN_FILE": "/var/run/wi", "AWS_ROLE_ARN": "arn:aws:iam::1:role/r",
        "AWS_ROLE_SESSION_NAME": "s", "AWS_EXECUTION_ENV": "AWS_ECS_FARGATE",
        "AWS_BEDROCK_RUNTIME_ENDPOINT": "https://bedrock-runtime.vpce", "CLAUDE_CODE_USE_BEDROCK": "1",
        "ANTHROPIC_MODEL": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        "ANTHROPIC_SMALL_FAST_MODEL": "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    }
    STRIPPED = {
        "LAB_RUN_TOKEN": "stale", "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.extraheader",
        "GIT_CONFIG_VALUE_0": "AUTHORIZATION: basic leak", "GIT_CONFIG_PARAMETERS": "'x.y'='z'",
        "LAB_CALLBACK_SECRET_ID": "orgiq/lab", "AWS_ACCESS_KEY_ID": "AKIA", "AWS_SECRET_ACCESS_KEY": "s",
        "AWS_SESSION_TOKEN": "t", "AWS_PROFILE": "p", "AWS_SHARED_CREDENTIALS_FILE": "/c",
        "AWS_CONFIG_FILE": "/f", "GITHUB_TOKEN": "ghp_x",
    }

    def test_the_strip_list_is_pinned(self):
        self.assertEqual(main._CLAUDE_ENV_STRIP, (
            "LAB_RUN_TOKEN", "LAB_CALLBACK_SECRET", "LAB_CALLBACK_SECRET_ID",
            "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
            "AWS_PROFILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONFIG_FILE",
            "GH_TOKEN", "GITHUB_TOKEN"))
        self.assertEqual(main._CLAUDE_ENV_STRIP_PREFIXES, ("GIT_CONFIG",))
        for name in self.KEPT:
            self.assertFalse(main._stripped_for_claude(name), name)
        for name in list(self.STRIPPED) + ["LAB_CALLBACK_SECRET", "GIT_CONFIG_GLOBAL"]:
            self.assertTrue(main._stripped_for_claude(name), name)

    def test_claude_env_lacks_the_secrets_the_git_child_has_the_header(self):
        os.environ.update(self.STRIPPED)
        os.environ.update(self.KEPT)
        # The payload's secret, so boot never tries the _ID lookup (no boto3, no network).
        booted, events = run(self.boot_and_task(boot_over={"callback_secret": SECRET}))
        env = self._env_of_claude()
        for name in list(self.STRIPPED) + ["LAB_CALLBACK_SECRET"]:
            self.assertNotIn(name, env, name)
        self.assertNotIn(RUN_TOKEN, Path(self.out, "env").read_text())
        self.assertNotIn(SECRET, Path(self.out, "env").read_text())
        self.assertNotIn(READ_TOKEN, Path(self.out, "env").read_text())
        # The execution role's credential provider and the Bedrock settings survive.
        for name, value in self.KEPT.items():
            self.assertEqual(env.get(name), value, name)
        self.assertEqual(env["LAB_API_BASE"], "http+unix://" + self.sock)
        self.assertEqual(env["LAB_RUN_REF"], "job-42")
        self.assertEqual(env["LAB_LIBRARY_SHA"], LIB_SHA)
        self.assertEqual(env["HOME"], self.root)
        self.assertEqual(env["GIT_AUTHOR_EMAIL"], "agent@orgiq.local")
        # …while the clone's git child carried the header.
        clone_env = self.git.calls[0]["env"]
        self.assertIn("http.https://github.com/.extraheader",
                      [clone_env[f"GIT_CONFIG_KEY_{i}"] for i in range(int(clone_env["GIT_CONFIG_COUNT"]))])

    def test_payload_callback_secret_stays_in_the_broker(self):
        payload_secret = "payload-fleet-secret-XYZ-0987"
        os.environ.pop("LAB_CALLBACK_SECRET", None)
        root = logging.getLogger()
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        old_level = root.level
        root.addHandler(handler)
        root.setLevel(logging.DEBUG)

        async def go():
            booted, events = await self.boot_and_task(boot_over={"callback_secret": payload_secret})
            # The broker signs with the payload's secret.
            self.up.calls.clear()
            status, _, _ = await main._unix_http(self.sock, "GET", "/api/runs/job-42/brief")
            return booted, events, status

        try:
            booted, events, status = run(go())
        finally:
            root.removeHandler(handler)
            root.setLevel(old_level)
        self.assertEqual(status, 200)
        h = self.up.calls[0]["headers"]
        cb = main._callbacks
        ok, _ = cb.verify_service_request(h["x-service-auth"], "GET", "/api/runs/job-42/brief", "",
                                          secret=payload_secret, allowed_services=["orgiq-devbox"],
                                          audience=cb.nonce_audience("orgiq-middleware/lab", h["x-service-nonce"]))
        self.assertTrue(ok)
        logs = stream.getvalue()
        self.assertEqual(logs.count("callback secret source=payload"), 1)
        claude_env = Path(self.out, "env").read_text()
        for value in (payload_secret, RUN_TOKEN):
            self.assertNotIn(value, claude_env)
            self.assertNotIn(value, logs)
            self.assertNotIn(value, json.dumps([booted, events]))
            for path in Path(self.root).rglob("*"):
                if path.is_file():
                    self.assertNotIn(value, path.read_text(errors="replace"), f"{value[:8]}… on disk in {path}")

    def test_secret_source_falls_back_to_env_then_none(self):
        with self.assertLogs("main", level="INFO") as logs:
            run(main.handle(self.boot_payload()))
        self.assertTrue(any("callback secret source=env" in m for m in logs.output))
        self.assertFalse(any(SECRET in m for m in logs.output))
        os.environ.pop("LAB_CALLBACK_SECRET", None)
        with self.assertLogs("main", level="INFO") as logs:
            run(main.handle(self.boot_payload()))
        self.assertTrue(any("callback secret source=none" in m for m in logs.output))

    def test_argv_has_no_continue_no_skipped_permissions_and_cwd_is_the_repo(self):
        _, events = run(self.boot_and_task())
        argv = Path(self.out, "argv").read_text()
        self.assertNotIn("--continue", argv)
        self.assertNotIn("--resume", argv)
        self.assertNotIn("--dangerously-skip-permissions", argv)
        self.assertEqual(events[0]["type"], "devbox_start")
        self.assertEqual(events[0]["workspace"], self.target)

    def test_devbox_end_carries_the_contract_fields(self):
        _, events = run(self.boot_and_task())
        ends = [e for e in events if e["type"] == "devbox_end"]
        self.assertEqual(len(ends), 1)
        end = events[-1]
        self.assertIs(end, ends[0])
        self.assertEqual(end["exit_code"], 0)
        self.assertEqual(end["fresh_tokens"], 150)  # 100 + 20 cache write + 30, cache reads excluded
        self.assertEqual(end["usage"], {"inputTokens": 100, "outputTokens": 30, "cacheWriteTokens": 20,
                                        "cacheReadTokens": 3000})
        self.assertEqual(end["head_sha"], HEAD)
        self.assertEqual(end["claude_session_id"], SESSION)
        self.assertIsInstance(end["duration_ms"], int)
        self.assertEqual(end["reported_cost_usd"], 0.02)
        self.assertIn("transcript_uploaded", end)

    def test_no_result_event_means_unknown_never_zero(self):
        self.use_claude(CLAUDE_NO_RESULT)
        _, events = run(self.boot_and_task())
        end = events[-1]
        self.assertEqual(end["type"], "devbox_end")
        self.assertEqual(end["exit_code"], 1)
        self.assertIsNone(end["fresh_tokens"])
        self.assertIsNone(end["usage"])

    def test_the_log_has_the_prompts_length_and_sha_and_none_of_its_text(self):
        prompt = ("Refactor the billing module so that invoices for customer Zed Quillfeather are "
                  "recomputed nightly, and never email the draft to anyone outside finance. " * 3)
        root = logging.getLogger()
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.setLevel(logging.DEBUG)
        old_level = root.level
        root.addHandler(handler)
        root.setLevel(logging.DEBUG)
        try:
            run(self.boot_and_task({"prompt": prompt}))
            # The fleet path too.
            async def fleet():
                return await collect(await main.handle({"prompt": prompt, "stream": True}))
            fleet_events = run(fleet())
        finally:
            root.removeHandler(handler)
            root.setLevel(old_level)
        self.assertEqual(fleet_events[-1]["type"], "devbox_end")
        text = stream.getvalue()
        self.assertEqual(text.count(f"prompt_len={len(prompt)}"), 2)  # microvm and fleet
        self.assertIn(hashlib.sha256(prompt.encode()).hexdigest(), text)
        for i in range(len(prompt) - 39):
            self.assertNotIn(prompt[i:i + 40], text, f"a 40-char piece of the prompt was logged at {i}")
        self.assertNotIn(RUN_TOKEN, text)
        self.assertNotIn("X-Amz-Signature", text)

    def test_transcript_put_once_and_its_failure_does_not_change_exit(self):
        tdir = main._transcript_path(self.root, self.target, SESSION).rsplit("/", 1)[0]
        os.environ["TRANSCRIPT_DIR"] = tdir
        self.use_claude(CLAUDE_TRANSCRIPT)
        self.up.put_error = urllib.error.HTTPError("https://s3.example/put", 403, "Forbidden", Message(), None)
        _, events = run(self.boot_and_task())
        end = events[-1]
        puts = self.up.of("PUT")
        self.assertEqual(len(puts), 1)
        self.assertEqual(puts[0]["url"], "https://s3.example/put?X-Amz-Signature=sig")
        self.assertEqual(puts[0]["data"], b'{"type":"user","message":"hi"}\n')
        self.assertEqual(end["exit_code"], 0)
        self.assertFalse(end["transcript_uploaded"])

        self.up.calls.clear()
        self.up.put_error = None
        _, events = run(self.boot_and_task())
        self.assertEqual(len(self.up.of("PUT")), 1)
        self.assertTrue(events[-1]["transcript_uploaded"])

    def test_resume_downloads_the_transcript_then_resumes_by_id(self):
        path = main._transcript_path(self.root, self.target, RESUME)
        self.use_claude(f"""
printf '%s\\n' "$*" > "$OUT_DIR/argv"
test -f '{path}' && echo '{{"type":"devbox_test","transcript":"present"}}'
echo '{{"type":"result","session_id":"{RESUME}","usage":{{"input_tokens":1,"output_tokens":1}}}}'
""")
        _, events = run(self.boot_and_task({"resume_session_id": RESUME,
                                            "resume_transcript_get_url": "https://s3.example/get?sig=1"}))
        self.assertIn({"type": "devbox_test", "transcript": "present"}, events)
        argv = Path(self.out, "argv").read_text().split()
        self.assertEqual(argv[argv.index("--resume") + 1], RESUME)
        self.assertNotIn("--continue", argv)
        self.assertEqual(Path(path).read_bytes(), self.up.transcript)
        self.assertTrue(path.startswith(os.path.join(self.root, ".claude", "projects", "-")))

    def test_resume_without_a_transcript_refuses_before_claude(self):
        marker = os.path.join(self.tmp, "claude-ran")
        self.use_claude(f"touch {marker}\n")

        async def go():
            await main.handle(self.boot_payload())
            a = await main.handle(self.task_payload(resume_session_id=RESUME))
            b = await main.handle(self.task_payload(resume_session_id="not-a-uuid"))
            return a, b

        a, b = run(go())
        self.assertEqual(a["error"], "resume-transcript-unavailable")
        self.assertEqual(b["error"], "bad resume_session_id")
        self.assertFalse(os.path.exists(marker))

    def test_dirty_tree_gets_a_snapshot_commit_as_the_actor(self):
        self.git.dirty = True
        author = {"name": "Ada Lovelace", "email": "1+ada@users.noreply.github.com"}
        _, events = run(self.boot_and_task({"author": author}))
        subs = self.git.subcommands()
        self.assertEqual(subs[-4:], ["status", "add", "commit", "rev-parse"])
        commit = next(c for c in self.git.calls if "commit" in c["argv"])
        self.assertIn("--no-verify", commit["argv"])
        self.assertEqual(commit["env"]["GIT_AUTHOR_NAME"], "Ada Lovelace")
        self.assertEqual(commit["env"]["GIT_COMMITTER_EMAIL"], "1+ada@users.noreply.github.com")
        self.assertNotIn("Fix the flaky", " ".join(commit["argv"]))  # the prompt is not the message
        self.assertEqual(events[-1]["head_sha"], NEW_HEAD)

    def test_clean_tree_gets_no_commit_and_default_author(self):
        run(self.boot_and_task())
        self.assertNotIn("commit", self.git.subcommands())
        status = next(c for c in self.git.calls if "status" in c["argv"])
        self.assertEqual(status["env"]["GIT_AUTHOR_NAME"], "OrgIQ Agent")


class PushTests(MicrovmCase):
    async def _boot(self, **over):
        out = await main.handle(self.boot_payload(**over))
        self.assertTrue(out["ok"], out)

    def test_push_uses_the_write_token_in_env_and_an_explicit_lease(self):
        async def go():
            await self._boot()
            first = await main.handle({"op": "push", "runner": "microvm", "branch": "orgiq/ab12cd34/job12345",
                                       "token": WRITE_TOKEN,
                                       "author": {"name": "Ada", "email": "1+ada@users.noreply.github.com"}})
            second = await main.handle({"op": "push", "runner": "microvm", "branch": "orgiq/ab12cd34/job12345",
                                        "token": WRITE_TOKEN})
            return first, second

        first, second = run(go())
        self.assertEqual(first, {"ok": True, "head_sha": HEAD, "pushed": True})
        pushes = [c for c in self.git.calls if "push" in c["argv"]]
        self.assertEqual(pushes[0]["argv"], [
            "git", "-C", self.target, "push", "--force-with-lease=refs/heads/orgiq/ab12cd34/job12345:",
            "https://github.com/acme/widgets.git", "HEAD:refs/heads/orgiq/ab12cd34/job12345"])
        # A second push leases on what the first one left.
        self.assertTrue(pushes[1]["argv"][4].endswith(":" + HEAD))
        env = pushes[0]["env"]
        keys = {env[f"GIT_CONFIG_KEY_{i}"]: env[f"GIT_CONFIG_VALUE_{i}"] for i in range(int(env["GIT_CONFIG_COUNT"]))}
        self.assertIn(base64.b64encode(f"x-access-token:{WRITE_TOKEN}".encode()).decode(),
                      keys["http.https://github.com/.extraheader"])
        self.assertEqual(keys["core.hooksPath"], os.devnull)
        self.assertEqual(env["GIT_CONFIG_GLOBAL"], os.devnull)
        self.assertNotIn(WRITE_TOKEN, json.dumps([c["argv"] for c in self.git.calls]))
        self.assertTrue(second["ok"])

    def test_a_resumed_branch_leases_on_the_boot_head(self):
        async def go():
            await self._boot(ref="orgiq/ab12cd34/job12345")
            return await main.handle({"op": "push", "runner": "microvm", "branch": "orgiq/ab12cd34/job12345"})

        run(go())
        push = next(c for c in self.git.calls if "push" in c["argv"])
        self.assertEqual(push["argv"][4], f"--force-with-lease=refs/heads/orgiq/ab12cd34/job12345:{HEAD}")

    def test_push_refuses_branches_outside_orgiq_and_reports_rejection(self):
        async def go():
            await self._boot()
            outs = [await main.handle({"op": "push", "runner": "microvm", "branch": b})
                    for b in ("main", "-f", "orgiq/../main", "orgiq/x/y.lock")]
            self.git.push_rc = 1
            outs.append(await main.handle({"op": "push", "runner": "microvm", "branch": "orgiq/a/b"}))
            return outs

        outs = run(go())
        for out in outs[:4]:
            self.assertEqual(out["error"], "bad-branch")
        self.assertEqual(outs[4]["error"], "push-rejected")
        self.assertFalse(outs[4]["ok"])

    def test_git_config_claude_edited_is_restored_before_the_push(self):
        async def go():
            await self._boot()
            cfg = Path(self.target, ".git", "config")
            original = cfg.read_text()
            cfg.write_text('[remote "origin"]\n\turl = https://evil.example/x.git\n[core]\n\tfsmonitor = sh -c evil\n')
            out = await main.handle({"op": "push", "runner": "microvm", "branch": "orgiq/a/b", "token": WRITE_TOKEN})
            return out, original, cfg.read_text()

        out, original, after = run(go())
        self.assertTrue(out["ok"])
        self.assertEqual(after, original)

    def test_push_before_boot_is_refused(self):
        out = run(main.handle({"op": "push", "runner": "microvm", "branch": "orgiq/a/b"}))
        self.assertEqual(out["error"], "not-booted")


class SettingsTests(unittest.TestCase):
    def test_managed_settings_allow_and_deny(self):
        s = json.loads((HERE / "managed-settings.json").read_text())
        self.assertEqual(s["permissions"]["allow"], [
            "Read", "Edit", "Write", "Glob", "Grep", "Bash(git status*)", "Bash(git diff*)", "Bash(git log*)",
            "Bash(git add*)", "Bash(git commit*)", "Bash(git checkout*)", "Bash(git switch*)", "Bash(git stash*)",
            "Bash(npm test*)", "Bash(npm run lint*)", "Bash(npm run typecheck*)", "Bash(lab *)"])
        self.assertEqual(s["permissions"]["deny"], [
            "Bash(git push*)", "Bash(curl*)", "Bash(wget*)", "Bash(ssh*)", "Bash(aws*)", "WebFetch", "WebSearch",
            "Read(./.env*)", "Read(~/.aws/**)"])
        self.assertEqual(s["permissions"]["disableBypassPermissionsMode"], "disable")
        self.assertEqual(s["hooks"]["SessionStart"][0]["hooks"][0]["command"], "lab brief")
        self.assertEqual(s["hooks"]["SessionEnd"][0]["hooks"][0]["command"], "lab keep")

    def test_no_runner_skips_permissions(self):
        orig = main._claude_bin
        main._claude_bin = lambda: "claude"
        try:
            for cmd in (main._build_cmd("p", False, "stream-json"), main._build_cmd("p", True, "json"),
                        main._build_cmd("p", False, "stream-json", resume_session_id=RESUME)):
                self.assertNotIn("--dangerously-skip-permissions", cmd)
                self.assertFalse(any(a.startswith("--permission-mode") for a in cmd))
        finally:
            main._claude_bin = orig


@unittest.skipUnless(shutil.which("curl") and shutil.which("python3") and shutil.which("bash"), "needs curl+bash")
class LabOverBrokerTests(MicrovmCase):
    """The real `lab` script, through the real broker, against the fake upstream."""

    def _lab(self, *args, extra=None):
        env = {"PATH": os.environ["PATH"], "HOME": self.root, "LAB_API_BASE": "http+unix://" + self.sock,
               "LAB_REPO": "acme/widgets", "LAB_SKILLS_DIR": os.path.join(self.root, ".claude", "skills")}
        env.update(extra or {})

        async def go():
            proc = await asyncio.create_subprocess_exec(
                "bash", str(HERE / "lab"), *args, env=env,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            out, err = await asyncio.wait_for(proc.communicate(), timeout=60)
            return proc.returncode, out.decode(), err.decode()
        return go()

    def test_lab_brief_goes_through_the_broker_with_no_token_of_its_own(self):
        async def go():
            await main.handle(self.boot_payload())
            self.up.calls.clear()
            # LAB_RUN_REF comes from the state file boot wrote; no token, no secret here.
            return await self._lab("brief", extra={"LAB_LIBRARY_SHA": LIB_SHA})

        rc, out, err = run(go())
        self.assertEqual(rc, 0, err)
        self.assertIn("installed the org's library", out)
        self.assertIn("# the brief", out)
        urls = [c["url"] for c in self.up.calls]
        self.assertEqual(urls, ["https://lab.orgiq.internal/api/runs/job-42/skills",
                                "https://lab.orgiq.internal/api/runs/job-42/brief?format=markdown"])
        for c in self.up.calls:
            self.assertEqual(c["headers"]["x-lab-run-token"], RUN_TOKEN)
            self.assertIn("x-service-auth", c["headers"])

    def test_lab_skills_refuses_a_library_that_is_not_the_runs(self):
        async def go():
            await main.handle(self.boot_payload())
            return await self._lab("skills", extra={"LAB_RUN_REF": "job-42", "LAB_LIBRARY_SHA": "f" * 64})

        rc, out, err = run(go())
        self.assertEqual(rc, 0, err)
        self.assertIn("REFUSED the library (library-mismatch", out)
        self.assertFalse(os.path.exists(os.path.join(self.root, ".claude", "skills", "rb-alpha")))


if __name__ == "__main__":
    unittest.main(verbosity=2)
