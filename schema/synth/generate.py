"""Doc-generation dispatcher.

Each doc-type's `plan_*` function turns the seed graph into a list of
GenerationTask tuples. `run_tasks` walks the tasks, calls Bedrock with the
right prompt + schema, validates, and stages a LoadableDoc.

Output is staged (not loaded) — `python -m schema.synth load` does the Aurora
+ S3 + KB step separately, so generation can happen offline.
"""
from __future__ import annotations

import json
import logging
import sys
import time
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import random

from botocore.exceptions import ClientError
from pydantic import BaseModel, ValidationError

from . import cache, validate
from .bedrock import converse_with_schema
from .config import CONFIG, NOVA_LITE, NOVA_PRO, SYNTH_DIR
from .load import LoadableDoc
from .prompts import (
    adr as adr_prompts,
    all_hands as all_hands_prompts,
    perf_review as perf_prompts,
    postmortem as postmortem_prompts,
    slack_thread as slack_prompts,
)
from .schemas import (
    ADR, ADRGen,
    AllHandsRecap, AllHandsRecapGen,
    PerfReview, PerfReviewGen,
    Postmortem, PostmortemGen,
    SlackThread, SlackThreadGen,
)

log = logging.getLogger(__name__)

STAGE_DIR = SYNTH_DIR / "staged"
STAGE_DIR.mkdir(exist_ok=True)

# The doc types this pipeline generates — one per `plan_*` planner below, and the
# single source of truth for what `load_staged()` is willing to load.
#
# `staged/` is gitignored scratch that accumulates across runs, so it outlives
# the code that wrote it. A retired tenant's generator was deleted while its 46
# `news_article` JSONs stayed on disk, and because `load_staged()` used to glob
# the directory blind, every subsequent `load` re-uploaded them to S3, re-upserted
# them into `documents`, and re-indexed them into the knowledge base — press
# releases outranking the authoritative ADRs on the very queries this product
# answers. Filtering on this tuple means an orphaned artifact stays inert: no
# generator, no load. Adding a doc type means adding a planner AND a name here.
DOC_TYPES: tuple[str, ...] = (
    "adr",
    "postmortem",
    "perf_review",
    "slack_thread",
    "all_hands",
)


@dataclass
class GenerationTask:
    doc_id: str
    doc_type: str
    model_id: str
    temperature: float
    system: str
    user_prompt: str
    output_model: type[BaseModel]
    finalize: Callable[[BaseModel], LoadableDoc]
    s3_prefix: str


# ── ADR planner ───────────────────────────────────────────────────────────────

def plan_adrs(graph: dict, personas_by_pid: dict[str, dict]) -> list[GenerationTask]:
    """One ADR per decision. Cast = decision_participants."""
    catalog = {
        "teams":    graph["teams"],
        "projects": graph["projects"],
        "skills":   graph["skills"],
    }
    people_by_id = {p["id"]: p for p in graph["people"]}
    participants_by_decision: dict[str, list[dict]] = {}
    for row in graph["decision_participants"]:
        participants_by_decision.setdefault(row["decision_id"], []).append(row)

    tasks: list[GenerationTask] = []
    for decision in graph["decisions"]:
        parts_raw = participants_by_decision.get(decision["id"], [])
        participants = [
            {**row, "name": people_by_id.get(row["person_id"], {}).get("name", row["person_id"])}
            for row in parts_raw
        ]
        cast_personas = [
            personas_by_pid[row["person_id"]]
            for row in parts_raw
            if row["person_id"] in personas_by_pid
        ]
        prompt = adr_prompts.build_prompt(decision, participants, cast_personas, catalog)
        doc_id = f"adr-{decision['id']}"

        def _finalize(gen: ADRGen, _decision=decision, _doc_id=doc_id) -> LoadableDoc:
            adr = ADR(
                decision_id=_decision["id"],
                title=f"ADR: {_decision['title']}",
                **gen.model_dump(),
            )
            # Ensure the parent decision is mentioned even if the model didn't echo it.
            mentions = list(adr.mentions)
            if not any(m.entity_type == "decision" and m.entity_id == _decision["id"] for m in mentions):
                mentions.append(type(adr.mentions[0])(
                    entity_type="decision", entity_id=_decision["id"], context="parent decision",
                )) if adr.mentions else None
            return LoadableDoc(
                id=_doc_id,
                title=adr.title,
                source="adr",
                body_markdown=adr.body_markdown,
                mentions=[m.model_dump() for m in mentions],
                s3_prefix=CONFIG.s3_internal_prefix + "adr",
                doc_type="adr",
                headline=adr.title,
                published_at=_decision.get("decided_at"),
                section="decisions",
            )

        tasks.append(GenerationTask(
            doc_id=doc_id,
            doc_type="adr",
            model_id=NOVA_PRO,
            temperature=CONFIG.temperature_structured,
            system=adr_prompts.SYSTEM,
            user_prompt=prompt,
            output_model=ADRGen,
            finalize=_finalize,
            s3_prefix=CONFIG.s3_internal_prefix + "adr",
        ))
    return tasks


