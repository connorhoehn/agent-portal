surface: activity
role: member
user: u-theo (Theo Chang) — GET /api/session/me on this sign-in: sub u-theo, tenant orgiq, role member
url: /iq/distillation/activity
audited: 2026-09-24 20:50–20:58 local, headless Chromium (Playwright) 1672×941 against this worktree's middleware dev:mock on :3013 (MOCK_QUEUE in-process) and portal vite on :5213, ui-components 2.389.4 (re-walk after the guide-record redesign: explorer title + scope count, no view select, crumb band in the record pane, guide body, light composer)
screenshot: activity.jpg
pages: portal/src/pages/distillation/DistillationModule.tsx,portal/src/pages/distillation/ActivityTab.tsx,portal/src/pages/distillation/RunInspector.tsx
verdict: pass
console errors: 0
layout: pass — the Distillation sub-nav rail (200–419px: Knowledge → Guides & findings 11 / Patterns 22 / Run notes N; Review → Pending 7 / Reviewed 20; Activity → Runs, red while a tier is stalled / Tier graph; the current view carries aria-current="page") beside the content col (left 420px); Activity keeps its ScopeHeader band (trail "Build › Distillation › Activity", title Activity); rail Activity → Runs current; PageHeader "Compaction activity" with the Runs | Tier graph switch and "Replica in sync"; the health line "Guide updates stalled · Last run 10h ago" with View runs →, the tier-flow strip (L1 "50m behind"); first-row-top: 437px (the first run row, "Run notes → Patterns · Completed · 13 run notes → 4 patterns"); no horizontal scroll (scrollWidth 1672 = innerWidth); exactly one <main>
keyboard: pass — 41 tabbable controls and all 41 accept focus (`.focus()` walk)
empty-state: pass — Activity has no search field; Filter runs → Status Queued + Running (nothing queued or running in the seed) reads "0 of 11 runs match the filters" and "No runs match", with the filter button showing 1 active filter
role-gating: member reads runs, the tier graph and the run inspector; no Compact L0 → L1 / L1 → L2 buttons (0 in DOM, ManageBots only)
notes: This redesign did not change Activity; walked because DistillationModule.tsx (which every surface renders through) changed. Console errors 0 (Playwright pageerror + console.error).
