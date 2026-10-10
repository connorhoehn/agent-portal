# Social calls: the first call (2026-09-29)

Step 5 of [the social-calls plan](social-calls-plan.md), walked end to end: two
OrgIQ users in one call from an initiative page, against the local `social`
stack ([guide](social-calls-local-stack.md)). **Signalling, the platform-api
session and media all worked**, including video through the SFU, both ways.

## What was run

| piece | where | notes |
|---|---|---|
| middleware | `:3001`, `npm run dev:mock` (already running) | `REALTIME_JWT_SECRET` unset → dev secret; `PLATFORM_API_URL` unset |
| websocket-gateway | `social-gateway` on **`:28080`** | `SOCIAL_GATEWAY_PORT=28080`: realtime-examples' Tilt stack held 18080 |

Known limit (2026-10-06): the `orgiq-media-validation-platform-api` container exited 134 (JavaScript heap out of memory) after repeated two-browser media runs; `docker start` restores it and `/health` returns 200 within seconds. Check it first when the forwarded :23002 answers with ECONNRESET.
| platform-api | `social-platform-api` on **`:23001`** | `SOCIAL_PLATFORM_API_PORT=23001`, same reason |
| SFU | the **host** SFU on `:3901` (Tilt's `lvs-sfu`, `node src/server.js`) | Tilt held 3901, which cannot move, so `social-sfu` was not started. `SOCIAL_VIDEO_API_URL=http://host.docker.internal:3901` — the guide's host-SFU variant, and Tilt's own arrangement |
| portal | a second Vite on **`:5184`** | `VITE_GATEWAY_URL=http://localhost:28080 VITE_PLATFORM_API_URL=http://localhost:23001 VITE_VIDEO_ENDPOINT=http://localhost:3901`; `portal/.env.local` untouched |

```bash
export GH_TOKEN=$(gh auth token)
SOCIAL_GATEWAY_PORT=28080 SOCIAL_PLATFORM_API_PORT=23001 \
SOCIAL_VIDEO_API_URL=http://host.docker.internal:3901 \
docker compose --profile social up -d --build \
  social-redis social-dynamodb social-gateway-image social-dynamodb-init \
  social-gateway social-platform-api
```

Browsers: Playwright chromium, two contexts, `--use-fake-ui-for-media-stream
--use-fake-device-for-media-stream`, camera + microphone granted, signed in
through `POST /api/session/login`.

**Cast.** No seeded initiative has both Vera (`p-002`) and Theo (`p-001`) as
owner/SME, so the walk used **Auth Migration** (`p-auth-migration`): owner Vera
Green (`u-vera`, org-leader) and SMEs Nora DaSilva (`p-004` → `u-nora`, sme) and
Nora Chang (`p-051`, no `app_users` row). Nora Chang is the "unlinked
contributor" case.

## Steps and what was observed

1. **No stack (`:5183`).** Start call renders disabled, hover text "Calls need
   platform-api — set VITE_PLATFORM_API_URL (or PLATFORM_API_URL on the
   middleware)". No console errors. `00-no-stack-disabled.png`.
2. **Vera opens `/iq/projects/p-auth-migration` (`:5184`).** The socket
   authenticates with the realtime token and gets `session connected`
   (`enabledServices` includes `call`). `GET /api/roster/users?personIds=p-002,p-051,p-004`
   → Vera and Nora DaSilva mapped, `p-051` unlinked. The call host sends
   `{service:'call', action:'status', lobbyName:'orgiq:dm:u-nora:u-vera'}` and the
   gateway answers `active-call … active:false`. Start call is enabled; its
   hover text reads "Call Nora DaSilva — Nora Chang has no OrgIQ sign-in in
   this workspace, so the call will not ring them." `01-vera-initiative.png`.
3. **Vera clicks Start call.** Dock: "Connecting…" for ~0.5 s while
   `POST /api/video/sessions` (201) and `/join` (200) run, then **"Calling Nora
   DaSilva…"** with Cancel. The invite frame is targeted:
   `{action:'invite', lobbyName:'orgiq:dm:u-nora:u-vera', callerId:'u-vera',
   targetUserIds:['u-nora'], channel:'initiative:p-auth-migration'}`.
   `02-vera-calling.png`.
4. **Nora's shell shows the toast** "Vera Green is calling · Video call ·
   Decline / Accept" within ~10 ms of the invite. `03-nora-ringing.png`.
5. **Accept.** Nora sends a targeted `accepted`, joins the same platform-api
   session (`POST /sessions` 200 = found, `/join` 200). Both docks go
   `Connecting…` → **"2 people · 00:04"** with two tiles. WHIP publish (201)
   on both sides ~3 s after joining, WHEP subscribe (201) ~3 s after that.
6. **Media.** Every tile had a playing `<video>` at **640×480**
   (`readyState 4`, not paused) on both sides — the fake camera's picture
   through the host SFU. `04-vera-live.png`, `05-nora-live.png`. The unlinked
   notice sits above the shelf during the call.
7. **Vera leaves.** She sends `user-status left/hung-up` to Nora and an
   `ended` frame targeted at herself, then `POST …/end` (200). **In a
   two-person call, one Leave ends it for both**: both docks show "Call ended ·
   Dismiss" for ~3 s, then idle. `06`/`07`.
8. **Ring on another page, Decline.** Nora on `/iq/projects` (the list) gets
   the toast (`08-nora-ringing-elsewhere.png`). Decline sends a targeted
   `declined`; Vera's dock goes straight to "Call ended" and her session is
   ended (`/end` 200). `09-vera-after-decline.png`.
9. **Ring on another page, Accept.** Accept navigates Nora to
   `/iq/projects/p-auth-migration` (from the invite's `channel`) and joins;
   both reach "2 people" within ~4 s. `10-nora-accepted-from-list.png`.
10. **Nora leaves** — same as step 7 in the other direction: both end.

## What this did not prove

- **The container SFU.** The walk used the host SFU (Tilt's), so whether
  mediasoup UDP gets through colima's forwarding from `social-sfu` is still
  untested. Media over the host SFU is proven.
- **Default ports 18080/13001**, and a third participant (an initiative with
  two linked SMEs besides the caller).
- **Tenant isolation.** The lobby is prefixed `orgiq:`, but nothing enforced
  it: the gateway was realtime-examples' server, not ours, so
  `calls({ lobbyGuard })` was not wired. *Gateway half since shipped — see
  [Through the OrgIQ gateway](#through-the-orgiq-gateway-2026-09-29) below;*
  platform-api still treats any non-document lobby as ad hoc.
- **Recording webhooks** and `useIncomingConversationCalls`' TTL path (a ring
  left to age out).

## Noise seen, not caused by this change

- `fetch http://localhost:28080/health` blocked by CORS on every page load —
  a probe to the gateway's origin; the gateway sends no CORS header.
- `DELETE …/whip/<id>` and `…/whep/<id>` answer 404 on leave: the SFU had
  already dropped the resources.
- After a Decline: `[lvs] publish failed: … signalingState is 'closed'` — the
  caller's WHIP publish racing the teardown.

## One fix found on the way

The first load of any `/iq` page after a cache clear made Vite discover
`@connorhoehnslalom/realtime-modules/client/video`, re-optimize mid-session,
and render once against a second React copy ("Invalid hook call" in
`LVSProvider`). `portal/vite.config.ts` now lists that entry in
`optimizeDeps.include`; the second walk had no such error.

## Through the OrgIQ gateway (2026-09-29)

The same walk with **no realtime-examples gateway at all**: the middleware
serves `/ws` itself (`middleware/src/lib/realtime-gateway.ts`, on by default
outside production, `REALTIME_GATEWAY=on|off`), verifies the realtime token it
minted, and refuses lobbies outside the caller's tenant. Screenshots are the
`gw-*.png` files in [`social-calls-first-call/`](social-calls-first-call/).

| piece | where | notes |
|---|---|---|
| middleware + gateway | `:3001`, `npm run dev:mock` | `/api/health` → `realtime: {gateway:'on', store:'memory'}` |
| second middleware (Redis run) | `:3011`, dev:mock env + `REDIS_URL=redis://127.0.0.1:6379` | `realtime: {gateway:'on', store:'redis'}` |
| platform-api | `social-platform-api` on `:23001` | 13001 held by realtime-examples' Tilt port-forward |
| SFU | the host SFU on `:3901` | as in the first walk |
| Redis, DynamoDB | `social-redis`, `social-dynamodb` (+ init) | |
| `social-gateway` | **not started** | |
| portal | second Vite on `:5184` | `VITE_GATEWAY_URL=http://localhost:3001` (then `:3011`), `VITE_PLATFORM_API_URL=http://localhost:23001`, `VITE_VIDEO_ENDPOINT=http://localhost:3901` |

```bash
SOCIAL_PLATFORM_API_PORT=23001 SOCIAL_VIDEO_API_URL=http://host.docker.internal:3901 \
docker compose --profile social up -d \
  social-redis social-dynamodb social-gateway-image social-dynamodb-init social-platform-api
```

**What passed** (Playwright chromium, two contexts, fake media; the same
cast as above), once against the memory store on `:3001` and once against the
Redis store on `:3011`:

1. Vera opens `/iq/projects/p-auth-migration`. Her only gateway socket is
   `ws://localhost:3001/ws`; it gets the library's `{type:'session',
   status:'connected'}` frame, and the `status` query for
   `orgiq:dm:u-nora:u-vera` is answered (`active-call`). `gw-01`.
2. Start call → targeted `invite` (`targetUserIds:['u-nora']`,
   `channel:'initiative:p-auth-migration'`); Nora, on `/iq/projects`, gets the
   toast. `gw-02`, `gw-03`.
3. Accept → both docks "2 people" within ~3.5 s; every tile a playing
   640×480 `<video>` on both sides. `gw-04`, `gw-05`.
4. **Forged frame.** A raw `ws` client holding Vera's own realtime token sends
   `invite` for `assessment:dm:u-nora:u-vera` targeting Nora. The gateway
   answers `{type:'error', service:'call', message:'Not authorized for call
   action: invite'}`, Nora's socket receives nothing, and the middleware logs
   `[realtime-gateway] refused lobby 'assessment:dm:u-nora:u-vera' for user
   'u-vera' (org 'orgiq')`. A `status` query for that dm from Theo (not in it)
   is refused the same way.
5. Vera clicks Leave → both docks "Call ended". `gw-06`, `gw-07`.

In the Redis run the call state is visibly in `social-redis`
(`call:active:<id>`, `call:lobby:orgiq:dm:u-nora:u-vera`, `call:user:*`,
`client:calls:*`, `call:accepted:<id>`).

**What did not / what was seen:**

- **A call can outlive its Leave in the gateway's state.** After Leave and
  both browsers closing, `status` for the lobby still answered `active:true,
  participantCount:1` (memory and Redis alike; in Redis the call hash and
  one participant client id remain with a ~4 h TTL). The next Start call
  still rang and connected, so it did not block the walk. This is
  realtime-modules' `CallService` bookkeeping, not the guard — to report to
  the library.
- **A fresh Vite reloads the page mid-call.** The first walk against a
  just-started `:5184` ended with both sides sending `user-status left /
  unload` right after Accept: Vite's `full-reload` (dependency discovery on
  first load). The re-run against the warm server passed. Warm Vite before a
  timed walk.
- Unchanged noise: the WHIP/WHEP `DELETE` 404s on leave.

**Still open for production** (deploy-plan risk #2): platform-api and the
SFU still verify only Cognito tokens (locally `SKIP_AUTH` / `LVS_AUTH_BYPASS`),
platform-api still treats any non-document lobby as ad hoc, chat/presence
channels are not tenant-scoped, and the router is single-process (Redis holds
call state, not cross-replica fan-out).

## Verified tokens, no bypasses (2026-09-29)

The same two-person walk with **every auth bypass off**: platform-api verifies
the OrgIQ realtime token itself and calls the SFU as a service, so neither
`SKIP_AUTH` nor `LVS_AUTH_BYPASS` is set, and the Cognito pool id is a fake
one that verifies nothing. Upstream: platform-api `416df6d9`, live-video-streaming
`cc28d028` (deploy plan §8).

| piece | where | notes |
|---|---|---|
| middleware + gateway | a second one on `:3011` (dev:mock env, no watch) | `REALTIME_JWT_SECRET` unset → the dev secret |
| platform-api | clone container `orgiq-verify-platform-api` on `:23003` | new image; `SKIP_AUTH=false`, `REALTIME_JWT_SECRET=orgiq-dev-realtime`, `VIDEO_SERVICE_TOKEN=local-dev-lvs-service-token`, `VIDEO_API_URL=http://host.docker.internal:23901` |
| SFU | the new LVS working tree on the **host**, `:23901` (web `:22020`), RTC `41000-41001`/`41010-41011` | `LVS_AUTH_BYPASS=false`, `LVS_SERVICE_TOKEN` as above, `COGNITO_USER_POOL_ID=us-east-1_localdev000` |
| Redis, DynamoDB | clone containers (own compose project `orgiq-verify`) | |
| portal | a Vite on `:5186` | `API_PROXY_TARGET=http://127.0.0.1:3011 VITE_GATEWAY_URL=http://localhost:3011 VITE_PLATFORM_API_URL=http://localhost:23003 VITE_VIDEO_ENDPOINT=http://localhost:23901` |

The clones came from this repo's `social` profile with a throwaway override
file (own project name, container names, ports and image tags) and
`SOCIAL_PLATFORM_SKIP_AUTH=false SOCIAL_LVS_AUTH_BYPASS=false`; the shared
`orgiq-social-*` containers were left alone.

**Refused by platform-api** (`POST /api/video/sessions`, tokens minted with
`jose` like the middleware's): wrong secret → 401 `Invalid token`; expired →
401 `Token expired`; `tokenKind: 'cognito'` → 401 `Invalid token`; no bearer →
401. Each refusal logs `OrgIQ realtime token refused` with the reason (`invalid
signature`, `jwt expired`, `not an orgiq realtime token`). A valid token for
`assessment:dm:u-nora:u-vera` (another tenant) or `orgiq:dm:u-nora:u-theo`
(not a participant) → 404 `Session not found`; for `orgiq:dm:u-nora:u-vera` →
201. The same valid user token sent straight to the SFU's `POST /api/sessions`
→ 401 `auth_failed`.

**The walk.** `CALL_BASE_URL=http://localhost:5186 CALL_SFU_URL=http://localhost:23901 npx playwright test e2e/initiative-call.spec.ts`:
ring → accept → both docks "2 people" with a playing `<video>` on each side →
Leave ends it for both; and the decline case. Passed twice in a row.

**No user bearer reached the SFU.** Over those runs its log has 64 ×
`service token accepted (no user bearer)` (20 on `POST /api/sessions`, 20 on
`/join`, 24 on `/end`), **zero** `Cognito JWT verification failed` and zero
`LVS_AUTH_BYPASS active` lines; the only Cognito attempt in the whole session
was the deliberate direct probe above, against the earlier container SFU.

**What did not work: the container SFU.** With `orgiq-verify-sfu` in colima,
both sides reached "Connecting…" and stayed there: the SFU logged ICE
connected, then `ICE connectivity lost` about two seconds later, for every
transport. Auth was fine (the same service-token lines). Moving the same code
to the host fixed it, which is the colima UDP-forwarding risk the local-stack
guide describes. The first host run also failed once with "Execution context
was destroyed" while probing video, then passed twice; not reproduced.

## Tilt stack

`tilt up` can carry real huddle media on the local stack. The root `Tiltfile`
adds a `platform-api-forward` resource (label `media`): an SSH forward into the
Colima VM for the media-validation platform-api (`127.0.0.1:23002`) and its SFU
Redis (`16480`). It copies the capacity forwarder's key and options but is a
separate process; never touch that forwarder or the default colima socket.

The middleware resource reads the gitignored `middleware/.env.tilt.local`
(a JSON object, mode 600) and adds it to its environment. Keys:
`REALTIME_JWT_SECRET` (must equal the platform-api container's value; copy it
from `docker inspect` on the capacity socket, never print or commit it),
`REALTIME_PLATFORM_PUBLIC_URL=http://127.0.0.1:23002`,
`REALTIME_VIDEO_PUBLIC_URL=http://127.0.0.1:3902`, and
`SOCIAL_PLATFORM_INTERNAL_URL` / `DOCUMENT_PLATFORM_INTERNAL_URL`. Without the
file the stack runs as before, with no media. The native SFU (`:3902`, host
process) must already be running; Tilt does not manage it.

Check: `GET /api/session/realtime-token` returns `platformApiUrl` and
`videoUrl`. Run from `portal/`:
`REAL_MEDIA_ACCEPTANCE=1 PARITY_BASE_URL=http://127.0.0.1:5183 npx playwright test e2e/huddle-media-real.spec.ts --project chromium`

### Document canvas on the Tilt stack (2026-10-06)

The assessment document canvas needs three things the media-validation
platform-api (`:23002`) does not provide: the document **gateway** socket
(`ws://…:28080`, what `connectDocumentCanvas` seeds and the browser dials),
the labelled **social** platform-api (`:23001`, the comments/workflows backend
that trusts the same grant key), and the `DOCUMENT_GRANT_*` signing settings.
Without them every canvas, comments and presence call answers 503.

- Tiltfile: a `social-docs-forward` resource (label `media`) forwards `28080`
  and `23001` from the Colima VM, same key/options as `platform-api-forward`.
- `middleware/.env.tilt.local` (JSON, mode 600, never print): add
  `DOCUMENT_GRANT_ISSUER`, `DOCUMENT_GRANT_KEY_ID`, `DOCUMENT_GRANT_PRIVATE_KEY`
  and `DOCUMENT_POLICY_SECRET` from `.scratch/social-documents/settings.json`
  (the same file the containers were built from), `DOCUMENT_GATEWAY_PUBLIC_URL`
  and `DOCUMENT_GATEWAY_INTERNAL_URL=ws://127.0.0.1:28080`, and
  `DOCUMENT_PLATFORM_INTERNAL_URL=http://127.0.0.1:23001`. Leave
  `SOCIAL_PLATFORM_INTERNAL_URL` and `REALTIME_PLATFORM_PUBLIC_URL` on `:23002`
  so huddle media is untouched.
- The `orgiq-social-*` containers showed "unhealthy" because their
  `orgiq-social-redis` and `orgiq-social-dynamodb` had exited (255) when the VM
  restarted; DynamoDB Local is in-memory so its tables were gone. Recovery, on
  the capacity socket only: `docker start orgiq-social-redis
  orgiq-social-dynamodb`, `docker start -a orgiq-social-dynamodb-init`
  (recreates the tables), then `docker restart orgiq-social-gateway
  orgiq-social-platform-api` (the gateway returned `SERVICE_INTERNAL_ERROR` on
  seed until restarted). Both then report healthy.
- Check: as u-farah in the assessment tenant, `POST /api/assessment/knowledge/canvas`
  with `{"id":"page:100002"}` returns a `gatewayUrl` and token, not 503.
