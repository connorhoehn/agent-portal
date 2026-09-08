surface: team-scorecard
role: program-lead
user: u-farah
url: /assessment/teams/TEAM-001?tab=certification
pages: portal/src/pages/assessment/DashboardPage.tsx,portal/src/pages/assessment/dashboard/TeamScorecard.tsx,portal/src/pages/assessment/dashboard/DimensionMasterDetail.tsx,portal/src/pages/assessment/dashboard/DimensionRow.tsx,portal/src/pages/assessment/dashboard/DimensionDetailHeader.tsx,portal/src/pages/assessment/dashboard/LevelBadge.tsx,portal/src/pages/assessment/dashboard/EvidenceIntake.tsx,portal/src/pages/assessment/dashboard/ExceptionsModal.tsx,portal/src/pages/assessment/dashboard/ImprovementPlan.tsx,portal/src/pages/assessment/dashboard/ScoringLogsDrawer.tsx,portal/src/pages/assessment/dashboard/StoriesPanel.tsx,portal/src/pages/assessment/dashboard/TeamActionsMenu.tsx
audited: 2026-09-07 00:38 local, Chrome 1560x857, middleware dev:mock on 127.0.0.1:3011 behind the Vite proxy — re-audit after the ExceptionsModal close-button change
screenshot: team-scorecard.jpg
verdict: pass
console errors: 0 — cleared before the surface, re-read after opening and closing the exceptions dialog by both routes, after selecting a dimension, and after loading TEAM-999.
layout: pass — content col left 224px w 1312px; no horizontal scroll (scrollWidth 1560 = innerWidth 1560). Master-detail fills the content width: the dimension rail measures 339px starting at x=225 and the detail takes the remainder of the 1312px column. The selected row carries both `aria-selected="true"` and `aria-current="true"`; the active tab carries `aria-selected="true"`; the workflow strip marks its current step with `aria-current="step"` on "Review". The exceptions dialog is 960px and its five columns — DIMENSION, SOURCE, REASON, STATUS, ACTIONS — fit inside it with no clipping.
keyboard: pass — 34 visible, enabled interactive controls in `<main>` on the Certification tab (re-counted 2026-09-08; was recorded as 26, see the freshness re-observation at the foot of this log); a document-order `.focus()` sweep reached all 34, 0 unreachable. Focusing a dimension row and clicking it moved the detail (row 09 → "DIMENSION 09 / Engineering Governance / VERIFIED / L4 / Verified at Level 4") and moved `aria-selected="true"` with it; the five tabs each activated and swapped the panel. **The exceptions dialog closes from both routes and hands focus back.** With the "Exceptions" trigger focused as a real user leaves it, opening the dialog moves focus to its "Close" button; clicking Close removes the dialog and `document.activeElement` is the trigger again; reopening and dispatching Escape does the same (`focusBackAfterClose: true`, `focusBackAfterEscape: true`, both read after two painted frames). Harness workarounds and the quirks they answer: Escape was dispatched as `keydown` (pages handle it explicitly), activation used a real `.click()` on the already-focused element because a synthetic Enter does not activate a button here, the tab order was walked with a document-order `.focus()` sweep, and every focus read followed two screenshots.
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
Console errors: 0 on both surfaces.
