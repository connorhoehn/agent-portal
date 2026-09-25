# Initiatives — three page variants: build plan

**Targets:** `docs/design/initiative-overview-mockup.png`, `initiative-work-mockup.png`, `initiative-mine-empty-mockup.png`, with the checklist in `initiative-variants-spec.md`. Where the images and the spec disagree, the images win.
**Today:** worktree `aws-agentcore-wt-initiative`, branch `feat/initiative-variants` from `origin/main` `2472bfe8`. The four-pane Work redesign landed in `610acb75`, `4210a572`, `2b6b93b8`, `2ee7368f` and `77526b89`.
**How exports were checked:**
- The installed dist was checked at `aws-agentcore-wt-guide/portal/node_modules/@connorhoehnslalom/ui-components`. It is now **2.389.4** (sha `871c13a5`), not 2.389.0: the guide branch bumped it in `316700c4`. Each export was checked with `node import()` and `typeof`.
- The library source was checked at `origin/main`. When read that was `7ec7617f` (2.389.3); it has since moved to `d9a26df5` (**2.389.6**). Library line numbers below are from `origin/main` at read time.

**Present in the dist:**
- Root: `ExplorerLayout`, `ScopeHeader`, `WorkListView`, `WorkListToolbar`, `GroupedList`, `WorkspaceRail`, `Banner`, `StatStrip`, `KeyValue`, `Disclosure`, `EmptyState`, `ProgressBar`, `WorkItemMetaBar`, `OutcomeSection`, `ChecklistSection`, `LinkedItemsSection`, `CommentList`, `WorkActivityList`, `RunDraftPanel`, `ContextColumn`, `ViewportFillRegion`, `SegmentedControl`, `Tabs`, `SearchInput`, `Select`, `DropdownMenu`, `FilterPopover`, `WarningIcon`, `ArrowRightIcon`, `ChevronIcon`, `LinkIcon`, `Divider`, `PageHeader`, `SourceList`, `MetaLine`, `StatusPill`, `Chip`.
- `/shared`: `T`, `Stack`, `Inline`, `Button`, `PageSection`, `PageHeader`, `SectionLabel`, `Link`, `Modal`, and the shared set listed above.
- `/doc-editor`: `EditorShell`, `FloatingComposerDock`.
- `/social/rich-composer`: `RichChatComposer`, `ComposerReferences`.
- 2.389.6 adds `DropdownMenu triggerVariant="primary|secondary|link"` and `SearchInput size="lg"`.

**Absent:**
- `ExternalLinkIcon`. Use `PopOutIcon` or add the icon in L1.
- `Disclosure` from `/shared`. It is exported from the root only.

## 0. Decisions to take before building (the default is what this plan assumes)

| # | Question | Default |
|---|---|---|
| D1 | Most mockup copy differs from the seed. Examples: "Stop duplicate alerts during a dependency outage" vs `Alert dedup storm when a shared dependency degrades` (`middleware/src/mock/work-items.ts:220`, `schema/seed_program.sql:31`), and summary "Collect telemetry, reduce alert noise, and control retention costs." vs `providers/projects.ts:243`. | **Adopt the mockup copy in the seed generator.** This covers p-observability's summary plus the titles of the 6 open or in-review items. The generator emits an explicit `UPDATE … SET title=` so an existing database converges (the inserts are `ON CONFLICT DO NOTHING`). Tests that name the old titles change in the same slice. |
| D2 | Which slice picks "What needs attention" and "Plan next"? | **A portal pure model over the `/work` rows**, reusing `workListModel`'s `priority` sort. The mockup's Plan next order (StatsD, dashboard, cardinality) is exactly the Work list's "Next up" order (priority, then title) minus the attention item. `lib/work-suggestions.ts` ranks by bigger points first, which would give a different order from the list that "See all" opens. All copy (summary, blocked reason) comes from the rows. |
| D3 | "2 agents running" and "· 2 agents" come from a typed `activeAgents` (`providers/projects.ts:370`), which breaks mock-floor rule 1. The seed ships no running runs, so Aurora says Idle. | **Derive the number from `running` bot_runs rows.** Seed exactly **2** in-flight marketplace runs (bot `null`, `jobId: null`, `costUsd: null`, `startedAt: clock`), on `wi-obs-e1-s3` and `wi-obs-e1-b5`, which are both `in_progress`. Other initiatives read "Idle". `countMockRunningRuns` (`providers/bots.ts:455-462`) must count all mock runs, as Aurora does at `:1045`. The cap is 3 (`lib/bot-runner.ts:198-201`), so one more mock dispatch still fits. Aurora stays Idle: that is an honest, documented divergence. |
| D4 | What does `/iq/projects` show in the pane with nothing selected? | **Everyone:** "All initiatives", the existing program `StatStrip` plus `ProjectTable`. **Mine:** "My initiatives" plus the table, or the empty variant. The card grid (`projects/InitiativeCard.tsx`) is retired. |
| D5 | "Workflow ▾" and "/ commands": the portal has no workflow catalogue (grep: none). | Three **prompt workflows** from a portal model: "Prioritize next work", "Define acceptance criteria", "Unblock this item". Each builds its prompt from row data. The same list feeds `commands` so "/ commands" is honest. |
| D6 | What does the composer do? | **Agent** asks: it navigates to `/iq/invoke?prompt=`, the guide branch's `ExplainComposer` pattern, and is open to every role. **Chat** posts to Discussion on a work item and needs `DispatchAgentRun`; otherwise it is disabled with a reason. The run instruction moves out of the composer into Run setup: RunDraft, then EstimateDrawer `initialInstruction`. |
| D7 | Where does "Check profile" go? | **`/settings#profile`**, a new Profile section: "Signed in as … · connected to <person> / not connected". hr-admin also gets "Open Identity → Users" (`ManageUsers`). |
| D8 | What does "Add context" write? | **M4:** `PUT/DELETE /api/graph/work-items/:id/decisions/:decisionId`. If M4 slips, the fallback is: the action opens the Decisions tab. |
| D9 | The explorer column is 343px in the mockup. | `railWidth="lg"` (368px), which `WorkListView` is measured against. Accept the 25px difference. |
| D10 | The explorer's **Sprints** tab is not in any mockup. | P7, minimal: the pane shows `SprintsLens` unchanged and the rail lists sprints. No regressions. |

