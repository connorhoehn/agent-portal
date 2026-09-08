"""Unit tests for _shared/instrumentation.py — no network, no OTel required.

What these pin, and why:

*   The ``ORGIQ_TRACE:`` stdout line is a **wire contract** with
    ``middleware/src/lib/cw-trace-ingest.ts``. AgentCore Runtime captures agent
    stdout into CloudWatch, the middleware greps for that prefix and extracts
    the JSON object with a depth counter. If the prefix, the single-line-ness,
    or the camelCase key names drift, trace ingestion stops — silently, because
    nothing errors: the poller simply matches nothing and reports zero. The
    parser here is a transliteration of the middleware's, so a drift on either
    side fails a test instead of emptying a dashboard.
*   The root AGENT span's attribute names are a second wire contract, this time
    with ``infra/lambda/span-projector/index.py``, which reads
    ``orgiq.invocation_id`` / ``orgiq.agent_id`` / ``orgiq.guardrail_action``
    and friends by exact string.
*   Everything on this path is fire-and-forget by design. The tests assert the
    *never crash the agent* rule directly: a dead middleware, a 401, an
    unserialisable bundle and a missing OpenTelemetry all leave the caller's
    code running.

Run:  cd agents/_shared && ../../.venv-synth/bin/python -m unittest test_instrumentation
"""

from __future__ import annotations

import io
import json
import sys
import types
import unittest
import urllib.error
from contextlib import redirect_stdout
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from _shared import callbacks  # noqa: E402
from _shared import instrumentation as ins  # noqa: E402


# ── Transliteration of middleware/src/lib/cw-trace-ingest.ts ──────────────────

ORGIQ_TRACE_PREFIX = "ORGIQ_TRACE:"


def middleware_extract(raw: str):
    """What the middleware does to one CloudWatch @message. Returns the parsed
    bundle or None. Mirrors cw-trace-ingest.ts (indexOf prefix → first brace →
    depth count, string- and escape-aware)."""
    prefix_idx = raw.find(ORGIQ_TRACE_PREFIX)
    if prefix_idx < 0:
        return None
    after = raw[prefix_idx + len(ORGIQ_TRACE_PREFIX):]
    first_brace = after.find("{")
    if first_brace < 0:
        return None
    depth = 0
    in_string = False
    escape = False
    end_brace = -1
    for i in range(first_brace, len(after)):
        ch = after[i]
        if escape:
            escape = False
            continue
        if ch == "\\":
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end_brace = i
                break
    if end_brace < 0:
        return None
    return json.loads(after[first_brace:end_brace + 1])


def capture_stdout(fn, *args, **kwargs):
    buf = io.StringIO()
    with redirect_stdout(buf):
        result = fn(*args, **kwargs)
    return result, buf.getvalue()


class _Resp:
    """urlopen context-manager stand-in."""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return b"{}"


