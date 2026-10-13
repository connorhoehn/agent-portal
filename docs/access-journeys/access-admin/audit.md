surface: audit
role: access-admin
user: u-priya (Priya Venkataraman)
url: /access/audit
pages: portal/src/pages/access/AuditPage.tsx,portal/src/pages/access/accessCollectionCommands.ts
audited: 2026-10-13 06:36 local, Chromium 148.0.7778.96 1680x940 (Playwright headless from portal/node_modules, fresh context, signed in by POST /api/session/login, not the shared Chrome tab), middleware dev:mock :3001 reset before the walk, Vite :5183; GET /api/session/me: sub u-priya, tenant access, role access-admin, grants {"access":["access-admin"]}
screenshot: audit.jpg
verdict: pass
console errors: 0 on the surface
layout: pass — no horizontal scroll (scrollWidth 1680 = innerWidth 1680); 1 <main>; trail (nav Breadcrumb) is the first row of the content column at top 68, left 224 = 200px rail + 24px gutter; h1 14/600 (the compact header density; /pipelines/runs and /pipelines/configuration measure the same 14/600 in this walk, so the protocol's 20/600 is stale, not an access defect); table body rows 15 at 44px, one line each; command composer docked at the bottom of the content column (top 842 of 940, 787px wide)
keyboard: pass — Tab visited 44 stops (23 inside main) against 22 really-visible focusable controls in main (a radio group is one tab stop)
empty-state: pass — search 'zzzz' renders 'No event matches this search and kind.'
role-gating: scope notice reads 'You see every event in the access workspace.'; 15 of 15 events and GET /api/access/audit returns the same 15: every event, not only her own, by actors system, u-nora, u-omar, u-priya, u-rhea; Event filter has 11 kinds; clicking the first row opens /access/requests/req-0001
notes: Composer: 'show approved events' → 'Filter: approved'; 'search events for omar' applies; 'open evt-0001' → /access/requests/req-0001; 'approve req-0001' refused, nothing changed. The walk's own decision and filings (req-0002 approval, req-0007, req-0008) were made before this page was read, so the 15 include them; the Submitted/approved rows from the walk read like the seeded ones. A 'provisioned' event has a system actor (blank actor handled).
