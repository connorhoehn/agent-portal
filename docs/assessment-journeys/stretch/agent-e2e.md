## Before (2026-09-05, middleware stub gateway)

stretch item: agent end-to-end through the fleet
role: lead-assessor
user: u-jonas
tenant: assessment
pages: portal/src/pages/assessment/RunsPage.tsx,portal/src/pages/assessment/dashboard/TeamScorecard.tsx
audited: 2026-09-18 12:0x local, Chrome 1512px, middleware dev:mock on 127.0.0.1:3013 behind a Vite proxy pinned to it
screenshot: agent-e2e.jpg (ledger showing the launched run at "completed" status, top row)
verdict: pass (ledger mechanics) / fail (score application) — the run appears and completes live through SSE exactly as expected, but it writes a scoring log for one dimension only and never touches the scorecard

## Run launch and ledger

On `/assessment/runs`, selected team "Fraud Detection ML (TEAM-006)" (native `<select>`; had to set its value programmatically after `Down`+`Enter` keystrokes failed to register — the on-screen select never visually opened during automation, but the app-level state update worked correctly once the `change` event fired) and clicked **Run** on `score-dimensions`. A toast confirmed "Run started · score-dimensions for TEAM-006."

Without any page reload or navigation (only scrolling within the same SPA view), a new row appeared at the top of the ledger:

