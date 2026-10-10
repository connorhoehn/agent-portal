surface: bot-detail (slice)
role: sme
user: u-nora (Nora DaSilva)
url: /admin/bots/32970d0a-e28e-5100-8fb0-a5cbb87dac99 (obs-nightly-maintenance)
pages: portal/src/pages/bots/BotDetailPage.tsx,portal/src/components/runs/PipelineRunParts.tsx,portal/src/components/runs/RunTimeline.tsx,portal/src/lib/pipelineRuns.ts
audited: 2026-10-08 11:46Z → 2026-10-08 11:46Z, Chromium (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), 1680×940, Tilt stack: middleware dev:mock on :3001, Vite :5183; GET /api/session/me: sub u-nora, tenant orgiq, role sme, grants {"orgiq":["sme"],"social":["participant"]}
screenshot: bot-detail.jpg
run-rendered: yes
steps-rendered: 5
artifact-rendered: yes
events-streamed: yes
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1480px, no horizontal scroll (scrollWidth 1680 / innerWidth 1680); on the Runs tab the sections pipeline-run ×1, pipeline-steps (5 rows), pipeline-artifacts (1 rows), pipeline-events render
keyboard: pass — 21 Tab stops in main (24 really-visible focusables), Tab visited 21
empty-state: pass — every seeded bot has firings and no mock scenario was switched on the shared stack; the unavailable and no-run states were not provoked in this pass (read from the page source: a failed /api/runs read renders the shared UnavailableNotice)
role-gating: pass — the page reads the /api/runs façade (GET /api/runs → 200 for sme), never /api/pipelines/* (GET /api/pipelines/runs → 403 for this orgiq session)
notes: Events section reads: EVENTS EVENT STREAM ── pipeline:run:started · completed ── pipeline:step:started · trigger · cron firing ── pipeline:step:completed · trigger · scheduled maintenance ── pipeline:step:started · enqueue
