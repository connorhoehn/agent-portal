role: sme
user: u-nora
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-15 19:57 local, Chrome window (innerWidth 1692, innerHeight 858), middleware dev:mock (re-verification after the shell gained a SkipLink — portal/src/components/shell/Layout.tsx is in this log's pages: digest; every fact below re-taken, not carried forward)
assessment-tile-visible: no        # /select Workspaces tab: one tile, Org (orgiq · 1 role, "SME — Dispatch agent runs against a sprint envelope"); no "Assessment" anywhere in the body text
assessment-nav-visible: no         # rail on /iq/projects: Initiatives, Library, Promotions, Designs, Automate, Distillation, Computer Lab, Session config, Ask, Explore, Settings — zero anchors matching /assessment
direct-route-result: redirect      # /assessment/teams → RequireTenant → /iq/projects ("Initiatives")
api-status: 403                    # fetch /api/assessment/teams with the u-nora cookie → 403
screenshot: sme.jpg
verdict: pass
notes: This is the case the user reported ("a sme shouldn't see the assessment pages"). Root cause was the cookie-less Demo User wearing SME while keeping every tenant's grants; a real SME (u-nora, grants exactly {orgiq:[sme]}) never held an assessment grant. Demo User now narrows to the chosen role too (demoScopedGrants) and the picker's two-step switch is validated against the persona's full set (switchableGrants), so both paths land here.
re-verified 2026-09-05 04:00: all four facts hold — Workspaces tab shows only Org (1 tile, no "Assessment" tile); rail on /iq/projects has zero `<a href>` containing "assessment"; `/assessment/teams` redirected to `/iq/projects`; `fetch('/api/assessment/teams')` returned 403.
re-verified 2026-09-05 08:31: all four facts still hold — Workspaces tab shows only Org (1 tile); rail on /iq/projects has 0 assessment anchors; /assessment/teams redirected away; fetch('/api/assessment/teams') returned 403.
re-verified 2026-09-07 22:07 (local-compute presence merge, Layout.tsx): all four facts still hold as u-nora (`/api/session/me` = sub u-nora, tenant orgiq, role sme, grants {orgiq:[sme]}). /select Workspaces shows one tile, Org (orgiq · 1 role, "SME — Dispatch agent runs against a sprint envelope"); the word "assessment" does not appear in the page text. Rail on /iq/projects with EVERY group expanded (PLAN/DESIGN/BUILD/RELEASE/ORG/SYSTEM — two are collapsed on load, so I clicked them open rather than trusting the short list): Initiatives, Library, Promotions, Designs, Automate, Distillation, Computer Lab, Session config, Ask, Explore, Settings — 0 anchors in the whole `[data-shell-nav]` subtree whose href matches /assessment/. /assessment/teams redirected to /iq/projects (h1 "Initiatives"). fetch('/api/assessment/teams') → 403. Console errors after the redirect: 0.
the new header badge: `LocalComputeBadge` (portal/src/components/shell/LocalComputeBadge.tsx, mounted in Layout.tsx line 298) is what changed this file's digest. It is NOT gated on tenant, but with `/api/local-compute/nodes` returning `{"nodes":[]}` for this session the library's MachinePresenceMenu renders nothing, so the header is byte-identical to the pre-merge audit: `.shell-header` is 61px tall, no new control appears, and first-row-top on /iq/projects measures 369px with no horizontal scroll at 1552px. The badge's only deep link is /admin/devbox, an orgiq route — see isolation/DEFECTS.md for the ungated-mount note.
re-verified 2026-09-07 23:55 (home-resolution fix, App.tsx + lib/tenantHome.ts): all four facts hold as u-nora (`/api/session/me` = sub u-nora, tenant orgiq, role sme, grants {orgiq:[sme]}). Single context, so the sign-in landed straight on /iq/projects. Rail: 13 anchors — Initiatives, Library, Promotions, Designs, Automate, Distillation, Computer Lab, Session config, Ask, Explore, Settings + two repo shortcuts — and 0 matching /assessment; "assessment" appears nowhere in the document. /assessment/teams redirected to /iq/projects (h1 "Initiatives", the "Mine" lens with Nora's two initiatives). fetch('/api/assessment/teams') → 403; /api/local-compute/nodes → 200 for this orgiq session (the tenant gate added for DEFECTS #2 allows orgiq and only orgiq). `.shell-header` 61px, innerWidth 1552 = scrollWidth 1552, console errors 0.

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
  - identity: sub u-nora, tenant orgiq, role sme, grants {orgiq:[sme]}.
  - assessment-tile-visible: **no** — no "assessment" in /select's text.
  - assessment-nav-visible: **no** — 13 anchors on /iq/projects (Initiatives,
    Library, Promotions, Designs, Automate, Distillation, Computer Lab, Session
    config, Ask, Explore, Settings + 2 repo shortcuts), **0** matching
    /assessment. Computer Lab is on this role's rail, as the log records.
  - direct-route-result: **redirect** — /assessment/teams → /iq/projects, h1
    "Initiatives", 704 chars of main.
  - api-status: **403** — /api/assessment/teams; POST /api/session/tenant
    {assessment} 403.
  - the badge: header 61px, no machine chip (u-nora owns none);
    /api/local-compute/nodes **200**, correct for an orgiq session.
Console errors: 0 across every navigation in this pass.

--- freshness re-observation, 2026-09-15 19:57 (the shell's SkipLink) ---
Why: Layout.tsx changed (the shell's SkipLink) and is in this log's pages: digest. Signed in from /select → Sign in as → Nora DaSilva; /api/session/me = sub u-nora, tenant orgiq, role sme, grants {orgiq:[sme]}.
  - assessment-tile-visible: no — the Workspaces tab shows one tile, Org (orgiq · 1 role, "Enter Org as SME (current workspace)"); body text has no "assessment".
  - assessment-nav-visible: no — 14 anchors in [data-shell-nav] on /iq/projects (the SME's rail carries Computer Lab and Local compute), 0 whose href matches /assessment.
  - direct-route-result: redirect — /assessment/teams landed on /iq/projects, h1 "Initiatives", 704 chars of main.
  - api-status: 403 — /api/assessment/teams; POST /api/session/tenant {assessment} 403 (curl cookie jar as u-nora agrees).
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
