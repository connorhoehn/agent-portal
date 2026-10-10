# Audit and refactor plan, 2026-10-07

This is a read-only audit of everything touched on 2026-10-07. It covers the
1,027 records in `docs/audit/2026-10-07-touched.jsonl`, plus the ui-components
chain 2.427 to 2.436.4 read at `4dfdb756`. Nothing other than this file was
changed.

## The verdict

The user's suspicion is right, though not in the form the gates look for.

Raw hand-rolling is close to zero. There are no raw `<button>` elements, no
`role="tab"`, and 11 inline styles in total. The component-discipline gate is
doing its job.

The debt is structural. The same idea was rebuilt on top of library parts,
several times over, by lanes that did not see each other:

- The right pane has four models. There are four rail models, about nine page
  headers and five composer wrappers on three different library bases.
- The server has three authority gates over the same Social handlers, five
  "mine" readers with five different shapes, about seven models of "shared
  work", and two stores for one page conversation.
- The library shipped 22 releases in a day. Seven components each gained
  their own `size="sm"`, there are four separate responsive mechanisms, and
  three density vocabularies disagree with each other.

The judges then ratified all of this. They were baselined on the same day they
were introduced, so 674 type-scale entries, 399 raw pixel sizes, 22 stacked
cells and 15 card strips are now recorded as "passing".

About 42,000 lines were added or changed today. Of those, 15,200 are tests and
specs, 13,900 are portal code and 10,700 are middleware code. This is an upper
bound: untracked files are counted whole. Another 230 of the 1,027 records
(22%) are journey-log churn, and 262 (26%) belong to no lane.

---

## (a) Findings

Severity: **H** means authority, correctness, or a pattern that multiplies;
**M** is debt that compounds; **L** is hygiene. Effort: **S** is under half a
day, **M** is one to two days, **L** is a multi-day program.

### Hand-rolled composition (portal)

