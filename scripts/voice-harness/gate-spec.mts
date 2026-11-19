// The hands-free voice gate: the scenario set, the observations a driver reports, and the pass/fail scoring.
// The thresholds are the plan's "Measurement" table (HANDSFREE-BUILD-PLAN.md); nothing here talks to a provider, so the
// scoring is unit-tested without a key (gate.test.mts). Times are session ms (the mixer's timeline, handsfree/types.ts).
//
// Observations are driver-neutral: a driver (fake, direct probe-style session, or the real HandsfreeRun) is fed the same
// scenario by gate-player.mts and reports what Milo did; scoring never knows which driver ran.

/** The plan's pass thresholds. Change them only with the plan. */
export const GATE = Object.freeze({
  nameFirst: { tries: 22, p50Ms: 1300, p90Ms: 1800, maxMs: 2500 },
  nameLast: { tries: 7, p50Ms: 2700, p90Ms: 3200, understood: 7 },
  followUp: { tries: 9, replied: 9, p90Ms: 1600 },
  chatter: { runs: 3, spokeUnasked: 0 },
  mentions: { clips: 8, relayedFrames: 0, toolCalls: 0 },
  asker: { wrongAsker: 0 },
  barge: { relaySilentMs: 700 },
  colleague: { relayedFrames: 0 },
  echo: { triggers: 0 },
  // The film's gaps (HF-FILM-DIAG.md, "GATE additions"): server lines through the interviews family, barge-in over one, a hold's
  // late words, a follow-up after a fixed answer, a preface before a candidate's name-last question, the mixer path's final lag.
  serverLine: { tries: 4, p50Ms: 1300, p90Ms: 1800, serverVoice: 4 },
  fixedBarge: { relaySilentMs: 700 },
  hold: { tries: 2, bargeInDrops: 0 },
  fixedFollow: { tries: 2, answered: 2, p90Ms: 1600 },
  preface: { tries: 2, answered: 2, p90Ms: 3200 },
  finalLag: { tries: 6, p50Ms: 400, p90Ms: 700 },
});

/** Seams the real runtime must export (`HANDSFREE_GATE_SEAMS`) for a scenario that needs them to run; without them it is skipped. */
export const SEAMS = Object.freeze({ interviews: 'interviews-family' });
/** The interviews family's time line ("About 30 minutes are left in this round.") and its repeat line (the gate's one question). */
const TIME_LINE = 'left in this round|minutes long';
const REPEAT_LINE = 'second largest number';

export type Expect = 'reply' | 'silent' | 'tool' | 'fixed';

export interface StepSpec {
  speaker: string;
  /** Clip id (clips.json); null = nobody speaks, just wait `gapMs` (the room is quiet). */
  clip: string | null;
  /** Silence before the step: after the previous step finished (its reply end, or its speech end when it expects silence). */
  gapMs: number;
  /**
   * reply = Milo should answer (latency measured); silent = he must not speak and nothing of this person may be relayed;
   * tool = a tool request, the call must carry this speaker as `askedBy`; fixed = only the server's fixed line may speak.
   */
  expect: Expect;
  /** Start this long after the PREVIOUS step started (two people at once); overrides gapMs. */
  concurrentMs?: number;
  /** Start while Milo is still talking: this long after his first voiced frame of the previous step (a barge-in). */
  overMiloAfterMs?: number;
  /** Which kind of barge-in this step is (for the report). */
  barge?: 'talk-over' | 'stop';
  /** From this step on, Milo's own output is played back into a room mic (memory only, never stored). */
  loopback?: boolean;
  /** The speaker presses the hold button at the step's start and releases it at its speech end (late words follow the release). */
  hold?: boolean;
  /** The answer must match this (case-insensitive regex source) to count as understood. */
  answer?: string;
}

export interface ScenarioSpec {
  id: string;
  about: string;
  /** People who speak (each gets a transcription stream and a mic stream). */
  speakers: string[];
  steps: StepSpec[];
  /** Runtime-only behaviours a direct session cannot show (the direct driver reports these as skipped). */
  runtimeOnly?: boolean;
  /** Settings the scenario needs from the run. */
  candidateMayAsk?: boolean;
  /** The run's family: `interviews` = the interviews policy's family and the orchestrator's server-line path (a seam), default the gate's own. */
  family?: 'gate' | 'interviews';
  /** A seam the runtime must export (SEAMS); without it the scenario is skipped, not failed. */
  needsSeam?: string;
  /** Audio reaches the listening side through the production mixer path (24 kHz -> 16 kHz chunks -> CallMixer -> placed pieces). */
  viaMixer?: boolean;
}

