# Upstream refinement plan — 2026-10-14

Bottom-up plan for the libraries under aws-agentcore: distributed-core →
service-runtime / event-catalog / message-queue → realtime-modules →
platform-api / realtime-examples → consumer pin moves. It is based on a
read-only survey (no installs, no commits, no browser) of the local checkouts
on 2026-10-14. All repos live under `~/Projects`. Ranked by payoff inside each
section. **Opus** = authority, security or concurrency judgement;
**Sonnet** = mechanical. Anything that needs AWS is marked **BLOCKED (cloud)**:
default credentials have been `InvalidClientTokenId` since early October.

## 0. Where things stand

### Dependency graph (who pins what)

| consumer | distributed-core | realtime-modules | service-runtime | event-catalog |
|---|---|---|---|---|
| **distributed-core** HEAD `ad0879c1` | 0.46.5 (clean) | — | — | — |
| service-runtime `7a0e338` (0.4.0) | `b6f38f57` = **0.42.1** (38 commits behind) | — | — | — |
| event-catalog `5911f95` (0.8.4, slalom) | `b6f38f57` = **0.42.1** | — | `7a0e338` | — |
| message-queue `6bcbf6b` (0.2.2, slalom) | `#ad0cec61` **short sha** = 0.46.1 (lock has full sha) | — | `7a0e338` | — |
| realtime-modules `57d8a1b` (0.115.0) | `eb6e4910` = 0.45.6 | — | peer `>=0.2 <1` | dev `bdb8a609` = 0.6.4 |
| platform-api `b72c6b8` (slalom) | `ad0879c1` = 0.46.5 | `988ee39` = **0.92.0** | `7a0e338` | `244286e0` = 0.8.1 |
| realtime-examples `bea2572a` | `52d1bb77` = 0.45.5 | `085580a` = **0.99.3** | `7a0e338` | `5911f95e` = 0.8.4 |
| live-video-streaming `0d4993f` | `b6f38f57` = 0.42.1 | `file:../../realtime-modules` (ui) | — | `474ed44` |
| aws-agentcore middleware | `ad0879c1` = 0.46.5 | tarball 0.115.0 (`57d8a1b`, key `@connorhoehnslalom/…`) | `7a0e338` | — |
| aws-agentcore portal | (via tarball) 0.45.6 | same tarball | — | — |
| aws-agentcore infra | (via realtime-examples) 0.45.5 | (via realtime-examples) 0.99.x | — | — |

Consequences that matter:

- **Three distributed-core copies in the middleware**: 0.46.5 (direct),
  0.45.6 (under realtime-modules), 0.42.1 (under service-runtime)
  (`middleware/node_modules/**/distributed-core/package.json`). Infra has
  four copies (0.45.5, 0.45.6, 0.42.1 ×2), 71 MB, to build three CDK
  constructs. Any `instanceof` or module singleton across copies is wrong
  by construction.
- **Tags stop at v0.99.4 in realtime-modules**; 0.100–0.115 exist only as
  release commits. distributed-core is tagged through v0.46.5.
- **Two orgs**: realtime-modules has `origin` (connorhoehn), `slalom` and a
  duplicate `origin2`; all three are at `57d8a1b` (0/0 divergence). event-catalog,
  message-queue and platform-api live only under connorhoehnslalom but publish
  under the `@connorhoehn/` npm scope.
- **`websocket-gateway` is not a repo.** Its `.git/` holds only `info/exclude`;
  the directory is screenshots and `.playwright-mcp` logs from Sept 1–10. It is
  the old name for realtime-examples, and several READMEs still use that name.
  Deleting it is the user's call.

### Health (run 2026-10-14, read-only, local node_modules, no network)

