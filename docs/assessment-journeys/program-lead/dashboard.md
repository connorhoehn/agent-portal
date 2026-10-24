surface: dashboard
role: program-lead
user: u-farah
url: /assessment/teams
audited: 2026-10-24 14:47–14:47 local, headless Chromium 1680x940 (Playwright), a fresh signed-in clone of u-farah (u-farah-clone-698c3663); Tilt stack: Vite :5183 over middleware :3001 (dev:mock); ui-components 2.480.5; mock state not reset (shared stack)
session: sub u-farah-clone-698c3663, tenant assessment, role program-lead
screenshot: dashboard.jpg
verdict: pass — walked 2026-10-24 as a clone of u-farah (program-lead); every field below was observed in this pass, none carried forward
console errors: 0 — collected from the load through every interaction below, including the empty-state probe
layout: pass — content col left 200px w 1480px; no horizontal scroll (scrollWidth 1680 vs innerWidth 1680); body scrollHeight 940 <= 940; 1 <main>; h1 "Assessor's desk" 20/600; breadcrumb "Assess›Dashboard"; 7 table rows, first-row-top 269px
keyboard: pass — 21 really-visible controls in main; a 70-press Tab walk (page.keyboard, headless) visited 49 distinct stops (22 inside main, the rest are shell chrome); Escape leaves 0 dialogs open; opening the first team link (/assessment/teams/TEAM-005) landed on /assessment/teams/TEAM-005 and browser Back returned to /assessment/teams
empty-state: pass — searching "zzznoexist" leaves "No teams match the current filters."
role-gating: capabilities true: ViewAssessment, ScoreAssessment, ApproveException, PublishReport, ManageSubmissions, RunAssessmentAgent, LabelFeedback, ManageKnowledge, ManageAssessmentConfig; false: none. "+ New team" in main: 1; headers TEAM | LEAD | MOTION | CERTIFICATION | ASSESSED | STEP | CONTRIBUTORS | QUESTIONS | NEXT ACTION | UPDATED
notes: Signed in as a clone (POST /api/__mock/identity/clone from u-farah, then POST /api/session/login), so the real persona's session epoch was not touched. Not exercised: writes (no run launched, no answer recorded, nothing published or saved).
