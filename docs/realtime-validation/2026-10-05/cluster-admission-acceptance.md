# Cluster admission and current cookie authority — 2026-10-05

This accepts the focused admission/authority change and one constrained collision
profile. It does **not** accept overall capacity, cloud deployment or media at
100 calls. Keep the single-gateway deployment safeguard. The default AWS
identity still returns `InvalidClientTokenId`; no ECR push, Aurora migration or
cloud mutation occurred.

Both consumers pin realtime-modules **0.105.0**, commit
`be54e682d50d750ede04bdae5f47302039826626`, pushed on
`feat/redis-realtime-router`. The owner main checkouts remain clean at their
previous realtime/UI commits. The prior retirement record retains its 0.104.0
pin and exact source snapshot.

## Resulting behavior

The earlier constrained two-node test admitted both tabs in five of ten
same-person answer races. A native Redis/WebSocket regression forced both
replicas to inspect the same pre-accept roster and reproduced that failure.
`CallStateStore.claimAcceptedSeat` now admits one authenticated person's seat
atomically, preserves the original caller and lobby, and never creates a
missing call. A losing tab receives `answered-elsewhere` and cannot use
participant-state recovery while the winner remains live. Replacement requires
a proof naming the exact departed winner. Memory and Redis adapters implement
the contract; legacy custom stores retain local behavior until implementing it.

The application lifecycle observes a successful atomic claim before signaling
acceptance. This retains automatic huddle joining and page replay without
transferring caller ownership. A real lifecycle regression caught the initial
integration omission and passes with the corrected observer.

The cookie-authenticated `/realtime` path checks current directory epoch,
source role and masquerade operator at upgrade, subscription and delivery.
With `REALTIME_GATEWAY_ROUTER=redis`, it owns a separate leased namespace and
fans server updates across nodes. A real REST compaction request reaches
remote cookie and JWT recipients, then stops delivering to a recipient whose
directory epoch was changed through native SQL. Router fencing also removes
the BFF from health admission. The default local mode remains available.

Directory reads combine only requests queued before SQL dispatch. A later
action cannot reuse an already-started pre-revocation lookup, even while its
older request is pending. No completed positive authority is cached.

Health polls respond promptly with dependency diagnostics, freshness and
refresh state. Cold or stale dependency results are degraded; one pending
refresh serves concurrent polls. A fenced router returns immediate 503.
The portal shows an availability check while diagnostics are pending instead
of falsely declaring an expired credential.

## Verification

- Library: 2,030 tests passed, 9 skipped; native admission/recovery subset:
  44 passed. Build and all 31 public exports passed. The actual packed 0.105.0
  artifact passed TypeScript consumption and a 32-contender runtime claim.
- Application: 287 passed, 1 skipped, across 28 suites, including actual
  Redis/DynamoDB Local contracts. The skip is the separately opted-in store
  restart contract. The optional native Social round trip also passes.
- Full BFFs: 10 passed, including ten genuine cross-process tab races,
  cookie/JWT REST producer fanout, revoked epochs/operators, protected page
  and history, private-channel removal, shared presence and missed calls.
  Abrupt process replacement waits for the default 30-second leases to expire
  naturally, then restores the original accepted seat/page/history.
- Faults: three actual Redis contracts and one actual DynamoDB pause/recovery
  contract pass. Fixtures are unpaused afterward. Health fencing is prompt;
  stalled history is bounded and retryable, retaining accepted seats/history.
- Portal: 1,318 unit tests passed, typecheck/build passed, and all nine fresh
  local browser huddle/page cases passed in 46.9 seconds. These browsers use
  local routing and stub media receipts; they are not multi-node/SFU proof.
- Driver: 15 contracts passed. Both application typechecks/builds passed.

The initial application native gate used the wrong fixture table prefix and
the optional Social fixture lacked its five canonical tables. That failing
evidence is retained. The correct owned fixture was restored, missing tables
were created only there, and the complete final gate passed. No application
authority fallback was added.

## Constrained 100-call collision profile

Compiled Node 22 image:
`sha256:86d3dd3c30818d7850274eae771e3d13df42df8c54287d9bb52e271030dfea8d`.
Both BFFs have one CPU and 1,024 MiB; the internal driver has one CPU and
512 MiB. WebSockets stay inside the inspected Docker network. Provider SQL,
Redis, durable chat and cookie/JWT authentication are actual local transports.
The SDK adapter substitutes native PostgreSQL for the Data API only in the
explicit non-production fixture; this is not Aurora/IAM/Cognito proof.

| Measure | Result |
| --- | --- |
| Connections / established calls | 1,000 / 100, all |
| Competing-tab races / duplicate caller answers | 10 of 10 with one winner / 0 |
| Invite p95 / p99 | 61.8 / 68.2 ms |
| Accept p95 / chat p95 | 55.5 / 79.3 ms |
| Paired background senders delivered | 790 of 790 |
| Health p99, primary / peer | 35.1 / 43.8 ms |
| Memory peak, primary / peer | 198.1 / 209.0 MiB |
| Cross-call deliveries, unexpected ends/disconnects, denied actions | 0 each |

Every unchanged threshold passed for this 69.7-second profile. The previous
failed matrix is preserved in `capacity-health/manifest.json`, including its
exact compiled source. Its soak and synchronized burst still failed latency
targets. A fresh complete matrix on 0.105.0 is running; one accepted collision
profile does not prove the remaining shapes.

Remaining requirements include sustained burst/reconnection performance,
the complete current capacity matrix, broader REST producer/role/tenant
acceptance, Aurora migrations and cloud permissions/deployment, 100-call real
media, WAN/TURN, physical devices and recording/restart coverage. See
[current work](capacity-progress.md) and the adjacent source/artifact manifest.
