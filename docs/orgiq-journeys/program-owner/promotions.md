surface: promotions
role: program-owner
user: u-mia (Mia Singh, p-030); signed in fresh via /select → Sign in as → Mia's card → Sign in → Org tile → "Program Owner" row; confirmed via GET /api/session/me (sub u-mia, tenant orgiq, role program-owner) before the surface
url: /iq/promotions
pages: portal/src/pages/promotions
audited: 2026-09-05 21:59 local, Chrome 152 at 1552px, middleware dev:mock
screenshot: promotions.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; first-row-top: 286px; a two-line description and one Status filter row above the table, no card stack; no nested rail; no horizontal scroll (1552/1552)
keyboard: pass — 28 tabbable (no tabindex -1), all 28 reached in one 32-Tab sweep and verified by diffing the focus log against the DOM (missing: none): five status pills → the four candidate titles as real `<button>`s → shell and rail; Enter on "Retry the Data API through an Aurora cold start" opens the candidate drawer with focus on Close, Escape closes it and `document.activeElement` is the same row button
empty-state: pass — no search box; the status pills filter with `aria-pressed` moving (Approved → 0 rows, "Nothing here / Nothing approved right now."); after the approval below the Promoted set holds 2 rows
role-gating: program-owner CAN approve and dismiss (the drawer's "Approve + record a passing dry run" and "Dismiss" are present and enabled — `routes/promotions.ts` gates on ManageBots, which this role holds); pressed "Approve + record a passing dry run" on the Aurora cold-start candidate: the drawer's badge flipped Candidate → Promoted in place, NEXT STEP became "Promoted — now running unattended as a skill.", a "✓ Promoted" toast appeared, and the action buttons were removed from the drawer (Close only); nothing on this page is hidden for the role
notes: The approval mutated shared dev:mock state (promo-aurora-cold-start is Promoted for every role until the middleware restarts — it had reset to Candidate since the first pass, so the mock has restarted at least once tonight). The one-click "Approve + record a passing dry run" skips the "Approved" state entirely, so the Approved pill is empty in the seed and stays empty after this flow; a program owner who wants to approve without vouching for a dry run has no button for it. The "drifted" tag on the Custodian runbook candidate still has no explanation on hover or in its drawer. The table's SUPPORT column ("3 obs · 2 sess") repeats the sub-line under every title ("3 observations across 2 sessions") — one of the two is decoration.
