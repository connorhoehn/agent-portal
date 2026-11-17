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
