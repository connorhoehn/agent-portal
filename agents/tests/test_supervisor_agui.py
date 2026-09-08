"""The AG-UI contract the portal reads over SSE.

Two kinds of thing are pinned here.

**What the supervisor hands the adapter.** ``RunAgentInput`` is built by hand
from the middleware's payload on every streamed turn, and it has broken twice
in production for the same reason: a required field the SDK grew and the
supervisor did not pass (``Message.id``; then ``state``/``tools``/``context``/
``forwarded_props``). The harness models those as genuinely required, so this
file fails the way the deployed runtime failed.

**What the supervisor hands the portal.** Events are forwarded verbatim, in
order — but the run's *terminal* event is the supervisor's own decision, and a
stream that stops without ever saying it failed is indistinguishable, at the
portal, from a short answer. The middleware only knows a run errored if it sees
``RUN_ERROR`` (``middleware/src/routes/agents.ts:256``); nothing downstream
reconstructs it from a truncated SSE body.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agui_harness import (  # noqa: E402
    AssistantMessage,
    RunFinishedEvent,
    RunStartedEvent,
    SupervisorTestCase,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallStartEvent,
    UserMessage,
)


class RunAgentInputTests(SupervisorTestCase):
    """The input object the supervisor constructs for the adapter."""

    def setUp(self):
        super().setUp()
        self.use_runtime("orgiq_search")

    def _run_input(self, payload):
        payload = {"stream": True, **payload}
        self.invoke(payload)
        return self.latest_agui().runs[-1]

    def test_thread_id_is_the_session_and_run_id_is_the_invocation(self):
        ri = self._run_input({"input_text": "q", "sessionId": "s-1", "invocationId": "inv-1"})
        self.assertEqual(ri.thread_id, "s-1")
        self.assertEqual(ri.run_id, "inv-1")

    def test_a_missing_session_still_yields_a_usable_thread_id(self):
        ri = self._run_input({"input_text": "q"})
        self.assertEqual(ri.thread_id, "default")
        self.assertTrue(ri.run_id)

    def test_an_explicitly_null_session_does_not_produce_a_null_thread_id(self):
        """`{"sessionId": null}` is a shape the middleware can send. `.get(k, d)`
        returns None for it, and None is not a str — the adapter's pydantic
        model rejects the whole run. Absent and null must behave alike."""
        ri = self._run_input({"input_text": "q", "sessionId": None, "invocationId": None})
        self.assertEqual(ri.thread_id, "default")
        self.assertIsInstance(ri.run_id, str)
        self.assertTrue(ri.run_id)

    def test_the_current_user_message_is_last_and_carries_the_input(self):
        ri = self._run_input({"input_text": "who knows auth"})
        self.assertEqual(ri.messages[-1].role, "user")
        self.assertEqual(ri.messages[-1].content, "who knows auth")

    def test_every_message_carries_an_id(self):
        """ag-ui-protocol >= 0.1.x makes `id` required; omitting it was a
        pydantic ValidationError that killed the invocation outright."""
        ri = self._run_input({
            "input_text": "now",
            "history": [
                {"role": "user", "content": "before"},
                {"role": "assistant", "content": "answer"},
            ],
        })
        self.assertEqual(len(ri.messages), 3)
        for m in ri.messages:
            self.assertTrue(m.id, f"message with no id: {m}")
        self.assertEqual(len({m.id for m in ri.messages}), 3, "message ids collide")

    def test_history_roles_map_to_the_right_message_classes(self):
        ri = self._run_input({
            "input_text": "now",
            "history": [
                {"role": "user", "content": "before"},
                {"role": "assistant", "content": "answer"},
            ],
        })
        self.assertIsInstance(ri.messages[0], UserMessage)
        self.assertIsInstance(ri.messages[1], AssistantMessage)
        self.assertEqual([m.content for m in ri.messages], ["before", "answer", "now"])

    def test_malformed_history_turns_are_dropped_not_fatal(self):
        ri = self._run_input({
            "input_text": "now",
            "history": [
                {"role": "user"},              # no content
                {"content": "orphan"},          # no role
                "not-a-dict",
                {"role": "user", "content": "kept"},
            ],
        })
        self.assertEqual([m.content for m in ri.messages], ["kept", "now"])

    def test_the_four_sdk_required_fields_are_all_supplied(self):
        """Absence — not the value — is what the SDK rejects. `None` and `[]`
        are legal; a missing key is a ValidationError."""
        ri = self._run_input({"input_text": "q"})
        for field in ("state", "tools", "context", "forwarded_props"):
            self.assertIn(field, ri.model_fields_set, f"{field} was not passed")
        self.assertEqual(ri.tools, [])
        self.assertEqual(ri.context, [])


class AdapterConstructionTests(SupervisorTestCase):
    def setUp(self):
        super().setUp()
        self.use_runtime("orgiq_search")

    def test_orgiq_keeps_the_historical_unqualified_adapter_name(self):
        """Topology and session naming key off this string; qualifying the
        default tenant would rename every existing supervisor node."""
        self.prewarm("orgiq", "member")
        self.assertEqual(self.latest_agui().name, "orgiq-supervisor-member")

    def test_another_tenant_gets_a_tenant_qualified_adapter_name(self):
        self.prewarm("other-tenant", "member")
        self.assertEqual(self.latest_agui().name, "orgiq-supervisor-other-tenant-member")

    def test_the_adapter_config_the_portal_depends_on(self):
        self.prewarm()
        cfg = self.latest_agui().config
        # The portal renders deltas, not snapshots; snapshots would double the
        # payload and re-render the whole transcript on every token.
        self.assertFalse(cfg.emit_messages_snapshot)
        # History is replayed into Strands so a follow-up turn has context.
        self.assertTrue(cfg.replay_history_into_strands)

    def test_the_adapter_wraps_the_agent_built_for_that_key(self):
        agent, ag_ui, _ = self.prewarm("orgiq", "org-leader")
        self.assertIs(ag_ui.agent, agent)


class EventForwardingTests(SupervisorTestCase):
    def setUp(self):
        super().setUp()
        self.use_runtime("orgiq_search")

    def test_adapter_events_are_forwarded_verbatim_and_in_order(self):
        _, ag_ui, _ = self.prewarm()
        script = [
            RunStartedEvent(thread_id="t", run_id="r"),
            TextMessageStartEvent(message_id="m1"),
            TextMessageContentEvent(message_id="m1", delta="Ana "),
            TextMessageContentEvent(message_id="m1", delta="knows auth."),
            TextMessageEndEvent(message_id="m1"),
            RunFinishedEvent(),
        ]
        ag_ui.script = list(script)

        events, _, err = self.invoke({"input_text": "q", "stream": True})

        self.assertIsNone(err)
        self.assertEqual([e.type for e in events], [e.type for e in script])
        for got, want in zip(events, script):
            self.assertIs(got, want, "the supervisor must not rewrap events")

    def test_the_persisted_response_is_the_assistant_text(self):
        _, ag_ui, _ = self.prewarm()
        ag_ui.script = [
            TextMessageStartEvent(message_id="m1"),
            TextMessageContentEvent(message_id="m1", delta="Ana "),
            TextMessageContentEvent(message_id="m1", delta="knows auth."),
            TextMessageEndEvent(message_id="m1"),
            RunFinishedEvent(),
        ]
        self.invoke({"input_text": "q", "stream": True})
        self.assertEqual(self.traces[-1]["response"], "Ana knows auth.")

    def test_tool_call_arg_deltas_do_not_leak_into_the_persisted_answer(self):
        """TOOL_CALL_ARGS carries a `delta` too. Accumulating every event that
        merely *has* a `delta` splices the tool's JSON arguments into the text
        stored as the assistant's answer — so the transcript, the judge and the
        canary all read a reply the user never saw."""
        _, ag_ui, _ = self.prewarm()
        ag_ui.script = [
            TextMessageStartEvent(message_id="m1"),
            TextMessageContentEvent(message_id="m1", delta="Looking. "),
            ToolCallStartEvent(tool_call_id="tc1", tool_call_name="search_organization"),
            ToolCallArgsEvent(tool_call_id="tc1", delta='{"query":'),
            ToolCallArgsEvent(tool_call_id="tc1", delta='"auth"}'),
            ToolCallEndEvent(tool_call_id="tc1"),
            TextMessageContentEvent(message_id="m1", delta="Ana does."),
            TextMessageEndEvent(message_id="m1"),
            RunFinishedEvent(),
        ]
        self.invoke({"input_text": "q", "stream": True})
        self.assertEqual(self.traces[-1]["response"], "Looking. Ana does.")

    def test_an_empty_run_still_persists_a_trace(self):
        _, ag_ui, _ = self.prewarm()
        ag_ui.script = [RunFinishedEvent()]
        events, _, err = self.invoke({"input_text": "q", "stream": True})
        self.assertIsNone(err)
        self.assertEqual(len(self.traces), 1)


class MidStreamFailureTests(SupervisorTestCase):
    """A stream that ends without saying it failed is the bug."""

    def setUp(self):
        super().setUp()
        self.use_runtime("orgiq_search")

    def _failing_run(self, exc=None):
        _, ag_ui, _ = self.prewarm()

        def boom():
            raise exc or RuntimeError("sub-agent exploded")

        ag_ui.script = [
            TextMessageStartEvent(message_id="m1"),
            TextMessageContentEvent(message_id="m1", delta="Working"),
            boom,
        ]
        return self.invoke({"input_text": "q", "stream": True})

    def test_the_stream_terminates_with_a_run_error_event(self):
        events, _, _ = self._failing_run()
        self.assertTrue(events, "nothing was streamed at all")
        self.assertEqual(
            events[-1].type.value, "RUN_ERROR",
            "the stream ended without telling the portal it failed",
        )

    def test_the_run_error_carries_the_reason(self):
        events, _, _ = self._failing_run(ValueError("bedrock said no"))
        self.assertIn("bedrock said no", events[-1].message)

    def test_partial_text_delivered_before_the_failure_is_kept(self):
        events, _, _ = self._failing_run()
        deltas = [e.delta for e in events if e.type.value == "TEXT_MESSAGE_CONTENT"]
        self.assertEqual(deltas, ["Working"])

    def test_the_failure_still_propagates_after_the_event(self):
        """The event is for the portal; the exception is for the runtime's own
        error accounting. Swallowing it would make a failed run look healthy in
        CloudWatch."""
        _, _, err = self._failing_run()
        self.assertIsInstance(err, RuntimeError)

    def test_a_failed_run_still_persists_its_trace(self):
        self._failing_run()
        self.assertEqual(len(self.traces), 1)

    def test_the_persisted_trace_says_it_failed(self):
        """A failed run with no tokens, no tools and an empty response is
        dropped at the sink as a phantom row (CLAUDE.md) — the failure would be
        invisible in observability. The error text is the substance that keeps
        the row."""
        self._failing_run(ValueError("bedrock said no"))
        response = self.traces[-1]["response"]
        self.assertIn("Working", response)
        self.assertIn("bedrock said no", response)

    def test_a_failure_before_the_first_event_still_says_run_error(self):
        _, ag_ui, _ = self.prewarm()

        def boom():
            raise RuntimeError("died immediately")

        ag_ui.script = [boom]
        events, _, err = self.invoke({"input_text": "q", "stream": True})
        self.assertEqual([e.type.value for e in events], ["RUN_ERROR"])
        self.assertIsInstance(err, RuntimeError)

    def test_a_failure_building_the_run_input_is_reported_the_same_way(self):
        """The 2026-08 SDK drift failed *here*, not inside the stream: a
        required field the supervisor did not pass made RunAgentInput raise
        before a single event was produced. That has to reach the portal as a
        RUN_ERROR and reach observability as a trace, like any other failure."""
        from unittest import mock

        self.prewarm()
        with mock.patch.object(
            self.sup, "RunAgentInput", side_effect=TypeError("missing field: state")
        ):
            events, _, err = self.invoke({"input_text": "q", "stream": True})

        self.assertEqual([e.type.value for e in events], ["RUN_ERROR"])
        self.assertIn("missing field: state", events[0].message)
        self.assertIsInstance(err, TypeError)
        self.assertEqual(len(self.traces), 1)
        self.assertIn("missing field: state", self.traces[0]["response"])

    def test_a_run_input_failure_still_releases_the_context(self):
        from unittest import mock

        self.prewarm()
        with mock.patch.object(self.sup, "RunAgentInput", side_effect=TypeError("boom")):
            self.invoke({"input_text": "q", "stream": True})
        _, runtime = self.use_runtime("orgiq_search")
        self.sup.search_organization("after")
        self.assertNotIn("parentInvocationId", runtime.last_payload)

    def test_the_context_is_still_released_after_a_failed_stream(self):
        """The `finally` must run even on the error path, or the next tool call
        in this process attaches itself to a dead invocation."""
        self._failing_run()
        _, runtime = self.use_runtime("orgiq_search")
        self.sup.search_organization("after")
        self.assertNotIn("parentInvocationId", runtime.last_payload)


if __name__ == "__main__":
    unittest.main()
