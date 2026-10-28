# DE-46 SDLC policy as versioned per-initiative data

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Depends on DE-44 (scope helper) for who may edit an initiative's policy. Pairs
with DE-42 (a policy-edit action) and DE-43 (an SME editing the rules that gate
them); DE-40's profiles can reuse the same versioning table.

## Current state (read from the code, 2026-10-27)

The backlog line is accurate: the defaults are `DEFAULT_POLICIES`
(`lib/sdlc-policy.ts:269`): independent review required, sensitive paths
(`infra/**`, `**/auth/**`, `**/*auth*`, `.github/**`, `**/Dockerfile`,
`**/*.tf`, `**/secrets/**`, `:283`), more than 40 files (`:293`), and a run over
$5 (`:300`), all `require_approval`. What it leaves out:

- **One global set.** `sdlc_policies` (`schema/agent_sdlc_schema.sql:132`) has
  no initiative or codebase column. `evaluateChange`
  (`providers/sdlc.ts:511`) evaluates every change in every initiative against
  `listPolicies()`, the whole table.
- **Edits overwrite and leave no trace.** `upsertPolicy` (`providers/sdlc.ts:92`)
  is `UPDATE … SET` in place; `deletePolicy` (`:123`) is a hard `DELETE`. The
  table has no `created_by`/`updated_by`, and `POST /api/sdlc/policies`
  (`routes/sdlc.ts:44`) does not pass the session sub anywhere.
- **Gate records cannot be tied to the rule that made them.**
  `agent_change_gates` stores `policy_id` and `policy_name`, not the config.
  `replaceGates` (`providers/sdlc.ts:472`) deletes a change's gates before
  writing new ones, so a re-review erases the earlier evaluation.
- **Re-evaluation uses whatever is current.** `rereview` (`routes/sdlc.ts:109`)
  and the governed pipeline (`lib/sdlc-pipeline.ts:273`) call `evaluateChange`,
  which reads today's policies. Loosening a policy and pressing re-review
  approves a change that was captured under the stricter rule.
- **Seeding hides a deleted set.** `seedDefaultPolicies` (`providers/sdlc.ts:71`)
  runs on every `GET /policies` and every evaluation and re-inserts the
  defaults only when the table is empty. Disabling every row, or deleting all
  but one, is not caught; the empty-set fail-closed arm (`:536`) only covers
  "zero rows".
- **Who can edit.** `ManageDevbox` (`index.ts:387`), held by `sme` and
  `hr-admin`: the people the gates constrain can change them (DE-43).
- **A stale comment.** `sdlc-policy.ts:263-265` says the defaults put "the
  governance rules themselves" behind a human; no default glob matches
  `sdlc-policy.ts`, `providers/sdlc.ts` or the schema file.

A change reaches an initiative through its codebase:
`agent_change_requests.project_id` → `agent_projects.org_project_id`
(nullable).

## Change

**Versioned policy sets, append-only.**

```sql
CREATE TABLE IF NOT EXISTS sdlc_policy_versions (
  scope        TEXT        NOT NULL,          -- 'org' | initiative id (projects.id)
  version      INTEGER     NOT NULL,
  policies     JSONB       NOT NULL,          -- the whole set: [{key, name, enabled, kind, config, action}]
  based_on     INTEGER,                       -- the version this edit started from
  changed_by   TEXT        NOT NULL,          -- session sub, or 'migration'
  reason       TEXT        NOT NULL,          -- required, shown in the history
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope, version)
);
ALTER TABLE agent_change_gates ADD COLUMN IF NOT EXISTS policy_scope TEXT;
ALTER TABLE agent_change_gates ADD COLUMN IF NOT EXISTS policy_version INTEGER;
ALTER TABLE agent_change_gates ADD COLUMN IF NOT EXISTS evaluation_seq INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agent_change_requests ADD COLUMN IF NOT EXISTS policy_scope TEXT;
ALTER TABLE agent_change_requests ADD COLUMN IF NOT EXISTS policy_version INTEGER;
```

