# Meeting assistant: audit

13 November 2026. Audited at `eb6cff56`, after packages 1 to 6a (`docs/meeting-assistant-design.md`).

**Status, 14 November.** The nine blocking findings and the medium ones are repaired and merged; a second audit found the blockers closed (see "After the repairs" at the end). The verdict below is the first audit's and is kept as written. A second full sweep on 14 November at `7cde1944` found one new high finding and fifteen medium ones (see "Second sweep" at the end); the feature stays off for real calls until those are repaired.

**Status, 15 November.** The second sweep's findings are repaired and merged. A third sweep on 14 and 15 November looked only at the experience: what a person in the call sees and hears, the consent workflow, and what is left after the call. It found 44 things, none of them a leak; they are repaired (see "Third sweep" at the end), and the chat cards and the meeting page were redesigned in the same run.

## Verdict

The feature must not be turned on for a real call yet. Nine defects are serious enough to block that: four can show one person's words or data to others, two can attribute or run an action wrongly, and three break the feature in normal use. None has touched real data. The flag is off by default, and the product code has only run on the mock world.

The parts built to be strict held up: nobody can post as Milo, turns and cards belong to the asker, nothing is stored or mixed before a person acknowledges, the test-only routes cannot be reached outside the mock world, and every tool call is answered exactly once.

## Scope and method

Three read-only passes over the meeting assistant's code, each on one slice: server authority and privacy; the orchestrator, session, audio and money; the portal and the walk. The nine blocking findings were then checked again against the code by a second reading. "Confirmed" means the defect is visible in the code. "Plausible" means the defect is in the code but its precondition was not proven.

Not audited: `platform-api` and the media server beyond the tap listing and the join id, the component library changes, the SQL stores against a real database, and the provider's real behaviour. Findings name the weakness and its effect, not a way to use it.

## Blocking findings

| # | Where | What is wrong | Effect | Fix |
|---|---|---|---|---|
| B1 | `orchestrator.ts` `onInput`, `onOutput` | Who a reply belongs to, and whether it is private, is one slot per call, and every new piece of speech resets it. Confirmed. | If anyone speaks between a private question (a budget) and the answer, the answer is posted to the whole call. The same slot can label a reply with the wrong asker. | Bind the reply to its tool call or turn, not to the call. |
| B2 | `orchestrator.ts` `submitResult` | A private tool result is given to the one session everybody shares. Confirmed. | Nothing stops the model repeating it later in a public answer to another person. | Answer private reads outside the shared session; tell the session only that it was answered privately. |
| B3 | `orchestrator.ts` `recentAsker` | On the real session the asker is the latest speaker, not the person who addressed Milo. Dropped request confirmed; wrong person plausible. | If someone else speaks before the tool call arrives, the request is refused in silence; if that person addressed Milo in the last 20 seconds, they get the card or their browser runs the read. | The asker is the speaker of the latest line that addresses Milo; refuse when that line has no speaker. Test the real path. |
| B4 | `media.ts`, `audio-intake.ts`, sink route | The audio sink's only credential is a token carried in the tap's destination address, and the media server lists tap destinations to any holder of a publisher-level credential for the channel. The speaker id on a chunk comes from a request header. Listing confirmed; credential level plausible. | A participant could submit audio as another participant. Their words would be stored as that person's, and a request attributed to that person would run reads in their browser. | Require a second secret that the media server sends but never lists, refuse to arm a tap without it, and stop the media server listing destinations to participants. |
| B5 | `routes/meeting-assistant.ts` | The masquerade refusal skips reads, and only the minutes route adds its own. Confirmed. | An administrator masquerading as an attendee reads the transcript, the state and that person's turns. | Refuse a masquerade on every read of words. |
| B6 | `MeetingTurnRunner.tsx`, `orchestrator.ts` `turnsFor` | A turn is marked as run in one browser tab only, and the server hands the same confirmed write to every poller. No server claim confirmed; two tabs plausible. | A person in the call from two tabs or devices runs a confirmed write twice. The refused second result does not undo it. | The browser claims a turn on the server before running it; one claim per turn. |
| B7 | `AssistantMessageExtras.tsx` | The action card never shows the action's summary sentence, and the card replaces the message text that carried it. Confirmed. | The asker confirms on bare `key: value` lines, cut at eight, with nested values missing. | Show the summary as the card's first line; show everything that will run. |
| B8 | `MeetingAssistantBar.tsx` | A hook is called after an early return, and the return's condition changes when a call rings or ends. Confirmed. | With the flag on, the footer throws when a call rings and when it ends. The walk misses it because its stubbed call never leaves "connecting". | Move the hook above the return. |
| B9 | `orchestrator.ts` `onClosed` | When replacing a dropped session fails, the retry returns at its own guard. Confirmed. | Milo has no session and hears nothing, but is shown as listening until the ceiling. | Retry with a delay, then leave with a notice. |

