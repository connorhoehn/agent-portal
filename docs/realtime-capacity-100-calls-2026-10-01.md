# Realtime capacity and collision review: 100 simultaneous calls (2026-10-01)

The owner's requirement: *"I want to make sure the video and chat and real
time components scale in the cloud to up to 100 calls simultaneous without
collision or pressure."*

Current status after integration (2026-10-01 13:40 local): the Redis,
single-gateway, reconnect and worker-placement fixes are implemented and
pinned. The original findings below describe the review's starting state;
the latest release and churn results are recorded at the end. AWS media
capacity has not been measured.

**Short answer: not yet, and the reasons are mostly not about size.** As coded
and as the CDK would deploy it today, the stack cannot reliably carry even a
handful of calls. Three of the problems are correctness defects that a bigger
instance would not fix:

- The SFU has no Redis, so one call splits into several SFU sessions.
- The middleware is allowed to autoscale to four tasks, which breaks its
  single-process router.
- A gateway socket reconnect ends every 1:1 call 30 seconds later.

Two more are hard ceilings:

- Every media transport lands on mediasoup worker 0, so the SFU uses one CPU
  core however large the host is.
- That core is a burstable `t4g.small`.

Once those are fixed, case (a) below fits one `c7g.2xlarge`-class SFU. Case
(b) fits one `c7g.4xlarge`-class SFU *after* the upstream worker-placement
fix. At that point the dominant cost is data-transfer egress, not compute.

Research only: no AWS calls were made, nothing was deployed or load-tested,
and no other file was edited.

## Evidence labels and scope

Every claim about code carries one of three labels:

- **[V]** verified in code, at the cited `file:line`.
- **[I]** inferred from code I read but did not run.
- **[M]** from memory: AWS list prices, instance specs, mediasoup's published
  guidance. I fetched none of these today, so treat the numbers as estimates
  to re-check.

Repo abbreviations:

- `rm/` is the installed realtime-modules 0.99.3 dist, at
  `middleware/node_modules/@connorhoehnslalom/realtime-modules/dist/`. The
  portal's copy is identical in shape.
- `lvs/` is `~/projects/live-video-streaming`. Its installed mediasoup is
  3.20.5.
- `papi/` is `~/projects/platform-api/src`.
- Unprefixed paths are in this repo.

## Workload assumption

- **Calls.** Each call is browser-to-SFU over WHIP/WHEP with camera and
  microphone. Capture is 640×480 at 24 fps, single layer, no simulcast
  (`rm/client/video/useLVSHangout.js:52-54` [V]; no `sendEncodings` anywhere in
  `client/video` [V]). I assume about 600 kbps per video stream plus about
  40 kbps per audio stream [I].
- **Transports.** Each remote participant is subscribed through its **own**
  WHEP peer connection, so it gets its own SFU transport
  (`useLVSHangout.js:740`, one `RTCPeerConnection` per remote `fullPid` [V]).
- **Background traffic.** About 1,000 connected users each hold one gateway
  socket. Each sends a presence heartbeat every 30 s
  (`rm/presence/PresenceService.js:36-40` [V]) and answers a server ping every
  30 s (`middleware/src/lib/realtime-gateway.ts:539` [V]). I also assume about
  one chat message per user every 30 s while active [I].

| | (a) 100 × 1:1 | (b) 100 × 4-way |
|---|---|---|
| Participants | 200 | 400 |
| Producers (audio + video) | 400 | 800 |
| Consumers (audio + video) | 400 | 2,400 (1,200 video) |
| SFU WebRTC transports (1 WHIP + N−1 WHEP each) | 400 | 1,600 |
| SFU egress (≈0.64 Mbps per consumer pair) | ≈130 Mbps | ≈780 Mbps |
| SFU ingress | ≈130 Mbps | ≈260 Mbps |
| Gateway sockets | 1,000 | 1,000 |
| Gateway frames/s, steady (ping + presence + chat) | ≈100 | ≈100 |
| Gateway frames, call-setup burst (invite/ringing/accept/status per participant) | ≈1,000 over a few s | ≈2,000 over a few s |

## 1. SFU / media (live-video-streaming on EC2)

**First bottleneck: one CPU core, then the host.** Worker 0 takes every
transport.

- The worker pool spawns `MEDIASOUP_WORKERS` workers. Each has one router and
  one `WebRtcServer` (`lvs/src/managers/WorkerPool.js:95, 222, 289` [V]).
- But the app takes worker 0 as "the" router and WebRtcServer
  (`lvs/src/app.js:310-317` [V]). The `TransportManager` is built on that one
  router (`app.js:566-569` [V]). The comment there names the follow-up
  ("hub#1253 … `workerPool.getNextWorker()`").
- `getNextWorker()` exists (`WorkerPool.js:362-417` [V]) but nothing outside
  `WorkerPool.js` calls it [V]. `RouterManager` is given only worker 0
  (`app.js:583-589` [V]).

The consequence is that the SFU is single-core whatever the instance size, and
`MEDIASOUP_WORKERS=2` buys an idle second worker.

- **Capacity of one worker.** mediasoup's documentation says one worker
  handles roughly 500 consumers, depending on the host [M].
  - Case (a): 400 consumers sit at that ceiling on one core.
  - Case (b): 2,400 consumers is about five times over.
  - One transport per WHEP subscriber adds DTLS/SRTP and ICE work per
    transport on top of the per-consumer cost [I]. Treat 500 as optimistic.
- **Host.** `t4g.small` has 2 burstable vCPUs (`infra/lib/social-media-stack.ts:272`
  [V]). Its sustained baseline is about 20% per vCPU, and it has a network
  baseline of about 0.128 Gbps with burst credits [M].
  - Case (a) needs about 0.26 Gbps of combined traffic and a full core
    sustained.
  - Both exhaust credits in minutes. Once they do, the instance throttles: CPU
    drops to baseline, packets drop, video freezes and audio garbles across
    **all** calls at once [I].

**Port collision and exhaustion: none at 100 calls.**

- With `WebRtcServer`, worker N binds UDP `base+N` and TCP `tcpBase+N`, and
  every transport on that worker multiplexes over those ports
  (`WorkerPool.js:228-257` [V]; `TransportManager.js:402-403` [V]).
- The stack sets `MEDIASOUP_WORKERS=2`, UDP base 40000, TCP base 40010 and
  `MEDIASOUP_RTC_TCP_PORT_PER_POD=false` (`social-media-stack.ts:206-209` [V]).
  That yields exactly UDP 40000-40001 and TCP 40010-40011, matching the
  security group (`:145, :149` [V]).
- Port count does not limit transport count.

**The real risk is a mismatch between worker count and open ports.** If
`MEDIASOUP_WORKERS` is raised, or left unset (it defaults to the CPU count,
`WorkerPool.js:95` [V]), the extra workers bind ports the security group does
not open. ICE then fails only for calls placed on those workers [I]. Once
worker placement is fixed, the security-group range must be derived from the
worker count.

**Software caps that 100 calls would hit:**

- **`MAX_TRANSPORTS_PER_POD`**, default 1000. The SFU warns at 80% and refuses
  at 100% (`lvs/src/managers/TransportManager.js:34-38` [V]). Case (b) needs
  1,600. **Blocker for (b).**
- **`MAX_CONCURRENT_STREAMS`**, default 50 per quota account
  (`lvs/src/services/quotaEnforcer.js:9` [V]).
  - It is checked on every WHIP publish (`lvs/src/api/channels/index.js:997`
    [V]) and incremented once per publisher (`:426` [V]).
  - Enforcement needs the SFU's Redis (`quotaEnforcer.js:226` [V]), so today
    it is inert. The moment the Redis blocker below is fixed, the 51st
    publisher gets 429.
  - The account resolves from the channel's `accountId`, then the token, then
    `'default'` (`lvs/src/middleware/quotaMiddleware.js:19-28` [V]). Whether
    platform-api sets a per-tenant account I did not check [I]; assume
    everyone is `'default'`. **Blocker once Redis is on.**
