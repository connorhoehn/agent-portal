"""Generate one Persona per person in the seed graph.

Each persona captures voice traits, tenure, backstory, and pet topics. The
combined personas.json gets prepended to every downstream doc-generation prompt
so the cast stays consistent across the corpus.

Cached per person_id under `cache/personas/`. Re-running is free for unchanged
people; delete the cache dir to force regen.
"""
from __future__ import annotations

import json
import logging
import sys
from pathlib import Path

from . import aurora, cache
from .bedrock import converse_with_schema
from .config import CONFIG, NOVA_PRO, SYNTH_DIR
from .schemas import Persona, PersonaGen

log = logging.getLogger(__name__)

PERSONAS_FILE = SYNTH_DIR / "personas.json"


SYSTEM_PROMPT = (
    "You write employee personas for a realistic mid-sized tech company called OrgIQ. "
    "Personas should feel specific, not stereotypical — give each person a distinct voice "
    "and at least one quirk that isn't obvious from their title. Avoid clichés. "
    "Always emit via the `emit` tool."
)


def _build_prompt(person: dict, team_name: str, top_skills: list[str]) -> str:
    skills_line = ", ".join(top_skills) if top_skills else "(no skills assigned)"
    return (
        f"Build the persona profile for this employee. Identity fields are fixed —\n"
        f"only generate tenure_years, voice_traits, backstory, and pet_topics.\n\n"
        f"  name:       {person['name']}\n"
        f"  title:      {person['title']}\n"
        f"  team:       {team_name}\n"
        f"  top skills: {skills_line}\n\n"
        f"Constraints:\n"
        f"- tenure_years: realistic for the seniority of '{person['title']}'.\n"
        f"- voice_traits: 2-5 distinct adjectives or short phrases for how they communicate.\n"
        f"- backstory: 2-3 sentences, specific and plausible. No famous-person tropes.\n"
        f"- pet_topics: 1-5 things this person tends to bring up unprompted."
    )


def _top_skills_for(
    person_id: str,
    person_skills: list[dict],
    skill_by_id: dict[str, dict],
    limit: int = 4,
) -> list[str]:
    rows = [r for r in person_skills if r["person_id"] == person_id]
    rows.sort(key=lambda r: -float(r.get("weight") or 0))
    return [skill_by_id[r["skill_id"]]["name"] for r in rows[:limit] if r["skill_id"] in skill_by_id]


def generate_one(person: dict, team_name: str, top_skills: list[str]) -> Persona:
    key = cache.cache_key("persona-v1", person["id"], NOVA_PRO, sorted(top_skills))
    hit = cache.get("personas", key)
    if hit:
        return Persona.model_validate(hit)

    prompt = _build_prompt(person, team_name, top_skills)
    gen = converse_with_schema(
        PersonaGen,
        system=SYSTEM_PROMPT,
        user_prompt=prompt,
        model_id=NOVA_PRO,
        temperature=0.7,
        max_tokens=1024,
        tool_description="Emit the generated persona fields.",
    )

    persona = Persona(
        person_id=person["id"],
        name=person["name"],
        title=person["title"],
        team_id=person["team_id"],
        **gen.model_dump(),
    )
    cache.put("personas", key, persona.model_dump())
    return persona


def generate_all(snapshot_path: Path | None = None) -> list[Persona]:
    """Generate personas for every person in the seed graph.

    If `snapshot_path` is given, reads the graph from a JSON file instead of
    Aurora — useful when the cluster isn't deployed yet.
    """
    if snapshot_path:
        graph = json.loads(snapshot_path.read_text())
    else:
        graph = aurora.fetch_seed_graph()

    team_name_by_id = {t["id"]: t["name"] for t in graph["teams"]}
    skill_by_id = {s["id"]: s for s in graph["skills"]}
    people = graph["people"]
    person_skills = graph["person_skills"]

    personas: list[Persona] = []
    for i, person in enumerate(people, 1):
        team_name = team_name_by_id.get(person["team_id"], person["team_id"])
        top_skills = _top_skills_for(person["id"], person_skills, skill_by_id)
        try:
            personas.append(generate_one(person, team_name, top_skills))
        except Exception as e:
            log.error("persona %s failed: %s", person["id"], e)
            raise
        if i % 10 == 0:
            print(f"  {i}/{len(people)} personas generated", file=sys.stderr)

    # Materialize the combined file so doc generators can prepend it cheaply.
    PERSONAS_FILE.write_text(
        json.dumps([p.model_dump() for p in personas], indent=2)
    )
    print(f"Wrote {len(personas)} personas → {PERSONAS_FILE.relative_to(SYNTH_DIR.parent.parent)}", file=sys.stderr)
    return personas


def load_personas() -> list[Persona]:
    """Read the materialized personas.json — used by downstream doc generators."""
    if not PERSONAS_FILE.exists():
        raise FileNotFoundError(
            f"{PERSONAS_FILE} missing — run `python -m schema.synth personas` first."
        )
    return [Persona.model_validate(p) for p in json.loads(PERSONAS_FILE.read_text())]
