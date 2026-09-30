surface: approvals
role: author
user: u-ines (Ines Moreau)
url: /pipelines/approvals
pages: portal/src/pages/pipelines/ApprovalsPage.tsx,portal/src/lib/pipelineDefinitions.ts
audited: 2026-09-30 05:04Z, Chromium 148.0.7778.96 1456×958 (Playwright headless, one context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183; GET /api/session/me: sub u-ines, tenant pipelines, role author, grants {"pipelines":["author"]}
screenshot: approvals.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1208px; no horizontal scroll (scrollWidth 1456 = innerWidth 1456); h1 "Approvals"; first table row top 269px; the drawer opens at 560px over the table
keyboard: pass — 2 really-visible focusables in main, Tab visited 2; Enter on the first focused row opened the drawer ("Agent question | consult:con-mock-1 | Cut tenants over smallest-first or riskiest-first? The runbook cannot be written u…"); Escape closed it (closed)
empty-state: pass — with pipelines.definitions pinned to error (reset afterwards) the queue still lists what is waiting and names the gap: "Not every gate could be read — pipeline_definitions: pipeline_definitions unavailable: relation does not exist. Steps waiting there are missing below, not absent."
role-gating: pass — author holds ViewPipelines, AuthorDefinition, RunPipeline; forbidden ApproveStep, CancelRun, ManagePipelineConfig. Opening a waiting step shows no Approve or Reject: both are absent from the DOM, and the drawer says "Only an operator or a pipeline admin decides a step. You can see what is waiting."
notes: Waiting steps as walked: Cut tenants over smallest-first or riskiest-first? The runbook cannot be written until this is settled. · Agent question · execute · Operator (default) · 10m ago | Suppress downstream pages during a cluster-wide outage · Change gate · gate · Operator (default) · 37m ago. Each is event-catalog pipeline.approval.requested read off an existing gate — a pending lab consult (step execute), a change the policy gates held at needs_approval (step gate) — and each names the path its decision is routed to; the tenant keeps no approval store. No definition names an approver here, so every step reads "Operator (default)" (design §8).
