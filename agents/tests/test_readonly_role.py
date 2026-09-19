"""The read agents' SQL must run under a role the *database* will not let write.

``_shared/test_sql_guard.py`` attacks the regex. ``test_read_tool_guard.py``
attacks the tools that call it. This file attacks the layer underneath both:
the PostgreSQL role ``orgiq_graph_reader`` (``schema/graph_readonly_role.sql``)
and the wiring that makes ``search`` and ``advisor`` authenticate as it.

WHAT THESE TESTS PROVE, AND WHAT THEY CANNOT
--------------------------------------------
The honest boundary of an offline test suite, stated up front so nobody reads
a green run as more than it is.

Proved here, without a cluster:

*   The shipped SQL grants ``SELECT``, ``USAGE`` on a schema and ``CONNECT`` on
    a database — and nothing else. No ``GRANT INSERT/UPDATE/DELETE/ALL``
    anywhere in the file, in any spelling, including inside the ``format()``
    strings the DO blocks execute.
*   The role is created with every escalation attribute explicitly negated,
    is never made an owner, and is pinned to
    ``default_transaction_read_only = on``.
*   The grant list is an explicit allow-list with no ``ALTER DEFAULT
    PRIVILEGES``, so it cannot silently grow when a migration adds a table.
*   No password appears in the file.
*   ``search`` and ``advisor`` send ``AURORA_READONLY_SECRET_ARN`` to the Data
    API when it is configured, the admin secret when it is not, and never
    retry a failure on the admin secret.
*   The CDK swaps the secret rather than adding one: with the role enabled,
    the two read runtimes lose ``GetSecretValue`` on the admin credential.

NOT proved here — these need the live cluster, and the commands that check
them are in ``docs/readonly-graph-role.md`` §"Verify":

*   That PostgreSQL actually refused a ``DELETE``. Only the engine can say
    that. ``schema/apply_all_seed.py`` asks it on every apply
    (``verify_readonly_role``) and fails the run if the answer is wrong; that
    is the on-cluster half of this proof, and it has not been run here because
    the credentials in this environment are expired and deploying is not
    authorised.
*   That the Data API accepts the read-only secret at all (secret shape,
    ``GetSecretValue`` permissions, the password actually matching the role).
*   That nothing in the fleet outside these two agents depended on the admin
    credential in the two runtimes whose grant is being swapped.

Run:  cd agents/tests && ../../.venv-synth/bin/python -m unittest test_readonly_role
"""

from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from agent_harness import FakeRds, load_agent  # noqa: E402

REPO = Path(__file__).resolve().parent.parent.parent
SQL_PATH = REPO / "schema" / "graph_readonly_role.sql"
AURORA_STACK = REPO / "infra" / "lib" / "aurora-stack.ts"
RUNTIME_STACK = REPO / "infra" / "lib" / "agentcore-runtime-stack.ts"

ROLE = "orgiq_graph_reader"

READONLY_ARN = "arn:aws:secretsmanager:us-east-1:647757222309:secret:orgiq-aurora-readonly-credentials-r0"
ADMIN_ARN = "arn:aws:secretsmanager:us-east-1:647757222309:secret:orgiq-aurora-admin-a0"
CLUSTER_ARN = "arn:aws:rds:us-east-1:647757222309:cluster:orgiq-aurora"


def strip_sql_comments(sql: str) -> str:
    """Remove ``--`` and ``/* */`` comments, keeping everything else intact.

    Not ``sql_guard.strip_literals_and_comments``: that also blanks
    dollar-quoted bodies, and the bodies are where this file's grants live.
    """
    sql = re.sub(r"/\*.*?\*/", " ", sql, flags=re.DOTALL)
    sql = re.sub(r"--[^\n]*", " ", sql)
    return sql


SQL_RAW = SQL_PATH.read_text(encoding="utf-8")
SQL = strip_sql_comments(SQL_RAW)


