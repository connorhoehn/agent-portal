# Honesty checks: which of the four recurring bug classes a machine can catch

Over roughly forty fixes in one session, nearly all of them were instances of
four recurring shapes. This is the write-up for `scripts/validate-honest-numbers.sh`
— what it checks, why, its false-positive story, what it finds on the current
tree, and what it deliberately does not attempt.

## The four classes, and the verdict on each

### Class 1 — a total that is really the length of a capped page. **Checkable, high precision.**

Shape: `return { entries, total: entries.length }` where `entries` was itself
truncated (`.slice(0, limit)`, or a SQL query with `LIMIT` and no paired
`count(*)`). The tell is mechanical: the reported total can never exceed the
page size, and the code that produces it is a small, local, syntactic pattern
— no cross-file reasoning needed.

This is the strongest of the four. It is a Node/TypeScript-AST scanner
(`scripts/lib/honest-numbers-scan.cjs`) because a plain grep can't reliably
find "which variable got `.slice()`'d earlier in this same function" — it
walks every function body (named declarations, arrow functions assigned to a
const, and anonymous handlers passed straight to `asyncHandler(...)`, which is
most of `routes/`), and flags a `total: X.length` where either `X` was itself
produced by a `.slice(...)` in the same function, or the function's only SQL
query has `LIMIT` with no `count(` anywhere alongside it.

**Proof it would have caught the real bug**: run against
`git show 294822c^:middleware/src/providers/aurora.ts` (the commit
before "feat(scale): honest counts, bounded reads, visible truncation"), it
flags all four of `realGetLeaderboard`, `realGetSkillLeaderboard`,
`mockGetLeaderboard`, `mockGetSkillLeaderboard` — exactly the four functions
that commit fixed, and exactly the two different shapes (JS `.slice()` for the
mocks, SQL `LIMIT`-with-no-`count` for the real queries). The validator runs
this as a standing calibration check on every invocation, not just once by
hand — see "Builds are not the only thing that regresses" below.

**Current finding: 0.** The team already swept this class; the budget is a
hard 0 (any finding fails the build), not a ratchet, because this is a proven
bug shape with a demonstrated zero false-positive rate on this codebase.

### Class 2 — a column rendered that the query never selects. **Checkable, but only the server half.**

The real example (`routes/quality.ts`'s RATIONALE/COST columns) has two
halves: the SQL never selected `judge_rationale` etc., AND the portal
rendered a column for it anyway. Only the first half is checkable from here.

The second half — "a portal table column reads `row.x` where the route's
response type has no `x`" — needs a type checker that spans both
`middleware/` and `portal/`, which don't share a types package; portal
hand-writes its own local interfaces matching each JSON shape, and matching
them back to the middleware response type by inspection, project-wide, is a
job for a human doing a design review, not a script. I did not build this
half. (It's also the half CLAUDE.md's Runs-page example turns out to need: "Prompt
ver." and "Cost" were declared fields that a *different data source* — the
live in-memory ring vs. the CloudWatch-poller-fed trace — structurally can't
produce; that's not a missing SQL column, it's two code paths disagreeing
about what a row is, and no static scan of one file sees that.)

What IS checkable: within one middleware file, does a row-mapper read
`r['some_col']` when no SELECT in that file's SAT produces `some_col` (raw or
as an alias)? This is the same AST scanner as class 1
(`scripts/lib/honest-numbers-scan.cjs`), reusing the same per-function walk.
It extracts every backtick SQL template in a function, splits the column list
on TOP-LEVEL commas (so `COALESCE(a, b) AS x, y` counts as 2 columns, not 3;
so does depth-tracking to find the real `FROM` instead of the first textual
one — `EXTRACT(EPOCH FROM ts)` isn't the query's FROM clause, and matching
plain `\bFROM\b` false-flagged an entire, entirely correct query the first time
this was tried), then checks every `r['x']` reference against that set.

**False-positive story, and how I got there.** The first cut flagged ~60
"missing" columns, nearly all wrong. Two causes, both fixed:
1. This codebase builds a lot of SQL by string-interpolating fragments
   (`` `SELECT ${legacySelect}${rollupSelect} FROM ...` ``) — the real column
   list is invisible to a single-file text scan. The scanner now bails (skips
   the whole function, reports nothing) whenever `${` appears inside the
   *column list* specifically. It used to bail on `${` anywhere in the query,
   which was equally wrong the other way — a dynamic `WHERE ${sinceClause}`
   with an entirely literal, fully-checkable SELECT list was being thrown out
   too, and that's most queries in this codebase.
2. `EXTRACT(EPOCH FROM ts)` inside the column list breaks a naive
   `SELECT...FROM` regex, as above.

