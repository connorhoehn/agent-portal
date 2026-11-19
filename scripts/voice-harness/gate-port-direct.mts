// The probe-style direct driver: one live session (delegation ON, one note tool) plus one provider transcription stream per
// person, joined by a small router of the harness's own. This is the BASELINE the real runtime must beat, not the runtime:
// no rules (a name in passing still routes), no queue (a second "Milo" while the floor is held is ignored), barge-in by
// energy. It follows the probe's hands-free route (HANDSFREE-PROBE.md): the session hears nothing of a person until their
// name is detected, then the withheld start of the sentence goes at once (a burst, repaid by skipping idle frames) and the
// rest in real time; the asker's audio keeps routing through the answer and a 10 s follow-up window.
// Audio: Milo's output is reduced to its timing on arrival; with loopback on it is held one frame in memory and fed to a
// room mic, never written anywhere.
import { LiveProbe, TranscribeProbe, Vad, now, rms, loadKey } from './lib.mjs';
import { HANDSFREE_FRAME_BYTES, HANDSFREE_FRAME_MS } from './gate-clock.mjs';
import type { GatePort, PortEvents, PortOpen } from './gate-player.mjs';
import { MILO_INSTRUCTIONS } from './scenarios.mjs';

const NAME_RE = /\b(milo|mylo|nilo|my low|mi lo|mee lo)\b/i;
const RING_FRAMES = 100; // 10 s
const PREROLL_FRAMES = 50; // 5 s, the provider's burst limit
const FOLLOW_UP_MS = 10_000;
const ANSWER_GAP_MS = 1200; // quiet this long = the answer is over
const GIVE_UP_MS = 12_000; // routed but never answered
const BARGE_FRAMES = 3; // 300 ms of anyone's voice over Milo
const QUIET_COMMIT_MS = 350;
const NOTE_TOOL = {
  type: 'function' as const, name: 'add_note', description: 'Add a short note to the meeting notes.',
  parameters: { type: 'object' as const, properties: { text: { type: 'string' as const, description: 'the note' } }, required: ['text'], additionalProperties: false as const },
};

interface Person {
  id: string; tx: TranscribeProbe | null; txReady: boolean; vad: Vad;
  ring: Array<{ pcm: Buffer; atMs: number }>; last: Buffer | null;
  voicedRun: number; quietMs: number; sentence: { text: string; startMs: number; named: boolean } | null;
}

export interface DirectOptions { envFile: string; voice?: string }