- **`ADMISSION_GATE_CAPACITY`**, default 100 in-flight WHIP/WHEP negotiations
  (`app.js:604` [V]). A ring storm in case (b) is about 1,600 negotiations in
  seconds. Whether excess requests queue or are refused I did not trace [I].
  Raise it to 400 and measure.
- **Rate limits.** WHIP is 30/min and WHEP 60/min per `arn+memberId` in the
  production profile (`lvs/src/middleware/rateLimitProfiles/profiles.js:32-41`
  [V]). These are per participant, so they are not a 100-call problem.

**Second node: no routing exists on the platform-api side.**

- platform-api has a single `VIDEO_API_URL` (`papi/lib/video-auth.ts:14` [V]).
  Every SFU call goes to `${VIDEO_API_URL}/api/sessions…`
  (`papi/routes/videoSessions.ts:368` [V]), and the stack points it at one
  private IP (`infra/lib/social-stack.ts:424` [V, per research pass]).
- LVS itself is cluster-aware: Redis channel-ownership leases, proxying to the
  owner pod, PipeTransports between pods (`lvs/src/api/channels/index.js:157-204`;
  `lvs/src/cluster/*` [V, per research pass]).
- The CDK runs it with `CLUSTER_ENABLED=false` (`social-media-stack.ts:204`
  [V]), and each node announces its own EIP.
- A second node therefore needs both LVS clustering turned on (shared Redis,
  seed nodes, mesh IPs) **and** a front door that sends a session's WHIP/WHEP
  to the owner or lets LVS proxy it.

That is real work. Scale up, not out, for 100 calls.

**Announced IP: correct for one host.** The EIP is allocated first and written
into `MEDIASOUP_ANNOUNCED_IP`/`_TCP` (`social-media-stack.ts:184-188, 210-211`
[V]). The container runs `--network host`, so the bound port is the announced
port (`:247` [V]).

**Who can send media.** Ingress is an explicit allowlist, `sfuAllowCidr`
(`social-media-stack.ts:138-158` [V]), because the account's custodian revokes
`0.0.0.0/0`.

- With 100 calls of real users on home or corporate networks, the allowlist
  cannot be maintained. **Any participant not on it gets no media.** The ALB
  allowlist has the same limit, though CloudFront relieves it for HTTP.
- This is the deployment blocker that sizing cannot touch. It needs either a
  custodian exception scoped to the SFU security group or a TURN relay whose
  ranges are allowlisted. That is owner/account work
  (`docs/social-calls-deploy-plan.md` §3).

**No TURN.**

- `/api/ice-servers` mints coturn credentials only when `LVS_TURN_URL` is set
  (`lvs/src/api/ice-servers.js:12-30` [V]). The stack does not set it.
- mediasoup's ICE-TCP candidate on 40010/40011 is on by default
  (`TransportManager.js:219-229` [V]), which rescues networks that block UDP
  but allow high TCP ports.
- Networks that allow only 443, which is common for corporate egress and
  guest Wi-Fi, fail outright. Industry experience is that roughly 5-15% of
  enterprise users need TURN over TLS on 443 [M].

**Bitrate.**

- Server-side settings are `maxIncomingBitrate` 5 Mbps and
  `initialAvailableOutgoingBitrate` 2.5 Mbps (`lvs/src/app.js:230-234` [V]).
- LVS can parse simulcast and switch layers (`lvs/src/whip/sdpUtils.js:180-192`
  [V]), but the client does not publish simulcast [V, above].
- So every subscriber gets the same single 640×480 layer. That is fine for
  2×2 grids and wasteful for thumbnails.

**Health and restart: a deploy or crash drops every call.**

- **Process crash.** The systemd unit has `Restart=always`
  (`social-media-stack.ts:257-259` [V]). Participant-token keys are ephemeral
  (`:194-196` comment [V]), so a restart invalidates every outstanding
  participant token and every transport.
- **Deploy.** `userDataCausesReplacement: true` (`:280` [V]) makes any image or
  env change a **new instance**. Every call drops for the minutes the new host
  takes to boot and pull.
- **Worker death.** mediasoup restarts the dead worker, but the `TransportManager`
  keeps the dead router reference: only `app.restartWorker()` refreshes it,
  and nothing calls that (`lvs/src/app.js:431, 447` [V, per research pass]).
  If worker 0 dies, new calls probably fail until the process restarts [I].
- **Health checks.** There is no health-based replacement. The ALB target on
  :3901 health-checks HTTP, but nothing restarts the instance on failure [I].

**Smallest changes:**

- **Upstream (LVS).** Place each room on a worker via `getNextWorker()` with
  one router per room. Room-affine placement means no `pipeToRouter` is needed
  within a room. Refresh the router reference on worker restart.
- **In this repo.**
  - Set `sfuInstanceType` (default `t4g.small`) and `sfuWorkers` (default 2)
    as context.
  - Derive `SFU_PORTS` and the security-group ranges from `sfuWorkers`.
  - Set `MAX_TRANSPORTS_PER_POD`, `MAX_CONCURRENT_STREAMS=0` (unlimited) and
    `ADMISSION_GATE_CAPACITY` in the env list (`social-media-stack.ts:200-220`).

## 2. Signalling gateway (middleware `/ws`)

**What it is.** The gateway is `attachRealtime` with chat, presence, calls and
notifications on the BFF's own HTTP server
(`middleware/src/lib/realtime-gateway.ts:536-573` [V]). The router is the
library's `LocalRealtimeRouter`, chosen whenever no `router` is passed
(`rm/server/attach.js:313-316` [V]).

**Carrying capacity on one task is not the problem** [I]:

- 1,000 sockets is small for `ws`: tens of KB each, roughly 50-100 MB.
- About 100 steady frames/s, with peaks around 1,000/s during call setup, is
  well within one Node event loop.
- The task is `cpu: 512` / `memoryLimitMiB: 1024`
  (`infra/lib/middleware-service-stack.ts:949-950` [V]), which is half a vCPU.
  It shares that half core with REST, agent SSE streaming, the CloudWatch
  trace poller (`OBS_USE_LEGACY_POLLER` defaults on), the bot scheduler and
  the distillation consumer (`middleware/src/index.ts:500-515` [V]). Any of
  those blocking the loop for 100+ ms delays ring and accept frames for
  everyone [I].

**Raise it to 1 vCPU / 2 GB.** Node only needs one core, but Fargate's 512
gives it half of one.

**What is in process and what is in Redis:**

| State | Where | Evidence |
|---|---|---|
| Channel subscriptions and frame fan-out | process (`LocalRealtimeRouter` Maps) | `rm/server/router.js:16-19, 40-50, 76-138` [V] |
| Who to ring (`getClientsByUserId`) | process, local sockets only | `rm/call/CallService.js:2058-2080` [V] |
| Call records, participants, accepted flags | process Maps; Redis mirror when `REDIS_URL` (`RedisCallStateStore`), mostly fire-and-forget | `CallService.js:120-139, 572`; `realtime-gateway.ts:520` [V] |
| Presence rosters | process only, no Redis option | `rm/presence/PresenceService.js:121-123` [V] |
| Chat recent-message caches | process LRU, 100 per channel | `rm/chat/ChatService.js:59, 874-883` [V] |
| Chat messages, members, reads | DynamoDB when `SOCIAL_CHAT_STORE=dynamo` | `realtime-gateway.ts:380-444` [V] |
| `social:ch:` membership (used by the synchronous guard) | process mirror, hydrated **only at boot** | `middleware/src/lib/social-chat.ts:155-205`; `realtime-gateway.ts:412-421` [V] |
| Invite→targets map for missed-call notices | process Map | `realtime-gateway.ts:447-456` [V] |
| Notification inbox | Redis (`notif:list:<uid>`) when `REDIS_URL` | `realtime-gateway.ts:521`; `rm/.../RedisNotificationStore.js:38-80` [V] |

