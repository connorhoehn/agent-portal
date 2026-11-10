"""Tests for the ingestion agent's tools — chiefly ``sync_knowledge_base``.

``sync_knowledge_base`` is a write tool in the sense that matters: it starts a
Bedrock ingestion job that re-indexes a knowledge base, spends money, and
changes what every search and advisor answer is grounded in. The decisions
worth pinning are about **which** knowledge base it touches, because getting
that wrong is silent — the job succeeds, on the wrong corpus.

No AWS: every client is a fake. Run from this directory:

    cd agents/tests && ../../.venv-synth/bin/python -m unittest test_ingestion_tools
"""

from __future__ import annotations

import json
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_harness import load_agent  # noqa: E402

ing = load_agent("ingestion", env={"KB_ID": "MAINKB0001"})


def _job(job_id="job-1", status="STARTING", started=None):
    job = {"ingestionJobId": job_id, "status": status}
    if started is not None:
        job["startedAt"] = started
    return {"ingestionJob": job}


class _Base(unittest.TestCase):
    def setUp(self):
        self.agent = mock.Mock()
        self.agent.list_data_sources.return_value = {
            "dataSourceSummaries": [{"dataSourceId": "ds-1"}]
        }
        self.agent.start_ingestion_job.return_value = _job()
        patcher = mock.patch.object(ing, "_bedrock_agent", self.agent)
        patcher.start()
        self.addCleanup(patcher.stop)


class SyncDefaultKbTests(_Base):
    def test_default_slug_syncs_the_module_kb(self):
        out = json.loads(ing.sync_knowledge_base())
        self.assertEqual(out["knowledge_base_id"], "MAINKB0001")
        self.assertEqual(out["data_source_id"], "ds-1")
        self.assertEqual(out["job_id"], "job-1")
        self.assertEqual(out["status"], "STARTING")
        self.assertEqual(
            self.agent.start_ingestion_job.call_args.kwargs["knowledgeBaseId"],
            "MAINKB0001",
        )

    def test_the_data_source_is_looked_up_on_the_kb_being_synced(self):
        ing.sync_knowledge_base()
        self.assertEqual(
            self.agent.list_data_sources.call_args.kwargs["knowledgeBaseId"],
            "MAINKB0001",
        )

    def test_started_at_is_serialised_not_dropped(self):
        self.agent.start_ingestion_job.return_value = _job(
            started=datetime(2026, 3, 1, 12, 0, tzinfo=timezone.utc)
        )
        out = json.loads(ing.sync_knowledge_base())
        self.assertIn("2026-03-01", out["started_at"])


class SyncNamedKbTests(_Base):
    def test_a_named_slug_syncs_the_registry_kb_not_the_main_one(self):
        with mock.patch.object(ing, "_resolve_kb_id_by_slug", return_value="ARTKB0002"):
            out = json.loads(ing.sync_knowledge_base(kb_slug="articles"))
        self.assertEqual(out["knowledge_base_id"], "ARTKB0002")
        self.assertEqual(
            self.agent.start_ingestion_job.call_args.kwargs["knowledgeBaseId"],
            "ARTKB0002",
        )

    def test_an_unknown_slug_refuses_rather_than_syncing_the_main_kb(self):
        # The bug this pins: `_resolve_kb_id_by_slug(slug) or KB_ID` meant a
        # typo'd or drifted slug quietly started a full re-index of the MAIN
        # knowledge base — a real cost against a corpus nobody asked about,
        # reported back as a successful sync of the slug that was requested.
        with mock.patch.object(ing, "_resolve_kb_id_by_slug", return_value=None):
            out = json.loads(ing.sync_knowledge_base(kb_slug="typo"))
        self.assertIn("error", out)
        self.assertIn("typo", out["error"])
        self.agent.start_ingestion_job.assert_not_called()

    def test_an_unresolvable_default_kb_is_an_error_not_an_empty_id(self):
        # An empty knowledgeBaseId reaches Bedrock as a validation error with
        # no hint about the cause; CLAUDE.md records exactly this class of
        # stale-env failure.
        with mock.patch.object(ing, "KB_ID", ""):
            out = json.loads(ing.sync_knowledge_base())
        self.assertIn("error", out)
        self.agent.start_ingestion_job.assert_not_called()

    def test_a_kb_with_no_data_source_is_reported_not_raised(self):
        # CLAUDE.md's recovery runbook: a repointed registry row that never
        # captured a data source id "still rejects every sync". Saying so beats
        # an IndexError in a tool result.
        self.agent.list_data_sources.return_value = {"dataSourceSummaries": []}
        out = json.loads(ing.sync_knowledge_base())
        self.assertIn("no data sources", out["error"])
        self.agent.start_ingestion_job.assert_not_called()


