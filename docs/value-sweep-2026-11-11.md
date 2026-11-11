# Value sweep: initiatives, runs, runbooks (11 November 2026)

A read-only sweep of the orgiq tenant for software a person would clearly want and that the code is one step short of. Three passes read the code: initiatives and work items; the learning loop (reports, debrief, runbooks, proposals, evidence, retirement); dispatch and the links between records (bots, runs, budgets, the bell, search). Every finding was confirmed against the code at the lines given. Left out on purpose: phones and tablets, cloud and deployment, real machines and microVMs, sign-in hardening, visual polish.

The loop's decisions ([learning-loop-decisions.md](learning-loop-decisions.md)) were checked on the way: rows 3, 9, 12, 13 and 15 are all built. What follows is new work, not unfinished work.

## The short version

The loop works, but its records do not point at each other, and nobody is told when it needs them. A work item's past attempts do not open their runs; a run does not open its work item or initiative; an initiative shows nothing the loop learned about it; a proposal waits fourteen days and expires without anyone being told. Fixing the links and the notice is small and makes everything already built reachable. After that, the two adds with the most new value are writing a runbook by hand and a list of obstacles that runs keep hitting.

## Packages, in build order

Size: S is under a day, M a few days, L needs a design first. "Mock" says whether the demo data already supports the feature.

| # | Package | What a person gains | Size | Mock |
|---|---|---|---|---|
| 1 | Threads between records | From a work item to its runs, from a run to its work item, initiative and change request, from a runbook to its runs | S | yes |
| 2 | Proposal notices | A reviewer learns from the bell and the rail that a proposal waits, and again before it expires | S–M | yes |
| 3 | Write a runbook by hand | A person who knows a procedure adds it without waiting for a run to discover it | S | yes |
| 4 | The initiative's Learning tab | One place on the initiative for its runs with outcomes, its runbooks and its open proposals | M | yes |
| 5 | Why a runbook was not chosen | Next to the pin, the in-scope runbooks the selector passed over and why | S | yes |
| 6 | Obstacles hit more than once | A list of walls that runs keep hitting, each with "write a runbook for this" | M | needs rows |
| 7 | Act on a failed run | Retry from the run's own page with the failure in view | S–M | yes |
| 8 | A bot's runs and what it learned | Bot firings open the run record; outcomes, cost and proposals per bot | M | yes |
| 9 | Bring a retired runbook back | Restore by proposal, so review stays in the path | S | yes |
| 10 | Search runs by text | Find "the run that hit the CSRF gate"; runs, proposals and runbook bodies in the org index | M | yes |
| 11 | Who would receive this proposal | The reviewer sees the open work items the proposed text would reach | M | yes |
| 12 | My work across initiatives | One table of a person's work items over every initiative | M | yes |
| 13 | Spend by bot, opened to its runs | "What did this bot cost this month", with the runs behind the figure | M | unverified |
| 14 | Create an initiative | The largest gap for a real user; needs a storage write and governance rules | L | no |

## Evidence

**1. Threads between records.**
- A work item's "Previous attempts" shows outcome, summary and obstacles with no link to the run (`portal/src/pages/runbooks/WorkItemRunbooks.tsx:89-99`); the run page exists at `/iq/runs/:ref` (`portal/src/pages/iq/RunsPage.tsx:61`).
- The run page prints the initiative as plain text and never shows the work item or change request, though both are in the row (`portal/src/pages/iq/RunPage.tsx:88-93`, `runsModel.ts:23,31`).
- The report store filters by work item (`middleware/src/lib/run-reports/store.ts:47`) but the route never reads the parameter (`middleware/src/routes/run-reports.ts:37-62`); the Runs filters are executor, initiative, outcome and debrief only (`portal/src/pages/iq/runReportCommands.ts:3`). Add work item and runbook filters.
- The runbook record names its scope initiative as text (`portal/src/pages/runbooks/RunbookRecord.tsx:83`).

**2. Proposal notices.** `notify()` is used for document proposals (`middleware/src/providers/document-proposals.ts:100`) and budget alerts (`middleware/src/lib/budget-thresholds.ts:196`). `middleware/src/routes/runbooks.ts` never calls it: not at filing (`:608`), not at accept or reject (`:711`, `:870`), and the expiry sweep (`lib/runbooks/retire.ts:26`) is silent. The rail's "needs you" count sums queue reviews and graph proposals only (`portal/src/components/shell/Layout.tsx:443`).

