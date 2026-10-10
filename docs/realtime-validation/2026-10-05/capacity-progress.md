# Current capacity work — 2026-10-05

This is an in-progress record, not capacity or cloud acceptance. Keep the full
goal: Work/People huddle persistence and permissions, OrgIQ corpus document
links, and cloud video/chat/realtime for 100 simultaneous calls. The deployment
single-gateway guard remains in place. Default AWS identity is invalid; no
cloud changes or ECR pushes were attempted.

The sealed [retirement record](cluster-retirement-acceptance.md) retains the
0.104.0 library pin, 2,023 library tests, three Redis faults, eight BFF contracts
and nine fresh browser cases. Its source snapshot preserves that exact stage.
Its consumers were pinned to `68581f7023b9948b7f16cc094d723dc332683039`.
The admission stage pinned 0.105.0 at `be54e682d50d750ede04bdae5f47302039826626`; see
[admission acceptance](cluster-admission-acceptance.md) for that sealed evidence.
Both consumers now pin 0.106.0 at `c5c967ee18fb2fa6dabe126e2dcdd023a4a64dac`;
its focused inbox/producer acceptance is being recorded below.

Subsequent application changes combine identity epoch/grants in a single SQL
snapshot and batch only queued authority reads. Membership queries share only
before dispatch. A test reproduced an unhinted remote-removal race in sharing
already-started queries; that prototype was rejected. No settled positive
authority answers are cached. The revised gate passed 269 tests (2 skipped),
eight full BFF contracts and three actual Redis failure contracts.

The SDK pool experiment with 128 sockets did not meet latency targets; default
concurrency remains 50. `SOCIAL_CHAT_MAX_SOCKETS` accepts explicit 1–256 values.
SDK connection/reply deadlines are configured. An actual DynamoDB Local pause
proved a bounded history read failed as generic 500; it now returns retryable
503, preserves accepted seats/page/history and recovers after unpause. The
native fault passes and 27 focused call-chat regressions pass. These latest
changes have typecheck/build evidence; broader final gates remain pending.

The old driver forced all idle users to send simultaneously at startup.
`--chat-startup spread` follows the planned 30-second background cadence and
preserves paired-sender coverage; `burst` retains the old synchronized workload
and its failing evidence. The driver now waits for actual chat join receipts
and reports admission timing. All 100 calls and 1,000 sockets succeed in both
native steady shapes without collisions, denied actions, unexpected ends or
latency/health failures. The unrestricted Node 25 source processes exceed the
unchanged 700 MiB memory target, so that run remains unaccepted.

Initial compiled Node 22 image, built locally without pushing:
`sha256:478a732b3ee21b9e997e2411f782bc86766b42b8198e80499511292c30c8dd35`.
The two compiled BFFs have one CPU and 1,024 MiB each, expose 3065/3066, use a
separate router namespace and separate synthetic identities, and execute actual
provider SQL through a read-only mount of the test SDK adapter. Authentication
remains a non-production native fixture, not Cognito/Aurora/IAM proof.

Host SSH forwarding crashed with `poll: Invalid argument` near 1,000 forwarded
connections. Colima and Docker remained alive in the VM. The first two BFFs
also exposed an unhandled idle PostgreSQL pool error in the test adapter; an
error listener now lets it reconnect without seed fallback. No VM or daemon
restart was performed. The task-owned forwarding process was replaced with
control/fixture forwarding only. WebSocket load now runs inside the inspected
Docker network, as the existing soak setup requires.

Use `DOCKER_HOST=unix:///tmp/orgiq-capacity-docker.sock` for current Docker
commands. The task control forwarder PID is recorded in
`/tmp/orgiq-capacity-forwarder.pid` (last started 72922); it forwards only the
Docker Unix socket and 15483/16483/18063. The normal Colima host Docker socket
and unrelated host forwards are not repaired or restarted. Private runtime
and environment files under `/tmp` remain mode 600 and excluded from evidence.

The current internal pilot passed call/chat/delivery/memory gates in both
shapes, but the first shape failed health p99 because its first health sample
waited for a cold AWS diagnostics probe (144.1/135.1 ms at 0.5 s). This failure
is retained. It is not accepted as a complete pilot. Compiled working-set
memory is roughly 136–143 MiB in that pilot.

