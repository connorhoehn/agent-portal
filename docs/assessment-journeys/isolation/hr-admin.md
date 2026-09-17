role: hr-admin
user: u-rachel (Rachel Kowalski — CHANGED from u-hr: that account is not on the /select roster, so it could never have been audited through "Sign in as"; docs/orgiq-journeys/PROTOCOL.md names u-rachel as the hr-admin persona)
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-15 19:59 local, Chrome window (innerWidth 1692, innerHeight 858), middleware dev:mock (re-verification after the shell gained a SkipLink — portal/src/components/shell/Layout.tsx is in this log's pages: digest; every fact below re-taken, not carried forward)
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

--- freshness re-observation, 2026-09-15 19:59 (the shell's SkipLink) ---
Why: Layout.tsx changed (the shell's SkipLink) and is in this log's pages: digest. Signed in from /select → Sign in as → Rachel Kowalski → Enter Org as HR Admin; /api/session/me = sub u-rachel, grants {orgiq:[hr-admin, org-leader]}, role hr-admin after the choice.
  - assessment-tile-visible: no — the Workspaces tab shows one tile, Org (orgiq · 2 roles: HR Admin, Org Leader); body text has no "assessment".
  - assessment-nav-visible: no — 34 anchors in [data-shell-nav] on /iq/projects (the widest rail: Codebases, Computer Lab, Identity, plus the nested rail), 0 whose href matches /assessment.
  - direct-route-result: redirect — /assessment/teams landed on /iq/projects, h1 "Initiatives".
  - api-status: 403 — /api/assessment/teams; POST /api/session/tenant {assessment} 403 (curl cookie jar as u-rachel agrees).
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

re-verified 2026-09-16 15:01 (observability taxonomy rename, Layout.tsx): the Operate rail item recorded above as "Health" now reads "Observability" — one line of NAV_ITEMS, renamed because that rail is the parent of eighteen pages of which only four are about health, so its old name sat in the middle of every breadcrumb beneath it ("Operate › Health › Approval Queue"). Nothing about reachability changed. Re-read live as Rachel Kowalski (`/api/session/me` = sub u-rachel, tenant orgiq, role hr-admin): shell rail reads Initiatives, Budgets, Designs, Promotions, Library, Session config, Observability, Architecture, Knowledge, Capabilities, Ask, Explore, Scores; 0 anchors in `[data-shell-nav]` matching /assessment; `fetch('/api/assessment/teams')` → 403. Console errors: 0. Re-audit 2026-09-16: the rail's Configuration row now admits assessor and lead-assessor alongside program-lead, matching the palette and the ungated route — the page renders read-only for them, Save stays behind canManage. Tenant isolation is unchanged: the row is still assessment-only and no orgiq surface appears. Console errors 0.
re-observed 2026-09-17: re-walked because Layout.tsx is in this log's freshness digest and it changed twice today — once to swap the library's nav class constants for local strings, once to put them back (see docs/branding-journeys for the measurements). Neither touch went near rail MEMBERSHIP: the whole diff is the two `activeNavItemClassName`/`inactiveNavItemClassName` bindings, i.e. how the active item is painted, not which items exist or who sees them. Confirmed live rather than reasoned: signed in to the assessment tenant as lead-assessor, the rail is exactly /assessment/teams · submissions · reports · feedback · enterprise · workspace · prompts · rules · runs · configuration plus /settings — eleven hrefs, and a filter for `/iq/` or `/admin/` over them returns the empty set. `platformItems` is computed as `onOrgiq ? … : []`, so a non-orgiq session gets no platform rail at all, which is the mechanism this log exists to pin. Everything recorded above still holds. Console errors 0.
