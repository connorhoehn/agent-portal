surface: review
role: org-leader
user: u-vera (Vera Green) — GET /api/session/me after POST /api/session/role {"role":"org-leader"}: sub u-vera, tenant orgiq, role org-leader
url: /iq/distillation/review
audited: 2026-09-24 18:23 local, Chrome window (innerWidth 1670, innerHeight 677), middleware dev:mock (MOCK_QUEUE in-process), ui-components 2.388.2 (re-walk after the module moved from header tabs to the vertical sub-nav rail; empty-state and acceptance-journey results below the frame are from the 08:40–08:52 walk of the same surfaces, which this change did not touch)
screenshot: review.jpg
pages: portal/src/pages/distillation/DistillationModule.tsx,portal/src/pages/distillation/ReviewTab.tsx,portal/src/pages/distillation/SourcesPanel.tsx,portal/src/pages/distillation/ExplainComposer.tsx
verdict: pass
console errors: 0
layout: pass — the Distillation sub-nav rail (200–419px: Knowledge → Guides & findings 11 / Patterns 22 / Run notes N; Review → Pending 7 / Reviewed 20; Activity → Runs, red while a tier is stalled / Tier graph; the current view carries aria-current="page", each entry's description is its tooltip) beside the content col (left 420px w 1250px); rail Review → Pending current; first-row-top: 344px (the first Pending row); no horizontal scroll
keyboard: pass — 66 tabbable controls and all 66 accept focus (`.focus()` walk)
empty-state: pass — "zzznoexist" reads "No sample in this list matches the search" (same component as member)
role-gating: org-leader gets the note box ("Your review", Add a note about the evidence…), ✓ Agree / ✕ Disagree and "This records your review; it does not publish the guide."
notes: Acceptance journey 3 walked: a note + Agree on "Cut one tenant over from SAML to Cognito" toasted "Recorded: agree — The guide is not published by a review.", Pending went 7 → 6 and Reviewed 20 → 21, the next sample ("Bump session_epoch …") opened, and the decided one is listed under Reviewed as Agreed. The rail's Pending count now refreshes with the verdict (it used to wait for the poll). The fixture was reset afterwards. Console errors 0, read with onlyErrors after load and after each interaction.
