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


DOC_TYPES = ["adr", "postmortem", "perf_review", "slack_thread", "all_hands"]


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
    for name in ["personas.json", "seed-graph.json"]:
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
    side_files = [SYNTH_DIR / n for n in ("personas.json", "seed-graph.json")]

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


def cmd_embed(args) -> int:
    from . import embed
    graph = _load_graph(args.snapshot)
    rows = embed.embed_all_nodes(graph)
    print(f"Embedded {len(rows)} nodes (cached)", file=sys.stderr)
    return 0


def cmd_load(args) -> int:
    from . import generate, load, embed

    docs = generate.load_staged()
    if not docs:
        print("No staged docs found — run `docs` first.", file=sys.stderr)
        return 1

    # 1. Documents + mentions + S3.
    for d in docs:
        load.load_one(d)

    # 2. Node embeddings.
    graph = _load_graph(args.snapshot)
    node_rows = embed.embed_all_nodes(graph)
    load.upsert_node_embeddings(node_rows)

    # 3. KB ingestion job.
    if not args.skip_kb_sync:
        load.trigger_kb_sync()

    print(f"Loaded {len(docs)} docs, {len(node_rows)} node embeddings.", file=sys.stderr)
    return 0


def cmd_all(args) -> int:
    """Run the full pipeline: personas → docs → dedupe → embed → load."""
    from types import SimpleNamespace
    snap = args.snapshot
    print("[1/5] personas", file=sys.stderr)
    if cmd_personas(SimpleNamespace(snapshot=snap)) != 0:
        return 1
    print("[2/5] docs", file=sys.stderr)
    if cmd_docs(SimpleNamespace(type="all", snapshot=snap)) != 0:
        return 1
    print("[3/5] dedupe", file=sys.stderr)
    if cmd_dedupe(SimpleNamespace(threshold=None)) != 0:
        return 1
    print("[4/5] embed", file=sys.stderr)
    if cmd_embed(SimpleNamespace(snapshot=snap)) != 0:
        return 1
    if args.skip_load:
        print("[5/5] load — SKIPPED (--skip-load)", file=sys.stderr)
        return 0
    print("[5/5] load", file=sys.stderr)
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
