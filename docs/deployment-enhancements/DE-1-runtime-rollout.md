# DE-1 One-command agent runtime rollout

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Depends on DE-2 part 1 (digest context), which gives the rollout its no-op
check. Same shape as the devbox rollout in DE-52. DE-14 calls both as phases.

## Current state (read from the code, 2026-10-27)

The backlog line is accurate about the three hand-run steps. It leaves out the
hazards that make those steps unsafe to repeat:

- **Two phases are gated by context.** Phase 1 creates the base repo, eight
  agent repos and their execution roles (`infra/lib/agentcore-runtime-stack.ts:182-400`).
  Phase 2 adds a `CfnRuntime` and a `CfnRuntimeEndpoint` per agent, and only
  when `deployRuntimes=true` (`:164`, `:402`, `:406-513`). AWS has run phase 2:
  "8 AgentCore runtimes READY" (`docs/aws-deploy-open-items-2026-10-27.md:15`).
- **Images are pinned at synth time.** `resolveContainerUri` shells out to
  `aws ecr describe-images … imageTag=latest` and returns `repo@sha256:…`. On
  any error it falls back to `:latest` (`agentcore-runtime-stack.ts:14-36`).
  This has three side effects:
  - On a first phase 2 with an empty repo, the runtime is created against a
    missing `:latest` tag and fails. That is the gotcha in CLAUDE.md.
  - Any synth after a push changes the container URI, so any later
    `deploy.sh` rolls every agent whose image moved.
  - A transient ECR failure during a deploy flips a digest URI to `:latest`.
    That is still a template diff, so the runtime rolls anyway.
- **`deploy.sh` keeps the gate but not the image.** It infers
  `deployRuntimes=true` from a live runtime count
  (`infra/scripts/deploy.sh:384-386`), so a later deploy does not delete the
  runtimes. Nothing records which digest is live. `deploy.sh` has no dry-run.
- **`onlyAgents` deletes the runtimes it leaves out.** Phase 2 skips any agent
  not in the set (`agentcore-runtime-stack.ts:403`). Once all eight are live,
  `--context onlyAgents=search` removes the other seven from the template and
  CloudFormation deletes them. The test only covers the first-deploy use
  (`infra/test/agentcore-runtime-stack.test.ts:75-85`). The backlog calls
  `onlyAgents` "all-or-nothing". That is wrong: it is a subset, and a
  destructive one on a live stack.
- **The builds are not tied to each other.** `agents/base/build.sh` pushes
  `orgiq-agent-base:latest` (`:9-24`). `agents/build-all.sh` builds every
  agent `FROM` that moving tag (`:16`, `:48`) and pushes only `:latest`
  (`:42`). It writes logs to `/tmp` and records no digest. A base change and
  an agent build are not linked, so an agent can ship on a stale base.
  `--provenance=false` (`build-all.sh:47`) makes the pushed digest the image
  manifest, so a buildx `--metadata-file` digest is the one ECR stores.
- **The fleet list is written out four times:**
  `agentcore-runtime-stack.ts:88-97`, `infra/lib/agents-stack.ts:23-35`,
  `build-all.sh:27` and the orphan-repo sweep at `deploy.sh:261-268`. The
  sweep's comment (`:255-259`) records the day one copy fell behind.
- **There is a precedent to copy.** `scripts/docker/social-images-build.mjs`
  has a `--dry-run` that runs no Docker and calls no AWS (`:8`, `:151-159`),
  reads digests from buildx metadata (`digestFromMetadata`, `:120-123`) and
  prints them as CDK context. It is tested in
  `scripts/docker/tests/social-images-build.test.mjs`.

## Change

**1. One fleet manifest.** `agents/fleet.json` lists the agent names. The two
stacks, the build script and `deploy.sh`'s sweep all read it. A test asserts
that every directory with a `main.py` under `agents/` appears in the manifest,
except `_shared`, `base`, `devbox` and `tests`.

**2. `scripts/docker/agent-images-build.mjs [--dry-run] [--only a,b]`**,
modelled on `social-images-build.mjs`:

- **Base image.** Tag it `base-<hash>`, where the hash covers
  `agents/base/Dockerfile` plus the pinned dependency inputs. Skip the build
  when ECR already has that tag. Push `latest` as well, for compatibility.
- **Agent images.** Build each agent with `BASE_IMAGE=<base repo>@<digest>`,
  never `:latest`. Pass `--metadata-file`. Tag each image `latest` and
  `git-<sha>`.
