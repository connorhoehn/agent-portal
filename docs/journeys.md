# Journey logs — what a walk proves, when it goes stale, how it is sealed

A journey log (`docs/<family>-journeys/<dir>/<surface>.md` plus its
screenshot) is the record of a real browser walk of one surface as one seeded
user. **The preferred way to produce one is a journey map walked by the runner**
(below, "Journey maps"); a hand walk is still accepted where no map exists. Each family's `PROTOCOL.md` says how to walk and which fields to write;
each family's validator judges the fields. This page is the one rule for the
part they all share: **freshness and sealing**. One implementation backs it:
`scripts/journeys/journeys.mjs`, sourced by every judge through
`scripts/lib/journeys.sh`.

| family | judge | logs judged |
|---|---|---|
| `orgiq-journeys` | `validate-orgiq-audit.sh` | the MATRIX.txt surface × role logs |
| `assessment-journeys` | `validate-assessment-tenant.sh` | role × surface, isolation, stretch, the review |
| `social-journeys` | `validate-social-tenant.sh` | every log |
| `pipelines-journeys` | `validate-pipelines-tenant.sh` | every log but fixtures |
| `communication-journeys` | `validate-communication-plane.sh` | the 24 required logs that carry every field |
| `distillation-journeys` | `validate-distillation.sh` | the current surfaces (knowledge, review, activity) |
| `search-journeys` | `validate-search-workspace.sh` | every log |
| `branding-journeys` | `validate-branding.sh` | the four theme cells |

## Journey maps — executable walks (preferred)

A journey map is the walk as data: who walks, what they want, the ordered
steps, what each step must show, and which fields of the family's
`PROTOCOL.md` the steps prove. `scripts/journeys/run-maps.mjs` walks it
headlessly, measures every step with the ui-dom-audit, writes the family's log
in its protocol's format with an honest verdict, and seals the directory only
when every map in it passed. Coverage over all maps is generated into
[docs/journeys/coverage.md](journeys/coverage.md).

```bash
node scripts/journeys/run-maps.mjs check                       # validate every map (no browser)
node scripts/journeys/run-maps.mjs walk --family access        # walk, write logs, seal passing directories
node scripts/journeys/run-maps.mjs walk --only requester/ --no-seal
node scripts/journeys/run-maps.mjs coverage [--check]          # docs/journeys/coverage.md
node scripts/journeys/run-maps.mjs burndown --family access    # route × rule pairs the last walk found, not yet owned
node --test scripts/journeys/tests/*.test.mjs                  # the runner's own tests
```

### The format

Maps live at `docs/journeys/maps/<family>/<dir>/<surface>.ts` (the log they
write is `docs/<family>-journeys/<dir>/<surface>.md`) and default-export one
object `satisfies JourneyMap` (types: `scripts/journeys/journey-map.ts`).
Files starting with `_` are shared fragments: each family keeps its surfaces'
steps once in `_shared.ts`, parameterised by role, so the roles' maps differ
only where the separation of duties says they must.

| key | what |
|---|---|
| `family`, `log`, `kind` | which family profile (`scripts/journeys/maps.mjs` `PROFILES`: the field list of each log kind — `surface`, `isolation-inbound`, `isolation-outbound`) |
| `persona` | seed user, tenant and role (asserted on `/api/session/me`); `switchRole`/`switchTenant` when the role is not the user's landing |
| `goal` | one sentence; it opens the log's `notes:` |
| `scenario` | `'shared'` (the shared mock, read-only) or `{ scope }` — a request-scoped mock world (`withMockScope`, copy-on-write); a map that writes must have one |
| `identity` | `clone` (default): a fresh clone of the persona per walk (`openAsClone`), so walks run beside audits and each other. `persona` (with `identityReason`): the seed user itself — the runner walks it only with `--allow-persona`, and never while `pgrep -f audit.mjs` shows an audit |
| `writes`, `hold` | a map whose steps write declares `writes: true` (and a scope); `hold: '<why>'` keeps a map from being walked at all (e.g. a write that reaches state no scope covers) |
| `fields`, `claims` | static fields (`surface`, `pages`); the value each claim field states when its proving steps pass (default `pass`) |
| `steps` | ordered; the first navigates |