class CheckStatusTests(_Base):
    def test_statistics_are_flattened_onto_stable_key_names(self):
        self.agent.get_ingestion_job.return_value = {
            "ingestionJob": {
                "status": "COMPLETE",
                "statistics": {
                    "numberOfDocumentsScanned": 10,
                    "numberOfNewDocumentsIndexed": 7,
                    "numberOfModifiedDocumentsIndexed": 2,
                    "numberOfDocumentsDeleted": 1,
                    "numberOfDocumentsFailed": 0,
                },
                "failureReasons": [],
            }
        }
        out = json.loads(ing.check_ingestion_status("job-1"))
        self.assertEqual(out["status"], "COMPLETE")
        self.assertEqual(
            out["statistics"],
            {"scanned": 10, "indexed": 7, "updated": 2, "deleted": 1, "failed": 0},
        )

    def test_absent_statistics_report_zero_rather_than_missing_keys(self):
        self.agent.get_ingestion_job.return_value = {
            "ingestionJob": {"status": "FAILED", "failureReasons": ["quota"]}
        }
        out = json.loads(ing.check_ingestion_status("job-1"))
        self.assertEqual(out["statistics"]["failed"], 0)
        self.assertEqual(out["failure_reasons"], ["quota"])


class ExtractPreviewTests(unittest.TestCase):
    def setUp(self):
        self.bedrock = mock.Mock()
        patcher = mock.patch.object(ing, "_bedrock_runtime", self.bedrock)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _reply(self, text):
        self.bedrock.converse.return_value = {
            "output": {"message": {"content": [{"text": text}]}}
        }

    def test_uses_converse_with_an_aws_native_message_shape(self):
        # Same bug as graph-builder's extract_and_build: an Anthropic
        # InvokeModel body (`anthropic_version`, flat string content,
        # `max_tokens`) aimed at MODEL_ID, which defaults to
        # amazon.nova-pro-v1:0 and rejects all three fields.
        self._reply('{"people": []}')
        ing.extract_entities_preview("Alice runs Kubernetes.")
        self.bedrock.invoke_model.assert_not_called()
        call = self.bedrock.converse.call_args.kwargs
        self.assertEqual(call["modelId"], ing.MODEL_ID)
        self.assertIsInstance(call["messages"][0]["content"], list)
        self.assertIn("maxTokens", call["inferenceConfig"])
        self.assertNotIn("anthropic_version", json.dumps(call, default=str))

    def test_model_id_defaults_to_an_aws_native_model(self):
        self.assertTrue(ing.MODEL_ID.startswith("amazon."), ing.MODEL_ID)

    def test_json_is_sliced_out_of_a_narrated_reply(self):
        self._reply('Here you go:\n{"people": [{"name": "Alice"}]}\nAnything else?')
        out = json.loads(ing.extract_entities_preview("doc"))
        self.assertEqual(out["people"][0]["name"], "Alice")

    def test_a_reply_with_no_json_is_returned_verbatim_not_crashed(self):
        self._reply("I found no entities.")
        self.assertEqual(ing.extract_entities_preview("doc"), "I found no entities.")

    def test_input_is_capped_before_it_reaches_the_model(self):
        self._reply("{}")
        ing.extract_entities_preview("w" * 40000)
        prompt = self.bedrock.converse.call_args.kwargs["messages"][0]["content"][0]["text"]
        self.assertLess(prompt.count("w"), 10050)


class ReadDocumentTests(unittest.TestCase):
    def setUp(self):
        self.s3 = mock.Mock()
        patcher = mock.patch.object(ing, "_s3", self.s3)
        patcher.start()
        self.addCleanup(patcher.stop)
        bucket = mock.patch.object(ing, "_documents_bucket", return_value="orgiq-docs")
        bucket.start()
        self.addCleanup(bucket.stop)

    def test_binary_formats_return_metadata_instead_of_bytes(self):
        # A PDF decoded as UTF-8 is 50KB of replacement characters handed to a
        # model; the KB's own extractor is the right reader for those.
        self.s3.get_object.return_value = {
            "ContentType": "application/pdf", "ContentLength": 1234,
            "Body": mock.Mock(read=lambda: b"%PDF-1.7"),
        }
        out = json.loads(ing.read_document("uploads/handbook.pdf"))
        self.assertNotIn("content", out)
        self.assertIn("Binary format", out["note"])

    def test_text_is_capped_at_50kb(self):
        self.s3.get_object.return_value = {
            "ContentType": "text/plain", "ContentLength": 999_999,
            "Body": mock.Mock(read=lambda: b"a" * 200_000),
        }
        out = json.loads(ing.read_document("uploads/notes.txt"))
        self.assertEqual(len(out["content"]), 51200)

    def test_undecodable_bytes_do_not_raise(self):
        self.s3.get_object.return_value = {
            "ContentType": "text/plain", "ContentLength": 4,
            "Body": mock.Mock(read=lambda: b"\xff\xfe ok"),
        }
        out = json.loads(ing.read_document("uploads/notes.txt"))
        self.assertIn("ok", out["content"])


