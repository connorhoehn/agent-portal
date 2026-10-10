# program-owner defects

Role: program-owner, user u-mia (Mia Singh, p-030, owner of Mobile App
Redesign). Audited 2026-09-05 19:40–20:36 local against the dev:mock
middleware at 1552px; re-audited 2026-09-05 21:47–22:55 (this file's Closed
section records what was observed after each fix). Items marked "reproduces <role> #N" are already filed
under that role and are listed here because they reproduce for this role.

## Open

#21 and #22 were both re-audited on 2026-09-07 and closed — see the Closed
section. #23–#27 were found on the 2026-10-01 09:27 headless re-walk
(Chromium 1680x940, Playwright, dev:mock on :3043/:5243, signed in as u-mia).

## Closed

29. ~~Computer Lab's computer list says "Nothing matches." when nothing is
    shared, with no filter typed.~~ Repro: u-mia (program-owner),
    `/admin/devbox`: the notice reads "You can see the fleet but not drive
    it", the status strip is 0 / 0 / 0, the pane says "No computers in the lab /
    Nothing in the fleet is shared with you yet." — and the list rail under the
    empty "Find computer or agent…" box says "Nothing matches." as if a search
    had failed. Suspect `portal/src/pages/admin/DevboxPage.tsx` (the list's
    empty copy does not distinguish an empty fleet from an empty filter).

    *Closed 2026-10-06 15:05 (ui-components 2.419.0, headless Chromium 1680x940, u-mia, devbox-boxes/agent-fleet/compute-nodes on the empty scenario, then reset): the list rail now reads "No computers in the lab / Nothing in the fleet is shared with you yet."; no "Nothing matches." node exists with no filter typed.*

30. ~~Search › Connections (`/iq/explore` lands here): a mouse cannot click or hover a node on the all-types graph.~~ **Closed 2026-10-06 12:50** — re-observed with real mouse clicks (Playwright click() and hover; ui-components 2.418.0): the record graph node buttons compute pointer-events auto, elementFromPoint over a node returns the node, and a click took the graph from 53–55 to 15 nodes ("1 selected", zoom 54% to 97%); a second click made "2 selected".

31. ~~People org graph: after two or three picks the drawing sits on the 40% zoom floor with unreadable captions and can run under the detail card.~~ **Closed 2026-10-06 12:50** — re-observed with real mouse clicks: people-graph picks re-fit at 103% / 90% / 90% (three picks) and 93% for a single pick, not the 40% floor; the selected person is on screen and legible, earlier far picks scroll out of view by design.

24. ~~Search › Connections graph node labels are clamped and the hover title does not carry the label.~~ **Closed 2026-10-06 12:50** — re-observed: every clamped record-graph caption sits in a button whose title leads with the record name and carries the full caption, nodes now receive hover, and a selected long-titled node prints its whole caption on three lines. Titles read from the attribute, not a native tooltip.

28. **Initiative Overview: work-graph node names are cut with an ellipsis and have no hover title.**
    Repro: u-mia, `/iq/projects/p-observability` (Overview), scroll to the
    "Shared work graph". The clipped-text sweep reports 6 leaf labels clipped, e.g.
    "Span-metrics connector feeding RED dashboards" has 130px of the 292px it
    needs and renders "Span-metrics conn…"; "Metric cardinality budgets" 130 of
    155. The node's `aria-label` carries the full text
    ("Span-metrics connector feeding RED dashboards, idl…") but nothing has a
    `title`, so a sighted reader cannot recover the cut name without opening
    the node. First seen on the 2026-10-06 re-walk; the earlier logs of this
    surface recorded the sweep as clean, so the graph is new since then.
    Suspect the graph composite fed from `portal/src/pages/project-detail`
    (the Overview graph panel) and the library's node renderer.

    *Closed 2026-10-06 14:10 (ui-components 2.416.0, headless Chromium 1680x940, u-mia): the work-graph node header now carries a `title` holding the full name. The sweep still reports the strings clipped by their single-line ellipsis box (e.g. "Span-metrics connector feeding RED dashboards" 130 of 292px) but every one is titled with its whole text, the deliberate ellipsis-with-hover pattern the protocol accepts. Checked by reading the `title` attribute, not by a physical hover (headless).*

23. ~~Initiatives: both tables are wider than their pane at 1680px, so the right-hand columns are cut with no visible scrollbar.~~ **Closed 2026-10-06 13:05** — re-observed as u-mia at 1680px: the table box is 948px and the table is 948px on All initiatives, on Sprints (13 rows) and on the landing view, so Updated, Envelope and Spend in window are fully visible.

25. ~~Agent library: opening 5 of 12 assets logs a console error, and the asset page has no h1.~~ **Closed 2026-10-06 13:05** — re-observed as u-mia: opening skill-pr-review-scoped, lib-stakeholder-email, lib-adr-summary, orgiq-supervisor-system-prompt and orgiq-search-system-prompt gave no 4xx and no console line, and each asset page has an h1 with the asset name.

26. ~~Asset promotions has no h1.~~ **Closed 2026-10-06 13:05** — re-observed as u-mia: /iq/promotions (→ review?view=promotions) has an h1 "Asset promotions"; with `&item=promo-aurora-cold-start` open the h1 is the candidate title.

27. ~~A known "not found" / "nothing there" reads as an outage.~~ **Closed 2026-10-06 13:05** — re-observed as u-mia: `/iq/designs/nope-not-real`, `/iq/library/nope-not-real` and `/iq/promotions/zz-bogus` read "Design not found", "Asset not found" and "Candidate not found" with a back link; with `session-bundles` on its empty scenario the configuration page shows "No configuration preview / No session bundle has been published yet…" (scenario restored); the promotions list error now reads "Candidates are clustered from lab observations by the promotions service, so this is unknown rather than empty." The remaining bare-noun notices (Designs rail, bundle provider error) are tracked in member #18.

