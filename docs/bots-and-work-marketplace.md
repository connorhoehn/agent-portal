# Bots & the Work Marketplace — design plan

Two flows, one primitive. A **bot** is a durable, mission-configured agent: pick a
template, point it at a repo or an initiative, set budget guardrails and a trigger,
then watch it work and govern what it ships. The **marketplace** is the
initiative-side entrance to the same machine: sized backlog work gets a
cost-and-duration estimate, a human authorizes it, and the outcome lands back on
the work item as a PR.

Grounded in a file-level audit of `middleware/src` and `portal/src` (2026-08-21).
Companion to the portal journey audit.

## 1 · The core insight: both flows converge on one primitive

"Create a tech-debt bot for this repo" and "grab this 5-point story and run it"
are the same object viewed from two doors. Model them as one thing — a
**directive** — and every downstream surface (activity, outcomes, governance,
spend) is built once.

```
Bot = template (epic|story|bug) + written mission + target (repo | initiative | work item)
    + trigger (manual | cron | PR-watch) + guardrails (model, budget, review)
    → governed runs → capture → review → gates → human decision → PR
```

Critically, **nothing new touches code ungoverned**. Every bot run flows through
the existing `dispatchGovernedRun` pipeline — diff capture, independent model
review, policy gates, human approval, delivery as a PR. Bots make the loop
autonomous at the *front* (what to work on, when); the back half stays exactly
as governed as it is today. The GitHub connector can open PRs but cannot merge —
that stays true.

## 2 · What already exists vs. what's missing

| Capability | State | Detail |
|---|---|---|
| Job queue + dispatcher | HAVE | `agent_jobs` with priority, attempts, SKIP LOCKED claiming, 10s dispatch tick, one job per idle computer, stale-reaping, boot recovery. Results persist `{summary, turns, durationMs, costUsd, toolCalls, transcript}`. |
| Governed run pipeline | HAVE | `dispatchGovernedRun` → capture → independent review → policy gates → decide → deliver PR. Commit-per-capture. Delivery guard (approved, live session, not superseded). |
| Recurring-agent template | HAVE | Org sweeps already are proto-bots: each ships its own remediation prompt + priority, dedupes findings by fingerprint, promotes to a job. The bot concept generalizes this from "graph hygiene" to "code missions". |
| Cron machinery | HAVE | Two node-cron registries exist (ingest schedules, crawl targets) with validate/CRUD/boot-re-register. Bots get a third registry backed by Aurora, not JSON files. |
| Sized work | HAVE | `work_items` already carry `story_points`, priority, `pr_url`/`pr_status`, assignee. The estimation unit exists. |
| Per-run dollar cost | **GAP** | Claude Code reports `total_cost_usd` per run and it's persisted for queue jobs (JSONB) — but **governed runs discard it**, even though `agent_project_runs.cost_usd` already exists as a column. One small fix unlocks the whole estimation engine. |
| PR awareness | **GAP** | Connector can open PRs, list repos, read commit signal — but cannot list PRs or check PR status. No webhooks possible (laptop middleware), so PR-watch triggers and merge detection poll, using the proven watermark-poller pattern (CloudWatch trace poller). |
| Work item ↔ agent linkage | **GAP** | No `work_item_id` on jobs, runs, or change requests. The only join is repo→initiative. Three nullable columns close it. |
| Budget enforcement | **GAP** | The policy engine has a clean seam for a spend gate (4 places to touch), but `ChangeFacts` carries no cost today, and nothing caps runs/day or $/day. |
| Wizard + tail UI | HAVE | KBCreateWizard is the exact multi-step modal pattern (validation, preview panel, live SSE step 3). The box-tail SSE + job-scoped filtering pattern is proven in two pages; needs extraction into a shared `RunTimeline` component. |
| Initiative ownership | **GAP** | `projects.owner_id` exists in schema but isn't surfaced; contributor roles are free text with no owner/SME semantics; the initiative activity feed is client-side mock data today. |

## 3 · Data model

