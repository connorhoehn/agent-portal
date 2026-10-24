surface: submissions
role: admin
user: u-operator
url: /assessment/submissions
audited: 2026-10-24 14:51–14:51 local, headless Chromium 1680x940 (Playwright), a fresh signed-in clone of u-operator (u-operator-clone-113050c7); Tilt stack: Vite :5183 over middleware :3001 (dev:mock); ui-components 2.480.5; mock state not reset (shared stack)
session: sub u-operator-clone-113050c7, tenant assessment, role admin
screenshot: submissions.jpg
verdict: pass — walked 2026-10-24 as a clone of u-operator (admin); every field below was observed in this pass, none carried forward
console errors: 0 — collected from the load through every interaction below, including the empty-state probe
layout: pass — content col left 200px w 1480px; no horizontal scroll (scrollWidth 1680 vs innerWidth 1680); body scrollHeight 940 <= 940; 1 <main>; h1 "Submissions" 20/600; breadcrumb "Assess›Submissions"; 3 table rows, first-row-top 269px
keyboard: pass — 18 really-visible controls in main; a 70-press Tab walk (page.keyboard, headless) visited 46 distinct stops (19 inside main, the rest are shell chrome); Escape leaves 0 dialogs open; no "Revision history" control in the list
empty-state: pass — searching "zzznoexist" leaves "No submission matches “zzznoexist”."
role-gating: capabilities true: ViewAssessment, ScoreAssessment, ApproveException, PublishReport, ManageSubmissions, RunAssessmentAgent, LabelFeedback, ManageKnowledge, ManageAssessmentConfig; false: none. Present: Add submissions →; headers TEAM | SUBMISSION | REVISION | SUBMITTER | RECEIVED | LINKS | STATUS | ACTIONS
notes: Signed in as a clone (POST /api/__mock/identity/clone from u-operator, then POST /api/session/login), so the real persona's session epoch was not touched. Not exercised: writes (no run launched, no answer recorded, nothing published or saved).