**What breaks with two or more tasks:**

- A ring from a socket on task A never reaches the callee's socket on task B,
  because `getClientsByUserId` is local. The caller hears ringing and nobody's
  phone rings.
- Chat published on A is not delivered to B's subscribers.
- Presence rosters split into per-task halves.
- First-accept-wins is decided against the local Map plus a Redis snapshot
  whose writes are `void`-ed, so it is not atomic across tasks
  (`CallService.js:1607, 1633-1673, 1811-1814` [V]).
- A channel membership added on A is invisible to B's guard until B restarts,
  so B refuses the new member.
- Missed-call notices lose their targets.

This is a **collision-class** failure, not a capacity one.

**And the CDK allows exactly this today:**

- `autoScaleTaskCount({ minCapacity: 1, maxCapacity: 4 })`, scaling on CPU
  70% and memory 80% (`middleware-service-stack.ts:1222-1235` [V]). On half a
  vCPU, a busy morning crosses 70% and adds a second task.
- `maxHealthyPercent: 200` (`:1027` [V]) means every deploy runs old and new
  tasks side by side. New sockets land on the new task while old ones stay on
  the old one, so rings across them fail until the old task drains. The ALB's
  default deregistration delay is 300 s [M].
- The comment at `:1205-1207` says "cross-task fan-out goes over Redis
  pub/sub". **That is false for this gateway.** It describes realtime-examples'
  gateway, not the middleware. Compare `realtime-gateway.ts:42-46`, which says
  one task, and the deploy plan, which says "keep the middleware at ONE task"
  (`docs/social-calls-deploy-plan.md:653`).

**Is there a cross-process fan-out to turn on? No.**

- The only Redis pub/sub hook in the dist is `CallService`'s
  `crossNodePubSub`, which relays client-departed notices only
  (`CallService.js:52, 140, 274-286` [V]).
- The `calls()` factory does not forward it, and it also drops
  `sweeperIsLeader`, `metaStore`, `onOfflineInvite` and `isClientAlive`
  (`rm/server/attach.js:169-211` [V]).
- No `redisPubSub`, `createClient`, cluster adapter or Redis-backed router
  ships [V].
- `attachRealtime({ router })` accepts a custom router. That is the
  extension point, and someone has to write it upstream.

**ALB.**

- Idle timeout is 300 s (`:1198` [V]) against a 30 s ping, which is fine.
- Stickiness is off (`:1208` [V]). That is moot at one task and wrong at two.
- The HTTP/1 target is pinned (`:1204` [V]).
- The ALB has no meaningful connection limit at this scale [M].
- CloudFront carries `/ws` (`infra/lib/portal-stack.ts:74` [V]) with a 60 s
  read/keepalive (`:180-181` [V]). The 30 s ping keeps that alive [I].

**Rate limits.**

- The middleware's limiter is per-IP and in-process
  (`middleware/src/lib/rate-limit.ts:24-50` [V]): login 15/min
  (`routes/session.ts:40` [V]) and SSO login 30/min (`routes/auth.ts:34` [V]).
- Behind CloudFront, `TRUST_PROXY_HOPS=2` (`middleware-service-stack.ts:799`
  [V]; `lib/trusted-proxy.ts:11-17` [V]) makes `req.ip` the viewer.
- **If `TRUST_PROXY_HOPS` is ever 1 while CloudFront is in front**, `req.ip`
  becomes a CloudFront edge address. A few edges then serve 1,000 users and
  the 16th login per edge per minute gets 429 [I]. The fix is
  `deployPortal` ⇒ `2`, which is how the code is written now.
- Even with the correct setting, a 1,000-person office behind one NAT gets 429
  on the 16th picker login in a minute [I]. SSO's 30/min helps; consider
  raising both or keying on the user.
- `/ws` upgrades and `/api/session/realtime-token` have no limiter [V], and
  no per-socket frame limiter exists in the library [V, per research pass].

**Payload limit.** The library builds `new WebSocketServer({ noServer: true })`
with no `maxPayload` (`rm/server-ws/createWsHandler.js:58` [V, per research
pass]). ws 8's default is 100 MiB. One authenticated client sending a large
frame can push a 1 GiB task into OOM and end every call and chat socket at
once [I]. Upstream should expose `maxPayload` and set about 256 KB.

**Smallest changes:**

- **Now (CDK).** When `realtimeGateway=true`, pin the service to one task:
  - no `autoScaleTaskCount`, or min = max = 1;
  - `minHealthyPercent: 0` / `maxHealthyPercent: 100` (stop-before-start, as
    platform-api already does at `social-stack.ts:507-510`);
  - `cpu: 1024` / `memoryLimitMiB: 2048`;
  - correct the comment.
- **Next (this repo, M).** Run the gateway as its own ECS service from the
  same image (`ROLE=gateway`), with an ALB/CloudFront path rule for `/ws`, so
  REST can autoscale freely while the gateway stays at one task. The catch:
  REST-side `notify()` calls rely on the in-process sink
  (`realtime-gateway.ts:575`), so a REST-only task would persist
  notifications to Redis but not live-deliver them. That needs a
  Redis-list/pubsub hand-off.
- **Later (upstream realtime-modules, L).** A Redis-backed `RealtimeRouter`
  (channel and user fan-out over pub/sub), with `calls()` forwarding
  `crossNodePubSub` and an atomic accept (`SET NX` on `call:accepted:<id>`
  whose result is honoured). The membership mirror needs pub/sub invalidation
  as well.

## 3. Collisions specifically

**Lobby names.**

- `dmLobbyName` de-duplicates, sorts and joins ids with `:`
  (`rm/client/video/conversationLobby.js:19-22` [V]).
- The same participant set always maps to the same lobby: `social:dm:a:b:c`
  whoever starts it. That is the intended "join the existing call"
  behaviour, so two separate calls among the same people **merge** into one.
- There is no escaping. `['a','b:c']` and `['a:b','c']` produce the same name.
  This repo's ids are `u-*`/`p-*` with no colons, so it is not reachable today
  [I]. Upstream should reject ids containing `:`.
- Tenant prefixes are enforced by `lobbyGuard`: partition = first segment,
  must be the caller's tenant or listed in the token's `tenants`, and a `dm:`
  lobby must name the caller (`realtime-gateway.ts:164-190` [V]).
- Rooms are `${orgId}:room:${slug}`, and slugs get `-2`/`-3` suffixes
  (`papi/routes/hangoutRooms.ts:168-169, 439-444` [V, per research pass]).
- The slug-uniqueness check is a GSI read followed by a put, a race the code
  explicitly accepts (`papi/repositories/HangoutRoomRepository.ts:160-193`
  [V, per research pass]). Two rooms created at the same instant with the
  same name can share a slug and therefore a lobby [I]. Room creation is
  limited to 5/hour per user, so this is rare.

**One call → two SFU sessions: yes, in the CDK as written. This is a blocker.**

- platform-api's find-or-create **delegates to LVS's Redis `SET NX`** and
  treats LVS's session store as "the source of truth for 'is this lobby live'"
  (`papi/routes/videoSessions.ts:236-241` [V]).
- LVS only honours `findOrCreate` when `sessionStore.connected`
  (`lvs/src/api/sessions/index.js:86-88` [V]). Its Redis URL defaults to
  `redis://localhost:6377` (`lvs/src/app.js:105` [V]), and connection failure
  only logs a warning (`app.js:470-474` [V]).
