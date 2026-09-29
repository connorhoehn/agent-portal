# Social calls: deploying the stack to AWS with CDK

Extends [the social-calls plan](social-calls-plan.md) (step 2 ran the stack
locally; this is the AWS half) and builds on
[the 2026-09-20 deployment research](realtime-middleware-deployment-research-2026-09-20.md).
Written 2026-09-28 from a read-only pass over this repo, realtime-examples
(`06bc94e6`), platform-api (`a3317f5`) and live-video-streaming (`e51de5c`).
Nothing here has been synthesized or deployed. Where a price is quoted it is a
us-east-1 list price as remembered, not fetched; re-check before quoting it on.

Target: the innovation-lab account `647757222309`, next to
`OrgIQ-MiddlewareService`. (The auto-memory says the local `default` profile
resolves to `264161986065`, the personal account CLAUDE.md forbids. Run
`aws sts get-caller-identity` before every phase; that disagreement is
unresolved.)

## What the code says that the plan did not

1. **Three services verify the user's token, not two.** The plan names the
   gateway and platform-api. platform-api also *forwards the caller's bearer*
   to the SFU on create, join and refresh (`videoSessions.ts:350-362`, `:549`,
   `:907`), and LVS checks it as a Cognito RS256 token on `/api/sessions`
   (`live-video-streaming/src/middleware/cognito-auth.js`,
   `src/api/sessions/index.js:75,252`). An HS256 OrgIQ token that the gateway
   and platform-api learn to accept still fails at the SFU in production.
2. **A gateway, platform-api and Redis already deploy onto this cluster.**
   `--context deployDocumentWorkspace=true` runs `attachDocumentWorkspace`
   (`infra/lib/document-workspace.ts`). That puts realtime-examples'
   `DocumentWorkspaceServices` construct (`lib/document-workspace-services.ts`)
   into `OrgIQ-MiddlewareService`: gateway, platform-api, MQ, catalog, a Redis
   *container* (`RedisService`), `ApplicationTables`, Cloud Map, a
   `/document-realtime` listener rule, and `idle_timeout` 300 s. It even mints
   `DocumentVideoWebhookSecret` / `DocumentVideoAdminSecret`, but it has no
   SFU. It is not reusable for calls as-is. The gateway's `ENABLED_SERVICES` is
   `presence,cursor,crdt,subscribe,document-events,fileupload` (no `chat`, no
   `call`). It accepts only EdDSA document grants scoped to one `doc:<id>`
   channel. Those grants are refused for every service except crdt/fileupload
   (`realtime-examples/src/server.ts:3414`). And it is gated to the assessment
   tenant. The social stack should reuse the same constructs (`RedisService`,
   `ApplicationTables`, the task shape) rather than invent new ones. Note that
   `infra/package.json` pins realtime-examples at `2549856e`, 1,058 commits
   behind its head.
3. **`PLATFORM_API_URL` already means something else in the middleware.**
   `work-graph/producer.ts:60` uses it server-side for
   `/internal/work-graph/ingest`, which is an internal URL. The token bridge
   (`config.ts:133`, `routes/session.ts:179`) echoes the same variable to the
   *browser*. In AWS those are different hosts, so the token response needs
   its own variable (say `REALTIME_PLATFORM_PUBLIC_URL`).
4. **Two call tables are not in the shared schema.** platform-api creates
   `call-log` (`userId`/`callId`) and `voicemail` (`userId`/`voicemailId`) at
   run time with `CreateTableCommand` (`CallLogRepository.ts:242`,
   `VoicemailRepository.ts:51`). Neither is among the 53 tables in
   realtime-examples' `infra/dynamodb-schemas.json`, which is what
   `ApplicationTables` reads. In AWS, either CDK creates them or the task role
   gets `dynamodb:CreateTable`. Take the first.
5. **There is no portal hosting.** No stack serves the portal (no S3/CloudFront;
   `portal/Dockerfile` exists for compose only). `VITE_GATEWAY_URL` is a
   build-time variable (`App.tsx:127`, `GatewayStatusBadge.tsx:13`).
6. The brief's `infra/lib/app.ts` is `infra/bin/app.ts`.

## Shape: stacks and deploy order

| # | Stack | Holds | Depends on |
|---|---|---|---|
| 0 | `OrgIQ-MiddlewareService` (existing, amended) | Mints `orgiq-realtime-jwt-secret`, sets `REALTIME_JWT_SECRET`, `REALTIME_GATEWAY_URL`, `REALTIME_PLATFORM_PUBLIC_URL`, `REALTIME_VIDEO_PUBLIC_URL` | as today |
| 1 | `OrgIQ-SocialImages` (new) | ECR repos `orgiq-social-gateway`, `orgiq-platform-api`, `orgiq-lvs-sfu`, RETAIN | none |
| 2 | `OrgIQ-SocialMedia` (new) | The SFU: EC2 instance, EIP, security group with an allowlist; later coturn | VPC from 0 |
| 3 | `OrgIQ-Social` (new) | Redis, DynamoDB tables, secrets, gateway and platform-api Fargate services, ALB host rules | 0, 1, 2 |

