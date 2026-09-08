role: hr-admin
user: u-hr
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-05 08:34 local, Chrome 1440px, gateway mode, middleware dev:mock (freshness re-sweep)
assessment-tile-visible: no        # /select Workspaces tab: one tile, Org (orgiq · 1 role: HR Admin); no "Assessment" in the body text
assessment-nav-visible: no         # rail on /iq/projects (19 entries incl. Codebases, Identity): zero anchors matching /assessment
direct-route-result: redirect      # /assessment/teams → RequireTenant → /iq/projects ("Initiatives")
api-status: 403                    # fetch /api/assessment/teams → 403; POST /api/session/tenant {assessment} → 403
screenshot: hr-admin.jpg
verdict: pass
notes: grants in /me are {orgiq:[hr-admin]}. hr-admin holds ManageUsers in orgiq, and Identity → Users is on its rail; that surface manages orgiq users and cannot mint an assessment grant for itself (the grants write path is being tenant-scoped in the middleware fix pass).
re-verified 2026-09-05 04:08: all four facts hold — Workspaces tab shows only Org (1 tile, 1 role: HR Admin; no "Assessment" tile); rail on /iq/projects has zero `<a href>` containing "assessment"; `/assessment/teams` redirected to `/iq/projects`; `fetch('/api/assessment/teams')` returned 403.
re-verified 2026-09-05 08:34: all four facts still hold — Workspaces tab shows only Org (1 tile); rail on /iq/projects has 0 assessment anchors; /assessment/teams redirected to /iq/projects; fetch('/api/assessment/teams') returned 403.
