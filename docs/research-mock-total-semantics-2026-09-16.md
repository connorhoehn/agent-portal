# `total` semantics: mock vs. real leaderboard — 2026-09-16

## Headline

The mock was wrong. `mockGetLeaderboard` and `mockGetSkillLeaderboard`
(`middleware/src/providers/aurora.ts`) reported `total` as the length of the
already-sliced page, while their real counterparts (fixed earlier the same
day, commit `294822c`) run a true `count(*)`/`count(DISTINCT ...)` over the
full filtered set. The pinning test
(`middleware/src/mock/__tests__/scores-seed-agreement.test.ts`,
`describe('nothing countable is stored')`) asserted the old, wrong behaviour
on purpose — but its own justification for doing so does not hold up: the
mock has the full filtered array sitting in memory a line before it slices
it. Counting it costs nothing and needs no new store. This is exactly the
mock floor's own rule (`docs/mock-floor.md`, `mock/core/contract.ts`): *a
fixture exports rows and selectors and never a number it could have counted
from rows it also exports.* Fixed both selectors and the test; no other
instance of the bug class was found in the mock layer.

## 1. Inventory — where `total` was derived from a page length

Searched the mock layer and `providers/aurora.ts`'s mock branch for any
selector that returns a count paired with a sliced/limited array
(`grep -rn "entries:.*total\|total:.*entries\|{ entries, total"`). Only two
hits, both in `providers/aurora.ts`:

- `mockGetLeaderboard` (was `providers/aurora.ts:1268-1277`) — `total:
  page.length` after `entries.slice(0, limit)`.
- `mockGetSkillLeaderboard` (was `providers/aurora.ts:1303-1314`) — `total:
  entries.length` where `entries` was already `.slice(0, limit)`'d.

No other function in `middleware/src/mock/*.ts` or `providers/*.ts` returns a
`{ rows/entries, total|count }`-shaped object at all — everything else
returning a paired count counts over an un-sliced group (e.g.
`observability-queries.ts`'s per-agent/per-user rollups count `group_.length`
over the full group before any `.slice()` is applied for a *different*,
unrelated top-N list; `mockMemoryStats`'s `total: group_.length` is the count
of one full group, not a page). The dozens of other `.slice(0, limit)` sites
across `observability-queries.ts`, `harness.ts`, `calibration.ts`,
`agent-project-runs.ts`, `prompt-versions.ts`, `github-runs.ts`,
`prompt-library.ts`, `local-compute.ts`, `sdlc.ts`, and `static-review.ts`
all return a plain `Row[]`/array with no accompanying total field, so there is
no drift to have.

One correct example of the right pattern already existed in the same file:
`cappedGraphPeople()` (`providers/aurora.ts:1146-1150`) computes `peopleTotal:
people.length` **before** `nodes: people.slice(0, PEOPLE_GRAPH_LIMIT)` — the
graph-total bug from the same "honest counts" pass (commit `294822c`) was
fixed correctly on the mock side; the leaderboard bug was not.

## 2. The pinning test's actual claim

`scores-seed-agreement.test.ts`, `describe('nothing countable is stored')`,
labelled point 4 in the file's header comment:

> 4. NO TYPED AGGREGATES. `total` is the length of the list it ships beside
>    and `mostRecentScoredAt` is a reduction over those rows; the skill
>    mention counts are counted from the person_skills edges, never stored.

And the test body itself:

```ts
it('reports `total` as the length of the page it ships', async () => {
  const page = await mockAurora.getLeaderboard({ limit: 12 });
  expect(page.entries).toHaveLength(12);
  expect(page.total).toBe(page.entries.length);
  const all = await mockAurora.getLeaderboard({ limit: 200 });
  expect(all.total).toBe(seedPeople.size);
});
```

