"""One Agent per (tenant, role), and whose prompt it is running.

Two coupled decisions live in ``_agents_for_role``:

*   **The cache key.** The role-specific guardrail is attached at
    model-build time, so the cache key *is* the security boundary. Keyed too
    loosely — by role alone, say — one tenant is served an Agent carrying
    another tenant's guardrail, and nothing downstream would notice: the answer
    still streams, it is just filtered by the wrong policy.
*   **The rebuild trigger.** The system prompt is resolved from Bedrock Prompt
    Management per invocation, and the Agent is rebuilt when the text changes.
    The sha recorded on the trace has to be the sha of the prompt that actually
    served the request, or observability names a prompt nobody ran.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agui_harness import (  # noqa: E402
    SupervisorTestCase,
    fake_bedrock_agent,
    prompt_detail,
)

from botocore.exceptions import ClientError  # noqa: E402
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from _shared.untrusted_text import with_data_rule  # noqa: E402  (the agents append the data rule)


def guardrail_of(agent) -> str:
    return agent.model.kwargs.get("guardrail_id", "")


class CacheKeyTests(SupervisorTestCase):
    def test_the_same_key_returns_the_identical_agent(self):
        a1, ui1, _ = self.prewarm("orgiq", "member")
        a2, ui2, _ = self.prewarm("orgiq", "member")
        self.assertIs(a1, a2)
        self.assertIs(ui1, ui2)

    def test_two_roles_never_share_an_agent(self):
        member, _, _ = self.prewarm("orgiq", "member")
        leader, _, _ = self.prewarm("orgiq", "org-leader")
        self.assertIsNot(member, leader)

    def test_two_roles_never_share_a_guardrail(self):
        member, _, _ = self.prewarm("orgiq", "member")
        leader, _, _ = self.prewarm("orgiq", "org-leader")
        admin, _, _ = self.prewarm("orgiq", "hr-admin")
        self.assertEqual(guardrail_of(member), "gr-member")
        self.assertEqual(guardrail_of(leader), "gr-leader")
        self.assertEqual(guardrail_of(admin), "gr-hradmin")

    def test_a_cache_hit_never_crosses_a_tenant(self):
        """Same role, different tenant — the second call must build its own
        Agent, not hand back the first tenant's."""
        one, ui_one, _ = self.prewarm("orgiq", "member")
        two, ui_two, _ = self.prewarm("assessment", "member")
        self.assertIsNot(one, two)
        self.assertIsNot(ui_one, ui_two)

    def test_the_cache_key_is_exactly_the_tenant_and_the_role(self):
        self.prewarm("orgiq", "member")
        self.prewarm("orgiq", "org-leader")
        self.prewarm("assessment", "member")
        self.assertEqual(
            sorted(self.sup._AGENTS_BY_KEY),
            [("assessment", "member"), ("orgiq", "member"), ("orgiq", "org-leader")],
        )
        self.assertEqual(sorted(self.sup._AG_UI_AGENTS), sorted(self.sup._AGENTS_BY_KEY))

    def test_every_cached_agent_has_its_own_ag_ui_adapter(self):
        for role in ("member", "org-leader", "hr-admin"):
            self.prewarm("orgiq", role)
        adapters = list(self.sup._AG_UI_AGENTS.values())
        self.assertEqual(len({id(a) for a in adapters}), 3)
        for key, agent in self.sup._AGENTS_BY_KEY.items():
            self.assertIs(self.sup._AG_UI_AGENTS[key].agent, agent)


class GuardrailMappingTests(SupervisorTestCase):
    def test_admin_borrows_the_hr_admin_guardrail(self):
        """admin is cross-tenant and has no guardrail of its own; hr-admin's is
        the least restrictive, which is the documented intent."""
        admin, _, _ = self.prewarm("orgiq", "admin")
        self.assertEqual(guardrail_of(admin), "gr-hradmin")

    def test_admin_still_gets_its_own_agent_not_hr_admins(self):
        admin, _, _ = self.prewarm("orgiq", "admin")
        hr, _, _ = self.prewarm("orgiq", "hr-admin")
        self.assertIsNot(admin, hr)

    def test_an_unknown_role_falls_to_the_strictest_guardrail(self):
        """A role the fleet has never heard of must not run unguarded."""
        unknown, _, _ = self.prewarm("orgiq", "not-a-real-role")
        self.assertEqual(guardrail_of(unknown), "gr-member")

    def test_the_guardrail_is_attached_at_model_build_time(self):
        member, _, _ = self.prewarm("orgiq", "member")
        kw = member.model.kwargs
        self.assertEqual(kw["guardrail_id"], "gr-member")
        self.assertEqual(kw["guardrail_version"], "DRAFT")
        self.assertEqual(kw["guardrail_trace"], "enabled")

    def test_the_draft_guardrail_version_means_ui_edits_apply_without_a_rebuild(self):
        _, _, _ = self.prewarm("orgiq", "member")
        self.assertEqual(
            self.sup._model_kwargs("g")["guardrail_version"], "DRAFT",
            "pinning a numbered version would strand every Guardrails UI edit",
        )

    def test_no_guardrail_configured_leaves_the_keys_off_entirely(self):
        """Passing guardrail_id='' would be an invalid Bedrock request; the
        keys have to be absent, not empty."""
        kw = self.sup._model_kwargs("")
        self.assertNotIn("guardrail_id", kw)
        self.assertNotIn("guardrail_version", kw)

    def test_the_model_is_the_configured_aws_native_one(self):
        kw = self.sup._model_kwargs("")
        self.assertEqual(kw["model_id"], self.sup.MODEL_ID)
        self.assertNotIn("anthropic", kw["model_id"])


