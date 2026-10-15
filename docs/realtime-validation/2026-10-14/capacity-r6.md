# Capacity and backpressure, realtime-modules 0.120.0 — 2026-10-14 (lane R6)

Lane R6 of `docs/upstream-refinement-plan-2026-10-14.md`, goal row U2 of
`docs/upstream-refinement-goal.md`. This is a **local, in-process library
measurement**, not a BFF capacity run and not cloud acceptance.

## Verdict

- **Cloud capacity profile: BLOCKED (cloud).** Nothing was deployed; default
  AWS credentials are still invalid.
- **BFF CPU sizing (`middlewareCpu`): the user's decision, still owed.** This
  record does not change the 2026-10-06 finding that no 1-CPU configuration
  passes every target.
- **2026-10-05 harness rerun: not possible today.** Both modes of
  `middleware/test-support/bff-cluster-capacity.mjs` (native processes and
  CPU-capped containers) `docker inspect` their Postgres/Redis/DynamoDB
  fixtures first, and Docker (Colima) is unreachable on this machine. Colima
  was not started or touched. So there are **no 1-CPU / 2-CPU numbers** in
  this record, and none against real DynamoDB.
- **The BFF does not use the new options yet.** `middleware/` was not edited
  (a later lane adopts 0.120). A `dev:mock` BFF on a spare port would only
  have re-measured the old behaviour, so it was not run.
- What *is* shown: in the library's own fan-out path, with a host
  `authorize` modelled on the BFF's, the verdict cache cuts **member queries
  per send** from 1.40 to 0.40 (DM groups of 4) and from 3.0 to 2.0 (pairs,
  one send each), and burst chat p95 from ~0.94–1.24 s to ~0.35–0.37 s and
  from ~0.82–0.89 s to ~0.59–0.63 s. Whether that survives into the BFF has
  to be measured after adoption, on the container harness, at 1 and 2 CPU.

## What shipped (realtime-modules 0.120.0, `6dcaaee`, tag `v0.120.0` on origin and slalom)

All opt-in; with no new option set, behaviour is unchanged (the
`after-noopts` rows below match `before`).

- `attachRealtime({ inboundRateLimit })` / `createWsHandler({ inboundRateLimit })`:
  per-socket token bucket, default 50 frames/s with a burst of 100. Excess
  frames are dropped before parsing; one `RATE_LIMITED` error frame per window.
- `attachRealtime({ authorityCache: { epoch } })` / `withAuthorityCache`:
  positive verdicts cached per (connection, auth context, kind, channel,
  directory epoch). An epoch change, a membership event
  (`handle.authorityCache.invalidateChannel`, also wired from
  `RedisRealtimeRouter({ membershipStore, authorityCache })`), a principal
  revalidation failure, a replaced context or a disconnect drops the
  connection's entries. Refusals are never cached. Principal revalidation
  still runs on every check, hits included. Contract V1–V7 is in
  `src/server/authority/verdictCache.ts`, and the revocation contracts are in
  `test/server/verdict-cache.test.ts` (23 tests, over real sockets where it
  matters). One of them pins down why membership events are mandatory: a
  membership change with no event and no epoch bump is still served from the
  cache until `maxAgeMs` (default 5 s).
- `attachRealtime({ authorizeBatch })`: one host call per fan-out for every
  recipient, with the per-recipient path as the fallback. It fails closed on a
  malformed answer.
- `stats()`: `queueDepth`, `maxConnectionQueueDepth`, `peakQueueDepth`,
  inbound accepted/dropped counts, event-loop p50/p99/max, verdict-cache
  counters and `RedisRealtimeRouter` queues. These are folded into 0.119's
  `attachRealtime(...).stats()`.

## Method

The harness is `bench/authority-load.cjs` in realtime-modules (not shipped).
The server runs `attachRealtime({ chat(), presence() })` on the built `dist`
in the main thread; the clients run in a worker thread. The host
`authorize` reads the channel's membership on each decision. That read is
one **member query**, modelled as 250 µs of synchronous CPU (SDK
marshal/parse) plus 3 ms of I/O. Like the BFF, it shares the read per
operation through `scope.share`, and principal revalidation is on.

Profile A has 400 sockets in DM groups of 4; each socket sends 5 chat
messages at once plus one presence set. Profile B has 1,000 sockets in pairs,
each sending one message plus one presence set (shaped like the 2026-10-05
`burst` profile). Profile F is profile A plus one socket flooding presence
frames at about 4,600 frames/s (the distillation-tab rate in
`ui-components-queue.md`). Latency runs from send to receipt at every other
group member. "before" is the 0.119.0 `dist` from origin/main (`d9e3c7c`);
"after" is the 0.120.0 build. There were two runs per row, on Node 25.9.0 on
a shared 16-core Mac with load average 14–29 throughout, so absolute
milliseconds are noisy. CPU cannot be capped in-process.

