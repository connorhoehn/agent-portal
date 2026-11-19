// Plays one gate scenario against a driver (a "port") on one clock and turns what the port reports into observations.
// Every person is a stream of 100 ms frames (frame k carries the audio of the 100 ms before it is sent, as a mic does);
// silence when they are not speaking, so a driver sees what a real room gives it. Nothing here keeps audio.
import { HANDSFREE_FRAME_BYTES, HANDSFREE_FRAME_MS, type Clock } from './gate-clock.mjs';
import type { RunObs, ScenarioSpec, StepObs, StepSpec } from './gate-spec.mjs';

export interface PortEvents {
  /** A voiced frame of Milo's voice reached the relay (kind: the model's own voice, or the server's fixed line). */
  voice(atMs: number, kind: 'model' | 'fixed'): void;
  /** A frame of this person's audio was handed to the talking side; `mixed` = it carried more than one person. */
  routed(speaker: string, atMs: number, mixed?: boolean): void;
  tool(name: string, askedBy: string | null, atMs: number): void;
  text(delta: string, atMs: number): void;
  /** The listening side decided someone addressed Milo (a name or hold trigger). */
  trigger(speaker: string, atMs: number): void;
  /** A finished sentence (a transcription final) of this person reached the listening side. */
  sentence?(speaker: string, atMs: number): void;
  /** The router dropped the relay of the current turn (`barge-in`, `stop`, `fixed`, ...). */
  drop?(reason: string, atMs: number): void;
}

export interface PortOpen { scenario: string; speakers: string[]; instructions: string; candidateMayAsk: boolean; family?: 'gate' | 'interviews'; viaMixer?: boolean }

export interface GatePort {
  /** The runtime seams this driver has (SEAMS in gate-spec.mts); a scenario that needs one this lacks is skipped. Absent = none. */
  seams?: readonly string[];
  /** The speaker presses (true) or releases (false) the hold button. */
  hold?(speaker: string, on: boolean): void;
  open(input: PortOpen, ev: PortEvents): Promise<void>;
  /** A step starts (a scripted fake uses it to know what is being said; a real driver ignores it). */
  begin?(i: number, step: StepSpec, clipMs: number): void;
  /** Called every tick, once per person, in order: that person's last 100 ms. `atMs` is the frame's end on the session clock. */
  frame(speaker: string, pcm24k: Buffer, atMs: number): void;
  /** After all of a tick's frames. */
  tick(atMs: number): void;
  /** From now on Milo's own output is played back into a room mic (memory only). */
  loopback(on: boolean): void;
  close(): Promise<{ billedLiveSeconds: number; txSeconds: number; errors: string[] }>;
}

const RUN_GAP_MS = 1500; // voiced frames closer than this are one run of voice
const TOOL_GAP_MS = 4000; // a delegated tool answer can follow the first words by seconds
const REPLY_WAIT_MS = 10_000;
const ROUTE_WINDOW_MS = 6000;

interface Rec extends StepObs {
  spec: StepSpec;
  released?: boolean;
  started: boolean; clipStartMs: number; done: boolean; doneAt: number; pos: number; pcm: Buffer | null; clipMs: number;
}

export interface PlayOptions { clips: Record<string, Buffer>; clock: Clock; maxMs?: number; instructions: string; log?: (s: string) => void }

