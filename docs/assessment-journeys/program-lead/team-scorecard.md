surface: team-scorecard
role: program-lead
user: u-farah
url: /assessment/teams/TEAM-001?tab=certification
pages: portal/src/pages/assessment/DashboardPage.tsx,portal/src/pages/assessment/dashboard/TeamScorecard.tsx,portal/src/pages/assessment/dashboard/DimensionMasterDetail.tsx,portal/src/pages/assessment/dashboard/DimensionRow.tsx,portal/src/pages/assessment/dashboard/DimensionDetailHeader.tsx,portal/src/pages/assessment/dashboard/EvidenceCoverage.tsx,portal/src/pages/assessment/dimensionStandards.ts,portal/src/pages/assessment/dashboard/LevelBadge.tsx,portal/src/pages/assessment/dashboard/EvidenceIntake.tsx,portal/src/pages/assessment/dashboard/ExceptionsModal.tsx,portal/src/pages/assessment/dashboard/ImprovementPlan.tsx,portal/src/pages/assessment/dashboard/ScoringLogsDrawer.tsx,portal/src/pages/assessment/dashboard/StoriesPanel.tsx,portal/src/pages/assessment/dashboard/TeamActionsMenu.tsx
audited: 2026-09-15 21:05 local, Chrome window (innerWidth 1692, innerHeight 858), middleware dev:mock (re-audit after docs/assessment-ux-goal.md slices 4 and 5: two-track rail rows with a confidence meter, the evidence coverage strip, repos in the header, and the "Measured against" enterprise standard line in the dimension pane; signed in as u-farah via POST /api/session/login + /role, opened TEAM-001; every field re-observed)
screenshot: team-scorecard.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px; no horizontal scroll (scrollWidth 1692 = innerWidth 1692). Header → meta line (Lead · Repos as GitLab links · Contacts) → StatStrip → tabs → stepper → EVIDENCE COVERAGE strip (legend + 17 numbered chips toned by class) → master-detail; the dimension rail starts at 482.5px, rows 50px tall (title line + `role="meter"` confidence line), each row carrying data-verified / data-claimed with a warning "↑n" chip where the claim is above the verified level; the pane header keeps the eyebrow + basis + badge and the certification statement is followed by the "Measured against <standard> · <clause>" line (or "No enterprise standard on file" with a link to the standards folder)
keyboard: pass — 37 visible, enabled controls in <main> on the Certification tab and all 37 accept focus (document-order `.focus()` walk): the breadcrumb, the header actions, the repo link(s), the five scorecard tabs, the rail collapse chevron, the 17 `role="option"` rows, the "Measured against" link and the five pane tabs; the 17-row dimension rail is a listbox with row 01 Continuous Integration (CI) selected on load
empty-state: pass — `/assessment/teams/TEAM-999` renders "No team TEAM-999 / There is no team with this id. It may have been deleted, or the link is out of date." with a "Back to the dashboard" button, 0 console errors. This pass also caught the more interesting one by accident of timing: both of TEAM-001's N/A exceptions were already decided by the time this role opened the dialog, so the ACTIONS column was empty and the dialog held **exactly one control, "Close"** — which is precisely the state that used to leave a reader with nothing to click. The fix is doing its job in the case that motivated it.
role-gating: capabilities are the full assessment set — ViewAssessment, ScoreAssessment, ApproveException, PublishReport, ManageSubmissions, RunAssessmentAgent, ManageKnowledge, ManageAssessmentConfig — plus ManageUsers. On this page that reads as the same header actions the other roles get ("Exceptions", "How it was assessed", "Report", "+ Add evidence", ⋯) with an ACTIONS column in the exceptions dialog that would carry Approve/Deny on any still-`requested` row. The role's distinguishing capability shows up in the shell rail rather than on the scorecard: SYSTEM lists Activity, **Configuration** and Settings for this role and only Activity/Settings for the others.
notes: The dialog fix reads correctly for the all-decided case: two approved rows, an empty ACTIONS column, and a single labelled way out. The certification headline ("Verified to Level 3 on 14 of 15 dimensions · Claims above verification on 6 dimensions — evidence requested") tells the whole story before you touch a tab. Two nits, unchanged across roles: the dimension rail truncates most titles mid-word at 339px ("Source Control & Traceabil…", "Testing & QE – Performance …"), and the certification tile's supporting line is clipped to "Claims a…" while there is free width beside it.