A version is a snapshot of the whole set (a set is a handful of rows), so the
audit is a diff of two snapshots and a revert is a new version copying an old
one. Each policy carries a stable `key` so diffs line up across versions.

**Resolution.** `resolvePolicySet(changeId)`: the change's codebase →
`org_project_id` → the latest version for that initiative if one exists, else
the latest `org` version. The engine (`evaluate`) stays pure and unchanged.

**Pin at capture.** The pipeline stores `(policy_scope, policy_version)` on the
change when it is captured; every later evaluation of that change uses the
pinned version. An edit governs new changes. `rereview` takes an optional
`{ repin: true }` that moves the pin to the latest version and records that it
did. `replaceGates` becomes an append with `evaluation_seq + 1`; the change
detail reads the latest sequence and the history keeps the rest.

**Writes.** `PUT /api/sdlc/policy-sets/:scope { policies, baseVersion, reason }`
inserts `version = baseVersion + 1` or returns 409 when someone else edited
first. `GET /api/sdlc/policy-sets/:scope` (current), `…/versions` (history with
author, reason, time), `…/versions/:v`. `scope = 'org'` needs an org-wide role;
an initiative scope needs DE-44's steward check plus the edit action DE-42
names. The engine refuses a set in which every policy is disabled (fails
closed as the empty set does now). The old `POST/DELETE /api/sdlc/policies`
answer 410 after one release of accept-both.

**Migration.** Additive schema in both loaders (`schema/load_schema.py`,
`migrate-work-comments-postgres.test.ts`). A script writes the current
`sdlc_policies` rows as `('org', 1)` with `changed_by = 'migration'`, or
`DEFAULT_POLICIES` when the table is empty; existing open changes are pinned to
`('org', 1)`. `seedDefaultPolicies` goes away. Order: apply schema, migrate,
deploy the BFF, ship the portal `PolicyEditor`
(`portal/src/components/sdlc/PolicyEditor.tsx`) with history and a reason
field.

**Mock floor.** `mock/sdlc.ts` registers a `sdlc_policy_versions` fixture
seeded from `DEFAULT_POLICIES` as `('org', 1)` with clock-derived timestamps,
so `POST /api/__mock/reset` restores it.

## Decisions owed

- **May an initiative loosen the org defaults?** Proposal: an initiative set
  may add policies and tighten existing ones (lower `max`, add globs, `block`
  over `require_approval`); disabling or loosening an org policy needs an
  org-wide role. Enforced as a comparison against the current `org` version at
  write time.
- **Who edits the org set?** Proposal: `org-leader` and `hr-admin` only; take
  policy editing away from `ManageDevbox` (with DE-42/DE-43).
- **Pin or re-evaluate?** Proposal above: pin at capture, explicit re-pin.
- **Protect the governance code by default?** Proposal: add
  `**/sdlc-policy*`, `**/sdlc*.sql` and `middleware/seeds/roles/**` to the
  sensitive-paths default, which also makes the comment true.

## Done when

- The schema is in both loaders and `validate-mock-floor.sh` stays green.
- A provider test: two edits to an initiative set produce versions 2 and 3
  with author and reason, and a `PUT` with a stale `baseVersion` is 409.
- A change captured under version 1, followed by an edit that loosens
  `max_files`, still evaluates under version 1 on `rereview`; with
  `repin: true` it evaluates under the new version and both evaluations are
  readable.
- A change on initiative A uses A's set; a change on a codebase with no
  initiative uses the `org` set.
- An `sme` not on initiative A gets 403 on `PUT …/policy-sets/A`; an
  initiative set that disables an org policy is 403 for a non-org-wide role.
- A set with every policy disabled routes a change to `needs_approval`, not
  `approved`.
- `sdlc-policy.test.ts` and `sdlc-routes.test.ts` pass, updated for the new
  routes.
