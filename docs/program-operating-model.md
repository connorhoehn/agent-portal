# Program operating model

How work, people, money and agents relate in OrgIQ. This is the frame the
seeded data, the Cedar roles and the budget tables all encode — read it before
adding a surface that touches initiatives, budgets or the work queue.

The shape is SAFe-adjacent without the ceremony: a program layer that allocates
money and cadence, an execution layer where SMEs spend it, and agents as the
capacity being bought. What is deliberately *not* borrowed is the assumption of
a ten-person team per initiative. An initiative here has **one owner** and a
**couple of SMEs who work across several initiatives**. Everything else is
compute.

## Cast

| Persona | Role (Cedar) | What they do | Key capability |
|---|---|---|---|
| Program operator | `hr-admin` | Runs the platform: bots, identity, policies, the governance queue | `ManageDevbox`, `ManageUsers`, `EditPolicy` |
| Release manager | `org-leader` | Allocates initiative budgets and grants SMEs sprint envelopes | `ManageBudgets`, `DispatchAgentRun`, `ApproveTransaction` |
| Initiative owner | `org-leader` or `sme` | Accountable for one initiative end to end ("Run by" on the card) | varies by grant |
| SME | `sme` | Attached to several initiatives; assigns compute to work inside their envelope | `DispatchAgentRun` |
| Member | `member` | Reads the org, searches, labels feedback | read-only affordances |

`sme` is a real Cedar role (`middleware/seeds/roles/orgiq/sme.cedar`), seeded
into Verified Permissions on boot like the others. It is a member plus
`DispatchAgentRun`, minus `ApproveTransaction` (explicitly forbidden — an SME
spends inside an envelope someone else authorized; they do not authorize).

Seeded logins: `u-release` (Sienna Garcia, release manager), `u-rachel`
(Rachel Kowalski, program operator), and four SMEs — `u-nora`, `u-eli`,
`u-layla`, `u-caleb`. Each maps to a real `people` row, so a masquerading SME
sees their own initiatives.

## The money path

Money moves in two hops, and burn is never stored — it is always derived from
`bot_runs.cost_usd` at read time, so allocation and actuals cannot drift apart
in storage.

```
release manager                 SME                          agents
      │                          │                              │
      ├─ initiative_budgets ─────┤                              │
      │  (monthly allocation     │                              │
      │   per initiative)        │                              │
      │                          ├─ budget_grants ──────────────┤
      │                          │  (sprint envelope for        │
      │                          │   one SME on one initiative) │
      │                          │                              │
      └──────── burn ◄───────────┴──── bot_runs.cost_usd ◄──────┘
```

1. **Allocation** — `initiative_budgets` (monthly, one row per initiative), set
   from `/admin/budgets` by anyone holding `ManageBudgets`.
2. **Grant** — `budget_grants` hands a named SME a spend envelope, normally
   scoped to one sprint. This is the release manager saying "see this sprint
   through with $30".
3. **Burn** — every `bot_runs` row attributed to the initiative by the
   three-way predicate (run's work item ∈ initiative, OR the bot targets the
   initiative, OR the bot targets a codebase delivering it).

## Estimation: complexity and dollars, never hours

Work is sized on two axes, and human-hours is not one of them:

- **Complexity** — `work_items.story_points` (1–21). What a person or an agent
  has to reason about.
- **Cost** — `work_items.estimated_cost_usd`. Complexity priced through the
  repo-calibrated $/point curve the marketplace already computes (`n ≥ 3` prior
  runs on that repo → model-specific rate; otherwise a scaled global prior,
  flagged `scaled`).

The marketplace echoes its estimate onto `bot_run.outcome` so the board can
tint estimated-vs-actual (danger above p75, success below p25). That feedback
loop is what calibrates the curve — the estimate is a measurement, not a guess
about how long a person would take.

Work that mixes people and agents is still sized this way: complexity is
complexity regardless of who does it, and the dollar figure is the agent
portion of delivering it.

## Bots are the baseline cost of ownership

An initiative's spend is not all feature work. Each one carries a maintenance
floor: dependency bumps, flaky-test triage, drift checks, evidence sweeps. That
floor is modeled as **cron bots** attached to the initiative (or to a codebase
that delivers it), and surfaced by `v_initiative_maintenance_30d`:

```sql
SELECT initiative_name, cron_runs_30d, maintenance_cost_30d_usd
FROM v_initiative_maintenance_30d ORDER BY 3 DESC;
```

Read an allocation against that view: the floor is what keeps the lights on,
and only the remainder is available for new work. An initiative whose
maintenance floor approaches its allocation is one that cannot take on
anything new — which is a real signal, visible before anyone commits work to it.

