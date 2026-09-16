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
