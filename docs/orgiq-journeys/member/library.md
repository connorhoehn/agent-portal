surface: library
role: member
user: u-theo (Theo Chang) — GET /api/session/me on this sign-in: sub u-theo, tenant orgiq, role member
url: /iq/library
pages: portal/src/pages/library
audited: 2026-09-06 10:50 local, Chrome 1552×789, middleware dev:mock
screenshot: library.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; breadcrumb "Design › Library" (present now — hr-admin #10's missing trail is gone on this route); nested "Prompt Management" rail flush with the content box (aside right edge 444px, inner content at 468px w 1060px); first-row-top: 326px (10 rows); above the table one H1 + a two-line description and one facet row (Kind All / System prompt 2 / Prompt 2 / Evaluator 2 / Skill 3 / Insight 1 · Tier All / Internal 9 / Endpoint 1 · search); the table is 1510px wide in a 1060px `overflow-x:auto` wrapper so the USES column is clipped until the wrapper is scrolled — the page itself does not scroll horizontally (scrollWidth 1552 = innerWidth)
keyboard: pass — 40 tabbable controls, none with tabIndex −1, all reached in a 48-press Tab sweep (focus-log diff: missing none — 39 unique keys because two facet chips share a label); each asset row's name is a real `<button>` — Return on "CSRF risk evaluator" opened the drawer (role=dialog, first heading "Contract", focus moved inside), Escape closed it and returned focus to the same row button
empty-state: pass — searching "zzznoexistasset" drops the table to 0 rows and renders "Nothing matches / No asset matches these facets. Clear a filter or widen the search." with a "Clear filters" button
role-gating: member can browse and filter the catalog and open an asset's drawer (contract, lineage, release readiness, eval set, latest run). The nested rail lists only "Library" for member — "What is deployed", Studio, Versions, Evals and Rollout are absent from the DOM, and direct `/iq/prompt-ops` and `/iq/prompts` both redirect to /iq/projects. In the drawer the "Run evals" button is gone for member: the LATEST RUN section reads "Running evals needs Manage bots." in its place (zero `<button>`s matching /run/ in the dialog), so the 403 toast can no longer be triggered
notes: DEFECTS #10 and #11 re-observed fixed and closed. Soft: the LATEST RUN copy right under "Running evals needs Manage bots." still says "Never evaluated — run the suite to produce the pass rate the release gate reads." — the gate sentence and the instruction sit one line apart, so a member reads "you can't" and "go run it" together; and the HEALTH & USAGE block on the same asset says "Eval pass rate — 96%" while LATEST RUN says "Never evaluated" (fixture disagreement, not filed). The USES column is invisible at 1552px without a horizontal gesture inside the table wrapper.