After both fixes: **0 false positives across `middleware/src/{routes,
providers, mock}`**, and it still catches the bug. I don't have a clean
single historical commit that isolates just "SQL omits a column the mapper
already reads" — the real Quality-page fix landed the interface field, the
mapper line, and the SQL column together in one commit (23b4320), so there's
no git blob where only the omission half exists. Proof instead: take the
*current, correct* `quality.ts`, delete `judge_rationale` from its SELECT
list (leaving the mapper unchanged), and confirm the scanner flags exactly
that line. The validator does this as a standing calibration check, same as
class 1.

**Current finding: 0.**

### Class 3 — a failed read rendered as an empty one. **Checkable, narrow, needs a human for the rest.**

The real shape: fourteen places used `EmptyState` on error instead of
`UnavailableNotice`, and "several pages never destructured `error`/`degraded`
from `useFetch` at all" (the CLAUDE.md phrasing this class is named after).
The second half of that sentence IS mechanically checkable; the first half —
"is THIS EmptyState render reachable when error is truthy" — is flow-sensitive
(which branch of a conditional render executes) and I didn't attempt it.

`scripts/lib/honest-numbers-emptystate.cjs` flags a `.tsx` page that (a) calls
`useFetch(...)` at least once, (b) renders a bare `<EmptyState` (not
`<SmartEmptyState`, which already takes a `degraded` prop and does the
UnavailableNotice-or-EmptyState branching internally — see
`portal/src/components/observability/SmartEmptyState.tsx`), and (c)
destructures neither `error` nor `degraded` out of ANY `useFetch` call in the
file. That's a file-level check, not a call-site one: if a page has two
`useFetch` calls and only one is checked for error, the page is NOT flagged
even if the unchecked one is the one feeding the EmptyState. I chose precision
over recall here on purpose — a call-site-accurate version needs to know
*which* fetched data feeds *which* rendered EmptyState, which is a real
data-flow question this scanner doesn't attempt, and a version that guesses
wrong reads as noise fast.

I also tried, and dropped, a second rule: "`<SmartEmptyState>` used without a
`degraded=` prop." It has exactly the failure mode the task warns about —
`InvocationSearchPage.tsx` matched it and is a false positive: it handles the
error case with its own separate branch above the `SmartEmptyState` render
(`{applied && error && <ErrorState .../>} {applied && !error && <SmartEmptyState .../>}`),
which is a legitimate alternative to passing `degraded=`. Telling that apart
from a real gap needs the same flow analysis as the dropped stricter class-3
rule, so I left it out rather than ship a check people would learn to ignore.

**Current finding: 4** (`portal/src/pages/ingest/CrawlTargetsPage.tsx`,
`RunHistoryPage.tsx`, `SchedulesPage.tsx`,
`portal/src/pages/observability/InvocationsPage.tsx`). Spot-checked
`InvocationsPage.tsx` by hand: all three of its `useFetch` calls omit
`error`/`degraded`, and its one `<EmptyState` has no failed-read branch
anywhere in the file — a real, live instance of this class, still on `main`
as of this writing. Ratcheted at budget 4
(`scripts/honest-numbers-class3-budget.txt`) — these are candidates for human
triage, not verdicts, so the script reports and ratchets rather than hard-
failing at 0. Calibration: `portal/src/pages/work/FindingsPage.tsx`, which
DOES destructure `findingsError`/`findingsDegraded` and IS correctly left
unflagged, runs on every invocation as the negative control.

### Class 4 — a measurement where there is none. **Only checkable as a candidate list; every hit needs a human.**

This is the softest class, and I want to be honest about why. "0 defaults to
mean 'nothing happened' when it should mean 'nothing measured'" is a judgment
about what a specific value MEANS, not a syntactic pattern. Two of the four
sub-shapes in the task are flatly not attempted:

- **A rolling mean initialized to 0** — this is about a *stateful* value's
  starting condition, which requires understanding the state machine (is this
  read before the first update ever lands, or after), not something visible
  in one function's text.
- **A guardrail alarm computed from ONE call** — "is N samples enough to
  alarm on" is a statistical/domain judgment with no syntactic signature at
  all; a `count === 1` check would be indistinguishable from ordinary
  threshold logic.

What I did build, as three regex shapes over `middleware/src/{routes,
providers, lib}`, unioned and deduped by file:line:
1. `Number(r['col'] ?? 0)` where the destination field name (same line) looks
   like a measurement — `p50`, `avg`, `mean`, `rate`, `sla`, `score`,
   `latency`, `fraction`, `percentile` — as opposed to a genuine count
   (`pendingCount`, `invocations`, `cnt`), where 0 really is the honest
   value. Filtering by field name against ~90 raw hits of the bare pattern
   brings it down to exactly the 2 real ones on this tree.
2. SQL-side `COALESCE(col, 0) AS <measurement-name>` — the same bug one layer
   down, in the query instead of the JS mapper.
