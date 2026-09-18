role: demo-user (cookie-less fallback identity, dev only)
user: demo-user
audited: 2026-09-18 04:4x local, Chrome 1512px, middleware dev:mock on 127.0.0.1:3013 behind a Vite proxy pinned to it
scenario: the original report — "a sme shouldn't see the assessment pages" — reproduced on the demo path, not a seeded user
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
picker-before-choice: 2 workspaces / 10 roles offered (permissive demo identity). CHANGED from "3 workspaces / 13 roles" — the newsroom tenant was deleted 2026-09-05, so the picker now reads "2 accounts · 10 roles": Org (orgiq · 6 roles — Admin, HR Admin, Member, Org Leader, Program Owner, SME) and Assessment (assessment · 4 roles — Admin, Assessor, Lead Assessor, Program Lead)
after Assessment · Program Lead: session grants {assessment:[program-lead]}, rail = the 4 assessment groups only, /api/session/me tenant=assessment role=program-lead
after Org · SME (from the same picker, no sign-out): session grants {orgiq:[sme]}, landed on /iq/projects (was /iq/work until the 2026-09-07 home-resolution fix single-sourced the tenant switch and `/`), rail has zero /assessment anchors
api-status: 403                    # fetch /api/assessment/teams as the demo SME
direct-route-result: redirect      # /assessment/teams → /iq/projects ("Initiatives")
picker-after-choice: still offers all 10 personas (from `switchable`), while the session itself stays narrowed — a demo can move between personas without signing out. CHANGED from 13 for the same reason
screenshot: demo-user.jpg
verdict: pass
notes: Two fixes made this true. (1) demoScopedGrants narrows the demo cookie to the persona it picks (before, "demo as SME" kept every tenant's grants — the reported leak). (2) switchableGrants validates the picker's two-step /tenant → /role against what the persona may become, and /me exposes it as `switchable` so the picker keeps offering every persona; without that the demo dead-ended at one tile with Sign out as the only way back. Real users are unaffected: their `switchable` equals their grants.
re-verified 2026-09-07 22:22 (local-compute presence merge, Layout.tsx): signed out to the cookie-less identity (`/api/session/me` = sub demo-user, grants {orgiq:[member,sme,program-owner,org-leader,hr-admin,admin], assessment:[assessor,lead-assessor,program-lead,admin]}). Picked Assessment · Program Lead → session narrowed to {assessment:[program-lead]}, tenant assessment, landed on /assessment/teams, rail = the 11 assessment items (Dashboard, Submissions, Reports, Feedback, Enterprise, Workspace, Prompts, Rules, Activity, Configuration, Settings). Back on /select the picker still offered all 10 personas from `switchable` while `grants` stayed {assessment:[program-lead]}. Picked Org · SME from the same picker with no sign-out → grants narrowed to {orgiq:[sme]}, landed on /iq/work; fetch('/api/assessment/teams') → 403; /assessment/teams redirected to /iq/projects; 0 rail anchors matching /assessment. Console errors: 0 throughout. Empty state seen on the way: /iq/projects as the demo SME shows "Nothing linked to you — No initiative lists you as owner or contributor — or your sign-in is not linked to a person in the org graph (Identity → Users fixes that)." with a "Show all initiatives" action, which is a real explanation rather than a blank table. Screenshot is that state.
the new header badge IS live for this identity, and that is how the tenant leak was found: the mock floor seeds `node-demo-macbook` with `ownerId: "demo-user"`, so `GET /api/local-compute/nodes` returns it, and `LocalComputeBadge` — mounted in Layout.tsx with no tenant guard — renders "⌂ demo-macbook · 1" in the header of BOTH tenants, including while the demo session is narrowed to {assessment:[assessor]}. The popover then shows that machine's orgiq work (p-realtime · feat/presence-mesh · "wire the presence mesh into the gateway") and an "Open Computer Lab" action that lands on the blank /iq/projects. Filed as isolation/DEFECTS.md #2 (and #1 for the dead-end landing). Layout itself is unaffected: `.shell-header` measures 61px with the badge present, the same as without it.
re-verified 2026-09-07 23:57 (home-resolution fix, App.tsx + lib/tenantHome.ts; and the closure evidence for DEFECTS #2): signed out to the cookie-less identity (`/api/session/me` = sub demo-user, grants {orgiq:[member,sme,program-owner,org-leader,hr-admin,admin], assessment:[assessor,lead-assessor,program-lead,admin]}). The picker reads "2 accounts · 10 roles" — Org (orgiq · 6 roles) and Assessment (assessment · 4 roles) — with ten "Enter …" buttons. Entered Assessment · Program Lead: session narrowed to {assessment:[program-lead]}, tenant assessment, landed on /assessment/teams, rail = the 11 assessment items, 0 anchors matching ^/(iq|admin). From there /iq/projects and /admin/devbox BOTH redirect to /assessment/teams and paint the dashboard — the blank /iq/projects of DEFECTS #1 is gone. DEFECTS #2 is closed on the exact identity that reproduced it: demo-user owns node-demo-macbook, and in the assessment tenant `GET /api/local-compute/nodes` now answers 403 {"error":"Forbidden","requiredTenant":"orgiq","tenant":"assessment"} and the header reads "Assessment | Mock: … | ⌘K Search | Demo User | Assessment · program-lead" with no "⌂ demo-macbook" badge (screenshot local-compute-badge-gated.jpg). Back on /select the picker still offered all 10 personas from `switchable` while `grants` stayed {assessment:[program-lead]}. Entered Org · SME from the same picker with no sign-out → grants {orgiq:[sme]}, landed on /iq/projects (it landed on /iq/work before this fix), and the badge is back — header reads "⌂ demo-macbook · 1" — which is the point: the badge was scoped to the orgiq tenant, not removed. fetch('/api/assessment/teams') → 403; /assessment/teams → /iq/projects (h1 "Initiatives"); 0 rail anchors matching /assessment; /api/local-compute/nodes → 200. Console errors 0 throughout. The empty state on the way is unchanged and still explains itself: /iq/projects as the demo SME shows "Nothing linked to you — No initiative lists you as owner or contributor — or your sign-in is not linked to a person in the org graph (Identity → Users fixes that)" with a "Show all initiatives" action. Screenshot is that state.

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
  THIS IS THE IDENTITY THE DEFECT REPRODUCED ON, so this log was driven through
  the real chooser rather than by API login, and both halves of the fix were
  watched on one session.
  - picker-before-choice: **"2 accounts · 10 roles"**, tiles Org and Assessment —
    unchanged.
  - after **Assessment · Program Lead**: /api/session/me = sub demo-user, tenant
    assessment, role program-lead; landed on /assessment/teams; the rail is the
    11 assessment items (Dashboard, Submissions, Reports, Feedback, Enterprise,
    Workspace, Prompts, Rules, Activity, Configuration, Settings) with **0**
    anchors matching ^/(iq|admin). The header reads "Assessment | Mock: … | ⌘K
    Search | Demo User | Assessment · program-lead" — **no `⌂ demo-macbook`**,
    and the string "macbook" occurs nowhere in the document. GET
    /api/local-compute/nodes answers **403**
    `{"error":"Forbidden","requiredTenant":"orgiq","tenant":"assessment"}`.
    On 2026-09-07 22:23 the same request answered 200 with `node-demo-macbook`.
  - after **Org · SME** from the same picker, no sign-out: tenant orgiq, role
    sme, grants {orgiq:[sme]}, landed on /iq/projects; the header reads "Org |
    Mock: … | ⌘K Search | **⌂ demo-macbook · 1** | Demo User | Org · SME" and
    /api/local-compute/nodes is **200** again. That is the whole point of the
    fix and the reason to record it here: the badge was scoped to the tenant,
    not deleted. `.shell-header` stays 61px in both.
  - api-status: **403** — /api/assessment/teams as the demo SME.
  - direct-route-result: **redirect** — /assessment/teams → /iq/projects, h1
    "Initiatives", 486 chars of main.
Console errors: 0 across every navigation in this pass.

--- freshness re-observation, 2026-09-15 19:59 (the shell's SkipLink) ---
Why: Layout.tsx changed (the shell's SkipLink) and is in this log's pages: digest. Reproduced cookie-less: Sign out on /select, then /select again as the dev fallback identity.
  - picker-before-choice: 2 accounts · 10 roles (Org · 6 roles, Assessment · 4 roles) — /api/session/me = sub demo-user, role member, tenant orgiq, grants {orgiq:[member, sme, program-owner, org-leader, hr-admin, admin], assessment:[assessor, lead-assessor, program-lead, admin]}; the picker's own caption reads "2 accounts · 10 roles". The Assessment tile IS visible here, which is the point of this scenario: it is the permissive demo identity, before a choice.
  - choice: "Enter Org as SME" → /api/session/me = sub demo-user, role sme, tenant orgiq, grants narrowed to exactly {orgiq:[sme]} (demoScopedGrants); landed on /iq/projects.
  - api-status: 403 — /api/assessment/teams as the demo SME.
  - direct-route-result: redirect — /assessment/teams → /iq/projects, h1 "Initiatives"; 0 rail anchors match /assessment.
  - picker-after-choice: not re-taken this pass (unchanged code path; the Sign-in-as tab still lists 10 personas on the cookie-less picker).
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
