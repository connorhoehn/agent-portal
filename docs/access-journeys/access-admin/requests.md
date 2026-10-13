surface: requests
role: access-admin
user: u-priya (Priya Venkataraman)
url: /access/requests?scope=all
pages: portal/src/pages/access/RequestsPage.tsx,portal/src/pages/access/accessColumns.tsx,portal/src/pages/access/accessCollectionCommands.ts
audited: 2026-10-13 07:10 local, Chromium 148.0.7778.96 1680x940 (Playwright headless from portal/node_modules, fresh context, signed in by POST /api/session/login, not the shared Chrome tab), middleware dev:mock :3001 reset before and after, Vite :5183, ui-components 2.441.8; GET /api/session/me: sub u-priya, tenant access, role access-admin, grants {"access":["access-admin"]}
screenshot: requests.jpg
verdict: pass
console errors: 0 on the surface (1 expected network 404 for /access/requests/req-missing)
layout: pass — no horizontal scroll (scrollWidth 1680 = innerWidth 1680); 1 <main>; trail (nav Breadcrumb) is the first row of the content column at top 68, left 224 = 200px rail + 24px gutter; h1 20/600 at left 224; table body rows 6 at 44px, one line each; command composer docked at the bottom of the content column (top 842 of 940, 772px wide)
keyboard: pass — Tab visited 36 stops (15 inside main) against 14 really-visible focusable controls in main (a radio group is one tab stop); Escape closes the Filters popover (verified)
empty-state: pass — search 'zzzz' renders 'No request matches this search and status.'; /access/requests/req-missing renders 'Request not found — No request req-missing that you may read.' (GET 404); the default Mine view is empty (0 of 0, 'You have not requested any access yet.')
role-gating: Whose filter present (options Mine, My reports’, Everyone’s); Everyone's shows 6 of 6 requests; New request button present; a row opens /access/requests/req-0001 and browser Back returns to /access/requests?scope=all
notes: Composer: 'search requests for rhea' applies; 'show open requests' → 'Filter: open'; 'reset filters'; 'open req-0002' → /access/requests/req-0002; 'approve req-0001' → 'Command not recognized … No changes were made', nothing changed. The scope is the URL (?scope=all); the screenshot is the Everyone's view.
