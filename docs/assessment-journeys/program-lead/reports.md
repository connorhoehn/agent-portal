surface: reports
role: program-lead
user: u-farah
url: /assessment/reports
pages: portal/src/pages/assessment/ReportsPage.tsx
audited: 2026-09-05 07:35 local, Chrome 1440px, gateway mode (VITE_GATEWAY_URL=http://localhost:18080), middleware dev:mock
screenshot: reports.jpg
verdict: pass
console errors: 0
layout: pass — main left 200px w 1272px; scrollWidth 1472 = innerWidth 1472 (no horizontal scroll); document body does not scroll (scrollHeight 845 = innerHeight 845); content renders in the same fixed-body/inner-scroll-pane shell as feedback (confirmed the page has more rows below the fold — a Teams table — reachable by scrolling the content pane, not the document).
keyboard: pass — 25 visible interactive controls; Tab-traversal reaches every row including the Teams table's team-name links further down the page (confirmed the inner pane scrolls to follow focus).
empty-state: n/a for this pass — the fixture has 7 teams with real rollup data; no zero-team empty state exists to check.
role-gating: program-lead sees "Publish report" (top right) — confirmed functional with a real write: clicking it produced a "Report published" toast with no error. This is the PublishReport capability the task description calls out as program-lead-exclusive.
notes: Portfolio rollup shows 7 teams / 55 of 117 dimensions assessed / 41 at-or-above L3 / 28 claims open across 3 cohort rows (white glove, self service, general) with matching per-cohort assessed/verified counts. "Where to start" lists each team's top-ranked next action (Close the claim / Advance the practice / Answer the question) with a per-kind count breakdown, and a "Teams" table below it lists all 7 teams with cohort, verified level, open claims, and open follow-ups — Northstar Payments (L4, 6 open claims, 9 follow-ups) down to Fraud Detection ML / Internal Tools (both "Not yet", 0/0). Numbers are internally consistent with dashboard.md and team-scorecard.md for the same teams.
re-verified 2026-09-05 07:35 (gateway mode): console 0, layout main left 200px w 1240px / scrollWidth 1440 = innerWidth 1440 / body scrollHeight 758 = innerHeight 758 (no scroll), screenshot retaken; 25 interactive controls counted (unchanged); spot-checked keyboard — "Publish report" still a real reachable button. Rollup now reads 72/117 dimensions assessed (was 55/117) — the +17 is exactly TEAM-007's new scores from stretch/agent-e2e.md Part 2; "41 at or above L3" and "28 claims open" are unchanged since all 17 new TEAM-007 scores are L0-L2 and produced follow-ups, not claims. Numbers internally consistent with dashboard.md and team-scorecard.md.
