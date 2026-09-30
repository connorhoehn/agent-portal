role: moderator
user: u-lena
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-30 07:17Z, Chromium 1552×958 (Playwright headless from portal/node_modules, a fresh context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183 — re-walked in lane E (E5 tenants guard in the gateway, the /api/social/bindings + grant-gated POST /api/social/dms routes, /iq/runs and /pipelines/configuration routes in App.tsx and the rail/palette rows in Layout.tsx/portalCommands.ts)
identity: sub u-lena, tenant social, role moderator, grants {"social":["moderator"]}
pipelines-tile-visible: no        # /select: tiles ["social"]; the word Pipelines appears nowhere on the page
pipelines-nav-visible: no         # rail on /social/channels: 9 anchors, 0 toward /pipelines; ⌘K "Initiatives" lists 1 commands, 0 of them a pipelines page; ⌘K "Runbooks" lists 0 commands, 0 of them a pipelines page; ⌘K "Teams" lists 7 commands, 0 of them a pipelines page
direct-route-result: redirect     # /pipelines/runs → /social/channels (h1 "Channels"); /pipelines/runs/job%3Ajob-obs-maint-1 → /social/channels (h1 "Channels"); /pipelines/configuration → /social/channels (h1 "Channels") (the new pipeline-admin-only Configuration route included), no pipeline-run section rendered
api-status: 403                   # /api/pipelines/summary 403, /api/pipelines/runs 403, /api/pipelines/runs/job%3Ajob-obs-maint-1 403, /api/pipelines/runs/job%3Ajob-obs-maint-1/steps 403, /api/pipelines/artifacts 403; POST /api/session/tenant {pipelines} 403 (session after: u-lena/social/moderator)
events-status: 403                # GET /api/pipelines/runs/job%3Ajob-obs-maint-1/events (Accept: text/event-stream) — refused at the /api/pipelines mount before any SSE handler
console errors: 0                  # read after /select, home, the palette queries, the bell and every direct route; the API probes go through the context's request client, outside the page console
screenshot: moderator.jpg                # where the direct routes left this identity
verdict: pass
notes: POST /api/session/login {userId:u-lena} → 200 (the call the Sign-in-as card makes), then sessionStorage['orgiq.contextChosen'] set to the sub — what the chooser's markContextChosen() does. Every field above was re-taken this pass, not carried forward. The header bell reads “Activity, 2 unread”, popover: “Notifications2 Mark all read Clear all Unread (2) All Farah Osei in #general Social · Message — lane E isolation probe 1m ago Theo Chang in #general Social · Message — lane E isolation probe 10m ago”; no item links toward /pipelines. No horizontal scroll (1552 = 1552).
