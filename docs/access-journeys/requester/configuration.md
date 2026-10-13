surface: configuration
role: requester
user: u-rhea (Rhea Castellanos)
url: /access/configuration (refused: redirects to /access/requests)
pages: portal/src/App.tsx,portal/src/pages/access/AccessLayout.tsx,portal/src/pages/access/ConfigurationPage.tsx
audited: 2026-10-13 07:04–07:10 local, Chromium 1680x940 (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183, ui-components 2.441.8
session: /api/session/me sub u-rhea, tenant access, role requester, grants {"access":["requester"]}
screenshot: configuration.jpg
verdict: pass
console errors: 0 (before, on the redirect, after Tab)
layout: pass — navigation history /access/configuration -> /access/requests; the landing: content col left 200 w 1480, trail at 224/68, title 224/111 at 20/600, no horizontal scroll (1680/1680), 1 <main>, 4 rows of 44px
type: landing page type: title 20/600; sizes 14/400x24, 12/600x10, 12/400x4, 10/600x4, 14/500x1, 20/600x1
keyboard: pass — Tab on the landing visits 11 stops in main plus composer controls; nothing traps focus after the redirect
empty-state: pass — no Configuration empty state exists for this role: the route is replaced by the redirect, no flash of the page
role-gating: pass — rail has no Configuration link; palette typed "Configur" lists only "Open reviews" (a fuzzy hit), no Configuration entry; typed "access" lists Open requests, New request, Catalog, Requests, Audit, Policies, Reviews, Open reviews, Access settings, Settings (no Approvals, no Configuration); API: GET /api/access/configuration 200 (durations, stewards, items: read-only data the wizard needs, readable by every access role) and PUT /api/access/configuration {} 403 (ManageAccessPolicy)
notes: What the requester sees instead of Configuration: a silent client-side redirect to /access/requests; rail, palette and route agree. The configuration route now exists in the API; the read is open, the write is refused. configuration.jpg is the landing after the redirect. Every field above was observed in this re-walk, not carried forward.
