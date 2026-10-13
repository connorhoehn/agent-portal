surface: requests
role: requester
user: u-rhea (Rhea Castellanos)
url: /access/requests
pages: portal/src/pages/access/RequestsPage.tsx,portal/src/pages/access/accessCollectionCommands.ts,portal/src/lib/accessRequests.ts
audited: 2026-10-13 07:04–07:10 local, Chromium 1680x940 (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183, ui-components 2.441.8
session: /api/session/me sub u-rhea, tenant access, role requester, grants {"access":["requester"]}
screenshot: requests.jpg
verdict: pass
console errors: 0 on the list, after Tab, after search/status filter/help/reset, and after opening a record (row Enter and `open req-0002`)
layout: pass — content col left 200 w 1480, top 44, bottom 891; trail left 224 top 68; title 224/111; scrollWidth 1680 = innerWidth 1680; 1 <main>; 4 body rows each 44px one line; composer docked bottom 882
type: title 20/600 (h1); sizes in main: 14/400x24, 12/600x10, 12/400x4, 10/600x4, 14/500x1, 20/600x1
keyboard: pass — 11 Tab stops in main (About Requests, New request, search, Filters, Refresh, 4 rows, Agent mode, command composer) plus composer controls, all visited; Enter on the focused first row opened /access/requests/req-0001; browser Back returned to /access/requests; New request opened /access/requests/new
empty-state: pass — searching "zzzqq" leaves "No request matches this search and status."; status select (Every status/Open/Approved/Active/Closed): Open 2 of 4, Approved 0, Active 0, Closed 2; composer `show approved requests` -> "No request matches this search and status."; `show rejected requests` is not a supported phrase (help lists open/approved/active/closed) and answers "Command not recognized"
role-gating: pass — no Whose/scope control (Status is the only select; text "whose" absent), no Approve/Reject buttons, no Approvals or Configuration in the rail; own rows only; API: GET /requests?scope=all 403 "scope=all needs DecideAccess"; ?scope=reports 200 {items:[]}; ?status=bogus 400 "Unknown status: bogus"; POST /requests {} 400; POST …/steps/1/decide {} 403; composer `approve req-0001` -> "Command not recognized … No changes were made." and nothing changed
notes: Rows at the start: req-0001 SME in Work submitted/Manager, req-0002 Member of Auth Migration pending/Steward, req-0005 Org leader in Work rejected, req-0006 Moderator in Social withdrawn. Another lane was acting on the shared mock during this walk (req-0002 read "active" in one snapshot, a req-0007 Operator in Pipelines for Rhea appeared "just now" in another), so counts moved between snapshots; the mock was reset at the end. Every field above was observed in this re-walk, not carried forward.
