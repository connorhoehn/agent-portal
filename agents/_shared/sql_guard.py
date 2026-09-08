"""Read-only SQL guard for the agents that hand model-authored SQL to Aurora.

Why this exists
---------------
``search`` and ``advisor`` expose a ``query_graph(sql)`` tool: the *model*
writes the SQL and the agent executes it verbatim through the RDS Data API.
When this module was written that call ran as a role that could write, and
this check was the only thing standing between a prompt injection in an
ingested document and ``DELETE FROM people`` — so it is a security boundary,
not a style rule.

Both agents used to carry their own copy of::

    _READONLY_RE = re.compile(r"^\\s*(WITH|SELECT)\\b", re.IGNORECASE)
    if not _READONLY_RE.match(sql) or ";" in sql.strip().rstrip(";"):
        reject()

That has a hole PostgreSQL opens and most other engines do not: a
**data-modifying CTE**. ``WITH gone AS (DELETE FROM people RETURNING *)
SELECT * FROM gone`` starts with ``WITH``, contains no semicolon, is a single
statement — and deletes the org graph. ``SELECT * INTO evil FROM people`` is
the same story with ``SELECT``. Neither is exotic; both are the first thing
anyone tries.

The guard here therefore does three things the regex could not:

1. **Neutralises comments and literals before matching.** ``--``/``/* */``
   comments and ``'...'`` / ``$tag$...$tag$`` / ``"..."`` quoted runs are
   blanked out first, so a keyword hidden in a comment cannot smuggle a write
   past the scan *and* a legitimate ``WHERE title = 'Update manager'`` cannot
   trip it. An unterminated quote or comment is rejected outright — if we
   cannot tell where the literal ends we cannot reason about the statement.
2. **Requires a single statement.** Any ``;`` outside a literal, other than a
   trailing one, is a reject.
3. **Rejects write verbs anywhere in the statement**, not just at the front —
   which is what closes the CTE hole.

Deliberately NOT here: a real SQL parser.

The braces have shipped
-----------------------
This module used to end by saying the correct fix was a database role with no
write grants, and that it was the belt to a missing braces. That role now
exists: ``orgiq_graph_reader`` (``schema/graph_readonly_role.sql``) holds
``SELECT`` on the org-graph tables and nothing else, owns nothing, carries no
escalation attribute, and runs pinned to
``default_transaction_read_only = on``. ``_shared/db_credentials.py`` selects
its credential for every ``query_graph`` call in an environment that has
applied the grant, so a write is refused by PostgreSQL rather than by a regex.
Runbook: ``docs/readonly-graph-role.md``.

This module stays exactly as it is, and is still the first line, for three
reasons:

*   An environment that has not applied the grant yet — a fresh cluster, a
    local ``agentcore dev``, a rebuild mid-runbook — falls back to the admin
    credential, and there this check is once again the whole boundary.
*   It rejects at the door, before a statement reaches Aurora, so a probing
    injection costs no round trip and no ACU.
*   It returns a reason the *model* can act on. ``permission denied for table
    people`` reads to a model as a bug to route around; "disallowed keyword
    'DELETE' in a read-only query" reads as a rule.

Defence in depth means both, not the newer one. Do not delete this because the
role exists.

Stdlib only, no boto3 — so it can be unit tested anywhere.
"""

from __future__ import annotations

import re

#: The message the tools return on rejection. Kept byte-identical to the
#: original so nothing downstream (or in a saved transcript) has to change.
REJECTION = "Only single read-only SELECT/WITH statements are allowed."

_LEADING_RE = re.compile(r"^\s*(WITH|SELECT)\b", re.IGNORECASE)

# Verbs that write, escalate, or read the host filesystem. Matched on word
# boundaries against the literal-stripped statement, so `created_at`,
# `update_ts`, `OFFSET` and friends do not trip them.
#
# `into` is here because PostgreSQL's `SELECT ... INTO new_table` is a CREATE
# TABLE in disguise; `nextval`/`setval` mutate sequences; the `pg_*`/`lo_*`
# entries reach outside the database entirely.
_FORBIDDEN = (
    "insert", "update", "delete", "merge", "truncate", "drop", "create",
    "alter", "grant", "revoke", "into", "copy", "vacuum", "reindex",
    "cluster", "refresh", "call", "do", "lock", "comment", "prepare",
    "execute", "deallocate", "discard", "listen", "notify", "unlisten",
    "checkpoint", "reassign", "import", "attach", "detach",
    "nextval", "setval", "dblink", "lo_import", "lo_export",
    "pg_read_file", "pg_read_binary_file", "pg_ls_dir", "pg_sleep",
    "pg_terminate_backend", "pg_cancel_backend", "pg_reload_conf",
    "pg_logical_emit_message",
)
_FORBIDDEN_RE = re.compile(
    r"\b(" + "|".join(re.escape(word) for word in _FORBIDDEN) + r")\b",
    re.IGNORECASE,
)


