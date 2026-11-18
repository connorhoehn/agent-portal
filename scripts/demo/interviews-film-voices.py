"""Voices for the Candidates call film (scripts/demo/interviews-call-film.mjs): Qwen3-TTS CustomVoice (mlx-audio), one preset speaker
per person with a style `instruct`, three seeds per line, the take with the widest pitch movement kept (a plain autocorrelation F0
track, its spread in semitones). Run with the mlx-audio environment's python:
    <venv>/bin/python scripts/demo/interviews-film-voices.py scripts/demo/interviews-film-lines.json <dir>
Writes <dir>/takes/*.wav and <dir>/takes.json; the film script trims and resamples the kept takes (48 kHz mono PCM16)."""
import sys, json, os, numpy as np, soundfile as sf, mlx.core as mx
from huggingface_hub import snapshot_download
from mlx_audio.tts.utils import load_model
spec = json.load(open(sys.argv[1])); out = sys.argv[2]; os.makedirs(f"{out}/takes", exist_ok=True)
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
res = {}
for lid, (who, text) in spec["lines"].items():
    v = spec["voices"][who]; best = None; takes = []
    for s in range(3):
        seed = 100 + 7 * s + len(res)
        mx.random.seed(seed)
        a = np.concatenate([np.array(r.audio) for r in m.generate(text=text, voice=v["speaker"], instruct=v["instruct"], lang_code="english", temperature=0.8)])
        p = os.path.abspath(f"{out}/takes/{lid}-s{seed}.wav"); sf.write(p, a, SR, subtype="PCM_16")
        sc, med, ev = score(a); dur = len(a) / SR
        # a take far longer than its words is likely a ramble/garble: penalise
        ok = dur < 0.11 * len(text) + 2.0
        takes.append(dict(file=p, seed=seed, f0_st_std=round(sc, 2), f0_median=round(med, 1), energy_cv=round(ev, 2), seconds=round(dur, 2), plausible=ok))
        if ok and (best is None or sc > best["f0_st_std"]): best = takes[-1]
    best = best or takes[0]
    res[lid] = dict(who=who, text=text, kept=best, takes=takes); print(lid, json.dumps(best), flush=True)
json.dump(res, open(f"{out}/takes.json", "w"), indent=1)
