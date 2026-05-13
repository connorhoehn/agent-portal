#!/usr/bin/env python3
"""
OrgIQ test harness runner.

Replays curated (prompt, agent) test cases through Bedrock Nova-Pro, pushes
each response through the middleware trace-sink for judging + schema
validation, then records pass/fail in observability.test_results.

The simulated agent system prompts live in `infra/scripts/agent_prompts.yaml`.
The runner forwards (system, user) to amazon.nova-pro-v1:0 (Converse API,
temperature 0, maxTokens 600), captures the response, then POSTs to the
locked middleware contract:

    POST   /api/observability/harness/runs                 -> {runId}
    POST   /api/observability/harness/trace                -> {invocationId, judgeScore, ...}
    POST   /api/observability/harness/runs/{id}/results
    PATCH  /api/observability/harness/runs/{id}
    GET    /api/observability/harness/runs/{id}

Usage:
    python3 infra/scripts/harness.py list
    python3 infra/scripts/harness.py run --label "main@$(git rev-parse --short HEAD)"
    python3 infra/scripts/harness.py run --case search.expert.k8s.001
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


# ── Bedrock Converse call ─────────────────────────────────────────────────────


def call_bedrock(system_prompt: str, user_prompt: str) -> tuple[str, int]:
    """Returns (response_text, duration_ms). Raises on failure."""
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
    return text, duration_ms


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

    # 1. Create run row via middleware.
    create_body = {
        "label": label,
        "gitSha": git_sha,
        "judgeModelId": NOVA_PRO_MODEL_ID,
        "totalCases": len(cases),
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
    print(f"run {run_id} started — {len(cases)} case(s), judge={NOVA_PRO_MODEL_ID}")
    if git_sha:
        print(f"git_sha={git_sha} label={label!r}")

    passed_n, failed_n = 0, 0
    started = time.perf_counter()

    for i, case in enumerate(cases, start=1):
        test_id = case["test_id"]
        agent_id = case["agent_id"]
        system_prompt = prompts[agent_id]

        case_start = time.perf_counter()
        invocation_id: str | None = None
        judge_score: float | None = None
        judge_rationale = ""
        schema_valid: bool | None = None
        response_text = ""
        duration_ms = 0
        fail_reasons: list[str] = []
        tag_hits: dict[str, bool] = {}
        passed = False

        # 2. Call Bedrock.
        try:
            response_text, duration_ms = call_bedrock(system_prompt, case["prompt"])
        except Exception as e:
            fail_reasons.append(f"bedrock-error:{type(e).__name__}")
            elapsed = time.perf_counter() - case_start
            print(
                f"[{i}/{len(cases)}] {test_id:<42}  "
                f"BEDROCK-ERROR  ({elapsed:.1f}s) {e}",
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
                    },
                )
            except (HttpError, RuntimeError) as post_err:
                print(f"  warn: failed to record fail row: {post_err}", file=sys.stderr)
            failed_n += 1
            continue

        # 3. POST to sync trace endpoint.
        trace_body = {
            "agentId": agent_id,
            "agentName": agent_id.replace("orgiq-", "").capitalize(),
            "templateId": case.get("template_id") or "",
            "prompt": case["prompt"],
            "response": response_text,
            "durationMs": duration_ms,
        }
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

        # 5. POST result.
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
                },
            )
        except (HttpError, RuntimeError) as e:
            print(f"  warn: failed to record result for {test_id}: {e}", file=sys.stderr)

        # 6. Live progress.
        score_str = f"score={judge_score:.2f}" if isinstance(judge_score, (int, float)) else "score=n/a"
        verdict = "PASS" if passed else "FAIL"
        secs = duration_ms / 1000.0
        print(
            f"[{i}/{len(cases)}] {test_id:<42}  {score_str:<11}  {verdict}  ({secs:.1f}s)",
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

    ps = sub.add_parser("status", help="print run summary + pass rate")
    ps.add_argument("run_id")

    pd = sub.add_parser("diff", help="compare two runs (regressions/fixes/neutral)")
    pd.add_argument("run_a")
    pd.add_argument("run_b")

    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    handler = {
        "list": cmd_list,
        "run": cmd_run,
        "status": cmd_status,
        "diff": cmd_diff,
    }[args.cmd]
    try:
        return handler(args)
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
