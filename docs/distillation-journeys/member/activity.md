surface: activity
role: member
user: u-theo (Theo Chang) — GET /api/session/me on this sign-in: sub u-theo, tenant orgiq, role member
url: /iq/distillation/activity
audited: 2026-09-24 08:52 local, Chrome window (innerWidth 1670, innerHeight 677), middleware dev:mock (MOCK_QUEUE in-process), ui-components 2.388.2 (first audit of the Knowledge / Review / Activity redesign)
screenshot: activity.jpg
pages: portal/src/pages/distillation/DistillationModule.tsx,portal/src/pages/distillation/ActivityTab.tsx,portal/src/pages/distillation/RunInspector.tsx
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1470px; trail "Build › Distillation › Activity"; PageHeader "Compaction activity" with the Runs | Tier graph switch and "Replica in sync"; one health banner ("Guide updates stalled · Last run 10h ago — 10 patterns waiting for L2 …"), the tier-flow strip (L0 112 · 14 writing → Compact → L1 22 · 1h 21m behind → Compact → L2 11 · Stalled → Publish → Library 7 linked); first-row-top: 467px (the first run row, "Run notes → Patterns · Completed · 13 run notes → 4 patterns · started 56m ago"); no horizontal scroll (scrollWidth 1670 = innerWidth)
keyboard: pass — 46 tabbable controls and all 46 accept focus (`.focus()` walk)
empty-state: pass — the runs list reads "11 of 11 runs" and Filter runs narrows it; a filter with no match reads its own empty line (same GroupedList as Knowledge)
role-gating: member reads runs, the tier graph and the run inspector; no Compact L0 → L1 / L1 → L2 buttons (0 in DOM, ManageBots only)
notes: The banner is driven by tier health from GET /api/distillation/levels, not by "last completed" alone; "Replica in sync" reads GET /api/distillation/replication (distributed-core MerkleSyncer between the L2 primary and its replica). Console errors 0, read with onlyErrors after load and after each interaction.
