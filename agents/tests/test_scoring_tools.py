"""Tests for the scoring agent's write tool.

``compute_expertise_scores`` is the third write agent: it reads the whole graph,
normalises an in-degree centrality to 0-100, and writes the result back onto
``people.expertise_score`` — the column every leaderboard, search ranking and
advisor answer is sorted by. The decisions worth pinning are the arithmetic
(a normalisation that divides by zero, or that rounds a top scorer to something
other than 100, silently reorders the whole org) and the failure isolation (a
best-effort DynamoDB snapshot must never abort the Aurora write it follows).

No AWS: every client is a fake. Run from this directory:

    cd agents/tests && ../../.venv-synth/bin/python -m unittest test_scoring_tools
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_harness import load_agent  # noqa: E402

sc = load_agent("scoring")


def _records(rows):
    """RDS Data API columnar output for (id, name, score) tuples."""
    return {
        "records": [
            [{"stringValue": pid}, {"stringValue": name}, {"doubleValue": score}]
            for pid, name, score in rows
        ]
    }


class _Base(unittest.TestCase):
    def setUp(self):
        self.rds = mock.Mock()
        self.dynamo = mock.Mock()
        for target, value in (("_rds", self.rds), ("_dynamo", self.dynamo)):
            patcher = mock.patch.object(sc, target, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def _rows_returned(self, rows):
        """First execute_statement is the SELECT; the rest are UPDATEs."""
        self.rds.execute_statement.side_effect = [_records(rows)] + [{}] * 50

    @property
    def updates(self):
        out = []
        for call in self.rds.execute_statement.call_args_list:
            sql = call.kwargs["sql"]
            if sql.strip().upper().startswith("UPDATE"):
                params = {
                    p["name"]: next(iter(p["value"].values()))
                    for p in call.kwargs.get("parameters", [])
                }
                out.append(params)
        return out


class ParameterCoercionTests(unittest.TestCase):
    def test_none_is_null(self):
        self.assertEqual(sc._p("x", None), {"name": "x", "value": {"isNull": True}})

    def test_int_and_float_keep_their_types(self):
        self.assertEqual(sc._p("x", 3), {"name": "x", "value": {"longValue": 3}})
        self.assertEqual(sc._p("x", 3.5), {"name": "x", "value": {"doubleValue": 3.5}})

    def test_strings_pass_through(self):
        self.assertEqual(sc._p("x", "a"), {"name": "x", "value": {"stringValue": "a"}})


class NormalisationTests(_Base):
    def test_the_top_scorer_normalises_to_exactly_100(self):
        self._rows_returned([("alice", "Alice", 40.0), ("bob", "Bob", 10.0)])
        out = json.loads(sc.compute_expertise_scores())
        self.assertEqual(out[0]["normalized_score"], 100.0)
        self.assertEqual(out[1]["normalized_score"], 25.0)

    def test_the_raw_score_is_reported_alongside_the_normalised_one(self):
        # Normalised scores are only comparable within one run; the raw value
        # is what makes two runs comparable at all.
        self._rows_returned([("alice", "Alice", 40.0)])
        out = json.loads(sc.compute_expertise_scores())
        self.assertEqual(out[0]["score"], 40.0)

    def test_an_all_zero_graph_does_not_divide_by_zero(self):
        # A freshly seeded or freshly truncated graph has no edges. A
        # ZeroDivisionError here would take down the whole scoring run rather
        # than reporting a flat zero.
        self._rows_returned([("alice", "Alice", 0.0), ("bob", "Bob", 0.0)])
        out = json.loads(sc.compute_expertise_scores())
        self.assertEqual([r["normalized_score"] for r in out], [0.0, 0.0])

    def test_no_people_returns_an_empty_list_and_writes_nothing(self):
        self.rds.execute_statement.return_value = {"records": []}
        self.assertEqual(json.loads(sc.compute_expertise_scores()), [])
        self.assertEqual(self.updates, [])

    def test_scores_are_rounded_to_two_places(self):
        self._rows_returned([("a", "A", 3.0), ("b", "B", 1.0)])
        out = json.loads(sc.compute_expertise_scores())
        self.assertEqual(out[1]["normalized_score"], 33.33)


class PersistenceTests(_Base):
    def test_one_update_per_person_with_bound_parameters(self):
        self._rows_returned([("alice", "Alice", 40.0), ("bob", "Bob", 10.0)])
        sc.compute_expertise_scores()
        self.assertEqual(len(self.updates), 2)
        self.assertEqual(self.updates[0], {"score": 100.0, "id": "alice"})
        self.assertEqual(self.updates[1], {"score": 25.0, "id": "bob"})

    def test_the_update_targets_a_single_row_by_primary_key(self):
        # An UPDATE without the WHERE would rewrite every score in the org.
        self._rows_returned([("alice", "Alice", 1.0)])
        sc.compute_expertise_scores()
        sql = [
            c.kwargs["sql"]
            for c in self.rds.execute_statement.call_args_list
            if c.kwargs["sql"].strip().upper().startswith("UPDATE")
        ][0]
        self.assertIn("WHERE id = :id", sql)
        self.assertIn("scored_at = NOW()", sql)

    def test_a_person_name_cannot_reach_the_sql_text(self):
        self._rows_returned([("bob", "Bob'); DROP TABLE people;--", 1.0)])
        sc.compute_expertise_scores()
        joined = " ".join(c.kwargs["sql"] for c in self.rds.execute_statement.call_args_list)
        self.assertNotIn("DROP TABLE", joined)

    def test_a_dynamodb_outage_does_not_abort_the_aurora_write(self):
        # The snapshot is explicitly best-effort. Letting it fail the run would
        # leave people.expertise_score half-updated — the worst of both.
        self.dynamo.put_item.side_effect = RuntimeError("table not found")
        self._rows_returned([("alice", "Alice", 40.0), ("bob", "Bob", 10.0)])
        out = json.loads(sc.compute_expertise_scores())
        self.assertEqual(len(out), 2)
        self.assertEqual(len(self.updates), 2)

    def test_the_snapshot_key_shape_is_stable(self):
        self._rows_returned([("alice", "Alice", 40.0)])
        sc.compute_expertise_scores(topic="kubernetes")
        item = self.dynamo.put_item.call_args.kwargs["Item"]
        self.assertEqual(item["pk"], {"S": "PERSON#alice"})
        self.assertTrue(item["sk"]["S"].startswith("SNAPSHOT#"))
        self.assertEqual(item["topic"], {"S": "kubernetes"})

    def test_an_unfiltered_run_labels_its_snapshot_all(self):
        self._rows_returned([("alice", "Alice", 40.0)])
        sc.compute_expertise_scores()
        self.assertEqual(
            self.dynamo.put_item.call_args.kwargs["Item"]["topic"], {"S": "all"}
        )


class QueryShapeTests(_Base):
    def test_the_topic_filter_is_bound_as_a_like_pattern(self):
        self._rows_returned([("alice", "Alice", 1.0)])
        sc.compute_expertise_scores(topic="kube")
        select = self.rds.execute_statement.call_args_list[0].kwargs
        params = {
            p["name"]: next(iter(p["value"].values()))
            for p in select["parameters"]
        }
        self.assertEqual(params["topic"], "%kube%")
        self.assertNotIn("kube", select["sql"])

    def test_limit_is_coerced_to_an_int_before_binding(self):
        self._rows_returned([("alice", "Alice", 1.0)])
        sc.compute_expertise_scores(limit="5")
        select = self.rds.execute_statement.call_args_list[0].kwargs
        limit = [p for p in select["parameters"] if p["name"] == "limit"][0]
        self.assertEqual(limit["value"], {"longValue": 5})

    def test_in_degree_counts_every_edge_table_that_points_at_a_person(self):
        # A missing UNION branch silently under-counts one whole relationship
        # class — the scores still look plausible, they are just wrong.
        for table in ("person_skills", "team_memberships", "project_contributions",
                      "decision_participants", "collaborations", "mentions"):
            self.assertIn(table, sc._IN_DEGREE_CTE)
        # Collaborations are undirected, so BOTH endpoints must contribute.
        self.assertIn("person_a_id", sc._IN_DEGREE_CTE)
        self.assertIn("person_b_id", sc._IN_DEGREE_CTE)


class RecordFlatteningTests(unittest.TestCase):
    def test_rows_are_value_only_lists(self):
        resp = {"records": [[{"stringValue": "a"}, {"doubleValue": 1.5}]]}
        self.assertEqual(sc._records_to_rows(resp), [["a", 1.5]])

    def test_no_records_is_an_empty_list(self):
        self.assertEqual(sc._records_to_rows({}), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