```sql
-- The new primitive
CREATE TABLE bots (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  template            TEXT NOT NULL CHECK (template IN ('epic','story','bug')),  -- the whole catalog
  prompt_template     TEXT NOT NULL,          -- the written mission, rendered with target context per run
  agent_project_id    UUID REFERENCES agent_projects(id) ON DELETE CASCADE,   -- repo target
  org_project_id      TEXT REFERENCES projects(id) ON DELETE SET NULL,        -- initiative target
  model               TEXT NOT NULL,
  trigger             TEXT NOT NULL CHECK (trigger IN ('manual','cron','pr_watch')),
  cron_expr           TEXT,                   -- validated by the existing validateCronExpr
  enabled             BOOLEAN NOT NULL DEFAULT TRUE,
  budget_per_run_usd  NUMERIC,               -- soft cap: warn + flag
  budget_per_day_usd  NUMERIC,               -- hard cap: bot pauses itself
  max_runs_per_day    INTEGER NOT NULL DEFAULT 4,
  requires_review     BOOLEAN NOT NULL DEFAULT TRUE,
  pr_watermark        TEXT,                   -- last PR number seen (pr_watch trigger)
  created_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_run_at         TIMESTAMPTZ,
  paused_reason       TEXT                    -- 'daily budget reached', 'disabled by …'
);

-- One row per firing, whichever trigger caused it
CREATE TABLE bot_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id        UUID NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  trigger       TEXT NOT NULL,               -- manual | cron | pr_watch | marketplace
  run_id        UUID REFERENCES agent_project_runs(id),   -- governed run it dispatched
  job_id        TEXT REFERENCES agent_jobs(id),           -- or queue job (org-loop missions)
  work_item_id  TEXT REFERENCES work_items(id),
  status        TEXT NOT NULL DEFAULT 'running',
  cost_usd      NUMERIC,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ,
  outcome       JSONB DEFAULT '{}'           -- {changeId, prUrl, summary, filesChanged}
);

-- Work-item taxonomy simplifies to match: epic | story | bug.
-- (Today: epic|feature|story|task. Migration: feature → story, task → story,
--  flattening to a two-level tree; parents preserved where the parent is an
--  epic, otherwise re-parented to the nearest epic ancestor.)
-- ALTER work_items type CHECK → ('epic','story','bug')

-- Close the work-item linkage gap (three nullable columns)
ALTER TABLE agent_project_runs    ADD COLUMN IF NOT EXISTS work_item_id TEXT REFERENCES work_items(id);
ALTER TABLE agent_change_requests ADD COLUMN IF NOT EXISTS work_item_id TEXT;
ALTER TABLE agent_jobs            ADD COLUMN IF NOT EXISTS bot_id UUID;

-- The estimation enabler: actually write the column that already exists
-- (executeProjectRun currently discards outcome.costUsd; finishRun gains cost)
-- agent_project_runs.cost_usd NUMERIC  ← exists today, never written
```

## 4 · Flow A — the bot wizard

Entry: a new **Bots** page in the Build group (the durable roster), plus
"+ New → Bot" from Computers. Built on the KBCreateWizard pattern: library
Modal, per-step validation, a resources-preview panel, and a live SSE final step.

1. **Template** — exactly three, no catalog sprawl: **Epic** (a container —
   groups stories/bugs, never dispatched itself) · **Story** (a sized change) ·
   **Bug** (a defect with a repro). The mission itself is *written*, not picked —
   the template shapes the outcome contract, the prompt says what to do. A
   recurring "tech-debt hunter" is a Bug-template bot with a written mission and
   a cron trigger.
2. **Target** — pick a linked codebase (or paste a repo URL — the link-repo flow
   exists) or an initiative. PR-watch bots require a repo + GitHub connection.
3. **Guardrails** — model picker (deployed allowlist), budget per run + per day,
   max runs/day, "requires review" (default on, policy-backed). Shows which SDLC
   policies will gate every change.
4. **Trigger** — manual · cron (presets hourly/daily/weekly + raw expr,
   validated) · on new PRs (polling; explains the poll-interval latency honestly).
5. **Review & launch** — everything on one card + a per-run cost estimate from
   history ("similar runs on this repo: $0.18–$0.65"). Launch → optional first
   run fires → the step becomes the live activity tail.

### The bot detail page (where you live with it)

- **Activity**: live tail of the current run (the extracted `RunTimeline` — the
  same component Job detail and Computers use), plus run history with per-run
  cost, duration, outcome.
- **Outcomes**: the changes/PRs this bot produced, each linking into the
  existing Changes review queue — the human decision stays where governance
  already lives.
