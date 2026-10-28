# DE-47 Fleet state that survives replicas, with a leader-elected reaper

Status: spec, 2026-10-27. Backlog: `docs/deployment-enhancements-2026-10-27.md`.
Depends on nothing; DE-48 and DE-50 build on the shared box record it introduces.
Keeps the one-task realtime gateway safeguard as it is.

## Current state (read from the code, 2026-10-27)

The backlog line is right about the shape and understates the exposure in two ways.

- **The registry is two Maps per process** (`boxes`, `bySession`,
  `middleware/src/lib/devbox-fleet.ts:139-140`), plus a 500-event ring buffer
  and live subscribers per box (`:116`, `:122-133`), the SDLC reservation map
  (`:595`, used by `lib/sdlc-pipeline.ts:118`) and the dispatcher's `busy` set
  (`lib/job-dispatcher.ts:59`). None of it is shared.
- **Two durable mirrors already exist, and both are read only at boot.** The
  Aurora mirror (`providers/devbox-fleet-store.ts:196`, table
  `schema/devbox_fleet_schema.sql`) writes structural changes immediately and
  coalesces `touch` every 15 s (`:41`); `initFleetPersistence` hydrates once
  (`:267`). The DynamoDB compute registry
  (`work-graph/compute-registry-runtime.ts:156-178`) hydrates every live
  registration another replica made into this replica's Maps and then
  heartbeats them. Neither re-reads after boot, and writes are last-writer-wins.
- **The reaper runs in every process.** `startReaper` is called at import of
  `routes/devbox.ts:69`; `sweepOnce` (`lib/devbox-reaper.ts:111`) reaps whatever
  the local `listBoxes()` returns.
- **More than one replica is already possible.** `middlewareAutoscale` defaults
  to on (1 to 4 tasks) whenever `realtimeGateway` is off
  (`infra/lib/middleware-service-stack.ts:1064-1069`, `:1368-1383`); only the
  realtime gateway pins one task. So this is not a future problem for any
  gateway-off deploy. The 2026-10-27 AWS deploy runs with the gateway on
  (`docs/aws-deploy-open-items-2026-10-27.md`), so it is pinned to one task
  and the failure below is latent there until the gateway is turned off.
- **The concrete failure:** replica B hydrates a box replica A created
  (compute registry), never sees A's events, so B's copy keeps its boot-time
  `lastActivityAt`. After 20 minutes B's reaper stops the session while A is
  running a task on it. Tails (`routes/devbox.ts:532-536`) on B show nothing
  of a run on A. The dispatcher on B can push a job onto a box A is using,
  because `busy` and reservations are local.
- **Sessions the registry forgets cannot be recovered from AWS.** Correct: the
  schema header (`schema/devbox_fleet_schema.sql:18-21`) records that no
  AgentCore API lists runtime sessions. The registry has to remember.
- **The lease primitives are already in this tree, not just upstream.**
  `lib/replica-fleet.ts:139` `withLock` wraps `FencedLease` from
  `@connorhoehn/realtime-modules/server`, which re-exports distributed-core's
  `FencedLease`, `LeaseGroup`, `ReadinessGate`
  (`~/Projects/realtime-modules/src/server/index.ts:117`;
  `~/Projects/distributed-core/src/cluster/leases/FencedLease.ts`,
  `LeaseGroup.ts`). `lib/access-expiry.ts:105-110` is the worked pattern
  (no peers: sweep; peers: sweep under the lock). But without `REDIS_URL` the
  fleet is `soloFleet` (`replica-fleet.ts:78-86`) and `withLock` always runs,
  and the deployed middleware only gets `REDIS_URL` with the realtime/social
  flags (`middleware-service-stack.ts:792-798`, `:994-999`). So in the
  autoscaled shape there is no lock to elect a leader with.

## Change

1. **Aurora `devbox_boxes` becomes the shared truth for fields that gate
   decisions** (status, `last_activity_at`, `created_at`, a new
   `busy_holder TEXT` + `busy_until TIMESTAMPTZ` claim, `stopped_at`). The Maps
   stay as a per-process read cache refreshed every sweep, so request handlers
   stay synchronous. Status transitions that decide ownership
   (`task_started`, dispatcher claim, SDLC reserve) become conditional writes:
   `UPDATE devbox_boxes SET busy_holder=:h, busy_until=:u WHERE id=:id AND
   (busy_holder IS NULL OR busy_until < NOW())`, returning rows. The local
   `busy` set and `reservations` Map are replaced by that claim.
2. **The activity clock is written by the replica running the task**, still
   coalesced, and the reaper reads Aurora, not the local Map, before deciding.
   A box whose stored `last_activity_at` is newer than the local copy is not
   reaped.
3. **Leader-elected reaper.** `startReaper` moves from module import to
   `index.ts` beside `startAccessExpirySweeper`, and each tick runs inside
   `replicaFleet().withLock('devbox-reaper', max(30 s, interval))` following
   `access-expiry.ts:105-110`. `sweepOnce` calls `lease.assertLive()` before
   each `StopRuntimeSession`, and `markStopped` writes
   `... WHERE id=:id AND status <> 'stopped'` so a fenced leader's late write is
   harmless. The lock is the one `withLock` already provides; no new upstream
   work.
4. **Tails across replicas.** Events stay in the per-process ring buffer, and a
   tail on a replica that does not own the run polls a short Aurora/Redis
   stream. Simplest honest form: publish each event on a Redis channel
   `orgiq:devbox:<boxId>` when Redis exists; otherwise the tail response says
   `owner: <replicaId>` and the portal reconnects (ALB has no stickiness today).
5. **The compute registry stops hydrating other replicas' boxes into the
   reaper's view.** It remains the cross-replica directory; reaping reads Aurora.

## Decisions owed

- **Where the lock lives when there is no Redis.** Proposal: provision Redis
  for any deploy with `middlewareAutoscale` on (reuse the Social ElastiCache
  parameter when present), and otherwise pin `middlewareAutoscale=false` with a
  synth error mirroring the realtime safeguard, rather than writing a second
  lease on Aurora advisory locks. Alternative: a DynamoDB conditional-write
  lease on `orgiq-sessions`, which the role can already write.
- **Cross-replica tails:** Redis pub/sub (needs Redis everywhere) vs reconnect
  to owner. Proposal: pub/sub, given the first decision.

## Done when

- `cd middleware && npx jest src/lib/__tests__/devbox-fleet.test.ts src/lib/__tests__/replica-fleet.test.ts`
  passes with new cases: two fleet instances over one fake store, replica B
  does not reap a box whose stored activity is fresh; only the lock holder's
  `sweepOnce` issues `StopRuntimeSessionCommand`; a fenced lease stops the
  sweep before the next stop call.
- A dispatcher test with two dispatchers sharing one store claims a box once.
- `grep -n "startReaper" middleware/src/routes/devbox.ts` finds nothing; it is
  started from `index.ts`.
- `npx jest test/middleware-service-stack.test.ts` (infra) asserts the chosen
  rule: autoscale without a Redis source fails synth, and
  `realtimeGateway=true` still forces one task.
- `scripts/validate-mock-floor.sh` stays green (the mock fleet still hydrates).
