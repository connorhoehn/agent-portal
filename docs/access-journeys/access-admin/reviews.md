surface: reviews
role: access-admin
user: u-priya (Priya Venkataraman)
url: /access/reviews
pages: portal/src/pages/access/ReviewsPage.tsx,middleware/src/routes/access.ts
audited: 2026-10-13 06:36 local, Chromium 148.0.7778.96 1680x940 (Playwright headless from portal/node_modules, fresh context, signed in by POST /api/session/login, not the shared Chrome tab), middleware dev:mock :3001 reset before the walk, Vite :5183; GET /api/session/me: sub u-priya, tenant access, role access-admin, grants {"access":["access-admin"]}
screenshot: reviews.jpg
verdict: pass
console errors: 0
layout: pass — no horizontal scroll (scrollWidth 1680 = innerWidth 1680); 1 <main>; trail (nav Breadcrumb) is the first row of the content column at top 68, left 224 = 200px rail + 24px gutter; h1 14/600 (the compact header density; /pipelines/runs and /pipelines/configuration measure the same 14/600 in this walk, so the protocol's 20/600 is stale, not an access defect); 1 body row(s), 85px (the empty-state message row); command composer docked at the bottom of the content column (top 842 of 940, 779px wide)
keyboard: pass — Tab visited 28 stops (7 inside main) against 6 really-visible focusable controls in main (a radio group is one tab stop)
empty-state: pass — this surface is the honest empty state: 'No review campaigns yet. A review asks a reviewer to keep or revoke each standing grant in one workspace. A2 brings campaigns.' (0 campaigns; GET /api/access/reviews → items [] with limits 'Access reviews arrive in phase A2')
role-gating: access-admin sees the surface and its toolbar and composer; nothing to decide or start (the composer says 'Commands never start, decide or close a review')
notes: Composer: help, 'search reviews for q4', 'reset filters' all answer; 'approve req-0001' → 'Command not recognized … No changes were made'. Names lane A2 as designed.
