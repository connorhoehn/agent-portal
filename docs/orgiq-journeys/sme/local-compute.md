surface: local-compute
role: sme
user: u-nora (Nora DaSilva) — GET /api/session/me on this surface: sub u-nora, tenant orgiq, role sme
url: /iq/local-compute
pages: portal/src/pages/local-compute
audited: 2026-09-15 08:22 local, Chrome window (innerWidth 1692, innerHeight 858), middleware dev:mock (first audit of this surface — it entered the rail with the local-compute work of 2026-09-14 and the pairing flow of 2026-09-15)
screenshot: local-compute.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px; breadcrumb "Build › Local compute"; no horizontal scroll (scrollWidth 1692 = innerWidth 1692). Not a list surface for this persona: no machine is paired to u-nora in the seed, so the page is the title, one description line and the empty state ("No paired machines / Pair a machine and it appears here, ready to accept work — the dialog gives you a code and the one command to run on it." with a "Pair a machine" button). When a machine is paired the page becomes three DetailSections — Your machines (a DataTable with an "Accepting work" Switch per row), Hand work to <machine> (the TaskComposer, with a banner while the machine is paused or offline) and Your runs — observed as org-leader after claiming a code
keyboard: pass — 21 tabbable controls and all 21 accept focus (`.focus()` walk asserting `document.activeElement`); "Pair a machine" opens a Modal whose focus lands inside it, Escape closes it and focus returns to the button
empty-state: pass — the empty state IS the seeded state for this persona; it names the next action and offers it. The dialog's own quiet states: "Minting a pairing code…" while the POST is in flight, a danger Banner if it fails
role-gating: sme holds ConnectLocalCompute (member.cedar's rationale: pairing is personal, not fleet authority — every node is bound to the pairing session's sub), so "Pair a machine" is present and POST /api/local-compute/pair/start returns 200 with an 8-character code; dispatching work to a machine is a separate question answered per row once one exists. Rail for this role: Initiatives · Designs · Promotions · Library · Automate · Distillation · Local compute · Computer Lab · Session config · Ask · Explore · Settings
notes: Sits directly above Computer Lab in Build now — the two machine doors (your own paired laptop vs the microVM fleet) are adjacent, which is the IA change of 2026-09-15.
