role: member
user: u-theo (Theo Chang)
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-10-13 06:47 local, Chromium 148.0.7778.96 (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), 1680x940, middleware dev:mock on :3001, Vite :5183
identity: sub u-theo, tenant orgiq, role member, grants {"orgiq":["member"],"social":["participant"]}
access-tile-visible: no        # /select: tile count 2; the word Access appears nowhere on the page; 0 anchors
access-nav-visible: no        # rail on /iq/projects: 14 anchors, 0 toward /access (all anchors on the page: 15, 0 /access); tenant switcher menu: "So Social 5" (0 Access entries, 0 links); ⌘K: ⌘K 'Access' lists 18 commands, 0 an Access page; ⌘K 'Requests' lists 13 commands, 0 an Access page; ⌘K 'Approvals' lists 8 commands, 0 an Access page; ⌘K 'Catalog' lists 10 commands, 0 an Access page; ⌘K 'Policies' lists 10 commands, 0 an Access page; ⌘K 'Audit' lists 14 commands, 0 an Access page; header bell popover: 0 links toward /access
direct-route-result: redirect  # /access/requests → /iq/projects (h1 “My initiatives”); /access/requests/req-0001 → /iq/projects (h1 “My initiatives”); /access/approvals → /iq/projects (h1 “My initiatives”); /access/catalog → /iq/projects (h1 “My initiatives”); /access/configuration → /iq/projects (h1 “My initiatives”); 0 access-* sections rendered
api-status: 403               # GET /summary 403, /catalog 403, /requests 403, /requests/req-0001 403, /approvals 403, /policies 403, /audit 403, /reviews 403
write-status: 403             # POST /api/access/requests 403, POST /api/access/requests/req-0001/steps/1/decide 403, PUT /api/access/policies/sod-001 403, POST /api/session/tenant {access} 403 (session after the tenant probe: u-theo/orgiq/member)
nothing-written: yes          # u-priya's GET /api/access/requests?scope=all stayed at 6 requests and /api/access/audit at 15 events across all four inbound walks
console errors: 0
screenshot: member.jpg         # /select as this identity; member-direct-route.jpg is where the last direct route left it
verdict: pass
notes: Every field above was observed in this pass. The one word match in ⌘K for 'Access' is the generic 'Search workspace: Access' row (and, for orgiq, 'You don’t have access to computers'), not an Access page. No horizontal scroll on the landing (scrollWidth 1680 = innerWidth 1680).
