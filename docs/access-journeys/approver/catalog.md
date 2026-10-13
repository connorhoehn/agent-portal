surface: catalog
role: approver
user: u-omar (Omar Haddad, Rhea's manager)
url: /access/catalog
pages: portal/src/pages/access/CatalogPage.tsx,portal/src/pages/access/accessCollectionCommands.ts
audited: 2026-10-13 15:03–15:07 local (re-walk on ui-components 2.442.2), Chromium 1456×940 (Playwright headless from portal/, a fresh context per run signed in through portal/e2e/realSession.ts openAs as u-omar — not the shared Chrome tab), Vite :5183 + middleware dev:mock :3001 (shared; u-rhea and u-priya walked concurrently; no 401 on my session)
session: /api/session/me sub u-omar, tenant access, role approver, grants {"access":["approver"]}
screenshot: catalog.jpg
verdict: pass
console errors: 0 (on load, after the Filters popover, the row click/Enter and every composer phrase)
layout: pass — content column left 200 w 1256; trail "Request › Catalog" at left 224 top 68 (24px gutter, first row); title "Catalog" 20/600 at top 111; 8 body rows all 44px, one line; command composer docked 842–882 at the column bottom (891); no horizontal scroll (1456/1456); 1 <main>; text sizes 14/400×26, 14/500×1, 12/400×24, 12/600×10, 10/600×10, 20/600×1
keyboard: pass — 23 really-visible focusables in main, Tab visited 24 distinct stops in main; Enter on a focused row (Org leader in Work) → /access/requests/new?item=role%3Aorgiq%3Aorg-leader; Escape closes the Filters (Workspace) popover (0 popovers after)
empty-state: pass — "search catalog items for zzzz" → "0 of 8 items" and "No catalog item matches this search and workspace."; an item has no page of its own (the row opens the wizard)
role-gating: pass — approver holds RequestAccess, so a row click opens the request wizard for that item: the Operator in Pipelines row → /access/requests/new?item=role%3Apipelines%3Aoperator (nothing submitted). Rail: Catalog, Requests, Approvals, Policies, Reviews, Audit (+ Settings); no Configuration. "You hold" and "Policy" read — on all 8 items (Omar holds none); "sensitive" on Org leader in Work and Lead assessor in Assessment. No row checkboxes (0), so there is no selection toolbar to swap here. Probes: PUT /api/access/policies/sod-001 {} → 403 ManageAccessPolicy; PUT /api/access/configuration {} → 403 ManageAccessPolicy
notes: Composer: help lists search / show work|assessment|social|pipelines catalog items / reset filters / refresh / open <exact ID or title> and says nothing is submitted until Submit; "search catalog items for pipelines" → 1 of 8; then "show work catalog items" → "Filter: orgiq." and 0 of 8 (the search for "pipelines" is kept, which the notice says; the echo still names the tenant key, not "Work"); "reset filters" → 8 of 8; "open role:pipelines:operator" → the wizard with ?item=; "approve req-0001" → "Command not recognized … No changes were made." Walked with no writes.
