import json
import logging
import os
import re
import sys
import time
from contextvars import ContextVar
from datetime import datetime, date
from pathlib import Path
from typing import Optional

import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent, tool
from strands.models.bedrock import BedrockModel

# Shared instrumentation — pull TraceContext + decorator from agents/_shared.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
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

# Patch boto3's bedrock-runtime client BEFORE Strands constructs its own.
install_bedrock_usage_capture()

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

# Per-invocation trace buffer.
_current_ctx: ContextVar[TraceContext | None] = ContextVar(
    "news_brief_trace_ctx", default=None
)

app = BedrockAgentCoreApp()

REGION = os.environ.get("AWS_REGION", "us-east-1")
AURORA_CLUSTER_ARN = os.environ.get("AURORA_CLUSTER_ARN", "")
AURORA_SECRET_ARN = os.environ.get("AURORA_SECRET_ARN", "")
DB_NAME = os.environ.get("PROJECT_PREFIX", "orgiq")
MODEL_ID = os.environ.get("MODEL_ID", "amazon.nova-pro-v1:0")

_rds = boto3.client("rds-data", region_name=REGION)

_READONLY_RE = re.compile(r"^\s*(WITH|SELECT)\b", re.IGNORECASE)

# ISO date pattern YYYY-MM-DD
_ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _records_to_dicts(resp: dict) -> list:
    """Convert RDS Data API response to list of dicts keyed by column name."""
    cols = [c.get("name", f"col{i}") for i, c in enumerate(resp.get("columnMetadata", []))]
    out = []
    for record in resp.get("records", []):
        row = {}
        for col, cell in zip(cols, record):
            row[col] = list(cell.values())[0] if cell else None
        out.append(row)
    return out


