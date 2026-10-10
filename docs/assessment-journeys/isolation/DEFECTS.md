# Defects found — tenant-isolation re-audit

Found on 2026-09-07 22:05–22:25 EDT re-observing the ten isolation logs that
the content-hash freshness check flagged after the local-compute presence merge
(`e59de29`). Chrome at 1552px, `middleware dev:mock` on :3011, portal on :5183.
Audited as the real picker personas — u-theo, u-nora, u-mia, u-vera, u-rachel,
u-asha, u-jonas, u-farah — never Demo User.

## Open


Nothing open (2026-09-29 20:05).

## Closed

### 2026-09-29 — a refused presence request gets no `AUTHZ_CHANNEL_DENIED` reply (low; signalling only) — **Closed, observed 2026-09-29 20:05**

Re-probed 20:03–20:06 as all five orgiq personas and the demo SME, each with its own realtime token on `ws://localhost:3001/ws`: the presence **subscribe** on `assessment:knowledge:confluence-eng` is now answered `{type:'error', service:'presence', code:'AUTHZ_CHANNEL_DENIED', kind:'subscribe'}`, and the **`set`** naming it is answered `AUTHZ_CHANNEL_DENIED` (`kind: 'publish'`) before the ordinary ack with `channels: []`. u-jonas's watcher socket received no `update` from any of them and the Engineering Space row kept only assessment avatars. I did not check which change closed it (the middleware's presence hook or the library); the client can now tell refused from empty. The original report follows.


Found 10:10 while closing the entry below. Under 0.98.6 a refused chat request is answered `{type:'error', code:'AUTHZ_CHANNEL_DENIED', kind, channel}`, but a refused presence request is not:
   - an orgiq socket's presence **subscribe** on `assessment:knowledge:confluence-eng` gets no frame at all;
   - its **`set`** gets an ordinary `set` ack with the channel silently removed (`channels: []`).

Nothing leaks, since no roster and no fan-out. The cause is that the middleware still wires `presence({ authorizeChannel: presenceAuthorize })` (`middleware/src/lib/realtime-gateway.ts`), and the presence service consults that hook first. On refusal it returns silently in `handleSubscribePresence`, and skips the channel in `permittedSetChannels`, before the router check that would send `AUTHZ_CHANNEL_DENIED`. A client therefore cannot tell “refused” from “no one here”.

Owner: middleware. Now that 0.98.6 makes the router the single check, drop the redundant presence hook so the router's reply reaches the client. Alternatively realtime-modules could have a hook refusal reply the same way.


### 2026-09-29 — an orgiq session could appear in an assessment presence roster — **Closed 2026-09-29 10:11**

