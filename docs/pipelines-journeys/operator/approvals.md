surface: approvals
role: operator
user: u-kofi (Kofi)
url: /pipelines/approvals
pages: portal/src/pages/pipelines/ApprovalsPage.tsx,portal/src/lib/pipelineDefinitions.ts
audited: 2026-10-08 10:50Z → 2026-10-08 10:50Z, Chromium (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), 1680×940, Tilt stack: middleware dev:mock on :3001, Vite :5183
session: /api/session/me sub u-kofi, tenant pipelines, role operator, grants {"pipelines":["operator"]}
screenshot: approvals.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1432px, top 70px, bottom 893px; no horizontal scroll (scrollWidth 1680 / innerWidth 1680); h1 “Approvals”; 1 <main>
type: title 20/600; sizes in main (size/weight×text nodes): 14/400×7, 12/600×5, 14/500×1, 20/600×1, 11/400×1, 10/600×1
keyboard: pass — 2 really-visible focusables in main (1 Tab stops, the rest roving tabindex=-1 members), Tab visited 1; Enter on the first row opened a drawer; Escape closed it
empty-state: pass — a read-only list with no filter; /pipelines/approvals/does-not-exist renders “Runs › Approvals Page not found Nothing lives at /pipelines/approvals/does-not-e”
role-gating: pass — holds ViewPipelines, RunPipeline, ApproveStep, CancelRun; forbidden AuthorDefinition, ManagePipelineConfig. Controls in main: ["Reject","Approve"]; Approve/Reject present, Cancel run absent, New definition absent, Configuration rail row absent; opening a waiting step shows a drawer with buttons ["Reject","Approve"] reading “Change gate change:9f2c17a0-5b64-4de1-8a03-6c1de4f27b58 The policy gates require a person to approve this change before it is delivered. connorhoehnslalom/orgiq”; invalid-body write probes (403 = refused by Cedar, anything else = past the gate, nothing written): PUT /configuration {} → 403; PUT /definitions/no-such-definition/approvers {} → 403; POST /approvals/no-such-step/decide {} → 400; POST /runs/no-such-run/cancel {} → 404
notes: Every field above was observed in this pass, not carried forward.  Main text on arrival: Runs › Approvals Approvals Steps waiting on a person — a job at review, a change the gates held, an agent's question. 1 waiting WAITING STEP ASKED BY STEP APPROVED BY WAITING SINCE Suppress downstream pages during a cluster-wide outage Chan
