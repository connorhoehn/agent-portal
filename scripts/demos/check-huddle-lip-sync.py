#!/usr/bin/env python3
"""Measure exported clips with the existing official SyncNet model.

This estimates audio/video timing. It does not certify perceptual quality or
replace watching and listening. No models are installed or downloaded here.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
from argparse import Namespace

ROOT = Path(__file__).resolve().parents[2]
MODEL_SHA256 = '961e8696f888fce4f3f3a6c3d5b3267cf5b343100b238e79b2659bff2c605442'


def digest(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--syncnet', type=Path, required=True)
    parser.add_argument('--face-weights', type=Path, required=True)
    parser.add_argument('--clips', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--turn', action='append')
    args = parser.parse_args()
    model_path = args.syncnet / 'data/syncnet_v2.model'
    if not model_path.is_file() or digest(model_path) != MODEL_SHA256:
        raise ValueError('Missing or changed official SyncNet model')
    import cv2
    import numpy as np
    import torch
    from facexlib.detection import init_detection_model
    sys.path.insert(0, str(args.syncnet.resolve()))
    from SyncNetInstance import SyncNetInstance
    torch.set_num_threads(4)
    detector = init_detection_model('retinaface_resnet50', device='cpu', model_rootpath=str(args.face_weights.resolve()))
    net = SyncNetInstance(device='cpu')
    net.loadParameters(str(model_path))
    story = json.loads((ROOT / 'docs/demos/work-huddles/storyboard.json').read_text())
    turns = [turn for scene in story['scenes'] for turn in scene['turns']]
    if args.turn:
        if set(args.turn) - {turn['id'] for turn in turns}:
            raise ValueError('Unknown turn')
        turns = [turn for turn in turns if turn['id'] in args.turn]
    args.out.mkdir(parents=True, exist_ok=True)
    proofs = []
    for turn in turns:
        clip = args.clips / turn['clip']
        if not clip.is_file():
            raise ValueError(f'Missing clip: {clip}')
        cap = cv2.VideoCapture(str(clip))
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = cap.get(cv2.CAP_PROP_FPS)
        width, height = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        if frame_count < 25 or abs(fps - 25) > 0.01:
            raise ValueError('SyncNet expects a 25fps clip of at least one second')
        boxes = []
        try:
            for index in np.linspace(0, frame_count - 1, 6).astype(int):
                cap.set(cv2.CAP_PROP_POS_FRAMES, int(index))
                ok, frame = cap.read()
                if not ok:
                    raise ValueError(f'Cannot read frame {index}')
                with torch.no_grad():
                    detections = detector.detect_faces(frame, 0.97)
                if len(detections) != 1:
                    raise ValueError(f'Expected one face, found {len(detections)}')
                boxes.append(detections[0][:4])
        finally:
            cap.release()
        det = np.median(np.array(boxes), axis=0)
        size = max(det[3] - det[1], det[2] - det[0]) / 2
        x, y = (det[0] + det[2]) / 2, (det[1] + det[3]) / 2
        # Official run_pipeline.py expanded-face convention, using a median
        # box for these single-face, fixed-camera portrait clips.
        left, top = max(0, int(x - size * 1.4)), max(0, int(y - size))
        right, bottom = min(width, int(x + size * 1.4)), min(height, int(y + size * 1.8))
        cropped = args.out / f'{turn["id"]}-crop.avi'
        subprocess.run(['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(clip),
                        '-vf', f'crop={right-left}:{bottom-top}:{left}:{top},scale=224:224,fps=25',
                        '-c:v', 'mpeg4', '-c:a', 'pcm_s16le', '-ar', '16000', '-ac', '1', str(cropped)], check=True)
        with torch.no_grad():
            offset, confidence, distances = net.evaluate(Namespace(tmp_dir=str(args.out / 'work'),
                reference=turn['id'], batch_size=8, vshift=15), str(cropped))
        proof = {'id': turn['id'], 'clipSha256': digest(clip), 'modelSha256': MODEL_SHA256,
                 'offsetFrames': int(offset), 'offsetSeconds': int(offset)/25,
                 'confidence': float(confidence), 'minimumDistance': float(np.min(np.mean(distances, axis=0))),
                 'faceSamples': 6, 'crop': [left, top, right, bottom],
                 'method': 'Official SyncNet model; median RetinaFace box, official expanded-face crop convention',
                 'limit': 'Automated temporal alignment estimate. Human listening and perceptual lip-sync review are not claimed.'}
        (args.out / f'{turn["id"]}-sync.json').write_text(json.dumps(proof, indent=2) + '\n')
        proofs.append(proof)
        print(f'{turn["id"]}: offset {proof["offsetSeconds"]:+.3f}s, confidence {proof["confidence"]:.3f}', flush=True)
    (args.out / 'sync-manifest.json').write_text(json.dumps({'kind': 'automated-speaking-alignment', 'clips': proofs}, indent=2)+'\n')


if __name__ == '__main__':
    main()
