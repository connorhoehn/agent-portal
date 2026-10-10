surface: computer-lab
role: org-leader
user: u-vera (Vera Green) — POST /api/session/login then /role; GET /api/session/me: sub u-vera, tenant orgiq, role org-leader
url: /admin/devbox
pages: portal/src/pages/admin/DevboxPage.tsx
audited: 2026-10-06 11:50 local, headless Chromium 1680x940 (Playwright), shared dev:mock stack (BFF :3001, Vite :5183, ui-components 2.413.0)
screenshot: computer-lab.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1432px; no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly 1 <main>, 1 H1 ("Computer Lab"); first-row-top: 334px; clipped-text sweep: clean. H1 band is the info banner "You can see the fleet but not drive it…"; five computers in a flat list, shell pane showing rachel-scratch read-only
keyboard: pass — 23 of 24 tabbable controls in <main> accept focus (the rest: disabled:⏎) — walked by document-order `.focus()` asserting `document.activeElement` (headless: no physical key events; Enter/Escape sent with `page.keyboard` to the focused target). The one refusal is the disabled ⏎ send control
empty-state: pass — filtering "zzznoexist" reads "Nothing matches." in the computer list; with no ManageDevbox the pane reads "No shell for your role — opening one needs computer access (ManageDevbox)… Showing this computer's activity instead."
role-gating: can see the fleet, the Computers/Agents tabs and "Keys"; the "+ Computer" button is absent from the DOM and no shell is opened. Capabilities from GET /api/session/capabilities for org-leader: ManageBots, DispatchAgentRun, ManageBudgets, ManageSprints, ManageCanary, ViewObservability, ViewLeaderboard, ConnectLocalCompute true; ManageDevbox, ManageIngest, ManageKB, EditGuardrail/EditPolicy/EditSchema, ViewIdentityAdmin false
notes: The earlier defect where the page auto-requested a shell and logged a 403 is gone: zero console errors and no failed request on load.