3. A ternary that special-cases the zero-denominator branch and returns a
   *literal* number instead of `null`, in either operand order
   (`count > 0 ? a/b : 0` and `count === 0 ? 0 : a/b`).

**This list is candidates, not verdicts — read it as such.** Confirmed real
by inspection: `middleware/src/routes/oncall.ts:592-595` — `p50DecisionSeconds`
and `p99DecisionSeconds` are `Number(r['p50_s'] ?? 0)` (a SQL
`PERCENTILE_CONT` over zero rows returns NULL, silently coerced to 0ms), and
`slaCompliantFraction: slaTotal > 0 ? withinSla / slaTotal : 1` reports 100%
SLA compliance for a window with zero decisions — this is the literal "SLA
100.0% over zero decisions" example from the task description, still live on
`main`, never mentioned in any of the fix commits I could find. Same bug,
same file, at `memory.ts:234-235` (`COALESCE(p.p50_ms, 0) AS p50_ms`).
Confirmed FALSE positive by inspection:
`middleware/src/providers/prompt-evals.ts:137` —
`output.trim().length === 0 ? 0 : output.trim().split(/\s+/).length` is
computing a word count, and 0 words for empty text is simply true, not a
lie. The rest I have not individually adjudicated; that's the triage this
doc explicitly hands off, per the task's "do not fix the findings" instruction.

**Current finding: 22**, ratcheted at that count
(`scripts/honest-numbers-class4-budget.txt`). Calibration: the pre-fix
`harness.ts` blob at `85c00bd^` (`avgDurationMs`'s `n === 0 ? 0 : total / n`,
fixed the same day) still matches the "count===0 ? literal : ratio" shape —
run on every invocation.

## What the script does, end to end

`scripts/validate-honest-numbers.sh`, following the conventions of the
existing `scripts/validate-*.sh` (ok/fail/section helpers, prints every
failing line in one run, `--quick` skips `tsc`, exits 0 only when everything
passes):

1. Runs `scripts/lib/honest-numbers-scan.cjs` once (classes 1 + 2 share one
   AST pass) against `middleware/src/{routes,providers,mock}`. Budget: **0**,
   not ratcheted — hard-fails on any finding.
2. Runs a calibration section: checks the pre-fix `aurora.ts` blob
   (`294822c^`) still flags all four leaderboard-total bugs, and a
   synthetically-regressed `quality.ts` (one column deleted from its own
   SELECT) still flags that column. This exists so a future edit to the
   scanner that quietly loses detection power shows up as a failure here,
   not as a silent "0 findings" that means "not looking" instead of "all
   clear".
3. Runs `scripts/lib/honest-numbers-emptystate.cjs` against
   `portal/src/pages`. Budget: ratchet, seeded at **4**
   (`scripts/honest-numbers-class3-budget.txt`). Calibration:
   `FindingsPage.tsx` (a real page that DOES check `error`/`degraded`) must
   stay unflagged.
4. Runs the three class-4 grep shapes against `middleware/src/{routes,
   providers,lib}`, unions and dedupes by file:line. Budget: ratchet, seeded
   at **22** (`scripts/honest-numbers-class4-budget.txt`). Calibration: the
   pre-fix `harness.ts` blob (`85c00bd^`) still matches.
5. `tsc --noEmit` on both `middleware` and `portal` (skipped under `--quick`)
   — this validator only reads source, so a break here would mean something
   else regressed, but it's cheap insurance and matches convention.

All four `scripts/lib/*.cjs` scanners also accept explicit file paths as
CLI args (instead of walking the default directories), which is how the
calibration sections point them at temp-file blobs without needing a second
code path.

## What this proves, and what it doesn't

Classes 1 and 2 (server half) are genuine, provable bugs with a demonstrated
0% false-positive rate on this codebase and a demonstrated catch of the real
historical bugs — those get a hard 0 budget. Classes 3 and 4 are legitimately
softer: class 3's rule is deliberately narrower than the real bug (file-level,
not call-site) so it under-catches rather than over-flags; class 4 is a
candidate list where roughly 1 in 10 hits I checked by hand was a false
positive (a genuinely-honest zero), so every hit needs a person, not a CI
gate that blocks a PR. Both are ratcheted rather than hard-failed for exactly
that reason — the mechanism (a number rising, not passing/failing a fixed
line) matches how sure I actually am about them.

Not attempted at all, and why: class 2's portal-column-vs-response-type half
(cross-project type matching, no shared types package); class 3's "is this
EmptyState reachable when error is true" (flow-sensitive, single strongest
signal I tried — `SmartEmptyState` without `degraded=` — had a real false
positive in the first file it touched); class 4's stateful-initial-value and
sample-size-based-alarm sub-shapes (both are semantic/statistical judgments
with no syntactic signature).