- `OrgIQ-SocialMedia` passes `REDIS_URL` only if the undocumented
  `sfuRedisUrl` context is set (`social-media-stack.ts:199, 219` [V]). No doc
  or deploy command sets it [V, grep].
- So in AWS every joiner of a call gets a **fresh** LVS channel and session.
  Each participant sits alone in their own session: no error, only silence
  [I]. The local stack did not show this because it runs LVS with `REDIS_URL`
  (`docs/social-calls-local-stack.md:185`).
- The same split happens after any SFU Redis restart mid-call: the
  `session:byname:<lobby>` index is gone, so late joiners start a new session
  [I].
- **Fix (S, this repo).** Run `redis:7` on the SFU host (`--network host`,
  bind 127.0.0.1) from the same user data, and set
  `REDIS_URL=redis://127.0.0.1:6379`. Make it the default; keep `sfuRedisUrl`
  as the override.
  - A local Redis avoids the deploy-order problem: `OrgIQ-SocialMedia`
    deploys before `OrgIQ-Social`'s ElastiCache exists.
  - It keeps LVS's unprefixed `session:*`, `quota:*`, `ratelimit:*` and
    `channel*` keys out of the shared cache.

**Two calls → one SFU session: by design, per lobby.**

- The session is keyed by lobby name (`POST /api/video/sessions {lobbyName,
  documentId: lobbyName, findOrCreate: true}`,
  `rm/client/video/useConversationCall.js:287-310` [V, per research pass]).
- It persists until `/end` or LVS's idle TTL.
- Signalling call ids are `call-${Date.now()}-${6 random base36}`
  (`useConversationCall.js:41` [V, per research pass]). They are per attempt
  and unrelated to the SFU session id, which is a `randomUUID()`
  (`papi/routes/videoSessions.ts:442` [V, per research pass]). LVS channel
  ARNs are UUIDs too (`lvs/src/services/channelStore.js:149` [V, per research
  pass]).
- Platform and SFU ids are unique. Call ids are unique enough at this scale:
  1 ms × 36⁶ [I].

**Races:**

- **Mutual invite (glare).** There is no server tie-break. Each side's
  `start()` creates its own `callId`. The other side shows an incoming ring
  for a different `callId` (`useConversationCall.js:533-541` [V, per research
  pass]). Both then find-or-create the same lobby session, so media converges
  but signalling carries two call records. Expect a stray "missed call"
  notice from the loser's invite [I].
- **Double accept by one user on two tabs.** The second socket gets
  `answered-elsewhere` (`CallService.js:1633-1673` [V]). This is safe on one
  process: the check after `await stateStore.getCall` reads the local Map,
  which the first accept updated synchronously [I]. It is unsafe across
  tasks, see §2.
- **Join during teardown / ghost participant.**
  - On socket close, if at least two participants remain the call continues.
  - If one remains, the server waits `rejoinGraceMs` (30 s) and then sends
    `ended`/`rejoin-grace-expired` (`CallService.js:2119-2450` [V, per
    research pass]).
  - Only `invite` or `accepted` re-registers a socket (`CallService.js:1674-1677`
    [V]). `participant-state` re-registers only for document calls with call
    meta (`:3150-3170` [V]), and `calls()` does not wire a `metaStore`.
  - The client's reconnect path sends only `status` and `participant-state`
    (`useConversationCall.js:686-701` [V]).
- **Consequence.** Any gateway socket drop during a 1:1 call ends that call
  30 s later, even though media is still flowing [I, strongly suggested by the
  code; not run]. Causes include a Wi-Fi blip, a laptop sleeping, a
  middleware deploy or task replacement, an ALB/CloudFront reconnect, or a
  token-prop change while disconnected.
- **At 100 calls, one middleware deploy ends all 100 1:1 calls.** Group calls
  survive, but the reconnected member is off the signalling roster.
  **Blocker (upstream realtime-modules, S-M):** re-register on
  `participant-state` for any active call whose roster lists that user.
  `rejoinGraceMs` is forwarded (`attach.js:207` [V]) but raising it does not
  help, because nothing re-registers.

**Redis namespaces.** No component prefixes its keys:

- middleware call state: `call:active:<id>`, `call:invites:user:<uid>`,
  `call:lobby:<lobby>`, `call:accepted:<id>` (`rm/call/CallStateStore.js:314-323`
  [V, per research pass]);
- notifications: `notif:list:<uid>` and `notif:read:<uid>`;
- platform-api: `video:arn-index:*`, `social:*`, `idem:*`
  (`papi/routes/videoSessions.ts:500-505`; `papi/lib/cache.ts:17-19` [V, per
  research pass]).

Today the families do not overlap, so tenants and services do not collide,
and lobby names already carry the tenant. **Two environments sharing one Redis
would collide**: a laptop pointed at the cloud cache, or dev and stage on one
cluster. Rule: one Redis per environment, and give LVS its own (above).
`redis-lite` supports a `/db` index (`middleware/src/lib/redis-lite.ts:105`
[V]) if separation inside one cluster is ever needed.

**DynamoDB:**

- **Chat** puts have no condition. Ids are
  `Date.now().toString(36) + Math.random().toString(36).substr(2)`
  (`rm/chat/ChatService.js:1687-1689` [V, per research pass]); SK = messageId,
  PK = channel (`DynamoMessagesTable.js:37-57`). Collision probability is
  negligible [I]. Ordering follows the sender node's clock: same-millisecond
  messages come out in random order. On one task there is no cross-node skew.
- **Call log** rows are keyed `userId`/`callId` (`papi/repositories/CallLogRepository.ts:6, 249`
  [V]). `applyEvent` does get-then-put with no condition (`:275-277` [V]), so
  it is idempotent by key. But the caller's and callee's reports for one row
  race and the last write wins: "answered" can be overwritten by "missed" [I].
  Fix upstream with a condition on a monotonic state rank (S).
- **Video sessions.** The `putItem` is unconditional and best-effort
  (`papi/repositories/VideoSessionRepository.ts:37-39` [V, per research
  pass]). Participant updates are unconditional read-modify-write (`:85-125`)
  and can lose updates under concurrent joins. That is cosmetic for the
  past-calls UI.

**Not relevant.** The ≥33-character session-id rule is AgentCore runtime
session storage and is not in the call path.

## 4. platform-api + DynamoDB + ElastiCache

**Per-call request volume** (from `papi/routes/videoSessions.ts`, per research
pass):

- Per participant: one create/find (`:242`), one join (`:552`), one leave or
  end (`:751`), periodic `/refresh-token` (`:910`), and call-log events.
  Create involves an SFU call, a `putItem`, a lobby Query and a stale-row
  loop (`:478-487`).
- Rooms add a loopback HTTP hop per join (`papi/routes/hangoutRooms.ts:250-270`).
- Case (b): about 400 creates/joins over a few seconds, then a trickle. The
  load is light for one 0.5 vCPU task [I].
- The pressure point is the **process-wide SFU circuit breaker**: 5 failures
  open it for 30 s, and every SFU call goes through it with an 8 s timeout
  (`papi/lib/sfu-breaker.ts:44, 56-68` [V, per research pass]). An SFU
  briefly pinned at 100% CPU, which is what happens today, opens the breaker
  and **every** new join fails 503 for 30 s [I].

**Task.**

- Fargate 512/1024, `desiredCount` 1, stop-before-start, **no autoscaling and
  no alarms** (`infra/lib/social-stack.ts:408-419, 506-511` [V, per research
  pass]).
- Ownership fencing across replicas is not established (comment `:507-510`),
  so it is single-task by design too.
- Going to 1 vCPU / 2 GB is cheap headroom.

