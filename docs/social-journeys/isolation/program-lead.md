role: program-lead
user: u-farah
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-10-08 11:08Z, Chromium (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), 1680×940, Tilt stack: Vite :5183 over middleware :3001 (mock providers)
identity: sub u-farah, tenant assessment, role lead-assessor, grants {"assessment":["program-lead","lead-assessor"],"social":["participant"]}
social-grant: yes                 # /api/session/me grants {"assessment":["program-lead","lead-assessor"],"social":["participant"]}
social-tile-visible: yes          # /select Workspaces tab: tiles ["assessment","social"] (data-testid select-roles-*)
social-nav-visible: no            # /assessment/teams: 14 anchors in the shell nav, 0 toward /social; ⌘K "Direct messages" lists 1 commands, 1 matching a social page name; ⌘K "Runbooks" lists 1 commands, 0 matching a social page name; ⌘K "Rubric" lists 0 commands, 0 matching a social page name; ⌘K "Channels" lists 5 commands, 1 matching a social page name
direct-route-result: redirect      # /social/channels → /assessment/teams (h1 “Assessor's desk”); /social/rooms → /assessment/teams (h1 “Assessor's desk”); /social/dms → /assessment/teams (h1 “Assessor's desk”); 0 social page test ids rendered
api-status: 403                   # /api/social/summary 403, /api/social/channels 403, /api/social/rooms 403, /api/social/teams 403, /api/social/recordings 403, /api/social/calls 403; /api/social/bindings?context=initiative%3Ap-auth-migration 403; POST /api/session/tenant {social} skipped
activity-leak: none               # bell opened: “Notifications29 Mark all read Clear all Unread (29) All Sana Iqbal in #general Social · Message — reply u-sana channels37w0qb 3m ago Sana Iqbal in #general Social · Message — reply u-sana channels 69etw7 3m ago Mira Okaf”; 0 link(s), 0 toward /social (this identity holds a social grant, so Social items are its own), 0 toward /pipelines
page-family-receipts: refused   # own realtime token: 5 chat/presence frames (join, history, read, receipts, presence subscribe) on pipelines:run:bot-run:run-inflight-obs-e1-s3, a channel this identity cannot read → 5 AUTHZ_CHANNEL_DENIED, 0 non-refusal frames naming it (3 unrelated socket-own frames)
console errors: 0 — the API probes go through the context request client, so their 403s never reach the page console
screenshot: program-lead.jpg                # /select as this identity
screenshot-direct-route: program-lead-direct-route.jpg   # where the last typed social URL leaves you
verdict: pass
notes: POST /api/session/login {userId:u-farah} → 200, then sessionStorage['orgiq.contextChosen'] set to the sub. Every field above was taken in this pass. This identity holds a social grant, so the picker shows the Social tile; its realtime token admits social:ch:general (probe frames: 0 refusals, 5 non-refusal frames naming it: ["notification:bulk-update/:","chat/joined:social:ch:general","presence/subscribed:social:ch:general","chat/history:social:ch:general","chat/history:social:ch:general"]); the session standing in its own tenant still cannot reach /social/* pages or the tenant-gated /api/social/* surface. No horizontal scroll (1680 / 1680). Session after the pass: u-farah/assessment/lead-assessor.
