surface: approvals
role: requester
user: u-rhea (Rhea Castellanos)
url: /access/approvals (refused: redirects to /access/requests)
pages: portal/src/App.tsx,portal/src/pages/access/AccessLayout.tsx,portal/src/pages/access/ApprovalsPage.tsx
audited: 2026-10-13 07:04–07:10 local, Chromium 1680x940 (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183, ui-components 2.441.8
session: /api/session/me sub u-rhea, tenant access, role requester, grants {"access":["requester"]}
screenshot: approvals.jpg
verdict: pass
console errors: 0 (before navigating, on the redirect, after Tab)
layout: pass — navigation history /access/approvals -> /access/requests; the landing: content col left 200 w 1480, trail at 224/68, title 224/111 at 20/600, no horizontal scroll (1680/1680), 1 <main>, 4 rows of 44px
type: landing page type: title 20/600; sizes 14/400x24, 12/600x10, 12/400x4, 10/600x4, 14/500x1, 20/600x1
keyboard: pass — Tab on the landing visits 11 stops in main (About, New request, search, Filters, Refresh, 4 rows, Agent mode, composer) plus composer controls; no focus trap from the redirect
empty-state: pass — there is no Approvals empty state for this role: the surface is replaced by the redirect; a deep link never renders a page
role-gating: pass — rail has no Approvals link (Catalog, Requests, Policies, Reviews, Audit, Settings only); command palette typed "Approv" lists Open requests, Requests, Open reviews (a fuzzy hit on "Campaigns still waiting on decisions"), Access settings — no Approvals entry; GET /api/access/approvals 403 {action DecideAccess, role requester}; POST /requests/req-0001/steps/1/decide {} 403; GET /api/access/summary 200 {openRequests 2, pendingForMe 0, activeElevations 0, policies 4, reviews 1}
notes: What the requester sees instead of Approvals: a silent client-side redirect to /access/requests. Rail, palette and route agree. approvals.jpg is the landing after the redirect. Every field above was observed in this re-walk, not carried forward.
