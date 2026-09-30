surface: agents
role: author
user: u-ines (Ines Moreau)
url: /pipelines/agents
pages: portal/src/pages/pipelines/PipelinesSurfacePage.tsx,portal/src/pages/pipelines/pipelinesSurfaces.ts
audited: 2026-09-30 03:30Z, Chromium 1456×958 (Playwright headless, one context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183; GET /api/session/me: sub u-ines, tenant pipelines, role author, grants {"pipelines":["author"]}
screenshot: agents.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1208px; no horizontal scroll (scrollWidth 1456 = innerWidth 1456); h1 "Agents", badge "Coming in lane P1", one EmptyState in the content column
keyboard: pass — 0 focusable controls in main (an empty state has none), Tab visited 0; the rail entry for the page is reachable by Tab from the shell
empty-state: pass — the page IS its empty state on this lane: "No agent runs yet | Each agent invocation becomes a run, with its steps and its trace as an artifact. | What comes next | Lane P1 carries the run id into every agent trace so each invocation lands here."
role-gating: pass — author holds ViewPipelines, AuthorDefinition, RunPipeline; forbidden ApproveStep, CancelRun, ManagePipelineConfig. Buttons in main: none; no Approve, Cancel, New definition or configuration control exists anywhere in the DOM of this surface (P0 surfaces are reads — those controls arrive with P2). The rail shows Configuration to every pipelines role (NAV_ITEMS carries no role gate); it opens a read-only empty state with no control — recorded in DEFECTS.md for P2, where ManagePipelineConfig gives it something to gate.
notes: Lane P1 carries the AG-UI run id into every trace; until then agent invocations are not runs.
