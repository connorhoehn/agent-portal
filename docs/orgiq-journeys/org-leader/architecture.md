surface: architecture
role: org-leader
user: u-vera (Vera Green — ViewObservability true); re-checked GET /api/session/me on arrival (sub u-vera, tenant orgiq, role org-leader)
url: /iq/agents
pages: portal/src/pages/AgentFlowPage.tsx,portal/src/pages/AgentFlowFrame.tsx
audited: 2026-09-05 23:34 local, Chrome 152 at 1552px, middleware dev:mock
screenshot: architecture.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1352px; not an L surface (no first-row-top rule); nested "Architecture" rail (Window: 1 hour / 24 hours / 7 days) flush with the content box (200 = 200); one stat strip (AGENTS 5 / 6 online · CALLS (24H) 3.0k · ERRORS 25 · ERR RATE 0.8% · Refreshed, with a 1h / 24h / 7d toggle) above the six-node graph and an Edges legend; no horizontal scroll (1552 = 1552)
keyboard: pass — 54 tabbable, all 54 reached in one 70-Tab sweep (focus-log diff: missing none): the sub-rail, the 1h / 24h / 7d toggle, six edges ("Edge from orgiq-supervisor to …"), the six nodes (each node is a `role=button` labelled e.g. "Supervisor — healthy, open metrics"), and Zoom In / Zoom Out / Fit View / Toggle Interactivity; Enter on the Supervisor node opens its drawer (Status healthy, Protocol AG-UI, Model nova-pro-v1, Agent ID orgiq-supervisor, CALLS 847 · ERRORS 3 · P50 1.2s · P95 4.5s, TOOLS route_to_agent / synthesize_responses, "Open agent details →", "Invoke this agent →") with focus on Close; Escape closes it and returns focus to the same node element; the 7d toggle re-renders the strip as "CALLS (7D) 21.0k · ERRORS 175" and writes ?window=7d to the URL
empty-state: n/a — no filter or search; every node carries real counts (Supervisor 847/3, Search 1.5k/7, Scoring 312/0, Advisor 156/2, Graph Builder 67/1, Ingestion 89/12)
role-gating: org-leader can open every node's metrics and follows "Open agent details →" / "Invoke this agent →" (read agents are ungated; Ingestion and Graph Builder are write agents whose direct invoke needs ManageIngest, false for this role — the drawer does not say so); nothing on the page is hidden for this role
notes: The strip now reads "CALLS (24H) 3.0k · ERRORS 25 · ERR RATE 0.8%" and the nodes sum to the same fleet Health reports (2,994 invocations / 25 errors in 24h) — the two OPERATE pages agree about whether anything ran today (DEFECTS #13 closed). Two things a person still notices: (1) the Window sub-rail (1 hour / 24 hours / 7 days) and the strip's 1h / 24h / 7d toggle are the same control twice; (2) each node takes two Tab stops (the React Flow node wrapper and the inner `role=button` card), so the sweep pauses twice per agent.
