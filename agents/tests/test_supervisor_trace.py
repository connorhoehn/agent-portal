"""The supervisor's trace context, and the A2A parent-id it threads.

This is the documented incident (CLAUDE.md): ``_handle_streaming`` originally
never called ``_current_ctx.set(...)``, so ``_invoke_sub_agent`` saw an empty
ContextVar, threaded no ``parentInvocationId``, and every sub-agent trace
persisted with ``parent_invocation_id NULL``. The portal drives the *streaming*
path, so ``/api/topology/a2a`` could never return an edge for real user traffic
while the sync path — the one an A2A caller uses — looked perfectly healthy.

The asymmetry is the bug. Every behaviour here is therefore asserted against
**both** handlers, driven through the real ``handle()`` entrypoint so the
streaming/non-streaming dispatch is part of what is pinned.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agui_harness import (  # noqa: E402
    SupervisorTestCase,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    RunFinishedEvent,
)

RUNTIMES = ("orgiq_search", "orgiq_scoring", "orgiq_advisor")


class ParentInvocationIdTests(SupervisorTestCase):
    """A sub-agent call made from inside a run carries the parent's id."""

    def setUp(self):
        super().setUp()
        self.control, self.runtime = self.use_runtime(*RUNTIMES)

    # ── streaming (what the portal uses) ──

    def test_streaming_threads_the_parent_invocation_id(self):
        agent, ag_ui, _ = self.prewarm()
        ag_ui.script = [
            TextMessageStartEvent(message_id="m1"),
            lambda: self.sup.search_organization("who knows auth"),
            TextMessageContentEvent(message_id="m1", delta="Ana does."),
            TextMessageEndEvent(message_id="m1"),
            RunFinishedEvent(),
        ]

        events, _, err = self.invoke({"input_text": "who knows auth", "stream": True})

        self.assertIsNone(err)
        self.assertEqual(len(self.runtime.calls), 1, "the sub-agent was never invoked")
        parent = self.runtime.last_payload.get("parentInvocationId")
        self.assertTrue(parent, "streaming path threaded no parentInvocationId — the 2026 incident")
        self.assertEqual(parent, self.traces[-1]["invocationId"])
        self.assertTrue(events)

    def test_sync_threads_the_parent_invocation_id(self):
        agent, _, _ = self.prewarm()
        agent.respond = lambda prompt, **kw: self.sup.search_organization(prompt)

        _, result, err = self.invoke({"input_text": "who knows auth"})

        self.assertIsNone(err)
        parent = self.runtime.last_payload.get("parentInvocationId")
        self.assertEqual(parent, result["invocationId"])
        self.assertEqual(parent, self.traces[-1]["invocationId"])

    def test_both_handlers_thread_a_parent_id(self):
        """The regression guard, stated as one assertion.

        Whatever else changes, neither handler may be the one that forgets.
        """
        seen = {}

        agent, ag_ui, _ = self.prewarm()
        ag_ui.script = [lambda: self.sup.search_organization("q"), RunFinishedEvent()]
        self.invoke({"input_text": "q", "stream": True})
        seen["streaming"] = self.runtime.last_payload.get("parentInvocationId")

        agent.respond = lambda prompt, **kw: self.sup.search_organization(prompt)
        self.invoke({"input_text": "q"})
        seen["sync"] = self.runtime.last_payload.get("parentInvocationId")

        self.assertTrue(all(seen.values()), f"a handler threaded no parent id: {seen}")
        self.assertNotEqual(
            seen["streaming"], seen["sync"],
            "two separate runs must not share one invocation id",
        )

    # ── what rides along with the parent id ──

    def test_user_and_session_ride_along_to_the_sub_agent(self):
        agent, ag_ui, _ = self.prewarm()
        ag_ui.script = [lambda: self.sup.search_organization("q"), RunFinishedEvent()]

        self.invoke({
            "input_text": "q",
            "stream": True,
            "userId": "u-42",
            "sessionId": "s-99",
        })

        payload = self.runtime.last_payload
        self.assertEqual(payload["userId"], "u-42")
        self.assertEqual(payload["sessionId"], "s-99")
        self.assertEqual(payload["input_text"], "q")

    def test_a_sub_agent_call_outside_any_run_threads_no_parent(self):
        """Direct tool use with no active context must not invent a parent —
        a fabricated edge is worse than a missing one."""
        self.sup.search_organization("q")
        self.assertNotIn("parentInvocationId", self.runtime.last_payload)

    def test_the_context_does_not_leak_past_the_stream(self):
        """The ContextVar is reset in `finally`, so a later tool call made
        outside the run cannot attach itself to the finished invocation."""
        _, ag_ui, _ = self.prewarm()
        ag_ui.script = [lambda: self.sup.search_organization("inside"), RunFinishedEvent()]
        self.invoke({"input_text": "q", "stream": True})
        inside = self.runtime.last_payload.get("parentInvocationId")
        self.assertTrue(inside)

        self.sup.search_organization("outside")
        self.assertNotIn("parentInvocationId", self.runtime.last_payload)

    def test_an_undeployed_sub_agent_reports_rather_than_invoking(self):
        self.use_runtime()  # no runtimes at all
        out = self.sup.search_organization("q")
        self.assertIn("not deployed", out)

    def test_a_sub_agent_transport_failure_is_returned_not_raised(self):
        _, runtime = self.use_runtime(*RUNTIMES, raises=RuntimeError("throttled"))
        out = self.sup.search_organization("q")
        self.assertIn("Sub-agent invocation failed", out)
        self.assertIn("throttled", out)

    def test_runtime_arn_lookup_is_cached_across_calls(self):
        self.sup.search_organization("a")
        self.sup.search_organization("b")
        self.assertEqual(self.control.list_calls, 1)


