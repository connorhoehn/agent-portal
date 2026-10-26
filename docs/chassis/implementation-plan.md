# Chassis implementation plan

Updated 2026-10-26 from the checked-out source. This refines the three approved
refactors: durable delivery and worker ownership, owner-published contracts, and
runtime capability/composition checks. Delivery repairs are in progress. C0 has queue characterization against
DynamoDB Local and a catalog source-retention regression; the early catalog
fix and capability-evaluator foundation are released (see the ledger).
The [execution ledger](../chassis-extensibility-goal.md) tracks completion;
[dependency-inventory.json](dependency-inventory.json) records observed versions
and pins. That inventory is not evidence of deployed versions.

## Recommended path

Finish the hangout regression release, then deliver one complete vertical slice:
**a durable job survives a service restart, is owned by one current attempt, and
reports honest readiness through the application and realtime modules.** Extract
only the contracts needed by that slice before moving the rest. Establish the
runtime capability vocabulary early so unsupported modes fail explicitly while
queue storage is being repaired.

Do not build another cluster framework. distributed-core already owns
`FencedLease`, `LeaseGroup`, `ReadinessGate`, bounded Redis and `Cluster.create` /
`createClusterFacade`. realtime-modules already has `defineFeature` and
`attachRealtime`; service-runtime already has configuration, dependency probes,
request context and ordered shutdown. Extend these existing owners.

## Evidence changing the priority

| Observed source | Consequence | Planned action |
| --- | --- | --- |
| message-queue `src/services/QueueInstance.ts`: delayed/dedup stores and consumer-group queues are in memory; durable lease claim failures do not block delivery | Persisted message bytes do not establish restart-safe delay, visibility, FIFO or group delivery | Replace the durable delivery path with transactional delivery state, then prove each guarantee separately |
| message-queue `src/storage/LeaseStore.ts`: claims are keyed by a newly generated receipt, not by message identity | Two different receipts do not contend for the same message; receipt persistence alone cannot authorize multiple active queue processes | Claim message + delivery scope atomically; fence acknowledge/extend/transfer on the current attempt |
| message-queue `src/storage/DurableBackedBatchedQueue.ts`: hydrates every retained body; QueueInstance reaches into private pending/inflight maps | Recovery can redeliver before an earlier visibility deadline; storage and scheduling are coupled | Make eligibility and lease state public delivery-store operations; remove private-map access from the durable path |
| event-catalog `src/client/durable.ts`: poison messages go into a capped in-memory buffer, then source receipts are deleted | A process restart can lose the only retained failed message | Move dead-letter responsibility to the durable broker; never delete the source on the strength of a diagnostic buffer |
| event-catalog publishes FIFO declarations without passing group/deduplication fields in `publishInner` | Declaring FIFO is insufficient to send valid FIFO messages | Add explicit publish options and contract tests; derive deduplication from stable event identity only where semantics permit |
| aws-agentcore `middleware/src/lib/mq-client.ts`: independent HTTP client, warning-only configuration conflicts, no heartbeat operation in the local interface | Wire handling drifts and consumers cannot express the full lease lifecycle | Publish a lean client/types subpath from message-queue; keep app queue definitions in the app |
| aws-agentcore `middleware/src/providers/agent-jobs.ts`: pull-side tokens fence results, push-side completion still permits the tokenless path | A late push-side completion can overwrite a newer attempt after recovery; the existing pull-side protection should be reused | Give push and pull executions an attempt token; conditional state changes and heartbeats in the authoritative job row |
| aws-agentcore `middleware/src/lib/replica-fleet.ts`: recovery lock has a fixed TTL without renewal | A long recovery pass can outlive its mutex; membership does not itself fence writes | Reuse fenced ownership where appropriate, while retaining attempt checks at each durable job mutation |
| realtime-modules `src/server/attach.ts`: duplicate wire keys are checked, manifest dependencies are not; factories create sequentially without rollback of earlier services on factory failure | Feature combinations and partial startup failure can leave inconsistent services | Preflight manifests/capabilities, preserve wire-name aliases, and clean up partially constructed features |
| realtime-modules `src/server/factory.ts`: unknown feature manifests are silently skipped | Configuration can appear accepted while a feature is absent | Add strict composition validation; migrate the legacy factory through the same validation without breaking its existing API accidentally |
| realtime-modules `src/client/hangout-rooms/types.ts`: saved layouts are absent; two application validators were introduced for the new plan | The new feature is not yet a complete reusable room contract | Publish the pure room-plan contract in realtime-modules and adopt it in both APIs and the UI |
| Package manifests contain different distributed-core/service-runtime/event-catalog pins and an event-catalog optional MQ peer name unlike MQ's actual package name | Version labels alone cannot establish compatibility | Verify exports, installed resolution and wire behavior before pin consolidation; correct the package identity during client adoption |

