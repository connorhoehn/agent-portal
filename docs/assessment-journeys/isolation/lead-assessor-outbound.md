role: lead-assessor
user: u-jonas
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-05 08:38 local, Chrome 1440px, gateway mode, middleware dev:mock (freshness re-sweep)
orgiq-nav-visible: no              # rail on /assessment/teams: Dashboard, Submissions, Reports, Feedback, Enterprise, Workspace, Prompts, Rules, Activity, Settings — zero anchors matching ^/(iq|admin|newsroom); user menu offers lead-assessor (active) / assessor + "Switch workspace…" only
orgiq-route-result: redirect       # /iq/projects → RequireTenant(orgiq) → "/" → /select ("Choose a workspace"; a two-role user is sent to the picker rather than a landing page)
orgiq-api-status: 403              # /api/graph/people, /api/scores/leaderboard, /api/work/queue, /api/newsroom/articles all 403; tenant switch to orgiq/newsroom 403
screenshot: lead-assessor-outbound.jpg
verdict: pass
notes: grants in /me are {assessment:[lead-assessor, assessor]}. This is the user the report was filed against ("/assessment/teams has a bunch of nav links related to another tenant"); the rail, user menu and palette were re-checked as Jonas after the shell fixes and carry nothing from orgiq or newsroom. The header's "Mock: aurora, agentcore, guardrails, cloudwatch" line is the shared BFF's environment badge, not navigation.
re-verified 2026-09-05 04:18: rail as lead-assessor still has zero `<a href>` matching `^/(iq|admin|newsroom)`; `/iq/projects` redirected to `/select`; `fetch('/api/graph/people?limit=1')` returned 403.
re-verified 2026-09-05 08:38: rail as lead-assessor still has 0 anchors matching ^/(iq|admin|newsroom); /iq/projects redirected to /select; fetch('/api/graph/people?limit=1') returned 403.
