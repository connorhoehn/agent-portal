# Ledger of open work

Written 25 November 2026 after a read-only sweep of the portal and every repository in its dependency chain. This is the single list of what is open. Each row was checked that day against the code, the git history or the CI runs, not copied from older notes. [next-steps.md](next-steps.md) stays as history and as the record of decisions; where the two disagree, this file is the newer one.

Keeping it: when a row is done, delete it and name the row id in the commit message. When something new turns up, add a row with its evidence. Sizes are S (an hour or two), M (a day), L (several days).

## How the sweep was run

- Every repository was fetched. ui-components was fast-forwarded to 2.546.0 and realtime-examples by two commits (interview guest isolation); the portal's local `main` moved to `aa0e6fcdf`. Everything else was already level with its remote.
- The portal was read on the checked-out branch `codex/milo-coding-film`, which is two commits ahead of `main` and one behind.
- Three lanes read in parallel: the Candidates tenant, the rest of the portal (Milo and the films first), and the dependency repositories with their pins, side work and CI.
- Nothing was changed except this file and one pointer line in `next-steps.md`.

## Where things stand

- **The Candidates tenant (code name `interviews`) works end to end in the mock world**: opening and kit, assign, accept, prepare, invite link, consent, room, pad or whiteboard, Milo's tools, scorecard, debrief, decision, record, retention and export. Typecheck is clean in the portal and the middleware. The portal's interview tests pass 269 of 269; the middleware's passed 2,385 with 1 failure (since fixed) and 35 skipped real-service tests. There are no stub markers in the tenant's code. Of the hiring-loop gaps from the 20 November audit, the blocker (cancel, no-show, withdraw) was built on 26 November; the rest are open.

- **The portal's four CI failures were fixed on 26 November** (the stale voice inventory, the demo director's settle race, the waiting-room assertion and the infra tenant list), and the film branch is merged into `main`. `next-steps.md` still says CI was green throughout; it had no green run in the 60 before.
- **No private chain repository has executed a CI job since 11 November** (row CI-1). The pipeline-runtime 1.8.x releases, the realtime-examples guest-isolation commits and distributed-core 0.52.0 were verified locally only.
- **Finished work is sitting uncommitted in two side worktrees**, in pipeline-runtime and ui-components (B-3, B-4). The cloud branch from the deploy machine was merged on 26 November, with one function now choosing among the mock, Docker, AgentCore and no code runner.
- **Milo's rebuild is half landed.** Phases 0 and 1 are on `main` and the text judge passes both sets, but the new turn owner is off by default, none of the planned deletions happened, and phases 2 and 3 have not started. Films 7 (coding) and 8 (system design) are delivered.
- **Closed and quiet:** the security work of 6 to 10 November, the learning loop, the value sweep and the voice navigator. The access tenant, described as unfinished in `next-steps.md`, is built.
- **The portal's pins are level as of 26 November:** ui-components 2.546.0, and realtime-modules 0.151.0 in both the middleware and the frontend.

## Do first

3. **CI-1** Owner: get Actions running again on the private repositories, then re-run the latest `main` run in each and cut realtime-examples 0.2.15 (D-7).
4. **B-3, B-4** Commit and push the two side worktrees before anything else touches them. They hold about 3,600 lines of pipeline-runtime and eleven ui-components source files that exist nowhere else.
7. **C-3, C-4** Candidates: with cancel, no-show and the recruiter's stage moves built, the simulated runner and the waiting-candidate bell come next.
8. **M-1 to M-3** Milo: build the audio gate, make the turn owner the default, then do the phase-1 deletion in one commit.
9. **P-8** One pass over the parked owner decisions: decide, record, implement.
10. **P-9** Privacy cleanup in the public repository.

## Branches and unmerged work

