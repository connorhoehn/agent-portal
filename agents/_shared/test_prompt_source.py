"""Unit tests for prompt_source — stdlib unittest, no network.

Run:  python -m unittest agents._shared.test_prompt_source  (from repo root)
or:   cd agents/_shared && python -m unittest test_prompt_source
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from botocore.exceptions import ClientError  # noqa: E402

from _shared import prompt_source as ps  # noqa: E402

BAKED = "You are the baked prompt."
LIVE = "You are the LIVE prompt from Bedrock."


def _fake_client(*, prompts=None, get_result=None, raises=None):
    """Minimal bedrock-agent stand-in: paginator + get_prompt."""
    client = mock.Mock()

    class _Paginator:
        def paginate(self):
            return [{"promptSummaries": prompts or []}]

    client.get_paginator.return_value = _Paginator()
    if raises is not None:
        client.get_prompt.side_effect = raises
    else:
        client.get_prompt.return_value = get_result or {}
    return client


def _prompt_detail(text, version="DRAFT", variant_name="default"):
    return {
        "version": version,
        "defaultVariant": variant_name,
        "variants": [
            {
                "name": variant_name,
                "templateConfiguration": {"text": {"text": text}},
            }
        ],
    }


class ResolveTests(unittest.TestCase):
    def setUp(self):
        ps.reset_cache()
        ps.DISABLED = False
        os.environ.pop("SYSTEM_PROMPT_NAME", None)
        os.environ.pop("SYSTEM_PROMPT_VERSION", None)

    def test_resolves_from_bedrock_when_present(self):
        client = _fake_client(
            prompts=[{"name": "orgiq-search-system-prompt", "id": "P1"}],
            get_result=_prompt_detail(LIVE),
        )
        with mock.patch.object(ps, "_bedrock_agent", return_value=client):
            got = ps.resolve_system_prompt(BAKED, agent_name="search")
        self.assertEqual(got.text, LIVE)
        self.assertEqual(got.source, "bedrock")
        self.assertTrue(got.is_live)
        self.assertEqual(got.sha, ps.prompt_sha(LIVE))

    def test_falls_back_when_prompt_missing(self):
        client = _fake_client(prompts=[{"name": "something-else", "id": "P9"}])
        with mock.patch.object(ps, "_bedrock_agent", return_value=client):
            got = ps.resolve_system_prompt(BAKED, agent_name="search")
        self.assertEqual(got.text, BAKED)
        self.assertEqual(got.source, "baked")

    def test_falls_back_on_access_denied(self):
        err = ClientError({"Error": {"Code": "AccessDeniedException"}}, "GetPrompt")
        client = _fake_client(
            prompts=[{"name": "orgiq-search-system-prompt", "id": "P1"}], raises=err
        )
        with mock.patch.object(ps, "_bedrock_agent", return_value=client):
            got = ps.resolve_system_prompt(BAKED, agent_name="search")
        self.assertEqual(got.text, BAKED)
        self.assertEqual(got.source, "baked")

    def test_falls_back_on_empty_template(self):
        client = _fake_client(
            prompts=[{"name": "orgiq-search-system-prompt", "id": "P1"}],
            get_result=_prompt_detail("   "),
        )
        with mock.patch.object(ps, "_bedrock_agent", return_value=client):
            got = ps.resolve_system_prompt(BAKED, agent_name="search")
        self.assertEqual(got.source, "baked")

    def test_kill_switch_skips_bedrock_entirely(self):
        client = _fake_client(
            prompts=[{"name": "orgiq-search-system-prompt", "id": "P1"}],
            get_result=_prompt_detail(LIVE),
        )
        ps.DISABLED = True
        try:
            with mock.patch.object(ps, "_bedrock_agent", return_value=client) as c:
                got = ps.resolve_system_prompt(BAKED, agent_name="search")
            self.assertEqual(got.source, "baked")
            c.assert_not_called()
        finally:
            ps.DISABLED = False

    def test_cache_prevents_repeat_lookups(self):
        client = _fake_client(
            prompts=[{"name": "orgiq-search-system-prompt", "id": "P1"}],
            get_result=_prompt_detail(LIVE),
        )
        with mock.patch.object(ps, "_bedrock_agent", return_value=client):
            ps.resolve_system_prompt(BAKED, agent_name="search")
            ps.resolve_system_prompt(BAKED, agent_name="search")
        self.assertEqual(client.get_prompt.call_count, 1)

    def test_default_name_derivation(self):
        self.assertEqual(ps.default_prompt_name("graph-builder"), "orgiq-graph-builder-system-prompt")
        self.assertEqual(ps.default_prompt_name("news_brief"), "orgiq-news-brief-system-prompt")

    def test_explicit_name_env_wins(self):
        os.environ["SYSTEM_PROMPT_NAME"] = "custom-prompt"
        try:
            self.assertEqual(ps.default_prompt_name("search"), "custom-prompt")
        finally:
            os.environ.pop("SYSTEM_PROMPT_NAME")


class PromptedAgentTests(unittest.TestCase):
    def setUp(self):
        ps.reset_cache()
        ps.DISABLED = False

    def test_builds_once_then_reuses(self):
        builds = []
        client = _fake_client(
            prompts=[{"name": "orgiq-search-system-prompt", "id": "P1"}],
            get_result=_prompt_detail(LIVE),
        )
        pa = ps.PromptedAgent(
            baked=BAKED,
            agent_name="search",
            build=lambda text: builds.append(text) or f"agent::{text[:10]}",
        )
        with mock.patch.object(ps, "_bedrock_agent", return_value=client):
            agent1, r1 = pa.get()
            agent2, r2 = pa.get()
        self.assertEqual(len(builds), 1)
        self.assertIs(agent1, agent2)
        self.assertEqual(r1.sha, r2.sha)

    def test_rebuilds_when_prompt_text_changes(self):
        builds = []
        first = _fake_client(
            prompts=[{"name": "orgiq-search-system-prompt", "id": "P1"}],
            get_result=_prompt_detail(LIVE),
        )
        second = _fake_client(
            prompts=[{"name": "orgiq-search-system-prompt", "id": "P1"}],
            get_result=_prompt_detail(LIVE + " Now with an extra rule."),
        )
        pa = ps.PromptedAgent(
            baked=BAKED,
            agent_name="search",
            build=lambda text: builds.append(text) or f"agent::{ps.prompt_sha(text)}",
        )
        with mock.patch.object(ps, "_bedrock_agent", return_value=first):
            agent1, _ = pa.get()
        ps.reset_cache()  # simulate TTL expiry
        with mock.patch.object(ps, "_bedrock_agent", return_value=second):
            agent2, r2 = pa.get()
        self.assertEqual(len(builds), 2)
        self.assertNotEqual(agent1, agent2)
        self.assertIn("extra rule", r2.text)

    def test_survives_bedrock_outage_with_baked_prompt(self):
        err = ClientError({"Error": {"Code": "ThrottlingException"}}, "ListPrompts")
        client = _fake_client(prompts=[{"name": "orgiq-search-system-prompt", "id": "P1"}], raises=err)
        pa = ps.PromptedAgent(baked=BAKED, agent_name="search", build=lambda text: f"agent::{text}")
        with mock.patch.object(ps, "_bedrock_agent", return_value=client):
            agent, resolved = pa.get()
        self.assertEqual(resolved.source, "baked")
        self.assertEqual(agent, f"agent::{BAKED}")



class LiveAgentTests(unittest.TestCase):
    def setUp(self):
        ps.reset_cache()
        ps.DISABLED = False

    def _client(self, text):
        return _fake_client(
            prompts=[{"name": "orgiq-search-system-prompt", "id": "P1"}],
            get_result=_prompt_detail(text),
        )

    def test_call_proxies_to_built_agent_and_exposes_sha(self):
        seen = {}

        def build(system_prompt):
            def agent(prompt):
                seen["system"] = system_prompt
                return f"answer::{prompt}"
            return agent

        la = ps.LiveAgent(baked=BAKED, agent_name="search", build=build)
        with mock.patch.object(ps, "_bedrock_agent", return_value=self._client(LIVE)):
            out = la("hello")
            self.assertEqual(la.prompt_sha, ps.prompt_sha(LIVE))
            self.assertEqual(la.prompt_source, "bedrock")
        self.assertEqual(out, "answer::hello")
        self.assertEqual(seen["system"], LIVE)

    def test_attribute_proxy(self):
        class _A:
            name = "strands-agent"

            def __call__(self, p):
                return p

        la = ps.LiveAgent(baked=BAKED, agent_name="search", build=lambda _t: _A())
        with mock.patch.object(ps, "_bedrock_agent", return_value=self._client(LIVE)):
            self.assertEqual(la.name, "strands-agent")

    def test_prompt_sha_matches_prompt_used_in_same_run(self):
        la = ps.LiveAgent(baked=BAKED, agent_name="search", build=lambda t: (lambda _p: t))
        with mock.patch.object(ps, "_bedrock_agent", return_value=self._client(LIVE)):
            sha_before = la.prompt_sha           # read as tracing does
            used_text = la("q")                  # then invoked
        self.assertEqual(sha_before, ps.prompt_sha(used_text))

if __name__ == "__main__":
    unittest.main(verbosity=2)
