"""
kb_resolver.py — resolve Bedrock KB IDs from the Aurora knowledge_bases registry.

Priority:
  1. Aurora knowledge_bases table (SELECT bedrock_kb_id WHERE tenant=:t AND purpose=:p AND status='ACTIVE')
  2. Environment variable fallback (KB_ID)

Agents are long-lived containers, so a resolved id is cached for the container
lifetime. **Only successful resolutions are cached.** That distinction matters:
Aurora Serverless v2 idles at 0.5 ACU and the first Data API call against a
cold cluster fails until the HTTP endpoint enables (the same race
`schema/load_schema.py` retries around). A cache that stored the miss would
freeze a whole container on ``KB_ID`` — or on ``None``, which reaches Bedrock
as an empty ``knowledgeBaseId`` and fails every retrieve for the life of the
runtime, with nothing in the logs after the first minute to say why. Caching
only what actually resolved means the next call retries.

Note the agents resolve at *module import* (``KB_ID = resolve_kb_id(...) or ""``
in search/advisor), so today a cold-start miss still sticks for that process.
Retrying inside the tool call is the follow-up; not caching the miss is the
half that belongs here.

Usage:
  from _shared.kb_resolver import resolve_kb_id, resolve_kb_id_by_slug

  KB_ID = resolve_kb_id("orgiq", "default") or ""
"""

import os
import logging
import threading
from typing import Optional

from _shared.db_credentials import read_secret_arn

logger = logging.getLogger(__name__)

_REGION = os.environ.get("AWS_REGION", "us-east-1")
_CLUSTER_ARN = os.environ.get("AURORA_CLUSTER_ARN", "")
# The registry lookup is a single SELECT, so it runs on the read-only role
# (`orgiq_graph_reader`, granted SELECT on `knowledge_bases`) wherever that is
# configured, and on the admin credential everywhere else. Read at call time,
# not pinned here: agents resolve their KB at module import, and a constant
# captured before the environment is fully set would freeze the wrong answer.
_SECRET_ARN = os.environ.get("AURORA_SECRET_ARN", "")
_DATABASE = os.environ.get("AURORA_DB_NAME", "orgiq")

# Success-only memo. Key is the lookup tuple; value is the resolved id.
_cache: dict = {}
_cache_lock = threading.Lock()


# ---------------------------------------------------------------------------
# Search type — why every retrieve MUST pass this explicitly.
# ---------------------------------------------------------------------------
#
# Bedrock's DEFAULT search type against this Aurora/pgvector store returns the
# correct k nearest neighbours **sorted worst-first**, and reports cosine
# *distance* in a field named `score` that every caller reads as "higher is
# better". Measured against ground truth (`ORDER BY embedding <=> query` on
# `bedrock_kb`, the very table Bedrock reads) over 8 representative queries:
#
#     default/SEMANTIC  top-1 correct: 0/8
#     HYBRID            top-1 correct: 8/8
#
# For every query the returned SET matched the true nearest neighbours exactly
# while the ORDER was the exact reverse — e.g. "Why did we choose Aurora over
# Neptune?" put `adr-d-iceberg.md` first (distance 0.831) and the actual
# `adr-d-aurora.md` LAST (0.492, i.e. the nearest chunk).
#
# This is the whole reason the knowledge base read as a "false flag": retrieval
# returned plausible, real org documents, so nothing looked broken, while every
# consumer taking the top-N got the LEAST relevant hits and the right answer
# fell off the end. Two things downstream compound it — nothing in the agents
# sorts by `score` (results are passed to the model in Bedrock's order), and
# `middleware/src/lib/turn-tool-calls.ts` trims oversized result lists from the
# TAIL, which discards the most relevant document first.
#
# HYBRID is a supported configuration here, not a workaround: it needs the GIN
# full-text index on `bedrock_kb`, which `infra/lib/knowledge-base-stack.ts`
# creates as `bedrock_kb_text_idx` (the `DbInitTextIndex` custom resource). It
# is also the better retrieval mode for this corpus independently — the queries
# carry exact proper nouns ("Neptune", "Kubernetes", "SOC2") that lexical
# matching nails and pure vector search blurs.
#
# Override only to diagnose: KB_SEARCH_TYPE=SEMANTIC reproduces the inversion.
KB_SEARCH_TYPE = os.environ.get("KB_SEARCH_TYPE", "HYBRID")


