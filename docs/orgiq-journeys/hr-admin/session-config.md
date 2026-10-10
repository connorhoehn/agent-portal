surface: session-config
role: hr-admin
user: u-rachel (Rachel Kowalski) — POST /api/session/login then /role; GET /api/session/me: sub u-rachel, tenant orgiq, role hr-admin
url: /iq/release (lands on /iq/local-compute/configuration)
pages: portal/src/pages/local-compute/ConfigurationPage.tsx
audited: 2026-10-06 11:50 local, headless Chromium 1680x940 (Playwright), shared dev:mock stack (BFF :3001, Vite :5183, ui-components 2.413.0)
screenshot: session-config.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1480px; no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly 1 <main>, 1 H1 ("Session settings"); clipped-text sweep: clean. /iq/release redirects to /iq/local-compute/configuration ("Session settings"): nested Local compute rail (Machines, Runs, Configuration) flush at x 200, a blue read-only banner, "Configuration preview v12" meta, one update-available disclosure and Skills · 3 / Hooks · 1 / Settings · 4 tabs
keyboard: pass — 5 of 6 tabbable controls in <main> accept focus (the rest: Open library skill →) — walked by document-order `.focus()` asserting `document.activeElement` (headless: no physical key events; Enter/Escape sent with `page.keyboard` to the focused target). The one refusal is the "Open library skill →" link inside the closed update disclosure
empty-state: pass — with the session-bundles fixture on its empty scenario (set and restored with POST /api/__mock/scenario for that fixture only) the page reads "No configuration preview / No session bundle has been published yet, so sessions run with the settings baked into their image." — an empty state, not an error card; default restored and re-read
role-gating: read-only for both roles: no publish or rollout control exists ("Runtime configuration management is not available yet"). Capabilities from GET /api/session/capabilities for hr-admin: ManageDevbox, ManageIngest, ManageKB, ManageUsers, ViewIdentityAdmin, EditGuardrail/EditPolicy/EditSchema, ManageBots, DispatchAgentRun, ManageBudgets, ManageCanary, ViewObservability true; ManageSprints, ApproveTransaction, EnterEnvironment false
notes: The empty-state copy and the broken-sentence problem filed earlier are both fixed. The empty scenario logs its own 404 console lines (the provider answering no bundle), which are the probe's, not the page's.
