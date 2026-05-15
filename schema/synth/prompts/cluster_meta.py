"""Prompt for summarizing a cluster of related articles."""
from __future__ import annotations


SYSTEM = (
    "You are a newsroom editor naming and describing a running story — a cluster "
    "of related articles. Be concise. Don't editorialize. Emit JSON via the `emit` tool."
)


def build_prompt(headlines: list[str], shared_tags: list[str]) -> str:
    tag_line = ", ".join(shared_tags) if shared_tags else "(no shared tags)"
    headline_block = "\n".join(f"  - {h}" for h in headlines)
    return f"""\
Summarize this cluster of related news articles.

CLUSTER HEADLINES:
{headline_block}

SHARED TAGS: {tag_line}

Required shape:
- title:         one short headline-style line that names the running story.
- description:   2-3 sentences. What is this story about, what's the through-line.
- primary_beat:  the editorial beat, e.g. 'AI infrastructure', 'enterprise', 'funding'.
"""
