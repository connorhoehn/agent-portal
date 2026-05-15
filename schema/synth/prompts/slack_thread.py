"""Prompt scaffolding for Slack threads.

Lightweight, conversational, multi-author. Generated with Nova-Lite for cost.
Drives co-mention signal between teammates.
"""
from __future__ import annotations


SYSTEM = (
    "You write Slack threads from a fictional company called OrgIQ. Threads sound real — "
    "people interrupt each other, type quickly, use lowercase, occasionally include code "
    "snippets in backticks or @-mention each other (by first name only in prose).\n\n"
    "STRICT prose rules — these are non-negotiable, the threads look fake if violated:\n"
    "- Refer to teammates by FIRST NAME only (e.g. 'alice', 'priya').\n"
    "- Refer to projects, teams, skills by HUMAN NAMES ('RAG Search', 'Kubernetes'),\n"
    "  NEVER by slug or id. Slugs like 'p-rag-search', 'sk-aurora', 't-platform' must\n"
    "  NEVER appear in body_markdown.\n"
    "- Slugs and IDs go ONLY into the `mentions` array.\n\n"
    "Emit JSON via the `emit` tool."
)


def build_prompt(
    channel: str,
    project: dict | None,
    team: dict | None,
    topic: str,
    cast_personas: list[dict],
    catalog: dict,
) -> str:
    cast_lines = "\n".join(
        f"  - {p['person_id']} | {p['name'].split()[0]} ({p['name']}, {p['title']}) "
        f"| voice: {', '.join(p.get('voice_traits', []))}"
        for p in cast_personas
    ) or "  (no cast)"

    catalog_block = (
        "  teams:    " + ", ".join(f"{t['id']}={t['name']}" for t in catalog["teams"]) + "\n"
        "  projects: " + ", ".join(f"{p['id']}={p['name']}" for p in catalog["projects"])
    )

    context_line = (
        f"project: {project['id']} ({project['name']})" if project
        else f"team: {team['id']} ({team['name']})" if team
        else "general"
    )

    return f"""\
Write a Slack thread.

CHANNEL: {channel}
CONTEXT: {context_line}
TOPIC: {topic}

CAST (only these people speak; message.author_id MUST be one of these):
{cast_lines}

CATALOG (IDs allowed in `mentions`):
{catalog_block}

Required shape:
- body_markdown: 4-20 messages, one per line block. Format each line as:
                   **<firstname>** [HH:MM] <message text>
                 Only use first names from the CAST. Casual register, lowercase OK,
                 authors should respond to each other naturally — not sequential monologues.
                 Aim for 6-12 turns and 200+ chars total.
                 Slugs (e.g. 'p-rag-search', 'sk-aurora', 't-platform') MUST NOT appear
                 in message text — use the human names from CATALOG.
- mentions:      every person (by id, from CAST), team, project, skill referenced
                 in the thread. The participants in the thread MUST appear here.
"""