**DynamoDB.** All tables are `PAY_PER_REQUEST` (`social-stack.ts:317-321` [V,
per research pass]), so there is no provisioned throttling at this volume.
Things that would bite at much larger scale but not at 100 calls [I]:

- `hangout-rooms` is partitioned by `orgId`, which is constant per tenant.
- The `global` lobby uses one partition.
- Full-table scans: `findActiveByReviewDocument`, the webhook fallback
  `findByChannelArn`, and `listActiveCandidates`
  (`VideoSessionRepository.ts:152-254`).

Also, the task role lacks `UpdateTimeToLive`, so the app's boot-time TTL
enablement fails silently. Ended-session rows then never expire
(`social-stack.ts:390-395`; `papi/lib/dynamo-setup.ts:21-37` [V, per research
pass]). Fix in CDK (S): set `timeToLiveAttribute` on those tables.

**ElastiCache** (`social-stack.ts:273-293` [V, per research pass]): one
`cache.t4g.micro` node, Redis 7.1, no replica, no failover, no snapshots, no
TLS or AUTH.

- The node has about 0.5 GiB of memory [M]. Call state, inboxes (200 per user,
  `RedisNotificationStore`) and caches for 1,000 users are a few MB, and
  connections are about 3 [I]. **Memory and connections are not the issue.**
- **A restart or AZ event loses** [I]:
  - every in-flight ring and call record;
  - every user's unread notifications, which the stack comment calls the
    reason Redis was chosen;
  - platform-api's ARN index (webhooks then fall back to a full scan) and its
    idempotency records.
- Headroom fix (S, CDK): `cache.t4g.small` with one replica, automatic
  failover, Multi-AZ, and a daily snapshot.
- Two clients constrain the options:
  - `redis-lite` cannot do TLS (`middleware/src/lib/redis-lite.ts:99-100` [V]),
    so in-transit encryption or Serverless needs a real client first.
  - It has **no command timeout** [V, no timeout anywhere in the file]. A Redis
    that accepts TCP but stalls would hang every call frame's awaited Redis
    call indefinitely [I]. Add a per-command timeout (S, this repo).

## 5. Client side

**Token.**

- The 10-minute HS256 token is cached until 60 s before expiry, and
  concurrent callers share one in-flight fetch (`portal/src/lib/realtimeToken.ts:19-117`
  [V]).
- The socket's token prop is swapped **only while the socket is down**
  (`portal/src/components/OptionalGatewayProvider.ts:31-40` [V]). The gateway
  never re-checks an open socket (`realtime-gateway.ts:22-24` [V]).
- So token rotation does **not** drop a live call. That part is sound.

**Socket drops.** These are the risk, per §3's ghost-participant finding.

- The library reconnects with backoff of 1 s × 2ⁿ, capped at 30 s, **with no
  jitter** (`rm/client/useWebSocket.js:57-62, 354-355` [V, per research
  pass]).
- After a middleware restart, all 1,000 clients reconnect in synchronized
  waves at 1, 2, 4, 8 and 16 s. Each fetches a token if its token is stale,
  and each `/api/session/realtime-token` does an Aurora read through
  `getUser` (`routes/session.ts:175` [V]) [I].
- About 1,000 upgrades plus a few hundred token mints in about a second is
  survivable on one task but spiky. Add jitter upstream (S).

**WHEP fan-in.** Each remote participant costs one WHEP peer connection plus an
`/api/ice-servers` fetch (`useLVSHangout.js:730-740` [V]). In a 4-way call
each browser holds 4 peer connections, which is fine. At 8+ participants this
shape becomes a client CPU problem; a single transport per subscriber would
fix it upstream [I].

**Call-host provider.** The video provider is latched once mounted, so a token
refresh cannot unmount it mid-call
(`portal/src/pages/projects/InitiativeCallHost.tsx:178-182` [V]).

## 6. Observability for load

**What exists:**

- Middleware ECS CPU and memory, used only by autoscaling
  (`middleware-service-stack.ts:1226-1235` [V]).
- `/health` reports whether the gateway is on and where call state lives
  (`middleware/src/index.ts:150` [V]), but no socket count.
- LVS exposes Prometheus `/metrics` with about 60 `sfu_*` series, including
  admission-gate utilisation (`lvs/src/observability/metrics.js`,
  `cluster-metrics.js:107-174` [V]). **Nothing in AWS scrapes it.**
- The only alarms in the repo are Aurora ACU and Bedrock throttle
  (`infra/lib/observability-stack.ts:238, 255` [V]). There are none in
  `social-stack.ts` or `social-media-stack.ts` [V, grep].

**Missing, in priority order:**

1. **SFU host.**
   - The CloudWatch agent (or ADOT) on the EC2, scraping `/metrics`:
     per-worker CPU, transports, consumers, admission-gate in-flight and
     rejects.
   - Alarms on CPU above 70% for 5 minutes, `NetworkOut`, and
     `CPUCreditBalance` (while burstable).
   - A `StatusCheckFailed` alarm with EC2 auto-recover.
2. **Gateway.**
   - A periodic log line or EMF metric with open sockets, active calls,
     event-loop delay p99 (`perf_hooks.monitorEventLoopDelay`) and Redis
     command latency.
   - Alarms on event-loop p99 above 100 ms and on socket count dropping by
     more than 50% in a minute (a mass disconnect).
3. **ALB and CloudFront.** `HTTPCode_Target_5XX_Count`,
   `TargetConnectionErrorCount`, `RejectedConnectionCount`.
4. **ElastiCache.** `DatabaseMemoryUsagePercentage`, `CurrConnections`,
   `Evictions`, `EngineCPUUtilization`.
5. **platform-api.** SFU breaker state transitions as a metric, and 5xx on
   `/api/video/*`.

## Ranked changes for 100 calls

"Here" means this repo. Blockers come first, ordered by how early they stop a
call from working.

