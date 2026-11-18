"""Voices for the Candidates call film (scripts/demo/interviews-call-film.mjs): Qwen3-TTS CustomVoice (mlx-audio), one preset speaker
per person with a style `instruct`, three seeds per line. Run with the mlx-audio environment's python:
    <venv>/bin/python scripts/demo/interviews-film-voices.py scripts/demo/interviews-film-lines.json <dir> [--only id,id,...]
Writes <dir>/takes/*.wav and <dir>/takes.json (with --only, only those lines are made again; the others are kept).

Which take is kept: a take far longer than its words is a ramble and is dropped; so is one whose speaking pitch strays more than
MAX_PITCH_STRAY semitones from that speaker's usual pitch (the median over every take of every line). The demo film's first take
of Hugo's first line sat at 265 Hz against his 120 to 150 Hz elsewhere, an octave up, picked for its wide pitch movement, and sounded
strained. Of the takes left, the one with the widest pitch movement (a plain autocorrelation F0 track, its spread in semitones)
is kept, so the delivery stays lively. The film script trims, levels (-16 LUFS) and resamples the kept takes (48 kHz mono PCM16)."""
import sys, json, os, numpy as np, soundfile as sf, mlx.core as mx
from huggingface_hub import snapshot_download
from mlx_audio.tts.utils import load_model

MAX_PITCH_STRAY = 3.0
spec = json.load(open(sys.argv[1])); out = sys.argv[2]; os.makedirs(f"{out}/takes", exist_ok=True)
only = set(sys.argv[sys.argv.index('--only') + 1].split(',')) if '--only' in sys.argv else None
m = load_model(snapshot_download("mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit", local_files_only=True))
print("speakers", m.get_supported_speakers(), flush=True)
SR = 24000


def f0_track(a):
    fr, hop = int(0.04 * SR), int(0.01 * SR); f0 = []; rms = []
    for i in range(0, len(a) - fr, hop):
        x = a[i:i + fr]; e = float(np.sqrt(np.mean(x * x))); rms.append(e)
        if e < 0.02: continue
        x = x - x.mean(); c = np.correlate(x, x, 'full')[fr - 1:]
        lo, hi = SR // 400, SR // 70
        k = lo + int(np.argmax(c[lo:hi]))
        if c[k] > 0.45 * c[0]: f0.append(SR / k)
    return np.array(f0), np.array(rms)


def score(a):
    f0, rms = f0_track(a)
    if len(f0) < 10: return 0, 0, 0
    st = 12 * np.log2(f0 / np.median(f0))
    return float(np.std(st)), float(np.median(f0)), float(np.std(rms) / (np.mean(rms) + 1e-9))


old_path = f"{out}/takes.json"
res = json.load(open(old_path)) if os.path.exists(old_path) else {}
for n, (lid, (who, text)) in enumerate(spec["lines"].items()):
    if only is not None and lid not in only: continue
    v = spec["voices"][who]; takes = []
    for s in range(3):
        seed = 100 + 7 * s + n
        mx.random.seed(seed)
        a = np.concatenate([np.array(r.audio) for r in m.generate(text=text, voice=v["speaker"], instruct=v["instruct"], lang_code="english", temperature=0.8)])
        p = os.path.abspath(f"{out}/takes/{lid}-s{seed}.wav"); sf.write(p, a, SR, subtype="PCM_16")
        sc, med, ev = score(a); dur = len(a) / SR
        takes.append(dict(file=p, seed=seed, f0_st_std=round(sc, 2), f0_median=round(med, 1), energy_cv=round(ev, 2), seconds=round(dur, 2), plausible=dur < 0.11 * len(text) + 2.0))
    res[lid] = dict(who=who, text=text, takes=takes)
    print(lid, 'made', [(t['f0_median'], t['f0_st_std'], t['seconds']) for t in takes], flush=True)

# Keep one take per line, judged against the speaker's usual pitch.
res = {k: r for k, r in res.items() if k in spec["lines"]}
usual = {}
for who in {r['who'] for r in res.values()}:
    meds = [t['f0_median'] for r in res.values() if r['who'] == who for t in r['takes'] if t['plausible'] and t['f0_median'] > 0]
    usual[who] = float(np.median(meds)) if meds else 0.0
for lid, r in res.items():
    u = usual[r['who']]
    stray = lambda t: abs(12 * np.log2(t['f0_median'] / u)) if u > 0 and t['f0_median'] > 0 else 99.0
    ok = [t for t in r['takes'] if t['plausible'] and stray(t) <= MAX_PITCH_STRAY]
    r['kept'] = max(ok, key=lambda t: t['f0_st_std']) if ok else min(r['takes'], key=stray)
    r['kept_why'] = 'widest pitch movement near the usual pitch' if ok else 'closest to the usual pitch (no take was near it)'
print('usual pitch', {k: round(v, 1) for k, v in usual.items()})
for lid, r in res.items(): print(lid, r['kept']['f0_median'], r['kept']['f0_st_std'], r['kept_why'])
json.dump(res, open(old_path, "w"), indent=1)
