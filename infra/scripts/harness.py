#!/usr/bin/env python3
"""
OrgIQ test harness runner.

Two modes, picked with --mode {live,sim}:

  * sim  — call Bedrock Nova-Pro directly with each agent's role-play
            system prompt from infra/scripts/agent_prompts.yaml. This is the
            legacy path: judges what the prompt SHOULD do, not what the
            deployed agent actually does. Cheap + fast + reproducible.

  * live — invoke the deployed AgentCore runtimes via
            bedrock-agentcore.invoke_agent_runtime. This exercises the
            ACTUAL deployed image with the ACTUAL tool plumbing, A2A links,
            and agent code. May fail in ways sim never sees — that's the
            point. Closes the simulation/reality gap.

Both modes push the response through the middleware trace-sink for judging
+ schema validation, stamp prompt+model provenance, and record pass/fail in
observability.test_results.

Middleware contract:
    POST   /api/observability/prompt-versions               -> {promptVersion}
    POST   /api/observability/harness/runs                  -> {runId}
    POST   /api/observability/harness/trace                 -> {..., est_cost_usd, ...}
    POST   /api/observability/harness/runs/{id}/results
    PATCH  /api/observability/harness/runs/{id}
    GET    /api/observability/harness/runs/{id}

Usage:
    python3 infra/scripts/harness.py list
    python3 infra/scripts/harness.py run --label "..." --mode live
    python3 infra/scripts/harness.py run --case search.expert.k8s.001 --mode sim
    python3 infra/scripts/harness.py status <run_id>
    python3 infra/scripts/harness.py diff <run_a> <run_b>

Env:
    MIDDLEWARE_URL   default http://localhost:3001
    AWS credentials  via boto3 default chain (SSO profile is fine)
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REGION = "us-east-1"
DATABASE = "orgiq"
NOVA_PRO_MODEL_ID = "amazon.nova-pro-v1:0"
DEFAULT_MIDDLEWARE = os.environ.get("MIDDLEWARE_URL", "http://localhost:3001")
DEFAULT_MODE = "live"   # Sprint 1 default — exercise the deployed runtimes.

# ── Sprint 2: boto3 timeout tuning ────────────────────────────────────────────
# bedrock-agentcore.invoke_agent_runtime is the slowest call in live mode and
# has been hitting 312s read-timeouts in observed runs. Cap it at 120s so
# live-mode runs fail fast (and the operator gets a clear signal) rather than
# the runner appearing to hang for 5 minutes per case.
LIVE_INVOKE_READ_TIMEOUT_S = int(os.environ.get("HARNESS_INVOKE_READ_TIMEOUT", "120"))
LIVE_INVOKE_CONNECT_TIMEOUT_S = int(os.environ.get("HARNESS_INVOKE_CONNECT_TIMEOUT", "10"))
LIVE_INVOKE_MAX_RETRIES = int(os.environ.get("HARNESS_INVOKE_MAX_RETRIES", "2"))

# Bedrock pricing (USD per 1K tokens) — must match middleware/src/lib/pricing.ts.
# Duplicated here so the runner can compute est_cost_usd for test_results
# without round-tripping through middleware just for the math.
BEDROCK_PRICING_PER_1K: dict[str, tuple[float, float]] = {
    "amazon.nova-pro-v1:0":         (0.0008,   0.0032),
    "amazon.nova-lite-v1:0":        (0.00006,  0.00024),
    "amazon.nova-micro-v1:0":       (0.000035, 0.00014),
    "amazon.titan-embed-text-v2:0": (0.00002,  0.0),
}

SCRIPT_DIR = Path(__file__).resolve().parent
PROMPTS_PATH = SCRIPT_DIR / "agent_prompts.yaml"

# ── Lazy imports so `list` and `diff` work without boto3 installed ───────────


def _boto3():
    import boto3  # type: ignore
    return boto3


def _load_yaml(path: Path) -> dict[str, str]:
    """Minimal YAML loader. Tries pyyaml; falls back to a tiny parser that
    handles the limited shape used by agent_prompts.yaml (`key: |` block scalars
    + `#` comments)."""
    text = path.read_text(encoding="utf-8")
    try:
        import yaml  # type: ignore
        return yaml.safe_load(text)
    except ImportError:
        pass

    out: dict[str, str] = {}
    cur_key: str | None = None
    cur_lines: list[str] = []
    indent: int | None = None
    for raw in text.splitlines():
        if cur_key is not None:
            if not raw.strip():
                cur_lines.append("")
                continue
            stripped_indent = len(raw) - len(raw.lstrip(" "))
            if indent is None:
                indent = stripped_indent
            if stripped_indent >= indent:
                cur_lines.append(raw[indent:])
                continue
            # dedent → close block
            out[cur_key] = "\n".join(cur_lines).rstrip() + "\n"
            cur_key, cur_lines, indent = None, [], None
        line = raw.rstrip()
        if not line or line.lstrip().startswith("#"):
            continue
        m = re.match(r"^([A-Za-z0-9_.\-]+):\s*\|\s*$", line)
        if m:
            cur_key = m.group(1)
            cur_lines = []
            indent = None
            continue
    if cur_key is not None:
        out[cur_key] = "\n".join(cur_lines).rstrip() + "\n"
    return out


# ── Aurora RDS Data API helpers (boto3 client) ────────────────────────────────


def _cf_output(stack: str, key: str) -> str:
    r = subprocess.run(
        [
            "aws", "cloudformation", "describe-stacks",
            "--stack-name", stack, "--region", REGION,
            "--query", f"Stacks[0].Outputs[?OutputKey=='{key}'].OutputValue",
            "--output", "text",
        ],
        capture_output=True, text=True, check=True,
    )
    return r.stdout.strip()


_RDS_CACHE: dict[str, str] = {}


def _rds_arns() -> tuple[str, str]:
    if "cluster" not in _RDS_CACHE:
        _RDS_CACHE["cluster"] = _cf_output("OrgIQ-Aurora", "ClusterArn")
        _RDS_CACHE["secret"] = _cf_output("OrgIQ-Aurora", "CredentialsSecretArn")
    return _RDS_CACHE["cluster"], _RDS_CACHE["secret"]


def _rds_client():
    return _boto3().client("rds-data", region_name=REGION)


def _execute_statement(sql: str, parameters: list[dict] | None = None) -> dict:
    cluster_arn, secret_arn = _rds_arns()
    client = _rds_client()
    kwargs: dict[str, Any] = {
        "resourceArn": cluster_arn,
        "secretArn": secret_arn,
        "database": DATABASE,
        "sql": sql,
        "includeResultMetadata": True,
    }
    if parameters:
        kwargs["parameters"] = parameters
    return client.execute_statement(**kwargs)


def _records_to_dicts(resp: dict) -> list[dict[str, Any]]:
    cols = [c["name"] for c in resp.get("columnMetadata", [])]
    out: list[dict[str, Any]] = []
    for row in resp.get("records", []):
        d: dict[str, Any] = {}
        for col, field in zip(cols, row):
            if field.get("isNull"):
                d[col] = None
            elif "stringValue" in field:
                d[col] = field["stringValue"]
            elif "longValue" in field:
                d[col] = field["longValue"]
            elif "doubleValue" in field:
                d[col] = field["doubleValue"]
            elif "booleanValue" in field:
                d[col] = field["booleanValue"]
            else:
                d[col] = next(iter(field.values()))
        out.append(d)
    return out


def fetch_active_cases(
    case_id: str | None = None,
    agent_id: str | None = None,
) -> list[dict[str, Any]]:
    sql = """
        SELECT test_id, agent_id, template_id, prompt, reference_output,
               expected_tags::text AS expected_tags,
               pass_threshold::text AS pass_threshold,
               notes
        FROM observability.test_cases
        WHERE active = true
    """
    params: list[dict] = []
    if case_id:
        sql += " AND test_id = :case_id"
        params.append({"name": "case_id", "value": {"stringValue": case_id}})
    if agent_id:
        sql += " AND agent_id = :agent_id"
        params.append({"name": "agent_id", "value": {"stringValue": agent_id}})
    sql += " ORDER BY agent_id, test_id"
    resp = _execute_statement(sql, params)
    rows = _records_to_dicts(resp)
    for r in rows:
        try:
            r["expected_tags"] = json.loads(r.get("expected_tags") or "[]")
        except (json.JSONDecodeError, TypeError):
            r["expected_tags"] = []
        try:
            r["pass_threshold"] = float(r["pass_threshold"])
        except (TypeError, ValueError):
            r["pass_threshold"] = 0.7
    return rows


# ── HTTP helpers (urllib stdlib) ──────────────────────────────────────────────


class HttpError(RuntimeError):
    def __init__(self, method: str, url: str, status: int, body: str) -> None:
        super().__init__(f"{method} {url} -> {status}: {body[:300]}")
        self.status = status
        self.body = body


def _http(method: str, url: str, body: dict | None = None, timeout: int = 60) -> dict:
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            if not raw:
                return {}
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                return {"_raw": raw}
    except urllib.error.HTTPError as e:
        body_text = e.read().decode("utf-8", errors="replace") if e.fp else ""
        raise HttpError(method, url, e.code, body_text) from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"{method} {url} failed: {e.reason}") from None


# ── Bedrock Converse call (sim mode) ──────────────────────────────────────────


def estimate_cost_usd(model_id: str, input_tokens: int, output_tokens: int) -> float:
    """Mirror of middleware.lib.pricing.estimateCost. Returns 0 for unknown ids."""
    price = BEDROCK_PRICING_PER_1K.get(model_id)
    if not price:
        return 0.0
    return (input_tokens / 1000.0) * price[0] + (output_tokens / 1000.0) * price[1]


def call_bedrock(system_prompt: str, user_prompt: str) -> tuple[str, int, int, int]:
    """Sim-mode invocation. Returns (response_text, duration_ms, input_tokens,
    output_tokens). Raises on failure.

    The Converse response includes a `usage` block; we surface it so the
    runner can populate trace + test_results with real token counts and let
    the middleware compute (and persist) the cost.
    """
    bedrock = _boto3().client("bedrock-runtime", region_name=REGION)
    t0 = time.perf_counter()
    resp = bedrock.converse(
        modelId=NOVA_PRO_MODEL_ID,
        system=[{"text": system_prompt}],
        messages=[{"role": "user", "content": [{"text": user_prompt}]}],
        inferenceConfig={"temperature": 0.0, "maxTokens": 600},
    )
    duration_ms = int((time.perf_counter() - t0) * 1000)
    parts = resp.get("output", {}).get("message", {}).get("content", [])
    text = "".join(p.get("text", "") for p in parts).strip()
    usage = resp.get("usage", {}) or {}
    input_tokens = int(usage.get("inputTokens") or 0)
    output_tokens = int(usage.get("outputTokens") or 0)
    return text, duration_ms, input_tokens, output_tokens


# ── AgentCore Runtime call (live mode) ────────────────────────────────────────

_AGENT_ARN_CACHE: dict[str, str] = {}

# Track which agents emitted a missing-tokens warning so we only print it once
# per agent per run. The first miss is signal ("instrument this agent"); the
# subsequent ones are noise.
_TOKEN_MISS_WARNED: set[str] = set()


def _live_botocore_config():
    """Tighter timeouts for live-mode runtime calls — see comment near the
    LIVE_INVOKE_* constants. Lazy-imported so `list`/`diff` paths still work
    without botocore installed."""
    from botocore.config import Config  # type: ignore
    return Config(
        read_timeout=LIVE_INVOKE_READ_TIMEOUT_S,
        connect_timeout=LIVE_INVOKE_CONNECT_TIMEOUT_S,
        retries={"max_attempts": LIVE_INVOKE_MAX_RETRIES},
    )


def _load_agent_runtime_arns() -> dict[str, str]:
    """Map agentRuntimeName -> agentRuntimeArn. Cached for the run."""
    if _AGENT_ARN_CACHE:
        return _AGENT_ARN_CACHE
    ctrl = _boto3().client(
        "bedrock-agentcore-control",
        region_name=REGION,
        config=_live_botocore_config(),
    )
    # The SDK paginates by maxResults; agents are 6 today, but query 50 to be safe.
    runtimes: list[dict] = []
    next_token: str | None = None
    while True:
        kwargs: dict[str, Any] = {"maxResults": 50}
        if next_token:
            kwargs["nextToken"] = next_token
        resp = ctrl.list_agent_runtimes(**kwargs)
        runtimes.extend(resp.get("agentRuntimes", []))
        next_token = resp.get("nextToken")
        if not next_token:
            break
    for r in runtimes:
        name = r.get("agentRuntimeName")
        arn = r.get("agentRuntimeArn")
        if name and arn:
            _AGENT_ARN_CACHE[name] = arn
    return _AGENT_ARN_CACHE


def _agent_id_to_runtime_name(agent_id: str) -> str:
    """orgiq-supervisor -> orgiq_supervisor (deployed runtimes use _)."""
    return agent_id.replace("-", "_")


def _extract_usage(obj: dict) -> dict:
    """Pull a usage block out of an agent response.

    Tried in order (Sprint 2):
        1. ``usage`` at top level — Strands ``@entrypoint`` returning the
           Converse response directly.
        2. ``metadata.usage`` — some Strands integrations nest it.
        3. ``response.usage`` (or any nested dict's ``usage``) — when the
           agent emitted its own trace bundle inline as the response payload.

    Returns ``{}`` when no shape matches. The caller decides whether ``{}``
    means "missing — warn the operator" or just "skip cost calc".
    """
    if not isinstance(obj, dict):
        return {}
    usage = obj.get("usage")
    if isinstance(usage, dict) and usage:
        return usage
    meta = obj.get("metadata")
    if isinstance(meta, dict):
        u = meta.get("usage")
        if isinstance(u, dict) and u:
            return u
    # Some agents include their own trace bundle under `response` — e.g. if
    # they wrap the Bedrock Converse result before returning. Walk one level.
    nested = obj.get("response")
    if isinstance(nested, dict):
        u = nested.get("usage")
        if isinstance(u, dict) and u:
            return u
        nm = nested.get("metadata")
        if isinstance(nm, dict):
            u = nm.get("usage")
            if isinstance(u, dict) and u:
                return u
    return {}


def _parse_agent_response(body_bytes: bytes) -> tuple[str, dict]:
    """Extract (response_text, usage_dict) from an AgentCore invocation body.

    AgentCore runtimes don't publish a single canonical response shape — each
    agent's Strands/AG-UI handler dictates it. We try the most common shapes
    in order:
        1. JSON with `response` (Strands @entrypoint default)
        2. JSON with `message` (older Strands shape)
        3. JSON-lines stream — last line is treated as the final message
        4. Raw text fallback
    Usage is extracted via :func:`_extract_usage` (top-level, metadata.usage,
    or response.usage when the agent emitted its trace bundle inline).
    """
    if not body_bytes:
        return "", {}
    raw = body_bytes.decode("utf-8", errors="replace").strip()
    if not raw:
        return "", {}

    # Try whole-body JSON first.
    try:
        obj = json.loads(raw)
        if isinstance(obj, dict):
            text = obj.get("response") or obj.get("message") or obj.get("text") or ""
            if not text and "output" in obj:
                text = str(obj["output"])
            usage = _extract_usage(obj)
            return str(text), usage
        if isinstance(obj, str):
            return obj, {}
    except json.JSONDecodeError:
        pass

    # Try JSON-lines: parse last non-empty line.
    lines = [ln for ln in raw.splitlines() if ln.strip()]
    if lines:
        last = lines[-1]
        try:
            obj = json.loads(last)
            if isinstance(obj, dict):
                text = obj.get("response") or obj.get("message") or obj.get("text") or ""
                usage = _extract_usage(obj)
                if text:
                    return str(text), usage
        except json.JSONDecodeError:
            pass

    # Last resort: return raw text.
    return raw, {}


def call_agent_runtime(agent_id: str, user_prompt: str) -> tuple[str, int, int, int]:
    """Live-mode invocation. Returns (response_text, duration_ms, input_tokens,
    output_tokens). Raises on any failure (caller catches and records as fail
    row — live mode is allowed to fail per case without crashing the run).

    Sprint 2: uses a tightened botocore Config (read_timeout=120s) so a slow
    agent fails fast instead of hanging for the full default 312s. The first
    time an agent comes back with no usage block we print a warning to stderr —
    that's the operator signal to instrument it (see agents/_shared/instrumentation.py)."""
    runtime_name = _agent_id_to_runtime_name(agent_id)
    arns = _load_agent_runtime_arns()
    arn = arns.get(runtime_name)
    if not arn:
        raise RuntimeError(f"no deployed runtime found for {runtime_name}")
    rt = _boto3().client(
        "bedrock-agentcore",
        region_name=REGION,
        config=_live_botocore_config(),
    )
    payload = json.dumps({"prompt": user_prompt}).encode("utf-8")
    t0 = time.perf_counter()
    resp = rt.invoke_agent_runtime(
        agentRuntimeArn=arn,
        qualifier="DEFAULT",
        payload=payload,
    )
    body_stream = resp.get("response")
    body_bytes = b""
    if body_stream is not None:
        # Streaming body — read in full. (boto3 returns a StreamingBody for
        # invoke_agent_runtime; .read() drains it.)
        try:
            body_bytes = body_stream.read()
        except AttributeError:
            # If it's already bytes, use directly.
            body_bytes = bytes(body_stream) if body_stream else b""
    duration_ms = int((time.perf_counter() - t0) * 1000)

    text, usage = _parse_agent_response(body_bytes)
    input_tokens = int(usage.get("inputTokens") or 0)
    output_tokens = int(usage.get("outputTokens") or 0)

    # First time we see tokenless output for this agent, tell the operator —
    # missing usage means we won't be able to populate cost chips for this
    # agent's traces. Once per agent per run is enough.
    if not usage and agent_id not in _TOKEN_MISS_WARNED:
        _TOKEN_MISS_WARNED.add(agent_id)
        print(
            f"  warn: {agent_id} returned no token usage — instrument the agent "
            f"(see agents/_shared/instrumentation.py) or expect $? in cost columns",
            file=sys.stderr,
        )
    return text, duration_ms, input_tokens, output_tokens


# ── Tag-matching rules ────────────────────────────────────────────────────────


_TAG_CAP_NOUN_RE = re.compile(r"\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b")


def check_tag(tag: str, response: str) -> bool:
    if not response:
        return False
    text = response
    low = text.lower()

    if tag == "has-amount":
        return "amount" in low
    if tag == "has-vendor":
        return "vendor" in low
    if tag == "has-date":
        return "date" in low
    if tag == "nulls-when-unsure":
        if "null" not in text:
            return False
        # No fabricated numbers — naive check: any digit cluster of 3+ is suspect.
        suspect = re.search(r"\d{3,}", text)
        return suspect is None
    if tag == "mentions-kubernetes":
        return ("kubernet" in low) or ("k8s" in low)
    if tag == "lists-people":
        return text.count("@") >= 2
    if tag == "cites-evidence":
        return re.search(r"\([^)]+\)", text) is not None
    if tag == "acknowledges-no-match":
        return any(p in low for p in (
            "no expert", "do not have", "not aware", "cannot find", "no one",
        ))
    if tag == "valid-json":
        trimmed = text.strip()
        # Strip markdown fences if present.
        if trimmed.startswith("```"):
            trimmed = re.sub(r"^```(?:json)?\s*", "", trimmed)
            trimmed = re.sub(r"\s*```$", "", trimmed)
        try:
            json.loads(trimmed)
            return True
        except json.JSONDecodeError:
            return False
    if tag == "score-in-range":
        m = re.search(r'"score"\s*:\s*([0-9.]+)', text)
        if not m:
            return False
        try:
            v = float(m.group(1))
            return 0.0 <= v <= 1.0
        except ValueError:
            return False
    if tag == "actionable":
        return any(re.search(rf"\b{kw}\b", low) for kw in (
            "page", "check", "look at", "review", "investigate",
            "alert", "escalate", "call",
        ))
    if tag == "prioritized":
        return any(marker in low for marker in (
            "first", "next", "then", "1.", "2.", "(1)", "(2)",
        ))
    if tag == "cites-projects":
        return _TAG_CAP_NOUN_RE.search(text) is not None
    if tag == "names-scoring-agent":
        return "scoring" in low
    if tag == "names-search-agent":
        return "search" in low
    # Unknown tag — be permissive but flag in fail_reasons elsewhere.
    return False


def evaluate_case(
    case: dict,
    response: str,
    judge_score: float | None,
    schema_valid: bool | None,
) -> tuple[bool, dict[str, bool], list[str]]:
    tags = case.get("expected_tags") or []
    threshold = float(case.get("pass_threshold") or 0.7)
    tag_hits: dict[str, bool] = {t: check_tag(t, response) for t in tags}
    fail_reasons: list[str] = []

    if judge_score is None:
        fail_reasons.append("no-judge-score")
        passed = False
    else:
        passed = judge_score >= threshold
        if not passed:
            fail_reasons.append("below-threshold")

    if schema_valid is False:
        passed = False
        fail_reasons.append("schema-invalid")

    missing = [t for t, hit in tag_hits.items() if not hit]
    for m in missing:
        fail_reasons.append(f"missing-tag:{m}")

    # Severe mismatch: 2+ expected tags and ALL missing → force fail.
    if len(tags) >= 2 and len(missing) == len(tags):
        passed = False
        fail_reasons.append("all-tags-missing")

    return passed, tag_hits, fail_reasons


# ── Git helpers ──────────────────────────────────────────────────────────────


def detect_git_sha() -> str | None:
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, check=True,
            cwd=str(SCRIPT_DIR.parent.parent),
        )
        return r.stdout.strip() or None
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None