## Other findings

Medium:

| # | Where | What is wrong | Fix |
|---|---|---|---|
| M1 | routes, `attendeeOf` | Anyone who ever held a seat counts as an attendee, including people who left before Milo was invited or joined after it left. | Record attendance only while Milo is present. |
| M2 | `store.ts`, `store-sql.ts` | The inviter's delete removes lines and minutes only. Request text on the record, tool arguments, card results and Milo's chat messages remain. | Blank them in the same step. |
| M3 | `retention.ts` | Only lines and minutes are swept. Records, actions and turns never expire. | Sweep all five tables by the call's age. |
| M4 | `index.ts` | The sweep starts only when the flag is on, so turning the feature off keeps stored words. | Always start it. |
| M5 | orchestrator, `spend.ts`, `audio-intake.ts` | Runs live in memory. After a restart the record says listening, the tap keeps posting audio, spend so far is never booked, and listening time keeps counting. | At start, settle and pause listening records and delete their taps. |
| M6 | `orchestrator.ts` `extend`, `meetingAssistant.ts` | Any participant who may invite can confirm past the inviter's budget on Extend. The portal offers no way to give that confirmation at all, so an invite that needs it cannot proceed. | Honour it only from the inviter; add the confirmation to the portal. |
| M7 | portal | Nothing reports the browser's media participant id. On a real call all audio is dropped as unknown while Milo shows listening and bills. | Report it on invite and on acknowledge. |
| M8 | `runCore.ts`, `MeetingTurnRunner.tsx` | Names in a write are resolved after Confirm, and a new work item lands on the initiative page in view, not the call's initiative. The card names neither. | Resolve before the card; default to the call's initiative and show it. |
| M9 | `MeetingTurnRunner.tsx`, orchestrator `tick` | The browser runs turns only while Milo is listening, and the server expires turns only for live runs. Cards confirmed while paused, and the minutes' cards, stay at "running" for ever. | Run whenever the person has a confirmed turn; expire without a live run. |
| M10 | `MeetingTurnRunner.tsx` | A failed result post, or a reload between running and posting, is never retried. A completed write then shows as expired. | Retry until the turn expires. |
| M11 | `attribution.ts` | Voicing uses one fixed loudness threshold. A noisy microphone can be credited with other people's words. Plausible. | A noise floor per participant and a loudest-wins margin. |
| M12 | `mixer.ts` | A participant's lane never re-anchors after bursts of audio and can go silent until the session is replaced. | Re-anchor when the lead passes a bound. |

Low: media ids bound per person are capped at eight and never released; the asker's own result sentence is shown on the card and fed back to the session; two simultaneous invites leave a second hold; the sink's rate limit is too low past about twenty speakers; roster and record names enter the instructions unescaped; an unexpected socket close books only the last usage report; turn expiry compares the server's time with the browser's clock; every participant polls every two seconds with no backoff; the meeting page shows "not found" for any fetch failure and allows a duplicate create; `set_status` runs with no card; one raw `span` in the card.

## What the walk does not cover

Real call phases (ringing, live, ended) with the flag on; one person in two tabs; a card confirmed after Milo left or while paused; Extend and the time-left line; the typed-request reply; an expired turn or a lost result; the flag off in a browser; the second private tool; participant binding.

Three steps assert too weakly: the create step finds the title anywhere in the work list, so it passes on a duplicate or the wrong initiative; the private answer step never checks the toast's words; the read step matches the scripted reply, not the result.

## Order of repair

1. Before any real session or call: B1 to B9, with M1 and the server half of M6 and M9. Add walk steps for B6, B7 and B8.
2. Records: M2 to M5.
3. A real call: M7, M8, M10, M11, M12, then the paid run in the design's package 6.
4. The low findings and the remaining walk gaps.

