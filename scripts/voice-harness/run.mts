#!/usr/bin/env -S npx tsx
// The voice harness: recorded scenario speech fed straight into a Live session (and, optionally, one provider
// transcription stream per person), no browser, no SFU, scored automatically. Started as the hands-free Milo probe.
//
//   cd middleware && npx tsx ../scripts/voice-harness/run.mts <scenario> --clips <dir> --env-file <path> --out <rows.jsonl>
//        [--method provider|create|mute|instr|burst] [--quiet-ms 350] [--burst-ms 1000] [--pace 1] [--n 22]
//        [--transcribe] [--no-live] [--delay minimal] [--words <whisper.json>] [--ledger <spend.json>] [--cap 5] [--yes]
//   cd middleware && npx tsx ../scripts/voice-harness/run.mts schema|idle --env-file <path> [--ledger <spend.json>]
//     schema: which session fields the provider takes (refusals are free); idle: what an idle session bills (three ~30 s sessions)
//
// Scenarios: scenarios.mts (latency, chatter, name-last, followup, barge, transcribe). Clips: make-clips.py (24 kHz mono
// PCM16, trimmed so the clip's end is the speech end); --words is stream-whisper.py's output (where "Milo" ends in each clip).
// Feeding: every person is a stream of 100 ms frames on one real-time clock (frame k carries the audio of the 100 ms before
// it is sent, as a microphone would). Our VAD watches each person's own frames; when it sees --quiet-ms of quiet after
// speech on a step marked `trigger`, the method runs: provider = nothing (the provider's own turn close), create =
// response.create, mute = session.input_audio.mute (unmuted at the next clip), instr = session.instructions.append
// ("answer now"), burst = --burst-ms of silence sent at once.
// Scoring per step: speech end -> Milo's first voiced audio (the first 10 ms window over RMS 100 in an output frame, at
// its arrival), reply end, spoke-when-not-asked, overlap with anyone's speech, "Milo" in the transcript vs where it was
// spoken. Milo's audio is reduced to energy on arrival and never kept; his words (text) are kept in the rows.
// Spend: every run books the provider's billed seconds in the ledger and refuses to start past --cap (USD).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  FRAME_BYTES, FRAME_MS, LiveProbe, TranscribeProbe, USD_PER_LIVE_MINUTE, USD_PER_TRANSCRIBE_MINUTE, Vad, jsonlLogger,
  loadKey, now, pct, readWav, sleep,
} from './lib.mjs';
import { MILO_INSTRUCTIONS, scenarios, type Step } from './scenarios.mjs';

const args = process.argv.slice(2);
const opt = (n: string, d = ''): string => { const i = args.indexOf(n); return i >= 0 ? (args[i + 1] ?? d) : d; };
const flag = (n: string): boolean => args.includes(n);
const name = args[0] ?? '';
const envFile = opt('--env-file');
const ledgerPath = opt('--ledger');
const cap = Number(opt('--cap', '5'));

interface Ledger { liveSeconds: number; transcribeSeconds: number; runs: Array<Record<string, unknown>> }
const readLedger = (): Ledger => (ledgerPath && existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) as Ledger : { liveSeconds: 0, transcribeSeconds: 0, runs: [] });
const spent = (l: Ledger): number => (l.liveSeconds / 60) * USD_PER_LIVE_MINUTE + (l.transcribeSeconds / 60) * USD_PER_TRANSCRIBE_MINUTE;
function book(live: number, tx: number, run: Record<string, unknown>): Ledger {
  const l = readLedger(); l.liveSeconds += live; l.transcribeSeconds += tx; l.runs.push({ ...run, live, tx, at: new Date().toISOString() });
  if (ledgerPath) writeFileSync(ledgerPath, JSON.stringify(l, null, 1));
  return l;
}

