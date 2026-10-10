role: operator
user: u-kofi
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx
audited: 2026-10-08 10:59Z, Chromium (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), 1680×940, middleware dev:mock on :3001, Vite :5183
identity: sub u-kofi, tenant pipelines, role operator, grants {"pipelines":["operator"]}
other-nav-visible: no         # rail on /pipelines/runs: 11 anchors, 0 matching /^\/(iq|admin)/; ⌘K "Initiatives" lists 4 commands, 0 of them a orgiq page
iq-route-result: redirect   # /iq/projects → /pipelines/runs (h1 “Runs”); /iq/runs → /pipelines/runs (h1 “Runs”); /iq/search → /pipelines/runs (h1 “Runs”)
iq-api-status: 403   # /api/bots 403, /api/graph/people?limit=1 403, /api/work/summary 403, /api/runs 403, /api/search?q=auth 403; POST /api/session/tenant {orgiq} 403 (session after: u-kofi/pipelines/operator)
assessment-route-result: redirect   # /assessment/teams → /pipelines/runs (h1 “Runs”); /assessment/workspace?doc=page%3A100002 → /pipelines/runs (h1 “Runs”)
assessment-api-status: 403   # /api/assessment/teams 403, /api/assessment/knowledge/tree 403, /api/assessment/pipeline-runs 403; POST /api/session/tenant {assessment} 403 (session after: u-kofi/pipelines/operator)
social-route-result: redirect   # /social/channels → /pipelines/runs (h1 “Runs”); /social/dms → /pipelines/runs (h1 “Runs”)
social-api-status: 403   # /api/social/summary 403, /api/social/channels 403, /api/social/bindings?context=initiative%3Ap-auth-migration 403; POST /api/session/tenant {social} 403 (session after: u-kofi/pipelines/operator)
page-family-receipts: refused   # own realtime token (tenants ["pipelines"]): 11 chat/presence frames on assessment:doc:page:100002, orgiq:initiative:p-auth-migration and social:ch:general → 11 AUTHZ_CHANNEL_DENIED, 0 frames naming a probed channel that were not a refusal (2 unrelated session/presence/notification frames the socket sends on its own, none naming a probed channel)
console errors: 0
screenshot: operator-outbound.jpg   # where the last typed URL leaves you
verdict: pass
notes: Every field above was taken in this pass. The header bell popover reads: “Nothing new Activity will appear here.” (0 link(s) toward another tenant). No horizontal scroll (1680 / 1680).
assessment-nav-visible: no         # rail on /pipelines/runs: 11 anchors, 0 matching /^\/assessment/; ⌘K "Teams" lists 4 commands, 1 of them a assessment page
social-nav-visible: no         # rail on /pipelines/runs: 11 anchors, 0 matching /^\/social/; ⌘K "Channels" lists 4 commands, 1 of them a social page
