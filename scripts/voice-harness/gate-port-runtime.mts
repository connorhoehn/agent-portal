// The real-runtime driver: the gate fed through `HandsfreeRun` (handsfree/types.ts) with a fake relay sink and delegation ON.
// Lanes A and B have not merged, so there is no runtime to load yet: `runtimePort()` looks for `handsfree/runtime.js` and,
// without a harness entry point, every scenario is reported as skipped (the gate then fails under --require-all, which is
// how the real-runtime run is judged).
//
// What this driver needs from lane B (a CONTRACT CHANGE REQUEST, not a types.ts edit): `handsfree/runtime.ts` exports
//   startHandsfreeRun(input: {
//     callId: string; speakers: Array<{ userId: string; name: string }>; candidateMayAsk: boolean; instructions: string;
//     relay: (pcm24k: Buffer, atMs: number, kind: 'model' | 'fixed') => void;        // the fake relay sink: Milo's voiced frames
//     onTool: (name: string, askedBy: string | null, atMs: number) => void;            // every tool call the orchestrator saw
//     onRouted: (userId: string, atMs: number, mixed: boolean) => void;               // each frame handed to TalkingSide.feed
//   }): Promise<HandsfreeRun>
// and `HandsfreeRun.on('state' | 'drop' | 'queued')` already covers the triggers. When it exists this file maps the
// player's frames to `run.sink.placed(userId, pcm, atMs)` and the port events above; nothing else changes.
import type { GatePort, PortEvents, PortOpen } from './gate-player.mjs';

export class RuntimeNotAvailable extends Error {}

export async function runtimePort(_opts: { envFile: string }): Promise<GatePort> {
  let mod: Record<string, unknown> | null = null;
  try { mod = (await import('../../middleware/src/lib/meeting-assistant/handsfree/runtime.js' as string)) as Record<string, unknown>; } catch { mod = null; }
  const start = mod?.['startHandsfreeRun'] as ((input: Record<string, unknown>) => Promise<{
    sink: { placed(userId: string, pcm: Buffer, atMs: number): void }; close(): Promise<void>;
  }>) | undefined;
  if (!start) throw new RuntimeNotAvailable('the hands-free runtime (handsfree/runtime.ts startHandsfreeRun) is not merged yet');
  let run: Awaited<ReturnType<typeof start>> | null = null;
  return {
    async open(input: PortOpen, ev: PortEvents) {
      run = await start({
        callId: `gate-${input.scenario}`, speakers: input.speakers.map((s) => ({ userId: s, name: s })), candidateMayAsk: input.candidateMayAsk, instructions: input.instructions,
        relay: (_pcm: Buffer, atMs: number, kind: 'model' | 'fixed') => ev.voice(atMs, kind),
        onTool: (name: string, askedBy: string | null, atMs: number) => ev.tool(name, askedBy, atMs),
        onRouted: (userId: string, atMs: number, mixed: boolean) => ev.routed(userId, atMs, mixed),
      });
    },
    frame(speaker, pcm, atMs) { run?.sink.placed(speaker, pcm, atMs); },
    tick() { /* the runtime's own clock */ },
    loopback() { /* the runtime driver wires Milo's relay frames back through sink.placed('room', ...) once it exists */ },
    async close() { await run?.close(); return { billedLiveSeconds: 0, txSeconds: 0, errors: [] }; },
  };
}
