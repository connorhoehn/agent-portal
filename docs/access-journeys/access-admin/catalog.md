surface: catalog
role: access-admin
user: u-priya (Priya Venkataraman)
url: /access/catalog
pages: portal/src/pages/access/CatalogPage.tsx,portal/src/pages/access/accessColumns.tsx,portal/src/pages/access/accessCollectionCommands.ts,portal/src/App.tsx
audited: 2026-10-13 14:52–15:01 local, Chromium 148.0.7778.96 1680x940 (Playwright headless from portal/node_modules, fresh context per script, signed in by POST /api/session/login, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183, ui-components 2.442.2; GET /api/session/me: sub u-priya, tenant access, role access-admin, grants {"access":["access-admin"]}; no 401 during the walk
screenshot: catalog.jpg
verdict: pass
console errors: 0
layout: no horizontal scroll (scrollWidth 1680 = innerWidth 1680); 1 <main>; trail (nav Breadcrumb) is the first row of the content column at top 68, left 224 = 200px rail + 24px gutter; h1 20/600 at left 224, top 111; table body rows 8 at 44px, one line each; command composer docked at the bottom of the content column (input top 842 of 940, 747px wide)
keyboard: pass — Tab visited 45 stops (24 inside main) against 23 really-visible focusable controls in main; Enter on a focused row opens the wizard for that item; no dialog on this page (Escape n/a)
empty-state: pass — search 'zzzz' renders 'No catalog item matches this search and workspace.'
role-gating: 8 row Request icons (none disabled: Priya holds none of the 8); a ROW click now opens the request wizard for the item (SME in Work → /access/requests/new?item=role%3Aorgiq%3Asme; Operator in Pipelines → ?item=role%3Apipelines%3Aoperator with the item chip in the header); browser Back returns to /access/catalog; no row checkboxes, so the selection toolbar swap does not apply here
notes: 8 of 8 items. Composer: help lists the phrases; 'search catalog items for pipeline' → 1 of 8; 'show work catalog items' with that search still applied → 0 of 8 ('Filter: orgiq. Search and sorting are unchanged' — correct, the search is kept); 'reset filters' → 8 of 8; 'approve req-0001' → 'Command not recognized … No changes were made'; 'open role:orgiq:sme' → the wizard for SME in Work (nothing submitted).
