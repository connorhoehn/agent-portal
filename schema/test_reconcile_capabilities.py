"""Offline tests for schema/reconcile_capabilities.py.

The point of this file is that the reconciler is judged without an account.
Everything that decides anything — parse, compare, classify, render, rewrite —
runs here against fixtures. A script whose only test is "it ran once against a
live account" is exactly what this replaces.

What is NOT covered here, and cannot be: the actual round trip to AWS. What IS
covered is the part of it that is guessable and therefore worth pinning — the
operation names and response member names in SPECS are asserted against the
real botocore service model (test_spec_table_matches_botocore), so a typo in
`browserSummaries` or `codeInterpreterId` fails here rather than in a live run.

    .venv-synth/bin/python -m unittest schema.test_reconcile_capabilities -v
"""

from __future__ import annotations

import unittest

from schema.reconcile_capabilities import (
    CURRENT,
    SPECS,
    STALE,
    UNKNOWN,
    UNSET,
    account_note,
    classify,
    live_inventory,
    parse_env,
    proposed_updates,
    render_report,
    rewrite_env_text,
)

# A trimmed .env.aws with the shape that matters: comments, blank lines, a
# section header, and one key (SESSION_SIGNING_SECRET_ARN) that
# dump-stack-outputs.sh does not emit — the one a full regenerate would drop.
SAMPLE_ENV = """\
# Aurora
AURORA_CLUSTER_ARN=arn:aws:rds:us-east-1:111122223333:cluster:orgiq-aurora
AWS_ACCOUNT_ID=111122223333

# Guardrail (per-role)
GUARDRAIL_ID_MEMBER=g-member
GUARDRAIL_ID_ORG_LEADER=g-leader
GUARDRAIL_ID_HR_ADMIN=g-hradmin

# AgentCore Memory
MEMORY_ID=orgiq_memory-LIVE

# AgentCore Capabilities
BROWSER_ID=orgiq_browser-DEAD
BROWSER_PROFILE_ID=orgiq_browser_profile-LIVE
CODE_INTERPRETER_ID=orgiq_code_interpreter-DEAD

SESSION_SIGNING_SECRET_ARN=arn:aws:secretsmanager:us-east-1:111122223333:secret:orgiq-session
"""


def inventory(**overrides):
    """A live account: one browser, one profile, one CI, one memory, 3 guardrails."""
    base = {
        "memory": [{"id": "orgiq_memory-LIVE", "status": "ACTIVE"}],
        "browser": [{"id": "orgiq_browser-NEW", "status": "READY"}],
        "browserProfile": [{"id": "orgiq_browser_profile-LIVE", "status": "READY"}],
        "codeInterpreter": [{"id": "orgiq_code_interpreter-NEW", "status": "READY"}],
        "guardrail": [
            {"id": "g-member", "status": "READY"},
            {"id": "g-leader", "status": "READY"},
            {"id": "g-hradmin", "status": "READY"},
        ],
    }
    base.update(overrides)
    return base


def by_key(findings):
    return {f.key: f for f in findings}


class ParseEnv(unittest.TestCase):
    def test_matches_config_ts_grammar(self):
        env = parse_env(SAMPLE_ENV)
        self.assertEqual(env["MEMORY_ID"], "orgiq_memory-LIVE")
        self.assertEqual(env["AWS_ACCOUNT_ID"], "111122223333")
        self.assertNotIn("# Aurora", env)

    def test_keeps_everything_after_the_first_equals(self):
        # ARNs and URLs carry '=' in query strings; splitting on every '='
        # would truncate them.
        env = parse_env("GATEWAY_URL=https://x/mcp?a=b=c\n")
        self.assertEqual(env["GATEWAY_URL"], "https://x/mcp?a=b=c")

    def test_ignores_comments_lowercase_and_blank_lines(self):
        env = parse_env("# NOT_A_KEY=1\n\nlower_case=2\n  INDENTED=3\nREAL=4\n")
        self.assertEqual(env, {"REAL": "4"})

    def test_blank_value_parses_as_empty_not_absent(self):
        # dump-stack-outputs.sh emits `KEY=` for anything unresolved; that is
        # "set to nothing", which classify must read as unset rather than
        # crash or treat as a literal id.
        self.assertEqual(parse_env("BROWSER_ID=\n"), {"BROWSER_ID": ""})


