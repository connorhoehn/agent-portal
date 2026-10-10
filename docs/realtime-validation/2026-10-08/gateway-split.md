# The gateway split — 2026-10-08

Closes the "god module" finding (D12 in
[the 2026-10-07 audit plan](../../audit/2026-10-07-audit-plan.md), step 6:
"split the gateway into six modules, with no behaviour change") and the half
of D3 that lived in the gateway (the chat store factory). Local only, no
cloud, no Aurora, no authority widening; the single-gateway safeguard and the
capacity profile are untouched.

## 1. The map before the split

### What is mounted where

Two WebSocket paths on the BFF's own `http.Server`, both refused for every
other upgrade by `lib/unsupported-upgrades.ts`:

| path | auth at upgrade | features | router |
|---|---|---|---|
| `/ws` (`lib/realtime-gateway.ts`) | `Sec-WebSocket-Protocol: bearer-token-v1, <jwt>` — the HS256 realtime token, then `getLivePrincipal` (a valid signature is not a current session) | `chat` (+ huddle chat, DM/assessment page references, reader cursors), `presence`, `cursor`, `calls`, `reactions`, `fileUploads` (when enabled), `activity`, `pipeline`, `workGraph`, `notifications`, the library's built-in `subscribe` | Local by default; `RedisRealtimeRouter` under `REALTIME_GATEWAY_ROUTER=redis` (namespace `orgiq-gateway`) |
| `/realtime` (`lib/distillation-realtime.ts`) | the signed `orgiq.session` cookie (demo identity where the HTTP floor allows it), `currentLiveSession`, active tenant `orgiq` or admin | none — built-in `subscribe` only; the server pushes `orgiq:distill:{levels,jobs,review}` | Local by default; its own leased `RedisRealtimeRouter` (namespace `orgiq-gateway:distillation`) |

One process holds both leased routers; `lib/realtime-node-ownership.ts`
retires the sibling when either fences, so `/health` never reports half a
node. Every distillation frame is pushed to BOTH routers (the portal opens
only `/ws`).

### Which authority function admitted each decision (pre-split)

