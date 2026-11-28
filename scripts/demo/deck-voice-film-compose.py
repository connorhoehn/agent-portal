#!/usr/bin/env python3
"""The edit and the review for the deck voice film (scripts/demo/deck-voice-film.mjs runs both).

    python3 scripts/demo/deck-voice-film-compose.py compose --out <dir> [--final <mp4>]
        Reads <dir>/timeline.json (the page recording with its wall-clock start, the film's window, the scenes, each spoken line
        with the moment it was played into the microphone, each assistant recording with the moment it started) and writes one
        film: the 1440x900 page over a caption bar per scene, with the person's lines and the assistant's voice, each placed at
        the moment the page played or received it (nothing is cut, so every wait in the film is the wait that happened).
        This ffmpeg may have no drawtext, so captions are PNGs drawn with Pillow.

    uv run --offline --no-project --python 3.10 --with faster-whisper python scripts/demo/deck-voice-film-compose.py review --out <dir>
        Transcribes the final mix (faster-whisper base, word times), writes <dir>/qa/review.md (the transcript with film times,
        each request's measured times from report.json, and which transcript words fall in each assistant reply), and extracts
        frames at the scenes and the marks (cards, the chart) to <dir>/qa/frames/. Transcription flags places to inspect; it
        cannot certify the film.
"""
import argparse
import json
import os
import subprocess
import sys

W, H, CAP = 1440, 900, 104
BG = (15, 23, 42)
INK = (241, 245, 249)
MUTED = (148, 163, 184)
ACCENT = (245, 158, 11)
FONTS = ['/System/Library/Fonts/Helvetica.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']


def run(cmd):
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if r.returncode != 0:
        sys.stderr.write(r.stderr[-3000:])
        raise SystemExit(f'failed: {" ".join(cmd[:6])} ...')
    return r


def font(size, bold=False):
    from PIL import ImageFont
    for f in FONTS:
        if os.path.exists(f):
            try:
                return ImageFont.truetype(f, size, index=1 if bold and f.endswith('.ttc') else 0)
            except OSError:
                continue
    return ImageFont.load_default()


def caption_png(path, n, title, caption):
    from PIL import Image, ImageDraw
    img = Image.new('RGBA', (W, CAP), BG + (255,))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 3], fill=ACCENT)
    d.rounded_rectangle([28, 22, 28 + 60, 22 + 60], radius=14, fill=ACCENT)
    f = font(34, True)
    d.text((28 + 30 - d.textlength(str(n), font=f) / 2, 32), str(n), font=f, fill=BG)
    d.text((112, 18), title, font=font(30, True), fill=INK)
    d.text((112, 60), caption[:150], font=font(22), fill=MUTED)
    img.save(path)


def duration(path):
    return float(run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path]).stdout.strip() or 0)


def compose(out, final):
    tl = json.load(open(os.path.join(out, 'timeline.json')))
    t0, t1 = tl['film']['fromMs'], tl['film']['toMs']
    dur = (t1 - t0) / 1000
    video = os.path.join(out, tl['video']['file'])
    ss = max(0.0, (t0 - tl['video']['startMs']) / 1000)
    caps = os.path.join(out, 'captions')
    os.makedirs(caps, exist_ok=True)
    inputs = ['-ss', f'{ss:.3f}', '-t', f'{dur:.3f}', '-i', video]
    fil = [f'[0:v]fps=30,scale={W}:{H},pad={W}:{H + CAP}:0:0:color=0x0f172a[v0]']
    scenes = tl['scenes']
    last = 'v0'
    for i, s in enumerate(scenes):
        png = os.path.join(caps, f'scene-{s["n"]}.png')
        caption_png(png, s['n'], s['title'], s['caption'])
        a = max(0.0, (s['atMs'] - t0) / 1000)
        b = (scenes[i + 1]['atMs'] - t0) / 1000 if i + 1 < len(scenes) else dur + 1
        inputs += ['-loop', '1', '-t', f'{dur:.3f}', '-i', png]
        n = len([x for x in inputs if x == '-i']) - 1
        fil.append(f"[{last}][{n}:v]overlay=0:{H}:enable='between(t,{a:.2f},{b:.2f})'[v{i + 1}]")
        last = f'v{i + 1}'
    sounds = [(os.path.join(out, s['file']), s['atMs']) for s in tl['speech'] if s.get('file')]
    sounds += [(os.path.join(out, a['file']), a['atMs']) for a in tl.get('assistant', []) if os.path.exists(os.path.join(out, a['file'])) and os.path.getsize(os.path.join(out, a['file'])) > 0]
    mix = []
    for f, at in sounds:
        inputs += ['-i', f]
        n = len([x for x in inputs if x == '-i']) - 1
        delay = max(0, int(at - t0))
        fil.append(f'[{n}:a]aresample=48000,aformat=channel_layouts=mono,adelay={delay}:all=1[a{len(mix)}]')
        mix.append(f'[a{len(mix)}]')
    if mix:
        fil.append(f'{"".join(mix)}amix=inputs={len(mix)}:normalize=0:dropout_transition=0,apad,atrim=0:{dur:.3f},alimiter=limit=0.89:level=disabled[aout]')
    cmd = ['ffmpeg', '-y', '-v', 'error', *inputs, '-filter_complex', ';'.join(fil), '-map', f'[{last}]']
    cmd += ['-map', '[aout]', '-c:a', 'aac', '-b:a', '160k'] if mix else []
    cmd += ['-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p', '-t', f'{dur:.3f}', '-movflags', '+faststart', final]
    run(cmd)
    print(f'compose: {final} ({duration(final):.1f} s, {len(sounds)} sounds)')


