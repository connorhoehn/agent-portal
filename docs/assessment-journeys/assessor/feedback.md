surface: feedback
role: assessor
user: u-asha
url: /assessment/feedback
pages: portal/src/pages/assessment/FeedbackPage.tsx
audited: 2026-09-05 08:20 local, Chrome 1440px, gateway mode (VITE_GATEWAY_URL=http://localhost:18080), middleware dev:mock
screenshot: feedback.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1272px; scrollWidth 1472 = innerWidth 1472 (no horizontal scroll); the document/body never scrolls (`document.scrollingElement.scrollHeight` stays 845 = innerHeight), the question list scrolls inside its own inner container (`div.flex-1.min-h-0.overflow-auto`, scrollHeight 4607 vs clientHeight 688) while the "Needs Feedback" header and status filter stay put — confirmed by scrolling and reading `scrollTop`.
keyboard: pass — 87 interactive controls (each of the 23 open questions renders a "Record answer" + "Dismiss" button plus an "Add the evidence →" link); the status `<select>` is a native combobox, correctly reachable and settable (verified via a real option-select, not just DOM value assignment).
empty-state: n/a — no team in this role's fixture data has zero feedback questions to show a true empty state; selecting "Answered" narrows correctly to the 1 real answered item on file (Checkout Experience / TEAM-003) with its recorded text and "2d ago" timestamp.
role-gating: assessor can Record answer, Dismiss, and use "Add the evidence →" on every open question; nothing on this surface is hidden for the role.
notes: Filed a real answer ("Audit test answer: shared pipeline dashboard link.") against Kubernetes Operator's Continuous Integration question and dismissed its next one — both actions updated the "N open across N teams" counter live, removed the item from the Open list, showed a toast ("Answer recorded" / "Dismissed"), and the answered item then appeared correctly under the "Answered" filter with its recorded text. Switching the status filter with a real user-style option-select (not a raw DOM `.value =` assignment, which gave a misleading transient reading during testing) behaves correctly in both directions. Groups are per-team as specified by the protocol, in fixture order (Kubernetes Operator, then Checkout Experience, etc.).
re-verified 2026-09-05 03:22: console 0, layout content col left 200px w 1272px / scrollWidth 1472 = innerWidth 1472 / body scrollHeight 845 = innerHeight 845 (unchanged), screenshot retaken (queue now 21 open across 2 teams, down from 23 — reflects the admin pass's Record-answer/Dismiss writes earlier in this session, not a regression); spot-checked keyboard — 48 native buttons + 1 native status `<select>` present.
re-verified 2026-09-05 08:20 (gateway mode, freshness re-sweep): console 0, layout unchanged; 299 interactive controls (queue grew substantially from this session's Part 1/2/4 stretch tests across TEAM-005/006/007). Same duplicate-question pattern already filed in lead-assessor/DEFECTS.md — TEAM-005 shows 3 near-identical "Testing & QE – Security Testing" cards from 3 repeated submission-processing runs this session, not a page regression. Record/Dismiss buttons still real, reachable controls.
