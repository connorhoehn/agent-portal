surface: computer-lab
role: hr-admin
user: u-rachel (Rachel Kowalski) — POST /api/session/login then /role; GET /api/session/me: sub u-rachel, tenant orgiq, role hr-admin
url: /admin/devbox
pages: portal/src/pages/admin/DevboxPage.tsx
audited: 2026-10-06 11:50 local, headless Chromium 1680x940 (Playwright), shared dev:mock stack (BFF :3001, Vite :5183, ui-components 2.413.0)
screenshot: computer-lab.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1432px; no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly 1 <main>, 1 H1 ("Computer Lab"); first-row-top: 323px; clipped-text sweep: clean. computers are grouped by initiative (Observability Platform, Auth Migration, Unassigned); shell pane attached to rachel-scratch
keyboard: pass — 24 of 25 tabbable controls in <main> accept focus (the rest: disabled:⏎) — walked by document-order `.focus()` asserting `document.activeElement` (headless: no physical key events; Enter/Escape sent with `page.keyboard` to the focused target). The one refusal is the disabled ⏎ send control
empty-state: pass — filtering "zzznoexist" reads "Nothing matches."
role-gating: has ManageDevbox: "+ Computer" and "Keys" are present and the shell is live (simulated AgentCore devbox, "Type help…"). Capabilities from GET /api/session/capabilities for hr-admin: ManageDevbox, ManageIngest, ManageKB, ManageUsers, ViewIdentityAdmin, EditGuardrail/EditPolicy/EditSchema, ManageBots, DispatchAgentRun, ManageBudgets, ManageCanary, ViewObservability true; ManageSprints, ApproveTransaction, EnterEnvironment false
notes: No console errors; the group headers show spend against allocation ("$0.46 / $95 · 3 bots").
