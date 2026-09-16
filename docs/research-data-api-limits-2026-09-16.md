# RDS Data API result-size limit vs. model-authored SQL — 2026-09-16

## Headline

Not a crash, not a silent truncation, not a misleading empty result. The
Strands `@tool` decorator already catches *any* exception a tool raises —
including this one — and turns it into a `ToolResultEvent(status="error")`
the model sees and can retry from; the turn does not die. That's genuinely
good news and the reason this isn't a "ship a LIMIT injector" report.

The real gap was narrower: `query_graph` let the raw botocore exception
(`UnsupportedResultException — Database response exceeded size limit`)
reach the model verbatim, instead of the same "rule, not a bug" phrasing
`sql_guard.py` already uses for its own rejections. Fixed by catching that
one specific failure and returning `{"error": "<actionable text>"}` — same
shape `query_graph` already returns for a guard rejection. No SQL is
rewritten, no LIMIT is injected, nothing about a *successful* query changes.

## 1. What the RDS Data API does at the limit

From the AWS API reference for `ExecuteStatement`
(<https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_ExecuteStatement.html>):

> If the binary response data from the database is more than 1 MB, the call
> is terminated.

And from its `Errors` section:

> **UnsupportedResultException** — There was a problem with the result
> because of one of the following conditions: It contained an unsupported
> data type. It contained a multidimensional array. **The size was too
> large.** HTTP Status Code: 400

> **BadRequestException** — There is an error in the call or in a SQL
> statement. **(This error only appears in calls from Aurora Serverless v1
> databases.)** HTTP Status Code: 400

