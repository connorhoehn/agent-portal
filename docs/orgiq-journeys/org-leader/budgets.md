surface: budgets
role: org-leader
user: u-vera (Vera Green — the release manager persona: ManageBudgets true); re-checked GET /api/session/me on arrival (sub u-vera, tenant orgiq, role org-leader)
url: /admin/budgets
pages: portal/src/pages/budgets
audited: 2026-09-05 23:29 local, Chrome 152 at 1552px, middleware dev:mock
screenshot: budgets.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1352px; nested "Budgets" rail (Reports: Initiatives 14 / Sprints 6) flush with the content box (200 = 200); first-row-top: 273px on the Initiatives report (one description line + one 4-tile stat strip — Allocated $261.00 / Spent this period $20.71 · 68 runs / Remaining $240.29 / Maintenance floor $15.46 · 75% of spend — above the table, no breakdown cards) and 336px on the Sprints report (?report=sprints); no horizontal scroll (1552 = 1552)
keyboard: pass — 63 tabbable, all 63 reached in one 75-Tab sweep (focus-log diff: missing none): the report entries, then per row the initiative link, the allocation button ("$60.00" … or "Set budget" for the 7 unallocated initiatives) and "Remove allocation for …"; Enter on "$60.00" opens the number input ("Monthly budget for Observability Platform", type number) with focus and the table header stays put (thead top 237px before and after, scrollY 0); Escape closes the editor and `document.activeElement` is the "$60.00" button again, attached to the document — program-owner #8 / DEFECTS #9 no longer reproduces
empty-state: n/a — no filter or search on either report; unallocated initiatives render "— unallocated" with a "Set budget" button, and the Sprints report reads "6 envelopes · 6 active"
role-gating: org-leader can set an allocation on any of the 14 initiatives (7 allocated with an editable amount + "Remove allocation" ✕, 7 with "Set budget") and the Sprints report carries "Grant envelope →" to /iq/sprints (the Sprints lens, whose drawer holds the "+ Grant envelope" form); nothing is hidden for this role. Not exercised: saving or removing an allocation, which mutates the shared dev:mock ledger
notes: This is the release manager's page and it answers the question: spend against allocation per initiative with the maintenance floor called out per row ("$4.12 · $2.74 maintenance") and in the strip; the strip's "$20.71 of $261.00" matches the Initiatives page's Everyone-scope strip. The Sprints report lists each SME's envelope beside the initiative's spend in the window and says plainly that the spend "is the initiative's within the sprint window, not the individual's". Unchanged minor points: "Grant envelope →" leaves for the Sprints lens, so the grant is two pages from the report that lists envelopes; the "UPDATED BY u-release" column names a user id rather than a person.
