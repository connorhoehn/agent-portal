role: assessor
user: u-asha
pages: portal/src/App.tsx,portal/src/components/shell/Layout.tsx,portal/src/pages/SelectContextPage.tsx
audited: 2026-09-07 23:44 EDT, Chrome 1552px, middleware dev:mock on :3011, portal :5185 (re-audit after the home-resolution fix for isolation/DEFECTS.md #1)
orgiq-nav-visible: no              # rail on /assessment/teams: Dashboard, Submissions, Reports, Feedback, Enterprise, Workspace, Prompts, Rules, Activity, Settings (10 anchors) — 0 matching ^/(iq|admin|newsroom)
orgiq-route-result: redirect       # every orgiq URL now leaves the orgiq URL space and lands on this tenant's own front door, populated. Measured this pass: /iq/projects → /assessment/teams (main 1068 chars, breadcrumb "Assess › Dashboard"); /iq/scores → /assessment/teams (1068); /admin/observability → /assessment/teams (1068); /admin/devbox → /assessment/teams (1068); / → /assessment/teams (1068). A path that matches no route at all still reads as not-found rather than as a redirect: /iq/nope-does-not-exist stays put and renders "Page not found — Nothing lives at /iq/nope-does-not-exist".
orgiq-api-status: 403              # /api/graph/people?limit=1 → 403, /api/scores/leaderboard → 403, /api/work/queue → 403, /api/local-compute/nodes → 403, POST /api/session/tenant {orgiq} → 403 (the session stayed on assessment afterwards)
newsroom-route-result: n/a         # the newsroom tenant was deleted 2026-09-05; there is no /newsroom route left to test, so this line is history, not a claim re-observed in this pass
screenshot: assessor-outbound.jpg  # what typing /iq/projects gets you now: the assessment dashboard, fully painted, under the assessment breadcrumb
verdict: pass
notes: Signed in from /select → "Sign in as" → Asha Nair; `/api/session/me` = sub u-asha, tenant assessment, role assessor, grants exactly {assessment:[assessor]}. Layout measured on /assessment/teams: `.shell-header` 61px, innerWidth 1552 = scrollWidth 1552 (no horizontal scroll), first data row at 428px. Console errors 0 across every navigation in this pass. The fix under test: portal/src/lib/tenantHome.ts is now the single home resolution (`resolveHome`), and App.tsx's guards all fall back to one `<HomeRedirect />` that uses it — so a refused tree sends you where `/` would send you, and if that resolves to the page you are already on it renders not-found instead of bouncing. The two orgiq trees no longer name `/iq/projects` as their own fallback.
defect #2 (LocalComputeBadge) is closed as observed here: `GET /api/local-compute/nodes` now answers 403 for this assessment session (it answered 200 on 2026-09-07 22:16), and the badge is absent from the header — `demo-macbook` occurs nowhere in the document.
re-verified 2026-09-05 04:15: rail on /assessment/teams still has zero `<a href>` matching `^/(iq|admin|newsroom)`; `/iq/projects` redirected to `/assessment/teams`; `fetch('/api/graph/people?limit=1')` returned 403.
re-verified 2026-09-05 08:37: rail as assessor still has 0 anchors matching ^/(iq|admin|newsroom); /iq/projects redirected to /assessment/teams; fetch('/api/graph/people?limit=1') returned 403.
re-verified 2026-09-07 22:16 (local-compute presence merge, Layout.tsx): the pass that filed DEFECTS #1 and #2 — /iq/projects did not redirect at all, the URL stayed and the content column was empty under the orgiq breadcrumb "Plan › Initiatives", and `GET /api/local-compute/nodes` answered 200 for an assessment session. Both are fixed and re-measured above; that reading is kept here as the before-state.

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
  - identity: sub u-asha, tenant assessment, role assessor, grants exactly
    {assessment:[assessor]}.
  - orgiq-nav-visible: **no** — 10 anchors on /assessment/teams (Dashboard,
    Submissions, Reports, Feedback, Enterprise, Workspace, Prompts, Rules,
    Activity, Settings), **0** matching ^/(iq|admin|newsroom).
  - orgiq-route-result: **redirect** — /iq/projects → /assessment/teams (h1
    "Engineering maturity cohorts", 1068 chars of main) and /admin/observability
    → the same, 1068 chars. A path matching no route still reads as not-found:
    /iq/nope-does-not-exist stays put and renders "Page not found".
  - orgiq-api-status: **403** — /api/graph/people?limit=1, /api/scores/leaderboard,
    /api/work/queue and /api/local-compute/nodes are all 403; POST
    /api/session/tenant {orgiq} is 403 and the session was still `assessment`
    afterwards.
  - the badge, i.e. DEFECTS #2 seen from this side: 403 on
    /api/local-compute/nodes and no machine chip in the header, now for two
    independent reasons — the server gates the route on tenant, and the shell
    no longer mounts the component outside orgiq at all.
  - layout re-checked while here: `.shell-header` 61px, first data row at 428px,
    scrollWidth 1552 = innerWidth 1552.
Console errors: 0 across every navigation in this pass.
