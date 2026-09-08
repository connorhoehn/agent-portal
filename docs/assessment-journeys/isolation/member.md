role: member
user: u-theo
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-05 08:30 local, Chrome 1440px, gateway mode, middleware dev:mock (freshness re-sweep after a subsequent portal edit)
assessment-tile-visible: no        # /select Workspaces tab shows one tile: Org (orgiq · 1 role); body text contains no "Assessment"
assessment-nav-visible: no         # rail on /iq/projects: Plan/Design/Build/Release/Org/System, zero anchors matching /assessment
direct-route-result: redirect      # /assessment/teams → RequireTenant → /iq/projects ("Initiatives"), no flash of assessment content
api-status: 403                    # fetch /api/assessment/teams with the u-theo cookie → 403 (requireTenant('assessment'))
screenshot: member.jpg
screenshot-direct-route: member-direct-route.jpg
verdict: pass
notes: Signed in as the real user (POST /api/session/login u-theo, role member — the same call the Sign-in-as card makes); grants in /me are exactly {orgiq:[member]}. The picker header reads "in Org · Member". Nothing on the page names the other tenant.
re-verified 2026-09-05 03:58: all four facts hold — Workspaces tab shows only Org (1 tile, no "Assessment" tile); rail on /iq/projects has zero `<a href>` containing "assessment" (checked programmatically); `/assessment/teams` redirected to `/iq/projects`; `fetch('/api/assessment/teams')` returned 403.
re-verified 2026-09-05 08:30: all four facts still hold — Workspaces tab shows only Org (1 tile, no "Assessment" tile); rail on /iq/projects has 0 `<a href>` containing "assessment"; `/assessment/teams` still redirected away; `fetch('/api/assessment/teams')` returned 403. Unaffected by this session's stretch/Part-4 data changes (those touched only assessment-tenant team/feedback data).
