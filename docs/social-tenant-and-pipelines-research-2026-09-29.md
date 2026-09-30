# A social tenant, and pipelines under every runbook and agent — foundations research

Research checkpoint: September 29, 2026. Read-only: no code, no commits, no
browser. The user's direction, verbatim:

> I don't have a design to integrate the social chat, channels, dms, teams,
> etc into each tenant so what I am thinking is to create another tenant for
> the social and then slowly contextually embed the interactions into the
> other tenants. The other thing is the pipelines which is basically the same.
> The idea being that any runbook or agent is backed by a pipeline. Go
> research the foundations for doing this.

What was inspected: this repo's middleware, portal, schema, infra, seeds and
docs; the installed `node_modules` dists (which are what the portal can use);
and, read-only, the sibling checkouts of realtime-examples, platform-api,
realtime-modules, ui-components, pipeline-runtime, distributed-core,
dc-k8s-operator and event-catalog. The running `dev:mock` middleware on
`127.0.0.1:3001` was probed with a cookie jar as `u-operator`. Nothing was
restarted or deployed. Every claim below is one of **verified** (read in code
or observed on the wire, with a `file:line`), **not found** (looked for and
absent), or **assumed** (a reading of intent, labelled as such).

Three facts to hold while reading, all verified today and all at odds with
what `CLAUDE.md` currently says:

- The portal and middleware install **ui-components 2.407.34** and
  **realtime-modules 0.98.7** (`portal/node_modules/@connorhoehnslalom/*/package.json`),
  not the 2.407.10 / 0.98.3 `CLAUDE.md` records. Both are the tips of their
  source repos, so the installed dist and the source agree for everything cited
  here.
- The middleware's own realtime gateway (`/ws`) keeps chat history and
  presence **in memory**: `chat()` is called with no `chatStore`
  (`middleware/src/lib/realtime-gateway.ts:209`), and the library's default is
  `InMemoryChatStore` (`middleware/node_modules/@connorhoehnslalom/realtime-modules/dist/server/attach.d.ts:26-29`,
  `dist/chat/ChatStore.d.ts:39`). Nothing in this repo persists a chat message.
- The Cognito seed list has **no assessment users**: `infra/lib/authentication-stack.ts:111-127`
  seeds eleven `@orgiq.example` addresses; `u-asha`, `u-jonas`, `u-farah` are
  absent. `CLAUDE.md` says the stack seeds "the 14 `app_users` emails including
  … assessment casts". A third tenant's cast will need adding there too.

---

## A. What a tenant is here today

### A.1 The server half

A tenant is a string in one array, and everything else is keyed on it.

- **The list.** `TENANTS = ['orgiq', 'assessment'] as const` and `type Tenant`
  (`middleware/src/lib/session.ts:23-24`); `ROLES_BY_TENANT` names the role
  vocabulary per tenant (`:29-32`), and the `Role` union is spelled out by hand
  beside it (`:37`). `DEFAULT_TENANT = 'orgiq'` (`:40`). Verified.
- **Grants and the invariant.** `Grants = Record<tenant, role[]>` (`:52`).
  `mintSession()` (`:159-185`) is the single choke point: it picks a tenant
  from `TENANTS.filter(t => rolesForTenant(grants, t).length > 0)` and a role
  held there. `verifySession()` (`:263-320`) refuses an unknown role
  (`isKnownRole`, `:259-261`, which walks `TENANTS`), defaults an unknown
  tenant to orgiq (`:290-292`), and re-mints if the active role is not held in
  the active tenant (`:310-315`). `permissiveGrants()` (`:88-92`) gives the
  cookie-less demo identity every role in every tenant.
- **Switching.** `POST /api/session/tenant` 400s unless the value is in
  `TENANTS` (`middleware/src/routes/session.ts:258-261`), 403s with no grant
  there (`:262-270`), carries the role over only if held (`:273-275`), bumps
  `session_epoch` (`nextEpochForSwitch`, `:74-82`) and re-issues the cookie.
  `POST /role` (`:231-252`) is the same shape. `GET /me` reports
  `availableTenants` from `TENANTS` (`:56`). Masquerade (`:304-350`) carries
  the target's grants under the operator's tenant.
- **Authorization.** `requireTenant(tenant)` (`middleware/src/lib/authz.ts:373-387`)
  reads the tenant from the signed cookie only and lets `admin` through any
  tenant. Cedar sees a `User` principal with `role` and `tenant` attributes
  (`:241-248`) against a singleton `Application::"app"` resource. Open mode (no
  `POLICY_STORE_ID`) evaluates the seed matrix (`:207-226`), honouring the admin
  wildcard (`:204`). `CAPABILITY_ACTIONS` (`:33-68`) is the list the portal's
  `can()` reads; the eight assessment actions are there at `:60-67` with the
  comment explaining why an unlisted action hides every control.
- **Cedar seeds.** One file per role per tenant under
  `middleware/seeds/roles/{orgiq,assessment}/`, each permit conditioned on
  `principal has tenant && principal.tenant == "<tenant>"`
  (`assessment/assessor.cedar:18`, `lead-assessor.cedar:23`,
  `program-lead.cedar:25`); `admin.cedar` is the one unconstrained permit. The
  action vocabulary is `middleware/seeds/schema.json` (35 action ids, verified
  by listing them). `middleware/src/lib/role-registry.ts:20` carries a
  `PRESENTATION` label/summary per role.
- **Identity store.** `schema/identity_schema.sql`: `tenants` (`:12-18`),
  `app_users` (`:20-28`, `id` is the session `sub`, `person_id` optionally links
  to the org graph, `external_sub` to Cognito), `user_tenant_roles` (`:36-42`).
  Seeds: two tenant rows (`:48-51`), fourteen users (`:57-85`), the grants
  (`:87-120`). `middleware/src/providers/identity.ts` mirrors them for the
  no-Aurora path: `FALLBACK_TENANTS` (`:42-45`), `FALLBACK_USERS` (`:48-96`).
- **Route mounts.** Twenty-seven mounts in `middleware/src/index.ts` carry
  `requireTenant('orgiq')` (verified by grep: `:168`–`:389`); the assessment
  router mounts bare at `:241` and applies its own gate per route so the
  machine callback `POST /runs/:runId/complete` can be exempt
  (`middleware/src/routes/assessment.ts:38-52`, `:427`). Agents are mapped to a
  tenant by id shape in `routes/agents.ts:113-126` (`agentTenant()`), and the
  two assessment agents add an in-agent floor
  (`agents/_shared/tenant_guard.py:24-45`); the supervisor keys one Agent per
  `(tenant, role)` (`agents/supervisor/main.py:428-445`) and defaults an
  unknown tenant to orgiq (`:451-468`).
- **The mock floor.** The `tenants` entity is registered in the parity harness
  (`middleware/src/mock/core/parity/entities.ts:815-825`), reading
  `listTenants()`; 57 fixture modules register through
  `middleware/src/mock/core/contract.ts` (rows + selectors, one clock, wire
  strings checked against a capture). A tenant with no fixtures is blank under
  `dev:mock`, which the contract names as bug class 5 (`contract.ts:17-19`).

### A.2 The portal half

- `type Tenant = 'orgiq' | 'assessment'` (`portal/src/lib/auth.tsx:9`);
  `RequireTenant` (`:334-341`) passes `admin` and otherwise requires
  `session.tenant === tenant`; `enterContext` (`:218-235`) POSTs `/tenant` then
  `/role`, clears tenant-scoped caches (`portal/src/lib/tenantCaches.ts`) and
  hard-navigates to `tenantHome(tenant)`. `TENANT_HOME`
  (`portal/src/lib/tenantHome.ts:24-30`) is the one place a front door is named.
