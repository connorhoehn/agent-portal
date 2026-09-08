# Goal: finish the assessment tenant to its definition of done

Paste this as the `/goal`:

> Bring the assessment tenant (`/assessment/*`, `docs/assessment-tenant.md`) to
> its definition of done: `scripts/validate-assessment-tenant.sh` exits 0.
> That script is the only judge — do not declare anything done that it does
> not confirm. Work the backlog in `docs/assessment-goal.md` in order, running
> the script after every slice and treating each failing line as the next
> task. Use subagents (Sonnet) for parallel slices that touch disjoint files;
> keep shared files (App.tsx, Layout.tsx, routes/assessment.ts, the mock) to
> one owner at a time. Until 08:00 local the time gate keeps this goal open;
> when every functional check passes before then, work the stretch backlog.
> No `npm install` anywhere (the user is offline; git installs wedge). If a
> library primitive is missing, compose from existing ui-components primitives
> and record the gap in `docs/ui-components-queue.md` — never hand-roll.

The validator prints every failing check with the specifics. Run it as
`scripts/validate-assessment-tenant.sh --quick` between slices (skips the slow
suites) and without flags before claiming a slice done.

## Status (2026-09-05 06:30, overnight run) — definition of done met, second review closed

A second adversarial code review of everything changed tonight
(`docs/assessment-journeys/REVIEW-2026-09-05.md`) substantiated ten
findings; eight are fixed with tests (self-approval of N/A exceptions,
program-lead locked out of user admin, no Aurora run-completion path,
non-atomic superseding commit + missing DB constraints, presence leave race,
SSE replay gap, SSE error crash, `run_id` dropped on reads), two are
dispositioned by design with follow-ups queued (markdown audit logs vs a
machine artifact; the tenant-wide replay ring). Closing numbers: middleware
`tsc` clean, 108 suites / 1632 tests; validator ALL CHECKS PASS with the
08:00 gate the only remaining line.

## Status (2026-09-05 05:40) — definition of done met

Final full run of `scripts/validate-assessment-tenant.sh` (no flags): every
functional check ✓; the 08:00 time gate is the only remaining line.
Middleware 98 suites / 1571 tests; portal tsc, 154 assessment tests, build;
0 raw elements outside 3 composed files; 48/48 journey + 10/10 isolation
logs present, passing, fresh; 60 parity rows, 0 partial. Realtime now
passes in BOTH modes — gateway (18080: presence ×2, live saves, CRDT, comments)
and BFF-only (SSE doc sync, comments, presence; survives a middleware restart
via epoch-prefixed frame ids + a heartbeat watchdog, proven ten minutes after
a forced restart). A `score-dimensions` run scores a team end to end; the
accessibility sweep passes with listbox rail semantics.

## Earlier status (2026-09-05 04:25)

`scripts/validate-assessment-tenant.sh` (no flags): every functional check
passes; only the 08:00 time gate remains. Real numbers: middleware 98 suites /
1569 tests, portal tsc + 131 assessment tests + vite build, 0 raw elements
outside the 4 queued composites, 48/48 journey logs + 10/10 isolation logs
present, passing and fresh, 60 parity rows with no `partial`. Stretch:
two-tab realtime passes in gateway mode; the BFF-only proof found and fixed a
real one (SSE frame ids restarted with the process, so a tab that lived
through a middleware restart silently dropped every later event — ids are
now epoch-prefixed, restart re-proof in flight), a
`score-dimensions` run scores the team end to end, accessibility sweep passes
with listbox semantics on the scorecard rail, Aurora path complete, CDK synth
clean except the credential-bound VPC lookup.

## Earlier status (2026-09-05 00:30)

Validator sections green: middleware + portal tsc/tests/build, component
discipline (0 raw elements outside the 3 queued composites), route↔test
parity (96 route tests), role isolation (10 logs + 5 code checks), source
parity (60 rows). Open: the 48 per-role journey logs (assessor pass in
flight), then the fix-and-re-audit loop those surface. Shipped beyond the
backlog: `schema/assessment_schema.sql` plus a complete Aurora path for
`providers/assessment.ts` (every function; `assessment-aurora.ts`, 96 suites /
1545 middleware tests with the Data API stubbed — no SQL has run against a
live cluster yet, none is reachable offline), the orgiq route-tree guard, the demo-picker two-step fix, the
shared rail/palette group order, and the code-review fix pass on
`routes/assessment.ts` / `providers/assessment.ts` (input validation,
prototype-pollution, N/A self-grant, tenant-scoped grants).

