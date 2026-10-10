#!/usr/bin/env python3
"""Local natural speech from the exact storyboard, using existing MLX-Audio.

This script requires an already downloaded, pinned Kokoro model and voices.
It neither installs packages nor downloads weights, and creates no video.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import time

ROOT = Path(__file__).resolve().parents[2]
MODEL_ID = "mlx-community/Kokoro-82M-bf16"
MODEL_REVISION = "a71e4d38b236d968966a2002c4c895dbd12b1c3c"
PINNED_FILES = {
    "config.json": "5abb01e2403b072bf03d04fde160443e209d7a0dad49a423be15196b9b43c17f",
    "kokoro-v1_0.safetensors": "4e9ecdf03b8b6cf906070390237feda473dc13327cb8d56a43deaa374c02acd8",
    "voices/af_heart.safetensors": "2c1c733b0e6576c810e268d3e440c21dea4e0f0131a3ba4cfc98d7fe6136d094",
    "voices/af_bella.safetensors": "112d310468cbb3cf23404d3d0b50ad3adf017b87bf38bf9edd15f4ad572df6a3",
}
VOICES = {"u-vera": ("af_heart", 0.95), "u-nora": ("af_bella", 0.95)}


def digest(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def normalized_words(text):
    return re.findall(r"[a-z0-9]+", text.lower().replace("’", "'"))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True, help="Local pinned Kokoro directory")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--storyboard", type=Path, default=ROOT / "docs/demos/work-huddles/storyboard.json")
    parser.add_argument("--turn", action="append", help="One or more exact turn IDs; default is all turns")
    parser.add_argument("--asr-model", type=Path, help="Optional existing local faster-whisper model")
    args = parser.parse_args()
    story = json.loads(args.storyboard.read_text())
    turns = [turn for scene in story["scenes"] for turn in scene["turns"]]
    if args.turn:
        if set(args.turn) - {turn["id"] for turn in turns}:
            raise ValueError("Unknown requested turn ID")
        turns = [turn for turn in turns if turn["id"] in args.turn]
    for turn in turns:
        if (not re.fullmatch(r"[a-z][a-z0-9-]{0,70}", turn["id"])
                or turn["actor"] not in VOICES or not turn.get("speech", "").strip()):
            raise ValueError(f"Invalid turn: {turn.get('id')}")
    for name, expected in PINNED_FILES.items():
        file = args.model / name
        if not file.is_file() or digest(file) != expected:
            raise ValueError(f"Missing or changed pinned model file: {file}")

    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
    import mlx.core as mx
    import numpy as np
    import soundfile as sf
    from mlx_audio.tts.generate import detect_speech_boundaries
    from mlx_audio.tts.utils import load_model

    model = load_model(args.model.resolve())
    asr = None
    if args.asr_model:
        if not (args.asr_model / "model.bin").is_file():
            raise ValueError("ASR model must be an existing local faster-whisper model")
        from faster_whisper import WhisperModel
        asr = WhisperModel(str(args.asr_model), device="cpu", compute_type="int8",
                           cpu_threads=4, local_files_only=True)
    args.out.mkdir(parents=True, exist_ok=True)
    results = []
    for turn in turns:
        voice, speed = VOICES[turn["actor"]]
        started = time.time()
        chunks = []
        for result in model.generate(text=turn["speech"], voice=str((args.model / f"voices/{voice}.safetensors").resolve()),
                                     speed=speed, lang_code="a"):
            mx.eval(result.audio)
            chunks.append(np.asarray(result.audio).reshape(-1))
        audio = np.concatenate(chunks)
        rate = model.sample_rate
        start, end = detect_speech_boundaries(audio, rate, window_duration=0.05,
                                             energy_threshold=0.006, margin_factor=4)
        audio = audio[start:end]
        if not 0 < len(audio) / rate <= 120:
            raise ValueError(f"Unexpected audio duration: {turn['id']}")
        file = args.out / f"{turn['id']}.wav"
        sf.write(file, audio, rate, subtype="PCM_16")
        (args.out / f"{turn['id']}.txt").write_text(turn["speech"] + "\n")
        peak = float(np.max(np.abs(audio)))
        proof = {
            "kind": "local-natural-speech-generation", "clipId": turn["id"], "actor": turn["actor"],
            "text": turn["speech"], "voice": voice, "speed": speed,
            "model": MODEL_ID, "modelRevision": MODEL_REVISION,
            "modelSha256": PINNED_FILES["kokoro-v1_0.safetensors"],
            "voiceSha256": PINNED_FILES[f"voices/{voice}.safetensors"],
            "sampleRate": rate, "seconds": len(audio) / rate,
            "peakDbFS": 20 * float(np.log10(peak)), "generationSeconds": time.time() - started,
            "wavSha256": digest(file), "videoStatus": "not generated",
            "qualityReview": "Voice naturalness and lip sync require inspection of the actual audio/video.",
        }
        if asr:
            segments, _ = asr.transcribe(str(file), language="en", beam_size=5, vad_filter=False,
                                         condition_on_previous_text=False)
            transcript = " ".join(segment.text.strip() for segment in segments)
            proof["independentAsr"] = {"transcript": transcript,
                                       "normalizedWordsMatch": normalized_words(transcript) == normalized_words(turn["speech"]),
                                       "limit": "ASR agreement corroborates words; it does not prove naturalness or lip sync."}
        (args.out / f"{turn['id']}-proof.json").write_text(json.dumps(proof, indent=2) + "\n")
        results.append(proof)
        print(f"Generated {turn['id']}: {proof['seconds']:.2f}s, {voice}, ASR {proof.get('independentAsr', {}).get('normalizedWordsMatch', 'not checked')}", flush=True)
    (args.out / "speech-manifest.json").write_text(json.dumps({
        "kind": "local-natural-speech-generation", "videoStatus": "not generated",
        "model": MODEL_ID, "revision": MODEL_REVISION, "results": results,
    }, indent=2) + "\n")


if __name__ == "__main__":
    main()
