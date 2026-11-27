# Ledger of open work

First written 25 November 2026 after a read-only sweep of the portal and every repository in its dependency chain, and brought up to date on 27 November after two days of working it. This is the single list of what is open. Each row was checked against the code, the git history or the CI runs when it was written, not copied from older notes. [next-steps.md](next-steps.md) stays as history and as the record of decisions; where the two disagree, this file is the newer one.

Keeping it: when a row is done, delete it and name the row id in the commit message. When something new turns up, add a row with its evidence. Sizes are S (an hour or two), M (a day), L (several days).

## Where things stand (27 November)

- **`main` is green.** Four CI runs in a row passed on 27 November; before 26 November it had no green run in its last 60. Nothing is pushed while a run is in flight, because a push cancels it.
- **Candidates tenant: the audit's blocker and most of its major gaps are built and seen on a screen.** Cancel, no-show and withdraw; the recruiter's stage moves; the runner note; the waiting-candidate bell and a panel member's admit; private notes and server-side drafts; scheduling warnings, the Missed label and the overdue reminder; five smaller fixes. Two headless walks (journey pieces G1 and G2) cover them and found three defects, all fixed. Not yet walked: the scheduling screens, and the panel member's admit, which needs a real gateway.
- **Unmerged work is down to two side worktrees**, in pipeline-runtime and ui-components (B-3, B-4), uncommitted and untouched since midday on 25 November. The film branch and the cloud branch are merged, and the pins are level: ui-components 2.546.0, and realtime-modules 0.151.0 in both the middleware and the frontend.
- **No dependency repository has moved since 25 November**, and none of the private ones has executed a CI job since 11 November (CI-1).
- **Milo's rebuild is half landed**, as before: phases 0 and 1 are on `main` and the text judge passes both sets, but the turn owner is off by default, none of the planned deletions happened, and phases 2 and 3 have not started. Films 7 and 8 are delivered.
- **A deck builder is planned and not started** (K-1). Its research found two things worth fixing whether or not it is built: deck drafting was unmetered (fixed on 27 November for three tenants; P-12 holds the fourth) (the second, bullets over 200 characters being silently dropped, was fixed on 27 November).
- **91 rows are open:** Candidates 20, dependency repositories 14, Milo 13, platform and money 12, CI 9, meeting assistant 9, branches 4, voice 4, UI library 3, documents 2, planned 1.

## Closed since the first sweep

For orientation only; the commits name the row ids.

- **26 November:** the film branch merged (B-1); the portal's four CI failures (CI-3 to CI-5 and the stale half of CI-2); both pin bumps (D-1, and the adoption half of D-2); the cloud branch merged, with one function choosing the code runner (B-2, C-19); cancel, no-show and withdraw (the built part of C-1).
- **27 November:** the recruiter's stage moves and the no-hiring-manager warning (C-2); the runner label (C-3); the waiting-candidate bell and the panel member's admit (C-4); the demo director's real race, which exposed P-11. Overnight into the 28th, in seven pushes that each passed the merge check and CI: the merge check as one command (CI-11); the two walks and their fixes; deck bullets (K-2); an interviewer no longer receives a candidate's contact details, and Milo's listening side checks consent on every frame (C-18's first item, M-9); deck drafting holds spend in three tenants (most of P-12); five small Candidates rows (C-10, C-12, C-13, C-14, C-16); the README's tenants and document map (H-2, H-4, C-20); notes and drafts (most of C-5); scheduling (most of C-17).

## Next, in order

### Finishing what is in flight

1. **The panel member's admit, against a real gateway.** The walk (piece G1) now covers the rest of C-1 to C-4 and found two defects, both fixed on 27 November; the admit cannot be walked in the mock world because presence comes from live sockets.
2. **CI-2.** The merge check is one command now (`scripts/merge-check.sh`); the voice inventory still goes stale whenever a line number moves.

### Then, work that needs nobody else

3. **Money.** P-11 (a reply's hold counted twice) and M-5 (Milo's transcription, speech and Decide spend unmetered), then the assessment half of P-12. P-11 changes a money rule and was left for the owner to see first.
4. **Candidates, what is left of the audit.** C-6 (reaching the candidate), C-11 (candidate accessibility) and C-7 (one role per person); C-8 and C-9 wait for the notice wording (C-27). A walk for the scheduling screens, and judge rows for the week's work (C-22 to C-24).
5. **Deck builder (K-1).** The two-day PDF spike that opens its phase 1 can start now, since it only produces knowledge. Phase 0 starts once the plan's decisions have been read.
6. **Milo (M-1 to M-3).** The audio gate, then the turn owner as the default, then the phase-1 deletion, which also stops paying for the unused speech-to-speech session. CI-10 alongside.
7. **Documents (H-1).** The README's tenants section and map of the documents, the scripts README and the interviews plan's status line were done on 27 November; what is left is striking the stale lines in `next-steps.md`.
8. **One ui-components batch (U-1, U-2, C-26, M-11, M-13)**, after B-4 has landed, since both would claim the next version number.

### Needs the owner

