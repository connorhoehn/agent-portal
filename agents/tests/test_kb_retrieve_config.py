"""The read agents' KB retrieval must pin the search type it sends to Bedrock.

``search`` exposes ``query_knowledge_base`` and ``advisor`` exposes
``retrieve_context``; both call ``bedrock-agent-runtime:Retrieve`` and hand the
results to the model **in the order Bedrock returned them**. Neither re-sorts,
and the middleware trims oversized result lists from the tail
(``middleware/src/lib/turn-tool-calls.ts``), so the returned order is load-
bearing all the way to the answer.

Bedrock's DEFAULT search type against this Aurora/pgvector store returns the
correct k nearest neighbours in EXACTLY REVERSE relevance order, reporting
cosine *distance* in a field named ``score``. Measured against ground truth
(``ORDER BY embedding <=> query`` on ``bedrock_kb``) over eight representative
queries, top-1 accuracy was **0/8 on the default and 8/8 on HYBRID** — e.g.
"Why did we choose Aurora over Neptune?" returned ``adr-d-iceberg.md`` first and
the actual ``adr-d-aurora.md`` last.

That made the knowledge base a false flag rather than an outage: real org
documents came back, so every surface looked like it worked while the model was
handed the least relevant evidence and the right answer fell off the end.

``_shared/test_kb_resolver.py::SearchType`` pins the helper. This file attacks
the shipped tools, because a helper is only worth what its call sites do with
it: both agents are covered by the same assertions deliberately — they hold
copy-pasted retrieval blocks, so a fix applied to one and not the other is
exactly the drift worth catching. The assertions are about the *presence* of
``overrideSearchType``, because the bug was an omission, not a wrong value.

Run:  cd agents/tests && ../../.venv-synth/bin/python -m unittest test_kb_retrieve_config
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_harness import load_agent  # noqa: E402


class FakeBedrockRuntime:
    """Records every retrieve call. Never speaks to Bedrock."""

    def __init__(self, results=None):
        self.calls = []
        self.results = results if results is not None else []

    def retrieve(self, **kwargs):
        self.calls.append(kwargs)
        return {"retrievalResults": self.results}

    @property
    def vector_config(self) -> dict:
        return self.calls[-1]["retrievalConfiguration"]["vectorSearchConfiguration"]


def _result(uri: str, score: float, text: str = "body"):
    return {
        "content": {"text": text},
        "score": score,
        "location": {"s3Location": {"uri": uri}},
    }


# (label, agent dir, tool attribute, the tool's documented max_results ceiling)
TOOLS = [
    ("search.query_knowledge_base", "search", "query_knowledge_base", 20),
    ("advisor.retrieve_context", "advisor", "retrieve_context", 10),
]


class SearchTypeReachesBedrock(unittest.TestCase):
    def _invoke(self, agent_dir, tool_name, *, results=None, **kwargs):
        mod = load_agent(agent_dir)
        fake = FakeBedrockRuntime(results=results)
        mod._bedrock = fake
        out = getattr(mod, tool_name)(**kwargs)
        return fake, out

    def test_override_search_type_is_sent(self):
        for label, agent_dir, tool_name, _ceiling in TOOLS:
            with self.subTest(tool=label):
                fake, _ = self._invoke(agent_dir, tool_name, query="who knows auth?")
                self.assertEqual(len(fake.calls), 1)
                cfg = fake.vector_config
                self.assertIn(
                    "overrideSearchType", cfg,
                    f"{label} omitted overrideSearchType — Bedrock's default ranks "
                    "this store's results worst-first",
                )
                self.assertEqual(cfg["overrideSearchType"], "HYBRID")

    def test_search_type_survives_a_custom_max_results(self):
        for label, agent_dir, tool_name, _ceiling in TOOLS:
            with self.subTest(tool=label):
                fake, _ = self._invoke(
                    agent_dir, tool_name, query="kubernetes", max_results=3
                )
                self.assertEqual(fake.vector_config["numberOfResults"], 3)
                self.assertEqual(fake.vector_config["overrideSearchType"], "HYBRID")

    def test_max_results_is_still_clamped_to_the_documented_ceiling(self):
        # The clamp is the other half of the config each tool builds; pinning it
        # here means a refactor of the retrieval block cannot quietly drop it
        # while satisfying the search-type assertions above.
        for label, agent_dir, tool_name, ceiling in TOOLS:
            with self.subTest(tool=label):
                fake, _ = self._invoke(
                    agent_dir, tool_name, query="anything", max_results=9999
                )
                self.assertEqual(fake.vector_config["numberOfResults"], ceiling)
                self.assertEqual(fake.vector_config["overrideSearchType"], "HYBRID")

    def test_results_are_passed_through_in_bedrock_order(self):
        # Not an endorsement of the order — a record of the dependency. Neither
        # tool sorts, which is precisely why the search type has to be right at
        # the call site rather than corrected downstream.
        ordered = [
            _result("s3://b/synth/internal/adr/adr-d-aurora.md", 0.500),
            _result("s3://b/synth/internal/adr/adr-d-vectordb.md", 0.492),
            _result("s3://b/synth/internal/adr/adr-d-iceberg.md", 0.469),
        ]
        for label, agent_dir, tool_name, _ceiling in TOOLS:
            with self.subTest(tool=label):
                _, out = self._invoke(
                    agent_dir, tool_name, results=ordered, query="aurora vs neptune"
                )
                got = [r["source"] for r in json.loads(out)]
                self.assertEqual(got, [r["location"]["s3Location"]["uri"] for r in ordered])


if __name__ == "__main__":
    unittest.main(verbosity=2)
