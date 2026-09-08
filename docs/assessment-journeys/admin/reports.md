surface: reports
role: admin
user: u-operator
url: /assessment/reports
pages: portal/src/pages/assessment/ReportsPage.tsx
audited: 2026-09-05 07:48 local, Chrome 1440px, gateway mode (VITE_GATEWAY_URL=http://localhost:18080), middleware dev:mock
screenshot: reports.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1272px; scrollWidth 1472 = innerWidth 1472 (no horizontal scroll); body scrollHeight 845 = innerHeight 845
keyboard: pass — 25 interactive elements above the fold; "Teams" table's team-name cells are real `<button>`s (the already-fixed defect from the assessor pass — no `<tr onClick>` regression), Tab/Enter navigates in-app to the scorecard with no full reload.
empty-state: n/a — full rollup data present (7 teams, 55/117 dimensions assessed, 41 at or above L3, 28 open claims)
role-gating: admin sees "Publish report" (top right), same as lead-assessor/program-lead — a role that may act on reports. Rollup (Teams/Dimensions Assessed/At or Above L3/Claims Open), "By cohort" table, and "Where to start" ranked list all render identically to the other roles.
notes: Clicked "Publish report" — toast "Report published" fired immediately, no errors. Confirmed the "Teams" table's Northstar Payments row navigates to `/assessment/teams/TEAM-001` on click (real in-app `<button>`, not a dead `<tr onClick>`); browser Back returned cleanly to Reports. "Where to start" list is ranked server-side, not re-orderable client-side, matching the page's own stated design ("never re-ordered here").
re-verified 2026-09-05 07:48 (gateway mode): console 0, layout main left 200px w 1240px / scrollWidth 1440 = innerWidth 1440 / body scrollHeight 758 = innerHeight 758 (no scroll), screenshot retaken; 25 interactive controls (unchanged); spot-checked keyboard — "Publish report" still a real reachable button. Rollup now reads 100/117 dimensions assessed (was lower at original audit) — growth is TEAM-007's 17 (stretch/agent-e2e.md Part 2) plus TEAM-005/006's new scores from this Part 4 sweep's submissions-wizard re-run; internally consistent with dashboard.md and feedback.md's counts for the same teams.
