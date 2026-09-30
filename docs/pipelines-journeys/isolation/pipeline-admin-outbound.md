role: pipeline-admin
user: u-dara
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx
audited: 2026-09-30 05:48Z, Chromium 1552×958 (Playwright headless from portal/node_modules, a fresh context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183, HEAD 0fb8eae6
identity: sub u-dara, tenant pipelines, role pipeline-admin, grants {"pipelines":["pipeline-admin"]}
other-nav-visible: no             # rail on /pipelines/runs: 10 anchors (/pipelines/definitions, /pipelines/runbooks, /pipelines/runs, /pipelines/approvals, /pipelines/artifacts, /pipelines/agents, /pipelines/bots, /pipelines/commands, /pipelines/configuration, /settings), 0 toward /iq, /admin, /assessment, /social; ⌘K "Initiatives" / "Teams" / "Channels" list 4 / 3 / 2 page commands, every one a pipelines page (fuzzy matches on its hint)
iq-route-result: redirect         # /iq/projects → /pipelines/runs (h1 "Runs"); /admin/bots/32970d0a-e28e-5100-8fb0-a5cbb87dac99 → /pipelines/runs (h1 "Runs"); /iq/runs → /iq/runs — "Page not found" (no such route in any tenant yet)
iq-api-status: 403                # /api/runs 403 (the orgiq façade under requireTenant('orgiq')), /api/bots 403, /api/graph/people?limit=1 403, /api/work/summary 403
assessment-route-result: redirect  # /assessment/teams → /pipelines/runs (h1 "Runs"); /assessment/workspace?doc=page%3A100002 → /pipelines/runs (h1 "Runs")
assessment-api-status: 403          # /api/assessment/teams 403, /api/assessment/knowledge/tree 403, /api/assessment/pipeline-runs 403
social-route-result: redirect      # /social/channels → /pipelines/runs (h1 "Runs"); /social/dms → /pipelines/runs (h1 "Runs")
social-api-status: 403              # /api/social/summary 403, /api/social/channels 403; POST /api/session/tenant {orgiq} / {assessment} / {social} 403 / 403 / 403 (session after: u-dara/pipelines/pipeline-admin)
console errors: 0                  # read after /select, home, the palette queries and every direct route; the 12 "Failed to load resource: 403" lines logged afterwards are the API probes' own answers, not the page's
screenshot: pipeline-admin-outbound.jpg   # where typing /social/channels and /social/dms leaves you
verdict: pass
notes: POST /api/session/login {userId:u-dara} → 200 (the call the Sign-in-as card makes), then sessionStorage['orgiq.contextChosen'] set to the sub — what the chooser's markContextChosen() does. The cast holds a grant only in pipelines, so sign-in lands on /pipelines/runs with no chooser stop. Re-walked 2026-09-30 05:48Z because this log's pages: digest moved: portal/src/App.tsx changed after the last seal, with c96be478 (the social channel/DM routes) and 0fb8eae6 (S2's social rooms/calls/contacts/teams/recordings/configuration routes and the pipelines definitions/runbooks/approvals/sources routes). Every field above was re-taken this pass, not carried forward. The header bell reads “Activity”, popover: “Nothing new | Activity will appear here.”. No horizontal scroll (1552 = 1552).
