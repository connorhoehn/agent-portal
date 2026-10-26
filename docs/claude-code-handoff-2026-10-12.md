# Claude Code handoff — October 12, 2026

Start in `/Users/connorhoehn/Projects/aws-agentcore`. This is the current
handoff for the tenant UI consistency and deterministic audit work. Older
checkpoint prose in `CLAUDE.md` is historical, including claims about unmerged
release branches, old dependency versions, and a blocked local environment.
Use current code and Git state when they differ.

**Latest checkpoint:** read “Chassis C6 owner releases — 2026-10-26”
at the end of this document. The
“Current state” and verification sections immediately below describe the
original October 12 handoff, not the current dependency pins or acceptance.

## Current state

The user asked to prepare this handoff. No implementation or test process is
intentionally left running. The local application remains running and returned
HTTP 200 at `http://localhost:5183` during preparation. This handoff does not
launch Claude Code or send it a message.

All four repositories were clean, on `main`, and equal to `origin/main` before
these handoff documentation changes. Only the main branch/worktree remained.
Feature heads before the documentation commits:

| Repository under `/Users/connorhoehn/Projects` | Commit | Latest work |
| --- | --- | --- |
| aws-agentcore | `7269ac54` | Pipeline collection composers and audit view policies |
| ui-components | `462574e9` | Composer-policy validation and audit instructions |
| platform-api | `6ec1c81` | Disconnected recording observer cleanup |
| live-video-streaming | `4efbd69` | Recording finalization timeline correction |

The portal consumes shared UI **2.440.7** from the tracked tarball
`portal/vendor/connorhoehnslalom-ui-components-2.440.7.tgz`, referenced by
`portal/package.json` and its lockfile. The latest ui-components commit changes
the audit skill only; it does not require a new UI bundle. The last shared UI
source/build commit is `37ba8bd7`.

## User intent to preserve

- Fix inconsistent controls, typography, tables, gutters, panes and composers
  through their shared owners, usually ui-components. Keep business data,
  authority and actions in frontend adapters. Avoid page-specific CSS patches.
- Collection/table pages should offer the shared language-command composer
  unless there is a documented contextual reason not to. Commands must actually
  affect the table or perform supported operations, not display a fake AI input.
- Keep the audit reusable across tenants and future split frontend repos.
  Use DOM geometry and computed styles as deterministic evidence. Extend the
  skill when a reported defect exposes a missing rule.
- Use subagents for independent work/review. Serialize shared builds and live
  authentication tests. Commit/push finished work and preserve all work before
  removing branches/worktrees.
- The user revoked the earlier requirement to preserve the in-memory session:
  restarting/rebuilding when necessary is authorized. This is not authorization
  to deploy to cloud or reset business data.
- Earlier screenshots also concerned tenant switching, toolbar/footer styling,
  the mouse animation, ticker, huddles, and recording/realtime behavior. This
  latest audit is not proof that every historical request or backend path works.

## What was implemented

Shared component fixes from the preceding pass: compact control typography,
avatar readability, graph action font inheritance, precise graph/people caption
profiles, and full-width composer boundaries. Changes were built into the
consumed ui-components package, not patched in installed node_modules.

App composition lives in `portal/src/components/collections/`:
`CollectionCommandPage` owns the flush page/gutter arrangement;
`CollectionCommandHost` uses the shared ConversationComposer, help popover,
status feedback and optional confirmation dialog. These are app adapters over
library components, not replacement input/toolbar primitives.

Runs and Contacts already had bounded commands. The latest pass added composers
to eight Pipeline pages: Definitions, Runbooks, Queues, Artifacts, Approvals,
Agents, Bots and Commands. The latter three share `SourcesPage.tsx`.

- `portal/src/pages/pipelines/pipelineCollectionCommands.ts` defines explicit
  search/filter/reset/refresh grammar and exact record resolution.
- Commands synchronize controlled toolbar state. Definitions and Artifacts kind
  filters make real server requests. Artifact search covers the latest 500
  returned records; the composer help states this limit.
- Sources and Approvals can open a unique exact visible title or exact ID.
  They reject ambiguous/filtered-out records. Opening an approval only reveals
  its existing drawer; approve/reject remain explicit permission-checked actions.
- Unsupported requests are rejected. These inputs are bounded commands, not
  arbitrary language-model agents. Do not claim broader language understanding.

## Audit skill and important entry points

Canonical skill:
`/Users/connorhoehn/Projects/ui-components/skills/ui-dom-audit/SKILL.md`.
`~/.codex/skills/ui-dom-audit` is a symlink to that directory. Claude can read and
run this skill directly; no Codex runtime integration is needed.

Frontend binding: `portal/e2e/ui-dom-audit.adapter.ts`.
Route selection/readiness: `portal/e2e/ui-dom-audit.routes.ts`.
Reviewed Pipeline policy: `portal/e2e/ui-dom-audit.policies.ts`.

The runner measures repeated settled DOM geometry, type profiles, columns,
tables and composer boundaries. Required composers need a visible input, not
just a decorative wrapper. `--strict-coverage` fails unclassified policies.
Explicit malformed policies and placeholder exemption reasons fail even in
advisory mode. Exemptions do not suppress style/geometry checks.

Exact absolute paths preserve supplied query values. Only documented route
aliases are accepted; `/pipelines` opens Runs. Readiness checks run after lazy
page loading, including a positive Configuration control. Spinner absence alone
was not sufficient and caused one unstable measurement in the expanded sweep.

Pipeline exceptions require positive view evidence: the spatial work graph,
communication directory without a conversation target, configuration form, and
unimplemented settings screen. Missing report coverage requires both API 404 and
the visible load-error state. A loaded report should require its existing
composer; no saved report was available to exercise that editor.

The report comparison deliberately retains unverified prior cases. A narrow
rerun does not certify omitted routes, and old unstable samples are not silently
counted as resolved visual findings.

## Verification and evidence

Local `.scratch` reports and `/tmp` logs are not committed and may be absent on
another machine. Do not publish raw runtime evidence or credentials.

- Prior representative four-tenant matrix: 96 cases, zero findings and zero
  unclassified policies (`.scratch/ui-dom-audit-improved/`).
- Latest Pipeline resting-state matrix: 68 cases, zero findings and zero
  unclassified policies (`.scratch/ui-dom-audit-pipelines-composers/`).
- Expanded Pipeline matrix: 188 cases; 187 passed and Configuration had one
  readiness/stability failure (`.scratch/ui-dom-audit-pipelines-composers-states/`).
  After fixing readiness, all 8 Configuration cases passed in
  `.scratch/ui-dom-audit-pipelines-config-ready/`. The entire 188-case matrix was
  not rerun afterward. Do not describe its original report as all green.
- Final exact-query check: 4 cases passed in
  `.scratch/ui-dom-audit-pipelines-query-ready/`.
- Latest focused unit suite: 36 passed; portal TypeScript passed.
- Pipeline browser acceptance: 3 passed across two specs, with real reads and
  no Pipeline mutations. The approval-opening case intercepts a GET fixture;
  it neither creates nor decides a server-side approval.
- Skill self-test passed: 33 geometry/style mutations plus policy, CLI-exit and
  report-comparison regressions, including 15 malformed/placeholder policy
  fixtures. Skill validator passed.

Useful commands, from aws-agentcore unless noted:

