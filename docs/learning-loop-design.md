# The learning loop

This replaces the earlier draft of this document in full. The decisions, one line each, are in [learning-loop-decisions.md](learning-loop-decisions.md).

## The problem

Agents execute work items. What one run works out, the next run on similar work should start with. Today it does not:

1. A finished run produces no runbook unless the working model volunteers a complete skill folder in the middle of its ticket. It almost never does.
2. Nothing chooses runbooks for a run. `selectRunbooks` exists (`middleware/src/lib/runbooks/select.ts`) and nothing calls it; the brief points at the whole library (`middleware/src/lib/runbooks/brief.ts`, `skillsPointer`).
3. Nothing a person can read shows whether a runbook reached a run or helped it.
4. The machine that used to sit here, three tiers and a compaction queue, used no model, was fed by no real run, and produced titles joined with semicolons. It was deleted because nobody could demo its output to a person.

The test of this design is not that rows move. It is that **a person can open a runbook that a run produced, read it, and would follow it**, and that the next related run demonstrably had it.

## The smallest loop that closes

```
                      ┌───────────────── runbooks given, with reasons ─────────────────┐
                      ▼                                                                 │
work item ─dispatch─▶ run ─ends─▶ report ─(worth it?)─▶ debrief turn ─▶ proposal ─review─▶ runbook
                      ▲                                  same session,    lint,           library
                      │                                  resumed          a person
                      └── previous attempts on this work item (from reports) ──┘
```

Five moving parts, each admitted because of one failure it prevents:

| Part | The failure it prevents |
|---|---|
| Run report (built) | The server knowing nothing of what a run did, so nothing downstream can exist. |
| Debrief turn | Runbooks written from a summary by something that was not there, or not written at all. |
| Review with lint | Text an agent wrote while reading an untrusted repository becoming instructions for future agents unread. |
| Giving runbooks to a run | A reviewed runbook sitting in a library that no run opens. |
| Evidence and retirement | A library that only grows, and a loop whose value nobody can state. |

Everything else in the previous draft is cut or deferred; see "What is cut".

## Stage 1. The run report (built)

Every run, from every executor, ends in one stored report: outcome, the worker's own summary, verification commands, obstacles, files changed, runbooks given and used, cost. One function assembles it (`recordRunEnd`, `middleware/src/lib/run-reports/record.ts`) and announces it (`onRunReportSaved`, same file). Local compute posts its half with the completion call (`tools/local-compute-report.mjs`); the worker's text arrives in a fenced `lab-report` block that is parsed tolerantly and treated as data (`middleware/src/lib/run-reports/self-report.ts`).

Two additions to the block, made in lane C:

- `learned`: one sentence, or empty. The framing asks: "Name one thing that cost you time in this run that a written procedure would have saved the next run on this kind of work. If nothing did, leave it empty."
- `runbooks`: for each runbook the run was given, `{ id, followed: "yes" | "partly" | "no", wrongStep?: number, note? }`.

One correction to what is built: today a runbook that a run loaded is recorded as having failed whenever the run failed (`record.ts`, the `appOutcome` branch). A run can fail for reasons that have nothing to do with the runbook, and health would drift by association. An application row is written from the run's own `runbooks` entry (followed, followed with deviation, failed at a step); a failed run that says nothing about a runbook writes no row for it.

## Stage 2. Who writes the runbook, and when

**Decision: the session that did the work writes it, in a second headless turn that resumes that session, and only when the run's report says there is something to write.**

The alternatives, and why each loses:

- *The working turn writes it unprompted.* This is what exists (`.lab/keep/`, asked for in `brief.ts` `reportSection`). It makes capture a voluntary, expensive side task of the ticket, so it does not happen.
- *A separate distiller session reads the report and the diff.* It is uniform and clean, and it writes from a 1,200 character summary of what the first session knew. The failed attempts, the file it had to read to understand the build, the command that finally worked: gone. This is how the deleted tier ended up producing text nobody would follow, with a model added.
- *Both in sequence, two sessions.* Twice the cost and the second still edits what it did not witness.

