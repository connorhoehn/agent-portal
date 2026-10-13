surface: request
role: requester
user: u-rhea (Rhea Castellanos)
url: /access/requests/req-0001 (own); req-0005 (own, rejected); req-missing, req-0003, req-0004 (not readable)
pages: portal/src/pages/access/RequestRecordPage.tsx,portal/src/lib/accessRequests.ts
audited: 2026-10-13 07:04–07:10 local, Chromium 1680x940 (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183, ui-components 2.441.8
session: /api/session/me sub u-rhea, tenant access, role requester, grants {"access":["requester"]}
screenshot: request.jpg
verdict: pass
console errors: 0 on arrival at every readable record (req-0001, req-0005, the submitted one), after Tab and after the Withdraw dialog; the unreadable ids log only the expected 404 of their own lookup (3 total)
layout: pass — primary rail folded to the 44px strip (content col left 44 w 1636, top 44, bottom 891; depth 3); trail "Request › Requests › req-0001 · SME in Work" at 68/68 (44+24); title 108/111; no horizontal scroll (1680/1680); 1 <main>; steps and audit table rows 44px one line; right pane "Discussion" with resize handle, minimize and collapse
type: title 20/600 (h1); sizes in main: 14/400x25, 12/600x16, 12/400x11, 10/600x9, 11/400x3 (the "2 steps", "clear", "1 events" count/status pills), 14/600x2, 14/500x1, 20/600x1
keyboard: pass — 9 Tab stops + composer Bold visited (two crumb links, About, Withdraw, Chat tab, composer, resize handle, minimize, collapse); Withdraw opens a ConfirmDialog ("Withdraw this request? req-0001 stops here…" Keep it / Withdraw), Escape closes it and focus returns to Withdraw, request unchanged
empty-state: pass — /access/requests/req-missing renders "Request not found — No request req-missing that you may read. You can read a request you made or benefit from, one you may decide, or any as an access admin."; req-0003 (Omar's) and req-0004 (Nora's) render the identical state and API 404 "No request …" — no content leaks
role-gating: pass — Withdraw only where can.withdraw holds (present on req-0001 submitted; absent on rejected req-0005), no "Your decision" section and no approve/reject/request-information controls in the DOM; API: POST …/req-0001/steps/1/decide {} and {decision:"approve"} 403 (DecideAccess); POST /requests/req-0003/withdraw {} 404 and /req-missing/withdraw {} 404; PUT /policies/x {} 403
notes: Sections: summary (For, Asked by, Item, Duration, Expires "When provisioned", Why), APPROVAL CHAIN stepper + table (req-0001: step 1 Manager current Omar Haddad, step 2 Steward waiting Priya Venkataraman with the note "Escalated to the access admins: the steward holds no deciding role in Access."), POLICY CHECK clear, AUDIT table (1 event), Discussion pane with an enabled composer "Message the request discussion" (Send disabled while empty, "No messages yet"). The agent-waiting 400 no longer occurs. Every field above was observed in this re-walk, not carried forward.
