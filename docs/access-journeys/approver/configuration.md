surface: configuration
role: approver
user: u-omar (Omar Haddad, Rhea's manager)
url: /access/configuration
pages: portal/src/App.tsx,portal/src/components/shell/portalCommands.ts,portal/src/pages/access/ConfigurationPage.tsx
audited: 2026-10-13 06:20–06:45 local, Chromium 1456×940 (Playwright headless from portal/node_modules, fresh context signed in by POST /api/session/login as u-omar, not the shared Chrome tab), Vite :5183 + middleware dev:mock :3001 (shared with other lanes: audit event counts drifted 15→20 mid-walk from another walker's writes)
session: /api/session/me sub u-omar, tenant access, role approver, grants {"access":["approver"]}
screenshot: configuration.jpg
verdict: pass
console errors: 0 (the redirect target loads with no console error)
layout: pass — the route redirects to /access/requests, where content col left 200 w 1256, trail left 224 top 68, title 14/600 (compact PageHeader, identical to /pipelines/approvals measured the same session; the protocol's 20/600 is not what any tenant renders now) at top 115, row 44px, composer docked 841–883, no horizontal scroll (1456/1456)
keyboard: pass — on the landing, 9 really-visible focusables in main, Tab visited 10 in main; Cmd+K palette opened, Escape closed it
empty-state: pass — /access/configuration (no data of its own for approvers) lands on Requests; /access/configuration/stewards renders the shell's “Page not found — Nothing lives at /access/configuration/stewards” under a “System › Configuration” trail
role-gating: pass — refused three agreeing ways: the rail has no Configuration anchor (0 anchors; rail reads Catalog, Requests, Approvals, Policies, Reviews, Audit, Settings); the Cmd+K palette answers “configuration” with “No results.” and “access” lists Catalog, Requests, Open requests, New request, Approvals, Policies, Reviews, Audit, Settings, Access settings (no Configuration); the route redirects. Server side there is no configuration API in A1: GET, PUT and POST /api/access/configuration → 404, PUT /api/access/catalog/role:orgiq:sme → 404, POST /api/access/provision → 404, so nothing is gated by Cedar to refuse — only PUT /api/access/policies/sod-001 {} → 403 ManageAccessPolicy
notes: The approver meets Configuration only as an absence. Because the middleware has no configuration route yet, an access-admin write cannot be probed here; the refusal is purely the portal's RequireRole.
