import json
import logging
import os
import time
from contextvars import ContextVar

import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent, tool
from strands.models.bedrock import BedrockModel

# Shared HITL approval tool — used to gate high-stakes ingestion side-effects.
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from _shared.approval_tool import request_approval  # noqa: E402
from _shared.kb_resolver import resolve_kb_id_by_slug as _resolve_kb_id_by_slug  # noqa: E402
from _shared.prompt_source import LiveAgent
from _shared.instrumentation import (  # noqa: E402
    TraceContext,
    install_bedrock_usage_capture,
    instrumented_tool,
    post_trace,
    reset_active_ctx,
    set_active_ctx,
    short_prompt_hash,
    with_orgiq_root,
)

# Patch boto3's bedrock-runtime client BEFORE Strands constructs its own —
# otherwise Converse usage is invisible to our TraceContext.
install_bedrock_usage_capture()

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

# Per-invocation trace buffer (see supervisor/main.py for the design note).
_current_ctx: ContextVar[TraceContext | None] = ContextVar(
    "ingestion_trace_ctx", default=None
)

app = BedrockAgentCoreApp()

REGION = os.environ.get("AWS_REGION", "us-east-1")
KB_ID = os.environ.get("KB_ID", "")
MODEL_ID = os.environ.get("MODEL_ID", "amazon.nova-pro-v1:0")
PREFIX = os.environ.get("PROJECT_PREFIX", "orgiq")

_s3 = boto3.client("s3", region_name=REGION)
_bedrock_agent = boto3.client("bedrock-agent", region_name=REGION)
_bedrock_runtime = boto3.client("bedrock-runtime", region_name=REGION)

# Documents bucket follows naming convention from foundation stack
def _documents_bucket() -> str:
    account = boto3.client("sts").get_caller_identity()["Account"]
    return f"{PREFIX}-documents-{account}-{REGION}"


def _get_data_source_id() -> str:
    """Look up the first S3 data source for the knowledge base."""
    response = _bedrock_agent.list_data_sources(knowledgeBaseId=KB_ID)
    sources = response.get("dataSourceSummaries", [])
    if not sources:
        raise RuntimeError(f"No data sources found for knowledge base {KB_ID}")
    return sources[0]["dataSourceId"]


@tool
@instrumented_tool(_current_ctx.get)
def list_documents(prefix: str = "") -> str:
    """List documents available in the S3 documents bucket for ingestion.

    Args:
        prefix: S3 key prefix to filter results (optional, e.g. 'transcripts/', 'wikis/')

    Returns:
        JSON list of {key, size, last_modified} for each object
    """
    bucket = _documents_bucket()
    kwargs = {"Bucket": bucket, "MaxKeys": 100}
    if prefix:
        kwargs["Prefix"] = prefix

    response = _s3.list_objects_v2(**kwargs)
    objects = [
        {
            "key": obj["Key"],
            "size_bytes": obj["Size"],
            "last_modified": obj["LastModified"].isoformat(),
        }
        for obj in response.get("Contents", [])
        if not obj["Key"].endswith("/")
    ]
    return json.dumps({"bucket": bucket, "count": len(objects), "objects": objects})


@tool
@instrumented_tool(_current_ctx.get)
def read_document(key: str) -> str:
    """Read the content of a document from the S3 documents bucket.

    Supports text-based formats (txt, md, html, json). For binary formats (PDF, DOCX),
    returns metadata only — Bedrock KB handles binary extraction during sync.

    Args:
        key: S3 object key (e.g. 'transcripts/eng-all-hands-2024-03.txt')

    Returns:
        Document content as a string (truncated to 50KB for LLM processing)
    """
    bucket = _documents_bucket()
    response = _s3.get_object(Bucket=bucket, Key=key)
    content_type = response.get("ContentType", "")

    binary_types = {"application/pdf", "application/vnd.openxmlformats"}
    if any(b in content_type for b in binary_types) or key.lower().endswith((".pdf", ".docx")):
        return json.dumps({
            "key": key,
            "content_type": content_type,
            "size_bytes": response["ContentLength"],
            "note": "Binary format — content extracted by Bedrock KB during sync",
        })

    raw = response["Body"].read()
    text = raw[:51200].decode("utf-8", errors="replace")  # 50KB cap
    return json.dumps({"key": key, "content_type": content_type, "content": text})


