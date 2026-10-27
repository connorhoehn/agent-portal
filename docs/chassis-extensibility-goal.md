# Chassis extensibility implementation

Requested 2026-10-25. Complete the three refactors in their owning packages and
adopt them in aws-agentcore and realtime-modules. This is an implementation
ledger, not a claim of production acceptance.

## Detailed plan

The [source-backed implementation plan](chassis/implementation-plan.md) defines
C0–C9, package ownership, migration gates and failure acceptance. The
[dependency inventory](chassis/dependency-inventory.json) records the inspected
pins. C3/C4 transactional delivery, FIFO/dedup and atomic DLQ pass local store
and separate-process HTTP acceptance. C6 subscriber lifecycle, C7 fenced job
attempts and C8 realtime composition/shared room contracts are verified locally
and pushed. C5 durable subscriptions now pass local acceptance in MQ 0.5.0.
C9 host adoption, readiness and the durable result/realtime path passed local acceptance on 2026-10-26, and the WebSocket leg and replicated brokers on 2026-10-27 (see the last sections); cloud and AgentCore-on-Aurora acceptance remain open.
The detailed plan refines the order below: extract the needed client contract
and capability checks before the durable queue migration.

## Execution order

1. Repair and verify the current hangout page, including the reported active-call
   layout, duplicate activity sections, saved layouts, temporary rooms, media
   movement and recording-summary authorization.
2. Make queue delivery and worker ownership durable. Extend existing message-queue
   stores and distributed-core fencing rather than introduce another coordinator.
   Prove restart recovery, visibility leases, delayed delivery, FIFO deduplication,
   consumer groups, duplicate delivery, stale receipts and stale-worker completion.
   Document supported replica/storage combinations explicitly.
3. Publish contracts and clients from their owners. Remove redundant BFF queue
   interfaces and room-plan validation, validate wire compatibility, and migrate
   realtime-modules and application consumers. Preserve the distinction between
   WebSocket frames and durable broker events; retain intentional domain projections.
4. Add declarative runtime capability checks to service-runtime, using existing
   distributed-core composition and readiness primitives. Integrate queue/storage/
   ownership checks in realtime-modules and both application services. Unsupported
   production combinations must fail startup or readiness with actionable errors.
5. Release owning packages, update consumer pins, run cross-package compatibility
   and failure tests, and push verified work. Local tests do not establish cloud
   deployment or capacity acceptance.

## Completion ledger

| Work | Owners / consumers | Status | Required evidence |
| --- | --- | --- | --- |
| Hangout baseline | ui-components, realtime-modules, platform-api, aws-agentcore | Targeted release verified | Real two-person media walk and 28 layout states pass; backend authorization checks pass. Broader tenant journey freshness still needs renewal (see product-readiness record) |
| C0 failure characterization | message-queue, event-catalog, AgentCore | Locally verified | Queue failure reproductions plus catalog poison/ACK and job-attempt ownership records are linked in the dated checkpoints |
| Durable queue and worker lifecycle | message-queue, distributed-core; platform-api, realtime-modules | Locally accepted (C9) | C3–C5 owner checks plus the C9 host matrix; MQ `ddb-v2` durable-single and durable-replicated enabled (0.5.3) |
| Owner contracts and clients | message-queue, event-catalog, pipeline-runtime, platform-api; realtime-modules, aws-agentcore | Locally accepted | Consumer typechecks; wire fixtures; no duplicate canonical validators/interfaces |
| Runtime composition | service-runtime, distributed-core; realtime-modules, platform-api, aws-agentcore | Adopted in platform-api and AgentCore; platform path accepted | Supported matrix passes; unsafe combinations rejected; ownership loss removes readiness |
| Downstream releases | All changed owners and consumers | Pushed: catalog 0.10.0, MQ 0.5.2, platform-api 8a0be3f, AgentCore, realtime-examples | Built owner artifacts match source; final consumer pin/result/readiness matrix remains |

## Boundaries

