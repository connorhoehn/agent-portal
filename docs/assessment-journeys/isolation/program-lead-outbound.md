role: program-lead
user: u-farah
audited: 2026-10-24 14:10–14:10 local, headless Chromium 1680x940 (Playwright), Tilt stack: Vite :5183 over middleware :3001 (dev:mock); mock state not reset (shared stack); a fresh signed-in clone of u-farah (u-farah-clone-3c7f8961)
session: sub u-farah-clone-3c7f8961, tenant assessment, role program-lead, grants {"assessment":["program-lead","lead-assessor"],"social":["participant"]}
orgiq-nav-visible: no              # rail on /assessment/teams: 20 anchors (/assessment/teams, /assessment/submissions, /assessment/communication, /assessment/reports, /assessment/feedback, /assessment/activity, /assessment/enterprise, /assessment/workspace, /assessment/prompts, /assessment/rules, /assessment/runs, /assessment/configuration, /settings, /assessment/teams/TEAM-005, /assessment/teams/TEAM-006, /assessment/teams/TEAM-007, /assessment/teams/TEAM-003, /assessment/teams/TEAM-004, /assessment/teams/TEAM-001, /assessment/teams/TEAM-002), 0 toward /iq or /admin
orgiq-route-result: redirect       # /iq/projects → /assessment/teams (h1 "Assessor's desk"); /iq/scores → /assessment/teams (h1 "Assessor's desk"); /admin/observability → /assessment/teams (h1 "Assessor's desk"); /iq/search → /assessment/teams (h1 "Assessor's desk"); /iq/runs → /assessment/teams (h1 "Assessor's desk"); /pipelines/runs → /assessment/teams (h1 "Assessor's desk")
orgiq-api-status: 403                # /api/graph/people?limit=1 403, /api/scores/leaderboard 403, /api/work/queue 403, /api/work/summary 403, /api/bots 403, /api/pipelines/runs 403; POST /api/session/tenant orgiq 403 / pipelines 403 (session after: u-farah-clone-3c7f8961/assessment/program-lead)
screenshot: program-lead-outbound.jpg
verdict: pass — walked 2026-10-24; 0 page errors
notes: Signed in as a clone (POST /api/__mock/identity/clone from u-farah, then POST /api/session/login), so the real persona's session epoch was not touched. The screenshot is what typing /iq/projects gets you.