# ── Postmortem planner ────────────────────────────────────────────────────────

INCIDENT_TEMPLATES = [
    ("p99 latency spike on write path", "sev2"),
    ("partial outage after deploy rollback", "sev1"),
    ("secret rotation broke downstream consumers", "sev2"),
    ("kafka consumer lag pinned to ceiling", "sev2"),
    ("data pipeline produced incorrect aggregates for 6 hours", "sev2"),
    ("auth token cache invalidation race", "sev3"),
    ("storage volume filled, writes blocked", "sev1"),
    ("flaky test masked a regression for two weeks", "sev3"),
    ("background job stalled on a missing index", "sev3"),
    ("vector index rebuild knocked search offline for 40 minutes", "sev2"),
]


def plan_postmortems(graph: dict, personas_by_pid: dict[str, dict]) -> list[GenerationTask]:
    """One postmortem per project. Cast = 2-4 project contributors."""
    rng = random.Random(42)
    catalog = {"teams": graph["teams"], "projects": graph["projects"], "skills": graph["skills"]}
    contribs_by_project: dict[str, list[dict]] = {}
    for row in graph["project_contributions"]:
        contribs_by_project.setdefault(row["project_id"], []).append(row)

    tasks: list[GenerationTask] = []
    for project in graph["projects"]:
        contribs = contribs_by_project.get(project["id"], [])
        cast_pids = [c["person_id"] for c in contribs[:5]]
        cast_personas = [personas_by_pid[pid] for pid in cast_pids if pid in personas_by_pid]
        if not cast_personas:
            continue

        incident_title, default_severity = INCIDENT_TEMPLATES[rng.randrange(len(INCIDENT_TEMPLATES))]
        # Spread incident dates across 2026 deterministically per project.
        day = (hash(project["id"]) % 200) + 30
        incident_date = f"2026-{(day // 30) % 12 + 1:02d}-{(day % 28) + 1:02d}"
        prompt = postmortem_prompts.build_prompt(project, incident_title, incident_date, cast_personas, catalog)
        doc_id = f"postmortem-{project['id']}"

        def _finalize(gen: PostmortemGen,
                      _project=project,
                      _doc_id=doc_id,
                      _incident_title=incident_title,
                      _incident_date=incident_date) -> LoadableDoc:
            pm = Postmortem(
                project_id=_project["id"],
                incident_title=_incident_title,
                incident_date=_incident_date,
                **gen.model_dump(),
            )
            return LoadableDoc(
                id=_doc_id,
                title=f"Postmortem: {_incident_title} ({_project['name']})",
                source="postmortem",
                body_markdown=pm.body_markdown,
                mentions=[m.model_dump() for m in pm.mentions],
                s3_prefix=CONFIG.s3_internal_prefix + "postmortem",
                doc_type="postmortem",
                headline=_incident_title,
                published_at=_incident_date,
                section="incidents",
            )

        tasks.append(GenerationTask(
            doc_id=doc_id, doc_type="postmortem",
            model_id=NOVA_PRO, temperature=CONFIG.temperature_structured,
            system=postmortem_prompts.SYSTEM, user_prompt=prompt,
            output_model=PostmortemGen, finalize=_finalize,
            s3_prefix=CONFIG.s3_internal_prefix + "postmortem",
        ))
    return tasks


