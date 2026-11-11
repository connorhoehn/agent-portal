# Creating an initiative by hand

Package 14 of the [value sweep](value-sweep-2026-11-11.md). Until now an initiative existed only because the seed or ingestion wrote it: `middleware/src/routes/projects.ts` reads and patches, and nothing inserts. A real organisation cannot start work that way. This page is the design and its decisions; each can be overruled.

## What a person does

On the Initiatives list a person who may create one sees **New initiative**. The form asks for a name, a short summary of what it is for, an owner (themselves by default), and optionally a sponsor and a repository. Filing it opens the new initiative's page, where the existing tabs take over: work items, decisions, bots, and the Learning tab, all empty and each saying what would fill it.

## Decisions

| # | Decision | Reason | What would change it |
|---|---|---|---|
| 1 | Creating an initiative is its own authority, the Cedar action `CreateInitiative`, held by org-leader and program-owner. Admin passes as it does everywhere. | It is a distinct act from governing runs or budgets, and the seeds should say who holds it in one line. | A role is found that should create but not steward. |
| 2 | The server makes the id: `p-` and a slug of the name, with a number added on a collision. The caller never supplies it. | Ids appear in scopes, briefs and links; a caller-chosen id could collide with or imitate another initiative. | Nothing. |
| 3 | The name is required, at most 80 characters, and unique within the tenant without regard to case. A duplicate is refused with the existing initiative named. | Two initiatives with one name cannot be told apart in a filter or a runbook's scope. | Organisations that reuse names across years; then add the year, do not relax the rule. |
| 4 | The creator is the owner unless they name another person from the directory, and the owner is a contributor from the first moment. | The "mine" rule (`lib/initiative-scope.ts`) decides who stewards runbooks and proposals; an initiative with no one on it would have no reviewer below org-leader. | Nothing. |
| 5 | A new initiative starts in the earliest status the data already uses, with no budget, no bots and no repository unless one is given. A repository is `owner/name` and is only recorded; nothing is cloned or checked. | Creation should not spend, dispatch or reach outside. | Nothing. |
| 6 | A hand-made initiative and an ingested one are the same kind of row. Ingestion that later meets the same name merges into the existing row and does not make a second. | One list, one page, one scope. | Ingestion's merge key turns out not to be the name; then the create route writes whatever key it uses. |
| 7 | No delete. An initiative made by mistake is closed through the status it already has. | Runs, reports, runbooks and spend point at initiatives; removing one would orphan them. | Nothing. |
| 8 | The write uses only the columns the projects table already has. No migration. The mock store gets the same insert so the feature works with no database. | Local first; a migration that is never run automatically would leave the feature broken where it matters. | A needed field has no column; then it waits for a migration and the form leaves it out. |
| 9 | The Initiatives list's empty state keeps pointing at ingestion for people who cannot create, and offers New initiative to those who can. | The old copy was right for most people and wrong for the ones who can now act. | Nothing. |

## What is checked

- A member, an SME and an HR admin are refused; an org leader and a program owner succeed; nobody creates in another tenant.
- A duplicate name is refused, in any letter case.
- The created initiative appears in the list, opens, and counts its creator as owner and contributor.
- The matrix and Cedar suites pin who holds `CreateInitiative`.
- The value-sweep journey creates one in the mock and lands on its page.

## Left out

Templates, copying an initiative, importing work items at creation, and setting a budget in the same form. Each is a separate piece of work and none blocks starting an initiative.