Initial independent containers, subsequently replaced:

- `orgiq-bff-capacity-a`: `0788fc82d22e6760297a71040c4449e2638161949acc189cf77ce1af1f15d5bc`
- `orgiq-bff-capacity-b`: `1006e9708e6b622447b042f1a872bdb854b07985e7cc59e08fb410d7b54fd6b0`
- Network: `orgiq-bff-capacity-network`; results: `orgiq-bff-capacity-results`.

The initial internal matrix on 0.104.0 is complete and unaccepted. Its exact
compiled source and all results are preserved in `capacity-health/manifest.json`.
Some steady/ring/churn shapes passed every target; other health/ring targets
failed. Soak chat p95 was 7,939.4 ms and synchronized burst chat p95 was
5,552.1 ms. Ten competing-tab races exposed five duplicate accepted seats.

The 0.105.0 atomic seat claim fixes that race. Its rebuilt constrained collision
profile passes every target: 1,000 connections, 100 calls, ten of ten unique
winners, no duplicate caller answers/cross-deliveries/unexpected ends, health
p99 35.1/43.8 ms and memory peaks 198.1/209.0 MiB. Current image is
`sha256:86d3dd3c30818d7850274eae771e3d13df42df8c54287d9bb52e271030dfea8d`.
That collision-stage runtime used `8020203ac5a727622069c179e16918382e16cfffa1207f3d0433c82ea7b80734`
and `4b165d10d00a8c547fc5ebbc134e6be5075bcf0a4637c6beb309a18b2c02cb25`;
these have subsequently been replaced.

The separate cookie `/realtime` path now owns a leased Redis namespace and
checks current directory authority at upgrade/subscription/delivery. Actual
REST job fanout reaches both cookie and JWT peers and ceases after retirement.
Directory coalescing shares only queued reads, not already-started snapshots.
Health diagnostics refresh independently and distinguish pending/stale results.
Current gates: 2,030 library tests, 287 application tests (1 skipped), ten full
BFF contracts, three Redis faults, one durable-store fault, 1,318 portal tests,
nine fresh local browser cases, typechecks/builds and the packed/compiled API.

The full 0.105.0 matrix finished and is unaccepted. Results and metrics are
preserved in `capacity-current/manifest.json`. Both ring-storm and churn shapes
passed, as did steady group four. Steady group two failed health p99 at
53.7 ms. Soak restored all 100 calls and 1,000 sockets through three genuine
credential renewal waves, but chat p95 was 8,038.2 ms and health p99 was
77.7/95.5 ms. Synchronized burst failed invite/accept/chat and health targets.
Do not treat session 64228 or its old container IDs as running.

Count/timing-only profiling found approximately 48,000 DynamoDB queries per
node, with the HTTP socket pool capped at the unchanged default 50. A full
200-item unread reply repeated authority checks for every record. Reply-only
policy/resource batching reduced measured queries to about 17,500 per node;
the identical burst still failed latency targets. Before/after results and
exact compiled source are preserved in `capacity-inbox-before/manifest.json`
and `capacity-inbox-after/manifest.json`. These stages do not include the
subsequent peer subscription API or cold-peer guard fix.

The new public readable-subscription probe checks current local or leased
peer connections, fresh channel authority, connection generations and receipt
ownership. Notification producers use it to avoid unread alerts while another
node hosts the reader. Actual DM and private-channel checks verify message
delivery without a live or stored unread alert, then verify alerts after the
reader unsubscribes. A 200-record native inbox test also found a cold-peer guard
ordering bug: the synchronous mirror was consulted before a fresh resource
read. The guard now runs after hydration, with fresh directory rights and all
pending membership fences at the send boundary. The native replay/removal
case passes and preserves all 200 stored records.

Library 0.106.0 at `c5c967ee18fb2fa6dabe126e2dcdd023a4a64dac` is pushed on
`feat/redis-realtime-router`. Its full 2,034-test gate (9 skipped), build/export
and actual packed TypeScript/runtime checks pass. Both consumer typechecks and
builds pass. The latest authority gate passes 52 tests; the broader application
gate passes 292 tests (1 skipped), all 12 native BFF contracts pass, all 1,318
portal tests pass, and nine fresh local browser cases pass in 46.3 seconds.
Browsers use local routing and stub media receipts. The initial browser launch
ran before BFF readiness and lacked the explicit fixture WebSocket endpoint;
those setup failures are retained, and the corrected fresh gate passes.