- The shell: `Layout.tsx` has its own `type Tenant = 'orgiq' | 'assessment' | 'admin'`
  (`portal/src/components/shell/Layout.tsx:64`), `NAV_ITEMS` per tenant with a
  `group` (`:93-143`), `TENANT_LABELS` (`:190`), the tenant filter (`:243-249`),
  the orgiq-only platform items (`:265-278`), and `data-tenant` on both the
  shell and `<html>` (`:341-357`) which `portal/src/app.css:201` / `:245` paint
  from. `portalCommands.ts` repeats the tenant type (`:23`), holds
  `GROUP_ORDER_BY_TENANT` (`:75-78`) — the rail and ⌘K share it — and lists
  every page with a `tenant` (`:94-242`, ten assessment rows at `:220-241`,
  which `validate-assessment-tenant.sh:266` counts).
- The picker: `SelectContextPage.tsx` `TENANT_META` (`:43-46`, label, blurb,
  accent), `ROLE_META` (`:48-58`), the curated cast (`:71-88`), and a
  per-tenant SVG glyph (`:102-136`). Route trees: `/assessment/*` under
  `RequireTenant tenant="assessment"` (`portal/src/App.tsx:218-241`), `/iq/*`
  (`:247-253`) and `/admin/*` (`:383-390`) under `tenant="orgiq"`. A feature
  flag parks a tree (`portal/src/lib/features.ts:7-9`).

### A.3 The rule, and its judge

`docs/assessment-tenant.md:276-320` states it: **tenants are separate
products on a shared BFF** — they share the session and nothing else, not
navigation, not journeys, not chrome. `scripts/validate-assessment-tenant.sh`
makes each clause mechanical: isolation logs for five outside roles plus three
outbound (`:220-260`), zero `/iq/` or `/admin/` paths inside the tenant's pages
(`:263-264`), ≥10 palette rows (`:266`), every Computer-Lab component gated on
`session?.tenant === 'orgiq'` (`:274-290`), `RequireTenant` on both trees
(`:292-298`), and a middleware test that pins the tenant gate (`:300`). The
removal record is the inverse checklist: `docs/newsroom-removal-goal.md:40-48`
inventories every place the retired tenant had to be scrubbed from.

⚠️ One judge will fail the moment a third tenant is added, and it is not the
one you would look at: `scripts/validate-newsroom-removal.sh:31` greps for the
exact text `TENANTS = ['orgiq', 'assessment']` in `session.ts`. It must be
re-pointed at "no `newsroom`" rather than "exactly these two" as part of the
registration, or the retired-tenant validator turns red for a reason unrelated
to the tenant it guards.

### A.4 Registering a third tenant — the checklist

Every location a tenant name is enumerated, verified by reading each file.
`docs/assessment-tenant.md:160-177` is the shorter version of this table.

| # | Concern | File | What changes |
|---|---|---|---|
| 1 | Tenant id, roles, `Role` union | `middleware/src/lib/session.ts:23-40` | add to `TENANTS`, `ROLES_BY_TENANT`, `Role`, `ROLE_RANK` (`:134-136`) |
| 2 | Cedar policies | `middleware/seeds/roles/<tenant>/<role>.cedar` | one per role, conditioned on `principal.tenant` |
| 3 | Cedar actions | `middleware/seeds/schema.json` | new action ids |
| 4 | `CAPABILITY_ACTIONS` | `middleware/src/lib/authz.ts:33-68` | every new gated action, or its control hides |
| 5 | Role labels | `middleware/src/lib/role-registry.ts:20` | `PRESENTATION` entries |
| 6 | Identity seeds | `schema/identity_schema.sql:48-120` | tenant row, users, grants |
| 7 | Identity fallback | `middleware/src/providers/identity.ts:42-96` | mirror of 6 |
| 8 | Route mounts | `middleware/src/index.ts` | `app.use('/api/<tenant>', requireTenant('<tenant>'), …)` — or the router's own gate if it has machine routes |
| 9 | Agent↔tenant map | `middleware/src/routes/agents.ts:113-126`; `agents/_shared/tenant_guard.py` | only if the tenant has agents |
| 10 | Mock fixtures + parity | `middleware/src/mock/*.ts`, `mock/core/parity/entities.ts:815` | registered fixtures under the contract |
| 11 | Portal tenant type | `portal/src/lib/auth.tsx:9`; `components/shell/Layout.tsx:64`; `portalCommands.ts:23` | three copies of the union |
| 12 | Home + caches | `portal/src/lib/tenantHome.ts:24-30`; `tenantCaches.ts` | front door; any new tenant-scoped localStorage keys |
| 13 | Feature flag | `portal/src/lib/features.ts` | `VITE_ENABLE_<TENANT>` |
| 14 | Rail | `Layout.tsx:93-143`, `:190` | `NAV_ITEMS` rows with `group`, `TENANT_LABELS` |
| 15 | Palette + group order | `portalCommands.ts:75-78`, `:94-242` | `GROUP_ORDER_BY_TENANT[tenant]`, ≥10 pages |
| 16 | Route tree | `portal/src/App.tsx` | `/<tenant>/*` under `RequireTenant` with a bare-`<Outlet/>` layout |
| 17 | Picker | `SelectContextPage.tsx:43-136` | `TENANT_META`, `ROLE_META`, cast, glyph |
| 18 | Brand tokens | `portal/src/app.css:201-350` | `[data-tenant="<tenant>"]` light + dark |
| 19 | Cognito seed users | `infra/lib/authentication-stack.ts:111-127` | the cast's emails |
| 20 | Validators | `scripts/validate-newsroom-removal.sh:31`; new `docs/<tenant>-goal.md` + `scripts/validate-<tenant>.sh` | re-point the pin; add the judge |
| 21 | Docs | `CLAUDE.md` (tenant list, `TENANTS` gotcha, naming), `docs/assessment-tenant.md:3` ("the second tenant") | the counts change |

`Breadcrumbs.tsx` carries no tenant string of its own (grep: none) — it reads
the rail map; not verified how it labels a tenant it has never seen.

---

## B. The social substrate that exists

### B.1 In this repo

