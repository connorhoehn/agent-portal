surface: library
role: hr-admin
user: u-rachel (Rachel Kowalski) - GET /api/session/me on this walk: sub u-rachel, tenant orgiq, role hr-admin
url: /iq/library
pages: portal/src/pages/library,portal/src/components/shell/StackedCatalogLayout.tsx
audited: 2026-10-08 07:04 local, headless Chromium 1680x940 (Playwright, fresh browser context per identity: POST /api/session/login then /role), BFF :3001 dev:mock via the Tilt stack, Vite :5183; no write was made and no mock reset
screenshot: library.jpg
verdict: pass
console errors: 0 - cleared before load, read after settle, the Tab walk, Enter/Escape and the empty-state step (0 console.error, 0 pageerror on the real route)
layout: pass - content col left 200px w 1480px; no horizontal scroll (scrollWidth 1680, innerWidth 1680); 1 <main>, h1 "Agent library" 20px/600, trail Build > Agent library; clipped-text sweep (untitled, overflow-hidden strings): 0; first-row-top: 301px (tbody tr, 8 table rows; limit 640); nested rails at x: 200-420 (0px from the content column); page height 940 vs window 940
keyboard: pass - Tab walk (page.keyboard, headless) made 66 distinct stops across the page; document-order focus sweep: 30 of 31 visible controls in <main> accept focus (1 disabled); Enter on "Review a PR diff-scoped" went to /iq/library/skill-pr-review-scoped; Escape leaves 0 dialog/menu open
empty-state: pass - "zzznoexist" in the Search assets… box renders "0 assets" / "Nothing matches" / "No asset matches these facets. Clear a filter or widen the search."
role-gating: hr-admin (GET /api/session/capabilities) true: Search, ViewOrgChart, ViewLeaderboard, ViewObservability, ViewIdentityAdmin, ManageUsers, EditPolicy, EditSchema, EditGuardrail, ManageDevbox, ManageBots, DispatchAgentRun, ManageIngest, ManageKB, ManageCanary, LabelFeedback, ManageBudgets, ManageEnvironments, ConnectLocalCompute; false: ApproveTransaction, Masquerade, ManageSprints, EnterEnvironment. Action-style controls in <main>: New asset
notes: Walked fresh on 2026-10-08 07:04; every field above was observed in this session, none copied forward. Type sizes in <main> (px/weight: count): 13/400:33, 12/400:12, 14/400:11, 13/600:8, 11/600:7, 13/500:6, 12/500:5, 11/500:1. Type-scale ledger (docs/journeys/contracts/type-scale.json, /iq/library): title 20/600, 5 tracked off-scale offender(s) [scale content 11/600; scale content 13/400; scale content 13/600; scale rail 11/600; scale rail 13/500]; cascade violations for the route: none. Not exercised: write actions (nothing was saved, dispatched or deleted), and no physical hover.