### Journey audit rounds so far

- **Assessor (u-asha)**: 12 logs; 14 defects filed, all fixed the same night
  (keyboard-dead tables, raw enum labels, `labelId` DOM leak, TEAM-999
  outage copy, dead submissions search, the whole wizard parse/commit
  contract, wizard step-3 link marking + gate bypass + grammar, explorer
  rail inset + keyboard-dead tree, two "missing key" page bugs, the
  palette's cross-tenant 403 poll).
- **Lead-assessor (u-jonas)**: 12 logs, 10 pass first time; the Exceptions
  modal clipped Approve/Deny (widened, decision folded under the status
  pill) and the workspace pane sat at 0.49 of the content width (the activity
  aside now stacks below the pane until 1536px).
- Program-lead, admin, and the re-audits of the fixed surfaces follow.

## Why this goal exists

The first pass shipped ten pages that type-check, test green, and build — and
still look wrong. The Workspace screenshot at 1900px: the tree rail floats
with a 90px gap instead of sitting flush like a navigator, the document pane
fills under half the width with a void beside it, the activity bar is
detached, and the connection state is styled like a log line. And the pages
are scaffolded from **274 raw styled HTML elements** (80 `<div className>`)
against 60 in the reference orgiq pages — `DimensionMasterDetail.tsx` alone
carries 73. Green checks did not catch either, so the validator now has a
component-discipline gate with a ratchet, a per-role journey audit with
measured layout verdicts, and a source-parity table. "Looks fine" is not a
check.

## Backlog, in order

### 0. Role isolation audit — first, because it is the one the user caught

An orgiq SME opened the app and could see the assessment pages. The tenancy
model says that is impossible: `sme` holds a grant in `orgiq` only, so the
Assessment tile must not appear on `/select`, no assessment entry may appear
in the rail, `/assessment/*` must render not-found (or redirect home) for
that session, and every `/api/assessment/*` call must 403 at
`requireTenant`. Audit it for every role that holds no assessment grant —
member, sme, program-owner, org-leader, hr-admin — and the
reverse for assessor / lead-assessor / program-lead against `/iq/*`.
Sign in as the REAL user for each (u-theo, u-nora, u-mia,
u-vera, u-hr; u-asha, u-jonas, u-farah), never Demo
User, whose synthetic grants span every tenant and therefore prove nothing.

Write `docs/assessment-journeys/isolation/<role>.md`:

```
role: sme
user: u-nora
assessment-tile-visible: no        # on /select, Workspaces tab
assessment-nav-visible: no         # rail after landing
direct-route-result: not-found     # what /assessment/teams renders
api-status: 403                    # curl /api/assessment/teams with this session
screenshot: sme.png
verdict: pass
notes: ...
```

and `docs/assessment-journeys/isolation/<role>-outbound.md` for the three
assessment roles with `orgiq-nav-visible`, `orgiq-route-result`,
`orgiq-api-status`. Where a check fails, FIX it (the shell's nav filter, the
route tree's tenant guard, `SelectContextPage`'s tile derivation, the
middleware gate), then re-audit. Pin the server side with a middleware test
that logs in an `sme` and asserts 403 on `/api/assessment/teams`.

### 1. Workspace/Enterprise/Rules/Prompts layout parity (the screenshot)

Reproduce `ui/src/components/knowledge/DocumentsExplorer.tsx`'s frame, not
its approximation:

- Left rail: **flush to the content edge**, full height of the pane, its own
  right border, 300px, scrolls independently. No card, no floating gap.
- Main pane: fills the remaining width; the document card is the pane's
  content, not a centred island. Breadcrumb row at the top of the pane with
  the connection state as a small `ConnectionPill`, not a headline.
- Activity bar: `xl:w-80`, stacked below the pane under `xl`, never a
  detached column with one line in it.
- Measure it. The journey log's `layout:` line is earned by numbers:
  rail left edge within 8px of the content edge; document pane ≥ 55% of the
  content width at ≥1440px; no vertical scrollbar on the page body while the
  rail scrolls.

If `RailLayout` cannot express this (it renders its rail on the right), the
composite that can is a `SplitPane`/`ExplorerLayout` — compose it from
`Stack`/`Inline`/`RailSection` inside ONE new file under
`portal/src/pages/assessment/knowledge/ExplorerFrame.tsx` that is the single
place raw layout elements are permitted, and queue the primitive in
`docs/ui-components-queue.md`. Everything else imports the frame.

### 2. De-hand-roll every page (ratchet `MAX_RAW_ELEMENTS` to 0)

For each file, worst first (`DimensionMasterDetail`, `ImprovementPlan`,
`EvidenceIntake`, `FeedbackPage`, `SubmissionsPage`, `RunsPage`, …):
replace raw `<div className="flex …">` with `Stack`/`Inline`; raw `<p>`/`<span>`
captions with `SectionLabel`, `MetaLine`, `DetailSection`, `PageSection`,
`Chip`, `StatusPill`; raw headings with `DetailHeader`/`PageHeader`; raw
lists with `DataTable` or `Card` lists; raw `<a>` with `Link`/`Button`. After
each file, lower `MAX_RAW_ELEMENTS` in the validator to the new count. It
may never go up. When a needed composite does not exist, compose it once in
a local `*Frame.tsx`/`*Row.tsx` and queue the primitive.

### 3. Per-role journey audit (4 roles × 12 surfaces)

Roles: `assessor` (u-asha), `lead-assessor` (u-jonas), `program-lead`
(u-farah), `admin` (u-operator entering the Assessment workspace). Sign in
through `/select` → **Sign in as** → the user card → the Assessment role tile;
never audit as Demo User (its context reverts).

Surfaces: dashboard, team-scorecard (all five tabs, and a dimension selected),
submissions, submissions-wizard (all four steps), feedback, reports, runs,
configuration, workspace, enterprise, rules, prompts.

For each, write `docs/assessment-journeys/<role>/<surface>.md`:

```
surface: team-scorecard
role: lead-assessor
url: /assessment/teams/TEAM-001?tab=plan
screenshot: team-scorecard.png          # saved beside the log, ≥1440px wide
verdict: pass                           # or fail + what
console errors: 0                       # from read_console_messages, errors only
layout: pass                            # the measured thresholds, with numbers
keyboard: pass                          # Tab reaches every control; Enter/Space act; Escape closes
empty-state: pass|n/a                   # what it shows with no data / a 404 / a 403
role-gating: <what this role can and cannot do here, and that the hidden controls are hidden>
notes: <anything a person would notice: wrapping, truncation, wrong labels, dead links>
```

A log with `TODO`, `unverified` or `placeholder` in it does not count. A log
older than the newest page edit does not count — re-audit after changing a
page. Empty and error states are part of the surface: clear the mock (or
use TEAM-006/007, which are new) and load the page; force a 403 by using the
role that lacks the capability; force a 404 with a bad id.

### 4. Source parity table (`docs/assessment-parity.md`)

One row per source page (20 in `ui/src/pages`), per slash command (9), per
workflow package (6), per scorecard tab (5), per dimension-detail tab (5):
`| feature | ported/partial/out-of-scope | note |`. `partial` blocks the
goal — finish it or make the call and write why. Expect ≥40 rows.

### 5. Every mounted route has a test that calls it

The validator lists the untested paths. Cover each with the role that may
call it and the role that may not.

### 6. Things the first pass skipped

- Team creation (`POST /teams` from the dashboard — a `Modal` with name +
  cohort + lead; deterministic `TEAM-0NN`), delete, reset-assessment, PATCH
  lead — all wired to the actions menu the source's `TeamActionsMenu` has.
- Exceptions modal on the scorecard (`ExceptionsModal.tsx` in the source):
  requested N/A rows with Approve/Deny for a lead, read-only for an assessor.
- Scoring logs (`GET /teams/:id/scoring-logs`) behind "How it was assessed".
- Provenance ledger (`GET /teams/:id/provenance`) on the Evidence tab.
- `?cohort=` deep links on the dashboard; `?tab=` on the scorecard survives
  refresh; browser Back walks the three dashboard views.
- The Runs page's launcher must react to its own launch: the new row
  appears from the SSE `run.started` event, progress ticks, then completes —
  no manual refresh.
- Dark theme on every surface (the shell supports it; check tokens, not
  hardcoded greys).
- Widths: 1280 (rail + pane, activity stacked), 1440, 1920.

## Stretch backlog status (02:30, every functional check green)

- Two-tab realtime proof: **failed honestly** (`stretch/realtime.md`). The
  knowledge pages ride realtime-modules' `useChannel`, which needs the
  websocket-gateway on :8080 — not running here — and `portal/.env.local`
  points `VITE_GATEWAY_URL` at the middleware, whose `/ws` was a do-nothing
  stub that made `ConnectionPill` say "Connected". Fix in flight: doc sync,
  comments and presence delivered over the BFF's own SSE broker (with the
  gateway merged in when it is up) and a connection pill that tells the
  truth. Re-proof after it lands.