class TheSqlGrantsOnlyReads(unittest.TestCase):
    """Every privilege the file hands out, enumerated."""

    #: Privilege verbs the role may legitimately receive. Anything else in a
    #: GRANT is a bug in the file, not a new feature.
    ALLOWED_PRIVILEGES = {"SELECT", "USAGE", "CONNECT"}

    #: The full set of PostgreSQL table privileges that are not SELECT. Listed
    #: exhaustively rather than as "the interesting ones": REFERENCES lets a
    #: role add a foreign key, TRIGGER lets it attach code, MAINTAIN (PG17)
    #: lets it run VACUUM/CLUSTER. None belongs here.
    WRITE_PRIVILEGES = [
        "ALL", "ALL PRIVILEGES", "INSERT", "UPDATE", "DELETE", "TRUNCATE",
        "REFERENCES", "TRIGGER", "CREATE", "MAINTAIN", "TEMPORARY", "TEMP",
        "EXECUTE",
    ]

    def test_every_grant_is_select_usage_or_connect(self):
        """Enumerate the privileges granted, do not spot-check them.

        Catches the case a denylist would miss: a privilege nobody thought to
        forbid because it did not exist when the test was written.
        """
        granted = set()
        for verbs in re.findall(r"\bGRANT\s+([A-Za-z ,]+?)\s+ON\b", SQL, re.IGNORECASE):
            for verb in verbs.split(","):
                granted.add(" ".join(verb.split()).upper())
        self.assertTrue(granted, "no GRANT found — did the file move?")
        self.assertEqual(
            granted - self.ALLOWED_PRIVILEGES,
            set(),
            f"graph_readonly_role.sql grants more than reads: {sorted(granted)}",
        )

    def test_no_write_privilege_is_granted_in_any_spelling(self):
        for privilege in self.WRITE_PRIVILEGES:
            pattern = r"\bGRANT\s+" + privilege.replace(" ", r"\s+") + r"\b"
            hit = re.search(pattern, SQL, re.IGNORECASE)
            self.assertIsNone(
                hit,
                f"GRANT {privilege} appears in graph_readonly_role.sql: {hit.group(0) if hit else ''}",
            )

    def test_grant_select_targets_only_tables_in_the_allow_list(self):
        """The one GRANT SELECT is parameterised by the allow-list array."""
        self.assertIn("GRANT SELECT ON TABLE public.%I TO orgiq_graph_reader", SQL)
        self.assertEqual(
            len(re.findall(r"\bGRANT\s+SELECT\b", SQL, re.IGNORECASE)),
            1,
            "more than one GRANT SELECT — every grant should flow through the allow-list",
        )

    def test_no_alter_default_privileges(self):
        """An allow-list that grows on its own is not an allow-list.

        ``ALTER DEFAULT PRIVILEGES ... GRANT SELECT ON TABLES`` would hand the
        role every future table any migration creates — identity, budgets,
        observability — without a review.
        """
        self.assertNotRegex(SQL, r"(?i)\bALTER\s+DEFAULT\s+PRIVILEGES\b")

    def test_privileges_are_revoked_before_they_are_granted(self):
        """A shrinking allow-list must actually shrink the role's privileges."""
        first_revoke = re.search(r"(?i)\bREVOKE\s+ALL\s+PRIVILEGES\b", SQL)
        first_grant = re.search(r"(?i)\bGRANT\s+", SQL)
        self.assertIsNotNone(first_revoke, "no REVOKE ALL — a removed table would keep its grant")
        self.assertIsNotNone(first_grant)
        self.assertLess(
            first_revoke.start(), first_grant.start(),
            "REVOKE must precede GRANT or the revoke undoes the grant",
        )


