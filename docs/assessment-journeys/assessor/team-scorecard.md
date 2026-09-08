surface: team-scorecard
role: assessor
user: u-asha
url: /assessment/teams/TEAM-001?tab=certification
pages: portal/src/pages/assessment/DashboardPage.tsx,portal/src/pages/assessment/dashboard/TeamScorecard.tsx,portal/src/pages/assessment/dashboard/DimensionMasterDetail.tsx,portal/src/pages/assessment/dashboard/DimensionRow.tsx,portal/src/pages/assessment/dashboard/DimensionDetailHeader.tsx,portal/src/pages/assessment/dashboard/LevelBadge.tsx,portal/src/pages/assessment/dashboard/EvidenceIntake.tsx,portal/src/pages/assessment/dashboard/ExceptionsModal.tsx,portal/src/pages/assessment/dashboard/ImprovementPlan.tsx,portal/src/pages/assessment/dashboard/ScoringLogsDrawer.tsx,portal/src/pages/assessment/dashboard/StoriesPanel.tsx,portal/src/pages/assessment/dashboard/TeamActionsMenu.tsx
audited: 2026-09-07 00:08 local, Chrome 1560x857, middleware dev:mock on 127.0.0.1:3011 behind the Vite proxy — re-audit after the ExceptionsModal close-button change
screenshot: team-scorecard.jpg
verdict: pass
console errors: 0 — cleared before the surface, re-read after all five tabs, after selecting a dimension, after opening and closing the exceptions dialog by both routes, and after loading TEAM-999.
layout: pass — content col left 224px w 1312px; no horizontal scroll (scrollWidth 1560 = innerWidth 1560). Master-detail fills the content width: the dimension rail measures 339px wide starting at x=225 and the detail takes the remainder to the right edge of the 1312px column. The selected row is marked twice over — `aria-selected="true"` and `aria-current="true"` on the row div, with the unselected rows carrying the explicit `"false"` counterparts — so both the ARIA listbox reading and the "current" reading are available to a screen reader. The active tab carries `aria-selected="true"`; the workflow strip's current step carries `aria-current="step"` on "Review".
keyboard: pass — 34 visible, enabled interactive controls in `<main>` on the Certification tab (re-counted 2026-09-08; was recorded as 26, see the freshness re-observation at the foot of this log); a document-order `.focus()` sweep reached all 34, 0 unreachable. Activation works on the real controls: focusing a dimension row and clicking it moved the detail to that dimension (row 03 "Automation" → "DIMENSION 03 / Automation / Verified at Level 3 — matches the team's own rating") and moved `aria-selected="true"` with it; each of the five tabs activated and swapped the panel. **The exceptions dialog now closes from the keyboard and the mouse, and hands focus back.** With the "Exceptions" trigger focused as a real user leaves it, opening the dialog moves focus to its "Close" button; clicking Close dismisses it and focus returns to the "Exceptions" trigger (verified `document.activeElement === ` the trigger, read after two painted frames). A dispatched Escape does the same. Harness workarounds and the quirks they answer: Escape was dispatched as `keydown` (pages handle it explicitly, so this is a genuine test) while activation used a real `.click()` on the already-focused element, because a synthetic Enter does not activate a button or anchor here; the tab order was walked with a document-order `.focus()` sweep; every `document.activeElement` read was taken after two screenshots, because the modal's focus hand-back is scheduled on a frame. One thing worth recording: an early attempt read focus as `BODY` after Close — that was the harness, not the page. A JS `.click()` on the trigger does not focus it the way a mouse click does, so the modal had captured `BODY` as the element to restore. Focusing the trigger first, as any real user's click or Tab would, gives the correct hand-back.
empty-state: pass — `/assessment/teams/TEAM-999` renders "No team TEAM-999 / There is no team with this id. It may have been deleted, or the link is out of date." with a "Back to the dashboard" control, 0 console errors. The Documents tab is a deliberate empty state that redirects rather than dead-ends: "Documents live in Workspace — This team's documents are in the Informatics › Workspace explorer, alongside the shared enterprise context."
role-gating: capabilities for this role are ViewAssessment, ScoreAssessment, ManageSubmissions, RunAssessmentAgent, LabelFeedback true; ApproveException, PublishReport, ManageAssessmentConfig, ManageKnowledge false. Matching that, the exceptions dialog renders the two exception rows read-only for this role — a DOM sweep of the dialog returns exactly one control, "Close", with no Approve and no Deny — while the page keeps "Exceptions", "How it was assessed", "Report", "+ Add evidence" and the ⋯ menu. Configuration is absent from the rail and from the command palette.
notes: The dialog is the fix that matters here and it landed properly: a reader with no decision to make now has a labelled button to aim at instead of having to guess that the overlay is clickable, and it is the app's own `ConfirmDialog` convention rather than a bolted-on ✕. The rest of the surface reads well — the certification headline ("Verified to Level 3 on 14 of 15 dimensions · Claims above verification on 6 dimensions — evidence requested") tells you the whole story before you touch a tab, and the "Basis: self-attested. That means it rests on what the team told us, and nothing more." line under a dimension is the single most useful sentence on the page. Two nits a person would raise: the dimension rail truncates most titles mid-word at 339px ("Source Control & Traceabil…", "Testing & QE – Performance …") so the rail reads as a list of prefixes, and the certification tile's supporting line is itself clipped ("Claims a…") while there is free width to its right.

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
Vite proxy), signed in through /select as Asha Nair (u-asha, assessor):
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