class ToolSurfaceTests(SupervisorTestCase):
    """What the supervisor is allowed to route to.

    The middleware gates *direct* invocation of the three write agents on
    `ManageIngest` and leaves the supervisor ungated, because reading through
    the fleet is fine. That split only holds while the supervisor cannot reach
    a writer: hand it `ingest_documents` or `build_graph` as a registered tool
    and any member can ask it, in English, to sync the knowledge base — the
    capability check bypassed by routing around it.
    """

    WRITE_TOOLS = {"ingest_documents", "build_graph"}

    def test_the_supervisor_routes_only_to_read_agents(self):
        names = {t.__name__ for t in self.sup.SUPERVISOR_TOOLS}
        self.assertEqual(
            names,
            {"search_organization", "get_expertise_scores", "get_strategic_advice"},
        )

    def test_no_write_agent_is_reachable_through_the_supervisor(self):
        names = {t.__name__ for t in self.sup.SUPERVISOR_TOOLS}
        leaked = names & self.WRITE_TOOLS
        self.assertEqual(
            leaked, set(),
            f"{leaked} would let an ungated supervisor turn bypass ManageIngest",
        )

    def test_the_sandbox_is_not_a_registered_tool_either(self):
        """It executes model-authored Python; it is defined but deliberately
        not wired into the routing surface."""
        names = {t.__name__ for t in self.sup.SUPERVISOR_TOOLS}
        self.assertNotIn("run_in_sandbox", names)

    def test_every_registered_tool_is_instrumented(self):
        """An uninstrumented tool call is a missing A2A edge and a missing row
        in the tool timeline."""
        self.use_runtime("orgiq_search", "orgiq_scoring", "orgiq_advisor")
        _, ag_ui, _ = self.prewarm()
        ag_ui.script = [
            (lambda tool=t: tool("q")) for t in self.sup.SUPERVISOR_TOOLS
        ] + [RunFinishedEvent()]
        self.invoke({"input_text": "q", "stream": True})
        recorded = [tc["toolName"] for tc in self.traces[-1]["toolCalls"]]
        self.assertEqual(recorded, [t.__name__ for t in self.sup.SUPERVISOR_TOOLS])

    def test_the_system_prompt_advertises_exactly_the_registered_tools(self):
        for tool in self.sup.SUPERVISOR_TOOLS:
            self.assertIn(tool.__name__, self.sup.SYSTEM_PROMPT)
        for name in self.WRITE_TOOLS:
            self.assertNotIn(name, self.sup.SYSTEM_PROMPT)


