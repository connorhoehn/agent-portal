surface: scores
role: hr-admin
user: u-rachel (Rachel Kowalski) — verified via GET /api/session/me on this surface (sub u-rachel, role hr-admin, tenant orgiq)
url: /iq/scores
pages: portal/src/pages/ScoresPage.tsx,portal/src/components/scores
audited: 2026-09-06 00:31 local, Chrome 1552px, middleware dev:mock
screenshot: scores.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; breadcrumb "Org › Scores"; nested "Explore" rail (Scores: Overview/Cohorts/Compare · Other views: Graph) flush with the content box at 224px; first-row-top: 473px (12 rows); above the table exactly one 5-tile StatStrip (People scored 12 / Avg composite 80 / Top score 94 / Departments 2 / Updated never), one description line, and one filter row (Search skill… · "Weighting: 55% / 45%" popover button · Department select) — the old explainer card and separate slider/chip rows are gone, "How scoring works" now lives in a collapsed section below the table; no horizontal scroll (1552 = 1552)
keyboard: pass — 62 controls counted, every one reached by a 65-press Tab sweep (rail → nested rail → skill search combobox → Weighting button → department select → per row: the Compare checkbox (aria-label "Compare <name>") then the person's name, a real `<button>` → wraps). Enter on the focused "Hiro Green" name button opens the person detail panel (an "Hiro Green" heading with skills/radar/trend and a Close button appears below the leaderboard); Escape closes it and returns focus to the same name button
empty-state: pass — typing "zzznoexistskill" in "Search skill…" opens the combobox popover (aria-expanded=true) with `No skills match "zzznoexistskill"` and a "Clear search" action while the 12-row leaderboard stays put behind it — the search no longer fails silently
role-gating: `/iq/scores` is wrapped in RequireRole org-leader/hr-admin; hr-admin sees the full leaderboard, the compare checkboxes feeding /iq/scores/compare, the weighting popover and the department filter; "Updated: never — run the scoring agent" is honest for dev:mock, where the scoring agent has not run
notes: DEFECTS #3, #4 and #5 all re-observed as fixed on this page — first-row-top dropped from 795px to 473px, the row's name is a keyboard-reachable button with Escape/focus-return, and the skill typeahead has a real empty state. The person panel opens below the table rather than beside it, so at 1552px you scroll to read it; the Close button and Escape both work from there.
