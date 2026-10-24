surface: team-scorecard
role: lead-assessor
user: u-jonas
url: /assessment/teams/TEAM-001
audited: 2026-10-24 14:42–14:43 local, headless Chromium 1680x940 (Playwright), a fresh signed-in clone of u-jonas (u-jonas-clone-44b4272e); Tilt stack: Vite :5183 over middleware :3001 (dev:mock); ui-components 2.480.5; mock state not reset (shared stack)
session: sub u-jonas-clone-44b4272e, tenant assessment, role lead-assessor
screenshot: team-scorecard.jpg
verdict: pass — walked 2026-10-24 as a clone of u-jonas (lead-assessor); every field below was observed in this pass, none carried forward
console errors: 0 — collected from the load through every interaction below, including the empty-state probe
layout: pass — content col left 44px w 1636px; no horizontal scroll (scrollWidth 1680 vs innerWidth 1680); body scrollHeight 940 <= 940; 1 <main>; h1 "Northstar Payments" 20/600; breadcrumb "Assess›Dashboard›NorthstarPayments"; 17 dimension rows carry data-verified/data-claimed and 15 confidence meters; 5 elements aria-selected/current after selecting dimension 01
keyboard: pass — 86 really-visible controls in main; a 70-press Tab walk (page.keyboard, headless) visited 41 distinct stops (28 inside main, the rest are shell chrome); Escape leaves 0 dialogs open; tabs clicked: Certification -> default; Improvement Plan -> plan; Stories -> stories; Evidence & Intake -> evidence; Documents -> documents; Activity -> activity; Team details drawer opened (1 dialog, 2 repo links) and Escape closed it (0 open)
empty-state: pass — /assessment/teams/TEAM-999 reads "Assess › Dashboard › TEAM-999 No team TEAM-999 There is no team with this id. It may have been deleted, or the link is out of date. Back to the dashboard" (the probe's own request logged 1 expected console error: Failed to load resource: the server responded with a status of 404 (Not Found))
role-gating: capabilities true: ViewAssessment, ScoreAssessment, ApproveException, PublishReport, ManageSubmissions, RunAssessmentAgent, LabelFeedback, ManageKnowledge; false: ManageAssessmentConfig. Dimension pane names its standard: "Measured against CI/CD Standards · CI on every push; a passing build before merge"
notes: Signed in as a clone (POST /api/__mock/identity/clone from u-jonas, then POST /api/session/login), so the real persona's session epoch was not touched. Not exercised: writes (no run launched, no answer recorded, nothing published or saved).