| id | area | file:line(s) | what is hand-rolled or duplicated | reuse target | sev | eff |
|---|---|---|---|---|---|---|
| H1 | shell CSS | `portal/src/app.css:672-699` | Folds the primary rail by reaching into library DOM with `> div > aside` and `!important`. It hides children with `:not(:has([data-testid="shell-rail-toggle"]))` and keys a height on `[data-testid$="-header"].h-9`, so test IDs and a Tailwind class have become a styling contract. Any library DOM change breaks it silently. | `SubNavLayout`/`NavRail` `collapsed` + `onToggleCollapsed` (queue row 10 already asks for it) | H | M (lib) |
| H2 | headers | `portal/src/pages/projects/InitiativeHeaderFrame.tsx:27-39,53,57,71-99` | A parallel `ScopeHeader` built from `PageHeader` + `StatusPill` + `Avatar` + `DropdownMenu` + `Tabs`. It has its own ResizeObserver 760px rule and a private `compact` mode, raw `text-sm text-text-tertiary` at `:89,:92`, and test-only `data-layout`/`data-wide`/`data-compact`. Queue row 86 was retired on 2026-10-05, so **nothing exempts this file**, and it is the ~300px header the user complained about. | NEW: library header density system, see (d) R2 | H | M |
| H3 | headers | `TeamScorecard.tsx:148-197`; `pipelines/RunDetailPage.tsx:104` + `PipelineRunParts.tsx:52`; `SearchPage.tsx:227-229`; `SectionContent.tsx:30-50`; `EditorShell` heads at `DeckEditorPage.tsx:121`, `WorkItemDetail.tsx:286`, `ReviewTab.tsx:124`, `KnowledgeRecord.tsx:328` | There are about nine header implementations. The scorecard's is the tallest (~220px) and is patched with `[&>div]:flex-wrap` at `:149`. The pipelines run page draws two titles for one record (`PageHeader "Run"` plus `DetailHeader as="h2"`). Search has a conditional two-row trail. `EditorShell` sits at `px-5`, off the 24px gutter. In total there are 38 `PageHeader` files, 10 `DetailHeader`, 6 `ScopeHeader` and 5 `ChannelHeader`, with three size vocabularies (`md|lg`, `md|sm`, none). | NEW: one `PageHeader` with `density` and slots (R2); `Layout.tsx:447` app header to a NEW `AppHeader` | H | L |
| H4 | right pane | `initiativePaneModel.ts:15-63`; `SearchPage.tsx:358-378`; `components/shell/conversationPaneModel.ts:14-29`; `HuddleChat.tsx:74,466-547`; `shellPaneSignal.ts:8-25` | The fourth column is modelled four times, with incompatible URL keys. The initiative uses `?selection=<kind>:<id>`, search uses `?pane=&paneRecord=` and also `?selection=` with a different meaning, and the HuddleChat view is `closed\|pane\|floating`. A module-global signal exists only so the rail rule can read pane state, and `railCollapseModel.ts:46-66` counts `selection` as depth. | NEW: `SidePane` (extend `ContextColumn`/`ChatSidePanelFrame`) with a typed `{tab, record}` URL contract, persisted ratio and a published `open` state | H | L |
| H5 | pane model mixes concerns | `initiativePaneModel.ts:82-103,139-176` | The pane-tab model also computes money (`maintenanceFloor`) and log formatting (`logLines`). | Split: money to the server (H11); log rows to a NEW `LogLines` or `TraceTree` | M | S |
| H6 | rails | `components/communication/planeRailModel.ts:84-125,169-280` (305 lines); `PlaneRailSections.tsx:43,76`; `SocialChatWorkspace.tsx:436-484`; `InitiativeListRail.tsx:243,302`; `SectionContent.tsx:96-143` (`SectionListLayout`, 7 users) | The Plane and Social rails each assemble `RailSectionHeader` + `ConversationList` inside `ConversationRail`, and each re-derive rows, unread counts, filters and row keys. `SectionListLayout` is a page-local composite over `ExplorerLayout` that the library does not have. Three readers normalize three server shapes into `PlaneGroup` (see D4). | `ConversationRail` `sections` as data, shared by Plane and Social; upstream `SectionListLayout` as a NEW `ListRailLayout` | H | L |
| H7 | rail collapse | `railCollapseModel.ts:26-125`, `useShellRails.ts`, `useSectionRailFold` | There are three notions of "how deep am I": path depth, the `DRILL_PARAMS` list at `:32` (hand-maintained), and pane open. Each is remembered under its own key: `shell.primary-rail.*`, `initiatives.rail-collapsed(.deep)`, `assessment.documentRail.collapsed`, `shell.conversation-pane.open`. | One library `useRailFold(band)` behind `SubNavLayout collapsed`; depth declared by the route, not by a param list | M | M |
| H8 | composers | `InitiativeComposer.tsx:194-263`; `DimensionComposer.tsx:5,112` (a self-declared copy); `DeckComposer.tsx:59`; `SummarizableChatPanel.tsx:13,122` → `ScopeDiscussion.tsx:64-91` (two local layers); `SearchComposer.tsx:126` (`AgentComposerDock`); `ExplainComposer.tsx:70` (`RichChatComposer`) | Five wrappers on three library bases. Each adds a target, references, status lines and `/commands` its own way. | NEW: `PageComposer` (`ContextComposer` with `target`, `references`, `statusLines`, `commands`) | H | M |
| H9 | hover card | `PersonRef.tsx:33-34` (450/250ms); `InitiativeDetailsCard.tsx:113-142` (300/250ms, its own Escape listener and anchor capture) | Two hover timings, two dismissal implementations. | NEW: `HoverCard` (queue row 293), timing inside it | M | S |
| H10 | measuring | `ShellCallHost.tsx:94`, `SocialFooter.tsx:147`, `HuddleChat.tsx:574`, `ProjectDetailPage.tsx:180`, `InitiativeHeaderFrame.tsx:34` | Five local ResizeObserver width hooks. The library has `useMeasuredWidth` but keeps it private to doc-editor (`ui-components/src/components/doc-editor/useMeasuredWidth.ts:29`). | Export `useMeasuredWidth` from `/shared`, or better, use container queries inside the composites | M | S |
| H11 | money in the client | `initiativePaneModel.ts:87-92`, read at `InitiativeDetailsCard.tsx:67` | The 30-day maintenance floor is summed in the browser from a run list. A null cost is counted as 0, which contradicts "unknown burn is unknown, not zero" and duplicates `v_initiative_maintenance_30d`. | A server field on `GET /api/bots/initiative-runs` read from the view; the honest-numbers judge gains a portal `reduce(… cost …)` scan | H | S |
| H12 | N+1 fetches | `InitiativeSidePane.tsx:204-220` (one GET per work item, then a client cap at `DOCS_PANE_LIMIT`); `usePlaneOrg.ts:37-59` (one `/api/social/bindings` per group, re-polled every 60s); `RunInspector.tsx:31`; `useDimensionIndex.ts:22`; `SharedWorkView.tsx:58` | Fan-out `Promise.all(map(fetch))` loops. 52 raw `fetch(\`/api…` calls in 36 files bypass `useFetch` (backoff, hidden-tab pause, share). | Batch routes (`GET /api/graph/projects/:id/documents`, `GET /api/social/bindings?contexts=`); a lint rule against `fetch` inside `.map` | M | M |
| H13 | Frame files | 8 `*Frame.tsx`; only `PromptsFrame`, `DiffFrame`, `TrafficHeatmapFrame` and `PersonCardFrame` have "Composed locally" rows. Unexempted: `InitiativeHeaderFrame` (107 lines), `assessment/knowledge/ExplorerFrame.tsx` (80), `AgentFlowFrame` (219), `RangeSliderFrame` (71, used at `SearchPage.tsx:595`). | The gate counts raw HTML, not local composites, so a page-local composite made of library parts passes unseen. | Judge change J2 | M | S |
| H14 | raw type | 94 files contain `text-[Npx]`: `[11px]`×108, `[13px]`×94, `[12px]`×97, `[10px]`×23, `[12.5px]`×14, `[10.5px]`×11. Worst offenders: `SelectContextPage` 28, `HarnessHomePage` 26, `InvocationDetailPage` 25, `InvocationsPage` 24, `WorkHomePage` 23. `SearchPage.tsx:43` has `HEADER_CONTROL='h-7 px-2.5 text-[13px] font-medium…'`. | The declared scale is 20/14/12, yet the tree holds 13px, 12.5px, 11px and 10.5px. The ratchet (`scripts/layout-drift-budget.txt` `pxtype 399`) made this the baseline. | `T`/`Text` tokens through the density system (R1) | M | M |
| H15 | size at every call site | portal: `size="sm"` ×1,089 (`Button` 353, `T` 135, `Table` 49) and `size="xs"` ×1,045 (`T` 399, `Chip` 379, `MetaLine` 155) | The house density is restated at roughly 2,100 call sites. That is a missing default, not a design choice. | `DensityProvider` default (R1), then a codemod to delete the props | M | M |
| H16 | click guard | `Breadcrumbs.tsx:54`, `StackedCatalogLayout.tsx:49`, `InitiativeRail.tsx:175`, `InitiativesExplorer.tsx:77,102`, `DistillationModule.tsx:131`, `KnowledgeTab.tsx:356`, `DocumentNavigation.tsx:26`, `SearchPage.tsx:40`, `PromotionsPage.tsx:324`, `IqLayout.tsx:33` | The plain-left-click guard is copied about 11 times. | Library `RouterLink`/`isPlainClick` | L | S |
| H17 | dots and drawings | `CanarySetupFlow.tsx:74`, `WorkflowTimeline.tsx:64` (`text-[8px]`), `SummaryPage.tsx:340`, `PromptHistoryPage.tsx:596`; `InitiativeSidePane.tsx:127-132` (`-ml-2.5` offset hack), `:283-287` (hand-drawn log rows) | Sized `rounded-full` dots and a hand-composed pane header row. | `StatusDot` / NEW `StepDot`; NEW `PaneHeader tabs trailing` | L | S |

