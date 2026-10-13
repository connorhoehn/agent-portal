surface: reviews
role: requester
user: u-rhea (Rhea Castellanos)
url: /access/reviews
pages: portal/src/pages/access/ReviewsPage.tsx
audited: 2026-10-13 06:20–06:33 local, Chromium 1680x940 (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183
session: /api/session/me sub u-rhea, tenant access, role requester, grants {"access":["requester"]}
screenshot: reviews.jpg
verdict: fail — page title renders 14/600 instead of the documented 20/600 (D1, platform-wide); the honest A2 empty table passed
console errors: 0 (before, after Tab, after every composer phrase)
layout: fail on title only — content col left 200 w 1480, top 44, bottom 891; trail "Govern › Reviews" at 224/68; title at 224/115; no horizontal scroll (1680/1680); 1 <main>; the empty state is one 85px row (no data rows); composer docked at the bottom
type: title 14/600 (h1), not the documented 20/600 — platform-wide today, /pipelines/runs as u-ines also measures 14px/600 (see DEFECTS.md D1); sizes in main: 14/400x3, 12/600x6, 12/400x2, 14/500x1, 14/600x1
keyboard: pass — 6 Tab stops in main (About Reviews, search, About results, Refresh, Agent mode, composer) plus Bold, all visited
empty-state: pass — the table is the honest empty state: "No review campaigns yet. A review asks a reviewer to keep or revoke each standing grant in one workspace. A2 brings campaigns." with the header "0 campaigns"; searching "zzzqq" gives "No campaign matches this search."
role-gating: pass — no Save, no start/close review controls (buttons: About, About results, Refresh, Agent, Apply disabled); composer help says "Commands never start, decide or close a review"; `approve req-0001` -> "Command not recognized … No changes were made."; GET /api/access/reviews is readable by every access role (summary reviews: 0)
notes: Composer phrases observed: help, search reviews for q3, reset filters, refresh ("Refreshing reviews."), the refused approve. Names lane A2 as the owner. Every field above was observed in this pass, not carried forward.