The queue's premature restart delivery, missing delayed-message persistence,
competing-client delivery and ignored claim refusal have now reproduced against
DynamoDB Local; see [the C0 record](queue-c0-verification.json). The remaining
rows are source findings, not claims that every failure has been reproduced.
The hangout return race was reproduced live separately and has a focused fix in
realtime-modules; that is part of the hangout release, not chassis completion.
Older repository roadmaps mention retired Raft queue wiring and a separate
pipeline-worker. Current code and the pipeline-runtime lifecycle take precedence.

## Ownership and reusable boundaries

| Owner | Owns | Consumer work |
| --- | --- | --- |
| distributed-core | Generic ownership, fencing, cluster and readiness primitives | Reuse existing exports; add a primitive only if a real consumer test exposes a missing operation |
| service-runtime | Pure capability requirement evaluation; safe diagnostics; existing health/config/shutdown integration | Hosts declare requirements from their enabled features and deployment mode; no app names or business authorization in the library |
| message-queue | Delivery state, atomic receipts, visibility, FIFO/delay/dedup, durable dead-letter transfer, consumer-group delivery, HTTP wire client | BFF memory fixture and event-catalog implement/consume the same public client contract |
| event-catalog | Event declarations, envelope/schema compatibility, publish/subscribe policy | Use the MQ client; keep broker delivery separate from WS signals; remove destructive in-memory DLQ fallback |
| realtime-modules | Realtime feature composition, store/authority requirements, room/meeting contracts and client hooks | Shared validation and capability reporting used by the BFF and gateway examples; keep browser entrypoints free of server dependencies |
| pipeline-runtime | Pipeline types and existing in-process bridge wiring | Use the bridge's ready/shutdown result in host readiness; no executor service extraction |
| platform-api | Business state, transactional outbox, authorization, scheduler integration and media-session metadata | Preserve repository transactions and scheduler fire claims; use new contracts and surface required dependency readiness |
| aws-agentcore | Tenant policy, actual runtime selection, agent-job attempt ownership, application adapters | Remove duplicate transport/shape logic; preserve domain-specific projections and authorization |
| live-video-streaming | Media ownership, channels, native SFU lifecycle | Compatibility consumer of fencing/event changes; no media topology redesign needed for this slice |
| realtime-examples | Executable gateway integration examples | Follow the reusable module release; exercise one supported composition, not every historical bootstrap mode |

managed-nosql-store is a future alternate DDB-wire adapter, not a prerequisite.
The new delivery-store contract must first pass against DynamoDB Local; accepting
the alternate store requires the same conditional-write/transaction failure tests.
Do not introduce another database migration to fix the queue's current semantics.

## Ordered work packages

