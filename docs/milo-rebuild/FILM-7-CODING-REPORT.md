# Film 7: one coherent coding interview

20 November 2026. Branch `codex/milo-coding-film`, based on `7a201de17`.

Final take: **Film 7 take 4**, approximately **6:10**, with **26 product checks passed, zero failed, and no browser page errors**. Its complete Whisper transcript and key rendered frames were reviewed. All three competencies have four source quotes, both code runs pass, and the scorecard displays Advance. This report supersedes the old Film 5 acceptance claims; the rejected Film 6 remains preserved as evidence. The detailed diagnosis is in [CODING-FILM-RESTART.md](CODING-FILM-RESTART.md).

## Product changes

Requested Two Sum inputs with no pair now become executable tests with an explicitly marked `[]` assumption. The dialogue agrees on that extra behavior before requesting the empty-array test. An explicitly conflicting request such as “return null” remains unresolved rather than being silently converted to `[]`. Completion text distinguishes checked cases from inputs that still lack expected results.

Generated Python and JavaScript/TypeScript test blocks fail the process if any comparison fails. Regression tests execute an intentionally wrong empty return alongside a passing duplicate case: the process must fail. Replacing the wrong return with `[]` must pass. The film reads the complete saved Milo pad snapshot, parses the actual Python case list, requires a real assertion, and checks every result on both screens. A print-only edge input no longer satisfies the film's coverage check.

The deterministic recap recognizes a six-word question opening with one ASR word edit, while retaining exact matching for short titles. It can identify substantive code-quality reasoning after a recognized question. Courtesy-only lines and Milo-directed requests cannot supply evidence; missing evidence remains uncovered.

The live recap uses an independently selected OpenAI backend. It selects exact candidate quotes with transcript sequence numbers, then the application adds a fixed neutral label. The existing source, speaker, personal-information, and judgment guards still apply. It does not receive ratings or code/run contents. The default Bedrock/scripted selection is unchanged unless `INTERVIEWS_RECAP_MODEL=openai` is set. The live pad writer is independently enabled with `MILO_PAD_WRITER_LIVE=1`.

Expanded scorecard evidence now sits outside `KeyValue`, whose single-line values inherited `white-space: nowrap` and clipped long quotes. The rating remains a compact value; evidence is a separate multiline disclosure. A layout regression reproduces the old clipping and verifies the entire expanded quote fits at 1280 and 900 pixels in light and dark themes, for both draft and submitted scorecards. The film also measures expanded quote containment.

## The failure a live take caught

Take 1 passed 25 product checks with live Milo turns but scripted pad writing and recap. It established the new sequence and executable-test behavior; it was not the final live-model proof.

Take 2 used live model-generated tests and recap. Its tests passed, but its recap covered only one competency, so the take failed two checks. A diagnostic replay showed summaries combining facts from several lines while citing only one. The single-line grounding validator correctly dropped them. Some selections also cited requests to Milo. Weakening that validator would have hidden the problem.

The extractive backend removes free-form summaries from the model's output schema. Two live replays of the failed transcript then covered all three competencies. A live negative control containing only greetings, a time request, and a farewell produced no evidence for any competency. The implementation therefore preserves a legitimate “no recommendation yet” outcome instead of forcing coverage.

Take 3 passed all 26 product checks. Its visual review caught the long-quote clipping in the draft scorecard, prompting the layout repair and a fresh take rather than accepting the green count alone.

## Conversation and recording

The new named coding scenario is recorded from one fresh call. “Same here” immediately answers the Claude Code exchange. The complete problem is introduced once, including distinct indices and the one-pair promise. The speakers agree on the no-pair extension, explain lookup before insertion, trace an example, request tests, inspect them, run them, and react to the actual result. The interviewer asks about complexity and negatives; the candidate adds two assertions and runs again. The time query reports actual elapsed time, followed by an explicit decision to finish early and one final technical question.

There is no six-minute artificial work interval. The post-call notes describe the reasoning and tests that occurred. Source quotes for all three competencies are opened in the film before the recommendation is read.

