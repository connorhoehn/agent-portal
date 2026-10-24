surface: runs
role: assessor
user: u-asha
url: /assessment/runs
audited: 2026-10-24 14:39–14:39 local, headless Chromium 1680x940 (Playwright), a fresh signed-in clone of u-asha (u-asha-clone-5a3304b1); Tilt stack: Vite :5183 over middleware :3001 (dev:mock); ui-components 2.480.5; mock state not reset (shared stack)
session: sub u-asha-clone-5a3304b1, tenant assessment, role assessor
screenshot: runs.jpg
verdict: pass — walked 2026-10-24 as a clone of u-asha (assessor); every field below was observed in this pass, none carried forward
console errors: 0 — collected from the load through every interaction below, including the empty-state probe
layout: pass — content col left 224px w 1432px; no horizontal scroll (scrollWidth 1680 vs innerWidth 1680); body scrollHeight 940 <= 940; 1 <main>; h1 "Activity" 20/600; breadcrumb "System›Activity"; 34 table rows on the page (Page 1 of 2 · 13 total), first-row-top 215px
keyboard: pass — 34 really-visible controls in main; a 70-press Tab walk (page.keyboard, headless) visited 62 distinct stops (35 inside main, the rest are shell chrome); Escape leaves 0 dialogs open
empty-state: n/a — the ledger has rows (statuses northstar payments, checkout experience, notifications service, kubernetes operator, data platform, —); nothing renders an empty state for this role
role-gating: capabilities true: ViewAssessment, ScoreAssessment, ManageSubmissions, RunAssessmentAgent, LabelFeedback; false: ApproveException, PublishReport, ManageKnowledge, ManageAssessmentConfig. Launcher "Prepare <command>" buttons: 11 (RunAssessmentAgent true); headers RUN | TEAM | STATUS | STARTED | DURATION | COMMAND | WHAT IT DOES | TOOLS | ACTIONS | RUN | STATUS | INITIATIVE | OWNER | KIND | STARTED BY | COST | STARTED
notes: Signed in as a clone (POST /api/__mock/identity/clone from u-asha, then POST /api/session/login), so the real persona's session epoch was not touched. Not exercised: writes (no run launched, no answer recorded, nothing published or saved).
