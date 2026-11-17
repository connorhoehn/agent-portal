# Plan: the `interviews` tenant

Status: a plan, written 16 November 2026 and audited the same day against the code (the audit's corrections are folded in; see "Audit" at the end). Nothing here is built. The ledger at the end is the list of work; each row says how it will be judged. The first row builds the judge, `scripts/validate-interviews.sh`, and from then on that script is the only judge, as `validate-learning-loop.sh` is for the learning loop.

## What this is

A sixth tenant, shown as "Interviews", for running job interviews end to end.

1. A recruiter creates an opening, adds a candidate and assigns an interview round to an interviewer.
2. The interviewer accepts, prepares from the candidate's résumé and the opening's question kit, and conducts the interview in a call.
3. The candidate, who has no account, joins through a candidate portal from an invite link.
4. Milo is in the call. It transcribes, suggests follow-up questions to the interviewer in the footer prompt, and asks one aloud only when the interviewer approves it.
5. A technical round has a shared code pad that both people type in, with a Run button backed by an execution queue (mocked first).
6. Afterwards the interviewer fills a scorecard, reviews Milo's evidence recap, and submits a personal go or no-go.
7. The recruiter and the hiring manager see the submissions, the recording and each round's result, and the hiring manager decides the candidate's next stage.

Two interview types share the same flow: technical (the focus) and behavioural (no code pad).

## What exists and what does not

Read from the code on 16 November 2026.

| Need | Today |
|---|---|
| A tenant | Declared in `tenants/manifest.json`; `scripts/gen-tenants.mjs` generates most of the registration. The newest tenant, `access`, is the template (about 80 files). |
| Calls, pre-join, ringing | Built. Lobbies are named `<tenant>:<family>:<id>`; every seat needs a signed-in session with a grant in the tenant. |
| Someone without an account in a call | Does not exist. No guest link, invite token or public page. |
| Recording and playback with a synced transcript | Built (the media stack decides whether a call records; `RecordingPlayer` with `TranscriptPanel`). Readable by every participant. |
| Milo | Built, but tied to the `orgiq` tenant and to initiative lobbies: who may invite, who may read the record, who pays and which tools it may call all assume employees. |
| Milo raising something for a person to confirm | Built (proposals, the decision watcher on Bedrock, the footer prompt deck). |
| Milo saying a sentence the server chose | In chat: built. Aloud: not possible today; the live session takes no text and the voice gate has no reason for it. |
| A collaborative code editor | Does not exist. `CodeEditor` in the library is a textarea. The collaboration stack under the documents feature (Yjs over the gateway, awareness, snapshots) is built and can carry one. |
| Paste detection, edit playback | Do not exist. |
| Running code | `POST /api/capabilities/code-interpreter/execute` runs Python on AgentCore Code Interpreter, synchronously, with no queue and no streaming. Nothing runs Swift. The mock counts `print(` calls. |
| Live job output to the browser | Built (server-sent events, `lib/sse.ts`). |
| Scorecards | Pieces exist: the assessment tenant's rubric levels and evidence shapes, the library's `VerdictPanel`, `SignoffPanel`, `CompareDeltaTable`. No rating input. |
| Tables, detail pages, drawers, stage trackers | Built (`CollectionPage`, `DetailPage`, `DataTable`, `WorkflowStepper`). |
| Résumé upload | Upload links accept PDFs. There is no PDF viewer. |
| Scheduling | Does not exist: no date picker, no calendar, no "upcoming" list. |
| Assign and accept | The bell and "My work" exist; the access tenant's request and approve flow is the closest pattern. |
| Shared editing in the mock world | Not available. Shared documents ride a separate socket to the real gateway, which only the social profile runs; the plain mock world, where the journeys walk, has none. |
| Recordings in the mock world | Not available. Recordings come from the media stack. |
| Packages | None of what the new pieces need is installed: an editor (CodeMirror with its Yjs binding), a PDF renderer, a speech client. Installs are not done in unattended runs here, so each is a step the owner runs or allows. |

## Decisions

Each is made here so the work can start. The ones marked "owner" are the ones most worth overruling; the default stands until then.

1. **Tenant.** Id `interviews`, label "Interviews", API under `/api/interviews`, portal under `/interviews`, one server flag `INTERVIEWS_ENABLED`, off by default.
2. **Roles.** Role ids are global, and `hr-admin` belongs to Work, so: `recruiter` (owns openings, candidates, assignment and scheduling; sees everything in the tenant), `interviewer` (sees only the interviews assigned to them), `hiring-manager` (sees their own openings: candidates, rounds, recordings, results; decides the stage). The cross-tenant `admin` passes as elsewhere.
3. **The candidate is not a user.** An interview has an invite link carrying a signed token for that one interview, which expires. It mints a guest identity with no grants in any tenant. A guest can reach exactly five things: the candidate portal pages for that interview, the interview's call, its call chat, its code pad, and its runs (starting one and reading its output). Everything else is refused by default, and the tests start from a guest and try the rest. The token is exchanged for a session cookie on first load and removed from the address, and the interviewer admits the guest from a waiting room. The product does not verify who the candidate is.
4. **Two sides of one record.** The panel side is the recruiter, the assigned interviewers and the opening's hiring manager. The candidate side is the candidate. The transcript, Milo's suggestions, notes, scorecards, the recap and the recording are panel-side only. This replaces the meeting assistant's rule that everyone who held a seat reads the record, for this tenant only.
5. **Consent comes first and is separate.** Before the candidate can join, the portal shows a versioned notice and asks three things separately: recording, transcription, and Milo's assistance. Milo's assistance needs transcription, so declining transcription declines both; the portal says so. Each answer is stored with its time and the notice version. Declining is allowed: the interview runs without that part (no Milo, or no recording), the interviewer is told only what is off, the recruiter is told so they can arrange what replaces it, and the choice appears nowhere on a scorecard or a debrief. Nothing of the candidate is recorded or transcribed before consent. Panel members are recorded too and see the same notice once, when they accept an assignment.
6. **Milo is a listener and an adviser. It never scores.** Milo gathers evidence with a source on every claim (a transcript moment, a code snapshot, a run result). It never rates, ranks or recommends go or no-go, and it never infers anything from a face, a voice or a tone: transcript and code only. The person decides, and the record shows it.
7. **Two engines behind one Milo.** The live session stays what it is today, the listener that produces the attributed transcript. A second, text-only "coach" on Bedrock (Amazon Nova) reads the transcript, the opening's kit, the résumé and the current pad, and produces suggestions, private answers to the interviewer and the recap. New model work is AWS-native; the coach has a scripted stand-in in the mock world, chosen the way `session-select.ts` chooses. The cost of this choice: the live session is a speech-to-speech model, about $3 an hour by the meeting assistant's own design figures, used here only to listen. That is accepted for the first version because the attributed transcript already works on it; row I3.9 prices an interview end to end and designs a listener on Amazon Transcribe behind the same session interface, which would be cheaper and AWS-native. (owner)
8. **Suggestions go to the interviewer only, in the footer prompt.** One at a time, tied to a competency from the kit, at most one every 90 seconds, never while one is waiting. Three answers: "I'll ask it" (marked as used), "Have Milo ask" (decision 9), "Skip". Every suggestion, whether it was shown, and the answer are written to an append-only log with the model id and prompt version.
9. **Milo speaks only approved words.** In an interview nothing the live model says is relayed. What Milo says aloud is text the server already holds: a question the interviewer approved, or a repeat of it. The text is synthesised (Amazon Polly) and sent over the existing voice relay under a new gate reason, `approved`; the same words are posted in the call chat and logged before they are spoken. So Milo cannot say anything to the candidate that the interviewer did not approve. (owner: a second voice provider beside the live model; the alternative is the existing provider's speech synthesis, which keeps one voice and is not AWS-native.)
10. **What the candidate may ask Milo.** Two fixed requests, each answered with text the server holds, never by a model: "Milo, repeat the question" (the last approved question again) and "Milo, how much time is left" (from the clock). Anything else from the candidate gets one fixed sentence saying what Milo can do for them. Nothing about the problem, no internal data, no tools. (owner: or nothing at all.)
11. **The code pad.** A new library component, a CodeMirror 6 editor bound to a shared text over the existing Yjs gateway provider, with remote carets and language modes (Python, Swift, JavaScript, TypeScript, Java, Go, C++). The interviewer can insert a question's prompt and starter code from the kit, and "Have Milo ask" on a coding question does the same insert as Milo asks it. Library first, then the portal. The editor and its Yjs binding are new packages (see "What exists").
12. **Pastes and edits are events, not accusations.** The pad records each paste (who, when, how many characters) and keeps a timed log of edits per person. The record page plays the code back beside the recording and shows pastes as plain markers. The product does not claim to detect outside help.
13. **One run interface, a mock behind it first.** Run requests go to a queue and their output streams back to both people. The mock executor returns scripted, realistic results. Real backends come later behind the same interface: AgentCore Code Interpreter for Python, JavaScript and TypeScript; a container runner with no network for Swift, Java, Go and C++. The shape is below.
14. **Rate first, then the recap.** After the call the interviewer rates each competency from their own judgement, then opens Milo's evidence recap, may ask the coach where something was said, and then finalises the go or no-go and submits. The record keeps whether a rating changed after the recap. A submitted scorecard cannot be edited; a correction is a new version with a reason. An interviewer cannot see another interviewer's scorecard for the same candidate until their own is in. (owner: this ordering limits anchoring on Milo's summary; the alternative is the recap first.)
15. **Review.** The recruiter sees submissions as they arrive. A debrief page shows a candidate's rounds side by side: scorecards, recap, recording. The hiring manager decides the stage (advance, hold, reject) with a reason; the recruiter schedules what follows.
16. **Scheduling is a time, not a calendar.** The recruiter sets a date and time on the interview; "Upcoming" is a table sorted by it. No availability, no calendar integration, no email in this plan. The interviewer's "you confirm it" is Accept or Decline (with a reason) on the assignment.
17. **Retention.** Media (recording, transcript, code log) 90 days by default; decision records (scorecards, consents, the log of what Milo showed) four years by default; both set per deployment. A candidate's deletion request removes their media within 30 days and leaves a deletion log; the decision records stay for their period, with the candidate's contact details removed. (owner: the defaults.)
18. **Money.** A new spend source, `interviews`. Milo's listening, the coach's calls, speech and runs are held against the opening, with a cap per interview. How an opening carries a budget is settled in the first phase (row I0.6).
19. **Mock first, with two known limits.** Every behaviour walks headlessly with the scripted session, the scripted coach and the mock executor before anything touches a provider. Two things do not exist in the plain mock world today: shared editing and recordings. Row I0.7 decides how the pad is carried and walked (over the middleware's own gateway, or a walk that starts a local gateway); the record page is walked on a seeded recording stand-in, and a real recording is checked by hand on the social profile.
20. **Panels.** One lead interviewer, and up to two more panel members assigned to the same round who may join the call. Only the lead gets Milo's prompts. Each panel member submits their own scorecard.
21. **The room is a call first, with one side pane (owner, 16 November).** The interview room fills the window: the library's call layout (the hangout grid of video tiles, the way initiative huddles look) takes the space, and one pane sits on the far right. In a behavioural round that pane is Milo's context for the panel (the plan, the kit's competencies, Milo's notes). In a technical round it is the code pad, with the run output under it. It is built from the tenant layouts that exist, not a new frame: the portal shell (`AppShell`, the section rail collapsed while the call is live), the library's call composites that initiative huddles and meeting rooms already use for the tiles and controls, and the shell's right column (`SidePane`) for the pane. The call's controls and Milo's prompts live in the shell footer on the same model as a work call (`SocialFooter`: the library's `HuddleBar` and `MeetingToolbar`, Milo's bar controls and the footer prompt deck), with the interview's own elements in it (time left, End interview, the suggestion and its three answers) rather than a separate toolbar on the page. A primitive the room needs that the library lacks is added to the library first. The candidate sees the same layout without Milo's context: video, and the pad in a technical round. Milo's prompts stay in the footer (decision 8).

### Safeguards the product has

These are features, each with a ledger row, not background reading.

- Consent before joining, asked separately for recording, transcription and Milo, stored with its time and the notice version (I2.3, I6.1).
- An interview can run without Milo or without recording when the candidate declines (I2.5).
- Milo shows evidence with a source on every claim and never rates or recommends (I5.2).
- Nothing is inferred from a face, a voice or a tone: transcript and code only (I3.3, I5.2).
- Milo says aloud only words the interviewer approved (I3.5).
- A log of everything Milo suggested, showed and said, with an export (I3.3, I6.2).
- Retention periods and deletion on request, with a deletion log (I6.3).

## The run interface

A run belongs to one interview. Both people see it.

Request: `{ runId, interviewId, language, files: [{ path, content }], entrypoint, stdin?, limits: { wallMs, memoryMb, maxOutputBytes } }`. `runId` is chosen by the caller and makes the request safe to repeat. The network is always off.

Status: `queued → compiling → running → succeeded | failed | compile_error | timed_out | memory_exceeded | cancelled | internal_error`.

Events, over server-sent events: `{ runId, seq, stream: 'stdout' | 'stderr' | 'status', data, at }`.

Result: `{ status, exitCode, compileOutput, stdout, stderr, truncated: { stdout, stderr }, timeMs, peakMemoryMb, backend, runtimeVersion }`. Output past `maxOutputBytes` is cut and flagged; the run goes on. One result per `runId`.

Defaults: 10 seconds, 256 MB, 64 KB of output, one run at a time per interview, 60 runs per interview. One pinned version per language, written on every result.

## The model

| Record | Holds |
|---|---|
| Opening | title, level, hiring manager, state, the kit: rounds (type, length), competencies with rubric anchors, question bank (prompt, competency, starter code per language), budget cap |
| Candidate | name, contact, résumé file, source, notes; never a user |
| Application | candidate and opening, current stage, history of stage decisions |
| Interview | application, round, type, lead and panel, time, state (`assigned → accepted → ready → live → ended → scored → reviewed`, or `declined`, `cancelled`; `ready` is accepted with a time set and questions chosen; `scored` is every panel member's scorecard submitted), chosen questions, invite token hash, call id |
| Consent | interview, notice version, three answers with times |
| Scorecard | interview, interviewer, ratings and notes per competency, recommendation (strong no, no, yes, strong yes), versions, whether ratings changed after the recap |
| Recap | interview, evidence per competency with sources, what was not covered; no score |
| Suggestion log | append-only: text, competency, shown, answer, spoken, model id, prompt version |
| Pad log | timed edits per person, pastes, snapshots |
| Run | request, status, result |
| Deletion log | what was removed, when, on whose request |

## Pages

Templates from the library: `CollectionPage` for lists, `DetailPage` for records, `MasterDetailPage` where a list and a record sit together.

| Who | Page | Shows |
|---|---|---|
| Recruiter | Candidates | table: name, opening, stage, next interview, last result |
| Recruiter | Upcoming | table by time: candidate, round, interviewer, state, consent |
| Recruiter | Openings, and one opening | the kit editor: rounds, competencies, questions |
| Recruiter, hiring manager | Candidate profile | header with the stage tracker; rounds list (interviewer, type, date, result, links); résumé; recordings; activity (consents, deletions) |
| Recruiter, hiring manager | Debrief | a candidate's rounds side by side; the stage decision |
| Interviewer | My interviews | to accept, to prepare, upcoming, scorecards due |
| Interviewer | Prepare | résumé, opening, kit; pick questions; Milo's suggested plan (advisory) |
| Interviewer, panel | Interview room | call, code pad, run output, plan pane, Milo's prompts in the footer |
| Interviewer | Scorecard | rate, then the recap, then go or no-go |
| Panel side | Interview record | recording, transcript, code playback, markers (questions, runs, pastes) |
| Hiring manager | My openings | candidates by stage |
| Candidate | Portal, outside the shell | invite landing, notice and three consents, device check, waiting room, interview room (video, chat, pad), ended page with how to ask for deletion |

## Cast (decided here)

Four seed users with a grant only in `interviews`, so isolation walks start from someone with nothing else. Ids collide with none of the existing seed users. Candidates are fictional and are records, not users.

| id | name | role |
|---|---|---|
| `u-greta` | Greta Lindqvist | `recruiter` |
| `u-hugo` | Hugo Marchetti | `interviewer` |
| `u-wen` | Wen Zhao | `interviewer` |
| `u-amara` | Amara Okafor | `hiring-manager` |

Seed content, one coherent story: three openings (a backend engineer, an iOS engineer, an engineering manager), about twelve candidates spread over the stages, six upcoming interviews, and four finished ones with scorecards, a recording stand-in, a transcript and a code log, so every table and page has real-looking rows on first load.

## Built so far

**16 November: phase 0 and the first page.** I0.1 to I0.5 are built, judged by `bash scripts/validate-interviews.sh --phase I0` and the walk `npm run journey:interviews` (in `portal/`). I1.1 (Candidates) is built, along with read-only versions of My interviews and My openings so each role lands on a real home; assigning, accepting and the bell (the rest of I1.4) are not. I0.6 and I0.7 are not started.

- The tenant is on in the mock world and off elsewhere unless `INTERVIEWS_ENABLED` is set; when it is off, `/api/interviews` answers 404. A record outside the viewer's scope also answers 404, so a URL cannot confirm that a record exists.
- No interviews role can use the voice navigator yet. The channel partition refuses everything until the call phases add channel families. The palette has no record search for the tenant.
- The seed story has 11 interviews rather than 10: one finished round has its scorecard still due, so that state can be seen. The iOS opening has no hiring manager, so Amara Okafor does not see it.
- The cast shows initials until portraits are made; their ids are listed as waiting for portraits.

**16 November, round 1 (six lanes in parallel).**

**16 November, round 2 (five lanes, prototype mode).** Built functionally, with type checks and unit tests only; the walks, judge rows and edge-case tests are owed to a later hardening pass. I1.4: a recruiter assigns a round (a lead and up to two panel members), each seat accepts or declines with a reason, and the recruiter reassigns before the call; declines are kept and shown only to the recruiter and the hiring manager; bells name the opening and the round, never the candidate. I1.5: a round's time is set or changed on the Upcoming page with the library's date-and-time field, and the seated hear of it. I0.6: the `interviews` spend source; the opening's cap covers the whole opening and a per-interview cap (default `INTERVIEWS_INTERVIEW_CAP_USD`, $10) covers each interview; an opening with no cap spends nothing; interview spend never counts against a person's own budget, and Work's spend report shows it only to the admin. I1.6 (server): one PDF résumé per candidate (`interview_resumes`, `INTERVIEWS_RESUME_BUCKET`), uploaded by the recruiter, read by anyone who can open the candidate, served inline in a sandbox; the seed has generated one-page PDFs. I2.1: the invite link `/join#<token>` (only the hash is stored; reusable until it expires 24 hours after the interview or is revoked; a new opening ends the earlier guest session); the guest has its own cookie and principal that every staff gate refuses; the guest's realtime token is built but not served until I2.2. The tenant is shown to people as Candidates; its id stays `interviews`. Round 3 drops the unused `interviews.invite_token_hash`.

**16 November, round 3 (eight lanes, prototype mode).** Functional, with type checks and unit tests; walks and edge cases are owed. I1.6 (portal): the résumé on the candidate's profile in the library's PDF viewer, with upload, replace and remove for the recruiter. I1.7: the Prepare page (questions, résumé, competencies); a round is `ready` when its lead has accepted, it has a time and at least one question (at most 8), and list rows follow the same rule. I5.6: a bell to the lead and panel 15 minutes before a round starts; the opening's cap is sent only to the recruiter, its hiring manager and the admin. I3.2 (staff half): only the lead invites Milo; the transcript and minutes are read by the lead, the panel, the recruiter and that opening's hiring manager; the opening pays; Milo has no tools in an interview; a Work session and an interviews session cannot reach each other's calls. I2.2: the lobby family `interviews:interview:<id>` with one seat rule for the call, presence, chat and media; the guest's realtime token is served behind `INTERVIEWS_GUEST_REALTIME` (on only in the mock world), loaded from the invite, never the directory; platform-api refuses a guest token everywhere but its own interview's video session (merged there). Deploy order: platform-api first, then this with the setting off, then the setting on. I2.3: the candidate's notice (version 2026-11-16.1) and three separate answers kept with their history, the device check, the waiting page; a guest may knock only when the current notice is answered, and Milo hears a guest only when the transcript and Milo were both accepted. The notice promises retention and deletion that row I6.3 enforces; it does not go live before I6.3. I2.4 (the panel's side, decision 21): the room fills the page with the call tiles, the shell's right pane holds Milo's context (or the coding questions, read-only until the pad is installed), and the footer call bar carries time left, End interview and the lead's Admit prompt; in an interview the footer drops sharing, rooms and reactions.

**17 November, round 4 (seven lanes, prototype mode).** I2.4 (candidate): the candidate's room under `/join` on the same call runtime (tiles, the library's call bar, the call chat in the right pane), and an ended page with how to ask for deletion; a guest's every recheck now needs its live session's tag. I2.7: the lead and up to two panel members hold the call, its chat and presence; a reassigned member loses it. I2.5: what each combination of the three answers runs with; a declined transcript means no Milo in the call at all; the recruiter gets a bell and a Consent column on Upcoming; the answers appear on no scorecard, debrief or list. I2.6: an interview is recorded only on the BFF's decision (`/recording-decision`), played only on its answer (`/recording-access`), with no share links; platform-api asks both and records nothing when it cannot ask. I3.3: the coach (Amazon Nova Pro by default, a scripted stand-in in the mock world) suggests one question at a time, tied to a competency and quoting the transcript; a guard drops any suggestion that rates, recommends or touches a personal trait; at most 20 per interview, one per 90 seconds; only the lead sees them. I3.4: the suggestion is a footer prompt (I'll ask it, Have Milo ask, Skip); Have Milo ask posts the words to the call chat, not yet aloud. I5.3: the scorecard (each competency 1 to 4, a recommendation, a summary; corrections are new versions with a reason); an interviewer reads the others' only once their own is in. I6.3: retention sweeps (media 90 days, records 4 years) and deletion on request from the profile, with a deletion log. Before the notice goes live: platform-api's erase route deployed, the meeting assistant's 30-day transcript sweep made to skip interview calls (the interviews sweep keeps them 90 days), reasons written on stage moves redacted on deletion, and a signal for a deletion request open past 30 days. Decided: in an interview call the candidate's chat shows only the questions the lead approved for Milo; Milo's other lines are panel-side.

**17 November, round 5 (eight lanes, prototype mode).** I5.1: the interview record page (the recording through platform-api's panel-only playback, the transcript, markers); interviewers may read it before they score. I5.2: Milo's recap, opened only after the reader's ratings are stored, every statement quoting a candidate's line; a recap that judges is rejected whole (three attempts); the scorecard records whether a rating changed after the recap. I5.4, I5.5, I5.6: the debrief side by side, the stage decision by that opening's hiring manager only (with a reason, never edited; a decision closes corrections), and the scorecard-due, submitted, every-scorecard-in and decided bells, none naming the candidate. I3.6, I3.7: the panel's live transcript and Milo's notes in the room's pane, and the lead's private questions to Milo, answered only from quoted lines; judgement questions get one fixed sentence. I3.10: Milo's suggested plan on Prepare, from the kit only. I6.1, I6.2: the consent records on the profile (answers to the recruiter; to the hiring manager only that the notice was given) and the recruiter's export of what Milo showed. The panel's own notice: Accept waits until the interviewer has read the current version. The recap and private answers are kept with the records (four years). Before the notice goes live: platform-api's erase route deployed, and the standalone gateway on the social profile filtering a guest's call chat as the middleware does (or refusing guest tokens). Done in round 5: Milo's 30-day sweep skips interview calls and the interviews sweep removes them at 90 days; stage-move reasons become "Reason removed." on deletion; a deletion past its date shows as late and rings the opening's recruiter once; the candidate's chat shows only people's messages and the questions the lead approved. Three system prompts (the recap, private answers, the plan) are written and not yet read by the owner. I3.9 estimates on Nova Pro: a suggestion about $0.002 to $0.005 (at most about $0.10 an interview), a private answer about $0.008 (at most about $0.12), a recap about $0.01 an attempt (worst case $0.16 for three).

**17 November, round 6 (five lanes, prototype mode; the last feature round that needs nothing from the owner).** The standalone gateway (realtime-examples `cef92bfe`) refuses an interview guest at the connection, on every bearer HTTP route and on every channel; interviews with a candidate run on the portal's own gateway only, and the social profile must run an image built from that commit or later. After the call, a seat that has opened the recap may ask Milo where something was said (quoted lines only, 10 per person). I6.4 is finished: `INTERVIEWS_SOON_MINUTES` (5 to 120, default 15) and `INTERVIEWS_REQUIRED_CONSENTS` (recording, transcription, milo; default none): a declined required part is stored, but the guest cannot knock or be let in, the candidate sees a held page, and the recruiter is told; `lib/interviews/settings.ts` lists every setting. The panel's notice is offered again on My interviews after a new version, blocking nothing. Tidy: `interviews.invite_token_hash` is dropped; Upcoming's time editor sits above the table; seeded interview ids are random. I3.9 and I4.6 are answered below. Decided: an interview's listening is limited to the round's minutes plus 15 (not the meeting assistant's 60 to 180), which keeps the worst case near $5.40 and lets the default per-interview cap fall to $6. Before the notice goes live, add: the notice's "Saying no" paragraph must say that a deployment may require a part (a new notice version), since it now reads that the interview always goes ahead. Owner decisions still open: the listener (Transcribe recommended), the first run backend (AgentCore Code Interpreter recommended), the CodeMirror install for the pad, the speech provider, and reading the notice and the three system prompts.

- **I0.7:** answered below.
- **I1.2, the candidate profile:** header, the stage tracker, the rounds with results the viewer may see, and the stage history. Names in every list link to it.
- **I1.3, openings and their kits:** the Openings table, an opening's page, the kit editor and a New opening page.
  - The recruiter writes under the existing `ManageCandidates` action, which already covers openings.
  - Each opening has a revision; a save made from an older revision is refused, so nobody overwrites someone else's changes unseen.
  - A round, competency or question already in use cannot be removed.
- **I1.8:** the Engineering Manager opening has a behavioural kit.
- **I3.1, the policy seam in the meeting assistant:** in place, with only the default policy registered. I3.2 must also widen the meeting-assistant routes' tenant gate, grant `InviteMeetingAssistant` to the interviewer role, and add the `interviews` spend source.
- **Library (ui-components 2.532.0):**
  - `DateTimeField` and `RatingInput`, the library halves of I1.5 and I5.3.
  - `CodePad` on its own subpath, which is I4.1: CodeMirror 6 on a shared Y.Text with named carets, seven languages, and paste and edit reports.
  - `PdfViewer`, the library half of I1.6.
  - CodeMirror and pdf.js are optional peers, so the portal installs them the first time a page uses either. That install happens in the foreground.

The judge's pieces live in `scripts/validate-interviews.d/` and the walk's in `scripts/journeys/interviews/`, one file per row.

## I0.7 answer

Written 16 November 2026 from this repository's code, the installed packages, and (read only) platform-api, realtime-modules and live-video-streaming. The websocket-gateway checkout has no source to read. Where this answer and "What exists" disagree on shared editing, this answer is the newer reading.

### The pad's shared text

**Decision: the middleware's own realtime gateway carries the pad.** realtime-modules already ships the CRDT service that the document gateways run (`collabDocs`, lifted from websocket-gateway). The middleware already serves a realtime gateway on `/ws` everywhere except production, and in production when `REALTIME_GATEWAY` is on. It is the socket the journeys use, and the one the interview's call, call chat and presence will use. The pad is one more feature on that socket: document `ivpad:<interviewId>` on channel `doc:ivpad:<interviewId>`. The client is the library's `GatewayProvider` through `useYjsDoc`, on the socket the portal already holds, and I4.1's editor binds to its `Y.Text` and awareness. The proof is built: `middleware/src/lib/interviews/pad/` plus two hook-ins, the feature in `lib/realtime-gateway.ts` and the `doc:` namespace in `lib/gateway/authority.ts`. Its test, `pad/__tests__/pad-proof.test.ts`, connects two people over a real socket, has both type at once and checks that they converge; it also checks that carets cross, that a late joiner catches up, and that everyone without a seat is refused.

The options, priced:

- A small y-protocols relay under `/api/interviews`. This needs a second socket path through the upgrade guard, its own token check, a client provider written from scratch (`y-websocket` is not installed), and a protocol nothing else speaks. The candidate would hold two sockets with two admissions. Not chosen: it rebuilds what the library ships.
- The walk starts a local gateway. websocket-gateway is a container in the social profile, and the walks never start docker. Not possible here.
- Production on websocket-gateway with a document grant, and the mock world on the relay. That is two carriers, and the walk would prove only the one production does not use. The candidate would also need a document grant, and websocket-gateway's session callback would have to know guests. Not chosen.

**Checks.** Two checks guard every action, and both must pass:

- The CRDT service's document hook allows only a pad's channel, and only reading, editing and carets. Creating, deleting, restoring, saving versions, renaming and seeding are refused.
- The gateway's authority sends every `doc:` name to `admitPadChannel`. That function reloads the principal and requires all of these: the socket is in the interviews tenant, the role holds `ViewInterviews`, the round is technical, and the caller is its lead or on its panel. It then reloads the principal again.

The decision runs on every subscribe, every edit and every delivery to a recipient. The recruiter, the hiring manager, interviewers on other rounds, other tenants and behavioural rounds are refused. So is any other `doc:` name, and so is everything while the tenant's flag is off.

**What it costs to stay in step with production.** The service, the wire frames and the client are the library's, so they move with the realtime-modules pin. What stays with this repository:

- Storage. Snapshots are in memory now. A deployment that keeps a pad across a restart, or runs more than one task, needs the library's Dynamo snapshot store and a Redis hot cache. Until then pads live under the gateway's existing one-task safeguard. The durable record is the pad log (I4.3).
- Per-delivery cost. Each delivery lists the tenant's interviews, so I4.2 adds a read of one interview to the store.
- Removed panel members. With `REALTIME_AUTHORITY_CACHE` on, a removed panel member keeps a cached yes for up to the cache's maximum age (5 seconds by default). I4.2 either drops pad verdicts when a panel changes or marks pad names uncacheable.
- Interview ids must stay at 40 characters or fewer, because the library caps a document channel at 50.

### The guest's seat

What exists today:

- The token bridge, `GET /api/session/realtime-token`, mints a 10-minute HS256 token from a signed session.
- The middleware's gateway admits a socket on that token.
- platform-api verifies the same token. Before it creates or joins a video session, it asks this middleware through `POST /api/realtime/lobby-access` and `/call-seat`.
- live-video-streaming trusts platform-api's participant tokens and needs nothing new.

What is missing:

- **This repository: a guest principal.** Every gateway decision, and both of platform-api's questions, load the principal from the directory (`getLivePrincipal`). That refuses anyone without a user row, a matching epoch and a grant, so today a guest is refused everywhere.
  - I2.1 mints the guest's realtime token: no tenants, a role with no Cedar file, and a claim naming its one interview.
  - I2.2 loads a guest principal from its invite (not revoked, not expired) instead of from the directory, and adds three things that take that guest and the panel: the `interviews:interview:<id>` lobby family, the call chat for that lobby, and the pad rule. Everything else stays refused, because every other family, namespace and route needs a grant the guest does not hold.
- **The waiting room: nothing exists.** Knocking in realtime-modules is client-side and only for direct calls, and platform-api keeps its admitted list only for those. So the waiting room lives here: the guest's lobby admission and pad seat are refused until the lead admits them. platform-api's existing question to this middleware then enforces it with no new protocol.
- **platform-api: two changes, both in I2.2.**
  - `LOBBY_AUTHORITY_TENANTS` defaults to orgiq, assessment, social and pipelines, so `interviews` must be added.
  - A guest's token is a valid identity on every platform-api route, not only video sessions. platform-api must refuse it everywhere else, keyed on the guest claim. Its own prefix rule passes a guest for every `interviews:` lobby, so this middleware's answer remains the only per-interview gate, and it is asked every time.

I2.1 changes only this repository. I2.2 changes this repository and platform-api. realtime-modules and live-video-streaming need nothing.

### Recordings in the mock world

Today platform-api records every lobby that is not a direct call, by default. The client's request decides, with no rule per lobby family and no question to this middleware. Any participant may play a recording back, and the candidate would be a participant. Share links play without signing in. The mock world has no media server: its only recordings are three fixture rows for Social lobbies, with nothing playable.

So I2.6 is mostly media work:

- **platform-api:** a recording decision for `interviews:` lobbies that asks this middleware whether every consent is in; playback that refuses guests (or asks this middleware); and share links turned off for the family.
- **This repository:** the consents, recording settings that the server sets rather than the client, and the panel-only read.

**What the walk can show:** the consents, the server's decision on whether a call asks to record (tests here and a walk step), and the record page (I5.1) on a seeded stand-in: a finished interview with a recording row and a transcript, panel side only, with the guest refused.

**What must be checked by hand on the social profile:** that a real call records only with consent, that the recording plays for the panel, and that a guest's token cannot list or play it in platform-api.

Rows changed: I2.2 and I2.6 now name platform-api and say how they are judged; I4.2 is judged on this carrier.

## I3.9 answer

Written 17 November 2026 from this repository's code. No price here was looked up on the day: the repository's own figures are cited where they are, and every other price is in "Prices assumed, to verify" with the unit it is charged in. Each model figure shows its arithmetic, so a corrected price can be dropped in.

### What one interview costs

**Prices from this repository.** The live session: $0.05 a minute (`OPENAI_LIVE_USD_PER_MINUTE`, `lib/model-prices-defaults.ts`; the meeting assistant's "about $3 per hour"). Amazon Nova Pro: $0.0008 per 1,000 input tokens and $0.0032 per 1,000 output tokens (`lib/pricing.ts`). Every Nova caller sizes its hold the same way: (system prompt + 800 + the request's own text) characters at four characters a token in, and a fixed number of tokens out.

**The arithmetic, one call each.** A transcript line is taken as 170 characters typical (speech plus its number and speaker) and 620 at the cap (`MAX_LINE_CHARS` 600 plus the label).

- Suggestion (`estimateCoachTokens`): prompt 1,593 + 800, the kit about 1,500, 80 lines, 8 earlier suggestions: about 19,900 characters, 5,000 tokens in, 120 out, **$0.0044**. At the cap (120 lines, 20 earlier, a 3,000-character kit): 23,000 in, 300 out (`COACH_MAX_TOKENS`), **$0.019**.
- Private answer, live or after the call (`estimateAskTokens`; both read the last 120 lines): prompt 1,468 + 800, a 300-character question, 80 lines: 4,000 in, 400 out (`ASK_MAX_TOKENS`), **$0.0045**. At the cap: 19,200 in, **$0.017**.
- Plan draft (`estimatePlanTokens`): prompt 1,137 + 800, a 20-question bank at 300 characters: 2,200 in, 700 out (`PLAN_MAX_TOKENS`), **$0.0040**. A 50-question bank at the 400-character cut: 6,900 in, **$0.0077**.
- Recap attempt (`estimateRecapTokens`): prompt 1,817 + 800, 250 lines for 60 minutes (190 for 45): 11,500 in (9,000), 1,000 out, **$0.012** ($0.010). At the cap (400 lines of 620, 2,000 out): 63,400 in, **$0.057**.

These replace round 5's figures where they differ; round 5's "at most $0.10" for suggestions assumed typical lines, and the cap's worst case is about four times that.

**The table.** Typical is a round that runs to time with an ordinary amount of help; worst is every limit used at its cap. Dollars per interview.

| Part | Unit | Units (product limit) | 60-min technical, typical | worst | 45-min behavioural, typical | worst | Held under |
|---|---|---|---|---|---|---|---|
| Listener (live session, listening only) | minute | the call's ceiling: 60 min, extendable to 180 (`MEETING_ASSISTANT_HARD_MAX_MINUTES`) | 60 min, $3.00 | 180 min, $9.00 | 45 min, $2.25 | 180 min, $9.00 | `listening` (the meeting assistant's hold, tied to the interview by its call) |
| Suggestions | call | 20 an interview | 10, $0.044 | 20, $0.39 | 12, $0.053 | 20, $0.39 | `coach` |
| Private answers, live | call | 15 an interview, the lead | 5, $0.023 | 15, $0.25 | 5, $0.023 | 15, $0.25 | `coach` |
| Private answers, after the call | call | 10 a seat, 3 seats | 3, $0.014 | 30, $0.50 | 6, $0.027 | 30, $0.50 | `coach` |
| Plan draft | call | 3 an interview | 1, $0.004 | 3, $0.023 | 1, $0.004 | 3, $0.023 | `coach` |
| Recap | attempt | 3 an interview | 1, $0.012 | 3, $0.17 | 1, $0.010 | 3, $0.17 | `coach` |
| Speech, Milo asking aloud (I3.5, not built) | character (assumed) | approved questions, repeats, the time | 1,300 chars, $0.021 | 12,800 chars, $0.20 | 1,300 chars, $0.021 | 12,800 chars, $0.20 | `speech` |
| Runs (I4.4, not built) | vCPU-second and GB-second (assumed) | 60 an interview | 25 runs, $0.003 | 60 compiled runs, $0.10 | none | none | `run` |
| **Held against the cap** | | | **$3.12** | **$10.63** | **$2.39** | **$10.53** | |
| Recording and its storage for 90 days | GB-month (assumed) | one recording | about 1 GB, $0.07 | the same, $0.07 | about 0.75 GB, $0.05 | $0.05 | nothing: platform-api's media cost |

Speech: typical is four approved questions of 200 characters, two repeats and two time answers; worst is all 20 suggestions spoken and repeated once, plus 20 fixed answers. Runs: typical is an interpreted run of 3 CPU-seconds in a 15-second, 1 GB session (about $0.0001); worst is a compiled run of 30 seconds on 2 vCPU and 2 GB (about $0.0017). A recording is about 1 GB an hour (assumed: 2.2 Mbit/s), kept three months. Playback adds data transfer per viewing (assumed below).

**What it shows.** The listener is 96% of a typical interview; all of Milo's text work together is under $0.15. The worst case passes the default cap of $10 only because the listener's ceiling is the meeting assistant's (60 minutes, extendable to 180), not the round's. With the cap in force the coach and runs are what get refused first, which is the wrong way round.

**What the cap should be.** Two changes, one decision:

- The interview's listening ceiling becomes the round's minutes plus 15, and extensions stop there (a policy value in `milo-policy.ts`, not a new setting). The worst cases then fall to $5.38 (technical: $3.75 of listening) and $4.53 (behavioural: $3.00).
- The default per-interview cap (`INTERVIEWS_INTERVIEW_CAP_USD`) goes from $10 to **$6** (owner: the default stands at $10 until changed). $6 covers every worst case above with a margin for a model price change, and halves what one interview can spend. With the Transcribe listener below, a typical technical round falls to about $1.61 and the cap could fall again.

### Prices assumed, to verify

Each is a public list price recalled, not read on the day, for us-east-1 on demand.

- Amazon Transcribe streaming: $0.024 per minute of audio streamed, billed per second with a 15-second minimum per stream.
- Amazon Polly neural voices: $16 per million characters (generative voices about $30 per million).
- AgentCore Code Interpreter and AgentCore Runtime: $0.0895 per vCPU-hour of active CPU and $0.00945 per GB-hour of memory, billed per second.
- Amazon S3 Standard: $0.023 per GB-month. Data transfer out for playback: about $0.09 per GB.
- The recording's size: 2.2 Mbit/s, about 1 GB an hour (this is platform-api's choice, not a price).

### A listener on Amazon Transcribe

**What it implements.** `LiveMeetingSession` (`lib/meeting-assistant/session.ts`), as a third kind: `TranscribeListener`, `kind: 'transcribe'`, `acceptsText: false`. It emits `inputTranscript`, `usage`, `expires`, `closed` and `error`, and never `outputTranscript`, `outputAudio`, `toolCall` or the delegation events: it has no voice and no tools. `start` ignores the instructions and the catalogue. `answerToolCall` and `appendContext` answer false. `pendingInputText` returns the newest partial result. `close` ends every stream and resolves once `closed` is emitted.

**One stream per participant.** Today the media server's taps already post each participant's own 16 kHz mono audio, 200 ms at a time, and the audio intake (`audio-intake.ts`) checks the token, the participant's binding and the acknowledgement before the mixer sums everyone into one 24 kHz stream. Transcribe takes 16 kHz PCM as it arrives, so the listener skips the mixer:

- The interface gains one optional method, `appendParticipantAudio(userId, pcm16kMono)`, and a flag, `perSpeaker: true`. The intake routes a chunk there instead of to the mixer when the session has the flag; the mixer path is unchanged for the other two kinds.
- `inputTranscript` gains `speakerId`. When it is set, the line is attributed to that person and the voiced timeline (`attribution.ts`) is not consulted. Overlap stops being a guess: two people talking at once are two lines.
- The listener opens one streaming transcription per bound participant (`StartStreamTranscription`, PCM 16 kHz), keyed by the user id the intake resolved, never by anything the stream says.

What the media stack must hand over is what it hands over today. What is missing: the candidate's tap is bound only through a person binding their own seat (`bindParticipant`), so the guest's seat (I2.2) must bind its participant id the same way; and one stream per seat costs per seat, so a seat's stream is opened when that person has been voiced and closed after 20 seconds of silence, with a one-second ring kept so the first words are not lost (the intake already measures each participant's level against their noise floor).

**Partial and final results.** Transcribe sends partial results while a person speaks and a final one when a segment ends. Only finals become `inputTranscript`, so the stored transcript, the coach, the private answers, the recap and the record page read finals only, exactly as they read lines today. The newest partial is `pendingInputText`, which the voice gate reads; the panel's live transcript (I3.6) shows it greyed under the last line and replaces it when the final arrives. Nothing partial is stored.

**Consent.** Nothing is sent before transcription is accepted, and the check stays where it is: the intake drops an unacknowledged person's chunk before it reaches any session, and the interviews policy's `acknowledgedElsewhere` answers for the candidate from the portal consent (I2.3). A stream is opened only for a person the intake has passed, so a declined candidate never has a stream at all. `inviteRefusal` still refuses the lead when the candidate declined the transcript.

**Language.** One language per interview, set on the opening and defaulting to English (US); the stream is opened with it. Automatic language identification is not used: it costs a second pass, and a wrong guess is worse than a fixed choice. A custom vocabulary per opening (the kit's terms) is a later row.

**Failure and reconnection.** A stream that fails or closes is reopened for that participant with backoff (1, 2, 4, 8 seconds, then every 15). Audio that arrives meanwhile is kept in the one-second ring and the rest is dropped, and the gap is recorded as a marker on the record ("transcription paused for 40 seconds"), never filled in. Throttling and service errors keep codes only (`ProviderErrorInfo`). When every stream has failed for 90 seconds the listener emits `closed`, and the meeting assistant's existing pause, settle and resume path runs unchanged.

**What Milo loses.** The live model can hear a spoken request and answer it. In an interview nothing it says is relayed (decision 9, `relaysLiveSpeech: never`), and the candidate's two requests are answered with held text, never by a model (decision 10). So the requests are found where the meeting assistant's detector already finds spoken commands: in the final transcript lines, by fixed patterns, which is what I3.8 builds. The answer is spoken by I3.5's synthesis. With the Transcribe listener the free-form spoken question to Milo disappears from interviews; nothing in this plan uses it. Work's calls keep the live model.

**How it is chosen.** `session-select.ts` takes the call's policy: a policy may name a listener, and the interviews policy names `transcribe` when the deployment setting `INTERVIEWS_LISTENER` says `transcribe` (default `live`, the session today). The mock world still returns the scripted session first, untouched. A Transcribe listener is made only when its client can be built.

**Money.** Held under `listening`, like the live session, in stream-minutes. The invite holds 10 stream-minutes per seat, and the run meter (`meterInterviewSpend`) tops up in 10-minute steps against the same caps; a refused top-up closes the streams and pauses Milo as a refused hold does today. Settled on the seconds each stream actually ran (the service reports none per stream), floored at the 15-second minimum. Typical, at the assumed price: a technical round's candidate speaks about 30 minutes and the lead 18; with silence tails about 62 stream-minutes, **$1.49** (a behavioural round with a panel member, about **$1.31**). Worst, every stream of four seats open for 75 minutes: **$7.20**, which the cap stops.

**Tests and what only a real call proves.** A scripted Transcribe stand-in (an injected client that replays partials and finals per stream, fails one stream mid-call, and throttles) proves: lines carry the stream's speaker; partials never stored; an unacknowledged person has no stream; reconnection and the gap marker; the 90-second close; holds, top-ups and the settle; the detector finds both fixed requests in finals. Only a real call proves accuracy on accents and technical words, latency from speech to a final line, the cost per real interview, and that a guest's tap binds.

**Size and rows.** About 6 builder days (the session and stand-in 2, the intake's per-speaker route and gating 2, selection, money and the gap marker 1, tests 1). Rows it would add: **I3.11** the Transcribe listener behind the session interface (M), **I3.12** the per-speaker route and the voiced gate in the intake (M), **I3.13** a measured cost per interview from one real call on each listener, written here (S).

**Decision (owner).** Decision 7 accepts the speech-to-speech listener for the first version, and that default stands. Recommended: switch interviews to the Transcribe listener before the first real candidate. It is AWS-native, so a candidate's voice stays in this deployment's provider; attribution comes from the stream rather than timing; it costs about half; and it loses nothing an interview uses.

## I4.6 answer

Written 17 November 2026 as a design only: I4.4 (the queue and the mock executor) is not built, so this is written against "The run interface" as the plan states it. What I4.4 must expose is at the end of the first part.

### AgentCore Code Interpreter: Python, JavaScript and TypeScript

What exists: the capabilities stack deploys a custom Code Interpreter in `SANDBOX` network mode (`infra/lib/agentcore-capabilities-stack.ts`), and the provider (`providers/agentcore.ts`, `executeCode`) starts a session, runs one snippet, collects the result and stops the session. That is the Python-only, synchronous route the audit found. The interviews backend is a second interpreter, `<prefix>_interview_runs`, of its own, so its role and limits are not shared with the agents'.

**A session per run.** Chosen over a session per interview. A fresh session per run leaves nothing of one run's files, processes or memory for the next, so a candidate's earlier program cannot change a later result and a hostile run harms only itself. Billing is for active CPU and memory, so a session left open for an interview costs memory for the hour and buys only start-up time. The cost is start-up per run, which is measured before this ships (below).

**How the request maps.**

- `files`: written with the interpreter's file-writing tool into a fresh working directory; a path with `..`, an absolute path or more than 50 files is refused before the session starts.
- `entrypoint` and `stdin`: run as one command, `<runtime> <entrypoint> < stdin.txt`, with stdin written as a file. Python runs directly. TypeScript is compiled first, and that step is `compiling` with its own 10-second limit.
- Limits: the session timeout is set to `wallMs` plus 5 seconds as a backstop, and the middleware's own timer stops the task at `wallMs` and reports `timed_out`. Memory is limited inside the session by the run wrapper (`prlimit` on address space and process count), so the runtime enforces it rather than the program. Exit by that limit reports `memory_exceeded`.
- `maxOutputBytes`: the middleware counts as it reads, keeps the first `maxOutputBytes` of each stream, and sets `truncated`. Past four times the limit it stops the task as an output flood and reports `failed`.

**Status and output.** `queued` is I4.4's queue. `compiling` is only for TypeScript. `running` starts when the command starts. The end maps: exit 0 to `succeeded`, any other exit to `failed`, the timer to `timed_out`, the memory limit to `memory_exceeded`, a cancel to `cancelled`, and any service error, throttle or refused session to `internal_error`. Output events (`stdout`, `stderr`) are sent as the service makes output available. If it gives output only at the end (to verify), the events arrive in one burst at the end and the contract still holds.

**Cancel.** Stops the task and then the session; the result is `cancelled` unless the run had already ended.

**The runtime version.** The service chooses its language versions; this project cannot pin them. Each run asks the runtime for its version in the same command and writes it on the result. A version that differs from the one this plan names raises an alarm and the run still answers. (owner: accept the service's versions; the alternative is to send all languages to the container runner below, which pins them.)

**No network.** `SANDBOX` mode is documented as having no outside network. What must be verified on a real interpreter: that DNS lookups do not resolve, that AWS endpoints (S3 included) are not reachable from the program, and that the session's role credentials cannot be read. The interviews interpreter's execution role holds nothing at all, not even logs, so a credential that leaked would open nothing.

**Cost.** At the assumed price, an interpreted run of 3 CPU-seconds in a 15-second, 1 GB session is about $0.0001. 60 runs are under $0.01, held under the `run` part, one hold per run (key: the `runId`), settled from the session's seconds.

**What I4.4 must expose.** An `Executor` interface with `start(request, onEvent)` returning the result, and `cancel(runId)`. A backend name and its pinned versions per language. The queue's one-at-a-time per interview and its 60-run count, held outside the executor so every backend gets them. The run row keyed by `runId`, so a repeat returns the stored result and never runs twice. The hold and settle around `start`.

### A container runner with no network: Swift, Java, Go and C++

**Where it runs.** The options that fit a CDK-only, AWS-native deployment:

- **AgentCore Runtime with one image per language, a session per run (chosen).** Each session is its own microVM, which is the isolation a hostile program needs. It is what the microVM runner already chose over self-hosting Firecracker (`docs/microvm-runner-design.md`, section 2), so the stack, the image pipeline and the role pattern exist. It runs in VPC mode in subnets with no route out and a security group with no outbound rule.
- ECS on Fargate, a task per run. Isolation is as good, but a task takes tens of seconds to start (assumed), well past what a person waits for in an interview. Rejected.
- Lambda with container images. Fast, but a warm environment is reused between invocations, so one candidate's leftover files and processes could meet the next run. Forcing a fresh environment per run gives up the speed. Rejected.
- ECS on EC2 with gVisor or Firecracker hosts. This means self-hosting, and the microVM runner already decided against it. Rejected.

**One sandbox per run.** A new session id per run, closed when the run ends. The image runs a small run server (the runtime's invocation contract) that writes the files, compiles, runs and streams back. The program runs as an unprivileged user in a fresh directory with an empty environment, so no credentials are passed to it.

**Compile, then run.** `compiling` has its own limit, 20 seconds (Swift and C++ compile slowly), and its output goes to `compileOutput`. A failed compile ends at `compile_error` and does not count against the run's `wallMs`.

**Limits enforced by the runtime.** Wall time by the run server's timer and the session's own lifetime as a backstop. Memory and the number of processes by cgroup or `prlimit` set before the program starts. No program can raise its own limits. Output is truncated as in the interpreter, by the run server and again by the middleware.

**Images pinned by digest.** One ECR repository, one image per language built in CDK with its version in the tag. The runtime is deployed by digest, and the digest and version are written on every result as `backend` and `runtimeVersion`. A new version is a new digest and a deploy, never a moving tag.

**No credentials or metadata.** The runtime's execution role holds only what pulling the image and writing logs needs. The program's user gets no environment. Before this ships, a run must show it cannot reach the metadata or credential endpoint or any address.

**The queue.** I4.4's queue in the middleware's store stays the queue; the middleware calls the runtime with a streaming response and turns it into the contract's events. No separate queue service while one middleware task runs. A deployment with several tasks claims runs from the same table under the per-interview lock, so one-at-a-time still holds.

**Cold start.** The contract's 10 seconds is the program's wall time, from `running`, not the wait. Start-up shows as `queued`. The microVM runner's boot time has never been measured in AWS (`microvm-boot-seconds`, "Unverified without AWS"), so the target is set here: a run reaches `running` within 5 seconds at the 75th percentile. If it does not, a warm session for each language is kept for at most one run and then discarded. That pays a session's idle memory to save the wait, and never reuses a sandbox.

**Cost.** At the assumed price, a compiled run of 30 seconds on 2 vCPU and 2 GB is about $0.0017; 60 runs are about $0.10, under `run`.

### What both must pass

The executor contract tests I4.4 writes, run unchanged against each backend:

- Each terminal status: `succeeded`, `failed`, `compile_error` (compiled languages), `timed_out`, `memory_exceeded`, `cancelled`, `internal_error` (an injected service failure).
- Truncation: an output past `maxOutputBytes` is cut, flagged, and the run goes on to its own end.
- A repeat of a `runId` returns the first result and starts nothing.
- Cancel while queued, while compiling and while running.
- One run at a time per interview; a second waits as `queued`. The 61st run is refused.
- Hostile programs: a fork bomb ends in `failed` or `memory_exceeded` within the wall time and leaves the next run unaffected; a network attempt (a socket to an outside address, a DNS lookup, the metadata address) fails; a write outside the working directory fails, and a file written inside it is gone in the next run; an output flood is cut and stopped.
- `runtimeVersion` and `backend` on every result.

The mock passes these by script. Only a real backend proves that untrusted code is isolated, which "What the judge cannot see" already says. A real backend is accepted when a person has run the hostile cases against it in a deployed account and written the results here.

### Order and size

**Which backend first (owner).** The default and the recommendation: AgentCore Code Interpreter first, because the stack, the role pattern and the provider call exist, and Python is the most common interview language. The runner follows, for the four compiled languages. About 3 builder days for the interpreter (its own interpreter in the stack 0.5, the executor 1.5, contract tests and a hostile run by hand 1) and about 8 for the runner (four images and their pipeline 3, the run server 2, the stack in VPC mode 1, the executor 1, measured cold start and hostile runs 1).

**What the owner provides.** AgentCore Code Interpreter and Runtime available in the account and region, with a session quota for at least the expected concurrent interviews. An ECR repository. Two subnets with no route out for the runner. Consent to run the hostile tests in that account.

**Rows a build would add.** **I4.7** the AgentCore Code Interpreter executor for Python, JavaScript and TypeScript (M). **I4.8** the language images and the run server, pinned by digest (L). **I4.9** the container runner executor on AgentCore Runtime in VPC mode (M). **I4.10** the hostile-program runs against both real backends, by hand, written here (S).

## Ledger

Sizes: S is under a day of builder time, M one to two, L more. Every row merges on its own after the full verification chain. "Judged by" is what the judge script checks; a row is done when the judge says so, never when this table is edited. The journey `journey:interviews` starts with I1.1 and gains a step with each row that names a walk step; it is not written at the end. Rows that change another repository say so: "library" is `ui-components`, "realtime" is `realtime-modules`, "media" is `platform-api`. Rows marked "install" need a package the owner installs first.

### Phase 0: the tenant exists

| # | Item | Judged by | Needs | Size |
|---|---|---|---|---|
| I0.1 | The judge, `scripts/validate-interviews.sh`, with `--quick` and `--phase`, phases nesting | it runs and prints every failing row | | S |
| I0.2 | Registration: the manifest entry and regenerated files, Cedar files per role, actions, role rank and presentation, the mount, channel families, notification labels, the voice tenant list and inventory, flags, nav, the context picker, tenant colours, route inventory, wire snapshots, the demo logins | `check-tenant-manifest.mjs` passes; the judge greps each point | I0.1 | L |
| I0.3 | The model: `schema/interviews_schema.sql`, the in-memory store and the SQL store behaving the same | store tests in both | I0.2 | M |
| I0.4 | The cast and the seed story in the mock world | mock floor and parity checks; the judge counts rows | I0.3 | M |
| I0.5 | Read routes and the permission matrix: each role sees what decision 2 says and nothing else | `authz-matrix` rows for the three roles | I0.3 | M |
| I0.6 | Spend source `interviews` and how an opening carries a cap (holds are keyed to an initiative today) | spend tests; a refused hold reads plainly | I0.3 | M |
| I0.7 | Spike: how the code pad is carried and walked without the social profile; how a guest gets a seat through the token bridge and the media stack. Ends in a short written answer and the rows it changes | the answer is in this document; a two-context proof of shared text runs in the chain | I0.2 | M |

### Phase 1: the desk (no call yet)

| # | Item | Judged by | Needs | Size |
|---|---|---|---|---|
| I1.1 | Candidates table | walk step; DOM audit route | I0.5 | S |
| I1.2 | Candidate profile with the stage tracker and the rounds list | walk step | I1.1 | M |
| I1.3 | Openings and the kit editor | walk step; kit validation tests | I0.5 | M |
| I1.4 | Assign a round; the bell; My interviews; Accept or Decline with a reason | walk steps as recruiter then interviewer | I1.2 | M |
| I1.5 | A date-and-time field in the library; the time on an interview; Upcoming | library tests; walk step | I1.4 | M |
| I1.6 | Résumé upload and a PDF viewer in the library (library; install) | library tests; walk step | I1.2 | M |
| I1.7 | Prepare page: résumé, kit, picking questions | walk step | I1.4, I1.6 | M |
| I1.8 | Behavioural rounds: a kit of behavioural questions and competencies, a round with no code pad | kit tests; walk leg on a behavioural round | I1.3 | S |

### Phase 2: the candidate's door

| # | Item | Judged by | Needs | Size |
|---|---|---|---|---|
| I2.1 | Invite token and the guest identity (decision 3); the token leaves the address after first load | tests: expiry, one interview only, reuse, revocation | I1.4 | M |
| I2.2 | Lobby family `interviews:interview:<id>`, admission for panel and guest, a guest seat through the token bridge, the channel guard refusing a guest everywhere else (realtime, media) | gateway authority tests starting from a guest, the pad proof among them (a guest of another interview, and one not yet admitted, refused); platform-api tests: a guest token refused outside its video session | I2.1, I0.7; media is platform-api (the tenant list, guest tokens); realtime-modules needs nothing (I0.7 answer) | L |
| I2.3 | Portal: landing, the notice and three consents, device check, waiting room, admitted by the interviewer | walk with a second browser context as the candidate | I2.2 | L |
| I2.4 | The interview room for both sides (decision 21: the call fills the window, one far-right pane: Milo's context, or the pad in a technical round); the candidate's layout has no shell | walk step; screenshots at 1440 and 1280 | I2.3 | M |
| I2.5 | Declined consent: what the interview runs without, what the recruiter is told, nothing shown against the candidate | tests per combination; walk step | I2.3 | M |
| I2.6 | Recording only with consent (a rule in the media stack for this lobby family) and panel-only playback (media) | tests in the media stack (the family's decision waits for consent; a guest token cannot list or play; no share links) and here; the record page on the seeded stand-in, panel side only; one real recording checked by hand on the social profile | I2.3 | M |
| I2.7 | Panel seats: up to two more panel members in the call; only the lead gets Milo's prompts | admission tests; walk step with a third context | I2.4 | S |

### Phase 3: Milo in the interview

| # | Item | Judged by | Needs | Size |
|---|---|---|---|---|
| I3.1 | A policy seam in the meeting assistant: who may invite, who reads, who pays, which tools, per lobby family. Work's behaviour unchanged. Starts only after the fourth sweep's repairs to the same files are merged | every existing meeting-assistant test, the walk and the scenario suite pass untouched | | L |
| I3.2 | The interviews policy: the lead invites; portal consent is the candidate's acknowledgement; panel-only reads; no tools and no data for the candidate; no bell and no Meetings list for a guest | policy tests; a guest reading the record gets nothing | I3.1, I2.3 | L |
| I3.3 | The coach on Bedrock with a scripted stand-in: suggestions from transcript, kit, résumé and pad; the rate limit; the suggestion log | tests on fixed transcripts; the request body pinned as text; a malformed answer dropped | I3.2 | L |
| I3.4 | The footer prompt: I'll ask it, Have Milo ask, Skip | walk step; log rows | I3.3 | M |
| I3.5 | Milo asks aloud: synthesised speech over the voice relay under the `approved` reason; the same words in chat; nothing from the live model relayed in an interview (install) | gate tests; a scenario where the live model speaks and nothing is heard | I3.4 | L |
| I3.6 | "Milo for you": competencies covered so far, a time check, private questions typed to the coach | walk step; the candidate's page shows none of it | I3.3 | M |
| I3.7 | The live transcript, panel side only | walk step from both sides | I3.2 | S |
| I3.8 | The candidate's two fixed requests and the one fixed refusal (decision 10) | detector tests; a request for a hint gets the fixed sentence and no model is called | I3.5 | S |
| I3.9 | What an interview costs end to end (listener, coach, speech, runs), written here; and the design of a listener on Amazon Transcribe behind the session interface | the figures and the design are in this document | I3.3 | S |
| I3.10 | The coach drafts a question plan on the Prepare page from the kit and the résumé, advisory, logged like a suggestion | tests on fixed inputs; walk step | I3.3, I1.7 | S |

### Phase 4: the code pad and runs

| # | Item | Judged by | Needs | Size |
|---|---|---|---|---|
| I4.1 | Library: a collaborative code editor (decision 11) (library; install) | library tests: two clients converge, carets, language switch | | L |
| I4.2 | The pad in the room: its channel and grants, language choice, inserting a question (by the interviewer, and by "Have Milo ask") | walk with two contexts typing on the gateway's pad (I0.7 answer); `pad-proof.test.ts` still passes, with the candidate's seat added | I4.1, I2.4, I0.7 | M |
| I4.3 | The pad log: timed edits per person, pastes, snapshots | tests; a paste by the candidate shows as an event on the panel side | I4.2 | M |
| I4.4 | The run interface, the queue, the mock executor, the output stream, the output pane, limits and cancel | executor contract tests any backend must pass; walk step where both people see one run | I4.2 | L |
| I4.5 | The coach reads the pad and the last run | tests on fixed inputs | I4.4, I3.3 | S |
| I4.6 | Design only: the real backends behind the contract (AgentCore; a container runner with no network) | a design section and the contract tests named as the bar | I4.4 | S |

### Phase 5: after the call

| # | Item | Judged by | Needs | Size |
|---|---|---|---|---|
| I5.1 | The interview record page: recording, transcript, code playback, markers | walk step on a seeded finished interview (recording stand-in) and, for transcript, code and markers, on the walked one | I4.3, I2.6 | L |
| I5.2 | The recap writer: evidence per competency with sources, what was not covered, no score | tests: every claim has a source; a rating or a recommendation in the output is rejected | I3.3 | M |
| I5.3 | A rating input in the library; the scorecard: rate, recap, go or no-go, submit; versions; others hidden until yours is in | library tests; walk steps; permission tests | I5.2 | L |
| I5.4 | Recruiter review and the debrief page | walk step | I5.3 | M |
| I5.5 | The hiring manager's recap and the stage decision; the stage moves | walk step as hiring manager | I5.4 | M |
| I5.6 | Bells: assigned, starting soon, scorecard due, submitted, decided | notification tests; no content of the interview in a bell | I5.3 | S |

### Phase 6: records and rules

| # | Item | Judged by | Needs | Size |
|---|---|---|---|---|
| I6.1 | Consent records and notice versions on the profile's activity | tests; walk step | I2.3 | S |
| I6.2 | Export: what Milo showed and said for an interview, and the notices given | export tests on the seeded interviews | I3.4 | M |
| I6.3 | Retention sweeps and deletion on request with a deletion log | sweep tests; a deleted candidate's media is gone and the log remains | I5.1 | M |
| I6.4 | Settings per deployment: retention, notice lead time, which consents are required | config tests | I6.3 | S |

### Phase E: evidence

| # | Item | Judged by | Needs | Size |
|---|---|---|---|---|
| E1 | The whole journey in one pass, technical then behavioural: recruiter assigns, interviewer accepts and prepares, candidate consents and joins, a suggestion is approved and asked, code is typed and run, scorecard, debrief, decision | every step green, in the verification chain | all | M |
| E2 | Isolation walks: a guest and each role try every other tenant and every other interview | all refused | I2.2, I0.5 | M |
| E3 | The DOM audit and the type-scale sweep over every new page, at 1440 and 1280 | no new failures | all pages | M |
| E4 | A read-only audit sweep of the experience, as done for Milo, and its repairs | findings closed or decided | E1 | M |

### Order and what can be shown when

Phases 0 and 1 give a desk that can be demonstrated without a call. I4.1 depends on nothing but its install and can start on the first day beside phase 0; I3.1 can start as soon as the fourth sweep's repairs are merged. I0.7 comes before anything in phase 2 or the pad. Phase 2 gives a call with a candidate in it. Phases 3 and 4 can run side by side after it. Phase 5 closes the loop. Fifty-two rows; eleven of them large.

## What the judge cannot see

- Whether the coach's suggestions are any good on a real interview. The scripted stand-in proves the plumbing; quality needs real calls and people's opinions.
- The wording of the candidate notice. The product stores what was shown.
- Real execution. The mock proves the contract; isolation of untrusted code is proven only against a real backend, which is not in this plan.
- Speech quality and the gap between an approval and Milo speaking.
- A candidate on a poor connection or a phone.

## Audit (16 November 2026)

The plan was checked against the code and the installed packages on the day it was written. What held: the tenant list and the manifest, the taken role id, the textarea editor, the Python-only synchronous run route, and Milo's ties to Work. What was wrong or missing, now corrected above:

- "Mock first" was claimed for everything, but shared editing and recordings do not exist in the plain mock world. Decision 19 and rows I0.7, I2.6, I4.2 and I5.1 now say how each is proven.
- The new packages are not installed and installs are not done unattended. Rows that need one are marked.
- Work in other repositories was hidden inside local rows. Rows now name the repository.
- The live session would be paid for as a listener only, and no interview was priced. Decision 7 and row I3.9.
- Decisions 9 and 10 contradicted each other: nothing from the model is relayed, yet the candidate could ask open questions. The candidate's requests are now fixed and answered with stored text.
- The three consents were not independent, declining could not be hidden from the interviewer, and panel members were not asked. Decision 5.
- A guest's reach omitted runs, and the invite token stayed in the address. Decision 3.
- The journey was written at the end although rows were judged by its steps. It now grows row by row.
- No rows for behavioural rounds, panel seats, the coach's prepare-page plan, or Milo inserting a coding question. Rows I1.8, I2.7, I3.10 and I4.2.
- "A hint is impossible" overclaimed. Reworded.
- A deletion request against four-year records was not reconciled. Decision 17.
- The refactor of Milo would have collided with repairs in progress. Row I3.1.
- Two sizes were optimistic (I0.2, I0.6).

Still unverified: speech pricing, and every size in the ledger.

## Not in this plan

Email and calendar invites, availability, take-home assignments, a question marketplace, importing from an applicant tracking system, offers, candidates signing in to see their own status, and any scoring by a model.
