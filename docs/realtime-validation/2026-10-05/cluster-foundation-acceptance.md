# Redis routing foundation acceptance — 2026-10-05

The upstream Redis peer transport and the app's remote call-feature readers
pass bounded local acceptance. Overall frontend/backend integration is
approximately **82% complete**, an engineering estimate. The normal BFF
still uses LocalRealtimeRouter; full multi-process application and cloud
acceptance remain open.

## Exact upstream release

Both app consumers and their lockfiles install realtime-modules
**0.102.1 / [`7af2e408ecc24e207344e2d5b07d1f5ebf354287`](https://github.com/connorhoehn/realtime-modules/commit/7af2e408ecc24e207344e2d5b07d1f5ebf354287)**
on `feat/redis-realtime-router`. The isolated candidate contains regenerated
package artifacts and is clean. The owning sibling main remains clean at
`94bf705e9a4be312d1b54aac83b374b227a2ca4e`. No main merge, tag or registry
release occurred. Installs used normal npm operations; installed package files
were not patched.

`RedisRealtimeRouter` composes the existing local recipient authorization and
subscription-generation fences. Authenticated connections register before
service hooks/readiness, with a unique boot owner, connection generation and
renewed Redis leases. A second live owner is refused. Renewal failure or
expiry permanently fences the instance, including a late successful response.
User lookups prune expired index entries atomically while retaining live
registrations. Hosts own connected Redis ports, credentials/TLS, command
deadlines and reconnect policy. This implementation uses a single Redis
primary; multi-slot Redis Cluster scripts are not supported.

Direct writes resolve true only after the destination confirms an actual
authorized socket write. A lost receipt can return false after one write;
there is no automatic resend. Duplicate peer request IDs share one delivery
result inside the bounded dedup window. Channel/broadcast completion confirms
publication, not all remote deliveries. Global ordering and end-to-end
exactly-once delivery are not established.

The [full upstream gate](cluster-upstream-tests.log) passes **2,015 tests,
9 skipped** in 173 suites. The [native transport case record](cluster-upstream-native-cases.json)
contains **19 passing contracts** using real Redis and independent TCP WS
servers: direct/channel fanout, publisher/recipient revocation, unsubscribe
generation, duplicate peer frames, lost receipts, namespaces/unknown owners,
node replacement, lease renewal/late response, expired-index pruning, startup
queue admission/overflow, async disposal, native call invite/accept/departure,
reconnect on another node, cross-tenant call filtering and server-originated
notification receipts. [Build/export verification](cluster-upstream-build.log)
and packed-consumer [types](cluster-packed-types.log)/[runtime](cluster-packed-runtime.log)
also pass.

## Application call-feature readers

Call-page and protected huddle-chat readers now await the owning node's fresh
connection registration. Current role/epoch, actor, grants and resource checks
remain in the application. Local disconnect invalidation retains its
synchronous fence. Huddle socket writes are awaited so the REST operation
does not outrun its live delivery attempts. Connection-directory transport
failure returns 503 instead of treating unknown peers as departed and clearing
shared pages or chat history floors.

Four [native application contracts](cluster-app-native-cases.json) use two
WS server instances, independent Redis/DynamoDB clients, real Redis call/page/
membership/receipt state and DynamoDB Local messages. They prove:

- Remote call seats authorize REST reads, and canonical page pin/clear
  snapshots reach the other server.
- Huddle messages arrive over the peer transport; cross-node retries retain
  the same stored ID/timestamp and shared history contains one stored message.
- Revocation while the destination filter awaits prevents that socket write;
  stale readers receive 401 and departed registrations resolve absent.
- Connection-directory failure yields 503 while shared pages and history
  floors remain intact; healthy reads resume afterward.

These nodes run in one test process. Trusted credential headers and explicit
identity/resource fixtures establish their authority. This is not acceptance
of two actual BFF processes, the provisioned directory, production JWT
provenance across replicas or application resource providers across nodes.
The four native cases are included in the [345 passing backend contracts,
2 skipped](cluster-app-tests.log). The existing real-BFF browser path passes
[nine checks](cluster-browser.log) covering protected huddle messaging,
permissions/retry/draft behavior and explicit page sharing. Those browser
checks establish the normal single-gateway path and substitute unavailable
media-session metadata/receipts; this phase does not reaccept WebRTC media.
Runtime audit during the next integration slice found that this browser run
used BFF PID 56895, started on 2026-10-04 before the reader edits. Treat it as
a baseline browser regression, not proof of the updated backend runtime.
Fresh-process browser acceptance remains required. The native four-case
runtime tests, typechecks and inspected production artifact cover the edited
reader source.

## Final artifacts and remaining work

The portal passes [1,318 tests](cluster-portal-tests.log),
[typecheck](cluster-portal-types.log) and [build](cluster-portal-build.log).
Middleware [typecheck](cluster-middleware-types.log) and
[build](cluster-middleware-build.log) pass. The new ARM64 production image is
recorded in the [manifest](cluster-foundation-manifest.json); its installed
0.102.1 export, compiled fresh reader, 503 handling and awaited huddle writes
pass [network-disabled artifact inspection](cluster-gateway-artifact.log).
No running gateway container was replaced, and no image was pushed to ECR.

The one-task/stop-before-start/no-autoscaling safeguard remains intact. Before
changing it, configure and accept two full BFF processes with current
directory/resource authority, private Social membership invalidation, shared
presence/CRDT ownership, REST notification producers and node failure/rejoin.
Capacity must use a provisioned current-authority directory. Aurora migration/
IAM, tenant cloud acceptance, internet/TURN and physical-device media, and
broader role journeys also remain open.

The current default AWS identity check still returns
[`InvalidClientTokenId`](cluster-aws-identity.log); no cloud mutations were
attempted. Root main remains `86925d4d41b3957c747228d28eda5fba3c8f40f2` and
the accumulated unrelated work is preserved. The manifest seals this phase's
source/package/evidence hashes; older dated manifests retain their historical
pins. Initial runs exposed test adapter/type/assertion mistakes and lifecycle/
lease/index edge cases; the passing gates describe the corrected final state.