# ── Perf review planner ───────────────────────────────────────────────────────

def plan_perf_reviews(graph: dict, personas_by_pid: dict[str, dict]) -> list[GenerationTask]:
    """One perf review per person — highest scoring signal."""
    catalog = {"teams": graph["teams"], "projects": graph["projects"], "skills": graph["skills"]}
    skill_by_id = {s["id"]: s for s in graph["skills"]}
    project_by_id = {p["id"]: p for p in graph["projects"]}

    skills_by_person: dict[str, list[dict]] = {}
    for row in graph["person_skills"]:
        s = skill_by_id.get(row["skill_id"])
        if s:
            skills_by_person.setdefault(row["person_id"], []).append({**s, "weight": row.get("weight")})

    projects_by_person: dict[str, list[dict]] = {}
    for row in graph["project_contributions"]:
        p = project_by_id.get(row["project_id"])
        if p:
            projects_by_person.setdefault(row["person_id"], []).append({**p, "role": row.get("role")})

    tasks: list[GenerationTask] = []
    for person in graph["people"]:
        persona = personas_by_pid.get(person["id"])
        if not persona:
            continue
        subj_skills = skills_by_person.get(person["id"], [])[:6]
        subj_projects = projects_by_person.get(person["id"], [])[:4]
        if not subj_skills or not subj_projects:
            # Skipping people with no skill/project rows — review would be too thin.
            continue
        review_period = "Q1 2026"
        prompt = perf_prompts.build_prompt(persona, review_period, subj_skills, subj_projects, catalog)
        doc_id = f"perf-{person['id']}"

        def _finalize(gen: PerfReviewGen, _person=person, _doc_id=doc_id, _period=review_period) -> LoadableDoc:
            pr = PerfReview(subject_id=_person["id"], review_period=_period, **gen.model_dump())
            mentions = [m.model_dump() for m in pr.mentions]
            # Ensure the subject is always in mentions.
            if not any(m["entity_type"] == "person" and m["entity_id"] == _person["id"] for m in mentions):
                mentions.append({"entity_type": "person", "entity_id": _person["id"], "context": "subject"})
            return LoadableDoc(
                id=_doc_id,
                title=f"Perf Review: {_person['name']} — {_period}",
                source="perf_review",
                body_markdown=pr.body_markdown,
                mentions=mentions,
                s3_prefix=CONFIG.s3_internal_prefix + "perf_review",
                doc_type="perf_review",
                headline=f"Perf Review: {_person['name']} — {_period}",
                section="people",
            )

        tasks.append(GenerationTask(
            doc_id=doc_id, doc_type="perf_review",
            model_id=NOVA_PRO, temperature=CONFIG.temperature_structured,
            system=perf_prompts.SYSTEM, user_prompt=prompt,
            output_model=PerfReviewGen, finalize=_finalize,
            s3_prefix=CONFIG.s3_internal_prefix + "perf_review",
        ))
    return tasks


# ── Slack thread planner ──────────────────────────────────────────────────────

SLACK_TOPICS = [
    "deciding whether to revert a flaky deploy",
    "review feedback on a PR with conflicting opinions",
    "incident triage in the first 10 minutes",
    "scope debate on an upcoming sprint",
    "celebrating a launch that went smoothly",
    "kicking the tires on a new tool",
    "design review screenshots and quick reactions",
    "deciding who picks up an oncall handoff",
    "weighing two competing library choices",
    "post-mortem readout follow-up discussion",
]


