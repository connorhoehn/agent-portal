surface: reports
role: assessor
user: u-asha
url: /assessment/reports
audited: 2026-10-24 14:39–14:39 local, headless Chromium 1680x940 (Playwright), a fresh signed-in clone of u-asha (u-asha-clone-5a3304b1); Tilt stack: Vite :5183 over middleware :3001 (dev:mock); ui-components 2.480.5; mock state not reset (shared stack)
session: sub u-asha-clone-5a3304b1, tenant assessment, role assessor
screenshot: reports.jpg
verdict: pass — walked 2026-10-24 as a clone of u-asha (assessor); every field below was observed in this pass, none carried forward
console errors: 0 — collected from the load through every interaction below, including the empty-state probe
layout: pass — content col left 224px w 1432px; no horizontal scroll (scrollWidth 1680 vs innerWidth 1680); body scrollHeight 940 <= 940; 1 <main>; h1 "Portfolio" 20/600; breadcrumb "Analyze›Reports"
keyboard: pass — 11 really-visible controls in main; a 70-press Tab walk (page.keyboard, headless) visited 40 distinct stops (13 inside main, the rest are shell chrome); Escape leaves 0 dialogs open; a column head hovered (title "Continuous Delivery (CD)"); the heatmap's first row ("Northstar Payments") opened /assessment/teams/TEAM-001 and Back returned to /assessment/reports
empty-state: n/a — the fixture has data for every team; unassessed cells render as "—" (75 in main)
role-gating: capabilities true: ViewAssessment, ScoreAssessment, ManageSubmissions, RunAssessmentAgent, LabelFeedback; false: ApproveException, PublishReport, ManageKnowledge, ManageAssessmentConfig. "Publish" buttons in DOM: 0 (PublishReport false); heatmap cells with data-verified 119 / data-claimed 119
notes: Signed in as a clone (POST /api/__mock/identity/clone from u-asha, then POST /api/session/login), so the real persona's session epoch was not touched. Not exercised: writes (no run launched, no answer recorded, nothing published or saved).