- **Output.** Write `{ agent: digest }` to
  `.scratch/agent-images/<sha>.json` and print it as DE-2's
  `agentImageDigests` context.
- **Old scripts.** `base/build.sh` and `build-all.sh` become thin wrappers so
  the existing docs keep working.

**3. `agents/rollout.sh [--dry-run] [--only a,b] [--skip-build] [--smoke]`**,
idempotent, in the same shape as DE-52's `agents/devbox/rollout.sh`. The
helpers both scripts need go in `infra/scripts/lib/runtime-rollout.sh`: the
account preflight, the live-digest read, and the bounded READY wait.

1. **Preflight.** `aws sts get-caller-identity` must return 647757222309, and
   `docker buildx` must be available.
2. **Phase 1, only if needed.** Run it when `OrgIQ-AgentCoreRuntime` is not
   live or any manifest repo is missing:
   `./infra/scripts/deploy.sh OrgIQ-AgentCoreRuntime`. On a live stack this is
   safe, because the sticky inference keeps the runtimes.
3. **Build** with step 2 of this spec (or read the newest digest file with
   `--skip-build`).
4. **Plan.** `planRollout(live, built, only)` is a pure function exported by
   the `.mjs` so it can be tested. It reads the live digest per agent from
   DE-2's `<Pascal>ImageDigest` outputs. Before DE-2 lands it reads
   `get-agent-runtime` `containerUri`. It returns the agents that are missing
   or whose digest changed. If none are, it prints "nothing to roll" and
   exits 0.
5. **Deploy** with `./infra/scripts/deploy.sh OrgIQ-AgentCoreRuntime
   --context deployRuntimes=true --context agentImageDigests=<changed only>`.
   DE-2 makes `deploy.sh` merge this with the live map, so unchanged agents do
   not roll. **The rollout never passes `onlyAgents`.**
6. **Wait.** Bounded: at most 10 minutes, polling every 15 s, never
   `until grep`. Each changed runtime and its endpoint must report `READY`. A
   `*_FAILED` status exits non-zero and names the agent.
7. **Verify.** For every agent, the live digest must equal the planned one.
   `--smoke` also invokes `search` once through `qualifier=DEFAULT`, which
   costs Bedrock money (see Decisions owed).

`--dry-run` runs steps 1-4 and prints the build commands, the plan and the
exact `deploy.sh` line. It changes nothing. Without AWS it falls back to the
build script's offline dry-run.

**4. Guard `onlyAgents`.** The stack throws when `onlyAgents` leaves out an
agent that has a live digest in the inferred map (DE-2). The message is
"would delete runtime <name>". `onlyAgents` stays valid for a first partial
deploy only.

## Decisions owed

- **`--smoke` costs Bedrock money.** Proposal: make it opt-in, with one
  `search` call. The default verification is control-plane `READY` plus the
  digest match.
- **Run the offline structural eval
  (`agents/tests/golden_runner.py`) before building?** Proposal: yes, as a
  free precheck. The pass/fail gate on real answers belongs to DE-5.
- **Where builds run.** Proposal: on the laptop for now, with the script
  written to run unchanged in DE-15's CI runner. Colima crashes are the
  argument for moving it.

## Done when

- `node --test scripts/docker/tests/agent-images-build.test.mjs` covers:
  - `planRollout` for an empty account: phase 1, then build, then all eight
    agents.
  - All digests equal: an empty plan with exit 0.
  - One digest changed: only that agent in the context map.
  - `--only` limits the build but never removes a live agent.
  - Agents are built `FROM` the base digest, never `:latest`.
  - `--dry-run` spawns no Docker or AWS process.
- `node --test` passes the manifest test: the agent directories, the stack
  lists and the build list agree.
- `cd infra && npm test` passes with a new case in
  `agentcore-runtime-stack.test.ts`: `onlyAgents=search` together with a live
  digest map that holds all eight agents throws "would delete".
- `bash -n agents/rollout.sh` passes, and `rollout.sh --dry-run` against the
  account prints the plan without calling `cdk deploy`.
- After a real rollout:
  - all eight `orgiq_*` runtimes report `READY` in `list-agent-runtimes`;
  - a second `rollout.sh` with no code change exits at step 4;
  - each runtime's `agentRuntimeVersion` is unchanged after that second run
    and after a following plain `./infra/scripts/deploy.sh`.