21. ~~A failed turn that started from a starter card shows a Retry button that
    does nothing.~~ **Closed 2026-09-07 16:38** — every send path now goes
    through one `send()` that records the turn, so `handleRetry`
    (`portal/src/pages/InvokePage.tsx:391`) always has text to resend.
    Re-observed as u-mia at 1552×857 with the first
    `POST /api/agents/orgiq-supervisor/invoke` forced to 503
    `{"error":"authorization unavailable"}` by a one-shot in-page `window.fetch`
    shim: clicking the "Android back gesture conflicts with drawer swipe" work
    card gave **1** invoke call and the banner "That turn failed. The agent is
    unavailable (503) — authorization unavailable"; clicking Retry gave **2**
    invoke calls, cleared the banner, streamed the reply, and left exactly
    **one** YOU bubble in `role=log`. The same ref feeds `collapseFailedTurn`
    (line 484), so the lingering-bubble collapse that closed #5 is live on
    these turns too. Filed identically as member #13 and sme #12; closed on all
    three.

22. ~~The two "From your work" cards sit at different heights in the same
    row.~~ **Closed 2026-09-07 16:38** — the grid carries `items-stretch`
    (`portal/src/pages/InvokePage.tsx:680`) and `items-center` is gone from the
    live class list; computed `align-items` is **`stretch`**. Re-measured as
    u-mia at 1552px: `auto-fit` still collapses the third track (`474px 474px
    0px`), and both cards now measure **132.5px tall with identical top 282.8px
    and bottom 415.3px** even though the left card's title wraps to one line
    and the right card's wraps to two — they were 115.5 and 135px at tops 292.5
    and 282.8. Neither card is inset. A per-node clipping sweep over `<main>`
    found 0 clipped nodes. Confirmed the same way for sme (#13).

1. **The program-owner persona's own initiative has no sprint, no grant and
   no allocation in dev:mock, so every "mine" view is blank.**
   `middleware/src/providers/sprints.ts:146-161` seeds six sprints, none for
   `p-mobile-redesign`, and `providers/budgets.ts` allocates nothing to it,
   while `schema/seed_program.sql:259-260` seeds `spr-mob-s1` (active,
   steward p-035, a $12 grant) with `wi-mob-*` work on it. Result: the
   Initiatives page with Show=Mine reads "SPEND · SEPTEMBER $0.00 no
   allocations", the Sprints lens with Mine reads "No sprints of yours" under
   both Active and All time (`GET /api/sprints?scope=all` → 6 sprints, 0 for
   the initiative), and Budgets omits the initiative entirely (see #7).
   CLAUDE.md says the fallbacks mirror the seed exactly; here they do not.
   Repro: sign in as Mia → Initiatives → Mine → read the stat strip; → Sprints
   → Mine → All time.
   **Closed 2026-09-05 21:47** — as Mia, Initiatives → Mine reads "SPEND · SEPTEMBER $0.94 of $15.00 allocated" with the row "Mobile App Redesign · 5/12 pts 42% · $0.94 / $15.00"; Sprints → Mine → Active lists "Sprint 31 — Routing · Mobile App Redesign · Ben Okafor · 23 Aug → 6 Sept · 5 / 12 · $12.00 envelope · $0.94"; Budgets lists Mobile App Redesign at $15.00 and its Sprints report the $12.00 envelope.

2. **"AGENTS ACTIVE 0 · 1 in flight" — one stat tile contradicts itself.**
   `/iq/projects` with Show=Mine (`portal/src/pages/projects/` stat strip).
   The tile's number says zero agents active while its caption says one is
   in flight; the Everyone scope reads "8 · 11 in flight" which has the same
   shape (number ≠ caption) but at least is not zero-vs-one.
   Repro: Initiatives → Mine → first stat tile.
   **Closed 2026-09-05 21:47** — the Mine strip reads "AGENTS ACTIVE 0 · none running" beside a separate "ACTIVE INITIATIVES 1 · 1 total" tile; Everyone reads "AGENTS ACTIVE 8 · on 6 initiatives" and "ACTIVE INITIATIVES 11 · 2 planning" — number and caption describe the same thing.

3. **Mia's initiative shows someone else's work, and the list and the detail
   disagree about it.** `middleware/src/providers/work-items.ts:651-654`
   hard-codes the `wi-onboard-*` family (epic "Self-Service Dev Environment
   Setup", projectName "Developer Onboarding Improvements", assignees Marcus
   O'Brien / Marcus Shah) onto `p-mobile-redesign`; the seed
   (`schema/seed_program.sql:262-265`) gives it `wi-mob-*` (Navigation
   overhaul, Bottom-tab IA, deep-link routing, an Android back-gesture bug,
   assigned to p-030/p-026). The Initiatives table therefore says "45% ·
   23/51 pts · 5 stories · 2 bugs" for the row while
   `/iq/projects/p-mobile-redesign` says "POINTS DONE 0% · 0/8 pts" with 3
   items, and Ask's "FROM YOUR WORK" starters all read "Not started on
   Developer Onboarding Improvements". Same shape as sme #8 (the `wi-k8s-*`
   Kubernetes family on p-observability, still present).
   Repro: Initiatives → Mine → open Mobile App Redesign → compare the two
   points figures; Ask → read the four NEXT-UP cards.
   **Closed 2026-09-05 22:47** — /iq/projects/p-mobile-redesign reads "POINTS DONE 42% · 5/12 pts" with three wi-mob-* rows (Bottom-tab IA done, Deep-link routing map in review, Android back gesture bug open; Mia Singh / Mateo Green), identical to the Initiatives row "5/12 pts · 42%"; Ask's FROM YOUR WORK cards name the same two items.

4. **Findings is read-only for the role that steers agent work.**
   `/iq/work/findings` — `portal/src/pages/work/FindingsPage.tsx:39`
   (`canManage = can('ManageDevbox')`) hides "Run sweeps now", "Find links in
   N of these" and every per-finding "Put a worker on it" / "Dismiss" for
   program-owner, and `middleware/src/routes/work.ts:324`
   (`POST /findings/:id/promote`, `requireAction('ManageDevbox')`) would 403
   it anyway — while the same role holds DispatchAgentRun and ManageBots and
   can ⚡ Estimate & authorize a run on initiative-detail. A program owner
   reads "Aurora cold-start recovery has a single holder" on Observability
   Platform and can do nothing about it here; an SME with no grant can
   (sme #4). The gate is on the wrong capability; nothing on the page says
   why the actions are missing.
   Repro: Findings → Enter on "Skill coverage risk" → no action buttons.
   **Closed 2026-09-05 21:51** — as Mia, Findings renders "Run sweeps now", "Find links in 1 of these" and per-finding "Put a worker on it" / "Dismiss"; pressing "Put a worker on it" on the Aurora cold-start finding → POST /api/work/findings/find-mock-1/promote 201, "✓ Worker queued" toast, and the page opened /iq/work/job-mock-1 ("queued by u-mia · from a finding").

6. **Computer Lab's two access messages contradict each other about this
   role, and the repo answers "may a program owner drive computers" three
   ways.** `/admin/devbox`: the page banner says "needs the ManageDevbox
   capability — an SME or a platform operator can"; ⌘I
   (`portal/src/components/shell/DevboxQuickSwitch.tsx:131`) says "Computer
   Lab needs the ManageDevbox capability (SME, program owner, org leader or HR
   admin)" — naming program owner as a holder while denying a program owner.
   `middleware/seeds/roles/orgiq/program-owner.cedar` grants no ManageDevbox
   (capabilities endpoint: false), `portal/src/App.tsx` admits program-owner
   to the route, and MATRIX.txt lists computer-lab for the role. Decide one
   answer; today the surface renders as a fleet the role can watch but not
   touch, with a broadcast textarea still editable.
   Repro: as Mia, /admin/devbox → read the banner → press ⌘I.
   **Closed 2026-09-05 22:55** — the rail has no Computer Lab entry, /admin/devbox redirects to /iq/projects, the Automate footer renders "Computer Lab" as plain text, and ⌘I reads "Computer Lab needs the ManageDevbox capability (SME or HR admin)" — one answer everywhere.

7. **Budgets cannot allocate for an initiative that has neither an allocation
   nor spend — including the program owner's own — and the Sprints report has
   no grant control.** `/admin/budgets` — `portal/src/pages/budgets/`. The
   Initiatives report lists 7 of 14 initiatives (six allocated + Inference
   Platform as a "blind spot" because it has spend); Mobile App Redesign has
   neither and is absent, and there is no "add allocation" affordance for an
   unlisted initiative. The Sprints report ("Budget envelopes granted to an
   SME for one sprint") lists 5 envelopes and offers no way to grant one,
   although `docs/program-operating-model.md` says the ManageBudgets holder
   grants them. A program owner with ManageBudgets therefore cannot set the
   ceiling for the one initiative she is accountable for, nor give her SME an
   envelope.
   Repro: as Mia, Budgets → search the table for "Mobile" (absent) → Sprints
   report → look for a grant control (absent).
   **Closed 2026-09-05 22:45** — Budgets → Initiatives lists all 14 initiatives; Mobile App Redesign reads "$15.00 · $0.94 · all of it maintenance · $14.06 · 6 runs" with an editable amount, and each of the 8 unallocated initiatives has "Set budget"; the Sprints report lists Ben Okafor's $12.00 envelope on Mobile App Redesign and offers "Grant envelope →" (to /iq/sprints) in its header.

8. **Budgets: Escape on the inline allocation editor loses focus.**
   `portal/src/pages/budgets/` — Enter on "$60.00" opens the number input
   with focus; Escape closes it and `document.activeElement` becomes `<body>`
   instead of the "$60.00" button (same after "Set budget" → Escape). Opening
   the editor also scrolls the table so its header leaves the viewport.
   Repro: Budgets → Tab to "$60.00" → Enter → Escape → check activeElement.
   **Closed 2026-09-05 22:45** — Enter on "$15.00" opens the number input focused; Escape closes it and document.activeElement is the "$15.00" button; same for "Set budget" → Escape; the table header's position was identical before and after (thead top unchanged).

9. **Bot detail contradicts itself and offers no control.**
   `/admin/bots/32970d0a-…` (obs-nightly-maintenance) — `portal/src/pages/bots/`.
   Header: "cron: 0 6 * * * · last ran 1h ago"; guardrails footer: "today:
   2/4 runs · $0.26 of $2.00"; RUNS section: "This bot has never fired. Use
   ▶ Run now, or wait for its trigger." — and there is no ▶ Run now, pause,
   enable or edit control on the page for a role holding ManageBots ("← Bots"
   is the only control). A program owner cannot un-pause cost-anomaly-sweep
   from either page.
   Repro: Bots → Enter on obs-nightly-maintenance → read RUNS.
   **Closed 2026-09-05 22:53** — obs-nightly-maintenance's page shows ▶ Run now / Pause / Delete / edit ×2 for program-owner; header "last ran 2h ago", guardrails "today: 2/4 runs · $0.26 of $2.00" and the RUNS table ($0.1600 2h ago, $0.1000 15h ago, … each with a "job →" link that resolves 200) agree; Resume on cost-anomaly-sweep → POST …/resume 200, status enabled, then Pause → 200 restored it.

10. **Bots: the summary count does not track the filtered list.**
    Reproduces hr-admin #9 in a new wording: with "zzznoexistbot" in the
    search box the table reads "No bots match the current filters." while
    the line above reads "5 bots match · …" (`portal/src/pages/bots/BotsPage.tsx`).
    Repro: Bots → type "zzznoexistbot".
   **Closed 2026-09-05 22:53** — with "zzznoexistbot" in the search the summary line reads "0 of 5 bots match" above "No bots match the current filters."

11. **Initiative-detail Board view logs two React errors: an `<a>` nested in
    an `<a>`.** `portal/src/pages/project-detail/BoardView.tsx` — each
    BoardCard is wrapped in `LinkWithRef to="?item=…"` and renders `PrBadge`
    → `ExternalLink href="https://github.com/…/pull/401"` inside it. Console:
    "In HTML, <a> cannot be a descendant of <a>. This will cause a hydration
    error." and "<a> cannot contain a nested <a>."
    Repro: /iq/projects/p-observability → ⊞ Board → console.
   **Closed 2026-09-05 22:46** — Items → Board on p-observability logs 0 console errors and `main.querySelectorAll('a a').length` is 0.

12. **Initiative-detail: the owner-picker menu ignores Escape.** The "✎" next
    to OWNER (`portal/src/pages/project-detail/InitiativeHeader.tsx`) opens
    a Nora DaSilva ✓ / Layla Hassan / Eli Garcia menu; Escape leaves it open
    (`[role=menu]` still in the DOM a second later).
    Repro: initiative header → click ✎ → Escape.
   **Closed 2026-09-05 22:46** — ✎ opens a role="menu" (✓ Nora DaSilva / Layla Hassan / Eli Garcia / Clear owner) with focus on the checked item; Escape removes the menu and returns focus to "Change who runs this initiative".

13. **Dispatch is refused for a codebase the page already shows, and the
    remedy names a surface this role cannot open.** Reproduces sme #3 for
    program-owner: ⚡ Estimate → Authorize → "Authorize run" on Observability
    Platform POSTs `/api/bots/dispatch-work` → 400 "no codebase delivers this
    initiative — link one in Codebases" (toast "✗ Dispatch failed") while the
    header shows "↗ connorhoehnslalom/orgiq-observability"; Codebases is
    `/admin/projects`, hr-admin only, which redirects program-owner to
    /select. No grant banner is shown for this role, so the refusal is the
    first the program owner hears of it.
    Repro: as Mia on Observability Platform, ⚡ Estimate on "Error-budget
    dashboard per team" → Authorize → Authorize run.
   **Closed 2026-09-05 22:47** — ⚡ Estimate → Authorize → Authorize run on "Error-budget dashboard per team" POSTs /api/bots/dispatch-work and is refused 503 "the devbox runtime is not deployed" (toast "✗ Dispatch failed", drawer left open) — the codebase preflight passes for the repo the header shows and the refusal names an infrastructure state, not a surface this role cannot open.

14. **Person chips trap keyboard focus in a hover-card that Escape does not
    close.** Reproduces sme #2 exactly:
    `portal/src/pages/project-detail/PersonRef.tsx:110`
    `onFocus={() => setOpened(true)}`; 12 Tabs bounce between the sponsor chip
    and the "Vera Green Principal Engineer Loading…" dialog, and the Work
    table is unreachable past row 1's assignee chip.
    Repro: /iq/projects/p-observability → Tab ×3 → Escape.
   **Closed 2026-09-05 22:46** — a 75-Tab sweep from the breadcrumb passes Vera Green → Nora DaSilva → ✎ → Layla Hassan → Eli Garcia → Work tab in one step each; no dialog opens on focus and all 65 tabbable controls (rows, ⚡ Estimate, ⚡ New epic, the rail) are reached.

15. **The role is described as having no allocation authority while it holds
    ManageBudgets.** `portal/src/pages/SelectContextPage.tsx:50` ("Sprints,
    board and bots — no allocation authority"), Mia's picker card ("Program
    owner — runs sprints and the board, cannot allocate"),
    `middleware/src/lib/role-registry.ts:23` and the comment at
    `middleware/src/providers/identity.ts:59` all say the opposite of
    `middleware/seeds/roles/orgiq/program-owner.cedar` (ManageBudgets granted,
    "the same allocation authority hr-admin and org-leader hold") and of the
    rail, which shows Budgets.
    Repro: /select → read the Program Owner row and Mia's card.
   **Closed 2026-09-05 22:55** — /select's Program Owner row reads "Allocates and grants on their own initiatives; sprints, board and bots" and Mia's card "Program owner — allocates for their initiatives, runs sprints and the board".

16. **Hidden direct routes bounce a multi-grant user to the workspace picker.**
    `portal/src/App.tsx` `RequireRole … fallback={<Navigate to="/" replace />}`:
    "/" resolves to /select for a user with two grants, so /admin/knowledge,
    /iq/prompts, /admin/identity/users, /iq/agents, /admin/observability/*,
    /admin/capabilities, /admin/projects and /assessment/teams all land Mia on
    "Choose a workspace" with her current role highlighted — it reads as
    "pick your role again", with no hint the URL was off-limits (an SME with
    one grant lands on /iq/projects instead). Not a leak; a dead-end.
    Repro: as Mia, navigate to /admin/knowledge.
   **Closed 2026-09-05 22:55** — /admin/knowledge, /iq/prompts, /iq/prompt-ops, /admin/identity/users, /iq/agents, /admin/observability/summary, /admin/observability/invocations, /admin/capabilities, /admin/projects, /admin/devbox and /assessment/teams all land on /iq/projects (Initiatives), not the workspace picker.

17. **Ask lists a session that cannot be reopened.** Reproduces sme #7:
    after one turn and "+ New", clicking the rail entry sets
    `aria-current="page"` on it but the transcript stays on the empty
    "Ask Supervisor" starter (`portal/src/pages/InvokePage.tsx`).
    Repro: Ask → send anything → + New → click the session in the rail.
   **Closed 2026-09-05 21:54** — after one turn and "+ New", clicking the rail entry set aria-current="page" AND restored the transcript (SUPERVISOR reply and PEOPLE IN THIS ANSWER chips visible).

18. **The palette cannot reach Budgets or six other rail surfaces.**
    `portal/src/components/shell/portalCommands.ts` — ⌘K's 14 rows omit
    Budgets, Library, Promotions, Designs, Computer Lab, Session config and
    Bots; Budgets is the surface that distinguishes program-owner from sme.
    Repro: ⌘K → type "Budg" → no result.
   **Closed 2026-09-05 22:55** — ⌘K lists 20 rows including Budgets, Bots, Changes, Library, Promotions, Designs and Session config, and no Computers row; typing "Budg" resolves to Budgets.

20. **Initiative-detail: the new right rail is sticky within its parent row,
    not pinned to the content area, and is taller than the scroll container
    that holds it.** `/iq/projects/p-observability` —
    `portal/src/pages/project-detail/InitiativeRail.tsx` / `ProjectDetailPage.tsx`.
    Measured: rail `position: sticky; top: 0px` (class `sticky top-0
    h-[calc(100vh-7rem)] w-[320px] shrink-0 self-start overflow-y-auto`,
    677px at innerHeight 789, scrollHeight 831 so it has its own scrollbar);
    ancestors with overflow other than visible: `div.flex-1.min-h-0.overflow-auto`
    (the shell's scroll container, top 125px, height 640px) and
    `main.overflow-auto.p-6` (top 61px). Its sticky parent
    `div.flex.flex-row.gap-4.items-start` is exactly the rail's height on a
    three-item initiative (677px), so the rail has no sticky travel: scrolling
    the container its full 101px moves the rail 101px (top 125 → 24). With the
    window shortened to innerHeight 377 the container scrolls 489px and the
    rail again lands at top 24px — pinned to the bottom of its row with its
    "DELIVERED BY" card at −106px, hidden behind the breadcrumb bar and
    unreachable by the rail's own scrollbar (a screenshot showed the rail
    beginning mid-DESIGNS). At the default viewport the 677px rail also
    exceeds the 640px container, so its last 37px are below the fold on every
    load. Re-measured after the 22:47 edits to both files: unchanged.
    Repro: /iq/projects/p-observability → scroll the work table to the bottom
    → read the rail's top; shrink the window to ~520px tall and repeat.
    **Closed 2026-09-06 11:30** — re-observed as u-mia at 1552×789: the rail is `sticky top-0` with `max-h 639px` (= the 640px scroll container), rect top 125px, height 639px, scrollHeight 831px; with 650px of container scroll (800px of temporary margin under the table) the rail's top stayed at 125px while the table's top went to −141px, and the rail scrolls inside itself (scrollTop 192px brings the last OUTCOMES row to 752px, above its 764px bottom edge). Nothing is clipped under the breadcrumb bar and nothing sits below the fold on load. Same numbers as member (u-theo) and sme (u-nora) on the same page this session.

5. **A failed Ask turn reports the wrong status, offers no retry, and stays
   in the transcript.** `/iq/invoke` — `portal/src/pages/InvokePage.tsx`.
   `POST /api/agents/orgiq-supervisor/invoke` returned **503** (middleware
   mid-restart); the page rendered "Error: Stream failed: 500" under the YOU
   bubble. The ↻ beside the suggestion chips only re-rolls the suggestions,
   so the only recovery is retyping, after which the transcript shows
   YOU / YOU / SUPERVISOR with the dead first bubble kept and no session
   listed for the failed turn.
   Repro: stop the middleware, send a message, restart it, send again.
   **Still reproduces 2026-09-05 21:54 (partially)** — the status is now the real one ("That turn failed. The agent is unavailable (503) — authorization unavailable") and there is a Retry that resends the exact text (banner clears, reply streams); but the failed turn's YOU bubble is kept and Retry appends a second identical YOU bubble, so the transcript reads YOU / YOU / SUPERVISOR (two divs with the same question at y −192 and −114) and the reopened session shows both. The lingering-bubble clause of this defect is what remains.
    **Closed 2026-09-06 11:36** — re-observed as u-mia: a turn forced to 503 rendered "That turn failed. The agent is unavailable (503) — authorization unavailable" with Retry; Return on Retry cleared the banner, resent the identical text, the reply streamed, and the transcript held exactly ONE YOU bubble with the question (the rail's session row is the only other element carrying the text); "+ New" then reopening the session from the rail still showed one YOU bubble plus the SUPERVISOR reply. Same shape seen as u-theo and u-nora this session.

19. **Ask: once a reply has streamed, the transcript's first turns sit above the
    scroll container's top and cannot be scrolled to.** `/iq/invoke` —
    `portal/src/pages/InvokePage.tsx:518` wraps the sessions rail and the chat
    column in `Inline className="h-full"` (items-center) and the chat column
    (`Stack className="flex-1 p-6 min-w-0"`, :601) has no `min-h-0`, so a
    column taller than the row (960px against a 624px row after one ~900px
    reply) is centred and overflows both ends: the transcript element's top is
    −59px with the outer scroller at scrollTop 0, the two YOU bubbles sit at
    −192/−114px, and a wheel scroll up over the transcript does nothing. A
    person cannot read their own question once the answer is longer than the
    viewport. Observed 2026-09-05 21:54 at 1552×733.
    Repro: Ask → send anything → try to scroll up to the YOU bubble.
    **Closed 2026-09-06 11:36** — re-observed as u-mia at 1552×789: after a reply streamed the transcript is its own scroller (`flex-1 min-h-0 overflow-auto`, top 149px, clientHeight 335px, scrollHeight 576px) and at scrollTop 0 the first YOU bubble sits at 184px — inside the scroller and below the app header — so the person's own question is always reachable. Same numbers as member and sme this session.


## Fixed (pending re-audit) — coordinator, 2026-09-05 20:05

- #6: Cedar is the source of truth — only `sme.cedar` and `hr-admin.cedar`
  grant `ManageDevbox`, so the route, rail and matrix were the ones lying.
  `/admin/devbox` now wears `RequireRole ['hr-admin','sme']` (`App.tsx`),
  `DEVBOX_ROLES` in `work/automateNav.tsx` is `hr-admin, sme, admin`, the
  ⌘I access-denied copy names "SME or HR admin", the palette's Computers
  entry carries the same list, and `MATRIX.txt`'s computer-lab row is
  `sme,hr-admin`. A program owner or org leader now sees no Computer Lab
  entry anywhere and a direct route redirects to `/iq/projects`.
- #16: every `RequireRole` fallback in the org tree now navigates to
  `/iq/projects` (the tenant home) instead of `/`, so a multi-grant user
  bounced off a hidden route lands on Initiatives, not the workspace picker.
- #18: the palette's `PAGES` list now includes Library, Promotions, Designs
  (group Design) and Session config (group Release) for every org role, and
  Budgets / Bots / Changes / Computers carry role lists that mirror Cedar
  (`BUDGETS` = program-owner, org-leader, hr-admin; `BOTS` adds sme;
  `CHANGES` = program-owner, hr-admin; `DEVBOX` = sme, hr-admin) instead of
  the blanket hr-admin-only `BUILD` gate.

## Fixed (pending re-audit) — portal agent B, 2026-09-05 20:30

- #5: A failed Ask turn now reports the real status and the middleware's own
  detail, offers a Retry, and never lingers as a stray transcript line.
  `useAgentStream`'s injectable `fetch` (it swallows the response body on a
  non-ok POST and throws a bare `Stream failed: ${status}`) is now
  `agentInvokeFetch` (`portal/src/pages/InvokePage.tsx`): it reads the real
  body and throws a message built by the new pure `describeTurnError(status,
  body)` (`portal/src/components/chat/turnError.ts`, node-tested in
  `__tests__/turnError.test.ts`) — a 503 with `{error: "authorization
  unavailable"}` now reads "The agent is unavailable (503) — authorization
  unavailable" instead of a hard-coded 500. The failure renders as its own
  `Banner` with a Retry button that resends the exact turn text (`lastTurnRef`
  + `handleRetry`), tracked in local state (`turnErrorMessage`) synced from
  the hook's `error` rather than pushed into `messages` — so it is never a
  chat bubble and clears itself the instant a retry (successful or not)
  starts, same as the pre-existing `historyError` banner it sits beside.
- #9: Bot detail no longer contradicts itself, and program-owner (who holds
  `ManageBots`, not `ManageDevbox`) now sees its controls.
  `portal/src/pages/bots/BotDetailPage.tsx` gated Run now / Pause-Resume /
  Delete / mission+guardrail edit on `can('ManageDevbox')` — the wrong
  capability for routes gated server-side on `ManageBots`
  (`middleware/src/routes/bots.ts` `manageGate`) — so a program owner saw
  none of them even though the server would have accepted every request;
  fixed to `can('ManageBots')`. Separately, the header's "last ran X ago",
  the guardrails footer's "today: N/M runs", and the RUNS table's "This bot
  has never fired" drew from three different sources (`bot.lastRunAt`,
  `bot.todayRunCount`, and a separate `/api/bots/:id/runs` fetch) that can
  disagree — in dev:mock, `listBotRuns` always returns `[]` while the bot
  record still carries seeded `lastRunAt`/`todayRunCount`, so every bot
  page read as self-contradictory. Added a pure `botRunSummary(runs, now)`
  (`portal/src/pages/bots/botsFormat.ts`, tested in
  `__tests__/botsFormat.test.ts`) that derives BOTH the header's claim and
  the guardrails footer's run count from the same `runs` array the RUNS
  table renders: no runs → "never fired" everywhere, some runs → "last ran
  <time>" agreeing with a real row in the table. Run now on a parked bot was
  already honest (the existing 409 handler surfaces the server's refusal
  reason via toast, never a fake success) — left unchanged.
  Verified: `npx tsc --noEmit` (clean for these files — two pre-existing,
  unrelated errors remain in untracked `budgets/InitiativesReport.tsx`),
  `node --test 'src/**/__tests__/*.test.ts'` (501 pass), `npx vite build`,
  and `scripts/validate-orgiq-audit.sh --quick` component-discipline block
  all ✓ (raw elements 0/0, no style=, no native controls, no raw button).

## Fixed (pending re-audit) — portal agent A, 2026-09-05 21:40

- #11: Board no longer nests an `<a>` inside an `<a>`. `BoardCard`
  (`portal/src/pages/project-detail/BoardView.tsx`) used to wrap the whole
  card in a `Link`, with `PrBadge`'s external `<a>` and `RunStateChips`'
  internal `Link`s rendering inside it. It now links only the title — the
  same pattern `ItemRow.tsx` already uses for this exact item in the tree
  view — so the card itself is not a link and there is exactly one anchor
  per interactive affordance.
- #12: the owner ✎ picker now closes on Escape and returns focus to the ✎
  trigger. The picker (`OwnerEditor` in
  `portal/src/components/marketplace/GovernanceEditor.tsx` — imported by
  `InitiativeHeader.tsx`, which is where the defect's repro lives) was a
  hand-rolled `<div role="listbox">` positioned with inline styles, closing
  only on outside click; Escape did nothing. Rewrote it on the library's
  `DropdownMenu` (built on `InlinePopover`, which gives Escape-dismiss and
  focus-capture/restore for free), and cleaned up `RoleCycleChip` in the same
  file to use `Button`/Tailwind instead of raw `<button style=…>` (component
  discipline, even though the validator only scores `pages/`).
- #4: Findings actions are visible to program-owner. `FindingsPage.tsx`
  gated "Run sweeps now", "Find links in N of these", and per-finding
  "Put a worker on it"/"Dismiss" on `can('ManageDevbox')`, a capability
  program-owner does not hold; all four end in an agent job, so they now
  gate on `DispatchAgentRun` (`canManageFindings`), matching ⚡ Estimate &
  authorize elsewhere and the middleware's parallel move of
  `POST /findings/:id/promote` to the same capability. The dead-letter
  queue's Requeue (a `jobs/:id/requeue` fleet operation, not a finding
  action, and not named in this defect) stays on `ManageDevbox`
  (`canRequeue`). `POST /api/work/sweeps/run` has not moved server-side as
  of this fix — "Run sweeps now" may still 403 a DispatchAgentRun-only
  session until it does; documented in code rather than re-hidden.
- #2: "Agents active" and its hint now describe the same thing. The tile
  summed `activeAgentRuns` for its value but paired it with `inFlight`
  (initiatives whose *status* is active/in_progress) for its hint — two
  unrelated metrics, hence "Agents active 0 · 1 in flight". Added
  `agentsActiveInitiatives` to `programTotals()`
  (`portal/src/pages/projects/projectFormat.ts`) — the count of initiatives
  in the SAME set with `activeAgentRuns > 0` — so the hint now reads "on N
  initiatives" / "none running". `inFlight` moved to its own "Active
  initiatives" tile, paired with the already-computed-but-unused `planning`
  count. Node test added:
  `programTotals` on a single Mine-scoped initiative (status active, 0
  agent runs) asserts `agentsActive`/`agentsActiveInitiatives` are 0 while
  `inFlight` is 1 — the exact non-contradiction. Files:
  `portal/src/pages/ProjectsPage.tsx`,
  `portal/src/pages/projects/projectFormat.ts`,
  `portal/src/pages/projects/__tests__/projectFormat.test.ts`.
- #7: Budgets' Initiatives table now lists every initiative the role can
  see, not just the ones with an allocation or spend. `GET /api/budgets`
  only ever returns allocated/spending rows (unchanged — read-only wire
  contract); the portal now also fetches `/api/graph/projects?limit=100`
  (the same call `FirstBudgetForm` already made) and merges it with the
  budget rows via a new pure `mergeInitiativesWithBudgets()`
  (`portal/src/pages/budgets/budgetsFormat.ts`, node-tested), producing a
  zeroed/unallocated `BudgetRow` for every initiative missing one — so the
  existing "— unallocated · Set budget" cell (already correct for one row)
  now renders for all of them, Mobile App Redesign included. A budget row
  whose initiative doesn't come back from the second fetch is kept, not
  dropped. Sprints report: confirmed no grant-creation route exists
  anywhere (`routes/budgets.ts` only reads `/grants`; `routes/sprints.ts`
  has none) — rather than fabricate a form with nowhere to POST,
  `SprintsReport.tsx` now gives a ManageBudgets holder a real "Grant
  envelope →" link to `/iq/sprints` in the header and in the empty state,
  and the empty-state copy no longer tells the reader to grant "from
  Initiatives → Sprints" (i.e. this same page). Files:
  `portal/src/pages/budgets/BudgetsPage.tsx`,
  `portal/src/pages/budgets/budgetsFormat.ts`,
  `portal/src/pages/budgets/SprintsReport.tsx`,
  `portal/src/pages/budgets/__tests__/budgetsFormat.test.ts`.
- #8: the inline allocation editor's Escape now cancels AND returns focus to
  the amount/"Set budget" button that opened it, instead of `<body>`.
  `AllocationCell` (`portal/src/pages/budgets/InitiativesReport.tsx`)
  replaced `autoFocus` with a manual `focus({ preventScroll: true })` in a
  `useEffect` (fixing the reported table-header scroll-jump too, since that
  was the browser scrolling the focused input into view inside the
  `overflow-x-auto` Card) and now refocuses the trigger button on Escape or
  a completed save via a ref captured off the click/keyboard-activation
  event (the library's `Button` isn't `forwardRef`-wrapped, so a `ref` prop
  on it is a TS error, not a silent no-op).
  Verified together: `npx tsc --noEmit` clean, `node --test
  'src/**/__tests__/*.test.ts'` 501/501 pass, `npx vite build` clean, and
  `scripts/validate-orgiq-audit.sh --quick` component-discipline block all
  ✓ (raw elements 0/0, no style=, no native controls, no raw button) —
  including `components/marketplace/GovernanceEditor.tsx`, which the
  validator doesn't score but was cleaned up anyway per the fix above.

## Fixed (pending re-audit) — middleware agent, 2026-09-06 00:20

- **#1 — Mia Singh's own initiative now carries a sprint, a grant and an
  allocation in dev:mock.** `schema/seed_program.sql` already had all three
  (`spr-mob-s1` steward p-035/Ben Okafor, `bg-mob-1` $12, `initiative_budgets`
  $15) — the generator's contribution table confirms `p-mobile-redesign`
  owner is `p-030` (Mia) — only the mock fixtures never mirrored them.
  Regenerated `schema/seed_program.sql` from
  `schema/seeds/generate_program_seed.py` (picks up the same pre-existing
  `summary`/`sponsor_person_id` drift the sme-journey middleware agent's
  2026-09-06 pass already documented and left in place; nothing in the
  mobile-redesign section itself changed) and added the mirror rows: a
  `spr-mob-s1` entry in `MOCK_SPRINTS` (`providers/sprints.ts`), a
  `p-mobile-redesign` row in `MOCK_BUDGETS` and a `bg-mob-1` row in
  `MOCK_GRANTS` (`providers/budgets.ts`) — spend/runs/maintenance ($0.94, 6
  runs) derived from the seed's `mobile-e2e-nightly` bot_runs, all of it
  cron maintenance since the bot is parked awaiting repo provisioning.
  Files: `schema/seeds/generate_program_seed.py` (unchanged, just re-run),
  `schema/seed_program.sql`, `middleware/src/providers/sprints.ts`,
  `middleware/src/providers/budgets.ts`.
  Tests: new `middleware/src/providers/__tests__/program-seed-parity.test.ts`
  — parses `sprints`/`budget_grants`/`initiative_budgets` INSERTs straight out
  of `seed_program.sql` (same discipline as `work-items-seed-parity.test.ts`)
  and asserts every sprint/grant the mock carries agrees with the seed's row
  for it, plus two defect-#1-specific regression pins (Mia's sprint is
  active with the right steward; her allocation is exactly $15). Left the
  ledger's known pre-existing drift on 3 other initiatives (Observability,
  LLM Platform, Cost Optimization — allocations hand-picked, not seed-exact;
  see the new test file's comment) undisturbed — out of scope for this
  defect, and asserting full equality there would fail on day one.
  Proof: `POST /api/session/login {"userId":"u-mia"}` → switch tenant/role to
  `orgiq`/`program-owner` → `GET /api/sprints?scope=mine` returns
  `spr-mob-s1` (active, steward Ben Okafor, granted $12, 3 items/12 pts);
  `GET /api/budgets` returns `{"orgProjectId":"p-mobile-redesign",
  "allocatedUsd":15,"spentThisPeriodUsd":0.94,"runCountThisPeriod":6}`.

- **#3 — the `wi-mob-*` family replaces the fabricated "Developer Onboarding"
  items, and the Initiatives-list rollup now derives from the same items as
  the Work-tab detail.** The `wi-onboard-*` fixture (4 items,
  `middleware/src/providers/work-items.ts`) was pointed at
  `p-mobile-redesign`'s id while its own `projectName` said "Developer
  Onboarding Improvements" and its assignees (Sienna Garcia, Marcus O'Brien,
  Marcus Shah) are nobody real on that initiative — removed and replaced with
  the real `wi-mob-*` family lifted from `schema/seed_program.sql` (epic +
  2 stories + 1 bug, real assignees p-030/p-026, real sprint/PR/estimate
  fields), the same treatment `wi-k8s-*` got for Observability Platform.
  Separately, `providers/projects.ts` `MOCK_INITIATIVES`'s hand-typed
  `openStories`/`openBugs`/`pointsDone`/`pointsTotal` for `p-mobile-redesign`
  (previously 5/2/23/51, unrelated to any real item) now equal what the real
  `wi-mob-*` items sum to (1/1/5/12) — the same formula
  `providers/projects.ts`'s Aurora rollup SQL uses (open stories/bugs = type
  in (story,bug) AND status in open/in_progress/in_review; points = sum
  story_points over story+bug; done = sum where status='done') — so the list
  and the detail can no longer read two different initiatives.
  Files: `middleware/src/providers/work-items.ts`,
  `middleware/src/providers/projects.ts`.
  Tests: extended `work-items-seed-parity.test.ts` with a `wi-onboard-*`
  non-resurrection guard (mirroring the existing `wi-k8s-*` one) and a new
  assertion that `listProjects()`'s points rollup for `p-mobile-redesign`
  equals the sum over its real `searchWorkItems()` rows. Also had to retarget
  `activity.test.ts`'s "zero-fills an initiative with no runs and no
  completed work" case from `p-mobile-redesign` (which now has one real
  `done` item 8 days old, so it's no longer activity-free) to `p-data-lake`
  (planning-stage, genuinely zero work items and zero bots in mock mode).
  Proof: `GET /api/graph/projects?mine=true` (as Mia) → `p-mobile-redesign`
  `{"openStories":1,"openBugs":1,"pointsDone":5,"pointsTotal":12}`;
  `GET /api/graph/projects/p-mobile-redesign/work` → same 3 sized items
  (`wi-mob-e1-s1` done 5pt, `wi-mob-e1-s2` in_review 5pt, `wi-mob-e1-b3` open
  2pt) summing to the identical 5/12.

- **#4 — `POST /api/work/findings/:id/promote` is gated `DispatchAgentRun`,
  not `ManageDevbox`.** Promoting a finding enqueues an agent job — the same
  act `POST /api/bots/dispatch-work` performs — and `DispatchAgentRun` is the
  capability Cedar actually grants for that (sme, program-owner, org-leader,
  hr-admin); `ManageDevbox` is the Computer Lab / devbox-driving capability
  and unrelated, which is exactly why it 403'd a program-owner here while the
  same role could already authorize the identical spend from
  initiative-detail's Estimate flow. The grant-scoped verdict the sme-journey
  middleware agent added (`grantScopedDispatchVerdict`) is unchanged —
  still runs after this gate, still the hard brake.
  Also audited the two neighboring gates named in the defect:
  `POST /api/work/sweeps/run` moved from `requireAction('ManageDevbox')` to
  `requireSession('RunSweeps')` — `org-sweeps.ts` makes no Bedrock call and
  enqueues no agent job, it only reads the graph and rewrites the `findings`
  cache, so it is a read-tier action like the mount-level
  `requireSession('ViewWork')` floor `GET /findings` already relies on, not a
  capability. `POST /api/work/findings/analyze-batch` (and its single-doc
  sibling `/findings/:id/analyze`) stays `ManageDevbox`: unlike sweeps, it
  spends real Bedrock $ per document and writes `graph_proposals` rows — the
  same write `POST /proposals` (manual proposal creation) makes under the
  same gate — so it keeps the gate its manual counterpart has rather than
  taking on `DispatchAgentRun`, which would be the wrong capability for a
  graph-write-adjacent action that never touches `agent_jobs`.
  Files: `middleware/src/routes/work.ts`.
  Tests: `work-findings-promote.test.ts` comment updated to name
  `DispatchAgentRun` (the test itself mocks `requireAction` away entirely, so
  behavior is unchanged; the real gate name is exercised live below and by
  `authz-matrix.test.ts`'s existing `DispatchAgentRun` role coverage).
  Proof: as Mia (program-owner, no `ManageDevbox`),
  `POST /api/work/findings/find-mock-2/promote` → `201` (job-mock-1 queued) —
  previously would have 403'd; as Theo (member, no `DispatchAgentRun`), same
  call → `403 {"action":"DispatchAgentRun","role":"member"}`; as Theo,
  `POST /api/work/sweeps/run` → `200` (previously would have 403'd on
  `ManageDevbox`).

- **#15 — the role descriptions now say what Cedar actually grants.**
  `middleware/src/lib/role-registry.ts:23`'s `program-owner` summary and the
  comment at `middleware/src/providers/identity.ts` above the `u-mia` fixture
  both said "no allocation authority" / "without... the allocation
  authority" while `program-owner.cedar` grants `ManageBudgets` outright
  ("the same allocation authority hr-admin and org-leader hold" — its own
  comment). Reworded both to: runs sprints/bots/the board AND allocates the
  monthly budget + sprint envelopes on the initiatives they own; no
  leaderboard, no identity admin, `ApproveTransaction` still forbidden
  (allocating is not approving). No test asserted the old text (checked
  `authz-matrix.test.ts`, which tests Cedar capabilities directly, not
  registry strings), so nothing needed updating beyond the source.
  Files: `middleware/src/lib/role-registry.ts`,
  `middleware/src/providers/identity.ts`.
  Note: the portal-facing copies of this same claim
  (`SelectContextPage.tsx:50` and Mia's picker card, also named in this
  defect) are portal territory, out of scope for this pass.

All four verified with `cd middleware && npx tsc --noEmit && npm test`
(116 suites / 1708 tests, up from 115/1700) green, and live curls against
`dev:mock` on :3001 as `u-mia` (program-owner), `u-theo` (member), and
`u-nora` (sme).


## Fixed (pending re-audit) — coordinator, 2026-09-05 23:20

- #5 (residual): a retried turn no longer shows twice. `InvokePage.tsx`
  tracks `retried` and renders the transcript through
  `components/chat/collapseFailedTurn.ts` (tested), which drops the failed
  "you" bubble when the identical turn follows it with no reply between —
  the stream hook exposes no way to remove a message, so the collapse is
  render-side and only ever touches that one shape.
- #19: the Ask page's two columns are `align="stretch"` with `min-h-0` on
  the chat column and the transcript scroller, so the first turn scrolls
  inside the transcript instead of above the shell's scroll container.
- #20: the initiative rail's ceiling is the content scroller's height, not
  the viewport's — `max-h-[calc(100vh-var(--shell-chrome-h))]` with
  `--shell-chrome-h: 150px` set once in `app.css` (header + breadcrumb row
  + content padding), so a sticky rail can never be taller than the box it
  pins to; the panel border that doubled every card's frame is gone and the
  "Delivered by" card uses the same small label as every other rail card.


## Fixed (pending re-audit) — coordinator, 2026-09-07 14:45

- #21 (Retry dead for non-composer turns): `lastTurnRef` was set in exactly
  one place — the composer's submit handler — so Retry after a work card, a
  starter, a `?prompt=` deep link or an "Ask about them" chip fired no
  request, and `collapseFailedTurn` was inert on those turns for the same
  reason. Every path now goes through one `send()` in `InvokePage.tsx` that
  sets the ref, clears the retried flag and streams; the call sites no longer
  each have to remember.
- The starter grid rendered ragged: `Inline` sets `items-center`, which
  survives the `grid` display override and stops grid items filling their
  row, so a short card measured 115px against its row-mates' 135px and
  floated. `items-stretch` added.
- A blocked card read "BLOCKED  Blocked" — the kind pill and the reason line
  said the same word once the initiative moved to its own slot. The pill is
  gone; the reason carries it.
