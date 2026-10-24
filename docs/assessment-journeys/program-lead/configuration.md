surface: configuration
role: program-lead
user: u-farah
url: /assessment/configuration
pages: portal/src/pages/assessment/ConfigurationPage.tsx
audited: 2026-10-24 14:48–14:48 local, headless Chromium 1680x940 (Playwright), a fresh signed-in clone of u-farah (u-farah-clone-698c3663); Tilt stack: Vite :5183 over middleware :3001 (dev:mock); ui-components 2.480.5; mock state not reset (shared stack)
session: sub u-farah-clone-698c3663, tenant assessment, role program-lead
screenshot: configuration.jpg
verdict: pass — walked 2026-10-24 as a clone of u-farah (program-lead); every field below was observed in this pass, none carried forward
console errors: 0 — collected from the load through every interaction below, including the empty-state probe
layout: pass — content col left 224px w 1432px; no horizontal scroll (scrollWidth 1680 vs innerWidth 1680); body scrollHeight 940 <= 940; 1 <main>; h1 "Configuration" 20/600; breadcrumb "System›Configuration"
keyboard: pass — 11 really-visible controls in main; a 70-press Tab walk (page.keyboard, headless) visited 38 distinct stops (11 inside main, the rest are shell chrome); Escape leaves 0 dialogs open; 9 form controls, 9 editable
empty-state: n/a — the configuration always has fixture content; nothing here has an empty state
role-gating: capabilities true: ViewAssessment, ScoreAssessment, ApproveException, PublishReport, ManageSubmissions, RunAssessmentAgent, LabelFeedback, ManageKnowledge, ManageAssessmentConfig; false: none. ManageAssessmentConfig true: Save in DOM true, 9 of 9 controls editable, Configuration links in the rail 1. Page reads "System › Configuration Configuration Cohort motions and the certification target level used across every team's assessment. Certification target The level every"
notes: Signed in as a clone (POST /api/__mock/identity/clone from u-farah, then POST /api/session/login), so the real persona's session epoch was not touched. Not exercised: writes (no run launched, no answer recorded, nothing published or saved).
