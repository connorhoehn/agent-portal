surface: requests
role: requester
user: u-rhea (Rhea Castellanos)
url: /access/requests
pages: portal/src/pages/access/RequestsPage.tsx,portal/src/pages/access/accessCollectionCommands.ts,portal/src/lib/accessRequests.ts
audited: 2026-10-13 14:56–15:03 local, Chromium 1680x940 (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183, ui-components 2.442.2
session: /api/session/me sub u-rhea, tenant access, role requester, grants {"access":["requester"]}
screenshot: requests.jpg
verdict: pass
console errors: 0 on the list, after Tab, after search/status filter/help/reset, and after opening records (row Enter and `open req-0002`)
layout: pass — content col left 200 w 1480, top 44, bottom 891; trail "Request › Requests" at 224/68; title 224/111 at 20/600; scrollWidth 1680 = innerWidth 1680; 1 <main>; 4 body rows each 44px one line; composer docked at y 842–882
type: title 20/600 (h1); sizes in main: 14/400x23, 12/600x10, 12/400x5, 10/600x4, 14/500x1, 20/600x1
keyboard: pass — 11 Tab stops in main (About Requests, New request, search, Filters, Refresh, 4 rows, Agent mode, command composer) plus Bold, all visited; Enter on the focused first row opened /access/requests/req-0001; browser Back returned to /access/requests; New request opened /access/requests/new; Escape on the Filters popover returns focus to "Filters (1 active)"
empty-state: pass — searching "zzzqq" leaves "No request matches this search and status." (0 of 4); Status select (Every status/Open/Approved/Active/Closed): Open 1, Approved 0, Active 1, Closed 2 of 4; composer `show approved requests` -> "No request matches this search and status."
role-gating: pass — no Whose/scope control (Status is the only select; the word "whose" is absent), no Approve/Reject buttons, no Approvals or Configuration in the rail; own rows only; no row checkboxes, so the toolbar never swaps for this role (toolbar: Search requests, Filters, Refresh); API: GET /requests?scope=all 403 "scope=all needs DecideAccess"; ?scope=reports 200 {items:[]}; ?status=bogus 400 "Unknown status: bogus"; POST /requests {} 400 "itemId is required"; POST …/steps/1/decide {} 403; composer `approve req-0001` -> "Command not recognized … No changes were made."
notes: Rows: req-0001 SME in Work submitted/Manager, req-0002 Member of Auth Migration (read "active" at 14:58 because another lane had decided its steward step; "pending/Steward" again after the 15:00 reset), req-0005 Org leader in Work rejected, req-0006 Moderator in Social withdrawn. Composer help lists search/show open|approved|active|closed/reset/refresh/open; `search requests for observability` -> 0 of 4; `open req-0002` opened its record. Every field above was observed in this re-walk, not carried forward.