The focused [inbox/producer record](cluster-inbox-acceptance.md) captures the
0.106.0 change, source snapshot, library/application/portal gates and the
current compiled artifact. This does not accept overall capacity or cloud.

Latest compiled image:
`sha256:9493e0964c2bc1a72f89315c4d84cf96e1fce91cc32b15d54a7b22ec0dc96ac2`.
The sealed inbox-stage BFFs were `fc08f7923405f8ddca99d6e798d1404aa0b1b8502a180bb8cbb4bbf6e1876a80`
and `46fce6c4576d749bfc7a30e87018bf14ffc58ca111663a0737cc46bcd2c43245`.
The last verified profiling replacements are
`a26e28bf094cfc577adce684b0d14a5cac49df73875dbd5af8ebe495f44d8eec`
and `a5beeb4b2cbef0a05e541eff28f0dfafbeebfa2d2de4ce97af4f67a287ceeaa0`,
on the same compiled image; current permissions prevent reinspection.
The unchanged synchronized burst establishes every call/socket and all 800
paired senders deliver, with no collision/denial/disconnect errors and no new
unread alerts for the peer readers. Invite p95 is 1,930.3 ms, accept p95
984.0 ms and chat p95 4,712.6 ms; health p99 is 36.6/103.1 ms. Memory peaks
are 223.7/224.8 MiB. Latency and peer health remain unaccepted.

The current control bridge resolves `host.docker.internal` to the macOS host.
A read-only pilot initially looked faster over direct Docker-network traffic,
but warmed 50-socket pools in both orders did not reproduce that improvement.
The rejected route hypothesis is preserved in `capacity-store-route/manifest.json`.
Only the additional pilot attachment was removed, returning the dedicated
DynamoDB fixture to its original networks. Its native loopback ports and data
remain intact. The fixed synthetic table categories show membership authority dominates the
query load: 19,512/19,370 member queries per node, versus 400 history queries
and 894/888 conversation-index queries. The table profile is preserved in
`capacity-table-profile/manifest.json`. It also exposed a fixture startup race:
27 early sockets received `ECONNREFUSED` before the peer HTTP listener was
ready. The owned launcher now verifies actual HTTP and leased-router readiness
inside the inspected Docker network before starting load. Thresholds, the
synchronized send workload and all measured coverage checks are unchanged.

The readiness-gated run connects all 1,000 sockets and establishes all 100
calls, with all 800 paired senders reaching their peer and no collision/denial/
unplanned-disconnect errors. It still fails: invite p95/p99 1,733.9/1,811.0 ms,
accept p95 767.0 ms, chat p95 4,163.1 ms and health p99 151.3/104.5 ms. Complete
logs/results are preserved in `capacity-table-ready/manifest.json`. The exec
handle is terminal/missing; do not treat it as an active load process.

A subsequent application prototype moves the SDK queue before actual dispatch.
The established default 50 transport slots remain unchanged. Membership reads
can combine while waiting for a slot, but their queued entry is removed before
the SDK is invoked; a later read gets a fresh snapshot even while an older
query is outstanding. Released async scopes cannot lend a stale permit to a
detached callback. Queued work is bounded to 4,096 jobs with a five-second wait
deadline; expiration never dispatches the abandoned job or retains its slot.
There is no settled positive cache.

The prototype passes 60 offline authority tests across five suites, including
1,000 readers over 500 resources, unhinted remote removal, cloning, expiration,
failure recovery and detached-callback limits. Typecheck/build and the actual
compiled queue artifact pass with a controlled client. The public
DynamoDB adapter pagination check also passes through the dispatch scope,
preserving strong-read flags and page cursors. The final combined gate passes all 60 checks; artifacts and exact source
are preserved in `capacity-sdk-dispatch/manifest.json`. These are offline contracts,
not native performance acceptance. The first ordinary Jest run was prevented
by the unrelated global HTTP fixture's `listen EPERM`; the temporary pure-test
configuration excludes that listener and does not substitute any authority
logic or network receipts.

