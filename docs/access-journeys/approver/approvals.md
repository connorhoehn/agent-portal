surface: approvals
role: approver
user: u-omar (Omar Haddad, Rhea's manager)
url: /access/approvals
pages: portal/src/pages/access/ApprovalsPage.tsx,portal/src/lib/accessRequests.ts
audited: 2026-10-13 06:20–06:45 local, Chromium 1456×940 (Playwright headless from portal/node_modules, fresh context signed in by POST /api/session/login as u-omar, not the shared Chrome tab), Vite :5183 + middleware dev:mock :3001 (shared with other lanes: audit event counts drifted 15→20 mid-walk from another walker's writes)
session: /api/session/me sub u-omar, tenant access, role approver, grants {"access":["approver"]}
screenshot: approvals.jpg
verdict: pass
console errors: 0 (0 on load, after row open, composer phrases, and the empty re-render)
layout: pass — content col left 200 w 1256, trail left 224 top 68, title 14/600 (compact PageHeader, identical to /pipelines/approvals measured the same session; the protocol's 20/600 is not what any tenant renders now) at top 115; the one body row is 44px, one line; composer docked 841–883; no horizontal scroll (1456/1456); 1 <main>; sizes 14/400×9, 12/600×9, 12/400×2, 14/600×1
keyboard: pass — 7 really-visible focusables in main, Tab visited 8 in main; Enter on a focused row and a click both opened /access/requests/req-0001
empty-state: pass — after req-0001 step 1 was decided the table read “0 waiting on you — Nothing is waiting on your decision.”; searching “zzzz” reads “0 waiting on you — No waiting request matches this search.”
role-gating: pass — approver and access-admin only (requester: route redirects, see that role's log). Inbox = exactly the steps Omar may decide now: GET /api/access/approvals → [req-0001 can.decide true], equal to the can.decide set of scope=all (req-0001); req-0002 (waiting on the steward), req-0003 (own) and a fresh req-0007 Omar filed himself are absent. Row: req-0001, SME in Work, for Rhea Castellanos, 30 days, 3h ago, asked by Rhea Castellanos, your step “1 · Manager”. Writes: POST /requests/req-0002/steps/1/decide → 409 “already decided” (nothing written); the page has no decision control of its own (decisions are on the record)
notes: Composer: help lists search approvals for/reset filters/refresh/open (“Open shows on…”); “search approvals for rhea” → 1; “reset filters”; “open req-0001” navigates to the record; “approve req-0001” → “Command not recognized … No changes were made.” and the inbox still held req-0001. Mock reset before and after.
