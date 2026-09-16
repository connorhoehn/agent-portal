role: org-leader
user: u-vera
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-15 19:57 local, Chrome window (innerWidth 1692, innerHeight 858), middleware dev:mock (re-verification after the shell gained a SkipLink — portal/src/components/shell/Layout.tsx is in this log's pages: digest; every fact below re-taken, not carried forward)
assessment-tile-visible: no        # /select Workspaces tab: one tile, Org (orgiq · 2 roles: Member, Org Leader); no "Assessment" in the body text
assessment-nav-visible: no         # rail on /iq/projects (16 top-level entries incl. Budgets, Knowledge, Health, Architecture, Capabilities, Scores): zero anchors matching /assessment. CHANGED: 16, not the 17 the 2026-09-05 pass counted — Computer Lab is no longer on this role's rail
direct-route-result: redirect      # /assessment/teams → RequireTenant → "/" → /iq/projects ("Initiatives"). CHANGED: the 2026-09-05 passes landed on /select; home now routes this single-tenant user to the orgiq default surface instead of the picker
api-status: 403                    # fetch /api/assessment/teams → 403; POST /api/session/tenant {assessment} → 403
screenshot: org-leader.jpg
verdict: pass
notes: grants in /me are {orgiq:[org-leader, member]}. The release-manager role is the most privileged orgiq role that is still tenant-bound; nothing in the wider rail opens toward the assessment product.
re-verified 2026-09-05 04:05: all four facts hold — Workspaces tab shows only Org (1 tile, 2 roles: Member, Org Leader; no "Assessment" tile); rail as org-leader has zero `<a href>` containing "assessment"; `/assessment/teams` redirected to `/select`; `fetch('/api/assessment/teams')` returned 403.
re-verified 2026-09-05 08:33: all four facts still hold — Workspaces tab shows only Org (2 roles); as org-leader, rail has 0 assessment anchors; /assessment/teams redirected away (landed on /select); fetch('/api/assessment/teams') returned 403.
re-verified 2026-09-07 22:12 (local-compute presence merge, Layout.tsx): signed in from /select → "Sign in as" → Vera Green, then the Org tile's Org Leader row (`/api/session/me` = sub u-vera, tenant orgiq, role org-leader, grants {orgiq:[org-leader, member]}, availableTenants ["orgiq"]). Workspaces tab: one tile, Org (orgiq · 2 roles — Member, Org Leader); no "assessment" string anywhere in the picker text. Rail with every group expanded: Initiatives, Budgets, Library, Promotions, Designs, Knowledge, Automate, Distillation, Session config, Health, Architecture, Capabilities, Ask, Explore, Scores, Settings — 16 items, 0 anchors in `[data-shell-nav]` matching /assessment (the nested Automate rail is clean too). fetch('/api/assessment/teams') → 403; POST /api/session/tenant {assessment} → 403, session unchanged. /assessment/teams redirected to /iq/projects. Console errors: 0.
two numbers changed and both are recorded above: the rail is 16 entries (Computer Lab is gone for this role) and the direct-route landing is /iq/projects rather than /select. The new `LocalComputeBadge` is invisible to this session (`/api/local-compute/nodes` → 200 `{"nodes":[]}`), `.shell-header` stays 61px, no new control in the header, no horizontal scroll at 1552px.
re-verified 2026-09-07 23:50 (home-resolution fix, App.tsx + lib/tenantHome.ts): all four facts hold as u-vera. /select Workspaces shows ONE tile — Org (orgiq · 2 roles: Member, Org Leader) — no Assessment tile. Entering Org · Org Leader landed on /iq/projects, not /iq/work: the tenant switch reads the same `TENANT_HOME` that `/` does now, which also settles the friction org-leader/RAIL.md noted. Rail: 30 anchors (16 nav items + 14 repo shortcuts), 0 matching /assessment. /assessment/teams redirected to /iq/projects (h1 "Initiatives", 3240 chars). fetch('/api/assessment/teams') → 403; /api/local-compute/nodes → 200 (orgiq). `.shell-header` 61px, innerWidth 1552 = scrollWidth 1552, console errors 0.

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
  - identity: sub u-vera, tenant orgiq, role org-leader, grants
    {orgiq:[org-leader, member]}.
  - assessment-tile-visible: **no** — no "assessment" in /select's text.
  - assessment-nav-visible: **no** — 30 anchors on /iq/projects: the 16
    top-level entries the log records (Initiatives, Budgets, Library,
    Promotions, Designs, Knowledge, Automate, Distillation, Session config,
    Health, Architecture, Capabilities, Ask, Explore, Scores, Settings) plus 14
    repo shortcuts; **0** matching /assessment. Still 16, still no Computer Lab.
  - direct-route-result: **redirect** — /assessment/teams → /iq/projects, h1
    "Initiatives", 2562 chars of main.
  - api-status: **403** — /api/assessment/teams; POST /api/session/tenant
    {assessment} 403.
  - the badge: header 61px, no machine chip; /api/local-compute/nodes **200**,
    correct for an orgiq session.
Console errors: 0 across every navigation in this pass.

--- freshness re-observation, 2026-09-15 19:57 (the shell's SkipLink) ---
Why: Layout.tsx changed (the shell's SkipLink) and is in this log's pages: digest. Signed in from /select → Sign in as → Vera Green → Enter Org as Org Leader; /api/session/me = sub u-vera, grants {orgiq:[org-leader, member]}, role org-leader after the choice.
  - assessment-tile-visible: no — the Workspaces tab shows one tile, Org (orgiq · 2 roles: Member, Org Leader); body text has no "assessment".
  - assessment-nav-visible: no — 31 anchors in [data-shell-nav] on /iq/projects (the platform rail with Operate, plus the nested rail), 0 whose href matches /assessment.
  - direct-route-result: redirect — /assessment/teams landed on /iq/projects, h1 "Initiatives".
  - api-status: 403 — /api/assessment/teams; POST /api/session/tenant {assessment} 403 (curl cookie jar as u-vera agrees).
Console errors: 0 across every navigation in this pass.

--- re-verification 2026-09-16 03:58 (Layout.tsx changed: shell chrome pass) ---
Why: `portal/src/components/shell/Layout.tsx` changed — the site header is wrapped in a native
`<header>` landmark, the ⌘I devbox switcher now runs through the same CommandPalette as ⌘K
(a "Devbox" group, scoped while ⌘I is open), and the account menu's panel is the library
InlinePopover (outside-click / Escape / focus return from useDismissableLayer). None of this
touches tenant gating: the rail items, the palette's page list and the tenant guards are the
same code paths as before. Re-checked the API floor with fresh sessions: every orgiq persona
(u-theo, u-nora, u-mia, u-vera, u-rachel) still gets 403 from GET /api/assessment/teams, each
assessment persona (u-asha, u-jonas, u-farah) still gets 403 from GET /api/graph/people, and
the cookie-less demo identity gets 403 from /api/assessment/teams. Console errors 0 on the
shell as Vera Green.