A step is one of `navigate {url}`, `click {target}`, `press {key, target?}`,
`fill {target, value}` (a UI-local control: search, filter, palette, command
composer), `back`, `wait {target}`, `tab-walk {max?}` (the skill's
`focusWalk` probe) and `api {url, method?, body?}`. Targets are by role and
accessible name first (`{ role, name, level?, within? }`), then `testId`,
`label`, `placeholder`, `text` or `css`. Each step carries `name` (a plain
sentence written into the log), `state` (the coverage state it shows:
`default`, `empty`, `filtered-empty`, `not-found`, `refused`, `row-open`,
`dialog-open`, …), `proves` (the protocol fields it is evidence for) and
`expect`: `url`, `urlNot`, `visible`, `absent` (not in the DOM at all),
`hidden`, `text`, `noText`, `disabled`, `enabled`, `focused`, `count`, `attr`,
`status` (api), `minVisited` (tab-walk), `firstRowTopMax` (the density rule)
and `noHscroll` (on by default). `expectConsole` names console errors a step
expects (a 404 lookup); any other console error fails the step.

`check` refuses a map where a claim field of its kind is proven by no step, a
step writes without `writes: true`, a writing map has no scope, a non-GET api
call in a read-only map is not a 4xx refusal probe with a `refusal` reason
(why it cannot write even if the gate were open — e.g. a body the route
rejects), or any string would put TODO / unverified / placeholder into a log.

### The runner

For each map: a fresh context signed in through `portal/e2e/realSession.ts`
(`openAsClone` by default; `withMockScope` for a scope), every non-GET request
the page sends **blocked and recorded** for a read-only map (a user action that
tried to write fails its step), then per step: act, settle (bounded), judge
`expect`, record the layout facts the protocols ask for (horizontal scroll,
h1 size/weight and position, the trail, row heights, the composer's dock,
first-row-top), measure with the skill, screenshot to
`.scratch/journeys/<family>/<log>/NN-<action>.jpg`. One protocol rule holds
throughout: a failed step is recorded and the walk keeps going.

The audit is the skill's own: the runner imports `measureDOM` from
`.claude/skills/ui-dom-audit/scripts/measure.mjs`, the contract
`references/work-ui.contract.json` (validated by `run.mjs`'s
`validateContract`), the adapter's selectors and its composer policy
(`portal/e2e/ui-dom-audit.adapter.ts`), and applies them the way `run.mjs`
applies one case (motion paused, fonts and two frames, measured twice,
instability reported). No rule is forked.

A finding fails the step — except one the **audit burn-down**
(`docs/journeys/audit-burndown.tsv`: route key, rule, owner, reason) owns.
Those stay visible in every log's `dom-audit:` line and never vanish; a row
is a decision a person writes (`run-maps.mjs burndown` only prints
candidates), and removing a row makes the finding fail again.

A BFF reload drops lane M's in-memory clones and scopes; the runner sees the
401/410, re-mints and walks the map once more, and says so in `notes:`.

The log is written in the family's field order: the built-in fields
(`url:` from the URLs actually visited, `audited:`, `session:` with the clone's
id, `screenshot:` — the first navigate's, or the step marked
`screenshot: 'log'` — `verdict:`, `console errors:`, `layout:`, `dom-audit:`,
`notes:`), each claim field as `<claim> — <the proving steps' sentences and
observations>` or `fail — <the step and its first failure>`, and a step table.
`verdict: pass` only when every step passed, no unexpected console error
occurred and layout passed. Then `scripts/journeys/seal.sh <dir>` runs for
each directory whose every log was written by this run and passed — the same
seal as for a hand walk, with the same refusals (contracts not measured on the
current source, the walk proof). A directory with a failed walk is left
unsealed and its judge stays red.

### What a clone can and cannot walk

A clone carries its persona's grants and person link but its own user id, and
records keyed by user id stay the persona's. In the access tenant that is
every request, step and event, so a requester or approver clone owns nothing
on the shared data: its maps prove the gates and the honest empty and
not-found states, not the persona's own flows (withdraw, an inbox with a row,
a decision). Those need either a scoped write that reaches no shared mirror
(`maps/access/approver/decision-walk.ts`, held: a decision rings the bell
through the unscoped notification store) or a clone that owns its persona's
records.

## The rule: a log is stale when a walked route's rendered contract changed

A walk proves what the walker saw on a route — its layout, its type, its rails,
the behaviour its specs pin — not which bytes were on disk. Until 2026-10-08
every judge keyed freshness on the source files a log named (`pages:`, by
content digest or by mtime), so a refactor that kept every page looking the
same — the density codemod, a sign-in helper moving — restaled every log over
it: 22% of a day's churn was journey logs re-walked for no visible change.