| # | Change | Where | Size | Kind | Blocker? |
|---|---|---|---|---|---|
| 1 | **SFU gets a Redis by default.** In `social-media-stack.ts` user data, start `docker run -d --name lvs-redis --network host redis:7-alpine --bind 127.0.0.1 --port 6379 --save ''` (as a systemd unit ordered before `lvs-sfu`) and default `REDIS_URL=redis://127.0.0.1:6379`; `sfuRedisUrl` stays as override. Without it every call splits into one session per joiner. | here (CDK) | S | config | **Blocker** (a, b) |
| 2 | **Pin the gateway to one task.** In `middleware-service-stack.ts`, when `realtime.enabled`: skip `autoScaleTaskCount` (context `middlewareAutoscale`, default `false` when the gateway is on), `minHealthyPercent: 0` / `maxHealthyPercent: 100`, `cpu: 1024` / `memoryLimitMiB: 2048`; fix the false Redis pub/sub comment at `:1205-1207`. Accept roughly a 1-2 minute signalling blackout per deploy (and see #4). | here (CDK) | S | config | **Blocker** (a, b) |
| 3 | **SFU size and LVS caps.** Context `sfuInstanceType` (default `t4g.small`; set `c7g.2xlarge` for (a), `c7g.4xlarge` for (b)), `sfuWorkers` (default 2; set to vCPU count) with `SFU_PORTS.rtcUdp/rtcTcp` and the SG ranges derived from it; add env `MAX_CONCURRENT_STREAMS=0`, `MAX_TRANSPORTS_PER_POD=4000`, `ADMISSION_GATE_CAPACITY=400`; enable EC2 auto-recovery. | here (CDK) | S | config | **Blocker** (a, b) |
| 4 | **Re-register a reconnected socket on conversation calls** (`CallService` `participant-state`/`status` from a roster member → `registerParticipant`), so a socket blip or deploy does not end 1:1 calls after 30 s; add reconnect jitter in `useWebSocket`. | upstream realtime-modules | S-M | code | **Blocker** for (a) reliability; any deploy ends all 1:1 calls |
| 5 | **Use all workers.** Room-affine placement via `workerPool.getNextWorker()`, `RouterManager` over all workers, one router per room, `TransportManager` per router; refresh router references on worker restart (hub#1253). | upstream LVS | M | code | **Blocker** for (b); (a) marginal without it |
| 6 | **Media reachability.** Custodian exception for the SFU SG (UDP/TCP worker ports from `0.0.0.0/0`) **or** coturn on TLS 443 with `LVS_TURN_URL`/`LVS_TURN_STATIC_SECRET`. Without one, only allowlisted IPs get media. | owner + here (CDK) | M | config + account | **Blocker** for real users, independent of load |
| 7 | **Gateway as its own ECS service** (`ROLE=gateway`, `/ws` path rule on ALB and CloudFront), so REST autoscaling can't split the router; needs a Redis hand-off for REST-originated `notify()`. | here | M | code + CDK | Headroom (removes #2's REST ceiling) |
| 8 | **ElastiCache resilience.** `cache.t4g.small`, 1 replica, `automaticFailoverEnabled`, `multiAzEnabled`, `snapshotRetentionLimit: 1` in `social-stack.ts`; per-command timeout in `redis-lite.ts`. | here | S | config + code | Headroom (a Redis blip loses rings and inboxes) |
| 9 | **Load alarms and metrics** (§6 list): CloudWatch agent on the SFU, gateway EMF line, ALB, ElastiCache and SFU alarms to an SNS topic. | here | M | CDK + small code | Headroom (needed to know you're at 100) |
| 10 | **ws `maxPayload`** option exposed by `attachRealtime`, set to about 256 KB here. | upstream realtime-modules + here | S | code | Headroom / safety |
| 11 | **Simulcast** (`sendEncodings` with 2-3 layers) in the publisher, plus layer selection by tile size. | upstream realtime-modules | M | code | Headroom (cuts (b) egress 30-50% [I]) |
| 12 | **platform-api.** 1 vCPU task; `timeToLiveAttribute` on `document-video-sessions`/`pipeline-runs`; breaker threshold tuned (e.g. 20 failures) so one hot SFU second doesn't 503 all joins for 30 s. | here (CDK) + upstream platform-api | S | config | Headroom |
| 13 | **Correctness cleanups.** Reject `:` in `dmLobbyName` ids; conditional call-log writes by state rank; `crossNodePubSub` forwarded by `calls()`. | upstream | S each | code | Not blockers at this scale |
| 14 | **Redis-backed `RealtimeRouter`** (user/channel fan-out over pub/sub, atomic `call:accepted` honoured, membership mirror invalidation) — only if the gateway must exceed one task or survive a task loss without a blip. | upstream realtime-modules | L | code | Not needed for 100 calls |

## Load-test plan

### A. Signalling at 100 calls, locally, no AWS

**Setup.**

- Run `npm run dev:mock` in `middleware/` on a free port, e.g.
  `PORT=3031 REDIS_URL=redis://127.0.0.1:6379 npm run dev:mock`. Use a
  throwaway `redis:7` container so `RedisCallStateStore` is exercised.
- Ports 3001, 5183, 3021 and 5191 are reserved for the owner's running
  stacks.
- `NODE_ENV=development` means `REALTIME_JWT_SECRET` falls back to
  `orgiq-dev-realtime` (`middleware/src/lib/realtime-token.ts:38-47` [V]).

**Tokens.** Don't mint them through `GET /api/session/realtime-token`: the
login limiter allows 15/min per IP and only about 20 users are seeded.
Instead, sign synthetic tokens in the script with `jose` (already a middleware
dependency), using the claims `verifyRealtimeToken` checks (`:136-143` [V]):

- `sub: lt-0001…lt-1000`, `org: 'social'`, `tenants: ['social']`;
- `tokenKind: 'orgiq-hs256'`, `iss: 'orgiq-middleware'`, `aud: 'realtime'`,
  10-minute `exp`.

Keep one real-endpoint test as a smoke check: one session through the login
flow to prove the HTTP path.

**Driver.** `scripts/loadtest/realtime-calls.mjs`, using `ws` from
`middleware/node_modules`:

- Open 1,000 sockets to `ws://127.0.0.1:3031/ws` with subprotocols
  `['bearer-token-v1', token]`, ramped at 50/s.
- Copy the call frames verbatim from the client the portal ships:
  `rm/client/video/useConversationCall.js` for `invite`, `accepted`,
  `participant-state` and `status`, and `CallService.js` for the envelopes
  the server returns. Do not hand-type them.
- For (a), pair 200 sockets into 100 DM lobbies `social:dm:<a>:<b>` (sorted,
  as `dmLobbyName` with prefix `social:` builds them).
- For (b), group 400 sockets into 100 lobbies of 4: caller invites three
  targets, each target accepts, and the call holds 5 minutes with
  `participant-state` every 20 s.
- The other 600 sockets subscribe to presence on a channel and publish chat
  every 30 s. Use DM channels: `social:ch:` needs membership rows.

**Scenarios:**

1. Steady: ramp to 1,000 sockets and start 100 calls over 60 s.
2. Ring storm: 100 invites within 1 s.
3. Glare: 20 pairs invite each other within 10 ms.
4. Double accept: 10 users with two sockets accept the same call.
5. Socket churn: kill 10% of in-call sockets and reconnect after 2 s.
   **Expected to fail today** for 1:1 calls (§3). This scenario is the
   regression test for change #4.
6. Gateway restart mid-test: send `SIGTERM` to the dev process and restart it.
   This measures reconnect-wave behaviour.

**Measure.** Record per frame in the client:

- latency for invite → callee `incoming`, accept → caller `accepted`, and
  publish → chat delivery;
- the count of frames carrying a `callId` or `lobbyName` the socket is not
  party to (the collision detector);
- unexpected `ended` frames;
- `AUTHZ_CHANNEL_DENIED` frames.

Server side, record RSS and CPU (`ps`), and event-loop delay. Add the
`monitorEventLoopDelay` log line from #9 first, or approximate it by polling
`/health` latency.

**Pass/fail:**

- 100% of sockets connect.
- Invite → incoming p95 < 250 ms and p99 < 1 s, steady and ring storm.
- Accept → accepted p95 < 250 ms.
- Chat delivery p95 < 300 ms.
- **Zero** cross-call deliveries, zero `answered-elsewhere` outside
  scenario 4, and exactly one winner in scenario 4.
- Zero `ended` frames before the scripted hang-up.
- Event-loop delay p99 < 50 ms.
- RSS < 700 MB.
- Same results with 2 Node CPUs pinned (`taskset`, or a container with
  `--cpus=1`) to mimic the 1 vCPU task.

**Media locally.** This rig proves signalling only. A local LVS with two or
three headless Chromium tabs is a functional check, not a capacity
measurement: the laptop is not the target CPU.

### B. Media at 100 calls, AWS only

Run this only after changes #1, #3 and #5 (and #6, or with load-generator IPs
in `sfuAllowCidr`).

**Tool.** Headless Chromium is the faithful client, launched with
`--use-fake-device-for-media-stream --use-fake-ui-for-media-stream
--use-file-for-fake-video-capture=<640x480.y4m>`. Drive it with Playwright
against the real portal.

- Each tab encodes 1 stream and decodes N−1, so budget about 1 vCPU per
  participant tab [M].
- Case (a): 200 tabs, about 25 × `c7i.2xlarge`.
- Case (b): 400 tabs, about 50 boxes.
- Spot instances bring that to roughly $15-30 for a 1-hour run [M].

**Cheaper and closer to pure SFU load:** headless WHIP/WHEP clients that send
a pre-encoded file and do not decode, for example a small Go program on Pion
or GStreamer's `whipclientsink`/`whepsrc` [M on availability and exact
element names]. That gives 50-100+ synthetic participants per 4 vCPU box.
Pair it with about 10 real Chromium tabs to judge quality by eye.

