"""Aurora + S3 + KB loader for generated docs.

Each generator produces a `LoadableDoc` dict (id, title, source, source_uri,
body_markdown, mentions). This module:
  - Uploads the body to S3 under the configured prefix.
  - Upserts a row into `documents`.
  - Upserts edges into `mentions`.
  - Triggers a KB ingestion job after a batch lands.

Nothing here runs unless explicitly called from __main__ — generation can
proceed offline and be loaded later.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from functools import lru_cache

import boto3

from . import aurora
from .config import CONFIG

log = logging.getLogger(__name__)


@dataclass
class LoadableDoc:
    id: str                     # e.g. "adr-d-aurora"
    title: str
    source: str                 # "adr" | "postmortem" | ... — populates documents.source
    body_markdown: str
    mentions: list[dict]        # [{entity_type, entity_id, count?}, ...]
    s3_prefix: str              # under bucket: e.g. "synth/internal/adr/"
    # Metadata columns on `documents`. NULL where not applicable.
    doc_type: str | None = None
    headline: str | None = None
    published_at: str | None = None      # ISO-8601 date or timestamp
    section: str | None = None


@lru_cache(maxsize=1)
def _s3():
    return boto3.client("s3", region_name=CONFIG.region)


def upload_body(doc: LoadableDoc) -> str:
    """Push the markdown body to S3 and return the s3:// URI."""
    bucket = CONFIG.s3_bucket
    key = f"{doc.s3_prefix.rstrip('/')}/{doc.id}.md"
    _s3().put_object(
        Bucket=bucket,
        Key=key,
        Body=doc.body_markdown.encode("utf-8"),
        ContentType="text/markdown; charset=utf-8",
        Metadata={"orgiq-doc-id": doc.id, "orgiq-source": doc.source},
    )
    return f"s3://{bucket}/{key}"


def _str_or_null(v: str | None) -> dict:
    # RDS Data API can't type a bare {isNull: true} inside expressions like
    # CASE WHEN :p IS NULL … (Postgres 42P18). Send '' and let the SQL use
    # NULLIF(:p, '') so the parameter is always an unambiguous text value.
    return {"stringValue": v if v is not None else ""}


def upsert_document(doc: LoadableDoc, source_uri: str) -> None:
    aurora.execute(
        """
        INSERT INTO documents
            (id, source, source_uri, title, doc_type, headline, published_at,
             section, kb_registry_slug)
        VALUES
            (:id, :source, :source_uri, :title,
             NULLIF(:doc_type, ''), NULLIF(:headline, ''),
             NULLIF(:published_at, '')::timestamptz,
             NULLIF(:section, ''),
             -- Resolve the slug THROUGH the registry rather than trusting the
             -- parameter: kb_registry_slug is a FK, so a slug with no row would
             -- fail the insert and take the whole corpus load down with it.
             -- The subselect yields NULL when the registry has no such row,
             -- degrading to the old unlinked behaviour instead of erroring.
             (SELECT slug FROM knowledge_bases WHERE slug = NULLIF(:kb_slug, '')))
        ON CONFLICT (id) DO UPDATE
          SET source = EXCLUDED.source,
              source_uri = EXCLUDED.source_uri,
              title = EXCLUDED.title,
              doc_type = EXCLUDED.doc_type,
              headline = EXCLUDED.headline,
              published_at = EXCLUDED.published_at,
              section = EXCLUDED.section,
              -- COALESCE so a run against a cluster whose registry row is
              -- missing cannot blank a link an earlier run established.
              kb_registry_slug = COALESCE(EXCLUDED.kb_registry_slug,
                                          documents.kb_registry_slug)
        """,
        params=[
            {"name": "id",           "value": {"stringValue": doc.id}},
            {"name": "source",       "value": {"stringValue": doc.source}},
            {"name": "source_uri",   "value": {"stringValue": source_uri}},
            {"name": "title",        "value": {"stringValue": doc.title}},
            {"name": "doc_type",     "value": _str_or_null(doc.doc_type)},
            {"name": "headline",     "value": _str_or_null(doc.headline)},
            {"name": "published_at", "value": _str_or_null(doc.published_at)},
            {"name": "section",      "value": _str_or_null(doc.section)},
            {"name": "kb_slug",      "value": _str_or_null(CONFIG.kb_registry_slug)},
        ],
    )


def upsert_mentions(doc: LoadableDoc) -> None:
    if not doc.mentions:
        return
    # Wipe-and-reinsert: the doc is the unit of truth for its own mentions.
    aurora.execute(
        "DELETE FROM mentions WHERE document_id = :doc_id",
        params=[{"name": "doc_id", "value": {"stringValue": doc.id}}],
    )
    param_sets = [
        [
            {"name": "doc_id",      "value": {"stringValue": doc.id}},
            {"name": "entity_type", "value": {"stringValue": m["entity_type"]}},
            {"name": "entity_id",   "value": {"stringValue": m["entity_id"]}},
            {"name": "count",       "value": {"longValue": int(m.get("count", 1))}},
        ]
        for m in doc.mentions
    ]
    aurora.execute_many(
        """
        INSERT INTO mentions (document_id, entity_type, entity_id, count)
        VALUES (:doc_id, :entity_type, :entity_id, :count)
        ON CONFLICT (document_id, entity_type, entity_id) DO UPDATE
          SET count = EXCLUDED.count
        """,
        param_sets,
    )


