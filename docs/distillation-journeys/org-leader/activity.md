surface: activity
role: org-leader
user: u-vera (Vera Green) — GET /api/session/me after POST /api/session/role {"role":"org-leader"}: sub u-vera, tenant orgiq, role org-leader
url: /iq/distillation/activity
audited: 2026-09-24 18:24 local, Chrome window (innerWidth 1670, innerHeight 677), middleware dev:mock (MOCK_QUEUE in-process), ui-components 2.388.2 (re-walk after the module moved from header tabs to the vertical sub-nav rail; empty-state and acceptance-journey results below the frame are from the 08:40–08:52 walk of the same surfaces, which this change did not touch)
screenshot: activity.jpg
pages: portal/src/pages/distillation/DistillationModule.tsx,portal/src/pages/distillation/ActivityTab.tsx,portal/src/pages/distillation/RunInspector.tsx
verdict: pass
console errors: 0
layout: pass — the Distillation sub-nav rail (200–419px: Knowledge → Guides & findings 11 / Patterns 22 / Run notes N; Review → Pending 7 / Reviewed 20; Activity → Runs, red while a tier is stalled / Tier graph; the current view carries aria-current="page", each entry's description is its tooltip) beside the content col (left 420px w 1250px); rail Activity → Runs current; Compact L0 → L1 / Compact L1 → L2 beside "Replica in sync"; first-row-top: 437px in the Runs view (the first run row); no horizontal scroll; exactly one <main>
keyboard: pass — 63 tabbable controls and all 63 accept focus (`.focus()` walk); graph nodes are focusable and arrow keys walk them in reading order
empty-state: pass — same runs list and filter as member; an inspector with no inputs listed says "The server did not list this job's inputs."
role-gating: org-leader gets Compact L0 → L1 and Compact L1 → L2 (POST /api/distillation/compact, which answers "queued" — the pass runs on the distillation queue and reports progress on distill:jobs)
notes: Acceptance journey 4 walked: Runs → Tier graph kept ?run=comp-101; the inspector shows Input / Output / Duration / Cost, What changed, Produced · N and Inputs / Run log / Technical details; opening a produced pattern lands in Knowledge on that pattern and Back returns to the same run in the Tier graph. Two defects found and fixed on this pass: the graph did not re-fit when the inspector opened (ui-components 2.388.2, TypedNodeCanvas re-fits on resize) and the Produced list carried the library default heading "Dependencies & decisions". Console errors 0, read with onlyErrors after load and after each interaction.
