surface: library
role: org-leader
user: u-vera (Vera Green) — POST /api/session/login then /role; GET /api/session/me: sub u-vera, tenant orgiq, role org-leader
url: /iq/library
pages: portal/src/pages/library
audited: 2026-10-06 11:50 local, headless Chromium 1680x940 (Playwright), shared dev:mock stack (BFF :3001, Vite :5183, ui-components 2.413.0)
screenshot: library.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1480px; no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly 1 <main>, 1 H1 ("Agent library"); first-row-top: 301px; clipped-text sweep: 6 hidden-overflow strings (all carry a title). breadcrumb Build > Agent library; nested rail Kind (All assets, System prompt 2, Prompt 2, Evaluator 2, Skill 5, Insight 1) flush at x 200; 8 rows per page ("Page 1 of 2 · 12 total"); description cells carry a title with the full text
keyboard: pass — 30 of 31 tabbable controls in <main> accept focus (the rest: disabled:Prev) — walked by document-order `.focus()` asserting `document.activeElement` (headless: no physical key events; Enter/Escape sent with `page.keyboard` to the focused target); Enter on the first row/link went from /iq/library to /iq/library/skill-pr-review-scoped. Prev is disabled on page 1
empty-state: pass — "zzznoexist" gives "Nothing matches / No asset matches these facets. Clear a filter or widen the search." with Clear filters; /iq/library/lib-nope reads "Asset not found / No library asset has the id "lib-nope". / ← All assets" (a not-found, not an outage)
role-gating: can browse and open every asset and see "New asset" and "Review promotions". Capabilities from GET /api/session/capabilities for org-leader: ManageBots, DispatchAgentRun, ManageBudgets, ManageSprints, ManageCanary, ViewObservability, ViewLeaderboard, ConnectLocalCompute true; ManageDevbox, ManageIngest, ManageKB, EditGuardrail/EditPolicy/EditSchema, ViewIdentityAdmin false
notes: Opening the first row (Review a PR diff-scoped) lands on /iq/library/skill-pr-review-scoped with no console error and no failed request — the earlier 404 on the provenance request is gone. The not-found URL itself logs one 404 for the lookup, which is the probe's own.
