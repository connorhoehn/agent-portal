surface: review
role: member
user: u-theo (Theo Chang) — GET /api/session/me on this sign-in: sub u-theo, tenant orgiq, role member
url: /iq/distillation/review
audited: 2026-09-24 08:41 local, Chrome window (innerWidth 1670, innerHeight 677), middleware dev:mock (MOCK_QUEUE in-process), ui-components 2.388.2 (first audit of the Knowledge / Review / Activity redesign)
screenshot: review.jpg
pages: portal/src/pages/distillation/DistillationModule.tsx,portal/src/pages/distillation/ReviewTab.tsx,portal/src/pages/distillation/SourcesPanel.tsx,portal/src/pages/distillation/ExplainComposer.tsx
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1470px; trail "Build › Distillation › Review"; first-row-top: 374px (the first Pending row, "Bump session_epoch on every tenant/role switch · Guide · 4 notes · 3h ago") under the Pending 6 / Reviewed 21 tabs and one search field; no horizontal scroll; clipped-text sweep 0
keyboard: pass — 47 tabbable controls and all 47 accept focus (`.focus()` walk)
empty-state: pass — "zzznoexist" in Find a review reads "No matches — No sample in this list matches the search"
role-gating: member sees the queue, the claim ("Does this match the source run?"), Open this guide →, Earlier reviews and Sampling details, and instead of the note box and Agree / Disagree an info notice: "Read-only — You can inspect this claim and its evidence. Recording a verdict needs the ManageBots capability." No verdict control is in the DOM
notes: Queue rows carry the resolved target title and type, never a bare id. Console errors 0, read with onlyErrors after load and after each interaction.
