# The learning loop: design (10 November 2026)

Work items are executed by agents. What a run learns should come back, be distilled into a runbook, be reviewed, and reach the next related run. This document replaces the pieces that were meant to do that and did not.

## What is wrong today

1. Nothing distils. The model-driven distillation tier was deleted on 15 October. A runbook is only proposed when the coding model volunteers a complete skill folder during its own run.
2. Local compute, the executor in daily use, has no return path. Skills flow down to it and nothing flows back.
3. A run dispatched on the mock is narrated and produces nothing, so the Runbooks pages only ever show seeded rows.
4. Nothing chooses runbooks for a run. The whole library is copied to every machine.
5. Nothing records which runbook a run used or whether it helped, so health never moves.
6. The same idea has several names and stores: three skill catalogues, two meanings of "runbook", raw lab notes, a promotions ladder with no page.
7. Budgets gate every executor except local compute, warn nobody before a cap, and have no line for learning.

## Vocabulary (one name each)

| Name | Meaning |
|---|---|
| Run | One execution of a work item (or a bot's task) by an executor. |
| Run report | What every run hands back when it ends. Structured, the same shape from every executor. |
| Lesson | A distiller's output for one run: nothing new, a new runbook, a revision of a runbook, or a suggestion to retire one. |
| Proposal | A lesson (or a run's own kept skill folder) waiting for a person's review. Existing store and review rule. |
| Runbook | A reviewed procedure. Delivered to machines as a Claude Code skill. One organisation-wide library. Existing store. |
| Offer | The runbooks chosen for a run when its brief is frozen. |
| Use | Evidence that a run loaded a runbook. |
| Workflow | What the pipelines area called a "runbook definition". Renamed; it is not a runbook. |

Retired names and stores: the asset library's `skill` and `insight` kinds (they point at Runbooks), the promotions ladder (deleted), lab "experiences" as a destination (they become distiller input), the job kind `local:consolidate` (deleted). `local:distill` is kept and becomes the distiller's local job kind.

## The loop

```
work item ──dispatch──▶ run ──ends──▶ run report ──▶ distiller ──▶ lesson ──▶ proposal
     ▲                   ▲                                                      │ review
     │                   └── offer (chosen runbooks, named in the brief) ◀── runbook library
     └────────────── evidence: offered, used, outcome, cost ◀── run report ─────┘
```

### 1. Run report

Every run ends with one report, stored once per run and never edited:

- `runRef`, work item, initiative, executor (`fleet`, `governed`, `microvm`, `local`, `mock`), model, started, ended.
- `outcome`: `done`, `failed`, `cancelled`, `needs-review`, with the failure code when there is one.
- `summary`: what was done, at most 1,200 characters.
- `changes`: files touched with added and removed line counts, and the change request id when a governed run made one. The diff itself stays where it is stored today.
- `verification`: commands the run used to check its work, each with pass or fail.
- `obstacles`: things that went wrong and how they were got round, at most eight short entries. This is the distiller's richest input.
- `runbooksOffered` (from the frozen brief) and `runbooksUsed` (see Evidence).
- `cost`: billed amount, and for local compute the amount the worker reported, marked as reported.
- `kept`: skill folders the run chose to keep, if any (today's `lab keep`).

Where it comes from:

- The server fills everything it already knows: the brief, the job row, the change request, the ledger.
- The worker supplies `summary`, `verification`, `obstacles` in a fenced block at the end of its final message (`lab-report`, JSON). The run framing asks for it in three lines. A missing or malformed block is not an error: the report is saved with those fields empty and flagged `selfReport: missing`.
- Local compute: the worker posts the report with its completion call. This is the return path that does not exist today. Kept skill folders in the checkout's `.lab/keep/` travel with it.
- Fleet and microVM: the existing `lab` hook posts the same shape.
- Mock: the simulated run writes a report from a small set of fixtures keyed by work item type, so the rest of the loop has something real to act on.

Everything a worker sends is untrusted text. It is stored as data, shown as text, and reaches a model only inside the untrusted-text fence.

### 2. Distiller

One job per finished run, idempotent on `runRef`. It runs after the report is saved, never inside the run.

Input: the run report, the diff (capped), the frozen brief, and the three most similar existing runbooks (names and their when-to-use lines).

Output: exactly one lesson.

- `none`: nothing a future run would need. The common case, and the cheapest. Recorded with a one-line reason.
- `new`: a complete runbook draft (when to use, steps, an offline Verify step, scope and labels).
- `revise`: a named runbook and the changed text, with why.
- `retire`: a named runbook the run was offered, did not need, and finished well without. Carries the model the run used. This is how the library shrinks as models improve.

A `new` or `revise` lesson is linted by the existing rules and enters the existing proposals queue with provenance (`source.run_ref`, `source.lesson`). A lint failure is kept on the lesson and shown; it does not reach the queue. A `retire` lesson becomes a retire proposal only after the same runbook collects three such lessons from three different runs within 30 days.

No self-accept, as today: a person with `ReviewRunbook` accepts, and never the person whose run produced it when another reviewer exists.

Where it runs, in this order:

1. Local compute, as job kind `local:distill`, when the organisation has a paired machine that accepts it. Costs nothing billed.
2. The server, with the configured Bedrock text model, through `reserveSpend` on the learning line.
3. Mock: a deterministic distiller that maps report fixtures to lessons, so the mock produces real proposals.

Skips are recorded, never silent: `skipped: learning-budget`, `skipped: no-report`, `skipped: run-failed-before-work`.

### 3. Offer (choosing runbooks for a run)

When a run's brief is frozen, the server chooses up to five runbooks for it:

- Candidates: published runbooks whose scope admits the work item's initiative and repository.
- Score: label overlap, token similarity between the work item (title, description, acceptance criteria, linked decision) and the runbook's when-to-use line and title, and health (proven above unproven above drifting).
- A runbook below the similarity floor is not offered. Offering nothing is a valid result.

The brief names the offered runbooks, one line each with the reason ("matches: auth, cutover"), and tells the worker to load those skills first. Procedure text still reaches a machine only as a skill; the brief carries names. The whole library is still synced, so the worker's own skill matching can pick up others.

The offer is stored on the brief (already write-once per run) and shown before dispatch in the work item's brief preview.

Embeddings are a later improvement behind the same function. The first version is lexical so it runs locally with no model.

### 4. Evidence

- `Use` is observed, not self-reported: the local worker and the devbox runner read the model's tool-call stream and record each skill the session loaded. `lab applied` remains as a second signal.
- The server writes an application row per used runbook from the report. Health (proven, drifting, unproven) starts moving for local runs.
- Per runbook, over a 30 day window: times offered, times used, outcome of the runs that used it, median billed cost and duration of those runs beside the same figures for runs of work items with the same labels that were not offered it. Shown as numbers with their sample size. With fewer than five runs on either side the page says "not enough runs to compare".
- Each runbook records the model its last three uses ran on. When the organisation's default model changes, runbooks not yet used on it show "unproven on <model>".

### 5. Budgets

- Thresholds: at 50, 80 and 100 percent of an initiative's cap, a user's budget and a grant, the owner (and at 100 percent the org leader) gets one bell notification per threshold per period, and the Budgets page marks the row. The percentages are configuration with those defaults.
- Local compute: its claim path goes through the same run limits and kill switches as every other executor. Its money stays at zero billed; the worker's reported figure is stored and shown as "reported, not billed".
- Learning line: a monthly organisation cap for server-side distillation, with a small default. At the cap the distiller skips and says so. Local distillation does not draw on it.

## Built from Anthropic's own components

The distiller, the runbook format and the evidence are built from the pieces Anthropic ships for the same job, not from home-grown equivalents. Names below are the documented ones.

| Need | Component | How it is used here |
|---|---|---|
| The unit of reusable procedure | Agent Skills (`SKILL.md`, progressive disclosure) | A runbook is a skill folder. Frontmatter keeps to the portable keys only: `name` (at most 64 characters, lowercase, digits and hyphens), `description` (at most 1,024 characters, says what it does and when to use it), `license`, `compatibility`, `metadata`, `allowed-tools`. Body under 500 lines; supporting files one level deep under `scripts/` and `references/`. The lint enforces this. |
| Writing a skill from experience | The `skill-creator` workflow (draft, test, grade, aggregate, improve) | The distiller is a headless Claude Code session that follows that workflow through a `distill-run` skill of our own. It drafts the runbook and at least three evaluation cases in `evals/evals.json`, taken from the run it is distilling. |
| Proof that a skill helps | skill-creator's benchmark: `with_skill` beside `without_skill` (or `old_skill` for a revision), and its trigger check | A trial job runs the proposal's evaluation cases both ways and checks that the description makes a session load it. The reviewer sees "passes 3 of 3 with, 1 of 3 without; loaded on 9 of 10 matching prompts" on the proposal. |
| Structured output from a headless run | `claude -p --json-schema` (result in `structured_output`) | The lesson is schema-checked output, never parsed prose. |
| Bounding an automated session | `--allowedTools`, `--max-turns`, `--max-budget-usd`, `--model`, `--permission-mode dontAsk` | The distiller reads its workspace and writes only inside it. No network, no shell beyond the evaluation scripts. |
| Seeing which skill a run loaded | The `Skill` tool call in `--output-format stream-json --verbose` | This is the observed Use. The transcript file is not parsed: its format is internal and changes. |
| Capturing the end of a run | The `Stop` hook's `last_assistant_message`; `SessionEnd` only enqueues (it has about 1.5 seconds and cannot block) | The run report's self-report block is read from the final message by the runner or the `Stop` hook. |
| Facts not yet worth a runbook | Claude Code's file memory: a `MEMORY.md` index of one-line pointers and one typed file per fact | The organisation's notes store uses this shape. The distiller reads the index, opens only what is relevant, and adds or corrects notes. A note that three runs lean on becomes a runbook proposal. This replaces lab "experiences". |
| The same on the API | The memory tool (`memory_20250818`: view, create, str_replace, insert, delete, rename) with a handler that maps `/memories` to the notes store | Used by the server-side distiller. The handler canonicalises every path, refuses traversal, caps file size, and treats what it reads as untrusted text. |
| Small context, fetched when needed | Just-in-time retrieval (Anthropic's context engineering guidance) | The distiller's inputs are files in a workspace (`report.json`, `diff.patch`, `brief.md`, `candidates/`), not one large prompt. |
| Long sessions | Compaction and context editing, paired with memory | Only the server-side distiller needs them, and only for a diff too large for one pass. |
| Cost | Prompt caching for the fixed instructions and schema; the Batch API for a backlog | A backlog of old runs is distilled in a batch at half price. |
| Promotion | Anthropic's harness rule: mark a feature passing only after an end-to-end check | An accepted runbook starts unproven and becomes proven only when a later run uses it and succeeds. |

Two things are deliberately not used because the official documentation does not describe them: a background "dream" consolidation pass, and hosted memory stores (the notes stay in this system's own storage).

Where the distiller runs is unchanged: the paired local machine first, running Claude Code on the smaller models. The server-side fallback produces the same skill folder and lesson schema with the configured Bedrock text model. Whether that fallback may be a Claude model on Bedrock is the owner's decision; until then it is Nova.

### What this changes above

- **Distiller output.** A `new` or `revise` lesson is a skill folder with `evals/evals.json`, not just text.
- **Trial.** After lint and before review, a trial job runs the evaluation cases with and without the skill on local compute. It is bounded (three cases, two arms, a turn limit) and skipped with a recorded reason when no machine is paired. A reviewer may accept without a trial; the proposal says it is untested.
- **Notes.** The notes store is added beside the runbook library. It is the distiller's memory, not something a run is sent.
- **Acceptance.** Item 2 also requires the proposal to carry its evaluation cases; a new item 11: on a test stack with a stub `claude`, a trial records a with and without result on the proposal.

## Pages

Decided from a walk of every page in the loop on the mock. One name per thing on screen: run, runbook, bot, computer.

Keep, as the spine:

- **Work item**: the Prepare job card and brief preview, now showing "Runbooks this run will get" with reasons.
- **Runs** (one list, under Operate): every run from every executor, with filters for queue, local and bot runs. The run record has Brief (what it was told), Report (summary, changes, verification, obstacles), Runbooks (offered, used) and Learned (the lesson and its proposal, or the skip reason).
- **Runbooks**: Library, Proposals, Evidence. A runbook's record shows its text, versions, the run it came from, offers and uses, trial results and health. Accepting a proposal asks for confirmation and says which runs it will reach.
- **Budgets**: threshold marks, the learning line, local runs as reported.

Merge:

- Briefs into the run record. A brief is a property of a run, not a destination.
- The Agent library's Skills and Insights into Runbooks.
- Automate › Runs and Local compute › Runs into Runs, as filters. The initiative's Agents tab links to Runs filtered to the initiative.
- Automations, Bots and the initiative's bot list into one page called Bots.
- Local compute and the Computer Lab into one page called Computers, with paired machines and fleet boxes as two groups. An org leader can drive it.

Remove: Local compute › Configuration (a mock-up), and Changes from Automate (it belongs to the org graph).

Rename: the pipelines area's Runbooks and Definitions become Workflows.

No internal words on screen: no hashes on rows, no "marketplace firing", "governed run (primary)", "session run", "box" or "devbox". Every page starts from a library template and uses library composites.

## What stays

- The runbook store: versions, proposals, applications, lint, the `ReviewRunbook` rule.
- The frozen brief and the claim-time framing as the two places a run's context passes through.
- `reserveSpend` as the one place money is reserved.
- Routes other features read: `/api/runs/:ref/brief`, `/api/runs/:ref/skills`, `/api/runbooks*`, `/api/lab/*`, `/api/work-items/:id/brief-preview`, and the search index's knowledge documents.
- Local compute runs the operator's own login on the smaller models only.

## Acceptance

On the mock, with no model and no cloud:

1. Dispatch a work item. Its run ends with a report visible on the run's page.
2. A lesson exists for that run. For a fixture that teaches something, a proposal is in Runbooks › Proposals naming the run it came from.
3. A reviewer accepts it. It is in the library.
4. Dispatch a related work item. Its brief preview names that runbook with a reason before dispatch; the run's page shows it offered and used.
5. The runbook's Evidence shows the use and its health is proven.
6. A run of an unrelated work item is offered nothing.
7. Three retire lessons for one runbook produce one retire proposal.
8. With the learning cap at zero and no paired machine, the lesson is `skipped: learning-budget` and the run page says so.
9. An initiative crossing 80 percent of its cap produces one bell notification and a mark on Budgets.
10. A local compute worker run against a test stack posts a report, and its run shows the reported cost as not billed.

`npm run journey:learning-loop` walks 1 to 9 in the browser. `scripts/validate-learning-loop.sh` runs the journey and the suites and is the judge.

## Build order

| Lane | Scope | Depends on |
|---|---|---|
| A | Run report: shape, store, routes, local worker and devbox return path, mock reports, use detection, application rows | none |
| B | Budgets: thresholds and notifications, local compute through run limits, learning line | none |
| C | Distiller: the `distill-run` skill, job, three executors, schema-checked lessons, skill folders with evaluation cases, notes store, proposals with provenance, retire rule | A |
| C2 | Trial: with and without runs of a proposal's evaluation cases, trigger check, results on the proposal | C |
| D | Offer: selection at brief freeze, brief text and fence, brief preview, evidence figures | A |
| E | Pages, vocabulary, removals, the journey and the validator | A to D and the page audit |