# ── Subcommands ──────────────────────────────────────────────────────────────


def cmd_list(args: argparse.Namespace) -> int:
    cases = fetch_active_cases()
    if not cases:
        print("no active test cases", file=sys.stderr)
        return 1
    print(f"{len(cases)} active test case(s):")
    print(f"{'test_id':<42}  {'agent_id':<22}  template_id")
    print("-" * 90)
    for c in cases:
        print(f"{c['test_id']:<42}  {c['agent_id']:<22}  {c.get('template_id') or ''}")
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    middleware = args.middleware
    git_sha = args.git_sha or detect_git_sha()
    label = args.label
    mode = args.mode

    cases = fetch_active_cases(case_id=args.case, agent_id=args.agent)
    if not cases:
        print("no matching test cases", file=sys.stderr)
        return 1

    prompts = _load_yaml(PROMPTS_PATH)
    missing_prompts = [c["test_id"] for c in cases if c["agent_id"] not in prompts]
    if missing_prompts:
        print(
            f"error: missing system prompts for agents on cases: {missing_prompts}",
            file=sys.stderr,
        )
        return 2

    # Pre-flight for live mode: probe the runtimes once so a missing ARN
    # surfaces NOW (before we create the run row), and log the response
    # shape from one supervisor call so the parser assumptions stay honest.
    if mode == "live":
        try:
            arns = _load_agent_runtime_arns()
            print(f"live: found {len(arns)} deployed runtime(s)")
            unique_agents = sorted({c["agent_id"] for c in cases})
            unknown = [a for a in unique_agents if _agent_id_to_runtime_name(a) not in arns]
            if unknown:
                print(
                    f"  warn: no runtime ARN for agent(s): {unknown} "
                    f"— these cases will fail in live mode",
                    file=sys.stderr,
                )
        except Exception as e:
            print(f"failed to list agent runtimes: {e}", file=sys.stderr)
            return 5

    # 1a. Register prompt versions for every distinct agent (M6 provenance).
    #     The middleware hashes content -> short SHA and returns it. We stamp
    #     that SHA on every trace row produced by that agent so researchers
    #     can answer "which prompt produced this regression".
    prompt_version_by_agent: dict[str, str] = {}
    for agent_id in sorted({c["agent_id"] for c in cases if c["agent_id"] in prompts}):
        try:
            resp = _http(
                "POST",
                f"{middleware}/api/observability/prompt-versions",
                {"agentId": agent_id, "content": prompts[agent_id]},
            )
            pv = resp.get("promptVersion")
            if pv:
                prompt_version_by_agent[agent_id] = pv
        except (HttpError, RuntimeError) as e:
            print(f"  warn: failed to register prompt for {agent_id}: {e}",
                  file=sys.stderr)

    # 1b. Create run row via middleware.
    create_body = {
        "label": label,
        "gitSha": git_sha,
        "judgeModelId": NOVA_PRO_MODEL_ID,
        "totalCases": len(cases),
        "mode": mode,
    }
    try:
        created = _http("POST", f"{middleware}/api/observability/harness/runs", create_body)
    except (HttpError, RuntimeError) as e:
        print(f"failed to create run: {e}", file=sys.stderr)
        return 3
    run_id = created.get("runId") or created.get("run_id")
    if not run_id:
        print(f"middleware did not return runId: {created}", file=sys.stderr)
        return 3
    print(f"run {run_id} started — {len(cases)} case(s), mode={mode}, judge={NOVA_PRO_MODEL_ID}")
    if git_sha:
        print(f"git_sha={git_sha} label={label!r}")

    passed_n, failed_n = 0, 0
    started = time.perf_counter()

    for i, case in enumerate(cases, start=1):
        test_id = case["test_id"]
        agent_id = case["agent_id"]
        system_prompt = prompts.get(agent_id, "")
        prompt_version = prompt_version_by_agent.get(agent_id)

        case_start = time.perf_counter()
        invocation_id: str | None = None
        judge_score: float | None = None
        judge_rationale = ""
        schema_valid: bool | None = None
        response_text = ""
        duration_ms = 0
        input_tokens = 0
        output_tokens = 0
        est_cost_usd: float | None = None
        fail_reasons: list[str] = []
        tag_hits: dict[str, bool] = {}
        passed = False

        # 2. Invoke the agent (live or sim).
        try:
            if mode == "live":
                response_text, duration_ms, input_tokens, output_tokens = (
                    call_agent_runtime(agent_id, case["prompt"])
                )
            else:
                response_text, duration_ms, input_tokens, output_tokens = (
                    call_bedrock(system_prompt, case["prompt"])
                )
        except Exception as e:
            err_kind = "agentcore-error" if mode == "live" else "bedrock-error"
            fail_reasons.append(f"{err_kind}:{type(e).__name__}")
            elapsed = time.perf_counter() - case_start
            print(
                f"[{i}/{len(cases)}] {test_id:<42}  "
                f"{err_kind.upper()}  ({elapsed:.1f}s) {e}",
                flush=True,
            )
            # Still record a fail row so the run is complete.
            try:
                _http(
                    "POST",
                    f"{middleware}/api/observability/harness/runs/{run_id}/results",
                    {
                        "testId": test_id,
                        "invocationId": None,
                        "passed": False,
                        "judgeScore": None,
                        "judgeRationale": "",
                        "schemaValid": None,
                        "tagHits": {},
                        "responseSnippet": "",
                        "failReasons": fail_reasons,
                        "durationMs": int(elapsed * 1000),
                        "inputTokens": None,
                        "outputTokens": None,
                        "estCostUsd": None,
                    },
                )
            except (HttpError, RuntimeError) as post_err:
                print(f"  warn: failed to record fail row: {post_err}", file=sys.stderr)
            failed_n += 1
            continue

        # Compute the agent-side est_cost_usd locally so we can populate
        # test_results even if the trace endpoint fails. For live mode where
        # the agent didn't report tokens, this is 0.0 (visible signal that
        # we need agent-side token emission in Sprint 2).
        est_cost_usd = estimate_cost_usd(
            NOVA_PRO_MODEL_ID, input_tokens, output_tokens
        ) if (input_tokens or output_tokens) else None

        # 3. POST to sync trace endpoint with tokens + provenance.
        trace_body: dict[str, Any] = {
            "agentId": agent_id,
            "agentName": agent_id.replace("orgiq-", "").capitalize(),
            "templateId": case.get("template_id") or "",
            "prompt": case["prompt"],
            "response": response_text,
            "durationMs": duration_ms,
            "inputTokens": input_tokens or None,
            "outputTokens": output_tokens or None,
            "modelId": NOVA_PRO_MODEL_ID,
        }
        if prompt_version:
            trace_body["promptVersion"] = prompt_version
        try:
            trace_resp = _http(
                "POST",
                f"{middleware}/api/observability/harness/trace",
                trace_body,
                timeout=90,
            )
            invocation_id = trace_resp.get("invocationId")
            judge_score = trace_resp.get("judgeScore")
            judge_rationale = trace_resp.get("judgeRationale") or ""
            schema_valid = trace_resp.get("schemaValid")
            # Prefer the cost the middleware computed (it's the canonical
            # source); fall back to our locally-computed value if missing.
            trace_cost = trace_resp.get("estCostUsd")
            if isinstance(trace_cost, (int, float)):
                est_cost_usd = float(trace_cost)
        except (HttpError, RuntimeError) as e:
            fail_reasons.append(f"trace-sink-error:{type(e).__name__}")
            print(f"  warn: trace-sink failed for {test_id}: {e}", file=sys.stderr)

        # 4. Compute pass/fail.
        passed, tag_hits, more_reasons = evaluate_case(
            case, response_text, judge_score, schema_valid
        )
        fail_reasons.extend(more_reasons)

        if passed:
            passed_n += 1
        else:
            failed_n += 1

        # 5. POST result with tokens + cost.
        try:
            _http(
                "POST",
                f"{middleware}/api/observability/harness/runs/{run_id}/results",
                {
                    "testId": test_id,
                    "invocationId": invocation_id,
                    "passed": passed,
                    "judgeScore": judge_score,
                    "judgeRationale": judge_rationale,
                    "schemaValid": schema_valid,
                    "tagHits": tag_hits,
                    "responseSnippet": response_text[:500],
                    "failReasons": fail_reasons,
                    "durationMs": duration_ms,
                    "inputTokens": input_tokens or None,
                    "outputTokens": output_tokens or None,
                    "estCostUsd": est_cost_usd,
                },
            )
        except (HttpError, RuntimeError) as e:
            print(f"  warn: failed to record result for {test_id}: {e}", file=sys.stderr)

        # 6. Live progress.
        score_str = f"score={judge_score:.2f}" if isinstance(judge_score, (int, float)) else "score=n/a"
        verdict = "PASS" if passed else "FAIL"
        secs = duration_ms / 1000.0
        tok_str = (f"tok={input_tokens}/{output_tokens}"
                   if (input_tokens or output_tokens) else "tok=?")
        cost_str = (f"${est_cost_usd:.4f}" if isinstance(est_cost_usd, (int, float))
                    else "$?")
        print(
            f"[{i}/{len(cases)}] {test_id:<42}  {score_str:<11}  "
            f"{verdict}  {tok_str:<14}  {cost_str:<8}  ({secs:.1f}s)",
            flush=True,
        )

    total_elapsed = time.perf_counter() - started
    completed = passed_n + failed_n
    pass_rate = (passed_n / completed) if completed else 0.0

    # 7. PATCH final run state.
    try:
        _http(
            "PATCH",
            f"{middleware}/api/observability/harness/runs/{run_id}",
            {
                "status": "done",
                "finishedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "passRate": round(pass_rate, 3),
                "completed": completed,
                "passed": passed_n,
                "failed": failed_n,
            },
        )
    except (HttpError, RuntimeError) as e:
        print(f"warn: failed to finalize run: {e}", file=sys.stderr)

    print()
    print(f"run {run_id} done in {total_elapsed:.1f}s")
    print(f"  pass-rate: {pass_rate:.0%}  ({passed_n} pass / {failed_n} fail / {completed} total)")

    # Optional: compare to most recent prior run (regressions only).
    try:
        recent = _http(
            "GET",
            f"{middleware}/api/observability/harness/runs?limit=5",
        )
        prior_id = _find_prior_run_id(recent, run_id)
        if prior_id:
            regressions, _, _ = _diff_runs(middleware, prior_id, run_id)
            if regressions:
                print(f"  regressions vs {prior_id}: {len(regressions)}")
                for r in regressions[:5]:
                    print(f"    - {r['test_id']}  Δ {r['delta']:+.2f}")
    except (HttpError, RuntimeError):
        pass

    portal = os.environ.get("PORTAL_URL", "http://localhost:5183")
    print(f"  portal: {portal}/observability/harness/runs/{run_id}")
    return 0 if completed == len(cases) else 4