### Duplication across lanes (server and shared)

| id | area | file:line(s) | what | reuse target | sev | eff |
|---|---|---|---|---|---|---|
| D1 | Social authority | `middleware/src/routes/social.ts:218` (`requireAction`, cookie grants that may be up to 120s stale); `routes/social-plane.ts:56,71,115,125` (`planeAction`, live grants plus post-read rechecks); `social.ts:540` (`embedGate`); `social.ts:434` (`markPlaneRequest` WeakSet lets `personalTeamSession` skip its epoch and actor checks) | Three gates sit over the same handlers, so `/api/social/channels` and `/api/social/plane/channels` answer the same rows under different freshness rules. Authority is passed through a request-scoped WeakSet. `social-plane.ts:182-191` (work-graph) skips the post-read recheck its siblings do. | One `socialGate(action)` in `lib/live-principal.ts` used by all three mounts; delete the WeakSet | H | M |
| D2 | page conversation | `routes/work-items.ts:639-650` (Aurora `work_item_comments`) vs the chat channel `orgiq:work:<id>`; `lib/tenant-channels.ts:23`; `lib/social-notify.ts:483` (bell opens `view=comments` for a chat event); `providers/assessment-aurora.ts:1262` (`assessment_knowledge_comments`) vs `assessment:doc:<id>` | Two stores for one thread, in two tenants. The checkpoint calls this a "migration owed", but nothing writes one store into the other. | The chat channel is the page thread; a one-time projection of comments into it, then retire the REST store | H | L |
| D3 | chat backend | `lib/social-chat.ts:451` (memory) vs `lib/realtime-gateway.ts:620` (Dynamo) | The store factory is split across two modules. | Both in `social-chat.ts` | M | S |
| D4 | "mine" readers | `routes/projects.ts:41` (bare array); `sprints.ts:113-131` (`{scope,personId,canSeeAll,sprints}`); `org-teams.ts:22` (`{personId,teams}`); `plane-groups.ts:21` (`{userId,personId,teams}`, membership by **display name or email**, `providers/plane-groups.ts:34-36`); `plane-groups.ts:34` (`owner`/`updatedBy` equals the user) | Five shapes and four membership rules, all normalized in the portal (`planeRailModel.ts:84-125`). Matching assessment teams by display name is an authority bug waiting for a namesake. | `GET /api/me/groups?kind=` returning `{userId, personId, items[{id,name,role,members}]}` on one `mineIdentity(session)`; a real user↔assessment-team link | H | M |
| D5 | roster and avatars | avatars attached at `social.ts:347,379,593`, `people.ts:47,87`, `session.ts:186,217`, `lib/call-log-avatars.ts:9`; roster built at `social.ts:165`, `social.ts:570`, `people.ts:42`, `lib/work-graph/plane-active.ts`; missed-call count at `page-calls.ts:37`, `social.ts:506` and plane-active | Eight avatar enrichments, four rosters, three missed-call counts. | `lib/people-directory.ts` `rosterFor(tenant,{authoritative})`; one `callLogView(rows)` | M | M |
| D6 | "shared work" | `lib/work-graph/sharing.ts`; `shared-work.ts:7-10` (implicit grants from `pageReference`); `routes/dm-page-references.ts:6` and `routes/page-references.ts` (two resolvers); `providers/work-documents.ts`; `lib/gateway-attachments.ts` + `social.ts:610`; recordings `social.ts:494`; bindings `social.ts:677`; portal `SharedWorkView.tsx` and `PersonSharedWork.tsx` | About seven models of "work shared between people". | One share-edge model `(subject, audience, grant)` in `sharing.ts`; the other six become edge producers | H | L |
| D7 | backend-dependent visibility | `lib/work-graph/plane-active.ts:27,63-73` | Production code imports `socialCallLogFixture`. Under the mock, every caller sees everyone's live calls; the real backend shows only the viewer's own. The mock is not a contract here. | Fix the mock to the real rule; ban `mock/` imports from `lib/` and `routes/` (J6) | H | S |
| D8 | production code imports a mock | `unreadFor` lives in `mock/social-channels.ts:227` and is used by `routes/people.ts:23` and `lib/page-thread-unread.ts:36` | Production logic is housed in a fixture file. | `lib/chat-unread.ts` | M | S |
| D9 | demo directors | `mock/demo-director.ts:140-190` vs `mock/distillation-demo.ts:143-187`, with two pace knobs | The same cancel, milestone, start/stop and beat scaffolding is written twice. | `mock/core/director.ts` | M | S |
| D10 | synthetic sessions | `social-notify.ts:510`, `shared-work.ts:71`, `recording-source.ts:38` (`iat: 0`) | Three hand-built sessions sit outside the authority module. | `live-principal.sessionForUser(user, tenant, role)` | M | S |
| D11 | DM naming | `social-chat.ts:84` (`dmChannelFor`), `people.ts:28` (`tenantDmChannel`), `tenantDmMembers` | The DM channel name is written three times. | One function, in realtime-modules next to `dmLobbyName` | M | S |
| D12 | god module | `lib/realtime-gateway.ts` (1,145 lines, +661 today): auth `:150`, guards `:208,:265`, four notify plugins `:439-557`, Dynamo plus seeding `:589-705`, invites and missed calls `:705-750`, stats `:763-836`, env `:893-910`, wiring `:923` | Eight responsibilities in one file that every lane edits. That is why snapshots went stale three times today. | Split into `gateway-auth`, `gateway-guards`, `gateway-notify-plugins`, `gateway-calls` and `gateway-stats`, with the chat backend moved to `social-chat`; ~200 lines of wiring remain | M | M |
| D13 | mock numbers | `mock/budgets.ts` `DEMO_ENVELOPE_USD = 0.7`, hand-sized against `demo-auth-products.ts:153-224`; `graphTeams` in `mock/people.ts` re-lists `departments` under new ids and joins them by name; `providers/org-teams.ts:31-42` mock roles (`department`/`title`) vs Aurora `team_memberships.role` | Violates `docs/mock-floor.md`: a number that could have been derived, and a fixture shape that diverges from the real one. | Derive from the rows; one team fixture | M | S |

