surface: designs
role: sme
user: u-nora (Nora DaSilva); re-confirmed via GET /api/session/me on this page (sub u-nora, role sme, tenant orgiq)
url: /iq/designs
pages: portal/src/pages/designs
audited: 2026-09-05 21:36 local, Chrome 152 at 1552px, middleware dev:mock (re-audit)
screenshot: designs.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; first-row-top: 286px; a two-line description + one Status filter row above the table, no card stack; no nested rail; no horizontal scroll (1552/1552)
keyboard: pass — 27 tabbable of 27 focusable; one Tab sweep from a body click reached every one (focusin log diffed against the DOM: missing = []): five status pills → the three row title links (`<a href="/iq/designs/des-auth-rotation">` …) → shell and rail; Enter on the first row link opens the design thread (/iq/designs/des-auth-rotation); on the thread page "← All designs", the three initiative links, the answer textarea, "Answer & continue the loop" (disabled until text), Approve and Reject are real controls, and the PEOPLE panel (Vera Green owner · Nora Chang SME · Nora DaSilva SME) is plain rows — no hover-card dialog, no trap
empty-state: pass — "Awaiting sign-off" (0 designs) renders "No design reviews / Nothing proposed right now." with `aria-pressed` moving correctly (Needs input 1, Ideating 1, Approved 1, All 3); /iq/designs/des-does-not-exist renders "Could not load this design / 404 Not Found" under the breadcrumb — reads as not-found; the way back is the "Designs" breadcrumb (the thread page's new "← All designs" link is not rendered on the 404 state)
role-gating: the list has no write control for any role; on the thread page sme gets the answer form and Approve/Reject — Nora is an SME on Auth Migration, so answering the open intent question is exactly her job here. Pressing Approve on the "Needs input" thread is refused with an explained toast "✗ Sign-off refused — no decision post yet — the thread has not converged" (state gate, not role gate); nothing admin-only is rendered
notes: For the persona the list answers "which design is waiting on me?" — "1 question waiting on a human" under the first row plus the "Needs input" chip does it, and the thread page says exactly what to do ("👉 Answer the open question below — the agents continue from your answer") and lists who is on it. The thread page gained a "← All designs" link since the last pass. Member's DEFECTS #1 (row mouse-only) and #2 (dead status pills) still reproduce as fixed here.
