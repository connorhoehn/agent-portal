# Member-role defects — org tenant

Found auditing u-theo (member) against `docs/orgiq-journeys/MATRIX.txt`. Repro
steps assume signed in as Theo Chang / member at 1552px, `middleware dev:mock`.

## Open

#13 and #14 were both re-audited on 2026-09-07 and closed — see the Closed
section. Nothing is open for this role right now.

## Closed

13. ~~A failed turn that started from a starter card shows a Retry button that
    does nothing.~~ **Closed 2026-09-07 16:29** — every send path now goes
    through one `send()` and records the turn, so `handleRetry`
    (`portal/src/pages/InvokePage.tsx:391`) always has text to resend; the
    comment at line 367 now reads "Every path that sends a turn goes through
    this, so `lastTurnRef` is set". Re-observed as u-theo at 1560×893 with the
    first `POST /api/agents/orgiq-supervisor/invoke` forced to 503
    `{"error":"authorization unavailable"}` by a one-shot in-page `window.fetch`
    shim, on both non-composer paths: (a) the "Strategic question" starter —
    failed send = **1** invoke call, click Retry = **2**, `role=alert` banner
    gone, reply streamed, transcript holds exactly **one** YOU turn; (b) the
    FROM YOUR WORK card, sent with a physical Return — failed send = **1**,
    Retry = **2**, banner gone, one YOU bubble ("I'm about to start "Breaking
    prop rename slipped past the semver gate" on Design System API…"). The
    lingering-bubble collapse (`collapseFailedTurn`, line 484) is fed by the
    same ref and is therefore live on those turns too. Confirmed the same way
    for sme (#12) and program-owner (#21).

14. ~~The one member's work board is empty against a seed that gives it an open
    bug.~~ **Closed 2026-09-07 16:29** — the no-Aurora fixture now mirrors the
    seed in full. `middleware/src/providers/work-items.ts` carries **81 `wi-*`
    items across all 14 seeded initiatives** (p-zero-trust, p-llm-platform,
    p-inference-platform, p-rag-search, p-mobile-redesign, p-observability,
    p-auth-migration, p-cost-opt, p-realtime-analytics, p-data-lake,
    p-feature-store, p-design-v3, p-soc2, **p-design-system-api**) against
    `schema/seed_program.sql`'s 81 `wi-*` ids — item-for-item parity, where it
    used to be 45 items across 7 initiatives. The p-design-system-api block is
    at `work-items.ts:814` with the epic `wi-dsapi-e1` and its three children.
    Re-observed as u-theo: /iq/invoke renders a FROM YOUR WORK strip with one
    card, "Next up in this sprint / Who has context on "Breaking prop rename
    slipped past the semver gate"? / Design System API" — his own initiative's
    open high-priority bug (`wi-dsapi-e1-b3`, `seed_program.sql:369`). The
    strip is no longer suppressed and the panel title no longer falls back to
    the canned "Try asking:" set alone.

1. ~~Table rows are mouse-only across four different pages.~~ (Initiatives
   List view, Library, Promotions, Designs — `<tr onclick tabIndex=-1>` with
   no focusable descendant.) **Closed 2026-09-05 20:59** — re-observed on all
   four as member: Initiatives List rows carry a real `<a
   href="/iq/projects/:id">` (Tab from Sort → row → Return opened the
   initiative), Library and Promotions rows carry a real `<button>` (Return
   opened the drawer, Escape closed it and returned focus to the row), Designs
   rows carry a real `<a href="/iq/designs/:id">` (Return opened the thread).

2. ~~Status filter buttons are dead on three pages.~~ (Promotions, Designs,
   Automate → Findings.) **Closed 2026-09-05 21:02** — re-observed: Designs
   "Ideating" narrowed 3 → 1 and "Awaiting sign-off" showed the empty panel
   with the pill pressed; Promotions "Candidates" 4 → 3, "Promoted" → 1,
   "Dismissed" → "Nothing dismissed right now."; Findings promoted / resolved /
   dismissed each swapped to their own group with `aria-pressed` following.

3. ~~A gated write action fails with zero user feedback.~~ (Promotions drawer
   Approve → silent 403.) **Closed 2026-09-05 20:59** — re-observed: the
   candidate drawer renders no Approve / "Approve + record a passing dry run" /
   Dismiss button for member (zero `<button>`s inside the dialog) and says
   "Promoting or dismissing a candidate needs Manage bots." under the next-step
   line.

4. ~~Prompt Studio has no role guard and leaks a raw backend error.~~
   **Closed 2026-09-05 18:22 — re-verified.** `/iq/prompts`, `/iq/history`,
   `/iq/diff`, `/iq/evaluations` now carry `RequireRole
   roles={['org-leader','hr-admin']}` in `portal/src/App.tsx`; re-tested as
   member, `/iq/prompts` now redirects to `/iq/projects` (confirmed via
   `location.pathname` after navigation) instead of rendering the editor.
   Re-confirmed 2026-09-05 20:50 (/iq/prompts and /iq/canary both →
   /iq/projects). The Library rail residual it mentioned is now filed as #10.
   Original repro: as member, navigate to `/iq/prompts` directly.

5. ~~Ask's session list never reflects the active conversation.~~
   **Closed 2026-09-05 20:46** — re-observed: the moment the first turn was
   sent, the SESSIONS rail listed "Who knows the most about Kubernetes? ·
   9/5/2026, 8:45:58 PM" with `aria-current="page"`; after a reload the row
   survives as "Untitled session" and the transcript slot explains the mock
   has no memory store to read turns back from.

6. ~~Explore's search box fails silently on no match.~~ **Closed 2026-09-05
   20:47** — re-observed: typing "zzznoexistperson" opens the dropdown slot
   with "No matches for "zzznoexistperson" / Try a different name, title,
   department, or skill." and a working "Clear search" button.

7. ~~Two visible entry points dead-end a member at a gated route with no
   explanation.~~ (Automate Overview "Computer Lab" link; ⌘K "Recent runs".)
   **Closed 2026-09-05 21:03** — re-observed: "Computer Lab" on Automate
   Overview is a plain `<span>` with no href for member; ⌘K shows no RECENT
   RUNS group (18 rows, none a harness run), and
   /admin/observability/harness/runs/nightly-2026-08-24 typed directly
   redirects to /iq/projects.

8. ~~Palette lists Scores despite no role gate on the entry.~~ **Closed
   2026-09-05 20:56** — re-observed: ⌘K as member lists no Scores / Score
   cohorts / Score compare row; /iq/scores and /iq/scores/cohorts typed
   directly render the "Leaderboard access needed" explanation.

9. ~~Findings' empty state points at a control that doesn't exist.~~
   **Closed 2026-09-05 21:02** — re-observed: the "run them now above" copy is
   gone from the page for member; with four open findings seeded this session
   the "open" empty panel itself does not render, and no run-sweeps control or
   reference to one exists anywhere on the page for this role.

10. **The Library rail's "What is deployed" is a page of links that bounce a
    member.** The nested Prompt Management rail no longer lists Studio /
    Versions / Evals / Rollout for member (the #4 residual is gone), but its
    second entry, "What is deployed" (`/iq/prompt-ops`,
    `portal/src/pages/iq/`), renders for member and carries eleven links to
    `/iq/prompts` (Prompt Studio →, Test a prompt →, Open Prompt Studio →,
    six "live · agent" rows) plus "Start a canary →" to `/iq/canary` — every
    one of which redirects a member to /iq/projects. The same page is reachable
    from ⌘K as "Prompt Ops". Either gate the rail entry / palette row / route
    to the platform roles like its targets, or render the page for member
    without the calls to action. (Filed 2026-09-05 20:49; the earlier text of
    item 4 refers to this as "#10".)
    Repro: as member, Library → "What is deployed" → click any "→" link →
    bounced to Initiatives.
    **Closed 2026-09-06 10:52** — re-observed as u-theo: the Library's nested Prompt Management rail now lists only "Library" (one `<a href="/iq/library">`, no "What is deployed"); a direct `/iq/prompt-ops` and a direct `/iq/prompts` both land on /iq/projects with no flash of the gated page, so no member-reachable page links to a route that bounces the role.

11. **Library's "Run evals" is live for a role that only gets "Forbidden".**
    In the asset drawer (`portal/src/pages/library/AssetEvals.tsx`) the
    "Run evals" button is enabled for any asset with eval cases — for member
    on "CSRF risk evaluator" (3 cases) it fires
    `POST /api/library/evals/lib-csrf-check/run`, which
    `middleware/src/routes/prompt-evals.ts` gates on `ManageBots`, so it 403s
    and the only feedback is a toast "Eval run failed / Forbidden" — no
    capability, no role, no next step — while the LATEST RUN copy directly
    above it still tells the member to "run the suite". Session config and the
    Promotions drawer (#3) show the pattern to copy: hide the button and say
    "needs Manage bots".
    Repro: Library → "CSRF risk evaluator" → Run evals → toast "Forbidden".
    **Closed 2026-09-06 10:52** — re-observed as u-theo: Return on the "CSRF risk evaluator" row opens the asset drawer with zero buttons matching /run/ and the LATEST RUN section reads "Running evals needs Manage bots." in the slot the button used to fill; no `POST /api/library/evals/…/run` can be fired from this role's drawer.

12. **A design thread tells a member to answer a question it gives them no
    way to answer.** On `/iq/designs/des-auth-rotation`
    (`portal/src/pages/designs/DesignThreadPage.tsx`) the summary card's
    next-step line reads "👉 Answer the open question below — the agents
    continue from your answer." (`designFormat.ts` `nextStep`) and the question
    post is badged "needs a human", but the answer control is only mounted when
    `can('DispatchAgentRun')` — member has no button, no textarea and no
    explanation of who can answer. Same dead-reference shape as #9.
    Repro: Designs → "Session token rotation on tenant switch" → read the 👉
    line, look for anywhere to type.
    **Closed 2026-09-06 10:53** — re-observed as u-theo on /iq/designs/des-auth-rotation: the summary card's next-step line now reads "👉 An owner or SME will answer the open question below." and the page still has no button, input or textarea for member — the copy no longer names a control the role does not have.


## Fixed (pending re-audit) — coordinator, 2026-09-05 18:20

- RAIL: `/iq/prompts`, `/iq/history`, `/iq/diff`, `/iq/evaluations` now wear
  `RequireRole ['org-leader','hr-admin']` in `App.tsx` (same guard as the
  Architecture routes) — a member typing the URL lands on home instead of
  Prompt Studio. The Library's link to it is being gated in `library/`.
- #8: Scores / Score cohorts / Score compare palette entries now carry
  `roles: PLATFORM` in `portalCommands.ts`, so a member's ⌘K no longer lists
  them.
- #7 (palette half): the "Recent runs" harness fetch and group are now gated
  on the platform roles (org-leader, hr-admin, admin) — a member never sees
  run rows that would bounce them. The Automate "Computer Lab" link half is
  with the `work/` fix agent.
- library.md (Prompt Management rail): Studio / Versions / Evals / Rollout are
  now filtered out of the nested rail for non-platform roles
  (`iq/iqSubNavCatalog.ts`, same pattern as `work/automateNav.tsx`); `/iq/canary`
  wears the platform RequireRole and the palette's Canary entry carries
  `roles: PLATFORM`, matching Studio/History/Diff/Evaluations.
- #1 (initiatives.md, List view half): `projects/ProjectTable.tsx`'s name cell
  now renders a real `<Link to={/iq/projects/:id}>` (stopping propagation so
  the row's mouse-click convenience still works) instead of relying only on
  `onRowClick` — Tab from the Sort control now reaches the row and Enter opens
  it. Applied the same fix to `designs/DesignsPage.tsx` (Link) and
  `promotions/PromotionsPage.tsx` / `sprints/SprintTable.tsx` (Button, since
  those open a drawer rather than navigating) while in those files for the
  other two defects below — same underlying `DataTable` onRowClick-only gap
  noted in `docs/ui-components-queue.md`. Library's occurrence is with
  whichever agent owns `library/`.
- #2 (designs.md, promotions.md): the Status filter row on both pages now
  runs through a new pure predicate — `filterDesigns` (`designs/designFormat.ts`)
  and `filterPromotions` (`promotions/promotionFormat.ts`) — wired via
  `useMemo`, each covered by a `node:test` case (`'all'` keeps everything, any
  other value narrows to an exact status match). Promotions also switched from
  a per-click `?status=` server round trip to fetching once and filtering
  client-side, so a click can never silently no-op on a slow/aborted refetch.
- #3 (promotions.md): `PromotionsPage.tsx`'s `CandidateDrawer` now reads
  `ManageBots` via `useCapabilities()` (the same gate
  `middleware/src/routes/promotions.ts` enforces on `/promote` and
  `/dismiss`) and hides the Approve / "Approve + record a passing dry run" /
  Dismiss buttons for anyone without it, showing "Promoting or dismissing a
  candidate needs Manage bots." instead — matching Session config's pattern.
  The existing `toastError` on a non-2xx response already surfaces the
  server's `{error}` body (`Forbidden` for a 403), so a caller who somehow
  still reaches the buttons (a stale capability cache) sees a toast rather
  than silence.

## Fixed (pending re-audit) — work/library agent, 2026-09-05

- #7 (Automate half): the inline "Computer Lab" mention on Automate Overview
  (`portal/src/pages/work/WorkHomePage.tsx`) is a live `<Link to="/admin/devbox">`
  only when the session role is one of `hr-admin`/`sme`/`program-owner`/
  `org-leader`/`admin` (`DEVBOX_ROLES`, new export in
  `portal/src/pages/work/automateNav.tsx`, mirroring the `/admin/devbox`
  `RequireRole` list in `App.tsx` and the existing `BOTS_ROLES`/`CHANGES_ROLES`
  pattern in the same file). A member now sees plain, non-clickable text.
- automate-findings.md #2 (status filter) and #9 (empty-state dead reference):
  `portal/src/pages/work/FindingsPage.tsx` now runs the fetched findings
  through a new pure `filterFindings(findings, status)`
  (`portal/src/pages/work/findingsFilter.ts`, tests in
  `portal/src/pages/work/__tests__/findingsFilter.test.ts`) so the rendered
  rows can never disagree with the pressed status pill, including a fetch
  that resolves after a fast filter click. The "open" empty state's copy is
  now conditional: `canManage` roles see "Nothing open. Sweeps run every 6
  hours, or run one now." with a real "Run sweeps now" `EmptyState` action
  wired to the same `runSweeps()` the page header button calls; every other
  role sees "Nothing open. Sweeps run automatically every 6 hours." with no
  reference to a control they can't see.
- automate.md notes (soft): the Overview page's description promises
  "anything ... waits below for a person," but when there are no pending
  consults, no jobs awaiting review, and no pending graph proposals, nothing
  rendered below it. Added an explicit `EmptyState` ("Nothing needs your
  attention right now") for that all-clear case so the copy and the blank
  space agree (`portal/src/pages/work/WorkHomePage.tsx`).
- library.md (row keyboard access): verified, not changed — `LibraryPage.tsx`'s
  asset-name cell already renders a real `Button` (Enter/Space-activatable,
  `stopPropagation`d so it doesn't double-fire the row's own `onRowClick`),
  and the row click still opens the same drawer via `DataTable`'s
  `onRowClick`. No code change needed; this closes DEFECTS #1's Library
  instance and the "asset rows are mouse-only" half of library.md.
- Verified clean, no defects filed against `work/`/`library/` beyond the
  above: `npx tsc --noEmit` passes; `node --test 'src/pages/**/__tests__/*.test.ts'`
  is 33/33; `npx vite build` succeeds; the raw-element grep over
  `portal/src/pages/work` and `portal/src/pages/library` returns exactly 1
  hit — the pre-existing, already-queued `ActivityScroll` `<div>` in
  `portal/src/pages/work/ActivityFrame.tsx` (documented in
  `docs/ui-components-queue.md`, needs a `ref`-forwarding `Stack`/`Card` or a
  `ScrollRegion` composite upstream before it can go away).

## Fixed (pending re-audit) — root pages agent, 2026-09-05

- #5 (Ask's session list never reflects the active conversation):
  `portal/src/pages/InvokePage.tsx` no longer depends solely on
  `GET /api/sessions` to know a conversation exists — that list is backed by
  AgentCore Memory (or the no-Aurora mock) and can lag or, with no memory
  store configured, never populate. A new `localSessions` map is written
  whenever `useAgentStream` mints or resumes a `sessionId`, titled from the
  first user turn, and merged over the server list in the `sessions` memo.
  The row (and its `aria-current="page"`, already present on the row button)
  now appears in the rail the moment a conversation starts, not after a poll
  that may never come. No wire contract changed — this is client-side
  bookkeeping only.
- #6 (Explore's search box fails silently on no match):
  `portal/src/components/org-graph/GraphSearchBox.tsx` only ever opened its
  dropdown when `totalRows > 0`, so a query with zero matches rendered
  nothing. It now opens on any non-empty query: the results `listbox` when
  there are rows, or a new `EmptyState` ("No matches for "<query>"" + a
  "Clear search" action that resets the box) in the same slot when there are
  none.
- Verified: `npx tsc --noEmit` passes for both files; root-page raw-element /
  `style={{}}` / `<button>` counts for `InvokePage.tsx` are all 0 (down from
  44 `style={{}}`/`<button>` occurrences).


## Fixed (pending re-audit) — coordinator, 2026-09-05 21:30

- #10 (route + palette halves): `/iq/prompt-ops` now wears the platform
  `RequireRole ['org-leader','hr-admin']` in `App.tsx` (redirect to
  `/iq/projects`), and the palette's "Prompt Ops" entry carries
  `roles: PLATFORM` in `portalCommands.ts`, matching Studio / History /
  Diff / Evaluations / Canary. The Library rail half is with the
  iq/library/designs agent.

## Fixed (pending re-audit) — portal agent (iq/library/designs), 2026-09-05 22:10

- #10 (rail + page halves): `portal/src/pages/iq/iqSubNavCatalog.ts` moved
  "What is deployed" (`/iq/prompt-ops`) out of the `Browse` group and into a
  new `Ops` group that `PROMPT_MGMT_PLATFORM_GROUPS` filters alongside
  `Author`/`Ship`, so a member's Library rail now shows only `Library`. The
  item list + filter were pulled into a new pure module,
  `portal/src/pages/iq/iqSubNavFormat.ts` (`promptMgmtItemsFor`), so the gate
  is unit-tested independent of the React hooks the catalog file pulls in —
  `portal/src/pages/iq/__tests__/iqSubNavCatalog.test.ts` asserts member sees
  only `/iq/library` and org-leader sees all six items. Separately,
  `PromptOpsHomePage.tsx` now checks the viewer's role itself (same
  org-leader/hr-admin/admin test the rail uses) and renders an explained
  "This is a platform surface" `EmptyState` — with a link to `/iq/library` —
  instead of its guided-path CTAs and full library listing, for anyone who
  reaches the URL directly (⌘K, a bookmark, or ahead of the route guard's
  session fetch resolving). This matters because member deliberately holds
  `ViewObservability` as an all-hands read (`member.cedar`), so the page's
  data loads fine for member and the existing `libraryError` branch never
  fires — the bouncing-links defect was real for any member with a link, not
  just a `RequireRole` race.
- #11: `portal/src/pages/library/AssetEvals.tsx` now gates the "Run evals"
  button on `useCapabilities().can('ManageBots')` — the same capability
  `middleware/src/routes/prompt-evals.ts` requires on `POST .../run`. Without
  it, the button is replaced by "Running evals needs Manage bots." in the
  same slot (`DetailSection actions`), matching the Promotions drawer's
  pattern (#3). A 403 that still reaches the client (stale capability cache)
  now throws `"${body.error} — Run evals needs ${body.action}."` instead of
  a bare `body.error`, so the toast names the action and the missing
  capability rather than just "Forbidden".
- #12: `portal/src/pages/designs/designFormat.ts` `nextStep()` takes a new
  `canAnswer` parameter (default `true`, so existing callers are unaffected
  until they pass it) — when `awaiting_input` and `canAnswer` is false, it
  returns "An owner or SME will answer the N open question(s) below."
  instead of "Answer the open question(s) below — the agents continue from
  your answer." `portal/src/pages/designs/DesignThreadPage.tsx` now passes
  `canSteer` (`can('DispatchAgentRun')`, the same capability that mounts the
  answer control) into the call, so the 👉 next-step line never tells a
  viewer to use a control that isn't on the page for them. Every other
  status's wording is unchanged by `canAnswer` (asserted in the new test).
  Node tests added to `portal/src/pages/designs/__tests__/designFormat.test.ts`
  covering both branches plus the "other statuses ignore canAnswer"
  invariant.
- Verified: `npx tsc --noEmit` clean; `node --test 'src/**/__tests__/*.test.ts'`
  540/540 passing (2 new files: `iq/__tests__/iqSubNavCatalog.test.ts`,
  additions to `designs/__tests__/designFormat.test.ts`); `npx vite build`
  succeeds; `bash scripts/validate-orgiq-audit.sh --quick` component
  discipline block all ✓ (0 raw styled elements, 0 JSX `style=`, no native
  form controls, no raw `<button>`).


## Fixed (pending re-audit) — coordinator, 2026-09-07 14:45

- #13 (Retry dead for non-composer turns): `lastTurnRef` was set in exactly
  one place — the composer's submit handler — so Retry after a work card, a
  starter, a `?prompt=` deep link or an "Ask about them" chip fired no
  request, and `collapseFailedTurn` was inert on those turns for the same
  reason. Every path now goes through one `send()` in `InvokePage.tsx` that
  sets the ref, clears the retried flag and streams; the call sites no longer
  each have to remember.

## Fixed (pending re-audit) — initiative-page session, 2026-09-24

- **Design detail had no real page title.** `/iq/designs/:id` rendered
  `PageSection title=""` — an empty `<h1>` at the title position — with the
  thread's name as an 18px/400 `<h2>` inside a DetailHeader 58px below the
  breadcrumb trail, so the page failed the shell's 16px / 20px-600 title
  rhythm and a screen reader found an empty top heading. Found while choosing
  a detail page for the branding rhythm. Fix: the thread title is the
  PageSection title; the status chip and meta line sit in an Inline under it
  (`portal/src/pages/designs/DesignThreadPage.tsx`). Re-measured: one `<h1>`,
  16px under the trail, 20px/600.

