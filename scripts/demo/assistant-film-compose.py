#!/usr/bin/env python3
"""Compose the Nova demo film from the recorder's timeline (scripts/demo/nova-meeting-film.mjs runs this at the end).

    python3 scripts/demo/nova-film-compose.py --out <dir> [--check]

Reads <dir>/timeline.json and the raw videos and speech clips it names, and writes <dir>/nova-in-the-meeting.mp4:
a title card per scene, then each shot cut from the right recordings, laid out on a 1920x1080 frame (one view, two side
by side, or strips stacked), a caption bar (chapter, title, one sentence), a name label on each view and a ring around
each element just before it is clicked. The audio track places every spoken clip at the moment it was spoken in the
recording (adelay), mixes them (amix, normalize=0), evens the level (loudnorm) and is muxed as AAC. This ffmpeg has no
drawtext, so every caption, label and ring is a PNG drawn with Pillow and overlaid. --check also writes one frame per
scene to <dir>/check/. --final names the film file. For the live take, the timeline may carry its own title cards
(`cards`), and <dir>/nova-audio.jsonl (Nova's voice frames as Vera's browser received them) is decoded and placed too.
"""
import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import wave

from PIL import Image, ImageDraw, ImageFont

W, H = 1920, 1080
CAP_H = 140
AREA_H = H - CAP_H
FPS = 30
BG = (11, 18, 32)
INK = (241, 245, 249)
MUTED = (148, 163, 184)
ACCENT = (245, 158, 11)
FONT = '/System/Library/Fonts/Helvetica.ttc'
TITLE_SECS = 0  # no card between scenes: the caption bar carries the chapter, the title and the sentence
OPEN_SECS = 2.6
GUTTER = 14
# Pace: speech, the recorder's holds (a state shown on purpose) and the ring before each click play as they happened; any other
# stretch where the picture does not change keeps its first FREEZE_KEEP seconds and plays the rest FREEZE_SPEED times faster;
# the rest (menus opening, cards arriving, typing) plays ACTIVE_SPEED times faster.
FREEZE_MIN = 1.0
FREEZE_KEEP = 0.6
FREEZE_SPEED = 8.0
ACTIVE_SPEED = 2.5

# Regions of a 1440x900 recording, by name (x, y, w, h). The recorder names them per view; tuned against its screenshots.
CROPS = {
    'chat-top': (960, 44, 480, 520),     # the call chat's first messages, with the toast corner above it
    'chat-mid': (960, 150, 480, 560),    # the call chat while it still fits the pane
    'chat-end': (960, 300, 480, 556),    # the newest messages of a full call chat
    'chat-deck': (960, 190, 480, 490),   # the newest messages while a deck prompt shortens the pane
    'deck': (0, 646, 1440, 254),         # the deck prompt above the footer row
    'bottom': (0, 580, 1440, 320),       # the transcription notice and the footer row
    'corner': (560, 520, 880, 380),      # Nova's mark, its menu (it opens above the mark), and the lower call chat
    'mark-chat': (690, 560, 750, 340),   # Nova's mark and the newest call chat messages, for two people stacked
    'notfound': (420, 44, 1020, 400),    # the meeting page's not-found message
    'lower': (0, 330, 1440, 570),        # the call card, the deck prompt and the footer
    'meeting': (60, 60, 980, 515),       # the meeting page's content, above the call card
    'chat-pane': (960, 44, 480, 812),    # the whole call chat pane, header to composer
    'callcard': (96, 572, 848, 144),     # the page's call card: the viewer's own camera tile, the people count and the call controls
}

