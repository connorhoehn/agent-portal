// The real-runtime driver: the gate fed through lane B's `startHandsfreeRun` (handsfree/runtime.ts): the router, lane A's listening
// side over the provider's transcription stream, lane C's rules and the live session with delegation, with a fake relay sink that
// plays Milo's voice out one tick at a time (so a dropped relay is silent from the next tick, as it is in a call). The player's
// frames go to `run.sink.placed`, its tick is the run's clock; loopback feeds the played voice back as a room mic, memory only.
import type { GatePort, PortEvents, PortOpen } from './gate-player.mjs';
import { appendFileSync } from 'node:fs';
import { loadKey, rms } from './lib.mjs';
import { HANDSFREE_FRAME_BYTES } from './gate-clock.mjs';

export class RuntimeNotAvailable extends Error {}

type Run = {
  sink: { placed(userId: string, pcm: Buffer, atMs: number): void }; tick(atMs: number): void; close(): Promise<void>;
  on(type: 'state', fn: (st: { phase: string; userId?: string }) => void): () => void;
  holdPress?(userId: string): Promise<unknown>; holdRelease?(userId: string): void;
};
type MixerLike = { push(userId: string, pcm16k: Buffer, arrivalMs?: number): unknown; tick(): number; close(): void };

export async function runtimePort(opts: { envFile: string }): Promise<GatePort> {
  let mod: Record<string, unknown> | null = null;
  try { mod = (await import('../../middleware/src/lib/meeting-assistant/handsfree/runtime.js' as string)) as Record<string, unknown>; } catch { mod = null; }
  const start = mod?.['startHandsfreeRun'] as ((input: Record<string, unknown>) => Promise<Run>) | undefined;
  if (!start) throw new RuntimeNotAvailable('the hands-free runtime (handsfree/runtime.ts startHandsfreeRun) is not merged yet');
  // Seams the runtime declares it has (scenarios that need one are skipped without it): `HANDSFREE_GATE_SEAMS` exported by runtime.ts.
  const seams = Array.isArray(mod?.['HANDSFREE_GATE_SEAMS']) ? (mod!['HANDSFREE_GATE_SEAMS'] as string[]) : [];
  let mixer: MixerLike | null = null; const down = new Map<string, { process(i: Int16Array): Int16Array }>();
  let run: Run | null = null; let loop = false; let echo: Buffer | null = null; let nowMs = 0;
  const startedWall = Date.now();
  const silence = Buffer.alloc(HANDSFREE_FRAME_BYTES);
  return {
    seams,
    hold(speaker: string, on: boolean) { if (on) void run?.holdPress?.(speaker).catch(() => undefined); else run?.holdRelease?.(speaker); },
    async open(input: PortOpen, ev: PortEvents) {
      loadKey(opts.envFile);
      if (input.viaMixer) {
        // The production path (orchestrator): each person's 16 kHz chunks go through the call mixer, which resamples to 24 kHz, places
        // them on one timeline (playout delay) and reports each placed piece; those pieces are what the listening side is fed.
        const { CallMixer, LinearResampler } = (await import('../../middleware/src/lib/meeting-assistant/mixer.js' as string)) as {
          CallMixer: new (o: Record<string, unknown>) => MixerLike; LinearResampler: new (i: number, o: number) => { process(i: Int16Array): Int16Array };
        };
        mixer = new CallMixer({ clock: () => nowMs, onFrame: () => undefined, onPlaced: (u: string, pcm: Buffer, at: number) => run?.sink.placed(u, pcm, at) });
        for (const sp of input.speakers) down.set(sp, new LinearResampler(24_000, 16_000));
      }
      run = await start({
        family: input.family ?? 'gate',
        callId: `gate-${input.scenario}`, speakers: input.speakers.map((s) => ({ userId: s, name: s })), candidateMayAsk: input.candidateMayAsk, instructions: input.instructions,
        // Milo's voice as it plays: voiced frames are the gate's `voice`; with loopback on, a room mic hears it one tick late.
        relay: (pcm: Buffer, atMs: number, kind: 'model' | 'fixed') => { if (rms(pcm) > 300) ev.voice(atMs, kind); if (loop) echo = pcm; },
        onTool: (name: string, askedBy: string | null, atMs: number) => ev.tool(name, askedBy, atMs),
        onRouted: (userId: string, atMs: number, mixed: boolean) => ev.routed(userId, atMs, mixed),
        onText: (text: string, atMs: number) => ev.text(text, atMs),
        trace: (event: string, data: Record<string, unknown>) => {
          if (event === 'l.sentence' && typeof data['userId'] === 'string') ev.sentence?.(data['userId'], Number(data['atMs']));
          if (event === 'drop' && typeof data['reason'] === 'string') ev.drop?.(data['reason'], Number(data['atMs']));
          if (process.env['HF_GATE_TRACE']) appendFileSync(process.env['HF_GATE_TRACE'], `${JSON.stringify({ event, ...data, wall: Date.now() })}\n`);
        },
      });
      run.on('state', (st) => { if (st.phase === 'routing' && st.userId) ev.trigger(st.userId, nowMs); });
    },
    frame(speaker, pcm, atMs) {
      const d = down.get(speaker);
      if (!mixer || !d) { run?.sink.placed(speaker, pcm, atMs); return; }
      // 24 kHz frame -> 16 kHz -> five 20 ms chunks arriving across the 100 ms the frame covers.
      const i16 = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2); const out = d.process(Int16Array.from(i16)); const per = Math.ceil(out.length / 5);
      for (let c = 0; c < 5; c += 1) {
        const part = out.subarray(c * per, Math.min(out.length, (c + 1) * per)); if (!part.length) continue;
        nowMs = atMs - 100 + (c + 1) * 20; mixer.push(speaker, Buffer.from(part.buffer, part.byteOffset, part.byteLength), nowMs);
      }
      nowMs = atMs;
    },
    tick(atMs) {
      nowMs = atMs;
      if (loop) { const e = echo && echo.length === HANDSFREE_FRAME_BYTES ? echo : silence; echo = null; run?.sink.placed('room', e, atMs); }
      mixer?.tick();
      run?.tick(atMs);
    },
    loopback(on: boolean) { loop = on; },
    async close() { mixer?.close(); await run?.close(); return { billedLiveSeconds: Math.max(15, Math.ceil((Date.now() - startedWall) / 1000)), txSeconds: 0, errors: [] }; },
  };
}
