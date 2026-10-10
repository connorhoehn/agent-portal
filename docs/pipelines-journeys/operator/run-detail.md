surface: run-detail
role: operator
user: u-kofi (Kofi)
url: /pipelines/runs/bot-run%3Arun-inflight-obs-e1-s3
pages: portal/src/pages/pipelines/RunDetailPage.tsx,portal/src/pages/pipelines/PipelineRunLive.tsx,portal/src/components/runs/RunTimeline.tsx,portal/src/lib/pipelineRuns.ts
audited: 2026-10-08 10:49Z → 2026-10-08 10:49Z, Chromium (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), 1680×940, Tilt stack: middleware dev:mock on :3001, Vite :5183
session: /api/session/me sub u-kofi, tenant pipelines, role operator, grants {"pipelines":["operator"]}
screenshot: run-detail.jpg
verdict: pass
console errors: 0 — plus 2 expected 404 resource line(s) from the deliberate not-found probe
layout: pass — content col left 68px w 1588px, top 70px, bottom 893px; no horizontal scroll (scrollWidth 1680 / innerWidth 1680); h1 “Run”; 1 <main>; sections pipeline-run ×1, pipeline-steps ×1, pipeline-artifacts ×1, pipeline-events ×1; 3 step row(s), 1 artifact row(s); selected step marker (aria-current/selected) count 1; timeline width 1588px; page height 1226px
type: title 20/600; sizes in main (size/weight×text nodes): 11/400×20, 14/400×17, 12/600×13, 10/600×13, 12/400×12, 6/600×6, 11/500×6, 10/400×6, 13/400×5, 10/500×3, 12/500×2, 14/500×1, 20/600×1, 18/400×1
keyboard: pass — 14 really-visible focusables in main (9 Tab stops, the rest roving tabindex=-1 members), Tab visited 10;
empty-state: pass — /pipelines/runs/does-not-exist renders “Run not found No run with id does-not-exist — it may belong to a source that was pruned.”
role-gating: pass — holds ViewPipelines, RunPipeline, ApproveStep, CancelRun; forbidden AuthorDefinition, ManagePipelineConfig. Controls in main: ["Runs","Collapse header","Cancel run","Run","Activity","Run report deck","Chat","Pinned","Files","Calls","Send"]; Approve/Reject absent from the DOM, Cancel run present, New definition absent, Configuration rail row absent; invalid-body write probes (403 = refused by Cedar, anything else = past the gate, nothing written): PUT /configuration {} → 403; PUT /definitions/no-such-definition/approvers {} → 403; POST /approvals/no-such-step/decide {} → 400; POST /runs/no-such-run/cancel {} → 404
notes: Every field above was observed in this pass, not carried forward. events: EVENTS Sy System started run.started 1h ago Sy System started step.started 1h ago Sy System completed step.completed 1h ago Sy System started step.started 1h ag Main text on arrival: Pipelines › Runs › Run bot-run%… Runs Run Cancel run One run: its context, its steps, what it produced and its events. Run Activity RUN marketplace work wi-obs-e1-s3 running Agent · manual trigger · started 1h ago Run bot-run:run-inflight-o
