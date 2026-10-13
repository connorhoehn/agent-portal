surface: requests
role: approver
user: u-omar (Omar Haddad, Rhea's manager)
url: /access/requests
pages: portal/src/pages/access/RequestsPage.tsx,portal/src/lib/accessRequests.ts
audited: 2026-10-13 07:10–07:35 local (re-walk after the coordinator's fixes: ui-components 2.441.8 and the access fixes), Chromium 1456×940 (Playwright headless from portal/node_modules, fresh context signed in by POST /api/session/login as u-omar, not the shared Chrome tab), Vite :5183 + middleware dev:mock :3001 (shared with other lanes: another walker's policy toggles and a Rhea-filed request appeared mid-walk)
session: /api/session/me sub u-omar, tenant access, role approver, grants {"access":["approver"]}
screenshot: requests.jpg
verdict: pass
console errors: 0 (0 on load, after Whose/Status changes, row opens, composer phrases)
layout: pass — content col left 200 w 1256, trail left 224 top 68, title 20/600 at top 111; body rows 44px one line; composer docked 841–883; no horizontal scroll (1456/1456); 1 <main>; sizes 14/400×7, 12/600×10, 12/400×3, 20/600×1, 10/600×1
keyboard: pass — 9 really-visible focusables in main, Tab visited 10 in main; Enter on a focused row → /access/requests/req-0001; browser Back → /access/requests?scope=reports with 4 rows; Escape closes the Filters popover
empty-state: pass — Whose “Mine” + Status “Open” → “0 of 1 requests”, “No request matches this search and status.”; /access/requests/req-missing renders “Request not found” (request.md)
role-gating: pass — Whose filter (Mine / My reports’ / Everyone’s) and Status (Every status, Open, Approved, Active, Closed). Mine → req-0003 (own, approved). My reports’ (?scope=reports) → req-0001 submitted, req-0002 pending, req-0005 rejected, req-0006 withdrawn (all Rhea's, 4 of 4). Everyone’s → those plus req-0003 (5; req-0004, Nora's, absent as outside the read rule); +Open → req-0001, req-0002; +Closed → req-0005, req-0006. Probes: ?scope=zz → 400 “Unknown scope: zz”; ?status=zz → 400 “Unknown status: zz”; POST /requests/req-0001/withdraw {} → 403 “Only the requester or the beneficiary can withdraw a request”
notes: Composer: help lists search/show open|approved|active|closed requests/reset filters/refresh/open; “search requests for pipelines” → 1 row; “show approved requests” → “Filter: approved.”; “reset filters”; “open req-0003” → its record; “approve req-0001” → “Command not recognized … No changes were made.” and nothing changed. New request button → /access/requests/new; a row click opened req-0002. Opening records now logs no console error.
