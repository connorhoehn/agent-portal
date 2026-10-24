surface: configuration
role: assessor
user: u-asha
url: /assessment/configuration
pages: portal/src/pages/assessment/ConfigurationPage.tsx
audited: 2026-10-24 14:39–14:39 local, headless Chromium 1680x940 (Playwright), a fresh signed-in clone of u-asha (u-asha-clone-5a3304b1); Tilt stack: Vite :5183 over middleware :3001 (dev:mock); ui-components 2.480.5; mock state not reset (shared stack)
session: sub u-asha-clone-5a3304b1, tenant assessment, role assessor
screenshot: configuration.jpg
verdict: pass — walked 2026-10-24 as a clone of u-asha (assessor); every field below was observed in this pass, none carried forward
console errors: 0 — collected from the load through every interaction below, including the empty-state probe
layout: pass — content col left 224px w 1432px; no horizontal scroll (scrollWidth 1680 vs innerWidth 1680); body scrollHeight 940 <= 940; 1 <main>; h1 "Configuration" 20/600; breadcrumb "System›Configuration"
keyboard: pass — 0 really-visible controls in main; a 70-press Tab walk (page.keyboard, headless) visited 27 distinct stops (0 inside main, the rest are shell chrome); Escape leaves 0 dialogs open; 9 form controls, 0 editable
empty-state: n/a — the configuration always has fixture content; nothing here has an empty state
role-gating: capabilities true: ViewAssessment, ScoreAssessment, ManageSubmissions, RunAssessmentAgent, LabelFeedback; false: ApproveException, PublishReport, ManageKnowledge, ManageAssessmentConfig. ManageAssessmentConfig false: Save in DOM false, 0 of 9 controls editable, Configuration links in the rail 1. Page reads "System › Configuration Configuration Cohort motions and the certification target level used across every team's assessment. Only a program lead can change these"
notes: Signed in as a clone (POST /api/__mock/identity/clone from u-asha, then POST /api/session/login), so the real persona's session epoch was not touched. Not exercised: writes (no run launched, no answer recorded, nothing published or saved).