## The queue loop

Cron bots do not run work directly against an initiative; they enqueue it, and
the fleet dispatcher picks it up. That indirection is what lets scheduled
maintenance, hand-dispatched work and marketplace claims share one pipeline and
one set of guardrails.

```
cron trigger → decideFire (enabled? budget? daily cap? concurrency?)
             → enqueueJob (agent_jobs, kind='devbox:task', payload.botId)
             → dispatcher claims (FOR UPDATE SKIP LOCKED)
             → governed run: capture → independent review → policy gates
             → awaiting_review (unless requiresReview=false) → PR
             → reconcile: cost + outcome written back to bot_runs
```

Repo-targeted bots take the governed-run path directly
(`dispatchGovernedRun`); initiative-targeted bots take the queue path above.
Either way the same gates apply, so a bot never has more authority than a
hand-driven run.

The seed exercises this end to end: every flagship initiative has a live
`queued` job alongside ~30 days of completed maintenance runs, so the queue is
populated on a fresh database instead of only after someone clicks something.

## Sprints

`sprints` gives each initiative a cadence and, more importantly, a *steward* —
the SME accountable for that iteration. `budget_grants.sprint_id` points at it,
and `work_items.sprint_id` puts work inside it. That triple (steward, envelope,
scope) is what an SME actually sees when they open a sprint: this is my work,
this is my money, this is when it ends.

## Data

Generated by `schema/seeds/generate_program_seed.py` → `schema/seed_program.sql`
(checked in; regenerate rather than hand-editing). Applied by
`schema/apply_all_seed.py` and `schema/apply-work-items.sh`, after
`schema/program_schema.sql` creates `sprints`, `budget_grants`, the work-item
columns and the maintenance view.

Fourteen canonical `p-*` initiatives, each with:

- exactly one `owner` and two `sme` rows in `project_contributions` (the old
  randomized 8-person contributor walls are deleted wholesale by the seed);
- a `github_url` and a linked `agent_projects` row under
  `connorhoehnslalom/orgiq-*`, ready for the repos to be provisioned;
- epics with stories and bugs carrying points **and** dollar estimates, PR URLs
  on merged/in-review items, and sprint membership;
- sprints with stewards, and `budget_grants` from `u-release` to those stewards;
- a monthly `initiative_budgets` allocation;
- a maintenance bot with ~30 days of cron `bot_runs` and their `agent_jobs`
  (except the two planning-stage initiatives, which have no repo to maintain,
  and the completed one, whose bot is parked with a `paused_reason`).

The middleware's no-Aurora fallbacks mirror this exactly — same ids, same
people, same owner/SME shape (`providers/projects.ts`, `providers/work-items.ts`)
— so mock mode and a seeded database tell the same story.

### Provisioning the test repos

The seed names repositories that do not exist yet. When they are provisioned
under `connorhoehnslalom/`, the linked `agent_projects` rows resolve and bots
begin doing real work against them with no schema change:

| Initiative | Repo |
|---|---|
| Observability Platform | `orgiq-observability` |
| Auth Migration | `orgiq-auth-service` |
| LLM Application Platform | `orgiq-llm-platform` |
| Cost Optimization | `orgiq-finops` |
| Real-time Analytics Pipeline | `orgiq-stream-analytics` |
| Data Lake Migration | `orgiq-data-lake` |
| ML Feature Store | `orgiq-feature-store` |
| Mobile App Redesign | `orgiq-mobile-app` |
| Design System v3 | `orgiq-design-system` |
| Design System API | `orgiq-design-system-api` |
| Inference Platform | `orgiq-inference-platform` |
| RAG Knowledge Search | `orgiq-rag-search` |
| SOC2 Compliance | `orgiq-compliance` |
| Zero Trust Network | `orgiq-zero-trust` |

Private repos need a stored connection (`agent_projects.connection_name`); the
clone path reports a missing credential rather than failing soft.

## Not built yet

- **The allocation brake.** Allocations report; they do not yet refuse. Daily
  bot budgets self-pause, but an initiative whose monthly allocation is
  exhausted still accepts dispatches. Making the grant a real brake means
  checking remaining envelope in `decideFire` and in the marketplace dispatch
  path, and returning the same 409-with-confirmation shape the per-run soft cap
  uses.
- **Sprint surfaces in the portal.** The tables and the seed are there; there
  is no sprint board or envelope-burn view yet.
- **Grant-scoped dispatch.** `DispatchAgentRun` is currently role-wide. Cedar
  can condition on the initiative, so an SME could be permitted to dispatch
  only where they hold a grant.
