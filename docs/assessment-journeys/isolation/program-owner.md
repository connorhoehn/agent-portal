role: program-owner
user: u-mia
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-05 08:32 local, Chrome 1440px, gateway mode, middleware dev:mock (freshness re-sweep)
assessment-tile-visible: no        # /select Workspaces tab: one tile, Org (orgiq · 2 roles: Member, Program Owner); no "Assessment" in the body text
assessment-nav-visible: no         # rail on /iq/projects: Initiatives, Budgets, Library, Promotions, Designs, Automate, Distillation, Computer Lab, Session config, Ask, Explore, Settings — zero anchors matching /assessment
direct-route-result: redirect      # /assessment/teams → RequireTenant → "/" → /select ("Choose a workspace"); the home route sends a multi-role user to the picker rather than a landing page
api-status: 403                    # fetch /api/assessment/teams → 403; POST /api/session/tenant {assessment} → 403 (no grant in that tenant)
screenshot: program-owner.jpg
verdict: pass
notes: grants in /me are {orgiq:[program-owner, member]}. The tenant switch is refused server-side as well as hidden client-side, so the tile could not be reached even by crafting the request.
re-verified 2026-09-05 04:02: all four facts hold — Workspaces tab shows only Org (1 tile, 2 roles: Member, Program Owner; no "Assessment" tile); rail on `/iq/work` (as program-owner) has zero `<a href>` containing "assessment"; `/assessment/teams` redirected to `/select`; `fetch('/api/assessment/teams')` returned 403.
re-verified 2026-09-05 08:32: all four facts still hold — Workspaces tab shows only Org (2 roles, no Assessment tile); as program-owner, rail has 0 assessment anchors; /assessment/teams redirected away (landed on /iq/work, the role's default); fetch('/api/assessment/teams') returned 403.
