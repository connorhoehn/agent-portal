surface: runs
role: admin
user: u-operator
url: /pipelines/runs
pages: portal/src/pages/pipelines/RunsPage.tsx,portal/src/components/runs/PipelineRunParts.tsx,portal/src/lib/pipelineRuns.ts
audited: 2026-10-08 10:49Z → 2026-10-08 10:49Z, Chromium (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), 1680×940, Tilt stack: middleware dev:mock on :3001, Vite :5183
session: /api/session/me sub u-operator, tenant pipelines, role admin, grants {"orgiq":["admin"],"assessment":["admin"],"social":["admin"],"pipelines":["admin"]}
screenshot: runs.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1432px, top 70px, bottom 893px; no horizontal scroll (scrollWidth 1680 / innerWidth 1680); h1 “Runs”; 1 <main>
type: title 20/600; sizes in main (size/weight×text nodes): 14/400×128, 10/600×50, 12/400×27, 12/600×8, 11/400×3, 14/500×1, 20/600×1
keyboard: pass — 31 really-visible focusables in main (30 Tab stops, the rest roving tabindex=-1 members), Tab visited 30; Enter on the first row (focus on TR) opened /pipelines/runs/agent-run%3A79eed77e-7aee-4911-a7ee-d45878eed5eb; browser Back returned to /pipelines/runs
empty-state: pass — Status = stuck leaves “No run matches these filters.”
role-gating: pass — admin holds every action. Controls in main: ["Activity","Prev","Next"]; Approve/Reject absent from the DOM, Cancel run absent, New definition absent, Configuration rail row present; invalid-body write probes (403 = refused by Cedar, anything else = past the gate, nothing written): PUT /configuration {} → 400; PUT /definitions/no-such-definition/approvers {} → 400; POST /approvals/no-such-step/decide {} → 400; POST /runs/no-such-run/cancel {} → 404
notes: Every field above was observed in this pass, not carried forward.  Main text on arrival: Pipelines › Runs Runs Activity Every run, what it acted for, and where it stands. Any status pending running awaiting approval paused completed rejected failed cancelled stuck Any kind Bot Agent Assessment command Compaction Any workspace O
