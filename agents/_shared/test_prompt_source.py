"""Unit tests for prompt_source — stdlib unittest, no network.

Run:  python -m unittest agents._shared.test_prompt_source  (from repo root)
or:   cd agents/_shared && python -m unittest test_prompt_source
"""

from __future__ import annotations

import importlib
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
        self.assertEqual(ps.default_prompt_name("graph_builder"), "orgiq-graph-builder-system-prompt")

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

# ── Documented hazards the tests above do not reach ──────────────────────────


def _paged_client(pages, get_result=None):
    """bedrock-agent stand-in whose ListPrompts is genuinely multi-page.

    ``client.list_prompts`` (the UN-paginated call) is wired to return ONLY the
    first page, so a regression away from the paginator resolves nothing and
    the test fails instead of passing on a lucky one-page fixture.
    """
    client = mock.Mock()

    class _Paginator:
        def paginate(self):
            for page in pages:
                yield {"promptSummaries": page}

    client.get_paginator.return_value = _Paginator()
    client.list_prompts.return_value = {"promptSummaries": pages[0]}
    client.get_prompt.return_value = get_result or {}
    return client


class PaginationTests(unittest.TestCase):
    """CLAUDE.md: "ListPrompts must be paginated: the un-paginated call returns
    only the first page and silently misses prompts." Silently is the problem —
    the agent falls back to its baked literal and looks perfectly healthy while
    every Prompt Studio edit is ignored."""

    def setUp(self):
        ps.reset_cache()
        ps.DISABLED = False
        os.environ.pop("SYSTEM_PROMPT_NAME", None)
        os.environ.pop("SYSTEM_PROMPT_VERSION", None)

    def test_finds_a_prompt_on_a_later_page(self):
        client = _paged_client(
            pages=[
                [{"name": "orgiq-advisor-system-prompt", "id": "P1"}],
                [{"name": "orgiq-ingestion-system-prompt", "id": "P2"}],
                [{"name": "orgiq-search-system-prompt", "id": "P3"}],
            ],
            get_result=_prompt_detail(LIVE),
        )
        with mock.patch.object(ps, "_bedrock_agent", return_value=client):
            got = ps.resolve_system_prompt(BAKED, agent_name="search")
        self.assertEqual(got.text, LIVE)
        self.assertEqual(got.source, "bedrock")
        client.get_prompt.assert_called_once()
        self.assertEqual(client.get_prompt.call_args.kwargs["promptIdentifier"], "P3")
        client.list_prompts.assert_not_called()

    def test_uses_the_paginator_not_the_bare_call(self):
        client = _paged_client(
            pages=[[{"name": "orgiq-search-system-prompt", "id": "P1"}]],
            get_result=_prompt_detail(LIVE),
        )
        with mock.patch.object(ps, "_bedrock_agent", return_value=client):
            ps.resolve_system_prompt(BAKED, agent_name="search")
        client.get_paginator.assert_called_once_with("list_prompts")

    def test_a_prompt_missing_from_every_page_falls_back(self):
        client = _paged_client(
            pages=[[{"name": "orgiq-advisor-system-prompt", "id": "P1"}], []],
        )
        with mock.patch.object(ps, "_bedrock_agent", return_value=client):
            got = ps.resolve_system_prompt(BAKED, agent_name="search")
        self.assertEqual(got.source, "baked")
        client.get_prompt.assert_not_called()

    def test_listprompts_failure_falls_back_rather_than_raising(self):
        client = mock.Mock()
        client.get_paginator.side_effect = ClientError(
            {"Error": {"Code": "AccessDeniedException"}}, "ListPrompts"
        )
        with mock.patch.object(ps, "_bedrock_agent", return_value=client):
            got = ps.resolve_system_prompt(BAKED, agent_name="search")
        self.assertEqual(got.text, BAKED)