def cmd_status(args: argparse.Namespace) -> int:
    run = _http("GET", f"{args.middleware}/api/observability/harness/runs/{args.run_id}")
    run_obj = run.get("run", run)
    label = run_obj.get("label")
    status = run_obj.get("status")
    pass_rate = run_obj.get("passRate") or run_obj.get("pass_rate")
    completed = run_obj.get("completed")
    total = run_obj.get("totalCases") or run_obj.get("total_cases")
    judge = run_obj.get("judgeModelId") or run_obj.get("judge_model_id")
    git_sha = run_obj.get("gitSha") or run_obj.get("git_sha")
    print(f"run     : {args.run_id}")
    print(f"label   : {label}")
    print(f"status  : {status}")
    print(f"git_sha : {git_sha}")
    print(f"judge   : {judge}")
    print(f"progress: {completed}/{total}")
    if isinstance(pass_rate, (int, float)):
        print(f"pass-rate: {pass_rate:.0%}")
    results = run.get("results") or []
    if results:
        passes = sum(1 for r in results if r.get("passed"))
        print(f"results : {passes}/{len(results)} pass")
    return 0


def _find_prior_run_id(listing: Any, current_run_id: str) -> str | None:
    runs = listing.get("runs") if isinstance(listing, dict) else None
    if not runs:
        return None
    for r in runs:
        rid = r.get("runId") or r.get("run_id")
        if rid and rid != current_run_id and (r.get("status") == "done"):
            return rid
    return None


