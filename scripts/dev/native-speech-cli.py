#!/usr/bin/env python3
"""Native faster-whisper engine entrypoint for platform-api's SPEECH_CLI seam.

Usage: native-speech-cli.py transcribe <media-file> [--json]

SPEECH_NATIVE_WORKER_ROOT must explicitly name an existing native
transcription-worker checkout. This calls its audio/Transcriber modules. It does
not consume jobs, publish events, write TranscriptDocs, or repair recognized
words. Model selection is explicit and local: WHISPER_MODEL must name an
already-cached CTranslate2 model directory. No model download is attempted.

Use the existing worker Python environment (or another provisioned runtime
containing its faster-whisper dependencies); ffmpeg must be on PATH.
WHISPER_COMPUTE_TYPE=int8, WHISPER_BEAM_SIZE=5, WHISPER_LANGUAGE=auto,
WHISPER_VAD_FILTER=false, WHISPER_SUPPRESS_LOW_CONFIDENCE=false by default.
The last two defaults retain the complete composed-recording speech rather
than applying the per-leg worker's cross-talk/silence suppression policy.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
from pathlib import Path
import sys
import tempfile

# Loading a read-only native source checkout must not write __pycache__ there.
sys.dont_write_bytecode = True


def boolean_env(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true"}:
        return True
    if normalized in {"0", "false"}:
        return False
    raise ValueError(f"{name} must be true/false or 1/0")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["transcribe"])
    parser.add_argument("file", type=Path)
    parser.add_argument("--json", action="store_true", dest="as_json")
    args = parser.parse_args(argv)

    try:
        worker_value = os.environ.get("SPEECH_NATIVE_WORKER_ROOT", "")
        worker_root = Path(worker_value).expanduser() if worker_value else None
        if worker_root is None or not worker_root.is_absolute() or not worker_root.is_dir():
            raise ValueError("SPEECH_NATIVE_WORKER_ROOT must name an absolute existing native transcription-worker directory")
        worker_root = worker_root.resolve(strict=True)
        if not all((worker_root / "src" / name).is_file()
                   for name in ("__init__.py", "audio.py", "transcribe.py")):
            raise ValueError("SPEECH_NATIVE_WORKER_ROOT lacks native src/audio.py or src/transcribe.py")
        media = args.file.expanduser().resolve(strict=True)
        if not media.is_file() or media.stat().st_size == 0:
            raise ValueError("input must be a nonempty media file")
        model_value = os.environ.get("WHISPER_MODEL", "")
        model = Path(model_value).expanduser() if model_value else None
        if model is None or not model.is_absolute() or not model.is_dir():
            raise ValueError("WHISPER_MODEL must name an absolute existing local model directory")
        if not all((model / name).is_file() for name in ("model.bin", "config.json", "tokenizer.json")):
            raise ValueError("WHISPER_MODEL lacks model.bin, config.json or tokenizer.json")
        compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
        if compute_type not in {"int8", "int8_float32", "float32"}:
            raise ValueError("WHISPER_COMPUTE_TYPE must be a CPU compute type: int8, int8_float32 or float32")
        beam_size = int(os.environ.get("WHISPER_BEAM_SIZE", "5"))
        if beam_size < 1:
            raise ValueError("WHISPER_BEAM_SIZE must be positive")
        language = os.environ.get("WHISPER_LANGUAGE", "").strip()
        vad_filter = boolean_env("WHISPER_VAD_FILTER", False)
        suppress = boolean_env("WHISPER_SUPPRESS_LOW_CONFIDENCE", False)
    except (OSError, ValueError) as error:
        print(f"speech-cli: {error}", file=sys.stderr)
        return 2

    try:
        # The library/runtime may log to stdout; the CLI result stays pipeable.
        with contextlib.redirect_stdout(sys.stderr):
            sys.path.insert(0, str(worker_root))
            from src.audio import extract_wav
            from src.transcribe import Transcriber

            engine = Transcriber(
                model_size=str(model), compute_type=compute_type,
                cache_dir=str(model.parent), beam_size=beam_size, language=language,
            )
            with tempfile.TemporaryDirectory(prefix="native-speech-cli-") as temp_dir:
                previous_tmpdir = os.environ.get("TMPDIR")
                os.environ["TMPDIR"] = temp_dir
                try:
                    wav = extract_wav(media.read_bytes())
                    segments, _meta = engine.transcribe(
                        wav, vad_filter=vad_filter, suppress_low_confidence=suppress,
                    )
                finally:
                    if previous_tmpdir is None:
                        os.environ.pop("TMPDIR", None)
                    else:
                        os.environ["TMPDIR"] = previous_tmpdir
        # Strip/join formatting only; no substitutions, scripts or prompts.
        text = "\n".join(segment.text for segment in segments)
        print(json.dumps({"file": str(media), "text": text}, ensure_ascii=False)
              if args.as_json else text)
        return 0
    except Exception as error:
        print(f"speech-cli: engine failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
