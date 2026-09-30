surface: configuration
role: pipeline-admin
user: u-dara (Dara Whitfield)
url: /pipelines/configuration
pages: portal/src/pages/pipelines/PipelinesSurfacePage.tsx,portal/src/pages/pipelines/pipelinesSurfaces.ts
audited: 2026-09-30 03:32Z, Chromium 1456×958 (Playwright headless, one context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183; GET /api/session/me: sub u-dara, tenant pipelines, role pipeline-admin, grants {"pipelines":["pipeline-admin"]}
screenshot: configuration.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1208px; no horizontal scroll (scrollWidth 1456 = innerWidth 1456); h1 "Configuration", badge "Coming in lane P2", one EmptyState in the content column
keyboard: pass — 0 focusable controls in main (an empty state has none), Tab visited 0; the rail entry for the page is reachable by Tab from the shell
empty-state: pass — the page IS its empty state on this lane: "Nothing to configure yet | Settings appear here as the features they govern arrive. Only a pipeline admin can change them. | What comes next | Lane P2 brings approver and retention settings."
role-gating: pass — pipeline-admin holds the operator four plus ManagePipelineConfig and ManageUsers. Buttons in main: none; no Approve, Cancel, New definition or configuration control exists anywhere in the DOM of this surface (P0 surfaces are reads — those controls arrive with P2). Configuration in the rail is this role's to use; on this lane it is a read-only empty state. The copy says only a pipeline admin can change settings; no setting exists yet, so nothing here is gated for any role.
notes: Approver and retention settings are P2's.
