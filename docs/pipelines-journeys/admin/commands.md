surface: commands
role: admin
user: u-operator (Platform Operator)
url: /pipelines/commands
pages: portal/src/pages/pipelines/SourcesPage.tsx,portal/src/lib/pipelineDefinitions.ts
audited: 2026-09-30 05:09Z, Chromium 148.0.7778.96 1456×958 (Playwright headless, one context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183; GET /api/session/me: sub u-operator, tenant pipelines, role admin, grants {"orgiq":["admin"],"assessment":["admin"],"social":["admin"],"pipelines":["admin"]}
screenshot: commands.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1208px; no horizontal scroll (scrollWidth 1456 = innerWidth 1456); h1 "Commands"; first table row top 286px; one row (search · count · recorded runs) above the table
keyboard: pass — 10 really-visible focusables in main, Tab visited 10; Enter on the first focused row opened its definition (/pipelines/definitions?open=assessment%3Aclassify-transcript, drawer open); Escape closed the drawer; Back returned to the list
empty-state: pass — search "zzzz-no-such-thing" leaves the table reading "No commands match "zzzz-no-such-thing"."
role-gating: pass — admin holds every action (the cross-tenant wildcard); forbidden nothing. Read-only for every role: the page carries a "Read-only" badge, the only buttons in main are the table's Prev/Next, and the definition a row opens offers only what the role may do (Dry-run is for runbooks, which this list does not hold).
notes: P2 re-walk — this surface was an empty state on P0 and now lists the commands from the definition registry (GET /api/pipelines/definitions?kind=…). First rows: classify-transcript Classify source material into evidence types and relevant dimensions. orgiq-assessment-scorer 1 completed Sep 23, 2026 / develop-jira-story Draft a story from one recommendation for human review. orgiq-assessment-drafter 1 completed 2d ago / draft-confluence-page Draft a Markdown page in the run ledger; publishing is separate. orgiq-assessment-drafter 1 completed 2d ago. The nine assessment commands, each run as the scorer or the drafter by its tools; run counts are the assessment runs the projection files under assessment:<command>.