| ID | Deliverable and owner | Prerequisite | Exit evidence |
| --- | --- | --- | --- |
| C0 | Characterize current protocol and failure cases; isolated local DDB/Redis harness | Hangout release checkpoint | Reproducers for restart visibility, lost delayed send, stale ACK, poison-message loss, and stale job completion; no shared-data resets |
| C1 | MQ client/types subpath with signed requests, deadlines, cancellation, visibility extension, explicit errors and strict ensure mode | C0 wire fixtures | BFF and event-catalog parity tests; browser/server import checks; old HTTP routes unchanged |
| C2 | service-runtime capability evaluator plus host profile declarations | C0 inventory | All configuration errors collected before resources open; unsupported memory/multi-replica combinations rejected; no secret values in diagnostics |
| C3 | Transactional durable message/attempt lifecycle in message-queue | C0, C1 | Two independent store clients cannot claim one live attempt; restart respects visibility; old ACK/extend rejected; durable write failure returns failure |
| C4 | Durable delayed eligibility, FIFO ordering/dedup, retention and atomic DLQ transfer | C3 | Crash between each write boundary loses neither source nor destination; FIFO group order survives restart; dedup and receive counts survive restart |
| C5 | Durable consumer-group subscriptions and delivery scopes | C3, C4 | Two groups each receive their own copy; same-group workers compete; last member leaving does not delete committed subscription backlog; generation-fenced offset commits |
| C6 | Durable event subscriber lifecycle in event-catalog | C1, C4 | Broker-owned DLQ; slow-handler visibility renewal; abort/drain semantics; lost ACK redelivers without charging handler failure budget; FIFO publish wire tests |
| C7 | Agent-job attempt lifecycle in the BFF | C0, C2 | Push/pull claims share fencing; cancel/requeue invalidates old completion; heartbeat expiry and two-dispatcher races tested against real local SQL |
| C8 | Realtime composition validation and reusable room contracts | C2; room contract independent of C3–C7 | Missing/duplicate/cyclic features rejected; partial startup rollback and reverse shutdown; saved-plan CAS/limits parity in both APIs; existing imports work |
| C9 | Host adoption and release compatibility matrix | C1–C8 | Platform outbox → MQ → consumer → durable result → realtime projection survives restart; mandatory dependency loss removes readiness; every owner release resolves from published artifacts |

C2 can be implemented before C3 is finished. C7 and the room-contract part of C8
are independent of queue storage. This is dependency independence, not a request
to run parallel agents. For one implementer, prefer C0 → C1 → C2 → C3/C4 → C6,
then C7/C8, then C5 and C9. Close the poison-message loss path as an early isolated
fix after its reproducer; do not wait for the full storage rewrite.

## Existing verification to extend

Reuse `realtime-examples/examples/middleware-foundation/acceptance.py` and its
UUID-owned Compose projects instead of inventing another integration stack. It
already exercises MQ/store replacement, durable ACK failure/retry, signed
requests, readiness and application recovery. Add a DynamoDB Local profile for
transaction semantics, then run the same store contract against its existing
managed-nosql-store profile. Build images serially; the example records a prior
local VM exhaustion under simultaneous image builds.

Extend these owner suites alongside the integration gate:

- MQ `test/integration/health-ready-contract.test.ts`, `ddb-lease-store.test.ts`,
  `ddb-store.test.ts`, `two-consumer-groups-fan-out.test.ts`, and
  `src/services/__tests__/QueueInstance.fifo-properties.test.ts`.
- event-catalog `tests/durable-failure-paths.test.ts`,
  `durable-acknowledgement.test.ts`, `durable-request-headers.test.ts` and
  `snapshot-consistency.test.ts`.
- realtime-modules `test/server/attach.test.ts`,
  `test/server/redis-router.lease.test.ts`, and meeting/call client tests.
- BFF `middleware/src/lib/__tests__/mq-client.test.ts`, `memory-queue.test.ts`,
  `replica-fleet.test.ts` and provider job tests. Existing SQL integration
  fixtures are a harness pattern, not proof of job attempt fencing; add the
  job-specific two-connection case.

`message-queue/scripts/characterize-durability.ts` now supplies the first C0
reproducers. A normal durable send/ACK control passed; all four observed defect
flags were true and the run exited 2 as designed. It removed its UUID-owned
table. This uses independent service/store instances in one process; separate
process/HTTP, stale ACK, FIFO/groups, catalog poison handling and job-attempt
cases remain. Existing suite names above are extension points, not newly passing
acceptance evidence. C0 is in progress. The early C6 source-retention fix and C2 evaluator are
released; the C1 owner client and BFF adoption are also released. Catalog adoption and
full C1–C9 downstream acceptance remain open. MQ now rejects unsupported
durable profiles before storage I/O. The v2 store is now connected to
QueueService/server under explicit experimental selection: 31 real DDB store
tests and ten separate-process signed HTTP tests pass, including restart,
competing claims, stale receipts, outage, shutdown, FIFO/dedup and atomic DLQ.
C3/C4 delivery policy is verified locally. C5, migration, scale and downstream acceptance
remain open; durable runtime profiles remain disabled. See the latest ledger.

