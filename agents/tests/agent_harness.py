"""Import an agent's ``main.py`` in a process that has no SDKs and no AWS.

The eight agents are single-file modules that do real work at import time —
they construct boto3 clients, patch botocore, build a ``BedrockModel`` and
register an AgentCore entrypoint — so none of them can be imported by a test
runner without help. That is exactly why the ``@tool`` functions inside them
have never been tested, and it is a solvable problem rather than a reason not
to.

This harness installs stand-ins for ``strands``, ``bedrock_agentcore``,
``httpx`` and ``websocket`` in ``sys.modules``, neuters ``boto3.client`` so no
client is ever constructed, and then loads the agent module by path (the agent
directories are hyphenated, so they are not importable as packages).

Two deliberate limits, so nobody reads more into a green run than is there:

*   ``strands.tool`` is the identity function here. The tests therefore
    exercise the raw Python callables and the ``instrumented_tool`` wrapper
    underneath them — the agent's decisions — and NOT Strands' schema
    generation, which is the framework's job to get right.
*   Nothing here touches AWS. Every client is a fake the test injects, so the
    assertions are about the request each tool *would* make: the SQL, the
    bound parameters, the model id, the KB it targets.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path
from unittest import mock

AGENTS_DIR = Path(__file__).resolve().parent.parent


# ── SDK stand-ins ─────────────────────────────────────────────────────────────


def _install_strands() -> None:
    if "strands" in sys.modules:
        return
    strands = types.ModuleType("strands")

    def tool(fn):
        """Identity: keeps the raw callable testable. See the module docstring."""
        return fn

    class Agent:
        """Records how it was built and how it was called.

        The supervisor calls ``agent(text, messages=[...])`` on its sync path,
        so the stub has to accept kwargs. ``respond`` lets a test script the
        answer (or raise, to exercise the modelStreamError retry).
        """

        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.system_prompt = kwargs.get("system_prompt")
            self.tools = kwargs.get("tools", [])
            self.model = kwargs.get("model")
            self.calls: list[tuple] = []
            #: Optional callable(prompt, **kwargs) -> answer. Default echoes.
            self.respond = None

        def __call__(self, prompt=None, **kwargs):
            self.calls.append((prompt, kwargs))
            if self.respond is not None:
                return self.respond(prompt, **kwargs)
            return f"stub-answer::{prompt}"

    strands.tool = tool
    strands.Agent = Agent

    models = types.ModuleType("strands.models")
    bedrock = types.ModuleType("strands.models.bedrock")

    class BedrockModel:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    bedrock.BedrockModel = BedrockModel
    models.bedrock = bedrock
    strands.models = models

    telemetry = types.ModuleType("strands.telemetry")
    telemetry.StrandsTelemetry = None  # absent-ish: OI bootstrap bails cleanly
    strands.telemetry = telemetry

    sys.modules["strands"] = strands
    sys.modules["strands.models"] = models
    sys.modules["strands.models.bedrock"] = bedrock


def _install_bedrock_agentcore() -> None:
    if "bedrock_agentcore" in sys.modules:
        return
    pkg = types.ModuleType("bedrock_agentcore")
    runtime = types.ModuleType("bedrock_agentcore.runtime")

    class BedrockAgentCoreApp:
        def __init__(self):
            self.entrypoints = []

        def entrypoint(self, fn):
            self.entrypoints.append(fn)
            return fn

        def run(self):  # pragma: no cover
            raise RuntimeError("not used in tests")

    runtime.BedrockAgentCoreApp = BedrockAgentCoreApp
    pkg.runtime = runtime

    tools = types.ModuleType("bedrock_agentcore.tools")
    browser = types.ModuleType("bedrock_agentcore.tools.browser_client")

    class BrowserClient:  # pragma: no cover — search's browser path is not under test
        def __init__(self, *a, **k):
            pass

    browser.BrowserClient = BrowserClient
    tools.browser_client = browser
    pkg.tools = tools

    sys.modules["bedrock_agentcore"] = pkg
    sys.modules["bedrock_agentcore.runtime"] = runtime
    sys.modules["bedrock_agentcore.tools"] = tools
    sys.modules["bedrock_agentcore.tools.browser_client"] = browser


def _install_httpx() -> None:
    """Minimal httpx so `_shared.approval_tool` imports. Any test that actually
    exercises approval polling should use test_approval_tool.py instead."""
    if "httpx" in sys.modules:
        return
    httpx = types.ModuleType("httpx")

    class HTTPStatusError(Exception):
        def __init__(self, message="", *, request=None, response=None):
            super().__init__(message)
            self.request = request
            self.response = response

    class Client:
        def __init__(self, *a, **k):
            raise AssertionError("no HTTP in agent-tool tests")

    httpx.HTTPStatusError = HTTPStatusError
    httpx.Client = Client
    sys.modules["httpx"] = httpx


def _install_websocket() -> None:
    sys.modules.setdefault("websocket", types.ModuleType("websocket"))


def install_sdk_stubs() -> None:
    _install_strands()
    _install_bedrock_agentcore()
    _install_httpx()
    _install_websocket()


# ── Module loading ────────────────────────────────────────────────────────────


def load_agent(agent_dir: str, *, env: dict | None = None):
    """Import ``agents/<agent_dir>/main.py`` with every SDK stubbed.

    ``boto3.client`` is replaced for the duration of the import so no real
    client is ever constructed — the module-level ``_rds`` / ``_bedrock_runtime``
    handles come out as Mocks that a test replaces with its own fake.
    """
    install_sdk_stubs()
    if str(AGENTS_DIR) not in sys.path:
        sys.path.insert(0, str(AGENTS_DIR))

    agent_path = AGENTS_DIR / agent_dir
    path = agent_path / "main.py"
    mod_name = f"orgiq_agent_{agent_dir.replace('-', '_')}"

    env = {"AWS_REGION": "us-east-1", **(env or {})}
    # The assessment agents keep their deterministic logic in a sibling
    # module (`scoring_logic` / `drafting_logic`) and import it by bare name,
    # so the agent's own directory has to be importable for the duration of
    # the import. Removed again afterwards to keep sys.path honest — the
    # sibling is already in sys.modules by then.
    sys.path.insert(0, str(agent_path))
    try:
        with mock.patch.dict("os.environ", env, clear=False), \
                mock.patch("boto3.client", side_effect=lambda *a, **k: mock.Mock()):
            spec = importlib.util.spec_from_file_location(mod_name, path)
            module = importlib.util.module_from_spec(spec)
            sys.modules[mod_name] = module
            spec.loader.exec_module(module)
    finally:
        try:
            sys.path.remove(str(agent_path))
        except ValueError:  # pragma: no cover — another loader already removed it
            pass
    return module


# ── RDS Data API fake ─────────────────────────────────────────────────────────


class FakeRds:
    """Records every execute_statement. Never speaks to Aurora."""

    def __init__(self, response=None):
        self.calls = []
        self.response = response if response is not None else {}

    def execute_statement(self, **kwargs):
        self.calls.append(kwargs)
        return self.response

    # Convenience accessors used by the tests.
    @property
    def sql(self) -> str:
        return self.calls[-1]["sql"]

    @property
    def params(self) -> dict:
        """Last call's parameters as {name: scalar}."""
        out = {}
        for p in self.calls[-1].get("parameters", []):
            value = p["value"]
            out[p["name"]] = next(iter(value.values()))
        return out
