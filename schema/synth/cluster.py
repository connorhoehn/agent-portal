"""Cluster news articles by embedding similarity.

Pipeline:
1. Embed each article body with Titan-v2 (1024d, normalized).
2. Build a cosine-similarity adjacency over articles >= threshold.
3. Union-find → connected components = story_clusters.
4. Nova-Lite generates a title/description/primary_beat per cluster.

No sklearn dependency — agglomerative clustering at this scale (50 articles) is
a handful of numpy operations.
"""
from __future__ import annotations

import logging
import sys
from dataclasses import dataclass, field

import numpy as np

from . import cache
from .bedrock import converse_with_schema, embed_text
from .config import NOVA_LITE
from .generate import load_staged
from .load import LoadableDoc
from .prompts import cluster_meta as cluster_prompts
from .schemas import ClusterMeta, ClusterMetaGen

log = logging.getLogger(__name__)

SIMILARITY_THRESHOLD = 0.55  # cosine on Titan-v2 normalized embeddings


@dataclass
class Cluster:
    id: str
    article_ids: list[str]
    meta: ClusterMeta | None = None
    headlines: list[str] = field(default_factory=list)
    shared_tags: list[str] = field(default_factory=list)


def _embed_articles(docs: list[LoadableDoc]) -> np.ndarray:
    """Returns an (N, 1024) array of L2-normalized embeddings, one per article."""
    vecs = []
    for i, d in enumerate(docs, 1):
        key = cache.cache_key("embed-v1", d.id, len(d.body_markdown))
        hit = cache.get("embeddings", key)
        if hit:
            vecs.append(np.array(hit["embedding"], dtype=np.float32))
        else:
            v = np.array(embed_text(d.body_markdown), dtype=np.float32)
            cache.put("embeddings", key, {"embedding": v.tolist()})
            vecs.append(v)
        if i % 10 == 0:
            print(f"  embed: {i}/{len(docs)}", file=sys.stderr)
    return np.stack(vecs)


def _union_find_clusters(sim: np.ndarray, threshold: float) -> list[list[int]]:
    n = sim.shape[0]
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for i in range(n):
        for j in range(i + 1, n):
            if sim[i, j] >= threshold:
                union(i, j)

    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    # Sort: bigger clusters first, then lexicographically.
    return sorted(groups.values(), key=lambda g: (-len(g), g[0]))


def _meta_for_cluster(cluster: Cluster) -> ClusterMeta:
    key = cache.cache_key("cluster-meta-v1", cluster.id, NOVA_LITE)
    hit = cache.get("clusters", key)
    if hit:
        return ClusterMeta.model_validate(hit)
    gen = converse_with_schema(
        ClusterMetaGen,
        system=cluster_prompts.SYSTEM,
        user_prompt=cluster_prompts.build_prompt(cluster.headlines, cluster.shared_tags),
        model_id=NOVA_LITE,
        temperature=0.3,
        max_tokens=512,
    )
    # Derive title from the first headline since Nova-Lite reliably elides it.
    title = cluster.headlines[0] if cluster.headlines else f"Cluster {cluster.id}"
    meta = ClusterMeta(title=title, **gen.model_dump())
    cache.put("clusters", key, meta.model_dump())
    return meta


def cluster_articles(threshold: float = SIMILARITY_THRESHOLD) -> list[Cluster]:
    docs = [d for d in load_staged() if d.source == "news_article"]
    if not docs:
        log.warning("no staged news_article docs — generate news first")
        return []

    print(f"Embedding {len(docs)} articles...", file=sys.stderr)
    emb = _embed_articles(docs)
    sim = emb @ emb.T  # cosine since vectors are L2-normalized
    groups = _union_find_clusters(sim, threshold)

    clusters: list[Cluster] = []
    for idx, member_ixs in enumerate(groups):
        cid = f"sc-{idx:03d}"
        articles = [docs[i] for i in member_ixs]
        cluster = Cluster(
            id=cid,
            article_ids=[d.id for d in articles],
            headlines=[d.title for d in articles],
            # tag set is the union — but LoadableDoc doesn't carry tags; read from cache.
            shared_tags=[],
        )
        cluster.meta = _meta_for_cluster(cluster)
        clusters.append(cluster)
        print(
            f"  cluster {cid}: {len(member_ixs)} article(s)  →  {cluster.meta.title[:60]}",
            file=sys.stderr,
        )
    return clusters
