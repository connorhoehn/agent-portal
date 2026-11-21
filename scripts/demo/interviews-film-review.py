#!/usr/bin/env python3
"""Review the FINAL mixed film, using the same local faster-whisper workflow as ai-3d-storymaker.

uv run --offline --no-project --python 3.10 --with faster-whisper --with matplotlib python \
  scripts/demo/interviews-film-review.py <take-directory>

Requires cached Systran/faster-whisper-base, matplotlib, ffmpeg and ffprobe. Writes a fresh qa/ directory;
refuses to overwrite a prior review. Read review.md and inspect its frames before accepting a take.
Transcription and similarity scores flag places to inspect; they cannot certify conversational sense.
"""
import argparse
import difflib
import hashlib
import json
from pathlib import Path
import re
import subprocess


def run(args):
    return subprocess.run(args, capture_output=True, text=True, check=True)


def timestamp(seconds):
    return f'{int(seconds // 60):02d}:{seconds % 60:04.1f}'


def film_time(ms, composition):
    seconds = (ms - composition['sourceStartMs']) / 1000
    return seconds - sum(max(0, min(seconds, c['b']) - c['a']) for c in composition['cuts'])


def words(text):
    return re.findall(r'[a-z0-9]+', text.lower())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('take', type=Path)
    args = parser.parse_args()
    take = args.take.resolve(strict=True)
    composition = json.loads((take / 'composition.json').read_text())
    timeline = json.loads((take / 'timeline.json').read_text())
    report = json.loads((take / 'report.json').read_text())
    film = Path(composition['film'])
    output = take / 'qa'
    output.mkdir(exist_ok=False)

    from faster_whisper import WhisperModel
    model = WhisperModel('base', device='cpu', compute_type='int8', local_files_only=True)
    segments, info = model.transcribe(str(film), language='en', beam_size=5, word_timestamps=True)
    segments = list(segments)
    heard = [{'start': s.start, 'end': s.end, 'text': s.text.strip(),
              'words': [{'start': w.start, 'end': w.end, 'word': w.word, 'probability': w.probability}
                        for w in (s.words or [])]} for s in segments]
    digest = hashlib.file_digest(film.open('rb'), 'sha256').hexdigest() if hasattr(hashlib, 'file_digest') else hashlib.sha256(film.read_bytes()).hexdigest()
    (output / 'transcript.json').write_text(json.dumps({'film': str(film), 'sha256': digest,
        'model': 'Systran/faster-whisper-base', 'durationSeconds': info.duration, 'segments': heard}, indent=2) + '\n')
    (output / 'transcript.txt').write_text('\n'.join(f"[{timestamp(s['start'])}–{timestamp(s['end'])}] {s['text']}" for s in heard) + '\n')

    noise = run(['ffmpeg', '-hide_banner', '-nostats', '-i', str(film), '-vn', '-af',
                 'silencedetect=n=-40dB:d=5', '-f', 'null', '-']).stderr
    gaps = []
    start = None
    for kind, value in re.findall(r'silence_(start|end): ([0-9.]+)', noise):
        if kind == 'start':
            start = float(value)
        elif start is not None:
            gaps.append({'start': start, 'end': float(value)})
            start = None
    if start is not None:
        gaps.append({'start': start, 'end': info.duration})

    cues = []
    all_words = [w for s in heard for w in s['words']]
    for cue in timeline.get('speech', []):
        if not cue.get('file'):
            continue
        at = film_time(cue['atMs'], composition)
        end = at + cue['durMs'] / 1000
        actual = ''.join(w['word'] for w in all_words if at - 0.3 <= (w['start'] + w['end']) / 2 <= end + 0.3).strip()
        score = difflib.SequenceMatcher(None, words(cue['text']), words(actual)).ratio()
        cues.append({'start': at, 'end': end, 'who': cue['who'], 'expected': cue['text'],
                     'heard': actual, 'orderedSimilarity': round(score, 3)})
    (output / 'alignment.json').write_text(json.dumps(cues, indent=2) + '\n')
    (output / 'gaps.json').write_text(json.dumps(gaps, indent=2) + '\n')

    # Sample the final rendered film, including the ending; these are review aids, not screenshots of a new session.
    frames = sorted(set([min(info.duration - 0.2, float(n)) for n in range(15, int(info.duration), 30)] + [max(0, info.duration - 1)]))
    # Check the screen at the actual dialogue cues, not only an arbitrary 30-second grid.
    for cue in cues:
        if cue['expected'].startswith(("Today's problem is Two Sum.", 'Design Twitter:', 'The prompt guarantees a pair,',
                                       'Checking every pair', 'If the loop finishes')):
            frames.append(min(info.duration - 0.2, cue['start'] + 0.5))
        if cue['expected'].startswith(('Now the high level.', 'Tweets are written', 'Timelines are read',
                                       'When someone tweets', 'For big accounts', 'And the purposes.',
                                       'Sure. For most people', 'We have enough time,', 'If you refactored')):
            frames.append(min(info.duration - 0.2, cue['end'] - 0.2))
    frames = sorted(set(frames))
    frame_lines = []
    for index, at in enumerate(frames):
        filename = f'frame-{index:02d}-{int(at):03d}s.png'
        run(['ffmpeg', '-v', 'error', '-ss', str(at), '-i', str(film), '-frames:v', '1', str(output / filename)])
        frame_lines.append(f'- [{timestamp(at)}]({filename})')

    lines = ['# Film review', '', f'Film: `{film}`', f'SHA-256: `{digest}`', '',
             '**Review status: requires a full transcript read and visual inspection. No automatic editorial approval.**', '',
             f'Product checks: **{report.get("passed", 0)} passed, {report.get("failed", 0)} failed**. Failed checks must be resolved before acceptance.', '',
             f'Model modes recorded by the runner: `{json.dumps(report.get("models", {}))}`', '',
             '## Questions to resolve', '',
             '- Does each response answer the preceding speaker, with no duplicate introduction or missing result reaction?',
             '- Is the question and starter visible on both pads before the problem is read, and does subsequent code match what each speaker points to?',
             '- Do spoken test claims match actual executable cases and run results?',
             '- Do the assessment claims occur in this conversation, with substantive cited evidence?',
             '- Are all cuts honest about elapsed work, and is the final call-to-scorecard transition continuous?', '',
             '## Actual edit', '', f'{composition["sourceDurationSeconds"]:.1f} seconds recorded; {info.duration:.1f} seconds composed.', '']
    lines += [f'- Removed source {timestamp(c["a"])}–{timestamp(c["b"])}: {c["caption"]}' for c in composition['cuts']] or ['No cuts.']
    lines += ['', '## Silence of at least five seconds', '']
    lines += [f'- {timestamp(g["start"])}–{timestamp(g["end"])} ({g["end"] - g["start"]:.1f}s)' for g in gaps] or ['None.']
    lines += ['', '## Lines flagged for listening or transcription review', '', 'Ordered word similarity below 0.80 is a prompt to inspect, not proof of a spoken error. Numerals and names often differ.', '']
    for cue in cues:
        if cue['orderedSimilarity'] < 0.8:
            lines += [f'- {timestamp(cue["start"])} {cue["who"]} ({cue["orderedSimilarity"]:.2f})',
                      f'  - Script: {cue["expected"]}', f'  - Whisper: {cue["heard"]}']
    lines += ['', '## Response timing', '', '[Speaker lanes, waveform and gap graph](dialogue-timing.png) · [Adjacent responses and measurements](dialogue-timing.md)',
              '', '## Frame samples', '', *frame_lines, '', '## Whole-film transcript', '', (output / 'transcript.txt').read_text()]
    (output / 'review.md').write_text('\n'.join(lines) + '\n')
    from interviews_film_timing import audit
    audit(take)
    print(f'Review written to {output / "review.md"}', flush=True)


if __name__ == '__main__':
    main()