| repo | typecheck | unit tests | lint |
|---|---|---|---|
| distributed-core | 0 errors (10 s) | 532 suites, **9,611 pass**, 6 skipped (81 s) | 10 errors, 130 warnings |
| realtime-modules | 0 errors (11 s) | 188 suites, **2,143 pass**, 60 skipped (4 suites opt-in Redis), 260 s; `verify:exports` pass (32 subpaths) | no lint script |
| message-queue | 0 errors | 125 suites, **1,500 pass**, 42 skipped (38 s) | 0 errors, 404 warnings |
| service-runtime | 0 errors | 18 suites, **351 pass** (10 s) | 0 errors, 13 warnings |
| platform-api | 0 errors (24 s) | 445 suites, **6,255 pass, 1 FAIL**, 13 skipped (1,140 s): `src/__tests__/route-access-guard.test.ts:96`, see P1 | 3 errors (`require-yield`, `no-control-regex`), 349 warnings |
| realtime-examples | `tsconfig.server.json` 0, `tsconfig.cdk.json` 0; root `tsconfig.json` **553 errors** (e2e/ and cell-router/test: missing DOM lib, `noUncheckedIndexedAccess`) | 318 suites, **4,018 pass, 2 FAIL**, 6 skipped (42 s): `test/services/presence-authoritative-read.test.js:174`, `presence-shadow-write.test.js:122`, see X1 | not run |

No Redis or Docker was running, so every opt-in real-Redis check was skipped.
platform-api's unit run logs `getaddrinfo ENOTFOUND redis` once a second: a
test leaves a reconnecting client alive, which is the same leak shape as its
29-hour OOM.

## 1. distributed-core (bottom of the chain)

**What it is.** It covers cluster membership, gossip and SWIM, Raft, locks
(`DistributedLock` with fencing, `LeasedKVLock` without, `RedisSemaphore`),
`EventBus`, `RedisPubSubManager`, the in-process `messaging-queue`,
`PeerMessaging` request/reply with timeouts, `ResourceRouter`, persistence
(KV, WAL, checkpoint fencer), Merkle replication, CRDT primitives, an HTTP
server with `/ready`, and OTel bootstrap. It also carries application code that
doesn't belong in a distributed-systems core: `applications/document` (Y.Doc
macros), `applications/pipeline` plus the duplicate `./pipeline`
(`PipelineExecutor.ts` is 149 KB), `applications/batch` and `./content`.

**What the chain uses.** About 10 of 21 subpaths. platform-api uses `/applications/pipeline`
(137 files) and the root. message-queue uses `/messaging-queue` (32). realtime-modules
uses the root (7) and `/applications/document` (7). The middleware uses only
`/replication`, `/persistence` and `/crdt-primitives` (distillation), plus one
dynamic root import in a dead file (see C1). **Nobody imports** `./cluster`,
`./cluster/locks`, `./messaging/peer`, `./crdt`, `./gateway`, `./routing`,
`./frontdoor`, `./server`, `./monitoring`, `./control-plane` or `./pipeline`.
The fenced lock, `PeerMessaging`, `ResourceRouter` and `/ready` all exist, but
the realtime stack re-implemented each of them instead of using them.

### D1 — Packaging that consumers can resolve (Sonnet, highest payoff, 0.47.0)
- **Goal:** every subpath types and imports under `node`, `node16` and
  `bundler` resolution; one copy of the package per install.
- **Changes:**
  - Add `typesVersions` for all 21 subpaths. There are none today, and
    `moduleResolution: node` sees every subpath import as untyped. aws-agentcore
    works around this with `paths` in `middleware/tsconfig.test.json` (commit
    `4e2050cd`).
  - Add the missing `import` condition to `./cluster/locks` and
    `./messaging/peer`.
  - Export `RedisPubSubManager` from `./gateway`; it is root-only today (see the
    comment at `middleware/src/lib/realtime-router-distributed.ts:521-525`).
  - Move `@opentelemetry/*`, `lz4` and `zstd-codec` to optional
    `peerDependencies`. The loader already tolerates their absence
    (`src/observability/tracing-bootstrap.ts:185-200`). This lets portal and
    middleware drop their `overrides.distributed-core` OTel pins.
  - Run `verify:dist` in `npm test`. Today it only runs in `prepublishOnly`,
    which git installs never trigger; that gap is how v0.42.0 shipped stale JS.
  - Delete the stray `distributed-core-0.37.2.tgz` from the repo root.
