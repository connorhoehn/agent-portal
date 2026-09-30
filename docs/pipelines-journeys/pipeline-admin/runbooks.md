surface: runbooks
role: pipeline-admin
user: u-dara (Dara Whitfield)
url: /pipelines/runbooks
pages: portal/src/pages/pipelines/RunbooksPage.tsx,portal/src/pages/pipelines/useDryRun.ts,portal/src/lib/pipelineDefinitions.ts
audited: 2026-09-30 05:08Z, Chromium 148.0.7778.96 1456×958 (Playwright headless, one context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183; GET /api/session/me: sub u-dara, tenant pipelines, role pipeline-admin, grants {"pipelines":["pipeline-admin"]}
screenshot: runbooks.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1208px; no horizontal scroll (scrollWidth 1456 = innerWidth 1456); h1 "Runbooks"; first table row top 269px; one count line ("N runbooks · N with a completed dry-run") above the table
keyboard: pass — 6 really-visible focusables in main, Tab visited 6; Enter on the first focused row opened its definition (/pipelines/definitions?open=runbook%3Apromo-custodian-sg-drift); browser Back returned to /pipelines/runbooks
empty-state: pass — with the pipelines.runs fixture pinned to error (POST /api/__mock/scenario, reset afterwards, walked 2026-09-30 05:00Z before any dry-run existed) the page still lists the runbooks and names the gap: "Not every source could be read — pipeline_runs: pipeline_runs unavailable: relation does not exist." — an unreadable ledger is named, never read as "no dry-run"
role-gating: pass — pipeline-admin holds ViewPipelines, RunPipeline, ApproveStep, CancelRun, ManagePipelineConfig, ManageUsers; forbidden AuthorDefinition. Dry-run buttons in main: 3 (one per runbook, RunPipeline); no Promote, Approve or Cancel control here — promotion stays on the org workspace's ladder and is judged by rule 1.
notes: Rows as walked: Custodian revokes open security-group ingress within seconds — request an allow-list instead · Runbook · 3 · never · Needs a completed dry-run ·  | Dry-run | Pin Fargate tasks to ARM64 or eat exec format error · Proposed as a skill · promoted · 3 · never · Already a skill ·  | Dry-run | Retry the Data API through an Aurora cold start · Proposed as a skill · 3 ·  | completed | just now |  · Dry-run passed ·  | Dry-run. The dry-run is an agent_jobs row of kind runbook:dry-run on the existing queue; the fleet dispatcher claimed it and it completed in about 25 s, after which the runbook reads "Dry-run passed" (the pipeline-admin and admin walks show it completed). The middleware restarted under tsx watch between the author walk and the operator walk (another lane's edit), which re-seeds every mock fixture — so the author's dry-runs are not in this state; the operator's is.
