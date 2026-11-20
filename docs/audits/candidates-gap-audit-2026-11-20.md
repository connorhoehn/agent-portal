# Candidates tenant: product gap audit

Read-only audit of `main` at `644c6c3cf`, 20 November 2026. Nothing was run: no servers, tests, journeys or model calls. Every finding was read in the code at the cited line. Cloud and deployment gaps are left out. Paths are from the repository root; `mw/` is `middleware/src/`, `pt/` is `portal/src/`, `plan` is `docs/interviews-tenant-plan.md`.

## Summary

1. The happy path is built and well covered: opening and kit, assign, accept, prepare, invite link, consent, room, pad, scorecard, debrief, decision, record, retention.
2. The loop breaks as soon as something goes wrong: there is no way to cancel a round, record a no-show or mark a candidate withdrawn.
3. The lead's join starts the round, so a candidate who never arrives burns it: it cannot be rescheduled or reassigned, and every seat owes a scorecard.
4. The stage machine has dead ends: nothing follows `offer`, the recruiter cannot move a stage, and an opening with no hiring manager can never be decided.
5. A coding round's Run button is a simulator by default; real execution needs an environment switch that no settings list names.
6. A waiting candidate is announced only inside the lead's open room page, and only the lead can admit them.
7. Interviewers have nowhere to take notes during the call, and the candidate's email is collected but never shown, used or editable.
8. Milo reads speech only: the recap ignores the pad, runs and whiteboard, and the coach and plan ignore the résumé, though the plan promises all of them.
9. "Milo recommends" is computed in the browser, never stored or exported, absent from the debrief, and contradicts the candidate notice.
10. The whiteboard round, the answer key reveal and red flags have unit tests but no judge row and no end-to-end walk.

## Gaps, ranked by impact on a real hiring loop

### 1. No cancel, no-show or withdraw (blocker)
- **Flow:** rescheduling, cancelling, no-shows.
- **Evidence:** `cancelled` and `withdrawn` are in the types (`mw/lib/interviews/types.ts:20,28`) but the store has no write for either (`mw/lib/interviews/store.ts:53-91`) and no route sets them. The lead's join starts the round (`pt/pages/interviews/InterviewRoomPage.tsx:108-114`). Once live, the time is frozen (`mw/lib/interviews/assign.ts:248-258`), seats are frozen (`assign.ts:205-209`) and only the lead can end it (`mw/lib/interviews/room.ts:109-116`, `mw/routes/interviews/room.ts:81-91`). A held round cannot be assigned again (`assign.ts:42,120`). A round still to run blocks Advance (`mw/lib/interviews/debrief/rules.ts:83`). Nothing waives a scorecard (`mw/lib/interviews/scorecard.ts:227`).
- **What a user hits:** the lead opens the room, the candidate never arrives, and the round is spent: End is the only move, all seats then owe a scorecard for an interview that did not happen, and the recruiter cannot run that round again. A round nobody starts sits in Upcoming with a past time forever and blocks Advance. A lead who closes the tab leaves the round "Live now" for good. A panel member who did not attend owes a scorecard forever, so the round never reaches `scored`.
- **Fix:** add a recruiter Cancel and a lead-or-recruiter "did not take place" write that moves the round to `cancelled` with a reason and frees it for reassignment, plus a recruiter write for `withdrawn`. Start the round on the first admit, not on the lead's join, and let the recruiter end a stale live round.

### 2. Stage dead ends, and openings nobody can decide (major)
- **Flow:** debrief and decision.
- **Evidence:** only two things write a stage: the first assignment sets `interviewing` (`mw/routes/interviews/assignments.ts:117`) and the hiring manager's decision sets `offer`, `on-hold` or `rejected` (`debrief/rules.ts:35`). The copy says "What follows is the recruiter's" and "The recruiter moves them" (`rules.ts:73-76`), but the recruiter has no stage route. Only the opening's own hiring manager decides (`mw/routes/interviews/debrief.ts:85`); the recruiter and admin get 403 (`debrief.ts:48-57`). A hiring manager is optional (`mw/lib/interviews/kit.ts:466-468`), and the debrief then just carries `decide: null` (`mw/lib/interviews/debrief/view.ts:138`).
- **What a user hits:** candidates pile up at `offer` with no `hired`; a rejection cannot be reopened; `screening`, `debrief`, `hired` and `withdrawn` appear on the stage tracker but only the seed reaches them. On an opening with no hiring manager the debrief shows no decision control and no reason why.
- **Fix:** give the recruiter a stage write for the moves the copy already assigns them (offer to hired, withdrawn, reopen). Refuse or warn on assigning rounds to an opening with no hiring manager, and say so on the debrief.

