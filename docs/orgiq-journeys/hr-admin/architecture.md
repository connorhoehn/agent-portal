surface: architecture
role: hr-admin
user: u-rachel (Rachel Kowalski) — verified via GET /api/session/me on this surface (sub u-rachel, role hr-admin, tenant orgiq)
url: /iq/agents
pages: portal/src/pages/AgentFlowPage.tsx,portal/src/pages/AgentFlowFrame.tsx
audited: 2026-09-06 00:33 local, Chrome 1552px, middleware dev:mock
screenshot: architecture.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; breadcrumb "Operate › Architecture"; nested "Architecture" rail (Window: 1 hour / 24 hours / 7 days) flush with the content box at 224px; not an L surface (no first-row-top rule); one stat bar (Agents 5/6 online · Calls 3.0k · Errors 25 · Err rate 0.8% · Refreshed · Window 1h/24h/7d) above the 6-node graph; no horizontal scroll (1552 = 1552)
keyboard: pass — 57 controls counted, every one reached by a 60-press Tab sweep (rail → nested rail → 1h/24h/7d → the 6 edge groups (`<g>` "Edge from orgiq-supervisor to …", xyflow's own focusable edges) → for each of the 6 nodes the xyflow wrapper then the node card (`role=button`, aria-label "Supervisor — healthy, open metrics" … "Ingestion — degraded, open metrics") → Zoom In / Zoom Out / Fit View / Toggle Interactivity → wraps). Every `.react-flow__node` now computes `visibility: visible` with tabIndex 0. Enter on the focused Supervisor card opens the metrics drawer (`role=dialog`: Status healthy · Protocol AG-UI · Model nova-pro-v1 · Agent ID · Calls 847 / Errors 3 / p50 1.2s / p95 4.5s · Tools · "Open agent details →" /iq/agents/orgiq-supervisor · "Invoke this agent →" /iq/invoke?agentId=orgiq-supervisor) with focus on its Close button; Escape closes it and returns focus to the same node card
empty-state: n/a — the fixed 6-agent topology always renders; no filter/search exists to drive it empty
role-gating: `/iq/agents` is wrapped in RequireRole org-leader/hr-admin; hr-admin sees the full topology with live 24h metrics and the drawer's "Invoke this agent" link — Ingestion (amber, 12 errors, p95 12.0s) is the degraded node and is a write agent gated on ManageIngest, which this role holds
notes: DEFECTS #6 re-observed as fixed — nodes are measured (visible) and each card is its own keyboard button, so a keyboard user opens the same drawer a mouse click does. The stat bar's 25 errors matches Health's 24h error count, and the graph legend (edge colours by error rate) sits inside the canvas rather than above it.
