surface: health
role: org-leader
user: u-vera (Vera Green) — POST /api/session/login then /role; GET /api/session/me: sub u-vera, tenant orgiq, role org-leader
url: /admin/observability/summary
pages: portal/src/pages/observability/SummaryPage.tsx,portal/src/pages/observability/ObservabilityLayout.tsx
audited: 2026-10-06 11:50 local, headless Chromium 1680x940 (Playwright), shared dev:mock stack (BFF :3001, Vite :5183, ui-components 2.413.0)
screenshot: health.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1432px; no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly 1 <main>, 1 H1 ("Overview"); first-row-top: 226px; clipped-text sweep: clean. Observability rail (Overview 14, On-Call, Runs 50, Cost, More 1) at x 224; Overview tiles (Deployed agents 9, Alarms 0, Errors 14) then a Fleet grid; first card at 226px
keyboard: pass — 13 of 13 tabbable controls in <main> accept focus — walked by document-order `.focus()` asserting `document.activeElement` (headless: no physical key events; Enter/Escape sent with `page.keyboard` to the focused target); Enter on the first row/link stayed in place
empty-state: n/a — Overview has no filter; Errors (24h) 14 links to Runs and an agent with no runs says "no runs in 24h"
role-gating: can read overview, On-Call, Runs, Cost and the 15 detail views behind "Show 15 detail views". Capabilities from GET /api/session/capabilities for org-leader: ManageBots, DispatchAgentRun, ManageBudgets, ManageSprints, ManageCanary, ViewObservability, ViewLeaderboard, ConnectLocalCompute true; ManageDevbox, ManageIngest, ManageKB, EditGuardrail/EditPolicy/EditSchema, ViewIdentityAdmin false
notes: Fleet cards flag Supervisor/Search/Advisor/Ingestion/Graph Builder with their error counts; Devbox and the assessment agents read 0.
