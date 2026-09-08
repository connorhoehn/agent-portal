surface: designs
role: program-owner
user: u-mia (Mia Singh, p-030); signed in fresh via /select → Sign in as → Mia's card → Sign in → Org tile → "Program Owner" row; confirmed via GET /api/session/me (sub u-mia, tenant orgiq, role program-owner) before the surface
url: /iq/designs
pages: portal/src/pages/designs
audited: 2026-09-05 22:00 local, Chrome 152 at 1552px, middleware dev:mock
screenshot: designs.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; first-row-top: 286px; a two-line description and one Status filter row above the table, no card stack; no nested rail; no horizontal scroll (1552/1552)
keyboard: pass — 27 tabbable (no tabindex -1), all 27 reached in one 31-Tab sweep and verified by diffing the focus log against the DOM (missing: none): five status pills → the three row title links (`<a href="/iq/designs/des-auth-rotation">` …) → shell and rail; Enter on the first row opens the design thread (/iq/designs/des-auth-rotation); on the thread "← All designs", the three initiative links, the "Answer this question" textarea, "Answer & continue the loop" (disabled until text), Approve and Reject are real controls, and the PEOPLE panel rows (owner, SME, SME) are plain text — no hover-card trap
empty-state: pass — "Awaiting sign-off" (0 designs) renders "No design reviews / Nothing proposed right now." with `aria-pressed` moving correctly; /iq/designs/des-does-not-exist renders "Could not load this design / 404 Not Found" under a "Design › Designs › des-does…" breadcrumb — reads as not-found, not an outage; the only way back is the Designs breadcrumb (no "← All designs" action on the 404, unlike the thread page)
role-gating: program-owner can open every thread and sees Answer / Approve / Reject on "Session token rotation on tenant switch" (Needs input); nothing is hidden on this page for the role. Not pressed: Approve/Reject on a design owned by another initiative's people — a sign-off is a durable decision another role will audit
notes: The list is honest and dense. The thread page's "👉 Answer the open question below — the agents continue from your answer" is addressed to whoever opens it, not to the design's owner or SMEs — a program owner of a different initiative is invited to answer an intent question that belongs to Auth Migration's people; the page does not say who should answer. The breadcrumb truncates the id to "des-auth…" instead of showing the design's title. GATED BY and KB read "—" on two of three rows, so those two columns carry one value between them.