class TheRoleItself(unittest.TestCase):

    def _create_role_clause(self) -> str:
        match = re.search(r"(?is)CREATE\s+ROLE\s+" + ROLE + r"(.*?);", SQL)
        self.assertIsNotNone(match, "no CREATE ROLE statement found")
        return match.group(1).upper()

    def test_role_is_created_with_every_escalation_attribute_negated(self):
        clause = self._create_role_clause()
        for attribute in ("NOSUPERUSER", "NOCREATEDB", "NOCREATEROLE",
                          "NOREPLICATION", "NOBYPASSRLS"):
            self.assertIn(attribute, clause, f"CREATE ROLE is missing {attribute}")

    def test_role_is_never_granted_superuser_or_a_privileged_group(self):
        """No `GRANT rds_superuser TO ...`, no SUPERUSER, no membership."""
        self.assertNotRegex(SQL, r"(?i)\bALTER\s+ROLE\s+\w+\s+.*\bSUPERUSER\b(?!\s*$)")
        self.assertNotRegex(SQL, r"(?i)\bGRANT\s+(rds_superuser|rds_iam|pg_write_\w+|pg_read_server_files)\b")
        self.assertNotRegex(SQL, r"(?i)\bWITH\s+ADMIN\s+OPTION\b")
        self.assertNotRegex(SQL, r"(?i)\bWITH\s+GRANT\s+OPTION\b")

    def test_role_owns_nothing(self):
        """Ownership beats privileges: an owner can always write its table."""
        self.assertNotRegex(SQL, r"(?i)\bOWNER\s+TO\s+" + ROLE)
        self.assertNotRegex(SQL, r"(?i)\bCREATE\s+(TABLE|SCHEMA|VIEW|SEQUENCE|FUNCTION)\b")
        # ...and the file asserts the same thing against the live catalog.
        self.assertIn("owns an object", SQL)

    def test_role_sessions_are_read_only_transactions(self):
        """The belt on the braces: no write is possible even if a grant slips."""
        self.assertRegex(
            SQL,
            r"(?i)ALTER\s+ROLE\s+" + ROLE + r"\s+SET\s+default_transaction_read_only\s*=\s*on",
        )

    def test_role_cannot_create_objects_in_public(self):
        self.assertRegex(SQL, r"(?i)REVOKE\s+ALL\s+PRIVILEGES\s+ON\s+SCHEMA\s+public\s+FROM\s+" + ROLE)
        self.assertRegex(SQL, r"(?i)GRANT\s+USAGE\s+ON\s+SCHEMA\s+public\s+TO\s+" + ROLE)

    def test_no_password_is_committed(self):
        """The credential lives in Secrets Manager. Only there."""
        self.assertNotRegex(SQL_RAW, r"(?i)\bPASSWORD\s+'")
        self.assertNotRegex(SQL_RAW, r"(?i)\bENCRYPTED\s+PASSWORD\b")

    def test_a_runaway_model_query_cannot_pin_the_cluster(self):
        self.assertRegex(SQL, r"(?i)ALTER\s+ROLE\s+" + ROLE + r"\s+SET\s+statement_timeout")


class TheAllowList(unittest.TestCase):
    """Exactly the tables ``search`` and ``advisor`` read, and no others."""

    #: A deliberate second copy of the list. Changing the grant means changing
    #: this too, which is the review this test exists to force.
    EXPECTED = {
        "people", "skills", "teams", "projects", "decisions", "documents",
        "person_skills", "team_memberships", "collaborations",
        "project_contributions", "decision_participants", "mentions",
        "knowledge_bases",
    }

    #: Tables that must never appear. Not an exhaustive denylist — the
    #: EXPECTED equality above already is one — but these are the ones whose
    #: accidental inclusion would matter most, so they get named.
    FORBIDDEN = {
        "app_users", "tenants", "user_tenant_roles",       # identity
        "initiative_budgets", "budget_grants", "sprints",  # money
        "bots", "bot_runs", "agent_jobs",                  # dispatch
        "invocation_traces", "node_embeddings",            # traces, vectors
        "work_items", "assessment_runs",
    }

    def setUp(self):
        block = re.search(r"(?is)READABLE\s+CONSTANT\s+text\[\]\s*:=\s*ARRAY\[(.*?)\]", SQL)
        self.assertIsNotNone(block, "allow-list array not found")
        self.tables = set(re.findall(r"'([a-z_]+)'", block.group(1)))

    def test_allow_list_is_exactly_what_the_read_tools_need(self):
        self.assertEqual(self.tables, self.EXPECTED)

    def test_allow_list_holds_nothing_sensitive(self):
        self.assertEqual(self.tables & self.FORBIDDEN, set())

    def test_every_allowed_table_is_named_by_a_read_tool_or_the_kb_resolver(self):
        """Trace each grant back to a consumer, so none is granted 'just in case'."""
        search = (REPO / "agents" / "search" / "main.py").read_text(encoding="utf-8")
        advisor = (REPO / "agents" / "advisor" / "main.py").read_text(encoding="utf-8")
        resolver = (REPO / "agents" / "_shared" / "kb_resolver.py").read_text(encoding="utf-8")
        corpus = search + advisor + resolver
        for table in self.tables:
            self.assertIn(
                table, corpus,
                f"{table} is granted but no read consumer mentions it",
            )


