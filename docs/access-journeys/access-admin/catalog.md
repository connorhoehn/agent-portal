surface: catalog
role: access-admin
user: u-priya (Priya Venkataraman)
url: /access/catalog
pages: portal/src/pages/access/CatalogPage.tsx,portal/src/pages/access/accessColumns.tsx,portal/src/pages/access/accessCollectionCommands.ts,portal/src/App.tsx
audited: 2026-10-13 07:10 local, Chromium 148.0.7778.96 1680x940 (Playwright headless from portal/node_modules, fresh context, signed in by POST /api/session/login, not the shared Chrome tab), middleware dev:mock :3001 reset before and after, Vite :5183, ui-components 2.441.8; GET /api/session/me: sub u-priya, tenant access, role access-admin, grants {"access":["access-admin"]}
screenshot: catalog.jpg
verdict: pass
console errors: 0
layout: pass — no horizontal scroll (scrollWidth 1680 = innerWidth 1680); 1 <main>; trail (nav Breadcrumb) is the first row of the content column at top 68, left 224 = 200px rail + 24px gutter; h1 20/600 at left 224; table body rows 8 at 44px, one line each; command composer docked at the bottom of the content column (top 842 of 940, 747px wide)
keyboard: pass — Tab visited 37 stops (16 inside main) against 15 really-visible focusable controls in main (a radio group is one tab stop); Escape: no dialog on this page; the composer notice closes with its x
empty-state: pass — search 'zzzz' renders 'No catalog item matches this search and workspace.' with 0 of 8 items
role-gating: 8 row Request icons (all 8 items, access-admin may request); the first opens /access/requests/new?item=role%3Aorgiq%3Asme on the wizard at step 'Who'
notes: 8 of 8 items. Composer: help lists the phrases; 'search catalog items for pipeline' → 1 of 8; 'show work catalog items' → 'Filter: orgiq'; 'reset filters' → 8 of 8; 'open role:orgiq:sme' → /access/requests/new?item=role%3Aorgiq%3Asme (nothing submitted); 'approve req-0001' → 'Command not recognized … No changes were made'.
