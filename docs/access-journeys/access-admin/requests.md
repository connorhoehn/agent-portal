surface: requests
role: access-admin
user: u-priya (Priya Venkataraman)
url: /access/requests?scope=all
pages: portal/src/pages/access/RequestsPage.tsx,portal/src/pages/access/accessColumns.tsx,portal/src/pages/access/accessCollectionCommands.ts
audited: 2026-10-13 06:36 local, Chromium 148.0.7778.96 1680x940 (Playwright headless from portal/node_modules, fresh context, signed in by POST /api/session/login, not the shared Chrome tab), middleware dev:mock :3001 reset before the walk, Vite :5183; GET /api/session/me: sub u-priya, tenant access, role access-admin, grants {"access":["access-admin"]}
screenshot: requests.jpg
verdict: pass
console errors: 0 on the surface (3 network errors logged by the record pages the walk opened: see request.md; plus the expected 404 for /access/requests/req-missing)
layout: pass — no horizontal scroll (scrollWidth 1680 = innerWidth 1680); 1 <main>; trail (nav Breadcrumb) is the first row of the content column at top 68, left 224 = 200px rail + 24px gutter; h1 14/600 (the compact header density; /pipelines/runs and /pipelines/configuration measure the same 14/600 in this walk, so the protocol's 20/600 is stale, not an access defect); table body rows 6 at 44px, one line each; command composer docked at the bottom of the content column (top 842 of 940, 772px wide)
keyboard: pass — Tab visited 36 stops (15 inside main) against 14 really-visible focusable controls in main (a radio group is one tab stop); Escape closes the Filters popover (verified)
empty-state: pass — search 'zzzz' renders 'No request matches this search and status.'; /access/requests/req-missing renders 'Request not found — No request req-missing that you may read.' (GET 404); default Mine view for Priya is empty (0 of 0, 'You have not requested any access yet.')
role-gating: Whose filter present (Filters popover options: Mine, My reports’, Everyone’s); Everyone's shows 6 of 6 requests (req-0001..0006 across Rhea, Omar and Nora); New request button present; a row opens its record (/access/requests/req-0001) and browser Back returns to /access/requests?scope=all
notes: Composer: help lists search/show open|approved|active|closed/reset/refresh/open; 'search requests for rhea' applies; 'show open requests' → 'Filter: open'; 'reset filters' clears; 'open req-0002' → /access/requests/req-0002; 'approve req-0001' → 'Command not recognized. Open Available requests commands for supported phrases. No changes were made.' and nothing changed. The scope view is the URL (?scope=all); the screenshot is the Everyone's view.
