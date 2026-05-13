#!/usr/bin/env python3
"""
Seed the observability.calibration_set table with a starter set of hand-graded
(prompt, response, human_score) tuples for Sprint 4 (M10) judge calibration.

Idempotent — inserts only when the agent_id + prompt pair isn't already present
so re-running this won't duplicate rows. Hits the RDS Data API directly with the
same pattern as schema/seed.py.

Mix:
    3x good       (human_score = 0.90)
    3x mediocre   (human_score = 0.50)
    3x bad        (human_score = 0.20)
    3x edge cases (empty response, hallucination, off-topic)

Usage:
    python3 infra/scripts/seed_calibration_cases.py
    python3 infra/scripts/seed_calibration_cases.py --dry-run
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from typing import Any

REGION = "us-east-1"
DATABASE = "orgiq"


def _boto3():
    import boto3  # type: ignore
    return boto3


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


def _execute_statement(sql: str, parameters: list[dict] | None = None) -> dict:
    cluster_arn, secret_arn = _rds_arns()
    client = _boto3().client("rds-data", region_name=REGION)
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


# ── The cases ────────────────────────────────────────────────────────────────
# Each tuple is (agent_id, prompt, response, human_score, human_rationale, notes).
# Prompts borrow shape from infra/scripts/agent_prompts.yaml + the real
# observability test_cases set so the calibration matches the judge's
# deployment domain.

CASES: list[tuple[str, str, str, float, str, str]] = [
    # ── 3x GOOD (0.90) ─────────────────────────────────────────────────────────
    (
        "orgiq-search",
        "Who knows Kubernetes best on the platform team?",
        "Suggesting @ariana-chen (Kubernetes, 6yrs, Platform Engineering — owns "
        "p-k8s-migration), @dev-patel (Kubernetes + Service Mesh, 4yrs — recent "
        "SOC2 cluster hardening). Both have authored the platform's Helm chart "
        "library; defer to Ariana for production cluster decisions.",
        0.90,
        "Grounded in named people, cites projects, returns 2 candidates with "
        "rationale, suggests a tiebreaker — exactly the search agent's contract.",
        "good: well-grounded, multi-person, evidence",
    ),
    (
        "orgiq-scoring",
        "Compute expertise score for p_ariana_chen on Kubernetes.",
        '{"personId": "p_ariana_chen", "score": 0.87, "basis": "6 years authored '
        'K8s, owns p-k8s-migration, 3 conf talks on service mesh, 12 closed PRs '
        'in Q1"}',
        0.90,
        "Strict JSON, score in range, basis is specific and verifiable, "
        "personId matches request.",
        "good: schema-clean and well-justified",
    ),
    (
        "orgiq-advisor",
        "Should we roll back the Nova-Pro standardization decision (d-nova)?",
        "Hold off on rollback. Three considerations: (1) d-nova was decided "
        "2026-04-21 by the architecture council — overturning needs the same "
        "forum, not a unilateral revert. (2) Cost data shows Nova-Pro is 38% "
        "cheaper per good response than the Claude-3 baseline we replaced. "
        "(3) The supervisor agent's pass rate has improved 12pp since adoption. "
        "If a specific gap motivates the question, name it and we can scope a "
        "supplementary model rather than reversing a council decision.",
        0.90,
        "Cites the source decision, gives quantitative reasoning, acknowledges "
        "the implicit concern, proposes a constructive alternative.",
        "good: grounded, structured, addresses concern",
    ),

    # ── 3x MEDIOCRE (0.50) ─────────────────────────────────────────────────────
    (
        "orgiq-search",
        "Who is the best person to ask about our LLM platform?",
        "You should probably ask someone on the ML team. Maybe try the team "
        "lead — they'd know who to route this to.",
        0.50,
        "Acknowledges the right team but doesn't name people, cite projects, "
        "or even attempt the contract format. Useful direction, useless detail.",
        "mediocre: vague, no names, no evidence",
    ),
    (
        "orgiq-supervisor",
        "Find the top performers in Q1 and tell me which projects they're on.",
        "This sounds like a two-part question — the scoring agent can rank "
        "people, then search can map them to projects. Let me know if you want "
        "to scope it to a specific team.",
        0.50,
        "Correctly identifies the routing topology but stops at the meta-answer "
        "instead of executing or giving a concrete plan. Not wrong, not helpful.",
        "mediocre: identifies routing, doesn't act",
    ),
    (
        "orgiq-ingestion",
        "Extract the invoice fields from: 'Acme Widgets, $4,200, March 2026'.",
        '{"amount": 4200, "vendor": "Acme Widgets", "date": "2026-03-01", '
        '"line_items": []}',
        0.50,
        "Schema-clean and vendor/amount are right, but the date precision is "
        "fabricated — 'March 2026' is not '2026-03-01'. Should have used null "
        "per the agent's contract for sub-month precision.",
        "mediocre: invents date precision, otherwise clean",
    ),

    # ── 3x BAD (0.20) ──────────────────────────────────────────────────────────
    (
        "orgiq-search",
        "Who knows about our zero-trust security architecture?",
        "Zero-trust is an important security model. It's based on the principle "
        "of never trusting any request and always verifying. Many organizations "
        "have adopted zero-trust principles.",
        0.20,
        "Educational content with zero org-specific information. Doesn't name a "
        "single person, project, or doc. This is what 'agent answered the topic "
        "instead of the question' looks like.",
        "bad: topic essay, no org content",
    ),
    (
        "orgiq-scoring",
        "Compute expertise score for p_unknown_999 on Rust.",
        "Sure! Here's a great Rust expertise score: high! They probably know "
        "lots of Rust. Score: 8/10.",
        0.20,
        "Wrong schema (not JSON), wrong scale (8/10 vs 0..1), unknown personId "
        "not flagged, score basis is meaningless. Every contract clause violated.",
        "bad: violates schema and scale",
    ),
    (
        "orgiq-advisor",
        "What did we decide about the legacy auth gateway sunset?",
        "The legacy auth gateway will be sunset by Q4 2027. The decision was "
        "made by the security council and championed by @sarah-johnson with "
        "buy-in from @michael-chen and @diana-park. Migration of the inventory "
        "service starts in May.",
        0.20,
        "Hallucinated. Real decision d-legacy-auth says Q3 2026 (not Q4 2027), "
        "and the names don't appear in the org. Every concrete fact is wrong. "
        "Worst kind of failure — confidently wrong.",
        "bad: hallucinated dates and people",
    ),

    # ── 3x EDGE (one each: empty, hallucinated, off-topic) ─────────────────────
    (
        "orgiq-search",
        "Who can review my pull request for the Aurora schema change?",
        "",
        0.10,
        "Empty response. Judge should score very low — there is no answer, no "
        "fallback, no acknowledgement of why no answer.",
        "edge: empty response",
    ),
    (
        "orgiq-supervisor",
        "How's the weather today?",
        "I'd suggest pinging @weather-bot or checking your phone — that's "
        "outside the OrgIQ supervisor's remit (people, projects, scores, "
        "decisions).",
        0.75,
        "Off-topic prompt handled correctly — acknowledges scope, doesn't "
        "fabricate an answer, suggests a route. Calibration anchor for "
        "'graceful refusal'.",
        "edge: off-topic, graceful refusal",
    ),
    (
        "orgiq-graph-builder",
        "Add a new person 'Lin Wu' on the Platform team.",
        "INSERT INTO people (id, name, team) VALUES "
        "('p_lin_wu', 'Lin Wu', 't-platform') "
        "ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, team = EXCLUDED.team;",
        0.85,
        "Correct single statement, idempotent ON CONFLICT, slug matches the "
        "schema's convention. Slightly under-90 because it doesn't auto-add "
        "the team-memberships join row, which is the agent's full contract.",
        "edge: solid but incomplete upsert",
    ),
]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Seed observability.calibration_set with starter cases.")
    parser.add_argument("--dry-run", action="store_true", help="emit a summary, don't write")
    args = parser.parse_args(argv)

    print(f"calibration set: {len(CASES)} starter case(s)")
    counts: dict[str, int] = {}
    for _, _, _, score, _, _ in CASES:
        if score >= 0.8:
            bucket = "good"
        elif score >= 0.4:
            bucket = "mediocre"
        elif score >= 0.15:
            bucket = "bad"
        else:
            bucket = "empty/edge"
        counts[bucket] = counts.get(bucket, 0) + 1
    print("  buckets:", ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))

    if args.dry_run:
        print("dry-run — no writes")
        return 0

    inserted, skipped = 0, 0
    for agent_id, prompt, response, score, rationale, notes in CASES:
        # Idempotent: skip when an (agent_id, prompt) pair already exists.
        # We don't have a unique constraint on (agent_id, prompt) by design —
        # researchers might intentionally hand-grade two responses to the same
        # prompt — but the seed script should not duplicate its own work.
        exists = _execute_statement(
            "SELECT COUNT(*)::bigint AS n "
            "FROM observability.calibration_set "
            "WHERE agent_id = :agent_id AND prompt = :prompt",
            [
                {"name": "agent_id", "value": {"stringValue": agent_id}},
                {"name": "prompt", "value": {"stringValue": prompt}},
            ],
        )
        n = 0
        for row in exists.get("records", []):
            for field in row:
                if "longValue" in field:
                    n = field["longValue"]
        if n and n > 0:
            skipped += 1
            print(f"  skip   {agent_id:<22}  {prompt[:60]!r}")
            continue

        _execute_statement(
            """INSERT INTO observability.calibration_set
                 (agent_id, prompt, response, human_score, human_rationale, notes,
                  created_at, updated_at)
               VALUES
                 (:agent_id, :prompt, :response, :human_score, :human_rationale,
                  :notes, now(), now())""",
            [
                {"name": "agent_id", "value": {"stringValue": agent_id}},
                {"name": "prompt", "value": {"stringValue": prompt}},
                {"name": "response", "value": {"stringValue": response}},
                {"name": "human_score", "value": {"doubleValue": score}},
                {"name": "human_rationale", "value": {"stringValue": rationale}},
                {"name": "notes", "value": {"stringValue": notes}},
            ],
        )
        inserted += 1
        print(f"  insert {agent_id:<22}  score={score:.2f}  {prompt[:60]!r}")

    print(f"done — {inserted} inserted, {skipped} already present")
    return 0


if __name__ == "__main__":
    sys.exit(main())
