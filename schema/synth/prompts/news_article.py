"""Prompt scaffolding for fictional industry news articles ABOUT OrgIQ.

These populate the newsroom corpus. Entity extraction happens in a separate
Nova-Lite NER pass — this prompt does not request a `mentions` field.
"""
from __future__ import annotations


SYSTEM = (
    "You are a tech-industry reporter writing short news articles about a fictional "
    "company called OrgIQ for an outsider audience. Articles are journalistic, not "
    "promotional — they cite analysts, mention competitors by plausible fictional name, "
    "and include a critical quote or counterpoint when appropriate.\n\n"
    "Emit JSON via the `emit` tool. Articles are 600-1200 chars in body_markdown."
)


def build_prompt(
    angle: str,
    related_decision: dict | None,
    related_project: dict | None,
    catalog: dict,
) -> str:
    catalog_block = (
        "  teams:    " + ", ".join(t["name"] for t in catalog["teams"]) + "\n"
        "  projects: " + ", ".join(p["name"] for p in catalog["projects"])
    )

    context_lines = []
    if related_decision:
        context_lines.append(f"recent decision: {related_decision['title']} — {related_decision.get('summary', '')}")
    if related_project:
        context_lines.append(f"related project: {related_project['name']} (status={related_project.get('status', '?')})")
    context_block = "\n".join(f"  - {l}" for l in context_lines) or "  (no specific anchor)"

    return f"""\
Write a fictional industry-news article about OrgIQ.

ANGLE: {angle}

ANCHOR CONTEXT:
{context_block}

ORGIQ's REAL ORG (use names from here in the article — feel free to invent
employee names where useful, but stay plausible):
{catalog_block}

Required shape:
- headline:      one punchy line.
- byline:        fictional reporter name (e.g. 'Dana Wexford').
- lede:          opening paragraph, 80+ chars.
- body_markdown: full article in markdown. 600+ chars. Includes at least one quote
                 (real or attributed to a fictional analyst). No subheadings needed.
- topic_tags:    1-6 short tags like 'AI infrastructure', 'enterprise SaaS'.
"""
