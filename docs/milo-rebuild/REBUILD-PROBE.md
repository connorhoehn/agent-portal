# Milo rebuild probe (2026-11-19)

Script: `scripts/milo-probe/probe.mts` on branch `milo-rebuild-probe` (modes `text`, `tts`, `live`). Raw rows in
`scratchpad/interviews/probe/*.jsonl`, summaries by `probe/an.py`. All times are ms from the end of the person's speech
(the same 20 ms / RMS 300 check the production transcriber uses, run over the clip). Clips: `hf-gate2/clips` (Qwen3-TTS
voices from the voice harness), streamed in real time in 20 ms frames into the production `openOpenAiTranscriber`
(gpt-live-transcribe, delay minimal, keyword Milo, 600 ms end of speech). No model audio was stored; TTS bytes were counted
and dropped. Machine was on battery (84%) throughout; runs were a few minutes each.

## a. Transcription final (current setup)

| run | n | final p50 | final p90 | commit (our 600 ms quiet) p50 | last delta p50 / p90 |
|---|---|---|---|---|---|
| live, gpt-4.1-mini | 60 | 1200 | 1238 | 602 | 334 / 427 |
| live, gpt-5.4-nano | 60 | 1213 | 1362 | 601 | 270 / 448 |

The words are all in about 0.3 s after speech ends; the final arrives ~0.6 s after our commit. Name misheard in 5/60
("Mylo", "Nilo", "Ilo"), and clip ct03's leading "Milo," was not transcribed at all.

## b. Decide: one streaming Chat Completions call with tools (warm connection)

Tool sets: candidate `time_left, repeat_question, stay_silent, cannot_help` (tool_choice required); interviewer adds
`introduce, pad_write`; work policy `time_left, pad_write, stay_silent` with free text allowed. gpt-5 family at
reasoning_effort none. 42 tool cases x1 (first sweep) per model; "free" = 5 trivia questions, first text token.

| model | tool first p50 | first p90 | done p50 | done p90 | free first token p50 | free done p50 | accuracy (x1) |
|---|---|---|---|---|---|---|---|
| gpt-4.1-mini | 543 | 658 | 574 | 782 | 456 | 552 | 41/42 |
| gpt-4o-mini | 573 | 760 | 657 | 803 | 414 | 513 | 37/42 |
| gpt-5.4-nano | 456 | 581 | 518 | 741 | 390 | 454 | 40/42 |
| gpt-5.4-mini | 612 | 830 | 661 | 850 | 596 | 684 | 37/42 |
| gpt-5-nano | 490 | 614 | 532 | 682 | 459 | 466 | 26/42 |
| gpt-5.6-luna | 639 | 1061 | 688 | 1061 | 624 | 715 | 42/42 |
| gpt-6-luna | 628 | 750 | 665 | 794 | 509 | 561 | 38/42 |
| gpt-4.1 | 575 | 717 | 596 | 748 | 438 | 467 | 40/42 |

Tool name and arguments arrive within ~40 ms of each other for argument-free tools, so "done" is the honest number.

## c. TTS, time to first audio byte (streaming pcm, "You have about twelve minutes left.", 20 each)

| model:voice | first byte p50 | p90 | whole clip p50 |
|---|---|---|---|
| tts-1:alloy | 1208 | 1805 | 1298 |
| tts-1-hd:alloy | 2095 | 2577 | 2346 |
| gpt-4o-mini-tts:alloy | 513 | 678 | 851 |
| gpt-4o-mini-tts:cedar | 512 | 617 | 728 |
| gpt-4o-mini-tts-2025-12-15:cedar | 512 | 756 | 907 |

Quality: not judged by ear (the probe keeps no audio); gpt-4o-mini-tts is the steerable newer model with the realtime voices
(cedar), tts-1 is the older lower-fidelity one and is also slower here. TTS is ~0.5 s, above the audit's 0.2-0.4 s.

## d. Total, speech end to first audio (sequential: final -> decide -> TTS), 20 runs per case

| case | decide model | final p50 | decide p50 | TTS p50 | total p50 | total p90 |
|---|---|---|---|---|---|---|
| server line (time left), interviewer | gpt-4.1-mini | 1200 | 623 | 626 | 2420 | 2678 |
| free answer (work policy) | gpt-4.1-mini | 1086 | 563 | 613 | 2339 | 2572 |
| candidate forced choice | gpt-4.1-mini | 1210 | 506 | 527 | 2216 | 2360 |
| server line (time left), interviewer | gpt-5.4-nano | 1099 | 500 | 568 | 2238 | 2672 |
| free answer (work policy) | gpt-5.4-nano | 1223 | 511 | 557 | 2365 | 2553 |
| candidate forced choice | gpt-5.4-nano | 1229 | 502 | 558 | 2314 | 2533 |

