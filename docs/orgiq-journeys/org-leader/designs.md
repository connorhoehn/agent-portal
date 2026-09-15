surface: designs
role: org-leader
user: u-vera (Vera Green); re-checked GET /api/session/me on arrival (sub u-vera, tenant orgiq, role org-leader)
url: /iq/designs
pages: portal/src/pages/designs
audited: 2026-09-15 12:29 local, Chrome window (innerWidth 1692, innerHeight 858), middleware dev:mock (re-audit after the design thread started registering its title with the breadcrumb trail; signed in as u-vera via /select → Sign in as → Vera Green → Org → Org Leader; every field re-observed)
screenshot: designs.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px; breadcrumb "Design › Designs"; first-row-top: 330px (3 rows) under the H1, a one-line description and one Status pill row (All / Needs input / Awaiting sign-off / Ideating / Approved); no stat strip, no card stack, no nested rail; no horizontal scroll (scrollWidth 1692 = innerWidth 1692). On the thread page the trail now reads "Design › Designs › Session token rotation on tenant switch" — the design's title, where it used to read the truncated id "des-auth…"
keyboard: pass — 34 tabbable controls and all 34 accept focus (`.focus()` walk); each design title is a real `<button>`/link that opens the thread
empty-state: pass — the "Awaiting sign-off" pill renders "No design reviews / Nothing proposed right now." in the table slot; /iq/designs/des-nope renders "Could not load this design / 404 Not Found" under a "des-nope" breadcrumb whose "Designs" crumb is the way back — reads as not-found, not an outage
role-gating: org-leader sees every design and, on the thread she owns, the "Answer & continue the loop", Approve and Reject controls; nothing on the list page is role-dependent
notes: The thread page remains the strongest surface for the persona — it says what is blocked and on whom, and names the initiatives an answer touches. The design 404 still has no "← All designs" action of its own (the breadcrumb serves), where the initiative 404 has "← Back to Initiatives" — inconsistent, minor. member #1 / member #2 do not reproduce. Re-audit 2026-09-15 12:29: the thread page's breadcrumb carries the design title ("Session token rotation on tenant switch") instead of "des-auth…" — the page registers it with the shell once the thread loads, via the same channel any entity page can use. List unchanged: Session token rotation (Needs input, 1 question waiting on a human), RED dashboards (Ideating, 1 design gated), ADR tail-sampling (Approved, logged). GATED BY and KB still read "—" on two of three rows. Console errors 0.
