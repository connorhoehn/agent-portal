surface: bots
role: hr-admin
user: u-rachel (Rachel Kowalski) — verified via GET /api/session/me on this surface (sub u-rachel, role hr-admin, tenant orgiq)
url: /admin/bots
pages: portal/src/pages/bots
audited: 2026-09-06 08:09 local, Chrome 1552px, middleware dev:mock
screenshot: bots.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; breadcrumb "Build › Automate › Bots"; nested Automate rail flush with the content box at 224px; first-row-top: 379px (5 rows); above the table one description line, one search box, one "All bots / Enabled / Paused" select and one summary line ("5 bots · every change still passes review + policy gates"); no horizontal scroll (1552 = 1552)
keyboard: pass — 49 controls counted, 49 reached by a 52-press Tab sweep (rail → nested rail → + New bot → search → status select → per row the bot name `<a href="/admin/bots/<uuid>">` and the target initiative link → wraps); Enter on a bot name opens its detail page (breadcrumb "Build › Automate › Bots › Bot 32970d0a…")
empty-state: pass — searching "zzznoexistbot" empties the table to "No bots match the current filters" with a working "Clear filters" button, and the summary line above it now reads "0 of 5 bots match · every change still passes review + policy gates" — the count tracks the filtered view
role-gating: hr-admin sees "+ New bot" and, on the detail page, ▶ Run now / Pause / Delete plus edit on The mission and Guardrails (none pressed — Run now enqueues a real job); the list is the same five seeded bots the Automate overview roster shows, with cost-anomaly-sweep paused
notes: DEFECTS #9 re-observed as fixed. The detail page's Runs table (15 rows: trigger/status/cost/duration/started/outcome with a "job →" link each) and its Guardrails footer "today: 0/4 runs · $0.00 of $2.00" agree with the list row's "0/4 runs · $0.00 of $2.00", so the detail derives its counts from the same run history the list shows.
