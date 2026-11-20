# Review of the Milo rebuild plan (2026-11-19)

Read-only, against main `c9a6f310f`. Nothing was run. Paths are under `middleware/src/lib/` unless stated.

## Verdict: GO WITH CHANGES

The direction is right and should replace patching. The plan as written would still fail live in three places it does not test: when a turn ends, how audio is played out, and whose mic a sentence really came from. Its judge also repeats the old gate's mistake by starting below the trigger.

The owner's steer is applied throughout: decide on the final transcript only, no provisional racing, pick the Decide model by accuracy with context, report latency against a loose p90 of 3 s instead of designing for it.

## Ranked failure risks

### 1. The text judge starts below the turn trigger (likelihood: certain as written)
- **Evidence.** Plan section 4: the judge calls `decideAndAct`. That skips the name gate (`findAddress`), sentence cutting, the follow-up window, the echo filter and the context builder. The probe's 123/126 was measured the same way, sentence straight into the model. This is audit F4 again: a judge beside the product path.
- **Change.** The judge feeds timed scripts of `{who, text, atMs, named}` and hold presses into the turn owner on a fake clock and scores the logged line. `decideAndAct` is not an exported judge seam.

### 2. A turn ends at a fixed 600 ms of quiet, on clean clips only (likelihood: high)
- **Evidence.** `voice/openai-transcribe.ts:17-23,66-88`: energy check at RMS 300, commit after 600 ms quiet. One commit is one sentence (`handsfree/listening.ts:219-246`). "Milo, add a test for... (thinks) ...empty input" becomes two sentences; the first reaches Decide as a write with half an argument. RMS 300 is about -40 dBFS, so typing in a coding round can hold a turn open until the 15 s cap. Film and probe clips are synthetic voices with no pauses or noise. If a mic's audio stops arriving, quiet is streamed 500 ms late (`listening.ts:47,370-378`).
- **Change.** A new onset from the asker before Milo's audio starts cancels the turn and merges the sentences. Decide gets a `keep_listening` choice. A write tool runs only once the turn is committed. The audio gate adds clips with 0.7-1.5 s pauses and keyboard noise.

### 3. Playout is not paced and the browser cannot be told to stop (likelihood: certain unless built)
- **Evidence.** `VoiceRelay` sends frames as fast as the socket takes them and drops past 3 s queued; `clear()` empties only the server queue (`voice.ts:56-74`). Today the router paces (`handsfree/router.ts:678-685`). TTS returns a clip in under half its length (probe c). Unpaced, a long introduction is partly dropped, barge-in cannot stop what was sent, and `partly`, the echo tail and the 10 s follow-up window have no playout time.
- **Change.** `speak.ts` owns pacing: real time, at most 300 ms ahead, and it reports play start and end. Add to phase 0 tests: a 12 s line is heard whole.

### 4. A mic does not hold only its owner (likelihood: medium; authority impact high)
- **Evidence.** The plan sizes `barge.ts` at 120 lines "from `router.ts:27-75`". Those lines are constants and a correlation helper. The working logic is `router.ts:237-262, 368-415, 678-866` plus `overlapOf` in `handsfree/rules.ts:218-240`, which phase 1 deletes. Nothing covers a remote person's voice leaking into another mic: a candidate heard through the lead's open speaker is transcribed on the lead's lane and gets the lead's tools.
- **Change.** Move the existing barge and echo code with its tests, do not rewrite it. Add two code rules: a sentence inside Milo's playout plus 1.5 s that matches the spoken line is dropped and never stored as that person's words; the same sentence on two lanes is one turn, credited to the earlier lane, and to the lower authority when unclear.

### 5. The follow-up window will make Milo interrupt people (likelihood: medium-high)
- **Evidence.** After an answer, every sentence from the asker for 10 s goes to Decide (`types.ts:49`). In a real call most of those are not for Milo. A candidate has a forced choice, and `cannot_help` speaks the fixed sentence. The probe's follow-up set was nearly all requests.
- **Change.** Without the name or a hold, `cannot_help` and a timeout mean silence. The corpus has at least half its follow-up sentences not for Milo.

### 6. The recommended model errs in the unsafe direction, and context is undefined (likelihood: medium)
- **Evidence.** Probe f: gpt-5.4-nano's misses are a mention answered aloud and an unrequested `pad_write`. gpt-5.6-luna's misses are a refusal and a silence. Both score 123/126 on 42 distinct cases, which cannot separate them. Only the pad follow-up was tested with context. The plan says "the last few lines" and nothing about the round, the question, or Milo's last action and arguments, which "same again but in Python" needs.
- **Change.** Choose on the hold-out by accuracy with context, counting false speech and false writes as worse than refusals. Start from luna or 4.1-mini. Define the context: the asker's last three lines, Milo's last line and tool call, and a tenant-supplied state string.

### 7. The name gate is still the regex grammar (likelihood: medium)
- **Evidence.** `findAddress` (`detector.ts:236-262`) decides "addressed" with word rules and moves to `name.ts` unchanged; audit F2 lists this range as script-fitted. The probe heard "Ilo", which is in neither spelling list (`listening.ts:28`), and one leading "Milo," was missing from the deltas.
- **Change.** Any sentence containing a spelling of the name goes to Decide; `stay_silent` judges mention against address. Keep the spelling list, delete the grammar. Decide on the final, where the name is most complete.

