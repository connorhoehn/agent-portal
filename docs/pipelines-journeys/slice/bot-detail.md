surface: bot-detail (slice)
role: sme
user: u-nora (Nora DaSilva)
url: /admin/bots/32970d0a-e28e-5100-8fb0-a5cbb87dac99 (obs-nightly-maintenance)
pages: portal/src/pages/bots/BotDetailPage.tsx,portal/src/components/runs/PipelineRunParts.tsx,portal/src/components/runs/RunTimeline.tsx,portal/src/lib/pipelineRuns.ts
audited: 2026-09-30 03:36Z, Chromium 1456×958 (Playwright headless, one context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183; GET /api/session/me: sub u-nora, tenant orgiq, role sme, grants {"orgiq":["sme"],"social":["participant"]}
screenshot: bot-detail.jpg
run-rendered: yes
steps-rendered: 5
artifact-rendered: yes
events-streamed: yes
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1256px, no horizontal scroll (scrollWidth 1456 = innerWidth 1456); on the Runs tab, under the bot's own firing table (21 rows), the four sections pipeline-run, pipeline-steps, pipeline-artifacts, pipeline-events render the newest firing; the event stream card is 988px
keyboard: pass — 21 really-visible focusables in main, Tab visited 21; the run picker (a library Select, "Pipeline run") is reachable and choosing job-obs-maint-2 re-read /api/runs/job%3Ajob-obs-maint-2, /steps and /events without a reload (the header then read job:job-obs-maint-2, $0.1000, and 12 frames streamed)
empty-state: pass — every seeded bot has firings, so the empty and failed states were read from BotDetailPage.tsx rather than provoked on the shared stack (a scenario switch would have moved every other walker's world): a failed /api/runs read renders the shared UnavailableNotice (what failed, the server's line, Try again) in place of the four sections, and a bot with no runs renders none of them beside "This bot has never fired"
role-gating: pass — the page reads /api/runs (the orgiq façade, requireTenant('orgiq') + the bots read gate: org-leader, hr-admin, program-owner, or ManageBots, which sme holds), never /api/pipelines/*; the façade serves only runs whose context.tenant is orgiq
notes: The slice of research §D.4 — a maintenance bot's cron firing as a pipeline run. Run: obs-nightly-maintenance | completed | Bot | · | schedule trigger | · | started 1h ago | Run | job:job-obs-maint-1 | Definition | bot:32970d0a-e28e-5100-8fb0-a5cbb87dac99 | Workspace | o. Steps: cron firing:completed, Enqueued:completed, Claimed by a box:completed, Executed:completed, Human review:completed — bot_runs is the trigger record, agent_jobs the run, the review step is there because the bot requires review. Artifact: Transcript scheduled maintenance — completed. execute agent_jobs/job-obs-maint-1#result (the job's recorded result; no seeded change links to a run — every agent_change_requests seed row has run_id null — so a `change` artifact appears only for a governed run that captured one). Events: 12 event-catalog frames (pipeline:run:completed, pipeline:run:started, pipeline:step:completed, pipeline:step:started) over SSE: the recorded history replayed, then live dispatcher (/api/work/events) and box-tail frames for this job. Also walked as program-owner (u-mia, role switched to program-owner): same four sections, 5 steps, 12 frames, console errors 0 — screenshot bot-detail-program-owner.jpg.