**Placement.** Put load generators in another region, or at least outside the
VPC, on public IPs, so traffic takes the EIP path and its data transfer is
counted. Allowlist them via `sfuAllowCidr`.

**Procedure.** Ramp 10 → 50 → 100 calls in 10-minute steps and hold 30 minutes
at 100. Then run one SFU worker kill (`kill -9` a mediasoup worker PID) and one
middleware deploy.

**Measure:**

- SFU per-worker CPU (from `/metrics`), `NetworkOut`, packets/s;
- client `getStats()`: `packetsLost`, `jitter`, `framesDropped`, freeze count,
  RTT, and `availableOutgoingBitrate`;
- time-to-first-frame;
- join failure rate.

**Pass:**

- per-worker CPU < 70%;
- packet loss < 1% and jitter < 30 ms at p95;
- time-to-first-frame p95 < 3 s;
- join failures < 0.5%;
- zero participants alone in a session that has others (the #1 regression
  check: compare session ids across a call's participants in platform-api's
  `document-video-sessions`).

## Cost (list prices from memory, us-east-1; re-check before quoting)

**Running cost per hour at full load.** Egress dominates; internet data
transfer out is about $0.09/GB in the first 10 TB tier [M].

| | (a) 100 × 1:1 | (b) 100 × 4-way |
|---|---|---|
| SFU egress | ≈130 Mbps ≈ 58 GB/h ≈ **$5.3/h** | ≈780 Mbps ≈ 350 GB/h ≈ **$31.6/h** |
| SFU instance | `c7g.2xlarge` ≈ $0.29/h [M] | `c7g.4xlarge` ≈ $0.58/h [M] |
| Middleware (1 vCPU / 2 GB Fargate ARM) | ≈ $0.04/h | ≈ $0.04/h |
| platform-api (1 vCPU / 2 GB) | ≈ $0.04/h | ≈ $0.04/h |
| ElastiCache `t4g.small` × 2 | ≈ $0.065/h | ≈ $0.065/h |
| **Total while at peak** | **≈ $5.8/h** | **≈ $32.4/h** |

