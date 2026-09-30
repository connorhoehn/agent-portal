role: sme
user: u-nora
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-30 02:37Z → 02:37Z, Chromium 1552×958 (Playwright headless, a fresh context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183
identity: sub u-nora, tenant orgiq, role sme, grants {"orgiq":["sme"],"social":["participant"]}
pipelines-tile-visible: no        # /select: tiles ['orgiq', 'social'], role rows ['orgiq-sme', 'social-participant']
pipelines-nav-visible: no         # rail on /iq/projects: 15 anchors, 0 toward /pipelines; ⌘K "Runbooks" lists 6 commands, 0 a pipelines page
direct-route-result: redirect     # /pipelines/runs → /iq/projects (h1 "My initiatives"); /pipelines/runs/run-x → stays, renders "Page not found" (no such route yet; nothing of the tenant rendered)
api-status: 403                   # /api/pipelines/summary 403, /api/pipelines/runs 403, /api/pipelines/runs/run-x 403, /api/pipelines/runs/run-x/steps 403
events-status: 403                # GET /api/pipelines/runs/run-x/events (Accept: text/event-stream) — refused at the /api/pipelines mount before any SSE handler
console errors: 0
screenshot: sme.jpg                # where the direct routes left this identity (the last shot is /pipelines/runs/run-x)
verdict: pass
notes: POST /api/session/login {userId:u-nora} → 200 (the call the Sign-in-as card makes), then sessionStorage['orgiq.contextChosen'] set to the sub — what the chooser's markContextChosen() does. No identity outside the pipelines cast and the operator holds a pipelines grant, so no tile is offered and the tenant gate refuses every /api/pipelines path, including the not-yet-built run routes.
