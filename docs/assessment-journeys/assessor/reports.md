surface: reports
role: assessor
user: u-asha
url: /assessment/reports
pages: portal/src/pages/assessment/ReportsPage.tsx
audited: 2026-09-05 08:21 local, Chrome 1440px, gateway mode (VITE_GATEWAY_URL=http://localhost:18080), middleware dev:mock
screenshot: reports.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1272px; scrollWidth 1472 = innerWidth 1472 (no horizontal scroll); body scrollHeight 845 = innerHeight 845
keyboard: pass (was fail) — the "Teams" table's team-name cell now resolves to a real `<button>` at elementFromPoint (TD > BUTTON, not a bare tr), so Tab reaches every row. Clicking it navigates in-app to that team's scorecard (URL changes to `/assessment/teams/TEAM-001`, page content swaps without a full reload, no new console errors) rather than a full page reload.
empty-state: n/a — every cohort and team in this role's fixture data has at least a "Not yet" row.
role-gating: assessor sees the rollup stats, "By cohort" table, "Where to start" ranked list, and "Teams" table; no "Publish" control anywhere in the DOM (confirmed via a text search) — publishing is correctly restricted to a role that isn't assessor.
notes: The rollup numbers (7 teams, 55/117 dimensions assessed, 41 at/above L3, 28 open claims) are unchanged from the first pass and still consistent with the dashboard's per-team numbers. "Where to start" entries and their recommended actions ("Close the claim" / "Advance the practice" / "Answer the question") are unchanged and correct.
re-verified 2026-09-05 03:25: console 0, layout content col left 200px w 1272px / scrollWidth 1472 = innerWidth 1472 / body scrollHeight 845 = innerHeight 845 (unchanged), screenshot retaken; spot-checked role-gating — `document.body.innerText` still contains no "Publish" anywhere, 23 interactive elements.
re-verified 2026-09-05 08:21 (gateway mode, freshness re-sweep): console 0, layout unchanged; 23 interactive controls (no "Publish report" for assessor, confirmed absent). Rollup reads 100/117 — stable and consistent with lead-assessor/admin's readings in this same session.
