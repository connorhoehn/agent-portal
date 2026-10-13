surface: audit
role: access-admin
user: u-priya (Priya Venkataraman)
url: /access/audit
pages: portal/src/pages/access/AuditPage.tsx,portal/src/pages/access/accessCollectionCommands.ts,portal/src/lib/accessRequests.ts
audited: 2026-10-13 14:52–15:01 local, Chromium 148.0.7778.96 1680x940 (Playwright headless from portal/node_modules, fresh context per script, signed in by POST /api/session/login, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183, ui-components 2.442.2; GET /api/session/me: sub u-priya, tenant access, role access-admin, grants {"access":["access-admin"]}; no 401 during the walk
screenshot: audit.jpg
verdict: pass
console errors: 0
layout: no horizontal scroll (scrollWidth 1680 = innerWidth 1680); 1 <main>; trail (nav Breadcrumb) is the first row of the content column at top 68, left 224 = 200px rail + 24px gutter; h1 20/600 at left 224, top 111; trail 'Govern › Audit'; table body rows 17 at 44px, one line each; command composer docked at the bottom of the content column (input top 842 of 940, 787px wide)
keyboard: pass — Tab visited 46 stops (25 inside main) against 24 really-visible focusable controls; Escape closes the Filters popover (verified)
empty-state: pass — search 'zzzz' renders 'No event matches this search and kind.'
role-gating: scope: access-admin reads every event — page '17 of 17 events' = GET /api/access/audit 17 (seed 15 + two policy-updated events from this walk's sod-001 block → warn → block PUTs at 15:00:47), actors Rhea, Omar, Priya, Nora and the system; Event filter has 13 kinds incl. Blocked by policy and Policy updated; a request row opens /access/requests/req-0002; 'open evt-0001' → /access/requests/req-0001; a policy-updated row opens /access/policies (the list, not the sod-001 record page)
notes: Composer: help; 'search events for omar' → 3; 'show approved events' → 1; 'reset filters' → 17; 'approve req-0001' refused, nothing changed. First pass (15:00:07) showed 22 events incl. this walk's req-0002 decision, the UI policy save/restore and a Rhea req-0008 while the API read 15 a moment later — another lane reset the mock at ~15:00:08; the second pass is the logged one and agrees (17 = 17). Reset by me at 15:01:13.
