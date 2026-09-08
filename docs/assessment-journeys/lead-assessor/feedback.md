surface: feedback
role: lead-assessor
user: u-jonas
url: /assessment/feedback
pages: portal/src/pages/assessment/FeedbackPage.tsx
audited: 2026-09-05 08:12 local, Chrome 1440px, gateway mode (VITE_GATEWAY_URL=http://localhost:18080), middleware dev:mock
screenshot: feedback.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1272px; scrollWidth 1472 = innerWidth 1472 (no horizontal scroll); body scrollHeight 845 = innerHeight 845
keyboard: pass — 86 interactive elements (queue starts at 25 open questions across 2 teams, each row rendering Record answer + Dismiss); status select ("Open" / "Answered" / "Dismissed" / "All statuses") is a native `<select>`, reachable by Tab.
empty-state: n/a — 25 open questions across 2 teams exist in this role's fixture data; did not exhaust the queue to see a zero-questions state.
role-gating: lead-assessor holds the same feedback authority as assessor — Record answer and Dismiss are both present and functional; nothing on this page is gated further for lead-assessor.
notes: Both actions are real, not decorative. "Record answer" expands a textarea (button stays disabled until text is entered); typed "Verified via CI dashboard export, attached in evidence." on the Kubernetes Operator / Continuous Integration (CI) question and submitted — the question disappeared from the list, the team's count dropped from "15 questions" to "14", and the page total dropped from "25 open across 2 teams" to "24". "Dismiss" on the next question worked the same way with a "Dismissed" toast, dropping the total to "23 open across 2 teams" / "13 questions" for Kubernetes Operator. Both are genuine server writes (counts persisted through the click, not a client-only optimistic revert).
re-verified 2026-09-05 03:42: console 0, layout content col left 200px w 1272px / scrollWidth 1472 = innerWidth 1472 / body scrollHeight 845 = innerHeight 845 (unchanged), screenshot retaken (queue now 21 open across 2 teams, reflecting this session's admin-pass writes, not a regression); spot-checked keyboard — 80 interactive controls, Record answer/Dismiss buttons and the status `<select>` all still native.
re-verified 2026-09-05 08:12 (gateway mode, freshness re-sweep): console 0, layout main left 200px w 1240px / scrollWidth 1440 = innerWidth 1440 / body scrollHeight 758 = innerHeight 758 (no scroll), screenshot retaken; 299 interactive controls (queue grew from this session's many stretch/Part-4 scoring runs across TEAM-005/006/007). New observation: TEAM-005's queue shows THREE near-identical "No evidence has been submitted for Testing & QE – Security Testing" cards, all "11m ago" — consistent with the submissions-wizard being re-processed 3 times for the same TEAM-005 submission across this session's program-lead/admin/assessor Part 4 passes, each run appending new follow-up questions per dimension rather than deduping against an already-open question for the same dimension. Recording as a real defect worth filing (repeated processing of the same submission is not idempotent for feedback questions), not a page regression from this pass.
