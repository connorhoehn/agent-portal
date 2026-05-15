"""Deterministic validators for generated docs.

Run after generation, before load. Reject (don't auto-fix) so the caller can
decide to regenerate or drop.
"""
from __future__ import annotations

import re
from dataclasses import dataclass


SLUG_PATTERN = re.compile(r"\b(?:p-[a-z][a-z0-9-]+|sk-[a-z][a-z0-9-]+|t-[a-z][a-z0-9-]+|d-[a-z][a-z0-9-]+)\b")


def slugs_in_prose(body: str) -> list[str]:
    """Return any slug-shaped tokens (p-*, sk-*, t-*, d-*) found in prose."""
    return SLUG_PATTERN.findall(body)


@dataclass
class ValidationResult:
    ok: bool
    errors: list[str]
    dropped_mentions: list[dict]


def build_entity_index(graph: dict) -> dict[str, set[str]]:
    """Flatten the seed graph into {entity_type: {ids...}} for closure checks."""
    return {
        "person":   {p["id"] for p in graph["people"]},
        "team":     {t["id"] for t in graph["teams"]},
        "skill":    {s["id"] for s in graph["skills"]},
        "project":  {p["id"] for p in graph["projects"]},
        "decision": {d["id"] for d in graph["decisions"]},
    }


def check_mentions_closure(
    mentions: list[dict],
    index: dict[str, set[str]],
) -> tuple[list[dict], list[dict]]:
    """Split mentions into (valid, dropped). Drops anything pointing at an ID
    that isn't in the seed graph — the model hallucinated it."""
    valid: list[dict] = []
    dropped: list[dict] = []
    for m in mentions:
        et = m.get("entity_type")
        eid = m.get("entity_id")
        if et in index and eid in index[et]:
            valid.append(m)
        else:
            dropped.append(m)
    return valid, dropped


def validate_adr(doc: dict, index: dict[str, set[str]]) -> ValidationResult:
    errors: list[str] = []

    # The decision_id must exist.
    if doc.get("decision_id") not in index["decision"]:
        errors.append(f"decision_id {doc.get('decision_id')!r} not in seed graph")

    # Body should at least mention something — empty mentions list is suspicious.
    valid, dropped = check_mentions_closure(doc.get("mentions", []), index)
    if not valid:
        errors.append("no valid mentions after closure check")

    # Status sanity (Pydantic already enforced the literal, but defend in depth).
    if doc.get("status") not in {"proposed", "accepted", "superseded", "rejected"}:
        errors.append(f"unknown status {doc.get('status')!r}")

    return ValidationResult(
        ok=(not errors),
        errors=errors,
        dropped_mentions=dropped,
    )
