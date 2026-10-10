surface: settings
role: hr-admin
user: u-rachel (Rachel Kowalski) — POST /api/session/login then /role; GET /api/session/me: sub u-rachel, tenant orgiq, role hr-admin
url: /settings
pages: portal/src/pages/SettingsPage.tsx,portal/src/pages/RangeSliderFrame.tsx
audited: 2026-10-06 12:40 local, headless Chromium 1680x940 (Playwright), shared dev:mock stack (BFF :3001, Vite :5183, ui-components 2.418.0)
screenshot: settings.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1432px; no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly 1 <main>, 1 H1 ("Settings"); clipped-text sweep: clean. Profile, Appearance (theme), Scores (default weighting with Reset), Keyboard (⌘K toggle) and Sessions and an Identity link cards in one column
keyboard: pass — 9 of 9 tabbable controls in <main> accept focus — walked by document-order `.focus()` asserting `document.activeElement` (headless: no physical key events; Enter/Escape sent with `page.keyboard` to the focused target)
empty-state: n/a — no search or filter; nothing on the page can be empty
role-gating: profile shows the signed-in user (Rachel Kowalski); "Open Identity → Users" is shown (ViewIdentityAdmin true). Capabilities from GET /api/session/capabilities for hr-admin: ManageDevbox, ManageIngest, ManageKB, ManageUsers, ViewIdentityAdmin, EditGuardrail/EditPolicy/EditSchema, ManageBots, DispatchAgentRun, ManageBudgets, ManageCanary, ViewObservability true; ManageSprints, ApproveTransaction, EnterEnvironment false
notes: Re-walked after the fix: no request to the BFF root (/metrics, /cluster) — 0 console errors and 0 4xx responses on load (was 2 404s, DEFECTS org-leader #38 / hr-admin #41). The page renders the same Profile, Appearance, Scores, Keyboard and Sessions cards.
