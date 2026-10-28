# DE-14 Single resumable deploy orchestrator

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Needs DE-17 (the environment file it reads) and DE-16 (the credential guard it
calls between phases). Calls DE-1's `agents/rollout.sh` and DE-52's `agents/devbox/rollout.sh` as
phases, and passes DE-18's `middlewareImageDigest`. Unblocks DE-15 (CI runs
this command, nothing else) and DE-21 (its gate is the `verify` phase).

## Current state (read from the code, 2026-10-27)

A deploy is the hand-run Runbook A (`docs/social-calls-deploy-plan.md:775-850`),
about fifteen commands across five tools:

| Phase | Command today | What it leaves behind |
|-------|---------------|-----------------------|
| fleet | `infra/scripts/deploy.sh` | live stacks only |
| agent images | `agents/base/build.sh`, `agents/build-all.sh` | `:latest` tags, logs in `/tmp/orgiq-build-*.log` (`build-all.sh:42-43`), no digest |
| runtimes | `deploy.sh OrgIQ-AgentCoreRuntime --context deployRuntimes=true` | digest picked at **synth** by `resolveContainerUri` (`infra/lib/agentcore-runtime-stack.ts:14-36`, `:412`) |
| middleware image | `scripts/docker/middleware-image-build.mjs` | `.scratch/middleware-image/report.json` (`:153-156`); the service pulls `:latest` (`middleware-service-stack.ts:1104`), so it prints a `--force-new-deployment` to run by hand (`:78`, `:159`) |
| middleware + portal | `deploy.sh OrgIQ-MiddlewareService OrgIQ-Portal -e …` | stacks |
| portal | `scripts/portal-publish.mjs` | nothing recorded |
| auth URLs, callbacks | `deploy.sh OrgIQ-Authentication …`, then the runtimes again | stacks |
| Social | `deploy.sh OrgIQ-SocialImages`, `social-images-build.mjs`, four more `deploy.sh` calls | `.scratch/social-images/report.json`; digests pasted into `--context` |
| documents | `scripts/document-workspace.mjs build`, `document-workspace-push.mjs` | `.scratch/document-workspace/push-report.json` and SSM `/<prefix>/documents/workspace-config` (`push.mjs:151-156`); it prints the next deploy command (`:158`) |
| devbox | `agents/devbox/build.sh` (DE-52 replaces it) | `:latest` |

What already works and must be kept:

- **`deploy.sh` reads live state back.** Its sticky-context block
  (`deploy.sh:382-468`) infers the phase-2 flags, the SFU and platform-api
  digests (`:418-433`) and the document context from SSM (`:441-447`) once they
  are live. A value passed explicitly wins (`infer` → `ctx_given`, `:377-380`).
- **It reports real stack status** after `cdk deploy`. The reconcile at
  `:696-727` exits non-zero on any stack that is not `*_COMPLETE`, and it retries
  the KB race and a blocked replacement once each (`:608-618`, `:665-688`).
- **The image scripts are pure planners with `--dry-run`**
  (`planMiddlewareImage`, `planSocialImages`, `planDocumentPush`,
  `planPublish`), and each is tested under `scripts/docker/tests/`.

**The backlog line is partly stale.** "Digests copied between steps" is now
true only for a **first** Social rollout and for each new Social image. After
that, `deploy.sh` infers the digests. The middleware has no digest to copy at
all, because it runs `:latest` (DE-18). The listed order also leaves out three
steps that Runbook A needs: the second runtimes pass that closes the callback
guards, the `OrgIQ-Authentication` pass with `portalPublicUrl`, and the devbox.
The state that does exist is spread over three report files with three
different schemas. No file records which phase finished.

## Change

**One command**, `node scripts/deploy/orchestrate.mjs <plan|apply|resume|status>
[--env lab] [--only a,b] [--from <phase>] [--dry-run]`. It follows the shape of
the `scripts/docker/*.mjs` scripts: a pure `planDeploy(env, probes, previous)`
plus a thin runner.

**Phases are data** (`scripts/deploy/phases.mjs`). Each phase has an `id`, its
`needs`, an `enabled(env)` test from the DE-17 environment file (Social,
documents and devbox are opt-in per environment), a **probe** that reads the
live account, an **input key**, and an action that invokes the existing script:

1. `preflight`: the DE-16/DE-17 guard. It checks the account against the
   environment file, the credential lifetime, `docker buildx` (only when an
   image phase runs), `cdk --version`, and a clean tree for the paths being
   built.
2. `fleet`: `deploy.sh` with no stack names.
3. `runtimes`: DE-1's `agents/rollout.sh`. It builds the base and the agents,
   compares digests, and deploys with `deployRuntimes=true` only when one
   changed.
