surface: requests
role: approver
user: u-omar (Omar Haddad, Rhea's manager)
url: /access/requests
pages: portal/src/pages/access/RequestsPage.tsx,portal/src/lib/accessRequests.ts
audited: 2026-10-13 15:03–15:07 local (re-walk on ui-components 2.442.2), Chromium 1456×940 (Playwright headless from portal/, a fresh context per run signed in through portal/e2e/realSession.ts openAs as u-omar — not the shared Chrome tab), Vite :5183 + middleware dev:mock :3001 (shared; u-rhea and u-priya walked concurrently; no 401 on my session)
session: /api/session/me sub u-omar, tenant access, role approver, grants {"access":["approver"]}
screenshot: requests.jpg
verdict: pass
console errors: 0 (load, Filters, row Enter, Back, composer phrases)
layout: pass — content column left 200 w 1256; trail "Request › Requests" at left 224 top 68; title 20/600 at top 111; the one body row (Mine) 44px, one line; composer docked 842–882; no horizontal scroll (1456/1456); 1 <main>; sizes 14/400×7, 14/500×1, 12/600×10, 12/400×3, 10/600×1, 20/600×1
keyboard: pass — 9 really-visible focusables in main, Tab visited 10; Enter on the focused row → /access/requests/req-0003; browser Back → /access/requests with its row; Escape closes the Filters popover
empty-state: pass — "Mine" holds only req-0003 (approved), so Status Open → none; /access/requests/req-missing renders "Request not found" (request.md)
role-gating: pass — the toolbar holds About, New request, Filters (Whose: Mine / My reports' / Everyone's, and Status), About these results, Refresh. API behind the Whose filter: scope=mine → req-0003 (Omar's own, approved); scope=reports → req-0001 submitted, req-0002 pending, req-0005 rejected, req-0006 withdrawn (all Rhea's); scope=all → those five, req-0004 (Nora's, outside his read rule) absent. Probes: ?scope=zz → 400 "Unknown scope: zz"; ?status=zz → 400 "Unknown status: zz"; POST /requests/req-0001/withdraw {} → 403 "Only the requester or the beneficiary can withdraw a request". No row checkboxes (0), so no selection toolbar
notes: Composer: help lists search / show open|approved|active|closed requests / reset filters / refresh / open, and "Commands never withdraw, approve or reject anything"; "search requests for pipelines" → 1 of 1; "show approved requests" → "Filter: approved."; "reset filters" → cleared; "open req-0003" → its record; "approve req-0001" → "Command not recognized … No changes were made." Walked with no writes.