class ListDocumentsTests(unittest.TestCase):
    def setUp(self):
        self.s3 = mock.Mock()
        patcher = mock.patch.object(ing, "_s3", self.s3)
        patcher.start()
        self.addCleanup(patcher.stop)
        bucket = mock.patch.object(ing, "_documents_bucket", return_value="orgiq-docs")
        bucket.start()
        self.addCleanup(bucket.stop)

    def test_directory_placeholders_are_excluded(self):
        self.s3.list_objects_v2.return_value = {
            "Contents": [
                {"Key": "uploads/", "Size": 0,
                 "LastModified": datetime(2026, 1, 1, tzinfo=timezone.utc)},
                {"Key": "uploads/a.md", "Size": 12,
                 "LastModified": datetime(2026, 1, 1, tzinfo=timezone.utc)},
            ]
        }
        out = json.loads(ing.list_documents())
        self.assertEqual(out["count"], 1)
        self.assertEqual(out["objects"][0]["key"], "uploads/a.md")

    def test_listing_never_leaves_the_run_prefix(self):
        self.s3.list_objects_v2.return_value = {"Contents": []}
        ing.list_documents()
        self.assertEqual(self.s3.list_objects_v2.call_args.kwargs["Prefix"], "uploads/")
        ing.list_documents(prefix="wikis/")
        self.assertEqual(self.s3.list_objects_v2.call_args.kwargs["Prefix"], "uploads/wikis/")
        ing.list_documents(prefix="uploads/2026/")
        self.assertEqual(self.s3.list_objects_v2.call_args.kwargs["Prefix"], "uploads/2026/")
        self.s3.list_objects_v2.reset_mock()
        out = json.loads(ing.list_documents(prefix="uploads/../tenants/"))
        self.assertIn("outside", out["error"])
        self.s3.list_objects_v2.assert_not_called()


class RunPrefixConfinement(unittest.TestCase):
    """The model chooses the keys and reads untrusted text, so a run reads only
    its own prefix: the payload's `s3Prefix`, else uploads/."""

    def setUp(self):
        self.s3 = mock.Mock()
        self.s3.get_object.return_value = {
            "ContentType": "text/plain", "ContentLength": 2, "Body": mock.Mock(read=lambda: b"ok"),
        }
        patcher = mock.patch.object(ing, "_s3", self.s3)
        patcher.start()
        self.addCleanup(patcher.stop)
        bucket = mock.patch.object(ing, "_documents_bucket", return_value="orgiq-docs")
        bucket.start()
        self.addCleanup(bucket.stop)

    def test_a_key_outside_the_run_prefix_is_refused_before_s3(self):
        for key in ("tenants/assessment/report.md", "notes.txt", "uploads/../tenants/x.md", "uploadsX/a.md"):
            out = json.loads(ing.read_document(key))
            self.assertIn("outside", out["error"], key)
        self.s3.get_object.assert_not_called()

    def test_the_payload_prefix_becomes_the_run_prefix(self):
        prefix = ing.run_prefix_from({"s3Prefix": "kb/hr-handbook"})
        self.assertEqual(prefix, "kb/hr-handbook/")
        token = ing._run_prefix.set(prefix)
        try:
            self.assertIn("content", json.loads(ing.read_document("kb/hr-handbook/a.md")))
            self.assertIn("error", json.loads(ing.read_document("uploads/a.md")))
        finally:
            ing._run_prefix.reset(token)

    def test_a_bad_payload_prefix_is_refused(self):
        for bad in ("../x", "/abs", "a/../b", 42, "a\\b", "."):
            self.assertIsNone(ing.run_prefix_from({"s3Prefix": bad}), bad)
        self.assertEqual(ing.run_prefix_from({}), "uploads/")

    def test_the_entrypoint_refuses_a_bad_prefix(self):
        import asyncio
        out = asyncio.run(ing.handle({"input_text": "list", "s3Prefix": "../secrets"}))
        self.assertIn("s3Prefix", out["error"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
