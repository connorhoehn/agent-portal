# DE-40 Policy profiles per initiative

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Depends on DE-46 (policy as data, versioned) for the storage shape; unblocks
DE-41 (egress per profile), DE-48 (one lifetime model) and the per-initiative
half of DE-43.

## Current state (read from the code, 2026-10-27)

Every knob the backlog names exists, but each lives in a different place, is
deploy-wide, and none is keyed by initiative:

| Knob | Where it is set today | Enforced where | Per initiative? |
|------|-----------------------|----------------|-----------------|
| Model allowlist | CDK env `DEVBOX_ALLOWED_MODELS` (`infra/lib/devbox-stack.ts:245`), duplicated in the image (`agents/devbox/Dockerfile:68`) | in the container, `_resolve_model` (`agents/devbox/main.py:86-104`) | no |
| Model IAM | `bedrock:InvokeModel*` on `foundation-model/anthropic.*` and `inference-profile/*anthropic*` (`devbox-stack.ts:121-135`) | IAM | no |
| SDLC `model_allowlist` | an `sdlc_policies` row kind (`middleware/src/lib/sdlc-policy.ts:178-190`), not in `DEFAULT_POLICIES` (`:269-303`) | at change review, after the money is spent | no (table has no initiative column, `schema/agent_sdlc_schema.sql:132-143`) |
| Task timeout | default 840 s via `DEVBOX_TASK_TIMEOUT_S`, cap 3300 s (`main.py:48-49`, `:315`); BFF also caps 3300 (`middleware/src/routes/devbox.ts:583`) | container | no; any caller picks any value up to the cap (`devbox.ts:648-656`) |
| Box lifetime | reaper env `DEVBOX_IDLE_TIMEOUT_MINUTES`=20, `DEVBOX_MAX_LIFETIME_MINUTES`=60 (`middleware/src/lib/devbox-reaper.ts:30-35`); AgentCore idle 3600 s / max 28800 s (`devbox-stack.ts:233-236`) | BFF reaper | no |
| Network mode | `networkMode: 'PUBLIC'` (`devbox-stack.ts:222`) | AgentCore, per runtime | no |
| Org-data access | `devboxOrgAccess` context flag (`devbox-stack.ts:91-92`, `:176-198`; `infra/bin/app.ts:344-352`) | execution-role IAM | no |

Three things the backlog line understates:

- **The allowlist is not a boundary.** A disallowed model falls back silently
  to the default (`main.py:103`, a `log.warning` only), and the execution role
  may invoke any Anthropic model. Command mode and the PTY
  (`devbox.ts:663`, `:839`) never pass through `main.py`, so a shell on the box
  can call Bedrock with any Claude model the IAM grant covers.
- **"Read-only" org access is not read-only.** The stack comment and
  `infra/bin/app.ts:339` call it read-only, but `app.ts:351` passes
  `${prefix}-aurora-secret-arn`, which is the cluster's master secret
  (`infra/lib/aurora-stack.ts:314-317`), not the SELECT-only
  `${prefix}-aurora-readonly-secret-arn` (`:319-324`). With
  `rds-data:ExecuteStatement` and the master secret a box can write. This
  should be fixed regardless of profiles.
- **The BFF reads the allowlist back from the runtime env**
  (`deployedModelCapability`, `devbox.ts:362-385`), so changing it today means
  redeploying the runtime, which wipes every workspace (`devbox-stack.ts:64-69`).

## Change

**A profile is a versioned row; an initiative points at one.**

```sql
CREATE TABLE IF NOT EXISTS devbox_profiles (
  id             TEXT NOT NULL,          -- 'default', 'restricted', 'org-read'
  version        INTEGER NOT NULL,
  models         JSONB NOT NULL,         -- allowlisted inference-profile ids, first = default
  task_timeout_s INTEGER NOT NULL CHECK (task_timeout_s BETWEEN 60 AND 3300),
  idle_minutes   INTEGER NOT NULL,
  max_lifetime_minutes INTEGER NOT NULL CHECK (max_lifetime_minutes <= 480),
  network_class  TEXT NOT NULL CHECK (network_class IN ('public','egress-allowlist')),
  org_access     TEXT NOT NULL CHECK (org_access IN ('none','read')),
  created_by     TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, version)
);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS devbox_profile_id TEXT;  -- null = 'default'
```