Why separate stacks and not another `attach…` inside the middleware stack:
the SFU has a different blast radius (public media ports, custodian exposure).
Also, the images must exist before the services, the same chicken-and-egg that
`OrgIQ-AgentCoreRuntime` and the middleware stack already solve with two
phases. The cost of splitting: the VPC, cluster and HTTPS listener live in
`OrgIQ-MiddlewareService` and are not exported. Passing them as props in
`bin/app.ts` makes CDK mint hash-named exports, and those freeze while
imported (the KnowledgeBase gotcha). That is acceptable here, since the VPC
and listener never change identity, but it means `OrgIQ-MiddlewareService`
can't be torn down without taking the social stacks down first.

Order it must go up:

1. `OrgIQ-MiddlewareService` phase 2 is already live with a certificate (see
   "HTTPS is a prerequisite" below). Redeploy it to mint the realtime secret.
   The token bridge then signs with a real secret; nothing verifies it yet,
   which is harmless.
2. `OrgIQ-SocialImages`, then build and push the three images (§4).
3. `OrgIQ-SocialMedia` with `--context sfuImageDigest=… --context sfuAllowCidr=…`.
4. `OrgIQ-Social` phase 1 (tables, Redis, secrets, services at
   `desiredCount 0`, the middleware pattern), then phase 2 with
   `--context deploySocial=true`.
5. Redeploy `OrgIQ-MiddlewareService` with the three public URLs as context.
6. Build the portal against them (§5).

## 1. websocket-gateway, Redis, and the shared JWT secret

