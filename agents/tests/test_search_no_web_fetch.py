"""The search agent holds the org graph and the knowledge base, so it must not
also hold a way to send data to an arbitrary URL.

A document in the KB is untrusted text the model reads. With a web-fetch tool
beside ``query_graph`` and ``query_knowledge_base``, a planted instruction can
turn "fetch this page" into an exfiltration channel. The tool was removed; this
pins that it stays removed, in the built agent and in the fallback prompt.

Run:  cd agents/tests && python -m unittest test_search_no_web_fetch
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_harness import load_agent  # noqa: E402


class SearchAgentHasNoWebFetch(unittest.TestCase):
    def setUp(self):
        self.mod = load_agent("search")

    def test_built_agent_tools_are_graph_and_kb_only(self):
        agent = self.mod._agent._build(self.mod.SYSTEM_PROMPT, "amazon.nova-pro-v1:0")
        names = sorted(getattr(t, "__name__", str(t)) for t in agent.tools)
        self.assertEqual(names, ["query_graph", "query_knowledge_base"])

    def test_module_exposes_no_web_fetch_tool(self):
        self.assertFalse(hasattr(self.mod, "fetch_web_page"))
        self.assertFalse(hasattr(self.mod, "BrowserClient"))

    def test_fallback_prompt_does_not_offer_web_access(self):
        self.assertNotIn("fetch_web_page", self.mod.SYSTEM_PROMPT)
        self.assertIn("no web access", self.mod.SYSTEM_PROMPT)


if __name__ == "__main__":
    unittest.main()
