import datetime as _dt
import json
import logging
import os
import sys
import time
from contextvars import ContextVar
from pathlib import Path

import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent, tool
from strands.models.bedrock import BedrockModel

# Shared instrumentation — pull TraceContext + decorator from agents/_shared.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from _shared.kb_resolver import resolve_kb_id as _resolve_kb_id  # noqa: E402
from _shared.prompt_source import LiveAgent
from _shared.instrumentation import (  # noqa: E402
    TraceContext,
    install_bedrock_usage_capture,
    instrumented_tool,
    post_trace,
    reset_active_ctx,
    set_active_ctx,
    short_prompt_hash,
)

# Patch boto3's bedrock-runtime client BEFORE Strands constructs its own —
# otherwise Converse usage is invisible to our TraceContext.
install_bedrock_usage_capture()

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

# Per-invocation trace buffer.
_current_ctx: ContextVar[TraceContext | None] = ContextVar(
    "news_researcher_trace_ctx", default=None
)

app = BedrockAgentCoreApp()

REGION = os.environ.get("AWS_REGION", "us-east-1")
KB_ID: str = _resolve_kb_id("newsroom", "articles") or ""
AURORA_CLUSTER_ARN = os.environ.get("AURORA_CLUSTER_ARN", "")
AURORA_SECRET_ARN = os.environ.get("AURORA_SECRET_ARN", "")
AURORA_DATABASE = os.environ.get("AURORA_DATABASE", "orgiq")
MODEL_ID = os.environ.get("MODEL_ID", "amazon.nova-pro-v1:0")

_bedrock = boto3.client("bedrock-agent-runtime", region_name=REGION)
_rds = boto3.client("rds-data", region_name=REGION)

_DOCUMENTS_BUCKET = os.environ.get("DOCUMENTS_BUCKET", "")
_s3_client = boto3.client("s3", region_name=REGION) if _DOCUMENTS_BUCKET else None

def _archive_article_to_s3(url: str, content: str, metadata: dict | None = None) -> None:
    """Push a fetched article to the newsroom/ S3 landing zone for KB ingestion.

    Only runs when DOCUMENTS_BUCKET env var is set. Safe to call even in
    environments without S3 access — failures are logged but not raised.
    """
    if not _s3_client or not _DOCUMENTS_BUCKET:
        return
    try:
        # Sanitize URL for use as S3 key segment
        safe_url = "".join(c if c.isalnum() or c in "-_." else "_" for c in url.replace("://", "_").replace("/", "_"))[:80]
        date_str = _dt.datetime.utcnow().strftime("%Y-%m-%d")
        key = f"newsroom/{date_str}/{safe_url}.txt"

        meta: dict[str, str] = {
            "source-url": url[:512],
            "archived-at": _dt.datetime.utcnow().isoformat(),
        }
        if metadata:
            # Merge extra metadata, truncating values to 256 chars (S3 metadata limit)
            for k, v in metadata.items():
                if isinstance(v, str):
                    meta[str(k)[:128]] = v[:256]

        _s3_client.put_object(
            Bucket=_DOCUMENTS_BUCKET,
            Key=key,
            Body=content.encode("utf-8"),
            ContentType="text/plain",
            Metadata=meta,
        )
        log.info("[news-researcher] Archived article to s3://%s/%s", _DOCUMENTS_BUCKET, key)
    except Exception as e:
        log.warning("[news-researcher] S3 archive failed for %s: %s", url, e)


def _records_to_dicts(resp: dict) -> list:
    """Convert RDS Data API response records to a list of dicts keyed by column name."""
    cols = [c.get("name", f"col{i}") for i, c in enumerate(resp.get("columnMetadata", []))]
    out = []
    for record in resp.get("records", []):
        row = {}
        for col, cell in zip(cols, record):
            row[col] = list(cell.values())[0] if cell else None
        out.append(row)
    return out


