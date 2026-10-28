# DE-12 Guardrail lifecycle

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Depends on nothing; DE-14 (orchestrator) and DE-15 (CI) would call its promote
step.

## Current state (read from the code, 2026-10-27)

`OrgIQ-Guardrails` builds three role-keyed guardrails (`member`, `org-leader`,
`hr-admin`) that share a PII/content/word floor and differ only in denied
topics (`infra/lib/guardrails-stack.ts:54`, `:184`). Each gets one
`CfnGuardrailVersion` with a fixed logical id `Guardrail<Role>V1`
(`guardrails-stack.ts:253`). The backlog line says "versioned per-role
guardrails"; per-role exists, versioning effectively does not:

- **Nothing runs a published version.** Every runtime gets
  `GUARDRAIL_VERSION: 'DRAFT'` (`infra/lib/agentcore-runtime-stack.ts:447`) and
  the supervisor passes it straight to `BedrockModel`
  (`agents/supervisor/main.py:380`). So a CDK change or a portal edit is live
  on the next model call, with no test in between.
- **The V1 resource never moves.** Its properties are only the guardrail id
  and a description, so a policy change updates the DRAFT and leaves version 1
  as the original spec (CloudFormation behaviour, inferred from the template,
  not checked against a deployed stack). Only the member version is exported
  (`guardrails-stack.ts:277`).
- **The portal edits DRAFT in place.** `PATCH/POST/DELETE
  /api/capabilities/guardrail/*` (`middleware/src/routes/capabilities.ts:57-83`,
  gated by `EditGuardrail`, held by `hr-admin.cedar`) issue a full-PUT
  `UpdateGuardrail` (`middleware/src/providers/guardrails.ts:213-305`). That is
  live-vs-code drift by design: the next `OrgIQ-Guardrails` update that changes
  the template overwrites it, and an unchanged template leaves it forever.
- **The editor targets one guardrail, and not in the cloud.** It reads
  `config.guardrail.id` = `GUARDRAIL_ID` (`middleware/src/config.ts:110`).
  `schema/dump-stack-outputs.sh:156` fills that from the member export locally;
  `infra/lib/middleware-service-stack.ts:892` sets only the three per-role ids,
  so the deployed BFF calls `GetGuardrail` with an empty identifier.
  `org-leader` and `hr-admin` cannot be edited or viewed at all.
  `config.guardrail.byRole` (`config.ts:114`) has no reader.
- **Tests check shape, not behaviour.** `infra/test/supporting-stacks.test.ts:17`
  asserts three guardrails, their exports and the PII floor;
  `infra/test/agentcore-runtime-stack.test.ts:269` asserts the supervisor alone
  carries the ids; `agents/tests/test_supervisor_cache.py:50` asserts two roles
  never share one. No golden case (`agents/tests/golden/supervisor.json`) sends a
  denied-topic or PII prompt, and nothing calls `ApplyGuardrail` against a spec.
- Fail-open corner: with no ids in env the supervisor's role map is
  `{member: ""}` and the model runs with no guardrail (`main.py:412`, `:377`).
  Deployed runtimes always carry the ids; the corner is local only.

## Change

**One spec, in code.** Move the role policies out of the stack constructor into
`infra/lib/guardrails/spec.ts` (data only: shared floor + `ROLE_TOPICS`), with a
`specHash(role)` over its canonical JSON. The stack renders from it unchanged.

**Published versions, pinned per role.** Replace the fixed `V1` resource with
one whose logical id carries the spec hash (`Guardrail<Role>V<hash8>`), so a
spec change mints a new immutable version and the old one is retained
(`RemovalPolicy.RETAIN` on the version). Export
`${prefix}-guardrail-version-<role>`. The runtime stack passes
`GUARDRAIL_VERSION_MEMBER/_ORG_LEADER/_HR_ADMIN` instead of the shared
`DRAFT`, and `_model_kwargs` picks the version that matches the id it attached.
`DRAFT` stays reachable only behind `GUARDRAIL_VERSION_OVERRIDE=DRAFT` for a
non-production runtime.

**Tests before promotion.** `agents/tests/guardrail_cases/<role>.json`: prompts
with the expected outcome per role (salary question blocked for `member` and
`org-leader`, allowed for `hr-admin`; health blocked for all; SSN blocked;
`EMP-1234567` anonymised; a long multi-step agentic prompt **not** blocked, the
regression `PROMPT_ATTACK MEDIUM` guards against, `guardrails-stack.ts:228`).
Two runners over one file:
- offline: asserts each case's topic/PII/word expectation against `spec.ts`
  (does the spec deny the topic the case names) — runs in `npm test`;
- live: `scripts/guardrail-promote.mjs --role <r> --version <n>` calls
  `ApplyGuardrail` (`source: INPUT`, then `OUTPUT`) on the candidate version and
  refuses to promote on any mismatch. Promotion = redeploying the runtime stack
  with the new version export; `deploy.sh` runs the live suite first when the
  guardrail stack changed.

**Drift detection.** `scripts/guardrail-drift.mjs` (read-only): for each role,
`GetGuardrail` on DRAFT and on the pinned version, normalise both, compare with
`spec.ts`; exit 1 naming the role and field. Also report when the pinned version
in the runtime env differs from the exported one. Wire it into `deploy.sh`'s
post-deploy reconcile and a `validate-guardrail-lifecycle.sh --quick` (offline:
spec ↔ template ↔ cases).

**The portal editor becomes a proposal surface** (see decisions): reads all
three roles via `byRole`, shows DRAFT vs pinned vs code diff, and edits stop
being silently live because runtimes no longer read DRAFT.

## Decisions owed

- What the portal editor is for once runtimes pin versions. Proposal: keep
  DRAFT edits as a sandbox (`hr-admin`, `EditGuardrail`) with a "test this
  draft" action that runs the case file through `ApplyGuardrail` on DRAFT;
  making it live means changing `spec.ts` in git. Alternative: a portal
  "publish" that calls `CreateGuardrailVersion` and accepts permanent drift
  from code.
- Roles outside `orgiq` (`sme`, `program-owner`, every assessment/social/
  pipelines/access role) fall back to `member` (`main.py:418`). Proposal: keep
  the fallback but make it explicit in `spec.ts` and test it, rather than add
  guardrails per tenant now.
- How many old versions to retain. Proposal: last three per role (Bedrock's
  per-guardrail version quota is unverified here).

## Done when

- `cd infra && npm test`: a test asserts each role's version logical id changes
  when its spec changes and not otherwise, the version export exists per role,
  and no runtime env carries `GUARDRAIL_VERSION: 'DRAFT'`.
- `agents/tests/test_supervisor_cache.py` (or a sibling) asserts the attached
  version matches the role's id and that an empty id map refuses to build in
  `APP_ENV=production` instead of running unguarded.
- `scripts/validate-guardrail-lifecycle.sh --quick` passes offline: every case
  file role exists in `spec.ts`, every denied topic has at least one blocked and
  the `hr-admin` salary case is allowed.
- With credentials: `node scripts/guardrail-promote.mjs --role member --dry-run`
  prints per-case results against the candidate version and exits non-zero on
  a seeded mismatch; `node scripts/guardrail-drift.mjs` exits 0 after a clean
  deploy and 1 after a portal topic edit on DRAFT. (Cloud steps unverified until
  credentials return.)
- `GET /api/capabilities/guardrail?role=org-leader` returns that role's
  guardrail in `dev:mock` and in a deployed BFF (no empty-id call).