Resuming the same session keeps the entire context of the work, costs one extra turn, and lets the instructions for writing a runbook be one fixed, versioned prompt on the server, not something each ticket carries. Claude Code supports it headless: `claude -p "<prompt>" --resume <session-id> --fork-session --json-schema <schema>` (flags confirmed in the installed CLI's help; `--fork-session` leaves the work session's own record untouched). The local worker already runs `claude -p` with `--output-format stream-json --verbose` (`tools/local-compute-worker.mjs`, `runTask`) and the devbox runner already has a resume-by-id path (`agents/devbox/main.py`, `_build_cmd`). The work turn's `result` event carries the session id; the worker does not read it yet.

### When a debrief is worth running

A debrief runs only when all of these hold:

1. The run ended `done` or `needs-review`. A failed or cancelled run has no proven procedure to write down. Its lesson goes to the next attempt (stage 4), and becomes a runbook only if a later run succeeds and debriefs.
2. The report's `learned` is not empty, and it is corroborated: at least one obstacle, or a given runbook marked `partly` or `no` with a wrong step. A model asked "did you learn something" tends to say yes; requiring a concrete obstacle beside the sentence is the cheap check on that.
3. Fewer than ten run-authored proposals are open. A full review queue stops new debriefs (`skipped: review-queue-full`). The machine never outruns the people reading its output.
4. The organisation's daily debrief limit (default ten) is not reached, and for a billed executor the learning line has room (stage 6).

Every skip is stored on the run with its reason and shown on the run's page.

### What the debrief turn is asked for

The prompt lives in one file (`middleware/src/lib/runbooks/debrief.ts`, new), is versioned, and is the same for every executor. It asks for exactly one of:

- `none`, with a one-line reason. The expected answer most of the time.
- `revise`: a named existing runbook and its corrected full text. The session can read the library, because it is installed beside it (below), and it was told which runbooks it was given. It is told to prefer revising one of those to writing a new one.
- `new`: a runbook.

For `revise` and `new` the session writes a skill folder to `.lab/keep/<rb-name>/` in its checkout, which is the path the worker already reads and posts with every safety check in place (`tools/local-compute-report.mjs`, `middleware/src/lib/runbooks/keep.ts`): `SKILL.md`, and `scripts/` only when a script is the point. The structured answer names the folder; it does not carry the text.

The turn is bounded: read, search and write inside the checkout only, the same permission mode as the work turn, a dollar ceiling (`--max-budget-usd`), and a wall-clock timeout in the runner.

A runbook is an Agent Skill and is written to Anthropic's authoring guidance, which the prompt states as rules: the description says what it does and when to use it; the body is a procedure with commands that exist in this repository; it ends with a Verify step that can run offline; under 500 lines; supporting files one level deep. Frontmatter is limited to the portable keys (`name`, `description`, `license`, `compatibility`, `metadata`). `allowed-tools` is refused in a run-authored runbook: a runbook does not widen what a future run may do.

**The failure this stage prevents:** runbooks nobody would follow, because the writer was not there.

## Stage 3. From a kept folder to a runbook

**Decision: the existing proposal queue, lint and review authority are the gate, with four additions. Nothing a run writes reaches another run without a person.**

What exists and stays: proposals of kind `new`, `edit` and `retire` with a stale-base refusal on accept (`middleware/src/routes/runbooks.ts`), eighteen lint rules including real commands, a Verify step, no secrets, one subject, not generated filler (`middleware/src/lib/runbooks/lint.ts`), and review by the runbook's owner or an initiative's subject-matter expert under `ReviewRunbook`.

Additions:

1. **Narrow scope by default.** A run-authored runbook is scoped to the run's repository, or to its initiative when the run had no repository. It is never organisation-wide. Widening scope is a separate, confirmed action by a reviewer. A bad runbook then reaches the work it came from, not every run.
2. **Similar runbooks are shown, and a near duplicate is converted.** A `new` proposal whose text is close to a published runbook (the existing token similarity, `middleware/src/lib/runbooks/similarity.ts`) is filed as an `edit` of that runbook, so the reviewer sees a diff, not a second copy. This, with the debrief's instruction to revise first, is what keeps the library from growing by duplication.
3. **Scripts are read or they do not ship.** A proposal with files under `scripts/` shows each in full and cannot be accepted until the reviewer ticks that they read them. A script runs on future machines; prose does not.
4. **A sole reviewer is not locked out.** Today the person who dispatched a run may not decide its proposal (`routes/runbooks.ts`, the run-binding rule). In an organisation where nobody else holds review rights, that rule means nothing is ever accepted. When no other eligible reviewer exists, the dispatcher may decide, and the version records "accepted by its dispatcher, sole reviewer".

### Reviewable in under two minutes

The proposal page is one screen, in this order: the run's `learned` sentence; the runbook as it will read (for an edit, the diff against the current version); the lint result; the run it came from, with its summary, obstacles and verification beside the text, so the reviewer can check the procedure against what happened; whether that run's change was approved, sent back or is still waiting; similar runbooks. Then Accept, Edit then accept, Reject.

A proposal nobody decides in fourteen days is withdrawn as expired. A proposal whose run's change is rejected is withdrawn at once. The Proposals page shows, over thirty days, how many run-authored proposals were accepted, rejected and expired. If fewer than a third are accepted across the first twenty, the debrief trigger is too loose and is tightened before anything else is built.

**Is review alone enough?** No, which is why the scope is narrow, lint runs first, scripts need a tick, every version names the run it came from, and a runbook can be retired in one click with its effect immediate for new runs. Review is the gate; the others limit the damage when a reviewer skims.

## Stage 4. Giving runbooks to a run

**Decision: when a run's brief is frozen, choose up to two runbooks and put their text in the brief. Keep installing the library as skills.**

This reverses the 15 October rule that a brief carries no procedure text (`brief.ts`, header comment). The reasons:

- The stated purpose of the whole loop is that a related run has the runbook in its context. Text in the brief is the only delivery that is certain. Pointing at an installed library and relying on the model to load the right skill by its description is exactly what has been in place since October, with no evidence it works.
- The cost is small: two runbooks are a few hundred to a few thousand tokens against a run that spends hundreds of thousands.
- It works identically on every executor, including a local run with no repository, where no skills are installed at all (`middleware/src/lib/local-work.ts`, `localSkillsDir`).

The library is still installed as skills, in a devbox's skills folder and in a local run's checkout (`tools/local-compute-skills.mjs`), for two reasons: a runbook's scripts live there, and runbooks that were not chosen remain available to the model's own matching. That second path is now measured for free: every skill a session loads is observed in its event stream (`middleware/src/lib/run-reports/use-detection.ts`). Within a week of real use the reports show how often a session loads a runbook nobody gave it. If that number is healthy, the brief can go back to names only; the choice is recorded with what would change it.

How the two are chosen (`selectRunbooks`, as it stands):

- Candidates are published runbooks whose scope admits the work item's repository or initiative.
- A runbook a person pinned to the work item is always first. Pins are a field on the work item and a control in the brief preview. A person's judgement about which procedure applies beats token overlap, and the function already orders pins first; nothing sets them today (`middleware/src/lib/run-brief.ts`, `composeRunBrief` passes `pinned: []`).
- Then by score: scope, label overlap, token similarity between the work item and the runbook's title and when-to-use lines, health.
- A runbook with no label hit and no shared terms is not given. Giving nothing is a valid result and is shown as such.

