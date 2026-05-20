"""Canary synthetic traffic generator.

Drives steady synthetic traffic to the canary `/ask` endpoint for a configurable
duration. Each request picks a random (person, topic, summary) tuple drawn from
the Aurora seed graph (via the existing :mod:`schema.synth.aurora` helpers, or a
direct ``rds-data`` call using ``AURORA_CLUSTER_ARN``/``AURORA_SECRET_ARN``/
``AURORA_DATABASE`` if set). If neither Aurora path is reachable, the script
falls back to a small hardcoded sample so it remains runnable in airgapped or
unconfigured environments.

Usage:
  python -m schema.synth.canary_traffic --minutes 240 --rate 30
  # 30 requests/minute for 4 hours

Environment:
  MIDDLEWARE_URL                default http://localhost:3001
  AURORA_CLUSTER_ARN            optional — direct rds-data path
  AURORA_SECRET_ARN             optional — direct rds-data path
  AURORA_DATABASE               optional — direct rds-data path (default: orgiq)

Per tick:
  - Pick a random (person_name, topic, summary) tuple
  - POST to {MIDDLEWARE_URL}/api/observability/canary/ask with body
    {"person_name": ..., "topic": ..., "summary": ...}
  - We don't consume the SSE response body (we just need to trigger the
    invocation); stream=True + immediate close.
  - Sleep until next tick (uniform jitter ±20% of mean interval).

No mutating AWS calls. Read-only Aurora SELECT only.
"""
from __future__ import annotations

import argparse
import os
import random
import signal
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any

try:
    import requests
except ImportError:  # pragma: no cover - clearer error than the stack trace
    print("error: 'requests' is required. pip install requests", file=sys.stderr)
    sys.exit(2)


SAMPLE_SIZE = 100
JITTER_FRAC = 0.20
PROGRESS_INTERVAL_SEC = 30.0
CANARY_PATH = "/api/observability/canary/ask"


# ── Seed tuples ──────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Seed:
    person_name: str
    topic: str
    summary: str


# Minimal hardcoded set — only used when Aurora is unreachable. Topics cover
# the demo's headline expertise areas so traces still look plausible.
FALLBACK_SEEDS: list[Seed] = [
    Seed("Ada Lovelace", "Kubernetes", "Platform engineer; container orchestration and rollout strategy."),
    Seed("Grace Hopper", "Compilers", "Distinguished engineer; language design and toolchains."),
    Seed("Alan Turing", "Cryptography", "Security architect; cryptographic protocol review."),
    Seed("Linus Torvalds", "Linux kernel", "Kernel maintainer; scheduler and filesystem internals."),
    Seed("Margaret Hamilton", "Reliability engineering", "Flight software lead; fault-tolerant systems design."),
    Seed("Donald Knuth", "Algorithms", "Algorithms researcher; analysis and data-structure design."),
    Seed("Barbara Liskov", "Distributed systems", "Distributed-systems researcher; replication and consensus."),
    Seed("Tim Berners-Lee", "Web standards", "Web architect; HTTP, URIs, and content negotiation."),
    Seed("Vint Cerf", "Networking", "Network protocols; TCP/IP and routing."),
    Seed("Radia Perlman", "Routing", "Spanning-tree designer; layer-2 network resilience."),
    Seed("Leslie Lamport", "Consensus", "Paxos and TLA+; formal methods for concurrency."),
    Seed("Anita Borg", "Operating systems", "OS internals; performance and scheduling."),
    Seed("Ken Thompson", "Unix", "Unix co-creator; shell, regex, and systems programming."),
    Seed("Dennis Ritchie", "C language", "Language design; compilers and runtime."),
    Seed("Brian Kernighan", "Programming languages", "Author and language designer; AWK and C."),
    Seed("Sandi Metz", "Object-oriented design", "OO design patterns; refactoring and code quality."),
    Seed("Martin Fowler", "Refactoring", "Software architecture; refactoring patterns."),
    Seed("Kent Beck", "Test-driven development", "TDD and extreme programming."),
    Seed("Werner Vogels", "Cloud architecture", "Cloud-native architecture; eventual consistency."),
    Seed("Adrian Cockcroft", "Microservices", "Microservices patterns; cloud migration."),
]


# ── Aurora seed loaders ──────────────────────────────────────────────────────