**3. Write a runbook by hand.** The server accepts a `kind: 'new'` proposal from a person (`middleware/src/routes/runbooks.ts:613`). The portal's only create call edits an existing runbook (`portal/src/pages/runbooks/RunbookRecord.tsx:290`), and the Library's empty state has no action (`LibraryTab.tsx:66`). A hand-written runbook still goes through review (decision 7).

**4. The initiative's Learning tab.** The initiative's tabs are overview, work, docs, decisions, agents, contributors, activity (`portal/src/pages/ProjectDetailPage.tsx:141`); none reads runbooks, proposals or run reports. `GET /api/initiatives/:id/run-reports` exists and nothing calls it (`middleware/src/routes/session-briefs.ts:196`). The runbook list filters by scope (`routes/runbooks.ts:453`); the proposal list has no scope filter (`:475`). The Agents tab's runs table reads bot runs, so it has no outcome, failure code or learned mark (`portal/src/pages/project-detail/InitiativeRail.tsx:95`). The overview's "Needs attention" lists blocked items only (`project-detail/overviewModel.ts:103-130`): failed runs this week and proposals awaiting review belong there.

**5. Why a runbook was not chosen.** The selector returns each excluded runbook with a reason (`middleware/src/lib/runbooks/select.ts:55`); the preview drops the list and sends one sentence (`session-brief-preview.ts:120`), which is all the work item panel shows (`WorkItemRunbooks.tsx:60`). Decision 6 is to be judged on "the right runbook exists and is not chosen"; this is how a person sees that.

**6. Obstacles hit more than once.** Obstacles are stored per report (`lib/run-reports/types.ts`) and read only per work item (`lib/run-brief.ts:135`). Nothing groups them by repository or initiative. Decision 3 names its own trigger as failed runs hitting the same wall across work items; this list is that trigger made visible, and its action opens package 3 with the obstacle filled in.

**7. Act on a failed run.** The run page has no action. Requeue lives only in the Findings failed view (`portal/src/pages/work/FindingsPage.tsx:183`, `middleware/src/routes/work.ts:348`); the Runs commands say they do not retry (`RunsPage.tsx:89`).

**8. A bot's runs and what it learned.** Bot firing rows link to the project or the job, never to `/iq/runs/:ref` (`portal/src/pages/bots/BotDetailPage.tsx:203-212`). The Runs list has no bot filter (`RunsPage.tsx:103-108`) and a report carries no bot field (`lib/run-reports/types.ts:150-187`); the join today is by job id (`BotDetailPage.tsx:152`).

**9. Bring a retired runbook back.** The retire route refuses an already retired runbook (`routes/runbooks.ts:981`) and there is no restore. Decision 13 lists "runbooks are retired that later prove needed" as what would change it.

**10. Search runs by text.** The Runs search matches loaded titles on the client and stops at 200 rows (`RunsPage.tsx:38,81,101,115`). The org index has no run or proposal type (`lib/search-index/orgiq.ts:29`) and indexes a runbook's title and summary, not its body (`:155`).

**11. Who would receive this proposal.** Reach is computed only to detect duplicates (`routes/runbooks.ts:341`); the reviewer sees a diff and lint results.

**12. My work across initiatives.** `GET /api/graph/work` takes label, team, sprint, status and period (`routes/work-items.ts:305-342`); the portal calls it with a sprint or bare (`pages/sprints/SprintBoard.tsx:181`, `RunsPage.tsx:43`).

**13. Spend by bot.** Spend groups by initiative, person, model, source and trigger (`pages/budgets/spendReportModel.ts:11-17`); the group table shows an entry count with no way through to the entries (`SpendGroupTable.tsx:66-74`). Whether ledger rows carry a bot or job id was not checked, so the size may grow.

**14. Create an initiative.** `middleware/src/routes/projects.ts` has reads and a patch only (`:46-168`); nothing inserts a project. Initiatives come from the seed or from ingestion. This needs a short design (who may create one, what it must carry, how it meets ingested ones) before any code.

## One cleanup

The `local:distill` job kind is still allowed (`middleware/src/lib/local-work.ts:44`, `providers/agent-jobs.ts:136`) and seeded on mock machines (`mock/local-compute.ts:219,393`), though decision 1 removed the distiller. Check whether anything still enqueues it; if not, remove the kind and the seed rows.

## Not found

Bulk decisions on proposals, gaps in the proposal diff view and missing proposal caps were looked for and not confirmed; the diff route, review page and caps exist. Whether the person who dispatched a run is told when it ends was not checked.
