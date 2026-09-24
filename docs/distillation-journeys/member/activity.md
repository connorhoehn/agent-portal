surface: activity
role: member
user: u-theo (Theo Chang) — GET /api/session/me on this sign-in: sub u-theo, tenant orgiq, role member
url: /iq/distillation/activity
audited: 2026-09-24 18:22 local, Chrome window (innerWidth 1670, innerHeight 677), middleware dev:mock (MOCK_QUEUE in-process), ui-components 2.388.2 (re-walk after the module moved from header tabs to the vertical sub-nav rail; empty-state and acceptance-journey results below the frame are from the 08:40–08:52 walk of the same surfaces, which this change did not touch)
screenshot: activity.jpg
pages: portal/src/pages/distillation/DistillationModule.tsx,portal/src/pages/distillation/ActivityTab.tsx,portal/src/pages/distillation/RunInspector.tsx
verdict: pass
console errors: 0
layout: pass — the Distillation sub-nav rail (200–419px: Knowledge → Guides & findings 11 / Patterns 22 / Run notes N; Review → Pending 7 / Reviewed 20; Activity → Runs, red while a tier is stalled / Tier graph; the current view carries aria-current="page", each entry's description is its tooltip) beside the content col (left 420px w 1250px); trail "Build › Distillation › Activity"; rail Activity → Runs current; PageHeader "Compaction activity" with the Runs | Tier graph switch and "Replica in sync"; one health banner ("Guide updates stalled · Last run 19h ago — 10 patterns waiting for L2 …"), the tier-flow strip (L0 642 · 12 writing → Compact → L1 22 · Stalled → Compact → L2 11 · Stalled → Publish → Library 7 linked); first-row-top: 437px (the first run row, "Run notes → Patterns · Completed · 13 run notes → 4 patterns · started 9h ago"); no horizontal scroll (scrollWidth 1670 = innerWidth); exactly one <main>
keyboard: pass — 53 tabbable controls and all 53 accept focus (`.focus()` walk)
empty-state: pass — the runs list reads "11 of 11 runs" and Filter runs narrows it; a filter with no match reads its own empty line (same GroupedList as Knowledge)
role-gating: member reads runs, the tier graph and the run inspector; no Compact L0 → L1 / L1 → L2 buttons (0 in DOM, ManageBots only)
notes: The banner is driven by tier health from GET /api/distillation/levels, not by "last completed" alone; "Replica in sync" reads GET /api/distillation/replication (distributed-core MerkleSyncer between the L2 primary and its replica). Console errors 0, read with onlyErrors after load and after each interaction.