## Durable queue design constraints

Use a delivery-state store owned by message-queue instead of adding more optional
best-effort stores around the in-memory queue. Persist envelope identity, ordered
sequence, eligibility/retention times, delivery scope, receive count, current
receipt/attempt and lease deadline. Storage performs conditional transitions;
in-memory lists may accelerate discovery but never authorize delivery or ACK.

For DDB, the message/delivery key is the contention point. A successful claim and
receipt index must be one transaction; ACK checks the current attempt and removes
its durable state atomically. FIFO claim also checks the group head/ownership in
the transaction. Dead-letter movement must atomically retain the destination
before releasing the source. Dedup reservation and accepted enqueue must not split
into a success-shaped reservation with no message. Expiration is a logical
eligibility rule; background TTL deletion is not its clock.

Preserve at-least-once delivery. Neither a receipt nor a fencing token guarantees
exactly-once business effects: each consumer needs a durable idempotency boundary
at its result write. Reuse platform-api's transactional outbox and SQL attempt
checks. Record stable event/attempt identifiers in diagnostics without message
bodies or tokens.

Retain the existing REST shape and memory profile while introducing the durable
implementation behind an explicit storage capability. Do not infer multi-process
safety from a DDB endpoint. Keep one active MQ process until competing-process
claim, FIFO, group and recovery tests all pass. Multi-owner readiness remains
rejected until that acceptance is recorded.

Group membership and subscription lifetime must be distinct. Persist the
subscription and its start position; workers coming and going must not erase
backlog. Define earliest/latest and unsubscribe behavior explicitly and preserve
the legacy ephemeral group mode for existing callers during migration. Large
fan-out must use a resumable durable expansion or per-group cursors, not an
unbounded multi-write transaction or fire-and-forget copies.

## Runtime profiles and composition

Start with explicit profiles: local ephemeral, durable single-process, and durable
replicated. Requirements come from enabled features, not from NODE_ENV alone.
An ephemeral feature such as cursor presence may legitimately use memory in a
durable application; chat history and accepted jobs cannot claim durability that
way. Every supplied adapter declares capabilities such as persistence, atomic
claim, conditional update and shared visibility. Verify declared capabilities in
contract tests; a label is not proof.

Keep static configuration validation separate from live dependency state. Use
service-runtime's existing bounded checks for dependency probes and
`ReadinessGate` for live ownership/listener state. A failed required capability
blocks the affected runtime before accepting writes; an optional model feature
may report degraded without disabling unrelated healthy routes. Preserve
liveness as event-loop/process health. Preserve existing health response schemas
where consumers depend on them; expose capability details additively.

Extend `attachRealtime`, not a parallel bootstrap API: preflight the complete
feature graph, account for serviceName aliases, construct in dependency order,
register cleanup as each feature succeeds, and roll back on partial failure.
Maintain principal revalidation and per-action authorization. Capability checks
must never substitute for access control. The legacy factory gets a deliberate
migration path and tests for its old supported inputs.

## Next consumer slice: C6 event-catalog

Source review on 2026-10-26 narrows the next changes to
`event-catalog/src/client/durable.ts`, `src/client/index.ts`, the public option
types and their existing durable tests. The owner client already supports async
request headers, strict `ensure`, POST receive, cancellation, deadlines and
rotating receipt extension. Preserve those boundaries rather than add another
HTTP retry/receipt implementation in the catalog.

1. Install the actual `@connorhoehnslalom/message-queue/client` owner artifact;
   replace the incorrectly named optional MQ peer with the dependency required
   by the runtime import. Verify a packed catalog consumer without sibling paths.
   Keep CommonJS compatibility; ESM remains opportunistic.
