"""Titan-v2 embeddings for seed-graph nodes.

For each node in the org graph, build a short text representation and embed it.
Results land in cache/embeddings_nodes/ — the loader reads from cache to
upsert `node_embeddings` rows so we never re-embed unchanged nodes.
"""
from __future__ import annotations

import logging
import sys

from . import cache
from .bedrock import embed_text

log = logging.getLogger(__name__)


def _person_text(person: dict, skills: list[dict], projects: list[dict]) -> str:
    skill_names = ", ".join(s["name"] for s in skills) or "no listed skills"
    project_names = ", ".join(p["name"] for p in projects) or "no listed projects"
    return (
        f"{person['name']}, {person.get('title', '')} on team {person['team_id']}. "
        f"Skills: {skill_names}. Projects: {project_names}."
    )


def _skill_text(skill: dict) -> str:
    return f"Skill: {skill['name']}. Domain: {skill.get('domain', 'unknown')}."


def _project_text(project: dict) -> str:
    return f"Project: {project['name']}. Status: {project.get('status', 'unknown')}."


def _decision_text(decision: dict) -> str:
    return f"Decision: {decision['title']}. {decision.get('summary') or ''}"


def _team_text(team: dict) -> str:
    return f"Team: {team['name']}."


def _embed_cached(node_id: str, node_type: str, text: str) -> dict:
    key = cache.cache_key("node-embed-v1", node_id, len(text))
    hit = cache.get("embeddings_nodes", key)
    if hit:
        return hit
    vec = embed_text(text)
    row = {"node_id": node_id, "node_type": node_type, "content": text, "embedding": vec}
    cache.put("embeddings_nodes", key, row)
    return row


def embed_all_nodes(graph: dict) -> list[dict]:
    """Embed every node in the seed graph; returns rows ready for node_embeddings."""
    skill_by_id = {s["id"]: s for s in graph["skills"]}
    project_by_id = {p["id"]: p for p in graph["projects"]}

    skills_by_person: dict[str, list[dict]] = {}
    for row in graph["person_skills"]:
        if row["skill_id"] in skill_by_id:
            skills_by_person.setdefault(row["person_id"], []).append(skill_by_id[row["skill_id"]])

    projects_by_person: dict[str, list[dict]] = {}
    for row in graph["project_contributions"]:
        if row["project_id"] in project_by_id:
            projects_by_person.setdefault(row["person_id"], []).append(project_by_id[row["project_id"]])

    rows: list[dict] = []
    total = len(graph["people"]) + len(graph["teams"]) + len(graph["skills"]) + len(graph["projects"]) + len(graph["decisions"])
    i = 0

    for p in graph["people"]:
        text = _person_text(p, skills_by_person.get(p["id"], []), projects_by_person.get(p["id"], []))
        rows.append(_embed_cached(p["id"], "person", text))
        i += 1
    for t in graph["teams"]:
        rows.append(_embed_cached(t["id"], "team", _team_text(t)))
        i += 1
    for s in graph["skills"]:
        rows.append(_embed_cached(s["id"], "skill", _skill_text(s)))
        i += 1
    for proj in graph["projects"]:
        rows.append(_embed_cached(proj["id"], "project", _project_text(proj)))
        i += 1
    for d in graph["decisions"]:
        rows.append(_embed_cached(d["id"], "decision", _decision_text(d)))
        i += 1
        if i % 20 == 0:
            print(f"  embedded {i}/{total}", file=sys.stderr)
    print(f"  embedded {len(rows)}/{total} nodes", file=sys.stderr)
    return rows
