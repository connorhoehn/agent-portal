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
    # Newsroom-extended columns on `documents`. NULL where not applicable.
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
            (id, source, source_uri, title, doc_type, headline, published_at, section)
        VALUES
            (:id, :source, :source_uri, :title,
             NULLIF(:doc_type, ''), NULLIF(:headline, ''),
             NULLIF(:published_at, '')::timestamptz,
             NULLIF(:section, ''))
        ON CONFLICT (id) DO UPDATE
          SET source = EXCLUDED.source,
              source_uri = EXCLUDED.source_uri,
              title = EXCLUDED.title,
              doc_type = EXCLUDED.doc_type,
              headline = EXCLUDED.headline,
              published_at = EXCLUDED.published_at,
              section = EXCLUDED.section
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


# ── Newsroom-side loaders ─────────────────────────────────────────────────────

def upsert_entities(entities: list[dict]) -> None:
    """entities: [{id, name, entity_type}, ...]"""
    if not entities:
        return
    param_sets = [
        [
            {"name": "id",          "value": {"stringValue": e["id"]}},
            {"name": "name",        "value": {"stringValue": e["name"]}},
            {"name": "entity_type", "value": {"stringValue": e["entity_type"]}},
        ]
        for e in entities
    ]
    aurora.execute_many(
        """
        INSERT INTO entities (id, name, entity_type)
        VALUES (:id, :name, :entity_type)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
        """,
        param_sets,
    )


def upsert_article_entities(rows: list[dict]) -> None:
    """rows: [{article_id, entity_id, salience}, ...]"""
    if not rows:
        return
    param_sets = [
        [
            {"name": "article_id", "value": {"stringValue": r["article_id"]}},
            {"name": "entity_id",  "value": {"stringValue": r["entity_id"]}},
            {"name": "salience",   "value": {"doubleValue": float(r.get("salience", 1.0))}},
        ]
        for r in rows
    ]
    aurora.execute_many(
        """
        INSERT INTO article_entities (article_id, entity_id, salience)
        VALUES (:article_id, :entity_id, :salience)
        ON CONFLICT (article_id, entity_id) DO UPDATE SET salience = EXCLUDED.salience
        """,
        param_sets,
    )


def upsert_clusters(clusters: list[dict]) -> None:
    """clusters: [{id, title, description, primary_beat, article_ids: [...]}, ...]"""
    if not clusters:
        return
    cluster_params = [
        [
            {"name": "id",           "value": {"stringValue": c["id"]}},
            {"name": "title",        "value": {"stringValue": c["title"]}},
            {"name": "description",  "value": {"stringValue": c["description"]}},
            {"name": "primary_beat", "value": {"stringValue": c["primary_beat"]}},
        ]
        for c in clusters
    ]
    aurora.execute_many(
        """
        INSERT INTO story_clusters (id, title, description, primary_beat)
        VALUES (:id, :title, :description, :primary_beat)
        ON CONFLICT (id) DO UPDATE
          SET title = EXCLUDED.title,
              description = EXCLUDED.description,
              primary_beat = EXCLUDED.primary_beat,
              last_updated = NOW()
        """,
        cluster_params,
    )
    edge_params = [
        [
            {"name": "cluster_id", "value": {"stringValue": c["id"]}},
            {"name": "article_id", "value": {"stringValue": aid}},
        ]
        for c in clusters for aid in c["article_ids"]
    ]
    aurora.execute_many(
        """
        INSERT INTO cluster_articles (cluster_id, article_id)
        VALUES (:cluster_id, :article_id)
        ON CONFLICT (cluster_id, article_id) DO NOTHING
        """,
        edge_params,
    )


def upsert_pitches(pitches: list[dict]) -> None:
    """pitches: [{id, title, body, beat, cluster_id}, ...]"""
    if not pitches:
        return
    param_sets = [
        [
            {"name": "id",         "value": {"stringValue": p["id"]}},
            {"name": "title",      "value": {"stringValue": p["title"]}},
            {"name": "body",       "value": {"stringValue": p["body"]}},
            {"name": "beat",       "value": {"stringValue": p.get("beat", "")}},
            {"name": "cluster_id", "value": {"stringValue": p["cluster_id"]}},
        ]
        for p in pitches
    ]
    aurora.execute_many(
        """
        INSERT INTO pitches (id, title, body, beat, cluster_id)
        VALUES (:id, :title, :body, :beat, :cluster_id)
        ON CONFLICT (id) DO UPDATE
          SET title = EXCLUDED.title,
              body = EXCLUDED.body,
              beat = EXCLUDED.beat,
              cluster_id = EXCLUDED.cluster_id,
              updated_at = NOW()
        """,
        param_sets,
    )


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
    bedrock_agent = boto3.client("bedrock-agent", region_name=CONFIG.region)
    resp = bedrock_agent.start_ingestion_job(knowledgeBaseId=kb_id, dataSourceId=ds_id)
    job_id = resp["ingestionJob"]["ingestionJobId"]
    log.info("KB ingestion job started: %s", job_id)
    return job_id