- Agent end-to-end: ledger/SSE mechanics pass (`stretch/agent-e2e.md`), but
  the mock `score-dimensions` completion wrote a one-dimension "placeholder"
  log and applied nothing. Fix in flight: a deterministic 17-dimension log
  built from the team's real intake + submissions, applied through
  `applyScores` so the scorecard changes.
- Accessibility sweep: pass (`stretch/accessibility.md`) — zero unnamed
  controls on 12 surfaces, correct tree/dialog semantics; one gap (the
  scorecard rail has no listbox semantics) being fixed.
- Aurora path: done for every provider function (see the tenant doc).
- `npx cdk synth`: every stack synthesizes except `OrgIQ-MiddlewareService`,
  whose VPC lookup needs live credentials ("AWS was not able to validate the
  provided access credentials") — expected offline, not drift; no infra file
  was touched by this work.
- Performance: the scorecard makes ONE team-detail request (`useTeamDetail`);
  no per-dimension fetch exists in `dashboard/*` to remove (verified by grep —
  zero `useFetch(` calls in the dimension components).
- Docs: `docs/assessment-tenant.md` and this file updated as work landed.

## Stretch backlog (after every functional check passes, until 08:00)

- Two-tab realtime proof: two browser tabs on the same document — presence
  shows the other viewer, an edit in one appears in the other via CRDT, a
  comment in one lands in the other's drawer. Screenshot both.
- Agent end-to-end through the fleet: launch `score-dimensions` from the
  Runs page, watch the run record complete, open the scoring log it wrote.
- The Aurora path of `providers/assessment.ts`: replace `notMocked` with real
  SQL for teams/assessments/runs against `schema/assessment_schema.sql`
  (write it — mirror the domain model), so the tenant is not mock-only.
- `npx cdk synth` for the stacks the agents touched; fix drift.
- Accessibility pass with the browser's accessibility tree: every control
  has a name; the master-detail rail is a `listbox`/`tablist` with
  `aria-current`; the tree is a `tree` with `aria-expanded`.
- Performance: the scorecard for TEAM-002 (17 dims × evidence × history)
  renders in one paint — profile with the console, remove the waterfall of
  per-dimension fetches if there is one.
- Update `docs/assessment-tenant.md` with what actually shipped, and this
  file's backlog with what is left.

## Follow-ups queued by the 2026-09-05 review

- An assessment-tenant Users page for program-lead's tenant-scoped
  `ManageUsers` (the API is reachable and scoped now; the only UI is orgiq's
  `/admin/identity`, which `RequireTenant('orgiq')` correctly hides).
- A Playwright-driven isolation artifact (timestamp + response hashes per
  role) to back the markdown journey/isolation logs with a machine proof.
- Deploy the machine-callback secrets: `OrgIQ-MiddlewareService` injects
  none of `ASSESSMENT_RUN_COMPLETE_SECRET` / `HARNESS_TRACE_SECRET` /
  `APPROVALS_REQUEST_SECRET` / `LAB_CALLBACK_SECRET` /
  `GATEWAY_SERVICE_AUTH_SECRET`, so every sessionless callback runs
  dev-open in ECS; also make those guards refuse when `NODE_ENV=production`
  and the secret is unset (see REVIEW-2026-09-05.md post-fix note).
- The SSE replay buffer is one tenant-wide ring; a `stream.gap` event now
  tells a reconnecting client when its seq predates the buffer, but the
  DocPane notice for it is not wired yet (hook exposes `gapped`).

## Rules that do not bend

- The validator is the judge. Run it; read every failing line; fix the line.
- No `npm install`, anywhere, for any reason, while offline.
- No hand-rolled HTML/CSS in pages. If the composite is missing, compose it
  once in a `*Frame.tsx`, queue the primitive, move on.
- Build to the middleware's response shapes — the mock is the contract. A
  page never invents a key; if it needs one, add it to the mock and the
  provider first.
- Guard on shape, not presence. A failed fetch still resolves to a body.
- Report the real numbers from the real commands. A green claim the
  validator does not confirm is a false claim.
