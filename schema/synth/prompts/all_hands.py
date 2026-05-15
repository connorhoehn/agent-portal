"""Prompt scaffolding for monthly all-hands recaps.

Broad multi-person, multi-project mentions — useful for PageRank ammunition
since these legitimately reference many entities at once.
"""
from __future__ import annotations


SYSTEM = (
    "You write monthly all-hands recaps for OrgIQ. Recaps are upbeat but honest, "
    "mention many people by name across multiple teams, and surface the quarter's "
    "real projects and decisions.\n\n"
    "Prose style:\n"
    "- Refer to people by full name, teams by their human names.\n"
    "- IDs belong ONLY in the structured `mentions` array.\n\n"
    "Emit JSON via the `emit` tool."
)


def build_prompt(
    date: str,
    quarter: str,
    highlighted_projects: list[dict],
    highlighted_people: list[dict],
    recent_decisions: list[dict],
    catalog: dict,
) -> str:
    proj_lines = "\n".join(f"  - {p['id']} | {p['name']} (status={p.get('status', '?')})" for p in highlighted_projects)
    people_lines = "\n".join(
        f"  - {p['person_id']} | {p['name']} ({p['title']}, team={p['team_id']})"
        for p in highlighted_people
    )
    decision_lines = "\n".join(
        f"  - {d['id']} | {d['title']}" for d in recent_decisions
    ) or "  (none in window)"

    catalog_block = (
        "  teams:    " + ", ".join(f"{t['id']}={t['name']}" for t in catalog["teams"]) + "\n"
        "  projects: " + ", ".join(f"{p['id']}={p['name']}" for p in catalog["projects"])
    )

    return f"""\
Write a monthly all-hands recap.

DATE: {date}
QUARTER: {quarter}

HIGHLIGHTED PROJECTS (each MUST get a section call-out):
{proj_lines}

HIGHLIGHTED PEOPLE (each MUST be named in at least one section):
{people_lines}

RECENT DECISIONS to nod at:
{decision_lines}

CATALOG (IDs allowed in `mentions`):
{catalog_block}

Required shape:
- headline:        one upbeat line summarizing the month.
- sections:        3-8 short topical recaps (2-4 sentences each), each mentioning people/projects by name.
- body_markdown:   full recap. Sections like # Headline / ## Engineering / ## Product / ## People moves / ## What's next. 500+ chars.
- mentions:        every person, team, project, decision, skill named in body_markdown.
"""
