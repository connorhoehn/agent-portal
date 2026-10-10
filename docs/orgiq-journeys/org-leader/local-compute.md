surface: local-compute
role: org-leader
user: u-vera (Vera Green) — POST /api/session/login then /role; GET /api/session/me: sub u-vera, tenant orgiq, role org-leader
url: /iq/local-compute
pages: portal/src/pages/local-compute
audited: 2026-10-06 11:50 local, headless Chromium 1680x940 (Playwright), shared dev:mock stack (BFF :3001, Vite :5183, ui-components 2.413.0)
screenshot: local-compute.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1480px; no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly 1 <main>, 1 H1 ("Local compute"); clipped-text sweep: clean. nested rail (Machines, Runs, Configuration) flush at x 200; not a list surface for this persona — no machine is paired, so the page is the H1, one description line and the empty state
keyboard: pass — 4 of 4 tabbable controls in <main> accept focus — walked by document-order `.focus()` asserting `document.activeElement` (headless: no physical key events; Enter/Escape sent with `page.keyboard` to the focused target). Enter on "Pair a machine" opens the dialog with focus on its "Done" button; Tab moves to "Copy code"; Escape closes it and focus returns to "Pair a machine" (two forced frames before each read)
empty-state: pass — the seeded state is the empty state and names the next action ("No paired machines / Pair a machine and it appears here…" with a Pair a machine button)
role-gating: can pair a machine (ConnectLocalCompute true). Capabilities from GET /api/session/capabilities for org-leader: ManageBots, DispatchAgentRun, ManageBudgets, ManageSprints, ManageCanary, ViewObservability, ViewLeaderboard, ConnectLocalCompute true; ManageDevbox, ManageIngest, ManageKB, EditGuardrail/EditPolicy/EditSchema, ViewIdentityAdmin false
notes: The earlier defect where the Pair dialog left focus on <body> does not reproduce on this build.
