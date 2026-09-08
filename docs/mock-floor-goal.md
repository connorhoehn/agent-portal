# Goal: every fixture in `dev:mock` stands on the floor

`scripts/validate-mock-floor.sh` is the only judge. Work the backlog in order,
run the script after every slice, treat each failing line as the next task. No
`npm install` (offline). Fixtures go through `middleware/src/mock/core/` —
`defineFixture` for rows, `clock` for instants, `countBy`/`sumBy` for anything
countable. The working manual is `docs/mock-floor.md`; the reasoning and the
five bugs are in `middleware/src/mock/core/contract.ts`.

## Why

Five classes of bug shipped out of hand-rolled fixtures, and a human audit —
not a test — found every one of them:

1. **Typed aggregates.** A count written beside the rows it claims to count.
   "5 bots" over an empty table; a team reading "New · 17/17" on a team of
   nine; a banner saying "6 pending" above 5 cards; a Health summary promising
   25 errors over a list that could only show 6. Each was right the day it was
   written and wrong the first time either side moved.
2. **Invented wire strings.** A fixture keyed `enterprise` while the server
   sent `enterprise_context`. The unit test used the fixture's key, so the test
   agreed with the code and both disagreed with the server. Six documents were
   unreachable on `/assessment/enterprise`, the rail read "Nothing here yet",
   and every check was green.
3. **Import-time timestamps.** `new Date(Date.now() - 3 * HOUR)` evaluated at
   module scope means three hours before the *process started*. Near UTC
   midnight it put "today's" run in yesterday, and `deriveBotStats` bucketed in
   local time on top of it, so the mock and Aurora disagreed for the first few
   hours after midnight — on a laptop, silently.
4. **No scenario control.** To audit an empty state an auditor mutated shared
   `dev:mock` state and warned the next auditor in prose:
   "`promo-aurora-cold-start` is now Promoted until the middleware restarts."
5. **Providers with no mock branch.** A surface that is blank offline, where an
   unbuilt feature and an unseeded one look identical.

The floor landed with a contract, a clock, a registry, a scenario control plane
(`/api/__mock/*`), a seed-parity harness and a wire capture — and **no judge**.
Every other goal in this repo has one. Without it the floor is a convention,
and a convention is what produced all five bugs.

## Definition of done (what the validator checks)

1. **Builds.** `middleware` `tsc --noEmit` clean, `npm test` green — the parity
   suites (`core/parity`) and the wire suites (`core/wire`) are part of that
   run, so a fixture that drifts from `schema/*.sql`, or a route table that
   drifts from the snapshot, fails here first.
2. **Rule 1 — no typed aggregates.** A count/total/rate/average assigned a
   non-zero literal in `middleware/src/mock/**` or `middleware/src/providers/**`,
   ratcheted against `scripts/mock-aggregate-budget.txt` (baseline **29** when
   the judge was written, already down to **17** after `mock/ingest-sources.ts`
   was deleted; may only be lowered). This is a heuristic; what it can and
   cannot see is written
   out in `docs/mock-floor.md` § The judge. It goes down by deriving the number
   with `countBy`/`sumBy` — never by deleting a leaf metric to buy a point.
3. **Rule 3 — timestamps come from the clock.** Zero `Date.now()`, zero
   no-argument `new Date()`, zero literal ISO timestamps anywhere under
   `middleware/src/mock/**` outside `core/clock.ts`. Not a ratchet: the fix is
   mechanical (`clock.nowIso()`, `clock.hoursAgo(n, { keepWithinToday: true })`,
   `clock.daysAgo(n)`) and the bug it prevents is invisible for 20 hours a day.
4. **Rule 4 — every mounted route has a mock branch.** No GET route recorded as
   `HTTP 500` in the wire capture, unless it is listed in
   `scripts/mock-floor-exemptions.txt` **with a reason**. An exemption that
   stops 500ing is reported as stale and must be deleted.
5. **Rule 5 — fixtures are registered.** Every `defineFixture` module is
   reachable from `src/index.ts` by the import graph (a module nothing imports
   registers nothing, so `GET /api/__mock/state` cannot list it and `resetAll`
   skips it); keys unique; no production fixture passes `registry:` to opt out
   of the shared registry.
6. **Rule 6 — the wire snapshots are current.** `snapshots/routes.json` equals
   the live router table exactly, with no unresolved mounts; `wire.json` covers
   every GET route in it; and `wire.json` is newer than every route/provider/mock
   source, because rule 4 believes the capture and a stale capture would let a
   newly broken route pass.
7. **Docs.** `docs/mock-floor.md` (the manual, including a `## The judge`
   section stating the blind spots) and this file both exist.

## Backlog, in order

0. **Baseline.** Run `scripts/validate-mock-floor.sh`; record the counts. Lower
   `scripts/mock-aggregate-budget.txt` to the number the run prints if it is
   already below the baseline.
1. **Rule 3 to zero** — the smallest slice and the one with a real bug behind
   it. Replace each module-level `hoursAgo`/`daysAgo`/`ago` helper with the
   `clock` equivalent, and each `Date.now()` id suffix with something that is
   not a clock read. The fixtures' rows factories already run at read time, so
   this is a one-line change per helper.
2. **Rule 4 to zero** — four Aurora/SSM-backed GET routes still fall through to
   AWS in `dev:mock`. Each is a surface that is blank offline. Give each one a
   `config.mock.aurora` branch backed by a registered fixture (not an inline
   literal), or, if it genuinely cannot have one, add it to
   `scripts/mock-floor-exemptions.txt` with the reason.
3. **Adopt the floor in the remaining mock modules.** `defineFixture` +
   `clock` + `empty: () => []` for every module under `middleware/src/mock/`
   that still exports a bare array. A fixture with no `empty` scenario is not
   auditable for its empty state — that is the point of declaring one.
4. **Rule 1 down.** Per aggregate: if the rows are in the repo, derive it; if
   they are not, record the leaf metric in this file's list below so the next
   reader does not chase it. Lower the budget after every slice.
5. **Recapture and re-run.** Regenerate the wire snapshots (`docs/mock-floor.md`
   § Regenerating the snapshots) after any response shape changes, then a full
   validator run.

### Reviewed leaf metrics (rule 1 false positives)

Counts the heuristic flags that have **no rows in the repo to count**. They are
still in the budget — the budget is a shape count, not a bug count — but do not
"fix" them by inventing rows:

- `providers/promotions.ts` `supportCount` / `sessionCount` — evidence and
  session totals for a promotion candidate; the underlying rows live in
  CloudWatch and Aurora, not in the fixture.
- `mock/capabilities.ts` `executionCount` / `requestCount` — per-session
  counters from the AgentCore Code Interpreter and Browser; the fixture carries
  no execution rows.
- `providers/kb-reconcile.ts` `dataSourceCount`, `providers/assessment.ts`
  `evidence_count` — same shape.

`mock/traces.ts` `totalDurationMs` is **not** in this list: that fixture carries
its own spans, and the root span's `durationMs` is the number. It should be
derived.

## Rules that do not bend

- The validator is the judge; report real numbers from real runs.
- Never widen `scripts/mock-aggregate-budget.txt`.
- An exemption without a reason is not an exemption. Same contract as
  `mock/core/wire/allow.ts` and the parity harness's `knownDrift`.
- Aurora, SSM, CloudWatch, Bedrock and AgentCore are all mocked elsewhere in
  this middleware. A route reaching one of them with no mock branch is a gap,
  not an exemption; only a real third-party credential earns one.
- Never lower a count by deleting a field the portal reads. The floor exists to
  make the mock agree with the server, not to make the script green.