def review(out, final):
    from faster_whisper import WhisperModel
    tl = json.load(open(os.path.join(out, 'timeline.json')))
    rep = json.load(open(os.path.join(out, 'report.json')))
    t0 = tl['film']['fromMs']
    qa = os.path.join(out, 'qa')
    frames = os.path.join(qa, 'frames')
    os.makedirs(frames, exist_ok=True)
    wav = os.path.join(qa, 'mix.wav')
    run(['ffmpeg', '-y', '-v', 'error', '-i', final, '-ac', '1', '-ar', '16000', wav])
    model = WhisperModel('base', device='cpu', compute_type='int8')
    segs, _ = model.transcribe(wav, language='en', word_timestamps=True, vad_filter=True)
    segs = list(segs)
    lines = ['# Deck voice film: review', '', f'Film: {os.path.basename(final)}, {duration(final):.1f} s.', '', '## Transcript of the final mix (film seconds)', '']
    for s in segs:
        lines.append(f'- {s.start:6.1f} to {s.end:6.1f}: {s.text.strip()}')
    lines += ['', '## Requests, as measured (film seconds)', '', '| request | line said | line ended | assistant began | card shown | confirmed | change visible | assistant said |', '|---|---|---|---|---|---|---|---|']
    for r in rep.get('requests', []):
        for a in r.get('attempts', []):
            cells = [r['kind'], a.get('said', ''), a.get('lineEndS'), a.get('replyS'), a.get('cardS'), a.get('confirmS'), a.get('visibleS'), (a.get('assistant') or '')[:220]]
            lines.append('| ' + ' | '.join('' if c is None else str(c).replace('|', '/') for c in cells) + ' |')
    marks = [(max(0.0, (s['atMs'] - t0) / 1000 + 2.5), f'scene-{s["n"]}') for s in tl['scenes']]
    marks += [(max(0.0, (m['atMs'] - t0) / 1000 + 0.6), f'mark-{i}') for i, m in enumerate(tl.get('marks', []))]
    lines += ['', '## Frames', '']
    for t, name in marks:
        p = os.path.join(frames, f'{name}-{t:06.1f}.png')
        run(['ffmpeg', '-y', '-v', 'error', '-ss', f'{t:.2f}', '-i', final, '-frames:v', '1', p])
        lines.append(f'- {t:.1f} s: frames/{os.path.basename(p)}')
    open(os.path.join(qa, 'review.md'), 'w').write('\n'.join(lines) + '\n')
    json.dump([{'start': s.start, 'end': s.end, 'text': s.text} for s in segs], open(os.path.join(qa, 'transcript.json'), 'w'), indent=1)
    os.remove(wav)
    print(f'review: {qa}/review.md, {len(segs)} segments, {len(marks)} frames')


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['compose', 'review'])
    ap.add_argument('--out', required=True)
    ap.add_argument('--final')
    a = ap.parse_args()
    final = a.final or os.path.join(a.out, 'deck-voice.mp4')
    compose(a.out, final) if a.cmd == 'compose' else review(a.out, final)
