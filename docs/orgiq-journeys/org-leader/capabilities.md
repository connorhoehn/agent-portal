surface: capabilities
role: org-leader
user: u-vera (Vera Green) — POST /api/session/login then /role; GET /api/session/me: sub u-vera, tenant orgiq, role org-leader
url: /admin/capabilities
pages: portal/src/pages/capabilities/CapabilitiesHomePage.tsx
audited: 2026-10-06 11:50 local, headless Chromium 1680x940 (Playwright), shared dev:mock stack (BFF :3001, Vite :5183, ui-components 2.413.0)
screenshot: capabilities.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1432px; no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly 1 <main>, 1 H1 ("Capabilities"); clipped-text sweep: clean. red "Needs attention" band, then a seven-row capability table (Browser, Browser profile, Code Interpreter, Memory, Guardrails…) with status, what uses it, configured id, last used
keyboard: pass — 12 of 12 tabbable controls in <main> accept focus — walked by document-order `.focus()` asserting `document.activeElement` (headless: no physical key events; Enter/Escape sent with `page.keyboard` to the focused target); Enter on the first row/link went from /admin/capabilities to /admin/capabilities/browser. Enter on the first link goes to /admin/capabilities/browser
empty-state: n/a — no search or filter; the page's own failure state is the Needs attention band ("Browser profile orgiq_browser_profile-STALE0PRF does not exist in this account. BROWSER_PROFILE_ID in middleware/.env.aws is stale"), which is correct for this machine's stale env file
role-gating: can read the platform inventory and follow each "What uses it" link. Capabilities from GET /api/session/capabilities for org-leader: ManageBots, DispatchAgentRun, ManageBudgets, ManageSprints, ManageCanary, ViewObservability, ViewLeaderboard, ConnectLocalCompute true; ManageDevbox, ManageIngest, ManageKB, EditGuardrail/EditPolicy/EditSchema, ViewIdentityAdmin false
notes: The stale browser profile is a real local-environment fact (the .env.aws id), reported correctly by the page, not a page defect.
