# The deck voice film: report (27 November 2026)

**No live take exists.** The voice provider rejected the key in `middleware/.env`: the film's middleware asked for a voice session and the provider answered 401. Calling the provider's model list with the same key also gave 401, so the key itself is refused; it is not a problem with the live model or the session request. The owner's rule is that a film is a live test with the real assistant, so no take was recorded with a scripted assistant. The only artefact is the rehearsal: the whole story with the voice never turned on.

## What was built

- `scripts/demo/deck-voice-film.mjs`: the film. It starts its own mock middleware (port 4190) and portal (port 5290), refuses to start if either port is in use, and stops only the process groups it started. One Chromium at 1440 by 900 is recorded. The microphone is a WebAudio stream that each spoken line is played into, the same way as `scripts/demo/interviews-call-film.mjs`. The middleware runs with `MOCK_VOICE=0`, so a session is always the live provider and never the scripted one. It has four modes: a take, `--rehearse` (no voice, no spend), `--probe` (one minimal session start) and `--compose-only`.
- How the assistant's voice is captured. The navigator's audio reaches the page over WebRTC, as the peer connection's remote audio track. An init script wraps `RTCPeerConnection`. When the track arrives, a `MediaRecorder` records that stream (Opus in WebM) and passes each half-second slice to the film script, which writes it to `assistant-<n>.webm` with the moment recording started. The same wrapper listens to the `oai-events` data channel in both directions, with audio payloads dropped. That gives the assistant's output transcript, what it heard, and every tool call and result, each with a timestamp. The take was never run, so this capture path has not been tested end to end.
- `scripts/demo/deck-voice-film-lines.json`: Vera's 14 lines (the story's lines, a clearer retry wording for each request, and "Yes, confirm."). The takes were made with `scripts/demo/interviews-film-voices.py` unchanged, using the Qwen3-TTS CustomVoice preset speaker `serena`. That is a built-in preset, not a clone of anyone's voice. Whisper heard every kept take correctly except "slide two to", which the base model hears as "slide 22". The retry wording avoids that phrase.
- `scripts/demo/deck-voice-film-compose.py`: `compose` lays the page recording over a caption bar for each scene and mixes Vera's lines with the assistant's recordings, each placed at the moment it was played or received. Nothing is cut, so every wait in the film is a real wait. `review` transcribes the final mix with faster-whisper, writes a table of each request's measured times and extracts frames.

## The story, adjusted to the real deck

The status-update example has 7 slides: title, agenda, key figures, chart, timeline, image and closing. After "add a timeline after slide three", the template's chart is slide five, not slide four. The chart line therefore says "put a pie chart on slide five". Saying slide four would have turned the new timeline into a chart.

Vera (org-leader) can read the spend report: the deck's chart-reports list returned all five reports to her, `spend-by-initiative` included.

## The rehearsal (no voice; each voice edit applied through the operations API)

The rehearsal recording is in the film folder outside the repository, under `deck-voice/rehearse3`: `deck-voice.mp4` (4 min 16 s), `timeline.json`, `report.json` and `qa/` with the review and frames. It runs the whole story. Where the assistant would confirm a change, the same edit is posted to the deck's operations endpoint, so the later scenes work on the same deck. Its times are not voice latencies: each "change visible" includes a page reload.

| request | line ended | change visible | product result (API check on the head revision) |
|---|---|---|---|
| Show me a few example slides | 8.1 s | (no voice) | the example tiles were clicked by hand |
| Add a timeline slide after slide three | 45.5 s | 66.1 s | right: slide 4 is a timeline, "Plan" |
| Rename slide two to "Where we are this month" | 72 s | about 92 s | right: slide 2 has that title |
| Pie chart from spend by initiative on slide five | 100 s | about 120 s | right: pie on slide 5, five initiatives plus Other, source `report:spend-by-initiative` |
| What reports can I use? | 164 s | (no voice) | not asked |
| Remove slide seven | 167 s | about 188 s | right: the image slide is gone |

The steps done by hand passed. The layout gallery opened in place, and a key-figures slide was added at the end with a title and two figures and saved. Present folded both sidebars and moved through slides 4, 5, 6 and 7, and Escape exited. The PDF downloaded (38,581 bytes, a valid PDF). The film's own check that the new slide's preview updated reported false, but the frames show the thumbnail redrawn with "$41k" and "92%". The check reads the thumbnail's text, and the thumbnail apparently has none to read. That is a fault in the film script, not the product.

## What the frames show (rehearsal)

- New presentation: the page opens on "From this initiative's facts", not on the examples, so "From an example" has to be clicked to show the gallery.
- The pie on slide five: a clear pie with a legend (LLM Application Platform 28%, Auth Migration 28%, Observability 16%, Inference 7%, Cost Optimization 5%, Other 16%). There are three product defects on this slide:
  - **The title is wrong.** It keeps the template's "Depots live by week", because `set_chart` does not change the title.
  - **Two slices share a colour.** "Other" is drawn in the same indigo as "LLM Application Platform".
  - **The speaker notes show a raw timestamp**, for example "read from the spend-by-initiative report at 2026-11-28T00:05:07.951Z".
- Present: the assistant pane and the slide list are gone, the primary rail is already folded to its icon strip, and the slide fills the left part with speaker notes beside it.
- Download: the menu opens inline under Download with PowerPoint, PDF and Images.
- Another defect, which caused a save failure in the first rehearsal: a slide added from the gallery has an empty title. Saving it fails with the raw message "invalid DeckSpec: slides[1].title: required", and Download stays disabled until the deck is saved. The film now types a title first.

## Failures and retries

- No take was made, so nothing was asked of the live assistant: there are no replies, latencies or confirm-card timings to report. The planned retry wordings (`*_b` lines) were never used.
- The probe started one session. The provider refused the mint (401), so no audio flowed and the voice log records `mint-failed`. No paid minutes were used.
- Bugs fixed in the film script on the way:
  - Node's `fetch` refuses port 4190, which is on the WHATWG bad-ports list. The readiness check now uses `node:http`.
  - Chromium blocks the same port, so the browser is launched with `--explicitly-allowed-ports=4190` (the realtime socket goes straight to the middleware).

## Cost

Zero session minutes. The one mint attempt was refused before a session existed, and no spend hold was settled.

## How to re-record

1. Put a working provider key in `middleware/.env` (never in a tracked file).
2. Run the probe: `node scripts/demo/deck-voice-film.mjs --out <film folder>/deck-voice/probe --probe`. It must report `PASS probe`.
3. Optional, only if the lines file changes: make the voices with `<qwen venv>/bin/python scripts/demo/interviews-film-voices.py scripts/demo/deck-voice-film-lines.json <film folder>/deck-voice/voices`.
4. Run the take: `node scripts/demo/deck-voice-film.mjs --out <film folder>/deck-voice/t1 --voices <film folder>/deck-voice/voices`. It composes `deck-voice.mp4` and runs the review into `qa/`.

Read `report.json` (each request's line end, first reply, card, confirm and visible times, the assistant's words and what it heard) and `qa/review.md` before accepting a take. One take is about four and a half minutes, under the daily cap of 60 voice minutes per person.
