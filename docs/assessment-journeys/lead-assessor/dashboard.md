surface: dashboard
role: lead-assessor
user: u-jonas
url: /assessment/teams
pages: portal/src/pages/assessment/DashboardPage.tsx,portal/src/pages/assessment/dashboard/CohortLanding.tsx,portal/src/pages/assessment/dashboard/TeamList.tsx,portal/src/pages/assessment/dashboard/NewTeamModal.tsx,portal/src/pages/assessment/dashboard/LevelBadge.tsx
audited: 2026-09-06 18:20 local, Chrome viewport 1560x913, middleware dev:mock (re-audit after the teal-brand / PageHeader change to CohortLanding)
screenshot: dashboard.jpg
verdict: pass
console errors: 0 — cleared before the surface, re-read after the cohort click, Back, "View all teams" and the New team modal.
layout: pass — content col left 224px w 1312px; scrollWidth 1560 = innerWidth 1560 (no horizontal scroll); body scrollHeight 913 = innerHeight 913. "Engineering maturity cohorts" is an `<h1>` at 20px/600 with its box top at 125px — the same title size and offset as Submissions and every other page in the tenant, so the three surfaces no longer disagree about how big a page title is. The three cohort cards sit on one row with no wrapping.
keyboard: pass — 12 visible, enabled interactive controls in `<main>` ("+ New team", three cohort cards, "View all teams", seven team-name buttons); a document-order `.focus()` sweep reached all 12, 0 unreachable, and every one is a real `<button type="button">`, so Enter/Space activation is native. Escape closed the "+ New team" modal (`[role=dialog]` gone). Workaround used (no display session): `.focus()` sweep instead of physical Tab, `.click()` and dispatched `keydown` for activation/Escape, two screenshots per state so a frame painted before each DOM read.
empty-state: pass — TEAM-007 "Internal Tools" renders the unassessed state correctly: muted "Not yet assessed" in the certification cell, 0/17 assessed, "—" follow-ups, and a "New" pill with an em-dash lead in the "View all teams" table. (TEAM-006 is no longer an unassessed example: this session's submissions-wizard pass processed a submission against it, so it now reads 17/17 with 16 open follow-ups. That is session data in the in-memory mock, not a page change.)
role-gating: identical control set to the assessor on this surface — "+ New team", the cohort cards, "View all teams", every team-name link. Rail is Dashboard, Submissions, Reports, Feedback, Enterprise, Workspace, Prompts, Rules, Activity, Settings; no Configuration entry, and the string "Configuration" does not appear anywhere in the document. The lead-assessor's extra powers (approve exceptions, publish reports) live on the scorecard and reports surfaces, not here.
notes: The teal brand carries the active rail item, "+ New team" and the cohort-card arrows, while the L3 badges stay indigo — chrome and data stay separable. Clicking White Glove filters to `?cohort=white_glove` (2 teams, 4 stat tiles, search + status select) and browser Back restores the landing with all three cards; "View all teams" lists all seven. One inconsistency worth flagging, visible in the "View all teams" table: TEAM-006 now shows 17/17 assessed and 16 open follow-ups while its status pill still reads "New" and its certification still reads "Working toward" — processing a submission scores the dimensions but does not advance the team's workflow status, so the row disagrees with itself. Not caused by this page's rendering, but a reader would read it as a bug.

--- freshness re-observation, 2026-09-08 (the Lead cell) ---
Why: `portal/src/pages/assessment/dashboard/TeamList.tsx` changed, which moved this
log's `pages:` digest. The change is narrow and is the portal half of the
assessment wire-field correction: `TeamSummary.assessment_lead_person_id`,
`TeamDetail.assessment_lead_person_id` and `contributors[].person_id` were
deleted from `pages/assessment/types.ts` because the server sends none of them
(verified live across all 7 teams, and asserted absent by
`middleware/src/providers/__tests__/assessment-declared-fields.test.ts`). The two
places that read them therefore stopped wrapping the lead's name in `PersonRef`.
Nothing was lost by that: `PersonRef` was always being handed a null personId
here, and with a null id it returns its plain, NON-focusable branch before any of
its hover/pin machinery — and in this tenant it would refuse to link anyway
(`linkable = session?.tenant === 'orgiq'`). The lead was already a name, not a
control; it is now a name written as one.
Re-observed live at 1552px on `npm run dev:mock` (127.0.0.1:3011 behind a pinned
Vite proxy), signed in through /select as Jonas Lindqvist (u-jonas, lead-assessor):
  - `/assessment/teams` (this surface): **12** visible, enabled controls in
    `<main>`, and a document-order `.focus()` sweep reached all 12 — exactly the
    12 this log's `keyboard:` line already records, unchanged.
  - `/assessment/teams?cohort=all` (the TeamList table this surface opens into):
    the Lead column renders plain text with **0** focusable controls per cell.
The em dash matters and was preserved deliberately: `assessment_lead` is the
empty string on TEAM-006 and TEAM-007, and `PersonRef`'s "no name" branch used to
render "—" for them. A bare data key would have left those cells blank, which
reads as a rendering fault rather than as "nobody yet", so the column keeps the
em dash the rest of this table uses for an empty. Verified: the seven Lead cells
read Dana Whitfield, Sam Okafor, —, —, Elena Marsh, Priya Natarajan, Jordan Lee,
and each one contains 0 focusable controls.
Console errors: 0 on both surfaces.
