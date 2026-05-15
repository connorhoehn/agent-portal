"""Prompt scaffolding for Architecture Decision Records."""
from __future__ import annotations


SYSTEM = (
    "You write Architecture Decision Records (ADRs) for OrgIQ, a realistic mid-sized "
    "tech company. ADRs are written in a measured, slightly skeptical voice — they "
    "name the options that were rejected and why, not just the winner.\n\n"
    "Prose style:\n"
    "- Refer to people by their full name (e.g. 'Alice Chen'), not their ID.\n"
    "- Refer to skills, teams, projects by their human name, not their slug.\n"
    "- IDs belong ONLY in the structured `mentions` array, never in prose.\n\n"
    "Emit JSON via the `emit` tool. Populate `mentions` with every person, team, "
    "project, or skill referenced in body_markdown, using the IDs from CAST/CATALOG."
)


def build_prompt(
    decision: dict,
    participants: list[dict],
    cast_personas: list[dict],
    catalog: dict,
) -> str:
    """
    decision:      {id, title, summary, decided_at}
    participants:  decision_participants rows joined to people
    cast_personas: full persona dicts for participants (voice, traits, backstory)
    catalog:       {teams: [...], projects: [...], skills: [...]} — slim references
    """
    cast_lines = []
    for pp in cast_personas:
        traits = ", ".join(pp.get("voice_traits", []))
        cast_lines.append(
            f"  - {pp['person_id']} | {pp['name']} ({pp['title']}, team={pp['team_id']}) "
            f"| voice: {traits} | pet topics: {', '.join(pp.get('pet_topics', []))}"
        )
    cast_block = "\n".join(cast_lines) if cast_lines else "  (no participants)"

    catalog_block = (
        "  teams:    " + ", ".join(f"{t['id']}={t['name']}" for t in catalog["teams"]) + "\n"
        "  projects: " + ", ".join(f"{p['id']}={p['name']}" for p in catalog["projects"]) + "\n"
        "  skills:   " + ", ".join(f"{s['id']}={s['name']}" for s in catalog["skills"][:40])
    )

    stance_lines = [
        f"  - {p['person_id']} ({p['name']}): stance={p.get('stance', 'unknown')}"
        for p in participants
    ]
    stance_block = "\n".join(stance_lines) if stance_lines else "  (no stances recorded)"

    return f"""\
Write the ADR for this decision.

DECISION
  id:         {decision['id']}
  title:      {decision['title']}
  decided_at: {decision.get('decided_at')}
  summary:    {decision.get('summary') or '(no summary)'}

PARTICIPANTS (with their recorded stances — reflect these in the body):
{stance_block}

CAST (only reference people from this list):
{cast_block}

CATALOG (only reference these entity IDs in `mentions`):
{catalog_block}

Required shape (the `emit` tool enforces it):
- status:       one of proposed | accepted | superseded | rejected.
- context:      2-4 paragraphs explaining the situation that forced the decision.
- options:      2-5 alternatives that were considered, INCLUDING the chosen one.
- decision:     the chosen path, in 2-4 sentences.
- consequences: 2-6 bullet-style strings, mixing positive and negative consequences.
- body_markdown: the full ADR as markdown, with sections # Context / # Options / # Decision / # Consequences / # Participants. Mention people by NAME. 400+ chars.
- mentions:     every person, team, project, or skill named in body_markdown, using IDs from CAST/CATALOG.
"""
