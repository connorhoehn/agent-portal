surface: initiatives
role: program-owner
user: u-mia (Mia Singh) - GET /api/session/me on this walk: sub u-mia, tenant orgiq, role program-owner
url: /iq/projects
pages: portal/src/pages/ProjectsPage.tsx,portal/src/pages/projects,portal/src/pages/sprints,portal/src/pages/project-detail
audited: 2026-10-08 07:04 local, headless Chromium 1680x940 (Playwright, fresh browser context per identity: POST /api/session/login then /role), BFF :3001 dev:mock via the Tilt stack, Vite :5183; no write was made and no mock reset
screenshot: initiatives.jpg
verdict: pass
console errors: 0 - cleared before load, read after settle, the Tab walk, Enter/Escape and the empty-state step (0 console.error, 0 pageerror on the real route)
layout: pass - content col left 200px w 1480px; no horizontal scroll (scrollWidth 1680, innerWidth 1680); 1 <main>, h1 "All initiatives" 20px/600, trail Plan > Initiatives > All initiatives; clipped-text sweep (untitled, overflow-hidden strings): 0; first-row-top: 295px (tbody tr, 14 table rows; limit 640); nested rails at x: none; page height 940 vs window 940
keyboard: pass - Tab walk (page.keyboard, headless) made 69 distinct stops across the page; document-order focus sweep: 59 of 60 visible controls in <main> accept focus (1 disabled); Enter on "Observability Platform" went to /iq/projects/p-observability?scope=all; Escape leaves 0 dialog/menu open
empty-state: pass - "zzznoexist" in the Find an initiative… box renders "No matches" / "No initiative matches this search or filter." / "0 of 14 initiatives"
role-gating: program-owner (GET /api/session/capabilities) true: Search, ViewOrgChart, ViewObservability, ManageBots, DispatchAgentRun, LabelFeedback, ManageBudgets, ManageSprints; false: ViewLeaderboard, ViewIdentityAdmin, ManageUsers, EditPolicy, EditSchema, EditGuardrail, ManageDevbox, ManageIngest, ManageKB, ManageCanary, ApproveTransaction, Masquerade, EnterEnvironment, ManageEnvironments, ConnectLocalCompute. Action-style controls in <main>: Remove Org › Initiatives from this draft, Add link; a composer is present
notes: Walked fresh on 2026-10-08 07:04; every field above was observed in this session, none copied forward. Type sizes in <main> (px/weight: count): 7.6/600:41, 11/400:29, 12/600:20, 12/400:20, 13/600:15, 14/400:14, 10/400:14, 13/500:13. Type-scale ledger (docs/journeys/contracts/type-scale.json, /iq/projects): title 20/600, 9 tracked off-scale offender(s) [scale content 10/400; scale content 11/400; scale content 13/600; scale rail 11/500; scale rail 11/600; scale rail 13/400; scale rail 13/500; scale rail 13/600; siblings rail 11|16]; cascade violations for the route: none. Not exercised: write actions (nothing was saved, dispatched or deleted), and no physical hover.
