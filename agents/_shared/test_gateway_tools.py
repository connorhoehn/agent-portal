"""The gateway MCP client against a stubbed endpoint: no network, no AWS, no strands."""
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import gateway_tools  # noqa: E402

TOOLS = [
    {"name": "orgiq-kb-query___knowledge-base-query", "description": "Query the KB",
     "inputSchema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
    {"name": "orgiq-graph-traversal___graph-traversal", "description": "Read-only SQL"},
]


class Endpoint:
    """A stub MCP endpoint that pages tools/list and denies one tool."""

    def __init__(self):
        self.calls = []

    def __call__(self, url, payload):
        self.calls.append((url, payload))
        method, params = payload["method"], payload["params"]
        if method == "tools/list":
            if params.get("cursor") == "p2":
                return {"result": {"tools": TOOLS[1:]}}
            return {"result": {"tools": TOOLS[:1], "nextCursor": "p2"}}
        if params["name"].startswith("orgiq-graph"):
            return {"error": {"code": -32002, "message": "denied by policy"}}
        return {"result": {"content": [{"type": "text", "text": f"hits for {params['arguments']['query']}"}]}}


class GatewayToolsTests(unittest.TestCase):
    def test_lists_tools_across_pages_and_maps_them_to_tool_specs(self):
        endpoint = Endpoint()
        client = gateway_tools.GatewayClient("https://gw.example/mcp", post=endpoint)
        specs = gateway_tools.tool_specs(client)
        self.assertEqual([s["name"] for s in specs],
                         ["orgiq-kb-query___knowledge-base-query", "orgiq-graph-traversal___graph-traversal"])
        self.assertEqual(specs[0]["inputSchema"]["json"]["required"], ["query"])
        self.assertEqual(specs[1]["inputSchema"]["json"], {"type": "object", "properties": {}})
        self.assertEqual({c[0] for c in endpoint.calls}, {"https://gw.example/mcp"})
        self.assertEqual(len(endpoint.calls), 2)

    def test_call_returns_text_and_policy_denial_raises(self):
        client = gateway_tools.GatewayClient("https://gw.example/mcp", post=Endpoint())
        self.assertEqual(client.call_tool("orgiq-kb-query___knowledge-base-query", {"query": "okrs"}), "hits for okrs")
        with self.assertRaisesRegex(gateway_tools.GatewayError, "denied by policy"):
            client.call_tool("orgiq-graph-traversal___graph-traversal", {"query": "x"})

    def test_off_by_default(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(gateway_tools.enabled())
            self.assertEqual(gateway_tools.strands_tools(), [])
        with patch.dict(os.environ, {"GATEWAY_TOOLS": "1", "GATEWAY_URL": "https://gw"}, clear=True):
            self.assertTrue(gateway_tools.enabled())


if __name__ == "__main__":
    unittest.main()