Rows are append-only: an edit inserts version n+1. A box records the
`(profile_id, version)` it was created under on its fleet row
(`devbox_boxes`), so a running box never changes rules mid-task.

**One resolver** (`lib/devbox-profile.ts`, `profileForBox(box)`), read by every
path that starts work: `POST /api/devbox/boxes` and `/sessions`, `/:sid/task`,
the internal router (`routes/internal-devbox.ts:165`, `:196`),
`dispatchGovernedRun` (`lib/sdlc-pipeline.ts:54`) and `bot-runner.ts`.

What the BFF enforces without a redeploy:

1. **Model**: an unlisted model is a 400 naming the allowed set, not a silent
   fallback. The BFF always sends `model` explicitly. `main.py` changes the
   fallback to a refusal (`{"error": "model not allowlisted"}`) so a client that
   bypasses the BFF fails visibly.
2. **Timeout**: `min(requested ?? profile.task_timeout_s, profile.task_timeout_s)`.
3. **Lifetime**: the reaper reads idle and max-lifetime from the box's profile
   instead of the module constants (DE-48 aligns these with the runtime's 8 h cap).
4. **SDLC `model_allowlist`**: evaluated against the profile's list when no
   explicit policy row exists, so review and dispatch agree.

What stays deploy-time, because AgentCore fixes it per runtime: network mode
and the execution role. Each `(network_class, org_access)` pair becomes a
runtime (at most four; two at first: `public/none` and
`egress-allowlist/none`), and `resolveDevboxArn` takes the box's profile and
picks the runtime ARN. Profiles name a class; they never carry an ARN.

**IAM backs the allowlist.** The execution role's Bedrock resources narrow from
`*anthropic*` to the union of models any profile may name, passed as
`--context devboxModels=...`. This is the only control that covers command
mode and the PTY.

**Org access** uses the read-only secret for the `read` runtime, fixing the
master-secret grant.

**Editing**: `PUT /api/devbox/profiles/:id` (new version) and
`PATCH /api/graph/projects/:id/devbox-profile` (initiatives are `projects` rows, mounted at `index.ts:229`), gated by the actions DE-42 adds.
Seed: `default` copies today's values (Haiku/Sonnet/Opus allowlist, 840 s,
20 min idle, 60 min max, public, none). Mock floor: a registered fixture; the
initiative column is read from the `projects` fixture.

## Decisions owed

- Who edits profiles and who assigns one to an initiative? Proposal:
  editing a profile is `hr-admin` and `admin` (the registry-editing roles);
  assigning one is the initiative's program owner or an org-leader, from the
  existing published profiles only.
- Do running boxes pick up a new profile version? Proposal: no. New boxes get
  it; the reaper's lifetime does use the newer, shorter value if it shrank.
- Should `org_access: read` exist at all for boxes? Proposal: yes, but only
  with the read-only secret, and only on a profile an admin creates.

## Done when

- `cd middleware && npx jest devbox-profile` covers: an unlisted model gives
  400 at `/api/devbox/:sid/task` and the internal router; a timeout above the
  profile is clamped; a box records its profile version and keeps it after the
  profile changes.
- `cd agents/devbox && python -m pytest test_main.py` has a test that an
  unlisted model returns an error and starts no `claude` process.
- A reaper test stops a box at its profile's max lifetime, not the env default.
- `cd infra && npx cdk synth OrgIQ-Devbox -c devboxOrgAccess=true` emits no
  reference to `aurora-secret-arn`, only `aurora-readonly-secret-arn`; and the
  Bedrock statement lists exactly the configured model ARNs.
- Changing an initiative's profile needs no `cdk deploy`.