The comment directly above `mockGetLeaderboard` made the same claim
explicitly: *"`total` counts the rows it ships beside — the page, the way
realGetLeaderboard reports it — not the size of the unpaged set."* That
clause — "the way realGetLeaderboard reports it" — is the tell: it describes
`realGetLeaderboard`'s *pre-`294822c`* behaviour. `realGetLeaderboard` no
longer reports `entries.length`; it runs `count(*)` (`providers/aurora.ts:610-657`,
commit `294822c`, "leaderboard and knowledge-base totals are real COUNT(*),
not page length"). The mock's comment was pinning agreement with a real
provider that, by the time of `294822c`, had already stopped behaving that
way — the two providers were left disagreeing by the same commit that closed
the gap for `peopleTotal`.

## 3. Decision, with the argument

**The mock was wrong; fixed to count.** Two independent reasons converge:

- **The stated reason doesn't apply.** "No typed aggregates" would be a good
  reason to keep `total` derived rather than stored — but deriving it as
  `page.length` and deriving it as `entries.length` (pre-slice, over the
  already-filtered-and-sorted array sitting in a local variable one line
  earlier) are *equally* derived, equally untyped, equally free of any new
  countable store. The mock floor's rule is about not inventing a stored
  number; it says nothing that prefers counting the wrong slice of an array
  you already have in hand. There was no genuine constraint here — unlike,
  say, `mostRecentScoredAt`, which the real query only ever computes over its
  own capped page (so the mock matching that behaviour is correct, not a
  shortcut).
- **A consumer reading `total` gets a different number depending on mode,
  silently, exactly the drift the mock floor exists to prevent.** `GET
  /api/scores/leaderboard?limit=12` against the real provider (today, with
  `294822c` live) returns `total: 56`; against the mock it returned `total:
  12`. `docs/mock-floor.md` and `mock/core/contract.ts` state the offline
  world must answer the same shapes with the same semantics as the real one
  — this is precisely bug class the contract was written to catch, just
  found in the wire semantics of a field rather than in a fixture's
  hand-typed number.

No wire-shape change is needed — `total` already means "count of the
filtered set" on the real side; the fix makes the mock mean the same thing,
which is what a consumer already assumed.

## 4. What changed

`middleware/src/providers/aurora.ts`:
- `mockGetLeaderboard` — counts `entries.length` (the filtered, sorted array)
  before slicing it into `page`; returns that as `total`. Comment rewritten
  to explain the fix and point at `cappedGraphPeople()` as the pattern this
  now matches.
- `mockGetSkillLeaderboard` — same shape: counts the matched (filtered,
  sorted) array as `total` before `.slice(0, limit)` produces `entries`.

`middleware/src/mock/__tests__/scores-seed-agreement.test.ts`:
- Header comment's point 4 rewritten to state the correct claim (count of the
  filtered set, not the page).
- `'reports `total` as the length of the page it ships'` renamed to
  `'reports `total` as a real count of the filtered set, not the page size'`
  and rewritten to assert `page.total === seedPeople.size` (56) for a
  `limit: 12` request, with an explicit `expect(page.total).not.toBe(page.entries.length)`
  so a regression back to page-length is caught even if a future edit makes
  the two numbers coincidentally equal for some other reason.
- Added `'keeps `total` the full holder count once the page is capped below
  it'` for `getSkillLeaderboard`, since the existing skill-leaderboard test
  used `limit: 100` — larger than Kubernetes' holder count — so it never
  actually exercised a cap and would have passed unchanged either way.
  Also tightened the existing test's assertion from `expect(total).toBe(entries.length)`
  to `expect(total).toBe(expected.length)` so it asserts the real invariant
  rather than one that's true of both the old and new code whenever the page
  isn't actually capped.

No other files touched. No wire-shape/type changes; `Leaderboard`'s `total:
number` field is unchanged.

## Verification

- `middleware && npx tsc --noEmit` — exit 0.
- `middleware && npm test` — 4035/4035 passed across 271 suites, exit 0
  (targeted run of `scores-seed-agreement.test.ts` +
  `aurora-leaderboard-total.test.ts` + `aurora-skill-leaderboard-total.test.ts`
  + `scores-routes.test.ts` also independently green, 47/47).
- `portal && npx tsc --noEmit` — exit 0.
- `portal && npm test` — 863/863 passed, exit 0.
- `./scripts/validate-mock-floor.sh` — first run showed 3 failures, all in
  `harness.ts`/observability territory (`observability-fixtures.test.ts`,
  `observability-mock-branch.test.ts`, and a stale `wire.json`/`writes.json`
  handler-sha) — unrelated to this change: `git status` showed
  `middleware/src/routes/harness.ts` and several
  `portal/src/pages/observability/**` files uncommitted and mid-edit by
  another worker at the same time (explicitly out of scope per this task's
  own instructions). Re-running just those two suites in isolation passed
  clean (51/51), confirming a race, not a regression.
