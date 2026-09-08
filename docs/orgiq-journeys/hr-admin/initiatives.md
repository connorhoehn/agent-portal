surface: initiatives
role: hr-admin
user: u-rachel (Rachel Kowalski) — verified via GET /api/session/me on this surface (sub u-rachel, role hr-admin, tenant orgiq)
url: /iq/projects
pages: portal/src/pages/ProjectsPage.tsx,portal/src/pages/projects
audited: 2026-09-07 15:20 local, Chrome 1552px, middleware dev:mock (re-audit: the Sprints lens gained a "My envelope" tile and the Estimate & authorize drawer gained a sprint-envelope pre-flight — every field below re-observed on this sign-in)
screenshot: initiatives.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; breadcrumb "Plan › Initiatives" above the H1; List view first-row-top: 369px (14 rows); above the table exactly one 5-tile StatStrip (Agents active / Active initiatives / Open work / Delivered / Spend · September) and one filter row (Show Everyone|Mine · Status All|In Progress|Planning|Completed · search · Sort select) — no card stack; no horizontal scroll (1552 = 1552)
keyboard: pass — 54 controls counted, 54 reached by a 57-press Tab sweep: rail → Initiatives|Sprints lens toggle → Cards|List → Show/Status pills → search → Sort select → each of the 14 rows' title link (`<a href="/iq/projects/p-…">`) → wraps. Enter on a focused title link opens the initiative; the `<tr>` itself is tabIndex -1 so the row's whitespace is mouse-only but the same destination is one Tab away on every row
empty-state: pass — searching "zzznoexistinitiative" empties the table and renders "No matching initiatives / No initiative matches the current filters." with a working "Clear filters" button
role-gating: hr-admin sees every rail group (Plan/Design/Build/Release/Operate/Org/System — 19 rail links) and every column including Spend (MTD) against allocation; no initiative-level action is gated out here (dispatch/allocate live on initiative-detail and Budgets)
notes: the strip's numbers agree with the table (11 active initiatives = the In Progress rows + planning; $20.71 spend matches the summed Spend column); a mis-aimed click on the row body opened /iq/projects/p-realtime-analytics — whole-row click and title-link keyboard both land on the detail, so mouse and keyboard reach the same page. Re-audit 2026-09-07: the Sprints lens gained a "My envelope" stat-strip tile for the reader's own sprint envelope. It is ABSENT for hr-admin (Rachel Kowalski holds no active grant, and grant-scoped dispatch applies to sme alone — with no envelope there is no brake to warn about, so a tile reading "none" would be an alarm about nothing); "My envelope" appears nowhere in the DOM. Re-measured on this sign-in: Initiatives-lens first-row-top 369px, Sprints-lens first-row-top 345px (7 sprint rows), no horizontal scroll (1552 = 1552), console errors 0 on both lenses.