class RunErrorEventTests(SupervisorTestCase):
    """The terminal event must survive an SDK that has moved on."""

    def test_it_builds_a_real_ag_ui_event_when_the_sdk_is_present(self):
        ev = self.sup._run_error_event("boom")
        self.assertEqual(ev.type.value, "RUN_ERROR")
        self.assertEqual(ev.message, "boom")

    def test_it_degrades_to_a_dict_rather_than_emitting_nothing(self):
        import unittest.mock as m

        with m.patch.dict(sys.modules, {"ag_ui.core": None}):
            ev = self.sup._run_error_event("boom")
        self.assertEqual(ev, {"type": "RUN_ERROR", "message": "boom", "code": "supervisor_stream_error"})

    def test_event_type_reads_enums_strings_and_dicts_alike(self):
        from agui_harness import TextMessageContentEvent as T

        self.assertEqual(self.sup._event_type(T(message_id="m", delta="x")), "TEXT_MESSAGE_CONTENT")
        self.assertEqual(self.sup._event_type({"type": "TEXT_MESSAGE_CONTENT"}), "TEXT_MESSAGE_CONTENT")
        self.assertEqual(self.sup._event_type(object()), "")


class IncomingParentTests(SupervisorTestCase):
    """The supervisor is itself a sub-agent sometimes: an inbound
    parentInvocationId must survive onto its own trace, and NOT be forwarded
    as its children's parent (that would flatten the tree by one level)."""

    def setUp(self):
        super().setUp()
        self.control, self.runtime = self.use_runtime(*RUNTIMES)

    def test_inbound_parent_is_recorded_on_the_supervisors_own_trace(self):
        self.invoke({"input_text": "q", "parentInvocationId": "caller-1"})
        self.assertEqual(self.traces[-1]["parentInvocationId"], "caller-1")

    def test_children_get_the_supervisors_id_not_the_callers(self):
        agent, _, _ = self.prewarm()
        agent.respond = lambda prompt, **kw: self.sup.search_organization(prompt)

        _, result, _ = self.invoke({"input_text": "q", "parentInvocationId": "caller-1"})

        self.assertEqual(
            self.runtime.last_payload["parentInvocationId"], result["invocationId"]
        )
        self.assertNotEqual(self.runtime.last_payload["parentInvocationId"], "caller-1")

    def test_masquerade_user_id_is_read_from_the_auth_block(self):
        """The middleware puts the effective user under `auth.userId` when
        masquerading; the trace must name the effective user, not nobody."""
        self.invoke({"input_text": "q", "auth": {"role": "member", "userId": "u-target"}})
        self.assertEqual(self.traces[-1]["userId"], "u-target")


