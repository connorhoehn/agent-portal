surface: audit
role: requester
user: u-rhea (Rhea Castellanos)
url: /access/audit
pages: portal/src/pages/access/AuditPage.tsx,portal/src/lib/accessRequests.ts
audited: 2026-10-13 14:56–15:03 local, Chromium 1680x940 (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183, ui-components 2.442.2
session: /api/session/me sub u-rhea, tenant access, role requester, grants {"access":["requester"]}
screenshot: audit.jpg
verdict: pass
console errors: 0 on the page, after Tab, after every composer phrase, and after the row open/Back/click sequence
layout: pass — content col left 200 w 1480, top 44, bottom 891; trail "Govern › Audit" at 224/68; title 224/111 at 20/600; no horizontal scroll (1680/1680); 1 <main>; 7 body rows each 44px one line; composer docked at y 842–882
type: title 20/600 (h1); sizes in main: 14/400x33, 12/600x8, 10/600x7, 12/400x6, 14/500x1, 20/600x1
keyboard: pass — 14 Tab stops in main (About Audit, search, Filters, About results, Refresh, 7 rows, Agent mode, composer) plus Bold, all visited; Enter on the first row opened /access/requests/req-0001; Back returned; a click on the second row opened /access/requests/req-0002; Escape on the About-results popover returns focus to "About these results"
empty-state: pass — searching "zzzqq" leaves "No event matches this search and kind." (0 of 7); Event select lists Every event, Submitted, Step approved, Step rejected, Information requested, Withdrawn, Approved, Provisioned, Expired, Revoked, Policy override, Blocked by policy, Policy updated
role-gating: pass — scope notice (About these results): "You see the events of requests you may open: yours, your reports’, and those you decided or may decide."; API as u-rhea: 7 events, actors u-rhea and u-omar, requests req-0001, 0002, 0005, 0006 only (none of req-0003/0004); no row checkboxes, no Save/decision controls; composer `approve req-0001` -> "Command not recognized … No changes were made."
notes: Composer help lists `search events for "name"`, show submitted/approved/rejected/withdrawn events and more, reset, refresh, open. `search audit events for withdrawn` searches the literal text "audit events for withdrawn" (0 of 7: the phrase is "search events for"); `show submitted events` after it -> 0 (intersection); `reset filters` -> 7 of 7; `open req-0001` answers "No matching record in the current table. Use its exact ID or title" (open matches an event, not a request id — a row click is the way to the request). Every field above was observed in this re-walk, not carried forward.
