role: assessor
user: u-asha
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-05 08:37 local, Chrome 1440px, gateway mode, middleware dev:mock (freshness re-sweep)
orgiq-nav-visible: no              # rail on /assessment/teams: Dashboard, Submissions, Reports, Feedback, Enterprise, Workspace, Prompts, Rules, Activity, Settings — zero anchors matching ^/(iq|admin|newsroom); user menu lists only "Role in Assessment"; ⌘K palette lists the 10 assessment pages only
orgiq-route-result: redirect       # /iq/projects → RequireTenant(orgiq) → "/" → /assessment/teams; /admin/observability → same. BEFORE this audit's fix the /iq tree was unguarded and rendered the assessment shell around an orgiq page showing "Failed to load initiatives — 403 Forbidden"
orgiq-api-status: 403              # /api/graph/people → 403, /api/scores/leaderboard → 403, /api/work/queue → 403, /api/newsroom/articles → 403; POST /api/session/tenant {orgiq} → 403, {newsroom} → 403
newsroom-route-result: redirect    # /newsroom/articles → /assessment/teams
screenshot: assessor-outbound.jpg  # taken on landing after the /admin/observability attempt — the redirect target
verdict: pass
notes: grants in /me are exactly {assessment:[assessor]}. Fix applied during this audit: portal/src/App.tsx wraps the /iq and /admin trees in RequireTenant tenant="orgiq" (admin role still passes), and the validator now requires all three product trees to be guarded.
re-verified 2026-09-05 04:15: rail on /assessment/teams still has zero `<a href>` matching `^/(iq|admin|newsroom)`; `/iq/projects` redirected to `/assessment/teams`; `fetch('/api/graph/people?limit=1')` returned 403.
re-verified 2026-09-05 08:37: rail as assessor still has 0 anchors matching ^/(iq|admin|newsroom); /iq/projects redirected to /assessment/teams; fetch('/api/graph/people?limit=1') returned 403.
