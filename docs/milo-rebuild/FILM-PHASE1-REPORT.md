# Milo rebuild, phase 1 proof: the hands-free board film on the turn owner (2026-11-20)

**Verdict: not proven yet.** With `MILO_TURN_OWNER=1` the first live take was mute: two faults in the seam that the offline judge cannot see. Both are fixed in this branch. The second take, on the fixed code, is the film. In it Milo gave the right words on four of the six beats, the wrong words on one, spoke once when nobody asked (over the candidate), and the interruption was not really tested. Every answer started 3.5 to 4.0 s after the speech ended, over the 3 s target.

| | take 1 (main as it was) | take 2 (with the two fixes) = the film |
|---|---|---|
| Hugo's hold: introduce | decided right, **never said** | **right**, 3.6 s |
| Mateo, name last: time left | decided right, **never said** | **right**, 3.6 s |
| Hugo talks over Milo | nothing to talk over | **not tested**: Milo had finished the line |
| Hugo, name first: time left | **never heard** (Milo had left the call) | **right**, 4.0 s |
| Hugo, follow-up without the name | **never heard** | **wrong** words, 3.5 s |
| Mateo's mention | silent (Milo was gone) | **right**: silent |
| a line nobody asked for | none | **one**, over the candidate |

Setup: the film script (`scripts/demo/interviews-board-film.mjs --milo --handsfree --turn-owner`), the same lines, human voices and beats as the 19 November hands-free report, its own stack on its own ports, Milo live on OpenAI. Decide ran on `gpt-5.4-mini`, the voice on `gpt-4o-mini-tts`. The only switch the interviews call needs is `MILO_TURN_OWNER=1` (with `MEETING_ASSISTANT_HANDSFREE=1`, as before): the interviews policy already carries the whole turn contract.

The machine was on AC power. The previous film is kept as `film/system-design-handsfree-2.mp4`; this take is `film/FINAL-system-design.mp4` (208.8 s, 0 cuts). Both are in the scratchpad, not in the repository.

## How each turn was scored

Three sources, side by side:

- the line the product logged and posted (the call chat, read by the film after each turn)
- the film's own audio, transcribed with faster-whisper (base) near that time
- the take's trace (`turn.decide`, `turn.act`, `turn.speak`) and the timeline of every voice frame against every human line

A turn is **right** only if the words are the correct answer for that asker in that context. A step the film script passed is not counted as success. Latency runs from the end of the asker's speech (for the hold, the release of the button) to Milo's first audio frame on the lead's page.

## Take 2, turn by turn

