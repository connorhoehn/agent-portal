surface: promotions
role: member
user: u-theo
url: /iq/promotions
pages: portal/src/pages/promotions
audited: 2026-09-05 20:59 local, Chrome 1552px, middleware dev:mock
screenshot: promotions.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; first-row-top: 286px (4 rows); a one-paragraph description and one Status filter row above the table; no horizontal scroll (scrollWidth 1552 = innerWidth)
keyboard: pass — 27 controls, none with tabIndex -1; each candidate row's name cell is a real `<button>` — Tab from the last Status pill ("Dismissed") landed on "Retry the Data API through an Aurora cold start", Return opened its drawer (role=dialog, focus moved inside), Escape closed it and returned focus to the same row button; the Status pills are `<button aria-pressed>`
empty-state: pass — "Dismissed" (a status no seeded candidate has) shows "Nothing here / Nothing dismissed right now." with the pill pressed; "Candidates" narrows to 3, "Promoted" to the one promoted skill ("Pin Fargate tasks to ARM64…"), "All" restores 4 — no server round trip per click (one `GET /api/promotions`, filtered client-side)
role-gating: member can browse candidates and open a drawer with the contributing observations and the NEXT STEP panel; the drawer renders no Approve / "Approve + record a passing dry run" / Dismiss button at all for member (zero `<button>`s inside the dialog) and says outright "Promoting or dismissing a candidate needs Manage bots." under the next-step line — the explained-gate pattern, matching Session config
notes: DEFECTS #1 (Promotions instance), #2 (Promotions instance) and #3 re-observed fixed. One correction to my own method, recorded so nobody chases it: two early pointer clicks on "Promoted" / "Dismissed" appeared to do nothing, but that was the browser extension's input detaching after a navigation (the protocol's "screenshot after each navigate" rule) — `document.elementFromPoint` confirmed the pills were under the cursor, a screenshot re-attached input, and every click after that (pointer and native `.click()` alike, on every pill) filtered correctly. Not a page defect.
