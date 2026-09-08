surface: designs
role: member
user: u-theo (Theo Chang) — GET /api/session/me on this sign-in: sub u-theo, tenant orgiq, role member
url: /iq/designs
pages: portal/src/pages/designs
audited: 2026-09-06 10:53 local, Chrome 1552×789, middleware dev:mock
screenshot: designs.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; breadcrumb "Design › Designs"; first-row-top: 326px (3 rows); one H1 + a two-line description and one Status pill row above the table; no horizontal scroll (scrollWidth 1552 = innerWidth)
keyboard: pass — 26 tabbable controls, none with tabIndex −1, all 26 reached in a 32-press Tab sweep (focus-log diff: missing none); the Status pills are `<button aria-pressed>`; each row's design name is a real `<a href="/iq/designs/:id">` (opened /iq/designs/des-auth-rotation)
empty-state: pass — "Awaiting sign-off" (a status no seeded design has) shows "No design reviews / Nothing proposed right now." with the pill pressed; /iq/designs/nope-not-real renders the breadcrumb and "Could not load this design / 404 Not Found"
role-gating: member can filter the list and read a full thread (summary, initiatives affected, people, the agent's posts, sign-offs). On /iq/designs/des-auth-rotation the thread renders no answer, reply or sign-off control for member (`<main>` holds zero button/input/textarea elements) and the summary card's next-step line now reads "👉 An owner or SME will answer the open question below." — the question post is still badged "needs a human", which is now consistent with the copy
notes: DEFECTS #12 re-observed fixed and closed. The thread breadcrumb truncates the design id to "des-auth…" rather than showing the design's title. The approved "ADR: tail-sampling policy" thread is correctly immutable and marked "logged" in the KB column.
