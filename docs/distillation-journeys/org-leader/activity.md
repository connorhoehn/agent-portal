surface: activity
role: org-leader
user: u-vera (Vera Green) — GET /api/session/me after POST /api/session/role {"role":"org-leader"}: sub u-vera, tenant orgiq, role org-leader
url: /iq/distillation/activity
audited: 2026-09-24 08:51 local, Chrome window (innerWidth 1670, innerHeight 677), middleware dev:mock (MOCK_QUEUE in-process), ui-components 2.388.2 (first audit of the Knowledge / Review / Activity redesign)
screenshot: activity.jpg
pages: portal/src/pages/distillation/DistillationModule.tsx,portal/src/pages/distillation/ActivityTab.tsx,portal/src/pages/distillation/RunInspector.tsx
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1470px; Tier graph with the run inspector open: the canvas (200–1290px) fits all four tiers at 76% on first render (L0 · Run notes 112, L1 · Patterns 22, L2 · Guides & findings 11, Publish · Library 7) beside the inspector (1290–1670px); first-row-top: 467px in the Runs view (the first run row); no horizontal scroll
keyboard: pass — 56 tabbable controls and all 56 accept focus (`.focus()` walk); graph nodes are focusable (arrow-key walking in reading order is covered by the library's TypedNodeCanvas tests, not re-driven here)
empty-state: pass — same runs list and filter as member; an inspector with no inputs listed says "The server did not list this job's inputs."
role-gating: org-leader gets Compact L0 → L1 and Compact L1 → L2 (POST /api/distillation/compact, which answers "queued" — the pass runs on the distillation queue and reports progress on distill:jobs)
notes: Acceptance journey 4 walked: Runs → Tier graph kept ?run=comp-101; the inspector shows Input / Output / Duration / Cost, What changed, Produced · N and Inputs / Run log / Technical details; opening a produced pattern lands in Knowledge on that pattern and Back returns to the same run in the Tier graph. Two defects found and fixed on this pass: the graph did not re-fit when the inspector opened (ui-components 2.388.2, TypedNodeCanvas re-fits on resize) and the Produced list carried the library default heading "Dependencies & decisions". Console errors 0, read with onlyErrors after load and after each interaction.
