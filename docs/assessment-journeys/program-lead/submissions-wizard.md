surface: submissions-wizard
role: program-lead
user: u-farah
url: /assessment/submissions?view=add
audited: 2026-10-24 14:47–14:47 local, headless Chromium 1680x940 (Playwright), a fresh signed-in clone of u-farah (u-farah-clone-698c3663); Tilt stack: Vite :5183 over middleware :3001 (dev:mock); ui-components 2.480.5; mock state not reset (shared stack)
session: sub u-farah-clone-698c3663, tenant assessment, role program-lead
screenshot: submissions-wizard.jpg
verdict: pass — walked 2026-10-24 as a clone of u-farah (program-lead); every field below was observed in this pass, none carried forward
console errors: 0 — collected from the load through every interaction below, including the empty-state probe
layout: pass — content col left 224px w 1432px; no horizontal scroll (scrollWidth 1680 vs innerWidth 1680); body scrollHeight 940 <= 940; 1 <main>; h1 "Add submissions" 20/600; breadcrumb "Assess›Submissions"
keyboard: pass — 6 really-visible controls in main; a 70-press Tab walk (page.keyboard, headless) visited 33 distinct stops (6 inside main, the rest are shell chrome); Escape leaves 0 dialogs open
empty-state: pass — "← All submissions" at step 1 returns to /assessment/submissions with 3 rows intact; disabled before a file is chosen: Parse file, Back, Next
role-gating: capabilities true: ViewAssessment, ScoreAssessment, ApproveException, PublishReport, ManageSubmissions, RunAssessmentAgent, LabelFeedback, ManageKnowledge, ManageAssessmentConfig; false: none. Steps seen: Assess› > Submissions > 1Dropfile > 2Preview&match > 3Fetchlinks > 4Runprompt; whole wizard available iff ManageSubmissions (true)
notes: Signed in as a clone (POST /api/__mock/identity/clone from u-farah, then POST /api/session/login), so the real persona's session epoch was not touched. Not exercised: writes (no run launched, no answer recorded, nothing published or saved).
