surface: library
role: member
user: u-theo (Theo Chang) — GET /api/session/me on this sign-in: sub u-theo, tenant orgiq, role member
url: /iq/library
pages: portal/src/pages/library
audited: 2026-09-15 10:25 local, Chrome window (innerWidth 1692, innerHeight 858), middleware dev:mock (re-audit after the one-row "Prompt Management" rail stopped rendering for Browse-only roles — it listed only "Library", a self-link; signed in as u-theo via /select → Sign in as → Theo Chang; every field re-observed)
screenshot: library.jpg
verdict: pass
console errors: 0
layout: pass — no nested rail for this role any more: the content box starts at the content col (left 224px, w 1444px) and the breadcrumb "Design › Library" is the only trail; first-row-top: 122px (12 rows) under the H1, its description and one facet row; the table wrapper is `overflow-x:auto` and the page itself does not scroll horizontally (scrollWidth 1692 = innerWidth 1692)
keyboard: pass — 41 tabbable controls and all 41 accept focus (`.focus()` walk); each asset row's name is a real `<button>` that opens the drawer (role=dialog) and Escape returns focus to the row
empty-state: pass — searching "zzznoexistasset" drops the table to 0 rows and renders "Nothing matches / No asset matches these facets. Clear a filter or widen the search." with a "Clear filters" button
role-gating: member can browse and filter the catalog and open an asset's drawer (contract, lineage, release readiness, eval set, latest run). The Prompt Management rail is absent for member — "What is deployed", Studio, Versions, Evals and Rollout are not in the DOM, and direct `/iq/prompt-ops` and `/iq/prompts` redirect to /iq/projects. In the drawer the "Run evals" control is gone: LATEST RUN reads "Running evals needs Manage bots." in its place
notes: DEFECTS #10 and #11 re-observed fixed and closed. Soft: the LATEST RUN copy right under "Running evals needs Manage bots." still says "Never evaluated — run the suite to produce the pass rate the release gate reads." — the gate sentence and the instruction sit one line apart, so a member reads "you can't" and "go run it" together; and the HEALTH & USAGE block on the same asset says "Eval pass rate — 96%" while LATEST RUN says "Never evaluated" (fixture disagreement, not filed). The USES column is invisible at 1552px without a horizontal gesture inside the table wrapper. Re-audit 2026-09-15 10:25: the Library no longer draws a one-item rail whose only row was the page itself; the catalog now takes the full content column and the first row sits at 122px instead of 326px. Console errors 0.
