surface: automate-findings
role: org-leader
user: u-vera (Vera Green); re-checked GET /api/session/me on arrival (sub u-vera, tenant orgiq, role org-leader)
url: /iq/work/findings
pages: portal/src/pages/work
audited: 2026-09-05 23:23 local, Chrome 152 at 1552px, middleware dev:mock
screenshot: automate-findings.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1352px; breadcrumb (Build › Automate › Findings) then the nested Automate rail flush with the content box (200 = 200); first-row-top: 382px (the first finding group row "warning · Bus factor · 1 finding" — the findings list is grouped rows, not a table); above it one dead-letter panel (its own honest empty state) and one status-pill row; no horizontal scroll (1552 = 1552)
keyboard: pass — 41 tabbable, all 41 reached in one 55-Tab sweep (focus-log diff: missing none): the rail, the sub-rail, "Run sweeps now", the four status pills, the three group rows and "Find links in 1 of these"; Enter on the "Bus factor" group row expands it in place (the row's label flips show → hide, focus stays on the row) and exposes the finding with real "Put a worker on it" / "Dismiss" buttons in the tab order; the status pills are real toggles (aria-pressed flips and the list re-renders)
empty-state: n/a — every status pill has at least one finding in this seed (open 3 groups, promoted 2, resolved 1, dismissed 1), so no filter yields zero; the dead-letter panel's own empty state reads "Nothing dead-lettered. Failed jobs land here with their error and a requeue button."
role-gating: org-leader gets the full write surface — "Run sweeps now" in the header, "Find links in 1 of these" on the Stale docs group, and "Put a worker on it" / "Dismiss" on every open finding (DispatchAgentRun / ManageBots suffice; nothing is gated on ManageDevbox); nothing is hidden for this role
notes: Every group heading is now a human title — open: "Bus factor", "Orphan decisions", "Stale docs"; dismissed: "Lab signals · 1 finding" where the previous pass read the raw kind id "lab-signal" (DEFECTS #7 closed). The seed has moved since the last pass: the critical "Aurora cold-start recovery has a single holder" bus-factor finding about Vera herself now sits under "promoted" (its "Mitigate: …" job is the one queued item on the Queue), so the open list is three warning/info rows. The group-row buttons still carry no aria-expanded — a screen reader hears only the "show"/"hide" text (unchanged, minor).
