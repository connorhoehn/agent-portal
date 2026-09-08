surface: dashboard
role: admin
user: u-operator
url: /assessment/teams
pages: portal/src/pages/assessment/DashboardPage.tsx,portal/src/pages/assessment/dashboard/CohortLanding.tsx,portal/src/pages/assessment/dashboard/TeamList.tsx,portal/src/pages/assessment/dashboard/NewTeamModal.tsx,portal/src/pages/assessment/dashboard/LevelBadge.tsx
audited: 2026-09-06 18:42 local, Chrome viewport 1560x913, middleware dev:mock (re-audit after the teal-brand / PageHeader change to CohortLanding; entered the Assessment workspace as admin from /select)
screenshot: dashboard.jpg
verdict: pass
console errors: 0 — cleared before the surface, re-read after the cohort click, Back, "View all teams", and the New team modal including a real create.
layout: pass — content col left 224px w 1312px; scrollWidth 1560 = innerWidth 1560 (no horizontal scroll); body scrollHeight 913 = innerHeight 913. "Engineering maturity cohorts" is an `<h1>` at 20px/600 with its box top at 125px — the same title size and offset as the other assessment pages. The three cohort cards hold one row; with eight teams the landing table now runs past the fold and scrolls inside its own container, not the page.
keyboard: pass — 12 visible, enabled interactive controls in `<main>` ("+ New team", three cohort cards, "View all teams", seven team-name buttons at the time of the sweep); a document-order `.focus()` sweep reached all 12, 0 unreachable, and each is a real `<button type="button">` so Enter/Space activation is native. Escape closed the "+ New team" modal, whose Name field is auto-focused. Workaround used (no display session): `.focus()` sweep instead of physical Tab, `.click()` and dispatched `keydown` for activation/Escape, two screenshots per state so a frame painted before each DOM read.
empty-state: pass — the seeded unassessed teams have all been scored by this session's wizard runs, so the unassessed state was re-created honestly: "+ New team" → "Audit Sandbox" / Self-Service created TEAM-008, which lands in the landing table as "Not yet assessed · 0/17 · —" and bumps the Self-Service card from 2 teams to 3. Its scorecard opens on "Not yet assessed · 0 of 17 dimensions", certification "Not yet assessed", workflow step "Intake", every dimension showing an em-dash level, and "No follow-up questions." — an empty team renders as empty everywhere rather than as zeros pretending to be scores.
role-gating: the cross-tenant wildcard role sees exactly the assessment tenant's own rail — 11 items (Dashboard, Submissions, Reports, Feedback, Enterprise, Workspace, Prompts, Rules, Activity, Configuration, Settings) with Configuration present as it is for program-lead. No orgiq entry leaks into the rail. On the dashboard itself admin has the same controls as everyone else.
notes: Creating a team is a one-step commit that navigates straight to the new team's scorecard, which is the right landing — you immediately see what an unassessed team looks like and where to add evidence. The teal brand carries the rail selection, "+ New team" and the card arrows; the L3 badges stay indigo. Clicking White Glove filters to `?cohort=white_glove` (2 teams) and Back restores the landing; "View all teams" lists all eight at `?cohort=all`. The all-teams table still shows TEAM-006 and TEAM-007 as status "New" while reading 17/17 assessed with 16 open follow-ups — the status-not-advanced inconsistency recorded as lead-assessor/DEFECTS.md Open #2.

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
Vite proxy), signed in through /select as Platform Operator (u-operator, admin, Assessment tile):
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
