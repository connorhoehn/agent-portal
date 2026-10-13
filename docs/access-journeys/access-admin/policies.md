surface: policies
role: access-admin
user: u-priya (Priya Venkataraman)
url: /access/policies
pages: portal/src/pages/access/PoliciesPage.tsx,portal/src/pages/access/accessCollectionCommands.ts,middleware/src/routes/access.ts
audited: 2026-10-13 07:10 local, Chromium 148.0.7778.96 1680x940 (Playwright headless from portal/node_modules, fresh context, signed in by POST /api/session/login, not the shared Chrome tab), middleware dev:mock :3001 reset before and after, Vite :5183, ui-components 2.441.8; GET /api/session/me: sub u-priya, tenant access, role access-admin, grants {"access":["access-admin"]}
screenshot: policies.jpg
verdict: pass
console errors: 0
layout: pass — no horizontal scroll (scrollWidth 1680 = innerWidth 1680); 1 <main>; trail (nav Breadcrumb) is the first row of the content column at top 68, left 224 = 200px rail + 24px gutter; h1 20/600 at left 224; table body rows 4 at 44px, one line each; command composer docked at the bottom of the content column (top 842 of 940, 782px wide)
keyboard: pass — Tab visited 37 stops (16 inside main) against 15 really-visible focusable controls in main (a radio group is one tab stop); Escape closes the drawer (verified)
empty-state: pass — search 'zzzz' renders 'No policy matches this search and severity.'; severity Warning filter → 2 of 4
role-gating: Save present for access-admin: 4 Edit icons; drawer on sod-001 opened from the row; Save disabled until a field changes; severity Blocking→Warning plus ' (journey walk edit)' on the reason → PUT /api/access/policies/sod-001 200; GET shows warn, updatedBy u-priya; the row flipped to 'warning', the drawer closed. AUDIT: GET /api/access/audit then holds one event of kind policy-updated (actor u-priya, request none, before block → after warn, reason 'Spend and allocate: reason now …'), total 18 events. Reset: PUT with the original severity/reason → 200, block, reason restored exactly (writes a second policy-updated event); severity 'bogus' → 400
notes: Composer: 'show blocking policies' → 'Filter: block'; 'open sod-001' → 'Opened Spend and allocate. Nothing was changed.' and the drawer opens; 'approve req-0001' refused, nothing changed. The fixed save-audit defect is verified; mock reset after the walk.
