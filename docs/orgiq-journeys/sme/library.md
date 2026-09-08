surface: library
role: sme
user: u-nora (Nora DaSilva); re-confirmed via GET /api/session/me on this page (sub u-nora, role sme, tenant orgiq)
url: /iq/library
pages: portal/src/pages/library
audited: 2026-09-05 21:33 local, Chrome 152 at 1552px, middleware dev:mock (re-audit)
screenshot: library.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; nested "Prompt Management" rail (Browse: Library) flush with the content box (aside left 224px = content left); first-row-top: 310px; one Kind/Tier facet row with the search box on its right and a two-line description above the table — no card stack; no horizontal scroll (1552/1552)
keyboard: pass — 41 tabbable of 41 focusable; one Tab sweep from a body click reached every one (focusin log diffed against the DOM: missing = []): the rail entry, the Kind and Tier facet pills, the search box, each asset row's name as a real `<button>`, then shell and rail. Enter on "Review a PR diff-scoped" opens the "Asset detail" drawer (`role="dialog"`) with focus on its Close button; Escape closes it and returns focus to the same row button; the drawer's related-asset links ("shares review") are buttons too
empty-state: pass — searching "zzznoexistasset" renders "Nothing matches / No asset matches these facets. Clear a filter or widen the search." with a Clear filters button that restores the 10 rows and empties the box
role-gating: sme's nested rail is Library only — "What is deployed" (/iq/prompt-ops) has been removed for sme along with Studio/Versions/Evals/Rollout (all absent from the DOM; /iq/prompt-ops itself now redirects sme to /iq/projects). The drawer's "Run evals" button is still rendered `disabled` for this asset, but the reason is now on the page next to it: EVAL SET "no cases yet — No eval set for this asset — nothing here can satisfy the gate above sandbox." and LATEST RUN "Never evaluated — run the suite to produce the pass rate the release gate reads." — a state gate, explained, not a role gate. No write control (create, edit, publish) is shown for any role here
notes: For the persona this answers "what will the agent I dispatch actually be told?" — the catalog reads well (kind/tier chips, "takes" column, distilled-from provenance and a RELEASE READINESS checklist in the drawer). The earlier rough edge (a dead "Run evals" with no reason) is gone; the disabled button now sits under a line that says why. The description paragraph is still two full lines of prose above the facets; one line would put the table 24px higher.
