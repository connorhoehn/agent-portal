surface: requests
role: requester
user: u-rhea (Rhea Castellanos)
url: /access/requests
pages: portal/src/pages/access/RequestsPage.tsx,portal/src/pages/access/accessCollectionCommands.ts,portal/src/lib/accessRequests.ts
audited: 2026-10-13 06:20–06:33 local, Chromium 1680x940 (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183
session: /api/session/me sub u-rhea, tenant access, role requester, grants {"access":["requester"]}
screenshot: requests.jpg
verdict: fail — page title renders 14/600 instead of 20/600 (D1, platform-wide); opening a row arrives at a record page that logs a 400 console error (D2, recorded under request.md)
console errors: 0 on the list itself, after Tab, after search/status filter/help/reset; 1 after opening a record (row Enter or `open req-0002`): GET /api/conversations/agent/waiting?channel=access:req:<id> -> 400 (D2)
layout: fail on title only — content col left 200 w 1480, top 44, bottom 891; trail left 224 top 68; title at 224/115; scrollWidth 1680 = innerWidth 1680; 1 <main>; 4 body rows each 44px one line; composer docked bottom 882
type: title 14/600 (h1), not the documented 20/600 — platform-wide today, /pipelines/runs as u-ines also measures 14px/600 (see DEFECTS.md D1); sizes in main: 14/400x24, 12/600x10, 12/400x4, 10/600x4, 14/500x1, 14/600x1
keyboard: pass — 11 Tab stops in main (About Requests, New request, search, Filters, Refresh, 4 rows, Agent mode, command composer) plus composer Bold, all visited; Enter on the focused first row opened /access/requests/req-0001; browser Back returned to /access/requests; New request button opened /access/requests/new
empty-state: pass — searching "zzzqq" leaves "No request matches this search and status."; status select (Every status/Open/Approved/Active/Closed): Open 2 of 4, Approved 0, Active 0, Closed 2; composer `show approved requests` -> "No request matches this search and status."; `show rejected requests` is not a supported phrase (help lists open/approved/active/closed) and answers "Command not recognized"
role-gating: pass — no Whose/scope control anywhere on the page (no select besides Status, text "whose" absent), no Approve/Reject buttons, no Approvals or Configuration in the rail; own rows only (req-0001, 0002, 0005, 0006); API: GET /requests?scope=all 403 "scope=all needs DecideAccess"; ?scope=reports 200 {items:[]}; ?status=bogus 400 "Unknown status: bogus"; POST /requests {} 400; POST …/steps/1/decide {} 403; composer `approve req-0001` -> "Command not recognized … No changes were made." and nothing changed
notes: Rows: req-0001 SME in Work submitted/Manager, req-0002 Member of Auth Migration pending/Steward, req-0005 Org leader in Work rejected, req-0006 Moderator in Social withdrawn. Composer help text: Commands never withdraw, approve or reject anything. Mid-walk another lane added req-0007 (requester u-omar, beneficiary u-rhea, Operator in Pipelines) to Rhea's list, so counts at that moment read 5; the mock was reset afterwards. Every field above was observed in this pass, not carried forward.
