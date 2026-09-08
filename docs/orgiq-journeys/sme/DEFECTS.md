# SME-role defects — org tenant

Found auditing u-nora / Nora DaSilva (sme, person p-004) against
`docs/orgiq-journeys/MATRIX.txt`. Repro steps assume signed in as Nora
DaSilva / SME at 1552px, `middleware dev:mock`. Judged as the persona the
role exists for: an engineer who holds a sprint envelope and wants to see it,
dispatch an agent against her initiative's work, and read what came back.

Fixed since earlier roles' passes and re-verified here as **fixed** for sme
(not repeated below): member #1 (mouse-only rows — Initiatives, Library,
Promotions, Designs), member #2 (dead status pills — Promotions, Designs,
Findings), member #3 (silent 403 on Promotions approve — sme is now gated
in and the action works), member #5 listing half (Ask's session rail
populates), member #6 (Explore no-match state), member #7/#8 (palette
Scores/Recent-runs leaks, Automate's Computer Lab link is live for sme),
member #9 (Findings empty-state control exists for sme), hr-admin #1
(Promotions drawer now updates after approve with a toast).

## Open

#12, #13 and #14 were all re-audited on 2026-09-07 and closed — see the
Closed section. Nothing is open for this role right now.

## Closed

12. ~~A failed turn that started from a FROM YOUR WORK card shows a Retry
    button that does nothing.~~ **Closed 2026-09-07 16:33** — every send path
    now routes through one `send()` that records the turn, so `handleRetry`
    (`portal/src/pages/InvokePage.tsx:391`) has text to resend no matter where
    the turn came from. Re-observed as u-nora at 1560×893 on this role's
    primary entry point, with the first `POST /api/agents/orgiq-supervisor/invoke`
    forced to 503 `{"error":"authorization unavailable"}` by a one-shot in-page
    `window.fetch` shim: clicking the "Error-budget dashboard per team" work
    card gave **1** invoke call and the `role=alert` banner "That turn failed.
    The agent is unavailable (503) — authorization unavailable"; clicking Retry
    gave **2** invoke calls, cleared the banner, streamed the reply, and left
    exactly **one** YOU bubble in `role=log` ("I'm about to start "Error-budget
    dashboard per team" on Observability Platform…"). Filed identically as
    member #13 and program-owner #21; closed on all three.