| Id | Item | Evidence | Status | Next action | Size |
|---|---|---|---|---|---|
| B-3 | pipeline-runtime: a new `/local` subpath (a SQLite-backed local job queue with lanes, gates, leases and a supervisor; changelog entries 1.9.0 and 1.9.1) is uncommitted in a side worktree and already in use from a packed tarball. `main` is still 1.8.1. | Worktree branch `handbuilt-local-jobs`, no upstream: `src/local/`, `test/local/`, `CHANGELOG.md` "[1.9.1] — 2026-11-25" | In flight in another session | Commit and push the branch now, then merge and tag 1.9.1 so the consumer stops depending on a side tarball | M |
| B-4 | ui-components: the Loops-page primitives are uncommitted in a side worktree: spacing fixes in `MarkdownView`, `MetaLine` and `ConnectionPill`, plus `StopCircleIcon` and `RelaunchIcon`. The work is based on 2.543.0 and labelled 2.544.0, a number `main` has since given to a different release; six of its files also changed on `main`. | Worktree branch `loops-page-primitives`, no upstream, base `d619f3581`; `main`'s 2.544.0 is `b5f2ac9bf` | In flight in another session | Rebase onto 2.546.0, renumber to 2.547.0, merge the six overlapping files, commit and release | M |
| B-5 | ui-components `main` has parked local changes: `.storybook/main.ts` points Storybook at an untracked `reference-sheets/` folder (728 files, 85 MB of design reference images). | Both dated 20 November; nothing upstream touches them | Parked | Decide: keep the sheets out of the public repository and revert the Storybook line, or commit the stories without the images | S |
| B-6 | Finished leftovers: the portal worktree on `codex/interview-tenant-fixes` (it is `main`'s head), a ui-components release clone on `t49-second-release` (level with `main`), and three ui-components stashes from 2 November on `codex/huddle-prejoin-redesign`, one labelled as already integrated. | `git worktree list`, `git stash list` in each repository | Finished or stale | Each owner removes its own; nothing to merge | S |

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

## Candidates tenant

Fourteen items in the plan and the audit have closed since they were written and are not listed. `mw/` below is `middleware/src/` and `pt/` is `portal/src/`.

### Hiring-loop gaps (from `docs/audits/candidates-gap-audit-2026-11-20.md`, each re-read in the code)

| Id | Item | Evidence | Status | Next action | Size |
|---|---|---|---|---|---|
| C-1 | Cancel, "did not take place", withdraw and the recruiter's End were built on 26 November. What is left of the audit's blocker: a round still starts when the lead opens the room, not when the candidate is first admitted; "Did not take place" is missing from the My interviews list; the new pages have not been looked at in a browser; the new Postgres case has not run; no judge row or walk covers any of it. | `mw/lib/interviews/cancel.ts`; `mw/routes/interviews/cancel.ts`; `pt/pages/interviews/RoundCloseDialog.tsx`; audit section 1 | Partly | Walk the four actions once in the mock world; decide start-on-admit together with the films, which rely on the lead's join starting the round | M |
| C-2 | The recruiter's stage moves (start screening, mark hired, offer declined, reopen) and the no-hiring-manager warning were built on 27 November. Left: the new screens have not been looked at in a browser, and no judge row or walk covers them. | `mw/lib/interviews/stage-moves.ts`; `mw/routes/interviews/stage-moves.ts`; `pt/pages/interviews/StageMoveDialog.tsx`; audit section 2 | Partly | Walk the four moves and the warning once in the mock world, with C-1's screens | S |
| C-3 | Run is a simulator unless a hidden setting is on, and the pad does not say so. | `mw/lib/interviews/runs/select.ts`; audit section 3 | Open | Label the pad when the runner is a stand-in; default to Docker locally when it answers; document the setting. The deployed backend (the AgentCore interpreter) is merged and unproven from this machine | M |
| C-4 | A waiting candidate is announced only to an open room page, and only the lead can admit. | `mw/routes/interview-invite.ts`; `mw/routes/interviews/admission.ts:36-41`; `pt/pages/join/WaitingStep.tsx:82`; audit section 4 | Open | Bell the lead and panel on the first knock; let a panel member admit when the lead is absent | M |
| C-5 | No notes during the call, and scorecard drafts live in the browser. | No notes route or store; `pt/lib/interviewsScorecard.ts:168`; audit section 5 | Open | A private per-seat notes field in the room, saved on the server and offered as the scorecard's starting notes; server-side drafts | M |
| C-6 | The candidate is reached only outside the product: no page shows their contact details, there is no edit route, and they cannot decline a time. | `mw/routes/interviews/candidates.ts`; audit section 6 | Open | Show and edit contact details; a copyable invitation message; a candidate-side "I can't make this time" that bells the recruiter | M |
| C-7 | One role per person at a time: only holders of `interviewer` can be seated. | `mw/routes/interviews/assignments.ts:57-62`; audit section 7 | Open | Derive reach from all of a person's grants in the tenant, or let a hiring manager or recruiter hold a seat | M |
| C-8 | Milo reads speech only. The recap, coach and plan see no résumé, pad or run results; one question has expected values; there is no tool to set the pad language, run code, move to the next question or write on the board. Since the audit he reads the board as text and his probes join the recap timeline. | `mw/lib/interviews/recap/prompt.ts:13`; `mw/lib/interviews/coach/prompt.ts:19`; `mw/lib/interviews/milo-tools/references.ts:46`; audit section 8 | Partly | Give the recap the final pad snapshot, run results and board text as citable sources; extract résumé text at upload; add a reference solution to kit questions; then the missing tools | L |
| C-9 | "Milo recommends" is computed in the browser only, is not stored or exported, and contradicts the one published notice version. | `pt/lib/interviewsMiloAdvice.ts`; `mw/lib/interviews/consent/notice.ts:21,27`; audit section 9 | Open | Compute it on the server, store what was shown with each scorecard version, show it on the debrief and the export, publish a matching notice version (C-27) | M |
| C-10 | A new opening has no spending cap, and the warning shows only on the opening page. | `pt/lib/interviewsKit.ts:258`, `:103`; audit section 10 | Open | Default a cap at creation, or warn on Assign, Prepare and the idle room | S |
| C-11 | Candidate accessibility: no transcript or captions for the candidate, and the door is walked at two desktop widths only. | `pt/pages/join/JoinRoom.tsx:8`; `scripts/journeys/interviews/E3-door.mjs:26`; audit section 11 | Open | Offer live captions when the candidate accepted the transcript; walk the door at phone width and by keyboard | M |

### Smaller gaps

| Id | Item | Evidence | Status | Next action | Size |
|---|---|---|---|---|---|
| C-12 | A paused or closed opening accepts candidates. | `mw/routes/interviews/candidates.ts:59-62` | Open | Refuse unless the opening is open | S |
| C-13 | One person applying to two openings becomes two records. | `mw/routes/interviews/candidates.ts:77-80` | Open | Match on email and add an application | S |
| C-14 | Red flags stop at the scorecard. | Nothing in `mw/lib/interviews/debrief`, `export` or `pt/pages/interviews/DebriefPage.tsx` | Open | Carry ticked flags to the debrief and the export | S |
| C-15 | The panel cannot confer in the product: discussions and huddle chat are off for the tenant. | `tenants/manifest.json:94-95` | Open | Decide; if yes, turn discussions on for the debrief only | S |
| C-16 | Settings are invisible: `interviewsSettings()` has no callers outside its file and tests. | `mw/lib/interviews/` | Open | A read-only view of retention periods and required consents | S |
| C-17 | Thin scheduling: no double-booking check, no "missed" label, no reminder. | `mw/lib/interviews/assign.ts`; `mw/lib/interviews/result-bells.ts` | Open | Add the three | M |
| C-18 | Four audit items not re-read: kits start empty, Milo has one setting, the candidate `notes` field is unused, and the profile read sends the whole row. | Audit "Minor" | Unverified | Re-check; fix the profile row first, because it reaches assigned interviewers | S |

### Delivery and coverage

| Id | Item | Evidence | Status | Next action | Size |
|---|---|---|---|---|---|
| C-20 | `docs/interviews-tenant-plan.md` is stale: it opens with "Nothing here is built" and lists closed items as open. | Plan lines 3, 211-219, 787-790 | Open | Rewrite the status line, strike the closed items, point here | S |
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
| M-9 | The listening-side consent check is hard-wired true; the intake is the only layer. | Audit finding F14; `middleware/src/lib/meeting-assistant/orchestrator.ts:2840` | Open | Wire it to the policy (privacy item) | S |
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

## Dependency repositories and pins

Since 11 November only ui-components (2.546.0), realtime-modules (0.151.0), platform-api, realtime-examples and pipeline-runtime (1.8.1) moved. event-catalog, distributed-core, service-runtime, message-queue and managed-nosql-store are quiet, clean and level with their remotes.

| Id | Item | Evidence | Status | Next action | Size |
|---|---|---|---|---|---|
| D-2 | ui-components 2.546.0 is adopted; its smaller `CatalogGrid` default gap (20px to 16px) has not been looked at on the two pages that use the default. | `portal/src/pages/ScoresCohortPage.tsx:43`; `portal/src/pages/SelectContextPage.tsx:426` | Open | Look at both pages once and re-run the DOM audit | S |
| D-3 | The portal's vendored CDK construct package is 0.1.0; its source in realtime-examples is 0.2.0. | `infra/package.json:14`; realtime-examples `cdk/package.json` | Impact unverified | Read the diff before the next cloud deploy and re-vendor if the stacks need it | S |
| D-4 | Local images for the `social` compose profile predate the 25 November pull, so the local gateway lacks the two guest-isolation commits. | `docker-compose.yml:136`; realtime-examples `18bff74f`, `3db0a544` | Open | Rebuild through `node scripts/social-documents.mjs up` | S |
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
| H-2 | The README, `docs/project-story.md` and `docs/demo-script.md` do not mention the Candidates tenant, the access tenant's current state, Milo or the meeting assistant. Nothing indexes `docs/milo-rebuild/`, `docs/interviews-tenant-plan.md` or `docs/audits/`. | `README.md` (four document links) | Open | One README section: the six tenants and a map of the documents | S |
| H-3 | `scripts/audit-loop/run.sh` points at three files that no longer exist, so it cannot run. | Path check on 25 November | Open | Delete the folder or restore the prompts | S |
| H-4 | `scripts/README.md` predates the interviews and learning-loop validators, the Milo judge and probe, the meeting assistant scripts, the voice harness and the film scripts. | Last changed 7 November | Open | Add a row per newer tool | S |

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