def _to_iso_date(s: str) -> str:
    """Validate and normalise a date string to YYYY-MM-DD.

    Raises ValueError if the input cannot be parsed.
    """
    s = s.strip()
    if _ISO_DATE_RE.match(s):
        # Validate it is an actual calendar date.
        datetime.strptime(s, "%Y-%m-%d")
        return s
    # Try a few other common formats.
    for fmt in ("%Y/%m/%d", "%m/%d/%Y", "%d-%m-%Y", "%B %d, %Y"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    raise ValueError(f"Cannot parse date: {s!r}. Expected YYYY-MM-DD.")


def _run_read_sql(sql: str) -> list:
    """Execute a read-only SQL statement via RDS Data API. Returns list of row dicts."""
    if not AURORA_CLUSTER_ARN or not AURORA_SECRET_ARN:
        raise RuntimeError("AURORA_CLUSTER_ARN / AURORA_SECRET_ARN env vars not set")
    resp = _rds.execute_statement(
        resourceArn=AURORA_CLUSTER_ARN,
        secretArn=AURORA_SECRET_ARN,
        database=DB_NAME,
        sql=sql,
        includeResultMetadata=True,
    )
    return _records_to_dicts(resp)


@tool
@instrumented_tool(_current_ctx.get)
def articles_in_window(start_date: str, end_date: str, beat: Optional[str] = None) -> str:
    """Retrieve articles published in a date window, optionally filtered by beat/section.

    Queries the Aurora ``documents`` table (extended with newsroom columns) joined
    to ``people`` for byline information.

    Args:
        start_date: Inclusive start date in YYYY-MM-DD format.
        end_date:   Inclusive end date in YYYY-MM-DD format.
        beat:       Optional section/beat filter (e.g. "Tech", "Business"). Pass
                    None or omit to include all sections.

    Returns:
        JSON array of article records, each with keys: id, headline, section,
        published_at, byline_name, word_count.  Returns an error JSON object on
        any Aurora failure (schema may not be applied yet).
    """
    try:
        start_iso = _to_iso_date(start_date)
        end_iso = _to_iso_date(end_date)
    except ValueError as exc:
        return json.dumps({"error": str(exc)})

    # Defensive SQL — documents may not yet have all newsroom columns.
    # We SELECT only columns expected by the brief spec; if the column doesn't
    # exist Aurora will raise and we surface a helpful message.
    beat_clause = ""
    if beat and beat.strip():
        # Parameterised literals are not available in all RDS Data API versions;
        # sanitise manually (beat is a simple string, not user-supplied SQL).
        safe_beat = beat.strip().replace("'", "''")
        beat_clause = f" AND LOWER(d.section) = LOWER('{safe_beat}')"

    sql = (
        "SELECT d.id, d.headline, d.section, d.published_at, "
        "       d.word_count, p.name AS byline_name "
        "FROM documents d "
        "LEFT JOIN people p ON p.id = d.byline_person_id "
        "WHERE d.doc_type = 'article' "
        f"  AND d.published_at BETWEEN '{start_iso}' AND '{end_iso}'"
        f"{beat_clause} "
        "ORDER BY d.published_at DESC "
        "LIMIT 200"
    )

    try:
        rows = _run_read_sql(sql)
        return json.dumps(rows, ensure_ascii=False, default=str)
    except Exception as exc:  # noqa: BLE001
        log.warning("articles_in_window: Aurora query failed: %s", exc)
        return json.dumps({
            "error": f"Aurora query failed — schema may not be applied yet: {exc}",
            "sql_attempted": sql,
        })


@tool
@instrumented_tool(_current_ctx.get)
def summarize_article(article_id: str) -> str:
    """Retrieve enough detail about a single article to write a 2-3 sentence summary.

    Fetches headline, section, published_at, word_count, byline name, and the
    first 500 characters of the body (if the ``body`` column exists).

    Args:
        article_id: The UUID of the article in the ``documents`` table.

    Returns:
        JSON object with article metadata, or an error object if not found /
        Aurora unavailable.
    """
    safe_id = article_id.strip().replace("'", "''")

    # Primary query — tries to fetch body excerpt.
    sql_with_body = (
        "SELECT d.id, d.headline, d.section, d.published_at, d.word_count, "
        "       LEFT(d.body, 500) AS body_excerpt, p.name AS byline_name "
        "FROM documents d "
        "LEFT JOIN people p ON p.id = d.byline_person_id "
        f"WHERE d.id = '{safe_id}' "
        "LIMIT 1"
    )

    # Fallback — omit body column if it doesn't exist yet.
    sql_no_body = (
        "SELECT d.id, d.headline, d.section, d.published_at, d.word_count, "
        "       p.name AS byline_name "
        "FROM documents d "
        "LEFT JOIN people p ON p.id = d.byline_person_id "
        f"WHERE d.id = '{safe_id}' "
        "LIMIT 1"
    )

    try:
        rows = _run_read_sql(sql_with_body)
    except Exception:
        try:
            rows = _run_read_sql(sql_no_body)
        except Exception as exc:  # noqa: BLE001
            log.warning("summarize_article: Aurora query failed: %s", exc)
            return json.dumps({"error": f"Aurora unavailable: {exc}"})

    if not rows:
        return json.dumps({"error": f"Article {article_id!r} not found"})

    return json.dumps(rows[0], ensure_ascii=False, default=str)


@tool
@instrumented_tool(_current_ctx.get)
def cluster_by_topic(article_ids: list) -> str:
    """Group a list of article IDs by their section/beat.

    This is a naive clustering step that queries the section column for each
    article and groups them.  The agent uses the result as an outline for the
    brief's per-beat sections.

    Args:
        article_ids: List of article UUID strings to cluster.

    Returns:
        JSON object mapping section name → list of article IDs.  Unknown section
        falls back to "General".
    """
    if not article_ids:
        return json.dumps({})

    # Sanitise IDs — accept only UUID-ish strings (hex + hyphens).
    safe_ids = [i.strip() for i in article_ids if re.match(r"^[0-9a-fA-F\-]{8,36}$", str(i).strip())]

    if not safe_ids:
        return json.dumps({"error": "No valid article IDs provided"})

    id_list = ", ".join(f"'{i}'" for i in safe_ids)
    sql = (
        f"SELECT id, COALESCE(section, 'General') AS section "
        f"FROM documents "
        f"WHERE id IN ({id_list})"
    )

    try:
        rows = _run_read_sql(sql)
    except Exception as exc:  # noqa: BLE001
        log.warning("cluster_by_topic: Aurora query failed, falling back to empty: %s", exc)
        # Graceful degradation — return all IDs under a single bucket.
        return json.dumps({"General": safe_ids})

    clusters: dict[str, list[str]] = {}
    returned_ids = {r["id"] for r in rows}
    for row in rows:
        section = row.get("section") or "General"
        clusters.setdefault(section, []).append(row["id"])

    # Any IDs not returned by Aurora (not in DB yet) go to General.
    missing = [i for i in safe_ids if i not in returned_ids]
    if missing:
        clusters.setdefault("General", []).extend(missing)

    return json.dumps(clusters, ensure_ascii=False)


def _model_kwargs() -> dict:
    kw: dict = {"model_id": MODEL_ID}
    gid = os.environ.get("GUARDRAIL_ID", "")
    if gid:
        kw["guardrail_id"] = gid
        kw["guardrail_version"] = os.environ.get("GUARDRAIL_VERSION", "DRAFT")
        kw["guardrail_trace"] = "enabled"
    return kw


SYSTEM_PROMPT = """\
You are the OrgIQ News Brief Synthesizer.  Your job is to produce a polished,
journalist-quality markdown brief that summarises articles published in a given
date window.

WORKFLOW — follow these steps in order:

1. Call articles_in_window(start_date, end_date, beat?) to retrieve the article
   list.  If no articles are found, say so clearly and stop.

2. Call cluster_by_topic(article_ids) with the list of IDs you received.  Use
   the resulting section → [id] map as the outline for the brief.

3. For each article, call summarize_article(article_id) to get headline, byline,
   and body excerpt.  Use this to write a 2-3 sentence summary in your own words.

4. Synthesize the final markdown brief in this structure:

   # Brief: <date range>
   *Generated by OrgIQ News Brief Synthesizer*

   ## <Section / Beat Name>
   ### <Headline>
   *Byline: <name> · <published_at>*
   <2-3 sentence summary>

   (repeat for each article in this section)

   ---
   ## Notable Patterns
   <3-5 bullet observations about themes, prolific authors, coverage gaps,
   or emerging topics across all the articles in this brief>

RULES:
- Use AWS-native reasoning only; do not reference external knowledge.
- If Aurora is unavailable, acknowledge it and synthesize from whatever data
  you received.
- Keep summaries factual and neutral in tone — newsroom style.
- If beat is specified, limit the brief to that section only.
- Always include the "Notable Patterns" closing section, even for a single article.
"""

_SYSTEM_PROMPT_SHA = short_prompt_hash(SYSTEM_PROMPT)

_model = BedrockModel(**_model_kwargs())
# System prompt is resolved from Bedrock Prompt Management at run time
# (falls back to the SYSTEM_PROMPT literal above). Editing the managed
# prompt `orgiq-news-brief-system-prompt` changes this agent within
# PROMPT_REFRESH_S — no image rebuild, no redeploy.
_agent = LiveAgent(
    baked=SYSTEM_PROMPT,
    agent_name="news-brief",
    build=lambda system_prompt: Agent(
        model=_model,
        tools=[articles_in_window, summarize_article, cluster_by_topic],
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
        return {"agent": "news-brief", "error": "missing input_text/prompt/message"}

    ctx = TraceContext.from_request_payload(payload if isinstance(payload, dict) else {})
    token = _current_ctx.set(ctx)
    shared_token = set_active_ctx(ctx)

    log.info(
        "NewsBrief handling (invocation=%s, parent=%s): %s",
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
            agent_id="orgiq-news-brief",
            agent_name="NewsBrief",
            model_id=MODEL_ID,
            duration_ms=duration_ms,
            prompt_version=_agent.prompt_sha,
        )
        post_trace(bundle)
    except Exception as exc:  # noqa: BLE001
        log.warning("news-brief: trace emission failed: %s", exc)

    return {
        "agent": "news-brief",
        "response": response_text,
        "invocationId": ctx.invocation_id,
    }


if __name__ == "__main__":
    app.run()
