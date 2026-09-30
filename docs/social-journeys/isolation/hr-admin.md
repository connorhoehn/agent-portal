role: hr-admin
user: u-hr
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-30 04:59Z → 04:59Z, Chromium 1552×958 (Playwright headless, a fresh context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183 — re-walked after lane S2 changed App.tsx (the /social/* routes now point at the rooms, calls, contacts, teams, recordings and configuration pages)
social-grant: no                 # /api/session/me: sub u-hr, tenant orgiq, role hr-admin, grants {"orgiq":["hr-admin"]}
social-tile-visible: no          # /select Workspaces tab: tiles ["orgiq"] (data-testid select-roles-*)
social-nav-visible: no            # /iq/projects: 35 anchors in [data-shell-nav], 0 toward /social; ⌘K "Direct messages" lists 13 commands, 0 of them a social page
direct-route-result: redirect      # /social/channels → /iq/projects (h1 "All initiatives"); /social/rooms → /iq/projects (h1 "All initiatives"); /social/dms → /iq/projects (h1 "All initiatives"); 0 social page test ids rendered
api-status: 403                   # /api/social/summary 403, /api/social/channels 403, /api/social/rooms 403, /api/social/teams 403, /api/social/recordings 403, /api/social/calls 403; POST /api/session/tenant {social} 403
activity-leak: none               # bell opened: "Nothing new Activity will appear here.", 0 item links, 0 outside the tenants held
forged-subscribe: AUTHZ_CHANNEL_DENIED   # 2026-09-30 05:35Z, u-hr (Priya Desai, tenant orgiq, grants {"orgiq":["hr-admin"]}): GET /api/session/realtime-token 200, a raw socket on ws://localhost:3001/ws, then hand-built frames — presence subscribe social:ch:general → error AUTHZ_CHANNEL_DENIED (kind subscribe); chat send → AUTHZ_CHANNEL_DENIED (kind publish); chat join → refused with code not-a-member ("You are not a member of this channel"), the membership check answering before any tenant check — design E5's tenants guard is still open, so this door is closed by membership, not by tenant
console errors: 0 — the 7 "Failed to load resource: 403" lines the walk's own API probes log are the answers under test (api-status), counted apart
screenshot: hr-admin.jpg                # /select as this identity
screenshot-direct-route: hr-admin-direct-route.jpg   # where typing /social/dms lands
verdict: pass
notes: POST /api/session/login {userId:u-hr} → 200 (the call the Sign-in-as card makes), then sessionStorage['orgiq.contextChosen'] set to the sub — what the chooser's markContextChosen() does. This identity holds no social grant, so the picker offers no Social tile and the tenant switch is refused.
