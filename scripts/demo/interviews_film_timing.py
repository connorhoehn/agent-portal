"""Whisper-word timing audit. Speaker labels come from recorded source cues, not diarization."""
import json
import subprocess
import statistics
import html
from pathlib import Path


def at(ms, composition):
    t = (ms - composition['sourceStartMs']) / 1000
    return t - sum(max(0, min(t, c['b']) - c['a']) for c in composition['cuts'])


def audit(take):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import numpy as np
    from matplotlib.ticker import FuncFormatter, MultipleLocator

    take = Path(take)
    qa = take / 'qa'
    transcript = json.loads((qa / 'transcript.json').read_text())
    composition = json.loads((take / 'composition.json').read_text())
    timeline = json.loads((take / 'timeline.json').read_text())
    duration = transcript['durationSeconds']
    turns = []
    for i, cue in enumerate(timeline.get('speech', [])):
        start = at(cue['atMs'], composition)
        end = at(cue['atMs'] + cue['durMs'], composition)
        turns.append(dict(id=cue.get('id', f'human-{i}'), who=cue['who'], start=start, end=end, expected=cue['text'], words=[]))
    for i, cue in enumerate(timeline.get('milo', [])):
        start = at(cue['startMs'], composition)
        end = at(cue['startMs'] + cue['ms'], composition)
        turns.append(dict(id=f'milo-{i}', who='milo', start=start, end=end, expected=None, words=[]))
    turns.sort(key=lambda t: t['start'])
    unknown = []
    for segment in transcript['segments']:
        for word in segment.get('words', []):
            mid = (word['start'] + word['end']) / 2
            candidates = [t for t in turns if t['start'] - .3 <= mid <= t['end'] + .3]
            candidates.sort(key=lambda t: max(0, min(word['end'], t['end']) - max(word['start'], t['start'])), reverse=True)
            # Multiple simultaneous speakers cannot be resolved from mixed-audio Whisper.
            true = [t for t in candidates if t['start'] <= mid <= t['end']]
            if not candidates or len({t['who'] for t in true}) > 1:
                unknown.append(word)
            else:
                candidates[0]['words'].append(word)
    measured = []
    for t in turns:
        if not t['words']:
            continue
        t['heard'] = ''.join(w['word'] for w in t['words']).strip()
        t['audibleStart'] = min(w['start'] for w in t['words'])
        t['audibleEnd'] = max(w['end'] for w in t['words'])
        measured.append(t)
    measured.sort(key=lambda t: t['audibleStart'])
    gaps = []
    for previous, current in zip(measured, measured[1:]):
        gaps.append(dict(start=previous['audibleEnd'], end=current['audibleStart'],
                         seconds=round(current['audibleStart']-previous['audibleEnd'], 3),
                         fromId=previous['id'], toId=current['id'],
                         fromWho=previous['who'], toWho=current['who'],
                         before=previous['heard'], after=current['heard']))
    overlaps = []
    for i, left in enumerate(turns):
        for right in turns[i+1:]:
            if right['start'] >= left['end']:
                break
            if left['who'] != right['who']:
                overlaps.append(dict(start=right['start'], end=min(left['end'],right['end']),
                                     speakers=[left['who'],right['who']], ids=[left['id'],right['id']]))
    human_changes = [g['seconds'] for g in gaps if g['fromWho'] in ('hugo','cand') and g['toWho'] in ('hugo','cand') and g['fromWho'] != g['toWho']]
    summary = dict(humanSpeakerChanges=len(human_changes),
                   medianHumanGapSeconds=round(statistics.median(human_changes),3) if human_changes else None,
                   fastestHumanGapSeconds=min(human_changes, default=None),
                   minimumHumanSourceWindowGapSeconds=round(min((b['start']-a['end'] for a,b in zip(turns,turns[1:])
                       if a['who'] in ('hugo','cand') and b['who'] in ('hugo','cand') and a['who'] != b['who']), default=0),3),
                   miloResponseGapsSeconds=[g['seconds'] for g in gaps if g['toWho']=='milo'],
                   gapsOverFiveSeconds=[g for g in gaps if g['seconds']>5])
    data = dict(film=transcript['film'], sha256=transcript['sha256'], summary=summary,
                method='Whisper word boundaries on final mixed audio, labeled using recorded source cue windows. Not independent speaker diarization. Overlap windows are potential audio overlap, not proof of simultaneous words.',
                turns=measured, gaps=gaps, potentialOverlaps=overlaps, unassignedWords=unknown)
    (qa / 'dialogue-timing.json').write_text(json.dumps(data,indent=2)+'\n')
    colors = {'hugo':'#2563eb','cand':'#059669','milo':'#9333ea','unknown':'#64748b'}
    names = {'hugo':'Hugo','cand':'Mateo','milo':'Milo','unknown':'Unassigned / overlap'}
    rows = {name: i for i,name in enumerate(colors)}
    fig, axes = plt.subplots(3,1,figsize=(20,8),sharex=True,gridspec_kw={'height_ratios':[3,1,2]})
    ax = axes[0]
    for t in turns:
        y=rows.get(t['who'],3)
        ax.broken_barh([(t['start'],max(0,t['end']-t['start']))],(y-.3,.6),facecolors=colors.get(t['who'],'gray'),alpha=.12)
        for w in t['words']:
            ax.broken_barh([(w['start'],max(.035,w['end']-w['start']))],(y-.25,.5),facecolors=colors.get(t['who'],'gray'))
    for w in unknown:
        ax.broken_barh([(w['start'],max(.035,w['end']-w['start']))],(2.75,.5),facecolors=colors['unknown'])
    for overlap in overlaps:
        ax.axvspan(overlap['start'],overlap['end'],color='#dc2626',alpha=.2)
    ax.set_yticks(list(rows.values()),[names[n] for n in rows]); ax.invert_yaxis()
    ax.set_title('Speech by speaker — solid marks: Whisper words; pale bars: recorded source windows',loc='left')
    raw=subprocess.run(['ffmpeg','-v','error','-i',transcript['film'],'-vn','-ac','1','-ar','8000','-f','f32le','pipe:1'],capture_output=True,check=True).stdout
    pcm=np.frombuffer(raw,dtype='<f4'); block=400; n=len(pcm)//block
    rms=np.sqrt(np.mean(pcm[:n*block].reshape(n,block)**2,axis=1))
    axes[1].plot(np.arange(n)*block/8000,20*np.log10(np.maximum(rms,1e-5)),lw=.6,color='#334155')
    axes[1].set_ylim(-80,0); axes[1].set_ylabel('Mix dBFS'); axes[1].grid(alpha=.15)
    for gap in gaps:
        color='#dc2626' if gap['seconds']<.2 else '#d97706' if gap['seconds']>1.5 else '#059669'
        axes[2].vlines(gap['end'],0,gap['seconds'],color=color,lw=2)
        axes[2].scatter([gap['end']],[gap['seconds']],color=color,s=12)
        if gap['seconds']>3:
            axes[2].annotate(f"{gap['seconds']:.1f}s",(gap['end'],gap['seconds']),xytext=(0,5),textcoords='offset points',ha='center',fontsize=8)
    axes[2].axhline(0,color='black',lw=.6); axes[2].axhline(1.5,color='#d97706',lw=.7,ls='--',alpha=.5)
    axes[2].set_ylabel('Gap before next cue (s)')
    axes[2].set_title('Response gaps — amber >1.5s and red <0.2s are review prompts, not automatic failures',loc='left')
    axes[2].xaxis.set_major_locator(MultipleLocator(15)); axes[2].xaxis.set_major_formatter(FuncFormatter(lambda x,p:f'{int(x)//60}:{int(x)%60:02d}'))
    axes[2].set_xlabel('Time in delivered film'); axes[2].set_xlim(0,duration); axes[2].grid(alpha=.15)
    fig.suptitle(f'{take.parent.name}/{take.name}: dialogue timing audit',fontsize=18)
    fig.text(.01,.01,'Speaker attribution uses source timing. Whisper boundaries are approximate. Review pauses against visible work and question/answer meaning.',fontsize=9)
    fig.tight_layout(rect=(0,.035,1,.95)); fig.savefig(qa/'dialogue-timing.png',dpi=140); fig.savefig(qa/'dialogue-timing.svg')
    graph_left, _, graph_width, _ = axes[2].get_position().bounds
    plt.close(fig)
    def stamp(t):return f'{int(t)//60}:{t%60:04.1f}'
    lines=['# Dialogue timing audit','',data['method'],'',f'Film SHA-256: `{transcript["sha256"]}`','',
           '[Timing graph](dialogue-timing.png) · [Scalable graph](dialogue-timing.svg) · [Measurements](dialogue-timing.json)','',
           'Thresholds flag review points; they do not certify natural pacing. A pending question can be interrupted even with no audio overlap. Read the adjacent responses and inspect visible activity.','',
           f'Median gap at human speaker changes: {summary["medianHumanGapSeconds"]} seconds. Milo response gaps: {summary["miloResponseGapsSeconds"]} seconds.','',
           '| Next cue | Gap | From → to | Previous utterance | Next utterance |','|---|---:|---|---|---|']
    for g in gaps:
        lines.append(f"| {stamp(g['end'])} | {g['seconds']:.2f}s | {names.get(g['fromWho'])} → {names.get(g['toWho'])} | {g['before'].replace('|','/')} | {g['after'].replace('|','/')} |")
    lines += ['',f'Potential source-window overlaps: {len(overlaps)}. Unassigned/ambiguous Whisper words: {len(unknown)}.']
    (qa/'dialogue-timing.md').write_text('\n'.join(lines)+'\n')
    table_rows = ''.join(f'<tr><td><button data-time="{max(0,g["start"]-1):.3f}">{stamp(g["end"])}</button></td><td>{g["seconds"]:.2f}s</td><td>{html.escape(names.get(g["fromWho"],g["fromWho"]))} → {html.escape(names.get(g["toWho"],g["toWho"]))}</td><td>{html.escape(g["before"])}</td><td>{html.escape(g["after"])}</td></tr>' for g in gaps)
    (qa/'dialogue-timing.html').write_text(f'''<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Dialogue timing review</title>
<style>body{{font:16px system-ui;margin:24px;color:#172033;background:#f8fafc}}main{{max-width:1500px;margin:auto}}video{{display:block;width:min(100%,1000px);background:#111;margin:20px auto}}img{{width:100%;cursor:crosshair}}table{{border-collapse:collapse;width:100%;font-size:14px}}th,td{{padding:10px;text-align:left;border-bottom:1px solid #cbd5e1;vertical-align:top}}button{{padding:7px 12px;cursor:pointer}}.scroll{{overflow:auto}}p{{max-width:1000px}}</style>
<main><h1>Dialogue timing review</h1><p>Click the graph to seek to that time, or a response time to play the surrounding exchange. Timing flags need context: inspect the question, response and visible work together.</p>
<video id="film" controls preload="metadata" src="../{html.escape(Path(transcript['film']).name,quote=True)}"></video>
<img id="graph" src="dialogue-timing.svg" alt="Speaker lanes, mixed-audio waveform and response gaps">
<p>{html.escape(data['method'])}</p><p>Whisper median human response gap: {summary['medianHumanGapSeconds']}s. Minimum recorded human source-window gap: {summary['minimumHumanSourceWindowGapSeconds']}s.</p>
<div class="scroll"><table><thead><tr><th>Play exchange</th><th>Gap</th><th>Speakers</th><th>Before</th><th>After</th></tr></thead><tbody>{table_rows}</tbody></table></div>
<p>Film SHA-256: <code>{transcript['sha256']}</code></p></main>
<script>const film=document.getElementById('film');function seek(t){{film.currentTime=Math.max(0,Math.min({duration},t));film.scrollIntoView({{block:'start',behavior:'smooth'}});film.play().catch(()=>{{}});}}document.querySelectorAll('[data-time]').forEach(b=>b.addEventListener('click',()=>seek(Number(b.dataset.time))));document.getElementById('graph').addEventListener('click',e=>{{const r=e.currentTarget.getBoundingClientRect();const x=(e.clientX-r.left)/r.width;seek((x-{graph_left})/{graph_width}*{duration});}});</script></html>''')
    print(f'Timing graph and response table: {qa / "dialogue-timing.md"}')


if __name__ == '__main__':
    import sys
    audit(sys.argv[1])
