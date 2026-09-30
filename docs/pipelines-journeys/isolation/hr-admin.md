role: hr-admin
user: u-rachel
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-30 03:41Z, Chromium 1456×958 (Playwright headless, a fresh context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183
identity: sub u-rachel, tenant orgiq, role hr-admin, grants {"orgiq":["hr-admin","org-leader"],"social":["participant"]}
pipelines-tile-visible: no        # /select: tiles ['orgiq', 'social'], role rows ['orgiq-hr-admin', 'orgiq-org-leader', 'social-participant']
pipelines-nav-visible: no         # rail on /iq/projects: 21 anchors, 0 toward /pipelines; ⌘K "Runbooks" lists 11 commands, 0 a pipelines page
direct-route-result: redirect     # /pipelines/runs → /iq/projects (h1 "All initiatives"); /pipelines/runs/job%3Ajob-obs-maint-1 → /iq/projects (h1 "All initiatives", no pipeline-run section rendered)
api-status: 403                   # /api/pipelines/summary 403, /api/pipelines/runs 403, /api/pipelines/runs/job%3Ajob-obs-maint-1 403, /api/pipelines/runs/job%3Ajob-obs-maint-1/steps 403, /api/pipelines/artifacts 403
events-status: 403                # GET /api/pipelines/runs/job%3Ajob-obs-maint-1/events (Accept: text/event-stream) 403 — refused at the /api/pipelines mount before any SSE handler
console errors: 0                  # the 6 "Failed to load resource: 403" lines are the API probes' own answers, not the page's
screenshot: hr-admin.jpg                # where the direct routes left this identity (the last shot is /pipelines/runs/job%3Ajob-obs-maint-1)
verdict: pass
notes: POST /api/session/login {userId:u-rachel} → 200 (the call the Sign-in-as card makes), then sessionStorage['orgiq.contextChosen'] set to the sub — what the chooser's markContextChosen() does. Re-walked 2026-09-30 after lane P0 landed the run routes: /pipelines/runs/:id is now a real route under RequireTenant, so the direct route redirects home instead of rendering "Page not found", and the probes hit real run ids (a bot-sourced job run) rather than a made-up one. No identity outside the pipelines cast and the operator holds a pipelines grant.
