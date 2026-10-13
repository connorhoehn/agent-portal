role: member
user: u-theo (Theo Chang)
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-10-13 16:39–16:40 local, Chromium (Playwright headless from portal/node_modules, a fresh context for this identity, not the shared Chrome tab), 1680x940, middleware dev:mock on :3001, Vite :5183, ui-components 2.442.4
identity: sub u-theo, tenant orgiq, role member, grants {"orgiq":["member"],"social":["participant"]}
access-tile-visible: no        # /select: "Workspaces 2"; the word Access appears nowhere on the page; 0 anchors toward /access; no horizontal scroll (1680/1680)
access-nav-visible: no        # rail on /iq/projects: 13 anchors, 0 toward /access (all anchors on the page: 15, 0 /access); tenant switcher menu: "So Social 1" (the 1 is a live unread badge; 0 Access entries, 0 links); ⌘K: 'Access' 18 rows, 'Requests' 13, 'Approvals' 8, 'Catalog' 10, 'Policies' 10, 'Audit' 14; none of those rows is an Access page (no "What access can be requested", "Your access requests…", "Separation-of-duties rules", "Every request transition", "Access review campaigns", "Ask for a role or a membership" or "Access settings" row); header bell popover: "Notifications 11 Unread (11) … Lena Brandt in #design-reviews, Social · Message" (0 links toward /access)
direct-route-result: redirect  # /access/requests, /access/requests/req-0001, /access/approvals, /access/catalog, /access/policies/sod-001, /access/configuration → each lands on /workspaces (h1 “Choose a workspace”); no Access record content rendered (no "SME in Work", "req-0001", "Separation-of-duties" or "Spend and allocate" text); the landing holds 0 /access anchors
api-status: 403               # GET /api/access/summary, /catalog, /requests, /requests/req-0001, /approvals, /policies, /policies/sod-001, /audit, /reviews → 403 each
write-status: 403             # POST /api/access/requests (a complete body) 403, POST /api/access/requests/req-0001/steps/1/decide {decision:approve} 403, PUT /api/access/policies/sod-001 {severity:warn} 403, POST /api/session/tenant {access} 403 (session after the tenant probe: u-theo/orgiq/member)
nothing-written: yes          # read at 16:42:51 through u-priya's session (after every isolation probe; mock last reset at 16:39:24): GET /api/access/requests?scope=all lists 6 requests whose requesters/beneficiaries are only u-rhea, u-omar and u-nora, and /api/access/audit's 15 events have actors u-rhea, u-omar, u-priya, u-nora and the system — none of u-theo, u-asha, u-sana, u-ines
console errors: 0
screenshot: member.jpg         # /select as this identity; member-direct-route.jpg is where the last direct route left it
verdict: pass
notes: Every field above was observed in this pass (the workspace chooser lists Work and Social only; still no Access tile). The only palette word matches for 'Access' are generic rows such as 'Search workspace: Access'.