**Service.** realtime-examples' `server-runtime` image, Fargate ARM64,
0.5 vCPU / 1 GB (the construct's size), `desiredCount 1`, private subnets.
Use **`minHealthyPercent 0 / maxHealthyPercent 100`** (stop-before-start),
not the middleware's 100/200. Ownership fencing across two gateways is not
established (2026-09-20 research), so a rolling overlap can double-write. A
deploy therefore drops live sockets for the length of a task start, and
clients reconnect.

Environment differs from the compose profile in these ways:
- `NODE_ENV=production`, `SKIP_AUTH` unset (the gateway refuses it in
  production).
- `ENABLED_SERVICES=chat,presence,call,room,activity,social,subscribe,notification`.
- `REDIS_ENDPOINT`/`REDIS_URL` pointing at the Redis below.
- `DDB_TABLE_PREFIX=orgiq-social-`, with no `DYNAMODB_ENDPOINT`.
- `PLATFORM_API_URL=http://social-platform.<ns>:3001` (Cloud Map).
- `WSG_EXPECTED_CLUSTER_SIZE=1`.
- `SERVICE_AUTH_SECRET` from Secrets Manager.
- `COGNITO_REGION`/`COGNITO_USER_POOL_ID` = the OrgIQ pool. `auth-middleware.ts:65`
  throws at start when these are unset and no grant verifier is configured,
  whichever verifier we end up with.

**Load balancer: the existing ALB, with a host-header rule.** Use
`rt.<domain>` → gateway target group on 8080. A path rule would also work for
the gateway (the document workspace already routes `/document-realtime` to a
gateway on this listener). But platform-api mounts `/api` wholesale
(`platform-api/src/app.ts:190`), which collides with the middleware, so use
host rules for all three and keep one listener, one certificate (SAN or
wildcard) and one `albAllowCidr` allowlist. A second ALB costs about
$16/month plus LCUs and buys nothing but a second allowlist to keep in sync.
Priorities 10 and 20 are taken by the document workspace; use 30 and up.

- **Idle timeout.** The ALB default is 60 s. The gateway pings every 30 s
  (`KEEPALIVE_INTERVAL_MS`, `src/config/constants.ts:17`), so the default would
  hold. Set `idle_timeout.timeout_seconds=300` unconditionally anyway; today
  it is only set when the document workspace deploys. The setting is
  ALB-wide, which also lengthens the middleware's SSE allowance. That is fine.
- **Sticky sessions: not needed.** realtime-examples' own ALB helper is
  deliberately "destickified": fan-out is cross-node over Redis pub/sub
  (`lib/fargate-service.ts:134`). With one task it is moot either way.
- **Health path.** `GET /health` on 8080, as the document construct and
  realtime-examples' helper use. `/health` does Redis I/O and `/ready` does
  not (`server.ts:3570`), so a Redis outage marks the target unhealthy and
  drains every socket. That is arguably correct for a relay that can't relay
  without Redis. The container-level check stays the construct's
  `node -e fetch('/health')`.
- **`Sec-WebSocket-Protocol: bearer-token-v1, <jwt>`.** The ALB forwards
  upgrade headers untouched, and the gateway echoes the marker. The token is
  well under ALB header limits, and it stays out of the URL, so it doesn't
  land in access logs. Nothing to configure; verify it in phase 2 anyway.

**Redis: recommend the container, then a single node.**

| option | $/mo idle | fit |
|---|---|---|
| Fargate container via realtime-examples' `RedisService` (0.25 vCPU / 0.5 GB, ARM64) | ~$7 | Already used by the document workspace. Loses all state on task replacement: presence, ringing calls, the ownership map. Acceptable for dev. |
| ElastiCache `cache.t4g.micro`, one node, no replica | ~$12 | Survives gateway/platform restarts. The recommendation once people rely on it. |
| ElastiCache Serverless | Valkey from ~$6; Redis OSS ~$90 minimum | Serverless requires TLS and is cluster-mode. The gateway and platform-api build plain `redis://` URLs from `REDIS_ENDPOINT`/`REDIS_PORT`, and I did not find a TLS or cluster-client path. Probably incompatible without upstream changes; not verified. |

**`REALTIME_JWT_SECRET`: mint once, read in both, no plaintext copy.** The
machine-callback gotcha exists because AgentCore runtimes can't take a
Secrets Manager reference, so the value is copied by hand into `--context`.
Here both consumers are ECS tasks, so both can use
`ecs.Secret.fromSecretsManager`, with no copy and no blackout window. Mint
it in `OrgIQ-MiddlewareService`. It already mints five secrets there, and
the social stack depends on that stack, not the other way round. Give it a
fixed name (`orgiq-realtime-jwt-secret`), and have `OrgIQ-Social` import it
with `Secret.fromSecretNameV2` rather than an exported ARN, so no export
freezes. Grant read to the gateway and platform-api task roles. If the SFU
must verify too (below), the EC2 role reads it at boot.

What changes the moment the middleware carries the secret: the token bridge
stops 503-ing in production (`realtime-token.ts:37`), and it issues tokens
that no service verifies yet. That is harmless, unlike the callback guards,
which flip to "required" on deploy.

HS256 means every holder of the secret can mint any identity. With three
verifiers holding it, an asymmetric token is the better shape. The EdDSA
grant plumbing (issuer, key id, Secrets Manager PEMs) already exists for
documents. Asymmetric is not required for a dev phase.

## 2. platform-api on Fargate

**Service.** 0.5 vCPU / 1 GB ARM64, private, Cloud Map name
`social-platform`, host rule `platform.<domain>` on the shared listener
(browsers call it directly: `useConversationCall({ platformApi: { baseUrl,
getIdToken } })`). Health `GET /health` returned 200 with `status:
"degraded"` locally, because the model check wants `ANTHROPIC_API_KEY`. Never set that key
(AWS-native models only); the degraded check does not fail the ALB probe.
Override the image `CMD` to `node dist/index.js`, as the document construct
does. The image's default is a Tilt restart-loop supervisor.

**Tables** (on-demand, prefix `orgiq-social-`, via `ApplicationTables` with
`tableNames` selected, plus two hand-written tables):

| table | keys | why |
|---|---|---|
| `document-video-sessions` | `documentId` / `sessionId` | session records (the `documentId` key is the lobby, kept for compatibility) |
| `call-session-bindings` | `callId` / `sessionId` | gateway call ↔ session |
| `video-call-recordings` (+ `video-call-recording-participants`) | `callId` / `recordingId`, TTL | recordings, if enabled |
| `call-reactions` | `lobbyKey` / `sk` | in-call reactions |
| `hangout-rooms`, `hangout-room-members` | `orgId`/`roomId` (TTL); `roomId`/`userId` | rooms |
| `social-profiles`, `social-rooms`, `social-room-members` | `userId`; `roomId`; `roomId`/`userId` | profiles and rooms |
| `social-outbox`, `pipeline-runs`, `pipeline-audit`, `pipeline-dlq` | per schema | boot touches these (`dynamo-setup.ts` checks TTL on each) |
| `chat-messages`, `chat-members`, `chat-reads`, `chat-conversations`, `chat-reactions`, `chat-pins`, `crdt-snapshots` | per schema | gateway chat |
| **`call-log`**, **`voicemail`** | `userId`/`callId`; `userId`/`voicemailId` | **not in the schema JSON**: CDK must create them |

⚠️ `ApplicationTables` creates every table with `RemovalPolicy.RETAIN`,
`deletionProtection` and fixed names. A teardown leaves them behind, and the
next create fails with "already exists", the same trap the orphan ECR repo
set for `OrgIQ-MiddlewareService`. `deploy.sh`'s orphan sweep (its DynamoDB
section) has to learn the `orgiq-social-` prefix, or the dev stack should
pass DESTROY.

**Environment:**
- `NODE_ENV=production`, `SKIP_AUTH` unset (refused in production,
  `index.ts:93`).
- `DDB_TABLE_PREFIX=orgiq-social-`, no `DYNAMODB_ENDPOINT`.
- Redis vars.
- `GATEWAY_WS_URL=ws://social-gateway.<ns>:8080`.
- `VIDEO_API_URL=http://<sfu private IP>:3901`, server to server inside
  the VPC.
- `VIDEO_PUBLIC_URL=https://sfu.<domain>`, which the browser uses.
- `LVS_WEBHOOK_BOOTSTRAP_URL=http://social-platform.<ns>:3001/hooks/lvs/recording`.
  The SFU calls it from inside the VPC.
