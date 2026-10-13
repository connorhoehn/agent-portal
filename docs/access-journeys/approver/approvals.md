surface: approvals
role: approver
user: u-omar (Omar Haddad, Rhea's manager)
url: /access/approvals
pages: portal/src/pages/access/ApprovalsPage.tsx,portal/src/lib/accessRequests.ts
audited: 2026-10-13 15:03–15:07 local (re-walk on ui-components 2.442.2), Chromium 1456×940 (Playwright headless from portal/, a fresh context per run signed in through portal/e2e/realSession.ts openAs as u-omar — not the shared Chrome tab), Vite :5183 + middleware dev:mock :3001 (shared; u-rhea and u-priya walked concurrently; no 401 on my session)
session: /api/session/me sub u-omar, tenant access, role approver, grants {"access":["approver"]}
screenshot: approvals.jpg
verdict: pass
console errors: 0 (load, row Enter, composer phrases)
layout: pass — content column left 200 w 1256; trail "Approve › Approvals" at left 224 top 68; title 20/600 at top 111; the body row 44px, one line; composer docked 842–882; no horizontal scroll (1456/1456); 1 <main>; sizes 14/400×9, 14/500×1, 12/600×9, 12/400×2, 20/600×1
keyboard: pass — 7 really-visible focusables in main, Tab visited 8; Enter on the focused row → /access/requests/req-0001
empty-state: pass — "search approvals for zzzz" → "0 waiting"; after Omar approved step 1 of req-0001 (request.md, 15:05:26) the inbox read "Nothing is waiting on your decision."
role-gating: pass — the inbox is exactly the steps Omar may decide now: GET /api/access/approvals → [req-0001 submitted, can.decide true]. Row: req-0001, SME in Work, for Rhea Castellanos, 30 days, 3h ago, asked by Rhea Castellanos, your step "1 · Manager". req-0002 (steward step), req-0003 (his own) and req-0007 (the request he filed for Rhea in new-request.md) never appear. No row checkboxes (0)
notes: Composer: help says "approve, reject and request information stay explicit controls on that page. This input records no decision."; "search approvals for rhea" → 1 waiting; "reset filters"; "open req-0001" → the record; "approve req-0001" → "Command not recognized … No changes were made." and the inbox still held req-0001.