def _diff_runs(
    middleware: str, run_a: str, run_b: str,
) -> tuple[list[dict], list[dict], list[dict]]:
    a = _http("GET", f"{middleware}/api/observability/harness/runs/{run_a}")
    b = _http("GET", f"{middleware}/api/observability/harness/runs/{run_b}")

    def index(payload: dict) -> dict[str, dict]:
        rs = payload.get("results") or []
        return {r["testId"] if "testId" in r else r.get("test_id"): r for r in rs}

    ia, ib = index(a), index(b)
    common = sorted(set(ia.keys()) & set(ib.keys()))

    regressions: list[dict] = []
    fixes: list[dict] = []
    neutral: list[dict] = []
    for tid in common:
        sa = ia[tid].get("judgeScore") or ia[tid].get("judge_score")
        sb = ib[tid].get("judgeScore") or ib[tid].get("judge_score")
        if not isinstance(sa, (int, float)) or not isinstance(sb, (int, float)):
            continue
        delta = float(sb) - float(sa)
        entry = {
            "test_id": tid,
            "score_a": float(sa),
            "score_b": float(sb),
            "delta": delta,
            "passed_a": bool(ia[tid].get("passed")),
            "passed_b": bool(ib[tid].get("passed")),
        }
        if delta < -0.05:
            regressions.append(entry)
        elif delta > 0.05:
            fixes.append(entry)
        else:
            neutral.append(entry)
    regressions.sort(key=lambda e: e["delta"])
    fixes.sort(key=lambda e: e["delta"], reverse=True)
    return regressions, fixes, neutral


