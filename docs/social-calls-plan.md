# Social chat with calls in OrgIQ: what it takes, in order

Written 2026-09-28 from two answers by the realtime-examples / realtime-modules
sessions (verified against their code that evening) plus this repo's pins.
The ask: the realtime-examples social chat composer with a docked call,
working on the Search workspace and on initiative pages, and eventually
social features across tenants so teammates work on tasks together and
share.

## The premise, corrected

**The video is not AWS IVS.** realtime-examples runs calls on **LVS**, the
self-hosted mediasoup SFU in `~/Projects/live-video-streaming` (WHIP/WHEP,
an IVS-shaped API with `arn:local:ivs:channel/<id>` ARNs, `node
src/server.js` on :3901, admin Bearer, `/api/ice-servers` for TURN). The
browser reaches it through `@connorhoehn/lvs-react` (`LVSProvider baseUrl`,
`VITE_VIDEO_ENDPOINT`) and `lvs-client`, which realtime-examples consumes as
`file:../../live-video-streaming/packages/*` — there is no npm publish.
ui-components' `video-ivs` entry is an older, unrelated surface; nothing in
the chat/call path uses it. No AWS resources are needed for a call.

## The stack a call needs (all of it, running)

| piece | what | where | env |
|---|---|---|---|
| websocket-gateway | `attachRealtime(httpServer, { features: [chat(), presence(), calls(), …], auth })` from `@connorhoehn/realtime-modules/server`; relays `{service:'call', action: invite\|accepted\|declined\|leave\|status\|meta}`; Redis-backed for replicas | realtime-examples `src/` (`src/server/attach.ts:211`) — our `VITE_GATEWAY_URL` :18080 is exactly this | `VITE_WS_URL` on the client |
| platform-api | owns video sessions and mints participant tokens: `POST /api/video/sessions` → `stageToken`, `POST /api/video/sessions/:id/end`, `GET …/:id?lobbyName=`, `GET …/document/:id` | `~/Projects/platform-api src/routes/videoSessions.ts`, `internal-video-sessions.ts`, `callLog.ts`; :13001 | `VIDEO_API_URL`, `VIDEO_PUBLIC_URL`, `VIDEO_ADMIN_TOKEN`, `LVS_WEBHOOK_SECRET`, `LVS_WEBHOOK_BOOTSTRAP_URL`, `VIDEO_SESSION_STALE_MS` |
| LVS SFU | the media server | `~/Projects/live-video-streaming`, :3901; realtime-examples' Tiltfile runs it as the `lvs-sfu` local_resource | `ADMIN_TOKEN`, `MEDIASOUP_ANNOUNCED_IP`, `MEDIASOUP_RTC_PORT`, `MEDIASOUP_RTC_TCP_PORT`, `MEDIASOUP_WORKERS` |

Identity, as the code actually has it (survey 2026-09-28): the gateway
realtime-examples runs takes a **Cognito ID token** over the
`Sec-WebSocket-Protocol: bearer-token-v1, <jwt>` subprotocol and verifies it
against the pool's JWKS (`src/middleware/auth-middleware.ts`); platform-api
takes `Authorization: Bearer <cognito id_token>` (`requireAuth`); both have a
`SKIP_AUTH=true` dev bypass; the `userId` the gateway derives is the token's
`sub`, and lobby names must match it. realtime-examples' server does not call `attachRealtime`; it wires the
services itself in `src/server.ts`, so a gateway *we* deploy needs its own
entry point with a verifier for our token. OrgIQ's BFF verifies the Cognito
id_token at login and then discards it (`middleware/src/routes/auth.ts:111`
→ `mintSession`), so the browser holds only `orgiq.session`. **Token
bridge**, therefore: a middleware endpoint that mints a short-lived HS256 JWT
(`sub` = `app_users.id`, `external_sub` when known, `displayName`, `org` =
tenant, `tenants`, `role`) from the session; locally the gateway and
platform-api run with `SKIP_AUTH` and read identity from its claims; in
production either our own gateway wrapper verifies it, or the BFF retains the
Cognito id_token at login and hands that out. Lobby access
(`platform-api/src/lib/lobbyAccess.ts`): a lobby name that is not a
platform-api document is ad hoc and any authenticated user can join it —
tenant scoping of lobby names has to be enforced there, not only chosen by
the client.

