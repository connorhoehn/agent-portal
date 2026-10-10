surface: activity
role: org-leader
user: u-vera (Vera Green) - GET /api/session/me on this walk: sub u-vera, tenant orgiq, role org-leader
url: /iq/distillation/activity
audited: 2026-10-08 08:15 local, headless Chromium 1680x940 (Playwright, fresh context per identity: POST /api/session/login then /role), Tilt BFF :3001 dev:mock via Vite :5183; no mock reset, no write action
screenshot: activity.jpg
pages: portal/src/pages/distillation/DistillationModule.tsx,portal/src/pages/distillation/ActivityTab.tsx,portal/src/pages/distillation/activityModel.ts,portal/src/pages/distillation/RunInspector.tsx
verdict: pass - every field below was observed on this walk
console errors: 0 (0 console.error/pageerror across load, the keyboard sweep and the empty-state step)
layout: pass - content col left 200px w 1480px; no horizontal scroll (scrollWidth 1680, innerWidth 1680); body scrollHeight 940 vs 940; 1 <main>; current item "Activity"; trail "Build››Distillation››Distillation›Activity", 1 visible h1: Compaction activity 20px/600; first-row-top: 174px (Last 24 hours7; limit 640); clipped-text sweep (strings cut with no title or aria-label ancestor): 0; 71 visible interactive controls
keyboard: pass - physical Tab (page.keyboard, headless) visited 55 distinct controls; 71 visible interactive controls in the DOM; Escape leaves 0 dialog/menu open; row "Last 24 hours7" opened /iq/distillation/activity, Escape left the URL at /iq/distillation/activity (inline inspector stays open, as before)
empty-state: pass - the Filter runs dialog opens (1 dialog; TransformationRun notes → PatternsPatterns → GuidesStatusQueuedRunningCompletedFailedRepositoryobservabilityau) and Escape leaves 0 dialog(s) open; no free-text filter exists, so a no-match state was not reachable
role-gating: org-leader: ManageBots true; in <main> 2 "Compact" button(s), 0 Agree, 0 Disagree, 0 "Record a run", 0 control(s) matching "Publish" (counted by text). Write actions (Agree/Disagree, Compact) were not exercised
notes: Walked fresh on 2026-10-08 08:15; no field was copied forward. Type-scale ledger (/iq/distillation/activity): title 20/600, 9 tracked offender(s) [scale content 10/600; scale content 11/400; scale content 13/400; scale content 13/700; scale content 17/700; scale rail 11/500; scale rail 11/600; scale rail 13/500; siblings rail 12|16]; cascade violations: none. Each run row now carries its facts as a meta line ("13 run notes → 4 patterns") and a separate "started 2h ago" line; the row button names title, meta and start in its aria-label.
