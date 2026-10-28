# DE-2 Digest-pinned agent images and versioned rollout

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Part 1 unblocks DE-1. Part 2 is the mechanism DE-5's eval gate promotes
through. It follows the devbox digest context in DE-52 for the agent fleet.

## Current state (read from the code, 2026-10-27)

- **The runtimes are already digest-pinned.** The backlog's "pin each runtime
  to an image digest" is stale. Phase 2 sets `containerUri` from
  `resolveContainerUri`, which turns `:latest` into `repo@sha256:…` at synth
  time (`infra/lib/agentcore-runtime-stack.ts:14-36`, `:412`). The pin is
  wrong in three ways:
  - **Nothing is recorded.** No stack output or context holds the digest.
  - **Every synth picks the digest again.** A push rolls the agent on the next
    unrelated deploy. An ECR error during synth rolls it to `:latest` (`:31-35`).
  - **It is not reproducible.** Each agent builds `FROM orgiq-agent-base:latest`
    (`agents/build-all.sh:16`). The base image builds `FROM python:3.12-slim`
    with no digest (`agents/base/Dockerfile:11`, `:42`), and its dependencies
    are `>=` ranges (`:23`).
  - **The phase 2 tests shell out to AWS.** They synthesise phase 2
    (`infra/test/agentcore-runtime-stack.test.ts:35`), which calls
    `resolveContainerUri`. The template then depends on whatever AWS answers
    on the test machine.
- **Endpoints exist but nothing uses them.** Each runtime gets a
  `CfnRuntimeEndpoint` named `<runtime>_endpoint`, with no version
  (`agentcore-runtime-stack.ts:508-513`). Every caller invokes
  `qualifier: 'DEFAULT'` instead:
  - `middleware/src/providers/agentcore.ts:715`, `:771`;
  - `routes/invocations.ts:876`;
  - `lib/harness-runner.ts:269`;
  - the supervisor's sub-agent call (`agents/supervisor/main.py:126`).

  The devbox calls (`lib/devbox-runner.ts:146`, `routes/devbox.ts:595`)
  belong to DE-52 and stay on `DEFAULT`.

  `DEFAULT` is created and managed with the runtime
  (`infra/scripts/destroy.sh:234`). So the CDK endpoint is dead weight, and
  every update reaches all traffic at once.
- **`onlyAgents` cannot be a canary.** It decides which runtimes exist, not
  which version serves (`agentcore-runtime-stack.ts:403`). On a live stack it
  deletes the agents it leaves out (DE-1).
- **What the installed CDK exposes.** These come from aws-cdk-lib 2.270.0
  (`infra/node_modules/aws-cdk-lib/aws-bedrockagentcore/lib/bedrockagentcore.generated.d.ts`):
  - `CfnRuntime` has the attribute `AgentRuntimeVersion` (`:10984`).
  - `CfnRuntimeEndpoint` takes an optional `agentRuntimeVersion` (`:11910`)
    and exposes `LiveVersion` and `TargetVersion` (`:11869`, `:11881`).
  - The endpoint has **no weight or traffic-split property** (`:11898-11930`).
    A percentage shift therefore cannot be declared in CloudFormation. It has
    to happen in the caller, by picking a qualifier.
- **Unverified (not checkable from this repo):**
  - whether `DEFAULT` always tracks the newest version, or can be pinned;
  - what an endpoint with no `agentRuntimeVersion` serves;
  - how many versions AgentCore keeps;
  - whether in-flight sessions drain when an endpoint's version changes.

  The code assumes that `DEFAULT` follows each update.
- **Old pinned images can be deleted.** Each repo keeps 5 images
  (`lifecycleRules: [{ maxImageCount: 5 }]`, `agentcore-runtime-stack.ts:186`,
  `:208`, which counts every image). A pinned or rollback digest can be
  expired after five pushes.

## Change

**Part 1: the digest as context** (needed by DE-1).

- **Stack.** `AgentCoreRuntimeStack` reads
  `--context agentImageDigests='{"search":"sha256:…",…}'`:
  - Each value is checked with the `sfuImageDigest` pattern
    (`infra/lib/social-media-stack.ts:177-186`).
  - An agent name that is not in the fleet throws.
  - An agent with a digest uses `repo@digest` and does not shell out.
  - An agent without a digest falls back to `resolveContainerUri`, with a
    synth warning. Remove the fallback once DE-1 has run once.
  - Each runtime gets a `<Pascal>ImageDigest` output and a
    `<Pascal>RuntimeVersion` output (`attrAgentRuntimeVersion`).