- **Controls**: Run now · Pause · Edit guardrails · spend-vs-budget bar for
  today (library `ProgressBar`).
- **Direct it**: a one-shot instruction box ("this run, focus on the auth
  module") that renders into the next run's prompt — the steering wheel without
  editing the template.

## 5 · Flow B — the work marketplace

```
Story or Bug (5 pts, unassigned, open) → [Estimate] → range: $1.20–$3.40 · 12–35 min
  · basis: 14 similar runs → [Authorize] → governed run bound to work_item
  → in_progress → change captured → in_review → PR delivered → pr_url on story
  → merged (polled) → done
```

The taxonomy is deliberately flat: **epics contain stories and bugs, and that's
the tree**. Stories and bugs are the dispatchable units; epics roll up progress
and spend. The current four-type hierarchy (epic → feature → story → task)
collapses to two levels, which also simplifies the initiative tree and board.

1. **Estimate affordance** on the work board and tree: open, sized, unassigned
   stories and bugs get an "Estimate" chip. Opens a Drawer: cost + duration
   *ranges*, the model picker re-computing live, and the basis stated plainly —
   "based on 14 runs on this repo with this model" or "no history yet — prior
   for Sonnet, wide range". Never a fake-precise single number.
2. **Authorize** = ConfirmDialog carrying the estimate → enqueues a governed run
   with `work_item_id`, flips the story to `in_progress`, records the estimate
   on the bot_run for later calibration.
3. **Watch**: the story row gains a pulsing "agent working" chip linking to the
   live tail.
4. **Outcome**: change captured → story `in_review` with a link into the Changes
   queue; delivery writes `pr_url`/`pr_status` onto the story (requires opening
   the work-items PATCH, which today accepts prStatus but not prUrl); the
   PR-status poller flips it to `done` on merge.
5. **Estimate vs. actual** accumulates automatically — the same calibration
   story the judge already has, applied to cost.

### The estimation engine

```
estimate(points P, model M, repo R):
  basis  = runs matching (M, R)          — need n ≥ 3
        else runs matching (M, any repo) — need n ≥ 5
        else static prior for M's tier   (wide range, labeled "no history")
  cost   = P × [p25, p75] of ($ / point) over basis
  time   = P × [p25, p75] of (minutes / point) over basis
  confidence = high (n≥8, repo-matched) | medium (n≥3) | prior
```

The single prerequisite is Phase 0's cost wiring: governed runs must stop
discarding `outcome.costUsd` (the column already exists). Actuals come from
Claude Code's own `total_cost_usd` — no pricing table needed for Claude models,
because the runtime reports real spend.

## 6 · Triggers

| Trigger | Mechanism | Notes |
|---|---|---|
| Manual | "Run now" → dispatch immediately | Also the marketplace's authorize path. |
| Cron | Third node-cron registry, Aurora-backed; re-registers on boot like ingest schedules | Laptop-middleware honesty: in-process cron misses firings while the process is down. Persist `last_run_at`; on boot, a bot whose schedule elapsed while down runs once (catch-up), never N times. |
| On new PRs | Watermark poller (the CloudWatch-poller pattern): every ~2 min, `listPulls(repo, since watermark)` per enabled pr-watch bot; new PR → dispatch with PR context in the prompt | Requires two small connector additions: `listPulls` and `getPullStatus` (the latter also powers marketplace merge-detection). Webhooks become possible only when the middleware runs on ECS with an HTTPS origin — the poller is the right v1 either way. |

## 7 · Budget & safety

- **Per-run soft cap**: estimate exceeds `budget_per_run_usd` → the run requires
  explicit confirmation; actual exceeds it → outcome flagged on the bot page.
- **Per-day hard cap**: bot pauses itself with `paused_reason` when today's
  summed `bot_runs.cost_usd` would exceed `budget_per_day_usd`; visible on the
  roster, one click to resume.
- **Max runs/day** backstops runaway triggers independently of cost.
- **New policy kind `max_cost`** in the SDLC gate engine — a change whose run
  cost exceeded the threshold requires approval regardless of review verdict.
  Exactly four touch points (verified): the `PolicyKind` union + switch,
  `ChangeFacts` (gains `costUsd`), the DB CHECK constraint, the route allowlist.
- **Concurrency**: bot runs auto-provision a computer when the pool is
  idle-empty (sessions are cheap; the reaper already stops them at 20 min idle /
  60 min lifetime), with a global concurrent-bot-runs ceiling.
- **Kill switch**: pausing a bot cancels its queued work; a global "pause all
  bots" flag lives beside the existing sweep-interval env toggle.

## 8 · Initiative layout changes — owner + SMEs

The operating model: one person runs each initiative; SMEs cut across
initiatives directing agents (redesigns, migrations). The schema is ahead of the
UI here.

- **Owner**: `projects.owner_id` already exists — surface it on the initiative
  header ("Run by") and the card grid. The owner is the default approver for
  marketplace authorizations on that initiative.
- **SME roles**: `project_contributions.role` is free text — reserve `owner` /
  `sme` values. The Contributors tab gains role editing; a person with an SME
  role on *any* initiative can dispatch and direct bots across the initiatives
  they're attached to.
- **Authorization**: new Cedar action `DispatchAgentRun` — held by hr-admin and
  org-leader globally; the middleware additionally honors initiative-scoped
  owner/SME membership so the model matches the org chart, not just the role
  matrix.
- **New "Agents" tab** on the initiative page (the tab row is a two-line
  change): the bots targeting this initiative, live runs, spend-to-date, and
  outcomes.
- **Real activity feed**: the card grid's activity feed is mock data today; bot
  runs, deliveries, and status changes become the real feed via the existing
  project-activity query.

## 9 · Build order

Sequenced by dependency and blast radius. Each phase is independently shippable
and reversible; nothing touches deployed AWS infra — it's all middleware +
portal + two additive schema files.

| Phase | Scope | Why this order |
|---|---|---|
| **0 · Foundations** | Wire `cost_usd` through `finishRun` (column exists, one discard to fix); add `bots`/`bot_runs` tables + linkage columns; extract `RunTimeline` from the two inline copies; add `listPulls`/`getPullStatus` to the connector. | Everything downstream reads cost history — every run before this lands is invisible to the estimator, so this ships first and the data accretes while the rest is built. Additive schema, zero behavior change, trivially reversible. |
| **1 · Bots MVP** | Bots CRUD API + roster page + wizard (manual + cron) + bot detail with live tail + outcomes into the Changes queue. Templates: epic / story / bug — the whole catalog. | Demonstrates the full loop (create → schedule → watch → govern → PR) with the fewest new moving parts. Cron registry is a proven pattern copied, not invented. |
| **2 · Marketplace** | Estimation engine + Estimate drawer + Authorize flow + work-item linkage + story/bug status automation + `pr_url` writable + taxonomy migration (feature/task → story, two-level tree). | Needs Phase 0's cost history to say anything honest. Touches the initiative page, which Phase 3 reworks anyway — estimator first, layout second, so the layout is designed around real data. |
| **3 · Org model + triggers** | PR-watch poller + PR-review bots; merge-detection → story done; owner/SME surfacing + `DispatchAgentRun` Cedar action + initiative Agents tab + real activity feed; `max_cost` policy kind + daily budget enforcement. | Highest blast radius (authz semantics, polling load, initiative layout) and everything it needs exists once 0–2 land. Cedar changes ride the existing seed/drain machinery. |

## 10 · Risks, stated plainly

| Risk | Mitigation |
|---|---|
| The middleware is a laptop process — cron bots silently stop when it's closed. | Catch-up-once semantics on boot; the Bots roster shows "last ran" prominently so staleness is loud. The design is unchanged by an eventual ECS move — it just makes triggers reliable. |
| Workspace wipes (image pushes, 14-day idle) strand bot checkouts mid-mission. | Bots treat checkouts the way Codebases already does: re-clone on demand, never assume. The clone-confirm flow exists. |
| Estimation confidence theater — a precise-looking number from 2 samples. | Ranges only, basis always stated, explicit "prior — no history" label under n=3. Estimate-vs-actual recorded from day one so drift is measurable. |
| Runaway spend from a misconfigured trigger. | Three independent brakes: max runs/day, daily $ hard cap with self-pause, global pause-all. Plus the fleet-concurrency ceiling. |
| Queue and findings tables grow without bound (no retention exists today). | Phase 0 adds a retention sweep for terminal jobs/runs older than a window — needed regardless of bots. |