class Classify(unittest.TestCase):
    def test_the_three_stale_ids_from_the_finding(self):
        f = by_key(classify(parse_env(SAMPLE_ENV), inventory()))
        self.assertEqual(f["BROWSER_ID"].state, STALE)
        self.assertEqual(f["CODE_INTERPRETER_ID"].state, STALE)
        self.assertEqual(f["MEMORY_ID"].state, CURRENT)
        self.assertEqual(f["BROWSER_PROFILE_ID"].state, CURRENT)
        self.assertTrue(f["BROWSER_ID"].broken)
        self.assertFalse(f["MEMORY_ID"].broken)

    def test_stale_names_the_live_replacement(self):
        f = by_key(classify(parse_env(SAMPLE_ENV), inventory()))
        self.assertEqual(f["BROWSER_ID"].candidates, ["orgiq_browser-NEW"])
        self.assertIn("orgiq_browser-DEAD", f["BROWSER_ID"].detail)

    def test_unset_is_not_stale(self):
        env = parse_env(SAMPLE_ENV)
        env["BROWSER_ID"] = ""
        f = by_key(classify(env, inventory()))
        self.assertEqual(f["BROWSER_ID"].state, UNSET)
        self.assertFalse(f["BROWSER_ID"].broken)

    def test_unreachable_service_is_unknown_not_stale(self):
        # The distinction the whole tool rests on: a failed List call says
        # nothing about the id. Reporting it as stale turns an expired laptop
        # credential into "your infrastructure is gone".
        f = by_key(classify(parse_env(SAMPLE_ENV), inventory(browser=None)))
        self.assertEqual(f["BROWSER_ID"].state, UNKNOWN)
        self.assertFalse(f["BROWSER_ID"].broken)

    def test_empty_account_is_stale_not_unknown(self):
        # An empty list IS a definite answer: the account holds none of these.
        f = by_key(classify(parse_env(SAMPLE_ENV), inventory(browser=[])))
        self.assertEqual(f["BROWSER_ID"].state, STALE)
        self.assertIn("no browser resources at all", f["BROWSER_ID"].detail)

    def test_present_but_unhealthy_status_is_reported(self):
        inv = inventory(memory=[{"id": "orgiq_memory-LIVE", "status": "CREATING"}])
        f = by_key(classify(parse_env(SAMPLE_ENV), inv))
        self.assertEqual(f["MEMORY_ID"].state, CURRENT)
        self.assertIn("CREATING", f["MEMORY_ID"].detail)

    def test_ready_active_available_are_all_healthy(self):
        for status in ("READY", "ACTIVE", "AVAILABLE"):
            inv = inventory(memory=[{"id": "orgiq_memory-LIVE", "status": status}])
            f = by_key(classify(parse_env(SAMPLE_ENV), inv))
            self.assertEqual(f["MEMORY_ID"].detail, "present in this account")

    def test_guardrails_are_reconciled_too(self):
        f = by_key(classify(parse_env(SAMPLE_ENV), inventory(guardrail=[])))
        for key in ("GUARDRAIL_ID_MEMBER", "GUARDRAIL_ID_ORG_LEADER", "GUARDRAIL_ID_HR_ADMIN"):
            self.assertEqual(f[key].state, STALE, key)


class ShellShadowing(unittest.TestCase):
    """config.ts only fills vars that are `undefined`."""

    def test_shell_export_is_the_value_judged(self):
        # The file says DEAD, the shell says NEW. The process will use NEW, so
        # the verdict must be about NEW — reporting the file's dead id here
        # would send the operator to fix something that is already irrelevant.
        f = by_key(classify(
            parse_env(SAMPLE_ENV), inventory(),
            shell_env={"BROWSER_ID": "orgiq_browser-NEW"},
        ))
        self.assertEqual(f["BROWSER_ID"].state, CURRENT)
        self.assertTrue(f["BROWSER_ID"].shadowed)
        self.assertEqual(f["BROWSER_ID"].shadowed_by, "orgiq_browser-NEW")

    def test_shell_export_can_make_a_good_file_look_broken(self):
        f = by_key(classify(
            parse_env(SAMPLE_ENV), inventory(),
            shell_env={"MEMORY_ID": "orgiq_memory-GONE"},
        ))
        self.assertEqual(f["MEMORY_ID"].state, STALE)
        self.assertTrue(f["MEMORY_ID"].shadowed)

    def test_shell_blanking_a_var_counts_as_shadowing(self):
        # `POLICY_STORE_ID= npm run …` is a real pattern in this repo. The
        # empty string is falsy but it still wins over the file.
        f = by_key(classify(
            parse_env(SAMPLE_ENV), inventory(), shell_env={"MEMORY_ID": ""},
        ))
        self.assertEqual(f["MEMORY_ID"].state, UNSET)
        self.assertTrue(f["MEMORY_ID"].shadowed)

    def test_identical_shell_value_is_not_shadowing(self):
        f = by_key(classify(
            parse_env(SAMPLE_ENV), inventory(),
            shell_env={"MEMORY_ID": "orgiq_memory-LIVE"},
        ))
        self.assertFalse(f["MEMORY_ID"].shadowed)

    def test_report_warns_that_the_file_is_dead_text(self):
        findings = classify(
            parse_env(SAMPLE_ENV), inventory(), shell_env={"MEMORY_ID": "orgiq_memory-GONE"},
        )
        out = render_report(findings)
        self.assertIn("SHADOWED BY THE SHELL", out)
        self.assertIn("will NOT change what the middleware uses", out)


