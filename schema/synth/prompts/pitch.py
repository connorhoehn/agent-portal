"""Prompt for editor pitches off a story cluster."""
from __future__ import annotations


SYSTEM = (
    "You write story pitches an assigning editor would send a reporter. Pitches "
    "are direct, name the angle, suggest sources to call, and define what 'done' "
    "looks like. Emit JSON via the `emit` tool."
)


def build_prompt(cluster_title: str, cluster_description: str, recent_headlines: list[str]) -> str:
    headline_block = "\n".join(f"  - {h}" for h in recent_headlines[:6])
    return f"""\
Write a story pitch off this cluster.

CLUSTER: {cluster_title}
SO FAR: {cluster_description}

RECENT COVERAGE:
{headline_block}

Required shape:
- angle:             the specific take this pitch is proposing (60+ chars).
- hook:              what makes it timely or fresh (40+ chars).
- target_outcome:    the form of the finished piece, e.g. '800-word feature', 'short news + sidebar'.
- suggested_sources: 1-6 sources to reach for (people, orgs, or 'analyst at <firm>').
- body_markdown:     the pitch as a short memo (200+ chars). Sections: Angle / Hook / Sources / Target.
"""
