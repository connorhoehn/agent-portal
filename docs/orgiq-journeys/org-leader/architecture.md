surface: architecture
role: org-leader
user: u-vera (Vera Green) — POST /api/session/login then /role; GET /api/session/me: sub u-vera, tenant orgiq, role org-leader
url: /iq/agents
pages: portal/src/pages/AgentFlowPage.tsx,portal/src/pages/AgentFlowFrame.tsx
audited: 2026-10-06 11:50 local, headless Chromium 1680x940 (Playwright), shared dev:mock stack (BFF :3001, Vite :5183, ui-components 2.413.0)
screenshot: architecture.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1432px; no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly 1 <main>, 1 H1 ("Architecture"); clipped-text sweep: clean. stat strip (Online 8/9, Calls 335, Errors 14, Err rate 4.2%), a blue note "3 agents are not on this diagram", Diagram/List toggle, 1h/24h/7d window; seven agent nodes and their edges visible without scrolling
keyboard: pass — 23 of 23 tabbable controls in <main> accept focus — walked by document-order `.focus()` asserting `document.activeElement` (headless: no physical key events; Enter/Escape sent with `page.keyboard` to the focused target)
empty-state: n/a — no search or filter; the List view is the fallback for agents not drawn (the note says so)
role-gating: can read agent health and edges (ViewObservability true); no edit controls exist. Capabilities from GET /api/session/capabilities for org-leader: ManageBots, DispatchAgentRun, ManageBudgets, ManageSprints, ManageCanary, ViewObservability, ViewLeaderboard, ConnectLocalCompute true; ManageDevbox, ManageIngest, ManageKB, EditGuardrail/EditPolicy/EditSchema, ViewIdentityAdmin false
notes: Ingestion is amber (8 errors, p95 12.4s); the legend names the edge colours.