- **CI-1** Actions on the private repositories. It blocks D-7 and leaves four repositories verified locally only.
- **B-3, B-4** The two side worktrees: commit and push them, or say that this lane may. About 3,600 lines of pipeline-runtime and eleven ui-components source files exist nowhere else.
- **K-1** Read the deck plan and overrule any of its twelve decisions.
- **P-8, P-9** The parked decisions. The standing rule is decide, record, implement, so one pass can make most of them; the commit address and any rewrite of history are the owner's own.
- **C-27, C-15, C-1** The candidate notice wording, whether the panel confers in the product, and whether a round should start on first admit (the films rely on the lead's join starting it).
- **The deploy machine.** Pull `main`: it holds the merged cloud branch, so `origin/infra-interviews-milo-cloud` can go. Write the deployed-state paragraph (P-1), build the social images from the new pins, and read the CDK package diff (D-3).

## Branches and unmerged work

| Id | Item | Evidence | Status | Next action | Size |
|---|---|---|---|---|---|
| B-3 | pipeline-runtime: a new `/local` subpath (a SQLite-backed local job queue with lanes, gates, leases and a supervisor; changelog entries 1.9.0 and 1.9.1) is uncommitted in a side worktree and already in use from a packed tarball. `main` is still 1.8.1. | Worktree branch `handbuilt-local-jobs`, no upstream: `src/local/`, `test/local/`, `CHANGELOG.md` "[1.9.1] — 2026-11-25" | Uncommitted; untouched since midday on 25 November | Commit and push the branch now, then merge and tag 1.9.1 so the consumer stops depending on a side tarball | M |
| B-4 | ui-components: the Loops-page primitives are uncommitted in a side worktree: spacing fixes in `MarkdownView`, `MetaLine` and `ConnectionPill`, plus `StopCircleIcon` and `RelaunchIcon`. The work is based on 2.543.0 and labelled 2.544.0, a number `main` has since given to a different release; six of its files also changed on `main`. | Worktree branch `loops-page-primitives`, no upstream, base `d619f3581`; `main`'s 2.544.0 is `b5f2ac9bf` | Uncommitted; untouched since midday on 25 November | Rebase onto 2.546.0, renumber to 2.547.0, merge the six overlapping files, commit and release | M |
| B-5 | ui-components `main` has parked local changes: `.storybook/main.ts` points Storybook at an untracked `reference-sheets/` folder (728 files, 85 MB of design reference images). | Both dated 20 November; nothing upstream touches them | Parked | Decide: keep the sheets out of the public repository and revert the Storybook line, or commit the stories without the images | S |
| B-6 | Finished leftovers: the portal worktree on `codex/interview-tenant-fixes` (contained in `main`); the remote branch `origin/infra-interviews-milo-cloud` (merged on 26 November); a ui-components release clone on `t49-second-release` (level with `main`); three ui-components stashes from 2 November on `codex/huddle-prejoin-redesign`, one labelled as already integrated. The portal's main checkout also still sits on a branch named `codex/milo-coding-film`, level with `main`. | `git worktree list`, `git branch -r`, `git stash list` in each repository | Finished or stale | Each owner removes its own; switch the checkout to `main`; nothing to merge | S |

## CI and checks

| Id | Item | Evidence | Status | Next action | Size |
|---|---|---|---|---|---|
| CI-1 | Actions does not start jobs on the private chain repositories: realtime-examples, pipeline-runtime, distributed-core, service-runtime. Every run since 11 November is red without executing. | Latest `main` runs of 11 to 18 November in each repository | Open, account-level | Owner restores Actions for private repositories, then re-runs the latest `main` run in each; expect first-run failures to fix | S (owner) |
| CI-2 | The voice inventory check marks a route stale whenever its line number moves, so every merge needs a recapture (recaptured on 26 November). | `scripts/voice/inventory.mjs:789-790` | Open | Key the check on method and path and drop the timestamps | S |
| CI-6 | platform-api's latest run died in `npm ci` while preparing a git dependency; no test ran. The two runs before it were green. | Run of 19 November on `e029313` | Cause unverified | Re-run once; if it repeats, check the dependency token against the private repositories | S |
| CI-7 | The portal's CI dependency token is the owner's CLI token, so logging out revokes it. | `docs/next-steps.md:455` | Unverified | Swap in a dedicated token and record it | S |
| CI-8 | `scripts/check-search-writers.mjs` fails with nine writers that never call the search hook (two on 7 November), among them the thread writers in `social-chat.ts` and `setBotEssential` in `bots.ts`. | Run on 25 November | Open | Hook or exempt each with a reason, then add the check to CI so the count cannot grow | S |
| CI-9 | Three kept validators were failing on real debt on 7 November and were not re-run: route coverage (11 untested routes), component discipline (raw styled elements over budget), mock floor (stale wire snapshots). | `docs/next-steps.md:31-33` | Unverified | Run each with `--quick`, record the counts, then burn down or delete | M |
| CI-10 | The Milo text judge is not in CI. | `.github/workflows/ci.yml`; `docs/milo-rebuild/REBUILD-PLAN.md:100` | Open | Add an offline judge job with the stand-in decide; the live run needs a key and stays manual | S |
| CI-12 | Failures seen once each on 26 and 27 November and not since: the portal's `npm ci` died compiling a native module inside a git dependency (the same failure as CI-6), and `json-body.test.ts` answered 404 for a board snapshot in one full local run. | CI run on `92071b525`, shard 1; a local full run of 27 November | Unverified | Record a second sighting here and fix it then | S |
| CI-13 | The interviews journey's own self-check fails two of its steps before any piece runs: a guest at a staff route answers 401, and one refusal table expects 403 where the route answers 401. | `npm run journey:interviews -- --harness-check` (steps H0.b, H0.i), run on 27 November | Open | Decide which is right, the route's 401 or the table's 403, and make them agree | S |

## Candidates tenant

Fourteen items in the plan and the audit have closed since they were written and are not listed. `mw/` below is `middleware/src/` and `pt/` is `portal/src/`.

### Hiring-loop gaps (from `docs/audits/candidates-gap-audit-2026-11-20.md`, each re-read in the code)

| Id | Item | Evidence | Status | Next action | Size |
|---|---|---|---|---|---|
| C-1 | Cancel, "did not take place", withdraw and the recruiter's End were built on 26 November. What is left of the audit's blocker: a round still starts when the lead opens the room, not when the candidate is first admitted; "Did not take place" is missing from the My interviews list; the new pages have not been looked at in a browser; the new Postgres case has not run; no judge row or walk covers any of it. | `mw/lib/interviews/cancel.ts`; `mw/routes/interviews/cancel.ts`; `pt/pages/interviews/RoundCloseDialog.tsx`; audit section 1 | Partly | Walk the four actions once in the mock world; decide start-on-admit together with the films, which rely on the lead's join starting the round | M |
| C-2 | The recruiter's stage moves (start screening, mark hired, offer declined, reopen) and the no-hiring-manager warning were built on 27 November. Left: the new screens have not been looked at in a browser, and no judge row or walk covers them. | `mw/lib/interviews/stage-moves.ts`; `mw/routes/interviews/stage-moves.ts`; `pt/pages/interviews/StageMoveDialog.tsx`; audit section 2 | Partly | Walk the four moves and the warning once in the mock world, with C-1's screens | S |
| C-3 | The pad says when its runner is simulated or not set up, for both seats, in a line over the output; Run stays alone in the toolbar. Seen at 1440, 1280, 900 and 390 pixels by the walk. The runner is still not chosen automatically, on purpose. | `pt/pages/interviews/pad/PadRunControl.tsx`; `scripts/journeys/interviews/G1.mjs` step G1f | Partly | Decide whether a developer's machine should pick the Docker runner by itself; otherwise close | S |
| C-4 | The first knock now rings the lead and the panel, a panel member in the call can admit while the lead is not in it, and the candidate reads "told" only when someone was (27 November). Left: not looked at in a browser; "bell sent" is remembered in memory and falls back to the inbox after a restart; no judge row or walk. | `mw/lib/interviews/waiting-room.ts`; `mw/routes/interviews/admission.ts`; `mw/lib/call-chat.ts` (`usersInLobbyCall`); audit section 4 | Partly | Walk a knock with the lead absent once, with a real gateway, since presence comes from live sockets | S |
| C-5 | Private notes in the room and server-side scorecard drafts were built on 27 November and seen by the walk (piece G2). Left: "Stop correcting" clears only the browser's draft copy, since there is no delete route. | `mw/routes/interviews/private-notes.ts`; `pt/pages/interviews/room/NotesTab.tsx`; audit section 5 | Partly | Decide whether a draft needs a delete | S |
| C-6 | The candidate is reached only outside the product: no page shows their contact details, there is no edit route, and they cannot decline a time. | `mw/routes/interviews/candidates.ts`; audit section 6 | Open | Show and edit contact details; a copyable invitation message; a candidate-side "I can't make this time" that bells the recruiter | M |
| C-7 | One role per person at a time: only holders of `interviewer` can be seated. | `mw/routes/interviews/assignments.ts:57-62`; audit section 7 | Open | Derive reach from all of a person's grants in the tenant, or let a hiring manager or recruiter hold a seat | M |
| C-8 | Milo reads speech only. The recap, coach and plan see no résumé, pad or run results; one question has expected values; there is no tool to set the pad language, run code, move to the next question or write on the board. Since the audit he reads the board as text and his probes join the recap timeline. | `mw/lib/interviews/recap/prompt.ts:13`; `mw/lib/interviews/coach/prompt.ts:19`; `mw/lib/interviews/milo-tools/references.ts:46`; audit section 8 | Partly | Give the recap the final pad snapshot, run results and board text as citable sources; extract résumé text at upload; add a reference solution to kit questions; then the missing tools | L |
| C-9 | "Milo recommends" is computed in the browser only, is not stored or exported, and contradicts the one published notice version. | `pt/lib/interviewsMiloAdvice.ts`; `mw/lib/interviews/consent/notice.ts:21,27`; audit section 9 | Open | Compute it on the server, store what was shown with each scorecard version, show it on the debrief and the export, publish a matching notice version (C-27) | M |
| C-11 | Candidate accessibility: no transcript or captions for the candidate, and the door is walked at two desktop widths only. | `pt/pages/join/JoinRoom.tsx:8`; `scripts/journeys/interviews/E3-door.mjs:26`; audit section 11 | Open | Offer live captions when the candidate accepted the transcript; walk the door at phone width and by keyboard | M |

### Smaller gaps

| Id | Item | Evidence | Status | Next action | Size |
|---|---|---|---|---|---|
| C-15 | The panel cannot confer in the product: discussions and huddle chat are off for the tenant. | `tenants/manifest.json:94-95` | Open | Decide; if yes, turn discussions on for the debrief only | S |
| C-17 | The double-booking warning, the Missed label and the overdue-scorecard reminder were built on 27 November. Left: not seen in a browser; a missed round still counts as the candidate's "next interview" on the Candidates list. | `mw/lib/interviews/conflicts.ts`; `mw/lib/interviews/missed.ts`; `mw/lib/interviews/overdue-sweep.ts` | Partly | Add the three to a walk; decide what "next interview" shows for a missed round | S |
| C-18 | Three small audit items, re-read on 27 November and still true: a new opening's kit starts empty with no way to copy another's, Milo has one setting per interview, and the candidate `notes` field is stored and shown nowhere. (The fourth, the profile read handing an interviewer the candidate's contact details, was fixed that day.) | `mw/routes/interviews/openings.ts:103`; `mw/lib/interviews/milo-settings.ts`; audit "Minor" | Open | Copy a kit from another opening; show or drop `notes` | S |

### Delivery and coverage

| Id | Item | Evidence | Status | Next action | Size |
|---|---|---|---|---|---|
| C-21 | A workaround for media ids cut at a colon can probably go; the fix is in realtime-modules 0.151.0. | `pt/lib/callTileMerge.ts:1-8`; realtime-modules `d5d0f77` | Partly | Confirm the installed build keys remote media by the full id, then delete the file and its test | S |
| C-22 | Milo's tools have a judge row and no judge piece. | No `I3.11` file in `scripts/validate-interviews.d/` | Open | Write the piece | S |
| C-23 | The judge and walks do not cover the whiteboard round end to end (draw, checkpoint, reveal, playback), the call chat unread and call float walks (files exist, no rows), or `POST /interviews/:id/milo-intro` (no test). | `scripts/validate-interviews.sh`; walk files `C1`, `C3` | Open | One whiteboard walk and its row; add the two rows; one route test | M |
| C-24 | Shipped since the audit with unit tests only: `ask_probe`, the pad confirmation and the board outline. | Commits `49db8197f`, `22256caef`, `379346511`, `da3a0929a` | Open | A judge row each, or one walk covering the three | M |
| C-25 | The real-Postgres and real-Docker suites are off by default; 35 tests were skipped. | `mw/lib/interviews/__tests__/interviews-postgres.test.ts:32`; `mw/lib/interviews/runs/__tests__/docker-executor.real.test.ts:16` | Open | Run both once and record the counts | S |
| C-26 | Thirty-three look findings owned by the library are accepted, not fixed: contrast tokens, the dock at 900px, `SplitPane` rounding, marker spacing. | `scripts/validate-interviews.d/E3.findings` | Open | Fix in ui-components with U-1, then delete the rows | M |
| C-27 | Owner decisions still open: the candidate notice wording and Milo's three prompts; 401 or 403 for a guest at the tenant gate; a star rating input (queued for the library). | Plan lines 205, 213, 259 | Open | Decide with P-8; one new notice version covers the wording and C-9 | S |

## Milo and the films

Recorded and reported: the phase-1 board film, film 3 (board, name required), film 5 and film 6 (coding; the owner rejected film 6 as incoherent), then film 7 (coding, take 8, 6:13) and film 8 (system design, take 3, 3:55), each with 28 checks. Not recorded: a Work huddle film, a Social room film, and the plan's five unscripted minutes with the owner.

| Id | Item | Evidence | Status | Next action | Size |
|---|---|---|---|---|---|
| M-1 | The audio gate (the plan's second gate) is not built: what was heard equals the logged row, latency p50 1.5 s and p90 2.5 s, barge-in stop within 0.7 s. | `docs/milo-rebuild/REBUILD-PLAN.md:107`; no audio script under `scripts/milo-judge/` | Open | Build it on the harness clips through the turn owner; set the latency number from measurements | M |
| M-2 | The turn owner is off by default. Interviews still run the old hands-free path unless `MILO_TURN_OWNER=1`. | `middleware/src/lib/meeting-assistant/turn/turn-owner.ts:55-57` | Open | Make it the default for interviews once M-1 is green; record the decision | S |
| M-3 | The phase-1 deletions did not happen: the old router, rules, talking, runtime, held hooks and gate all remain, and the unused speech-to-speech session is still opened, kept alive and billed. | `docs/milo-rebuild/REBUILD-PLAN.md:84`; files under `middleware/src/lib/meeting-assistant/handsfree/` | Open | One deletion commit after M-2; it also removes the keepalive spend | M |
| M-4 | Latency: every live turn takes 2.5 to 4.4 s and no film met 3 s. Film 7's measured gaps were 3.74 s and 2.48 s. Most of it is the wait for the finished sentence. | `docs/milo-rebuild/FILM-PHASE1-REPORT.md:64-73`; `FILM-3-REPORT.md:54`; film 7 report on the film branch | Open | Measure end-of-turn detection first. The standing steer is correct over fast, so this is a measurement and a decision, not a tuning sprint | M |
| M-5 | Transcription seconds, text-to-speech characters and Decide tokens are not metered into the per-user budget or the interview cap. | Audit finding F8; nothing in `middleware/src/lib/meeting-assistant/spend.ts` or `middleware/src/lib/voice/ledger.ts` | Open | Money item: do it with or before M-6 | M |
| M-6 | Phase 2: Work and Social on the turn owner (shared act, default policy, social policy), then delete the room-mix path; one Work huddle film and one Social room film. | `docs/milo-rebuild/REBUILD-PLAN.md:86-94`; only `interviews/milo-policy.ts` registers a turn policy | Open | Start after M-3; the largest remaining Milo package | L |
| M-7 | Phase 3: split `orchestrator.ts` (2,886 lines), move `handsfree/*` into `turn/`, amend decision 9 in the interviews plan. | `docs/milo-rebuild/REBUILD-PLAN.md:96-102` | Open | After M-6 | M |
| M-8 | A split request is acted on before its second half arrives; only the model's `keep_listening` prevents it. | `docs/milo-rebuild/DECIDE-BAKEOFF.md:88` | Open | Add the code rule: nothing is done until the asker has been quiet since the sentence ended | S |
| M-10 | The "talking to Milo" tile ring is missing on both seats during a hold. | `docs/milo-rebuild/FILM-3-REPORT.md:56`; wired at `portal/src/components/shell/ShellCallHost.tsx:206-209` | Open | Find why the floating gallery loses it; library first if the tile needs a prop | S |
| M-11 | Library workarounds remain: the board fit strips a toolbar class inside the canvas library, and one test-id restyle is left. | Audit finding F12; `portal/src/lib/interviewsBoard.ts:168-173`; `portal/src/components/calls/RoomCallGallery.tsx` | Partly | Ship a `fit` prop on the canvas in ui-components, then delete the workaround | M |
| M-12 | The delivered films and their handoff note live in a folder outside the repository, and two reports cite it by a home-relative path. | Film 7 and 8 reports on the film branch | Open | Decide where delivered films live (a release asset or a private bucket) and replace the paths | S |
| M-13 | The scorecard's rating form has six advisory findings: placeholder contrast 4.2:1 and label baseline alignment. | Film 7 report on the film branch | Open | Fix in the library's form field tokens | S |
| M-14 | Undocumented settings: `TRANSCRIBE_MODEL`, `MOCK_TOOL_GAP_MS`, `HF_GATE_TX_QUIET_MS`, `MILO_TURN_OWNER`, `MILO_DECIDE_MODEL`, `MILO_PAD_WRITER_LIVE`, `INTERVIEWS_RECAP_MODEL`. | Audit finding F14; found only in code and the audit | Open | One table of settings in the README or the Milo docs | S |

## Platform, deploy and money

Cloud work happens on another machine, so the deploy rows could only be read from the documents, not checked.

| Id | Item | Evidence | Status | Next action | Size |
|---|---|---|---|---|---|
| P-1 | No document records a deploy since 26 and 27 October. The owed list stands: middleware image, call smoke test, devbox stack, page-thread migration, access tenant schema. | `docs/next-steps.md:55-63`, `:451` | Unverified | Get the current state from the deploy machine and write one dated "deployed state" paragraph | M |
| P-2 | The signed-request replay table is built and wired but not deployed. Foundation must deploy before the runtimes and the middleware. | `docs/next-steps.md:123`, `:803`; `infra/SECURITY-NOTES.md` | Open | Part of the next deploy | S |
| P-3 | The knowledge base's per-tenant data sources need their migration run: replace the data source, backfill tenant metadata, re-ingest. | `docs/next-steps.md:125` | Open | Part of the next deploy | M |
| P-4 | The microVM runner's fixes from its first real deploy are merged, but its design document still reads as built and unproven in places. | `docs/microvm-runner-design.md` section 16 | Partly | Rewrite section 16 with what the deploy proved; the deploy machine knows | M |
| P-5 | Budgets on real spend: `next-steps.md` says real metering of every model dollar is not built, but the spend ledger and agent usage emission have landed since. | `docs/next-steps.md:81`; `docs/spend-map.md` (last changed 8 November) | Unverified | Reconcile the spend map with the ledger code and state what is still unmetered; M-5 is a known gap | M |
| P-11 | Answering an agent's question takes a second spend hold on the same sprint envelope, "held for visibility" because the run's own hold already covers the money. It still counts toward the envelope's hard cap, so a person's reply can make the next piece of work be refused (403) for money that is not really in flight twice. The demo director now answers only after the next pickup is judged, which hides it in the demo and not in real use. | `middleware/src/routes/devbox.ts:748-770`; `middleware/src/lib/spend-holds.ts:433`; `middleware/src/mock/demo-director.ts` | Open | Decide: exclude a covered reply's hold from the held sums, or hold it at zero; a money rule, so a deliberate change with tests | M |
| P-12 | Assessment review decks are still drafted with no spend hold; the other three tenants' deck drafting and revision were put behind one on 27 November. The assessment draft runs as an asynchronous agent run with only a concurrency cap, and a hold there would have to span the dispatch for every assessment command. A revise refused for budget now answers with a `reason`, which no page shows yet. | `middleware/src/lib/assessment-dispatcher.ts:67`; `middleware/src/lib/deck-shared/spend.ts`; `docs/spend-map.md` | Partly | Meter the assessment dispatcher as its own change; show the revise reason in the deck editor | M |
| P-6 | One 1-vCPU middleware task is CPU-bound near 100 calls and 1,000 sockets, and no option has been chosen. | `docs/next-steps.md:75` | Open | Decide between a larger task, a smaller advertised profile and the multi-node router; record it | S |
| P-7 | `k8s/crds/middleware-workload.yaml` ships `REPLACE_ME` for the signing secret and policy store, and the media server's metrics scrape needs a token. | `k8s/crds/middleware-workload.yaml:30-38`; `docs/next-steps.md:458` | Open by design until a cluster exists | Leave; note it in the deploy runbook | S |
| P-8 | Owner decisions parked on 10 November and never recorded as decided: history rewrite, the registry prefix default in `scripts/build.sh`, back-publishing old library versions, program-owner scope on budgets and grants, who edits SDLC policies, who sees the guardrail editor, the steward check on work-item comments, whether leaders may retry a failed run. | `docs/next-steps.md:67-73`, `:765`, `:810`, `:1042` | Open | One high-effort pass that writes each decision into section 9 of `next-steps.md`, then implements it | M |
| P-9 | Privacy in the public repository: account ids remain in eight tracked `infra/` files, one tracked spec holds a machine path, and commits on `main` carry an author address on a local hostname (git has no email configured on the build machine). | Audit finding F13; `docs/next-steps.md:809`; `portal/e2e/_tmp/shot.spec.ts` | Open | Move the ids to untracked config, delete `portal/e2e/_tmp/`, set the commit email to the noreply address; decide on history | M |
| P-10 | A fresh clone still needs access to private dependency repositories or the vendored tarballs. | Audit finding F7; `portal/vendor/` | Open | Follows from the library releases; restate once the pins are level | M |

## Voice navigator

Built and hardened through 10 November; nothing has changed since the interviews work began.

| Id | Item | Evidence | Status | Next action | Size |
|---|---|---|---|---|---|
| V-1 | The capability catalogue is 652 characters under the context-window limit, so the next capability has to trim first. | `docs/voice-navigator-gaps.md` "Coverage (10 November)"; `portal/src/lib/voice/__tests__/contextWindow.test.ts:129` | Open | Trim or split the catalogue per tenant before adding Candidates or access capabilities | M |
| V-2 | Three catalogue gaps: decision records are found only by a naming convention, the bell's entries have no read route of their own, and a runbook is still called a "document" in one knowledge search line. | `docs/voice-navigator-gaps.md` "Coverage (10 November)", Open | Open | Three small fixes | S |
| V-3 | No real session has run in a deployed environment, and the four and a half silent minutes of 9 November have no proven cause. | `docs/next-steps.md:460`, `:767` | Open | Cloud-side; diagnostics are in place for the next occurrence | S |
| V-4 | No voice document mentions the Candidates, access or pipelines tenants, so whether the navigator is offered there is undocumented. | `docs/voice-navigator-spec.md` | Unverified | State the position per tenant in the spec | S |

## Meeting assistant and learning loop

The learning loop is done. The meeting assistant outside interviews is merged with its flag off and still on the old room-mix path; what remains is mostly proof against real things.

| Id | Item | Evidence | Status | Next action | Size |
|---|---|---|---|---|---|
| A-1 | The paid proof of the old voice gate never ran. The key has worked since 19 November, but phase 2 of the rebuild replaces that gate. | `docs/meeting-assistant-audit.md` "Still open"; `docs/next-steps.md:1077` | Open, about to be superseded | Do not spend on it; strike it when M-6 lands | S |
| A-2 | No real multi-person call outside interviews has run on the current code; the echo guard is unproven on a long call and the attribution fix has not been seen live. | `docs/next-steps.md:1079`, `:1089` | Open | Hold one real call after M-6, not before | M |
| A-3 | The watcher's one-cent model check has not run because credentials had expired. | `docs/next-steps.md:1079`; `scripts/meeting-assistant/watcher-check.mjs` | Open | Run it when credentials are valid on the build machine | S |
| A-4 | The SQL stores have never run against a real database; the statements were checked as text only. | `docs/next-steps.md:1091` | Open | Run the store suite once against the local Postgres container | M |
| A-5 | Private answers stay in the asker's inbox after a record is deleted, because the notification service has no delete. | `docs/next-steps.md:1092` | Open | Add a delete to the notification service, then call it from erase | M |
| A-6 | Package 8: joining scheduled rooms on its own, a real media participant, minutes from the recorded transcript. | `docs/next-steps.md:1093` | Open | Not before M-6 | L |
| A-7 | Small leftovers: unit-test-only paths with no walk step, "Create work item" pressed twice across two servers, the meeting page missing from the DOM audit's route list, the proposal bell wording, the call bar `truncate` workaround. | `docs/meeting-assistant-audit.md` "Still open" (third sweep) | Open | Batch into one cleanup lane | M |
| A-8 | Films that were asked for and not made: document collaboration, the whiteboard, and the access tenant with live cursors. | `docs/next-steps.md:1081` | Open | The film tooling is on `main` now; schedule when wanted | M |
| A-9 | The mock world has no ledger entry with an unknown cost and fewer runs than one page, so two walk assertions only run "when present". | `docs/next-steps.md:1041` | Open | Add one unknown-cost row and enough runs to the mock world | S |

## UI library

| Id | Item | Evidence | Status | Next action | Size |
|---|---|---|---|---|---|
| U-1 | Nine queued composites are still worked around in the portal: the "Demo data" mark, a wrapping `DataTable` column, a typed `table` prop through `CollectionPage`, a read-only document without a fixed-height parent, a `ChangeReviewCard` confirmation step, a `ConfirmDialog` body node, the evidence line, a single `ComputerWorkspace`, and the mock shell wording. | `docs/ui-components-queue.md`; `portal/src/pages/iq/RunPage.tsx:159,262`; `portal/src/pages/computers/ComputersPage.tsx:300` | Open | One batched library release, then adopt; never one release per row | L |
| U-2 | Four library-first items are missing from the queue file: a canvas `fit` prop (M-11), the call bar `truncate` drawing a flex box, the form placeholder contrast (M-13), and two-line titles in the Decisions list. | Audit finding F12; `docs/meeting-assistant-audit.md`; `docs/next-steps.md:802` | Open | Add the four rows to the queue file so one release can take them | S |
| U-3 | Two layout findings from the walk of 27 November, both older than that week's work: on the scorecard the red-flag checkboxes sit at the far right edge of a full-width row, a screen away from their labels; and at 900 pixels the prepare page squeezes the plan into a narrow column beside the résumé viewer. | Journey piece G2, steps G2c and G2f; `pt/pages/interviews/ScorecardPage.tsx`; `pt/pages/interviews/PreparePage.tsx` | Open | Put each checkbox beside its label (a library checkbox row if `Checkbox` has no label-first form); stack the prepare page below a width | S |

## Dependency repositories and pins

Since 11 November only ui-components (2.546.0), realtime-modules (0.151.0), platform-api, realtime-examples and pipeline-runtime (1.8.1) moved. event-catalog, distributed-core, service-runtime, message-queue and managed-nosql-store are quiet, clean and level with their remotes.

| Id | Item | Evidence | Status | Next action | Size |
|---|---|---|---|---|---|
| D-2 | ui-components 2.546.0 is adopted; its smaller `CatalogGrid` default gap (20px to 16px) has not been looked at on the two pages that use the default. | `portal/src/pages/ScoresCohortPage.tsx:43`; `portal/src/pages/SelectContextPage.tsx:426` | Open | Look at both pages once and re-run the DOM audit | S |
| D-3 | The portal's vendored CDK construct package is 0.1.0; its source in realtime-examples is 0.2.0. | `infra/package.json:14`; realtime-examples `cdk/package.json` | Impact unverified | Read the diff before the next cloud deploy and re-vendor if the stacks need it | S |
| D-4 | Local images for the `social` compose profile predate the 25 November pull, so the local gateway lacks the two guest-isolation commits; the three `document-workspace` images were also removed from the local machine on 25 November. | `docker-compose.yml:136`; realtime-examples `18bff74f`, `3db0a544` | Open | Rebuild through `node scripts/social-documents.mjs up` | S |
| D-5 | platform-api has 17 commits since 0.1.8 with no version, including mid-call interview recording and the captions shared secret. | platform-api `CHANGELOG.md:6` "Unreleased"; head `e029313` | Open | Cut 0.1.9, or 0.2.0 because `refresh-token` stopped forwarding `role`; re-run CI | S |
| D-6 | platform-api pins pipeline-runtime 1.5.3 and realtime-modules 0.146.5, so it lacks the 1.8.x approval fixes (a waiting run survives a restart and stays approvable). | platform-api `package.json:28-29` | Open | Move to 1.8.1 and 0.151.0, run the suite | M |
| D-7 | realtime-examples has three guest-isolation security commits that are unreleased and have never run in CI. | realtime-examples `CHANGELOG.md:3` "Unreleased"; `cef92bfe`, `18bff74f`, `3db0a544` | Open | After CI-1, re-run CI and cut 0.2.15 | S |
| D-8 | realtime-examples' own frontend and gateway are behind: realtime-modules 0.148.0 and ui-components 2.522.0. | realtime-examples `frontend/package.json:28-29`, `package.json:58` | Open, not urgent | One bump when the gateway is next touched; the portal uses its own frontend | M |
| D-9 | realtime-modules: a call ends at once when its last two sockets drop together, and the client hook never learns its call is gone after a reconnect. The portal works around both. | `docs/next-steps.md:1098-1101`; `portal/src/lib/useInterviewCallLoss.ts` | Open | Two library changes, then keep the portal's handling as the rare path | M |
| D-10 | live-video-streaming has a list of owner decisions and deploy prerequisites that nobody has acted on: Actions disabled in the repository, the media server's secrets before deploy, node size, webhook signature v2 in receivers, one real transcription, publishing the two client packages, the bucket allowlist, recording defaults. | live-video-streaming's `BACKLOG-PROGRESS.md:190` (in its docs folder), "Needs Connor" | Open since 11 November | Work the list top-down before any cloud deploy of the media server; CI and secrets first | L |
| D-11 | live-video-streaming still lists tap destinations to non-admin callers. | `docs/meeting-assistant-audit.md:96`; `docs/next-steps.md:1090` | Open | Fix in the media server's repository | S |
| D-12 | Bundled UIs carry old library tarballs: live-video-streaming (2.520.0 and 0.147.1) and event-catalog's admin (2.509.0). | Their `ui/package.json` and `src/admin/package.json` | Open, low priority | Re-pack only when those UIs are next changed | S |
| D-13 | Four repositories pin event-catalog 0.10.7, one behind the metrics rate-limit fix in 0.10.8. | Pins at `a045aca` in platform-api, realtime-examples, realtime-modules, live-video-streaming | Open, low priority | The fix is server-side; take 0.10.8 in the next pin round | S |
| D-14 | distributed-core 0.52.0 and service-runtime 0.8.0 are adopted nowhere; every repository pins 0.51.2 and 0.7.3. | Pins at `5ff83f5c` and `6fb67ad` | Open, optional | No consumer needs the SQLite graph store or `superviseWorker` yet; move every repository together when one does | M |
| D-15 | dc-k8s-operator has been dormant since August on distributed-core 0.42.1. | Head `c1f8047d`, 18 August | Dormant | Decide whether it is still on the deploy path; if not, mark it retired | S |

## Documents and housekeeping

| Id | Item | Evidence | Status | Next action | Size |
|---|---|---|---|---|---|
| H-1 | `docs/next-steps.md` is 1,101 lines of dated narrative with open items buried between closed ones. Its status table describes 6 November; it says CI is green, that the access tenant is unfinished and that the microVM runner has never run in the cloud. It has no Milo section. | `docs/next-steps.md:7-18`, `:20-45`, `:74`, `:455` | Partly (it now points here) | Strike the stale lines as their rows here are closed; keep section 9 as the decision record | S |
| H-3 | `scripts/audit-loop/run.sh` points at three files that no longer exist, so it cannot run. | Path check on 25 November | Open | Delete the folder or restore the prompts | S |

## Planned work

| Id | Item | Evidence | Status | Next action | Size |
|---|---|---|---|---|---|
| K-1 | A deck builder: one engine, a layout model with PowerPoint, PDF and image output, themes and kits from the design system, a staged agent pipeline and a deck skill. | `docs/deck-builder-plan.md` | Planned, nothing built | Phase 0 first | L |

## Documents that now mislead

- `docs/next-steps.md`: "Where things stand", sections 1 to 4, and the CI line in section 10.
- `docs/milo-rebuild/FILM-5-CODING-REPORT.md`: its acceptance was withdrawn by the coding film restart note (on the film branch).
- `docs/milo-rebuild/FILM-PHASE1-REPORT.md` and `FILM-3-REPORT.md`: five items in their open lists are fixed.
- `docs/microvm-runner-design.md` section 16: "nothing has run against AWS".
- `docs/voice-navigator-gaps.md` section 4: reads as a plan; all of it is built.
- `docs/interviews-tenant-plan.md` decision 9: the rebuild plan says it must be amended.

## Not verified in this sweep

- The state of the cloud deploy, and anything else that only the deploy machine can see.
- The three validators in CI-9 and the full test suites; only static checks and the Candidates suites were run.
- Why platform-api's install failed (CI-6), and whether the vendored CDK package differs materially from its source (D-3).
- Who owns the two in-flight side worktrees (B-3, B-4); their sessions were not contacted.
- Whether a candidate's media join works against platform-api `main`; it is closed by commit message only (`a1cd486`).
- Anything that needs a running stack: the Candidates judge's current colour, the journeys, the real-Postgres and real-Docker suites.
- The four items in row C-18.
