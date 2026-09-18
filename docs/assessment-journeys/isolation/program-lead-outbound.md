role: program-lead
user: u-farah
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-18 04:4x local, Chrome 1512px, middleware dev:mock on 127.0.0.1:3013 behind a Vite proxy pinned to it
orgiq-nav-visible: no              # rail on /assessment/teams: Dashboard, Submissions, Reports, Feedback, Enterprise, Workspace, Prompts, Rules, Activity, Configuration, Settings (11 anchors — Configuration is this role's extra) — 0 matching ^/(iq|admin|newsroom)
orgiq-route-result: redirect       # measured this pass: /iq/projects → /assessment/teams (main 1068 chars); /iq/scores → /assessment/teams (1068); /admin/observability → /assessment/teams (1068); /admin/identity/users → /assessment/teams; / → /assessment/teams (1068). The URL always moves and the landing page is populated.
orgiq-api-status: 403              # /api/graph/people?limit=1 → 403, /api/scores/leaderboard → 403, /api/work/queue → 403, /api/local-compute/nodes → 403, POST /api/session/tenant {orgiq} → 403 (session stayed on assessment)
newsroom-route-result: n/a         # the newsroom tenant was deleted 2026-09-05; there is no /newsroom route left to test, so this line is history, not a claim re-observed in this pass
screenshot: program-lead-outbound.jpg  # what typing /iq/projects gets you now: the assessment dashboard under the assessment breadcrumb, signed in as Farah · program-lead
verdict: pass
notes: Signed in from /select → "Sign in as" → Farah Osei, then the Assessment tile's Program Lead row; `/api/session/me` = sub u-farah, tenant assessment, role program-lead, grants {assessment:[program-lead, lead-assessor]}. `.shell-header` 61px, innerWidth 1552 = scrollWidth 1552, console errors 0 throughout. The fix under test: portal/src/lib/tenantHome.ts is now the single home resolution (`resolveHome`), and App.tsx's guards all fall back to one `<HomeRedirect />` that uses it — so a refused tree sends you where `/` would send you, and if that resolves to the page you are already on it renders not-found instead of bouncing. The two orgiq trees no longer name `/iq/projects` as their own fallback. Farah, like Jonas, holds two contexts, so she also depended on the `markContextChosen` re-mark described in lead-assessor-outbound.md; the marker read "u-farah" for every measurement above.
defect #2 (LocalComputeBadge) is closed as observed here: `GET /api/local-compute/nodes` → 403 for this session, and `demo-macbook` occurs nowhere in the document.
re-verified 2026-09-05 04:21: rail as program-lead still has zero `<a href>` matching `^/(iq|admin|newsroom)`; `/iq/projects` redirected to `/select`; `fetch('/api/graph/people?limit=1')` returned 403.
re-verified 2026-09-05 08:39: rail as program-lead still has 0 anchors matching ^/(iq|admin|newsroom); /iq/projects redirected to /select; fetch('/api/graph/people?limit=1') returned 403.
re-verified 2026-09-07 22:20 (local-compute presence merge, Layout.tsx): the pass that filed DEFECTS #1 — /iq/projects did not redirect, the URL stayed put and the content column was empty under the orgiq breadcrumb "Plan › Initiatives". Kept here as the before-state.

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
  - identity: sub u-farah, tenant assessment, role program-lead, grants
    {assessment:[program-lead, lead-assessor]}.
  - orgiq-nav-visible: **no** — 11 anchors on /assessment/teams (Dashboard,
    Submissions, Reports, Feedback, Enterprise, Workspace, Prompts, Rules,
    Activity, Configuration, Settings — Configuration is this role's extra),
    **0** matching ^/(iq|admin|newsroom).
  - orgiq-route-result: **redirect** — /iq/projects → /assessment/teams (h1
    "Engineering maturity cohorts", 1068 chars) and /admin/identity/users → the
    same, 1068 chars. The URL always moves and the landing page is populated.
  - orgiq-api-status: **403** — /api/graph/people?limit=1,
    /api/scores/leaderboard, /api/work/queue and /api/local-compute/nodes; POST
    /api/session/tenant {orgiq} 403, session still `assessment` afterwards.
  - the badge: no machine chip in the header and 403 on the endpoint, from both
    the per-route server gate and the new shell gate.
Console errors: 0 across every navigation in this pass.

--- freshness re-observation, 2026-09-15 20:02 (the shell's SkipLink) ---
Why: Layout.tsx changed (the shell's SkipLink) and is in this log's pages: digest. Signed in from /select → Sign in as → Farah Osei → "Enter Assessment as Program Lead" (sets orgiq.contextChosen = u-farah); /api/session/me = sub u-farah, tenant assessment, role program-lead, grants {assessment:[program-lead, lead-assessor]}.
  - orgiq-nav-visible: no — 11 anchors in [data-shell-nav] on /assessment/teams (the assessor's ten plus Configuration), 0 whose href starts with /iq/ or /admin/.
  - orgiq-route-result: redirect — /iq/projects landed on /assessment/teams, h1 "Assessor's desk".
  - orgiq-api-status: 403 — /api/graph/people?limit=1; curl cookie jar as u-farah: /api/scores/leaderboard 403, /api/work/queue 403, /api/local-compute/nodes 403, POST /api/session/tenant {orgiq} 403.
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
re-observed 2026-09-17: re-walked because Layout.tsx is in this log's freshness digest and it changed twice today — once to swap the library's nav class constants for local strings, once to put them back (see docs/branding-journeys for the measurements). Neither touch went near rail MEMBERSHIP: the whole diff is the two `activeNavItemClassName`/`inactiveNavItemClassName` bindings, i.e. how the active item is painted, not which items exist or who sees them. Confirmed live rather than reasoned: signed in to the assessment tenant as lead-assessor, the rail is exactly /assessment/teams · submissions · reports · feedback · enterprise · workspace · prompts · rules · runs · configuration plus /settings — eleven hrefs, and a filter for `/iq/` or `/admin/` over them returns the empty set. `platformItems` is computed as `onOrgiq ? … : []`, so a non-orgiq session gets no platform rail at all, which is the mechanism this log exists to pin. Everything recorded above still holds. Console errors 0.
re-verified 2026-09-17 20:40 (`SelectContextPage.tsx` — the chooser's role rows): the change is presentational and isolation is unaffected, but every fact was re-taken rather than carried forward. The row wanted a single top rule to separate stacked roles; `border-t` alone could not give it one, because the library's `ghost` Button variant is `bg-transparent … border border-border` — the same border treatment as `secondary`, not a chromeless button — so the row drew a box on all four sides. It is now `border-x-0 border-b-0 border-t`, measured live at 1px/0px/0px/0px (top/right/bottom/left). Re-observed on the isolated stack (middleware :3013 mock, Vite :5199): every one of the eight named identities was signed in in turn and asked for the tenant it does not hold — the five orgiq roles for `/api/assessment/teams`, the three assessment roles for `/api/graph/people` — and **all eight returned 403**, each with grants scoped to its own tenant only. The cookie-less demo-user resolves to tenant orgiq and is also 403 on `/api/assessment/teams`. As u-theo the chooser renders one workspace tile and one role row ("Enter Org as Member (current workspace)"), and the string "assessment" does not occur anywhere in its text; `/assessment/teams` redirected to `/iq/projects` (h1 "Initiatives") with no flash of assessment content.
re-observed 2026-09-18 (Layout.tsx gained an <html> tenant marker): the edit in this log's `pages` list sets `data-tenant` on document.documentElement as well as on the shell <Stack>, mirroring how lib/preferences.ts sets `data-theme`. It exists so a tenant can paint the page ground at all — custom properties inherit downward only, and the <Stack> is a grandchild of <body>, so `body { background: var(--color-bg) }` could never resolve a tenant's value. It is a CSS hook and touches no route guard, no capability and no fetch: the attribute was already in the DOM one level lower, so nothing is exposed that was not. What was re-verified live rather than reasoned about, as Asha Nair (assessment/assessor, her only grant): `/api/session/me` returns tenant assessment, `document.documentElement.dataset.tenant` reads "assessment", and `GET /api/graph/projects` — an orgiq route — answers 403. The attribute was separately read as "orgiq" in a Theo Chang session on /iq/projects, so it resolves per session rather than sticking at whichever tenant loaded first; a tenant switch hard-navigates (the session-epoch path in CLAUDE.md), so the effect re-runs on mount with the new tenant. The isolation fields above are unchanged.
