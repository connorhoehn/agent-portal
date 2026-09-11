#!/usr/bin/env python3
"""Do the capability ids in middleware/.env.aws still name anything real?

`OrgIQ-AgentCoreCapabilities` mints a fresh id every time it is recreated, and
nothing regenerates `.env.aws`. So after a rebuild the middleware keeps calling
resources that no longer exist, and each one fails in its own unhelpful way:

  - the Code Interpreter says "not found", naming an id nobody recognises
  - the browser says "Browser profile not found" and surfaces as a bare 500
  - site-survey's browser fallback fails *soft* — a dead BROWSER_ID is
    indistinguishable from "this site has no JavaScript-only pages"

CLAUDE.md writes the remedy down as prose ("reconcile with
`aws bedrock-agentcore-control list-browsers | list-browser-profiles |
list-code-interpreters | list-memories`"), which means it is done by hand every
rebuild, or forgotten. This is that paragraph, executable.


Why this stands BESIDE schema/dump-stack-outputs.sh rather than extending it
---------------------------------------------------------------------------
`dump-stack-outputs.sh` is a *generator*: it reads CloudFormation outputs and
rewrites the whole of `.env.aws` unconditionally. Three reasons that is the
wrong place for this:

1. It is destructive by construction. The live file carries keys the generator
   does not emit at all (`SESSION_SIGNING_SECRET_ARN`, `CANARY_NAME`,
   `BROWSER_PROFILE_ID`), so running it to fix one stale id silently drops
   them. A diagnostic has to be safe to run when you do not yet know what is
   wrong — this one writes nothing unless you pass --write, and even then edits
   only the specific lines it can justify.
2. It answers a different question. The generator can tell you what CFN says;
   it cannot tell you that the id you are already running with is dead. The
   whole finding is that nobody *knows* the file has rotted.
3. The capability ids are not reliably CFN outputs anyway. They come from the
   AgentCore control plane, which is the only authority on what currently
   exists in the account — the same place a human would look.

The two compose: run this to learn what is stale; run `dump-stack-outputs.sh`
when you want the whole file regenerated from a fresh stack.


Testability
-----------
Everything that decides anything is pure and lives above the AWS boundary:
`parse_env`, `classify`, `render_report`, `rewrite_env_text`. They take an
inventory dict and return verdicts and text. `schema/test_reconcile_capabilities.py`
drives all of them with fixtures and no credentials.

The only unverified-without-an-account part is `live_inventory()`, which shells
out to the AWS CLI. Its response parsing is not guessed: the array member and
id field for each call were read out of the botocore service model for
`bedrock-agentcore-control` and `bedrock`, and the test asserts the spec table
against that model when botocore is importable (it is, in .venv-synth).


Usage
-----
    .venv-synth/bin/python -m schema.reconcile_capabilities            # report only
    .venv-synth/bin/python -m schema.reconcile_capabilities --write    # offer to fix
    .venv-synth/bin/python -m schema.reconcile_capabilities --json     # machine-readable

Exit code is 1 when anything is STALE, so it can gate a deploy script.
Read-only: it makes List* and GetCallerIdentity calls and nothing else.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Callable, Iterable, Sequence

DEFAULT_ENV_FILE = "middleware/.env.aws"

# Byte-for-byte the regex in middleware/src/config.ts. See parse_env.
_ENV_LINE = re.compile(r"^([A-Z_][A-Z0-9_]*)=(.*)$")

# ---------------------------------------------------------------------------
# The spec table: what to check, and where the account's own answer lives.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CapabilitySpec:
    """One env var, and the List call that is authoritative for it."""

    key: str  # env var name in .env.aws
    label: str  # human name, used in the report
    resource: str  # inventory bucket key
    argv: tuple[str, ...]  # aws CLI argv after `aws`
    list_field: str  # array member in the response
    id_field: str  # id member inside each element
    hint: str  # what breaks when this one is stale


SPECS: tuple[CapabilitySpec, ...] = (
    CapabilitySpec(
        "MEMORY_ID", "Memory", "memory",
        ("bedrock-agentcore-control", "list-memories"), "memories", "id",
        "agent memory reads/writes fail; conversations lose continuity",
    ),
    CapabilitySpec(
        "BROWSER_ID", "Browser", "browser",
        ("bedrock-agentcore-control", "list-browsers"), "browserSummaries", "browserId",
        "site-survey's browser fallback fails SOFT — reads as 'no JS-only pages'",
    ),
    CapabilitySpec(
        "BROWSER_PROFILE_ID", "Browser profile", "browserProfile",
        ("bedrock-agentcore-control", "list-browser-profiles"), "profileSummaries", "profileId",
        "'Browser profile not found', surfaced as a bare 500",
    ),
    CapabilitySpec(
        "CODE_INTERPRETER_ID", "Code Interpreter", "codeInterpreter",
        ("bedrock-agentcore-control", "list-code-interpreters"), "codeInterpreterSummaries", "codeInterpreterId",
        "the Code Interpreter says 'not found', naming an id nobody recognises",
    ),
    # Guardrails rot on exactly the same schedule and matter more: the
    # supervisor attaches a role-specific guardrail at model-build time, so a
    # stale id here means answers going out without the policy they should
    # carry. Same classify() code, three more rows.
    CapabilitySpec(
        "GUARDRAIL_ID_MEMBER", "Guardrail (member)", "guardrail",
        ("bedrock", "list-guardrails"), "guardrails", "id",
        "the member role's guardrail is not applied",
    ),
    CapabilitySpec(
        "GUARDRAIL_ID_ORG_LEADER", "Guardrail (org leader)", "guardrail",
        ("bedrock", "list-guardrails"), "guardrails", "id",
        "the org-leader role's guardrail is not applied",
    ),
    CapabilitySpec(
        "GUARDRAIL_ID_HR_ADMIN", "Guardrail (HR admin)", "guardrail",
        ("bedrock", "list-guardrails"), "guardrails", "id",
        "the hr-admin role's guardrail is not applied",
    ),
)

# READY / ACTIVE / AVAILABLE are the same thing said three ways by three
# services. Flagging one of them reads as a problem when it is not.
HEALTHY_STATUSES = frozenset({"READY", "ACTIVE", "AVAILABLE"})

CURRENT = "current"
STALE = "stale"
UNSET = "unset"
UNKNOWN = "unknown"


@dataclass
class Finding:
    key: str
    label: str
    state: str
    configured: str | None
    detail: str
    hint: str
    aws_status: str | None = None
    # Live ids of the same resource kind, for the rewrite offer.
    candidates: list[str] = field(default_factory=list)
    # True when the launching shell exports this var with a value that differs
    # from the file's. `shadowed_by` is what the shell actually says, and it
    # may legitimately be the empty string — a shell that BLANKS a var (as
    # `npm run dev:mock` does for POLICY_STORE_ID) shadows it just as hard as
    # one that overrides it, so the flag is separate from the truthiness of
    # the value.
    shadowed: bool = False
    shadowed_by: str = ""

    @property
    def broken(self) -> bool:
        return self.state == STALE


# ---------------------------------------------------------------------------
# Pure: parse
# ---------------------------------------------------------------------------


def parse_env(text: str) -> dict[str, str]:
    """Parse .env.aws exactly the way middleware/src/config.ts does.

    config.ts matches /^([A-Z_][A-Z0-9_]*)=(.*)$/ and does no unquoting, no
    interpolation, no `export ` prefix, no trailing-comment stripping. Parsing
    it more cleverly here would make this tool disagree with the process it is
    supposed to be describing, so it does not.
    """
    out: dict[str, str] = {}
    for line in text.splitlines():
        m = _ENV_LINE.match(line)
        if m:
            out[m.group(1)] = m.group(2)
    return out


# ---------------------------------------------------------------------------
# Pure: classify
# ---------------------------------------------------------------------------


def classify(
    env: dict[str, str],
    inventory: dict[str, list[dict[str, str | None]] | None],
    shell_env: dict[str, str] | None = None,
    specs: Sequence[CapabilitySpec] = SPECS,
) -> list[Finding]:
    """Compare configured ids against what the account actually holds.

    `inventory` maps a spec's `resource` to a list of {id, status} rows, or to
    None when that List call could not be made. None is deliberately NOT the
    same as an empty list: an empty list is a definite "this account has none
    of these", while None says nothing at all about the configured id, and
    reporting the second as the first is how a broken laptop turns into a
    false "your infrastructure is gone".
    """
    shell_env = shell_env if shell_env is not None else {}
    findings: list[Finding] = []

    for spec in specs:
        configured = (env.get(spec.key) or "").strip()

        # Requirement 3, checked before anything else: config.ts only fills
        # vars that are `undefined`, so an export in the launching shell wins
        # over the file. If we did not surface this, --write would "fix" a file
        # the running process is not reading, and the report would be a lie.
        shadowed = False
        shadow_value = ""
        raw_shell = shell_env.get(spec.key)
        if raw_shell is not None and raw_shell.strip() != configured:
            shadowed, shadow_value = True, raw_shell.strip()
            # Judge the value the middleware will really use, not the file's.
            configured = shadow_value
        shade = {"shadowed": shadowed, "shadowed_by": shadow_value}

        rows = inventory.get(spec.resource, None)
        candidates = [r["id"] for r in rows if r.get("id")] if rows else []

        if not configured:
            findings.append(Finding(
                spec.key, spec.label, UNSET, None,
                f"{spec.key} is not set — the capability is simply unavailable, "
                f"which is a different thing from broken.",
                spec.hint, candidates=candidates, **shade,
            ))
            continue

        if rows is None:
            findings.append(Finding(
                spec.key, spec.label, UNKNOWN, configured,
                f"could not list {spec.label.lower()} resources — this says nothing "
                f"about whether {configured} is valid.",
                spec.hint, **shade,
            ))
            continue

        hit = next((r for r in rows if r.get("id") == configured), None)
        if hit is None:
            detail = (
                f"{configured} does not exist in this account."
                if candidates
                else f"{configured} does not exist, and this account has no "
                     f"{spec.label.lower()} resources at all."
            )
            findings.append(Finding(
                spec.key, spec.label, STALE, configured, detail, spec.hint,
                candidates=candidates, **shade,
            ))
            continue

        status = hit.get("status")
        detail = (
            f"present, but AWS reports {status}"
            if status and status not in HEALTHY_STATUSES
            else "present in this account"
        )
        findings.append(Finding(
            spec.key, spec.label, CURRENT, configured, detail, spec.hint,
            aws_status=status, candidates=candidates, **shade,
        ))

    return findings


def proposed_updates(findings: Iterable[Finding]) -> tuple[dict[str, str], list[Finding]]:
    """Which stale keys can be fixed without guessing, and which cannot.

    A single live candidate is an unambiguous replacement. Two or more is a
    choice, and this script does not get to make it — picking the first would
    be a coin flip that looks like a fix. Those come back in the second list so
    the operator is told to choose.
    """
    updates: dict[str, str] = {}
    ambiguous: list[Finding] = []
    for f in findings:
        if not f.broken:
            continue
        if len(f.candidates) == 1:
            updates[f.key] = f.candidates[0]
        else:
            ambiguous.append(f)
    return updates, ambiguous


# ---------------------------------------------------------------------------
# Pure: rewrite
# ---------------------------------------------------------------------------


def rewrite_env_text(text: str, updates: dict[str, str]) -> str:
    """Replace the named keys in place, touching nothing else.

    Line-surgical on purpose. `.env.aws` is hand-annotated and carries keys no
    generator emits; a regenerate-from-scratch rewrite is how those get lost.
    Comments, ordering, blank lines and every unrelated key survive verbatim.
    """
    if not updates:
        return text
    remaining = dict(updates)
    out: list[str] = []
    for line in text.splitlines():
        eq = line.find("=")
        key = line[:eq] if eq > 0 and not line.lstrip().startswith("#") else None
        if key in remaining:
            out.append(f"{key}={remaining.pop(key)}")
        else:
            out.append(line)
    if remaining:
        out.append("")
        out.append("# Added by schema/reconcile_capabilities.py")
        out.extend(f"{k}={v}" for k, v in remaining.items())
    trailing = "\n" if text.endswith("\n") or not text else ""
    return "\n".join(out) + trailing


# ---------------------------------------------------------------------------
# Pure: render
# ---------------------------------------------------------------------------

_MARK = {CURRENT: "ok   ", STALE: "STALE", UNSET: "unset", UNKNOWN: "?    "}


def render_report(
    findings: Sequence[Finding],
    env_file: str = DEFAULT_ENV_FILE,
    account_note: str | None = None,
) -> str:
    lines: list[str] = [f"Capability reconciliation — {env_file}", ""]

    if account_note:
        lines += [account_note, ""]

    width = max((len(f.key) for f in findings), default=0)
    for f in findings:
        shown = f.configured or "(not set)"
        lines.append(f"  [{_MARK[f.state]}] {f.key.ljust(width)}  {shown}")
        if f.state in (STALE, UNKNOWN) or f.aws_status not in (None, *HEALTHY_STATUSES):
            lines.append(f"          {' ' * width}  {f.detail}")
        if f.state == STALE:
            lines.append(f"          {' ' * width}  when stale: {f.hint}")
            if f.candidates:
                lines.append(f"          {' ' * width}  live now: {', '.join(f.candidates)}")

    shadowed = [f for f in findings if f.shadowed]
    if shadowed:
        lines += [
            "",
            "SHADOWED BY THE SHELL — config.ts only fills vars that are undefined,",
            "so these are exported in your environment and the file's values are",
            "dead text. Editing the file will NOT change what the middleware uses:",
        ]
        for f in shadowed:
            shown = f.shadowed_by or "(blank)"
            lines.append(f"  {f.key}={shown}   (unset it, or fix it where you export it)")

    stale = [f for f in findings if f.broken]
    unknown = [f for f in findings if f.state == UNKNOWN]
    lines.append("")
    if stale:
        lines.append(f"{len(stale)} stale id(s): {', '.join(f.key for f in stale)}")
    if unknown:
        lines.append(
            f"{len(unknown)} unchecked (AWS not reachable): "
            f"{', '.join(f.key for f in unknown)} — verdict withheld, not 'fine'."
        )
    if not stale and not unknown:
        lines.append("Every configured capability id resolves.")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Impure: AWS. Everything below this line needs credentials.
# ---------------------------------------------------------------------------


def _aws_json(argv: Sequence[str], region: str) -> dict:
    proc = subprocess.run(
        ["aws", *argv, "--region", region, "--output", "json"],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout).strip().splitlines()
        raise RuntimeError(tail[-1] if tail else f"aws {' '.join(argv)} failed")
    return json.loads(proc.stdout or "{}")


def _paginate(spec: CapabilitySpec, region: str) -> list[dict[str, str | None]]:
    """Follow nextToken.

    CLAUDE.md already records this exact bug for ListPrompts: the un-paginated
    call returns the first page and silently misses the rest. Here a missed
    page reports a live id as STALE, which is worse than not checking.
    """
    rows: list[dict[str, str | None]] = []
    token: str | None = None
    for _ in range(20):  # bounded; 20 pages of 50 is far past anything real
        argv = [*spec.argv, "--max-results", "50"]
        if token:
            argv += ["--next-token", token]
        body = _aws_json(argv, region)
        for item in body.get(spec.list_field) or []:
            rows.append({"id": item.get(spec.id_field), "status": item.get("status")})
        token = body.get("nextToken")
        if not token:
            break
    return rows


def live_inventory(region: str, fetch: Callable[[CapabilitySpec, str], list] = _paginate) -> dict:
    """One List call per distinct resource kind. A failure is None, never [].

    `fetch` is injected so the tests can drive everything above this line
    without AWS.
    """
    inventory: dict[str, list | None] = {}
    for spec in SPECS:
        if spec.resource in inventory:
            continue
        try:
            inventory[spec.resource] = fetch(spec, region)
        except Exception:
            inventory[spec.resource] = None
    return inventory


def caller_account(region: str) -> str | None:
    try:
        return _aws_json(("sts", "get-caller-identity"), region).get("Account")
    except Exception:
        return None


def account_note(env: dict[str, str], live_account: str | None) -> str | None:
    """Guard against the loudest possible false positive.

    If the credentials point at a different account than the file was
    generated for, every single id will come back STALE and the report will
    read as "your entire stack is gone" when the truth is "you are logged into
    the wrong account". Say so before the table, not after it.
    """
    configured = (env.get("AWS_ACCOUNT_ID") or "").strip()
    if not live_account:
        return ("Could not resolve the calling account (credentials expired?). "
                "Any verdict below marked '?' is withheld for that reason.")
    if configured and configured != live_account:
        return (f"ACCOUNT MISMATCH: {DEFAULT_ENV_FILE} was generated for {configured}, "
                f"but these credentials are in {live_account}. Every 'STALE' below is "
                f"more likely to mean 'wrong account' than 'deleted resource'. "
                f"Fix the profile before you fix the file.")
    return None


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _repo_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main(argv: Sequence[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--env-file", default=None, help=f"default {DEFAULT_ENV_FILE}")
    ap.add_argument("--region", default=os.environ.get("AWS_REGION", "us-east-1"))
    ap.add_argument("--write", action="store_true", help="rewrite stale ids in place")
    ap.add_argument("--yes", action="store_true", help="skip the confirmation prompt")
    ap.add_argument("--json", action="store_true", dest="as_json")
    args = ap.parse_args(argv)

    path = args.env_file or os.path.join(_repo_root(), DEFAULT_ENV_FILE)
    try:
        with open(path, encoding="utf8") as fh:
            text = fh.read()
    except OSError as exc:
        print(f"cannot read {path}: {exc}", file=sys.stderr)
        return 2

    env = parse_env(text)
    inventory = live_inventory(args.region)
    findings = classify(env, inventory, shell_env=dict(os.environ))
    note = account_note(env, caller_account(args.region))

    if args.as_json:
        print(json.dumps({
            "envFile": path,
            "accountNote": note,
            "findings": [
                {k: v for k, v in f.__dict__.items()} | {"broken": f.broken}
                for f in findings
            ],
        }, indent=2))
    else:
        print(render_report(findings, env_file=path, account_note=note))

    updates, ambiguous = proposed_updates(findings)

    if ambiguous and not args.as_json:
        print("")
        for f in ambiguous:
            print(f"{f.key} is stale but has {len(f.candidates)} live candidates "
                  f"({', '.join(f.candidates)}) — pick one by hand; this will not guess.")

    if updates and not args.as_json:
        print("")
        print("Proposed rewrite:")
        for k, v in updates.items():
            print(f"  {k}: {env.get(k, '(unset)')} -> {v}")
        if not args.write:
            print("Re-run with --write to apply. Nothing has been changed.")
        else:
            if not args.yes:
                try:
                    if input(f"Rewrite {path}? [y/N] ").strip().lower() not in ("y", "yes"):
                        print("Not written.")
                        return 1
                except EOFError:
                    print("Not written (no tty; pass --yes).")
                    return 1
            with open(path, "w", encoding="utf8") as fh:
                fh.write(rewrite_env_text(text, updates))
            print(f"Rewrote {len(updates)} key(s) in {path}.")
            # The one thing a fixer must never do is claim a fix it did not
            # make. A shell export outranks the file, so a rewritten line the
            # process will never read is not a fix.
            still = [f for f in findings if f.key in updates and f.shadowed]
            for f in still:
                print(f"WARNING: {f.key} is still exported in your shell as "
                      f"{f.shadowed_by} — the middleware will use that, not the file. "
                      f"Run `unset {f.key}` in the shell you start it from.")

    return 1 if any(f.broken for f in findings) else 0


if __name__ == "__main__":
    raise SystemExit(main())