### Profile first (`node --cpu-prof`, profile A, query CPU set to 0)

Library-owned self time was small: socket writes about 5%, principal
wrapper, scope `share` and handler bookkeeping each under 1%. The burst was
not bound by library code. Per send the host was asked `authorize` 10 times
and `revalidate` 25.8 times, and made 1.4 member queries after
per-operation sharing. With the 250 µs query cost, p95 rose from 208 ms to
about 900 ms. So host authority work per send sets burst latency, which is
the same shape the 2026-10-05 table profile found in the BFF (19,512 member
queries per node against 400 history queries).

## Results

Member queries per send (lower is better), host `authorize` calls per send, and burst chat latency (ms):

| row | member queries per send | authorize / send | chat p50 | chat p95 | server CPU (ms) |
|---|---|---|---|---|---|
| A before (0.119) | 1.40 / 1.40 | 10 | 890 / 686 | **1,241 / 942** | 1,411 / 1,273 |
| A after, no options | 1.40 / 1.40 | 10 | 706 / 695 | 942 / 1,040 | 1,281 / 1,375 |
| A after, `authorityCache` | **0.40 / 0.40** | 0.4 | 294 / 290 | **365 / 349** | 563 / 547 |
| A after, `authorizeBatch` | 1.40 / 1.40 | 5.4 (+1.2 batch) | 746 / 740 | 959 / 948 | 1,165 / 1,156 |
| A after, cache + batch | 0.40 / 0.40 | 0.4 | 294 / 294 | 362 / 356 | 579 / 538 |
| B before (0.119) | 3.00 / 3.00 | 10 | 712 / 445 | **851 / 888** | 1,037 / 999 |
| B after, no options | 3.00 / 3.00 | 10 | 687 / 693 | 823 / 826 | 990 / 1,019 |
| B after, `authorityCache` | **2.00 / 2.00** | 2 | 564 / 569 | **590 / 597** | 707 / 729 |
| B after, `authorizeBatch` | 3.00 / 3.00 | 7 (+2 batch) | 690 / 689 | 826 / 824 | 1,014 / 1,029 |
| B after, cache + batch | 2.00 / 2.00 | 2 | 596 / 564 | 632 / 593 | 754 / 736 |

Every row delivered every expected message (6,000 of 6,000 for A, 1,000 of
1,000 for B).

Flood (profile F):

| row | inbound dropped | peak queue depth | chat p95 |
|---|---|---|---|
| before (0.119) | 0 | not reported | 867 / 893 |
| after, `inboundRateLimit` default | 3,961 / 3,916 | 2,480 / 2,444 (vs ~4,500 without the budget, earlier run) | 908 / 880 |

## Reading the numbers

- **The verdict cache is the change that moves both measures.** It removes
  the repeat authority work of a socket that keeps sending to a channel it
  already proved: the sender's publish check, the recipients' subscribe
  rechecks and presence. Profile B gains less than A because each socket
  sends once, so the first publish check is always a miss.
- **Batching alone moved neither measure in this model.** It halves host
  `authorize` calls, but this host already shares the membership read per
  operation, which is how the BFF is written. It only pays for a host whose
  per-call cost does not share (policy evaluation per recipient) or that
  answers N recipients in one query. That is unmeasured here.
- **The inbound budget does not change other sockets' p95 here,** because a
  connection's frames already run on that connection's own serial lane. What
  it removes is the flooding socket's backlog: about 3,900 frames per second
  are never parsed, queued or authorized, and the peak queue depth roughly
  halves.
- **Principal revalidations are unchanged (25.8 per send).** They are the
  revocation fence and stay on every check by design. If the BFF's
  `getLivePrincipal` is not an in-memory read, it is the next cost to look at.
- **Limits.** This is a single process with no Redis peer hop and no
  DynamoDB. The query cost is modelled, not measured. There is no CPU cap and
  the host was heavily loaded. Health p99, memory, call setup and the 2-node
  path are not measured.

## To close U2 for real (owed)

1. Adopt 0.120 in the BFF. Pass `authorityCache.epoch` from the live
   directory mirror's session epoch, wire `membershipStore` +
   `authorityCache` on the Redis router, and set `inboundRateLimit: true`.
2. Rerun `bff-cluster-capacity.mjs burst` and `soak` in container mode at
   `ORGIQ_BFF_CONTAINER_CPUS=1` and `2` once Docker is reachable, with
   metrics mode for member queries per send.
3. The cloud profile and the `middlewareCpu` decision stay with the user.
