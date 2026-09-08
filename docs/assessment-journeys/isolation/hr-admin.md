role: hr-admin
user: u-rachel (Rachel Kowalski — CHANGED from u-hr: that account is not on the /select roster, so it could never have been audited through "Sign in as"; docs/orgiq-journeys/PROTOCOL.md names u-rachel as the hr-admin persona)
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-07 22:13 EDT, Chrome 1552px, middleware dev:mock (re-audit after the local-compute presence merge)
assessment-tile-visible: no        # /select Workspaces tab: one tile, Org (orgiq · 2 roles: HR Admin, Org Leader); no "Assessment" in the body text. CHANGED from "1 role: HR Admin" — u-rachel holds both orgiq roles; u-hr, the account the old log named, is not on the picker
assessment-nav-visible: no         # rail on /iq/projects (19 top-level entries incl. Codebases, Computer Lab, Identity; 24 anchors counting the nested Automate rail): zero anchors matching /assessment
direct-route-result: redirect      # /assessment/teams → RequireTenant → /iq/projects ("Initiatives")
api-status: 403                    # fetch /api/assessment/teams → 403; POST /api/session/tenant {assessment} → 403
screenshot: hr-admin.jpg
verdict: pass
notes: grants in /me are {orgiq:[hr-admin]}. hr-admin holds ManageUsers in orgiq, and Identity → Users is on its rail; that surface manages orgiq users and cannot mint an assessment grant for itself (the grants write path is being tenant-scoped in the middleware fix pass).
re-verified 2026-09-05 04:08: all four facts hold — Workspaces tab shows only Org (1 tile, 1 role: HR Admin; no "Assessment" tile); rail on /iq/projects has zero `<a href>` containing "assessment"; `/assessment/teams` redirected to `/iq/projects`; `fetch('/api/assessment/teams')` returned 403.
re-verified 2026-09-05 08:34: all four facts still hold — Workspaces tab shows only Org (1 tile); rail on /iq/projects has 0 assessment anchors; /assessment/teams redirected to /iq/projects; fetch('/api/assessment/teams') returned 403.
re-verified 2026-09-07 22:13 (local-compute presence merge, Layout.tsx): re-audited as the real picker persona, Rachel Kowalski — /select → "Sign in as" → Rachel Kowalski → the Org tile's HR Admin row (`/api/session/me` = sub u-rachel, tenant orgiq, role hr-admin, grants {orgiq:[hr-admin, org-leader]}, availableTenants ["orgiq"]). Workspaces tab: one tile, Org (orgiq · 2 roles — HR Admin, Org Leader); no "assessment" string in the picker text. Rail with every group expanded: Initiatives, Budgets, Library, Promotions, Designs, Knowledge, Automate, Distillation, Codebases, Computer Lab, Session config, Health, Architecture, Capabilities, Ask, Explore, Scores, Settings, Identity (19) plus the nested Automate rail (Overview, Queue, Findings, Bots, Changes) — 0 anchors in `[data-shell-nav]` matching /assessment. fetch('/api/assessment/teams') → 403; POST /api/session/tenant {assessment} → 403, session unchanged. /assessment/teams redirected to /iq/projects (h1 "Initiatives"). Console errors: 0.
what changed: the identity (u-rachel, two roles) — recorded above — not the isolation facts. The new `LocalComputeBadge` is invisible to this session (`/api/local-compute/nodes` → 200 `{"nodes":[]}`) even though hr-admin is the one outside role that DOES carry Computer Lab on its rail; `.shell-header` stays 61px, no new header control, no horizontal scroll at 1552px.
re-verified 2026-09-07 23:52 (home-resolution fix, App.tsx + lib/tenantHome.ts): all four facts hold as u-rachel (grants {orgiq:[hr-admin, org-leader]} — no assessment grant despite the HR Admin capability set). /select offers "Enter Org as HR Admin" and "Enter Org as Org Leader" and nothing else; the string "assessment" does not occur in the picker's text. Entering Org · HR Admin landed on /iq/projects. Rail: 33 anchors, 0 matching /assessment. /assessment/teams redirected to /iq/projects (h1 "Initiatives", 3240 chars). fetch('/api/assessment/teams') → 403; /api/local-compute/nodes → 200 (orgiq). `.shell-header` 61px, innerWidth 1552 = scrollWidth 1552, console errors 0.

--- freshness re-observation, 2026-09-08 (the LocalComputeBadge tenant gate) ---
Why: `portal/src/components/shell/Layout.tsx` changed — `LocalComputeBadge` is
now mounted as `{session?.tenant === 'orgiq' && <LocalComputeBadge />}`, the fix
for DEFECTS.md #2 — and that file is part of this log's `pages:` digest. Every
field above was re-taken rather than carried forward. `npm run dev:mock` on
127.0.0.1:3011, portal on a Vite proxy pinned to it (:5186, then :5183 after this
box SIGTERMed the first dev server mid-pass), Chrome innerWidth 1552.
Method, stated because it is not the picker: except where noted, the identity was
established with `POST /api/session/login` (+ `POST /api/session/role` where the
persona holds more than one) — the same call the "Sign in as" card makes — and,
for an identity with more than one context, `sessionStorage['orgiq.contextChosen']`
was set to the sub, which is exactly what the chooser's `markContextChosen()`
does. That second step matters and is worth writing down: without it
`resolveHome` correctly routes a multi-context identity to /select, and a pass
that skipped it would have recorded a chooser stop as if it were the product's
answer to a cross-tenant URL. It is not.
Measured this pass:
  - identity: sub u-rachel, tenant orgiq, role hr-admin, grants
    {orgiq:[hr-admin, org-leader]}.
  - assessment-tile-visible: **no** — no "assessment" in /select's text.
  - assessment-nav-visible: **no** — 19 anchors on /iq/projects (Initiatives,
    Budgets, Library, Promotions, Designs, Knowledge, Automate, Distillation,
    Codebases, Computer Lab, Session config, Health, Architecture, Capabilities,
    Ask, Explore, Scores, Settings, Identity), **0** matching /assessment — the
    same 19 the log records, Codebases / Computer Lab / Identity included.
  - direct-route-result: **redirect** — /assessment/teams → /iq/projects, h1
    "Initiatives", 2562 chars of main.
  - api-status: **403** — /api/assessment/teams; POST /api/session/tenant
    {assessment} 403.
  - the badge: header 61px, no machine chip (u-rachel owns none);
    /api/local-compute/nodes **200**, correct for an orgiq session.
Console errors: 0 across every navigation in this pass.
