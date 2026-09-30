role: participant
user: u-sana
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-30 05:00Z → 05:00Z, Chromium 1552×958 (Playwright headless, a fresh context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183 — re-walked after lane S2 changed App.tsx
identity: sub u-sana, tenant social, role participant, grants {"social":["participant"]}
orgiq-nav-visible: no              # rail on /social/channels: 9 anchors (/social/channels, /social/dms, /social/calls, /social/rooms, /social/contacts, /social/teams, /social/recordings, /social/configuration, /settings), 0 matching ^/(iq|admin)
orgiq-route-result: redirect       # /iq/projects → /social/channels (h1 "Channels"); /admin/bots/b-x → /social/channels (h1 "Channels"); /iq/runs → /iq/runs (h1 "None")
orgiq-api-status: 403                # /api/bots 403, /api/graph/people?limit=1 403, /api/work/summary 403, /api/runs 403; POST /api/session/tenant {orgiq} 403
assessment-nav-visible: no         # 0 anchors matching ^/assessment
assessment-route-result: redirect  # /assessment/teams → /social/channels (h1 "Channels")
assessment-api-status: 403           # /api/assessment/teams 403, /api/assessment/knowledge/tree 403, /api/assessment/pipeline-runs 403; POST /api/session/tenant {assessment} 403
console errors: 0 — the 9 "Failed to load resource: 403" lines the walk's own API probes log are the answers under test (the *-api-status fields), counted apart
screenshot: participant-outbound.jpg   # where typing /iq/projects, /admin/bots/b-x, /iq/runs leaves you (the last shot is /iq/runs)
verdict: pass
notes: POST /api/session/login {userId:u-sana} → 200 (the call the Sign-in-as card makes), then sessionStorage['orgiq.contextChosen'] set to the sub. The cast holds a grant only in social, so sign-in lands on /social/channels with no chooser stop; session after the pass is still {"sub":"u-sana","tenant":"social","role":"participant"}.