### 3. Run is a simulator unless a hidden switch is set (major)
- **Flow:** coding pad round.
- **Evidence:** the executor is the mock unless `INTERVIEWS_RUN_BACKEND=docker` (`mw/lib/interviews/runs/backend.ts:12-24`). The mock "NEVER executes anything" and prints literal values only (`mw/lib/interviews/runs/mock-executor.ts:1-3,156`). The switch is not in the settings list (`mw/lib/interviews/settings.ts`, no match).
- **What a user hits:** on default settings the candidate presses Run and sees scripted output, or "[demo workspace] … is not simulated here". Nothing in the pad says the runner is a stand-in before that.
- **Fix:** outside the mock world default to the Docker runner when Docker answers, label the pad "simulated runner" otherwise, and list the setting.

### 4. A waiting candidate is announced only to an open room page (major)
- **Flow:** join flow, admission.
- **Evidence:** a knock publishes a live hint and nothing else (`mw/routes/interview-invite.ts:182-188`); the listener is mounted only in the room page (`InterviewRoomPage.tsx:221`). Only the lead may admit (`mw/routes/interviews/admission.ts:58-60`). The candidate reads "The interviewer has been told you are here" (`pt/pages/join/WaitingStep.tsx:82`) and the page stops checking after 30 minutes (`pt/pages/join/steps.ts:112`).
- **What a user hits:** the lead is late or on another page; nobody is told; the candidate is assured otherwise. A panel member already in the room sees the knock and cannot let them in.
- **Fix:** ring the lead and panel with a bell on the first knock, let a panel member admit when the lead is absent, and say "told" only once a seat is in the room.

### 5. No notes during the call (major)
- **Flow:** notes, scorecards.
- **Evidence:** the room's pane has the plan, Milo's notes, Ask Milo, the transcript, chat and the pad or board; the only text field is Ask Milo (`InterviewRoomPage.tsx:316-326,456-525`). The scorecard draft lives in the browser only (`pt/lib/interviewsScorecard.ts:6-7`).
- **What a user hits:** interviewers write notes elsewhere. When the candidate declines the transcript there are no Milo notes either, so the scorecard is written from memory. A draft started on one machine is not on another.
- **Fix:** a private per-seat notes field in the room, saved on the server and offered as the scorecard's starting notes; save scorecard drafts server-side.

### 6. The candidate is reached, and reaches back, only outside the product (major)
- **Flow:** inviting the candidate, rescheduling.
- **Evidence:** the email is required at creation (`mw/routes/interviews/candidates.ts:38-40`) but no page reads it (no `candidate.email` under `pt/pages/interviews`), and no route edits a candidate (`store.ts:109` is create only). The link is shown once to copy (`pt/lib/interviewsUpcoming.ts:47-57`). Email and calendar are out of plan (`plan:802`). The candidate's pages name no contact (`pt/pages/JoinPage.tsx:133,212`).
- **What a user hits:** the recruiter cannot see the address they typed, cannot fix a typo in a name, and must paste the link into their own mail. A time change bells the interviewers and tells the candidate nothing. The candidate cannot say "I can't make it".
- **Fix:** show and edit contact details on the profile, offer a copyable invitation message (link, round, time), and add a candidate-side "I can't make this time" that bells the recruiter.

