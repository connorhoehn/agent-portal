// Milo's voice in the browser: a thin WebAudio player over lib/assistantVoiceModel.ts.
// Frames come from the call-chat socket the page already has (`assistant-audio`); each is decoded and scheduled
// on one AudioContext. The audio is only played: never recorded, stored, logged or re-sent. The only thing kept
// across visits is the person's mute choice, per call: muting Milo in one call does not carry into the next. Where no AudioContext can be made, frames are still counted as
// "would schedule" on a plain clock so the mark and the walk behave the same.

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useGatewayFrames } from './gatewayFrames';
import type { AssistantView } from './meetingAssistantModel';
import { EARLY_BUFFER_TTL_MS, keepEarly, muteKey, parseAudioFrame, pcm16ToFloat32, readMutedFrom, runChanged, scheduleFrame, shouldPlay, speakingHoldMs, type AudioFrame, type EarlyBuffer } from './assistantVoiceModel';
import { refreshAssistant } from './meetingAssistant';


export interface AssistantVoiceSnapshot {
  muted: boolean;
  /** Milo is audible now: back to false SPEAKING_HOLD_MS after the scheduled playout of the last frame ends. */
  speaking: boolean;
  /** The browser has not allowed sound yet (no click on the page): known as soon as the voice is on, before any frame. */
  needsGesture: boolean;
  framesPlayed: number;
  framesIgnored: number;
  lastSeq: number;
}

interface Clock { currentTime: number; state?: string }

const readMuted = (callId: string): boolean => { try { return readMutedFrom(localStorage, callId); } catch { return false; } };

class AssistantVoicePlayer {
  private ctx: AudioContext | null = null;
  private clock: Clock = { get currentTime() { return performance.now() / 1000; } };
  private nextStart = 0;
  private runId = '';
  private utterance = false;
  private sources = new Set<AudioBufferSourceNode>();
  private hold: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private callId = '';
  private snap: AssistantVoiceSnapshot = { muted: false, speaking: false, needsGesture: false, framesPlayed: 0, framesIgnored: 0, lastSeq: 0 };

  subscribe = (l: () => void) => { this.listeners.add(l); return () => { this.listeners.delete(l); }; };
  getSnapshot = () => this.snap;
  private set(patch: Partial<AssistantVoiceSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }

  setMuted(muted: boolean) {
    try { if (this.callId) localStorage.setItem(muteKey(this.callId), muted ? '1' : '0'); } catch { /* private window: the choice lasts this visit only */ }
    if (muted) this.stop();
    this.set({ muted });
  }

  /** The browser only lets sound start after a click; this is that click. */
  async resume() {
    try { await this.ctx?.resume(); } catch { /* still suspended */ }
    this.noteState();
  }

  private gestureWatch: (() => void) | null = null;
  private noteState() {
    const suspended = this.ctx?.state === 'suspended';
    if (!suspended && this.gestureWatch) { this.gestureWatch(); this.gestureWatch = null; }
    if (suspended !== this.snap.needsGesture) this.set({ needsGesture: suspended });
  }

  /**
   * The voice is on for this person: make the audio context now, before any reply, so a browser that holds sound until a click is
   * known at once (`needsGesture`) and the first reply is not dropped. Any click or key on the page then lets sound start.
   */
  prime() {
    this.context();
    const ctx = this.ctx;
    if (!ctx) return;
    ctx.onstatechange = () => this.noteState();
    if (ctx.state === 'suspended' && !this.gestureWatch && typeof document !== 'undefined') {
      const onGesture = () => { void this.resume(); };
      document.addEventListener('pointerdown', onGesture, true); document.addEventListener('keydown', onGesture, true);
      this.gestureWatch = () => { document.removeEventListener('pointerdown', onGesture, true); document.removeEventListener('keydown', onGesture, true); };
    }
    this.noteState();
  }

  ignored() { this.set({ framesIgnored: this.snap.framesIgnored + 1 }); }

  private context(): Clock {
    if (!this.ctx && typeof AudioContext !== 'undefined') {
      try { this.ctx = new AudioContext({ sampleRate: 24000 }); } catch { try { this.ctx = new AudioContext(); } catch { this.ctx = null; } }
    }
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume().catch(() => undefined);
    return this.ctx ?? this.clock;
  }

  play(frame: AudioFrame) {
    const samples = pcm16ToFloat32(frame.pcm);
    const clock = this.context();
    const seconds = samples.length / frame.sampleRate;
    const d = scheduleFrame({ currentTime: clock.currentTime, nextStartTime: this.nextStart, frameSeconds: seconds, utteranceStarted: this.utterance, running: this.ctx ? this.ctx.state === 'running' : true });
    if (!d.play) { this.utterance = false; this.set({ framesIgnored: this.snap.framesIgnored + 1, lastSeq: frame.seq, needsGesture: this.ctx?.state === 'suspended' }); return; }
    this.utterance = !frame.last;
    this.nextStart = d.nextStartTime;
    if (this.ctx && samples.length > 0) {
      const buffer = this.ctx.createBuffer(1, samples.length, frame.sampleRate);
      buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
      const src = this.ctx.createBufferSource();
      src.buffer = buffer; src.connect(this.ctx.destination);
      src.onended = () => { this.sources.delete(src); };
      this.sources.add(src);
      src.start(d.startAt);
    }
    if (this.hold) clearTimeout(this.hold);
    // The mark stays on until what is scheduled has played: a released hold arrives as one burst and plays out after it (in-call 8).
    this.hold = setTimeout(() => { this.hold = null; this.set({ speaking: false }); }, speakingHoldMs(clock.currentTime, this.nextStart));
    this.set({ speaking: true, framesPlayed: this.snap.framesPlayed + 1, lastSeq: frame.seq, needsGesture: this.ctx?.state === 'suspended' });
  }

