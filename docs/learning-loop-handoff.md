# The learning loop: handoff for lane E and the open middleware items

This is the work order for whoever picks the loop up next (a person, Codex, or another agent). It is self-contained: read it, then [learning-loop-design.md](learning-loop-design.md) (the why) and [learning-loop-decisions.md](learning-loop-decisions.md) (22 one-line decisions). Each lane's build notes are in [next-steps.md](next-steps.md) under "Learning loop".

## Where main stands

Everything this work order asked for is on main (11 November 2026): lanes A (run report), B (budgets), C (debrief, proposals from runs, review rules, retirement) and D (giving runbooks to a run); the eight lane E packages (the run page, one Runs list, the brief preview and pins, the Runbooks pages, Bots and Computers, the removals, the Workflows rename, the journey and the validator); and the middleware follow-ups, including selected-row visibility on Budgets at 1280 px. The judge is `scripts/validate-learning-loop.sh`:

- Acceptance 1 to 12 pass in the browser through real dispatches on the mock (`npm run journey:learning-loop`, in `portal/`).
- Acceptance items 13 and 14 pass against the real local worker with a stub `claude` (`scripts/learning-loop/debrief-e2e.mjs`, `scripts/learning-loop/local-report-e2e.mjs`).
- Acceptance 4, 5, 6 and 8 pass on the mock in `middleware/src/routes/__tests__/learning-loop-offer-mock.test.ts`.