2. Route ensure/send/receive/ACK/extension through that client. Keep event
   validation, envelope construction, metrics and publish retry policy in the
   catalog. If the metrics observer needs raw queue attributes beyond `inspect`,
   add and test that query on the MQ client rather than duplicate its transport.
   Bound health/attribute response bodies too; broker readiness must not be
   inferred from process liveness.
3. Make queue ensure strict. Today a failed DLQ ensure drops redrive policy and
   a 409 is accepted. Preserve the full requested configuration across retries,
   cache by configuration as well as name, and invalidate/recreate with that same
   policy after a 404. Create FIFO DLQs with matching FIFO configuration and a
   valid `base-dlq.fifo` name. Never silently downgrade durable policy.
4. Carry declared `partitionKey(payload)` or an explicit publish group into FIFO
   sends. Use the stable envelope ID as the default dedup identity for retries of
   that envelope; expose explicit send options where callers need control.
   Reject a FIFO publish lacking a group instead of inventing one. The existing
   catalog currently forwards neither partition keys nor FIFO send fields.
5. Track each acquired receipt as a lease, including messages waiting behind a
   slow handler in a received batch. Renew before expiry, serialize renewal with
   terminal ACK, and use the latest rotated receipt. Lease loss stops ACK and
   signals cancellation to the handler; it must not increment the handler's
   poison budget. Preserve the already-shipped rule that local diagnostics never
   authorize source deletion. Broker delivery count and actual handler failures
   are distinct observations.
6. Separate stopping intake from draining accepted handlers. Keep synchronous
   unsubscribe compatible, expose completion, and make disconnect wait within a
   bounded budget. After cancellation/drain expiry, start no further handlers
   from the leased batch and refuse late ACK. Handler cancellation is cooperative;
   business writes still need their durable idempotency/fencing boundary.
7. Reuse the UUID-owned DDB/child-process harness for a real catalog consumer:
   slow handler plus competing subscriber, renewal/ACK race, cancelled batch,
   lost ACK response, broker outage, poison movement, FIFO publish and policy
   mismatch. Extend existing catalog unit/loopback suites and packed Node 20/25
   import/require checks. Run its full suite and dist gate before release/push.

C7 job fencing and C8 realtime composition/contracts follow this consumer slice;
C5 durable subscriptions and C9 host adoption remain required by the original
goal. This source review is a plan, not implemented catalog behavior.

## ESM migration debt — TD-ESM-01

**Decision: accepted 2026-10-25. Status: deferred, opportunistic only.** ESM is the
target module format. The user directed us to track this as technical debt and
work on it only when already changing the relevant file for authorized work.
Retain CommonJS compatibility for shared packages while consumers require it.
This decision does not authorize a standalone migration or make conversion a
prerequisite for C0–C9.

Use ESM source syntax in touched files where the existing package/build contract
supports it. TypeScript `import` syntax alone does not establish ESM output. Do
not flip a package's `type`, exports, compiler mode or test runner merely because
one file was touched; if conversion expands beyond that work, leave it deferred.
Keep CommonJS tool/config files explicit where their runner still requires them.
Current Node images mix 20 and 22, TypeScript versions differ, and several package
engine ranges still admit early Node 20 releases. Do not rely on newer
`require(esm)` interoperability without first tightening and testing that matrix.

Use tested conditional exports where dual entrypoints are necessary. Stateful
libraries must share runtime state across import/require entrypoints; do not
independently instantiate two registries, caches or owner managers. Browser-only
entrypoints must remain isolated from server dependencies. Check packed artifacts
in native Node ESM, native Node CommonJS and the actual Vite consumer.

When a dedicated migration is scheduled, use a deterministic, reviewable process:

1. Generate a versioned inventory of package boundaries, exports, emitted formats,
   Node floors, consumer pins and CommonJS-only tooling from manifests/configs.