## What the UI is made of (ui-components, all shipped)

- `social/ChatPanel` — transcript + `composer` slot + `dock` slot (2.400.0;
  the call shelf renders between the messages and the composer, testid
  `chat-panel-dock-slot`).
- `social/ConversationSurface` — header with `onStartCall(audioOnly)`,
  `callInProgress`, a `canvas` slot above the transcript.
- `video/CallDock` — the shelf: `phase` (`calling` with `callingTo` since
  2.404.0), `participants: CallDockParticipant[]`, `mic`/`camera`
  (`DeviceToggleSelect` props), `screenShare`, `extras`, `onLeave`,
  `onPopOut`, `error`, `compact`; `documents` optional; controls wrap to the
  dock's own width (2.404.0).
- `doc-editor/VideoDockSlot` (drop target while a call floats),
  `video/CallSidePanel` + toggles, `CallTileRow`, `ParticipantTile`,
  `StreamVideo`, `IncomingCallToast` (app code today).
- Our composer stays `AgentComposerDock` (2.403.0): it is what
  `ChatPanel.composer` receives on Search and on initiatives. **Gap:** it has
  no `dock` slot above the composer the way `ChatPanel` does — a `dock?:
  ReactNode` on `AgentComposerDock` is a library change before any page
  docks a call over it.

The mapping from live call state onto `CallDockProps` is 170 lines:
realtime-examples `frontend/src/components/hangout/HangoutShelfDock.tsx`.
The call state itself is **app code in realtime-examples**, not library:
`providers/HangoutDomainProvider.tsx` (openHangout, callUsers, activeSession,
`VideoDockTarget` registry), `components/hangout/HangoutOverlay.tsx`
(~3.5k lines), `hooks/useVideoCall.ts` (session create/end), `useIncomingCalls.ts`,
`useHangoutMachine.ts`, `useDevicePreferences.ts`. The thinner, library-backed
path is document calls: `@connorhoehn/realtime-modules/client/video`
`useDocumentCall` / `useIncomingDocumentCalls` / `useLVSHangout` /
`useMediaDevices` / `useAudioVideoSettings`, bound by
`components/doc-editor/call/{DocumentCallController,CallDockBinding}.tsx`
(spec: realtime-examples `docs/design/document-calls/SPEC.md` §4–5, the
wire contract and where state lives with two replicas).

## Where this repo stands

- ui-components **2.405.2** — ahead of what realtime-examples pins (2.405.0);
  every composite above is installed.
- realtime-modules: the **middleware** is on **0.97.12 @ b7b29fbf** (the
  exact sha realtime-examples pins; bumped 2026-09-28 — typecheck and all
  jest suites green with no source changes, since `agent-streaming`,
  `server` and `adapters/tiptap` did not change shape). The **portal** is
  still on **0.69.4 @ 99eb8c3b**, which has none of the `/client/video` or
  `/call` entry points; its bump (it imports `proxy-client` and
  `agent-streaming/client`) is the remaining half of step 1.
- No websocket-gateway, platform-api or SFU in `docker-compose`; the mock
  middleware has no `/ws` (the portal's gateway provider already tolerates
  that). `docs/realtime-middleware-deployment-research-2026-09-20.md` is the
  prior research on running the realtime middleware through CDK.
- Users are `app_users` with tenant grants in a signed cookie; the only JWT
  the BFF mints is the step-3 realtime token.

## The plan, in order