@tool
@instrumented_tool(_current_ctx.get)
def sync_knowledge_base(kb_slug: str = "default") -> str:
    """Trigger a Bedrock Knowledge Base ingestion job.

    Args:
        kb_slug: Registry slug of the KB to sync (default: "default" = main OrgIQ KB).

    Returns:
        JSON with {job_id, status, knowledge_base_id, data_source_id}
    """
    # Resolve KB ID and data source ID from registry when a non-default slug is requested.
    resolved_kb_id = KB_ID  # module-level default
    resolved_ds_id = None  # will be looked up below
    if kb_slug != "default":
        resolved_kb_id = _resolve_kb_id_by_slug(kb_slug) or KB_ID
    # Re-resolve data source for whichever KB we landed on.
    if resolved_kb_id != KB_ID or resolved_ds_id is None:
        def _get_ds_for(kb_id: str) -> str:
            response = _bedrock_agent.list_data_sources(knowledgeBaseId=kb_id)
            sources = response.get("dataSourceSummaries", [])
            if not sources:
                raise RuntimeError(f"No data sources found for knowledge base {kb_id}")
            return sources[0]["dataSourceId"]
        resolved_ds_id = _get_ds_for(resolved_kb_id)
    else:
        resolved_ds_id = _get_data_source_id()

    data_source_id = resolved_ds_id
    response = _bedrock_agent.start_ingestion_job(
        knowledgeBaseId=resolved_kb_id,
        dataSourceId=data_source_id,
        description="Triggered by OrgIQ Ingestion Agent",
    )
    job = response["ingestionJob"]
    return json.dumps({
        "job_id": job["ingestionJobId"],
        "status": job["status"],
        "knowledge_base_id": resolved_kb_id,
        "data_source_id": data_source_id,
        "started_at": job.get("startedAt", "").isoformat() if hasattr(job.get("startedAt", ""), "isoformat") else str(job.get("startedAt", "")),
    })


@tool
@instrumented_tool(_current_ctx.get)
def check_ingestion_status(job_id: str) -> str:
    """Check the status of a Bedrock Knowledge Base ingestion job.

    Args:
        job_id: Ingestion job ID returned by sync_knowledge_base

    Returns:
        JSON with {status, statistics, failure_reasons} where status is one of:
        STARTING, IN_PROGRESS, COMPLETE, FAILED, STOPPING, STOPPED
    """
    data_source_id = _get_data_source_id()
    response = _bedrock_agent.get_ingestion_job(
        knowledgeBaseId=KB_ID,
        dataSourceId=data_source_id,
        ingestionJobId=job_id,
    )
    job = response["ingestionJob"]
    stats = job.get("statistics", {})
    return json.dumps({
        "status": job["status"],
        "statistics": {
            "scanned": stats.get("numberOfDocumentsScanned", 0),
            "indexed": stats.get("numberOfNewDocumentsIndexed", 0),
            "updated": stats.get("numberOfModifiedDocumentsIndexed", 0),
            "deleted": stats.get("numberOfDocumentsDeleted", 0),
            "failed": stats.get("numberOfDocumentsFailed", 0),
        },
        "failure_reasons": job.get("failureReasons", []),
    })


