role: community-admin
user: u-mira
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx
audited: 2026-10-22 23:33–23:34 local, headless Chromium 1680×940 (Playwright), a fresh signed-in clone of u-mira (u-mira-clone-bb4f7edb) in the social tenant, no second context; Tilt stack: Vite :5183 over middleware :3001 (dev:mock), Social platform-api :23002, SFU :3902; mock not reset (shared stack)
session: sub u-mira-clone-bb4f7edb, tenant social, role community-admin
identity: sub u-mira-clone-bb4f7edb, tenant social, role community-admin, grants {"social":["community-admin"]}
orgiq-nav-visible: no         # /social/channels (h1 “Channels”): 10 anchors in the shell nav, 0 matching /^\/(iq|admin)/; 11 on the whole page, 0 matching; ⌘K "Initiatives" lists 4 commands, 0 of them an orgiq page
orgiq-route-result: redirect   # /iq/projects → /social/channels (h1 “Channels”); /iq/runs → /social/channels (h1 “Channels”); /iq/search → /social/channels (h1 “Channels”)
orgiq-api-status: 403   # /api/bots 403, /api/graph/people?limit=1 403, /api/work/summary 403, /api/runs 403, /api/search?q=auth 403; POST /api/session/tenant {orgiq} 403 (session after: u-mira-clone-bb4f7edb/social/community-admin)
assessment-nav-visible: no         # same page: 0 shell-nav anchors and 0 page anchors matching /^\/assessment/; ⌘K "Teams" lists 13 commands, 0 of them an assessment page
assessment-route-result: redirect   # /assessment/teams → /social/channels (h1 “Channels”); /assessment/workspace?doc=page%3A100002 → /social/channels (h1 “Channels”)
assessment-api-status: 403   # /api/assessment/teams 403, /api/assessment/knowledge/tree 403, /api/assessment/pipeline-runs 403; POST /api/session/tenant {assessment} 403 (session after: u-mira-clone-bb4f7edb/social/community-admin)
activity-leak: none   # bell opened on /social/channels: “Notifications UnreadAllNothing newActivity will appear here.”; 0 link(s), 0 toward /iq or /admin, 0 toward /assessment, 0 toward /pipelines
page-family-receipts: refused   # own realtime token (tenants ["social"]): 10 hand-built chat/presence frames (join, history, read, receipts, presence subscribe on each of assessment:doc:page:100002, orgiq:initiative:p-auth-migration) → 10 AUTHZ_CHANNEL_DENIED, 0 frames naming a probed channel that were not a refusal (2 unrelated socket-own frames: ["presence/set","session"])
console errors: 0
screenshot: community-admin-outbound.jpg   # where the last typed orgiq URL leaves you
screenshot-direct-route: community-admin-outbound-direct-route.jpg   # where the last typed assessment URL leaves you
verdict: pass
notes: POST /api/session/login {userId:u-mira-clone-bb4f7edb} → 200 for the clone (grants copied from u-mira: {"social":["community-admin"]}); the clone holds only a social grant, so the refused tenant switches touch no real session. Every field above was taken in this pass. ⌘K entries for "Initiatives": ["ChannelsConversations the te","Work graphYour conversations","#auth-migrationAuth migratio","@Asha Nair this one for rele"]; for "Teams": ["ChannelsConversations the te","Direct messagesOne-to-one an","CallsStart or join a call","RoomsStanding rooms you can ","TeamsTeams and their channel","ProfileHow you appear to oth","ConfigurationRetention, room","Journey participant 185623Te","Journey moderator 185350Team","Journey moderator 184919Team","Journey moderator 184637Team","ModerationTeam · 2 members: "]. The bell is the clone's own feed (a fresh clone has no notifications), so activity-leak is judged on what this clone's bell holds. No horizontal scroll on /social/channels (1680 / 1680). Not exercised: the Social bottom bar and keyboard traversal (not fields of an isolation log).
