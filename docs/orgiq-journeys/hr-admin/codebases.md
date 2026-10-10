surface: codebases
role: hr-admin
user: u-rachel (Rachel Kowalski) — POST /api/session/login then /role; GET /api/session/me: sub u-rachel, tenant orgiq, role hr-admin
url: /admin/projects
pages: portal/src/pages/admin/AgentProjectsPage.tsx,portal/src/components/codebases
audited: 2026-10-06 11:50 local, headless Chromium 1680x940 (Playwright), shared dev:mock stack (BFF :3001, Vite :5183, ui-components 2.413.0)
screenshot: codebases.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1432px; no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly 1 <main>, 1 H1 ("Codebases"); first-row-top: 293px; clipped-text sweep: clean. H1 "Codebases" with "+ Link a repository", "Discover" and "Connections"; repository cards two to a row (connorhoehnslalom/orgiq-zero-trust … private), first card at 293px
keyboard: pass — 46 of 46 tabbable controls in <main> accept focus — walked by document-order `.focus()` asserting `document.activeElement` (headless: no physical key events; Enter/Escape sent with `page.keyboard` to the focused target)
empty-state: n/a — no search or filter control exists; each repo with no runs says "Nothing has been run against this yet." and "Not in a workspace yet."
role-gating: can link, discover, unlink and clone ("+ Link a repository", "unlink", "Clone into workspace" present); org-leader is redirected away from /admin/projects (RAIL.md). Capabilities from GET /api/session/capabilities for hr-admin: ManageDevbox, ManageIngest, ManageKB, ManageUsers, ViewIdentityAdmin, EditGuardrail/EditPolicy/EditSchema, ManageBots, DispatchAgentRun, ManageBudgets, ManageCanary, ViewObservability true; ManageSprints, ApproveTransaction, EnterEnvironment false
notes: All fourteen orgiq-* repos show "private", matching the project rule that generated repos are private.
