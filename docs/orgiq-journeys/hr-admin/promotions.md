surface: promotions
role: hr-admin
user: u-rachel (Rachel Kowalski) — POST /api/session/login then /role; GET /api/session/me: sub u-rachel, tenant orgiq, role hr-admin
url: /iq/promotions (lands on /iq/distillation/review?view=promotions)
pages: portal/src/pages/promotions,portal/src/pages/distillation
audited: 2026-10-06 11:50 local, headless Chromium 1680x940 (Playwright), shared dev:mock stack (BFF :3001, Vite :5183, ui-components 2.413.0)
screenshot: promotions.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1480px; no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly 1 <main>, 1 H1 ("Asset promotions"); first-row-top: 242px; clipped-text sweep: 4 hidden-overflow strings (all carry a title). lands on /iq/distillation/review?view=promotions: Distillation rail, Asset promotions list (All 4, Candidates 3, Approved 0, Promoted 1, Dismissed 0) and an empty review pane ("Review a proposed asset"); candidate titles carry a title
keyboard: pass — 17 of 17 tabbable controls in <main> accept focus — walked by document-order `.focus()` asserting `document.activeElement` (headless: no physical key events; Enter/Escape sent with `page.keyboard` to the focused target)
empty-state: pass — typing "zzznope" one key at a time at 250ms keeps all seven characters (box and ?q= agree) and the list reads "No candidates in this view"; ?item=cand-nope reads "Candidate not found / No promotion candidate has the id "cand-nope". / ← All asset promotions"
role-gating: can view candidates and follow the Agent library link. Capabilities from GET /api/session/capabilities for hr-admin: ManageDevbox, ManageIngest, ManageKB, ManageUsers, ViewIdentityAdmin, EditGuardrail/EditPolicy/EditSchema, ManageBots, DispatchAgentRun, ManageBudgets, ManageCanary, ViewObservability true; ManageSprints, ApproveTransaction, EnterEnvironment false
notes: Both earlier promotion defects are gone on this build: dropped keystrokes in "Find a candidate" and the not-found shown as an outage.
