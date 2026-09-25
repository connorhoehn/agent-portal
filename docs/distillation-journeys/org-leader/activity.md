surface: activity
role: org-leader
user: u-vera (Vera Green) — GET /api/session/me after POST /api/session/role {"role":"org-leader"}: sub u-vera, tenant orgiq, role org-leader
url: /iq/distillation/activity
audited: 2026-09-25 10:04 local, headless Chromium (Playwright) 1672×941 against this worktree's middleware dev:mock on :3025 and portal vite on :5197, ui-components 2.397.4 (re-walk after the one-rail-type-scale change: shell + nested rail items 13px→15px/500 on 40px rows, group headings 11px/600 caps with an SVG caret, item counts 13px plain, hints 12px — this surface's own tables/graphs are unchanged, walked because DistillationModule.tsx, which every surface renders through, is on the newer rail)
screenshot: activity.jpg
pages: portal/src/pages/distillation/DistillationModule.tsx,portal/src/pages/distillation/ActivityTab.tsx,portal/src/pages/distillation/RunInspector.tsx
verdict: pass
console errors: 0
layout: pass — same one-type-scale rail as member/activity.md: shell rail (0–200px) and Distillation's nested rail (200–420px) both use 15px/500 item labels on 40px rows, 11px/600 uppercase group headers with an SVG caret on 40px rows, 13px/500 plain item counts, 11px/500 plain group counts. Nested rail's current item ("Activity › Runs") carries `border-left 3px rgb(99,102,241)` over `oklab(.../0.08)` = primary/8. Activity keeps its ScopeHeader band, PageHeader "Compaction activity" with Runs | Tier graph and "Replica in sync"; health line and tier-flow strip unchanged (library `StatStrip`/`StatusPill`, not the sub-nav rail, so untouched by the type-scale change); first-row-top: 437px (unchanged); no horizontal scroll; exactly one `<main>`
keyboard: pass — 52 tabbable controls, all 52 accept focus (`.focus()` walk; one more than the prior 51, same +1 seen on every surface this walk)
empty-state: pass — Activity has no search field; the Queued+Running filter combination was not re-run this pass (unchanged since the prior audit; re-verified for member/activity.md this walk)
role-gating: org-leader gets Compact L0 → L1 and Compact L1 → L2 (measured 2 buttons matching `/^Compact /` in the DOM this walk) beside "Replica in sync" — unaffected by the rail typography change
notes: Same rail-typography observations as member/activity.md; Activity's own content is unchanged by this work. Console errors 0 (Playwright pageerror + console.error).
