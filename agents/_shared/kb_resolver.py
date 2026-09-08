"""
kb_resolver.py — resolve Bedrock KB IDs from the Aurora knowledge_bases registry.

Priority:
  1. Aurora knowledge_bases table (SELECT bedrock_kb_id WHERE tenant=:t AND purpose=:p AND status='ACTIVE')
  2. Environment variable fallback (KB_ID)

All lookups are lru_cache'd so the Aurora call only happens once per process.
Agents are long-lived containers — the cache persists for the container lifetime.

Usage:
  from _shared.kb_resolver import resolve_kb_id, resolve_kb_id_by_slug

  KB_ID = resolve_kb_id("orgiq", "default") or ""
"""

import os
import functools
import logging
from typing import Optional

logger = logging.getLogger(__name__)

_REGION = os.environ.get("AWS_REGION", "us-east-1")
_CLUSTER_ARN = os.environ.get("AURORA_CLUSTER_ARN", "")
_SECRET_ARN = os.environ.get("AURORA_SECRET_ARN", "")
_DATABASE = os.environ.get("AURORA_DB_NAME", "orgiq")


@functools.lru_cache(maxsize=32)
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
    if _CLUSTER_ARN and _SECRET_ARN:
        try:
            import boto3
            rds = boto3.client("rds-data", region_name=_REGION)
            resp = rds.execute_statement(
                resourceArn=_CLUSTER_ARN,
                secretArn=_SECRET_ARN,
                database=_DATABASE,
                sql=(
                    "SELECT bedrock_kb_id FROM knowledge_bases "
                    "WHERE tenant = :t AND purpose = :p AND status = 'ACTIVE' "
                    "LIMIT 1"
                ),
                parameters=[
                    {"name": "t", "value": {"stringValue": tenant}},
                    {"name": "p", "value": {"stringValue": purpose}},
                ],
            )
            records = resp.get("records", [])
            if records and records[0][0].get("stringValue"):
                return records[0][0]["stringValue"]
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "kb_resolver: Aurora lookup failed for tenant=%s purpose=%s: %s",
                tenant, purpose, exc,
            )

    # Env var fallback
    return os.environ.get("KB_ID") or None


@functools.lru_cache(maxsize=32)
def resolve_kb_id_by_slug(slug: str) -> Optional[str]:
    """Resolve a Bedrock KB ID by its registry slug.

    Checks the Aurora knowledge_bases registry first, then falls back to
    well-known environment variables for canonical slugs.

    Args:
        slug: Registry slug for the KB (e.g. "default")

    Returns:
        The bedrock_kb_id string if found, or None.
    """
    if _CLUSTER_ARN and _SECRET_ARN:
        try:
            import boto3
            rds = boto3.client("rds-data", region_name=_REGION)
            resp = rds.execute_statement(
                resourceArn=_CLUSTER_ARN,
                secretArn=_SECRET_ARN,
                database=_DATABASE,
                sql=(
                    "SELECT bedrock_kb_id FROM knowledge_bases "
                    "WHERE slug = :s AND status = 'ACTIVE' "
                    "LIMIT 1"
                ),
                parameters=[
                    {"name": "s", "value": {"stringValue": slug}},
                ],
            )
            records = resp.get("records", [])
            if records and records[0][0].get("stringValue"):
                return records[0][0]["stringValue"]
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "kb_resolver: Aurora slug lookup failed for slug=%s: %s",
                slug, exc,
            )

    # Env var fallback for the canonical slug
    if slug == "default":
        return os.environ.get("KB_ID") or None
    return None


def invalidate_cache() -> None:
    """Clear all cached KB ID lookups. Useful for testing."""
    resolve_kb_id.cache_clear()
    resolve_kb_id_by_slug.cache_clear()
