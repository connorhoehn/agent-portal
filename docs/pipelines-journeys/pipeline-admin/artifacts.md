surface: artifacts
role: pipeline-admin
user: u-dara (Dara Whitfield)
url: /pipelines/artifacts
pages: portal/src/pages/pipelines/ArtifactsPage.tsx,portal/src/components/runs/PipelineRunParts.tsx,portal/src/lib/pipelineRuns.ts
audited: 2026-09-30 03:31Z, Chromium 1456×958 (Playwright headless, one context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183; GET /api/session/me: sub u-dara, tenant pipelines, role pipeline-admin, grants {"pipelines":["pipeline-admin"]}
screenshot: artifacts.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1208px; no horizontal scroll (scrollWidth 1456 = innerWidth 1456); one filter row (Artifact kind select, "100 artifacts"); first table row top 280px; kinds on the first page: Change, Transcript
keyboard: pass — 27 really-visible focusables in main, Tab visited 27; Enter on the first scores row opened its run (/pipelines/runs/assessment-run%3Arun-20260923T033128Z-score-dimensions-9c02de11aa3f)
empty-state: pass — kind=Trace (lane P1 brings traces) leaves the table reading "No artifact of this kind."; kind=Scores lists 3 scoring logs (scoring_log_20260923T033128Z.json, scoring_log_20260925T033128Z.json, scoring_log_20260926T033128Z.json)
role-gating: pass — pipeline-admin holds the operator four plus ManagePipelineConfig and ManageUsers. Buttons in main: none; no Approve, Cancel, New definition or configuration control exists anywhere in the DOM of this surface (P0 surfaces are reads — those controls arrive with P2). Configuration in the rail is this role's to use; on this lane it is a read-only empty state
notes: Changes captured outside any run the projection reads (every seeded change has run_id null) list as "no run" with no workspace — the only artifacts a context-scoped façade does not show. Transcripts are each queue job's recorded result; documents and scores are the files an assessment command wrote.
