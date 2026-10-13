surface: reviews
role: access-admin
user: u-priya (Priya Venkataraman)
url: /access/reviews (and /access/reviews/rev-0001)
pages: portal/src/pages/access/ReviewsPage.tsx,portal/src/pages/access/ReviewRecordPage.tsx,middleware/src/routes/access.ts
audited: 2026-10-13 14:52–15:01 local, Chromium 148.0.7778.96 1680x940 (Playwright headless from portal/node_modules, fresh context per script, signed in by POST /api/session/login, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183, ui-components 2.442.2; GET /api/session/me: sub u-priya, tenant access, role access-admin, grants {"access":["access-admin"]}; no 401 during the walk
screenshot: reviews.jpg
verdict: pass
console errors: 0 on both pages (network 409/400 from this walk's deliberate replay and invalid probes, 404 for rev-missing)
layout: no horizontal scroll (scrollWidth 1680 = innerWidth 1680); 1 <main>; trail (nav Breadcrumb) is the first row of the content column at top 68, left 224 = 200px rail + 24px gutter; h1 20/600 at left 224, top 111; trail 'Govern › Reviews'; table body rows 1 at 44px; command composer docked (input top 842, 779px wide). Record rev-0001: no horizontal scroll, trail first row at left 224, top 68 ('Govern › Reviews'), h1 'Q4 SME certification — Work' 20/600 at left 264, 4 item rows at 44px, composer docked (top 842)
keyboard: pass — list: Tab visited 31 stops (10 inside main) against 9 really-visible focusable; record: 34 stops (13 in main) against 12; Escape closes the New campaign drawer (verified) and the Revoke dialog on ri-0004 (focus returns to Revoke)
empty-state: pass — search 'zzzz' renders 'No campaign matches this search and status.'; /access/reviews/rev-missing renders 'Campaign not found — No review campaign rev-missing.'
role-gating: list: 1 campaign rev-0001 (owner Priya, open); New campaign button present, drawer 'Open campaign' disabled until set (closed with Escape, nothing created). RECORD rev-0001 from its row: 'Progress 2 of 4 decided · 2 kept · 0 revoked'; Keep/Revoke only on the 2 undecided rows (Caleb ri-0004, Layla ri-0003). DECIDED ri-0004 Keep with the comment 'Still needed for the Q4 sprint envelope.' at 14:59:26 → notice 'Kept Caleb Turner · sme.', progress 3 of 4 · 3 kept, row shows kept by Priya; replay → 409 'ri-0004 was already decided'; decision 'bogus' → 400
notes: Composer on the list: help; 'search reviews for q4' → 1; 'reset filters'; 'approve req-0001' refused; 'open rev-0001' → the record. On the record 'search review items for eli' → 1 row. The record's trail stops at 'Govern › Reviews' (it does not name the campaign, unlike the request record). The Keep was reset away.
