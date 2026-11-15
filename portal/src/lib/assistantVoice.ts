// Milo's voice in the browser: a thin WebAudio player over lib/assistantVoiceModel.ts.
// Frames come from the call-chat socket the page already has (`assistant-audio`); each is decoded and scheduled
// on one AudioContext. The audio is only played: never recorded, stored, logged or re-sent. The only thing kept
// across visits is the person's mute choice, per call: muting Milo in one call does not carry into the next. Where no AudioContext can be made, frames are still counted as
// "would schedule" on a plain clock so the mark and the walk behave the same.

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useGatewayFrames } from './gatewayFrames';
import type { AssistantView } from './meetingAssistantModel';
import { SPEAKING_HOLD_MS, muteKey, parseAudioFrame, pcm16ToFloat32, readMutedFrom, runChanged, scheduleFrame, shouldPlay, type AudioFrame } from './assistantVoiceModel';


export interface AssistantVoiceSnapshot {
  muted: boolean;
  /** Frames are arriving now (back to false SPEAKING_HOLD_MS after the last one). */
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
    this.hold = setTimeout(() => { this.hold = null; this.set({ speaking: false }); }, SPEAKING_HOLD_MS);
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

  useEffect(() => {
    if (!callId) return undefined;
    player.resetCall(callId);
    return gateway.onMessage((raw) => {
      const frame = parseAudioFrame(raw);
      if (!frame) return;
      const cur = live.current;
      if (frame.callId !== cur.callId) return;
      player.noteRun(frame);
      if (shouldPlay({ callId: cur.callId ?? '', frameCallId: frame.callId, seq: frame.seq, lastSeq: player.getSnapshot().lastSeq, muted: cur.muted, voice: cur.voice, listening: cur.listening })) player.play(frame);
      else if (frame.seq > player.getSnapshot().lastSeq) player.ignored();
    });
  }, [callId, gateway.onMessage]);

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