### 7. One role per person at a time (major)
- **Flow:** permissions.
- **Evidence:** only holders of `interviewer` can be seated (`assignments.ts:60`); reach follows the session's single role (`mw/lib/interviews/scope.ts:41-46`, `mw/lib/session.ts:184-199`); the debrief is closed to the interviewer role (`debrief/view.ts:98,126`).
- **What a user hits:** a hiring manager who interviews their own candidates needs a second grant and must switch context to conduct and score, then switch back to decide. A recruiter cannot run a phone screen.
- **Fix:** derive reach from all of the person's grants in the tenant, or let a hiring manager or recruiter hold a seat.

### 8. Milo reads speech only (major, Milo integration)
- **Flow:** coach, recap, scorecard recommendation, whiteboard.
- **Evidence:** the recap leaves out the pad and runs (`mw/lib/interviews/recap/prompt.ts:13`) though decision 6 names code snapshots and run results as sources (`plan:54`). The coach and plan leave out the résumé (`mw/lib/interviews/coach/prompt.ts:19`, `mw/lib/interviews/plan/service.ts:4`) though decision 7 and rows I3.3 and I3.10 promise it (`plan:57,618,625`). The coach reads code only, never the board (`mw/lib/interviews/coach/service.ts:96-97`); Milo's tools cannot touch the board (`mw/lib/interviews/milo-tools/family.ts:22-29`). Expected test values exist for one seeded question id (`mw/lib/interviews/milo-tools/references.ts:35`), and the kit has no field for a reference.
- **What a user hits:** in a coding or design round the recap has evidence only for what was said aloud, so the recommendation rule (needs evidence for half the competencies, `plan:251`) lands on "no recommendation" or "Inconclusive". "Milo, add test cases" gives inputs without expected values on every question a recruiter writes.
- **Fix:** give the recap the final pad snapshot, run results and board text as citable sources; extract résumé text at upload; add a reference solution field to kit questions.

### 9. "Milo recommends" is unrecorded and contradicts the notice (major, Milo integration)
- **Flow:** scorecard, debrief, privacy.
- **Evidence:** the rule runs in the browser and only the scorecard page imports it (`pt/lib/interviewsMiloAdvice.ts:124-174`). The export has no recommendation (`mw/lib/interviews/export/sections.ts`, no match). The only notice version says Milo "does not recommend whether to hire you" (`mw/lib/interviews/consent/notice.ts:27,37`) and that the interview "still goes ahead" after a no (`notice.ts:30`), while a deployment may require a part (`mw/lib/interviews/invite/admission.ts:109-116`; the new version is owed at `plan:167`).
- **What a user hits:** the hiring manager decides on the debrief without the pill; nobody can later show what Milo recommended when a decision was made; a candidate reads a promise the scorecard's heading breaks.
- **Fix:** compute it on the server, store what was shown with each scorecard version, show it on the debrief and in the export, and publish a notice version that matches (or rename the heading).

### 10. A new opening has no spending cap, so Run and Milo refuse mid-interview (major)
- **Flow:** creating a role, coding round.
- **Evidence:** the default cap is none (`pt/lib/interviewsKit.ts:246`); no cap refuses every hold (`mw/lib/interviews/spend.ts:208`, `mw/lib/spend-refusal.ts:67-69`), runs on the free local runner included (`mw/lib/interviews/runs/service.ts:312-313`). The warning is on the opening's page only (`interviewsKit.ts:90`).
- **What a user hits:** the lead learns it when Run is refused in front of the candidate, who gets a generic refusal.
- **Fix:** default a cap at creation, or warn on Assign, Prepare and the idle room.

### 11. Candidate accessibility (major)
- **Flow:** accessibility, join flow.
- **Evidence:** the transcript is panel-side only (`plan:52`); no candidate route reads it, and the candidate's only caption is Milo's line (`pt/pages/join/GuestMiloVoice.tsx:7`). The device check continues with a blocked microphone and tests no connection (`pt/pages/join/DeviceCheckStep.tsx:53`). The door was measured at 1440 and 1280 only (`scripts/journeys/interviews/E3-door.mjs:26`; `plan:678`).
- **What a user hits:** a deaf or hard-of-hearing candidate has no captions; a candidate on a phone is on an unmeasured layout.
- **Fix:** offer the candidate their own live captions when they accepted the transcript; walk the door at phone width and by keyboard.

