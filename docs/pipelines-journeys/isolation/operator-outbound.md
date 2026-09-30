role: operator
user: u-kofi
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx
audited: 2026-09-30 03:35Z, Chromium 1456×958 (Playwright headless, a fresh context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183
identity: sub u-kofi, tenant pipelines, role operator, grants {"pipelines":["operator"]}
other-nav-visible: no             # rail on /pipelines/runs: 10 anchors (/pipelines/definitions, /pipelines/runbooks, /pipelines/runs, /pipelines/approvals, /pipelines/artifacts, /pipelines/agents, /pipelines/bots, /pipelines/commands, /pipelines/configuration, /settings), 0 toward /iq, /admin, /assessment, /social; ⌘K "Initiatives" / "Teams" / "Channels" list 4 / 3 / 2 commands, every one a pipelines page (fuzzy matches on its hint)
iq-route-result: redirect         # /iq/projects → /pipelines/runs (h1 "Runs"); /admin/bots/32970d0a-e28e-5100-8fb0-a5cbb87dac99 → /pipelines/runs (h1 "Runs"); /iq/runs → /iq/runs ("Page not found" — no such route yet)
iq-api-status: 403                # /api/runs 403 and /api/runs/job%3Ajob-obs-maint-1 403 (the orgiq façade, now mounted under requireTenant('orgiq')), /api/bots 403, /api/graph/people?limit=1 403, /api/work/summary 403
assessment-route-result: redirect  # /assessment/teams → /pipelines/runs (h1 "Runs")
assessment-api-status: 403          # /api/assessment/teams 403, /api/assessment/knowledge/tree 403, /api/assessment/pipeline-runs 403
social-route-result: redirect      # /social/channels → /pipelines/runs (h1 "Runs"); /social/dms → /pipelines/runs (h1 "Runs")
social-api-status: 403              # /api/social/summary 403, /api/social/channels 403
console errors: 0                  # the 10 "Failed to load resource: 403" lines are the API probes' own answers, not the page's
screenshot: operator-outbound.jpg   # where typing /social/channels and /social/dms leaves you
verdict: pass
notes: POST /api/session/login {userId:u-kofi} → 200 (the call the Sign-in-as card makes), then sessionStorage['orgiq.contextChosen'] set to the sub — what the chooser's markContextChosen() does. The cast holds a grant only in pipelines, so sign-in lands on /pipelines/runs with no chooser stop; session after the pass is still {"sub": "u-kofi", "tenant": "pipelines", "role": "operator"}. Re-walked 2026-09-30 after lane P0's projection landed: /api/runs (the orgiq façade) now answers 403 at requireTenant('orgiq') where the previous pass saw 404 (unmounted), and /pipelines/runs/:id is a real route.
