# Two-process gateway and shared service acceptance — 2026-10-05

The opt-in Redis gateway now passes **eight full BFF process contracts**,
including abrupt node loss and authenticated seat recovery. Normal startup
awaits the host-owned Redis connections and leased router before listening.
The default remains LocalRealtimeRouter and the cloud service retains its
single-gateway safeguard. This record advances the foundation acceptance; it
does not accept a multi-replica cloud deployment.

Both application manifests and lockfiles pin realtime-modules **0.103.0** at
`90a6d16ec14bdf4ea5517cd9a373794673240136`, published on
[`feat/redis-realtime-router`](https://github.com/connorhoehn/realtime-modules/tree/90a6d16ec14bdf4ea5517cd9a373794673240136).
The candidate and sibling main checkouts are clean. Root application changes
remain uncommitted with the unrelated work preserved.

## Accepted behavior

The [seven full-process contracts](cluster-service-bff.log) use independent
Node BFFs on ports 3063 and 3064 with real picker login, signed cookies, minted
JWTs, native TCP WebSockets, Redis and DynamoDB Local. The native RDS preload
replaces only the SDK transport: the providers execute their actual SQL against
one dedicated PostgreSQL database, including directory epochs and tenant roles.
No test route, identity-provider result, call state or socket receipt is substituted.

- Protected huddle messages and canonical Work pages cross processes. The
  private sender proof remains server-side; the caller retains stop rights
  when making a request through the peer BFF.
- A committed directory epoch retirement blocks protected REST access and
  socket admission on the other BFF, suppresses new protected delivery and
  preserves stored history. Retiring the actual masquerade operator also
  rejects the token at admission on both BFFs.
- Forged callers and foreign call lobbies are refused before peer fanout.
- A private channel created on one BFF becomes visible remotely after a
  committed membership addition. A leave submitted through the other BFF
  revokes both directory visibility and subsequent message delivery.
- Shared presence reads name the actual authenticated user and omit a source
  whose directory epoch has been retired.
- A missed-call notification reaches the peer socket and replays from the
  shared durable inbox when that user reconnects through the other BFF.

The separate [abrupt-loss contract](cluster-service-crash.log) validates the
owned process's current PID, argv, working directory and listener before
terminating node B. It lets the **default 30-second owner lease** expire
naturally, then starts a new owner. The same authenticated user recovers their
seat under a new client ID, preserves the shared page/revision and persisted
history, and receives a newly sent message. Node A stays running throughout.
The test does not inspect or edit private routing keys.

The directory fixture loads the canonical OrgIQ, identity, Work, document-link
and Social schemas, the estimate migration and the Work/sprint portion of the
program schema. Other domains are mocked; unrelated job/observability/bot SQL
objects are absent and their background workers log missing-table warnings.
This establishes shared native SQL authority for these contracts, not a fully
provisioned application database or Aurora Data API/IAM compatibility.

## Changes and regression gates

The upstream call fix waits for durable seat registration and the accepted
marker before signaling. A replica's last local group participant no longer
ends a call with surviving peers. An accepted DM closes when either party
explicitly leaves, with a shared once guard for the end callback. Mid-call
invitations preserve the original caller, invite metadata and accepted lifetime.

The public library now exports RedisPresenceStore, namespace-scoped peer
invalidation events and leased-router readiness. Presence snapshots recheck
connection identity/liveness and publisher channel access. Invalidation events
are hints without replay or receipts; application membership reads still load
strongly consistent durable rows. Pending reads are fenced by committed local
writes or peer invalidations, and delayed reads cannot revive a newer removal.

The BFF uses bounded host-owned Redis connections with separate command,
publisher and subscriber clients. It checks current directory authority before
socket registration and revalidates protected call-page/chat frames at their
destination. Graceful disposal drains sockets and library services while the
application runtimes and store ports remain available to disconnect hooks.

- [Upstream full gate](cluster-service-upstream-tests.log): **2,021 passed,
  9 skipped**, 173 passing suites; **25 native Redis/WebSocket contracts**.
- [Current application gate](cluster-service-app-tests.log): **258 passed,
  2 skipped**, 24 suites, including the native shared Redis/DynamoDB contracts.
- [Fresh BFF browser gate](cluster-service-browser.log): **9 passed**, with
  no retries or unexpected results. PID 90916 started immediately before this
  run, after the reader, destination, admission and library-pin edits. Browser
  contexts are isolated; only media-session receipts are substituted in this
  signaling/navigation gate. It does not extend the earlier native SFU evidence.
- [Portal gate](cluster-service-portal-tests.log): **1,318 passed**. Both
  consumers pass typecheck/build, as do the upstream build/export and actual
  packed-consumer type/runtime checks.

The ARM64 production build is local-only at
`sha256:14ac9ead48a94a2111fadf296943554880a125348dfe182c23537c692d76f7c1`.
Its [network-disabled artifact check](cluster-service-artifact.log) confirms
the exact Git pin, public presence/readiness exports and compiled application
admission, peer membership and protected-frame boundaries. No running
container was replaced and no image was pushed to ECR.

## Outstanding acceptance

Keep the one-task cloud guard. Remaining work includes host health/retirement
behavior after lease failure, peer publication outage and recovery, shared
ownership for the separate `/realtime` document/distillation path and any
other enabled local service state, REST notification producers, authority-aware
capacity testing, broader role journeys and provisioned tenant cloud acceptance.
Internet/TURN, physical devices and media capacity remain separate checks.

Default AWS identity still returns
[`InvalidClientTokenId`](cluster-service-aws-identity.log). No cloud mutations,
Aurora migrations, tenant deployment or safeguard removal were attempted.

The [manifest](cluster-service-manifest.json) records source/evidence digests,
exact pins, runtime identities, image digest and acceptance limits. The
engineering completion estimate is **85%**, not a measured acceptance ratio.

To rerun the full process contracts after starting the owned loopback fixtures:

```sh
cd middleware
ORGIQ_BFF_CLUSTER_ACCEPTANCE=1 node --test test-support/bff-cluster-acceptance.mjs
```

Abrupt-loss acceptance is an additional explicit opt-in. Set
`ORGIQ_BFF_CLUSTER_CRASH_ACCEPTANCE=1` and `ORGIQ_BFF_RUNTIME_ENV_FILE` to the
private runtime profile when running the same file. The owned launcher in
`test-support/bff-cluster-processes.py` accepts node `a` or `b`, refuses occupied
ports and checks ownership before stopping a live process. Do not commit or
copy the private profile into evidence.