### 8. Things the deletion list removes without saying so (likelihood: medium)
- **Evidence.** "Stop listening", "leave the call" and "never mind" are parsed by the detector (`detector.ts:269-276,327`) and have no Decide tool. `repeatWindowMs` goes although it stops a double write. `orchestrator.ts:947-1260` includes `pushFloor`, `sendVoice` and `onHeardLine` (`:1034-1079`), which the new path keeps; `:1687-1998` includes `noticeRequestCap` (`:1976`), which a phase 0 test needs. `handsfree/surface.ts:9` imports `rules.js`.
- **Change.** Add core tools `pause_listening`, `leave_call`, `cancel` with role checks. Keep an idempotency key per sentence. Delete by named method, not by line range.

### 9. Migration order (likelihood: medium)
- **Evidence.** `orchestrator.ts` is edited in every phase and split last, against the audit's own "split the hot file first". Phase 1 deletes the router while Work under the flag still uses it until phase 2, and lane 1A's hook deletion needs the orchestrator that 1B owns. Each phase deletes before its film. Lane 0D cuts inside `live-session.ts` and `router.ts`, both deleted whole later.
- **Change.** The orchestrator gets one small seam (start, stop, sentence, hold, say). Old code is disconnected, then deleted in one commit per phase after the judge, the audio gate and the owner's five minutes. Drop 0D's surgery; delete whole files. The router goes in phase 2.

### 10. Privacy and authority gaps (likelihood: medium)
- **Evidence.** `postTextResponse` posts to `/responses` (`voice/openai.ts:168-178`), which keeps responses unless `store: false`; no caller sets it. The plan does not say the context lines pass `modelReadsSpeaker`. A candidate with pad help can call tools whose arguments are model-written code up to 6,000 characters (`interviews/milo-tools/pad-add-helper.ts:15-20`), so only tool choice is enforced in code. The TTS model can misread; the plan checks heard against logged offline only.
- **Change.** `store: false`, with a test on the request body. A test that a declined candidate's lines are in nobody's Decide request. A candidate's pad write needs the lead's confirm card. Fixed lines are rendered once and checked; other lines are transcribed after the fact and the row is flagged on a mismatch.

### 11. Latency will miss the plan's number (likelihood: certain; low harm under the steer)
- **Evidence.** Sequential is 2.2-2.4 s p50 and 2.4-2.7 s p90 offline. The film's final lagged 1.6-1.7 s where the probe saw 1.2 s. The probe used a warm streaming chat call; the plan's helper is a cold, non-streaming Responses call. My estimate, unmeasured: 2.7-3.0 s p50 and 3.0-3.5 s p90 at the relay for computed lines.
- **Change.** Gate on p90 of 3 s at the relay as a reported number. Keep only cheap, isolated help: fixed lines rendered at call start, and one warming request when the name is heard. No provisional path.

### 12. The tenant contract is two members short (likelihood: low-medium)
- **Evidence.** There is no member for call state, so the core must learn about rounds or Decide goes without. Hold permission lives in a core file. Social as a 15-line copy of Work proves nothing.
- **Change.** Add `context(call, person)` and `mayHold(call, role)`. Prove the contract with a test tenant that passes the judge with no core edits, and a test that the core imports nothing from `interviews/`.

## Plan claims checked

- Correct: file sizes; `runServerTool` exported and returns a line (`server-tools.ts:165`); `orchestrator.ts:2263-2342` is the held fallback; `repeat_question` reads Milo's own last question.
- Wrong: the barge-in source range (risk 4); "listening.ts kept as is" holds only without a provisional path, since no commit event is emitted; the text helper is not the call the probe timed (risk 11); two deletion ranges include kept code (risk 8).

## Amended phase 1: interviews on the turn owner, sequential

Order: judge, decide, interviews, floor, then one deletion commit.

- **1D judge first (Sonnet).** Timed scripts through the turn owner on a fake clock, scored on the logged line. Corpus: split requests, half the follow-up sentences not for Milo, the same sentence on two lanes, Milo's echo, misheard names, pause and leave. A model bake-off with context picks the Decide model by accuracy and error direction.
- **1A decide (Opus).** One call on the final transcript, `store: false`. Context is the asker's last three lines, Milo's last action and `policy.context()`, filtered by `modelReadsSpeaker`. Core tools: `stay_silent`, `cannot_help`, `keep_listening`, `pause_listening`, `leave_call`, `cancel`.
- **1C interviews (Sonnet).** As planned, plus the lead's confirm on a candidate's pad write.
- **1B floor (Opus).** Any sentence with the name reaches Decide. A new onset before audio cancels and merges. Without the name, `cannot_help` is silence. Echo and two-lane rules from risk 4. Existing barge code moved, not rewritten. The only orchestrator change is the seam, behind one switch for interviews.
- **Gate.** Candidate output inside the allow-list 100%; silence 98% at realistic rates; action 95% on the hold-out; heard equals logged on clips with pauses and noise through the real orchestrator; p90 reported against 3 s.
- **Then.** The hands-free board film, the owner's five unscripted minutes, and one commit that deletes the interviews session path and the switch. The router and rules go in phase 2 with Work.