class TheAgentsUseTheReadOnlyCredential(unittest.TestCase):
    """The wiring: which secret ARN actually reaches the Data API."""

    BASE_ENV = {
        "AURORA_CLUSTER_ARN": CLUSTER_ARN,
        "AURORA_SECRET_ARN": ADMIN_ARN,
        # Keep kb_resolver off the (mocked) network path.
        "KB_ID": "kb-test",
    }

    def _query(self, agent: str, env: dict, sql: str = "SELECT 1 FROM people"):
        module = load_agent(agent, env={**self.BASE_ENV, **env})
        fake = FakeRds({"columnMetadata": [], "records": []})
        module._rds = fake
        result = module.query_graph(sql)
        return module, fake, result

    def test_read_only_secret_is_used_when_configured(self):
        for agent in ("search", "advisor"):
            with self.subTest(agent=agent):
                _, fake, _ = self._query(agent, {"AURORA_READONLY_SECRET_ARN": READONLY_ARN})
                self.assertEqual(fake.calls[-1]["secretArn"], READONLY_ARN)

    def test_admin_secret_requires_explicit_development_fallback(self):
        for agent in ("search", "advisor"):
            with self.subTest(agent=agent):
                _, fake, _ = self._query(agent, {"AURORA_READONLY_SECRET_ARN": "",
                    "APP_ENV": "development", "ALLOW_UNSAFE_SQL_ADMIN_FALLBACK": "true"})
                self.assertEqual(fake.calls[-1]["secretArn"], ADMIN_ARN)

    def test_empty_reader_fails_before_agent_can_query(self):
        for agent in ("search", "advisor"):
            with self.subTest(agent=agent), self.assertRaises(RuntimeError):
                self._query(agent, {"AURORA_READONLY_SECRET_ARN": "  ", "APP_ENV": "production"})

    def test_a_permission_error_is_not_retried_on_the_admin_secret(self):
        """Fail closed.

        ``permission denied for table people`` is exactly the error an
        injection can provoke on purpose. Retrying it on a writable credential
        would turn the boundary into a speed bump.
        """
        class Denying:
            def __init__(self):
                self.calls = []

            def execute_statement(self, **kwargs):
                self.calls.append(kwargs)
                raise RuntimeError("permission denied for table people")

        for agent in ("search", "advisor"):
            with self.subTest(agent=agent):
                module = load_agent(agent, env={
                    **self.BASE_ENV, "AURORA_READONLY_SECRET_ARN": READONLY_ARN,
                })
                denying = Denying()
                module._rds = denying
                with self.assertRaises(RuntimeError):
                    module.query_graph("SELECT 1 FROM people")
                self.assertEqual(len(denying.calls), 1, "the failure was retried")
                self.assertEqual(denying.calls[0]["secretArn"], READONLY_ARN)

    def test_the_regex_guard_still_runs_under_the_read_only_role(self):
        """Defence in depth: the role does not switch the guard off.

        A rejected statement must still cost zero round trips.
        """
        for agent in ("search", "advisor"):
            with self.subTest(agent=agent):
                _, fake, result = self._query(
                    agent,
                    {"AURORA_READONLY_SECRET_ARN": READONLY_ARN},
                    "WITH gone AS (DELETE FROM people RETURNING *) SELECT * FROM gone",
                )
                self.assertIn("error", json.loads(result))
                self.assertEqual(fake.calls, [], "a rejected statement reached Aurora")


