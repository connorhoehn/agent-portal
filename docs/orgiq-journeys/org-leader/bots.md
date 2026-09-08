surface: bots
role: org-leader
user: u-vera (Vera Green — ManageBots true); re-checked GET /api/session/me on arrival (sub u-vera, tenant orgiq, role org-leader)
url: /admin/bots
pages: portal/src/pages/bots
audited: 2026-09-05 23:41 local, Chrome 152 at 1552px, middleware dev:mock
screenshot: bots.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1352px; breadcrumb (Build › Automate › Bots) then the nested Automate rail flush with the content box (200 = 200); first-row-top: 355px; above the table one description line, then the search box, the All bots / Enabled / Paused select and the "5 bots · every change still passes review + policy gates" caption stacked as three full-width rows where one filter row would do (no cards, so under the density rule, but not tight); no horizontal scroll (1552 = 1552)
keyboard: pass — 44 tabbable, all 44 reached in one 60-Tab sweep (focus-log diff: missing none); each bot name is a real `<a href="/admin/bots/<uuid>">` and each target is a link to its initiative — Enter on "cost-anomaly-sweep" opens the bot detail page ("← Bots", ▶ Run now, Resume, Delete, two "edit" buttons, the mission, the guardrails table, RUNS); "← Bots" returns
empty-state: pass — searching "zzznoexistbot" renders "0 of 5 bots match / No bots match the current filters." over an empty table with a "Clear filters" button; /admin/bots/nope renders "Bot / Failed to load bot: 404 Not Found / ← Bots" — reads as not-found, with a way back
role-gating: org-leader (ManageBots true) sees "+ New bot" and, on the detail page, ▶ Run now / Resume / Delete / edit; the pause reason is stated in a banner ("paused by operator"); nothing is hidden for this role. Not exercised: Run now / Resume / Delete, which would fire or change a bot in the shared dev:mock state
notes: The table is the maintenance-floor ledger — per-bot "TODAY 2/4 runs · $0.26 of $2.00" against a budget bar, and the detail's guardrails card spells out "Enforce allocation: off (bot spend is the maintenance floor)". The list and the detail now tell one story about cost-anomaly-sweep: the row reads "last ran 1d ago · 0/4 runs · $0.00 of $2.00", the detail header reads "cron: 15 7 * * * · last ran 1d ago", and its RUNS table lists "cron · done · $0.1800 · 4m · 1d ago" then "$0.2200 · 3d ago" and on — DEFECTS #20 closed. The Bots page is now also reachable from the Automate Overview roster and its "Manage bots →" (DEFECTS #4 closed). One thing a person notices: the pause banner has gone from a reason ("awaiting repo provisioning — un-pause once the repository exists") to "paused by operator", which says who but no longer why.
