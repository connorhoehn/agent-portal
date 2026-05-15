"""Aurora RDS Data API wrapper for the synth pipeline.

Reads the seed graph (populated by schema/seed.py) and provides batched upserts
for documents/mentions/newsroom tables. Cluster ARNs are resolved once from the
OrgIQ-Aurora CloudFormation stack.
"""
from __future__ import annotations

import subprocess
from functools import lru_cache
from typing import Any

import boto3

from .config import CONFIG


@lru_cache(maxsize=1)
def _arns() -> tuple[str, str]:
    def cf(key: str) -> str:
        return subprocess.check_output([
            "aws", "cloudformation", "describe-stacks",
            "--stack-name", CONFIG.aurora_stack, "--region", CONFIG.region,
            "--query", f"Stacks[0].Outputs[?OutputKey=='{key}'].OutputValue",
            "--output", "text",
        ], text=True).strip()
    return cf("ClusterArn"), cf("CredentialsSecretArn")


@lru_cache(maxsize=1)
def _client():
    return boto3.client("rds-data", region_name=CONFIG.region)


def _coerce(v: dict) -> Any:
    """Collapse an RDS Data API field dict to a Python value."""
    if v.get("isNull"):
        return None
    for k in ("stringValue", "longValue", "doubleValue", "booleanValue"):
        if k in v:
            return v[k]
    return None


def execute(sql: str, params: list[dict] | None = None) -> list[dict]:
    """Run a single statement. Returns rows as list-of-dicts keyed by column name."""
    cluster_arn, secret_arn = _arns()
    kwargs = dict(
        resourceArn=cluster_arn,
        secretArn=secret_arn,
        database=CONFIG.aurora_db,
        sql=sql,
        includeResultMetadata=True,
    )
    if params:
        kwargs["parameters"] = params
    resp = _client().execute_statement(**kwargs)
    cols = [c["name"] for c in resp.get("columnMetadata", [])]
    return [
        {col: _coerce(field) for col, field in zip(cols, row)}
        for row in resp.get("records", [])
    ]


def execute_many(sql: str, param_sets: list[list[dict]]) -> None:
    """Batch-insert via BatchExecuteStatement. param_sets is list of parameter arrays."""
    if not param_sets:
        return
    cluster_arn, secret_arn = _arns()
    # BatchExecuteStatement caps at 25 sets per call.
    for i in range(0, len(param_sets), 25):
        _client().batch_execute_statement(
            resourceArn=cluster_arn,
            secretArn=secret_arn,
            database=CONFIG.aurora_db,
            sql=sql,
            parameterSets=param_sets[i:i + 25],
        )


# ── Seed-graph readers ────────────────────────────────────────────────────────

def fetch_people() -> list[dict]:
    return execute("SELECT id, name, email, title, team_id FROM people ORDER BY id")


def fetch_teams() -> list[dict]:
    return execute("SELECT id, name FROM teams ORDER BY id")


def fetch_skills() -> list[dict]:
    return execute("SELECT id, name, domain FROM skills ORDER BY id")


def fetch_person_skills() -> list[dict]:
    return execute("SELECT person_id, skill_id, weight FROM person_skills")


def fetch_projects() -> list[dict]:
    return execute("SELECT id, name, status FROM projects ORDER BY id")


def fetch_decisions() -> list[dict]:
    return execute("SELECT id, title, summary, decided_at FROM decisions ORDER BY decided_at")


def fetch_decision_participants() -> list[dict]:
    return execute("SELECT decision_id, person_id, stance FROM decision_participants")


def fetch_project_contributions() -> list[dict]:
    return execute("SELECT project_id, person_id, role, weight FROM project_contributions")


def fetch_seed_graph() -> dict:
    """One-shot snapshot of the seed graph for the planner."""
    return {
        "people": fetch_people(),
        "teams": fetch_teams(),
        "skills": fetch_skills(),
        "person_skills": fetch_person_skills(),
        "projects": fetch_projects(),
        "decisions": fetch_decisions(),
        "decision_participants": fetch_decision_participants(),
        "project_contributions": fetch_project_contributions(),
    }
