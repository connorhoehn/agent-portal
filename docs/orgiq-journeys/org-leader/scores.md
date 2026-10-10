surface: scores
role: org-leader
user: u-vera (Vera Green) — POST /api/session/login then /role; GET /api/session/me: sub u-vera, tenant orgiq, role org-leader
url: /iq/scores
pages: portal/src/pages/ScoresPage.tsx,portal/src/components/scores
audited: 2026-10-06 12:40 local, headless Chromium 1680x940 (Playwright), shared dev:mock stack (BFF :3001, Vite :5183, ui-components 2.418.0)
screenshot: scores.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1432px; no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly 1 <main>, 1 H1 ("Scores"); first-row-top: 482px; clipped-text sweep: clean. The Updated tile's hint ("no scoring run yet — an HR admin can start one") is still cut at 200px of 249px, but the tile now carries the full text as its `title` (hover reads it), so it is recoverable; the sweep treats a titled string as deliberate. Leaderboard of 56 rows, otherwise fully visible.
keyboard: pass — 178 of 178 tabbable controls in <main> accept focus — walked by document-order `.focus()` asserting `document.activeElement` (headless: no physical key events; Enter/Escape sent with `page.keyboard` to the focused target); Enter on the first row/link stayed in place
empty-state: pass — "zzznoexist" in "Search skill…" (with Enter) shows "No skills match" and keeps the ranked leaderboard (56 rows) beneath it, which is the page's design ("search a skill to re-rank")
role-gating: can read the leaderboard, Cohorts and Compare; the hint says an HR admin starts a scoring run (no run control is shown to this role). Capabilities from GET /api/session/capabilities for org-leader: ManageBots, DispatchAgentRun, ManageBudgets, ManageSprints, ManageCanary, ViewObservability, ViewLeaderboard, ConnectLocalCompute true; ManageDevbox, ManageIngest, ManageKB, EditGuardrail/EditPolicy/EditSchema, ViewIdentityAdmin false
notes: The Updated hint's tail ("…can start one") is the part a person needs; it is cut visually but its tile has the full text as a title (DEFECTS #37 closed).
