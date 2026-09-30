role: member
user: u-theo
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-30 05:37Z, Chromium 1552×958 (Playwright headless from portal/node_modules, a fresh context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183, HEAD 0fb8eae6
identity: sub u-theo, tenant orgiq, role member, grants {"orgiq":["member"],"social":["participant"]}
pipelines-tile-visible: no        # /select: tiles ['orgiq', 'social'], role rows ['orgiq-member', 'social-participant']; the word Pipelines appears nowhere on the page
pipelines-nav-visible: no         # rail on /iq/projects: 13 anchors, 0 toward /pipelines; ⌘K "Runbooks" lists 5 commands, 0 a pipelines page
direct-route-result: redirect     # /pipelines/runs → /iq/projects (h1 "My initiatives"); /pipelines/runs/job%3Ajob-obs-maint-1 → /iq/projects (h1 "My initiatives"), no pipeline-run section rendered
api-status: 403                   # /api/pipelines/summary 403, /api/pipelines/runs 403, /api/pipelines/runs/job%3Ajob-obs-maint-1 403, /api/pipelines/runs/job%3Ajob-obs-maint-1/steps 403, /api/pipelines/artifacts 403; POST /api/session/tenant {pipelines} 403 (session after: u-theo/orgiq/member)
events-status: 403                # GET /api/pipelines/runs/job%3Ajob-obs-maint-1/events (Accept: text/event-stream) 403 — refused at the /api/pipelines mount before any SSE handler
console errors: 0                  # read after /select, home, the palette queries and every direct route; the 16 "Failed to load resource" lines logged afterwards are the API probes' own 403/404 answers, not the page's
screenshot: member.jpg                # where the direct routes left this identity (the last shot is /pipelines/runs/job%3Ajob-obs-maint-1)
verdict: pass
notes: POST /api/session/login {userId:u-theo} → 200 (the call the Sign-in-as card makes), then sessionStorage['orgiq.contextChosen'] set to the sub — what the chooser's markContextChosen() does. Re-walked 2026-09-30 05:37Z because this log's pages: digest moved: portal/src/App.tsx changed after the last seal, with c96be478 (the social channel/DM routes) and 0fb8eae6 (S2's social rooms/calls/contacts/teams/recordings/configuration routes and the pipelines definitions/runbooks/approvals/sources routes). Every field above was re-taken this pass, not carried forward. The header bell reads “Activity”, popover: “Nothing new | Activity will appear here.”; no item links toward /pipelines. No horizontal scroll (1552 = 1552).