@tool
@instrumented_tool(_current_ctx.get)
def extract_entities_preview(text: str) -> str:
    """Use Bedrock to preview what entities would be extracted from a document.

    This is a dry-run NER pass — the actual extraction for the graph happens in
    the graph-builder agent. Use this to verify document quality before ingestion.

    Args:
        text: Document text to analyze (max 10,000 characters)

    Returns:
        JSON with extracted {people, teams, skills, decisions, projects}
    """
    prompt = f"""Extract organizational entities from this text. Return ONLY valid JSON.

Text:
{text[:10000]}

Return JSON with these keys:
- people: list of {{name, role, team}} objects
- teams: list of team names
- skills: list of technical skills or domains mentioned
- decisions: list of {{title, summary}} for key decisions
- projects: list of project names

JSON:"""

    response = _bedrock_runtime.invoke_model(
        modelId=MODEL_ID,
        body=json.dumps({
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 1024,
            "anthropic_version": "bedrock-2023-05-31",
        }),
        contentType="application/json",
    )
    raw = json.loads(response["body"].read())
    content = raw.get("content", [{}])[0].get("text", "{}")

    # Extract JSON from response
    start = content.find("{")
    end = content.rfind("}") + 1
    if start >= 0 and end > start:
        try:
            return content[start:end]
        except Exception:
            pass
    return content


def _model_kwargs() -> dict:
    kw: dict = {"model_id": MODEL_ID}
    gid = os.environ.get("GUARDRAIL_ID", "")
    if gid:
        kw["guardrail_id"] = gid
        kw["guardrail_version"] = os.environ.get("GUARDRAIL_VERSION", "DRAFT")
        kw["guardrail_trace"] = "enabled"
    return kw


SYSTEM_PROMPT = (
    "You are the OrgIQ Ingestion agent. Process organizational documents into the knowledge base.\n\n"
    "Supported formats: PDF, DOCX, Markdown, HTML, plain text, JSON (Jira/Confluence exports).\n\n"
    "Standard workflow:\n"
    "1. list_documents — see what's available for ingestion\n"
    "2. read_document — inspect content for text files\n"
    "3. extract_entities_preview — verify entities before committing\n"
    "4. sync_knowledge_base — trigger Bedrock KB ingestion job\n"
    "5. check_ingestion_status — monitor progress\n\n"
    "After sync, the graph-builder agent handles entity extraction and graph construction."
)

_SYSTEM_PROMPT_SHA = short_prompt_hash(SYSTEM_PROMPT)

_model = BedrockModel(**_model_kwargs())
# System prompt is resolved from Bedrock Prompt Management at run time
# (falls back to the SYSTEM_PROMPT literal above). Editing the managed
# prompt `orgiq-ingestion-system-prompt` changes this agent within
# PROMPT_REFRESH_S — no image rebuild, no redeploy.
_agent = LiveAgent(
    baked=SYSTEM_PROMPT,
    agent_name="ingestion",
    build=lambda system_prompt: Agent(
        model=_model,
        tools=[list_documents, read_document, sync_knowledge_base, check_ingestion_status, extract_entities_preview, request_approval],
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
        return {"agent": "ingestion", "error": "missing input_text/prompt/message"}

    # ── Sprint 2 instrumentation ─────────────────────────────────────────────
    # Picks up ``parentInvocationId`` when the supervisor invoked us via A2A.
    ctx = TraceContext.from_request_payload(payload if isinstance(payload, dict) else {})
    token = _current_ctx.set(ctx)
    shared_token = set_active_ctx(ctx)

    log.info(
        "Ingestion handling (invocation=%s, parent=%s): %s",
        ctx.invocation_id, ctx.parent_invocation_id or "—", input_text[:120],
    )

    with with_orgiq_root(
        ctx,
        agent_id="orgiq-ingestion",
        agent_name="Ingestion",
        prompt_version=_agent.prompt_sha,
    ) as oi_span:
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
                agent_id="orgiq-ingestion",
                agent_name="Ingestion",
                model_id=MODEL_ID,
                duration_ms=duration_ms,
                prompt_version=_agent.prompt_sha,
            )
            post_trace(bundle)
        except Exception as exc:  # noqa: BLE001
            log.warning("ingestion: trace emission failed: %s", exc)

    return {
        "agent": "ingestion",
        "response": response_text,
        "invocationId": ctx.invocation_id,
        "toolCalls": ctx.project_tool_calls(),
    }


if __name__ == "__main__":
    app.run()
