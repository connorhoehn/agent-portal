surface: approvals
role: access-admin
user: u-priya (Priya Venkataraman)
url: /access/approvals
pages: portal/src/pages/access/ApprovalsPage.tsx,portal/src/pages/access/accessCollectionCommands.ts,portal/src/App.tsx
audited: 2026-10-13 06:36 local, Chromium 148.0.7778.96 1680x940 (Playwright headless from portal/node_modules, fresh context, signed in by POST /api/session/login, not the shared Chrome tab), middleware dev:mock :3001 reset before the walk, Vite :5183; GET /api/session/me: sub u-priya, tenant access, role access-admin, grants {"access":["access-admin"]}
screenshot: approvals.jpg
verdict: pass
console errors: 0 on the surface
layout: pass — no horizontal scroll (scrollWidth 1680 = innerWidth 1680); 1 <main>; trail (nav Breadcrumb) is the first row of the content column at top 68, left 224 = 200px rail + 24px gutter; h1 14/600 (the compact header density; /pipelines/runs and /pipelines/configuration measure the same 14/600 in this walk, so the protocol's 20/600 is stale, not an access defect); table body rows 1 at 44px, one line each; command composer docked at the bottom of the content column (top 842 of 940, 769px wide); the 1-row table has 7 columns incl. Asked by and Your step
keyboard: pass — Tab visited 29 stops (8 inside main) against 7 really-visible focusable controls in main (a radio group is one tab stop)
empty-state: pass — search 'zzzz' renders 'No waiting request matches this search.'
role-gating: inbox lists only steps Priya may decide now: GET /api/access/approvals → [req-0002] (step 2 · Steward; req-0001 waits on the manager step and is not listed); a row opens the record (Enter on a focused row too → /access/requests/req-0002)
notes: 1 waiting on you. Composer: help lists search/reset/refresh/open; 'open req-0002' opens the record; 'approve req-0002' → 'Command not recognized … No changes were made' and the approval list still holds req-0002.