- Secrets: `VIDEO_ADMIN_TOKEN` (= the SFU's `ADMIN_TOKEN`), `LVS_WEBHOOK_SECRET`
  (= the SFU's `WEBHOOK_HMAC_SECRET`; one secret under two names),
  `SERVICE_AUTH_SECRET`, and `REALTIME_JWT_SECRET` once platform-api verifies it.
- `VIDEO_SECRETS_REQUIRED=true`, so a missing video secret fails boot.
  Whether `assertRequiredInProd` hard-fails without it depends on
  distributed-core, which I didn't check.
- `COGNITO_*` from the OrgIQ pool (`requireAuth` reads them at module load).

Several routes still default the admin bearer to the literal `'admin'`
(`videoSessions.ts:126`, `recordings.ts:222`). Only the secret guarantees
they don't.

**Verification: the decision.** `SKIP_AUTH` is refused under
`NODE_ENV=production` by the gateway, platform-api and LVS alike. The choice:

| option | what must be built | cost |
|---|---|---|
| **A. An `orgiq-hs256` verifier** (the plan's option a) | An HS256 branch that checks `iss=orgiq-middleware`, `aud=realtime` and `tokenKind`, in the gateway's `AuthMiddleware.validateToken`, in platform-api's `requireAuth`/`optionalAuth`, **and** a change so LVS stops seeing it. Either platform-api calls LVS `/api/sessions` as a service (admin bearer, `creatorId` in the body) instead of forwarding the user bearer, or LVS gains the same branch. | Upstream changes in three repos (or two plus a platform-api change). Works for picker and SSO sessions alike, follows masquerade and tenant switches, and carries `org`. |
| B. Retain the Cognito id_token in the BFF | `routes/auth.ts` keeps the id_token and refresh token and hands them out. All three services already verify against a pool, so this is config only (`COGNITO_*` = the OrgIQ pool; LVS `COGNITO_CLIENT_ID` for `aud`). | Picker/demo sessions have no id_token, so no calls. Masquerade hands out the *operator's* identity. Our pool has no org claim (`custom:orgId`), so gateway `orgId` is null and lobbies are not tenant-scoped. Token lifetime and refresh become the BFF's job. |

**Gateway half of A: shipped 2026-09-29** — not as a branch in
realtime-examples' `validateToken` but as the middleware's own gateway
(`/ws`, `REALTIME_GATEWAY=on`; plan step 7), which verifies the token with
`verifyRealtimeToken` and refuses lobbies outside the caller's `org`. What
remains of A is platform-api's verifier and the service-to-LVS change.

Recommend **A with the service-to-LVS change**. The verifier that must exist
is an `orgiq-hs256` (or EdDSA) branch in the gateway and in platform-api.
Then the SFU only ever sees platform-api's admin bearer and the participant
tokens it mints itself. B is a stopgap if the upstream work stalls, and only
for SSO users.

## 3. The mediasoup SFU: the hard part

What LVS needs, from the code:
- A browser-reachable **public IP**, announced as `MEDIASOUP_ANNOUNCED_IP`
  (and `_TCP`). mediasoup cannot announce a port different from the one it
  binds (`src/app.js:258`).
- A small, fixed port set. With `WebRtcServer`, each worker multiplexes every
  transport on one UDP and one TCP port. With `MEDIASOUP_WORKERS=2`,
  `MEDIASOUP_RTC_PORT=40000`, `MEDIASOUP_RTC_TCP_PORT=40010` and
  `MEDIASOUP_RTC_TCP_PORT_PER_POD=false`, that is **UDP 40000-40001 and TCP
  40010-40011**. The range is four ports, not a thousand.
- Its HTTP API on 3901 (WHIP/WHEP signaling, `/api/ice-servers`) reachable
  from the browser **over HTTPS**. An HTTPS portal cannot call `http://`
  (mixed content).
- In production: `ADMIN_TOKEN` (strict, no default), `COGNITO_USER_POOL_ID`
  unless option A removes the forwarded bearer, `WEBHOOK_HMAC_SECRET`,
  `LVS_CORS_ORIGINS` = the portal origin, and `RECORDING_ENABLED=false` for
  the first phases. Conversation calls start recording at two participants
  (`videoSessions.ts:346`), and recordings need a disk and a finalize path.
- Participant tokens are RS256, signed with PEMs from `JWT_KEY_DIR`
  (`/etc/jwt-keys`). Without PEMs it generates an ephemeral keypair, so a
  restart invalidates every outstanding participant token. That is fine for
  one instance, and clients refresh.
- The image runs as root, installs `iptables`, bakes `proxy-ca.pem` into the
  trust store, `EXPOSE`s 3001 while listening on `PORT=3901`, and its build
  needs `GH_TOKEN` as a BuildKit secret.

**Fargate + NLB vs EC2:**

| | Fargate behind an NLB with EIPs | EC2 `t4g.small` with an EIP |
|---|---|---|
| Static IP | NLB `subnetMappings` with an EIP allocation (one per AZ used) | EIP on the instance |
| Announced IP | the EIP, via context | the EIP, via context or IMDS in user-data |
| Ports | 4 NLB listeners (2 UDP, 2 TCP), IP targets; the UDP target group health-checks over TCP/HTTP on 3901 | direct |
| Client IP at the SFU | preserved for UDP IP targets (not switchable), so the task SG still needs the clients' CIDRs | direct |
| HTTPS for 3901 | ALB host rule `sfu.<domain>` → task:3901 | ALB host rule `sfu.<domain>` → instance:3901 (instance target) |
| Idle $/mo | ~$29 (1 vCPU/2 GB) + $16 NLB + $3.65/EIP ≈ **$49** | $12.3 + $1.6 EBS + $3.65 EIP ≈ **$18** |
| Ops | no host to patch; NLB UDP flow timeout 120 s (ICE consent every ~5 s keeps it) | a host to patch; `docker run --network host` from ECR via user-data or SSM |

Recommend **EC2** for dev: less than half the cost, no NLB/UDP flow
subtleties, and it matches LVS's own EKS overlay (per-pod EIP,
`k8s/overlays/ec2`). Revisit Fargate + NLB if the SFU ever needs more than
one node.

**The blocker: this account removes open ingress.** An SFU has to accept
media from wherever participants are. Every workable shape puts `0.0.0.0/0`
on some security group: the instance's, the task's, or the NLB's. NLB client
IP preservation means an NLB doesn't hide it. Custodian
(`custodian-restrict-security-group-admin-ingress`) revoked `0.0.0.0/0:80`
six seconds after CloudFormation added it. I don't know whether the rule
also matches UDP or high TCP ports. Its name says "admin ingress", but the
evidence is port 80. So:

- **Phase 0 must measure it.** Create a throwaway SG with `0.0.0.0/0` on UDP
  40000 and TCP 40010, then read `IpPermissions` after 60 s. That is an AWS
  write, so it is for the operator, not an agent.
- **The shape custodian tolerates: allowlists.** Add
  `--context sfuAllowCidr=a/32,b/32`, parsed like `albAllowCidr`, applied to
  UDP 40000-40001 and TCP 40010-40011 (plus coturn's ports later). Emit a
  synth warning when it is empty. This is less limiting than it sounds: the
  portal and middleware already sit behind `albAllowCidr`, so a participant
  who is not allowlisted can't load the app either. For the two-person test,
  both participants' public IPs go in **both** lists.
- **If media must reach arbitrary networks,** there are three ways out, none
  of them an engineering workaround:
  1. Ask the account owner for a scoped custodian exception tagged to the SFU
     security group.
  2. Run the SFU outside this account. Not the personal `264161986065`;
     CLAUDE.md forbids it.
  3. Force relay through a managed TURN service and allow only the provider's
     relay ranges on the SFU. That dodges a `0.0.0.0/0` match only in
     letter, so it needs the owner's sign-off too.

**TURN.** For an SFU on a public IP, TURN is not what symmetric NAT needs:
the client dials a public address, and the SFU (ICE-lite) answers. TURN
matters when a client's network blocks UDP *and* the SFU's odd TCP ports,
which describes corporate networks. mediasoup's own TCP candidate (40010)
covers some of that. The rest needs TURN over TLS on 443. LVS already
supports it: `LVS_TURN_URL` + `LVS_TURN_STATIC_SECRET` mint time-bound
credentials at `/api/ice-servers` (`k8s/README.md:37-48`). realtime-examples
ships `docker/Dockerfile.coturn`, and LVS has `k8s/coturn.yaml` with relay
ports 49152-49999. A coturn instance has the same custodian problem on 443,
3478 and its relay range. Defer it to phase 4; locally `iceServers` was `[]`.

## 4. ECR repos and image builds

Three repos in `OrgIQ-SocialImages`: `orgiq-social-gateway`,
`orgiq-platform-api`, `orgiq-lvs-sfu` (the names as built, 2026-09-29). Settings: `lifecycleRules:
[{ maxImageCount: 5 }]` (the platform-api and SFU images are large: claude-code
and g++ in one, ffmpeg and mediasoup in the other).

**Removal policy: RETAIN, in their own stack.** The middleware's reasoning
applies: a stack that owns a repo and pulls from it deletes the image when a
failed create is rolled back. Keeping them in their own stack goes further,
because the service stacks never own the repos. RETAIN means the names
survive teardown, so add all three to `deploy.sh`'s `ECR_REPOS` orphan list
(its comment records exactly this failure for the middleware repo) and to
`destroy.sh`'s billing sweep.

**Builds:** local `docker buildx --platform linux/arm64`, like the agents; not
CodeBuild. Services reference images **by digest** via context
(`gatewayImageDigest`, …), as `DocumentWorkspaceConfig` already requires,
not `:latest` the way the middleware does. Build contexts are the ones the
compose profile proved:
- the gateway: `../realtime-examples`, target `server-runtime`, `--ssh default`;
- platform-api: context `..` (its Dockerfile COPYs `platform-api/…`), `--ssh default`;
- LVS: `../live-video-streaming`, `--secret id=gh-token`.

The compose profile builds from sibling *working trees*. For AWS, build from
pinned commits the way `scripts/docker/document-workspace-build.mjs` does
(`git archive` of a commit in `document-workspace-sources.json`). Extend that
manifest with live-video-streaming and add a push step; it only builds today.

## 5. Portal and middleware runtime config

| setting | local (`social` profile) | AWS dev |
|---|---|---|
| gateway | `ws://localhost:18080` | `wss://rt.<domain>` |
| platform-api (browser) | `http://localhost:13001` | `https://platform.<domain>` |
| platform-api (middleware work-graph, server side) | as configured | `http://social-platform.<ns>:3001` |
| SFU (browser, `LVSProvider baseUrl`) | `http://localhost:3901` | `https://sfu.<domain>` |
| SFU (platform-api `VIDEO_API_URL`) | `http://social-sfu:3901` | `http://<sfu private IP>:3901` |

The portal should learn these **at run time from `GET
/api/session/realtime-token`**, not from `VITE_*` at build time: one bundle
then serves every environment, and the values follow the middleware's
config. Today the response carries `gatewayUrl` and `platformApiUrl`. It
needs a `videoUrl` as well, and `platformApiUrl` needs its own variable (see
the top of this doc). Keep `VITE_GATEWAY_URL` as a local-dev override only.
The local-stack guide says it should be `ws://localhost:18080`, while
`portal/.env.local` currently holds `http://localhost:3001`.

**HTTPS is a prerequisite, not polish.** wss from an HTTPS page, Cognito
callbacks and `getUserMedia` all need it, which means a domain and an ACM
certificate for `certificateArn` covering `rt.`, `platform.` and `sfu.`.
Whether the lab account has a zone is unknown. Until it does, the dev test can
run the portal on each participant's own `localhost` (a secure context for
`getUserMedia`; an `http://` page may open `ws://` and call `http://`) against
the allowlisted HTTP ALB. That is fine for phase 2 and nothing more.

## 6. Cost per month at idle

| item | choice | $/mo |
|---|---|---|
| gateway | Fargate ARM 0.5 vCPU / 1 GB | 14.4 |
| platform-api | Fargate ARM 0.5 vCPU / 1 GB | 14.4 |
| Redis | `RedisService` container 0.25 / 0.5 (→ `cache.t4g.micro` +4.5) | 7.2 |
| SFU | EC2 `t4g.small` + 20 GB gp3 + EIP | 17.5 |
| DynamoDB | ~25 on-demand tables, PITR, near-zero storage | < 1 |
| Secrets Manager | realtime JWT, service auth, LVS admin, LVS webhook | 1.6 |
| ECR | 3 repos × ≤5 images, ~1-2 GB each | 1-3 |
| CloudWatch Logs | 3 groups, 1-month retention | 1-3 |
| ALB | shared with the middleware; rules are free | 0 (+16.4 if separate) |
| NAT gateway | already paid by `OrgIQ-MiddlewareService` | 0 (+data) |
| **total** | | **≈ $58-62** |
| later: coturn | `t4g.small` + EIP | +16 |
| alternative: SFU on Fargate + NLB | instead of EC2 | +31 |

Media egress is the only usage-driven line: roughly 0.5-1 GB per
participant-hour at $0.09/GB beyond the free tier. That is nothing at idle.

## 7. Phased rollout (dev, then more)

"Single AZ" applies to what can be single-AZ. The existing VPC spans two
AZs and the ALB requires two, but the NAT is already single. Pin the Fargate
tasks and the SFU to one subnet.

| phase | deploy | verify before moving on |
|---|---|---|
| 0: probes | nothing (operator only) | `sts get-caller-identity` = `647757222309`. The custodian probe on UDP/high-TCP ingress. A domain and ACM cert exist or are requested. |
| 1: images | `OrgIQ-SocialImages`; build and push by digest | `aws ecr describe-images` shows arm64 digests for all three. `docker run` of each image on the Mac starts and answers `/health` (`/api/health` for the SFU). |
| 2: backend, SKIP_AUTH-free | the middleware secret; `OrgIQ-Social` phases 1 and 2 with option A's verifiers merged upstream; the SFU with `RECORDING_ENABLED=false` | `describe-services` shows running 1/1 (a `CREATE_COMPLETE` stack proves nothing; see the middleware gotcha). The ALB target groups are healthy. From an allowlisted IP: `wss://rt.<domain>` connects with `bearer-token-v1, <realtime token>`. A forged token (wrong secret) is **rejected**; this is the check local runs never made. `POST /api/video/sessions` → 201 → the SFU channel exists → `/join` → a participant token. The SFU logs show no forwarded user bearer. |
| 3: the call | the portal against the deployed middleware | **Two participants on two different networks** (not the same Wi-Fi: say home broadband and a phone hotspot, both IPs allowlisted) complete invite → ring → accept → two-way audio and video for 5 minutes. `chrome://webrtc-internals` on each side shows the selected candidate pair on the EIP, over UDP. Repeat with UDP blocked client-side to prove the TCP 40010 fallback. Leave → `/end` → the session row is ended and `call-log` has rows for both users. |
| 4: hardening | coturn (TLS 443), recordings (EBS + finalize webhook), `cache.t4g.micro`, alarms | A client on a UDP-blocking network connects via relay. The recording webhook arrives with a valid HMAC. A gateway redeploy mid-call: the call media survives (it is SFU-side) and the relay reconnects. |

## 8. Backlog: what exists as code, what does not

As of 2026-09-29 the stacks exist as code with unit tests
(`infra/test/social-stacks.test.ts`, run by `cd infra && npm test`). Nothing
has been deployed, and `cdk synth` has not run against an account (the
tests synthesize the whole app in-process, offline).

One change of shape since §1: **the middleware is its own realtime gateway**
(`REALTIME_GATEWAY=on`, social-calls plan step 7), so `OrgIQ-Social` runs no
separate gateway service. The `orgiq-social-gateway` repo exists anyway.

| item | status |
|---|---|
| `OrgIQ-SocialImages` (`infra/lib/social-images-stack.ts`) | **code.** Repos `orgiq-social-gateway`, `orgiq-platform-api`, `orgiq-lvs-sfu`; RETAIN, `maxImageCount: 5`; exports `<repo>-ecr-uri`. In the app when any social flag is set (or `deploySocialImages=true`). |
| `OrgIQ-MiddlewareService` amendments | **code.** Mints `orgiq-realtime-jwt-secret` as the `REALTIME_JWT_SECRET` container secret. `idle_timeout` 300 s unconditionally, target group `ProtocolVersion HTTP1`, stickiness explicitly off. `--context realtimeGateway=true` sets `REALTIME_GATEWAY=on` and `REDIS_URL` (default `redis://redis.orgiq-social.local:6379`, override `realtimeRedisUrl`). `realtimeGatewayUrl` / `realtimePlatformPublicUrl` / `realtimeVideoPublicUrl` feed the token bridge's browser URLs. |
| `OrgIQ-SocialMedia` (`infra/lib/social-media-stack.ts`) | **code.** `t4g.small` AL2023 ARM64 with an EIP, a systemd unit that runs the image `--network host` and announces the EIP. It mints `orgiq-social-sfu-admin-token` and `orgiq-social-sfu-webhook-secret`, and `RECORDING_ENABLED=false`. The security group opens only `sfuAllowCidr` on UDP 40000-40001 / TCP 40010-40011, and synth warns when that is empty or open. `deploySocialMedia=true`. |
| `OrgIQ-Social` (`infra/lib/social-stack.ts`) | **code.** platform-api on Fargate ARM64 (Cloud Map `social-platform`, stop-before-start, `desiredCount 0` until `deploySocialService=true` + `platformApiImageDigest`), Redis container (`RedisService`), 23 on-demand RETAIN tables including `call-log` and `voicemail`, `tableSuffix` context. Host rules at priority 30 (`socialPlatformHost`) and 40 (`socialSfuHost` → SFU :3901). `deploySocial=true`. |
| Middleware code | `videoUrl` in the token response; reading `REALTIME_PLATFORM_PUBLIC_URL` / `REALTIME_VIDEO_PUBLIC_URL`; the middleware gateway itself is **shipped** (2026-09-29, `middleware/src/lib/realtime-gateway.ts`: `/ws`, HS256 verify, `lobbyGuard`, Redis call state when `REDIS_URL` is set — see the plan's step 7). Note its router is single-process: Redis shares call state, not frame fan-out, so keep the middleware at one task while the gateway is on. The middleware task role has **no** grant on the `orgiq-social-*` tables yet; add one if its gateway persists chat. |
| Upstream: gateway / platform-api / LVS | gateway: **none needed** — the middleware's `/ws` verifies the `orgiq-hs256` token and enforces tenant lobbies (2026-09-29). Still open: the same verifier in platform-api's `requireAuth`/`optionalAuth`, platform-api's tenant-aware ad hoc lobbies (`lobbyAccess.ts`), and platform-api calling LVS as a service instead of forwarding the user bearer. |
| Upstream: realtime-examples | `call-log` and `voicemail` in `infra/dynamodb-schemas.json`; the infra pin moved off `2549856e` (its manifest is older than HEAD's). Then `social-stack.ts` can drop its table copy for `ApplicationTables`. |
| Images/builds | **missing.** The three buildx builds and pushes by digest; social entries in `scripts/docker/document-workspace-sources.json` (or a sibling manifest) including live-video-streaming; the three repos in `deploy.sh` `ECR_REPOS`; the `orgiq-social-*` table and secret sweep in `deploy.sh`/`destroy.sh`. |
| DNS/TLS | **missing.** A hosted zone and an ACM certificate covering `platform.`, `sfu.` and the middleware host. The host rules take effect only once those names resolve to the ALB. |
| Portal | **missing.** Hosting of any kind; reading endpoints from the token response instead of `VITE_GATEWAY_URL`. |
| Verifiers | **gateway half done locally**: the middleware `/ws` refuses a wrong-secret, expired, wrong-audience or non-`orgiq-hs256` token with 401 and a cross-tenant lobby with an error frame (`lib/__tests__/realtime-gateway.test.ts`, and the forged-frame walk in `social-calls-first-call.md`). **Missing:** a phase 2 check that a forged token is rejected by platform-api and the deployed middleware gateway, and that the SFU sees no forwarded user bearer. Until option A is merged upstream, platform-api in `NODE_ENV=production` verifies Cognito tokens only. |
| TURN / recordings / ElastiCache | phase 4, unchanged. |

### Phase 1 deploy order

Before any of it, check the account (`647757222309`, never `264161986065`),
run the custodian probe (phase 0), and have the domain and certificate.

```bash
aws sts get-caller-identity --query Account --output text   # must print 647757222309
cd infra

# Every flag each stack needs, stated once. CDK context is not sticky: a
# redeploy without a stack's flags reverts it (the middleware to 0 tasks, the
# SFU to no ingress). `-e` (--exclusively) stops cdk from also redeploying
# the dependency stacks (Foundation, Aurora, …) under this context.
MW=(--context deployMiddlewareService=true --context certificateArn=$CERT_ARN
    --context albAllowCidr=$IP_A/32,$IP_B/32)
MEDIA=(--context deploySocialMedia=true --context sfuImageDigest=$SFU_DIGEST
       --context sfuAllowCidr=$IP_A/32,$IP_B/32)
SOCIAL=(--context deploySocial=true --context socialPlatformHost=platform.$DOMAIN
        --context socialSfuHost=sfu.$DOMAIN)

# 0. Mint the realtime JWT secret. Harmless on its own: the token bridge stops
#    503-ing and nothing verifies its tokens yet.
./scripts/deploy.sh OrgIQ-MiddlewareService -e "${MW[@]}"

# 1. The three repos, then build and push (local buildx, ARM64 — not CodeBuild).
./scripts/deploy.sh OrgIQ-SocialImages -e --context deploySocialImages=true
REG=647757222309.dkr.ecr.us-east-1.amazonaws.com
aws ecr get-login-password | docker login --username AWS --password-stdin $REG
docker buildx build --platform linux/arm64 --target server-runtime --ssh default \
  -t $REG/orgiq-social-gateway:latest --push ../../realtime-examples
docker buildx build --platform linux/arm64 --ssh default -f ../../platform-api/Dockerfile \
  -t $REG/orgiq-platform-api:latest --push ../..
docker buildx build --platform linux/arm64 --secret id=gh-token,env=GH_TOKEN \
  -t $REG/orgiq-lvs-sfu:latest --push ../../live-video-streaming
SFU_DIGEST=$(aws ecr describe-images --repository-name orgiq-lvs-sfu \
  --query 'sort_by(imageDetails,&imagePushedAt)[-1].imageDigest' --output text)
PLATFORM_DIGEST=$(aws ecr describe-images --repository-name orgiq-platform-api \
  --query 'sort_by(imageDetails,&imagePushedAt)[-1].imageDigest' --output text)
# (re-run the MEDIA=(…) line now that SFU_DIGEST is set)

# 2. The SFU. The middleware goes in the same call because it gains the
#    auto-generated exports (VPC, subnets) the SFU stack imports.
./scripts/deploy.sh OrgIQ-MiddlewareService OrgIQ-SocialMedia -e "${MW[@]}" "${MEDIA[@]}"

# 3. OrgIQ-Social phase 1: tables, Redis, secrets, platform-api at desiredCount 0.
#    Again with the middleware (cluster, listener, security-group exports).
./scripts/deploy.sh OrgIQ-MiddlewareService OrgIQ-SocialMedia OrgIQ-Social -e \
  "${MW[@]}" "${MEDIA[@]}" "${SOCIAL[@]}"

# 4. Phase 2: platform-api to 1 task on the pushed digest.
SOCIAL+=(--context deploySocialService=true --context platformApiImageDigest=$PLATFORM_DIGEST)
./scripts/deploy.sh OrgIQ-Social -e "${MW[@]}" "${MEDIA[@]}" "${SOCIAL[@]}"
aws ecs describe-services --cluster orgiq-middleware --services orgiq-social-platform-api \
  --query 'services[0].[desiredCount,runningCount]'   # CREATE_COMPLETE proves nothing

# 5. The middleware becomes the gateway now that redis.orgiq-social.local
#    resolves, and the token bridge learns the browser URLs.
MW+=(--context realtimeGateway=true
     --context realtimeGatewayUrl=wss://$MIDDLEWARE_HOST
     --context realtimePlatformPublicUrl=https://platform.$DOMAIN
     --context realtimeVideoPublicUrl=https://sfu.$DOMAIN)
./scripts/deploy.sh OrgIQ-MiddlewareService -e "${MW[@]}" "${MEDIA[@]}" "${SOCIAL[@]}"
```

From step 2 on, every middleware deploy must carry the social flags as
well. Without them the social stacks drop out of the app, and CDK tries to
delete the exports they still import. CloudFormation refuses that with
"Cannot delete export … in use", which is the same freeze as the
KnowledgeBase gotcha.

