role: requester
user: u-rhea (Rhea Castellanos)
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx
audited: 2026-10-13 06:47 local, Chromium 148.0.7778.96 (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), 1680x940, middleware dev:mock on :3001, Vite :5183
identity: sub u-rhea, tenant access, role requester, grants {"access":["requester"]}
other-nav-visible: no         # rail on /access/requests: 6 anchors incl. /settings, 0 matching /^\/(iq|admin|assessment|social|pipelines)/ (page-wide anchors: 7, 0 foreign); tenant switcher: "No other tenants are available for your account."; ⌘K: ⌘K 'Initiatives' lists 2 commands, 2 Access pages, 0 foreign pages; ⌘K 'Assessment' lists 4 commands, 4 Access pages, 0 foreign pages; ⌘K 'Channels' lists 4 commands, 4 Access pages, 0 foreign pages; ⌘K 'Pipelines' lists 4 commands, 4 Access pages, 0 foreign pages; ⌘K 'Teams' lists 4 commands, 4 Access pages, 0 foreign pages; ⌘K 'Runs' lists 8 commands, 7 Access pages + the shell Settings row, 0 foreign pages; header bell popover: "Nothing new Activity will appear here." (0 links); footer buttons: Messages, Demo today: Needs review. 2 ag, Huddle, Message, Device settings (the Messages panel reads “Open Social to join the conversation” as plain text with no link)
iq-route-result: redirect     # /iq/projects → /access/requests (h1 “Requests”); /iq/runs → /access/requests (h1 “Requests”); /admin/identity/users → /access/requests (h1 “Requests”)
iq-api-status: 403            # /api/graph/people?limit=1 403, /api/graph/teams 403, /api/bots 403, /api/work/summary 403; POST /api/session/tenant {orgiq} 403
assessment-route-result: redirect  # /assessment/teams → /access/requests (h1 “Requests”)
assessment-api-status: 403    # /api/assessment/summary 403, /api/assessment/teams 403; POST /api/session/tenant {assessment} 403
social-route-result: redirect # /social/channels → /access/requests (h1 “Requests”); /social/dms → /access/requests (h1 “Requests”)
social-api-status: 403        # /api/social/summary 403, /api/social/channels 403; POST /api/session/tenant {social} 403
pipelines-route-result: redirect  # /pipelines/runs → /access/requests (h1 “Requests”); /pipelines/configuration → /access/requests (h1 “Requests”)
pipelines-api-status: 403     # /api/pipelines/summary 403, /api/pipelines/runs 403; POST /api/session/tenant {pipelines} 403
console errors: 0
screenshot: requester-outbound.jpg         # /select as this identity; requester-outbound-direct-route.jpg is where the last typed URL leaves you
verdict: pass
notes: Every field above was observed in this pass. The session after every tenant switch probe is still u-rhea/access/requester. /select lists one workspace tile (Access). No horizontal scroll (scrollWidth 1680 = innerWidth 1680).
