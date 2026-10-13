surface: configuration
role: requester
user: u-rhea (Rhea Castellanos)
url: /access/configuration (refused: redirects to /access/requests)
pages: portal/src/App.tsx,portal/src/pages/access/AccessLayout.tsx,portal/src/pages/access/ConfigurationPage.tsx
audited: 2026-10-13 14:56–15:03 local, Chromium 1680x940 (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183, ui-components 2.442.2
session: /api/session/me sub u-rhea, tenant access, role requester, grants {"access":["requester"]}
screenshot: configuration.jpg
verdict: pass
console errors: 0 (before navigating, on the redirect, after Tab)
layout: pass — navigation history /access/configuration -> /access/requests; the landing: content col left 200 w 1480, trail "Request › Requests" at 224/68, title "Requests" 224/111 at 20/600, no horizontal scroll (1680/1680), 1 <main>, 4 rows of 44px, composer docked at y 842–882
type: landing page type: title 20/600; sizes 14/400x24, 12/600x10, 12/400x4, 10/600x4, 14/500x1, 20/600x1
keyboard: pass — Tab on the landing visits 12 stops (About, New request, search, Filters, Refresh, 4 rows, Agent mode, composer, Bold); nothing traps focus after the redirect
empty-state: pass — there is no Configuration empty state for this role: the route is replaced by the redirect; a deep link never renders the page
role-gating: pass — rail has no Configuration link; palette typed "Configur" lists only "Open reviews" (a fuzzy hit); typed "access" lists Open requests, New request, Catalog, Requests, Audit, Policies, Reviews, Open reviews, Access settings, Settings (no Approvals, no Configuration); API: GET /api/access/configuration 200 (durations 8h/24h/7d/30d/standing, standingReasonMin 20, stewards, items: read-only data the wizard needs) and PUT /api/access/configuration {} 403 (ManageAccessPolicy)
notes: What the requester sees instead of Configuration: a silent client-side redirect to /access/requests; rail, palette and route agree. configuration.jpg is the landing after the redirect. Every field above was observed in this re-walk, not carried forward.
