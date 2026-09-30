surface: bots
role: admin
user: u-operator (Platform Operator)
url: /pipelines/bots
pages: portal/src/pages/pipelines/SourcesPage.tsx,portal/src/lib/pipelineDefinitions.ts
audited: 2026-09-30 05:09Z, Chromium 148.0.7778.96 1456×958 (Playwright headless, one context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183; GET /api/session/me: sub u-operator, tenant pipelines, role admin, grants {"orgiq":["admin"],"assessment":["admin"],"social":["admin"],"pipelines":["admin"]}
screenshot: bots.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1208px; no horizontal scroll (scrollWidth 1456 = innerWidth 1456); h1 "Bots"; first table row top 286px; one row (search · count · recorded runs) above the table
keyboard: pass — 13 really-visible focusables in main, Tab visited 13; Enter on the first focused row opened its definition (/pipelines/definitions?open=bot%3Aa0a4b025-3e67-5004-8b8a-05a3d4f2028d, drawer open); Escape closed the drawer; Back returned to the list
empty-state: pass — search "zzzz-no-such-thing" leaves the table reading "No bots match "zzzz-no-such-thing"."
role-gating: pass — admin holds every action (the cross-tenant wildcard); forbidden nothing. Read-only for every role: the page carries a "Read-only" badge, the only buttons in main are the table's Prev/Next, and the definition a row opens offers only what the role may do (Dry-run is for runbooks, which this list does not hold).
notes: P2 re-walk — this surface was an empty state on P0 and now lists the bots from the definition registry (GET /api/pipelines/definitions?kind=…). First rows: a11y-audit-weekly paused Schedule · Manual · 0 8 * * 1 Design System v3 us.amazon.nova-lite-v1:0 4 completed 1d ago / api-contract-watch paused Schedule · Manual · 30 7 * * 1-5 Design System API us.amazon.nova-lite-v1:0 6 completed 1d ago / auth-dep-watch paused Schedule · Manual · 0 5 * * 1-5 Auth Migration us.amazon.nova-lite-v1:0 8 completed 3h ago. Twelve bots, each a definition with its cron (Schedule · Manual · <cron>), initiative and model; the seeded bots are parked, so each carries a paused chip and its firings are history.
