#!/usr/bin/env python3
"""Render the storyboard's fictional portraits with its verified local speech.

Runs an existing SadTalker checkout and Python runtime sequentially. No package
installation or model download occurs. Render/codec provenance is separate
from the later inspection of identity, voice quality and lip sync.
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
MODEL_RELEASE = "OpenTalker/SadTalker v0.0.2-rc, 256-face model"
MODEL_FILES = [
    "checkpoints/SadTalker_V0.0.2_256.safetensors",
    "checkpoints/mapping_00109-model.pth.tar",
    "gfpgan/weights/alignment_WFLW_4HG.pth",
    "gfpgan/weights/detection_Resnet50_Final.pth",
]
ENVIRONMENT = {"PYTORCH_ENABLE_MPS_FALLBACK": "1", "TORCH_FORCE_NO_WEIGHTS_ONLY_LOAD": "1"}
RENDER_ARGS = ["--preprocess", "full", "--size", "256", "--batch_size", "1"]


def sha(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def fingerprint(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def run(argv, **kwargs):
    return subprocess.run([str(value) for value in argv], check=True, **kwargs)


def probe(file):
    return json.loads(run(["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", file],
                          capture_output=True, text=True).stdout)


def measure_peak(file):
    measured = run(["ffmpeg", "-nostdin", "-hide_banner", "-nostats", "-i", file, "-map", "0:a:0",
                    "-af", "volumedetect", "-vn", "-f", "null", "-"], capture_output=True, text=True)
    match = re.search(r"max_volume:\s*(-?[\d.]+|-inf)\s*dB", measured.stderr)
    peak = float(match.group(1)) if match else float("-inf")
    if peak < -55:
        raise ValueError(f"Missing or inaudible speech in {file}")
    return peak


def summary(info):
    fields = ("codec_type", "codec_name", "width", "height", "pix_fmt", "r_frame_rate",
              "duration", "sample_rate", "channels", "nb_frames", "start_time")
    return {"format": {key: info["format"].get(key) for key in ("format_name", "duration", "size", "start_time")},
            "streams": [{key: stream[key] for key in fields if key in stream} for stream in info["streams"]]}


def validate_final(file, speech_seconds):
    info = probe(file)
    videos = [stream for stream in info["streams"] if stream["codec_type"] == "video"]
    audios = [stream for stream in info["streams"] if stream["codec_type"] == "audio"]
    if len(videos) != 1 or len(audios) != 1 or videos[0]["codec_name"] != "h264" or videos[0].get("pix_fmt") != "yuv420p":
        raise ValueError(f"Final export needs one browser-compatible H.264 video and speech track: {file}")
    if audios[0]["codec_name"] != "aac" or audios[0].get("sample_rate") != "24000":
        raise ValueError(f"Final export must retain the original speech at 24kHz: {file}")
    if abs(float(info["format"]["duration"]) - speech_seconds) > 0.06:
        raise ValueError(f"Unexpected export duration relative to source speech: {file}")
    return summary(info), measure_peak(file)


def source_tree(sadtalker):
    files = [sadtalker / "inference.py"]
    files += [file for file in (sadtalker / "src").rglob("*")
              if file.is_file() and "__pycache__" not in file.parts and file.suffix not in (".pyc", ".pyo")]
    return [{"file": file.relative_to(sadtalker).as_posix(), "sha256": sha(file)}
            for file in sorted(files)]


def write_json(path, data):
    temporary = path.with_suffix(path.suffix + ".partial")
    temporary.write_text(json.dumps(data, indent=2) + "\n")
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sadtalker", type=Path, required=True, help="Existing patched SadTalker checkout")
    parser.add_argument("--python", type=Path, required=True, help="Existing renderer Python executable")
    parser.add_argument("--speech", type=Path, required=True, help="WAV, exact TXT and speech proof directory")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--storyboard", type=Path, default=ROOT / "docs/demos/work-huddles/storyboard.json")
    parser.add_argument("--turn", action="append", help="Optional exact turn IDs; default is all eight")
    parser.add_argument("--resume", action="store_true", help="Reuse only exports with matching complete provenance and bytes")
    parser.add_argument("--timeout", type=int, default=1800, help="Per-clip renderer limit in seconds")
    args = parser.parse_args()
    if args.timeout <= 0:
        raise ValueError("Timeout must be positive")
    args.sadtalker = args.sadtalker.resolve()
    args.speech = args.speech.resolve()
    args.out = args.out.resolve()
    # Preserve the venv executable path: resolving its symlink would bypass the
    # virtual environment and lose the renderer's actual installed packages.
    args.python = args.python.absolute()
    if not (args.sadtalker / "inference.py").is_file() or not args.python.is_file():
        raise ValueError("SadTalker checkout and renderer Python must already exist")
    story = json.loads(args.storyboard.read_text())
    cast = {actor["userId"]: actor for actor in story["cast"]}
    all_turns = [turn for scene in story["scenes"] for turn in scene["turns"]]
    if len({turn["id"] for turn in all_turns}) != len(all_turns):
        raise ValueError("Duplicate storyboard turn ID")
    if args.turn and set(args.turn) - {turn["id"] for turn in all_turns}:
        raise ValueError("Unknown requested turn ID")
    turns = [turn for turn in all_turns if not args.turn or turn["id"] in args.turn]
    env = {**os.environ, **ENVIRONMENT, "PYTHONUNBUFFERED": "1"}
    runtime_code = """import sys,json,torch,importlib.metadata
