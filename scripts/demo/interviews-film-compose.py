#!/usr/bin/env python3
"""Cameras and the edit for the Candidates call film (scripts/demo/interviews-call-film.mjs runs both).

    python3 scripts/demo/interviews-film-compose.py cameras --out <dir>
        Writes <dir>/media/{lead,cand}.y4m: a still, clearly fictional camera for each person (a coloured card, an illustrated
        head-and-shoulders avatar and a name label), 640x480, 15 frames, which Chromium loops as its fake camera.

    python3 scripts/demo/interviews-film-compose.py compose --out <dir> [--final <mp4>]
        Reads <dir>/timeline.json (the two recordings with their wall-clock start, the film's window, the scenes, every spoken
        line with the moment it was played into a microphone) and <dir>/assistant-voice.jsonl (Milo's voice frames as the
        candidate's browser received them) and writes one side-by-side film: Interviewer on the left, Candidate on the right,
        each labelled, a caption bar per scene, and the call's sound (both people's lines and Milo's voice, each placed at the
        moment it was heard). This ffmpeg may have no drawtext, so every label and caption is a PNG drawn with Pillow.
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import wave

from PIL import Image, ImageDraw, ImageFont

W, HEAD, CELL_W, CELL_H, CAP = 1920, 60, 960, 600, 140
H = HEAD + CELL_H + CAP
FPS = 30
BG = (11, 18, 32)
INK = (241, 245, 249)
MUTED = (148, 163, 184)
ACCENT = (245, 158, 11)
FONTS = ['/System/Library/Fonts/Helvetica.ttc', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']


def font(size, bold=False):
    for f in FONTS:
        if os.path.exists(f):
            try:
                return ImageFont.truetype(f, size, index=1 if bold and f.endswith('.ttc') else 0)
            except OSError:
                continue
    return ImageFont.load_default()


def run(cmd):
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if r.returncode != 0:
        sys.stderr.write(r.stderr[-3000:])
        raise SystemExit(f'ffmpeg failed: {" ".join(cmd[:6])} ...')
    return r


def wrap(d, text, fnt, width):
    words, lines, cur = text.split(), [], ''
    for w in words:
        t = f'{cur} {w}'.strip()
        if d.textlength(t, font=fnt) <= width or not cur:
            cur = t
        else:
            lines.append(cur)
            cur = w
    return lines + ([cur] if cur else [])


# ── cameras ──
CAMERAS = {
    'lead': {'name': 'Hugo Marchetti', 'role': 'Interviewer (fictional)', 'bg': (20, 83, 92), 'skin': (224, 172, 105), 'shirt': (30, 41, 59), 'hair': (60, 40, 30)},
    'cand': {'name': 'Mateo Álvarez', 'role': 'Candidate (fictional)', 'bg': (76, 29, 149), 'skin': (198, 134, 66), 'shirt': (190, 18, 60), 'hair': (25, 20, 20)},
}


def camera_png(path, c):
    img = Image.new('RGB', (640, 480), c['bg'])
    d = ImageDraw.Draw(img)
    for i in range(0, 480, 4):  # a soft vertical gradient
        shade = tuple(max(0, v - i // 24) for v in c['bg'])
        d.rectangle([0, i, 640, i + 4], fill=shade)
    d.ellipse([200, 320, 440, 580], fill=c['shirt'])           # shoulders
    d.rectangle([295, 250, 345, 320], fill=c['skin'])            # neck
    d.ellipse([240, 110, 400, 290], fill=c['skin'])              # head
    d.chord([236, 96, 404, 230], 180, 360, fill=c['hair'])       # hair
    d.ellipse([280, 180, 296, 196], fill=(30, 30, 30))           # eyes
    d.ellipse([344, 180, 360, 196], fill=(30, 30, 30))
    d.arc([290, 210, 350, 255], 20, 160, fill=(120, 50, 40), width=4)  # smile
    d.rounded_rectangle([20, 46, 620, 116], radius=14, fill=(15, 23, 42))  # top: the call tile puts its own name at the bottom
    d.text((40, 54), c['name'], font=font(30, True), fill=INK)
    d.text((40, 90), c['role'], font=font(18), fill=MUTED)
    img.save(path)


def cameras(out):
    media = os.path.join(out, 'media')
    os.makedirs(media, exist_ok=True)
    for key, c in CAMERAS.items():
        png = os.path.join(media, f'{key}.png')
        camera_png(png, c)
        run(['ffmpeg', '-y', '-v', 'error', '-loop', '1', '-i', png, '-frames:v', '15', '-r', '15', '-vf', 'format=yuv420p',
             '-f', 'yuv4mpegpipe', os.path.join(media, f'{key}.y4m')])
    print(f'cameras: {media}/lead.y4m, {media}/cand.y4m')


# ── the edit ──
def label_png(path, text, sub):
    img = Image.new('RGBA', (CELL_W, HEAD), BG + (255,))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([16, 10, 16 + 14, 10 + 40], radius=4, fill=ACCENT)
    d.text((44, 12), text, font=font(28, True), fill=INK)
    d.text((44 + d.textlength(text, font=font(28, True)) + 16, 20), sub, font=font(20), fill=MUTED)
    img.save(path)


def caption_png(path, n, title, caption):
    img = Image.new('RGBA', (W, CAP), (15, 23, 42, 255))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 3], fill=ACCENT)
    d.rounded_rectangle([40, 30, 40 + 72, 30 + 72], radius=16, fill=ACCENT)
    f = font(40, True)
    d.text((40 + 36 - d.textlength(str(n), font=f) / 2, 44), str(n), font=f, fill=(15, 23, 42))
    d.text((140, 20), title, font=font(34, True), fill=INK)
    y = 66
    for line in wrap(d, caption, font(25), W - 200)[:2]:
        d.text((140, y), line, font=font(25), fill=MUTED)
        y += 31
    img.save(path)


def assistant_voice(out):
    src = os.path.join(out, 'assistant-voice.jsonl')
    if not os.path.exists(src):
        return []
    frames = [json.loads(line) for line in open(src) if line.strip()]
    utts, cur = [], None
    for f in frames:
        if cur and (f['runId'] != cur['runId'] or f['seq'] != cur['seq'] + 1):
            utts.append(cur)
            cur = None
        if cur is None:
            cur = {'runId': f['runId'], 'at': f['atMs'], 'rate': f.get('sampleRate') or 24000, 'pcm': bytearray(), 'seq': f['seq']}
        cur['pcm'] += base64.b64decode(f['pcm'])
        cur['seq'] = f['seq']
        if f.get('last'):
            utts.append(cur)
            cur = None
    if cur:
        utts.append(cur)
    res = []
    os.makedirs(os.path.join(out, 'audio'), exist_ok=True)
    for i, u in enumerate(utts):
        p = os.path.join(out, 'audio', f'milo-{i + 1:03d}.wav')
        with wave.open(p, 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(u['rate'])
            w.writeframes(bytes(u['pcm']))
        res.append({'who': 'milo', 'file': p, 'atMs': u['at']})
    print(f"  Milo's voice: {len(frames)} frames in {len(utts)} utterances")
    return res


def compose(out, final):
    tl = json.load(open(os.path.join(out, 'timeline.json')))
    t0, t1 = tl['film']['fromMs'], tl['film']['toMs']
    dur = (t1 - t0) / 1000
    tmp = os.path.join(out, 'compose')
    os.makedirs(tmp, exist_ok=True)
    inputs = ['-f', 'lavfi', '-i', f'color=c=0x0b1220:s={W}x{H}:r={FPS}:d={dur:.3f}']
    fil, n = [], 1
    vids, lead_in = {}, {}
    for side in ('lead', 'cand'):
        v = tl['videos'][side]
        ss = max(0.0, (t0 - v['startMs']) / 1000)
        # A browser opened after the film's start (the candidate's) is held on the background until its first frame.
        lead_in[side] = max(0.0, (v['startMs'] - t0) / 1000)
        inputs += ['-ss', f'{ss:.3f}', '-t', f'{dur:.3f}', '-i', os.path.join(out, v['file'])]
        vids[side] = n
        n += 1
    labels = {}
    for side, text, sub in (('lead', 'Interviewer', tl.get('labels', {}).get('lead', '')), ('cand', 'Candidate', tl.get('labels', {}).get('cand', ''))):
        p = os.path.join(tmp, f'label-{side}.png')
        label_png(p, text, sub)
        inputs += ['-i', p]
        labels[side] = n
        n += 1
    caps = []
    scenes = tl.get('scenes', [])
    for i, s in enumerate(scenes):
        p = os.path.join(tmp, f'cap-{i}.png')
        caption_png(p, s['n'], s['title'], s.get('caption', ''))
        a = max(0.0, (s['atMs'] - t0) / 1000)
        b = (scenes[i + 1]['atMs'] - t0) / 1000 if i + 1 < len(scenes) else dur + 1
        inputs += ['-loop', '1', '-t', f'{dur:.3f}', '-i', p]
        caps.append((n, a, b))
        n += 1
    for side, tag in (('lead', 'l'), ('cand', 'r')):
        pad = f',tpad=start_duration={lead_in[side]:.3f}:color=0x0b1220' if lead_in[side] > 0 else ''
        fil.append(f'[{vids[side]}:v]setpts=PTS-STARTPTS,fps={FPS},scale={CELL_W - 2}:{CELL_H}{pad}[{tag}]')
    fil.append('[0:v][l]overlay=0:%d:eof_action=repeat[b1]' % HEAD)
    fil.append('[b1][r]overlay=%d:%d:eof_action=repeat[b2]' % (CELL_W + 2, HEAD))
    fil.append(f'[b2][{labels["lead"]}:v]overlay=0:0[b3]')
    fil.append(f'[b3][{labels["cand"]}:v]overlay={CELL_W}:0[b4]')
    last = 'b4'
    for k, (idx, a, b) in enumerate(caps):
        fil.append(f"[{last}][{idx}:v]overlay=0:{HEAD + CELL_H}:enable='between(t,{a:.2f},{b:.2f})'[c{k}]")
        last = f'c{k}'
    # sound
    clips = [{'file': os.path.join(out, s['file']), 'atMs': s['atMs']} for s in tl.get('speech', [])] + assistant_voice(out)
    clips = [c for c in clips if t0 - 2000 <= c['atMs'] <= t1]
    amix = []
    for i, c in enumerate(clips):
        inputs += ['-i', c['file']]
        delay = max(0, int(c['atMs'] - t0))
        fil.append(f'[{n}:a]aresample=48000,aformat=channel_layouts=mono,adelay={delay}:all=1[a{i}]')
        amix.append(f'[a{i}]')
        n += 1
    if amix:
        fil.append(f'{"".join(amix)}amix=inputs={len(amix)}:normalize=0:dropout_transition=0,apad,atrim=0:{dur:.3f},loudnorm=I=-16:TP=-1.5[aout]')
    cmd = ['ffmpeg', '-y', '-v', 'error', *inputs, '-filter_complex', ';'.join(fil), '-map', f'[{last}]']
    if amix:
        cmd += ['-map', '[aout]', '-c:a', 'aac', '-b:a', '160k']
    cmd += ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-t', f'{dur:.3f}', '-movflags', '+faststart', final]
    run(cmd)
    print(f'film: {final} ({dur:.1f} s, {len(clips)} sounds, {len(scenes)} scenes)')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('what', choices=['cameras', 'compose'])
    ap.add_argument('--out', required=True)
    ap.add_argument('--final')
    a = ap.parse_args()
    if a.what == 'cameras':
        cameras(a.out)
    else:
        compose(a.out, a.final or os.path.join(a.out, 'interviews-call.mp4'))


if __name__ == '__main__':
    main()
