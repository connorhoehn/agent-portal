surface: reviews
role: requester
user: u-rhea (Rhea Castellanos)
url: /access/reviews (list), /access/reviews/rev-0001 (record), /access/reviews/rev-missing
pages: portal/src/pages/access/ReviewsPage.tsx,portal/src/lib/accessRequests.ts
audited: 2026-10-13 07:04–07:10 local, Chromium 1680x940 (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183, ui-components 2.441.8
session: /api/session/me sub u-rhea, tenant access, role requester, grants {"access":["requester"]}
screenshot: reviews.jpg
verdict: pass
console errors: 0 on the list, after Tab, after every composer phrase and on the campaign record; the rev-missing lookup logs only its own expected 404
layout: pass — list: content col left 200 w 1480, top 44, bottom 891; trail "Govern › Reviews" at 224/68; title 224/111; no horizontal scroll (1680/1680); 1 <main>; 1 body row of 44px (rev-0001); composer docked at the bottom. Record rev-0001: title "Q4 SME certification — Work" 20/600 at left 264 (back link in the title row), no horizontal scroll, its empty items state is one 85px row
type: title 20/600 (h1); list sizes in main: 14/400x7, 12/600x9, 12/400x2, 10/600x1, 14/500x1, 20/600x1
keyboard: pass — 8 Tab stops in the list (About Reviews, search, Filters, About results, Refresh, the row, Agent mode, composer) plus Bold, all visited; Enter on the row opened /access/reviews/rev-0001, whose Tab stops are the crumb link, About, search, Filters, About results, Refresh, Agent mode, composer; Back returned to /access/reviews
empty-state: pass — searching "q3" leaves "No campaign matches this search and status."; Status select (Every status/Open/Closed): Closed = 0 of 1; /access/reviews/rev-missing renders "Campaign not found — No review campaign rev-missing." (API 404 "No review rev-missing"); the record shows "No standing grant of yours is in this campaign." with progress 0 of 0 decided
role-gating: pass — no New campaign control, no keep/revoke decision controls (record buttons: Agent, Apply disabled), no Save; API: GET /api/access/reviews 200 and /reviews/rev-0001 200; POST /api/access/reviews {} 403 (ManageAccessPolicy); POST /reviews/rev-0001/items/x/decide {} 403 (DecideAccess); composer `approve req-0001` -> "Command not recognized … No changes were made."; POST /reviews/rev-0001/close is a missing route (Express 404)
notes: One campaign: rev-0001 "Q4 SME certification — Work", workspace Work, owner Priya Venkataraman, status open, opened 5d ago, decided blank. Composer help: search reviews for "name"; show open reviews; show closed reviews; reset filters; refresh; open <exact ID or title>; "Commands never start, decide or close a review; New campaign is an explicit control" (that control is absent for a requester). Rhea holds no standing grant in the campaign, so her record is empty by design. Every field above was observed in this re-walk, not carried forward.
