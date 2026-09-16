"""Turn an RDS Data API result-size failure into a message the model can act on.

Why this exists
----------------
``search`` and ``advisor`` hand *model-authored* SQL to the RDS Data API via
``query_graph`` (see ``sql_guard.py``). Nothing bounds how much that SQL can
ask for — no injected ``LIMIT``, no row cap, no column cap (deliberately: see
``sql_guard.py``'s own module docstring on why a silent ``LIMIT`` injection is
not an obviously safe fix). So the Data API's own result-size ceiling is the
only thing that ever stops an unbounded ``SELECT *`` — and per AWS's docs it
does not truncate silently:

    "If the binary response data from the database is more than 1 MB, the
    call is terminated."
    — https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_ExecuteStatement.html

    "In this case, the size of the result set returned by the database was
    too large. The Data API limit is 1 MiB in the result set returned by the
    database."
    — https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.troubleshooting.html
      ("Database response exceeded size limit")

The modeled exception for this on Aurora Serverless v2 / provisioned clusters
(what this project runs — see CLAUDE.md) is ``UnsupportedResultException``
("The size was too large", HTTP 400); ``BadRequestException`` is the same
failure on Serverless v1, which this project does not use. There is also a
distinct per-row cap ("Packet for query is too large" — 64 KB per row),
raised the same way.

Without this module, that exception propagates out of ``query_graph``
uncaught. It does **not** crash the turn and does **not** surface as a
misleading empty result: the Strands ``@tool`` decorator (`decorator.py`,
`strands-agents/harness-sdk`) wraps every tool call in a generic
``except Exception`` and returns a ``ToolResultEvent`` with
``status: "error"`` and ``content: [{"text": f"Error: {type(e).__name__} -
{e}"}]`` — the turn continues and the model sees the failure. But that text is
a raw botocore exception name and an AWS-internal phrase ("Database response
exceeded size limit") with no hint of what to do about it — exactly the gap
``sql_guard.py`` calls out for its own rejections: "'permission denied for
table people' reads to a model as a bug to route around; 'disallowed keyword
DELETE...' reads as a rule." This module gives the size failure the same
"rule, not a bug" treatment, in the same ``{"error": ...}`` JSON shape
``query_graph`` already returns for a guard rejection — no SQL is rewritten,
no LIMIT is injected, no result is altered on success.

Usage in a ``query_graph`` tool::

    try:
        response = _rds.execute_statement(...)
    except Exception as exc:
        msg = result_size_error(exc)
        if msg:
            return json.dumps({"error": msg})
        raise  # anything else keeps today's behaviour (generic tool error)

Stdlib only, no boto3 — matches, deliberately, testable anywhere.
"""

from __future__ import annotations

#: Exception class names botocore raises for this family of failure. Matched
#: by name, not by isinstance, because the actual classes are generated at
#: runtime by botocore's error factory from the service's Smithy model and
#: this module has no boto3 dependency to import them from.
_SIZE_EXCEPTION_NAMES = frozenset({"UnsupportedResultException", "BadRequestException"})

#: Substrings of the AWS-authored message that confirm a match on
#: ``_SIZE_EXCEPTION_NAMES`` is actually the size failure and not one of the
#: other conditions those two exception names cover — `UnsupportedResultException`
#: also fires for an unsupported data type or a multidimensional array, and
#: `BadRequestException` is the generic "error in the call or in a SQL
#: statement" bucket on Serverless v1. Checked case-insensitively.
_SIZE_MESSAGE_MARKERS = (
    "database response exceeded size limit",  # troubleshooting-guide wording
    "size was too large",  # API-reference wording (UnsupportedResultException)
    "packet for query is too large",  # per-row (64 KB) variant of the same family
)

#: The message returned to the model. Mirrors `sql_guard.REJECTION` in tone —
#: names the constraint and the fix, not the AWS internals.
RESULT_TOO_LARGE = (
    "Query result too large for the RDS Data API (its hard limit is ~1 MiB total, "
    "64 KB per row). Narrow the query: select fewer columns, add a more selective "
    "WHERE clause, aggregate instead of returning raw rows, or add LIMIT and page "
    "through the results."
)


def is_result_size_error(exc: BaseException) -> bool:
    """True when ``exc`` is the RDS Data API's result-too-large failure.

    Matched on the exception's class name plus a marker in its message, so an
    ``UnsupportedResultException`` raised for an unrelated reason (e.g. an
    unsupported column type) is not mistaken for this one.
    """
    if type(exc).__name__ not in _SIZE_EXCEPTION_NAMES:
        return False
    msg = str(exc).lower()
    return any(marker in msg for marker in _SIZE_MESSAGE_MARKERS)


def result_size_error(exc: BaseException) -> str | None:
    """``None`` when ``exc`` isn't a result-size failure; else the tool message.

    Usage mirrors ``sql_guard.read_only_error``::

        msg = result_size_error(exc)
        if msg:
            return json.dumps({"error": msg})
        raise
    """
    return RESULT_TOO_LARGE if is_result_size_error(exc) else None
