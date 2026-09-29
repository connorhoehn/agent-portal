# Social calls: the local stack (`social` compose profile)

Step 2 of [the social-calls plan](social-calls-plan.md). One command brings up
the three services a call needs, built from the sibling checkouts, beside the
usual `dev:mock` middleware and portal. Written and verified 2026-09-28.

## What runs

| service | built from | host port (loopback) | what it is |
|---|---|---|---|
| `social-gateway` | `../realtime-examples` `Dockerfile`, target `server-runtime` | `18080` → 8080 | the websocket-gateway (`src/server.ts`): chat, presence, `call` relay, rooms |
| `social-platform-api` | `../platform-api/Dockerfile`, context `..` | `13001` → 3001 | video sessions and participant tokens (`src/routes/videoSessions.ts`) |
| `social-sfu` | `../live-video-streaming/Dockerfile` | `3901`, RTC `40000-40001/udp`, `40010-40011/tcp` | LVS, the mediasoup SFU |
| `social-redis` | `redis:7-alpine` | `6379` | call state, presence, pub/sub for all three |
| `social-dynamodb` | `amazon/dynamodb-local:3.3.1` (pinned digest), in-memory | `8000` | platform-api's `document-video-sessions` and the gateway's tables |
| `social-dynamodb-init` | the gateway image | — | one-shot: realtime-examples' `scripts/init-dynamodb.cjs` creates all 53 tables in its `infra/dynamodb-schemas.json` |
| `social-gateway-image` | — | — | builds the gateway image once so the init job can reuse it; exits at once |

DynamoDB is required, not optional: platform-api stores sessions in a table
and fails without one. The store is in-memory, so `down` (or any restart of
`social-dynamodb`) wipes every session; the init job recreates the tables on
the next `up`.

The builds mirror realtime-examples' own `docker-compose.local.yml` and
Tiltfile, and none of the sibling Dockerfiles were changed. They build from
each sibling's **working tree**, not a pinned commit, so the result is
whatever those checkouts hold right now. (`prepare-libraries.mjs` pins by
commit because it vendors npm libraries; these are whole services, and a
plain build context reaches them.) The platform-api context is the parent
directory `..`. BuildKit sends only the paths the Dockerfile COPYs, which
came to about 140 kB in practice.

## Run it

Prerequisites:

- `ssh-add -l` lists a GitHub key. The gateway and platform-api builds clone
  private `github:` pins over your forwarded ssh-agent.
- `GH_TOKEN` is exported. The LVS Dockerfile rewrites its pins to HTTPS and
  reads the token as the BuildKit secret `gh-token`.

```bash
export GH_TOKEN=$(gh auth token)
docker compose --profile social up -d --build \
  social-redis social-dynamodb social-gateway-image social-dynamodb-init \
  social-gateway social-platform-api social-sfu
```

Name the services. A bare `docker compose --profile social up` also starts
`jupyter`, `jupyter-gcp`, `middleware` and `portal`, because those have no
profile and so are always active.

Then run the app as usual, on the host:

```bash
cd middleware && npm run dev:mock     # :3001
cd portal && npm run dev              # :5183
```

Where the portal's socket goes (`portal/src/components/OptionalGatewayProvider.ts`):
`VITE_GATEWAY_URL` in `portal/.env.local`, when set, is a local override and
wins (restart Vite after changing it). Unset or blank, the portal takes
`gatewayUrl` from `GET /api/session/realtime-token` (the middleware's
`REALTIME_GATEWAY_URL`) at run time, which is how a deployed bundle works
with no build-time URL. Neither set means no socket (offline context). The
local middleware sets no `REALTIME_GATEWAY_URL` by default, so locally keep
`VITE_GATEWAY_URL=http://localhost:3001` in `.env.local`, or start the
middleware with `REALTIME_GATEWAY_URL=http://localhost:3001` and drop it.
(The gateway status badge and `useGatewayInfo` still read only
`VITE_GATEWAY_URL`; `/api/session/realtime-token` also carries
`platformApiUrl`, which the call host already prefers when
`VITE_PLATFORM_API_URL` is unset.)

