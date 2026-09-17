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

--- re-verification 2026-09-16 05:05 (Layout.tsx changed: ui-components 2.273.0 adoption) ---
Why: the shell's ChannelHeader renders as a real `<header>` (as="header") instead of being
wrapped, and the shell SubNavLayout carries `railLabel` ("Org navigation" / "Assessment
navigation"). Tenant gating is untouched. Re-checked the API floor with fresh sessions: every
orgiq persona (u-theo, u-nora, u-mia, u-vera, u-rachel) still gets 403 from GET
/api/assessment/teams, each assessment persona (u-asha, u-jonas, u-farah) still gets 403 from
GET /api/graph/people, and the cookie-less demo identity gets 403. Console errors 0.

--- freshness re-observation, 2026-09-16 08:20 (the shell rail moved off inline styles) ---
Why: `portal/src/components/shell/Layout.tsx` is in this log's `pages:` digest —
its `renderNavItem` stopped hand-computing an inline `style` object and now
returns ui-components 2.275.1's `activeNavItemClassName`/`inactiveNavItemClassName`.
That changes how a rail item is painted, not which items exist, but this log's
whole claim is about which items exist, so every fact below was re-taken rather
than carried forward.
  Rail, orgiq side (u-theo, member, /iq/projects): 11 anchors, 0 matching
  /assessment, the string "assessment" occurs 0 times in the document, exactly
  one item lit (Initiatives) and 0 anchors carry a `style` attribute.
  Rail, assessment side (u-asha, assessor, /assessment/teams): 8 anchors, 0
  matching /iq/ or /admin/, one lit (Dashboard), 0 inline styles.
  Direct routes: /assessment/teams as u-theo → /iq/projects (h1 "Initiatives"),
  no flash of assessment content; /iq/projects as u-asha → /assessment/teams
  (h1 "Assessor's desk").
  API floor, fresh cookie jars: GET /api/assessment/teams → 403 for u-theo,
  u-nora, u-mia, u-vera and u-rachel; GET /api/graph/people → 403 for u-asha,
  u-jonas and u-farah. Cookie-less: /api/assessment/teams 403, /api/graph/people
  404 (that route is not mounted for an anonymous caller, so no guard runs — it
  is recorded here as measured rather than as the 403 an earlier entry claimed).
Console errors: 0.
addendum, same session: `Layout.tsx` was edited once more after the observation above — the active rail item's fill class was swapped from the library's `bg-surface-hover` to `bg-primary-soft`, restoring the brand tint the branding cells record (see docs/branding-journeys/*.md, 2026-09-16 08:40). That is a `background-color` change on the one already-lit anchor: it adds, removes and re-targets no rail item, so every isolation fact re-taken above stands unchanged.
addendum, 2026-09-16 09:33: `Layout.tsx` changed again — the command palette's prompt text now reflects the scoped (⌘I) dialog instead of always advertising the full tenant search, and the shell rail is otherwise untouched. No rail item was added, removed or re-gated, so every isolation fact re-taken in the 08:20 entry above stands.

re-verified 2026-09-16 15:01 (observability taxonomy rename, Layout.tsx): the Operate rail item recorded above as "Health" now reads "Observability" — one line of NAV_ITEMS, gated `requireRoles: ['org-leader', 'hr-admin']` as before, so this role still reaches it and sees only the new label. Verified live in the hr-admin cell of this same set, on the same session (Rachel Kowalski holds both roles): rail reads Observability in place of Health, 0 /assessment anchors, `/api/assessment/teams` → 403. Reachability and tenant isolation unchanged. Console errors: 0. Re-audit 2026-09-16: the rail's Configuration row now admits assessor and lead-assessor alongside program-lead, matching the palette and the ungated route — the page renders read-only for them, Save stays behind canManage. Tenant isolation is unchanged: the row is still assessment-only and no orgiq surface appears. Console errors 0.
re-observed 2026-09-17: re-walked because Layout.tsx is in this log's freshness digest and it changed twice today — once to swap the library's nav class constants for local strings, once to put them back (see docs/branding-journeys for the measurements). Neither touch went near rail MEMBERSHIP: the whole diff is the two `activeNavItemClassName`/`inactiveNavItemClassName` bindings, i.e. how the active item is painted, not which items exist or who sees them. Confirmed live rather than reasoned: signed in to the assessment tenant as lead-assessor, the rail is exactly /assessment/teams · submissions · reports · feedback · enterprise · workspace · prompts · rules · runs · configuration plus /settings — eleven hrefs, and a filter for `/iq/` or `/admin/` over them returns the empty set. `platformItems` is computed as `onOrgiq ? … : []`, so a non-orgiq session gets no platform rail at all, which is the mechanism this log exists to pin. Everything recorded above still holds. Console errors 0.
