surface: requests
role: approver
user: u-omar (Omar Haddad, Rhea's manager)
url: /access/requests
pages: portal/src/pages/access/RequestsPage.tsx,portal/src/lib/accessRequests.ts
audited: 2026-10-13 06:20–06:45 local, Chromium 1456×940 (Playwright headless from portal/node_modules, fresh context signed in by POST /api/session/login as u-omar, not the shared Chrome tab), Vite :5183 + middleware dev:mock :3001 (shared with other lanes: audit event counts drifted 15→20 mid-walk from another walker's writes)
session: /api/session/me sub u-omar, tenant access, role approver, grants {"access":["approver"]}
screenshot: requests.jpg
verdict: pass
console errors: 0 on the list (0 on load, 0 after Whose/Status changes and composer phrases); opening any record logs 1 console 400, recorded on request.md
layout: pass — content col left 200 w 1256, trail left 224 top 68, title 14/600 (compact PageHeader, identical to /pipelines/approvals measured the same session; the protocol's 20/600 is not what any tenant renders now) at top 115; body rows 44px one line; composer docked 841–883; no horizontal scroll (1456/1456); 1 <main>; sizes 14/400×7, 12/600×10, 12/400×3, 14/600×1, 10/600×1
keyboard: pass — 9 really-visible focusables in main, Tab visited 10 in main; Enter on a focused row opened /access/requests/req-0001; browser Back returned to /access/requests?scope=reports with 4 rows; Escape closed the Filters popover
empty-state: pass — Whose “Mine” + Status “Open” renders “0 of 1 requests” and “No request matches this search and status.”; /access/requests/req-missing renders “Request not found” (see request.md)
role-gating: pass — Whose filter present (Mine / My reports’ / Everyone’s) with a Status filter (Every status, Open, Approved, Active, Closed), absent for requesters by role. Default Mine → req-0003 only (Omar's own, approved). My reports’ (?scope=reports) → req-0001 submitted, req-0002 pending, req-0005 rejected, req-0006 withdrawn (all Rhea's). Everyone’s → those four plus req-0003 (5 rows; req-0004, Nora's, is outside the read rule and absent); Everyone’s+Open → req-0001, req-0002; +Closed → req-0005, req-0006. API probes: GET ?scope=zz → 400 “Unknown scope: zz”; ?status=zz → 400 “Unknown status: zz”; POST /requests/req-0001/withdraw {} → 403 “Only the requester or the beneficiary can withdraw a request”
notes: Composer: help lists search/show open|approved|active|closed requests/reset filters/refresh/open; “search requests for pipelines” → 1 row; “show approved requests” → notice “Filter: approved.”; “reset filters” clears; “open req-0003” navigates to the record; “approve req-0001” → “Command not recognized … No changes were made.” and nothing changed. New request button → /access/requests/new. Row click on req-0002 opened its record.