13. ~~The "From your work" row is ragged — a short card floats in the middle of
    its track instead of stretching.~~ **Closed 2026-09-07 16:33** — the grid
    carries `items-stretch` (`portal/src/pages/InvokePage.tsx:680`) and
    `items-center` is gone from the live class list, which now reads `flex-row
    gap-2 flex-wrap grid w-full grid-cols-[repeat(auto-fit,minmax(260px,1fr))]
    items-stretch`; computed `align-items` is **`stretch`**. Re-measured as
    u-nora: the grid resolves to `316px 316px 316px` in a 964px column and all
    four cards measure **316 × 132.5px**, with the three on row 1 sharing top
    282.8px and bottom 415.3px exactly (they were 135 / 135 / 115.5px at tops
    282.8 / 282.8 / 292.5). No card is inset on either edge. `flex-row` and
    `flex-wrap` survive as dead classes on a grid, but they no longer drag
    `items-center` with them. Confirmed the same way for program-owner (#22).

14. ~~A blocked card prints the word "Blocked" twice, side by side.~~ **Closed
    2026-09-07 16:33** — the coloured kind pill has been dropped from the card,
    so each card leads with one prose reason line and nothing repeats it. A
    sweep for a lone kind token (`NEXT-UP` / `BLOCKED` / `IN-REVIEW`) across
    every leaf element in `<main>` returned **0 matches**. Re-observed as
    u-nora: the four cards read "Waiting in review", "Next up in this sprint",
    "Not started" and "Blocked" — one line each. `reasonFor`
    (`middleware/src/lib/work-suggestions.ts:119`) still returns a bare
    'Blocked' for that kind, so it remains the least informative of the four
    reason lines, but the duplication this defect was filed for is gone, and
    `next-up` now honestly splits into "Next up in this sprint" vs "Not
    started" on whether the item is in a sprint.

1. **The seed gives the SME persona no sprint grant, so the role's core
   loop cannot be exercised.** `schema/seed_program.sql` — every
   `budget_grants.grantee_person_id` (p-008, p-011, p-051, p-042, p-013,
   p-017, p-019, p-035, p-038, p-055, p-052) is someone other than p-004,
   which `schema/identity_schema.sql` links to u-nora, the only seeded `sme`
   user. Result: the Sprints lens (`/iq/projects?lens=sprints`) says "MY
   SPRINTS 2 · SPEND IN WINDOWS $4.44 of $50.00 granted" but
   `GET /api/sprints?scope=mine` returns `isGrantee: false` on both sprints
   (the $30/$20 envelopes are Layla Hassan's and Nora Chang's), and every
   initiative Nora opens shows "You hold no active sprint grant on this
   initiative". Either give p-004 a grant on spr-obs-s3 / spr-auth-s2 in the
   seed (regenerate via `schema/seeds/generate_program_seed.py`) or the
   audit persona cannot dispatch anywhere.
   Repro: sign in as Nora → Initiatives → Sprints → both rows' Steward is
   not Nora; open Observability Platform → amber no-grant banner.
   **Closed 2026-09-05 21:55** — re-observed as Nora: `GET /api/sprints?scope=mine` returns spr-auth-s2 (Auth Migration) with `isGrantee: true`; the Sprints lens reads "SPEND IN WINDOWS $6.14 of $65.00 granted" and Auth Migration's envelope is $35.00; Auth Migration's detail page shows no no-grant banner and ⚡ Estimate → Authorize reaches the money gates there (see #3).
2. **Person chips open a hover-card on keyboard focus that traps Tab and
   ignores Escape — initiative-detail is unusable past row 1 by keyboard.**
   `/iq/projects/p-observability` —
   `portal/src/pages/project-detail/PersonRef.tsx:110`
   (`onFocus={() => setOpened(true)}` on the ui-components
   `PersonHoverCard`). Tab onto the sponsor chip "Vera Green" and a
   `role="dialog"` "About Vera Green" opens; the next 126 Tabs bounce
   between the chip and the dialog, Escape does not close it, a click
   elsewhere does not close it, and while it is pinned Tab stops moving
   focus anywhere on the page. The same chip is the owner, both SMEs, and
   the assignee of every work-item row, so a second sweep from the Work tab
   dies on row 1's "Nora DaSilva" chip — rows 2–17, "⚡ Estimate", "+ New
   bot" and the Designs/Agents panel are unreachable. Fix direction: open
   on hover/click only (or on focus with Escape + blur closing it and no
   focus trap), and give the chip a real accessible name instead of a
   focus-triggered dialog. Likely needs a ui-components change — queue it
   in `docs/ui-components-queue.md`.
   Repro: open the initiative, click the "Initiatives" breadcrumb, press
   Tab three times, then Escape.
   **Closed 2026-09-05 21:55** — re-observed: a Tab sweep from the breadcrumb reached all 64 tabbable controls on /iq/projects/p-observability with no dialog in the DOM after focusing "Vera Green" or any row's assignee chip; hover opens the non-modal "About Vera Green" card without moving focus and Escape closes it; rows 2–3, ⚡ Estimate, ⚡ New epic, + New bot and the Designs/Agents panel are all reachable.
3. **Dispatch is refused for a different reason than the page gives, and
   the remedy points an SME at a page she cannot open.** Same page —
   the banner reads "You hold no active sprint grant on this initiative —
   ask the release manager for a grant before dispatching", but ⚡ Estimate
   → Authorize → "Authorize run" still POSTs `/api/bots/dispatch-work` and
   the server answers `400 {"error":"no codebase delivers this initiative —
   link one in Codebases"}` (toast "✗ Dispatch failed"). `routes/bots.ts`
   runs `preflightWorkItem` (→ `lib/bot-runner.ts:925 decideDispatch`)
   before `resolveActiveGrant`/`decideGrantScopedDispatch`, so the codebase
   refusal wins, and "Codebases" is `/admin/projects`, which redirects sme
   to /iq/projects. Either evaluate the grant gate first (it is the hard
   gate the docs describe) or disable the Estimate controls when the banner
   is showing, and make the codebase message role-aware.
   Repro: as Nora on Observability Platform, ⚡ Estimate on "Error-budget
   dashboard per team" → Authorize → Authorize run → read the toast.
   **Closed 2026-09-05 21:55** — re-observed: on Observability Platform (no grant) ⚡ Estimate → Authorize → Authorize run now shows, inline in the panel, "No sprint grant on this initiative — you hold no active sprint grant on Observability Platform, so you cannot dispatch against this initiative — ask the release manager for a grant. This isn't a failed run — the run was never started…" (403), the same reason as the banner and no Codebases pointer. On Auth Migration (grant held) the same flow passes the grant and codebase checks ("Delivered by connorhoehnslalom/orgiq-auth-service" is linked) and reaches the money gates: a $0.01 per-run cap returns the run-budget 409 as "Over the cap you set for this run … Dispatch anyway"; with no cap the run clears every gate and ends at "✗ Dispatch failed — the devbox runtime is not deployed" (503, dev:mock has no devbox).
4. **The two dispatch paths disagree about whether an ungranted SME may
   spend.** `/iq/work/findings` "Put a worker on it" on "Aurora cold-start
   recovery has a single holder" (a p-observability finding) succeeded for
   Nora — `routes/work.ts:324 POST /findings/:id/promote` is gated only on
   `requireAction('ManageDevbox')` and enqueued job-mock-1 for the same
   initiative on which `dispatch-work` refuses her for lack of a grant. One
   of the two is wrong; the operating model (`docs/program-operating-model.md`)
   says an SME spends a grant, which argues for the promote route running
   the same `decideGrantScopedDispatch`.
   Repro: Findings → expand "Skill coverage risk" → Put a worker on it →
   toast "✓ Worker queued" → /iq/work/job-mock-1 "queued by u-nora".
   **Closed 2026-09-05 21:55** — re-observed on /iq/work/findings: "Put a worker on it" on "Aurora cold-start recovery has a single holder" (p-observability) → toast "✗ Promote failed — you hold no active sprint grant on Observability Platform, so you cannot dispatch against this initiative — ask the release manager for a grant" (403, identical wording to dispatch-work); on the Cognito-decision finding (p-auth-migration, grant held) → "✓ Worker queued" and /iq/work/job-mock-1 "queued by u-nora · from a finding".
5. **/admin/bots renders in full for sme although the matrix reserves it for
   hr-admin.** `portal/src/App.tsx` (the `/admin/bots` `RequireRole` list),
   `portal/src/pages/work/automateNav.tsx` (`BOTS_ROLES`), and
   `middleware/src/routes/bots.ts:43 readForRolesElseAction([...],
   'ManageBots')` all admit sme because `middleware/seeds/roles/orgiq/sme.cedar`
   grants ManageBots. Three visible entry points lead there: the Automate
   sub-rail's "Configure → Bots", "Manage bots →" on Automate overview, and
   "+ New bot" on initiative-detail. Either MATRIX.txt's `bots` row should
   include sme (and the sme journey should audit it) or the grant/gate is
   too wide — decide which; today the audit's judge and the app disagree.
   Repro: as Nora, navigate to /admin/bots — the 5-bot table renders.
   **Closed 2026-09-05 21:55** — MATRIX.txt now lists bots for sme,program-owner,org-leader,hr-admin; /admin/bots audited as sme in sme/bots.md (its own defects filed as #10/#11); the three entry points are in-matrix, not leaks.
6. **/iq/scores/cohorts shows a raw 403 inside the Scores shell.**
   `portal/src/pages/ScoresCohortPage.tsx` renders "⚠️ Failed to load
   cohorts / 403 Forbidden" under the full Scores sub-rail
   (Overview/Cohorts/Compare/Graph), while `/iq/scores` (`ScoresPage.tsx`)
   explains the same denial ("🔒 Leaderboard access needed…"). Neither route
   carries a `RequireRole` in `App.tsx` (unlike /iq/agents and /iq/prompts),
   so a role with ViewLeaderboard false gets a navigable sub-rail whose
   every entry fails.
   Repro: as Nora, navigate to /iq/scores/cohorts.
   **Closed 2026-09-05 21:55** — re-observed: /iq/scores/cohorts (and /iq/scores/compare) render the same "🔒 Leaderboard access needed — the scoring dashboard is limited to the org-leader and HR Admin roles (the ViewLeaderboard permission)…" state as /iq/scores, with 0 console errors and no raw "Failed to load cohorts / 403 Forbidden".
7. **Ask lists a session that cannot be reopened.** `/iq/invoke` —
   `portal/src/pages/InvokePage.tsx`. After one turn the SESSIONS rail shows
   the conversation (client-side `localSessions`); press "+ New", then click
   that entry: it takes `aria-current="page"` but the transcript stays on
   the empty "Ask Supervisor" starter — no turns, and not the "Nothing has
   been deleted — this is a load failure" notice either, because the history
   fetch for the stored `chat.session.invoke` id returns empty without
   error (`GET /api/sessions` is `{"sessions":[]}` in dev:mock, no memory
   store). The UI needs a state for "listed locally, nothing on the server"
   instead of silently showing a blank starter. Likely dev:mock-only in
   cause; the missing UI state is not.
   Repro: Ask → send anything → + New → click the session in the rail.
   **Closed 2026-09-05 21:55** — re-observed: sent a question, pressed "+ New", clicked the rail entry → it took `aria-current="page"` and the original YOU/SUPERVISOR turns reappeared immediately; after a full reload with no memory store the pane shows the explained "This conversation's transcript isn't stored in this environment … nothing was deleted" state with "Start a new one →" instead of a blank starter.
8. **The no-Aurora work-items fallback does not mirror the seed for
   Observability Platform.** `middleware/src/providers/work-items.ts:584-600`
   hard-codes the `wi-k8s-*` family (epics "Control Plane Upgrade to 1.29"
   and "Worker Node Fleet Upgrade", etcd/kube-apiserver/GPU-node stories
   assigned to Theo Chang, Vera Green, Caleb Turner, Marcus Shah) onto
   `p-observability`, so the initiative's owner opens it to 17 items of
   which 14 are a Kubernetes upgrade the seed (`schema/seed_program.sql`,
   `wi-obs-*` only) never gave it. CLAUDE.md says the fallbacks mirror
   `seed_program.sql` exactly; here they do not.
   Repro: `/iq/projects/p-observability` → Work tab → epic filter lists
   "Control Plane Upgrade to 1.29 (9)" and "Worker Node Fleet Upgrade (5)".
   **Closed 2026-09-05 21:55** — re-observed: /iq/projects/p-observability Work tab lists 3 items, all `wi-obs-e2-*` under the single "SLOs and error budgets" epic; the epic select offers only that epic; `GET /api/graph/projects/p-observability/work` returns `wi-obs-e2` only — no `wi-k8s-*`.
9. **A findings fixture names p-004 "Mia Torres".** The "Flaky-test triage
   is held by two people on the same team" finding on `/iq/work/findings`
   reads "Theo Chang (p-001) and Mia Torres (p-004)", but p-004 is Nora
   DaSilva everywhere else in dev:mock (`middleware/src/mock/people.ts:34`;
   the file's header comment warns the findings cast drifted). Nora reads a
   bus-factor warning about herself under someone else's name.
   Repro: Findings → open → expand "Skill coverage risk" → second finding.
   **Closed 2026-09-05 21:55** — re-observed: the flaky-test finding reads "Theo Chang (p-001) and Nora DaSilva (p-004), both on Platform".

10. **Pause on a bot is a silent no-op in dev:mock — the page toasts "✓ Paused"
    and the bot stays enabled.** `/admin/bots/<id>` → Pause → toast "✓ Paused",
    but the status pill stays "enabled", the button still reads "Pause", and a
    reload shows the same; `POST /api/bots/<id>/pause` answers 200 with
    `enabled: true, pausedReason: null`. `middleware/src/providers/bots.ts`
    `setPausedReason`/`setEnabled` return early under `config.mock.aurora`, so
    `routes/bots.ts` `POST /:id/pause` (566) and `/resume` (577) acknowledge a
    change they never made, and `portal/src/pages/bots/BotDetailPage.tsx:199`
    toasts success on any 2xx. Either persist the flag in the mock store
    (the fixtures already carry `pausedReason`) or have the route answer with
    the real state so the toast cannot lie.
    Repro: as Nora, /admin/bots → obs-nightly-maintenance → Pause → read the
    pill; `GET /api/bots/32970d0a-e28e-5100-8fb0-a5cbb87dac99` → `enabled: true`.
    **Closed 2026-09-06 11:20** — re-observed as u-nora on /admin/bots/32970d0a-…: Pause → toast "✓ Paused", the pill reads "paused", the button reads "Resume", `GET /api/bots/32970d0a-e28e-5100-8fb0-a5cbb87dac99` answers `enabled: true, pausedReason: "paused by operator"`, and a hard reload still shows paused / Resume; Resume restored `pausedReason: null` and the "enabled" pill. The toast no longer lies.

11. **Every bot run-history row links to a job page that never loads.**
    `/admin/bots/<id>` RUNS table → "job →" is `<a href="/iq/work/job-obs-maint-1">`
    (…-2 … -9); `GET /api/work/jobs/job-obs-maint-1` is 404, and
    `portal/src/pages/work/JobDetailPage.tsx:208-213` renders "Loading job
    job-obs-maint-1…" forever because the `useFetch` error is never handled
    (no not-found state). The ids are minted by the mock run generator
    (`middleware/src/providers/bots.ts` ~301, `jobId: job-${prefix}-${seq}`)
    and no job provider knows them. Either seed matching `agent_jobs` rows in
    the mock job store, or leave `jobId` null for runs with no job (the row
    already renders without the link), and give JobDetailPage a 404 state.
    Repro: as Nora, /admin/bots → obs-nightly-maintenance → first "job →".
    **Closed 2026-09-06 11:22** — re-observed as u-nora: the RUNS table's first "job →" (`/iq/work/job-obs-maint-1`) opened a real job page ("done · attempt 1 of 2 · queued by portal · scheduled by obs-nightly-maintenance →", THE ASK = the bot's mission) — all nine links resolve; `/iq/work/job-does-not-exist` renders "Job not found / No job with id job-does-not-exist — it may have been pruned." with "← Back to queue" instead of loading forever.


## Fixed (pending re-audit) — coordinator, 2026-09-05 19:35

- #5: Cedar is the source of truth and `middleware/seeds/roles/orgiq/{sme,program-owner,org-leader,hr-admin}.cedar`
  all grant `ManageBots`, so the app was right and `MATRIX.txt` was wrong —
  the bots surface now lists `sme,program-owner,org-leader,hr-admin`; every
  role that sees it audits it.
- #9: the dev:mock findings fixture (`middleware/src/providers/org-sweeps.ts`,
  `seedMockFindings`) now names p-002 Vera Green, p-004 Nora DaSilva and
  p-005 Sienna Garcia, matching `mock/people.ts`.

## Fixed (pending re-audit) — middleware agent, 2026-09-06 00:05

- **#1 — Nora (p-004, the seeded `sme` login) now holds an active sprint
  grant.** She is owner of Observability Platform, not an SME on it (checked
  `generate_program_seed.py`'s contribution table directly — the guess in the
  Open item was wrong); she IS an SME on Auth Migration (`smes=['p-051',
  'p-004']`), which already has an active sprint (`spr-auth-s2`, ends today).
  Added a second `budget_grants` row there (`bg-auth-3`, $15, alongside
  p-051's $20 — `budget_grants` has no uniqueness constraint on
  sprint+grantee) and regenerated `schema/seed_program.sql`
  (`python3 schema/seeds/generate_program_seed.py`); the derived monthly
  allocation for `p-auth-migration` moved from 60 to 75 to cover it (see the
  formula's comment in the script — it sums the grants inside the month).
  Mirrored exactly in `middleware/src/providers/budgets.ts`
  (`MOCK_GRANTS` + `MOCK_BUDGETS.allocated`). Regenerating also picked up
  unrelated pre-existing drift between the script and the checked-in SQL
  (every initiative's `UPDATE projects` gained `summary`/`sponsor_person_id`,
  columns that already existed in `schema/orgiq_schema.sql` from an earlier
  commit that never regenerated the seed) — left in place per "regenerate,
  never hand-edit."
  Files: `schema/seeds/generate_program_seed.py`, `schema/seed_program.sql`,
  `middleware/src/providers/budgets.ts`.
  Proof: `POST /api/session/login {"userId":"u-nora"}` then
  `GET /api/sprints?scope=mine` → `spr-auth-s2` now carries
  `"isGrantee":true` (`spr-obs-s3`, where she is owner not grantee, correctly
  stays `false`).

- **#3 — the grant-scoped gate now runs before the codebase preflight, and
  the codebase message is role-aware.** `POST /api/bots/dispatch-work`
  (`middleware/src/routes/bots.ts`) fetches the work item once up front,
  runs the grant check (`grantScopedDispatchVerdict`, a new shared helper in
  `middleware/src/lib/bot-runner.ts`) before `preflightWorkItem`'s
  shape/codebase resolution, and hands `preflightWorkItem` the already-fetched
  item plus the caller's role so it never re-fetches and so `decideDispatch`
  can phrase the no-codebase refusal correctly. `/admin/projects` (Codebases)
  turned out to be an **hr-admin-only** page (not just closed to sme) — the
  400 now reads "no codebase delivers this initiative — ask a program owner
  to link a codebase in Codebases" for every role except hr-admin, which
  still gets "link one in Codebases".
  Files: `middleware/src/lib/bot-runner.ts` (`decideDispatch`,
  `preflightWorkItem`, new `grantScopedDispatchVerdict`),
  `middleware/src/routes/bots.ts`.
  Tests: `middleware/src/lib/__tests__/marketplace-dispatch.test.ts` (+2),
  `middleware/src/routes/__tests__/bots-dispatch.test.ts` (+5, new describe
  "grant-scoped authorization runs before the codebase preflight").
  Proof (as Nora, no grant on Observability Platform):
  `POST /api/bots/dispatch-work {"workItemId":"wi-obs-e2-s3","model":"m"}` →
  `403 {"error":"you hold no active sprint grant on Observability
  Platform, so you cannot dispatch against this initiative — ask the release
  manager for a grant"}`. Same call against Auth Migration (where she now
  holds the grant from #1) → `400 {"error":"no codebase delivers this
  initiative — ask a program owner to link a codebase in Codebases"}` (mock
  mode's `listAgentProjects()` returns `[]` unconditionally — a second,
  pre-existing gap; see below).

- **#4 — `POST /api/work/findings/:id/promote` now runs the same
  grant-scoped gate as dispatch-work.** Extracted into
  `grantScopedDispatchVerdict` (see #3) precisely so both dispatch surfaces
  share one verdict; the promote route resolves the finding's initiative via
  a new `initiativeIdForFinding` helper (`middleware/src/providers/
  org-sweeps.ts`) that normalizes the three shapes sweeps actually use
  (`evidence.initiatives[0]`, `evidence.initiative`,
  `evidence.candidateInitiative`, or a lab signal's `evidence.initiativeId`)
  — a finding with none of those is unscoped and the gate does not fire,
  matching the money gates' own "no context is not a denial" posture.
  `POST /api/work/findings/analyze-batch` was checked and does not enqueue
  agent work (only graph-link proposals via `providers/doc-linker.ts`), so it
  needed no gate.
  Files: `middleware/src/routes/work.ts`, `middleware/src/providers/
  org-sweeps.ts` (new `initiativeIdForFinding`).
  Tests: new `middleware/src/routes/__tests__/work-findings-promote.test.ts`
  (6 tests: 403 ungranted, exact wording parity with dispatch-work, 201 when
  granted, 201 when the finding is unscoped, org-leader bypass, 404 before
  any grant check).
  Proof (as Nora): promoting "Aurora cold-start recovery has a single
  holder" (p-observability, no grant) → `403`, same text as the dispatch-work
  403 above; promoting the Cognito-decision finding (`candidateInitiative:
  'p-auth-migration'`, where she now holds a grant) → `201`.

- **#8 — the no-Aurora work-items fallback no longer fabricates a
  Kubernetes-upgrade epic on Observability Platform.** The `wi-k8s-*` family
  (16 items, `middleware/src/providers/work-items.ts`) was hard-coded onto
  `p-observability` and assigned to people who are not even that
  initiative's seeded owner/SMEs (Theo Chang, Vera Green, Marcus Shah, Caleb
  Turner vs. the real p-004/p-008/p-011) — removed outright rather than
  relocated, since no seeded initiative has a Kubernetes-upgrade epic to move
  it to (also dropped its 7 `MOCK_PROGRAM_FIELDS` sprint-membership entries).
  `p-observability`'s Work tab now shows exactly the `wi-obs-*` items
  `schema/seed_program.sql` actually gives it (4 today — the curated subset
  already mirroring the seed; the other two epics real Observability Platform
  carries, OpenTelemetry rollout and cost-aware telemetry, are not yet
  represented in the fallback at all, which is a real gap but a different,
  additive one from the wi-k8s-* contamination this defect named).
  Files: `middleware/src/providers/work-items.ts`.
  Tests: new `middleware/src/providers/__tests__/work-items-seed-parity.test.ts`
  — parses `schema/seed_program.sql`'s own `INSERT INTO work_items` statements
  (not a hand-copied table) and asserts the mock fallback's project id agrees
  with the seed's for every id both know about, plus a standing guard that
  `wi-k8s-*` never reappears.
  Proof: `GET /api/graph/projects/p-observability/work` → 4 items, all
  `wi-obs-*`, zero `wi-k8s-*`.

All four verified with `cd middleware && npx tsc --noEmit && npm test` green
(115 suites / 1700 tests, up from 113/1685) and live curls against
`dev:mock` on :3001 as `u-nora`, `u-release`, and `u-rachel`.

## Fixed (pending re-audit) — portal agent, 2026-09-05 20:10

- #2: `PersonRef.tsx` no longer wraps the person chip in the library
  `PersonHoverCard`/`InlinePopover` — both open the panel on a bare focus
  event and, once open, always move focus into the panel and trap Tab there
  (even with zero focusable children, where Tab is simply swallowed). It now
  runs its own open/hover/pin state (`personCardState.ts`, a pure reducer
  with unit tests) and a locally composed, non-modal panel
  (`PersonCardFrame.tsx`) that never takes focus: focus alone never opens
  the card, hover opens it after a short delay, Enter (on the linkable
  variant) keeps its native "navigate to the graph" action, Space toggles a
  pin, and Escape closes whatever is open and — since focus was never moved
  away from the trigger in the first place — is trivially already back on
  it. Tab now moves through a table of person chips exactly like any other
  row of plain links, whether a card is open, pinned, or closed. Queued the
  gap in `docs/ui-components-queue.md` (two rows: the non-trapping-popover
  primitive itself, and the `Stack`/`Card`/`InlinePopover` not-`forwardRef`
  gap that forced the position math into an imperative ref effect instead of
  a JSX `style=` prop).
  Verified: `/iq/projects/p-observability` → Tab onto "Vera Green" → focus
  moves there with no dialog opening; Tab continues to the next control;
  Space opens (pins) the card without moving focus; Escape closes it.
- #6: `/iq/scores/cohorts` and `/iq/scores/compare` now run the same
  capability guard `ScoresPage.tsx` already had — ask `ViewLeaderboard` via
  `useCapabilities()` before firing the request at all, and never render the
  server's raw denial. The explained state itself is now one component,
  `components/scores/LeaderboardAccessNeeded.tsx`, used by all three pages;
  a fallback (`isLeaderboardForbiddenError`) also catches the case where the
  capability probe said yes but the server still 403s, matched against the
  exact `"403 ..."` status-prefix shape `useFetch` produces, never a loose
  substring test. Guards on response shape/status throughout, never on
  presence-of-an-error.
  Verified: as Nora, `/iq/scores/cohorts` and `/iq/scores/compare` both show
  "🔒 Leaderboard access needed" — the same copy as `/iq/scores` — with no
  console 403 and no raw "Failed to load" text.
- #7: `InvokePage.tsx`'s local `localSessions` cache now stores each
  session's full message list (not just its title), and the hook's
  `historyFetch` serves that cache first — a session started in this tab is
  never re-fetched from the (possibly memory-less) backend, so reselecting
  it after "+ New" restores instantly from local state. When a *different*
  reload path (a genuine `GET /api/sessions/:id/events` load, not the local
  cache) resolves with zero events for a session that was actually
  selected, the transcript pane now shows an `EmptyState` — "This
  conversation's transcript isn't stored in this environment" with a "Start
  a new one" action — instead of silently falling through to the generic
  "Ask {agent}" starter, which read as an empty conversation rather than an
  environment that cannot answer for it.
  Verified: Ask → send a message → "+ New" → click the earlier session in
  the rail → the original turns reappear immediately (served from
  `localSessions`, no request needed); a session known only to the server
  with a genuinely empty transcript shows the new explained empty state
  instead of a blank starter.

## Fixed (pending re-audit) — bots/jobs agent, 2026-09-06 01:50

- **#10 — pause/resume in dev:mock now actually mutate the mock bot,
  instead of no-opping and reporting success anyway.**
  `providers/bots.ts` `setPausedReason()` and `updateBot()` both returned
  early under `config.mock.aurora`, so `routes/bots.ts`'s `/pause` and
  `/resume` handlers re-read the SAME unchanged bot right after "changing"
  it — the response (and the portal's "✓ Paused" toast) always said
  `enabled: true, pausedReason: null` no matter what was asked. Both
  functions now mutate the `MOCK_BOTS` singleton in place (the same array
  `listBots()`/`getBot()` read), matching real (non-mock) semantics exactly:
  pause sets `pausedReason` only (never forces `enabled` false — that is
  also what the real Aurora-backed route does), and resume clears
  `pausedReason` and sets `enabled: true`, which also correctly un-parks a
  bot that started disabled straight from the seed (`cost-anomaly-sweep`).
  Files: `middleware/src/providers/bots.ts` (`setPausedReason`,
  `updateBot`).
  Tests: new `middleware/src/routes/__tests__/bots-pause-resume-mock-mode.test.ts`
  (5 tests: pause sets a real reason, a custom reason is honored, resume
  clears it and a live GET reflects the same state, resume re-enables a
  seed-parked bot, 404 on an unknown id) — through the real provider, not
  seam-mocked, following the `bots-dispatch-mock-mode.test.ts` pattern.
  Proof (dev:mock, as u-rachel/hr-admin), obs-nightly-maintenance
  (`32970d0a-e28e-5100-8fb0-a5cbb87dac99`):
  before → `enabled: true, pausedReason: null`;
  `POST /pause {}` → `enabled: true, pausedReason: "paused by operator"`,
  a follow-up `GET` shows the same (not just the POST response echoing the
  request); `POST /resume {}` → `enabled: true, pausedReason: null`, and a
  follow-up `GET` again agrees.

- **#11 — every mock bot run's `jobId` now resolves at
  `GET /api/work/jobs/:id`.** `bots.ts`'s mock run generator (`genRun`)
  mints ids like `job-obs-maint-1` for every run in `MOCK_BOT_RUNS`, and
  `BotDetailPage.tsx`'s run-history table links each row to
  `/iq/work/<jobId>`; no job provider had ever heard of those ids, so the
  route 404'd and `JobDetailPage.tsx` had no way to tell "genuinely still
  loading" apart from "this id will never resolve" — it rendered "Loading
  job …" forever. Fixed on both ends:
  - `providers/agent-jobs.ts` now exports `MOCK_BOT_RUNS` from
    `providers/bots.ts` (also exported it there) and, at mock-mode module
    load, mints one `AgentJob` per run that carries a `jobId`
    (`seedMockJobsFromBotRuns`) — same `kind`/title/payload shape a real
    dispatch enqueues (`lib/bot-runner.ts` `fireBot`: `kind: 'devbox:task'`,
    title = bot name, payload carries prompt/model/botId, `bot_id` column
    set), with `status` derived generically from the run's own status
    (`done`→`done`, `failed`→`failed`, `skipped`→`cancelled`) rather than
    hard-coded, and `botName`/`botTrigger` resolved from the same bot so the
    job page's "scheduled by `<bot>` →" provenance link is correct.
  - `portal/src/pages/work/JobDetailPage.tsx` now reads `error` off
    `useFetch` and gives it a real not-found state: a 404
    (`jobFetchStatus.ts` → `isNotFoundFetchError`, guarded on the numeric
    status prefix, never a message substring) renders the library
    `EmptyState` — "Job not found … it may have been pruned" — with a
    "← Back to queue" action to `/iq/work`; any other fetch error renders
    `ErrorState` with a Retry action; only the genuine no-error/no-data case
    still shows the loading line. `useFetch` never clears stale `data` on a
    poll error, so this only fires on a first-load failure, never mid-poll
    on a job that already loaded once.
  Files: `middleware/src/providers/bots.ts` (exported `MOCK_BOT_RUNS`),
  `middleware/src/providers/agent-jobs.ts` (`seedMockJobsFromBotRuns`,
  `jobStatusForRunStatus`), `portal/src/pages/work/JobDetailPage.tsx`,
  new `portal/src/pages/work/jobFetchStatus.ts` (+ test beside it).
  Tests: new `middleware/src/providers/__tests__/bots-run-job-parity.test.ts`
  (3 tests: every run with a jobId resolves with matching status/bot
  provenance, a known id has the right kind/title, an id nothing minted
  still 404s), new `portal/src/pages/work/__tests__/jobFetchStatus.test.ts`
  (3 tests).
  Proof (dev:mock, as u-rachel): obs-nightly-maintenance's run list starts
  `["job-obs-maint-1","job-obs-maint-2","job-obs-maint-3", …]`;
  `GET /api/work/jobs/job-obs-maint-1` → `200`, full job with
  `botName: "obs-nightly-maintenance"`, `status: "done"`; every id up to
  `job-obs-maint-9` and `job-auth-dep-8` (a different bot's run) → `200`;
  `GET /api/work/jobs/job-does-not-exist` → `404` (a real store, not a
  wildcard).

Verified together with `cd middleware && npx tsc --noEmit && npm test`
(124 suites / 1738 tests, up from 122/1730) and
`cd portal && npx tsc --noEmit && node --test 'src/**/__tests__/*.test.ts'`
(543/543) `&& npx vite build` (clean), plus
`bash scripts/validate-orgiq-audit.sh --quick` component-discipline section
(all ✓, budget 0/0).


## Fixed (pending re-audit) — coordinator, 2026-09-07 14:45

- #12 (Retry dead for non-composer turns): `lastTurnRef` was set in exactly
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
