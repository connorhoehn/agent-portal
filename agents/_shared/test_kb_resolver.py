"""Unit tests for kb_resolver — stdlib unittest, no network, no Aurora.

The knowledge base id is the one piece of config every retrieval path depends
on and the one that CLAUDE.md records as having gone wrong for real (a KB
deleted out of band, a registry row naming an id that never existed). These
tests pin what the resolver does when the answer is missing, stale, or
unavailable.

Run:  cd agents/_shared && ../../.venv-synth/bin/python -m unittest test_kb_resolver
"""

from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from _shared import kb_resolver as kb  # noqa: E402


def _row(value):
    """RDS Data API response carrying one string cell."""
    return {"records": [[{"stringValue": value}]]}


class _FakeRds:
    """boto3 rds-data stand-in. Records calls; never touches the network."""

    def __init__(self, response=None, raises=None):
        self.response = response if response is not None else {"records": []}
        self.raises = raises
        self.calls = []

    def execute_statement(self, **kwargs):
        self.calls.append(kwargs)
        if self.raises is not None:
            raise self.raises
        return self.response


class _Base(unittest.TestCase):
    def setUp(self):
        kb.invalidate_cache()
        self._saved = {k: os.environ.get(k) for k in ("KB_ID",)}
        os.environ.pop("KB_ID", None)
        # Module-level ARNs are read at import; tests set them explicitly so a
        # developer's real .env can't change the outcome.
        self._arns = (kb._CLUSTER_ARN, kb._SECRET_ARN)
        kb._CLUSTER_ARN = "arn:aws:rds:us-east-1:1:cluster:orgiq"
        kb._SECRET_ARN = "arn:aws:secretsmanager:us-east-1:1:secret:orgiq"

    def tearDown(self):
        kb.invalidate_cache()
        kb._CLUSTER_ARN, kb._SECRET_ARN = self._arns
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def _with_rds(self, fake):
        boto3 = mock.Mock()
        boto3.client.return_value = fake
        return mock.patch.dict(sys.modules, {"boto3": boto3})


class RegistryLookup(_Base):
    def test_registry_row_wins_over_env(self):
        os.environ["KB_ID"] = "ENVKBID0001"
        fake = _FakeRds(_row("REGKBID0001"))
        with self._with_rds(fake):
            self.assertEqual(kb.resolve_kb_id("orgiq", "default"), "REGKBID0001")

    def test_falls_back_to_env_when_registry_has_no_row(self):
        os.environ["KB_ID"] = "ENVKBID0001"
        with self._with_rds(_FakeRds({"records": []})):
            self.assertEqual(kb.resolve_kb_id("orgiq", "default"), "ENVKBID0001")

    def test_returns_none_when_nothing_knows_the_id(self):
        # The real consequence: `KB_ID = resolve_kb_id(...) or ""` in the agent
        # module, so a retrieve goes out with an empty knowledgeBaseId. None is
        # the honest answer; inventing one would be worse.
        with self._with_rds(_FakeRds({"records": []})):
            self.assertIsNone(kb.resolve_kb_id("orgiq", "default"))

    def test_aurora_failure_degrades_to_env_and_never_raises(self):
        # Aurora Serverless v2 sleeps at 0.5 ACU; the first Data API call
        # against a cold cluster throws. A KB lookup that raised here would
        # crash the agent at *import* time — every agent resolves KB_ID at
        # module scope — turning a slow database into a crash-looping runtime.
        os.environ["KB_ID"] = "ENVKBID0001"
        boom = RuntimeError("HttpEndpointNotEnabledException")
        with self._with_rds(_FakeRds(raises=boom)):
            self.assertEqual(kb.resolve_kb_id("orgiq", "default"), "ENVKBID0001")

    def test_no_aurora_config_skips_the_call_entirely(self):
        kb._CLUSTER_ARN = ""
        kb._SECRET_ARN = ""
        os.environ["KB_ID"] = "ENVKBID0001"
        fake = _FakeRds(_row("REGKBID0001"))
        with self._with_rds(fake):
            self.assertEqual(kb.resolve_kb_id("orgiq", "default"), "ENVKBID0001")
        self.assertEqual(fake.calls, [], "must not call Aurora with no ARNs configured")

    def test_query_is_parameterised_and_filters_on_active(self):
        # The registry drifts (CLAUDE.md: rows naming knowledge bases that no
        # longer exist), so status='ACTIVE' is what keeps a retired row from
        # being handed to Bedrock. And the tenant is bound, never interpolated.
        fake = _FakeRds(_row("REGKBID0001"))
        with self._with_rds(fake):
            kb.resolve_kb_id("orgiq", "articles")
        sql = fake.calls[0]["sql"]
        self.assertIn("status = 'ACTIVE'", sql)
        self.assertIn(":t", sql)
        self.assertNotIn("orgiq", sql)
        names = {p["name"]: p["value"]["stringValue"] for p in fake.calls[0]["parameters"]}
        self.assertEqual(names, {"t": "orgiq", "p": "articles"})


