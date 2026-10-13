surface: reviews
role: approver
user: u-omar (Omar Haddad, Rhea's manager)
url: /access/reviews
pages: portal/src/pages/access/ReviewsPage.tsx
audited: 2026-10-13 06:20–06:45 local, Chromium 1456×940 (Playwright headless from portal/node_modules, fresh context signed in by POST /api/session/login as u-omar, not the shared Chrome tab), Vite :5183 + middleware dev:mock :3001 (shared with other lanes: audit event counts drifted 15→20 mid-walk from another walker's writes)
session: /api/session/me sub u-omar, tenant access, role approver, grants {"access":["approver"]}
screenshot: reviews.jpg
verdict: pass
console errors: 0 (0 on load, after Enter on the row, after composer phrases)
layout: pass — content col left 200 w 1256, trail left 224 top 68, title 14/600 (compact PageHeader, identical to /pipelines/approvals measured the same session; the protocol's 20/600 is not what any tenant renders now) at top 115; the table body is the one 85px empty-message row (the honest empty state, not a data row); composer docked 841–883; no horizontal scroll (1456/1456); 1 <main>; sizes 14/400×3, 12/600×6, 12/400×2, 14/600×1
keyboard: pass — 6 really-visible focusables in main, Tab visited 7 in main (toolbar, composer); the empty row is not focusable and Enter on it opens nothing; no dialog to close
empty-state: pass — the honest empty table: “0 campaigns — No review campaigns yet. A review asks a reviewer to keep or revoke each standing grant in one workspace. A2 brings campaigns.” with columns CAMPAIGN, WORKSPACE, STATUS, DUE; “search reviews for auth” → “No campaign matches this search.”
role-gating: pass — reads ViewAccess; no review controls for any role in A1: GET /api/access/reviews → 200 {items:[],limits:['Access reviews arrive in phase A2; no campaign exists yet.']}; POST /api/access/reviews {} → 404 and PUT /api/access/reviews/x {} → 404 (no write route exists, so nothing is gated or written)
notes: Composer: help lists search reviews for/reset filters/refresh and says “Commands never start, decide or close a review.”; “search reviews for auth” and “reset filters” work; “open camp-1” → “Opening records is not available here. No changes were made.”; “approve req-0001” → “Command not recognized … No changes were made.”.
