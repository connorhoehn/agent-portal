# Defects found — program-lead journey audit (u-farah)

All 12 surfaces pass. No new functional defects were found for this role beyond
what assessor/lead-assessor already documented, and every defect those two
audits found already fixed remains fixed here too. One transient issue was
observed and investigated; it is not filed as a defect (see below).

## Investigated, not filed as a defect

1. **Submissions wizard step 1 ("Parse file") returned one transient 500.**
   The FIRST `POST /api/assessment/submissions/parse` attempt with the fixture
   CSV returned 500 "Internal server error"; the identical request seconds
   later returned 200 and parsed correctly, and every later attempt in this
   session (including a full second end-to-end run of the wizard) succeeded
   cleanly. Root-caused it live: `parseSubmission()` in
   `middleware/src/providers/assessment.ts` calls
   `parseFormsRecords(payload.records ?? [], sourceFile)` with only 2
   arguments, but `parseFormsRecords` requires 4
   (`records, sourceFile, teams, hasCommittedEnvelopeForForm`) — if this were
   a real code defect it would 500 on every call, not just the first. Given
   this session has other agents concurrently editing this same repo
   (confirmed separately by Vite HMR "Failed to reload ExceptionsModal.tsx"
   overlay messages during the dashboard pass, and a `GET
   /api/assessment/runs/<id>` 404 for a run that had returned 202 seconds
   earlier — a symptom of an in-memory mock store resetting mid-session),
   this reads as a request racing a live server reload, not a reproducible
   bug. Flagging here in case a future clean-session run reproduces it —
   if so, the fix is adding the two missing arguments at that call site.
   Detail: submissions-wizard.md.

## Confirmed still-fixed (re-verified, not re-opened)

- Exceptions modal Approve/Deny clipping (lead-assessor/DEFECTS.md): the
  modal is 960px wide and both buttons render fully inside it at this
  window width — team-scorecard.md.
