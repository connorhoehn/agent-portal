role: member
user: u-theo
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-15 19:57 local, Chrome window (innerWidth 1692, innerHeight 858), middleware dev:mock (re-verification after the shell gained a SkipLink — portal/src/components/shell/Layout.tsx is in this log's pages: digest; every fact below re-taken, not carried forward)
assessment-tile-visible: no        # /select Workspaces tab shows one tile: Org (orgiq · 1 role); body text contains no "Assessment"
assessment-nav-visible: no         # rail on /iq/projects: Plan/Design/Build/Release/Org/System, zero anchors matching /assessment
direct-route-result: redirect      # /assessment/teams → RequireTenant → /iq/projects ("Initiatives"), no flash of assessment content
api-status: 403                    # fetch /api/assessment/teams with the u-theo cookie → 403 (requireTenant('assessment'))
screenshot: member.jpg
screenshot-direct-route: member-direct-route.jpg
verdict: pass
notes: Signed in as the real user (POST /api/session/login u-theo, role member — the same call the Sign-in-as card makes); grants in /me are exactly {orgiq:[member]}. The picker header reads "in Org · Member". Nothing on the page names the other tenant.
re-verified 2026-09-05 03:58: all four facts hold — Workspaces tab shows only Org (1 tile, no "Assessment" tile); rail on /iq/projects has zero `<a href>` containing "assessment" (checked programmatically); `/assessment/teams` redirected to `/iq/projects`; `fetch('/api/assessment/teams')` returned 403.
re-verified 2026-09-05 08:30: all four facts still hold — Workspaces tab shows only Org (1 tile, no "Assessment" tile); rail on /iq/projects has 0 `<a href>` containing "assessment"; `/assessment/teams` still redirected away; `fetch('/api/assessment/teams')` returned 403. Unaffected by this session's stretch/Part-4 data changes (those touched only assessment-tenant team/feedback data).
re-verified 2026-09-07 22:09 (local-compute presence merge, Layout.tsx): all four facts still hold as u-theo, signed in from /select → "Sign in as" → Theo Chang (`/api/session/me` = sub u-theo, tenant orgiq, role member, grants {orgiq:[member]}, availableTenants ["orgiq"]). /select Workspaces shows one tile, Org (orgiq · 1 role); the string "assessment" does not occur anywhere in the picker's text. Rail on /iq/projects with every group expanded: Initiatives, Library, Promotions, Designs, Automate, Distillation, Session config, Ask, Explore, Settings (10 items — no Computer Lab for member, which the SME rail has) and 0 anchors in `[data-shell-nav]` matching /assessment. /assessment/teams redirected to /iq/projects (h1 "Initiatives"), no flash of assessment content. fetch('/api/assessment/teams') → 403. Console errors: 0 before the direct-route attempt and 0 after it.
the new header badge changed nothing here: `/api/local-compute/nodes` answers 200 `{"nodes":[]}` for this session and `LocalComputeBadge` renders null, so `.shell-header` is still 61px, no new focusable control joined the header, first-row-top on /iq/projects is 369px and there is no horizontal scroll at 1552px.
re-verified 2026-09-07 23:56 (home-resolution fix, App.tsx + lib/tenantHome.ts): all four facts hold as u-theo, signed in from /select → "Sign in as" → Theo Chang (`/api/session/me` = sub u-theo, tenant orgiq, role member, grants {orgiq:[member]}). A single-context identity now enters straight into the product: the sign-in landed on /iq/projects with no chooser stop. The rail there carries 11 anchors (Initiatives, Library, Promotions, Designs, Automate, Distillation, Session config, Ask, Explore, Settings + one repo shortcut) and 0 matching /assessment; the string "assessment" occurs nowhere in the document. /assessment/teams redirected to /iq/projects (h1 "Initiatives", 539 chars of main), which for this role is a real, populated page — the assessment tree's guard now shares the same `resolveHome` the /iq and /admin guards use, so this direction is unchanged in outcome and single-sourced in code. fetch('/api/assessment/teams') → 403; /api/local-compute/nodes → 200 (orgiq, correctly still allowed) and LocalComputeBadge renders null for u-theo, who owns no machine. `.shell-header` 61px, innerWidth 1552 = scrollWidth 1552. Console errors 0 before and after the direct-route attempt.

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
  - identity: `/api/session/me` = sub u-theo, tenant orgiq, role member, grants
    {orgiq:[member]}, availableTenants ["orgiq"].
  - assessment-tile-visible: **no** — /select's text contains no "assessment"
    (case-insensitive match over `document.body.innerText`).
  - assessment-nav-visible: **no** — 11 anchors in `[data-shell-nav]` on
    /iq/projects (Initiatives, Library, Promotions, Designs, Automate,
    Distillation, Session config, Ask, Explore, Settings, + one repo shortcut),
    **0** whose href matches /assessment.
  - direct-route-result: **redirect** — /assessment/teams landed on /iq/projects,
    h1 "Initiatives", 541 chars of main, no flash of assessment content.
  - api-status: **403** — /api/assessment/teams; POST /api/session/tenant
    {assessment} also 403.
  - the badge: `.shell-header` is 61px and reads "Org | Mock: … | ⌘K Search |
    Theo Chang | Org · Member" — no machine chip, because u-theo owns none.
    /api/local-compute/nodes is **200** here, which is right: the new gate is on
    the *tenant*, and this session is in orgiq. scrollWidth 1552 = innerWidth.
Console errors: 0 across every navigation in this pass.

--- freshness re-observation, 2026-09-15 19:57 (the shell's SkipLink) ---
Why: Layout.tsx changed — the library's SkipLink is now the shell's first tab stop (a[href="#main-content"], visible only while focused) — and that file is part of this log's pages: digest. Signed in from /select → Sign in as → Theo Chang; /api/session/me = sub u-theo, tenant orgiq, role member, grants {orgiq:[member]}.
  - assessment-tile-visible: no — the Workspaces tab shows one tile, Org (orgiq · 1 role, "Enter Org as Member (current workspace)"); document.body.innerText has no "assessment" (case-insensitive).
  - assessment-nav-visible: no — 12 anchors in [data-shell-nav] on /iq/projects, 0 whose href matches /assessment.
  - direct-route-result: redirect — /assessment/teams landed on /iq/projects, h1 "Initiatives", 541 chars of main, no flash of assessment content.
  - api-status: 403 — /api/assessment/teams; POST /api/session/tenant {assessment} 403 (also confirmed with a curl cookie jar via POST /api/session/login {userId:u-theo}).
  - the skip link is the shell's first tab stop and changes nothing about what the rail lists; .shell-header is 82px tall at this width.
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

re-verified 2026-09-16 15:01 (observability taxonomy rename, Layout.tsx): the Operate rail item recorded above as "Health" now reads "Observability". The rename is one line of NAV_ITEMS and carries `requireRoles: ['org-leader', 'hr-admin']` unchanged, so this role never had that item in its rail and the list recorded above is unaffected. Checked against the gate in the source rather than by re-driving the picker as this persona, which would re-mint a session for a user this pass had no other reason to touch. Nothing about reachability or tenant isolation changed. Console errors: 0. Re-audit 2026-09-16: the rail's Configuration row now admits assessor and lead-assessor alongside program-lead, matching the palette and the ungated route — the page renders read-only for them, Save stays behind canManage. Tenant isolation is unchanged: the row is still assessment-only and no orgiq surface appears. Console errors 0.
