role: assessor
user: u-asha
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-30 04:59Z → 04:59Z, Chromium 1552×958 (Playwright headless, a fresh context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183 — re-walked after lane S2 changed App.tsx (the /social/* routes now point at the rooms, calls, contacts, teams, recordings and configuration pages)
social-grant: yes                 # /api/session/me: sub u-asha, tenant assessment, role assessor, grants {"assessment":["assessor"],"social":["participant"]}
social-tile-visible: yes          # /select Workspaces tab: tiles ["assessment","social"] (data-testid select-roles-*)
social-nav-visible: no            # /assessment/teams: 11 anchors in [data-shell-nav], 0 toward /social; ⌘K "Direct messages" lists 0 commands, 0 of them a social page
direct-route-result: redirect      # /social/channels → /assessment/teams (h1 "Assessor's desk"); /social/rooms → /assessment/teams (h1 "Assessor's desk"); /social/dms → /assessment/teams (h1 "Assessor's desk"); 0 social page test ids rendered
api-status: 403                   # /api/social/summary 403, /api/social/channels 403, /api/social/rooms 403, /api/social/teams 403, /api/social/recordings 403, /api/social/calls 403; POST /api/session/tenant {social} skipped (grant held)
activity-leak: none               # bell opened: "Notifications1 Mark all read Clear all Unread (1) All Farah Osei mentioned you Assessment · Mention — On “What Counts as Evidence”: @Asha Nair can you check the verbal-confirmation line against last cycle? 5h ago", 0 item links, 0 outside the tenants held
console errors: 0 — the 6 "Failed to load resource: 403" lines the walk's own API probes log are the answers under test (api-status), counted apart
screenshot: assessor.jpg                # /select as this identity
screenshot-direct-route: assessor-direct-route.jpg   # where typing /social/dms lands
verdict: pass
notes: POST /api/session/login {userId:u-asha} → 200 (the call the Sign-in-as card makes), then sessionStorage['orgiq.contextChosen'] set to the sub — what the chooser's markContextChosen() does. This identity holds a social grant, so the Social tile shows on the picker — and the session standing in its own tenant still cannot reach /social/* or /api/social/* (the S2 routes included): the gate is the session's tenant, not the grant list.