**The gateway.** `middleware/src/lib/realtime-gateway.ts` attaches
realtime-modules' `chat()`, `presence()` and `calls({ stateStore, lobbyGuard,
config: { canCall } })` on `/ws` (`:201-221`), authenticates only
`Sec-WebSocket-Protocol: bearer-token-v1, <jwt>` (`:77-97`) into
`{ userId: sub, displayName, org, tenants, role }`, and passes a router-level
`authorize` (`:146-153`, wired at `:207`) that applies the lobby rule to every
chat/presence channel: the channel, with the service prefix stripped
(`stripServicePrefix`, `:140-143`), must start with `<org>:`, and an
`<org>:dm:<ids>` channel only when the caller is one of the ids
(`lobbyGuard`, `:106-119`; `channelGuard`, `:129-131`). The header comment at
`:31-33` still says chat and presence channels "are not tenant-scoped" — that
sentence is stale; the code at `:206-207` scopes them. Call state is Redis
when `REDIS_URL` is set, memory otherwise (`:189-192`); the router is always the
library's single-process `LocalRealtimeRouter` (`:38-44`). Live:
`GET /api/health` → `"realtime":{"gateway":"on","store":"memory"}`.

**The token.** `middleware/src/lib/realtime-token.ts:49-66` — `sub`,
`displayName`, `given_name`/`family_name`, `email?`, `org` (= session tenant),
`tenants` (every granted tenant), `role`, `tokenKind: 'orgiq-hs256'`,
`external_sub?`, `act?`; HS256, 10 minutes, `iss orgiq-middleware`,
`aud realtime`. Minted by `GET /api/session/realtime-token`
(`routes/session.ts:169-189`), which also returns `gatewayUrl`,
`platformApiUrl`, `videoUrl` when configured. Live, as `u-operator`: the token
decoded to `org: "orgiq"`, `tenants: ["orgiq","assessment"]`, `role: "admin"`,
and the response carried `gatewayUrl: "http://localhost:3001"`. **`tenants` is
carried but read by nothing** — the gateway checks `org` only, platform-api
reads a single org claim (see B.3). Verified in both.

**Channel names in use.** `orgiq:invoke` / `orgiq:session:<id>`
(`portal/src/pages/InvokePage.tsx:209`, `:356`); `assessment:doc:<id>`
(`portal/src/pages/assessment/knowledge/knowledgeFormat.ts:395`),
`assessment:knowledge:<section>` (`:443`), and a hashed
`assessment:doc:h:<base36>` when the name would exceed the chat service's
50-character cap (`:407-420`). Call lobbies are `<tenant>:dm:<sorted user ids>`
(`portal/src/lib/conversationCallModel.ts:101-103` + `dmLobbyName`), and the
invite carries a `channel` of `initiative:<id>` or `search:<person ids>` so the
callee's Accept knows where to open (`:105-139`).

**Calls, shipped.** One `useConversationCall` per orgiq shell
(`portal/src/pages/projects/InitiativeCallHost.tsx`, header `:1-24`), pages
bind a lobby through `usePeopleCall` (`pages/projects/peopleCall.tsx:55-80`),
person→user mapping is tenant-scoped in `GET /api/roster/users`
(`middleware/src/routes/roster.ts:68-80`), and the dock/toast are the
library's `createConversationCallDock(video)` + `IncomingCallToast` from
`@connorhoehnslalom/ui-components/integrations/realtime`
(`portal/src/lib/conversationCall.tsx:6-10`). Judges:
`portal/e2e/initiative-call.spec.ts`, `search-call.spec.ts`. The walk record is
`docs/social-calls-first-call.md`; what it did not prove is at `:79-90`, and
the still-open production items at `:177-181` (platform-api ad-hoc lobbies,
channel scoping — now closed by the gateway — and the single-process router).

**A document conversation, shipped.** `DocumentConversation.tsx` runs one
`useChat(channel)` per page outside the canvas's document-grant socket
(`:22-53`), and renders `ContextComposer` (`:91-121`) and `WrappedChatPanel`
(`:133-139`) — both from the installed library. Judge:
`portal/e2e/document-chat.spec.ts`. Presence on the documents rail is one
avatar per person, keyed by the gateway-stamped `metadata.userId`
(`knowledgeFormat.ts:423-439`, commit `c058f337`).

**Infra, as code, not deployed.** `docs/social-calls-deploy-plan.md:448-471`
records the three stacks: `OrgIQ-SocialImages`, `OrgIQ-SocialMedia` (the SFU on
EC2) and `OrgIQ-Social` (platform-api on Fargate, a Redis container, 23
on-demand RETAIN tables). `infra/lib/social-stack.ts:46-103` lists the tables:
`document-video-sessions`, `call-session-bindings`, `video-call-recordings`,
`video-call-recording-participants`, `call-reactions`, `hangout-rooms`,
`hangout-room-members`, `social-profiles`, `social-rooms`,
`social-room-members`, `social-outbox`, `pipeline-runs`, `pipeline-audit`,
`pipeline-dlq`, `chat-messages`, `chat-members`, `chat-reads`,
`chat-conversations`, `chat-reactions`, `chat-pins`, `crdt-snapshots`,
`call-log`, `voicemail`. **Not in that list:** `teams`, `team-members`,
`social-relationships` (the follow graph behind Contacts),
`pipeline-definitions`, `video-recording-share-links`. Locally the `social`
compose profile (`docker-compose.yml:98-201`, guide
`docs/social-calls-local-stack.md`) runs realtime-examples' gateway,
platform-api, the SFU, Redis and DynamoDB Local with all 53 upstream tables.

### B.2 Upstream: what is stored, served and drawn

The question was "which of channels / DMs / teams / rooms / recordings have
storage + routes + UI upstream". The answer needs one correction first:
**channels, DMs and chat-message reactions are not platform-api features.**
realtime-examples' gateway server owns them: it writes `chat-messages`,
`chat-conversations`, `chat-reactions`, `chat-pins`, `chat-reads`,
`chat-members` itself (`realtime-examples/src/server.ts:946-1050`) and serves
`GET /api/chat/conversations`, `PATCH /api/chat/conversations/:channel`,
`/api/chat/pins`, `GET /api/chat/channel/:channel/history` (`:2731-2752`,
`:4508-4756`); platform-api only reads those tables to decide membership
(`platform-api/src/chat/conversationMembers.ts:23-24`). And there is no
"channel" entity: a team channel is a `hangout-rooms` row carrying a `teamId`
(`platform-api/src/routes/teams.ts:1-24`).

| Feature | Storage (DynamoDB, `realtime-examples/infra/dynamodb-schemas.json`) | Routes | UI (realtime-examples `frontend/src/`) | In this repo today |
|---|---|---|---|---|
| Channels (chat) | `chat-messages` (:222), `chat-members` (:234), `chat-reads` (:246), `chat-reactions` (:280), `chat-pins` (:292) | gateway `server.ts` (above); WebSocket `chat` service for send/history | `pages/MessagesPage.tsx` (4,661 lines): `useChat`, `useReactions`, `usePins`, `useChatReadReceipts`; `ChatPanel`, `ConversationRail`, `ContextComposer`, `CreateChannelDialog` | gateway in memory; `WrappedChatPanel` + `ContextComposer` on documents |
| DMs | `chat-conversations` (:258, userId/channel + `channel-index`); the channel **is** the DM: `chat:dm:<sorted ids>` (`realtime-modules/src/chat/dmChannels.ts`) | same as channels; legacy `POST /api/rooms/dm` (mutual follow) in platform-api `routes/rooms.ts:23` | same page (`/social/chat/dm/:peers`); `NewChatDialog` | DM **lobbies** for calls only (`<tenant>:dm:<ids>`); no DM chat surface |
| Teams | `teams` (:1029, orgId/teamId), `team-members` (:1055) | platform-api `/api/teams`: POST/GET, `/:teamId`, `/:teamId/channels`, `/:teamId/members`, `/:teamId/me` (`routes/teams.ts:229-488`) | `TeamChannelTree`, `CreateTeamDialog` inside MessagesPage | nothing |
| Rooms (hangouts) | `hangout-rooms` (:956, orgId/roomId, `teamId-index`, TTL), `hangout-room-members` (:1003) | platform-api `/api/rooms`: list, `/:slug`, create, patch, archive, members, join, leave (`routes/hangoutRooms.ts:281-725`) | `RoomsPage`, `RoomAdminPage` (`/rooms`, no nav tab); `useHangoutRooms` from `/client/hangout-rooms` | nothing |
| Recordings | `video-call-recordings` (:350), `-participants` (:373), `video-recording-share-links` (:398) | platform-api `/api/recordings*`, playback/share/transcript/summary (`routes/recordings.ts:56-1075`) | `RecordingsPage`; library `RecordingList`, `RecordingPlayer`, `TranscriptPanel` | nothing (the SFU's recording webhook is untested locally) |
| Contacts | `social-relationships` (:26, follower/followee) + `social-profiles` (:18) | platform-api `/api/social/follow*`, `/followers`, `/following`, `/friends` (`routes/social.ts:74-182`); `/api/profiles` (`routes/profiles.ts:24-196`) | `ContactsPage` (follow graph + presence + a static dev list) | the org roster (`/api/roster`) is the analogue |
| Calls log / voicemail | `call-log`, `voicemail` — **created at runtime**, absent from the schema file (`CallLogRepository.ts:26`, `VoicemailRepository.ts:16`) | `/api/calls/log*`, `/voicemail*` (`routes/callLog.ts:50-143`) | `CallsPage` | in `OrgIQ-Social`'s table list; no page |
| Video sessions | `document-video-sessions` (:304), `call-session-bindings` (:316), `call-reactions` (:386) | `/api/video/sessions*` (`routes/videoSessions.ts:241-1534`) | `HangoutDomainProvider` (app code) | **used** — the initiative and Search calls |
| Users | **not found** — no users table, no users route; `social-profiles` is the nearest thing | — | — | `app_users` |

Two things the frontend does *not* do, which matter for the proposal: it does
not use `useConversationCall`, `dmLobbyName` or `ConversationCallDock` (calls
run through `providers/HangoutDomainProvider.tsx`, lobby `dm:${sorted}` at
`:63`) — this repo is the only consumer of the 0.98 conversation-call surface;
and its Social sub-nav is flat — Chat, Calls, Contacts, Recordings, Profile
(`components/AppLayout.tsx:405-424`), with `/social/channels`, `/social/dms`,
`/social/rooms` all redirecting to `/social/chat` (`app/App.tsx:565-570`).

### B.3 Identity and tenancy upstream

- platform-api's principal is `req.user = { sub, email?, orgId?, displayName?, authKind? }`
  (`platform-api/src/types/express.d.ts:4-12`), accepted from a Cognito RS256
  token, from the OrgIQ HS256 token (`src/lib/orgiqRealtimeToken.ts:66-81`,
  requires `sub` and `org`), or decoded unverified under `SKIP_AUTH`. The org
  is the first of `custom:orgId | orgId | org_id | org | custom:org_id`
  (`src/lib/org-claim.ts:14`). **A `tenants` claim is not read anywhere.**
- Tenancy is partial: `src/lib/tenant.ts:81-105` (`tenantOf`, `scopedKey` →
  `'org|id'`) and `src/lib/authorize.ts:1-40` deny cross-tenant requests, but
  only call-reactions, recordings, video sessions and document edit access use
  the scoped key. Hangout rooms and teams partition by `orgId` directly and
  fall back to `'default-org'` under `SKIP_AUTH` (`routes/hangoutRooms.ts:66,141-149`;
  `routes/teams.ts:50,60-65`). Pipeline definitions are scoped per **user**
  (`src/pipeline/definitions-repository.ts:9-24`).
- The document-grant pattern: `DocumentGrantClaims { sub, tenantId, documentId,
  operations[], sessionId, sessionEpoch, jti }`
  (`realtime-modules/src/server/documentGrant.ts:6-12`), enforced by
  `platform-api/src/middleware/document-policy.ts:29-93` with **one tenant per
  deployment** (`DOCUMENT_TENANT_ID`), and mirrored in the gateway
  (`realtime-examples/src/realtime-fanout/document-grant-policy.ts:1-40`). This
  repo mints those grants from `POST /internal/document-grants`
  (`middleware/src/index.ts:113`).

### B.4 The library's authorization model, 0.98.4 → 0.98.7

- `authorize` is a router option: `ChannelAuthorize = ({ kind: 'subscribe'|'publish', clientId, channel, ctx }) => boolean`
  (`realtime-modules/src/server/router.ts:88`), passed through
  `attachRealtime({ authorize })` (`src/server/attach.ts:407`, `:438`); a custom
  `router` ignores it (`:413-416`). The deny frame is
  `{ type:'error', service, code:'AUTHZ_CHANNEL_DENIED', kind, channel, … }`
  (`src/server-ws/channelAccess.ts:~115-130`).
- 0.98.4 checked only the router's own subscribe and the fan-out; presence
  ignored a refused subscribe and chat stored before it dropped (CHANGELOG
  0.98.6 lists the holes). **0.98.6** made the router the single enforcement
  point, **per operation**: `subscribe` for presence subscribe/get, reactions,
  cursor, chat join/history/members/receipts; `publish` for presence `set`,
  reaction send, cursor update, chat send/edit/delete/typing/read/members
  (`src/chat/ChatService.ts:132-143`, check at `:532-535`). On deny: no state
  change, no ack, no fan-out. **0.98.7** closed presence `get { targetClientId }`
  (`src/presence/PresenceService.ts:269-276`, `:442`) so a caller sees only the
  channels it may subscribe to and otherwise gets `Client not found`. This is
  the "presence get by clientId" hole, and the installed version has the fix.
  The hook receives `kind`, never an action name.
- **Server-stamped sender (0.98.5).** `src/server-ws/senderIdentity.ts`
  (`senderFromContext` `:54`, `stampSender` `:104`): chat `send`/`edit`
  (`ChatService.ts:857`, `:1065`), presence `set` (`PresenceService.ts:224-236`),
  reactions — `message.userId` and the roster's `userId` come from the auth
  context. **Calls are not stamped:** `callerId` is read from the payload
  (`src/call/CallService.ts:1711`), forwarded verbatim (`:1947-1951`) and handed
  to `canCall` (`:1674`). Within a tenant a caller id is spoofable today.
- `calls({ lobbyGuard })` (`attach.ts:211-272`, option `:223`, 0.98.0) wraps
  `config.authorize`; frames naming no lobby pass (`:257`).
  `dmLobbyName(ids, { prefix })` → `${prefix}dm:<sorted>`
  (`src/client/video/conversationLobby.ts:14`). ⚠️ `enforceDmMembership`
  (`ChatService.ts:256-269`, `:1985`) matches only the **unprefixed**
  `chat:dm:` form, so a tenant-prefixed DM chat channel is protected by the
  router `authorize` alone — which is this gateway's `channelGuard`, and it
  does check the ids. Verified in both.
- Client hooks: `useChat(channel)` (`src/client/chat/useChat.ts:80`) takes no
  identity — the socket's token is the identity; `usePresence(channel,
  { join })` (`usePresence.ts:72`) returns a roster **keyed by `clientId`**
  (`:141`, `:180`), and the client `PresenceEntry` type has no `userId` even
  though the server adds one (`client/types.ts:121`). ui-components collapses
  to people via `metadata.userId || clientId`
  (`ui-components/src/integrations/realtime-modules/adapters.ts:136-145`), which
  is what `presenceAvatarUsers` in this portal does by hand.
- Multi-process: **not found.** `LocalRealtimeRouter` keeps channel membership
  in Maps and hard-codes `redisAvailable = false; nodeId = 'local'`
  (`src/server/router.ts:186-197`, header `:15-18`). `RedisCallStateStore`
  shares call state only; `calls()` under `attachRealtime` does not pass
  `crossNodePubSub` (`attach.ts:263-269`). The recipes name realtime-examples'
  `MessageRouter` as the reference for a cross-node router.

### B.5 What the installed ui-components can draw

Installed 2.407.34; every export below verified in
`portal/node_modules/@connorhoehnslalom/ui-components/dist`.

- **Usable from this portal:** `WrappedChatPanel`, `IncomingCallToast`,
  `createConversationCallDock(video)`, `WrappedPresencePanel`,
  `WrappedActivityPanel`, `WrappedNotificationCenter`,
  `createWrappedHangoutRoomsList`, `createHangoutRoomsSection`,
  `createWrappedStreamStage`, `createRealtimeIntegrations` — all from
  `integrations/realtime`, whose runtime JS imports nothing from
  realtime-modules. `ChatPanel` (with `composer` and `dock` slots),
  `ContextComposer`, `ConversationList`, `ConversationRail`,
  `NewConversationPanel`, `CreateChannelDialog`, `TeamChannelTree`, `RoomList`,
  `RecordingList`, `RecordingPlayer`, `RosterPanel`, `PresenceAvatars`,
  `NotificationCenter`, `StackedRail`, `SubNavLayout`.
- **Not usable here:** the prebound `integrations/realtime-modules` entry
  (`ConversationCallDock`, `WrappedHangoutRoomsList`, `HangoutRoomsSection`,
  `CanvasDocumentPane`, …) imports the canonical `@connorhoehn/realtime-modules`
  scope, which `portal/node_modules/@connorhoehn/` does not contain;
  `validate-assessment-tenant.sh:93` bans the import and
  `docs/ui-components-queue.md:121-139` records the resolution (use the
  factories).
- **Not found in the library:** a `DocumentRail` (portal-local,
  `portal/src/pages/assessment/knowledge/DocumentRail.tsx` composes
  `StackedRail`); an org member directory with presence (only
  `WrappedPresencePanel` / `PresenceAvatars`); `useHangoutRooms` lives in
  `/client/hangout-rooms`, not `/client/video`.

---

## C. The social tenant: a foundation proposal

### C.1 Why a tenant, and what kind

The user's premise holds against the code: there is no design for putting
channels, DMs and teams inside orgiq or assessment, and the rule in A.3
forbids a shared social chrome across products. A tenant is the one shape
this repo already knows how to add, judge and remove (A.4). The cost is that
a tenant is a *product* in the picker, and a chat product with nobody in it is
an empty room; phase 0 below is deliberately small so that cost is paid once.

**Tenant id:** `social`. **Roles**, mirroring the assessment ladder of three
plus the cross-tenant admin: `participant` (read, post, call, join rooms),
`moderator` (participant + create/rename/archive channels and rooms, manage
team membership, manage recordings), `community-admin` (moderator + tenant
configuration and `ManageUsers` scoped to the tenant, the way `program-lead`
holds it). Cedar actions to add to `seeds/schema.json` and
`CAPABILITY_ACTIONS`: `ViewSocial`, `PostMessage`, `StartCall`,
`ManageChannels`, `ManageTeams`, `ManageRecordings`, `ManageSocialConfig`;
a `forbid` on `participant` for the three `Manage*` actions, and on
`moderator` for `ManageSocialConfig` — the same separation-of-duties shape as
`assessor.cedar:22-30`. Assumed, not derived: the names; the shape is the
template's.

**Rail groups** (`GROUP_ORDER_BY_TENANT.social`), proposed against
realtime-examples' flat sub-nav (B.2), which hides Rooms and Teams behind the
Chat page: **Talk** (Channels `/social/channels`, Direct messages
`/social/dms`), **Meet** (Calls `/social/calls`, Rooms `/social/rooms`),
**People** (Contacts `/social/contacts`, Teams `/social/teams`), **Library**
(Recordings `/social/recordings`), **System** (Configuration, Settings). Ten
palette rows, which is the floor the assessment judge counts. Front door:
`/social/channels`.

### C.2 Identity: one `app_users`, three consumers

Today the mapping is already one id everywhere, by construction:
`app_users.id` → session `sub` → realtime token `sub` → gateway `userId` →
platform-api `req.user.sub`. Keep it. What differs is the **org**: the token's
`org` is the session tenant (`realtime-token.ts:83`), platform-api partitions
rooms and teams by that org (B.3), and the gateway scopes channels by it
(B.1). So a user standing in the social tenant gets `org: 'social'`, and every
room, team and channel they create lands under `social`. That is the right
partition for the tenant's own state.

The consequence for embedding: an orgiq session's token says `org: 'orgiq'`,
so it can neither subscribe to a `social:` channel (gateway) nor list a
`social` room (platform-api). The `tenants` claim is the unused key to this
(B.1, B.3): both verifiers should accept a channel or room whose partition is
**any tenant in the caller's `tenants`**, not only `org`. Concretely:

- gateway: `channelGuard` and `lobbyGuard` (`realtime-gateway.ts:106-131`)
  take `auth.tenants` and allow a prefix `p:` when `tenants.includes(p)`; the
  DM rule (caller must be one of the ids) is unchanged;
- platform-api: `lobbyAccess.ts` and the rooms/teams routes read the org from
  the request's *target* (the prefix of the lobby, the `orgId` on the room)
  and check it against the token's `tenants` — a platform-api change, in its
  repo, with the same "OrgIQ caller" branch it already has for `orgiq-hs256`;
- no second token: one realtime token per session, carrying every grant.

Do not model social as "the org for everyone" (every token `org: social`):
it would break the two tenants' existing channel names (`orgiq:invoke`,
`assessment:doc:*`) and the isolation walks that proved them.

### C.3 Where state lives

Argued from what exists, not from preference:

| State | Exists today | Proposal |
|---|---|---|
| Rooms, teams, recordings, call sessions, call log | platform-api + DynamoDB, routes, repositories; tables in `OrgIQ-Social` (rooms, recordings, calls) — **teams/team-members are missing from the stack** | platform-api behind the BFF: the portal calls platform-api directly with the realtime token (as calls do today), the BFF stays the identity issuer; add `teams`, `team-members`, `social-relationships`, `video-recording-share-links` to `social-stack.ts:46-103` |
| Channel and DM messages, membership, reads, pins | the `chat-*` tables are in `OrgIQ-Social`, but the code that **writes** them is realtime-examples' gateway (`server.ts:946-1050`), which this repo does not run; the middleware's `/ws` chat is `InMemoryChatStore` | implement a `ChatStore` (`dist/chat/ChatStore.d.ts:2`) over the same `chat-messages` / `chat-conversations` shape in the middleware and pass it as `chat({ chatStore })` — one gateway, one verifier, durable history. Not found: a DynamoDB `ChatStore` shipped by the library, so this is new code (assumed ~the size of `lib/redis-lite.ts`) |
| Who may see what (grants) | the document-grant pattern (B.3) scopes one document per grant; channels have no grant | not needed for phase 1: the router `authorize` + `chat-members` is the membership check. A grant per channel is the escalation path if a channel ever needs to be shared *across* tenants without a `tenants` grant |
| Context bindings ("this initiative's channel") | nothing | Aurora: `social_bindings (tenant, context_kind, context_id, channel, created_by)` owned by the BFF — it is the only party that knows both an initiative id and a channel name, mirroring how `knowledge_bases` bookkeeps Bedrock ids |
| The tenant's own roster | `app_users` + `user_tenant_roles` (Aurora) | unchanged; `/api/roster`'s tenant-scoped shape (`roster.ts:68-80`) generalises to `social` |

Aurora for messages is the wrong tool (fan-out and history reads are hot,
the Data API is neither) and DynamoDB tables for these shapes already exist;
Aurora for bindings and identity is right because those rows join to orgiq
ids. Verified: the table shapes; assumed: the sizing.

### C.4 Channel naming for a tenant of tenants

Rule: **social state is named `social:`; other tenants embed it, they do not
own it.** `social:ch:<slug>` (a channel), `social:dm:<sorted user ids>` (a DM;
the library's DM helpers accept the prefix, B.4), `social:team:<team>:<slug>`
(a team channel), `social:room:<slug>` (a room's call lobby, the library's
`room:` shape). An orgiq initiative page that shows its channel subscribes to
`social:ch:<slug>` through a binding row, and the guard admits it because the
session holds a `social` grant. Rejected: an unowned `shared:` prefix — no
tenant would own its membership, and `requireTenant` has nothing to check.

### C.5 The contextual-embedding seam

What a page in another tenant needs to show a channel, DM or call:

1. **A socket whose token grants social** — already true for any user holding
   a `social` grant (`tenants` claim), once C.2's guard change lands.
2. **A channel name for the context** — `GET /api/social/bindings?context=initiative:<id>`
   (Aurora, C.3), or `dmLobbyName` for people.
3. **Composites** — all present: `WrappedChatPanel` + `ContextComposer` (the
   document-conversation pair, `DocumentConversation.tsx:91-139`);
   `createConversationCallDock(video)` + `IncomingCallToast`
   (`lib/conversationCall.tsx`); `PresenceAvatars` via `presenceAvatarUsers`;
   `StackedRail` / `ConversationRail` for a channel list in a pane.
4. **Missing, small:** a `ChannelBinding` strip ("Discussion · #auth-migration ·
   Open in Social") — queue it in `docs/ui-components-queue.md` and compose
   locally until it ships; an org directory with presence (not found
   upstream); moving `presenceAvatarUsers` onto the library's
   `adaptPresenceRoster` (queue row at `ui-components-queue.md:137-139`).

The composer discipline in `docs/social-calls-plan.md` ("one composer, modes
by context") already decides which modes a surface offers; a social channel
embedded on an initiative is that composer in `chat` mode pointed at a
`social:` channel instead of the item's discussion.

### C.6 Phases

- **Phase 0 — registered, pickable, empty.** Every row of A.4 for `social`;
  Cedar files; three seed users; nav, palette, route tree, picker tile, brand
  tokens; a `SocialLayout` with empty-state pages naming what phase 1 brings;
  `docs/social-tenant-goal.md` + `scripts/validate-social-tenant.sh` cloned
  from the assessment judge (isolation logs for the five orgiq and three
  assessment roles, and the outbound walks). Judge: the validator, plus
  `validate-assessment-tenant.sh` and `validate-newsroom-removal.sh` (after
  `:31` is re-pointed) still green.
- **Phase 1 — channels and DMs, durable.** The `ChatStore` in the middleware;
  `chat-*` tables (already in `OrgIQ-Social`) or DynamoDB Local via the
  `social` profile; `/social/channels` and `/social/dms` on `ConversationRail`
  + `WrappedChatPanel` + `ContextComposer`; membership via the library's
  `useChatMembers`; the C.2 guard change (gateway half here, platform-api half
  upstream). Mock floor: registered fixtures for channels/messages so
  `dev:mock` is not blank (contract bug class 5). Judge: a two-context
  Playwright walk (post, read, DM, refused cross-tenant subscribe →
  `AUTHZ_CHANNEL_DENIED`), modelled on `document-chat.spec.ts`.
- **Phase 2 — teams, rooms, recordings.** platform-api's existing routes;
  add the four missing tables to `social-stack.ts`; `TeamChannelTree`,
  `createWrappedHangoutRoomsList`, `RecordingList`; room calls on
  `social:room:<slug>` through the existing call host. Judge: rooms created
  via REST are visible to a browser user in the same tenant (the 404 the plan
  warns about at step 7).
- **Phase 3 — embedding.** `social_bindings`; the `ChannelBinding` strip on
  the initiative overview, the Search connections tab (people → DM) and the
  document pane (a document's conversation becomes a `social:` channel rather
  than the BFF-gateway-only `assessment:doc:*`, or keeps both — a decision for
  then). Judge: the assessment isolation walk still passes (an assessor with no
  social grant sees no channel and gets `AUTHZ_CHANNEL_DENIED` on a forged
  frame).

### C.7 Risks, named

- **Cross-tenant identity.** platform-api reads one org claim and partitions
  rooms/teams by it with a `'default-org'` fallback under `SKIP_AUTH`; DM
  membership enforcement is unprefixed-only; calls are not server-stamped
  (`callerId` from the payload, B.4). Every one of these is upstream code.
- **The single-process router.** One middleware task while `/ws` is on
  (`realtime-gateway.ts:38-44`); chat history dies with the process until the
  `ChatStore` lands; a Redis-backed router does not exist in the library.
- **Presence by `clientId`.** The client roster is per socket; every consumer
  must collapse by `metadata.userId` (the portal does; the library's
  `WrappedPresencePanel` does with `perConnection=false`). The cross-tenant
  `get` hole is closed at the installed 0.98.7.
- **The mock floor.** platform-api has no mock in this repo; under `dev:mock`
  the social tenant is either blank (bug class 5) or needs mock providers for
  rooms/teams — or the `social` compose profile is the dev path, which is
  heavier than `npm run dev:mock`.
- **Judges that pin the old count.** `validate-newsroom-removal.sh:31`; the
  Cognito seed list (`authentication-stack.ts:111-127`) already omits the
  assessment cast; `CLAUDE.md`'s tenant sentences.

---

## D. Pipelines as the substrate behind runbooks and agents

### D.1 What exists in this repo

There is no pipeline entity here. There are **seven run-shaped tables, six
status vocabularies, and one de-facto pipeline in code.**

| Run-shaped thing | Table (`schema/`) | Status vocabulary | Steps / events |
|---|---|---|---|
| Queue job | `agent_jobs` (`agentic_work_schema.sql`): `kind` (`devbox:task`, `sweep:<name>`, local-compute kinds), `payload`, `box_id`/`session_id`, `attempts`, `result` | `queued → claimed → running → awaiting_review \| done \| failed \| cancelled` | `dispatcherEvents` → `GET /api/work/events` SSE (`routes/work.ts:318-323`); the box's event log (`lib/devbox-fleet.ts`, `task_started`/`job_started`/`devbox_start` at `:506-516`) |
| Bot firing | `bot_runs` (`agent_bots_schema.sql`): `trigger` manual\|cron\|pr_watch\|marketplace, `run_id` **or** `job_id`, `work_item_id`, `cost_usd`, `outcome`, `dispatched_by` (`agent_run_attribution_schema.sql`) | `running \| done \| failed \| skipped` | `decideFire` (`lib/bot-runner.ts:60-99`), the three money brakes |
| Governed run | `agent_project_runs` (`agent_projects_schema.sql`): prompt, model, session, `files_changed`, `cost_usd` | `running \| done \| failed` | `dispatchGovernedRun` (`lib/sdlc-pipeline.ts:53`) |
| Change | `agent_change_requests` + `agent_change_reviews` + `agent_change_gates` + `sdlc_policies` (`agent_sdlc_schema.sql:19-152`), `commit_sha` (commit-per-capture, `docs/sdlc-capture-delivery-model.md`) | `captured → in_review → changes_requested \| blocked \| approved → delivering → delivered` (`:53`); review `approve\|request_changes\|reject`; gate `pass\|requires_approval\|block` | `captureAndGate` (`:190`), `deliverApprovedChange` (`:259`) |
| Assessment run | `assessment_runs` (`assessment_schema.sql`): `command`, `args`, `launched_by`, `source` | `running \| completed \| failed` | `POST /runs` 202 (`routes/assessment.ts:374-385`); machine callback `POST /runs/:runId/complete` (`:427`); `run.started/progress/completed/failed` on the SSE broker (`lib/assessment-broker.ts:35-38`) |
| Compaction | `distillation_compactions` (`distillation_ops_schema.sql:22-52`): `level`, `phase`, `percent`, `log`, `attempts`, `step_label` | `queued \| running \| succeeded \| failed`, phase `claim\|read\|merge\|write\|done\|retrying` | the one table here that already carries step-level progress |
| Agent invocation | `observability.invocation_traces` (`observability_schema.sql`) | — (a trace, not a state machine) | AG-UI `RUN_STARTED`/`RUN_FINISHED`, `STEP_STARTED`/`STEP_FINISHED`, `TOOL_CALL_*` relayed by `routes/agents.ts:279-361`; the supervisor brackets each sub-agent call (`agents/supervisor/main.py:528-550`, `:696`); the trace bundle POSTed to `/api/observability/harness/trace` (`routes/harness.ts:336`) and echoed as `ORGIQ_TRACE:` (`agents/_shared/instrumentation.py:673-691`, `post_trace` `:696`) |
| Human consult | `lab_consults` (`lab_loop_schema.sql`) | `pending \| answered \| expired \| withdrawn` | `routes/lab.ts` |

Plus: the harness's `observability.test_runs`, the canary's Step Functions
controller (`infra/lib/prompt-canary-stack.ts:492-494`), and the local-compute
pull-side worker that claims the same `agent_jobs` (`routes/local-compute.ts:499-729`:
claim, start, heartbeat, complete, log).

**The de-facto pipeline** is `dispatchGovernedRun` → `runDevboxShell` →
`captureAndGate` → `reviewDiff` → `evaluateChange` → human decision →
`deliverApprovedChange` (`lib/sdlc-pipeline.ts`, header `:1-13`). Every bot,
marketplace claim and cron firing converges on it
(`docs/program-operating-model.md` "The queue loop"). It has stages, a
human gate, artifacts (a change with a `commit_sha`) and events — it lacks a
name, a definition row and a shared status vocabulary.

**Runbooks** are a rung, not a table. The ladder OBSERVATION → PATTERN →
RUNBOOK → SKILL (`docs/asset-library-and-promotion.md`) is curated by
`providers/promotions.ts`, which is mock-first ("`lab_experiences` has no
promotion/cluster tables yet", `:22`); the library catalog is
`providers/prompt-library.ts` behind `GET /api/library` (`routes/library.ts:19`).
A RUNBOOK's promotion to SKILL requires "human approved AND dry-run passes" —
**the dry-run is not implemented as an executable anywhere** (not found). So
"a runbook backed by a pipeline" today means: there is a document and a
promotion verdict, and no run.

**The one pipeline definition in this repo** is a Kubernetes manifest:
`k8s/crds/researcher-pipeline.yaml` (`AgenticPipeline`, steps search → llm →
approval → webhook, triggers manual + webhook, audit to DynamoDB). Two drifts,
verified: its approval `requiredRoles` is `[role:editor]` (yaml `:26`, `:46`)
while `docs/researcher-pipeline-crd.md` says `role:org-leader`; and the
`ResearcherPipelinePage.tsx` stub that doc names is **not found** in
`portal/src/pages/`.

### D.2 What exists upstream

- **The engine is distributed-core, running inside platform-api.**
  `distributed-core/src/applications/pipeline/{PipelineExecutor,PipelineModule,PipelineRunCheckpointStore,StuckRunDetector}.ts`;
  types in `types.ts`: `NodeType` `trigger|llm|transform|condition|action|fork|join|approval|agent`
  (`:18`), `TriggerType` `manual|document.*|schedule|webhook` (`:29`),
  `PipelineDefinition { id, name, version, status: draft|published, triggerBinding?, nodes, edges, … }`
  (`:314`), `PipelineRun { id, pipelineId, status, triggeredBy, currentStepIds, steps: Record<stepId, StepExecution>, context, pipelineDefinitionSnapshot?, … }`
  (`:577`), and a 31-event `PipelineEventMap` (`:696`).
- **pipeline-runtime is a types library**, not a runtime: `PipelineRunStatus`
  `pending|running|awaiting_approval|paused_at_breakpoint|completed|rejected|failed|cancelled|stuck`
  (`pipeline-runtime/src/types/pipeline-execution.ts:51-60`, aliases `:102`),
  `PipelineStepStatus` (`:145-152`), `PipelineRun`/`PipelineStep` (`:169-208`),
  and the `PipelineBridge` interface (`src/bridge-types.ts:45-126`: `trigger`,
  `getRun`, `getHistory`, `resolveApproval`, `listRuns`, `cancelRun`, `getDLQ`,
  …). Its planned worker service was abandoned (2026-05-19).
- **platform-api stores and serves runs.** Definitions per user in
  `pipeline-definitions` (`src/pipeline/definitions-repository.ts:9-24`,
  routes `routes/pipelineDefinitions.ts:165-588`); runs as `PipelineRunItem`
  (`src/repositories/PipelineRunRepository.ts:136-245`: `triggerType`
  `manual|schedule|webhook|document-event`, `stepsSummary` with `attempts[]`,
  `checkpoint`, `definitionSnapshot`, `tokenUsage`, `estimatedCostUsd`,
  `agentLoopRunId`, 30-day TTL) with trigger/list/get/history/replay/retry/
  resume/cancel/approve routes (`routes/index.ts:184-296`). **Artifacts are
  ids on a step's output** (`src/pipeline/declaredArtifacts.ts:15`,
  `PipelineArtifactReference { artifactId, pipelineId, runId }`); no artifact
  table, no `artifact.created` event. Agent loops (`/api/agent-loops/:runId`,
  `/tail`, `/instruct`, `/stop`) are already pipeline runs
  (`PipelineRunItem.agentLoopRunId`) — the precedent for "an agent is backed
  by a pipeline".
- **Events are declared** in event-catalog (`src/declarations/pipeline-p1.ts`,
  `pipeline-p2.ts`, `pipeline.ts`): `pipeline:run:started|completed|failed|cancelled|paused|resumed|stuck`,
  `pipeline:step:started|completed|failed|skipped|heartbeat|attempt:*`,
  `pipeline.approval.requested|recorded|resolved`, `pipeline.run.checkpoint`;
  `step:completed` carries `artifactIds` (`pipeline-p1.ts:135`). The gateway
  fans them out on `pipeline:all`, `pipeline:run:<runId>`,
  `pipeline:approvals` (`realtime-examples/src/pipeline-bridge/pipeline-bridge.ts`;
  client `components/pipelines/context/WebSocketEventAdapter.ts:200-221`).
- **UI:** realtime-examples' `PipelinesPage.tsx` renders ui-components'
  `PipelinesListView` over realtime-modules' `usePipelineCatalog`
  (`GET /api/pipelines/defs?include=rollup`, `src/client/pipelines/usePipelineCatalog.ts:76`)
  with live rollups from `pipeline:all`; editor, runs, replay, approvals, DLQ
  and metrics pages beside it (`app/App.tsx:688-752`).
- **The operator.** `dc-k8s-operator` reconciles `AgenticPipeline`
  (`crds/agenticpipeline/types.ts`: steps `llm|tool-call|approval|webhook|wait`,
  edges `{from,to,condition?}`, triggers `manual|webhook|cron|event`, audit
  `ddb|mq|none`) by validating, creating the audit table, and publishing the
  definition over Redis (`AgenticPipelineReconciler.ts:264-293`), which
  platform-api's subscriber writes to `pipeline-definitions` under
  `system:operator` (`src/control-plane/pipeline-config-subscriber.ts:172-185`).
  **No Run/Job/Agent/Worker CRD; runs never flow back to the CRD.** The
  `Runbook`/`RunbookExecution` CRDs were retired (`b27da5f9`). ⚠️ Read-only
  finding, not tested at runtime: the operator publishes `steps/edges(from,to)`
  and the subscriber stores it as-is where the executor expects
  `nodes/edges(source,target)` — no converter found.
- **Shared vs duplicated.** Shared: the run/step status vocabulary
  (distributed-core → pipeline-runtime → platform-api), the bridge interface,
  the event names. Duplicated: `PipelineDefinition`/`PipelineRun` in four
  forms plus the CRD's fifth; three trigger vocabularies; colon, dotted and
  kebab event names normalised client-side.

### D.3 The foundation, proposed

**One model, five nouns, borrowed vocabularies.**

```
Definition  { id, tenant, kind: 'runbook'|'agent'|'bot'|'assessment-command'|'compaction',
              owner, version, source: { assetId? | agentId? | botId? }, steps[], triggers[] }
