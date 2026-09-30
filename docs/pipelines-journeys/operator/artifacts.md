surface: artifacts
role: operator
user: u-kofi (Kofi Mensah)
url: /pipelines/artifacts
pages: portal/src/pages/pipelines/ArtifactsPage.tsx,portal/src/components/runs/PipelineRunParts.tsx,portal/src/lib/pipelineRuns.ts
audited: 2026-09-30 04:15Z, Chromium 1456×958 (Playwright headless, one context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183; GET /api/session/me: sub u-kofi, tenant pipelines, role operator, grants {"pipelines":["operator"]}
screenshot: artifacts.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1208px; no horizontal scroll (scrollWidth 1456 = innerWidth 1456); one filter row (Artifact kind select, "239 artifacts"); first table row top 280px; newest first, kinds on the first page: Trace, Transcript, Change
keyboard: pass — 27 really-visible focusables in main (kind=Trace), Tab visited 27; Enter on the first trace row opened its run (/pipelines/runs/agent-run%3A79eed77e-7aee-4911-a7ee-d45878eed5eb)
empty-state: pass — kind=Trace, empty before P1, now lists "139 artifacts" (first: Trace | Supervisor trace | agent-run:79eed77e-7aee-4911-a7ee-d45878eed5eb | completed | orgiq | 2m ago); every other kind has rows too (Change 3 artifacts, Document 17 artifacts, Scores 3 artifacts, Transcript 77 artifacts), so the filtered empty message "No artifact of this kind." was read from ArtifactsPage.tsx rather than provoked (a scenario switch would move every other walker's world)
role-gating: pass — operator holds ViewPipelines, RunPipeline, ApproveStep, CancelRun; forbidden AuthorDefinition, ManagePipelineConfig. Buttons in main: none; no Approve, Cancel, New definition or configuration control exists anywhere in the DOM of this surface (P0 surfaces are reads — those controls arrive with P2). The rail shows Configuration to every pipelines role (NAV_ITEMS carries no role gate); it opens a read-only empty state with no control — recorded in DEFECTS.md for P2, where ManagePipelineConfig gives it something to gate
notes: P1 re-walk. Every agent run files its invocation_traces row as a 'trace' artifact (the uri is the trace uuid; meta.href names /api/observability/invocations/<uuid>), and a sub-agent trace folded into a run is filed on that run too. The list now reads newest first across kinds. Changes captured outside any run the projection reads (every seeded change has run_id null) still list as "no run" with no workspace — the only artifacts a context-scoped façade does not show.
