# DE-43 Separation of duties for agent changes and SDLC policy

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Depends on DE-42 (`DecideAgentChange`, `EditSdlcPolicy`, `onInitiative`).
Overlaps DE-46 (policy as data, versioned): this item adds the audit columns
and the two-person rule; DE-46 adds per-initiative scoping of the rows.

## Current state (read from the code, 2026-10-27)

**Self-approval.** `POST /api/sdlc/changes/:id/decide` (`middleware/src/routes/sdlc.ts:89-102`)
records `req.session?.sub` as the decider and calls `decideChange`
(`providers/sdlc.ts:569-584`), which checks only that the status is decidable.
Nothing compares the decider with whoever caused the change, and there is no
column to compare against:

- `agent_change_requests` has `decided_by` but no requester
  (`schema/agent_sdlc_schema.sql:19-76`); `agent_project_runs` has none either
  (`schema/agent_projects_schema.sql:55-73`).
- Who caused a run is known only on some paths: `bot_runs.dispatched_by`
  (`schema/agent_run_attribution_schema.sql:32`, set from the cookie in
  `lib/bot-runner.ts:995`, `:1284`) and the bot's `created_by`
  (`schema/agent_bots_schema.sql:61`), joined through `bot_runs.run_id`
  (`:82`). The ad-hoc run route passes no actor
  (`routes/agent-projects.ts:130`), nor does `/address` (`sdlc.ts:160`);
  `dispatchGovernedRun` takes `dispatchedBy` but only writes it to the
  session brief (`lib/sdlc-pipeline.ts:64`, `:107`).
- The route reads `req.session`, not `resolveSession`, so under the demo
  fallback the decider is null, and a test pins that a null decider is accepted
  (`routes/__tests__/sdlc-routes.test.ts:233-237`).
- Since only `sme`, `hr-admin` and `admin` hold `ManageDevbox`
  (`seeds/roles/orgiq/sme.cedar:28`, `hr-admin.cedar:27`), the SME who
  dispatched a run is in practice its usual approver.

**SMEs editing the gates.** `POST` and `DELETE /api/sdlc/policies`
(`sdlc.ts:44-69`) sit behind the same `ManageDevbox` mount (`index.ts:387`).
The backlog line is right, and the hole is wider than "edit or delete":

- Policies are global, not per initiative (`sdlc_policies` has no scope
  column, `agent_sdlc_schema.sql:132-143`), so one SME loosens governance for
  every initiative.
- No audit: no `updated_by`, no history; `upsertPolicy` overwrites in place
  (`providers/sdlc.ts:92-121`) and `deletePolicy` hard-deletes (`:123-128`).
- **Disabling every policy auto-approves everything.** The fail-closed guard
  fires only when `policies.length === 0` (`providers/sdlc.ts:536`), and
  disabled rows count toward that length while `evaluatePolicy` skips them
  (`lib/sdlc-policy.ts:138`). Re-saving the four defaults with
  `enabled: false` leaves zero gates, the engine returns `approved`
  (`sdlc-policy.ts:254`), and the guard does not fire. Re-seeding cannot help:
  it runs only on an empty table (`providers/sdlc.ts:77-78`).
- The defaults' comment says the governance rules themselves need a human
  (`sdlc-policy.ts:262-267`), but the globs (`:282-285`) match neither
  `sdlc-policy.ts` nor `seeds/roles/**/*.cedar`. `**/*auth*` happens to catch
  `authz.ts`.

**Precedent in the tree.** Assessment already refuses self-approval of N/A
exceptions (`providers/assessment.ts:998-1050`, compares `requested_by`),
returns 409 with `gate: 'self-approval'`, and allows an audited admin override
(`routes/assessment.ts:197-209`). This item copies that shape.

## Change

**1. Record who caused each change.** Additive schema:

```sql
ALTER TABLE agent_project_runs    ADD COLUMN IF NOT EXISTS dispatched_by TEXT;
ALTER TABLE agent_change_requests ADD COLUMN IF NOT EXISTS requested_by  TEXT;
```