All 120 live decisions picked the right action (time clips -> time_left, repeat clips -> repeat_question, the candidate's
trivia / note requests -> cannot_help, every free question answered in text). Free answers waited for the whole (one
sentence) text before TTS.

## e. Decide on the provisional transcript (deltas at our commit, 600 ms), confirm on the final

| case | model | provisional total p50 | p90 | same action as final | delta text == final at commit | at speech end / +300 ms |
|---|---|---|---|---|---|---|
| server line | gpt-4.1-mini | 1880 | 2040 | 18/20 | 18/20 | 0 / 7 |
| free answer | gpt-4.1-mini | 1857 | 2050 | 19/20 | 19/20 | 4 / 17 |
| candidate | gpt-4.1-mini | 1668 | 1862 | 18/20 | 18/20 | 0 / 14 |
| server line | gpt-5.4-nano | 1781 | 1988 | 18/20 | 18/20 | 0 / 8 |
| free answer | gpt-5.4-nano | 1861 | 2045 | 18/20 | 19/20 | 3 / 15 |
| candidate | gpt-5.4-nano | 1741 | 2407 | 18/20 | 18/20 | 0 / 16 |

Every action mismatch was a case where the delta text differed from the final (ct03 lost its "Milo,"; q22 "continents" ->
"consonants"), so the safe rule is: decide and synthesise on the commit-time deltas, hold the audio, play it only if the
final's text equals what was decided on, else re-decide. The final (~1.2 s) lands before the provisional audio (~1.8 s),
so confirming costs nothing. With that rule (mismatches fall back to the sequential path): gpt-4.1-mini p50 / p90 =
1897 / 2117 (server), 1857 / 2050 (free), 1719 / 1932 (candidate); gpt-5.4-nano 1799 / 2083, 1861 / 2417, 1812 / 2407.
Saving: ~0.5 s at p50. Starting at speech end + 300 ms instead of the commit would save another ~0.3 s but the deltas
match the final only 40-85% of the time there.

## f. Accuracy on the audit's ordinary phrasings (3.4), plus 5 candidate off-limits requests, 3 repetitions

The regex rules: 2/10 candidate time, 0/5 repeat, 2/5 intro, 0/4 nameless follow-ups.

| model | candidate time | candidate repeat | lead intro | mention vs address | follow-up, no name | candidate off-limits | total |
|---|---|---|---|---|---|---|---|
| gpt-5.4-nano | 30/30 | 15/15 | 15/15 | 13/15 | 35/36 | 15/15 | 123/126 |
| gpt-5.6-luna | 29/30 | 15/15 | 13/15 | 15/15 | 36/36 | 15/15 | 123/126 |
| gpt-4.1-mini | 28/30 | 15/15 | 10/15 | 15/15 | 36/36 | 15/15 | 119/126 |

Misses: "Hey Milo, what time is it?" -> cannot_help (4.1-mini, luna); "Milo, say hi to Mateo." / "tell Mateo what you do" ->
stay_silent (introduce's description is too narrow; a prompt fix); nano: "I liked how Milo kept time." -> time_left, and
"Mateo, go ahead." -> pad_write once (with the pad follow-up context). No candidate request ever reached an
interviewer-only tool (the candidate tool set does not offer one).

## Spend

About $0.5 in all: ~1,400 text calls (mostly mini/nano, ~400 input tokens each), ~260 short TTS calls, ~12 minutes of
transcription across the live runs.

## Verdict

The audit's 1.3-2.1 s estimate is optimistic at the naive build and roughly right with the provisional trick. Built
straight (final -> decide -> TTS) the target design is 2.2-2.4 s p50 and 2.4-2.7 s p90, because both stages it guessed
low come in at ~0.5 s each (decide 0.5-0.6 s, TTS first byte 0.5-0.6 s) on top of a 1.1-1.2 s final. Deciding and
synthesising on the commit-time deltas and confirming against the final brings it to 1.7-1.9 s p50, ~2.0-2.4 s p90, with
no accuracy cost (every mismatch was caught by the text check). Fixed lines (introduction, refusals) and per-minute
time-left lines can be pre-rendered, which removes the 0.5 s TTS step for most interview answers and puts those near
1.2-1.4 s (estimated from the parts, not measured). All of it beats today's 2.8-4.7 s, and the decide step is right on 98% of the ordinary phrasings where the rules
got under a third. Pick gpt-5.4-nano (fastest, 123/126) with gpt-4o-mini-tts; the largest remaining cost is the
transcriber's ~0.6 s from commit to final, which the provisional path already hides.
