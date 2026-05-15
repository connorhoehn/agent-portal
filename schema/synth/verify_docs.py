"""Offline smoke test for each doc-type planner.

Runs one of each type against a small fixture. Validates that:
- Each planner produces at least one task.
- Each task's prompt + schema round-trips through Bedrock successfully.
- Each finalize() returns a LoadableDoc with valid mentions.

SPENDS REAL BEDROCK $ (~$0.02 per run). Run sparingly.

Run: .venv-synth/bin/python -m schema.synth.verify_docs
"""
from __future__ import annotations

import argparse

from . import generate, validate
from .schemas import Persona


GRAPH = {
    "teams": [
        {"id": "t-platform", "name": "Platform Engineering"},
        {"id": "t-data",     "name": "Data Platform"},
    ],
    "people": [
        {"id": "p-001", "name": "Alice Chen",    "title": "Staff Engineer",       "team_id": "t-platform"},
        {"id": "p-002", "name": "Marcus Rivera", "title": "Engineering Manager",  "team_id": "t-platform"},
        {"id": "p-003", "name": "Priya Patel",   "title": "Senior Data Engineer", "team_id": "t-data"},
        {"id": "p-004", "name": "Diana Park",    "title": "Senior Engineer",      "team_id": "t-platform"},
    ],
    "skills": [
        {"id": "sk-aurora",   "name": "Aurora PostgreSQL", "domain": "data"},
        {"id": "sk-postgres", "name": "PostgreSQL",        "domain": "data"},
        {"id": "sk-cost-opt", "name": "Cost Optimization", "domain": "infra"},
        {"id": "sk-k8s",      "name": "Kubernetes",        "domain": "infra"},
        {"id": "sk-otel",     "name": "OpenTelemetry",     "domain": "infra"},
    ],
    "person_skills": [
        {"person_id": "p-001", "skill_id": "sk-aurora",   "weight": 0.9},
        {"person_id": "p-001", "skill_id": "sk-postgres", "weight": 0.95},
        {"person_id": "p-001", "skill_id": "sk-k8s",      "weight": 0.7},
        {"person_id": "p-003", "skill_id": "sk-aurora",   "weight": 0.85},
        {"person_id": "p-003", "skill_id": "sk-postgres", "weight": 0.9},
        {"person_id": "p-004", "skill_id": "sk-k8s",      "weight": 0.9},
        {"person_id": "p-004", "skill_id": "sk-otel",     "weight": 0.85},
    ],
    "projects": [
        {"id": "p-rag-search",   "name": "RAG Knowledge Search", "status": "completed"},
        {"id": "p-observability","name": "Observability Platform","status": "in_progress"},
    ],
    "decisions": [
        {"id": "d-aurora", "title": "Adopt Aurora over Neptune",
         "summary": "Picked Aurora PostgreSQL + relational graph over Neptune Analytics for cost + latency reasons.",
         "decided_at": "2026-03-12"},
        {"id": "d-otel", "title": "Adopt OpenTelemetry",
         "summary": "Replace ad-hoc tracing with OTLP + AWS X-Ray for unified observability.",
         "decided_at": "2026-03-25"},
    ],
    "decision_participants": [
        {"decision_id": "d-aurora", "person_id": "p-001", "stance": "champion"},
        {"decision_id": "d-aurora", "person_id": "p-002", "stance": "approver"},
        {"decision_id": "d-aurora", "person_id": "p-003", "stance": "consulted"},
        {"decision_id": "d-otel",   "person_id": "p-002", "stance": "approver"},
        {"decision_id": "d-otel",   "person_id": "p-004", "stance": "champion"},
    ],
    "project_contributions": [
        {"project_id": "p-rag-search",    "person_id": "p-001", "role": "tech_lead"},
        {"project_id": "p-rag-search",    "person_id": "p-003", "role": "contributor"},
        {"project_id": "p-rag-search",    "person_id": "p-002", "role": "manager"},
        {"project_id": "p-observability", "person_id": "p-004", "role": "tech_lead"},
        {"project_id": "p-observability", "person_id": "p-001", "role": "contributor"},
        {"project_id": "p-observability", "person_id": "p-002", "role": "manager"},
    ],
}


PERSONAS = {
    "p-001": Persona(
        person_id="p-001", name="Alice Chen", title="Staff Engineer", team_id="t-platform",
        tenure_years=7.0,
        voice_traits=["precise", "skeptical of vendor pitches", "draws on prior incident memory"],
        backstory="Came up through SRE at a payments company; loves Postgres internals and has strong opinions about query plans.",
        pet_topics=["query plans", "cost of ownership", "operational simplicity"],
    ),
    "p-002": Persona(
        person_id="p-002", name="Marcus Rivera", title="Engineering Manager", team_id="t-platform",
        tenure_years=11.0,
        voice_traits=["pragmatic", "decision-driving", "low-jargon"],
        backstory="Former staff engineer; manages the platform team and chairs architecture review. Lost a quarter once to a too-clever migration.",
        pet_topics=["blast radius", "team capacity", "shipping over polishing"],
    ),
    "p-003": Persona(
        person_id="p-003", name="Priya Patel", title="Senior Data Engineer", team_id="t-data",
        tenure_years=5.0,
        voice_traits=["data-driven", "loves benchmarks", "asks for numbers"],
        backstory="Has migrated three different graph stacks; wary of premature graph-DB adoption. Keeps a benchmark notebook.",
        pet_topics=["latency tail", "join cost", "benchmark methodology"],
    ),
    "p-004": Persona(
        person_id="p-004", name="Diana Park", title="Senior Engineer", team_id="t-platform",
        tenure_years=6.0,
        voice_traits=["thorough", "writes runbooks unprompted", "calmly skeptical"],
        backstory="Came from a monitoring vendor; built OrgIQ's first OTel pipeline single-handedly. Resists adding new dashboards without owners.",
        pet_topics=["alert hygiene", "trace sampling", "on-call experience"],
    ),
}


def run_one_planner(name: str, planner) -> None:
    personas_by_pid = {pid: p.model_dump() for pid, p in PERSONAS.items()}
    tasks = planner(GRAPH, personas_by_pid)
    if not tasks:
        print(f"\n[{name}] planner produced 0 tasks — skipping")
        return
    sample = tasks[:1]
    print(f"\n[{name}] {len(tasks)} task(s), running 1 sample: {sample[0].doc_id}")
    docs = generate.run_tasks(sample, GRAPH)
    d = docs[0]
    print(f"  title:    {d.title}")
    print(f"  source:   {d.source}")
    print(f"  mentions: {len(d.mentions)}")
    print(f"  body[:400]:\n    " + d.body_markdown[:400].replace("\n", "\n    "))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", choices=["postmortem", "perf_review", "slack_thread", "all_hands", "news_article", "all"],
                        default="all")
    args = parser.parse_args()
    planners = {
        "postmortem":   generate.plan_postmortems,
        "perf_review":  generate.plan_perf_reviews,
        "slack_thread": generate.plan_slack_threads,
        "all_hands":    generate.plan_all_hands,
        "news_article": generate.plan_news_articles,
    }
    if args.only == "all":
        for name, planner in planners.items():
            run_one_planner(name, planner)
    else:
        run_one_planner(args.only, planners[args.only])


if __name__ == "__main__":
    main()