```sh
npm --prefix portal run typecheck
node --test portal/src/pages/pipelines/__tests__/pipeline*Commands.test.ts portal/e2e/ui-dom-audit.policies.test.ts portal/e2e/ui-dom-audit.routes.test.ts
cd portal
npx playwright test e2e/pipeline-collection-commands.spec.ts e2e/pipeline-registry-commands.spec.ts --workers=1 --reporter=line
cd ..
npm --prefix portal run audit:ui -- --tenant pipelines --all --strict-coverage --themes light,dark --widths 1440,900 --out .scratch/ui-dom-audit-next
node ../ui-components/skills/ui-dom-audit/scripts/self-test.mjs --project portal
```

Live tests use `portal/e2e/realSession.ts`. Tenant/role switches revoke other
cookies for the same user through session epochs. Never run separate audit or
browser processes authenticating the same fixture identity concurrently.

The portal and middleware are native Tilt resources, not Docker frontend images.
Use `tilt trigger portal` after changing the consumed UI bundle and verify actual
browser styles/exports. A package version alone does not prove Vite serves the
new dist. Keep sibling builds/pack/install under one owner; do not edit node_modules.

## Continuation log

- **2026-10-12 (Claude Code).** The full Pipeline matrix was rerun after the
  Configuration readiness fix: 188 cases, 0 findings, 0 unclassified policies,
  strict coverage, exit 0, measured on commit `e52d888d` with a clean tree
  (`.scratch/ui-dom-audit-pipelines-full-20261012/`, local only). Item 4 below
  is therefore closed; the original 187/188 report is preserved. `CLAUDE.md`
  in this repo and in ui-components, platform-api and live-video-streaming was
  trimmed to current guidance; the dated checkpoint prose moved to
  `docs/history/claude-md-checkpoints-2026-10.md`. Pre-existing reds not
  touched by this pass: the pipelines/social/communication validators fail on
  re-staled journey logs (rendered contracts last measured 2026-10-08),
  `validate-component-discipline.sh` (52 raw styled elements, 3 raw buttons
  in `portal/src`) and `validate-route-coverage.sh` (1 untested route).

- **2026-10-12/13 (Claude Code, continued).** The Codex lane was resumed as
  the user asked. Composer policy: `portal/e2e/ui-dom-audit.policies.ts`
  `tenantComposerPolicy` classifies every orgiq/assessment/social route from
  rendered evidence (list judge, collection toolbar, searchable table,
  visible composer, charts, canvas, settings surface, placeholder, lab,
  section landing, chat/document directory, observed 404, titled record),
  `required` winning before any exemption; `AUDIT_ROUTE_ALIASES` in
  `ui-dom-audit.routes.ts` are the only accepted redirects; per-tenant deck
  APIs feed the missing-deck case. Unclassified went 102 → 0 on the resting
  matrix. Composers: one grammar (`components/collections/collectionCommands.ts`)
  and `CollectionCommandHost` on ~47 orgiq/assessment collection pages
  (four lanes; every page's grammar + tests sit beside it; admin and
  observability pages mount the host embedded in their section with the
  `embedded` boundary marker; `StackedCatalogLayout` gained a `footer` slot for
  record-view composers). Library: ui-components **2.441.0 → 2.441.2**
  (TenantSwitcher, DeckReader/DeckPresentationDialog composites; rail
  `data-ui-text` markers; lab pills, WorkItemMetaBar, StatStrip clickable
  cards, ChoiceRow, Textarea default, SourceCard on the scale); the portal's
  copies are deleted, the e2e fixture imports the library reader. Drift:
  densitysize 224 → 0, raw elements/buttons 0, burn-down rows lowered.
  Judges green: route-coverage, nav-parity, component-discipline,
  honest-numbers, mock-floor (snapshots recaptured on a throwaway :3012 BFF;
  three fixture/server disagreements repaired). Acceptance audit (light+dark,
  1440+900, discovered states) runs per tenant/section because one Playwright
  test caps at 30 min: orgiq `/iq` 536 cases / 622 findings, orgiq `/admin`
  500 / 1,804, assessment 168 / 156, social 124 / 8 — the findings are now
  library-owned families (Breadcrumbs sm, link Button size, GroupedList action,
  MarkdownView buttons, SegmentedControl, lab chrome, StackedRail group count,
  FileUploadDrop dashed → named dropzone variant) queued for 2.441.3, plus the
  admin-lane fixes (12px cells, 63px quality rows at 900, admin composer
  insets, knowledge badge, crawl inputs) awaiting re-measurement. Known
  pre-existing: `e2e/deck-reader.spec.ts` "Stop Follow" hover flake and the
  "real Work member" case expecting a work-item blocked reason the mock
  presentation reply never contained; ui-components has 11 unit tests and two
  lints red on its clean HEAD. New goal: the `access` tenant
  (`docs/access-tenant-design.md`, `docs/access-tenant-goal.md`,
  `scripts/validate-access-tenant.sh`, 98 red checks = backlog).
- **2026-10-13 acceptance (Claude Code).** On ui-components **2.441.4** the
  acceptance matrix is green in every section: orgiq `/iq` 536 cases, orgiq
  `/admin` 500, assessment 168, social 124, pipelines 188 — 1,516 cases,
  **0 findings, 0 unclassified**, strict coverage, light + dark, 1440 + 900,
  discovered states (`.scratch/ui-dom-audit-final3-*-20261013/`, local only;
  run per section because one Playwright test caps at 30 min). The library
  chain 2.441.0 → 2.441.4 is committed and pushed in ui-components; the audit
  skill's contract gained two fixture-proven exclusions (marked drop target,
  xterm helper inside a marked terminal) and its self-test passes (38
  mutations). Portal: typecheck, 1,834 unit tests, component-discipline,
  route-coverage, nav-parity, honest-numbers and mock-floor all green. Still
  owed: the journey re-walks (contracts re-measured 2026-10-13; the logs
  themselves are stale), the two pre-existing deck-reader cases, the `access`
  tenant build, and the ui-components unit/lint reds that predate this work.

- **2026-10-13, layout cascade (Claude Code).** The journey measurement
  (`scripts/journeys/measure.sh`) exposed a Codex-era regression: under the
  shell's compact density every unsized `PageSection` rendered a 14px h2, so
  46 routes had no page h1. ui-components **2.441.5** makes the heading level
  come from `size` only (density tightens spacing); the subsection
  `size="sm"` props the density pass had removed are restored and the
  `densitysize` ratchet no longer counts PageSection. Also fixed: one trail
  per column under section layouts (`SectionTrailContext`), Search/Invoke on
  the shell trail (`ShellTrail`), the deck editor h1 inset, the distillation
  record insets, the document rail's 220px default, every `!important` in
  `app.css`. Library gaps queued and requested as 2.441.6: the `SplitPane`
  divider owns 8px of layout (five assessment explorer routes measure the
  trail 32px from the content edge) and `EditorShell` lacks a 14px title.
  **Two decisions are the user's:** (1) `docs/layout-cascade.md` rule 8 says
  the section rail never folds, but the 2026-10-10 huddles work folds both
  rails while a discussion pane is open (`useDialogueRailFold`); four cascade
  tests and the initiative gutter follow whichever wins. (2) `/social/dms`
  deliberately hides Teams, Rooms and Channels (`social-navigation.spec.ts`
  "DM route stays DM-only", commit a58b424e), which contradicts rail-parity
  decision 6 ("one composition; the route only picks the pane").