## 1. Element by element

"Exists" means a component already does it; "NEW" means a library addition (section 3, slice L); "portal" means a page-side change only.

### Shared frame (all three variants)

| # | Mockup | Today | Renders with |
|---|---|---|---|
| F1 | Org shell and org rail | unchanged (`components/shell/Layout.tsx`) | Exists. The page stays `data-shell-flush` (`app.css:494-501`). Do **not** touch `app.css` or `Layout.tsx` (that keeps branding journeys fresh). |
| F2 | Explorer column across all variants | List: `PageSection` wall (`ProjectsPage.tsx:157-335`). Detail: `ExplorerLayout` inside a ScopeHeader band (`ProjectDetailPage.tsx:477-490`). | Exists: `ExplorerLayout` with `railWidth="lg"`, `railHeading="prominent"`, `panePadding="none"`, `asidePlacement="beside"` and **no aside**. A portal frame `projects/InitiativesExplorer.tsx` is shared by both routes. The rail is re-mounted per route; `useFetch` with `share:true` avoids a double fetch. |
| F3 | "Initiatives 11" with a plain muted count, ⋯ and « | none | Exists: `railTitle`, `railCount`, `railActions` (a `DropdownMenu` ⋯ holding the old Sort and Status filters from `ProjectsPage.tsx:226-280`) and `onToggleRail` (persist to localStorage). **NEW** `railCountStyle="plain"`: the count is a Chip today (`WorkspaceRail.tsx:56`). |
| F4 | Tabs "Initiatives \| Sprints" | `SegmentedControl` lens (`ProjectsPage.tsx:162-170`) | Exists: `Tabs variant="underline"` in `railHeader`, bound to `?lens=`. |
| F5 | Segmented "Everyone \| Mine" | `SegmentedControl` in the toolbar (`:244-252`) | Exists: `SegmentedControl` in `railHeader`, keeping `?scope=` and its default by role (`:83-94`). |
| F6 | "Find an initiative…" | `SearchInput` (`:263-278`) | Exists: `SearchInput` at full width. The query stays in `?q=`. |
| F7 | Groups "In progress 9" (open) and "Planning 2" (collapsed) with a plain count | none | Exists: `GroupedList size="md" currentStyle="bar"`, with group `defaultOpen:false` for planning and completed. **NEW** `groupCountStyle="plain"`: the count is a Chip today (`GroupedList.tsx:642-645`). The grouping and counts come from rows (P0 `initiativeListModel`). |
| F8 | Rows: title plus "Nora DaSilva · 2 agents" or "· Idle" | card/table (`InitiativeCard.tsx`, `ProjectTable.tsx`) | Exists: a `GroupedListRow` with `subline`. The text comes from the `ownerName` and `activeAgentRuns` rows (D3). `null` shows the owner only, never "0 agents". |
| F9 | Selected row: fill plus left bar | n/a | Exists: `currentStyle="bar"`, with `currentId` set to the route id. |
| F10 | Footer "11 initiatives" | none | Exists: `railFooter` with `T`. The count is `rows.length`, or "N+" when `rows.length === limit` (honest-numbers class 1). |
| F11 | Light composer at the bottom of the main column: "Agent ▾", a chip with a dot, ×, multi-line input, B I code link attach · Workflow ▾ · / commands, Send | Only on the work item and only for dispatchers (`WorkItemDetail.tsx:201-228`) | Exists: `RichChatComposer` with `backdropTone="none"`, `modeControl="menu"`, `layout="wide"`, `toolbar="editor"`, `toolbarExtras` = `DropdownMenu triggerVariant="secondary"` "Workflow", `commands`, `references` and `onRemoveReference`. **NEW** `ExplorerLayout.paneFooter`: a non-scrolling band under the pane, so all three variants dock in one slot. **NEW** `ComposerReference.marker="dot"`: the fallback is a DocumentIcon today (`ComposerReferences.tsx:86`). Optional **NEW** toolbar preset `prompt` (B I code link attach, no list/quote). Component: `projects/InitiativeComposer.tsx`. |

### Variant 1: Overview (`/iq/projects/p-observability`)

