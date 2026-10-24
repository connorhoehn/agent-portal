surface: workspace
role: program-lead
user: u-farah
url: /assessment/workspace?doc=workspace_drafts%2Fstory-dim1-ci-evidence.md
audited: 2026-10-24 14:48–14:49 local, headless Chromium 1680x940 (Playwright), a fresh signed-in clone of u-farah (u-farah-clone-698c3663); Tilt stack: Vite :5183 over middleware :3001 (dev:mock); ui-components 2.480.5; mock state not reset (shared stack)
session: sub u-farah-clone-698c3663, tenant assessment, role program-lead
screenshot: workspace.jpg
verdict: pass — walked 2026-10-24 as a clone of u-farah (program-lead); every field below was observed in this pass, none carried forward
console errors: 0 — collected from the load through every interaction below, including the empty-state probe
layout: pass — content col left 200px w 1480px; explorer rail left 200px width 221px (0px from content start 200px); document pane 1259px = 85% of the content column; rail scrollHeight 847 / clientHeight 847; no horizontal scroll (scrollWidth 1680 vs innerWidth 1680); body scrollHeight 940 <= 940; 1 <main>; h1 "Workspace" 16/400; breadcrumb "Workspace›NorthstarPayments:closetheCIclaim(dimension1)"
keyboard: pass — 55 really-visible controls in main; a 70-press Tab walk (page.keyboard, headless) visited 50 distinct stops (21 inside main, the rest are shell chrome); Escape leaves 0 dialogs open; 11 tree rows in the rail; tabs ["Editor","Comments","Versions","History","Reviews","Recordings"]
empty-state: pass — /assessment/workspace?doc=page%3A99999999 keeps the explorer rail (1 rail) with no document open: "DOCUMENTS 9 VIEWS All documents 9 Recent Shared with me PRESENTATIONS View all Northstar Payments — assessment review WO"
role-gating: capabilities true: ViewAssessment, ScoreAssessment, ApproveException, PublishReport, ManageSubmissions, RunAssessmentAgent, LabelFeedback, ManageKnowledge, ManageAssessmentConfig; false: none. canvas contenteditable elements 2 (ManageKnowledge true); Outline controls 1
notes: Signed in as a clone (POST /api/__mock/identity/clone from u-farah, then POST /api/session/login), so the real persona's session epoch was not touched. Not exercised: writes (no run launched, no answer recorded, nothing published or saved).
