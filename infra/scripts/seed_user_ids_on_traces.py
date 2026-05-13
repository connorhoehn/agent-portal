#!/usr/bin/env python3
"""
Backfill `user_id` + `session_id` on recent invocation_traces so the Sprint 4
TrafficPage Top-Users table has data to render.

Most existing traces were captured before the agents started stamping
user_id/session_id, so both columns are NULL. We pick a small pool of fake
user ids, distribute them with a realistic power-law-ish skew, and update
recent test-row-free traces in-place.

Usage:
    python3 infra/scripts/seed_user_ids_on_traces.py                # apply
    python3 infra/scripts/seed_user_ids_on_traces.py --dry-run      # SQL only
    python3 infra/scripts/seed_user_ids_on_traces.py --hours 168    # last 7d

Deterministic — uses random.seed(91).
"""
from __future__ import annotations

import argparse
import os
import random
import subprocess
import sys

random.seed(91)

# Power-law-ish user pool. Probabilities should sum to ~1.0.
USER_POOL: list[tuple[str, float]] = [
    ("u_alice", 0.50),
    ("u_bob",   0.25),
    ("u_carol", 0.15),
    ("u_diana", 0.10),
]


def pick_user() -> str:
    r = random.random()
    acc = 0.0
    for uid, prob in USER_POOL:
        acc += prob
        if r <= acc:
            return uid
    return USER_POOL[-1][0]


def session_for(user: str) -> str:
    # ${user}_${YYYYMMDD}_${rand4}. Date is "today" — keeps sessions short-lived,
    # which matches the real-world expectation that sessions don't persist for
    # a week.
    import datetime as _dt
    day = _dt.date.today().strftime("%Y%m%d")
    rand4 = f"{random.randint(0, 0xFFFF):04x}"
    return f"{user}_{day}_{rand4}"


def get_cluster_arns() -> tuple[str, str]:
    region = os.environ.get("AWS_REGION", "us-east-1")

    def cf(key: str) -> str:
        return subprocess.check_output([
            "aws", "cloudformation", "describe-stacks",
            "--stack-name", "OrgIQ-Aurora", "--region", region,
            "--query", f"Stacks[0].Outputs[?OutputKey=='{key}'].OutputValue",
            "--output", "text",
        ], text=True).strip()

    return cf("ClusterArn"), cf("CredentialsSecretArn")


def fetch_candidate_ids(rds, cluster_arn: str, secret_arn: str, hours: int, limit: int) -> list[str]:
    """Return invocation_ids in the window where user_id is NULL or empty.

    We filter test:* rows out — they'd skew the user-id assignment for no
    benefit on the traffic page (which itself filters test rows).
    """
    sql = f"""
        SELECT invocation_id::text AS invocation_id
          FROM observability.invocation_traces
         WHERE ts > now() - INTERVAL '{hours} hours'
           AND (template_id NOT LIKE 'test:%' OR template_id IS NULL)
           AND (user_id IS NULL OR length(trim(user_id)) = 0)
         ORDER BY ts DESC
         LIMIT {limit}
    """
    resp = rds.execute_statement(
        resourceArn=cluster_arn,
        secretArn=secret_arn,
        database="orgiq",
        sql=sql,
    )
    out: list[str] = []
    for row in resp.get("records", []):
        cell = row[0]
        val = cell.get("stringValue")
        if val:
            out.append(val)
    return out


def emit_statements(invocation_ids: list[str]) -> list[tuple[str, str, str]]:
    """For each invocation_id, pick a user + session and return tuples of
    (invocation_id, user_id, session_id) ready to UPDATE."""
    out: list[tuple[str, str, str]] = []
    for iid in invocation_ids:
        u = pick_user()
        s = session_for(u)
        out.append((iid, u, s))
    return out


def apply(rds, cluster_arn: str, secret_arn: str, triples: list[tuple[str, str, str]]) -> None:
    for i, (iid, uid, sid) in enumerate(triples):
        sql = """
            UPDATE observability.invocation_traces
               SET user_id    = :uid,
                   session_id = :sid
             WHERE invocation_id = :iid::uuid
        """
        params = [
            {"name": "uid", "value": {"stringValue": uid}},
            {"name": "sid", "value": {"stringValue": sid}},
            {"name": "iid", "value": {"stringValue": iid}},
        ]
        try:
            rds.execute_statement(
                resourceArn=cluster_arn,
                secretArn=secret_arn,
                database="orgiq",
                sql=sql,
                parameters=params,
            )
        except Exception as e:
            print(f"  x  row {i + 1}/{len(triples)} failed: {e}", file=sys.stderr)
            raise
        if (i + 1) % 50 == 0:
            print(f"  updated {i + 1}/{len(triples)} rows...")
    print(f"  updated {len(triples)} rows.")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Backfill user_id + session_id on recent invocation_traces.",
    )
    parser.add_argument("--hours", type=int, default=168,
                        help="Look-back window in hours (default 168 = 7 days)")
    parser.add_argument("--limit", type=int, default=2000,
                        help="Max rows to backfill in one pass (default 2000)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Emit the (invocation_id, user_id, session_id) "
                             "assignment plan to stdout but don't write")
    args = parser.parse_args()

    import boto3  # local — keep top-level imports light for --help
    cluster_arn, secret_arn = get_cluster_arns()
    region = os.environ.get("AWS_REGION", "us-east-1")
    rds = boto3.client("rds-data", region_name=region)

    print(
        f"Fetching candidate invocation_ids (last {args.hours}h, limit {args.limit})...",
        file=sys.stderr,
    )
    ids = fetch_candidate_ids(rds, cluster_arn, secret_arn, args.hours, args.limit)
    print(f"Found {len(ids)} rows with NULL/empty user_id.", file=sys.stderr)

    if not ids:
        print("Nothing to do.")
        return

    triples = emit_statements(ids)

    # Headline distribution check.
    counts: dict[str, int] = {}
    for _, uid, _ in triples:
        counts[uid] = counts.get(uid, 0) + 1
    print("Distribution:", file=sys.stderr)
    for uid, _ in USER_POOL:
        n = counts.get(uid, 0)
        pct = (n / len(triples)) * 100 if triples else 0.0
        print(f"  {uid:10s} {n:5d}  ({pct:5.1f}%)", file=sys.stderr)

    if args.dry_run:
        for iid, uid, sid in triples:
            print(f"{iid}\t{uid}\t{sid}")
        return

    apply(rds, cluster_arn, secret_arn, triples)
    print("Backfill applied.")


if __name__ == "__main__":
    main()
