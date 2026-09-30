role: sme
user: u-nora
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-30 03:38Z → 03:38Z, Chromium 1552×958 (Playwright headless, a fresh context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183
social-grant: yes                 # /api/session/me: sub u-nora, tenant orgiq, role sme, grants {"orgiq":["sme"],"social":["participant"]}
social-tile-visible: yes          # /select Workspaces tab: tiles ['orgiq', 'social'] (data-testid select-roles-*)
social-nav-visible: no            # /iq/projects: 15 anchors in [data-shell-nav], 0 toward /social; ⌘K "Direct messages" lists 3 commands, 0 of them a social page
direct-route-result: redirect      # /social/channels → /iq/projects (h1 "My initiatives"); /social/dms → /iq/projects (h1 "My initiatives"); 0 social page test ids rendered
api-status: 403                   # /api/social/summary 403, /api/social/channels 403; POST /api/session/tenant {social} skipped (grant held)
activity-leak: none               # bell opened: "Nothing new / Activity will appear here.", 0 item links, 0 outside the tenants held
console errors: 0
screenshot: sme.jpg                # /select as this identity
screenshot-direct-route: sme-direct-route.jpg   # where typing /social/dms lands
verdict: pass
notes: POST /api/session/login {userId:u-nora} → 200 (the call the Sign-in-as card makes), then sessionStorage['orgiq.contextChosen'] set to the sub — what the chooser's markContextChosen() does. This identity holds a social participant grant (design §4.1: the curated casts join social), so the Social tile shows on the picker — and the session standing in its own tenant still cannot reach /social/* or /api/social/*: the gate is the session's tenant, not the grant list.
