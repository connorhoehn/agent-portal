surface: requests
role: access-admin
user: u-priya (Priya Venkataraman)
url: /access/requests?scope=all
pages: portal/src/pages/access/RequestsPage.tsx,portal/src/pages/access/accessColumns.tsx,portal/src/pages/access/accessCollectionCommands.ts
audited: 2026-10-13 14:52–15:01 local, Chromium 148.0.7778.96 1680x940 (Playwright headless from portal/node_modules, fresh context per script, signed in by POST /api/session/login, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183, ui-components 2.442.2; GET /api/session/me: sub u-priya, tenant access, role access-admin, grants {"access":["access-admin"]}; no 401 during the walk
screenshot: requests.jpg
verdict: pass
console errors: 0 on the surface (1 expected network 404 for /access/requests/req-missing)
layout: no horizontal scroll (scrollWidth 1680 = innerWidth 1680); 1 <main>; trail (nav Breadcrumb) is the first row of the content column at top 68, left 224 = 200px rail + 24px gutter; h1 20/600 at left 224, top 111; table body rows 6 at 44px, one line each; command composer docked at the bottom of the content column (input top 842 of 940, 772px wide)
keyboard: pass — Tab visited 36 stops (15 inside main) against 14 really-visible focusable controls in main; Enter on a focused row opens /access/requests/req-0001; Escape closes the Filters popover (verified, 0 dialogs after)
empty-state: pass — search 'zzzz' renders 'No request matches this search and status.'; /access/requests/req-missing renders 'Request not found — No request req-missing that you may read. …'; the default Mine view is empty (0 of 0, 'You have not requested any access yet.')
role-gating: Whose filter present in the Filters popover (Mine, My reports’, Everyone’s; plus Status); Everyone's shows 6 of 6; My reports' 1 of 1; New request button present; a row opens /access/requests/req-0001 and browser Back returns to /access/requests?scope=all; no row checkboxes, so the selection toolbar swap does not apply
notes: Composer: 'search requests for rhea' → 4 rows; 'show open requests' → 2 rows ('Filter: open'); 'reset filters' → 6; 'approve req-0001' → 'Command not recognized … No changes were made', nothing changed; 'open req-0002' → /access/requests/req-0002. The screenshot is the Everyone's view.
