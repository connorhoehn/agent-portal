role: moderator
user: u-lena
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-10-08 10:58Z, Chromium (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), 1680×940, middleware dev:mock on :3001, Vite :5183
identity: sub u-lena, tenant social, role moderator, grants {"social":["moderator"]}
pipelines-tile-visible: no        # /select: tiles ["social"]; the word Pipelines appears nowhere on the page
pipelines-nav-visible: no        # rail on /social/channels: 10 anchors, 0 toward /pipelines; ⌘K "Initiatives" lists 2 commands, pipelines-page hits 0; ⌘K "Runbooks" lists 0 commands, runbook-named hits 0; ⌘K "Teams" lists 7 commands, pipelines-page hits 0; ⌘K "Pipelines" hits 0 of 7
direct-route-result: redirect     # /pipelines/runs → /social/channels (h1 “Channels”); /pipelines/runs/bot-run%3Arun-inflight-obs-e1-s3 → /social/channels (h1 “Channels”); /pipelines/configuration → /social/channels (h1 “Channels”); /pipelines/calls → /social/channels (h1 “Channels”); 0 pipeline-run section(s) rendered
api-status: 403                   # /api/pipelines/summary 403, /api/pipelines/runs 403, /api/pipelines/runs/bot-run%3Arun-inflight-obs-e1-s3 403, /api/pipelines/runs/bot-run%3Arun-inflight-obs-e1-s3/steps 403, /api/pipelines/artifacts 403; POST /api/session/tenant {pipelines} 403 (session after: u-lena/social/moderator)
events-status: 403                # GET /api/pipelines/runs/bot-run%3Arun-inflight-obs-e1-s3/events (Accept: text/event-stream), the SSE door separately
console errors: 0                  # read after /select, home, the palette queries, the bell and every direct route; the API probes go through the context's request client, outside the page console
screenshot: moderator.jpg                # /select as this identity; moderator-direct-route.jpg is where the last direct route left it
page-family-receipts: refused   # own realtime token (tenants ["social"]), 5 chat/presence frames on pipelines:run:bot-run:run-inflight-obs-e1-s3 → 5 AUTHZ_CHANNEL_DENIED (chat/subscribe:pipelines:run:bot-run:run-inflight-obs-e1-s3, presence/subscribe:pipelines:run:bot-run:run-inflight-obs-e1-s3), 0 frames naming a probed channel that were not a refusal (3 unrelated session/presence/notification frames the socket sends on its own, none naming a probed channel)
verdict: pass
notes: POST /api/session/login {userId:u-lena} → 200, then sessionStorage['orgiq.contextChosen'] set to the sub. Every field above was taken in this pass. The header bell popover reads: “Notifications9 Mark all read Clear all Unread (9) All Mira Okafor in #general Social · Message — Rail preview pipelines 1791456946144 2m ago Mira Okafor in #general Social · Message — Rail preview assessment 179145687430” (0 link(s), 0 toward /pipelines). No horizontal scroll (1680 / 1680).