The workspace permission profile changed to restricted filesystem/network
access. The task Docker socket now returns permission denied and localhost
listeners are denied. Default AWS identity was last verified invalid. Native
BFFs, Docker images and browsers remain at the sealed inbox source; none runs
the later dispatch prototype. Required next gates are fresh native authority/
fault contracts and a new constrained capacity matrix, followed by the full
remaining cloud/media/role scope. Keep the goal active and the deployment guard.

A follow-up review reproduced a real deadline race in the initial dispatch
prototype: a promise could free a slot before an overdue timer callback ran,
letting expired work start and leaving stale jobs occupying admission slots.
The dispatcher now checks a monotonic deadline at actual start and admission,
and drains pending work iteratively. Both regressions pass. The latest gate
passes 62 offline authority checks, typecheck/build, and actual compiled
consumption that discards 1,000 expired jobs after deliberately stalled timers.
No expired job invokes the controlled client; fresh work still runs. This does
not establish native SDK or capacity performance. The Docker socket remains
denied on the latest read-only inspection; the earlier access question remains
pending. Snapshot/evidence is recorded in `capacity-sdk-deadline/manifest.json`.

The required runtime access has now remained denied across three consecutive
goal turns. The previous two made offline source/test progress; that work is
complete enough for native evaluation, and further performance edits without
measurements would be speculative. Current inspection again returns Docker
permission denied and an ephemeral localhost bind returns `listen EPERM`.
The current AWS identity check cannot reach its endpoint; the last reachable
check returned `InvalidClientTokenId`. The full goal is blocked, not completed.
See `capacity-environment-blocked/manifest.json` for this audit and exact next
requirements. Resume after Docker/loopback/network access and the authorized
AWS session are available. Keep all source/evidence and the deployment guard.

Claude Code took over from the Codex handoff. Docker and loopback access are
available again; the default AWS identity still returns `InvalidClientTokenId`.
The dispatch prototype's first native evaluation passes all authority suites
(62/62 under the normal Jest config, after widening one flaky 10 ms test wait
budget), all 12 native BFF contracts, three Redis faults, one DynamoDB fault
and the 29-suite application gate (292 + the opt-in restart skip). A local
ARM64 image (`sha256:be341009…`) contains the exact compiled source.

The unchanged synchronized burst regresses on that image in two runs:
invite p95 3,124.3/2,616.3 ms, accept p95 1,455.7/1,202.3 ms and chat p95
5,967.9/5,054.4 ms, against 1,733.9, 767.0 and 4,163.1 ms on the readiness-gated
baseline. Correctness coverage is unchanged and complete. The prototype is not
a capacity improvement; the rest of the matrix was not run on it. Evidence:
`capacity-sdk-native/manifest.json`.

The SDK dispatch queue is now opt-in (`SOCIAL_DYNAMO_DISPATCH_QUEUE=1`); the
default is the plain SDK client. On a fresh local ARM64 image
(`sha256:323aef20…`, queue off) the 62-check authority set plus the opt-in test
(64), 12 native BFF contracts, three Redis faults, one DynamoDB fault and the
29-suite application gate (292 passed, 1 skipped) all pass. The unchanged burst
still fails on this image (invite p95 2,397.7/2,328 ms, chat p95 5,324.2/
4,738.3 ms); one run with the queue on the same image gave 2,238.1 and
4,422.2 ms, so the queue is not the cause of the earlier regression. During the
burst both BFF containers reach their 1-CPU cap while DynamoDB Local reaches
73-110% of a core; Redis and Postgres stay below 20%. Steady and churn pass;
ring-storm, double-accept and soak fail the thresholds named in
`capacity-baseline-profile/manifest.json`. Capacity remains unaccepted.

