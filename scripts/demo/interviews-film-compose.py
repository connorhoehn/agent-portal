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
        moment it was heard, each sound levelled to LINE_LUFS, a limiter on the mix). The timeline's `cuts` (stretches where
        nothing happens on screen) are taken out and marked with a "Skipping ahead" banner; a cut never covers a spoken line or
        Milo's voice (it is shrunk to the silence around them, or dropped), so Milo's latency is shown as it was. This ffmpeg may
        have no drawtext, so every label and caption is a PNG drawn with Pillow.
"""
import argparse
import base64
import datetime
import hashlib
import json
import os
import re
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
LINE_LUFS = -16
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


def skip_png(path, text):
    f = font(28, True)
    d0 = ImageDraw.Draw(Image.new('RGBA', (10, 10)))
    w = int(d0.textlength(text, font=f)) + 80
    img = Image.new('RGBA', (w, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, w - 1, 63], radius=18, fill=(15, 23, 42, 235), outline=ACCENT, width=3)
    d.text((40, 14), text, font=f, fill=INK)
    img.save(path)
    return w


def gain_to(path, target=LINE_LUFS):
    """The gain (dB) that brings a sound to `target` integrated loudness (0 when it cannot be measured)."""
    r = subprocess.run(['ffmpeg', '-nostats', '-hide_banner', '-i', path, '-af', 'ebur128', '-f', 'null', '-'], capture_output=True, text=True)
    for line in r.stderr.split('Summary:')[-1].splitlines():
        line = line.strip()
        if line.startswith('I:') and 'LUFS' in line:
            try:
                return max(-12.0, min(14.0, target - float(line.split()[1])))
            except ValueError:
                return 0.0
    return 0.0


def clear_cuts(cuts, sounds, t0, dur):
    """Each cut (film seconds) shrunk to the silence between sounds (0.3 s kept each side); one shorter than 1.5 s is dropped."""
    busy = sorted(((c['atMs'] - t0) / 1000 - 0.3, (c['atMs'] - t0) / 1000 + c['secs'] + 0.3) for c in sounds)
    kept = []
    for cut in cuts:
        a, b = max(0.0, (cut['fromMs'] - t0) / 1000), min(dur, (cut['toMs'] - t0) / 1000)
        for s0, s1 in busy:
            if s1 <= a or s0 >= b:
                continue
            if s0 - a >= b - s1:
                b = min(b, s0)
            else:
                a = max(a, s1)
        if b - a >= 1.5:
            kept.append({'a': a, 'b': b, 'caption': cut.get('caption') or 'Skipping ahead'})
        else:
            print(f"  cut at {a:.1f} s dropped: it would cover speech")
    kept.sort(key=lambda c: c['a'])
    merged = []
    for c in kept:
        if merged and c['a'] <= merged[-1]['b']:
            merged[-1]['b'] = max(merged[-1]['b'], c['b'])
        else:
            merged.append(c)
    return merged


def apply_cuts(src, final, cuts, dur, tmp):
    """The film without the cuts, each marked by a banner for 3 s where it was."""
    keep, at = [], 0.0
    for c in cuts:
        keep.append((at, c['a']))
        at = c['b']
    keep.append((at, dur))
    inputs, fil, n = ['-i', src], [], 1
    for i, (a, b) in enumerate(keep):
        fil.append(f'[0:v]trim=start={a:.3f}:end={b:.3f},setpts=PTS-STARTPTS[v{i}]')
        fil.append(f'[0:a]atrim=start={a:.3f}:end={b:.3f},asetpts=PTS-STARTPTS[a{i}]')
    fil.append(''.join(f'[v{i}][a{i}]' for i in range(len(keep))) + f'concat=n={len(keep)}:v=1:a=1[cv][ca]')
    last, removed = 'cv', 0.0
    for k, c in enumerate(cuts):
        p = os.path.join(tmp, f'skip-{k}.png')
        w = skip_png(p, f"{c['caption']} ({c['b'] - c['a']:.0f} s)")
        inputs += ['-loop', '1', '-t', '4', '-i', p]
        pos = c['a'] - removed
        removed += c['b'] - c['a']
        fil.append(f"[{last}][{n}:v]overlay={(W - w) // 2}:{HEAD + 24}:enable='between(t,{pos:.2f},{pos + 3:.2f})'[k{k}]")
        last, n = f'k{k}', n + 1
    run(['ffmpeg', '-y', '-v', 'error', *inputs, '-filter_complex', ';'.join(fil), '-map', f'[{last}]', '-map', '[ca]', '-c:a', 'aac', '-b:a', '160k',
         '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', final])
    return dur - removed


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
        res.append({'who': 'milo', 'file': p, 'atMs': u['at'], 'secs': len(u['pcm']) / 2 / u['rate']})
    print(f"  Milo's voice: {len(frames)} frames in {len(utts)} utterances")
    return res


# Milo's introduction as the product will say it (screenplay v1.3); the stand-in says it even while the branch has the old text.
INTRO_TEXT = "Hi, I'm Milo. I won't write your algorithm or anything like that, but use me if you want to speed things up or have a question."


def standin_voice(out, tl, utts):
    """SCRIPTED rehearsals only: each of Milo's utterances (the scripted session's tones) is replaced by its words, said by a third
    TTS preset (interviews-film-standin.py), at the utterance's own start. The words are Milo's posts (timeline `miloSaid`), paired
    with the utterances in order. A real take never comes here: its timeline has no `scripted` flag, and Milo's real voice is used."""
    said = tl.get('miloSaid') or []
    py = os.environ.get('IVFILM_TTS_PYTHON')
    if not said or not py:
        print("  stand-in: skipped (no miloSaid in the timeline or IVFILM_TTS_PYTHON unset); Milo's tones are kept")
        return utts
    # Each utterance takes the nearest post in time (within 8 s; a post can land before or after its voice); a post with no
    # utterance near it (the join notice, said by nobody) is left out, and an utterance with no post keeps its tones.
    posts = []
    for s in said:
        try:
            at = datetime.datetime.fromisoformat(str(s.get('at')).replace('Z', '+00:00')).timestamp() * 1000
        except ValueError:
            continue
        posts.append({'text': s['text'], 'at': at})
    used, lines = set(), []
    for u in utts:
        near = [(abs(p['at'] - u['atMs']), k) for k, p in enumerate(posts) if k not in used and abs(p['at'] - u['atMs']) < 8000]
        if not near:
            lines.append(None)
            continue
        k = min(near)[1]
        used.add(k)
        text = posts[k]['text']
        if re.match(r"^\s*(hi|hello)[,!.]?\s+i'?m milo\b", text, re.I):
            text = INTRO_TEXT
        lines.append({'key': hashlib.sha1(f'standin|{text}'.encode()).hexdigest()[:16], 'text': text})
    cache = os.environ.get('IVFILM_STANDIN_CACHE') or os.path.join(out, 'standin')
    spec = os.path.join(out, 'compose-standin.json')
    json.dump([l for l in lines if l], open(spec, 'w'), indent=1)
    if subprocess.run([py, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'interviews-film-standin.py'), spec, cache]).returncode != 0:
        print("  stand-in: the TTS run failed; Milo's tones are kept")
        return utts
    res = []
    for i, u in enumerate(utts):
        if lines[i]:
            p = os.path.join(cache, f"{lines[i]['key']}.wav")
            with wave.open(p) as w:
                secs = w.getnframes() / w.getframerate()
            res.append({'who': 'milo', 'file': p, 'atMs': u['atMs'], 'secs': secs, 'text': lines[i]['text']})
            print(f"  stand-in {i + 1}: {secs:.1f} s (tones {u['secs']:.1f} s) {lines[i]['text'][:60]}")
        else:
            res.append(u)
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
    milo = assistant_voice(out)
    if tl['film'].get('scripted'):
        milo = standin_voice(out, tl, milo)
    clips = [{'file': os.path.join(out, s['file']), 'atMs': s['atMs'], 'secs': s['durMs'] / 1000} for s in tl.get('speech', []) if s.get('file')] + milo
    clips = [c for c in clips if t0 - 2000 <= c['atMs'] <= t1]
    amix = []
    for i, c in enumerate(clips):
        inputs += ['-i', c['file']]
        delay = max(0, int(c['atMs'] - t0))
        # Every sound at one loudness (people's lines are levelled already; Milo's voice is levelled here), then one limiter.
        fil.append(f'[{n}:a]aresample=48000,aformat=channel_layouts=mono,volume={gain_to(c["file"]):.2f}dB,adelay={delay}:all=1[a{i}]')
        amix.append(f'[a{i}]')
        n += 1
    if amix:
        fil.append(f'{"".join(amix)}amix=inputs={len(amix)}:normalize=0:dropout_transition=0,apad,atrim=0:{dur:.3f},alimiter=limit=0.89:level=disabled[aout]')
    else:
        inputs += ['-f', 'lavfi', '-t', f'{dur:.3f}', '-i', 'anullsrc=r=48000:cl=mono']
        fil.append(f'[{n}:a]anull[aout]')
        n += 1
    cuts = clear_cuts(tl.get('cuts', []), clips, t0, dur)
    full = os.path.join(tmp, 'full.mp4') if cuts else final
    cmd = ['ffmpeg', '-y', '-v', 'error', *inputs, '-filter_complex', ';'.join(fil), '-map', f'[{last}]', '-map', '[aout]', '-c:a', 'aac', '-b:a', '160k']
    cmd += ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-t', f'{dur:.3f}', '-movflags', '+faststart', full]
    run(cmd)
    length = apply_cuts(full, final, cuts, dur, tmp) if cuts else dur
    print(f'film: {final} ({length:.1f} s of {dur:.1f} s recorded, {len(cuts)} cuts, {len(clips)} sounds, {len(scenes)} scenes)')


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
