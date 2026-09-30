role: demo-user (cookie-less fallback identity, dev only)
user: demo-user
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-30 03:41Z → 03:42Z, Chromium 1552×958 (Playwright headless, a fresh context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183
social-grant: no                 # /api/session/me: sub demo-user, tenant orgiq, role member, grants {"orgiq":["member","sme","program-owner","org-leader","hr-admin","admin"],"assessment":["assessor","lead-assessor","program-lead","admin"]}
social-tile-visible: no          # /select Workspaces tab: tiles ['orgiq', 'assessment'] (data-testid select-roles-*)
social-nav-visible: no            # /iq/projects: 12 anchors in [data-shell-nav], 0 toward /social; ⌘K "Direct messages" lists 3 commands, 0 of them a social page
direct-route-result: redirect      # /social/channels → /iq/projects (h1 "My initiatives"); /social/dms → /iq/projects (h1 "My initiatives"); 0 social page test ids rendered
api-status: 403                   # /api/social/summary 403, /api/social/channels 403; POST /api/session/tenant {social} 403
activity-leak: none               # bell opened: "Nothing new / Activity will appear here.", 0 item links, 0 outside the tenants held
console errors: 0
screenshot: demo-user.jpg                # /select as this identity
screenshot-direct-route: demo-user-direct-route.jpg   # where typing /social/dms lands
verdict: pass
notes: no sign-in: the cookie-less fallback identity (a fresh context with no cookie). This identity holds no social grant, so the picker offers no Social tile — permissiveGrants() leaves social out of the demo identity on purpose (design §4.1).