## After the repairs

Written after a second audit of the repaired code. Each blocking finding is closed by a rule that the code and a test now hold.

- B1 is closed. A reply is judged as a whole utterance against one reply context for the run, which only an answered tool call can set. Speech from people never changes it, and a later line that addresses Milo ends it.
- B2 is closed. A private read is answered outside the shared session. The session is told only that the question was answered privately, so it cannot repeat the answer.
- B3 is closed. The asker is the speaker of the latest stored line that addresses Milo, and a tool call is judged only after every line that arrived before it has been stored.
- B4 is closed on our side. The audio sink needs a second shared secret as well as the per-call token, and it refuses everything when none is configured outside the development switch. The media server's tap listing is still open (see below).
- B5 is closed. Every assistant route refuses a masquerade, reads included.
- B6 is closed. A browser claims a turn on the server before it runs it, a claim is granted once, and a result must carry the claim.
- B7 is closed. The action card opens with the summary sentence and then shows every argument the tool will receive.
- B8 is closed. The footer calls all its hooks before any early return.
- B9 is closed. A failed replacement session is retried after 1, 3 and 9 seconds, and then Milo leaves with a notice.

The four medium findings of the second audit are fixed as follows.

- A muted continuation could be posted in pieces, a public answer could be split or mislabelled, and labels could swap with two requests in flight. Output speech is now grouped into utterances (a gap of 900 ms of Milo's silence ends one), there is one reply context per run, the acknowledgement spoken while any call is open is never posted, and a context lasts 20 seconds when public and 8 when muted. This is the rule set in F1.
- A hidden browser tab stopped polling, so the asker's reads expired and confirmed writes never ran. A seated person now polls every 2 seconds, or every 5 seconds when the tab is hidden, and stops only when not seated.
- The boot reconcile paused every listening record, which with two processes on one store would stop a call the other process serves. It now touches only records whose last heartbeat, or invitation when there is none, is older than 90 seconds.
- The lost-connection and time-limit notices promised that anyone could invite Milo again, which the server refuses once the record is left. They now say Milo has left this call.

Smaller repairs in the same pass. Claiming a confirmed write now gives it at least 90 seconds from the claim, so a write confirmed in its last seconds can finish. Provider error events are kept as codes only on the session and counted in the call's state for seat holders, and the paid check prints the count. A transcript piece that the echo guard judges to be Milo's own voice is not stored and is counted.

Accepted residue. A private answer is delivered as a notification to the asker's inbox, tagged with the call id. The realtime notification service offers no operation to delete or blank a notification by id or by a payload field (it can list, mark read and deliver), so the inviter's delete and the retention sweep do not remove private answers that were already delivered. They stay in the asker's own inbox, readable only by that person.

Still open:

- The media server still lists tap destinations to a holder of a publisher-level credential for the channel. The per-call token in the address is therefore not enough on its own, which is why the second secret exists; the listing itself is not changed.
- The SQL stores have never run against a real database. Their statements are checked as text only.
- No real call has been made. One paid run on 14 November put the real provider behind the whole server chain with a simulator in place of the media server's taps, and passed (`docs/meeting-assistant-design.md`, "The paid run"). The media server's own taps, real microphones and sound in a browser are still unproven.

Closed the same night: The component-discipline check rose from 9 failing checks to 11 with this feature (three decisions asked in dialogs, one control off the table scale). They were converted the same night; the check is now part of the verification chain.

## Second sweep (14 November)

Audited at `7cde1944`, after packages 1 to 7, the repairs and the re-audit fixes. Four read-only passes, each on one slice: authority and the life of the records; the orchestrator, the live session and money; the audio path in and Milo's voice out; the portal, the walk and the documents. The one high finding and the medium findings marked "read" were checked a second time against the lines.

### Verdict

One high finding, fifteen medium, and a list of low ones. The feature stays off for real calls until the high finding and the medium findings about replies, askers and the card are repaired.

Nothing was found that stores or logs audio, exposes a key or a token, lets a person post as Milo, reads another call's record by changing an id, or runs a write without the asker's card. The parts repaired after the first audit held.

### High

- **S1. Reads about the asker alone are answered to the whole call (read).** Only two tools are treated as private. A read is classified by its tool name and not by its arguments, so reads that return one person's own things (their unread messages, their direct messages, their missed calls, their review queue) count as ordinary reads. Their results go to the shared session and are spoken and posted to everyone. Together with S2 a person who only says the name at the wrong moment can have their own things read out for someone else's question. Repair: classify by tool and arguments, so that person-scoped reads take the private path, or do not offer them in a meeting.

### Medium: replies, askers and the card

- **S2. The asker is judged when the tool call arrives, not when the request was made (read).** The model works for some seconds before its tool call reaches the server. The provider reports the moment that work began, but nothing listens for it. A person who addresses Milo in between becomes the asker, and their browser runs the read or receives the card. Repair: record the moment the work began, find the asker at that moment, and count the call as open from then.
- **S3. Real answers can be dropped or mislabelled.** While any read waits on its asker's browser (up to 90 seconds when that tab is gone), every utterance of Milo's counts as an acknowledgement and nothing is posted for anyone. A muted reply context (after a refusal, an expiry or a private answer) swallows another person's answer for 8 seconds. A public context labels another person's answer with the wrong asker. No private content is involved. Repair: limit the acknowledgement rule to the first seconds of a call, never let a muted context replace a live public one, and end a context when a different person addresses Milo.
- **S4. The card shows what was said; the record is chosen after the confirmation (read).** A write is planned in the asker's browser only after they confirm, and the resolved target is never shown. A name is matched loosely, and a position in a list is read from that browser's own last list, which need not be the list Milo read out. The write can land on a record the asker never saw named. Repair: accept only exact references for writes from a call, or plan before the card and show the resolved target on it.

### Medium: records and restarts

- **S5. A failed delete cannot be repeated.** The tombstone is written before Milo's chat messages are blanked, and a tombstone makes the next delete a 404. If the chat step fails, Milo's replies and cards stay in the chat until the retention sweep. Repair: the inviter's delete runs the chat step again on a record that is already deleted.
- **S6. A crash followed by a restart inside 90 seconds is never reconciled.** The check at boot skips fresh heartbeats and runs once. The record stays listening with nothing listening, the tap keeps posting, and the used minutes are never booked; a later dismiss or call end finds no run and settles nothing. Repair: run the check again on a timer, and settle in the dismiss and call-end paths when there is no run.
- **S7. Listening and paused records are exempt from retention with no time bound.** Only a dismiss, a seen call end or a later boot ends them, and the call-end listener does nothing while the flag is off. A call that outlives the restart that turned the feature off keeps its words past the retention period. Repair: the sweep ends any such record whose heartbeat is older than the hard maximum plus a margin.
- **S8. The retention sweep fails silently after one log line.** With the SQL statements unproven against a database, stored words could outlive the period with no signal. Repair: log again when the message changes or once a day, and expose the time of the last good sweep.

### Medium: audio and voice

- **S9. Attribution favours a loud microphone and sparse noise (needs a test).** A line's speaker is ranked by raw level times time over a widened window. A much louder neighbour, or key clicks joined into one voiced stretch, can outrank the real speaker of a short line, and a request is then judged as the other person's. Repair: weigh by voiced time, normalise the level for each participant, and require the first-ranked speaker to cover most of the line's own span.
- **S10. The echo guard's window is shorter than the delays in front of it (needs a test).** The guard ends half a second after the last relayed frame and wants the line wholly inside it. Playout, the jitter buffer and the stamping lag can put the end of an echo after that, and the last piece is then stored under whoever's microphone caught it. Repair: a tail of about a second and a half, judged by overlap.
- **S11. Deleting a tap is one attempt that is not recorded.** A failed delete is forgotten, so the tap keeps posting after a pause or a dismiss until the call ends or the next boot (the sink refuses it unread). The detach is also skipped when the ceiling is reached during a replacement. Repair: retry failed deletes, and detach in the stop path whatever happened before.
- **S12. Nothing arms again after the one-minute give-up.** If no audio producer appears within a minute, the chat says Milo cannot hear the call yet and nothing retries; the paid session stays open on silence until someone pauses and resumes. Repair: a slow retry while listening, or pause and release the hold.

### Medium: portal, documents and the paid script

- **S13. Meetings is in the navigation with the flag off.** The nav entry, the palette row and the routes do not read what the session advertises, and the list answers 404 when the feature is off, so a default install has an entry that opens an error. Repair: hide them unless the feature is advertised.
- **S14. The real-call recipe left out the switch that makes it real.** In the mock world, without `MEETING_ASSISTANT_LIVE=1`, the session is scripted and no tap is armed: Milo is invited, hears nothing and reports no error. Fixed in `docs/next-steps.md` with this write-up.
- **S15. The paid script's stop lived only in the script.** No signal handlers and no ceiling on the server side: stopping the script alone left its middleware and the real session running to the default ceiling. Its stop also waited on calls with no time limit and reported a dismissal it had not checked. Being repaired with the scenario suite (a short server ceiling, a dead-man timer in the child, signal handlers, a time-boxed dismiss).

- **S16. The minutes notice ends in a path as plain text.** The closing notice names the meeting page by its path, which nobody can click. Repair: carry it as a page reference the chat renders as a link.

### Low

- **Money.** The stop path has no guard, so a store error can skip the settlement, and a failed settlement is never retried. A close that times out books less than the wall clock. The hold can expire during a long pause, and delegation tokens are booked but never held. Two extensions at once can lose a hold.
- **Session.** The provider's message text is logged up to 200 characters although the session keeps codes only for that reason. A pause posts the half sentence in flight, and a read cut by a pause uses the wrong words. A speaker's name reaches the model's context uncleaned. One tick loop has no guard for each run. A place name that begins with the assistant's name counts as an address at the start of a sentence.
- **Records.** Open cards stay open after a delete, so a late result can write onto a blanked card. The Meetings list uses a JSON operator the data API may read as a placeholder. A record can stick in the invited state. A duplicate line arriving twice at once throws on the SQL store where the memory store returns nothing. Every poll writes attendance. The purge depends on the chat step. Two comments are stale.
- **Audio and voice.** One late voice frame drops the rest of the utterance. The frame counter restarts with the run, so open browsers ignore frames after a restart. Frames queue while the browser's audio is suspended. The mixer's catch-up after a stall is unbounded. One lane per person garbles two devices, and lanes are never released. Other browsers learn the voice switch by the poll. Bindings outlive a call that ends without a dismiss. Two functions have no callers. With the mock world and a real media server configured together, the test-only route can return a real call's sink token.
- **Portal.** The card's initiative line shows on every create. A write confirmed late is done but its result is dropped, because the claim does not return the new expiry. Poll loops can stack on a visibility change, and executor requests have no time limit. The bar is an empty ruled slot for someone who cannot invite. The notice says 30 days in fixed text though retention is a setting.
- **Documents.** The plan says the journey shows the ceiling warning and that a validator script exists; neither does. Its restart risk and its portal flag in decision 13 do not match the code.

### The walk

Five steps prove less than their titles: the second-tab step never has a second runner; the meetings-row step matches the empty-table message too; the work-item step is satisfied by a link label; the minutes-link step is a substring check; the invite step makes the inviter's name optional. Two voice steps prove the server sent nothing, not that the browser stopped.

No step at all: a turn run in a hidden tab; a reload during a turn; an expired or failed card; the time-left mark; Milo's chat messages after a delete; the media-id report; the flag off.

### Order of repair

1. S1 to S4, with scenario runs as the proof.
2. S5 to S8 and the money lows.
3. S9 to S12, measured by the crosstalk, loud-neighbour and echo scenarios.
4. S13 and S16, the portal lows, and the weak walk steps.
5. The documents.

A scenario suite for the paid simulator is being built alongside: twelve scripted calls against the real provider (personal and private reads, two askers, ten quiet minutes, crosstalk, a loud neighbour, echo, forms of address, a late joiner, pause and dismiss, confirm and decline, a dropped connection). Its results will be recorded in `docs/meeting-assistant-design.md`.

## Third sweep (14 and 15 November): the experience

Audited at `50bc577a`, after the second sweep's repairs and the consent workflow. Three read-only passes, each from a person's seat and not from the code's: the middle of a call; the consent workflow from the seat of the asker, a named person, the executor, a bystander, a late joiner and someone who was not there; and everything around the call (bringing Milo in, each way it can fail, the call ending, the meeting record afterwards). Every finding was checked against the lines; a few are marked as inferred in the working notes.

### Verdict

44 findings: 15 in the call, 15 in the consent workflow, 14 around it. None stores or exposes anything it should not. They are the kind of defect a walk with fixed strings does not see: a state with no sign, a message that blames the wrong person, a dead end, a control that does more than its label says.

### What was found and repaired

**Milo's state was not always visible.** Nothing said Milo was working on a request; the bar read "listening" while Milo was still joining or could not hear; an error stayed on the bar for the rest of the call; whether Milo's voice was on could only be seen inside a menu; the bar offered "Invite" for a moment after a reload. Repaired: the bar says who Milo is working for, "joining", "connecting" or "cannot hear the call"; errors clear when the state changes or after 20 seconds; a chip shows the voice state; the mute is kept per call; nothing is drawn until the first state read. A late joiner finds who invited Milo, whether its voice is on and who can pause it in the bar's menu (the chat's history floor was left as it is).