class _Unterminated(ValueError):
    """A quoted run or block comment that never closes."""


def strip_literals_and_comments(sql: str) -> str:
    """Blank out comments and quoted runs, preserving length and structure.

    Every removed character is replaced by a space so offsets, line breaks and
    word boundaries in the surviving text still line up with the original —
    which keeps ``^\\s*(WITH|SELECT)`` meaningful and keeps two adjacent
    keywords from being glued into one token by the removal.

    Raises ``_Unterminated`` when a quote or ``/* */`` never closes.
    """
    out: list[str] = []
    i = 0
    n = len(sql)
    while i < n:
        ch = sql[i]

        # -- line comment
        if ch == "-" and sql.startswith("--", i):
            while i < n and sql[i] != "\n":
                out.append(" ")
                i += 1
            continue

        # /* block comment */ — PostgreSQL nests these.
        if ch == "/" and sql.startswith("/*", i):
            depth = 0
            while i < n:
                if sql.startswith("/*", i):
                    depth += 1
                    out.append("  ")
                    i += 2
                elif sql.startswith("*/", i):
                    depth -= 1
                    out.append("  ")
                    i += 2
                    if depth == 0:
                        break
                else:
                    out.append("\n" if sql[i] == "\n" else " ")
                    i += 1
            if depth != 0:
                raise _Unterminated("unterminated block comment")
            continue

        # $tag$ dollar-quoted string $tag$ (the body of a PL/pgSQL DO block).
        if ch == "$":
            tag = re.match(r"\$[A-Za-z_][A-Za-z_0-9]*\$|\$\$", sql[i:])
            if tag:
                marker = tag.group(0)
                end = sql.find(marker, i + len(marker))
                if end < 0:
                    raise _Unterminated("unterminated dollar-quoted string")
                stop = end + len(marker)
                out.extend("\n" if c == "\n" else " " for c in sql[i:stop])
                i = stop
                continue

        # '...' string literal (doubled '' is an escaped quote) and "..."
        # quoted identifier — both can hide keywords, neither may contribute
        # one, so both are blanked.
        if ch in ("'", '"'):
            quote = ch
            out.append(" ")
            i += 1
            closed = False
            while i < n:
                if sql[i] == quote:
                    if i + 1 < n and sql[i + 1] == quote:  # '' / "" escape
                        out.append("  ")
                        i += 2
                        continue
                    out.append(" ")
                    i += 1
                    closed = True
                    break
                # Backslash escapes are NOT standard-conforming in PostgreSQL
                # (standard_conforming_strings = on), so a backslash is an
                # ordinary character here and must not extend the literal.
                out.append("\n" if sql[i] == "\n" else " ")
                i += 1
            if not closed:
                raise _Unterminated(f"unterminated {quote} quoted string")
            continue

        out.append(ch)
        i += 1

    return "".join(out)


def check_read_only(sql: object) -> tuple[bool, str]:
    """``(True, "")`` when ``sql`` is a single read-only statement.

    Otherwise ``(False, reason)`` — the reason names the specific rule that
    tripped, so an operator reading a transcript can tell "the model wrote a
    second statement" apart from "the model wrote a DELETE inside a CTE".
    """
    if not isinstance(sql, str) or not sql.strip():
        return False, "empty or non-string SQL"

    try:
        scrubbed = strip_literals_and_comments(sql)
    except _Unterminated as exc:
        return False, str(exc)

    if not _LEADING_RE.match(scrubbed):
        return False, "statement must begin with SELECT or WITH"

    # A trailing semicolon is fine; anything before the last non-space
    # character means a second statement was appended.
    body = scrubbed.rstrip()
    if body.endswith(";"):
        body = body[:-1]
    if ";" in body:
        return False, "only one statement may be submitted"

    hit = _FORBIDDEN_RE.search(scrubbed)
    if hit:
        # This is the data-modifying-CTE case in almost every real instance.
        return False, f"disallowed keyword {hit.group(1).upper()!r} in a read-only query"

    return True, ""


def read_only_error(sql: object) -> str | None:
    """``None`` when ``sql`` may run; else the message the tool should return.

    Usage in an agent tool::

        err = read_only_error(sql)
        if err:
            return json.dumps({"error": err})
    """
    ok, reason = check_read_only(sql)
    if ok:
        return None
    return f"{REJECTION} ({reason})"
