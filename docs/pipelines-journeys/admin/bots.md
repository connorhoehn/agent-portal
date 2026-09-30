surface: bots
role: admin
user: u-operator (Platform Operator), entered the Pipelines workspace
url: /pipelines/bots
pages: portal/src/pages/pipelines/PipelinesSurfacePage.tsx,portal/src/pages/pipelines/pipelinesSurfaces.ts
audited: 2026-09-30 03:32Z, Chromium 1456×958 (Playwright headless, one context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183; GET /api/session/me: sub u-operator, tenant pipelines, role admin, grants {"orgiq":["admin"],"assessment":["admin"],"social":["admin"],"pipelines":["admin"]}
screenshot: bots.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1208px; no horizontal scroll (scrollWidth 1456 = innerWidth 1456); h1 "Bots", badge "Coming in lane P0", one EmptyState in the content column
keyboard: pass — 0 focusable controls in main (an empty state has none), Tab visited 0; the rail entry for the page is reachable by Tab from the shell
empty-state: pass — the page IS its empty state on this lane: "No bot runs yet | A bot firing is the trigger of a run. Its history will be listed here. | What comes next | Lane P0 brings bot firings through the run projection."
role-gating: pass — admin is the cross-tenant wildcard. Buttons in main: none; no Approve, Cancel, New definition or configuration control exists anywhere in the DOM of this surface (P0 surfaces are reads — those controls arrive with P2). Configuration in the rail is this role's to use; on this lane it is a read-only empty state.
notes: Bot firings already appear as runs on /pipelines/runs (Kind = Bot); this Sources page is the per-producer list, still an empty state on this lane.