Now each log is judged by the **rendered contract** of the routes it walked.
A log names its routes on its `url:` line (an isolation or rail log with no
`url:` names them in its other fields; `notes:` never counts). Each URL
resolves through the route inventory (`portal/e2e/route-inventory.ts`
`routeKey`) to the key the sweeps record it by, and the contract of that key
is:

| part | what it is | where it is measured |
|---|---|---|
| `cascade <key>` | the layout-cascade invariants the route breaks (rails, list-rail, crumbs-first, gutter, title, footer, hscroll at 1680 and 1280) and where it lands if it redirects | `layout-cascade.spec.ts` → `docs/journeys/contracts/cascade.json` |
| `type-scale <key>` | the page title's size/weight and the route's off-scale sizes (rule · region · size/weight, the burn-down's key) | `type-scale-sweep.spec.ts` → `…/type-scale.json` |
| `type-scale <tenant> · primary rail` | the tenant's primary rail offenders (every route of the tenant shows it) | same |
| `type-scale <state>` | a judged other-user state (`STATE_ROUTES`) when the log's user is that state's user | same |
| `rail <subject>` | MATCH, or the rail-frame problems (numbers masked), for every rail subject at or under the walked URL | `scripts/lib/rail-parity-measure.mjs` → `…/rail.json` |
| `gate <key>` | App.tsx's RequireRole roles on the route, and whether it only forwards | `portal/e2e/route-sources.ts`, read live |
| `spec <file>` | the normalised `expect(…)` statements inside the `test(…)` bodies of every spec that names one of the route's URLs | `route-inventory.ts` `specCoverage` / `specAssertions`, read live |
| `theme …` (branding only) | the digest of `app.css` and `Layout.tsx` — the tokens are what a branding walk proves, and no sweep measures colour yet | read live |

The values are **categorical** on purpose (which invariants fail, which sizes
occur, MATCH or not), so re-measuring an unchanged page writes the same bytes:
`docs/journeys/contracts/*.json` only change when a contract does, and each
route carries `changedAt`, the time its value last moved. A helper moved
between files does not change `spec` (only assertions inside tests count);
a pixel of noise does not change `rail`.

The log's digest is the hash of all its parts. `.contract-sha` in the family
directory records, per log, that digest, every part's own hash, when it was
sealed and on what basis. A judge reports each log as

- **fresh** — its contract equals its seal;
- **stale** — a part moved since the walk (the judge names the first parts that moved);
- **unsealed** — no seal under this rule (walk it, then seal);
- **unswept** — it walked only routes no sweep measures (add the route to the inventory, below);
- **unrouted** — it names no inventoried route and no `pages:` files.

A log that names no inventoried route at all — a review, a stretch proof —
keeps the old rule: the content digest of the files on its `pages:` line.

### Measured on the current source, or not at all

Every contract file records the `sourceDigest` it was measured against (all of
`portal/src` but tests, plus `portal/package.json`, computed before and after
the sweep — a source that moved mid-sweep is recorded as `mixed`). When the
source has moved since, every judge fails **one** line — "rendered contracts
are not measured on the current source … run scripts/journeys/measure.sh" —
and its per-log verdicts are provisional. Re-measuring is a machine's job
(about 13 minutes on the Tilt stack); re-walking is a person's, and is now
owed only for logs whose contract really moved.

```bash
scripts/journeys/measure.sh              # rails, cascade, type scale; records all three
scripts/journeys/measure.sh type-scale   # or one of: rail cascade type-scale
```

`validate-rail-parity.sh` (full mode) runs exactly this as its measurement.
A filtered sweep (`LAYOUT_CASCADE_ONLY`, `TYPE_SCALE_ONLY`, another
`TYPE_SCALE_USER`) records nothing.

### Routes the walks use that the judges do not

`OBSERVED_ROUTES` in the inventory lists routes a journey walks that the
judged inventory does not hold (a channel conversation, a DM, a bot record,
`/admin/identity/roles`). The sweeps measure and record them but never judge
them — they are outside the cascade baseline and the type-scale burn-down.
To give a new walk a contract, add its route there (or to `PARAM_ROUTES` to
judge it too). A route that only forwards (a `<Navigate>` or `*Redirect`
element) or a wildcard has its gate as its whole contract.

## Sealing: only a walk seals

```bash
scripts/journeys/seal.sh docs/<family>-journeys/<dir>
```

One directory per call, by whoever walked it; nothing is written unless every
log in the directory passes. It refuses when

- the contracts are not measured on the current source (measure first);
- a log lacks a field its family requires, says TODO/unverified/placeholder,
  or its screenshot is missing;
- a log names no route and no `pages:`, or walks a route no sweep measures;
- **the walk proof fails**: the log and its screenshot must both have been
  written after every contract part that moved (all parts, for a first seal)
  last changed, and after the previous seal. A log nobody re-walked cannot
  be sealed over a contract change.

The validators no longer seal: their old `--seal` flags exit 2 with a pointer
here, and `seal-communication.sh` is gone. The proof reads mtimes, so it is a
guard against sealing an unwalked log, not evidence of a walk — a fresh clone
or a bulk `touch` sets every mtime to now (the "validator staleness needs
mtime" trap), which is why it is only one of the seal's conditions and why the
judge itself never reads an mtime.

## What the rule does not see

- **Roles.** The sweeps sign in as the inventory's user (`u-operator`, every
  grant); a change only one role sees moves no sweep. The `gate` part and the
  specs that walk as that role are what cover it.
- **Behaviour no spec asserts.** Keyboard, empty-state and realtime steps are
  covered only where a spec names the route.
- **Data.** Contracts are measured over the shared mock stack; a fixture
  change that keeps the categories keeps the contract.
- **Spec results.** `spec` parts are the assertion text, not a pass/fail.

## The 2026-10-08 migration

The 263 logs stale under the source-digest rule at 04:45 that morning were
re-evaluated once, by a one-time script (not kept in the tree), and the
outcome recorded in each family's `.contract-sha` `basis`:

- `carried/…` — fresh under the old rule (its sources had not changed since its
  walk), so its walk saw the current contract: sealed with today's contract.
- `migrated/…` — stale under the old rule, but nothing on record says its
  routes' contract moved after the walk: no covering spec's file changed after
  it (pre-migration mtimes), the route's type-scale offenders equal the
  2026-10-07 baseline, its cascade violations equal the cascade baseline, and
  its rail subjects MATCH. Each carries its `walked` time. Walks older than
  those baselines (2026-10-07 12:50 cascade, 16:22 type scale) are carried on
  the absence of evidence: re-walk them first when time allows.
- not sealed — genuinely stale: a covering spec changed after the walk, or the
  type/cascade contract differs from its baseline, or the route is not swept.

The counts per family are in "Status" below. `.pages-sha` files are retired.

## Status

At the migration (2026-10-08, contracts measured three times on one
unchanged source; the second and third runs recorded byte-identical values):

| family | judged | stale, source-digest rule (04:45) | carried | migrated | genuinely stale (contract rule) |
|---|---|---|---|---|---|
| orgiq | 92 | 67 | 25 | 31 | 36 |
| assessment | 61 | 57 | 4 | 8 | 49 |
| social | 48 | 40 | 8 | 12 | 28 |
| pipelines | 55 | 55 | 0 | 4 | 51 |
| communication | 24 | 24 | 0 | 0 | 24 |
| search | 10 | 10 | 0 | 0 | 10 |
| distillation | 6 | 6 | 0 | 0 | 6 |
| branding | 4 | 4 | 0 | 0 | 4 |
| **total** | **300** | **263** | **37** | **55** | **208** |

Why the 208 remain: 96 logs have both a covering spec changed after their
walk and a type-scale contract that moved from its baseline, 61 only the
type-scale contract (offenders burned since 2026-10-07 — 75 of the 674 no
longer occur, mostly `/iq/projects`, `/assessment/teams`, `/pipelines/runs`,
`/social/channels` and the tenant landings), 51 only a covering spec
(`pane-composer-placement`, `app-type-scale`, `communication-*`,
`header-density`, `huddle-bar-surfaces` were all edited after those walks).
The refactor steps 1–4 changed the type and the specs on almost every
surface, so most of this is real; the coarse part is spec coverage — a spec
that only passes through a route to start a huddle still counts as covering
it. The judges are the source of truth after this.

## Records that are not walks

A file in a journey directory with no `verdict:` line is a record (a code
review such as `assessment-journeys/REVIEW-2026-09-05.md`, an agent ledger),
not a route walk: the judge reports it as `record` and the seal skips it. It
is outside the freshness rule — nothing rendered can make it stale — and it
is kept for its history. A walk may name its evidence as `screenshot:` or
`screenshots:` (first file is the one the seal checks). In the Social set a
`verdict: limited — <reason>` is a complete walk of a surface this stack
cannot fully show (the recordings logs); it seals, and
`validate-social-tenant.sh`'s S2 check keeps it visibly red.
