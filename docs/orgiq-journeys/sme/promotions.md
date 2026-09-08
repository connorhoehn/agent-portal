surface: promotions
role: sme
user: u-nora (Nora DaSilva); re-confirmed via GET /api/session/me on this page (sub u-nora, role sme, tenant orgiq)
url: /iq/promotions
pages: portal/src/pages/promotions
audited: 2026-09-05 21:26 local, Chrome 152 at 1552px, middleware dev:mock (re-audit)
screenshot: promotions.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; first-row-top: 286px; a two-line description + one Status filter row above the table, no card stack; no nested rail; no horizontal scroll (1552/1552)
keyboard: pass — 28 tabbable of 28 focusable; one Tab sweep from a body click reached every one (focusin log diffed against the DOM: missing = []): five status pills → the four candidate title `<button>`s → shell and rail; Enter on "Retry the Data API through an Aurora cold start" opens the "Promotion candidate detail" drawer (`role="dialog"`) with focus on Close, Escape closes it and returns focus to the same row button
empty-state: pass — no search box; the status pills filter correctly with `aria-pressed` moving (All 4 rows, Candidates 3, Promoted 1, Approved → "Nothing here / Nothing approved right now.", Dismissed → "Nothing here / Nothing dismissed right now.")
role-gating: sme holds ManageBots, the gate the page and the server's /promote and /dismiss routes share, so the drawer shows "Approve + record a passing dry run" and "Dismiss" (no gate note). Pressing approve succeeded: toast "✓ Promoted — now running unattended as a skill.", the drawer's badge flipped to Promoted and both action buttons disappeared (only Close remains), `GET /api/promotions/promo-aurora-cold-start` returns 200, and after Escape the list row reads "Skill · Promoted" — no stale drawer, no second Approve to mis-click
notes: Member's #1/#2/#3 and hr-admin's #1 still reproduce as fixed here. The earlier visual nit (candidate title centred in a full-width button) is gone — the title button is `text-align: left` at the column's left edge (241px), so the title and its "3 observations across 2 sessions" sub-line line up. The description paragraph is still two lines of prose where one would do; the "drifted" pill on the Custodian runbook is the one status cue on the page that nothing explains until the drawer is opened.
