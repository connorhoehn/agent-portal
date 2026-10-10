role: member
user: u-theo
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-10-08 10:54Z, Chromium (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), 1680×940, middleware dev:mock on :3001, Vite :5183
identity: sub u-theo, tenant orgiq, role member, grants {"orgiq":["member"],"social":["participant"]}
pipelines-tile-visible: no        # /select: tiles ["orgiq","social"]; the word Pipelines appears nowhere on the page
pipelines-nav-visible: no        # rail on /iq/projects: 13 anchors, 0 toward /pipelines; ⌘K "Initiatives" lists 11 commands, pipelines-page hits 0; ⌘K "Runbooks" lists 5 commands, runbook-named hits 1; ⌘K "Teams" lists 12 commands, pipelines-page hits 0; ⌘K "Pipelines" hits 0 of 11
direct-route-result: redirect     # /pipelines/runs → /iq/projects (h1 “My initiatives”); /pipelines/runs/bot-run%3Arun-inflight-obs-e1-s3 → /iq/projects (h1 “My initiatives”); /pipelines/configuration → /iq/projects (h1 “My initiatives”); /pipelines/calls → /iq/projects (h1 “My initiatives”); 0 pipeline-run section(s) rendered
api-status: 403                   # /api/pipelines/summary 403, /api/pipelines/runs 403, /api/pipelines/runs/bot-run%3Arun-inflight-obs-e1-s3 403, /api/pipelines/runs/bot-run%3Arun-inflight-obs-e1-s3/steps 403, /api/pipelines/artifacts 403; POST /api/session/tenant {pipelines} 403 (session after: u-theo/orgiq/member)
events-status: 403                # GET /api/pipelines/runs/bot-run%3Arun-inflight-obs-e1-s3/events (Accept: text/event-stream), the SSE door separately
console errors: 0                  # read after /select, home, the palette queries, the bell and every direct route; the API probes go through the context's request client, outside the page console
screenshot: member.jpg                # /select as this identity; member-direct-route.jpg is where the last direct route left it
page-family-receipts: refused   # own realtime token (tenants ["orgiq","social"]), 5 chat/presence frames on pipelines:run:bot-run:run-inflight-obs-e1-s3 → 5 AUTHZ_CHANNEL_DENIED (presence/subscribe:pipelines:run:bot-run:run-inflight-obs-e1-s3, chat/subscribe:pipelines:run:bot-run:run-inflight-obs-e1-s3), 0 frames naming a probed channel that were not a refusal (3 unrelated session/presence/notification frames the socket sends on its own, none naming a probed channel)
verdict: pass
notes: POST /api/session/login {userId:u-theo} → 200, then sessionStorage['orgiq.contextChosen'] set to the sub. Every field above was taken in this pass. The header bell popover reads: “Notifications5 Mark all read Clear all Unread (5) All Mira Okafor in #general Social · Message — Rail preview assessment 1791456874300 just now Mira Okafor in #general Social · Message — Rail preview org-leader 179145678” (0 link(s), 0 toward /pipelines). No horizontal scroll (1680 / 1680).
