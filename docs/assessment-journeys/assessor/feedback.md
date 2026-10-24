surface: feedback
role: assessor
user: u-asha
url: /assessment/feedback
audited: 2026-10-24 14:38–14:39 local, headless Chromium 1680x940 (Playwright), a fresh signed-in clone of u-asha (u-asha-clone-5a3304b1); Tilt stack: Vite :5183 over middleware :3001 (dev:mock); ui-components 2.480.5; mock state not reset (shared stack)
session: sub u-asha-clone-5a3304b1, tenant assessment, role assessor
screenshot: feedback.jpg
verdict: pass — walked 2026-10-24 as a clone of u-asha (assessor); every field below was observed in this pass, none carried forward
console errors: 0 — collected from the load through every interaction below, including the empty-state probe
layout: pass — content col left 200px w 1480px; no horizontal scroll (scrollWidth 1680 vs innerWidth 1680); body scrollHeight 940 <= 940; 1 <main>; h1 "Question queue" 20/600; breadcrumb "Analyze›Feedback"; 15 table rows, first-row-top 269px
keyboard: pass — 21 really-visible controls in main; a 70-press Tab walk (page.keyboard, headless) visited 49 distinct stops (22 inside main, the rest are shell chrome); Escape leaves 0 dialogs open; the first row opened its record at /assessment/feedback/fb-link-notifications-repos ("QUESTIONS 15 NOTIFICATIONS SERVICE 1 Whole assessment Farah Osei: ask Martina Kovacs for the Notifications Service repository URLs and link "), Back returned to /assessment/feedback
empty-state: pass — searching "zzznoexist" leaves "No questions match the current filters."
role-gating: capabilities true: ViewAssessment, ScoreAssessment, ManageSubmissions, RunAssessmentAgent, LabelFeedback; false: ApproveException, PublishReport, ManageKnowledge, ManageAssessmentConfig. Record actions present: Dismiss, Record answer (LabelFeedback true); headers TEAM | DIMENSION | KIND | QUESTION | RAISED
notes: Signed in as a clone (POST /api/__mock/identity/clone from u-asha, then POST /api/session/login), so the real persona's session epoch was not touched. Not exercised: writes (no run launched, no answer recorded, nothing published or saved).
