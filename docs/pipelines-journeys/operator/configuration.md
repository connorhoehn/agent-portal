surface: configuration
role: operator
user: u-kofi (Kofi Mensah)
url: /pipelines/configuration
pages: portal/src/pages/pipelines/ConfigurationPage.tsx,portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/components/shell/portalCommands.ts
audited: 2026-10-07 13:08Z, Chromium 148.0.7778.96 1680×940 (Playwright headless from portal/node_modules, one context per identity — not the shared Chrome tab), middleware dev:mock on :3001, Vite :5183, realtime-modules 0.115.0 (tenant Discussions keep per-reader read cursors); GET /api/session/me: sub u-kofi, tenant pipelines, role operator, grants {"pipelines":["operator"]}
screenshot: configuration.jpg
verdict: pass
console errors: 0
layout: pass — typing /pipelines/configuration lands on /pipelines/runs (h1 “Runs”): content col left 224px w 1432px; no horizontal scroll (scrollWidth 1680 = innerWidth 1680); 1 <main>
keyboard: pass — no Configuration entry to reach: the rail carries 11 anchors and none is /pipelines/configuration; on the page it lands on, 30 controls, 30 accept focus
empty-state: n/a — this role is not shown the page at all (decision, DEFECTS.md Closed #1)
role-gating: pass — operator holds ViewPipelines, RunPipeline, ApproveStep, CancelRun; forbidden AuthorDefinition, ManagePipelineConfig. Configuration is absent from the rail (11 anchors) and the route redirects home; 0 “Default approver” control / 0 Save in the DOM. API: GET /api/pipelines/configuration 200; a PUT with an out-of-range value answers 403 (refused for a role without ManagePipelineConfig)
notes: Landed on “Runs” (/pipelines/runs). The one fact of the setting this role's work depends on — who approves a step by default — reads on Definitions and Approvals as “Operator (default)”. Calls re-walk (2026-10-07, 1680x940): the rail carries /pipelines/calls and clicking it opens “Calls” (empty state “No calls yet”, 0 console errors, GET /api/calls/tenant 200); the run discussion on a run page has Chat | Pinned | Files | Calls tabs and Calls renders “No calls yet” with 0 console errors (GET /api/calls?lobby=pipelines:run:… 200, calls []).
