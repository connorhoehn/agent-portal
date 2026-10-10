# Defects found — assessor journey audit (u-asha)

## Closed — 2026-10-07 08:08 — the dimension composer is below the fold on arrival (ui-components 2.427.0 MasterDetail paneFooter)

Re-measured as u-asha (assessor) on /assessment/teams/TEAM-001 at 1680x940 after MasterDetail took the remaining height: on arrival, host column at scroll 0 and window scrollY 0, the composer input is at y=754-794 and its block at y=705-868, above the shell footer bar (top y=893) and inside the 940px viewport. Scrolling the dimension list (0 to 495) leaves the input at y=754; selecting another row leaves it at y=754. Zero console errors. The earlier record (input y=961-1001, block y=911-1075) is superseded. Detail: team-scorecard.md.

Previous entry, kept as history:

### Was open — 2026-10-07 07:58 — the dimension composer is below the fold on arrival (ui-components 2.427.0 MasterDetail paneFooter)

Found as u-asha (assessor) on /assessment/teams/TEAM-001 at 1680x940: the composer's input is at y=961-1001 and its block at y=911-1075, past the 940px viewport and under the shell footer (starts y=893). The master-detail is 576px tall starting at y=500 inside a host column that ends at y=869 (scrollHeight 939, clientHeight 732); the host scrolls, and at scrollTop 207 the input reads y=754-794. The list itself behaves: the rail scrolls inside the pane (0 to 289) and the composer does not move while it does. The previous record had the composer top at y=707 on arrival. Likely cause: the pane is sized to a fixed height that does not account for the header, stat strip and tab rows above it. Not fixed here (audit rule). Detail: team-scorecard.md.

Status reflects the state after the Part 2 re-audit (2026-09-05, this session).
All 8 items open at the end of the original pass are now Closed, verified by
re-testing every one of the seven re-audited surfaces (team-scorecard,
submissions-wizard, configuration, workspace, enterprise, rules, prompts).

## Closed (re-verified fixed in this re-audit)

1. **Submissions wizard step 3 ("Fetch links") field-name mismatch.**
   Re-tested end to end with the fixture CSV: committed a revision for
   TEAM-005 (form7, r2) and "Mark fetched" on its evidence link succeeded
   immediately (status flipped to "fetched", gate banner cleared). Detail:
   submissions-wizard.md.

2. **Submissions wizard step-3 gate bypass via the bottom "Next" button.**
   Not reproducible — "Continue" and "Next" both stayed disabled together
   while the gate was open and enabled together once the link was marked;
   there was nothing left to bypass. Detail: submissions-wizard.md.

3. **Grammar: "1 link still need to be marked..."** Now reads "1 link still
   needs to be marked fetched or skipped before processing." Detail:
   submissions-wizard.md.

4. **Explorer shell rail sits 48px inset from the content column, not flush.**
   Re-measured on all four pages at 1472px window width: rail `left` 224px =
   content column `left` 224px, a 0px offset (was 48px). Detail: workspace.md,
   enterprise.md, prompts.md, rules.md.

5. **File/document tree items are not keyboard-reachable.**
   All three tree-bearing pages (workspace, rules, prompts) now implement a
   real roving-tabindex model — exactly one `[role="treeitem"]` carries
   `tabindex="0"` at a time, the rest `-1`. Verified live on prompts with a
   full click → Down → Down → Enter cycle that correctly moved focus and
   navigated to a new document (URL, breadcrumb, and doc card all updated).
   Detail: workspace.md, rules.md, prompts.md.

6. **`/assessment/configuration` "missing key" console warning.**
   Not reproducible on a genuine full-navigate reload. Detail:
   configuration.md.

7. **`/assessment/teams/:id` (team-scorecard) "missing key" console warning
   attributed to StoriesPanel.** Not reproducible on a fresh navigation to
   the Stories tab. Detail: team-scorecard.md.

8. **Command palette polls an orgiq-only observability endpoint from every
   tenant, and re-fires on every navigation instead of once per session.**
   Not directly re-tested via network capture in this pass (that check ran
   under the program-lead audit in the same session and found zero
   `/api/observability/harness/*` requests firing on navigation — see
   program-lead/runs.md); no console errors or related symptoms observed on
   any of the seven assessor surfaces re-audited here either.

## New observation (not a defect)

- **Workspace's document-pane ratio, previously open at 0.437, is now 0.727**
  at this 1472px window width — fixed via a responsive breakpoint (the
  Activity aside now stacks below the document pane instead of squeezing
  beside it below the `2xl` (1536px) breakpoint), not a raw width increase.
  Not verified above 1536px in this pass. Detail: workspace.md.

## Closed (fixed mid-audit during the original pass, verified by re-test then)

1. **Dashboard "All teams" / cohort tables were not keyboard-reachable.** Rows
   were `<tr onClick>` with no `tabindex`/`role`. Now a real `<button>` wraps the
   team-name cell in both tables; Tab + Enter opens the scorecard. Re-verified
   dashboard.md.

2. **Dashboard status pills showed raw enum text** (`IN_PROGRESS`, `ASSESSED`,
   `NEW`). Now humanized ("In progress", "Assessed", "New"). Re-verified
   dashboard.md.