Each given runbook appears in the brief under its title with the reason it was chosen ("pinned", "labels auth, cutover"), and with one warning line when its health is drifting (the warning text already exists, `middleware/src/lib/runbooks/health.ts`). The choice is stored on the frozen brief as `offer.runbooks`, the shape the report reader already expects (`record.ts`, `offeredFromBrief`). The work item's brief preview shows the same thing before dispatch.

Embeddings are not used. The library is small, the lexical score is explainable in a phrase a reviewer can read, and it runs with no model.

### Previous attempts

The brief gains one section: for the same work item, the last two runs' outcome, failure code, obstacles and, for a governed run, the reviewer's requested changes, read from run reports and the change request. This is where a failed run's lesson goes. It costs nothing to produce, needs no review because it instructs nothing, and it is the most direct form of "the next run knows what the last one found". The text is other runs' words, so it sits inside the untrusted-text fence as data.

### The brief's report section shrinks

The four `lab` lines the brief carries today (`brief.ts`, `reportSection`: `lab applied`, `lab propose`, `.lab/keep`, `lab remember`) are replaced by the `lab-report` ask alone. The debrief supersedes proposing; the report's `runbooks` field supersedes `lab applied`; the line telling a local run that it has no `lab` command (`local-work.ts`, `briefBlock`) goes with them. A work run is asked for one thing at its end.

**The failure this stage prevents:** an accepted runbook that no run ever sees.

## Stage 5. Evidence, and how the library stays small

Evidence is counted from report rows, never estimated, and always shown with its sample size.

Per runbook, over thirty days: runs it was given to; of those, how many said they followed it, followed it in part, or did not; how many of the runs that followed it ended done; and the list of those runs. Health (proven, drifting, unproven) is derived from the same rows as today.

For the loop as a whole, one line at the top of Runbooks: "In the last 30 days: N runs were given a runbook, M said they followed it, K of those finished. P proposals from runs: A accepted, R rejected, E expired. Debriefs cost $X billed and $Y reported." That line is the answer to whether the loop is worth its cost. A comparison of cost or duration against runs that had no runbook is shown only when both sides have at least five runs of work items sharing a label; otherwise the page says there are not enough runs to compare. No number on these pages is an aggregate kept separately from its rows.

The library stays small by three rules, none of which is a queue or a pass:

1. **Revise before adding** (stages 2 and 3).
2. **Retire by disuse.** A published runbook given to at least five runs in sixty days and followed by none, or given to no run in ninety days, gets one `retire` proposal, filed when a report is saved.
3. **Retire when a model no longer needs it.** The report's `runbooks` entry carries `followed: "no"`. When three consecutive successful runs on the organisation's current default model were given a runbook and did not follow it, it gets one `retire` proposal naming those runs and that model. This is the whole mechanism for "as models improve, the old lessons go": no trial harness, three runs' own accounts and a person's click.

Each runbook records the models its recent followed runs used, so after a model change the page can say "not yet followed on <model>".

**The failure this stage prevents:** a library of stale procedures steering better models wrong, and a loop nobody can justify.

## Stage 6. What the loop may spend

Built in lane B, used here unchanged:

- Bell notifications at 50, 80 and 100 percent of an initiative's allocation, a user's budget and a grant.
- Local compute passes the same run limits and kill switches as every executor at claim time; its money is zero billed and the worker's figure is stored as reported.
- A monthly learning line with a cap an org leader sets, and `reserveLearningSpend({ runRef, estimate })` with settle and release (`middleware/src/lib/learning-budget.ts` on the budgets branch).

The debrief is the loop's only model spend. On a billed executor the server reserves on the learning line before it asks for a debrief, passes the same figure as the turn's dollar ceiling, and settles with what the turn reports. At the cap the debrief is skipped with `skipped: learning-budget`. On local compute nothing is billed; the worker's reported figure is recorded. The daily debrief limit applies to both.

There is no server-side model call anywhere in the loop, so there is no choice of server-side model to make.

