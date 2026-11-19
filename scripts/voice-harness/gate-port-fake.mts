// A scripted driver: behaves as a profile says, on the virtual clock. It proves the scenarios, the player and the scoring
// without a key (gate.test.mts), and stays the stand-in for lanes A and B until the real runtime exists. The `ideal`
// profile is the behaviour the plan asks for; each test breaks one thing and expects exactly that check to fail.
import type { GatePort, PortEvents, PortOpen } from './gate-player.mjs';
import type { StepSpec } from './gate-spec.mjs';

export interface FakeProfile {
  /** Speech end to first voiced frame for this step (ms); null = never answers. */
  latencyMs(step: StepSpec, i: number): number | null;
  /** How long Milo talks (ms). */
  talkMs: number;
  /** Frames of a silent step's person routed anyway (a mention or a colleague that leaked). */
  leakFrames(step: StepSpec): number;
  /** Who a tool call names. */
  askedBy(step: StepSpec): string | null;
  /** After a barge-in starts, the relay keeps talking this long. */
  bargeStopMs: number;
  /** Voice runs from nothing (spoke when not asked), one per silent step number listed. */
  unaskedAfter: ReadonlySet<number>;
  mixedAudio: boolean;
  echoTriggers: number;
  /** Candidate-off: audio routed and a model reply instead of the fixed line. */
  candidateLeaks: boolean;
  /** Two at once: the queued second asker is answered after the floor frees (decision 10), never, or before the first. */
  queuedSecond: 'after' | 'never' | 'first';
  /** A mention (silent step) set off a tool call. */
  toolOnMention: boolean;
  /** Speech end to the transcription final of a step (ms); the mixer path adds `mixerExtraMs` in a viaMixer scenario. */
  finalLagMs: number;
  mixerExtraMs: number;
  /** A hold's late words dropped the relay as a barge-in. */
  holdLateBargeIn: boolean;
}

export const idealProfile: FakeProfile = {
  latencyMs: (s) => (s.answer && /tokyo|madrid/.test(s.answer) ? 1200 : s.clip && /^n\d\d$|^h0[12]$/.test(s.clip) ? 2400 : s.clip && /^f\d\d$/.test(s.clip) ? 1100 : 1150),
  talkMs: 1800,
  leakFrames: () => 0,
  askedBy: (s) => s.speaker,
  bargeStopMs: 300,
  unaskedAfter: new Set(),
  mixedAudio: false,
  echoTriggers: 0,
  candidateLeaks: false,
  queuedSecond: 'after',
  toolOnMention: false,
  finalLagMs: 200,
  mixerExtraMs: 100,
  holdLateBargeIn: false,
};

export function fakePort(profile: Partial<FakeProfile> = {}): GatePort & { opened: PortOpen | null } {
  const p: FakeProfile = { ...idealProfile, ...profile };
  let ev: PortEvents | null = null; let opened: PortOpen | null = null;
  let window: { start: number; end: number; kind: 'model' | 'fixed' } | null = null;
  const pending: Array<{ at: number; run: () => void }> = [];
  let nowMs = 0; let stepNo = 0;
  /** The answer last scheduled, and when the floor it holds frees (its start + its talk). */
  let lastAnswer: { item: { at: number; run: () => void }; freeAt: number } | null = null;
  const port = {
    seams: ['interviews-family'] as readonly string[],
    hold() { /* the scripted driver has no button: holdLateBargeIn decides */ },
    get opened() { return opened; },
    async open(input: PortOpen, e: PortEvents) { opened = input; ev = e; },
    begin(i: number, step: StepSpec, clipMs: number) {
      const startMs = nowMs; const endMs = startMs + clipMs; stepNo = i;
      if (step.clip && step.expect !== 'silent') pending.push({ at: endMs + p.finalLagMs + (opened?.viaMixer ? p.mixerExtraMs : 0), run: () => ev?.sentence?.(step.speaker, nowMs) });
      if (step.hold && p.holdLateBargeIn) pending.push({ at: endMs + 1000, run: () => ev?.drop?.('barge-in', nowMs) });
      if (step.overMiloAfterMs !== undefined && window && window.end > nowMs) {
        window.end = Math.min(window.end, nowMs + p.bargeStopMs); // the relay drops after the configured delay
        return;
      }
      if (step.expect === 'silent') {
        const leak = p.leakFrames(step);
        for (let n = 0; n < leak; n += 1) pending.push({ at: startMs + n * 100, run: () => ev?.routed(step.speaker, nowMs) });
        if (p.toolOnMention && /^m\d\d$/.test(step.clip ?? '')) pending.push({ at: endMs + 600, run: () => ev?.tool('add_note', step.speaker, nowMs) });
        if (p.unaskedAfter.has(i)) pending.push({ at: endMs + 600, run: () => { window = { start: nowMs, end: nowMs + 1200, kind: 'model' }; } });
        if (step.loopback === undefined && p.echoTriggers > 0 && i > 0) for (let n = 0; n < p.echoTriggers; n += 1) pending.push({ at: startMs + 500, run: () => ev?.trigger('room', nowMs) });
        return;
      }
      if (step.loopback && p.echoTriggers > 0) for (let n = 0; n < p.echoTriggers; n += 1) pending.push({ at: endMs + 1500, run: () => ev?.trigger('room', nowMs) });
      const kind: 'model' | 'fixed' = step.expect === 'fixed' && !p.candidateLeaks ? 'fixed' : 'model';
      if (step.expect === 'fixed' && p.candidateLeaks) for (let n = 0; n < 5; n += 1) pending.push({ at: startMs + n * 100, run: () => ev?.routed(step.speaker, nowMs) });
      const latency = p.latencyMs(step, i);
      if (latency === null) return;
      let at = endMs + latency;
      // A second asker while the floor is held: queued, answered once the floor frees (or as the profile breaks it).
      const queued = step.concurrentMs !== undefined && lastAnswer !== null;
      if (queued && p.queuedSecond === 'never') return;
      if (queued && p.queuedSecond === 'after') at = Math.max(at, lastAnswer!.freeAt + latency);
      if (queued && p.queuedSecond === 'first') { at = endMs + 300; lastAnswer!.item.at = at + p.talkMs + latency; }
      const talk = step.clip && /^g0[12]$/.test(step.clip) ? 8000 : p.talkMs;
      const item = { at, run: () => { window = { start: nowMs, end: nowMs + talk, kind }; if (step.answer) ev?.text(step.answer.split('|')[0]!, nowMs); else ev?.text('Sure.', nowMs); } };
      pending.push(item);
      lastAnswer = { item, freeAt: at + talk };
      if (step.expect === 'tool') pending.push({ at: endMs + 600, run: () => ev?.tool('add_note', p.askedBy(step), nowMs) });
      if (p.mixedAudio && step.concurrentMs === undefined) pending.push({ at: startMs + 200, run: () => ev?.routed(step.speaker, nowMs, true) });
    },
    frame() { /* the scripted driver does not listen */ },
    tick(t: number) {
      nowMs = t;
      for (let n = pending.length - 1; n >= 0; n -= 1) if (pending[n]!.at <= t) { const x = pending.splice(n, 1)[0]!; x.run(); }
      if (window && t >= window.start && t < window.end) ev?.voice(t, window.kind);
      void stepNo;
    },
    loopback() { /* nothing: the profile decides */ },
    async close() { return { billedLiveSeconds: 0, txSeconds: 0, errors: [] as string[] }; },
  };
  return port;
}