# Cells of the picture area per layout (x, y, w, h).
LAYOUTS = {
    'full': [(0, 0, W, AREA_H)],
    'split': [(0, 0, W // 2, AREA_H), (W // 2, 0, W // 2, AREA_H)],
    'rows2': [(0, 0, W, AREA_H // 2), (0, AREA_H // 2, W, AREA_H - AREA_H // 2)],
    'rows3': [(0, 0, W, AREA_H // 3), (0, AREA_H // 3, W, AREA_H // 3), (0, 2 * (AREA_H // 3), W, AREA_H - 2 * (AREA_H // 3))],
}


def font(size, bold=False):
    return ImageFont.truetype(FONT, size, index=1 if bold else 0)


def wrap(draw, text, fnt, width):
    words, lines, cur = text.split(), [], ''
    for w in words:
        t = f'{cur} {w}'.strip()
        if draw.textlength(t, font=fnt) <= width or not cur:
            cur = t
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def run(cmd):
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if r.returncode != 0:
        sys.stderr.write(r.stderr[-3000:])
        raise SystemExit(f'ffmpeg failed: {" ".join(cmd[:6])} ...')
    return r


def caption_png(path, n, title, caption):
    img = Image.new('RGBA', (W, CAP_H), (15, 23, 42, 255))
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 3], fill=ACCENT)
    # Chapter badge
    d.rounded_rectangle([48, 34, 48 + 72, 34 + 72], radius=16, fill=ACCENT)
    num = str(n)
    f = font(40, True)
    d.text((48 + 36 - d.textlength(num, font=f) / 2, 48), num, font=f, fill=(15, 23, 42))
    d.text((150, 22), title, font=font(36, True), fill=INK)
    lines = wrap(d, caption, font(26), W - 150 - 60)
    y = 68 if len(lines) > 1 else 74
    for line in lines[:2]:
        d.text((150, y), line, font=font(26), fill=MUTED)
        y += 32
    img.save(path)


def label_png(path, text):
    f = font(21, True)
    tmp = ImageDraw.Draw(Image.new('RGBA', (10, 10)))
    tw = int(tmp.textlength(text, font=f))
    img = Image.new('RGBA', (tw + 28, 36), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, tw + 27, 35], radius=9, fill=(15, 23, 42, 230), outline=ACCENT, width=2)
    d.text((14, 7), text, font=f, fill=INK)
    img.save(path)


def ring_png(path, w, h):
    pad = 10
    img = Image.new('RGBA', (int(w) + 2 * pad, int(h) + 2 * pad), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([2, 2, img.width - 3, img.height - 3], radius=12, outline=ACCENT + (255,), width=5)
    img.save(path)


def card_png(path, big, title, caption, eyebrow=None):
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)
    y = 380
    if eyebrow:
        f = font(34, True)
        d.text((W / 2 - d.textlength(eyebrow, font=f) / 2, y - 90), eyebrow, font=f, fill=ACCENT)
    if big:
        f = font(96, True)
        d.text((W / 2 - d.textlength(big, font=f) / 2, y), big, font=f, fill=INK)
        y += 140
    f = font(64 if not big else 54, True)
    d.text((W / 2 - d.textlength(title, font=f) / 2, y), title, font=f, fill=INK if not big else ACCENT)
    y += 100
    fc = font(34)
    for line in wrap(d, caption, fc, 1300):
        d.text((W / 2 - d.textlength(line, font=fc) / 2, y), line, font=fc, fill=MUTED)
        y += 48
    img.save(path)


def frames(secs):
    return max(1, round(secs * FPS))


def encode_card(png, n_frames, out):
    dur = n_frames / FPS
    run(['ffmpeg', '-y', '-v', 'error', '-loop', '1', '-framerate', str(FPS), '-i', png,
         '-vf', f'fade=t=in:st=0:d=0.4,fade=t=out:st={dur - 0.4:.3f}:d=0.4,format=yuv420p',
         '-frames:v', str(n_frames), '-r', str(FPS), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', out])


def fit(crop, cell):
    cx, cy, cw, ch = crop
    x, y, w, h = cell
    x, y, w, h = x + GUTTER, y + GUTTER, w - 2 * GUTTER, h - 2 * GUTTER
    s = min(w / cw, h / ch)
    sw, sh = int(cw * s) // 2 * 2, int(ch * s) // 2 * 2
    return s, x + (w - sw) // 2, y + (h - sh) // 2, sw, sh


def encode_shot(tl, out_dir, shot, scene, idx, tmp):
    # A shot marked with a speed (a wait where nothing changes) plays that many times faster.
    sp = shot.get('speed', 1) or 1
    n_frames = frames((shot['to'] - shot['from']) / 1000 / sp)
    dur = n_frames / FPS
    cells = LAYOUTS[shot['layout']]
    views = shot['views']
    if len(views) != len(cells):
        raise SystemExit(f'scene {scene["n"]}: layout {shot["layout"]} has {len(cells)} cells for {len(views)} views')
    inputs = ['-f', 'lavfi', '-i', f'color=c=0x{BG[0]:02x}{BG[1]:02x}{BG[2]:02x}:s={W}x{H}:r={FPS}:d={dur + 1:.3f}']
    filters, last, k = [], '0:v', 1
    placed = []
    for view, cell in zip(views, cells):
        vid = tl['videos'][view['v']]
        start = (shot['from'] - vid['startMs']) / 1000
        if start < 0:
            raise SystemExit(f'scene {scene["n"]}: shot starts before video {view["v"]} does')
        inputs += ['-ss', f'{start:.3f}', '-t', f'{dur * sp + 0.5:.3f}', '-i', os.path.join(out_dir, vid['file'])]
        crop = CROPS.get(view.get('crop')) or (0, 0, tl['size']['width'], tl['size']['height'])
        s, px, py, sw, sh = fit(crop, cell)
        cx, cy, cw, ch = crop
        filters.append(f'[{k}:v]setpts=(PTS-STARTPTS)/{sp},fps={FPS},crop={cw}:{ch}:{cx}:{cy},scale={sw}:{sh}:flags=lanczos[v{k}]')
        filters.append(f'[{last}][v{k}]overlay={px}:{py}:eof_action=repeat[b{k}]')
        last = f'b{k}'
        placed.append((view, crop, s, px, py))
        k += 1
    cap = os.path.join(tmp, f'cap-{scene["n"]}.png')
    if not os.path.exists(cap):
        caption_png(cap, scene['n'], scene['title'], scene['caption'])
    inputs += ['-i', cap]
    filters.append(f'[{last}][{k}:v]overlay=0:{AREA_H}[c{k}]')
    last = f'c{k}'
    k += 1
    for view, crop, s, px, py in placed:
        lbl = os.path.join(tmp, f'label-{view["v"]}.png')
        if not os.path.exists(lbl):
            who = tl['videos'][view['v']]['who']
            label_png(lbl, tl['cast'][who]['label'])
        inputs += ['-i', lbl]
        filters.append(f'[{last}][{k}:v]overlay={px + 8}:{py + 8}[l{k}]')
        last = f'l{k}'
        k += 1
    # Rings: each click on a shown view, from its hover until just after the click, mapped through the crop and scale.
    for ci, click in enumerate(tl['clicks']):
        for view, crop, s, px, py in placed:
            if view['v'] != click['video']:
                continue
            t0 = (click['atMs'] - shot['from']) / 1000 / sp
            t1 = t0 + (click['leadMs'] / 1000 + 0.15) / sp
            if t1 < 0 or t0 > dur:
                continue
            bx, by, bw, bh = click['box']
            cx, cy, cw, ch = crop
            if bx + bw < cx or by + bh < cy or bx > cx + cw or by > cy + ch:
                continue
            rw, rh = bw * s, bh * s
            ring = os.path.join(tmp, f'ring-{ci}-{view["v"]}-{int(rw)}x{int(rh)}.png')
            if not os.path.exists(ring):
                ring_png(ring, rw, rh)
            rx, ry = int(px + (bx - cx) * s) - 10, int(py + (by - cy) * s) - 10
            inputs += ['-i', ring]
            filters.append(f"[{last}][{k}:v]overlay={rx}:{ry}:enable='between(t,{max(0, t0):.3f},{t1:.3f})'[r{k}]")
            last = f'r{k}'
            k += 1
    filters.append(f'[{last}]format=yuv420p[out]')
    out = os.path.join(tmp, f'shot-{scene["n"]:02d}-{idx}.mp4')
    run(['ffmpeg', '-y', '-v', 'error', *inputs, '-filter_complex', ';'.join(filters), '-map', '[out]',
         '-frames:v', str(n_frames), '-r', str(FPS), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-an', out])
    return out, n_frames


def still_spans(mp4, dur):
    """Stretches of at least FREEZE_MIN seconds where the picture does not change. A frame counts as changed when enough pixels
    of a small grey copy move by a clear step: the recordings' codec refreshes (every couple of seconds) and a ticking call timer
    stay under that, a card changing state or a menu opening do not."""
    import numpy as np
    w, h = 320, 180
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', mp4, '-vf', f'scale={w}:{h},format=gray', '-f', 'rawvideo', '-'],
                         capture_output=True, check=True).stdout
    a = np.frombuffer(raw, np.uint8).reshape(-1, h, w)[:, : int(h * AREA_H / H)].astype(np.int16)
    if len(a) < 2:
        return []
    changed = (np.abs(np.diff(a, axis=0)) > 24).sum(axis=(1, 2)) > 12
    spans, start = [], 0
    for i, c in enumerate(changed):
        if c:
            if (i + 1 - start) / FPS >= FREEZE_MIN:
                spans.append((start / FPS, (i + 1) / FPS))
            start = i + 1
    if (len(a) - start) / FPS >= FREEZE_MIN:
        spans.append((start / FPS, min(dur, len(a) / FPS)))
    return spans


def squeeze(mp4, nf, protect):
    """Re-times an encoded shot (see the pace settings above); `protect` holds the speech, in the shot's own seconds. Returns the
    shot, its frame count and its segments [(from, to, factor)] in the shot's own seconds, for placing speech."""
    dur = nf / FPS
    freezes = still_spans(mp4, dur)
    cuts = {0.0, dur}
    for fs, fe in freezes:
        cuts |= {fs, min(fe, fs + FREEZE_KEEP), fe}
    for pa, pb in protect:
        cuts |= {max(0.0, pa), min(dur, pb)}
    pts = sorted(c for c in cuts if 0.0 <= c <= dur)

    def factor(m):
        if any(pa <= m < pb for pa, pb in protect):
            return 1.0
        for fs, fe in freezes:
            if fs <= m < fe:
                return 1.0 if m < fs + FREEZE_KEEP else FREEZE_SPEED
        return ACTIVE_SPEED
    segs = []
    for x, y in zip(pts, pts[1:]):
        if y - x < 1 / FPS:
            continue
        f = factor((x + y) / 2)
        if segs and segs[-1][2] == f and abs(segs[-1][1] - x) < 1e-6:
            segs[-1] = (segs[-1][0], y, f)
        else:
            segs.append((x, y, f))
    if not segs or all(f == 1.0 for _, _, f in segs):
        return mp4, nf, [(0.0, dur, 1.0)]
    filt = ''.join(f'[0:v]trim=start={a:.3f}:end={b:.3f},setpts=(PTS-STARTPTS)/{f}[s{i}];' for i, (a, b, f) in enumerate(segs))
    filt += ''.join(f'[s{i}]' for i in range(len(segs))) + f'concat=n={len(segs)}:v=1:a=0,fps={FPS}[out]'
    out = mp4[:-4] + '-sq.mp4'
    new_nf = frames(sum((b - a) / f for a, b, f in segs))
    run(['ffmpeg', '-y', '-v', 'error', '-i', mp4, '-filter_complex', filt, '-map', '[out]', '-frames:v', str(new_nf), '-r', str(FPS),
         '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', out])
    return out, new_nf, segs


def local_to_film(segs, x):
    t = 0.0
    for a, b, f in segs:
        if x < b:
            return t + max(0.0, x - a) / f
        t += (b - a) / f
    return t


def nova_voice(out_dir):
    """The live take's Nova voice: <out>/nova-audio.jsonl holds each 100 ms frame (24 kHz PCM16, base64) with the wall-clock time
    Vera's browser received it. Frames run together into one utterance until one says it is the last (or the run or the count
    breaks); each utterance is written as a WAV and placed at its first frame's arrival, as the browser starts playing it then."""
    src = os.path.join(out_dir, 'nova-audio.jsonl')
    if not os.path.exists(src):
        return []
    frames = [json.loads(line) for line in open(src) if line.strip()]
    utterances, cur = [], None
    for f in frames:
        if cur and (f['runId'] != cur['runId'] or f['seq'] != cur['seq'] + 1):
            utterances.append(cur)
            cur = None
        if cur is None:
            cur = {'runId': f['runId'], 'at': f['atMs'], 'rate': f.get('sampleRate') or 24000, 'pcm': bytearray(), 'seq': f['seq']}
        cur['pcm'] += base64.b64decode(f['pcm'])
        cur['seq'] = f['seq']
        if f.get('last'):
            utterances.append(cur)
            cur = None
    if cur:
        utterances.append(cur)
    out = []
    os.makedirs(os.path.join(out_dir, 'audio'), exist_ok=True)
    for i, u in enumerate(utterances):
        rel = os.path.join('audio', f'nova-{i + 1:03d}.wav')
        with wave.open(os.path.join(out_dir, rel), 'wb') as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(u['rate'])
            w.writeframes(bytes(u['pcm']))
        out.append({'who': 'nova', 'text': '(Nova, live)', 'file': rel, 'atMs': u['at'], 'durMs': round(len(u['pcm']) / 2 / u['rate'] * 1000), 'heard': False})
    print(f'  Nova\'s voice: {len(frames)} frames in {len(utterances)} utterances')
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--check', action='store_true')
    ap.add_argument('--final', help='the film file (default <out>/nova-in-the-meeting.mp4)')
    ap.add_argument('--no-squeeze', action='store_true', help='keep unchanged stretches at normal speed')
    a = ap.parse_args()
    out_dir = os.path.abspath(a.out)
    tl = json.load(open(os.path.join(out_dir, 'timeline.json')))
    cards = tl.get('cards', {})
    tl['speech'] = tl['speech'] + nova_voice(out_dir)
    tmp = os.path.join(out_dir, 'parts')
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(tmp)

    parts, t = [], 0.0  # film time in seconds, kept in whole frames
    shot_map = []  # (wall from, wall to, film start) for placing speech
    opening = os.path.join(tmp, 'card-open.png')
    c = cards.get('open', {})
    card_png(opening, None, c.get('title', 'Nova in the meeting'), c.get('text', 'A meeting assistant that hears everyone in a call, answers when asked, acts only with consent, and leaves minutes behind.'), eyebrow=c.get('eyebrow', 'Observability Platform · a call with Vera, Nora and Eli'))
    n = frames(OPEN_SECS)
    encode_card(opening, n, os.path.join(tmp, 'card-open.mp4'))
    parts.append(os.path.join(tmp, 'card-open.mp4'))
    t += n / FPS
    check_points = []
    for scene in tl['scenes']:
        if TITLE_SECS > 0:
            png = os.path.join(tmp, f'card-{scene["n"]:02d}.png')
            card_png(png, str(scene['n']), scene['title'], scene['caption'])
            n = frames(TITLE_SECS)
            mp4 = os.path.join(tmp, f'card-{scene["n"]:02d}.mp4')
            encode_card(png, n, mp4)
            parts.append(mp4)
            t += n / FPS
        longest = None
        for i, shot in enumerate(scene['shots']):
            if shot.get('to') is None or shot['to'] <= shot['from']:
                continue
            mp4, nf = encode_shot(tl, out_dir, shot, scene, i, tmp)
            spd = shot.get('speed', 1) or 1
            protect = [((s['atMs'] - shot['from']) / 1000 / spd - 0.2, (s['atMs'] + s['durMs'] - shot['from']) / 1000 / spd + 0.2)
                       for s in tl['speech'] if s['atMs'] < shot['to'] and s['atMs'] + s['durMs'] > shot['from']]
            protect += [((h0 - shot['from']) / 1000 / spd, (h1 - shot['from']) / 1000 / spd)
                        for h0, h1 in tl.get('holds', []) if h0 < shot['to'] and h1 > shot['from']]
            shown = {v['v'] for v in shot['views']}
            protect += [((c['atMs'] - shot['from']) / 1000 / spd, (c['atMs'] + c['leadMs'] - shot['from']) / 1000 / spd + 0.2)
                        for c in tl['clicks'] if c['video'] in shown and shot['from'] <= c['atMs'] < shot['to']]
            mp4, nf, segs = (mp4, nf, [(0.0, nf / FPS, 1.0)]) if a.no_squeeze else squeeze(mp4, nf, protect)
            parts.append(mp4)
            shot_map.append((shot['from'], shot['to'], t, scene['n'], spd, segs))
            if longest is None or nf > longest[1]:
                longest = (t, nf)
            t += nf / FPS
        if longest:
            check_points.append((scene['n'], longest[0] + longest[1] / FPS * 0.7))
        print(f'scene {scene["n"]:2d} {scene["title"]}: ends at {t:6.1f}s', flush=True)
    closing = os.path.join(tmp, 'card-close.png')
    c = cards.get('close', {})
    card_png(closing, None, c.get('title', 'Nova'), c.get('text', 'Hears the call, answers in the chat or aloud, asks before it writes, notices what the team agrees, and leaves minutes only the people in the call can read.'), eyebrow=c.get('eyebrow', 'Recorded on the mock world: fictional people and data'))
    n = frames(OPEN_SECS)
    encode_card(closing, n, os.path.join(tmp, 'card-close.mp4'))
    parts.append(os.path.join(tmp, 'card-close.mp4'))
    t += n / FPS
    total = t

    lst = os.path.join(tmp, 'parts.txt')
    with open(lst, 'w') as f:
        for p in parts:
            f.write(f"file '{p}'\n")
    video = os.path.join(tmp, 'video.mp4')
    run(['ffmpeg', '-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', lst, '-c', 'copy', video])

    # Audio: each clip at its film time.
    placed = []
    for sp in tl['speech']:
        hit = next((m for m in shot_map if m[0] <= sp['atMs'] < m[1]), None)
        if not hit:
            print(f'  speech not in any shot, left out: {sp["who"]}: {sp["text"][:60]}')
            continue
        at = hit[2] + local_to_film(hit[5], (sp['atMs'] - hit[0]) / 1000 / hit[4])
        if sp['atMs'] + sp['durMs'] > hit[1] + 300:
            nxt = next((m for m in shot_map if m[0] >= hit[1] - 5 and m[0] <= hit[1] + 5), None)
            if not nxt:
                print(f'  speech runs past its shot by {(sp["atMs"] + sp["durMs"] - hit[1]) / 1000:.1f}s: {sp["who"]}: {sp["text"][:60]}')
        placed.append((at, os.path.join(out_dir, sp['file'])))
    audio = os.path.join(tmp, 'audio.m4a')
    if placed:
        inputs, filters = [], []
        for i, (at, f) in enumerate(placed):
            inputs += ['-i', f]
            ms = int(round(at * 1000))
            filters.append(f'[{i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay={ms}|{ms}[a{i}]')
        mix = ''.join(f'[a{i}]' for i in range(len(placed)))
        filters.append(f'{mix}amix=inputs={len(placed)}:normalize=0:dropout_transition=0,apad,atrim=0:{total:.3f},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[aout]')
        run(['ffmpeg', '-y', '-v', 'error', *inputs, '-filter_complex', ';'.join(filters), '-map', '[aout]', '-c:a', 'aac', '-b:a', '160k', audio])
    else:
        run(['ffmpeg', '-y', '-v', 'error', '-f', 'lavfi', '-i', f'anullsrc=r=48000:cl=stereo', '-t', f'{total:.3f}', '-c:a', 'aac', audio])

    final = os.path.abspath(a.final) if a.final else os.path.join(out_dir, 'nova-in-the-meeting.mp4')
    run(['ffmpeg', '-y', '-v', 'error', '-i', video, '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'copy',
         '-t', f'{total:.3f}', '-movflags', '+faststart', final])
    size = os.path.getsize(final) / 1e6
    print(f'film: {final} ({total / 60:.1f} min, {size:.0f} MB, {len(placed)} spoken clips)')

    if a.check:
        chk = os.path.join(out_dir, 'check')
        shutil.rmtree(chk, ignore_errors=True)
        os.makedirs(chk)
        for n_, at in check_points:
            run(['ffmpeg', '-y', '-v', 'error', '-ss', f'{at:.2f}', '-i', final, '-frames:v', '1', '-vf', 'scale=1280:-2', os.path.join(chk, f'scene-{n_:02d}.png')])
        print(f'check frames in {chk}')


if __name__ == '__main__':
    main()