class TheCredentialSelector(unittest.TestCase):
    """``_shared/db_credentials.py`` in isolation."""

    def setUp(self):
        sys.path.insert(0, str(REPO / "agents"))
        from _shared import db_credentials  # noqa: PLC0415
        self.mod = db_credentials

    def _with_env(self, **env):
        from unittest import mock
        return mock.patch.dict("os.environ", env, clear=True)

    def test_prefers_the_read_only_arn(self):
        with self._with_env(AURORA_SECRET_ARN=ADMIN_ARN, AURORA_READONLY_SECRET_ARN=READONLY_ARN):
            self.assertEqual(self.mod.read_secret_arn(), READONLY_ARN)
            self.assertTrue(self.mod.read_only_enforced())

    def test_explicit_development_fallback(self):
        with self._with_env(AURORA_SECRET_ARN=ADMIN_ARN, APP_ENV="development", ALLOW_UNSAFE_SQL_ADMIN_FALLBACK="true"):
            self.assertEqual(self.mod.read_secret_arn(), ADMIN_ARN)
            self.assertFalse(self.mod.read_only_enforced())

    def test_missing_reader_fails_closed_even_with_production_fallback_flag(self):
        for env in ({}, {"APP_ENV": "production", "ALLOW_UNSAFE_SQL_ADMIN_FALLBACK": "true"}):
            with self.subTest(env=env), self._with_env(AURORA_SECRET_ARN=ADMIN_ARN, **env):
                with self.assertRaises(RuntimeError):
                    self.mod.read_secret_arn()

    def test_diagnosis_says_which_boundary_is_live(self):
        """Two states that look identical from outside must not read identically."""
        with self._with_env(AURORA_SECRET_ARN=ADMIN_ARN, AURORA_READONLY_SECRET_ARN=READONLY_ARN):
            enforced = self.mod.credential_diagnosis()
        with self._with_env(AURORA_SECRET_ARN=ADMIN_ARN):
            not_enforced = self.mod.credential_diagnosis()
        self.assertNotEqual(enforced, not_enforced)
        self.assertIn("orgiq_graph_reader", enforced)
        self.assertIn("sql_guard", not_enforced)
        self.assertIn("docs/readonly-graph-role.md", not_enforced)


class TheCdkWiring(unittest.TestCase):
    """Read the stacks as text — there is no CDK test runner in this repo.

    Weaker than a synthesised template, and named as such: these assert the
    source says the right thing, not that CloudFormation received it. `cdk
    synth` needs live credentials for context lookups, which this environment
    does not have.
    """

    AURORA = AURORA_STACK.read_text(encoding="utf-8")
    RUNTIME = RUNTIME_STACK.read_text(encoding="utf-8")

    def test_aurora_mints_a_separate_secret_with_a_generated_password(self):
        self.assertIn("orgiq_graph_reader", self.AURORA)
        self.assertIn("generateStringKey: 'password'", self.AURORA)
        self.assertIn("aurora-readonly-secret-arn", self.AURORA)

    def test_generated_password_excludes_the_characters_the_applier_cannot_inline(self):
        """`ALTER ROLE ... PASSWORD` takes no bind parameter, so the applier
        inlines the value. Quote/backslash/dollar must never be generated."""
        match = re.search(r"excludeCharacters:\s*'([^\n]*?)',", self.AURORA)
        self.assertIsNotNone(match, "no excludeCharacters on the generated password")
        excluded = match.group(1).replace("\\\\", "\\")
        for ch in ("'", '"', "\\", "$", ";"):
            self.assertIn(ch, excluded, f"generated password may contain {ch!r}")

    def test_only_search_and_advisor_read_as_the_read_only_role(self):
        match = re.search(r"READ_AGENTS\s*=\s*new Set<[^>]*>\(\[(.*?)\]\)", self.RUNTIME, re.DOTALL)
        self.assertIsNotNone(match)
        self.assertEqual(set(re.findall(r"'([a-z-]+)'", match.group(1))), {"search", "advisor"})

    def test_the_secret_grant_is_a_swap_not_an_addition(self):
        """A read agent that can still fetch the admin secret has no boundary."""
        self.assertIn(
            "resources: [useReadOnlySecret ? readOnlySecretArn! : props.auroraCredentialsSecretArn]",
            self.RUNTIME,
        )

    def test_readonly_cannot_be_disabled_in_a_deployed_runtime(self):
        self.assertIn("readOnlyGraphRole cannot be disabled", self.RUNTIME)
        self.assertIn("APP_ENV: 'production'", self.RUNTIME)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