| # | Mockup | Today | Renders with |
|---|---|---|---|
| O1 | Title "Observability Platform", about 28px bold, "In progress" pill | ScopeHeader h1 at 22px (`ScopeHeader.tsx:252`) plus crumbs (`ProjectDetailPage.tsx:443`) | **NEW** `ScopeHeader titleSize="lg"`. Portal: drop `breadcrumbs`. |
| O2 | Right side: outlined "Repository ↗" button and ⋯ | Inline link with LinkIcon (`ScopeHeader.tsx:157`) | **NEW** `ScopeHeader linkStyle="button"` with a ↗ icon (`PopOutIcon`, or a new `ExternalLinkIcon`). Label "Repository", href from `repoFullName` (`ProjectDetailPage.tsx:433,453`). |
| O3 | Subtitle: "Collect telemetry, reduce alert noise, and control retention costs." | not shown (only `stats`, `:447-451`) | **NEW** `ScopeHeader description`. The text is `project.summary` (wire exists: `providers/projects.ts:88`, mock `:317`). The seed changes per D1. |
| O4 | "Nora DaSilva · Owner   Layla Hassan, Eli Garcia · SMEs" as names | Avatar groups (`ScopeHeader.tsx:266`, `ProjectDetailPage.tsx:429-432`) | **NEW** `ScopeHeader peopleStyle="names"`. Same `people` groups. |
| O5 | Tabs: Overview · Work 11 · Decisions 2 · Agents · Contributors 3 | Tabs without Overview; default `work` (`:171-175, 463-470`) | Exists: `ScopeHeader tabs` in `ExplorerLayout.paneHeader`. Portal: add `overview`. Default is `overview`, but `work` when `?item=` is present, so `ActiveRunsBadge.tsx:82` and `LocalComputePage.tsx:131,761` keep landing on Work. The Work count is `allRows.length`. |
| O6 | Stat strip: "**18** / 52 points delivered" plus progress bar · "**2** agents running" · "**$1.73** spent of $95 allocated", with dividers | `progress` and `spentUsd` inline in the header stats | **NEW** `StatStrip variant="inline"` and `StatStripItem.progress`. Today the cluster is label-over-value (`StatStrip.tsx:78`). Data: points from `sumForestPoints(workTree)` (`ProjectDetailPage.tsx:428`); `activeAgentRuns` and `allocatedUsd` are **new on the detail wire** (M1); spend is `agentSpendUsd`. A null allocation reads "$1.73 spent · no allocation". |
| O7 | "What needs attention": callout with amber fill and left bar; title, two-sentence body, meta "**Blocked** · Eli Garcia · 2 points", action "Open work →" | none | Exists: `Banner layout="callout" variant="warning"`, which 2.389.4 gives the pale callout fill. **NEW** `Banner accent="bar"` (3px tone bar) and `Banner meta`. Data: the first blocked open or in-progress item in Work order (P0 `overviewModel.attention`). Title = row title; body = `summary` plus `blockedReason` (M2); meta = "Blocked" (warning ink), assignee, points. The action opens `?tab=work&item=<id>`. Nothing blocked: `T` muted "Nothing is blocked." (from rows; a failed `/work` read shows the error instead). |
| O8 | "Plan next": 3 rows (title, one-line description, right "Layla Hassan · 5 points", chevron) and "See all 11 work items →" | none | **NEW** `ActionRowList` (work/): whole-row button, `description`, right-aligned `meta`, chevron, rules, `footer` link. Data: `overviewModel.planNext` = the first 3 of Next up excluding the attention item. The description is `summary` (M2); rows without one show none. |
| O9 | "How to move this forward" plus one sentence | none | Exists: `SectionLabel`/`T`. Headings come from a library heading size (branding forbids page title typography, `validate-branding.sh:71-73`): use `PageHeader size="md"`, or `KeyValue`/`OutcomeSection variant="heading"` title styles. |
| O10 | Composer: chip "● Observability Platform ×", prefilled "Help me prioritize the next changes and explain the tradeoffs." | none | F11. The prefill uses the `draft` prop keyed by initiative id. Send enabled. |

### Variant 2: Work tab, item open (`?tab=work&item=wi-obs-e2-b4`)

