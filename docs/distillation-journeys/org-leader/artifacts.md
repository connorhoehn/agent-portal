surface: artifacts
role: org-leader
user: u-vera (Vera Green) — GET /api/session/me on this surface: sub u-vera, tenant orgiq, role org-leader
url: /iq/distillation/artifacts
audited: 2026-09-14 21:26 local, Chrome window (innerWidth 1692, innerHeight 858), worktree middleware dev:mock on :3011 behind the portal on :5184 (re-audit: Procedure filter, ?open= deep link, Steps + Runs drawer sections)
screenshot: artifacts.jpg
pages: portal/src/pages/distillation/ArtifactsPage.tsx,portal/src/pages/distillation/LineageFrame.tsx
verdict: pass
console errors: 0
layout: pass — no horizontal scroll (scrollWidth 1692 = innerWidth 1692); **first-row-top 330px** with the Procedure filter applied (3 rows). Drawer at 720px stacks header, Body, Steps (`StackDiagram`), Runs (`EventRow` list), Facts, mini-lineage without the page scrolling
keyboard: pass — 52 tabbable elements with the drawer closed and all 52 accept focus; unreachable list empty (org-leader's shell rail carries more items than member's, hence 52 vs 45). Arriving on ?open=art-009 opens the drawer; Escape closes it and drops `open` from the URL
empty-state: pass — Procedure + Retired → "No artifacts / No artifact matches these filters / Clear filters"; art-011's Runs section reads "Never run to completion — this procedure is unproven until a session applies it."
role-gating: org-leader holds ManageBots, the gate on `POST /api/distillation/procedures/:id/apply`, but the drawer ships no form for it in this slice — recording a run is API-only — so the surface is identical to member's. No other control on Artifacts is gated
notes: Opened "Bring SSO up on a new origin without breaking the picker" (Published, reviewed by Mia Singh): four steps all green (86 / 88 / 84 / 82% confidence, one observation each) and a Runs ledger of four Succeeded rows — 1h ago sess-auth-04, 2h ago sess-auth-06, 5h ago sess-auth-05, 8h ago sess-auth-04 — which is the evidence behind the Overview's "Proven · 4 runs, all succeeded". The Body's Why section ("Cognito rejects a non-localhost http callback before any app code runs …") is the supporting fact with ordinal null, listed once under Facts Re-checked 2026-09-14 21:26 after the review pass: facet change closes the drawer and drops `open` (?type=runbook, 3 rows, first-row-top 330px, console errors 0); the run node's lineage subtitle is the box id alone, the age beside it comes from the same relativeTime the ledger uses; a run node is now a lineage root, so "Focus here" on one no longer 404s.
