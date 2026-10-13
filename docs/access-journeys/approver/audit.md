surface: audit
role: approver
user: u-omar (Omar Haddad, Rhea's manager)
url: /access/audit
pages: portal/src/pages/access/AuditPage.tsx,portal/src/lib/accessRequests.ts
audited: 2026-10-13 07:10–07:35 local (re-walk after the coordinator's fixes: ui-components 2.441.8 and the access fixes), Chromium 1456×940 (Playwright headless from portal/node_modules, fresh context signed in by POST /api/session/login as u-omar, not the shared Chrome tab), Vite :5183 + middleware dev:mock :3001 (shared with other lanes: another walker's policy toggles and a Rhea-filed request appeared mid-walk)
session: /api/session/me sub u-omar, tenant access, role approver, grants {"access":["approver"]}
screenshot: audit.jpg
verdict: pass
console errors: 0 on load, after the Event filter, row opens and composer phrases (2 console lines came only from my deliberate probes)
layout: pass — content col left 200 w 1256, trail left 224 top 68, title 20/600 at top 111; 13 body rows all 44px one line; composer docked 841–883; no horizontal scroll (1456/1456); 1 <main>; sizes 14/400×61, 12/400×8, 12/600×8, 10/600×13, 20/600×1
keyboard: pass — 20 really-visible focusables in main, Tab visited 21 in main; Enter on a focused row opened a record (the first row was another walker's “Policy updated” event, which opened /access/policies); a click on another row → /access/requests/req-0002; Escape closes the Event filter and “About these results” popovers
empty-state: pass — “search events for zzzz” → “0 of 11 events”; /access/requests/req-missing renders “Request not found”
role-gating: pass — approver sees events of requests he may open: GET /api/access/audit lists req-0001, 0002, 0003, 0005, 0006 (every one readable, GET each → 200) plus request-less policy events; req-0004 (Nora's, unreadable) no longer appears. The scope is stated in the page description and the About popover: “You see the events of requests you may open: yours, your reports’, and those you decided or may decide.” (it sits behind the header's info icon, not as a visible line). Event filter options: Every event, Submitted, Step approved, Step rejected, Information requested, Withdrawn, Approved, Provisioned, Expired, Revoked, Policy override, Blocked by policy, Policy updated (Step approved → 3 of 13). POST /audit → 404 (append-only); GET ?event=zz → 200, the unknown filter is ignored
notes: Composer: help lists search events for/show submitted|approved|rejected|withdrawn|override|blocked events/reset filters/refresh/open; “search events for rhea” → 5 of 11; “show submitted events” → “Filter: submitted.”; “open evt-0001” → /access/requests/req-0001; “approve req-0001” refused, nothing changed. The live count read 13 then 11 as another lane wrote and reverted sod-001 policy edits (“audit walk: temporary reason change”) on the shared mock.