const pad = (n: number): string => String(n).padStart(2, '0');
const rep = <T,>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));

export function gateScenarios(): ScenarioSpec[] {
  // two voices: hugo (q01-q11) and the candidate (qc01-qc11), interleaved
  const first: StepSpec[] = rep(GATE.nameFirst.tries, (i) => {
    const hugo = i % 2 === 0; const k = Math.floor(i / 2) + 1;
    return { speaker: hugo ? 'hugo' : 'cand', clip: hugo ? `q${pad(k)}` : `qc${pad(k)}`, gapMs: 1200, expect: 'reply' as const };
  });
  const last: StepSpec[] = [
    ['hugo', 'n01', 'test cases|dozen|twelve|add'], ['hugo', 'n02', 'tokyo'], ['cand', 'n03', 'linked|node|pointer|list'], ['hugo', 'n04', '52|fifty'],
    ['cand', 'n05', 'log'], ['hugo', 'h01', 'gmt|utc|greenwich|london|zone'], ['hugo', 'h02', '11|eleven'],
  ].map(([speaker, clip, answer]) => ({ speaker: speaker!, clip: clip!, gapMs: 1500, expect: 'reply' as const, answer }));
  const follow: StepSpec[] = [];
  for (const [q, fs] of [['q01', ['f01', 'f02', 'f05']], ['q02', ['f03']], ['q09', ['f04']], ['q15', ['f06']], ['q06', ['f07']], ['q13', ['f09']]] as const) {
    follow.push({ speaker: 'hugo', clip: q, gapMs: 1500, expect: 'reply' });
    for (const f of fs) follow.push({ speaker: 'hugo', clip: f, gapMs: 3000, expect: 'reply' });
  }
  // 3 + 1 + 1 + 1 + 1 + 1 = 8 follow-ups above, the ninth here
  follow.push({ speaker: 'hugo', clip: 'f08', gapMs: 3000, expect: 'reply' });
  const chatterOnce: StepSpec[] = [
    { speaker: 'cand', clip: 'c01', gapMs: 600, expect: 'silent' }, { speaker: 'cand', clip: 'c02', gapMs: 400, expect: 'silent' },
    { speaker: 'hugo', clip: 'c03', gapMs: 700, expect: 'silent' }, { speaker: 'hugo', clip: 'c04', gapMs: 500, expect: 'silent' },
    { speaker: 'cand', clip: 'c05', gapMs: 700, expect: 'silent' },
  ];
  const chatter = rep(GATE.chatter.runs, () => chatterOnce).flat();
  const mentions: StepSpec[] = ['m01', 'm02', 'm03', 'm04', 'm05', 'm06', 'm07', 'm08']
    .map((clip, i) => ({ speaker: i % 2 === 0 ? 'hugo' : 'cand', clip, gapMs: 1000, expect: 'silent' as const }));
  const tools: StepSpec[] = [['hugo', 't01'], ['cand', 't02'], ['hugo', 't03'], ['cand', 't04']].map(([speaker, clip]) => ({ speaker: speaker!, clip: clip!, gapMs: 1500, expect: 'tool' as const }));
  const ask = (speaker: string, clip: string, expect: Expect, gapMs: number, extra: Partial<StepSpec> = {}): StepSpec => ({ speaker, clip, gapMs, expect, ...extra });
  const lagSteps: StepSpec[] = ['q01', 'qc01', 'q02', 'qc02', 'q03', 'qc03'].map((clip, i) => ask(i % 2 === 0 ? 'hugo' : 'cand', clip, 'reply', 1200));
  const gate2: ScenarioSpec[] = [
    { id: 'iv-name-first', about: 'interviews family, name first, phrase-tool questions (time, repeat): answered by a server line, name-first latency', speakers: ['hugo'], family: 'interviews', needsSeam: SEAMS.interviews, runtimeOnly: true,
      steps: [ask('hugo', 'iv01', 'fixed', 1200), ask('hugo', 'iv02', 'fixed', 2500), ask('hugo', 'iv01', 'fixed', 2500), ask('hugo', 'iv02', 'fixed', 2500)] },
    { id: 'fixed-barge', about: 'barge-in over a server line ("Milo, stop" 600 ms into the candidate\'s time answer): the relay goes silent, the next ask is answered', speakers: ['hugo', 'cand'], candidateMayAsk: false, runtimeOnly: true,
      steps: [ask('cand', 'ct03', 'fixed', 800), ask('hugo', 's01', 'silent', 0, { overMiloAfterMs: 600, barge: 'stop' }), ask('cand', 'ct03', 'fixed', 2500)] },
    { id: 'iv-barge', about: 'interviews family: barge-in over a server line', speakers: ['hugo'], family: 'interviews', needsSeam: SEAMS.interviews, runtimeOnly: true,
      steps: [ask('hugo', 'iv01', 'fixed', 800), ask('hugo', 's01', 'silent', 0, { overMiloAfterMs: 600, barge: 'stop' }), ask('hugo', 'iv02', 'fixed', 2500)] },
    { id: 'hold-late', about: 'hold to talk: the transcription arrives after the release; the late words of the hold\'s own sentence must not count as a barge-in', speakers: ['hugo'], runtimeOnly: true,
      steps: [ask('hugo', 'hl01', 'reply', 800, { hold: true, answer: 'madrid' }), ask('hugo', 'hl02', 'reply', 2500, { hold: true, answer: 'four|4' })] },
    // The lead, not the candidate: a candidate on fixed lines gets no follow-up window by design (rules.ts, step-0 decision), so
    // the window after a server line is a routed person's. The lead speaks the candidate-worded follow-ups (iv-follow has the lead's own).
    { id: 'fixed-follow', about: 'a follow-up without the name after a server line (the lead, interviews family; a fixed-lines candidate gets no window by design): answered by the server line again', speakers: ['hugo'], family: 'interviews', needsSeam: SEAMS.interviews, runtimeOnly: true,
      steps: [ask('hugo', 'ct03', 'fixed', 800), ask('hugo', 'cf01', 'fixed', 2500), ask('hugo', 'cf03', 'fixed', 2500)] },
    { id: 'iv-follow', about: 'interviews family: a follow-up without the name after a server line, same asker', speakers: ['hugo'], family: 'interviews', needsSeam: SEAMS.interviews, runtimeOnly: true,
      steps: [ask('hugo', 'iv01', 'fixed', 800), ask('hugo', 'cf04', 'fixed', 2500), ask('hugo', 'cf05', 'fixed', 2500)] },
    // The interviews family (the real candidate lines), and the line's words must be the right one: film 2 F1 heard the fixed
    // "I can..." sentence while the gate family's stand-in counted any server line. ct01 is the film's line word for word.
    { id: 'cand-preface', about: 'candidate, fixed lines, name last with a preface ("Before I start drawing, roughly how much time is left, Milo?", the film\'s line): the time line speaks', speakers: ['cand'], candidateMayAsk: false, family: 'interviews', needsSeam: SEAMS.interviews, runtimeOnly: true,
      steps: [ask('cand', 'ct01', 'fixed', 800, { answer: TIME_LINE }), ask('cand', 'ct02', 'fixed', 2500, { answer: TIME_LINE })] },
    { id: 'cand-preface-repeat', about: 'candidate, name last with a preface, asking for the question again: the repeat line speaks', speakers: ['cand'], candidateMayAsk: false, family: 'interviews', needsSeam: SEAMS.interviews, runtimeOnly: true,
      steps: [ask('cand', 'cr01', 'fixed', 800, { answer: REPEAT_LINE }), ask('cand', 'cr02', 'fixed', 2500, { answer: REPEAT_LINE })] },
    { id: 'final-lag', about: 'control: audio fed straight to the listening side; transcription final vs speech end', speakers: ['hugo', 'cand'], runtimeOnly: true, steps: lagSteps },
    { id: 'mixer-lag', about: 'audio through the production mixer path (24k -> 16k chunks -> CallMixer -> placed pieces): transcription final vs speech end', speakers: ['hugo', 'cand'], viaMixer: true, runtimeOnly: true, steps: lagSteps },
  ];
  return [
    { id: 'name-first', about: 'name first, two voices: speech end to Milo first audible frame', speakers: ['hugo', 'cand'], steps: first },
    { id: 'name-last', about: 'name last: the sentence is replayed from the buffer; Milo must understand it', speakers: ['hugo', 'cand'], steps: last },
    { id: 'follow-up', about: 'a follow-up without the name, 3 s after the answer, same person', speakers: ['hugo'], steps: follow },
    { id: 'chatter', about: 'two people talking to each other, three rounds: Milo must stay silent', speakers: ['hugo', 'cand'], steps: chatter },
    { id: 'mentions', about: 'the name used in passing, never a request: Milo relays no voice and calls no tool', speakers: ['hugo', 'cand'], steps: mentions },
    { id: 'asker', about: 'tool requests from both voices: askedBy is the right person', speakers: ['hugo', 'cand'], steps: tools },
    {
      id: 'barge', about: 'talk over Milo, and "Milo, stop": the relay goes silent in time and the next question is answered', speakers: ['hugo'],
      steps: [
        { speaker: 'hugo', clip: 'g01', gapMs: 800, expect: 'reply' },
        { speaker: 'hugo', clip: 'g04', gapMs: 0, overMiloAfterMs: 2500, expect: 'silent', barge: 'talk-over' },
        { speaker: 'hugo', clip: 'q06', gapMs: 2500, expect: 'reply' },
        { speaker: 'hugo', clip: 'g02', gapMs: 1500, expect: 'reply' },
        { speaker: 'hugo', clip: 's01', gapMs: 0, overMiloAfterMs: 2500, expect: 'silent', barge: 'stop' },
        { speaker: 'hugo', clip: 'q11', gapMs: 2500, expect: 'reply' },
      ],
    },
    {
      id: 'two-at-once', about: 'two people say Milo together: one floor, the first asker answered first, the queued second after, no mixed audio', speakers: ['hugo', 'cand'],
      steps: [
        { speaker: 'hugo', clip: 'p01', gapMs: 800, expect: 'reply', answer: 'madrid' },
        // Step-0 decision 10: the second "Milo" while the floor is held is queued (one sentence) and answered after the first.
        { speaker: 'cand', clip: 'p02', gapMs: 0, concurrentMs: 150, expect: 'reply', answer: 'cairo' },
      ],
    },
    {
      id: 'colleague', about: 'a colleague talks inside the follow-up window: nothing of it is relayed', speakers: ['hugo', 'cand'],
      steps: [
        { speaker: 'hugo', clip: 'q01', gapMs: 800, expect: 'reply' }, { speaker: 'cand', clip: 'w01', gapMs: 2500, expect: 'silent' },
        { speaker: 'hugo', clip: 'q03', gapMs: 6000, expect: 'reply' }, { speaker: 'cand', clip: 'w02', gapMs: 2500, expect: 'silent' },
      ],
    },
    {
      id: 'candidate-off', about: 'a candidate with candidate-may-ask off: no audio routed, only the fixed lines', speakers: ['cand'], runtimeOnly: true, candidateMayAsk: false,
      steps: [{ speaker: 'cand', clip: 'h04', gapMs: 800, expect: 'fixed' }, { speaker: 'cand', clip: 'qc01', gapMs: 2000, expect: 'fixed' }],
    },
    {
      id: 'echo', about: "Milo's own voice played into a mic: no trigger", speakers: ['hugo'],
      steps: [{ speaker: 'hugo', clip: 'g02', gapMs: 800, expect: 'reply', loopback: true }, { speaker: 'hugo', clip: null, gapMs: 7000, expect: 'silent' }],
    },
    ...gate2,
  ];
}