- **2026-10-13 final state.** ui-components **2.441.7** (2.441.6 made the
  SplitPane divider own no layout width and gave EditorShell `titleSize="sm"`
  + `titleAs`; 2.441.7 put the loaded deck editor's chrome on the control
  scale once a saved deck existed in the shared mock). The audit contract's
  composer inset now resolves `--ui-content-gutter` on the measured element
  (self-test 41 mutations). Acceptance: orgiq `/iq` 536 and assessment 168
  cases green on 2.441.7; orgiq `/admin` 500, social 124, pipelines 188 green
  on 2.441.6 (2.441.7 touches only the deck editor those sections never load).
  Layout cascade: 12 of 16 cascade tests pass; the four that fail are the
  rail-collapse tests behind user decision (1); type-scale burn-down 590 under
  its 599 ceiling; rail-parity red only on `/social/dms` (decision 2). Portal
  typecheck + 1,834 unit tests green. Journey contracts re-measured; the
  journey logs themselves still need their walks.

- **2026-10-13, the `access` tenant (Claude Code).** Built A0 → A2 in one
  day on the goal/validator pattern: registration (21 points), additive
  `schema/access_schema.sql` + mock mirror, `/api/access/*` with live
  approver chains, SoD policies, provisioning through `setGrants`, expiry
  sweeper, bell items, one thread per request, review campaigns, manual
  revoke, configuration; nine portal pages on the house frame with the shared
  composer. 31 journey logs walked twice and sealed; DOM audit green on the
  tenant; gate record `docs/realtime-validation/2026-10-13/access-tenant.md`.
  The UX audit skill is now a Claude Code skill (`.claude/skills/ui-dom-audit`
  → ui-components); a 30-minute session loop re-runs the representative
  cross-tenant sweep. ui-components reached **2.441.8** (compact PageHeader
  keeps the 20/600 title; Escape returns focus to the Filters trigger).
  Owed: Aurora application (user), native PostgreSQL contracts, the two layout
  decisions above, the older tenants' journey re-walks.

## Suggested continuation

1. Continue from the user's next screenshot or requested tenant. Reproduce an
   exact route/state first; update a general rule and failing fixture if needed.
2. Extend explicit composer policies to unreviewed routes in other tenants;
   the representative matrix is not a full-app acceptance claim.
3. When a real saved Pipeline report is available, audit the loaded editor,
   composer and permission states separately from the missing-record case.
4. If a single all-green final artifact is needed, rerun the full Pipeline
   matrix above after the readiness fix. Preserve the original reports.
5. Recording/realtime/cloud follow-ups have separate historical evidence under
   `docs/demos/work-huddles/`. Re-establish current health before making claims;
   this UI pass did not revalidate media or production capacity.

## Continuation 2026-10-16 (evening)

