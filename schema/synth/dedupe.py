"""Embedding-based near-dup detection over the staged corpus.

After generation, embed every body with Titan-v2 and drop any doc whose cosine
similarity to an earlier kept doc exceeds `config.dup_cosine_threshold`. Dropped
JSONs are moved to staged/_duplicates/ rather than deleted so they're inspectable.

Embeddings are cached by (doc_id, body_length) — re-runs are free once stable.
"""
from __future__ import annotations

import logging
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from . import cache
from .bedrock import embed_text
from .config import CONFIG
from .generate import STAGE_DIR, load_staged

log = logging.getLogger(__name__)

DUPLICATES_DIR = STAGE_DIR / "_duplicates"


@dataclass
class DedupeReport:
    kept: list[str]
    dropped: list[tuple[str, str, float]]   # (dropped_id, near_id, similarity)


def _vec(doc) -> np.ndarray:
    key = cache.cache_key("dedupe-embed-v1", doc.id, len(doc.body_markdown))
    hit = cache.get("embeddings_dedupe", key)
    if hit:
        return np.array(hit["embedding"], dtype=np.float32)
    v = np.array(embed_text(doc.body_markdown), dtype=np.float32)
    cache.put("embeddings_dedupe", key, {"embedding": v.tolist()})
    return v


def dedupe_staged(threshold: float | None = None) -> DedupeReport:
    """Walk staged docs in stable order; keep the first, drop later near-dupes."""
    threshold = threshold if threshold is not None else CONFIG.dup_cosine_threshold
    docs = load_staged()
    if not docs:
        return DedupeReport(kept=[], dropped=[])

    DUPLICATES_DIR.mkdir(exist_ok=True)
    print(f"Embedding {len(docs)} staged docs for dedupe...", file=sys.stderr)
    vectors: list[tuple[str, np.ndarray, object]] = []  # (doc_id, vec, doc)
    for i, d in enumerate(docs, 1):
        vectors.append((d.id, _vec(d), d))
        if i % 25 == 0:
            print(f"  embed: {i}/{len(docs)}", file=sys.stderr)

    kept: list[tuple[str, np.ndarray]] = []
    dropped: list[tuple[str, str, float]] = []
    for did, vec, doc in vectors:
        best_sim = 0.0
        best_id = None
        for kid, kvec in kept:
            sim = float(vec @ kvec)
            if sim > best_sim:
                best_sim, best_id = sim, kid
        if best_id is not None and best_sim >= threshold:
            dropped.append((did, best_id, best_sim))
            # Move the staged JSON aside so it's recoverable.
            src = STAGE_DIR / f"{did}.json"
            if src.exists():
                shutil.move(str(src), DUPLICATES_DIR / f"{did}.json")
        else:
            kept.append((did, vec))

    print(f"Dedupe: kept {len(kept)}, dropped {len(dropped)} (threshold={threshold:.2f})", file=sys.stderr)
    for did, near_id, sim in dropped:
        log.info("  dropped %s (sim=%.3f to %s)", did, sim, near_id)

    return DedupeReport(kept=[k[0] for k in kept], dropped=dropped)
