surface: catalog
role: approver
user: u-omar (Omar Haddad, Rhea's manager)
url: /access/catalog
pages: portal/src/pages/access/CatalogPage.tsx,portal/src/pages/access/accessCollectionCommands.ts
audited: 2026-10-13 07:10–07:35 local (re-walk after the coordinator's fixes: ui-components 2.441.8 and the access fixes), Chromium 1456×940 (Playwright headless from portal/node_modules, fresh context signed in by POST /api/session/login as u-omar, not the shared Chrome tab), Vite :5183 + middleware dev:mock :3001 (shared with other lanes: another walker's policy toggles and a Rhea-filed request appeared mid-walk)
session: /api/session/me sub u-omar, tenant access, role approver, grants {"access":["approver"]}
screenshot: catalog.jpg
verdict: pass
console errors: 0 (0 on load; 0 after Filters, Request click, composer phrases)
layout: pass — content col left 200 w 1256, trail left 224 top 68 (24px gutter, first row), title 20/600 at top 111; 8 body rows all 44px one line; composer docked 841–883 (column bottom 891); no horizontal scroll (1456/1456); 1 <main>; sizes 14/400×26, 12/400×24, 12/600×10, 10/600×10, 20/600×1
keyboard: pass — 15 really-visible focusables in main, Tab visited 16 in main (incl. composer input); Escape closed the Workspace filter popover; Request icon “Request Operator in Pipelines” → /access/requests/new?item=role%3Apipelines%3Aoperator; Enter on a row opens nothing (catalog rows are not records; the Request icon is the action)
empty-state: pass — “search catalog items for zzzz” → “0 of 8 items” with “No catalog item matches this search and workspace.”; the catalog has no per-id record page
role-gating: pass — approver holds ViewAccess/RequestAccess/DecideAccess, not ManageAccessPolicy. Rail: Catalog, Requests, Approvals, Policies, Reviews, Audit, Settings (no Configuration). “You hold” and “Policy” chips read — on all 8 items (Omar holds none); sensitive chip on Org leader in Work and Lead assessor in Assessment. Probes: POST /requests {} → 400 “itemId is required”; PUT /policies/no-such {} → 403 ManageAccessPolicy; PUT /configuration {} → 403 ManageAccessPolicy; composer “approve req-0001” → “Command not recognized … No changes were made.”
notes: Composer: help lists search/show work|assessment|social|pipelines catalog items/reset filters/refresh/open; “search catalog items for pipelines” → 1 of 8; “show work catalog items” → Work, 4 of 8 (notice says “Filter: orgiq.”, the tenant key not the label); search and workspace compose; “reset filters” → 8 of 8; “open role:pipelines:operator” opens the wizard with ?item=. Escape leaves the composer's help notice on screen (a dismissible notice, not a popover). Summary now reads reviews 1.