class IdentityResolutionTests(SupervisorTestCase):
    """How a TRUSTED auth block maps to (tenant, role). Trust here comes from
    the dev-mode path (no AGENT_INVOKE_SECRET, INSECURE_DEV_MODE=true); whether
    a block is trusted at all is test_supervisor_invoke_auth.py's business."""

    def setUp(self):
        super().setUp()
        env = mock.patch.dict("os.environ", {"INSECURE_DEV_MODE": "true", "APP_ENV": "", "NODE_ENV": "",
                                             "AGENT_INVOKE_SECRET": "", "AGENT_INVOKE_SECRET_ID": ""})
        env.start()
        self.addCleanup(env.stop)

    def test_the_auth_block_supplies_the_tenant_and_role(self):
        self.assertEqual(
            self.sup._resolve_identity({"auth": {"tenant": "orgiq", "role": "org-leader"}}),
            ("orgiq", "org-leader"),
        )

    def test_a_missing_auth_block_is_the_least_privileged_identity(self):
        """A payload with no auth means a direct invoke that bypassed the
        middleware — treated as an orgiq member, never trusted."""
        self.assertEqual(self.sup._resolve_identity({}), ("orgiq", "member"))

    def test_an_unknown_tenant_falls_back_rather_than_minting_a_cache_entry(self):
        """A caller-supplied tenant string must not become a cache key, or the
        cache grows without bound on attacker-chosen input."""
        tenant, role = self.sup._resolve_identity({"auth": {"tenant": "../evil", "role": "member"}})
        self.assertEqual(tenant, "orgiq")

    def test_a_non_string_role_falls_back_to_member(self):
        self.assertEqual(
            self.sup._resolve_identity({"auth": {"role": 42}})[1], "member"
        )

    def test_an_unknown_role_keeps_its_name_for_the_cache_but_not_its_guardrail(self):
        _, role = self.sup._resolve_identity({"auth": {"role": "sme"}})
        self.assertEqual(role, "sme")
        agent, _, _ = self.prewarm("orgiq", role)
        self.assertEqual(guardrail_of(agent), "gr-member")

    def test_a_non_dict_auth_block_is_not_trusted(self):
        self.assertEqual(self.sup._resolve_identity({"auth": "admin"}), ("orgiq", "member"))

    def test_the_role_reaches_the_agent_through_the_entrypoint(self):
        self.use_runtime("orgiq_search")
        self.invoke({"input_text": "q", "auth": {"tenant": "orgiq", "role": "org-leader"}})
        self.assertIn(("orgiq", "org-leader"), self.sup._AGENTS_BY_KEY)
        self.assertEqual(
            guardrail_of(self.sup._AGENTS_BY_KEY[("orgiq", "org-leader")]), "gr-leader"
        )

    def test_two_roles_in_one_process_do_not_pollute_each_other(self):
        self.use_runtime("orgiq_search")
        self.invoke({"input_text": "q", "auth": {"role": "member"}})
        self.invoke({"input_text": "q", "auth": {"role": "hr-admin"}})
        self.assertEqual(
            guardrail_of(self.sup._AGENTS_BY_KEY[("orgiq", "member")]), "gr-member"
        )
        self.assertEqual(
            guardrail_of(self.sup._AGENTS_BY_KEY[("orgiq", "hr-admin")]), "gr-hradmin"
        )

    def test_the_sync_response_names_the_role_it_ran_as(self):
        self.use_runtime("orgiq_search")
        _, result, _ = self.invoke({"input_text": "q", "auth": {"role": "hr-admin"}})
        self.assertEqual(result["role"], "hr-admin")


LIVE_PROMPT = "You are the LIVE supervisor prompt, edited in the studio."
NEWER_PROMPT = "You are the NEWER supervisor prompt."


