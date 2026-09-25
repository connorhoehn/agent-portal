surface: review
role: member
user: u-theo (Theo Chang) — GET /api/session/me on this sign-in: sub u-theo, tenant orgiq, role member
url: /iq/distillation/review
audited: 2026-09-24 20:50–20:58 local, headless Chromium (Playwright) 1672×941 against this worktree's middleware dev:mock on :3013 (MOCK_QUEUE in-process) and portal vite on :5213, ui-components 2.389.4 (re-walk after the guide-record redesign: explorer title + scope count, no view select, crumb band in the record pane, guide body, light composer)
screenshot: review.jpg
pages: portal/src/pages/distillation/DistillationModule.tsx,portal/src/pages/distillation/ReviewTab.tsx,portal/src/pages/distillation/SourcesPanel.tsx,portal/src/pages/distillation/ExplainComposer.tsx
verdict: pass
console errors: 0
layout: pass — the Distillation sub-nav rail (200–419px: Knowledge → Guides & findings 11 / Patterns 22 / Run notes N; Review → Pending 7 / Reviewed 20; Activity → Runs, red while a tier is stalled / Tier graph; the current view carries aria-current="page") beside the content col (left 420px); Review keeps its ScopeHeader band (trail "Build › Distillation › Review", title Review, All repositories, Open Library ↗); rail Review → Pending current; queue with Pending 7 / Reviewed 20 tabs and "Find a review"; first-row-top: 344px (the first Pending row, "Cut one tenant over from SAML to Cognito · Guide · 4 notes · 4h ago"); the docked composer is now the light one (backdropTone none: Agent ▾, a "This review ▾" context menu button (aria-haspopup=menu), "Show the evidence for this finding…", Ask →), the same look as Knowledge; no horizontal scroll (scrollWidth 1672 = innerWidth); exactly one <main>
keyboard: pass — 45 tabbable controls and all 45 accept focus (`.focus()` walk)
empty-state: pass — search "zzznoexist" in Find a review reads "No matches — No sample in this list matches the search."
role-gating: member sees the queue, the claim ("Does this match the source run?"), Open this guide →, Earlier reviews and Sampling details, and a "Read-only" notice instead of the note box and Agree / Disagree (0 verdict controls in the DOM)
notes: Queue rows carry the resolved target title and type, never a bare id. Console errors 0 (Playwright pageerror + console.error across load and interactions).
