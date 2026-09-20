# The mock floor

`middleware/src/mock/core/` is the floor every fixture in `dev:mock` stands on.
The full reasoning — and the five classes of bug that put it there — is in
[`contract.ts`](../middleware/src/mock/core/contract.ts). This is the working
version.

Import everything from one place:

```ts
import { clock, defineFixture, countBy, todayInUtc } from '../mock/core/index.js';
```

## The rules

1. **No typed aggregates.** A fixture module may export rows and selectors. It
   may never export a number that could have been counted from rows it also
   exports. A count written beside its rows is right the day it is written and
   wrong the first time either side moves — "5 bots" over an empty table, a
   banner reading "6 pending" above 5 cards. Use `countBy` / `sumBy`.
2. **No invented wire strings.** Section keys, status enums, capability names
   are copied from a real response or a real schema, never typed from memory. A
   fixture once keyed `enterprise` while the server sent `enterprise_context`;
   the unit test used the fixture's key, so the test agreed with the code and
   both disagreed with the server.
3. **Every timestamp comes from the clock.** Never `Date.now()` in a fixture,
   and never a timestamp at module scope — that bakes "3 hours ago" at import
   and it means three hours before the *process started*.
4. **Every route has a mock branch.** A provider with no mock path makes an
   unbuilt feature and an unseeded one look identical in `dev:mock`.

## Adding a fixture

Rows are a **factory**, not an array (rule 3 — an array literal freezes its
timestamps at import). `default` is required; other scenarios fall back to it
unless declared.

```ts
import { clock, defineFixture, todayInUtc, sumBy } from '../core/index.js';

export const botRuns = defineFixture<BotRun>({
  key: 'bot-runs',
  scenarios: {
    default: () => [
      { id: 'r1', botId: 'b1', costUsd: 0.12,
        // "earlier today" that stays today even at 00:05 UTC:
        startedAt: clock.hoursAgo(3, { keepWithinToday: true }) },
      { id: 'r2', botId: 'b1', costUsd: 0.4, startedAt: clock.daysAgo(2) },
    ],
    empty: () => [],
  },
});

// Selectors, not stored fields:
export const todaySpendUsd = (botId: string) =>
  sumBy(todayInUtc(botRuns.rows().filter((r) => r.botId === botId), 'startedAt'),
        'costUsd', { digits: 2 });
```

`rows()` hands back the **live** array, so a mock `POST` can push to it;
`reset()` is how the seed comes back. Keys are unique — a duplicate throws at
import rather than hiding a fixture from `resetAll`.

`todayInUtc` is the *only* place "today" is defined, and it buckets in **UTC**,
because that is what Aurora's `date_trunc('day', NOW())` does in a UTC session.
A local-time bucket agrees with production only on a UTC laptop; `deriveBotStats`
shipped that bug and dropped the most recent run out of "today" for the first
few hours after midnight.

## Asking for a scenario

`default` (the demo corpus), `empty`, `error`, `large`, `fresh` — one-line
descriptions live in `SCENARIOS`, which is what any control-plane surface should
render rather than a hand-typed list.

```ts
fixtureRegistry.resetAll('empty');   // switch every fixture at once
fixtureRegistry.resetAll('default'); // and back
fixtureRegistry.scenario();          // what is live now
```

An audit never has to mutate shared state to see an empty table. Note the
fallback rule: a fixture that does not declare `empty` keeps its default rows
there, so a fixture whose empty state you want to audit must say `empty: () => []`.

### `large`, and what it actually covers

`large` shipped as a name in `SCENARIOS` for a while with **zero fixtures
implementing it** — `POST /api/__mock/scenario {"scenario":"large"}` answered
200 and `GET /api/__mock/state` showed every fixture quietly still on
`default`. Applying it changed nothing, which is the same silent-fallback trap
`docs/mock-floor.md`'s fixture-reference test exists to catch elsewhere, one
level up: an *advertised but unimplemented scenario* rather than an
unregistered fixture. `src/mock/__tests__/scenario-coverage.test.ts` is the
guard against it coming back — it fails if any scenario `GET
/api/__mock/scenarios` advertises has no fixture that DECLARED a branch for it
(`declaredScenariosFor`, `core/fixture.ts` — a plain fallback to `default`
does not count).

Fixtures that now declare a real `large` branch, each generated
deterministically from its own seeded cast (a counter, a modulo over real
names/ids, never a typed literal count) rather than invented:

| Fixture | `large` size | Proves |
|---|---|---|
| `mock/people.ts`'s `graphPeople`/`graphRelationships` | 616 people (56 seeded × 11 rounds), capped to 500 by `providers/aurora.ts`'s `cappedGraphPeople` | `GET /api/graph/entities`'s 500-row `PEOPLE_GRAPH_LIMIT` AND the portal's 200-node canvas cap both fire; `peopleTotal` reports the true, larger count beside the capped `nodes` |
| `mock/org-findings.ts`'s `orgFindings` | 315 open findings (7 seeded × 45) | `findingStats`'s GROUP BY (behind `/api/work/summary`) stays right past `listFindings`'s 300-row list cap |
| `mock/work-items.ts`'s `workItems` | ~2,916 items (81 seeded × 36 rounds) | `searchWorkItems`'s 200-row default cap, and `PROJECT_WORK_ITEMS_LIMIT` (500) on the busiest single initiative |
| `mock/assessment.ts`'s `teamsFixture`/`scoresFixture` | 168 teams (7 seeded × 24) | `/api/assessment/teams`'s 500/2000 `clampLimit` |
| `mock/bots.ts`'s `botRuns` | every seeded bot's history extended 220+ runs past its own seed | `listBotRuns`/`listBotRunsForBotsResult`'s 200-run-per-bot cap |
| `mock/invocations.ts`'s `invocationTail` | 5× the default traffic volume | the Invocations page's density and the 50-row `/recent-invocations` window against a busy fleet |
| `mock/traces.ts`'s `traces` | 12 rounds of the seeded traces (36 total) | the trace list's paging and the waterfall's density |
| `mock/local-compute.ts`, `mock/distillation.ts` | see each fixture's own header | their own pagination surfaces |

Fixtures that deliberately still fall back to `default` under `large`: every
other fixture in the registry. Most seed a cast too small to have a
truncation-relevant cap at all (a handful of decisions, a handful of
connected sources), and inflating them would just be noise with nothing on
the other end to prove. If a future client bound needs one of them to grow,
add a `large` branch there rather than assuming this table is exhaustive —
`scenario-coverage.test.ts` only guards "at least one fixture implements this
scenario," not "every fixture that could usefully implement it does."

In tests, take your own registry (`createFixtureRegistry()`) and freeze the
clock rather than reasoning about wall time:

