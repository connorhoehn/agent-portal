surface: invocations
role: hr-admin
user: u-rachel (Rachel Kowalski) — POST /api/session/login then /role; GET /api/session/me: sub u-rachel, tenant orgiq, role hr-admin
url: /admin/observability/invocations
pages: portal/src/pages/observability/InvocationsPage.tsx,portal/src/pages/observability/InvocationDetailPage.tsx,portal/src/pages/observability/invocationsFilters.ts,portal/src/pages/observability/ObservabilityLayout.tsx
audited: 2026-10-06 11:50 local, headless Chromium 1680x940 (Playwright), shared dev:mock stack (BFF :3001, Vite :5183, ui-components 2.413.0)
screenshot: invocations.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1432px; no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly 1 <main>, 1 H1 ("Runs"); first-row-top: 337px; clipped-text sweep: 28 hidden-overflow strings (all carry a title). Runs table, 50 rows; filters at the right (All agents, All statuses); 28 prompt/response cells are cut with ellipsis and every one carries a title with the full text
keyboard: pass — 61 of 61 tabbable controls in <main> accept focus — walked by document-order `.focus()` asserting `document.activeElement` (headless: no physical key events; Enter/Escape sent with `page.keyboard` to the focused target); Enter on the first row/link went from /admin/observability/invocations to /admin/observability/summary. 61 controls: one per row plus the filters
empty-state: n/a — the filters are selects with an All state; the header reads "Live · last 50 invocations, 14 of them errored" and failed rows show their error text in red
role-gating: can read every run; no write control. Capabilities from GET /api/session/capabilities for hr-admin: ManageDevbox, ManageIngest, ManageKB, ManageUsers, ViewIdentityAdmin, EditGuardrail/EditPolicy/EditSchema, ManageBots, DispatchAgentRun, ManageBudgets, ManageCanary, ViewObservability true; ManageSprints, ApproveTransaction, EnterEnvironment false
notes: Rows show When, Agent, Prompt, Response, Duration and Status; the error runs (A2A timeout, OpenSearch timeout, Bedrock throttling) are legible.
