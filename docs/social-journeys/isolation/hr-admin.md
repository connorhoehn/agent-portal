role: hr-admin
user: u-hr
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-30 07:10Z, Chromium 1552×958 (Playwright headless from portal/node_modules, a fresh context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183 — re-walked in lane E (E5 tenants guard in the gateway, the /api/social/bindings + grant-gated POST /api/social/dms routes, /iq/runs and /pipelines/configuration routes in App.tsx and the rail/palette rows in Layout.tsx/portalCommands.ts)
social-grant: no                 # /api/session/me: sub u-hr, tenant orgiq, role hr-admin, grants {"orgiq":["hr-admin"]}
social-tile-visible: no          # /select Workspaces tab: tiles ["orgiq"] (data-testid select-roles-*)
social-nav-visible: no            # /iq/projects: 36 anchors in [data-shell-nav], 0 toward /social; ⌘K "Direct messages" lists 13 commands, 0 of them a social page; ⌘K "Runbooks" lists 11 commands, 0 of them a social page; ⌘K "Rubric" lists 32 commands, 0 of them a social page
direct-route-result: redirect      # /social/channels → /iq/projects (h1 "All initiatives"); /social/rooms → /iq/projects (h1 "All initiatives"); /social/dms → /iq/projects (h1 "All initiatives"); 0 social page test ids rendered
api-status: 403                   # /api/social/summary 403, /api/social/channels 403, /api/social/rooms 403, /api/social/teams 403, /api/social/recordings 403, /api/social/calls 403; POST /api/session/tenant {social} 403
activity-leak: none               # bell opened: "Nothing new Activity will appear here.", 0 item links, 0 outside the tenants held
forged-subscribe: AUTHZ_CHANNEL_DENIED   # 2026-09-30 07:10Z, u-hr (tenant orgiq, grants {"orgiq":["hr-admin"]}, none in social): GET /api/session/realtime-token 200, a raw socket on ws://localhost:3001/ws, then hand-built frames — presence subscribe social:ch:general → AUTHZ_CHANNEL_DENIED (kind subscribe); chat join social:ch:general → not-a-member; chat send social:ch:general → AUTHZ_CHANNEL_DENIED (kind publish). Since lane E the gateway admits a partition only from the token's tenants (E5): with no social grant the router refuses the subscribe and the publish outright; a chat join is still answered by the chat service's own membership gate (not-a-member) before any history is sent
console errors: 0 — the walk's API probes go through the context's request client, so their 403s never reach the page console
screenshot: hr-admin.jpg                # /select as this identity
screenshot-direct-route: hr-admin-direct-route.jpg   # where the last typed social URL leaves you
verdict: pass
notes: POST /api/session/login {userId:u-hr} → 200 (the call the Sign-in-as card makes), then sessionStorage['orgiq.contextChosen'] set to the sub — what the chooser's markContextChosen() does. This identity holds no social grant, so the picker offers no Social tile, the tenant switch is refused, and /api/social/bindings?context=initiative%3Ap-auth-migration 403 answers 403 too (no grant in social).
