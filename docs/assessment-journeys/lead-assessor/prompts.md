surface: prompts
role: lead-assessor
user: u-jonas
url: /assessment/prompts?doc=prompt%3Aclassify-transcript.md
audited: 2026-10-24 14:46–14:47 local, headless Chromium 1680x940 (Playwright), a fresh signed-in clone of u-jonas (u-jonas-clone-44b4272e); Tilt stack: Vite :5183 over middleware :3001 (dev:mock); ui-components 2.480.5; mock state not reset (shared stack)
session: sub u-jonas-clone-44b4272e, tenant assessment, role lead-assessor
screenshot: prompts.jpg
verdict: pass — walked 2026-10-24 as a clone of u-jonas (lead-assessor); every field below was observed in this pass, none carried forward
console errors: 0 — collected from the load through every interaction below, including the empty-state probe
layout: pass — content col left 200px w 1480px; explorer rail left 200px width 221px (0px from content start 200px); document pane 1259px = 85% of the content column; rail scrollHeight 847 / clientHeight 847; no horizontal scroll (scrollWidth 1680 vs innerWidth 1680); body scrollHeight 940 <= 940; 1 <main>; h1 "Prompts" 16/400; breadcrumb "Informatics›Prompts"
keyboard: pass — 58 really-visible controls in main; a 70-press Tab walk (page.keyboard, headless) visited 51 distinct stops (22 inside main, the rest are shell chrome); Escape leaves 0 dialogs open; 13 tree rows in the rail; tabs ["Editor","Comments 1","Versions","History","Reviews","Recordings"]
empty-state: pass — /assessment/prompts?doc=prompt%3Amissing.md keeps the explorer rail (1 rail) with no document open: "PROMPTS 9 VIEWS All documents 9 Recent Shared with me PROMPTS 9 Classify Transcript 1mo Score Dimensions 1mo Extract Ent"
role-gating: capabilities true: ViewAssessment, ScoreAssessment, ApproveException, PublishReport, ManageSubmissions, RunAssessmentAgent, LabelFeedback, ManageKnowledge; false: ManageAssessmentConfig. canvas contenteditable elements 2 (ManageKnowledge true); Outline controls 1
notes: Signed in as a clone (POST /api/__mock/identity/clone from u-jonas, then POST /api/session/login), so the real persona's session epoch was not touched. Not exercised: writes (no run launched, no answer recorded, nothing published or saved).
