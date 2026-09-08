surface: reports
role: lead-assessor
user: u-jonas
url: /assessment/reports
pages: portal/src/pages/assessment/ReportsPage.tsx
audited: 2026-09-05 08:14 local, Chrome 1440px, gateway mode (VITE_GATEWAY_URL=http://localhost:18080), middleware dev:mock
screenshot: reports.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1272px; scrollWidth 1472 = innerWidth 1472 (no horizontal scroll); body scrollHeight 845 = innerHeight 845
keyboard: pass — 24 interactive elements; "Teams" table team-name cells resolve to a real button element at elementFromPoint, Tab-reachable.
empty-state: n/a — every cohort and team in this role's fixture data has at least one row with data; did not exhaust the rollup to a zero-data state.
role-gating: lead-assessor sees the rollup stats, "By cohort" table, "Where to start" ranked list, "Teams" table, PLUS a "Publish report" button (top right) that assessor's copy of this page does not have anywhere in its DOM (per assessor/reports.md). Confirmed functional, not decorative: clicked it and got a "Report published" toast, a genuine server action.
notes: Rollup numbers (7 teams, 55/117 dimensions assessed, 41 at/above L3, 28 open claims) are internally consistent with the dashboard's per-team totals. "Where to start" entries (Close the claim / Advance the practice / Answer the question) are unchanged by publishing; publish is a snapshot action, not a workflow-state mutation on the underlying claims.
re-verified 2026-09-05 03:46: console 0, layout content col left 200px w 1272px / scrollWidth 1472 = innerWidth 1472 / body scrollHeight 845 = innerHeight 845 (unchanged), screenshot retaken (rollup numbers unchanged: 7 teams, 55/117, 41 at/above L3, 28 open claims); spot-checked role-gating — "Publish report" still present (24 interactive elements).
re-verified 2026-09-05 08:14 (gateway mode, freshness re-sweep): console 0, layout unchanged; 24 interactive controls; "Publish report" still functional. Rollup reads 100/117 (stable vs admin's reading in this same session) — consistent across roles.