| # | Mockup | Today | Renders with |
|---|---|---|---|
| W1 | "‹ Initiatives" back link above the rail title | none | **NEW** `ExplorerLayout railBack={label, onClick\|href}` (a WorkspaceRail row above the title). |
| W2 | "Work 11" plus switcher "Observability Platform ▾" | `WorkListView` full chrome (`ProjectDetailPage.tsx:492-557`) | Exists: `WorkListView chrome="embedded"`; `railTitle="Work"`, `railCount`, `railActions` = `Select` over the initiatives list, navigating to `/iq/projects/:id?tab=work`. No « here. |
| W3 | Search "Find work…" and filter button on one row; "By priority ▾" as a text menu below | Search row, then Select plus filter (`WorkListView.tsx:329+`) | **NEW** `WorkListView toolbarLayout="inline"` and `sortStyle="menu"` (a `DropdownMenu triggerVariant="link"`). Portal: sort labels become "By priority", "By points", "Recently updated", "By title" (`workListModel.ts:29-34`). |
| W4 | Groups: Next up 5 (open), In progress 2 (collapsed), In review 1, Done 3 (collapsed); plain counts | All open except Done (`workListModel.ts:14-19`) | Exists: `WORK_GROUPS` with `in_progress.defaultOpen=false`. **NEW** `groupCountStyle` passthrough. |
| W5 | Rows: "Bug · Eli Garcia · 2 points" as text; red "Blocked" tag on the right; no avatar; no checkbox for member | Avatar, Bug chip, "2 pts" (`WorkListView.tsx:229-238`, `workListModel.ts:87-108`) | **NEW** `WorkListView metaStyle="text"`, `WorkListItem.kindLabel`, `pointsLabel` ("points"), `WorkListItem.tag` (maps to `GroupedListRow.trailing`), and `signalDisplay="meta"` ("Awaiting review · Layla Hassan", no ring). Blocked = `labels` includes 'blocked' (same rule as `lib/work-suggestions.ts:146`). |
| W6 | Selected row: fill plus bar | fill plus bar at md | Exists (`size="md"`). |
| W7 | Condensed initiative header: title and pill, "18 / 52 points delivered · $1.73 spent" under the title, Repository ↗ ⋯, tabs | ScopeHeader stats inline | **NEW** `ScopeHeader statsPlacement="below"`. On Work: no `description`, no `people`. |
| W8 | Crumb "› SLOs and error budgets / Bug · wi-obs-e2-b4" | Exists (`WorkItemDetail.tsx:170-176`) | Exists: `EditorShell variant="work-item"`, `itemType`, `itemKey`. |
| W9 | Title about 26px bold | 22px work-item default | Exists: `EditorShell titleSize="lg"` (2.389.0). |
| W10 | Meta: "● Open · **Blocked** · (EG) Eli Garcia · 2 points · **High priority**", divided | Boxed `WorkItemMetaBar` with order status/points/owner/priority (`WorkItemDetail.tsx:177-190`) | **NEW** `WorkItemMetaBar flags=[{label:'Blocked',tone:'danger'}]`, `layout="divided"` (order status · flags · owner · points · priority) and `priorityStyle="tag"`. Member stays read-only through `readOnlyReason`. |
| W11 | Tabs: Brief · Discussion · Activity, no counts | Discussion count (`:191-195`) | Exists. Portal: pass `count` only when > 0. |
| W12 | "Why this matters" paragraph | `OutcomeSection` titled "Outcome" (`:233-239`; default title `OutcomeSection.tsx:36`) | Exists: `OutcomeSection title="Why this matters" variant="heading"`. The value is `description` (seeded per D1). |
| W13 | Amber "Next step" callout: "Confirm the dependency map with Eli Garcia." / "The team needs this before choosing how to group duplicate alerts." / "Open discussion →" | none | Exists plus NEW from O7: `Banner layout="callout" variant="warning" accent="bar" title=nextStep` with `nextStepDetail` as the body. The action switches to `?view=comments`. Hidden when `nextStep` is null. |
| W14 | "Complete the brief", a sentence, and a 3-row table: label · status · action | Full sections (`:240-264`) | **NEW** `KeyValue` `items[].action`, `items[].muted`, `divided`. Rows: acceptance criteria ("Not defined yet" / "3 defined · 1 met", action "Draft with agent" / "Edit"); dependencies and decisions ("No links added" / "2 linked", "Add context"); planning notes ("No notes added" / "2 notes", "Add a note"). Built by P0 `briefModel` from criteria, decisions and comments, with loading and error states. A filled component also renders its full existing section (ChecklistSection, LinkedItemsSection, CommentList) above; when all three are filled the table hides. |
| W15 | Collapsed "› Run setup · SME or release manager required to dispatch" | `ContextColumn` aside with RunDraft (`ProjectDetailPage.tsx:559-586`) | Exists: `Disclosure variant="plain"` containing `RunDraft`. **NEW** `Disclosure hint` and `size="lg"` (keeps title typography in the library). The hint comes from `briefModel.runSetupHint`: no `DispatchAgentRun` → "SME or release manager required to dispatch"; SME without a grant → "Needs an active sprint grant on this initiative"; otherwise "<model> · <repo> · cap $X". The aside and `RUN_COLUMN_KEY` are removed. |
| W16 | Composer chip "● This work item ×", prefill "Help me define acceptance criteria and identify what Eli needs before this work can start." | Agent mode prepares a run (`:203-226`) | F11 and D6. The prompt comes from `composerPrompts.forItem(item, brief)`: criteria missing plus blocked, with the first name from `assigneeName`. |

### Variant 3: Mine, empty (`/iq/projects?scope=mine`, unlinked member)

| # | Mockup | Today | Renders with |
|---|---|---|---|
| M1 | Rail: Mine selected; "Nothing linked yet / Try Everyone to browse the workspace. / Show everyone →" | Centred `EmptyState` in the page (`ProjectsPage.tsx:294-302`) | **NEW** `EmptyState align="start"`, `size="sm"`, `EmptyStateAction.variant="link"`. |
| M2 | Footer "Personal view" | none | `railFooter`: `T`. |
| M3 | "My initiatives" / "Initiatives where you are an owner or contributor." with a rule | `PageSection` "Initiatives" | Exists: `PageHeader size="lg" description` in `paneHeader`. |
| M4 | "No initiatives are linked to you yet." plus two lines; **Browse all initiatives** (primary) and **Check profile** (secondary); rule; "How this view works" plus 3 lines; "Refresh this view" link | none | **NEW** `EmptyState align="start"`, `size="lg"`, `actionsDirection="row"`, `details={title, body, action}`. The reason comes from P0 `mineModel`: `unlinked` (M3 route) → the mockup copy; `linked, none` → "You are connected as <name>, but no initiative lists you…"; failed read → `UnavailableNotice` (class 3). |
| M5 | Composer chip "● Initiatives", placeholder "Ask about the team's initiatives or how to get involved…", Send disabled | none | F11 with no draft. The library already disables Send when the composer is empty. |

## 2. Data contract