# TODO: call _archive_article_to_s3(url, content) from any future fetch_article or
# research_topic tool that fetches live article content. search_archive is a
# retrieval-only tool so archiving is intentionally skipped here.
@tool
@instrumented_tool(_current_ctx.get)
def search_archive(query: str, max_results: int = 5) -> str:
    """Search the news archive knowledge base for related coverage.

    Uses semantic (vector) retrieval over the Bedrock Knowledge Base that indexes
    ingested articles, documents, and source material.

    Args:
        query: Natural-language search query describing the story angle or topic.
        max_results: Number of results to return (default 5, max 20).

    Returns:
        JSON array of [{content, score, source}] ranked by relevance.
    """
    if not KB_ID:
        return json.dumps({"error": "KB_ID env var missing — knowledge base unavailable"})

    try:
        response = _bedrock.retrieve(
            knowledgeBaseId=KB_ID,
            retrievalQuery={"text": query},
            retrievalConfiguration={
                "vectorSearchConfiguration": {"numberOfResults": min(max_results, 20)}
            },
        )
        results = [
            {
                "content": r["content"]["text"],
                "score": round(r.get("score", 0.0), 4),
                "source": r.get("location", {}).get("s3Location", {}).get("uri", "unknown"),
            }
            for r in response.get("retrievalResults", [])
        ]
        return json.dumps(results, ensure_ascii=False)
    except Exception as exc:
        log.warning("search_archive failed: %s", exc)
        return json.dumps({"error": f"KB retrieval error: {exc}"})


@tool
@instrumented_tool(_current_ctx.get)
def find_entities_in_articles(article_ids: list) -> str:
    """Find named entities (people, orgs, places) mentioned in the given articles.

    Joins article_entities with entities in the Aurora newsroom schema. Safe to
    call even when the newsroom tables are empty — returns an empty list.

    Args:
        article_ids: List of article/document IDs (strings) to look up.

    Returns:
        JSON array of [{entityId, name, entityType, salience}].
    """
    if not article_ids:
        return json.dumps([])
    if not AURORA_CLUSTER_ARN or not AURORA_SECRET_ARN:
        return json.dumps({"error": "Aurora env vars missing"})

    # Build a safe parameterised IN clause.
    placeholders = ", ".join([f":id{i}" for i in range(len(article_ids))])
    sql = (
        f"SELECT ae.entity_id AS \"entityId\", "
        f"       e.name, "
        f"       e.entity_type AS \"entityType\", "
        f"       ae.salience "
        f"FROM article_entities ae "
        f"JOIN entities e ON e.id = ae.entity_id "
        f"WHERE ae.article_id IN ({placeholders}) "
        f"ORDER BY ae.salience DESC"
    )
    params = [
        {"name": f"id{i}", "value": {"stringValue": str(aid)}}
        for i, aid in enumerate(article_ids)
    ]

    try:
        response = _rds.execute_statement(
            resourceArn=AURORA_CLUSTER_ARN,
            secretArn=AURORA_SECRET_ARN,
            database=AURORA_DATABASE,
            sql=sql,
            parameters=params,
            includeResultMetadata=True,
        )
        return json.dumps(_records_to_dicts(response), ensure_ascii=False, default=str)
    except Exception as exc:
        log.warning("find_entities_in_articles failed: %s", exc)
        return json.dumps({"error": f"Aurora query error: {exc}"})


@tool
@instrumented_tool(_current_ctx.get)
def find_co_mentions(entity_id: str, limit: int = 10) -> str:
    """Find entities that most frequently co-appear with the given entity across articles.

    Uses the article_entities join table to count shared article appearances.
    Safe to call even when the newsroom tables are empty — returns an empty list.

    Args:
        entity_id: The entity ID to find co-mentions for.
        limit: Maximum number of co-mentioned entities to return (default 10).

    Returns:
        JSON array of [{entityId, name, entityType, sharedArticleCount}] sorted
        by sharedArticleCount descending.
    """
    if not entity_id:
        return json.dumps([])
    if not AURORA_CLUSTER_ARN or not AURORA_SECRET_ARN:
        return json.dumps({"error": "Aurora env vars missing"})

    sql = (
        "SELECT other.entity_id AS \"entityId\", "
        "       e.name, "
        "       e.entity_type AS \"entityType\", "
        "       COUNT(*) AS \"sharedArticleCount\" "
        "FROM article_entities ref "
        "JOIN article_entities other "
        "  ON other.article_id = ref.article_id "
        " AND other.entity_id  != ref.entity_id "
        "JOIN entities e ON e.id = other.entity_id "
        "WHERE ref.entity_id = :entity_id "
        "GROUP BY other.entity_id, e.name, e.entity_type "
        "ORDER BY \"sharedArticleCount\" DESC "
        f"LIMIT {min(abs(limit), 50)}"
    )
    params = [{"name": "entity_id", "value": {"stringValue": str(entity_id)}}]

    try:
        response = _rds.execute_statement(
            resourceArn=AURORA_CLUSTER_ARN,
            secretArn=AURORA_SECRET_ARN,
            database=AURORA_DATABASE,
            sql=sql,
            parameters=params,
            includeResultMetadata=True,
        )
        return json.dumps(_records_to_dicts(response), ensure_ascii=False, default=str)
    except Exception as exc:
        log.warning("find_co_mentions failed: %s", exc)
        return json.dumps({"error": f"Aurora query error: {exc}"})