Actor speech is prerecorded Qwen audio and the cameras are visibly fictional. Generic existing clips are reused only where their exact text fits; all footage and product state come from the new call. Milo's turns, pad writing, and recap are live. The proactive coach and interview storage remain local mock components; Python runs execute in Docker. This is a local integration demonstration, not a production deployment or a real candidate assessment.

## Repeatable review

`interviews-call-film.mjs` now runs `interviews-film-review.py` after composition. The review uses the same cached local faster-whisper workflow as ai-3d-storymaker on the **entire final audio mix**. It writes timestamped text and word data, ordered per-line comparisons, silence intervals, frame samples, and a review document. `composition.json` records the cuts actually applied, so review timestamps match the delivered film. A film hash binds the review to its input. Existing reviews are not overwritten.

Run the review independently with:

```sh
uv run --offline --no-project --python 3.10 --with faster-whisper python \
  scripts/demo/interviews-film-review.py /absolute/path/to/a/fresh/take
```

The automated output explicitly requires a full transcript read and visual inspection. Word similarity does not certify conversational sense, and a green UI report is not editorial acceptance. Missing audio, stale voice text, incorrect test results, absent competency evidence, or other failed product checks cause a nonzero recording exit.

## Validation

- Full interviews run: 109 suites passed, one suite had a socket-hangup failure, one suite skipped; 1,816 tests passed, one failed, 35 skipped. The failing gate suite then passed all four tests in isolation.
- After the final product edits: all six Milo-tool suites passed (80 tests), all eight recap suites passed (105 tests), and the additional provider/prompt-version service check passed with its 27-test suite.
- Middleware and portal typechecks passed. The film proof helper's two tests passed; JavaScript syntax and Python compilation checks passed.
- All eight expanded-evidence layout cases pass. The exact scorecard route's DOM audit measured four resting states with zero resting-gate findings and zero unclassified composer policies. It still reports six separate deep/advisory findings in the initial rating form: placeholder contrast (4.2:1 versus 4.5:1) and narrow label/description baseline alignment. Those unchanged rating-form findings are not claimed fixed by the evidence repair.
- The live negative control leaves all competencies uncovered. Two diagnostic replays of the failed live transcript cover all three using source-checked quotes.

## Final artifacts and review

The local delivery is `~/Projects/milo-film-handoff/film7/t4/`:

- `interviews-call.mp4`: the final film, 369.9 seconds from 372.5 seconds recorded. Its only cut removes about 2.7 seconds while the invitation opens; no interview work or ending is spliced out.
- `report.json`, `timeline.json`, `composition.json`, `milo-pad.py`, and `product-transcript.txt`: actual product state, executable-case snapshot, and edit provenance.
- `qa/transcript.txt` and `qa/transcript.json`: uncorrected whole-film Whisper output, with word times and the film's SHA-256.
- `qa/acceptance.md`, `qa/review.md`, and sampled PNG frames: the completed editorial/visual review. This is a transcript and frame review, not a claim of listening to every second manually.

The three silences longer than five seconds correspond to confirmation and writing tests, entering notes/loading the recap, and visibly reading source quotes. There is no fabricated six-minute work interval. Whisper spelling differences for Claude Code, Two Sum, and the spoken number list are preserved in the raw output. “Same here” occurs once in the right exchange; the problem is introduced once; both successful runs receive a reaction; the ending and recommendation match the product.

All three expanded source quotes measured `white-space: normal` and fit their containers in the final call. The source review and recommendation are also visibly legible in the exported frames. The separate six rating-form audit findings above remain documented, not silently waived.

The final film's SHA-256 is `c613e262d718c5be41a8370a7a3f24546c74f9027d6ab7a106404cb5dd161517`. Voice files and launch scripts are preserved in `film7/`, outside Claude's temporary scratchpad. The isolated middleware, portal, SFU, Redis, DynamoDB, and platform API used for recording have been stopped; ports 4182, 5282, and 3912 and the `ivsnappy-*` containers were checked clear. No production deployment was performed.
