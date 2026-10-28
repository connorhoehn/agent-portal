# DE-42 Cedar for box actions: split ManageDevbox

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Unblocks DE-43 (separation of duties needs `DecideAgentChange` and
`EditSdlcPolicy` to exist). Pairs with DE-40 (profile editing gets its own action).

## Current state (read from the code, 2026-10-27)

`ManageDevbox` is one role-wide grant, held by `sme`
(`middleware/seeds/roles/orgiq/sme.cedar:28`), `hr-admin`
(`hr-admin.cedar:27`) and `admin` (`seeds/roles/admin.cedar`, wildcard). It
gates authorities of very different weight:

| Authority | Route | Gate |
|-----------|-------|------|
| Arbitrary shell | `POST /api/devbox/:sid/command` (`mode: full`), `POST /:sid/shell-url` (`routes/devbox.ts:663`, `:839`) | mount `readForRolesElseAction([...], 'ManageDevbox')` (`index.ts:505-509`) |
| Claude Code task | `POST /api/devbox/:sid/task` (`devbox.ts:642`); `POST /api/agent-projects/:id/runs` (`agent-projects.ts:113`); `POST /api/sdlc/changes/:id/address`, `/rereview` (`sdlc.ts:109`, `:135`); direct invoke of the devbox agent (`agents.ts:192-194`) | same, `writeGate` (`agent-projects.ts:26`), `/api/sdlc` mount (`index.ts:387`) |
| Box lifecycle | `POST /boxes`, `/sessions`, `PATCH`/`DELETE /boxes/:id`, `DELETE /:sid` (`devbox.ts:417-482`, `:910`) | mount |
| Approve agent code | `POST /api/sdlc/changes/:id/decide` (`sdlc.ts:89`) | `/api/sdlc` mount |
| Ship agent code (push, PR) | `POST /api/sdlc/changes/:id/deliver` (`sdlc.ts:169`) | `/api/sdlc` mount |
| Edit governance | `POST`/`DELETE /api/sdlc/policies` (`sdlc.ts:44`, `:65`) | `/api/sdlc` mount |
| Work queue, findings, proposals | ten routes in `routes/work.ts` (`:233`-`:496`) | `requireAction('ManageDevbox')` |
| Capabilities, session bundles, codebases | `capabilities.ts:38`, `session-bundle.ts:20`, `agent-projects.ts:44-136` | `requireAction('ManageDevbox')` |

So the backlog line is right: one grant covers shell through policy edits.
Further facts:

- **No initiative enters Cedar.** Every decision targets the singleton
  `OrgIQ::Application::"app"` with role and tenant only (`lib/authz.ts:269-291`).
  The `Application` entity declares only `amount` and the four `env*`
  attributes (`seeds/schema.json`), and the store validates STRICT
  (`infra/lib/authorization-stack.ts:43`), so an undeclared attribute is
  rejected. Per-box scope is done after Cedar, by `requireBoxAccess`
  (`devbox.ts:308-340`) and `lib/devbox-visibility.ts:91`; the SDLC routes have
  no initiative scope at all.
- **Locally, conditions and forbids are both skipped.** With no
  `POLICY_STORE_ID` the decision is a flat role-to-action matrix
  (`authz.ts:195-199`, `:236-253`), built from `permit` lists only
  (`lib/role-registry.ts:53-60`). A `when` clause or a `forbid` changes nothing
  in dev, so any rule that matters must also exist in route code.
- **New actions must be listed in `CAPABILITY_ACTIONS`** (`authz.ts:34-96`) or
  `GET /api/session/capabilities` returns no key and the portal hides the
  control for every role. An action whose permit carries a `resource has X`
  condition also needs a probe entry in `CAPABILITY_PROBE_ATTRS`
  (`routes/session.ts:161-163`), or the bare probe denies it.
- `/api/sdlc` and `/api/devbox` have no `requireTenant('orgiq')`
  (`index.ts:387`, `:505`); the tenant boundary is only the Cedar `when`.
- Seeds re-sync to AVP on every boot (`lib/policy-seeds.ts:72-135`), keyed by
  statement position (`:101`). New statements should be appended to a file so
  existing descriptions keep their numbers.

## Change

**New actions** (orgiq namespace, `appliesTo` User/Application, added to
`seeds/schema.json` and to `CAPABILITY_ACTIONS` with a route comment):