### Authority smell

| id | area | file:line(s) | what | target | sev | eff |
|---|---|---|---|---|---|---|
| A1 | call listing | `middleware/src/routes/page-calls.ts:55-65` | `/api/calls/tenant` lists every lobby in the tenant without asking each lobby's read gate or rechecking afterward. The sibling `/api/calls` route asks at `:48`. | Per-lobby read gate, as at `:48` | H | S |
| A2 | freshness | `routes/org-teams.ts:22` | `/api/graph/teams` has no `currentLiveSession` tenant or epoch check, unlike `/api/people/*`. | `socialGate`/`currentLiveSession` floor | M | S |
| A3 | portal copies a server rule | `components/shell/callShellModel.ts:196-199` | The lobby admission regex is copied from `lib/call-access.ts` `huddleLobbyTenant`, and pipelines and social are silently excluded. | Server returns `huddleChat: boolean` with the lobby | M | S |
| A4 | portal decides grants | `lib/communicationPlane.ts:42-49`; `EmbeddedSocial.tsx:246` and `CommunicationPlane.tsx:80` (`grants.social?.[0]`) | Access is decided from cookie grants, and the first role is picked as if users hold one. | `can('ViewSocial')` from `/api/session/capabilities` | M | S |
| A5 | default-allow | `pages/social/SocialConversation.tsx:160,173` (`maySend ?? true`, `maySend = true`) | A caller that forgets the prop is offered send and `/agent`. | Default `false`; the server returns `maySend` | H | S |
| A6 | client filtering | `ActivityBell.tsx:53-60` (inbox filtered by tenant grants); `SearchPage.tsx:340` (agents filtered by an id regex) | Either a server bug is hidden or the client is the only gate. | The server scopes both | M | S |
| A7 | role lists | 26 `RequireRole roles={[...]}` in `App.tsx`; 12 `requireRoles:` in `Layout.tsx:129-167`; `LEADER_ROLES` at `InitiativeListRail.tsx:72` | Copies of Cedar. Nav-parity only checks that they agree with each other. | `can(action)` everywhere; nav-parity compares against Cedar | M | M |
| A8 | pre-check drift | `InitiativeComposer.tsx:261` | Role-wide `can('DispatchAgentRun')` stands in for the per-subject `deckWriteAuthority`. | The server returns `mayBuild` per subject | M | S |
| A9 | hidden affordance | `components/shell/EmbeddedSocial.tsx:249-251,259` | Alt-click is the only route to the quick-DM panel: undiscoverable, keyboard-hostile and absent on touch. | A visible `DropdownMenu` item, or drop the panel | M | S |
| A10 | test hooks | `CommunicationPlane.tsx:204,218` (`data-access`, read only by `e2e/communication-plane.spec.ts:80+`); `InitiativeHeaderFrame.tsx:53,73,77`; `InitiativeSidePane.tsx:125` | `data-*` attributes exist only so specs can read an internal decision. | Assert on visible roles and text | L | S |
| A11 | stubbed sessions | 66 `page.route(` stubs in 18 specs | Browser "acceptance" that bypasses the real session path. | Keep stubs only in specs labelled as contract stubs | M | M |
| A12 | demo login | `mock/demo-director.ts:211` + `routes/mock-control.ts` | The director signs in as `u-nora`, and anyone on loopback can trigger it unless `MOCK_CONTROL_SECRET` is set. | Require the secret whenever a director route is used | L | S |

### Library hygiene (ui-components 2.427 to 2.436.4)

