role: participant
user: u-sana
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx
audited: 2026-10-08 11:11Z, Chromium (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), 1680×940, middleware dev:mock on :3001, Vite :5183
identity: sub u-sana, tenant social, role participant, grants {"social":["participant"]}
orgiq-route-result: redirect   # /iq/projects → /social/channels (h1 “Channels”); /iq/runs → /social/channels (h1 “Channels”); /iq/search → /social/channels (h1 “Channels”)
orgiq-api-status: 403   # /api/bots 403, /api/graph/people?limit=1 403, /api/work/summary 403, /api/runs 403, /api/search?q=auth 403; POST /api/session/tenant {orgiq} 403 (session after: u-sana/social/participant)
assessment-nav-visible: no         # rail on /social/channels: 10 anchors, 0 matching /^\/assessment/; ⌘K "Teams" lists 7 commands, 0 of them a assessment page
assessment-route-result: redirect   # /assessment/teams → /social/channels (h1 “Channels”); /assessment/workspace?doc=page%3A100002 → /social/channels (h1 “Channels”)
assessment-api-status: 403   # /api/assessment/teams 403, /api/assessment/knowledge/tree 403, /api/assessment/pipeline-runs 403; POST /api/session/tenant {assessment} 403 (session after: u-sana/social/participant)
page-family-receipts: refused   # own realtime token (tenants ["social"]): 10 chat/presence frames on assessment:doc:page:100002, orgiq:initiative:p-auth-migration → 10 AUTHZ_CHANNEL_DENIED, 0 frames naming a probed channel that were not a refusal (3 unrelated session/presence/notification frames the socket sends on its own, none naming a probed channel)
console errors: 0
screenshot: participant-outbound.jpg   # where the last typed URL leaves you
verdict: pass
notes: Every field above was taken in this pass. The header bell popover reads: “Notifications9 Mark all read Clear all Unread (9) All Mira Okafor in #general Social · Message — Rail preview pipelines 1791456946144 15m ago Mira Okafor in #general Social · Message — Rail preview assessment 17914568743” (0 link(s) toward another tenant). No horizontal scroll (1680 / 1680).
orgiq-nav-visible: no         # rail on /social/channels: 10 anchors, 0 matching /^\/(iq|admin)/; ⌘K "Initiatives" lists 2 commands, 0 of them a orgiq page
