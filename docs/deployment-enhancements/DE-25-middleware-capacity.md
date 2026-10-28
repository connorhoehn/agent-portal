# DE-25 Middleware capacity: a larger task, peer routing, or a smaller profile

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Open user decision (CLAUDE.md, "Capacity for 100 calls / 1,000 sockets is
unaccepted"). This spec lays out the evidence and recommends; it does not take
the decision, and it keeps the one-task gateway safeguard in place. Peer routing
depends on DE-47.

## Current state (read from the code, 2026-10-27)

The backlog line is right about the shape and wrong in one important way: the
evidence says **a larger task alone does not fix it**, because the bottleneck is
one JavaScript thread, not the vCPU count.

- **The pin.** With `realtimeGateway=true` the middleware task *is* the gateway:
  1 vCPU / 2 GB by default (`infra/lib/middleware-service-stack.ts:1062-1063`),
  no autoscaling (`:1064-1069` throws on `middlewareAutoscale=true`),
  stop-before-start deploys (`:1158`, min 0 / max 100), AZ rebalancing off
  (`:1179`), a 15 s deregistration delay (`:1352`). `middlewareCpu` /
  `middlewareMemoryMiB` already resize it. `infra/test/realtime-capacity.test.ts:44-71`
  pins all of this. The 2026-10-27 AWS deploy runs this shape.
- **What the safeguard protects.** Not just sockets. The comment at `:1037-1052`
  says a Redis endpoint "does not prove that all application/service state is
  safe across tasks". Concretely: the devbox fleet Maps, reaper, dispatcher
  `busy` set and SDLC reservations are per process (DE-47, Current state);
  `recoverOrphanedWork` (`middleware/src/lib/job-dispatcher.ts:163`) requeues
  only when it sees no peers; the ALB has no stickiness. With the gateway off,
  the same stack autoscales 1 to 4 tasks today (`:1368-1383`) and carries all
  of the DE-47 exposure.
- **Peer routing exists in code and is off in the cloud.** `startRealtimeGateway`
  (`middleware/src/lib/realtime-gateway.ts:205-241`) builds a
  `RedisRealtimeRouter` when `REALTIME_GATEWAY_ROUTER=redis`
  (`lib/gateway/env.ts:5-15`). CDK never sets that variable, so the deployed
  router is `local`.
- **A cheaper lever is also off in production.** `REALTIME_AUTHORITY_CACHE`
  defaults to on outside production and off in production
  (`lib/gateway/env.ts:50-66`); CDK sets `NODE_ENV=production`
  (`middleware-service-stack.ts:845`) and not the flag. The library measurement
  (`docs/realtime-validation/2026-10-14/capacity-r6.md`, Results) shows the
  cache cutting member queries per send from 1.40 to 0.40 and burst chat p95
  from about 1.2 s to 0.36 s. It has not been measured inside the BFF.

### Evidence (all local, containerised, no cloud run exists)

| Shape | Result | Source |
|---|---|---|
| Two BFF nodes, 1 CPU each, Redis peer routing | burst fails invite/chat/health; both BFFs at their 1-CPU cap; steady and churn pass | `realtime-validation/2026-10-05/capacity-progress.md:249-256` |
| Same image, 2 CPU and 4 CPU per node | nothing passes every target; CPU peaks near 100-130 % of one core, so extra cores sit idle | `capacity-progress.md:401-412`, `2026-10-06/capacity-sizing/manifest.json` |
| DynamoDB socket cap raised to 256/512 | latency worse, not better: the thread cannot absorb the work | `capacity-progress.md:414-424` |
| 0.110 request cuts, 1 CPU | no 1-CPU run passes; at 2 CPU both soaks pass health, chat p95 still about 690 ms | `capacity-progress.md:447-456` |

So "CPU-bound" in CLAUDE.md means "single-thread-bound". A 2 vCPU task buys
headroom for GC, libuv and the SDK threads (the soak passes health at 2 CPU)
but does not reach the chat target. Peer routing spreads sockets across
threads, but was measured only at 1 CPU per node and still failed burst.
(CLAUDE.md's "nothing deployed since early October" line was corrected on
2026-10-27: the 2026-10-26/27 deploy ran in account 647757222309.)

## Change

Three steps, in order, each measured before the next. None of them lifts the
safeguard.

1. **Measure the authority cache in the BFF.** Run the existing container
   harness (`middleware/test-support/bff-cluster-capacity.mjs`, needs Docker)
   with `REALTIME_AUTHORITY_CACHE=on` at 1 and 2 CPU, single node. Record it as
   `docs/realtime-validation/<date>/capacity-authority-cache/manifest.json` in
   the existing format. If it passes, add `REALTIME_AUTHORITY_CACHE` as a
   context-driven env (`realtimeAuthorityCache=true`) in
   `middleware-service-stack.ts` beside `REALTIME_GATEWAY`.
2. **Offer 2 vCPU / 4 GB as a named profile, not a new default.** Add
   `--context middlewareProfile=pilot|capacity` mapping to 1024/2048 and
   2048/4096, so the size is a recorded choice. The test at
   `realtime-capacity.test.ts:67` already proves the override path.
3. **Peer routing only after DE-47.** Lifting the pin needs, at minimum:
   DE-47's shared box claims and leader-elected reaper; Redis present for every
   multi-task deploy; `REALTIME_GATEWAY_ROUTER=redis` set by CDK; a rolling
   deploy (100/200) replacing stop-before-start; and a two-node cloud capacity
   run that passes. That is a separate change behind its own flag, and the synth
   error at `:1066-1069` stays until the user accepts it.

## Decisions owed

- **Which capacity target to accept.** Options: (a) raise `middlewareCpu` to
  2048 and accept the measured soak (health passes, chat p95 about 690 ms);
  (b) accept a smaller profile than 100 calls / 1,000 sockets for the pilot,
  where the 0.105 collision profile already passed at 1 CPU
  (`capacity-progress.md:82-86`); (c) fund peer routing (DE-47 plus a cloud
  run). Proposal: step 1 first, then (a) with (b)'s smaller profile as the
  stated pilot limit; defer (c) until a real load needs more than one task.
- **Enabling the authority cache in production.** It trades up to
  `REALTIME_AUTHORITY_CACHE_MAX_AGE_MS` (default 5 s) of revocation lag for a
  missed membership event (V5, `lib/gateway/env.ts:68`; `capacity-r6.md:47-50`). Proposal: accept it, given
  the invalidation wiring in `lib/gateway/authority-invalidation.ts`.

## Done when

- A capacity manifest for the BFF with the authority cache on, at 1 and 2 CPU,
  is committed under `docs/realtime-validation/`.
- `cd infra && npm test` passes, including new cases: `middlewareProfile=capacity`
  gives 2048/4096; `realtimeAuthorityCache=true` sets the env; and
  `realtimeGateway=true` still refuses `middlewareAutoscale=true`
  (`realtime-capacity.test.ts:70` unchanged).
- `grep -n "REALTIME_GATEWAY_ROUTER" infra/lib/middleware-service-stack.ts`
  finds nothing until the peer-routing decision is recorded.
- CLAUDE.md's capacity line names the accepted profile, or still says
  unaccepted.