class ProposedUpdates(unittest.TestCase):
    def test_single_candidate_is_an_unambiguous_fix(self):
        updates, ambiguous = proposed_updates(classify(parse_env(SAMPLE_ENV), inventory()))
        self.assertEqual(updates, {
            "BROWSER_ID": "orgiq_browser-NEW",
            "CODE_INTERPRETER_ID": "orgiq_code_interpreter-NEW",
        })
        self.assertEqual(ambiguous, [])

    def test_two_candidates_is_a_choice_the_script_refuses_to_make(self):
        inv = inventory(browser=[
            {"id": "orgiq_browser-A", "status": "READY"},
            {"id": "orgiq_browser-B", "status": "READY"},
        ])
        updates, ambiguous = proposed_updates(classify(parse_env(SAMPLE_ENV), inv))
        self.assertNotIn("BROWSER_ID", updates)
        self.assertEqual([f.key for f in ambiguous], ["BROWSER_ID"])

    def test_unknown_is_never_rewritten(self):
        updates, _ = proposed_updates(classify(parse_env(SAMPLE_ENV), inventory(browser=None)))
        self.assertNotIn("BROWSER_ID", updates)


class RewriteEnvText(unittest.TestCase):
    def test_replaces_only_the_named_lines(self):
        out = rewrite_env_text(SAMPLE_ENV, {"BROWSER_ID": "orgiq_browser-NEW"})
        self.assertIn("BROWSER_ID=orgiq_browser-NEW", out)
        self.assertNotIn("orgiq_browser-DEAD", out)
        self.assertIn("CODE_INTERPRETER_ID=orgiq_code_interpreter-DEAD", out)

    def test_preserves_comments_blank_lines_and_unknown_keys(self):
        out = rewrite_env_text(SAMPLE_ENV, {"BROWSER_ID": "x"})
        self.assertIn("# AgentCore Capabilities", out)
        # The key dump-stack-outputs.sh would have silently dropped.
        self.assertIn("SESSION_SIGNING_SECRET_ARN=arn:aws:secretsmanager", out)
        self.assertEqual(len(out.splitlines()), len(SAMPLE_ENV.splitlines()))

    def test_no_updates_is_byte_identical(self):
        self.assertEqual(rewrite_env_text(SAMPLE_ENV, {}), SAMPLE_ENV)

    def test_absent_key_is_appended_and_labelled(self):
        out = rewrite_env_text(SAMPLE_ENV, {"WORKLOAD_IDENTITY_ARN": "arn:new"})
        self.assertIn("# Added by schema/reconcile_capabilities.py", out)
        self.assertIn("WORKLOAD_IDENTITY_ARN=arn:new", out)

    def test_does_not_rewrite_a_commented_out_key(self):
        out = rewrite_env_text("# BROWSER_ID=old\nBROWSER_ID=live\n", {"BROWSER_ID": "new"})
        self.assertIn("# BROWSER_ID=old", out)
        self.assertIn("BROWSER_ID=new", out)

    def test_round_trip_clears_the_findings(self):
        # The fix actually fixes: re-classify the rewritten file and nothing
        # is stale any more.
        findings = classify(parse_env(SAMPLE_ENV), inventory())
        updates, _ = proposed_updates(findings)
        again = classify(parse_env(rewrite_env_text(SAMPLE_ENV, updates)), inventory())
        self.assertEqual([f.key for f in again if f.broken], [])


