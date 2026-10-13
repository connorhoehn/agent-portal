surface: approvals
role: approver
user: u-omar (Omar Haddad, Rhea's manager)
url: /access/approvals
pages: portal/src/pages/access/ApprovalsPage.tsx,portal/src/lib/accessRequests.ts
audited: 2026-10-13 07:10–07:35 local (re-walk after the coordinator's fixes: ui-components 2.441.8 and the access fixes), Chromium 1456×940 (Playwright headless from portal/node_modules, fresh context signed in by POST /api/session/login as u-omar, not the shared Chrome tab), Vite :5183 + middleware dev:mock :3001 (shared with other lanes: another walker's policy toggles and a Rhea-filed request appeared mid-walk)
session: /api/session/me sub u-omar, tenant access, role approver, grants {"access":["approver"]}
screenshot: approvals.jpg
verdict: pass
console errors: 0 (load, row open, composer phrases)
layout: pass — content col left 200 w 1256, trail left 224 top 68, title 20/600 at top 111; the body row is 44px one line; composer docked 841–883; no horizontal scroll (1456/1456); 1 <main>; sizes 14/400×9, 12/600×9, 12/400×2, 20/600×1
keyboard: pass — 7 really-visible focusables in main, Tab visited 8 in main; Enter on a focused row and a click both → /access/requests/req-0001
empty-state: pass — “search approvals for zzzz” → “0 waiting on you — No waiting request matches this search.”
role-gating: pass — approver and access-admin only. Inbox = exactly the steps Omar may decide now: GET /api/access/approvals → [req-0001 can.decide true], equal to the can.decide set of scope=all. Row: req-0001, SME in Work, for Rhea Castellanos, 30 days, 3h ago, asked by Rhea Castellanos, your step “1 · Manager”. req-0002 (steward step) and req-0003 (own) are absent. Another walker filed req-0007 as Rhea mid-walk (Member of Observability Platform) and it appeared as a second row, so the inbox follows live state; Omar's own filing for Rhea never appears. After step 1 of req-0001 was decided the next load held only that other row. POST /requests/req-0002/steps/1/decide → 409 “already decided”
notes: Composer: help lists search approvals for/reset filters/refresh/open; “search approvals for rhea”; “reset filters”; “open req-0001” → the record; “approve req-0001” → “Command not recognized … No changes were made.” and the inbox still held req-0001. Mock reset before and after.
