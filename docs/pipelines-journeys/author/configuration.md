surface: configuration
role: author
user: u-ines (Ines Moreau)
url: /pipelines/configuration (→ /pipelines/runs)
pages: portal/src/pages/pipelines/ConfigurationPage.tsx,portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/components/shell/portalCommands.ts
audited: 2026-09-30 07:33Z, Chromium 1552×958 (Playwright headless from portal/node_modules, one context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183; GET /api/session/me: sub u-ines, tenant pipelines, role author, grants {"pipelines":["author"]} — re-walked in lane E (the page is real now and gated to pipeline-admin)
screenshot: configuration.jpg
verdict: pass
console errors: 0
layout: pass — typing /pipelines/configuration lands on /pipelines/runs (h1 “Runs”): content col left 224px w 1304px; no horizontal scroll (scrollWidth 1552 = innerWidth 1552)
keyboard: pass — no Configuration entry to reach: the rail carries 9 anchors and none is /pipelines/configuration; on the Runs page it lands on, 29 controls, 29 accept focus
empty-state: n/a — this role is not shown the page at all (decision, DEFECTS.md Closed #1)
role-gating: pass — author holds ViewPipelines, AuthorDefinition, RunPipeline; forbidden ApproveStep, CancelRun, ManagePipelineConfig. Configuration is pipeline-admin only (the separation-of-duties table): absent from the rail, absent from the palette (roles: ['pipeline-admin']), and the route redirects home (RequireRole pipeline-admin → HomeRedirect → /pipelines/runs); 0 select/Save in the DOM. The API agrees: GET /api/pipelines/configuration 200 (the default approver is shown on every Definition and Approval anyway), PUT 403
notes: The one fact of the setting this role's work depends on — who approves a step by default — reads on Definitions and Approvals as “Operator (default)”.