| decision | where it was asked | the rule, as spelled there |
|---|---|---|
| channel subscribe/publish (chat, presence, reactions, cursor, typing, pins, the work-graph and flow-run streams, decks) | `realtime-gateway.ts` `authorizeChannel` → `authorizeLiveGatewayChannel(args, { guard: channelGuard, baseChannel })` | the sync shape (`channelGuard`: partition ∈ token tenants, DM ids, team roster, `social:ch:` membership mirror, family × service table), then live-principal: fresh directory session (epoch, signed role still granted, masquerade actor still admin), the family's Cedar action, Social `ViewSocial`/`PostMessage` + membership proof, `orgiq:deck` row + tier, the page resource (`channelResource`), a second reload |
| call frames (`invite`/`join`/`accepted`/…) | `calls({ config.authorize })` → `authorizeLiveGatewayCall(ctx, action, payload, { guard: guardWithLog, getLobby })` | callerId == sub on invite, a stored call's lobby cannot be renamed, `lobbyGuard` shape, the family's read, Social `StartCall` + membership, the page resource (`lobbyResource`), a second reload |
| call frame delivery, notification delivery | `directRecipientFilter(guards)` → `authorizeLiveGatewayCallRecipient`; notification records: tenant grant, `ViewSocial`/`ApproveTransaction` role, `lobbyGuard` on the record's channel, Social membership proof | the recipient's own fresh authority at the send boundary |
| lobby read (`GET /api/calls`, `/api/calls/tenant`, the plane's Active now) | `authorizeCallLobbyRead(ctx, lobby, lobbyGuard)` | family is a lobby in a tenant partition, the family's read, the page resource, a second reload, the shape |
| upload request/complete (socket), `PUT/GET /api/uploads` | `uploadFeatureOptions(getCtx, { guard: channelGuard, baseChannel })`, `createUploadsRouter(…, { guard: channelGuard, baseChannel: stripServicePrefix })` (index.ts) | publish on the channel now; read = uploader, or subscribe now + the history floor (`routes/chat-pins.ts historyFloor`) |
| cursor | the router's `authorize` on `cursor:<channel>` (`lib/gateway-cursor.ts` decides nothing) | the family's READ authority (ephemeral service) |
| activity / pipeline producers | `lib/gateway-run-feed.ts` ×3: `tenantChannelFamily(channel)` non-null before `emitEvent`/`publish` | a server frame leaves only onto a family name; the router re-asks `authorize` per recipient |
| reader cursors / page-thread unread / mentions | `lib/page-thread-unread.ts currentPageReaders` and `lib/social-notify.ts currentlyReadsTenantChannel` | by user id: the family's read over every role the directory grants, the page resource, the explicit membership rows |
| notifications feature | inline `authorize` in `realtime-gateway.ts`: `getLivePrincipal(ctx)` + the socket still holds that context | the principal is current |
| pins (`/api/chat/*`) | `routes/chat-pins.ts chatAccess`: `lobbyGuard({ userId, org: 'social', tenants: ['social'] })` + explicit rows; `tenantPinAccess`: `authorizeConversationChat(…, { guard: channelGuard, baseChannel })` | Social: the name's membership rule then the rows; tenant threads: the family read |
| `/summarize`, the work graph's own flow runs | `routes/conversation-summarize.ts assertChat`, `lib/work-graph/{sources,assessment-sources,pipelines-sources}.ts` — each `authorizeConversationChat(…, { guard: channelGuard, baseChannel })` | the conversation's chat read now |
| Social conversation readability (work graph) | `lib/work-graph/social-sources.ts` → `socialConversationReadable(userId, channel, channelGuard, auth)` | the name's rule then the rows |
| platform-api's lobby question | `routes/realtime-lobby-access.ts` → `authorizeLiveGatewayCall(auth, 'join', { lobbyName }, { guard: lobbyGuard, getLobby: async () => null })` | the same `join` admission |
| distillation on `/realtime` | `distillation-realtime.ts authorizeChannel` (subscribe only, one of three names, `mayReadDistillation(getLivePrincipal(ctx).auth)`) and `filterClientMessage` (the same read, per delivered frame) | active tenant orgiq or admin, current session |
| distillation on `/ws` | `channelGuard`'s distillation branch under `authorizeLiveGatewayChannel` | the same rule, spelled a second time |
| the assessment team family for a REST-side wrapper | `lib/assessment-page-references.ts holdsTeamAuthority`: `tenantChannelFamily` + `channelAuthorityFor` + `holdsChannelAuthority` | the family rule, spelled a third time |

### Where `/ws` and `/realtime` duplicated or differed

- **Duplicated.** The distillation read was written twice: once as a
  `channelGuard` branch (`/ws`) and once as `authorizeChannel` +
  `filterClientMessage` (`/realtime`), each with its own
  `getLivePrincipal` call. The `{ guard: channelGuard, baseChannel }` pair
  was assembled by hand at 11 call sites and `{ guard: lobbyGuard, getLobby }`
  at 4; the producer-side family existence check was spelled three times in
  `gateway-run-feed.ts`; the family-rule-for-a-session was spelled once more
  in `assessment-page-references.ts`; `chatAccess` re-spelled
  `socialConversationReadable` (shape + rows).
- **Differed, by design, and still do.** `/realtime` authenticates a cookie
  and admits only orgiq (or admin); `/ws` authenticates the realtime token and
  admits every tenant the token lists. `/realtime` has no features and no
  client publish at all. These are different front doors to one authority,
  not two authorities.
- **Not duplicated** (one copy each, now named by the facade): the reader gate
  (`currentlyReadsTenantChannel`), the notification recipient rule
  (`lib/direct-recipient.ts`), the history floor (`routes/chat-pins.ts
  historyFloor`), the page resource (`lib/page-resources.ts`), the huddle seat
  (`lib/call-chat.ts`).
- **Still a copy, out of scope here** (listed so it is not forgotten):
  `lib/call-access.ts huddleLobbyTenant` carries the `assessment:team:TEAM-…`
  regex that `lib/tenant-channels.ts` also holds; `routes/agent-loop-create.ts`
  spells the lobby-read rule (`family.lobby` + `holdsChannelAuthority` +
  `pageResourceVisible`) with its own 409/403/404 mapping rather than reading
  `admitLobbyRead`'s four-way verdict. Both are a verdict-preserving change
  for a later lane; neither widens anything today.

### What "split" means here

The audit's D12 is a MODULE split: eight responsibilities in one 1,163-line
file that every lane edited. The split separates

- the **GATEWAY** — socket admission (`lib/gateway/auth.ts`), routing, fan-out,
  stores, leases and feature wiring (`lib/realtime-gateway.ts` as composition
  only, `lib/gateway/calls.ts`, `lib/gateway/notify-plugins.ts`,
  `lib/gateway/stats.ts`, `lib/gateway/env.ts`, the unchanged
  `lib/gateway-cursor.ts`, `gateway-run-feed.ts`, `gateway-attachments.ts`,
  `gateway-redis.ts`), from
- **AUTHORITY** — one facade, `lib/gateway/authority.ts`, holding the sync
  shape guards and every fresh-per-request `admit*` decision over
  `lib/live-principal.ts`, `lib/tenant-channels.ts`, `lib/social-authority.ts`'s
  primitive (`socialActionRole`), the page/lobby rules and the reader gate.
  Every feature plugin and every REST route that asks a conversation's gateway
  authority now calls the facade; none assembles a guard pair or re-spells a
  rule.

A PROCESS split (`/ws` and cookie `/realtime` as separate deployables) is
**not warranted now**: both paths already run as separately leased routers
with their own namespaces and an ownership link that retires the sibling, the
gateway is pinned to one task by the single-gateway safeguard the capacity
work has not lifted (CLAUDE.md, "Capacity"), and `/realtime` carries one
feed with no client publish. Splitting the process would double the blackout
window per deploy and the lease machinery for no admission gain; it becomes a
question only if the capacity decision moves the gateway off one task.

## 2. The facade (`lib/gateway/authority.ts`)

Shape guards (moved byte-for-byte from `realtime-gateway.ts`):
`lobbyGuard(auth, lobby)`, `channelGuard(auth, channel, kind)`,
`stripServicePrefix` (the deprecated alias of the library's `baseChannel`).

The guard pairs the live-principal primitives take, built once:
`channelGuards = { guard: channelGuard, baseChannel }`,
`callGuards(getLobby, guard = lobbyGuard)`, `noStoredCall`.

The decisions, each fresh per call (no positive cache anywhere below them):

| facade | verdict | the pre-split call it equals |
|---|---|---|
| `admitChannel({ kind, clientId, channel, ctx, scope? })`, `admitSubscribe`, `admitPublish` | boolean | `authorizeLiveGatewayChannel(args, { guard: channelGuard, baseChannel })` |
| `admitCursor(ctx, channel, kind)` | boolean | the router's decision on `cursor:<channel>` |
| `admitCall(ctx, action, payload, guards)` | boolean | `authorizeLiveGatewayCall(ctx, action, payload, { guard, getLobby })` |
| `admitCallRecipient(ctx, data, guards)` | boolean | `authorizeLiveGatewayCallRecipient(…)` |
| `admitLobbyRead(ctx, lobby)` | `'ok' \| 'not-a-lobby' \| 'gone' \| 'denied'` | `authorizeCallLobbyRead(ctx, lobby, lobbyGuard)` |
| `admitConversationChat({ ctx, channel, kind, clientId, scope? })` | boolean | `authorizeConversationChat(args, { guard: channelGuard, baseChannel })` |
| `admitSocialConversation(userId, conversation, auth)` | boolean | `await socialChat().ready; socialConversationReadable(userId, conversation, channelGuard, auth)` — also `chatAccess`'s `lobbyGuard` + rows block |
| `admitUploadRead(found, ctx)` | boolean | `mayReadUpload(found, ctx, { guard: channelGuard, baseChannel })` |
| `admitDistillation(ctx, channel, kind)`, `admitDistillationDelivery(ctx)` | boolean | `distillation-realtime.ts authorizeChannel` / `filterClientMessage`; equal to `admitChannel` on the same name (the `/ws` branch) |
| `admitReader(userId, channel, scope?)` | boolean | `currentlyReadsTenantChannel` |
| `admitPrincipal(ctx)` | boolean | the notifications feature's `getLivePrincipal` try/catch |
| `producerChannelAllowed(channel)` | boolean | `tenantChannelFamily(channel) !== null` |
| `holdsFamilyAuthority(session, channel, kind)` | boolean | `tenantChannelFamily` + `channelAuthorityFor` + `holdsChannelAuthority` |

## 3. The facade contract

`middleware/src/lib/gateway/__tests__/authority-facade.test.ts` — **88
contracts**, table-driven over (feature, family, role). Every channel, call,
lobby-read and conversation row asserts two things against one directory
world: the VERDICT the rule must give, and EQUALITY with the pre-split
primitive handed the hand-built guard pair. The verdict column is the
contract; the equality column pins the facade to the primitive so a rule added
to or dropped from the facade fails here before any socket does.

Rows cover: revoked grant (channel, call, conversation, reader), epoch bump
(channel, call, recipient, principal, distillation delivery), masquerade actor
(admitted as the target; refused when the actor is no longer admin or its
epoch moved), cross-tenant (a grant held while standing elsewhere is not the
active tenant; pipelines on orgiq; cursor from another tenant), history floor
(a member added after the file was shared never sees it), non-member lobby (a
private channel refuses a non-member ring; `StartCall` denied), page family
existence (`assessment:team:TEAM-9` is `gone`/false on channel, call and lobby
read), explicit rows closing a thread, the DM id rule, E5 (a social grant
holder standing in orgiq reaches a social DM), the nested call envelope, a
stored call that cannot be renamed, and the `/realtime` == `/ws` distillation
agreement over four names × two kinds × five principals.

## 4. Deletions and moves

`lib/realtime-gateway.ts`: **1,163 → 389 lines**, composition only (attach,
start, status, the router hook that logs a refusal, the feature list, the
runtime wiring, dispose). Every name it exported before is re-exported from
where it lives now, so none of its 11 production importers or 20+ test files
moved.

Moved out of it (no logic change):

| to | lines | what |
|---|---|---|
| `lib/gateway/authority.ts` | 352 (of which ~130 moved: `lobbyGuard`, `admitName`, `channelGuard`, `stripServicePrefix`) | the shape guards + the facade |
| `lib/gateway/auth.ts` | 74 | `realtimeGatewayEnabled`, `authenticateGatewayUpgrade`, `gatewayAuthFromClaims` |
| `lib/gateway/notify-plugins.ts` | 254 | the four notify plugins, `pageCursorChatOptions`, `notifyChannelMessage`, the live-subscriber probes |
| `lib/gateway/calls.ts` | 113 | `recordInvite`, `notifyMissedCall`, the `calls()` configuration (`tenantCalls`) |
| `lib/gateway/stats.ts` | 79 | the load line |
| `lib/gateway/env.ts` | 27 | the three tuning knobs |
| `lib/social-chat.ts` (+132) | `socialChatClient`, `createSocialChatBackend` — both store factories now sit together (audit D3) |

Rule copies deleted (each replaced by one facade call):

| file | copy removed |
|---|---|
| `src/index.ts` | the hand-built `{ guard: channelGuard, baseChannel: stripServicePrefix }` for the uploads router |
| `routes/chat-pins.ts` | `chatAccess`'s `lobbyGuard({ userId, org: 'social', tenants: ['social'] })` + explicit-rows block (11 lines); `tenantPinAccess`'s guard pair |
| `routes/conversation-summarize.ts` | `assertChat`'s guard pair |
| `routes/page-calls.ts` | two `authorizeCallLobbyRead(…, lobbyGuard)` sites |
| `routes/realtime-lobby-access.ts` | the hand-built `{ guard: lobbyGuard, getLobby: async () => null }` |
| `lib/work-graph/sources.ts`, `assessment-sources.ts`, `pipelines-sources.ts` | three guard pairs (each with its three dynamic imports) |
| `lib/work-graph/shared-work.ts`, `social-sources.ts`, `plane-active.ts` | three guard pairs / guard arguments |
| `lib/gateway-run-feed.ts` | three producer-side `tenantChannelFamily(channel)` existence checks → `producerChannelAllowed` |
| `lib/distillation-realtime.ts` | the second spelling of the distillation read (`authorizeChannel` body and `filterClientMessage`) |
| `lib/assessment-page-references.ts` | the third spelling of the family rule (`holdsTeamAuthority` body, 4 lines) |
| `lib/realtime-gateway.ts` | the inline notifications `authorize`, `guardWithLog`, the two inline guard pairs |

Judge: `scripts/validate-social-tenant.sh` line 470 now asks
`lib/social-chat.ts` (not the gateway) for the `DynamoChatStore` import — the
import moved with the factory, and the check follows it.

No file under `lib/` was deleted; nothing was renamed; `portal/**` untouched.

## 5. Gates

All run on the split tree, 2026-10-08 afternoon, sequentially (the full jest
and the mock-floor judge each alone, as the checkpoint asks).

| gate | result |
|---|---|
| `middleware` typecheck (`tsc --noEmit`) | clean |
| the gateway suites (`realtime-gateway-*`, `call-chat-*`, `gateway-run-feed`, `distillation-realtime`, `lobby-access`, `page-calls`, `chat-pins`, `conversation-summarize`, `work-graph`, `social-chat`, `gateway-attachments`, `direct-recipient`, `tenant-channels`, `live-principal`, `page-thread`) | 50 suites, 729 passed, 1 skipped, 0 failed — unchanged test files |
| the facade contract (`lib/gateway/__tests__/authority-facade.test.ts`) | 88 passed |
| full middleware jest, run alone | 474 suites passed (7 skipped), **6,753 passed**, 26 skipped, 0 failed (was 6,665 at the previous checkpoint; +88 are the facade contracts) — 38 min |
| Redis + DynamoDB Local contracts (`CALL_CHAT_TEST_REDIS_URL` / `CALL_PAGE_TEST_REDIS_URL` = host Redis `:6379`, `SOCIAL_CHAT_DDB_IT` = DynamoDB Local `:8000`) | `call-chat-redis.integration` PASS, `call-pages-redis.integration` PASS, `realtime-gateway-social-dynamo` PASS (the real `chat-*` tables), `redis-lite` PASS — 15 passed |
| `call-chat-durable.integration`, `call-features-cluster.integration` | **not run to a verdict**: both want `orgiq-chat-*` tables, which neither DynamoDB Local instance here holds (`:8000` has the unprefixed social tables, `:18063` the `orgiq-bff-cluster-*` ones); every failure is `ResourceNotFoundException`, none reaches a gateway decision. The validation Redis container `:16481` is not port-forwarded to the host (`ECONNREFUSED`), which is why the host Redis was used. |
| the 12 native full-BFF contracts, 3 Redis faults, 1 DynamoDB fault | **not re-run** — see §6 |
| `validate-route-coverage.sh` | ALL CHECKS PASS |
| `validate-honest-numbers.sh` | ALL CHECKS PASS |
| `validate-social-tenant.sh --quick` | red only on journey logs re-staled by other lanes today (the four `limited` recordings logs on S2 by design; 4 `channels.md` logs whose `/social/channels/:slug` type-scale contract moved; the assessment judge's 12 re-staled isolation/stretch logs). The three gateway checks the split moved — `DynamoChatPinsStore`/`DynamoChatStore` (now `social-chat.ts`), `onCallMissed` → `social-notify` (now `gateway/calls.ts`), `tenants.includes(` (now `gateway/authority.ts`) — follow their code; before that edit they were the only reds this change introduced. |
| `validate-communication-plane.sh --quick` | red only on the 20 re-staled `/…/communication` cascade/type-scale logs other lanes' page edits produced (the checkpoint's "24 re-staled logs"); no code check red |
| `validate-mock-floor.sh` full (after recapture) | **ALL CHECKS PASS** (15:19–15:44, 744 routes in the live router table; the snapshots carry the digest of the handler sources on disk after the split; [log](gateway-split-mock-floor.log)) |

Evidence beside this record: [gateway suites](gateway-split-gateway-suites.log),
[full jest](gateway-split-full-jest.log), [Redis/Dynamo contracts](gateway-split-redis-dynamo-contracts.log),
[mock-floor](gateway-split-mock-floor.log). |

The mock-floor recapture: the handler digest hashes every `.ts` under
`lib/`, so the split changed it and the snapshots were recaptured from a
throwaway server on `:3012` with the documented env (`capture.ts`, exit 0,
~4 min). The diff is larger than this change: it also absorbs the routes
other lanes added since the 14:00 capture (`routes.json` +1,353 lines; 35
routes gained a captured 200; every new `skipped` is a "no value found for
:id" or an HTTP 400/404 on a route with no fixture id; one old `HTTP 503`
skip disappeared; **no route flipped from 200 to skipped**, the capture-env
trap `docs/mock-floor.md` warns about).

## 6. Honest limits

- **No cloud, no Aurora.** The default AWS identity is still
  `InvalidClientTokenId`; nothing was deployed, synthesised or migrated.
- **The capacity profile is untouched** and was not re-run; the
  single-gateway safeguard stays.
- **The 12 native full-BFF contracts, the 3 Redis faults and the 1 DynamoDB
  fault could not be re-run against the split tree.** They need the two
  owned acceptance nodes on `127.0.0.1:3063/3064`
  (`test-support/bff-cluster-processes.py`); both ports are held by processes
  an earlier lane started on 2026-10-07 04:08 from this tree (PIDs 91936,
  91948, `node --import ./test-support/native-rds-preload.mjs --import tsx
  src/index.ts`, no watch), which run the pre-split code. Stopping processes
  this lane did not start is not allowed, and the launcher refuses occupied
  ports. Running the contracts against them would test the old code and is
  not claimed. The runnable equivalents here are the Redis/DynamoDB Local
  jest integration contracts listed in §5.
- **The equality half of the facade contract is only as strong as the
  primitive it compares to.** It proves the facade adds and drops nothing
  relative to `lib/live-principal.ts`; the verdict column is what proves the
  rule.
- **Two spellings remain** (`call-access.ts huddleLobbyTenant`,
  `agent-loop-create.ts`'s lobby read with its own HTTP mapping); see §1.
- **`lib/live-principal.ts` is 547 lines** and `lib/social-chat.ts` is now 709;
  the audit's proposed per-file cap of 400 under `lib/` would fail both. That
  judge is not shipped here; both files hold one subject each.
- **No browser smoke** (huddle start, DM send, cursors) was walked in this
  lane: the shared Tilt BFF hot-reloads the tree, and this lane kept to
  typecheck-before-save plus the socket contracts rather than driving the
  user's Chrome.
