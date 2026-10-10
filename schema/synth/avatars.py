"""Portrait avatars for the seed cast, generated with Amazon Nova Canvas.

Run separately (`python -m schema.synth avatars`); it is NOT part of `all`
because it costs real money (~$0.04/image, ~$2.24 for 56 people). Cache hits
are free: each PNG has a sidecar JSON holding a key over (model, request body).

No real-person likeness: the prompt carries role, department and a few
seed-derived traits only, never the person's name.

Serving: the artifacts bucket is private, so the portal cannot read the S3
object. `people.avatar_url` is therefore the portal-relative path
`/avatars/<personId>.png`, and `load` also copies each PNG into
`portal/public/avatars/` so the portal bundle (published by
scripts/portal-publish.mjs) serves it. `SYNTH_AVATAR_URL_BASE` overrides the
base (e.g. a CDN origin). The S3 copy (`avatars/<id>.png`) is the durable archive.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
from pathlib import Path
from typing import Any, Callable

from . import cache
from .config import CACHE_DIR, CONFIG, NOVA_CANVAS, SYNTH_DIR, _caller_account

# Nova Canvas requires each side between 320 and 4096 and a multiple of 16, so
# 256 is rejected. Pillow is not installed in .venv-synth (and we may not
# install), so we generate at the 320 minimum and serve it as-is.
IMAGE_SIZE = 320

# Standard quality, up to 512x512 (USD per image). Premium is $0.06.
PRICE_PER_IMAGE_USD = 0.04

AVATAR_DIR = CACHE_DIR / "avatars"
PORTAL_AVATAR_DIR = SYNTH_DIR.parent.parent / "portal" / "public" / "avatars"

NEGATIVE_TEXT = ("illustration, cartoon, vector art, 3D render, plastic skin, "
                 "celebrity, recognizable real-person likeness, text, watermark, logo, "
                 "multiple people, distorted face")

HAIR_STYLES = ["short cropped", "long straight", "curly", "wavy shoulder-length",
               "braided", "buzz cut", "bun", "side-parted", "afro", "bald"]
HAIR_COLOURS = ["black", "dark brown", "chestnut", "auburn", "blonde",
                "silver grey", "ginger", "white"]
SKIN_TONES = ["very light", "light", "medium", "tan", "brown", "deep brown"]
TINTS = ["soft teal", "warm sand", "pale blue", "sage green", "dusty rose",
         "light lavender", "muted peach", "cool grey"]
GLASSES = ["wearing glasses", "no glasses"]


def style_seed(person_id: str) -> int:
    """Deterministic seed in [0, 2**31-1) from sha256 (never Python's hash())."""
    return int.from_bytes(hashlib.sha256(person_id.encode("utf-8")).digest()[:8], "big") % (2**31 - 1)


def _pick(options: list[str], digest: bytes, slot: int) -> str:
    return options[int.from_bytes(digest[slot * 2:slot * 2 + 2], "big") % len(options)]


def traits(person_id: str) -> dict[str, str]:
    d = hashlib.sha256(("traits:" + person_id).encode("utf-8")).digest()
    return {
        "hair_style": _pick(HAIR_STYLES, d, 0),
        "hair_colour": _pick(HAIR_COLOURS, d, 1),
        "skin": _pick(SKIN_TONES, d, 2),
        "tint": _pick(TINTS, d, 3),
        "glasses": _pick(GLASSES, d, 4),
    }


def with_departments(people: list[dict], teams: list[dict]) -> list[dict]:
    names = {t["id"]: t["name"] for t in teams}
    return [{**p, "department": p.get("department") or names.get(p.get("team_id"), "")}
            for p in people]


def build_prompt(person: dict) -> dict:
    t = traits(person["id"])
    role = person.get("title") or "team member"
    dept = person.get("department") or "the organisation"
    text = (f"photographic head-and-shoulders portrait of a fictional adult {role} in {dept}, "
            f"{t['hair_colour']} {t['hair_style']} hair, {t['skin']} skin tone, {t['glasses']}, "
            f"softly blurred neutral {t['tint']} office background, "
            f"natural skin texture and proportions, relaxed expression, soft window daylight, "
            f"normal business-casual clothes, centered, shoulders up, room for a circular crop")
    return {"text": text[:1000], "negativeText": NEGATIVE_TEXT}


def request_body(person: dict) -> dict:
    p = build_prompt(person)
    return {
        "taskType": "TEXT_IMAGE",
        "textToImageParams": {"text": p["text"], "negativeText": p["negativeText"]},
        "imageGenerationConfig": {
            "numberOfImages": 1, "width": IMAGE_SIZE, "height": IMAGE_SIZE,
            "cfgScale": 7.0, "seed": style_seed(person["id"]), "quality": "standard",
        },
    }


_CLIENT: list = []


def _bedrock():
    if not _CLIENT:
        import boto3
        _CLIENT.append(boto3.client("bedrock-runtime", region_name=CONFIG.region))
    return _CLIENT[0]


_CALLS = {"n": 0}  # Bedrock calls actually made this process


def generate_one(person: dict, *, client=None) -> Path:
    pid = person["id"]
    body = request_body(person)
    key = cache.cache_key(NOVA_CANVAS, body)
    AVATAR_DIR.mkdir(parents=True, exist_ok=True)
    png, side = AVATAR_DIR / f"{pid}.png", AVATAR_DIR / f"{pid}.json"
    if png.exists() and side.exists():
        try:
            if json.loads(side.read_text()).get("key") == key:
                return png
        except json.JSONDecodeError:
            pass
    client = client or _bedrock()
    resp = client.invoke_model(modelId=NOVA_CANVAS, body=json.dumps(body),
                               accept="application/json", contentType="application/json")
    _CALLS["n"] += 1
    raw = resp["body"]
    payload = json.loads(raw.read() if hasattr(raw, "read") else raw)
    if payload.get("error"):
        raise RuntimeError(f"Nova Canvas error for {pid}: {payload['error']}")
    images = payload.get("images") or []
    if not images:
        raise RuntimeError(f"Nova Canvas returned no image for {pid}")
    png.write_bytes(base64.b64decode(images[0]))
    side.write_text(json.dumps({"key": key, "model": NOVA_CANVAS}))
    return png


def artifacts_bucket() -> str:
    acct = os.environ.get("AWS_ACCOUNT_ID") or _caller_account()
    return f"orgiq-artifacts-{acct}-{CONFIG.region}"


def avatar_url(person_id: str) -> str:
    base = os.environ.get("SYNTH_AVATAR_URL_BASE", "/avatars").rstrip("/")
    return f"{base}/{person_id}.png"


UPDATE_SQL = ("UPDATE people SET avatar_url = :url, updated_at = NOW() "
              "WHERE id = :id AND avatar_url IS DISTINCT FROM :url")


def upload_and_upsert(people: list[dict], *, s3=None, execute: Callable[..., Any] | None = None) -> int:
    """Upload cached PNGs, copy them into the portal bundle, set people.avatar_url."""
    if s3 is None:
        import boto3
        s3 = boto3.client("s3", region_name=CONFIG.region)
    if execute is None:
        from . import aurora
        execute = aurora.execute
    bucket = artifacts_bucket()
    n = 0
    for p in people:
        pid = p["id"]
        png = AVATAR_DIR / f"{pid}.png"
        if not png.exists():
            continue
        data = png.read_bytes()
        s3.put_object(Bucket=bucket, Key=f"avatars/{pid}.png", Body=data, ContentType="image/png")
        PORTAL_AVATAR_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(png, PORTAL_AVATAR_DIR / f"{pid}.png")
        execute(UPDATE_SQL, params=[
            {"name": "id", "value": {"stringValue": pid}},
            {"name": "url", "value": {"stringValue": avatar_url(pid)}},
        ])
        n += 1
    return n


def run(people: list[dict], *, skip_load: bool = False, client=None, s3=None, execute=None) -> list[Path]:
    before = _CALLS["n"]
    paths = [generate_one(p, client=client) for p in people]
    made = _CALLS["n"] - before
    print(f"avatars: {len(paths)} ready, {made} Bedrock calls × ${PRICE_PER_IMAGE_USD:.2f} "
          f"= ${made * PRICE_PER_IMAGE_USD:.2f} ({len(paths) - made} cache hits free)")
    if not skip_load:
        n = upload_and_upsert(people, s3=s3, execute=execute)
        print(f"avatars: uploaded/updated {n} people")
    return paths