3. **`FormField` in `@connorhoehnslalom/ui-components` leaked its internal
   `labelId` wiring prop onto the rendered DOM node** ("React does not recognize
   the `labelId` prop..."), firing on every team-scorecard and Configuration
   load via `EvidenceIntake.tsx` and `ConfigurationPage.tsx`. Confirmed gone with
   a hard reload on both pages. Re-verified team-scorecard.md, configuration.md.

4. **Reports "Teams" table rows were not keyboard-reachable** (same `<tr onClick>`
   pattern as dashboard). Now a real `<button>` wraps the team-name cell; Tab +
   Enter navigates in-app to the scorecard with no full reload. Re-verified
   reports.md.

5. **`/assessment/teams/TEAM-999` showed a generic "API may be unavailable" error
   for a genuine 404** instead of a not-found state. Now renders "No team
   TEAM-999 / There is no team with this id..." with a working "Back to the
   dashboard" button. Re-verified team-scorecard.md.

6. **Submissions search box never matched anything** — `DataTable`'s default
   filter read `row[column.key]` but the row objects had no such top-level
   fields (`team`, `submission`, `submitter`, etc. were only present via `render`
   functions). Every column now supplies a working match (confirmed: "Notifications"
   matches by team name, "Sam Okafor" matches by submitter). Re-verified
   submissions.md.

7. **The entire submissions-wizard file-upload contract was broken** — the
   client POSTed the raw file as `multipart/form-data` while the server only
   understood JSON `{rows}`, so every real upload 500'd with a bare "Internal
   server error," for every role, unconditionally. Rebuilt end-to-end: the
   client now parses the CSV itself and POSTs structured JSON, which the server
   stages with a `staging_token` and returns per-row `new`/`seen`/`unknown_team`
   classification; commit takes `{staging_token, selections}`. Verified with a
   real fixture file through steps 1-2 and confirmed de-duplication (re-uploading
   the same file reclassified already-committed rows from "New" to "Seen").
   Re-verified submissions-wizard.md.

## Closed (re-verified fixed in the 2026-09-07 re-audit)

1. **The "N/A exceptions" dialog has no visible close control.**
   Fixed and verified live on 2026-09-07 at a 1560x857 window. The dialog
   opened from TEAM-001's "Exceptions" button now renders a footer "Close"
   `Button`, and for this role that is the *only* control in it: a DOM sweep
   of `button`, `[role=button]` and `a[href]` inside `[role="dialog"]`
   returns exactly one element, "Close" — no Approve, no Deny, correctly, and
   no longer zero. Both dismiss routes work and both hand focus back: with
   the "Exceptions" trigger focused as a real user leaves it, opening the
   dialog moves focus to "Close"; clicking Close removes the dialog and
   `document.activeElement` is the "Exceptions" trigger again (read after two
   painted frames), and a dispatched Escape does the same. Detail:
   team-scorecard.md. Fixed in
   `portal/src/pages/assessment/dashboard/ExceptionsModal.tsx`.

2. **The explorer's document pane drops under the 0.55 floor at viewports
   ≥1536px.** Fixed and verified live on 2026-09-07. Re-measured on
   `/assessment/workspace` at the same 1560px window the defect was filed at:
   content column 1312px, tree rail 300px, Activity aside now **256px**
   (was 320px), document pane **756px** — 756 ÷ 1312 = **0.576**, clear of
   the 0.55 floor where it previously measured 692px = 0.53. Re-measured on
   the other side of the `2xl` breakpoint at a 1440px window, where the aside
   stacks below the pane: content 1192px, pane 892px = **0.748**. Both sides
   of 1536px clear the floor. The rail is still flush — rail `left` 224px =
   content-column `left` 224px, a 0px offset — on all four explorer pages,
   which measure 0.576 (workspace, with the aside) and 0.771 (enterprise,
   rules, prompts, no aside). Detail: workspace.md, enterprise.md, rules.md,
   prompts.md. Fixed in
   `portal/src/pages/assessment/knowledge/ExplorerFrame.tsx`.

## Closed (re-verified fixed in the 2026-09-07 02:52 re-audit)

Re-observed as fixed by re-running the original repro steps as u-asha, not by
reading the fix. Numbering follows the Open entries they replace.

1. **A submission whose run completed still read "Unprocessed" when its
   hinted dimension landed unverified.** Fixed. Observed 2026-09-07 02:52:
   the list reads SUBMISSIONS 6 / TEAMS 5 / **UNPROCESSED 0** with a green
   "Processed" pill on every row (assessor/submissions.jpg). TEAM-005's
   **Form #7** — the row this defect was filed against, carrying an evidence
   link (LINKS **1/1**) whose single hinted dimension comes back
   `current_level: null`, `certification.basis: "documented"`,
   `certification.status: "pending"` — now reads **Processed**. The
   inversion is gone with it: rows processed with no evidence link behave
   exactly as before, so attaching evidence no longer makes a submission
   *less* likely to be marked processed. Across the four role passes all
   three link dispositions were exercised — fetched (lead-assessor), skipped
   (program-lead) and none at all (here) — and all three reach Processed.
   Fixed in `middleware/src/mock/assessment.ts` (`isSubmissionProcessed`),
   which now asks whether each hinted dimension carries a `history` entry at
   or after the envelope's `ingested_at` rather than whether that pass
   produced a level; a dimension never touched, or reset by
   `resetAssessment`, still correctly fails.

2. **The wizard's step 2 kept calling a row "Unknown team" after you had
   matched it.** Fixed. Observed 2026-09-07 02:48: row 9 ("Ledger
   Reconciliation") still parses in with the amber "Unknown team" chip and a
   "Match a team…" select, which is correct — the submitted name resolves to
   no roster id. Choosing "Internal Tools (TEAM-007)" flips the chip to a
   green **"Matched"**, and ticking the row moved the footer to "2
   submissions selected / Commit 2 submissions"
   (assessor/submissions-wizard.jpg). Rows that matched on name keep their
   untouched "Seen" chips, so the fix did not smear over the states that were
   already right.
   Fixed in `portal/src/pages/assessment/secondaryFormat.ts`
   (`resolveRowStatusDisplay`, which keys the chip off "has a team id from
   either source" — the same fact `isReady` uses) and
   `portal/src/pages/assessment/submissions/PreviewStep.tsx`.

## Closed (re-verified fixed in the 2026-09-07 02:28 re-audit)

3. **The Enterprise page hides every document it has — and two of them
   describe this role's job.** Fixed. Re-observed 2026-09-07 02:28 as u-asha:
   `/assessment/enterprise` renders a rail headed "ENTERPRISE CONTEXT · 10"
   holding all four folders and all six documents — CI/CD Standards, Security
   Baseline, Intake Checklist, Scoring Workflow, RACI, Approved Tools. Every
   one opens and renders (Scoring Workflow shows its full
   `classify-transcript -> score-dimensions -> validate-outputs ->
   apply-scores` text), `?doc=` deep links resolve, a directory id renders a
   folder pane rather than an error, and an unknown id falls back to "Select a
   document from the library to view it." with the rail intact at 10 nodes.
   20 interactive controls, all reachable, 0 console errors, ten
   `[role="treeitem"]` nodes with exactly one at `tabindex="0"`. The section
   key in `SECTION_KEY_FOR_MODE` now reads `enterprise_context`, matching what
   the server sends, and the unit fixture was rekeyed to the real tree shape
   so the test can no longer agree with the code against the API. The two
   documents this entry was filed over — Intake Checklist and Scoring Workflow
   — are both reachable in two clicks from a cold load. Detail: enterprise.md.

4. **A save tells the saving tab that someone changed the document.** Fixed.
   Re-observed 2026-09-07 02:44 on `/assessment/rules?doc=rule:scoring-guardrails.md`
   as u-jonas (the role that can save; this role cannot, so the fix is verified
   where it is reachable and inherited here). Saving the unmodified 326-character
   buffer produced **zero** "Updated by … just now" notices across 30 samples
   over 9 seconds, and a full reload of the saving tab produced none either —
   the confirmed-timestamp set persists in `sessionStorage`
   (`assessment.knowledge.ownSaveTimestamps`) and survived the reload with 6
   entries. The suppression did not go too far: with a second tab open on the
   same document, a genuine save from that tab still raised "Updated by u-jonas
   just now" in the first tab within seconds. Membership on a confirmed-save
   timestamp set plus an in-flight flag replaced the before/after comparison
   that lost the race. Detail: stretch/accessibility.md and lead-assessor/DEFECTS.md.

## Closed (re-verified fixed in the 2026-09-07 04:20 re-audit)

5. **A freshly opened tab is told an hours-old edit happened "just now".**
   **Fixed — verified 2026-09-07 04:20.** Measured rather than eyeballed, and
   measured in the state that used to reproduce it. The middleware was
   restarted first so the SSE ring buffer started empty and every event in it
   was one this pass created. A real save was made through the editor at
   `2026-09-07T07:48:46Z` and a second at `07:49:36Z`. A brand-new tab was then
   opened on `/assessment/rules?doc=rule:scoring-guardrails.md` **8.6 minutes
   later**, deliberately under a *different* user (u-asha) so the result could
   not be an accident of shared suppression state.
   `sessionStorage['assessment.knowledge.ownSaveTimestamps']` was `null` and the
   page body matched neither `/Updated by/` nor `/changed by someone else/i` —
   **no notice of any kind**. The same check was run on all four explorer
   surfaces for all four roles in this pass; every one came up clean.

   Confirmed at the wire, not just in the DOM. An SSE request to
   `/api/assessment/events` presenting **no** `Last-Event-ID` returned frames
   `<epoch>-15/16/17`, all three `knowledge.presence` published live during the
   read window, and replayed **nothing** from the buffer — where the old
   handler replayed the whole 500-slot ring and could hand a first-time visitor
   a `knowledge.doc.saved` from 101 minutes earlier. A genuine reconnect is
   still served: the same request presenting `Last-Event-ID: <epoch>-0`
   replayed seq **1 through 17**, both buffered `knowledge.doc.saved` events
   included, with **no** `stream.gap` frame — correctly, both being inside the
   30-minute `REPLAY_MAX_AGE_MS`. The age-eviction and gap paths that a live
   session cannot reach inside a 30-minute window are pinned by **11 passing
   `decideReplay` unit tests**. Note for future probes: frame ids are
   `<epoch>-<seq>`, so a bare `Last-Event-ID: 0` is rejected by
   `afterSeqFromLastEventId` and lands on the fresh-connection path — correct,
   but easy to misread as "reconnects get nothing".

   The `sessionStorage` half of this entry is fixed too.
   `'assessment.knowledge.ownSaveTimestamps'` is now cleared by
   `portal/src/lib/tenantCaches.ts` on tenant switch, role switch, login and
   logout. Verified live: a tab holding one confirmed own-save as u-jonas was
   signed in as u-asha in place and came back with that key `null`, while
   `'assessment.knowledge.tabId'` survived unchanged — the right split, since
   the tab id identifies the tab (and must persist for presence) and the
   own-save set identifies the person (and must not). Before the fix, six
   timestamps written as u-jonas survived a switch to u-operator.

   Live cross-tab notification still works and was re-proved in the same run: a
   save from a second tab reached an already-open peer tab in under 2.5 s, with
   the document refetched, no reload, no clobber, and a Dismiss control
   offered. What did *not* come back is the arrival-time fabrication.

   One narrower problem survives and is filed separately as Open #6 below: a
   notice already on screen never re-renders its age.

## Closed (re-verified fixed in the 2026-09-07 05:05 re-audit)

6. **A save notice already on screen never re-rendered its age, so it read
   "just now" indefinitely.** — CLOSED 2026-09-07 05:05.
   Filed 2026-09-07 04:19: a notice was correct the moment it appeared and then
   froze, still reading "Updated by u-jonas just now" at 2 min 20 s, 2 min 48 s
   and 7 min 54 s after the save it described. Root cause was the notice state
   holding the *rendered sentence*, formatted once inside an effect that
   short-circuits on an unchanged `ts`, so `relativeTime` was evaluated exactly
   once per event.

   **Re-observed 2026-09-07 04:41–05:02, gone.** `DocPane.tsx` now holds
   `{ by, requiresReload, ts }` in notice state and derives the wording at
   render (`docSavedNoticeText(notice.by, notice.ts)` in the JSX), so any
   re-render re-reads the real age; the 15-second presence heartbeat supplies
   the re-renders. Two tabs as u-jonas on
   `/assessment/rules?doc=rule:scoring-guardrails.md`, tab B saving at
   `2026-09-07T08:08:43.616Z` and tab A left untouched and read repeatedly:

   | elapsed since the save | banner text |
   |---|---|
   | 7 s | "Updated by u-jonas **just now**" |
   | 1 min 37 s | "Updated by u-jonas **just now**" (correct — `relativeTime` cuts over at two minutes) |
   | 2 min 27 s | "Updated by u-jonas **2m ago**" |
   | 3 min 09 s | "Updated by u-jonas **3m ago**" |
   | 5 min 40 s | "Updated by u-jonas **5m ago**" |
   | 9 min 03 s | "Updated by u-jonas **8m ago**" (backgrounded tab, one throttle interval behind) |
   | 9 min 03 s, foregrounded | "Updated by u-jonas **9m ago**" |
   | ~20 min | "Updated by u-jonas **20m ago**" |

   Three readings with the gaps between them, to compare directly against the
   filing: **7 s → "just now"**, then **+2 min 20 s → "2m ago"** (at 2 min
   27 s), then **+6 min 36 s → "9m ago"** (at 9 min 03 s, foregrounded). The
   old defect produced "just now" at every one of those points.

   One caveat recorded rather than filed: the refresh rides whatever re-renders
   the component, and Chrome throttles timers in a **backgrounded** tab to
   roughly once a minute, so a tab nobody is looking at can trail the true age
   by up to a minute — visible above at 9 min 03 s. Foregrounding corrected it
   immediately. Not a defect: a person reading a banner is looking at the tab.
   It is written down because it will otherwise read as a regression to the
   next person measuring this from a headless harness that never foregrounds.

   The two neighbouring fixes were re-confirmed in the same run: a tab opened
   three minutes *after* the save showed no banner and no
   `assessment.knowledge.ownSaveTimestamps` entry, and a tab holding one
   confirmed own-save as u-jonas, signed in as u-asha in place, came back with
   that key gone while `assessment.knowledge.tabId` survived unchanged — so a
   user switch inherits no suppression in either direction. Tab A kept its
   banner across that switch and went on ageing it correctly, which is right:
   the banner describes an event, not a session.
   Evidence: `docs/assessment-journeys/stretch/realtime-notice-ages.jpg` (the
   banner at 7 min 24 s reading "6m ago", where
   `realtime-stale-just-now.jpg` shows the same moment reading "just now"
   before the fix).

## Fixed (pending re-audit) — submissions agent, 2026-09-07 01:01 EDT

Both defects from the 2026-09-07 re-audit are fixed. Their entries were left
in place at the time (not moved/renumbered) since this note was the
disposition, not a re-audit; #6 has since been re-audited and moved to Closed
above, on 2026-09-07 05:05.

1. **"Unprocessed" despite a completed run landing "documented / pending".**
   Root cause: `isSubmissionProcessed` (`middleware/src/mock/assessment.ts`)
   required `current_level !== null || is_na` for every hinted dimension,
   on top of a recency check against `updated_at`. That conflated "never
   looked at" with "looked at, concluded not enough evidence yet" — the
   latter is exactly what `certification.basis: "documented"` /
   `certification.status: "pending"` means (moderate confidence, no level,
   not N/A — see `dimensionStatus`/`basisFromConfidence` in
   `middleware/src/providers/assessment.ts:159-168`). A dimension scored to
   that outcome has a real `history` entry from the scoring pass
   (`applyScores` in `providers/assessment.ts` always appends one,
   regardless of the resulting level), so it's done being worked, not
   queued — but the old predicate could never see that and the row stayed
   "Unprocessed" forever. Attaching more evidence didn't help either: raw
   evidence has no bearing on the predicate at all.
   Fix: the predicate now asks whether each hinted dimension has a
   `history` entry timestamped at or after the envelope's `ingested_at`,
   dropping the `current_level`/`is_na` condition entirely. A dimension
   that was genuinely never touched still has no such entry (empty
   `history`, or all entries pre-dating ingestion) and correctly stays
   unprocessed; a reset (`resetAssessment`, which clears `history` rather
   than appending to it) also correctly fails the check. Verified live
   against `:3011`: committed TEAM-002's `sub-...-r3` revision (status
   `committed`), applied scores on all 6 hinted dimensions with
   `suggested_level: null, confidence: "moderate"` (the "documented /
   pending" outcome — `GET /api/assessment/teams/TEAM-002` then shows
   `current_level: null, is_na: false, confidence: "moderate",
   certification.basis: "documented", certification.status: "pending"` on
   dimension 1), and both `GET /api/assessment/submissions/TEAM-002/sub-...-r3`
   and the `groups` entry in `GET /api/assessment/submissions` now read
   `status: "processed"`.
   File: `middleware/src/mock/assessment.ts` (`isSubmissionProcessed`).
   Tests: `middleware/src/providers/__tests__/assessment-status-transitions.test.ts`
   adds "a dimension scored to 'documented / pending' ... still counts as
   processed" and "attaching more evidence without a scoring pass does not,
   by itself, mark a dimension processed", alongside the existing
   partially-scored and resubmission-recency cases (all kept passing).

2. **Step 2's amber "Unknown team" chip outlives a match.** Root cause:
   `PreviewStep.tsx` rendered the status chip straight off the parse-time
   `row.status` (`STATUS_LABEL`/`STATUS_TONE`, keyed only by the CSV's
   original classification), which never gets recomputed once the operator
   picks a team in the row's `Select` — even though `isReady`/`blockedCount`
   (the ready-to-commit count) already treat that same match as sufficient.
   Fix: extracted a pure helper, `resolveRowStatusDisplay(status, hasTeamId)`
   in `portal/src/pages/assessment/secondaryFormat.ts`, that folds
   `unknown_team` over to a "Matched" (success-tone) chip once a team id is
   present from either source (`row.team_id` or the wizard's `assignments`
   map — the same value `isReady` computes), leaving `new`/`seen` untouched.
   `PreviewStep.tsx`'s status column now calls it with `isReady(row)`.
   Tests: `portal/src/pages/assessment/__tests__/secondaryFormat.test.ts`
   adds three cases for `resolveRowStatusDisplay` (unmatched stays amber,
   matched reads "Matched", new/seen unaffected by the match flag).

## Fixed and re-audited — knowledge agent, 2026-09-07

Re-audited 2026-09-07 02:12–02:53; both are confirmed fixed in the browser and
have been moved to the dated Closed section above. What follows is the root
cause and the change, kept for the record.

3. **The Enterprise page hides every document it has.** Root cause confirmed
   live: `curl -b <assessment-session-cookie> 127.0.0.1:3011/api/assessment/knowledge/tree`
   returns four sections keyed `enterprise_context` (10 nodes), `rules` (3),
   `prompts` (9) and the synced `confluence-eng` (5) — `SECTION_KEY_FOR_MODE`
   in `portal/src/pages/assessment/knowledge/knowledgeFormat.ts` mapped mode
   `enterprise` to the key `enterprise`, which nothing on the server has ever
   sent; `rules` and `prompts` were already correct (checked the same way, as
   the defect asked). Fixed by mapping `enterprise` to `enterprise_context`.
   The fixture in `portal/src/pages/assessment/__tests__/knowledgeFormat.test.ts`
   invented a section keyed plain `enterprise`, which is what let the wrong
   mapping pass — rekeyed the fixture to `enterprise_context` (matching the
   live tree) and rewrote the `sectionsForMode` test to assert against all
   three real keys (`enterprise_context`/`rules`/`prompts`), including a new
   `prompts` fixture section the old test had no coverage for at all.
   File: `portal/src/pages/assessment/knowledge/knowledgeFormat.ts`
   (`SECTION_KEY_FOR_MODE`), `portal/src/pages/assessment/__tests__/knowledgeFormat.test.ts`.

4. **A save tells the saving tab that someone changed the document.** Root
   cause: the old suppression compared a single `mySavedTs` timestamp,
   updated only after the PUT/restore response resolved, against each SSE
   event's `ts` — but `putKnowledgeDoc`/`restoreKnowledgeDocVersion`
   (`middleware/src/providers/assessment.ts`) publish to the broker BEFORE
   the handler returns, so this tab's own SSE echo can arrive before the
   response does. At that instant `mySavedTs` was still stale, the event read
   as external, and a `seenExternalTsRef` guard meant the notice, once shown,
   could never be re-examined and retracted once the response did land.
   Separately, `mySavedTs` was reset to `null` on every doc reselection and
   lived only in memory, so a stale echo of an old save of this tab's own
   reappeared as "someone changed this" both after navigating away and back
   and after a genuine full reload of the tab.
   Fix: `externalDocSave` now takes an `OwnSaveState` (`confirmedTimestamps: ReadonlySet<string>` +
   `saveInFlight: boolean`) instead of a single before/after cutoff — order-
   independent by construction, so recomputing it after either piece of state
   changes naturally reconciles a notice already shown. `saveInFlightRef` is
   set true before the request goes out and cleared once it resolves
   (covering the race), `confirmedTimestampsRef` never resets on doc
   reselection, and is persisted to `sessionStorage` (same pattern as the
   existing per-tab `getTabId`) so it survives an actual page reload too.
   Tests in `portal/src/pages/assessment/__tests__/knowledgeFormat.test.ts`
   cover all four scenarios: frame-before-response (suppressed via
   `saveInFlight`), frame-after-response (suppressed via
   `confirmedTimestamps`), a genuine external save (still reported), and a
   simulated reload (the same persisted state, recomputed fresh, still
   correctly suppresses the old event).
   File: `portal/src/pages/assessment/knowledge/DocPane.tsx`,
   `portal/src/pages/assessment/knowledge/knowledgeFormat.ts`.

Verified: `npx tsc --noEmit` clean, `node --test 'src/**/__tests__/*.test.ts'`
591/591 passing, `npx vite build` clean, and (from the repo root)
`scripts/validate-orgiq-audit.sh --quick` component-discipline section and
`scripts/validate-branding.sh --quick` header-rhythm section both ✓.

## Fixed (pending re-audit) — sse agent, 2026-09-07

5. **A freshly opened tab is told an hours-old edit happened "just now".**
   Two independent root causes, both fixed:

   1. **No age bound on SSE replay.** `GET /events` unconditionally handed a
      brand-new connection (no `Last-Event-ID`) `assessmentBroker.replay(undefined)`
      — the whole ring buffer, sized by event COUNT (`BUFFER_CAPACITY = 500`),
      never by age. Decision: a connection with no `Last-Event-ID` is a
      genuinely fresh view with nothing to catch up on, so it now gets **no**
      history at all — only events published from that moment forward. A
      RECONNECT (one presenting a `Last-Event-ID`) still gets its gap filled,
      but bounded by a new `REPLAY_MAX_AGE_MS` (30 minutes): anything older,
      whether still ring-buffer-resident or not, is dropped from the reply and
      the client is told via a `stream.gap` frame — the same signal already
      used for capacity eviction, now also raised for the age bound. This
      keeps a genuine "reconnected after a coffee break" replay working while
      killing the "brand-new tab told about a save from 101 minutes ago"
      failure mode outright, without needing presence (which depends on
      "current roster republished on any join/purge, within one 15s
      heartbeat") to grow its own snapshot endpoint. The policy is a new pure
      function, `decideReplay` (`middleware/src/lib/assessment-broker.ts`),
      wrapped by `assessmentBroker.catchUp`/`gapFrame` and called from
      `GET /events` (`middleware/src/routes/assessment.ts`). It supersedes the
      old `replaySince`/`gapFrameFor` pair.
   2. **Hardcoded "just now".** `docSavedNoticeText` (`knowledgeFormat.ts`)
      ignored the save event's own `ts` and always rendered the literal words
      "just now", so even a save the client legitimately learned about late
      (a slow reconnect, a delayed live frame) was mis-announced. It now takes
      the event's `ts` and renders it through the repo's existing
      `relativeTime` helper (`portal/src/lib/relativeTime.ts`) — "8m ago",
      "1h ago", etc. — so the notice is honest about the edit's age regardless
      of which path delivered the frame. Caller updated:
      `portal/src/pages/assessment/knowledge/DocPane.tsx`.

   Also fixed — the related storage wrinkle noted in this item: **sessionStorage
   isn't scoped per user.** `assessment.knowledge.ownSaveTimestamps`
   (`DocPane.tsx`'s `OWN_SAVE_TS_STORAGE_KEY`) was never cleared on a
   user/role switch, so a tab that switched identity inherited the previous
   user's "these saves are mine" set (confirmed live: u-jonas's six
   timestamps survived a switch to u-operator). Fixed by clearing that key
   from `clearTenantScopedCaches()` (`portal/src/lib/tenantCaches.ts`) — an
   ADDITIVE change to that shared module (new `SESSION_KEYS` list alongside
   the existing `LOCAL_KEYS`/`LOCAL_PREFIXES`, restated by literal key rather
   than imported, same pattern the module already uses for the compute-lib
   keys), already wired into `auth.tsx`'s `enterContext`/`login`/`logout`, so
   no additional call sites needed touching.

   Files: `middleware/src/lib/assessment-broker.ts`,
   `middleware/src/routes/assessment.ts`,
   `portal/src/pages/assessment/knowledge/knowledgeFormat.ts`,
   `portal/src/pages/assessment/knowledge/DocPane.tsx`,
   `portal/src/lib/tenantCaches.ts`.

   Tests: `decideReplay` covered directly in
   `middleware/src/lib/__tests__/assessment-broker.test.ts` (no Last-Event-ID
   delivers nothing; a Last-Event-ID inside the buffer and age bound replays
   exactly the gap, not gapped; a Last-Event-ID older than the age bound is
   gapped and only the still-fresh events replay; frames older than the bound
   are dropped even with no ring-buffer eviction; capacity eviction still
   gaps independently of age), plus `assessmentBroker.catchUp`/`gapFrame`
   wiring tests. Route-level SSE tests updated/added in
   `middleware/src/routes/__tests__/assessment.test.ts` and
   `.../assessment-events-gap.test.ts` (fresh connection gets no history but
   still gets live frames with valid `id:` lines; reconnect within the bound
   gets the gap with no `stream.gap`; reconnect past the age bound gets
   `stream.gap` and excludes the aged-out frame). `docSavedNoticeText`
   covered in `portal/src/pages/assessment/__tests__/knowledgeFormat.test.ts`
   for a few-seconds-old, an 8-minutes-old, and a 101-minutes-old save (the
   exact repro). `tenantCaches.test.ts` covers the new sessionStorage key
   being cleared.

   Curl proof (mock middleware, `u-operator`/assessment/admin): saved a doc at
   `07:42:07Z`; a fresh SSE connection opened afterward received **zero**
   frames referencing that save, only a live save made *during* that
   connection's own window (`07:42:33Z`) — confirming a fresh tab no longer
   sees stale history. Separately, a reconnect using a captured
   `Last-Event-ID` correctly replayed a save made *while disconnected*,
   confirming the gap-fill path for genuine reconnects still works.

Verified: `cd middleware && npx tsc --noEmit && npm test` (127 suites / 1759
tests passing). `cd portal && npx tsc --noEmit && node --test
'src/**/__tests__/*.test.ts'` (592 passing) `&& npx vite build` (clean). From
the repo root, `bash scripts/validate-orgiq-audit.sh --quick` component
discipline section all ✓.

re-observed 2026-09-18 (the real prompt documents landed): The nine prompt documents now carry the REAL command files from ~/Projects/agentic-assessment-accelerator/.claude/commands rather than a hand-written summary of each. This was the first line of the complaint that started this thread — "the workspace document contents are way off" — and it was accurate: classify-transcript rendered four lines of paraphrase where the real document is eighty, carrying its `## Input` contract, the file-format rules, seven precisely-defined output fields, an exact JSON schema, the `uv run -m sdlcd.main assess apply-classification` handoff and the strict validation the verb applies. Bodies went from 274-483 bytes to 1,985-13,623.

Putting the real content in immediately exposed two rendering bugs that a four-line stub could never have shown, both in the library and both now queued. (1) `MarkdownView`'s JSON highlighter corrupts its own output: it chains regex passes over accumulated HTML, and the pass that colours strings re-matches the quoted attribute value the pass that colours properties just wrote, so every JSON object rendered nested broken markup as literal text at the reader. Defused by stripping the language off ```json fences — colour lost, markup no longer printed. (2) A code block's Copy button is absolutely positioned over the code with no gutter reserved, so the long `apply-classification` line ran underneath it; the `pre` does scroll, but scrolling to the end still parked the tail under the button. Fixed by padding the inner `code` — padding on the `pre` does nothing, because a scroll container's padding is not added to its scrollWidth (measured: it stayed 924 against a client width of 896).
re-observed 2026-09-18 (comments became durable): a comment was WRITE-ONLY. `POST /knowledge/doc/comment` had an INSERT on the Aurora path and a broker publish on the mock path, and nothing anywhere had a SELECT. The pane rebuilt its thread from this session's SSE echoes plus the realtime gateway's channel — and the gateway is offline here, which the banner says — so a comment vanished on reload and the drawer then read "No comments on this document yet", about a comment the reader had just written. An empty state asserting something false, on the one surface whose job is to carry what people said to each other. Driven, not reasoned about: posted a comment, reloaded, watched it disappear under that sentence.
Now: a registered `assessment-knowledge-comments` fixture (seeded with a real thread, so POST /api/__mock/reset undoes anything an audit adds — the mock floor's contract for a write), `fetchKnowledgeComments` on the Aurora side against the table that already existed, `GET /knowledge/doc/comments`, and DocPane fetching it as the base of the merge with the live sources folded on top. The stored row and its SSE echo now share ONE id, minted once by the provider, so the merge dedupes exactly rather than on a content+time window — an id that differed between them would have shown every comment twice for the life of the session. Re-driven end to end: the thread renders on load, the Comments button carries its count ("Comments (2)" → "(3)" after posting), a posted comment survives a reload, and it appears once.
Not done, and not blocked by tiptap as I had been saying: ChatPanel already exposes onReply, onEditMessage, onDeleteMessage, onToggleReaction and onTogglePin, and none of them are wired. Those want comment-level endpoints (edit, delete, react) and a parent id — server work in this repo, the same shape as the move and rename endpoints, not a library gap. `CommentThread` in the library's /social subpath is gateway-connected (roomId/postId/idToken) rather than props-driven, so it is a different integration from the ChatPanel this pane uses.
re-observed 2026-09-18 (comments gained edit and soft-delete): last pass made the thread durable; this one gives it the affordances `ChatPanel` already renders. `onEditMessage` and `onDeleteMessage` are its own props — it draws the action bar, the inline editor, the "(edited)" marker and the tombstone — so this was never a library gap, only a missing place to write to. PATCH and DELETE /knowledge/doc/comment are that place. Authorship is read from the SESSION, never the body, so naming someone else does not let you rewrite their words; delete is SOFT (`deleted_at` is a timestamp, the row keeps its place) because removing it outright leaves a hole in a thread other people are part-way through reading, and the panel is built to render the stub. Deleting twice is idempotent rather than an error, and an empty edit is refused rather than blanking the comment.
One defect found by driving it rather than reading it: hovering my own comment showed NO edit or delete. The library's ChatMessage doc is explicit — "is this mine" keys on `userId` and never on `clientId`, "otherwise your own messages stop being yours partway up the thread" — and the mapper set only `clientId`. So the panel could not identify a single one of the viewer's own comments and offered the actions on none of them. Both mappers (stored rows and SSE echoes) now carry `userId`, and the format test asserts it rather than treating it as decoration. After that, hovering shows "Edit message" / "Delete message" on exactly the viewer's own rows — including the seeded kc-classify-02, which is authored by u-farah and therefore legitimately theirs. Edit driven end to end through the panel: the text changed, the old text is gone, and "(edited)" renders.
Seeded one comment with an `edited_at` so that marker is reachable without an auditor having to write and rewrite one first. `deleted_at` is deliberately NOT seeded — a tombstone in the seed is a comment nobody ever wrote — and its absence is explained in the shape table rather than left as drift. Still unwired, still not a library gap: reply (the panel calls `onReply` and renders nothing for it, so threading needs host UI and a composer override, which is the queued gap), reactions and pinning.
re-observed 2026-09-18 (the reaction bar stopped offering what it cannot do): reactions here are a GATEWAY-only feature — there is no BFF endpoint, no broker event and no persistence for them anywhere in the middleware, which is worth knowing before reading the rest. The bar was gated on `gateway.connectionState !== 'connected'`, the WEAKER of the two checks this very file already computes: `gatewayReady` (line ~248) is `isGatewayReady(connectionState, clientId)`, and the format suite's own test says readiness needs BOTH 'connected' AND a handshake clientId. In the window between the socket opening and the handshake landing, the control was live: a react() went out with no identity behind it, and `summarizeReactions` keys `mine` on that same clientId, so a viewer's own reaction could never come back marked as theirs.
Measured as Farah Osei on /assessment/prompts with the gateway offline: before, the "+ 😀" control reported `disabled: false` and opened its emoji picker — an affordance that could not reach anything. After, `disabled: true`, beside the page's own "Gateway offline" banner which already explains why. Pinned by a source-level assertion in the format suite (the gate is inline JSX with no seam to call, the same approach assessment-callback-exemption.test.ts takes to its route module): the bar must disable on `!gatewayReady` and must not mention connectionState.
Consequence worth recording for whoever picks this up: COMMENT reactions were the obvious next step after edit and delete, and they are not worth wiring while reactions have no durable path. ChatPanel's `reactionsFor`/`onToggleReaction` would light up controls with the same defect one level down. The real prerequisite is a reaction store — the same shape the comment thread just got — not more wiring.
re-observed 2026-09-18 (reactions became durable, on documents AND comments): last pass found that reactions existed ONLY over the realtime gateway — no endpoint, no broker event, no persistence — and disabled the bar because with the gateway down it could not reach anything. That was the right answer for the world as it was; this pass changes the world. The BFF now owns them: `assessment_knowledge_reactions`, one row per (target_id, emoji, actor), where the primary key IS the toggle — reacting twice is an add then a remove, never a count of two, which is what the `mine` flag depends on. `target_id` is a document id or a comment id, so the same store feeds the document's own bar and every comment's, read in ONE request per page rather than one per comment.
Identity is the session `sub`, not the gateway clientId. That is the load-bearing difference: a clientId identifies a CONNECTION and changes on reconnect, so "mine" computed from it stops being mine — and offline there is no clientId at all, which is why the old bar could never mark a viewer's own reaction. The bar is therefore no longer gateway-gated, and the source-level test that asserted `disabled={!gatewayReady}` has been replaced by one asserting the opposite invariant: nothing in the bar may mention connectionState, gatewayReady or clientId again.
Driven live as the program-lead with the gateway OFFLINE: the document bar renders 👍2 from the two seeded reactors, clicking takes it to 👍3, and a reload still reads 👍3. The seeded 🎯 on kc-classify-01 renders inside the comment thread — ChatPanel's `reactionsFor`/`onToggleReaction` wired to the same store. Note the two library contracts differ and both are fed from the one set of rows: ReactionsBar wants AGGREGATED {emoji,count,mine}, ChatPanel wants the RAW per-reactor rows and aggregates them itself so it can name who reacted.
One self-inflicted defect worth recording: the first wiring put the reaction hooks BELOW `if (docFetch.isLoading) return`, so React counted a different number of hooks between renders and the whole pane died with "Rendered more hooks than during the previous render". The comment fetch had been placed above that early return for the same reason and I did not notice the pattern until the page broke. Both now sit together above it.
re-observed 2026-09-18 (chrome removed; rename by hover or double-click; Write/Preview): three changes, all from direct feedback that the surface was noisy.
(1) The "Live" pill and the "Gateway offline — presence and co-editing via the BFF" chip are gone from the explorer header and the document header. They were permanent furniture: the pill read "Live" whenever the SSE stream was up, which is nearly always, and the chip restated an offline gateway on a surface where that is the NORMAL configuration rather than an incident. What they guarded still speaks where it matters — the editor shows "Editing an offline copy" on the document being edited, and the reaction bar no longer depends on the gateway at all.
(2) The rename pencil no longer sits on every row. It is revealed on the row's :hover or ; :focus-within (app.css, keyed on the ARIA role and our own class, because TreeView gives its rows no `group` to hang a Tailwind group-hover off), and the primary affordance is now DOUBLE-CLICK on the row — what a file tree is expected to do, and what needs no aiming at a 12px target. `TreeViewProps` has no double-click hook, so useTreeRename.ts bolts it onto the rendered DOM exactly as useKeyboardTree.ts beside it already does, mapping a row back to its node through the `${testId}-row-${nodeId}` data-testid the library renders. A double-click on the caret or on the pencil is ignored, so an expand/collapse done twice does not open the dialog.
(3) The editor grew Write / Preview tabs. A markdown document is edited as raw text and read as rendered output, and the author could previously only see the second by saving — not safe here, since this pane's renderer has quirks of its own (a ```json fence printed broken markup at the reader until it was defused). There is no split-pane primitive in the library and a hand-rolled flex container is what the component gate exists to stop, so it is `Tabs` + `TabPanel`, which carry the aria wiring. Preview runs the SAME transform chain as the reader — frontmatter and title heading stripped, json fences defused — over the LIVE buffer, so what the author checks is what will be published rather than a preview of the last save. Pinned by a test asserting the two paths agree. Verified live: typing a heading, a code span and a list renders all three in Preview, and Cancel drops the buffer.
Not editable here by design: the prompts mode is excluded from `canEdit`, because those documents mirror .claude/commands in the source project and editing them in the app would fork them.
re-observed 2026-09-18 (dead code from the chrome removal): removing the "Live" pill and the gateway chip left their imports and one computation behind — `ConnectionPill` and `liveConnectionState` in both files, plus `gatewayOfflineHint`/`isGatewayReady` and the `gatewayHint` line in the explorer. tsc does not fail on an unused import, so the only thing that would have surfaced it is reading the diff. Removed. Nothing on screen changed; this entry exists so the next reader does not go looking for a pill that is no longer rendered.
re-observed 2026-09-18 (the five unaudited surfaces): Reports, Feedback, Configuration, Activity and Settings had never been opened by this audit. Three carried something; two were clean.
REPORTS and FEEDBACK: the identifying label of each row — the team name — was a ghost `Button` carrying the variant's 1px border, so the first column read as a column of controls while the data cells beside it were flat chips. All three call sites already had `px-0` to fight the same variant's padding, which is the tell that the variant was wrong for the job; they now carry `border-0` too. Recorded against the existing ghost-Button row in the queue rather than opened as a new one.
CONFIGURATION: the "Accent" field rendered the bare string "#141C7C" — the one field on the page whose entire content IS a colour, shown in a form nobody can decode. The source project's own Configuration paints a swatch from it (ui/src/components/configuration/Configuration.tsx, `backgroundColor: cohort.accent`), so this now does too, via the library's `StatusDot color=` rather than a hand-rolled span — the component gate bans inline `style={{}}` in pages outright, and my first attempt at the swatch tripped it. Guarded by `isHexColour` so a half-typed "#14" paints nothing rather than a confident wrong colour. Worth recording that the value is carried for the SOURCE system: this app's cohort chips take their colour from the tenant's semantic tones (MOTIONS' `accent: ChipTone`), which are theme-aware in a way a stored hex is not, so the swatch shows what is stored rather than previewing the chip.
ACTIVITY and SETTINGS: clean. Both 404'd at the URLs I guessed — /assessment/activity and /assessment/settings — and neither is a defect: the nav items point at /assessment/runs and the shared /settings, and both resolve. The 404 page itself is good, naming the path and pointing at the rail and ⌘K.
Checked and NOT changed: Feedback's "OPEN QUESTIONS 24" beside "SHOWING 25 open" looks like a contradiction and is not — 24 follow-up questions plus the 1 exception review counted separately as "waiting on you" is the 25 open rows, and each label says what it counts.
re-observed 2026-09-18 (the accent swatch, second pass): the swatch landed as a hand-rolled span with an inline `style={{ backgroundColor }}`, which the component gate bans in pages outright — and rightly, since its own header records that a rule you can evade by hoisting the object to a const is not a rule. Rebuilt on the library's `StatusDot color=`, which takes a colour as a prop and needs no style of ours. A second gate then caught the hex literal I had written into the explaining COMMENT; the branding budget for hex in pages is zero and does not care that it is prose. Both now clean.

### 2026-09-19 workspace keyboard regression (closed after live recheck)

Before the fix, the document tree ran the local useKeyboardTree handler in addition to the installed TreeView's own keyboard implementation. In the rendered workspace, focus Rubric Overview (leaf) and dispatch a bubbling ArrowRight: focus moves to sibling Team Playbooks, although ArrowRight on a leaf should do nothing. Native Tab traversal also skipped the current treeitem while reaching other controls; that observation may involve the native automation/window-focus behavior, so it is not independently attributed to product code. The installed library already supplied roving tabindex and keyboard behavior; the duplicate local shim was the competing implementation. The subsequent live recheck is recorded below.

Resolution: root removed the redundant local hook and retained the installed library behavior. Live recheck confirms leaf ArrowRight stays put, arrows move once, Home/End reach the boundaries, Enter/Space toggle once, and native Tab enters the tree. See workspace.md for the complete current record.

## Open — found 2026-09-29 21:02–21:05, the StackedRail re-walk

- **Source group labels truncate at the 220px documents rail with no title or tooltip** (workspace: “ENGINEERIN…”; enterprise: “ENTERPRISE CONTE…”) — seen as this role on `/assessment/workspace` and `/assessment/enterprise`; recorded once, with measurements and owner (ui-components `StackedRail`), as lead-assessor/DEFECTS.md #15. The two logs are `verdict: fail` on it.

## 2026-10-06 footer re-walk

- Minor: the workspace Explorer section heading "Engineering Space (Confluence)" is cut with an ellipsis (141px into 213px) and has no title, so the full name is unreachable. Repro: /assessment/workspace?doc=page%3A100002 at 1680px; likely the library StackedRail section header (portal/src/pages/assessment/knowledge/DocumentRail.tsx). Not a regression of the footer work.

## 2026-10-06 dimension composer re-walk

- CLOSED 2026-10-06 19:00 (final re-walk: Pinned view reads "Nothing pinned yet", GET /api/chat/pins 200, 0 console errors; a pin and unpin by u-jonas both returned 200). Was: on /assessment/teams/TEAM-001 the Discussion tab's Pinned view reads "Pinned messages are unavailable: gateway request failed: 400" and logs one 400 console error as every assessment role. Repro: open the Discussion tab (any role), then the Pinned sub-tab area renders the message. Matches the known queued gap that Pinned needs /api/chat/pins for assessment channels.
- CLOSED 2026-10-06 19:00 (composer docked at y=707-869 of 940, visible on arrival). Was: the dimension composer's top edge is at y=1593 in a 940px viewport, so on arrival the Chat | Agent block is not visible and has to be found by scrolling the page.

## 2026-10-06 20:16 activity graph re-walk

- Minor, open: the assessment rail now has two near-identical entries, 'Activity graph' (/assessment/activity, the work graph) and 'Activity' (/assessment/runs, the agent run ledger); the command palette query 'Activity' returns both ('Activity graph' and 'Activity — Agent run ledger'). A person scanning the rail cannot tell which is which without hovering. Repro: sign in as this role, open /assessment/teams, read the rail. Not fixed here (no code changes in a re-walk).
- Observation, not a defect: /assessment/activity shows 6 nodes at 1680x940 while GET /api/assessment/work-graph/workspace/graph returns 27; the canvas windows to the viewer's visible region, and the team Activity tab shows its 3 (TEAM-001) or 20 (TEAM-006 after a run) nodes.

## Open — 2026-10-08 — type-scale and layout-cascade findings on the re-walked routes

Recorded from the 2026-10-08 re-walk as assessor (live type census per route is in each log's notes) and the measured sweep contract (docs/journeys/contracts/type-scale.json, 09:34Z). The cascade sweep reports no violations for any of these routes. Not fixed here; no product code was edited.

- /assessment/teams · title 20/600 · scale content 10/400; scale content 11/400 · rule: type scale (14/600 headings, 14/400 body, 12/400 meta, 20/600 page title; docs/journeys.md type-scale contract)
- /assessment/enterprise · title 20/700 · scale content 10/400; scale content 13/400; scale content 13/500; scale content 16/400; scale content 16/600; scale rail 11/600; scale rail 13/500; siblings content 40|22 · rule: type scale (14/600 headings, 14/400 body, 12/400 meta, 20/600 page title; docs/journeys.md type-scale contract)
- /assessment/feedback · title 20/600 · no sweep offenders · rule: type scale (14/600 headings, 14/400 body, 12/400 meta, 20/600 page title; docs/journeys.md type-scale contract)
- /assessment/prompts · title 20/700 · scale content 10/400; scale content 11/400; scale content 13/400; scale content 13/500; scale content 13/600; scale content 16/400; scale content 16/600; scale rail 11/600; scale rail 13/500; siblings content 40|22|22|22 · rule: type scale (14/600 headings, 14/400 body, 12/400 meta, 20/600 page title; docs/journeys.md type-scale contract)
- /assessment/reports · title 20/600 · actions content size=md; scale content 11/400; title-scale content 20/600 · rule: type scale (14/600 headings, 14/400 body, 12/400 meta, 20/600 page title; docs/journeys.md type-scale contract)
- /assessment/rules · title 20/700 · scale content 10/400; scale content 13/400; scale content 13/500; scale content 16/400; scale content 16/600; scale rail 11/600; scale rail 13/500 · rule: type scale (14/600 headings, 14/400 body, 12/400 meta, 20/600 page title; docs/journeys.md type-scale contract)
- /assessment/runs · title 20/600 · scale content 11/400; scale content 16/400; title-scale content 20/600 · rule: type scale (14/600 headings, 14/400 body, 12/400 meta, 20/600 page title; docs/journeys.md type-scale contract)
- /assessment/submissions · title 20/600 · no sweep offenders · rule: type scale (14/600 headings, 14/400 body, 12/400 meta, 20/600 page title; docs/journeys.md type-scale contract)
- /assessment/submissions?view=add · title 20/600 · no sweep offenders · rule: type scale (14/600 headings, 14/400 body, 12/400 meta, 20/600 page title; docs/journeys.md type-scale contract)
- /assessment/teams/TEAM-001 · title 20/600 · actions content 16/600; scale content 10/400; scale content 10/600; scale content 11/400; scale content 11/700; scale content 16/400; scale content 16/600; scale content 18/700; siblings content 12|16 · rule: type scale (14/600 headings, 14/400 body, 12/400 meta, 20/600 page title; docs/journeys.md type-scale contract)
- /assessment/workspace · title 20/700 · scale content 10/400; scale content 11/400; scale content 13/400; scale content 13/500; scale content 13/600; scale content 16/400; scale content 16/600; scale rail 11/600; scale rail 13/500; siblings content 40|22|22 · rule: type scale (14/600 headings, 14/400 body, 12/400 meta, 20/600 page title; docs/journeys.md type-scale contract)

Scorecard dimension rail, measured live as assessor: sibling group headings in one rail carry different sizes — Dimensions17 12/600; Claims to verify6 16/400; Verified9 16/400; Not applicable2 16/400; Testing & QE – Automated Tes 18/700. The sweep's `siblings content 12|16` offender is exactly this (the "Dimensions" heading is 12/600 while "Claims to verify / Verified / Not applicable" are 16/400). Rule: sibling headings share one size (layout cascade / type scale).

Explorer pages (workspace, enterprise, rules, prompts): the page title is 20/700 where every other page is 20/600, and the content region draws 10/11/13/16/22/40px text outside the scale (sweep offenders above). The Explorer rail has no search control (menu offers only "Refresh library"); PROTOCOL.md still describes a searchable tree rail — open question, not a regression I can date.

The earlier "composer below the fold" defect stays closed: the dimension composer input measured y=779-819 against the footer at y=893 on arrival.
