# System-design film revision

20 November 2026. Follow-up to the owner's review of the coding demo. Source branch: `codex/milo-coding-film`.

## What the old film got wrong

The preserved baseline is `~/Projects/milo-film-handoff/system-design/baseline/`, copied from Claude's Film 3 take 2 before modification. Its whole mixed audio was transcribed again with Whisper and plotted with speaker lanes, waveform, response gaps, and an adjacent-response table.

The old film combined a design interview with voice-contract stress tests. It asked the time twice, repeated the problem, deliberately waited for silence after an unnamed request, then deliberately interrupted a repeated probe. The probe was generic and Mateo's prepared response did not directly explain what he would change. The graph identifies the known two-second Hugo/Milo overlap and the deliberate five-to-six-second waits. The old scorecard had no evidence for either competency. These checks were useful as isolated tests, but produced a confusing demonstration.

## Revised sequence

The `--coherent` recording mode makes one uninterrupted walkthrough: the prompt is on both boards before Hugo reads it; Mateo clarifies reads versus writes and freshness; the requirement notes and diagram are drawn through Excalidraw's controls; the large-account trade-off is noted; Hugo deliberately selects a relevant kit follow-up with **Have Milo ask**; Milo finishes before Mateo answers; then Hugo closes and reviews the evidence.

The voice-contract stress-test branch remains available separately. The coherent mode removes the repeated probe, deliberate interruption, duplicate time request, and unnamed-request silence test. The introduction no longer promises a full hour of content in this short walkthrough. The existing product now supplies the board-specific Milo introduction. Revised actor lines were checked against Whisper before recording. The proactive coach remains scripted; the live request/voice path and extractive OpenAI recap are real. This demo uses a selected kit follow-up, not a claim that Milo generated a novel probe.

The scorecard requires source evidence for both System design and Communication. It shows the sources before the recommendation. A missing recommendation is no longer counted as a successful recommendation check. Quotes are checked for visible containment, and the closing board must match the saved record.

## Visual review matters

Take 2 passed 26 checks but was rejected in visual review: the floating camera tiles hid the workers during the fan-out discussion. The revised staging uses the app's **Minimise** control on both sides before drawing, returns to the selection tool, and checks that the workers' position is unobscured on both boards before the follow-up. This changes normal UI state rather than hiding overlays with CSS.

## Timing review

Both film runners now automatically review their final mixed audio with Whisper and generate `qa/dialogue-timing.png`, `.svg`, `.json`, and `.md`. Speaker attribution comes from the recording's source windows; this is not independent diarization. Solid marks show Whisper word timing, pale bars show source windows, the waveform shows actual mixed audio energy, and the response table preserves the utterances surrounding each gap.

The graph flags gaps below 0.2 seconds and above 1.5 seconds for human review; those are not universal pass/fail thresholds. The script allows at least 600 ms when people change speakers and 800 ms after a question, unless the intervening screen work already supplies that pause. The audit must still check meaning: a question can be left hanging without any physical audio overlap. Rendered frames are sampled at actual discussion cues as well as on a regular grid. Recording stalls abort the take instead of continuing after sleep.

## Final verification

Final delivery: `~/Projects/milo-film-handoff/system-design/t3/system-design.mp4`, **3:55**, **28 checks passed, zero failed**, and no browser page errors. All 235.4 recorded seconds are retained; there are no cuts. The saved record has the same 143 elements as the live board and three snapshots. Both competencies have four source quotes and the scorecard displays Advance. Both expanded quotes fit their containers.

The full Whisper transcript and response table were read; the timing graph and rendered prompt, drawing, follow-up, source-evidence, and closing frames were inspected. The worker-visibility check passed on both sides and the frames confirm the worker is visible during the discussion. Hugo's provided design is visible only on his side. The normal drawing properties panel remains in the candidate editor; it does not cover the fan-out components.

The graph finds **no source-window overlaps**, **0.68 seconds median human response gap**, and **0.606 seconds minimum between human source windows on speaker changes**. Whisper finds no unassigned words. Its one low-similarity line is “read heavy / red-heavy” and “a hundred / 100,” not a changed response. Raw output is retained. The longer gaps show the end confirmation (5.24 s, including the bounded mention check), notes/recap loading (9.54 s), and reading evidence (10.92 s).

Review does not claim a manual listen to every second. Local source ASR errors remain in the quoted evidence; quotes are not silently rewritten. The source labels in the graph come from recorded timing, not independent diarization. The separate rating-form contrast/alignment findings from the coding report are not part of this script repair.

Artifacts include `report.json`, `timeline.json`, `composition.json`, `qa/transcript.txt`, `qa/dialogue-timing.html` (click a graph point or response time to seek the film), PNG/SVG timing plots, JSON measurements, and `qa/acceptance.md`. JavaScript syntax, Python compilation, and whitespace checks passed; the timing player's local video loading and seek interaction were verified. Earlier rejected takes remain marked with their status.

Film SHA-256: `5a5249056cf64d32f9b9248ce0c17baef16aed8f90408712e83bb2a0826ca124`. `delivery-manifest.json` binds the artifact hashes to the source commit. The recording middleware, portal, SFU, and owned containers have been stopped. No production deployment was performed.
