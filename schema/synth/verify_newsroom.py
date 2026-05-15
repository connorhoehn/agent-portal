"""Offline smoke test for the newsroom pipeline: NER → cluster → pitch.

Generates 4 news articles (overwriting any from prior tests), runs NER on each,
clusters them, generates one pitch per cluster.

SPENDS REAL BEDROCK $ (~$0.05 per run). Run sparingly.

Run: .venv-synth/bin/python -m schema.synth.verify_newsroom
"""
from __future__ import annotations

import sys

from . import cluster as cluster_mod, generate, ner, pitches as pitches_mod
from .verify_docs import GRAPH, PERSONAS


def main():
    personas_by_pid = {pid: p.model_dump() for pid, p in PERSONAS.items()}

    # 1. Generate 4 news articles (forces a small spread of topics).
    print("=== Phase 1: news articles ===", file=sys.stderr)
    tasks = generate.plan_news_articles(GRAPH, personas_by_pid)[:4]
    generate.run_tasks(tasks, GRAPH)

    # 2. NER over each staged article.
    print("\n=== Phase 2: NER ===", file=sys.stderr)
    ner_results = ner.extract_all()
    for aid, res in ner_results.items():
        print(f"  {aid}: {len(res.entities)} entities — sample: "
              + ", ".join(f"{e.entity_type[:3]}:{e.name}" for e in res.entities[:5]))

    # 3. Cluster.
    print("\n=== Phase 3: cluster ===", file=sys.stderr)
    clusters = cluster_mod.cluster_articles(threshold=0.55)
    for c in clusters:
        print(f"  {c.id} ({len(c.article_ids)} articles): {c.meta.title}")
        print(f"     beat: {c.meta.primary_beat}")
        print(f"     desc: {c.meta.description[:160]}")

    # 4. Pitches (one per cluster).
    print("\n=== Phase 4: pitches ===", file=sys.stderr)
    pitches = pitches_mod.generate_pitches(clusters)
    for p in pitches:
        print(f"  pitch cluster={p.cluster_id}: {p.angle[:80]}")
        print(f"    hook: {p.hook[:120]}")
        print(f"    sources: {p.suggested_sources}")


if __name__ == "__main__":
    main()
