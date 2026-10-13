surface: new-request
role: access-admin
user: u-priya (Priya Venkataraman)
url: /access/requests/new
pages: portal/src/pages/access/RequestNewPage.tsx,portal/src/lib/accessRequests.ts,middleware/src/routes/access.ts
audited: 2026-10-13 07:10 local, Chromium 148.0.7778.96 1680x940 (Playwright headless from portal/node_modules, fresh context, signed in by POST /api/session/login, not the shared Chrome tab), middleware dev:mock :3001 reset before and after, Vite :5183, ui-components 2.441.8; GET /api/session/me: sub u-priya, tenant access, role access-admin, grants {"access":["access-admin"]}
screenshot: new-request.jpg
verdict: pass
console errors: 0
layout: pass — no horizontal scroll (scrollWidth 1680 = innerWidth 1680); 1 <main>; trail (nav Breadcrumb) is the first row of the content column at top 68, left 224 = 200px rail + 24px gutter, 'Request › Requests › New request'; h1 20/600 at left 264; WorkflowStepper (Who, What, Why, How long); no list, no composer on a wizard
keyboard: pass — 5 stops in main against 6 focusable (the two 'who' radios are one tab stop); Next is disabled until each step is valid and the reason is printed beside it
empty-state: pass — step 'What': Next disabled with 'Choose an item'; step 'Why': 9 characters → 'Say why in at least 20 characters (9 so far)', Next disabled; Standing duration adds 'Why standing access?' and Submit stays disabled until it has 20 characters
role-gating: walked for herself: Who offers 'Myself' and 'Someone who reports to me' (no pick-anyone control: a report is chosen only from people who already have a request on file); What: 8 items, 'Operator in Pipelines' pre-check 'No separation-of-duties conflict'; Why counter; How long 8 hours / 24 hours / 7 days / 30 days / Standing; Submit → /access/requests/req-0007. File for anyone via API as access-admin: POST beneficiaryId u-theo → 201 req-0008 (requester u-priya, beneficiary u-theo); unknown u-nobody → 400; Operator in Pipelines for u-ines (an author) → 409 'Separation of duties blocks Operator in Pipelines for Ines Moreau' (sod-002)
notes: Walk requests were reset away. The wizard still cannot name an arbitrary person although the API lets an access admin file for anyone (kept in DEFECTS.md).
