surface: commands
role: pipeline-admin
user: u-dara (Dara Whitfield)
url: /pipelines/commands
pages: portal/src/pages/pipelines/PipelinesSurfacePage.tsx,portal/src/pages/pipelines/pipelinesSurfaces.ts
audited: 2026-09-30 03:31Z, Chromium 1456×958 (Playwright headless, one context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183; GET /api/session/me: sub u-dara, tenant pipelines, role pipeline-admin, grants {"pipelines":["pipeline-admin"]}
screenshot: commands.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1208px; no horizontal scroll (scrollWidth 1456 = innerWidth 1456); h1 "Commands", badge "Coming in lane P0", one EmptyState in the content column
keyboard: pass — 0 focusable controls in main (an empty state has none), Tab visited 0; the rail entry for the page is reachable by Tab from the shell
empty-state: pass — the page IS its empty state on this lane: "No command runs yet | Scoring and drafting commands from the assessment workspace will be listed here as runs. | What comes next | Lane P0 brings assessment commands through the run projection."
role-gating: pass — pipeline-admin holds the operator four plus ManagePipelineConfig and ManageUsers. Buttons in main: none; no Approve, Cancel, New definition or configuration control exists anywhere in the DOM of this surface (P0 surfaces are reads — those controls arrive with P2). Configuration in the rail is this role's to use; on this lane it is a read-only empty state.
notes: Assessment commands already appear as runs on /pipelines/runs (Kind = Assessment command); this Sources page is the per-producer list, still an empty state.
