"""Milo's spoken stand-in for SCRIPTED rehearsals of the Candidates call film (interviews-film-compose.py calls it; never a real take).
The scripted session speaks placeholder tones; this says each of Milo's lines in a third Qwen3-TTS preset that is clearly neither
Hugo ("ryan") nor Mateo ("aiden"), so a rehearsal can be judged by ear. Run with the mlx-audio environment's python:
    <venv>/bin/python scripts/demo/interviews-film-standin.py <lines.json> <cache dir>
<lines.json> is a list of {"key": ..., "text": ...}; each line is written once to <cache dir>/<key>.wav (kept between runs)."""
import sys, json, os, numpy as np, soundfile as sf, mlx.core as mx
from huggingface_hub import snapshot_download
from mlx_audio.tts.utils import load_model

SPEAKER = 'serena'
INSTRUCT = ('A calm, friendly AI assistant, clear and concise, warm and attentive, speaking at an easy conversational pace '
            'with natural intonation.')
SR = 24000

lines = json.load(open(sys.argv[1])); out = sys.argv[2]; os.makedirs(out, exist_ok=True)
todo = [l for l in lines if not os.path.exists(os.path.join(out, f"{l['key']}.wav"))]
if todo:
    m = load_model(snapshot_download("mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit", local_files_only=True))
    for l in todo:
        mx.random.seed(101)
        a = np.concatenate([np.array(r.audio) for r in m.generate(text=l['text'], voice=SPEAKER, instruct=INSTRUCT, lang_code="english", temperature=0.7)])
        sf.write(os.path.join(out, f"{l['key']}.wav"), a, SR, subtype="PCM_16")
        print('stand-in', l['key'], f'{len(a) / SR:.1f} s', l['text'][:60], flush=True)
print(f'stand-in: {len(lines)} lines, {len(todo)} made')