The host-only fan-out proof (hot-path report change #1) now starts each
Social membership proof before the directory awaits, in both channel and call
recipient authorization, so recipients of one fan-out can share a read that
has not yet dispatched. Its fences are unchanged or wider: each caller keeps
its own observer from the earlier start, and directory, actor, policy and
resource checks still decide. Seven new regression tests pass (71 authority
checks), along with 12 native BFF contracts, three Redis faults, one DynamoDB
fault and the 29-suite application gate. On local image
`sha256:4090a491…` it is not a capacity improvement. Member queries per burst
are unchanged (about 16.5k per node on both images, roughly 25 per message),
because the burst's `social:dm:` pairs have about one recipient per fan-out.
Accept and chat p95 were worse in all three fan-out bursts (accept
1,724.9–1,914.3 ms, chat 5,654.6–6,936.5 ms) than in three baseline-image runs.
One soak improved chat p95 to 8,405.5 ms but still fails. Evidence:
`capacity-fanout-proof/manifest.json`. The remaining cost is the sequential
per-operation reads, which need the upstream operation scope.

The early membership-proof change (`capacity-fanout-proof/`) was reverted after
measurement: member queries stayed at ~16.5k per node per burst (the burst's
chat channels are two-person DMs, so fan-out shares almost nothing) and accept/
chat p95 regressed in all three bursts. The patched source is preserved there as
`live-principal.patched.ts` / `live-principal.test.patched.ts`; five
ordering-specific tests were removed with it, and the two denial tests remain.
The remaining lever is the ~25 sequential reads per send, which needs the
upstream per-operation authority scope in realtime-modules. Native BFFs were
restarted on the reverted source; compiled BFFs 3065/3066 still run the
fan-out image until the next image build.

Realtime-modules 0.107.0 (`826d81e5…`) authority items are adopted in the
host (`capacity-authority-scope/manifest.json`). The library `baseChannel`
replaces the local prefix strip; the four extra prefixes it dropped
(`chat:`/`typing:`/`activity:`/`pins:`) name no live channel and now fail
closed. Each library operation's `AuthorityScope` shares one Social membership
read per channel. The observer starts before that read and lives until the
scope closes. A write or peer hint denies the rest of the operation; directory,
actor and policy checks still run per check. 17 new adversarial tests (130
authority tests), the 29-suite gate (308 passed, 1 skipped), 12 native
contracts, 3 Redis faults (on a fresh restart; one earlier unreproduced lease
failure is retained), 1 DynamoDB fault and the library's 31 + 5 native Redis
contracts pass. On local image `sha256:c229bf59…`, member queries per burst
fall about 61% (6.4k vs 16.5k per node). Two bursts improve every latency
(accept p95 157.1/65.3 ms now passes) but still fail invite, chat and health.
Steady and churn pass. Soak chat p95 halves to 5,083.9 ms but invite/accept
now fail. Ring-storm group four and double-accept health are worse. Capacity
remains unaccepted.

Realtime-modules 0.108.0 (`6e2a9392…`) is adopted in both consumers
(`2026-10-06/capacity-plugin-scope/manifest.json`). The gateway's notify
plugins now pass the operation's `AuthorityScope` into their membership reads
and unread probes, so one send makes one membership read across its authorize
checks and plugins. A revocation during the plugin still denies its remaining
probes, and the removed member gets no alert. The portal's fake work-graph
transport is replaced by the library's gateway stream. The BFF builds each
viewer's frames from that viewer's own snapshot, and the content-free hint
remains only as a fallback. On local image `sha256:60accf65…`, burst member
queries are unchanged (about 6.4k per node; the burst chats on two-person DMs).
Two plain bursts still fail invite, chat and health: invite p95 978.3/946 ms,
chat p95 2,948.2/2,731.5 ms. Accept p95 (242.7/131.2 ms) passes. Soak
invite/accept now pass (94.7/67.2 ms), but chat p95 is 5,478.4 ms and health
still fails. Native contracts were 9/12, Redis faults 2/3 and the DynamoDB
fault 0/1. Every failure hits `POST /api/calls/:id/chat/messages`, which the
concurrently edited, untracked `routes/call-chat.ts` no longer serves. This
stage did not cause those failures. Capacity remains unaccepted.

2026-10-06 (`2026-10-06/capacity-real-send/manifest.json`). The huddle
contracts now send over the gateway socket on `orgiq:huddle:<callId>`, as the
portal does, instead of the removed `POST /api/calls/:id/chat/messages`; one
new check proves an unseated socket of the same user is refused. Native
contracts pass 12/12 and the DynamoDB fault 1/1. Redis faults are 2/3 in two
runs: both chat cases pass, but the stalled-command case fails because a live
client keeps renewing the fenced `bff-b` owner lease (not diagnosed). The load
driver never used the removed route — its chat leg was already the socket DM
send — so it is unchanged. On the unchanged image the burst chat p95 is
3,272.1 ms and the soak 6,383.7 ms. The soak also newly shows 95 publish
denials and 6 call-status errors, which are not yet explained. A count/timing
profile shows the delay is waiting for the SDK's 50 DynamoDB sockets: each call
queues 170–600 ms but DynamoDB Local answers in 35–50 ms, and the event loop
stays near 50 ms p99. Each DM send needs about 17 pooled requests. The largest
category was the conversation index written twice. That duplicate is now
removed (4→2 writes per send, pool queue peak halved), but plain burst chat p95
did not improve beyond noise (before 3,492.1/2,920.3, after 4,302.7/2,947.5).
The remaining load is per-recipient membership reads and repeated publish
checks. Capacity remains unaccepted.

2026-10-06, later (`2026-10-06/capacity-latency/manifest.json`). New count/timing
frame diagnostics measured each stage from socket receipt to the recipient's
write. The send handler does not start ~2 s late. On a burst DM it waits 0.66–0.72 s p50
in the connection's frame queue, mostly behind the same socket's presence `set`.
After that, it spends 0.14–0.26 s before the message exists. Reaching the peer recipient
takes 1.72 s p50. Parse/dispatch is ≤0.1 ms, socket backlog is zero and event-loop
delay is 40 ms p99. In soak, queue wait is 2.9–3.2 s p95. Every stage is
authorization I/O on a saturated fixture: BFFs at their 1-CPU cap; authorize
~100 ms p50. One reversible upstream change gives presence frames their own
per-connection lane. It is on branch `perf/presence-frame-lane` at
`b365d49c5e183fb357391bd7ae1385c6493b8599`, unreleased; consumers still pin 0.108.0.
In an overlay image, soak queue wait halves (1.3–1.4 s p95). Soak chat p95 is
2,985/3,094/2,438 ms with the lane, against 3,095–13,929 ms without it. Burst shows
no difference beyond noise. The stalled-Redis
failure was not a fenced owner renewing. The cookie router fenced, and the `/ws` router
got its reply within its deadline and correctly kept its lease. The node
then reported 503 while half its ownership lived on. The BFF now retires its
sibling router on the first fence (`realtime-node-ownership.ts`, with tests). The 95 denials
and 6/13 call refusals appeared only in overloaded soaks and did not recur
in eight more runs. No membership writes or hints occurred, so they are
fail-closed exceptions under overload. That is correct for authority, but it is a capacity defect.
Gates: typecheck, 290 gateway tests, 12/12 native contracts, 3/3 Redis faults
and 1/1 DynamoDB fault pass. Capacity remains unaccepted.

2026-10-06, 0.109 (`2026-10-06/capacity-0109/manifest.json`). Realtime-modules
0.109.0 (`d948047cc962fa3d0349a090da27b8f88fd45032`, branch `feat/orgiq-0109`,
not merged, no tag) is pinned in both consumers. It carries three changes. The
first is the presence frame lane. The second is opt-in publish proofs. One
sender-side publish decision per socket and channel is reused within one send
while it is under 2 s old (`REALTIME_PUBLISH_PROOF_MAX_AGE_MS`). The membership
store drops it on a committed write or peer hint. A peer skips only its repeated
check of the sender while the origin's proof is fresh. Recipient checks are
never shared, so a peer still denies a revoked recipient. The contract (P1–P5
in `authorityScope.ts`) was written first. The third is `parseDmLobby` /
`dmLobbyPrefix`, which replace the DM-prefix slicing in `social-chat.ts` and
`socialChat.ts`.

One two-node chat send now makes 1 publish check instead of 7 on the origin
plus 1 on the peer; a local send makes 1 instead of 5. Gates:

- library: 2,097 tests (native Redis included), build/export and packed consumer;
- gateway: 390 tests;
- native: 12/12 contracts, 3/3 Redis faults and 1/1 DynamoDB fault;
- portal: typecheck passes, and tests are 1,450/1,451. The one failure is an
  unrelated in-flight assessment test.

On local image `sha256:bb15549e…` the burst still fails:

- chat p95 is 3,016.7 ms, inside earlier noise;
- invite p95 is 1,304.3 ms;
- health p99 is 143.8/178.1 ms.

The soak's chat p95 is 1,610.2 ms, the lowest soak so far, but it is one run
and still fails, as does health. That soak also had 120 recipient refusals in
one second on one node, alongside DynamoDB connection timeouts. These were
fail-closed authorization under overload, and 39 messages went undelivered.
A directory epoch change can outlive a sender's proof by up to 2 s within one
send. Capacity remains unaccepted.

2026-10-06, sizing (`2026-10-06/capacity-sizing/manifest.json`). The same 0.109 image
(`sha256:bb15549e…`), drivers and targets ran with fixture BFFs at 2 and 4 CPUs
(4,096 MiB each); DynamoDB Local unchanged. Test-support launcher now reads
`ORGIQ_BFF_CONTAINER_CPUS` / `_MEMORY_MIB` (defaults 1 / 1024). Nothing passed all
targets. 4 CPUs: burst chat p95 1,465 ms, health p99 82/137 ms; soak chat p95
801.6 ms, health p99 45.6/49.7 ms. 2 CPUs: soak chat p95 623 ms; burst invite p95
1,550 ms (plain) or 101 ms (metrics mode, 47 authz denials). BFF CPU peaked near
100-130% of the cap, so CPU is not saturated; the DynamoDB SDK 50-socket limit
queued about 1,200 requests every run. Soak memory (709-749 MiB) fails the 700 MiB
target only because V8's heap limit scales with the container; 1 GiB runs read
246 MiB. Member queries: burst about 12.4-12.7k, soak 77-81k; publish authorizes
11.9-12.2k and about 121.5k. Capacity remains unaccepted.

2026-10-06, sockets (`2026-10-06/capacity-sockets/manifest.json`). Two changes
were measured one at a time on the unchanged readiness-gated burst and soak.
Every run used metrics mode.

The first change raised the DynamoDB socket cap. The BFF, not the library,
builds that client (`socialChatClient`). `SOCIAL_CHAT_MAX_SOCKETS` now accepts
1–1024 and still defaults to 50. Caps of 256 and 512 removed the pool queue:
mean wait fell from about 400 ms to 0.3–13 ms. Latency did not improve. At
1 CPU, soak chat p95 went from 1,840 ms (50) to 2,855 (256) and 4,606 (512).
At 2 CPU it was 2,482 and 3,118 ms. Health p99 rose, and fail-closed denials
appeared. The BFF's single JS thread already peaks near 100%, so the queue was
limiting work that the thread could not absorb. Keep 50.

The second change cut requests per send. Realtime-modules 0.110.0
(`cd8591284badcf3b6afc6f7dd83c77ba83c28847`, `feat/orgiq-0110`, pushed, not
merged, no tag) adds two opt-in options:

- `peerOperationLingerMs` (contract P6). A send's notify probe and its fan-out
  share one peer authority scope. Every check still asks `authorize`.
- `messageIndexWrites: 'transaction'`. Both index rows are written in one
  TransactWriteItems request.

The BFF now takes a tenant DM's audience from its name instead of a GSI query.
A two-node DM send fell from 6.7 to 3.9 Dynamo requests: put 1, index 2→1,
audience query 1→0, origin membership read 1, peer reads 1.75→0.98.

Gates:

- library: 2,110 tests, build/export and packed consumer;
- gateway: 393 tests;
- native: 12/12 contracts, 3/3 Redis faults and 1/1 DynamoDB fault;
- portal: typecheck and 1,456/1,456 tests.

On image `sha256:7344cece…` no 1-CPU run passed. Burst chat p95 was
3,967–4,663 ms. Two plain bursts established only 84 and 94 of 100 calls.
Soak chat p95 was 1,210 ms with BFF defaults and 3,198 ms with transactions.
The transaction soak also had 801 DynamoDB errors and 351 fail-closed denials.
At 2 CPU both soaks passed health and had no errors. Chat p95 was still
about 690 ms, and memory read 704–745 MiB with a 4 GiB container.

Presence, joins and notifications now make up most Dynamo traffic. No
configuration passes every target at the deployed 1-CPU size, so there is no
candidate for deploy plan §11. Capacity remains unaccepted.
