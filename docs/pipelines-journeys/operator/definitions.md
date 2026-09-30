surface: definitions
role: operator
user: u-kofi (Kofi Mensah)
url: /pipelines/definitions
pages: portal/src/pages/pipelines/DefinitionsPage.tsx,portal/src/pages/pipelines/DefinitionDrawer.tsx,portal/src/pages/pipelines/useDryRun.ts,portal/src/lib/pipelineDefinitions.ts
audited: 2026-09-30 05:08Z, Chromium 148.0.7778.96 1456×958 (Playwright headless, one context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183; GET /api/session/me: sub u-kofi, tenant pipelines, role operator, grants {"pipelines":["operator"]}
screenshot: definitions.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1208px; no horizontal scroll (scrollWidth 1456 = innerWidth 1456); h1 "Definitions"; first table row top 286px; one filter row (search · kind · count · "unnamed approvers default to operator") above the table, 25 rows on the first page
keyboard: pass — 28 really-visible focusables in main, Tab visited 28; rows carry tabindex=0, Enter on the first row opened the drawer (/pipelines/definitions?open=runbook%3Apromo-custodian-sg-drift); Escape closed it (closed)
empty-state: pass — search "zzzz-no-such-thing" leaves the table reading "No definition matches this search and kind."; /pipelines/definitions?open=bot:nope renders "Definition | bot:nope | Definition not found | No definition with id bot:nope — its source may have been removed." (the one 404 the browser logs there is that deliberate probe's fetch, counted apart from the surface)
role-gating: pass — operator holds ViewPipelines, RunPipeline, ApproveStep, CancelRun; forbidden AuthorDefinition, ManagePipelineConfig. The open runbook's drawer shows Dry-run (RunPipeline); the Approvers editor is absent from the DOM (no AuthorDefinition), not disabled. No Approve, Cancel or configuration control exists on this surface.
notes: 33 definitions: 3 runbooks, 12 bots, 9 assessment commands, 9 agents — each derived from its source (lib/pipeline-definitions.ts), the nine commands recorded at v1 by the seed. Kind=Runbook narrows to 3 rows. The screenshot is the Aurora cold-start runbook opened: its three steps are its observations oldest first (Recognise / Decide / Apply), the verdict reads "Needs a completed dry-run — a skill needs a completed dry-run of runbook:promo-aurora-cold-start — start one from /pipelines/runbooks".
