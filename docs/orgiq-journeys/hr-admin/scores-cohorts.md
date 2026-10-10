surface: scores-cohorts
role: hr-admin
user: u-rachel (Rachel Kowalski) — POST /api/session/login then /role; GET /api/session/me: sub u-rachel, tenant orgiq, role hr-admin
url: /iq/scores/cohorts
pages: portal/src/pages/ScoresCohortPage.tsx,portal/src/components/scores
audited: 2026-10-06 12:40 local, headless Chromium 1680x940 (Playwright), shared dev:mock stack (BFF :3001, Vite :5183, ui-components 2.418.0)
screenshot: scores-cohorts.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1432px; no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly 1 <main>, 1 H1 ("Score Cohorts"); first-row-top: 208px; clipped-text sweep: clean. six cohort cards (Data Platform 11 people, Design Systems 7, ML / AI 10, Platform Engineering 14, Product 8, Security 6) in a 3x2 grid beside the Scores rail; no table
keyboard: pass — 7 of 7 tabbable controls in <main> accept focus — walked by document-order `.focus()` asserting `document.activeElement` (headless: no physical key events; Enter/Escape sent with `page.keyboard` to the focused target); Enter on the first row/link went from /iq/scores/cohorts to /iq/scores
empty-state: n/a — no search or filter; each card carries its own Gini value and named brokers where they exist
role-gating: can read distributions and brokers. Capabilities from GET /api/session/capabilities for hr-admin: ManageDevbox, ManageIngest, ManageKB, ManageUsers, ViewIdentityAdmin, EditGuardrail/EditPolicy/EditSchema, ManageBots, DispatchAgentRun, ManageBudgets, ManageCanary, ViewObservability true; ManageSprints, ApproveTransaction, EnterEnvironment false
notes: Each card shows its histogram, median and Gini; brokers listed only for four of six teams.
