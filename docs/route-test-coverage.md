# Route ↔ test coverage

`scripts/validate-assessment-tenant.sh` has carried one check for months that
has repeatedly caught real gaps: **every mounted route on `routes/assessment.ts`
has a test.** This extends that guarantee to every router in the middleware —
440 routes at the time this was written, enumerated by
[`mock/core/wire/routes.ts`](../middleware/src/mock/core/wire/routes.ts) (the
same parser the wire-capture floor uses — no second implementation of "list
every route," which is how the wire snapshot's first baseline disagreed with
its own checker).

```bash
./scripts/validate-route-coverage.sh
cd middleware && npx tsx src/mock/core/coverage/scan.ts   # the report on demand
```

## How "has a test" is decided

[`mock/core/coverage/testCalls.ts`](../middleware/src/mock/core/coverage/testCalls.ts)
walks every `*.test.ts(x)` file under `middleware/src` with the TypeScript
parser and pulls out every `request(<app>).<method>(<path>)` call — supertest
against a locally built Express app, which is the one signal in this repo that
a route was actually invoked rather than merely imported or mentioned in a
comment. A route and a call match
([`mock/core/coverage/scan.ts`](../middleware/src/mock/core/coverage/scan.ts))
when the method agrees, the segment count agrees, and every `/`-segment pair
agrees — where a route's `:param` or a call's templated segment (`` `/api/bots/${id}` ``)
counts as agreeing with anything.

The path argument is resolved in three tiers, in order: a plain string or
template literal is used as-is; a bare identifier is checked against a
same-file `const name = '/literal'`; failing that, the call is matched against
**every** path-shaped string literal anywhere in the file (a deliberate
over-approximation — the handful of real cases in this repo are `for (const
path of [...])` and `it.each([[path, ...], ...])` tables, and reconstructing
destructured-array binding for three call sites was not worth the surface
area). An argument this cannot resolve at all (a bare `bot.id`, not inside a
template) credits nothing — a false negative, not a crash.

## What this proves, and what it does not

Say it out loud so nobody over-trusts it, same as `docs/mock-floor.md` does
for the wire-capture floor:

- **A route having *a* test says nothing about whether the test is any good.**
  This check cannot see the assertion. A test that calls
  `request(app).get('/api/bots')` and asserts nothing but `res.status` counts
  exactly the same as one that pins the full response shape, an empty-state,
  and a 403 boundary. "Tested" here means "invoked," not "specified."
- **It cannot see whether the assertion matches the route's contract.** A test
  that calls the right path and asserts the wrong thing entirely still counts.
- **Two ways to be wrong in either direction.** False positive: the file-wide
  fallback (tier 3 above) can credit a route because some *unrelated* literal
  in the same test file happens to look like its path, even though the loop
  that actually calls it iterates a different array. False negative: a route
  invoked only via a call this parser cannot statically resolve (a computed
  path built by a helper function, a path assembled with string
  concatenation instead of a template literal) is reported untested even
  though a real request happens.
- **A route only exercised through another router's mount test does not
  count against the OTHER router.** The router recorded is the one that
  declares the route (`wire/routes.ts`'s `source`), which is correct — but a
  thin router that is only ever hit by a parent integration test still shows
  up as "untested" here even if, in aggregate, a request does reach it.
- **Static, not dynamic.** Like the wire-capture floor, this reads source; it
  does not run the suite. A call inside `it.skip(...)` or a dead helper
  nobody invokes still counts as coverage.

## The ratchet

`scripts/route-coverage-budget.txt` holds the ceiling on untested routes —
same contract as `scripts/orgiq-raw-budget.txt` and
`scripts/mock-aggregate-budget.txt`. It may only go down. The validator fails
if the live untested count exceeds the budget (a route lost its test, or a
new route shipped with none) and notes when the budget is stale (coverage
improved and the file wasn't lowered to match).

## Why only a handful of routes got new tests here

440 routes and 260 without a test is the honest number (268 before the tests
below), and closing all of it is not one slice of work. Eight routes across
three write-surfaces were picked instead, chosen for where an untested
regression is actually dangerous rather than merely uncovered:

- **`PATCH /api/capabilities/guardrail/pii`, `POST`/`PATCH`/`DELETE
  /api/capabilities/guardrail/topics(/:name)`** — these mutate Bedrock
  Guardrails content-safety config (PII redaction, denied topics) and sit
  behind a two-layer gate: a blanket `ManageDevbox` on every mutation on the
  router, plus a second `requireAction('EditGuardrail')` on these four routes
  specifically. A regression dropping the second gate (e.g. a refactor that
  reused the blanket middleware instead of the per-route one) would silently
  let anyone who can spend AgentCore budget also disable content moderation.
  `capabilities-mutation-gate.test.ts` pins the exact gate-construction
  sequence — one `ManageDevbox`, then four `EditGuardrail` — so a route
  losing or gaining a gate changes the count. It also covers
  `DELETE /code-sessions/:sessionId` (a real, destructive AgentCore call)
  specifically to show the *other* point on the matrix: a mutation that is
  gated by `ManageDevbox` alone, on purpose — and `GET /guardrail` as the
  negative control proving reads never touch the gate. Six routes from this
  one file.
- **`POST /api/session/masquerade/stop`** — the one route whose entire job is
  handing impersonated authority back to the operator. Every other
  masquerade test in this repo covers *entering* impersonation; nothing
  covered *leaving* it. A regression here (restoring the wrong identity,
  keeping `act` set, dropping the operator's frozen epoch) is a
  privilege-retention bug, not a cosmetic one.
  `session-masquerade-stop.test.ts` pins the 400 when there is no
  masquerade to stop, and that stop restores the operator's own identity
  (not the impersonated target's) with `act` cleared.
- **`DELETE /api/admin/kb-registry/:id`** — the in-app trigger for the
  exact KB-deletion failure mode CLAUDE.md already documents as having
  happened once: a knowledge base four other CDK stacks import by id,
  deleted out-of-band, unrecoverable via CFN alone. `kb-admin-delete.test.ts`
  pins the 404-before-mutating boundary and that deprovisioning is genuinely
  fire-and-forget — the request must never hang or fail because the
  background Bedrock/Aurora teardown does.

These 15 test cases are not a claim that the other 260 gaps are safe — they are
the ones judged most expensive to leave silently broken, worked in the time
available. The ranked list `validate-route-coverage.sh` prints is the actual
backlog.