Simulcast (#11) mostly lowers (b)'s egress. Chat, presence and signalling
bandwidth is negligible.

**Monthly.** Fixed cost is 730 hours of infrastructure. Variable cost assumes
8 hours/day at peak on 22 workdays, i.e. 176 hours.

| | (a) | (b) |
|---|---|---|
| SFU instance + EIP + EBS | ≈ $215 | ≈ $430 |
| Middleware, platform-api, Redis (×2), ALB base | ≈ $30 + $30 + $47 + $20 ≈ $127 | same ≈ $127 |
| Egress at 176 peak hours | ≈ $930 | ≈ $5,560 |
| coturn (if chosen over a custodian exception) | + ≈ $25 + relayed traffic | same |
| **Total** | **≈ $1.3k/mo** | **≈ $6.1k/mo** |

These figures assume peak load all day. Real usage averages far below that, so
egress scales with actual call-minutes. The rule of thumb is about $0.03 per
participant-hour for (a) and about $0.08 for (b).

## Open questions for the owner

1. **Call size.** What is the maximum participants per call: 2, 4, or "a
   room"? At 8 or more, the per-subscriber transport design, simulcast and
   SFU sizing all change.
2. **Who joins from where.** Do 100 calls mean users on arbitrary home and
   corporate networks? If so, we need either a custodian exception for the
   SFU security group or TURN on 443 (#6). If not, which networks count?
3. **Deploys during calls.** Must calls survive a deploy? Today an SFU deploy
   replaces the instance and drops every call. A middleware deploy ends every
   1:1 call until #4 ships. If calls must survive, budget for a drain-aware
   two-SFU setup and the Redis router (#14).
4. **Recording.** It is disabled (`RECORDING_ENABLED=false`). If it is
   wanted, it adds ffmpeg CPU per recorded call on the SFU and S3 storage.
   Conversation calls default to recording at two participants
   (`docs/social-calls-deploy-plan.md` §3).
5. **Regions.** Is this one region (us-east-1) only? A single SFU in one AZ is
   a single point of failure. Is that acceptable for this phase?
6. **Peak profile.** Is 100 calls a sustained 8-hour peak or a short burst?
   That sets whether the cost table's $1.3k-6.1k/month is real, or nearer
   the fixed floor of about $350-560.

## Implemented 2026-10-01

These items are now code or CDK in this repo, with offline tests. Nothing was
deployed. The flags and the 100-call profile are in
[the deploy plan §11](social-calls-deploy-plan.md#11-capacity-100-simultaneous-calls-2026-10-01).

| # | Status | Notes, including where this review was checked and found wrong |
|---|---|---|
| 1 | **Done.** A loopback Redis on the SFU host by default; `sfuRedisUrl` overrides. | It uses AL2023's `redis6` with a `redis:7-alpine` fallback, not Docker-only. Arming Redis also arms LVS's stream quota, so `MAX_CONCURRENT_STREAMS` now defaults to 1000. **Correction to §1 and #3:** `MAX_CONCURRENT_STREAMS=0` is not unlimited. `quotaEnforcer.js` reads `parseInt(v) \|\| 50`, so 0 means 50. |
| 2 | **Done.** With the gateway on: no autoscaling, 0/100 deploys, 1 vCPU / 2 GB (`middlewareCpu`, `middlewareMemoryMiB`), a 15 s deregistration delay. The false pub/sub comment is fixed, and `middlewareAutoscale=true` with the gateway is refused. | The deregistration delay was not in the review. With stop-before-start, the ALB's default 300 s drain would have made each deploy a five-minute blackout. |
| 3 | **Done.** `sfuInstanceType` (Graviton enforced), `sfuWorkers` (ports and security group derived from it), `sfuMaxStreams`, `sfuMaxTransports`, `sfuAdmissionCapacity`, plus EC2 auto-recover, always on. | New finding: OrgIQ-Social imported the SFU host through CDK hash exports. Every instance replacement (any image or env change) would have failed with "Cannot delete export … in use". It now reads SSM parameters by name. |
| 6 | **Built, off:** `deployTurn=true` (coturn on 3478 and 443, `LVS_TURN_URL` and `LVS_TURN_STATIC_SECRET` on the SFU). | TURN over TLS needs a DNS name and a certificate (`turnTlsDomain`, `turnTlsCertSecretName`). Without them, 443 carries plain TURN-over-TCP. The client ignores `iceTransportPolicy`, so there is no forced relay. |
| 7 | **Not built; judged unnecessary for 100 calls.** | One 1 vCPU task carries the §2 load. It remains headroom for REST. |
| 8 | **Done.** `socialRedisReplicas` and `socialRedisNodeType` (replica, failover, Multi-AZ, snapshot), and `redis-lite` per-command and connect deadlines. | A timeout abandons the connection, because a late reply cannot be skipped on one ordered connection. |
| 9 | **Done, behind `realtimeAlarms=true`.** SNS `orgiq-realtime-alarms`; alarms on the ALB, ECS, ElastiCache, DynamoDB throttles and the SFU; and a `realtime-gateway-stats` log line read by metric filters. | Not done: the CloudWatch agent scraping LVS `/metrics`, platform-api breaker metrics, and a socket-drop (rate) alarm. |
| 12 | **CDK half done.** `platformApiCpu` and `platformApiMemoryMiB`, and TTL on `document-video-sessions`, `pipeline-runs` and `social-outbox`. | The breaker threshold is upstream (platform-api). |
| 4, 5, 10, 11, 13, 14 | Upstream. Unchanged. | (b) needs #5 before more workers do anything. |

## Measured 2026-10-01 (signalling only, local)

`scripts/loadtest/realtime-calls.mjs` (see `scripts/loadtest/README.md`) ran
every scenario of plan A at 100 calls, for 1:1 and for four-way calls: 1,000
sockets ramped at 50/s, a 60 s hold, against one mock middleware process with
in-memory call state (no Redis or Docker on this machine, so
`RedisCallStateStore` was not exercised). Nine of ten runs passed every
threshold.

| scenario | 1:1 | four-way |
|---|---|---|
| steady | pass — invite→incoming p95 0.5 ms | pass — 1.6 ms |
| ring storm | pass — 0.6 ms | pass — 2.8 ms |
| glare | pass — 20/20 pairs resolved to one call | pass |
| double accept | pass — 10/10 one winner, one `answered-elsewhere` | pass |
| socket churn | **fail — 20 of 20 reconnected calls ended** | pass (no `ended`) |

- **Collisions: none.** Zero cross-call deliveries and zero denied frames in
  all ten runs.
- **Pressure: none on signalling.** Peak RSS 205 MB against the 700 MB limit;
  about 31% of one laptop core for a second, 3% mean. A laptop core is not the
  Fargate task, and the plan's pinned-CPU run was not done.
- **The churn failure is change #4, now observed rather than inferred.** A
  dropped 1:1 socket reconnects after 2 s and sends `status` and
  `participant-state` as the shipped client does; the server's `active-call`
  reply lists the peer but not the reconnected user (0 of 20), and exactly
  30.0 s after the drop every surviving peer receives `ended` with reason
  `rejoin-grace-expired`. It reproduced on a second run. Four-way calls
  survive, but the reconnected member is missing from the roster there too
  (0 of 40).
- **One threshold miss to watch:** `/api/health` p99 was 93.6 ms (limit 50)
  in the churn 1:1 run. Slow samples of 140–290 ms appear in most runs at the
  end of the ramp, when about 800 sockets join chat and set presence in one
  burst. That timing is the likely cause; the server was not profiled.

Not measured here: media (WHIP/WHEP, the SFU, platform-api), a Redis-backed
gateway, and a gateway restart mid-test (plan scenario 6). The same script
runs against a deployed gateway with `--url wss://<host>/ws --secret <the
deployed REALTIME_JWT_SECRET> --health-url https://<host>/api/health`; the
load generator's address must be in `albAllowCidr`.

## Integrated and rechecked 2026-10-01 13:40 local

- **Reconnect (#4):** realtime-modules v0.99.4,
  `94bf705e9a4be312d1b54aac83b374b227a2ca4e`, is pushed to the canonical
  repository and installed in both middleware and portal. Its 1,906 tests,
  typecheck and tracked-dist build pass. Rejoins require an authenticated
  former seat on the live call's lobby. The peer stays through rejoin grace;
  reconnect waits have jitter.
- **Worker placement (#5):** LVS
  `1c26334bd7508fc5fc6afbb1319e6d2fd7a0aa45` is pushed and pinned in
  `socialSources`. Single-node rooms spread over live workers and remain
  worker-affine; clustered mesh pods keep primary placement. Caps parse
  0 / unlimited honestly. Lint, 21 fake-worker checks and two real-mediasoup
  checks pass. The full runner reports 224 passing files and the same two
  baseline failures: `api/channels/createRetry.test.js` and the
  missing-Redis `redis-pubsub-duplicate.test.js` timeout.
- **Payload cap (#10):** the middleware sets `maxPayload: 256 * 1024` on
  `/ws`. A real-socket test confirms a larger invite closes only the sender
  with 1009 and never reaches the peer. Per-socket frame rate limiting is
  still a queued library gap. The separate canvas socket uses 16 MiB.
- **Consumer checks:** all 373 middleware suites pass across two disjoint
  batches; middleware and portal typechecks pass. All 1,209 portal tests and
  the production build pass. The integration here is uncommitted.

The original failing **1:1 churn** scenario was re-run against a fresh
middleware process using the installed v0.99.4, after the tests and browsers
stopped. Command: `node scripts/loadtest/realtime-calls.mjs --url
ws://127.0.0.1:3061/ws --scenario churn --group-size 2 --sockets 1000 --calls
100 --hold-seconds 5 --spread-seconds 2`. Churn holds the calls until past the
30-second grace even with the shorter hold flag. This remains local
signalling with in-memory call state, not Redis failover or SFU media.

| Measure | Re-run |
|---|---|
| Calls established | 100/100 |
| Dropped / reconnected call sockets | 20/20 |
| Calls ended before scripted hang-up | 0 (was 20) |
| Cross-call / chat / presence deliveries | 0 |
| Invite-to-ring p95 / p99 | 1.8 / 2.5 ms |
| Accept p95 | 1.6 ms |
| Chat delivery p95 | 1.4 ms |
| Health latency p99 | 36.8 ms (limit 50) |
| Server RSS peak | 235.3 MiB (limit 700) |
| Threshold verdict | all pass |

The initial `active-call` query still omits the reconnecting person because
it precedes `participant-state`; it is a query, not the seat-registration
operation. The later announcement now seats the person and cancels grace.
The measured failures from the original run above remain historical evidence.

## Redis restart and bounded container soak, 2026-10-03

Both app consumers now lock realtime-modules 0.100.2 at
`373182242a7ee115ef1d787a61b25054105c5a14` on the upstream
`fix/persisted-call-restart` branch. A controlled restart baseline recovered
40 sockets but zero of ten original participant call-status checks. The
upstream fix adds atomic remembered-participant resume and unchanged-roster
pruning; its full library suite passes 1,940 tests, with five actual Redis
recovery tests also passing. The repeated small container restart recovered
all ten original call statuses and peer routes.

The load generator runs inside the isolated Compose network under Tilt.
The initial host-forwarded 1,000-socket run failed when Lima's SSH forwarding
disappeared while the VM's Docker daemon and gateway stayed running; that
failed run is not capacity acceptance. The repeated internal-network run uses
Redis call state, a gateway limited to 0.5 CPU / 768 MiB, and a separate driver
limited to 1 CPU / 512 MiB. It holds 100 two-person calls among 1,000 sockets
for five minutes, restarts only the gateway, and refreshes authenticated
connections three times using 120-second tokens.

| Measure | Internal container run |
|---|---|
| Calls established | 100/100 |
| Gateway restart recovery | 1,000 sockets, 200 call statuses/peer routes, 800 chat/presence clients; 24.4 s |
| Each token-renewal recovery | Same complete coverage; 21.5 s |
| Unexpected disconnects / early call ends / cross-channel frames | 0 / 0 / 0 |
| Invite-to-ring p95 / p99 | 1.9 / 4.6 ms |
| Accept p95 | 1.7 ms |
| Chat delivery p95 | 171.6 ms |
| Health p99 / maximum | 18.3 / 231.8 ms |
| Health errors outside / during planned outage | 0 / 4 |
| Gateway peak Docker working set | 139 MiB |
| Predefined threshold verdict | all pass |

The [raw result](realtime-validation/2026-10-03/orgiq-restart-1000.json)
records 12,547 peer-delivery observations for 12,548 sends. These are frame
counts, not unique persisted message receipts: per-message loss,
deduplication, and durable replay require separate acceptance. Chat storage
in this profile is memory, and non-realtime providers are mocked. No SFU,
live browser media, AWS deployment, multiple gateways, or long-duration
production soak is covered. The [initiative integration plan](design/initiative-huddle-shell-plan.md)
records those remaining gates.