// ---------------------------------------------------------------- observations

export interface StepObs {
  i: number;
  clip: string | null;
  speaker: string;
  expect: Expect;
  speechEndMs: number | null;
  /** First voiced frame of Milo's own voice relayed after this step asked (session ms). */
  firstVoiceMs: number | null;
  /** Last voiced frame of the run that followed this step. */
  lastVoiceMs: number | null;
  /** Frames of any voice from the server's fixed lines (not the model). */
  fixedVoice: boolean;
  /** Voiced frames of Milo's voice relayed (OUTBOUND) in the run this step owns or the strays attributed to it. */
  relayedFrames: number;
  /** Voice runs that started while nobody had asked: attributed to the latest started step. */
  strayRuns: number;
  /** Frames of this step's window (its start to 6 s after its end) in which a person's audio was handed to the talking side, per person. */
  routed: Record<string, number>;
  /** A routed frame carried two people at once. */
  mixed: boolean;
  text: string;
  toolCalls: Array<{ name: string; askedBy: string | null }>;
  barge?: 'talk-over' | 'stop';
  /** Barge-in steps: ms from the interruption's start to the last relayed voiced frame (0 = already silent). */
  relaySilentMs: number | null;
  /** The step's name/trigger count (echo): triggers the run reported for this window. */
  triggers: number;
  noReply: boolean;
  /** Session ms of the last transcription final (a finished sentence) of this step's speaker inside its window. */
  finalMs?: number | null;
  /** The router's drop reasons attributed to this step (e.g. `barge-in`). */
  drops?: string[];
}