**One click removed Milo for everyone, for good.** Dismiss sat next to "I understand" with no confirmation, and a dismissed Milo cannot rejoin. Repaired: the control reads "Dismiss Milo for everyone" and asks once, naming the effect; afterwards the bar says who dismissed it, or that it reached its time limit or lost its connection, and that it cannot rejoin this call.

**Spoken commands and endings were silent or blamed the asker.** A spoken "pause" or "leave" changed the state with no chat line and skipped the steps the button takes; a request cut short when Milo left got no reply, and its card said the asker "did not confirm in time". Repaired: the spoken path and the button share one function; a request cut short says why (left, dismissed, time limit, lost connection, restarted). The walk then caught a real defect: after a spoken pause, the next answer was labelled for the person who said "pause". Fixed.

**Messages read like machine output.** Refusals showed setting names, file names and state names, said "the assistant", and did not say whether to try again. Repaired: plain sentences with a next step; the detail goes to the server log; status codes and machine fields are unchanged. A permission refusal is told to the asker privately, not to the call under their name.

**Limits were announced only when they hit.** Repaired: the join notice states the time limit and that a dismissal is final; the five-minute warning names who can extend, or says the call cannot be extended further; a warning comes when five requests are left. The two disclosures no longer contradict each other.

**Consent: dead ends and accidents.** The executor was told to "consent again" and never offered it; the run could start in the executor's browser on someone else's click; one keypress by anyone ended a proposal for good; a new proposal moved keyboard focus onto Consent; one objector could hold a proposal with no way out; the card showed a tool name, not what would be written; nobody could tell a proposal Milo raised from one a person asked for. Repaired:
- The executor's own click is the last step. They are offered "Run it now"; if nobody who consented can run it, people who have not answered are asked.
- A proposal arriving never takes focus (library 2.528.0), and digits act only inside the prompt.
- "Not a decision" is offered only on proposals Milo raised; on an asked one only the asker can drop it; both have Undo.
- An objected proposal says what clears it, names every objector and can be raised again.
- The card says in plain words what will be written, whether it will be recorded as decided or as waiting, who asked or that Milo heard it, and when it expires. The lines Milo heard are shown only to people who were in the call; the server enforces that.
- The footer count shows only what waits on the viewer. The asker and the executor are told when a proposal ends or is handed back.