```ts
const restore = freezeClock('2026-09-06T00:05:00.000Z'); // Sunday, 00:05 UTC
// ...
restore();
```

## Asking for a scenario over HTTP — the control plane

`resetAll` is the in-process call. A **browser** audit cannot make it, which is
why every audit this week reached an empty or error state by mutating shared
`dev:mock` state and then warning the next auditor in its log ("`promo-aurora-cold-start`
is now Promoted until the middleware restarts", "the store gained `TEAM-008`").
`middleware/src/routes/mock-control.ts` replaces that with four routes, so an
auditor asks for a world instead of damaging one.

**This is dev-only and it is gated to be unreachable anywhere else.** Every
route requires the mock providers to be on (`config.mock.aurora` **or**
`config.mock.agentcore`) **and** `NODE_ENV !== 'production'`. Failing either,
every route answers `404 {"error":"Not found"}` — not 403, because a 403
confirms to a prober that the endpoint is real. The gate is applied per route,
not as a blanket mount, matching the machine-callback guards in `harness.ts`
and `approvals.ts`; there is no session floor, because an auditor curls these
with no cookie. Set `MOCK_CONTROL_SECRET` to additionally require
`x-mock-control-auth` (constant-time check, open when unset) if a mock
middleware is ever reachable from something other than localhost.

| Route | Does |
|---|---|
| `GET /api/__mock/scenarios` | The menu: every world with its one-line description, and per fixture the line *that* fixture declares (fixtures declaring nothing report the shared line from `SCENARIOS`). |
| `POST /api/__mock/scenario` `{ scenario, fixture? }` | Switch everything to a world, or pin one fixture to it. |
| `POST /api/__mock/reset` `{ fixture? }` | Put the starting state back — everything to `default`, or drop one fixture's pin. |
| `GET /api/__mock/state` | Which world each fixture is in, with a row count each. Paste this into the journey log. |

```bash
curl -s localhost:3011/api/__mock/scenarios              # what can I ask for?
curl -s localhost:3011/api/__mock/state                  # what am I looking at?
curl -sXPOST localhost:3011/api/__mock/scenario \
  -H 'content-type: application/json' -d '{"scenario":"empty","fixture":"bots"}'
curl -sXPOST localhost:3011/api/__mock/reset \
  -H 'content-type: application/json' -d '{}'            # undo the whole audit
```

A **global** switch calls `registry.resetAll(scenario)`, so a fixture that
registers later inherits it. A **per-fixture** switch is a *pin*: the plane
wraps that fixture's `rows` so a no-argument read resolves to the pinned world
while every other fixture stays where it is — `rows(scenario)` with an explicit
argument still passes through untouched. A later global switch drops the pin and
takes the fixture along, because an auditor asking for the whole world means the
whole world. `/state` reports `pinned: true` so a journey log can explain why one
panel differs from the rest of the page. `{ fixture }` on `/reset` drops the pin
and rejoins the current world — it does *not* drag the rest back to `default`.

A fixture that throws under `error` is reported as `rows: null` with its
message, rather than failing the whole `/state` read.

### `X-Mock-Scenario`

The control plane is mounted at the app root, so it stamps every response that
is served after it with the active world:

```
X-Mock-Scenario: default | empty | error | large | fresh | mixed
X-Mock-Scenario-Pins: bots=empty          # only when a fixture is pinned
```

`mixed` means at least one fixture is pinned away from the global world; the
`Pins` header names which. **A response with no `X-Mock-Scenario` header is not
mock-served** — nothing is stamped outside a non-production mock process, which
makes the header a screenshot-legible answer to "was this real data?". (`/health`
and `/api/health` are registered before the mount and are deliberately not
stamped.)

## The devbox, offline

The governed-run and change-delivery loops are the one place the middleware
drives a *sandbox* rather than a database or an API, and they were the last
thing in `dev:mock` that could not run at all. Three `src/lib` modules blocked
them, none of them a provider, so nothing in the judge could see it:

| Blocker | Was | Is |
|---|---|---|
| `lib/devbox-arn.ts` | `ListAgentRuntimes` → null → every caller 503s | returns a `…-MOCK` ARN, and `devboxDataClient()` returns a fake microVM |
| `lib/change-reviewer.ts` | a live Bedrock `Converse` | a real static read of the diff (`mock/static-review.ts`) |
| `lib/change-delivery.ts` | borrow a token, push a branch, open a PR | the workspace checks still run; the push and the PR are a fixture |

**The devbox is replaced at the transport, not per caller.** `devboxDataClient()`
hands back `mock/devbox-shell.ts` — an object that answers the two runtime
commands (`InvokeAgentRuntimeCommandCommand` for a shell, `InvokeAgentRuntimeCommand`
for an agent task) over the workspace fixture in `mock/devbox-workspace.ts`.
Branching inside `lib/project-runner.ts` and `lib/sdlc-pipeline.ts` instead
would have meant an offline pipeline that is a *different* pipeline — different
sequencing, different failure handling — and no exercise of the real one. This
way capture, commit-per-capture, review, gate evaluation, the block-rollback
and delivery all run their production code and only the sandbox is imaginary.

An unrecognised shell probe answers `fatal: mock devbox: unsupported command …`
rather than an empty string, because every caller treats a leading `fatal:` as
a git failure and treats empty output as *a clean tree* — the single most
misleading thing this module could say.

**What an offline agent writes is declared, not invented.** A mock cannot write
code, so `devboxWorkProducts` holds three real diffs and a run picks one by a
stated keyword in its prompt. They exist to cover the three branches
`evaluate()` actually has:

| Prompt contains | Product | Reviewer | Decision |
|---|---|---|---|
| `noise` | `src/alerts/throttle.ts` | `request_changes` — removed guard, `console.log`, TODO | `changes_requested` |
| `cookie` | `src/auth/session-cookie.ts` | `approve` | `needs_approval` (protected path) |
| anything else | `src/collector/sampler.ts` + its test | `approve` | `approved`, auto |

**The offline reviewer is a real reading, and says what it is.** It scans added
and removed lines for a committed credential, a removed guard, a skipped or
focused test, debug output and unfinished markers, pins each finding to a real
new-side line number, and records itself as `offline/static-diff-review` — never
a Bedrock model id. Its verdict then flows into the real `evaluate()`, so the
gates and the status are genuine engine output, exactly as `mock/sdlc.ts`
derives its seeded statuses. A mock reviewer that approved everything would be
strictly worse than the 503 it replaced, because it makes a broken gate look
green.

It cannot judge correctness, scope, or whether the change did what was asked —
the three things the real system prompt asks for. It is a floor, not a
substitute. And the branch sits **above** the `try`/`catch` in `reviewDiff`, so
in real mode a thrown `Converse` still degrades to `request_changes` with the
reason; that degradation is the governance guarantee and a mock must never
soften it.

## Running the parity harness

Parity means the mock says what the seed says. The harness walks the entities
declared in `src/mock/core/parity/entities.ts` against `schema/*.sql`:

```bash
cd middleware
npm test -- seed-parity     # the harness
npm test -- src/mock        # the floor + every mock test
npx tsc --noEmit
```

A failure names the entity, the id, the field and the seed line, so it is
readable without opening either file. An accepted disagreement is declared as
`knownDrift` **with a reason** — an unexplained exemption is how drift becomes
permanent.

### Adding a parity entity

One row in `PARITY_ENTITIES` (`core/parity/entities.ts`) per seeded entity; no
new test file — `seed-parity.test.ts` walks the array. A row is about fifteen
lines and names four things:

```ts
{
  name: 'bots',                       // the table as the seed spells it
  describes: 'The maintenance bots the fleet page lists.',
  sqlFile: 'seed_program.sql',        // the canonical INSERTs, parsed not retyped
  seedId: 'id',                       // the id COLUMN name, not a function
  coverage: 'complete',               // or 'subset' for a curated cast
  mockRows: async () => (await import('../../../providers/bots.js')).MOCK_BOTS,
  mockId: (b: { id: string }) => b.id,
  fields: [
    { seed: 'name',     mock: (b: { name: string }) => b.name },
    { seed: 'schedule', mock: (b: { schedule: string }) => b.schedule },
    { seed: 'enabled',  mock: (b: { enabled: boolean }) => b.enabled,
      knownDrift: { 'bot-nightly': 'parked in the mock so the scheduler cannot fire at boot' } },
  ],
}
```

- **Never hand-copy ids.** `seedRows()` parses the real `INSERT` statements;
  a list of expected ids in the test file is the bug this harness replaces.
- `seedId` is a column name. A composite key (`project_contributions` is keyed
  on person + project) sets `seedId: ''` and supplies `seedKey(row)`. Point at
  a differently-named table in the same file with `sqlTable`, and narrow to
  part of it with `seedFilter`.
- `coverage: 'complete'` means the fixture claims the whole seeded set — a
  missing id fails. `'subset'` allows missing ids but **never invented ones**:
  an id the mock made up is always a failure, because inventing ids is how the
  `wi-k8s-*` family shipped.
- `normalize` coerces the seed literal before comparing (scale changes, joins,
  a column the mock spells differently); `equals` replaces deep equality (money
  to the cent); `missing` says what an omitted column means.
- `knownDrift` as a bare string exempts the field everywhere; as a record it
  exempts only the ids named. Per-id is almost always what you want. Ids go in
  `allowedExtraIds` / `allowedMissingIds`, also id → reason. All of them **must**
  say why, and all are printed by the known-drift roll-up so they stay visible.
  An exemption that no longer applies — an `allowedMissingIds` entry for an id
  the mock now carries — **fails**. A stale exemption is indistinguishable from
  a live one, and the difference is a bug nobody is looking for.
- **Comparing values, not just rows** (`core/parity/columns.ts`). Matching ids
  is not agreement: for three months the mock allocated $60 where the seed
  allocated $95, on every headroom number and every allocation brake, and every
  check was green because both sides had the row. So the harness derives, from
  the seed's own `INSERT`s and the live mock rows, every column **both sides
  carry**, and fails on any that no `FieldCheck` compares. A numeric column
  added to either side fails until someone declares it.
- `uncheckedColumns[column] = reason` is the escape hatch, same contract as
  `knownDrift`: mandatory reason, printed, and stale entries fail. A column the
  seed writes as a SQL expression on every row (`NOW() - INTERVAL '4 days'`) has
  no literal to compare against and is exempted automatically — still printed.
  `setExactlyWhenTheSeedSetsIt` checks such a column for *presence* instead: a
  done work item must carry a `completed_at` even when the instant can't match.
- A divergence that is a **bug** is prefixed `DEFECT:` in the roll-up rather
  than filed as accepted drift — the same argument as `wire/allow.ts`'s
  `bug: true`. An accepted difference and an unfixed bug must never read alike.

Cross-surface rules that no single entity can express — two surfaces reading
the same fixture and disagreeing with each other — go in
`core/parity/invariants.ts` instead: a name, the lesson, and a `check` that
returns one line per violation (empty array = pass). Returning lines rather
than throwing is what lets one run report every violated invariant.

## API surface

| Module | Exports |
|---|---|
| `clock.ts` | `clock` (`mockClock` alias), `freezeClock`, `unfreezeClock`, `isClockFrozen`, `utcDayStartMs`, `msSinceUtcMidnight`, `HOUR_MS`, `DAY_MS` |
| `fixture.ts` | `defineFixture`, `fixtureRegistry`, `createFixtureRegistry`, `SCENARIOS`, `SCENARIO_NAMES`, `isScenarioName`, `describeScenario` |
| `derive.ts` | `countBy`, `sumBy`, `groupBy`, `latestBy`, `todayInUtc`, `toRecord` |

`countBy`/`groupBy` return a `Map` (data-derived keys must not collide with
`Object.prototype`); `toRecord` converts one for the wire.

## Wire capture — proving a fixture against the server

The floor above stops a fixture from *contradicting itself*. It cannot stop a
fixture from contradicting the **server**, and that is the bug that actually
shipped: the portal looked up its knowledge sections under `enterprise`, the
server sends `enterprise_context`. Six documents were unreachable on
`/assessment/enterprise`, the rail read "Nothing here yet", and every test was
green — because the unit fixture had invented `enterprise` too. The test agreed
with the code, both disagreed with the server, and nothing mechanical could
have found it. A human audit did.

`middleware/src/mock/core/wire/` is the mechanism that finds it next time.

### The shape of it

| File | Does |
|---|---|
| `routes.ts` | Enumerates the whole HTTP surface by parsing `src/index.ts` and every router it mounts (TypeScript AST, not regex; follows nested `router.use('/drift', driftRouter)`). No server, no `app.listen`. |
| `capture.ts` | Signs in, GETs everything it can reach on a running `dev:mock`, and writes what came back. |
| `shape.ts` | Turns a response into **key paths** (`sections[].key`) and the wire-shaped **values** at those paths. Never the data. |
| `corpus.ts` | The second witness: every quoted string and identifier in the middleware's own source, comments and `__tests__` excluded. |
| `vocabulary.ts` | Reads the snapshot back as one entry per object the server sends, and matches a fixture's key set to the objects it could be. |
| `scan.ts` | The check, and the message. |
| `allow.ts` | Accepted disagreements, each with a reason; `bug: true` marks a real product bug so it is *printed*, not silenced. |
| `write-policy.ts` | Which writes may be replayed. An **allowlist**: six ordered refusal rules run first, and the last one matches everything left, so a new write route is `unclassified` — a gap in the policy — until someone reads its handler and writes down why it is safe and where its body comes from. Silence is a refusal, never a permission. |
| `capture-writes.ts` | Replays the allowed writes, `POST /api/__mock/reset` before every one and again in a `finally`, and pins their response shapes. |
| `http.ts` | The personas, cookie jar and `:id` resolution both sweeps share, so a write signs in exactly the way the GET sweep does. |
| `snapshots/routes.json`<br>`snapshots/wire.json`<br>`snapshots/writes.json` | The committed truth. Sorted, so a diff reads as added and removed lines. |

### Not every fixture implements every scenario — the plane now says so

`GET /api/__mock/scenarios` reports what each fixture ACTUALLY has a branch
for, and `POST /api/__mock/scenario` answers **409** for one it does not,
naming what it does declare. Of the 108 fixtures, **31 implement `error`** and
95 implement `empty`.

It used to report the global catalogue — all five, for all 108. So
`compute-nodes`, which declares `default/empty/fresh/large`, advertised
`error` with the sentence "Providers fail, so a surface has to render an error
state rather than a blank panel"; the pin was accepted with 200, `GET /state`
reported the fixture pinned to `error`, and the rows came back `default` with
HTTP 200. Someone following the instruction two sections above — "to see an
empty or error state, ask for it" — got a healthy page and would have
concluded the surface handles a failed read.

So when a surface needs auditing under failure and its fixture does not
implement `error`, that is now a visible 409 rather than a silent pass: either
add the branch to the fixture, or audit a different one. Tests:
`routes/__tests__/mock-control.test.ts` § "scenarios are per-fixture".

### Regenerating the snapshots

**Do this whenever a route is added or a response shape changes.** The snapshot
is the only thing standing between a fixture and its own imagination, and a
stale one is worse than none.

```bash
cd middleware && npm run dev:mock                  # one terminal, leave it up
cd middleware && npx tsx src/mock/core/wire/capture.ts
```

`WIRE_BASE_URL=http://127.0.0.1:3012` points it at another port — worth doing,
because `dev:mock` runs under `tsx watch` and editing anything under
`middleware/src` restarts it mid-capture. A restart shows up as a run full of
`fetch failed`. Start a throwaway server on its own port instead:

```bash
cd middleware && PORT=3012 SWEEP_INTERVAL_MIN=0 \
  DEV_OFFLINE=true MOCK_AURORA=true MOCK_AGENTCORE=true MOCK_GUARDRAILS=true \
  MOCK_CLOUDWATCH=true POLICY_STORE_ID= NODE_ENV=development AUTH_DEMO_MODE=true \
  npx tsx src/index.ts
```

⚠️ **Use that env exactly — every `MOCK_*` flag, not just the two obvious ones.**
`MOCK_GUARDRAILS` and `MOCK_CLOUDWATCH` are separate flags from `MOCK_AURORA` /
`MOCK_AGENTCORE` (`middleware/src/config.ts`), and a capture server missing one
does not fail: the routes behind it fall through to a real AWS call, answer
`500 UnrecognizedClientException` with expired credentials, and get recorded as
`{"skipped": "HTTP 500 …"}`. Rule 4 then reads that snapshot and reports the
route as having **no mock branch** — an accusation against the product for what
is really an artifact of the capture shell. `GET /api/capabilities/guardrail`
did exactly this on 2026-09-18: it has had a `mockGuardrails` provider all
along, and the committed snapshot recorded a healthy 200 for it.

The tell is that the diff *removes* a captured shape and replaces it with a
skip. Before trusting a rule-4 failure, check whether the route's entry in
`git diff` went from `status: 200` to `skipped`, and whether the fixture it
would read from is listed in `GET /api/__mock/state` — if it is, suspect the
capture env before the code. Recapturing costs ~4 minutes; chasing a phantom
missing branch costs considerably more.

`capture.ts`'s `main()` runs the GET sweep first, against a clean world, then
the write sweep — so the one command produces all three snapshots.

Capture takes about four minutes. It prints every route it could **not** reach
and why — that list is part of the output, not a failure, and it belongs in the
snapshot so the gaps are visible rather than assumed away. The write sweep
prints the same for every write it **refused**, naming the rule that refused it
(`spends`, `not-intercepted`, `destructive`, `fires`, `session`, `unresettable`,
`control-plane`). A refusal is a decision on the record; an `unclassified` route
is the one thing that means somebody has not looked yet.

**`not-intercepted`, and why the policy asks the server.** Some routes spend
only because a real provider is behind them — and `MOCK_AGENTCORE` /
`MOCK_GUARDRAILS` genuinely intercept several of those, so they are safe to
replay *in the configuration the sweep is actually running against*. The route
property, true everywhere, is "this spends unless the process serving it
intercepts the provider it spends through". Whether **this** process does is a
fact about the server, and `WIRE_BASE_URL` can point anywhere, so neither the
policy file nor the laptop's own environment is entitled to answer it. The
sweep therefore asks: `GET /api/health` already reports
`mocks: { aurora, agentcore, guardrails, cloudwatch }`, and a spec declaring
`intercepts: ['agentcore']` is admitted only when the server says of itself
that it runs those providers. No report means nothing is known to be
intercepted, and the write is refused — silence stays a refusal. An unreadable
`/api/health` fails the capture outright rather than degrading into a hundred
look-alike refusals.

A distinct rule id alone would not have done: naming an assumption is not
checking it, and the whole point of the `spends` comment is that a policy
leaning on the laptop is one `WIRE_BASE_URL` away from being wrong. `writes.json`
records the `intercepted` set the server reported, so a snapshot says which
world produced it.

Run the sweep on demand without regenerating anything:

```bash
cd middleware && npx tsx src/mock/core/wire/scan.ts   # ~1s, exit 1 on a finding
cd middleware && npm test -- src/mock/core/wire       # the same, as tests
```

### What the check actually asserts

Every object literal in every `__tests__/**/*.test.ts(x)` — both packages — is
matched against the objects the server really sends. An object matching nothing
is not standing in for a response and is left alone. A matched one gets two
checks, and **a fixture may omit any field; it may never invent one.**

1. **Invented wire value.** `key: 'enterprise'` where that object's `key` on the
   real route is one of `enterprise_context`, `rules`, `prompts`,
   `confluence-eng`. Checked for the field names in `shape.ts`'s `WIRE_FIELDS`
   — section keys, status enums, capability names, tenant and role ids — never
   for ids, names or free text, which are open sets.
2. **Invented key.** A fixture carrying a field its matched shape has not got.

Both need **two witnesses** before they fail. A captured response is a *lower*
bound on what a field can hold — `GET /api/session/me` was captured as an
admin, so its `role` reads `['admin']`, and `role: 'member'` is perfectly
correct while sitting outside it. So a string is only called invented when the
server did not send it there **and** no middleware source file spells it.
Without that second witness the first sweep produced 219 findings, nearly all
of them wrong; with it, five.

The failure names the file, the line, the string and the route:

```
portal/src/pages/assessment/__tests__/knowledgeFormat.test.ts:64
  fixture `…/knowledgeFormat.test.ts` invents key `enterprise`;
  GET /api/assessment/knowledge/tree `sections[]` sends 'confluence-eng',
  'enterprise_context', 'prompts', 'rules', and no middleware source file
  spells 'enterprise' either.
```

### A new route is covered the day it ships

`routes.test.ts` enumerates the live router table and compares it with
`snapshots/routes.json`. Add a route and the test fails naming it, with the
regeneration command — which is the point of enumerating rather than keeping a
hand-written list.

### What this cannot catch

Say it out loud so nobody over-trusts it:

- **Only what a session can reach.** Most GET routes are captured; the rest are
  listed in `wire.json` with a reason (SSE streams, routes needing a query
  parameter, empty collections that yield no `:id`, routes that 500 without
  real AWS).
- **Writes are captured, but most are refused on purpose.** Of 194 write routes
  58 are replayed and shape-pinned; 112 are refused by rule because replaying
  them would spend money, delete something, fire a schedule, kill the sweep's
  own session, or leave state `POST /api/__mock/reset` cannot restore. Those
  112 response shapes are still invisible — the refusal is the honest answer,
  not a fix. Eight provider domains hold their mock rows in module-level arrays
  that register no fixture, which is why several writes can only be replayed as
  echo-backs; `defineFixture` on those providers is what would unlock them.
- **A lower bound, not an enum.** Values are what one `dev:mock` corpus
  happened to contain. A status no seed produces looks invented, which is why
  the source corpus is required as a second witness — and equally, a fixture
  using a *wrong but real* string (a status from another route) passes.
- **`dev:mock`, not production.** Every shape comes from the mock providers. If
  a mock and its Aurora path disagree, this check believes the mock. Keeping
  those two honest is the parity harness's job, not this one's.
- **Object literals only.** A fixture built by a function, imported from JSON,
  spread over a base, or typed as `as unknown as Foo` is not analysed. Spreads
  are deliberately exempt from the key check.
- **Keys, not semantics.** It cannot tell that a correctly-named field carries a
  nonsense value, that a number is out by a factor of a hundred, or that the
  portal reads a real key at the wrong nesting depth.
- **It does not read the portal's source.** It compares *fixtures* to the
  server. Where a fixture is right and the portal is wrong — or both are wrong
  together in a way no fixture states — only an audit will find it.

## The judge

`scripts/validate-mock-floor.sh` is the only judge of the floor. It exits 0
only when every check passes, and each failing line names the next task. The
goal, the backlog and the rules that do not bend are in
[`docs/mock-floor-goal.md`](./mock-floor-goal.md).

```bash
./scripts/validate-mock-floor.sh            # everything (~2 min: tsc + full jest)
./scripts/validate-mock-floor.sh --quick    # skips the full jest run
```

| Section | Enforces | Fails when |
|---|---|---|
| builds | `tsc --noEmit`, `npm test` | anything under `src/mock/core/parity` or `core/wire` breaks — those suites are part of the normal run, and **rule 2 (no invented wire strings) is enforced there**, by `core/wire/__tests__/sweep.test.ts`, not by a section of its own |
| rule 1 | no typed aggregates | the count of literal `count`/`total`/`rate`/`avg` fields exceeds `scripts/mock-aggregate-budget.txt` |
| rule 3 | timestamps from the clock | any `Date.now()`, no-arg `new Date()`, or literal ISO timestamp under `middleware/src/mock/**` outside `core/clock.ts`; **and** the count of wall-clock mints inside a `config.mock` branch under `middleware/src/providers/**` exceeds `scripts/mock-mint-budget.txt` |
| rule 4 | every route has a mock branch | a GET route is recorded as `HTTP 500` in `wire.json` and is not in `scripts/mock-floor-exemptions.txt` with a reason; **and** the count of write routes statically reaching an unmocked provider exceeds `scripts/mock-write-route-budget.txt` |
| rule 5 | fixtures are registered | a `defineFixture` module is unreachable from `src/index.ts`, two fixtures share a key, or a production fixture passes `registry:` |
| rule 6 | snapshots are current | `routes.json` ≠ the live router table, `wire.json` misses a GET route, or `wire.json` is older than a route/provider/mock source |

### The two halves of rules 3 and 4

Both rules originally looked only where the bug had already been found, and
both were widened after a slice found the other half.

**Rule 3** grep-scans `src/mock/**` as before, *and* runs an AST scan over
`middleware/src/providers/**` for a wall-clock mint (`Date.now()`, no-arg
`new Date()`) inside a `config.mock` branch — the then-side of
`if (config.mock…)`, the else-side of a negated one, the matching arm of a
`config.mock ? … : …`. That is a fixture timestamp living outside the fixture
directory, and `providers/agent-projects.ts` `markCloned` minted one for as
long as the rule could not see it. A mint on the *Aurora* side is left alone:
that code talks to a database where `NOW()` does the minting, and a `Date.now()`
there is a cache stamp or a stopwatch.

**Rule 4** reads the wire capture as before for GET, *and* runs a static
reachability scan for POST/PUT/PATCH/DELETE. It has to be static: you cannot
POST or DELETE against a live server during a validation run, because the
writes are real and they mutate the world the next check reads. The scan walks
the call graph from each write route's handler through `src/routes`, `src/lib`
and `src/providers`, and reports the routes that reach a function calling the
RDS Data API, an AWS SDK client, or an outbound `fetch`, with no offline branch
above it.

It walked all three directories from the start but only ever *reported* a leaf
in `src/providers/**`, and that under-reporting is documented below as one of
the things the judge could not see. It is now fixed: a leaf in `src/lib/**`
counts too. **The number went up when the scan was widened — from 15 pairs to
78, across 32 distinct routes — and that rise is the scan seeing more, not the
code getting worse.** The whole governed-run and change-delivery surface was
already 503ing offline at `lib/devbox-arn.ts`, and no number moved when it did.
From this new baseline the ratchet only goes down.

Two things came with the widening, both recorded in `mock-branches.ts`:

- `runDevboxShell` is excluded by name, as transport, on the same argument that
  excludes `exec` — it *is* the devbox wire, so reporting it says "the wire is
  the wire" once per caller and buries the function above it that decides
  whether there is an offline path.
- `GUARD_TOKENS` gained `policyStoreId` and `sessionSigningSecretArn`.
  `lib/authz.ts` answers from the Cedar seed matrix when `POLICY_STORE_ID` is
  unset and `lib/session.ts` signs with a deterministic dev key when no secret
  ARN is set; `dev:mock` takes both. Without them the widened scan reported
  every gated write route in the middleware — sixty-odd — as reaching live AWS
  through its own auth check, which names the guard rather than a gap. Four
  spellings of "this has an offline path" is drift waiting to happen;
  consolidating them is a separate slice.

**It was widened a second time, in 2026-09, to count an outbound `fetch`.**
Counting only `.send()` and `exec()` meant "reaches a backend `dev:mock` cannot
answer" really meant "reaches AWS" — anything spoken over plain HTTP was
structurally invisible, and this document said so: `lib/github-connector.ts`
reaches github.com with `fetch` and nothing reported it. **The budget went from
78 pairs to 79** and that rise is, again, the scan seeing more. The new pair is
`POST /api/ingest/survey` → `lib/site-survey.ts disallowedPrefixes()`, which
GETs the surveyed origin's `robots.txt` and does nothing else, so no earlier
rule could name it. From this baseline the ratchet only goes down.

The widening also turns `github-connector.ts` from a blind spot into a **proven
negative**, which is the more interesting half of the result. Every function in
it that a *write* route reaches has a real offline path: `identify`, `listOrgs`,
`listRepos` and `readRepoSignal` each branch on `config.mock.agentcore`, and
`openPullRequest` — which genuinely fetches unguarded — is only ever reached
through `lib/change-delivery.ts`, which branches above the call and hands back a
fixture PR. The scan is now silent there because there is nothing to say, not
because it cannot look, and `src/lib/__tests__/mock-branches-fetch-scan.test.ts`
fails if that stops being true.

Two rules keep the `fetch` half from crying wolf, both mirroring the precedent
the AWS half already set:

- **Self-origin is not outbound.** A `fetch` at a loopback host, or at a
  string/template literal starting with `/`, is answered by the same mock
  middleware the caller runs inside. A template whose *first* element is an
  interpolation (`` `${origin}/robots.txt` ``) is deliberately **not**
  self-origin — that origin is the site being surveyed.
- **`gh()` in `github-connector.ts` is excluded by name as transport**, exactly
  as `exec` is, and — exactly as with `exec` — a *call to* it counts as reaching
  the network for whoever makes the call. The exclusion is module-qualified,
  because `gh` is a two-letter name another file could plausibly reuse.

Both scans live in `middleware/src/mock/core/wire/mock-branches.ts` and are
runnable on their own:

```bash
cd middleware && npx tsx src/mock/core/wire/mock-branches.ts        # both
cd middleware && npx tsx src/mock/core/wire/mock-branches.ts mints  # rule 3
cd middleware && npx tsx src/mock/core/wire/mock-branches.ts writes # rule 4
```

### The ratchets and the exemption file

`scripts/mock-aggregate-budget.txt` holds one number — the count of
typed-aggregate *shapes* the repo currently carries. It may only go down.
Lower it after every slice that derives one; never raise it. (Same contract as
`scripts/orgiq-raw-budget.txt`.)

`scripts/mock-mint-budget.txt` (rule 3, provider half) and
`scripts/mock-write-route-budget.txt` (rule 4, write half) are the same
contract: one number, down only. They start as ratchets rather than gates
because both rules surfaced more on their first run than one slice could fix —
17 mints across 9 providers, and 45 route→provider pairs across 22 routes. A
ratchet keeps the whole list *printed on every run* rather than exempted into
silence, which is the point: an exemption file would have hidden them.

`scripts/mock-floor-exemptions.txt` is rule 4's written list, one route per
line as `GET /path | why`. A line with nothing after the `|` is **not** an
exemption — the validator fails it, on the same contract as
`mock/core/wire/allow.ts`. An entry naming a route that no longer 500s is
reported as stale and must be deleted, so the list cannot quietly outlive the
problem.

### What the judge cannot see

Say it out loud so nobody over-trusts it.

- **Rule 4's write half cannot see a route that calls `exec` itself.** The scan
  reports a leaf in `src/lib/**` or `src/providers/**`, and `exec` is excluded
  everywhere as transport — so a handler that reaches the Data API *directly*,
  with no provider between, is structurally invisible to it. That is not
  hypothetical: `POST /harness/runs/:runId/results`, `PATCH /harness/runs/:id`
  and `POST /harness/promote` all 500'd offline while the budget reported them
  as fine, because none of the three was ever on the list. Note the shape of the
  trap for anyone tempted to "fix" a number: hoisting a `config.mock`-mentioning
  named function into the route makes the pairs disappear, because the scan
  stops at a guarded function — which is suppression unless a real offline path
  is behind it.
- **Nor a route that builds its own AWS SDK client.** Same cause as the bullet
  above, one step wider: findings may only name a leaf in `src/lib/**` or
  `src/providers/**`, so a handler that constructs a client and `send`s a
  command *itself* is not a finding at all — not over-reported, not
  under-reported, simply never looked at. `routes/kb-admin.ts` had a local
  `agentClient()` and used it four times, and two of those were the KB's whole
  sync journey: `POST /:id/sync` and `GET /:id/jobs` called Bedrock
  unconditionally, so under `dev:mock` they reached the real account with
  whatever credentials the developer's shell had. What that cost is worth
  stating, because it is the failure mode this document keeps calling the worst
  one: the page appeared to work. "Sync now" answered a live
  `AccessDeniedException` — a red banner about IAM on a page with no AWS in it —
  and the job list swallowed its own refusal into `degraded({ jobs: [] })`,
  which renders as *this knowledge base has never synced*. Every number beside
  them was correctly mocked. Both now go through
  `providers/knowledge-base.ts`, which is scannable and branched. Note the write
  budget did not move when they were fixed (34 before, 34 after): they were
  never counted, so a green ratchet was never evidence about them. If you add a
  `new SomethingClient()` to a file under `src/routes/**`, no rule here will
  object — the reviewer is the judge.
- **Rule 1 matches a shape, not a bug.** `documentCount: 1247` on a line of its
  own is what it looks for. It cannot tell a *drifting* aggregate (the rows are
  right there in the same fixture — `mock/traces.ts`'s `totalDurationMs` beside
  its own spans) from a *leaf metric* (nothing in the repo to count — a Code
  Interpreter session's `executionCount`). Both are in the budget; only the
  first is a bug, and the reviewed leaf metrics are listed in the goal doc. It
  also cannot see an aggregate computed by a helper, spread from a base object,
  written inline among other properties on one line, or spelled with a name
  outside `total*`/`*Count`/`*Rate`/`avg*`. Zero-valued aggregates are
  deliberately ignored: a zero over an empty list is the honest empty case.
- **Rule 3 is about minting, not formatting.** `new Date(<something>)` that
  parses an existing value — sorting by `startedAt`, adding an offset to a
  clock-derived stamp — is a read and is left alone. The provider half sees
  only what is *lexically inside* a `config.mock` branch: a mock-only helper
  function called from that branch but declared beside it, or a mock path
  selected by some other flag, mints unwatched. It also does not look at
  `src/lib/**` at all, and it never flags an ISO literal in a provider —
  seeded rows legitimately carry the dates `schema/*.sql` gives them.
- **Rule 4's GET half sees only what the capture reached.** The wire capture is
  GET-only. A route that returns `200` with an empty body because its mock
  branch returns nothing is indistinguishable from a genuinely empty
  collection. And the whole half trusts `wire.json`, which is why rule 6 fails
  a capture older than the sources it describes.
- **Rule 4's write half is a reachability argument, not a test.** It is
  static — it never issues a request — so what it proves is "some path from
  this handler reaches a provider function that talks to live AWS with no
  offline branch above it". Read that sentence carefully, because it is weaker
  than "this route 500s offline" in both directions:
  - **It over-reports.** A path may be unreachable at run time (behind a
    validation that always fails offline, an `if` the mock data never
    satisfies, a `.catch` that swallows the failure into a soft outcome). Such
    a route is on the list and does not 500.
  - **It under-reports.** It now asks about `src/lib/**` as well as
    `src/providers/**` — that widening is above, and it is what the paragraph
    here used to warn about: `POST /api/agent-projects/:id/runs` answered
    **503 "the devbox runtime is not deployed"** offline because
    `lib/devbox-arn.ts` lists real AgentCore runtimes, and neither it nor
    `lib/project-runner.ts` is a provider, so neither was scanned. The second
    widening closed the `fetch` half of that: an outbound `fetch` now counts,
    so `lib/github-connector.ts` and `lib/site-survey.ts` are in scope. What
    remains invisible is a route broken offline for a reason that is neither an
    AWS call nor an HTTP call: a missing env var, a file read, a spawned
    process, a socket. Three narrower `fetch` gaps also survive, all of them
    consequences of where the scan looks rather than of what it counts:
    - **GET routes are not in the write half at all**, so an unguarded outbound
      `fetch` on a read route is still nobody's finding. `GET /api/environments/:id/runs`
      → `listWorkflowRuns` → `gh` → api.github.com has no
      mock branch of its own, and the route swallows the failure into
      `{ runs: [], note }`, so the GET capture records a cheerful `200` too.
    - **A `fetch` in a route handler itself is not reported**, because findings
      may only name a leaf in `src/lib/**` or `src/providers/**`. Nothing in
      `src/routes/**` fetches today; the day one does, the scan stays quiet.
    - **Self-origin is decided lexically.** A `fetch` at a variable that happens
      to hold our own base URL is counted as outbound (over-report); a `fetch`
      at a literal `/`-prefixed path that a proxy rewrites to somewhere else is
      not (under-report). Both are the same trade the rest of the scan makes:
      it resolves names, not values.
  - **A client passed in as a parameter is not analysed, so a route can be on
    the list and work.** `lib/devbox-runner.ts`'s `executeDevboxTask` takes its
    `BedrockAgentCoreClient` from its caller, and offline that caller hands it
    the fake microVM in `mock/devbox-shell.ts`. The scan resolves names, not
    values, so it still reports `POST /api/agent-projects/:id/runs` and
    `POST /api/sdlc/changes/:id/address` as reaching live AWS. Both complete
    offline. Two of the 78 pairs are that over-report, left on the list rather
    than tuned away — suppressing a finding because it happens to be about the
    route you just fixed is how a scan stops being evidence.
  - **It resolves names, not types.** A provider reached only through a
    callback, a dynamic `import()`, a re-export, or a value passed as a
    parameter is not followed. Names are matched per module against relative
    imports and local declarations; two different functions with the same name
    in one module collapse to one.
  - **A guard is a string match.** `config.mock` (the floor's switch) or
    `auroraConfigured` (providers/identity.ts's in-memory fallback) anywhere in
    a function body — or in a helper it calls in the same module — counts as
    guarded, and the search stops there. So a function that guards *one* of its
    two AWS calls reads as fully guarded, and a guard spelled some third way
    reads as absent.
  - **`providers/aurora.ts` and functions named `exec`/`safeExec`/`execWrite`/
    `execOne` are excluded by name** as transport, as are `runDevboxShell` and
    — module-qualified — `gh` in `lib/github-connector.ts`. A provider that
    genuinely named a surface function `exec` would be skipped.
- **Rule 5 is static.** It proves a fixture module is *loaded* at boot, not that
  its rows ever reach a route: a provider can import a fixture and then ignore
  it. It also reads the key from the two lines after `defineFixture`, so a
  fixture that declares `key` somewhere else is miscounted.
- **Rule 6 checks the route table exactly and the shapes not at all.** A
  response whose *keys* changed while its route stayed put is only caught by
  the freshness rule — the mtime comparison — which is a proxy, not proof. It
  cannot tell an edit that changed a shape from one that changed a comment.
- **None of it reads the portal.** The floor makes fixtures agree with the
  server. Where a fixture is right and the page is wrong — or both are wrong
  together in a way no fixture states — only an audit will find it.

## The mock agent stream is paced

`mockAgentCore.invokeAgentStreaming` (`providers/agentcore.ts`) sleeps
`MOCK_STREAM_PACE_MS` between chunks — default 12ms in development, 0 under
jest. Unpaced, a whole run landed in one ~2ms SSE read, React batched every
event into a single render, and no in-flight state (the step strip, the
streaming bubble, tool-call pills) was ever painted, so Ask looked as if the
hook dropped `STEP_STARTED`. A real Nova answer streams for seconds; the mock
now takes about 1.4s. Set `MOCK_STREAM_PACE_MS=0` for a capture server.

## The error band, and what it costs

`mock/invocations.ts` used to rank every THROWN run into 0.05–8h and every
clean run into 8–24h, so in newest-first order every error outranked every
success. `trace-sink-union.test.ts` pinned that as a contract, and there was a
real defect behind it: spread evenly across the day, the day's errors competed
for slots with clean rows and two fell past `/recent-invocations`' fixed
50-row window, so Health linked to a list that could not show the errors
Health had just counted.

The cost was that the Runs page opened wall-to-wall red. All fourteen of the
day's errors landed inside the fifty most recent rows by construction, so the
error share of what was on screen was 28% while Overview, reading the same
corpus, said 4.2%. Two pages, one day of traffic, opposite impressions.

A first attempt at interleaving the errors through the window instead of
ahead of it, on 2026-09-16, was reverted rather than half-done: it satisfied
the underlying requirement (every error still inside the tail) but broke three
further behaviours that leaned on the stronger disjoint-band property rather
than on the requirement itself, and re-deriving all three honestly looked
bigger than it turned out to be.

**It shipped on the second pass.** `mock/invocations.ts` now exports
`TAIL_WINDOW` (50, matching `/recent-invocations`' default) and
`interleaveThroughTail(errors, clean, TAIL_WINDOW)` spreads the day's errors
evenly across the first `TAIL_WINDOW` ranks — mixed with clean rows rather
than staged ahead of them — before the rest of the day's clean rows fill out
to 24h. The 14 seeded errors now land roughly one every three or four rows
inside the tail, which is what a bad hour actually looks like, rather than a
wall. The three dependent behaviours were re-derived, not bent:

- **`trace-sink-union.test.ts`, "leaves the seeded error band ahead of the
  seeded clean band"** pinned the mechanism (every thrown row outranks every
  clean row). It's now "keeps every seeded error inside the tail window the
  Runs list actually shows" — it asserts the REQUIREMENT instead: every
  thrown row's rank is `< TAIL_WINDOW`, whatever the corpus size.
- **`trace-sink-union.test.ts`, "shows up in the 1h outlier list, which the
  seeded clean rows cannot reach"** depended on the old band leaving the
  1-hour drift/outlier window with nothing but failures (no embedding, no
  distance) in it. That premise is gone — some of the day's own clean rows now
  legitimately fall inside the newest hour too, so the list is non-empty
  before any write. The honest post-change property, and what the test (now
  "is reachable in the 1h outlier list on the strength of its own measured
  distance") asserts instead: a written row still reaches the list on its own
  measured distance (0 — one written row is its own centroid), landing at the
  bottom of the dist-descending sort rather than needing an empty list to
  appear in at all.
- **`observability-fixtures.test.ts`, "separates a real failure from a weak
  answer — the errorRate gotcha"** pinned ingestion's `low_quality_count` at
  6. That number was never a designed target — `judge_score` is a
  deterministic hash of each row's `invocation_id`, and interleaving changed
  which of ingestion's clean rows land on which id, which moved how many hash
  into the `< 0.3` bucket. It's 4 now; the test still asserts it against a
  direct count over the same rows the list shows, which is the property that
  actually matters.

One further thing broke that wasn't on the anticipated list: `mock/observability.ts`'s
`humanLabels` fixture hardcoded five demo narratives — "Timed out mid-route",
"Blocked on a question the guardrail should not have caught" — against literal
`mock-inv-N` ids. Those ids are RANKS, not identities, so the moment
interleaving moved which row lands on `mock-inv-0`, its note started
describing a row that hadn't timed out. `humanLabels` now resolves each
target by `agentId` + `promptSnippet` (`labelTarget()`) instead of a bare id,
so a label stays attached to the row its note is actually about regardless of
how the corpus is ordered — and the two entries whose targets never actually
matched their notes even under the old band (a preexisting mismatch, not
something this change caused) got pointed at rows that do.

## The fleet that was empty by construction (2026-09-16)

`Computer Lab` is a nav item of its own — the tmux-shaped multiplexer over
microVM sessions — and in the entire `dev:mock` demo it showed **nothing**.
`GET /api/devbox/boxes` answered `{"boxes":[]}` while its sibling
`/api/environments` came back richly seeded.

The cause is one line. `providers/devbox-fleet-store.ts::loadFleet()` opens
with `if (!usable()) return []`, and `usable()` is false whenever Aurora is
mocked — so the fleet was empty *by construction*, not by accident, and had
been for as long as the offline mode existed.

This is contract.ts rule 5, and `mock/lab.ts`'s own header already names it
about its surface: "THE STORE WAS EMPTY, so `GET` returned `[]` and an unbuilt
feature and an unseeded one looked identical." The lab is the more expensive
version, because **its empty state is phrased as an instruction** — "No
computers to lab · Provision at least one computer". A blank list reads as
unfinished; an instruction reads as *waiting for you*, and the obvious next
move offline is to try provisioning against a runtime that is not there.

### What the seed is chosen to exercise

`lib/devbox-visibility.ts` recognises three shapes of computer, so a seed
carrying only one of them exercises a third of the rule. `mock/devbox-fleet.ts`
seeds at least one of each — shared (a `projectId`), personal (an `ownerId`
and no project), and unattributed (neither, the shape the fleet makes for
itself) — using real `u-*` subs and real `p-*` initiative ids, never invented
ones. A box charged to an initiative nobody is attached to would be invisible
to every role and would look like a bug in the filter rather than a seed that
says nothing.

Measured live, which is the point of choosing the rows that way:

| caller | sees |
|---|---|
| `u-rachel` (hr-admin, org-wide) | 5 |
| `u-nora` (sme, on auth-migration + observability) | 3 |
| `u-layla` (sme, on observability only) | 1 |

`stopped` is deliberately never seeded: `loadFleet` filters `status <>
'stopped'` and prunes those rows, so seeding one would be inventing a state the
real loader guarantees never arrives.

### The in-memory Map is not fixture rows

The boxes live in a `Map` in `lib/devbox-fleet.ts`, hydrated once at boot — so
`registry.resetAll()` cannot reach them. Left alone, that broke the control
plane's single promise in both directions: a box renamed during a demo survived
`POST /api/__mock/reset`, and pinning `devbox-boxes` to `empty` changed the
fixture while five boxes stayed on screen.

`rehydrateMockFleet()` closes it, and is called from **every** mock-control
mutation — the full reset, a per-fixture reset, and both scenario routes —
following the `clearDevPairings()` precedent already in that file, which exists
for exactly the same reason. It re-reads the fixture rather than caching a
copy, so it follows a pinned `empty` instead of dragging the default fleet back
over it.


### Durable document service boundaries

Document collaboration deliberately uses the owning gateway/platform/source
services when Aurora is mocked. Their successful replies mean a real durable
write, review transition, or remote publication; manufacturing those replies in
an Aurora fixture would create a second authority. Missing configuration returns
an explicit unavailable response. The write scanner still reports these paths as
`DOCUMENT_SERVICE`, with function-qualified entries and test/evidence references
in `DOCUMENT_SERVICE_BOUNDARIES`; the existing unmocked-Aurora budget stays 25.
New outbound functions are not implicitly covered. The wire replay refuses these
operations because resetting Aurora fixtures cannot undo them. Isolated integration
proof is in `research-evidence/document-workspace-live-2026-09-20.json`.
