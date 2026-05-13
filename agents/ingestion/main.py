import json
import os

import boto3
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from strands import Agent, tool
from strands.models.bedrock import BedrockModel

# Shared HITL approval tool — used to gate high-stakes ingestion side-effects.
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from _shared.approval_tool import request_approval  # noqa: E402

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
def sync_knowledge_base() -> str:
    """Trigger an ingestion job to sync the S3 documents bucket into the Bedrock Knowledge Base.

    This re-indexes all new or changed documents. Runs asynchronously — check status
    with check_ingestion_status using the returned job_id.

    Returns:
        JSON with {job_id, status, knowledge_base_id, data_source_id}
    """
    data_source_id = _get_data_source_id()
    response = _bedrock_agent.start_ingestion_job(
        knowledgeBaseId=KB_ID,
        dataSourceId=data_source_id,
        description="Triggered by OrgIQ Ingestion Agent",
    )
    job = response["ingestionJob"]
    return json.dumps({
        "job_id": job["ingestionJobId"],
        "status": job["status"],
        "knowledge_base_id": KB_ID,
        "data_source_id": data_source_id,
        "started_at": job.get("startedAt", "").isoformat() if hasattr(job.get("startedAt", ""), "isoformat") else str(job.get("startedAt", "")),
    })


@tool
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


_model = BedrockModel(**_model_kwargs())
_agent = Agent(
    model=_model,
    tools=[list_documents, read_document, sync_knowledge_base, check_ingestion_status, extract_entities_preview, request_approval],
    system_prompt=(
        "You are the OrgIQ Ingestion agent. Process organizational documents into the knowledge base.\n\n"
        "Supported formats: PDF, DOCX, Markdown, HTML, plain text, JSON (Jira/Confluence exports).\n\n"
        "Standard workflow:\n"
        "1. list_documents — see what's available for ingestion\n"
        "2. read_document — inspect content for text files\n"
        "3. extract_entities_preview — verify entities before committing\n"
        "4. sync_knowledge_base — trigger Bedrock KB ingestion job\n"
        "5. check_ingestion_status — monitor progress\n\n"
        "After sync, the graph-builder agent handles entity extraction and graph construction."
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

    result = _agent(input_text)
    return {"agent": "ingestion", "response": str(result)}


if __name__ == "__main__":
    app.run()
