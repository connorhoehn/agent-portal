# Leased gateway retirement acceptance — 2026-10-05

The current Redis gateway retires permanently when an established command,
publisher or subscriber connection becomes unavailable. `/health` and
`/api/health` report HTTP 503 for a fenced router, and new WebSocket upgrades
are refused. Redis reconnect and late replies cannot revive that incarnation.
Retiring it preserves accepted shared call seats, caller page ownership and
chat history; authenticated replacement connections resume the original call.
Dead remote connections are pruned only after their owner is proved absent.

Both consumers pin realtime-modules **0.104.0** at full commit
`68581f7023b9948b7f16cc094d723dc332683039`, pushed on
`feat/redis-realtime-router`. The owner main checkout remains untouched.
Normal npm installs preserve the applications' existing package alias. The
root application tree remains an uncommitted working snapshot; the
[manifest](cluster-retirement-manifest.json) records source and evidence hashes.
Earlier [service](cluster-service-acceptance.md) and
[foundation](cluster-foundation-acceptance.md) records retain their historical pins.

## Accepted local evidence

| Gate | Result |
| --- | --- |
| Library full gate | 2,023 passed, 9 skipped; 173 passing suites |
| Library native cluster contracts | 27 passed, including connection loss and shared-call retirement |
| Library build, exports and packed consumer | Passed; actual installed TypeScript compiler used |
| Focused application gate | 258 passed, 2 skipped in 24 suites, with native stores |
| Full BFF process contracts | 8 passed, including abrupt loss, natural 30-second lease expiry and replacement |
| Actual Redis failure contracts | 3 passed: subscriber socket loss, protected call recovery, stalled command renewal |
| Portal unit gate | 1,318 passed |
| Fresh local BFF browser gate | 9 passed; call media receipts are stubbed in these browser cases |
| Middleware and portal typecheck/build | Passed |
| Load driver contracts | 14 passed; capacity acceptance remains open |

The dedicated Redis container was inspected by exact ID, validation label and
loopback port before fault injection. `CLIENT KILL TYPE pubsub` disconnected
actual subscriber sockets: both BFFs became unhealthy and stayed fenced after
Redis recovery. Replacement nodes recovered both participants, the original
shared Work page/revision and pre-failure history, enforced caller-only stop,
and delivered a new message across owners.

Pausing that Redis also proved a reply-deadline gap: node-redis's command
timeout is removed once a command reaches the socket. The host now bounds
command and publish replies and destroys its owned stalled connection. The
passing stall contract checks bounded lease failure, sub-second fenced health
responses, permanent fencing after unpause, natural expiry of unreleased
stable owner leases, and admission of fresh owners. It reads those fixture
lease keys to wait for expiry; it never deletes or steals them. The container
was unpaused and healthy at completion. These checks do not simulate an ALB
or execute an ECS replacement.

The focused application gate preceded the final host reply-deadline edit;
that edit is covered by the three full-process failure contracts, current
typecheck/build and the production artifact check. The fresh browser BFF used
the local router, so these nine cases do not establish multi-node browser or
SFU recovery acceptance.

## Production artifact and boundaries

Local ARM64 production image:
`sha256:0501270a4371409c1e570b60611c163f667a5b961327b653eb219bc5f0802bb3`.
Network-disabled inspection verifies the exact library pin/version, exported
router and presence store, compiled bounded replies, permanent fencing, 503
health handling and shared-call retirement checks. No ECR push or deployment
was attempted.

The BFFs run independently on 3063/3064 with real cookie/JWT admission and
WebSockets. Their test-only RDS SDK transport executes actual provider SQL in
the dedicated PostgreSQL fixture; Redis and DynamoDB Local hold shared state.
It is not Aurora Data API, IAM or Cognito acceptance. Unrelated background
domains are mocked or lack their optional fixture schemas. Runtime IDs,
container identities and evidence digests are in the manifest. The private
runtime profile, credentials and session cookies are excluded from evidence.

Default routing remains local. The deployed single-gateway guard, rollout
limits and disabled realtime autoscaling remain in place. Current default AWS
identity fails with `InvalidClientTokenId`.

The first directory-backed two-node pilot used 60 sockets and 10 simultaneous
calls of each shape. All sockets and calls succeeded without cross-delivery,
unexpected ends or authorization errors; the two-person run missed chat p95
at 301.9 ms against the unchanged 300 ms limit. Capacity is not accepted by
this record. Provisioned 100-call/1,000-socket load, publisher-specific outage,
separate `/realtime` ownership, REST notification producers, cloud role and
tenant journeys, WAN/TURN and physical-device media remain outstanding.

The full integration remains approximately **85%** complete as an engineering
estimate, not a measured acceptance ratio.
