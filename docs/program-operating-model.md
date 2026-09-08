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
| Program operator | `hr-admin` | Runs the platform: bots, identity, policies, the governance queue | `ManageDevbox`, `ManageUsers`, `EditPolicy`, `ManageBudgets` (co-allocates spend with the release manager) |
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
  (except the two planning-stage initiatives, which have no repo to maintain).

⚠️ **Seeded bots are parked, and no `queued` jobs are seeded.** Both are safety,
not omission: `initBotScheduler` registers every *enabled* cron bot at boot, and
the job dispatcher claims any *queued* job the moment a devbox box is idle.
Either would run against repositories that do not exist yet — burning real money
to fail at clone. The completed run history is what demonstrates the loop and
the maintenance baseline. Provision the repo, then un-pause the bot from its
page; that is the activation step.

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

## The allocation as a brake

`POST /api/bots/dispatch-work` runs three soft brakes in order — the per-run
cap, the initiative allocation, and the SME's sprint envelope — each pure in
`lib/bot-runner.ts` (`decideRunBudget` / `decideAllocation` / `decideEnvelope`).
A forecast that does not fit answers **409** carrying `gate` (`run-budget` /
`allocation` / `envelope`) and `confirmFlag`, and proceeds only with that
specific flag: `confirmOverRunBudget`, `confirmOverAllocation`, or
`confirmOverEnvelope`. One click never answers two limits — the deprecated
`confirmOverBudget` still opens the two gates that predate the split, but not
the envelope.

Shared choices across all three brakes:

- **Soft, not hard.** Unlike the per-day bot budget, which self-pauses the bot,
  these gate human-initiated work. A hard stop with no override would strand an
  SME mid-sprint, and the estimate is a forecast, not a bill.
- **Unbudgeted is not zero-budget.** An initiative with no allocation row, or an
  SME with no active grant, is not braked by that gate; the allocation blind
  spot shows on the Budgets page instead.
- **One forecast, three confidences.** A single fallback chain
  (`selectDispatchForecast`) feeds both the estimate the operator reads and the
  forecast the brakes judge, so they cannot disagree. It always returns a range
  and a `confidence` label — `scaled` (per-point history), `run-history`
  (run-level), or `prior` (no history). The brakes test **p75** against the
  remainder regardless of confidence, so a first, historyless dispatch against a
  small allocation still brakes; confidence shapes the 409's wording, not the
  verdict.

Envelope attribution is honest about what the data supports: a grantee's burn is
the sum of `bot_runs` whose `dispatched_by` (taken from the session, never the
body) is that person, inside the grant's sprint window. Runs predating the
`dispatched_by` column, cron firings, and other people's dispatches count
against nobody — and when attribution is unavailable the burn is treated as
*unknown*, so only a forecast exceeding the whole envelope brakes.

## Sprints

`/iq/sprints` (and `GET /api/sprints?scope=mine|all`) is the SME's view: an SME
lands on the sprints they steward, hold a grant on, or have work in — each card
carrying dates, the work board grouped by status, points, planned cost, the
envelope, and the initiative's spend in the window (labelled as initiative
spend, never a personal burn). `scope=all` takes the budgets read tier; an SME
requesting it gets a 403, not a silently narrowed answer.

## Recently built

- **Grant-scoped dispatch.** `POST /api/bots/dispatch-work` blocks an `sme`
  who holds no active sprint grant on the target initiative (hard 403 via
  `decideGrantScopedDispatch`), before the money gates; org-leader/hr-admin/admin
  bypass. The deny text now distinguishes "no grant here" from "your grant's
  sprint isn't active yet."
- **Initiative-scoped sprint writes.** Cedar grants `ManageSprints` role-wide,
  but the route layer (`requireInitiativeSteward` in `routes/sprints.ts`) scopes
  an SME's create/move to initiatives they own or contribute to; org-leader/
  hr-admin/admin are org-wide.
- **Sprint mutation.** `POST /api/sprints`, `PATCH/DELETE /api/sprints/:id/items`
  (gated `ManageSprints`) and grant CRUD `POST/PATCH/DELETE /api/grants` (gated
  `ManageBudgets`) are built, with a portal UI on `/iq/sprints`. Grants carry a
  correctable free-text `note` (validated, empty clears) that `PATCH` treats as
  separately optional from the amount, so a note fix doesn't clobber the
  envelope. The SME sees a pre-dispatch cue on the initiative page when they
  hold no active grant there.
- **Direct-invoke authorization.** `POST /api/agents/:id/invoke` gates the write
  agents (graph-builder, ingestion, scoring) on `ManageIngest`, so a member
  can't drive graph/KB/score writes directly; read agents unchanged.
- **Roster-sourced pickers.** `GET /api/roster` (people + `isSme`, tenant+session
  gated) backs the New Sprint steward and grant-grantee pickers, which list an
  initiative's own contributors first, then everyone else with SMEs tagged — so a
  cross-initiative SME (the operating model's whole point) can be made steward or
  granted an envelope from the UI, matching what the APIs already accepted.
- **Person↔account linking.** `PUT /api/identity/users/:id/person`
  (`ManageUsers`-gated, validates the person exists, `null` clears) plus an inline
  Link/Relink affordance on `/admin/identity/users`. Previously `personId` was
  settable only at user creation, so the Sprints "link it from Identity → Users"
  remediation was a dead end.
- **Agent-projects read tier.** The `/api/agent-projects` list + `/:id/runs` are
  now read-tiered via `readForRolesElseAction(['org-leader','hr-admin'],
  'DispatchAgentRun')` (`routes/agent-projects.ts`) instead of gating reads on
  `ManageDevbox` — so a TPM/release manager can see the initiative codebases and
  their run history without dispatch rights; writes keep the stricter gate.

## Not built yet

- **Bot-fire allocation brake.** `decideFire` knows a bot's own per-run/per-day
  budgets but not its initiative's allocation, so a cron bot's spend is bounded
  by its caps, not the initiative envelope. That looks deliberate —
  `v_initiative_maintenance_30d` treats bot spend as the maintenance *floor* an
  allocation is read against. A pure, opt-in `decideBotFireAllocation` skip now
  exists (OFF by default) for when a `bots.enforce_allocation` flag is added.
- **Member feedback threading.** The `LabelFeedback` control is built and tested —
  a capability-gated 👍/👎 on each Ask answer that POSTs
  `{invocationId, label}` to `/api/observability/quality/feedback` — but renders
  only when an answer carries a real observability `invocationId`, which the
  *streaming* Ask path does not yet thread through (the AG-UI `run_id` is disjoint
  from the server-side trace uuid). So it is forward-compatible and inert until
  `invocationId` is plumbed supervisor → middleware → stream hook.
