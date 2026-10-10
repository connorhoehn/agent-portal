# HR-admin-role defects — org tenant

Found auditing u-rachel / Rachel Kowalski (hr-admin) against
`docs/orgiq-journeys/MATRIX.txt`. Repro steps assume signed in as Rachel
Kowalski / HR Admin at 1552px, `middleware dev:mock`. Several bugs member
found on shared components (Initiatives/Library/Promotions/Designs row
keyboard access, Promotions/Designs status-pill filters, and the missing
`RequireRole` on `/iq/prompts`+`/iq/history`+`/iq/evaluations`) were fixed by
another agent mid-session and reproduce cleanly as **fixed** here — see the
`notes:` line on each of those surfaces' `.md` logs for the file-mtime
evidence. They are not repeated below; only defects that still reproduce for
hr-admin, or are new to this role's write/admin surfaces, are listed.

## Open

Found on the 2026-10-01 re-walk (headless Chromium 1680x940 via Playwright,
own middleware dev:mock on :3045 + Vite :5245, signed in as u-rachel /
orgiq / hr-admin, ui-components 2.407.40). Each was reproduced at least twice.


#33–#40 were closed on 2026-10-06 (see Closed); #41–#46 were found on the
2026-10-06 11:50 headless re-walk (Chromium 1680x940, shared dev:mock, u-rachel).

## Closed

47. ~~Search › Connections (`/iq/explore` lands here): a mouse cannot click or hover a node on the all-types graph.~~ **Closed 2026-10-06 12:50** — re-observed with real mouse clicks (Playwright click() and hover; ui-components 2.418.0): the record graph node buttons compute pointer-events auto, elementFromPoint over a node returns the node, and a click took the graph from 53–55 to 15 nodes ("1 selected", zoom 54% to 97%); a second click made "2 selected".

48. ~~People org graph: after two or three picks the drawing sits on the 40% zoom floor with unreadable captions and can run under the detail card.~~ **Closed 2026-10-06 12:50** — re-observed with real mouse clicks: people-graph picks re-fit at 102% / 90% / 90% (three picks) and 100% for a single pick, not the 40% floor; the selected person is on screen and legible, earlier far picks scroll out of view by design. One click timed out on Playwright's stability wait in the first pass and passed on rerun.

41. **Settings logs two 404 console errors on every load.** `/settings` — `GET
    http://localhost:3001/metrics` and `/cluster` both 404 on mount (BFF root, not
    `/api`); same cause as org-leader #38. Repro: open /settings as u-rachel with the
    console open.

    *Closed 2026-10-06 12:45 (headless Chromium 1680x940, shared dev:mock, ui-components 2.418.0, u-rachel): /settings loads with 0 console errors and 0 4xx responses; no /metrics or /cluster request.*

42. **Automate Inbox: the Recent runs table starts 716px down for hr-admin.** `/iq/work`
    — the open agent question carries an answer textarea and a disabled "Send answer" button,
    which pushes the first `tbody tr` of Recent runs to 716px (org-leader sees the same page
    without the answer box: 618px). Over the 640px budget. Suspect the Inbox composition in
    `portal/src/pages/work` (the question card's answer box height or its position above
    the queue counters).

    *Closed 2026-10-06 12:45 (headless Chromium 1680x940, shared dev:mock, ui-components 2.418.0, u-rachel): the open question is a collapsed Disclosure; the first Recent runs row is at 540px (opened it moves to 746px, by choice).*

43. **Identity > Roles logs a 503 console error on every load.** `/admin/identity/roles`
    — `GET /api/identity/schema` answers 503 (twice per load in this walk). The matrix
    renders; the page shows no message about the failure. Suspect the schema request
    the Identity layout makes for the Schema sibling
    (`portal/src/pages/admin/identity`) against the mock identity router.

    *Closed 2026-10-06 12:45 (headless Chromium 1680x940, shared dev:mock, ui-components 2.418.0, u-rachel): /admin/identity/roles loads with 0 console errors; GET /api/identity/schema no longer answers 503 under dev:mock.*

44. **Identity > Users: the four tenant tiles cut their role lists with no title.**
    `/admin/identity/users` — "orgiq · ACTIVE · roles: hr-adm…" (234px of 390px), "assessment ·
    ACTIVE · roles: a…" (245/356), "social · ACTIVE · roles: commu…" (234/339), "pipelines · ACTIVE ·
    roles: au…" (245/306); no `title`/`aria-label`. The role lists are what the tiles are for.
    Suspect the tenant `StatStrip` hints in `portal/src/pages/admin/identity`.

    *Closed 2026-10-06 12:45 (headless Chromium 1680x940, shared dev:mock, ui-components 2.418.0, u-rachel): the four tenant tiles still cut the role list visually (234px of 390px) but each tile carries the full "<tenant> · ACTIVE · roles: …" text as its title.*

45. **Capabilities > Crawl: the page-screenshot request 404s and logs a console error.**
    Reached from `/admin/capabilities` (Enter on the first link as hr-admin → `/admin/ingest/crawl`):
    `GET /api/ingest/crawl/crawl-mock-0004/page/0/screenshot` → 404. The Capabilities page itself
    logs none. Suspect the mock crawl fixture lacking screenshots for the latest crawl.

    *Closed 2026-10-06 12:45 (headless Chromium 1680x940, shared dev:mock, ui-components 2.418.0, u-rachel): /admin/capabilities then /admin/ingest/crawl: 0 console errors, GET /api/ingest/crawl/crawl-mock-0004/page/0/screenshot answers 200.*