### Minor
- **One person, two openings, two records.** Adding a candidate always mints a new record (`candidates.ts:77`); the debrief already handles several applications per candidate (`debrief/view.ts:129`) but nothing creates a second one. Fix: match on email and add an application.
- **Unused candidate fields.** `notes` is never written or shown; the profile read sends the whole row, email included, to every reader, an assigned interviewer too (`mw/lib/interviews/views.ts:381`). Fix: send only what the page shows.
- **Red flags stop at the scorecard.** Ticked flags are absent from the debrief and the export (no match in `DebriefPage.tsx`, `debrief/view.ts`, `export/sections.ts`).
- **No debrief discussion.** `discussions` and `huddleChat` are off (`tenants/manifest.json:94-95`); the panel cannot confer in the product.
- **Thin scheduling.** No double-booking check, no "missed" label for a past time, one scorecard-due bell and no reminder (`mw/lib/interviews/result-bells.ts:3`).
- **Settings are invisible.** `interviewsSettings()` has no caller outside tests (`settings.ts:30`), so nobody can read the retention periods or required consents in the product.
- **Kits start empty.** No copy from another opening (`mw/routes/interviews/openings.ts:103`).
- **Paused or closed openings accept candidates.** The server checks only that the opening exists (`candidates.ts:56-62`); rounds then cannot be assigned (`assign.ts:112`).
- **One Milo setting.** `candidateMayAsk`, per interview, lead only (`mw/lib/interviews/milo-settings.ts:5-10`); no opening-level default and no recruiter control.
- **The plan is stale.** It opens with "Nothing here is built" (`plan:3`), and its open list (`plan:787-789`) names pieces that exist (`pt/pages/interviews/room/ProvidedDesignTab.tsx:64-73`, `InterviewRecordPage.tsx:199-206`, `ScorecardPage.tsx:194`, `AnswerKeyEditor.tsx`).

## Promised in docs but not built

- The coach and the Prepare plan reading the résumé (`plan:57,618,625`).
- Recap evidence from code snapshots and run results (`plan:54`).
- Milo tools `pad_set_language`, `run_code`, `next_question` (`plan:276`); Milo's board tools and the coach tracking board frames (`plan:790`).
- A notice version saying a deployment may require a part (`plan:167`).
- The recruiter's stage moves and "schedules what follows" (`plan:65`); the `cancelled` state and the `screening`, `debrief`, `hired`, `withdrawn` stages (`plan:106-107`).
- A star rating input (`plan:259`, queued for the library).
- Dropping `pt/lib/callTileMerge.ts` after a realtime-modules release (`plan:215`); the file is still there.
- Listed open in the plan and not checkable from this repository: the candidate's media join refused by platform-api, and recording decided once at call creation (`plan:217-218`). `mw/lib/interviews/recording-push.ts` looks like this repository's half of the second.

## Built but untested

- **The whiteboard round end to end** (draw, checkpoints, record playback): no ledger row or judge piece; the board appears only in layout walks (`C2-callpane.mjs`, `C3-callfloat.mjs`). Unit and socket tests exist.
- **Reveal the provided design, red flags seen, the clarifying-question nudge:** no journey mentions any of them.
- **Milo's tools (I3.11):** a walk file and a judge row exist, but `scripts/validate-interviews.d/` has no `I3.11.sh`.
- **`POST /interviews/:id/milo-intro`:** no test names the route.
- **Recording when consent arrives after the call starts** (`recording-push.ts`): the real-recording walk (`I5.1-recording.mjs`) runs only against a media stack.
- **The call chat unread, call pane and call float walks** (`C1` to `C3`): files exist, not rows in the judge's table.
- **The live model paths** for the coach, recap, plan and private answers: scripted in the mock world (`mw/lib/interviews/coach/model.ts:239`), so quality and failure handling on a real model are unseen (`plan:674`).
- **The candidate door on a phone, by keyboard or with a screen reader.**
