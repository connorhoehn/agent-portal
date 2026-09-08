role: org-leader
user: u-vera
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-05 08:33 local, Chrome 1440px, gateway mode, middleware dev:mock (freshness re-sweep)
assessment-tile-visible: no        # /select Workspaces tab: one tile, Org (orgiq · 2 roles: Member, Org Leader); no "Assessment" in the body text
assessment-nav-visible: no         # rail on /iq/projects (17 entries incl. Budgets, Knowledge, Health, Architecture, Capabilities, Scores): zero anchors matching /assessment
direct-route-result: redirect      # /assessment/teams → RequireTenant → "/" → /select ("Choose a workspace")
api-status: 403                    # fetch /api/assessment/teams → 403; POST /api/session/tenant {assessment} → 403
screenshot: org-leader.jpg
verdict: pass
notes: grants in /me are {orgiq:[org-leader, member]}. The release-manager role is the most privileged orgiq role that is still tenant-bound; nothing in the wider rail opens toward the assessment product.
re-verified 2026-09-05 04:05: all four facts hold — Workspaces tab shows only Org (1 tile, 2 roles: Member, Org Leader; no "Assessment" tile); rail as org-leader has zero `<a href>` containing "assessment"; `/assessment/teams` redirected to `/select`; `fetch('/api/assessment/teams')` returned 403.
re-verified 2026-09-05 08:33: all four facts still hold — Workspaces tab shows only Org (2 roles); as org-leader, rail has 0 assessment anchors; /assessment/teams redirected away (landed on /select); fetch('/api/assessment/teams') returned 403.
