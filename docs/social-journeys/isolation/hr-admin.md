role: hr-admin
user: u-hr
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-10-08 11:07Z, Chromium (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), 1680×940, Tilt stack: Vite :5183 over middleware :3001 (mock providers)
identity: sub u-hr, tenant orgiq, role hr-admin, grants {"orgiq":["hr-admin"]}
social-grant: no                 # /api/session/me grants {"orgiq":["hr-admin"]}
social-tile-visible: no          # /select Workspaces tab: tiles ["orgiq"] (data-testid select-roles-*)
social-nav-visible: no            # /iq/projects: 23 anchors in the shell nav, 0 toward /social; ⌘K "Direct messages" lists 14 commands, 2 matching a social page name; ⌘K "Runbooks" lists 11 commands, 0 matching a social page name; ⌘K "Rubric" lists 27 commands, 0 matching a social page name; ⌘K "Channels" lists 19 commands, 2 matching a social page name
direct-route-result: redirect      # /social/channels → /iq/projects (h1 “All initiatives”); /social/rooms → /iq/projects (h1 “All initiatives”); /social/dms → /iq/projects (h1 “All initiatives”); 0 social page test ids rendered
api-status: 403                   # /api/social/summary 403, /api/social/channels 403, /api/social/rooms 403, /api/social/teams 403, /api/social/recordings 403, /api/social/calls 403; /api/social/bindings?context=initiative%3Ap-auth-migration 403; POST /api/session/tenant {social} 403
activity-leak: none               # bell opened: “Nothing new Activity will appear here.”; 0 link(s), 0 toward /social, 0 toward /pipelines
forged-subscribe: AUTHZ_CHANNEL_DENIED   # u-hr (tenant orgiq, none in social): a raw browser WebSocket to ws://127.0.0.1:3001/ws with its own realtime token (tenants ["orgiq"]), hand-built frames chat join, chat history, presence subscribe on social:ch:general → 2 AUTHZ_CHANNEL_DENIED (chat/subscribe:social:ch:general, presence/subscribe:social:ch:general); other refusal frames ["chat/:"]; 0 non-error frames naming the channel (no history, message or joined frame reached it)
page-family-receipts: refused   # own realtime token: 5 chat/presence frames (join, history, read, receipts, presence subscribe) on pipelines:run:bot-run:run-inflight-obs-e1-s3, a channel this identity cannot read → 5 AUTHZ_CHANNEL_DENIED, 0 non-refusal frames naming it (2 unrelated socket-own frames)
console errors: 0 — the API probes go through the context request client, so their 403s never reach the page console
screenshot: hr-admin.jpg                # /select as this identity
screenshot-direct-route: hr-admin-direct-route.jpg   # where the last typed social URL leaves you
verdict: pass
notes: POST /api/session/login {userId:u-hr} → 200, then sessionStorage['orgiq.contextChosen'] set to the sub. Every field above was taken in this pass. No social grant: no tile, the tenant switch is refused. No horizontal scroll (1680 / 1680). Session after the pass: u-hr/orgiq/hr-admin.
