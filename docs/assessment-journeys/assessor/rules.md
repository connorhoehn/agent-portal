surface: rules
role: assessor
user: u-asha
url: /assessment/rules?doc=rule%3Ascoring-guardrails.md
audited: 2026-10-24 14:41–14:41 local, headless Chromium 1680x940 (Playwright), a fresh signed-in clone of u-asha (u-asha-clone-5a3304b1); Tilt stack: Vite :5183 over middleware :3001 (dev:mock); ui-components 2.480.5; mock state not reset (shared stack)
session: sub u-asha-clone-5a3304b1, tenant assessment, role assessor
screenshot: rules.jpg
verdict: pass — walked 2026-10-24 as a clone of u-asha (assessor); every field below was observed in this pass, none carried forward
console errors: 0 — collected from the load through every interaction below, including the empty-state probe
layout: pass — content col left 200px w 1480px; explorer rail left 200px width 221px (0px from content start 200px); document pane 1259px = 85% of the content column; rail scrollHeight 847 / clientHeight 847; no horizontal scroll (scrollWidth 1680 vs innerWidth 1680); body scrollHeight 940 <= 940; 1 <main>; h1 "Rules" 16/400; breadcrumb "Informatics›Rules"
keyboard: pass — 27 really-visible controls in main; a 70-press Tab walk (page.keyboard, headless) visited 45 distinct stops (17 inside main, the rest are shell chrome); Escape leaves 0 dialogs open; 8 tree rows in the rail; tabs ["Editor","Comments","Versions","History","Reviews","Recordings"]
empty-state: pass — /assessment/rules?doc=rule%3Amissing.md keeps the explorer rail (1 rail) with no document open: "RULES 4 VIEWS All documents 4 Recent Shared with me RULES 4 Scoring Guardrails 9h What Counts as Evidence 1mo Evidence C"
role-gating: capabilities true: ViewAssessment, ScoreAssessment, ManageSubmissions, RunAssessmentAgent, LabelFeedback; false: ApproveException, PublishReport, ManageKnowledge, ManageAssessmentConfig. canvas contenteditable elements 1 (ManageKnowledge false); Outline controls 1
notes: Signed in as a clone (POST /api/__mock/identity/clone from u-asha, then POST /api/session/login), so the real persona's session epoch was not touched. Not exercised: writes (no run launched, no answer recorded, nothing published or saved).
