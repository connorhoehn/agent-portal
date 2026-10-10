# Peer readers and current inbox authority — 2026-10-05

This accepts the focused peer subscription and inbox behavior. Overall capacity,
cloud deployment and media at 100 calls remain unaccepted. Keep the deployment
single-gateway safeguard. Default AWS identity still returns
`InvalidClientTokenId`; no cloud mutation, ECR push or Aurora migration occurred.

Both consumers pin realtime-modules **0.106.0**, commit
`c5c967ee18fb2fa6dabe126e2dcdd023a4a64dac`, pushed on
`feat/redis-realtime-router`. The owner realtime/UI main checkouts remain clean
at their prior commits. Earlier acceptance records retain their original pins,
source snapshots and artifact digests.

## Resulting behavior

The public `isClientSubscribed` probe checks the recipient's actual readable
subscription. Local checks retain the exact connection context and subscription
token across fresh authority reads. Remote checks use current leased identity,
connection generation, bounded receipts and owner validation. Missing receipts,
expired registrations, retired owners or changed subscriptions return false.
These checks emit no client-visible authorization error.

DM and channel notification producers use this public API to detect readers
hosted by a peer node. A reader receives the message without an unnecessary
live or stored unread alert; after unsubscribing, the member receives the
alert. Mentions retain their attention behavior. Unknown router state preserves
conservative notification behavior.

A 200-item inbox reply checks each unique policy/resource within that reply.
No completed or already-started authority answer is shared with later replies.
Current directory rights and all pending membership fences still surround the
final send. A new native replay case exposed a cold-node bug: the synchronous
resource guard consulted an empty local mirror before fetching membership.
Fresh resource hydration now precedes that final guard. All 200 authorized
records replay; a later completed removal filters them on the other node while
leaving all 200 persistent inbox rows intact.

## Verification

- Library: 2,034 passed, 9 skipped, across 175 passing suites. Build and all
  31 public exports pass. The actual packed artifact passes TypeScript
  consumption and local readable-subscription runtime checks.
- Application: 292 passed, 1 skipped, across 29 suites, including native
  Redis/DynamoDB Local contracts and the optional Social round trip. The skip
  is the separately opted-in store restart. Latest authority subset: 52 passed.
- Full BFFs: all 12 native contracts pass, including peer DM/private-channel
  producers, 200-record replay/removal, atomic competing-tab admission,
  current epochs/operators, REST cookie/JWT fanout, presence, protected
  pages/history and natural-lease crash/rejoin.
- The 0.106 peer API also passes three actual Redis failures and one actual
  DynamoDB stall/recovery case. Those faults ran before the final cold-peer
  guard reorder; current authority regressions cover that later application
  change. Dedicated stores are running and unpaused afterward.
- Portal: 1,318 tests and typecheck/build pass. Nine fresh local browser cases
  pass in 46.3 seconds with restarted BFF/Vite processes. These use local
  routing and stub media receipts, and do not establish SFU/cloud acceptance.
- Both consumer typecheck/build gates and a network-disabled inspection of the
  actual compiled Node 22 ARM64 artifact pass.

The first broad app run selected DynamoDB for memory-fixture tests; its failures
are preserved. The corrected latest gate passes. Initial browser setup lacked
the explicit fixture WebSocket endpoint and raced BFF readiness; those failures
are retained, and the corrected fresh browser gate passes. Cold-peer inbox
failures are genuine reproduced regressions with passing fixes.

## Capacity remains open

Count/timing-only profiling found roughly 48,000 DynamoDB queries per node.
Reply-only inbox batching reduced that to about 17,500; the identical burst
still failed. Those before/after results and exact compiled source are sealed
in `capacity-inbox-before/manifest.json` and `capacity-inbox-after/manifest.json`.

Current local-only compiled image:
`sha256:9493e0964c2bc1a72f89315c4d84cf96e1fce91cc32b15d54a7b22ec0dc96ac2`.
Both BFFs have one CPU and 1,024 MiB; the internal driver has one CPU and
512 MiB. This run still routes native stores through the host's published
fixture ports. The adapter executes actual provider SQL and substitutes only
the non-production RDS transport; it does not establish Aurora/IAM/Cognito.

| Unchanged synchronized burst measure | Result |
| --- | --- |
| Connected sockets / established calls | 1,000 / 100, all |
| Paired senders reaching their peer | 800 of 800 |
| Cross-deliveries / denied actions / unexpected ends or disconnects | 0 each |
| New unread alerts for peer readers | 0 |
| Invite p95 / p99 | 1,930.3 / 1,987.7 ms |
| Accept p95 / chat p95 | 984.0 / 4,712.6 ms |
| Health p99, primary / peer | 36.6 / 103.1 ms |
| Memory peak, primary / peer | 223.7 / 224.8 MiB |

Latency and peer health still fail. All thresholds and the synchronized
workload remain unchanged. The complete older 0.105 matrix is preserved in
`capacity-current/manifest.json`; a passing collision profile does not accept
all capacity. A separate read-only comparison is investigating direct store
traffic inside the owned Docker network. No direct-route application load is
accepted by this record.

Remaining requirements include burst/reconnection pressure, the complete
capacity matrix, broader producer/role/tenant acceptance, cloud permissions
and deployment, Aurora migrations, 100-call real media, WAN/TURN, physical
devices and recording/restart coverage. See [current work](capacity-progress.md)
and `cluster-inbox-manifest.json` for evidence and exact source snapshots.
