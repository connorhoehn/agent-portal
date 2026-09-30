surface: runbooks
role: author
user: u-ines (Ines Moreau)
url: /pipelines/runbooks
pages: portal/src/pages/pipelines/RunbooksPage.tsx,portal/src/pages/pipelines/useDryRun.ts,portal/src/lib/pipelineDefinitions.ts
audited: 2026-09-30 05:04Z, Chromium 148.0.7778.96 1456×958 (Playwright headless, one context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183; GET /api/session/me: sub u-ines, tenant pipelines, role author, grants {"pipelines":["author"]}
screenshot: runbooks.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1208px; no horizontal scroll (scrollWidth 1456 = innerWidth 1456); h1 "Runbooks"; first table row top 269px; one count line ("N runbooks · N with a completed dry-run") above the table
keyboard: pass — 5 really-visible focusables in main, Tab visited 5; Enter on the first focused row opened its definition (/pipelines/definitions?open=runbook%3Apromo-custodian-sg-drift); browser Back returned to /pipelines/runbooks
empty-state: pass — with the pipelines.runs fixture pinned to error (POST /api/__mock/scenario, reset afterwards, walked 2026-09-30 05:00Z before any dry-run existed) the page still lists the runbooks and names the gap: "Not every source could be read — pipeline_runs: pipeline_runs unavailable: relation does not exist." — an unreadable ledger is named, never read as "no dry-run"
role-gating: pass — author holds ViewPipelines, AuthorDefinition, RunPipeline; forbidden ApproveStep, CancelRun, ManagePipelineConfig. Dry-run buttons in main: 3 (one per runbook, RunPipeline); no Promote, Approve or Cancel control here — promotion stays on the org workspace's ladder and is judged by rule 1.
notes: Rows as walked: Custodian revokes open security-group ingress within seconds — request an allow-list instead · Runbook · 3 ·  | completed | just now |  · Dry-run passed ·  | Dry-run | Pin Fargate tasks to ARM64 or eat exec format error · Proposed as a skill · promoted · 3 · never · Already a skill ·  | Dry-run | Retry the Data API through an Aurora cold start · Proposed as a skill · 3 · never · Needs a completed dry-run ·  | Dry-run. Pressing Dry-run on "Retry the Data API through an Aurora cold start" queued a governed run: the toast read "Dry-run queued job:job-d5c0e565-8696-42fc-8420-fc5bb59e597f — Brakes: run budget: none requested; allocation and envelope: the runbook names no initiative." and the row's Last dry-run turned to pending. The dry-run is an agent_jobs row of kind runbook:dry-run on the existing queue; the fleet dispatcher claimed it and it completed in about 25 s, after which the runbook reads "Dry-run passed" (the pipeline-admin and admin walks show it completed).
