surface: audit
role: requester
user: u-rhea (Rhea Castellanos)
url: /access/audit
pages: portal/src/pages/access/AuditPage.tsx,portal/src/lib/accessRequests.ts
audited: 2026-10-13 06:20–06:33 local, Chromium 1680x940 (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183
session: /api/session/me sub u-rhea, tenant access, role requester, grants {"access":["requester"]}
screenshot: audit.jpg
verdict: fail — page title renders 14/600 instead of the documented 20/600 (D1, platform-wide); scoping and navigation passed
console errors: 0 on the page, after Tab and after every composer phrase; 2 after row open/Back/click sequence, both the record page's 400 (D2)
layout: fail on title only — content col left 200 w 1480, top 44, bottom 891; trail "Govern › Audit" at 224/68; title at 224/115; no horizontal scroll (1680/1680); 1 <main>; 7 body rows each 44px one line; composer docked at the bottom
type: title 14/600 (h1), not the documented 20/600 — platform-wide today, /pipelines/runs as u-ines also measures 14px/600 (see DEFECTS.md D1); sizes in main: 14/400x33, 12/600x8, 10/600x7, 12/400x6, 14/500x1, 14/600x1
keyboard: pass — 14 Tab stops in main (About Audit, search, Filters, About results, Refresh, 7 rows, Agent mode, composer) plus Bold, all visited; Enter on the first row opened /access/requests/req-0001; Back returned; a click on the second row opened /access/requests/req-0002
empty-state: pass — searching "zzzqq" leaves "No event matches this search and kind."; Event select lists Every event, Submitted, Step approved, Step rejected, Information requested, Withdrawn, Approved, Provisioned, Expired, Revoked, Policy override, Policy updated; composer `show approved events` -> none (final "Approved" only, Rhea has none)
role-gating: pass — scope notice is the "About these results" tooltip: "You see the events of requests you made or benefit from."; About Audit: "Approvers see every event; others their own." API as u-rhea: 7 events, actors u-rhea and u-omar, only req-0001, 0002, 0005, 0006 (none of req-0003/0004); no Save/decision controls; composer `approve req-0001` -> "Command not recognized … No changes were made."
notes: Composer: help (search events for "name"; show submitted/approved/rejected/withdrawn/override events; reset filters; refresh; open <exact ID or title>), `open req-0001` -> "No matching record in the current table. Use its exact ID or title" (open matches an event id, not a request id). `search audit for approved` searches the literal text "audit for approved" (0 results). Rows read like "3h ago Submitted req-0001 Rhea Castellanos draft -> submitted". Every field above was observed in this pass, not carried forward.