class CacheTtlTests(unittest.TestCase):
    """The cache is what keeps this cheap enough to call per invocation; the
    TTL is what makes a Prompt Studio edit reach the fleet in ~a minute without
    a redeploy. Both halves are behaviour, not incidental."""

    def setUp(self):
        ps.reset_cache()
        ps.DISABLED = False
        self._refresh = ps.REFRESH_S
        self.addCleanup(lambda: setattr(ps, "REFRESH_S", self._refresh))

    def _client(self, text=LIVE):
        return _fake_client(
            prompts=[{"name": "orgiq-search-system-prompt", "id": "P1"}],
            get_result=_prompt_detail(text),
        )

    def test_default_ttl_is_sixty_seconds(self):
        self.assertEqual(self._refresh, 60)

    def test_a_hot_cache_serves_without_touching_bedrock(self):
        client = self._client()
        ps.REFRESH_S = 3600
        with mock.patch.object(ps, "_bedrock_agent", return_value=client):
            for _ in range(20):
                ps.resolve_system_prompt(BAKED, agent_name="search")
        self.assertEqual(client.get_prompt.call_count, 1)

    def test_an_expired_entry_is_refetched(self):
        client = self._client()
        ps.REFRESH_S = -1  # everything is already stale
        with mock.patch.object(ps, "_bedrock_agent", return_value=client):
            ps.resolve_system_prompt(BAKED, agent_name="search")
            ps.resolve_system_prompt(BAKED, agent_name="search")
        self.assertEqual(client.get_prompt.call_count, 2)

    def test_a_fallback_is_cached_too_so_an_outage_is_not_amplified(self):
        # An agent under load resolves per invocation. If the failure path
        # re-queried every time, a throttled control plane would be hammered
        # by the whole fleet at request rate.
        err = ClientError({"Error": {"Code": "ThrottlingException"}}, "GetPrompt")
        client = _fake_client(
            prompts=[{"name": "orgiq-search-system-prompt", "id": "P1"}], raises=err
        )
        ps.REFRESH_S = 3600
        with mock.patch.object(ps, "_bedrock_agent", return_value=client):
            for _ in range(5):
                got = ps.resolve_system_prompt(BAKED, agent_name="search")
        self.assertEqual(got.source, "baked")
        self.assertEqual(client.get_prompt.call_count, 1)


class VersionPinTests(unittest.TestCase):
    def setUp(self):
        ps.reset_cache()
        ps.DISABLED = False
        os.environ.pop("SYSTEM_PROMPT_VERSION", None)
        self.addCleanup(lambda: os.environ.pop("SYSTEM_PROMPT_VERSION", None))
        self.client = _fake_client(
            prompts=[{"name": "orgiq-search-system-prompt", "id": "P1"}],
            get_result=_prompt_detail(LIVE, version="3"),
        )

    def test_unset_version_reads_the_draft_working_copy(self):
        # No promptVersion kwarg == DRAFT, which is the whole reason a studio
        # edit applies without cutting a version.
        with mock.patch.object(ps, "_bedrock_agent", return_value=self.client):
            ps.resolve_system_prompt(BAKED, agent_name="search")
        self.assertNotIn("promptVersion", self.client.get_prompt.call_args.kwargs)

    def test_the_literal_string_DRAFT_is_also_not_sent(self):
        os.environ["SYSTEM_PROMPT_VERSION"] = "draft"
        with mock.patch.object(ps, "_bedrock_agent", return_value=self.client):
            ps.resolve_system_prompt(BAKED, agent_name="search")
        self.assertNotIn("promptVersion", self.client.get_prompt.call_args.kwargs)

    def test_a_numbered_version_pins_the_fetch(self):
        os.environ["SYSTEM_PROMPT_VERSION"] = "3"
        with mock.patch.object(ps, "_bedrock_agent", return_value=self.client):
            got = ps.resolve_system_prompt(BAKED, agent_name="search")
        self.assertEqual(self.client.get_prompt.call_args.kwargs["promptVersion"], "3")
        self.assertEqual(got.version, "3")


class VariantSelectionTests(unittest.TestCase):
    def setUp(self):
        ps.reset_cache()
        ps.DISABLED = False

    def _resolve(self, detail):
        client = _fake_client(
            prompts=[{"name": "orgiq-search-system-prompt", "id": "P1"}],
            get_result=detail,
        )
        with mock.patch.object(ps, "_bedrock_agent", return_value=client):
            return ps.resolve_system_prompt(BAKED, agent_name="search")

    def test_the_named_default_variant_wins_over_the_first(self):
        detail = {
            "version": "DRAFT",
            "defaultVariant": "b",
            "variants": [
                {"name": "a", "templateConfiguration": {"text": {"text": "variant A"}}},
                {"name": "b", "templateConfiguration": {"text": {"text": LIVE}}},
            ],
        }
        self.assertEqual(self._resolve(detail).text, LIVE)

    def test_an_unmatched_default_falls_back_to_the_first_variant(self):
        detail = {
            "version": "DRAFT",
            "defaultVariant": "gone",
            "variants": [
                {"name": "a", "templateConfiguration": {"text": {"text": LIVE}}},
            ],
        }
        self.assertEqual(self._resolve(detail).text, LIVE)

    def test_no_variants_at_all_falls_back_to_baked(self):
        self.assertEqual(
            self._resolve({"version": "DRAFT", "variants": []}).source, "baked"
        )

    def test_a_malformed_template_config_falls_back_to_baked(self):
        detail = {
            "version": "DRAFT",
            "defaultVariant": "a",
            "variants": [{"name": "a", "templateConfiguration": {"chat": {}}}],
        }
        self.assertEqual(self._resolve(detail).source, "baked")


