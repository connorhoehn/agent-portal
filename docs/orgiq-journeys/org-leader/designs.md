surface: designs
role: org-leader
user: u-vera (Vera Green); re-checked GET /api/session/me on arrival (sub u-vera, tenant orgiq, role org-leader)
url: /iq/designs
pages: portal/src/pages/designs
audited: 2026-09-05 23:28 local, Chrome 152 at 1552px, middleware dev:mock
screenshot: designs.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1352px; first-row-top: 262px; above the table one description (two lines at this width) and one Status pill row; no horizontal scroll (1552 = 1552)
keyboard: pass — 33 tabbable, all 33 reached in one 50-Tab sweep (focus-log diff: missing none); each design title is a real `<a href="/iq/designs/<id>">` — Enter on "Session token rotation on tenant switch" opens /iq/designs/des-auth-rotation (breadcrumb Design › Designs › des-auth…, "← All designs", the Needs input badge, Auth Migration · 4 posts, and "Answer & continue the loop" / Approve / Reject for this role); the five Status pills are real toggles (All 3 · Needs input 1 · Awaiting sign-off 0 · Ideating 1 · Approved 1)
empty-state: pass — the "Awaiting sign-off" pill renders "No design reviews / Nothing proposed right now." in the table slot; /iq/designs/des-nope renders "Could not load this design / 404 Not Found" under a "des-nope" breadcrumb whose "Designs" crumb is the way back — reads as not-found, not an outage
role-gating: org-leader sees every design and, on the thread she owns, the "Answer & continue the loop", Approve and Reject controls; nothing on the list page is role-dependent
notes: The thread page remains the strongest surface for the persona — it says what is blocked and on whom, and names the initiatives an answer touches. The design 404 still has no "← All designs" action of its own (the breadcrumb serves), where the initiative 404 has "← Back to Initiatives" — inconsistent, minor. member #1 / member #2 do not reproduce.
