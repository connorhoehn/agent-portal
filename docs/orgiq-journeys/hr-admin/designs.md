surface: designs
role: hr-admin
user: u-rachel (Rachel Kowalski) — verified via GET /api/session/me on this surface (sub u-rachel, role hr-admin, tenant orgiq)
url: /iq/designs
pages: portal/src/pages/designs
audited: 2026-09-15 12:29 local, Chrome window (innerWidth 1692, innerHeight 858), middleware dev:mock (re-audit after the design thread started registering its title with the breadcrumb trail; signed in as u-rachel via /select → Sign in as → Rachel Kowalski → Org → HR Admin; every field re-observed)
screenshot: designs.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px; breadcrumb "Design › Designs"; first-row-top: 330px (3 rows) under the H1, a one-line description and one Status pill row (All / Needs input / Awaiting sign-off / Ideating / Approved); no stat strip, no card stack, no nested rail; no horizontal scroll (scrollWidth 1692 = innerWidth 1692). On the thread page the trail now reads "Design › Designs › Session token rotation on tenant switch" — the design's title, where it used to read the truncated id "des-auth…"
keyboard: pass — 37 tabbable controls and all 37 accept focus (`.focus()` walk); each design title is a real `<button>`/link that opens the thread
empty-state: pass — filtering to "Awaiting sign-off" (0 designs in this seed) toggles the pill's aria-pressed and renders "No design reviews / Nothing proposed right now." in place of the table
role-gating: same read surface every role gets — no sign-off or approve control lives on this list (those are on the thread page); the Gated by / KB columns show which designs gate other work and which are logged as ADRs
notes: the list is the page — three rows, honest per-row sub-lines ("1 question waiting on a human", "3 sign-offs · in the knowledge base"), and the Status pill both filters and re-filters back to All without a reload. Re-audit 2026-09-15 12:29: the thread page's breadcrumb carries the design title ("Session token rotation on tenant switch") instead of "des-auth…" — the page registers it with the shell once the thread loads, via the same channel any entity page can use. List unchanged: Session token rotation (Needs input, 1 question waiting on a human), RED dashboards (Ideating, 1 design gated), ADR tail-sampling (Approved, logged). GATED BY and KB still read "—" on two of three rows. Console errors 0.
