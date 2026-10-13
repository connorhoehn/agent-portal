surface: configuration
role: requester
user: u-rhea (Rhea Castellanos)
url: /access/configuration (refused: redirects to /access/requests)
pages: portal/src/App.tsx,portal/src/pages/access/AccessLayout.tsx,portal/src/pages/access/ConfigurationPage.tsx
audited: 2026-10-13 06:20–06:33 local, Chromium 1680x940 (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183
session: /api/session/me sub u-rhea, tenant access, role requester, grants {"access":["requester"]}
screenshot: configuration.jpg
verdict: pass
console errors: 0 (before, on the redirect, after Tab)
layout: pass — the route redirects (history /access/configuration -> /access/requests) and the landing is the requests page: content col left 200 w 1480, trail at 224/68, no horizontal scroll (1680/1680), 1 <main>, 4 rows of 44px; the landing's 14/600 title is recorded under requests.md (D1)
type: landing page type measured as on requests.md (title 14/600; sizes 14/400x24, 12/600x10, 12/400x4, 10/600x4)
keyboard: pass — Tab on the landing visits 11 stops in main plus Bold; nothing traps focus after the redirect
empty-state: pass — no Configuration empty state exists for this role: the route is replaced by the redirect, with no flash of the page
role-gating: pass — rail has no Configuration link; command palette typed "Configur" -> "No results."; palette typed "access" lists Open requests, New request, Catalog, Requests, Audit, Policies, Reviews, Access settings, Settings (no Approvals, no Configuration); there is no /api/access/configuration route at all (GET and PUT answer the Express HTML 404, not a 403), the page reads GET /api/access/catalog, so the API-level refusal here is the missing route plus ManageAccessCatalog/ManageAccessPolicy checks on writes, not a Cedar answer
notes: What the requester sees instead of Configuration: a silent client-side redirect to /access/requests; rail, palette and route agree. Screenshot configuration.jpg is the landing page after the redirect. Every field above was observed in this pass, not carried forward.
