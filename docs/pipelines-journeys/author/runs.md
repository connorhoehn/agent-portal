surface: runs
role: author
user: u-ines (Ines Moreau)
url: /pipelines/runs
pages: portal/src/pages/pipelines/RunsPage.tsx,portal/src/components/runs/PipelineRunParts.tsx,portal/src/lib/pipelineRuns.ts
audited: 2026-09-30 03:30Z, Chromium 1456×958 (Playwright headless, one context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183; GET /api/session/me: sub u-ines, tenant pipelines, role author, grants {"pipelines":["author"]}
screenshot: runs.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1208px; no horizontal scroll (scrollWidth 1456 = innerWidth 1456); filter row is one line (Status · Kind · Workspace selects, then "108 runs"); first table row top 280px, 25 rows on the first page (pageSize 25, Prev/Next below); both context tenants in view (assessment, orgiq)
keyboard: pass — 29 really-visible focusables in main, Tab visited 29; Enter on the first focused row opened /pipelines/runs/assessment-run%3Arun-20260930T032422Z-score-dimensions-cc10aa77ff02; browser Back returned to /pipelines/runs
empty-state: pass — Status=failed narrows to failed runs (L1 compaction; process-self-assessment · TEAM-005; suggest-confluence-content · TEAM-004 …); Status=paused (no run is paused at a breakpoint) leaves the table reading "No run matches these filters."; a source table that cannot be read is named in a warning banner rather than read as empty (none unreadable on this pass)
role-gating: pass — author holds ViewPipelines, AuthorDefinition, RunPipeline; forbidden ApproveStep, CancelRun, ManagePipelineConfig. Buttons in main: ['Prev', 'Next']; no Approve, Cancel, New definition or configuration control exists anywhere in the DOM of this surface (P0 surfaces are reads — those controls arrive with P2). The rail shows Configuration to every pipelines role (NAV_ITEMS carries no role gate); it opens a read-only empty state with no control — recorded in DEFECTS.md for P2, where ManagePipelineConfig gives it something to gate
notes: Each row's status is pipeline-runtime's word; where the crosswalk changes what the source meant (skipped → cancelled, blocked → rejected, awaiting_review → awaiting approval) the row says "source status: …" beside it — a rename (done → completed) says nothing. Running rows are the in-flight assessment command, the governed run on Observability and the two marketplace firings; costs are what the source recorded, an em dash where none was.
