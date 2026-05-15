"""Per-doc disk cache keyed on (doc_id, model, params).

Each generated artifact is cached as a single JSON file so reruns are free.
Cache lives under schema/synth/cache/ and is gitignored.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from .config import CACHE_DIR


def cache_key(*parts: Any) -> str:
    h = hashlib.sha256()
    for part in parts:
        h.update(json.dumps(part, sort_keys=True, default=str).encode("utf-8"))
        h.update(b"\x00")
    return h.hexdigest()[:24]


def _path(namespace: str, key: str) -> Path:
    ns_dir = CACHE_DIR / namespace
    ns_dir.mkdir(parents=True, exist_ok=True)
    return ns_dir / f"{key}.json"


def get(namespace: str, key: str) -> dict | None:
    p = _path(namespace, key)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except json.JSONDecodeError:
        return None


def put(namespace: str, key: str, value: dict) -> None:
    p = _path(namespace, key)
    p.write_text(json.dumps(value, indent=2, default=str))


def invalidate(namespace: str, key: str) -> None:
    p = _path(namespace, key)
    if p.exists():
        p.unlink()
