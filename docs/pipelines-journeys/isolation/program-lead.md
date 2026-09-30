role: program-lead
user: u-farah
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-30 02:40Z → 02:40Z, Chromium 1552×958 (Playwright headless, a fresh context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183
identity: sub u-farah, tenant assessment, role program-lead, grants {"assessment":["program-lead","lead-assessor"],"social":["participant"]}
pipelines-tile-visible: no        # /select: tiles ['assessment', 'social'], role rows ['assessment-lead-assessor', 'assessment-program-lead', 'social-participant']
pipelines-nav-visible: no         # rail on /assessment/teams: 11 anchors, 0 toward /pipelines; ⌘K "Runbooks" lists 1 commands, 0 a pipelines page
direct-route-result: redirect     # /pipelines/runs → /assessment/teams (h1 "Assessor's desk"); /pipelines/runs/run-x → stays, renders "Page not found" (no such route yet; nothing of the tenant rendered)
api-status: 403                   # /api/pipelines/summary 403, /api/pipelines/runs 403, /api/pipelines/runs/run-x 403, /api/pipelines/runs/run-x/steps 403
events-status: 403                # GET /api/pipelines/runs/run-x/events (Accept: text/event-stream) — refused at the /api/pipelines mount before any SSE handler
console errors: 0
screenshot: program-lead.jpg                # where the direct routes left this identity (the last shot is /pipelines/runs/run-x)
verdict: pass
notes: POST /api/session/login {userId:u-farah} → 200, then POST /api/session/role {role:program-lead} → 200 (the call the Sign-in-as card makes), then sessionStorage['orgiq.contextChosen'] set to the sub — what the chooser's markContextChosen() does. No identity outside the pipelines cast and the operator holds a pipelines grant, so no tile is offered and the tenant gate refuses every /api/pipelines path, including the not-yet-built run routes.
