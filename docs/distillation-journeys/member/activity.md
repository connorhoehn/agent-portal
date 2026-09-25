surface: activity
role: member
user: u-theo (Theo Chang) — GET /api/session/me on this sign-in: sub u-theo, tenant orgiq, role member
url: /iq/distillation/activity
audited: 2026-09-25 10:04 local, headless Chromium (Playwright) 1672×941 against this worktree's middleware dev:mock on :3025 and portal vite on :5197, ui-components 2.397.4 (re-walk after the one-rail-type-scale change: shell + nested rail items 13px→15px/500 on 40px rows, group headings 11px/600 caps with an SVG caret, item counts 13px plain, hints 12px — this surface's own tables/graphs are unchanged, walked because DistillationModule.tsx, which every surface renders through, is on the newer rail)
screenshot: activity.jpg
pages: portal/src/pages/distillation/DistillationModule.tsx,portal/src/pages/distillation/ActivityTab.tsx,portal/src/pages/distillation/RunInspector.tsx
verdict: pass
console errors: 0
layout: pass — shell rail (0–200px) and Distillation's nested rail (200–420px) share the one type scale (item label 15px/500 on a 40px row, group header 11px/600 uppercase caps with an SVG caret on a 40px row, item count 13px/500 plain, group count 11px/500 plain). Nested rail current item ("Activity › Runs") carries `border-left 3px rgb(99,102,241)` over `oklab(.../0.08)` = primary at 8%, same as Knowledge/Review. Activity keeps its ScopeHeader band (trail "Build › Distillation › Activity", title Activity); PageHeader "Compaction activity" with the Runs | Tier graph switch and "Replica in sync"; the health line and tier-flow strip are unchanged (still library `StatStrip`/`StatusPill`, not the sub-nav rail component, so the type-scale change does not touch them); first-row-top: 437px (unchanged); no horizontal scroll (scrollWidth 1672 = innerWidth); exactly one `<main>`
keyboard: pass — 42 tabbable controls, all 42 accept focus (`.focus()` walk; one more than the prior 41, same +1 seen on every surface this walk)
empty-state: pass — Activity has no search field; Filter runs → Status Queued + Running (nothing queued or running in the seed) still reads "0 of 11 runs match the filters" / "No runs match" with the filter button showing 1 active filter (unchanged, re-verified)
role-gating: member reads runs, the tier graph and the run inspector; no Compact L0 → L1 / L1 → L2 buttons (0 matched in the DOM this walk, ManageBots only — see org-leader/activity.md)
notes: Activity's own content did not change with the rail-type-scale work; re-walked because the shared DistillationModule.tsx frame (and the shell rail it sits inside) is now on the new scale. Console errors 0 (Playwright pageerror + console.error).
