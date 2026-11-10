"""graph_extraction: what graph-builder may write from a model's extraction.

Run from this directory: ``python -m unittest test_graph_extraction``.
"""

from __future__ import annotations

import unittest

try:
    from . import graph_extraction as ge
except ImportError:  # flat run from agents/_shared
    import graph_extraction as ge

ORGIQ = {"sub": "u-1", "role": "member", "tenant": "orgiq"}
DOC = (
    "Alice Smith (alice@example.com) leads the Platform team and runs Kubernetes "
    "for Project Atlas. She worked with Bob Jones, a Data Engineer."
)


def _ok_extraction():
    return {
        "people": [
            {"id": "alice_smith", "name": "Alice Smith", "email": "alice@example.com", "team": "Platform"},
            {"id": "bob_jones", "name": "Bob Jones", "role": "Data Engineer"},
        ],
        "skills": [{"id": "kubernetes", "name": "Kubernetes"}],
        "teams": [{"id": "platform", "name": "Platform"}],
        "projects": [{"id": "project_atlas", "name": "Project Atlas"}],
        "relationships": [
            {"from_id": "alice_smith", "from_label": "Person", "to_id": "kubernetes", "to_label": "Skill", "type": "HAS_SKILL", "weight": 0.9},
            {"from_id": "alice_smith", "from_label": "Person", "to_id": "platform", "to_label": "Team", "type": "MEMBER_OF"},
            {"from_id": "alice_smith", "from_label": "Person", "to_id": "project_atlas", "to_label": "Project", "type": "WORKED_ON"},
            {"from_id": "alice_smith", "from_label": "Person", "to_id": "bob_jones", "to_label": "Person", "type": "WORKED_WITH"},
        ],
    }


class CallerTests(unittest.TestCase):
    def test_orgiq_and_the_cross_tenant_admin_may_write(self):
        self.assertTrue(ge.caller_may_write(ORGIQ))
        self.assertTrue(ge.caller_may_write({"tenant": "assessment", "role": "admin"}))

    def test_another_tenant_or_no_caller_may_not(self):
        for auth in (None, {}, {"tenant": "assessment", "role": "member"}, "orgiq", {"tenant": "ORGIQ"}):
            with self.subTest(auth=auth):
                self.assertFalse(ge.caller_may_write(auth))

    def test_a_refused_caller_drops_everything_under_tenant(self):
        checked = ge.check_extraction(_ok_extraction(), DOC, {"tenant": "assessment", "role": "member"})
        self.assertEqual(checked.dropped, {"tenant": 9})
        self.assertEqual(checked.relationships, [])
        self.assertTrue(all(not v for v in checked.entities.values()))


class SchemaTests(unittest.TestCase):
    def test_a_clean_extraction_passes_whole(self):
        checked = ge.check_extraction(_ok_extraction(), DOC, ORGIQ)
        self.assertEqual(checked.dropped, {})
        self.assertEqual(len(checked.entities["people"]), 2)
        self.assertEqual(len(checked.relationships), 4)
        self.assertEqual(checked.entities["people"][0]["email"], "alice@example.com")

    def test_not_an_object_is_a_schema_drop(self):
        self.assertEqual(ge.check_extraction(["x"], DOC, ORGIQ).dropped, {"schema": 1})
        self.assertEqual(ge.check_extraction({"people": "Alice"}, DOC, ORGIQ).dropped, {"schema": 1})

    def test_bad_entity_shapes_are_dropped(self):
        ex = {"people": [
            "Alice Smith",
            {"id": "x"},
            {"id": "", "name": ""},
            {"id": "!!!", "name": "Alice Smith"},
            {"id": "a" * 500, "name": "Alice Smith"},
            {"id": ["a"], "name": "Alice Smith"},
        ]}
        self.assertEqual(ge.check_extraction(ex, DOC, ORGIQ).dropped, {"schema": 6})

    def test_a_name_the_document_never_mentions_is_dropped(self):
        ex = {"people": [{"id": "eve", "name": "Eve Outsider"}, {"id": "alice", "name": "alice   SMITH"}]}
        checked = ge.check_extraction(ex, DOC, ORGIQ)
        self.assertEqual(checked.dropped, {"not_in_source": 1})
        self.assertEqual([p["id"] for p in checked.entities["people"]], ["alice"])

    def test_a_name_inside_a_longer_word_is_not_a_mention(self):
        # "Ali" sits inside "Alice", "Form" inside "Platform", "Net" inside
        # nothing: none of them is a whole-word mention.
        ex = {
            "people": [{"id": "ali", "name": "Ali"}],
            "teams": [{"id": "form", "name": "Form"}],
            "skills": [{"id": "rnetes", "name": "rnetes"}],
        }
        checked = ge.check_extraction(ex, DOC, ORGIQ)
        self.assertEqual(checked.dropped, {"not_in_source": 3})

    def test_a_name_shorter_than_the_minimum_is_not_a_mention(self):
        ex = {"people": [{"id": "a", "name": "A"}]}
        self.assertEqual(ge.check_extraction(ex, "A note from A.", ORGIQ).dropped, {"not_in_source": 1})
        # Two letters is enough when the word stands alone.
        ok = {"skills": [{"id": "go", "name": "Go"}]}
        self.assertEqual(ge.check_extraction(ok, "She writes Go daily.", ORGIQ).dropped, {})

    def test_optional_fields_need_a_whole_word_match_too(self):
        ex = {"people": [{"id": "alice", "name": "Alice Smith", "team": "Plat", "role": "Data Engineer"}]}
        checked = ge.check_extraction(ex, DOC, ORGIQ)
        self.assertEqual(checked.entities["people"], [{"id": "alice", "name": "Alice Smith", "role": "Data Engineer"}])
        self.assertEqual(checked.fields_cleared, 1)

    def test_mentions(self):
        source = ge._normalise(DOC)
        self.assertTrue(ge.mentions(source, "alice@example.com"))
        self.assertTrue(ge.mentions(source, "project   atlas"))
        self.assertFalse(ge.mentions(source, "atla"))
        self.assertFalse(ge.mentions(source, " "))
        self.assertFalse(ge.mentions(source, "a"))

    def test_optional_fields_not_in_the_document_are_blanked(self):
        ex = {"people": [{"id": "alice", "name": "Alice Smith", "email": "boss@elsewhere.test", "role": "CEO"}]}
        checked = ge.check_extraction(ex, DOC, ORGIQ)
        self.assertEqual(checked.entities["people"], [{"id": "alice", "name": "Alice Smith"}])
        self.assertEqual(checked.fields_cleared, 2)

    def test_duplicates_and_limits(self):
        ex = {"skills": [{"id": "kubernetes", "name": "Kubernetes"}] * 2}
        self.assertEqual(ge.check_extraction(ex, DOC, ORGIQ).dropped, {"duplicate": 1})
        many = {"skills": [{"id": f"k{i}", "name": "Kubernetes"} for i in range(ge.MAX_PER_KIND + 5)]}
        self.assertEqual(ge.check_extraction(many, DOC, ORGIQ).dropped, {"limit": 5})


