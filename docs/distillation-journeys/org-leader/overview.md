surface: overview
role: org-leader
user: u-vera (Vera Green) — signed in this session via /select → Sign in as → Vera Green → Workspaces → Org → Org Leader; GET /api/session/me returns sub u-vera, tenant orgiq, role org-leader
url: /iq/distillation/overview
audited: 2026-09-14 21:00 local, Chrome window (innerWidth 1692, innerHeight 858), worktree middleware dev:mock on :3011 behind the portal on :5184 (re-audit: procedures repertoire + "Proven procedures" tile)
screenshot: overview.jpg
pages: portal/src/pages/distillation/OverviewPage.tsx,portal/src/pages/distillation/ProcessFlow.tsx,portal/src/pages/distillation/CompactionFlowFrame.tsx
verdict: pass
console errors: 0
layout: pass — content col left 224px, sub-rail flush at x 224 (0px), no horizontal scroll (scrollWidth 1692 = innerWidth 1692), page body does not scroll (scrollHeight 858 = innerHeight 858). Six-tile strip on one line; the repertoire is one `DataTable` with 3 rows between the tier banners and Ingest pressure. Not a density surface
keyboard: pass — 50 tabbable elements and all 50 accept focus (`.focus()` walk asserting `document.activeElement`); unreachable list empty. org-leader's count is 8 higher than member's 42: the Bot runs node is a door for this role (11 flow stops vs 10) and the shell rail carries this role's extra items; the repertoire adds the same 3 title doors as for member. Enter on a title opens the artifact drawer via ?open=
empty-state: pass — same two scenario switches as the member log: applications empty → all three Unproven with empty gauges; artifacts empty → "No procedures yet …" and hint "no procedures"; `POST /api/__mock/reset` restored drifting / unproven / proven
role-gating: nothing on Overview is gated. org-leader holds ManageBots, which is what `POST /api/distillation/procedures/:id/apply` requires, but no control on this surface (or on Artifacts yet) posts to it — recording a run is API-only in this slice, so the page shows exactly what member sees. Bot runs 7 renders as a door for this role (member sees "—")
notes: Same three rows and verdicts as member — Drifting (SAML → Cognito cutover, 50%), Unproven (idle-capacity teardown, never run), Proven (SSO origin bring-up, 4/4) — with the drifting reason naming the session that last proved it and what moved since. Live counts: L0 76 / L1 22 behind (44 min) / L2 11 stalled (10h), Bot runs 7, Library 7, Human review 20. The tile "1/3 · 1 drifting" is the one-glance version; the section is the why
