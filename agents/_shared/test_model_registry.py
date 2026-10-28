"""Unit tests for model_registry (DE-3) — stdlib unittest, no network.

Run:  cd agents/_shared && ../../.venv-synth/bin/python -m unittest test_model_registry
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from botocore.exceptions import ClientError  # noqa: E402

from _shared import model_registry as mr  # noqa: E402

ENV_KEYS = ("MODEL_REGISTRY_PARAM", "MODEL_REGISTRY_VERSION", "MODEL_REGISTRY_FILE",
            "MODEL_REGISTRY_DISABLED", "MODEL_REGISTRY_REFRESH_S", "MODEL_ID",
            "MODEL_TEMPERATURE", "MODEL_MAX_TOKENS")


def _doc(primary="us.amazon.nova-pro-v1:0", fallbacks=("amazon.nova-lite-v1:0",), **extra):
    entry = {"primary": primary, "fallbacks": list(fallbacks), "temperature": 0.1, "maxTokens": 2048}
    entry.update(extra)
    return {"schema": 1, "roles": {"search": entry}, "allow": list(mr.ALLOWED_PREFIXES)}


def _ssm_response(doc, version=7):
    return {"Parameter": {"Value": json.dumps(doc), "Version": version}}


def _client_error(code):
    return ClientError({"Error": {"Code": code, "Message": code}}, "Converse")


class _Base(unittest.TestCase):
    def setUp(self):
        self._saved = {k: os.environ.pop(k, None) for k in ENV_KEYS}
        # Offline tests must not pick up the repo's checked-in file by accident.
        os.environ["MODEL_REGISTRY_FILE"] = "/nonexistent/model-registry.json"
        mr.reset_cache()
        mr._ssm_client = None

    def tearDown(self):
        for k in ENV_KEYS:
            os.environ.pop(k, None)
            if self._saved[k] is not None:
                os.environ[k] = self._saved[k]
        mr.reset_cache()
        mr._ssm_client = None

    def _use_ssm(self, client):
        os.environ["MODEL_REGISTRY_PARAM"] = "/orgiq/models/registry"
        mr._ssm_client = client


class ResolveFromSsmTests(_Base):
    def test_reads_registry_role(self):
        client = mock.Mock()
        client.get_parameter.return_value = _ssm_response(_doc())
        self._use_ssm(client)
        got = mr.resolve_model("search")
        self.assertEqual(got.model_id, "us.amazon.nova-pro-v1:0")
        self.assertEqual(got.chain, ("us.amazon.nova-pro-v1:0", "amazon.nova-lite-v1:0"))
        self.assertEqual((got.temperature, got.max_tokens), (0.1, 2048))
        self.assertEqual((got.source, got.version), ("ssm", "7"))
        client.get_parameter.assert_called_once_with(Name="/orgiq/models/registry")

    def test_cache_ttl(self):
        client = mock.Mock()
        client.get_parameter.return_value = _ssm_response(_doc())
        self._use_ssm(client)
        with mock.patch.object(mr.time, "monotonic", return_value=1000.0):
            mr.resolve_model("search")
            mr.resolve_model("search")
        self.assertEqual(client.get_parameter.call_count, 1, "second read within TTL is cached")
        with mock.patch.object(mr.time, "monotonic", return_value=1000.0 + 61):
            mr.resolve_model("search")
        self.assertEqual(client.get_parameter.call_count, 2, "read after TTL refetches")

    def test_ssm_error_falls_back_to_model_id_env(self):
        client = mock.Mock()
        client.get_parameter.side_effect = _client_error("AccessDeniedException")
        self._use_ssm(client)
        os.environ["MODEL_ID"] = "amazon.nova-lite-v1:0"
        got = mr.resolve_model("search")
        self.assertEqual((got.model_id, got.source), ("amazon.nova-lite-v1:0", "env"))

    def test_ssm_error_without_env_uses_literal(self):
        client = mock.Mock()
        client.get_parameter.side_effect = RuntimeError("timeout")
        self._use_ssm(client)
        got = mr.resolve_model("search", default_model_id="amazon.nova-micro-v1:0")
        self.assertEqual((got.model_id, got.source), ("amazon.nova-micro-v1:0", "default"))

    def test_version_pin_is_honoured(self):
        client = mock.Mock()
        client.get_parameter.return_value = _ssm_response(_doc(primary="amazon.nova-lite-v1:0"), version=3)
        self._use_ssm(client)
        os.environ["MODEL_REGISTRY_VERSION"] = "3"
        got = mr.resolve_model("search")
        client.get_parameter.assert_called_once_with(Name="/orgiq/models/registry:3")
        self.assertEqual((got.model_id, got.version), ("amazon.nova-lite-v1:0", "3"))

    def test_non_amazon_id_in_registry_is_rejected(self):
        client = mock.Mock()
        client.get_parameter.return_value = _ssm_response(
            _doc(primary="anthropic.claude-3-5-sonnet-20240620-v1:0"))
        self._use_ssm(client)
        os.environ["MODEL_ID"] = "amazon.nova-pro-v1:0"
        got = mr.resolve_model("search")
        self.assertEqual((got.model_id, got.source), ("amazon.nova-pro-v1:0", "env"))

    def test_missing_role_falls_back(self):
        client = mock.Mock()
        client.get_parameter.return_value = _ssm_response(_doc())
        self._use_ssm(client)
        got = mr.resolve_model("advisor", default_model_id="amazon.nova-pro-v1:0")
        self.assertEqual(got.source, "default")


class ValidatorTests(_Base):
    def test_rejects_non_aws_native_ids(self):
        for bad in ("anthropic.claude-v2", "us.anthropic.claude-3-haiku", "meta.llama3", "", None):
            with self.subTest(bad=bad), self.assertRaises(mr.RegistryError):
                mr.validate_registry(_doc(primary=bad))

    def test_rejects_non_aws_fallback(self):
        with self.assertRaises(mr.RegistryError):
            mr.validate_registry(_doc(fallbacks=("us.anthropic.claude-3-haiku",)))

    def test_allow_cannot_widen(self):
        doc = _doc()
        doc["allow"] = ["amazon.", "anthropic."]
        with self.assertRaises(mr.RegistryError):
            mr.validate_registry(doc)

    def test_env_model_id_must_be_aws_native(self):
        os.environ["MODEL_ID"] = "us.anthropic.claude-sonnet-4"
        got = mr.resolve_model("search", default_model_id="amazon.nova-pro-v1:0")
        self.assertEqual((got.model_id, got.source), ("amazon.nova-pro-v1:0", "default"))

    def test_checked_in_registry_is_valid(self):
        path = Path(__file__).resolve().parent.parent.parent / "infra" / "config" / "model-registry.json"
        doc = mr.validate_registry(json.loads(path.read_text()))
        for role in ("supervisor", "search", "advisor", "scoring", "ingestion", "graph-builder",
                     "assessment-drafter", "assessment-scorer", "eval-judge"):
            self.assertIn(role, doc["roles"])


class OfflineFileTests(_Base):
    def test_reads_file_and_never_calls_ssm(self):
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
            json.dump(_doc(primary="amazon.nova-lite-v1:0"), fh)
        os.environ["MODEL_REGISTRY_FILE"] = fh.name
        with mock.patch.object(mr, "_ssm") as ssm:
            got = mr.resolve_model("search")
        ssm.assert_not_called()
        self.assertEqual((got.model_id, got.source), ("amazon.nova-lite-v1:0", "file"))
        os.unlink(fh.name)

    def test_disabled_uses_env(self):
        os.environ["MODEL_REGISTRY_DISABLED"] = "1"
        os.environ["MODEL_ID"] = "amazon.nova-micro-v1:0"
        self.assertEqual(mr.resolve_model("search").model_id, "amazon.nova-micro-v1:0")


class FallbackTests(_Base):
    CHAIN = ("us.amazon.nova-pro-v1:0", "amazon.nova-lite-v1:0")

    def test_fallback_fires_on_throttling(self):
        calls = []

        def call(mid):
            calls.append(mid)
            if mid == self.CHAIN[0]:
                raise _client_error("ThrottlingException")
            return "ok"

        result, served = mr.invoke_with_fallback(call, self.CHAIN)
        self.assertEqual((result, served), ("ok", "amazon.nova-lite-v1:0"))
        self.assertEqual(calls, list(self.CHAIN))

    def test_fallback_fires_on_wrapped_strands_throttle(self):
        class ModelThrottledException(Exception):
            pass

        def call(mid):
            if mid == self.CHAIN[0]:
                raise ModelThrottledException("slow down")
            return "ok"

        self.assertEqual(mr.invoke_with_fallback(call, self.CHAIN)[1], self.CHAIN[1])

    def test_no_fallback_on_validation_error(self):
        calls = []

        def call(mid):
            calls.append(mid)
            raise _client_error("ValidationException")

        with self.assertRaises(ClientError):
            mr.invoke_with_fallback(call, self.CHAIN)
        self.assertEqual(calls, [self.CHAIN[0]])

    def test_all_throttled_reraises(self):
        def call(mid):
            raise _client_error("ServiceUnavailableException")

        with self.assertRaises(ClientError):
            mr.invoke_with_fallback(call, self.CHAIN)


class RegistryAgentTests(_Base):
    def _agent(self):
        built: list[tuple[str, str]] = []

        class FakeLive:
            def __init__(self, *, baked, build, agent_name=None, name=None):
                self._build = build
                self.prompt_sha = "sha-" + baked

            def __call__(self, text):
                return self._build("prompt")(text)

        def build(system_prompt, model_id):
            built.append((system_prompt, model_id))

            def run(text):
                if model_id == "us.amazon.nova-pro-v1:0":
                    raise _client_error("ThrottlingException")
                return f"{model_id}:{text}"
            return run

        client = mock.Mock()
        client.get_parameter.return_value = _ssm_response(_doc())
        self._use_ssm(client)
        agent = mr.RegistryAgent(role="search", default_model_id="amazon.nova-pro-v1:0",
                                 baked="b", build=build, live_agent_factory=FakeLive)
        return agent, built

    def test_turn_retries_on_fallback_and_records_served_id(self):
        agent, built = self._agent()
        self.assertEqual(agent("hi"), "amazon.nova-lite-v1:0:hi")
        self.assertEqual(agent.model_id, "amazon.nova-lite-v1:0")
        self.assertEqual([m for _, m in built], ["us.amazon.nova-pro-v1:0", "amazon.nova-lite-v1:0"])
        self.assertEqual(agent.registry_version, "7")
        self.assertEqual(agent.prompt_sha, "sha-b")


if __name__ == "__main__":
    unittest.main()
