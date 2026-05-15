"""Prompt scaffolding for incident postmortems."""
from __future__ import annotations


SYSTEM = (
    "You write blameless incident postmortems for OrgIQ. Postmortems are honest, "
    "name-people-by-name, and focus on systems and signals — not finger-pointing. "
    "Timelines are precise. Action items are concrete and have owners.\n\n"
    "Prose style:\n"
    "- Refer to people by full name (e.g. 'Alice Chen'), never by id.\n"
    "- Refer to projects, teams, skills by their human names.\n"
    "- IDs belong ONLY in the structured `mentions` array.\n\n"
    "Emit JSON via the `emit` tool. Populate `mentions` with every person, team, "
    "project, or skill referenced in body_markdown, using IDs from CAST/CATALOG."
)


def build_prompt(
    project: dict,
    incident_title: str,
    incident_date: str,
    cast_personas: list[dict],
    catalog: dict,
) -> str:
    cast_lines = "\n".join(
        f"  - {p['person_id']} | {p['name']} ({p['title']}, team={p['team_id']}) "
        f"| voice: {', '.join(p.get('voice_traits', []))}"
        for p in cast_personas
    ) or "  (no cast)"

    catalog_block = (
        "  teams:    " + ", ".join(f"{t['id']}={t['name']}" for t in catalog["teams"]) + "\n"
        "  projects: " + ", ".join(f"{p['id']}={p['name']}" for p in catalog["projects"]) + "\n"
        "  skills:   " + ", ".join(f"{s['id']}={s['name']}" for s in catalog["skills"][:40])
    )

    return f"""\
Write the postmortem for this incident.

INCIDENT
  project:        {project['id']} ({project['name']})
  title:          {incident_title}
  date:           {incident_date}

CAST (only reference people from this list):
{cast_lines}

CATALOG (only reference these IDs in `mentions`):
{catalog_block}

Required shape:
- severity:      sev1 | sev2 | sev3 — pick what fits the incident.
- summary:       3-5 sentences. What happened and impact.
- timeline:      3-12 entries like 'HH:MM — alert fires on X' or 'HH:MM — Alice deploys hotfix'.
- root_cause:    2-4 sentences. Specific. Mention the system or signal that failed.
- action_items:  2-8 concrete follow-ups. Owners by name where appropriate.
- body_markdown: full postmortem. Sections: # Summary / # Impact / # Timeline / # Root Cause / # Action Items / # Participants. 500+ chars.
- mentions:      every person, team, project, skill named in body_markdown.
"""