def vector_search_config(num_results: int, **extra) -> dict:
    """Build a `vectorSearchConfiguration` with the search type pinned.

    Every KB retrieve in this repo goes through here so the search type cannot
    be omitted at a call site — omitting it is what produced anti-relevant
    ranking on all three production call sites at once. `extra` carries
    per-caller keys such as `filter`.
    """
    cfg = {"numberOfResults": num_results, "overrideSearchType": KB_SEARCH_TYPE}
    cfg.update(extra)
    return cfg


def _cached(key):
    with _cache_lock:
        return _cache.get(key)


def _remember(key, value):
    with _cache_lock:
        _cache[key] = value


def _query_registry(sql: str, parameters: list) -> Optional[str]:
    """Run one registry lookup through the RDS Data API.

    Returns the first column of the first row, or None — including on any
    failure, which is logged. A KB lookup must never raise into agent startup:
    the env fallback exists precisely so a cold or missing Aurora degrades to
    "use the id the runtime was deployed with" rather than to a crash loop.
    """
    secret_arn = read_secret_arn() or _SECRET_ARN
    if not (_CLUSTER_ARN and secret_arn):
        return None
    try:
        import boto3

        rds = boto3.client("rds-data", region_name=_REGION)
        resp = rds.execute_statement(
            resourceArn=_CLUSTER_ARN,
            secretArn=secret_arn,
            database=_DATABASE,
            sql=sql,
            parameters=parameters,
        )
        records = resp.get("records", [])
        if records and records[0] and records[0][0].get("stringValue"):
            return records[0][0]["stringValue"]
    except Exception as exc:  # noqa: BLE001
        logger.warning("kb_resolver: registry lookup failed (%s): %s", parameters, exc)
    return None


def resolve_kb_id(tenant: str, purpose: str = "default") -> Optional[str]:
    """Resolve a Bedrock KB ID by tenant and purpose.

    Checks the Aurora knowledge_bases registry first, then falls back to
    environment variables.

    Args:
        tenant: Tenant identifier (e.g. "orgiq")
        purpose: Purpose/type of KB (e.g. "default", "articles")

    Returns:
        The bedrock_kb_id string if found, or None.
    """
    key = ("tenant", tenant, purpose)
    hit = _cached(key)
    if hit:
        return hit

    found = _query_registry(
        "SELECT bedrock_kb_id FROM knowledge_bases "
        "WHERE tenant = :t AND purpose = :p AND status = 'ACTIVE' "
        "LIMIT 1",
        [
            {"name": "t", "value": {"stringValue": tenant}},
            {"name": "p", "value": {"stringValue": purpose}},
        ],
    )

    # Env var fallback. Read live, not at import: the runtime's KB_ID can be
    # repointed (`cdk deploy --context kbId=…`) without this module changing.
    resolved = found or os.environ.get("KB_ID") or None
    if resolved:
        _remember(key, resolved)
    return resolved


def resolve_kb_id_by_slug(slug: str) -> Optional[str]:
    """Resolve a Bedrock KB ID by its registry slug.

    Checks the Aurora knowledge_bases registry first, then falls back to
    well-known environment variables for canonical slugs.

    Args:
        slug: Registry slug for the KB (e.g. "default")

    Returns:
        The bedrock_kb_id string if found, or None.
    """
    key = ("slug", slug)
    hit = _cached(key)
    if hit:
        return hit

    found = _query_registry(
        "SELECT bedrock_kb_id FROM knowledge_bases "
        "WHERE slug = :s AND status = 'ACTIVE' "
        "LIMIT 1",
        [{"name": "s", "value": {"stringValue": slug}}],
    )

    # Env var fallback for the canonical slug only — KB_ID names the main KB,
    # so handing it back for an arbitrary slug would silently sync the wrong
    # knowledge base.
    if not found and slug == "default":
        found = os.environ.get("KB_ID") or None

    if found:
        _remember(key, found)
    return found


def invalidate_cache() -> None:
    """Clear all cached KB ID lookups. Useful for testing."""
    with _cache_lock:
        _cache.clear()
