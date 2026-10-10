role: demo-user (cookie-less fallback identity, dev only)
user: demo-user
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-10-08 11:09Z, Chromium (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), 1680×940, Tilt stack: Vite :5183 over middleware :3001 (mock providers)
identity: sub demo-user, tenant orgiq, role member, grants {"orgiq":["member","sme","program-owner","org-leader","hr-admin","admin"],"assessment":["assessor","lead-assessor","program-lead","admin"]}
social-grant: no                 # /api/session/me grants {"orgiq":["member","sme","program-owner","org-leader","hr-admin","admin"],"assessment":["assessor","lead-assessor","program-lead","admin"]}
social-tile-visible: no          # /select Workspaces tab: tiles ["orgiq","assessment"] (data-testid select-roles-*)
social-nav-visible: no            # /select: 0 anchors in the shell nav, 0 toward /social; ⌘K "Direct messages" lists 0 commands, 0 matching a social page name; ⌘K "Runbooks" lists 0 commands, 0 matching a social page name; ⌘K "Rubric" lists 0 commands, 0 matching a social page name; ⌘K "Channels" lists 0 commands, 0 matching a social page name
direct-route-result: redirect      # /social/channels → /select (h1 “Choose a workspace”); /social/rooms → /select (h1 “Choose a workspace”); /social/dms → /select (h1 “Choose a workspace”); 0 social page test ids rendered
api-status: 403                   # /api/social/summary 403, /api/social/channels 403, /api/social/rooms 403, /api/social/teams 403, /api/social/recordings 403, /api/social/calls 403; /api/social/bindings?context=initiative%3Ap-auth-migration 403; POST /api/session/tenant {social} 403
activity-leak: none               # bell opened: “(no bell on this page)”; 0 link(s), 0 toward /social, 0 toward /pipelines
forged-subscribe: AUTHZ_CHANNEL_DENIED   # demo-user (tenant orgiq, none in social): a raw browser WebSocket to ws://127.0.0.1:3001/ws with its own realtime token (tenants ["orgiq","assessment"]), hand-built frames chat join, chat history, presence subscribe on social:ch:general → 2 AUTHZ_CHANNEL_DENIED (presence/subscribe:social:ch:general, chat/subscribe:social:ch:general); other refusal frames ["chat/:"]; 0 non-error frames naming the channel (no history, message or joined frame reached it)
page-family-receipts: refused   # own realtime token: 5 chat/presence frames (join, history, read, receipts, presence subscribe) on pipelines:run:bot-run:run-inflight-obs-e1-s3, a channel this identity cannot read → 5 AUTHZ_CHANNEL_DENIED, 0 non-refusal frames naming it (2 unrelated socket-own frames)
console errors: 0 — the API probes go through the context request client, so their 403s never reach the page console
screenshot: demo-user.jpg                # /select as this identity
screenshot-direct-route: demo-user-direct-route.jpg   # where the last typed social URL leaves you
verdict: pass
notes: No sign-in: the cookie-less demo identity. Every field above was taken in this pass. No social grant: no tile, the tenant switch is refused. No horizontal scroll (1680 / 1680). Session after the pass: demo-user/orgiq/member.
