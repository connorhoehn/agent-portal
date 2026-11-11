# The learning loop: decisions

One line each. The reasoning is in [learning-loop-design.md](learning-loop-design.md). Each can be overruled; the last column says what would change it.

| # | Decision | Reason | What would change it |
|---|---|---|---|
| 1 | The session that did the work writes the runbook, in a second headless turn that resumes it. No separate distiller. | It has the whole context of the work; a distiller reads a summary. | Sessions cannot be resumed on the executors in use. |
| 2 | A debrief runs only after a successful run whose report names something learned and at least one concrete obstacle. | Most runs teach nothing; a model asked alone says yes. | Fewer than a third of the first twenty proposals are accepted: tighten. Good lessons are being missed: loosen. |
| 3 | A failed run writes no runbook. Its outcome and obstacles are shown to the next attempt at the same work item. | Only a procedure that worked is worth following. | Failed runs keep hitting the same wall across different work items. |
| 4 | Given runbooks go into the brief as text, at most two. This reverses the 15 October rule. | Delivery is the point of the loop and text is the only certain delivery. | A week of reports shows sessions reliably load installed skills on their own: return to names only. |
| 5 | The library is still installed as skills on every machine that can take it. | Scripts live there, and loads of runbooks nobody gave are observed for free. | Nothing. |
| 6 | Runbooks are chosen by the existing lexical selector, with a person's pins first. No embeddings. | Small library; a reason a person can read; no model needed. | The right runbook exists and is not chosen, more than occasionally. |
| 7 | Every runbook from a run is reviewed by a person before any run gets it. | It is instructions for future agents, written by an agent that read an untrusted repository. | Nothing. |
| 8 | A runbook from a run is scoped to that run's repository or initiative, never the organisation. | A bad one reaches only the work it came from. | A reviewer widens a specific runbook. |
| 9 | A near duplicate of a published runbook is filed as an edit of it. | The reviewer sees a diff, and the library does not grow by copies. | Edits are regularly wrong matches. |
| 10 | A proposal with scripts cannot be accepted until the reviewer ticks that they read them. | Scripts run on future machines. | Nothing. |
| 11 | When nobody else can review, the person who dispatched the run may decide its proposal, and the record says so. | Otherwise a one-person organisation never accepts anything. | A second reviewer exists. |
| 12 | At most ten run-authored proposals are open; more debriefs are skipped. Unreviewed proposals expire in fourteen days. | The machine must not outrun the people reading it. | Review keeps pace and good proposals are being skipped. |
| 13 | A runbook is retired by proposal when unused for the set period, or when three successful runs on the current model were given it and did not follow it. | This is how old lessons leave as models improve, with no trial machinery. | Runbooks are retired that later prove needed. |
| 14 | No consolidation pass, no notes store, no automated trials, no evaluation cases. | None is needed to close the loop at seven runbooks. | About fifty runbooks, duplicates at review, or proposals arriving faster than they can be read. |
| 15 | Evidence is counted from report rows and shown with its sample size. Comparisons need five runs on each side. | Small samples; no figure that cannot be traced to its rows. | Nothing. |
| 16 | The loop's only model spend is the debrief turn, reserved on the learning line for billed executors and capped per day. | One place to see and stop what learning costs. | Nothing. |
| 17 | No server-side model anywhere in the loop. | Nothing server-side needs one once the working session writes the runbook. | A separate distiller is ever reinstated. |
| 18 | Anthropic's skill format, authoring guidance, headless flags and observed skill loads are used. The skill-creator loop, memory tool, compaction, Batch API and hooks are not. | Each used piece fits a need here; the others serve agents this system does not have. | A long-lived API agent is added. |
| 19 | The mock's reports and its one produced runbook are hand-written and marked as demo data. | The loop must be walkable with no model, without generated text passing as knowledge. | Nothing. |
| 20 | Five nouns on screen: run, runbook, proposal, bot, computer. Briefs, the Agent library's Skills and Insights, the lab memory rail and Local compute's Configuration page go. | One name per thing; no page that shows only seeded or retired data. | A removed page turns out to have a real user. |
| 21 | The work run is asked for one thing at its end: the report block. The `lab applied`, `lab propose` and voluntary keep lines leave the brief. | The debrief and the report replace them, and a ticket should not carry side tasks. | Nothing. |
| 22 | A runbook's failure is recorded from the run's own account of it, not from the run having failed. | A run fails for many reasons; health should not drift by association. | Nothing. |
| 23 | The brief and the runbook's record print a health warning for an unproven runbook whose last run failed, not only for a drifting one. | The warning already existed; an unproven runbook whose only run failed is the riskier of the two. | Runs reporting that the warning made them skip a runbook they should have followed. |
