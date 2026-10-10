surface: agents
role: pipeline-admin
user: u-dara (Dara)
url: /pipelines/agents
pages: portal/src/pages/pipelines/AgentsPage.tsx
audited: 2026-10-08 10:49Z → 2026-10-08 10:49Z, Chromium (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), 1680×940, Tilt stack: middleware dev:mock on :3001, Vite :5183
session: /api/session/me sub u-dara, tenant pipelines, role pipeline-admin, grants {"pipelines":["pipeline-admin"]}
screenshot: agents.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1432px, top 70px, bottom 893px; no horizontal scroll (scrollWidth 1680 / innerWidth 1680); h1 “Agents”; 1 <main>
type: title 20/600; sizes in main (size/weight×text nodes): 14/400×58, 10/600×21, 12/600×9, 12/400×9, 14/600×2, 14/500×1, 20/600×1
keyboard: pass — 11 really-visible focusables in main (10 Tab stops, the rest roving tabindex=-1 members), Tab visited 10; Enter on the first row (focus on TR) opened /pipelines/definitions?open=agent%3Aorgiq-advisor; browser Back returned to /pipelines/agents
empty-state: pass — a read-only list with no filter; /pipelines/agents/does-not-exist renders “Sources › Agents Page not found Nothing lives at /pipelines/agents/does-not-exis”
role-gating: pass — holds ViewPipelines, RunPipeline, ApproveStep, CancelRun, ManagePipelineConfig; forbidden AuthorDefinition. Controls in main: []; Approve/Reject absent from the DOM, Cancel run absent, New definition absent, Configuration rail row present; invalid-body write probes (403 = refused by Cedar, anything else = past the gate, nothing written): PUT /configuration {} → 400; PUT /definitions/no-such-definition/approvers {} → 403; POST /approvals/no-such-step/decide {} → 400; POST /runs/no-such-run/cancel {} → 404
notes: Every field above was observed in this pass, not carried forward.  Main text on arrival: Sources › Agents Agents Read-only The agent fleet — every deployed agent is a definition, and each invocation that carried a run id is one of its runs. 9 agents • 105 recorded runs AGENT RUNTIME WORKSPACE MODEL TOOLS STATUS RUNS LAST RUN LA