| Field | On the wire today? | Change |
|---|---|---|
| Initiative summary | yes: `ProjectDetail.summary` (`providers/projects.ts:88`; Aurora `getProject`; mock `:317`) | Seed text per D1 (`generate_program_seed.py:39`, UPDATE at `:559-560`). |
| Owner, SMEs | yes: `ownerId/ownerName`, `contributors[].role` | none |
| Points delivered/total | yes: derived from the `/work` tree (`sumForestPoints`); list rollup `pointsDone/Total` | none |
| Agents running | list only: `activeAgentRuns`. Mock is a **typed** value (`:370`); Aurora derives it (`:489`). | M1: add to `ProjectDetail` (Aurora: copy the `active_agent_runs` subquery near the spend SQL at `:667`). Mock: count running `allMockRuns()` rows in 24h under the three-way attribution. Delete `activeAgents` and `activeHoursAgo`. |
| Spent / allocated | spent on detail; allocated on list only (`:58,496-497`) | M1: add `allocatedUsd` to the detail (mock `mockBudgetRow(ledger).allocatedUsd`; Aurora `initiative_budgets` subquery). |
| Attention item | `labels` contains `'blocked'` (seed and mock `wi-obs-e2-b4`) | none (selection in P0) |
| Attention reason | no | M2: `work_items.blocked_reason TEXT` → `WorkItem.blockedReason` |
| Plan next description | no (description is null on most children) | M2: `work_items.summary TEXT` (≤ 1 sentence) → `WorkItem.summary` |
| Why this matters | `description` (mock only for b4; the seed omits child descriptions, `parity/entities.ts:553-560` knownDrift) | M2: seed descriptions for the obs children; delete those knownDrift entries |
| Next step | no | M2: `work_items.next_step`, `next_step_detail TEXT` |
| Brief completeness | yes: criteria (`GET …/criteria`), decisions (`/projects/:id/decisions`, `workItemId`), notes (comments `!isSystem`) | none; P0 `briefModel` derives it |
| Run-setup gating | yes: `/api/session/capabilities` (`DispatchAgentRun`), `/api/sprints?scope=mine` grant (`ProjectDetailPage.tsx:144-152`) | none |
| Mine list | yes: `GET /api/graph/projects?scope=mine` (`routes/projects.ts:31-53`); unlinked → `[]` | none |
| Mine linkage and empty reason | no: `session/me` has no person (`routes/session.ts:41-57`) | M3: `GET /api/session/person` → `{ linked: boolean, personId: string\|null }` (`getUser(sub)`; `demo-user` → unlinked). Name via the existing `GET /api/graph/people/:id` (`routes/graph.ts:46`). |
| Decision ↔ item link | read only (`routes/decisions.ts:36,49` are GETs) | M4 (D8): `PUT/DELETE /api/graph/work-items/:id/decisions/:decisionId` behind `writeGate` (`routes/work-items.ts:62`) |

**Schema:** `schema/orgiq_work_items_schema.sql` (next to `description`, `:21`) gets `ALTER TABLE work_items ADD COLUMN IF NOT EXISTS summary TEXT, … blocked_reason TEXT, … next_step TEXT, … next_step_detail TEXT`.

**Aurora read:**
- `ITEM_COLUMNS` (`providers/work-items.ts:251-263`) gets the four columns behind a once-per-process `information_schema.columns` probe, mirroring `appUsersAvailable()` (`:283-300`). A missing column costs the field (null), never the board.
- `getProject` gets the two rollups.
- `/api/session/person` reads `app_users.person_id` through `getUser`.

**Seed generator** (`schema/seeds/generate_program_seed.py`):
- Add a `BRIEFS` dict keyed by work-item id. After the inserts, emit `UPDATE work_items SET title=…, summary=…, description=…, blocked_reason=…, next_step=…, next_step_detail=…`.
- Emit **no new RNG calls** (the RNG sequence drives every assignee and date).
- Regenerate `schema/seed_program.sql`. Do not hand-edit it.

**Mock (mock-floor rules):**
- **Rule 1:** `activeAgents` goes. The count comes from `running` rows (`countBy`). Point totals are never stored.
- **Rule 3:** `MOCK_INITIATIVES` moves to `middleware/src/mock/initiatives.ts` as `defineFixture({key:'initiatives', scenarios:{default, empty, error}})`. Timestamps come from `clock` (or a `Date.UTC` epoch as in `mock/work-items.ts:50-60`), never ISO literals, and there is no module-scope `Date.now()` (today `providers/projects.ts:306`).
  - `mockProjectExists` and `mockProjectName` read `initiatives.rows()`.
  - The `error` branch throws "relation does not exist" (the pattern in `mock/budgets.ts:113`).
  - Seeded in-flight runs (D3) go in `botRuns.default` (`mock/bots.ts:304-311`) with `clock.minutesAgo`.
- **Rule 2:** no new enum strings. `'blocked'` and statuses already exist.
- **Rule 4:** `/api/session/person` and M4 get mock branches (`FALLBACK_USERS`, `providers/identity.ts:44-73`; the `decisionRows` fixture, `mock/decisions.ts:64`).
- **Rule 5:** the fixture is reachable through `providers/projects.ts`.
- **Rule 6:** recapture `routes.json`, `wire.json` and `writes.json` with the full `MOCK_*` environment (`docs/mock-floor.md:417-421`). Classify M4 in `mock/core/wire/write-policy.ts`.

**Parity** (`mock/core/parity/entities.ts`):
- `work_items` (`:494-565`) gets fields `summary`, `blocked_reason`, `next_step`, `next_step_detail`, and drops the description knownDrift for the items now seeded.
- `projects` (`:268-279`) keeps comparing name and status against the D1 copy.
- `bot_runs` (`:707`) filters to rows with `job_id`, so `jobId:null` in-flight rows stay out.

## 3. Slices (in dependency order)