Run         { id, definitionId, tenant, status: PipelineRunStatus,   ← pipeline-runtime's nine
              triggeredBy, triggerType, startedAt, finishedAt, costUsd, context }
Step        { runId, stepId, status: PipelineStepStatus, attempts[], input?, output? }
Artifact    { id, runId, stepId, kind: 'change'|'document'|'scores'|'trace'|'transcript'|'image', uri, meta }
Event       event-catalog names: pipeline:run:*, pipeline:step:*, pipeline.approval.*
```

Nothing above is invented: the statuses are `pipeline-runtime`'s, the events
are event-catalog's, `Artifact` is the one entity **nobody has** and this repo
needs most (a `commit_sha`, an `assessment_scoring_logs` row and a trace bundle
are all artifacts today with no common handle).

**How a runbook becomes pipeline-backed.** A RUNBOOK candidate
(`providers/promotions.ts`) gets a `Definition { kind: 'runbook', source: { assetId } }`
whose steps are its ordered steps; "dry-run passes" becomes "a `Run` of that
definition reached `completed` with the expected artifacts", and the promotion
verdict links to the run id — the provenance the ladder doc asks for, as a row
instead of a sentence. The library asset (`kind: skill`) keeps its contract;
the definition is what makes it *executable*.

**How an agent becomes pipeline-backed.** A fleet invocation is a `Run` of
`Definition { kind: 'agent', source: { agentId } }`: `RUN_STARTED` opens it,
each `STEP_STARTED`/`STEP_FINISHED` the supervisor already emits is a `Step`,
each `TOOL_CALL_START…RESULT` is an attempt on it, and the harness trace bundle
(`POST /api/observability/harness/trace`) closes the run and files the
`invocation_traces` row as the `trace` artifact. The AG-UI `run_id` and the
trace uuid are disjoint today (`docs/program-operating-model.md`, "Not built
yet") — carrying the run id into the bundle is the one plumbing change this
needs, and it is the same change `LabelFeedback` is waiting on.

**How the existing tables map** (a projection, before any new store):
`agent_jobs.id` → `Run.id` with `kind` → `Definition`; `bot_runs` → the
run's trigger record (`triggerType`, `dispatched_by` → `triggeredBy`,
`cost_usd`); `agent_project_runs` → the `execute` step; `agent_change_requests`
→ an `Artifact { kind: 'change', uri: commit_sha }` plus `review`/`gate`/`deliver`
steps from its status history; `assessment_runs` → `Run` with the command as
`definitionId`, `scoring_log` → `Artifact { kind: 'scores' }`;
`distillation_compactions` → `Run` with `phase` as the current step;
`lab_consults` → a `pipeline.approval.requested` event on the step that asked.
The status crosswalk is mechanical: `queued→pending`, `claimed|running→running`,
`awaiting_review→awaiting_approval`, `done|succeeded|completed→completed`,
`skipped→cancelled`, `blocked→rejected`.

**Tenant, cross-tenant service, or section?** Argued from A: tenants share
only the BFF, and every run above is already tenant-attributed by the table it
lives in (`assessment_runs` behind `requireTenant('assessment')`, everything
else behind `requireTenant('orgiq')`). A *tenant* is wrong: nobody works in
"Pipelines" the way an assessor works in Assessment, and a picker tile for a
ledger is a product with no cast. A *cross-tenant service* is wrong for the
same reason `requireTenant` exists: an unscoped `/api/pipelines` is a route
that serves both tenants' runs to whichever session asks. The answer is **a
section in each tenant over one shared model**: one `lib/pipeline-runs.ts`
(the projection + the crosswalk, pure), one façade router mounted twice —
`/api/runs` under `requireTenant('orgiq')` and `/api/assessment/runs` inside
the assessment router — and a **Runs** rail entry per tenant (orgiq: under
Operate beside Observability's "Runs", which today lists only invocations;
assessment: the existing Activity page, re-fed). The cross-tenant `admin` sees
both because `requireTenant` lets it, and only it.

**Where definitions and runs are stored, later.** The projection needs no new
table. When definitions arrive (phase 2 below), the choice is Aurora
(`pipeline_definitions`, `pipeline_runs`, `pipeline_steps`, `pipeline_artifacts`
— joins to `bots`, `work_items`, `assessment_teams`) versus adopting
platform-api's engine (DAG execution, breakpoints, replay, approvals — real,
tested, 30-day TTL, per-user scoping, DynamoDB). Argued from what exists: the
runs this repo cares about are *already* executed by the fleet dispatcher, the
governed-run pipeline and the assessment worker; none of them needs a DAG
executor, and their money brakes live in `bot-runner.ts`. So: **Aurora for the
model, platform-api's engine only for definitions that genuinely need a DAG**
(the researcher shape), reached through the `PipelineBridge` interface so a
`Run` row here can point at a `pipeline-runs` item there by id. That keeps the
AgenticPipeline CRD path open without making DynamoDB the source of truth for
`bot_runs`.

### D.4 Phases, and the first vertical slice

- **Phase 0 — the projection.** `lib/pipeline-runs.ts` + `GET /api/runs`
  (list, `:id`, `:id/steps`, `:id/events` SSE folding `/api/work/events` and the
  box tail) over the existing tables; a Runs page per tenant on
  `RunTimeline` (`portal/src/components/runs/RunTimeline.tsx`) and a plain
  `DataTable`. No schema change. Judge: every row in `agent_jobs`, `bot_runs`,
  `agent_project_runs`, `assessment_runs` and `distillation_compactions` in
  the seed appears exactly once with a valid `PipelineRunStatus`, under
  `dev:mock` and against Aurora (a parity check in the mock harness, the way
  `entities.ts` pins `tenants`).
- **The first vertical slice, named:** *a maintenance bot's cron firing as a
  pipeline run.* Every piece exists: `decideFire` → `enqueueJob` → dispatcher
  claim → `dispatchGovernedRun` → `captureAndGate` → review → gates →
  `awaiting_review` → deliver (`docs/program-operating-model.md`, "The queue
  loop"), with `bot_runs` as the trigger record, `agent_jobs` as the run,
  `agent_change_requests` as the artifact and `/api/work/events` as the event
  stream. Rendering that as `Run → Steps → Artifact → Events` on the bot detail
  page (`portal/src/pages/bots/BotDetailPage.tsx`, which already mounts
  `RunTimeline`) proves the crosswalk on the most-exercised path, with real
  cost and real governance, and no new execution code.
- **Phase 1 — the agent half.** Carry the AG-UI run id into the trace bundle;
  `Run`/`Step` from `STEP_*` and `TOOL_CALL_*`; the `trace` artifact. This is
  also what unblocks `LabelFeedback`.
- **Phase 2 — definitions and runbooks.** `pipeline_definitions` in Aurora;
  bots and assessment commands become definitions with triggers; the RUNBOOK
  dry-run is a run; promotion to SKILL requires one.
- **Phase 3 — DAG definitions through the bridge.** `AgenticPipeline`-shaped
  definitions delegated to platform-api via `PipelineBridge`; the researcher
  manifest as the fixture; the `steps/edges` ↔ `nodes/edges` converter, which
  is missing upstream, written where the operator's subscriber runs.

Risks: the crosswalk hides real differences (`skipped` bot runs are not
cancellations in intent — carry the original status as `context.sourceStatus`);
two ids per agent run until phase 1 lands; adopting platform-api's engine
imports its per-user definition scoping, which has no tenant.

---

## E. Decisions only the user can make

1. **Pipelines: a section in each tenant (recommended) or a tenant of their
   own.** A section keeps `requireTenant` as the data boundary and needs no
   picker tile, at the cost of two mounts and two rail entries for one model;
   a tenant gives one place to look at every run but has no cast, no product
   rule to obey, and would be the first tenant whose rows belong to other
   tenants.
2. **The social store: platform-api + DynamoDB behind the BFF (recommended
   for rooms, teams, recordings; the chat tables via a middleware `ChatStore`)
   or Aurora for everything.** The DynamoDB shapes, routes and stack exist and
   the chat tables are already provisioned, but channels/DMs are written by a
   gateway this repo does not run, so durable chat is new code either way;
   Aurora would make every message a Data API call and rebuild what exists.
3. **Identity source of truth: `app_users` with the realtime token as the
   only bridge (recommended), or Cognito subjects.** One id already flows from
   the cookie to the gateway to platform-api and picker logins have no
   Cognito subject; choosing Cognito would make SSO a prerequisite for chat and
   put token lifetime on the BFF (the deploy plan's option b).
4. **Is the social tenant a product in the picker, or an embedded capability
   with a tenant only in the data model?** A tile is what the tenant machinery
   gives you for free and is how isolation gets judged, but a "Social"
   workspace with three seed users is an empty room until phase 3; a data-only
   tenant skips the room but has no home for channel administration, teams or
   recordings, and no journey logs to prove isolation.
5. **The guard rule: `org` only (today) or any tenant in `tenants`
   (proposed).** `org`-only keeps the isolation walks exactly as proven and
   makes embedding impossible; `tenants` is one function in the gateway plus a
   platform-api change upstream, and it means a user's social grant is what
   lets an orgiq page show a channel — which is the right meaning, but it
   widens what a single token can reach.

## What this did not check

No browser walk was run, so nothing above claims a page renders. The
upstream repos were read at their working trees, not at the shas the
`social` profile builds from. The operator↔platform-api definition-shape
mismatch is a reading of two files, not a failed run. The `ChatStore` sizing
and the role/action names in C.1 are proposals. `Breadcrumbs.tsx`'s behaviour
for an unknown tenant was not verified.