| id | file:line(s) | what | target | sev | eff |
|---|---|---|---|---|---|
| L1 | `PageSection.tsx:34`, `DetailSection.tsx:43`, `StatStrip.tsx:96`, `ActionRowList.tsx:151` (40px rows), `ChatSidePanelRegistry.tsx:77` (where `sm` is the *larger* option), `Table.tsx:16,27` + `DataTable.tsx:88` (44px rows, with its own `TableSizeContext`), `EmptyState.tsx:161` (alongside an existing `density` at `:163`) | Seven separate `size="sm"` props, each defining its own scale. Row heights disagree (40 vs 44). | R1 density system | H | L |
| L2 | `RichChatComposer.tsx:619` (`responsive="pane"`, plus an older `density` at `:548`), `ContextComposer.tsx:286`, `Tabs.tsx:87` (`overflowBelow`, unused), `SegmentedControl.tsx:73` (`iconOnly`), `InlinePopover.tsx:146` (`POPOVER_BOUNDARY_ATTR`) | Four container-responsiveness mechanisms. | CSS container queries keyed on one `@container pane` (R1) | M | M |
| L3 | `CallDock.tsx:145` (`tileSize`) vs `:309` (`compact`); `:159` `layout="stack"` (unused); `CallTileRow.tsx:100` `maxColumns` (unused) | Duplicate knobs and dead props. | R6 call block | M | S |
| L4 | `ConversationRail.tsx:174` (`shelfLayout`, `search`, `sections`, `sectionLayout`, `onSectionLayoutChange`); `ConversationShelf.tsx:68`; `HangoutRoomsSection.tsx:79`; `MasterDetail.tsx:43` (`paneFooter`) | Slots added one lane at a time. | R4 rail model / R3 pane model | M | M |
| L5 | `/compute` `LabInstructContext`, `useLabInstruct`, `runInstructionAsTasks`, `MOCK_TAIL_DEMO_SCRIPTS` (a demo fixture as public API); `RAIL_DMS_SECTION`, `RAIL_SECTION_GUTTER`, `arrangeRailSections` (the portal imports none of them) | App-specific or unused exports. | Move to the consumer, or delete | M | S |
| L6 | Two different commits both labelled 2.436.1 (`dd5e366f` off the chain, `541c2c85` on it); CHANGELOG 2.436.2 documents `dockTilesThatFit` (never exported); `wrappedDockItems` not in `video/index.ts:73`; 2.431.1-.3 composer patches and `HangoutRoomsSection` collapse ship without tests | Release hygiene. | Release-gate checks (J8) | M | S |
| L7 | Vocabularies: `full\|compact` (CallControls, DocumentToolbar), `default\|compact` (EmptyState, Disclosure, CollapsibleSection), `comfortable\|compact` (RichChatComposer). `src/styles.css` `@theme` has colour tokens only. | No density system exists. | R1 | H | L |
| L8 | Branch `release/2.437.0-header-density` exists at the 2.436.4 commit | The parallel header lane. See the conflict note in (b) step 2. | — | — | — |

### Tests, judges and docs

| id | where | what | target | sev | eff |
|---|---|---|---|---|---|
| T1 | ~19 local `signIn`/`login` helpers (e.g. `assessment-documents-parity.spec.ts:22`, `computer-lab-demo.spec.ts:60`, `distillation-demo.spec.ts:51`, `layout-cascade.spec.ts:138`, `section-landings.spec.ts:16`) vs the shared `e2e/realSession.ts:9` `loginAs` (35 users) | Duplicated helpers. | One `auth` fixture; ban local sign-ins | M | S |
| T2 | 55 `waitForTimeout` in 27 specs (`social-presence-burst` 6, `layout-cascade` 4) | Sleep-based specs are the known flakes. | `expect.poll` on state | M | M |
| T3 | 1,727 `data-testid`/`getByTestId` uses in 84 specs; 777 `data-testid` in portal source | Specs assert internals, so every refactor breaks specs that should not care. | Role and name locators; `testid` only on composite roots | M | L |
| T4 | Route inventories: `e2e/layout-inventory.ts`, `layout-cascade-baseline.ts`, `type-scale-baseline.json` (130 routes), `scripts/lib/nav-route-parity.cjs`, the route-coverage scanner (609), the mock-floor capture (767) | Six lists of the same routes. | One inventory generated from `App.tsx` | M | M |
| T5 | Seal logic in `scripts/journeys/seal-communication.sh` plus inline copies in five validators; 351 journey logs; 193 stale or unwalked at the close (54 orgiq, 33 assessment, 40 social, 22 pipelines, 6 distillation, 10 search, 4 branding, 24 communication) | Six seal implementations. 22% of today's touched files are log churn: every page edit stales a log, which a human then re-walks. | One `scripts/lib/journeys.sh`; logs only for flows, keyed to behaviour rather than page digests | H | M |
| T6 | `scripts/layout-drift-budget.txt` (`pxtype 399`, `stackedcell 22`, `cardstat 15`, `bigtext 4`, `glyphbutton 1`), `portal/e2e/type-scale-baseline.json` (674 entries), `raw-typography-budget.txt` (8). All are untracked and new today. | Ratchets minted on the day they were introduced. All current debt was recorded as passing, and since nothing at HEAD exists to diff against, there is no history showing whether they grew. | A burn-down schedule (J1) | H | S |
| T7 | `validate-rail-parity.sh` vs `layout-cascade.spec.ts`; the component-discipline drift section (`validate-component-discipline.sh:287`) vs `type-scale-sweep`, `admin-type-scale` and `app-type-scale` specs | Overlapping judges measuring the same geometry and type scale. | One layout judge and one type judge | M | M |
| T8 | `CLAUDE.md` at 1,103 lines (+575 today; the checkpoint is a changelog); `docs/audit-loop/runs/` (120 files, 2.3 MB, not ignored); strays `portal/src/pages/iq/iqSubNavCatalog.ts-E`, `iqSubNavFormat.ts-E` (left by `sed -i ''`), `portal/e2e/_tmp/shot.spec.ts`; `planeRailModel.test.ts:60,82,86` invent status `away` that the wire never sends | Sprawl and contract drift. | Checkpoint to a dated file; ignore `runs/`; delete strays; fix the fixture | M | S |
| T9 | 262 of 1,027 touched files (26%) have no lane | Nobody owns a quarter of the change. | A lane tag in every brief | M | S |

---

## (b) Refactor program, in order

Each step names one owner surface, the composite it consolidates onto, the files
it deletes, the judge change that stops a relapse, and what must be seen in the
browser.

