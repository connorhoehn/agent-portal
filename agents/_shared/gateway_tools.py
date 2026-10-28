"""
gateway_tools.py — the MCP client for the AgentCore gateway (DE-7).

Off unless ``GATEWAY_TOOLS=1``. The gateway speaks MCP over HTTP with SigV4
(``authorizerType: AWS_IAM``), so this posts JSON-RPC (``tools/list``,
``tools/call``) to ``GATEWAY_URL`` and signs with the runtime's own credentials,
which are the execution role the Cedar policies name. A denial by the policy
engine comes back as a JSON-RPC error and is raised as ``GatewayError``.

The transport is injectable (``post``) so tests need no network or AWS.
"""
from __future__ import annotations

import json
import os
from typing import Any, Callable, Dict, List, Optional

SERVICE = "bedrock-agentcore"

Post = Callable[[str, Dict[str, Any]], Dict[str, Any]]


class GatewayError(RuntimeError):
    pass


def enabled() -> bool:
    return os.environ.get("GATEWAY_TOOLS") == "1" and bool(os.environ.get("GATEWAY_URL"))


def _sigv4_post(url: str, payload: Dict[str, Any]) -> Dict[str, Any]:  # pragma: no cover - needs AWS
    import urllib.request

    import botocore.session
    from botocore.auth import SigV4Auth
    from botocore.awsrequest import AWSRequest

    session = botocore.session.get_session()
    region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
    body = json.dumps(payload).encode()
    request = AWSRequest(method="POST", url=url, data=body,
                         headers={"Content-Type": "application/json", "Accept": "application/json"})
    SigV4Auth(session.get_credentials().get_frozen_credentials(), SERVICE, region).add_auth(request)
    with urllib.request.urlopen(urllib.request.Request(
            url, data=body, headers=dict(request.headers.items()), method="POST"), timeout=30) as res:
        return json.loads(res.read())


class GatewayClient:
    def __init__(self, url: Optional[str] = None, post: Optional[Post] = None):
        self.url = url or os.environ.get("GATEWAY_URL", "")
        if not self.url:
            raise GatewayError("GATEWAY_URL is not set")
        self._post = post or _sigv4_post
        self._id = 0

    def _rpc(self, method: str, params: Dict[str, Any]) -> Any:
        self._id += 1
        reply = self._post(self.url, {"jsonrpc": "2.0", "id": self._id, "method": method, "params": params})
        if reply.get("error"):
            raise GatewayError(f"{method}: {reply['error'].get('message', reply['error'])}")
        return reply.get("result", {})

    def list_tools(self) -> List[Dict[str, Any]]:
        tools: List[Dict[str, Any]] = []
        params: Dict[str, Any] = {}
        while True:
            result = self._rpc("tools/list", params)
            tools.extend(result.get("tools", []))
            cursor = result.get("nextCursor")
            if not cursor:
                return tools
            params = {"cursor": cursor}

    def call_tool(self, name: str, arguments: Dict[str, Any]) -> str:
        result = self._rpc("tools/call", {"name": name, "arguments": arguments})
        text = "\n".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")
        if result.get("isError"):
            raise GatewayError(text or f"{name} failed")
        return text


def tool_specs(client: GatewayClient) -> List[Dict[str, Any]]:
    """Strands ToolSpec dicts for every tool the gateway lists to this caller."""
    return [{"name": t["name"], "description": t.get("description", ""),
             "inputSchema": {"json": t.get("inputSchema", {"type": "object", "properties": {}})}}
            for t in client.list_tools()]


def strands_tools(client: Optional[GatewayClient] = None) -> List[Any]:
    """Gateway tools as Strands tools; an empty list when the flag is off."""
    if client is None:
        if not enabled():
            return []
        client = GatewayClient()
    from strands.tools.tools import PythonAgentTool  # imported lazily: agents only

    def make(spec: Dict[str, Any]) -> Any:
        def run(tool_use: Dict[str, Any], **_: Any) -> Dict[str, Any]:
            try:
                text = client.call_tool(spec["name"], tool_use.get("input", {}))
                status = "success"
            except GatewayError as exc:
                text, status = str(exc), "error"
            return {"toolUseId": tool_use["toolUseId"], "status": status, "content": [{"text": text}]}
        return PythonAgentTool(spec["name"], spec, run)

    return [make(s) for s in tool_specs(client)]
