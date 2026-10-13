surface: policies
role: access-admin
user: u-priya (Priya Venkataraman)
url: /access/policies
pages: portal/src/pages/access/PoliciesPage.tsx,portal/src/pages/access/accessCollectionCommands.ts,middleware/src/routes/access.ts
audited: 2026-10-13 06:36 local, Chromium 148.0.7778.96 1680x940 (Playwright headless from portal/node_modules, fresh context, signed in by POST /api/session/login, not the shared Chrome tab), middleware dev:mock :3001 reset before the walk, Vite :5183; GET /api/session/me: sub u-priya, tenant access, role access-admin, grants {"access":["access-admin"]}
screenshot: policies.jpg
verdict: pass
console errors: 0
layout: pass — no horizontal scroll (scrollWidth 1680 = innerWidth 1680); 1 <main>; trail (nav Breadcrumb) is the first row of the content column at top 68, left 224 = 200px rail + 24px gutter; h1 14/600 (the compact header density; /pipelines/runs and /pipelines/configuration measure the same 14/600 in this walk, so the protocol's 20/600 is stale, not an access defect); table body rows 4 at 44px, one line each; command composer docked at the bottom of the content column (top 842 of 940, 782px wide)
keyboard: pass — Tab visited 37 stops (16 inside main) against 15 really-visible focusable controls in main (a radio group is one tab stop); Escape closes the drawer (verified)
empty-state: pass — search 'zzzz' renders 'No policy matches this search and severity.'; severity Warning filter → 2 of 4
role-gating: Save present for access-admin: drawer on sod-001 (Spend and allocate) opened from the row's Edit icon (4 edit icons, one per policy); Save disabled until a field changes (True); changed severity Blocking→Warning and appended ' (journey walk edit)' to the reason → Save enabled → PUT /api/access/policies/sod-001 answered 200; GET shows severity warn, updatedBy u-priya; the table row flipped to 'warning' and the drawer closed. Reset: PUT with the original severity/reason → 200, block, reason restored exactly; PUT severity 'bogus' → 400
notes: Composer: 'show blocking policies' → 'Filter: block'; 'open sod-001' → 'Opened Spend and allocate. Nothing was changed.' and the drawer opens; 'approve req-0001' refused, nothing changed. The Save in the policy drawer writes no audit event: GET /api/access/audit stayed at 15 events (0 of kind policy-*) after a PUT, although the Audit Event filter offers 'Policy updated' (see DEFECTS.md). Mock reset after the walk.
