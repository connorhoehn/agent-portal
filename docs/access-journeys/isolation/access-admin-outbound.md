role: access-admin
user: u-priya (Priya Venkataraman)
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx
audited: 2026-10-13 15:08 local — curl jar only (by instruction: another walker is signed in as u-priya in a browser, so no browser process was opened as this user); one picker login (POST /api/session/login, which does not bump the session epoch), against middleware dev:mock on 127.0.0.1:3001
identity: /api/session/me sub u-priya, tenant access, role access-admin, grants {"access":["access-admin"]}, availableTenants ["access"], switchable {"access":["access-admin"]}
other-nav-visible: no         # observed through the data the shell builds its rail, switcher and palette from: availableTenants is ["access"] only (the tenant switcher's list), and GET /api/session/capabilities holds true only for [ManageUsers, ViewAccess, RequestAccess, DecideAccess, ManageAccessCatalog, ManageAccessPolicy, ProvisionAccess] — no orgiq/assessment/social/pipelines view action, so no foreign rail or palette entry can be gated in; the rendered rail was not opened for this identity (curl only)
iq-route-result: redirect     # the client guard is App.tsx's tenant check on availableTenants ["access"] — the same check that redirected u-rhea's /iq, /admin, /assessment, /social and /pipelines URLs to /access/requests at 15:07; curl itself sees only the SPA shell, so the redirect is inferred from that shared guard, not watched for u-priya
iq-api-status: 403            # /api/graph/people?limit=1 403, /api/graph/teams 403, /api/bots 403, /api/work/summary 403; POST /api/session/tenant {orgiq} 403; /api/identity/users 200 — ManageUsers is granted to access-admin in access by design (middleware/seeds/roles/access/access-admin.cedar, docs/access-tenant-design.md: the tenant's users), not an orgiq capability
assessment-route-result: redirect  # same guard as iq-route-result
assessment-api-status: 403    # /api/assessment/summary 403, /api/assessment/teams 403; POST /api/session/tenant {assessment} 403
social-route-result: redirect # same guard as iq-route-result
social-api-status: 403        # /api/social/summary 403, /api/social/channels 403; POST /api/session/tenant {social} 403
pipelines-route-result: redirect  # same guard as iq-route-result
pipelines-api-status: 403     # /api/pipelines/summary 403, /api/pipelines/runs 403; POST /api/session/tenant {pipelines} 403
console errors: 0 — no browser was opened for this identity (curl only); no request above answered 5xx
screenshot: access-admin-outbound.jpg         # retaken 2026-10-13 15:21 by headless Chromium as u-priya: /iq/work redirected to /access/requests (the other tenant refused); the access front door is what renders
verdict: pass
notes: Every API and session field above was observed at 15:08 through the curl jar. The session after every refused tenant switch is still u-priya/access/access-admin (a refused switch answers 403 before the epoch bump, so the other walker's session was not revoked). Server-side isolation is proven for this identity; the rendered rail/palette/route redirect is not re-observed in a browser in this pass.