- Preserve existing data and the Product review / Design studio hangouts.
- Use isolated walk identities and clean up only records created by those walks.
- No cloud deployment, business-data reset or claim of accepted production scale.
- Keep the pipeline executor in platform-api; its retired worker service is not
  restored without a demonstrated requirement.
- Do not replace working domain-specific authorization or fencing with a generic
  interface that weakens those guarantees.

## Technical debt

| ID | Decision | Status / trigger | Acceptance |
| --- | --- | --- | --- |
| TD-ESM-01 | ESM is the target across the chassis and application packages; retain CommonJS consumer compatibility as needed | Deferred. Only migrate a file already being changed for other authorized work when its package boundary safely supports it. No standalone conversion or broad configuration churn. | Future deterministic inventory + AST codemod with dry-run and idempotence checks; packed-artifact compatibility, singleton identity and consumer tests before each package release |

Accepted by the user on 2026-10-25. The
[migration policy and automation path](chassis/implementation-plan.md#esm-migration-debt--td-esm-01)
define the scope. This debt does not block the three chassis refactors.

## Evidence

Append exact test commands, outcomes, versions and remaining limitations as each
phase completes. A planned row becomes complete only after downstream adoption.

### 2026-10-25 — active implementation goal

The three chassis improvements are the active Codex goal. The hangout baseline
release is complete; chassis C0–C9 acceptance remains the completion boundary.

- **C0 / early C6:** event-catalog `0f979fa` (0.8.8, pushed) stops deleting a
  poison source on the strength of its process-local diagnostic buffer. A real
  loopback HTTP regression failed before the fix (unexpected source DELETE),
  then passed after replacing the subscriber and its diagnostic buffer. This
  proves subscriber policy, not broker disk durability. All 149 suites / 3,139
  tests pass, as do lint, build and eight-export/four-bin dist verification.
  Full C6 (heartbeat, drain, FIFO, owner client) and consumer adoption remain open.
- **C2 foundation:** service-runtime `0776e24890478b9a3098bd132c47f086e0e6994a`
  (v0.5.0, pushed) adds pure capability evaluation/assertion and a lean signing
  entrypoint sharing the existing implementation. All 19 suites / 356 tests,
  typecheck, lint (13 existing warnings, no errors) and build pass. Packed
  native Node 20.0.0 and 25.9.0 import/require checks confirm class/function
  identity and no telemetry/JWT/logging imports through the two new subpaths.
  This is static evaluation only; host profiles and live readiness remain open.
- **C1 in progress:** MQ owns the new HTTP client and browser-safe wire types.
  The owner client is now released and adopted by the BFF (details below).
  Catalog adoption remains part of C6. Inspection also found catalog's GET receive query
  names differ from the broker's camelCase names; adopting the POST receive
  contract will remove that drift.

Evidence commands: event-catalog `npm test`, `npm run lint`, `npm run build`,
`npm run verify:dist`; service-runtime `npm test -- --runInBand`,
`npm run typecheck`, `npm run lint`, `npm run build`, `npm pack` and native
import/require of the extracted tarball. Raw local logs are under `.scratch/`
with the `chassis-catalog-` and `chassis-runtime-` prefixes. No shared data reset
or cloud operation was used.

### Foundation release and first consumer adoption

- **C1 owner:** message-queue `dd97a694d3528e11b55f405af97a30b62b559abd`,
  tagged v0.3.0, publishes client/types subpaths. The full owner suite passed
  127 suites / 1,522 tests; seven environment-gated suites / 42 tests skipped.
  This includes a real signed HTTP client-to-broker lifecycle. Packed Node
  20.0.0 and 25.9.0 import/require checks and browser compilation with no Node
  types pass. The Git consumer install built the ignored dist successfully.
- **BFF adoption:** `lib/mq-client.ts` is a compatibility re-export, replacing
  the independent HTTP implementation. The memory fixture now supports receipt
  renewal/rotation, abort-before-mutation, delayed FIFO heads and strict ensure;
  unsupported consumer-group subscriptions fail explicitly. The middleware pins
  MQ v0.3.0 and service-runtime v0.5.0 at full SHAs. Installing MQ also resolved
  additional server-package dependencies; runtime import isolation is verified,
  but the subpath does not make its npm dependency tree client-only.
- **Application verification:** typecheck/build and 19 focused queue tests pass.
  The full middleware run had 540 passing suites / 7,495 passing tests, nine
  skipped suites / 56 skipped tests, and two stale route-record failures from
  the earlier hangout release. Static enumeration refreshed all 811 routes;
  the two PATCH routes were recorded as refused by existing policy, with a
  separate refusal-review timestamp. No HTTP response was invented or write
  replayed. All seven wire suites / 79 tests then passed. The entire middleware
  suite was not repeated after this metadata-only correction.
- **C2 queue host checkpoint:** message-queue
  `e8a336df4d9784f77a6181772b9116e612231c58` is pushed after the v0.3.0 tag.
  It preflights profiles/counts before stores/listeners. Seven profile tests
  (including a child-process startup with zero storage requests), 21 storage
  factory tests, two readiness-contract tests, build and changed-file lint pass.
  This is unreleased server work; the BFF remains pinned to the client release.
  Legacy DDB offers body persistence, not complete durable delivery, so durable
  profiles intentionally remain unavailable until C3–C5 acceptance passes.
- **C3–C5 design:** the owner records transaction boundaries, queue/subscription
  generations, FIFO head progression, bounded materialization and migration in
  `message-queue/docs/delivery-state-v2.md`. This is a design, not an implemented
  store or scale claim. Keep the new store in a distinct schema namespace.

The local middleware watcher was restarted after dependency installation left
it without the new package during resolution; `/api/health` on 3001 and portal
5183 return 200. No shared reset endpoint or cloud operation was used. The
user's original ui-components lock remains byte-identical to its backup.
Event-catalog consumer pins, C3–C7 delivery/job work, C8 reusable room contracts
and composition, and the C9 end-to-end release gate remain open. The earlier
broad tenant journey freshness limitations still apply.

### Usage-limit checkpoint: transactional store foundation

The user reported an approaching usage limit. Progress is saved without marking
the goal complete or changing it to paused. Message-queue main is pushed at
`c0d22e9422b546370f712e5233f8fb5ecb85dc9c` (unreleased; v0.3.0 remains the earlier
client release). `src/storage/delivery/` now contains the v2 store contract,
configuration validation and DynamoDB transaction implementation. The store
fences mutations by queue generation and current receipt, atomically persists
enqueue/claim/ACK/renewal, retains append history, and bounds candidate discovery.

Verification: **14 real DynamoDB Local tests pass**, including two-client
enqueue/claim contention, replacement-client visibility/counts, stale receipt and
generation rejection, ACK-versus-renewal races, delay, retention, pagination,
storage failure and lost-response recovery. Build, changed-file lint and diff
checks pass. The test deleted only its UUID-owned table and destroyed its own
clients. Log: `.scratch/chassis-delivery-v2-store-tests.log`. Machine-readable
record: `chassis/delivery-store-verification.json`.

**C3 is not complete.** This is a store-level checkpoint; it is not connected to
QueueService or the running server, and no new capability is advertised. The
legacy path still has the C0 defects. FIFO, DLQ, subscriptions, retired-generation
cleanup and migration tooling remain open. No consumer pin was moved for this
unreleased work. No shared stack reset, restart or deployment was performed.

Resume with the QueueService/HTTP integration. Read the owner's
`docs/delivery-state-v2.md`, then audit concrete `getQueue()`/QueueInstance uses
before choosing the adapter boundary. Keep the existing REST contract and memory
profile; explicitly reject unsupported operations. Add connection readiness and
bounded shutdown, then prove restart and competing claims using **separate queue
processes over HTTP**. Do not enable durable profiles before the C3–C5 acceptance
matrix passes. Continue all C0–C9 work from the original plan; this checkpoint
does not narrow the approved three improvements. ESM remains opportunistic only.

### 2026-10-26 — C3 HTTP lifecycle and shared shutdown release

Message-queue `757d06fc0085f14ed0357104fe14274c44f19cbe` is pushed to main
(unreleased; the v0.3.0 tag and application client pin remain unchanged).
The existing QueueService and signed HTTP API now use transactional standard
delivery when explicitly configured with `ddb-v2` and a separate pre-provisioned
table. Startup validates that table, reads discover current queue generations,
operations are bounded/cancellable, and readiness follows storage availability.
Partial storage initialization rolls back, parked receives end before HTTP
drain, and accepted acknowledgements can finish before final shutdown.

- Full MQ suite: **130 suites / 1,537 tests passed**, nine gated suites /
  65 tests skipped. Build, changed-file lint and diff checks pass.
- Real DynamoDB Local: **14 store + eight separate-process HTTP tests passed**.
  The latter use the published HTTP client, signed requests, two queue children,
  SIGKILL/replacement, competing claims, delayed delivery, stale receipts,
  queue recreation, injected storage outage, abort and graceful shutdown.
  Only UUID-owned tables and child processes are removed.
- All eight HTTP cases also pass under **Node 20.0.0**. The packed MQ client
  import/require identity and browser-only type checks pass under Node 25.9.0.
- A real same-port IPv4/IPv6 test identified a Supertest fixture-routing defect;
  the test harness now targets the actual listener family. Focused fixture,
  quota and schema tests pass (18). Queue deletion now stops its legacy runtime;
  parked receive/deletion and delayed workflows pass (62 focused tests).

Service-runtime **v0.5.1**, `c01db0e6dfe0e6b91081ae92ee5cc3c1e77d2ad6`, is
released and pinned by MQ. Its HTTP drain closes idle keep-alive sockets on
early Node 20 while preserving active responses. Shutdown uses a monotonic total
budget, reports hook failures through exit status, and settles custom callbacks
once. All **19 suites / 360 tests**, build/typecheck and lint pass (13 existing
warnings); nine lifecycle tests pass on Node 20.0.0. Native extracted npm packs
pass import/require identity and custom-shutdown checks on Node 20.0.0/25.9.0.
Application adoption of this patch remains part of C9.

**C3's standard delivery lifecycle is locally verified; the overall goal is
unfinished.** Durable profiles remain disabled. FIFO/dedup, atomic DLQ transfer,
subscriptions, retired-generation cleanup/migration, C6 catalog lifecycle,
C7 job fencing, C8 realtime composition/room contracts and C9 adoption remain.
Continue with C4 using the linked-group transaction design in the owner's
`docs/delivery-state-v2.md`. No shared reset/restart or cloud deployment occurred
in this checkpoint. Evidence is in `chassis/delivery-store-verification.json`;
local logs use `.scratch/chassis-delivery-v2-` and `chassis-runtime-` prefixes.


### 2026-10-26 — C4 policy acceptance and repository push audit

Message-queue policy implementation `eb51d18fa232e1a5ee9e05b50d2cd67dcd8a1e36`
and persisted-policy correction `2f562c20c522b3d697e9604ce26a1a86e9490fd4` are
pushed to main. These remain unreleased server checkpoints; v0.3.0 and consumer
pins are unchanged. FIFO group head/tail progression, five-minute queue/group
deduplication, retained accepted responses, expiry unlinking and automatic DLQ
movement now use transactional storage. Source removal, destination acceptance,
FIFO progression and transfer identity commit together. Missing/replaced targets
retain the source; cyclic or mismatched policies are rejected. Caller queue
handles identify a generation but cannot override persisted dedup policy.

Verification at the final correction: **130 suites / 1,537 tests pass**, nine
gated suites / 84 tests skipped. **31 DDB store + ten separate-process HTTP
cases pass on Node 25.9.0 and 20.0.0**; combined with API validation, the focused
run passes 76 tests. Build, changed-file lint, diff checks and packed-client
import/require/browser-type verification pass. Two added regressions failed
before their fixes: broker DLQ provenance could strand a size-limit body, and a
caller-supplied queue handle could change dedup scope. All fixtures removed only
their own UUID tables and processes. No shared reset/restart or cloud action.

The user explicitly requested every related repository be pushed. Audit scope:
aws-agentcore, message-queue, service-runtime, event-catalog, realtime-modules,
distributed-core, pipeline-runtime, platform-api, live-video-streaming,
realtime-examples and ui-components. All local branch commits were checked
against origin, not only the checked-out branch. There was no older unpushed
work. The only pre-existing worktree difference was two stale UI lockfile version
fields (2.457.1 versus published 2.481.2). They were aligned to the manifest;
the result is byte-identical to the committed release, with the original full
backup retained at `.scratch/ui-components-original-lock-before-hangouts.json`.
No dependency entries changed and no new UI release was made.

**The three-improvement goal remains unfinished.** Next is C6 catalog consumer
adoption, then C7/C8, C5 and C9 as planned. The implementation plan now records
the concrete C6 path: shared client, strict full-policy ensure, FIFO publish
fields, lease renewal for all acquired batch messages, serialized ACK/renewal,
and bounded drain. Durable profiles remain disabled. Legacy operator replay/
redrive, subscriptions, migration and production scale are not newly accepted.


### 2026-10-26 — C6 catalog consumer released

Message-queue **0.4.0** (`b055b33a1ca3fa201415478768b18fbaed73f805`) and event-catalog
**0.9.0** (`4e8910f70486d335014d6d6eb93fa842ae8bed32`) are pushed with release tags. C6 now
uses the owner client for signed/bounded wire operations, strict policy setup,
FIFO group/dedup fields, readiness and metrics. Every fetched receipt renews,
including queued batch members. Renewal and ACK serialize; cancelled/expired
leases cannot authorize late ACK. Stop intake then drain within a bounded budget;
pausing no longer acknowledges skipped work. Declared queue names flow through
publish, subscribe and observation. Transitive AJV installation exposed an
implicit schema-mode switch; catalog now explicitly preserves its established
fallback keyword semantics.

**152 suites / 3,157 tests pass**, including nine real DDB/separate-process broker
cases. The 16 focused ownership/policy tests pass on Node 20.0.0; packed catalog
root/durable import/require identity and public types pass on Node 20.0.0 and
25.9.0. MQ passes 130 suites / 1,541 tests (nine gated suites / 84 skipped),
plus packed client checks on both runtimes. Builds, dist gate and generated
contract checks pass. Fixtures removed only their owned processes/tables.

**The goal remains unfinished:** C7 attempt fencing and C8 composition/contracts
are next, then C5 durable subscriptions and C9 host adoption. No shared stack
restart/reset or cloud deployment occurred. Host consumer pins are unchanged.
Evidence: [catalog-consumer-verification.json](chassis/catalog-consumer-verification.json).


### 2026-10-26 — C7 fenced job attempts accepted locally

Implementation `cf672ef5` unifies push, named and pull claims around the existing
SQL attempt token and heartbeat. Late/missing-token writes are refused;
cancellation/recovery revoke ownership. The dispatcher renews serially and
aborts/suppresses late work when ownership is uncertain. Replica maintenance
locks reuse the shipped `FencedLease`; long holds renew and displaced callbacks
stop initiating mutations.

The 27 ownership checks pass on Node 20.0.0 and 25.9.0, including nine actual
PostgreSQL cases and nine Redis cases. All 554 middleware test files are accounted
for across batches: 544 runnable suites passed, ten opt-in suites skipped in the
default inventory. The ownership SQL and migration Dynamo tests were also run
explicitly against isolated local stores. Type-checking and mock-floor source/
snapshot checks pass. Two timing failures passed their focused rerun; the diff's
explicit two-second assertion was unchanged. Jest reported a worker force-exit
warning on that rerun. The detailed execution record preserves these limits:
[job-attempt-verification.json](chassis/job-attempt-verification.json).

The C8 implementation plan is now concrete. Four composition gaps reproduced
against installed realtime-modules 0.138.0; see its C0 record and reusable
reproducer. **C8 composition/room contracts, C5 subscriptions and C9 adoption
remain unfinished.** No cloud rollout is authorized by this checkpoint. Before
deployment, apply the existing job-fencing migration and drain old push workers;
their unconditional SQL makes mixed-version execution unsafe.


## C8 realtime composition and room contracts — 2026-10-26

Realtime-modules 0.139.0 (`c002e5e`) now validates feature graphs and explicit
adapter capabilities before startup, resolves aliases in dependency order,
rolls back partial construction, and disposes once in reverse order. Socket
authentication/registration cannot outlive service teardown. The legacy factory
shares the planner and lifecycle and refuses unknown features actionably.

The pure `hangout-rooms` entry point owns room-plan input/types/limits and the
REST client. Platform-api, the BFF and portal consume it. Both HTTP adapters
run the same boundary corpus. Real DynamoDB competing writes and the BFF mock
prove one winner for same-version saves; assignments remain separate from ACLs,
attendance and IVS sessions. Artifact checks load the actual package in Node
20/25 and a browser-like VM without React or Node imports.

Evidence: [realtime-composition-verification.json](chassis/realtime-composition-verification.json).
The original goal remains unfinished: **C5 subscriptions and C9 final adoption,
readiness and restart/result acceptance remain**. Production durable profiles
stay disabled; ESM migration remains opportunistic.


## C5 append-history prerequisite — 2026-10-26

MQ 0.4.1 (`aa981c5`) retains accepted eligibility in immutable append history.
Before this change, ACK erased the only durable record of the original delay.
The three regression cases failed before and pass after; all 44 actual store/
process cases pass on Node 20/25, and all 130 runnable MQ suites / 1,541 tests pass.
The owner now has a concrete storage/API/generation/migration/test plan in
`docs/durable-subscription-plan.md`. Its subscription implementation is still
required, followed by C9 host/readiness/restart acceptance. The original goal
remains unfinished. See
[subscription-prerequisite-verification.json](chassis/subscription-prerequisite-verification.json).


The same release audit found obsolete generated modules surviving builds in the
long-lived MQ checkout. Release 0.4.2 (`e02f726`) clears generated output before
compiling. Fresh/main and Node 20/25 packages now match byte-for-byte; final
packed-client checks pass on both runtimes. This closes that artifact drift
without claiming the remaining C5/C9 work is done.


## C5 durable subscriptions — 2026-10-26

MQ **0.5.0 / `316c35f`** is committed, tagged and pushed. It adds independent
durable subscription generations, bounded transactional history materialization,
scope-local FIFO/DLQ, worker sessions and fenced offsets. The final member leaving
preserves backlog. Offset observations cannot acknowledge or skip delivery.
Explicit signed client/API methods preserve the default and legacy boundaries.
ACK and renewal now enforce queue receive permissions as well.

The body-free history inventory is read-only, bounded and generation-pinned. It
reports missing original eligibility and incomplete scans without importing or
resetting data. Legacy replay fails explicitly. Seventy-six actual DynamoDB and
separate-process cases pass on Node 20.0.0 and 25.9.0. The full default inventory
passes 131 suites / 1,557 tests (10 suites / 119 tests remain opt-in/skipped);
13 API boundary and 28 client cases pass. Packed client/type checks pass and
Node20/Node25 plus main/worktree artifact hashes match. Owned resources were removed.
Evidence: [subscription-verification.json](chassis/subscription-verification.json).

The three-improvement goal remains unfinished. **C9** must adopt the owner
artifacts, add mandatory live readiness/schema/pipeline checks and prove the
outbox → MQ → durable result → realtime projection path across restart. Source
inspection and the optimized C9 order are recorded in the implementation plan.
Production profiles remain gated; no shared data migration or cloud deploy ran.

## C9 host adoption and durable result — 2026-10-26

Local C9 acceptance passed. Evidence:
[c9-durable-result-verification.json](chassis/c9-durable-result-verification.json).

- **Catalog 0.10.0** (`b758fb7`) installs MQ 0.5.0 through its Git prepare build;
  the lock integrity equals the verified packed MQ artifact. Explicit queue-owned
  subscription handles are forwarded on receive; a stale or removed handle ends
  intake with a typed error and never falls back or re-creates anything.
- **platform-api** (`8a0be3f`) adopts catalog 0.10.0 and service-runtime 0.5.1.
  `PLATFORM_RUNTIME_PROFILE=durable` validates providers before startup (exit 2)
  and makes outbox, catalog, consumers, pipelines, scheduler and work-graph
  mandatory `feature:*` health checks; readiness drops first on shutdown.
- **AgentCore middleware** (`91ae19aa`): `ORGIQ_RUNTIME_PROFILE=durable` makes
  Aurora, credentials, the C7 claim columns and the queue mandatory (503 with the
  dependency named); `/livez` is process-only. Default behaviour is unchanged.
  Not run against live Aurora: credentials are still invalid.
- **realtime-examples** `acceptance.py --durable-result` ran platform-api's real
  work-graph path on DynamoDB Local and the `ddb-v2` broker three times, the last
  with the broker as `durable-single` in production mode. Across broker, consumer
  and store SIGKILL, redelivery of committed results and a stale completion:
  10 business events, 10 event markers, contiguous revisions 1–10, no pending
  outbox rows, a projection event per revision and the Redis signal.
- The harness found five defects, all fixed and pushed: the MQ image build, the
  14-day `ddb-v2` retention cap, drainer rows marked FAILED during broker
  outages, a consumer-created queue conflicting with producers, and consumers
  never started after a background catalog reconnect.
- **MQ 0.5.2** enables `durable-single` for `ddb-v2`. Still unsupported:
  `durable-replicated`, legacy-store migration, managed-nosql-store as a
  transactional datastore, gateway WebSocket delivery, AWS and capacity.

## C9 WebSocket leg and replicated brokers — 2026-10-27

Evidence: the `2026-10-27-websocket-and-replicated` run in
[c9-durable-result-verification.json](chassis/c9-durable-result-verification.json).

- **WebSocket leg.** The durable-result matrix now runs the gateway and a
  reader in its own container: a snapshot over platform-api's HTTP route, then
  the gateway stream from its signed cursor. Across broker, consumer, store and
  gateway SIGKILL its watermarks form one contiguous chain to the final
  revision, with no resets; in steady state it catches up 0.1 s after the
  commit, so the Redis signal, not the 30 s safety poll, drives it.
- **Defect found and fixed (platform-api `e0be5e0`).** An empty day lists no
  sources, and the authorization revision's base hashed source health, so a
  day's first activity moved the base and the replay answered `policyChanged`:
  a reader that opened on an empty day was revoked by its own first event. The
  base now hashes only sources that are not `available`; an unavailable source
  still moves it. Full suite 451 suites / 6,356 tests.
- **message-queue 0.5.3** (`8736e3c`, tag `v0.5.3`) declares `shared-delivery`
  for `ddb-v2`, enabling `durable-replicated`. `MQ_REPLICAS=2` ran two brokers
  behind one service name; each was SIGKILLed in turn while the survivor
  finished the accepted events, projections and the reader's revisions, and
  both served receives. Run on the candidate and again on the tagged image:
  16 events, 16 results, contiguous revisions, no pending outbox rows.
- Still open: AgentCore's durable profile on live Aurora (credentials),
  legacy-to-`ddb-v2` data migration, managed-nosql-store as a transactional
  datastore, a durable consumer for `work-graph.projection.changed.v1`, browser
  rendering of the stream, and AWS/capacity.