export interface RunObs {
  scenario: string;
  steps: StepObs[];
  /** A reason this driver cannot show the scenario (check results become skipped, not passed). */
  skipped?: string;
  errors: string[];
  billedLiveSeconds?: number;
  txSeconds?: number;
}

export interface Check { id: string; label: string; value: string; threshold: string; pass: boolean | null }

export function pct(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!);
}

const latency = (s: StepObs): number | null => (s.firstVoiceMs !== null && s.speechEndMs !== null ? Math.round(s.firstVoiceMs - s.speechEndMs) : null);
const sumRouted = (s: StepObs): number => Object.values(s.routed).reduce((a, b) => a + b, 0);
const ms = (v: number | null): string => (v === null ? 'n/a' : `${v} ms`);
const le = (v: number | null, max: number): boolean => v !== null && v <= max;

export function scoreScenario(scenarioId: string, run: RunObs): Check[] {
  const check = (id: string, label: string, value: string, threshold: string, pass: boolean | null): Check => ({ id: `${scenarioId}.${id}`, label, value, threshold, pass: run.skipped ? null : pass });
  const steps = run.steps; const asked = steps.filter((s) => s.expect === 'reply' || s.expect === 'tool' || s.expect === 'fixed');
  const lat = steps.filter((s) => s.expect === 'reply').map(latency).filter((x): x is number => x !== null);
  const strays = steps.reduce((a, s) => a + s.strayRuns, 0);
  switch (scenarioId) {
    case 'name-first': {
      const t = GATE.nameFirst; const p50 = pct(lat, 50); const p90 = pct(lat, 90); const max = lat.length ? Math.max(...lat) : null;
      return [
        check('answered', `answered ${t.tries}/${t.tries}`, `${lat.length}/${asked.length}`, `${t.tries}/${t.tries}`, lat.length === t.tries && asked.length === t.tries),
        check('p50', 'p50', ms(p50), `<= ${t.p50Ms} ms`, le(p50, t.p50Ms)),
        check('p90', 'p90', ms(p90), `<= ${t.p90Ms} ms`, le(p90, t.p90Ms)),
        check('max', 'all under', ms(max), `< ${t.maxMs} ms`, max !== null && max < t.maxMs && lat.length === t.tries),
      ];
    }
    case 'name-last': {
      const t = GATE.nameLast; const p50 = pct(lat, 50); const p90 = pct(lat, 90);
      const understood = steps.filter((s, i) => s.expect === 'reply' && s.firstVoiceMs !== null && understoodAnswer(s, i)).length;
      return [
        check('p50', 'p50', ms(p50), `<= ${t.p50Ms} ms`, le(p50, t.p50Ms)),
        check('p90', 'p90', ms(p90), `<= ${t.p90Ms} ms`, le(p90, t.p90Ms)),
        check('understood', 'understood', `${understood}/${asked.length}`, `${t.understood}/${t.tries}`, understood === t.understood && asked.length === t.tries),
      ];
    }
    case 'follow-up': {
      const t = GATE.followUp; const f = steps.filter((s) => s.expect === 'reply' && s.clip !== null && /^f\d\d$/.test(s.clip));
      const fl = f.map(latency).filter((x): x is number => x !== null); const p90 = pct(fl, 90);
      return [
        check('answered', 'follow-ups answered', `${fl.length}/${f.length}`, `${t.replied}/${t.tries}`, fl.length === t.replied && f.length === t.tries),
        check('p90', 'follow-up p90', ms(p90), `<= ${t.p90Ms} ms`, le(p90, t.p90Ms)),
      ];
    }
    case 'chatter':
      return [check('unasked', 'spoke when not asked', String(strays), `= ${GATE.chatter.spokeUnasked}`, strays === GATE.chatter.spokeUnasked)];
    case 'mentions': {
      // Outbound: Milo's voice relayed to the room (review 1, item 10: this counted the people's routed audio, inbound). The
      // inbound frames are shown beside it: a name routes until its verdict, so they are not a failure on their own.
      const frames = steps.reduce((a, s) => a + s.relayedFrames, 0); const routedIn = steps.reduce((a, s) => a + sumRouted(s), 0);
      const tools = steps.reduce((a, s) => a + s.toolCalls.length, 0);
      return [
        check('relayed', 'Milo voice frames relayed', `${frames} (${routedIn} routed in)`, `= ${GATE.mentions.relayedFrames}`, frames === GATE.mentions.relayedFrames && steps.length === GATE.mentions.clips),
        check('tools', 'tool calls on a mention', String(tools), `= ${GATE.mentions.toolCalls}`, tools === GATE.mentions.toolCalls),
        check('silent', 'Milo spoke', String(strays), '= 0', strays === 0),
      ];
    }
    case 'asker': {
      const wrong = steps.filter((s) => s.expect === 'tool' && !(s.toolCalls.length > 0 && s.toolCalls.every((c) => c.askedBy === s.speaker)));
      return [check('askedBy', 'tool calls with the right askedBy', `${steps.filter((s) => s.expect === 'tool').length - wrong.length}/${steps.filter((s) => s.expect === 'tool').length}`, 'every one', wrong.length === GATE.asker.wrongAsker && steps.some((s) => s.expect === 'tool'))];
    }
    case 'barge': {
      const bs = steps.filter((s) => s.barge !== undefined);
      const bad = bs.filter((s) => !le(s.relaySilentMs, GATE.barge.relaySilentMs));
      const after = bs.map((s) => steps[s.i + 1]).filter((s): s is StepObs => !!s);
      const answered = after.filter((s) => s.firstVoiceMs !== null).length;
      const worst = bs.length ? Math.max(...bs.map((s) => s.relaySilentMs ?? Infinity)) : null;
      return [
        check('silent', 'relay silent after the interruption (worst)', ms(worst === Infinity ? null : worst), `<= ${GATE.barge.relaySilentMs} ms`, bs.length === 2 && bad.length === 0),
        check('next', 'the next question answered', `${answered}/${after.length}`, 'all', after.length === 2 && answered === 2),
      ];
    }
    case 'two-at-once': {
      // Step-0 decision 10: one floor; the first asker answered first; the second's queued sentence replayed once the floor frees
      // and answered after (its answer may follow on in the first one's run of voice, so the order is read off the words too).
      const [a, b] = [steps[0]!, steps[1]!];
      const words = `${a.text} ${b.text}`.toLowerCase(); const first = words.search(/madrid/); const second = words.search(/cairo/);
      const firstOk = a.firstVoiceMs !== null && understoodAnswer(a, 0) && (second < 0 || first < second);
      const secondOk = second >= 0 && first >= 0 && second > first && (b.firstVoiceMs === null || a.lastVoiceMs === null || b.firstVoiceMs > a.lastVoiceMs);
      return [
        check('first', 'the first asker is answered first', firstOk ? 'yes' : 'no', 'yes', firstOk),
        check('second', 'the queued second is answered after', secondOk ? 'yes' : 'no', 'yes', secondOk),
        check('mixed', 'mixed audio routed', String(a.mixed || b.mixed), 'false', !(a.mixed || b.mixed)),
        check('stray', 'unasked voice', String(strays), '= 0', strays === 0),
      ];
    }
    case 'colleague': {
      const sil = steps.filter((s) => s.expect === 'silent'); const frames = sil.reduce((a, s) => a + sumRouted(s), 0);
      return [
        check('relayed', 'colleague frames relayed', String(frames), `= ${GATE.colleague.relayedFrames}`, frames === GATE.colleague.relayedFrames),
        check('silent', 'Milo replied to the colleague', String(strays), '= 0', strays === 0),
      ];
    }
    case 'candidate-off': {
      const frames = steps.reduce((a, s) => a + sumRouted(s), 0); const model = steps.filter((s) => s.firstVoiceMs !== null && !s.fixedVoice).length;
      return [
        check('routed', 'audio routed', String(frames), '= 0', frames === 0),
        check('fixed', 'only the fixed line spoke', `${steps.filter((s) => s.fixedVoice).length} fixed, ${model} model`, 'fixed only', model === 0 && strays === 0 && steps.some((s) => s.fixedVoice)),
      ];
    }
    case 'echo': {
      const triggers = steps.reduce((a, s) => a + s.triggers, 0); const extra = steps.slice(1).reduce((a, s) => a + s.strayRuns, 0) + steps[0]!.strayRuns;
      return [check('trigger', "triggers from Milo's own voice", `${triggers} triggers, ${extra} extra answers`, `= ${GATE.echo.triggers}`, triggers === GATE.echo.triggers && extra === 0 && steps.every((s) => (s.routed['room'] ?? 0) === 0))];
    }
    case 'iv-name-first': return serverLineChecks(check, steps, GATE.serverLine);
    case 'cand-preface-repeat':
    case 'cand-preface': {
      const t = GATE.preface; const ok = steps.filter((s, i) => s.firstVoiceMs !== null && s.fixedVoice && understoodAnswer(s, i)); const p90 = pct(ok.map(latency).filter((x): x is number => x !== null), 90);
      return [
        check('answered', 'preface questions answered by the server line', `${ok.length}/${asked.length}`, `${t.answered}/${t.tries}`, ok.length === t.answered && asked.length === t.tries),
        check('p90', 'p90', ms(p90), `<= ${t.p90Ms} ms`, le(p90, t.p90Ms)),
        check('model', 'the model spoke instead', String(steps.filter((s) => s.firstVoiceMs !== null && !s.fixedVoice).length), '= 0', steps.every((s) => s.firstVoiceMs === null || s.fixedVoice)),
      ];
    }
    case 'iv-barge':
    case 'fixed-barge': {
      const bs = steps.filter((s) => s.barge !== undefined); const worst = bs.length ? Math.max(...bs.map((s) => s.relaySilentMs ?? Infinity)) : null;
      const first = steps[0]!; const next = steps[2];
      return [
        check('line', 'the server line began before the interruption', first.firstVoiceMs !== null && first.fixedVoice ? 'yes' : 'no', 'yes', first.firstVoiceMs !== null && first.fixedVoice),
        check('silent', 'relay silent after the interruption', ms(worst === Infinity ? null : worst), `<= ${GATE.fixedBarge.relaySilentMs} ms`, bs.length === 1 && le(worst === Infinity ? null : worst, GATE.fixedBarge.relaySilentMs)),
        check('next', 'the next ask answered', next?.firstVoiceMs != null ? 'yes' : 'no', 'yes', next?.firstVoiceMs != null),
      ];
    }
    case 'hold-late': {
      const t = GATE.hold; const answered = steps.filter((s, i) => s.firstVoiceMs !== null && understoodAnswer(s, i)).length;
      const drops = steps.flatMap((s) => s.drops ?? []).filter((d) => d === 'barge-in').length;
      return [
        check('answered', 'held questions answered', `${answered}/${asked.length}`, `${t.tries}/${t.tries}`, answered === t.tries && asked.length === t.tries),
        check('bargeIn', "barge-in drops from the hold's own late words", String(drops), `= ${t.bargeInDrops}`, drops === t.bargeInDrops),
      ];
    }
    case 'iv-follow':
    case 'fixed-follow': {
      const t = GATE.fixedFollow; const f = steps.slice(1); const ok = f.filter((s) => s.firstVoiceMs !== null && s.fixedVoice); const p90 = pct(ok.map(latency).filter((x): x is number => x !== null), 90);
      return [
        check('answered', 'follow-ups after a server line answered by it', `${ok.length}/${f.length}`, `${t.answered}/${t.tries}`, ok.length === t.answered && f.length === t.tries),
        check('p90', 'follow-up p90', ms(p90), `<= ${t.p90Ms} ms`, le(p90, t.p90Ms)),
      ];
    }
    case 'final-lag':
    case 'mixer-lag': {
      const t = GATE.finalLag; const lags = steps.map((s) => (s.finalMs != null && s.speechEndMs !== null ? Math.round(s.finalMs - s.speechEndMs) : null)).filter((x): x is number => x !== null);
      const p50 = pct(lags, 50); const p90 = pct(lags, 90);
      return [
        check('seen', 'transcription finals seen', `${lags.length}/${t.tries}`, `${t.tries}/${t.tries}`, lags.length === t.tries),
        check('p50', 'final lag after speech end, p50', ms(p50), `<= ${t.p50Ms} ms`, le(p50, t.p50Ms)),
        check('p90', 'final lag after speech end, p90', ms(p90), `<= ${t.p90Ms} ms`, le(p90, t.p90Ms)),
        check('answered', 'answered', `${lat.length}/${asked.length}`, `${t.tries}/${t.tries}`, lat.length === t.tries && asked.length === t.tries),
      ];
    }
    default:
      return [check('known', 'known scenario', scenarioId, 'listed', false)];
  }
}

