surface: automate
role: member
user: u-theo (Theo Chang) - GET /api/session/me on this walk: sub u-theo, tenant orgiq, role member
url: /iq/work
pages: portal/src/pages/work
audited: 2026-10-08 07:04 local, headless Chromium 1680x940 (Playwright, fresh browser context per identity: POST /api/session/login then /role), BFF :3001 dev:mock via the Tilt stack, Vite :5183; no write was made and no mock reset
screenshot: automate.jpg
verdict: pass
console errors: 0 - cleared before load, read after settle, the Tab walk, Enter/Escape and the empty-state step (0 console.error, 0 pageerror on the real route)
layout: pass - content col left 200px w 1480px; no horizontal scroll (scrollWidth 1680, innerWidth 1680); 1 <main>, h1 "Inbox" 20px/600, trail Build > Automate > Inbox; clipped-text sweep (untitled, overflow-hidden strings): 0; first-row-top: 447px (tbody tr, 4 table rows; limit 640); nested rails at x: 200-420 (0px from the content column); page height 940 vs window 940
keyboard: pass - Tab walk (page.keyboard, headless) made 42 distinct stops across the page; document-order focus sweep: 16 of 16 visible controls in <main> accept focus (0 disabled); Enter on "inference-canary-nightly" went to /iq/work/job-inf-maint-1; Escape leaves 0 dialog/menu open
empty-state: n/a - no search or filter control on this surface
role-gating: member (GET /api/session/capabilities) true: Search, ViewOrgChart, ViewObservability, LabelFeedback, ConnectLocalCompute; false: ViewLeaderboard, ViewIdentityAdmin, ManageUsers, EditPolicy, EditSchema, EditGuardrail, ManageDevbox, ManageBots, DispatchAgentRun, ManageIngest, ManageKB, ManageCanary, ApproveTransaction, Masquerade, ManageBudgets, ManageSprints, EnterEnvironment, ManageEnvironments. Action-style controls in <main>: none visible
notes: Walked fresh on 2026-10-08 07:04; every field above was observed in this session, none copied forward. Type sizes in <main> (px/weight: count): 14/400:26, 14/600:7, 13/400:7, 13/500:4, 12/600:4, 10/600:4, 12/500:2, 11/600:1. Type-scale ledger (docs/journeys/contracts/type-scale.json, /iq/work): title 20/600, 8 tracked off-scale offender(s) [scale content 10.5/400; scale content 10/400; scale content 11/400; scale content 11/700; scale content 13.5/500; scale content 13/400; scale rail 11/600; scale rail 13/500]; cascade violations for the route: none. Not exercised: write actions (nothing was saved, dispatched or deleted), and no physical hover.
