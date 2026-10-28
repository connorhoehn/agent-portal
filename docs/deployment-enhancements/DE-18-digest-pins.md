# DE-18 Digest pins everywhere

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Overlaps DE-2 (agent runtimes); DE-19 reuses its digest context for the
document images.

## Current state (read from the code, 2026-10-27)

The backlog line is right about the middleware and understates how much is
already pinned. Every image consumer, and how it picks its image:

| Consumer | Pin | Where |
|----------|-----|-------|
| Middleware service (Fargate) | **tag `latest`**, always | `infra/lib/middleware-service-stack.ts:1104` |
| platform-api (Fargate) | `platformApiImageDigest` context; required once `deploySocialService=true`, else `latest` at desired 0 | `infra/lib/social-stack.ts:420-426`, `:547` |
| SFU (EC2 user data) | `sfuImageDigest` context; optional, falls back to `:latest` with a synth warning | `infra/lib/social-media-stack.ts:177-187` |
| Document services (5 Fargate) | digest required, synth throws without one | `infra/lib/document-workspace.ts:51-53` |
| Agent runtimes, devbox | `:latest` resolved to a digest **at synth** by `aws ecr describe-images`; any error silently falls back to `:latest` | `infra/lib/agentcore-runtime-stack.ts:14-36`, `:412`; `infra/lib/devbox-stack.ts:219` |

Consequences for the middleware:

- A push changes nothing that runs, so the build script prints an
  `aws ecs update-service --force-new-deployment` as the rollout
  (`scripts/docker/middleware-image-build.mjs:77-78`). The stack's own
  first-deploy comment says the same (`middleware-service-stack.ts:127-130`).
- A scale-out, a task replacement after a health-check failure or an
  unrelated `cdk deploy` that touches the task definition can start
  whatever `:latest` is at that moment, which may not be what was verified.
- The build script already knows the digest: it tags `:<commit12>` and
  `:latest` and writes `digest` to `.scratch/middleware-image/report.json`
  (`middleware-image-build.mjs:69`, `:152-157`). Nothing reads it.
- The stack outputs no digest, so `deploy.sh`'s sticky inference (which
  already carries `sfuImageDigest` and `platformApiImageDigest` forward,
  `infra/scripts/deploy.sh:418-433`) has nothing to read for the middleware.

Other facts that bear on the design:

- No repository sets `imageTagMutability`, so every tag is mutable
  (`middleware-service-stack.ts:243-250`, `social-images-stack.ts:50-57`).
- Lifecycle rules count images, not use: `maxImageCount: 10` for the
  middleware and 5 for the Social repos. Eleven pushes without a deploy expire
  the digest the service is pinned to, and the next task start fails to pull.
- The comment at `middleware-service-stack.ts:245-247` says the deploy's
  orphan sweep "adopts" an existing repository. It does not: the sweep
  force-deletes any listed repo no stack owns, images included
  (`deploy.sh:279-301`). Fix the comment while touching the file.

## Change

**One convention for every container consumer:** a `<service>ImageDigest`
context, validated as `sha256:<64 hex>`, required whenever the service runs,
written as a stack output, and carried forward by `deploy.sh`.

1. **Middleware.** Read `middlewareImageDigest`; `deployMiddlewareService=true`
   without it throws at synth, the same rule as `social-stack.ts:425`. The
   image becomes `fromEcrRepository(repo, digest)`. Add a
   `MiddlewareImageDigest` output (`(none)` in phase one).
2. **deploy.sh.** Infer `middlewareImageDigest` from that output beside the
   SFU and platform-api lines, so a deploy that does not name a new image
   keeps the running one. A new image is named explicitly:
   `--context middlewareImageDigest=sha256:…`.
3. **Build script.** Replace the printed `--force-new-deployment` with the
   deploy command carrying the new digest. Keep pushing `:<commit12>` for
   humans; stop relying on `:latest` (decision below).
4. **SFU.** Make `sfuImageDigest` required once the stack is deployed with
   its instance; keep the warning-only path for a synth with no flag.
5. **Agent runtimes and devbox.** `resolveContainerUri` stops swallowing
   errors. Today stderr is discarded (`stdio: [..., 'ignore']`), so an expired
   token and an empty repo look the same; capture stderr and fall back to
   `:latest` only on `ImageNotFoundException`, throwing on anything else. Explicit per-agent digests and traffic
   shifting stay with DE-2.
6. **Retention.** Lifecycle rules keep tagged `:<commit12>` images by count
   and expire untagged images by age, and `deploy.sh` refuses (before
   `cdk deploy`) a digest that `ecr describe-images` cannot find, naming the
   repo.
7. **One reader for the reports.** A small `scripts/docker/image-pins.mjs`
   prints the `--context` flags from the three `report.json` files (middleware,
   Social, documents) so an operator copies one line, not three.

## Decisions owed

- **Stop pushing `:latest`, and make tags immutable?** Proposal: yes for the
  middleware and Social repos once step 1 lands (`IMMUTABLE` tags plus the
  commit tag); agent repos keep `:latest` until DE-2 replaces synth-time
  resolution.
- **Should `deploy.sh` pick up a fresh `report.json` automatically?**
  Proposal: no. Sticky inference only re-supplies what is already running;
  a new image is always named on the command line, so a deploy never ships an
  image nobody chose.

## Done when

- `cd infra && node --require ts-node/register --test test/middleware-service-stack.test.ts test/social-stacks.test.ts`
  passes with new cases: synth with `deployMiddlewareService=true` and no digest throws;
  with a digest the task definition's image ends in `@sha256:…` and no
  template references `:latest` for the middleware.
- `cd infra && npx cdk synth OrgIQ-MiddlewareService -c deployMiddlewareService=true -c middlewareImageDigest=sha256:$(printf 'a%.0s' {1..64}) | grep -c ':latest'`
  prints 0.
- `grep -n "force-new-deployment" scripts/docker/middleware-image-build.mjs`
  finds nothing; `node scripts/docker/middleware-image-build.mjs --dry-run`
  prints a deploy line with `middlewareImageDigest`.
- A `test/deploy-config.test.ts` source check (that file greps the shell
  scripts) pins the `middlewareImageDigest` inference line beside the SFU and
  platform-api ones in `deploy.sh`; the explicit `--context` already wins
  through `infer`/`ctx_given` (`deploy.sh:363-381`).
- `test/agentcore-runtime-stack.test.ts`: the first-deploy fallback case
  (`:129`) passes with its mock's error moved into stderr, and a new case shows an
  `ExpiredTokenException` throws instead of returning `:latest`.
- Cloud (once credentials work): two consecutive `deploy.sh` runs with no new
  digest leave `describe-services … taskDefinition` unchanged, and pushing a
  new image without naming it changes nothing that runs.