2. Run AST-based codemods with explicit preconditions and a dry-run report. Convert
   only mechanically safe static imports/exports and resolvable specifiers;
   report dynamic `require`, resolution hooks, cycles and interop assumptions for
   review instead of guessing. Resolve paths against actual emitted artifacts.
3. Require an idempotent second run with no changes, then typecheck, build and test
   packed artifacts across the supported Node/import/require/browser matrix.
   Include shared singleton identity and initialization/cleanup behavior.
4. Release one package boundary at a time with compatibility entrypoints and a
   reversible consumer-pin update. Retire CommonJS output only after the consumer
   inventory and compatibility tests show it is unused.

Owners are the maintainers of each affected package; the central tracking entry
is [TD-ESM-01 in the chassis ledger](../chassis-extensibility-goal.md#technical-debt).
No codemod or package conversion is implemented by this planning entry.

Primary references: [Node package exports](https://nodejs.org/api/packages.html#conditional-exports),
[dual-package state hazards](https://github.com/nodejs/package-examples/blob/main/guide/07-dual-packages/README.md),
and [TypeScript module configuration](https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html).

## Release and migration gates

1. Capture C0 fixtures and the installed dependency graph; distinguish source,
   built artifact, installed artifact and running service fingerprints.
2. Release additive owner APIs first. Keep temporary re-exports/adapters for the
   old imports; do not require all applications to switch in one deployment.
3. Install built owner artifacts in each consumer and run export/type/wire tests.
   MQ currently ships ESM; event-catalog and realtime-modules ship CommonJS.
   The client needs tested import/require entrypoints (or a compatible owner
   artifact), not a root import that constructs queue services or starts timers.
   Test packed artifacts with Node import and require, not only TypeScript.
   Resolve service-runtime/DC compatibility without assuming every consumer needs
   the newest version. Do not add a dependency cycle between event-catalog and MQ.
4. Introduce new durable records with a schema version and a restartable migration.
   Pause queue intake, drain or explicitly transfer live attempts, validate counts,
   and retain old records until verified. No mixed old/new writers against changed
   receipt semantics. Dry-run against an isolated copy before any shared migration.
5. Rollback is safe only before incompatible state has been written, or through a
   tested reverse migration. Merely downgrading a package is not a rollback plan.
6. Run the vertical slice with two service processes, injected store/network
   failures, worker cancellation, rolling replacement and stale completions.
   Include native media/call regression checks for RT module releases.
7. Commit owner source and built artifacts, tag where required, push, then update
   consumer pins and record exact tested revisions. No cloud deploy is implied.

## Acceptance matrix

| Failure boundary | Required outcome |
| --- | --- |
| Accepted send then immediate process death | Message remains discoverable; accepted delay/retention semantics remain intact |
| Claim then process death before response | One lease survives; message becomes eligible when its deadline expires |
| Two processes receive the same message | One current receipt per delivery scope; competing worker gets another eligible message or empty result |
| Old worker ACKs/extends after reassignment | Rejected without changing the current attempt |
| Handler succeeds, ACK response is lost | Redelivery permitted; durable business result is not duplicated |
| Poison handler; DLQ storage unavailable | Source retained and failure visible; diagnostic buffer is insufficient |
| FIFO head is slow or its owner dies | No later message in that group passes it; other groups can progress |
| Group worker exits or all members disconnect | Subscription backlog remains; rejoin resumes at the durable position |
| Redis stalls beyond lease deadline | Owner fences immediately; readiness drops; stale business writes fail |
| Required store absent / wrong capabilities | Startup or readiness rejects the enabled operation with an actionable reason |
| Feature factory fails after earlier factories ran | Constructed services, listeners and timers are cleaned up |
| Pipeline bootstrap returns null | Required pipeline capability is unavailable; unrelated optional features remain usable |
| Browser consumer imports room contracts | No React hook execution, Node built-ins, DDB SDK or server side effects loaded |

Capacity and cloud readiness are separate acceptance work. This plan does not
claim AWS IVS validation, Redis Cluster support, cross-region queue safety, or a
production throughput target. Choose and measure those profiles after correctness
and release compatibility are established.