4. `middleware-image`, then `middleware-portal`: phase 2 with `deployPortal`,
   the environment's `albAllowCidr` and `--context middlewareImageDigest=…`
   (DE-18). Until DE-18 lands, run `update-service --force-new-deployment`, and
   only when the digest changed.
5. `portal-publish`, then `auth-urls`: Authentication with `portalPublicUrl`,
   and the middleware with `portalPublicUrls`. On a later run `deploy.sh`
   infers both and this phase does nothing.
6. `runtime-callbacks`: the runtimes again. The secrets are inferred
   (`deploy.sh:453-460`).
7. `social-*`, `documents-*`, `devbox` (`rollout.sh`, DE-52), each gated by the
   environment file.
8. `verify`: `/health` through the portal origin, ECS desired = running, and
   runtime `READY`. DE-21 adds the smoke specs here.

**Done is decided by the live account. The state file is a record.** A phase is
skipped when its probe reports it live **and** its input key matches the last
recorded success. The input key is the git tree hash of the paths the phase
builds, plus the context it passes. For example, `runtimes` is skipped when
`orgiq-supervisor:<commit12>` already exists in ECR and `agents/` is unchanged.
So a resume on another machine, or after the state file is lost, re-derives the
same plan. The state file only saves time and keeps the history.

**State file**, `.scratch/deploy/<env>/state.json` (gitignored, `.gitignore:15`):

```json
{ "schemaVersion": 1, "env": "lab", "account": "647757222309", "region": "us-east-1",
  "runId": "2026-10-27T18:02Z-89cc3143", "commit": "<40 hex>",
  "phases": { "middleware-image": { "status": "done", "inputKey": "…",
    "startedAt": "…", "finishedAt": "…", "outputs": { "digest": "sha256:…" } } } }
```

Every phase is written before it starts (`running`) and after it ends (`done`
or `failed`, with the exit code and the last 40 log lines). The write uses a
temp file and a rename, so an interrupted write cannot leave a torn file. The
three per-script report files stay; their digests are copied into `outputs`.
After each phase the file is also put to SSM `/<prefix>/deploy/last-run` as a
`String` parameter, so CI (DE-15) and a second machine see the same run.

**A lock.** `aws ssm put-parameter --name /<prefix>/deploy/lock` without
`--overwrite` is an atomic create. The value is `{runId, host, startedAt}`.
`apply` refuses while the lock exists. `--break-lock` prints the holder and
takes the lock only when the user confirms. This stops a laptop deploy and a CI
deploy from interleaving.

**Digests flow as explicit context.** An image phase writes its digest into
`outputs`, and every later `deploy.sh` call passes it as `--context
sfuImageDigest=…` (and the same for each digest). An explicit value beats the
inferred one, so a fresh digest can never lose to a stale live one.

**Unchanged:** `deploy.sh` stays the only way CloudFormation is touched, and the
orchestrator treats its exit code as the result of the phase. Each script keeps
working on its own.

## Decisions owed

- Where the authoritative run record lives: SSM only, or an S3 object (history,
  larger logs). Proposal: SSM `last-run` plus the lock now (a small `String`;
  logs stay local), and S3 when DE-15 needs artifacts.
- Does the orchestrator run the schema loader (DE-20) and the page-thread
  migration? Proposal: no. Migrations need sign-off (open item 3), so leave a
  `schema` phase slot that prints the pending step and stops.
- How strict the clean-tree rule is: refuse on a dirty tree, or build `HEAD` and
  warn, as `middleware-image-build.mjs:140` does. Proposal: refuse in `apply`
  and allow `--working-tree` only with `--only`.

## Done when

- `node --test scripts/deploy/tests/orchestrate.test.mjs` passes, covering:
  - A fresh-account probe fixture plans every enabled phase in Runbook A order,
    including `auth-urls` and `runtime-callbacks`.
  - An all-live fixture with unchanged input keys plans only `preflight` and
    `verify`.
  - A changed Social source commit plans `social-images` and the stacks after
    it, and passes the new digest as explicit `--context`.
  - Killing the runner after phase N (simulated) and then calling `resume`
    replans from N+1. A deleted state file yields the same plan.
  - A torn or invalid state file is rejected and the probes decide.
  - A second `apply` while the lock is held exits non-zero and names the holder.
- `orchestrate.mjs plan --env lab --dry-run` against the live account prints
  every command, with real digests and inferred context, and makes no write
  call. A stubbed `aws` and `docker` on `PATH` record no mutating verb.
- A real `apply` followed by an immediate second `apply` runs no `cdk deploy`,
  no `docker push` and no `update-service`.
