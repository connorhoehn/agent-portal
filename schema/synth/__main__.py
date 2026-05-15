"""CLI dispatcher for the synth pipeline.

Subcommands are wired in as their modules land. Step 1 ships scaffolding only —
the `check` subcommand is a smoke test that verifies Aurora connectivity and
seed-graph presence without calling Bedrock.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path


def cmd_check(_args) -> int:
    from . import aurora
    print("Checking Aurora connectivity and seed graph...")
    graph = aurora.fetch_seed_graph()
    counts = {k: len(v) for k, v in graph.items()}
    print(f"  people:               {counts['people']:>4}")
    print(f"  teams:                {counts['teams']:>4}")
    print(f"  skills:               {counts['skills']:>4}")
    print(f"  projects:             {counts['projects']:>4}")
    print(f"  decisions:            {counts['decisions']:>4}")
    print(f"  decision_participants:{counts['decision_participants']:>4}")
    print(f"  person_skills:        {counts['person_skills']:>4}")
    print(f"  project_contributions:{counts['project_contributions']:>4}")
    if counts["people"] == 0:
        print("  ⚠️  seed graph empty — run `python3 schema/seed.py` first.", file=sys.stderr)
        return 1
    return 0


def cmd_snapshot(args) -> int:
    """Dump the Aurora seed graph to a local JSON file (lets us run personas/docs offline)."""
    from . import aurora
    out = Path(args.out)
    import json
    graph = aurora.fetch_seed_graph()
    out.write_text(json.dumps(graph, indent=2, default=str))
    counts = {k: len(v) for k, v in graph.items()}
    print(f"Wrote snapshot → {out} ({counts})")
    return 0


def cmd_personas(args) -> int:
    from . import personas
    snap = Path(args.snapshot) if args.snapshot else None
    personas.generate_all(snapshot_path=snap)
    return 0


def _load_graph(snapshot: str | None) -> dict:
    import json
    if snapshot:
        return json.loads(Path(snapshot).read_text())
    from . import aurora
    return aurora.fetch_seed_graph()


DOC_TYPES = ["adr", "postmortem", "perf_review", "slack_thread", "all_hands", "news_article"]


def cmd_docs(args) -> int:
    from . import generate, personas
    graph = _load_graph(args.snapshot)
    personas_list = personas.load_personas()
    personas_by_pid = {p.person_id: p.model_dump() for p in personas_list}
    selected = DOC_TYPES if args.type == "all" else [args.type]
    planners = {
        "adr":          generate.plan_adrs,
        "postmortem":   generate.plan_postmortems,
        "perf_review":  generate.plan_perf_reviews,
        "slack_thread": generate.plan_slack_threads,
        "all_hands":    generate.plan_all_hands,
        "news_article": generate.plan_news_articles,
    }
    tasks: list = []
    for t in selected:
        tasks += planners[t](graph, personas_by_pid)
    if not tasks:
        print(f"No tasks for type {args.type!r}", file=sys.stderr)
        return 1
    print(f"Generating {len(tasks)} docs...", file=sys.stderr)
    generate.run_tasks(tasks, graph)
    return 0


def cmd_stats(_args) -> int:
    """Print a snapshot of the staged corpus + cache state."""
    import json
    from collections import Counter
    from .config import CACHE_DIR, SYNTH_DIR
    from .generate import STAGE_DIR, load_staged

    print("schema/synth/ state:\n")

    # Staged docs.
    docs = load_staged()
    by_source = Counter(d.source for d in docs)
    print(f"  staged docs: {len(docs)}")
    for src, n in sorted(by_source.items(), key=lambda x: -x[1]):
        print(f"    {src:<14} {n:>4}")
    dupes_dir = STAGE_DIR / "_duplicates"
    if dupes_dir.exists():
        n_dupes = len(list(dupes_dir.glob("*.json")))
        if n_dupes:
            print(f"    (_duplicates)  {n_dupes:>4}")
    print()

    # Cache subdirs.
    print("  cache:")
    if CACHE_DIR.exists():
        for sub in sorted(CACHE_DIR.iterdir()):
            if sub.is_dir():
                n = sum(1 for _ in sub.rglob("*.json"))
                print(f"    {sub.name:<22} {n:>4}")
    print()

    # Side files.
    print("  side files:")
    for name in ["personas.json", "clusters.json", "pitches.json", "seed-graph.json"]:
        p = SYNTH_DIR / name
        if p.exists():
            try:
                obj = json.loads(p.read_text())
                size = len(obj) if isinstance(obj, list) else "ok"
                print(f"    {name:<22} {size}")
            except Exception:
                print(f"    {name:<22} (unreadable)")
        else:
            print(f"    {name:<22} (missing)")
    return 0


def cmd_clean(args) -> int:
    import shutil
    from .config import CACHE_DIR, SYNTH_DIR
    from .generate import STAGE_DIR

    targets = [CACHE_DIR, STAGE_DIR]
    side_files = [SYNTH_DIR / n for n in ("personas.json", "clusters.json", "pitches.json", "seed-graph.json")]

    print("This will remove:")
    for t in targets:
        if t.exists():
            print(f"  {t.relative_to(SYNTH_DIR.parent.parent)}/")
    for f in side_files:
        if f.exists():
            print(f"  {f.relative_to(SYNTH_DIR.parent.parent)}")

    if not args.force:
        print("\nRun with --force to actually delete.", file=sys.stderr)
        return 1

    for t in targets:
        if t.exists():
            shutil.rmtree(t)
    for f in side_files:
        if f.exists():
            f.unlink()
    print("Cleaned.")
    return 0


def cmd_dedupe(args) -> int:
    from . import dedupe
    report = dedupe.dedupe_staged(threshold=args.threshold)
    print(f"kept {len(report.kept)}, dropped {len(report.dropped)}", file=sys.stderr)
    return 0


def cmd_ner(_args) -> int:
    from . import ner
    results = ner.extract_all()
    print(f"NER produced {len(results)} article results", file=sys.stderr)
    return 0


def cmd_cluster(args) -> int:
    from . import cluster as cluster_mod
    clusters = cluster_mod.cluster_articles(threshold=args.threshold)
    print(f"Built {len(clusters)} cluster(s)", file=sys.stderr)
    # Persist a summary so `load` and `pitches` can rerun without re-embedding.
    import json
    from .config import SYNTH_DIR
    out = SYNTH_DIR / "clusters.json"
    out.write_text(json.dumps([
        {
            "id": c.id,
            "article_ids": c.article_ids,
            "title": c.meta.title if c.meta else "",
            "description": c.meta.description if c.meta else "",
            "primary_beat": c.meta.primary_beat if c.meta else "",
            "headlines": c.headlines,
        } for c in clusters
    ], indent=2))
    return 0


def cmd_pitches(_args) -> int:
    import json
    from .config import SYNTH_DIR
    from . import cluster as cluster_mod, pitches as pitch_mod
    cl_file = SYNTH_DIR / "clusters.json"
    if not cl_file.exists():
        print("clusters.json missing — run `cluster` first.", file=sys.stderr)
        return 1
    raw = json.loads(cl_file.read_text())
    # Reconstruct Cluster objects with meta.
    from .schemas import ClusterMeta
    clusters = [
        cluster_mod.Cluster(
            id=r["id"],
            article_ids=r["article_ids"],
            headlines=r["headlines"],
            meta=ClusterMeta(title=r["title"], description=r["description"], primary_beat=r["primary_beat"]),
        )
        for r in raw
    ]
    pitches = pitch_mod.generate_pitches(clusters)
    print(f"Generated {len(pitches)} pitches", file=sys.stderr)
    # Stash pitches alongside clusters for the load step.
    out = SYNTH_DIR / "pitches.json"
    out.write_text(json.dumps([p.model_dump() for p in pitches], indent=2))
    return 0


def cmd_embed(args) -> int:
    from . import embed
    graph = _load_graph(args.snapshot)
    rows = embed.embed_all_nodes(graph)
    print(f"Embedded {len(rows)} nodes (cached)", file=sys.stderr)
    return 0


def cmd_load(args) -> int:
    import json
    from . import generate, load, ner as ner_mod, embed
    from .config import SYNTH_DIR

    docs = generate.load_staged()
    if not docs:
        print("No staged docs found — run `docs` first.", file=sys.stderr)
        return 1

    # 1. Documents + mentions + S3.
    for d in docs:
        load.load_one(d)

    # 2. Newsroom: article_entities, story_clusters, pitches.
    news_doc_ids = {d.id for d in docs if d.source == "news_article"}
    if news_doc_ids:
        # NER results from cache (re-extract any missing).
        ner_results = ner_mod.extract_all()
        entities_by_id: dict[str, dict] = {}
        article_entity_rows: list[dict] = []
        for article_id, res in ner_results.items():
            for ent in res.entities:
                eid = ner_mod.entity_id(ent.name, ent.entity_type)
                entities_by_id[eid] = {"id": eid, "name": ent.name, "entity_type": ent.entity_type}
                article_entity_rows.append({"article_id": article_id, "entity_id": eid, "salience": 1.0})
        load.upsert_entities(list(entities_by_id.values()))
        load.upsert_article_entities(article_entity_rows)

        cl_file = SYNTH_DIR / "clusters.json"
        if cl_file.exists():
            clusters_raw = json.loads(cl_file.read_text())
            load.upsert_clusters(clusters_raw)

        pitches_file = SYNTH_DIR / "pitches.json"
        if pitches_file.exists():
            raw = json.loads(pitches_file.read_text())
            load.upsert_pitches([
                {
                    "id": f"pitch-{p['cluster_id']}",
                    "title": p["angle"][:200],
                    "body": p["body_markdown"],
                    "beat": p.get("target_outcome", ""),
                    "cluster_id": p["cluster_id"],
                } for p in raw
            ])

    # 3. Node embeddings.
    graph = _load_graph(args.snapshot)
    node_rows = embed.embed_all_nodes(graph)
    load.upsert_node_embeddings(node_rows)

    # 4. KB ingestion job.
    if not args.skip_kb_sync:
        load.trigger_kb_sync()

    print(f"Loaded {len(docs)} docs, {len(node_rows)} node embeddings.", file=sys.stderr)
    return 0


def cmd_all(args) -> int:
    """Run the full pipeline: personas → docs → ner → cluster → pitches → embed → load."""
    from types import SimpleNamespace
    snap = args.snapshot
    print("[1/7] personas", file=sys.stderr)
    if cmd_personas(SimpleNamespace(snapshot=snap)) != 0:
        return 1
    print("[2/8] docs", file=sys.stderr)
    if cmd_docs(SimpleNamespace(type="all", snapshot=snap)) != 0:
        return 1
    print("[3/8] dedupe", file=sys.stderr)
    if cmd_dedupe(SimpleNamespace(threshold=None)) != 0:
        return 1
    print("[4/8] ner", file=sys.stderr)
    if cmd_ner(SimpleNamespace()) != 0:
        return 1
    print("[5/8] cluster", file=sys.stderr)
    if cmd_cluster(SimpleNamespace(threshold=0.55)) != 0:
        return 1
    print("[6/8] pitches", file=sys.stderr)
    if cmd_pitches(SimpleNamespace()) != 0:
        return 1
    print("[7/8] embed", file=sys.stderr)
    if cmd_embed(SimpleNamespace(snapshot=snap)) != 0:
        return 1
    if args.skip_load:
        print("[8/8] load — SKIPPED (--skip-load)", file=sys.stderr)
        return 0
    print("[8/8] load", file=sys.stderr)
    rc = cmd_load(SimpleNamespace(snapshot=snap, skip_kb_sync=args.skip_kb_sync))
    return rc


SUBCOMMANDS = {
    "check":    (cmd_check,    lambda p: None),
    "snapshot": (cmd_snapshot, lambda p: p.add_argument("--out", default="schema/synth/seed-graph.json")),
    "personas": (cmd_personas, lambda p: p.add_argument("--snapshot", help="Read seed graph from this JSON instead of Aurora")),
    "docs":     (cmd_docs,     lambda p: (
        p.add_argument("--type", default="all", choices=["all"] + DOC_TYPES),
        p.add_argument("--snapshot", help="Read seed graph from this JSON instead of Aurora"),
    )),
    "stats":    (cmd_stats,    lambda p: None),
    "clean":    (cmd_clean,    lambda p: p.add_argument("--force", action="store_true")),
    "dedupe":   (cmd_dedupe,   lambda p: p.add_argument("--threshold", type=float, default=None)),
    "ner":      (cmd_ner,      lambda p: None),
    "cluster":  (cmd_cluster,  lambda p: p.add_argument("--threshold", type=float, default=0.55)),
    "pitches":  (cmd_pitches,  lambda p: None),
    "embed":    (cmd_embed,    lambda p: p.add_argument("--snapshot", help="Read seed graph from this JSON")),
    "load":     (cmd_load,     lambda p: (
        p.add_argument("--snapshot", help="Read seed graph from this JSON"),
        p.add_argument("--skip-kb-sync", action="store_true"),
    )),
    "all":      (cmd_all,      lambda p: (
        p.add_argument("--snapshot", help="Read seed graph from this JSON"),
        p.add_argument("--skip-load", action="store_true", help="Stop before loading to Aurora/S3/KB"),
        p.add_argument("--skip-kb-sync", action="store_true"),
    )),
}


def main() -> int:
    parser = argparse.ArgumentParser(prog="python -m schema.synth")
    sub = parser.add_subparsers(dest="cmd", required=True)
    for name, (_fn, add_args) in SUBCOMMANDS.items():
        sp = sub.add_parser(name)
        add_args(sp)
    args = parser.parse_args()
    fn, _ = SUBCOMMANDS[args.cmd]
    return fn(args) or 0


if __name__ == "__main__":
    sys.exit(main())
