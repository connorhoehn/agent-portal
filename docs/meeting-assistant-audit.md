# Meeting assistant: audit

13 November 2026. Audited at `eb6cff56`, after packages 1 to 6a (`docs/meeting-assistant-design.md`).

## Verdict

The feature must not be turned on for a real call yet. Nine defects are serious enough to block that: four can show one person's words or data to others, two can attribute or run an action wrongly, and three break the feature in normal use. None has touched real data. The flag is off by default, and the product code has only run on the mock world.

The parts built to be strict held up: nobody can post as Nova, turns and cards belong to the asker, nothing is stored or mixed before a person acknowledges, the test-only routes cannot be reached outside the mock world, and every tool call is answered exactly once.

## Scope and method

Three read-only passes over the meeting assistant's code, each on one slice: server authority and privacy; the orchestrator, session, audio and money; the portal and the walk. The nine blocking findings were then checked again against the code by a second reading. "Confirmed" means the defect is visible in the code. "Plausible" means the defect is in the code but its precondition was not proven.

Not audited: `platform-api` and the media server beyond the tap listing and the join id, the component library changes, the SQL stores against a real database, and the provider's real behaviour. Findings name the weakness and its effect, not a way to use it.

## Blocking findings

| # | Where | What is wrong | Effect | Fix |
|---|---|---|---|---|
| B1 | `orchestrator.ts` `onInput`, `onOutput` | Who a reply belongs to, and whether it is private, is one slot per call, and every new piece of speech resets it. Confirmed. | If anyone speaks between a private question (a budget) and the answer, the answer is posted to the whole call. The same slot can label a reply with the wrong asker. | Bind the reply to its tool call or turn, not to the call. |
| B2 | `orchestrator.ts` `submitResult` | A private tool result is given to the one session everybody shares. Confirmed. | Nothing stops the model repeating it later in a public answer to another person. | Answer private reads outside the shared session; tell the session only that it was answered privately. |
| B3 | `orchestrator.ts` `recentAsker` | On the real session the asker is the latest speaker, not the person who addressed Nova. Dropped request confirmed; wrong person plausible. | If someone else speaks before the tool call arrives, the request is refused in silence; if that person addressed Nova in the last 20 seconds, they get the card or their browser runs the read. | The asker is the speaker of the latest line that addresses Nova; refuse when that line has no speaker. Test the real path. |
| B4 | `media.ts`, `audio-intake.ts`, sink route | The audio sink's only credential is a token carried in the tap's destination address, and the media server lists tap destinations to any holder of a publisher-level credential for the channel. The speaker id on a chunk comes from a request header. Listing confirmed; credential level plausible. | A participant could submit audio as another participant. Their words would be stored as that person's, and a request attributed to that person would run reads in their browser. | Require a second secret that the media server sends but never lists, refuse to arm a tap without it, and stop the media server listing destinations to participants. |
| B5 | `routes/meeting-assistant.ts` | The masquerade refusal skips reads, and only the minutes route adds its own. Confirmed. | An administrator masquerading as an attendee reads the transcript, the state and that person's turns. | Refuse a masquerade on every read of words. |
| B6 | `MeetingTurnRunner.tsx`, `orchestrator.ts` `turnsFor` | A turn is marked as run in one browser tab only, and the server hands the same confirmed write to every poller. No server claim confirmed; two tabs plausible. | A person in the call from two tabs or devices runs a confirmed write twice. The refused second result does not undo it. | The browser claims a turn on the server before running it; one claim per turn. |
| B7 | `AssistantMessageExtras.tsx` | The action card never shows the action's summary sentence, and the card replaces the message text that carried it. Confirmed. | The asker confirms on bare `key: value` lines, cut at eight, with nested values missing. | Show the summary as the card's first line; show everything that will run. |
| B8 | `MeetingAssistantBar.tsx` | A hook is called after an early return, and the return's condition changes when a call rings or ends. Confirmed. | With the flag on, the footer throws when a call rings and when it ends. The walk misses it because its stubbed call never leaves "connecting". | Move the hook above the return. |
| B9 | `orchestrator.ts` `onClosed` | When replacing a dropped session fails, the retry returns at its own guard. Confirmed. | Nova has no session and hears nothing, but is shown as listening until the ceiling. | Retry with a delay, then leave with a notice. |

## Other findings

Medium:

| # | Where | What is wrong | Fix |
|---|---|---|---|
| M1 | routes, `attendeeOf` | Anyone who ever held a seat counts as an attendee, including people who left before Nova was invited or joined after it left. | Record attendance only while Nova is present. |
| M2 | `store.ts`, `store-sql.ts` | The inviter's delete removes lines and minutes only. Request text on the record, tool arguments, card results and Nova's chat messages remain. | Blank them in the same step. |
| M3 | `retention.ts` | Only lines and minutes are swept. Records, actions and turns never expire. | Sweep all five tables by the call's age. |
| M4 | `index.ts` | The sweep starts only when the flag is on, so turning the feature off keeps stored words. | Always start it. |
| M5 | orchestrator, `spend.ts`, `audio-intake.ts` | Runs live in memory. After a restart the record says listening, the tap keeps posting audio, spend so far is never booked, and listening time keeps counting. | At start, settle and pause listening records and delete their taps. |
| M6 | `orchestrator.ts` `extend`, `meetingAssistant.ts` | Any participant who may invite can confirm past the inviter's budget on Extend. The portal offers no way to give that confirmation at all, so an invite that needs it cannot proceed. | Honour it only from the inviter; add the confirmation to the portal. |
| M7 | portal | Nothing reports the browser's media participant id. On a real call all audio is dropped as unknown while Nova shows listening and bills. | Report it on invite and on acknowledge. |
| M8 | `runCore.ts`, `MeetingTurnRunner.tsx` | Names in a write are resolved after Confirm, and a new work item lands on the initiative page in view, not the call's initiative. The card names neither. | Resolve before the card; default to the call's initiative and show it. |
| M9 | `MeetingTurnRunner.tsx`, orchestrator `tick` | The browser runs turns only while Nova is listening, and the server expires turns only for live runs. Cards confirmed while paused, and the minutes' cards, stay at "running" for ever. | Run whenever the person has a confirmed turn; expire without a live run. |
| M10 | `MeetingTurnRunner.tsx` | A failed result post, or a reload between running and posting, is never retried. A completed write then shows as expired. | Retry until the turn expires. |
| M11 | `attribution.ts` | Voicing uses one fixed loudness threshold. A noisy microphone can be credited with other people's words. Plausible. | A noise floor per participant and a loudest-wins margin. |
| M12 | `mixer.ts` | A participant's lane never re-anchors after bursts of audio and can go silent until the session is replaced. | Re-anchor when the lead passes a bound. |

Low: media ids bound per person are capped at eight and never released; the asker's own result sentence is shown on the card and fed back to the session; two simultaneous invites leave a second hold; the sink's rate limit is too low past about twenty speakers; roster and record names enter the instructions unescaped; an unexpected socket close books only the last usage report; turn expiry compares the server's time with the browser's clock; every participant polls every two seconds with no backoff; the meeting page shows "not found" for any fetch failure and allows a duplicate create; `set_status` runs with no card; one raw `span` in the card.

## What the walk does not cover

Real call phases (ringing, live, ended) with the flag on; one person in two tabs; a card confirmed after Nova left or while paused; Extend and the time-left line; the typed-request reply; an expired turn or a lost result; the flag off in a browser; the second private tool; participant binding.

Three steps assert too weakly: the create step finds the title anywhere in the work list, so it passes on a duplicate or the wrong initiative; the private answer step never checks the toast's words; the read step matches the scripted reply, not the result.

## Order of repair

1. Before any real session or call: B1 to B9, with M1 and the server half of M6 and M9. Add walk steps for B6, B7 and B8.
2. Records: M2 to M5.
3. A real call: M7, M8, M10, M11, M12, then the paid run in the design's package 6.
4. The low findings and the remaining walk gaps.

## After the repairs

Written after a second audit of the repaired code. Each blocking finding is closed by a rule that the code and a test now hold.

- B1 is closed. A reply is judged as a whole utterance against one reply context for the run, which only an answered tool call can set. Speech from people never changes it, and a later line that addresses Nova ends it.
- B2 is closed. A private read is answered outside the shared session. The session is told only that the question was answered privately, so it cannot repeat the answer.
- B3 is closed. The asker is the speaker of the latest stored line that addresses Nova, and a tool call is judged only after every line that arrived before it has been stored.
- B4 is closed on our side. The audio sink needs a second shared secret as well as the per-call token, and it refuses everything when none is configured outside the development switch. The media server's tap listing is still open (see below).
- B5 is closed. Every assistant route refuses a masquerade, reads included.
- B6 is closed. A browser claims a turn on the server before it runs it, a claim is granted once, and a result must carry the claim.
- B7 is closed. The action card opens with the summary sentence and then shows every argument the tool will receive.
- B8 is closed. The footer calls all its hooks before any early return.
- B9 is closed. A failed replacement session is retried after 1, 3 and 9 seconds, and then Nova leaves with a notice.

The four medium findings of the second audit are fixed as follows.

- A muted continuation could be posted in pieces, a public answer could be split or mislabelled, and labels could swap with two requests in flight. Output speech is now grouped into utterances (a gap of 900 ms of Nova's silence ends one), there is one reply context per run, the acknowledgement spoken while any call is open is never posted, and a context lasts 20 seconds when public and 8 when muted. This is the rule set in F1.
- A hidden browser tab stopped polling, so the asker's reads expired and confirmed writes never ran. A seated person now polls every 2 seconds, or every 5 seconds when the tab is hidden, and stops only when not seated.
- The boot reconcile paused every listening record, which with two processes on one store would stop a call the other process serves. It now touches only records whose last heartbeat, or invitation when there is none, is older than 90 seconds.
- The lost-connection and time-limit notices promised that anyone could invite Nova again, which the server refuses once the record is left. They now say Nova has left this call.

Smaller repairs in the same pass. Claiming a confirmed write now gives it at least 90 seconds from the claim, so a write confirmed in its last seconds can finish. Provider error events are kept as codes only on the session and counted in the call's state for seat holders, and the paid check prints the count. A transcript piece that the echo guard judges to be Nova's own voice is not stored and is counted.

Accepted residue. A private answer is delivered as a notification to the asker's inbox, tagged with the call id. The realtime notification service offers no operation to delete or blank a notification by id or by a payload field (it can list, mark read and deliver), so the inviter's delete and the retention sweep do not remove private answers that were already delivered. They stay in the asker's own inbox, readable only by that person.

Still open:

- The media server still lists tap destinations to a holder of a publisher-level credential for the channel. The per-call token in the address is therefore not enough on its own, which is why the second secret exists; the listing itself is not changed.
- The SQL stores have never run against a real database. Their statements are checked as text only.
- No real call has been made. The product code has run only on the mock world and against a fake provider.
