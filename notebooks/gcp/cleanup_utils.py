"""Resource tracking and cleanup utilities for OrgIQ GCP notebooks.

Mirrors the AWS-side `cleanup_utils.py` but targets GCP resource types
(Vertex AI deployments, Discovery Engine apps, AlloyDB clusters, GCS
buckets, etc). Tracked resources are recorded in `config.json` under
`gcp.tracked_resources` so 19-cleanup can drain them in dependency order.

Usage in a notebook:

    from cleanup_utils import ResourceTracker
    tracker = ResourceTracker()
    tracker.track('alloydb_cluster', 'orgiq-alloydb', region='us-central1')
    tracker.flush()           # persist to config.json
    # ... later, in 19-cleanup ...
    tracker.teardown_all()    # walks the list in reverse insertion order
"""
from __future__ import annotations

import json
import logging
import subprocess
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Optional

log = logging.getLogger(__name__)

CONFIG_PATH = Path("config.json")
TRACKED_KEY_PATH = ("gcp", "tracked_resources")

# Resource-kind → delete handler (gcloud command builder). Each handler returns
# a list of args appended to `gcloud`. Add new kinds here as notebooks need them.
DELETERS: dict[str, callable] = {
    "alloydb_cluster": lambda r: [
        "alloydb", "clusters", "delete", r["name"],
        "--region", r.get("region", "us-central1"),
        "--force", "--quiet",
    ],
    "vertex_endpoint": lambda r: [
        "ai", "endpoints", "delete", r["name"],
        "--region", r.get("region", "us-central1"),
        "--quiet",
    ],
    "discovery_engine_app": lambda r: [
        "alpha", "discovery-engine", "apps", "delete", r["name"],
        "--location", r.get("location", "global"),
        "--quiet",
    ],
    "gcs_bucket": lambda r: [
        "storage", "rm", "--recursive", f"gs://{r['name']}",
    ],
    "agent_engine": lambda r: [
        "ai", "reasoning-engines", "delete", r["name"],
        "--region", r.get("region", "us-central1"),
        "--quiet",
    ],
    "model_armor_template": lambda r: [
        "model-armor", "templates", "delete", r["name"],
        "--location", r.get("location", "us-central1"),
        "--quiet",
    ],
}


@dataclass
class TrackedResource:
    kind: str
    name: str
    extra: dict[str, Any] = field(default_factory=dict)


def _load_config() -> dict[str, Any]:
    if not CONFIG_PATH.exists():
        return {}
    try:
        return json.loads(CONFIG_PATH.read_text())
    except json.JSONDecodeError:
        log.warning("config.json is malformed; treating as empty")
        return {}


def _save_config(cfg: dict[str, Any]) -> None:
    CONFIG_PATH.write_text(json.dumps(cfg, indent=2))


def _get_tracked(cfg: dict[str, Any]) -> list[dict[str, Any]]:
    node: Any = cfg
    for key in TRACKED_KEY_PATH:
        if not isinstance(node, dict) or key not in node:
            return []
        node = node[key]
    return node if isinstance(node, list) else []


def _set_tracked(cfg: dict[str, Any], items: list[dict[str, Any]]) -> None:
    node = cfg
    for key in TRACKED_KEY_PATH[:-1]:
        node = node.setdefault(key, {})
    node[TRACKED_KEY_PATH[-1]] = items


class ResourceTracker:
    """Append-only ledger of GCP resources created by notebooks."""

    def __init__(self) -> None:
        self._cfg = _load_config()
        existing = _get_tracked(self._cfg)
        self._items: list[dict[str, Any]] = list(existing)

    def track(self, kind: str, name: str, **extra: Any) -> None:
        """Record a resource. Idempotent on (kind, name) — re-tracks update extras."""
        for i, r in enumerate(self._items):
            if r.get("kind") == kind and r.get("name") == name:
                self._items[i] = {"kind": kind, "name": name, **extra}
                return
        self._items.append({"kind": kind, "name": name, **extra})

    def untrack(self, kind: str, name: str) -> None:
        self._items = [
            r for r in self._items
            if not (r.get("kind") == kind and r.get("name") == name)
        ]

    def list(self) -> list[dict[str, Any]]:
        return list(self._items)

    def flush(self) -> None:
        """Persist the current list back to config.json."""
        _set_tracked(self._cfg, self._items)
        _save_config(self._cfg)

    def teardown_all(self, dry_run: bool = False) -> dict[str, Any]:
        """Delete every tracked resource in reverse insertion order.

        Returns a summary dict: {ok: int, failed: list, skipped: list}.
        Continues on individual failures.
        """
        ok = 0
        failed: list[dict[str, Any]] = []
        skipped: list[dict[str, Any]] = []
        for r in reversed(self._items):
            kind = r.get("kind")
            handler = DELETERS.get(kind)
            if not handler:
                skipped.append({**r, "reason": f"no deleter for kind={kind!r}"})
                continue
            args = ["gcloud", *handler(r)]
            if dry_run:
                log.info("DRY: %s", " ".join(args))
                ok += 1
                continue
            try:
                subprocess.run(args, check=True, capture_output=True, text=True)
                self.untrack(kind, r["name"])
                ok += 1
            except subprocess.CalledProcessError as exc:
                failed.append({**r, "stderr": exc.stderr.strip()[:500]})
        self.flush()
        return {"ok": ok, "failed": failed, "skipped": skipped}
