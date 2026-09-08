surface: budgets
role: hr-admin
user: u-rachel (Rachel Kowalski) — verified via GET /api/session/me on this surface (sub u-rachel, role hr-admin, tenant orgiq)
url: /admin/budgets
pages: portal/src/pages/budgets
audited: 2026-09-06 00:30 local, Chrome 1552px, middleware dev:mock
screenshot: budgets.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; breadcrumb "Plan › Budgets"; nested "Budgets" rail (Reports: Initiatives 14 / Sprints 6) flush with the content box at 224px; first-row-top: 337px (14 rows — every initiative, allocated or not); above the table exactly one description line ("Monthly agent-spend allocations per initiative, against actuals … · September 2026") and one 4-tile StatStrip (Allocated $261.00 / Spent this period $20.71 / Remaining $240.29 / Maintenance floor $15.46); the Spend by model / Spend by trigger breakdown now sits below the table (top 1172px), not above it; no horizontal scroll (1552 = 1552)
keyboard: pass — 66 controls counted, every one reached by a 69-press Tab sweep (rail → nested rail → per row: the initiative name `<a href="/iq/projects/…">`, the allocation-amount button or "Set budget", and "Remove allocation for <initiative>" (aria-labelled ✕) → wraps). Enter on a focused "Set budget" swaps the cell for an inline "Monthly budget for Real-time Analytics Pipeline" input and moves focus into it; Escape cancels the edit, restores the "— unallocated · Set budget" cell and returns focus to the Set budget button (no value submitted — an allocation write would change shared seed state)
empty-state: n/a — no search/filter on this report; the unallocated case is rendered honestly per row ("— unallocated" + Set budget, "$0.00 / — / 0 / never / —"), and Inference Platform carries a "blind spot" tag because it has $1.82 of spend against no allocation
role-gating: hr-admin holds ManageBudgets — every allocated row exposes the amount as an editable button and a Remove control, every unallocated row a Set budget; member/sme never reach this route (App.tsx RequireRole org-leader/hr-admin/program-owner). Updated-by reads "u-release" on every seeded allocation, the release-manager who owns allocations in the operating model
notes: DEFECTS #2 re-observed as fixed — the two breakdown cards that used to stack above the table are below it now, and the block count above the first row is exactly the description line and the StatStrip. The 14 rows are the full `p-*` initiative family, so "Budgets lists every initiative" holds; the strip's $20.71 spent matches Initiatives' "Spend · September" tile.