- run id: `run-20260905T063742Z-score-dimensions-aae48023a4d3`
- command: `score-dimensions`, team: `TEAM-006`
- appeared with status **running**, started "just now", duration "—"
- polled via `javascript_tool` — by the next check the row had already flipped to status **completed**, duration **0m 08s** (the mock runner's fixed ~8s runtime, matching every other `score-dimensions`/`process-self-assessment` row in the ledger, which all show `0m 08s` too — this looks like a fixed mock delay, not simulated variable work)

This is a real SSE-driven update: the row's appearance, its running->completed transition, and its duration all rendered with zero interaction beyond the initial Run click — no refresh anywhere in this sequence.

## "How it was assessed" — scoring log

Navigated to `/assessment/teams/TEAM-006` -> **How it was assessed** (top-right of the scorecard header). The drawer lists two prior scoring-log runs for this team:

- `20260905T063750Z` — source `mock` (this is the run just launched: `063750Z` is 8s after the ledger's `063742Z` start stamp, consistent with the 0m 08s duration)
- `20260905T051440Z` — source `mock` (an earlier run, ~76 minutes before, corresponding to the `run-20260905T051432Z-process-self-assessment-ecd5e006b425` row visible in the ledger)

Opened the matching `20260905T063750Z` entry. Its content is:

```
Source: mock · No submission envelope
CONTINUOUS INTEGRATION (CI)   [L2]  [moderate]
Mock run — plausible placeholder score for "score-dimensions" (demo data, not a real assessment).
```

Only **one** of the team's 17 dimensions (Continuous Integration) got a log entry, at level **L2** / tone "moderate" — and the log text says outright it is a "plausible placeholder score... demo data, not a real assessment." No envelope, no other dimensions, no rationale beyond that boilerplate line.

## Did the scorecard change?

No. Before and after the run, `/assessment/teams/TEAM-006`'s Certification tab still reads:

- Certification: **Not yet assessed** · 0 of 17 dimensions
- ASSESSED: **0/17**
- Workflow step: still **Intake** (never advanced to Classify/Score/Review)
- Dimension 01 (Continuous Integration — the one dimension the log claims to have scored): still shows **"Not yet verified · no claim on file"**, level **Low**, basis **self-attested**; its own "How it was assessed" tab still reads "Rated low · basis: self-attested. That means it rests on what the team told us, and nothing more." — no mention of the run, no L2, no "moderate."

So the run writes a scoring **log** entry (visible in the drawer, timestamped, tied to the run id) but never calls whatever code path would apply that score to the team's live dimension data. The log and the scorecard are two disconnected surfaces for this command in mock mode.

## Summary

The ledger/ SSE half of "agent end-to-end" genuinely works: launch a run, watch it appear, tick to completion, all live with no reload — this is solid. The "assessment" half does not: `score-dimensions` for TEAM-006 produced a scoring log for exactly one dimension, explicitly labeled placeholder/demo data, and the team's actual scorecard (dimension levels, ASSESSED count, workflow step) was completely untouched by the run. A user watching the ledger would reasonably conclude TEAM-006 got assessed; opening the scorecard shows it didn't.


## After — gateway mode (18080) (2026-09-05, real websocket-gateway on :18080)

stretch item: agent end-to-end through the fleet, re-run against the real gateway, against a team that had never been touched
role: lead-assessor
user: u-jonas
tenant: assessment
audited: 2026-09-05 07:22 local, Chrome 1440px, portal restarted with VITE_GATEWAY_URL=http://localhost:18080, middleware dev:mock
screenshot: agent-e2e.jpg (ledger showing the launched run for TEAM-007 at "completed" status, top row)
verdict: pass (ledger mechanics AND score application) — the run appears and completes live through SSE exactly as expected, and this time it applies a full 17-dimension score set to the team's live scorecard

### Run launch and ledger

On `/assessment/runs`, selected team "Internal Tools (TEAM-007)" — this team was unassessed going in (TEAM-006 was already scored by an earlier run, so TEAM-007 is a clean, never-before-scored subject) — via the native `<select>` (set programmatically through the native value setter + `change` event, same as Before; the on-screen select still doesn't visually open under automation, but the underlying state update fires correctly), and clicked **Run** on `score-dimensions`. A toast confirmed "Run started · score-dimensions for TEAM-007."

Without any page reload or navigation, a new row appeared at the top of the ledger:

- run id: `run-20260905T072242Z-score-dimensions-a5abd12ac353`
- command: `score-dimensions`, team: `TEAM-007`
- appeared with status **running**, started "just now", duration "—"
- polled via `javascript_tool` — the row had already flipped to status **completed**, duration **0m 08s** by the time of the first poll (same fixed ~8s mock runtime noted in Before)

Real SSE-driven update again: appearance, running→completed transition, and duration all rendered live with zero interaction beyond the initial Run click.

### Scorecard — did it change this time?

Yes. `/assessment/teams/TEAM-007` now shows:

- Certification: **L2** — "Working toward Level 3 · verified up to Leve…"
- ASSESSED: **17/17**
- Open follow-ups: **17** (one per dimension, e.g. dimension 01's reads: `No evidence has been submitted for "Continuous Integration (CI)" — can the team describe current practice or link supporting documentation?`)
- Workflow step: **Score** (workflow rail shows Intake ✓ and Classify ✓ both green-checked, Score as the current highlighted step, Review/Publish/Follow-up still pending) — this is a real advance past Before's stuck-at-Intake finding

Levels/confidence across all 17 dimensions (rail, left to right, all confidence **Low**, all basis **self-attested**):

| # | Dimension | Level |
|---|---|---|
| 01 | Continuous Integration (CI) | L1 |
| 02 | Continuous Delivery (CD) | L2 |
| 03 | Automation | L0 |
| 04 | Source Control & Traceability | L1 |
| 05 | Testing & QE – Automated Testing | L2 |
| 06 | Testing & QE – Security Testing | L0 |
| 07 | Testing & QE – Performance & … | L1 |
| 08 | Security Control SDLC & Code … | L2 |
| 09 | Engineering Governance | L0 |
| 10 | Monitoring, Observability & Ru… | L0 |
| 11 | Environment Management | L1 |
| 12 | Release Management & Opera… | L2 |
| 13 | Platform Reusability & Patterns | L0 |
| 14 | Software Development Mindse… | L1 |
| 15 | Agile Planning & Backlog Mana… | L2 |
| 16 | Design Standards & Technical … | L0 |
| 17 | Engineering Metrics & Continu… | L1 |

Distribution: 6× L0, 6× L1, 5× L2 — all confidence "Low" / basis "self-attested" (consistent with a floor-estimate scoring pass with no submitted evidence, not a real evidence-backed assessment — but this time the floor estimates are actually **written to the live scorecard**, not just to an isolated log).

### "How it was assessed" — scoring log

Opened the drawer from the team header. It lists exactly one run: **`20260905T072250Z`**, source `mock`, envelope `—` — the stamp is 8 seconds after the ledger's `072242Z` start time, matching the run's `0m 08s` duration exactly (the run's own summary/duration is what the stamp corresponds to).

Opening that run shows one entry per dimension (17 total, not 1 as in Before). Verbatim, three of them:

> **CONTINUOUS INTEGRATION (CI)** `L1` `low`
> No evidence was found for "Continuous Integration (CI)" — no self-assessment answer, no linked intake evidence. Suggested Level 1 is a floor estimate only, not a verified score.

> **CONTINUOUS DELIVERY (CD)** `L2` `low`
> No evidence was found for "Continuous Delivery (CD)" — no self-assessment answer, no linked intake evidence. Suggested Level 2 is a floor estimate only, not a verified score.

> **AUTOMATION** `L0` `low`
> No evidence was found for "Automation" — no self-assessment answer, no linked intake evidence. Suggested Level 0 is a floor estimate only, not a verified score.

This is a materially different (and more honest) log than Before's single "Mock run — plausible placeholder score... demo data, not a real assessment" line: each of the 17 entries names its own basis (no self-assessment answer, no linked evidence) and calls its own level a floor estimate, not a verified score — and, critically, those floor estimates are the same L0/L1/L2 values now showing on the live scorecard rail above, so the log and the scorecard agree.

### Console errors

0 errors on `/assessment/runs` and `/assessment/teams/TEAM-007` across the whole sequence.

### Summary

Both halves of "agent end-to-end" now work. The ledger/SSE mechanics were already solid in Before and still are. The scoring half is fixed: `score-dimensions` against a genuinely untouched team (TEAM-007) produced a full 17-dimension score set, advanced the workflow step from Intake to Score, set a real ASSESSED 17/17 and a derived L2 certification, and opened 17 explicit follow-ups — and the scoring log's per-dimension rationale (self-attested floor estimate, no evidence) matches what's shown on the scorecard exactly. A user watching the ledger and then opening the scorecard now sees a consistent story, unlike Before's split between "ledger says done" and "scorecard says untouched."

--- freshness re-observation, 2026-09-08 (the Lead cell) ---
Why: `portal/src/pages/assessment/dashboard/TeamScorecard.tsx` changed, which moved this
log's `pages:` digest. The change is narrow and is the portal half of the
assessment wire-field correction: `TeamSummary.assessment_lead_person_id`,
`TeamDetail.assessment_lead_person_id` and `contributors[].person_id` were
deleted from `pages/assessment/types.ts` because the server sends none of them
(verified live across all 7 teams, and asserted absent by
`middleware/src/providers/__tests__/assessment-declared-fields.test.ts`). The two
places that read them therefore stopped wrapping the lead's name in `PersonRef`.
Nothing was lost by that: `PersonRef` was always being handed a null personId
here, and with a null id it returns its plain, NON-focusable branch before any of
its hover/pin machinery — and in this tenant it would refuse to link anyway
(`linkable = session?.tenant === 'orgiq'`). The lead was already a name, not a
control; it is now a name written as one.
Re-observed live at 1552px on `npm run dev:mock` (127.0.0.1:3011 behind a pinned
Vite proxy), signed in through /select as Asha Nair, Jonas Lindqvist, Farah Osei and Platform Operator in turn — all four gave the same numbers:
  - the team header now renders `Lead: Priya Natarajan` as text, with **0**
    focusable controls inside it.
  - `/assessment/teams?cohort=all` (TeamList, the other reader of the deleted
    field): the Lead column is plain text, **0** focusable controls per cell.
  - CORRECTION TO THE `keyboard:` LINE ABOVE, and it is not caused by this
    change. The sweep now finds **34** visible, enabled controls in `<main>` on
    the Certification tab, not 26, and a document-order `.focus()` sweep reaches
    all 34 (0 unreachable), so the surface still passes its keyboard criterion.
    The 34 itemise as: the "Dashboard" breadcrumb link (1), the header actions
    Exceptions / How it was assessed / Report / + Add evidence / the overflow
    menu (5), the five outer tabs (5), the dimension-rail collapse chevron (1),
    the seventeen `role="option"` dimension rows (17), and the five inner tabs of
    the dimension detail — Progress & follow-ups / How it was assessed / Evidence
    / Definition & rubric / History (5). Deleting a wire field can only remove
    controls, never add eight, so the earlier 26 was taken against a different
    control set; which eight that sweep excluded is for a real re-audit of this
    surface to settle, not for a freshness note. Recorded here rather than left
    to be re-discovered.
The em dash matters and was preserved deliberately: `assessment_lead` is the
empty string on TEAM-006 and TEAM-007, and `PersonRef`'s "no name" branch used to
render "—" for them. A bare data key would have left those cells blank, which
reads as a rendering fault rather than as "nobody yet", so the column keeps the
em dash the rest of this table uses for an empty. Verified: the seven Lead cells
read Dana Whitfield, Sam Okafor, —, —, Elena Marsh, Priya Natarajan, Jordan Lee,
and each one contains 0 focusable controls.
Console errors: 0 on both surfaces.

--- freshness re-observation, 2026-09-15 21:20 (TeamScorecard.tsx changed: slices 4 + 5 of docs/assessment-ux-goal.md) ---
Why: the scorecard header now renders the team's repos and contacts from the same `GET /teams/:id` payload, and the Certification tab opens with the evidence coverage strip above the master-detail. The run-a-scoring-agent path this log records (Runs page → launch → the scorecard reflecting applied scores) is unchanged: the strip and the rail rows re-derive from the refreshed payload, so an applied score moves a chip from "Unassessed" to its class and a row from badge-only to badge + meter without a reload beyond the one this page already does. Re-opened TEAM-001 and TEAM-003 as u-asha / u-operator after the change: console errors 0.

--- freshness re-observation, 2026-09-16 00:12 (portal/src/pages/assessment changed: secondary-page findings from the audit fan-out) ---
Why: five Sonnet fix agents applied the read-only audit's findings; re-observed as u-asha on TEAM-001 (all five scorecard tabs), /assessment/submissions and /assessment/runs.
  RunsPage.tsx changed only in the run-detail drawer (Team / Started / Duration / Progress / Summary / Error are shared KeyValue rows); the launch → ledger → scorecard path this log records is unchanged.
Console errors: 0.

--- freshness re-observation, 2026-09-16 01:50 (portal/src/pages/assessment changed: three Card lists → DataTable) ---
Why: the last three open audit findings for this tenant; re-observed as u-asha (/assessment/runs, /assessment/submissions, the wizard) and as u-operator (a knowledge doc's History).
  RunsPage changed in the Run-a-command panel only (a DataTable with the same launch handler and team gating); the launch → ledger → scorecard path is unchanged.
Console errors: 0. Re-audit 2026-09-16 04:02: RunsPage read is on useFetch; the SSE run stream and selection are unchanged. Code-verified. Console errors 0. Re-audit 2026-09-16 05:40: RunsPage command panel reads via useFetch; the SSE run stream is unchanged. Code-verified. Console errors 0. Re-audit 2026-09-16 08:05: Runs ledger status reads from the shared table; the SSE stream is unchanged. Code-verified. Console errors 0. Re-audit 2026-09-16 09:33: Runs ledger keeps its frame while loading; the SSE stream is unchanged. Code-verified. Console errors 0. Re-audit 2026-09-16 10:30: Scale pass: the runs ledger paginates; the SSE stream is unchanged. Code-verified. Console errors 0. Re-audit 2026-09-16: the Activity page now warns when the live feed reports a replay gap, with a 'Refresh the ledger' button. This page folds run.started/progress/completed/failed onto the ledger rather than re-reading it per event, so a dropped transition would leave a finished run rendering as running — the notice says so and the button re-reads the server state. Not visible in the healthy path observed here: the stream connected and every run row tracked its own launch through to completion, so no notice rendered; the Live pill and the table are unchanged. Console errors 0.

Re-audit 2026-09-17 23:55 — `knowledge/DocPane.tsx` moved this log's digest, for two changes and one correction to the record. (1) `updated_at` came down on every document read and was used only to confirm this tab's own save — it was never shown. "When did this last change?" is the second question anyone asks of a document and the answer was already in hand; the meta line now carries it (`prompts/classify-transcript.md · Updated Aug 13, 2026`), through the shared `lib/relativeTime`. (2) The document card now takes `shadow-sm`. The library's `Card` paints no shadow and exposes no elevation prop, so a document sat as a hairline rectangle with nothing marking it as the thing you came to read — measured, this pane was the only content on screen and used 43% of the available height with 292px of dead space under it. Verified live: the card resolves `rgba(15,23,42,.05) 0 1px 1px, rgba(15,23,42,.05) 0 2px 6px` — the two-layer token, which also now has a night value. A `Card elevation` prop is queued so this stops being a per-call-site decision.

Correction to an assumption worth recording, because it was wrong in an interesting way: the Prompts rail looks impoverished — nine flat items, no nesting, no sync control — and that is the DATA, not the component. Read live from `/api/assessment/knowledge/tree`: `prompts`, `rules` and `enterprise_context` are `kind: 'local'` (they ship with the accelerator, no remote), while `confluence-eng` is `kind: 'synced'`. On Workspace, which renders that synced section, the same `TreeView` shows a real nested tree with expand/collapse carets (SDLC Assessment Program › Rubric Overview / Team Playbooks / FAQ), a **Pull** button, an Activity rail with a count, reactions and Comments. So nesting, expand/collapse and sync all exist and are offered exactly where a remote source exists. What genuinely does NOT exist: drag-and-drop reparenting (the library's `TreeView` has `onReorder`, but the middleware has no move endpoint — wiring it would lose the move on refresh) and inline rename (absent from the library entirely). Both queued. Re-audit 2026-09-18 01:30 — `knowledge/DocPane.tsx` moved this log's digest, for an error state that never said what went wrong. `assessment-knowledge-docs` had no `error` branch (the SECTIONS fixture beside it always did), so a failed tree read was auditable while a failed DOCUMENT read was not — the rail could report a failure and the pane it opens into could not be made to. With the branch added and pinned, the pane rendered a warning triangle, the document's NAME in red, and its id — and no sentence saying what had happened. Cause: `ErrorState`'s `body` and `description` are ALIASES for one slot (the `.d.ts` says so: "Alias for `body`"), this call site passed BOTH, and the id won, silently dropping "Couldn't load this document." A repo-wide sweep found this was the only call site passing both. It now reads title "Couldn't load this document" with the document and id as the body, which is also the shape every other error state in the app uses — a red document NAME reads as "this document is an error" rather than "we could not fetch it". Verified live. Console errors 0. Re-audit 2026-09-18 02:15 — the comments drawer, opened and used for the first time rather than read about. It is the library's `ChatPanel` (from `social`, not the unbuildable `doc-editor` subpath), and it was wired with almost none of what that component offers. Two fixes. (1) The panel could not answer "is this comment mine": `currentActor` — a legacy DISPLAY-NAME fallback whose own prop doc says "a display name is not an identity, and deciding ownership from it gave two participants named Alex a cancel button on each other's uploads" — was being handed the session `sub`, while `currentUserId`, the actual identity prop, was passed nothing. Swapped: `currentUserId` takes the sub, `currentActor` takes the display name. (2) The empty state read "No messages yet", which is both the bare default `emptyState` exists to replace (its prop doc says so outright) and the wrong noun on a document. It now names the document — "No comments on this document yet / Comments are attached to <title> and everyone with access to it sees them…" — verified live on Rubric Overview.

What is NOT wired, and why it is not a component gap: `ChatPanel` also offers `onReply` (threading), `reactionsFor`/`onToggleReaction`, `onEditMessage` and `onDeleteMessage`, each documented as "presence of this enables the control". `POST /api/assessment/knowledge/doc/comment` accepts `{ id, body }` and nothing else — no `parentId` for a reply to point at, no reaction table, no comment id to address for an edit or delete. Wiring those controls today would put affordances on screen the API cannot honour, so they stay off; the order is backend first, and the panel lights them up with no new component work. Written into docs/assessment-tenant.md. The composer still reads "Type a message…" — `ChatPanel` exposes no prop for that hint text, and the only escape is replacing the whole composer, so that one is queued rather than hand-rolled. Re-audit 2026-09-18 04:05 — the document header reads as a sheet now, not a data card. It used to put the classification INLINE after the title as a stock `info`-blue chip, so a label and a name shared one line and neither was the first thing read. The reference DocView this surface mirrors (~/Projects/agentic-assessment-accelerator, ui/src/components/knowledge/DocView.tsx) reads top-down: a tinted uppercase kicker saying what kind of thing this is, then a large title, then a rule, then the body. Same order here now, built by re-arranging library components — Chip's own `uppercase`, DetailHeader, Stack, Divider — not by hand-rolling a pill.

The kicker is tinted with the TENANT's brand rather than a stock tone, which is the part that makes it read as this product: measured live, background `rgb(220,237,234)` (`--color-brand-soft`) with `rgb(11,58,58)` text (`--color-brand-ink`, the SDLC deep base) at 10px/600 uppercase — **10.32:1**, comfortably AA, and it swaps per tenant and per theme because both are theme tokens. `ChipTone` has no `brand` member (neutral/success/warning/danger/info/caution/accent, and `accent` renders violet, which inside a teal tenant is another product's colour), so this took a `className` — queued, because a className fighting a `tone` prop is not a pattern other consumers should copy. Console errors 0.

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
