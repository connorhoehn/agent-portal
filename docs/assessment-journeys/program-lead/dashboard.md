surface: dashboard
role: program-lead
user: u-farah
url: /assessment/teams
pages: portal/src/pages/assessment/DashboardPage.tsx,portal/src/pages/assessment/dashboard/AssessorDesk.tsx,portal/src/pages/assessment/dashboard/NewTeamModal.tsx,portal/src/pages/assessment/dashboard/LevelBadge.tsx,portal/src/pages/assessment/assessmentFormat.ts
audited: 2026-09-15 19:53 local, Chrome window (innerWidth 1692, innerHeight 858), middleware dev:mock (re-audit after the dashboard became the assessor's desk — docs/assessment-ux-goal.md slice 1: the three motion cards and the separate per-cohort list are gone, one dense DataTable carries every team with two-track certification and a computed next action; signed in as u-farah via /select → Sign in as → Farah Osei (Assessment · program-lead); every field re-observed)
screenshot: dashboard.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px; breadcrumb "Assess › Dashboard"; "Assessor's desk" is the `<h1>` with "+ New team" in its action slot; one StatStrip (TEAMS 7 · VERIFIED AT L3 3 · CLAIMS OPEN 28 · QUESTIONS OPEN 24) then ONE filter row (motion SegmentedControl All motions / White Glove / Self-Service / Assessment Factory · status Select · search, with "7 of 7 teams · sorted by fewest dimensions at target" at its right) then the table; first row at 367px, rows 67px tall; columns Team (name + id · lead) / Motion / Certification (verified-level Chip · n/17 at L3 · claims-open Chip) / Assessed / Step (n/6 · label) / Questions / Next action / Updated; no horizontal scroll (scrollWidth 1692 = innerWidth 1692)
keyboard: pass — 32 tabbable controls and all 32 accept focus (`.focus()` walk): "+ New team", the four motion segments (aria-pressed on the chosen one), the status select, the search box, then each row's team-name button (the row's one Enter-activatable control; the row click stays as a mouse convenience)
empty-state: pass — TEAM-006 "Fraud Detection ML" and TEAM-007 "Internal Tools" render unassessed: certification "Not yet assessed", 0/17, Step "1/6 · Intake", questions "—", next action "Start intake"; searching "zzznoexist" leaves the table body reading "No teams match the current filters." with a "Clear filters" button that restores all 7 rows; the White Glove segment narrows the table to its 2 teams and writes ?cohort=white_glove to the URL, "All motions" clears it
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
Console errors: 0 on both surfaces. Re-audit 2026-09-15 19:53: the desk. Seven rows sorted by fewest dimensions at target — Notifications Service (L1 verified · 0/17 at L3 · 5 claims open → Close 5 claims), Checkout Experience (L2 · Assess 9 more), Fraud Detection ML and Internal Tools (Start intake), Data Platform (L3 · 10/17 · Assess 7 more), Northstar Payments (L4 · 14/15 · 6 claims open · 9 questions → Close 6 claims), Kubernetes Operator (L3 · 17/17 · 17 claims open · 15 questions · 5/6 Publish → Close 17 claims). Role: the only assessment role whose rail carries Configuration — 11 items (Dashboard, Submissions, Reports, Feedback, Enterprise, Workspace, Prompts, Rules, Activity, Configuration, Settings), which is the extra tab stop against the assessor's 31; "+ New team" renders. Signed in as Farah, whose grants are {assessment:[program-lead, lead-assessor]} — the picker lands her as lead-assessor, so the role was switched with POST /api/session/role {role:"program-lead"} and confirmed in the header ("Assessment · program-lead") before measuring. Console errors 0.
