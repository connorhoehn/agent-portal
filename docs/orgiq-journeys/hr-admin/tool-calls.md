surface: tool-calls
role: hr-admin
user: u-rachel (Rachel Kowalski) — POST /api/session/login then /role; GET /api/session/me: sub u-rachel, tenant orgiq, role hr-admin
url: /admin/observability/tools
pages: portal/src/pages/observability/ToolCallsPage.tsx,portal/src/pages/observability/toolCallsFormat.ts,portal/src/pages/observability/ObservabilityLayout.tsx
audited: 2026-10-06 11:50 local, headless Chromium 1680x940 (Playwright), shared dev:mock stack (BFF :3001, Vite :5183, ui-components 2.413.0)
screenshot: tool-calls.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1432px; no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly 1 <main>, 1 H1 ("Tool Calls"); first-row-top: 320px; clipped-text sweep: clean. H1 "Tool Calls" with the window picker (1h/24h/7d/14d); one filter row (All agents, Filter tools…, Failing only); 18 tools in the table, none cut
keyboard: pass — 45 of 45 tabbable controls in <main> accept focus — walked by document-order `.focus()` asserting `document.activeElement` (headless: no physical key events; Enter/Escape sent with `page.keyboard` to the focused target); Enter on the first row/link went from /admin/observability/tools to /admin/observability/summary
empty-state: pass — "zzznoexist" gives "No tool matches these filters / Widen the window, clear the search, or pick All agents."
role-gating: can read per-tool latency, volume and error rate. Capabilities from GET /api/session/capabilities for hr-admin: ManageDevbox, ManageIngest, ManageKB, ManageUsers, ViewIdentityAdmin, EditGuardrail/EditPolicy/EditSchema, ManageBots, DispatchAgentRun, ManageBudgets, ManageCanary, ViewObservability true; ManageSprints, ApproveTransaction, EnterEnvironment false
notes: Error-rate pills are amber at 1.1% / 2.4% / 2.3% and red at 5.0% (generate_embeddings, recommend_pairings).