class PromptResolutionTests(SupervisorTestCase):
    """The managed prompt is what the fleet runs; the literal is the airbag."""

    def setUp(self):
        super().setUp()
        self.ps.DISABLED = False
        self.use_runtime("orgiq_search")

    def _with_library(self, text, **kw):
        client = fake_bedrock_agent(
            prompts=[{"name": "orgiq-supervisor-system-prompt", "id": "P1"}],
            detail=prompt_detail(text),
            **kw,
        )
        self.ps.reset_cache()
        return mock.patch.object(self.ps, "_bedrock_agent", return_value=client), client

    def test_the_library_prompt_is_what_the_agent_runs(self):
        patcher, _ = self._with_library(LIVE_PROMPT)
        with patcher:
            agent, _, _ = self.prewarm()
        self.assertEqual(agent.system_prompt, with_data_rule(LIVE_PROMPT))

    def test_the_sha_recorded_is_the_prompt_that_actually_served(self):
        patcher, _ = self._with_library(LIVE_PROMPT)
        with patcher:
            self.invoke({"input_text": "q"})
        self.assertEqual(self.traces[-1]["promptVersion"], self.ps.prompt_sha(LIVE_PROMPT))
        self.assertNotEqual(self.traces[-1]["promptVersion"], self.sup._BAKED_PROMPT_SHA)

    def test_the_streaming_path_records_the_same_resolved_sha(self):
        """Both handlers stamp promptVersion, or observability tells two
        different stories about the same fleet."""
        patcher, _ = self._with_library(LIVE_PROMPT)
        with patcher:
            self.invoke({"input_text": "q", "stream": True})
        self.assertEqual(self.traces[-1]["promptVersion"], self.ps.prompt_sha(LIVE_PROMPT))

    def test_the_looked_up_name_matches_the_seeded_library_entry(self):
        patcher, client = self._with_library(LIVE_PROMPT)
        with patcher:
            self.prewarm()
        self.assertEqual(
            self.ps.default_prompt_name("supervisor"), "orgiq-supervisor-system-prompt"
        )
        self.assertTrue(client.get_prompt.called)

    def test_a_library_outage_falls_back_to_the_literal_and_still_answers(self):
        err = ClientError({"Error": {"Code": "AccessDeniedException"}}, "GetPrompt")
        patcher, _ = self._with_library(LIVE_PROMPT, raises=err)
        with patcher:
            _, result, error = self.invoke({"input_text": "q"})
        self.assertIsNone(error)
        self.assertEqual(result["agent"], "supervisor")
        self.assertEqual(
            self.sup._AGENTS_BY_KEY[("orgiq", "member")].system_prompt,
            with_data_rule(self.sup.SYSTEM_PROMPT),
        )

    def test_the_fallback_records_the_baked_sha_not_a_stale_live_one(self):
        err = ClientError({"Error": {"Code": "ThrottlingException"}}, "GetPrompt")
        patcher, _ = self._with_library(LIVE_PROMPT, raises=err)
        with patcher:
            self.invoke({"input_text": "q"})
        self.assertEqual(self.traces[-1]["promptVersion"], self.sup._BAKED_PROMPT_SHA)

    def test_a_prompt_edit_rebuilds_the_agent_within_the_refresh_window(self):
        patcher, _ = self._with_library(LIVE_PROMPT)
        with patcher:
            first, first_ui, first_sha = self.prewarm()
        patcher2, _ = self._with_library(NEWER_PROMPT)
        with patcher2:
            second, second_ui, second_sha = self.prewarm()

        self.assertIsNot(first, second)
        self.assertEqual(second.system_prompt, with_data_rule(NEWER_PROMPT))
        self.assertNotEqual(first_sha, second_sha)

    def test_a_prompt_edit_also_rebuilds_the_ag_ui_adapter(self):
        """The portal drives the adapter. Rebuilding only the bare Agent would
        leave every streamed turn on the old prompt indefinitely."""
        patcher, _ = self._with_library(LIVE_PROMPT)
        with patcher:
            _, first_ui, _ = self.prewarm()
        patcher2, _ = self._with_library(NEWER_PROMPT)
        with patcher2:
            second_agent, second_ui, _ = self.prewarm()

        self.assertIsNot(first_ui, second_ui)
        self.assertIs(second_ui.agent, second_agent)
        self.assertEqual(second_ui.agent.system_prompt, with_data_rule(NEWER_PROMPT))

    def test_an_unchanged_prompt_does_not_rebuild(self):
        patcher, _ = self._with_library(LIVE_PROMPT)
        with patcher:
            first, first_ui, _ = self.prewarm()
        patcher2, _ = self._with_library(LIVE_PROMPT)
        with patcher2:
            second, second_ui, _ = self.prewarm()
        self.assertIs(first, second)
        self.assertIs(first_ui, second_ui)

    def test_a_rebuild_keeps_each_key_on_its_own_guardrail(self):
        patcher, _ = self._with_library(LIVE_PROMPT)
        with patcher:
            self.prewarm("orgiq", "member")
            self.prewarm("orgiq", "hr-admin")
        patcher2, _ = self._with_library(NEWER_PROMPT)
        with patcher2:
            member, _, _ = self.prewarm("orgiq", "member")
            hr, _, _ = self.prewarm("orgiq", "hr-admin")

        self.assertEqual(guardrail_of(member), "gr-member")
        self.assertEqual(guardrail_of(hr), "gr-hradmin")
        self.assertEqual(member.system_prompt, with_data_rule(NEWER_PROMPT))

    def test_the_kill_switch_pins_the_literal_without_calling_bedrock(self):
        self.ps.DISABLED = True
        patcher, client = self._with_library(LIVE_PROMPT)
        with patcher:
            agent, _, sha = self.prewarm()
        self.assertEqual(agent.system_prompt, with_data_rule(self.sup.SYSTEM_PROMPT))
        self.assertEqual(sha, self.sup._BAKED_PROMPT_SHA)
        client.get_paginator.assert_not_called()

    def test_the_literal_fallback_still_carries_the_citation_rule(self):
        """The baked prompt is a real fallback, not a stub — a live turn once
        cited 'Source: Scoring specialist', i.e. the topology leaking into the
        user's citation line."""
        self.assertIn("never name a tool", self.sup.SYSTEM_PROMPT)
        self.assertIn("CITATIONS", self.sup.SYSTEM_PROMPT)