class AccountNote(unittest.TestCase):
    def test_mismatch_is_called_out_before_the_table(self):
        note = account_note(parse_env(SAMPLE_ENV), "999988887777")
        self.assertIn("ACCOUNT MISMATCH", note)
        self.assertIn("111122223333", note)
        self.assertIn("999988887777", note)

    def test_matching_account_says_nothing(self):
        self.assertIsNone(account_note(parse_env(SAMPLE_ENV), "111122223333"))

    def test_no_credentials_explains_the_question_marks(self):
        note = account_note(parse_env(SAMPLE_ENV), None)
        self.assertIn("credentials expired", note)


class RenderReport(unittest.TestCase):
    def test_stale_row_carries_the_symptom_and_the_replacement(self):
        out = render_report(classify(parse_env(SAMPLE_ENV), inventory()))
        self.assertIn("[STALE] BROWSER_ID", out)
        self.assertIn("fails SOFT", out)  # the site-survey symptom
        self.assertIn("live now: orgiq_browser-NEW", out)
        self.assertIn("2 stale id(s)", out)

    def test_clean_account_says_so_plainly(self):
        env = parse_env(SAMPLE_ENV)
        env["BROWSER_ID"] = "orgiq_browser-NEW"
        env["CODE_INTERPRETER_ID"] = "orgiq_code_interpreter-NEW"
        out = render_report(classify(env, inventory()))
        self.assertIn("Every configured capability id resolves.", out)
        self.assertNotIn("STALE", out)

    def test_unknown_is_not_reported_as_fine(self):
        out = render_report(classify(parse_env(SAMPLE_ENV), inventory(browser=None)))
        self.assertIn("verdict withheld, not 'fine'", out)


class LiveInventory(unittest.TestCase):
    def test_one_call_per_resource_kind_not_per_env_var(self):
        # Three guardrail env vars must not mean three list-guardrails calls.
        calls = []

        def fetch(spec, region):
            calls.append(spec.resource)
            return []

        live_inventory("us-east-1", fetch=fetch)
        self.assertEqual(sorted(calls), sorted(set(calls)))
        self.assertEqual(len(calls), 5)

    def test_a_failing_call_becomes_none_not_empty(self):
        def fetch(spec, region):
            if spec.resource == "browser":
                raise RuntimeError("ExpiredToken")
            return []

        inv = live_inventory("us-east-1", fetch=fetch)
        self.assertIsNone(inv["browser"])
        self.assertEqual(inv["memory"], [])

    def test_one_dead_service_does_not_hide_the_others(self):
        def fetch(spec, region):
            if spec.resource == "guardrail":
                raise RuntimeError("AccessDenied")
            return [{"id": "x", "status": "READY"}]

        inv = live_inventory("us-east-1", fetch=fetch)
        self.assertIsNone(inv["guardrail"])
        self.assertEqual(len(inv["browser"]), 1)


class SpecTable(unittest.TestCase):
    def test_spec_table_matches_botocore(self):
        """The response parsing is model-checked, not guessed.

        `browserSummaries`/`browserId` and friends are the only part of this
        tool that could be wrong in a way the fixtures cannot catch, because
        the fixtures are written to the same assumption. botocore ships the
        real service model, so assert against that instead.
        """
        try:
            import botocore.session
        except ImportError:  # pragma: no cover - host python has no botocore
            self.skipTest("botocore unavailable — run under .venv-synth")

        sess = botocore.session.get_session()
        for spec in SPECS:
            service, cli_op = spec.argv[0], spec.argv[1]
            api_op = "".join(p.capitalize() for p in cli_op.split("-"))
            # list-code-interpreters -> ListCodeInterpreters
            model = sess.get_service_model(service)
            self.assertIn(api_op, model.operation_names, f"{service} {cli_op}")
            out = model.operation_model(api_op).output_shape
            self.assertIn(spec.list_field, out.members, f"{api_op} array member")
            item = out.members[spec.list_field].member
            self.assertIn(spec.id_field, item.members, f"{api_op} id field")
            self.assertIn("status", item.members, f"{api_op} status field")
            self.assertIn(
                "nextToken",
                model.operation_model(api_op).input_shape.members,
                f"{api_op} must be paginated",
            )

    def test_the_four_ids_from_the_gotcha_are_all_covered(self):
        keys = {s.key for s in SPECS}
        for expected in ("BROWSER_ID", "BROWSER_PROFILE_ID", "CODE_INTERPRETER_ID", "MEMORY_ID"):
            self.assertIn(expected, keys)


if __name__ == "__main__":
    unittest.main()
