surface: dashboard
role: program-lead
user: u-farah
url: /assessment/teams
pages: portal/src/pages/assessment/DashboardPage.tsx,portal/src/pages/assessment/dashboard/CohortLanding.tsx,portal/src/pages/assessment/dashboard/TeamList.tsx,portal/src/pages/assessment/dashboard/NewTeamModal.tsx,portal/src/pages/assessment/dashboard/LevelBadge.tsx
audited: 2026-09-06 18:31 local, Chrome viewport 1560x913, middleware dev:mock (re-audit after the teal-brand / PageHeader change to CohortLanding)
screenshot: dashboard.jpg
verdict: pass
console errors: 0 — cleared before the surface, re-read after the cohort click, Back, "View all teams" and the New team modal.
layout: pass — content col left 224px w 1312px; scrollWidth 1560 = innerWidth 1560 (no horizontal scroll); body scrollHeight 913 = innerHeight 913. "Engineering maturity cohorts" is an `<h1>` at 20px/600 with its box top at 125px — the same size and offset as Submissions and the team detail, so the tenant's page titles now agree. The three cohort cards hold one row and the seven-row table needs no horizontal scrolling.
keyboard: pass — 12 visible, enabled interactive controls in `<main>` ("+ New team", three cohort cards, "View all teams", seven team-name buttons); a document-order `.focus()` sweep reached all 12, 0 unreachable, and each is a real `<button type="button">` so Enter/Space activation is native. Escape closed the "+ New team" modal, whose Name field is auto-focused on open. Workaround used (no display session): `.focus()` sweep instead of physical Tab, `.click()` and dispatched `keydown` for activation/Escape, two screenshots per state so a frame painted before each DOM read.
empty-state: pass — TEAM-007 "Internal Tools" renders unassessed cleanly: muted "Not yet assessed", 0/17, "—" follow-ups, "New" pill with an em-dash lead in the all-teams table. (TEAM-006 no longer serves as the second example — this session's wizard passes scored it to 17/17. Session data in the in-memory mock, not a page change.)
role-gating: this is the only role whose rail carries **Configuration** — 11 items (Dashboard, Submissions, Reports, Feedback, Enterprise, Workspace, Prompts, Rules, Activity, Configuration, Settings) against the assessor's and lead-assessor's 10. On the dashboard itself the control set is the same as the other roles: "+ New team", the cohort cards, "View all teams", the team links.
notes: The teal chrome (rail selection, "+ New team", cohort-card arrows) sits against indigo L3 badges and amber follow-up counts without any of the three fighting. White Glove → `?cohort=white_glove` shows the 2-team cohort view and browser Back restores the landing; "View all teams" lists all seven at `?cohort=all`. Same self-contradiction visible here as in the lead-assessor pass: TEAM-006 reads "New · — · 17/17 · 16 open" because processing a submission scores dimensions without advancing the team's status (lead-assessor/DEFECTS.md Open #2).

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
Vite proxy), signed in through /select as Farah Osei (u-farah, program-lead):
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