def cmd_replay(args: argparse.Namespace) -> int:
    """Re-invoke a single past invocation against the CURRENT runtime.

    Workflow: ``harness.py replay <invocation_id>``.

    1. Fetches the historical invocation from middleware
       (``GET /api/observability/invocations/:id``) — we need the agent_id +
       original prompt + (optionally) template_id and prompt_version snapshot.
    2. Invokes that agent's deployed runtime with the SAME prompt. This is the
       "did our fix actually fix it?" verification path — pair it with the
       portal's invocation-detail view to compare before/after side by side.
    3. Records a one-case test_run labelled ``replay@<short-sha-of-source-inv>``
       plus a single test_result so the replay is visible in the harness
       history and can be diffed against any sibling run.

    No tag-matching is performed (we don't have expected_tags for ad-hoc
    invocations); the test_result records the response + judge score (if the
    middleware /trace endpoint returns one) and is treated as PASS iff the
    judge score is at or above the default 0.7 threshold.
    """
    middleware = args.middleware
    invocation_id = args.invocation_id
    git_sha = args.git_sha or detect_git_sha()

    # 1. Fetch the source invocation. Endpoint is owned by Agent A in Sprint 2;
    #    we fail with a clean message if it isn't deployed yet rather than
    #    swallowing into a generic 404.
    inv_url = f"{middleware}/api/observability/invocations/{invocation_id}"
    try:
        inv_resp = _http("GET", inv_url, timeout=15)
    except HttpError as e:
        if e.status == 404:
            print(f"replay: invocation {invocation_id} not found at {middleware}",
                  file=sys.stderr)
            return 4
        print(f"replay: failed to load source invocation: {e}", file=sys.stderr)
        return 4
    except RuntimeError as e:
        print(f"replay: failed to load source invocation: {e}", file=sys.stderr)
        return 4

    inv = inv_resp.get("invocation") or inv_resp
    agent_id = inv.get("agentId") or inv.get("agent_id")
    prompt = inv.get("prompt") or inv.get("inputText")
    template_id = inv.get("templateId") or inv.get("template_id") or ""
    if not agent_id or not prompt:
        print(
            f"replay: invocation {invocation_id} missing agentId/prompt "
            f"(got agentId={agent_id!r}, prompt={'<empty>' if not prompt else '<set>'})",
            file=sys.stderr,
        )
        return 4

    short = invocation_id[:8] if invocation_id else "unknown"
    label = args.label or f"replay@{short}"
    print(
        f"replay: invocation={invocation_id} agent={agent_id} "
        f"prompt={prompt[:80]!r} label={label!r}"
    )

    # 2. Create a fresh harness run for this single replay so it shows up in
    #    the runs history and can be diff'd against any sibling run.
    create_body = {
        "label": label,
        "gitSha": git_sha,
        "judgeModelId": NOVA_PRO_MODEL_ID,
        "totalCases": 1,
        "mode": "live",
    }
    try:
        created = _http(
            "POST", f"{middleware}/api/observability/harness/runs", create_body
        )
    except (HttpError, RuntimeError) as e:
        print(f"replay: failed to create run: {e}", file=sys.stderr)
        return 3
    run_id = created.get("runId") or created.get("run_id")
    if not run_id:
        print(f"replay: middleware did not return runId: {created}", file=sys.stderr)
        return 3
    print(f"replay: run {run_id} started")

    # 3. Invoke the SAME agent with the SAME prompt against the current runtime.
    case_start = time.perf_counter()
    response_text = ""
    duration_ms = 0
    input_tokens = 0
    output_tokens = 0
    fail_reasons: list[str] = []
    try:
        response_text, duration_ms, input_tokens, output_tokens = (
            call_agent_runtime(agent_id, prompt)
        )
    except Exception as e:
        fail_reasons.append(f"agentcore-error:{type(e).__name__}")
        print(f"replay: agentcore invocation failed: {e}", file=sys.stderr)
        # still close out the run with a fail row so the operator sees what happened
        elapsed_ms = int((time.perf_counter() - case_start) * 1000)
        try:
            _http(
                "POST",
                f"{middleware}/api/observability/harness/runs/{run_id}/results",
                {
                    "testId": f"replay:{invocation_id}",
                    "invocationId": None,
                    "passed": False,
                    "judgeScore": None,
                    "judgeRationale": "",
                    "schemaValid": None,
                    "tagHits": {},
                    "responseSnippet": "",
                    "failReasons": fail_reasons,
                    "durationMs": elapsed_ms,
                    "inputTokens": None,
                    "outputTokens": None,
                    "estCostUsd": None,
                },
            )
        except (HttpError, RuntimeError) as post_err:
            print(f"  warn: failed to record fail row: {post_err}", file=sys.stderr)
        _finalize_run(middleware, run_id, passed_n=0, failed_n=1)
        return 4

    est_cost_usd = (
        estimate_cost_usd(NOVA_PRO_MODEL_ID, input_tokens, output_tokens)
        if (input_tokens or output_tokens) else None
    )

    # 4. POST to trace sink to get a judge score for this replay. Mirrors
    #    cmd_run's body shape but omits expected_tags since we don't have any
    #    for an ad-hoc invocation.
    trace_body: dict[str, Any] = {
        "agentId": agent_id,
        "agentName": agent_id.replace("orgiq-", "").capitalize(),
        "templateId": template_id,
        "prompt": prompt,
        "response": response_text,
        "durationMs": duration_ms,
        "inputTokens": input_tokens or None,
        "outputTokens": output_tokens or None,
        "modelId": NOVA_PRO_MODEL_ID,
    }
    invocation_id_new: str | None = None
    judge_score: float | None = None
    judge_rationale = ""
    schema_valid: bool | None = None
    try:
        trace_resp = _http(
            "POST",
            f"{middleware}/api/observability/harness/trace",
            trace_body,
            timeout=90,
        )
        invocation_id_new = trace_resp.get("invocationId")
        judge_score = trace_resp.get("judgeScore")
        judge_rationale = trace_resp.get("judgeRationale") or ""
        schema_valid = trace_resp.get("schemaValid")
        trace_cost = trace_resp.get("estCostUsd")
        if isinstance(trace_cost, (int, float)):
            est_cost_usd = float(trace_cost)
    except (HttpError, RuntimeError) as e:
        fail_reasons.append(f"trace-sink-error:{type(e).__name__}")
        print(f"  warn: trace-sink failed: {e}", file=sys.stderr)

    passed = bool(
        isinstance(judge_score, (int, float)) and judge_score >= 0.7
    ) and schema_valid is not False

    # 5. Record the one result row.
    try:
        _http(
            "POST",
            f"{middleware}/api/observability/harness/runs/{run_id}/results",
            {
                "testId": f"replay:{invocation_id}",
                "invocationId": invocation_id_new,
                "passed": passed,
                "judgeScore": judge_score,
                "judgeRationale": judge_rationale,
                "schemaValid": schema_valid,
                "tagHits": {},
                "responseSnippet": response_text[:500],
                "failReasons": fail_reasons,
                "durationMs": duration_ms,
                "inputTokens": input_tokens or None,
                "outputTokens": output_tokens or None,
                "estCostUsd": est_cost_usd,
            },
        )
    except (HttpError, RuntimeError) as e:
        print(f"  warn: failed to record result: {e}", file=sys.stderr)

    score_str = f"score={judge_score:.2f}" if isinstance(judge_score, (int, float)) else "score=n/a"
    verdict = "PASS" if passed else "FAIL"
    tok_str = (f"tok={input_tokens}/{output_tokens}"
               if (input_tokens or output_tokens) else "tok=?")
    cost_str = (f"${est_cost_usd:.4f}" if isinstance(est_cost_usd, (int, float))
                else "$?")
    print(f"replay  {score_str}  {verdict}  {tok_str}  {cost_str}  ({duration_ms/1000:.1f}s)")

    _finalize_run(
        middleware, run_id,
        passed_n=1 if passed else 0,
        failed_n=0 if passed else 1,
    )

    portal = os.environ.get("PORTAL_URL", "http://localhost:5183")
    print(f"  portal: {portal}/observability/harness/runs/{run_id}")
    return 0 if passed else 4


