role: sme
user: u-nora
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-05 08:31 local, Chrome 1440px, gateway mode, middleware dev:mock (freshness re-sweep)
assessment-tile-visible: no        # /select Workspaces tab: one tile, Org (orgiq · 1 role, "SME — Dispatch agent runs against a sprint envelope"); no "Assessment" anywhere in the body text
assessment-nav-visible: no         # rail on /iq/projects: Initiatives, Library, Promotions, Designs, Automate, Distillation, Computer Lab, Session config, Ask, Explore, Settings — zero anchors matching /assessment
direct-route-result: redirect      # /assessment/teams → RequireTenant → /iq/projects ("Initiatives")
api-status: 403                    # fetch /api/assessment/teams with the u-nora cookie → 403
screenshot: sme.jpg
verdict: pass
notes: This is the case the user reported ("a sme shouldn't see the assessment pages"). Root cause was the cookie-less Demo User wearing SME while keeping every tenant's grants; a real SME (u-nora, grants exactly {orgiq:[sme]}) never held an assessment grant. Demo User now narrows to the chosen role too (demoScopedGrants) and the picker's two-step switch is validated against the persona's full set (switchableGrants), so both paths land here.
re-verified 2026-09-05 04:00: all four facts hold — Workspaces tab shows only Org (1 tile, no "Assessment" tile); rail on /iq/projects has zero `<a href>` containing "assessment"; `/assessment/teams` redirected to `/iq/projects`; `fetch('/api/assessment/teams')` returned 403.
re-verified 2026-09-05 08:31: all four facts still hold — Workspaces tab shows only Org (1 tile); rail on /iq/projects has 0 assessment anchors; /assessment/teams redirected away; fetch('/api/assessment/teams') returned 403.
