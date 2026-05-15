"""Generate one editor pitch per story cluster."""
from __future__ import annotations

import logging

from . import cache
from .bedrock import converse_with_schema
from .cluster import Cluster
from .config import NOVA_LITE
from .prompts import pitch as pitch_prompts
from .schemas import EditorPitch, EditorPitchGen

log = logging.getLogger(__name__)


def generate_pitches(clusters: list[Cluster]) -> list[EditorPitch]:
    pitches: list[EditorPitch] = []
    for cluster in clusters:
        if not cluster.meta:
            continue
        key = cache.cache_key("pitch-v1", cluster.id, NOVA_LITE)
        hit = cache.get("pitches", key)
        if hit:
            pitches.append(EditorPitch.model_validate(hit))
            continue
        gen = converse_with_schema(
            EditorPitchGen,
            system=pitch_prompts.SYSTEM,
            user_prompt=pitch_prompts.build_prompt(
                cluster.meta.title, cluster.meta.description, cluster.headlines
            ),
            model_id=NOVA_LITE,
            temperature=0.6,
            max_tokens=1024,
        )
        pitch = EditorPitch(cluster_id=cluster.id, **gen.model_dump())
        cache.put("pitches", key, pitch.model_dump())
        pitches.append(pitch)
    return pitches
