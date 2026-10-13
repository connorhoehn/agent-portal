surface: configuration
role: approver
user: u-omar (Omar Haddad, Rhea's manager)
url: /access/configuration
pages: portal/src/App.tsx,portal/src/components/shell/portalCommands.ts,portal/src/pages/access/ConfigurationPage.tsx
audited: 2026-10-13 07:10–07:35 local (re-walk after the coordinator's fixes: ui-components 2.441.8 and the access fixes), Chromium 1456×940 (Playwright headless from portal/node_modules, fresh context signed in by POST /api/session/login as u-omar, not the shared Chrome tab), Vite :5183 + middleware dev:mock :3001 (shared with other lanes: another walker's policy toggles and a Rhea-filed request appeared mid-walk)
session: /api/session/me sub u-omar, tenant access, role approver, grants {"access":["approver"]}
screenshot: configuration.jpg
verdict: pass
console errors: 0 (the redirect target loads with no console error)
layout: pass — the route redirects to /access/requests: content col left 200 w 1256, trail left 224 top 68, title 20/600 at top 111, row 44px, composer docked 841–883, no horizontal scroll (1456/1456)
keyboard: pass — on the landing, 9 really-visible focusables in main, Tab visited 10 in main; Cmd+K opens the palette and Escape closes it
empty-state: pass — /access/configuration lands on Requests; /access/configuration/stewards renders the shell's “Page not found — Nothing lives at /access/configuration/stewards”
role-gating: pass — refused in the UI three agreeing ways: 0 Configuration anchors in the rail (Catalog, Requests, Approvals, Policies, Reviews, Audit, Settings); the palette answers “configuration” with only “Open reviews — Campaigns still waiting on decisions” and no Configuration row (“access” lists Catalog, Requests, Open requests, New request, Approvals, Policies, Reviews, Open reviews, Audit, Settings, Access settings); the route redirects. API: PUT /api/access/configuration {} → 403 ManageAccessPolicy; POST → 404; PUT /api/access/catalog/role:orgiq:sme → 404; POST /api/access/provision → 404; PUT /api/access/policies/sod-001 {} → 403. GET /api/access/configuration → 200 for the approver (ViewAccess: durations, the six steward rules and the catalog item list)
notes: The approver meets Configuration as an absence in the UI, but its read endpoint answers 200 to any ViewAccess role; only the write is gated (ManageAccessPolicy). That is read-only policy data and was judged acceptable, not a failure; the Configuration page itself has no approver view.