class TraceBundleTests(SupervisorTestCase):
    """What the supervisor persists after a run, on both paths."""

    def setUp(self):
        super().setUp()
        self.use_runtime(*RUNTIMES)

    def test_streaming_persists_exactly_one_root_trace(self):
        self.invoke({"input_text": "hello", "stream": True})
        self.assertEqual(len(self.traces), 1)
        b = self.traces[0]
        self.assertEqual(b["agentId"], "orgiq-supervisor")
        self.assertEqual(b["agentName"], "Supervisor")
        self.assertEqual(b["prompt"], "hello")

    def test_sync_persists_exactly_one_root_trace(self):
        self.invoke({"input_text": "hello"})
        self.assertEqual(len(self.traces), 1)
        self.assertEqual(self.traces[0]["agentId"], "orgiq-supervisor")

    def test_the_model_id_recorded_is_the_one_the_agent_runs(self):
        for payload in ({"input_text": "q"}, {"input_text": "q", "stream": True}):
            with self.subTest(stream=payload.get("stream", False)):
                self.traces.clear()
                self.invoke(payload)
                self.assertEqual(self.traces[-1]["modelId"], self.sup.MODEL_ID)

    def test_the_recorded_model_is_aws_native(self):
        """The eight OrgIQ agents never run an Anthropic model; the devbox is
        the documented exception and is not this agent."""
        self.assertFalse(self.sup.MODEL_ID.startswith("anthropic."))
        self.assertNotIn("anthropic", self.sup.MODEL_ID)

    def test_duration_is_recorded_on_both_paths(self):
        for payload in ({"input_text": "q"}, {"input_text": "q", "stream": True}):
            with self.subTest(stream=payload.get("stream", False)):
                self.traces.clear()
                self.invoke(payload)
                self.assertIsInstance(self.traces[-1]["durationMs"], int)
                self.assertGreaterEqual(self.traces[-1]["durationMs"], 0)

    def test_tool_calls_reach_the_bundle_on_the_streaming_path(self):
        _, ag_ui, _ = self.prewarm()
        ag_ui.script = [lambda: self.sup.search_organization("q"), RunFinishedEvent()]
        self.invoke({"input_text": "q", "stream": True})
        names = [tc["toolName"] for tc in self.traces[-1]["toolCalls"]]
        self.assertEqual(names, ["search_organization"])

    def test_sync_returns_the_projected_tool_timeline(self):
        agent, _, _ = self.prewarm()
        agent.respond = lambda prompt, **kw: self.sup.get_expertise_scores(prompt)
        _, result, _ = self.invoke({"input_text": "q"})
        self.assertEqual([tc["name"] for tc in result["toolCalls"]], ["get_expertise_scores"])

    def test_a_failing_trace_emission_never_breaks_the_run(self):
        """Observability is best-effort by contract."""
        self.sup.post_trace.side_effect = RuntimeError("sink down")
        _, result, err = self.invoke({"input_text": "q"})
        self.assertIsNone(err)
        self.assertEqual(result["agent"], "supervisor")

    def test_a_failing_trace_emission_never_breaks_the_stream(self):
        self.sup.post_trace.side_effect = RuntimeError("sink down")
        events, _, err = self.invoke({"input_text": "q", "stream": True})
        self.assertIsNone(err)
        self.assertTrue(events)


class EntrypointDispatchTests(SupervisorTestCase):
    def setUp(self):
        super().setUp()
        self.use_runtime(*RUNTIMES)

    def test_stream_true_takes_the_streaming_path(self):
        events, result, _ = self.invoke({"input_text": "q", "stream": True})
        self.assertIsNone(result)
        self.assertTrue(events)

    def test_no_stream_flag_takes_the_a2a_sync_path(self):
        events, result, _ = self.invoke({"input_text": "q"})
        self.assertEqual(events, [])
        self.assertEqual(result["agent"], "supervisor")

    def test_ag_ui_streaming_kill_switch_forces_the_sync_path(self):
        self.sup.AG_UI_STREAMING = False
        self.addCleanup(setattr, self.sup, "AG_UI_STREAMING", True)
        _, result, _ = self.invoke({"input_text": "q", "stream": True})
        self.assertIsNotNone(result, "AG_UI_STREAMING=false must fall back to sync")

    def test_prompt_and_message_are_accepted_aliases_for_input_text(self):
        for key in ("input_text", "prompt", "message"):
            with self.subTest(key=key):
                _, result, _ = self.invoke({key: "hello there"})
                self.assertEqual(self.traces[-1]["prompt"], "hello there")

    def test_an_empty_payload_is_rejected_without_spending_a_model_call(self):
        _, result, _ = self.invoke({})
        self.assertIn("error", result)
        self.assertEqual(self.traces, [])


if __name__ == "__main__":
    unittest.main()
