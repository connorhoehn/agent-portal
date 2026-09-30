surface: bot-detail (slice)
role: sme
user: u-nora (Nora DaSilva)
url: /admin/bots/32970d0a-e28e-5100-8fb0-a5cbb87dac99 (obs-nightly-maintenance)
pages: portal/src/pages/bots/BotDetailPage.tsx,portal/src/components/runs/PipelineRunParts.tsx,portal/src/components/runs/RunTimeline.tsx,portal/src/lib/pipelineRuns.ts
audited: 2026-09-30 04:15Z, Chromium 1456×958 (Playwright headless, one context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183; GET /api/session/me: sub u-nora, tenant orgiq, role sme, grants {"orgiq":["sme"],"social":["participant"]}
screenshot: bot-detail.jpg
run-rendered: yes
steps-rendered: 5
artifact-rendered: yes
events-streamed: yes
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1256px, no horizontal scroll (scrollWidth 1456 = innerWidth 1456); on the Runs tab, under the bot's own firing table, the four sections pipeline-run, pipeline-steps, pipeline-artifacts, pipeline-events render the newest firing; the event stream card is 988px
keyboard: pass — 21 Tab stops in main, Tab visited 21 (the Mission and Guardrails tabs are roving-tabindex=-1 members of the tablist, reached with the arrow keys, not Tab — the 23 matched by a plain focusable selector); the run picker (a library Select, "Pipeline run") is reachable
empty-state: pass — every seeded bot has firings, so the empty and failed states were read from BotDetailPage.tsx rather than provoked on the shared stack (a scenario switch would have moved every other walker's world): a failed /api/runs read renders the shared UnavailableNotice (what failed, the server's line, Try again) in place of the four sections, and a bot with no runs renders none of them beside "This bot has never fired"
role-gating: pass — the page reads /api/runs (the orgiq façade, requireTenant('orgiq') + the bots read gate: org-leader, hr-admin, program-owner, or ManageBots, which sme holds), never /api/pipelines/*; the façade serves only runs whose context.tenant is orgiq
notes: P1 re-walk (the shared run parts changed: the Attempts column now renders chips — named tool calls on an agent run, "attempt N" on this bot run — and the summary gains the AG-UI run row for agent runs only, absent here). Steps: cron firing | completed | 1h ago | attempt 1 | scheduled maintenance; Enqueued | completed | 1h ago | attempt 1 | by scheduler; Claimed by a box | completed | 1h ago | attempt 1 | —; Executed | completed | 1h ago | attempt 1 | —; Human review | completed | — | attempt 1 | —. Artifact: Transcript | scheduled maintenance — completed. | execute | agent_jobs/job-obs-maint-1#result. Events: 12 event-catalog frames (pipeline:run:started, pipeline:step:started, pipeline:step:completed, pipeline:run:completed) over SSE from /api/runs/…/events: the recorded history replayed. The page still reads only the /api/runs façade (context.tenant orgiq), never /api/pipelines/*.
