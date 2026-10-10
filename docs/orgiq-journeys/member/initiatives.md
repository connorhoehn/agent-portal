surface: initiatives
role: member
user: u-theo (Theo Chang) - GET /api/session/me on this walk: sub u-theo, tenant orgiq, role member
url: /iq/projects
pages: portal/src/pages/ProjectsPage.tsx,portal/src/pages/projects,portal/src/pages/sprints,portal/src/pages/project-detail
audited: 2026-10-08 07:04 local, headless Chromium 1680x940 (Playwright, fresh browser context per identity: POST /api/session/login then /role), BFF :3001 dev:mock via the Tilt stack, Vite :5183; no write was made and no mock reset
screenshot: initiatives.jpg
verdict: pass
console errors: 0 - cleared before load, read after settle, the Tab walk, Enter/Escape and the empty-state step (0 console.error, 0 pageerror on the real route)
layout: pass - content col left 200px w 1480px; no horizontal scroll (scrollWidth 1680, innerWidth 1680); 1 <main>, h1 "My initiatives" 20px/600, trail Plan > Initiatives > My initiatives; clipped-text sweep (untitled, overflow-hidden strings): 0; first-row-top: 239px (tbody tr, 1 table rows; limit 640); nested rails at x: none; page height 940 vs window 940
keyboard: pass - Tab walk (page.keyboard, headless) made 39 distinct stops across the page; document-order focus sweep: 21 of 22 visible controls in <main> accept focus (1 disabled); Enter on "Design System API" went to /iq/projects/p-design-system-api?scope=mine; Escape leaves 0 dialog/menu open
empty-state: pass - "zzznoexist" in the Find an initiative… box renders "No matches" / "No initiative matches this search or filter." / "0 of 1 initiative"
role-gating: member (GET /api/session/capabilities) true: Search, ViewOrgChart, ViewObservability, LabelFeedback, ConnectLocalCompute; false: ViewLeaderboard, ViewIdentityAdmin, ManageUsers, EditPolicy, EditSchema, EditGuardrail, ManageDevbox, ManageBots, DispatchAgentRun, ManageIngest, ManageKB, ManageCanary, ApproveTransaction, Masquerade, ManageBudgets, ManageSprints, EnterEnvironment, ManageEnvironments. Action-style controls in <main>: Remove Org › Initiatives from this draft, Add link; a composer is present
notes: Walked fresh on 2026-10-08 07:04; every field above was observed in this session, none copied forward. Type sizes in <main> (px/weight: count): 12/600:9, 14/400:5, 12/400:5, 11/600:3, 13/500:3, 7.6/600:3, 13/600:2, 11/400:2. Type-scale ledger (docs/journeys/contracts/type-scale.json, /iq/projects): title 20/600, 9 tracked off-scale offender(s) [scale content 10/400; scale content 11/400; scale content 13/600; scale rail 11/500; scale rail 11/600; scale rail 13/400; scale rail 13/500; scale rail 13/600; siblings rail 11|16]; cascade violations for the route: none. Not exercised: write actions (nothing was saved, dispatched or deleted), and no physical hover.
