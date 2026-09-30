"""The trace bundle carries the AG-UI run it belongs to (pipelines P1, rule 2).

``docs/pipelines-tenant-goal.md`` §P1: every fleet invocation is a pipeline
Run. ``RUN_STARTED`` opens it, each ``STEP_STARTED``/``STEP_FINISHED`` is a
Step, each ``TOOL_CALL_START``…``TOOL_CALL_RESULT`` an attempt on that step, and
the trace bundle — POSTed to ``/api/observability/harness/trace`` and echoed as
``ORGIQ_TRACE:`` — closes the run. None of that joins unless the bundle names
the run: until this, the AG-UI run id and the trace's invocation uuid were
disjoint (``docs/program-operating-model.md``, "Not built yet").

Two layers are pinned: ``TraceContext`` on its own (the recorder), and the
supervisor's real streaming path driven through ``handle()`` (that the recorder
is actually fed, including the STEP events the supervisor synthesises itself).

Run:  cd agents/tests && ../../.venv-synth/bin/python -m unittest test_trace_run_id
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agui_harness import (  # noqa: E402
    RunFinishedEvent,
    RunStartedEvent,
    SupervisorTestCase,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
)
from _shared.instrumentation import TraceContext  # noqa: E402


def _bundle(ctx: TraceContext) -> dict:
    return ctx.build_trace_bundle(prompt="q", response="a", agent_id="orgiq-supervisor")


class TraceContextRunTests(unittest.TestCase):
    """The recorder, fed AG-UI events directly."""

    def test_run_started_puts_run_id_and_thread_id_in_the_bundle(self):
        ctx = TraceContext()
        ctx.observe_agui_event({"type": "RUN_STARTED", "run_id": "run-abc", "thread_id": "sess-1"})
        body = _bundle(ctx)
        self.assertEqual(body["runId"], "run-abc")
        self.assertEqual(body["threadId"], "sess-1")
        # Still its own trace: the invocation uuid is not replaced by the run id.
        self.assertNotEqual(body["invocationId"], "run-abc")

    def test_camel_case_and_enum_typed_events_are_read_too(self):
        ctx = TraceContext()
        ctx.observe_agui_event(RunStartedEvent(run_id="run-enum", thread_id="t"))
        self.assertEqual(_bundle(ctx)["runId"], "run-enum")
        ctx2 = TraceContext()
        ctx2.observe_agui_event({"type": "RUN_STARTED", "runId": "run-camel", "threadId": "t2"})
        self.assertEqual(_bundle(ctx2)["runId"], "run-camel")

    def test_a_payload_run_id_seeds_the_context(self):
        ctx = TraceContext.from_request_payload({"runId": "run-from-mw", "sessionId": "s"})
        self.assertEqual(_bundle(ctx)["runId"], "run-from-mw")

    def test_no_run_means_no_run_keys_rather_than_nulls(self):
        body = _bundle(TraceContext())
        for key in ("runId", "threadId", "steps"):
            self.assertNotIn(key, body)

    def test_steps_carry_the_tool_calls_that_ran_inside_them_as_attempts(self):
        ctx = TraceContext()
        ctx.observe_agui_event({"type": "RUN_STARTED", "run_id": "r1", "thread_id": "t"})
        # The supervisor's order: TOOL_CALL_START, then its synthesised STEP_STARTED.
        ctx.observe_agui_event({"type": "TOOL_CALL_START", "tool_call_id": "tc1", "tool_call_name": "search_organization"})
        ctx.observe_agui_event({"type": "STEP_STARTED", "step_name": "search"})
        ctx.observe_agui_event({"type": "TOOL_CALL_END", "tool_call_id": "tc1"})
        ctx.observe_agui_event({"type": "TOOL_CALL_RESULT", "tool_call_id": "tc1", "content": "x"})
        ctx.observe_agui_event({"type": "STEP_FINISHED", "step_name": "search"})
        ctx.observe_agui_event({"type": "TOOL_CALL_START", "tool_call_id": "tc2", "tool_call_name": "get_expertise_scores"})
        ctx.observe_agui_event({"type": "STEP_STARTED", "step_name": "scoring"})
        ctx.observe_agui_event({"type": "TOOL_CALL_RESULT", "tool_call_id": "tc2", "content": "y"})
        ctx.observe_agui_event({"type": "STEP_FINISHED", "step_name": "scoring"})

        steps = _bundle(ctx)["steps"]
        self.assertEqual([s["name"] for s in steps], ["search", "scoring"])
        self.assertEqual(len({s["stepId"] for s in steps}), 2, "step ids must be unique within a run")
        for s, tcid, tool in ((steps[0], "tc1", "search_organization"), (steps[1], "tc2", "get_expertise_scores")):
            self.assertEqual(s["status"], "completed")
            self.assertTrue(s["startedAt"] and s["finishedAt"])
            self.assertEqual([c["toolCallId"] for c in s["toolCalls"]], [tcid])
            self.assertEqual(s["toolCalls"][0]["name"], tool)
            self.assertEqual(s["toolCalls"][0]["status"], "completed")
            self.assertNotIn("_claimed", s["toolCalls"][0], "bookkeeping must not reach the wire")

    def test_a_run_error_fails_the_open_step_and_its_in_flight_call(self):
        ctx = TraceContext()
        ctx.observe_agui_event({"type": "TOOL_CALL_START", "tool_call_id": "tc1", "tool_call_name": "get_strategic_advice"})
        ctx.observe_agui_event({"type": "STEP_STARTED", "step_name": "advisor"})
        ctx.observe_agui_event({"type": "RUN_ERROR", "message": "boom"})
        step = _bundle(ctx)["steps"][0]
        self.assertEqual(step["status"], "failed")
        self.assertTrue(step["finishedAt"])
        self.assertEqual(step["toolCalls"][0]["status"], "failed")

    def test_a_malformed_event_is_ignored_not_raised(self):
        ctx = TraceContext()
        ctx.observe_agui_event(object())
        ctx.observe_agui_event({"type": "TOOL_CALL_START"})  # no id
        ctx.observe_agui_event(None)
        self.assertNotIn("steps", _bundle(ctx))


class SupervisorStreamingRunIdTests(SupervisorTestCase):
    """The shipped streaming path feeds the recorder."""

    def setUp(self):
        super().setUp()
        self.use_runtime("orgiq_search")

    def test_the_middleware_minted_run_id_is_the_run_the_bundle_names(self):
        _, ag_ui, _ = self.prewarm()
        ag_ui.script = [
            RunStartedEvent(run_id="run-from-mw", thread_id="sess-1"),
            TextMessageStartEvent(message_id="m1"),
            TextMessageContentEvent(message_id="m1", delta="hi"),
            TextMessageEndEvent(message_id="m1"),
            RunFinishedEvent(),
        ]
        _, _, err = self.invoke({"input_text": "q", "stream": True, "sessionId": "sess-1", "runId": "run-from-mw"})
        self.assertIsNone(err)
        self.assertEqual(self.latest_agui().runs[-1].run_id, "run-from-mw")
        self.assertEqual(self.traces[-1]["runId"], "run-from-mw")
        self.assertEqual(self.traces[-1]["threadId"], "sess-1")

    def test_a_run_id_is_carried_even_when_the_middleware_sent_none(self):
        self.invoke({"input_text": "q", "stream": True})
        bundle = self.traces[-1]
        self.assertTrue(bundle.get("runId"))
        self.assertEqual(bundle["runId"], self.latest_agui().runs[-1].run_id)

    def test_synthesised_sub_agent_steps_reach_the_bundle_with_their_attempt(self):
        _, ag_ui, _ = self.prewarm()
        ag_ui.script = [
            ToolCallStartEvent(tool_call_id="tc1", tool_call_name="search_organization"),
            ToolCallEndEvent(tool_call_id="tc1"),
            ToolCallResultEvent(tool_call_id="tc1", message_id="m0", content="found"),
            TextMessageStartEvent(message_id="m1"),
            TextMessageContentEvent(message_id="m1", delta="Ana."),
            TextMessageEndEvent(message_id="m1"),
            RunFinishedEvent(),
        ]
        _, _, err = self.invoke({"input_text": "who knows auth", "stream": True, "runId": "r-steps"})
        self.assertIsNone(err)
        steps = self.traces[-1]["steps"]
        self.assertEqual(len(steps), 1)
        self.assertEqual(steps[0]["name"], "search")
        self.assertEqual(steps[0]["status"], "completed")
        self.assertEqual([c["toolCallId"] for c in steps[0]["toolCalls"]], ["tc1"])

    def test_a_stream_that_dies_mid_step_records_the_step_failed(self):
        _, ag_ui, _ = self.prewarm()

        def boom():
            raise RuntimeError("model stream died")

        ag_ui.script = [
            ToolCallStartEvent(tool_call_id="tc1", tool_call_name="get_strategic_advice"),
            boom,
        ]
        _, _, err = self.invoke({"input_text": "advise", "stream": True, "runId": "r-dies"})
        self.assertIsNotNone(err)
        bundle = self.traces[-1]
        self.assertEqual(bundle["runId"], "r-dies")
        self.assertEqual(bundle["steps"][0]["status"], "failed")


if __name__ == "__main__":
    unittest.main()