def _model_kwargs() -> dict:
    kw: dict = {"model_id": MODEL_ID}
    gid = os.environ.get("GUARDRAIL_ID", "")
    if gid:
        kw["guardrail_id"] = gid
        kw["guardrail_version"] = os.environ.get("GUARDRAIL_VERSION", "DRAFT")
        kw["guardrail_trace"] = "enabled"
    return kw


SYSTEM_PROMPT = (
    "You are the OrgIQ News Researcher agent — a story-research assistant for journalists "
    "and editors in the OrgIQ newsroom.\n\n"
    "Your job is to produce a structured research brief on any topic or emerging story:\n"
    "1. First call search_archive to find related coverage in the archive. Use the returned "
    "   article sources as evidence. Note the score to gauge relevance.\n"
    "2. Extract article IDs from the search results (the source URI usually contains the ID) "
    "   and call find_entities_in_articles to identify the key people, organisations, and "
    "   places mentioned. Highlight entities with the highest salience.\n"
    "3. For the top 1-2 entities, call find_co_mentions to surface which other actors "
    "   frequently appear alongside them — these co-occurrence patterns suggest story angles.\n\n"
    "Always structure your brief as:\n"
    "  ## Related Coverage\n"
    "  (list articles with sources cited inline)\n\n"
    "  ## Key Entities\n"
    "  (table or list of top people / orgs / places and their salience)\n\n"
    "  ## Suggested Angles\n"
    "  (3-5 specific, actionable story ideas derived from co-mention patterns and coverage gaps)\n\n"
    "Always cite sources. Be concise but specific — journalists need leads, not summaries."
)

_SYSTEM_PROMPT_SHA = short_prompt_hash(SYSTEM_PROMPT)

_model = BedrockModel(**_model_kwargs())
# System prompt is resolved from Bedrock Prompt Management at run time
# (falls back to the SYSTEM_PROMPT literal above). Editing the managed
# prompt `orgiq-news-researcher-system-prompt` changes this agent within
# PROMPT_REFRESH_S — no image rebuild, no redeploy.
_agent = LiveAgent(
    baked=SYSTEM_PROMPT,
    agent_name="news-researcher",
    build=lambda system_prompt: Agent(
        model=_model,
        tools=[search_archive, find_entities_in_articles, find_co_mentions],
        system_prompt=system_prompt,
    ),
)


@app.entrypoint
async def handle(payload: dict) -> dict:
    if isinstance(payload, dict):
        input_text = (
            payload.get("input_text")
            or payload.get("prompt")
            or payload.get("message")
            or ""
        )
    else:
        input_text = str(payload)

    if not input_text:
        return {"agent": "news-researcher", "error": "missing input_text/prompt/message"}

    ctx = TraceContext.from_request_payload(payload if isinstance(payload, dict) else {})
    token = _current_ctx.set(ctx)
    shared_token = set_active_ctx(ctx)

    log.info(
        "NewsResearcher handling (invocation=%s, parent=%s): %s",
        ctx.invocation_id, ctx.parent_invocation_id or "—", input_text[:120],
    )

    t0 = time.monotonic()
    try:
        result = _agent(input_text)
    finally:
        _current_ctx.reset(token)
        reset_active_ctx(shared_token)
    duration_ms = int((time.monotonic() - t0) * 1000)

    response_text = str(result)

    try:
        bundle = ctx.build_trace_bundle(
            prompt=input_text,
            response=response_text,
            agent_id="orgiq-news-researcher",
            agent_name="NewsResearcher",
            model_id=MODEL_ID,
            duration_ms=duration_ms,
            prompt_version=_agent.prompt_sha,
        )
        post_trace(bundle)
    except Exception as exc:  # noqa: BLE001
        log.warning("news-researcher: trace emission failed: %s", exc)

    return {
        "agent": "news-researcher",
        "response": response_text,
        "invocationId": ctx.invocation_id,
    }


if __name__ == "__main__":
    app.run()