print(json.dumps({'python':sys.version,'executable':sys.executable,'torch':torch.__version__,
'mpsAvailable':torch.backends.mps.is_available(),'cudaAvailable':torch.cuda.is_available(),
'packages':sorted([(d.metadata['Name'],d.version) for d in importlib.metadata.distributions()])}))"""
    runtime = json.loads(run([args.python, "-c", runtime_code], capture_output=True, text=True, env=env).stdout)
    revision = run(["git", "-C", args.sadtalker, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    files = source_tree(args.sadtalker)
    models = [{"file": name, "bytes": (args.sadtalker / name).stat().st_size, "sha256": sha(args.sadtalker / name)}
              for name in MODEL_FILES]
    shared = {"driverSha256": sha(Path(__file__)), "sourceRevision": revision,
              "sourceTreeSha256": fingerprint(files), "modelRelease": MODEL_RELEASE,
              "modelFiles": models, "runtime": runtime, "environment": ENVIRONMENT, "rendererArguments": RENDER_ARGS,
              "finalEncoding": {"video": "libx264/yuv420p/crf18", "audio": "original WAV/AAC/24000Hz/mono",
                                "maxLastFramePaddingSeconds": 0.04}}
    jobs = []
    for turn in turns:
        if (not re.fullmatch(r"[a-z][a-z0-9-]{0,70}", turn["id"])
                or turn["clip"] != turn["id"] + ".mp4" or turn["actor"] not in cast):
            raise ValueError(f"Invalid turn: {turn.get('id')}")
        portrait = (ROOT / cast[turn["actor"]]["portrait"]).resolve()
        if not portrait.is_relative_to(ROOT):
            raise ValueError("Portrait must remain inside the repository")
        audio = args.speech / (turn["id"] + ".wav")
        speech_proof_file = args.speech / (turn["id"] + "-proof.json")
        speech_proof = json.loads(speech_proof_file.read_text())
        if (speech_proof.get("text") != turn["speech"] or speech_proof.get("actor") != turn["actor"]
                or speech_proof.get("clipId") != turn["id"] or speech_proof.get("wavSha256") != sha(audio)
                or (args.speech / (turn["id"] + ".txt")).read_text().strip() != turn["speech"]):
            raise ValueError(f"Speech source/provenance does not match the storyboard: {turn['id']}")
        input_info = probe(audio)
        seconds = float(input_info["format"]["duration"])
        if not 0 < seconds <= 120 or input_info["streams"][0].get("sample_rate") != "24000":
            raise ValueError(f"Expected bounded original 24kHz speech: {audio}")
        input_peak = measure_peak(audio)
        provenance = {**shared, "id": turn["id"], "actor": turn["actor"], "speech": turn["speech"],
                      "speechSha256": sha(audio), "speechProofSha256": sha(speech_proof_file),
                      "voice": speech_proof.get("voice"), "voiceSha256": speech_proof.get("voiceSha256"),
                      "speechModelRevision": speech_proof.get("modelRevision"),
                      "portrait": cast[turn["actor"]]["portrait"], "portraitSha256": sha(portrait)}
        jobs.append((turn, portrait, audio, seconds, input_peak, provenance))

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / ".render-work").mkdir(exist_ok=True)
    write_json(args.out / "renderer-provenance.json", {**shared, "sourceFiles": files})
    manifest = {"kind": "local-portrait-speaking-render", "expectedClipCount": len(turns), "clips": [],
                "qualityStatus": "unreviewed; renders and codec checks do not certify lip sync or voice naturalness"}
    for turn, portrait, audio, seconds, input_peak, provenance in jobs:
        target = args.out / turn["clip"]
        receipt = args.out / (turn["id"] + "-render.json")
        expected = fingerprint(provenance)
        previous = None
        if args.resume and target.is_file() and receipt.is_file():
            try:
                candidate = json.loads(receipt.read_text())
                if candidate.get("inputFingerprint") == expected and candidate.get("clipSha256") == sha(target):
                    validate_final(target, seconds)
                    previous = candidate
            except (ValueError, OSError, subprocess.SubprocessError):
                previous = None
        if previous is not None:
            print(f"Resume {turn['id']}: source, script, voice, portrait, model, runtime and export bytes match", flush=True)
            manifest["clips"].append(previous)
            write_json(args.out / "speaking-manifest.json", manifest)
            continue
        work = Path(tempfile.mkdtemp(prefix=turn["id"] + "-", dir=args.out / ".render-work"))
        log = work / "render.log"
        command = [args.python, args.sadtalker / "inference.py", "--driven_audio", audio,
                   "--source_image", portrait, "--checkpoint_dir", args.sadtalker / "checkpoints",
                   "--result_dir", work, *RENDER_ARGS]
        print(f"Render {turn['id']} ({seconds:.3f}s). Log: {log}", flush=True)
        started = time.time()
        with log.open("w") as output:
            try:
                run(command, cwd=args.sadtalker, env=env, stdout=output, stderr=subprocess.STDOUT, timeout=args.timeout)
            except (subprocess.SubprocessError, OSError) as error:
                raise RuntimeError(f"Renderer failed for {turn['id']}; inspect {log}") from error
        generated = list(work.glob("*.mp4"))
        if len(generated) != 1:
            raise ValueError(f"Renderer must produce exactly one final portrait MP4 for {turn['id']}: {work}")
        native = probe(generated[0])
        native_video = next((stream for stream in native["streams"] if stream["codec_type"] == "video"), None)
        if native_video is None or abs(float(native_video.get("duration", native["format"]["duration"])) - seconds) > 0.04 + 0.001:
            raise ValueError(f"Portrait video is missing or differs from speech by more than one frame: {generated[0]}")
        final = work / "browser-export.mp4"
        # Use the original 24kHz WAV, rather than SadTalker's internally resampled
        # and shortened 16kHz soundtrack. At most one last video frame is padded.
        run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", generated[0], "-i", audio,
             "-map", "0:v:0", "-map", "1:a:0", "-vf", "tpad=stop_mode=clone:stop_duration=0.04,format=yuv420p",
             "-af", f"atrim=end_sample={round(seconds * 24000)},asetpts=N/SR/TB", "-t", f"{seconds:.6f}",
             "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-c:a", "aac", "-ar", "24000", "-ac", "1",
             "-movflags", "+faststart", final], capture_output=True, text=True)
        inspected, peak = validate_final(final, seconds)
        result = {"id": turn["id"], "clip": turn["clip"], "actor": turn["actor"],
                  "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                  "inputFingerprint": expected, "provenance": provenance, "clipSha256": sha(final),
                  "renderSeconds": time.time() - started, "sourceSpeechSeconds": seconds,
                  "sourceSpeechPeakDbFS": input_peak, "exportPeakDbFS": peak, "ffprobe": inspected,
                  "nativeRendererFfprobe": summary(native), "renderLog": str(log),
                  "qualityStatus": "unreviewed; actual identity, lip sync and voice quality still need inspection"}
        final.replace(target)
        write_json(receipt, result)
        manifest["clips"].append(result)
        write_json(args.out / "speaking-manifest.json", manifest)
        print(f"Exported {turn['clip']}: {inspected['format']['duration']}s, H.264/AAC24kHz, peak {peak:.1f}dBFS", flush=True)
    print(f"Completed {len(manifest['clips'])} generated portrait clips. Quality inspection and live call synchronization remain separate checks.", flush=True)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError, RuntimeError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