export function directPort(opts: DirectOptions): GatePort {
  let ev: PortEvents | null = null; let live: LiveProbe | null = null;
  const people = new Map<string, Person>();
  let offset = 0; let nowMs = 0; let startedWall = 0;
  let state: 'idle' | 'routing' | 'answering' | 'follow-up' = 'idle';
  let owner: string | null = null; let stateSince = 0; let lastModelVoice = -1e9; let relaying = false; let bargeRun = 0;
  let lead = 0; let backlog: Buffer[] = []; let loop = false; let held: Buffer | null = null; let txStartWall = 0;
  const silence = Buffer.alloc(HANDSFREE_FRAME_BYTES);
  const errors: string[] = [];
  const toSession = (wall: number): number => Math.round(wall - offset);

  const send = (pcm: Buffer): void => { live?.append(pcm); };
  const mkPerson = (id: string): Person => ({ id, tx: null, txReady: false, vad: new Vad(QUIET_COMMIT_MS), ring: [], last: null, voicedRun: 0, quietMs: 1e9, sentence: null });

  async function startTx(p: Person): Promise<void> {
    const tx = new TranscribeProbe((text, _at, kind) => {
      if (kind !== 'delta' || !p.sentence) return;
      p.sentence.text += text;
      if (!p.sentence.named && NAME_RE.test(p.sentence.text)) { p.sentence.named = true; trigger(p, p.sentence.startMs); }
    });
    p.tx = tx; txStartWall = txStartWall || now();
    await tx.start({ delay: 'minimal', keywords: ['Milo'], languages: ['en'] });
    p.txReady = true;
  }

  function trigger(p: Person, sentenceStartMs: number): void {
    ev?.trigger(p.id, nowMs);
    const free = state === 'idle' || (state === 'follow-up' && owner !== p.id);
    if (!free) return;
    state = 'routing'; owner = p.id; stateSince = nowMs; relaying = true; bargeRun = 0;
    // the withheld start of the sentence, at most the provider's burst limit
    backlog = p.ring.filter((f) => f.atMs > sentenceStartMs).slice(-PREROLL_FRAMES).map((f) => f.pcm);
    // the live frame of this very tick goes with the burst
  }

  function frame(speaker: string, pcm: Buffer, atMs: number): void {
    const p = people.get(speaker); if (!p) return;
    p.last = pcm; p.ring.push({ pcm, atMs }); if (p.ring.length > RING_FRAMES) p.ring.shift();
    const voiced = rms(pcm) > 300;
    if (voiced) {
      if (!p.sentence || p.quietMs >= 800) p.sentence = { text: '', startMs: atMs - HANDSFREE_FRAME_MS - 200, named: false };
      p.voicedRun += 1; p.quietMs = 0;
    } else { p.voicedRun = 0; p.quietMs += HANDSFREE_FRAME_MS; }
    p.tx?.append(pcm);
    if (p.vad.push(pcm)) p.tx?.commit();
    if (state === 'answering' && relaying && speaker !== 'room' && voiced) { bargeRun += 1; } else if (state === 'answering' && speaker !== 'room' && !voiced) bargeRun = Math.max(0, bargeRun - 1);
  }

  function tick(atMs: number): void {
    nowMs = atMs; offset = now() - atMs;
    // barge-in by energy: anyone's voice over Milo for 300 ms drops the relay (the session talks on, unheard)
    if (state === 'answering' && relaying && bargeRun >= BARGE_FRAMES) { relaying = false; state = 'idle'; owner = null; backlog = []; }
    if (state === 'answering' && nowMs - lastModelVoice > ANSWER_GAP_MS) { state = 'follow-up'; stateSince = nowMs; }
    if (state === 'follow-up' && nowMs - stateSince > FOLLOW_UP_MS) { state = 'idle'; owner = null; }
    if (state === 'routing' && nowMs - stateSince > GIVE_UP_MS) { state = 'idle'; owner = null; backlog = []; }
    // the session's frame for this tick
    const routedFrame = owner && state !== 'idle' ? people.get(owner)?.last ?? null : null;
    if (routedFrame) {
      if (backlog.length > 0) {
        for (const f of backlog) { send(f); ev?.routed(owner!, atMs); lead += HANDSFREE_FRAME_MS; }
        backlog = [];
      }
      send(routedFrame); ev?.routed(owner!, atMs);
    } else if (lead >= HANDSFREE_FRAME_MS) lead -= HANDSFREE_FRAME_MS; // repay the burst's lead by skipping an idle frame
    else send(silence);
    // loopback: Milo's last frame, one tick late, as a room mic hears it
    if (loop && held) { const room = people.get('room'); if (room) frame('room', held, atMs); held = null; } else if (loop) { const room = people.get('room'); if (room) frame('room', silence, atMs); }
  }

  const port: GatePort = {
    async open(input: PortOpen, events: PortEvents): Promise<void> {
      ev = events; loadKey(opts.envFile);
      for (const s of input.speakers) people.set(s, mkPerson(s));
      live = new LiveProbe({
        onVoice: (wall) => {
          lastModelVoice = nowMs;
          if (state === 'routing' || state === 'follow-up') { state = 'answering'; stateSince = nowMs; }
          if (relaying) ev?.voice(toSession(wall), 'model');
        },
        onFrame: (pcm) => { if (loop) held = pcm.length === HANDSFREE_FRAME_BYTES ? pcm : held; },
        onOutputText: (d) => { if (relaying) ev?.text(d, nowMs); },
        onOther: (e) => {
          const inner = (e['event'] ?? e) as Record<string, unknown>;
          const item = (inner['item'] ?? null) as Record<string, unknown> | null;
          if (inner['type'] === 'response.output_item.done' && item?.['type'] === 'function_call') {
            const callId = String(item['call_id'] ?? ''); const name = String(item['name'] ?? '');
            ev?.tool(name, owner, nowMs);
            live?.send({ type: 'response.item.create', event_id: `g_out_${callId}`, item: { type: 'function_call_output', call_id: callId, output: JSON.stringify({ ok: true }) } });
            live?.send({ type: 'response.create', event_id: `g_resp_${callId}` });
          }
        },
      });
      await live.start({ instructions: `${MILO_INSTRUCTIONS} When asked to add a note, call add_note, then confirm in a few words.`, voice: opts.voice ?? 'marin', tools: [NOTE_TOOL], delegation: true });
      startedWall = now();
      await Promise.all([...people.values()].map(startTx));
    },
    frame,
    tick,
    loopback(on: boolean): void {
      loop = on;
      if (on && !people.has('room')) { const r = mkPerson('room'); people.set('room', r); void startTx(r).catch((e: Error) => errors.push(`room transcription: ${e.message}`)); }
    },
    async close() {
      const wallMs = now() - startedWall;
      await live?.close();
      for (const p of people.values()) p.tx?.close();
      const txSeconds = txStartWall ? ((now() - txStartWall) / 1000) * people.size : 0;
      errors.push(...(live?.errors.map((e) => `${e.code}${e.param ? `(${e.param})` : ''}: ${e.message ?? ''}`.slice(0, 300)) ?? []));
      return { billedLiveSeconds: Math.max(live?.usageSeconds ?? 0, Math.ceil(wallMs / 1000), 15), txSeconds: Math.round(txSeconds), errors };
    },
  };
  void HANDSFREE_FRAME_BYTES;
  return port;
}