--- freshness re-observation, 2026-09-08 (the Lead cell) ---
Why: `portal/src/pages/assessment/dashboard/TeamScorecard.tsx` changed, which moved this
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
  - the team header now renders `Lead: Priya Natarajan` as text, with **0**
    focusable controls inside it.
  - `/assessment/teams?cohort=all` (TeamList, the other reader of the deleted
    field): the Lead column is plain text, **0** focusable controls per cell.
  - CORRECTION TO THE `keyboard:` LINE ABOVE, and it is not caused by this
    change. The sweep now finds **34** visible, enabled controls in `<main>` on
    the Certification tab, not 26, and a document-order `.focus()` sweep reaches
    all 34 (0 unreachable), so the surface still passes its keyboard criterion.
    The 34 itemise as: the "Dashboard" breadcrumb link (1), the header actions
    Exceptions / How it was assessed / Report / + Add evidence / the overflow
    menu (5), the five outer tabs (5), the dimension-rail collapse chevron (1),
    the seventeen `role="option"` dimension rows (17), and the five inner tabs of
    the dimension detail — Progress & follow-ups / How it was assessed / Evidence
    / Definition & rubric / History (5). Deleting a wire field can only remove
    controls, never add eight, so the earlier 26 was taken against a different
    control set; which eight that sweep excluded is for a real re-audit of this
    surface to settle, not for a freshness note. Recorded here rather than left
    to be re-discovered.
The em dash matters and was preserved deliberately: `assessment_lead` is the
empty string on TEAM-006 and TEAM-007, and `PersonRef`'s "no name" branch used to
render "—" for them. A bare data key would have left those cells blank, which
reads as a rendering fault rather than as "nobody yet", so the column keeps the
em dash the rest of this table uses for an empty. Verified: the seven Lead cells
read Dana Whitfield, Sam Okafor, —, —, Elena Marsh, Priya Natarajan, Jordan Lee,
and each one contains 0 focusable controls.
Console errors: 0 on both surfaces. Re-audit 2026-09-15 19:53: unchanged on screen — TEAM-002 Kubernetes Operator, header strip (Certification L3 · Assessed 17/17 · Open follow-ups 15 · Workflow step Publish), the six-step stepper, the 17-dimension rail and the CI pane ("Claimed Level 5 · Verified up to Level 3"); breadcrumb "Assess › Dashboard › TEAM-002"; the desk is now the page this one is opened from. Role switched to program-lead via POST /api/session/role after the picker landed her as lead-assessor; the Configuration rail row is the one extra tab stop. Console errors 0. Re-audit 2026-09-15 21:05 (slices 4 + 5): TEAM-001 Northstar Payments as Farah Osei (program-lead): 6 of 17 rail rows carry a claim chip (01 ↑5 on L2, 02/05/11/14/17 ↑4 on L3); dimension 09 Engineering Governance is the one three-dot "high" row; 06 and 07 read N/A with no meter; coverage strip "Attested 1 · Documented 13 · Observed 1 · N/A 2" with 09 solid green; header meta lists both repos (northstar-payments-api, northstar-payments-infra) as GitLab links and two contacts; the same five header actions as before plus the ⋯ menu; "Measured against CI/CD Standards" on the CI pane. Console errors 0. Addendum 2026-09-15 21:20: after this observation DimensionRow.tsx changed once more — a pending dimension (no level on either track) no longer shows a confidence meter, only its badge; on the team observed above every dimension carries a level, so the rows read exactly as recorded; re-checked on TEAM-003 as admin where rows 09–17 now show no meter. Console errors 0. Re-audit 2026-09-16 00:12: the dimension pane header now shows both tracks like the rail row that opens it — verified-level badge plus the amber "↑n" claim chip (Dimension 01 · Continuous Integration (CI) · self-attested · ↑5 · L2 on TEAM-001) — composed from Inline/Stack/SectionLabel with no raw wrappers; the Improvement Plan's "What this involves" reveals are library CollapsibleSections (four on TEAM-001, the first badged with its story count) instead of a ghost button + hand-built reveal; Evidence & Intake's cards carry CardHeader titles and a third intake path, "Point at a repo", lists the team's repos (northstar-payments-api, northstar-payments-infra) as chips with a Use button that fills the repo URL; Stories' state sentence is its card's CardHeader title; the scoring-logs drawer's two titles are CardHeaders. Re-observed as Asha Nair; none of these are capability-gated, so the other roles see the same. Console errors 0. Re-audit 2026-09-16 09:10: the dimension pane's title is an h2 under the page's h1 (it was an h3 with no h2 anywhere, a skipped level for heading navigation); nothing else on the pane moved. Console errors 0. Re-audit 2026-09-16 04:02: Dashboard read moved onto useFetch with error/degraded branches; the scorecard itself is unchanged. Code-verified (tsc, 542 middleware tests, 570 portal tests). Console errors 0. Re-audit 2026-09-16 05:40: Plan/Stories/Evidence panes mount on first visit and stay mounted (visited set), so tab state still persists but a team open costs the certification reads only. Measured as u-asha: first Plan visit +1 request (recommendations), revisit +0, first Stories +1. Console errors 0.
