surface: bots
role: org-leader
user: u-vera (Vera Green) — POST /api/session/login then /role; GET /api/session/me: sub u-vera, tenant orgiq, role org-leader
url: /admin/bots
pages: portal/src/pages/bots
audited: 2026-10-06 11:50 local, headless Chromium 1680x940 (Playwright), shared dev:mock stack (BFF :3001, Vite :5183, ui-components 2.413.0)
screenshot: bots.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1480px; no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly 1 <main>, 1 H1 ("Bots"); first-row-top: 393px; clipped-text sweep: clean. H1 "Bots" with "+ New bot"; four-tile strip (Enabled 0, Paused 12, Spend today $1.53, Near budget 0), one filter row (search, All bots), twelve bots each with Run now and Resume
keyboard: pass — 68 of 68 tabbable controls in <main> accept focus — walked by document-order `.focus()` asserting `document.activeElement` (headless: no physical key events; Enter/Escape sent with `page.keyboard` to the focused target); Enter on the first row/link went from /admin/bots to /admin/bots/32970d0a-e28e-5100-8fb0-a5cbb87dac99. Enter on the first row link opened the bot's record
empty-state: pass — "zzznoexist" gives "No bots match the current filters." with Clear filters
role-gating: can create ("+ New bot"), run now and resume (ManageBots true). Capabilities from GET /api/session/capabilities for org-leader: ManageBots, DispatchAgentRun, ManageBudgets, ManageSprints, ManageCanary, ViewObservability, ViewLeaderboard, ConnectLocalCompute true; ManageDevbox, ManageIngest, ManageKB, EditGuardrail/EditPolicy/EditSchema, ViewIdentityAdmin false
notes: All twelve seeded bots are parked, as the seed intends; "Run now" is offered on parked bots.
