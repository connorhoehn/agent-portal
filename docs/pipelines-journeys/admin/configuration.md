surface: configuration
role: admin
user: u-operator (Platform Operator)
url: /pipelines/configuration
pages: portal/src/pages/pipelines/ConfigurationPage.tsx,portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/components/shell/portalCommands.ts
audited: 2026-10-07 13:08Z, Chromium 148.0.7778.96 1680×940 (Playwright headless from portal/node_modules, one context per identity — not the shared Chrome tab), middleware dev:mock on :3001, Vite :5183, realtime-modules 0.115.0 (tenant Discussions keep per-reader read cursors); GET /api/session/me: sub u-operator, tenant pipelines, role admin, grants {"orgiq":["admin"],"assessment":["admin"],"social":["admin"],"pipelines":["admin"]}
screenshot: configuration.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1432px; no horizontal scroll (scrollWidth 1680 = innerWidth 1680); 1 <main>; h1 “Configuration”, 1 select, 1 Save
keyboard: pass — 1 really-visible focusable control(s) in main, 1 accept focus (the Default approver select; Save is disabled until the value changes); the rail's Configuration row is reachable from the shell
empty-state: n/a — the setting always has a value (the design default, operator, when nobody has changed it); a failed read renders ErrorState “Configuration unavailable”
role-gating: pass — admin holds Search, ViewOrgChart, ViewLeaderboard, ViewObservability, ViewIdentityAdmin, ManageUsers, EditPolicy, EditSchema, EditGuardrail, ManageDevbox, ManageBots, DispatchAgentRun, ManageIngest, ManageKB, ManageCanary, LabelFeedback, ApproveTransaction, Masquerade, ManageBudgets, ManageSprints, EnterEnvironment, ManageEnvironments, ConnectLocalCompute, ViewAssessment, ScoreAssessment, ApproveException, PublishReport, ManageSubmissions, RunAssessmentAgent, ManageKnowledge, ManageAssessmentConfig, ViewSocial, PostMessage, StartCall, ManageChannels, ManageTeams, ManageRecordings, ManageSocialConfig, ViewPipelines, AuthorDefinition, RunPipeline, ApproveStep, CancelRun, ManagePipelineConfig; forbidden nothing. Configuration is rendered (1 select, 1 Save in main; rail lists 12 anchors incl. /pipelines/configuration: true). API: GET /api/pipelines/configuration 200; a PUT with an out-of-range value answers 400 (a holder gets a validation refusal, not a write)
notes: Main: System › Configuration Configuration How this workspace decides who approves a step. Default approver Who approves a step when its definition names nobody. A definition's own approver roles always win. Now Operator Last changed by Nobody — the design default (operator) Operator Pipeline admin Save Calls: same rail entry as the other pipelines roles; not separately re-driven as admin.