**After the call there was nothing to find.** Minutes went into a chat nobody could open, with no notification; a failed minutes write was final and the page then said nothing was decided; the list stopped at 25 meetings; a deleted record read as "you were not in that call"; the page said neither how long the record is kept nor what Milo covered. Repaired: one bell notification per attendee when minutes are ready, with nothing from the meeting in it; a failed write is tried again (three times by the sweep, five by an attendee's press, enforced in the store); the list loads older meetings; an attendee is told a record was deleted or expired, and everyone else gets a neutral sentence; the page says "Kept until", who can delete it sooner, how long Milo listened and how many people were not transcribed (a count, never names).

**Deleting a record filled the chat with one sentence per message** (reported by the owner). Repaired: the sentence appears once per call as a plain line, and Milo's other messages and cards are removed from view.

### Redesigned in the same run

- **The chat cards.** One compact layout for action, proposal and minutes cards: what it is and its status on one row, a one-line title, one plain line of what will happen, faces for the people, then the actions and the expiry. A card that waits on the viewer is toned; a finished, declined, expired or dropped one is a single row that can be opened. Raw `key: value` rows are gone (every field Milo will send stays readable behind "Details", as the first audit requires), the line "I have asked … to confirm" is no longer posted beside the card that says it, and the join notice is a block, not a paragraph in a pill.
- **The meeting page and the Meetings list.** Delete moved into a menu; "Needs you" comes first when something waits on the viewer; the summary is a lead sentence and up to four bullets, never a retelling by speaker; decisions, action items and proposals are tables with portraits; a proposal opens in a drawer; the transcript is collapsed. The list shows length, people and outcomes.
- **The call block** (library 2.529.0). Everyone in the call has a tile side by side, with "+N" only past what fits, and the recording notice is an indicator with a tooltip on the meta line instead of a banner on its own line.

### Second pass (15 November)

Four of the items first listed as open were closed in the same run:

- **The proposal cap.** When Milo has raised its eighth proposal in a call it says so once, and that people can still ask it to record a decision. The count is read from the stored proposals, so a restart neither repeats nor loses the notice.
- **An action item made into a work item from the meeting page.** The button now goes through the meeting's own route, which keeps the plain path's permission checks, creates the work item and records its id on the action item; the page then reads "Work item created" with a link the server builds.
- **"Click to hear Milo".** It shows as soon as Milo's voice is on and the browser still needs a click, before any reply is lost.
- **The prompt over the last rows.** The page could already be scrolled clear of the docked prompt. The real defect was different: hidden labels in the proposals table made the whole document taller than the screen, so scrolling past the end slid the header, prompt and footer off the screen. The shell no longer lets the document scroll.

### Fourth pass (15 November): the three items left from the real-provider runs

Built the same day, each in its own lane, then reviewed as one change before merging:

- **Milo's voice only for speech someone asked for.** A gate in front of the relay decides each speaking turn: it goes out at once when someone addressed Milo in the last 10 seconds or Milo has addressed work in flight; otherwise it is held for at most 2 seconds and then released whole or withheld whole. The quiet scenario now makes two unprompted remarks and both are withheld, while the answer to the final request is voiced, including when its audio arrives before the request's words.
- **A live transcript in the call.** "Show transcript" in Milo's menu turns the call's pane into what Milo is hearing, following the newest line. `TranscriptPanel` gained `follow` and portraits for it (ui-components 2.530.0).
- **Inviting Milo back.** A call can have several listening periods on one record; everyone acknowledges again, each period is billed on its own, and the minutes are added to when Milo leaves again, with earlier items kept in place.

A review of the combined change found five defects, all repaired before the merge, each with a test that fails without its repair: inviting Milo back while it was still leaving billed the earlier period twice and left Milo shown as listening with no session (the invitation now waits for the departure, and a late departure cannot touch the newer period); the gate cut long spoken answers between sentences and could drop a held opening sentence early (decisions now cover a speaking turn); a minutes addition's cost was never booked (every minutes run has its own ledger entry); a delete racing an invitation back could leave a deleted meeting listening (both stores now refuse either order); and a call ending during an invitation back could leave Milo listening to nothing (it now leaves with the call). Two smaller ones were repaired with them: released audio is counted as heard when it plays, and the live transcript reads once more after every leave.

### Fifth pass (16 November): a sweep of the experience after the rename

Three auditors walked the call, the pages around it, and consent and the invitation back, at 1280 and 1440, and reported 41 findings, 35 of them distinct. 33 were repaired in three lanes and checked together before the merge; the other two were decided as they are (below: text stored before the rename, and people from a later listening period reading the whole record).

- **In the call.** Change cards say the change from the request itself ("Set "Runbook" to cancelled"), not the catalogue's sample sentence. Transcript times stay on the call's own timeline, counted from Milo's first invitation, live and on the meeting page. Milo is heard from its first word: browsers keep up to a second of early voice frames, and the speaking mark lasts until playback ends. The voice gate uses the chat's 20-second window (one constant). Typed requests follow the spoken address rule and are answered once per listening stretch ("Milo only hears spoken requests"; "Milo is paused…" once per pause). The voice chip reads "Milo's voice on" / "Milo muted for you". The live transcript's header agrees with the footer, shows read errors, and ends with an "Acknowledge" link for someone who has not. A seated person whose first name is heard as Milo is named in the join notice.
- **Around the call.** A retried minutes addition keeps what was said in the later period. "Not transcribed" counts only people who never acknowledged in any period. The summary's lines about proposals are built when the page is read, so one agreed after the call no longer reads as waiting. Under Budgets, Milo's charges read as what it did ("Milo listening, period 2", "Milo minutes, addition 1, try 2") with the call's name. The Updated card quotes the addition's own sentence and counts only new items; a repeated action item is not added twice. The page says "will try again" only while the sweep will, follows Milo's leave without a reload (for at most five minutes), names every inviter and everyone who can delete sooner, and shows portraits for everyone a proposal names. Delete is not offered while Milo is back in the call. The bell reads "Minutes are ready: <meeting>".
- **Consent and the invitation back.** Open proposals stay answerable in the footer for the whole call, with or without Milo; a card for a call the person is not in links to the meeting page. The request and proposal caps count per listening period, and their notices can be said again in a later one. An invitation back needs at least five minutes of the call's listening time left; otherwise it is refused, and the dismiss question no longer promises one. After Milo leaves, the footer keeps one control, "Invite Milo again", with why it left as its tooltip ("Milo is leaving…" while the leave finishes); people who cannot bring it back see one quiet chip. The footer stays on one line, and the call's name ends in an ellipsis. The invited-back notices say "once more" only to people who acknowledged before and say the voice is off. "Extend time" says how many minutes it adds and whose budget holds them, and is not offered at the maximum. The over-budget ask names the hold, the minutes and the overage.

### Decided

- Milo can be invited back into a call it left (fourth pass, above). Until then it could not.
- The chat's history floor stays: a late joiner does not get Milo's earlier answers.
- A tombstone tells only attendees that a record was deleted or expired. Once the sweep has removed the call, nobody can be told apart, so everyone gets the neutral sentence.
- The minutes page counts the people who were not transcribed and does not name them.
- Evidence lines are for people who were in the call. A named person who was not sees the statement and who raised it.
- People who were only in a later listening period can read and delete the whole record, like everyone else in it (fifth pass).
- Text stored before the rename keeps "Nova"; it is not rewritten.
- A seated person named Milo or Mylo is named in the join notice and nothing else changes: "Milo, …" said to them still counts as a request.
- Typed messages follow the spoken address rule. A request typed while Milo is joining is ignored silently.
- Caps (60 requests, 8 proposals) count per listening period; the record keeps the whole call's total.

### Still open

- "Paused for" on the meeting page is all the time Milo was in the call and not listening; pauses are not tracked on their own.
- A finished action row has no link to what it created; the card carries no link the browser can trust.
- Covered by unit tests only, because the walk cannot produce them: the "working for" mark (a lookup finishes too fast to catch), the failed-minutes path (the scripted writer cannot fail), a work item made from an action item on the meeting page (the walk's meeting has none left to make), and the "Click to hear Milo" prompt (headless Chromium does not block sound).
- The meeting page's "Create work item" now makes a story at once, titled with the action item's text; the earlier path opened the initiative's form first. Two presses at the same moment on two servers could make two work items, of which one is recorded.
- The meeting page is not in the DOM geometry audit's route list.
- From the real-provider runs: the voice gate (fourth pass) is proven on the fake provider; a short paid run to prove it on the real provider (`scenarios.mjs --scenario quiet-long,personal-read --minutes 2 --yes`, worst case $0.27) could not start on 15 November because the provider rejected the API key, so it is not yet proven there; the two-askers case was relaxed and not re-run against the provider; the echo guard is unproven on a long call; the attribution fix has not yet been seen on a live call.
- Covered by unit tests only (fifth pass): several inviters on one meeting (the walk's script has one inviter per period), the "Milo is leaving…" wait, the over-budget ask's wording, "Extend time" hidden at the maximum, and the retry wording after the sweep stops.
- Proposal bells still say "the <call> call"; the minutes bell names the meeting after a colon.
- The library's call bar passes `truncate` as a class to `T`, which draws a flex box where an ellipsis never shows; the footer forces the name to a block until the library is fixed.
