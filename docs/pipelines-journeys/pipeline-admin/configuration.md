surface: configuration
role: pipeline-admin
user: u-dara (Dara Whitfield)
url: /pipelines/configuration
pages: portal/src/pages/pipelines/ConfigurationPage.tsx,portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/components/shell/portalCommands.ts
audited: 2026-10-07 13:08Z, Chromium 148.0.7778.96 1680×940 (Playwright headless from portal/node_modules, one context per identity — not the shared Chrome tab), middleware dev:mock on :3001, Vite :5183, realtime-modules 0.115.0 (tenant Discussions keep per-reader read cursors); GET /api/session/me: sub u-dara, tenant pipelines, role pipeline-admin, grants {"pipelines":["pipeline-admin"]}
screenshot: configuration.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1432px; no horizontal scroll (scrollWidth 1680 = innerWidth 1680); 1 <main>; h1 “Configuration”, 1 select, 1 Save
keyboard: pass — 1 really-visible focusable control(s) in main, 1 accept focus (the Default approver select; Save is disabled until the value changes); the rail's Configuration row is reachable from the shell
empty-state: n/a — the setting always has a value (the design default, operator, when nobody has changed it); a failed read renders ErrorState “Configuration unavailable”
role-gating: pass — pipeline-admin holds ManageUsers, ViewPipelines, RunPipeline, ApproveStep, CancelRun, ManagePipelineConfig; forbidden AuthorDefinition. Configuration is rendered (1 select, 1 Save in main; rail lists 12 anchors incl. /pipelines/configuration: true). API: GET /api/pipelines/configuration 200; a PUT with an out-of-range value answers 400 (a holder gets a validation refusal, not a write)
notes: Main: System › Configuration Configuration How this workspace decides who approves a step. Default approver Who approves a step when its definition names nobody. A definition's own approver roles always win. Now Operator Last changed by Nobody — the design default (operator) Operator Pipeline admin Save Calls re-walk (2026-10-07, 1680x940): the rail carries /pipelines/calls and clicking it opens “Calls” (empty state “No calls yet”, 0 console errors, GET /api/calls/tenant 200); the run discussion on a run page has Chat | Pinned | Files | Calls tabs and Calls renders “No calls yet” with 0 console errors (GET /api/calls?lobby=pipelines:run:… 200, calls []).