/** (b) Which session fields might switch off the provider's own replies. A refusal comes before the start and bills nothing. */
async function schema(): Promise<void> {
  const candidates: Array<[string, Record<string, unknown>]> = [
    ['turn_detection:null', { turn_detection: null }],
    ['turn_detection:{type:none}', { turn_detection: { type: 'none' } }],
    ['create_response:false', { create_response: false }],
    ['audio.input.turn_detection:null', { audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: 'marin' }, input: { turn_detection: null } } }],
    ['audio.input.create_response', { audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: 'marin' }, input: { create_response: false } } }],
    ['turn_taking:manual', { turn_taking: 'manual' }],
    ['response:{auto:false}', { response: { auto: false } }],
    ['auto_response:false', { auto_response: false }],
    ['input_audio_transcription', { input_audio_transcription: { model: 'gpt-live-transcribe' } }],
    ['audio.input.transcription', { audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: 'marin' }, input: { transcription: { model: 'gpt-live-transcribe' } } } }],
    ['speak:false', { speak: false }],
    ['modalities:[text]', { modalities: ['text'] }],
    ['output_modalities:[text]', { output_modalities: ['text'] }],
  ];
  for (const [label, extra] of candidates) {
    const before = readLedger();
    if (spent(before) > cap - 0.05) { console.log('CAP reached; stop'); return; }
    const p = new LiveProbe();
    const t = now();
    try {
      const s = await p.start({ instructions: 'You are Milo. Stay silent.', extra, timeoutMs: 8000 });
      console.log('ACCEPTED', label, 'echoed keys:', Object.keys(s).join(','), 'echo of field:', JSON.stringify(extra).slice(0, 80), '->', JSON.stringify(Object.fromEntries(Object.keys(extra).map((k) => [k, s[k]]))).slice(0, 160));
      await p.close();
      const l = book(Math.max(p.usageSeconds, Math.ceil((now() - t) / 1000)), 0, { name: 'schema', label });
      console.log('  billed', p.usageSeconds, 's; spend $', spent(l).toFixed(3));
    } catch (e) {
      console.log('REFUSED', label, '->', (e as Error).message.slice(0, 200));
      try { p.socket?.close(1000); } catch { /* closed */ }
    }
    await sleep(300);
  }
}

/** Milo's voice runs: a pause shorter than this is the same reply (he stalls 1-2 s mid-sentence, live-session.ts). */
const RUN_GAP_MS = 2000;

/** (e) What an idle session bills: 5 s of silence, then 20 s of (a) nothing sent, (b) silence while muted, (c) silence; then 5 s. */
async function idleCost(): Promise<void> {
  const silence = Buffer.alloc(FRAME_BYTES);
  for (const mode of ['nothing', 'muted', 'silence'] as const) {
    if (spent(readLedger()) > cap - 0.05) { console.log('CAP reached; stop'); return; }
    const p = new LiveProbe(); await p.start({ instructions: 'You are Milo. Stay silent.' });
    const t = now(); let k = 0;
    const feed = async (ms: number, send: boolean): Promise<void> => { const end = k + ms / FRAME_MS; for (; k < end; k += 1) { await sleep(t + (k + 1) * FRAME_MS - now()); if (send) p.append(silence); } };
    await feed(5000, true);
    if (mode === 'muted') p.send({ type: 'session.input_audio.mute', event_id: 'idle_mute' });
    await feed(20_000, mode !== 'nothing');
    if (mode === 'muted') p.send({ type: 'session.input_audio.unmute', event_id: 'idle_unmute' });
    await feed(5000, true);
    const usageBefore = p.usageSeconds; await p.close();
    const wall = Math.round((now() - t) / 1000);
    book(Math.max(p.usageSeconds, 15), 0, { name: 'idle', label: mode });
    console.log('IDLE', mode, 'wall', wall, 's; billed', p.usageSeconds, 's (last update before close', usageBefore, '); closed', p.closeReason, 'errors', p.errors.map((e) => e.code).join(','));
  }
}

interface Rec {
  i: number; id: string; speaker: string; expect: string; method: string;
  clipStartWall?: number; speechEndWall?: number; vadWall?: number; firstVoice?: number; lastVoice?: number;
  outText: string; outTextWall?: number; inText: string; nameInputWall?: number; txText: string; txNameWall?: number; txCompletedWall?: number;
  done: boolean; noReply?: boolean; overlapFrames: number; stopRelayWall?: number; errors: string[];
}

