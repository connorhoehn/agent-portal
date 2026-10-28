# Deployment backlog: the half that builds locally (2026-10-28)

Definition of done for the specs in `docs/deployment-enhancements/` that can
be built and proven **without AWS access**. Rows are in dependency order:
the spend ledger first, because most money specs read from it. Specs that
need the deployed stack to prove (DE-1, 2, 5, 6, 9, 10, 11, 12, 13, 15, 16,
18, 19, 21, 22, 23, 24, 25, 26, 27, 41, 44 leftovers, 49, 51, 52) are not
rows; a row below may still write their CDK or script half when the spec says
it is synth-testable.

Rules for whoever continues:
- Read this file first; take the first row that is not `done`.
- Read the row's spec, build only its **Change** and **Done when**; one row
  can take several commits. Mark a row `done` only when every local "done
  when" item has a test.
- **Decisions owed:** when the spec recommends a default and the choice is
  engineering (a TTL, a table shape, an error code), take it and note it in
  the commit. When it is a product or money call (who may do what, a dollar
  figure, a UI placement, anything CLAUDE.md lists as open), build the
  conservative default (fail closed, off by default, existing behaviour
  kept) behind config, and list it under "Decisions taken by default" below
  for the user to confirm or change.
- No cloud apply, no shared mock reset, no business-data cleanup, no pattern
  pkill; stop only processes you started. Keep the single-gateway safeguard.
- Schema changes are additive SQL files plus their mock fixtures; never run
  them against Aurora.
- Portal pages use ui-components composites only; a missing primitive is
  queued in `docs/ui-components-queue.md` and released upstream first.
- Run full suites alone (middleware jest, infra `npm test`, portal
  typecheck); recapture the wire snapshots on a throwaway :3012 server when a
  response shape changes (docs/mock-floor.md § Regenerating the snapshots),
  then `scripts/validate-mock-floor.sh --quick`.
- Update this table and push after each batch.

| # | Spec | Local scope | State |
|---|------|-------------|-------|
| 1 | DE-30 spend ledger | append-only ledger keyed by initiative/grant/run/box, written by bot runs, devbox tasks, internal tasks and work jobs; budgets read it | |
| 2 | DE-32 Claude pricing | per-model/profile prices from config, fallback estimate when no cost is reported | |
| 3 | DE-33 unknown cost gates | unknown cost routes to approval in SDLC `max_cost`; local runs record unknown, not $0 | |
| 4 | DE-31 box spend rollup | box `spendUsd` lands in the ledger under its project and owner | |
| 5 | DE-34 spend holds | reserve the p75 forecast at dispatch against allocation and envelope; settle on finish | |
| 6 | DE-35 mid-run cutoff | a run crossing its reserved ceiling is stopped with a recorded reason | |
| 7 | DE-36 hard caps | non-overridable cap per initiative and grant; unreadable budget state fails closed | |
| 8 | DE-39 bot-fire allocation brake | cron firings pass the allocation check | |
| 9 | DE-37 run limits | per-initiative/tenant concurrency, runs/day, $/hour | |
| 10 | DE-38 budget periods | sprint-aligned and rolling windows, carry-over rules | |
| 11 | DE-50 kill switches and alerts | fleet and initiative pause; threshold/stuck-run/reaper alerts as events (CloudWatch alarm half synth-tested) | |
| 12 | DE-53 initiative spend report | API plus portal view joining allocation, grants, holds, ledger, forecasts, outcomes | |
| 13 | DE-40 policy profiles | versioned per-initiative profile (models, task time, lifetime, network mode, org access) read at dispatch | |
| 14 | DE-48 one lifetime model | reaper, task timeout and AgentCore ceilings aligned and profile-driven | |
| 15 | DE-42 Cedar box actions | split `ManageDevbox` into shell/task/delivery/policy-edit with initiative attributes | |
| 16 | DE-43 separation of duties | author cannot decide own change; gated users cannot edit their own gate | |
| 17 | DE-46 SDLC policy versioned | defaults as versioned per-initiative policy with an audit trail | |
| 18 | DE-47 fleet state across replicas | busy flags, reservations, buffers in Redis/Aurora; leader-elected reaper (local Redis) | |
| 19 | DE-45 credentials out of shell | token never in a command string on the BFF side; per-run token provider interface (GitHub App half needs the image) | |
| 20 | DE-28 bug-class lint | lint for partial secret ARNs, uuid binds as text, second CommonJS editor stack | |
| 21 | DE-20 schema migrations | migration ledger with dry-run, tested against local Postgres | |
| 22 | DE-3 model registry | central versioned model config read by agents and BFF, env fallback | |
| 23 | DE-4 prompt promotion | alias-based prompt reads and promotion through canary/eval (code + synth) | |
| 24 | DE-7 MCP tool registry | gateway tools from a manifest; synth tests | |
| 25 | DE-8 memory config | per-tenant memory strategies and retention from config; synth tests | |
| 26 | DE-17 parameterised environments | account/region/prefix/domain as config; synth tests for a second environment | |
| 27 | DE-14 deploy orchestrator | one resumable command with recorded state, tested with a fake `aws`/`cdk` | |
| 28 | DE-29 tenant manifest | one manifest drives TENANTS, Cedar seeds, routers and CDK | |

## Decisions taken by default

(none yet)

## Owed from the deploy machine

Each row's AWS proof, appended as rows finish.
