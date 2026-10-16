# Upstream refinement — goal

Set 2026-10-14. Plan and evidence: `docs/upstream-refinement-plan-2026-10-14.md`.
Judge: `scripts/validate-upstream-refinement.sh` — the only judge. `--quick`
runs the static checks; the default also runs every repo's test suite and
typecheck (long; run alone).

## Why

The realtime chain under this app (distributed-core → service-runtime,
event-catalog, message-queue → realtime-modules → platform-api,
realtime-examples, live-video-streaming → aws-agentcore) drifted: six distributed-core versions,
hand-copied authority logic in the host, private casts into the library, a
gateway that is CPU-bound at 1 vCPU, and an infra stack that installs a whole
demo app to build three CDK constructs. Done means each repo owns what it
should, every consumer is on one current version, and the host keeps only
host rules.

## Already done (2026-10-14)

distributed-core 0.47.0 (D1 packaging) and 0.48.0 (D2 fenced lease, bounded
Redis, peer registry, readiness gate); realtime-modules 0.116.0 (R2 authority
kit), 0.116.1 (R1 tags, publish checks), 0.117.0 (R3 router on the lease);
platform-api guards on the recording routes; realtime-examples presence tests;
middleware on realtime-modules 0.117.0 and distributed-core 0.48.0 (C1 dead
router deleted).

## Phases

| phase | lanes | done when (the validator's checks) |
|---|---|---|
| U0 — one distributed-core | S1, M1, D3 | service-runtime ≥0.4.1, event-catalog ≥0.8.5, message-queue ≥0.2.3 each pin distributed-core at a full sha that contains v0.48.0; distributed-core 0.49.0 deprecates `./pipeline` and closes the techdebt items (D3); the middleware moves its service-runtime pin and installs exactly one distributed-core |
| U1 — realtime-modules owns its seams | R4, R5, R7 | the host's `realtime-gateway.ts` has no `as unknown as` / `as any` casts; nothing in the host reads `channelMembers` or `activeCalls`; the library exports `./testing` (`createRowsChatBackend`, a fake cluster Redis, test identities), `replayOnConnect` and the reader-cursor unread model; a `lint` script exists |
| U2 — capacity | R6 | `inboundRateLimit`, per-(connection, channel, epoch) verdict cache, batched recipient authorization and queue depth in `stats()` ship in realtime-modules; a dated local capacity record (`docs/realtime-validation/<date>/capacity-*.md`) reports member queries per send and burst chat p95 at 1 and 2 CPU against the 2026-10-05 baseline |
| U3 — apps on the chain | P1, X1 | platform-api pins realtime-modules ⊇ v0.117.0 and distributed-core ⊇ v0.48.0, its schedule evaluator is single-flight under a lease or semaphore, its definitions cache is event-invalidated, a local soak record shows a flat heap; realtime-examples ships its CDK constructs as `@connorhoehn/realtime-examples-cdk` (`cdk/`) with `aws-cdk-lib`/`constructs` as peers and aws-agentcore infra consumes that instead of the whole app, with an empty `cdk synth` diff |
| U4 — the consumer | C2, C3, C4 | both portal and middleware install `@connorhoehn/realtime-modules` (canonical name, no alias or `paths` shims) at the same tarball; the legacy authority guards and parity assertion are deleted after a clean release; `realtime-node-ownership.ts`, `gateway-redis.ts`, `redis-lite.ts` are gone; the static-secret machine callbacks verify service-runtime signed envelopes |
| U5 — the SFU on the chain | V1 | live-video-streaming (the mediasoup SFU behind hangouts) pins distributed-core at a full sha that contains v0.48.0 (it was on v0.42.1); its hand-rolled `src/cluster/RedisLeaseStore.js` (no fencing) is replaced by the library's fenced lease, so two nodes can never both own a room during a re-topology; a multi-node test kills the node that owns a room and proves ownership moves once, pipes are rebuilt idempotently and no orphaned pipe or producer survives; the change is logged with "(lane V1)" |

Each lane records its library change in that repo's CHANGELOG with the lane id
in the entry (e.g. "(lane R4)") and lands named contracts.

## Rules

Bottom-up release order; one consumer pin move per release; full 40-character
shas or tracked tarballs; verify against the installed `dist`; tags pushed to
both realtime-modules remotes; the middleware full jest suite runs alone; never
touch shared containers or the dev Redis's db 0 (use a spare logical db and
delete the keys); clones, never seed personas, for browser runs.

## Blocked or owed by the user

Cloud: multi-replica acceptance, the SFU's 1,000-room scale-out (placement, client-side failover lists, cross-node cascading; design and load test owed, not this round), the cloud capacity profile, the deployed
platform-api soak, `LOBBY_AUTHORITY_REQUIRED` in a deployed stack, the callback
guard rollout and any deploy. Decisions: BFF CPU sizing; whether the
realtime-examples demo app is retired (skip its realtime-modules bump if so);
whether `applications/pipeline` and `applications/document` leave
distributed-core this round (the shims ship either way; the move is optional).
