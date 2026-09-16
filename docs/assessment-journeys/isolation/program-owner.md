role: program-owner
user: u-mia
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-15 19:57 local, Chrome window (innerWidth 1692, innerHeight 858), middleware dev:mock (re-verification after the shell gained a SkipLink — portal/src/components/shell/Layout.tsx is in this log's pages: digest; every fact below re-taken, not carried forward)
assessment-tile-visible: no        # /select Workspaces tab: one tile, Org (orgiq · 2 roles: Member, Program Owner); no "Assessment" in the body text
assessment-nav-visible: no         # rail on /iq/projects: Initiatives, Budgets, Library, Promotions, Designs, Automate, Distillation, Computer Lab, Session config, Ask, Explore, Settings — zero anchors matching /assessment
direct-route-result: redirect      # /assessment/teams → RequireTenant → "/" → /iq/projects ("Initiatives"). CHANGED: the 2026-09-05 passes landed on /select (and once on /iq/work); the home route now sends this single-tenant, two-role user straight to the orgiq default surface instead of back to the picker. Still a redirect out of the tenant, which is the fact this log asserts.
api-status: 403                    # fetch /api/assessment/teams → 403; POST /api/session/tenant {assessment} → 403 (no grant in that tenant)
screenshot: program-owner.jpg
verdict: pass
notes: grants in /me are {orgiq:[program-owner, member]}. The tenant switch is refused server-side as well as hidden client-side, so the tile could not be reached even by crafting the request.
re-verified 2026-09-05 04:02: all four facts hold — Workspaces tab shows only Org (1 tile, 2 roles: Member, Program Owner; no "Assessment" tile); rail on `/iq/work` (as program-owner) has zero `<a href>` containing "assessment"; `/assessment/teams` redirected to `/select`; `fetch('/api/assessment/teams')` returned 403.
re-verified 2026-09-05 08:32: all four facts still hold — Workspaces tab shows only Org (2 roles, no Assessment tile); as program-owner, rail has 0 assessment anchors; /assessment/teams redirected away (landed on /iq/work, the role's default); fetch('/api/assessment/teams') returned 403.
re-verified 2026-09-07 22:11 (local-compute presence merge, Layout.tsx): signed in from /select → "Sign in as" → Mia Singh, then the Org tile's Program Owner row (`/api/session/me` = sub u-mia, tenant orgiq, role program-owner, grants {orgiq:[program-owner, member]}, availableTenants ["orgiq"]). Workspaces tab: one tile, Org (orgiq · 2 roles — Member, Program Owner); no "assessment" string in the picker text. Rail with every group expanded: Initiatives, Budgets, Library, Promotions, Designs, Automate, Distillation, Session config, Ask, Explore, Settings — 0 anchors in `[data-shell-nav]` matching /assessment (the nested Automate rail — Overview, Queue, Findings, Bots, Changes — is also clean). fetch('/api/assessment/teams') → 403; POST /api/session/tenant {assessment} → 403 and the session stayed program-owner/orgiq afterwards. /assessment/teams redirected to /iq/projects. Console errors: 0.
one number changed: the direct-route landing is /iq/projects, not /select — see the header line. The new `LocalComputeBadge` in the header is invisible to this session (`/api/local-compute/nodes` → 200 `{"nodes":[]}`), `.shell-header` is 61px as before, no new control, no horizontal scroll at 1552px.
re-verified 2026-09-07 23:53 (home-resolution fix, App.tsx + lib/tenantHome.ts): all four facts hold as u-mia. /select Workspaces shows ONE tile — Org (orgiq · 2 roles: Member, Program Owner) — and the string "assessment" does not occur anywhere in the picker's text. Entering Org · Program Owner landed on /iq/projects (it landed on /iq/work before this fix; the tenant switch and `/` now give the same answer, from lib/tenantHome.ts). Rail: 25 anchors, 0 matching /assessment. /assessment/teams redirected to /iq/projects (h1 "Initiatives", 3240 chars of main). fetch('/api/assessment/teams') → 403; /api/local-compute/nodes → 200 (orgiq). `.shell-header` 61px, innerWidth 1552 = scrollWidth 1552, console errors 0.

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
  - identity: sub u-mia, tenant orgiq, role program-owner, grants
    {orgiq:[program-owner, member]}.
  - assessment-tile-visible: **no** — no "assessment" in /select's text.
  - assessment-nav-visible: **no** — 25 anchors on /iq/projects: the 11 rail
    items (Initiatives, Budgets, Library, Promotions, Designs, Automate,
    Distillation, Session config, Ask, Explore, Settings) plus 14 repo
    shortcuts; **0** matching /assessment.
  - direct-route-result: **redirect** — /assessment/teams → /iq/projects, h1
    "Initiatives", 2562 chars of main.
  - api-status: **403** — /api/assessment/teams; POST /api/session/tenant
    {assessment} 403.
  - the badge: header 61px, no machine chip; /api/local-compute/nodes **200**,
    correct for an orgiq session.
Console errors: 0 across every navigation in this pass.

--- freshness re-observation, 2026-09-15 19:57 (the shell's SkipLink) ---
Why: Layout.tsx changed (the shell's SkipLink) and is in this log's pages: digest. Signed in from /select → Sign in as → Mia Singh → Enter Org as Program Owner; /api/session/me = sub u-mia, grants {orgiq:[program-owner, member]}, role program-owner after the choice.
  - assessment-tile-visible: no — the Workspaces tab shows one tile, Org (orgiq · 2 roles: Member, Program Owner); body text has no "assessment".
  - assessment-nav-visible: no — 26 anchors in [data-shell-nav] on /iq/projects (top rail plus the Initiatives page's nested rail), 0 whose href matches /assessment.
  - direct-route-result: redirect — /assessment/teams landed on /iq/projects, h1 "Initiatives".
  - api-status: 403 — /api/assessment/teams; POST /api/session/tenant {assessment} 403 (curl cookie jar as u-mia agrees).
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