def load_one(doc: LoadableDoc) -> str:
    """Full path for a single doc — S3 upload, Aurora upsert, mentions upsert."""
    uri = upload_body(doc)
    upsert_document(doc, uri)
    upsert_mentions(doc)
    log.info("loaded %s → %s", doc.id, uri)
    return uri


def upsert_node_embeddings(rows: list[dict]) -> None:
    """rows: [{node_id, node_type, content, embedding: [floats]}, ...]"""
    if not rows:
        return
    # pgvector accepts a string literal cast via :embedding::vector
    param_sets = [
        [
            {"name": "node_id",   "value": {"stringValue": r["node_id"]}},
            {"name": "node_type", "value": {"stringValue": r["node_type"]}},
            {"name": "content",   "value": {"stringValue": r["content"]}},
            {"name": "embedding", "value": {"stringValue": "[" + ",".join(f"{v:.7f}" for v in r["embedding"]) + "]"}},
        ]
        for r in rows
    ]
    aurora.execute_many(
        """
        INSERT INTO node_embeddings (node_id, node_type, content, embedding)
        VALUES (:node_id, :node_type, :content, :embedding::vector)
        ON CONFLICT (node_id) DO UPDATE
          SET node_type = EXCLUDED.node_type,
              content = EXCLUDED.content,
              embedding = EXCLUDED.embedding
        """,
        param_sets,
    )


def trigger_kb_sync() -> str | None:
    """Kick off a Bedrock KB ingestion job. Returns the job id or None if the KB
    isn't deployed yet."""
    import subprocess, json
    try:
        out = subprocess.check_output([
            "aws", "cloudformation", "describe-stacks",
            "--stack-name", "OrgIQ-KnowledgeBase",
            "--region", CONFIG.region,
            "--query", "Stacks[0].Outputs",
            "--output", "json",
        ], text=True)
    except subprocess.CalledProcessError:
        log.warning("OrgIQ-KnowledgeBase stack not deployed — skipping KB sync")
        return None
    outputs = {o["OutputKey"]: o["OutputValue"] for o in json.loads(out)}
    kb_id = outputs.get("KnowledgeBaseId")
    ds_id = outputs.get("DataSourceId")
    if not kb_id or not ds_id:
        log.warning("KB/DataSource IDs missing from stack outputs — skipping KB sync")
        return None
    reconcile_kb_registry(kb_id, ds_id)
    bedrock_agent = boto3.client("bedrock-agent", region_name=CONFIG.region)
    resp = bedrock_agent.start_ingestion_job(knowledgeBaseId=kb_id, dataSourceId=ds_id)
    job_id = resp["ingestionJob"]["ingestionJobId"]
    log.info("KB ingestion job started: %s", job_id)
    return job_id


def reconcile_kb_registry(kb_id: str, ds_id: str) -> None:
    """Point the `knowledge_bases` registry row at the live Bedrock KB.

    A rebuilt `OrgIQ-KnowledgeBase` mints fresh ids, but the seeded registry row
    keeps `bedrock_kb_id`/`data_source_id` NULL at `status = 'PENDING'` — so the
    admin surface reported the knowledge base as unprovisioned while it was live
    and fully indexed, the exact inverse of the corpus reporting success against
    an empty KB. Nothing reconciled the two automatically.

    This runs on the corpus load because that is the one step that already holds
    both live ids, so the link repairs itself on every run instead of needing a
    hand-driven adoption after each rebuild. `s3_prefix` is deliberately left
    alone: it describes the portal's *upload* landing zone, and the CDK data
    source sets no inclusion prefix, so the whole bucket is indexed regardless
    of where the corpus happens to sit.
    """
    # RETURNING, not numberOfRecordsUpdated: `aurora.execute` maps the Data API
    # response to rows and discards the update count, so a bare UPDATE would
    # report "already current" even on the run that repaired the row.
    updated = aurora.execute(
        """
        UPDATE knowledge_bases
           SET bedrock_kb_id  = :kb_id,
               data_source_id = :ds_id,
               status         = 'ACTIVE',
               error_message  = NULL
         WHERE slug = :slug
           AND (bedrock_kb_id  IS DISTINCT FROM :kb_id
             OR data_source_id IS DISTINCT FROM :ds_id
             OR status <> 'ACTIVE')
        RETURNING slug
        """,
        params=[
            {"name": "kb_id", "value": {"stringValue": kb_id}},
            {"name": "ds_id", "value": {"stringValue": ds_id}},
            {"name": "slug",  "value": {"stringValue": CONFIG.kb_registry_slug}},
        ],
    )
    if updated:
        log.info("kb registry row %r repointed → kb=%s ds=%s (ACTIVE)",
                 CONFIG.kb_registry_slug, kb_id, ds_id)
    else:
        log.debug("kb registry row %r already current", CONFIG.kb_registry_slug)