**Step 0: freeze and hygiene (S, one lane).** No feature lanes while steps 1-4
run.
- Owner: the repo.
- Delete the strays (T8), ignore `docs/audit-loop/runs/`, and fix the `away`
  fixture.
- Add one e2e `auth` fixture and convert the ~19 local sign-ins (T1).
- Move the CLAUDE.md checkpoint narrative to `docs/checkpoints/2026-10-07.md`
  and leave a 20-line pointer.
- Judge: component-discipline refuses `*.ts-E` and `e2e/_tmp`; an e2e lint
  refuses a local `signIn`/`login` function.
- Browser: none.

**Step 1: library density system, release 2.437.0 (L, one library lane).**
See (d) R1.
- Owner: `ui-components` `shared/Density.tsx` and `styles.css` `@theme`.
- Consolidates: the seven `size="sm"` props (L1), the three vocabularies (L7),
  `TableSizeContext`, and EmptyState `size` and `density`.
- Portal: `<DensityProvider value="compact">` in `Layout.tsx`, then a codemod
  that removes `size="sm"`/`"xs"` wherever it equals the provider default
  (about 2,100 sites, H15).
- Judge: the type-scale baseline is frozen and must reach zero by 2.439 (J1).
  `size="sm"` on a component whose default already matches the provider is
  flagged.
- Browser: `/iq/projects/:id`, `/assessment/…/scorecard`, `/pipelines/runs/:id`,
  `/admin/observability/*` and `/social/channels` at 1680 and 1280. The
  type-scale sweep stays green with the baseline reduced, not raised.

**Step 2: header density, in the same 2.437 train (M).** See (d) R2.
- Owner: library `PageHeader`.
- Consolidates: `InitiativeHeaderFrame`, `SectionContent`'s `SectionHeader`,
  the Search two-row trail, the scorecard header, the pipelines run header's
  double title, the `EditorShell` head inset, and `ScopeHeader`'s title row.
- Deletes: `portal/src/pages/projects/InitiativeHeaderFrame.tsx`, the
  `useWideHeader` hook, and the `headerRhythm.ts` constants once the header
  owns the rhythm.
- Judge: J2 refuses a page-local `*Header*`/`*Frame*` file without a
  "Composed locally" row.
- Browser: initiative Overview/Work/Activity/Agents, scorecard Activity,
  pipelines run Activity and `/iq/search`. Measure that header height drops
  from ~300px to one row on canvas/conversation tabs, that the chevron is
  remembered across reloads, and that the description is reachable in the
  hover card by keyboard.

> **Conflict with the running header lane.** `release/2.437.0-header-density`
> exists and is being implemented now. Three conditions keep it from becoming
> vocabulary number four:
>
> 1. It must take its `comfortable | compact` value from R1's `Density`, not
>    define its own union. `collapsed` is a header *state*, not a density, so
>    model it as `collapse="auto" | "expanded" | "collapsed"`.
> 2. It must land in library `PageHeader`/`ScopeHeader`, not in
>    `InitiativeHeaderFrame.tsx`. If the lane is editing the portal frame,
>    stop it.
> 3. It must share the hover-card primitive (R5) for the description, rather
>    than a third hover timing.
>
> If the lane ships first, step 1 must adopt its type. Either order works; two
> unions do not.

**Step 3: pane and tab model, release 2.438 (L).** See (d) R3.
- Owner: library `SidePane` (built from `ContextColumn` + `ChatSidePanelFrame`)
  plus `PaneHeader`.
- Consolidates: `initiativePaneModel.ts` (tabs half), `conversationPaneModel.ts`,
  `shellPaneSignal.ts`, the HuddleChat split (`HuddleChat.tsx:466-547`), and the
  Search pane (`SearchPage.tsx:358-378`), all behind one URL contract,
  `?pane=<tab>&record=<kind:id>`.
- Retires: `?selection=` as pane state. Search keeps `selection` for graph
  picks only.
- Deletes: `conversationPaneModel.ts`, `shellPaneSignal.ts`, and the pane-tab
  half of `initiativePaneModel.ts`. Money moves to the server (H11) and log
  rows to `LogLines`.
- Judge: a unit test that every pane host uses `SidePane`; a grep ban on
  `localStorage` keys ending in `.pane.*` outside the library.
- Browser: initiative Discussion/Details/Docs/Log, work item, search Ask about
  selection, scorecard dimension, document. Check the ratio is remembered, the
  pane opens from deep links, the graph keeps ≥55% width, and there is only one
  composer on screen.

**Step 4: rail model and fold, release 2.438 (L).** See (d) R4.
- Owner: library `SubNavLayout collapsed`, `ListRailLayout` (the upstreamed
  `SectionListLayout`), and `ConversationRail` `sections` as data.
- Deletes: `app.css:672-699`, `railCollapseModel.ts` (depth comes from route
  metadata), `useShellRails.ts`, `SectionContent.tsx:96-143`, and most of
  `planeRailModel.ts` (rows, unread, filter and keys move to the library
  section builder).
- Plane and Social share one section builder.
- Judge: CSS lint refuses `!important` and `[data-testid` selectors in
  `app.css`; rail-parity measures the strip from the library's own collapsed
  state.
- Browser: the 127-route cascade sweep at 1680/1280/1100/760; the initiative
  work item at depth 3; `/iq/communication`; `/social/dms` (still unconfirmed
  today).

**Step 5: server consolidation (M each, middleware lane, Opus for the authority
parts).**
- (a) `socialGate` unifies D1 and removes the WeakSet. A1, A2 and A5 are fixed
  in the same change.
- (b) `GET /api/me/groups` (D4) replaces three portal readers. The assessment
  team link moves off display names.
