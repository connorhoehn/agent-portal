"""Local per-person transcription for the voice harness: faster-whisper `base` on CPU (int8), the settings of the
qwen3-voice-clone skill's whisper_transcribe.py, run as a simulated stream.
    uv run --offline --no-project --python 3.10 --with faster-whisper python -I scripts/voice-harness/stream-whisper.py <clips-dir> <out.json> [--step 0.5] [--ids q01,n01]
For every clip: (1) a whole-clip pass with word timestamps gives the time the word "Milo" ENDS in the clip (the reference);
(2) the stream: at every `step` seconds of audio (the clip, then 1 s of silence) the audio so far (last 10 s at most) is
transcribed again, and the first pass whose text holds the name counts. Its delay = (audio time of that pass + its compute
time) - the name's end. Prints one line per clip and a summary; writes the rows to <out.json>."""
import sys, json, os, time, re, wave, numpy as np
from faster_whisper import WhisperModel

clips, out = sys.argv[1], sys.argv[2]
step = float(sys.argv[sys.argv.index('--step') + 1]) if '--step' in sys.argv else 0.5
ids = sys.argv[sys.argv.index('--ids') + 1].split(',') if '--ids' in sys.argv else None
beam = int(sys.argv[sys.argv.index('--beam') + 1]) if '--beam' in sys.argv else 1
# --hint: bias the stream toward the name (faster-whisper's initial_prompt), as a hotword list would
hint = dict(initial_prompt='Milo is the meeting assistant. Hey Milo.') if '--hint' in sys.argv else {}
index = json.load(open(f"{clips}/clips.json"))
m = WhisperModel('base', device='cpu', compute_type='int8', local_files_only=True)
NAME = re.compile(r"\bmilo\b", re.I)
rows = []
for cid, meta in index.items():
    if ids and cid not in ids: continue
    with wave.open(f"{clips}/{cid}.wav") as w: sr = w.getframerate(); a = np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768
    a16 = np.interp(np.arange(0, len(a), sr / 16000), np.arange(len(a)), a).astype(np.float32)  # whisper wants 16 kHz
    segs, _ = m.transcribe(a16, language='en', beam_size=5, word_timestamps=True)  # the reference pass: no hint
    words = [w for s in segs for w in s.words]
    full = ''.join(w.word for w in words).strip()
    name_end = next((w.end for w in words if NAME.search(w.word)), None)
    padded = np.concatenate([a16, np.zeros(16000, np.float32)])
    hit = None; passes = 0; compute = []
    t = step
    while t <= len(padded) / 16000 + 1e-6:
        lo = max(0, int((t - 10) * 16000)); chunk = padded[lo:int(t * 16000)]
        c0 = time.perf_counter(); segs, _ = m.transcribe(chunk, language='en', beam_size=beam, vad_filter=False, **hint)
        text = ''.join(s.text for s in segs).strip(); dt = time.perf_counter() - c0; passes += 1; compute.append(dt)
        if hit is None and NAME.search(text): hit = dict(audio_s=round(t, 2), compute_s=round(dt, 3), text=text)
        if hit: break
        t += step
    delay = round(hit['audio_s'] + hit['compute_s'] - name_end, 3) if hit and name_end is not None else None
    row = dict(id=cid, text=meta['text'], whisper=full, name_heard=bool(NAME.search(full)), name_end_s=name_end, clip_s=meta['seconds'],
               stream_hit=hit, delay_s=delay, mean_compute_s=round(float(np.mean(compute)), 3) if compute else None)
    rows.append(row)
    print(cid, 'name' if row['name_heard'] else 'NO-NAME', 'delay', delay, 'compute', row['mean_compute_s'], '|', full[:70], flush=True)
json.dump(rows, open(out, 'w'), indent=1)
d = sorted(r['delay_s'] for r in rows if r['delay_s'] is not None)
if d: print('SUMMARY step', step, 'n', len(d), 'of', len(rows), 'median', d[len(d) // 2], 'p90', d[min(len(d) - 1, int(0.9 * len(d)))], 'heard', sum(r['name_heard'] for r in rows))