This project runs Aurora Serverless v2 (CLAUDE.md, "Aurora Serverless v2
has a 0.5-ACU minimum"), so the exception that actually fires here is
`UnsupportedResultException`, not `BadRequestException` — the latter is the
v1-only name, which is easy to assume incorrectly from memory.

The Aurora User Guide troubleshooting page
(<https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.troubleshooting.html>)
gives the human-readable framing, under "Database response exceeded size
limit":

> In this case, the size of the result set returned by the database was too
> large. The Data API limit is 1 MiB in the result set returned by the
> database. To solve this issue, make sure that calls to Data API return 1
> MiB of data or less. If you need to return more than 1 MiB, you can use
> multiple `ExecuteStatement` calls with the `LIMIT` clause in your query.

There is also a distinct, smaller per-row cap, "Packet for query is too
large":

> the result set returned for a row was too large. The Data API size limit
> is 64 KB per row.

Both are **hard terminations with a named exception**, not silent
truncation. `formatRecordsAs: JSON` does not sidestep this — it has its own,
larger cap on the `formattedRecords` string (10 MB, per the same API
reference), but neither agent sets `formatRecordsAs`; both use the default
`records` shape, so the 1 MiB / 64 KB limits are the ones that apply here.

## 2. What each agent does today (before this change)

Both `search/main.py` and `advisor/main.py` define `query_graph(sql)`
identically for this purpose: after `sql_guard.read_only_error(sql)` passes,
they called `_rds.execute_statement(...)` with no `try`/`except` around it.
An oversized result raised `UnsupportedResultException` straight out of the
tool function.

Traced the actual path that exception takes:

1. `query_graph` is wrapped by `@instrumented_tool` (`agents/_shared/instrumentation.py:582`),
   which is explicit that it **does not swallow**: "if the call raises,
   records `errored=True` + message AND re-raises — the agent's
   error-handling path is untouched."
2. `@instrumented_tool` sits *inside* `@tool` (Strands' decorator,
   `strands-py/src/strands/tools/decorator.py` in
   `strands-agents/harness-sdk` — this package was renamed from
   `strands-agents/sdk-python`; the old repo path 404s now). That decorator
   wraps every tool invocation in `except Exception as e:` and converts it
   into:
   ```python
   yield self._wrap_tool_result(
       tool_use_id,
       {"toolUseId": tool_use_id, "status": "error",
        "content": [{"text": f"Error: {error_type} - {error_msg}"}]},
       exception=e,
   )
   ```
   (`decorator.py:673-685`). This is unconditional — every tool in the
   framework gets this, not something these agents opted into.

So **before this change**, the model would have seen a tool result like:

```
Error: UnsupportedResultException - An error occurred (UnsupportedResultException)
when calling the ExecuteStatement operation: The size was too large.
```

That is not a crash and not a false "no results" — the turn continues and
the model can see something failed. But it's a raw AWS exception name and
phrase, not guidance, which matters because `sql_guard.py`'s own docstring
states the design bar for these messages explicitly: `"permission denied for
table people" reads to a model as a bug to route around; "disallowed keyword
'DELETE'..." reads as a rule.` The pre-existing size-limit message read as
the former, not the latter.

## 3. Does the middleware already defend against this?

Yes, but with a defense that cannot transfer to the agents. `middleware/src/providers/aurora.ts`'s
`exec()` (:119-139) has **no** try/catch around `ExecuteStatementCommand`
either — same as the agents, if it hit the limit it would throw uncaught.
It doesn't hit the limit because every call site hand-writes SQL with a
literal, developer-chosen, clamped `LIMIT`:

```
290:const PEOPLE_GRAPH_LIMIT = 500;
304:    [intParam('lim', Math.max(1, Math.min(limit, PEOPLE_GRAPH_LIMIT)))],
611:  const limit = Math.max(1, Math.min(opts.limit ?? 25, 200));   // leaderboard
660:  const limit = Math.max(1, Math.min(opts.limit ?? 25, 100));  // skill leaderboard
698:  const lim = Math.max(1, Math.min(limit, 100));                // top skills
```

This works because the middleware controls 100% of the SQL text — a human
wrote every query and chose every `LIMIT` up front. That's structurally
unavailable to `query_graph`: the whole point of the tool is that the
*model* writes the SQL, so there is no fixed query shape a developer can
pre-bound the same way without deciding, on the model's behalf, what "enough
rows" means for a question the developer hasn't seen. This is exactly the
tension the task brief calls out: an injected `LIMIT` "changes results
silently." The middleware's approach avoids that tension by never handing
SQL-authorship to anything the developer didn't write; the agents can't
borrow the technique, only the reasoning that hard-coded LIMIT
avoids the size failure — which is why this fix treats the failure as an
error to explain, not a query to rewrite.

## 4. Does anything bound what the model can ask for?

No. Read `agents/_shared/sql_guard.py` end to end: it checks that the
statement is a single `SELECT`/`WITH`, strips comments and literals before
scanning, and rejects a fixed list of write/escalation verbs
(`_FORBIDDEN`, lines 87-97). There is no `LIMIT` injection, no row cap, no
column-count cap, nothing that bounds result *size* at all — that was never
its job; `check_read_only()` (lines 198-229) is purely about
read-only-ness. `db_credentials.py` is credential selection
(admin vs. `orgiq_graph_reader`), also unrelated to size. So today a
`SELECT * FROM mentions` (or any unfiltered join) is syntactically legal
under the guard and will run all the way to Aurora before failing — costing
a real round trip and ACU time before the model learns anything.

## 5. Does `turn-tool-calls.ts`'s tail-trimming interact with this?

No — it's on a different axis of the pipeline and doesn't touch the
size-limit failure at all. `middleware/src/lib/turn-tool-calls.ts` only
runs **after** a turn has already completed successfully, when the
middleware persists that turn's tool calls to AgentCore Memory for
transcript restore (`recordTurn`). It never sits between `query_graph` and
the model live — by the time it runs, the model has already produced its
answer from whatever `query_graph` actually returned.

Two things it does NOT do to a `query_graph` result specifically:

- Its "trim from the tail" behavior (`capToolCalls`, :162-173, dropping
  whole calls from the end of the array when the envelope exceeds
  `MAX_ENVELOPE_CHARS`) operates on **which tool calls** are kept in a turn,
  not on rows inside one result.
- The per-call result capping (`capOne`, :121-156) tries
  `distillRetrievalResult` first — but that function only recognizes
  KB-retrieval-shaped payloads (`{source/uri/sourceUri}` fields, per
  `distillRetrievalResult`'s doc comment). A `query_graph` result is an
  array of arbitrary row objects keyed by column name, so
  `distillRetrievalResult` returns `null` for it and `capOne` falls through
  to plain `clampText` — a byte-level truncation of the *front* 4000
  characters of the JSON string, dropping everything after (the tail of the
  byte stream, not "the tail of a ranked list"). That can leave invalid JSON
  in storage, but nothing reads it back as JSON for `query_graph`: the
  portal's SQL-table chip (`answerSources.ts:235` `tablesInSql`) parses the
  stored **`args`** (the SQL text) for table names, never the stored
  `result`. So this truncation is cosmetic — a possibly-broken `result`
  string sits in Memory, unused.

The tail-trimming the CLAUDE.md gotcha warns about ("discards the most
relevant document first") is specifically about `distillRetrievalResult`'s
doc list for **KB retrieval** results (`kb_resolver.py:76-77` cites the same
mechanism), which is a different tool (`query_knowledge_base`) and a
different failure (ranking, not size). It doesn't reach `query_graph`.

## Recommendation and tradeoff

**Implemented**: `agents/_shared/result_size_guard.py` — a small, shared
helper that recognizes the RDS Data API's result-too-large failure (by
exception class name + a message-marker check, since `UnsupportedResultException`
and `BadRequestException` both cover other conditions too) and returns a
fixed, actionable message:

> "Query result too large for the RDS Data API (its hard limit is ~1 MiB
> total, 64 KB per row). Narrow the query: select fewer columns, add a more
> selective WHERE clause, aggregate instead of returning raw rows, or add
> LIMIT and page through the results."

Wired into both `search/main.py` and `advisor/main.py`'s `query_graph`: the
`execute_statement` call is now in a `try`/`except Exception`; only a
confirmed size failure gets this message (`json.dumps({"error": ...})`,
matching the existing guard-rejection shape); anything else `raise`s
unchanged, so every other failure mode (timeout, permission denied,
throttling, etc.) keeps exactly today's behavior — the generic Strands
tool-error wrapper.

**Tradeoff, stated explicitly**: this does not make an oversized query
cheaper. The round trip to Aurora, and the ACU time it costs, still happens
before the model learns the query was too big — the fix only makes what the
model does *next* better-informed, not the first attempt free. A pre-flight
`LIMIT` injection would avoid that round trip, but the task brief is right
that it's not obviously safe: it would silently change what a successful
query returns (e.g. silently drop rows the model asked for and never told
it was incomplete), which is a worse failure mode than a slower, honest
error. Catching and explaining was preferred over injecting for that reason.

Not implemented, and deliberately out of scope for this narrow fix: no row
cap, column cap, or LIMIT default in `sql_guard.py` itself — that's the
middleware-style "developer bounds the query" pattern, which (per §3) can't
transfer to model-authored SQL without deciding on the model's behalf what
"enough" means, changing answers, not just guarding them.

## Verification

```
cd agents/_shared && ../../.venv-synth/bin/python -m unittest test_result_size_guard test_sql_guard -v
```

48 tests, exit code 0 (12 new in `test_result_size_guard`, 36 pre-existing in
`test_sql_guard`, unchanged and still passing).