`dispatchGovernedRun` passes `dispatchedBy` into `startRun`; the ad-hoc runs
route and `/address` pass `resolveSession(req).sub`. `captureAndGate` stamps
`requested_by` = run `dispatched_by`, else the bot run's `dispatched_by`, else
the bot's `created_by` (a cron bot answers to the person who wrote it). An
`/address` re-run is a new change requested by whoever pressed Address.

**2. Refuse self-approval.** `decideChange` takes the decider and returns
409 `{ gate: 'self-approval' }` when `decider === requested_by`. The route uses
`resolveSession`; no session means 401, never a null decider. `admin` may pass
`override: true`, logged as `DecideAgentChange.Override` through `logAuthz`, as
in assessment. Cedar mirrors it for production:

```cedar
forbid (principal, action == OrgIQ::Action::"DecideAgentChange", resource)
when { resource has isAuthor && resource.isAuthor && principal.role != "admin" };
```

`isAuthor` is declared as an optional Boolean on `Application` in
`seeds/schema.json`; the capability probe sends `isAuthor: false`
(`routes/session.ts:161`) so the control still shows. The forbid is appended
to the end of each role file that holds `DecideAgentChange` (sme,
program-owner, org-leader), not put in a new file: every `.cedar` under
`seeds/roles/` is discovered as a role (`lib/policy-seeds.ts:46-62`,
`lib/role-registry.ts:68-90`), and appending keeps existing statement numbers
(`policy-seeds.ts:101`). The local matrix ignores forbids
(`role-registry.ts:53-60`), so the route check is the authority in both modes.

**3. Take policy edits off SMEs.** `EditSdlcPolicy` (DE-42) goes to `hr-admin`
and `admin` only. `deletePolicy` becomes a soft delete (`deleted_at`), and every
write records `updated_by` and a row in a new `sdlc_policy_events`
(`policy_id, actor, before JSONB, after JSONB, at`).

**4. Two people to loosen.** An edit is *loosening* when it disables or
deletes a policy, changes `block` to `require_approval`, raises `max` or
`maxUsd`, or removes a glob or model. A loosening edit is stored as pending
and takes effect only when a second `EditSdlcPolicy` holder, or an org-leader,
approves it; the proposer cannot. Tightening applies at once.

**5. Fail closed on zero enabled gates.** The guard at `providers/sdlc.ts:536`
counts enabled policies, not rows. The `require_review` default becomes
undeletable (soft-delete refused for `kind = 'require_review'` while it is the
only one).

**6. Protect the governance code.** Add `**/sdlc-policy*`, `**/seeds/roles/**`,
`**/*.cedar` and `**/authz*` to the default protected paths, and make a hit on
them `block` unless an org-leader approves.

## Decisions owed

- A change with no recorded requester (everything captured before this
  ships): who may approve it? Proposal: only `org-leader` and `admin`,
  never an SME.
- Is the SME who pressed Address on someone else's change an author of the
  new change? Proposal: yes, the new change only.
- Two-person rule for loosening, or audit-only? Proposal: two-person; edits
  are rare and the auto-approve hole above is exactly the case it stops.
- Should the deliverer also differ from the requester? Proposal: no; delivery
  ships what someone else already approved.

## Done when

- Both `ALTER`s are in `agent_sdlc_schema.sql` / `agent_projects_schema.sql`
  and registered in both loaders; `bash scripts/validate-mock-floor.sh` stays green.
- `cd middleware && npx jest sdlc-routes` has deny tests: the requester gets
  409 `self-approval` on `/decide`; a different SME on the initiative gets 200;
  admin with `override: true` gets 200 and one `DecideAgentChange.Override`
  audit line; no session gets 401 (the null-decider test is inverted).
- `npx jest sdlc` covers capture: a bot-run change carries the dispatcher, a
  cron-bot change the bot's creator, an ad-hoc run the session sub.
- Deny tests: `sme` gets 403 on `POST` and `DELETE /api/sdlc/policies`; a
  loosening edit by `hr-admin` returns 202 pending and does not change
  evaluation until a second holder approves; the proposer approving gets 409.
- A test disables all four defaults and shows a new change lands
  `needs_approval`, not `approved`.
- `npx jest authz-matrix cedar-policy-edges` pins the forbid and the
  `isAuthor` schema attribute.