**The middleware is the gateway now (2026-09-29).** With `REALTIME_GATEWAY=on`
(the default outside production) the middleware serves `ws://localhost:3001/ws`
itself — chat, presence and calls, verifying the realtime token and refusing
lobbies outside the caller's tenant — so `VITE_GATEWAY_URL=http://localhost:3001`
works and `social-gateway` can be left out of the `up` list. Set `REDIS_URL`
on the middleware (e.g. `redis://127.0.0.1:6379`, this profile's Redis) to
keep call state there; `/api/health` shows `realtime.store`. Walked in
[the first call, through the OrgIQ gateway](social-calls-first-call.md#through-the-orgiq-gateway-2026-09-29).
The `social-gateway` notes below describe realtime-examples' server.

Checks:

```bash
curl -s localhost:18080/health                                   # gateway
curl -s localhost:13001/health                                   # platform-api
curl -s -H 'Authorization: Bearer admin' localhost:3901/api/ice-servers   # SFU
docker compose --profile social ps
```

Stop it with `docker compose --profile social down`. Add `-v` to also drop the
recordings volume.

**It clashes with realtime-examples' Tilt stack.** Tilt serves the same
18080 and 13001 through kubectl port-forwards, and its `lvs-sfu` binds 3901
and the RTC ports. Run one stack or the other. If Tilt is up and you only
need to check this stack, move the two app ports with
`SOCIAL_GATEWAY_PORT=28080 SOCIAL_PLATFORM_API_PORT=23001`. The SFU ports
cannot move: platform-api hands the browser `http://localhost:3901`, and
mediasoup announces the port it binds. Both run on the same Docker daemon
(colima on this Mac), but they don't otherwise collide: containers are
`orgiq-social-*` and images are `orgiq-social-*:local`.

## Environment

`.env.social.example` lists every variable, its default, and what reads it.
Copy it to `.env.social` (gitignored) and pass
`--env-file .env.social` to override values. The shared secrets are local
literals that match realtime-examples' Tilt:

- `ADMIN_TOKEN` / `VIDEO_ADMIN_TOKEN` = `admin`
- `WEBHOOK_HMAC_SECRET` / `LVS_WEBHOOK_SECRET` = `dev-lvs-webhook-secret`
- `SERVICE_AUTH_SECRET` = `local-dev-service-auth-secret`

## Assessment documents on this profile (2026-09-29)

The assessment workspace opens its rich editor only when the middleware can
mint a **document grant** and a gateway and platform-api trust it. Plain
`dev:mock` has none of that, so `POST /api/assessment/knowledge/canvas`
answers 503 and the page falls back to the reader. One script wires both
sides ([parity plan](assessment-documents-parity-plan.md), Phase 0):

```bash
export GH_TOKEN=$(gh auth token)              # only if the images must be built
node scripts/social-documents.mjs up          # redis, dynamodb, gateway :28080, platform-api :23001
cd middleware && npm run dev:mock:social      # dev:mock + the document env, :3001
cd portal && npm run dev                      # :5183
```

- `.scratch/social-documents/settings.json` (gitignored, created on first run)
  holds one local Ed25519 pair, its issuer/key id, and a policy secret. The
  **private** key goes only to the middleware (`DOCUMENT_GRANT_PRIVATE_KEY`);
  the containers get the public key through the `SOCIAL_DOCUMENT_*`
  variables in `docker-compose.yml`, which default to empty — so a plain
  `--profile social up` behaves exactly as before.
- The middleware gets `DOCUMENT_GRANT_ISSUER/PRIVATE_KEY/KEY_ID`,
  `DOCUMENT_POLICY_SECRET`, `DOCUMENT_GATEWAY_PUBLIC_URL` and
  `DOCUMENT_GATEWAY_INTERNAL_URL` (`ws://127.0.0.1:28080`), and
  `DOCUMENT_PLATFORM_INTERNAL_URL=http://127.0.0.1:23001`.
  `node scripts/social-documents.mjs env` prints them as exports.
- Ports default to 28080/23001 so this runs beside realtime-examples' Tilt
  (18080/13001); override with `SOCIAL_GATEWAY_PORT` /
  `SOCIAL_PLATFORM_API_PORT`. The SFU is not started — documents do not need it.
- The gateway and platform-api call the middleware back on
  `/internal/document-grants/session` through `host.docker.internal`, so the
  middleware's port is baked in at `up`. Running the middleware elsewhere
  (e.g. a second one on 3011): `ORGIQ_BFF_PORT=3011 node scripts/social-documents.mjs up`
  and `ORGIQ_BFF_PORT=3011 npm run dev:mock:social`, then a Vite with
  `API_PROXY_TARGET=http://127.0.0.1:3011`.
- Check: sign in, then `POST /api/assessment/knowledge/canvas {"id":"page:100002"}`
  returns `{documentId, gatewayUrl:"ws://127.0.0.1:28080", token, canEdit, …}`
  and `GET /api/assessment/knowledge/doc/workflows?id=page%3A100002` returns
  the lifecycle. DynamoDB is in-memory: `down` or a restart of
  `social-dynamodb` drops the seeded canvases; the middleware's mock mapping
  is in memory too, so restart both together.
- `node scripts/social-documents.mjs down` stops them (the image-builder
  one-shot is left alone).

## The SFU in a container, and the trade-off

realtime-examples' Tiltfile runs the SFU as a **host process** (its `lvs-sfu`
local_resource), not in the VM. Its comment gives the reason: colima's `vz`
networking forwarded the mediasoup UDP ports unreliably, and calls lost
media. This profile keeps a container so the stack is one command. Since
Docker here is colima, not Docker Desktop, that same risk applies:

- RTC ports are published 1:1 on 127.0.0.1, and the SFU announces
  `127.0.0.1`. Each worker has a TCP candidate (40010/40011) as well as UDP.
  Colima's TCP forwarding is reliable, so ICE can fall back to TCP if UDP
  doesn't get through.
- Host networking (`network_mode: host`) doesn't help. On colima and Docker
  Desktop it means the VM's network, not the Mac's.
- To call from another device, set `SOCIAL_MEDIASOUP_ANNOUNCED_IP` to the
  Mac's LAN IP and publish the RTC ports on that interface. That departs
  from the loopback rule, so do it deliberately.

**Host-SFU variant** (Tilt's arrangement), if container media misbehaves:

1. `docker compose --profile social stop social-sfu`.
2. From `../live-video-streaming`, run the SFU with Tilt's `lvs-sfu` env
   (Tiltfile, `local_resource('lvs-sfu', …)`), setting
   `REDIS_URL=redis://localhost:6379`:
   `PORT=3901 ADMIN_TOKEN=admin LVS_AUTH_BYPASS=true NODE_ENV=development COGNITO_USER_POOL_ID=us-east-1_localdev000 WEBHOOK_HMAC_SECRET=dev-lvs-webhook-secret WEBHOOK_FORMAT=bare SEED_NODES= IS_DASHBOARD=true REDIS_URL=redis://localhost:6379 MEDIASOUP_RTC_PORT=40000 MEDIASOUP_RTC_TCP_PORT=40010 MEDIASOUP_ANNOUNCED_IP=127.0.0.1 MEDIASOUP_ANNOUNCED_IP_TCP=127.0.0.1 MEDIASOUP_RTC_TCP_PORT_PER_POD=false MEDIASOUP_WORKERS=2 ENABLE_UDP=true node src/server.js`
3. Recreate platform-api pointed at the host:
   `SOCIAL_VIDEO_API_URL=http://host.docker.internal:3901 SOCIAL_LVS_WEBHOOK_BOOTSTRAP_URL=http://host.docker.internal:13001/hooks/lvs/recording docker compose --profile social up -d social-platform-api`.
   That webhook URL has not been tried.

## Identity: what these services accept today

**Update 2026-09-29: calls need no bypass.** platform-api verifies the OrgIQ
realtime token itself (`REALTIME_JWT_SECRET`, compose default
`orgiq-dev-realtime` = the middleware's dev secret, override
`SOCIAL_REALTIME_JWT_SECRET`) and calls the SFU's session routes with a service
token (`VIDEO_SERVICE_TOKEN` = the SFU's `LVS_SERVICE_TOKEN`, both
`SOCIAL_LVS_SERVICE_TOKEN`, default `local-dev-lvs-service-token`). Run
without the bypasses with `SOCIAL_PLATFORM_SKIP_AUTH=false
SOCIAL_LVS_AUTH_BYPASS=false`; they still default to `true` because the other
platform-api surfaces and the documents path were not re-walked without them.
Even with `SKIP_AUTH=true`, an HS256 bearer is verified when the secret is set,
so a forged OrgIQ token is a 401 rather than decoded. Walked in
[the first call § Verified tokens](social-calls-first-call.md#verified-tokens-no-bypasses-2026-09-29).
The rest of this section describes the bypass mode.

All three run with their auth **bypassed**: `SKIP_AUTH=true` on the gateway
and platform-api, and `LVS_AUTH_BYPASS=true` on the SFU. Each one refuses
that setting under `NODE_ENV=production`. In this mode:

- **Gateway** (`realtime-examples/src/middleware/auth-middleware.ts`,
  `AuthMiddleware.validateToken`). The token is read from
  `Sec-WebSocket-Protocol: bearer-token-v1, <jwt>` and `jwt.decode`d with
  **no signature check**:
  - `sub` becomes the user id.
  - `email` is used if present.
  - Display name comes from `given_name` + `family_name`, falling back to
    `email`. **It does not read a `displayName` claim.**
  - The org comes from the first of `custom:orgId`, `orgId`, `org_id`,
    `org`, `custom:org_id`. So `org` works.
  - `tenants`, `role`, `iss` and `aud` are ignored. Every SKIP_AUTH
    connection is `isAdmin: true`.
- **platform-api** (`platform-api/src/middleware/auth.ts`, `requireAuth`).
  `Authorization: Bearer <jwt>` is decoded without verification:
  - `sub`, `email` and the same org claim list are read.
  - `displayName` for a call participant comes from the **request body** of
    `POST /api/video/sessions` and `/join`, not the token.
  - A request with no bearer runs as `dev-user` with no org.
- **SFU.** The browser presents the participant token that platform-api
  mints. Admin routes take `Bearer <ADMIN_TOKEN>`.

So the middleware's planned HS256 token
`{ sub, displayName, org, tenants, role, iss:'orgiq-middleware', aud:'realtime' }`
is **accepted but not verified**. Until the gateway changes, the token
bridge should also set `given_name` and `family_name` (or `email`) so the
gateway shows a name. Any string that decodes as a JWT gets in, so nothing
here is a security boundary. `REALTIME_JWT_SECRET` is not read by anything
in this stack.

**Production needs one of two things.** Option 1 is now done for the
gateway, by the middleware's own `/ws` rather than in realtime-examples'
server (see above); platform-api and the SFU still need it:

1. **Our own verifier on the gateway.** Today the verified path in
   `AuthMiddleware.validateToken` accepts only Cognito RS256 tokens: JWKS
   from `COGNITO_REGION` / `COGNITO_USER_POOL_ID`, `algorithms: ['RS256']`,
   issuer = the pool URL. It has no HS256 or shared-secret option, and no
   env var changes that. Two ways to add one:
   - A gateway wrapper that owns the server and passes its own `auth` to
     realtime-modules' `attachRealtime(httpServer, { features, auth })`,
     which verifies HS256 against `REALTIME_JWT_SECRET` with
     `iss`/`aud` checks.
   - An HS256 branch in `validateToken`.

   platform-api needs the same change in `requireAuth` / `optionalAuth`
   (`src/middleware/auth.ts`), which are also Cognito-RS256-only. Note that
   realtime-examples' server does **not** call `attachRealtime` today. It
   wires its services directly in `src/server.ts`, so the wrapper option
   means a separate entry point.
2. **Cognito tokens from our pool.** Point both services'
   `COGNITO_REGION` / `COGNITO_USER_POOL_ID` at `OrgIQ-Authentication`'s
   pool and pass the user's Cognito ID token. That only works for SSO
   sessions; the demo user picker has no Cognito token to pass.

## What was verified (2026-09-28, colima, arm64)

- `docker compose --profile social config -q` is valid. With no profile,
  the service list is unchanged: jupyter, jupyter-gcp, middleware, portal.
- All three sibling images built. The only build failure was ours: the
  compose secret was first named `social-gh-token`, and the LVS Dockerfile
  mounts `id=gh-token`. It is now `gh-token`.
- The init job created 53 tables. Gateway, platform-api and SFU all
  reported healthy within about 10 s. This run used ports 28080/23001
  because Tilt held 18080/13001.
- Gateway `GET /health` returned 200, `"status": "healthy"`, Redis
  connected, and `enabledServices` including `call`.
- platform-api `GET /health` returned 200:
  `{"status":"degraded", checks: dynamodb ok, redis ok, build ok, model degraded — "no ANTHROPIC_API_KEY"}`.
  The model check is for pipelines, not calls.
- SFU `GET /api/ice-servers` with `Bearer admin` returned 200:
  `{"iceServers":[],"iceTransportPolicy":"all"}`. The list is empty
  because no TURN is configured (`LVS_TURN_URL` unset), so it relies on
  direct host candidates. The route also answered without a bearer.
- An HS256 token `{ sub:'u-ada', displayName, org:'orgiq', tenants, role, iss, aud }`
  worked end to end:
  - `POST /api/video/sessions` returned 201. platform-api created the LVS
    channel `arn:local:ivs:channel/…` on the SFU.
  - `/join` returned 200 with a participant token.
  - `GET /sessions/:id?lobbyName=` showed `orgId:"orgiq"` and the
    participant `u-ada` named "Ada Lovelace" (from the body).
  - `/end` returned `{"ended":true}`.
- A WebSocket connect with `bearer-token-v1, <that token>` got
  `session connected`, and the gateway logged
  `[SKIP_AUTH] Accepting connection for user: u-ada`.

## Not verified

- **Media.** No browser published or subscribed, so whether UDP reaches the
  containerized SFU through colima, and whether TCP ICE takes over when it
  doesn't, is untested.
- The `call` invite/accept relay between two gateway connections.
- Recording webhooks: LVS → `social-platform-api:3001/hooks/lvs/recording`.
- The host-SFU variant.
- Running on the default ports 18080/13001, which Tilt held during the
  test.
- Running on Docker Desktop rather than colima.