46. **Initiative detail: six work-graph node headers are cut with no title.** Same as
    org-leader #39 (`/iq/projects/p-observability`, 1,250–1,830px down the Overview tab);
    re-check after the work-graph change lands.

    *Closed 2026-10-06 14:10 (ui-components 2.416.0, headless Chromium 1680x940, u-rachel): the work-graph node header now carries a `title` holding the full name. The sweep still reports the strings clipped by their single-line ellipsis box (e.g. "Span-metrics connector feeding RED dashboards" 130 of 292px) but every one is titled with its whole text, the deliberate ellipsis-with-hover pattern the protocol accepts. Checked by reading the `title` attribute, not by a physical hover (headless).*

33. **Initiatives: the program table is wider than its pane, so the Updated
    column is cut.** `/iq/projects` at 1680px — the table is 969px inside a
    948px `overflow-x: auto` wrapper; the "UPDATED" header reads "UPDATEI" and
    every value reads "1h ag" / "24m ag" at the pane's right edge. Reachable
    only by scrolling the wrapper sideways. Cause: the list page stacks the
    220px "INITIATIVES" view rail (All initiatives / My initiatives / Sprints)
    beside the 264px explorer rail, while the detail page folds the same view
    list into the explorer rail. Suspect `portal/src/pages/ProjectsPage.tsx`
    and the Initiatives sub-nav in `portal/src/pages/iq/IqLayout.tsx` /
    `iqSubNavCatalog`. The 2026-09-30 lane-E screenshot at 1552px already shows
    it, worse.
    **Closed 2026-10-06 11:55** — re-observed as u-rachel (hr-admin), 1680x940. The program table fits its pane (no overflow wrapper wider than its client width) and the Updated column is now a status pill with a relative time under it; first `tbody tr` at 302px.

34. **Promotions: "Find a candidate" keeps only the last key typed.**
    `/iq/promotions` (lands on `/iq/distillation/review?view=promotions`).
    Click the field, type `ADOT` one key at a time (tested at 0, 120 and 250ms
    per key): the field reads `T`, the URL reads `q=T` and all four
    candidates stay listed. Pasting `ADOT` (or opening `?q=ADOT`) filters to the
    one ADOT candidate correctly, and the Distillation knowledge search on
    the same module keeps `Aurora` intact, so the fault is local to this field.
    Suspect `portal/src/pages/promotions/PromotionsPage.tsx:308` — the
    `SearchInput` is bound straight to the URL `q` via `setFilter` →
    `setParams(next, { replace: true })`.
    **Closed 2026-10-06 11:55** — re-observed as u-rachel. Typing "zzznope" one key at a time at 250ms leaves the box `zzznope` and the URL `?view=promotions&q=zzznope`; the list reads "No candidates in this view".

