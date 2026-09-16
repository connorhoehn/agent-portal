role: lead-assessor
user: u-jonas
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-15 20:02 local, Chrome window (innerWidth 1692, innerHeight 858), middleware dev:mock (re-verification after the shell gained a SkipLink — portal/src/components/shell/Layout.tsx is in this log's pages: digest; every fact below re-taken, not carried forward)
orgiq-nav-visible: no              # rail on /assessment/teams: Dashboard, Submissions, Reports, Feedback, Enterprise, Workspace, Prompts, Rules, Activity, Settings (10 anchors) — 0 matching ^/(iq|admin|newsroom)
orgiq-route-result: redirect       # measured this pass: /iq/projects → /assessment/teams (main 1068 chars, breadcrumb "Assess › Dashboard"); /iq/scores → /assessment/teams; /admin/observability → /assessment/teams (1068); /admin/devbox → /assessment/teams (1068); / → /assessment/teams (1068). The URL always moves and the landing page is populated.
orgiq-api-status: 403              # /api/graph/people?limit=1 → 403, /api/scores/leaderboard → 403, /api/work/queue → 403, /api/local-compute/nodes → 403, POST /api/session/tenant {orgiq} → 403 (session stayed on assessment)
screenshot: lead-assessor-outbound.jpg  # what typing /iq/projects gets you now: the assessment dashboard under the assessment breadcrumb, signed in as Jonas · lead-assessor
verdict: pass
notes: Signed in from /select → "Sign in as" → Jonas Lindqvist, then the Assessment tile's Lead Assessor row; `/api/session/me` = sub u-jonas, tenant assessment, role lead-assessor, grants {assessment:[lead-assessor, assessor]}. `.shell-header` 61px, innerWidth 1552 = scrollWidth 1552, console errors 0 throughout. The fix under test: portal/src/lib/tenantHome.ts is now the single home resolution (`resolveHome`), and App.tsx's guards all fall back to one `<HomeRedirect />` that uses it — so a refused tree sends you where `/` would send you, and if that resolves to the page you are already on it renders not-found instead of bouncing. The two orgiq trees no longer name `/iq/projects` as their own fallback.
A second, quieter drift surfaced while measuring this user and was fixed in the same pass. Jonas holds TWO contexts, so the home resolution routes a not-yet-chosen identity to the chooser — and the chooser's own `markContextChosen()` was being erased microseconds later by `clearTenantScopedCaches()` inside `enterContext` (the marker lives in the sessionStorage that scrub wipes). The call was dead: a person who had just picked Lead Assessor was sent straight back to /select by the next home resolution. Measured before the fix: /iq/projects, /admin/observability and / all landed on /select with `sessionStorage['orgiq.contextChosen']` null. `enterContext` now re-marks the same `sub` after the scrub, and the numbers above are the re-measurement with the marker reading "u-jonas".
defect #2 (LocalComputeBadge) is closed as observed here: `GET /api/local-compute/nodes` → 403 for this session, and `demo-macbook` occurs nowhere in the document.
re-verified 2026-09-05 04:18: rail as lead-assessor still has zero `<a href>` matching `^/(iq|admin|newsroom)`; `/iq/projects` redirected to `/select`; `fetch('/api/graph/people?limit=1')` returned 403.
re-verified 2026-09-05 08:38: rail as lead-assessor still has 0 anchors matching ^/(iq|admin|newsroom); /iq/projects redirected to /select; fetch('/api/graph/people?limit=1') returned 403.
re-verified 2026-09-07 22:19 (local-compute presence merge, Layout.tsx): the pass that filed DEFECTS #1 — /iq/projects did not redirect, the URL stayed put and the content column was empty under the orgiq breadcrumb "Plan › Initiatives". Kept here as the before-state.

--- freshness re-observation, 2026-09-15 20:02 (the shell's SkipLink) ---
Why: Layout.tsx changed (the shell's SkipLink) and is in this log's pages: digest. Signed in from /select → Sign in as → Jonas Lindqvist → "Enter Assessment as Lead Assessor" (the chooser click, which sets sessionStorage orgiq.contextChosen = u-jonas — without it resolveHome correctly parks a two-context identity on /select, which this pass first observed and then ruled out as the product's answer); /api/session/me = sub u-jonas, tenant assessment, role lead-assessor, grants {assessment:[lead-assessor, assessor]}.
  - orgiq-nav-visible: no — 10 anchors in [data-shell-nav] on /assessment/teams, 0 whose href starts with /iq/ or /admin/.
  - orgiq-route-result: redirect — /iq/projects landed on /assessment/teams, h1 "Assessor's desk", 1554 chars of main.
  - orgiq-api-status: 403 — /api/graph/people?limit=1; curl cookie jar as u-jonas: /api/scores/leaderboard 403, /api/work/queue 403, /api/local-compute/nodes 403, POST /api/session/tenant {orgiq} 403.
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