def _finalize_run(middleware: str, run_id: str, *, passed_n: int, failed_n: int) -> None:
    completed = passed_n + failed_n
    pass_rate = (passed_n / completed) if completed else 0.0
    try:
        _http(
            "PATCH",
            f"{middleware}/api/observability/harness/runs/{run_id}",
            {
                "status": "done",
                "finishedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
                "passRate": round(pass_rate, 3),
                "completed": completed,
                "passed": passed_n,
                "failed": failed_n,
            },
        )
    except (HttpError, RuntimeError) as e:
        print(f"warn: failed to finalize run: {e}", file=sys.stderr)


def cmd_diff(args: argparse.Namespace) -> int:
    middleware = args.middleware
    regressions, fixes, neutral = _diff_runs(middleware, args.run_a, args.run_b)

    # Honest comparison: print judge model for each side.
    try:
        ra = _http("GET", f"{middleware}/api/observability/harness/runs/{args.run_a}")
        rb = _http("GET", f"{middleware}/api/observability/harness/runs/{args.run_b}")
        ja = (ra.get("run") or ra).get("judgeModelId") or (ra.get("run") or ra).get("judge_model_id")
        jb = (rb.get("run") or rb).get("judgeModelId") or (rb.get("run") or rb).get("judge_model_id")
        print(f"run A : {args.run_a}  judge={ja}")
        print(f"run B : {args.run_b}  judge={jb}")
        if ja and jb and ja != jb:
            print("warning: judge models differ — comparison may be unfair")
    except (HttpError, RuntimeError):
        pass

    def fmt(entry: dict) -> str:
        flip = ""
        if entry["passed_a"] and not entry["passed_b"]:
            flip = "  (was PASS, now FAIL)"
        elif not entry["passed_a"] and entry["passed_b"]:
            flip = "  (was FAIL, now PASS)"
        return (
            f"  {entry['test_id']:<42}  "
            f"{entry['score_a']:.2f} -> {entry['score_b']:.2f}  "
            f"Δ {entry['delta']:+.2f}{flip}"
        )

    print(f"\nregressions ({len(regressions)}):")
    for e in regressions:
        print(fmt(e))
    print(f"\nfixes ({len(fixes)}):")
    for e in fixes:
        print(fmt(e))
    print(f"\nneutral ({len(neutral)}): scores within ±0.05")
    return 0