**L. ui-components batch, one additive release** (next minor after `origin/main`, likely 2.390.0). Repo `~/Projects/ui-components`, branched from the **latest** `origin/main`. Every prop is additive and keeps existing defaults.
- L1 `ScopeHeader`: `titleSize`, `description`, `peopleStyle`, `linkStyle` (plus `ExternalLinkIcon` if `PopOutIcon` is not ↗), `statsPlacement`.
- L2 `ExplorerLayout` and `WorkspaceRail`: `railBack`, `railCountStyle`, `paneFooter` (pane only, like 2.389.4's `paneHeader`).
- L3 `GroupedList`: `groupCountStyle`.
- L4 `WorkListView`: `toolbarLayout`, `sortStyle`, `metaStyle`, `pointsLabel`, `signalDisplay`, `WorkListItem.kindLabel`, `WorkListItem.tag`; pass through `currentStyle` and `groupCountStyle`.
- L5 `Banner`: `accent="bar"`, `meta`.
- L6 `StatStrip`: `variant="inline"`, `item.progress`.
- L7 NEW `ActionRowList` (work/, root export).
- L8 `KeyValue`: `items[].action`, `items[].muted`, `divided`.
- L9 `EmptyState`: `align`, `size="lg"`, `actionsDirection`, action `variant:"link"`, `details`.
- L10 `ComposerReference.marker`.
- L11 `WorkItemMetaBar`: `flags`, `layout="divided"`, `priorityStyle="tag"`.
- L12 `Disclosure`: `hint`, `size`. Also export `Disclosure` from `/shared`.
- L13 (optional) RichChatComposer `toolbar="prompt"`.

Tests: a vitest per prop; stories `Layout/ExplorerLayout › Initiative overview | Initiative work item | Initiatives mine empty` composing each whole variant from these props.

Acceptance:
```
npm test && npm run lint && npm run lint:static-styles && npm run lint:hex-colors && npm run snapshot:exports && npm run build
```
Also compare storybook screenshots at 1642×958 against the mockups. Record everything in the CHANGELOG.

**B. Pin (after L):**
- Set `portal/package.json:17` to the full 40-character sha, then `npm install`, `rm -rf node_modules/.vite`, and check for new optional peers.
- Settle identity and version with the two commands at `CLAUDE.md:437`. Verify every new prop against the installed `dist/*.d.ts`, not the source.
- Update the `CLAUDE.md:240` pin line.

Acceptance: `cd portal && npx tsc --noEmit && npx vite build`.

**M1. Initiatives fixture and detail rollups** (parallel with L):
- Files: `mock/initiatives.ts` (new), `providers/projects.ts`, `providers/bots.ts` (`countMockRunningRuns` counts all runs), `mock/bots.ts` (2 in-flight runs, D3).
- Tests: `providers/__tests__/projects-initiatives-fixture.test.ts` (count derived from rows; empty and error; `mockProjectExists` under empty); `routes/__tests__/projects-detail-rollups.test.ts` (`allocatedUsd`, `activeAgentRuns`, 404).

**M2. Brief fields** (parallel with L and M1):
- Files: schema ALTER, generator plus regenerated `seed_program.sql`, `mock/work-items.ts:205-220` (new fields and D1 titles), `providers/work-items.ts` (type, `ITEM_COLUMNS` with probe, `rowToItem`), parity entity.
- Update the title-bearing tests: `mock/__tests__/domain-fixture-writes.test.ts`, `routes/__tests__/work-item-criteria-comments.test.ts`, `portal/.../projectFormat.test.ts`.
- New test: `providers/__tests__/work-items-brief-fields.test.ts` (mock values; SQL includes or omits the columns with the probe true or false).

**M3. `GET /api/session/person`** (parallel): `routes/session.ts`, `routes/__tests__/session-person.test.ts` (demo-user → unlinked; u-theo → p-001; u-release → p-005 but no contributions), a route-coverage row.

**M4. Decision links** (parallel, optional per D8): `routes/work-items.ts`, `providers/work-items.ts` (Aurora `UPDATE decisions SET work_item_id`), the mock `decisionRows` mutation, write-policy entry, tests (401/403 member/200/404/409 for another project).

**M5. Wire and floor** (after M1–M4):
```
cd middleware && PORT=3012 … npx tsx src/index.ts   # the env at docs/mock-floor.md:417-421
npx tsx src/mock/core/wire/capture.ts
npx tsx src/mock/core/wire/scan.ts
npm test && npm run typecheck
cd .. && ./scripts/validate-mock-floor.sh && ./scripts/validate-route-coverage.sh && ./scripts/validate-honest-numbers.sh
```
Lower any budget that went down.

**P0. Portal pure models** (`.ts` only; parallel with L and M; types come from the M contracts above):
- `pages/projects/initiativeListModel.ts`: groups, row sublines, counts, footer.
- `pages/projects/mineModel.ts`: `unlinked | linked-none | error | has-rows`.
- `pages/project-detail/overviewModel.ts`: attention, planNext and stat items via `workRows(tree,'priority','')`.
- `pages/project-detail/briefModel.ts`: rows, states, `runSetupHint`.
- `pages/project-detail/composerPrompts.ts`: prefills, D5 workflows, `/iq/invoke` prompt builder.
- Extend `types.ts` and `project-detail/types.ts` with the new wire fields.
- Node tests for each (`__tests__/*.test.ts`) and an update to `workListModel.test.ts` (groups, labels, `kindLabel`/`tag`).

Acceptance: `cd portal && node --test 'src/**/__tests__/*.test.ts'`.

**P1. Frame and composer** (after B and P0): `pages/projects/InitiativesExplorer.tsx`, `InitiativeListRail.tsx`, `InitiativeComposer.tsx` (F2–F11).

**P2. List route** (after P1): rewrite `ProjectsPage.tsx`: D4 panes, Mine-empty variant (M1–M5 table rows), error via `UnavailableNotice`. Delete `InitiativeCard.tsx` if it is unused.

**P3. Overview** (after P1, parallel with P2): `ProjectDetailPage.tsx` tab logic and header props; new `project-detail/InitiativeOverview.tsx` (O1–O10).

**P4. Work** (after P1, parallel with P2 and P3 once `ProjectDetailPage.tsx` edits are sequenced after P3): `WorkRail` in the detail page (W1–W6); restructure `WorkItemDetail.tsx` (W8–W16); `RunDraft` inside the Disclosure; remove the `ContextColumn`.

**P5. Profile** (parallel): `SettingsPage.tsx` Profile section (D7).

**P6. Sprints tab** (optional, D10).

Portal acceptance after each P slice:
```
npx tsc --noEmit && npx vite build
../scripts/validate-component-discipline.sh
../scripts/validate-branding.sh --quick
../scripts/validate-nav-parity.sh
../scripts/validate-honest-numbers.sh
```
The raw/button/style budgets for pages are 0 (`validate-component-discipline.sh:185-199`), and no page may style its own titles.

**D. Docs, validators, journeys** (last):
- `CLAUDE.md` pin; `docs/program-operating-model.md` "Recently built"; `docs/mock-floor.md` (initiatives fixture, in-flight runs, `countMockRunningRuns`); `docs/ui-components-queue.md` (confirm no "Composed locally" rows were added).
- Re-walk `docs/orgiq-journeys/{member,sme,program-owner,org-leader,hr-admin}/{initiatives,initiative-detail}.md` (10 logs; plus `settings.md` ×5 if P5), with new screenshots and first-row-top ≤ 640.
- Optionally add a `MATRIX.txt` row `initiative-work | /iq/projects/p-observability?tab=work&item=wi-obs-e2-b4 | L | all five`.
- Then `./scripts/validate-orgiq-audit.sh --seal`, and without `--seal`, all of:
```
./scripts/validate-orgiq-audit.sh && ./scripts/validate-branding.sh && ./scripts/validate-mock-floor.sh && ./scripts/validate-component-discipline.sh && ./scripts/validate-nav-parity.sh && ./scripts/validate-honest-numbers.sh
```
- Update `portal/e2e/computer-lab-demo.spec.ts:108` to `?tab=work`.

**Parallel map:**
- `L ∥ M1 ∥ M2 ∥ M3 ∥ M4 ∥ P0`
- `B` after L; `M5` after M1–M4
- `P1` after B and P0; `P2 ∥ P3 ∥ P5` after P1; `P4` after P3 (shared file); `D` after everything

## 4. Visual acceptance (headless Chromium, viewport 1642×958, dev:mock, clean `POST /api/__mock/reset`)

Procedure:
- A throwaway Playwright script (portal `@playwright/test`, `baseURL` http://localhost:5183) calls `page.request.post('/api/session/login',{data:{userId}})`, then `goto`, then waits for network idle.
- Save to `docs/design/initiative-variants-build-<variant>-<role>.png`.
- Personas:
  - **member**: `u-theo` for Overview and Work; the cookie-less `demo-user` (no login) for Mine-empty, which matches the mockup's "Demo User · Member".
  - **sme**: `u-nora` (owner).
  - **org-leader**: `u-vera`; `u-release` for "linked, no contributions".

**Overview** (member and org-leader):
1. No crumb trail. Title and "In progress" pill on one row. Title visibly larger than the 22px default (about 28px).
2. The subtitle is the seeded summary. The people line reads names followed by "· Owner" and "· SMEs".
3. Outlined "Repository ↗" and ⋯ at top right.
4. Tabs: Overview (active), Work 11, Decisions 2, Agents (no count for member), Contributors 3.
5. Three stat cells with dividers: "18 / 52 points delivered" with a bar about 35% full; "2 agents running"; "$X spent of $95 allocated", where X equals the Budgets ledger's MTD for p-observability.
6. Warning callout with a left bar, the b4 title, two sentences, "Blocked · Eli Garcia · 2 points", and "Open work →" on the right. Clicking it lands on Work with b4 open.
7. Plan next: exactly 3 rows (StatsD, Error-budget dashboard, Metric cardinality) with owner · points on the right, chevrons and rules; "See all 11 work items →".
8. Composer bottom edge within 24px of the viewport bottom. Chip "● Observability Platform ×". Draft text present, Send enabled. No horizontal scroll. 0 console errors.
9. Rail: "Initiatives 14" (**not** 11: the mockup's numbers are illustrative); In progress 11 open; Planning 2 collapsed; Completed 1 collapsed. The Observability row is selected with a bar and reads "Nora DaSilva · 2 agents"; other rows read "· Idle". Footer "14 initiatives".

**Work** (member and sme):
1. "‹ Initiatives" above "Work 11" and the switcher.
2. Search and filter on one row; "By priority ▾" below.
3. Next up 5 (b4 first, red "Blocked" tag); In progress 2 collapsed; In review 1 ("Awaiting review · Layla Hassan"); Done 3 collapsed.
4. The member sees no checkboxes. The sme sees checkboxes.
5. Header: title and pill; "18 / 52 points delivered · $X spent" beneath; Work tab underlined.
6. Crumb "› SLOs and error budgets / Bug · wi-obs-e2-b4". Title about 26px. Meta row with Blocked and "High priority" tags.
7. Why this matters; Next step callout with "Open discussion →"; Complete the brief with 3 rows reading "Not defined yet", "No links added", "No notes added".
8. Actions:
   - Member: "Draft with agent" enabled; "Add context" and "Add a note" disabled with a title reason.
   - SME: all three enabled.
9. "› Run setup" collapsed, with hint:
   - Member: "SME or release manager required to dispatch".
   - Nora: her grant state per `/api/sprints?scope=mine`.
10. No right-hand column. Chip "● This work item". Prefill names Eli.

**Mine-empty** (demo-user member; `u-release` org-leader):
1. Rail: Mine selected; "Nothing linked yet" left-aligned with "Show everyone →"; footer "Personal view"; count "Initiatives 0".
2. Pane: "My initiatives" with its subtitle and rule. Heading "No initiatives are linked to you yet." Primary "Browse all initiatives" and secondary "Check profile" side by side. Rule, then "How this view works" with 3 lines and a "Refresh this view" link.
3. `u-release` sees the "connected as Sienna Garcia, but…" wording instead.
4. Composer chip "● Initiatives", placeholder visible, Send disabled.
5. "Check profile" lands on `/settings#profile`. "Browse all initiatives" switches to Everyone.
6. With `POST /api/__mock/scenario {"scenario":"error","fixture":"initiatives"}`, both rail and pane show the failure, never the empty copy.

## 5. Risks

1. **Shared files with `feat/distillation-guide-record`:**
   - `portal/package.json:17` and `package-lock.json` (it pins `871c13a5`).
   - `CLAUDE.md:240`.
   - `middleware/src/mock/core/wire/snapshots/{routes,wire,writes}.json`, `write-policy.ts`, `http.ts`.
   - `docs/mock-floor.md` (uncommitted there now).

   Rebase after it merges, keep the higher pin, and **never hand-merge the snapshot JSON**: recapture.
2. **The library is moving:** 2.389.2–2.389.6 landed within hours. Rebase L onto the newest `origin/main` immediately before releasing, bump the version to whatever is next, and re-run `snapshot:exports`.
3. **orgiq-audit freshness:** 10 journey logs go stale by pages digest (5 more if P5 touches `SettingsPage.tsx`). The initiative-detail observations (default tab, run column, composer gating) become false, so re-walk with every field, not just a re-seal. The branding journeys' "initiatives=16px" rhythm entry becomes untrue. It only forces a re-walk if `app.css`/`Layout.tsx` change (hash at `validate-branding.sh:99`), but correct it at the next walk.
4. **Capability gating:**
   - Run setup is capability-based (`DispatchAgentRun`), not role names, so program-owner and hr-admin read as able to dispatch.
   - The SME grant cue is kept.
   - Chat mode and the Add note/context writes follow `writeGate`.
   - "Check profile" must be reachable by member (`/settings`), with the Identity link only for `ManageUsers`.
   - Nav-parity is unaffected because `App.tsx:296-300` gating is unchanged.
5. **Default tab change:** the `?item=` → Work rule keeps existing deep links working. `computer-lab-demo.spec.ts:108` and the demo-recording skill need `?tab=work`.
6. **D3 in-flight runs:** they show globally (ActiveRunsBadge, Automate, Computer Lab), consume one of the three concurrency slots, and may be settled by a mock reconcile loop. Verify they survive 10 minutes of dev:mock and that no other journey claims "nothing running". Aurora reads Idle by design.
7. **Seed copy (D1):** `ON CONFLICT DO NOTHING` needs the explicit UPDATE. Changing RNG call order would reshuffle the whole seed. Check that the synthetic corpus does not read the old titles.
8. **Honest numbers:**
   - The rail count must not be the length of a capped page (list `limit=100`).
   - The mockup's 11/9/2 counts are illustrative, so acceptance uses derived counts.
   - Class 3: every new `useFetch` destructures `error`/`degraded` before any empty copy (Mine-empty, attention, brief rows).
9. **Composer:**
   - Never put it in a content-sized box (the 2.389.1 loop).
   - Key the `draft` prefill by subject so switching items does not carry text across.
   - Agent mode navigates away, so an unsent SME Chat draft is lost. Say so in `modeUnavailableReasons` or warn.
10. **Aurora schema lag:** the probe must degrade to null fields. Apply `orgiq_work_items_schema.sql` before the seed UPDATEs (`schema/apply-work-items.sh` ordering).
11. **Component discipline:** layout wrappers are library `Stack`/`Inline` only. Any unavoidable local composite must be queued ("Composed locally in …", cap 8 raw per file) before it is merged, not after.

### Critical files for implementation
- /Users/connorhoehn/Projects/aws-agentcore-wt-initiative/portal/src/pages/ProjectDetailPage.tsx
- /Users/connorhoehn/Projects/aws-agentcore-wt-initiative/portal/src/pages/ProjectsPage.tsx
- /Users/connorhoehn/Projects/aws-agentcore-wt-initiative/portal/src/pages/project-detail/WorkItemDetail.tsx
- /Users/connorhoehn/Projects/aws-agentcore-wt-initiative/middleware/src/providers/projects.ts
- /Users/connorhoehn/Projects/aws-agentcore-wt-initiative/middleware/src/providers/work-items.ts (+ schema/seeds/generate_program_seed.py)

## Decisions taken (2026-09-24, orchestrator — the images win)
All §0 defaults D1–D10 are adopted as written, including M4 (decision links) and P5 (Settings Profile). P6 (Sprints tab) is minimal: no regressions.
