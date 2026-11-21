# Milo rebuild, film 3: the board film with the name required (2026-11-20)

> Superseded for demonstration use by [the coherent system-design revision](FILM-8-SYSTEM-DESIGN-REPORT.md). This historical report describes a voice-contract stress-test film, not the revised delivery.

**Verdict: the turn contract holds; two of Milo's answers have the wrong words.** On the film take Milo answered every request made with his name or the hold, stayed silent on the three lines that only mentioned or quoted him, never started while a person was talking, and stopped when Hugo cut in. The words were wrong twice: the introduction is the coding round's ("I won't write your algorithm") in a board round, and the probe was the scripted stand-in's template, not a written question. The scorecard still has no recommendation from Milo. Every answer started 3.2 to 4.1 s after the speech ended.

Setup: `scripts/demo/interviews-board-film.mjs --milo --handsfree --turn-owner --name-required --barge-on none`, its own stack on its own ports, Milo live on OpenAI (Decide `gpt-5.4-mini`), the human voices from earlier films plus five new lines (Qwen3-TTS, each checked with Whisper). The machine was on AC power (36%, charging). The film is take 2 (263.7 s, 0 cuts), kept as `film/FINAL-system-design.mp4` in the scratchpad; the phase-1 film is kept as `film/system-design-phase1.mp4`. Nothing is in the repository.

## How each turn was scored

Milo's words come from a faster-whisper (base) transcript of the film's audio, next to the line the product posted in the call chat and the take's trace (`turn.decide`, `turn.act`, `turn.speak`, `turn.barge-in`). A turn is **right** only if those words are the correct thing for that asker in that context; the film script's step passes are not counted. Latency runs from the end of the asker's line (for the hold, the release) to Milo's first audio frame on the lead's page. Overlap compares every Milo voice frame with every human line on the film's timeline.

## Take 2 (the film), beat by beat

| # | film time | who, how | asked | Milo's words (Whisper) | right? | latency |
|---|---|---|---|---|---|---|
| 1 | 0:17 | Hugo reads the round's opening line | "If you'd like help, just say 'Hey Milo'." | nothing (Decide: `stay_silent`) | **right** | n/a |
| 2 | 0:26 | Hugo, hold | "Please introduce yourself to Mateo." | "Hi, I'm Milo. I won't write your algorithm or anything like that, but use me if you want to speed things up or have a question." | **wrong words**: right action, the coding round's sentence in a board round | 3.2 s from the release |
| 3 | 1:10 | Mateo, name last | "Before I start drawing, roughly how much time is left, Milo?" | "About 59 minutes are left in this round." | **right** | 4.1 s |
| 4 | 2:26 | Hugo, "Hey Milo" | "…ask a probe about the non-functional requirements in this part of the design?" | "Thinking about non-functional requirements in this part of the design, what would you change in the high level design part, and why?" | **wrong words**: right tool and area, but the text is the scripted stand-in's template (see below) | 3.8 s |
| 5 | 2:50 | Hugo, name first | "Milo, how long have we got?" | "About 58 minutes are left in this round." | **right** | 3.6 s |
| 6 | 3:01 | Hugo, no name | "Great. And can you read out the question once more?" | nothing (no Decide at all: no name, no window); Hugo read it himself | **right** | n/a |
| 7 | 3:23 | Hugo, name first, then cuts in | "Milo, can you ask Mateo that probe once more?" | "Thinking about the non-functional requirements in this part of the design," then stopped under Hugo's "Okay, thanks, that's enough" | **right** stop (words: the same template) | 3.9 s |
| 8 | 3:58 | Mateo, a mention | "I liked how Milo kept time." | nothing (Decide: `stay_silent`) | **right** | n/a |
| 9 | 4:13 | scorecard | | the pill reads "Milo has no recommendation yet. The transcript has evidence for only 0 of 2 competencies." | **wrong**: no recommendation | n/a |

The interruption: Hugo started 2.5 s into the line; Milo's last frame came 1.6 s later and the audio ended 2.0 s after Hugo began (`turn.barge-in` 1.7 s after). That 2.0 s is the only overlap in the film. Milo never started while anyone was talking.

### Why the probe is a template

The film runs the coach as the scripted stand-in (`INTERVIEWS_COACH_MODEL=scripted`) so its suggestions are repeatable. The probe writer (`middleware/src/lib/interviews/milo-tools/probe.ts`, `writeProbe`) chooses the scripted stand-in whenever the coach is scripted, so no model wrote these probes: the words are `scriptedProbe`'s "Thinking about <topic>, what would you change in <the frame> part, and why?". To film a real probe, either the film runs the coach live or the probe writer stops following the coach's switch. The second probe also read a frame title aloud as "Purpose(s)".

### Gaps

13 gaps of 1.5 s or more. The three longest are deliberate silences: 6.1 s after the opening line (the 5 s watch), 6.1 s after the follow-up without the name (the 6 s watch), 5.4 s after the mention. Five are Milo's latency (3.5 to 4.6 s). The rest are 1.6 to 2.6 s turn changes.

## Take 1: the film script's fault

Take 1 had the same results except beat 3: with no barge-in planned at that point, the script waited only for Milo's first frame, so Mateo's next line started 0.6 s into the answer. The product did the right thing (`turn.barge-in` by the asker, Milo stopped after 0.1 s of audio), but the answer was never heard. The script now waits for the whole answer there. Take 1 is not the film.

## Spend

Two takes of about 260 s each with Milo listening, about $0.75 at the 19 November rates; Decide made 9 calls per take (about 1,100 tokens in, 15 out) and the voice said 5 lines per take: under $0.05. **About $0.80 in all.** No Bedrock and no Anthropic calls.

## What changed in this branch

- `scripts/demo/interviews-board-film.mjs`: `--name-required` (with `--turn-owner`) plays the 20 November beats: the opening line, a probe by "Hey Milo" and Mateo's answer, the follow-up without the name met by silence and Hugo reading the question, a second probe that Hugo cuts into. Each silence is watched for a bounded time and recorded in the report (`silences`). Mateo's next line after the time question waits for Milo's whole answer.
- `scripts/demo/interviews-board-film-lines.json`: five lines (`h01`, `p01`, `p02`, `f02`, `p03`).

## Open

1. The introduction's wording is the coding round's in a board round (carried over from phase 1).
2. The probe writer follows the coach's scripted switch, so a scripted coach means template probes.
3. Latency 3.2 to 4.1 s on every turn; no turn met 3 s.
4. Milo makes no recommendation on the scorecard (evidence 0 of 2), unchanged.
5. The speaker's tile ring during a hold is still missing on both seats (0 rings).
