role: participant
user: u-sana
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-30 07:18Z, Chromium 1552×958 (Playwright headless from portal/node_modules, a fresh context per identity — not the shared Chrome tab), middleware dev:mock:social on :3001, Vite :5183 — re-walked in lane E (E5 tenants guard in the gateway, the /api/social/bindings + grant-gated POST /api/social/dms routes, /iq/runs and /pipelines/configuration routes in App.tsx and the rail/palette rows in Layout.tsx/portalCommands.ts)
identity: sub u-sana, tenant social, role participant, grants {"social":["participant"]}
orgiq-nav-visible: no              # rail on /social/channels: 9 anchors (/social/channels, /social/dms, /social/calls, /social/rooms, /social/contacts, /social/teams, /social/recordings, /social/configuration, /settings), 0 matching ^/(iq|admin); ⌘K "Initiatives" lists 1 commands, 0 of them a orgiq page; ⌘K "Runbooks" lists 0 commands, 0 of them a orgiq page; ⌘K "Teams" lists 7 commands, 0 of them a orgiq page
orgiq-route-result: redirect       # /iq/projects → /social/channels (h1 "Channels"); /iq/runs → /social/channels (h1 "Channels"); /iq/search → /social/channels (h1 "Channels"); /admin/bots/32970d0a-e28e-5100-8fb0-a5cbb87dac99 → /social/channels (h1 "Channels")
orgiq-api-status: 403                # /api/bots 403, /api/graph/people?limit=1 403, /api/work/summary 403, /api/runs 403, /api/search?q=auth 403; POST /api/session/tenant {orgiq} 403
assessment-nav-visible: no         # 0 anchors matching ^/assessment
assessment-route-result: redirect  # /assessment/teams → /social/channels (h1 "Channels")
assessment-api-status: 403           # /api/assessment/teams 403, /api/assessment/knowledge/tree 403, /api/assessment/pipeline-runs 403, /api/assessment/knowledge/doc/workflows/comments?id=page%3A100002 403; POST /api/session/tenant {assessment} 403
console errors: 0 — the API probes run through the context's request client, outside the page console
screenshot: participant-outbound.jpg   # where the last typed URL leaves you
verdict: pass
notes: POST /api/session/login {userId:u-sana} → 200 (the call the Sign-in-as card makes), then sessionStorage['orgiq.contextChosen'] set to the sub — what the chooser's markContextChosen() does. /iq/runs now exists (lane E, the orgiq Runs section) and still sends this session home: the /iq tree is RequireTenant orgiq. Realtime, own token (tenants ["social"]): chat join assessment:doc:page:100002 → AUTHZ_CHANNEL_DENIED (kind subscribe); presence subscribe assessment:doc:page:100002 → AUTHZ_CHANNEL_DENIED (kind subscribe); chat join orgiq:initiative:p-auth-migration → AUTHZ_CHANNEL_DENIED (kind subscribe) — E5 opens a partition only for a grant held. Session after the pass: u-sana/social/participant.