class Caching(_Base):
    def test_success_is_cached_once_per_key(self):
        fake = _FakeRds(_row("REGKBID0001"))
        with self._with_rds(fake):
            kb.resolve_kb_id("orgiq", "default")
            kb.resolve_kb_id("orgiq", "default")
        self.assertEqual(len(fake.calls), 1)

    def test_distinct_purposes_are_distinct_cache_entries(self):
        fake = _FakeRds(_row("REGKBID0001"))
        with self._with_rds(fake):
            kb.resolve_kb_id("orgiq", "default")
            kb.resolve_kb_id("orgiq", "articles")
        self.assertEqual(len(fake.calls), 2)

    def test_a_miss_is_NOT_cached(self):
        # The hazard this guards: an lru_cache stores the *negative* result of
        # a cold-start lookup, so a container that booted one second before
        # Aurora woke up serves an empty KB id until it is replaced — with no
        # log line after the first attempt to say why every retrieve fails.
        first = _FakeRds({"records": []})
        with self._with_rds(first):
            self.assertIsNone(kb.resolve_kb_id("orgiq", "default"))
        later = _FakeRds(_row("REGKBID0001"))
        with self._with_rds(later):
            self.assertEqual(kb.resolve_kb_id("orgiq", "default"), "REGKBID0001")
        self.assertEqual(len(later.calls), 1, "second attempt must actually re-query")

    def test_invalidate_cache_forces_a_re_query(self):
        fake = _FakeRds(_row("REGKBID0001"))
        with self._with_rds(fake):
            kb.resolve_kb_id("orgiq", "default")
            kb.invalidate_cache()
            kb.resolve_kb_id("orgiq", "default")
        self.assertEqual(len(fake.calls), 2)


class SlugLookup(_Base):
    def test_slug_row_wins(self):
        fake = _FakeRds(_row("SLUGKBID001"))
        with self._with_rds(fake):
            self.assertEqual(kb.resolve_kb_id_by_slug("articles"), "SLUGKBID001")
        self.assertIn("slug = :s", fake.calls[0]["sql"])

    def test_default_slug_falls_back_to_env(self):
        os.environ["KB_ID"] = "ENVKBID0001"
        with self._with_rds(_FakeRds({"records": []})):
            self.assertEqual(kb.resolve_kb_id_by_slug("default"), "ENVKBID0001")

    def test_unknown_slug_does_NOT_fall_back_to_the_main_kb(self):
        # ingestion's sync_knowledge_base resolves by slug and then starts an
        # ingestion job. Handing back the main KB for an unrecognised slug
        # would silently re-sync the wrong knowledge base — an expensive,
        # entirely invisible mistake. None makes the caller's `or KB_ID`
        # fallback an explicit decision instead of a hidden one.
        os.environ["KB_ID"] = "ENVKBID0001"
        with self._with_rds(_FakeRds({"records": []})):
            self.assertIsNone(kb.resolve_kb_id_by_slug("does-not-exist"))

    def test_slug_lookup_failure_degrades_quietly(self):
        with self._with_rds(_FakeRds(raises=RuntimeError("cold cluster"))):
            self.assertIsNone(kb.resolve_kb_id_by_slug("articles"))


class SearchType(unittest.TestCase):
    """The search type must reach Bedrock on every retrieve.

    Bedrock's default search type against this Aurora/pgvector store returns the
    correct nearest neighbours in exactly REVERSE relevance order, reporting
    cosine distance in the `score` field. Measured top-1 accuracy over eight
    representative queries was 0/8 on the default and 8/8 on HYBRID, so a
    missing `overrideSearchType` is not a tuning nicety — it silently makes
    every consumer read the least relevant documents while the correct answer
    falls off the end of the list. Nothing downstream re-sorts, and the
    middleware trims oversized result lists from the tail, so the failure is
    invisible: real org documents come back and look like a working search.

    These assert the *presence and value* of the key, because the bug was an
    omission, not a wrong value.
    """

    def test_default_search_type_is_hybrid(self):
        self.assertEqual(kb.KB_SEARCH_TYPE, "HYBRID")

    def test_config_pins_override_search_type(self):
        cfg = kb.vector_search_config(5)
        self.assertEqual(cfg["overrideSearchType"], "HYBRID")
        self.assertEqual(cfg["numberOfResults"], 5)

    def test_config_never_omits_the_search_type(self):
        for n in (1, 5, 20):
            self.assertIn("overrideSearchType", kb.vector_search_config(n))

    def test_extra_keys_pass_through_without_dropping_search_type(self):
        # The gateway tool adds a metadata `filter`; adding one must not
        # displace the search type.
        flt = {"equals": {"key": "team", "value": {"stringValue": "t-data"}}}
        cfg = kb.vector_search_config(3, filter=flt)
        self.assertEqual(cfg["filter"], flt)
        self.assertEqual(cfg["overrideSearchType"], "HYBRID")

    def test_env_can_override_for_diagnosis(self):
        # KB_SEARCH_TYPE=SEMANTIC reproduces the inversion on purpose. The module
        # reads the env at import, so this reloads under a patched environ — and
        # the restoring reload must happen AFTER the patch is lifted, or it
        # re-reads the patched value and leaks SEMANTIC into every later test.
        import importlib

        try:
            with mock.patch.dict(os.environ, {"KB_SEARCH_TYPE": "SEMANTIC"}):
                reloaded = importlib.reload(kb)
                self.assertEqual(reloaded.KB_SEARCH_TYPE, "SEMANTIC")
                self.assertEqual(
                    reloaded.vector_search_config(5)["overrideSearchType"], "SEMANTIC"
                )
        finally:
            os.environ.pop("KB_SEARCH_TYPE", None)
            importlib.reload(kb)
        self.assertEqual(kb.KB_SEARCH_TYPE, "HYBRID")


if __name__ == "__main__":
    unittest.main(verbosity=2)
