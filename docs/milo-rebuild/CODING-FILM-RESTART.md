# Coding interview film analysis and restart

Implementation update: the restart is now implemented on `codex/milo-coding-film`. See [Film 7's implementation and validation report](FILM-7-CODING-REPORT.md) for the fresh recordings, live-model diagnosis, regression checks, and final review. The analysis below preserves the findings that motivated that work.

Reviewed 20 November 2026 against main `7a201de17`, Film 6 take 3, the saved product transcript, the whole-film Whisper transcript, and the recording and recap code. This supersedes the acceptance conclusions in `FILM-5-CODING-REPORT.md`. The recordings remain historical evidence; they are not an accepted final film.

The next take needs a newly written conversation with a consistent problem, test contract, sequence of actions, and assessment. Moving existing lines again will leave the underlying contradictions intact. Preserve the working call, editor, confirmation, and recording infrastructure, but rebuild the story and its checks before spending another live take.

## What actually went wrong

The evidence supports reuse of incompatible screenplay fragments, not a claim that the latest video combines footage from several different calls. Film 6 has one saved recording timeline with two cuts. Its script retains an older interview branch, a newer `namedRound()` branch, shared post-call assessment, and a shared catalogue of old voice lines. Those pieces no longer agree about what happened.

The old conversation included a failed duplicate test, a fix, a second run, a complexity question, and further discussion. The new branch types a correct implementation immediately and removes most of that discussion, but keeps lines and assessment assumptions from a fuller interview. A stale comment above `namedRound()` still describes probes, interruptions, and no code execution, although the branch now does something else. This makes the file itself an unreliable account of the intended story.

There are three records to reconcile: what the film audience hears, what the product transcribes, and what the UI/run/scorecard actually records. The old checks largely verified that UI steps happened. They did not verify agreement among these records.

## Reading the whole film as a conversation

Times below refer to the composed film, approximately 191 seconds long. Whisper spellings are not proof of the exact pronunciation; line identity and intended text also come from `timeline.json` and the voice catalogue.

| Time | What the audience gets | Why it fails or needs revision |
| --- | --- | --- |
| 0:01–0:38 | Hugo announces Two Sum to himself; Mateo narrates every consent choice and joining step. | The opening prioritizes UI coverage. The audience waits over a minute and a half for the actual question. Keep consent actions visible, but shorten the spoken tour. Distinguish private preparation from conversation. |
| 0:38–0:59 | Greeting, another welcome, then “Great, let's get started.” | Multiple opening fragments spend time establishing the same thing. One greeting and one concise setup would feel intentional. |
| 0:59–1:24 | Mateo mentions Claude Code and frontier models; Hugo sends a blog link; Mateo says he will read it later; Hugo says “Same here.” | “Same here” now answers the wrong statement. The saved speech list contains one `h06`, not two performances of it. The duplication complaint is a useful signal of broken conversational continuity. “That frontier model” also refers to no specific model, and the script sends a general news index while describing a particular latest post. |
| 1:24–1:53 | Milo help instructions, a second “Today's question is Two Sum,” language choice, then the actual problem. | The problem is introduced in pieces. The spoken problem omits the exactly-one-answer and distinct-element constraints that matter for the later empty-array and duplicate cases. |
| 1:53–2:10 | Mateo mentions brute force, a hash map, checking partners, then adds a duplicate example. | There is a useful core here, but little reasoning develops between the lines. The duplicate example is just a printed call. The script types `GOOD_BODY`; there is no failed run or demonstrated fix in this branch. |
| 2:10–2:34 | Hugo says it looks clean; Mateo asks Milo for empty-array and duplicate tests; Hugo confirms; Mateo says both are there. | An empty array appears only in a print-only edge-input block. The dialogue declares the request fulfilled before an assertion exists. The audience never hears an agreement on what empty input should return. |
| 2:34–2:43 | “Let's run it” immediately gives way to “We're close to the end.” | The run has no conversational consequence: no result, interpretation, or next question. The script hides about 372 seconds under “Mateo works on,” but its intervening actions are tab/scroll changes and a sleep, not a continued interview. |
| 2:43–2:55 | Milo says about two minutes remain; Hugo immediately wraps. | Finishing early can be legitimate, but this sequence exists to demonstrate a time query. Nothing explains why the remaining time is unnecessary or uses it for a final question. |
| 2:57–3:10 | Hugo describes evidence-backed notes; the scorecard has no recommendation and no competency evidence. | The narration promises what the screen cannot deliver. The scorecard also contains a scripted note about a complexity answer that never occurred. |

This is why the film feels assembled: statements do not create obligations that the next action resolves. Asking for tests should lead to a defined expectation, a verified edit, an actual run, a reaction, and a conclusion. Instead, each feature demonstration advances independently.

## Assessment claims that the take does not support

In `scripts/demo/interviews-call-film.mjs`, the named-round scorecard note says Mateo “explained the linear time when asked.” The saved product transcript has 19 lines and contains neither that question nor that answer. The note check passes merely because the text was typed into the form successfully.

The same script selects rating 3 for every competency. These are scripted human ratings, not a result derived from the recorded exchange. A demo may script human actions, but its notes and ratings still need a plausible, visible basis. The film should never present a surviving note from an older scenario as evidence from this one.

`solvedAt` is set after typing the duplicate example, before Milo's request and the run. The report describes the resulting duration as time “to the green run.” That is also inaccurate. Track the actual successful run event separately.

## The empty-array issue is a contract problem

`middleware/src/lib/interviews/testcases/render.ts` deliberately separates cases marked `edge` from cases with expected values. Film 6 contains four comparisons in `milo_test_cases`, then `([], 6)` in `milo_edge_inputs`, printed without an expected value. The output confirms four `ok` rows and one `edge` row. An input that prints is not a passing assertion.

The film check extracts arrays from the whole rendered block. It therefore sees `[]` regardless of which list contains it. The block header counts five inputs, making the mismatch easier to miss. Even the ordinary comparison loop prints `DIFF` without raising; exit code 0 alone does not establish that all tests passed. `runAndRead(..., /ok /)` can succeed when one case passes and another fails.

The question promises exactly one solution. Empty input lies outside that promise. The film should establish an explicit extension, such as returning `[]` when no pair exists, before requesting that case. That makes the expected result a declared contract rather than an arbitrary universal rule for all coding questions. A broadly reusable product change should distinguish reference-verified expectations, explicitly agreed expectations, and unresolved inputs. It must not label an agreed extension as verified by a reference that rejects it.

For this demo, require an actual empty-array assertion and an actual duplicate assertion, then verify their individual outcomes. Include a negative control in the implementation tests: a deliberately wrong empty-input return must fail. Do not fix the film by counting the existing print-only input as a test or by claiming that a comment supplies an expected result.

## Reproduced cause of the missing recap

The recording script explicitly sets `INTERVIEWS_COACH_MODEL=scripted`. Milo's conversational turns can be live while the coach and recap remain deterministic stand-ins. “Live Milo” therefore does not describe every feature in the film.

`middleware/src/lib/interviews/recap/model.ts` opens answer windows only when a panel transcript line contains the first six normalized words of a configured question. The Two Sum opening is `given an array of integers and`. Product transcript line 10 instead reads:

> At given in array of integers and a target, return the indices of the two numbers that add up to the target.

That small ASR error prevents the question from matching. This is distinct from Whisper on the composed film, which hears the question more accurately. Better film review alone cannot repair the transcript the product uses.

An offline diagnostic called the current `scriptedRecap` implementation with all 19 saved product lines and the selected Two Sum question:

| Diagnostic input | Covered competencies | Evidence sequence numbers |
| --- | --- | --- |
| Saved transcript unchanged | None | None |
| Copy with only `At given in array` changed to `Given an array` in line 10 | Problem solving, Communication | 11, 12, 15, 19 for each |

The original transcript was preserved. This is a minimal reproduction, not a replay of every stored suggestion from the deleted stack. It establishes a sufficient cause of the observed 0/3 result and explains why another recording could produce a different result without any meaningful change in interview quality.

The corrected-input result exposes another flaw: sequence 19 is “Thanks Hugo.” The stand-in selects candidate lines by question window and length, not their relevance. Code quality remains uncovered because the only question in this diagnostic is tagged Problem solving; only Communication receives the cross-cutting fallback.

A successful next take must not depend on ASR reproducing six magic words, and it must not promote salutations or requests to Milo into competency evidence. Decide explicitly whether the next recording demonstrates the stand-in or the supported live recap path. Fix and test the selected path. Preserve source sequence IDs and exact quotes; keep uncertainty when relevant evidence is genuinely absent. Do not lower the evidence threshold merely to force a recommendation.

The recap contract currently reads transcript text and questions, not editor contents or run output (`recap/prompt.ts`). A code run on screen cannot silently supply transcript evidence. Ask meaningful human follow-ups about the implementation and its tests so the conversation itself contains the reasoning the recap is supposed to cite. Expanding the recap to code/run evidence would be a separate product change.

## A coherent replacement conversation

This is a proposed new script, not recorded dialogue or an approved performance. Write it as one ordered scene sequence with stable, descriptive line IDs. Reuse an existing voice clip only if its exact text and delivery fit the new context. The goal is a credible interview in which Milo helps with tests, followed by a scorecard that accurately reflects it.

1. **Join and establish the round once.** Show consent and admission without narrating each click. Hugo: “Hi Mateo. We've got about ten minutes for a coding exercise. Talk me through your thinking as you go.” Mateo acknowledges. Explain Milo's test help before it is needed.
2. **Keep the requested Claude Code exchange together.** Hugo asks how Mateo approaches coding now. Mateo mentions Claude Code and staying sharp enough to verify its output. Hugo immediately answers: “Same here. Being able to check the result is what I want to see today.” Then: “I saw a post about those models—I'll put the link in chat for later.” Mateo responds only after the link arrives: “Thanks. I'll read it afterward.” Avoid a claim about a specific latest article unless that exact article is linked and verified.
3. **State one complete problem.** Hugo introduces Two Sum once, including distinct indices and the one-solution promise. Mateo chooses Python. The pad shows the same problem and language.
4. **Resolve the edge contract.** Mateo: “The prompt guarantees a pair. For empty input or no pair, should I return an empty list?” Hugo: “Yes. Let's include that as an extra behavior beyond the prompt.” The expectation is now explicit and testable.
5. **Let the explanation drive the code.** Mateo: “Checking every pair would be quadratic. I'll keep a dictionary of earlier values and their indices.” While typing: “I check for the complement before storing this number, so I can't reuse the same index.” Show the relevant lines, rather than completing the whole solution before the explanation catches up.
6. **Ask for meaningful test help.** Mateo: “Hey Milo, can you add test cases for an empty array and duplicates? For empty input, expect an empty list.” Milo's reply is live and must be evaluated as received. Hugo confirms through the real UI. Do not dub a desired response over a different product action.
7. **Inspect the tests before claiming completion.** Wait for the authoritative pad state. Mateo identifies the actual assertions: empty input expects `[]`; `[3, 3]` with target 6 expects two different indices. Say neither line unless the corresponding test exists. If Milo produces print-only inputs, stop acceptance and diagnose the product.
8. **Run, observe, and explain.** Mateo runs the code. Hold the complete results long enough to read. After results are verified, Mateo: “Those pass, including empty input. The duplicate case uses indices zero and one, so it isn't reusing the same element.” If the tests differ, use a truthful matching reaction. Hugo can ask what the duplicate case protects against; Mateo explains the lookup-before-insert rule.
9. **Ask the complexity question that the assessment needs.** Hugo: “What's the time and space cost?” Mateo: “Expected linear time, with constant-time dictionary lookups on average. Worst-case extra space is linear because the dictionary can hold one entry per input.” Keep this a human exchange; there is no need to restore the discarded Milo probe sequence.
10. **Use real remaining interview time.** Include actual coding review or a relevant follow-up in the full recording. A near-end time request must follow real elapsed work. If Milo reports two minutes left, use that time for a final question or explicitly explain an early finish. For example, Hugo asks how Mateo would test a change to the no-pair behavior; Mateo explains that the agreed expectation must change in the tests too.
11. **Close once.** Hugo thanks Mateo, ends the call, and moves to assessment. Preserve continuity from the final in-call exchange through End. Compress genuine quiet work with a clearly labelled cut; do not sleep for six minutes and caption it as continued work.
12. **Assess only this session.** Enter notes tied to actual answers and actions. Show the recap's relevant quotes. Explain a recommendation only after the real UI produces it from the actual ratings and evidence. If it cannot, the diagnostic take fails its intended scenario and the finding is reported honestly.

Allow the revised cut to be longer if that is what makes the reasoning readable. Roughly three minutes was the old output duration, not a requirement to squeeze every feature into isolated fragments. UI consent coverage and an intelligible coding interview may also warrant separate films, but retain the requested full flow unless the owner changes that scope.

## Checks that would have caught this take

| Area | Required evidence |
| --- | --- |
| Conversation | Every reply answers an adjacent or explicitly recalled statement; no repeated introduction; every claim of completion follows its observed event. Read the entire composed transcript in order. |
| Tests | Both requested cases have declared expectations and executable comparisons; deliberate incorrect behavior is detected; print-only inputs do not count. Read the authoritative pad/run snapshot rather than guessing from virtualized editor rows. |
| Run | The current run finishes; every requested assertion passes; no `DIFF`, assertion failure, or exception; both participants see that run's result. One `ok` or exit 0 is insufficient. |
| Timeline | Each cut removes an identified interval from this take; it does not invent offscreen progress. There is a result reaction before leaving the run. Remaining time is consistent with the actual session clock. |
| Assessment | Every factual note maps to an actual utterance or recorded action. Complexity cannot be credited without its answer. Do not select ratings solely because an old script selected them. |
| Recap | Relevant, correctly attributed candidate quotes cover the intended competencies. Greetings, farewells, and tool requests are excluded. Evidence checks run in the new branch too. |
| Recommendation | The planned demonstration receives a supported outcome; “no recommendation yet” is a diagnostic finding, not a pass for a recommendation demo. Do not require an arbitrary favorable decision. |
| Audio | Per-line words are intelligible in the final mix, and whole-film order and meaning survive composition. Check overlaps, pauses, and result readability in addition to word presence. |

The existing script disables recap-content, transcript-attribution, and some record checks under `NAME_REQUIRED`. Restore scenario-appropriate checks rather than reducing assertions until a retake is green. Keep UI mechanics, product correctness, and editorial review as separate results; one green count must not hide a failed category.

## What to reuse from ai-3d-storymaker

Use its transcription and final-mix review approach: `library/scripts/soundtrack.py` provides `transcribe` and `check_dialogue`, and `library/toolkit_common/audio_config.py` locates the speech helper. Consult that toolkit's own `AUDIO.md` (in its docs folder) for the local runtime. No Blender scene rebuild is necessary for this browser film.

The important limitation is visible in the implementation: `words_missing` compares a typo-tolerant, order-insensitive pool of words. That can confirm that a line is audible, but it cannot tell whether “Same here” answers the right person, a result was earned, or a scorecard note is true. Borrowing that checker alone would still accept the central editorial defect.

Use two passes: transcribe the whole final film with times and read it as one conversation; then compare final-mix line spans with the intended script to catch missing or mangled words. Compare both against the separate product transcript and actual run/recap state. Keep the uncorrected ASR output beside editorial notes. Do not silently replace the transcript with the script. Listen to suspect spans before attributing odd spelling to voice generation.

## Restart sequence

1. Read the preserved whole-film transcript and product transcript, then this analysis. Treat Film 6 as a failing fixture, not the new screenplay.
2. Write the replacement conversation and state prerequisites for each line, including the empty-input agreement and result-dependent reactions. Remove stale assessment claims. Keep old scenarios separately identifiable so their dialogue cannot leak into the new sequence.
3. Fix requested-case expectations and outcome checking. Test an empty-input failure and a mixed passing/failing run before recording.
4. Fix or select the recap path explicitly. Reproduce the ASR mismatch, exclude irrelevant candidate lines, and verify competency coverage with source quotes. Record which features are live and which are scripted.
5. Rehearse the full intended conversation as text, including the post-call notes. Confirm that no line assumes an event the script does not produce.
6. Record a new version using the real application state and real run results. Preserve previous takes. Keep a manifest of script, source revision, voice takes, timeline, product transcript, run snapshots, and recap output.
7. Review the complete final film with Whisper and the checks above before presenting it. A technical pass and a coherent conversation are both required.

The initial review changed documentation and preserved evidence only. The subsequent implementation and fresh recordings are documented in [FILM-7-CODING-REPORT.md](FILM-7-CODING-REPORT.md). Neither report claims the old rejected film was watched and listened to end to end.