_SEED_SQL = """
WITH skills_agg AS (
  SELECT ps.person_id, STRING_AGG(s.name, ', ') AS skill_list
  FROM person_skills ps
  JOIN skills s ON s.id = ps.skill_id
  GROUP BY ps.person_id
),
primary_skill AS (
  SELECT DISTINCT ON (ps.person_id) ps.person_id, s.name AS topic, ps.weight
  FROM person_skills ps
  JOIN skills s ON s.id = ps.skill_id
  ORDER BY ps.person_id, ps.weight DESC NULLS LAST, s.name
)
SELECT
  p.name AS person_name,
  COALESCE(ps.topic, 'general engineering') AS topic,
  CONCAT_WS(' ',
    COALESCE(p.title, ''),
    CASE WHEN p.team IS NOT NULL THEN '(' || p.team || ').' ELSE '' END,
    CASE WHEN sa.skill_list IS NOT NULL THEN 'Skills: ' || sa.skill_list ELSE '' END
  ) AS summary
FROM people p
LEFT JOIN primary_skill ps ON ps.person_id = p.id
LEFT JOIN skills_agg sa    ON sa.person_id = p.id
ORDER BY random()
LIMIT {limit}
""".strip()


def _load_seeds_via_synth_aurora(limit: int) -> list[Seed] | None:
    """Try the in-repo helper. Returns None if it can't be used."""
    try:
        from . import aurora as synth_aurora  # type: ignore
    except Exception:
        return None
    try:
        rows = synth_aurora.execute(_SEED_SQL.format(limit=limit))
    except Exception as exc:
        print(f"warn: synth.aurora.execute failed: {exc}", file=sys.stderr)
        return None
    return _rows_to_seeds(rows)


def _load_seeds_via_env(limit: int) -> list[Seed] | None:
    """Try the explicit-env rds-data path. Returns None if env not set."""
    cluster_arn = os.environ.get("AURORA_CLUSTER_ARN")
    secret_arn = os.environ.get("AURORA_SECRET_ARN")
    database = os.environ.get("AURORA_DATABASE", "orgiq")
    if not (cluster_arn and secret_arn):
        return None
    try:
        import boto3  # local import; only needed for this path
    except ImportError:
        print("warn: boto3 not installed; cannot use AURORA_* env path", file=sys.stderr)
        return None
    try:
        rds = boto3.client("rds-data")
        resp = rds.execute_statement(
            resourceArn=cluster_arn,
            secretArn=secret_arn,
            database=database,
            sql=_SEED_SQL.format(limit=limit),
            includeResultMetadata=True,
        )
    except Exception as exc:
        print(f"warn: rds-data execute_statement failed: {exc}", file=sys.stderr)
        return None
    cols = [c["name"] for c in resp.get("columnMetadata", [])]
    rows: list[dict[str, Any]] = []
    for record in resp.get("records", []):
        row: dict[str, Any] = {}
        for col, field in zip(cols, record):
            if field.get("isNull"):
                row[col] = None
            else:
                for k in ("stringValue", "longValue", "doubleValue", "booleanValue"):
                    if k in field:
                        row[col] = field[k]
                        break
                else:
                    row[col] = None
        rows.append(row)
    return _rows_to_seeds(rows)


def _rows_to_seeds(rows: list[dict[str, Any]]) -> list[Seed]:
    seeds: list[Seed] = []
    for r in rows:
        name = (r.get("person_name") or "").strip()
        topic = (r.get("topic") or "general engineering").strip() or "general engineering"
        summary = (r.get("summary") or "").strip()
        if not name:
            continue
        seeds.append(Seed(person_name=name, topic=topic, summary=summary))
    return seeds


def load_seeds(limit: int = SAMPLE_SIZE) -> tuple[list[Seed], bool]:
    """Return (seeds, used_fallback).

    Tries the in-repo synth.aurora helper first (uses CloudFormation outputs),
    then the AURORA_* env path, then falls back to FALLBACK_SEEDS.
    """
    for loader in (_load_seeds_via_synth_aurora, _load_seeds_via_env):
        seeds = loader(limit)
        if seeds:
            return seeds, False
    return list(FALLBACK_SEEDS), True


# ── HTTP driver ──────────────────────────────────────────────────────────────

def fire_request(session: requests.Session, url: str, seed: Seed, timeout: float = 30.0) -> None:
    """POST one canary request. Doesn't consume the SSE body; just triggers the invocation.

    Raises ``requests.RequestException`` on failure — caller decides what to do.
    """
    payload = {
        "person_name": seed.person_name,
        "topic": seed.topic,
        "summary": seed.summary,
    }
    resp = session.post(url, json=payload, timeout=timeout, stream=True)
    try:
        # Status read forces the request to complete; don't iterate the body.
        if resp.status_code >= 400:
            raise requests.HTTPError(f"HTTP {resp.status_code}", response=resp)
    finally:
        resp.close()


