surface: commands
role: operator
user: u-kofi (Kofi)
url: /pipelines/commands
pages: portal/src/pages/pipelines/CommandsPage.tsx
audited: 2026-10-08 10:50Z → 2026-10-08 10:50Z, Chromium (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), 1680×940, Tilt stack: middleware dev:mock on :3001, Vite :5183
session: /api/session/me sub u-kofi, tenant pipelines, role operator, grants {"pipelines":["operator"]}
screenshot: commands.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1432px, top 70px, bottom 893px; no horizontal scroll (scrollWidth 1680 / innerWidth 1680); h1 “Commands”; 1 <main>
type: title 20/600; sizes in main (size/weight×text nodes): 14/400×51, 10/600×11, 12/400×11, 12/600×6, 14/600×2, 14/500×1, 20/600×1
keyboard: pass — 13 really-visible focusables in main (12 Tab stops, the rest roving tabindex=-1 members), Tab visited 12; Enter on the first row (focus on TR) opened /pipelines/definitions?open=assessment%3Aclassify-transcript; browser Back returned to /pipelines/commands
empty-state: pass — a read-only list with no filter; /pipelines/commands/does-not-exist renders “Sources › Commands Page not found Nothing lives at /pipelines/commands/does-not-”
role-gating: pass — holds ViewPipelines, RunPipeline, ApproveStep, CancelRun; forbidden AuthorDefinition, ManagePipelineConfig. Controls in main: []; Approve/Reject absent from the DOM, Cancel run absent, New definition absent, Configuration rail row absent; invalid-body write probes (403 = refused by Cedar, anything else = past the gate, nothing written): PUT /configuration {} → 403; PUT /definitions/no-such-definition/approvers {} → 403; POST /approvals/no-such-step/decide {} → 400; POST /runs/no-such-run/cancel {} → 404
notes: Every field above was observed in this pass, not carried forward.  Main text on arrival: Sources › Commands Commands Read-only The assessment worker's commands — each is a definition, each launch one of its runs. 11 commands • 13 recorded runs COMMAND WHAT IT DOES RUNS AS RUNS LAST RUN LAST RUN AT classify-transcript Classify s