function serverLineChecks(check: (id: string, label: string, value: string, threshold: string, pass: boolean | null) => Check, steps: StepObs[], t: typeof GATE.serverLine): Check[] {
  const ok = steps.filter((s) => s.firstVoiceMs !== null); const lat = ok.map(latency).filter((x): x is number => x !== null); const p50 = pct(lat, 50); const p90 = pct(lat, 90);
  const server = steps.filter((s) => s.firstVoiceMs !== null && s.fixedVoice).length;
  return [
    check('answered', 'phrase-tool questions answered', `${ok.length}/${steps.length}`, `${t.tries}/${t.tries}`, ok.length === t.tries && steps.length === t.tries),
    check('server', 'answered by the server line', `${server}/${steps.length}`, `${t.serverVoice}/${t.tries}`, server === t.serverVoice),
    check('p50', 'p50', ms(p50), `<= ${t.p50Ms} ms`, le(p50, t.p50Ms)),
    check('p90', 'p90', ms(p90), `<= ${t.p90Ms} ms`, le(p90, t.p90Ms)),
  ];
}

function understoodAnswer(s: StepObs, i: number): boolean {
  const spec = gateScenarios().flatMap((sc) => sc.steps.map((st) => ({ ...st, sc: sc.id }))).find((x) => x.clip === s.clip && x.speaker === s.speaker && x.answer);
  void i;
  if (!spec?.answer) return !/go ahead|what do you (want|need)|what can i|how can i help/i.test(s.text);
  return new RegExp(spec.answer, 'i').test(s.text);
}

export interface GateResult { checks: Check[]; pass: number; fail: number; skipped: number; ok: boolean }

/** The gate passes when nothing failed; with requireAll, a skipped check fails it too (the real-runtime run must prove every row). */
export function scoreGate(runs: RunObs[], opts: { requireAll?: boolean } = {}): GateResult {
  const checks = runs.flatMap((r) => scoreScenario(r.scenario, r));
  const pass = checks.filter((c) => c.pass === true).length; const fail = checks.filter((c) => c.pass === false).length; const skipped = checks.filter((c) => c.pass === null).length;
  return { checks, pass, fail, skipped, ok: fail === 0 && (!opts.requireAll || skipped === 0) };
}

export function formatChecks(res: GateResult): string {
  return res.checks.map((c) => `${c.pass === true ? 'PASS' : c.pass === false ? 'FAIL' : 'SKIP'}  ${c.id.padEnd(22)} ${c.label}: ${c.value}  (need ${c.threshold})`).join('\n')
    + `\n${res.ok ? 'GATE OK' : 'GATE FAILED'}: ${res.pass} pass, ${res.fail} fail, ${res.skipped} skipped`;
}
