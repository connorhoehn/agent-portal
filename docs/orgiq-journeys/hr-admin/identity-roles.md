surface: identity-roles
role: hr-admin
user: u-rachel (Rachel Kowalski) - GET /api/session/me on this walk: sub u-rachel, tenant orgiq, role hr-admin
url: /admin/identity/roles
pages: portal/src/pages/identity
audited: 2026-10-08 07:04 local, headless Chromium 1680x940 (Playwright, fresh browser context per identity: POST /api/session/login then /role), BFF :3001 dev:mock via the Tilt stack, Vite :5183; no write was made and no mock reset
screenshot: identity-roles.jpg
verdict: pass
console errors: 0 - cleared before load, read after settle, the Tab walk, Enter/Escape and the empty-state step (0 console.error, 0 pageerror on the real route)
layout: pass - content col left 200px w 1480px; no horizontal scroll (scrollWidth 1680, innerWidth 1680); 1 <main>, h1 "Roles" 20px/600, trail System > Identity > Roles; clipped-text sweep (untitled, overflow-hidden strings): 0; first-row-top: 246px (tbody tr, 45 table rows; limit 640); nested rails at x: 200-420 (0px from the content column); page height 940 vs window 940
keyboard: pass - Tab walk (page.keyboard, headless) made 27 distinct stops across the page; document-order focus sweep: 6 of 6 visible controls in <main> accept focus (0 disabled); no row link on this surface; Escape leaves 0 dialog/menu open
empty-state: n/a - no search or filter control on this surface
role-gating: hr-admin (GET /api/session/capabilities) true: Search, ViewOrgChart, ViewLeaderboard, ViewObservability, ViewIdentityAdmin, ManageUsers, EditPolicy, EditSchema, EditGuardrail, ManageDevbox, ManageBots, DispatchAgentRun, ManageIngest, ManageKB, ManageCanary, LabelFeedback, ManageBudgets, ManageEnvironments, ConnectLocalCompute; false: ApproveTransaction, Masquerade, ManageSprints, EnterEnvironment. Action-style controls in <main>: none visible
notes: Walked fresh on 2026-10-08 07:04; every field above was observed in this session, none copied forward. Type sizes in <main> (px/weight: count): 10/600:793, 14/400:50, 12/400:30, 12/600:16, 14/600:15, 13/500:5, 11/600:1, 14/500:1. Type-scale ledger (docs/journeys/contracts/type-scale.json, /admin/identity/roles): title 20/600, 3 tracked off-scale offender(s) [scale content 10/600; scale rail 11/600; scale rail 13/500]; cascade violations for the route: none. Not exercised: write actions (nothing was saved, dispatched or deleted), and no physical hover.
