# Film 7: one coherent coding interview

20 November 2026 (revised after owner review). Branch `codex/milo-coding-film`, based on `7a201de17`.

Initial delivery: **Film 7 take 4**, approximately **6:10**, with **26 product checks passed, zero failed, and no browser page errors**. The owner correctly rejected its opening: the pad stayed blank while Hugo read the problem and they discussed empty input. The transcript review and sampled frames missed this timing defect. Its green checks were insufficient for acceptance. The detailed original diagnosis is in [CODING-FILM-RESTART.md](CODING-FILM-RESTART.md).

The revised sequence retains the DSA/Claude Code exchange and the motivated Anthropic news link. They choose Python first; Hugo inserts the question and starter; both screens must visibly contain them before the problem audio can start. A missing prompt now aborts the take. The review also captures frames at the actual problem, empty-input, approach, and return-value dialogue cues rather than relying only on a 30-second sampling grid.

The owner also identified the awkward closing turn: Hugo announced a final question, but Mateo asked Milo about time before Hugo could ask it. The revised sequence puts Mateo's clock check first, followed by Hugo's decision to finish early, his actual final question, and Mateo's answer. The premature announcement is removed.

Final revised delivery: **Film 7 take 8**, **6:13**, **28 checks passed, zero failed**, no browser page errors. The full Whisper transcript, response graph, and cue-specific frames were reviewed. The earlier take 7 passed the product checks but prompted the extra response pauses.

The lingering Milo card came from the recording monitor itself: it opened the suggestion every 700 ms. The monitor now reads the waiting button without clicking. Hugo explicitly accepts or skips a suggestion at a relevant boundary; the wrap-up verifies no card is left open.

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
uv run --offline --no-project --python 3.10 --with faster-whisper --with matplotlib python \
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

The revised delivery is `~/Projects/milo-film-handoff/film7/t8/`:

- `interviews-call.mp4`: 373.1 seconds from 376.5 seconds recorded. Its only cut removes 3.4 seconds while the invitation opens. No work or closing exchange is cut.
- `report.json`, `timeline.json`, `composition.json`, `milo-pad.py`, and `product-transcript.txt`: checks, timing provenance, actual generated cases, and saved product transcript.
- `qa/transcript.txt` and `.json`: whole-film Whisper output, preserved uncorrected.
- `qa/dialogue-timing.html`: local video player with a clickable graph and adjacent-response table. PNG, SVG, JSON, and Markdown versions are alongside it. The local player was tested for seeking and for keeping the video visible after selecting a response.
- `qa/acceptance.md`, `qa/review.md`, and PNG frames: the completed review, including the exact two-minute frame, final question, and expanded evidence.

The prompt and Python starter are visible on both sides before the problem starts at about 1:42. The DSA/Claude Code exchange and motivated Anthropic news link remain. At the close, the time check finishes before Hugo introduces and asks his final question; Mateo answers directly. The suggestion card is closed, with a visible Skip receipt.

The graph shows **no source-window voice overlaps**, a **0.74-second median human response gap**, and at least **0.601 seconds between consecutive human source clips when the speaker changes**. Whisper occasionally places adjacent word boundaries at the same timestamp; those approximate boundaries are not claims of overlapping speech. Milo's measured word-to-word response gaps are 3.74 and 2.48 seconds. Gaps over five seconds correspond to confirmation/test writing (7.12 s), notes/recap loading (5.70 s), and visibly reading evidence (12.90 s).

Both real runs pass. The actual generated cases include `([], 0) -> []`, `([3, 3], 6) -> [0, 1]`, and `([1, 5, 1, 5], 10) -> [1, 3]`; the candidate adds negative-number and no-pair assertions. All three competencies have four source quotes and the recommendation is Advance. Both long quotes opened in this take wrap and fit; the remaining first quote is short. The exported frame confirms the long Communication quote is fully visible.

Review means a full transcript/response-table read and key frame inspection, not a manual listen to every second. Raw ASR spelling errors remain visible in both transcripts; no evidence was silently rewritten. The six separate rating-form audit findings described above are still outside this repair.

Film SHA-256: `f00850c5d3c103000161ce499217c63d14c71045a31d1398cd1935a6eab066ba`. Launch scripts and voice assets are retained outside the old scratchpad. The source revision and artifact hashes are in `delivery-manifest.json`. No production deployment was performed.
