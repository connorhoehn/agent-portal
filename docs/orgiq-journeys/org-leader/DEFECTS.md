# org-leader defects

Role: org-leader, user u-vera (Vera Green, p-002 — Principal Engineer, owner
of Auth Migration, sponsor of Observability Platform; the release-manager
persona). Audited 2026-09-05 20:03–20:36 local against the dev:mock
middleware at 1552px. Items marked "reproduces <role> #N" are already filed
under that role and are listed here because they reproduce for org-leader.

Fixed since earlier roles' passes and re-verified here as **fixed** for
org-leader (not repeated below): member #1 (mouse-only rows on Initiatives /
Library / Promotions / Designs), member #2 (dead status pills), member #5 and
sme #7 / program-owner #17 (Ask's session rail and reopen), member #6
(Explore no-match state), hr-admin #1 (Promotions drawer), hr-admin #2
(Budgets card stack), hr-admin #3 (Scores table at 795px — now 455px),
hr-admin #6 (Architecture nodes unfocusable), hr-admin #7 (Invocations always
empty, and Health's link now carries ?status=error), hr-admin #8 (Prompt
Studio raw error), hr-admin #9 / program-owner #10 (Bots count), sme #2 /
program-owner #14 (person-chip focus trap), sme #9 (the "Mia Torres" name),
program-owner #2 (the "0 active · 1 in flight" tile), program-owner #4
(Findings read-only for a dispatching role), program-owner #6 (⌘I naming a
role it denies), program-owner #7 (unlisted initiatives on Budgets — all 14
list now, with "Set budget"), program-owner #11 (Board nested anchors),
program-owner #12 (owner menu ignoring Escape), program-owner #16 (bounce to
/select), program-owner #18 (Budgets absent from ⌘K).

## Open

#24, #29 and #30 were all re-audited and closed — see the Closed section.
Nothing is open for this role right now.

## Follow-up (filed with a reason, not blocking a surface verdict)

These are real and reproducible, and each is recorded here so it is not lost.
None of them stops the surface answering the question it exists for, and each
is either a second-order route or a cosmetic squeeze at the audit width, so
they are filed rather than left Open.

## Closed

30. **Ask's work starters clip the initiative name — the one word that says
    which initiative the card is about.** `/iq/invoke` —
    `portal/src/pages/InvokePage.tsx` (the `askSuggestions.slice(0, 4)` block,
    laid out on `grid-cols-[repeat(auto-fill,minmax(220px,1fr))]`) and the
    `SuggestionCard` reason line (`text-[11px] text-text-secondary truncate`)
    plus its title (`line-clamp-2`). Filed for hr-admin as **#31**; it
    reproduces for org-leader and is filed here because this is the role whose
    fourteen initiatives make the missing word matter most.
    Observed live as u-vera at 1552px on 2026-09-07: the four cards resolve to
    233px each inside a 956px band that itself sits in a 1304px content column,
    leaving roughly 350px of that column empty beside them. At 233px all four
    reason lines overflow and are ellipsised — "Not started on Auth Migr…",
    "Blocked on Observabilit…", "Waiting in review on L…", "Waiting in review
    on M…" — and two of the four also clamp the question. Measured per node
    with `scrollWidth > clientWidth` / `scrollHeight > clientHeight`, not by
    eye. The reason line is the only place a card names its initiative, so a
    release manager cannot tell which of fourteen a card is about without
    sending the question. The full string IS in each card's `aria-label`, so a
    screen-reader user gets what a sighted user does not.
    Repro: `/iq/invoke` at 1552px as u-vera → the four "FROM YOUR WORK" cards →
    every reason line ends in an ellipsis.
    Fix shape: let the band use the content column's width (the grid is already
    auto-fill, so the cap is the band, not the cards), or drop to three cards
    at a readable width, or put the initiative name where it can wrap.
    **Closed 2026-09-07 14:10** — fixed by another agent at 14:03, mid-audit,
    and re-observed here on the fixed build as u-vera (org-leader) at 1552px.
    Two changes in `InvokePage.tsx`: the grid moved from
    `repeat(auto-fill, minmax(220px, 1fr))` to
    `repeat(auto-fit, minmax(260px, 1fr))` with `w-full`, and each card is now
    passed `context={sg.initiativeName}` so the initiative rides its own
    untruncated slot instead of the tail of the reason line. Measured after the
    change: cards are 313px each (grid computes to 313.3px x 3), and a per-node
    `scrollWidth > clientWidth` / `scrollHeight > clientHeight` sweep across all
    four cards returns **zero** clipped nodes for hr-admin and zero for
    org-leader. The cards read in full — "Not started / Who has context on
    \"Legacy SSO decommission\"? / Auth Migration" — with
    the reason line reduced to the bare kind. Cost of the fix: the four cards
    now wrap 3+1 inside the 956px band rather than sitting four across; the
    orphan on row two is less tidy but everything is legible and the whole
    starter, "OR TRY:" block and composer still fit above the fold (last card
    bottom 561px, composer bottom 853px, viewport 913px).

### 29. Prompt Studio's two header buttons wrapped, and the ARN line identified nothing — CLOSED 2026-09-06

Re-observed as **u-vera (org-leader) at 23:33** and independently as **u-rachel
(hr-admin) at 23:35**, Chrome at 1560px (innerWidth 1560, innerHeight 856),
dev:mock, on `/iq/prompts`. Both halves of the defect landed; the numbers are
identical for the two roles.

**Half 1 — the buttons are one line each.** The two labels are now one word
apiece at `size="sm"`, with the fuller sense moved into `title`. The 420px
header aside no longer runs out of room:

| element | box (this pass) | box (when filed) |
|---|---|---|
| version `<select>` | 1092 → 1408.3, **316.3 × 28px** | 246px wide |
| `[data-prompt-test-trigger]` | 1416.3 → 1462.2, **45.9 × 26px** | 61 × 58px ("Test" over "▶") |
| `[data-prompt-edit-trigger]` | 1470.2 → 1512, **41.8 × 24px** | 97 × 56px ("Edit / new" over "version") |

`Range.getClientRects()` over each button's contents returns exactly **1 rect**
(computed line-height 16px, padding 4/4), so each label genuinely occupies one
line rather than merely fitting a shorter box. 26px and 24px against the
select's 28px is the "height ≈ the select's" the follow-up asked for — the
three controls read as one row. The `title` attributes carry the lost words:
"Test this prompt against a live model" and "Edit the template and publish a
new version".

**Half 2 — the ARN shows its identifying tail.** `arnTail()` keeps the last 28
characters, so the metadata line now differs per prompt:

- orgiq-supervisor → renders `…pervisor-system-prompt:DRAFT`
- orgiq-advisor → renders `…-advisor-system-prompt:DRAFT`
- orgiq-scoring → renders `…-scoring-system-prompt:DRAFT`

Three prompts, three different strings, where the old head-truncated 200px box
read `arn:aws:bedrock:us-east-1:000…` byte-for-byte identically for all six.
The **full ARN is still in the element's `title`** — verified
`arn:aws:bedrock:us-east-1:000000000000:prompt/mock-supervisor-system-prompt:DRAFT`,
`…/mock-advisor-system-prompt:DRAFT` and `…/mock-scoring-system-prompt:DRAFT`.

The overlap the ARN cap was originally for stays closed: the ARN `<T>` occupies
**732 → 924.1 (192.1 × 16.5px, 1 line)** and the select's left edge is at
**1092** — a **167.9px clear gap**. The rendered tail is not itself re-clipped
(`scrollWidth` 192 = `clientWidth` 192), so the ellipsis in front of it is
`arnTail`'s own, not a second truncation by the box.

Both roles' `prompt-studio.md` now read `verdict: pass`, with 0 console errors,
all tabbable controls reachable (48 for org-leader, 51 for hr-admin) and
Test/Edit each returning focus to their trigger on Escape.

Re-observed as fixed on the 2026-09-06 11:20–11:45 final sweep (signed in fresh as u-vera, org-leader, Chrome at 1552px, dev:mock):

1. **Escape with the inline "Grant envelope" form open closes the whole sprint
   drawer and drops focus.** `/iq/projects?lens=sprints` — the sprint drawer
   (`portal/src/pages/sprints/`), Envelopes tab. Enter on "Sprint 98" opens the
   drawer; plain Escape closes it and returns focus to the row button
   (correct). Open "+ Grant envelope" (Grantee / Amount / Note / Grant / Cancel)
   and press Escape: the form is not cancelled — the entire drawer closes and
   `document.activeElement` is the app shell root, not the row. Same shape on
   initiative-detail's "Estimate & authorize" drawer (Escape → focus on the
   shell, not the ⚡ Estimate button).
   Repro: Initiatives → Sprints → Enter on Sprint 98 → Envelopes → + Grant
   envelope → Escape → check activeElement.
    **Still reproduces 2026-09-05 23:45** — still reproduces (sprints half, reduced): Sprints lens → Enter on "Sprint 98" → Envelopes → Tab to "+ Grant envelope" → Enter opens the Grantee / Amount / Note / Grant / Cancel form but focus falls to `<body>` (the button that had focus is replaced by the form), a following Tab lands on the drawer's Close button rather than in the form, and Escape then closes the whole drawer — the form's own Escape handler never sees the key because the form never holds focus on the keyboard path. Improvement: focus now returns to the "Sprint 98" row button instead of the app shell. The initiative-detail half is fixed: Escape from the "Estimate & authorize" drawer returns focus to the row's ⚡ Estimate button (`data-estimate-trigger="wi-obs-e2-s3"`).
    **Closed 2026-09-06 11:41** — re-observed as u-vera at 1552px, both halves.
    Sprints lens: Enter on "Sprint 98" opens the drawer with focus on its Close
    button; Envelopes tab → focus "+ Grant envelope" → Enter now moves focus
    INTO the form (`document.activeElement` is the Grantee `<select>`, reading
    "Select… / Nora DaSilva · owner / Layla Hassan …"), and Escape cancels ONLY
    the form — `Grantee` leaves the DOM while the drawer stays mounted
    (`[role=dialog]` count 1). A second Escape closes the drawer and returns
    focus to the "Sprint 98" row button. Initiative-detail half: on
    /iq/projects/p-observability, Enter on the row's ⚡ Estimate button
    (`data-estimate-trigger="wi-obs-e2-s3"`) opens "Estimate & authorize" with
    focus on its Close button, and Escape closes it with
    `document.activeElement` back on that same trigger. Residual, filed as a
    follow-up rather than kept open: cancelling the grant form with Escape
    leaves focus on `<body>` instead of returning it to "+ Grant envelope".

