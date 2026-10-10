surface: scores
role: hr-admin
user: u-rachel (Rachel Kowalski) — POST /api/session/login then /role; GET /api/session/me: sub u-rachel, tenant orgiq, role hr-admin
url: /iq/scores
pages: portal/src/pages/ScoresPage.tsx,portal/src/components/scores
audited: 2026-10-06 12:40 local, headless Chromium 1680x940 (Playwright), shared dev:mock stack (BFF :3001, Vite :5183, ui-components 2.418.0)
screenshot: scores.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1432px; no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly 1 <main>, 1 H1 ("Scores"); first-row-top: 482px; clipped-text sweep: clean. five-tile strip (People scored 56, Avg composite 63, Top score 91, Departments 6, Updated "run the scoring agent"); nothing cut
keyboard: pass — 178 of 178 tabbable controls in <main> accept focus — walked by document-order `.focus()` asserting `document.activeElement` (headless: no physical key events; Enter/Escape sent with `page.keyboard` to the focused target); Enter on the first row/link stayed in place
empty-state: pass — "zzznoexist" in "Search skill…" (with Enter) shows "No skills match" and keeps the ranked leaderboard beneath it, as designed
role-gating: can read the leaderboard; the Updated tile says "run the scoring agent". Capabilities from GET /api/session/capabilities for hr-admin: ManageDevbox, ManageIngest, ManageKB, ManageUsers, ViewIdentityAdmin, EditGuardrail/EditPolicy/EditSchema, ManageBots, DispatchAgentRun, ManageBudgets, ManageCanary, ViewObservability true; ManageSprints, ApproveTransaction, EnterEnvironment false
notes: Same page as org-leader; the hint reads "run the scoring agent" for this role and fits.