Found 09:37 while re-verifying lead-assessor/DEFECTS.md #9, with the gateway's channel guard working as designed. u-theo (orgiq member, realtime token `org: "orgiq"`) opened a socket on `ws://localhost:3001/ws`:

   - He sent `{service:'presence', action:'subscribe', channel:'assessment:knowledge:confluence-eng'}`. The middleware logged `refused subscribe on channel 'presence:assessment:knowledge:confluence-eng' for user 'u-theo' (org 'orgiq')`, so the router did refuse. The presence service still answered `subscribed` with the channel's roster, which held u-farah's entry (her client id and metadata).
   - His `set` of presence `online` with `channels:['assessment:knowledge:confluence-eng']` then reached u-jonas, who was subscribed, as a `presence` `update` (“Theo intruder” on the running process; as “Theo Chang” on the 0.98.5 side instance, which stamps the name but still delivers it).

   Why, read from the installed 0.98.5 dist:
   - `PresenceService.handleSubscribePresence` awaits `messageRouter.subscribeToChannel(clientId, 'presence:' + channel)` but ignores its `false` return (the router's own comment says services should “suppress local sub + joined ack”), then sends the roster anyway.
   - `broadcastPresenceUpdate` calls `sendToChannel('presence:' + ch, message, clientId)` with no `publisherClientId`, so the router's publish-side `authorize` never runs for a presence `set`.

   Chat is not affected: its join and send are refused. The rail would show an orgiq user as online in an assessment source once #7 is fixed. Every REST gate, the routes, the tile and the nav are unchanged, (superseded 09:56: see the re-verification below. The five outside-role logs and demo-user.md now carry `verdict: fail` for this leak.)

   Owner: realtime-modules. The presence service should honour the router's refusal on subscribe, and pass the setter as `publisherClientId` (or drop unauthorized channels) on `set`. The middleware can close the roster read now by also wiring the presence service's own `authorizeChannel` hook (`presence({ authorizeChannel })`, which sees the bare channel name). That hook does not gate `set`.

   **Re-verified 2026-09-29 09:50–09:56, after the restart:** the :3001 middleware restarted at 09:49:07 and now loads realtime-modules 0.98.5 (health `ok`), with the gateway passing `presence({ authorizeChannel })` from the router's client context.
   - **The read half is closed.** u-theo's presence subscribe on `assessment:knowledge:confluence-eng` now gets no `subscribed` frame and no roster. The middleware logs `refused presence on channel 'assessment:knowledge:confluence-eng' for client '…' (org 'orgiq')`.
   - **The write half is still open, and is now visible in the UI.** u-theo's `set` with `channels:['assessment:knowledge:confluence-eng']` still reached u-jonas as an `update` stamped “Theo Chang”. With u-farah and u-jonas both on Rubric Overview, now that the rail joins the section channel (lead-assessor/DEFECTS.md #7), Jonas's Engineering Space (Confluence) row grew a third avatar, **TC Theo Chang**, next to FO and JL (`presence-cross-tenant-rail.jpg`). It went away when Theo's socket closed.

   Every outside persona reproduces it: each signed in, took its realtime token, subscribed and then `set` on the channel while u-jonas watched it on his own socket.

   | persona | token org | subscribe reply | what u-jonas received |
   |---|---|---|---|
   | member | orgiq | no roster (only its own connect-time `set`, `channels: []`) | u-theo offline Theo Chang, u-theo online Theo Chang |
   | sme | orgiq | no roster (only its own connect-time `set`, `channels: []`) | u-nora offline Nora DaSilva, u-nora online Nora DaSilva |
   | program-owner | orgiq | no roster (only its own connect-time `set`, `channels: []`) | u-mia offline Mia Singh, u-mia online Mia Singh |
   | org-leader | orgiq | no roster (only its own connect-time `set`, `channels: []`) | u-vera offline Vera Green, u-vera online Vera Green |
   | hr-admin | orgiq | no roster (only its own connect-time `set`, `channels: []`) | u-rachel offline Rachel Kowalski, u-rachel online Rachel Kowalski |
   | demo-sme | orgiq | no roster (only its own connect-time `set`, `channels: []`) | demo-user offline Demo User, demo-user online Demo User |

   Reported to realtime-modules as the library half: `broadcastPresenceUpdate` passes no `publisherClientId`, so the router's publish `authorize` never runs for a presence `set`. The gateway's presence `authorizeChannel` hook covers subscribe only, so the middleware cannot close this half from its side without changing the library contract. Owner: realtime-modules.

**Closed 2026-09-29 10:09–10:11, re-verified on :3001:** both servers restarted at 10:08 (middleware 10:08:27, Vite 10:08:32) onto realtime-modules 0.98.6 (`node -p` reads 0.98.6 in portal/ and middleware/), in which the router is the single channel check.

Setup: u-farah and u-jonas were on Rubric Overview (`/assessment/workspace?doc=page%3A100002`), and Jonas also held a raw socket subscribed to `assessment:knowledge:confluence-eng`. Each outside persona then took its own realtime token (org `orgiq`) and sent, in order: a presence subscribe on that channel; a presence `set` with `channels:['assessment:knowledge:confluence-eng']`; then chat `history`, `join`, `members` and `send` on `assessment:doc:page:100002`.

   | persona | presence subscribe reply | presence `set` reply | reached Jonas | chat history | chat join | chat members | chat send |
   |---|---|---|---|---|---|---|---|
   | member (u-theo) | none | `set` ack with `channels: []` | nothing | `AUTHZ_CHANNEL_DENIED` (subscribe) | `AUTHZ_CHANNEL_DENIED` (subscribe) | `AUTHZ_CHANNEL_DENIED` (subscribe) | `AUTHZ_CHANNEL_DENIED` (publish) |
   | sme (u-nora) | none | `set` ack with `channels: []` | nothing | `AUTHZ_CHANNEL_DENIED` (subscribe) | `AUTHZ_CHANNEL_DENIED` (subscribe) | `AUTHZ_CHANNEL_DENIED` (subscribe) | `AUTHZ_CHANNEL_DENIED` (publish) |
   | program-owner (u-mia) | none | `set` ack with `channels: []` | nothing | `AUTHZ_CHANNEL_DENIED` (subscribe) | `AUTHZ_CHANNEL_DENIED` (subscribe) | `AUTHZ_CHANNEL_DENIED` (subscribe) | `AUTHZ_CHANNEL_DENIED` (publish) |
   | org-leader (u-vera) | none | `set` ack with `channels: []` | nothing | `AUTHZ_CHANNEL_DENIED` (subscribe) | `AUTHZ_CHANNEL_DENIED` (subscribe) | `AUTHZ_CHANNEL_DENIED` (subscribe) | `AUTHZ_CHANNEL_DENIED` (publish) |
   | hr-admin (u-rachel) | none | `set` ack with `channels: []` | nothing | `AUTHZ_CHANNEL_DENIED` (subscribe) | `AUTHZ_CHANNEL_DENIED` (subscribe) | `AUTHZ_CHANNEL_DENIED` (subscribe) | `AUTHZ_CHANNEL_DENIED` (publish) |
   | demo-sme (demo-user) | none | `set` ack with `channels: []` | nothing | `AUTHZ_CHANNEL_DENIED` (subscribe) | `AUTHZ_CHANNEL_DENIED` (subscribe) | `AUTHZ_CHANNEL_DENIED` (subscribe) | `AUTHZ_CHANNEL_DENIED` (publish) |

What changed:
   - **Presence.** No outsider's `set` reached Jonas (0 `update` frames across all six). The `set` is acknowledged with the channel removed (`channels: []`), so nothing is stored or fanned out.
   - **The rail.** Jonas's and Farah's Engineering Space (Confluence) rows read **FO JL** before, during and after the six probes (`presence-cross-tenant-rail.jpg`), where the 09:50 pass showed a third avatar, TC Theo Chang.
   - **Chat history.** An outsider's `history` read, which was unchecked before 0.98.6, is now refused with `AUTHZ_CHANNEL_DENIED` (`kind: "subscribe"`).
   - **Middleware log.** Each persona logged `refused presence on channel 'assessment:knowledge:confluence-eng'` twice (subscribe and set), `refused subscribe on channel 'assessment:doc:page:100002'` three times (history, join, members), and `refused publish` once (send). 0 outsider text in either assessment Chat panel.
   - **The assessment side still works.** Farah's presence `set` reached Jonas as `u-farah` / “Farah Osei”, with her forged `displayName: "forged"` replaced by the token's name. Chat went Farah→Jonas in 224 ms and Jonas→Farah in 156 ms, with 0 console or page errors in either tab.

Confidentiality closed; one signalling gap remains, filed below.


### 2026-09-29 — a gateway chat message carried a client-chosen sender name — **Closed 2026-09-29 09:51**

The half of the 2026-09-29 conversation defect that the tenant scoping below does not close. The BFF gateway's chat service stores whatever the sender puts in `metadata.displayName` and every panel renders it as the author name, so a signed-in user can post into a conversation they may join under someone else's name. After the channel fix this is confined to the caller's own tenant (an orgiq session can no longer reach an assessment channel at all), but inside it the spoof still works: at 09:12 three socket probes sent as u-asha, u-jonas and u-farah with `metadata.displayName: "isolation re-probe"` render in Rubric Overview's Chat panel as “IR · isolation re-probe”, not as the three real names (`chat-cross-tenant-refused.jpg`, u-jonas's panel, shows them). The user id on each stored message is correct (`userId` comes from the verified token) — only the display name is unbound.

Owner: realtime-modules (the chat service should stamp the display name from the authenticated connection, not the message metadata) — the library session is shipping it as **0.98.5**; the BFF then needs to put the name into the realtime token it mints. Re-verify after that pin moves: send with a forged `metadata.displayName` and read the name the other panel shows.

**Re-verified 2026-09-29 09:36–09:41: still open on the running middleware; the pinned library does fix it, but it is not loaded yet.** Both `middleware/package.json` and `portal/package.json` pin `fde7ad33…` and `node -p "require('./node_modules/@connorhoehnslalom/realtime-modules/package.json').version"` reads `0.98.5` in both packages. But the :3001 middleware process (pid 78909) was started at 09:31:04 by `tsx watch` for the `realtime-gateway.ts` edit, and `middleware/node_modules/@connorhoehnslalom/realtime-modules` was reinstalled at 09:33:08 — `tsx watch` does not watch `node_modules`, so the running gateway still executes the previous pin (`99eb8c3b`) in memory even though `package.json` and the installed files say 0.98.5.

   - **Chat send.** A socket authenticated as u-jonas (token `displayName: "Jonas Lindqvist"`) joined `assessment:doc:page:100002` and sent a message. The frame claimed `userId: "u-farah"` and `displayName: "Farah Osei"`, with `metadata.displayName: "Farah Osei"` and a forged `metadata.avatarUrl`. Farah's socket received it with `userId: "u-jonas"` (from the token) but `metadata: {displayName: "Farah Osei", userId: "u-farah", avatarUrl: "https://forged.example/f.png"}`, which is the frame's copy.
   - **The panel.** u-farah's Chat panel on Rubric Overview rendered the message as “FO · Farah Osei” (`chat-sender-spoof.jpg`). Every viewer's browser also fetched the forged `avatarUrl`: 2 `ERR_NAME_NOT_RESOLVED` console errors per tab. That is a second face of the same bug, since a client-chosen avatar URL makes other people's browsers request an arbitrary host.
   - **Chat edit.** An `edit` of that message carrying `metadata.displayName: "Farah Osei"` went through, and the stored metadata kept the forged name.
   - **Presence set.** u-farah's `set` claimed `metadata.displayName: "Jonas Lindqvist (forged by Farah)"` and `metadata.userId: "u-jonas"`. Jonas received it as-is, with no top-level `userId` on the entry.
   - **The installed code, in isolation.** To separate the library from the stale process, the same probes were run against a throwaway instance on 127.0.0.1:3097. That instance was `attachRealtimeGateway` from `middleware/src/lib/realtime-gateway.ts`, with the installed 0.98.5 `realtime-modules`, run by the middleware's own `tsx` and stopped afterwards. The results:
     - chat send and edit came out with `userId: "u-jonas"` and `metadata: {displayName: "Jonas Lindqvist"}`: the forged name, userId and avatarUrl were all dropped;
     - Farah's forged presence `set` reached Jonas as `userId: "u-farah"`, `metadata: {userId: "u-farah", displayName: "Farah Osei"}`.

     So no BFF change is needed beyond what is in the tree. The token already carries `displayName`, and the gateway's auth context passes it through.

   The spoofed probe messages were deleted afterwards from u-jonas's socket, so the panel shows tombstones. **To close:** restart the :3001 middleware so it loads 0.98.5, then repeat the u-jonas → “Farah Osei” send and read Farah's panel. Owner: whoever runs the shared dev stack (a restart); no code owner remains.

**Closed 2026-09-29 09:50–09:51, re-verified on :3001 after the restart.** Since then, the :3001 middleware restarted at 09:49:07 and now loads realtime-modules 0.98.5 (health `ok`), with the gateway passing `presence({ authorizeChannel })` from the router's client context.
   - **Chat send.** A socket authenticated as u-jonas joined `assessment:doc:page:100002` and sent a message. The frame claimed `userId: "u-farah"`, `displayName: "Farah Osei"`, `metadata.displayName: "Farah Osei"`, and a forged `metadata.avatarUrl`. Farah's socket received it with `userId: "u-jonas"` and `metadata: {displayName: "Jonas Lindqvist"}`: the forged name, userId and avatarUrl were all dropped.
   - **Chat edit.** An `edit` carrying `metadata.displayName: "Farah Osei"` came back unchanged: `{displayName: "Jonas Lindqvist"}`.
   - **Presence set.** Farah's `set` claimed `displayName: "Jonas Lindqvist (forged by Farah)"` and `userId: "u-jonas"`. Jonas received it as `userId: "u-farah"`, `metadata: {userId: "u-farah", displayName: "Farah Osei"}`.
   - **The panel.** With both Chat panels open on Rubric Overview, a live forged send from u-jonas rendered in Farah's panel as “Jonas Lindqvist: Live spoof …”. The earlier probe message, stored before the restart, also reads “JL Jonas Lindqvist” (`chat-sender-spoof.jpg`). Both tabs made 0 requests to the forged avatar host, and logged 0 console or page errors.
   - **Cleanup.** The probe messages were deleted afterwards.

   No owner remains.

### 2026-09-29 — orgiq roles could read and write an assessment document's conversation — **Closed 2026-09-29 09:12–09:15** (the cross-tenant read/write half; the sender-name half closed 2026-09-29 09:51, above).

   Fixed in the middleware: `middleware/src/lib/realtime-gateway.ts` now passes `authorize: authorizeChannel` to `attachRealtime`, and `channelGuard` applies the call-lobby rule to every chat and presence channel — the channel must start with the caller's own `<tenant>:` prefix, and a `<tenant>:dm:<ids>` channel only admits a participant. Re-verified headless against dev:mock:social on :3001 (middleware restarted 09:06, after the 09:04 edit), same method as the report below — each persona signed in with `POST /api/session/login` (+ `/role`), `GET /api/session/realtime-token`, a browser WebSocket to `ws://localhost:3001/ws` with `bearer-token-v1, <token>`, `{service:'chat', action:'join', channel:'assessment:doc:page:100002'}`, then a `send` on the same channel:

| persona | grants | token | join | history | send |
|---|---|---|---|---|---|
| u-theo (member) | {"orgiq": ["member"]} | 200 | none (refused) | 0 | “You must join the channel before sending messages” |
| u-nora (sme) | {"orgiq": ["sme"]} | 200 | none (refused) | 0 | “You must join the channel before sending messages” |
| u-mia (program-owner) | {"orgiq": ["program-owner", "member"]} | 200 | none (refused) | 0 | “You must join the channel before sending messages” |
| u-vera (org-leader) | {"orgiq": ["org-leader", "member"]} | 200 | none (refused) | 0 | “You must join the channel before sending messages” |
| u-rachel (hr-admin) | {"orgiq": ["hr-admin", "org-leader"]} | 200 | none (refused) | 0 | “You must join the channel before sending messages” |
| demo-user (entered as Org · SME) | {"orgiq": ["sme"]} | 200 | none (refused) | 0 | “You must join the channel before sending messages” |

   For each of the six the middleware logged `[realtime-gateway] refused subscribe on channel 'assessment:doc:page:100002' for user '<id>' (org 'orgiq')`. The socket itself stays open (presence and session frames still arrive), which is right — the token is valid for its own tenant.

   The UI end, with both assessment panels live: u-farah (program-lead) and u-jonas (lead-assessor) each on `/assessment/workspace?doc=page%3A100002` with the Chat panel open; u-theo then joined and sent “Intruder … from u-theo” with `metadata.displayName: "Farah Osei"` — refused, and the text appears in neither panel (0 matches in each; `chat-cross-tenant-refused.jpg` is Jonas's panel afterwards). The 08:45 leaked message (“Isolation probe: an orgiq member (u-theo) wrote this…”) is gone too, because the mock gateway's store is in memory and the middleware restarted. The assessment side still works: all three assessment roles join the channel and get its history over the socket; Farah's message from the composer dock appeared in her own panel and in Jonas's already-open panel with no reload, and Jonas's reply from the panel's composer appeared in Farah's. 0 console/page errors in either assessment tab. The five outside-role logs and demo-user.md are back to `verdict: pass`.

   One side effect found while verifying, filed as lead-assessor/DEFECTS.md #9 (owner middleware): the router is asked about the name a service subscribes to, and the presence service subscribes to `presence:<channel>`, so the guard now also refuses an assessment user's presence on `assessment:knowledge:<section>` (`refused subscribe on channel 'presence:assessment:knowledge:confluence-eng' for user 'u-jonas' (org 'assessment')`). It does not reopen anything here — it fails closed.

   The original report:

   Found re-walking the isolation logs after the assessment document pages were rebuilt on `EditorShell`. The new composer dock and Chat panel (`portal/src/pages/assessment/knowledge/DocumentConversation.tsx`) put each document's conversation on a chat channel of the BFF's own realtime gateway — `assessment:doc:<docId>` (`conversationChannelForDoc`) — and that gateway's chat channels are not tenant-scoped (`middleware/src/lib/realtime-gateway.ts` scopes only call lobbies; the parity goal says so: "No middleware change: the BFF gateway's chat channels are not tenant-scoped"). The realtime token is minted for every signed-in session regardless of tenant, so the channel is open to the other tenant.

   Evidence, headless Playwright against dev:mock:social on :3001, each persona signed in with the sanctioned `POST /api/session/login` (+ `/role`), then `GET /api/session/realtime-token` (200 for all) and a browser WebSocket to `ws://localhost:3001/ws` with `bearer-token-v1, <token>`, sending `{service:'chat', action:'join', channel:'assessment:doc:page:100002'}`:

   | persona | grants | join | history returned |
   |---|---|---|---|
   | u-theo (member) | {orgiq:[member]} | joined | 4 messages by u-asha, u-jonas, u-farah, u-operator |
   | u-nora (sme) | {orgiq:[sme]} | joined | 5 |
   | u-mia (program-owner) | {orgiq:[program-owner,member]} | joined | 5 |
   | u-vera (org-leader) | {orgiq:[org-leader,member]} | joined | 5 |
   | u-rachel (hr-admin) | {orgiq:[hr-admin,org-leader]} | joined | 5 |
   | demo-user entered as Org · SME | {orgiq:[sme]} | joined | 5 |

   Write, once, as u-theo: a `send` on the same channel was echoed back and now shows in the assessment users' Chat panel for Rubric Overview as "IP · isolation probe · Isolation probe: an orgiq member (u-theo) wrote this into an assessment document conversation" (`isolation/chat-cross-tenant-leak.jpg`, taken as u-jonas). Note the display name there is whatever the sender put in `metadata.displayName` — the gateway does not bind it to the session, so an outsider can post under an assessment user's name.

   Every REST-level isolation fact still holds for these personas (`/api/assessment/teams`, `/api/assessment/knowledge/tree` and `POST /api/assessment/knowledge/canvas` all 403; the routes redirect; no tile, no nav). The five outside-role logs and demo-user.md carry `verdict: fail` for this leak.

   Owner: middleware (`lib/realtime-gateway.ts` — refuse chat joins/sends on `<tenant>:` channels outside the caller's tenant, as it already does for call lobbies, and take the sender name from the verified token) — the portal half (`DocumentConversation.tsx`) should not ship a tenant-private conversation on an unscoped channel until then.

1. **An assessment role typing an orgiq URL lands on a blank page inside the
   orgiq URL space, not on their own home.** — **Closed 2026-09-07 23:44 EDT.**

   The cause was a guard whose fallback pointed *inside the tree it guarded*:
   `App.tsx` wrapped `/iq` and `/admin` in
   `<RequireTenant tenant="orgiq" fallback={<Navigate to="/iq/projects">}>`, so
   for an assessment session the guard denied, the fallback re-entered, the
   guard denied again, and the URL never moved — leaving an empty content
   column under the orgiq breadcrumb "Plan › Initiatives".

   The fix does not just repoint that one arrow. `portal/src/lib/tenantHome.ts`
   is now the **only** place that answers "where does this identity belong":
   `resolveHome(session)` — chooser when there is no session, no usable
   workspace, or an unmade multi-workspace choice; otherwise the front door of
   the tenant the session is standing in (a cross-tenant `admin` is not
   special — `session.tenant` is the workspace they entered, and that
   workspace's home is the right answer). `App.tsx` has one `<HomeRedirect />`
   built on it, used both for `/` and as the fallback of all 23 guards, and it
   renders **not-found** rather than navigating when the home it resolves is
   the page already on screen — so a fallback can never dead-end again, whoever
   writes the next guard. Three drifted copies of the answer were folded in:
   `RootRedirect`'s `/iq/projects`, `auth.tsx`'s `TENANT_HOME` (`/iq/work`,
   used by the tenant switch) and `NotFoundPage`'s "back to home" link
   (`/iq/work`). Pinned by `portal/src/lib/__tests__/tenantHome.test.ts`
   (9 tests), including "an assessment identity is never sent into the orgiq
   tree" and "the tenant switch and `/` agree".

   Evidence, re-observed as the three seeded personas at 1552px on the stock
   mock floor, console errors 0 throughout:

   | user | /iq/projects | /iq/scores | /admin/observability | / |
   |---|---|---|---|---|
   | u-asha (assessor) | → /assessment/teams, 1068 chars | → /assessment/teams | → /assessment/teams | → /assessment/teams |
   | u-jonas (lead-assessor) | → /assessment/teams, 1068 chars | → /assessment/teams | → /assessment/teams | → /assessment/teams |
   | u-farah (program-lead) | → /assessment/teams, 1068 chars | → /assessment/teams | → /assessment/teams | → /assessment/teams |

   `/admin/devbox` and `/admin/identity/users` land the same way, and a path
   that matches no route at all still reads as not-found rather than as a
   redirect (`/iq/nope-does-not-exist` renders "Page not found — Nothing lives
   at /iq/nope-does-not-exist"). The data boundary is unchanged and still
   holds: `/api/graph/people`, `/api/scores/leaderboard`, `/api/work/queue` and
   `POST /api/session/tenant {orgiq}` are 403 for all three. Logs and
   screenshots: `assessor-outbound.md`, `lead-assessor-outbound.md`,
   `program-lead-outbound.md`, all now `verdict: pass`.

   One thing found while closing this, fixed in the same pass: the chooser's
   `markContextChosen()` was dead code. `SelectContextPage.choose()` marks the
   pick, then `enterContext` calls `clearTenantScopedCaches()`, which wipes the
   sessionStorage that marker lives in — so a two-context user (u-jonas,
   u-farah) who had just picked a workspace was sent straight back to /select
   by the very next home resolution. `enterContext` now re-marks the same
   `sub` after the scrub. A different identity still re-drives through the
   chooser: `login`/`logout` call `clearContextChosen()` outright.

2. **`LocalComputeBadge` mounts in every tenant's shell, so orgiq Computer Lab
   chrome appears in the assessment header.** — **Closed 2026-09-07 23:57 EDT**
   (fixed by another agent; verified here).

   Both halves are in place. Client: `Layout.tsx:304` now reads
   `{session?.tenant === 'orgiq' && <LocalComputeBadge />}`, matching its two
   neighbours. Server: `middleware/src/routes/local-compute.ts` applies
   `requireTenant('orgiq')` **per route** to the browser half (`/nodes`,
   `/nodes/all`, `/stream`) and deliberately not at the mount, so the
   session-less machine callbacks (`/announce`, `/heartbeat`,
   `/sessions/:id/end`, `/pair/claim`) still work.

   Verified on the identity that reproduced it — demo-user, who owns
   `node-demo-macbook`. In Assessment · Program Lead the header reads
   `Assessment | Mock: … | ⌘K Search | Demo User | Assessment · program-lead`
   with no `⌂ demo-macbook` anywhere in the document, and
   `GET /api/local-compute/nodes` answers **403**
   `{"error":"Forbidden","requiredTenant":"orgiq","tenant":"assessment"}`
   (it answered 200 with `node-demo-macbook` on 2026-09-07 22:23). Switching
   the same identity to Org · SME brings the badge back — `⌂ demo-macbook · 1`
   — and the endpoint back to 200, which is the point: the badge was scoped to
   the tenant, not removed. It is 403 for u-asha, u-jonas and u-farah too, so
   the "any dual-grant user reaches it the moment they register a machine"
   exposure is closed at the API, not just hidden in the shell.
   Screenshots: `local-compute-badge-in-assessment.jpg` (the pre-fix leak,
   kept as the before-state) and `local-compute-badge-gated.jpg` (after).

   The follow-up this entry raised is now **done (2026-09-08)**.
   `scripts/validate-assessment-tenant.sh` used to grep for `DevboxQuickSwitch`
   and `ComputeDock` by name, so the ratchet could not have caught this defect
   and would not have caught the next such component. That check now names what
   it means instead of enumerating two things: it collects every component
   `Layout.tsx` mounts whose name carries the Computer-Lab vocabulary
   (`Devbox|Compute|Machine`) and requires each one to be gated on
   `session?.tenant === 'orgiq'`, with a floor of three so a rename OUT of that
   vocabulary fails loudly rather than emptying the check. Proved both ways
   before it was accepted: with `LocalComputeBadge` temporarily un-gated the
   script fails naming it (`✗ Computer-Lab chrome mounts in every tenant's shell
   — gate on session?.tenant === 'orgiq': LocalComputeBadge`), and with the gate
   restored it passes naming all three (`✓ every Computer-Lab component the
   shell mounts is gated on the orgiq tenant (3: ComputeDock DevboxQuickSwitch
   LocalComputeBadge)`).

   Re-verified 2026-09-08 on the identity that reproduced the defect, through
   the real chooser rather than an API login, with both halves of the gate
   watched on one session: as **demo-user in Assessment · Program Lead** the
   header reads "Assessment | Mock: … | ⌘K Search | Demo User | Assessment ·
   program-lead", the string "macbook" occurs nowhere in the document, and
   `GET /api/local-compute/nodes` answers 403
   `{"error":"Forbidden","requiredTenant":"orgiq","tenant":"assessment"}`;
   switching the same identity to **Org · SME** brings back both the chip
   (`⌂ demo-macbook · 1`) and the 200. Scoped to the tenant, not removed —
   which is the distinction this defect was about. `.shell-header` is 61px in
   both. The endpoint is also 403 for u-asha and u-farah, so the exposure is
   closed at the API and not merely hidden in the shell.

<details>
<summary>Original reports (2026-09-07 22:05–22:25 EDT)</summary>

### The two reports as filed


1. **An assessment role typing an orgiq URL lands on a blank page inside the
   orgiq URL space, not on their own home.** `portal/src/App.tsx:256` (the
   `/iq` tree) and `:373` (the `/admin` tree) both guard with
   `<RequireTenant tenant="orgiq" fallback={<Navigate to="/iq/projects" replace />}>`
   — a fallback that points *inside the tree it is guarding*. So for a session
   whose tenant is `assessment`:
   - `/iq/projects` → the guard denies, renders `<Navigate to="/iq/projects">`,
     the guard denies again. The URL never moves. `[data-shell-nav] main`
     contains one breadcrumb — the orgiq trail **"Plan › Initiatives"** — and an
     empty content div. Verified DOM:
     `<div class="h-full flex flex-col bg-bg"><nav aria-label="Breadcrumb">…Plan › Initiatives…</nav><div class="flex-1 min-h-0 overflow-auto"></div></div>`
   - `/iq/scores` → `/iq/projects`, same blank page.
   - `/admin/observability` → `/iq/projects`, same blank page.
   - `/` → `/assessment/teams` correctly, so the app *knows* the right home; only
     these two fallbacks don't use it.

   Reproduced identically as all three assessment personas: u-asha (assessor),
   u-jonas (lead-assessor), u-farah (program-lead). Screenshots:
   `assessor-outbound.jpg`, `lead-assessor-outbound.jpg`,
   `program-lead-outbound.jpg`.

   Why it matters rather than being cosmetic: the tenant *data* boundary holds
   (rail carries 0 anchors matching `^/(iq|admin|newsroom)`, and
   `/api/graph/people`, `/api/scores/leaderboard`, `/api/work/queue` and
   `POST /api/session/tenant {orgiq}` all return 403). But the *route* boundary
   now reads as an outage: a person who follows a stale link is parked at
   `/iq/projects` under the other product's breadcrumb with nothing on the page
   and no way back except the rail. `docs/orgiq-journeys/PROTOCOL.md` §5 is
   explicit that a blocked route must read as not-found, not as an outage. The
   comment directly above the guard states the intent — "an assessor who types
   /iq/projects must land on their own home" — which is exactly what does not
   happen.

   Fix hint: the `/assessment` tree at `App.tsx:227` gets this right because its
   fallback names the *other* tenant's home. The two orgiq trees should fall
   back to `<Navigate to="/" replace />` (Home already resolves per tenant) or to
   `/assessment/teams`, not to a route they themselves guard.

   Consequence for the logs: `assessor-outbound.md`, `lead-assessor-outbound.md`
   and `program-lead-outbound.md` now carry
   `orgiq-route-result: dead-end` and `verdict: fail`. The five inbound logs
   (member, sme, program-owner, org-leader, hr-admin) are unaffected — the
   assessment tree's fallback sends an orgiq user to `/iq/projects`, which for
   them is a real, populated page.

2. **`LocalComputeBadge` mounts in every tenant's shell, so orgiq Computer Lab
   chrome appears in the assessment header — reproducible on the stock mock
   floor, no instrumentation.** `portal/src/components/shell/Layout.tsx:298`
   renders `<LocalComputeBadge />` unconditionally, unlike `<DevboxQuickSwitch>`
   and `<ComputeDock>` on the lines around it, which are both gated on
   `session?.tenant === 'orgiq'` (and which
   `scripts/validate-assessment-tenant.sh` checks for by name). Server side,
   `middleware/src/routes/local-compute.ts:229` gates `GET /nodes` with
   `requireSession('ViewLocalCompute')` — an authentication floor, no tenant
   scope — and the handler filters by owner only
   (`listNodesByOwner(session.sub)`, `providers/local-compute.ts:199`), never by
   tenant.

   Repro, exactly as observed at 22:23 EDT:
   1. `/select` → Sign out (the cookie-less Demo User identity).
   2. Workspaces → **Assessment → Assessor**. `/api/session/me` narrows to
      `{assessment:["assessor"]}`, tenant `assessment`, and the app lands on
      `/assessment/teams`.
   3. The assessment header now reads
      `Assessment | … | ⌘K Search | ⌂ demo-macbook · 1 | Demo User | Assessment · assessor`.
      `GET /api/local-compute/nodes` returns **200** with
      `node-demo-macbook` (`ownerId: "demo-user"`), because the mock floor seeds
      that node for the demo identity.
   4. Opening the badge shows, inside the assessment product:
      `DEMO-MACBOOK · darwin/arm64 · CONNECTED · p-realtime · feat/presence-mesh ·
      ollama · qwen2.5-coder:14b · "wire the presence mesh into the gateway" ·
      ctx 31% · 7 pending` — an orgiq initiative id, an orgiq branch and an
      orgiq work intent — plus an **"Open Computer Lab"** action.
   5. Clicking it navigates to `/admin/devbox`, which hits defect 1 and dead-ends
      on a blank `/iq/projects`.

   Screenshot: `local-compute-badge-in-assessment.jpg` (step 4, unstubbed).
   The seeded personas do not have a node, so `nodes` is `[]` for u-asha, u-jonas
   and u-farah and the badge renders null for them today — but their API call
   still returns 200, not 403, so the only thing between them and the same
   header is whether a machine is registered against their `sub`. Any dual-grant
   user (the `admin` persona u-operator, or a future one) reaches it the moment
   they register a machine.

   Fix hint: gate the mount the way its two neighbours are gated
   (`session?.tenant === 'orgiq' && <LocalComputeBadge />`), and/or scope
   `GET /api/local-compute/nodes` to the caller's tenant. The validator's
   "Computer Lab chrome gated on the orgiq tenant" check should grow to name
   `LocalComputeBadge` too, otherwise the next such component ships ungated
   again.

</details>

## Not filed

- The header badge did **not** change layout or density anywhere, in either
  tenant, with or without a machine present. Measured on /iq/projects at 1552px
  as u-nora and u-theo (badge absent) and on /assessment/teams as Demo User
  (badge present, "⌂ demo-macbook · 1"): `.shell-header` is 61px in every case,
  `first-row-top` on /iq/projects is 369px, and
  `document.documentElement.scrollWidth <= innerWidth` holds. The badge adds one
  focusable button to the header, between Search and the user menu, in document
  order; its popover opens on click and closes on Escape. Console errors were 0
  on every surface visited in this pass. The badge's *placement* is fine; only
  its *tenant scope* (defect 2) is wrong.

--- re-verification 2026-09-16 03:58 (Layout.tsx changed: shell chrome pass) ---
Why: `portal/src/components/shell/Layout.tsx` changed — the site header is wrapped in a native
`<header>` landmark, the ⌘I devbox switcher now runs through the same CommandPalette as ⌘K
(a "Devbox" group, scoped while ⌘I is open), and the account menu's panel is the library
InlinePopover (outside-click / Escape / focus return from useDismissableLayer). None of this
touches tenant gating: the rail items, the palette's page list and the tenant guards are the
same code paths as before. Re-checked the API floor with fresh sessions: every orgiq persona
(u-theo, u-nora, u-mia, u-vera, u-rachel) still gets 403 from GET /api/assessment/teams, each
assessment persona (u-asha, u-jonas, u-farah) still gets 403 from GET /api/graph/people, and
the cookie-less demo identity gets 403 from /api/assessment/teams. Console errors 0 on the
shell as Vera Green.

--- re-verification 2026-09-16 05:05 (Layout.tsx changed: ui-components 2.273.0 adoption) ---
Why: the shell's ChannelHeader renders as a real `<header>` (as="header") instead of being
wrapped, and the shell SubNavLayout carries `railLabel` ("Org navigation" / "Assessment
navigation"). Tenant gating is untouched. Re-checked the API floor with fresh sessions: every
orgiq persona (u-theo, u-nora, u-mia, u-vera, u-rachel) still gets 403 from GET
/api/assessment/teams, each assessment persona (u-asha, u-jonas, u-farah) still gets 403 from
GET /api/graph/people, and the cookie-less demo identity gets 403. Console errors 0.

--- freshness re-observation, 2026-09-16 08:20 (the shell rail moved off inline styles) ---
Why: `portal/src/components/shell/Layout.tsx` is in this log's `pages:` digest —
its `renderNavItem` stopped hand-computing an inline `style` object and now
returns ui-components 2.275.1's `activeNavItemClassName`/`inactiveNavItemClassName`.
That changes how a rail item is painted, not which items exist, but this log's
whole claim is about which items exist, so every fact below was re-taken rather
than carried forward.
  Rail, orgiq side (u-theo, member, /iq/projects): 11 anchors, 0 matching
  /assessment, the string "assessment" occurs 0 times in the document, exactly
  one item lit (Initiatives) and 0 anchors carry a `style` attribute.
  Rail, assessment side (u-asha, assessor, /assessment/teams): 8 anchors, 0
  matching /iq/ or /admin/, one lit (Dashboard), 0 inline styles.
  Direct routes: /assessment/teams as u-theo → /iq/projects (h1 "Initiatives"),
  no flash of assessment content; /iq/projects as u-asha → /assessment/teams
  (h1 "Assessor's desk").
  API floor, fresh cookie jars: GET /api/assessment/teams → 403 for u-theo,
  u-nora, u-mia, u-vera and u-rachel; GET /api/graph/people → 403 for u-asha,
  u-jonas and u-farah. Cookie-less: /api/assessment/teams 403, /api/graph/people
  404 (that route is not mounted for an anonymous caller, so no guard runs — it
  is recorded here as measured rather than as the 403 an earlier entry claimed).
Console errors: 0.
addendum, same session: `Layout.tsx` was edited once more after the observation above — the active rail item's fill class was swapped from the library's `bg-surface-hover` to `bg-primary-soft`, restoring the brand tint the branding cells record (see docs/branding-journeys/*.md, 2026-09-16 08:40). That is a `background-color` change on the one already-lit anchor: it adds, removes and re-targets no rail item, so every isolation fact re-taken above stands unchanged.
addendum, 2026-09-16 09:33: `Layout.tsx` changed again — the command palette's prompt text now reflects the scoped (⌘I) dialog instead of always advertising the full tenant search, and the shell rail is otherwise untouched. No rail item was added, removed or re-gated, so every isolation fact re-taken in the 08:20 entry above stands.

## Observation — 2026-10-08 — a direct cross-tenant URL lands on the workspace picker when the session was not entered through the picker

Found while re-walking the isolation logs: a session created by `POST /api/session/login` alone (no picker click, so no `orgiq.contextChosen` sessionStorage marker) that opens a tenant it cannot use (`/assessment/teams` as u-theo, `/iq/projects` as u-asha) lands on `/select` ("Choose a workspace") instead of its own tenant home. With the marker the picker's row click sets, the same URLs redirect to `/iq/projects` and `/assessment/teams` and every log above records that. No data is exposed either way (every assessment and orgiq API answered 403 in both states). Recorded as a behaviour difference between the two entry paths, not as a leak.
