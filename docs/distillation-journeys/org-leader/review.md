surface: review
role: org-leader
user: u-vera (Vera Green) — GET /api/session/me after POST /api/session/role {"role":"org-leader"}: sub u-vera, tenant orgiq, role org-leader
url: /iq/distillation/review
audited: 2026-09-24 20:50–20:58 local, headless Chromium (Playwright) 1672×941 against this worktree's middleware dev:mock on :3013 (MOCK_QUEUE in-process) and portal vite on :5213, ui-components 2.389.4 (re-walk after the guide-record redesign: explorer title + scope count, no view select, crumb band in the record pane, guide body, light composer)
screenshot: review.jpg
pages: portal/src/pages/distillation/DistillationModule.tsx,portal/src/pages/distillation/ReviewTab.tsx,portal/src/pages/distillation/SourcesPanel.tsx,portal/src/pages/distillation/ExplainComposer.tsx
verdict: pass
console errors: 0
layout: pass — the Distillation sub-nav rail (200–419px: Knowledge → Guides & findings 11 / Patterns 22 / Run notes N; Review → Pending 7 / Reviewed 20; Activity → Runs, red while a tier is stalled / Tier graph; the current view carries aria-current="page") beside the content col (left 420px); Review keeps its ScopeHeader band (trail "Build › Distillation › Review", title Review, All repositories, Open Library ↗); rail Review → Pending current; queue with Pending 7 / Reviewed 20 tabs and "Find a review"; first-row-top: 344px (the first Pending row, "Cut one tenant over from SAML to Cognito · Guide · 4 notes · 4h ago"); the docked composer is now the light one (backdropTone none: Agent ▾, a "This review ▾" context menu button (aria-haspopup=menu), "Show the evidence for this finding…", Ask →), the same look as Knowledge; no horizontal scroll (scrollWidth 1672 = innerWidth); exactly one <main>
keyboard: pass — 56 tabbable controls and all 56 accept focus (`.focus()` walk)
empty-state: pass — search "zzznoexist" in Find a review reads "No matches — No sample in this list matches the search."
role-gating: org-leader gets the note box ("Your review", Add a note about the evidence…), ✓ Agree / ✕ Disagree and "This records your review; it does not publish the guide."
notes: Acceptance journey 3 walked on this build: a note + Agree on "Cut one tenant over from SAML to Cognito" (rev-027) toasted "Recorded: agree — The guide is not published by a review.", the rail went Pending 7 → 6 and Reviewed 20 → 21, and the next sample (rev-002) opened. The fixture was reset afterwards (POST /api/__mock/reset → 200). Console errors 0.