The package sections below are kept as the as-built record: the file paths, contracts and acceptance each names are what was built. What remains open is in [next-steps.md](next-steps.md) under "Learning loop" (each lane's note) and in the decisions file.

Pickup on 11 November: the MicroVM filter now has browser coverage in journey step R4, using two hand-written, clearly marked browser fixtures. It checks selection through the filter control, keeping another filter, reload, clearing, and the Demo data mark. The API suite separately checks real filtering over microVM and other executor reports. This does not prove a microVM dispatch: the default mock still produces governed runs, and real AWS execution remains unverified. The subsequent Budgets pickup below closes the selected-row gap through the shared library.

Component discipline retains main's known baseline of nine failing checks, confirmed in the preceding handoff: raw elements and inline styles exceed several area budgets, and card-stat and density-size rules fail in `ReferenceSheet.tsx` and `BotDetailPage.tsx`. The MicroVM-filter pickup changed no portal implementation. The loop's 61 middleware suites pass; the wider middleware run was stopped when the baseline was initially mistaken for a new merge blocker, so that run is not claimed as passing.

Pickup verification: all fourteen acceptance items and R1–R4 pass (`validate-learning-loop.sh --skip-suites`); separately, the loop's middleware suites pass 1,046 tests, the portal passes 2,448 tests with one skipped, and the devbox Python suite passes 65 tests. Both TypeScript checks, voice inventory, documentation links and story checks pass. All four journeys (learning loop, demo moments, voice coverage and leftovers) finish without failures. R4's screenshots were checked at 1280 and 1440 px; its reports remain browser-only fixtures.

## Continuing work loop (11 November 2026)

Repeat: select an actionable recorded gap, reproduce it, fix it on an isolated branch, run focused checks and the relevant journey, update this record, then fast-forward the clean main checkout and select the next gap. Keep user decisions and real-cloud validation outside that loop until their required input exists.

Owner direction, 11 November: this app is for desktop and laptop use, never phones or tablets. Do not spend loop cycles on phone/tablet layouts. The recurring Budgets checks cover 1440 and 1280 px; 1280 px remains a supported laptop width. Earlier mobile observations below are historical evidence, not an active backlog.

The Budgets gap is closed with vendored ui-components 2.522.0, built from library commit `704280cea` on `codex/data-table-reveal-selection`. The library source remains on that branch because its main checkout contains unrelated edits. `DataTable` owns optional `revealSelection`; the page only opts in. It chooses the selected row's page, waits for layout and reveals the row without moving focus. Refreshing equivalent rows does not scroll again. `npm run journey:budgets-selection` in `portal/` checks an initially offscreen allocation at 1440 and 1280 px on load and resize; the learning-loop validator now includes it.

Library verification: 1,107 suites / 12,298 tests passed before the final refresh guard; the final guard and related checks pass 114 tests, and lint and build pass. The portal suite passes 2,448 tests with one skipped. At ui-components 2.522.0, the Budgets deep DOM audit was **not clean**: its six light/dark width cases produce 852 findings, with every issue identical against 2.519.0 using the same audit engine. They cover card/table geometry, narrow shell column expectations and leading separators; no tolerance or baseline was changed. The following responsive-audit pickup resolves these measurement gaps. On the final package, `validate-learning-loop.sh --skip-suites` passes all fourteen acceptance items, R1–R4 and the six budget visibility cases. Documentation links and story checks pass; component discipline remains at the same nine failures, with zero inheritance contract failures.

The next cycle preserves structured failure codes for governed and fleet runs. `resultEventFailureCode` accepts bounded identifier-shaped `terminal_reason` values on failed results, while the full error detail stays intact. `DevboxRunOutcome` and `ProjectRunEnd` pass the code to the report; success clears it and budget cutoffs take precedence. Missing or malformed reasons retain the existing error-text fallback. Journey L8 now checks `needs_gpu_pool` exactly on both cold-start reports and in the next attempt's brief. Parser/stream tests cover malformed reasons and zero-exit API failures; fleet tests read stored reports to check structured codes, legacy fallback, success and budget precedence.

Failure-code verification: TypeScript and the focused parser, stream, fleet and report suites pass. The full learning-loop validator passes all fourteen acceptance items, R1–R4, the six budget visibility cases, 61 middleware suites / 1,046 tests and the portal's 2,448 passing tests (one skipped). The validator now also selects the focused runtime/dispatch suites and prints the Node test runner's portal totals. Documentation links and story checks pass.

The desktop audit cycle vendors ui-components 2.522.1 from source commit `9b0c53067` on `codex/responsive-audit-profiles`. It measures DataTable cards against an explicit profile activated by the shared owner's CSS state; Budgets uses that form in its constrained content column at 1280 px. Card rows retain inset, spacing, display, header and typography checks. CollectionToolbar's header placement has a separate zero-inset profile scoped to PageHeader, which supplies the gutter; ordinary toolbar bands retain their inset. Leading separators are measured after ancestor clipping. Valid/mutated fixtures cover each profile and ordinary neighbors. No tolerance or baseline was relaxed. The already-built archive also contains compact navigation profiles; the proposed portal mobile markers were removed following the owner's desktop-only direction.

The initial six-case comparison against the preceding audit found no unverified cases and explicitly warned that the contract changed. This corrects measurements of intentional layouts, not 852 product defects. The recurring `journey:budgets-audit` now covers four light/dark cases at 1440 and 1280 px, all passing with zero findings and zero unclassified composer policies. The selected-row journey checks load and resize at those same desktop widths. Both are part of the learning-loop validator.

Runs' missing composer is restored with the shared `CollectionCommandHost` and bounded collection grammar. It filters the existing report query, searches loaded titles, refreshes and opens one current report by exact ID or unique title. Toolbar search and commands share URL state; changing one filter preserves the others, and reset clears all filters and title search together. No start, cancel or retry command was added. Parser tests cover independent filters, atomic reset and unsupported actions; journey R2 exercises the actual composer, toolbar search, filter persistence, rejection, reset and opening a report.

Journey R5 audits Runs after the real mock dispatches, with 17 report rows measured in each of four desktop width/theme cases: zero findings and zero unclassified composer policies. It explicitly refuses an empty-table audit. The 1440/light and 1280/dark screenshots were reviewed. Computers also passes its four desktop cases with eight rows per case. Its historical phone column finding is outside product scope. That audit allowed horizontal scrolling to reach Cost at 1280 px, because the contract permits a table's own scroller. The following pickup checks that desktop interaction explicitly.

Verification: both TypeScript checks pass; the full middleware run passes 654 suites / 8,965 tests (15 suites / 111 tests skipped), and the portal passes 2,450 tests with one skipped. The learning-loop validator passes all fourteen acceptance items, R1–R5 and both desktop Budgets checks; the final journey repeat also passes, verifying that reset waits for the newest run and that R5 measures populated rows. Demo moments, voice coverage and leftovers passed before the Runs-only addition; the updated learning-loop journey covers that addition. Python passes 65 tests. Voice inventory, links and story checks pass. Shared audit mutation tests and skill validation pass; the component build/lint and 88 focused component tests passed before the final audit-only header profile. Component discipline remains at the same nine failures, with zero inheritance failures and the installed archive matching its source.

The Runs column pickup opts into DataTable's adaptive columns and header chooser. Runbooks given, Initiative and then Who ran it yield space in that order; When, What, Outcome, Learned and Cost stay in the main table. On the populated journey, 1440 px shows all eight fields and 1280 px shows six, with Initiative and Runbooks available in each row's hidden-values popover. Five load/resize measurements have zero horizontal overflow and no clipped or missing primary headers. R2 also checks every hidden value and column choice, without opening the run. The remaining phone-only L11 screenshot was removed.

That interaction exposed a shared bug: choosing a wider hidden column could hide it again after the fit ran out of alternatives. Vendored ui-components 2.522.2 (`53fdafac4`, `codex/data-table-column-choice`) keeps the chosen column out of the hide order. When no swap fits, all fields are shown as cards; widening the table restores ordinary rows. The asymmetric-width regression failed before the fix and passes after it. All 62 DataTable tests, library lint/build, portal TypeScript and 2,450 portal tests pass. The installed bundle was compared with the rebuilt source bundle. The final learning-loop validator passes all fourteen acceptance items, R1–R5, both desktop Budgets checks and both local-worker harnesses. Runs and Budgets have zero findings in their four-case desktop audits. Voice inventory, links and story checks pass; component discipline retains its nine known failures and zero inheritance failures. Middleware and devbox sources are unchanged from the preceding full-suite verification.

Next actionable work: repair navigation parity's source interpretation. A temporary probe recognizing App's `Gate` wrapper resolves 47 role mismatches; the other two findings are the `/iq/logging` and `/pipelines/logging` roots of existing `logging/*` routes. Add guarded wrapper recognition and wildcard-root handling with mutation coverage, preserving detection of actual missing routes and changed role gates. Real governed debrief remains unsupported as decided; the MicroVM browser fixtures do not prove cloud execution.

## Rules that bind this work

These are not preferences; a change that breaks one is not merged.

1. **Public repositories.** Nothing from real usage, no personal data, no machine-local paths, no account identifiers in tracked files. Docs name weakness classes and their fixes, never attack steps.
2. **No model anywhere server-side** (decision 17). Do not add an LLM call to the middleware or the portal. Never invoke the real `claude` CLI from a test or a script that could spend; the harnesses put a stub `claude` on `PATH`.
3. **Pages come from the component library.** Every page starts from a `@connorhoehn/ui-components` template (`PageFrame`, `CollectionPage`, `MasterDetailPage`, `DetailPage`, `DashboardPage`, `SettingsPage`) and uses its composites; the index is `portal/node_modules/@connorhoehn/ui-components/docs/COMPONENT_INDEX.md`. No hand-rolled HTML, no inline `style={{...}}`, text through the library's `T` with the neighbouring group's tokens. If a composite is missing, stop and record the gap in `docs/ui-components-queue.md` rather than hand-roll it; the library is a separate repository and is pinned here as a vendored tarball (`portal/vendor/`).
4. **No internal words on screen** (design § Pages): no hashes on rows, no "marketplace firing", "governed run (primary)", "session run", "box" or "devbox". Five nouns: run, runbook, proposal, bot, computer.
5. **Mock data is hand-written and marked.** A simulated run's report, its debrief and the one runbook it files are fixtures (`middleware/src/mock/run-report-fixtures.ts`, `middleware/src/mock/debrief-fixtures.ts`); they carry `simulated: true` / `demo_data: true` and every page shows "Demo data" for them. Nothing is assembled from strings at run time.
6. **Lane E does not change middleware behaviour** beyond: the routes the removals delete, and the one list read named under E2. Everything else the pages need already exists; if it does not, write it down as a follow-up instead of adding it.
7. **Work on a branch, verify, then fast-forward.** The main checkout serves live dev servers; never edit it directly, never run against ports 3001, 5183 or 18080. Boot your own middleware (`PORT=<free port>`), your own Vite, your own `VOICE_LOG_DIR`. Local compute tests set `ORGIQ_PRESENCE_CONFIG` to a temp file (the default token file is global and pairing a test stack unpairs the owner's machine). Tests never create Computer Lab machines.
8. **Wire snapshots** (`middleware/src/mock/core/wire/snapshots/*.json`) are regenerated from your own server and every changed row is explained in the commit message. A row you cannot explain is a bug.

## The contract lane E builds on

Shapes are in TypeScript; line numbers are as of this writing (re-grep if they drift).

### Runs and reports

| What | Where |
|---|---|
| `RunReport` (the one record every run end writes) | `middleware/src/lib/run-reports/types.ts:150` — `runRef`, `workItemId`, `initiativeId`, `executor` (`fleet` \| `governed` \| `microvm` \| `local` \| `mock`), `outcome` (`done` \| `failed` \| `cancelled` \| `needs-review`), `failureCode`, `summary`, `changes`, `verification[]`, `obstacles[]`, `runbooksOffered[]`, `runbooksUsed[]` (`source: observed \| lab-applied`), `cost { billedUsd, reportedUsd, basis }`, `selfReport`, `learned`, `runbookAccounts[]`, `debrief`, `claudeSessionId`, `briefId` |
| `RunReportRunbookAccount` (what the run said of each runbook it was given) | `types.ts:77` — `followed: yes \| partly \| no`, the step it had wrong, a note |
| `RunDebrief` and `DebriefState` | `types.ts:118`, `:106` — states `skipped`, `requested`, `filed`, `nothing-to-keep`, `lint-failed`, `refused`, `expired`; `reasonText` is the sentence pages print (never compose your own); `proposalId`, `proposalKind`, `convertedFrom`, `lint[]`, `problems[]`, `cost`, `simulated` |
| `DEBRIEF_SKIP_REASONS` and their sentences | `types.ts:90`; `middleware/src/lib/runbooks/debrief.ts:55` (`DEBRIEF_SKIP_TEXT`) |
| `recordRunEnd` (every executor's run end goes through it) | `middleware/src/lib/run-reports/record.ts:258`; local compute calls it at `middleware/src/routes/local-compute.ts:926` with `runRef: job.id`; the microVM dispatcher at `middleware/src/lib/microvm-dispatcher.ts:818`, also `runRef: job.id` |
| `GET /api/runs/:ref/report` | `middleware/src/routes/session-briefs.ts:196` — the report for one run ref |
| `GET /api/work-items/:id/run-reports`, `GET /api/initiatives/:id/run-reports` | `session-briefs.ts:207`, `:213` — newest first |
| `GET /api/runs/:ref/brief` | `session-briefs.ts:112` — the frozen text a run was given; its stored `offer` is `{ runbooks: [{ id, version, title, reason, pinned, health, warning }], none_reason }` |
| `GET /api/runs`, `/api/runs/:id`, `/:id/steps`, `/:id/events` | `middleware/src/routes/runs.ts:26` — the bot and queue run projection for the orgiq tenant (the façade the current `/iq/runs` page reads) |
| Local compute jobs | `GET /api/work/jobs/:id` (`middleware/src/routes/work.ts`); a job's run ref is its job id |

### Work items, pins, the brief preview

| What | Where |
|---|---|
| `GET /api/work-items/:id/brief-preview` | `session-briefs.ts:232` — the exact brief a dispatch would freeze now, plus `offer`, `pins`, `previous_attempts` |
| `PUT /api/graph/work-items/:id/runbook-pins` | `middleware/src/routes/work-items.ts:913` — body `{ runbookIds: string[] }` (ordered, at most five, each a published runbook whose scope admits the item; `[]` clears), response `{ workItemId, runbookPins }`; the board's write gate and the item's initiative scope |
| `planRunBrief` (one function for preview and freeze) | `middleware/src/lib/run-brief.ts:175`; selection in `middleware/src/lib/runbooks/select.ts:126` (`MAX_GIVEN_RUNBOOKS = 2`, pins first) |

### Runbooks, proposals, evidence

| What | Where |
|---|---|
| Runbooks router (every route listed in its header comment) | `middleware/src/routes/runbooks.ts:1-37`; mounted at `/api/runbooks` |
| `GET /api/runbooks/evidence` | `runbooks.ts:538` — `LoopEvidence` (`middleware/src/lib/runbooks/evidence.ts:87`): the 30-day window, runs given, runs that said they followed, outcomes, proposal counts by status, the comparison when both sides have five runs |
| `GET /api/runbooks/:id/evidence` | `runbooks.ts:552` — `RunbookEvidence` (`evidence.ts:69`) with the runs (`EvidenceRun`, `evidence.ts:44`) |
| `GET /api/runbooks/:id/applications` | `runbooks.ts:604` — the runs a runbook was given to (`?version=`) |
| `GET /api/runbooks/proposals`, `GET /api/runbooks/proposals/:pid` | `runbooks.ts:481`, `:496` — a proposal carries `expired: boolean`, `source.kind` (`run` \| `person` \| `system`), `proposed_scope`, `run_ref` (for a run's proposal), `demo_data`; the detail adds the diff against its base, a fresh lint result and `scripts_to_read: [{ path, sha256 }]` |
| `POST /api/runbooks/proposals/:pid/accept` | `runbooks.ts:717` — body may carry `widen_scope: true` (required when the reviewer accepts at a wider scope than proposed; organisation scope needs an org leader) and `scripts_read: [{ path, sha256 }]` (required for every entry in `scripts_to_read`; otherwise `409 { code: 'SCRIPTS_UNREAD', scripts }`). The response says `accepted_as: 'sole-reviewer-dispatcher'` when decision 11 applied |
| `reject` (note required), `withdraw`, `merge`, `retire` | `runbooks.ts:876`, `:893`, `:939`, `:979` |
| The runbook record and versions | `GET /api/runbooks/:id` (`runbooks.ts:568`), `/versions` (`:583`), `/diff` (`:591`); a version from a run names its `run_ref`; `demo_data` on a version from the mock (`middleware/src/lib/runbooks/types.ts:133`) |

### Budgets (lane B; the Budgets page is done)

`GET /api/budgets/lines` (`middleware/src/routes/budgets.ts:76`), `PUT /api/budgets/learning` (`:101`). The learning line is the only money the loop spends; `middleware/src/lib/learning-budget.ts`.

### The mock

- Four simulated runs (`middleware/src/mock/run-report-fixtures.ts`): the logout cookie bug (teaches something), the tenant cutover (follows `rb-tenant-cutover`), a dashboard item (needs nothing), the cold-start bug (fails). Dispatching a work item on the mock plays the matching fixture through the governed path: the fake microVM's final message carries the fixture's `lab-report` block (`middleware/src/mock/devbox-shell.ts`) and its `debrief` op answers with the hand-written folder (lane E8).
- The one hand-written runbook a debrief files: `rb-logout-shim-cookie` (`middleware/src/mock/debrief-fixtures.ts`), marked `demo_data`.
- Personas and seeded data are the Halyard story in `docs/demo-script.md`; `node scripts/content/check-story.mjs` must stay green.

## Lane E: the pages

Eight packages, all done. E1 to E4 are the loop, E5 to E7 are the consolidation the design asks for, E8 is the judge. Each package's acceptance is on the mock in a browser with no model, and the judge runs them.

### E1. The run page (done)

Route `/iq/runs/:id` (today `PipelinesRunDetailPage` with `briefTab`, `portal/src/App.tsx` around line 533). Replace the tab set with four sections, each from `GET /api/runs/:ref/report` and `GET /api/runs/:ref/brief`:

- **Brief**: the frozen text, as the run was given it (whole, in a document view; the runbook text inside it is already fenced and labelled by the middleware).
- **Report**: summary, changed files, verification rows, obstacles, cost. A local run's cost reads "Reported, not billed" (`cost.basis`); a run with `selfReport: missing | malformed` says the run did not report, in those words.
- **Runbooks**: one row per entry in `runbooksOffered` with its reason from the brief's offer, joined with the run's account (`runbookAccounts`): followed yes / partly / no, the step it had wrong, the note. An observed load the run did not name is labelled "loaded, not reported". A run given nothing shows the offer's `none_reason`.
- **Learned**: the `learned` sentence; then the debrief: `filed` → a link to `/iq/runbooks/proposals/:proposalId` (and "filed as an edit of …" when `proposalKind` is `edit`); `skipped` → `reasonText` verbatim; `nothing-to-keep` → the session's one line; `lint-failed` / `refused` → the lint rows or problems; `requested` → "waiting for the debrief"; `expired` → that. `simulated` → the "Demo data" mark on the section, and the sentence that the run was simulated.

The same page serves local compute jobs (run ref = job id) and bot runs (the façade's `steps` and `events` stay available as a fifth section when the run has them). The local job page (`portal/src/pages/work/JobDetailPage.tsx`) links here rather than growing its own report view.

Acceptance: items 1, 5 (the Brief shows the runbook's text; Runbooks shows it given and followed), 7 (the dashboard item's Learned says why there was no debrief, in the stored sentence), 8 (the second cold-start run's Brief shows the first attempt under previous attempts).

### E2. One Runs list (done)

Route `/iq/runs` (today `portal/src/pages/iq/RunsPage.tsx`, bot runs only). One list for every executor, newest first, with filters: executor (queue, local, bot, microVM), initiative, outcome, and "debriefed" (filed / skipped / none). Columns: when, what (work item title or run title), who ran it (bot name, "Your machine", or the executor word), outcome, runbooks given (count), learned (a dot when a proposal was filed), cost.

This needs one read the middleware does not have: a list of run reports across executors. Add `GET /api/run-reports?executor=&initiative=&outcome=&debrief=&cursor=&limit=` over the existing store (`middleware/src/lib/run-reports/store.ts`, with `allReports` in `record.ts:246` as the model), read gate the same as `/api/runs`. It is the one middleware addition lane E may make; no logic, only a filtered page of rows. Bot-run rows join the façade for their names.

Merged in, as the design lists: Automate › Runs (`portal/src/pages/work/automateNav.tsx`, the `/iq/work/queue` entry becomes a filter on this list), Local compute › Runs (a filter), the initiative's Agents › Runs (a link to this list filtered by initiative).

Acceptance: after the mock's four dispatches, the list shows the four runs with their outcomes; the local filter is empty until a worker runs; the initiative filter narrows to Auth Migration.

### E3. The work item: brief preview and pins (done)

`portal/src/pages/runbooks/WorkItemBriefPreview.tsx` already reads `GET /api/work-items/:id/brief-preview`. Extend it, where the dispatch card and the work item's drawer show it, with:

- **Runbooks this run will get**: each offered runbook with its reason sentence and the drift warning when present; "none" with `none_reason` otherwise.
- **Pin / unpin**: a control writing `PUT /api/graph/work-items/:id/runbook-pins`, visible to whoever has the board's write gate; a pinned runbook shows first with "pinned" as its reason. Picking from the library uses the runbooks list (`GET /api/runbooks?scope_kind=&scope_ref=`) filtered to runbooks whose scope admits the item.
- **Previous attempts**: the `previous_attempts` rows (outcome, failure code, summary, obstacles, what the reviewer asked for), newest first.

Acceptance: item 4 (open a related work item; its preview lists `rb-logout-shim-cookie` with its reason before dispatch; pin a second runbook; it appears first).

### E4. Runbooks: Library, Proposals, evidence (done)

`portal/src/pages/runbooks/RunbooksModule.tsx` keeps Library and Proposals; the Briefs tab goes (E6).

- **Evidence line** at the top of Library from `GET /api/runbooks/evidence`: "In the last 30 days: N runs given a runbook, M said they followed it, K done; P proposals open, Q accepted, R expired" and the comparison sentence only when the read returns one. Every figure shows its sample size; none is a percentage without its count.
- **Runbook record** (`RunbookRecord.tsx`): text, versions (each version from a run names the run and links to its run page), the runs it was given to (`/:id/applications` and `/:id/evidence`: given, what each run said, outcome), health with the sentence that it is derived from what runs said.
- **Proposal review** (`ProposalReview.tsx`): the full runbook text, the lint result, and — for a proposal whose `source.kind` is `run` — the run's obstacles and `learned` sentence beside it (from `GET /api/runs/:run_ref/report`). "Demo data" when `demo_data`. "Expired" when `expired`. The accept control is a confirmation that states the scope in words ("This runbook will be given to runs in repository X" / "on initiative Y"); when `scripts_to_read` is not empty the confirmation lists each script by path with a tick, and the accept sends `scripts_read` with the path and sha256 shown; the 409 `SCRIPTS_UNREAD` response re-shows the unticked ones. Widening scope is a second, separate confirmation sending `widen_scope: true`. A proposal the viewer dispatched the run for says so, and says whether decision 11 applies.
- **Proposals tab**: filters by kind (new / edit / retire), source (run / person / system), status; a retire proposal shows the runs it names.

Acceptance: items 2, 3 (a second persona accepts; the confirmation states the run's repository; the library shows a version naming the run), 6 (the runbook's page lists the run, health proven, the evidence line counts it), 9 (one retire proposal naming three runs: the fixtures need three successful unfollowed runs of `rb-tenant-cutover`, or the journey dispatches it three times with a fixture that reports `followed: no`), 10 (ten open run-authored proposals → the next debrief shows `skipped` with the `review-queue-full` sentence), 12 (a proposal with a script cannot be accepted until the reviewer ticks it).

### E5. Bots and Computers (done)

Done: see next-steps.md, "Lane E5". Bots is `/admin/bots` (with `?initiative=`); Computers is `/iq/computers`, and the two old computer routes redirect there.

Two pages replace five places:

- **Bots** (`/admin/bots`, `portal/src/pages/bots/`): one list of every bot and scheduled automation, with the initiative column; the initiative page's bot list becomes a link here filtered. `automateNav.tsx`'s "Automations" entry and "Bots" become one entry, "Bots".
- **Computers**: Local compute (`/iq/local-compute`, `portal/src/pages/local-compute/LocalComputePage.tsx`) and Computer Lab (`/admin/devbox`, `portal/src/pages/admin/DevboxPage.tsx`) become one page listing paired machines and lab machines together, with the same row shape (name, state, what it is running, last seen) and the existing actions; an org leader can start, stop and hand work to either kind. Keep the existing API calls; this is one page over two reads, not a new backend.

Acceptance: both pages render from a library template with no internal words; the command palette (`portal/src/components/shell/portalCommands.ts`) and the nav (`portal/src/components/shell/Layout.tsx`) have one entry each; the old routes redirect.

### E6. Removals (done)

Done, lane E6+E7, with the Definitions wording (the last of item 2) closed in lane E5; a removed path lands on "Page not found" by design (decision 20).

Delete, with their routes, fixtures, tests, breadcrumb cases (`portal/src/components/shell/breadcrumbResolve.ts`), command-palette entries and voice kinds (`portal/src/lib/voice/kinds.ts`); then regenerate `docs/voice-tool-inventory.json` (`node scripts/voice/inventory.mjs`) and check it (`--check`):

1. **Runbooks › Briefs**: `pages/runbooks/BriefsTab.tsx`, `BriefDocument.tsx`, `briefDocumentMarkdown.ts`, `BriefSkills.tsx`, `RunBriefPanel.tsx` where only Briefs used it, the `briefs` and `briefs/:ref` child routes (`App.tsx` around line 630), the breadcrumb case; the brief lives on the run page (E1). `GET /api/briefs` (`session-briefs.ts:98`) goes once nothing reads it; `GET /api/runs/:ref/brief` stays.
2. **Agent library Skills and Insights**: the two kinds in `pages/library/types.ts` and `libraryFormat.ts`, their filters, the seeded rows of kind `skill` and `insight` in `middleware/src/mock/prompt-library.ts`, `proposedKind: 'insight'` in `middleware/src/mock/promotions.ts`, and the kinds in the library routes' validation. Runbooks are the only catalogue of procedures.
3. **The initiative's lab memory rail**: `portal/src/components/marketplace/InitiativeLabMemoryRail.tsx` and its use in `pages/project-detail/InitiativeRail.tsx`. The `/api/lab/experiences` read and `lab remember` / `lab recall` on a devbox stay (design § Pages).
4. **Local compute › Configuration**: `pages/local-compute/ConfigurationPage.tsx`, its route and the `release` redirect (`App.tsx` lines 620 and 637), `pages/release/`, the command-palette entry; in the middleware `routes/session-bundle.ts`, `providers/session-bundle.ts`, `mock/session-bundle.ts`, its mount in `index.ts`, its entry in `mock/core/wire/write-policy.ts`, and what `lib/runbooks/skill.ts` and `routes/runbooks.ts` still import from it (keep the skill-library reads at `session-briefs.ts:167` and `:219`: decision 5 keeps the library installed on machines).
5. **Old redirects**: `promotions` and `promotions/:candidateId` (`App.tsx` 616–617, `pages/promotions/LegacyRedirect.tsx`), `distillation` and `distillation/*` (`App.tsx` 634–635, `pages/runbooks/DistillationRedirect.tsx`), and the `promotions`, `distillation` and `release` breadcrumb cases.
6. **Changes from the Automate rail**: the `CHANGES_ITEM` in `automateNav.tsx` (it belongs to the org graph, where `/admin/changes` stays).

Acceptance: `node scripts/docs/check-links.mjs` green (the removed-doc baseline `scripts/docs/removed-docs.txt` may grow by the removed pages' docs, ceiling 104 entries); the wire snapshots regenerated with the deleted routes gone and nothing else changed; the voice inventory check green; `scripts/validate-component-discipline.sh` green.

### E7. Rename (done)

Done. The pipelines tenant's "Runbooks" is **Workflows** at `/pipelines/workflows` (`portal/src/pages/pipelines/WorkflowsPage.tsx`), with `/pipelines/runbooks` redirecting; behaviour unchanged, and the API path `/api/pipelines/runbooks` stays (noted in the page's header comment). E6 items 2 to 6 are done with it; the removed `/iq/promotions`, `/iq/distillation`, `/iq/release` and `/iq/local-compute/configuration` paths now land on "Page not found", which is what decision 20 asks for (nothing links to them). The Definitions page's kind filter and rung label now say Workflow (lane E5 session).

### E8. The journey and the validator (done)

Done. `scripts/journeys/learning-loop.mjs` walks acceptance 1 to 12 through real dispatches on `dev:mock` (`npm run journey:learning-loop`, which boots its own middleware and Vite from `JOURNEY_MIDDLEWARE_PORT` and `JOURNEY_PORTAL_PORT`; `PLAYWRIGHT_BROWSERS_PATH` must name Playwright's browsers). `scripts/validate-learning-loop.sh` is the judge: the journey, `scripts/learning-loop/debrief-e2e.mjs` (13), `scripts/learning-loop/local-report-e2e.mjs` (14, ports `LL_DEBRIEF_PORT` and `LL_E2E_PORT`), the loop's middleware suites and the portal suite, one PASS or FAIL line per item. Lane E is done when it is green. What was built and decided is in `docs/next-steps.md`, "Lane E8".

## Verification before any merge

Run from your branch, against your own ports:

```
cd middleware && npx tsc --noEmit -p . && node node_modules/.bin/jest --config jest.config.cjs
cd portal && npx tsc --noEmit -p . && npm test
node scripts/voice/inventory.mjs && node scripts/voice/inventory.mjs --check
node scripts/docs/check-links.mjs
node scripts/content/check-story.mjs
cd portal && npm run journey:demo-moments && npm run journey:voice-coverage && npm run journey:leftovers2 && npm run journey:learning-loop
node scripts/learning-loop/local-report-e2e.mjs && node scripts/learning-loop/debrief-e2e.mjs
cd agents/devbox && python3 -m unittest discover        # Python 3.12 with schema/synth/requirements.txt
```

Recapturing the wire snapshots: boot the middleware with `npm run dev:mock`'s environment on a free `PORT` (without `tsx watch`), wait for `/api/health`, then `cd middleware && WIRE_BASE_URL=http://127.0.0.1:<port> npx tsx src/mock/core/wire/capture.ts`. A write route with no entry in `mock/core/wire/write-policy.ts` is recorded as "unclassified"; that is a visible gap, not an error, and is left visible until someone reads the handler and writes the entry.

Merge: rebase onto main, re-run the list above, fast-forward only. If the owner's dev servers are up, do not fast-forward while a voice session is open (the newest `middleware/.voice-log/*.jsonl` has no `closed` row).

## Middleware follow-ups (not lane E)

Small, separate changes; each needs its own test.

1. [done, lane C follow-up] **MicroVM debrief.** `middleware/src/lib/microvm-dispatcher.ts:818` records the run end but stops the machine before any debrief. It must call the devbox `debrief` op (`agents/devbox/main.py`, `_debrief_cmd` at line 1433) with the request `debriefRequestFor` (`middleware/src/lib/runbooks/debrief.ts:285`) builds, post the folder through the same settle path the local route uses (`routes/local-compute.ts:852`), and pass `hasCheckout: true` to `recordRunEnd`. Until then microVM runs record `skipped: executor-unsupported`.
2. [done, lane C follow-up] **Fleet and governed runs are not debriefed** (`executorDebriefs`, `debrief.ts:146`). Decide per executor whether a session can be resumed there; where it cannot, the skip stands (decision 1's last column).
3. [done, lane C follow-up] **Write-policy entries** for `PUT /api/graph/work-items/:id/runbook-pins` and `POST /api/local-compute/jobs/:jobId/debrief` in `mock/core/wire/write-policy.ts`, each with the six-rule note the file asks for, so the capture records their response shapes.
4. [done, lane C follow-up] **Scope matrix coverage.** `middleware/src/routes/__tests__/initiative-scope-matrix.test.ts` does not yet cover the runbooks routes or the local compute claim; add rows.
5. [done, lane C follow-up] **Seeded ledger rows for local compute**, so the Budgets › Lines report shows a reported figure on the mock instead of $0 until a worker runs.
6. [done, selected-row pickup] **Budgets at 1280 px**: `DataTable.revealSelection` in ui-components 2.522.0 reveals the selected row in table and card layouts; `InitiativesReport.tsx` opts in. The validator checks load and resize at 1440 and 1280 px.

## Open decisions the owner may overrule

Each is recorded in [learning-loop-decisions.md](learning-loop-decisions.md) with what would change it. Two that lane E touches directly: decision 20 (the removals) and decision 4 (runbook text in the brief). Build to the decision as written; do not reopen it in the lane.

One more the owner may overrule, outside the decisions file because it is the lab's, not the loop's: **the lab drive** (11 November 2026). `OperateDevbox` — provision, rename, stop and remove a lab computer — is its own Cedar action, held by sme, hr-admin and org-leader, and org-leader also holds `RunDevboxTask`; `ManageDevbox` (codebases, capability writes, session bundles) and the shell stay with the operators. To take the lab back from leaders, remove the two actions from `middleware/seeds/roles/orgiq/org-leader.cedar` and the matching rows in `authz-matrix.test.ts`, `cedar-policy-edges.test.ts` and `devbox-lab-drive.test.ts`; the Computers page then shows that role the read-only lab again on its own.