def _http_error(code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("http://mw/x", code, "nope", {}, None)


class _EnvMixin:
    def _set_env(self, **kv):
        patcher = mock.patch.dict("os.environ", kv, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        callbacks.reset_announcements()


# ── TraceContext ──────────────────────────────────────────────────────────────


class TraceContextTests(unittest.TestCase):
    def test_defaults_give_a_fresh_invocation_id(self):
        a, b = ins.TraceContext(), ins.TraceContext()
        self.assertNotEqual(a.invocation_id, b.invocation_id)
        self.assertIsNone(a.parent_invocation_id)

    def test_reads_camelcase_wire_fields(self):
        ctx = ins.TraceContext.from_request_payload(
            {"parentInvocationId": "p1", "userId": "u1", "sessionId": "s1"}
        )
        self.assertEqual(
            (ctx.parent_invocation_id, ctx.user_id, ctx.session_id), ("p1", "u1", "s1")
        )

    def test_snake_case_is_tolerated(self):
        ctx = ins.TraceContext.from_request_payload(
            {"parent_invocation_id": "p1", "user_id": "u1", "session_id": "s1"}
        )
        self.assertEqual(ctx.parent_invocation_id, "p1")

    def test_auth_block_supplies_the_user_when_masquerading(self):
        ctx = ins.TraceContext.from_request_payload({"auth": {"userId": "real-user"}})
        self.assertEqual(ctx.user_id, "real-user")

    def test_runtime_session_id_alias(self):
        ctx = ins.TraceContext.from_request_payload({"runtimeSessionId": "s9"})
        self.assertEqual(ctx.session_id, "s9")

    def test_non_dict_payload_yields_defaults_rather_than_raising(self):
        # A direct invoke can hand the entrypoint a bare string. Instrumentation
        # is the last thing that should turn that into a 500.
        for payload in ("just a prompt", None, 7, ["a"]):
            ctx = ins.TraceContext.from_request_payload(payload)
            self.assertIsNone(ctx.parent_invocation_id)

    def test_non_string_ids_are_dropped_not_coerced(self):
        ctx = ins.TraceContext.from_request_payload({"parentInvocationId": 42})
        self.assertIsNone(ctx.parent_invocation_id)

    def test_parent_link_is_what_makes_a2a_topology_edges_possible(self):
        # CLAUDE.md: the supervisor's streaming path once failed to thread this,
        # so every sub-agent trace persisted with parent_invocation_id NULL and
        # /api/topology/a2a could never return an edge for real traffic.
        ctx = ins.TraceContext.from_request_payload({"parentInvocationId": "sup-1"})
        bundle = ctx.build_trace_bundle(
            prompt="q", response="a", agent_id="orgiq-search"
        )
        self.assertEqual(bundle["parentInvocationId"], "sup-1")


class UsageAccumulationTests(unittest.TestCase):
    def test_sums_across_calls(self):
        ctx = ins.TraceContext()
        ctx.accumulate_usage(10, 5)
        ctx.accumulate_usage(3, 2)
        self.assertEqual((ctx.bedrock_input_tokens, ctx.bedrock_output_tokens), (13, 7))

    def test_malformed_usage_does_not_poison_the_totals(self):
        ctx = ins.TraceContext()
        ctx.accumulate_usage(10, 5)
        ctx.accumulate_usage("nope", None)
        ctx.accumulate_usage(-4, -4)
        self.assertEqual((ctx.bedrock_input_tokens, ctx.bedrock_output_tokens), (10, 5))

    def test_accumulated_usage_reaches_the_bundle(self):
        ctx = ins.TraceContext()
        ctx.accumulate_usage(11, 22)
        bundle = ctx.build_trace_bundle(prompt="q", response="a", agent_id="a")
        self.assertEqual((bundle["inputTokens"], bundle["outputTokens"]), (11, 22))

    def test_explicit_tokens_override_the_accumulator(self):
        ctx = ins.TraceContext()
        ctx.accumulate_usage(11, 22)
        bundle = ctx.build_trace_bundle(
            prompt="q", response="a", agent_id="a", input_tokens=1, output_tokens=2
        )
        self.assertEqual((bundle["inputTokens"], bundle["outputTokens"]), (1, 2))

    def test_zero_usage_is_omitted_rather_than_reported_as_zero(self):
        # "we don't know" and "it cost nothing" are different facts; the sink
        # logs "no usage" once per agent on the former.
        bundle = ins.TraceContext().build_trace_bundle(
            prompt="q", response="a", agent_id="a"
        )
        self.assertNotIn("inputTokens", bundle)
        self.assertNotIn("outputTokens", bundle)


# ── The trace bundle: key names are the wire ─────────────────────────────────


class BundleShapeTests(unittest.TestCase):
    def test_required_keys(self):
        bundle = ins.TraceContext().build_trace_bundle(
            prompt="who knows auth?", response="Alice", agent_id="orgiq-supervisor"
        )
        self.assertEqual(bundle["agentId"], "orgiq-supervisor")
        self.assertEqual(bundle["agentName"], "orgiq-supervisor")  # defaults to id
        self.assertEqual(bundle["prompt"], "who knows auth?")
        self.assertEqual(bundle["response"], "Alice")
        self.assertIn("invocationId", bundle)

    def test_full_key_set_is_camelcase(self):
        ctx = ins.TraceContext(
            parent_invocation_id="p", user_id="u", session_id="s"
        )
        ctx.record_tool_call({"toolName": "query_graph"})
        bundle = ctx.build_trace_bundle(
            prompt="q",
            response="a",
            agent_id="orgiq-search",
            agent_name="Search",
            model_id="amazon.nova-pro-v1:0",
            template_id="t1",
            duration_ms=123,
            input_tokens=1,
            output_tokens=2,
            prompt_version="abc123def456",
            guardrail_action="GUARDRAIL_INTERVENED",
            pii_detected=True,
        )
        self.assertEqual(
            set(bundle),
            {
                "agentId", "agentName", "prompt", "response", "invocationId",
                "templateId", "durationMs", "inputTokens", "outputTokens",
                "promptVersion", "modelId", "guardrailAction", "piiDetected",
                "parentInvocationId", "userId", "sessionId", "toolCalls",
            },
        )

    def test_unset_optional_fields_are_omitted_not_nulled(self):
        bundle = ins.TraceContext().build_trace_bundle(
            prompt="q", response="a", agent_id="a"
        )
        for key in ("parentInvocationId", "userId", "sessionId", "toolCalls",
                    "guardrailAction", "piiDetected", "modelId", "templateId"):
            self.assertNotIn(key, bundle)

    def test_pii_false_is_still_reported(self):
        # False is a measurement; only None means "not checked".
        bundle = ins.TraceContext().build_trace_bundle(
            prompt="q", response="a", agent_id="a", pii_detected=False
        )
        self.assertIs(bundle["piiDetected"], False)

    def test_guardrail_none_action_is_dropped(self):
        # 'NONE' is truthy so it survives; the middleware's errorRate rule
        # ("guardrail_action present and not 'NONE'") depends on that spelling.
        bundle = ins.TraceContext().build_trace_bundle(
            prompt="q", response="a", agent_id="a", guardrail_action="NONE"
        )
        self.assertEqual(bundle["guardrailAction"], "NONE")


class ProjectToolCallsTests(unittest.TestCase):
    def test_successful_call_projects_args_and_result(self):
        ctx = ins.TraceContext()
        ctx.record_tool_call(
            {"toolName": "query_graph", "inputSample": "{}", "outputSample": "[]"}
        )
        self.assertEqual(
            ctx.project_tool_calls(),
            [{"name": "query_graph", "args": "{}", "result": "[]"}],
        )

    def test_errored_call_renders_as_terminal_so_the_ui_timeline_closes(self):
        ctx = ins.TraceContext()
        ctx.record_tool_call(
            {"toolName": "query_graph", "errored": True, "errorMessage": "boom"}
        )
        self.assertEqual(ctx.project_tool_calls()[0]["result"], {"error": "boom"})

    def test_unnamed_tool_falls_back_to_unknown(self):
        ctx = ins.TraceContext()
        ctx.record_tool_call({})
        self.assertEqual(ctx.project_tool_calls()[0]["name"], "unknown")


# ── ORGIQ_TRACE: the stdout wire contract ────────────────────────────────────


class StdoutWireContractTests(unittest.TestCase):
    def _emit(self, bundle):
        _, out = capture_stdout(ins._emit_stdout_trace, bundle)
        return out

    def test_prefix_is_exact(self):
        out = self._emit({"agentId": "a"})
        self.assertTrue(out.startswith("ORGIQ_TRACE:{"))

    def test_exactly_one_line(self):
        # CloudWatch Insights matches per @message; a bundle split across lines
        # would be truncated at the first newline and never parse.
        ctx = ins.TraceContext()
        ctx.record_tool_call(
            {"toolName": "t", "outputSample": "line one\nline two\r\nline three"}
        )
        out = self._emit(
            ctx.build_trace_bundle(
                prompt="multi\nline\nprompt", response="also\nmulti", agent_id="a"
            )
        )
        self.assertEqual(out.count("\n"), 1)
        self.assertTrue(out.endswith("\n"))

    def test_round_trips_through_the_middleware_parser(self):
        ctx = ins.TraceContext(parent_invocation_id="p1", user_id="u", session_id="s")
        ctx.record_tool_call({"toolName": "query_graph", "durationMs": 5})
        bundle = ctx.build_trace_bundle(
            prompt="q", response="a", agent_id="orgiq-search", duration_ms=9
        )
        parsed = middleware_extract(self._emit(bundle))
        self.assertEqual(parsed, bundle)

    def test_survives_stdout_concatenation_on_both_sides(self):
        # AgentCore Runtime glues adjacent stdout writes into one @message, so
        # the prefix can appear mid-line and the agent's own answer can follow
        # the JSON — including a stray `}` that a lastIndexOf-based parser
        # would slice past.
        bundle = ins.TraceContext().build_trace_bundle(
            prompt="q", response="a", agent_id="orgiq-search"
        )
        line = self._emit(bundle).rstrip("\n")
        noisy = f"some earlier log output {line} and then a trailing }} brace"
        self.assertEqual(middleware_extract(noisy), bundle)

    def test_braces_inside_string_values_do_not_end_the_object(self):
        bundle = ins.TraceContext().build_trace_bundle(
            prompt='{"looks": "like json"} } }',
            response='a "quoted" } brace',
            agent_id="a",
        )
        self.assertEqual(middleware_extract(self._emit(bundle)), bundle)

    def test_non_ascii_survives(self):
        bundle = ins.TraceContext().build_trace_bundle(
            prompt="who knows 日本語?", response="Zoë — naïve", agent_id="a"
        )
        parsed = middleware_extract(self._emit(bundle))
        self.assertEqual(parsed["response"], "Zoë — naïve")

    def test_non_json_native_values_are_stringified_not_dropped(self):
        bundle = {"agentId": "a", "when": datetime(2026, 1, 1, tzinfo=timezone.utc)}
        parsed = middleware_extract(self._emit(bundle))
        self.assertIn("2026-01-01", parsed["when"])

    def test_unserialisable_bundle_never_raises(self):
        class Boom:
            def __repr__(self):
                raise RuntimeError("even repr explodes")

        out = self._emit({"agentId": Boom()})
        self.assertEqual(out, "")  # nothing emitted, and no exception escaped


# ── post_trace ───────────────────────────────────────────────────────────────


class PostTraceTests(_EnvMixin, unittest.TestCase):
    def setUp(self):
        self.bundle = ins.TraceContext().build_trace_bundle(
            prompt="q", response="a", agent_id="orgiq-search"
        )

    def test_success_returns_true_and_still_emits_on_stdout(self):
        with mock.patch.object(ins.urllib.request, "urlopen", return_value=_Resp()):
            ok, out = capture_stdout(ins.post_trace, self.bundle)
        self.assertTrue(ok)
        self.assertIn("ORGIQ_TRACE:", out)

    def test_stdout_emission_happens_before_the_post(self):
        # The whole point of the dual path: an unreachable middleware must not
        # be able to swallow the trace. Emission is unconditional and first.
        order = []

        def _emit(bundle):
            order.append("stdout")

        def _urlopen(*a, **k):
            order.append("http")
            raise urllib.error.URLError("connection refused")

        with mock.patch.object(ins, "_emit_stdout_trace", _emit), \
                mock.patch.object(ins.urllib.request, "urlopen", _urlopen):
            self.assertFalse(ins.post_trace(self.bundle))
        self.assertEqual(order, ["stdout", "http"])

    def test_unreachable_middleware_returns_false_without_raising(self):
        with mock.patch.object(
            ins.urllib.request, "urlopen",
            side_effect=urllib.error.URLError("no route to host"),
        ):
            ok, out = capture_stdout(ins.post_trace, self.bundle)
        self.assertFalse(ok)
        self.assertIn("ORGIQ_TRACE:", out)

    def test_server_error_returns_false_without_raising(self):
        with mock.patch.object(
            ins.urllib.request, "urlopen", side_effect=_http_error(500)
        ):
            ok, _ = capture_stdout(ins.post_trace, self.bundle)
        self.assertFalse(ok)

    def test_unexpected_exception_is_absorbed(self):
        with mock.patch.object(
            ins.urllib.request, "urlopen", side_effect=RuntimeError("tls exploded")
        ):
            ok, _ = capture_stdout(ins.post_trace, self.bundle)
        self.assertFalse(ok)

    def test_no_service_auth_header_when_the_secret_is_unset(self):
        self._set_env(HARNESS_TRACE_SECRET="")
        seen = {}

        def _urlopen(req, timeout=None):
            seen["headers"] = dict(req.headers)
            return _Resp()

        with mock.patch.object(ins.urllib.request, "urlopen", _urlopen):
            capture_stdout(ins.post_trace, self.bundle)
        # urllib title-cases header names.
        self.assertNotIn("X-harness-auth", seen["headers"])

    def test_service_auth_header_is_sent_when_configured(self):
        self._set_env(HARNESS_TRACE_SECRET="  s3cret\n")
        seen = {}

        def _urlopen(req, timeout=None):
            seen["value"] = req.get_header("X-harness-auth")
            return _Resp()

        with mock.patch.object(ins.urllib.request, "urlopen", _urlopen):
            capture_stdout(ins.post_trace, self.bundle)
        # Whitespace-stripped: a secret pasted from `aws secretsmanager
        # get-secret-value --output text` carries a trailing newline, which is
        # not a legal header value at all.
        self.assertEqual(seen["value"], "s3cret")

    def test_401_is_not_fatal_because_the_stdout_path_already_delivered(self):
        self._set_env(HARNESS_TRACE_SECRET="wrong")
        with mock.patch.object(
            ins.urllib.request, "urlopen", side_effect=_http_error(401)
        ):
            with self.assertLogs(ins.log, level="ERROR") as logs:
                ok, out = capture_stdout(ins.post_trace, self.bundle)
        self.assertFalse(ok)
        self.assertIn("ORGIQ_TRACE:", out)
        joined = "\n".join(logs.output)
        self.assertIn("HARNESS_TRACE_SECRET", joined)
        self.assertIn("CloudWatch", joined)

    def test_403_is_treated_the_same_as_401(self):
        with mock.patch.object(
            ins.urllib.request, "urlopen", side_effect=_http_error(403)
        ):
            with self.assertLogs(ins.log, level="ERROR"):
                ok, _ = capture_stdout(ins.post_trace, self.bundle)
        self.assertFalse(ok)

    def test_posts_to_the_harness_trace_route(self):
        seen = {}

        def _urlopen(req, timeout=None):
            seen["url"] = req.full_url
            seen["method"] = req.get_method()
            return _Resp()

        with mock.patch.object(ins.urllib.request, "urlopen", _urlopen):
            capture_stdout(ins.post_trace, self.bundle, middleware_url="http://mw:3001/")
        self.assertEqual(seen["url"], "http://mw:3001/api/observability/harness/trace")
        self.assertEqual(seen["method"], "POST")


# ── instrumented_tool ────────────────────────────────────────────────────────


class InstrumentedToolTests(unittest.TestCase):
    def test_records_name_timing_sizes_and_samples(self):
        ctx = ins.TraceContext()

        @ins.instrumented_tool(ctx)
        def query_graph(sql: str) -> str:
            return "[]"

        self.assertEqual(query_graph("SELECT 1"), "[]")
        entry = ctx.tool_calls[0]
        self.assertEqual(entry["toolName"], "query_graph")
        self.assertFalse(entry["errored"])
        self.assertIn("SELECT 1", entry["inputSample"])
        self.assertEqual(entry["outputSample"], "[]")
        self.assertIsInstance(entry["durationMs"], int)
        self.assertGreater(entry["inputSize"], 0)

    def test_samples_are_capped_at_500_chars(self):
        # The sink truncates to 500 server-side too; doing it here keeps the
        # CloudWatch line (and the Insights result) small.
        ctx = ins.TraceContext()

        @ins.instrumented_tool(ctx)
        def big(_: str) -> str:
            return "y" * 5000

        big("x" * 5000)
        entry = ctx.tool_calls[0]
        self.assertEqual(len(entry["outputSample"]), 500)
        self.assertEqual(len(entry["inputSample"]), 500)
        # Sizes report the TRUE length, not the truncated one.
        self.assertEqual(entry["outputSize"], 5002)

    def test_failure_is_recorded_and_re_raised(self):
        # The agent's own error handling must be untouched — instrumentation
        # observes, it does not swallow.
        ctx = ins.TraceContext()

        @ins.instrumented_tool(ctx)
        def boom():
            raise ValueError("nope")

        with self.assertRaises(ValueError):
            boom()
        entry = ctx.tool_calls[0]
        self.assertTrue(entry["errored"])
        self.assertEqual(entry["errorMessage"], "ValueError: nope")
        self.assertIn("durationMs", entry)

    def test_signature_and_docstring_survive_for_the_strands_schema(self):
        # @tool sits OUTSIDE this decorator and builds the tool schema from the
        # wrapped function's signature + docstring. Losing functools.wraps here
        # would silently give every agent a tool named "wrapper" with no args.
        @ins.instrumented_tool(None)
        def merge_person(person_id: str, name: str = "") -> str:
            """Upsert a Person row."""
            return "ok"

        self.assertEqual(merge_person.__name__, "merge_person")
        self.assertEqual(merge_person.__doc__, "Upsert a Person row.")
        import inspect

        self.assertEqual(
            list(inspect.signature(merge_person).parameters), ["person_id", "name"]
        )

    def test_none_context_drops_observations_silently(self):
        @ins.instrumented_tool(None)
        def t():
            return 1

        self.assertEqual(t(), 1)

    def test_callable_resolver_is_read_per_call(self):
        # This is the shape every agent uses: `instrumented_tool(_current_ctx.get)`
        # so observations follow the rotating per-invocation buffer.
        boxes = [ins.TraceContext(), ins.TraceContext()]
        idx = {"i": 0}

        @ins.instrumented_tool(lambda: boxes[idx["i"]])
        def t():
            return 1

        t()
        idx["i"] = 1
        t()
        self.assertEqual(len(boxes[0].tool_calls), 1)
        self.assertEqual(len(boxes[1].tool_calls), 1)

    def test_resolver_returning_none_is_the_normal_no_invocation_case(self):
        @ins.instrumented_tool(lambda: None)
        def t():
            return 1

        self.assertEqual(t(), 1)

    def test_a_broken_resolver_does_not_break_the_tool(self):
        def explode():
            raise RuntimeError("contextvar gone")

        @ins.instrumented_tool(explode)
        def t():
            return "still works"

        self.assertEqual(t(), "still works")

    def test_unserialisable_arguments_still_produce_a_sample(self):
        ctx = ins.TraceContext()

        class Weird:
            pass

        @ins.instrumented_tool(ctx)
        def t(obj):
            return obj

        t(Weird())
        self.assertTrue(ctx.tool_calls[0]["inputSample"])


class ActiveContextTests(unittest.TestCase):
    def test_set_and_reset_restore_the_previous_value(self):
        self.assertIsNone(ins.get_active_ctx())
        ctx = ins.TraceContext()
        token = ins.set_active_ctx(ctx)
        self.assertIs(ins.get_active_ctx(), ctx)
        ins.reset_active_ctx(token)
        self.assertIsNone(ins.get_active_ctx())

    def test_reset_with_a_stale_token_is_absorbed(self):
        # Called from a `finally`; a raise here would mask the real exception.
        token = ins.set_active_ctx(ins.TraceContext())
        ins.reset_active_ctx(token)
        ins.reset_active_ctx(token)  # must not raise


# ── OpenInference spans ──────────────────────────────────────────────────────


class _FakeSpan:
    def __init__(self, name, attributes=None):
        self.name = name
        self.attributes = dict(attributes or {})

    def set_attribute(self, key, value):
        self.attributes[key] = value

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeTracer:
    def __init__(self, sink):
        self._sink = sink

    def start_as_current_span(self, name, attributes=None):
        span = _FakeSpan(name, attributes)
        self._sink.append(span)
        return span


def _otel_stubs(sink):
    """sys.modules stubs for opentelemetry + openinference.instrumentation.

    Neither package is installed in the offline test venv, which is itself the
    interesting case (`with_orgiq_root` must degrade to a no-op). These stubs
    cover the other half: that when they ARE present the span carries exactly
    the attribute names infra/lambda/span-projector/index.py reads back.
    """
    import contextlib as _contextlib

    otel = types.ModuleType("opentelemetry")
    trace_mod = types.ModuleType("opentelemetry.trace")
    trace_mod.get_tracer = lambda _name: _FakeTracer(sink)
    otel.trace = trace_mod

    oi = types.ModuleType("openinference")
    oi_ins = types.ModuleType("openinference.instrumentation")

    @_contextlib.contextmanager
    def using_session(session_id=None):
        sink.append(("session", session_id))
        yield

    @_contextlib.contextmanager
    def using_user(user_id=None):
        sink.append(("user", user_id))
        yield

    oi_ins.using_session = using_session
    oi_ins.using_user = using_user
    oi.instrumentation = oi_ins

    return {
        "opentelemetry": otel,
        "opentelemetry.trace": trace_mod,
        "openinference": oi,
        "openinference.instrumentation": oi_ins,
    }


class RootSpanTests(unittest.TestCase):
    def test_degrades_to_a_no_op_when_otel_is_absent(self):
        # True of this test venv, and true of any image where the OI extras
        # failed to install. The body MUST still run.
        ran = []
        with mock.patch.dict(sys.modules, {"opentelemetry": None}):
            with ins.with_orgiq_root(
                ins.TraceContext(), "orgiq-search", "Search"
            ) as span:
                ran.append(span)
        self.assertEqual(ran, [None])

    def test_attribute_names_match_the_span_projector(self):
        sink = []
        ctx = ins.TraceContext(
            parent_invocation_id="p1", user_id="u1", session_id="s1"
        )
        with mock.patch.dict(sys.modules, _otel_stubs(sink)):
            with ins.with_orgiq_root(
                ctx,
                agent_id="orgiq-search",
                agent_name="Search",
                prompt_version="abc123",
                template_id="t1",
                runtime_image_digest="sha256:dead",
            ) as span:
                pass
        self.assertEqual(span.name, "orgiq.agent.invoke")
        self.assertEqual(
            span.attributes,
            {
                "openinference.span.kind": "AGENT",
                "agent.name": "Search",
                "orgiq.agent_id": "orgiq-search",
                "orgiq.agent_name": "Search",
                "orgiq.invocation_id": ctx.invocation_id,
                "orgiq.parent_invocation_id": "p1",
                "orgiq.user_id": "u1",
                "orgiq.session_id": "s1",
                "orgiq.prompt_version": "abc123",
                "orgiq.template_id": "t1",
                "orgiq.runtime_image_digest": "sha256:dead",
            },
        )

    def test_absent_ids_are_omitted_rather_than_stamped_empty(self):
        sink = []
        with mock.patch.dict(sys.modules, _otel_stubs(sink)):
            with ins.with_orgiq_root(
                ins.TraceContext(), "orgiq-search", "Search"
            ) as span:
                pass
        for key in ("orgiq.parent_invocation_id", "orgiq.user_id",
                    "orgiq.session_id", "orgiq.prompt_version"):
            self.assertNotIn(key, span.attributes)

    def test_session_and_user_are_propagated_to_child_spans(self):
        sink = []
        ctx = ins.TraceContext(user_id="u1", session_id="s1")
        with mock.patch.dict(sys.modules, _otel_stubs(sink)):
            with ins.with_orgiq_root(ctx, "orgiq-search", "Search"):
                pass
        self.assertIn(("session", "s1"), sink)
        self.assertIn(("user", "u1"), sink)

    def test_the_caller_exception_is_not_suppressed(self):
        sink = []
        with mock.patch.dict(sys.modules, _otel_stubs(sink)):
            with self.assertRaises(ValueError):
                with ins.with_orgiq_root(ins.TraceContext(), "a", "A"):
                    raise ValueError("agent failed")


class RetrieverSpanTests(unittest.TestCase):
    def test_degrades_to_a_no_op_when_otel_is_absent(self):
        with mock.patch.dict(sys.modules, {"opentelemetry": None}):
            with ins.retriever_span("kb.retrieve", "who knows auth?") as span:
                self.assertIsNone(span)

    def test_kind_and_query_are_stamped(self):
        sink = []
        with mock.patch.dict(sys.modules, _otel_stubs(sink)):
            with ins.retriever_span("kb.retrieve", "who knows auth?") as span:
                pass
        self.assertEqual(span.attributes["openinference.span.kind"], "RETRIEVER")
        self.assertEqual(span.attributes["input.value"], "who knows auth?")
        self.assertEqual(span.attributes["input.mime_type"], "text/plain")

    def test_long_query_is_capped(self):
        sink = []
        with mock.patch.dict(sys.modules, _otel_stubs(sink)):
            with ins.retriever_span("kb.retrieve", "x" * 5000) as span:
                pass
        self.assertEqual(len(span.attributes["input.value"]), 2000)

    def test_empty_query_does_not_crash(self):
        sink = []
        with mock.patch.dict(sys.modules, _otel_stubs(sink)):
            with ins.retriever_span("kb.retrieve", "") as span:
                pass
        self.assertEqual(span.attributes["input.value"], "")


class RetrievalDocumentTests(unittest.TestCase):
    def test_flattened_openinference_attribute_names(self):
        span = _FakeSpan("kb.retrieve")
        ins.record_retrieval_documents(
            span,
            [
                {"id": "d1", "score": 0.91, "content": "auth notes",
                 "metadata": {"uri": "s3://x"}},
                {"source": "s3://y", "text": "second"},
            ],
        )
        self.assertEqual(span.attributes["retrieval.documents.0.document.id"], "d1")
        self.assertEqual(span.attributes["retrieval.documents.0.document.score"], 0.91)
        self.assertEqual(
            span.attributes["retrieval.documents.0.document.content"], "auth notes"
        )
        self.assertEqual(
            json.loads(span.attributes["retrieval.documents.0.document.metadata"]),
            {"uri": "s3://x"},
        )
        # Second doc falls back to `source` for the id and `text` for content.
        self.assertEqual(span.attributes["retrieval.documents.1.document.id"], "s3://y")
        self.assertEqual(
            span.attributes["retrieval.documents.1.document.content"], "second"
        )

    def test_id_falls_back_to_the_index(self):
        span = _FakeSpan("kb.retrieve")
        ins.record_retrieval_documents(span, [{"content": "no id here"}])
        self.assertEqual(span.attributes["retrieval.documents.0.document.id"], "doc-0")

    def test_content_is_capped(self):
        span = _FakeSpan("kb.retrieve")
        ins.record_retrieval_documents(span, [{"id": "d", "content": "z" * 9000}])
        self.assertEqual(
            len(span.attributes["retrieval.documents.0.document.content"]), 2000
        )

    def test_unscorable_score_is_skipped_not_fatal(self):
        span = _FakeSpan("kb.retrieve")
        ins.record_retrieval_documents(span, [{"id": "d", "score": "high"}])
        self.assertNotIn("retrieval.documents.0.document.score", span.attributes)
        self.assertEqual(span.attributes["retrieval.documents.0.document.id"], "d")

    def test_no_span_and_no_documents_are_both_no_ops(self):
        ins.record_retrieval_documents(None, [{"id": "d"}])
        ins.record_retrieval_documents(_FakeSpan("s"), [])

    def test_non_dict_documents_are_skipped(self):
        span = _FakeSpan("kb.retrieve")
        ins.record_retrieval_documents(span, ["a string", {"id": "d"}])
        self.assertEqual(span.attributes["retrieval.documents.1.document.id"], "d")


class GuardrailCaptureTests(unittest.TestCase):
    def test_attribute_names_match_the_span_projector(self):
        span = _FakeSpan("orgiq.agent.invoke")
        ins.record_guardrail_action(span, "GUARDRAIL_INTERVENED", pii_detected=True)
        self.assertEqual(
            span.attributes,
            {"orgiq.guardrail_action": "GUARDRAIL_INTERVENED", "orgiq.pii_detected": True},
        )

    def test_pii_false_is_recorded(self):
        span = _FakeSpan("orgiq.agent.invoke")
        ins.record_guardrail_action(span, "NONE", pii_detected=False)
        self.assertIs(span.attributes["orgiq.pii_detected"], False)

    def test_no_span_is_a_no_op(self):
        ins.record_guardrail_action(None, "GUARDRAIL_INTERVENED", True)

    def test_a_span_that_rejects_attributes_does_not_crash_the_agent(self):
        class Hostile:
            def set_attribute(self, *_a):
                raise RuntimeError("span already ended")

        ins.record_guardrail_action(Hostile(), "NONE", False)


class ShortHashTests(unittest.TestCase):
    def test_twelve_hex_chars_matching_the_middleware_shorthash(self):
        import hashlib

        text = "You are the OrgIQ Search agent."
        got = ins.short_prompt_hash(text)
        self.assertEqual(len(got), 12)
        self.assertEqual(
            got, hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]
        )

    def test_stable_across_calls_and_sensitive_to_edits(self):
        a = ins.short_prompt_hash("prompt")
        self.assertEqual(a, ins.short_prompt_hash("prompt"))
        self.assertNotEqual(a, ins.short_prompt_hash("prompt "))


if __name__ == "__main__":
    unittest.main(verbosity=2)
