surface: promotions
role: org-leader
user: u-vera (Vera Green); re-checked GET /api/session/me on arrival (sub u-vera, tenant orgiq, role org-leader)
url: /iq/promotions
pages: portal/src/pages/promotions
audited: 2026-09-05 23:27 local, Chrome 152 at 1552px, middleware dev:mock
screenshot: promotions.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1352px; first-row-top: 262px; above the table one description (two lines at this width) and one Status pill row; no horizontal scroll (1552 = 1552)
keyboard: pass — 34 tabbable, all 34 reached in one 50-Tab sweep (focus-log diff: missing none); each candidate title is a real `<button>` — Enter on "Retry the Data API through an Aurora cold start" opens the drawer (NEXT STEP, the observations) with focus on Close and Escape returns focus to the same row button; Enter on the candidate "Agent images need ADOT, not vanilla opentelemetry-distro" opens its drawer with Promote / Dismiss and "NEXT STEP: Approve to promote — insights need no dry run.", Escape returns focus to that row; the five Status pills are real toggles (aria-pressed flips, the list re-renders: All 4 · Candidates 2 · Approved 0 · Promoted 2 · Dismissed 0)
empty-state: pass — the Approved and Dismissed pills render "Nothing here / Nothing approved right now." and "Nothing here / Nothing dismissed right now." in the table slot
role-gating: org-leader (ManageBots true) sees the write controls in the drawer — Promote and Dismiss on a candidate; nothing on the page is hidden for this role. Not exercised: Promote / Dismiss themselves, which mutate the shared dev:mock state
notes: The CANDIDATE column now reads as one left-aligned block: the title button computes `text-align: left` and its left edge (217px) sits exactly over the "3 observations across 2 sessions" sub-line (217px) on all four rows — the zig-zag is gone (DEFECTS #8 closed). The seed has moved since the last pass: "Pin Fargate tasks to ARM64 or eat exec format error" is now Promoted (2 promoted, 2 candidates), and the Custodian runbook carries a "drifted" badge that the table explains only in the drawer.
