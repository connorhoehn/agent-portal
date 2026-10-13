role: participant
user: u-sana (Sana Iqbal)
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-10-13 16:01–16:05 local, Chromium (Playwright headless from portal/node_modules, a fresh context for this identity, not the shared Chrome tab), 1680x940, middleware dev:mock on :3001, Vite :5183, ui-components 2.442.3
identity: sub u-sana, tenant social, role participant, grants {"social":["participant"]}
access-tile-visible: no        # /select: "Workspaces 1"; the word Access appears nowhere on the page; 0 anchors toward /access; no horizontal scroll (1680/1680)
access-nav-visible: no        # rail on /social/channels: 10 anchors, 0 toward /access (all anchors on the page: 11, 0 /access); tenant switcher menu: "No other tenants are available for your account." (0 Access entries, 0 links); ⌘K: 'Access' 12 rows, 'Requests' 0, 'Approvals' 4, 'Catalog' 9, 'Policies' 11, 'Audit' 4; none of those rows is an Access page (no "What access can be requested", "Your access requests…", "Separation-of-duties rules", "Every request transition", "Access review campaigns", "Ask for a role or a membership" or "Access settings" row); header bell popover: "Notifications 2 Unread (2) Farah Osei sent you a message" (0 links toward /access)
direct-route-result: redirect  # /access/requests, /access/requests/req-0001, /access/approvals, /access/catalog, /access/policies/sod-001 (the new policy record page), /access/configuration → each lands on /social/channels (h1 “Channels”); 0 access-* sections rendered; the landing names no Access workspace and holds 0 /access anchors
api-status: 403               # GET /api/access/summary, /catalog, /requests, /requests/req-0001, /approvals, /policies, /policies/sod-001, /audit, /reviews → 403 each
write-status: 403             # POST /api/access/requests (a complete body) 403, POST /api/access/requests/req-0001/steps/1/decide {decision:approve} 403, PUT /api/access/policies/sod-001 {severity:warning} 403, POST /api/session/tenant {access} 403 (session after the tenant probe: u-sana/social/participant)
nothing-written: yes          # read at 16:05:08 through u-priya's curl jar: GET /api/access/requests?scope=all lists 6 requests whose requesters/beneficiaries are only u-rhea, u-omar and u-nora, and /api/access/audit's 15 events have actors u-rhea, u-omar, u-priya, u-nora and the system — none of u-theo, u-asha, u-sana, u-ines
console errors: 28 — all 502 from /api/social/{teams,rooms,calls,recordings} (this identity's own Social workspace; the Social platform-api upstream is not running on this stack); none touches /api/access
screenshot: participant.jpg         # /select as this identity; participant-direct-route.jpg is where the last direct route left it
verdict: pass
notes: Every field above was observed in this pass. The only palette word match for 'Access' is the generic 'Search workspace: Access' row (and, for orgiq, 'You don’t have access to computers').