class UnexpandedVariableTests(unittest.TestCase):
    """A system prompt is finished text — there is no substitution step on this
    path. A ``{{tenant}}`` that survives to the model ships the braces verbatim
    and quietly means something other than what its author wrote, so the
    mistake is made loud rather than guessed at."""

    def setUp(self):
        ps.reset_cache()
        ps.DISABLED = False

    def test_finds_placeholders_and_deduplicates(self):
        # Deduplication is on the literal matched text, so two spellings of the
        # same variable are reported separately — which is the right answer for
        # a warning whose job is to show the author exactly what they wrote.
        self.assertEqual(
            ps.unexpanded_variables("Hi {{tenant}}, you are {{role}} in {{tenant}}."),
            ["{{role}}", "{{tenant}}"],
        )
        self.assertEqual(
            ps.unexpanded_variables("{{ tenant }} and {{tenant}}"),
            ["{{ tenant }}", "{{tenant}}"],
        )

    def test_clean_text_reports_nothing(self):
        self.assertEqual(ps.unexpanded_variables("You are the Search agent."), [])

    def test_a_template_is_still_served_but_warns(self):
        # Loud, not fatal: a half-templated live prompt is still closer to what
        # its author meant than a stale baked literal.
        text = "You are the {{agent}} agent."
        client = _fake_client(
            prompts=[{"name": "orgiq-search-system-prompt", "id": "P1"}],
            get_result=_prompt_detail(text),
        )
        with mock.patch.object(ps, "_bedrock_agent", return_value=client):
            with self.assertLogs(ps.log, level="WARNING") as logs:
                got = ps.resolve_system_prompt(BAKED, agent_name="search")
        self.assertEqual(got.text, text)
        self.assertIn("{{agent}}", "\n".join(logs.output))


