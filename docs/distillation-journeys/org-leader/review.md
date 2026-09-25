surface: review
role: org-leader
user: u-vera (Vera Green) — GET /api/session/me after POST /api/session/role {"role":"org-leader"}: sub u-vera, tenant orgiq, role org-leader
url: /iq/distillation/review
audited: 2026-09-25 10:04 local, headless Chromium (Playwright) 1672×941 against this worktree's middleware dev:mock on :3025 and portal vite on :5197, ui-components 2.397.4 (re-walk after the one-rail-type-scale change: shell + nested rail items 13px→15px/500 on 40px rows, group headings 11px/600 caps with an SVG caret, item counts 13px plain, hints 12px; Review's GroupedList queue also moved sm→md with the same label-style group headings as Knowledge)
screenshot: review.jpg
pages: portal/src/pages/distillation/DistillationModule.tsx,portal/src/pages/distillation/ReviewTab.tsx,portal/src/pages/distillation/SourcesPanel.tsx,portal/src/pages/distillation/ExplainComposer.tsx
verdict: pass
console errors: 0
layout: pass — same one-type-scale rail as member/review.md: shell rail (0–200px) and Distillation's nested rail (200–420px) both use 15px/500 item labels on 40px rows, 11px/600 uppercase group headers with an SVG caret on 40px rows, 13px/500 plain item counts, 11px/500 plain group counts. Nested rail's current item ("Review › Pending") carries `border-left 3px rgb(99,102,241)` over `oklab(.../0.08)` = primary/8 (the shell rail's "Distillation" entry does not carry `aria-current` from this URL — same behaviour as member/review.md, unrelated to the rail typography change). Review keeps its ScopeHeader band; queue with Pending 7 / Reviewed 20 and "Find a review"; queue rows are now 15px/500 (GroupedList sm→md) with 11px/600 uppercase group headings, same as Knowledge; first-row-top: 343px (unchanged); light composer unchanged; no horizontal scroll (scrollWidth 1672 = innerWidth); exactly one `<main>`
keyboard: pass — 57 tabbable controls, all 57 accept focus (`.focus()` walk; one more than the prior 56, same +1 seen on every surface this walk)
empty-state: pass — search "zzznoexist" in Find a review reads "No matches — No sample in this list matches the search."
role-gating: org-leader still gets the note box ("Your review", Add a note about the evidence…), ✓ Agree / ✕ Disagree (measured 1 `review-agree`, 1 `review-disagree`, 1 `review-note` in the DOM, 0 `review-readonly`) — unaffected by the rail typography change
notes: Same rail-typography observations as member/review.md. Did not re-run the agree/disagree write-and-reset acceptance journey this pass (out of scope for a type-scale re-walk; last verified in the prior audit) — the controls' presence and gating were confirmed instead. Console errors 0.
