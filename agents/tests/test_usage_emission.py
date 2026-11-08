"""Token usage on the response, not only in the trace bundle.

The middleware prices a chat turn from a ``usage`` block on the agent's final
event (or on the sync response dict) and writes the ledger row with an UNKNOWN
cost when there is none (``middleware/src/lib/agent-invoke-spend.ts``
``usageFromEvent``). These tests pin the producer side of that contract: the
block is attached when Converse counts were captured, and omitted, never
zeroed, when they were not.

Run: cd agents/tests && ../../.venv-synth/bin/python -m unittest test_usage_emission
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agui_harness import (  # noqa: E402
    RunFinishedEvent,
    SupervisorTestCase,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
)


def _shared():
    # Imported lazily: the harness puts agents/ on sys.path when the
    # supervisor loads, and installs the ag_ui stubs `_shared` may touch.
    from agui_harness import supervisor

    supervisor()
    from _shared import agui_stream, instrumentation

    return agui_stream, instrumentation


class WithUsageTests(unittest.TestCase):
    def setUp(self):
        self.agui, self.inst = _shared()

    def _ctx(self, i=0, o=0):
        ctx = self.inst.TraceContext.from_request_payload({})
        ctx.accumulate_usage(i, o)
        return ctx

    def test_usage_and_model_are_attached_when_tokens_were_counted(self):
        out = self.agui.with_usage(RunFinishedEvent(), self._ctx(120, 30), "amazon.nova-pro-v1:0")
        self.assertEqual(out["usage"], {"inputTokens": 120, "outputTokens": 30})
        self.assertEqual(out["model"], "amazon.nova-pro-v1:0")
        self.assertEqual(out["type"], "RUN_FINISHED")

    def test_one_nonzero_count_is_enough(self):
        out = self.agui.with_usage({"type": "RUN_FINISHED"}, self._ctx(0, 7), "m")
        self.assertEqual(out["usage"], {"inputTokens": 0, "outputTokens": 7})

    def test_no_counts_forwards_the_same_event_unchanged(self):
        ev = RunFinishedEvent()
        self.assertIs(self.agui.with_usage(ev, self._ctx(0, 0), "m"), ev)
        d = {"type": "RUN_FINISHED", "threadId": "t"}
        self.assertIs(self.agui.with_usage(d, self._ctx(), "m"), d)

    def test_dict_input_keeps_its_fields_and_is_not_mutated(self):
        d = {"type": "RUN_FINISHED", "threadId": "t", "runId": "r", "result": {"a": 1}}
        out = self.agui.with_usage(d, self._ctx(5, 6), "m")
        self.assertEqual(out["threadId"], "t")
        self.assertEqual(out["runId"], "r")
        self.assertEqual(out["result"], {"a": 1})
        self.assertNotIn("usage", d)
        self.assertNotIn("model", d)
        self.assertIsNot(out, d)

    def test_pydantic_input_is_not_mutated(self):
        ev = RunFinishedEvent()
        out = self.agui.with_usage(ev, self._ctx(5, 6), "m")
        self.assertIsInstance(out, dict)
        self.assertFalse(hasattr(ev, "usage"))
        self.assertEqual(self.agui.event_type(out), "RUN_FINISHED")

    def test_usage_block_and_attach_usage(self):
        self.assertIsNone(self.inst.usage_block(None))
        self.assertIsNone(self.inst.usage_block(self._ctx()))
        resp = {"response": "hi"}
        self.assertEqual(self.inst.attach_usage(resp, self._ctx(), "m"), {"response": "hi"})
        self.inst.attach_usage(resp, self._ctx(3, 4), "m")
        self.assertEqual(resp["usage"], {"inputTokens": 3, "outputTokens": 4})
        self.assertEqual(resp["model"], "m")


class StreamAguiUsageTests(unittest.TestCase):
    """The shared streamer the six non-supervisor agents use."""

    def setUp(self):
        self.agui, self.inst = _shared()

    def _run(self, script):
        from unittest import mock

        from agui_harness import StrandsAgent, no_network, run_async

        adapter = StrandsAgent()
        adapter.script = script
        live = mock.Mock(prompt_sha="sha", registry_version="", resolved=None)
        live.ag_ui.return_value = adapter

        async def drive():
            return [
                ev async for ev in self.agui.stream_agui(
                    payload={"stream": True}, input_text="q", live_agent=live,
                    agent_id="a", agent_name="A", model_id="amazon.nova-pro-v1:0",
                )
            ]

        with no_network(), mock.patch.object(self.agui, "post_trace"):
            return run_async(drive())

    def test_run_finished_carries_usage_accumulated_mid_run(self):
        def spend():
            self.inst.get_active_ctx().accumulate_usage(120, 30)

        events = self._run([spend, RunFinishedEvent()])
        self.assertEqual(events[-1]["usage"], {"inputTokens": 120, "outputTokens": 30})
        self.assertEqual(events[-1]["model"], "amazon.nova-pro-v1:0")

    def test_run_finished_is_untouched_without_counts(self):
        finished = RunFinishedEvent()
        events = self._run([finished])
        self.assertIs(events[-1], finished)


class SupervisorUsageTests(SupervisorTestCase):
    def setUp(self):
        super().setUp()
        self.use_runtime("orgiq_search")
        _, self.inst = _shared()

    def _spend(self, i, o):
        self.inst.get_active_ctx().accumulate_usage(i, o)

    def test_streamed_run_finished_carries_usage_and_model(self):
        _, ag_ui, _ = self.prewarm()
        ag_ui.script = [
            TextMessageStartEvent(message_id="m1"),
            TextMessageContentEvent(message_id="m1", delta="hi"),
            TextMessageEndEvent(message_id="m1"),
            lambda: self._spend(120, 30),
            RunFinishedEvent(),
        ]
        events, _, err = self.invoke({"input_text": "q", "stream": True})
        self.assertIsNone(err)
        final = events[-1]
        self.assertEqual(final["type"], "RUN_FINISHED")
        self.assertEqual(final["usage"], {"inputTokens": 120, "outputTokens": 30})
        self.assertTrue(final["model"])
        self.assertNotIn("usage", events[0] if isinstance(events[0], dict) else {})

    def test_streamed_run_without_counts_is_forwarded_unchanged(self):
        _, ag_ui, _ = self.prewarm()
        finished = RunFinishedEvent()
        ag_ui.script = [finished]
        events, _, _ = self.invoke({"input_text": "q", "stream": True})
        self.assertIs(events[-1], finished)

    def test_sync_response_carries_usage_only_when_counted(self):
        agent, _, _ = self.prewarm()
        agent.respond = lambda prompt, **kw: self._spend(11, 22) or "ok"
        _, result, _ = self.invoke({"input_text": "q"})
        self.assertEqual(result["usage"], {"inputTokens": 11, "outputTokens": 22})
        self.assertTrue(result["model"])

        agent.respond = lambda prompt, **kw: "ok"
        _, result, _ = self.invoke({"input_text": "q"})
        self.assertNotIn("usage", result)
        self.assertNotIn("model", result)


if __name__ == "__main__":
    unittest.main()
