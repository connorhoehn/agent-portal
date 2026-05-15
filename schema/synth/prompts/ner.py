"""Prompt for the Nova-Lite NER pass over a news article body."""
from __future__ import annotations


SYSTEM = (
    "You extract named entities from short news articles. For each entity you "
    "find, emit a single name and one of four types: person, organization, "
    "location, topic. Skip common nouns, generic descriptors, and the article "
    "byline. Cap output at 20 entities — pick the most salient if there are more. "
    "Emit JSON via the `emit` tool."
)


def build_prompt(headline: str, body: str) -> str:
    return f"""\
Extract named entities from this article.

HEADLINE: {headline}

BODY:
{body}

Required shape:
- entities: list of {{name, entity_type}}.
  - entity_type: one of person | organization | location | topic.
  - name: the surface form as it appears in the text (singular, title-cased where appropriate).
  - Skip pronouns, generic terms ('the company', 'a startup'), and the reporter's byline.
"""
