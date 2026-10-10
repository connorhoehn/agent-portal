# Escalation review 2026-10-05

The `realtime-gateway.ts` regex should **not** be swapped for the library's `splitServiceChannel` yet. Its `chat:` strip is load-bearing, because the library itself creates `chat:dm:…` channel names that its own helper doesn't recognise. Two of the "hand-rolled" items already have library components the auditor missed (`TraceTimeline`, `TreeView`). Library versions checked: realtime-modules 0.106.0 (`c5c967ee`, both consumers) and ui-components 2.409.0 dist.

## Verified findings (ranked)
| # | file:line | verdict | fix location | sketch |
|---|---|---|---|---|
| 1 | `middleware/src/lib/realtime-gateway.ts:249-252` (used at :225, :257, :332, :370) | **Real, but don't swap now. Should move upstream.** The library's `SERVICE_CHANNEL_PREFIXES` only lists `presence`, `reactions` and `cursor` (`dist/server-ws/channelAccess.js:27`). But the library's own `channelForLobby` returns `chat:dm:…` and `chat:dmg:…` (`dist/call/lobbyChannel.js:57`), and `lobbyForChannel` strips `chat:` (:41-44). Swapping now would refuse DM call chat, because `chat:social:dm:…` fails the tenant-partition rule. The extra `typing`, `activity` and `pins` prefixes appear in no service channel name I found. `activity:broadcast` (`dist/server/manifest.js:68`) strips to `broadcast` and is refused, so it fails closed. Over-stripping only ever maps a name onto its base channel's authority, never a weaker one, and `chat:orgiq:huddle:*` still hits `inCallChatNamespace` (`call-chat.ts:15`). Authority stays per-call fresh in `authorizeLiveGatewayChannel`, so there is no fence problem. | realtime-modules, then gateway | Upstream: export a `baseChannel(name)` from `/server` that understands the library's own `chat:` lobby form (keep `SERVICE_CHANNEL_PREFIXES` service-only). Then the gateway passes `baseChannel` and drops `typing\|activity\|pins`, with a test proving no subscription uses them. No authority caching. |
| 2 | `portal/src/components/ingest/SiteSurveyPanel.tsx:355-372` | **Real, duplicate of library.** It's a hand-rolled recursive tree with `paddingLeft: depth*14` and no queue row (queue row 85 covers only the Button variant). `TreeView` exists (`ui-components dist/shared.d.ts:5935`, `TreeNode` :5910) with `parentId`, `badge`, controlled expansion and `renderTrailing`. | portal | Flatten `SurveyNode` into `TreeNode[]` and use `renderTrailing` for the in-scope tint/badge. |
| 3 | `portal/src/components/observability/ToolWaterfall.tsx:161,174` | **Real, duplicate of library.** `TraceTimeline` (`dist/agents.d.ts:558`; its `title` prop is documented for "an agent step's tool calls", :563-571) already draws this waterfall. | portal | Map tool calls to `TraceSpan`s with `status` from `errored`. I didn't check label-inside/outside parity; if it's missing, add a queue row rather than keep a local copy. |
| 4 | `portal/src/pages/social/socialChat.ts:73-76`, `middleware/src/lib/social-chat.ts:88-92`, `middleware/src/lib/social-notify.ts:360-365` | **Real, duplicate of library.** The auditor was wrong to call this upstream-needed: `dmLobbyMembers` is exported from `/call` (`dist/call/lobbyChannel.d.ts:43`, `.js:124`). It reads past tenant prefixes and returns null when there are fewer than two members. The local copies differ: the portal returns `[]`, and `parseDmLobby` accepts a single member. | portal + middleware, now | Keep the local `social:dm:` prefix check, then call `dmLobbyMembers`. `parseDmLobby` becomes the tenant (first segment) plus `dmLobbyMembers`. |
| 5 | `middleware/src/lib/social-chat.ts:80-86` (`dmChannelFor`) | **Real, should move upstream.** It duplicates `dmLobbyName`, but that function is only exported from `/client/video` (`dist/client/video/conversationLobby.js:22`). The middleware shouldn't import a client subpath. | realtime-modules | Re-export `dmLobbyName` from `/call` (no React). Then `dmChannelFor = ids => dmLobbyName(ids, { prefix: 'social:' })`, keeping its fewer-than-two check. |
| 6 | `portal/src/components/shell/SharedNotifications.tsx:23-31` | **Real, should move upstream.** The hook's `markAsRead`/`markAllRead` don't notify the server (`dist/client/useNotifications.d.ts:58-61`), so the portal relays them itself. realtime-examples' `NotificationsContext.tsx` has no relay at all, so its replayed unread state probably diverges too. | realtime-modules | `useNotifications({ syncReads?: boolean })` would send `{service:'notification', action:'markRead', id}` and `markAllRead`, but only while connected. Then the provider just shares the hook's value. |
| 7 | `scripts/audit-loop/raw-scan.mjs:6` | **Real.** The scanner doesn't skip comments. All 8 SkillFilter hits are comment text (`SkillFilter.tsx:118-130`), so the exemption retirement in queue rows 38/47 is correct. | this repo's script | Blank `//…` and `/*…*/` runs (outside quoted strings) before the tag walk. |
| 8 | `portal/src/components/canary/edges/WeightedEdge.tsx:55-58` | **Partly real.** `stroke: 'var(--color-primary…)'` is static and should be a class. `strokeWidth` and the label transform (:69) are data-driven xyflow geometry but have no queue row. | portal | Move the stroke to a class and add a queue row for the geometry. |
| 9 | `portal/src/components/ingest/Thumbnail.tsx:42,57` | **Real, low.** Data-driven `width`/`height` plus a raw `<img>`, with no queue row. | portal | Add a queue row. I didn't check whether ui-components' `Image` mentions fit. |

## Rejected findings
- Finding 3 as stated ("no library parser exists"): `dmLobbyMembers` exists (`dist/call/lobbyChannel.d.ts:43`). It's folded into row 4 above.
- "Missing primitive: waterfall/gantt bar": `TraceTimeline` is present (`agents.d.ts:558`).
- "Missing primitive: Tree/indent prop": `TreeView` is present (`shared.d.ts:5935`).
- SkillFilter as a stale exemption: it's a scanner false positive, not a stale row (row 7 above).
- Swapping finding 1 directly for `splitServiceChannel`: that would break DM call chat (`lobbyChannel.js:57`).

No new ui-components primitive is needed this run.

## Library work to batch into one release
These are all realtime-modules; ui-components needs nothing unless the `TraceTimeline` label check fails.

1. `/server`: a `baseChannel(name)` that strips the service prefixes plus the library's own `chat:` lobby form, with its rule documented next to `channelForLobby` so the two can't drift (finding 1).
2. `/call`: re-export `dmLobbyName`, with no React dependency (finding 5).
3. `/client`: `useNotifications({ syncReads })` that sends `markRead`/`markAllRead` to the gateway (finding 6). Mirror it in realtime-examples' `NotificationsContext.tsx` in the same release.

After the release:
- Pin the full 40-character SHA in both consumers.
- Have the gateway adopt `baseChannel`, with a test that `chat:social:dm:a:b` is still admitted for members and `activity:broadcast` is still refused.
- Rerun the gateway suites.

Portal-only work that can ship now is findings 2, 3, 4, 7, 8 and 9.
