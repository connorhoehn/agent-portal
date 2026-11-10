#!/usr/bin/env python3
"""Write the `tenant` metadata sidecar beside every knowledge-base document
that lacks one (the migration for per-tenant data sources; infra/SECURITY-NOTES.md).

Retrieval filters on the `tenant` metadata attribute as well as on the key
prefix, so a document indexed without `<key>.metadata.json` is no longer
returned. This lists every declared prefix (tenants/kb-prefixes.json) and any
`--prefix TENANT=PREFIX` given (prefixes registered at run time in
/admin/knowledge), and writes `{"metadataAttributes": {"tenant": OWNER}}` for
each document without a sidecar, OWNER being the tenant of the longest prefix
the key starts with. Dry run unless `--apply`; then sync each data source.

Run from repo root:
    python3 schema/backfill_kb_tenant_metadata.py --bucket <documents bucket> [--prefix assessment=assessment/evidence/] [--apply]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
KB_PREFIXES = REPO_ROOT / "tenants" / "kb-prefixes.json"
SIDECAR = ".metadata.json"


def declared_prefixes(path: Path = KB_PREFIXES) -> list[tuple[str, str]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return [(p, t) for t, ps in data["tenants"].items() for p in ps]


def owner_of(key: str, prefixes: list[tuple[str, str]]) -> str | None:
    best, owner = -1, None
    for p, t in prefixes:
        if key.startswith(p) and len(p) > best:
            best, owner = len(p), t
    return owner


def plan(keys: list[str], prefixes: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """(sidecar key, owner) for every document key without a sidecar."""
    present = set(keys)
    out = []
    for key in keys:
        if key.endswith(SIDECAR) or key.endswith("/") or f"{key}{SIDECAR}" in present:
            continue
        owner = owner_of(key, prefixes)
        if owner:
            out.append((f"{key}{SIDECAR}", owner))
    return out


def sidecar_body(owner: str) -> bytes:
    return json.dumps({"metadataAttributes": {"tenant": owner}}).encode("utf-8")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--prefix", action="append", default=[], metavar="TENANT=PREFIX")
    parser.add_argument("--apply", action="store_true", help="write the sidecars (default: print the plan)")
    options = parser.parse_args(argv)
    prefixes = declared_prefixes()
    for item in options.prefix:
        tenant, _, prefix = item.partition("=")
        if not tenant or not prefix or prefix.startswith("/") or ".." in prefix.split("/"):
            parser.error(f"bad --prefix {item!r}")
        prefixes.append((prefix.rstrip("/") + "/", tenant))

    import boto3

    s3 = boto3.client("s3", region_name=os.environ.get("AWS_REGION", "us-east-1"))
    keys: list[str] = []
    for p, _ in prefixes:
        for page in s3.get_paginator("list_objects_v2").paginate(Bucket=options.bucket, Prefix=p):
            keys.extend(o["Key"] for o in page.get("Contents", []))
    todo = plan(sorted(set(keys)), prefixes)
    for sidecar, owner in todo:
        print(f"{'write' if options.apply else 'would write'} {sidecar} tenant={owner}")
        if options.apply:
            s3.put_object(Bucket=options.bucket, Key=sidecar, Body=sidecar_body(owner), ContentType="application/json")
    print(f"{len(todo)} sidecar(s) {'written' if options.apply else 'planned'}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
