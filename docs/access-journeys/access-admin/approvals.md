surface: approvals
role: access-admin
user: u-priya (Priya Venkataraman)
url: /access/approvals
pages: portal/src/pages/access/ApprovalsPage.tsx,portal/src/pages/access/accessCollectionCommands.ts,portal/src/App.tsx
audited: 2026-10-13 14:52–15:01 local, Chromium 148.0.7778.96 1680x940 (Playwright headless from portal/node_modules, fresh context per script, signed in by POST /api/session/login, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183, ui-components 2.442.2; GET /api/session/me: sub u-priya, tenant access, role access-admin, grants {"access":["access-admin"]}; no 401 during the walk
screenshot: approvals.jpg
verdict: pass
console errors: 0
layout: no horizontal scroll (scrollWidth 1680 = innerWidth 1680); 1 <main>; trail (nav Breadcrumb) is the first row of the content column at top 68, left 224 = 200px rail + 24px gutter; h1 20/600 at left 224, top 111; trail 'Approve › Approvals'; table body rows 1 at 44px, one line; command composer docked at the bottom of the content column (input top 842 of 940, 769px wide)
keyboard: pass — Tab visited 29 stops (8 inside main) against 7 really-visible focusable controls in main; Enter on the focused row opens /access/requests/req-0002
empty-state: pass — search 'zzzz' renders 'No waiting request matches this search.'
role-gating: inbox lists only steps Priya may decide now: GET /api/access/approvals → [req-0002] (step 2 Steward, escalated to access admins); req-0001 waits on the manager step and is absent; a row click opens /access/requests/req-0002 and Back returns; Approvals is in her rail
notes: Composer: help; 'search approvals for rhea' → 1 row; 'reset filters'; 'approve req-0002' → 'Command not recognized … No changes were made' and req-0002 still listed; 'open req-0002' → the record.
