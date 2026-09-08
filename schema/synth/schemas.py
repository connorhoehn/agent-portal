"""Pydantic models for each doc type.

These serve two purposes:
1. Force the LLM to emit JSON matching this shape, via Converse `toolConfig`.
2. Validate generated output before it touches Aurora.

`Mention` is the common edge — every doc type emits a `mentions` list that the
loader translates into rows in the `mentions` table.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


# ── Shared ────────────────────────────────────────────────────────────────────

EntityType = Literal["person", "team", "project", "skill", "decision"]


class Mention(BaseModel):
    entity_type: EntityType
    entity_id: str = Field(..., description="Must match an id from the seed graph (e.g. p-003, t-platform, sk-kubernetes).")
    context: str = Field("", description="Short snippet showing how this entity appears.")


# ── Personas ──────────────────────────────────────────────────────────────────

class PersonaGen(BaseModel):
    """Only the fields the LLM is asked to generate — identity fields are
    merged in afterwards from the seed graph so the model can't drift on them.
    """
    tenure_years: float = Field(..., ge=0.0, le=25.0)
    voice_traits: list[str] = Field(..., min_length=2, max_length=5, description="e.g. 'wry', 'data-driven', 'avoids jargon'.")
    backstory: str = Field(..., min_length=80, max_length=400)
    pet_topics: list[str] = Field(..., min_length=1, max_length=5)


class Persona(PersonaGen):
    person_id: str
    name: str
    title: str
    team_id: str


# ── Internal docs ─────────────────────────────────────────────────────────────

class ADRGen(BaseModel):
    """Model-emitted fields for an ADR. Identity fields (decision_id, title)
    are merged in afterward — Nova tends to elide anything it can infer from
    the prompt, so we don't ask it to echo them.
    """
    status: Literal["proposed", "accepted", "superseded", "rejected"]
    context: str = Field(..., min_length=120)
    options: list[str] = Field(..., min_length=2, max_length=5)
    decision: str = Field(..., min_length=80)
    consequences: list[str] = Field(..., min_length=2, max_length=6)
    body_markdown: str = Field(..., min_length=400, description="Full rendered ADR. Reference participants by name and skills by name.")
    mentions: list[Mention]


class ADR(ADRGen):
    decision_id: str = Field(..., description="FK into the decisions table, e.g. d-aurora.")
    title: str


class PostmortemGen(BaseModel):
    severity: Literal["sev1", "sev2", "sev3"]
    summary: str = Field(..., min_length=80)
    timeline: list[str] = Field(..., min_length=3, max_length=12, description="Each entry like '14:02 — alert fires on db-write latency'.")
    root_cause: str = Field(..., min_length=80)
    action_items: list[str] = Field(..., min_length=2, max_length=8)
    body_markdown: str = Field(..., min_length=500)
    mentions: list[Mention]


class Postmortem(PostmortemGen):
    project_id: str
    incident_title: str
    incident_date: str = Field(..., description="ISO date, e.g. 2026-04-12.")


class PerfReviewGen(BaseModel):
    strengths: list[str] = Field(..., min_length=2, max_length=5)
    growth_areas: list[str] = Field(..., min_length=1, max_length=4)
    project_callouts: list[str] = Field(..., min_length=1, max_length=5, description="Each names a project this person contributed to and what they did. Use the project's name, not its id.")
    skill_demonstrations: list[str] = Field(..., min_length=2, max_length=6, description="Each names a skill this person demonstrated and concrete evidence. Use the skill's name, not its id.")
    body_markdown: str = Field(..., min_length=400)
    mentions: list[Mention]


class PerfReview(PerfReviewGen):
    subject_id: str = Field(..., description="The person being reviewed (p-NNN).")
    review_period: str = Field(..., description="e.g. 'Q1 2026'.")


class SlackThreadGen(BaseModel):
    """Slack threads are rendered straight into body_markdown — Nova-Lite is
    unreliable at generating nested arrays of objects, and we don't store
    per-message rows in Aurora anyway."""
    body_markdown: str = Field(..., min_length=200, description="Rendered thread. Each line like: **alice** [14:02] yeah agreed, let's revert.")
    mentions: list[Mention]


class SlackThread(SlackThreadGen):
    channel: str = Field(..., description="e.g. #proj-auth-migration.")
    project_id: str | None = None
    team_id: str | None = None


class AllHandsRecapGen(BaseModel):
    headline: str
    sections: list[str] = Field(..., min_length=3, max_length=8, description="Topic recaps, each ~2-4 sentences referencing people/projects.")
    body_markdown: str = Field(..., min_length=500)
    mentions: list[Mention]


class AllHandsRecap(AllHandsRecapGen):
    date: str = Field(..., description="ISO date.")
    quarter: str


# ── Registry ──────────────────────────────────────────────────────────────────

DOC_SCHEMAS: dict[str, type[BaseModel]] = {
    "adr": ADR,
    "postmortem": Postmortem,
    "perf_review": PerfReview,
    "slack_thread": SlackThread,
    "all_hands": AllHandsRecap,
}