## Anthropic's components: used, and not

Used because they are the natural fit:

| Component | Use |
|---|---|
| Agent Skills (`SKILL.md`, progressive disclosure, the portable frontmatter keys and limits) | The format of every runbook, and how the library is installed. |
| Skill authoring guidance (description states what and when; short body; one level of supporting files) | The rules in the debrief prompt and in lint. |
| Headless Claude Code: `--resume`, `--fork-session`, `--json-schema`, `--allowedTools`, `--permission-mode`, `--max-budget-usd`, `--output-format stream-json --verbose` | The debrief turn and its bounds; the work turn as today. |
| The `Skill` tool call in the event stream | Observing which installed skills a session loads. |

Not used, and why:

- **The skill-creator loop.** It is an interactive cycle of drafting, benchmarking and revising with a person. Its conventions are adopted; its loop is not run headless.
- **The memory tool, context editing, compaction.** They serve a long-lived agent on the API. There is none here: Claude Code manages its own context, and run reports are the durable record.
- **The Batch API.** There is no server-side distillation to batch.
- **Hooks.** The runner owns the process and reads its stream. The session-end hook has about a second and a half and cannot block.
- **Hosted memory stores and any background consolidation pass.** Not confirmed in the official documentation.

## The mock

The browser loop must work with no model, and the mock must not become the product.

- A simulated run ends with a report from a small, hand-written fixture set (built: the logout cookie bug teaches something, the tenant cutover run follows `rb-tenant-cutover`, a dashboard item needs nothing, the cold-start bug fails).
- The mock's debrief returns a hand-written runbook folder for the one fixture that teaches something. It is a real procedure in the demo story's world that passes every lint rule. It is never assembled from strings at run time.
- Everything a simulated run produced carries a "Demo data" mark on the run, the proposal and the runbook version, and the run's Learned section says the run was simulated.
- The two acceptance items that prove the loop outside the mock use the real worker and the real `claude` invocation against a stub binary and a throwaway repository, and spend nothing.

## Pages

Five nouns on screen: run, runbook, proposal, bot, computer. "Brief", "report" and "learned" are sections of a run, not places.

- **Work item.** The dispatch card and brief preview show "Runbooks this run will get" with reasons, a control to pin or unpin, and previous attempts.
- **Runs.** One list under Operate for every executor, with filters for queue, local and bot runs and for an initiative. A run's page has: Brief (the frozen text), Report (summary, changes, verification, obstacles), Runbooks (given, and what the run said of each), Learned (the proposal it produced, or why there was no debrief).
- **Runbooks.** Library, Proposals, and the evidence line. A runbook's page shows its text, versions, the run each version came from, the runs it was given to, and health. Accepting a proposal asks for confirmation and states its scope.
- **Budgets.** As lane B built it.

Merged into those: Runbooks › Briefs (into the run), Automate › Runs and Local compute › Runs (filters on Runs), the initiative's Agents › Runs (a link to Runs filtered), Automations and Bots and the initiative's bot list (one page, Bots), Local compute and Computer Lab (one page, Computers, which an org leader can drive).

Removed:

- Local compute › Configuration, which is a mock-up, and with it the remaining session-bundle code and `liveBundleSkills` (`run-brief.ts`), which lists seeded skills in every devbox brief that nothing installs.
- The Agent library's Skills and Insights kinds, their filters and seeded rows. Runbooks are the only catalogue of procedures.
- The initiative's lab memory rail. `lab remember` and `lab recall` keep working on a devbox; nothing in this loop reads those notes, and a read-only rail of raw notes is a second place to look for lessons.
- Changes from the Automate rail (it belongs to the org graph), and the redirects at `/iq/promotions` and `/iq/distillation`.

Renamed: the pipelines area's "runbook" definitions become Workflows. They are a different thing and keep their behaviour.

No internal words on screen: no hashes on rows, no "marketplace firing", "governed run (primary)", "session run", "box" or "devbox". Every page starts from a library template and uses library composites.