class RelationshipTests(unittest.TestCase):
    def _rels(self, *rels):
        ex = _ok_extraction()
        ex["relationships"] = list(rels)
        return ge.check_extraction(ex, DOC, ORGIQ)

    def test_unknown_types_and_wrong_label_pairs_are_kind_drops(self):
        checked = self._rels(
            {"from_id": "alice_smith", "from_label": "Person", "to_id": "kubernetes", "to_label": "Skill", "type": "RELATED_TO"},
            {"from_id": "alice_smith", "from_label": "Person", "to_id": "kubernetes", "to_label": "Skill", "type": "MADE"},
            {"from_id": "alice_smith", "from_label": "Person", "to_id": "kubernetes", "to_label": "Team", "type": "HAS_SKILL"},
            {"from_id": "kubernetes", "from_label": "Skill", "to_id": "alice_smith", "to_label": "Person", "type": "HAS_SKILL"},
        )
        self.assertEqual(checked.dropped, {"kind": 4})

    def test_endpoints_must_be_accepted_entities_of_the_right_kind(self):
        checked = self._rels(
            {"from_id": "alice_smith", "from_label": "Person", "to_id": "rust", "to_label": "Skill", "type": "HAS_SKILL"},
            {"from_id": "ceo", "from_label": "Person", "to_id": "kubernetes", "to_label": "Skill", "type": "HAS_SKILL"},
            {"from_id": "alice_smith", "from_label": "Person", "to_id": "platform", "to_label": "Project", "type": "WORKED_ON"},
        )
        self.assertEqual(checked.dropped, {"unknown_endpoint": 3})

    def test_weight_must_be_a_number_in_range(self):
        checked = self._rels(
            {"from_id": "alice_smith", "from_label": "Person", "to_id": "kubernetes", "to_label": "Skill", "type": "HAS_SKILL", "weight": 7},
            {"from_id": "alice_smith", "from_label": "Person", "to_id": "kubernetes", "to_label": "Skill", "type": "HAS_SKILL", "weight": "high"},
            {"from_id": "alice_smith", "from_label": "Person", "to_id": "kubernetes", "to_label": "Skill", "type": "HAS_SKILL", "weight": True},
        )
        self.assertEqual(checked.dropped, {"schema": 3})

    def test_ids_are_slugged_like_the_writer_and_type_is_normalised(self):
        checked = self._rels(
            {"from_id": "Alice Smith", "from_label": "Person", "to_id": "Kubernetes", "to_label": "Skill", "type": " has_skill "},
        )
        self.assertEqual(checked.relationships, [{
            "from_id": "alice_smith", "from_label": "Person", "to_id": "kubernetes",
            "to_label": "Skill", "type": "HAS_SKILL", "weight": 1.0,
        }])


class DirectToolTests(unittest.TestCase):
    def test_check_node(self):
        self.assertIsNone(ge.check_node("Person", "bob", "Bob", ORGIQ))
        self.assertEqual(ge.check_node("Person", "bob", "Bob", None), "tenant")
        self.assertEqual(ge.check_node("Person", "", "Bob", ORGIQ), "schema")
        self.assertEqual(ge.check_node("Person", "bob", "x" * 500, ORGIQ), "schema")
        self.assertEqual(ge.check_node("Planet", "bob", "Bob", ORGIQ), "kind")

    def test_check_edge(self):
        self.assertIsNone(ge.check_edge("HAS_SKILL", "Person", "Skill", ORGIQ))
        self.assertEqual(ge.check_edge("HAS_SKILL", "Person", "Skill", {"tenant": "assessment"}), "tenant")
        self.assertEqual(ge.check_edge("MEMBER_OF", "Person", "Skill", ORGIQ), "kind")
        # Decision edges are left to the writer's table allow-list.
        self.assertIsNone(ge.check_edge("MADE", "Person", "Decision", ORGIQ))


if __name__ == "__main__":
    unittest.main(verbosity=2)
