surface: review
role: member
user: u-theo (Theo Chang) — GET /api/session/me on this sign-in: sub u-theo, tenant orgiq, role member
url: /iq/distillation/review
audited: 2026-09-24 18:22 local, Chrome window (innerWidth 1670, innerHeight 677), middleware dev:mock (MOCK_QUEUE in-process), ui-components 2.388.2 (re-walk after the module moved from header tabs to the vertical sub-nav rail; empty-state and acceptance-journey results below the frame are from the 08:40–08:52 walk of the same surfaces, which this change did not touch)
screenshot: review.jpg
pages: portal/src/pages/distillation/DistillationModule.tsx,portal/src/pages/distillation/ReviewTab.tsx,portal/src/pages/distillation/SourcesPanel.tsx,portal/src/pages/distillation/ExplainComposer.tsx
verdict: pass
console errors: 0
layout: pass — the Distillation sub-nav rail (200–419px: Knowledge → Guides & findings 11 / Patterns 22 / Run notes N; Review → Pending 7 / Reviewed 20; Activity → Runs, red while a tier is stalled / Tier graph; the current view carries aria-current="page", each entry's description is its tooltip) beside the content col (left 420px w 1250px); trail "Build › Distillation › Review"; rail Review → Pending current; first-row-top: 344px (the first Pending row, "Cut one tenant over from SAML to Cognito · Guide · 4 notes · 4h ago") under the in-queue Pending 7 / Reviewed 20 tabs and one search field; no horizontal scroll; exactly one <main>
keyboard: pass — 55 tabbable controls and all 55 accept focus (`.focus()` walk)
empty-state: pass — "zzznoexist" in Find a review reads "No matches — No sample in this list matches the search"
role-gating: member sees the queue, the claim ("Does this match the source run?"), Open this guide →, Earlier reviews and Sampling details, and instead of the note box and Agree / Disagree an info notice: "Read-only — You can inspect this claim and its evidence. Recording a verdict needs the ManageBots capability." No verdict control is in the DOM
notes: Queue rows carry the resolved target title and type, never a bare id. Console errors 0, read with onlyErrors after load and after each interaction.
