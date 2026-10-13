surface: audit
role: requester
user: u-rhea (Rhea Castellanos)
url: /access/audit
pages: portal/src/pages/access/AuditPage.tsx,portal/src/lib/accessRequests.ts
audited: 2026-10-13 07:04–07:10 local, Chromium 1680x940 (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183, ui-components 2.441.8
session: /api/session/me sub u-rhea, tenant access, role requester, grants {"access":["requester"]}
screenshot: audit.jpg
verdict: pass
console errors: 0 on the page, after Tab, after every composer phrase, and after the row open/Back/click sequence
layout: pass — content col left 200 w 1480, top 44, bottom 891; trail "Govern › Audit" at 224/68; title 224/111; no horizontal scroll (1680/1680); 1 <main>; 7 body rows each 44px one line; composer docked at the bottom
type: title 20/600 (h1); sizes in main: 14/400x33, 12/600x8, 10/600x7, 12/400x6, 14/500x1, 20/600x1
keyboard: pass — 14 Tab stops in main (About Audit, search, Filters, About results, Refresh, 7 rows, Agent mode, composer) plus Bold, all visited; Enter on the first row opened /access/requests/req-0001; Back returned; a click on the second row opened /access/requests/req-0002
empty-state: pass — searching "zzzqq" leaves "No event matches this search and kind."; Event select now lists Every event, Submitted, Step approved, Step rejected, Information requested, Withdrawn, Approved, Provisioned, Expired, Revoked, Policy override, Blocked by policy, Policy updated; composer `show approved events` -> none (final "Approved" only, Rhea has none)
role-gating: pass — scope notice (About these results): "You see the events of requests you may open: yours, your reports’, and those you decided or may decide."; API as u-rhea: 7 events, actors u-rhea and u-omar, only req-0001, 0002, 0005, 0006 (none of req-0003/0004); no Save/decision controls; composer `approve req-0001` -> "Command not recognized … No changes were made."
notes: Composer help adds `show blocked events`. `open req-0001` answers "No matching record in the current table. Use its exact ID or title" (open matches an event id, not a request id); `search audit for approved` searches the literal text "audit for approved" (0 results). Every field above was observed in this re-walk, not carried forward.
