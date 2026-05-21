"""Resource tracking and cleanup utilities for OrgIQ GCP notebooks.

Mirrors the AWS-side `cleanup_utils.py` but targets GCP resource types
(Vertex AI deployments, Discovery Engine apps, BigQuery datasets, GCS
buckets, RAG corpora, etc). Tracked resources are recorded in `config.json`
under `gcp.tracked_resources` so 19-cleanup can drain them in dependency
order.

Usage in a notebook:

    from cleanup_utils import ResourceTracker
    tracker = ResourceTracker()
    tracker.track('bigquery_dataset', 'orgiq', project='my-project')
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
    "vertex_endpoint": lambda r: [
        "ai", "endpoints", "delete", r["name"],
        "--region", r.get("region", "us-central1"),
        "--quiet",
    ],
    # Discovery Engine surface moved out of `alpha` — engines and data stores
    # are separate resources and must be deleted independently (engine first,
    # then data store). The portal notebook 04-vertex-search creates both.
    "discovery_engine_engine": lambda r: [
        "beta", "discovery-engine", "engines", "delete", r["name"],
        "--location", r.get("location", "global"),
        "--collection", r.get("collection", "default_collection"),
        "--quiet",
    ],
    "discovery_engine_data_store": lambda r: [
        "beta", "discovery-engine", "data-stores", "delete", r["name"],
        "--location", r.get("location", "global"),
        "--collection", r.get("collection", "default_collection"),
        "--quiet",
    ],
    "gcs_bucket": lambda r: [
        "storage", "rm", "--recursive", f"gs://{r['name']}",
    ],
    "model_armor_template": lambda r: [
        "model-armor", "templates", "delete", r["name"],
        "--location", r.get("location", "us-central1"),
        "--quiet",
    ],
}
# Note: identity_platform_tenant and identityplatform.tenant are handled by
# PYTHON_DELETERS below — gcloud identity-platform is not available in all
# gcloud versions.


# Python deleters — for resources whose canonical delete path is not
# `gcloud` (e.g. Vertex AI Agent Engines, RAG corpora). The teardown loop
# calls these as `func(record)` and expects them to return on success or
# raise on failure. Python deleters take priority over gcloud DELETERS.
def _delete_bigquery_dataset(r: dict[str, Any]) -> None:
    """Delete a BigQuery dataset and all its contents via the Python client.

    Uses delete_contents=True so tables/views inside are dropped first.
    The bq CLI is a separate tool, not a gcloud subcommand, so it cannot go
    through the gcloud DELETERS path.
    """
    from google.cloud import bigquery as _bq
    project = r.get("project")
    client = _bq.Client(project=project)
    dataset_id = f'{project}.{r["name"]}' if project else r["name"]
    client.delete_dataset(dataset_id, delete_contents=True, not_found_ok=True)


def _delete_agent_engine(r: dict[str, Any]) -> None:
    """Delete a Vertex AI Agent Engine (Reasoning Engine) via the Python SDK.

    `gcloud ai reasoning-engines` is not present in all gcloud versions; the
    Python SDK (`vertexai.Client.agent_engines`) is the stable surface.
    """
    import vertexai
    project = r.get("project")
    region = r.get("region", "us-central1")
    if not project:
        cfg = _load_config()
        project = cfg.get("gcp", {}).get("project_id")
    full_name = r.get("full_name")
    if not full_name and project:
        full_name = f"projects/{project}/locations/{region}/reasoningEngines/{r['name']}"
    if not full_name:
        raise ValueError(f"cannot resolve full resource name for agent_engine {r!r}")
    # Use raw REST with force=true — the Python SDK delete() doesn't expose
    # the force flag, and engines with child sessions fail with FAILED_PRECONDITION
    # without it.
    import google.auth
    import google.auth.transport.requests
    import urllib.request as _urllib

    creds, _ = google.auth.default()
    creds.refresh(google.auth.transport.requests.Request())

    url = f'https://{region}-aiplatform.googleapis.com/v1beta1/{full_name}?force=true'
    req = _urllib.Request(url, method='DELETE')
    req.add_header('Authorization', f'Bearer {creds.token}')
    with _urllib.urlopen(req) as resp:
        if resp.status not in (200, 202):
            body = resp.read().decode()
            raise RuntimeError(f'DELETE {full_name} returned {resp.status}: {body[:300]}')


def _delete_identity_platform_tenant(r: dict[str, Any]) -> None:
    """Delete an Identity Platform tenant via the Identity Toolkit REST API.

    gcloud identity-platform is not in all gcloud versions. The REST surface
    DELETE identitytoolkit.googleapis.com/v2/projects/{project}/tenants/{id}
    is always available with Application Default Credentials.
    Tracker entries may store the tenant id under 'id' instead of 'name'.
    """
    import google.auth
    import google.auth.transport.requests
    import urllib.request as _urllib

    project = r.get("project")
    if not project:
        cfg = _load_config()
        project = cfg.get("gcp", {}).get("project_id")
    tenant_id = r.get("id") or r.get("name")
    if not tenant_id:
        raise ValueError(f"cannot resolve tenant id from record {r!r}")

    creds, _ = google.auth.default()
    creds.refresh(google.auth.transport.requests.Request())
    url = f"https://identitytoolkit.googleapis.com/v2/projects/{project}/tenants/{tenant_id}"
    req = _urllib.Request(url, method="DELETE")
    req.add_header("Authorization", f"Bearer {creds.token}")
    with _urllib.urlopen(req) as resp:
        if resp.status not in (200, 204):
            body = resp.read().decode()
            raise RuntimeError(f"DELETE tenant {tenant_id} returned {resp.status}: {body[:300]}")


def _delete_rag_corpus(r: dict[str, Any]) -> None:
    """Delete a Vertex AI RAG Engine corpus by full resource name."""
    import vertexai
    from vertexai import rag
    vertexai.init(project=r["project"], location=r.get("location", "us-central1"))
    rag.delete_corpus(name=r["name"])


PYTHON_DELETERS: dict[str, callable] = {
    "bigquery_dataset": _delete_bigquery_dataset,
    "agent_engine": _delete_agent_engine,
    "identity_platform_tenant": _delete_identity_platform_tenant,
    "identityplatform.tenant": _delete_identity_platform_tenant,
    "rag_corpus": _delete_rag_corpus,
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

    def list(self) -> list[dict[str, Any]] :
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
            py_handler = PYTHON_DELETERS.get(kind)
            cli_handler = DELETERS.get(kind)
            if py_handler is None and cli_handler is None:
                skipped.append({**r, "reason": f"no deleter for kind={kind!r}"})
                continue
            if dry_run:
                if py_handler is not None:
                    log.info("DRY [python]: %s(%r)", py_handler.__name__, r)
                else:
                    log.info("DRY: %s", " ".join(["gcloud", *cli_handler(r)]))
                ok += 1
                continue
            try:
                if py_handler is not None:
                    py_handler(r)
                else:
                    subprocess.run(
                        ["gcloud", *cli_handler(r)],
                        check=True, capture_output=True, text=True,
                    )
                self.untrack(kind, r.get("name"))
                ok += 1
            except subprocess.CalledProcessError as exc:
                failed.append({**r, "stderr": exc.stderr.strip()[:500]})
            except Exception as exc:  # noqa: BLE001 — surface python deleter errors
                failed.append({**r, "error": f"{type(exc).__name__}: {exc}"[:500]})
        self.flush()
        return {"ok": ok, "failed": failed, "skipped": skipped}