def plan_slack_threads(graph: dict, personas_by_pid: dict[str, dict]) -> list[GenerationTask]:
    """N threads per project, cast = a sample of project contributors."""
    rng = random.Random(7)
    catalog = {"teams": graph["teams"], "projects": graph["projects"], "skills": graph["skills"]}
    project_by_id = {p["id"]: p for p in graph["projects"]}
    contribs_by_project: dict[str, list[str]] = {}
    for row in graph["project_contributions"]:
        contribs_by_project.setdefault(row["project_id"], []).append(row["person_id"])

    tasks: list[GenerationTask] = []
    for project in graph["projects"]:
        pids = contribs_by_project.get(project["id"], [])
        if len(pids) < 3:
            continue
        for i in range(CONFIG.n_slack_threads_per_project):
            sample = rng.sample(pids, k=min(4, len(pids)))
            cast = [personas_by_pid[pid] for pid in sample if pid in personas_by_pid]
            if len(cast) < 2:
                continue
            topic = SLACK_TOPICS[(hash((project["id"], i)) % len(SLACK_TOPICS))]
            channel = f"#proj-{project['id'].replace('p-', '')}"
            prompt = slack_prompts.build_prompt(channel, project, None, topic, cast, catalog)
            doc_id = f"slack-{project['id']}-{i:02d}"

            def _finalize(gen: SlackThreadGen,
                          _project=project, _channel=channel, _topic=topic, _doc_id=doc_id) -> LoadableDoc:
                thread = SlackThread(
                    channel=_channel, project_id=_project["id"], team_id=None,
                    **gen.model_dump(),
                )
                return LoadableDoc(
                    id=_doc_id,
                    title=f"#{_channel.lstrip('#')} — {_topic}",
                    source="slack_thread",
                    body_markdown=thread.body_markdown,
                    mentions=[m.model_dump() for m in thread.mentions],
                    s3_prefix=CONFIG.s3_internal_prefix + "slack",
                    doc_type="slack_thread",
                    section="chat",
                )

            tasks.append(GenerationTask(
                doc_id=doc_id, doc_type="slack_thread",
                model_id=NOVA_LITE, temperature=CONFIG.temperature_casual,
                system=slack_prompts.SYSTEM, user_prompt=prompt,
                output_model=SlackThreadGen, finalize=_finalize,
                s3_prefix=CONFIG.s3_internal_prefix + "slack",
            ))
    return tasks


# ── All-hands planner ─────────────────────────────────────────────────────────

def plan_all_hands(graph: dict, personas_by_pid: dict[str, dict]) -> list[GenerationTask]:
    """N monthly recaps spread across 2026, each highlighting a rotating cast."""
    rng = random.Random(13)
    catalog = {"teams": graph["teams"], "projects": graph["projects"], "skills": graph["skills"]}
    people = graph["people"]
    projects = graph["projects"]
    decisions_sorted = sorted(graph["decisions"], key=lambda d: d.get("decided_at") or "")

    tasks: list[GenerationTask] = []
    for i in range(CONFIG.n_all_hands):
        month = i + 1
        date = f"2026-{month:02d}-15"
        quarter = f"Q{((month - 1) // 3) + 1} 2026"
        hi_projects = rng.sample(projects, k=min(4, len(projects)))
        hi_people_raw = rng.sample(people, k=min(8, len(people)))
        hi_people = [
            {**p, **personas_by_pid.get(p["id"], {})}
            for p in hi_people_raw
            if p["id"] in personas_by_pid
        ]
        # Recent decisions: those with decided_at <= this all-hands date.
        recent = [d for d in decisions_sorted if (d.get("decided_at") or "") <= date][-3:]

        prompt = all_hands_prompts.build_prompt(date, quarter, hi_projects, hi_people, recent, catalog)
        doc_id = f"all-hands-{date}"

        def _finalize(gen: AllHandsRecapGen, _date=date, _quarter=quarter, _doc_id=doc_id) -> LoadableDoc:
            recap = AllHandsRecap(date=_date, quarter=_quarter, **gen.model_dump())
            return LoadableDoc(
                id=_doc_id,
                title=f"All-Hands — {_date}",
                source="all_hands",
                body_markdown=recap.body_markdown,
                mentions=[m.model_dump() for m in recap.mentions],
                s3_prefix=CONFIG.s3_internal_prefix + "all_hands",
                doc_type="all_hands",
                headline=recap.headline,
                published_at=_date,
                section="company",
            )

        tasks.append(GenerationTask(
            doc_id=doc_id, doc_type="all_hands",
            model_id=NOVA_LITE, temperature=CONFIG.temperature_casual,
            system=all_hands_prompts.SYSTEM, user_prompt=prompt,
            output_model=AllHandsRecapGen, finalize=_finalize,
            s3_prefix=CONFIG.s3_internal_prefix + "all_hands",
        ))
    return tasks