35. **A not-found id reads as an outage on Library, Designs and Promotions,
    and Session config's "no bundle" 404 does too.** `/iq/library/nope-asset`
    → "Could not load this asset · 404 Not Found — asset not found. Assets are
    read from the library catalog, so this is unknown rather than empty. Try
    again"; `/iq/designs/des-nope` → the same shape for designs;
    `/iq/promotions/nope-cand` → "…promotion candidate not found. Promotion
    candidates, so this is unknown rather than empty."; with
    `session-bundles` on its `empty` scenario `/iq/release` → "Could not load
    configuration preview · 404 Not Found — no live session bundle. Session
    bundle provider, so this is unknown rather than empty." All four use
    `UnavailableNotice` (outage framing + Try again) for a definite 404.
    Initiative detail does it right ("Initiative not found / No initiative has
    the id … / ← Back to Initiatives"). Second fault, same component:
    `source` is meant to be a clause ("X are read from Y"), and three call
    sites pass a bare noun, producing the broken sentences quoted above —
    `PromotionsPage.tsx:311,322`, `DesignsPage.tsx:108` (the rail; the pane at
    :120 is right), `local-compute/ConfigurationPage.tsx:98,102`.
    **Closed 2026-10-06 11:55** — re-observed as u-rachel. /iq/library/lib-nope → "Asset not found / No library asset has the id … ← All assets"; /iq/designs/des-nope → "Design not found … ← All designs"; /iq/promotions/nope-cand → "Candidate not found …" (item=nope-cand); with session-bundles on its empty scenario (that fixture only, restored) Session settings reads "No configuration preview / No session bundle has been published yet, so sessions run with the settings baked into their image." No outage framing, no Try again, no broken sentence.

36. **Library: opening a never-distilled asset logs a console error.**
    Open the first row ("Review a PR diff-scoped") from `/iq/library` →
    `GET /api/distillation/library/skill-pr-review-scoped/provenance` 404 →
    "Failed to load resource … 404" in the console. 5 of the 12 seeded assets
    do it (skill-pr-review-scoped, lib-stakeholder-email, lib-adr-summary,
    orgiq-supervisor-system-prompt, orgiq-search-system-prompt).
    `portal/src/pages/library/DistillationProvenance.tsx` documents 404 as the
    normal "never distilled" answer; the API should answer that case with a
    200 and an empty body instead of an error status.
    **Closed 2026-10-06 11:55** — re-observed as u-rachel. Clicking the first library row (Review a PR diff-scoped) lands on /iq/library/skill-pr-review-scoped with zero console errors and no response >= 400 (the provenance request no longer 404s).

37. **Local compute: the "Pair a machine" modal opens with focus left on
    `<body>`.** `/iq/local-compute` → focus "Pair a machine" → Enter. The
    `aria-modal` dialog opens with its code, but `document.activeElement` is
    `<body>` at 100, 600 and 1500ms and after two forced frames
    (`requestAnimationFrame` verified firing). Tab then enters the dialog and
    Escape returns focus to the trigger, so the close half works. The
    2026-09-16 walk recorded focus landing inside. `PairMachineDialog.tsx` has
    not changed since 2026-09-16, so suspect the library `Modal` at
    ui-components 2.407.40.
    **Closed 2026-10-06 11:55** — re-observed as u-rachel. Enter on "Pair a machine" opens the dialog with focus on its "Done" button (two forced frames); Tab → "Copy code"; Escape closes and returns focus to "Pair a machine".

38. **Prompt Studio: the focus hand-backs are lost again (#24's legs).**
    `/iq/prompts` → Edit → Cancel, Test → Close, and Test → Escape each leave
    focus on `<body>` (after forced frames, rAF verified firing). Entering
    each mode is fine (Edit lands in "Prompt template", Test in the first
    variable input). The triggers do carry `data-prompt-edit-trigger` /
    `data-prompt-test-trigger`; the rAF lookups in
    `portal/src/pages/capabilities/prompts/EditPanel.tsx:53-58` and
    `TestPanel.tsx:24-28` run before the fresh trigger is in the DOM, or the
    trigger is replaced again after it.
    **Closed 2026-10-06 11:55** — re-observed as u-rachel. Prompt Studio: Edit → Cancel returns focus to Edit; Edit → Escape returns to Edit; Test → Close returns to Test; Test → Escape returns to Test (each read after two forced frames and again after a second wait).

39. **Prompt Studio: every prompt row clips its name and description with no
    way to read the rest.** The rail column gives 179px; the six names need
    186–232px ("orgiq-supervisor-system-…", "orgiq-graph-builder-syste…")
    and every description is cut after a few words. No `title` on the text or
    on any ancestor. Selecting a row shows the full name in the editor header,
    but the description appears nowhere else on the page. The rows are the
    library's `ChoiceRow` (`portal/src/pages/capabilities/prompts/PromptSidebar.tsx:59`),
    so the fix is probably a `title` in the library or a wider rail.
    **Closed 2026-10-06 11:55** — re-observed as u-rachel. The Prompt Studio list wraps names and descriptions; the clipped-text sweep over the whole <main> reports 0 cut strings.

40. **Automate: "New run" opens the Runs list with the new-run form 1,500px
    below the fold.** `/iq/work` → New run → `/iq/work/queue?compose=1#new-run`.
    The `#new-run` form ("NEW RUN … Title … What should the worker do? … Queue
    run") sits at top 1651px under the ~77-row runs table. The content pane
    is scrolled only 135px, so the screen shows a slice of the runs table
    with the page title scrolled off, and focus is on `<body>`. The button's
    promise is not on screen. Suspect `portal/src/pages/work/QueuePage.tsx`:
    the compose form should open where it is seen and take focus.
    **Closed 2026-10-06 11:55** — re-observed as u-rachel. /iq/work → "New run" (Enter) goes to /iq/work/queue?compose=1 under the H1 "Runs" with focus on an input at 428px from the top of a 940px viewport; there is no #new-run anchor and no scroll offset, so the form is on screen and focused.

32. **Computer Lab: the terminal pane is a keyboard trap, and it strands the
    user before the Broadcast instruction box.** `/admin/devbox` — the surface
    is `ComputerLab` from `@connorhoehnslalom/ui-components/compute`
    (`portal/src/pages/admin/DevboxPage.tsx` is 86 lines of wiring around it),
    so the fix belongs to the library; also queued in
    `docs/ui-components-queue.md`.

    Repro (hr-admin, 1552px, `middleware dev:mock`): with an EMPTY fleet the
    surface is clean — 35 tabbable controls, all 35 reached in a 36-press Tab
    sweep. Provision one computer (`POST /api/devbox/boxes {"label":"kbd-probe"}`,
    or the "+ new computer" button), which opens a pane, then sweep again:
    40 tabbable controls and only **37** reached in 55 presses. The three never
    reached are "⌘K Search", "▶ focused pane" and the "Broadcast instruction"
    textarea — the last being the one control the surface exists for.

    Cause, isolated rather than inferred: focus seated on
    `textarea.xterm-helper-textarea` inside the pane never leaves it.
    Tab, Shift+Tab, Escape, Ctrl+Tab and Alt+Tab were each pressed with focus
    in that textarea and `document.activeElement` was identical before and
    after every one of them. A terminal consuming Tab is correct — that is
    shell completion — but there is no escape hatch, so a keyboard user who
    tabs into a pane cannot reach the broadcast bar, the pane switcher, or
    back out to the rail. The mouse is the only exit. WCAG 2.1.2 (No Keyboard
    Trap).

    **Closed 2026-09-15 07:25.** Fixed in the library: ui-components 2.260.0 adds a
    `leave-pane` command bound to ⇧esc (leader `q`) — a chord no shell wants —
    that moves focus from a pane to the Broadcast instruction textarea; the
    lab already listened in the capture phase, so it fires from inside
    xterm's helper textarea, and the ⌘/ shortcut sheet lists it. Verified
    live as hr-admin with a provisioned computer: focus in the pane, ⇧esc,
    `document.activeElement` is the prompt bar; plain Tab still belongs to
    the shell. Portal pinned to 2.260.0 (`8b96a107`).

31. **Ask's work starters clip the initiative name — the one word that says
    which initiative the card is about.** `/iq/invoke` —
    `portal/src/pages/InvokePage.tsx` (the `askSuggestions.slice(0, 4)` block,
    laid out on `grid-cols-[repeat(auto-fill,minmax(220px,1fr))]`) and the
    `SuggestionCard` reason line (`text-[11px] text-text-secondary truncate`)
    plus its title (`line-clamp-2`).
    Observed live as u-rachel (hr-admin) and again as u-vera (org-leader) at
    1552px on 2026-09-07: the four cards resolve to 233px each inside a 956px
    band that itself sits in a 1304px content column, leaving roughly 350px of
    that column empty beside them. At 233px every card's reason line overflows
    and is ellipsised — "Blocked on Auth Migrati…", "Blocked on Observabilit…",
    "Waiting in review on L…", "Waiting in review on M…", and for org-leader
    "Not started on Auth Migr…" — and three of hr-admin's four (two of
    org-leader's four) also clamp the question itself. Measured per node with
    `scrollWidth > clientWidth` / `scrollHeight > clientHeight`, not by eye.
    The reason line is the only place the card names the initiative, so a
    reader with fourteen initiatives cannot tell from the card which one is
    blocked without sending the question. The full string IS in each card's
    `aria-label` ("Who can unblock \"…\"? — Blocked on Auth Migration"), so a
    screen-reader user gets what a sighted user does not.
    Repro: `/iq/invoke` at 1552px as any role with work suggestions →
    the four "FROM YOUR WORK" cards → every reason line ends in an ellipsis.
    Fix shape: let the band use the content column's width (the grid is already
    auto-fill, so the cap is the band, not the cards), or drop to three cards
    at a readable width, or put the initiative name where it can wrap.
    **Closed 2026-09-07 14:10** — fixed by another agent at 14:03, mid-audit,
    and re-observed here on the fixed build as u-rachel (hr-admin) at 1552px.
    Two changes in `InvokePage.tsx`: the grid moved from
    `repeat(auto-fill, minmax(220px, 1fr))` to
    `repeat(auto-fit, minmax(260px, 1fr))` with `w-full`, and each card is now
    passed `context={sg.initiativeName}` so the initiative rides its own
    untruncated slot instead of the tail of the reason line. Measured after the
    change: cards are 313px each (grid computes to 313.3px x 3), and a per-node
    `scrollWidth > clientWidth` / `scrollHeight > clientHeight` sweep across all
    four cards returns **zero** clipped nodes for hr-admin and zero for
    org-leader. The cards read in full — "Blocked / Who can unblock
    \"Tenant-by-tenant cutover runbook with rollback\"? / Auth Migration" — with
    the reason line reduced to the bare kind. Cost of the fix: the four cards
    now wrap 3+1 inside the 956px band rather than sitting four across; the
    orphan on row two is less tidy but everything is legible and the whole
    starter, "OR TRY:" block and composer still fit above the fold (last card
    bottom 561px, composer bottom 853px, viewport 913px).

30. **New tenant: Create lights up for an id the field's own label forbids,
    and the rejection lands behind the drawer.** `/admin/identity/users` →
    "+ Tenant" — `portal/src/pages/identity/UsersPage.tsx` (`NewTenantForm`,
    the `disabled={busy || !id.trim()}` on Create; the page-level
    `{error && <InlineAlert tone="error">}` inside `PageSection`; the
    `onSubmit` that only calls `setShowNewTenant(false)` after a successful
    POST) against `middleware/src/routes/identity.ts` (`POST /tenants`, which
    requires `^[a-z][a-z0-9-]{1,30}$` and otherwise 400s
    "id must be lowercase kebab-case, 2-31 chars").
    Observed live as u-rachel at 1552px on 2026-09-07: the field is labelled
    "ID (kebab-case)" and hinted "e.g. assessment"; typing three spaces
    correctly leaves Create disabled (it trims), but typing
    `   audit probe TENANT` — spaces, uppercase, and a leading run of
    whitespace — flips Create to enabled with no inline error, no
    `aria-invalid`, and no other feedback. The only client guard is
    non-empty-after-trim, so the button invites a click the server is
    guaranteed to refuse.
    The second half is read from the source rather than pressed: `run()` puts
    the server's message in the page-level `error` state, which renders as an
    `InlineAlert` inside `PageSection` — a sibling of the `Drawer`, behind it —
    and the drawer is only closed on the success path, so a 400 leaves the
    form open, unchanged, over an alert the user cannot see. Same shape as
    defect #1 (a click whose only observable outcome is nothing happening).
    Create was deliberately not pressed: it is a write against shared
    dev:mock state that other journey logs read from.
    Repro: `/admin/identity/users` → "+ Tenant" → type `Acme Corp` in ID →
    Create is enabled; press it and the drawer stays as it was.
    Fix shape: mirror the server regex in the form (disable Create and mark
    the field until the id matches), and render the failure inside the drawer
    the way `PromotionsPage` now renders `actionError`.
    **Closed 2026-09-07 13:48** — re-observed live as u-rachel (hr-admin) at
    1552px on dev:mock, typing into the "+ Tenant" drawer's ID field with real
    key events and reading the field's `aria-invalid`, its `aria-describedby`
    hint and the Create button's `disabled` property after each string. The
    exact string this defect was filed against, `   audit probe TENANT`, now
    leaves Create disabled and the hint reading "No spaces — use hyphens, like
    \"field-ops\"." with `aria-invalid="true"`. Four more: `Assessment` →
    "Lowercase only, like \"field-ops\"."; `2fast` → "Start with a letter.";
    `has_underscore` → "Letters, digits and hyphens only."; `a` → "Between 2
    and 31 characters." A valid id, `field-ops2`, puts the hint back to
    "e.g. assessment", drops `aria-invalid` and enables Create. Create was not
    pressed — it writes to shared dev:mock state — and GET /api/identity/tenants
    after closing the drawer still returns exactly orgiq and assessment. The
    rule lives in `tenantIdProblem()` (`portal/src/pages/identity/identityFormat.ts`),
    node-tested in `identity/__tests__/identityFormat.test.ts` against the
    server's own `^[a-z][a-z0-9-]{1,30}$`. The second half — the server's
    refusal landing behind the drawer — was verified by source read rather than
    by pressing Create: `NewTenantForm` now takes an `error` prop and renders it
    as an `InlineAlert` as its first child inside the `Drawer`, and the page
    passes its `error` state down at the `<Drawer open={showNewTenant}>` call
    site (`portal/src/pages/identity/UsersPage.tsx`).

10. **Library and Promotions render without the breadcrumb trail their rail
    siblings carry.** `/iq/library` and `/iq/promotions` —
    `portal/src/components/shell/Breadcrumbs.tsx` (`resolveBreadcrumbs`).
    `/iq/designs` (same Design rail group) shows "Design › Designs" and every
    other audited route shows a trail ("Plan › Initiatives", "Org › Ask",
    "Build › Automate", "Plan › Budgets", "Build › Computer Lab" …), but the
    `iq` switch has no `library` or `promotions` case, falls through to
    `default` and returns `[]`, so `<nav aria-label="Breadcrumb">` is absent
    from the DOM and the H1 sits at 85px instead of under a trail. Found
    2026-09-06 00:28; re-checked 08:00 after a fresh hr-admin sign-in — still
    absent on both routes.
    Repro: open `/iq/library` or `/iq/promotions` →
    `document.querySelector('nav[aria-label="Breadcrumb"]')` → `null`; open
    `/iq/designs` → "Design › Designs".
    **Closed 2026-09-06 11:44** — re-observed as a fresh hr-admin (u-rachel)
    sign-in at 1552px on both routes: `/iq/library` now renders
    `nav[aria-label="Breadcrumb"]` reading "Design › Library" and
    `/iq/promotions` reads "Design › Promotions", the same shape /iq/designs
    carries. The H1 moved from 99px to 125px on both, sitting under the trail
    instead of flush against the header rule.

9. **Bots: the "N bots" summary count doesn't track the filtered list.**
   `/admin/bots` — `portal/src/pages/bots/BotsPage.tsx`. Searching a name
   that matches nothing correctly renders "No bots match the current
   filters." in the table, but the line just above it still reads "5 bots ·
   every change still passes review + policy gates" — the count is computed
   from the unfiltered fetch, not the filtered view.
   Repro: `/admin/bots` → type "zzznoexistbot" in the search box → table
   empties, count line still says "5 bots".
   **Closed 2026-09-06 08:09** — typing "zzznoexistbot" empties the table to
   "No bots match the current filters" + Clear filters and the summary line
   reads "0 of 5 bots match · every change still passes review + policy
   gates"; with no filter it reads "5 bots".

8. **Prompt Studio leaks a raw backend error even for an authorized role.**
   `/iq/prompts` — `portal/src/pages/capabilities/PromptsPage.tsx`. Shows
   both "No prompts yet / The Bedrock Prompt Library is empty for this
   tenant." AND the literal `{"error":"Bedrock unavailable","detail":"The
   security token included in the request is invalid."}` in a red box at the
   same time — contradictory messaging, and the second is unformatted JSON
   from the backend. This role-gating on this route is now fixed (App.tsx
   wraps it in `RequireRole roles={['org-leader','hr-admin']}`), but the
   error-handling bug member found is independent of role and still
   reproduces for hr-admin, who is legitimately allowed here.
   Repro: sign in as hr-admin or org-leader → `/iq/prompts`.
   **Closed 2026-09-06 08:07** — as hr-admin, `/iq/prompts` loads a six-prompt
   library from the dev:mock provider (orgiq-supervisor/search/scoring/
   advisor/ingestion/graph-builder-system-prompt, DRAFT, real template text)
   with no error box and no "No prompts yet" text; the search zero-match
   reads "No prompts found". The raw-JSON + empty-state contradiction no
   longer renders.

7. **Health's error count doesn't lead anywhere: Invocations always reads
   "No invocations yet."** `/admin/observability/summary` links "Read the
   failures on Supervisor, Search, Advisor, Ingestion, Graph Builder" (25
   errored invocations in 24h) straight to
   `/admin/observability/invocations` — `portal/src/pages/observability/
   InvocationsPage.tsx` — which permanently shows "No invocations yet. Send a
   message via the Agent Tools page…" regardless. The "All agents" filter
   select there also has only its own default entry — no agent names —
   while "All statuses" correctly lists OK/Blocked/Error, because the agent
   list derives from the (empty) live tail, not the 6 deployed agents Health
   already knows about. Likely a dev:mock-only symptom (CloudWatch poller
   isn't running against a laptop middleware per CLAUDE.md) — re-check
   against a deployed stack before treating as a real-environment bug.
   Repro: Health → click "Read the failures…" → lands on Invocations → empty.
   **Closed 2026-09-06 08:03** — Health's "Read the failures on …" and "Open
   Runs →" both link to `/admin/observability/invocations?status=error`;
   that page lands pre-filtered on Error with 25 rows (matching Health's 25),
   the "All agents" select lists Advisor/Graph Builder/Ingestion/Scoring/
   Search/Supervisor, each row's timestamp link opens
   `/admin/observability/invocations/<id>` (breadcrumb "Operate › Health ›
   Runs › Invocation mock-inv-0"), and a zero-match filter
   (`?agentId=orgiq-scoring&status=error`) renders "No invocations match" +
   Clear filters instead of the true-empty text.

1. **Promotions: a successful Approve leaves the open drawer showing stale
   state, and a same-drawer retry fails silently.** `/iq/promotions` —
   `portal/src/pages/promotions/PromotionsPage.tsx`. Opening "Retry the Data
   API through an Aurora cold start" and clicking Approve fired `POST
   /api/promotions/promo-aurora-cold-start/promote`, which succeeded, but the
   drawer kept showing the "Candidate" badge and the same enabled buttons
   with no toast; a second Approve 409'd silently. **Closed 2026-09-06 00:28**
   — as hr-admin the drawer for that skill (no passing dry run) offered only
   "Approve + record a passing dry run" and Dismiss; clicking it fired one
   POST → 200, the badge flipped Candidate → Promoted, the Next step read
   "Promoted — now running unattended as a skill.", both buttons
   disappeared, a "Promoted" toast showed, and the list re-fetched to
   Promoted. No second POST is possible from the drawer.

2. **Budgets stacks two spend-breakdown cards above the table.**
   `/admin/budgets` — `portal/src/pages/budgets/BudgetsPage.tsx`. A
   description line, a 4-tile stat strip AND two side-by-side cards (Spend by
   model, Spend by trigger) sat above the initiative table. **Closed
   2026-09-06 00:30** — above the table there is now exactly one description
   line and one StatStrip; "Spend by model" / "Spend by trigger" render at
   1172px, below the 14-row table (every initiative listed); first-row-top
   337px.

3. **Scores: the leaderboard table sits below the fold.** `/iq/scores` —
   first-row-top measured 795px behind six stacked blocks. **Closed
   2026-09-06 00:31** — first-row-top measures 473px at 1552px; above the
   table: one StatStrip, one description line, one filter row (skill search ·
   "Weighting: 55% / 45%" popover button · Department select); "How scoring
   works" is a collapsed section below the table.

4. **Scores: leaderboard rows are mouse-only.**
   `portal/src/components/scores/Leaderboard.tsx` — the only focusable
   descendant was the compare checkbox. **Closed 2026-09-06 00:31** — each
   row's name is a real `<button>` in the tab order after its Compare
   checkbox; Enter on "Hiro Green" opened the person panel (heading + Close
   button), Escape closed it and returned focus to the same name button.

5. **Scores: the skill-search typeahead fails silently on no match.**
   `portal/src/components/scores/SkillFilter.tsx`. **Closed 2026-09-06 00:31**
   — typing "zzznoexistskill" opened the combobox popover (aria-expanded=true)
   with `No skills match "zzznoexistskill"` and a "Clear search" action while
   the leaderboard stayed put behind it.

6. **Architecture: every graph node is unreachable by keyboard.**
   `/iq/agents` — `portal/src/pages/AgentFlowPage.tsx` / `AgentFlowFrame.tsx`;
   nodes computed `visibility: hidden`. **Closed 2026-09-06 00:33** — all 6
   `.react-flow__node` elements compute `visibility: visible`, each node card
   is a `role=button` with an aria-label ("Supervisor — healthy, open
   metrics"), a 60-press Tab sweep reached every one, Enter on Supervisor
   opened the metrics drawer (focus on Close) and Escape closed it with focus
   back on the node card.

## Fixed (pending re-audit) — promotions/budgets/bots agent, 2026-09-05 19:05

1. **Promotions stale drawer / silent 409 — closed.**
   `portal/src/pages/promotions/PromotionsPage.tsx`,
   `portal/src/pages/promotions/promotionFormat.ts`. Root cause: the server's
   `decidePromotion` gate (`middleware/src/providers/promotions.ts`) always
   409s a plain Approve on a skill with no passing dry run — even on the very
   first click — while still recording the approval as a side effect
   (`status: 'candidate' → 'approved'`). The old drawer showed a plain
   "Approve"/"Promote" button for exactly that shape, so every click
   guaranteed a swallowed 409 and a state change the drawer never displayed.
   Fixed by adding `allowedActions(candidate)` to `promotionFormat.ts` (node
   tests in `__tests__/promotionFormat.test.ts`), mirroring the server gate so
   the UI never renders a button that is guaranteed to fail: a skill without
   a passing dry run now shows only "Approve + record a passing dry run" (the
   one action that can actually clear the gate) plus Dismiss. `promote()` and
   `dismiss()` now always `refresh()` + `refreshOpen()` in `finally` (so a
   partial state change lands even on a failed call), call `toastSuccess` on
   2xx, and on a non-2xx set `actionError` — rendered as an `InlineAlert` in
   the drawer's "Next step" section — in addition to the existing
   `toastError`. The drawer's status badge is now a `StatusPill`
   (`STATUS_PILL_STATE` in `promotionFormat.ts`) so "did my click land" reads
   at a glance. Observed: opening "Retry the Data API through an Aurora cold
   start" (a skill, `dryRunPassed: null`) shows only the dry-run-carrying
   button; clicking it returns 200/promoted, the drawer badge flips to
   "Promoted" with a success toast, and the action buttons disappear. Forcing
   a genuine stale-retry (promote an already-`promoted`/`dismissed`
   candidate) now shows a red `InlineAlert` with the server's exact reason
   text ("already promoted" / "dismissed — reopen it before promoting") and a
   matching `toastError`, with the list and drawer both re-synced afterward.

2. **Budgets density — closed.** `portal/src/pages/budgets/BudgetsPage.tsx`,
   `portal/src/pages/budgets/InitiativesReport.tsx`. The page was already
   split into two reports (Initiatives / Sprints) behind a `SubNavLayout`
   with a single `StatStrip` above the report, from earlier work this
   session — but the "Spend by model" / "Spend by trigger" `CatalogGrid`
   still rendered above the allocation table inside `InitiativesReport`,
   ahead of the very ledger the report exists to show. Moved the
   `CatalogGrid` block to render after the `<Table>` (still inside
   `InitiativesReport`, unchanged props/markup otherwise). Above the table
   there is now exactly one description line (from `PageSection`) and one
   `StatStrip` — no filter row is needed on this report, so none is added.
   Expected `first-row-top`: description line (~1 line) + `StatStrip` (~72px)
   + the `SubNavLayout`/`PageSection` chrome, comfortably under 640px at
   1440–1552px (previously 477px with the breakdown cards still counted
   toward the block count, per the original defect text — the pixel number
   was already fine, only the block count was over budget).

9. **Bots filtered-count summary — closed.** `portal/src/pages/bots/BotsPage.tsx`,
   `portal/src/pages/bots/botsFormat.ts`. Added a pure `botsSummaryLine(total,
   shown)` (node tests in `__tests__/botsFormat.test.ts`): returns `"N bots"`
   (singular `"1 bot"`) when the filtered list equals the full list, and `"S
   of N bots match"` once a search or status filter narrows it. Wired into
   the `MetaLine` above the table as `botsSummaryLine(bots.length,
   filtered.length)`, replacing the old `${bots.length} bots` literal that
   ignored `filtered`. Observed: typing "zzznoexistbot" now reads "0 of 5
   bots match" over the empty table instead of "5 bots".

## Fixed (pending re-audit) — invocations/prompts agent, 2026-09-05 19:30

7. **Invocations always reading "No invocations yet" — closed.**
   `middleware/src/lib/invocations.ts`, `middleware/src/mock/invocations.ts`
   (new), `portal/src/pages/observability/InvocationsPage.tsx`,
   `portal/src/pages/observability/invocationsFilters.ts` (new). Root cause:
   `getRecentInvocations` reads a pure in-memory ring buffer that only fills
   from real chat traffic — in `dev:mock` nothing invokes the fleet unless a
   person manually asks something, so the buffer (and the page) stayed empty
   forever even though Health's summary (`mock/agent-statuses.ts`) reports a
   full day of traffic with 25 errors. Added `mock/invocations.ts`: a
   32-row fixture across the same 6 agents `agent-statuses.ts` uses, mixed
   OK/blocked/error (only agents with `errorsLast24h > 0` there get an error
   row, so the two surfaces read as one fleet), timestamps computed relative
   to "now" on every call so "last 24h" never goes stale. `getRecentInvocations`
   now merges this fixture in behind any real ring-buffer entries when
   `MOCK_AGENTCORE` is on (`lib/invocations.ts:130-146`), de-duped by id — real
   mock-agent chat traffic still takes priority and appears on top. Also
   fixed on the page: the "All agents" `Select` now lists names from
   `GET /api/agents` (the fleet registry) instead of deriving from the — often
   empty — tail; the page seeds `agentFilter`/`statusFilter` from the URL on
   arrival via new pure helpers `parseAgentFilter`/`parseStatusFilter`
   (`invocationsFilters.ts`, unit-tested), honouring `?agentId=`/`?agent=` and
   `?status=` so a link that already knows what it wants to show lands
   pre-filtered; the zero-match case now renders a real `EmptyState` ("No
   invocations match" + a "Clear filters" action) instead of the same
   placeholder text used for the true-empty case. Note: Health's own "Read the
   failures on …" link (`SummaryPage.tsx`, out of this agent's owned files)
   still passes no query string — the page now honours `?status=`/`?agent=`
   whenever a link supplies them, but that specific link doesn't yet; flagged
   for whoever owns `SummaryPage.tsx`. Verified live against the running
   `dev:mock` server: `GET /api/observability/recent-invocations?limit=50`
   returns 32 rows across all 6 agents; `GET /api/observability/summary`
   still reports `totalErrors24h: 25`, consistent with the fixture. New tests:
   `middleware/src/lib/__tests__/invocations-mock.test.ts`,
   `portal/src/pages/observability/__tests__/invocationsFilters.test.ts`.

8. **Prompt Studio leaking a raw backend error — closed.**
   `middleware/src/routes/canary-library.ts`,
   `middleware/src/mock/canary-library.ts` (new),
   `portal/src/pages/capabilities/PromptsPage.tsx`,
   `portal/src/pages/capabilities/prompts/PromptSidebar.tsx`,
   `portal/src/pages/capabilities/prompts/libraryError.ts` (new). Two
   independent bugs, both fixed: (1) the three GET routes Prompt Studio reads
   (`/library`, `/library/:id/versions`, `/library/:id/version/:version`)
   called Bedrock unconditionally, so `dev:mock` 503'd on every load with
   `{"error":"Bedrock unavailable","detail":"…"}` — there was no mock
   provider for prompt management at all. Added `mock/canary-library.ts`: one
   system prompt per deployed agent (`orgiq-<agent>-system-prompt`, matching
   the live naming convention), each with a real DRAFT template, wired behind
   the same `config.mock.aurora` flag `dev:mock` already sets (mirroring the
   precedent in `providers/prompt-library.ts`'s `MOCK_ASSETS`) — so Prompt
   Studio now has a full library to browse, select, and view offline instead
   of an unreachable Bedrock. (2) Even once real backend errors are properly
   surfaced (e.g. an authorized role, live stack, revoked credentials),
   `PromptsPage.tsx` rendered its "No prompts yet" `EmptyState` AND the raw
   JSON error text in the same view — contradictory, and the second was
   unformatted backend JSON leaking into the UI. Added
   `prompts/libraryError.ts` (`friendlyLibraryError`, unit-tested): extracts
   `detail` (falling back to `error`) from the known JSON shape, passes
   through anything else unchanged. `PromptsPage.tsx` now renders exactly one
   of an `ErrorState` ("Prompt library unreachable" + the friendly detail +
   Retry) or the empty state — never both — and `PromptSidebar.tsx`'s inline
   rail alert uses the same helper instead of the raw fetch error. Verified
   live against the running `dev:mock` server:
   `GET /api/observability/canary/library` returns 6 prompts (one per agent)
   with `version: "DRAFT"`; `.../version/DRAFT` returns real template text and
   `modelId: "amazon.nova-pro-v1:0"`. New tests:
   `middleware/src/routes/__tests__/canary-library-mock.test.ts`,
   `portal/src/pages/capabilities/prompts/__tests__/libraryError.test.ts`.

## Fixed (pending re-audit) — scores/architecture agent, 2026-09-05 19:00

3. **Scores density.** `ScoresPage.tsx` had six stacked blocks above the
   table (stat grid, a "WHAT THE SCORE IS DOING" card, and three separate
   filter rows). Now: `StatCards.tsx` renders a single library `StatStrip`
   (was a hand-rolled 4-tile grid plus its own freshness caption line — two
   blocks became one); a new one-line `T` description sits above the table;
   the skill/weighting/department filters collapsed into one `Inline` row
   (`FilterBar.tsx`) — the skill-chip row was dropped in favor of typeahead
   suggestions (`SkillFilter.tsx`), the department chip row became a single
   `Select` (`DepartmentFilter.tsx`), and the weighting slider moved off the
   page entirely into an `InlinePopover` behind a "Weighting: N% / N%"
   `Button` (`WeightSlider.tsx` is now the popover body). The analysis panel
   (`ScoreAnalysisPanel.tsx`) moved below the table into a closed-by-default
   `CollapsibleSection` titled "How scoring works". Expected first-row-top
   at 1440–1552px: header (~120px) + StatStrip (~90px) + description line
   (~20px) + the one filter row (~40px) + the leaderboard Card's own
   header/padding (~50px) ≈ 320–360px, well inside the 640px budget.
   Re-weighting math extracted to `scoresFormat.ts` (`computeReweighted`,
   `filterSkillSuggestions`), unit-tested in
   `components/scores/__tests__/scoresFormat.test.ts`.

4. **Scores keyboard.** `Leaderboard.tsx` rows had only the compare
   `<input type="checkbox">` in the tab order — Tab skipped straight past
   the row-open action. The checkbox is now the library `Checkbox`
   composite (`onClick` stopPropagation, `onChange` toggles compare), and
   the name cell renders a real `Button` (styled to read as plain text,
   underline on hover/focus) that calls the same `onSelect` toggle with
   `e.stopPropagation()` so the row's own `onClick` still opens it for a
   mouse click elsewhere in the row. `ScoresPage.tsx` adds Escape-to-close
   (a `window` keydown listener, scoped to while a panel is open) and
   focus-return: `selectPerson` captures `document.activeElement` before
   opening, and an effect refocuses it once `selectedId` goes back to
   `null` — covers both the Leaderboard's row Button and the detail panel's
   own Close button.

5. **Skill search empty state.** `SkillFilter.tsx`'s suggestion popover used
   to just not open when a query substring-matched nothing, so a query like
   "zzznoexistskill" left the 12-row leaderboard sitting there unfiltered
   with zero feedback that the search ran. The popover (now a real
   `InlinePopover`, anchored to the search `Input`) stays open on any
   non-empty query and renders a library `EmptyState` — title `No skills
   match "<q>"` plus a "Clear search" action — in the exact slot the
   suggestion list occupies when there is one. `filterSkillSuggestions`
   (the extracted, tested logic) is what decides empty vs. populated.

6. **Architecture keyboard.** Root cause matched the doc's hint exactly:
   xyflow's `hasDimensions` check (`@xyflow/system`) treats a node as
   unmeasured — permanently `visibility: hidden`, unfocusable — unless
   `measured`, `width`/`height`, or `initialWidth`/`initialHeight` is set,
   and this fixed-position graph set none of them, so nothing ever flipped
   visible. `AgentFlowPage.tsx`'s `rfNodes` now seeds `initialWidth: 215,
   initialHeight: 118` (exported as `NODE_WIDTH`/`NODE_HEIGHT` from
   `AgentFlowFrame.tsx`, matching the node card's actual `w-[215px]`
   footprint) — xyflow uses that placeholder size immediately and switches
   to the real measured size once its own ResizeObserver fires, same
   "seed the fallback dimensions" shape as
   `distillation/CompactionFlowFrame.tsx`. Separately, xyflow's own
   Enter/Space handling on the node wrapper only toggles internal
   selection, never calls back into `onSelect` — `AgentNodeComp`'s `Card`
   now carries its own `role="button" tabIndex={0} onKeyDown` (Enter/Space
   → `onSelect(id)`, matching a mouse click) plus an `aria-label`, and
   `<ReactFlow nodesFocusable>` is now explicit rather than relying on the
   library default. Verified via `getNodeDimensions`/`nodeHasDimensions` in
   `@xyflow/system`'s source (`node.measured?.width ?? node.width ??
   node.initialWidth`) and by reading `distillation/CompactionFlowFrame.tsx`
   per the repro note.


## Fixed (pending re-audit) — coordinator, 2026-09-06 08:35

- #10: `resolveBreadcrumbs` had no `library`, `promotions`, `release` or
  `sprints` case, so those routes rendered no trail. The resolver now lives
  in `components/shell/breadcrumbResolve.ts` (pure, no React) with the four
  cases added, and `__tests__/breadcrumbResolve.test.ts` asserts that EVERY
  rail path — org, admin, assessment, settings, plus the detail routes the
  rails open — resolves to at least a section and a page, so a route can
  no longer ship trail-less.


## Fixed (pending re-audit) — coordinator, 2026-09-07 13:35

- #30 (both halves): `tenantIdProblem()` (pure, in `identity/identityFormat.ts`,
  tested against the server's own `^[a-z][a-z0-9-]{1,30}$` — every id it
  accepts, that regex accepts) now says what is wrong while the id is being
  typed, in the terms the field's label promises ("No spaces — use hyphens,
  like field-ops"), sets `aria-invalid`, and gates Create. The exact string
  the audit typed, `   audit probe TENANT`, is refused with a reason before
  any request. And the server's own refusal now renders as an `InlineAlert`
  INSIDE the drawer rather than a page-level alert sitting behind it — the
  same shape as the already-closed #1.


## Fixed (pending re-audit) — coordinator, 2026-09-07 14:20

- #31: the initiative's name was glued to the end of the reason sentence
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
copy note 2026-09-16: the error quoted above as "Prompt library unreachable" now reads "Prompt studio unreachable" — it was borrowing the Library page's name for a different page.
