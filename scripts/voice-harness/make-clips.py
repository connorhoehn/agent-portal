"""Scenario speech for the voice harness: one Qwen3-TTS CustomVoice take per line of lines.json, trimmed to the speech
(30 ms margin) so a clip's end IS its speech end, written as 24 kHz mono PCM16 WAV plus clips.json (seconds per clip).
Run with the mlx-audio environment's python (the same one scripts/demo/interviews-film-voices.py uses):
    <venv>/bin/python scripts/voice-harness/make-clips.py scripts/voice-harness/lines.json <out-dir> [--only id,id]
Keep the clips outside the repo (TTS output is never committed)."""
import sys, json, os, numpy as np, soundfile as sf, mlx.core as mx
from huggingface_hub import snapshot_download
from mlx_audio.tts.utils import load_model

SR = 24000
spec = json.load(open(sys.argv[1])); out = sys.argv[2]; os.makedirs(out, exist_ok=True)
only = set(sys.argv[sys.argv.index('--only') + 1].split(',')) if '--only' in sys.argv else None
m = load_model(snapshot_download("mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit", local_files_only=True))
index_path = f"{out}/clips.json"
index = json.load(open(index_path)) if os.path.exists(index_path) else {}


def trim(a):
    fr = int(0.01 * SR); e = np.array([np.sqrt(np.mean(a[i:i + fr] ** 2)) for i in range(0, len(a) - fr, fr)])
    on = np.where(e > 0.01)[0]
    if len(on) == 0: return a
    lo = max(0, (on[0] - 3) * fr); hi = min(len(a), (on[-1] + 4) * fr)
    return a[lo:hi]


for n, (lid, (who, text)) in enumerate(spec["lines"].items()):
    if only is not None and lid not in only: continue
    v = spec["voices"][who]
    mx.random.seed(200 + n)
    a = np.concatenate([np.array(r.audio) for r in m.generate(text=text, voice=v["speaker"], instruct=v["instruct"], lang_code="english", temperature=0.8)])
    a = trim(a.astype(np.float32))
    peak = float(np.max(np.abs(a))) or 1.0
    a = a * min(1.0, 0.7 / peak)
    sf.write(f"{out}/{lid}.wav", a, SR, subtype="PCM_16")
    index[lid] = dict(who=who, text=text, seconds=round(len(a) / SR, 3))
    print(lid, index[lid]["seconds"], flush=True)
json.dump(index, open(index_path, "w"), indent=1)
