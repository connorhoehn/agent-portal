surface: new-request
role: access-admin
user: u-priya (Priya Venkataraman)
url: /access/requests/new
pages: portal/src/pages/access/RequestNewPage.tsx,portal/src/lib/accessRequests.ts,middleware/src/routes/access.ts
audited: 2026-10-13 14:52–15:01 local, Chromium 148.0.7778.96 1680x940 (Playwright headless from portal/node_modules, fresh context per script, signed in by POST /api/session/login, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183, ui-components 2.442.2; GET /api/session/me: sub u-priya, tenant access, role access-admin, grants {"access":["access-admin"]}; no 401 during the walk
screenshot: new-request.jpg
verdict: pass
console errors: 0
layout: pass — no horizontal scroll (scrollWidth 1680); 1 <main>; the section rail folds at this depth, so the trail 'Request › Requests › New request' is the first row at left 68 = 44px strip + 24px gutter, top 68; h1 'New request' 20/600 at left 108 (after the back control), item chip beside it; compact WorkflowStepper (Who, What, Why, How long); each step heading is an h2 at 14/600; the radios are on the 12/14 scale — labels 14/500 ('Myself (Priya Venkataraman)', 'Someone who reports to me', '8 hours' … 'Standing'), descriptions 12/400 ('Approvers may request on behalf of a report', 'This item’s default'); no list, so no composer
keyboard: pass — 5 stops in main against 6 really-visible focusable (the two Who radios are one tab stop); Next is disabled whenever the step is invalid, with the reason printed beside it
empty-state: pass — Why with 9 characters: 'Say why in at least 20 characters (9 so far).' and Next disabled, counter '9 of at least 20 characters' → '69 of at least 20 characters'; How long → Standing adds 'Why standing access?' and Submit stays disabled until it is filled
role-gating: opened from the catalog row for Operator in Pipelines: the wizard starts at Who with the item preselected (chip in the header; What step shows it selected with 'No separation-of-duties conflict with the access you hold now.'); Who offers Myself and 'Someone who reports to me' (report select lists Omar Haddad); walked for herself, 7 days, Submit → /access/requests/req-0007 (14:56:45), a 1-step chain (Steward, escalated to the platform admins)
notes: req-0007 was this walk's own write; the mock was reset by another lane at about 15:00:08 and by me at 15:01:13. The What step's item select could not be cleared back to its empty choice by selectOption(''), so the 'Choose an item' state was read from the hint, not re-entered. new-request-duration.jpg is the How long step.
