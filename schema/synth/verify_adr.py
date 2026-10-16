"""Offline ADR smoke test — no Aurora needed.

Builds a tiny fictional seed graph + personas, runs the ADR generator on one
decision, prints the result. Lets us validate prompt + schema + validator
without deploying the cluster.

SPENDS REAL BEDROCK $ (~$0.01 per run). Run sparingly.

Run: .venv-synth/bin/python -m schema.synth.verify_adr
"""
from __future__ import annotations

import json

from . import generate, validate
from .schemas import Persona


FIXTURE_GRAPH = {
    "teams": [
        {"id": "t-platform", "name": "Platform Engineering"},
        {"id": "t-data",     "name": "Data Platform"},
    ],
    "people": [
        {"id": "p-001", "name": "Alice Chen",    "title": "Staff Engineer",      "team_id": "t-platform"},
        {"id": "p-002", "name": "Marcus Rivera", "title": "Engineering Manager", "team_id": "t-platform"},
        {"id": "p-003", "name": "Priya Patel",   "title": "Senior Data Engineer","team_id": "t-data"},
    ],
    "skills": [
        {"id": "sk-aurora",    "name": "Aurora PostgreSQL", "domain": "data"},
        {"id": "sk-neptune",   "name": "Neptune",            "domain": "data"},
        {"id": "sk-postgres",  "name": "PostgreSQL",         "domain": "data"},
        {"id": "sk-cost-opt",  "name": "Cost Optimization",  "domain": "infra"},
    ],
    "person_skills": [],
    "projects": [
        {"id": "p-rag-search", "name": "RAG Knowledge Search", "status": "completed"},
    ],
    "decisions": [
        {
            "id": "d-aurora",
            "title": "Adopt Aurora over Neptune",
            "summary": "The org graph needs graph-shaped questions (who worked with whom, paths across teams) joined to projects and decisions. Neptune Analytics answered the graph questions well but meant a second database, a second query language and a separate backup story. Aurora PostgreSQL with relational edge tables and recursive CTEs answered every query we had under 200 ms p95 on the full graph. We gave up native graph algorithms, so centrality scores run as a nightly batch job instead of a query.",
            "decided_at": "2026-03-12",
        }
    ],
    "decision_participants": [
        {"decision_id": "d-aurora", "person_id": "p-001", "stance": "champion"},
        {"decision_id": "d-aurora", "person_id": "p-002", "stance": "approver"},
        {"decision_id": "d-aurora", "person_id": "p-003", "stance": "consulted"},
    ],
    "project_contributions": [],
}


FIXTURE_PERSONAS = [
    Persona(
        person_id="p-001", name="Alice Chen", title="Staff Engineer", team_id="t-platform",
        tenure_years=7.0,
        voice_traits=["precise", "skeptical of vendor pitches", "draws on prior incident memory"],
        backstory="Came up through SRE at a payments company; loves Postgres internals and has strong opinions about query plans. Hates magic that nobody on the team can explain at 3am.",
        pet_topics=["query plans", "cost of ownership", "operational simplicity"],
    ),
    Persona(
        person_id="p-002", name="Marcus Rivera", title="Engineering Manager", team_id="t-platform",
        tenure_years=11.0,
        voice_traits=["pragmatic", "decision-driving", "low-jargon"],
        backstory="Former staff engineer, now manages the platform team and chairs the architecture review. Lost a quarter once to a too-clever migration and writes ADRs accordingly.",
        pet_topics=["blast radius", "team capacity", "shipping over polishing"],
    ),
    Persona(
        person_id="p-003", name="Priya Patel", title="Senior Data Engineer", team_id="t-data",
        tenure_years=5.0,
        voice_traits=["data-driven", "loves benchmarks", "asks for numbers"],
        backstory="Has migrated three different graph stacks; wary of premature graph-DB adoption. Keeps a benchmark notebook with results she will absolutely cite at you.",
        pet_topics=["latency tail", "join cost", "benchmark methodology"],
    ),
]


def main():
    personas_by_pid = {p.person_id: p.model_dump() for p in FIXTURE_PERSONAS}
    tasks = generate.plan_adrs(FIXTURE_GRAPH, personas_by_pid)
    print(f"Planned {len(tasks)} ADR task(s).")
    docs = generate.run_tasks(tasks, FIXTURE_GRAPH)
    for d in docs:
        print("\n" + "=" * 72)
        print(f"DOC: {d.id}  title={d.title!r}  source={d.source}")
        print(f"mentions ({len(d.mentions)}):")
        for m in d.mentions:
            print(f"  - {m['entity_type']:9} {m['entity_id']}")
        print("\nbody_markdown (first 1200 chars):")
        print(d.body_markdown[:1200])
        if len(d.body_markdown) > 1200:
            print(f"... [+{len(d.body_markdown) - 1200} more chars]")


if __name__ == "__main__":
    main()
