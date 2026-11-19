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
};

export async function runtimePort(opts: { envFile: string }): Promise<GatePort> {
  let mod: Record<string, unknown> | null = null;
  try { mod = (await import('../../middleware/src/lib/meeting-assistant/handsfree/runtime.js' as string)) as Record<string, unknown>; } catch { mod = null; }
  const start = mod?.['startHandsfreeRun'] as ((input: Record<string, unknown>) => Promise<Run>) | undefined;
  if (!start) throw new RuntimeNotAvailable('the hands-free runtime (handsfree/runtime.ts startHandsfreeRun) is not merged yet');
  let run: Run | null = null; let loop = false; let echo: Buffer | null = null; let nowMs = 0;
  const startedWall = Date.now();
  const silence = Buffer.alloc(HANDSFREE_FRAME_BYTES);
  return {
    async open(input: PortOpen, ev: PortEvents) {
      loadKey(opts.envFile);
      run = await start({
        callId: `gate-${input.scenario}`, speakers: input.speakers.map((s) => ({ userId: s, name: s })), candidateMayAsk: input.candidateMayAsk, instructions: input.instructions,
        // Milo's voice as it plays: voiced frames are the gate's `voice`; with loopback on, a room mic hears it one tick late.
        relay: (pcm: Buffer, atMs: number, kind: 'model' | 'fixed') => { if (rms(pcm) > 300) ev.voice(atMs, kind); if (loop) echo = pcm; },
        onTool: (name: string, askedBy: string | null, atMs: number) => ev.tool(name, askedBy, atMs),
        onRouted: (userId: string, atMs: number, mixed: boolean) => ev.routed(userId, atMs, mixed),
        ...(process.env['HF_GATE_TRACE'] ? { trace: (event: string, data: Record<string, unknown>) => appendFileSync(process.env['HF_GATE_TRACE']!, `${JSON.stringify({ event, ...data })}\n`) } : {}),
      });
      run.on('state', (st) => { if (st.phase === 'routing' && st.userId) ev.trigger(st.userId, nowMs); });
    },
    frame(speaker, pcm, atMs) { run?.sink.placed(speaker, pcm, atMs); },
    tick(atMs) {
      nowMs = atMs;
      if (loop) { const e = echo && echo.length === HANDSFREE_FRAME_BYTES ? echo : silence; echo = null; run?.sink.placed('room', e, atMs); }
      run?.tick(atMs);
    },
    loopback(on: boolean) { loop = on; },
    async close() { await run?.close(); return { billedLiveSeconds: Math.max(15, Math.ceil((Date.now() - startedWall) / 1000)), txSeconds: 0, errors: [] }; },
  };
}