- **Proof:** a new `test/package/packed-consumer.test.ts` that runs `npm pack`,
  extracts into a temp project, and checks that `tsc` resolves every subpath under
  `node`, `node16` and `bundler`, and that `require()` and `import()` both load
  each subpath.
- **Risk:** low. The change is additive to the exports map. Watch that the
  dual ESM/CJS `createRequire` shim (`scripts/postbuild-esm.mjs:102-130`) still
  holds.

### D2 — Fenced lease and bounded Redis, moved down from the realtime work (Opus, 0.48.0)
- **Goal:** one owner-lease primitive with the semantics the cluster acceptance
  proved. Today they exist twice: in `RedisRealtimeRouter.ts:180-262`
  (realtime-modules) and in middleware glue.
- **Changes:**
  - **`FencedLease`**: a unique boot owner with a connection generation;
    `SET NX PX`; renewal at lease/3; bounded renew. Once renewal fails or the
    deadline passes, the lease fences **permanently**, even if a successful
    reply arrives late. Fenced owners are never revived. Exposes `onFence`,
    `isLive()` and `release()`.
    `docs/realtime-validation/2026-10-05/cluster-foundation-acceptance.md:19-23` and
    `cluster-retirement-acceptance.md:3-8,44-48` are the spec. `LeasedKVLock`
    stays as is, documented "no fencing" (`LeasedKVLock.ts:4-12`).
  - **`LeaseGroup`**: the first fence retires sibling owners. This replaces
    `middleware/src/lib/realtime-node-ownership.ts` (`linkNodeOwnership`), which
    fixed the half-fenced node measured on 2026-10-06 (capacity-progress:355-359).
  - **`createBoundedRedis(url, { timeoutMs })`**: commands and publish replies are
    bounded *after* the socket write, where node-redis drops its own timeout, and
    a stalled connection is destroyed. It should satisfy the client shapes that
    `RedisPubSubManager`, `RedisLockProvider`, `RedisSemaphore` and
    realtime-modules' `RealtimeClusterRedis` each want. Source:
    `middleware/src/lib/gateway-redis.ts` (112 lines).
  - **`RedisPeerRegistry`**: heartbeat sorted-set liveness that answers
    alone / peers / *unknown* (Redis unreachable means unknown, never alone).
    Source: `middleware/src/lib/replica-fleet.ts`.
  - **`ReadinessGate`**: composes owners into `/ready`. It is ready only after
    every leased owner is live and the listener is up, and returns 503 the
    moment any owner fences (`cluster-service-acceptance.md:5`,
    `cluster-admission-acceptance.md:46`).
- **Proof:**
  - A fake Redis that can stall after write, drop, or reply late. Port the
    realtime-modules router fault tests and the middleware ownership tests as
    contracts: a late renew reply after the deadline stays fenced; a second live
    owner is refused; a stalled publish is bounded and the socket destroyed;
    sibling retirement happens.
  - Opt-in real-Redis variants (`REDIS_URL`).
- **Risk:** this is concurrency semantics. Every behaviour must be pinned by a
  ported test *before* realtime-modules swaps onto it (R3).

