"""Tests for the graph-builder's ``merge_*`` write tools.

graph-builder is the agent that mutates durable state: every ``merge_*`` call
is an ``INSERT ... ON CONFLICT DO UPDATE`` against the org graph, and the model
chooses the ids. What is worth pinning here is not that SQL runs — it is the
handful of decisions that make those writes safe to repeat and hard to corrupt:

  * ids are slugified, so two spellings of one person cannot become two rows;
  * values are **bound parameters**, never interpolated, and the one place a
    table name IS interpolated draws from a fixed allow-list;
  * a blank field on a re-merge preserves what is already stored instead of
    erasing it (``COALESCE(NULLIF(...))``) — this is what makes a second
    ingestion pass idempotent rather than destructive;
  * an unrecognised relationship type writes nothing at all;
  * nothing is written for a caller outside the graph's tenant, and an
    extraction is checked against the schema and its own document before any
    write (``_shared/graph_extraction.py``; the checks themselves are pinned in
    ``_shared/test_graph_extraction.py``).

No AWS: every client is a fake. Run from this directory:

    cd agents/tests && ../../.venv-synth/bin/python -m unittest test_graph_builder_tools
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_harness import FakeRds, load_agent  # noqa: E402

gb = load_agent("graph-builder")


ORGIQ_CALLER = {"sub": "u-1", "role": "member", "tenant": "orgiq"}


class _Base(unittest.TestCase):
    #: The verified caller the write tools see (handle() sets it in production).
    caller = ORGIQ_CALLER

    def setUp(self):
        self.rds = FakeRds()
        patcher = mock.patch.object(gb, "_rds", self.rds)
        patcher.start()
        self.addCleanup(patcher.stop)
        token = gb._caller_auth.set(self.caller)
        self.addCleanup(gb._caller_auth.reset, token)


# ── Id slugification ─────────────────────────────────────────────────────────


class SafeIdTests(unittest.TestCase):
    def test_lowercases_and_underscores(self):
        self.assertEqual(gb._safe_id("Alice Smith"), "alice_smith")

    def test_collapses_spellings_of_the_same_person_onto_one_id(self):
        # The graph joins on these ids. If "Alice Smith" and "alice smith"
        # produced different rows, every downstream score would be split in two.
        self.assertEqual(gb._safe_id(" Alice Smith "), gb._safe_id("alice smith"))

    def test_punctuation_becomes_underscores(self):
        self.assertEqual(gb._safe_id("O'Brien-Jones"), "o_brien_jones")
        self.assertEqual(gb._safe_id("alice@example.com"), "alice_example_com")

    def test_non_ascii_is_replaced_not_dropped(self):
        # Replacement keeps distinct names distinct even when neither is ASCII.
        self.assertNotEqual(gb._safe_id("zoë"), gb._safe_id("zoe"))

    def test_sql_metacharacters_cannot_survive_into_an_id(self):
        # Belt to the bound-parameter braces: even if an id ever reached a
        # string context, there is nothing left in it to break out with.
        import re as _re

        got = gb._safe_id("bob'; DROP TABLE people; --")
        self.assertIsNone(_re.search(r"[^a-z0-9_]", got), got)
        self.assertNotIn(";", got)
        self.assertNotIn("'", got)

    def test_already_safe_ids_are_unchanged(self):
        self.assertEqual(gb._safe_id("alice_smith"), "alice_smith")


# ── RDS Data API parameter coercion ──────────────────────────────────────────


class ParameterCoercionTests(unittest.TestCase):
    def test_none_is_null_not_the_string_none(self):
        self.assertEqual(gb._p("x", None), {"name": "x", "value": {"isNull": True}})

    def test_bool_is_checked_before_int(self):
        # `isinstance(True, int)` is True in Python, so an int-first branch
        # would silently store booleans as 1/0 and break any boolean column.
        self.assertEqual(gb._p("x", True), {"name": "x", "value": {"booleanValue": True}})
        self.assertEqual(gb._p("x", False), {"name": "x", "value": {"booleanValue": False}})

    def test_int_and_float_keep_their_types(self):
        self.assertEqual(gb._p("x", 7), {"name": "x", "value": {"longValue": 7}})
        self.assertEqual(gb._p("x", 0.5), {"name": "x", "value": {"doubleValue": 0.5}})

    def test_everything_else_is_stringified(self):
        self.assertEqual(gb._p("x", "hi"), {"name": "x", "value": {"stringValue": "hi"}})
        self.assertEqual(gb._p("x", ["a"]), {"name": "x", "value": {"stringValue": "['a']"}})


# ── merge_* upserts ──────────────────────────────────────────────────────────


class MergePersonTests(_Base):
    def test_returns_the_slugified_id(self):
        out = json.loads(gb.merge_person(person_id="Alice Smith", name="Alice Smith"))
        self.assertEqual(out, {"merged": "Person", "id": "alice_smith"})

    def test_values_are_bound_not_interpolated(self):
        gb.merge_person(
            person_id="bob", name="Bob'); DROP TABLE people;--", email="b@x.com"
        )
        self.assertNotIn("DROP TABLE", self.rds.sql)
        self.assertEqual(self.rds.params["name"], "Bob'); DROP TABLE people;--")

    def test_upsert_is_idempotent_on_the_primary_key(self):
        gb.merge_person(person_id="bob", name="Bob")
        self.assertIn("ON CONFLICT (id) DO UPDATE", self.rds.sql)

    def test_blank_fields_preserve_what_is_already_stored(self):
        # A second ingestion pass that knows only the name must not wipe the
        # email/title/team a richer earlier pass supplied. That is what makes
        # re-ingesting a corpus safe.
        gb.merge_person(person_id="bob", name="Bob")
        for column in ("email", "title", "team"):
            self.assertIn(f"COALESCE(NULLIF(EXCLUDED.{column}", self.rds.sql.replace("  ", " "))

    def test_role_maps_onto_the_title_column(self):
        gb.merge_person(person_id="bob", name="Bob", role="Staff Engineer")
        self.assertEqual(self.rds.params["title"], "Staff Engineer")

    def test_missing_optionals_are_bound_as_empty_strings_for_nullif(self):
        # NULLIF('' , '') is what turns "not supplied" into "keep the old
        # value"; binding NULL instead would make the COALESCE a no-op.
        gb.merge_person(person_id="bob", name="Bob")
        self.assertEqual(self.rds.params["email"], "")


class MergeOtherNodeTests(_Base):
    def test_merge_skill(self):
        out = json.loads(gb.merge_skill(skill_id="Kubernetes", name="Kubernetes"))
        self.assertEqual(out, {"merged": "Skill", "id": "kubernetes"})
        self.assertIn("INSERT INTO skills", self.rds.sql)
        self.assertIn("ON CONFLICT (id) DO UPDATE", self.rds.sql)

    def test_merge_team(self):
        out = json.loads(gb.merge_team(team_id="Platform Eng", name="Platform Eng"))
        self.assertEqual(out["id"], "platform_eng")
        self.assertIn("INSERT INTO teams", self.rds.sql)

    def test_merge_project(self):
        out = json.loads(
            gb.merge_project(project_id="Project Atlas", name="Atlas", status="active")
        )
        self.assertEqual(out["id"], "project_atlas")
        self.assertEqual(self.rds.params["status"], "active")

    def test_merge_project_meets_a_hand_made_initiative_of_the_same_name(self):
        # A person made "Atlas" by hand as p-atlas. Ingestion must not add a second row.
        self.rds.response = {"records": [[{"stringValue": "p-atlas"}]]}
        gb._project_alias.clear()
        out = json.loads(gb.merge_project(project_id="Project Atlas", name="ATLAS", status="active"))
        self.assertEqual(out, {"merged": "Project", "id": "p-atlas", "matched_by": "name"})
        self.assertNotIn("INSERT INTO projects", " ".join(c["sql"] for c in self.rds.calls))
        self.assertIn("UPDATE projects SET status", self.rds.sql)
        self.assertEqual(self.rds.params["id"], "p-atlas")
        # Relationships that name either id reach the stored row, hyphens intact.
        self.assertEqual(gb._project_id("Project", gb._safe_id("Project Atlas")), "p-atlas")
        self.assertEqual(gb._project_id("Project", gb._safe_id("p-atlas")), "p-atlas")
        self.assertEqual(gb._project_id("Person", "p_atlas"), "p_atlas")
        gb._project_alias.clear()


# ── merge_relationship: the allow-listed table name ──────────────────────────


class MergeRelationshipTests(_Base):
    def test_each_known_type_writes_to_its_mapped_table(self):
        to_labels = {"HAS_SKILL": "Skill", "MEMBER_OF": "Team", "WORKED_ON": "Project"}
        for rel, (table, src, dst) in gb._REL_TABLES.items():
            with self.subTest(rel=rel):
                self.rds.calls.clear()
                gb.merge_relationship(
                    from_id="alice", from_label="Person",
                    to_id="k8s", to_label=to_labels.get(rel, "Decision"), rel_type=rel,
                )
                self.assertIn(f"INSERT INTO {table} ({src}, {dst}, weight)", self.rds.sql)
                self.assertIn(f"ON CONFLICT ({src}, {dst}) DO UPDATE", self.rds.sql)

    def test_an_unknown_type_writes_nothing(self):
        # The table name is the ONE value interpolated into the SQL string.
        # It is safe only because it comes from _REL_TABLES; an unmapped type
        # must therefore stop before the f-string, not guess a table.
        out = json.loads(
            gb.merge_relationship(
                from_id="a", from_label="Person", to_id="b", to_label="Skill",
                rel_type="RELATED_TO",
            )
        )
        self.assertIn("unknown rel_type", out["error"])
        self.assertEqual(self.rds.calls, [], "no SQL may be issued for an unmapped type")

    def test_a_hostile_rel_type_cannot_reach_the_table_name(self):
        gb.merge_relationship(
            from_id="a", from_label="Person", to_id="b", to_label="Skill",
            rel_type="people; DROP TABLE people; --",
        )
        self.assertEqual(self.rds.calls, [])

    def test_rel_type_is_case_and_whitespace_insensitive(self):
        gb.merge_relationship(
            from_id="a", from_label="Person", to_id="k8s", to_label="Skill",
            rel_type="  has_skill  ",
        )
        self.assertIn("INSERT INTO person_skills", self.rds.sql)

    def test_endpoints_are_slugified(self):
        gb.merge_relationship(
            from_id="Alice Smith", from_label="Person",
            to_id="Kubernetes", to_label="Skill", rel_type="HAS_SKILL",
        )
        self.assertEqual(self.rds.params["src"], "alice_smith")
        self.assertEqual(self.rds.params["dst"], "kubernetes")

    def test_weight_never_decreases_on_re_merge(self):
        # GREATEST, not assignment: re-ingesting a document that mentions a
        # pairing once must not overwrite the strength learned from fifty
        # other documents.
        gb.merge_relationship(
            from_id="a", from_label="Person", to_id="b", to_label="Skill",
            rel_type="HAS_SKILL", weight=0.1,
        )
        self.assertIn("GREATEST(person_skills.weight, EXCLUDED.weight)", self.rds.sql)


class CollaborationTests(_Base):
    def test_pair_is_stored_in_canonical_order(self):
        # collaborations is an undirected edge with a two-column PK. Without
        # canonical ordering, (a,b) and (b,a) become two rows and the conflict
        # target never fires.
        gb.merge_relationship(
            from_id="zoe", from_label="Person", to_id="alice", to_label="Person",
            rel_type="WORKED_WITH",
        )
        self.assertEqual(self.rds.params["a"], "alice")
        self.assertEqual(self.rds.params["b"], "zoe")

    def test_order_of_arguments_does_not_change_the_row(self):
        gb.merge_relationship(
            from_id="alice", from_label="Person", to_id="zoe", to_label="Person",
            rel_type="WORKED_WITH",
        )
        first = self.rds.params
        gb.merge_relationship(
            from_id="zoe", from_label="Person", to_id="alice", to_label="Person",
            rel_type="WORKED_WITH",
        )
        self.assertEqual(first, self.rds.params)

    def test_self_collaboration_is_skipped_without_a_write(self):
        # A two-column PK cannot hold (a,a) meaningfully and "Alice worked with
        # Alice" is never a fact worth storing.
        out = json.loads(
            gb.merge_relationship(
                from_id="Alice", from_label="Person", to_id="alice",
                to_label="Person", rel_type="WORKED_WITH",
            )
        )
        self.assertEqual(out, {"skipped": "self-loop", "id": "alice"})
        self.assertEqual(self.rds.calls, [])

    def test_weight_uses_greatest_and_touches_last_seen(self):
        gb.merge_relationship(
            from_id="a", from_label="Person", to_id="b", to_label="Person",
            rel_type="WORKED_WITH", weight=0.4,
        )
        self.assertIn("GREATEST(collaborations.weight, EXCLUDED.weight)", self.rds.sql)
        self.assertIn("last_seen = NOW()", self.rds.sql)


# ── Embeddings ───────────────────────────────────────────────────────────────


class EmbedAndStoreTests(_Base):
    def setUp(self):
        super().setUp()
        self.bedrock = mock.Mock()
        self.bedrock.invoke_model.return_value = {
            "body": mock.Mock(read=lambda: json.dumps({"embedding": [0.5] * 1024}).encode())
        }
        patcher = mock.patch.object(gb, "_bedrock_runtime", self.bedrock)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_titan_v2_at_1024_dimensions(self):
        # The dimension is not a tuning knob: it has to match the
        # `vector(1024)` column type and every other embedding in the corpus.
        gb.embed_and_store(node_id="alice", node_label="Person", content="Alice, SRE")
        call = self.bedrock.invoke_model.call_args.kwargs
        self.assertEqual(call["modelId"], "amazon.titan-embed-text-v2:0")
        body = json.loads(call["body"])
        self.assertEqual(body["dimensions"], 1024)
        self.assertIs(body["normalize"], True)

    def test_reports_the_dimension_it_actually_stored(self):
        out = json.loads(
            gb.embed_and_store(node_id="alice", node_label="Person", content="x")
        )
        self.assertEqual(out, {"node_id": "alice", "dimensions": 1024, "stored": True})

    def test_vector_is_cast_and_upserted_on_node_id(self):
        gb.embed_and_store(node_id="alice", node_label="Person", content="x")
        self.assertIn("CAST(:embedding AS vector)", self.rds.sql)
        self.assertIn("ON CONFLICT (node_id) DO UPDATE", self.rds.sql)
        self.assertTrue(self.rds.params["embedding"].startswith("["))

    def test_content_is_capped_before_it_reaches_the_column(self):
        gb.embed_and_store(node_id="alice", node_label="Person", content="z" * 9000)
        self.assertEqual(len(self.rds.params["content"]), 4096)


# ── Extraction: the model call shape ─────────────────────────────────────────


class ConverseTextTests(unittest.TestCase):
    def test_concatenates_text_blocks(self):
        resp = {"output": {"message": {"content": [{"text": "a"}, {"text": "b"}]}}}
        self.assertEqual(gb._converse_text(resp), "ab")

    def test_ignores_non_text_blocks(self):
        resp = {"output": {"message": {"content": [{"toolUse": {}}, {"text": "a"}]}}}
        self.assertEqual(gb._converse_text(resp), "a")

    def test_an_empty_or_malformed_response_yields_an_empty_json_object(self):
        for resp in ({}, {"output": {}}, {"output": {"message": {}}},
                     {"output": {"message": {"content": []}}}):
            self.assertEqual(gb._converse_text(resp), "{}")


class ExtractAndBuildTests(_Base):
    def setUp(self):
        super().setUp()
        self.bedrock = mock.Mock()
        patcher = mock.patch.object(gb, "_bedrock_runtime", self.bedrock)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _reply(self, text):
        self.bedrock.converse.return_value = {
            "output": {"message": {"content": [{"text": text}]}}
        }
        self.bedrock.invoke_model.return_value = {
            "body": mock.Mock(read=lambda: json.dumps({"embedding": [0.1] * 1024}).encode())
        }

    def test_uses_converse_with_an_aws_native_message_shape(self):
        # The old code sent an Anthropic InvokeModel body (`anthropic_version`,
        # a flat string `content`, `max_tokens`) at MODEL_ID — which defaults
        # to amazon.nova-pro-v1:0. Nova rejects every one of those fields, so
        # this tool could not have worked as written. Converse is the
        # model-agnostic surface AND the operation the usage-capture patch
        # watches, so these tokens now reach the trace.
        self._reply('{"people": [], "skills": [], "teams": [], "projects": [], "relationships": []}')
        gb.extract_and_build(document_text="Alice runs Kubernetes.")
        self.bedrock.invoke_model.assert_not_called()
        call = self.bedrock.converse.call_args.kwargs
        self.assertEqual(call["modelId"], gb.MODEL_ID)
        self.assertEqual(call["messages"][0]["role"], "user")
        self.assertIsInstance(call["messages"][0]["content"], list)
        self.assertIn("text", call["messages"][0]["content"][0])
        self.assertIn("maxTokens", call["inferenceConfig"])
        self.assertNotIn("anthropic_version", json.dumps(call, default=str))

    def test_model_id_defaults_to_an_aws_native_model(self):
        self.assertTrue(gb.MODEL_ID.startswith("amazon."), gb.MODEL_ID)
        self.assertNotIn("anthropic", gb.MODEL_ID)

    DOC = "Alice Smith, an SRE on Platform, runs Kubernetes for Atlas."

    def test_writes_every_extracted_entity_and_relationship(self):
        self._reply(json.dumps({
            "people": [{"id": "Alice Smith", "name": "Alice Smith", "role": "SRE"}],
            "skills": [{"id": "Kubernetes", "name": "Kubernetes"}],
            "teams": [{"id": "Platform", "name": "Platform"}],
            "projects": [{"id": "Atlas", "name": "Atlas"}],
            "relationships": [{
                "from_id": "Alice Smith", "from_label": "Person",
                "to_id": "Kubernetes", "to_label": "Skill",
                "type": "HAS_SKILL", "weight": 0.9,
            }],
        }))
        out = json.loads(gb.extract_and_build(document_text=self.DOC, source_key="s3://k"))
        self.assertEqual(out["dropped"], {})
        self.assertEqual(out["nodes_created"], 4)
        self.assertEqual(out["relationships_created"], 1)
        self.assertEqual(out["embeddings_stored"], 2)  # people + skills only
        self.assertEqual(out["source"], "s3://k")
        tables = " ".join(c["sql"] for c in self.rds.calls)
        for table in ("people", "skills", "teams", "projects", "person_skills"):
            self.assertIn(table, tables)

    def test_json_wrapped_in_prose_is_still_extracted(self):
        # Models narrate. The tool slices from the first `{` to the last `}`
        # rather than requiring a bare object.
        self._reply(
            'Sure! Here is the JSON:\n```json\n'
            '{"people": [{"id": "bob", "name": "Bob"}], "skills": [], "teams": [], '
            '"projects": [], "relationships": []}\n```\nHope that helps.'
        )
        out = json.loads(gb.extract_and_build(document_text="Bob wrote this."))
        self.assertEqual(out["nodes_created"], 1)

    def test_a_reply_with_no_json_is_an_error_envelope_not_an_exception(self):
        self._reply("I could not find any entities in that document.")
        out = json.loads(gb.extract_and_build(document_text="doc"))
        self.assertIn("No JSON", out["error"])
        self.assertEqual(self.rds.calls, [])

    def test_malformed_json_is_reported_with_a_sample_and_writes_nothing(self):
        self._reply('{"people": [{"id": "bob",,,]}')
        out = json.loads(gb.extract_and_build(document_text="doc"))
        self.assertIn("JSON parse failed", out["error"])
        self.assertIn("raw", out)
        self.assertEqual(self.rds.calls, [])

    def test_missing_keys_are_treated_as_empty_not_fatal(self):
        self._reply('{"people": [{"id": "bob", "name": "Bob"}]}')
        out = json.loads(gb.extract_and_build(document_text="Bob wrote this."))
        self.assertEqual(out["nodes_created"], 1)
        self.assertEqual(out["relationships_created"], 0)

    def test_what_fails_the_check_is_dropped_counted_and_never_written(self):
        self._reply(json.dumps({
            "people": [
                {"id": "alice_smith", "name": "Alice Smith"},
                {"id": "mallory", "name": "Mallory Planted"},
            ],
            "skills": [{"id": "kubernetes", "name": "Kubernetes"}],
            "relationships": [
                {"from_id": "alice_smith", "from_label": "Person", "to_id": "kubernetes",
                 "to_label": "Skill", "type": "HAS_SKILL", "weight": 0.9},
                {"from_id": "mallory", "from_label": "Person", "to_id": "kubernetes",
                 "to_label": "Skill", "type": "HAS_SKILL"},
                {"from_id": "alice_smith", "from_label": "Person", "to_id": "kubernetes",
                 "to_label": "Skill", "type": "MADE"},
            ],
        }))
        out = json.loads(gb.extract_and_build(document_text=self.DOC))
        self.assertEqual(out["nodes_created"], 2)
        self.assertEqual(out["relationships_created"], 1)
        self.assertEqual(out["dropped"], {"not_in_source": 1, "unknown_endpoint": 1, "kind": 1})
        written = json.dumps([c.get("parameters") for c in self.rds.calls], default=str)
        self.assertNotIn("mallory", written.lower())

    def test_document_text_is_capped_in_the_prompt(self):
        self._reply('{"people": []}')
        gb.extract_and_build(document_text="w" * 50000)
        prompt = self.bedrock.converse.call_args.kwargs["messages"][0]["content"][0]["text"]
        self.assertLess(prompt.count("w"), 20050)


class CallerScopeTests(_Base):
    """Nothing reaches the graph for a caller outside its tenant."""

    caller = {"sub": "u-2", "role": "member", "tenant": "assessment"}

    def setUp(self):
        super().setUp()
        self.bedrock = mock.Mock()
        patcher = mock.patch.object(gb, "_bedrock_runtime", self.bedrock)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_every_write_tool_refuses_another_tenant(self):
        outs = [
            gb.merge_person(person_id="bob", name="Bob"),
            gb.merge_skill(skill_id="k8s", name="Kubernetes"),
            gb.merge_team(team_id="t", name="T"),
            gb.merge_project(project_id="p", name="P"),
            gb.merge_relationship(from_id="a", from_label="Person", to_id="b",
                                  to_label="Skill", rel_type="HAS_SKILL"),
            gb.embed_and_store(node_id="bob", node_label="Person", content="Bob"),
        ]
        for out in outs:
            self.assertEqual(json.loads(out)["reason"], "tenant")
        self.assertEqual(self.rds.calls, [])
        self.bedrock.invoke_model.assert_not_called()

    def test_extraction_refuses_before_the_model_call(self):
        out = json.loads(gb.extract_and_build(document_text="Bob wrote this."))
        self.assertEqual(out["refused"], "tenant")
        self.bedrock.converse.assert_not_called()
        self.assertEqual(self.rds.calls, [])

    def test_no_verified_caller_writes_nothing(self):
        token = gb._caller_auth.set(None)
        try:
            out = json.loads(gb.merge_person(person_id="bob", name="Bob"))
        finally:
            gb._caller_auth.reset(token)
        self.assertEqual(out["reason"], "tenant")
        self.assertEqual(self.rds.calls, [])


class AdminCallerTests(_Base):
    caller = {"sub": "u-3", "role": "admin", "tenant": "assessment"}

    def test_the_cross_tenant_admin_may_write(self):
        out = json.loads(gb.merge_person(person_id="bob", name="Bob"))
        self.assertEqual(out["merged"], "Person")


class ModelToolListTests(unittest.TestCase):
    """The model reaches the graph only through extract_and_build.

    The merge_* writers and embed_and_store are internal steps behind
    check_extraction; offered to the model as tools, a document that steers
    the model could write past those checks.
    """

    WRITERS = ("merge_person", "merge_skill", "merge_team", "merge_project",
               "merge_relationship", "embed_and_store")

    def test_model_tools_are_extract_and_build_and_the_sandbox_only(self):
        names = [t.__name__ for t in gb.MODEL_TOOLS]
        self.assertEqual(names, ["extract_and_build", "run_in_sandbox"])

    def test_the_built_agent_is_handed_only_the_model_tools(self):
        built = gb._agent._build("system", gb.MODEL_ID)
        names = {getattr(t, "__name__", "") for t in built.tools}
        self.assertEqual(names, {"extract_and_build", "run_in_sandbox"})
        for writer in self.WRITERS:
            self.assertNotIn(writer, names)

    def test_the_system_prompt_does_not_offer_the_writers(self):
        for writer in self.WRITERS:
            self.assertNotIn(writer, gb.SYSTEM_PROMPT)


class EmbedLabelTests(_Base):
    def test_an_unknown_label_is_refused_before_the_embedding_call(self):
        bedrock = mock.Mock()
        with mock.patch.object(gb, "_bedrock_runtime", bedrock):
            out = json.loads(gb.embed_and_store(node_id="x", node_label="Secret", content="x"))
        self.assertEqual(out, {"refused": "embedding", "reason": "kind"})
        bedrock.invoke_model.assert_not_called()
        self.assertEqual(self.rds.calls, [])


class HandleSetsTheCallerTests(unittest.TestCase):
    def test_handle_reads_the_caller_from_the_verified_block_only(self):
        seen = []
        with mock.patch.object(gb, "verified_auth", side_effect=lambda p: seen.append(p) or None), \
                mock.patch.object(gb, "post_trace"), \
                mock.patch.object(gb, "_agent", side_effect=lambda text: seen.append(gb._caller_auth.get()) or "ok"):
            import asyncio
            asyncio.run(gb.handle({"prompt": "hi", "tenant": "orgiq", "auth": {"tenant": "orgiq"}}))
        self.assertEqual(len(seen), 2)
        self.assertIsNone(seen[1], "an unverified block must not become the write caller")


# ── Sandbox tool ─────────────────────────────────────────────────────────────


class SandboxTests(unittest.TestCase):
    def test_missing_code_interpreter_id_is_named_rather_than_a_bare_500(self):
        # CLAUDE.md: capability ids are minted fresh on every rebuild and
        # .env/runtime env goes stale silently. Saying which variable is empty
        # is the difference between a one-line fix and an afternoon.
        with mock.patch.object(gb, "CODE_INTERPRETER_ID", ""):
            out = json.loads(gb.run_in_sandbox("print(1)"))
        self.assertIn("CODE_INTERPRETER_ID", out["error"])

    def test_a_sandbox_failure_is_returned_not_raised(self):
        client = mock.Mock()
        client.start_code_interpreter_session.side_effect = RuntimeError("no capacity")
        token = gb._sandbox_log.set([])
        try:
            with mock.patch.object(gb, "CODE_INTERPRETER_ID", "ci-1"), \
                    mock.patch.object(gb, "_agentcore_data", client):
                out = json.loads(gb.run_in_sandbox("print(1)"))
        finally:
            gb._sandbox_log.reset(token)
        self.assertIn("no capacity", out["error"])

    def test_the_session_is_stopped_even_when_invocation_fails(self):
        # Sessions are a billed, quota-limited resource; leaking one per failed
        # run is how a lab account runs out of them.
        client = mock.Mock()
        client.start_code_interpreter_session.return_value = {"sessionId": "s-1"}
        client.invoke_code_interpreter.side_effect = RuntimeError("boom")
        token = gb._sandbox_log.set([])
        try:
            with mock.patch.object(gb, "CODE_INTERPRETER_ID", "ci-1"), \
                    mock.patch.object(gb, "_agentcore_data", client):
                gb.run_in_sandbox("print(1)")
        finally:
            gb._sandbox_log.reset(token)
        client.stop_code_interpreter_session.assert_called_once()
        self.assertEqual(
            client.stop_code_interpreter_session.call_args.kwargs["sessionId"], "s-1"
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
