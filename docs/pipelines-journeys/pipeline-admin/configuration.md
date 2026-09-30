surface: configuration
role: pipeline-admin
user: u-dara (Dara Whitfield)
url: /pipelines/configuration
pages: portal/src/pages/pipelines/ConfigurationPage.tsx,portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/components/shell/portalCommands.ts
audited: 2026-09-30 07:37Z, Chromium 1552×958 (Playwright headless from portal/node_modules, one context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183; GET /api/session/me: sub u-dara, tenant pipelines, role pipeline-admin, grants {"pipelines":["pipeline-admin"]} — re-walked in lane E (the page is real now and gated to pipeline-admin)
screenshot: configuration.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; no horizontal scroll (scrollWidth 1552 = innerWidth 1552); h1 “Configuration”, one PageSection “Default approver” with a KeyValue (Now / Last changed by), the Select and Save
keyboard: pass — 1 enabled focusable control in main (the Default approver role select; Save is disabled until the value changes) and 1 accept focus; the rail's Configuration row is reachable by Tab from the shell
empty-state: n/a — the setting always has a value (the design default, operator, when nobody has changed it: “Nobody — the design default (operator)”); a failed read renders ErrorState “Configuration unavailable”
role-gating: pass — pipeline-admin holds ViewPipelines, RunPipeline, ApproveStep, CancelRun, ManagePipelineConfig, ManageUsers: the select and Save are rendered (Can ManagePipelineConfig); GET /api/pipelines/configuration 200, PUT (an echo-back of the current value) 200; the rail lists Configuration (10 anchors)
notes: Main: System › Configuration Configuration How this workspace decides who approves a step. Default approver Who approves a step when its definition names nobody. A definition's own approver roles always win. Now Operator Last changed by Nobody — the design default (operator) Operator Pipeline admin Save