class ModelRetryTests(SupervisorTestCase):
    """Nova's transient modelStreamErrorException is retried; nothing else is."""

    def setUp(self):
        super().setUp()
        self.use_runtime("orgiq_search")
        patcher = mock.patch.object(self.sup.time, "sleep")
        self.sleep = patcher.start()
        self.addCleanup(patcher.stop)

    def test_a_transient_model_stream_error_is_retried_and_succeeds(self):
        agent, _, _ = self.prewarm()
        calls = {"n": 0}

        def flaky(prompt, **kw):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("modelStreamErrorException: invalid sequence")
            return "recovered"

        agent.respond = flaky
        _, result, err = self.invoke({"input_text": "q"})
        self.assertIsNone(err)
        self.assertEqual(result["response"], "recovered")
        self.assertEqual(calls["n"], 2)

    def test_a_real_error_is_not_retried(self):
        agent, _, _ = self.prewarm()
        calls = {"n": 0}

        def hard_fail(prompt, **kw):
            calls["n"] += 1
            raise ValueError("ValidationException: bad request")

        agent.respond = hard_fail
        with self.assertRaises(ValueError):
            self.invoke({"input_text": "q"})
        self.assertEqual(calls["n"], 1, "a non-transient error must not be retried")

    def test_retries_are_bounded_by_the_configured_attempt_count(self):
        agent, _, _ = self.prewarm()
        calls = {"n": 0}

        def always_flaky(prompt, **kw):
            calls["n"] += 1
            raise RuntimeError("modelStreamErrorException")

        agent.respond = always_flaky
        with self.assertRaises(RuntimeError):
            self.invoke({"input_text": "q"})
        self.assertEqual(calls["n"], self.sup.MODEL_STREAM_RETRY_ATTEMPTS)


class HistoryTests(SupervisorTestCase):
    def setUp(self):
        super().setUp()
        self.use_runtime("orgiq_search")

    def test_sync_history_is_converted_to_the_bedrock_content_shape(self):
        agent, _, _ = self.prewarm()
        self.invoke({
            "input_text": "and now?",
            "history": [{"role": "user", "content": "before"}],
        })
        _, kwargs = agent.calls[-1]
        self.assertEqual(
            kwargs["messages"], [{"role": "user", "content": [{"text": "before"}]}]
        )

    def test_no_history_means_no_messages_kwarg_at_all(self):
        agent, _, _ = self.prewarm()
        self.invoke({"input_text": "hello"})
        _, kwargs = agent.calls[-1]
        self.assertNotIn("messages", kwargs)

    def test_malformed_sync_history_turns_are_dropped(self):
        agent, _, _ = self.prewarm()
        self.invoke({
            "input_text": "q",
            "history": [{"role": "user"}, None, {"role": "user", "content": "kept"}],
        })
        _, kwargs = agent.calls[-1]
        self.assertEqual([m["content"][0]["text"] for m in kwargs["messages"]], ["kept"])


if __name__ == "__main__":
    unittest.main()