- Explorer rail inset (assessor/DEFECTS.md #4): 0px offset on
  workspace/enterprise/rules/prompts — confirmed for program-lead too.
- Tree keyboard reachability (assessor/DEFECTS.md #5): roving tabindex
  confirmed on workspace/rules/prompts.
- Configuration/team-scorecard "missing key" console warnings (assessor/
  DEFECTS.md #6, #7): 0 console errors on every surface visited, including
  genuine reloads.
- Command-palette observability-harness 403 poll (assessor/DEFECTS.md #8):
  zero `/api/observability/harness/*` requests fired across this entire
  session's navigation — runs.md.
- Workspace document-pane ratio (open in both prior passes at 0.437/0.493):
  now 0.727 at this window width, via a responsive fix that stacks the
  Activity aside below the document pane instead of beside it under 1536px
  — workspace.md.

### Disposition of the transient parse 500 (reviewed 2026-09-05 01:40)

Not a code defect. The auditor read the file mid-refactor: the Aurora pass
was changing `parseFormsRecords` from reading `M.MOCK_TEAMS` to taking
`teams` + `hasCommittedEnvelopeForForm` as parameters, and for a few seconds
the call site and the signature disagreed while `tsx watch` restarted the
middleware. Both call sites (`assessment.ts:1886` Aurora, `:1905` mock) now
pass all four arguments, `tsc` is clean, and the wizard parse test suite is
green. The `GET /runs/<id>` 404 seconds after a 202 is the same restart — the
mock store is in-memory and a restart empties runs launched in that session.

## Closed (re-verified fixed in the 2026-09-07 re-audit)

1. **A processed submission never stops showing "Unprocessed".** Fixed for
   the general case and verified live on 2026-09-07. `/assessment/submissions`
   read SUBMISSIONS 6 / TEAMS 5 / UNPROCESSED 3, with TEAM-007's, TEAM-006's
   and TEAM-002's rows all carrying a green "Processed" pill — against the
   previous pass, which found all five rows amber and the tile stuck at
   "UNPROCESSED 5" no matter how many runs completed. The pill's success
   state is reachable and the counter tracks the data. The narrower case
   where a hinted dimension comes back without a verified level still sticks
   and is filed separately as Open #2 rather than left under this entry.
   Detail: submissions.md. Fixed in `middleware/src/mock/assessment.ts`
   (`isSubmissionProcessed`) and `middleware/src/providers/assessment.ts`
   (`listSubmissions` / `getSubmissionDetail`).

2. **The "N/A exceptions" dialog has no visible close control.** Fixed and
   verified live on 2026-09-07. The dialog now carries a footer "Close"
   button for every role, and this pass caught it in the exact state that
   motivated the fix: both of TEAM-001's N/A exceptions had already been
   decided, so the ACTIONS column was empty and "Close" was the **only**
   control in the dialog — where before there would have been none at all,
   even for a role that may approve. Both dismiss routes work and both hand
   focus back: with the "Exceptions" trigger focused as a real user leaves
   it, opening moves focus to "Close"; clicking Close removes the dialog and
   `document.activeElement` is the trigger again, and Escape does the same
   (`focusBackAfterClose: true`, `focusBackAfterEscape: true`, read after two
   painted frames). Detail: team-scorecard.md. Fixed in
   `portal/src/pages/assessment/dashboard/ExceptionsModal.tsx`.

3. **The explorer's document pane drops under the 0.55 floor at viewports
   ≥1536px.** Fixed and verified live on 2026-09-07. Re-measured for this
   role on `/assessment/workspace` at the same 1560px window the defect was
   filed at: content column 1312px, tree rail 300px, Activity aside now
   **256px** (was 320px), document pane **756px** — 756 ÷ 1312 = **0.576**,
   against 692px = 0.53 before. The rail is still flush at a 0px offset
   (rail `left` 224px = content-column `left` 224px), and the three explorer
   pages with no aside measure 1012 ÷ 1312 = **0.771** (enterprise, rules,
   prompts). Detail: workspace.md, enterprise.md, rules.md, prompts.md.
   Fixed in `portal/src/pages/assessment/knowledge/ExplorerFrame.tsx`.

## Closed (re-verified fixed in the 2026-09-07 02:32 re-audit)

Re-observed as fixed by re-running the original repro steps as u-farah, not by
reading the fix. Numbering follows the Open entries they replace.

2. **A submission whose run completed still read "Unprocessed" when its
   hinted dimension landed unverified.** Fixed. Observed 2026-09-07 02:32,
   deliberately from the angle that used to demonstrate the inversion: I
   committed an r2 of TEAM-005's Form #7 — the row that could never leave the
   UNPROCESSED count — marked its one evidence link **Skipped** at step 3
   rather than fetched, and processed it to "Completed — Scored 17
   dimensions: 5 from evidence, 12 low-confidence with no evidence; 12
   follow-ups opened". The list reads that row as **Processed**, LINKS
   **1/1**, "2 revisions — latest r2", and the tiles read SUBMISSIONS 6 /
   TEAMS 5 / **UNPROCESSED 0** with a green pill on all six rows
   (program-lead/submissions.jpg). Taken with the fetched-link run in
   lead-assessor/submissions.md and the no-link rows, all three link
   dispositions now reach Processed, so evidence no longer makes a row *less*
   likely to count however it is resolved.
   Fixed in `middleware/src/mock/assessment.ts` (`isSubmissionProcessed`),
   which now asks whether each hinted dimension carries a `history` entry at
   or after the envelope's `ingested_at` rather than whether that pass
   produced a level.

3. **The wizard's step 2 kept calling a row "Unknown team" after you had
   matched it.** Fixed. Observed 2026-09-07 02:28: row 9 ("Ledger
   Reconciliation") still parses in amber "Unknown team" with a "Match a
   team…" select, which is correct — the submitted name resolves to no roster
   id. Choosing "Internal Tools (TEAM-007)" flips the chip to a green
   **"Matched"**, and the footer moved to "2 submissions selected / Commit 2
   submissions". program-lead/submissions-wizard.jpg shows all three states
   in one table — two grey "Seen" rows, one ticked and one not, beside the
   green "Matched" row with its populated select — and nothing on screen
   contradicts anything else.
   Fixed in `portal/src/pages/assessment/secondaryFormat.ts`
   (`resolveRowStatusDisplay`) and
   `portal/src/pages/assessment/submissions/PreviewStep.tsx`.

4. **The document editor destroyed the document while the gateway was
   unreachable.** Fixed. Observed 2026-09-07 02:18, with the transport in
   exactly the state that produced the loss — `gateway HTTP status:
   unhealthy`, `gateway WebSocket status: reconnecting`, pill "Gateway
   offline — presence and co-editing via the BFF". On
   `/assessment/rules?doc=rule:scoring-guardrails.md` (server
   `markdown.length` **326**) pressing **Edit** now opens a body editor
   **populated with all 326 characters**, under an amber inline alert reading
   "Editing an offline copy — the realtime session is reconnecting, so this
   edit won't sync live and other viewers won't see it until you save."
   Pressing **Save** on the unmodified buffer — idempotent by design, so a
   still-broken build could not have destroyed anything — returned "Saved."
   and `GET .../knowledge/doc` came back **326 characters, byte-identical**.
   The old failure wrote `""` at this point. Screenshot:
   program-lead/rules.jpg.
   Keystrokes were checked too, without writing: with the body textarea
   focused I typed `- keystroke probe` at the end and the value went
   **326 -> 343** and stayed there, where the old failure snapped it straight
   back to `""`; **Cancel** discarded it and the server was still 326
   characters with no probe text. The one branch this fixture cannot reach is
   the withheld-Edit case (off-sync **and** no fallback content) -- every
   document in the tenant's tree has content -- so that rests on the portal
   node tests for `decideDocSaveGate`.
   Fixed in `portal/src/pages/assessment/knowledge/DocPane.tsx` and
   `portal/src/pages/assessment/knowledge/knowledgeFormat.ts`.

## Closed (re-verified fixed in the 2026-09-07 02:38 re-audit)

1. **The empty Enterprise page never names the action that would fill it.**
   Closed, not by rewording the empty state but by removing it. The page was
   never empty — #5 below was the cause — and as of 2026-09-07 02:38 it opens
   on a rail headed "ENTERPRISE CONTEXT · 10" listing all four folders and all
   six documents. "Nothing here yet." is now only the genuine not-found
   fallback. The 02:21 note on this entry was right to hold: naming
   `extract-enterprise-context` in that copy would have told the program lead
   to regenerate documents that were already written. Detail: enterprise.md.

5. **The Enterprise page hides every document it has.** Fixed. Re-observed
   2026-09-07 02:38 as u-farah: the rail reads "ENTERPRISE CONTEXT · 10" and
   holds all four folders and all six documents — CI/CD Standards, Security
   Baseline, Intake Checklist, Scoring Workflow, RACI, Approved Tools. Every
   one opens and renders; RACI, the document this role most needs, comes
   through as a genuine `<table>` (1 table, 5 rows, 4 `<th>`, no raw pipes)
   stating "Change target level: Program Lead = A". `?doc=` deep links
   resolve, a directory id renders a folder pane, and an unknown id falls back
   to "Select a document from the library to view it." with the rail intact at
   10 nodes. 23 interactive controls, all reachable, 0 console errors, ten
   `[role="treeitem"]` nodes with exactly one at `tabindex="0"`, ArrowDown +
   Enter navigating correctly. `SECTION_KEY_FOR_MODE` now maps `enterprise` to
   `enterprise_context` and the unit fixture was rekeyed to the server's real
   shape. Detail: enterprise.md.

6. **A save tells the saving tab that someone changed the document.** Fixed.
   Re-observed 2026-09-07 02:44 on `/assessment/rules?doc=rule:scoring-guardrails.md`
   as u-jonas. Saving the unmodified 326-character buffer produced **zero**
   "Updated by … just now" notices across 30 samples over 9 seconds, and a
   full reload of the saving tab produced none either — the confirmed-save
   timestamp set persists in `sessionStorage`
   (`assessment.knowledge.ownSaveTimestamps`, 6 entries after the test) and
   survived the reload. The suppression did not go too far: with a second tab
   open on the same document, a genuine save from that tab still raised
   "Updated by u-jonas just now" in the first tab within seconds. A residual,
   separately caused problem found while confirming this is filed as Open #7.

## Closed (re-verified fixed in the 2026-09-07 04:20 re-audit)

7. **A freshly opened tab is told an hours-old edit happened "just now".**
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
   `2026-09-07T08:41:43.616Z` and tab A left untouched and read repeatedly:

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


## Fixed and re-audited — knowledge editor agent, 2026-09-07 01:03 EDT

The Open #4 defect above ("The document editor destroys the document while
the gateway is unreachable") is fixed. Left the Open entry in place above
(not moved/renumbered) since this note is the disposition, not a re-audit.

**Root cause.** `useCRDT` (realtime-modules, vendored — not owned in this
repo) only wires the Y.Text observer that updates `crdt.content` inside the
effect gated on `connectionState === 'connected'`; while the transport is
`reconnecting`/`disconnected` that effect never runs, so `crdt.content` stays
frozen at its initial `''`, `applyLocalEdit` mutates a Y.Doc nobody is
reading, and a textarea bound to `value={crdt.content}` renders permanently
blank and rejects every keystroke — on a document that may have real
content. The seed at the old `DocPane.tsx:321`
(`if (!crdt.content && doc.markdown) crdt.applyLocalEdit(doc.markdown)`) only
ever ran once, into a Y.Doc whose observer was never registered while
off-sync, so it had no visible effect. Saving `crdt.content` in that state
posted `""` with a 200.

**Fix**, entirely in `portal/src/pages/assessment/knowledge/`:
1. `knowledgeFormat.ts` gains `docSyncStatus(connectionState, clientId)`
   (collapses the gateway's five-state `ConnectionState` to
   `'synced' | 'reconnecting' | 'disconnected'`, 'synced' meaning
   `isGatewayReady`) and the pure gate `decideDocSaveGate({ status, hasSeed })`
   — the one question a save must answer: was the content ever actually
   loaded? `synced` always passes (including a genuinely empty document —
   that's an observed state, not an unloaded one); off-sync passes only when
   a non-empty HTTP-fetched fallback (`hasSeed`) was available to edit
   instead of the frozen CRDT. Off-sync with no fallback refuses, with a
   reason naming which transport state is unavailable. Node tests in
   `portal/src/pages/assessment/__tests__/knowledgeFormat.test.ts` cover all
   four states: synced with content, reconnecting with a seed, reconnecting
   with no seed, and synced-but-genuinely-empty.
2. `DocPane.tsx` now tracks an explicit `editSource: 'crdt' | 'fallback' |
   null` per edit session, fixed at `startEditing()`: synced → bind the
   textarea to `crdt.content`/`crdt.applyLocalEdit` as before; off-sync (with
   a seed — the Edit button is disabled otherwise, see below) → bind it to a
   local `fallbackContent` state seeded from the HTTP-fetched `doc.markdown`.
   A handoff effect catches the case where the transport drops mid-edit
   while `editSource === 'crdt'`: it captures the last-good `crdt.content`
   into `fallbackContent` and switches the session to `'fallback'` before
   the frozen/reset CRDT value can ever render — so a disconnect that
   happens *during* an edit is closed the same way as one found on open.
   The handoff is deliberately one-directional (never fallback → crdt
   mid-session) so a mid-edit reconnect can't silently discard unsaved
   fallback edits under a live snapshot.
   `handleSave` re-checks `decideDocSaveGate` (using
   `fallbackContent !== null` as `hasSeed` once a session is underway)
   immediately before the PUT and refuses with a visible `saveError` instead
   of posting when it fails — belt-and-suspenders against any future
   regression that reaches Save without a real edit source.
3. When capability + `doc.editable` would otherwise offer editing but the
   transport is off-sync AND the doc has no fallback content, the Edit
   button is withheld and an `InlineAlert` names the unavailable state
   instead (`decideDocSaveGate`'s `reason`) — never an empty box that
   accepts a Save. When editing via the fallback path, a second
   `InlineAlert` says so explicitly ("Editing an offline copy — the realtime
   session is {status}...") so the reader always knows which state they're
   in, matching what the presence/document-push/comments paths already say
   honestly via the existing "Gateway offline" pill.

**States that can now reach a save:** (a) transport `synced`, any content
including empty (deliberate clear); (b) transport `reconnecting` or
`disconnected` at open, with a non-empty HTTP-fetched seed, edited as an
offline copy; (c) transport `synced` at edit start, later drops mid-edit —
handed off to the last-good captured content, still saveable. The only
editing-disallowed state is off-sync with no seed at all (nothing was ever
loaded) — read-only with a stated reason, and `handleSave` itself refuses a
post in that state even if reached by some other path.

Verified: `node --test 'src/**/__tests__/*.test.ts'` (589 pass, including the
new `docSyncStatus`/`decideDocSaveGate` cases), `npx tsc --noEmit` clean,
`npx vite build` clean, and (from the repo root)
`scripts/validate-orgiq-audit.sh --quick` component-discipline section and
`scripts/validate-branding.sh --quick` header-rhythm section both ✓.
File: `portal/src/pages/assessment/knowledge/DocPane.tsx`,
`portal/src/pages/assessment/knowledge/knowledgeFormat.ts`.

## Fixed and re-audited — knowledge agent, 2026-09-07

Re-audited 2026-09-07 02:12–02:53; both are confirmed fixed in the browser and
have been moved to the dated Closed section above. What follows is the root
cause and the change, kept for the record.

5. **The Enterprise page hides every document it has.** Root cause confirmed
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

6. **A save tells the saving tab that someone changed the document.** Root
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
   and — exactly the repro filed above — after a genuine full reload of the
   tab.
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

7. **A freshly opened tab is told an hours-old edit happened "just now".**
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

## Open — found 2026-09-29, EditorShell rebuild re-walk

- **Prompts are renamable from the rail by this role** (Rename… on every prompt row's ⋯, accepted by the server). Full evidence and owner in `lead-assessor/DEFECTS.md` #5; this role's `prompts.md` carries `verdict: fail`.

## Open — found 2026-09-29 21:02–21:05, the StackedRail re-walk

- **Source group labels truncate at the 220px documents rail with no title or tooltip** (workspace: “ENGINEERIN…”, “WORKSPACE DRA…”; enterprise: “ENTERPRISE CONTE…”) — seen as this role on `/assessment/workspace` and `/assessment/enterprise`; recorded once, with measurements and owner (ui-components `StackedRail`), as lead-assessor/DEFECTS.md #15. The two logs are `verdict: fail` on it.
