surface: budgets
role: program-owner
user: u-mia (Mia Singh) - GET /api/session/me on this walk: sub u-mia, tenant orgiq, role program-owner
url: /admin/budgets
pages: portal/src/pages/budgets
audited: 2026-10-08 07:04 local, headless Chromium 1680x940 (Playwright, fresh browser context per identity: POST /api/session/login then /role), BFF :3001 dev:mock via the Tilt stack, Vite :5183; no write was made and no mock reset
screenshot: budgets.jpg
verdict: pass
console errors: 0 - cleared before load, read after settle, the Tab walk, Enter/Escape and the empty-state step (0 console.error, 0 pageerror on the real route)
layout: pass - content col left 200px w 1480px; no horizontal scroll (scrollWidth 1680, innerWidth 1680); 1 <main>, h1 "Initiatives" 20px/600, trail Plan > Budgets; clipped-text sweep (untitled, overflow-hidden strings): 0; first-row-top: 280px (tbody tr, 14 table rows; limit 640); nested rails at x: 200-420 (0px from the content column); page height 940 vs window 940
keyboard: pass - Tab walk (page.keyboard, headless) made 72 distinct stops across the page; document-order focus sweep: 43 of 43 visible controls in <main> accept focus (0 disabled); Enter on "Observability Platform" went to /iq/projects/p-observability; Escape leaves 0 dialog/menu open
empty-state: n/a - no search or filter control on this surface
role-gating: program-owner (GET /api/session/capabilities) true: Search, ViewOrgChart, ViewObservability, ManageBots, DispatchAgentRun, LabelFeedback, ManageBudgets, ManageSprints; false: ViewLeaderboard, ViewIdentityAdmin, ManageUsers, EditPolicy, EditSchema, EditGuardrail, ManageDevbox, ManageIngest, ManageKB, ManageCanary, ApproveTransaction, Masquerade, EnterEnvironment, ManageEnvironments, ConnectLocalCompute. Action-style controls in <main>: Remove allocation for <row>
notes: Walked fresh on 2026-10-08 07:04; every field above was observed in this session, none copied forward. Type sizes in <main> (px/weight: count): 14/400:94, 14/600:19, 10/600:13, 12/600:9, 12/400:5, 12/500:4, 13/500:2, 11/600:1. Type-scale ledger (docs/journeys/contracts/type-scale.json, /admin/budgets): title 20/600, 2 tracked off-scale offender(s) [scale rail 11/600; scale rail 13/500]; cascade violations for the route: none. Not exercised: write actions (nothing was saved, dispatched or deleted), and no physical hover.
