# DE-33 Unknown cost is not "allowed"

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Uses DE-30's unknown count and DE-32's `estimated` basis; the SDLC half stands alone.

## Current state (read from the code, 2026-10-27)

**The SDLC gate fails open on unknown cost, and its justification doesn't hold.**
`max_cost` returns `null` (does not fire) when `facts.costUsd == null`
(`middleware/src/lib/sdlc-policy.ts:192-207`). The comment says this is safe
because `require_review` still gates the change. But that gate passes on the
reviewer's `approve` (`sdlc-policy.ts:157`), and the reviewer is a Nova model,
not a person (`lib/change-reviewer.ts:20`). So an agent-approved change with
unrecorded cost, no protected path and under 40 files is auto-approved.
`mock/__tests__/sdlc-writes.test.ts:266-282` pins exactly that, and expects
`approved` with one gate. The cost fact comes only from
`agent_project_runs.cost_usd` (`providers/sdlc.ts:492-501`), so a change with
no `runId` is always unknown. Every seeded mock change sets `costUsd: null`
(`mock/sdlc.ts:477-486`).

**The backlog's second clause is wrong.** The "confident $0" for local runs is
deliberate and correct. The middleware decides it from the route the result
arrived on, not from the run's claim (`routes/local-compute.ts:663-669`,
`lib/run-cost.ts:133-152`), and records `model_provider = 'local'` beside it
(`schema/local_compute_worker_schema.sql:79-89`). Tokens served on owned
hardware cost nothing at the margin, and recording `null` would make local work
look unmetered. Nothing to fix there. The real risk is a Bedrock run
mislabelled local, which the route-based rule already prevents.

**Budget brakes ignore unknowns too.** Every spend sum filters
`br.cost_usd IS NOT NULL` (`providers/budgets.ts:110-113`), so a run with no
figure spends no allocation or envelope, and the three soft brakes
(`routes/bots.ts:171-184`, `:369`) never see it. DE-30 makes the unknown count
visible. Nothing yet decides what it does.

## Change

1. **`max_cost` gates unknown.** In `evaluatePolicy`, `costUsd == null` returns
   a gate with `outcome: 'requires_approval'` and the detail "The run's cost was
   not recorded; a person must accept it." The outcome is `requires_approval`
   even under `action: 'block'`, because an unknown is not evidence of
   overspend. An opt-out `config.onUnknown: 'pass'` exists, but
   `DEFAULT_POLICIES` (`sdlc-policy.ts:296-302`) seeds `'require_approval'`.
   Rewrite the comment at `:195-199`.
2. **Estimated counts as known.** `ChangeFacts` gains
   `costBasis: 'reported' | 'estimated' | 'unknown' | 'local'`, and
   `runCostUsd` reads it (from `spend_entries` once DE-30 lands, from
   `agent_project_runs` until then). A DE-32 estimate is judged against
   `maxUsd` like a reported figure, and its gate detail says "estimated". A
   local $0 passes.
3. **Brakes see unknowns.** `dispatchedSpendInWindow` (`providers/bots.ts:307`) and the allocation query
   return `unknownCount` from the ledger. When it is non-zero, the matching
   soft brake fires with its existing confirm flag
   (`confirmOverAllocation` / `confirmOverEnvelope`) and the message "N runs
   in this window have no recorded cost". The hard grant gate
   (`decideGrantScopedDispatch`) is unchanged. No new flag.
4. **Ledger provenance.** Add a nullable `provider` column (`bedrock`, `local`
   or `simulated`) to DE-30's `spend_entries` (additive, both loaders:
   `schema/load_schema.py`, `schema/apply_all_seed.py`), so `cost_usd = 0 AND
   provider = 'local'` is distinguishable from a Bedrock run reporting $0.
   Order: apply, then deploy. No backfill, matching the `bot_runs.model_provider`
   rule of never asserting a provider for history.

**Mock floor:** seeded changes stay rows. Give the auto-approve demo change a
`runId` pointing at an `agent-project-runs` fixture row with a recorded cost
(`mock/agent-project-runs.ts:103` has one at $0.42), so the "approved" path is
still demonstrable. The other seeds keep `null` and now show the cost gate.
Gates remain engine output, never hand-typed.

## Decisions owed

- Should unknown cost ever **block** rather than route to a person?
  Proposal: never block. `requires_approval` regardless of the policy's
  `action`, with `onUnknown: 'pass'` as an explicit operator opt-out.
- Does an unknown-cost run in a budget window trip the soft brake on its own,
  or only once the known spend is within some margin of the limit? Proposal:
  on its own. The confirm is cheap, and a silent pass is the bug.

## Done when

- `lib/__tests__/sdlc-policy.test.ts`:
  - the `max_cost` case at `:106` flips: `costUsd: null` yields
    `requires_approval`, including with `action: 'block'`
  - `onUnknown: 'pass'` yields `null`
  - `costBasis: 'local'` at $0 passes
  - an estimated $7.25 against $5 fires with "estimated" in the detail
- `mock/__tests__/sdlc-writes.test.ts:266-282` is rewritten. With no recorded
  cost, re-review to `approve` yields `needs_approval` with a `max_cost` gate.
  With a recorded cost, the same flow yields `approved`.
- A budgets/bots route test: a window with one null-cost run makes
  `POST /api/bots/dispatch-work` answer the envelope brake, and passing
  `confirmOverEnvelope: true` dispatches.
- `run-cost.test.ts` stays green unchanged, since the local $0 rule is kept.
- `scripts/validate-mock-floor.sh` green.