Open, in order:
1. The user-search lane is pushing assessment (0.78) and access (0.83) to 1.00. Its edits sit uncommitted in portal/src/components/collections/*, portal/src/lib/tenantAnswer.ts, portal/src/pages/access/CatalogPage.tsx, middleware/src/lib/tenant-answers/* and portal/e2e/user-search-catalog.ts, waiting on a full probe. If they're still uncommitted, re-run the probe, ratchet scripts/user-search-floors.tsv and commit.
2. A peer session lands the meeting wiring after that commit: pins ui-components 2.478.0 and realtime-modules 0.134.0, plus BFF, portal and specs, with the UI behind VITE_MEETING_ROOMS (off).
3. Then run one consolidated pass:
   - Fix the mock-clone DM gap: /api/social/embedded returns persona-keyed DMs while source.userId is the clone, so member and org-leader clones read "This conversation is not yours".
   - Run scripts/journeys/measure.sh once.
   - Walk and seal all five Work roles, the communication-plane maps and the 17 user-search maps.
   - Regenerate docs/journeys/coverage.md.
   - Run every validator sequentially.
   - communication-shared-work.spec.ts still asserts "No Social channel bound", which PlaneGroupPane no longer draws (likely stale).
4. User decisions owed:
   - Program-owner read access to /admin/changes.
   - Renaming the real GitHub org in the seed.
   - Acceptance criteria on completed items.
5. Machines (Computer Lab) are ephemeral; walks never create or depend on one.

## Meeting rooms on calls (accepted 2026-10-17)

Current pins: ui-components **2.480.3**, realtime-modules **0.137.0**.
Initiative huddles carry raise hand, reactions, rooms, room chat and
announcements behind `VITE_MEETING_ROOMS` (default off).

E2 and X1 are recorded in `docs/realtime-validation/2026-10-16/meeting-breakout.md`;
X2 is fixed in live-video-streaming `11b2a6f`. E3 is complete: both 27-step
organizer/participant journeys passed and are sealed, and the strict UI audit
passed all 20 cases (including Rooms at both widths and themes), with zero
findings. `docs/realtime-validation/2026-10-17/meeting-ui.md` records the exact
checks, fixture boundary and separate branding-validator debt. The meeting
judge now requires current audit evidence and sealed walks.

Scope remains initiative huddles only, as decided by the user. Other call
surfaces and cloud deployment remain later work; nothing was deployed here.

## Final journey pass — 2026-10-17

The recovered session's Work walks finished with 116/123 passing before this
closeout. The remaining failures included stale test assumptions: navigation
accessible names put the unread-conversation/inbox marker before the count
badge, and the work-item composer can already be in Chat mode. The maps now
match that ordering and choose Chat through the named mode control.

All **five permission/refusal walks** and **three work-write walks** were
rerun successfully; their individual records are sealed. The Work catalog
now contains **123 passing records and two failing records**, including the
two meeting walks accepted separately. This is not a fresh full-matrix claim:
some older passing records still need a walk after their covering specs changed.

The Assessment and Pipelines `active-now` walks were repeated after the clone-DM
fix. Both pass: Enter opens the clone's own DM, presence arrives without reload,
the missing-person state is honest, and both browser contexts record zero
console errors. Their individual records are sealed; they do not certify the
older Communication records or give their whole directories fresh seals.

The current journey runner/proof suite passes **26/26 tests**, all **204 maps**
pass structural checks, and the generated coverage document is current.
All **17 user-search content walks** pass. The generic seal engine does not
register the `user-search` family and refused those seal attempts; these logs
are not presented as sealed. Their protocol and search judge currently assess
the passing answer/record-open fields separately from rendered-contract seals.

The full search probe completed all **17 role groups / 91 questions** and its
watched-source digest is current (`1e48f6ca2f7a86d4`). The content judge still
fails: Work, Assessment, Pipelines and Access meet their 1.00 pass-rate / zero
wrong-result thresholds, but **Social is 0.89 with five wrong results on the
designated best surface**. These are palette results for `s-missed-calls`
(“missed calls”, “call history”), `s-live-huddle` (“live calls now”), and
`s-room` (“Design crit room”, “rooms”). The saved probe records the unrelated
options returned. Thresholds were not lowered. Completion of the probe's
Playwright tests does not mean the content acceptance checks passed.

All 24 validators ran sequentially with `--quick` before the concurrent meeting
acceptance merge. Eight passed: agent-eval, component-discipline,
distillation-runbooks, honest-numbers, meeting-rooms-app, nav-parity,
rail-parity, and route-coverage. Logs are local at
`.scratch/wrap-up-2026-10-17/`; quick mode is not full acceptance.
The subsequent branding cleanup (`a7a71991`) is merged; its quick validator
now passes on the current tree, as does the meeting-specific validator.

Outstanding findings are preserved, not waived:

- Member `frames`: the narrow read-only composer leaves **More formatting**
  enabled (`RichChatComposer`, ui-components).
- Member `prepare-job`: the read-only composer audit flags the prompt deck's
  **Show/Hide** controls. Its intended disclosure semantics need to be encoded
  in the shared owner; the failed walk remains visible.
- Older Work, Communication, Assessment, Access, Social, Pipelines and Search
  records need their stale contracts re-walked. The directory seal
  guard refused older Work records whose covering specs changed after their
  walks. Only freshly re-walked passing records were sealed individually;
  current spec results cannot seal old journey records.
- Social search's five wrong palette results above remain open. Demo-content
  probe evidence is still stale. The mock floor's
  typecheck and fixture tests pass, but `wire.json` and `writes.json` need
  recapture against the current handlers on an isolated mock server.
- Other validator debt includes Git-sha pin assumptions despite tarball
  dependencies, Assessment document composition checks, the retired-tenant
  scan, Social's entity description/old logs,
  upstream C1/C3 ownership, and the general Work judge's call-room map depth
  assertions (the meeting-specific judge passes). Check the named validator's output before
  treating a static failure as a runtime defect.

The concurrent meeting acceptance merge updated the app to ui-components
2.480.3 and refreshed rendered contracts with unchanged categorical values;
its own acceptance record above is separate evidence. Cloud deployment,
Aurora changes, production capacity and previously recorded user decisions
remain outside this local closeout.

## Follow-up — 2026-10-18

The goal remains the outstanding local work in the October 17 final journey
pass. It is not yet complete. Current UI pin: **2.480.4**; realtime remains
**0.137.0**. The shared UI repair is pushed upstream in `645aaa37`, with the
packed release built in `6b94314b`.

- Both member failures now pass their actual browser walks on the installed
  package: `frames` (28 steps, both widths/themes) and `prepare-job` (14 steps).
  RichChatComposer disables the narrow formatting overflow with the editor.
  ComposerPromptDeck marks only its local disclosure/navigation controls as
  read-only-safe; prompt answers remain gated. Their seals await current
  rendered-contract measurement.
- Shared UI verification: **1,018 test files / 11,208 tests passed**, two tests
  skipped; lint, build, packed-export tests, skill validation and the audit
  mutation suite passed. The audit still rejects enabled formatting next to
  an allowed prompt disclosure. Portal typecheck passed.
- The mock wire/write snapshots were recaptured against a disposable offline
  server on `3012`; the mock-floor quick validator now passes. Assessment deck,
  Assessment document-parity and retired-tenant quick validators also pass.
  Their stale checks now follow the same immutable tarball, parameterized
  document title and call-host props, and ignore only a reference to the
  retired-tenant validator's own script path.
- Both meeting maps now assert all UI-changing steps and exercise Rooms with
  Enter. **All 125 Work maps meet the depth rules**, all 204 maps validate,
  the 26 runner/proof tests pass, and generated coverage is current. The
  revised meeting maps still need their browser reruns and current E3 audit.
- User-search is registered with the normal seal engine, and its full validator
  now requires current rendered-contract seals as well as answer/record-open
  passes. The 17 runnable maps must be re-walked and sealed; eight held maps
  remain explicitly pending.
- The October 17 Social search results used the live platform provider while
  the catalog expected seeded mock rooms/calls. The probe now refuses that
  mismatch and supports `USER_SEARCH_BASE_URL`; this refusal was verified
  against the shared stack. The full probe is being rerun on an isolated mock
  stack. An initial isolated run was interrupted after Vite could not resolve
  a peer import from a cache outside `portal/node_modules`; the corrected
  portal loads with zero page errors. Do not treat the intermediate results
  as acceptance. Live platform room/call indexing remains a separate gap;
  a green fixture probe cannot prove it works.

Local logs: `.scratch/handoff-followup-2026-10-18/`. Current rendered-contract
measurement and the full seeded search probe are in progress. After they
finish, seal the freshly walked records, refresh the meeting audit, re-walk
the stale tenant records, and rerun the validators sequentially. Remaining
work also includes demo-content probe freshness, older Assessment static
composition checks if still failing on a fresh run, and C1/C3 extraction of
Redis/node ownership to the upstream libraries. The original cloud and user
decision exclusions still apply.

## Closeout — 2026-10-18

The user asked to wrap up. This closes the current pass; the broader
outstanding-work goal is **not complete**. Application fixes are pushed in
`0565826f`; the search-probe run-lock repair is pushed in `d7dd5f7f`.
UI **2.480.4** and realtime **0.137.0** remain the installed pins.

Completed evidence:

- Rendered contracts were remeasured on source `bcde1c0398b7`: rail checks
  passed on 19 routes, layout cascade passed on all 143 inventoried routes,
  and typography passed on the same 143 routes with no new offenders beyond
  the existing burn-down. Contract values were unchanged; measurement
  metadata is current. The optional realtime-examples comparison on `15174`
  was skipped because that app was not running.
- The repaired member `frames` and `prepare-job` walks both pass and their
  rendered-contract seals are fresh. No older directory was blanket-sealed.
- All **17 runnable user-search journeys pass and are individually sealed**;
  eight held maps remain held. The first sweep passed 16/17, with an Assessment
  failed-runs walk reporting a missing command result and
  `ERR_NETWORK_IO_SUSPENDED`. That unchanged map passed a fresh retry with
  zero console errors. Its original failure remains in the local sweep log.
- The full user-search validator confirms the 17 seals, memory and DynamoDB-wire
  search-index suites, 40 hooked writers with zero failures, and clone parity
  for 24 “mine” phrasings. Overall search acceptance still fails as below.
- The probe run-lock now serializes worker claims and publishes the runner PID
  atomically. Five results/lock regression tests pass, including eight real
  concurrent workers, refusal of a second live runner, stale-owner recovery,
  and the empty-file regression. The affected Work probe groups were not
  successfully rerun during this closeout.

The isolated full search probe **did not complete successfully**: nine role
groups passed, four failed and four did not run. Work's member group hit the
old startup lock race (`pid 0`), skipping the other four Work groups; Social
participant/moderator and Access requester hit browser timeouts. The process
finished with exit 1 before the attempted interrupt. Its incomplete capture
is preserved locally as
`.scratch/handoff-followup-2026-10-18/user-search-probe-incomplete.json`.
`docs/user-search-probe-results.json` retains the last complete committed
capture; incomplete results were not promoted to acceptance. The full judge
therefore still reports three failures: Social's mock-provider proof is
unrecorded, its pass rate is **0.89** against **1.00**, and it has **five wrong
results on the best surface** against a maximum of zero. Rerun on an isolated
mock-backed portal with the repaired lock. Live-platform room/call indexing
remains a separate, unverified gap.

After the current contract measurements, **12 of 23 quick validators passed**.
User-search was then run in full mode and failed only the three checks above.
Logs for this final sweep are under
`.scratch/handoff-followup-2026-10-18/closeout-current/`; quick-mode passes are
not full acceptance. Remaining findings include:

- Stale journey records: Work 38/125, legacy OrgIQ 34/113, Communication 21/24,
  Assessment 60/61, Access 34/34, Pipelines 55/56, Social 48/48, and Search
  workspace 10/10. The fresh user-search family is separate from Search workspace.
- Meeting E3 needs the current strict Rooms audit and reruns of the revised
  organizer/participant maps. Demo-content's probe remains stale.
- Assessment still has Feedback/scorecard composition-check failures. Access
  checks still expect a local `GRANT_ROLE_SQL` declaration and an old
  delete-and-reinsert test; the implementation now re-exports the SQL and tests
  transaction-based grant edits. Its PostgreSQL proof also needs refreshing.
- Search-workspace checks still expect `RecordResultList` directly in
  `SearchPage.tsx` and a Git-SHA dependency instead of the tracked tarball.
  Social's validator still reports the old tenant-description condition and
  four incomplete recording journeys, plus the Assessment dependency failures.
  Inspect these checks against current code before treating each as a product bug.
- Upstream refinement C1/C3 still requires replacing `redis-lite.ts`,
  `gateway-redis.ts`, and `realtime-node-ownership.ts` with the installed
  library's bounded Redis and lease-group APIs. No part of that replacement
  was implemented here; its empty temporary worktree and branch were removed.

All validation processes from this pass have finished. The owned isolated
middleware (`3012`) and portal (`5184`) were stopped. The shared Tilt stack
was left running; portal `5183` and middleware `3001` both returned HTTP 200.
The pre-existing ui-components `package-lock.json` edit was preserved.
Cloud deployment, Aurora changes, production capacity and the previously
recorded user decisions remain outside this closeout.

## Redis checkpoint and pause — 2026-10-18

The user again asked to wrap up. Work is paused; the broader goal is **not
complete**. The Redis follow-up is saved separately from main on branch
`fix/handoff-redis-20261018`, in worktree
`/tmp/aws-agentcore-redis-20261018`, based on `cbd6d08a`. Main retains the
previously committed application state; the migration has not been merged.

- `d2ee71b2` replaces `redis-lite.ts`, `gateway-redis.ts`, and the application
  ownership polling loop with the installed realtime-modules bounded Redis
  transport and `LeaseGroup`. A small `redis-store.ts` adapter preserves the
  application store shapes. Startup awaits Redis readiness even for local
  routing; fleet operations preserve conservative peer detection and close
  their transport on stop. Dependency pins are unchanged.
- `4b9d820b` updates two stale assertions: Pipelines has an intentional seeded
  rehearsal, and persona clones address their DMs under their own identity.
  Both changed test suites pass.

Verification is partial, not acceptance:

- Middleware TypeScript checking and `git diff --check` passed.
- Eight focused suites passed **69 tests**, including real disposable Redis
  coverage of fleet locks/cleanup, gateway fanout, lease-group retirement on
  connection loss, bounded stalled commands, notification persistence, and
  call-chat/page stores, plus the two fixture corrections.
- That focused command exited 1 because it also selected the durable-chat
  Redis/DynamoDB suite with only its Redis endpoint configured. Its explicit
  setup guard rejected the incomplete configuration. With both integration
  endpoints unset, the durable-chat and call-feature-cluster suites correctly
  skipped all **eight tests**. Their real DynamoDB integration is unverified.
- The full middleware run was interrupted at the wrap-up request (exit 130),
  after **149 passing suites and five failing suites** had reported. The
  Pipelines and Social failures are corrected and rerun above. Remaining
  failures are `session-brief-contract.test.ts` (old skill-library hash),
  `realtime-gateway-tenants.test.ts` (platform team-membership setup), and
  `access-provision.test.ts` (Rhea is already in the seeded initiative SME
  list). Their fixes and the rest of the full sweep remain unfinished.

Logs are local under `.scratch/redis-migration-2026-10-18/` in the main
worktree: `full-tests.log`, `closeout-targeted.log`,
`closeout-unconfigured-integration.log`, and `typecheck-final.log`.

Before merging the branch: resolve the remaining suite failures, review any
session-brief contract regeneration, run the missing integration checks,
smoke-test application startup, recapture the mock wire snapshots against
the changed handler source, and run the mock-floor/upstream-refinement judges.
C1/C3 is implemented on the branch but is **not accepted**. The journey,
search, meeting, demo-content, and validator debt listed in the preceding
closeout remains open; no stale records were sealed during this follow-up.

All owned validation processes have stopped, including disposable Redis on
port `6384`. The shared Tilt stack remains running: portal `5183` and
middleware `3001/health` both returned HTTP 200. The pre-existing
ui-components `package-lock.json` edit was preserved.

## Redis acceptance resumed — 2026-10-18

The user resumed work with the Redis checkpoint above as the active goal.
The migration is still on `fix/handoff-redis-20261018` and has not been merged
into main. The pre-merge requirements above remain in force.

- `182f5612` fixes the remaining three known suite failures. The platform
  membership test explicitly selects its platform backend; the Access
  insertion test establishes an absent membership before provisioning and
  verifies reset restores the real seed. The session-brief contract was
  regenerated and reviewed: only the library pointer and derived hashes
  changed, following the earlier canonical-package rename. All three suites
  pass: **36 tests**.
- The durable-chat and call-feature-cluster integration suites now ran
  against real isolated stores and pass **8/8 tests**. The dedicated
  DynamoDB Local container is `orgiq-redis-migration-dynamodb-20261018`
  (host port `18064`), and Redis is on `6384`, logical database `13`.
  Existing shared containers were not restarted or changed.
- `1e9efc24` corrects stale acceptance checks for the current Social tenant
  description, shared grant SQL and transaction test, Search's result-list
  adapter and tracked tarball, and Feedback's URL-addressed record layout.
  The latter follows the existing collection-record amendment in
  `docs/layout-cascade.md`; the Assessment UX doc now reflects that amendment.
  Journey freshness checks and the scorecard confidence requirement remain.
  The grant-proof freshness check also follows the shared SQL owner now.
- The upstream-refinement **quick** judge passes every static check. Its
  dependency scan now follows a worktree's top-level `node_modules` symlink
  while still requiring exactly one installed distributed-core.

At this checkpoint the full middleware suite was running alone with isolated
Redis/DynamoDB endpoints enabled. It was subsequently stopped as recorded below.
No complete-suite result, refreshed wire snapshot, startup smoke result, or
full-validator pass is claimed yet. The follow-up logs are under
`.scratch/redis-acceptance-2026-10-18/` in the main worktree:
`failures-recheck.log`, `brief-update.log`, `durable-integration.log`,
`full-tests.log`, and `upstream-quick.log`.

After the full run: resolve any further failures; run the application startup
smoke and wire capture; run the mock-floor and full upstream judges; refresh
the outstanding PostgreSQL proof and evaluate the corrected tenant checks;
then merge only with the resulting evidence recorded. Stop the owned Redis
and DynamoDB acceptance services when their checks are complete. The older
journey, search, meeting and demo-content debt remains open.

## Redis acceptance stopping point — 2026-10-18

The user asked to find a stopping point. Work is **paused, not complete**.
The Redis migration remains unmerged on `fix/handoff-redis-20261018`, in
`/tmp/aws-agentcore-redis-20261018`. Main receives only this handoff update;
its application code remains at the previously accepted state.

- The full middleware run was interrupted with SIGINT (exit **130**) after
  **465 passing suites and two failing suites** reported. This is not a
  complete-suite pass. Both reported failures were then corrected and rerun
  together: **2 suites, 10 tests passed** in 6.5 seconds.
- `migrate-work-comments-dynamo.test.ts` initially could not resolve the
  infra schema package from the worktree. Linking the worktree's
  `infra/node_modules` to the existing main install fixed that environment
  issue. The rerun explicitly enabled `PAGE_THREAD_TEST_DYNAMODB_ENDPOINT`
  against the dedicated DynamoDB Local container; its two native tests passed.
  The worktree also links its middleware and portal dependencies to main.
- `9999d749` updates the document-comment import assertions for the existing
  third seeded comment, including its nested parent edge. The seed and product
  behavior are unchanged; all eight tests in that suite passed.
- `a8bd113a` preserves per-repository test/typecheck output in the full
  upstream validator through `UPSTREAM_LOG_DIR` (or a temporary directory),
  with failure tails printed. Shell syntax and whitespace checks pass; the
  modified full validator has not yet been exercised.

Evidence remains in `.scratch/redis-acceptance-2026-10-18/` in the main
worktree, including `full-tests.log` and `stopping-point-recheck.log`. The
prepared `startup-smoke.mjs` is syntax-checked only and **has not run**.
No startup smoke, refreshed wire snapshot, mock-floor result, PostgreSQL
proof, full upstream-validator pass, or corrected tenant-validator pass is
claimed. The earlier 36-test failure recheck, 8-test durable integration
pass, and upstream quick-judge pass remain valid evidence for their scopes.

Resume with a complete middleware run, alone, against fresh isolated Redis
and DynamoDB stores. Preserve all integration endpoint settings from the test
setup and include `PAGE_THREAD_TEST_DYNAMODB_ENDPOINT` for the migration
suite. Then complete startup smoke, wire capture, mock-floor, full upstream
validation, PostgreSQL proof, and the corrected tenant checks before deciding
whether to merge. The broader journey, search, meeting, demo-content, and
scorecard confidence debt remains open; no stale journey records were sealed.

All owned validation processes have stopped. Disposable Redis on `6384`
was shut down, and the dedicated containers
`orgiq-redis-migration-dynamodb-20261018` and
`orgiq-access-postgres-redis-20261018` were removed. The latter had reached
readiness but had not run any proof. Shared services were left running:
portal `5183` and middleware `3001/health` both returned HTTP **200** after
cleanup. The pre-existing ui-components `package-lock.json` edit was preserved.

## Redis acceptance — 2026-10-19

Two Claude Code sessions worked `fix/handoff-redis-20261018` in the same
worktree (`/private/tmp/aws-agentcore-redis-20261018`) this evening and
split the pre-merge list between them. Evidence is under
`.scratch/redis-acceptance-2026-10-19/` in the main checkout (the second
session's logs under `opus/`). Isolated stores: disposable Redis on `6384`
(password-protected, tests on logical db 13, the smoke on 14), DynamoDB
Local container `orgiq-redis-migration-dynamodb-20261019` on `127.0.0.1:18064`
with the five `orgiq-chat-` tables, and the 2026-10-14 PostgreSQL proof
container `orgiq-access-postgres-acceptance` (colima had to be restarted; its
host socket was dead).

- **Full middleware suite** (`full-tests.log`, run alone 18:49–18:56 with the
  Redis/Dynamo opt-ins and `PAGE_THREAD_TEST_DYNAMODB_ENDPOINT`): **545 suites
  passed, 1 failed, 4 skipped; 7,482 tests passed.** The failure is
  `envelope-read.test.ts` hitting its 5 s timeout under load; it passes 7/7
  alone (`envelope-read-recheck.log`). Every Redis and DynamoDB integration
  suite ran for real and passed. A second full run (`full-tests-c9.log`)
  overlapped the first and carried two env vars — `RUNBOOK_DYNAMODB_ENDPOINT`
  and `SEARCH_INDEX_DYNAMODB_ENDPOINT` — that are not test-only opt-ins: the
  app's own store selection reads them, so six suites read an empty DynamoDB
  instead of the seeded rows. Those eight suites were rerun alone with the
  corrected `env.sh`: **8/8 suites, 231 tests passed** in 12 s
  (`rerun-8-suites-c9.log`).
- **Startup smoke** (`startup-smoke.mjs`, `startup-smoke.json`): the BFF on
  `3012` with `REALTIME_GATEWAY_ROUTER=redis` reports `realtime.store: redis`,
  `ready: true`, every mock on; killing its Redis clients turns `/health` to
  **503 / ready: false** in 4 ms and it stays fenced while Redis itself still
  answers; SIGTERM exits 0.
- **Wire snapshots recaptured** against a throwaway server on `3013`
  (`wire-capture.log`): 309/415 GET routes and 120/364 write routes captured,
  `serverHandlerSha` now matches the branch's handler sources (`9cade41b…`).
  The GET snapshot is unchanged apart from one clock-ordered id list. Two
  write routes, `PUT`/`DELETE /api/graph/work-items/:id/decisions/:decisionId`,
  moved from a captured 200/404 to a reasoned `skipped`: the sweep resolves the
  work item to `wi-rta-e1-s1` (`p-realtime-analytics`), whose initiative has
  no seeded decision — the same on the shared main server, so not a branch
  change; the harness's own `bodyFrom` note anticipates it.
- **Mock-floor judge** `--quick`: **ALL CHECKS PASS** on the branch with the
  recaptured snapshots (`mock-floor-quick-c9.log`). The full-mode jest run is
  the suite result above.
- **PostgreSQL proofs** (dedicated containers, nothing on Aurora): access
  contracts **11/11 alone** on the branch
  (`docs/realtime-validation/2026-10-19/access-postgres.md`);
  work-documents **6/6**; page-thread **7/7** after the second session
  corrected the suite's schema list to follow `load_schema.py`'s order up to
  `work_item_estimate_schema.sql` (`bd96c532`). An 18:58 run of the
  access suite from both sessions at once against one container and one schema
  name failed on duplicate keys; it is a collision, not a regression — alone it
  passes.
- **Upstream-refinement judge, full mode** (`opus/upstream-full.log`,
  per-repo logs in `opus/upstream-full-repos/`): **89 checks pass, 6 fail**,
  none caused by this branch. Every static C1/C3 check, middleware typecheck
  and the consumer authority-facade contract are green. The six: message-queue
  consumer-groups is a `socket hang up` flake (alone: fail, pass, pass);
  platform-api `recordingAttendance.test.ts` fails 3/18 on that repo's clean
  HEAD `db7b55f` (call binding `unresolved`, session null after end) — a real
  break owned by platform-api, reported, not fixed here; live-video-streaming
  `test/redis-pubsub-duplicate.test.js` hangs for good when nothing listens on
  `localhost:6379` (`mesh.connect()` never returns, so its skip path never
  runs) — a test bug owned by that repo; the whole LV suite passes (exit 0)
  against the isolated Redis (`REDIS_URL=…6384 TEST_REDIS_DB=13 npm test`,
  `opus/rerun-lv-tests.log`); its "typecheck" was a judge defect (plain-JS repo, `npx tsc`
  hit the stub package) and the judge now skips typecheck for a repo with
  neither a script nor a tsconfig (`bd96c532`, together with the page-thread
  schema-list fix);
  communication-plane and social quick judges are the stale-journey debt
  (21/24 and 48/48 logs, four incomplete Social recordings). Nothing was
  sealed.
- **Corrected tenant validators** (quick mode, second session): the checks
  corrected in `1e9efc24` pass (Social description, Access grant SQL and
  transaction test, Search `RecordResultList` adapter and tracked tarball).
  Remaining reds are the debt already listed: stale journey logs, four
  incomplete Social recording logs, Assessment slice 4 (scorecard confidence).

Two things learned the hard way, for the next pair of sessions: name log
files per session (we both wrote `full-tests.log` and one run's output
replaced the other's), and never run `access-postgres.test.ts` from two
places — it owns its container's schema name.

With the pre-merge list closed — suite, integration stores, startup smoke,
wire capture, mock-floor judge, PostgreSQL proofs, full upstream judge,
corrected tenant checks — C1/C3 is **accepted** and the branch is merged into
`main`. Still open and unchanged by this work: the journey, search, meeting,
demo-content and scorecard-confidence debt; the platform-api
`recordingAttendance` break and the live-video-streaming hanging test
(both in their own repos); cloud deployment, Aurora schema application,
capacity, and the user decisions listed at the top of this file.

## User search — 2026-10-21

The full user-search probe ran to completion on an isolated `dev:mock` stack
(middleware `3014` with `SOCIAL_PLATFORM_BACKEND=mock`, portal `5194`): all
**17 role groups passed**, and every tenant meets its floor, **100% of intents
with zero wrong answers on the best surface** (orgiq 23/23, assessment 18/18,
social 18/18, pipelines 16/16, access 16/16). Social's provider proof is now
recorded as `mock` for all three personas. Logs:
`.scratch/user-search-2026-10-21/` (`full-probe-2-c9.log`,
`validate-user-search-full-c9.log`).

Social's earlier 0.89 and five wrong results came from two probe defects and
one product gap:

- The probe signed in after loading `/` and then navigated in-page, so the app
  kept the pre-login session. On Social the palette offered orgiq pages and
  queried `/api/search` (403). The probe now reloads once after sign-in.
- The probe never pressed the chat rail's "Find a chat" button, which hides the
  field since ui-components 2.432.0, and graded every rail phrasing as a missing
  box.
- The rail's find field matched conversation names only, so message text was
  searchable only through the palette. It now also lists message and pin hits
  from `/api/social/search` in a "Messages" rail section while two or more
  characters are typed (Social tenant only; the embedded Communication plane
  has no search route). At rest the page is unchanged.
- The search index now also posts long "-tion" words under their root and the
  scorer accepts a term's plural-stripped stem, so "why were transcripts
  delayed" finds the root-cause message about "the transcription queue". A
  persisted DynamoDB-wire index needs a rebuild to gain the new postings.

The full validator's only remaining failure is that rendered contracts must be
remeasured on the current source (`scripts/journeys/measure.sh`). Live-platform
room/call indexing remains a separate, unverified gap.


## Hangouts and chassis checkpoint — 2026-10-25

The current work is product/backend readiness in the existing AgentCore app.
The earlier standalone concept was withdrawn. The user approved saved hangout
layouts plus temporary breakouts, shared-library UI designs, and the three
chassis refactors across owners and realtime-modules. ESM is the agreed target,
but TD-ESM-01 is deferred and opportunistic; do not start a package-wide migration.

### Released owners and app composition

- ui-components `f23d75cf`, version **2.481.2**: dedicated call stage and compact
  controls, contextual pane fit, shared hangout creation controls, contrast and
  reusable audit contracts. Original main and the hangout worktree match the
  pushed source. The original ui-components lockfile remains the user's prior
  dirty file, preserved byte for byte; do not discard it.
- realtime-modules `209c91c`, version **0.138.0**: camera-off entry on rejoin and
  bounded retry for the known simultaneous breakout-return lobby claim conflict.
  Portal and middleware consume the tracked tarball; portal consumes the UI
  tarball. Lockfile integrity was checked against each packed artifact.
- platform-api `83fdaca`: saved-layout validation and conditional updates,
  parent/breakout metadata, recording configuration, bounded exact-session
  activity and current recording-summary authorization. Preceding `a029309`
  isolates unit AWS clients and improves test compilation; `03b10ad` repairs
  canonical IPv4-mapped private image URL rejection discovered by the full sweep.
- message-queue `3c36020`: local durability characterization harness and its
  documentation only. This is evidence of defects, not a durability repair.

The app uses Overview / Call / Conversation / Rooms / Activity tabs inside the
existing tenant shell. The Call tab owns the media stage; the far-right huddle
pane and duplicate media controls are suppressed while the page owns the call.
Rooms separates saved assignments from temporary live changes. The shared person
picker and tables replace ad hoc forms. Activity is rendered once and uses
actual attendance and authorized recording summaries. Empty directories do not
offer browse/search controls with nothing to browse. The UI owner contains the
reusable fixes; app files retain tenant authority and adapters.

See [product readiness](design/product-readiness/README.md), its 33 proposed
journeys, generated concepts and
[exact verification record](design/product-readiness/hangouts-verification.json).

### Verification and current local runtime

- ui-components: 1,019 test files / 11,214 tests passed, two skipped; lint and
  build passed, as did the reusable audit rule fixtures.
- realtime-modules: 91 conversation-call/meeting tests, lint and all 35 built
  export checks passed.
- platform-api: full suite **450 passed / four skipped suites; 6,304 passed /
  15 skipped tests**, no failures. Full typecheck, build, OpenAPI coverage and
  lint passed (356 existing warnings, zero errors). Unit tests now use dummy
  AWS credentials and a closed local default endpoint. The first interrupted
  run exposed unmocked AWS requests rejected for invalid credentials; it is not
  acceptance evidence. No cloud operation was used to validate this release.
- Browser: 14 targeted tests passed, including the actual two-person local
  media walk. Its optional audit measured 28 stable light/dark wide/narrow
  hangout states with zero findings. The separate directory deep audit passed
  all 27 cases with zero findings/unclassified composer policies.
- Portal build, middleware typecheck and 23 portal pure tests passed. BFF
  Social/embedded/meeting tests passed; final added activity/Communication
  authority cases cover caller-token forwarding, parent-room refusal, empty
  mock history and cross-tenant grants. The route coverage gate is recorded
  separately from journey freshness.
- The release image is `orgiq-platform-api:hangouts-release-20261025`, digest
  `sha256:b97f5de4e29793986f84a09cc386b5fabc4ce080b5bd9ec97832b4e086bdc83d`,
  built from platform-api `83fdaca` and activated locally with the prior
  container retained for rollback. Health passed. The actual two-person walk
  passed again after activation (one test; DOM audit disabled on that repeat).
  UI source/packages are unchanged from the measured 28-state audit.

Walks used isolated clones and archived only their owned hangouts. Design studio
and Product review remain. No shared mock reset was run. The older
`social-rooms.spec.ts` still resets the mock world and was not used for live
acceptance on the shared stack; the scoped `hangouts-real.spec.ts` supplies that
proof.

### Remaining acceptance and next work

**The broad Social/Communication/Assessment judges are not all green on this
source.** Their cascade/type-scale/rail measurements predate these changes.
The Social quick judge identifies 32 changed journey records; Assessment's
`stretch/realtime` record also needs a new walk. Do not reseal those records
without observation or repeat the October 24 all-green claim. The newly added
route coverage was completed separately; stale measurements/seals remain open.

Activity is bounded to 20 session pointers per page and follows seven-day
session retention, without historical backfill. The memory video-store profile
is not durable history. The native SFU walk does not establish AWS IVS,
process-restart durability, cloud deployment or capacity acceptance. All-tenant
journeys in the catalog are an acceptance backlog, not a completion percentage.

Continue [C0–C9](chassis/implementation-plan.md) and the
[chassis ledger](chassis-extensibility-goal.md). The first C0 harness confirmed:
restart can redeliver before visibility expiry; accepted delayed messages have
no durable body; independent clients can deliver the same message; and a refused
durable claim can still produce a delivery. Its normal send/ACK control passed;
the UUID-owned DynamoDB Local table was removed. The harness intentionally exits
2 while those defect flags are true. Separate-process, stale-ACK, FIFO/group,
catalog poison-handling and job-attempt cases remain; C1–C9 are not complete.
Prefer owner client contracts and capability checks before the delivery-store
rewrite, reusing existing distributed-core fencing. The room validator remains
mirrored until the independent C8 pure-contract extraction is adopted in both
APIs. No whole-package ESM conversion was made.


## Chassis foundation checkpoint — 2026-10-25

The user explicitly made the three chassis improvements the active Codex goal.
Continue the [implementation plan](chassis/implementation-plan.md) and
[execution ledger](chassis-extensibility-goal.md); this is not goal completion.

Released/pushed owners: event-catalog 0.8.8 (`0f979fa`, retain failed sources),
service-runtime v0.5.0 (`0776e24`, capability evaluation + lean signing), and
message-queue v0.3.0 (`dd97a69`, signed bounded client + shared types). MQ main
then advanced to `e8a336d` with unreleased host preflight and v2 delivery design.
The host refuses durable claims for legacy storage; C3–C5 must establish the
actual guarantees before those capability labels can be enabled.

The BFF now pins the released MQ client and runtime at full SHAs and re-exports
owner APIs through the old local import. Its memory fixture has renewal/receipt
rotation and explicit unsupported-group handling. The owner client passes its
full 1,522-test gate (42 environment-gated skips), real signed broker HTTP, and
packed Node 20/25 + browser type checks. BFF typecheck/build and 19 focused tests
pass. Its full run passed 7,495 tests with two stale route-record failures and
56 skips; the static route/refusal records were corrected, then all 79 wire
tests passed. No full repeat after that metadata correction and no write replay
or mock reset. Raw logs/results use `.scratch/chassis-*`; the ledger has detail.

The middleware watcher is serving 3001 again after the new Git dependency
finished installing; portal 5183 also returns 200. Existing backend/media images
were not replaced by this chassis checkpoint. The ui-components lock still
matches the original backup SHA recorded in the prior checkpoint.

Next: transactional delivery-store implementation in message-queue, using the
owner's `docs/delivery-state-v2.md` and UUID-owned local tables. Catalog client
adoption/lifecycle, job fencing, reusable room validation, realtime composition
and final host adoption remain open. The catalog source-retention fix is an
owner release; older application catalog pins have not yet been consolidated.
Do not revive the earlier all-green tenant-judge claim or convert packages to
ESM wholesale. ESM remains deferred/opportunistic (TD-ESM-01).

## Chassis usage-limit checkpoint — 2026-10-25

The user is approaching a usage limit. The approved three-improvement goal
remains active and incomplete. Message-queue main is pushed at
`c0d22e9422b546370f712e5233f8fb5ecb85dc9c`, adding a v2 transactional delivery
store. Fourteen real DynamoDB Local tests, build and changed-file lint pass.
Only a UUID-owned test table was created/deleted; the shared application was
not restarted or reset. No test process is intentionally left running.

This store is **not connected to QueueService/server** and is not a new tagged
release. Application pins remain at the previous client release. Durable runtime
profiles remain unavailable; FIFO, DLQ, subscriptions and process acceptance are
unfinished. Continue from the detailed resume instructions in
`docs/chassis-extensibility-goal.md` under “Usage-limit checkpoint: transactional
store foundation” and `docs/chassis/delivery-store-verification.json`.
Next: integrate through the existing QueueService/HTTP surface, preserve memory
behavior, then prove separate-process restart/claim/receipt semantics. Keep all
C0–C9 scope intact. The user's dirty ui-components lock remains untouched.


## Chassis C3 HTTP checkpoint — 2026-10-26

The three chassis improvements remain unfinished. MQ main is pushed at
`757d06fc0085f14ed0357104fe14274c44f19cbe`; service-runtime v0.5.1 is released
at `c01db0e6dfe0e6b91081ae92ee5cc3c1e77d2ad6` and adopted by MQ. The application
client pins remain unchanged. Standard transactional delivery now runs through
the existing signed HTTP API under explicit experimental `ddb-v2` selection.

Verification: 130 MQ suites / 1,537 tests pass (nine gated suites / 65 skipped);
14 real DDB store tests plus eight separate-process HTTP tests pass. All eight
HTTP tests also pass on Node 20.0.0. Shared shutdown has 360 passing tests and
packed Node 20/25 compatibility. See `docs/chassis-extensibility-goal.md` and
`docs/chassis/delivery-store-verification.json` for exact scope and limitations.

Next: C4 durable FIFO/dedup and atomic dead-letter transfer, following
`message-queue/docs/delivery-state-v2.md`. Durable runtime profiles stay disabled
until complete policy/subscription acceptance. C6–C9 and migration are still
open. No shared reset/restart or cloud deployment occurred in this checkpoint.
ESM remains deferred/opportunistic.


## Chassis C4 and repository push checkpoint — 2026-10-26

MQ main is pushed through `2f562c20c522b3d697e9604ce26a1a86e9490fd4` (unreleased).
C3/C4 transactional delivery now includes FIFO order, durable dedup and atomic
automatic DLQ transfer. Full suite: 130 suites / 1,537 tests pass (84 gated tests
skipped). Live DDB: 31 store + ten separate-process HTTP tests pass on Node
20.0.0/25.9.0, as do packed client import/require/browser types. Runtime v0.5.1
remains released/pushed and pinned by MQ; application client pins are unchanged.

All 11 related repos and every local branch were audited for unpushed commits.
There was no older unpublished branch work. The UI lockfile's only difference
was stale root version metadata; it now matches the committed release exactly,
and its original backup is preserved. The root documentation commit containing
this checkpoint is the final push in this audit; repeat status if resuming later.

Continue with the new C6 section in `docs/chassis/implementation-plan.md`, then
C7/C8, C5 and C9. The original three-improvement goal is not complete. Durable
profiles remain disabled until the remaining acceptance gates pass. No shared
data reset/restart, cloud deployment or broad ESM conversion occurred.


## Chassis C6 owner releases — 2026-10-26

MQ 0.4.0 (`b055b33`) and event-catalog 0.9.0 (`4e8910f`) are released/tagged
and pushed. The catalog uses the owner HTTP client, strict full queue policy,
FIFO routing/dedup, renewable delivery leases, serialized ACK and bounded drain.
Paused subscribers retain skipped work; custom queue names and string metrics
are honored. Explicit fallback schema mode prevents dependency hoisting from
changing accepted events.

All 152 catalog suites / 3,157 tests pass, including nine real DDB/child-broker
cases; 16 focused tests and packed consumers pass on Node 20.0.0 too. MQ's
130 suites / 1,541 tests pass (nine gated suites / 84 skipped). See
`docs/chassis/catalog-consumer-verification.json` for commands and scope.

C7/C8/C5/C9 remain. Dispatcher and bot-runner still use tokenless completion;
fix both callers and the underlying provider, not just dispatcher. Existing
`claim_token`/`heartbeat_at` and pull-side routes provide the reusable starting
point. Preserve schema fail-closed behavior, claim-token privacy and business
result fencing. No cloud migration, shared reset/restart or host pin change in C6.
