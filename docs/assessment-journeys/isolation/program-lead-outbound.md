role: program-lead
user: u-farah
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-05 08:39 local, Chrome 1440px, gateway mode, middleware dev:mock (freshness re-sweep)
orgiq-nav-visible: no              # rail on /assessment/teams adds Configuration under System for this role (11 entries); zero anchors matching ^/(iq|admin|newsroom)
orgiq-route-result: redirect       # /iq/projects → RequireTenant(orgiq) → "/" → /select ("Choose a workspace")
orgiq-api-status: 403              # /api/graph/people, /api/scores/leaderboard, /api/work/queue, /api/newsroom/articles all 403; tenant switch to orgiq/newsroom 403
newsroom-route-result: redirect    # /newsroom/articles → /select
screenshot: program-lead-outbound.jpg
verdict: pass
notes: grants in /me are {assessment:[program-lead, lead-assessor]}. A first load of /assessment/teams during this audit showed "Couldn't load teams" while the middleware was restarting under a concurrent edit; reloaded a minute later the teams API is 200 and the page renders (screenshot). program-lead holds ManageUsers in this tenant; the grants write path is being scoped to the caller's tenant in the middleware fix pass so that capability cannot mint a cross-tenant grant.
re-verified 2026-09-05 04:21: rail as program-lead still has zero `<a href>` matching `^/(iq|admin|newsroom)`; `/iq/projects` redirected to `/select`; `fetch('/api/graph/people?limit=1')` returned 403.
re-verified 2026-09-05 08:39: rail as program-lead still has 0 anchors matching ^/(iq|admin|newsroom); /iq/projects redirected to /select; fetch('/api/graph/people?limit=1') returned 403.
