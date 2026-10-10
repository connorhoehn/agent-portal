surface: designs
role: org-leader
user: u-vera (Vera Green) — POST /api/session/login then /role; GET /api/session/me: sub u-vera, tenant orgiq, role org-leader
url: /iq/designs
pages: portal/src/pages/designs
audited: 2026-10-06 11:50 local, headless Chromium 1680x940 (Playwright), shared dev:mock stack (BFF :3001, Vite :5183, ui-components 2.413.0)
screenshot: designs.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1480px; no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly 1 <main>, 1 H1 ("Designs"); first-row-top: 247px; clipped-text sweep: clean. H1 "Designs", one description, status rail (All designs, Needs input, Awaiting sign-off, Ideating, Approved) and a three-row table (Session token rotation…, RED dashboards…, ADR: tail-sampling policy…)
keyboard: pass — 12 of 12 tabbable controls in <main> accept focus — walked by document-order `.focus()` asserting `document.activeElement` (headless: no physical key events; Enter/Escape sent with `page.keyboard` to the focused target); Enter on the first row/link went from /iq/designs to /iq/designs/des-auth-rotation
empty-state: pass — /iq/designs/des-nope reads "Design not found / No design review has the id "des-nope". / ← All designs"; the status rail shows Approved with its own list rather than a blank page
role-gating: can open and read all designs. Capabilities from GET /api/session/capabilities for org-leader: ManageBots, DispatchAgentRun, ManageBudgets, ManageSprints, ManageCanary, ViewObservability, ViewLeaderboard, ConnectLocalCompute true; ManageDevbox, ManageIngest, ManageKB, EditGuardrail/EditPolicy/EditSchema, ViewIdentityAdmin false
notes: Each row names the initiative, a status pill, gating and KB state ("logged" on the approved ADR).
