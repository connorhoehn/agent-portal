# DE-52 Deployable devbox phase 2

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Unblocks DE-51. One phase of DE-1/DE-14 (neither has a spec yet). It touches
DE-49, because every runtime roll wipes `/mnt/workspace`.

## Current state (read from the code, 2026-10-27)

- `OrgIQ-Devbox` is two-phase (`infra/lib/devbox-stack.ts:71-74`). Phase 1
  creates the ECR repo and the execution role. Phase 2 (`deployDevbox=true`,
  `:89-90`) adds the `CfnRuntime` and its endpoint (`:213-267`). AWS has phase 1
  only (`docs/aws-deploy-open-items-2026-10-27.md:12`).
- `agents/devbox/build.sh` is standalone. It is not part of
  `agents/build-all.sh`, and it pushes `orgiq-devbox:latest` (ARM64) and then
  prints the follow-up deploy command by hand (`build.sh:31`).
- The image is pinned at **synth time**. `resolveContainerUri` shells out to
  `aws ecr describe-images … imageTag=latest` and returns `repo@sha256:…`
  (`infra/lib/agentcore-runtime-stack.ts:14-36`). As a result, any synth after
  a push changes the runtime's container URI, including a plain `deploy.sh` run
  for an unrelated stack. That rolls the runtime and wipes every session
  workspace (`devbox-stack.ts:66-69`, `build.sh:6-7`). No digest is recorded
  anywhere.
- **`deploy.sh` does not keep the gate.** Its sticky-context block infers
  `deployRuntimes` from a live runtime count (`infra/scripts/deploy.sh:384-386`)
  so that a later deploy cannot delete the agent runtimes. It has no such rule
  for `deployDevbox`. Once phase 2 exists, the next `./scripts/deploy.sh`
  without the flag deletes the devbox runtime. The backlog does not mention this
  hazard, and it is the main reason phase 2 must not be hand-run.
- The middleware discovers the runtime by name through `ListAgentRuntimes`
  (`middleware/src/lib/devbox-arn.ts:74-104`; grant at
  `middleware-service-stack.ts:542-550`), so no middleware redeploy is needed.
  A `null` answer is cached for 5 minutes (`devbox-arn.ts:21`), so
  `GET /api/devbox/status` (`middleware/src/routes/devbox.ts:413`) can report
  `deployed: false` for up to 5 minutes after the runtime exists.
- Teardown already covers the stack: `destroy.sh:218` pre-drains
  `OrgIQ-Devbox`, and `deploy.sh:270` sweeps the orphan `orgiq-devbox` repo.
- The Dockerfile installs `@anthropic-ai/claude-code` unpinned
  (`agents/devbox/Dockerfile:30`), so two builds of the same commit can differ.

## Change

**1. Digest as context, not a synth-time lookup.** `DevboxStack` takes
`--context devboxImageDigest=sha256:<64 hex>`, validated with the
`sfuImageDigest` pattern (`infra/lib/social-media-stack.ts:177-186`). With the
digest it uses `repo@digest` and does not shell out. Without it, phase 2 falls
back to `resolveContainerUri` and adds a synth warning. A `DevboxImageDigest`
stack output records what was deployed.

**2. Sticky context.** `deploy.sh` infers `deployDevbox=true` when
`OrgIQ-Devbox` owns an `AWS::BedrockAgentCore::Runtime`, and
`devboxImageDigest` from the `DevboxImageDigest` output. DE-51 adds
`labCallbackSecret`. A full `deploy.sh` then keeps the runtime, the pinned
image and the lab wiring, and rolls nothing by accident.

**3. One idempotent command**, `agents/devbox/rollout.sh [--dry-run]
[--allow-wipe]`, written so DE-14 can call it as one phase:

1. Preflight: `aws sts get-caller-identity` must be 647757222309, and
   `docker buildx` must be available.
2. Phase 1 if the repo is missing: `./infra/scripts/deploy.sh OrgIQ-Devbox`.
3. Build and push through `build.sh`, tagging both `latest` and the git sha.
   Read the pushed digest with `aws ecr describe-images`.
4. Compare it with the live runtime's container URI
   (`aws bedrock-agentcore-control get-agent-runtime`). If they are equal,
   skip to step 7: nothing rolls and no workspace is wiped.
5. Wipe guard: when `GET /api/devbox/boxes` reports any box `running`, refuse
   without `--allow-wipe`. A digest change wipes every workspace.
6. Run `./infra/scripts/deploy.sh OrgIQ-Devbox --context deployDevbox=true
   --context devboxImageDigest=<digest>`. The lab context is inferred (DE-51).
7. Bounded wait (max 10 min, 15 s polls, never `until grep`) for the runtime
   and its endpoint to report `READY`.
8. Verify: `GET /api/devbox/status` returns `deployed: true` within 6 minutes
   (the null-cache TTL), then run the DE-51 `lab recall` smoke.

`--dry-run` prints steps 2-6 with the digest it would deploy and changes
nothing.

**4. Pin the CLI.** Add an `ARG CLAUDE_CODE_VERSION` to the Dockerfile
(`npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`) with the
version recorded in `build.sh`, so a rebuild of one commit gives one image.

## Decisions owed

- Is a workspace wipe on every image change acceptable until DE-49 lands?
  Proposal: yes, behind the `--allow-wipe` guard, and with the digest skip in
  step 4 so a no-op rollout never wipes.
- Model allowlist default. `DEVBOX_ALLOWED_MODELS` lists
  `us.anthropic.claude-sonnet-5` and `us.anthropic.claude-opus-4-8`
  (`devbox-stack.ts:245`), and the operator memory says box work is
  Sonnet/Haiku only. Proposal: ship the first AWS rollout with Haiku and Sonnet
  only, and add Opus when DE-40 profiles exist.
- Turn on `devboxOrgAccess` in AWS? Proposal: no for the first rollout. The
  read-only Aurora and KB grants (`devbox-stack.ts:176-197`) are not needed by
  the lab loop.

## Done when

- `cd infra && npm test` passes with new assertions:
  - `devbox-stack.test.ts`: with `devboxImageDigest` the runtime's
    `ContainerUri` is `…/orgiq-devbox@sha256:…`; a malformed digest throws.
  - `deploy-config.test.ts`'s inferred-key list includes `deployDevbox` and
    `devboxImageDigest`.
- `bash -n agents/devbox/rollout.sh` passes, and `rollout.sh --dry-run`
  against the live account prints the planned digest and deploy command
  without calling `cdk deploy`.
- After a real rollout:
  - `aws bedrock-agentcore-control list-agent-runtimes --query
    "agentRuntimes[?agentRuntimeName=='orgiq_devbox'].status"` returns `READY`;
  - `curl -b <jar> $PORTAL_URL/api/devbox/status` returns `"deployed":true`.
- A second `rollout.sh` with no code change exits at step 4, and the runtime's
  `agentRuntimeVersion` is unchanged.
- A following plain `./infra/scripts/deploy.sh` leaves the devbox runtime's
  version unchanged.
