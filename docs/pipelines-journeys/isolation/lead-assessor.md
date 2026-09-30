role: lead-assessor
user: u-jonas
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-30 07:15Z, Chromium 1552×958 (Playwright headless from portal/node_modules, a fresh context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183 — re-walked in lane E (E5 tenants guard in the gateway, the /api/social/bindings + grant-gated POST /api/social/dms routes, /iq/runs and /pipelines/configuration routes in App.tsx and the rail/palette rows in Layout.tsx/portalCommands.ts)
identity: sub u-jonas, tenant assessment, role assessor, grants {"assessment":["lead-assessor","assessor"],"social":["participant"]}
pipelines-tile-visible: no        # /select: tiles ["assessment", "social"]; the word Pipelines appears nowhere on the page
pipelines-nav-visible: no         # rail on /assessment/teams: 11 anchors, 0 toward /pipelines; ⌘K "Direct messages" lists 0 commands, 0 of them a pipelines page; ⌘K "Runbooks" lists 1 commands, 0 of them a pipelines page; ⌘K "Initiatives" lists 2 commands, 0 of them a pipelines page
direct-route-result: redirect     # /pipelines/runs → /assessment/teams (h1 "Assessor's desk"); /pipelines/runs/job%3Ajob-obs-maint-1 → /assessment/teams (h1 "Assessor's desk"); /pipelines/configuration → /assessment/teams (h1 "Assessor's desk") (the new pipeline-admin-only Configuration route included), no pipeline-run section rendered
api-status: 403                   # /api/pipelines/summary 403, /api/pipelines/runs 403, /api/pipelines/runs/job%3Ajob-obs-maint-1 403, /api/pipelines/runs/job%3Ajob-obs-maint-1/steps 403, /api/pipelines/artifacts 403; POST /api/session/tenant {pipelines} 403 (session after: u-jonas/assessment/assessor)
events-status: 403                # GET /api/pipelines/runs/job%3Ajob-obs-maint-1/events (Accept: text/event-stream) — refused at the /api/pipelines mount before any SSE handler
console errors: 0                  # read after /select, home, the palette queries, the bell and every direct route; the API probes go through the context's request client, outside the page console
screenshot: lead-assessor.jpg                # where the direct routes left this identity
verdict: pass
notes: POST /api/session/login {userId:u-jonas} → 200 (the call the Sign-in-as card makes), then sessionStorage['orgiq.contextChosen'] set to the sub — what the chooser's markContextChosen() does. Every field above was re-taken this pass, not carried forward. The header bell reads “Activity”, popover: “Nothing new Activity will appear here.”; no item links toward /pipelines. No horizontal scroll (1552 = 1552).