export async function playScenario(sc: ScenarioSpec, port: GatePort, opts: PlayOptions): Promise<RunObs> {
  const { clock } = opts; const maxMs = opts.maxMs ?? 240_000;
  const recs: Rec[] = sc.steps.map((spec, i) => ({
    spec, i, clip: spec.clip, speaker: spec.speaker, expect: spec.expect, ...(spec.barge ? { barge: spec.barge } : {}),
    speechEndMs: null, firstVoiceMs: null, lastVoiceMs: null, fixedVoice: false, relayedFrames: 0, strayRuns: 0, routed: {}, mixed: false, text: '', toolCalls: [],
    relaySilentMs: null, triggers: 0, noReply: false, finalMs: null, drops: [],
    started: false, clipStartMs: 0, done: false, doneAt: 0, pos: 0, pcm: spec.clip ? opts.clips[spec.clip]! : null,
    clipMs: spec.clip ? ((opts.clips[spec.clip]!.length / HANDSFREE_FRAME_BYTES) * HANDSFREE_FRAME_MS) : 0,
  }));
  const errors: string[] = [];
  let lastVoiceAny = -1e9; let runOwner: Rec | null = null; let nowMs = 0;
  const latestStarted = (): Rec | null => recs.findLast((r) => r.started) ?? null;
  const awaiting = (): Rec | undefined => recs.find((r) => r.spec.expect !== 'silent' && r.started && r.speechEndMs !== null && r.firstVoiceMs === null && !r.done);

  const ev: PortEvents = {
    voice: (at, kind) => {
      const cont = at - lastVoiceAny < (runOwner?.spec.expect === 'tool' ? TOOL_GAP_MS : RUN_GAP_MS) && runOwner !== null;
      lastVoiceAny = at;
      if (cont && runOwner) { runOwner.lastVoiceMs = at; runOwner.relayedFrames += 1; if (kind === 'fixed') runOwner.fixedVoice = true; return; }
      const a = awaiting();
      if (a) { a.firstVoiceMs = at; a.lastVoiceMs = at; a.relayedFrames += 1; if (kind === 'fixed') a.fixedVoice = true; runOwner = a; return; }
      const last = latestStarted(); runOwner = last;
      if (last) { last.strayRuns += 1; last.lastVoiceMs = at; last.relayedFrames += 1; if (kind === 'fixed') last.fixedVoice = true; }
    },
    routed: (speaker, at, mixed) => {
      const r = recs.findLast((x) => x.started && x.speaker === speaker && x.clipStartMs <= at) ?? latestStarted();
      if (!r) return;
      r.routed[speaker] = (r.routed[speaker] ?? 0) + 1;
      if (mixed) (latestStarted() ?? r).mixed = true;
    },
    tool: (name, askedBy) => {
      const r = recs.findLast((x) => x.started && x.spec.expect === 'tool') ?? latestStarted();
      r?.toolCalls.push({ name, askedBy });
    },
    text: (delta) => {
      const r = awaiting() ?? runOwner ?? latestStarted();
      if (r) r.text += delta;
    },
    // only a trigger from a mic that is not one of the scenario's people counts: the echo room (their own names are the point)
    sentence: (speaker, at) => {
      const r = recs.findLast((x) => x.started && x.speaker === speaker && x.pcm !== null && x.clipStartMs <= at);
      if (r && (r.speechEndMs === null || at - r.speechEndMs < 6000)) r.finalMs = at;
    },
    drop: (reason) => { latestStarted()?.drops?.push(reason); },
    trigger: (speaker) => { if (sc.speakers.includes(speaker)) return; const r = latestStarted(); if (r) r.triggers += 1; },
  };

  await port.open({ scenario: sc.id, speakers: sc.speakers, instructions: opts.instructions, candidateMayAsk: sc.candidateMayAsk ?? true, family: sc.family ?? 'gate', viaMixer: sc.viaMixer ?? false }, ev);
  const silence = Buffer.alloc(HANDSFREE_FRAME_BYTES);
  const t0 = clock.now() + 50; let k = 0; let nextIdx = 0; let loop = false;
  const busy = (speaker: string): boolean => recs.some((r) => r.started && r.speaker === speaker && r.pcm !== null && r.pos < r.pcm.length);
  const allDone = (): boolean => recs.every((r) => r.done);
  const gapFrom = (): number => recs.reduce((a, r) => (r.done ? Math.max(a, r.doneAt) : a), 0);

  while (true) {
    k += 1;
    await clock.sleepUntil(t0 + k * HANDSFREE_FRAME_MS);
    nowMs = k * HANDSFREE_FRAME_MS;
    if (nowMs > maxMs) { errors.push('scenario time cap reached'); break; }
    // finish steps
    for (const r of recs) {
      if (r.done || !r.started || r.speechEndMs === null) continue;
      if (r.spec.expect === 'silent') { r.done = true; r.doneAt = r.speechEndMs; continue; }
      if (r.firstVoiceMs !== null && r.lastVoiceMs !== null && nowMs - r.lastVoiceMs > (r.spec.expect === 'tool' ? TOOL_GAP_MS : RUN_GAP_MS)) { r.done = true; r.doneAt = r.lastVoiceMs; }
      else if (r.firstVoiceMs === null && r.spec.expect === 'tool' && r.toolCalls.length > 0 && nowMs - r.speechEndMs > 4000) { r.done = true; r.doneAt = nowMs; }
      else if (r.firstVoiceMs === null && nowMs - r.speechEndMs > REPLY_WAIT_MS) { r.done = true; r.noReply = true; r.doneAt = nowMs; }
    }
    // start the next step
    if (nextIdx < recs.length) {
      const r = recs[nextIdx]!; const prev = nextIdx > 0 ? recs[nextIdx - 1]! : null; const s = r.spec;
      let go = false;
      if (s.concurrentMs !== undefined && prev) go = prev.started && nowMs >= prev.clipStartMs + s.concurrentMs;
      else if (s.overMiloAfterMs !== undefined && prev) go = prev.firstVoiceMs !== null && nowMs >= prev.firstVoiceMs + s.overMiloAfterMs;
      else go = recs.slice(0, nextIdx).every((x) => x.done) && nowMs >= gapFrom() + s.gapMs && nowMs - lastVoiceAny > 1000;
      if (s.overMiloAfterMs !== undefined && prev?.done && !go) go = nowMs >= gapFrom() + 500; // no answer to talk over: do not wait forever
      if (go && !busy(s.speaker)) {
        r.started = true; r.clipStartMs = nowMs - HANDSFREE_FRAME_MS;
        if (r.pcm === null) { r.speechEndMs = nowMs; }
        if (s.loopback && !loop) { loop = true; port.loopback(true); }
        port.begin?.(r.i, s, r.clipMs);
        if (s.hold) port.hold?.(s.speaker, true);
        nextIdx += 1;
      }
    }
    if (nextIdx >= recs.length && allDone() && nowMs - Math.max(gapFrom(), lastVoiceAny) > 2500) break;
    // one frame per person
    for (const sp of sc.speakers) {
      let f = silence;
      const r = recs.find((x) => x.started && x.speaker === sp && x.pcm !== null && x.pos < x.pcm.length);
      if (r && r.pcm) {
        f = Buffer.alloc(HANDSFREE_FRAME_BYTES);
        const end = Math.min(r.pcm.length, r.pos + HANDSFREE_FRAME_BYTES);
        r.pcm.copy(f, 0, r.pos, end); r.pos = end;
        if (end >= r.pcm.length) r.speechEndMs = r.clipStartMs + r.clipMs;
      }
      port.frame(sp, f, nowMs);
    }
    for (const r of recs) if (r.spec.hold && r.started && r.pcm !== null && r.pos >= r.pcm.length && !r.released) { r.released = true; port.hold?.(r.speaker, false); }
    port.tick(nowMs);
  }

  const closed = await port.close();
  errors.push(...closed.errors);
  // barge-in: how long the relay kept talking after the interruption started
  for (const r of recs) {
    if (!r.spec.barge) continue;
    const prev = recs[r.i - 1];
    r.relaySilentMs = prev?.lastVoiceMs != null ? Math.max(0, Math.round(prev.lastVoiceMs - r.clipStartMs)) : 0;
  }
  void ROUTE_WINDOW_MS;
  return {
    scenario: sc.id, errors, billedLiveSeconds: closed.billedLiveSeconds, txSeconds: closed.txSeconds,
    steps: recs.map(({ spec: _s, started: _a, clipStartMs: _b, done: _c, doneAt: _d, pos: _e, pcm: _f, clipMs: _g, released: _h, ...obs }) => obs),
  };
}