1. **Dependencies — middleware half SHIPPED 2026-09-28.** The middleware
   pins realtime-modules `b7b29fbf` (0.97.12, the sha realtime-examples
   pins and origin/main's head); `agent-streaming`, `server` and
   `adapters/tiptap` were unchanged between 0.69.4 and 0.97.12, so no
   route edits were needed and all 339 suites pass. Still open: the
   **portal** pin (still 0.69.4 @ 99eb8c3b; bump when the 0.98.0 sha with
   `useConversationCall` lands so it is one move), and the two LVS
   packages — npm cannot `github:` a monorepo sub-package, so publish
   them or vendor `packages/lvs-react` + `packages/lvs-client` the way
   realtime-examples' `file:` links do (decide with the library owner);
   confirm whether realtime-modules bundles or peer-depends on lvs-react
   before pinning.

2. **Run the stack locally — SHIPPED 2026-09-28** as the `social` profile in
   `docker-compose.yml` (`docs/social-calls-local-stack.md`): Redis, DynamoDB
   Local + realtime-examples' table init, the gateway, platform-api and the
   SFU built unchanged from the sibling checkouts; verified: gateway and
   platform-api healthy, an HS256 token creates a session, creates the SFU
   channel and joins (participant token), `orgId` recorded. Not verified:
   media between two participants (the SFU runs in a colima container with
   RTC ports on loopback — Tilt runs it on the host for a reason; the guide
   has the host-SFU swap), the invite/accept relay, recording webhooks. The
   CDK deployment (gateway + platform-api + SFU next to
   `OrgIQ-MiddlewareService`) still follows the 2026-09-20 research.
3. **Token bridge — shipped 2026-09-28.** `GET /api/session/realtime-token`
   (`middleware/src/routes/session.ts`, signing in
   `middleware/src/lib/realtime-token.ts`, tests in
   `routes/__tests__/session-realtime-token.test.ts`). Behind
   `requireSession()`; responds `{ token, expiresAt, gatewayUrl?,
   platformApiUrl? }` with `Cache-Control: no-store`, the two URLs from
   `REALTIME_GATEWAY_URL` / `PLATFORM_API_URL` and omitted when unset. The
   token is HS256, 10 minutes, signed with `REALTIME_JWT_SECRET` (unset in
   development → the dev secret `orgiq-dev-realtime` plus a one-time
   warning; unset in production → 503 "realtime token signing
   unavailable"). Claims:

   ```
   { sub, displayName, given_name, family_name, email?,
     org: <current tenant>, tenants: [<granted tenants>], role,
     tokenKind: 'orgiq-hs256', iss: 'orgiq-middleware', aud: 'realtime',
     iat, exp, external_sub?: <Cognito sub, once the user has used SSO>,
     act?: { sub: <real operator while masquerading> } }
   ```

   `given_name` / `family_name` are `displayName` split on its first space
   (family may be `''`): the gateway's `SKIP_AUTH` bypass
   (`auth-middleware.ts`) reads `sub`, `email`, `org` and builds the name from
   those two, ignoring `displayName`. platform-api takes the display name
   from the request body, so the portal must send it there as well.

   `sub` is the *effective* identity (the impersonated user while
   masquerading), matching the cookie; `org` follows a tenant switch on the
   next fetch. A client should re-fetch before `expiresAt`; nothing in the
   portal calls it yet.

   **Who verifies it — settled 2026-09-29 (option a).** The gateway is the
   middleware's own `/ws` (step 7). platform-api verifies it in
   `requireAuth`/`optionalAuth` beside Cognito when `REALTIME_JWT_SECRET` is
   set (platform-api `416df6d9`, `src/lib/orgiqRealtimeToken.ts`: HS256,
   `iss`/`aud`/`exp`/`tokenKind`, `org` → `orgId`), and its `lobbyAccess.ts`
   applies the middleware's `lobbyGuard` to OrgIQ callers. The SFU never sees
   the user's token: platform-api calls LVS's session lifecycle with
   `VIDEO_SERVICE_TOKEN`, which LVS accepts as `LVS_SERVICE_TOKEN`
   (live-video-streaming `cc28d028`). Walked with no `SKIP_AUTH` and no
   `LVS_AUTH_BYPASS` — [verified tokens](social-calls-first-call.md#verified-tokens-no-bypasses-2026-09-29).
   The history below is what the options were.
   realtime-examples' websocket-gateway
   (`Sec-WebSocket-Protocol: bearer-token-v1, <jwt>`,
   `src/middleware/auth-middleware.ts`) and platform-api (`Authorization:
   Bearer`, `requireAuth`) verify **Cognito id_tokens** against the pool's
   JWKS, with a `SKIP_AUTH=true` dev bypass. So:
   - *Locally*, both run with `SKIP_AUTH=true` and read identity from this
     token's claims; `tokenKind` lets them tell it from a Cognito token.
   - *In production*, one of two options, deliberately not chosen in code:
     (a) our own gateway entry point with a verifier for this token (the
     shared `REALTIME_JWT_SECRET`, `iss`/`aud` checked) — realtime-examples'
     server wires its services in `src/server.ts` rather than through
     `attachRealtime`, so this is a new entry point, not a flag — and
     platform-api taught the same, or (b) the BFF **retains the Cognito id_token** at
     login — `routes/auth.ts` verifies it in `/callback` and then discards it
     — and hands *that* out instead, so the upstream services keep verifying
     Cognito unchanged (costs: id_token lifetime and refresh become the BFF's
     problem, and picker/demo logins have no id_token at all).
4. **Library port — LANDED 2026-09-29 as realtime-modules 0.98.0 → 0.98.3
   (origin/main `d84d961`; 0.98.1–3 fix cross-replica DM drop / grace-expiry /
   answered-call sweeps). `ConversationCallDock` is NOT in ui-components yet
   (2.407.9 has CallDock render fixes and `--dock-floor` for a pinned composer
   under a dock); the portal renders `CallDock` from the pure mapping until it
   is. Exports, all from
   `@connorhoehn/realtime-modules/client/video`:
   `useConversationCall({ lobbyName, channel?, self:{userId,displayName},
   platformApi:{ baseUrl, getIdToken }, gateway:{ send, onMessage,
   connectionState? }, devices?, onCallStarted?, onCallEnded?, onCallMissed? })`
   → `{ phase: idle|calling|ringing|connecting|live|reconnecting|ended|failed,
   call, incoming, error, start(targets,{audioOnly?}), accept(), decline(),
   leave(), rejoin(), media, devices, elapsedMs, activeSpeakerId }` —
   `lobbyName` passes through verbatim (so `<tenant>:dm:<sorted ids>` works),
   no Vite env anywhere (platform-api base URL + token getter are props; LVS
   from `<LVSProvider baseUrl getAuthToken>`, overridden per call by the
   participant JWT); `useIncomingConversationCalls({ gateway, self })` →
   `{ rings, accept, decline }`; `conversationCallDockProps(result, { title,
   extras?, onOpenPeople, onOpenSettings, onPopOut?, tile, compact? })`
   (pure mapping to `CallDockProps`); `dmLobbyName(userIds, { prefix? })`,
   `useDevicePreferences(storage?)`, `channelForLobby`. Server: `calls({
   lobbyGuard: (auth, lobbyName) => boolean })` so our gateway `auth` can
   refuse lobbies outside the caller's org. ui-components
   `integrations/realtime-modules` gains `ConversationCallDock({ call, title,
   extras?, onOpenPeople, onOpenSettings, onPopOut?, compact? })` (CallDock +
   tiles) that drops into `ChatPanel dock` / `AgentComposerDock dock`.
   `IncomingCallToast` stays app-side this round. The realtime-examples
   shelf is re-pointed at the mapping as the regression gate; the session
   will send the shas when they land. Our middleware upgrade targets that
   0.98.0 sha once it exists (≥ 0.97.11 until then).

5. **Initiative page — SHIPPED 2026-09-29** (`portal/src/pages/projects/InitiativeCall.tsx`,
   `InitiativeCallHost.tsx` in the /iq shell, the toast — since step 6 in
   `lib/conversationCall.tsx` —
   `GET /api/roster/users` for person → user), walked with two users against
   the local stack including media: [the first call](social-calls-first-call.md).
   The dock sits on the initiative composer (`AgentComposerDock dock`), not a
   `ChatPanel`. Original step: `ChatPanel composer={<AgentComposerDock/>}
   dock={call ? <CallDock …/> : null}` on the Work/Discussion view;
   `ConversationSurface onStartCall` → call the initiative's owner + SMEs
   (`dm:` lobby of sorted user ids); incoming ring → `IncomingCallToast`
   → accept; Leave = hook leave + `POST /end`. Judge: a Playwright walk
   with two identities in one call against the local stack.
6. **Search — SHIPPED 2026-09-29** (not committed). The Search composer
   (`portal/src/pages/search/SearchComposer.tsx`, an `AgentComposerDock`)
   has the initiative composer's call: with people in the selection
   (`?selection=person:…`, e.g. picked on the connections tab) or attached
   as context, its dock row offers **Start call** (`search-start-call`),
   ringing their OrgIQ sign-ins in `orgiq:dm:<sorted user ids>`
   (`dmLobbyName`); while the call is on, the row is the shelf
   (`search-call-dock`). The invite's channel is `search:<sorted person
   ids>`, so the callee's Accept (the shell's toast, on any /iq page) opens
   `/iq/search?tab=connections&selection=…` on the same people and answers
   there. The mechanics are shared, not copied: `pages/projects/peopleCall.tsx`
   (`usePeopleCall` — roster mapping, lobby binding, availability, Start call,
   dock) serves both composers; the pure model moved to
   `lib/conversationCallModel.ts` (`initiativeCallModel.ts` re-exports it, its
   tests unchanged; `callChannelHref` decides where Accept goes). Dock + toast
   are `lib/conversationCall.tsx` — composed locally with the props of the
   library's `ConversationCallDock` / `IncomingCallToast`, built on
   ui-components branch `feat/conversation-call-dock` (unreleased); after the
   release the swap is that one module's body. Judge:
   `portal/e2e/search-call.spec.ts` — two contexts, fake media, ring → accept
   → both "2 people" → leave, and ring → decline (passed against the `:5184`
   Vite with `VITE_PLATFORM_API_URL`; it skips, saying why, on a portal that
   cannot place calls). Original step: the same `ChatPanel` + dock around
   `AgentComposerDock` on the Answer view, calling the people in the
   selection — the dock went on the composer instead, as on the initiative.
7. **Cross-tenant.** Lobby names prefixed by tenant (`<tenant>:dm:<ids>`),
   presence directory scoped per tenant, platform-api's channel→org
   mapping made tenant-aware, the token bridge carrying every tenant the
   user may act in — and the Cedar `requireTenant` gates on the new
   middleware routes. Rooms created via REST landing in a different org
   than browser users (a 404 seen on 2026-09-28) is the failure to test
   for.

   **Gateway half — SHIPPED 2026-09-29.** The middleware is its own
   gateway: `middleware/src/lib/realtime-gateway.ts` attaches
   realtime-modules' `attachRealtime(server, { path: '/ws', features:
   [chat(), presence(), calls({ stateStore, lobbyGuard, config: { canCall }
   })], auth })` to the BFF's own `http.Server`, gated by
   `REALTIME_GATEWAY=on|off` (default on outside production, off in
   production unless set — the ECS task is unchanged). `auth` takes only
   `Sec-WebSocket-Protocol: bearer-token-v1, <jwt>`, checks the browser
   Origin allowlist, and verifies the realtime token
   (`verifyRealtimeToken` in `lib/realtime-token.ts`: HS256, same secret,
   `iss`/`aud`/`exp`, `tokenKind`) into `{ userId: sub, displayName, org,
   tenants, role }`; anything else is a 401 at upgrade. `lobbyGuard` allows a
   lobby only under the caller's `<org>:` prefix, and an `<org>:dm:<ids>`
   lobby only for one of those ids — for every call frame naming a lobby,
   `status` queries included. `canCall` refuses untargeted invites (the
   library fans those out to every socket, i.e. every tenant). Call state is
   `RedisCallStateStore` when `REDIS_URL` is set (over a small RESP client,
   `lib/redis-lite.ts` — no Redis client is installed here), memory
   otherwise; `/api/health` reports `realtime: { gateway, store }`. Walked
   with two users and a forged cross-tenant frame, both stores:
   [Through the OrgIQ gateway](social-calls-first-call.md#through-the-orgiq-gateway-2026-09-29).
   The portal needed no change — `VITE_GATEWAY_URL=http://localhost:3001`
   resolves to `ws://localhost:3001/ws`.

   Still open in this step: chat and presence **channels** are not
   tenant-scoped (the portal's channel names carry no tenant prefix);
   presence directory per tenant; the router is the library's
   single-process `LocalRealtimeRouter`, so Redis shares call state but not
   frame fan-out — one task until a Redis-backed router exists. (platform-api's
   tenant-aware lobbies and the platform-api/SFU verifiers shipped
   2026-09-29 — step 3.)

## Deploying it (see `docs/social-calls-deploy-plan.md`, 2026-09-28)

Four pieces in order — the realtime JWT secret minted by
`OrgIQ-MiddlewareService` and read by both ECS services; `OrgIQ-SocialImages`
(three ECR repos, RETAIN); `OrgIQ-SocialMedia` (the SFU on a small EC2 with a
static IP); `OrgIQ-Social` (gateway + platform-api on Fargate behind the
existing ALB by hostname, Redis as a container, the DynamoDB tables). About
$60/month idle. Three risks the plan makes explicit, all needing the user's
decision before phase 0: (1) the custodian may revoke the `0.0.0.0/0` UDP/TCP
ingress a media server needs — phase 0 is a throwaway security-group probe,
and an `sfuAllowCidr` allowlist is what it tolerates; (2) the SFU ALSO
verifies Cognito tokens (`cognito-auth.js`) and platform-api forwards the
user's bearer to it, so our HS256 token needs an upstream verifier in the
gateway and platform-api AND platform-api calling the SFU as a service
(the gateway half shipped 2026-09-29 as the middleware's own `/ws`, step 7);
(3) no domain/certificate, no portal hosting, and `PLATFORM_API_URL` is
already a server-side internal URL in the middleware — the browser-facing one
needs its own variable.

## One composer, modes by context (user direction 2026-09-28)

`AgentComposerDock` is the single chat component everywhere (search,
initiatives, documents, computer lab). Which of its three modes — chat /
agent / terminal — are offered is decided by the SURFACE, never by a
second component:

| surface | modes on | why |
|---|---|---|
| Search | agent | no discussion thread, no shell; chat and terminal disabled with reasons |
| initiative (overview / work) | agent + chat | chat posts to the item's discussion behind its write gate |
| document (design thread, knowledge record) | agent + chat | chat is the document's comment thread; the call shelf docks above it |
| computer lab / devbox terminal | terminal (+ agent) | the box's shell is the subject; chat has nothing to post to |

The rule is a pure `composerModesFor(surface, capabilities)` (portal,
tested) that returns `modes`, `disabledModes` and `modeUnavailableReasons`
for `AgentComposerDock`; a page never hand-picks modes. The call shelf
(`ChatPanel.dock` → `CallDock`) attaches to the same composer on every
surface that has people to call (initiatives, documents), which is what
"bring the LVS stuff in for hangouts and document sharing and editing,
especially for initiatives" means in practice.

## Not decided yet (the user's calls)

- Whether the realtime-examples session takes the library port (step 4)
  now; it offered to open it as a plan.
- Publish vs vendor for the two LVS packages (step 1).
- Local stack: docker-compose profile in this repo vs pointing at
  realtime-examples' Tiltfile (step 2).