- (c) `lib/people-directory.ts` (D5).
- (d) Batch routes for H12, and a maintenance-floor field for H11.
- (e) Move `unreadFor` out of `mock/`, fix `plane-active`'s mock visibility
  (D7, D8), and add `sessionForUser` (D10).
- Deletes: about 300 lines of portal normalizers, the duplicate avatar code,
  and three synthetic sessions.
- Judge: J6 (no `mock/` imports from `lib/` or `routes/`); the
  communication-plane authority test gains a same-data-same-answer case across
  `/social/*` and `/social/plane/*`.
- Browser: Communication as `u-theo` (granted) and `u-hr` (no grant);
  revoke-then-read within 120s on both mounts.

**Step 6: split the gateway (M).** D12 into six modules, with no behaviour
change. Judge: a per-file line cap of 400 under `lib/`. Browser: huddle start,
DM send and cursors as a smoke test.

**Step 7: one page thread (L, needs a user decision and Aurora).** D2: project
`work_item_comments` and `assessment_knowledge_comments` into their chat
channels, retire the REST writes, and fix the bell link
(`social-notify.ts:483`). Browser: an old comment appears in the thread, a new
message reaches the bell, and the unread divider is correct.

**Step 8: shared-work model (L).** D6 to share edges. Two portal views remain,
fed by one route.

**Step 9: composers (M).** NEW `PageComposer` (H8). Deletes
`DimensionComposer.tsx`, `ScopeDiscussion.tsx` and `SummarizableChatPanel.tsx`.
`InitiativeComposer` shrinks to configuration.

**Step 10: judges and logs (M).**
- J1-J8 below.
- Merge rail-parity with layout-cascade, and component-discipline drift with
  the type sweeps (T7).
- Build one route inventory (T4) and one seal library (T5).
- Re-key journey logs to flows, so a CSS edit no longer stales 193 logs.

### Judge changes referenced above

- **J1:** every baseline file carries a target and a date, and the validator
  fails when the count is above the scheduled line. Ratchets go down on a
  schedule, not merely "never up".
- **J2:** a new file named `*Frame|*Header|*Pane|*Rail|*Composer|*Layout`
  under `portal/src/pages` needs a "Composed locally in" queue row.
- **J3:** ban `altKey` handlers that change destination.
- **J4:** ban `.filter(` on role, tenant or grant fields in `portal/src`
  outside `lib/auth.tsx`.
- **J5:** ban `fetch(` inside `.map(`.
- **J6:** ban `from '../mock/` in `middleware/src/{lib,routes}`.
- **J7:** ban `!important` and `[data-testid` in `app.css`.
- **J8:** the library release gate refuses a duplicate version, a CHANGELOG
  symbol missing from the barrel, a new prop without a test, or a new export
  with no consumer.

---

## (c) Stop doing (put this in every brief)

1. **No local `*Frame.tsx`, `*Header*` or `*Pane*` composite without a
   "Composed locally in" queue row.** If the library lacks it, the lane ships
   it upstream first.
2. **No per-lane size, density or responsive prop.** A lane that needs
   "smaller" uses the density system. If the system cannot express it, change
   the system, once, in the library.
3. **No baseline that is minted at today's count.** Every new ratchet ships
   with a burn-down date. "Never up" is not a plan.
4. **No Alt-click, long-press or other hidden-modifier affordances.** Every
   action is visible and reachable by keyboard.
5. **No client-side authority.** The portal does not filter server lists by
   role, tenant or grant, does not copy server regexes, and does not pick
   `grants.x?.[0]`. Ask `can()` or the server.
6. **No `?? true` on any permission prop.** Missing means no.
7. **No `fetch` fan-out per row.** If a page needs N records, the server
   offers one route.
8. **No production imports from `mock/`.** No mock that grants wider
   visibility than the real backend.
9. **No `data-*` attribute added only for a spec.** Assert what a user sees.
10. **No local `signIn` in specs, and no `waitForTimeout`.**
11. **No new page-local pane, rail or URL-param model.** Use the pane and rail
    contracts.
12. **No library releases one lane at a time.** Batch per train (see (d)),
    branch from the current pin, one version number per commit.
13. **No checkpoint narrative in `CLAUDE.md`.** Write dated files.
14. **No lane without an owner tag.** 26% unattributed is not acceptable.
15. **No `!important` or test-id selectors in `app.css`.**

---

## (d) Library roadmap, 2.437+ as one plan

The roadmap is three trains, each one release branch with one CHANGELOG
section. Every train ends with a consumer codemod and a deletion list in the
portal.

**Train A, 2.437: density and header**

- **R1, density system.**
  - `type Density = 'comfortable' | 'compact'`, with `<DensityProvider>` and
    `useDensity()`.
  - CSS variables on `@theme`: `--ui-row-h` (44/36), `--ui-type-body`
    (14/14), `--ui-type-meta` (12/12), `--ui-type-heading` (14/600),
    `--ui-type-title` (20/600), `--ui-gap-*`, `--ui-control-h` (32/26).
  - Every Group A component (`PageSection`, `DetailSection`, `StatStrip`,
    `ActionRowList`, `Table`/`DataTable`, `ChatSidePanelFrame`, `EmptyState`,
    `Button`, `IconButton`, `Chip`, `T`) reads these. The per-component `size`
    stays one minor release as a deprecated override, and is then removed.
  - Responsiveness comes from container queries on a `@container pane` that
    `SidePane` and `ConversationSurface` declare. That replaces
    `responsive="pane"`, `overflowBelow`, `iconOnly` and the popover boundary
    attribute (L2).
  - `useMeasuredWidth` is exported for the rare imperative case (H10).