# ── Main loop ────────────────────────────────────────────────────────────────

@dataclass
class Stats:
    sent: int = 0
    errors: int = 0
    start_monotonic: float = 0.0

    def rate_per_min(self) -> float:
        elapsed = max(time.monotonic() - self.start_monotonic, 1e-6)
        return (self.sent / elapsed) * 60.0


def _now_hms() -> str:
    return datetime.now().strftime("%H:%M:%S")


def _print_progress(stats: Stats, prefix: str) -> None:
    print(
        f"[{_now_hms()}] {prefix}sent={stats.sent} errors={stats.errors} "
        f"rate={stats.rate_per_min():.1f}/min",
        flush=True,
    )


def run(
    minutes: float,
    rate_per_min: float,
    middleware_url: str,
    seed_limit: int = SAMPLE_SIZE,
) -> int:
    if rate_per_min <= 0:
        print("error: --rate must be > 0", file=sys.stderr)
        return 2
    if minutes <= 0:
        print("error: --minutes must be > 0", file=sys.stderr)
        return 2

    seeds, used_fallback = load_seeds(limit=seed_limit)
    if not seeds:
        print("error: no seed tuples available (Aurora + fallback both empty)", file=sys.stderr)
        return 2

    tag = "[fallback] " if used_fallback else ""
    url = middleware_url.rstrip("/") + CANARY_PATH
    mean_interval = 60.0 / rate_per_min
    deadline = time.monotonic() + minutes * 60.0
    stats = Stats(start_monotonic=time.monotonic())
    last_progress = stats.start_monotonic

    print(
        f"[{_now_hms()}] {tag}starting canary traffic: url={url} "
        f"rate={rate_per_min:.1f}/min duration={minutes:g}min "
        f"seeds={len(seeds)}",
        flush=True,
    )

    session = requests.Session()

    # SIGINT → graceful shutdown.
    interrupted = {"flag": False}

    def _on_sigint(_signum: int, _frame: Any) -> None:
        interrupted["flag"] = True

    signal.signal(signal.SIGINT, _on_sigint)

    try:
        while not interrupted["flag"] and time.monotonic() < deadline:
            seed = random.choice(seeds)
            try:
                fire_request(session, url, seed)
                stats.sent += 1
            except requests.RequestException as exc:
                stats.errors += 1
                print(f"[{_now_hms()}] {tag}warn: request failed: {exc}", flush=True)
            except Exception as exc:  # pragma: no cover - defensive
                stats.errors += 1
                print(f"[{_now_hms()}] {tag}warn: unexpected error: {exc}", flush=True)

            now = time.monotonic()
            if now - last_progress >= PROGRESS_INTERVAL_SEC:
                _print_progress(stats, tag)
                last_progress = now

            # Jittered sleep, but never past the deadline.
            jitter = random.uniform(1.0 - JITTER_FRAC, 1.0 + JITTER_FRAC)
            sleep_for = max(mean_interval * jitter, 0.0)
            sleep_for = min(sleep_for, max(deadline - time.monotonic(), 0.0))
            if sleep_for > 0 and not interrupted["flag"]:
                time.sleep(sleep_for)
    finally:
        session.close()

    suffix = "interrupted" if interrupted["flag"] else "done"
    print(f"[{_now_hms()}] {tag}{suffix}: ", end="")
    _print_progress(stats, tag)
    return 0


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    default_url = os.environ.get("MIDDLEWARE_URL", "http://localhost:3001")
    parser = argparse.ArgumentParser(
        prog="python -m schema.synth.canary_traffic",
        description="Drive synthetic traffic to the canary /ask endpoint.",
    )
    parser.add_argument("--minutes", type=float, default=240.0,
                        help="Duration in minutes (default: 240).")
    parser.add_argument("--rate", type=float, default=30.0,
                        help="Mean requests per minute (default: 30).")
    parser.add_argument("--middleware-url", type=str, default=default_url,
                        help=f"Middleware base URL (default: {default_url}).")
    parser.add_argument("--seed-limit", type=int, default=SAMPLE_SIZE,
                        help=f"Max seed tuples to fetch from Aurora (default: {SAMPLE_SIZE}).")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    return run(
        minutes=args.minutes,
        rate_per_min=args.rate,
        middleware_url=args.middleware_url,
        seed_limit=args.seed_limit,
    )


if __name__ == "__main__":
    sys.exit(main())
