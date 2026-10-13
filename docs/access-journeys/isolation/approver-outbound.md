role: approver
user: u-omar (Omar Haddad)
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx
audited: 2026-10-13 16:41–16:42 local — headless Chromium as this identity (Playwright from portal/node_modules, a fresh context signed in by POST /api/session/login, not the shared Chrome tab), 1680x940, middleware dev:mock on :3001, Vite :5183, ui-components 2.442.4
identity: /api/session/me sub u-omar, tenant access, role approver, grants {"access":["approver"]}, availableTenants ["access"]
other-nav-visible: no         # /select: "Workspaces 1" (Access only), 0 anchors toward /iq, /admin, /assessment, /social, /pipelines; rail on /access/requests: 7 anchors, 0 foreign (all anchors on the page: 8, 0 foreign); tenant switcher menu: "No other tenants are available for your account."; ⌘K: 'Initiatives' 3 rows, 'Assessment' 5, 'Channels' 4, 'Pipelines' 5, 'Teams' 5, 'Runs' 10 — 0 rows outside the Access vocabulary (requests, approvals, catalog, audit, policies, reviews, settings)
iq-route-result: redirect     # watched in the browser: /iq/projects, /iq/runs, /admin/identity/users → /access/requests (h1 "Requests"), 0 foreign anchors
iq-api-status: 403            # /api/graph/people?limit=1 403, /api/graph/teams 403, /api/bots 403, /api/work/summary 403; POST /api/session/tenant {orgiq} 403; /api/identity/users 403
assessment-route-result: redirect  # /assessment/teams → /access/requests (h1 "Requests")
assessment-api-status: 403    # /api/assessment/summary 403, /api/assessment/teams 403; POST /api/session/tenant {assessment} 403
social-route-result: redirect # /social/channels, /social/dms → /access/requests (h1 "Requests")
social-api-status: 403        # /api/social/summary 403, /api/social/channels 403; POST /api/session/tenant {social} 403
pipelines-route-result: redirect  # /pipelines/runs, /pipelines/configuration → /access/requests (h1 "Requests")
pipelines-api-status: 403     # /api/pipelines/summary 403, /api/pipelines/runs 403; POST /api/session/tenant {pipelines} 403
console errors: 0
screenshot: approver-outbound.jpg         # retaken 2026-10-13 16:41–16:42 by headless Chromium as u-omar: /select showing the Access workspace only; approver-outbound-direct-route.jpg is /access/requests where the last foreign route (/pipelines/configuration) redirected
verdict: pass
notes: Every field above was observed in this pass, rendered rail, switcher, palette and redirects included (the previous pass inferred them from curl). The session after every refused tenant switch is still u-omar/access/approver (a refused switch answers 403 before the epoch bump).
