surface: runbooks
role: pipeline-admin
user: u-dara (Dara)
url: /pipelines/runbooks
pages: portal/src/pages/pipelines/RunbooksPage.tsx,portal/src/lib/pipelineDefinitions.ts
audited: 2026-10-08 10:50Z → 2026-10-08 10:50Z, Chromium (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), 1680×940, Tilt stack: middleware dev:mock on :3001, Vite :5183
session: /api/session/me sub u-dara, tenant pipelines, role pipeline-admin, grants {"pipelines":["pipeline-admin"]}
screenshot: runbooks.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1432px, top 70px, bottom 893px; no horizontal scroll (scrollWidth 1680 / innerWidth 1680); h1 “Runbooks”; 1 <main>
type: title 20/600; sizes in main (size/weight×text nodes): 14/400×21, 12/600×7, 10/600×3, 14/600×2, 14/500×1, 20/600×1
keyboard: pass — 7 really-visible focusables in main (6 Tab stops, the rest roving tabindex=-1 members), Tab visited 6; Enter on the first row (focus on TR) opened /pipelines/definitions?open=runbook%3Apromo-custodian-sg-drift; browser Back returned to /pipelines/runbooks
empty-state: pass — a read-only list with no filter; /pipelines/runbooks/does-not-exist renders “Catalog › Runbooks Page not found Nothing lives at /pipelines/runbooks/does-not-”
role-gating: pass — holds ViewPipelines, RunPipeline, ApproveStep, CancelRun, ManagePipelineConfig; forbidden AuthorDefinition. Controls in main: ["Dry-run Custodian revokes open s","Dry-run Pin Fargate tasks to ARM","Dry-run Retry the Data API throu"]; Approve/Reject absent from the DOM, Cancel run absent, New definition absent, Configuration rail row present; invalid-body write probes (403 = refused by Cedar, anything else = past the gate, nothing written): PUT /configuration {} → 400; PUT /definitions/no-such-definition/approvers {} → 403; POST /approvals/no-such-step/decide {} → 400; POST /runs/no-such-run/cancel {} → 404
notes: Every field above was observed in this pass, not carried forward.  Main text on arrival: Catalog › Runbooks Runbooks Runbooks on their way to becoming skills. A runbook becomes a skill only after a completed dry-run of its own definition. 3 runbooks • 0 with a completed dry-run RUNBOOK RUNG STEPS LAST DRY-RUN DRY-RUN AT PROMOTI
