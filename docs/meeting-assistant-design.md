# Meeting assistant: design and plan

13 November 2026. Status: plan accepted, nothing built.

## What this is

An assistant, shown as **Nova**, that a person in a call can invite. It hears everyone in the call, knows who said what, answers in the call chat when someone addresses it by name, offers actions to the person who asked, and leaves minutes behind. It reuses the voice navigator's tool catalogue and the media stack's caption path.

The reference product is Claude Meetings (beta, November 2026): a visible participant in a video call that keeps a live transcript, replies in the call chat when addressed by name, acts through each person's own tools with per-request confirmation, and leaves a meeting page with notes, action items and the transcript.

## What already exists

Evidence is from a read of the five repositories on 13 November. Paths are relative to each repository.

| Need | Existing piece | State |
|---|---|---|
| Hear each speaker separately | Media server per-participant audio taps (`live-video-streaming` `src/taps/TapManager.js`) | Built |
| Turn speech into text per speaker | `live-video-streaming` `services/live-captions`: faster-whisper, publishes to Redis `captions:<channelArn>` | Built; not in this app's local stack |
| Arm the tap for a call | `platform-api` `src/recordings/liveCaptions.ts`, toggle `POST /api/video/captions` | Built |
| Deliver captions to browsers | Gateway caption relay; `useLiveCaptions` in `realtime-modules`; `TranscriptOverlay` in `ui-components` | Built; the portal uses none of it |
| Tell people they are transcribed | `RecordingConsentNotice` (`kind: 'transcription'`) in `ui-components` | Built; the portal has not adopted it |
| A tool catalogue with per-role filtering and confirm cards | Voice navigator (`middleware/src/lib/voice/catalogue.ts`, `portal/src/lib/voice/tools.ts`) | Built for one person and one microphone |
| A chat beside the call | `orgiq:huddle:<callId>` (`middleware/src/lib/call-chat.ts`) | Built; refuses anyone without a seat |
| A card with approve and reject in chat | `AgentRunCard` in `ui-components` | Built for agent runs |
| After-call record | Room activity and the recording transcript pipeline in `platform-api` | Built for recorded calls only |

## What is missing

1. The local social stack runs no captions service, so no captions are produced on a developer machine.
2. Nothing consumes captions on the server. The only consumer counts lines.
3. A caption names a per-join participant id, not a person. The join record that maps it to a user is in `platform-api`.
4. No non-human author can post in the call chat.
5. The voice tools run for the one person holding the tab. There is no "the person who asked" in a call.
6. Nothing stores words. The voice log deliberately keeps none, and live captions are thrown away.
7. No per-call budget, no spend source for this consumer, no invite or consent flow.

## Spike result (13 November)

Simulated speech from three speakers was fed to the captions service at real-time pace on a developer Mac.

| Model | Delay after speech ends (median / worst) | Name heard | Notes |
|---|---|---|---|
| `base` | 0.8 s / 0.9 s | 9 of 9 | Misheard a person's name and a technical word |
| `small.en` | 1.45 s / 2.4 s | 9 of 9 | Fewer word errors; queues behind overlapping speakers |

Findings that shape the design:

- Captions are final only. A window is cut after 3 s of audio or 0.6 s of silence.
- The 3 s cut is blind. It splits a long request across captions and sometimes cuts a word in half. Leftover slivers produce junk captions such as "Thank you."
- The speaker id was right on every caption.
- Not measured: real microphones, noise, accents, more than three speakers, other settings.

Verdict: good enough for name-triggered requests if the assistant stitches a speaker's consecutive captions into one request and lets the model repair mishearings from context. The blind cut should be fixed in the captions service as its own package.

## Decisions

1. **Listening is server-side and local.** Captions come from the media server's taps and the local Whisper service. Listening to a whole meeting costs no model spend. The reasoning model is called only when the assistant is addressed, and once at the end for minutes.
2. **The assistant is not a media participant in the first version.** It is shown in the call's roster and bar from its server state, and it writes in the call chat. A real participant that speaks is a later phase.
3. **It answers in the call chat, never aloud, in the first version.** This matches the reference product and avoids talking over people.
4. **It is addressed by name.** Spoken: a caption containing "Nova" starts a request; the same speaker's following captions are stitched on until that speaker pauses for 1.5 s or another caption from them does not arrive within 4 s. Typed: a call chat message that mentions Nova. It never interjects unprompted.
5. **Every action runs in the asking person's own browser with their own permissions.** The server never acts as a person. Reads run without a confirmation, as the voice navigator's do. Writes appear as a card in the call chat addressed to the asker, and only the asker's click runs it. A spoken "yes" confirms nothing, because any voice could say it.
6. **Asking in the call is choosing to share the answer with the call.** The answer is posted to everyone, labelled with who asked. Tools about one person's private standing (budget, access request status) answer only to the asker.
7. **The tool list is the asker's.** It is the voice catalogue filtered to the asker's tenant and role at the moment of the request.
8. **Consent is explicit and visible.** Inviting the assistant posts a notice in the chat, shows the transcription notice to every participant, and marks the call bar. Anyone in the call can pause listening or dismiss the assistant. Joining a call where it is already listening shows the notice before the person's first caption is stored.
9. **Words are stored, audio is not.** Transcript lines are kept 30 days by default, readable only by people who were in the call. The voice log's no-words rule does not change.
10. **Spend.** A request reserves against the asker's budget; minutes reserve against the inviter's. A call on an initiative attributes both to that initiative. A new spend source, `meeting_assistant`, is added to both schema checks. Each call has a ceiling on requests and on spend.
11. **Model.** The reasoning call uses the provider the voice navigator already uses, through a server-side call with the same strict tool definitions, behind one interface so an AWS-native model can replace it. The key stays in the gitignored environment file.
12. **Mock first.** The default mock world gets a caption injector and a deterministic model, so every behaviour is walked headlessly without media, a microphone or a model call.
13. **Off by default.** One server flag and one portal flag. A new policy action, `InviteMeetingAssistant`, decides who may invite.
14. **Outside guests.** Calls in this product have no guests today. If a lobby type later admits them, the assistant leaves when one joins.