## What is cut, and what would bring it back

| Cut from the previous draft | Why | Comes back when |
|---|---|---|
| A separate distiller job with three executors and a server-side model | It writes from a summary. The session that did the work writes better, and costs one turn. | Never as designed. If sessions cannot be resumed on some executor, that executor skips debriefs. |
| "Lesson" as a stored thing | A debrief's answer is a proposal or a skip reason on the run. A third record adds a noun and a table. | Not expected. |
| The notes store | A second memory to curate. Previous attempts in the brief cover what a note was for. | Runs repeatedly rediscover a fact that is not a procedure. |
| Evaluation cases with every proposal, and with/without trials | Nothing reads the cases until trials exist, and trials double the cost of every proposal. | Proposals arrive faster than a person can judge by reading, or accepted runbooks are often retired unused. |
| The consolidation pass | The library has seven runbooks, every addition is reviewed, and near duplicates are converted to edits. | About fifty runbooks, or reviewers meeting duplicates. |
| Embedding retrieval | Not needed at this size; lexical reasons are readable. | The right runbook exists and is not chosen, more than occasionally. |
| "Also available" list in the brief | The library is installed and Claude Code lists it. | Not expected. |
| Compare a brief with the previous run's | Previous attempts answers the question it was for. | Not expected. |
| `lab applied`, `lab propose`, voluntary `.lab/keep` in the brief | Replaced by the report's `runbooks` field and the debrief. | Not expected. |

## Acceptance

In the browser, on the mock, with no model:

1. Dispatch the logout cookie bug. Its run's page shows the report: summary, verification, obstacles, and the `learned` sentence.
2. The run's Learned section links to a proposal. The proposal page shows the runbook's full text, a passing lint result, and the run's obstacles beside it, with the "Demo data" mark.
3. A second persona accepts it. The confirmation states its scope (the run's repository). It is in the library with a version that names the run.
4. Open a related work item. Its brief preview lists that runbook with the reason, before dispatch. Pin a second runbook; it appears first.
5. Dispatch it. The run's Brief shows the runbook's text; its Runbooks section shows it given and followed.
6. The runbook's page lists that run, and its health is proven. The evidence line on Runbooks counts it.
7. Dispatch the dashboard item. It is given nothing, and its Learned section says why there was no debrief.
8. Dispatch the cold-start bug, which fails. Dispatch it again: the second run's brief shows the first attempt's outcome and obstacles under previous attempts.
9. A runbook given to three successful runs that each did not follow it has one retire proposal naming them.
10. With ten run-authored proposals open, a run that would debrief shows `skipped: review-queue-full`.
11. An initiative crossing 80 percent of its allocation produces one bell notification and a mark on Budgets (built in lane B).
12. A proposal with a script cannot be accepted until the reviewer ticks that they read it.

Outside the mock, spending nothing:

13. The real local worker, against a test stack and a throwaway repository, with a stub `claude` on the path that plays a recorded stream: the work turn's report is stored with its session id; the server asks for a debrief; the worker runs the resume invocation with the expected flags; the kept folder becomes a proposal that passes lint.
14. The same harness with a brief that gives a runbook: the prompt the stub receives contains the runbook's text and the previous-attempts section inside its fence, and the report records the runbook as followed.

`npm run journey:learning-loop` walks 1 to 12. `scripts/validate-learning-loop.sh` runs the journey, items 13 and 14, and the suites, and is the judge.

## Build lanes

Lanes A and B are done or landing. C and D can run together after B merges; E follows both.

**A. Run report (merged).** `middleware/src/lib/run-reports/*`, the completion path in `middleware/src/routes/local-compute.ts`, `tools/local-compute-report.mjs`, three read routes in `middleware/src/routes/session-briefs.ts`.

**B. Budgets (built, merging).** Thresholds and bells, the local claim gate, the learning line and `reserveLearningSpend`, the Budgets page, the first step of `scripts/journeys/learning-loop.mjs`.

**C. Debrief and review.** Depends on A and B.
- `lab-report` gains `learned` and `runbooks` (`run-reports/self-report.ts`, `types.ts`); application rows follow the run's own account (`record.ts`).
- `middleware/src/lib/runbooks/debrief.ts`: the prompt, the answer schema, the decision whether to debrief with its skip reasons, the queue and daily limits, the reservation on the learning line.
- Local: the completion response carries a debrief request; `tools/local-compute-worker.mjs` reads the session id from the work turn, runs the resume turn, and posts the kept folder to a new `POST /api/local-compute/jobs/:id/debrief`. Devbox and microVM: the same in `agents/devbox/main.py`.
- Mock: the hand-written runbook fixture and the "Demo data" mark.
- Proposals: narrow default scope, conversion of a near duplicate to an edit, the scripts tick, the sole-reviewer exception, expiry at fourteen days, withdrawal when the run's change is rejected (`routes/runbooks.ts`, `lib/runbook-review.ts`); lint for portable frontmatter and refused `allowed-tools` (`lib/runbooks/lint.ts`).
- Retire proposals by disuse and by three unfollowed runs, filed on report save.
- Acceptance 13.
- Must not touch: `brief.ts`, `select.ts`, `run-brief.ts`, portal pages.

**D. Giving runbooks to a run.** Depends on A.
- `selectRunbooks` wired into `composeRunBrief` (`run-brief.ts`); a pins field on the work item with its route and provider parity.
- `brief.ts`: given runbooks with text, reasons and the drift warning, at most two within the budget; `offer.runbooks` stored; the previous-attempts section inside the untrusted-text fence; the report section reduced to the `lab-report` ask; `liveBundleSkills` and the "Skills on this box" section removed.
- `local-work.ts`: the framing lines about `lab` removed.
- Brief preview route returns the offer and previous attempts.
- The evidence figures as one read (`GET /api/runbooks/evidence`, and per runbook), counted from rows.
- Acceptance 14.
- Must not touch: `run-reports/*`, `routes/local-compute.ts`, `tools/local-compute-worker.mjs`, proposals code, portal pages.

**E. Pages.** Depends on C and D.
- The run's page, the single Runs list and its filters, the work item's brief preview with pins, Runbooks with proposals as specified and the evidence line, Bots, Computers.
- The removals and the rename listed under Pages, with their routes, fixtures and SQL.
- The journey for acceptance 1 to 12 and the validator.
- Must not touch: middleware logic beyond the routes the removals delete.

Each lane regenerates the wire snapshots from its own server and explains every changed row.

Lanes A to D are on main. The work order for lane E, the journey, the validator and the middleware follow-ups is [learning-loop-handoff.md](learning-loop-handoff.md): routes and shapes with file and line, the eight page packages with their acceptance, the verification list and the rules that bind the work.

## Risks

- **A session cannot be resumed.** The session file must still exist on the machine and the checkout must be in place. The worker keeps the checkout until the debrief is posted or refused. Where resume fails the run records `skipped: session-unavailable`; nothing else depends on it.
- **The debrief says yes too often.** The corroboration rule, the queue limit and the acceptance rate are the checks. If acceptance is under a third after twenty proposals, tighten the trigger before building further.
- **Text in the brief displaces the task.** At most two runbooks, inside the existing token budget, dropped whole when they do not fit, with the task never truncated to make room.
- **A person accepts without reading.** Narrow scope, lint, the scripts tick and one-click retirement bound the result.
- **A run's own account of what it followed is wrong.** It is the only signal that exists for text in a brief. The pages label it as what the run said, and retirement needs three runs to agree.
- **Unproven on AWS.** The fleet and microVM executors have not run there. The loop is proven on local compute first; a cloud executor's debrief is the same invocation.