  /** At once: cancel what is scheduled, forget the utterance. */
  stop() {
    for (const s of this.sources) { try { s.onended = null; s.stop(); } catch { /* already ended */ } }
    this.sources.clear();
    this.utterance = false; this.nextStart = 0;
    if (this.hold) { clearTimeout(this.hold); this.hold = null; }
    // `needsGesture` is the browser's state, not the playback's: it stays (the prompt itself hides when the voice is off or muted).
    if (this.snap.speaking) this.set({ speaking: false });
  }

  runIdNow(): string { return this.runId; }

  /** The server started a new run (a restart): its `seq` begins again at 1, so the last sequence seen is forgotten. */
  noteRun(frame: AudioFrame) {
    if (!runChanged(this.runId, frame)) return;
    const first = this.runId === '';
    this.runId = frame.runId;
    if (!first) { this.stop(); this.set({ lastSeq: 0 }); }
  }

  /** A new call starts counting from nothing; the server's `seq` is per call. */
  resetCall(callId: string) { this.callId = callId; this.runId = ''; this.stop(); this.set({ muted: readMuted(callId), framesPlayed: 0, framesIgnored: 0, lastSeq: 0 }); }
}

const player = new AssistantVoicePlayer();

/**
 * Plays Milo's voice for one call while the state says it should. Every hook runs before any return.
 * Returns the player's snapshot and the controls the Milo mark's menu uses.
 */
export function useAssistantVoice(callId: string | null, view: AssistantView) {
  const { gateway } = useGatewayFrames();
  const snap = useSyncExternalStore(player.subscribe, player.getSnapshot, player.getSnapshot);
  const live = useRef({ callId, voice: view.voice, listening: view.phase === 'listening' || view.phase === 'invited', muted: snap.muted });
  live.current = { callId, voice: view.voice, listening: view.phase === 'listening' || view.phase === 'invited', muted: snap.muted };
  const shouldSound = !!callId && view.voice && live.current.listening && !snap.muted;

  // Frames that came while this browser still believed the voice was off (its poll had not caught up with someone turning it on or
  // resuming Milo): at most a second of them, played once the state read says the voice is on, never while muted (in-call 7).
  const early = useRef<EarlyBuffer | null>(null);
  const refreshing = useRef(false);
  const gate = (frame: AudioFrame) => {
    const cur = live.current;
    return shouldPlay({ callId: cur.callId ?? '', frameCallId: frame.callId, seq: frame.seq, lastSeq: player.getSnapshot().lastSeq, muted: cur.muted, voice: cur.voice, listening: cur.listening });
  };
  const flushEarly = () => {
    const buf = early.current;
    if (!buf) return;
    early.current = null;
    const fresh = Date.now() - buf.startedAt <= EARLY_BUFFER_TTL_MS;
    for (const f of buf.frames) { if (fresh && gate(f)) player.play(f); else if (f.seq > player.getSnapshot().lastSeq) player.ignored(); }
  };
  const flushRef = useRef(flushEarly);
  flushRef.current = flushEarly;

  useEffect(() => {
    if (!callId) return undefined;
    player.resetCall(callId);
    early.current = null;
    return gateway.onMessage((raw) => {
      const frame = parseAudioFrame(raw);
      if (!frame) return;
      const cur = live.current;
      if (frame.callId !== cur.callId) return;
      if (runChanged(player.runIdNow(), frame)) early.current = null;
      player.noteRun(frame);
      const lastSeq = player.getSnapshot().lastSeq;
      if (gate(frame)) { flushRef.current(); player.play(frame); return; }
      if (frame.seq <= lastSeq) return;
      // The server relays only while the voice is on and Milo listens: a frame here means this browser's view is behind. Keep it
      // and read the state now instead of at the next poll.
      const kept = !cur.voice || !cur.listening ? keepEarly(early.current, frame, { muted: cur.muted, lastSeq, now: Date.now() }) : null;
      if (!kept) { player.ignored(); return; }
      early.current = kept;
      if (!refreshing.current && cur.callId) { refreshing.current = true; void refreshAssistant(cur.callId).catch(() => undefined).finally(() => { refreshing.current = false; }); }
    });
  }, [callId, gateway.onMessage]);
  // The state read said the voice is on: play what was kept, in order. Muted: drop it.
  useEffect(() => { if (shouldSound) flushRef.current(); else if (snap.muted && early.current) { early.current = null; } }, [shouldSound, snap.muted]);

  // Pause, leave, voice off, mute, call end: nothing more is played and what is scheduled is cancelled.
  useEffect(() => { if (!shouldSound) player.stop(); }, [shouldSound]);
  // Voice on and not muted: learn now whether the browser holds sound until a click, before Milo's first reply.
  const wantsSound = !!callId && view.voice && !snap.muted;
  useEffect(() => { if (wantsSound) player.prime(); }, [wantsSound, callId]);
  useEffect(() => () => player.stop(), []);

  return {
    ...snap,
    setMuted: (m: boolean) => player.setMuted(m),
    enableSound: () => player.resume(),
  };
}
