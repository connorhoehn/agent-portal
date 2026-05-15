"""Thin Bedrock Converse wrapper for schema-constrained generation.

We force the model to call a single tool whose input schema matches the
desired Pydantic model — the tool input IS the output. This is the
AWS-native equivalent of OpenAI structured outputs and works on Nova-Pro
and Nova-Lite via the Converse API.
"""
from __future__ import annotations

import json
from functools import lru_cache
from typing import Any

import boto3
from pydantic import BaseModel, ValidationError

from . import cost
from .config import CONFIG, NOVA_PRO


@lru_cache(maxsize=1)
def _client():
    return boto3.client("bedrock-runtime", region_name=CONFIG.region)


def _inline_refs(schema: dict) -> dict:
    """Inline every $ref against the schema's own $defs so the result has no
    references — Nova's toolConfig parser dislikes the indirection."""
    defs = schema.get("$defs", {}) or schema.get("definitions", {}) or {}

    def walk(node):
        if isinstance(node, dict):
            if "$ref" in node and len(node) == 1:
                key = node["$ref"].split("/")[-1]
                return walk(defs.get(key, {}))
            return {k: walk(v) for k, v in node.items()}
        if isinstance(node, list):
            return [walk(x) for x in node]
        return node
    return walk(schema)


def _strip_unsupported(schema: dict) -> dict:
    """Bedrock toolConfig schemas don't accept some JSON Schema keywords."""
    drop = {"$defs", "definitions", "title"}
    if isinstance(schema, dict):
        return {k: _strip_unsupported(v) for k, v in schema.items() if k not in drop}
    if isinstance(schema, list):
        return [_strip_unsupported(x) for x in schema]
    return schema


def converse_with_schema(
    output_model: type[BaseModel],
    system: str,
    user_prompt: str,
    *,
    model_id: str = NOVA_PRO,
    temperature: float = 0.4,
    max_tokens: int = 4096,
    tool_name: str = "emit",
    tool_description: str = "Emit the structured artifact.",
) -> BaseModel:
    """Call Converse forcing the model to emit JSON matching `output_model`.

    Returns a validated instance of output_model. Raises ValidationError on
    malformed output (caller decides whether to retry).
    """
    schema = _strip_unsupported(_inline_refs(output_model.model_json_schema()))
    tool_spec = {
        "toolSpec": {
            "name": tool_name,
            "description": tool_description,
            "inputSchema": {"json": schema},
        }
    }
    resp = _client().converse(
        modelId=model_id,
        system=[{"text": system}],
        messages=[{"role": "user", "content": [{"text": user_prompt}]}],
        toolConfig={
            "tools": [tool_spec],
            "toolChoice": {"tool": {"name": tool_name}},
        },
        inferenceConfig={
            "temperature": temperature,
            "maxTokens": max_tokens,
        },
    )
    usage = resp.get("usage") or {}
    cost.record(model_id, usage.get("inputTokens", 0), usage.get("outputTokens", 0))
    payload = _extract_tool_input(resp, tool_name)
    return output_model.model_validate(payload)


def _extract_tool_input(resp: dict, tool_name: str) -> dict:
    for block in resp.get("output", {}).get("message", {}).get("content", []):
        if "toolUse" in block and block["toolUse"].get("name") == tool_name:
            return block["toolUse"].get("input") or {}
    raise RuntimeError(
        f"Converse response had no toolUse block for {tool_name!r}; "
        f"stopReason={resp.get('stopReason')!r}"
    )


def embed_text(text: str) -> list[float]:
    """Single Titan-v2 1024d embedding call. Caller is responsible for batching."""
    from .config import TITAN_V2, EMBEDDING_DIM
    resp = _client().invoke_model(
        modelId=TITAN_V2,
        body=json.dumps({"inputText": text, "dimensions": EMBEDDING_DIM, "normalize": True}),
    )
    body = json.loads(resp["body"].read())
    cost.record(TITAN_V2, body.get("inputTextTokenCount", 0), 0)
    return body["embedding"]
