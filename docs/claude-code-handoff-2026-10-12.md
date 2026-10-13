# Claude Code handoff — October 12, 2026

Start in `/Users/connorhoehn/Projects/aws-agentcore`. This is the current
handoff for the tenant UI consistency and deterministic audit work. Older
checkpoint prose in `CLAUDE.md` is historical, including claims about unmerged
release branches, old dependency versions, and a blocked local environment.
Use current code and Git state when they differ.

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
