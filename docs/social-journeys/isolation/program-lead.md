role: program-lead
user: u-farah
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-30 03:41Z → 03:41Z, Chromium 1552×958 (Playwright headless, a fresh context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183
social-grant: yes                 # /api/session/me: sub u-farah, tenant assessment, role program-lead, grants {"assessment":["program-lead","lead-assessor"],"social":["participant"]}
social-tile-visible: yes          # /select Workspaces tab: tiles ['assessment', 'social'] (data-testid select-roles-*)
social-nav-visible: no            # /assessment/teams: 11 anchors in [data-shell-nav], 0 toward /social; ⌘K "Direct messages" lists 0 commands, 0 of them a social page
direct-route-result: redirect      # /social/channels → /assessment/teams (h1 "Assessor's desk"); /social/dms → /assessment/teams (h1 "Assessor's desk"); 0 social page test ids rendered
api-status: 403                   # /api/social/summary 403, /api/social/channels 403; POST /api/session/tenant {social} skipped (grant held)
activity-leak: none               # bell opened: "Notifications1 / Mark all read / Clear all / Unread (1) / All / Jonas Lindqvist replied to your comment /  / Assessment · Reply — On “Rubric Overview”: Thanks — the payments example is the one I had in mind. /  / 2h ago", 0 item links, 0 outside the tenants held
console errors: 0
screenshot: program-lead.jpg                # /select as this identity
screenshot-direct-route: program-lead-direct-route.jpg   # where typing /social/dms lands
verdict: pass
notes: POST /api/session/login {userId:u-farah} → 200, then POST /api/session/role {role:program-lead} → 200 (the call the Sign-in-as card makes), then sessionStorage['orgiq.contextChosen'] set to the sub — what the chooser's markContextChosen() does. This identity holds a social participant grant (design §4.1: the curated casts join social), so the Social tile shows on the picker — and the session standing in its own tenant still cannot reach /social/* or /api/social/*: the gate is the session's tenant, not the grant list.