# ── CLI plumbing ──────────────────────────────────────────────────────────────


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="harness.py",
        description="OrgIQ test harness runner — replay (prompt, agent) cases through Bedrock.",
    )
    p.add_argument(
        "--middleware",
        default=DEFAULT_MIDDLEWARE,
        help=f"middleware base URL (default {DEFAULT_MIDDLEWARE})",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="list active test cases")

    pr = sub.add_parser("run", help="replay active test cases and record results")
    pr.add_argument("--label", required=True, help="run label, e.g. 'main@bb85bcf'")
    pr.add_argument("--case", help="run a single test_id")
    pr.add_argument("--agent", help="filter by agent_id")
    pr.add_argument("--git-sha", help="override git_sha (auto-detected if omitted)")
    pr.add_argument(
        "--mode",
        choices=["live", "sim"],
        default=DEFAULT_MODE,
        help=(
            f"live: invoke deployed AgentCore runtimes (real agents). "
            f"sim: call Bedrock Nova-Pro directly with role-play prompts. "
            f"default: {DEFAULT_MODE}"
        ),
    )

    ps = sub.add_parser("status", help="print run summary + pass rate")
    ps.add_argument("run_id")

    pd = sub.add_parser("diff", help="compare two runs (regressions/fixes/neutral)")
    pd.add_argument("run_a")
    pd.add_argument("run_b")

    pre = sub.add_parser(
        "replay",
        help="re-invoke a past invocation against the current runtime and "
             "record a new one-case run (Sprint 2)",
    )
    pre.add_argument(
        "invocation_id",
        help="invocation id (uuid) of the trace to replay — fetched from "
             "/api/observability/invocations/:id",
    )
    pre.add_argument(
        "--label",
        help="override the run label (default: replay@<short-sha-of-source>)",
    )
    pre.add_argument(
        "--git-sha",
        help="override git_sha for the new run row (auto-detected if omitted)",
    )

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    handler = {
        "list": cmd_list,
        "run": cmd_run,
        "status": cmd_status,
        "diff": cmd_diff,
        "replay": cmd_replay,
    }[args.cmd]
    try:
        return handler(args)
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