| # | film time | who, how | asked | Milo's logged line | Whisper heard in the film | right? | latency | overlap |
|---|---|---|---|---|---|---|---|---|
| 1 | 0:14 | Hugo, hold | "Please introduce yourself to Mateo." | "Hi, I'm Milo. I won't write your algorithm or anything like that, but use me if you want to speed things up or have a question." | the same words, 0:19.8 to 0:27.3 | **right** (see note a) | 3.6 s from the release, 3.9 s from the last word | none |
| 2 | 0:29 | Hugo, to Mateo, not to Milo | "It's a classic: design Twitter." | the fixed line "I can introduce myself, repeat the question or tell you how much time is left." (not read back by the film; the wording is the product's constant) | "I can introduce myself. Repeat the question. … how much time is left." 0:36.4 to 0:40.5, mixed with Mateo's words | **wrong**: nobody asked | 4.5 s after Hugo's line | **began while Mateo was mid-sentence** (1.8 s over "…and a home timeline, newest first"), then 1.5 s over his next line |
| 3 | 0:58 | Mateo, name last | "Before I start drawing, roughly how much time is left, Milo?" | "About 59 minutes are left in this round." | the same words, 1:05.4 to 1:08.0 | **right** | 3.6 s | none on the words (see the interruption) |
| 4 | 2:13 | Hugo, name first | "Milo, how long have we got?" | "About 58 minutes are left in this round." | the same words, 2:19.0 to 2:21.6 | **right** | 4.0 s | none |
| 5 | 2:24 | Hugo, follow-up, no name | "Great. And can you read out the question once more?" | "Milo has not asked a question yet." | the same words, 2:30.2 to 2:32.3 | **wrong** (see note b) | 3.5 s | none |
| 6 | 3:01 | Mateo, a mention | "Thank you, that was fun. I liked how Milo kept time." | none: `stay_silent` | nothing from Milo in the 5.4 s that follow | **right** | n/a | n/a |

Three more sentences reached Decide and were rightly left in silence: Hugo's "Very read heavy…" (0:48), Mateo's "Okay, I'll note the requirements first" in his follow-up window (1:16), and Hugo's "The fan-out. Walk me through it." in his (2:43).

Notes:

- **(a) The introduction** is the product's fixed sentence and it was said whole. It says "I won't write your algorithm" in a system design round, where there is no algorithm to write. Right action, coding-round wording.
- **(b) The follow-up** was routed correctly now, without the name, to `repeat_question`. But the tool answers "Milo has not asked a question yet." whenever the lead asked the question himself, which is this film's flow (Hugo presses "I'll ask it"). Hugo wanted the round's question read out. This is the same fault as on 19 November, unchanged by the rebuild.

### The line nobody asked for (turn 2)

Hugo released the hold at 0:16.5. His next sentence, 13 s later and spoken to Mateo, went to Decide marked `via: hold`. Told "they held the button that asks Milo", the model chose `cannot_help`, and for a hold that line is spoken. Milo started it at 0:36.2, while Mateo was reading the prompt aloud, and Whisper lost Mateo's "newest first" and "Before I draw anything" under it.

The likely cause is in `turn/floor.ts`: a sentence counts as held when its start is before the release. A lane's sentence starts where the lane's previous sentence ended, not where the person began to speak, so the first sentence after a release still starts "inside" the hold. Hugo's sentence after that one (0:48) was also marked `via: hold`; I did not trace why. This is a new fault of the turn owner and it is not fixed here.

### The interruption

The film has Hugo talk over Milo 2.5 s into the answer to Mateo. The new voice says that line in 2.4 s, so Milo had finished: his last voiced frame was at 1:07.8, Whisper's last word ends at 1:08.0, and Hugo began at 1:08.1. No word of Milo's was cut and none overlapped.

Two things still show in the trace:

- After the words, 1.5 s of silent frames were still sent, and the owner logged `turn.barge-in` at 1:09.7 with the line marked `partly, stopped`. A line that was heard whole is recorded as cut short.
- The only real cut in the take was Mateo over the unrequested line: he began his next sentence at 0:39.0 and Milo's last frame went out 1.1 s later (playout ended 1.45 s later). The target is 0.7 s; the old path measured 0.6 s on 19 November. One sample, on a line that should not have been said.

So "Hugo interrupts Milo and Milo stops" is not proven for the turn owner. The film's barge has to start earlier (about 1 s in) or on the longer introduction.

### Where the time goes

| turn | speech end to the finished sentence | Decide | voice, first byte | total |
|---|---|---|---|---|
| 1 introduce (hold) | 1.6 s | 1.0 s | 1.3 s | 3.9 s (3.6 s from the release) |
| 3 Mateo, time left | 1.8 s | 1.0 s | 0.8 s | 3.6 s |
| 4 Hugo, time left | 1.7 s | 1.3 s | 0.9 s | 4.0 s |
| 5 follow-up | 2.0 s | 0.8 s | 0.6 s | 3.5 s |

The largest part is the wait for the lane's finished sentence, before Decide starts. On 19 November the old path answered Hugo's name-first question in 2.8 s; the turn owner took 4.0 s for the same words. No turn met 3 s.

### Carried over, unchanged

- Hold chips are right on both seats ("You are talking to Milo" / "Hugo Marchetti is talking to Milo"). The speaker's tile ring is still missing on both.
- Each page read the floor twice at load and never again.
- The scorecard still says Milo has no recommendation, evidence for 0 of 2 competencies.
- The film has 9 gaps of 1.5 s or more; the worst is 5.4 s (the watch after the mention). Four of them are Milo's latency (3.5 to 4.0 s each).

## Take 1: mute, and the two faults behind it

Take 1 ran on main as it was. Decide and Act were right both times they ran (introduce in 1.6 s, time left in 1.1 s) and nothing was ever said. Whisper finds no word of Milo's in that film.

**1. Every line's speech hold was refused.** Before a line is said, the interviews policy holds its money under the interview's cap, with the spend key `turn-<sentence id>`. A real sentence id carries its lane, for example `<mark>.1/u-hugo:1:2`, and a spend key may hold only letters, digits, dot, dash and underscore. The money door threw, the hold counted as refused, and Speak ended `unspoken, no-hold` each time. "Have Milo ask" would have failed the same way (`say:1`). The judge's test tenant has no money door, so it could not see this.

Fix: `speechHoldKey` in `middleware/src/lib/interviews/milo-turn.ts` replaces the other characters; a test checks real ids against the money door's own rule.

**2. Milo left the call after two minutes.** With the owner on, the session the orchestrator still opens is fed nothing. The provider ends a session that gets no audio after 30 s (`session.closed`, reason `expired`), the orchestrator counts that as a drop and opens a replacement, and after three replacements it gives up. Milo was gone at 1:58, so Hugo's two later questions were never heard. Each replacement also builds a new turn owner, so the floor and the follow-up window were reset every 30 s.

Fix: in the seam (`orchestrator.ts`), the unused session is fed one silent frame every 10 s, which is what the hands-free runtime fed it when idle. In take 2 the one session lived the whole 209 s. This keepalive goes away with the session in the phase's deletion commit.

Both fixes passed `tsc` and the three touched suites (63 tests). The full suites and the judge were not run in this lane.

## Still open for phase 1

1. A sentence after a hold's release is treated as held, and Milo speaks unasked over the candidate (new, turn 2).
2. `repeat_question` has nothing to read when the lead asked the question himself (old, turn 5).
3. Latency is 3.5 to 4.0 s on every turn; the sentence final is 1.6 to 2.0 s of it.
4. The interruption is unproven on the turn owner, and a line heard whole can be logged as cut (the 1.5 s of silent frames after the words).
5. The introduction's wording is the coding round's in a board round.
6. The unused session is still opened and billed until the deletion commit.

## Spend

Estimated at the 19 November rates ($0.05 a minute for the open session, $0.017 a minute for each of two transcription lanes): take 2 ran 209 s, about $0.29; take 1 had sessions open for about 2 minutes, about $0.17. Decide made 11 calls of about 700 tokens in and 15 out, and the voice said 5 lines (about 20 s): together under $0.02. **About $0.50 in all.** No Bedrock was used.

## What changed in this branch

- `scripts/demo/interviews-board-film.mjs`: `--turn-owner` sets `MILO_TURN_OWNER=1` for the film's middleware, and the take's report records which path ran.
- `middleware/src/lib/interviews/milo-turn.ts`: `speechHoldKey`.
- `middleware/src/lib/meeting-assistant/orchestrator.ts`: the keepalive for the owner's unused session.
- Tests for both in `milo-turn.test.ts` and `handsfree-orchestrator.test.ts`.
