surface: approvals
role: operator
user: u-kofi (Kofi Mensah)
url: /pipelines/approvals
pages: portal/src/pages/pipelines/ApprovalsPage.tsx,portal/src/lib/pipelineDefinitions.ts
audited: 2026-09-30 05:08Z, Chromium 148.0.7778.96 1456×958 (Playwright headless, one context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183; GET /api/session/me: sub u-kofi, tenant pipelines, role operator, grants {"pipelines":["operator"]}
screenshot: approvals.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1208px; no horizontal scroll (scrollWidth 1456 = innerWidth 1456); h1 "Approvals"; first table row top 269px; the drawer opens at 560px over the table
keyboard: pass — 1 really-visible focusables in main, Tab visited 1; Enter on the first focused row opened the drawer ("Change gate | change:9f2c17a0-5b64-4de1-8a03-6c1de4f27b58 | The policy gates require a person to approve this change bef…"); Escape closed it (closed)
empty-state: pass — with pipelines.definitions pinned to error (reset afterwards) the queue still lists what is waiting and names the gap: "Not every gate could be read — pipeline_definitions: pipeline_definitions unavailable: relation does not exist. Steps waiting there are missing below, not absent."
role-gating: pass — operator holds ViewPipelines, RunPipeline, ApproveStep, CancelRun; forbidden AuthorDefinition, ManagePipelineConfig. Opening a waiting step shows Approve and Reject in the drawer footer with a note field (ApproveStep, and the step's approver role — operator by default — is one this role satisfies).
notes: Waiting steps as walked: Suppress downstream pages during a cluster-wide outage · Change gate · gate · Operator (default) · 38m ago. Each is event-catalog pipeline.approval.requested read off an existing gate — a pending lab consult (step execute), a change the policy gates held at needs_approval (step gate) — and each names the path its decision is routed to; the tenant keeps no approval store. No definition names an approver here, so every step reads "Operator (default)" (design §8). In the first pass of this walk (05:06Z) the operator approved the agent question with a note: the consult was answered through the lab consult path ("Approved — Smallest tenants first — walked by the pipelines operator") and the queue dropped to the one change gate; this pass shows that one row, opened.
