"""Which Aurora credential an agent uses to run a query, and why.

Two secrets exist for one cluster:

``AURORA_SECRET_ARN``
    The cluster's admin credential (the master user). It can write. Every
    agent that mutates durable state — ingestion, graph-builder, scoring —
    needs it, and always will.

``AURORA_READONLY_SECRET_ARN``
    ``orgiq_graph_reader``, created by ``schema/graph_readonly_role.sql``:
    LOGIN, no ownership, no escalation attributes, ``SELECT`` on the fourteen
    org-graph tables the read tools describe to the model, and nothing else.
    Pinned to ``default_transaction_read_only = on``, so even a mistaken grant
    cannot produce a write through it.

The read agents (``search``, ``advisor``) hand *model-authored* SQL to the RDS
Data API. ``_shared/sql_guard.py`` inspects that SQL before it runs and is
worth keeping — it is the layer that gives the model a usable error, and it
catches the attempt at the door. But a regex over SQL someone else wrote is an
argument about parsing, and the attacker gets to pick the argument. A role that
cannot write is a fact PostgreSQL enforces. This module picks that role.

Missing read-only credentials fail closed. Local experiments may explicitly set
``APP_ENV=development`` and ``ALLOW_UNSAFE_SQL_ADMIN_FALLBACK=true`` to use the
admin credential; deployed runtimes set ``APP_ENV=production`` and cannot
activate this fallback. Permission errors never trigger another credential.

Stdlib only, no boto3 — so it can be unit tested anywhere.
"""

from __future__ import annotations

import os

#: Env var carrying the ARN of the cluster admin credential (can write).
ADMIN_SECRET_ENV = "AURORA_SECRET_ARN"

#: Env var carrying the ARN of the ``orgiq_graph_reader`` credential.
READONLY_SECRET_ENV = "AURORA_READONLY_SECRET_ARN"

#: The database role behind READONLY_SECRET_ENV. Named here so an error
#: message can name it without the agents hardcoding a string.
READONLY_ROLE = "orgiq_graph_reader"

RUNBOOK = "docs/readonly-graph-role.md"


def read_only_secret_arn() -> str:
    """The ``orgiq_graph_reader`` secret ARN, or ``""`` when not configured."""
    return (os.environ.get(READONLY_SECRET_ENV) or "").strip()


def admin_secret_arn() -> str:
    """The cluster admin secret ARN, or ``""``."""
    return (os.environ.get(ADMIN_SECRET_ENV) or "").strip()


def read_only_enforced() -> bool:
    """True when reads go through a role the database will not let write."""
    return bool(read_only_secret_arn())


def read_secret_arn() -> str:
    """Credential for model-authored graph queries; missing reader fails closed."""
    reader = read_only_secret_arn()
    if reader:
        return reader
    if _unsafe_development_fallback():
        return admin_secret_arn()
    raise RuntimeError(f"{READONLY_SECRET_ENV} is required for graph queries; see {RUNBOOK}")


def _unsafe_development_fallback() -> bool:
    return (os.environ.get("APP_ENV") == "development"
            and os.environ.get("ALLOW_UNSAFE_SQL_ADMIN_FALLBACK") == "true")


def credential_diagnosis() -> str:
    """One line for a log or an error, saying which boundary is actually live.

    Worth emitting at agent start: "the read-only role is configured" and "the
    read-only role is not configured" look identical from the outside until
    something goes wrong, and by then the trace is what you have.
    """
    if read_only_enforced():
        return (
            f"query_graph reads as {READONLY_ROLE} — writes are refused by the "
            "database, not only by sql_guard"
        )
    if _unsafe_development_fallback():
        return f"Explicit unsafe development fallback: sql_guard is the only write guard. See {RUNBOOK}."
    return f"query_graph is disabled: {READONLY_SECRET_ENV} is required; sql_guard alone is insufficient. See {RUNBOOK}."
