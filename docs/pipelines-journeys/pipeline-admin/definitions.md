surface: definitions
role: pipeline-admin
user: u-dara (Dara)
url: /pipelines/definitions
pages: portal/src/pages/pipelines/DefinitionsPage.tsx,portal/src/lib/pipelineDefinitions.ts
audited: 2026-10-08 10:50Z → 2026-10-08 10:50Z, Chromium (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), 1680×940, Tilt stack: middleware dev:mock on :3001, Vite :5183
session: /api/session/me sub u-dara, tenant pipelines, role pipeline-admin, grants {"pipelines":["pipeline-admin"]}
screenshot: definitions.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1432px, top 70px, bottom 893px; no horizontal scroll (scrollWidth 1680 / innerWidth 1680); h1 “Definitions”; 1 <main>
type: title 20/600; sizes in main (size/weight×text nodes): 14/400×182, 10/600×71, 12/400×14, 12/600×10, 11/400×3, 14/500×1, 20/600×1
keyboard: pass — 29 really-visible focusables in main (28 Tab stops, the rest roving tabindex=-1 members), Tab visited 28; Enter on the first row (focus on TR) opened /pipelines/definitions?open=runbook%3Apromo-custodian-sg-drift; browser Back returned to /pipelines/definitions
empty-state: n/a — no filter value of this table produced an empty result in the live data (nothing to provoke without damaging shared state)
role-gating: pass — holds ViewPipelines, RunPipeline, ApproveStep, CancelRun, ManagePipelineConfig; forbidden AuthorDefinition. Controls in main: ["Prev","Next"]; Approve/Reject absent from the DOM, Cancel run absent, New definition absent, Configuration rail row present; invalid-body write probes (403 = refused by Cedar, anything else = past the gate, nothing written): PUT /configuration {} → 400; PUT /definitions/no-such-definition/approvers {} → 403; POST /approvals/no-such-step/decide {} → 400; POST /runs/no-such-run/cancel {} → 404
notes: Every field above was observed in this pass, not carried forward.  Main text on arrival: Catalog › Definitions Definitions What can run: every bot, assessment command, runbook and agent, with its triggers, steps and runs. Any kind Runbook Bot Assessment command Agent 35 definitions · unnamed approvers default to operator DEFINI
