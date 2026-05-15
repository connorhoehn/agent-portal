"""Prompt scaffolding for performance review snippets.

These are the highest-signal doc type for the scoring agent — they tie a person
explicitly to specific skills and project contributions, which becomes the
mention-density signal that drives expertise ranking.
"""
from __future__ import annotations


SYSTEM = (
    "You write performance review snippets at OrgIQ — short, specific, evidence-based. "
    "Reviews call out concrete skill demonstrations and project contributions. "
    "Voice is warm but unsentimental.\n\n"
    "Prose style:\n"
    "- Refer to the subject and any collaborators by full name.\n"
    "- Refer to projects and skills by their human names.\n"
    "- IDs belong ONLY in the structured `mentions` array.\n\n"
    "Emit JSON via the `emit` tool. Populate `mentions` with every person, team, "
    "project, or skill referenced in body_markdown, using IDs from CAST/CATALOG."
)


def build_prompt(
    subject_persona: dict,
    review_period: str,
    subject_skills: list[dict],
    subject_projects: list[dict],
    catalog: dict,
) -> str:
    skills_block = "\n".join(
        f"  - {s['id']} | {s['name']} (weight={s.get('weight', '?')})"
        for s in subject_skills
    ) or "  (none)"
    proj_block = "\n".join(
        f"  - {p['id']} | {p['name']} (role={p.get('role', '?')})"
        for p in subject_projects
    ) or "  (none)"

    catalog_block = (
        "  teams:    " + ", ".join(f"{t['id']}={t['name']}" for t in catalog["teams"]) + "\n"
        "  projects: " + ", ".join(f"{p['id']}={p['name']}" for p in catalog["projects"]) + "\n"
        "  skills:   " + ", ".join(f"{s['id']}={s['name']}" for s in catalog["skills"][:40])
    )

    return f"""\
Write a performance review snippet for this person, covering {review_period}.

SUBJECT
  id:       {subject_persona['person_id']}
  name:     {subject_persona['name']}
  title:    {subject_persona['title']}
  team:     {subject_persona['team_id']}
  voice:    {', '.join(subject_persona.get('voice_traits', []))}
  pet topics: {', '.join(subject_persona.get('pet_topics', []))}

DEMONSTRATED SKILLS (use ONLY these as skill_demonstrations — these are real):
{skills_block}

CONTRIBUTING PROJECTS (use ONLY these as project_callouts — real assignments):
{proj_block}

CATALOG (IDs you may reference in `mentions`):
{catalog_block}

Required shape:
- strengths:            2-5 short strings, evidence-backed.
- growth_areas:         1-4 honest, non-generic developmental notes.
- project_callouts:     1-5 entries — each ties the SUBJECT to one of their listed projects with specifics.
- skill_demonstrations: 2-6 entries — each ties the SUBJECT to one of their listed skills with a concrete example.
- body_markdown:        full review. Sections: # Summary / # Strengths / # Growth Areas / # Notable Contributions. 400+ chars.
- mentions:             the subject (mandatory), plus any other people/teams/projects/skills named in body_markdown.
"""