async function runScenario(): Promise<void> {
  const clipsDir = opt('--clips'); const out = opt('--out');
  const method = opt('--method', 'provider'); const quietMs = Number(opt('--quiet-ms', '350')); const burstMs = Number(opt('--burst-ms', '1000'));
  const pace = Number(opt('--pace', '1')); const n = Number(opt('--n', '22')); const live = !flag('--no-live'); const transcribe = flag('--transcribe');
  const maxSessionMs = Number(opt('--max-s', '260')) * 1000;
  const sc = scenarios(n)[name];
  if (!sc) throw new Error(`unknown scenario ${name}`);
  if (!clipsDir || !out) throw new Error('--clips and --out are needed');
  const index = JSON.parse(readFileSync(`${clipsDir}/clips.json`, 'utf8')) as Record<string, { seconds: number; text: string }>;
  const words = opt('--words') ? Object.fromEntries((JSON.parse(readFileSync(opt('--words'), 'utf8')) as Array<{ id: string; name_end_s: number | null }>).map((r) => [r.id, r.name_end_s])) : {};
  const pcm: Record<string, Buffer> = {};
  for (const s of sc.steps) pcm[s.clip] ??= readWav(`${clipsDir}/${s.clip}.wav`);
  const speakers = [...new Set(sc.steps.map((s) => s.speaker))];
  const planS = sc.steps.reduce((a, s) => a + s.gapMs / 1000 + index[s.clip]!.seconds + (s.expect === 'reply' ? 6 : 0), 0);
  const estimate = (live ? (Math.min(planS, maxSessionMs / 1000) / 60) * USD_PER_LIVE_MINUTE : 0) + (transcribe ? (planS / 60) * USD_PER_TRANSCRIBE_MINUTE * speakers.length : 0);
  const before = readLedger();
  console.log(`scenario ${name} method ${method}: ${sc.steps.length} steps, ~${Math.round(planS)} s, estimate $${estimate.toFixed(3)}; spent so far $${spent(before).toFixed(3)} of $${cap}`);
  if (spent(before) + estimate > cap) { console.log('CAP: refusing to start'); return; }
  if (!flag('--yes')) { console.log('dry: pass --yes to run'); return; }
  loadKey(envFile);
  const log = jsonlLogger(out);

  const recs: Rec[] = sc.steps.map((s, i) => ({ i, id: s.clip, speaker: s.speaker, expect: s.expect, method: s.trigger ? method : 'none', outText: '', inText: '', txText: '', done: false, overlapFrames: 0, errors: [] }));
  const strays: Array<{ afterStep: number; atWall: number }> = [];
  let runOwner: Rec | null = null; // the step Milo's current voice run belongs to
  let lastVoiceAny = 0;
  // holdUntil/held: hands-free routing; the person's frames reach the session only once their name was detected (the
  // name's end + --detect-ms), the withheld start of the sentence then goes at once and the rest in real time.
  const person: Record<string, { clip: Buffer | null; pos: number; vad: Vad; rec: Rec | null; tx: TranscribeProbe | null; holdUntil: number; held: Buffer[] }> = {};
  for (const sp of speakers) person[sp] = { clip: null, pos: 0, vad: new Vad(quietMs), rec: null, tx: null, holdUntil: 0, held: [] };
  const route = !flag('--no-route'); const detectMs = Number(opt('--detect-ms', '-1'));
  const speaking = (): boolean => Object.values(person).some((p) => p.clip !== null);

  const onVoice = (at: number): void => {
    const cont = lastVoiceAny > 0 && at - lastVoiceAny < RUN_GAP_MS && runOwner;
    lastVoiceAny = at;
    if (speaking()) { const r = runOwner ?? recs.findLast((x) => x.clipStartWall !== undefined); if (r) r.overlapFrames += 1; }
    if (cont && runOwner) { runOwner.lastVoice = at; return; }
    // a new run of voice: the step awaiting a reply owns it, else it was not asked for
    // only after its speech ended: voice that starts while someone is still asking is an interjection, not the answer
    const awaiting = recs.find((r) => r.expect === 'reply' && r.speechEndWall !== undefined && r.firstVoice === undefined && !r.done);
    if (awaiting) { awaiting.firstVoice = at; awaiting.lastVoice = at; runOwner = awaiting; return; }
    const last = recs.findLast((r) => r.clipStartWall !== undefined);
    runOwner = last ?? null;
    if (last) { strays.push({ afterStep: last.i, atWall: at }); if (last.firstVoice !== undefined || last.expect === 'silent') last.lastVoice = at; }
  };
  const probe = live ? new LiveProbe({
    onVoice,
    onOutputText: (d, at) => {
      // the words lead the voice: they belong to the step awaiting its reply, else to the run playing now
      const awaiting = recs.find((r) => r.expect === 'reply' && r.speechEndWall !== undefined && r.firstVoice === undefined && !r.done);
      const r = awaiting ?? runOwner; if (!r) return;
      r.outText += d; r.outTextWall ??= at;
    },
    onInputText: (d, at) => {
      const r = recs.findLast((x) => x.clipStartWall !== undefined && (x.speechEndWall === undefined || at - x.speechEndWall < 4000));
      if (!r) return; r.inText += d; if (r.nameInputWall === undefined && /\bmilo\b/i.test(r.inText)) r.nameInputWall = at;
    },
    onOther: (e, at) => {
      if (e['type'] === 'error') { const r = recs.findLast((x) => x.clipStartWall !== undefined); const er = (e['error'] ?? e) as { code?: unknown; message?: unknown }; r?.errors.push(`${String(er.code ?? 'error')}: ${String(er.message ?? '').slice(0, 120)}`); }
      else if (!['session.usage.updated', 'rate_limits.updated', 'info'].includes(String(e['type']))) log({ k: 'event', type: e['type'], inner: (e['event'] as { type?: unknown } | undefined)?.type, t: Math.round(at) });
    },
  }) : null;

  const txStart = now();
  if (transcribe) {
    for (const sp of speakers) {
      const p = person[sp]!;
      p.tx = new TranscribeProbe((text, at, kind) => {
        const r = p.rec; if (!r) return;
        if (kind === 'completed') { r.txCompletedWall ??= at; if (!r.txText) r.txText = text; return; }
        r.txText += text; if (r.txNameWall === undefined && /\bmilo\b/i.test(r.txText)) r.txNameWall = at;
      });
      await p.tx.start({ delay: opt('--delay') || undefined, keywords: flag('--keywords') ? ['Milo'] : undefined, languages: ['en'] });
    }
  }
  const instructions = sc.instructions ?? MILO_INSTRUCTIONS;
  if (probe) await probe.start({ instructions, voice: opt('--voice', 'marin') });
  const sessionStart = now();
  console.log('started', live ? 'live' : '', transcribe ? `transcribe x${speakers.length}` : '');

  const t0 = now() + 50; let k = 0; let stepIdx = 0; let gapFrom = t0; let muted = false; let maxLate = 0;
  // lead: how far the session's audio runs ahead of the wall clock (bursts, replays). --repay skips silent frames while
  // nobody speaks and Milo is quiet until it is paid back (the provider drops audio that arrives too far ahead).
  const fixtureSent = new Set<number>();
  let lead = 0; let maxLead = 0; const repay = flag('--repay');
  const ahead = (ms: number): void => { lead += ms; maxLead = Math.max(maxLead, lead); };
  const silence = Buffer.alloc(FRAME_BYTES);
  const applyMethod = (r: Rec): void => {
    r.vadWall = now();
    if (!probe) { person[r.speaker]!.tx?.commit(); return; }
    person[r.speaker]!.tx?.commit();
    if (method === 'create') probe.send({ type: 'response.create', event_id: `h_create_${r.i}` });
    else if (method === 'mute') { probe.send({ type: 'session.input_audio.mute', event_id: `h_mute_${r.i}` }); muted = true; }
    else if (method === 'text') probe.send({ type: 'session.instructions.append', event_id: `h_text_${r.i}`, delegation_id: null, content: `${r.speaker === 'cand' ? 'The candidate' : 'Hugo'} just asked you: "${index[r.id]!.text}" Answer now, in one short sentence.` });
    else if (method === 'instr') probe.send({ type: 'session.instructions.append', event_id: `h_instr_${r.i}`, delegation_id: null, content: 'The person has just finished speaking to you. Answer them now.' });
    else if (method === 'burst') for (let b = 0; b < burstMs / FRAME_MS; b += 1) { probe.append(silence); ahead(FRAME_MS); }
  };
  const startStep = (i: number): void => {
    const s = sc.steps[i]!; const r = recs[i]!; const p = person[s.speaker]!;
    if (muted && probe) { probe.send({ type: 'session.input_audio.unmute', event_id: `h_unmute_${i}` }); muted = false; }
    p.clip = pcm[s.clip]!; p.pos = 0; p.rec = r; p.vad.reset(); p.held = [];
    // where the name ends: the reference pass's word time; a clip it missed that opens with the name: 0.45 s (the others' typical end)
    const nameEnd = words[s.clip] ?? (/^milo\b/i.test(index[s.clip]!.text) ? 0.45 : null);
    // hands-free: a sentence without the name never reaches the session (held, then dropped at the person's next step)
    p.holdUntil = detectMs < 0 ? 0 : nameEnd != null ? t0 + (k - 1) * FRAME_MS + nameEnd * 1000 + detectMs : Number.POSITIVE_INFINITY;
    r.clipStartWall = t0 + (k - 1) * FRAME_MS; // frame k (sent at t0 + k*100) carries the 100 ms of audio before it
    const effPace = s.pace === -1 ? pace : (s.pace ?? 1);
    if (effPace !== 1) {
      // a buffered replay: the whole clip (pace 0) or `pace` frames per tick, sent as frames
      if (effPace === 0) {
        for (let at = 0; at < p.clip.length; at += FRAME_BYTES) { const f = Buffer.alloc(FRAME_BYTES); p.clip.copy(f, 0, at, Math.min(p.clip.length, at + FRAME_BYTES)); probe?.append(f); p.tx?.append(f); ahead(FRAME_MS); }
        r.clipStartWall = now(); r.speechEndWall = now(); p.clip = null;
        if (s.trigger) applyMethod(r);
      }
    }
  };

  while (true) {
    k += 1;
    const due = t0 + k * FRAME_MS; const wait = due - now();
    if (wait > 0) await sleep(wait); else maxLate = Math.max(maxLate, -wait);
    const tNow = now();
    if (tNow - sessionStart > maxSessionMs) { console.log('session cap reached'); break; }
    // finish reply waits
    for (const r of recs) {
      if (r.done || r.speechEndWall === undefined) continue;
      if (r.expect === 'silent') { r.done = true; continue; }
      if (r.firstVoice !== undefined && r.lastVoice !== undefined && tNow - r.lastVoice > RUN_GAP_MS) r.done = true;
      else if (r.firstVoice === undefined && tNow - r.speechEndWall > 10_000) { r.done = true; r.noReply = true; }
      if (r.done && r.i === stepIdx - 1) gapFrom = r.firstVoice !== undefined ? r.lastVoice! : tNow;
    }
    // barge-in bookkeeping
    for (const [i, s] of sc.steps.entries()) {
      const r = recs[i]!;
      if (s.stopRelayAfterMs && r.firstVoice !== undefined && r.stopRelayWall === undefined) r.stopRelayWall = r.firstVoice + s.stopRelayAfterMs;
      if (s.stopWithFixture && r.stopRelayWall !== undefined && tNow >= r.stopRelayWall && !fixtureSent.has(i)) {
        fixtureSent.add(i);
        probe?.send({ type: 'session.output_audio.fixture.play', event_id: `h_fixture_${i}`, audio: Buffer.alloc(4800).toString('base64') });
        setTimeout(() => probe?.send({ type: 'session.input_audio.unmute', event_id: `h_fixunmute_${i}` }), 300);
      }
    }
    // start the next step
    if (stepIdx < sc.steps.length && !speaking()) {
      const s = sc.steps[stepIdx]!; const prev = stepIdx > 0 ? recs[stepIdx - 1]! : null;
      const over = s.overMiloAfterMs !== undefined && prev?.firstVoice !== undefined && tNow >= prev.firstVoice + s.overMiloAfterMs;
      const prevDone = !prev || prev.done || (prev.expect === 'silent' && prev.speechEndWall !== undefined);
      if (prev && prev.expect === 'silent' && prev.speechEndWall !== undefined && prev.i === stepIdx - 1 && gapFrom < prev.speechEndWall) gapFrom = prev.speechEndWall;
      if (over || (prevDone && tNow >= gapFrom + s.gapMs)) { startStep(stepIdx); stepIdx += 1; }
    }
    if (stepIdx >= sc.steps.length && recs.every((r) => r.done) && tNow - Math.max(gapFrom, lastVoiceAny) > 2000) break;
    // one frame per person; the session gets the mix
    const mix = new Int32Array(FRAME_BYTES / 2);
    for (const p of Object.values(person)) {
      let f = silence;
      if (p.clip) {
        const s = sc.steps[p.rec!.i]!; const effPace = s.pace === -1 ? pace : (s.pace ?? 1);
        const per = effPace > 1 ? effPace : 1;
        for (let rep = 0; rep < per && p.clip; rep += 1) {
          f = Buffer.alloc(FRAME_BYTES); const end = Math.min(p.clip.length, p.pos + FRAME_BYTES);
          p.clip.copy(f, 0, p.pos, end);
          if (end >= p.clip.length) {
            const r = p.rec!; r.speechEndWall = per > 1 ? now() : r.clipStartWall! + (p.clip.length / (FRAME_BYTES / FRAME_MS));
            p.clip = null;
          } else p.pos = end;
          if (rep < per - 1) { ahead(FRAME_MS); probe?.append(f); p.tx?.append(f); if (p.vad.push(f) && p.rec && sc.steps[p.rec.i]!.trigger && p.rec.vadWall === undefined) applyMethod(p.rec); }
        }
      }
      const own = f; // the person's own frame: their transcription stream and our VAD always get it
      if (!route) f = silence;
      else if (p.holdUntil > 0 && tNow < p.holdUntil) { p.held.push(f); f = silence; }
      else if (p.held.length > 0) { for (const h of p.held) { probe?.append(h); ahead(FRAME_MS); } p.held = []; p.holdUntil = 0; }
      for (let j = 0; j < mix.length; j += 1) mix[j]! += f.readInt16LE(j * 2);
      p.tx?.append(own);
      if (p.vad.push(own) && p.rec && sc.steps[p.rec.i]!.trigger && p.rec.vadWall === undefined) applyMethod(p.rec);
    }
    const frame = Buffer.alloc(FRAME_BYTES);
    for (let j = 0; j < mix.length; j += 1) frame.writeInt16LE(Math.max(-32768, Math.min(32767, mix[j]!)), j * 2);
    const idle = !speaking() && !recs.some((r) => r.expect === 'reply' && r.speechEndWall !== undefined && !r.done) && !(probe?.speakingWithin(RUN_GAP_MS) ?? false);
    if (repay && lead >= FRAME_MS && idle) lead -= FRAME_MS;
    else probe?.append(frame);
  }

  const liveMs = now() - sessionStart;
  if (probe) await probe.close();
  for (const p of Object.values(person)) p.tx?.close();
  const txSeconds = transcribe ? ((now() - txStart) / 1000) * speakers.length : 0;
  const liveSeconds = probe ? Math.max(probe.usageSeconds, Math.ceil(liveMs / 1000), 15) : 0;
  const l = book(liveSeconds, txSeconds, { name, method, quietMs, burstMs, pace });

  // rows + summary
  const lat: number[] = []; const fromVad: number[] = [];
  for (const [i, r] of recs.entries()) {
    const s = sc.steps[i]!;
    const nameEnd = words[r.id] != null && r.clipStartWall !== undefined ? r.clipStartWall + (words[r.id] as number) * 1000 : undefined;
    const row = {
      k: 'step', scenario: name, method: r.method, i, id: r.id, speaker: r.speaker, expect: r.expect,
      latencyMs: r.firstVoice !== undefined && r.speechEndWall !== undefined ? Math.round(r.firstVoice - r.speechEndWall) : null,
      textLeadMs: r.outTextWall !== undefined && r.firstVoice !== undefined ? Math.round(r.firstVoice - r.outTextWall) : null,
      vadToVoiceMs: r.firstVoice !== undefined && r.vadWall !== undefined ? Math.round(r.firstVoice - r.vadWall) : null,
      replyMs: r.firstVoice !== undefined && r.lastVoice !== undefined ? Math.round(r.lastVoice - r.firstVoice) : null,
      noReply: r.noReply ?? false, overlapFrames: r.overlapFrames,
      nameInputDelayMs: nameEnd !== undefined && r.nameInputWall !== undefined ? Math.round(r.nameInputWall - nameEnd) : null,
      txNameDelayMs: nameEnd !== undefined && r.txNameWall !== undefined ? Math.round(r.txNameWall - nameEnd) : null,
      txCompletedAfterEndMs: r.txCompletedWall !== undefined && r.speechEndWall !== undefined ? Math.round(r.txCompletedWall - r.speechEndWall) : null,
      voiceAfterStopMs: r.stopRelayWall !== undefined && r.lastVoice !== undefined ? Math.round(r.lastVoice - r.stopRelayWall) : null,
      miloStoppedAfterInterruptMs: s.overMiloAfterMs !== undefined && i > 0 && recs[i - 1]!.lastVoice !== undefined && r.clipStartWall !== undefined ? Math.round(recs[i - 1]!.lastVoice! - r.clipStartWall) : null,
      inText: r.inText.trim(), txText: r.txText.trim(), outText: r.outText.trim(), errors: r.errors,
    };
    log(row);
    if (row.expect === 'reply' && row.latencyMs !== null) lat.push(row.latencyMs);
    if (row.vadToVoiceMs !== null && row.expect === 'reply') fromVad.push(row.vadToVoiceMs);
    console.log(`${String(i).padStart(2)} ${r.id} ${r.expect.padEnd(6)} lat ${String(row.latencyMs).padStart(5)} reply ${String(row.replyMs).padStart(5)} ov ${r.overlapFrames} nameIn ${row.nameInputDelayMs} tx ${row.txNameDelayMs}${row.voiceAfterStopMs !== null ? ` afterStop ${row.voiceAfterStopMs}` : ''}${row.miloStoppedAfterInterruptMs !== null ? ` miloStoppedAfter ${row.miloStoppedAfterInterruptMs}` : ''}${r.errors.length ? ` ERR ${r.errors.join('|').slice(0, 100)}` : ''} | ${row.outText.slice(0, 60)}`);
  }
  const summary = {
    k: 'summary', scenario: name, method, quietMs, burstMs, pace, replies: lat.length, expected: recs.filter((r) => r.expect === 'reply').length,
    noReply: recs.filter((r) => r.noReply).length, strays: strays.length, strayAfter: strays.map((s) => recs[s.afterStep]!.id),
    medianMs: pct(lat, 50), p90Ms: pct(lat, 90), under2s: lat.filter((x) => x < 2000).length, vadToVoiceMedianMs: pct(fromVad, 50),
    overlapFrames: recs.reduce((a, r) => a + r.overlapFrames, 0), maxLateMs: Math.round(maxLate), maxLeadMs: maxLead, repay,
    billedLiveSeconds: probe?.usageSeconds ?? 0, wallLiveSeconds: Math.round(liveMs / 1000), txSeconds: Math.round(txSeconds),
    providerErrors: probe?.errors.map((e) => `${e.code}${e.param ? `(${e.param})` : ''}: ${e.message ?? ''}`.slice(0, 400)) ?? [],
    spentUsd: Number(spent(l).toFixed(3)),
  };
  log(summary);
  console.log('SUMMARY', JSON.stringify(summary));
}

(name === 'schema' ? (loadKey(envFile), schema()) : name === 'idle' ? (loadKey(envFile), idleCost()) : runScenario()).then(() => process.exit(0), (e: Error) => { console.error('FAILED', e.message); process.exit(1); });
