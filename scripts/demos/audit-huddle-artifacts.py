#!/usr/bin/env python3
"""Bind delivered huddle artifacts to their scripts and recorded checks.

No inference, installs, services, archive rewriting or clip regeneration.
--fix-readiness only copies verified archive facts into duplicated metadata.
"""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "docs/demos/work-huddles"
EXPECTED = "d0fc41cba9147d8b46b5cb29c5184548dbc1d3abca3b783a39b020132ac004d8"


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def read(path):
    return json.loads(path.read_text())


def words(text):
    return re.findall(r"[a-z0-9]+", text.lower().replace("’", "'"))


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def contract(path):
    code = """import {readFileSync} from 'node:fs';
import {makeMediaContract} from './scripts/demos/huddle-media-contract.mjs';
console.log(JSON.stringify(makeMediaContract(JSON.parse(readFileSync(process.argv[1])),process.cwd())));"""
    return json.loads(subprocess.run(["node", "--input-type=module", "-e", code, str(path)],
                                    cwd=ROOT, check=True, capture_output=True, text=True).stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True, help="Consistency proof JSON")
    parser.add_argument("--fix-readiness", action="store_true")
    args = parser.parse_args()
    errors, warnings = [], []

    def require(condition, message):
        if not condition:
            errors.append(message)

    current = contract(BASE / "storyboard.json")
    require(current["contentSha256"] == EXPECTED, "Current storyboard content contract changed")
    manifest = read(BASE / "speaking-media-manifest.json")
    readiness_file = BASE / "media-readiness.json"
    readiness = read(readiness_file)
    require(readiness["contentSha256"] == current["contentSha256"], "Readiness content contract differs")
    scene_turns = [turn for scene in current["scenes"] for turn in scene["turns"]]
    turns = {turn["id"]: turn for turn in scene_turns}
    portraits = {actor["userId"]: actor["portraitSha256"] for actor in current["cast"]}
    require(len(scene_turns) == len(turns) == len(manifest["clips"]) == manifest["clipCount"] == 8, "Expected eight unique turns and clips")
    require({clip["id"] for clip in manifest["clips"]} == set(turns), "Clip manifest IDs differ from storyboard")
    asr = read(BASE / "speaking-media/encoded-speech-validation.json")
    lip = read(BASE / "speaking-media/automated-review.json")
    require(asr["promptHints"] is False, "ASR report used prompt hints")
    require(len(asr["rows"]) == len({row["id"] for row in asr["rows"]}) == 8, "ASR rows must be unique")
    require(len(lip["clips"]) == len({row["id"] for row in lip["clips"]}) == 8, "Lip-sync rows must be unique")
    require({row["id"] for row in asr["rows"]} == {row["id"] for row in lip["clips"]} == set(turns), "Report IDs differ from storyboard")
    asr_rows, lip_rows = ({row["id"]: row for row in asr["rows"]}, {row["id"]: row for row in lip["clips"]})
    local = read(BASE / "speaking-media/local-generation-provenance.json")
    renderer = read(BASE / "speaking-media/renderer-provenance.json")
    commands = read(BASE / "speaking-media/generation-commands.json")
    require(commands["hashContext"]["contentSha256"] == EXPECTED, "Generation commands content contract differs")
    script_rows = []
    for driver in commands["hashContext"]["drivers"]:
        actual = digest(ROOT / driver["repositoryPath"])
        require(actual == driver["sha256"], "Generation driver changed: " + driver["repositoryPath"])
        script_rows.append({"file": driver["repositoryPath"], "sha256": actual, "matchesRecorded": actual == driver["sha256"]})
    require(renderer["driverSha256"] == digest(ROOT / "scripts/demos/generate-huddle-speaking.py"), "Renderer driver differs from render receipts")
    patch = (BASE / "speaking-media" / local["SadTalker"]["compatibilityPatch"]).resolve()
    require(patch.is_file() and digest(patch) == local["SadTalker"]["patchSha256"], "Renderer compatibility patch binding failed")

    clip_rows = []
    for clip in manifest["clips"]:
        name, path = clip["id"], BASE / clip["file"]
        actual, size = digest(path), path.stat().st_size
        turn, audio, timing = turns[name], asr_rows[name], lip_rows[name]
        receipt = read(BASE / f"speaking-media/{name}-render.json")
        source = receipt["provenance"]
        require(path.name == turn["clip"] and actual == clip["sha256"] == audio["clipSha256"] == timing["clipSha256"] == receipt["clipSha256"], name + ": clip/report byte binding failed")
        require(size == clip["bytes"] == timing["bytes"], name + ": byte count differs")
        word_match = audio["expected"] == turn["speech"] and words(audio["transcript"]) == words(turn["speech"])
        require(word_match and audio["normalizedWordsMatch"] is True, name + ": actual stored ASR words differ from current script")
        require(source["speech"] == turn["speech"] and source["actor"] == turn["actor"], name + ": render speech/actor differs")
        require(source["portraitSha256"] == portraits[turn["actor"]], name + ": source portrait differs")
        require(receipt["inputFingerprint"] == fingerprint(source), name + ": render provenance fingerprint differs")
        require(source["driverSha256"] == renderer["driverSha256"], name + ": render driver differs")
        require(timing["modelSha256"] == local["SyncNet"]["modelSha256"], name + ": SyncNet model differs")
        require(timing["offsetSeconds"] == timing["offsetFrames"] / 25 == -0.04, name + ": stored timing estimate differs")
        visual = BASE / "speaking-media" / timing["visualEvidence"]
        require(visual.is_file(), name + ": sampled frames missing")
        speech_dir = Path(commands["commands"][1]["argv"][commands["commands"][1]["argv"].index("--speech") + 1])
        wav, speech_proof = speech_dir / f"{name}.wav", speech_dir / f"{name}-proof.json"
        cache_bound = None
        if wav.is_file() and speech_proof.is_file():
            generated = read(speech_proof)
            cache_bound = digest(wav) == source["speechSha256"] == generated["wavSha256"] and digest(speech_proof) == source["speechProofSha256"]
            require(cache_bound and generated["text"] == turn["speech"], name + ": cached source audio/proof differs")
        clip_rows.append({"id": name, "bytes": size, "sha256": actual, "asrWordsRecomputedMatch": word_match,
                          "renderFingerprintMatches": receipt["inputFingerprint"] == fingerprint(source),
                          "portraitSha256": source["portraitSha256"], "syncNetOffsetSeconds": timing["offsetSeconds"],
                          "cachedSourceSpeechBound": cache_bound, "sampledFramesSha256": digest(visual)})
    require(sum(row["bytes"] for row in clip_rows) == manifest["totalVideoBytes"] == readiness["deliveredMedia"]["totalVideoBytes"], "Total video bytes differs")

    archives = []
    for name in ["speaking-media.zip", "speaking-media-handoff.zip"]:
        path = BASE / name
        with zipfile.ZipFile(path) as archive:
            entries = archive.namelist()
            require(len(entries) == len(set(entries)), name + ": duplicate ZIP paths")
            failed = archive.testzip()
            require(failed is None, name + ": CRC failure")
            rows = []
            for entry in entries:
                if entry.endswith("/"):
                    continue
                require(not Path(entry).is_absolute() and ".." not in Path(entry).parts, name + ": unsafe ZIP path")
                data, disk = archive.read(entry), BASE / entry
                zipped = hashlib.sha256(data).hexdigest()
                require(disk.is_file() and zipped == digest(disk), name + ": archive differs from delivered file " + entry)
                rows.append({"file": entry, "bytes": len(data), "sha256": zipped})
            archives.append({"file": name, "bytes": path.stat().st_size, "sha256": digest(path), "crcFailures": failed, "entries": rows})
    actual_archive, handoff_archive = archives
    require(actual_archive["bytes"] == manifest["archive"]["bytes"] and actual_archive["sha256"] == manifest["archive"]["sha256"], "Authoritative manifest archive facts differ from actual ZIP")
    require(handoff_archive["bytes"] == readiness["portableHandoff"]["bytes"] and handoff_archive["sha256"] == readiness["portableHandoff"]["sha256"], "Portable handoff archive facts differ")
    snapshot = contract(BASE / "speaking-media/storyboard.json")
    handoff = read(BASE / "media-handoff/requests.json")
    require(snapshot == current, "Packed storyboard snapshot content differs")
    require(handoff["contract"] == current and handoff["contentSha256"] == EXPECTED, "Portable handoff content differs")
    for turn in scene_turns:
        require((BASE / f"media-handoff/speech/{turn['id']}.txt").read_text().strip() == turn["speech"], "Portable exact speech file differs: " + turn["id"])
    for actor in current["cast"]:
        require(digest(BASE / "media-handoff" / actor["portrait"]) == actor["portraitSha256"], "Portable portrait differs")
    if any("predates this command manifest" in limit for limit in commands["limits"]):
        warnings.append("generation-commands.json archive-predates wording is stale: current ZIP contains the manifest and corrected provenance")

    before = {"bytes": readiness["deliveredMedia"].get("archiveBytes"), "sha256": readiness["deliveredMedia"].get("archiveSha256")}
    after = {"bytes": actual_archive["bytes"], "sha256": actual_archive["sha256"]}
    fixed = False
    if args.fix_readiness and not errors:
        readiness["deliveredMedia"]["archiveBytes"] = after["bytes"]
        readiness["deliveredMedia"]["archiveSha256"] = after["sha256"]
        readiness_file.write_text(json.dumps(readiness, indent=2) + "\n")
        fixed = before != after
    elif before != after:
        errors.append("Duplicated media-readiness archive facts differ; use --fix-readiness after authoritative byte checks pass")
    proof = {"kind": "speaking-artifact-byte-consistency", "checkedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
             "status": "verified" if not errors else "failed", "contentSha256": current["contentSha256"], "clips": clip_rows,
             "totalVideoBytes": sum(row["bytes"] for row in clip_rows), "archives": archives, "scriptBindings": script_rows,
             "storyboardSnapshotContentMatch": snapshot == current, "handoffContractMatch": handoff["contract"] == current,
             "readinessArchiveCorrection": {"before": before, "after": after, "changed": fixed}, "errors": errors, "warnings": warnings,
             "limits": ["No ASR or SyncNet inference rerun; prior reports bind to these exact bytes and their stored words are recomputed against current scripts.",
                        "Sampled frames were byte-checked; human listening and continuous perceptual lip-sync review are not claimed.",
                        "Native live scene/transcript/screen acceptance is outside this artifact consistency check.",
                        "This audit does not rewrite archives, clips, the manifest, storyboard, models, services or generation runtime. --fix-readiness can synchronize the duplicated archive facts after verification; separate corrections have their own receipts."]}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(proof, indent=2) + "\n")
    print(json.dumps({"status": proof["status"], "clipCount": len(clip_rows), "archive": after,
                      "readinessCorrected": fixed, "errors": errors, "warnings": warnings, "proof": str(args.out)}, indent=2))
    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