class EnvContractTests(unittest.TestCase):
    """These four env vars are read at import, so the only honest test is to
    re-import the module with them set."""

    def _reload(self, **env):
        with mock.patch.dict(os.environ, env, clear=False):
            for key, value in env.items():
                if value is None:
                    os.environ.pop(key, None)
            importlib.reload(ps)

    def tearDown(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            for key in ("PROMPT_SOURCE_DISABLED", "PROMPT_REFRESH_S"):
                os.environ.pop(key, None)
            importlib.reload(ps)
        ps.reset_cache()

    def test_kill_switch_reads_PROMPT_SOURCE_DISABLED(self):
        self._reload(PROMPT_SOURCE_DISABLED="1")
        self.assertTrue(ps.DISABLED)

    def test_only_the_exact_value_1_arms_the_kill_switch(self):
        # A half-on kill switch is worse than none: "true" looking like "off"
        # would leave an operator convinced the fleet was pinned when it wasn't.
        for value in ("true", "yes", "0", "", "TRUE"):
            self._reload(PROMPT_SOURCE_DISABLED=value)
            self.assertFalse(ps.DISABLED, value)

    def test_refresh_interval_reads_PROMPT_REFRESH_S(self):
        self._reload(PROMPT_REFRESH_S="5")
        self.assertEqual(ps.REFRESH_S, 5)

    def test_kill_switch_pins_the_baked_literal_and_skips_bedrock(self):
        self._reload(PROMPT_SOURCE_DISABLED="1")
        with mock.patch.object(ps, "_bedrock_agent") as client:
            got = ps.resolve_system_prompt(BAKED, agent_name="search")
        self.assertEqual(got.text, BAKED)
        self.assertEqual(got.source, "baked")
        self.assertFalse(got.is_live)
        client.assert_not_called()


class NoAgentNameTests(unittest.TestCase):
    def setUp(self):
        ps.reset_cache()
        ps.DISABLED = False

    def test_an_unnameable_agent_uses_the_baked_prompt_without_calling_bedrock(self):
        # AGENT_NAME unset and no explicit name: there is nothing to look up,
        # and a wildcard guess would serve another agent's prompt.
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("AGENT_NAME", None)
            os.environ.pop("SYSTEM_PROMPT_NAME", None)
            self.assertEqual(ps.default_prompt_name(), "")
            with mock.patch.object(ps, "_bedrock_agent") as client:
                got = ps.resolve_system_prompt(BAKED)
            self.assertEqual(got.source, "baked")
            client.assert_not_called()

    def test_agent_name_env_is_used_when_no_argument_is_given(self):
        with mock.patch.dict(os.environ, {"AGENT_NAME": "scoring"}, clear=False):
            os.environ.pop("SYSTEM_PROMPT_NAME", None)
            self.assertEqual(ps.default_prompt_name(), "orgiq-scoring-system-prompt")


if __name__ == "__main__":
    unittest.main(verbosity=2)



# ── DE-4: pointer-based reads and promotion arms ────────────────────────────

import json  # noqa: E402
import random  # noqa: E402

POINTER_ENV = ("SYSTEM_PROMPT_POINTER", "SYSTEM_PROMPT_VERSION", "SYSTEM_PROMPT_NAME", "APP_ENV", "AGENT_NAME")
LIVE_7 = "Live version seven."
CAND_8 = "Candidate version eight."


def _fake_ssm(values=None, raises=None):
    """SSM stand-in: get_parameters returns only the names present in `values`."""
    client = mock.Mock()
    values = values or {}
    if raises is not None:
        client.get_parameters.side_effect = raises
    else:
        def _get(Names):
            present = [{"Name": n, "Value": values[n]} for n in Names if n in values]
            missing = [n for n in Names if n not in values]
            return {"Parameters": present, "InvalidParameters": missing}
        client.get_parameters.side_effect = _get
    return client


def _versioned_bedrock(texts):
    """bedrock-agent stand-in whose get_prompt answers by (promptIdentifier, promptVersion)."""
    client = mock.Mock()

    def _get(promptIdentifier, promptVersion=None):
        key = (promptIdentifier, promptVersion or "DRAFT")
        if key not in texts:
            raise ClientError({"Error": {"Code": "ResourceNotFoundException"}}, "GetPrompt")
        return _prompt_detail(texts[key], version=key[1])

    client.get_prompt.side_effect = _get
    client.get_paginator.side_effect = AssertionError("ListPrompts must not be called when a pointer is present")
    return client


class PointerTests(unittest.TestCase):
    def setUp(self):
        self._saved = {k: os.environ.pop(k, None) for k in POINTER_ENV}
        ps.reset_cache()
        ps.DISABLED = False
        os.environ["SYSTEM_PROMPT_POINTER"] = "/orgiq/prompts/search"
        self.live = json.dumps({"promptId": "PSEARCH", "version": "7"})
        self.cand = json.dumps({"promptId": "PSEARCH", "version": "8", "weight": 25})
        self.bedrock = _versioned_bedrock({("PSEARCH", "7"): LIVE_7, ("PSEARCH", "8"): CAND_8})

    def tearDown(self):
        for k in POINTER_ENV:
            os.environ.pop(k, None)
            if self._saved[k] is not None:
                os.environ[k] = self._saved[k]
        ps.reset_cache()
        ps._rng = random.Random()

    def _resolve(self, ssm):
        with mock.patch.object(ps, "_ssm", return_value=ssm), \
                mock.patch.object(ps, "_bedrock_agent", return_value=self.bedrock):
            return ps.resolve_system_prompt(BAKED, agent_name="search")

    def test_live_pointer_resolves_the_numbered_version_by_id(self):
        ssm = _fake_ssm({"/orgiq/prompts/search/live": self.live})
        got = self._resolve(ssm)
        self.assertEqual(got.text, LIVE_7)
        self.assertEqual(got.source, "bedrock")
        self.assertEqual(got.version, "7")
        self.assertEqual(got.version_number, "7")
        self.assertEqual(got.arm, "live")
        self.assertEqual(got.prompt_id, "PSEARCH")
        self.bedrock.get_prompt.assert_called_once_with(promptIdentifier="PSEARCH", promptVersion="7")
        # One GetParameters for both arms, and the pointer carried the id.
        ssm.get_parameters.assert_called_once_with(
            Names=["/orgiq/prompts/search/live", "/orgiq/prompts/search/candidate"])
        self.bedrock.get_paginator.assert_not_called()

    def test_no_list_prompts_when_a_pointer_is_present(self):
        ssm = _fake_ssm({"/orgiq/prompts/search/live": self.live,
                         "/orgiq/prompts/search/candidate": self.cand})
        for _ in range(20):
            self._resolve(ssm)
        self.bedrock.get_paginator.assert_not_called()
        self.assertFalse(any("list_prompts" in str(c) for c in self.bedrock.mock_calls))

    def test_candidate_weight_splits_traffic_with_a_seeded_rng(self):
        ssm = _fake_ssm({"/orgiq/prompts/search/live": self.live,
                         "/orgiq/prompts/search/candidate": self.cand})
        ps._rng = random.Random(7)
        draws = random.Random(7)
        expected = ["candidate" if draws.random() * 100 < 25 else "live" for _ in range(40)]
        arms = [self._resolve(ssm).arm for _ in range(40)]
        self.assertEqual(arms, expected, "the same seed must give the same sequence of arms")
        self.assertIn("candidate", arms)
        self.assertIn("live", arms)
        # Each arm's text was fetched once; the split never refetches.
        self.assertEqual(self.bedrock.get_prompt.call_count, 2)

    def test_candidate_text_matches_its_arm(self):
        ssm = _fake_ssm({"/orgiq/prompts/search/live": self.live,
                         "/orgiq/prompts/search/candidate": self.cand})
        ps._rng = random.Random(3)
        seen = {}
        for _ in range(40):
            got = self._resolve(ssm)
            seen[got.arm] = got.text
        self.assertEqual(seen, {"live": LIVE_7, "candidate": CAND_8})

    def test_weight_zero_and_absent_candidate_serve_live_only(self):
        for cand in (None, json.dumps({"promptId": "PSEARCH", "version": "8", "weight": 0})):
            ps.reset_cache()
            values = {"/orgiq/prompts/search/live": self.live}
            if cand:
                values["/orgiq/prompts/search/candidate"] = cand
            ssm = _fake_ssm(values)
            arms = {self._resolve(ssm).arm for _ in range(30)}
            self.assertEqual(arms, {"live"})

    def test_pointer_read_failure_falls_back_to_baked_and_is_cached(self):
        err = ClientError({"Error": {"Code": "AccessDeniedException"}}, "GetParameters")
        ssm = _fake_ssm(raises=err)
        got = self._resolve(ssm)
        self.assertEqual(got.text, BAKED)
        self.assertEqual(got.source, "baked")
        self.assertEqual(self._resolve(ssm).text, BAKED)
        self.assertEqual(ssm.get_parameters.call_count, 1, "an outage costs one call per refresh, not per run")
        self.bedrock.get_prompt.assert_not_called()

    def test_missing_pointers_fall_back_to_baked(self):
        got = self._resolve(_fake_ssm({}))
        self.assertEqual(got.source, "baked")
        self.bedrock.get_prompt.assert_not_called()

    def test_malformed_pointer_is_treated_as_absent(self):
        for raw in ("not json", "[]", json.dumps({"version": "7"}), json.dumps({"promptId": "P", "version": "v7"}),
                    json.dumps({"promptId": "P", "version": "7", "weight": 250})):
            ps.reset_cache()
            got = self._resolve(_fake_ssm({"/orgiq/prompts/search/live": raw,
                                           "/orgiq/prompts/search/candidate": raw}))
            self.assertEqual(got.source, "baked", raw)

    def test_version_fetch_failure_falls_back_to_baked(self):
        ssm = _fake_ssm({"/orgiq/prompts/search/live": json.dumps({"promptId": "PSEARCH", "version": "99"})})
        got = self._resolve(ssm)
        self.assertEqual(got.source, "baked")
        self.assertEqual(got.arm, "live")

    def test_hard_pin_wins_over_the_pointer_versions_and_weight(self):
        os.environ["SYSTEM_PROMPT_VERSION"] = "7"
        cand100 = json.dumps({"promptId": "PSEARCH", "version": "8", "weight": 100})
        ssm = _fake_ssm({"/orgiq/prompts/search/live": self.live, "/orgiq/prompts/search/candidate": cand100})
        got = self._resolve(ssm)
        self.assertEqual(got.text, LIVE_7)
        self.assertEqual(got.arm, "pinned")

    def test_draft_pointer_is_refused_in_production(self):
        os.environ["APP_ENV"] = "production"
        self.bedrock = _versioned_bedrock({("PSEARCH", "DRAFT"): "draft text"})
        ssm = _fake_ssm({"/orgiq/prompts/search/live": json.dumps({"promptId": "PSEARCH", "version": "DRAFT"})})
        got = self._resolve(ssm)
        self.assertEqual(got.source, "baked")
        self.bedrock.get_prompt.assert_not_called()

    def test_draft_pointer_is_served_outside_production(self):
        self.bedrock = _versioned_bedrock({("PSEARCH", "DRAFT"): "draft text"})
        ssm = _fake_ssm({"/orgiq/prompts/search/live": json.dumps({"promptId": "PSEARCH", "version": "DRAFT"})})
        got = self._resolve(ssm)
        self.assertEqual(got.text, "draft text")
        self.assertEqual(got.version_number, "")
        self._resolve(ssm)
        self.assertEqual(self.bedrock.get_prompt.call_count, 1, "DRAFT text is TTL-cached like a name lookup")

    def test_trace_attributes_carry_version_and_arm(self):
        ssm = _fake_ssm({"/orgiq/prompts/search/live": self.live})
        got = self._resolve(ssm)
        self.assertEqual(ps.trace_attributes(got), {"orgiq.prompt_version_number": "7", "orgiq.prompt_arm": "live"})
        baked = ps.ResolvedPrompt(text=BAKED, source="baked", version="", sha=ps.prompt_sha(BAKED))
        self.assertEqual(ps.trace_attributes(baked), {})
        self.assertEqual(ps.trace_attributes(None), {})

    def test_prompted_agent_keeps_both_arms_built(self):
        ssm = _fake_ssm({"/orgiq/prompts/search/live": self.live,
                         "/orgiq/prompts/search/candidate": self.cand})
        ps._rng = random.Random(11)
        builds = []
        pa = ps.PromptedAgent(baked=BAKED, agent_name="search",
                              build=lambda text: builds.append(text) or f"agent::{ps.prompt_sha(text)}")
        with mock.patch.object(ps, "_ssm", return_value=ssm), \
                mock.patch.object(ps, "_bedrock_agent", return_value=self.bedrock):
            pairs = [pa.get() for _ in range(40)]
        self.assertEqual(sorted(builds), sorted([LIVE_7, CAND_8]), "one build per arm, never per flip")
        for agent, resolved in pairs:
            self.assertEqual(agent, f"agent::{resolved.sha}", "each run gets the agent built for its own text")


class ProductionDraftRefusalTests(unittest.TestCase):
    """Without a pointer, APP_ENV=production never reads DRAFT (DE-4 item 2)."""

    def setUp(self):
        self._saved = {k: os.environ.pop(k, None) for k in POINTER_ENV}
        ps.reset_cache()
        ps.DISABLED = False
        os.environ["APP_ENV"] = "production"
        self.client = _fake_client(
            prompts=[{"name": "orgiq-search-system-prompt", "id": "P1"}],
            get_result=_prompt_detail(LIVE),
        )

    def tearDown(self):
        for k in POINTER_ENV:
            os.environ.pop(k, None)
            if self._saved[k] is not None:
                os.environ[k] = self._saved[k]
        ps.reset_cache()

    def test_unset_version_is_refused_and_bedrock_is_not_called(self):
        with mock.patch.object(ps, "_bedrock_agent", return_value=self.client):
            got = ps.resolve_system_prompt(BAKED, agent_name="search")
        self.assertEqual(got.source, "baked")
        self.client.get_prompt.assert_not_called()
        self.client.get_paginator.assert_not_called()

    def test_explicit_DRAFT_is_refused_too(self):
        os.environ["SYSTEM_PROMPT_VERSION"] = "DRAFT"
        with mock.patch.object(ps, "_bedrock_agent", return_value=self.client):
            got = ps.resolve_system_prompt(BAKED, agent_name="search")
        self.assertEqual(got.source, "baked")
        self.client.get_prompt.assert_not_called()

    def test_a_numbered_pin_still_reads_bedrock_in_production(self):
        os.environ["SYSTEM_PROMPT_VERSION"] = "4"
        self.client.get_prompt.return_value = _prompt_detail(LIVE, version="4")
        with mock.patch.object(ps, "_bedrock_agent", return_value=self.client):
            got = ps.resolve_system_prompt(BAKED, agent_name="search")
        self.assertEqual(got.text, LIVE)
        self.assertEqual(got.version_number, "4")

    def test_outside_production_DRAFT_still_serves(self):
        os.environ["APP_ENV"] = "dev"
        with mock.patch.object(ps, "_bedrock_agent", return_value=self.client):
            got = ps.resolve_system_prompt(BAKED, agent_name="search")
        self.assertEqual(got.text, LIVE)


