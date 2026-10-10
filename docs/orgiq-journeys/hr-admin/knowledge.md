surface: knowledge
role: hr-admin
user: u-rachel (Rachel Kowalski) - GET /api/session/me on this walk: sub u-rachel, tenant orgiq, role hr-admin
url: /admin/knowledge
pages: portal/src/pages/knowledge
audited: 2026-10-08 07:04 local, headless Chromium 1680x940 (Playwright, fresh browser context per identity: POST /api/session/login then /role), BFF :3001 dev:mock via the Tilt stack, Vite :5183; no write was made and no mock reset
screenshot: knowledge.jpg
verdict: pass
console errors: 0 - cleared before load, read after settle, the Tab walk, Enter/Escape and the empty-state step (0 console.error, 0 pageerror on the real route)
layout: pass - content col left 200px w 1480px; no horizontal scroll (scrollWidth 1680, innerWidth 1680); 1 <main>, h1 "Knowledge" 20px/600, trail Operate > Knowledge; clipped-text sweep (untitled, overflow-hidden strings): 0; first-row-top: 292px (tbody tr, 3 table rows; limit 640); nested rails at x: 200-420 (0px from the content column); page height 940 vs window 940
keyboard: pass - Tab walk (page.keyboard, headless) made 60 distinct stops across the page; document-order focus sweep: 25 of 25 visible controls in <main> accept focus (0 disabled); Enter on "OrgIQ Knowledge Base" went to /admin/knowledge/registry/a0000001-0000-4000-8000-000000000001; Escape leaves 0 dialog/menu open
empty-state: pass - "zzznoexist" in the Search by name, slug or id… box renders "0 of 3 knowledge bases" / "No knowledge bases match the current filters."
role-gating: hr-admin (GET /api/session/capabilities) true: Search, ViewOrgChart, ViewLeaderboard, ViewObservability, ViewIdentityAdmin, ManageUsers, EditPolicy, EditSchema, EditGuardrail, ManageDevbox, ManageBots, DispatchAgentRun, ManageIngest, ManageKB, ManageCanary, LabelFeedback, ManageBudgets, ManageEnvironments, ConnectLocalCompute; false: ApproveTransaction, Masquerade, ManageSprints, EnterEnvironment. Action-style controls in <main>: + New link
notes: Walked fresh on 2026-10-08 07:04; every field above was observed in this session, none copied forward. Type sizes in <main> (px/weight: count): 11/400:21, 14/400:17, 14/600:11, 12/600:8, 12/400:8, 13/500:7, 10/600:4, 11/600:3. Type-scale ledger (docs/journeys/contracts/type-scale.json, /admin/knowledge): title 20/600, 6 tracked off-scale offender(s) [scale content 11/400; scale content 11/700; scale content 13/400; scale content 13/700; scale rail 11/600; scale rail 13/500]; cascade violations for the route: none. Not exercised: write actions (nothing was saved, dispatched or deleted), and no physical hover.