- **`deploy.sh` inference.** It builds the map from those outputs. The given
  map is **merged over** the inferred one. This is new: `infer` skips any key
  the caller passed (`infra/scripts/deploy.sh:377-381`), so the key needs its
  own merge step. A rollout that passes only `search` keeps the other seven
  digests, and a plain `deploy.sh` rolls nothing.
- **ECR.** The lifecycle keeps the last 20 `git-`-tagged images (DE-1 tags
  them) and expires untagged images after 7 days.
- **Base image.** `agents/base/Dockerfile` pins `python:3.12-slim@sha256:…`.
  The base image installs from a `uv` lock exported at build time, not from
  `>=` ranges.

**Part 2: versioned endpoints and the caller-side canary.**

- **Endpoints.** Replace `<runtime>_endpoint` with two endpoints per agent:
  - **`live`** takes `agentRuntimeVersion` from `--context
    agentLiveVersions='{"search":"7"}'`, inferred by `deploy.sh` from the
    endpoint's `LiveVersion`. With no entry, it is created at the version the
    runtime has at that moment, so a later image update does not move it.
  - **`canary`** has no pinned version, so it follows the newest version.
    Whether that holds is unverified; checking it is the first task.
- **One qualifier resolver.** Add `qualifierFor(agent, { sessionId,
  userId })` in `middleware/src/providers/agentcore.ts`. All four middleware
  call sites use it in place of the literal `'DEFAULT'`. It reads SSM
  `/orgiq/agents/routing`, for example
  `{ "search": { "canaryPercent": 10, "canaryUsers": ["u-…"] } }`, with a
  60 s cache:
  - The share is sticky per `sessionId` (a hash), so a conversation never
    switches version partway.
  - If the parameter is missing, it answers `live`.
  - Under `MOCK_AGENTCORE` it answers `live`, so the mock floor stays
    unchanged.
- **Supervisor.** The supervisor reads `SUBAGENT_QUALIFIER`, default `live`,
  in place of the literal at `main.py:126`.
- **Traces.** Each invocation stamps the chosen qualifier, so DE-5 and DE-9
  can compare `live` and `canary` error and quality rates.
- **`infra/scripts/agent-promote.sh <agent> [--rollback]`.** It reads the
  canary's `LiveVersion` and redeploys with that agent's `agentLiveVersions`
  entry moved, then resets `canaryPercent` to 0. `--rollback` sets the canary
  share to 0 and leaves `live` where it is. Neither path pushes an image.
- **Order.** Middleware and supervisor first, so they move to `live` while
  `live` still equals `DEFAULT`. Then the stack change. Only after that is
  any canary share above zero.

## Decisions owed

- **Can sub-agent calls made by the supervisor go to a canary?** Proposal: no
  for now. The supervisor always calls `live`, and canaries cover direct
  invocations and the supervisor itself. Pass the qualifier through the
  payload later if needed.
- **The promotion rule until DE-5 exists.** Proposal: promote by hand with
  `agent-promote.sh`, after at least 50 canary invocations whose
  `errorRate` and `lowQualityRate` are no worse than `live`'s
  (`routes/traffic.ts` reports both).
- **How many images to keep.** Proposal: 20 `git-` tags per repo, about
  20 × 8 small layers on top of the shared base, which costs cents.

## Done when

- `cd infra && npm test` passes with new cases in
  `agentcore-runtime-stack.test.ts`:
  - With `agentImageDigests`, each `ContainerUri` is `…/orgiq-<agent>@sha256:…`
    and `execFileSync` is never called (stub it so it throws).
  - A malformed digest throws, and so does an unknown agent key.
  - Each runtime has `ImageDigest` and `RuntimeVersion` outputs.
  - The `live` endpoint carries `AgentRuntimeVersion` from
    `agentLiveVersions`.
  - No `<runtime>_endpoint` resource remains.
- `deploy-config.test.ts`'s inferred-key list includes `agentImageDigests`
  and `agentLiveVersions`, and a new case asserts the merge, not the skip.
- Middleware jest covers `qualifierFor`:
  - a missing parameter gives `live`;
  - 10% gives a stable answer per session;
  - a user in `canaryUsers` always gets `canary`.
- `rg "qualifier: 'DEFAULT'|\"qualifier\": \"DEFAULT\"" middleware/src
  agents -g '!*test*' -g '!*devbox*'` returns no matches.
- After a real canary of `search`:
  - `get-agent-runtime-endpoint … live` keeps its `liveVersion`;
  - after `agent-promote.sh search`, it moves to the canary's version;
  - a plain `./infra/scripts/deploy.sh` afterwards changes neither.
