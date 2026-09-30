surface: run-detail
role: author
user: u-ines (Ines Moreau)
url: /pipelines/runs/agent-run%3Aa4ee74ac-a5ee-463f-a6ee-77d2a7ee7965
pages: portal/src/pages/pipelines/RunDetailPage.tsx,portal/src/pages/pipelines/runActions.ts,portal/src/components/runs/PipelineRunParts.tsx,portal/src/components/runs/RunTimeline.tsx,portal/src/lib/pipelineRuns.ts
audited: 2026-09-30 07:32Z, Chromium 1552×958 (Playwright headless from portal/node_modules, one context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183; GET /api/session/me: sub u-ines, tenant pipelines, role author, grants {"pipelines":["author"]} — re-walked in lane E (Cancel for CancelRun holders; the same page now also serves /iq/runs/:id over the orgiq façade)
screenshot: run-detail.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; no horizontal scroll (scrollWidth 1552 = innerWidth 1552); exactly 1 <main>; Run → Steps → Artifacts → Events render as four sections (pipeline-run, pipeline-steps, pipeline-artifacts, pipeline-events)
keyboard: pass — 1 focusable control in main on this finished run (the ← Runs back link), 1 accept focus; the step and artifact tables are read-only; on an open run the Cancel button joins the Tab order and its confirm dialog closes on Escape (not offered to this role)
empty-state: pass — /pipelines/runs/does-not-exist renders “Runs | Run | Run not found | No run with id does-not-exist — it may belong to a source that was pruned.” (its two 404 network lines are the probe's own answer, excluded from the count)
role-gating: pass — author holds ViewPipelines, AuthorDefinition, RunPipeline; forbidden ApproveStep, CancelRun, ManagePipelineConfig. On this finished (failed) agent run there is no Cancel for any role — a terminal run has nothing to cancel (pages/pipelines/runActions.ts `isTerminalRun`). On the open run assessment-run:run-20260930T064646Z-score-dimensions-cc10aa77ff02 (running): no Cancel button in the DOM (absent, not disabled) — this role does not hold CancelRun. Configuration is not in the rail (pipeline-admin only since lane E).
notes: Steps: STEPS 2 route route STEP STATUS STARTED ATTEMPTS DETAIL route completed 11m ago route_to_agent 1 tool call route failed 11m ago route_to_agent 1 tool call. Header: RUN Route this to the scoring agent and get PageRank for the platform team failed Agent · manual trigger · started 11m ago Run agent-run:a4ee74ac-a5ee-463f-a6ee-77d2a7ee7965 Definition agent:orgiq-supervisor Workspace orgiq Source agent trace mock-inv-2 Source
