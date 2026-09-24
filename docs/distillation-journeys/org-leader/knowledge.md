surface: knowledge
role: org-leader
user: u-vera (Vera Green) — GET /api/session/me after POST /api/session/role {"role":"org-leader"}: sub u-vera, tenant orgiq, role org-leader
url: /iq/distillation/knowledge
audited: 2026-09-24 08:46 local, Chrome window (innerWidth 1670, innerHeight 677), middleware dev:mock (MOCK_QUEUE in-process), ui-components 2.388.2 (first audit of the Knowledge / Review / Activity redesign)
screenshot: knowledge.jpg
pages: portal/src/pages/distillation/DistillationModule.tsx,portal/src/pages/distillation/KnowledgeTab.tsx,portal/src/pages/distillation/KnowledgeRecord.tsx,portal/src/pages/distillation/ProcedureRuns.tsx,portal/src/pages/distillation/SourcesPanel.tsx,portal/src/pages/distillation/ExplainComposer.tsx
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1470px; first-row-top: 384px (the first Recently updated row); no horizontal scroll; clipped-text sweep 0
keyboard: pass — 64 tabbable controls and all 64 accept focus (`.focus()` walk)
empty-state: pass — same explorer and empty lines as member ("No matches"); the Sources graph at 34% after Fit shows all eight lineage nodes of art-001 with "7 linked records" and Show as list
role-gating: org-leader holds ManageBots: the drifting procedure "Cut one tenant over from SAML to Cognito" (art-010) shows its steps with latest-run markers (✓ ✓ ! ○, "flag flipped but the hosted-UI redirect still resolved to the old domain" under step 3); its Runs tab has "Latest run stopped at step 3", STEPS IN THE LATEST RUN, RUN HISTORY (Failed at step 3 · 1h ago; Succeeded · 6h ago) and the RECORD A RUN form (Succeeded / Failed / Abandoned, note, Record run)
notes: The Overview mockup's procedure inspector is folded into the record as the Runs tab, as the build spec planned. Console errors 0, read with onlyErrors after load and after each interaction.