| Action | Routes | sme | program-owner | org-leader | hr-admin | member |
|--------|--------|-----|---------------|------------|----------|--------|
| `OpenDevboxShell` | `/:sid/command`, `/:sid/shell-url` | yes | no | no | **no** (today yes) | no |
| `RunDevboxTask` | `/:sid/task`, agent-projects `/:id/runs`, sdlc `/address`, `/rereview`, devbox agent invoke | yes | no | no | **no** (today yes) | no |
| `DecideAgentChange` | sdlc `/changes/:id/decide` | yes | yes | yes | no | no |
| `DeliverAgentChange` | sdlc `/changes/:id/deliver` | yes | yes | yes | no | no |
| `EditSdlcPolicy` | sdlc `POST`/`DELETE /policies` | **no** (today yes) | no | no | yes | no |

`ManageDevbox` stays for box lifecycle, codebases, work queue, capabilities and
session bundles, with its comment narrowed to that. `admin` keeps everything
through the wildcard. No role in `assessment`, `social`, `pipelines` or
`access` gets any of these; each permit keeps
`principal has tenant && principal.tenant == "orgiq"`.

**Initiative attributes, as booleans.** Following the reasoning in
`authz.ts:123-160` (low-cardinality attributes keep the decision cache useful),
the route computes and passes:

- `onInitiative`: the caller stewards or works on the box's or change's
  initiative (`lib/initiative-scope.ts:53`, `:97`), or holds an org-wide role
  (`ORG_WIDE_INITIATIVE_ROLES`, `:41`);
- `ownsBox`: the box's `ownerId` is the caller.

Declared as optional `Boolean` on `Application` in `schema.json`. The sme and
program-owner permits for the five actions gain
`when { resource has onInitiative && resource.onInitiative }`; the shell permit
also accepts `resource.ownsBox`. Probe entries
(`{ onInitiative: true }`) go into `CAPABILITY_PROBE_ATTRS` for each.

**Route checks are the authority in both modes.** Each route resolves the
initiative (box `projectId`; change via `agent_projects.org_project_id`),
refuses with 403 `{ code: 'NOT_ON_INITIATIVE' }` when the caller is not on it,
and only then calls `isAllowed(session, action, attrs)`. Cedar repeats the rule
in production. `/api/sdlc` moves to `requireTenant('orgiq')` +
`requireSession` at the mount with per-route gates; reads open to the four
roles in the table. `/api/devbox` gains `requireTenant('orgiq')`.

**Portal**: the 23 `can('ManageDevbox')` call sites in `portal/src` are
re-pointed where they guard a shell, task, decide, deliver or policy control.

## Decisions owed

- Does `hr-admin` lose shell and task? Proposal: yes. It mirrors the existing
  `EnterEnvironment` forbid for hr-admin (`hr-admin.cedar:51-61`): curating
  records is not acting on them. hr-admin keeps `EditSdlcPolicy`, matching its
  `EditPolicy` and `EditGuardrail` grants.
- Should program-owner and org-leader decide and deliver? Today they cannot
  even read `/api/sdlc`. Proposal: yes, scoped by `onInitiative`. DE-43 needs
  an approver who is not the SME who dispatched the run.
- Keep the local matrix or add a local Cedar evaluator
  (`@cedar-policy/cedar-wasm`, a new dependency)? Proposal: route checks now;
  a separate item for the evaluator, since it also fixes `ApproveTransaction`
  and the retired-environment forbid in dev.

## Done when

- `cd middleware && npx jest authz-matrix` pins the new matrix: each of the
  five actions granted exactly to the roles in the table, and to no role in
  the other four tenants.
- `npx jest session-capabilities` shows each new action as a key, and true for
  `sme` (`OpenDevboxShell`, `RunDevboxTask`, `DecideAgentChange`,
  `DeliverAgentChange`) and for `hr-admin` (`EditSdlcPolicy`).
- Deny tests, one per row, in `routes/__tests__/devbox.test.ts` and
  `sdlc-routes.test.ts`:
  - `hr-admin` gets 403 on `/command`, `/shell-url`, `/task`;
  - `sme` gets 403 on `POST` and `DELETE /api/sdlc/policies`;
  - `member` gets 403 on every new action;
  - `sme` on a box or change of an initiative they are not on gets 403
    `NOT_ON_INITIATIVE`, in open mode (no `POLICY_STORE_ID`);
  - a `social` `participant` and an `assessment` `assessor` get 403 on
    `/api/sdlc/*` and `/api/devbox/*` POSTs.
- `npx jest cedar-policy-edges` (structural, no evaluation) asserts the sme
  and program-owner permits for the five actions carry the
  `resource has onInitiative && resource.onInitiative` clause, and that
  `schema.json` declares `onInitiative` and `ownsBox` as Boolean.
- `bash scripts/validate-component-discipline.sh` and the nav-parity validator
  stay green after the portal re-pointing.
