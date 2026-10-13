surface: audit
role: access-admin
user: u-priya (Priya Venkataraman)
url: /access/audit
pages: portal/src/pages/access/AuditPage.tsx,portal/src/pages/access/accessCollectionCommands.ts
audited: 2026-10-13 07:10 local, Chromium 148.0.7778.96 1680x940 (Playwright headless from portal/node_modules, fresh context, signed in by POST /api/session/login, not the shared Chrome tab), middleware dev:mock :3001 reset before and after, Vite :5183, ui-components 2.441.8; GET /api/session/me: sub u-priya, tenant access, role access-admin, grants {"access":["access-admin"]}
screenshot: audit.jpg
verdict: pass
console errors: 0 on the surface
layout: pass — no horizontal scroll (scrollWidth 1680 = innerWidth 1680); 1 <main>; trail (nav Breadcrumb) is the first row of the content column at top 68, left 224 = 200px rail + 24px gutter; h1 20/600 at left 224; table body rows 17 at 44px, one line each; command composer docked at the bottom of the content column (top 842 of 940, 787px wide)
keyboard: pass — Tab visited 46 stops (25 inside main) against 24 really-visible focusable controls in main (a radio group is one tab stop)
empty-state: pass — search 'zzzz' renders 'No event matches this search and kind.'
role-gating: scope: access-admin reads every event, not only her own: 17 of 17 events and GET /api/access/audit returns the same 17, by actors Rhea, Omar, Priya, Nora, the system and the policy edit; Event filter now has 13 kinds incl. 'Blocked by policy' and 'Policy updated'; the policy-updated rows read e.g. 'sod-001 Priya Venkataraman warn → block, Spend and allocate: reason now …'; clicking a policy row opens /access/policies, 'open evt-0001' opens /access/requests/req-0001
notes: Composer: 'show approved events' → 'Filter: approved'; 'search events for omar' applies; 'reset filters'; 'approve req-0001' refused, nothing changed. This page was re-walked after two policy PUTs (block→warn→block), so the extra policy-updated rows are the walk's own. In the first pass of this walk the page read 20 events while the API read 15 a moment later (consistent with another lane resetting the mock mid-walk); the re-walk agrees (17 = 17).
