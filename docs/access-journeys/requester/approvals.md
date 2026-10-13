surface: approvals
role: requester
user: u-rhea (Rhea Castellanos)
url: /access/approvals (refused: redirects to /access/requests)
pages: portal/src/App.tsx,portal/src/pages/access/AccessLayout.tsx,portal/src/pages/access/ApprovalsPage.tsx
audited: 2026-10-13 06:20–06:33 local, Chromium 1680x940 (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183
session: /api/session/me sub u-rhea, tenant access, role requester, grants {"access":["requester"]}
screenshot: approvals.jpg
verdict: pass
console errors: 0 (before navigating, on the redirect, after Tab)
layout: pass — the route redirects (history /access/approvals -> /access/requests) and the landing is the requests page: content col left 200 w 1480, trail at 224/68, no horizontal scroll (1680/1680), 1 <main>, 4 rows of 44px; the landing's 14/600 title is recorded under requests.md (D1)
type: landing page type measured as on requests.md (title 14/600; sizes 14/400x24, 12/600x10, 12/400x4, 10/600x4)
keyboard: pass — Tab on the landing visits 11 stops in main (About, New request, search, Filters, Refresh, 4 rows, Agent mode, composer) plus Bold; no focus trap from the redirect
empty-state: pass — there is no Approvals empty state for this role: the surface is replaced by the redirect; a deep link to /access/approvals never renders a page or a flash of the inbox
role-gating: pass — rail has no Approvals link (Catalog, Requests, Policies, Reviews, Audit, Settings only); command palette typed "Approv" -> "Open requests / Requests / Access settings", no Approvals entry (the "Open requests" item is the requests filter); GET /api/access/approvals 403 {action DecideAccess, role requester}; POST /requests/req-0001/steps/1/decide {} 403; GET /api/access/summary 200 {openRequests 2, pendingForMe 0, activeElevations 0, policies 4, reviews 0}
notes: What the requester sees instead of Approvals: a silent client-side redirect (HomeRedirect) to /access/requests. Rail, palette and route agree. Screenshot approvals.jpg is the landing page after the redirect. Every field above was observed in this pass, not carried forward.
