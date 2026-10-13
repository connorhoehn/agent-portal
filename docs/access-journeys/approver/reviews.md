surface: reviews
role: approver
user: u-omar (Omar Haddad, Rhea's manager)
url: /access/reviews
pages: portal/src/pages/access/ReviewsPage.tsx,portal/src/pages/access/ReviewRecordPage.tsx
audited: 2026-10-13 15:03–15:07 local (re-walk on ui-components 2.442.2), Chromium 1456×940 (Playwright headless from portal/, a fresh context per run signed in through portal/e2e/realSession.ts openAs as u-omar — not the shared Chrome tab), Vite :5183 + middleware dev:mock :3001 (shared; u-rhea and u-priya walked concurrently; no 401 on my session)
session: /api/session/me sub u-omar, tenant access, role approver, grants {"access":["approver"]}
screenshot: reviews.jpg
verdict: pass
console errors: 0 on the list, the record and the composer; the one 404 is the expected /access/reviews/rev-missing lookup
layout: pass — list: content column left 200 w 1256, trail "Govern › Reviews" at left 224 top 68, title 20/600 at top 111, one row (rev-0001) 44px, composer docked 842–882, no horizontal scroll (1456/1456), 1 <main>, sizes 14/400×7, 12/600×9, 12/400×2, 20/600×1. Record /access/reviews/rev-0001: title "Q4 SME certification — Work" 20/600 at left 264 top 111, 4 item rows all 44px, composer docked 842–882, no horizontal scroll
keyboard: pass — list: 8 really-visible focusables, Tab visited 9; "open rev-0001" and a row both reach /access/reviews/rev-0001; record: 8 really-visible focusables, Tab visited 9
empty-state: pass — /access/reviews/rev-missing renders "Campaign not found — No review campaign rev-missing."
role-gating: pass — list: rev-0001, Q4 SME certification — Work, Work, owner Priya Venkataraman, open, 5d ago. Record: "2 of 4 decided · 2 kept · 0 revoked"; Caleb Turner and Layla Hassan undecided, Eli Garcia and Nora DaSilva kept by Priya with comments. Omar is neither owner nor admin: 0 Keep/Revoke buttons in the DOM, GET /reviews/rev-0001 can {"decide":false}. POST …/items/ri-0004/decide {decision:'keep'} → 403 "Only the owner of rev-0001 or an access admin decides its items"; POST /reviews {} → 403 ManageAccessPolicy; nothing written. No row checkboxes (0)
notes: Composer: help says "Commands never start, decide or close a review"; "search reviews for sme" → 1 of 1 campaigns; "reset filters"; "approve req-0001" → "Command not recognized … No changes were made."; "open rev-0001" → the record. The record's trail stops at "Govern › Reviews" and does not name the campaign (the request and policy records name theirs).