- **R2, header density.** One `PageHeader` with slots `trail`, `title`,
  `status`, `meta`, `people` (an `AvatarGroup`), `actions`, `tabs`:
  - `density` comes from R1. Comfortable is the full stack; compact is one row
    of title + status + owner avatars + actions, with the description and SMEs
    in a `HoverCard` on the title's info control.
  - `collapse="auto" | "expanded" | "collapsed"`. `auto` collapses on scroll
    past the tabs, or when `contentKind="graph" | "canvas" | "conversation"`.
    A manual chevron is remembered per device under one library key per
    `headerId`.
  - Actions fold into `⋯` by container width, which replaces the 760px
    ResizeObserver rule.
  - `ScopeHeader` becomes a thin preset over it. `DetailHeader` is the h2
    form.
  - Absorbs H2, H3 and the queue's `ScopeHeader` 20px row.
- **R5, HoverCard.** Non-modal, non-trapping, with one timing (open 300ms,
  close 250ms), Escape, a pin-on-click, and keyboard reachability. Used by R2,
  `PersonHoverCard` and the initiative Details card (H9).
- **EmptyState scale.** Comes from R1; the separate `size` and `density`
  props are deleted.

**Train B, 2.438: pane, tab and rail models**

- **R3, `SidePane` + `PaneHeader`.**
  - Props: `tabs: {id,label,badge?}[]`, `record?: {kind,id}`,
    `urlKey='pane'` (with a typed `parse` and `serialize`), and a persisted
    `ratio` within min/max bounds.
  - `useSidePane()` publishes `open` so the shell can read it without a global.
  - `MasterDetail` `paneFooter` and `ChatSidePanelFrame` become this.
  - The composer dock is a slot (`footer`), so "one composer on screen" is
    structural rather than enforced by tests.
- **R4, rail model.**
  - `SubNavLayout collapsed`/`onToggleCollapsed` with the 44px strip.
  - `useRailFold(band)` with one storage convention.
  - `ListRailLayout` (the upstreamed `SectionListLayout`: `ExplorerLayout` +
    caption + count + search + filter popover + `GroupedList currentStyle="bar"`).
  - `ConversationRail` `sections` as data with a shared section builder (rows,
    unread, filter, keys). Plane and Social pass data, not JSX.
  - `shelfLayout`, `sectionLayout` and the `RAIL_*` constants collapse into
    this API (L4, L5).
- **`RouterLink`/`isPlainClick`** (H16).

**Train C, 2.439: composer and call block**

- **`PageComposer`.** `ContextComposer` with `target` (To), `references`
  (page chips), `statusLines`, `commands` (`/deck`, `/doc`, `/agent`),
  `readOnlyReason`, and `maySend` (required, with no default) (H8, A5).
- **R6, call block.** One `CallBlock` that owns `HuddleBar` + `CallTileRow` +
  ringing placeholders + overflow:
  - `placement="composer" | "pane" | "page" | "footer"` replaces
    `callMediaLayout`, `tileSize`, `compact`, `layout="stack" | "grid"` and
    `maxColumns`.
  - Tile size comes from container width and density.
  - Unused props are removed (L3).
  - The portal's `callShellModel.ts:99-170` placement logic is deleted.
- **Cleanup.** The Computer Lab demo exports (`MOCK_TAIL_DEMO_SCRIPTS`,
  `LabInstructContext`) move to a `/compute/demo` subpath or into the
  consumer.

**Release rules for all three trains.** One branch per train, cut from the
current pin. The version is bumped once per merged train, never per lane. The
J8 gate applies. The consumer installs the new pin once per train, and nobody
edits an import before that install.

---

## (e) How much of today's code should survive

Roughly 42,000 lines of code and specs were added or changed.

| Bucket | Lines today (approx.) | Survives as written | Survives after moving or reshaping | Should be deleted |
|---|---|---|---|---|
| Middleware authority and data (plane routes, cursors, unread, call logs, avatars, sharing) | ~10,700 | 45% | 35%: into `socialGate`, `me/groups`, `people-directory` and share edges | 20%: duplicate rosters and avatars, the WeakSet, synthetic sessions, mock-in-lib |
| Portal pages and shell (headers, panes, rails, composers, Communication) | ~13,900 | 30% | 35%: the logic of the pane, rail and composer models moves into library composites | 35%: `InitiativeHeaderFrame`, `conversationPaneModel`, `shellPaneSignal`, `railCollapseModel`, `app.css:672-699`, normalizers, the `DimensionComposer` copy, N+1 hooks, ~2,100 redundant size props |
| Library 2.427 to 2.436.4 | 22 releases | 50%: the behaviour (ringing tiles, the composer one-row, Table numeric) | 30%: the props folded into density, pane, rail and call | 20%: unused props and app exports |
| Tests and specs | ~15,200 | 55% | 30%: rewritten on one auth fixture and role locators | 15%: `data-testid` internals, sleeps, stub-only "acceptance" |
| Journey logs, acceptance records, CLAUDE.md narrative | 230 logs + ~700 doc lines | — | — | Most of it has no lasting value; the logs restale on the next edit |

**Bottom line.** About a third of today's code is right where it is. About a
third is the right idea in the wrong place, and should move into the library or
behind one server module. About a third should not exist. The behaviour the
user asked for (rail folding, one-row titles, pane-hosted discussion, huddle
tiles, the Communication plane) is mostly worth keeping.

The way it was built is not worth keeping: per-lane props, local frames,
duplicated authority and baselines that bless the debt. If the program above
runs in order, the portal should end up roughly 6,000 to 8,000 lines smaller,
with each of these concepts living in one place: header, pane, rail, composer,
call block, density, social authority, "mine" and "shared work".