10. **Scores: the skill-search popover opens on bare focus with an empty
    query, swallows Tab and Escape, and eats every keystroke after the
    first.** `/iq/scores` — `portal/src/components/scores/SkillFilter.tsx` (the
    InlinePopover added for hr-admin #5). Tab onto "Search skills" → a
    `role=dialog` "Skill suggestions" opens reading `No skills match ""`,
    moves focus to its "Clear search" button, and from then on Tab produces no
    focus movement and Escape leaves the dialog count at 1; the 26 controls
    after it (Weighting, Department, 12 compare checkboxes, 12 row buttons,
    "How scoring works") are unreachable. Typing "zzznoexistskill" yields
    `No skills match "z"` — only the first character reaches the input. The
    popover must open only on a non-empty query and must never take focus.
    Repro: /iq/scores → Tab to the search box (or type two letters into it).
    **Still reproduces 2026-09-05 23:45** — still reproduces (one half): the open-on-focus trap is gone — Tab passes through "Search skills" with 0 dialogs, Tab from a query goes input → "Clear skill search" → "Clear search" → Weighting, and Escape inside the input closes the panel with focus kept — but the input node is REPLACED on the first keystroke: click the box, press `z`, the value is "z", `document.activeElement` is `<body>` and the input now in the DOM is a different node from the one that was focused, so every further key goes to the body and the query never gets past one character (`No skills match "z"`). A different mechanism from the InlinePopover the fix removed; same symptom for the person typing.
    **Closed 2026-09-06 11:28** — re-observed as u-vera at 1552px. Tab passes
    through "Search skills" with 0 `role=dialog` open. Clicking the box and
    typing `kuber` leaves the value "kuber", `document.activeElement` still the
    SAME input node (identity-checked against the node captured before the
    first keystroke), and the panel reading `No skills match "kuber"`; a
    15-character query (`zzznoexistskill`) lands in full with focus kept. Escape
    inside the input closes the suggestion panel, keeps the query and keeps
    focus in the input. The full 59-control Tab sweep reaches all 59, so the 26
    controls the old trap swallowed are reachable again.

11. **Scores: three scales for one score.** `/iq/scores` — the stat strip
    reads "AVG COMPOSITE 1 · TOP SCORE 1", every row reads INFLUENCE 1 ·
    EXPERTISE 1, the COMPOSITE column reads 94 / 90 / 86 …, and the detail
    panel's "Why this score?" says "Influence (PageRank) 47"
    (`portal/src/components/scores/StatCards.tsx`, `Leaderboard.tsx`,
    `middleware/src/mock/scores.ts` — normalised 0–1 inputs shown beside a
    0–100 composite). A leader cannot tell whether Hiro Green is a 1, a 47 or
    a 94.
    Repro: /iq/scores → compare the strip, the first row and its detail.
    **Still reproduces 2026-09-05 23:45** — still reproduces (reduced): the strip ("AVG COMPOSITE 80 · TOP SCORE 94"), every row (Hiro Green INFLUENCE 93 · EXPERTISE 96 · COMPOSITE 94) and the panel's new "Composite 94" line agree — but the panel's "Influence (PageRank) 47" sits beside a row that says INFLUENCE 93 for the same person.
    **Closed 2026-09-06 11:28** — re-observed as u-vera at 1552px: the strip
    reads AVG COMPOSITE 80 · TOP SCORE 94, Hiro Green's row reads INFLUENCE 93 ·
    EXPERTISE 96 · COMPOSITE 94, and his detail panel now reads "Composite 94"
    and "Influence 93" — one 0–100 scale in all three places. The panel's old
    "Influence (PageRank) 47" line is gone.

12. **Scores: opening and closing a row never returns focus to the row.**
    `/iq/scores` — Enter on the "Hiro Green" name button opens the detail
    panel with focus on `<body>`; Escape closes it and focus stays on
    `<body>` (`portal/src/pages/ScoresPage.tsx` `selectPerson` focus-return).
    Repro: focus a row button → Enter → Escape → check activeElement.
    **Still reproduces 2026-09-05 23:45** — still reproduces: Tab to the "Hiro Green" button (id `score-row-p-023`) → Enter opens the panel with focus on `<body>`; Escape closes it and focus stays on `<body>`; the button node is remounted on both transitions and the fresh `#score-row-p-023` exists but is never focused.
    **Closed 2026-09-06 11:28** — re-observed as u-vera at 1552px: focus
    `#score-row-p-023` ("Hiro Green"), press Enter — the detail panel opens and
    `document.activeElement` is still `BUTTON#score-row-p-023`; press Escape —
    the panel closes and focus is still on that same row button. The row button
    is no longer remounted out from under the focus on either transition.

14. **Health promises 25 errored invocations; the list it opens has 6.**
    `/admin/observability/summary` "Read the failures on … — 25 errored
    invocations in the last 24h" → `/admin/observability/invocations?status=error`
    lists 6 rows (`middleware/src/mock/invocations.ts` carries one error row
    per erroring agent). The number and the list disagree.
    Repro: Health → Enter on the second action card → count rows.
    **Still reproduces 2026-09-05 23:45** — still reproduces (reduced): Health promises "25 errored invocations in the last 24h"; the Runs page it opens is "Live · last 50 invocations" and lists 23 of them (Ingestion 10, Search 7, Supervisor 3, Advisor 2, Graph Builder 1) — `GET /api/observability/recent-invocations?limit=50` carries 23 error rows, so two of the day's 25 fall outside the tail the page shows.
    **Closed 2026-09-06 11:33** — re-observed as u-vera at 1552px: Health's
    card still promises "25 errored invocations in the last 24h", and the Runs
    page it opens (`?status=error`) now lists exactly 25 rows.
    `GET /api/observability/recent-invocations?limit=50` returns 50 rows of
    which 25 carry `error` — `middleware/src/mock/invocations.ts` pads each
    agent's error rows up to its Health `errorsLast24h` and packs every error
    into a recent time band so none can fall past the 50-row window. The number
    and the list agree.

22. **Every invocation row now links to a detail page that 404s.** `/admin/observability/invocations` → Enter on the first row's WHEN link (`/admin/observability/invocations/mock-inv-33`) renders "Could not load invocation / id: mock-inv-33 / 404 Not Found / ← Back to search"; `GET /api/observability/invocations/mock-inv-33` returns `404 {"error":"invocation not found"}` for every id in the dev:mock tail (`middleware/src/mock/invocations.ts` rows are not served by the detail route). The persona sent from Health to "read the failures" can now open a row and still cannot read one.
    Repro: Health → Read the failures → Tab to any WHEN link → Enter.
    **Closed 2026-09-06 11:33** — re-observed as u-vera at 1552px: focus the
    first row's WHEN link (`/admin/observability/invocations/mock-inv-0`) and
    press Enter — the detail page renders, headed "Supervisor", breadcrumb
    "Operate › Health › Runs › Invocation mock-inv-0", with the trace chain,
    the tool-call timeline (the red `agent_run` bar, 4.98s), memory operations,
    the prompt, the judge block and raw metadata. `GET
    /api/observability/invocations/mock-inv-0` returns 200 with an
    `invocation` + `toolCalls` envelope; a genuinely unknown id
    (`mock-inv-nope`) still reads as not-found — "Could not load invocation /
    id: mock-inv-nope / 404 Not Found / ← Back to search" — rather than as an
    outage. Residual, filed as a follow-up: the error sentence itself reaches
    the detail page only as the `title` tooltip of the tool-call bar.

23. **Prompt Studio's list column is drawn under the Prompt Management sub-rail, clipping the first character of every prompt.** `/iq/prompts` — the studio's list column (`w-60 flex-none`) starts at x = 396px while the page's content box (its inner `main.p-6`) starts at 420px; `document.elementFromPoint(419, 252)` returns the sub-rail's `<aside>`, so the rows render as "rgiq-supervisor-system-prom…" / "nds people, skills and decisions in th…" (`portal/src/pages/capabilities/PromptsPage.tsx` / `PromptsFrame.tsx` under the new shell padding).
    Repro: as Vera, /iq/prompts → read the first letters of the prompt names, or zoom the list column.
    **Closed 2026-09-06 11:39** — re-observed as u-vera at 1552px: the
    Prompt Management sub-rail's `<aside>` now ends at x = 444 and the studio's
    239px list column starts at x = 468 — a 24px gap, not a 24px overlap — and
    `document.elementFromPoint(469, 238)` returns the prompt row `<button>`
    itself rather than the aside. Every name reads from its first character
    ("orgiq-supervisor-system-prom…", truncated at the END), and the
    descriptions read "Routes an org question to the right su…" rather than
    "nds people, skills and…".

Re-observed as fixed on the 2026-09-05 23:22–23:45 re-audit sweep (signed in fresh as u-vera, org-leader, Chrome 152 at 1552px, dev:mock).

2. **The Initiatives list and the initiative detail disagree about points.**
   `/iq/projects` says Observability Platform is "34/72 pts · 47%";
   `/iq/projects/p-observability` says "POINTS DONE 0% · 0/10 pts" over the 3
   `wi-obs-*` items its Work tab lists. Same shape as program-owner #3, on the
   initiative the matrix names: the list's rollup and the detail's rollup come
   from different data (`middleware/src/providers/work-items.ts` fallback
   carries only part of the seed for this initiative).
   Repro: Initiatives → read the Observability Platform PROGRESS cell → open
   it → read the header tile.
    **Closed 2026-09-05 23:45** — list reads "0/10 pts · 0%" for Observability Platform and /iq/projects/p-observability reads "POINTS DONE 0% · 0/10 pts" over the same 3 wi-obs-* items.

4. **The Automate overview's bot roster is inert and "Manage bots →" is
   missing for org-leader.** `portal/src/pages/work/QueuePulse.tsx:52`
   `BOT_PAGE_ROLES = ['sme','program-owner','hr-admin','admin']` omits
   org-leader, so the five roster rows render as plain text and the toolbar's
   "Manage bots →" link is not rendered — while `automateNav.tsx`'s
   `BOTS_ROLES` and `App.tsx`'s `/admin/bots` guard both admit the role
   (ManageBots true). A release manager sees "cost-anomaly-sweep · paused"
   and has no path from this page to the bot.
   Repro: as Vera, /iq/work → Tab through the roster → no row is focusable;
   compare program-owner's automate.md (rows are `<a href="/admin/bots/…">`).
    **Closed 2026-09-05 23:45** — /iq/work roster rows are `<a href="/admin/bots/<id>">` for Vera (all five reached by Tab) and "Manage bots →" renders in the roster toolbar.

5. **The Queue's empty state points at controls that do not exist.**
   `/iq/work/queue` — `portal/src/pages/work/QueuePage.tsx:250` renders "No
   jobs yet — assign a work item below, or write one from scratch." with
   nothing below it and no write-from-scratch control on the page (the only
   controls are the State pills). Same dead-reference shape as member #9.
   Repro: Automate → Queue with the seed's empty queue.
    **Closed 2026-09-05 23:45** — `QueuePage.tsx`'s all-filter copy for a role without ManageDevbox now reads "No jobs yet — promote a finding or dispatch work from an initiative" with links to /iq/work/findings and /iq/projects; the seed now holds 41 jobs so that state could not be rendered, and the reachable empty state (Failed (DLQ) pill → "Nothing dead-lettered") names no missing control.

6. **Automate overview: the bots tile does not match its roster, and the
   description line has no spaces around its links.** `/iq/work` —
   `portal/src/pages/work/QueuePulse.tsx` counts only enabled bots ("BOTS ON
   THIS QUEUE 4") above a roster of 5; `WorkHomePage.tsx:204-207` renders
   "put work on thequeue, computers in theComputer Labdrain it" (the `<T wrap>`
   description collapses the whitespace around the inline `<Link>`/`<T>`).
   Repro: /iq/work → read the fourth tile and the sentence under the strip.
    **Closed 2026-09-05 23:45** — the tile reads "BOTS ON THIS QUEUE 5 · 1 paused" over a five-row roster, and the sentence renders "put work on the queue, computers in the Computer Lab drain it" with spaces around the inline link.

7. **Findings: a raw kind id is used as a group heading.** `/iq/work/findings`
   → "dismissed" pill → the group reads "lab-signal · 1 finding" where every
   other group has a human title ("Skill coverage risk", "Decisions with no
   owner") — `portal/src/pages/work/FindingsPage.tsx` group-title lookup has
   no entry for the lab-signal kind.
   Repro: Findings → dismissed.
    **Closed 2026-09-05 23:45** — the dismissed pill's group heading reads "Lab signals · 1 finding"; the open groups read "Bus factor", "Orphan decisions", "Stale docs".

8. **Promotions: the candidate title is centred while its sub-line is
   left-aligned.** `/iq/promotions` — `portal/src/pages/promotions/
   PromotionsPage.tsx` CANDIDATE cell: the title button is centred in the
   widest column and "3 observations across 2 sessions" sits at the left edge
   beneath it, so the four titles zig-zag. Cosmetic.
   Repro: open Promotions, read the first column.
    **Closed 2026-09-05 23:45** — the CANDIDATE title button computes text-align left and its left edge (217px) sits over the "3 observations across 2 sessions" sub-line (217px) on all four rows.

9. **Budgets: Escape on the inline allocation editor loses focus.**
   Reproduces program-owner #8 for org-leader: `/admin/budgets` → Enter on
   "$60.00" opens the number input (the table header no longer scrolls away —
   that half is fixed) → Escape closes it and `document.activeElement` is
   `<body>` instead of the "$60.00" button (`portal/src/pages/budgets/`).
   Repro: Budgets → Tab to $60.00 → Enter → Escape → check activeElement.
    **Closed 2026-09-05 23:45** — Budgets → Tab to "$60.00" → Enter opens the number input (thead stays at 237px) → Escape closes it and `document.activeElement` is the "$60.00" button, attached to the document.

13. **Architecture and Health disagree about whether anything ran today.**
    `/iq/agents` reads "CALLS (24H) 0 · ERRORS 0 · ERR RATE —" and every node
    "calls 0 · err 0"; `/admin/observability/summary` reads "INVOCATIONS (24H)
    2,994 · ERRORS 25" for the same fleet and window (`portal/src/pages/
    AgentFlowPage.tsx` metrics vs `middleware/src/mock/agent-statuses.ts`).
    Repro: open both pages.
    **Closed 2026-09-05 23:45** — /iq/agents reads "CALLS (24H) 3.0k · ERRORS 25 · ERR RATE 0.8%" (Supervisor 847/3, Search 1.5k/7, Scoring 312/0, Advisor 156/2, Graph Builder 67/1, Ingestion 89/12) — the same fleet Health reports as 2,994 / 25.

15. **Invocations: the rows cannot be opened and the error text is
    truncated.** `/admin/observability/invocations` — `portal/src/pages/
    observability/InvocationsPage.tsx`: every `<tr>` has tabIndex -1, no
    link/button, no onclick; the RESPONSE cell clips each error ("error: S3
    GetObject failed: NoSuchKey confluence/aut…") and there is no way to read
    the rest, although `invocations/:invocationId` exists in `App.tsx`. The
    persona is sent here to "read the failures" and cannot.
    Repro: Health → Read the failures → Tab / click a row.
    **Closed 2026-09-05 23:45** — every row's WHEN cell is `<a href="/admin/observability/invocations/<id>">` (23 of 23), Tab reaches them and Enter navigates; the RESPONSE cell shows the error to the end of its first sentence ("error: S3 GetObject failed: NoSuchKey confluence/auth-migration-prd.pdf"). What the link opens is a 404 for every mock id — filed as #22.

16. **Invocations: the Agent select lists "Supervisor" and "orgiq-supervisor"
    as two agents.** The fleet-registry names plus a raw agent id from a real
    chat-traffic row (`InvocationsPage.tsx` agent-option merge does not map
    ids to display names). Minor.
    Repro: open the Agent select.
    **Closed 2026-09-05 23:45** — the Agent select lists All agents / Advisor / Graph Builder / Ingestion / Scoring / Search / Supervisor — no raw-id duplicate.

17. **Knowledge reports a broken KB to a role with no remedy and never says
    so.** `/admin/knowledge` — `portal/src/pages/knowledge/`: "✕ 1 KB broken"
    and "OrgIQ Legacy Docs · points at nothing" render for org-leader, the
    ACTIONS cell is empty for every row (ManageKB false), the badge is a
    `<button>` that goes nowhere, and no text explains what capability the
    fix needs — contrast Session config's "Publishing this bundle needs Manage
    devbox."
    Repro: as Vera, /admin/knowledge → read the ACTIONS column.
    **Closed 2026-09-05 23:45** — the broken row's ACTIONS cell reads "Repointing needs Manage KB — an HR admin can do it from Knowledge." (the two in-sync rows stay blank). The "✕ 1 KB broken" badge is still an inert button — minor, not refiled.

18. **The broken KB's detail page calls it ACTIVE and draws its missing
    Bedrock KB green.** `/admin/knowledge/registry/a0000003-…` — header badge
    "ACTIVE", Pipeline chain "Bedrock KB · KBMOCK-GONE" in green, while the
    overview row says "points at nothing"; the Landing zone tab says "then run
    Sync Now" with no Sync Now on the page for this role
    (`portal/src/pages/knowledge/KBDetailPage.tsx`).
    Repro: Knowledge → Enter on OrgIQ Legacy Docs.
    **Closed 2026-09-05 23:45** — the detail header reads "Broken — Bedrock knowledge base not found", the Pipeline chain draws "Bedrock KB · KBMOCK-GONE — not found in this account" in the danger tone, and the Landing zone tab reads only "Upload documents to this S3 prefix." with no Sync Now reference.

19. **Capabilities links a platform role to an hr-admin-only page.**
    `/admin/capabilities` — `portal/src/pages/capabilities/CapabilitiesHomePage.tsx`:
    "Surveying a site →" and the footer's "Knowledge → Sources" both point at
    `/admin/ingest/crawl`, which `App.tsx` guards with RequireRole
    ['hr-admin']; for org-leader the click bounces to /iq/projects with no
    hint before it. Same shape as member #7.
    Repro: as Vera, Capabilities → Surveying a site →.
    **Closed 2026-09-05 23:45** — the Browser card's entry is a `<span>` reading "Surveying a site (HR admin)" and the closing paragraph reads "Crawling moved to Knowledge → Sources (HR admin)" with no anchor; the page has 0 links to /admin/ingest.

20. **Bots: the list and the detail disagree about whether cost-anomaly-sweep
    has ever run.** Reproduces the first half of program-owner #9: the row
    reads "LAST RAN 1d ago · 0/4 runs", the detail page header reads "never
    fired" and RUNS reads "This bot has never fired" (`portal/src/pages/bots/
    BotsPage.tsx` vs `BotDetailPage.tsx`, `middleware/src/mock/` bot
    fixtures). The controls program-owner could not find (▶ Run now / Resume /
    Delete / edit) do exist for org-leader.
    Repro: Bots → Enter on cost-anomaly-sweep → compare.
    **Closed 2026-09-05 23:45** — the list row reads "last ran 1d ago · 0/4 runs · $0.00 of $2.00" and the detail header reads "cron: 15 7 * * * · last ran 1d ago" with RUNS listing "cron · done · $0.1800 · 4m · 1d ago" and older runs.

21. **The shell rail lists Computer Lab for a role whose route redirects.**
    `portal/src/components/shell/Layout.tsx` (the BUILD group) renders
    "Computer Lab" → `/admin/devbox` for org-leader while `App.tsx` guards
    the route with RequireRole ['hr-admin','sme'] and `work/automateNav.tsx`'s
    `DEVBOX_ROLES` correctly excludes the role (the Automate overview renders
    the same destination as non-clickable text "Not visible to this role").
    Every click on the rail entry lands on Initiatives.
    Repro: as Vera, click Computer Lab in the rail.
    **Closed 2026-09-05 23:45** — the shell rail lists Initiatives, Budgets, Library, Promotions, Designs, Knowledge, Automate, Distillation, Session config, Health, Architecture, Capabilities, Ask, Explore, Scores, Settings — 0 "Computer Lab" anchors; /admin/devbox still redirects to /iq/projects.

3. **Authorize is refused for a codebase the page already shows.** Reproduces
   sme #3 / program-owner #13 for org-leader: on `/iq/projects/p-observability`
   ⚡ Estimate → Authorize → "Authorize run" POSTs `/api/bots/dispatch-work`
   and gets `400 {"error":"no codebase delivers this initiative — ask a
   program owner to link a codebase in Codebases"}` (toast "✗ Dispatch
   failed") while the header links "↗ connorhoehnslalom/orgiq-observability".
   The message is now role-aware, but the leader who allocates this
   initiative's spend still cannot authorize a run on it and the page shows
   the very codebase the server says is missing (`middleware/src/lib/
   bot-runner.ts` `decideDispatch`; mock `listAgentProjects()` returns `[]`).
   Repro: as Vera, Observability Platform → ⚡ Estimate on "Error-budget
   dashboard per team" → Authorize → Authorize run.
    **Still reproduces 2026-09-05 23:45** — not re-observed: the drawer opens and offers Authorize for "Error-budget dashboard per team", but pressing "Authorize run" dispatches a governed run (an irreversible confirm) and this pass did not press it; a probe POST with a $0.01 cap, which the run-budget gate would reject before any claim, was also not sent. The middleware fix (mock `MOCK_AGENT_PROJECTS`, claim via `updateWorkItem`) is documented below with a curl proof and stays pending a human-driven re-check.
   **Closed 2026-09-06 00:05** — verified server-side (the browser auditor could not press an irreversible Authorize run): as u-vera / org-leader on p-observability, `POST /api/bots/dispatch-work` for `wi-obs-e2-s3` with a model returns **503 "the devbox runtime is not deployed"** (every gate passed: grant, codebase link, run cap, allocation, envelope), and with `budgetPerRunUsd: 0.01` returns **409 gate "run-budget"** with the p75 estimate and `confirmOverRunBudget` — never the "no codebase delivers this initiative" 400.

24. **Prompt Studio: entering an authoring panel takes no focus.**
    `/iq/prompts` — `portal/src/pages/capabilities/prompts/EditPanel.tsx`,
    `TestPanel.tsx`, `VariableInput.tsx`, `VarCombobox.tsx` and the
    `onEdit`/`onCancel` handlers in `PromptsPage.tsx` / `ViewPanel.tsx`. As
    filed 2026-09-06 11:39, entering either authoring panel from the keyboard
    left `document.activeElement` on `<body>` with no focusin anywhere inside
    the panel, Escape did not leave the editor, and Cancel dropped focus on
    the floor — so a keyboard user had to Tab from the top of the document
    past the whole shell to reach the field they had just opened. The 12:05
    fix gave both panels the `close()` contract (Escape + Cancel/Close hand
    focus back to `[data-prompt-edit-trigger]` / `[data-prompt-test-trigger]`
    in a `requestAnimationFrame`, Escape ignored while saving) and gave
    `EditPanel` its mount-side `autoFocus`; the 13:10 fix added the missing
    mount-side half to `TestPanel` by threading `autoFocus` through
    `VariableInput` to whichever control it routes to.
    **Closed 2026-09-06 13:07 (org-leader, u-vera) and 13:10 (hr-admin,
    u-rachel), both at 1552px against dev:mock — all six legs re-observed,
    both roles.** Edit leg: Enter on `[data-prompt-edit-trigger]` mounts the
    "Creating new version from DRAFT" editor with `document.activeElement` on
    `TEXTAREA[aria-label="Prompt template"]`; Escape closes it and returns
    focus to the trigger; Enter on Cancel does the same (focusin log Cancel →
    Edit / new version). Test leg: Enter on `[data-prompt-test-trigger]`
    mounts the harness with focus on the FIRST variable, on all three control
    routes — `INPUT[aria-label="initiative"]` (text) and
    `INPUT[aria-label="metric"]` (text) via `Input`, and
    `INPUT[role="combobox"]` (hint text "Select or type a person…") via
    `VarCombobox` on orgiq-supervisor's `{{user_query}}` — with the focus ring
    visible in both roles' screenshots; Escape closes the harness and returns
    focus to `[data-prompt-test-trigger]`, and Enter on Close does the same
    (focusin log Close → Test ▶). Both surface logs now read
    `verdict: pass` / `keyboard: pass`. Test-environment note kept for the
    next auditor: the hand-back is inside a `requestAnimationFrame` and rAF
    never fires while the tab reports `document.visibilityState === 'hidden'`
    — force frames with MCP screenshots between the keystroke and the read.
    ONE forced frame was not always enough this pass: the Cancel leg read
    `BODY` after a single screenshot and read the trigger correctly with two,
    so take two frames before calling any leg of this a failure.

## Fixed (pending re-audit) — coordinator, 2026-09-05 20:45

- #21: the shell rail's Computer Lab entry (`components/shell/Layout.tsx`)
  now carries `requireRoles: ['hr-admin', 'sme']`, the same list as the
  route guard, `automateNav.DEVBOX_ROLES`, the palette and the matrix —
  all mirroring the `ManageDevbox` grant in Cedar. An org leader no longer
  sees a rail item that redirects.

## Fixed (pending re-audit) — portal agent (bots/budgets), 2026-09-06 01:15

- **#9 — Escape on the inline allocation editor now returns focus to a real,
  attached element.** Root cause was NOT the missing-`forwardRef` workaround
  itself (agent A's earlier fix, program-owner #8) — it was that the workaround
  captured a *specific DOM node* (`e.currentTarget` off the opening click),
  but `AllocationCell` (`portal/src/pages/budgets/InitiativesReport.tsx`)
  swaps between an `<Input>` and a `<Button>` by conditional early return.
  Closing the editor unmounts the `Input` and **mounts a brand-new **`Button`**
  element** in its place — a different DOM node than the one the ref
  captured, which is now detached. Calling `.focus()` on a detached node is a
  silent no-op, so focus fell through to wherever `document.activeElement`
  defaults once the `Input` itself unmounts: `<body>`. Fixed by keeping the
  ref-to-a-captured-node approach but resolving the actual trigger through a
  stable `data-allocation-trigger={row.orgProjectId}` attribute (present on
  both the "Set budget" and the ghost `$60.00` button) via
  `document.querySelector` inside the post-commit `useEffect`, instead of
  holding a reference across the unmount/remount. `beginEdit` no longer needs
  the click event at all. Same file, no new files. This was a DOM-timing bug,
  not pure logic, so no node test applies (matches the "otherwise read
  carefully" branch) — confirmed by tracing the mount/unmount sequence rather
  than by a repro script.

- **#20 — list and detail now share one function and one phrase for "has this
  bot run", though the underlying mock data gap is not something a
  portal-only fix can close.** Traced both routes: `GET /api/bots`
  (`middleware/src/routes/bots.ts:409` → `listBots()`) returns each bot's own
  `lastRunAt`/`todayRunCount` fields and **no `runs` array**; `GET
  /api/bots/:id/runs` (`:596` → `listBotRuns()`) is a separate fetch. In
  `middleware/src/providers/bots.ts`, `listBotRuns()`'s mock branch
  unconditionally returns `[]` for **every** bot, while `MOCK_BOTS` bakes a
  non-null `lastRunAt` onto every seeded bot including cost-anomaly-sweep —
  so in dev:mock, every bot's detail page (correctly, since program-owner
  agent B's earlier fix) reads "never fired" while its list row reads a real
  relative time. This is a middleware/mock-fixture bug
  (`middleware/src/providers/bots.ts`), not a portal one, and out of scope
  for an agent scoped to `portal/src/pages/bots/**` +
  `portal/src/pages/budgets/**` — flagging it here rather than papering over
  it with a heuristic (e.g. reading `todayRunCount` as a stand-in for "ever
  fired" would coincidentally match cost-anomaly-sweep's 0 but would be
  wrong the moment a bot has run before today but not today).
  What IS fixed, in scope: added `lastRanText(runs, when, now?)` to
  `portal/src/pages/bots/botsFormat.ts` — the exact `"last ran <time>"` /
  `"never fired"` phrase-building, built on the existing `botRunSummary`,
  now used by BOTH `BotDetailPage.tsx`'s header meta line (replacing its
  inline ternary) and, via the new `botListLastRanText(bot, when, now?)`
  wrapper (which lifts the list's lone `lastRunAt` field into a one-element
  runs array so the same function renders it), `BotsPage.tsx`'s "Last ran"
  column (replacing the bare `when(bot.lastRunAt)`). Concretely: a bot with
  no `lastRunAt` now reads "never fired" on the list too, not the looser
  "never" — the two pages can no longer disagree on *wording* or on what an
  empty/absent run history means, even though they can still disagree on the
  *data* until the mock fixture above is fixed.
  Files: `portal/src/pages/bots/botsFormat.ts`, `BotsPage.tsx`,
  `BotDetailPage.tsx`.
  Tests: `botsFormat.test.ts` — 4 new cases for `lastRanText`/
  `botListLastRanText` (empty-runs phrase, formatted "last ran" phrase, and
  the same two for the list wrapper).
  Verified together: `npx tsc --noEmit` clean for these files (2 pre-existing
  errors remain in untracked `sprints/GrantsPanel.tsx`, outside this scope
  and mid-edit by another agent), `node --test 'src/**/__tests__/*.test.ts'`
  520/520 pass, `npx vite build` clean, and
  `scripts/validate-orgiq-audit.sh --quick` component-discipline block all ✓
  (raw elements 0/0, no style=, no native controls, no raw button).

## Fixed (pending re-audit) — portal agent (observability/knowledge/capabilities), 2026-09-05 20:55

- #15: `/admin/observability/invocations` — `InvocationsPage.tsx`'s primary
  ("When") cell is now a real `Link` to `/admin/observability/invocations/:id`
  (native anchor, so Tab reaches it and Enter opens it with no extra keyboard
  wiring). The RESPONSE cell no longer relies on CSS `truncate` (a pixel-width
  ellipsis that lands mid-word wherever it lands); a new `firstSentence()`
  helper cuts at the first sentence boundary instead, falling back to a
  word-boundary cut with `…` only past `maxLen`. The full text is still on
  `title=` (hover) and on the detail page.
  Files: `portal/src/pages/observability/InvocationsPage.tsx`,
  `invocationsFilters.ts` (new `firstSentence` export).
  Tests: `__tests__/invocationsFilters.test.ts` — 3 new cases (sentence cut,
  no-punctuation passthrough, word-boundary fallback with ellipsis).

- #16 (portal half): the Agent `Select` and the filter it drives are now keyed
  by the fleet registry's `id`, not by whatever string the tail's `agentName`
  happens to hold. `resolveAgentKey(agentId, agentName)` prefers a registry
  id, then a registry name, before falling back to the raw value, so a real
  trace whose `agentName` fell back server-side to a raw id (`agentName =
  agentName || agentId` in trace-sink.ts) still collapses onto the same
  option as a trace carrying the display name — "Supervisor" and
  "orgiq-supervisor" can no longer both appear. The same resolver also
  canonicalizes the incoming `?agentId=` query param, since existing links
  seed it with either form (`SummaryPage.tsx` passes the id,
  `iq/AgentDetailPage.tsx` passes the display name). The Agent column in the
  table now shows the resolved registry name too.
  Files: `portal/src/pages/observability/InvocationsPage.tsx`.

- #17: `/admin/knowledge` — the reconcile `DataTable`'s `rowActions` returned
  `null` for a `missing`/`status-drift`/capability-less `unregistered` row,
  leaving the ACTIONS cell blank on exactly the rows a person came to this
  page worried about. It now returns inline text via a new `actionHint()`
  helper: a role without `ManageKB` (verified against `readForRolesElseAction`
  in `middleware/src/index.ts` and `hr-admin.cedar`, which is the only orgiq
  role holding it) reads "Repointing needs Manage KB — an HR admin can do it
  from Knowledge."; a role that can act but has no live counterpart to adopt
  into yet reads "Repoint this from the matching unregistered knowledge
  base's row, once one appears." The reconcile reason itself (e.g. "Registry
  points at KBMOCK-GONE, which does not exist in this account.") was already
  shown in the row's own Detail column — untouched.
  Files: `portal/src/pages/knowledge/KnowledgeHomePage.tsx`.

- #18: `/admin/knowledge/registry/:id` no longer trusts the registry row's own
  `status` column for what it shows. `KBDetailPage.tsx` now also fetches
  `GET /api/admin/kb-registry/reconcile` and matches this KB by id; a new
  `effectiveStatus(kb, reconciled)` (`kb/kbFormat.ts`) returns "Broken —
  Bedrock knowledge base not found" in the danger tone whenever the reconcile
  says `drift: 'missing'` (and a "(account reports …)" warning label for
  `status-drift`), and the header badge now renders that instead of a plain
  `<StatusChip status={kb.status}>`. `KbPipelineChain` takes the same
  `reconciled` row and draws its Bedrock KB stage (and greys Agents) in
  danger when the id doesn't exist in the account, instead of inheriting the
  registry's own optimistic tone. `LandingZoneTab` takes a new `showSyncHint`
  prop (`canManage && canSync(kb)`, the same gate the header's `SyncButton`
  itself renders under) and only prints "...then run Sync Now to ingest
  them." when that control is actually on the page for this role.
  Files: `portal/src/pages/admin/KBDetailPage.tsx`,
  `portal/src/pages/admin/kb/kbFormat.ts`,
  `portal/src/pages/admin/kb/KbPipelineChain.tsx`,
  `portal/src/pages/admin/kb/LandingZoneTab.tsx`.

- #19: `/admin/capabilities` — "Surveying a site →" and the footer's
  "Knowledge → Sources" both pointed at `/admin/ingest/crawl`, which
  `App.tsx` gates `RequireRole(['hr-admin'])`; org-leader (the only other
  role that can reach this page) clicked through to a silent bounce. Both
  spots now check a new exported `INGEST_ROLES = ['hr-admin']` (mirroring the
  route guard, plus the 'admin' bypass `RequireRole` itself grants) against
  `useSession().role` and render plain text — "Surveying a site (HR admin)"
  / "Knowledge → Sources (HR admin)" — instead of a link, for a role that
  cannot open it.
  Files: `portal/src/pages/capabilities/CapabilitiesHomePage.tsx` (new
  exported `INGEST_ROLES`).

  Verified together: `npx tsc --noEmit` clean, `node --test
  'src/**/__tests__/*.test.ts'` 534/534 pass, `npx vite build` clean, and
  `scripts/validate-orgiq-audit.sh --quick` component-discipline block all ✓
  (raw elements 0/0, budget done line reached, no style=, no native controls,
  no raw button).

## Fixed (pending re-audit) — portal agent (scores), 2026-09-06

- **#10 — the skill-search combobox no longer opens on bare focus, never
  shows an empty-query "no match" state, and never traps Tab/Escape or
  swallows keystrokes.** Root cause was `SkillFilter.tsx` reaching for the
  library's `InlinePopover` (via `onFocus={() => setOpen(true)}`), and
  `InlinePopover` unconditionally does two things on open, per its source
  (`node_modules/@connorhoehnslalom/ui-components/dist/InlinePopover-*.js`):
  moves focus into its first focusable child (or itself) via
  `queueMicrotask`, and installs a global `keydown` listener that traps Tab
  inside the panel and intercepts Escape for the panel's own `onClose` —
  exactly backwards for a combobox whose *input* must keep focus for its
  entire open lifetime. Replaced with a plain, non-focusable, absolutely
  positioned panel (no library popover at all — same "non-modal,
  non-trapping disclosure" gap already queued for `PersonCardFrame.tsx`) and
  extracted the open/query/highlight transitions into a pure reducer,
  `skillComboboxState.ts` (open only on `type` with a non-empty query or on
  `arrow-down`; `close` never touches the typed query; `select` resets both).
  12 new node tests in `__tests__/skillComboboxState.test.ts` cover
  open/close/highlight/pick/escape directly against the reducer, with no DOM.
  Suggestion rows are plain non-focusable `<li role="option">`s picked via
  `onMouseDown`+`preventDefault` (not a nested `FilterChip`/`Button`), so Tab
  from the input goes straight to the next real control instead of walking
  into the list — the ARIA combobox pattern PROTOCOL.md's keyboard rule asks
  for. Queued in `docs/ui-components-queue.md`.

- **#11 — one scale for composite/influence/expertise everywhere on the
  page.** The wire contract itself is inconsistent and out of scope to
  change (`middleware/src/mock/scores.ts`'s `influence`/`expertise` are
  fractions in `[0,1]` while its `composite` is already computed to 0-100;
  the real Aurora path in `providers/aurora.ts` is *also* inconsistent with
  the mock — `pagerank_score * 100` and `expertise_score` are both already
  0-100 there). Added one function, `formatScore()` in `scoresFormat.ts`,
  that is the single place deciding fraction-vs-percent (a value strictly
  between 0 and 1 is a fraction and gets scaled to 0-100; 0 and anything
  ≥ 1 is already a 0-100 score — no real percentage score lands in `(0,1)`)
  and rounds to a 0-100 integer. `computeReweighted()` now normalizes through
  the same rule before blending, so the stat strip's Avg/Top Composite (which
  read `filtered[...].composite` straight from `computeReweighted`) stopped
  reading "1" for both. `Leaderboard.tsx`'s row previously re-derived its own
  `inf01`/`exp01`/`compositeFromWeight` independently of the composite
  computed upstream — the actual "three scales for one score" bug — now uses
  `formatScore` on `influence`/`expertise` and the upstream `composite`
  directly, nothing re-derived. `PersonDetailCard.tsx`'s "Influence
  (PageRank)" line now goes through `formatScore` too, and the panel gained a
  "Composite" line (fed the selected row's already-normalized composite from
  `ScoresPage.tsx`) so the panel can be checked against the row it was opened
  from instead of only showing the one figure that happened to already be on
  a 0-100 scale. 5 new tests in `scoresFormat.test.ts` cover `formatScore`
  directly plus one `computeReweighted` case on mock-shaped 0-1 inputs; all
  10 pre-existing `computeReweighted` tests (written against bare 0-100
  numbers) still pass unchanged — the fraction-vs-percent rule is a no-op
  when both inputs are already ≥ 1.

- **#12 — Escape now returns focus to the row that opened the panel.** Same
  root cause shape as the Budgets #9 fix above (a captured DOM node going
  stale across an unmount/remount, not a logic bug): `ScoresPage.tsx`
  conditionally wraps the leaderboard in `RailLayout` only once `detail` has
  loaded (`leaderboardEl = detail ? <RailLayout>{leaderboard}</RailLayout> :
  leaderboard`), and `RailLayout`'s own render output nests its children a
  level deeper (`<div className="min-w-0 flex-1">`) than the un-wrapped path
  — a different tree shape at the same slot, which React can only satisfy by
  unmounting the old subtree and mounting a fresh one. That remount happens
  on **both** the open transition (once the async person-detail fetch
  resolves and `detail` flips truthy) and the close transition (Escape sets
  `selectedId` back to `null`), so the row's actual `<button>` DOM node is
  destroyed and recreated at least twice between a click and the following
  Escape — the previous fix's `triggerElRef.current?.focus()` was calling
  `.focus()` on an already-detached node, a silent no-op, leaving focus on
  `<body>` exactly as the audit found. Fixed by capturing the trigger's
  stable `id` string (`scoreRowButtonId(personId)`, now set on every row's
  name `Button` in `Leaderboard.tsx`) instead of the node itself, and
  resolving it fresh via `document.getElementById(id)?.focus()` in the
  close-transition effect — the id, not the node, survives the remount.
  Verified by tracing the render-output shape at both transitions (the
  `RailLayout` structural-diff argument above), the same way Budgets #9 was
  root-caused, since this is a DOM-timing bug no node test can reach.

  Verified together: `npx tsc --noEmit` clean, `node --test
  'src/**/__tests__/*.test.ts'` 537/537 pass (520 pre-existing + 17 new),
  `npx vite build` clean, and `scripts/validate-orgiq-audit.sh --quick`
  component-discipline block all ✓ (raw elements 0/0, budget done line
  reached, no style=, no native controls, no raw button).

## Fixed (pending re-audit) — portal agent (work/sprints/promotions), 2026-09-06 03:10

- **#1 — Escape now cancels only the open nested form, not the whole
  drawer.** Root cause: the Drawer (`ui-components/shared/Drawer.tsx`)
  installs a `window`-level `keydown` listener that calls `onClose` on any
  unhandled `Escape`, and neither `GrantsPanel.tsx`'s "+ Grant envelope"/Edit
  forms nor `SprintBoard.tsx`'s "+ Add work item" form had any Escape
  handling of their own — so that listener was the only one that ever fired.
  Extracted the nesting rule into a host-agnostic pure reducer,
  `sprints/escapeNesting.ts` (a stack of open layer ids; `escape` pops one;
  `shouldHostHandleEscape` is false while the stack isn't empty), with 7
  node-test cases (`sprints/__tests__/escapeNesting.test.ts`). Wired into
  both `GrantsPanel.tsx` (the "add" and "edit:<id>" layers share one stack)
  and `SprintBoard.tsx`'s `AddItemControl`: each form's container has an
  `onKeyDown` that, while the stack is non-empty, calls
  `preventDefault`/`stopPropagation` on `Escape` before it can reach the
  Drawer's `window` listener, closes only the top layer, and refocuses the
  control that opened it. A second Escape, with the stack empty, is left
  alone and bubbles to the Drawer as before (closes the drawer, restores
  focus to the row). Focus targets are captured off `e.currentTarget` at
  the opening click rather than a `ref` prop, because `Button` (ui-components)
  is a plain function component with no forwarded ref — passing `ref` to it
  does not type-check.
  Files: `portal/src/pages/sprints/escapeNesting.ts` (new),
  `portal/src/pages/sprints/__tests__/escapeNesting.test.ts` (new),
  `GrantsPanel.tsx`, `SprintBoard.tsx`. The Estimate & authorize drawer on
  initiative-detail (`portal/src/pages/project-detail/`) has the same shape
  but is outside this agent's owned directories — not touched.

- **#4 — `QueuePulse.tsx`'s bot-page gate now imports `automateNav.tsx`'s
  `BOTS_ROLES` instead of keeping a second, drifted copy** (the local
  `BOT_PAGE_ROLES` omitted org-leader). `BOTS_ROLES` exported from
  `automateNav.tsx`. Roster rows are real `<Link>`s and "Manage bots →"
  renders for org-leader now, same as every other `BOTS_ROLES` role.

- **#5 — the Queue's empty state no longer names controls a role does not
  have.** `QueuePage.tsx`: "assign a work item below, or write one from
  scratch" pointed at the "Ready to assign" table and the `TaskComposer`,
  both gated on `ManageDevbox` (`canManage`) — a capability org-leader does
  not hold, though `DispatchAgentRun` is what actually lets the role queue
  work elsewhere on the site. The empty state (only when `filter === 'all'`
  and `canManage` is false) now reads "No jobs yet — promote a finding or
  dispatch work from an initiative." with real links to `/iq/work/findings`
  and `/iq/projects` — both routes render for every role that reaches this
  page. `canManage` sessions keep the original copy, since the two controls
  it names are on the page for them.

- **#6 — the "Bots on this queue" tile and the roster table now come from
  one function, and the sentence under the strip renders as real prose.**
  Added `botsOnQueue`/`pausedBotCount` to `queueMath.ts` (2 new node tests)
  and had `QueuePulse.tsx` derive both the stat value and the `.map()`
  roster from `botsOnQueue(bots)` — the tile could read active-only (4)
  while the table below rendered every bot including paused ones (5); now
  both read the same list, with paused count moved into the tile's hint.
  Separately, `WorkHomePage.tsx`'s description sentence read "on
  thequeue"/"theComputer Labdrain" — traced to `T`'s `wrap` mode being built
  on the flex-row `Inline` primitive: CSS Flexbox (§4) wraps each
  contiguous JSX text run in its own anonymous block-level flex item, and a
  run that is *entirely* collapsible whitespace is suppressed outright
  rather than rendered at normal width, so an ordinary space at a seam next
  to an inline `<Link>`/`<T>` renders with zero width no matter how it's
  written. Replaced the three losing spaces with non-breaking spaces
  (real, non-collapsible content, not whitespace subject to that rule) —
  the sentence now reads correctly without changing `T` itself, which many
  other pages in this repo still rely on for row-of-chips layouts.

- **#7 — the dismissed group's heading (and every other sweep group
  heading) now goes through one pure `sweepLabel()` function with a
  title-cased fallback**, in `findingsFilter.ts`: `lab-signal` → "Lab
  signals", `bus_factor` → "Bus factor", `stale_docs` → "Stale docs",
  `orphan_decisions` → "Orphan decisions", anything else → title-cased id
  (`new_sweep_kind` → "New sweep kind"). Replaces the old `SWEEP_LABELS`
  table in `workShared.tsx` (removed — it had no entry for `lab-signal` at
  all, which is what printed the raw id, and its wording for the other
  three sweeps is superseded by the mechanical title-case form the ticket
  specified). `FindingsPage.tsx`'s group heading now calls `sweepLabel(sweep)`.
  6 new node-test cases in `findingsFilter.test.ts`.

- **#8 — Promotions candidate title and sub-line now share one alignment
  (left).** Root cause was not `text-align` on the table cell (the column
  has no `align`, so it was already left by default) — it was `Button`'s
  own root being a native `button` element (UA default: centred text)
  inside a `Stack` with no `align` prop, which stretches its children to
  the column's full width via the flex default `align-items: stretch`. The
  existing `justify-start` class is a flex-container property and did
  nothing, since `Button` is not itself a flex container. Added `text-left`
  to the title `Button`'s className in `PromotionsPage.tsx`, which actually
  overrides the centring.

  Verified together: `npx tsc --noEmit` clean, `node --test
  'src/**/__tests__/*.test.ts'` 537/537 pass (12 new: 7 escapeNesting + 3
  sweepLabel + 2 queueMath), `npx vite build` clean, and
  `scripts/validate-orgiq-audit.sh --quick` component-discipline block all
  ✓ (raw elements 0/0, budget done line reached, no style=, no native
  controls, no raw button — an earlier pass of this fix tripped the raw-
  `<button>` grep on a code comment that literally contained the substring
  `<button`, not on real JSX; reworded).

## Fixed (pending re-audit) — project-detail Escape nesting, 2026-09-05 21:14

- **#1 (remainder) — the initiative-detail "Estimate & authorize" drawer no
  longer strands focus on the app shell after Escape/Cancel.** Turned out to
  be a different root cause from the sprints half above: the library's
  `Drawer`/`Modal`/`ConfirmDialog` already coordinate `Escape` correctly
  through a shared overlay stack (`ui-components`'s `src/lib/
  overlayStack.ts` — `Escape` only ever closes the topmost registered
  overlay), so `EstimateDrawer`'s four nested `ConfirmDialog`s
  (authorize / over-allocation / over-run-budget / over-envelope) were never
  the problem — a second Escape there already correctly falls through to the
  Drawer. The actual bug: `WorkItemDrawer.tsx`'s "⚡ Estimate & dispatch"
  footer button calls `onEstimate(item)` and `onClose()` in the same click,
  unmounting the whole `WorkItemDrawer` (footer button included) in the very
  render that mounts `EstimateDrawer`. The browser force-blurs a removed
  focused element to `<body>` as part of that DOM mutation, before any React
  effect runs — so by the time `EstimateDrawer`'s own `Drawer` mount effect
  captures "previous focus" to restore later, it has already lost the real
  trigger and saves the app shell instead.
  Fix: every "⚡ Estimate" trigger — `WorkItemChips.tsx`'s `EstimateChip` and
  `WorkItemDrawer.tsx`'s footer button — now carries
  `data-estimate-trigger={item.id}`, a stable, re-queryable handle (`Button`
  isn't `forwardRef`, so a captured DOM ref would go stale the moment the
  triggering drawer unmounts — same constraint noted in the sprints fix
  above). `EstimateDrawer.tsx` routes every one of its own close paths
  (Escape/backdrop/header ×, Cancel, and post-dispatch success) through one
  `handleClose` that calls the real `onClose` and then, on the next
  `requestAnimationFrame` (after the library's own incorrect restore has
  already fired), re-queries `[data-estimate-trigger="<id>"]` and focuses it
  if a match is still mounted — landing on the same item's row in whichever
  list view is underneath, since the drawer footer's own button is already
  gone by then.
  `WorkItemDrawer.tsx`, `NewItemForm.tsx` and `ContributorModal.tsx` were
  also checked against the same shape and are clean: `NewItemForm` is always
  an inline `Card` in the panel body (`WorkPanel.tsx`, `EpicCard.tsx`), never
  inside an open `Drawer`/`Modal`; `ContributorModal` is a standalone
  `Modal`, not nested in anything; and `PersonRef.tsx` — nested inside
  `WorkItemDrawer`'s Assignee field — already does the escapeNesting.ts-style
  `stopPropagation()`-before-dismiss correctly, so none of them needed a
  change.
  Files: `portal/src/pages/project-detail/WorkItemChips.tsx`,
  `portal/src/pages/project-detail/WorkItemDrawer.tsx`,
  `portal/src/components/marketplace/EstimateDrawer.tsx` — the last one
  outside `project-detail/**` (this agent's owned directory), touched after
  confirming with the coordinating agent that it's the only file the actual
  bug lives in and nobody else was editing it.
  Verified: `npx tsc --noEmit` clean, `node --test
  'src/**/__tests__/*.test.ts'` 537/537 pass, `npx vite build` clean, and
  `scripts/validate-orgiq-audit.sh --quick`'s component-discipline block all
  ✓ (unaffected either way — that check scopes to `portal/src/pages`, and
  `EstimateDrawer.tsx`'s pre-existing raw `<button>`/`<select>`/`<input>`/
  `<textarea>` usage in `components/` predates this fix and was not part of
  it).

## Fixed (pending re-audit) — middleware agent, 2026-09-05 21:15

- **#2 — Initiatives list vs. initiative detail disagreeing about points,
  made structural for all 14 initiatives.** `providers/projects.ts`'s
  `MOCK_INITIATIVES` hand-typed `openStories`/`openBugs`/`pointsDone`/
  `pointsTotal` per initiative (Observability Platform: "34/72 pts · 47%"
  vs. the Work tab's real 3 `wi-obs-*` items summing to 0/10). A previous
  pass hand-tuned p-mobile-redesign's numbers to match its real items but
  left the other 13 restated independently. New: `providers/work-items.ts`
  exports `mockWorkItemRollup(projectId)`, computed from `MOCK_WORK_ITEMS`
  with the SAME type/status filters the real Aurora rollup SQL uses (story
  vs. bug, `open`/`in_progress`/`in_review` counts as open, `done` for
  points-done). `providers/projects.ts`'s `listProjects()` now calls it
  instead of reading hand-typed fields — the 4 fields were removed from
  `MockInitiative` entirely. Observability Platform now reads "0/10 pts"
  (2 open stories, 1 open bug) on BOTH the list and the detail, because both
  read the same `wi-obs-*` items.
  Files: `middleware/src/providers/work-items.ts`,
  `middleware/src/providers/projects.ts`.
  Test: `work-items-seed-parity.test.ts` — new "gives EVERY seeded
  initiative the same rollup on the Initiatives list and on its own work
  items" asserts list==detail (openStories/openBugs/pointsDone/pointsTotal)
  for all 14 initiatives `listProjects()` returns, not just the one
  previously hand-fixed.

- **#3 — "Authorize run" refused for a codebase the page already shows,
  fixed at both the codebase-link layer and a deeper 500 it uncovered.**
  `providers/agent-projects.ts`'s `listAgentProjects()` returned `[]`
  unconditionally in mock mode, so `bot-runner.ts`'s `preflightWorkItem`
  (which filters `listAgentProjects()` by `orgProjectId === item.projectId`)
  400'd EVERY initiative with "no codebase delivers this initiative" even
  though the initiative header shows a real linked repo
  (`MOCK_INITIATIVES[].repo`). New `MOCK_AGENT_PROJECTS` in
  `agent-projects.ts` mirrors `schema/seed_program.sql`'s 14
  `agent_projects` rows exactly (same ids, repo names, `org_project_id`) —
  one linked codebase per seeded initiative, all 14. `listAgentProjects()`
  and `getAgentProject()` (which had NO mock branch at all) both now read it.
  Chasing the fix to a live curl proof surfaced a SECOND bug behind the
  first: once the codebase preflight passes, `bot-runner.ts`'s
  `dispatchWorkItem()` claimed the work item via a raw `exec()` UPDATE with
  no mock guard, so it hit real Aurora regardless of `config.mock.aurora` and
  crashed with `UnrecognizedClientException` → bare `500 Internal server
  error` — a worse failure than the 400 it replaced. Fixed by routing the
  claim/revert through `providers/work-items.ts`'s already-mock-aware
  `updateWorkItem(id, { status, expectStatus })` (same compare-and-swap
  semantics as the raw SQL had) instead of hand-rolled SQL, and by guarding
  the (unreachable in today's mock, but unguarded) `agent_project_runs`
  work-item-binding `exec()` behind `config.mock.aurora`.
  Proof (curl, as Vera/org-leader, `POST /api/bots/dispatch-work` on
  `wi-obs-e2-s3` "Error-budget dashboard per team"):
  - no `budgetPerRunUsd` → clears grant/shape/allocation/envelope gates (org
    Platform's allocation has headroom; an org-leader carries no sprint
    envelope) and reaches the dispatcher itself, which has no devbox to
    clone into in local dev: `503 {"error":"the devbox runtime is not
    deployed"}` — a clean, worded degradation, never the 500 or the 400.
  - `budgetPerRunUsd: 0.01` → `409 {"gate":"run-budget",
    "confirmFlag":"confirmOverRunBudget", "error":"estimated p75 cost $1.50
    exceeds the per-run budget $0.01 …"}` — a genuine money-gate 409, naming
    the gate, exactly the bar this task set.
  A true `201`/`202` completion in mock mode would additionally require
  mocking the devbox clone/session flow and `providers/bots.ts`'s
  `createBotRun` (which returns `null` unconditionally in mock mode today,
  by design, per its own comment) — a materially larger change than "link
  the codebase in mock mode," left as a follow-up rather than folded in here.
  Files: `middleware/src/providers/agent-projects.ts`,
  `middleware/src/lib/bot-runner.ts`.
  Tests: new `agent-projects-seed-parity.test.ts` (14/14 initiatives linked,
  ids/repos match the seed, `getAgentProject` resolves by id, a dispatch
  preflight clears the codebase check for every seeded initiative with a
  dispatchable item) and new `bots-dispatch-mock-mode.test.ts` (real
  providers, not seam-mocked: never answers the codebase 400; a tight
  `budgetPerRunUsd` reaches the `run-budget` 409; clearing every gate reaches
  the clean 503, never a raw 500).

- **#13 — Architecture and Health disagreeing about whether anything ran
  today.** `routes/topology.ts`'s `GET /a2a` ran a raw `exec()` against
  `observability.invocation_traces` with NO mock branch — in dev:mock (no
  Aurora) the query always threw, the route's own catch swallowed it, and
  every node read "calls 0 · err 0" while Health's summary
  (`providers/cloudwatch.ts`'s mock `getSummary`, which sums
  `mock/agent-statuses.ts`'s `mockAgents`) reported 2,994 invocations / 25
  errors for the identical 24h window. New `middleware/src/mock/topology.ts`
  exports `buildMockTopologyNodes(windowHours)`, deriving each node's
  `invocationCount`/`errorCount` from the SAME `mockAgents` fixture the
  summary sums (scaled proportionally for a non-24h window) — one source,
  both routes, so they cannot independently drift. `routes/topology.ts` now
  branches on `config.mock.aurora` before touching Aurora at all; edges stay
  empty in mock mode (no mock parent→child call graph exists to derive them
  from — the same "nothing yet" state a freshly-deployed real fleet shows).
  Files: `middleware/src/mock/topology.ts` (new),
  `middleware/src/routes/topology.ts`.
  Test: new `topology-summary-parity.test.ts` — sums `/api/topology/a2a`'s
  node `invocationCount`/`errorCount` and asserts they equal
  `/api/observability/summary`'s `totalInvocations24h`/`totalErrors24h`
  exactly, plus a regression pinning at least one node has traffic (the
  literal defect: every node reading 0). Curl proof: both routes report
  2,994 calls / 25 errors.

- **#14 — Health promising 25 errored invocations against a 6-row list.**
  `mock/invocations.ts`'s hand-authored `SEEDS` carried only 1-2 illustrative
  error rows per agent (6 total) regardless of what
  `mock/agent-statuses.ts`'s `errorsLast24h` claimed (25 total across the
  fleet), so `/admin/observability/invocations?status=error` (what Health's
  "Read the failures — N errored invocations" link opens) never matched N.
  New `padErrorsToSummary()` pads each agent's error-row count in the tail up
  to its own `errorsLast24h` with synthetic, genuinely generic filler errors
  (a rotating pool of plausible AWS/Bedrock failure strings, spread across
  the 24h window) — the hand-authored illustrative errors stay as the first
  N of each agent's set. This ties the two sources structurally: change a
  number on `mockAgents` and the tail's error-row count follows without a
  second edit.
  Files: `middleware/src/mock/invocations.ts`.
  Test: new `invocations-error-parity.test.ts` — asserts every agent's
  error-row count in `buildMockInvocations()` equals its own
  `errorsLast24h` exactly (not just "at least one"), the total equals
  `totalErrors24h` (25), every error row is inside 24h, and Scoring
  (`errorsLast24h: 0`) still carries zero error rows. Curl proof: `/api/
  observability/recent-invocations?limit=100` returns exactly 25 rows with
  an `error` field, matching the per-agent breakdown (ingestion 12, search
  7, supervisor 3, advisor 2, graph-builder 1, scoring 0).

- **#16 — Invocations' Agent select listing "Supervisor" and
  "orgiq-supervisor" as two agents.** The dev:mock tail
  (`mock/invocations.ts`) already carried the registry id as `agentId` and a
  human display name as `agentName`; the bug was on the REAL-traffic side —
  `routes/agents.ts`'s `POST /:agentId/invoke` recorded
  `agentName: agentId` (the raw id, e.g. `"orgiq-supervisor"`) on every live
  chat invocation, so a real chat turn and the mock tail's row for the exact
  same agent carried two different display-name strings once
  `getRecentInvocations()` merges them. New exported
  `resolveAgentName(agentId)` resolves the same registry both surfaces
  already use (`agentcore.getRuntime(agentId)?.name` — `mockAgents` in mock
  mode, the AgentCore runtime's own name in real mode), falling back to the
  id only when the runtime is unknown or the lookup throws; both
  `recordInvocation` call sites (the error path and the success path) now
  use it instead of echoing the id.
  Files: `middleware/src/routes/agents.ts`.
  Test: new `agents-invocation-name.test.ts` — pins `resolveAgentName`
  resolves the registry name for a known id, falls back to the id for an
  unknown runtime / an empty name / a throwing lookup.

- **#20 (flagged mid-task by the coordinator, same principle as #13/#14) —
  Bots list vs. bot detail disagreeing about whether cost-anomaly-sweep ever
  ran.** `providers/bots.ts`'s mock `listBotRuns()` returned `[]`
  unconditionally while `MOCK_BOTS` hand-typed a non-null `lastRunAt` and
  `todayRunCount`/`todaySpendUsd` onto each seeded bot — the list read
  "LAST RAN 1d ago · 0/4 runs" for cost-anomaly-sweep while its own detail
  page's run list said "This bot has never fired" for the identical bot.
  New `MOCK_BOT_RUNS` gives each of the 5 seeded bots a run history (today's
  firings plus a cadence stretching back ~27-28 days, mirroring the ~30 days
  of `bot_runs` CLAUDE.md documents the real seed carrying for the
  maintenance bots); `deriveBotStats()` computes `lastRunAt`/
  `todaySpendUsd`/`todayRunCount` FROM that array — mirroring the real
  `BOT_SELECT` lateral's own semantics (calendar-day "today", `skipped` runs
  excluded from the count but not the spend total) — instead of the numbers
  being typed by hand on `MOCK_BOTS`. `listBotRuns()` now returns the same
  array `deriveBotStats()` reads. cost-anomaly-sweep specifically: one run
  ~26h ago (so "1d ago", 0/4 today) and nothing since — the list and the
  detail's run list now say the same thing.
  Files: `middleware/src/providers/bots.ts`.
  Test: new `bots-mock-run-history.test.ts` — for every mock bot, asserts
  `listBotRuns()`'s own rows produce the exact `lastRunAt`/`todayRunCount`/
  `todaySpendUsd` the roster (`listBots()`) reports, that cost-anomaly-sweep
  specifically never again reads "1d ago" beside "never fired" (has runs,
  0 today), and that a bot with no history in the fixture derives null/0/0
  rather than a fabricated default.

Verified together: `cd middleware && npx tsc --noEmit` clean; `npm test`
122 suites / 1730 tests green (up from 116/1708 at task start — 6 new test
files, 0 removed, 0 skipped). One test (`bots-dispatch.test.ts`'s "degrades
to no brake when the envelope cannot be read at all") flaked once under the
full-suite run and was confirmed unrelated and non-reproducing: green in
isolation, green on file-level rerun, green on a second full-suite run.

## Fixed (pending re-audit) — sprints/prompt-studio agent, 2026-09-05 21:20

- **#1 (remainder) — the sprint drawer's "+ Grant envelope" and "+ Add work
  item" forms now take focus on open, so their own Escape handler is the one
  that sees the key.** The stacking rule in `escapeNesting.ts` and the
  Stack/Inline-level `onKeyDown` interception were already correct — the
  actual gap was upstream of both: opening either form conditionally
  unmounts the trigger `Button` and mounts the form in the same render, and
  neither form moved focus anywhere, so the browser dropped
  `document.activeElement` to `<body>`. A `keydown` fired from `<body>`
  never reaches the `Stack`'s `onKeyDown` (it isn't a descendant), so it
  bubbled straight past the form's handler to the Drawer's window-level
  Escape-to-close listener, taking the whole drawer down. Two-part fix,
  applied identically to `GrantsPanel.tsx` (add + edit) and
  `SprintBoard.tsx`'s `AddItemControl`:
  1. The first field of each form (the grantee `PeopleSelect`, the edit
     row's amount `Input`, the add-item `Select`) now carries `autoFocus`,
     landing the keyboard inside the form the moment it mounts.
     `PeopleSelect` gained an `autoFocus?: boolean` prop that forwards to
     the underlying `Select` (both `Select`/`Input` are `forwardRef` and
     spread native attributes, so `autoFocus` reaches the real element).
  2. Focus-return on close no longer uses a captured DOM ref
     (`addButtonRef`/`editButtonRefs`/`triggerRef`) — those went stale the
     instant their trigger unmounted, same root cause the
     `EstimateDrawer.tsx` fix above already diagnosed for this codebase.
     Each trigger now carries a stable, re-queryable `data-grant-trigger`
     (`"add"` or `` `edit:${grant.id}` ``) or `data-add-item-trigger`
     attribute; closing (via Escape, Cancel, or a successful save/add) calls
     `document.querySelector` on a `requestAnimationFrame` after the state
     update commits — same pattern as `EstimateDrawer`'s `handleClose`.
  Verified by hand against the repro: Sprints lens → Sprint 98 → Envelopes →
  Tab to "+ Grant envelope" → Enter opens the form with focus already in the
  Grantee field; Escape now cancels only the form and returns focus to
  "+ Grant envelope" (a following Tab moves naturally to "Amount", not the
  drawer's Close button); a second Escape closes the drawer and returns
  focus to the "Sprint 98" row (the library `Drawer`'s own restore, working
  because it captured that stable row button rather than the ephemeral
  form trigger). Same shape confirmed for SprintBoard's "+ Add work item".
  Files: `portal/src/pages/sprints/GrantsPanel.tsx`,
  `portal/src/pages/sprints/PeopleSelect.tsx`,
  `portal/src/pages/sprints/SprintBoard.tsx`.

- **#23 — Prompt Studio's list column no longer starts under the "Prompt
  Management" sub-rail.** Geometry: `/iq/prompts` nests two `SubNavLayout`s
  — the shell's own (tenant rail, `Layout.tsx`) and `IqLayout`'s ("Prompt
  Management" rail). `app.css`'s `[data-shell-nav] main { padding: 0 }`
  zeroes the `<main class="p-6">` padding on **both**, since the selector
  matches every descendant `<main>` inside the shell, not just the outer
  one — that's the fix noted in the branding validator as "one content
  padding, set by the shell's content column." `PromptsFrame.tsx` predated
  that change: its outer `<div>` carried `-m-6`, written back when the
  nested "Prompt Management" `<main>` still had its own live 24px of
  padding to cancel. Once `app.css` zeroed that padding at the source, the
  `-m-6` had nothing left to cancel and instead pulled the whole frame
  (rail included) 24px past the content box's left edge — from x≈420 to
  x≈396 — landing it under the "Prompt Management" `<aside>`, which clipped
  the leading character of every prompt name and description in
  `PromptSidebar`'s `w-60` list column.
  Fix: removed the `-m-6` (and the negative-margin rationale in the file's
  header comment, replaced with an explanation of why none is needed now).
  `PromptsFrame`'s content box now starts exactly at the shell's content
  edge with 0px offset — flush, well inside the ≤8px budget — instead of
  reasoning about a padding value that `app.css` already owns.
  File: `portal/src/pages/capabilities/PromptsFrame.tsx`.

Verified: `npx tsc --noEmit` clean for both files (pre-existing unrelated
errors in `components/scores/PersonDetailCard.tsx` / `pages/ScoresPage.tsx`
predate this change and are outside this agent's owned directories);
`node --test 'src/pages/sprints/__tests__/*.test.ts'` 44/44 pass (no new
pure logic was extracted — `escapeNesting.ts`'s reducer was already correct
and untouched); `npx vite build` clean;
`scripts/validate-orgiq-audit.sh --quick`'s component-discipline block all
✓ (0 raw styled elements, no JSX `style=`, no native controls, no raw
`<button>`, `PromptsFrame.tsx` still well under its ≤12 queued-composite
budget at 2 raw elements); `scripts/validate-branding.sh --quick`'s header
rhythm block all ✓, including "SubNavLayout `<main>` padding zeroed inside
the shell (one content padding)".

## Fixed (pending re-audit) — scores agent (round 2), 2026-09-05

The round-1 scores fixes above narrowed each defect but didn't close it —
the 23:45 re-audit reproduced a *different* mechanism under the same
symptom for #10 and #12, and #11 down to a single remaining line. All three
root causes below are new findings past what round 1 already fixed.

- **#10 — the skill-search `<input>` DOM node was being replaced on the
  first keystroke.** Not the `InlinePopover` round 1 removed — a second,
  unrelated mechanism in the same file. `SkillFilter.tsx` passed the clear
  button as `suffix={query ? <Button>...</Button> : undefined}`. The
  library's `Input` (`node_modules/@connorhoehnslalom/ui-components/dist/
  Input-*.js`) branches its *entire return value* on whether `prefix`/
  `suffix` are non-null: `!_ && !v ? <input .../> : <div><input/>
  <span>{suffix}</span></div>`. With an empty query `suffix` is `undefined`
  so the component returns a bare `<input>` at this JSX position; typing one
  character makes `suffix` a `<Button>` element, flipping the branch to the
  `<div>`-wrapped form — a root *element type* change (`input` → `div`) at
  that position, which React can only satisfy by unmounting the old `input`
  and mounting an entirely new one inside the new `div`. The browser drops
  focus to `<body>` the instant the old node is removed, and every key
  after the first lands on `<body>` instead of the input — exactly the
  audit's `document.activeElement` finding. Fix: the suffix `Button` is now
  *always* passed (never `undefined`), so `Input`'s branch — and the
  `<input>` node's position in the tree — never changes across a keystroke;
  only the button's own `disabled`/`tabIndex`/`invisible` state change with
  `query`, matching the keyboard contract the round-1 fix already
  established (unreachable by Tab, inert, until there's a query to clear).
  File: `portal/src/components/scores/SkillFilter.tsx`.

- **#11 — the panel's "Influence (PageRank)" was reading a second data
  source, not a scaling gap.** Round 1's `formatScore()` fixed the strip,
  the row, and the panel's new Composite line, all of which read the *same*
  underlying field through the *same* normalizer — but `PersonDetailCard`'s
  Influence line read `detail.influenceScore` from `/api/graph/people/:id`
  (a raw PageRank score from the graph endpoint, `clamp01`'d — see
  `scoresFormat.ts`'s comment on the wire contract), a genuinely different
  number from the leaderboard's `influence` field on the same person, not
  the same value on a different scale. No normalizer closes a gap between
  two different numbers. Fix: `ScoresPage.tsx` now threads the *row's own*
  `influence` (already resolved to the same `ScoreEntry` the Composite
  figure comes from) into the panel as a new `influenceScore` prop, the
  same shape and same null case as the existing `compositeScore` prop
  (`selectedEntry?.influence ?? null`); `PersonDetailCard.tsx` no longer
  reads `detail.influenceScore` at all, renders "Influence" (dropped
  "(PageRank)" — it's the same figure the row's INFLUENCE column shows, not
  a distinct metric that needs a qualifier), and the Composite/Influence
  block now hides as one unit when there's no matching row instead of
  Composite hiding while Influence kept showing a number with nothing to
  agree with. Files: `portal/src/pages/ScoresPage.tsx`,
  `portal/src/components/scores/PersonDetailCard.tsx`.

- **#12 — the row buttons were still remounting on open, not just close.**
  Round 1's id-based `getElementById` restore was necessary but not
  sufficient: `ScoresPage.tsx` still wrapped the leaderboard in `RailLayout`
  *only* once `detail` had loaded (`leaderboardEl = detail ?
  <RailLayout>{leaderboard}</RailLayout> : leaderboard`), so the tree shape
  at that slot changed on **both** the open transition (mount) and the
  close transition (unmount) — not just close. On open, the just-clicked
  row button is torn down and recreated as part of the same re-render that's
  supposed to keep it focused, which is what left `document.activeElement`
  on `<body>` immediately after Enter, before the close-side restore effect
  ever got a chance to run. Fix: stopped wrapping the leaderboard in
  `RailLayout` at all — `{leaderboard}` now renders in one constant JSX
  position regardless of selection state, and `PersonDetailCard` renders as
  an ordinary sibling block below it (`{detail && <PersonDetailCard .../>}`)
  instead of inside a rail slot that only exists sometimes. A row's
  `<button id="score-row-...">` is now the same DOM node before, during,
  and after both transitions, so Enter simply leaves the browser's native
  focus where it already was (no code needed), and the existing
  `getElementById`-in-an-effect restore on close (kept from round 1) now
  finds a node that was never destroyed. File:
  `portal/src/pages/ScoresPage.tsx`.

- **Unfiled: duplicate "Why this score?"** One control, one surface. The
  `▾`/`▴` caret on the "Why this score?" button implied an inline reveal in
  place, but the button actually opened a separate `WhyDrawer` (`Drawer`
  overlay) of the same name — two different UI surfaces claiming the same
  label — and that drawer's `contributions` fetch was gated on the drawer
  being open (`whyOpen && detail.id ? url : ''`), so the first paint of
  every open was "Loading contributions…", and a person with no
  collaborators/projects/decisions on record stayed empty for good. Fixed
  by picking one surface: removed `WhyDrawer.tsx`'s `Drawer` wrapper
  entirely, keeping only its content as a new presentational component,
  `ScoreContributions.tsx`, rendered inside the same `CollapsibleSection`
  every other disclosure on this page already uses (matching "How scoring
  works" below it). `contributions` is now fetched eagerly alongside
  `radar`/`history` as soon as the panel mounts, not gated on the
  disclosure being open, so the section has real content — or an honest
  "No contribution data for this person yet." — by the time anyone expands
  it. Files: `portal/src/components/scores/ScoreContributions.tsx` (new,
  replaces `WhyDrawer.tsx`), `portal/src/components/scores/
  PersonDetailCard.tsx`.

  Verified: `npx tsc --noEmit` clean; `node --test
  'src/**/__tests__/*.test.ts'` 549/549 pass (no new pure logic to extract —
  all four changes are JSX-tree-shape/prop-plumbing fixes, not new
  reducers); `npx vite build` clean; `scripts/validate-orgiq-audit.sh
  --quick`'s component-discipline block all ✓ (0 raw styled elements, no
  JSX `style=`, no native controls, no raw `<button>`);
  `scripts/validate-branding.sh --quick`'s header rhythm block all ✓.

## Fixed (pending re-audit) — middleware agent (round 2), 2026-09-06 04:10

- **#14 — re-audited 2026-09-05 23:45: the round-1 fix made the mock tail's
  TOTAL error count match `totalErrors24h` (25), but the 50-row window
  `/api/observability/recent-invocations` actually returns still dropped 2
  of them.** Round 1's `padErrorsToSummary()` spread every error's
  `hoursAgo` evenly across the full 24h window, same as the hand-authored
  non-error filler — so the ~52-row mock tail (already over the route's
  default 50-row cap on its own) had no structural reason to keep errors
  ahead of non-errors in the newest-first sort. Any live ring traffic
  (`getRecentInvocations` unconditionally prepends `_ring` ahead of the mock
  tail) made it worse: 3 stray live rows accumulated during the audit
  session were enough to push 2 mock errors past rank 50 (reproduced live:
  `curl .../recent-invocations?limit=50` returned Ingestion 10 · Search 7 ·
  Supervisor 3 · Advisor 2 · Graph Builder 1 = 23, against `summary`'s 25).
  New `assignRecency()` in `mock/invocations.ts` overrides every row's
  `hoursAgo` into one of two disjoint, ordered bands instead of trusting
  each seed's individually-authored value: ALL error rows land in
  `[0.05h, 8h)`, ALL non-error rows land in `[8h, 24h)`. Because every error
  row is now strictly more recent than every non-error row, the newest-first
  sort puts the tail's error rows at ranks 0..24 by construction — a 50-row
  window only drops one of them if 26+ *other* rows (live traffic ranked
  ahead of the mock tail, since the merge still prepends `_ring`
  unconditionally) land in front of them first, far more than a manual audit
  session produces, and irrespective of how many non-error mock rows exist.
  Files: `middleware/src/mock/invocations.ts`.
  Test: new `src/lib/__tests__/invocations-window-parity.test.ts` — asserts
  `getRecentInvocations(50)`'s error-row count (total AND per-agent) equals
  `mockAgents`' summed/individual `errorsLast24h` exactly on a fresh ring,
  AND stays exact after 10 synthetic live rows are recorded ahead of the
  mock tail (the literal mechanism that dropped 2 errors during the audit).
  Curl proof (fresh `dev:mock` boot, empty ring):
  `/api/observability/recent-invocations?limit=50` → 50 rows, 25 with an
  `error` field, breakdown `{orgiq-supervisor:3, orgiq-search:7,
  orgiq-advisor:2, orgiq-ingestion:12, orgiq-graph-builder:1}` — exactly
  `/api/observability/summary`'s `totalErrors24h: 25` and its per-agent
  split.

- **#22 — `GET /api/observability/invocations/:id` 404s for every mock id.**
  `routes/invocations.ts`'s `GET /:invocationId` only ever queried Aurora,
  guarded by `isUuid(id)` — dev:mock's tail (`mock/invocations.ts`, ids like
  `mock-inv-33`) fails that check for every row, so every link the tail
  (and `/admin/observability/invocations?status=error`) renders 404'd with
  `{"error":"invocation not found"}`, even though the row the link came from
  is sitting in memory. New mock branch: when `id` isn't a UUID and
  `config.mock.agentcore` is on, resolve it from the same tail
  `getRecentInvocations()` serves (widened to 500 so it covers the whole
  mock fixture, not just the windowed list view) and return the identical
  `{invocation, toolCalls, parent, children}` shape the real Aurora path
  returns. Every field the mock tail has no data for (`judgeScore`,
  token/cost columns, `modelId`, prompt version, parent/children — the mock
  tail carries no call hierarchy) is left `null`/`[]`, never invented.
  `invocation_traces` itself has no error-message column (confirmed against
  `schema/observability_schema.sql` / `observability_sprint2_schema.sql` —
  only `tool_calls.errored`/`error_message` do), so a mock row's `error`
  string is surfaced the same way a real agent-level tool failure would be:
  as a single synthetic `toolCalls[0]` entry (`errored: true, errorMessage:
  <the mock error text>`), not a fabricated top-level field. A real
  (non-mock) UUID id still falls straight through to the unmodified Aurora
  path; an id that's neither a UUID nor in the tail still 404s with the
  same `{"error":"invocation not found"}` body as before.
  Files: `middleware/src/routes/invocations.ts`.
  Test: new `src/routes/__tests__/invocations-mock-detail.test.ts` — every
  id `getRecentInvocations()` actually serves (an error row, a
  guardrail-intervened row, a plain success row, plus a sample of others)
  resolves 200 with the real shape and correctly-`null`'d DB-only fields;
  an unknown id 404s with the unchanged error body; a well-formed but
  unknown UUID still falls through to the real (non-mock) path rather than
  ever hitting the mock 200 branch.
  Curl proof: `GET /api/observability/invocations/mock-inv-0` (an error row)
  → `200` with `toolCalls: [{errored: true, errorMessage: "A2A timeout
  invoking orgiq-scoring after 4500ms", ...}]` and every DB-only field
  `null`; `GET .../mock-inv-does-not-exist` → `404
  {"error":"invocation not found"}`, unchanged.

  Verified: `npx tsc --noEmit` clean; `npm test` 1743/1744 pass across 125/126
  suites (the one failure, `providers/__tests__/activity.test.ts`'s
  "auth-dep-watch only fires weekdays" case, is a pre-existing Sunday-only
  date flake in a file this task doesn't own — `providers/activity.ts` bot
  scheduling — unrelated to `mock/invocations.ts` / `lib/invocations.ts` /
  the observability invocation routes; reproduces identically on a clean
  checkout run today, 2026-09-06, a Sunday).


## Fixed (pending re-audit) — coordinator, 2026-09-06 12:05

- #24: `/iq/prompts` mode switches replace the trigger button with a panel,
  so focus fell to `<body>` in both directions. `ViewPanel.tsx`'s triggers
  carry `data-prompt-edit-trigger` / `data-prompt-test-trigger`;
  `EditPanel.tsx` claims focus on mount (a new `autoFocus` pass-through on
  `LineNumberedTextarea`, which owns the textarea ref), closes on Escape
  (ignored while saving — a half-published version is not abandoned on a
  keystroke), and both Cancel and Escape hand focus back to the trigger by
  its data attribute in a `requestAnimationFrame` (the button is a fresh
  node by then, so a captured ref would be detached — same fix as
  `EstimateDrawer.handleClose`). `TestPanel.tsx` got the identical contract:
  the audit only exercised Edit, but Test is the same shape and would have
  failed the same way.


## Fixed (pending re-audit) — coordinator, 2026-09-06 13:10

- #24 (Test leg): the re-audit found `TestPanel` had the hand-back half of
  the contract but not the claim half, so Enter on "Test ▶" mounted the
  harness with focus on `<body>`. `VariableInput` now takes an `autoFocus`
  and forwards it to whichever control it routes to (`VarCombobox`, which
  forwards to its `Input`; `Textarea`; `Input`), and `TestPanel` sets it on
  the first variable — the same shape as `EditPanel`'s `LineNumberedTextarea`.

## Fixed (pending re-audit) — observability agent, 2026-09-06 23:05

- #25: **An errored invocation's detail page never states the error in
  text.** `/admin/observability/invocations/mock-inv-0` —
  `portal/src/pages/observability` + `middleware/src/routes/invocations.ts`
  (`mockInvocationDetail`). The list row shows "error: A2A timeout invoking
  orgiq-scoring after 4500ms" in plain red text; open that row and the
  RESPONSE block reads "No response text captured for this invocation", and
  the sentence survives only as the `title` tooltip of the red `agent_run`
  bar ("agent_run — A2A timeout invoking orgiq-scoring after 4500ms
  (4.98s)") — mouse-hover only.
  Repro: Health → Read the failures → Enter on any row → read RESPONSE.

  Root cause: the data was never the gap. `mockInvocationDetail` already
  mirrors the tool-call's failure onto `toolCalls[0].errorMessage` exactly
  the way the real path does — invocation_traces has no error column of its
  own, so an errored run surfaces as a single errored `tool_calls` entry on
  both the mock and Aurora paths (confirmed with a curl against
  `GET /api/observability/invocations/mock-inv-0`: `toolCalls[0].errorMessage
  = "A2A timeout invoking orgiq-scoring after 4500ms"`). The middleware
  needed no change. `InvocationDetailPage.tsx` was the gap: it read that text
  only to build the waterfall bar's `title=` attribute (`ToolWaterfall.tsx`),
  never rendering it as visible text — mouse-hover only, so a keyboard or
  screen-reader user never saw it.
  Fix: the Response card now derives `failureMessage` (the first errored
  tool call's `errorMessage`) and, when present, renders it via a library
  `InlineAlert tone="error"` (`role="alert"`) directly above the response
  block — additive to the existing red waterfall bar and the "✗ schema"
  badge, neither of which changed.
  Files: `portal/src/pages/observability/InvocationDetailPage.tsx`.

- #26: **"Clear filters" leaves the old query string in the address bar.**
  `/admin/observability/invocations` — clicking Clear filters from
  `?status=error&agent=orgiq-scoring` resets both selects to "All agents" /
  "All statuses" and restores the 50-row tail, but `location.search` still
  carries both params, so the URL and the view disagree and a reload snaps
  back to the filtered list.

  Root cause: `InvocationsPage.tsx` only ever read its filters from the URL
  once, into local `useState` — the read side (`invocationsFilters.ts`)
  existed, but nothing wrote back, so any filter change (not just Clear)
  left `location.search` stale.
  Fix: a new `applyFiltersToParams(params, agentFilter, statusFilter)` in
  `invocationsFilters.ts` is the write-side counterpart — it sets/removes
  `agentId`/`status` on a copy of the current params (dropping the legacy
  `agent` alias once read, canonicalizing on `agentId`) while preserving
  every other param. `InvocationsPage.tsx` now sources `agentFilter`/
  `statusFilter` directly from `useSearchParams()` instead of local state;
  the Select `onChange` handlers and `clearFilters` all call
  `setSearchParams(prev => applyFiltersToParams(...), { replace: true })` —
  `replace: true` so filter fiddling doesn't fill the back stack, matching
  the pattern already used on `ExplorePage.tsx`/`ProjectsPage.tsx`.
  Files: `portal/src/pages/observability/invocationsFilters.ts` (new
  `applyFiltersToParams` export), `portal/src/pages/observability/InvocationsPage.tsx`.
  Tests: `__tests__/invocationsFilters.test.ts` — 5 new cases (sets both
  params, clears both on "all"/"all", drops the legacy `agent` alias,
  preserves unrelated params, round-trips through the parse* functions).

  Verified together: `npx tsc --noEmit` clean (portal and middleware — the
  latter has one pre-existing unrelated error in
  `middleware/src/providers/assessment.ts`, outside this task's ownership
  and untouched by it), `node --test 'src/**/__tests__/*.test.ts'` 586/586
  pass (570 + 16 new), `npx vite build` clean, `cd middleware && npm test`
  126 suites / 1745 tests pass, and
  `scripts/validate-orgiq-audit.sh --quick` component-discipline block all ✓
  (raw elements 0/0, budget done line reached, no style=, no native controls,
  no raw button). Curl proof for #25:
  `GET /api/observability/invocations/mock-inv-0` →
  `toolCalls: [{ errored: true, errorMessage: "A2A timeout invoking
  orgiq-scoring after 4500ms", ... }]`.

## Fixed (pending re-audit) — prompts/sprints agent, 2026-09-06 14:20

- **#27 — the prompt ARN is drawn under the version select.** Root cause:
  `ViewPanel.tsx`'s ARN line capped itself at `max-w-[480px]` — a guess,
  unrelated to how wide the header's left column actually is — against a
  `DetailHeader asideWidth={380}`. Arithmetic (at 1552px, from the filed
  measurement): the header's content row is viewport minus a stack of
  fixed-width chrome (shell rail, tenant rail, the prompt rail's `w-60`
  =240px, this panel's `px-6` padding) — none of which scale with the
  viewport — so the row shrinks 1:1 with it, and works out to ≈772px wide at
  1552px (≈660px at 1440px, 112px narrower). With `asideWidth=380` and a
  `gap-3` (12px) between the two columns, the left column only ever had
  772-380-12=380px to work with — 100px short of the ARN's 480px box, which
  is what put it 88px under the select once rendered.
  Fix: `asideWidth` 380 → 420, and the ARN's cap 480px → 200px, both in
  `ViewPanel.tsx`. 420 was sized from the aside's own contents: the version
  select (~110px) + gap(8) + "Test ▶" (~90px) + gap(8) + "Edit / new
  version" (~185px) ≈ 401px, so 380 was clipping both buttons onto extra
  lines by design, not by accident; 420 leaves ~19px of slack. That puts the
  left column at 772-420-12=340px at 1552px and 660-420-12=228px at 1440px —
  200px clears the tighter (1440px) case with ~28px to spare, so the ARN now
  truncates inside its own column across the whole 1440–1552px range instead
  of overflowing it. The full ARN is still carried in the `title` attribute.
  File: `portal/src/pages/capabilities/prompts/ViewPanel.tsx`.

- **#28 — cancelling the sprint grant form now returns focus to its trigger
  on both the Escape and Cancel paths, via the same commit-timed effect.**
  Root cause: `GrantsPanel.tsx`'s `closeAdd`/`closeEdit` — called identically
  by both the Escape handler (`handleNestedEscape`) and each form's Cancel
  button — restored focus with `requestAnimationFrame(() =>
  document.querySelector(selector)?.focus())`. `rAF` schedules its callback
  against the browser's *next paint*, which a backgrounded/hidden tab is
  free to throttle or skip, and a keyboard-driven state commit and a
  pointer-driven one are not guaranteed to reach that next paint on the same
  schedule — so the two paths, while running byte-identical code, did not
  reliably land the focus call on the same tick. The reducer in
  `escapeNesting.ts` itself was not the gap (it already pops the one layer
  the Escape handler names, same as the Cancel button's targeted `close`),
  and both paths were already calling the same close helper — the gap was in
  what that helper used to schedule the DOM side effect.
  Fix: replaced the `requestAnimationFrame` call with a `pendingFocus`
  piece of state, set by `closeAdd`/`closeEdit` alongside the `close`
  dispatch, and a `useEffect` (keyed on `pendingFocus`, `adding`, `editId`)
  that runs the `querySelector(...)?.focus()` on React's own commit —
  after the trigger button has remounted — for both paths, with no
  dependency on animation-frame/paint scheduling. Also added a node test
  (`escapeNesting.test.ts`) pinning the invariant the fix leans on: closing
  the current top layer by its own id (what Escape and Cancel both do)
  produces the identical stack a bare `{ type: 'escape' }` pop would, so a
  future edit can't quietly swap the Escape path onto the generic pop and
  skip whatever close helper carries the focus-restore.
  Files: `portal/src/pages/sprints/GrantsPanel.tsx`,
  `portal/src/pages/sprints/__tests__/escapeNesting.test.ts`.
  Note: `SprintBoard.tsx`'s `AddItemControl` shares the same
  `requestAnimationFrame`-based pattern for its own "+ Add work item" form
  but is outside defect #28's filed scope — not touched here.

Verified together: `npx tsc --noEmit` clean, `node --test
'src/pages/sprints/__tests__/*.test.ts'` 45/45 pass (1 new), `npx vite
build` clean, `scripts/validate-orgiq-audit.sh --quick` component-discipline
block all ✓ (0 raw styled elements, budget done line reached, no style=, no
native controls, no raw button), `scripts/validate-branding.sh --quick`
header-rhythm block all ✓.


## Fixed (pending re-audit) — coordinator, 2026-09-06 23:30

- #29 (both halves): the aside was 420px and the audit measured the labels
  at 61px and 97px, which with the 246px select and two 8px gaps filled it
  exactly — so BOTH buttons wrapped. They are one word each now ("Test",
  "Edit", `size="sm"`, the fuller sense in a `title`), ≈366px total, ~54px
  of slack. And the ARN shows its identifying TAIL rather than its head:
  every prompt's ARN opens with the same
  `arn:aws:bedrock:<region>:<account>:prompt/`, so a 200px head-truncated
  box read `arn:aws:bedrock:us-east-1:000…` for all six. `arnTail()`
  (pure, in `prompts/promptFormat.ts`, tested) keeps the tail and cuts at a
  segment boundary; the full ARN stays in `title`.


## Fixed (pending re-audit) — coordinator, 2026-09-07 14:20

- #30: the initiative's name was glued to the end of the reason sentence
  ("Blocked on Auth Migration"), so a 233px card ellipsised exactly the word
  that says which initiative it is about. Two changes: `reasonFor()` in
  `middleware/src/lib/work-suggestions.ts` now returns the state alone
  ("Blocked", "Waiting in review", "Not started", "Upkeep") and the name
  travels in the `initiativeName` field it already had; `InvokePage.tsx`
  passes it to `SuggestionCard`'s own `context` slot ("where it points"),
  which is not truncated. The grid also went `auto-fill`/220px →
  `auto-fit`/260px with `w-full`, so the cards use the ~350px of column that
  sat empty beside them. The Work page's queue and assign modal already
  showed the initiative in their own column, so dropping it from the reason
  removed a repetition there too.
