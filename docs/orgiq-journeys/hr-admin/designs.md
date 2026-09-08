surface: designs
role: hr-admin
user: u-rachel (Rachel Kowalski) — verified via GET /api/session/me on this surface (sub u-rachel, role hr-admin, tenant orgiq)
url: /iq/designs
pages: portal/src/pages/designs
audited: 2026-09-06 00:29 local, Chrome 1552px, middleware dev:mock
screenshot: designs.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; breadcrumb "Design › Designs"; first-row-top: 326px (3 rows); above the table one two-line description and one Status pill row (All/Needs input/Awaiting sign-off/Ideating/Approved) — nothing else; no horizontal scroll (1552 = 1552)
keyboard: pass — 36 controls counted, 36 reached by a 39-press Tab sweep (rail → the 5 status pills → each row's design title, a real `<a>` into the design thread → wraps)
empty-state: pass — filtering to "Awaiting sign-off" (0 designs in this seed) toggles the pill's aria-pressed and renders "No design reviews / Nothing proposed right now." in place of the table
role-gating: same read surface every role gets — no sign-off or approve control lives on this list (those are on the thread page); the Gated by / KB columns show which designs gate other work and which are logged as ADRs
notes: the list is the page — three rows, honest per-row sub-lines ("1 question waiting on a human", "3 sign-offs · in the knowledge base"), and the Status pill both filters and re-filters back to All without a reload.
