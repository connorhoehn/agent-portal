surface: review
role: org-leader
user: u-vera (Vera Green) — GET /api/session/me after POST /api/session/role {"role":"org-leader"}: sub u-vera, tenant orgiq, role org-leader
url: /iq/distillation/review
audited: 2026-09-24 08:47 local, Chrome window (innerWidth 1670, innerHeight 677), middleware dev:mock (MOCK_QUEUE in-process), ui-components 2.388.2 (first audit of the Knowledge / Review / Activity redesign)
screenshot: review.jpg
pages: portal/src/pages/distillation/DistillationModule.tsx,portal/src/pages/distillation/ReviewTab.tsx,portal/src/pages/distillation/SourcesPanel.tsx,portal/src/pages/distillation/ExplainComposer.tsx
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1470px; first-row-top: 374px (the first Pending row); no horizontal scroll; clipped-text sweep 0
keyboard: pass — 58 tabbable controls and all 58 accept focus (`.focus()` walk)
empty-state: pass — "zzznoexist" reads "No sample in this list matches the search" (same component as member)
role-gating: org-leader gets the note box ("Your review", Add a note about the evidence…), ✓ Agree / ✕ Disagree and "This records your review; it does not publish the guide."
notes: Acceptance journey 3 walked: a note + Agree on "Cut one tenant over from SAML to Cognito" toasted "Recorded: agree — The guide is not published by a review.", Pending went 7 → 6 and Reviewed 20 → 21, the next sample ("Bump session_epoch …") opened, and the decided one is listed under Reviewed as Agreed. The header's Review count now refreshes with the verdict (it used to wait for the poll). The fixture was reset afterwards. Console errors 0, read with onlyErrors after load and after each interaction.
