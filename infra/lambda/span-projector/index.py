"""
Span Projector Lambda — OI Phase 3.

Polls CloudWatch Logs Insights for OI-attributed OTel spans emitted by
AgentCore Runtime, reconstructs trace trees, and projects each trace into:
  - observability.invocation_traces
  - observability.tool_calls
via the Aurora RDS Data API.

Triggered by EventBridge on a 1-minute schedule. Idempotent via
ON CONFLICT (invocation_id) DO NOTHING.
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any

import boto3

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)

# ---------------------------------------------------------------------------
# Boto3 clients (module-level for Lambda container reuse)
# ---------------------------------------------------------------------------

logs_client = boto3.client("logs")
rds_data_client = boto3.client("rds-data")
ssm_client = boto3.client("ssm")

# ---------------------------------------------------------------------------
# Environment variables
# ---------------------------------------------------------------------------

AURORA_CLUSTER_ARN = os.environ["AURORA_CLUSTER_ARN"]
AURORA_SECRET_ARN = os.environ["AURORA_SECRET_ARN"]
AURORA_DATABASE = os.environ.get("AURORA_DATABASE", "orgiq")
CURSOR_PARAM_NAME = os.environ.get("CURSOR_PARAM_NAME", "/orgiq/span-projector/cursor")

# Optional: if Phase 2 collector is deployed, also poll this log group
OPTIONAL_OTEL_LOG_GROUP = os.environ.get("OTEL_LOG_GROUP", "")

# Sliding-window fallback (seconds) when no cursor is saved yet
DEFAULT_LOOKBACK_SECONDS = 300  # 5 minutes

# CloudWatch Insights query timeout (seconds)
CW_QUERY_TIMEOUT_SECONDS = 55  # stay well within Lambda 5-min limit

# ---------------------------------------------------------------------------
# Cursor helpers (SSM Parameter Store)
# ---------------------------------------------------------------------------


def get_cursor() -> int:
    """
    Return the last-processed epoch-ms timestamp from SSM, or
    (now - DEFAULT_LOOKBACK_SECONDS) if the parameter is missing / unparseable.
    """
    try:
        resp = ssm_client.get_parameter(Name=CURSOR_PARAM_NAME)
        raw = resp["Parameter"]["Value"].strip()
        if raw == "0" or raw == "":
            raise ValueError("initial value")
        # Accept both ISO strings and raw epoch-ms integers
        try:
            return int(raw)
        except ValueError:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            return int(dt.timestamp() * 1000)
    except ssm_client.exceptions.ParameterNotFound:
        pass
    except Exception as exc:  # noqa: BLE001
        logger.warning("get_cursor error: %s — using default lookback", exc)

    return int((time.time() - DEFAULT_LOOKBACK_SECONDS) * 1000)


def save_cursor(epoch_ms: int) -> None:
    """Persist the high-water mark to SSM."""
    try:
        ssm_client.put_parameter(
            Name=CURSOR_PARAM_NAME,
            Value=str(epoch_ms),
            Type="String",
            Overwrite=True,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("save_cursor error: %s", exc)


# ---------------------------------------------------------------------------
# Log group discovery
# ---------------------------------------------------------------------------


def discover_log_groups() -> list[str]:
    """
    Return the list of CW log group names to poll.

    Always includes:
      /aws/bedrock-agentcore/runtimes/*-DEFAULT

    Optionally includes OPTIONAL_OTEL_LOG_GROUP if the env var is set.
    """
    groups: list[str] = []

    try:
        paginator = logs_client.get_paginator("describe_log_groups")
        page_iterator = paginator.paginate(
            logGroupNamePrefix="/aws/bedrock-agentcore/runtimes/"
        )
        for page in page_iterator:
            for lg in page.get("logGroups", []):
                name = lg.get("logGroupName", "")
                if name.endswith("-DEFAULT"):
                    groups.append(name)
    except Exception as exc:  # noqa: BLE001
        logger.warning("discover_log_groups error: %s", exc)

    if OPTIONAL_OTEL_LOG_GROUP:
        groups.append(OPTIONAL_OTEL_LOG_GROUP)

    logger.info("Polling %d log group(s): %s", len(groups), groups)
    return groups


# ---------------------------------------------------------------------------
# CloudWatch Logs Insights query
# ---------------------------------------------------------------------------

_CW_QUERY = (
    "filter @message like 'ORGIQ_OI_SPAN:' "
    "| display @message "
    "| limit 10000"
)
_OI_PREFIX = "ORGIQ_OI_SPAN:"


def query_logs(log_group: str, start_time_ms: int, end_time_ms: int) -> list[dict]:
    """
    Run a CW Logs Insights query on *log_group* for the given time window.
    Returns a list of parsed span dicts. Bad/unparseable results are skipped.
    """
    try:
        resp = logs_client.start_query(
            logGroupName=log_group,
            startTime=start_time_ms // 1000,
            endTime=end_time_ms // 1000,
            queryString=_CW_QUERY,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("start_query failed for %s: %s", log_group, exc)
        return []

    query_id = resp["queryId"]
    deadline = time.time() + CW_QUERY_TIMEOUT_SECONDS

    while True:
        if time.time() >= deadline:
            logger.warning("CW Insights query %s timed out — stopping query", query_id)
            try:
                logs_client.stop_query(queryId=query_id)
            except Exception:  # noqa: BLE001
                pass
            return []

        try:
            result = logs_client.get_query_results(queryId=query_id)
        except Exception as exc:  # noqa: BLE001
            logger.warning("get_query_results error for query %s: %s", query_id, exc)
            return []

        status = result.get("status", "")
        if status in ("Complete", "Failed", "Cancelled", "Timeout"):
            if status != "Complete":
                logger.warning(
                    "CW Insights query %s ended with status %s", query_id, status
                )
                return []
            break

        time.sleep(2)

    spans: list[dict] = []
    for row in result.get("results", []):
        # Each row is a list of {"field": str, "value": str} dicts
        field_map: dict[str, str] = {item["field"]: item["value"] for item in row}
        raw_message = field_map.get("@message", "")
        # Strip the ORGIQ_OI_SPAN: prefix that the agent's ConsoleSpanExporter
        # formatter prepends. Trim trailing whitespace + newline.
        idx = raw_message.find(_OI_PREFIX)
        if idx < 0:
            continue
        raw_json = raw_message[idx + len(_OI_PREFIX):].strip()
        try:
            span = json.loads(raw_json)
            if isinstance(span, dict):
                spans.append(span)
        except Exception:  # noqa: BLE001
            pass

    logger.info("log group %s: found %d OI spans", log_group, len(spans))
    return spans


# ---------------------------------------------------------------------------
# Span helpers
# ---------------------------------------------------------------------------


def _attr(span: dict, key: str, default: Any = None) -> Any:
    """Safely retrieve a span attribute by key."""
    try:
        attrs = span.get("attributes", {})
        if isinstance(attrs, dict):
            return attrs.get(key, default)
        # Some exporters encode attributes as a list of {key, value} dicts
        if isinstance(attrs, list):
            for item in attrs:
                if isinstance(item, dict) and item.get("key") == key:
                    v = item.get("value", {})
                    if isinstance(v, dict):
                        # OTel OTLP JSON: {"stringValue": "..."} etc.
                        for vk in ("stringValue", "intValue", "doubleValue", "boolValue"):
                            if vk in v:
                                return v[vk]
                    return v
    except Exception:  # noqa: BLE001
        pass
    return default


def _span_duration_ms(span: dict) -> int:
    """Return span wall-clock duration in milliseconds."""
    try:
        start = int(span.get("start_time_unix_nano", 0))
        end = int(span.get("end_time_unix_nano", 0))
        if start and end and end >= start:
            return (end - start) // 1_000_000
    except Exception:  # noqa: BLE001
        pass
    return 0


def _span_start_iso(span: dict) -> str:
    """Return span start as ISO 8601 UTC string."""
    try:
        nanos = int(span.get("start_time_unix_nano", 0))
        if nanos:
            secs = nanos / 1e9
            return datetime.fromtimestamp(secs, tz=timezone.utc).isoformat()
    except Exception:  # noqa: BLE001
        pass
    return datetime.now(tz=timezone.utc).isoformat()


def _is_oi_span(span: dict) -> bool:
    return bool(_attr(span, "openinference.span.kind"))


# ---------------------------------------------------------------------------
# Trace grouping
# ---------------------------------------------------------------------------


def group_into_traces(spans: list[dict]) -> dict[str, list[dict]]:
    """Group spans by trace_id. Only OI-attributed spans are included."""
    traces: dict[str, list[dict]] = {}
    for span in spans:
        try:
            if not _is_oi_span(span):
                continue
            tid = span.get("trace_id", "")
            if not tid:
                continue
            traces.setdefault(tid, []).append(span)
        except Exception:  # noqa: BLE001
            pass
    return traces


# ---------------------------------------------------------------------------
# Payload builder
# ---------------------------------------------------------------------------


def build_invocation_payload(trace_spans: list[dict]) -> dict | None:
    """
    Given a list of spans sharing a trace_id, find the root AGENT span and
    build a TraceInput dict ready for Aurora insertion.

    Returns None if the trace has no valid root AGENT span.
    """
    # --- Find root span ---
    root: dict | None = None
    for span in trace_spans:
        try:
            kind = _attr(span, "openinference.span.kind", "")
            parent_id = span.get("parent_span_id", "")
            if kind == "AGENT" and (not parent_id or parent_id == "0000000000000000"):
                root = span
                break
        except Exception:  # noqa: BLE001
            pass

    # Fall back: first span without a parent
    if root is None:
        for span in trace_spans:
            try:
                parent_id = span.get("parent_span_id", "")
                if not parent_id or parent_id == "0000000000000000":
                    root = span
                    break
            except Exception:  # noqa: BLE001
                pass

    if root is None:
        logger.debug("No root span found in trace with %d spans", len(trace_spans))
        return None

    invocation_id = _attr(root, "orgiq.invocation_id") or root.get("span_id", "")
    if not invocation_id:
        return None

    # --- Aggregate child spans ---
    prompt_tokens = 0
    completion_tokens = 0
    first_model: str | None = None
    tool_calls: list[dict] = []

    for span in trace_spans:
        try:
            if span is root:
                continue
            kind = _attr(span, "openinference.span.kind", "")

            if kind == "LLM":
                prompt_tokens += int(_attr(span, "llm.token_count.prompt", 0) or 0)
                completion_tokens += int(_attr(span, "llm.token_count.completion", 0) or 0)
                if first_model is None:
                    first_model = _attr(span, "llm.model_name")

            elif kind == "TOOL":
                tool_name = _attr(span, "tool.name") or span.get("name", "unknown_tool")
                input_val = str(_attr(span, "input.value", "") or "")
                output_val = str(_attr(span, "output.value", "") or "")
                errored = span.get("status", {}).get("code", "") == "ERROR" if isinstance(
                    span.get("status"), dict
                ) else False
                error_msg: str | None = None
                if errored:
                    error_msg = (
                        span.get("status", {}).get("message")
                        if isinstance(span.get("status"), dict)
                        else None
                    )

                tool_calls.append(
                    {
                        "toolName": tool_name,
                        "startedAt": _span_start_iso(span),
                        "durationMs": _span_duration_ms(span),
                        "inputSize": len(input_val),
                        "outputSize": len(output_val),
                        "errored": errored,
                        "errorMessage": error_msg,
                        "inputSample": input_val[:500],
                        "outputSample": output_val[:500],
                    }
                )
        except Exception as exc:  # noqa: BLE001
            logger.debug("Error processing child span: %s", exc)

    payload: dict = {
        "invocationId": invocation_id,
        "agentId": _attr(root, "orgiq.agent_id") or "",
        "agentName": _attr(root, "orgiq.agent_name") or root.get("name", ""),
        "templateId": _attr(root, "orgiq.template_id"),
        "prompt": _attr(root, "input.value") or "",
        "response": _attr(root, "output.value") or "",
        "modelId": first_model,
        "promptVersion": _attr(root, "orgiq.prompt_version"),
        "inputTokens": prompt_tokens,
        "outputTokens": completion_tokens,
        "durationMs": _span_duration_ms(root),
        "parentInvocationId": _attr(root, "orgiq.parent_invocation_id"),
        "userId": _attr(root, "orgiq.user_id") or _attr(root, "user.id"),
        "sessionId": _attr(root, "orgiq.session_id") or _attr(root, "session.id"),
        "guardrailAction": _attr(root, "orgiq.guardrail_action"),
        "piiDetected": _attr(root, "orgiq.pii_detected"),
        "toolCalls": tool_calls,
    }
    return payload


# ---------------------------------------------------------------------------
# Aurora insert (RDS Data API)
# ---------------------------------------------------------------------------

_INSERT_INVOCATION_SQL = """
INSERT INTO observability.invocation_traces (
  invocation_id, agent_id, agent_name, template_id,
  prompt, response, model_id, prompt_version,
  input_tokens, output_tokens, duration_ms,
  parent_invocation_id, user_id, session_id,
  guardrail_action, pii_detected,
  created_at
) VALUES (
  :invocation_id, :agent_id, :agent_name, :template_id,
  :prompt, :response, :model_id, :prompt_version,
  :input_tokens, :output_tokens, :duration_ms,
  :parent_invocation_id, :user_id, :session_id,
  :guardrail_action, :pii_detected,
  NOW()
)
ON CONFLICT (invocation_id) DO NOTHING
"""

_INSERT_TOOL_CALL_SQL = """
INSERT INTO observability.tool_calls (
  invocation_id, tool_name, started_at, duration_ms,
  input_size, output_size, errored, error_message,
  input_sample, output_sample
) VALUES (
  :invocation_id, :tool_name, :started_at::timestamptz, :duration_ms,
  :input_size, :output_size, :errored, :error_message,
  :input_sample, :output_sample
)
ON CONFLICT DO NOTHING
"""


def _str_param(name: str, value: Any) -> dict:
    if value is None:
        return {"name": name, "value": {"isNull": True}}
    return {"name": name, "value": {"stringValue": str(value)}}


def _int_param(name: str, value: Any) -> dict:
    if value is None:
        return {"name": name, "value": {"isNull": True}}
    return {"name": name, "value": {"longValue": int(value)}}


def _bool_param(name: str, value: Any) -> dict:
    if value is None:
        return {"name": name, "value": {"isNull": True}}
    return {"name": name, "value": {"booleanValue": bool(value)}}


def insert_aurora(payload: dict) -> None:
    """Insert one trace + its tool calls into Aurora via RDS Data API."""
    invocation_id = payload["invocationId"]

    invocation_params = [
        _str_param("invocation_id", invocation_id),
        _str_param("agent_id", payload.get("agentId")),
        _str_param("agent_name", payload.get("agentName")),
        _str_param("template_id", payload.get("templateId")),
        _str_param("prompt", payload.get("prompt")),
        _str_param("response", payload.get("response")),
        _str_param("model_id", payload.get("modelId")),
        _str_param("prompt_version", payload.get("promptVersion")),
        _int_param("input_tokens", payload.get("inputTokens")),
        _int_param("output_tokens", payload.get("outputTokens")),
        _int_param("duration_ms", payload.get("durationMs")),
        _str_param("parent_invocation_id", payload.get("parentInvocationId")),
        _str_param("user_id", payload.get("userId")),
        _str_param("session_id", payload.get("sessionId")),
        _str_param("guardrail_action", payload.get("guardrailAction")),
        _bool_param("pii_detected", payload.get("piiDetected")),
    ]

    try:
        rds_data_client.execute_statement(
            resourceArn=AURORA_CLUSTER_ARN,
            secretArn=AURORA_SECRET_ARN,
            database=AURORA_DATABASE,
            sql=_INSERT_INVOCATION_SQL,
            parameters=invocation_params,
        )
        logger.info("Inserted/skipped invocation trace: %s", invocation_id)
    except Exception as exc:  # noqa: BLE001
        logger.error("Failed to insert invocation_trace %s: %s", invocation_id, exc)
        return

    for tc in payload.get("toolCalls", []):
        try:
            tool_params = [
                _str_param("invocation_id", invocation_id),
                _str_param("tool_name", tc.get("toolName")),
                _str_param("started_at", tc.get("startedAt")),
                _int_param("duration_ms", tc.get("durationMs")),
                _int_param("input_size", tc.get("inputSize")),
                _int_param("output_size", tc.get("outputSize")),
                _bool_param("errored", tc.get("errored")),
                _str_param("error_message", tc.get("errorMessage")),
                _str_param("input_sample", tc.get("inputSample")),
                _str_param("output_sample", tc.get("outputSample")),
            ]
            rds_data_client.execute_statement(
                resourceArn=AURORA_CLUSTER_ARN,
                secretArn=AURORA_SECRET_ARN,
                database=AURORA_DATABASE,
                sql=_INSERT_TOOL_CALL_SQL,
                parameters=tool_params,
            )
        except Exception as exc:  # noqa: BLE001
            logger.error(
                "Failed to insert tool_call %s/%s: %s",
                invocation_id,
                tc.get("toolName"),
                exc,
            )


# ---------------------------------------------------------------------------
# Lambda entry point
# ---------------------------------------------------------------------------


def lambda_handler(event: dict, context: Any) -> dict:  # noqa: ARG001
    """
    Main entry point. Called by EventBridge on a 1-minute schedule.

    1. Determine the polling window from the SSM cursor.
    2. Discover AgentCore runtime log groups (+ optional OTel log group).
    3. For each log group, run CW Insights to fetch OI spans.
    4. Group spans into traces and project each trace to Aurora.
    5. Advance the cursor to end_time_ms.
    """
    start_time_ms = get_cursor()
    end_time_ms = int(time.time() * 1000)

    if end_time_ms <= start_time_ms:
        logger.info("No new time window to process (cursor is up to date).")
        return {"status": "ok", "traces_projected": 0}

    log_groups = discover_log_groups()
    if not log_groups:
        logger.info("No log groups to poll. Advancing cursor.")
        save_cursor(end_time_ms)
        return {"status": "ok", "traces_projected": 0}

    all_spans: list[dict] = []
    for lg in log_groups:
        try:
            spans = query_logs(lg, start_time_ms, end_time_ms)
            all_spans.extend(spans)
        except Exception as exc:  # noqa: BLE001
            logger.error("Unhandled error querying log group %s: %s", lg, exc)

    traces = group_into_traces(all_spans)
    logger.info(
        "Total spans: %d | distinct traces: %d", len(all_spans), len(traces)
    )

    projected = 0
    for trace_id, trace_spans in traces.items():
        try:
            payload = build_invocation_payload(trace_spans)
            if payload is None:
                logger.debug("Skipping trace %s — no valid root span", trace_id)
                continue
            insert_aurora(payload)
            projected += 1
        except Exception as exc:  # noqa: BLE001
            logger.error("Unhandled error projecting trace %s: %s", trace_id, exc)

    save_cursor(end_time_ms)
    logger.info("Projection complete. Traces projected: %d", projected)
    return {"status": "ok", "traces_projected": projected}