# ── Runner ────────────────────────────────────────────────────────────────────

def run_tasks(tasks: list[GenerationTask], graph: dict) -> list[LoadableDoc]:
    index = validate.build_entity_index(graph)
    staged: list[LoadableDoc] = []
    for i, task in enumerate(tasks, 1):
        key = cache.cache_key("doc-v1", task.doc_id, task.model_id, task.user_prompt)
        hit = cache.get(f"docs/{task.doc_type}", key)
        if hit:
            loadable = LoadableDoc(**hit)
        else:
            # Models occasionally drop required fields (ValidationError) or
            # emit a broken tool-use sequence (Bedrock ModelErrorException) —
            # retry a few times before letting the whole pipeline die on one doc.
            last_err: Exception | None = None
            gen = None
            for attempt in range(4):
                try:
                    gen = converse_with_schema(
                        task.output_model,
                        system=task.system,
                        user_prompt=task.user_prompt,
                        model_id=task.model_id,
                        # Nudge temperature up on retries for a different sample.
                        temperature=min(1.0, task.temperature + 0.15 * attempt),
                        max_tokens=CONFIG.max_output_tokens,
                    )
                    break
                except ValidationError as err:
                    last_err = err
                    print(f"  retry {attempt + 1}/4: {task.doc_type} {key} failed validation")
                except ClientError as err:
                    code = err.response.get("Error", {}).get("Code", "")
                    if code not in ("ModelErrorException", "ThrottlingException", "ServiceUnavailableException"):
                        raise
                    last_err = err
                    print(f"  retry {attempt + 1}/4: {task.doc_type} {key} bedrock {code}")
                    time.sleep(2 * (attempt + 1))
            if gen is None:
                raise last_err  # type: ignore[misc]
            loadable = task.finalize(gen)
            cache.put(f"docs/{task.doc_type}", key, loadable.__dict__)

        # Closure-check mentions against the seed graph; drop hallucinated ones.
        valid, dropped = validate.check_mentions_closure(loadable.mentions, index)
        if dropped:
            log.info("%s: dropped %d hallucinated mentions", task.doc_id, len(dropped))
        loadable.mentions = valid
        # Slug-leak warning — non-blocking, but worth surfacing during runs.
        slugs = validate.slugs_in_prose(loadable.body_markdown)
        if slugs:
            log.warning("%s: %d slug(s) leaked into prose: %s", task.doc_id, len(slugs), slugs[:5])
        _stage(loadable)
        staged.append(loadable)
        print(f"  [{i}/{len(tasks)}] {task.doc_id} ({len(loadable.mentions)} mentions)", file=sys.stderr)
    return staged


def _stage(doc: LoadableDoc) -> None:
    """Write the finalized LoadableDoc to staged/ so `load` can pick it up later."""
    out = STAGE_DIR / f"{doc.id}.json"
    out.write_text(json.dumps(doc.__dict__, indent=2))


def load_staged() -> list[LoadableDoc]:
    """Read the staged JSON for every live doc type as a LoadableDoc.

    Docs whose `doc_type` is not in DOC_TYPES are skipped and counted, not
    loaded — see the note on DOC_TYPES for why the directory is not trusted on
    its own. The skip is logged at WARNING because a non-empty count means
    there is scratch on disk that no generator claims any more.
    """
    docs: list[LoadableDoc] = []
    skipped: Counter[str] = Counter()
    for p in sorted(STAGE_DIR.glob("*.json")):
        doc = LoadableDoc(**json.loads(p.read_text()))
        if doc.doc_type not in DOC_TYPES:
            skipped[doc.doc_type or "<none>"] += 1
            continue
        docs.append(doc)
    if skipped:
        detail = ", ".join(f"{n}× {t}" for t, n in sorted(skipped.items()))
        log.warning(
            "load_staged: skipped %d staged doc(s) of retired type(s) (%s) — "
            "no generator produces these; they will not be loaded or indexed",
            sum(skipped.values()), detail,
        )
    return docs
