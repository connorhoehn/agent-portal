surface: agents
role: operator
user: u-kofi (Kofi Mensah)
url: /pipelines/agents
pages: portal/src/pages/pipelines/SourcesPage.tsx,portal/src/lib/pipelineDefinitions.ts
audited: 2026-09-30 05:08Z, Chromium 148.0.7778.96 1456×958 (Playwright headless, one context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183; GET /api/session/me: sub u-kofi, tenant pipelines, role operator, grants {"pipelines":["operator"]}
screenshot: agents.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1208px; no horizontal scroll (scrollWidth 1456 = innerWidth 1456); h1 "Agents"; first table row top 286px; one row (search · count · recorded runs) above the table
keyboard: pass — 10 really-visible focusables in main, Tab visited 10; Enter on the first focused row opened its definition (/pipelines/definitions?open=agent%3Aorgiq-advisor, drawer open); Escape closed the drawer; Back returned to the list
empty-state: pass — search "zzzz-no-such-thing" leaves the table reading "No agents match "zzzz-no-such-thing"."
role-gating: pass — operator holds ViewPipelines, RunPipeline, ApproveStep, CancelRun; forbidden AuthorDefinition, ManagePipelineConfig. Read-only for every role: the page carries a "Read-only" badge, the only buttons in main are the table's Prev/Next, and the definition a row opens offers only what the role may do (Dry-run is for runbooks, which this list does not hold).
notes: P2 re-walk — this surface was an empty state on P0 and now lists the agents from the definition registry (GET /api/pipelines/definitions?kind=…). First rows: Advisor orgiq-advisor orgiq nova-pro-v1 3 healthy 0 never / Assessment Drafter orgiq-assessment-drafter assessment nova-pro-v1 2 healthy 0 never / Assessment Scorer orgiq-assessment-scorer assessment nova-pro-v1 2 healthy 0 never. Nine agents from the fleet registry; only the supervisor has runs (its invocations carry the AG-UI run id; the sub-agents it calls fold into its runs as children), so the others read 0 / never — true, not missing.
