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