### D3 — Scope diet (Sonnet with an Opus review of the plan, 0.49.0, after D1)
- **Goal:** distributed-core stops being where application code lands.
- **Changes:**
  - Deprecate `./pipeline` (alias of `./applications/pipeline`, kept "for
    back-compat", `src/pipeline.ts:1-6`).
  - Plan the move of `applications/pipeline` to `pipeline-runtime`, which
    platform-api already depends on (1.2.1), and of `applications/document` to
    realtime-modules or its own package. Ship re-export shims for one minor.
  - Close the techdebt items in `realtime-examples/distributed-core-techdebt.md`:
    root vs subpath parity (3.1), version vs tag drift (3.2),
    `MetricsExporter` `.d.ts`/`.js` mismatch (3.4), three Prometheus renderers
    (2.2), and the `PubSubConfig` name clash (1.2).
  - Fix the 10 lint errors.
- **Proof:** the D1 packed-consumer test, plus platform-api's full suite
  against the shimmed build.
- **Risk:** platform-api has 137 files on the pipeline subpath. Do the shims
  first and the move last; the move itself is not required this round.

## 2. Mid-chain libraries that only need a distributed-core bump

### S1 — service-runtime 0.4.1 and event-catalog 0.8.5 (Sonnet, after D1)
- Move both off distributed-core **0.42.1** onto 0.47. This one change removes
  the 0.42.1 copy from every install in the chain (middleware, infra, LVS).
- Fix doc drift: service-runtime's CHANGELOG stops at 0.3.2 although tags
  0.3.3–0.4.0 exist; `ROADMAP.md:4` says "0.3.1"; `ROADMAP.md:269-271` forbids
  cutting 0.4.0 with root re-exports, yet 0.4.0 shipped with them.
- **Proof:** 351 tests green, plus `npm ls distributed-core` in a consumer shows
  one version.

### M1 — message-queue 0.2.3 (Sonnet, after D1)
- Replace `#ad0cec61` with the full 40-character sha at 0.47.
- Fix CLAUDE.md, which says the pin is `8586b330` / 0.40.0 and omits the
  `/replication` import it uses.
- Fix README, whose install line names `connorhoehn/` although the remote is
  connorhoehnslalom.
- **Proof:** 1,500 tests green.
- The open Phase 4.2–4.6 durable-backbone items (multi-process ownership,
  durable delays) are out of scope here; they later become a consumer of D2's
  `FencedLease`.

## 3. realtime-modules (the main payoff)

**State:** 0.115.0 at `57d8a1b` (the "consolidate lineages" merge); both
remotes identical; `dist/` tracked (1,064 files) and in parity with `src/`;
`typesVersions` covers all 32 subpaths and matches `exports`, so it does not
have distributed-core's gap; tests green.

**What it lacks:** tags since 0.99.4, a lint script, a packed-consumer test,
and the server half of several contracts that every host has to write.

The consumer survey found **72 non-test middleware files** importing the library
(`/server` 47, `/chat` 34, `/deck` 32, `/work-graph` 22, `/call` 17, …),
**nine `as unknown as` casts in `realtime-gateway.ts`**, and the hand copies
listed in R2.

### R1 — Release hygiene (Sonnet, 0.115.1, can start now)
- Tag `v0.100.0`…`v0.115.0` on their release commits; record the tag step in
  RELEASE.md as mandatory.
- Add `verify:exports` to `prepublishOnly` and `test`.
- Add the D1-style packed-consumer test, including that the `@connorhoehn/`
  package name resolves when the package is installed under a different key.
- Bump distributed-core to 0.47 (one copy with the middleware).
- Bump the event-catalog dev dependency from 0.6.4 to 0.8.x.
- Delete the `origin2` remote.
- Fix README:11,31, which still say "powers websocket-gateway" (the old name).
- Mark the root `.` barrel deprecated: it mixes React and server code. Also
  deprecate the duplicate server-ws re-exports in `./server`
  (`src/server/index.ts:114-130`, the same set as `src/server-ws/index.ts:10-23`)
  and the second `WorkGraphStreamService` export path.
- Leave `./ingest`, `./server-ws` and `.` unremoved; no external importer was
  found, but they get one deprecation minor first.

### R2 — Authority primitives the host had to write (Opus, 0.116.0, highest product payoff)
Each item below names the consumer code it retires. Behaviour must be
**verdict-identical**: port the 88 facade contracts in
`middleware/src/lib/gateway/__tests__/authority-facade.test.ts` into the
library as table tests before deleting the local copy.

- **`defineChannelFamilies([...]) → { guard, lobbyGuard, familyOf, serviceOf, authorizeLobby(ctx, name, 'read'|'join') }`.**
  The family table stays app data; the mechanism moves. Sources:
  - `middleware/src/lib/tenant-channels.ts:76-110`;
  - `channelService()` re-spells `SERVICE` at `:106`;
  - `lib/gateway/authority.ts:73-178`.

  One exported `authorizeLobby` retires the hand-copied verdicts:
  `lib/call-access.ts:20-22` (`huddleLobbyTenant` regex), `:99`, `:105/:109`,
  `:127`; `lib/call-chat.ts:406`; `routes/agent-loop-create.ts:109-114` (lobby
  read re-derived from `family.lobby` + `holdsChannelAuthority` +
  `pageResourceVisible`); the memo at `routes/page-calls.ts:74`; the second
  `parseDmLobby` at `lib/social-notify.ts:482-487`; and the hand DM parse at
  `lib/gateway/authority.ts:98-101`.

  Also give DM naming one function next to `dmLobbyName`; today it is written
  three times (audit plan :81).
- **`partitionGuard({ tenantsOf })`**: the first segment must be the caller's org
  or one of its tenants, and DM lobbies admit only listed members. This is a
  generic multi-tenant rule. Source: `authority.ts:73-117`.
- **Principal revalidation hook**: `attachRealtime({ principal: { revalidate(ctx, scope), recheckAfterIo: true } })`,
  called at upgrade, on every authorize, recipient and feature hook, and again
  after any I/O. It fences on epoch. Source: `lib/live-principal.ts:50-108,228-231`
  and `realtime-gateway.ts:248`. The directory stays host data; the library
  owns *when* the check runs.
- **`bearerSubprotocolAuth({ verify })` / `tokenFromSubprotocol()`**: the client
  already speaks `bearer-token-v1, <jwt>`, but the server has no parser
  (`lib/realtime-token.ts:129-163`). Verification stays pluggable so
  service-runtime JWT can back it. Also add a typed `RealtimeAuthContext`
  (`lib/gateway/auth.ts:59-73`).
- **Call defaults**:
  - `calls({ verifyCaller: true })`, on by default, because "the library trusts
    callerId on invite" (`lib/gateway/calls.ts:85-100`);
  - `canCall` refuses an empty target list by default; today an empty list fans
    out to everyone;
  - `onCallMissed` carries `targetUserIds` and `channel`, which retires the
    invite ledger at `calls.ts:14-27`.
- **Proof:** the ported facade table shows the same verdict for every row; a
  spoofed `callerId`, an empty target list and an epoch bump mid-I/O are each
  refused; `validate-communication-plane.sh` and `validate-social-tenant.sh`
  stay green after the consumer swap.
- **Risk:** high. These are the tenant boundary and the DM privacy rule. Ship
  behind host-supplied tables and keep the host's guards in place for one
  release, with a parity assertion in dev, before deleting them.

### R3 — Router on the distributed-core lease (Opus, 0.117.0, needs D2)
- Rebuild `RedisRealtimeRouter` (577 lines) on `FencedLease`, `LeaseGroup` and
  `createBoundedRedis`. Accept a `LeaseGroup` so the `/ws` and cookie
  `/realtime` routers fence together; this deletes the consumer's
  `realtime-node-ownership.ts`.
- Add `RedisRealtimeRouter({ membershipStore })`, which does the
  `onCommittedWrite` → `peerEvents` invalidation itself (`realtime-gateway.ts:313-324`).
- **Proof:**
  - The existing router tests plus the 4 opt-in real-Redis checks, run with
    Redis up.
  - The consumer's 3 Redis-fault and 1 Dynamo-fault native contracts; these were
    never re-run on the split tree because of a port collision
    (`docs/realtime-validation/2026-10-08/gateway-split.md:238-248`).
- **Risk:** concurrency. Keep the single-gateway CDK safeguard until two-node
  contracts pass. Multi-replica acceptance is **BLOCKED (cloud)**.

### R4 — Typed seams instead of private casts (Sonnet, 0.116.x)
- Typed `handle.services.chat` and `.notification` accessors.
- `router.liveUsersOn(channel, userIds, { scope })`; today the host reads the
  private `channelMembers` (`notify-plugins.ts:38-72`).
- `handle.stats()` / `onStats`, giving sockets, calls, event-loop p99 and RSS;
  replaces `gateway/stats.ts:42-79`, which reads `activeCalls`.
- `ChatService.appendServerMessage(channel, msg)`, which runs plugins; this
  removes the cast to `addToChannelHistory`/`broadcastMessage` at
  `realtime-gateway.ts:339-351`.
- `parseChatPluginMessage`, which applies the rule that the stamped sender must
  equal the publisher (`notify-plugins.ts:84-100`).
- Raise the default `maxChannelNameLength` from 50, or document 256 for prefixed
  names; the host sets 256 at `realtime-gateway.ts:269,291`.
- **Proof:** the consumer's cast count in `realtime-gateway.ts` goes 9 → 0
  under `tsc --noEmit`.

### R5 — Chat read model and notifications (Sonnet, then Opus review of read admission; 0.117.x)
- `chat({ cursorMode, currentReaders, unread: { notify, itemId } })` owns the
  "new messages" item per cursor holder and clears it on read receipt. Sources:
  `lib/page-thread-unread.ts:44-58`, `notify-plugins.ts:204-234`,
  `realtime-gateway.ts:346-359`; the logic is duplicated today for
  server-side posts.
- `notifications({ replayOnConnect: true })` covers what the comment calls "the
  library leaves replay to the host" (`realtime-gateway.ts:209-210,258-261`).
- **Proof:** reader-cursor tests from 0.115, plus unread items cleared on
  receipt, plus replay on reconnect.

### R6 — Capacity and backpressure (Opus profiling, Sonnet implementation; 0.118.0)
- **Evidence:** at 1 vCPU no profile passes (burst chat p95 3,967–4,663 ms,
  only 84/94 of 100 calls set up); at 2 vCPU chat p95 is about 690 ms
  (`docs/realtime-validation/2026-10-05/capacity-progress.md:447-456`).
  Membership authority dominates: 19,512 member queries per node against 400
  history queries (`:162-164`), even after 0.107 cut them 61%. Health p99
  under burst was 143.8/178.1 ms on 0.109 (`:392`).
- **Changes:**
  - Add a per-socket inbound frame budget, `attachRealtime({ inboundRateLimit })`
    as a token bucket at about 50 fps. One distillation tab sent about 4,600
    frames/s (`ui-components-queue.md:211-224`).
  - Cache authority verdicts per (connection, channel, directory epoch). The
    epoch fence from R2 makes this safe.
  - Batch recipient authorization per fan-out.
  - Expose the work queue depth in `stats()`.
- **Proof:** the local loadgen (`capacity-*` harness) shows member queries per
  send and burst chat p95 at 1 and 2 CPU. Acceptance at the cloud profile is
  **BLOCKED (cloud)**, and the CPU sizing decision is the user's.

### R7 — Upstream client defects and a `/testing` subpath (Sonnet, any time)
- **Client defects** (`ui-components-queue.md:78,180,209`): `GatewayProxyClient`
  calls `fetch` unbound; `archiveRoom` sends a DELETE platform-api doesn't
  serve; `useAgentStream` has no in-flight guard.
- **`/testing`**: a rows-backed chat backend (`createRowsChatBackend`, from
  `middleware/src/lib/social-chat.ts:138,175,340`); a fake `RealtimeClusterRedis`
  with stall injection (shared with D2); and epoch-scoped test identities (the
  idea behind `mock/core/scope.ts` and `mock/identity-clones.ts`; the mock
  fixtures stay in the host).
- Add a lint script.

## 4. Apps on the chain

### P1 — platform-api (Sonnet; the guard and scheduler items are Opus)
- **Red on HEAD, first:** `route-access-guard.test.ts:96` finds two id routes
  with no access middleware and no allowlist entry:
  `POST /api/video/sessions/:sessionId/call-binding` and
  `GET /api/recordings/:recordingId/status`. Both came in with the recent
  recording work (`cbec174` call-binding, `989fabf` status). Either put them behind the access
  middleware or allowlist them with the inline authority check named (Opus:
  this is an authz boundary).
- Bump realtime-modules from **0.92.0** to current; it only uses `/work-graph`,
  `/server` and `/work-graph/server`. Bump distributed-core to 0.47 and
  event-catalog to 0.8.4.
- **Leak:** `6ec1c81` (2026-10-12) fixed the recording-status long-poll that
  leaked subscriptions and timers. The unit suite still leaves a Redis client
  reconnecting every second (see health), so find and close it.
- Run a local 30-hour soak with heap sampling to confirm the 29-hour OOM is
  gone. Confirmation on the deployed media stack is **BLOCKED (cloud)**.
- **ROADMAP P2.1:** the `setInterval` schedule evaluator double-fires with 2
  replicas. Put it behind D2's `FencedLease` or the existing `RedisSemaphore`
  (Opus).
- **P2.2:** the definitions cache polls DynamoDB every 60 s. Make it
  event-invalidated.
- Fix the 3 lint errors.
- Fix CLAUDE.md:23 and ROADMAP:4,21, which still use the websocket-gateway name
  and memory paths.
- **Lobby authority:** the BFF route exists (`routes/realtime-lobby-access.ts`).
  Turning `LOBBY_AUTHORITY_REQUIRED` on in a deployed stack is **BLOCKED (cloud)**.
  When R2 lands, the route should answer from `authorizeLobby`.

### X1 — realtime-examples: split the CDK constructs from the demo app (Sonnet)
- aws-agentcore infra uses only `ApplicationTables`,
  `DocumentWorkspaceServices` and `RedisService` from the committed `dist-cdk/`.
  To get them it installs the whole app: realtime-modules 0.99.3, four
  distributed-core copies and 27 + 71 MB.
- Publish the constructs as a dependency-free package, with `aws-cdk-lib` and
  `constructs` as peers. It can be a `cdk/package.json` workspace or its own
  repo. infra then pins that package.
- **Proof:** `npm ls` in infra shows no distributed-core; `cdk synth` diff is
  empty.
- **Red on HEAD:** two presence tests expect the frame's `userId`
  (`user-B`, `user-1`) but the service records the connection's identity
  (`reader`, `client-1`). Decide which is intended before changing either
  side (Opus: this is the identity-spoofing rule realtime-modules 0.114 fixed
  for cursors).
- **Demo app:** bump realtime-modules from 0.99.3 to current.
- Fix the root `tsconfig.json` 553 errors with an e2e tsconfig that has the DOM
  lib, or by excluding `e2e/` and `cell-router/test`.
- Fix CLAUDE.md:2,91-95 (it lists 0.15.2 / v0.3.3 / 0.3.59) and README:13,23,
  which still say realtime-modules is "upcoming".
- Skip the demo-app bump if the app is retired. That is the user's call; its
  last commit is 2026-09-30.

## 5. Consumer moves in aws-agentcore (last, one PR per release)

### C1 — Now, no upstream release needed (Sonnet)
- Delete `middleware/src/lib/realtime-router-distributed.ts` (539 lines) and its
  test. The only importer is `lib/__tests__/realtime-router-distributed.test.ts`;
  production uses `RedisRealtimeRouter` (`realtime-gateway.ts:161`,
  `distillation-realtime.ts:204`). This also removes the middleware's only
  distributed-core root import.
- Replace `lib/redis-lite.ts`, a 543-line hand RESP client that the file itself
  says to swap, with a node-redis store built on the `gateway-redis.ts` bounded
  connection. Its adapter onto distributed-core lock and pubsub shapes
  (`redis-lite.ts:463-500`) goes with it.
- Remove the deprecated alias `stripServicePrefix = baseChannel` at
  `gateway/authority.ts:191`.
- Fix the social-presence-burst flake: 6 `waitForTimeout` calls should become
  `expect.poll` (audit plan :120).

### C2 — Install under the canonical name (Sonnet, with the next tarball)
- Change the dependency key from `@connorhoehnslalom/realtime-modules` to
  `@connorhoehn/realtime-modules` in both package.json files and both lockfiles,
  and codemod the imports (134 middleware and 62 portal files).
- This deletes the Vite alias (`portal/vite.config.ts:34`) and the four
  `paths` shims in `portal/tsconfig.json:22-25`, which exist only because
  ui-components imports the canonical name.
- Update CLAUDE.md's pin line in the same change.

### C3 — Pin moves, in release order
1. **distributed-core 0.47.0 (D1):**
   - Middleware pin → 0.47 full sha.
   - Delete the `paths` block in `middleware/tsconfig.test.json` (from `4e2050cd`).
   - Drop `overrides.distributed-core` OTel pins in portal and middleware.
   - Check: `npm ls distributed-core` shows one version after S1, M1 and R1;
     middleware jest and typecheck run sequentially.
2. **service-runtime 0.4.1 / event-catalog 0.8.5 (S1):** move the middleware's
   service-runtime sha.
3. **realtime-modules 0.115.1 (R1):** new tarball in `portal/vendor/` with a
   provenance JSON; both lockfiles; clear `portal/node_modules/.vite`; restart
   Vite; `tilt trigger portal`.
4. **realtime-modules 0.116 (R2 + R4):**
   - Swap the gateway facade onto `defineChannelFamilies`, `authorizeLobby` and
     `principal.revalidate`.
   - Delete the hand-copied verdicts listed in R2.
   - Gate: the facade table, the communication-plane, social and access
     validators, and the ui-dom-audit composer policy.
5. **realtime-modules 0.117 (R3 + R5):** delete `realtime-node-ownership.ts`,
   `page-thread-unread.ts` glue and the unread replay; run the native Redis
   fault contracts on free ports.
6. **realtime-examples CDK package (X1):** infra pin moves; `cdk synth` diff
   must be empty. Deploy is **BLOCKED (cloud)**.
7. **realtime-modules 0.118 (R6):** rerun the local capacity harness and write a
   dated `docs/realtime-validation/<date>/capacity-*` record. The cloud profile
   is **BLOCKED (cloud)**.

### C4 — Security follow-up (Opus)
- The callback guards in `lib/service-auth.ts` are static shared-secret headers
  compared in constant time. service-runtime already ships signed envelopes,
  and the middleware uses them for `internal-devbox` and
  `internal-work-graph-compute`.
- Moving the four static-secret callbacks onto `verifyEnvelope` adds replay
  protection.
- This is an ordered two-stack deploy (agent images first;
  `agentcore-preview-surface.md` §6a), so the rollout is **BLOCKED (cloud)**.
  The code and tests are not.

## 6. Parallelism and model assignment

| lane | depends on | model | can run alongside |
|---|---|---|---|
| D1 packaging | — | Sonnet | R1, R7, C1, X1-docs |
| R1 rm hygiene | D1 for the dc bump only | Sonnet | D1, C1 |
| C1 consumer cleanup | — | Sonnet | everything |
| R7 client defects, `/testing` | — | Sonnet | everything |
| S1, M1 | D1 | Sonnet | each other, R2 |
| D2 lease/bounded Redis | D1 | **Opus** | R2, R4 |
| R2 authority primitives | R1 | **Opus** | D2 |
| R4 typed seams | R1 | Sonnet | R2 (different files) |
| D3 scope diet | D1 | Sonnet + Opus review | P1 after shims |
| R3 router on lease | D2, R2 | **Opus** | R5 |
| R5 read model | R2 | Sonnet + Opus review | R3 |
| R6 capacity | R2 (epoch-cached verdicts), R3 | **Opus** profile, Sonnet build | — |
| P1 platform-api | R1, S1 | Sonnet (scheduler: Opus) | X1 |
| X1 CDK split | — | Sonnet | everything |
| C2 canonical key | next tarball | Sonnet | — (touches ~200 import sites; run alone) |
| C3/C4 consumer moves | the release each names | Sonnet (C4 Opus) | one bump at a time |

Rules that carry over: pin by full 40-character sha or tarball, never a
short sha; verify every release against the installed `dist`; batch library
changes so each consumer bump is one install; clear `.vite` after a tarball
move; run the middleware full suite alone; make cross-repo fixes in the owning
repo's own session; never edit `node_modules`.

## 7. Blocked or owed by the user

- **BLOCKED (cloud):** multi-replica acceptance (R3), the cloud capacity
  profile (R6), the platform-api soak on the media stack and the
  lobby-authority flag (P1), the callback-guard rollout (C4), the CDK deploy
  (X1), and every Aurora-side proof.
- **User decisions:** BFF CPU sizing (`middlewareCpu`) or a smaller accepted
  profile; whether realtime-examples' demo app is retired (X1); deleting
  `~/Projects/websocket-gateway`; whether `applications/pipeline` and
  `applications/document` leave distributed-core this round (D3).