## Architecture

```
speakers ─► media server taps ─► captions service ─► Redis captions:<arn>
                                                        │
                    platform-api join record ──► caption intake (middleware)
                                                        │  attributed lines
                              ┌─────────────────────────┼──────────────────────┐
                              ▼                         ▼                      ▼
                       transcript store          request detector        assistant state
                       (30 days, no audio)              │                (invited, listening,
                              │                         ▼                 paused, left)
                              │                  reasoning call ◄── asker's tool list
                              │                         │ tool calls
                              │                         ▼
                              │            turn exchange with the asker's browser
                              │            (reads run; writes wait on a card)
                              ▼                         ▼
                        minutes at end ─────────► call chat as Nova ─► everyone in the call
```

New middleware module `lib/meeting-assistant/`:

- `intake`: a caption source interface with two implementations, the mock injector and a Redis subscriber that resolves the per-join id to a user through `platform-api`.
- `store`: assistant state per call and transcript lines, behind the existing store selection (mock and SQL).
- `detector`: name matching, stitching, junk filtering, cancel words ("Nova, never mind").
- `brain`: builds the prompt from the last minutes of transcript, the roster and the call's record; calls the model; returns text and tool calls.
- `turns`: the exchange with the asker's browser. The server posts a turn; the browser runs read tools and returns results; write tools become cards.
- `chat`: posts as the assistant into the call chat through a server-side path that does not need a seat.
- `minutes`: at the end, produces notes, decisions and action items, each action item offered as a card to its owner.

Routes, all under `/api/calls/:callId/assistant`: invite, pause, resume, dismiss, state, turn results, card decision, transcript, minutes.

## Packages

Each package is one branch, verified by the full chain, merged on its own.

| # | Package | Repositories | Size |
|---|---|---|---|
| 1 | Core: flag, policy action, state and transcript stores, mock caption injector, invite/pause/dismiss routes, detector with tests from the spike's captions | this one | Medium |
| 2 | The assistant in chat: server-side post as Nova, join and state notices, message and action card kinds | this one, `ui-components` | Medium |
| 3 | Call UI: Invite Nova, roster entry, listening mark, transcription notice, pause and dismiss, live caption overlay for people | this one | Medium |
| 4 | Brain and turns: reasoning interface with the deterministic mock, prompt, turn exchange, read tools in the asker's browser, write cards, typed mentions, spend source and per-call ceilings | this one | Large |
| 5 | Minutes: end-of-call notes and action items, the meeting page, the call log entry, search over past meetings | this one | Medium |
| 6 | Real path: captions service in the local social stack, arming the tap on invite, the join-record lookup, the real model call | this one, `platform-api` | Medium |
| 7 | Captions quality: cut windows at a quiet point instead of blindly, drop slivers, try a 5 s window | `live-video-streaming` | Small |
| 8 | Later: a real participant that speaks, joining scheduled rooms on its own, minutes from the recorded transcript when a call was recorded | several | Large |

Packages 1 to 5 run entirely on the mock world. Package 6 needs the social stack and two real people, or a second headless browser with a fake audio file, on its own ports.

Order: 1, then 2 and 3 in parallel, then 4, then 5; 7 can run at any time; 6 last.

## How it is judged

- A journey, `meeting-assistant`, on the default mock world at 1440 and 1280: invite, notice shown to a second participant, a spoken request split across three captions becomes one request, a read answer lands in chat labelled with the asker, a write shows a card that only the asker can confirm, a second person's "yes" does nothing, pause stops storing lines, dismiss posts minutes, the meeting page shows them, a person who was not in the call is refused.
- Unit tests for the detector built from the spike's real captions, including the split request, the half-cut words and the junk slivers.
- The scope matrix and the voice inventory classify every new route.
- A validator script that runs the journey and the unit suites, in the same form as the learning loop's.

## Risks

- **Caption quality on real audio is unmeasured.** The spike used clean synthetic voices. Package 6 must measure with real microphones before the feature is called usable.
- **One Whisper worker.** Many simultaneous speakers queue. `base` kept up with three.
- **The asker's browser must be open.** If the asker leaves mid-turn, the turn expires and says so in chat.
- **Shared answers.** Decision 6 makes an asker responsible for what they ask in front of others. The private-tool list must be reviewed whenever a tool is added.
- **Local stack weight.** The captions service adds about 600 MB of memory and bursts of CPU while people speak.
- **Service identities in the local stack are unsigned.** The server-side chat path must use a credential that also works with gateway authentication on.

## Not in this plan

Phones and tablets, cloud deployment, calendars, other meeting products, and recording changes.
