"""Named-entity extraction over generated news articles.

Reads staged news_article docs, calls Nova-Lite with a 2-field schema for
reliability, and writes one NER-result JSON per article under cache/ner/.
"""
from __future__ import annotations

import logging
import re
import sys

from . import cache
from .bedrock import converse_with_schema
from .config import NOVA_LITE
from .generate import load_staged
from .prompts import ner as ner_prompts
from .schemas import NERResultGen

log = logging.getLogger(__name__)


def slugify(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "unknown"


def entity_id(name: str, entity_type: str) -> str:
    return f"ent-{entity_type[:3]}-{slugify(name)}"


def extract_one(article_id: str, headline: str, body: str) -> NERResultGen:
    key = cache.cache_key("ner-v1", article_id, NOVA_LITE)
    hit = cache.get("ner", key)
    if hit:
        return NERResultGen.model_validate(hit)
    result = converse_with_schema(
        NERResultGen,
        system=ner_prompts.SYSTEM,
        user_prompt=ner_prompts.build_prompt(headline, body),
        model_id=NOVA_LITE,
        temperature=0.2,
        max_tokens=2048,
    )
    cache.put("ner", key, result.model_dump())
    return result


def extract_all() -> dict[str, NERResultGen]:
    """Run NER over every staged news article. Returns {article_id: NERResult}."""
    docs = [d for d in load_staged() if d.source == "news_article"]
    out: dict[str, NERResultGen] = {}
    for i, d in enumerate(docs, 1):
        try:
            out[d.id] = extract_one(d.id, d.title, d.body_markdown)
        except Exception as e:
            log.error("NER failed for %s: %s", d.id, e)
            continue
        if i % 5 == 0:
            print(f"  NER: {i}/{len(docs)}", file=sys.stderr)
    print(f"NER complete: {len(out)} articles", file=sys.stderr)
    return out
