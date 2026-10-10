surface: automate-findings
role: hr-admin
user: u-rachel (Rachel Kowalski) — POST /api/session/login then /role; GET /api/session/me: sub u-rachel, tenant orgiq, role hr-admin
url: /iq/work/findings
pages: portal/src/pages/work,portal/src/components/shell/BuildSectionLayout.tsx
audited: 2026-10-06 12:40 local, headless Chromium 1680x940 (Playwright), shared dev:mock stack (BFF :3001, Vite :5183, ui-components 2.418.0)
screenshot: automate-findings.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1480px; no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly 1 <main>, 1 H1 ("Findings"); first-row-top: 407px; clipped-text sweep: clean. H1 "Findings" with "Run sweeps now" at the right, a Dead-letter queue block, four status chips (open / promoted / resolved / dismissed) and four finding groups (Orphan decisions 2, Bus factor 1, Lab signals 1, Stale docs 1)
keyboard: pass — 16 of 16 tabbable controls in <main> accept focus — walked by document-order `.focus()` asserting `document.activeElement` (headless: no physical key events; Enter/Escape sent with `page.keyboard` to the focused target)
empty-state: pass — the Dead-letter queue block is empty and says so ("Nothing dead-lettered. Failed jobs land here with their error and a requeue button."); the resolved chip shows its own shorter list (Orphan decisions, 1 finding) rather than blanking the page
role-gating: can view findings and "Run sweeps now" (ManageBots/DispatchAgentRun true). Capabilities from GET /api/session/capabilities for hr-admin: ManageDevbox, ManageIngest, ManageKB, ManageUsers, ViewIdentityAdmin, EditGuardrail/EditPolicy/EditSchema, ManageBots, DispatchAgentRun, ManageBudgets, ManageCanary, ViewObservability true; ManageSprints, ApproveTransaction, EnterEnvironment false
notes: Rows are collapsed groups with a severity pill (warning/info); nothing is cut.
