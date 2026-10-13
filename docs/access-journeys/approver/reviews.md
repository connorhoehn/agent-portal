surface: reviews
role: approver
user: u-omar (Omar Haddad, Rhea's manager)
url: /access/reviews
pages: portal/src/pages/access/ReviewsPage.tsx
audited: 2026-10-13 07:10–07:35 local (re-walk after the coordinator's fixes: ui-components 2.441.8 and the access fixes), Chromium 1456×940 (Playwright headless from portal/node_modules, fresh context signed in by POST /api/session/login as u-omar, not the shared Chrome tab), Vite :5183 + middleware dev:mock :3001 (shared with other lanes: another walker's policy toggles and a Rhea-filed request appeared mid-walk)
session: /api/session/me sub u-omar, tenant access, role approver, grants {"access":["approver"]}
screenshot: reviews.jpg
verdict: pass
console errors: 0 (list, record open, composer; the 4xx lines are my deliberate API probes and the expected 404 on rev-missing)
layout: pass — list: content col left 200 w 1256, trail left 224 top 68, title 20/600 at top 111, one row (rev-0001) 44px, composer docked 841–883, no horizontal scroll (1456/1456), 1 <main>, sizes 14/400×7, 12/600×9, 20/600×1; record /access/reviews/rev-0001: trail left 224 top 68, title “Q4 SME certification — Work” 20/600 (left 264, top 111), 4 item rows all 44px, composer docked 841–883, no horizontal scroll
keyboard: pass — list: 8 really-visible focusables in main, Tab visited 9; Enter on a focused row → /access/reviews/rev-0001, a click does the same; record: 12 really-visible focusables, Tab visited 13 in main; browser Back → /access/reviews
empty-state: pass — /access/reviews/rev-missing renders “Campaign not found — No review campaign rev-missing.”
role-gating: pass — list: rev-0001, Q4 SME certification — Work, workspace Work, owner Priya Venkataraman, open, opened 5d ago. Record: “2 of 4 decided · 2 kept · 0 revoked”; Caleb Turner and Layla Hassan undecided, Eli Garcia and Nora DaSilva kept by Priya with comments. Omar is neither owner nor admin: 0 Keep/Revoke controls in the DOM and GET /reviews/rev-0001 reports can.decide false. Writes: POST /reviews/rev-0001/items/ri-0004/decide {} → 400 “decision must be keep or revoke”; {decision:'keep'} → 403 “Only the owner of rev-0001 or an access admin decides its items”; {decision:'zz'} → 400; POST /reviews {} → 403 ManageAccessPolicy; GET /reviews/rev-missing → 404 “No review rev-missing”; nothing was written
notes: Composer: help lists search/show open|closed reviews/reset filters/refresh/open <exact ID or title>; “search reviews for sme”; “open rev-0001” → the record; “approve req-0001” → “Command not recognized … No changes were made.”. The A2 empty table is gone: the list is now a real collection.
